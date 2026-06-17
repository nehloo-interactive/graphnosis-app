// Skill walker — drives a SkillWalkPlan to actual execution by dispatching
// each step to its chosen model and capturing the result.
//
// Phase 1 scope:
//   - Ollama provider works for real (HTTP to localhost:11434).
//   - Paid providers (Anthropic, OpenAI, etc.) error with a clear
//     `provider-not-configured` reason — the routing plan still
//     selects them, the walker just can't execute them yet. Lets us
//     prove the architecture end-to-end on a local-only setup.
//   - Each step's output is captured against `captureAs` if the step
//     declares one. Captures flow forward into subsequent step prompts.
//   - Savings tracker records every step (routing-savings event).
//
// Out of scope (future):
//   - Sub-skill recursion via `step.calls`.
//   - Streaming event emission while the walk runs.
//   - Failure handlers + retries.
//   - Multi-model voting for critical steps.

import { OllamaLlm } from './local-llm.js';
import { recordRoutingSavings } from './savings-tracker.js';
import type { GraphnosisHost } from './host.js';
import type { SkillWalkPlan, PlannedStep } from './model-router.js';
import { getKnownModel } from './model-registry.js';

export interface WalkerDeps {
  host: GraphnosisHost;
}

export interface WalkerStepInput {
  index: number;
  text: string;
  /** Optional name to capture this step's output under. Subsequent steps
   *  can reference `$captureAs` in their text and the walker substitutes
   *  the captured value at execution time. */
  captureAs?: string;
}

export interface WalkerInput {
  /** The skill being walked — surfaces in audit + savings attribution. */
  sourceId: string;
  /** Same step list the planner received, with optional capture names. */
  steps: WalkerStepInput[];
  /** The plan the user approved. Picked models per step come from here. */
  plan: SkillWalkPlan;
  /** Initial captures the caller provides — typically the skill's `requires` vars. */
  initialCaptures?: Record<string, string>;
}

export interface WalkedStep {
  index: number;
  label: string;
  pickedModelId: string | null;
  pickedModelDisplay: string | null;
  /** Final composed prompt sent to the model. */
  prompt: string;
  /** Model output for this step. */
  output: string;
  /** Latency end-to-end including HTTP. */
  elapsedMs: number;
  /** What was captured from this step's output (key → value). */
  capturedAs?: { name: string; value: string };
  /** Set when the step couldn't execute — provider not configured, model
   *  not pulled, network error. The walk continues with the next step
   *  unless the step was on the critical path; the UI surfaces the error
   *  in the per-step card. */
  error?: string;
}

export interface WalkResult {
  sourceId: string;
  steps: WalkedStep[];
  /** All capture names that landed during the walk. */
  captures: Record<string, string>;
  /** True when every step executed without error. */
  ok: boolean;
  /** Sum of `elapsedMs` across all steps. */
  totalElapsedMs: number;
}

/**
 * Execute a planned skill walk. Each step runs against its picked
 * model; captures flow forward so step N can reference `$captureName`
 * from step N-1. Failures don't halt the walk — they're recorded in
 * the step's `error` field and the user can re-run individual steps.
 */
export async function walkSkillPlan(deps: WalkerDeps, input: WalkerInput): Promise<WalkResult> {
  const captures: Record<string, string> = { ...(input.initialCaptures ?? {}) };
  const cortexDir = deps.host.getCortexDir();
  const walked: WalkedStep[] = [];
  let totalElapsedMs = 0;

  for (const step of input.steps) {
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
    if (!planned.pickedModelId) {
      walked.push(skeletonStep(step, planned, 'No model satisfies step requirements'));
      continue;
    }
    const model = getKnownModel(planned.pickedModelId);
    if (!model) {
      walked.push(skeletonStep(step, planned, `Unknown model: ${planned.pickedModelId}`));
      continue;
    }
    const prompt = composePrompt(step, captures);
    const startedAt = Date.now();
    try {
      const output = await dispatchModelCall(model.provider, model.modelTag, prompt);
      const elapsedMs = Date.now() - startedAt;
      totalElapsedMs += elapsedMs;
      const capturedAs = step.captureAs
        ? { name: step.captureAs, value: output.trim() }
        : undefined;
      if (capturedAs) captures[capturedAs.name] = capturedAs.value;
      walked.push({
        index: step.index,
        label: planned.label,
        pickedModelId: planned.pickedModelId,
        pickedModelDisplay: planned.pickedModelDisplay,
        prompt,
        output,
        elapsedMs,
        ...(capturedAs ? { capturedAs } : {}),
      });
      // Record routing savings — actual USD comes from the step's cost
      // estimate (free for Ollama, real $ for paid providers). Tokens
      // are approximated from prompt + output length. The baseline is
      // implicit in `recordRoutingSavings` (Claude Sonnet baseline rates).
      const approxInputTokens = Math.ceil(prompt.length / 4);
      const approxOutputTokens = Math.ceil(output.length / 4);
      await recordRoutingSavings(cortexDir, {
        actualUsd: planned.cost?.usd ?? 0,
        inputTokens: approxInputTokens,
        outputTokens: approxOutputTokens,
        pickedModelDisplayName: planned.pickedModelDisplay ?? planned.pickedModelId,
        source: `skill:${input.sourceId}:step${step.index}`,
      });
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      totalElapsedMs += elapsedMs;
      walked.push({
        index: step.index,
        label: planned.label,
        pickedModelId: planned.pickedModelId,
        pickedModelDisplay: planned.pickedModelDisplay,
        prompt,
        output: '',
        elapsedMs,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    sourceId: input.sourceId,
    steps: walked,
    captures,
    ok: walked.every((s) => !s.error),
    totalElapsedMs,
  };
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

/**
 * Substitute `$captureName` references in the step text with the
 * captured values from prior steps. Keeps anything that doesn't match
 * a capture as-is (so literal `$foo` in a step's prose stays intact
 * when no `foo` capture exists yet).
 */
function composePrompt(step: WalkerStepInput, captures: Record<string, string>): string {
  return step.text.replace(/\$(\w+)/g, (match, name: string) => {
    return captures[name] ?? match;
  });
}

/**
 * Dispatch one model call to the right provider adapter. Phase 1 only
 * implements Ollama for real; other providers throw a clear error so
 * the walker records the failure and continues. When the rest of the
 * adapters ship, this switch grows.
 */
async function dispatchModelCall(provider: string, modelTag: string, prompt: string): Promise<string> {
  if (provider === 'ollama') {
    // Reuse the existing OllamaLlm client. Uses default localhost:11434.
    const client = new OllamaLlm(`ollama:${modelTag}`, modelTag);
    return client.complete({
      system: 'You are Ghampus, a local AI agent working with the user\'s memory. Answer the step concisely and concretely.',
      user: prompt,
    });
  }
  if (provider === 'mlx' || provider === 'vllm') {
    throw new Error(`Provider '${provider}' adapter not yet implemented in this build. Routing picked it because it claims the right capabilities; configure Ollama as fallback or wait for the adapter to ship.`);
  }
  // Paid providers — clear error so the walker records the failure and
  // the UI can prompt the user to install Ollama or skip the step.
  throw new Error(`Provider '${provider}' requires a configured API key. Open Settings → Models to connect it, or switch routing strategy to Local-only.`);
}
