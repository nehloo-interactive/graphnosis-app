import type { GraphId, SubgraphBudget } from '../types.js';
import {
  DEFAULT_BUDGET,
  TIER_CAPS,
  budgetFor,
  estimateTokens,
  redactNode,
  shareableGraphs,
  tierOf,
  type PolicyConfig,
  type SensitivityTier,
} from '../policy/index.js';

// Federation = run query against every graph the user owns, merge results into one budgeted context.
// The sidecar binds `runQuery` to Graphnosis' `query()` per graph.
//
// Budget enforcement happens in two layers:
//   1. Per-graph tier cap (sensitive < personal < public) — applied BEFORE selection.
//   2. Global request budget — applied DURING selection across all graphs.
// A request asking for 5000 tokens / 50 nodes against a `sensitive` graph
// still gets ≤ 500 tokens / 5 nodes from that graph.

export interface CandidateNode {
  graphId: GraphId;
  nodeId: string;
  score: number;
  text: string;
  type?: string;
  tags?: string[];
}

export interface FederatedQueryRunner {
  runQuery(graphId: GraphId, query: string, k: number): Promise<CandidateNode[]>;
}

export interface AttachedGraphAudit {
  graphId: GraphId;
  tier: SensitivityTier;
  nodesIncluded: number;
  tokensIncluded: number;
}

export interface FederatedSubgraph {
  byGraph: Map<GraphId, CandidateNode[]>;
  prompt: string;
  tokensUsed: number;
  nodesIncluded: number;
  /** Per-graph audit trail. Used by the desktop app's prompt-context inspector. */
  audit: AttachedGraphAudit[];
}

export async function federatedQuery(
  runner: FederatedQueryRunner,
  graphIds: GraphId[],
  query: string,
  cfg: PolicyConfig,
  budget: SubgraphBudget = DEFAULT_BUDGET,
): Promise<FederatedSubgraph> {
  const shareable = shareableGraphs(cfg, graphIds);
  const perGraphK = Math.max(5, Math.ceil(budget.maxNodes / Math.max(1, shareable.length)) * 2);

  // Run all per-graph queries in parallel.
  const results = await Promise.all(
    shareable.map(async (g): Promise<[GraphId, CandidateNode[]]> => [g, await runner.runQuery(g, query, perGraphK)]),
  );

  // Layer 1: per-graph tier cap. Compute it once per graph; track running usage.
  const graphCaps = new Map<GraphId, { maxTokens: number; maxNodes: number; usedTokens: number; usedNodes: number }>();
  for (const g of shareable) {
    const cap = budgetFor(cfg, g, budget);
    graphCaps.set(g, { ...cap, usedTokens: 0, usedNodes: 0 });
  }

  // Apply per-graph policy filters (redaction).
  const filtered: CandidateNode[] = [];
  for (const [g, candidates] of results) {
    const policy = cfg.graphs.find(p => p.graphId === g);
    for (const c of candidates) {
      const probe: { type?: string; tags?: string[]; content?: string } = { content: c.text };
      if (c.type !== undefined) probe.type = c.type;
      if (c.tags !== undefined) probe.tags = c.tags;
      if (redactNode(probe, policy)) continue;
      filtered.push(c);
    }
  }

  // Interleave across graphs by score, respecting both tier caps and the global budget.
  filtered.sort((a, b) => b.score - a.score);

  const byGraph = new Map<GraphId, CandidateNode[]>();
  let totalTokens = 0;
  let totalCount = 0;
  const minPerGraph = budget.perGraphMinTokens ?? 0;
  const reserved = new Map<GraphId, number>();
  for (const g of shareable) reserved.set(g, minPerGraph);

  for (const cand of filtered) {
    if (totalCount >= budget.maxNodes) break;
    const t = estimateTokens(cand.text);
    const cap = graphCaps.get(cand.graphId);
    if (!cap) continue;

    // Per-graph tier cap is hard.
    if (cap.usedNodes >= cap.maxNodes) continue;
    if (cap.usedTokens + t > cap.maxTokens) continue;

    // Global budget allows a reserved minimum per graph; otherwise yields to the budget.
    const reservedHere = reserved.get(cand.graphId) ?? 0;
    if (totalTokens + t > budget.maxTokens && reservedHere <= 0) continue;

    const bucket = byGraph.get(cand.graphId) ?? [];
    bucket.push(cand);
    byGraph.set(cand.graphId, bucket);

    cap.usedTokens += t;
    cap.usedNodes += 1;
    totalTokens += t;
    totalCount += 1;
    if (reservedHere > 0) reserved.set(cand.graphId, Math.max(0, reservedHere - t));
  }

  const audit: AttachedGraphAudit[] = [];
  for (const g of shareable) {
    const cap = graphCaps.get(g)!;
    audit.push({
      graphId: g,
      tier: tierOf(cfg, g),
      nodesIncluded: cap.usedNodes,
      tokensIncluded: cap.usedTokens,
    });
  }

  return { byGraph, prompt: renderPrompt(byGraph), tokensUsed: totalTokens, nodesIncluded: totalCount, audit };
}

function renderPrompt(byGraph: Map<GraphId, CandidateNode[]>): string {
  const sections: string[] = [];
  sections.push('# Graphnosis context');
  sections.push('The following memories from the user\'s personal graphs may be relevant.');
  for (const [g, items] of byGraph) {
    sections.push(`\n## Graph: ${g}`);
    for (const item of items) {
      sections.push(`- ${item.text}`);
    }
  }
  return sections.join('\n');
}

export { TIER_CAPS };
