//! Self-heal cadence policy (pure — no host, no LLM, deterministic).
//!
//! The SkillMaintenanceScheduler already retrains stale skills on a tick.
//! Contradictions, by contrast, were only ever detected *on demand* (the
//! `contradiction_pairs` tool). This module supplies the missing piece: a
//! deterministic policy that decides (a) WHEN a contradiction health-sweep is
//! due, and (b) WHICH detected pairs are genuinely new — not already resolved
//! or suppressed in the healing journal — so a thin scheduler can run the
//! existing scan on a cadence and surface only the conflicts that matter.
//!
//! It also exposes a walk-time guard so a skill's `recall(...)` step never acts
//! blindly on memory that sits on an unresolved contradiction.
//!
//! Kept pure on purpose: the host wiring (run findSimilarPairs, read the
//! journal for known keys, persist surfaced conflicts) lives in the scheduler;
//! the *decisions* live here and are fully unit-testable.

import { pairKey, type ContradictionSeverity } from './contradiction-utils.js';

export interface DetectedContradiction {
  graphId: string;
  nodeA: string;
  nodeB: string;
  severity: ContradictionSeverity;
  similarity?: number;
}

export interface SweepCadenceState {
  /** Epoch ms of the last completed sweep, or null if never swept. */
  lastSweptAt: number | null;
}

export interface SweepPlan {
  shouldSweep: boolean;
  /** ms until the next sweep is due (0 when due now). */
  dueInMs: number;
  /** Detected pairs not already resolved/suppressed/journaled, severity-sorted. */
  newContradictions: DetectedContradiction[];
  /** The subset at 'high' severity — candidates to surface immediately. */
  urgent: DetectedContradiction[];
  summary: string;
}

/** Default self-heal cadence: 6h, matching the maintenance snooze grain so the
 *  two background loops don't thrash. */
export const DEFAULT_SWEEP_CADENCE_MS = 6 * 60 * 60 * 1000;

const SEVERITY_RANK: Record<ContradictionSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Stable, order-independent key for a detected pair. Mirrors how the healing
 *  journal keys resolved/suppressed pairs, so set-membership dedup is exact. */
export function contradictionKey(c: { graphId: string; nodeA: string; nodeB: string }): string {
  return pairKey(c.graphId, c.nodeA, c.nodeB);
}

/** Pure self-heal policy: is a sweep due, and which detected pairs are new?
 *
 *  @param knownKeys  contradictionKey() of every pair already resolved,
 *                    suppressed, or journaled — these are filtered out so the
 *                    sweep never re-surfaces a conflict the user already judged.
 */
export function planContradictionSweep(
  state: SweepCadenceState,
  detected: ReadonlyArray<DetectedContradiction>,
  knownKeys: ReadonlySet<string>,
  now: number,
  cadenceMs: number = DEFAULT_SWEEP_CADENCE_MS,
): SweepPlan {
  const elapsed = state.lastSweptAt === null ? Infinity : now - state.lastSweptAt;
  const shouldSweep = elapsed >= cadenceMs;
  const dueInMs = shouldSweep ? 0 : Math.max(0, cadenceMs - elapsed);

  const seen = new Set<string>();
  const newContradictions: DetectedContradiction[] = [];
  for (const c of detected) {
    const k = contradictionKey(c);
    if (knownKeys.has(k) || seen.has(k)) continue; // already judged, or a dup within this batch
    seen.add(k);
    newContradictions.push(c);
  }
  newContradictions.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const urgent = newContradictions.filter((c) => c.severity === 'high');

  const summary = shouldSweep
    ? `${newContradictions.length} new contradiction(s)${urgent.length ? `, ${urgent.length} urgent` : ''} (sweep due)`
    : `sweep not due for ~${Math.round(dueInMs / 60_000)} min`;

  return { shouldSweep, dueInMs, newContradictions, urgent, summary };
}

export interface RecallHitRef {
  graphId: string;
  nodeId: string;
}

export interface RecallContradictionWarning {
  nodeId: string;
  conflictsWith: string;
  severity: ContradictionSeverity;
}

/** Walk-time guard. Given the nodes a `recall(...)` step pulled and the set of
 *  open (unresolved) contradictions, return a warning for each recalled node
 *  that sits on a conflict — so the walk can surface "⚠ contradicted memory"
 *  instead of feeding it into a downstream step. Pure. */
export function surfaceContradictionsForRecall(
  hits: ReadonlyArray<RecallHitRef>,
  openContradictions: ReadonlyArray<DetectedContradiction>,
): RecallContradictionWarning[] {
  if (hits.length === 0 || openContradictions.length === 0) return [];
  const hitIds = new Set(hits.map((h) => h.nodeId));
  const warnings: RecallContradictionWarning[] = [];
  const emitted = new Set<string>();
  const add = (nodeId: string, conflictsWith: string, severity: ContradictionSeverity): void => {
    const k = `${nodeId}|${conflictsWith}`;
    if (emitted.has(k)) return;
    emitted.add(k);
    warnings.push({ nodeId, conflictsWith, severity });
  };
  for (const c of openContradictions) {
    if (hitIds.has(c.nodeA)) add(c.nodeA, c.nodeB, c.severity);
    if (hitIds.has(c.nodeB)) add(c.nodeB, c.nodeA, c.severity);
  }
  // Most severe first so a caller truncating the list keeps the worst.
  warnings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return warnings;
}
