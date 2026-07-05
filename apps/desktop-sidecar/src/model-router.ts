// Routing planner — given a list of skill steps with their declared
// capability requirements, pick the right model for each step under
// the user's chosen strategy + privacy posture + budget.
//
// The planner is read-only and deterministic: same input → same plan.
// Actual walk execution (the LLM driver that sends each step to the
// chosen model) lives elsewhere; this module produces the plan the user
// approves before the work happens.
//
// Three rules layered in order of precedence:
//   1. Privacy gate (hard).      Sensitive engrams refuse non-local models.
//   2. Strategy (user choice).   Adaptive / local-only / always-best.
//   3. Cheapest-meets-spec.      Tiebreak on cost, then latency.

import type { ModelCapability, KnownModel, CustomRateOverride, CallCostEstimate, ModelProviderId } from './model-registry.js';
import { ALL_CAPABILITIES, KNOWN_MODELS, getKnownProvider, estimateCallCost, isSensitiveEngramSafe } from './model-registry.js';
import { isProviderDisabled } from './admin-policy.js';

/** One step in the plan request — typically derived from a SkillExecutionPlan step. */
export interface PlanStepInput {
  /** 1-based step number for display. */
  index: number;
  /** Short human label for the step. */
  label: string;
  /**
   * Capabilities this step needs the model to provide. The planner only
   * picks models whose `capabilities` are a superset of this list.
   * Empty / absent means `['general']` — any general-purpose model qualifies.
   */
  capabilities?: ModelCapability[];
  /**
   * When true, force local-only routing for this step regardless of the
   * strategy. The planner sets this automatically for steps that touch
   * sensitive engrams; callers can also force it via the skill SOP.
   */
  privacyLocked?: boolean;
  /**
   * Reason the step is privacy-locked. Surfaces in the plan UI so users
   * see WHY (e.g. "touches `finance` engram"); absent for non-locked.
   */
  privacyLockReason?: string;
  /**
   * Rough token sizing for cost estimation. Defaults are reasonable for
   * a typical skill step; pass concrete values when you can compute them
   * from the surrounding context.
   */
  approxInputTokens?: number;
  approxOutputTokens?: number;
}

/** User-controlled routing strategy. Mirrors the settings radio. */
export type RoutingStrategy = 'adaptive' | 'local-only' | 'always-best';

export interface PlanContext {
  strategy: RoutingStrategy;
  /** Provider ids the user has currently enabled (Settings → Models toggles). */
  enabledProviders: ModelProviderId[];
  /**
   * For each subscription-pool provider (Copilot), how much of the
   * included credit pool has been spent this billing cycle (USD) and
   * how much flex has been spent. Drives the "within pool" / "into flex"
   * / "over-quota" labels in the plan output.
   */
  subscriptionPoolUsage?: Partial<Record<ModelProviderId, { poolSpentUsd: number; flexSpentUsd: number }>>;
  /**
   * Custom rate overrides from `settings.models.customRates`. Passed
   * through to `estimateCallCost` per step.
   */
  customRates?: CustomRateOverride[];
}

export interface PlannedStep {
  index: number;
  label: string;
  /** What the step asked for. Echoed back for the UI. */
  capabilities: ModelCapability[];
  /**
   * The model the router picked. `null` means no model satisfies the
   * step's requirements — the plan as a whole is then `feasible: false`
   * and the UI shows an actionable error ("install a model with X capability").
   */
  pickedModelId: string | null;
  pickedModelDisplay: string | null;
  pickedProvider: ModelProviderId | null;
  /** Fallback chain in order — tried if `pickedModelId` errors. */
  fallbacks: string[];
  cost: CallCostEstimate | null;
  /** Set when the step is privacy-locked to local routing. */
  privacyLocked: boolean;
  privacyLockReason?: string;
  /** Human-readable hint when no model meets the constraints. */
  unsatisfiedReason?: string;
}

export interface SkillWalkPlan {
  feasible: boolean;
  steps: PlannedStep[];
  /** Sum of marginal USD across steps (pool-included calls count $0,
   *  pool-flex calls count their USD, per-token calls count their USD). */
  totalUsd: number;
  /** Per-provider subscription-pool drawdown from this walk (USD).
   *  UIs use this to render "this walk would consume $X.XX of your $Y
   *  Copilot credit pool". */
  subscriptionPoolDraw: Partial<Record<ModelProviderId, number>>;
  /**
   * Set when at least one step had no satisfying model. Lists the
   * unsatisfied capabilities so the UI can prompt the user to install /
   * connect a matching model.
   */
  missingCapabilities: ModelCapability[];
  /** Plain-language summary the UI shows on the approve button. */
  summary: string;
}

/**
 * Solve the routing problem for one skill walk.
 *
 * The picking algorithm is deliberately simple:
 *   1. Filter candidates by `enabledProviders` and capability superset.
 *   2. If `privacyLocked` (or sensitive engram), filter to local-only.
 *   3. Strategy filter:
 *        - 'adaptive'      → keep all, sort by USD ASC then latency ASC.
 *        - 'local-only'    → drop non-local, sort by latency ASC.
 *        - 'always-best'   → sort by capability-coverage DESC then USD ASC.
 *   4. Pick the head. Build a fallback chain from the rest (top 2).
 *
 * Smarter approaches (learned-from-history, multi-step optimisation) are
 * intentionally deferred. They'd add complexity without much improvement
 * over the cheapest-that-meets-spec baseline for a single walk.
 */
export function planSkillWalk(steps: PlanStepInput[], ctx: PlanContext): SkillWalkPlan {
  // Track cumulative pool usage AS we plan, so a step late in the walk
  // sees the pool state the earlier steps left behind. This means a
  // walk whose first 4 steps deplete the Copilot pool routes step 5 to
  // flex (or a different provider) automatically.
  const cumulativePool: Partial<Record<ModelProviderId, { poolSpentUsd: number; flexSpentUsd: number }>> = {};
  for (const p of Object.keys(ctx.subscriptionPoolUsage ?? {}) as ModelProviderId[]) {
    const entry = ctx.subscriptionPoolUsage?.[p];
    if (entry) cumulativePool[p] = { ...entry };
  }

  const planned: PlannedStep[] = steps.map((s) => {
    const ctxWithCumulative: PlanContext = { ...ctx, subscriptionPoolUsage: cumulativePool };
    const step = planOneStep(s, ctxWithCumulative);
    // After picking, update the cumulative pool so subsequent steps see
    // the depletion.
    if (step.cost?.kind === 'pool-included' && step.pickedProvider && step.cost.poolState) {
      const entry = cumulativePool[step.pickedProvider] ?? { poolSpentUsd: 0, flexSpentUsd: 0 };
      entry.poolSpentUsd = step.cost.poolState.poolUsedAfterCall;
      cumulativePool[step.pickedProvider] = entry;
    } else if (step.cost?.kind === 'pool-flex' && step.pickedProvider && step.cost.poolState) {
      const entry = cumulativePool[step.pickedProvider] ?? { poolSpentUsd: 0, flexSpentUsd: 0 };
      entry.flexSpentUsd = step.cost.poolState.flexUsedAfterCall;
      cumulativePool[step.pickedProvider] = entry;
    }
    return step;
  });

  const feasible = planned.every((p) => p.pickedModelId !== null);
  const totalUsd = planned.reduce((sum, p) => sum + (p.cost?.usd ?? 0), 0);

  // Per-provider subscription pool draw — for each provider we picked
  // a `pool-included` step from, how much pool USD does this walk
  // consume relative to the cycle's starting state.
  const subscriptionPoolDraw: Partial<Record<ModelProviderId, number>> = {};
  for (const p of Object.keys(cumulativePool) as ModelProviderId[]) {
    const startPool = ctx.subscriptionPoolUsage?.[p]?.poolSpentUsd ?? 0;
    const endPool = cumulativePool[p]?.poolSpentUsd ?? 0;
    const draw = endPool - startPool;
    if (draw > 0) subscriptionPoolDraw[p] = draw;
  }

  const missingCapabilities: ModelCapability[] = [];
  for (const p of planned) {
    if (p.pickedModelId === null) {
      for (const c of p.capabilities) {
        if (!missingCapabilities.includes(c)) missingCapabilities.push(c);
      }
    }
  }

  const localCount = planned.filter((p) => p.cost?.kind === 'free').length;
  const poolCount = planned.filter((p) => p.cost?.kind === 'pool-included').length;
  const paidCount = planned.length - localCount - poolCount;
  const summary = !feasible
    ? `Plan blocked — ${missingCapabilities.join(', ')} capability not available in any enabled model.`
    : totalUsd === 0 && poolCount === 0
      ? `${planned.length} step${planned.length === 1 ? '' : 's'} · all on free local models`
      : `${planned.length} steps · ${localCount} local · ${poolCount} from subscription pool · ${paidCount} paid · ≈ $${totalUsd.toFixed(4)}`;

  return {
    feasible,
    steps: planned,
    totalUsd,
    subscriptionPoolDraw,
    missingCapabilities,
    summary,
  };
}

function planOneStep(step: PlanStepInput, ctx: PlanContext): PlannedStep {
  const capabilities = step.capabilities && step.capabilities.length > 0 ? step.capabilities : ['general' as ModelCapability];
  const privacyLocked = step.privacyLocked === true;
  const base: PlannedStep = {
    index: step.index,
    label: step.label,
    capabilities,
    pickedModelId: null,
    pickedModelDisplay: null,
    pickedProvider: null,
    fallbacks: [],
    cost: null,
    privacyLocked,
    ...(step.privacyLockReason !== undefined ? { privacyLockReason: step.privacyLockReason } : {}),
  };

  let candidates = KNOWN_MODELS.filter((m) => ctx.enabledProviders.includes(m.provider))
    .filter((m) => !isProviderDisabled(m.provider))
    .filter((m) => capabilities.every((c) => m.capabilities.includes(c)));

  if (privacyLocked) {
    candidates = candidates.filter((m) => isSensitiveEngramSafe(m));
  }

  if (ctx.strategy === 'local-only') {
    candidates = candidates.filter((m) => isSensitiveEngramSafe(m));
  }

  if (candidates.length === 0) {
    return {
      ...base,
      unsatisfiedReason: privacyLocked
        ? `No local model with ${capabilities.join(', ')} — sensitive engram blocks remote routing.`
        : ctx.strategy === 'local-only'
          ? `No local model with ${capabilities.join(', ')} — install a stronger local model or switch to Adaptive routing.`
          : `No enabled model declares ${capabilities.join(', ')} — connect a provider with this capability.`,
    };
  }

  const ranked = rankCandidates(candidates, ctx);
  const picked = ranked[0];
  if (!picked) {
    return { ...base, unsatisfiedReason: 'No candidate after ranking' };
  }
  const inTok = step.approxInputTokens ?? 1500;
  const outTok = step.approxOutputTokens ?? 400;
  const poolState = ctx.subscriptionPoolUsage?.[picked.provider];
  const cost = estimateCallCost(picked, inTok, outTok, {
    ...(ctx.customRates ? { overrides: ctx.customRates } : {}),
    ...(poolState ? { poolSpentUsdThisCycle: poolState.poolSpentUsd, flexSpentUsdThisCycle: poolState.flexSpentUsd } : {}),
  });

  return {
    ...base,
    pickedModelId: picked.id,
    pickedModelDisplay: picked.displayName,
    pickedProvider: picked.provider,
    fallbacks: ranked.slice(1, 3).map((m) => m.id),
    cost,
  };
}

function rankCandidates(candidates: KnownModel[], ctx: PlanContext): KnownModel[] {
  if (ctx.strategy === 'always-best') {
    // Pick the one with the most capability coverage; tiebreak on cheaper.
    return [...candidates].sort((a, b) => {
      const capDiff = b.capabilities.length - a.capabilities.length;
      if (capDiff !== 0) return capDiff;
      return modelCostRank(a, ctx) - modelCostRank(b, ctx);
    });
  }
  if (ctx.strategy === 'local-only') {
    // All non-local already filtered out; sort by latency ASC.
    return [...candidates].sort((a, b) => a.typicalLatencyMs - b.typicalLatencyMs);
  }
  // adaptive
  return [...candidates].sort((a, b) => {
    const costDiff = modelCostRank(a, ctx) - modelCostRank(b, ctx);
    if (costDiff !== 0) return costDiff;
    return a.typicalLatencyMs - b.typicalLatencyMs;
  });
}

/**
 * Cheap-first ordering hint. Free local rank 0. Subscription-pool models
 * inside their included pool also rank 0 — the user already paid for
 * that usage. Once the pool's gone, rank by underlying input rate (the
 * marginal cost of the next call).
 */
function modelCostRank(model: KnownModel, ctx: PlanContext): number {
  const pricing = ctx.customRates
    ? (ctx.customRates.find((o) => o.modelId === model.id) ??
       ctx.customRates.find((o) => !o.modelId && o.providerId === model.provider))?.pricing ?? model.pricing
    : model.pricing;

  if (pricing.kind === 'free') return 0;
  if (pricing.kind === 'subscription-pool') {
    const poolSpent = ctx.subscriptionPoolUsage?.[model.provider]?.poolSpentUsd ?? 0;
    if (poolSpent < pricing.creditPoolUsd) return 0;
    return pricing.underlyingRates.inputUsdPer1M;
  }
  return pricing.inputUsdPer1M;
}

/**
 * Helper for derived plan inputs from a `SkillExecutionPlan`. Each step's
 * `capabilities` are pulled from optional inline annotations in the step
 * text (`@needs: reasoning, structured-output`), falling back to
 * `['general']`. Privacy locks are passed in by the caller because they
 * depend on engram tier — the planner doesn't know which engrams a step
 * recalls from.
 */
export function deriveStepsFromText(
  rawSteps: Array<{ index: number; text: string }>,
  engramTierByStep?: Record<number, 'public' | 'personal' | 'sensitive'>,
): PlanStepInput[] {
  const NEEDS_PATTERN = /@needs?:\s*([a-z, -]+)/i;
  return rawSteps.map((s) => {
    const match = s.text.match(NEEDS_PATTERN);
    const declared = match?.[1]?.split(',').map((c) => c.trim()).filter(Boolean) ?? [];
    const valid: ModelCapability[] = (declared as ModelCapability[]).filter((c) => isKnownCapability(c));
    // First line of the step (sans annotation) makes the label.
    const label = s.text.replace(NEEDS_PATTERN, '').split('\n')[0]?.trim().slice(0, 80) ?? `Step ${s.index}`;
    const tier = engramTierByStep?.[s.index];
    const privacyLocked = tier === 'sensitive';
    return {
      index: s.index,
      label,
      capabilities: valid.length > 0 ? valid : inferCapabilities(s.text),
      ...(privacyLocked ? { privacyLocked: true, privacyLockReason: `step touches sensitive engram` } : {}),
    };
  });
}

// Validate declared @needs tags against the registry's single source of truth
// (`ALL_CAPABILITIES`) so this list can never drift from the `ModelCapability`
// union — an unknown tag is dropped and the step falls back to inference.
function isKnownCapability(c: string): c is ModelCapability {
  return (ALL_CAPABILITIES as readonly string[]).includes(c);
}

// ── Auto-@needs inference ────────────────────────────────────────────────
// Most trained skills carry no explicit @needs, so every step would default to
// ['general'] and route to the cheapest model (a 1B) — fine for trivial steps,
// but a quality risk for reasoning/code/writing steps. We infer a single best-fit
// capability from the step text so the router can right-size. Heavy capabilities
// are ordered first: under-routing a reasoning/code/writing step to a 1B is the
// costly mistake, while over-routing a trivial step to a 7B is free locally.
// An explicit @needs tag always overrides this.
const CAPABILITY_HINTS: Array<[RegExp, ModelCapability]> = [
  [/\b(implement|refactor|patch|debug|compile|lint|stack ?trace|exception|regex|code|coding|function|script|diff)\b/i, 'code'],
  [/\b(analy[sz]e|assess|evaluate|reason|diagnos|root.?cause|trade.?off|compare|strateg|prioriti[sz]e|decide|decision|weigh|\bplan\b)\b/i, 'reasoning'],
  [/\b(draft|write|compose|rephrase|reword|rewrite|announce|announcement|email|blog|post|narrat|prose|caption|copy)\b/i, 'writing'],
  [/\b(json|schema|structured|extract fields|key-?value|emit (?:a )?(?:json|object|list)|table of)\b/i, 'structured-output'],
  [/\b(extract|pull (?:out|the)|retriev(?:e|al|ing)|parse (?:out|the)|grab the|get the (?:value|field|number|date|email|amount|name|id)|find the (?:value|field|number|date|email|amount))\b/i, 'extraction'],
  [/\b(summari[sz]|digest|tl;?dr|recap|condense|abstract)\b/i, 'summarization'],
  [/\b(\blist\b|\bcheck\b|verify|confirm|look ?up|fetch|status|\bcount\b|classify|\broute\b|\bmatch\b|quick|simple)\b/i, 'fast'],
];

/** Infer one best-fit capability for a step that declares no explicit @needs.
 *  Returns ['general'] when no hint matches. Exported for testing. */
export function inferCapabilities(text: string): ModelCapability[] {
  for (const [re, cap] of CAPABILITY_HINTS) {
    if (re.test(text)) return [cap];
  }
  return ['general'];
}
