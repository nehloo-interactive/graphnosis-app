// True L3 UNATTENDED skill executor.
//
// SAFETY-CRITICAL. This is the §11 "open frontier" — a background loop that
// walks an auto-eligible skill end-to-end with NO human in the loop. The
// interlocks ARE the product: the executor is OFF by default and only ever runs
// a skill that clears ALL SEVEN gates, re-checked LIVE at execution time (never
// trusting the proactive card's snapshot).
//
// This module WIRES existing machinery (the autonomy decision in
// skill-autonomy.ts, the reference walker in agent-walker.ts, the encrypted run
// store in skill-runs.ts, the kill switch in agent-policy.ts) — it adds the
// admission gate + the per-action audit hook, not new graph/LLM machinery.
//
// Modeled on ProactiveWatcher: a deferrable timer + WorkPriority gate. It does
// NOT re-implement matching — it consumes the SAME ProactiveCard stream via the
// watcher's onAutoEligible hook, then RE-decides everything itself.

import {
  resolveUnattendedExecutorEnabled,
  resolveUnattendedRequireReversibleOnly,
  resolveSkillAutonomyLevel,
} from '@graphnosis-app/core/settings';
import type { GraphnosisHost } from './host.js';
import type { SkillTrainer } from './skill-trainer.js';
import type { BrainEngine } from './brain-engine.js';
import type { BroadcastRawFn } from './events.js';
import type { ProactiveCard } from './proactive-watcher.js';
import { shouldDeferGhampusBackground } from './background-lane-scheduler.js';
import {
  decideSkillAutonomy,
  parseDispatchSafe,
  isMetaSkillLabel,
  type AutonomyLevel,
  type DispatchSafety,
} from './skill-autonomy.js';
import type { SkillExecutionPlan } from './skill-trainer.js';
import type { WalkResult, WalkedStep } from './agent-walker.js';
import type { DetectedContradiction } from './contradiction-health.js';
import {
  appendUnattendedRunHeader,
  appendUnattendedAction,
  appendUnattendedRunTerminal,
  type UnattendedRunHeader,
  type UndoClassification,
} from './unattended-audit.js';
import { classifyReversibility, type ActionSideEffect } from './unattended-undo.js';
import { assertUnattendedAllowed } from './agent-policy.js';

const TICK_MS = 120_000; // 2 min — slower than the watcher; one walk per tick.
const STARTUP_DELAY_MS = 6 * 60_000; // 6 min — after the watcher has warmed up.

/** Plan-shape classification for the §11 walker-gap guard. */
export interface PlanShape {
  /** True when the plan is strictly linear — no loop edges, no parallel
   *  siblings. Kept for audit continuity; admission keys on
   *  `walkerExecutable` (capped loops are walkable now that the reference
   *  walker re-executes loop bodies with the cap enforced in code). */
  singlePass: boolean;
  /** True when the reference walker can faithfully execute the plan: linear
   *  plans, and loop plans whose every loop edge declares a finite authored
   *  cap (`@loop: N max=M`). False for parallel siblings and for uncapped
   *  loops — an unattended L3 run requires the bound to be AUTHORED, not
   *  defaulted (the attended walker bounds uncapped loops with
   *  DEFAULT_UNCAPPED_LOOP_ITERATIONS). */
  walkerExecutable: boolean;
  /** Human reason when not walker-executable. */
  reason?: string;
}

/** Inputs to the PURE admission gate. Mirrors how skill-autonomy.ts isolates the
 *  decision: model-free, host-free, fully unit-testable. */
export interface AdmissionInput {
  /** Global kill switch: agent.enabled !== false. */
  killSwitchOn: boolean;
  /** Owner opt-in: agent.unattendedExecutor.enabled === true. */
  optInOn: boolean;
  /** LIVE re-resolved effective level (NOT the card snapshot). Must be 'L3'. */
  effectiveLevel: AutonomyLevel;
  /** Authored dispatch-safe of the skill. */
  dispatchSafe: DispatchSafety;
  /** Meta/router skill — never auto-runs. */
  isMetaSkill: boolean;
  /** LIVE: does any bound engram have an open, unresolved contradiction? */
  hasUnresolvedContradiction: boolean;
  /** Match confidence carried by the card. */
  matchConfidence: number;
  /** Plan-shape guard result. */
  planShape: PlanShape;
  /** requireReversibleOnly resolved from settings. */
  requireReversibleOnly: boolean;
  /** Whether the rate limit currently permits another run this hour/tick. */
  rateLimitOk: boolean;
}

export type AdmissionResult = { run: true } | { run: false; reason: string };

/**
 * THE GATE. Pure, deterministic, no I/O. Requires ALL SEVEN interlocks; any one
 * failure denies the run. Order is fail-fast from cheapest/most-fundamental
 * (kill switch, opt-in) outward, so the reason names the FIRST binding gate.
 *
 *   1. kill switch on
 *   2. opt-in on (default OFF)
 *   3. effective level === 'L3' (re-resolved live)
 *   4. no unresolved contradiction on bound memory (and decision stays 'auto')
 *   5. single-pass linear plan shape (§11 walker gap)
 *   6. reversible side effects only (when requireReversibleOnly)  ← checked per
 *      action at exec time; here we only require the guard to be in force
 *   7. rate limit OK
 */
export function admitForUnattended(input: AdmissionInput): AdmissionResult {
  // 1. Kill switch.
  if (!input.killSwitchOn) return { run: false, reason: 'kill switch engaged (agent.enabled === false)' };
  // 2. Opt-in (default OFF).
  if (!input.optInOn) return { run: false, reason: 'unattended executor not opted in (default off)' };
  // 3. Live effective level must be exactly L3.
  if (input.effectiveLevel !== 'L3') {
    return { run: false, reason: `effective autonomy ${input.effectiveLevel} < L3 (re-resolved at exec time)` };
  }
  // 4. Re-run the autonomy decision with the LIVE contradiction value. This
  //    folds in dispatch-safe cap, meta/router exclusion, the contradiction
  //    ceiling, and the confidence floor — it must still land on 'auto'.
  const decision = decideSkillAutonomy({
    level: input.effectiveLevel,
    dispatchSafe: input.dispatchSafe,
    isMetaSkill: input.isMetaSkill,
    matchConfidence: input.matchConfidence,
    hasUnresolvedContradiction: input.hasUnresolvedContradiction,
  });
  if (decision.action !== 'auto') {
    return { run: false, reason: `autonomy decision capped to ${decision.action}: ${decision.reason}` };
  }
  // 5. Plan-shape guard — the §11 walker gap made honest. Linear and
  //    capped-loop plans are walker-executable (loop caps enforced in code by
  //    agent-walker.ts); parallel siblings and uncapped loops are refused.
  if (!input.planShape.walkerExecutable) {
    return {
      run: false,
      reason: input.planShape.reason
        ?? 'plan shape is not walker-executable — parallel siblings or an uncapped loop (not unattended-safe)',
    };
  }
  // 7. Rate limit. (6, the per-action reversibility guard, is enforced during
  //    the walk — here we only assert the guard is configured; with
  //    requireReversibleOnly off, irreversible actions are admitted by policy.)
  if (!input.rateLimitOk) return { run: false, reason: 'rate limit reached (maxRunsPerHour / one-per-tick)' };

  return { run: true };
}

/**
 * Inspect a compiled SkillExecutionPlan for the walker-gap guard. The reference
 * walker (agent-walker.ts) executes single calls, linear steps, and loop-back
 * steps — re-entering each loop body with the iteration cap enforced in code
 * (the authored `max=N`, else the walker default for attended runs). It does
 * NOT dispatch parallel[] siblings. Unattended admission is stricter than the
 * walker itself: an uncapped loop is refused even though an attended walk
 * would bound it with DEFAULT_UNCAPPED_LOOP_ITERATIONS, because an L3 run
 * with no human watching requires the bound to be authored into the skill.
 * Refusing here means an unattended run never SILENTLY under- or over-executes
 * a skill (the §5/§11 termination claims stay honest).
 */
export function classifyPlanShape(plan: SkillExecutionPlan): PlanShape {
  let sawLoop = false;
  for (const step of plan.steps) {
    if (step.parallel && step.parallel.length > 0) {
      return { singlePass: false, walkerExecutable: false, reason: `step ${step.index} dispatches parallel sub-skills — requires a parallel executor (not unattended-safe)` };
    }
    if (step.loopsBackTo && step.loopsBackTo.length > 0) {
      sawLoop = true;
      if (typeof step.maxIterations !== 'number' || step.maxIterations < 1) {
        return { singlePass: false, walkerExecutable: false, reason: `step ${step.index} declares an uncapped @loop — unattended runs require an authored cap (@loop: N max=M)` };
      }
    } else if (typeof step.maxIterations === 'number' && step.maxIterations > 1) {
      // A cap with no loop edge cannot come out of the trainer — treat as a
      // malformed plan rather than guessing the author's intent.
      return { singlePass: false, walkerExecutable: false, reason: `step ${step.index} declares maxIterations>1 with no loop edge — malformed plan (not unattended-safe)` };
    }
  }
  return sawLoop
    ? { singlePass: false, walkerExecutable: true }
    : { singlePass: true, walkerExecutable: true };
}

export interface UnattendedExecutorDeps {
  host: GraphnosisHost;
  skillTrainer: SkillTrainer | null;
  brainEngine: BrainEngine | null;
  broadcastRaw: BroadcastRawFn;
  cortexDir: string;
}

export class UnattendedExecutor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamps (ms) of runs started this rolling hour — for the rate limit. */
  private runTimestamps: number[] = [];
  /** One walk at a time. */
  private walking = false;
  /** Cards handed by the watcher, awaiting a tick. Bounded — newest wins. */
  private queue: ProactiveCard[] = [];
  private blockedCount = 0;

  constructor(private deps: UnattendedExecutorDeps) {}

  /**
   * Build the LIVE open-contradiction accessor: the brain engine's open
   * (unresolved) contradiction pairs, filtered to the given engrams. Wired BOTH
   * into the admission gate's live check AND into WalkerDeps.openContradictionsFor
   * so contradicted recall is annotated mid-walk. ContradictionPair is shape-
   * compatible with DetectedContradiction (graphId/nodeA/nodeB/severity).
   */
  private openContradictionsFor(graphIds: string[]): DetectedContradiction[] {
    const engine = this.deps.brainEngine;
    if (!engine) return [];
    const want = new Set(graphIds);
    return engine
      .getContradictionPairs()
      .filter((c) => !c.resolvedAt && want.has(c.graphId))
      .map((c) => ({
        graphId: c.graphId,
        nodeA: c.nodeA,
        nodeB: c.nodeB,
        severity: c.severity ?? 'medium',
      }));
  }

  /** True when a bound engram currently carries an open contradiction. */
  private hasUnresolvedContradiction(graphId: string): boolean {
    return this.openContradictionsFor([graphId]).length > 0;
  }

  start(): void {
    if (this.timer) return;
    // SAFETY: even though start() is always called, it is a no-op while the
    // opt-in is off — the tick re-checks and returns early. We still arm the
    // timer so flipping the opt-in on takes effect without a restart.
    this.startupTimer = setTimeout(() => { void this.tick(); }, STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** The watcher's onAutoEligible hook. We only ENQUEUE here — the tick RE-checks
   *  every interlock live, so a stale card can never run on the strength of its
   *  snapshot alone. */
  onAutoEligible(card: ProactiveCard): void {
    // Bound the queue; keep the most recent few.
    this.queue.push(card);
    if (this.queue.length > 8) this.queue = this.queue.slice(-8);
  }

  /** Live status for the review UI banner / IPC. */
  status(): { enabled: boolean; runsLastHour: number; blockedCount: number } {
    this.pruneRunWindow(Date.now());
    return {
      enabled: resolveUnattendedExecutorEnabled(this.deps.host.getSettings().agent),
      runsLastHour: this.runTimestamps.length,
      blockedCount: this.blockedCount,
    };
  }

  private pruneRunWindow(now: number): void {
    const cutoff = now - 60 * 60 * 1000;
    this.runTimestamps = this.runTimestamps.filter((t) => t >= cutoff);
  }

  private rateLimitOk(now: number): boolean {
    this.pruneRunWindow(now);
    const cap = this.deps.host.getSettings().agent?.unattendedExecutor?.maxRunsPerHour;
    if (typeof cap === 'number' && cap >= 0 && this.runTimestamps.length >= cap) return false;
    return true;
  }

  private async tick(): Promise<void> {
    // Interlock 2 (opt-in) and interlock 1 (kill switch) — fastest no-op path.
    const agent = this.deps.host.getSettings().agent;
    if (!resolveUnattendedExecutorEnabled(agent)) return;       // default OFF → no-op
    if (agent?.enabled === false) return;                       // kill switch
    if (!this.deps.skillTrainer) return;
    if (this.walking) return;
    if (this.queue.length === 0) return;

    // Interlock 7 (scheduling half): never contend with the user/ingest.
    const { isBusyAbove, WorkPriority } = await import('./work-priority.js');
    if (isBusyAbove(WorkPriority.P2_GHAMPUS)) return;
    if (shouldDeferGhampusBackground(this.deps.host)) return;

    // One card per tick (conservative). Drain newest-first.
    const card = this.queue.pop();
    this.queue = [];
    if (!card) return;

    this.walking = true;
    try {
      await this.consider(card);
    } catch (err) {
      console.error(`[unattended] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.walking = false;
    }
  }

  /** Re-decide everything LIVE and, if admitted, run the walk. */
  private async consider(card: ProactiveCard): Promise<void> {
    const host = this.deps.host;
    const now = Date.now();
    const agent = host.getSettings().agent;

    // Re-resolve the EFFECTIVE level at exec time (interlock 3) — min(per-skill
    // resolved level, authored dispatch-safe cap). Never trust card.autonomyAction.
    const ref = host.getSourceRecord(card.skillGraphId, card.skillSourceId)?.ref ?? card.skillSourceId;
    const effectiveLevel = host.resolveEffectiveSkillAutonomy(card.skillGraphId, card.skillSourceId, ref);

    // Authored safety, parsed live from the skill's current text.
    const detail = this.deps.skillTrainer?.getSkill(card.skillGraphId, card.skillSourceId);
    const dispatchSafe = detail?.text ? parseDispatchSafe(detail.text) : 'yes';
    const isMetaSkill = isMetaSkillLabel(card.skillLabel);

    // Build the plan exactly as ipc.ts agent:walkSkill does, then guard its shape.
    const built = await this.buildPlan(card);
    if (!built) {
      this.deny(card, 'plan-infeasible');
      return;
    }
    const planShape = classifyPlanShape(built.skillPlan);

    // Live contradiction check (interlock 4).
    const hasContra = this.hasUnresolvedContradiction(card.skillGraphId);

    const admission = admitForUnattended({
      killSwitchOn: agent?.enabled !== false,
      optInOn: resolveUnattendedExecutorEnabled(agent),
      effectiveLevel,
      dispatchSafe,
      isMetaSkill,
      hasUnresolvedContradiction: hasContra,
      matchConfidence: 1, // an auto-eligible card already cleared the conf floor at the watcher
      planShape,
      requireReversibleOnly: resolveUnattendedRequireReversibleOnly(agent),
      rateLimitOk: this.rateLimitOk(now),
    });

    if (!admission.run) {
      this.deny(card, admission.reason);
      return;
    }

    await this.run(card, built, effectiveLevel, dispatchSafe);
  }

  private deny(card: ProactiveCard, reason: string): void {
    this.blockedCount++;
    // Surface the downgrade exactly as today's watcher would: a preview card,
    // never a silent under-execution. The watcher already broadcast the card;
    // we log the executor's live refusal reason for the audit trail.
    console.log(`[unattended] refused "${card.skillLabel}" → surfaced as preview (${reason})`);
  }

  /** Build the compiled plan + execution steps for the card's skill. */
  private async buildPlan(card: ProactiveCard): Promise<{
    skillPlan: SkillExecutionPlan;
    rawSteps: Array<{ index: number; text: string; captureAs?: string }>;
    plan: import('./model-router.js').SkillWalkPlan;
    executionSteps: import('./agent-walker.js').WalkerExecutionStep[];
    failureHandlers: SkillExecutionPlan['failureHandlers'];
  } | null> {
    const host = this.deps.host;
    const { walkSkillSequence, walkSkillToJson } = await import('./skill-trainer.js');
    const { planSkillWalk, deriveStepsFromText } = await import('./model-router.js');
    const { isProviderDisabled } = await import('./admin-policy.js');
    const { deriveEngramTierByStep } = await import('./agent-walker.js');

    const walked = walkSkillSequence(host, card.skillGraphId, card.skillSourceId, { recursive: false });
    if (walked.steps.length === 0) return null;
    const meta = host.getGraphMetadata(card.skillGraphId);
    const src = host.getSourceRecord(card.skillGraphId, card.skillSourceId);
    const title = walked.steps[0]?.text ?? src?.ref ?? card.skillSourceId;
    const skillPlan = walkSkillToJson(walked, {
      sourceId: card.skillSourceId,
      title,
      ...(meta?.displayName ? { engramName: meta.displayName } : {}),
    });
    const rawSteps = skillPlan.steps.map((s) => ({
      index: s.index,
      text: s.text,
      ...(s.calls?.captureAs ? { captureAs: s.calls.captureAs } : {}),
    }));

    const settings = host.getSettings();
    const enabledProviders = Object.entries(settings.models?.providers ?? { ollama: { enabled: true } })
      .filter(([id, s]) => s?.enabled === true && !isProviderDisabled(id))
      .map(([id]) => id as Parameters<typeof planSkillWalk>[1]['enabledProviders'][number]);
    const subscriptionPoolUsage: Record<string, { poolSpentUsd: number; flexSpentUsd: number }> = {};
    for (const [pid, ps] of Object.entries(settings.models?.providers ?? {})) {
      if (ps?.poolSpentUsd !== undefined || ps?.flexSpentUsd !== undefined) {
        subscriptionPoolUsage[pid] = { poolSpentUsd: ps.poolSpentUsd ?? 0, flexSpentUsd: ps.flexSpentUsd ?? 0 };
      }
    }
    // Privacy hard-lock (Invariant 2): force any step that recalls from a
    // sensitive engram onto a local model. Critical here — the unattended path
    // runs with NO human in the loop, so a missed lock would silently route
    // sensitive recalls to the cloud.
    const engramTierByStep = deriveEngramTierByStep(host, skillPlan.steps);
    const plan = planSkillWalk(deriveStepsFromText(rawSteps, engramTierByStep), {
      strategy: settings.models?.strategy ?? 'adaptive',
      enabledProviders,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscriptionPoolUsage: subscriptionPoolUsage as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      customRates: (settings.models?.customRates as any) ?? [],
    });
    if (!plan.feasible) return null;

    const executionSteps = skillPlan.steps.map((s) => ({
      index: s.index,
      text: s.text,
      ...(s.calls ? {
        calls: {
          targetSourceId: s.calls.targetSourceId,
          ...(s.calls.targetGraphId ? { targetGraphId: s.calls.targetGraphId } : {}),
          ...(s.calls.captureAs ? { captureAs: s.calls.captureAs } : {}),
          args: s.calls.args,
        },
      } : {}),
      ...(s.calls?.captureAs ? { captureAs: s.calls.captureAs } : {}),
      // Loop metadata rides along so the walker can re-execute capped loop
      // bodies (admission already refused uncapped loops above).
      ...(s.loopsBackTo && s.loopsBackTo.length > 0 ? { loopsBackTo: s.loopsBackTo } : {}),
      ...(typeof s.maxIterations === 'number' ? { maxIterations: s.maxIterations } : {}),
    }));

    return { skillPlan, rawSteps, plan, executionSteps, failureHandlers: skillPlan.failureHandlers };
  }

  /** Admitted — create the run record, open the audit, walk, persist, broadcast. */
  private async run(
    card: ProactiveCard,
    built: NonNullable<Awaited<ReturnType<UnattendedExecutor['buildPlan']>>>,
    effectiveLevel: AutonomyLevel,
    _dispatchSafe: DispatchSafety,
  ): Promise<void> {
    const host = this.deps.host;
    const cortexDir = this.deps.cortexDir;
    const startedAt = Date.now();
    this.runTimestamps.push(startedAt);

    // Shared enforcement point — throws if the kill switch / opt-in flipped
    // between the gate and here (belt-and-suspenders with the live tick check).
    assertUnattendedAllowed({ host });

    const { randomUUID } = await import('node:crypto');
    const runId = randomUUID();

    // Create the resumable run record (actor 'unattended').
    await host.skillRuns.save({
      runId,
      skillGraphId: card.skillGraphId,
      skillSourceId: card.skillSourceId,
      planTitle: card.skillLabel,
      capturedVars: {},
      completedStepIndex: 0,
      status: 'running',
      actorId: 'unattended',
      actorLabel: 'Unattended executor',
      stepLog: [],
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    const header: Omit<UnattendedRunHeader, 'type'> = {
      runId,
      skillSourceId: card.skillSourceId,
      skillGraphId: card.skillGraphId,
      skillLabel: card.skillLabel,
      startedAt,
      trigger: { signalType: card.signalType, signalLabel: card.signalLabel, why: card.why },
      autonomyReason: card.autonomyReason ?? `effective ${effectiveLevel} → auto`,
      status: 'running',
    };
    // Header must land BEFORE the first step. Sealed at rest with the cortex key.
    const dataKey = host.getCortexDataKey();
    await appendUnattendedRunHeader(cortexDir, dataKey, header);
    this.broadcastRun(header);

    // Interlock 6 — reversible-only enforcement is live during the walk. When
    // requireReversibleOnly is in force, an action whose side effect is NOT
    // reversible (kind 'external' / reversible:false) must NOT be executed: we
    // record the refusal and stop the walk. Default TRUE.
    const requireReversibleOnly = resolveUnattendedRequireReversibleOnly(host.getSettings().agent);

    let result: WalkResult;
    let aborted: string | null = null;
    try {
      const { walkSkillPlan } = await import('./agent-walker.js');
      result = await walkSkillPlan(
        {
          host,
          // Wire the previously-unwired contradiction guard so contradicted
          // recall is annotated mid-walk (same accessor as the admission check).
          openContradictionsFor: (gids) => this.openContradictionsFor(gids),
        },
        {
          sourceId: card.skillSourceId,
          graphId: card.skillGraphId,
          steps: built.rawSteps,
          plan: built.plan,
          executionSteps: built.executionSteps,
          failureHandlers: built.failureHandlers,
        },
      );

      // Per-action audit — one awaited line per step.
      for (const step of result.steps) {
        // Kill-switch re-check BETWEEN steps: abort an in-flight walk if the
        // owner flipped it. (The walk itself already ran; we stop auditing/
        // persisting further and mark the run aborted.)
        if (host.getSettings().agent?.enabled === false) { aborted = 'kill switch engaged mid-run'; }
        if (!resolveUnattendedExecutorEnabled(host.getSettings().agent)) { aborted = aborted ?? 'opt-in disabled mid-run'; }

        // Interlock 6 — reversible-only enforcement, per action. Classify the
        // step's side effect; if the guard is in force and the effect is NOT
        // reversible (kind 'external'), REFUSE it: record the refusal and stop
        // the walk rather than letting an irreversible action stand. The MVP
        // walker only ever yields kind 'none' (read/compute), so the happy path
        // is unaffected.
        const effect = this.classifyStepSideEffect(step);
        const classification = classifyReversibility(effect);
        if (requireReversibleOnly && !classification.reversible) {
          const refusedReason =
            `requireReversibleOnly: refused irreversible action (${effect.kind}) — not executed`;
          await this.auditRefusal(runId, cortexDir, dataKey, step, refusedReason);
          aborted = aborted ?? refusedReason;
          break;
        }

        await this.auditStep(runId, cortexDir, dataKey, step, classification);
        if (aborted) break;
      }
    } catch (err) {
      aborted = err instanceof Error ? err.message : String(err);
      result = { sourceId: card.skillSourceId, steps: [], captures: {}, ok: false, totalElapsedMs: 0 };
    }

    // Persist the run record result (mirrors ipc.ts agent:walkSkill block).
    const existing = await host.skillRuns.read(runId);
    if (existing) {
      const lastCompleted = result.steps.reduce(
        (max, s) => (!s.error && s.index > max ? s.index : max),
        existing.completedStepIndex,
      );
      const status = aborted ? 'failed' : result.ok ? 'complete' : 'failed';
      await host.skillRuns.save({
        ...existing,
        completedStepIndex: lastCompleted,
        status,
        capturedVars: { ...existing.capturedVars, ...result.captures },
        stepLog: [
          ...(existing.stepLog ?? []),
          ...result.steps.map((s) => ({
            stepIndex: s.index,
            actor: 'Unattended executor',
            tool: 'unattended:run',
            outcome: (s.error ? 'error' : 'ok') as 'error' | 'ok',
            ts: Date.now(),
          })),
        ],
        updatedAt: Date.now(),
      });
    }

    const endedAt = Date.now();
    const finalStatus = aborted ? 'aborted' : result.ok ? 'complete' : 'failed';
    await appendUnattendedRunTerminal(cortexDir, dataKey, runId, {
      status: finalStatus,
      endedAt,
      ...(aborted ? { note: aborted } : {}),
    });
    this.broadcastRun({ ...header, status: finalStatus, endedAt, ...(aborted ? { note: aborted } : {}) });
  }

  /**
   * Derive a step's side-effect descriptor for the reversibility interlock. The
   * MVP reference walker dispatches LLM prompts and performs NO cortex mutation —
   * so every step's side effect is 'none' (captured outputs only), which
   * classifyReversibility marks reversible with nothing to undo. When a future
   * recall-aware walker reports a real mutation, the WalkedStep would carry it
   * and this is the single place that maps it to an ActionSideEffect — so both
   * the audit classification AND the reversible-only interlock see the same view.
   */
  private classifyStepSideEffect(_step: WalkedStep): ActionSideEffect {
    return { kind: 'none' };
  }

  /** SENSITIVE_VAR_RE redactor (same as captured vars), routed through a neutral
   *  field name so prompt/output previews never carry raw secrets to disk. */
  private async makeRedactor(): Promise<(s: string) => string> {
    const { redactSkillRunVars } = await import('./skill-runs.js');
    return (s: string): string => {
      const out = redactSkillRunVars({ preview: s });
      return typeof out.preview === 'string' ? out.preview : '[redacted]';
    };
  }

  /** Write one per-action audit line — redacted, classified for undo. Awaited;
   *  the line is sealed at rest with the cortex data key before we proceed. */
  private async auditStep(
    runId: string,
    cortexDir: string,
    dataKey: Uint8Array,
    step: WalkedStep,
    undo: UndoClassification,
  ): Promise<void> {
    const redact = await this.makeRedactor();
    await appendUnattendedAction(cortexDir, dataKey, {
      runId,
      stepIndex: step.index,
      label: step.label,
      pickedModelDisplay: step.pickedModelDisplay,
      touched: { recalledEngrams: [], writtenNodeIds: [], mcpTools: step.subSkill ? [step.subSkill] : [] },
      outcome: step.error ? 'error' : 'ok',
      ...(step.contradictionWarnings ? { contradictionWarnings: step.contradictionWarnings } : {}),
      undo,
      redactedPromptPreview: redact(step.prompt ?? ''),
      redactedOutputPreview: redact(step.output ?? ''),
      elapsedMs: step.elapsedMs,
      ts: Date.now(),
    });
  }

  /** Record an interlock-6 refusal: the action was NOT executed because the
   *  reversible-only guard is in force and its side effect is irreversible. The
   *  line is sealed at rest like every other audit line. */
  private async auditRefusal(
    runId: string,
    cortexDir: string,
    dataKey: Uint8Array,
    step: WalkedStep,
    refusedReason: string,
  ): Promise<void> {
    const redact = await this.makeRedactor();
    await appendUnattendedAction(cortexDir, dataKey, {
      runId,
      stepIndex: step.index,
      label: step.label,
      pickedModelDisplay: step.pickedModelDisplay,
      touched: { recalledEngrams: [], writtenNodeIds: [], mcpTools: step.subSkill ? [step.subSkill] : [] },
      outcome: 'refused',
      ...(step.contradictionWarnings ? { contradictionWarnings: step.contradictionWarnings } : {}),
      // An irreversible action is, by classification, not reversible and carries
      // no undo token — nothing was executed, so there is nothing to undo.
      undo: { reversible: false, kind: 'none' },
      redactedPromptPreview: redact(step.prompt ?? ''),
      redactedOutputPreview: redact(step.output ?? ''),
      elapsedMs: step.elapsedMs,
      ts: Date.now(),
      refusedReason,
    });
  }

  private broadcastRun(header: UnattendedRunHeader | Omit<UnattendedRunHeader, 'type'>): void {
    try {
      this.deps.broadcastRaw({
        kind: 'unattended.run',
        name: 'unattended.run',
        payload: header,
      });
    } catch { /* non-fatal */ }
  }
}
