// Tool registry for the Ghampus runtime.
//
// Each tool wraps a primitive on `GraphnosisHost`. Tools share the same
// host as the MCP server (a recall called from Ghampus and a recall
// called from Claude Desktop run identically at the storage layer), but
// the wrappers here return structured JSON instead of the MCP
// `{content:[{type:'text', text}]}` envelope — the LLM driver formats it
// for the chat surface separately.
//
// Phase 3 implements three read-only tools (recall, stats, list_engrams).
// Write tools (remember, edit, forget) are declared in `agent-types.ts`
// but their handlers throw — they need the correction-flow integration
// to land first so the user reviews diffs before they commit.

import type { GraphnosisHost } from './host.js';
import type { AgentToolName } from './agent-types.js';

export interface AgentToolDeps {
  host: GraphnosisHost;
}

export interface RecallToolArgs {
  query: string;
  /** When set, restrict the federated recall to these graphIds. */
  onlyEngrams?: string[];
  /** Token budget for the result. Default 2000 mirrors the MCP `recall`. */
  maxTokens?: number;
  /** Node budget. Default 20 mirrors the MCP `recall`. */
  maxNodes?: number;
}

export interface RecallToolResult {
  prompt: string;
  nodesIncluded: number;
  tokensUsed: number;
  engramsContributing: string[];
  /**
   * Phase 4 sharing-integration: when any contributing engram is covered
   * by an active outbound share, the share name(s) are surfaced here so
   * the chat surface can render the "you're sharing this" provenance
   * badge. Empty array when no shared engram contributed.
   */
  sharingProvenance: Array<{ engramId: string; shareName: string; role: string }>;
}

export interface StatsToolResult {
  graphs: Array<{
    graphId: string;
    totalNodes: number;
    activeNodes: number;
    softDeletedNodes: number;
    sources: number;
  }>;
}

export interface ListEngramsToolResult {
  engrams: Array<{
    graphId: string;
    displayName: string;
    tier: string;
    template?: string;
    archived: boolean;
    loaded: boolean;
  }>;
}

export class AgentToolNotImplementedError extends Error {
  constructor(tool: AgentToolName) {
    super(`Tool '${tool}' is declared but not yet implemented in Phase 3.`);
    this.name = 'AgentToolNotImplementedError';
  }
}

/**
 * The runtime calls into this single function with a tool name + parsed
 * args, gets back a structured result. Dispatch by tool name. Unknown tool
 * → throw before touching the host.
 */
export async function invokeAgentTool(
  deps: AgentToolDeps,
  tool: AgentToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case 'recall':
      return runRecall(deps, args as unknown as RecallToolArgs);
    case 'stats':
      return runStats(deps);
    case 'list_engrams':
      return runListEngrams(deps);
    case 'remember':
    case 'edit':
    case 'forget':
      throw new AgentToolNotImplementedError(tool);
    default: {
      // Exhaustive — TS will flag if AgentToolName grows.
      const _exhaustive: never = tool;
      throw new Error(`Unknown agent tool: ${String(_exhaustive)}`);
    }
  }
}

async function runRecall(deps: AgentToolDeps, args: RecallToolArgs): Promise<RecallToolResult> {
  if (typeof args.query !== 'string' || args.query.trim().length === 0) {
    throw new Error('recall requires a non-empty `query` string.');
  }
  const budget = {
    maxTokens: typeof args.maxTokens === 'number' && args.maxTokens > 0 ? args.maxTokens : 2000,
    maxNodes: typeof args.maxNodes === 'number' && args.maxNodes > 0 ? args.maxNodes : 20,
    perGraphMinTokens: 150,
  };
  const sub = await deps.host.recall(args.query, {
    budget,
    ...(args.onlyEngrams && args.onlyEngrams.length > 0 ? { onlyGraphIds: args.onlyEngrams } : {}),
  });
  const contributing = sub.audit
    .filter((a) => a.nodesIncluded > 0)
    .map((a) => a.graphId);
  // Phase 4 sharing-integration: for each contributing engram, look up
  // whether the user has an active outbound sharing token covering it.
  // The presence of a share doesn't change the recall result — it just
  // surfaces the provenance so the chat surface can badge facts that
  // are visible to collaborators. Expired tokens are skipped.
  const sharingProvenance = collectSharingProvenance(deps.host, contributing);
  return {
    prompt: sub.prompt,
    nodesIncluded: sub.nodesIncluded,
    tokensUsed: sub.tokensUsed,
    engramsContributing: contributing,
    sharingProvenance,
  };
}

function collectSharingProvenance(
  host: GraphnosisHost,
  engramIds: string[],
): Array<{ engramId: string; shareName: string; role: string }> {
  const tokens = host.getSettings().sharing?.tokens ?? [];
  if (tokens.length === 0) return [];
  const now = Date.now();
  const out: Array<{ engramId: string; shareName: string; role: string }> = [];
  for (const token of tokens) {
    if (token.expiresAt !== undefined && token.expiresAt <= now) continue;
    const covered: Set<string> = token.scope.engrams === '*'
      ? new Set(engramIds)
      : new Set((token.scope.engrams as string[]).filter((id) => engramIds.includes(id)));
    for (const engramId of covered) {
      out.push({ engramId, shareName: token.name, role: token.scope.role });
    }
  }
  return out;
}

function runStats(deps: AgentToolDeps): StatsToolResult {
  const s = deps.host.stats();
  return {
    graphs: s.graphs.map((g) => ({
      graphId: g.graphId,
      totalNodes: g.totalNodes,
      activeNodes: g.activeNodes,
      softDeletedNodes: g.softDeletedNodes,
      sources: g.sources,
    })),
  };
}

function runListEngrams(deps: AgentToolDeps): ListEngramsToolResult {
  const rows = deps.host.graphsWithMetadata({ includeUnloaded: true });
  return {
    engrams: rows.map(({ graphId, metadata, loaded }) => ({
      graphId,
      displayName: metadata.displayName ?? graphId,
      tier: (metadata as { sensitivityTier?: string }).sensitivityTier ?? 'personal',
      ...(metadata.template !== undefined ? { template: metadata.template } : {}),
      archived: (metadata as { archived?: boolean }).archived ?? false,
      loaded,
    })),
  };
}
