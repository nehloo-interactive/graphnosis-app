/**
 * Self-heal cadence driver — the contradiction counterpart to
 * SkillMaintenanceScheduler. On an idle cadence it reads the brain engine's
 * OPEN (unresolved, unsuppressed) contradiction queue and SURFACES any
 * newly-appeared conflict as a card for the owner to adjudicate. It never
 * auto-resolves — that is the substrate's owner-adjudicated posture, preserved.
 *
 * The when/which decision is the pure, tested planContradictionSweep()
 * (contradiction-health.ts); this class only drives it on a timer, tracks which
 * open pairs have already been surfaced (so a standing conflict isn't re-carded
 * every tick), and emits the card.
 */
import type { GraphnosisHost } from './host.js';
import type { BrainEngine } from './brain-engine.js';
import type { BroadcastRawFn } from './events.js';
import {
  planContradictionSweep,
  contradictionKey,
  DEFAULT_SWEEP_CADENCE_MS,
  type DetectedContradiction,
  type SweepCadenceState,
} from './contradiction-health.js';

export interface ContradictionHealthCard {
  id: string;
  createdAt: number;
  signalType: 'contradiction-health';
  signalLabel: string;
  newCount: number;
  urgentCount: number;
  pairs: Array<{ id: string; graphId: string; severity: string; snippetA: string; snippetB: string }>;
  why: string;
  status: 'pending';
}

export interface ContradictionHealthSchedulerDeps {
  host: Pick<GraphnosisHost, 'getSettings'>;
  brainEngine: Pick<BrainEngine, 'getContradictionPairs'>;
  broadcastRaw: BroadcastRawFn;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/** Poll interval. The real self-heal cadence is enforced by
 *  planContradictionSweep (DEFAULT_SWEEP_CADENCE_MS); the poll just wakes up
 *  often enough to notice when a sweep is due. */
const TICK_MS = 10 * 60_000;

export type ContradictionHealthTick =
  { action: 'idle' | 'swept' | 'skip'; detail?: string; newCount?: number };

export class ContradictionHealthScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: SweepCadenceState = { lastSweptAt: null };
  private surfacedKeys = new Set<string>();

  constructor(private deps: ContradictionHealthSchedulerDeps) {}

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  start(): void {
    if (this.timer) return;
    setTimeout(() => { void this.tick(); }, 6 * 60_000);
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Test hook — runs one tick and reports the outcome. */
  async tickForTest(): Promise<ContradictionHealthTick> {
    return this.tick();
  }

  private async tick(): Promise<ContradictionHealthTick> {
    const settings = this.deps.host.getSettings();
    if (settings.agent?.enabled === false) return { action: 'skip', detail: 'ghampus-disabled' };

    const now = this.nowMs();
    const openPairs = this.deps.brainEngine.getContradictionPairs().filter((p) => !p.resolvedAt);
    const detected: DetectedContradiction[] = openPairs.map((p) => ({
      graphId: p.graphId,
      nodeA: p.nodeA,
      nodeB: p.nodeB,
      severity: p.severity ?? 'medium',
    }));

    // knownKeys = pairs already surfaced in a prior sweep, so a standing
    // conflict the owner hasn't acted on yet isn't re-carded every cadence.
    const plan = planContradictionSweep(this.state, detected, this.surfacedKeys, now, DEFAULT_SWEEP_CADENCE_MS);
    if (!plan.shouldSweep) return { action: 'idle', detail: 'not-due' };

    // Sweep is due: stamp it and refresh the surfaced set to exactly the keys
    // still open (resolved/suppressed pairs drop out of getContradictionPairs,
    // so they fall out here too — keeping the set from growing unbounded).
    this.state = { lastSweptAt: now };
    this.surfacedKeys = new Set(detected.map(contradictionKey));

    if (plan.newContradictions.length === 0) return { action: 'idle', detail: 'no-new' };

    const pairByKey = new Map(openPairs.map((p) => [contradictionKey(p), p]));
    const cardPairs = plan.newContradictions.slice(0, 10).map((c) => {
      const p = pairByKey.get(contradictionKey(c));
      return {
        id: p?.id ?? contradictionKey(c),
        graphId: c.graphId,
        severity: c.severity,
        snippetA: p?.snippetA ?? '',
        snippetB: p?.snippetB ?? '',
      };
    });
    this.emitCard(this.buildCard(plan.newContradictions.length, plan.urgent.length, cardPairs, now));
    return { action: 'swept', detail: plan.summary, newCount: plan.newContradictions.length };
  }

  private buildCard(
    newCount: number,
    urgentCount: number,
    pairs: ContradictionHealthCard['pairs'],
    now: number,
  ): ContradictionHealthCard {
    const signalLabel = newCount === 1
      ? '1 new contradiction to review'
      : `${newCount} new contradictions to review`;
    const why =
      `Graphnosis detected ${newCount} new contradiction${newCount === 1 ? '' : 's'}` +
      `${urgentCount ? ` (${urgentCount} high-severity)` : ''} in your cortex since the last sweep. ` +
      `Contradictions are surfaced for you to adjudicate — Graphnosis never resolves them on its own.`;
    return {
      id: `contra-${now}-${pairs.length}`,
      createdAt: now,
      signalType: 'contradiction-health',
      signalLabel,
      newCount,
      urgentCount,
      pairs,
      why,
      status: 'pending',
    };
  }

  private emitCard(card: ContradictionHealthCard): void {
    try {
      this.deps.broadcastRaw({ kind: 'ghampus.card', name: 'ghampus.card', payload: card });
    } catch { /* non-fatal */ }
  }
}
