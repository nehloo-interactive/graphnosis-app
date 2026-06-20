// Skill walker — drives a SkillWalkPlan to actual execution by dispatching
// each step to its chosen model and capturing the result.
//
// Providers:
//   - Ollama: local HTTP to localhost:11434
//   - Anthropic / OpenAI-compatible: BYOK cloud adapters (Settings → Models)
//   - mlx / vllm: OpenAI-compatible local endpoints (Settings → Models baseUrl)
//   - Sub-skill recursion via `@skill:` calls (depth-capped)
//   - Failure handlers: one recovery sub-skill + one step retry

import { OllamaLlm } from './local-llm.js';
import { dispatchCloudModelCall, dispatchLocalOpenAiModelCall, OPENAI_COMPAT_BASE_URLS } from './cloud-llm.js';
import { recordRoutingSavings, resolveSavingsBaseline } from './savings-tracker.js';
import type { GraphnosisHost } from './host.js';
import type { SkillWalkPlan, PlannedStep } from './model-router.js';
import { planSkillWalk, deriveStepsFromText } from './model-router.js';
import { walkSkillSequence, walkSkillToJson } from './skill-trainer.js';
import { getKnownModel, type ModelProviderId } from './model-registry.js';
import { isProviderDisabled } from './admin-policy.js';

/** Max nested `@skill:` depth — prevents runaway recursion. */
const MAX_SUB_SKILL_DEPTH = 3;

export interface WalkerDeps {
  host: GraphnosisHost;
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
}

export interface WalkResult {
  sourceId: string;
  steps: WalkedStep[];
  captures: Record<string, string>;
  ok: boolean;
  totalElapsedMs: number;
}

function resolveEnabledProviders(host: GraphnosisHost): ModelProviderId[] {
  const providers = Object.entries(host.getSettings().models?.providers ?? { ollama: { enabled: true } })
    .filter(([id, s]) => s?.enabled === true && !isProviderDisabled(id))
    .map(([id]) => id as ModelProviderId);
  return providers.length > 0 ? providers : ['ollama'];
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
  const plan = planSkillWalk(deriveStepsFromText(rawSteps), {
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
 */
export async function walkSkillPlan(deps: WalkerDeps, input: WalkerInput): Promise<WalkResult> {
  const captures: Record<string, string> = { ...(input.initialCaptures ?? {}) };
  const cortexDir = deps.host.getCortexDir();
  const savingsBaseline = resolveSavingsBaseline(deps.host.getSettings());
  const walked: WalkedStep[] = [];
  let totalElapsedMs = 0;
  const depth = input.recursionDepth ?? 0;
  const execByIndex = new Map((input.executionSteps ?? []).map((s) => [s.index, s]));

  for (const step of input.steps) {
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
    walked.push(result);
  }

  return {
    sourceId: input.sourceId,
    steps: walked,
    captures,
    ok: walked.every((s) => !s.error),
    totalElapsedMs,
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

async function dispatchModelCall(provider: string, modelTag: string, prompt: string, deps: WalkerDeps): Promise<string> {
  if (provider === 'ollama') {
    const activeModel = deps.host.getSettings().ai?.llmModel ?? modelTag;
    const client = new OllamaLlm(`ollama:${activeModel}`, activeModel);
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
