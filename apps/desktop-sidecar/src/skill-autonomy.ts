//! Skills Autonomy Engine — the gating decision (pure, deterministic, no host).
//!
//! The "crazy idea": let Ghampus actually RUN a skill for the user, not merely
//! list its steps. The obvious danger is autonomy without bounds. This module
//! IS the bound. It answers one question deterministically — given the user's
//! chosen autonomy level and the skill's *authored* safety properties, how far
//! may this skill be taken automatically: manual / suggest / preview / auto?
//!
//! Invariant: **autonomy is capped by safety, never safety by autonomy.**
//!   - A meta/router skill is never auto-run (its job is to dispatch others).
//!   - dispatch-safe:no       → capped at 'suggest'  (surface it; the human runs it).
//!   - dispatch-safe:partial  → capped at 'preview'  (show the plan; human confirms).
//!   - dispatch-safe:yes      → may reach 'auto' at L3.
//!   - recalled memory under an unresolved contradiction → capped at 'preview'
//!     (this is the seam with contradiction-health.ts: never auto-act on
//!     contradicted memory).
//!   - a low-confidence match downgrades to 'suggest' at most.
//!
//! This is a SEPARATE axis from the retrain-promotion `autonomyLevel`
//! (auto-accept/notify/preview-first) in main.ts: that governs whether a
//! *retrained* skill is saved; this governs whether a *matched* skill is run.
//!
//! The background executor (watcher → walker → report) is the wiring; this is
//! its conscience, and it is unit-testable in isolation.

/** L0 manual · L1 suggest · L2 preview-then-run · L3 autonomous. */
export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type DispatchSafety = 'yes' | 'partial' | 'no';
export type AutonomyAction = 'manual' | 'suggest' | 'preview' | 'auto';

export interface SkillAutonomyInput {
  level: AutonomyLevel;
  dispatchSafe: DispatchSafety;
  isMetaSkill: boolean;
  /** 0..1 trigger-match confidence from the proactive matcher. */
  matchConfidence: number;
  /** True when a recall step would feed memory that sits on an open
   *  contradiction (from contradiction-health surfacing). */
  hasUnresolvedContradiction?: boolean;
}

export interface AutonomyDecision {
  action: AutonomyAction;
  /** What the level alone asked for, before any safety capping — for transparency. */
  requested: AutonomyAction;
  capped: boolean;
  reason: string;
}

const LEVEL_TO_ACTION: Record<AutonomyLevel, AutonomyAction> = {
  L0: 'manual',
  L1: 'suggest',
  L2: 'preview',
  L3: 'auto',
};

const ACTION_RANK: Record<AutonomyAction, number> = { manual: 0, suggest: 1, preview: 2, auto: 3 };

/** Below this confidence a match may be suggested but never previewed-as-correct
 *  or auto-run. */
export const AUTONOMY_CONFIDENCE_FLOOR = 0.6;

/** The highest action a skill may reach regardless of the user's level. */
export function safetyCeiling(
  input: Pick<SkillAutonomyInput, 'dispatchSafe' | 'isMetaSkill' | 'hasUnresolvedContradiction'>,
): AutonomyAction {
  if (input.isMetaSkill) return 'suggest';                // routers never auto-run
  if (input.hasUnresolvedContradiction) return 'preview'; // never auto-act on contradicted memory
  switch (input.dispatchSafe) {
    case 'no': return 'suggest';
    case 'partial': return 'preview';
    case 'yes': return 'auto';
  }
}

function lower(a: AutonomyAction, b: AutonomyAction): AutonomyAction {
  return ACTION_RANK[a] <= ACTION_RANK[b] ? a : b;
}

/** Decide how far a matched skill may be taken automatically. Pure. */
export function decideSkillAutonomy(input: SkillAutonomyInput): AutonomyDecision {
  const requested = LEVEL_TO_ACTION[input.level];
  const ceiling = safetyCeiling(input);
  let action = lower(requested, ceiling);

  // Confidence downgrade — applied after the safety ceiling so the binding
  // reason is reported accurately.
  let confidenceBound = false;
  if (input.matchConfidence < AUTONOMY_CONFIDENCE_FLOOR && ACTION_RANK[action] > ACTION_RANK.suggest) {
    action = 'suggest';
    confidenceBound = true;
  }

  const capped = ACTION_RANK[action] < ACTION_RANK[requested];
  let reason: string;
  if (!capped) {
    reason = `level ${input.level} → ${action}`;
  } else if (confidenceBound) {
    reason = `capped to ${action}: match confidence ${input.matchConfidence.toFixed(2)} < ${AUTONOMY_CONFIDENCE_FLOOR}`;
  } else if (input.isMetaSkill) {
    reason = `capped to ${action}: meta/router skill never auto-runs`;
  } else if (input.hasUnresolvedContradiction) {
    reason = `capped to ${action}: recalled memory has an unresolved contradiction`;
  } else {
    reason = `capped to ${action}: dispatch-safe:${input.dispatchSafe}`;
  }

  return { action, requested, capped, reason };
}

/** Convenience: may this decision proceed without a human in the loop? */
export function isAutonomous(decision: AutonomyDecision): boolean {
  return decision.action === 'auto';
}

// ── Dispatch-safe readout (compute-only; deterministic; no host) ───────────────
//
// The engram-level execution-autonomy dial sets the REQUESTED ceiling for skills
// matched from that engram. Each skill is then individually capped at dispatch
// time by decideSkillAutonomy() using its authored `[dispatch-safe: …]` tag and
// meta/router status. This readout exposes, deterministically:
//   - configuredLevel   — the engram's persisted executionAutonomyLevel (resolved)
//   - dispatchSafeCap    — the highest level the engram's skills can MEANINGFULLY
//                          reach given their authored safety (the most permissive
//                          skill sets the ceiling; an empty engram is uncapped)
//   - effectiveLevel     — min(configuredLevel, dispatchSafeCap)
//   - perSkill           — each skill's authored dispatch-safe value + its own cap
//
// "Cap" is expressed as an AutonomyLevel (L0..L3) so it composes with the
// engram dial. It is derived from the action-level safetyCeiling() inverted back
// to a level: manual→L0, suggest→L1, preview→L2, auto→L3.

/** Inverse of LEVEL_TO_ACTION — the highest level whose action equals `action`. */
const ACTION_TO_LEVEL: Record<AutonomyAction, AutonomyLevel> = {
  manual: 'L0',
  suggest: 'L1',
  preview: 'L2',
  auto: 'L3',
};

const LEVEL_RANK: Record<AutonomyLevel, number> = { L0: 0, L1: 1, L2: 2, L3: 3 };
const RANK_TO_LEVEL: AutonomyLevel[] = ['L0', 'L1', 'L2', 'L3'];

/** The lower (more restrictive) of two levels. */
export function lowerLevel(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b;
}

/** The higher (more permissive) of two levels. */
export function higherLevel(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/**
 * The per-skill autonomy CAP (as a level) implied by a skill's authored safety
 * — purely the safety ceiling, before the engram/global level or match
 * confidence is applied. dispatch-safe:no → L1, partial → L2, yes → L3; a
 * meta/router skill → L1; an unresolved contradiction → L2.
 */
export function dispatchSafeCapForSkill(
  input: Pick<SkillAutonomyInput, 'dispatchSafe' | 'isMetaSkill' | 'hasUnresolvedContradiction'>,
): AutonomyLevel {
  return ACTION_TO_LEVEL[safetyCeiling(input)];
}

/**
 * Canonical meta/router skill names — skills whose job is to dispatch OTHER
 * skills. They never auto-run (safetyCeiling pins them to 'suggest'). Shared by
 * the proactive watcher (auto-proposal filter) and the dispatch-safe readout so
 * both agree on what counts as a router. Compared case-insensitively against a
 * skill's base label (the `skill:<ts>:` prefix stripped).
 */
export const META_SKILL_NAMES: ReadonlySet<string> = new Set([
  'skill-dispatch',
  'session-start',
  'session-end',
  'self-driving-session',
  'adaptive-skill-creation',
  'autonomous-decision-authority',
]);

/** Parse a skill's authored `[dispatch-safe: yes|partial|no]` tag from its text.
 *  Anything missing or unrecognised defaults to 'yes' (the authored opt-OUT is
 *  explicit, mirroring proactive-watcher). */
export function parseDispatchSafe(text: string): DispatchSafety {
  const m = text.match(/\[dispatch-safe:\s*([a-z]+)\s*\]/i);
  const v = m?.[1]?.toLowerCase();
  return v === 'no' || v === 'partial' ? v : 'yes';
}

/** True when a skill label (any `skill:<ts>:` prefix stripped) is a meta/router. */
export function isMetaSkillLabel(label: string): boolean {
  return META_SKILL_NAMES.has(label.replace(/^skill:\d+:/, '').trim().toLowerCase());
}

/** Authored properties of one skill, parsed from its stored text by the caller. */
export interface SkillSafetyInfo {
  sourceId: string;
  label: string;
  dispatchSafe: DispatchSafety;
  isMetaSkill: boolean;
  /**
   * The user's RAW per-skill autonomy override for this skill (from
   * GraphMetadata.skillAutonomyLevels[sourceId]). `null` = no override → the
   * skill INHERITS the engram default. The caller resolves this from settings;
   * the readout passes it straight through as `configuredSkillLevel`.
   */
  configuredSkillLevel?: AutonomyLevel | null;
  /**
   * The skill's RESOLVED requested level (override ?? engramDefault ??
   * globalDefault) — i.e. resolveSkillAutonomyLevel(...). The caller supplies it;
   * computeDispatchSafeReadout caps it by `cap` to derive `effectiveLevel`. When
   * omitted, the readout falls back to the engram's `configuredLevel`.
   */
  resolvedSkillLevel?: AutonomyLevel;
}

export interface PerSkillDispatchSafe {
  sourceId: string;
  label: string;
  dispatchSafe: DispatchSafety;
  /** This skill's own autonomy cap (level) implied by its authored safety. */
  cap: AutonomyLevel;
  /**
   * The user's RAW per-skill override (null = inheriting from the engram). The
   * UI renders the override state directly from this in one call.
   */
  configuredSkillLevel: AutonomyLevel | null;
  /**
   * The EFFECTIVE (capped) per-skill level the dispatcher will honor:
   * min(resolvedSkillLevel ?? engram configuredLevel, this skill's `cap`).
   */
  effectiveLevel: AutonomyLevel;
}

export interface DispatchSafeReadout {
  graphId: string;
  /** Engram's resolved (configured) execution-autonomy level. */
  configuredLevel: AutonomyLevel;
  /**
   * Highest level the engram's skills can meaningfully reach given authored
   * safety. The MOST permissive skill sets it (each skill is still individually
   * capped at dispatch). An engram with no skills is uncapped → 'L3'.
   */
  dispatchSafeCap: AutonomyLevel;
  /** min(configuredLevel, dispatchSafeCap). */
  effectiveLevel: AutonomyLevel;
  perSkill: PerSkillDispatchSafe[];
}

/**
 * Pure dispatch-safe readout for one engram. Deterministic; no host. The caller
 * supplies the engram id, its resolved configured level, and the parsed safety
 * info for each skill in the engram (dispatch-safe value + meta-skill flag).
 */
export function computeDispatchSafeReadout(
  graphId: string,
  configuredLevel: AutonomyLevel,
  skills: readonly SkillSafetyInfo[],
): DispatchSafeReadout {
  const perSkill: PerSkillDispatchSafe[] = skills.map((s) => {
    const cap = dispatchSafeCapForSkill({ dispatchSafe: s.dispatchSafe, isMetaSkill: s.isMetaSkill });
    // The skill's requested level: its resolved per-skill level when the caller
    // supplied one, else the engram's configured level (the inherit case).
    const requested = s.resolvedSkillLevel ?? configuredLevel;
    return {
      sourceId: s.sourceId,
      label: s.label,
      dispatchSafe: s.dispatchSafe,
      cap,
      configuredSkillLevel: s.configuredSkillLevel ?? null,
      // EFFECTIVE = min(requested, authored cap) — autonomy is capped by safety.
      effectiveLevel: lowerLevel(requested, cap),
    };
  });
  // The engram cap is the most permissive skill's cap — setting the dial higher
  // than this would be meaningless because no skill could ever use it. An engram
  // with no skills imposes no authored cap (L3).
  const dispatchSafeCap = perSkill.length === 0
    ? 'L3'
    : perSkill.reduce<AutonomyLevel>((acc, p) => higherLevel(acc, p.cap), 'L0');
  const effectiveLevel = lowerLevel(configuredLevel, dispatchSafeCap);
  return { graphId, configuredLevel, dispatchSafeCap, effectiveLevel, perSkill };
}

/** Map an autonomy level to its 0..3 rank — useful for comparisons by callers. */
export function levelRank(level: AutonomyLevel): number {
  return LEVEL_RANK[level];
}

/** Map a 0..3 rank back to its level (clamped). */
export function levelForRank(rank: number): AutonomyLevel {
  return RANK_TO_LEVEL[Math.max(0, Math.min(3, rank))]!;
}
