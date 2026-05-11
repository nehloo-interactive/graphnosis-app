import type { GraphId, SubgraphBudget } from '../types.js';

// Policy = what gets attached to which prompt. Per-graph rules cap how much
// context an AI can pull, regardless of what it asks for. The federation pass
// enforces this *after* the AI's requested budget — so a maxed-out `recall`
// against a `sensitive` graph still only yields the tier's cap.

export type SensitivityTier = 'public' | 'personal' | 'sensitive';

export interface GraphPolicy {
  graphId: GraphId;
  shareWithAi: boolean;
  /** Default `'personal'` if unset. Tightens the AI-visible budget per graph. */
  tier?: SensitivityTier;
  excludeNodeTypes?: string[];
  excludeTags?: string[];
}

export interface PolicyConfig {
  defaultBudget: SubgraphBudget;
  graphs: GraphPolicy[];
}

export const DEFAULT_BUDGET: SubgraphBudget = {
  maxTokens: 2_000,
  maxNodes: 20,
  perGraphMinTokens: 200,
};

// Per-tier hard caps applied *after* the user-/AI-requested budget.
// A request asking for 5000 tokens against a sensitive graph still gets ≤ 500.
export const TIER_CAPS: Record<SensitivityTier, { maxTokens: number; maxNodes: number }> = {
  public:    { maxTokens: 8_000, maxNodes: 50 },
  personal:  { maxTokens: 2_000, maxNodes: 20 },
  sensitive: { maxTokens:   500, maxNodes:  5 },
};

export function tierOf(cfg: PolicyConfig, graphId: GraphId): SensitivityTier {
  return cfg.graphs.find(g => g.graphId === graphId)?.tier ?? 'personal';
}

export function shouldShare(cfg: PolicyConfig, graphId: GraphId): boolean {
  const g = cfg.graphs.find(x => x.graphId === graphId);
  return g ? g.shareWithAi : true;
}

export function shareableGraphs(cfg: PolicyConfig, graphIds: GraphId[]): GraphId[] {
  return graphIds.filter(g => shouldShare(cfg, g));
}

/** Per-graph budget = min(requested, tier cap). */
export function budgetFor(cfg: PolicyConfig, graphId: GraphId, requested: SubgraphBudget): { maxTokens: number; maxNodes: number } {
  const cap = TIER_CAPS[tierOf(cfg, graphId)];
  return {
    maxTokens: Math.min(requested.maxTokens, cap.maxTokens),
    maxNodes:  Math.min(requested.maxNodes,  cap.maxNodes),
  };
}

// Very rough token estimate. The sidecar can swap in a real tokenizer if needed.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function redactNode(
  node: { type?: string; tags?: string[]; content?: string },
  policy: GraphPolicy | undefined,
): boolean {
  if (!policy) return false;
  if (node.type && policy.excludeNodeTypes?.includes(node.type)) return true;
  if (node.tags && policy.excludeTags && node.tags.some(t => policy.excludeTags!.includes(t))) return true;
  return false;
}
