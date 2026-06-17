// Model registry — the catalog of LLM providers + models Ghampus can route
// to, plus their declared capabilities and cost data.
//
// Skills declare the capabilities each step needs (e.g.
// `['reasoning', 'cited']`); the router picks the cheapest available
// model that meets the requirements. Three privacy-and-cost dials live
// here together because they share a vocabulary:
//   - capability claims (what a model can do)
//   - cost (per-token pricing)
//   - locality (does the model send data off the machine?)
//
// The catalog is intentionally data-only — no runtime adapters. Adapters
// live in `model-router.ts`; this module is pure declarations that the
// settings UI, the planner, and the audit layer all read from.

/**
 * Capability tags a skill step can require, and a model can claim.
 * Defined as a closed union so the planner can constraint-solve over
 * them without runtime string surprises. Adding a capability is a
 * breaking change for older skills and older model catalogs — be
 * conservative.
 */
export type ModelCapability =
  | 'general'           // catch-all; any model meets this
  | 'fast'              // sub-1s typical for short prompts
  | 'low-context'       // ≤8k tokens — fits on resource-constrained local
  | 'high-context'      // ≥32k tokens
  | 'reasoning'         // chain-of-thought, multi-step deduction
  | 'summarization'     // condense longer inputs into shorter outputs
  | 'writing'           // generate fluent narrative prose
  | 'tone-match'        // adapt voice / register to examples
  | 'structured-output' // reliably produce JSON / typed schemas
  | 'cited'             // attach citations to claims
  | 'code'              // generate / refactor source code
  | 'vision';           // accept images alongside text

/** The companies / runtimes Ghampus can route to. */
export type ModelProviderId =
  | 'ollama'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'bedrock'
  | 'azure-openai'
  | 'github-copilot'
  | 'groq'
  | 'fireworks'
  | 'together'
  | 'mlx'
  | 'vllm';

/**
 * Pricing shape for a model. Three flavours so the cost estimator can
 * speak the right language for each provider:
 *   - `per-token`           — the default; classic input/output rates.
 *   - `subscription-pool`   — GitHub Copilot's post-2026-06 model: flat
 *                             monthly fee bundles a dollar-denominated
 *                             credit pool which per-token calls deplete.
 *                             Optional flex overage above the pool.
 *   - `free`                — local-runtime models. Cost always 0.
 */
export type ModelPricing =
  | {
      kind: 'per-token';
      inputUsdPer1M: number;
      outputUsdPer1M: number;
    }
  | {
      kind: 'subscription-pool';
      /** Monthly subscription fee in USD. */
      monthlyUsd: number;
      /** Dollar-denominated credit pool included each month. Calls
       *  consume this pool first; while inside it the marginal USD cost
       *  is $0 (already paid by the subscription). */
      creditPoolUsd: number;
      /** Optional add-on "flex" pool — overage above the included pool,
       *  charged separately at a fixed monthly cap. When unset, calls
       *  past the pool are rejected (or sent through real per-token
       *  billing at the underlying rates, depending on provider). */
      flexAllotmentUsd?: number;
      /** Per-1M-token rates calls are metered at, matching the provider's
       *  published model rates. Each call's true cost is computed from
       *  these and compared to pool state. */
      underlyingRates: {
        inputUsdPer1M: number;
        outputUsdPer1M: number;
      };
    }
  | { kind: 'free' };

/**
 * Static metadata for one provider. Cost + capability data for individual
 * models is on `KnownModel` below. Providers themselves carry the
 * privacy posture and the BYOK / credential flow.
 */
export interface ModelProviderInfo {
  id: ModelProviderId;
  displayName: string;
  /** Short marketing string for the settings card. */
  tagline: string;
  /** True when calls leave the user's machine. Sensitive engrams refuse
   *  to route to providers where `local: false` regardless of plan. */
  local: boolean;
  /** True for providers the catalog ships natively (no key required). */
  builtIn: boolean;
  /** Provider's docs / signup URL — used by the "Manage key" link. */
  homepage: string;
}

/**
 * One model the catalog knows about. The same provider can host many
 * models with very different cost + capability profiles, so models live
 * in their own table and reference providers by id.
 */
export interface KnownModel {
  /** Composite id, `<provider>:<model-tag>`, stable across catalog versions. */
  id: string;
  provider: ModelProviderId;
  /** Tag in the provider's vocabulary — `llama3.2:3b`, `claude-haiku-4`, etc. */
  modelTag: string;
  /** Display name in the settings card and cost preview. */
  displayName: string;
  /** What this model can do — the planner constraint-solves over these. */
  capabilities: ModelCapability[];
  /**
   * Pricing — see `ModelPricing` for shape. Local-runtime models report
   * `{ kind: 'free' }`. Subscription models (Copilot) use
   * `{ kind: 'subscription', ... }` so the cost preview can speak in
   * "calls remaining" instead of fake dollar amounts.
   */
  pricing: ModelPricing;
  /** Typical latency for a 200-token output. Used for routing tiebreakers. */
  typicalLatencyMs: number;
  /** Max context window in tokens — drives the `low-context` / `high-context` flag. */
  contextWindow: number;
}

// ── Provider catalog ───────────────────────────────────────────────────

export const KNOWN_PROVIDERS: ModelProviderInfo[] = [
  {
    id: 'ollama',
    displayName: 'Ollama (local)',
    tagline: 'Runs on your machine · free · sensitive-engram safe',
    local: true,
    builtIn: true,
    homepage: 'https://ollama.com',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic Claude',
    tagline: 'BYOK · paid · personal & public engrams only',
    local: false,
    builtIn: true,
    homepage: 'https://console.anthropic.com',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    tagline: 'BYOK · paid · personal & public engrams only',
    local: false,
    builtIn: true,
    homepage: 'https://platform.openai.com',
  },
  {
    id: 'google',
    displayName: 'Google Gemini',
    tagline: 'BYOK · paid · personal & public engrams only',
    local: false,
    builtIn: true,
    homepage: 'https://aistudio.google.com',
  },
  {
    id: 'bedrock',
    displayName: 'AWS Bedrock',
    tagline: 'Compliance-friendly — your VPC, your keys',
    local: false,
    builtIn: true,
    homepage: 'https://aws.amazon.com/bedrock',
  },
  {
    id: 'azure-openai',
    displayName: 'Azure OpenAI',
    tagline: 'Microsoft-hosted OpenAI for enterprise',
    local: false,
    builtIn: true,
    homepage: 'https://azure.microsoft.com/products/ai-services/openai-service',
  },
  {
    id: 'github-copilot',
    displayName: 'GitHub Copilot',
    tagline: 'Subscription · base requests unlimited · premium agent requests metered',
    local: false,
    builtIn: true,
    homepage: 'https://github.com/features/copilot',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    tagline: 'Very low latency · paid',
    local: false,
    builtIn: true,
    homepage: 'https://console.groq.com',
  },
  {
    id: 'fireworks',
    displayName: 'Fireworks AI',
    tagline: 'Open-weight hosting · paid',
    local: false,
    builtIn: true,
    homepage: 'https://fireworks.ai',
  },
  {
    id: 'together',
    displayName: 'Together AI',
    tagline: 'Open-weight hosting · paid',
    local: false,
    builtIn: true,
    homepage: 'https://together.ai',
  },
  {
    id: 'mlx',
    displayName: 'MLX (local)',
    tagline: 'Apple Silicon-native local runtime',
    local: true,
    builtIn: true,
    homepage: 'https://ml-explore.github.io/mlx/',
  },
  {
    id: 'vllm',
    displayName: 'vLLM (local)',
    tagline: 'High-throughput local runtime',
    local: true,
    builtIn: true,
    homepage: 'https://docs.vllm.ai',
  },
];

// ── Model catalog ──────────────────────────────────────────────────────
//
// Costs reflect public retail pricing as of catalog version 2026-06; the
// settings UI surfaces the version so users can tell if numbers are
// stale. When the provider updates pricing, bump KNOWN_MODELS_VERSION
// and refresh the entries below.

export const KNOWN_MODELS_VERSION = '2026-06-15';

export const KNOWN_MODELS: KnownModel[] = [
  // ── Local: Ollama ──
  {
    id: 'ollama:llama3.2:3b',
    provider: 'ollama',
    modelTag: 'llama3.2:3b-instruct-q4_K_M',
    displayName: 'Llama 3.2 3B',
    capabilities: ['general', 'fast', 'low-context', 'summarization'],
    pricing: { kind: 'free' },
    typicalLatencyMs: 800,
    contextWindow: 8192,
  },
  {
    id: 'ollama:llama3.2:1b',
    provider: 'ollama',
    modelTag: 'llama3.2:1b-instruct-q4_K_M',
    displayName: 'Llama 3.2 1B',
    capabilities: ['general', 'fast', 'low-context'],
    pricing: { kind: 'free' },
    typicalLatencyMs: 400,
    contextWindow: 8192,
  },
  {
    id: 'ollama:qwen2.5:7b',
    provider: 'ollama',
    modelTag: 'qwen2.5:7b-instruct-q4_K_M',
    displayName: 'Qwen 2.5 7B',
    capabilities: ['general', 'reasoning', 'code', 'summarization', 'structured-output'],
    pricing: { kind: 'free' },
    typicalLatencyMs: 2100,
    contextWindow: 32768,
  },
  {
    id: 'ollama:llama3.2-vision:11b',
    provider: 'ollama',
    modelTag: 'llama3.2-vision:11b',
    displayName: 'Llama 3.2 Vision 11B',
    capabilities: ['general', 'vision', 'summarization'],
    pricing: { kind: 'free' },
    typicalLatencyMs: 4000,
    contextWindow: 8192,
  },

  // ── Anthropic ──
  {
    id: 'anthropic:claude-haiku-4',
    provider: 'anthropic',
    modelTag: 'claude-haiku-4-5-20251001',
    displayName: 'Claude Haiku 4.5',
    capabilities: ['general', 'fast', 'high-context', 'reasoning', 'summarization', 'writing', 'tone-match', 'structured-output', 'cited', 'code'],
    pricing: { kind: 'per-token', inputUsdPer1M: 0.80, outputUsdPer1M: 4.00 },
    typicalLatencyMs: 1200,
    contextWindow: 200_000,
  },
  {
    id: 'anthropic:claude-sonnet-4-6',
    provider: 'anthropic',
    modelTag: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    capabilities: ['general', 'high-context', 'reasoning', 'summarization', 'writing', 'tone-match', 'structured-output', 'cited', 'code', 'vision'],
    pricing: { kind: 'per-token', inputUsdPer1M: 3.00, outputUsdPer1M: 15.00 },
    typicalLatencyMs: 2800,
    contextWindow: 200_000,
  },
  {
    id: 'anthropic:claude-opus-4-8',
    provider: 'anthropic',
    modelTag: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    capabilities: ['general', 'high-context', 'reasoning', 'summarization', 'writing', 'tone-match', 'structured-output', 'cited', 'code', 'vision'],
    pricing: { kind: 'per-token', inputUsdPer1M: 15.00, outputUsdPer1M: 75.00 },
    typicalLatencyMs: 3500,
    contextWindow: 200_000,
  },

  // ── OpenAI ──
  {
    id: 'openai:gpt-4o-mini',
    provider: 'openai',
    modelTag: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    capabilities: ['general', 'fast', 'high-context', 'reasoning', 'summarization', 'writing', 'structured-output', 'code', 'vision'],
    pricing: { kind: 'per-token', inputUsdPer1M: 0.15, outputUsdPer1M: 0.60 },
    typicalLatencyMs: 900,
    contextWindow: 128_000,
  },
  {
    id: 'openai:gpt-4o',
    provider: 'openai',
    modelTag: 'gpt-4o',
    displayName: 'GPT-4o',
    capabilities: ['general', 'high-context', 'reasoning', 'summarization', 'writing', 'tone-match', 'structured-output', 'cited', 'code', 'vision'],
    pricing: { kind: 'per-token', inputUsdPer1M: 2.50, outputUsdPer1M: 10.00 },
    typicalLatencyMs: 2200,
    contextWindow: 128_000,
  },

  // ── GitHub Copilot ──
  //
  // Copilot switched to AI Credits billing on 2026-06-01. Each plan
  // bundles a dollar-denominated credit pool that per-token calls deplete;
  // optional "flex" overage available above the pool. Underlying token
  // rates match what direct API users see — Copilot's value vs going
  // direct is the subscription discount on the first $N of usage plus
  // unified billing across providers. Sign-ups for the Pro plan are
  // currently paused per GitHub's plan page.
  //
  // The catalog tracks plan tiers as separate "models" because their
  // credit pools differ; the routing layer treats them as one underlying
  // capability surface. We assume Copilot routes to Haiku-class rates on
  // the included models. When real per-model rates ship, the underlying
  // rates field becomes per-tier.
  {
    id: 'github-copilot:free',
    provider: 'github-copilot',
    modelTag: 'copilot-free',
    displayName: 'Copilot Free',
    capabilities: ['general', 'fast', 'high-context', 'reasoning', 'code'],
    pricing: {
      kind: 'subscription-pool',
      monthlyUsd: 0,
      creditPoolUsd: 0, // free tier is request-counted (2000 completions + 50 chat) — modeled as $0 pool with overage rejection
      underlyingRates: { inputUsdPer1M: 0.80, outputUsdPer1M: 4.00 },
    },
    typicalLatencyMs: 1500,
    contextWindow: 128_000,
  },
  {
    id: 'github-copilot:pro',
    provider: 'github-copilot',
    modelTag: 'copilot-pro',
    displayName: 'Copilot Pro',
    capabilities: ['general', 'fast', 'high-context', 'reasoning', 'code', 'writing'],
    pricing: {
      kind: 'subscription-pool',
      monthlyUsd: 10,
      creditPoolUsd: 15,
      flexAllotmentUsd: 5,
      underlyingRates: { inputUsdPer1M: 0.80, outputUsdPer1M: 4.00 },
    },
    typicalLatencyMs: 1500,
    contextWindow: 128_000,
  },
  {
    id: 'github-copilot:pro-plus',
    provider: 'github-copilot',
    modelTag: 'copilot-pro-plus',
    displayName: 'Copilot Pro+',
    capabilities: ['general', 'fast', 'high-context', 'reasoning', 'code', 'writing', 'structured-output'],
    pricing: {
      kind: 'subscription-pool',
      monthlyUsd: 39,
      creditPoolUsd: 70,
      flexAllotmentUsd: 31,
      // Pro+ unlocks Opus — assume higher avg rates than haiku-class.
      underlyingRates: { inputUsdPer1M: 3.00, outputUsdPer1M: 15.00 },
    },
    typicalLatencyMs: 2000,
    contextWindow: 200_000,
  },
  {
    id: 'github-copilot:max',
    provider: 'github-copilot',
    modelTag: 'copilot-max',
    displayName: 'Copilot Max',
    capabilities: ['general', 'fast', 'high-context', 'reasoning', 'code', 'writing', 'structured-output', 'cited', 'vision'],
    pricing: {
      kind: 'subscription-pool',
      monthlyUsd: 100,
      creditPoolUsd: 200,
      flexAllotmentUsd: 100,
      underlyingRates: { inputUsdPer1M: 3.00, outputUsdPer1M: 15.00 },
    },
    typicalLatencyMs: 1800,
    contextWindow: 200_000,
  },
  {
    id: 'github-copilot:business',
    provider: 'github-copilot',
    modelTag: 'copilot-business',
    displayName: 'Copilot Business',
    capabilities: ['general', 'fast', 'high-context', 'reasoning', 'code', 'writing', 'structured-output'],
    pricing: {
      kind: 'subscription-pool',
      monthlyUsd: 19,
      // 2× promo bumps the included pool through Aug 2026; the catalog
      // ships the post-promo number; the settings UI can show the 2×
      // overlay separately so users see what they actually have today.
      creditPoolUsd: 19,
      underlyingRates: { inputUsdPer1M: 0.80, outputUsdPer1M: 4.00 },
    },
    typicalLatencyMs: 1500,
    contextWindow: 128_000,
  },
  {
    id: 'github-copilot:enterprise',
    provider: 'github-copilot',
    modelTag: 'copilot-enterprise',
    displayName: 'Copilot Enterprise',
    capabilities: ['general', 'fast', 'high-context', 'reasoning', 'code', 'writing', 'structured-output', 'cited'],
    pricing: {
      kind: 'subscription-pool',
      monthlyUsd: 39,
      creditPoolUsd: 39, // 2× promo overlay handled in settings UI
      underlyingRates: { inputUsdPer1M: 3.00, outputUsdPer1M: 15.00 },
    },
    typicalLatencyMs: 1500,
    contextWindow: 200_000,
  },

  // ── Google ──
  {
    id: 'google:gemini-2.0-flash',
    provider: 'google',
    modelTag: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    capabilities: ['general', 'fast', 'high-context', 'reasoning', 'summarization', 'structured-output', 'code', 'vision'],
    pricing: { kind: 'per-token', inputUsdPer1M: 0.10, outputUsdPer1M: 0.40 },
    typicalLatencyMs: 750,
    contextWindow: 1_000_000,
  },
];

/**
 * Lookup helper — by full composite id. Returns undefined for unknown
 * models so callers can fall back gracefully (a skill saved when GPT-5
 * existed and run on a machine that doesn't know about it shouldn't
 * crash; it should re-route).
 */
export function getKnownModel(id: string): KnownModel | undefined {
  return KNOWN_MODELS.find((m) => m.id === id);
}

export function getKnownProvider(id: ModelProviderId): ModelProviderInfo | undefined {
  return KNOWN_PROVIDERS.find((p) => p.id === id);
}

/**
 * True when a model is safe to route a sensitive-engram step to.
 * The rule is hard: only local-provider models qualify. Future
 * compliance modes (e.g. Bedrock-in-our-VPC) can extend this with an
 * `enterpriseTrustedRemote` flag on ProviderInfo + matching enterprise
 * settings, but the default is conservative.
 */
export function isSensitiveEngramSafe(model: KnownModel): boolean {
  const provider = getKnownProvider(model.provider);
  return provider?.local === true;
}

// ── Custom rate overrides ──────────────────────────────────────────────
//
// Enterprises with negotiated pricing — flat-rate volume discounts,
// AI credit pools, free-tier Bedrock allocations — need to override the
// catalog's retail pricing. Two scopes:
//   - Per-model: pin a specific model's pricing.
//   - Per-provider: rewrite every model from that provider.
// Model-scope overrides take precedence over provider-scope.
//
// An override is data — it lives in `AppSettings.models.customRates` and
// is read on every cost estimate, so changing it takes effect immediately
// without a sidecar restart.

export interface CustomRateOverride {
  /**
   * Either `modelId` or `providerId` must be set. Setting both is
   * accepted; the modelId narrows the scope (only that one model).
   */
  modelId?: string;
  providerId?: ModelProviderId;
  pricing: ModelPricing;
  /**
   * Why this override exists — surfaced in the settings UI so other
   * users (or the same user 6 months later) understand the deal.
   * Example: "negotiated 30% off via 2026 enterprise contract".
   */
  note?: string;
  /**
   * When true, the override was set by an IT admin policy and cannot be
   * edited or removed by individual users. Set by the enterprise
   * policy fetcher; surfaced in the settings UI with a lock icon.
   */
  adminEnforced?: boolean;
}

/**
 * Resolve the effective pricing for a model — applying any overrides
 * the user or their org has configured. Model-scope override wins;
 * provider-scope override applies when no model-scope match exists.
 * No overrides → catalog default.
 */
export function resolveEffectivePricing(
  model: KnownModel,
  overrides: CustomRateOverride[] | undefined,
): ModelPricing {
  if (!overrides || overrides.length === 0) return model.pricing;
  const modelOverride = overrides.find((o) => o.modelId === model.id);
  if (modelOverride) return modelOverride.pricing;
  const providerOverride = overrides.find((o) => !o.modelId && o.providerId === model.provider);
  if (providerOverride) return providerOverride.pricing;
  return model.pricing;
}

/**
 * Cost estimate result. The numeric `usd` field is always present for
 * budget burndown math; `display` is what UIs should show — shaped
 * differently per pricing kind so subscription-pool providers (Copilot)
 * speak in pool draw-down rather than fake dollars while inside the
 * included credits.
 */
export interface CallCostEstimate {
  /** USD-equivalent marginal cost. 0 when the call is paid out of an
   *  included subscription pool (the pool itself is amortised by the
   *  budget tracker, not charged per call). */
  usd: number;
  /** Human-readable label the UI should render. */
  display: string;
  /** Distinguishes UI rendering — chip color, currency vs quota style. */
  kind: 'free' | 'per-token' | 'pool-included' | 'pool-flex' | 'pool-overage';
  /** Pool state — set on subscription-pool providers so the UI can render a progress bar. */
  poolState?: {
    poolUsedAfterCall: number;
    poolTotal: number;
    flexUsedAfterCall: number;
    flexTotal: number;
  };
}

/**
 * Estimate one model call. Subscription-pool providers (Copilot)
 * report 0 marginal USD while the call fits in the included credit
 * pool; once the pool is exhausted, the flex pool takes over (charged
 * separately); once flex is gone, calls are rejected (or, if the
 * provider allows it, billed at full rate as `pool-overage`).
 */
export function estimateCallCost(
  model: KnownModel,
  approxInputTokens: number,
  approxOutputTokens: number,
  options: {
    /** Overrides — typically from `settings.models.customRates`. */
    overrides?: CustomRateOverride[];
    /** For subscription-pool providers, how much of the included pool
     *  has been spent this billing cycle (USD). Drives pool-vs-flex
     *  state transitions. */
    poolSpentUsdThisCycle?: number;
    /** For subscription-pool providers, how much of the flex allotment
     *  has been spent this billing cycle (USD). */
    flexSpentUsdThisCycle?: number;
  } = {},
): CallCostEstimate {
  const pricing = resolveEffectivePricing(model, options.overrides);

  if (pricing.kind === 'free') {
    return { usd: 0, display: 'free', kind: 'free' };
  }

  if (pricing.kind === 'per-token') {
    const inCost = (approxInputTokens / 1_000_000) * pricing.inputUsdPer1M;
    const outCost = (approxOutputTokens / 1_000_000) * pricing.outputUsdPer1M;
    const usd = inCost + outCost;
    return { usd, display: `$${usd.toFixed(4)}`, kind: 'per-token' };
  }

  // subscription-pool
  const rateIn = pricing.underlyingRates.inputUsdPer1M;
  const rateOut = pricing.underlyingRates.outputUsdPer1M;
  const callUsd = (approxInputTokens / 1_000_000) * rateIn + (approxOutputTokens / 1_000_000) * rateOut;

  const poolSpent = options.poolSpentUsdThisCycle ?? 0;
  const poolTotal = pricing.creditPoolUsd;
  const flexSpent = options.flexSpentUsdThisCycle ?? 0;
  const flexTotal = pricing.flexAllotmentUsd ?? 0;

  if (poolSpent + callUsd <= poolTotal) {
    return {
      usd: 0, // amortised into the monthly subscription fee
      display: `$${callUsd.toFixed(4)} of pool · ${(((poolSpent + callUsd) / poolTotal) * 100).toFixed(0)}% used`,
      kind: 'pool-included',
      poolState: { poolUsedAfterCall: poolSpent + callUsd, poolTotal, flexUsedAfterCall: flexSpent, flexTotal },
    };
  }

  if (flexTotal > 0 && flexSpent + callUsd <= flexTotal) {
    return {
      usd: callUsd, // flex overage is paid usage above the included pool
      display: `$${callUsd.toFixed(4)} from flex · ${(((flexSpent + callUsd) / flexTotal) * 100).toFixed(0)}% of $${flexTotal} flex`,
      kind: 'pool-flex',
      poolState: { poolUsedAfterCall: poolTotal, poolTotal, flexUsedAfterCall: flexSpent + callUsd, flexTotal },
    };
  }

  return {
    usd: callUsd,
    display: `over-quota · $${callUsd.toFixed(4)} (pool + flex exhausted)`,
    kind: 'pool-overage',
    poolState: { poolUsedAfterCall: poolTotal, poolTotal, flexUsedAfterCall: flexTotal, flexTotal },
  };
}

/**
 * Legacy convenience — same signature as the original implementation.
 * Kept for callers that just want the USD number and don't care about
 * the human label or quota state. New code should use `estimateCallCost`.
 */
export function estimateCallCostUsd(
  model: KnownModel,
  approxInputTokens: number,
  approxOutputTokens: number,
): number {
  return estimateCallCost(model, approxInputTokens, approxOutputTokens).usd;
}
