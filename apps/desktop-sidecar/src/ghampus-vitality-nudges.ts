/**
 * Ghampus vitality nudge cards — idle suggestions for low scores / duplicates.
 * Shares idle gates with proactive tips; separate settings toggle.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveGhampusVitalityNudgesSettings } from '@graphnosis-app/core/settings';
import type { GraphnosisHost } from './host.js';
import type { BroadcastRawFn } from './events.js';
import type { BrainEngine } from './brain-engine.js';
import { isGhampusBusy, ghampusChatSoftIdle } from './ghampus-busy.js';
import { shouldDeferGhampusBackground, scaleGhampusStartupDelay } from './background-lane-scheduler.js';

export type VitalityNudgeKind =
  | 'health-check'
  | 'clear-duplicates'
  | 'review-contradictions'
  | 'populate-empty'
  | 'cortex-gardening';

export interface VitalityNudgePayload {
  id: string;
  nudgeId: string;
  title: string;
  body: string;
  kind: VitalityNudgeKind;
  ts: number;
  examplePrompt?: string;
  walkSkillLabel?: string;
  notify: false;
}

interface NudgesState {
  version: 1;
  shownNudgeIds: Record<string, number>;
}

export interface GhampusVitalityNudgesSchedulerDeps {
  host: GraphnosisHost;
  brainEngine: BrainEngine | null;
  broadcastRaw: BroadcastRawFn;
  cortexDir: string;
}

const TICK_MS = 5 * 60_000;
const STATE_FILE = 'ghampus-vitality-nudges-state.json';
const REPEAT_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_STARTUP_DELAY_MS = 3 * 60_000;

const LOW_ENGRAM_THRESHOLD = 40;
const VERY_LOW_ENGRAM_THRESHOLD = 35;
const LOW_OVERALL_THRESHOLD = 45;
const DUPLICATE_BANNER_THRESHOLD = 5;

async function loadState(cortexDir: string): Promise<NudgesState> {
  try {
    const raw = await fs.readFile(path.join(cortexDir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as NudgesState;
    if (parsed.version !== 1) throw new Error('bad version');
    return { version: 1, shownNudgeIds: parsed.shownNudgeIds ?? {} };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT' && !(e instanceof SyntaxError)) {
      console.error(`[ghampus-vitality-nudges] state load failed: ${err.message}`);
    }
    return { version: 1, shownNudgeIds: {} };
  }
}

async function saveState(cortexDir: string, state: NudgesState): Promise<void> {
  const target = path.join(cortexDir, STATE_FILE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

type NudgeCandidate = {
  id: string;
  kind: VitalityNudgeKind;
  title: string;
  body: string;
  examplePrompt?: string;
  walkSkillLabel?: string;
  priority: number;
};

export class GhampusVitalityNudgesScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private state: NudgesState = { version: 1, shownNudgeIds: {} };
  private stateLoaded = false;
  private tickInFlight = false;
  /** null = untried; false = detailed vitality pull unavailable on this sidecar build. */
  private breakdownPullSupported: boolean | null = null;

  constructor(private deps: GhampusVitalityNudgesSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    void this.init().then(() => {
      const base = resolveGhampusVitalityNudgesSettings(this.deps.host.getSettings().agent).startupDelayMs;
      const delay = scaleGhampusStartupDelay(this.deps.host, base);
      this.startupTimer = setTimeout(() => { void this.tick(); }, delay);
      this.startupTimer.unref?.();
      this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
      this.timer.unref?.();
    });
  }

  stop(): void {
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async tickForTest(): Promise<{ emitted: boolean; nudgeId?: string }> {
    await this.init();
    return this.tick();
  }

  private async init(): Promise<void> {
    if (this.stateLoaded) return;
    this.state = await loadState(this.deps.cortexDir);
    this.stateLoaded = true;
  }

  private isEnabled(): boolean {
    if (this.deps.host.getSettings().agent?.enabled === false) return false;
    return resolveGhampusVitalityNudgesSettings(this.deps.host.getSettings().agent).enabled;
  }

  private markBreakdownPullUnsupported(reason: unknown): void {
    if (this.breakdownPullSupported === false) return;
    this.breakdownPullSupported = false;
    const detail = reason instanceof Error ? reason.message : String(reason);
    console.error(`[ghampus-vitality-nudges] detailed vitality unavailable — scheduler stopped (${detail})`);
    this.stop();
  }

  private breakdownPullReady(): boolean {
    if (this.breakdownPullSupported === false) return false;
    const engine = this.deps.brainEngine;
    if (!engine || typeof engine.getVitalityDetailedReport !== 'function') {
      this.markBreakdownPullUnsupported('getVitalityDetailedReport missing');
      return false;
    }
    if (this.breakdownPullSupported === null) this.breakdownPullSupported = true;
    return true;
  }

  private canEmitNow(): boolean {
    if (!this.isEnabled()) return false;
    if (!this.deps.brainEngine) return false;
    if (!this.breakdownPullReady()) return false;
    if (this.deps.host.listGraphs().length === 0) return false;
    if (isGhampusBusy()) return false;
    if (shouldDeferGhampusBackground(this.deps.host)) return false;
    if (!ghampusChatSoftIdle()) return false;
    return true;
  }

  private pickNudge(now: number, report: Awaited<ReturnType<BrainEngine['getVitalityDetailedReport']>>): NudgeCandidate | null {
    if (!report) return null;
    const dupes = report.pendingDuplicatePairs;
    const contras = report.pendingContradictionPairs ?? 0;
    const overall = report.overall;
    const candidates: NudgeCandidate[] = [];

    if (contras > 0) {
      candidates.push({
        id: 'review-contradictions',
        kind: 'review-contradictions',
        title: 'Contradictions need review',
        body: `**${contras} contradiction${contras === 1 ? '' : 's'}** are queued — open **Memory Integrity** (Foresight) to Keep A, Keep B, or mark as debate.`,
        examplePrompt: 'Walk me through my memory contradictions',
        walkSkillLabel: 'consistency-audit',
        priority: 110,
      });
    }

    if (dupes >= DUPLICATE_BANNER_THRESHOLD || report.cortexFactors.coherence < 0.75) {
      candidates.push({
        id: 'clear-duplicates',
        kind: 'clear-duplicates',
        title: 'Duplicates are lowering vitality',
        body: `**${dupes} duplicate pairs** are unresolved — coherence (15% weight) applies to every engram. Open **Check-in** and merge or keep-both.`,
        examplePrompt: 'Open Check-in duplicate review',
        priority: 100,
      });
    }

    const lowEngrams = Object.values(report.byGraphBreakdown)
      .filter((b) => b.score > 0 && b.score < LOW_ENGRAM_THRESHOLD)
      .sort((a, b) => a.score - b.score);
    const emptyEngrams = Object.values(report.byGraphBreakdown)
      .filter((b) => b.activeNodes === 0);

    if (
      overall < LOW_OVERALL_THRESHOLD
      || dupes >= DUPLICATE_BANNER_THRESHOLD
      || lowEngrams.some((b) => b.score < VERY_LOW_ENGRAM_THRESHOLD)
    ) {
      candidates.push({
        id: 'cortex-gardening',
        kind: 'cortex-gardening',
        title: 'Preview cortex-gardening?',
        body: 'Overall vitality is soft or duplicates are piling up. **cortex-gardening** covers duplicate triage, orphan linking, and skill hygiene — preview the SOP before you run it in Cursor.',
        examplePrompt: '/preview cortex-gardening',
        walkSkillLabel: 'cortex-gardening',
        priority: 80,
      });
    }

    const lowest = lowEngrams[0];
    if (lowest) {
      const meta = this.deps.host.getGraphMetadata(lowest.graphId);
      const name = meta?.displayName ?? lowest.graphId;
      candidates.push({
        id: `health-check-${lowest.graphId}`,
        kind: 'health-check',
        title: `Health check: ${name}`,
        body: `**${name}** scores **${lowest.score}/100**. Ask for a deterministic factor breakdown — connectivity, confidence, activity, coherence.`,
        examplePrompt: `health check ${lowest.graphId}`,
        priority: 60,
      });
    }

    const empty = emptyEngrams[0];
    if (empty) {
      const meta = this.deps.host.getGraphMetadata(empty.graphId);
      const name = meta?.displayName ?? empty.graphId;
      candidates.push({
        id: `populate-${empty.graphId}`,
        kind: 'populate-empty',
        title: `Populate ${name}`,
        body: `Engram **${name}** is empty — ingest a source or \`/save\` a seed memory so vitality can measure it.`,
        examplePrompt: `/save Seed note for ${name}`,
        priority: 50,
      });
    }

    const eligible = candidates
      .filter((c) => now - (this.state.shownNudgeIds[c.id] ?? 0) >= REPEAT_COOLDOWN_MS)
      .sort((a, b) => b.priority - a.priority);

    return eligible[0] ?? null;
  }

  private async tick(): Promise<{ emitted: boolean; nudgeId?: string }> {
    if (this.tickInFlight) return { emitted: false };
    this.tickInFlight = true;
    try {
      await this.init();
      const now = Date.now();
      if (!this.canEmitNow()) return { emitted: false };

      let report: Awaited<ReturnType<BrainEngine['getVitalityDetailedReport']>>;
      try {
        report = await this.deps.brainEngine!.getVitalityDetailedReport();
      } catch (err) {
        this.markBreakdownPullUnsupported(err);
        return { emitted: false };
      }
      const nudge = this.pickNudge(now, report);
      if (!nudge) return { emitted: false };

      await this.emitNudge(nudge, now);
      this.state.shownNudgeIds[nudge.id] = now;
      await saveState(this.deps.cortexDir, this.state);
      return { emitted: true, nudgeId: nudge.id };
    } catch (err) {
      console.error('[ghampus-vitality-nudges] tick error:', err);
      return { emitted: false };
    } finally {
      this.tickInFlight = false;
    }
  }

  private async emitNudge(nudge: NudgeCandidate, now: number): Promise<void> {
    const payload: VitalityNudgePayload = {
      id: `vnudge-${nudge.id}-${now}`,
      nudgeId: nudge.id,
      title: nudge.title,
      body: nudge.body,
      kind: nudge.kind,
      ts: now,
      notify: false,
      ...(nudge.examplePrompt ? { examplePrompt: nudge.examplePrompt } : {}),
      ...(nudge.walkSkillLabel ? { walkSkillLabel: nudge.walkSkillLabel } : {}),
    };

    const histMsg = {
      kind: 'vitality-nudge' as const,
      nudgeId: nudge.id,
      title: nudge.title,
      body: nudge.body,
      nudgeKind: nudge.kind,
      ts: now,
      ...(nudge.examplePrompt ? { examplePrompt: nudge.examplePrompt } : {}),
      ...(nudge.walkSkillLabel ? { walkSkillLabel: nudge.walkSkillLabel } : {}),
    };

    const { appendGhampusHistoryMessage } = await import('./ghampus-history-cache.js');
    await appendGhampusHistoryMessage(this.deps.cortexDir, histMsg);

    try {
      this.deps.broadcastRaw({ kind: 'ghampus.vitality-nudge', name: 'ghampus.vitality-nudge', payload });
    } catch { /* non-fatal */ }
  }
}

export { DEFAULT_STARTUP_DELAY_MS as VITALITY_NUDGES_STARTUP_DELAY_MS };
