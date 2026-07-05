// Skill walker — drives a SkillWalkPlan to actual execution by dispatching
// each step to its chosen model and capturing the result.
//
// Providers:
//   - Ollama: local HTTP to localhost:11434
//   - Anthropic / OpenAI-compatible: BYOK cloud adapters (Settings → Models)
//   - mlx / vllm: OpenAI-compatible local endpoints (Settings → Models baseUrl)
//   - Sub-skill recursion via `@skill:` calls (depth-capped)
//   - Loop re-execution: `skill:loop` edges re-enter the body with the
//     iteration cap enforced in code (declared `max=N`, else the walker default)
//   - Failure handlers: one recovery sub-skill + one step retry

import { OllamaLlm } from './local-llm.js';
import { settings as settingsMod } from '@graphnosis-app/core';
import { dispatchCloudModelCall, dispatchLocalOpenAiModelCall, OPENAI_COMPAT_BASE_URLS } from './cloud-llm.js';
import { recordRoutingSavings, resolveSavingsBaseline } from './savings-tracker.js';
import type { GraphnosisHost } from './host.js';
import type { SkillWalkPlan, PlannedStep } from './model-router.js';
import { planSkillWalk, deriveStepsFromText } from './model-router.js';
import { walkSkillSequence, walkSkillToJson } from './skill-trainer.js';
import { getKnownModel, type ModelProviderId } from './model-registry.js';
import { isProviderDisabled } from './admin-policy.js';
import { extractRecipeEngramNames, resolveEngramScope } from './skill-recall-bindings.js';
import {
  surfaceContradictionsForRecall,
  type DetectedContradiction,
  type RecallContradictionWarning,
  type RecallHitRef,
} from './contradiction-health.js';

/** Max nested `@skill:` depth — prevents runaway recursion. */
const MAX_SUB_SKILL_DEPTH = 3;

/**
 * Iteration cap the walker imposes on an UNCAPPED loop edge (`@loop` with no
 * `max=N`). The plan contract deliberately leaves the stopping decision to the
 * executor ("absent = no cap; the executor decides when to stop" —
 * skill-trainer.ts); this constant IS that decision, made deterministic: no
 * loop body ever runs more than this many times without an authored cap.
 * Declared caps (`@loop: N max=M`) always take precedence.
 */
export const DEFAULT_UNCAPPED_LOOP_ITERATIONS = 3;

/**
 * Hard backstop on total step executions in one walk, loop re-execution
 * included. Per-edge caps already bound every walk — each cap is a lifetime
 * budget for its edge within one walk (never reset by an enclosing loop), so
 * total executions ≤ steps · (1 + Σ caps) — this guard exists so a future
 * scheduler bug can still never run away. Generous: the trained corpus tops
 * out near 45 plan steps.
 */
export const MAX_TOTAL_STEP_EXECUTIONS = 500;

export interface WalkerDeps {
  host: GraphnosisHost;
  /**
   * Optional contradiction-health guard. When wired, a recall-recipe step that
   * pulls node refs is checked against the open (unresolved) contradictions for
   * those engrams, and any warnings are annotated onto the WalkedStep — the walk
   * is NEVER blocked or altered, only annotated.
   *
   * Returns the open DetectedContradiction[] touching the given engrams. Left
   * unwired by default: the current walker dispatches each step as an LLM prompt
   * and does not perform a live cortex recall, so node refs are rarely available
   * at walk time. The plumbing sits behind this guard so a future recall-aware
   * walker can light it up by passing the brain-engine's open pairs.
   *
   * WIRED by the UNATTENDED executor (unattended-executor.ts): an unattended walk
   * passes the brain engine's open (unresolved) contradiction pairs here — the
   * SAME accessor its admission gate uses for the live uncontradicted-memory
   * interlock — so any contradicted recall a step surfaces is annotated onto the
   * WalkedStep and captured in the per-action audit.
   */
  openContradictionsFor?: (graphIds: string[]) => DetectedContradiction[];
}

export interface WalkerStepInput {
  index: number;
  text: string;
  captureAs?: string;
}

export interface WalkerStepCall {
  targetSourceId: string;
  targetGraphId?: string;
  captureAs?: string;
  args?: string[];
}

export interface WalkerFailureHandler {
  description: string;
  targetSourceId?: string;
  targetTitle?: string;
  args?: string[];
  unresolvedCall?: string;
}

export interface WalkerExecutionStep {
  index: number;
  text: string;
  calls?: WalkerStepCall;
  captureAs?: string;
  /** 1-based earlier step indices this step loops back to (`skill:loop` edge). */
  loopsBackTo?: number[];
  /** Authored loop cap (`@loop: N max=M`). Absent = uncapped: the walker
   *  applies DEFAULT_UNCAPPED_LOOP_ITERATIONS. */
  maxIterations?: number;
}

export interface WalkerInput {
  sourceId: string;
  graphId: string;
  steps: WalkerStepInput[];
  plan: SkillWalkPlan;
  initialCaptures?: Record<string, string>;
  executionSteps?: WalkerExecutionStep[];
  failureHandlers?: WalkerFailureHandler[];
  recursionDepth?: number;
}

export interface WalkedStep {
  index: number;
  label: string;
  pickedModelId: string | null;
  pickedModelDisplay: string | null;
  prompt: string;
  output: string;
  elapsedMs: number;
  capturedAs?: { name: string; value: string };
  error?: string;
  /** True when this step delegated to a sub-skill walk instead of an LLM. */
  subSkill?: string;
  /**
   * Walk-time contradiction guard annotations (contradiction-health.ts). Present
   * only when a recall-recipe step pulled node refs that sit on an unresolved
   * contradiction AND WalkerDeps.openContradictionsFor was wired. Advisory — the
   * walk proceeds regardless; this just flags "⚠ contradicted memory".
   */
  contradictionWarnings?: RecallContradictionWarning[];
  /** Loop bookkeeping: which body iteration this execution belonged to.
   *  Present only when ≥2 — i.e. the step ran because a loop edge re-entered
   *  it. First-pass executions carry no tag. */
  loopIteration?: number;
}

export interface WalkResult {
  sourceId: string;
  steps: WalkedStep[];
  captures: Record<string, string>;
  ok: boolean;
  totalElapsedMs: number;
  /** Per-loop-edge execution report (present when the plan declared loop edges). */
  loops?: LoopRunReport[];
  /** Set when MAX_TOTAL_STEP_EXECUTIONS tripped and the walk was halted. */
  executionGuardTripped?: boolean;
}

// ── Loop scheduler (pure, model-free — unit-testable without a host) ────────

export interface LoopRunReport {
  /** 1-based index of the loop-closing step (edge source). */
  fromIndex: number;
  /** 1-based index the edge jumps back to (edge target). */
  toIndex: number;
  /** Enforced iteration cap for the loop body. */
  cap: number;
  capSource: 'declared' | 'default';
  /** Body iterations actually completed (1 = single pass, no re-entry). */
  iterations: number;
  /** Why looping stopped: cap hit, body output converged (fixed point), or
   *  structurally invalid target (never jumped). Null when the loop-closing
   *  step was never reached. */
  stop: 'cap' | 'converged' | 'invalid-target' | null;
}

export interface LoopScheduler {
  /** The validated jump target for a loop-closing step, or null when the step
   *  carries no (structurally valid) loop edge. */
  edgeTarget(fromIndex: number): number | null;
  /**
   * Called when the loop-closing step at `fromIndex` completes one body
   * iteration. `bodySignature` is a deterministic digest of the body outputs
   * for this iteration; two identical consecutive signatures = converged
   * (fixed point), stop early. Returns the jump, or null to fall through —
   * the cap is enforced HERE, in code, never delegated to the model.
   */
  onLoopStepComplete(fromIndex: number, bodySignature: string): { jumpTo: number; nextIteration: number } | null;
  report(): LoopRunReport[];
}

export function createLoopScheduler(
  steps: Array<Pick<WalkerExecutionStep, 'index' | 'loopsBackTo' | 'maxIterations'>>,
): LoopScheduler {
  interface EdgeState { report: LoopRunReport; lastSignature: string | null }
  const known = new Set(steps.map((s) => s.index));
  const edges = new Map<number, EdgeState>();
  for (const s of steps) {
    if (!s.loopsBackTo || s.loopsBackTo.length === 0) continue;
    // First structurally valid target wins (the trainer emits one loop edge
    // per step in practice). A target that names a missing or non-earlier
    // step is recorded as invalid and never jumped — reported, not silent.
    const target = s.loopsBackTo.find((t) => known.has(t) && t < s.index);
    const declared = typeof s.maxIterations === 'number' && s.maxIterations >= 1
      ? Math.floor(s.maxIterations)
      : undefined;
    edges.set(s.index, {
      lastSignature: null,
      report: {
        fromIndex: s.index,
        toIndex: target ?? s.loopsBackTo[0] ?? s.index,
        cap: declared ?? DEFAULT_UNCAPPED_LOOP_ITERATIONS,
        capSource: declared !== undefined ? 'declared' : 'default',
        iterations: 0,
        stop: target === undefined ? 'invalid-target' : null,
      },
    });
  }
  return {
    edgeTarget(fromIndex) {
      const edge = edges.get(fromIndex);
      if (!edge || edge.report.stop === 'invalid-target') return null;
      return edge.report.toIndex;
    },
    onLoopStepComplete(fromIndex, bodySignature) {
      const edge = edges.get(fromIndex);
      if (!edge || edge.report.stop === 'invalid-target') return null;
      const r = edge.report;
      r.iterations += 1;
      if (edge.lastSignature !== null && edge.lastSignature === bodySignature) {
        r.stop = 'converged';
        return null;
      }
      edge.lastSignature = bodySignature;
      if (r.iterations >= r.cap) {
        r.stop = 'cap';
        return null;
      }
      return { jumpTo: r.toIndex, nextIteration: r.iterations + 1 };
    },
    report() {
      return [...edges.values()].map((e) => ({ ...e.report }));
    },
  };
}

function resolveEnabledProviders(host: GraphnosisHost): ModelProviderId[] {
  const providers = Object.entries(host.getSettings().models?.providers ?? { ollama: { enabled: true } })
    .filter(([id, s]) => s?.enabled === true && !isProviderDisabled(id))
    .map(([id]) => id as ModelProviderId);
  return providers.length > 0 ? providers : ['ollama'];
}

/**
 * Privacy hard-lock (paper Invariant 2). For each step, find the engrams it
 * recalls from (via its recall recipe / `only_engrams` clause, in the step text
 * or its anchored supporting context), resolve each to its sensitivity tier, and
 * if ANY is `sensitive` mark the WHOLE step `sensitive` — the strictest tier
 * wins. `deriveStepsFromText` turns a `sensitive` tier into `privacyLocked: true`,
 * and the planner then forces that step onto a LOCAL model regardless of strategy
 * or enabled cloud providers.
 *
 * Conservative on ambiguity: a recipe that names a graph we can't resolve at plan
 * time is treated as `sensitive` (lock when unsure), so an unknown engram never
 * routes a recall to the cloud. Steps with no recall recipe get no entry and keep
 * the normal (cloud-eligible) routing.
 */
export function deriveEngramTierByStep(
  host: GraphnosisHost,
  steps: Array<{ index: number; text: string; supportingContext?: string[] }>,
): Record<number, 'public' | 'personal' | 'sensitive'> {
  const tierByStep: Record<number, 'public' | 'personal' | 'sensitive'> = {};
  const rank = (t: 'public' | 'personal' | 'sensitive'): number =>
    t === 'sensitive' ? 2 : t === 'personal' ? 1 : 0;
  for (const step of steps) {
    const blobs = [step.text, ...(step.supportingContext ?? [])];
    const names = new Set<string>();
    for (const blob of blobs) {
      for (const n of extractRecipeEngramNames(blob)) names.add(n);
    }
    if (names.size === 0) continue;
    let stepTier: 'public' | 'personal' | 'sensitive' = 'public';
    for (const name of names) {
      const resolved = resolveEngramScope(host, [name]) ?? [];
      // resolveEngramScope falls back to the raw name when nothing resolves; a
      // graphId we don't actually host has no metadata → treat as sensitive.
      const knownGraphs = host.listGraphs();
      const gids = resolved.filter((g) => knownGraphs.includes(g));
      if (gids.length === 0) {
        // Named engram that doesn't resolve to a hosted graph — lock conservatively.
        stepTier = 'sensitive';
        break;
      }
      for (const gid of gids) {
        const tier = (host.getGraphMetadata(gid)?.sensitivityTier ?? 'personal') as
          'public' | 'personal' | 'sensitive';
        if (rank(tier) > rank(stepTier)) stepTier = tier;
      }
      if (stepTier === 'sensitive') break;
    }
    tierByStep[step.index] = stepTier;
  }
  return tierByStep;
}

function buildPlanForSkill(
  host: GraphnosisHost,
  graphId: string,
  sourceId: string,
): { plan: SkillWalkPlan; rawSteps: WalkerStepInput[]; executionSteps: WalkerExecutionStep[] } | null {
  const walked = walkSkillSequence(host, graphId, sourceId, { recursive: false });
  if (walked.steps.length === 0) return null;
  const meta = host.getGraphMetadata(graphId);
  const src = host.getSourceRecord(graphId, sourceId);
  const title = walked.steps[0]?.text ?? src?.ref ?? sourceId;
  const skillPlan = walkSkillToJson(walked, {
    sourceId,
    title,
    ...(meta?.displayName ? { engramName: meta.displayName } : {}),
  });
  const rawSteps = skillPlan.steps.map((s) => ({
    index: s.index,
    text: s.text,
    ...(s.calls?.captureAs ? { captureAs: s.calls.captureAs } : {}),
  }));
  const settings = host.getSettings();
  const subscriptionPoolUsage: Record<string, { poolSpentUsd: number; flexSpentUsd: number }> = {};
  for (const [pid, ps] of Object.entries(settings.models?.providers ?? {})) {
    if (ps?.poolSpentUsd !== undefined || ps?.flexSpentUsd !== undefined) {
      subscriptionPoolUsage[pid] = { poolSpentUsd: ps.poolSpentUsd ?? 0, flexSpentUsd: ps.flexSpentUsd ?? 0 };
    }
  }
  // Privacy hard-lock: resolve each step's recalled-engram tiers so a step that
  // reads a sensitive engram is forced local. Keyed by the SAME 1-based index
  // rawSteps use (skillPlan.steps[].index), so the maps line up step-for-step.
  const engramTierByStep = deriveEngramTierByStep(host, skillPlan.steps);
  const plan = planSkillWalk(deriveStepsFromText(rawSteps, engramTierByStep), {
    strategy: settings.models?.strategy ?? 'adaptive',
    enabledProviders: resolveEnabledProviders(host),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscriptionPoolUsage: subscriptionPoolUsage as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    customRates: (settings.models?.customRates as any) ?? [],
  });
  const executionSteps: WalkerExecutionStep[] = skillPlan.steps.map((s) => ({
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
    ...(s.loopsBackTo && s.loopsBackTo.length > 0 ? { loopsBackTo: s.loopsBackTo } : {}),
    ...(typeof s.maxIterations === 'number' ? { maxIterations: s.maxIterations } : {}),
  }));
  return { plan, rawSteps, executionSteps };
}

async function executeSubSkillWalk(
  deps: WalkerDeps,
  graphId: string,
  sourceId: string,
  depth: number,
  initialCaptures?: Record<string, string>,
): Promise<WalkResult> {
  if (depth >= MAX_SUB_SKILL_DEPTH) {
    return {
      sourceId,
      steps: [],
      captures: initialCaptures ?? {},
      ok: false,
      totalElapsedMs: 0,
    };
  }
  const built = buildPlanForSkill(deps.host, graphId, sourceId);
  if (!built || !built.plan.feasible) {
    return {
      sourceId,
      steps: [],
      captures: initialCaptures ?? {},
      ok: false,
      totalElapsedMs: 0,
    };
  }
  return walkSkillPlan(deps, {
    sourceId,
    graphId,
    steps: built.rawSteps,
    plan: built.plan,
    executionSteps: built.executionSteps,
    ...(initialCaptures ? { initialCaptures } : {}),
    recursionDepth: depth,
  });
}

/**
 * Execute a planned skill walk. Each step runs against its picked
 * model; captures flow forward. Sub-skill calls recurse with a depth cap.
 * Step failures trigger at most one recovery sub-skill + one retry.
 *
 * Loop re-execution: a step with a `loopsBackTo` edge re-enters its body up to
 * the enforced iteration cap — the authored `max=N` when declared, else
 * DEFAULT_UNCAPPED_LOOP_ITERATIONS — with an early exit when the body's
 * outputs reach a fixed point (identical consecutive iterations). Caps are
 * lifetime budgets per edge within one walk (an enclosing loop does not reset
 * an inner edge's budget), so every capped walk terminates by construction;
 * MAX_TOTAL_STEP_EXECUTIONS backstops the whole walk in code.
 */
export async function walkSkillPlan(deps: WalkerDeps, input: WalkerInput): Promise<WalkResult> {
  const captures: Record<string, string> = { ...(input.initialCaptures ?? {}) };
  const cortexDir = deps.host.getCortexDir();
  const savingsBaseline = resolveSavingsBaseline(deps.host.getSettings());
  const walked: WalkedStep[] = [];
  let totalElapsedMs = 0;
  const depth = input.recursionDepth ?? 0;
  const execByIndex = new Map((input.executionSteps ?? []).map((s) => [s.index, s]));

  const scheduler = createLoopScheduler(input.executionSteps ?? []);
  const posByIndex = new Map(input.steps.map((s, i) => [s.index, i]));
  const lastOutputByIndex = new Map<number, string>();
  /** Digest of the body outputs for a loop edge's current iteration. */
  const bodySignatureFor = (toIndex: number, fromIndex: number): string => {
    const parts: string[] = [];
    for (const s of input.steps) {
      if (s.index >= toIndex && s.index <= fromIndex) {
        parts.push(`${s.index}\u0001${lastOutputByIndex.get(s.index) ?? ''}`);
      }
    }
    return parts.join('\u0000');
  };

  let pos = 0;
  let executions = 0;
  let executionGuardTripped = false;
  /** Set while re-walking a loop body (cleared once the walk passes the
   *  loop-closing step without jumping); tags WalkedStep.loopIteration. */
  let activeLoop: { untilPos: number; iteration: number } | null = null;

  while (pos < input.steps.length) {
    const step = input.steps[pos]!;
    if (executions >= MAX_TOTAL_STEP_EXECUTIONS) {
      executionGuardTripped = true;
      break;
    }
    executions++;
    const execMeta = execByIndex.get(step.index);
    const planned = input.plan.steps.find((p) => p.index === step.index);
    if (!planned) {
      walked.push({
        index: step.index,
        label: step.text.slice(0, 80),
        pickedModelId: null,
        pickedModelDisplay: null,
        prompt: '',
        output: '',
        elapsedMs: 0,
        error: 'No routing plan for step',
      });
      pos++;
      continue;
    }

    const runOnce = async (): Promise<WalkedStep> => {
      if (execMeta?.calls?.targetSourceId && depth < MAX_SUB_SKILL_DEPTH) {
        const subGraph = execMeta.calls.targetGraphId ?? input.graphId;
        const subStarted = Date.now();
        const subArgs = execMeta.calls.args ?? [];
        for (let i = 0; i < subArgs.length; i++) {
          const argName = subArgs[i];
          if (argName && captures[argName] !== undefined) {
            captures[`__sub_arg_${i}`] = captures[argName]!;
          }
        }
        const sub = await executeSubSkillWalk(
          deps,
          subGraph,
          execMeta.calls.targetSourceId,
          depth + 1,
          { ...captures },
        );
        const elapsedMs = Date.now() - subStarted;
        const output = sub.steps.map((s) => s.output).filter(Boolean).join('\n\n')
          || (sub.ok ? 'Sub-skill completed.' : 'Sub-skill failed.');
        const captureName = execMeta.calls.captureAs ?? step.captureAs;
        const capturedAs = captureName
          ? { name: captureName, value: output.trim() }
          : undefined;
        if (capturedAs) captures[capturedAs.name] = capturedAs.value;
        return {
          index: step.index,
          label: planned.label,
          pickedModelId: null,
          pickedModelDisplay: `sub-skill:${execMeta.calls.targetSourceId}`,
          prompt: `[Sub-skill call] ${execMeta.calls.targetSourceId}`,
          output,
          elapsedMs,
          ...(capturedAs ? { capturedAs } : {}),
          subSkill: execMeta.calls.targetSourceId,
          ...(sub.ok ? {} : { error: 'Sub-skill walk reported errors' }),
        };
      }
      return executeModelStep(deps, step, planned, captures, cortexDir, savingsBaseline, input.sourceId);
    };

    let result = await runOnce();
    // Walk-time contradiction guard (annotate only — never block/alter the walk).
    annotateContradictionWarnings(deps, input.graphId, step, result);
    if (result.error && input.failureHandlers?.length) {
      const handler = input.failureHandlers.find((h) => h.targetSourceId);
      if (handler?.targetSourceId) {
        const recoveryStarted = Date.now();
        const recovery = await executeSubSkillWalk(
          deps,
          input.graphId,
          handler.targetSourceId,
          depth + 1,
          { ...captures },
        );
        totalElapsedMs += Date.now() - recoveryStarted;
        if (recovery.captures) Object.assign(captures, recovery.captures);
        result = await runOnce();
        if (!result.error && recovery.ok) {
          result.output = `[Recovery: ${handler.description}]\n${result.output}`;
        }
      }
    }

    totalElapsedMs += result.elapsedMs;
    if (activeLoop) result.loopIteration = activeLoop.iteration;
    walked.push(result);
    lastOutputByIndex.set(step.index, result.output ?? '');

    // Loop decision — cap enforced in code by the scheduler, never the model.
    const loopTarget = scheduler.edgeTarget(step.index);
    if (loopTarget !== null) {
      const jump = scheduler.onLoopStepComplete(step.index, bodySignatureFor(loopTarget, step.index));
      const targetPos = jump ? posByIndex.get(jump.jumpTo) : undefined;
      if (jump && targetPos !== undefined) {
        activeLoop = { untilPos: pos, iteration: jump.nextIteration };
        pos = targetPos;
        continue;
      }
    }
    if (activeLoop && pos >= activeLoop.untilPos) activeLoop = null;
    pos++;
  }

  const loops = scheduler.report();
  return {
    sourceId: input.sourceId,
    steps: walked,
    captures,
    ok: walked.every((s) => !s.error) && !executionGuardTripped,
    totalElapsedMs,
    ...(loops.length > 0 ? { loops } : {}),
    ...(executionGuardTripped ? { executionGuardTripped: true } : {}),
  };
}

async function executeModelStep(
  deps: WalkerDeps,
  step: WalkerStepInput,
  planned: PlannedStep,
  captures: Record<string, string>,
  cortexDir: string,
  savingsBaseline: ReturnType<typeof resolveSavingsBaseline>,
  walkSourceId: string,
): Promise<WalkedStep> {
  if (!planned.pickedModelId) {
    return skeletonStep(step, planned, 'No model satisfies step requirements');
  }
  const model = getKnownModel(planned.pickedModelId);
  if (!model) {
    return skeletonStep(step, planned, `Unknown model: ${planned.pickedModelId}`);
  }
  const prompt = composePrompt(step, captures);
  const startedAt = Date.now();
  try {
    const output = await dispatchModelCall(model.provider, model.modelTag, prompt, deps);
    const elapsedMs = Date.now() - startedAt;
    const capturedAs = step.captureAs
      ? { name: step.captureAs, value: output.trim() }
      : undefined;
    if (capturedAs) captures[capturedAs.name] = capturedAs.value;
    const walkedStep: WalkedStep = {
      index: step.index,
      label: planned.label,
      pickedModelId: planned.pickedModelId,
      pickedModelDisplay: planned.pickedModelDisplay,
      prompt,
      output,
      elapsedMs,
      ...(capturedAs ? { capturedAs } : {}),
    };
    const approxInputTokens = Math.ceil(prompt.length / 4);
    const approxOutputTokens = Math.ceil(output.length / 4);
    await recordRoutingSavings(cortexDir, {
      actualUsd: planned.cost?.usd ?? 0,
      inputTokens: approxInputTokens,
      outputTokens: approxOutputTokens,
      pickedModelDisplayName: planned.pickedModelDisplay ?? planned.pickedModelId,
      source: `skill:${walkSourceId}:step${step.index}`,
    }, savingsBaseline);
    return walkedStep;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    return {
      index: step.index,
      label: planned.label,
      pickedModelId: planned.pickedModelId,
      pickedModelDisplay: planned.pickedModelDisplay,
      prompt,
      output: '',
      elapsedMs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function skeletonStep(step: WalkerStepInput, planned: PlannedStep, error: string): WalkedStep {
  return {
    index: step.index,
    label: planned.label,
    pickedModelId: planned.pickedModelId,
    pickedModelDisplay: planned.pickedModelDisplay,
    prompt: '',
    output: '',
    elapsedMs: 0,
    error,
  };
}

function composePrompt(step: WalkerStepInput, captures: Record<string, string>): string {
  return step.text.replace(/\$(\w+)/g, (match, name: string) => {
    return captures[name] ?? match;
  });
}

/** Node-id shape used across the cortex (hex/uuid-ish tokens, ≥8 chars). Used to
 *  spot node refs a recall-recipe step pulled, so the contradiction guard can
 *  check them. Conservative: a false miss just means no warning, never a block. */
const NODE_REF_RE = /\b[0-9a-f]{8,}(?:-[0-9a-f]{4,}){0,4}\b/gi;

/**
 * Walk-time contradiction guard. When WalkerDeps.openContradictionsFor is wired
 * (recall-aware walker), gather the node refs this step surfaced and annotate any
 * that sit on an open contradiction. No-op when the guard is unwired — the
 * default LLM-prompt walker has no live recall hits at walk time. Pure-core
 * decision lives in surfaceContradictionsForRecall(); this only assembles inputs.
 */
function annotateContradictionWarnings(
  deps: WalkerDeps,
  graphId: string,
  step: WalkerStepInput,
  result: WalkedStep,
): void {
  if (!deps.openContradictionsFor) return;
  // Recall-recipe node refs may appear in the step prompt or its output.
  const refTokens = new Set<string>();
  for (const src of [result.prompt, result.output, step.text]) {
    if (!src) continue;
    for (const m of src.matchAll(NODE_REF_RE)) refTokens.add(m[0]);
  }
  if (refTokens.size === 0) return;
  const open = deps.openContradictionsFor([graphId]);
  if (open.length === 0) return;
  const hits: RecallHitRef[] = [...refTokens].map((nodeId) => ({ graphId, nodeId }));
  const warnings = surfaceContradictionsForRecall(hits, open);
  if (warnings.length > 0) result.contradictionWarnings = warnings;
}

async function dispatchModelCall(provider: string, modelTag: string, prompt: string, deps: WalkerDeps): Promise<string> {
  if (provider === 'ollama') {
    const activeModel = deps.host.getSettings().ai?.llmModel ?? modelTag;
    const client = new OllamaLlm(
      `ollama:${activeModel}`,
      activeModel,
      undefined,
      () => settingsMod.resolveLlmTemperature(deps.host.getSettings()),
    );
    return client.complete({
      system: 'You are Ghampus, a local AI agent working with the user\'s memory. Answer the step concisely and concretely.',
      user: prompt,
    });
  }
  if (provider === 'mlx' || provider === 'vllm') {
    return dispatchLocalOpenAiModelCall(provider, modelTag, prompt, deps.host);
  }
  const pid = provider as ModelProviderId;
  if (pid === 'anthropic' || OPENAI_COMPAT_BASE_URLS[pid]) {
    return dispatchCloudModelCall(pid, modelTag, prompt, deps.host);
  }
  throw new Error(
    `Provider '${provider}' requires a configured API key. Open Settings → Models to connect it, or switch routing strategy to Local-only.`,
  );
}
