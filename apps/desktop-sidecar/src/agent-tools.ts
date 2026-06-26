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
import type { SkillTrainer } from './skill-trainer.js';
import type { AgentToolName } from './agent-types.js';
import { augmentMemoryWithTemporalContext, inferObligationFromText } from './ghampus-temporal-parse.js';
import { stripInternalSourceRefPrefix } from './ghampus-recall-format.js';

export interface AgentToolDeps {
  host: GraphnosisHost;
  /**
   * Optional — when absent, `list_skills` returns an empty array rather
   * than throwing. Lets the agent surface degrade gracefully on cortexes
   * where the trainer isn't initialised (e.g. during cold-start tests).
   */
  skillTrainer?: SkillTrainer | null;
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
  /**
   * Attached files associated with the contributing engrams. The recall
   * prompt itself doesn't include attachment content (these are just
   * pointers), but the chat surface renders them as "Linked files" cards
   * so the user can open the source artifacts in their native apps.
   * Each entry mirrors `AttachmentRecord` from `attachments-store.ts`.
   */
  attachments: Array<{
    id: string;
    path: string;
    kind: string;
    label: string;
    note?: string;
    graphId: string;
    sourceId?: string;
    nodeIds?: string[];
    lastVerifiedOk: boolean;
    sizeBytes?: number;
  }>;
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

export interface ListSkillsToolArgs {
  /** Optional engram filter. When omitted, returns skills from every engram. */
  engramId?: string | undefined;
}

export interface ListSkillsToolResult {
  skills: Array<{
    sourceId: string;
    engramId: string;
    label: string;
    nodeCount: number;
    /** Source kind that produced the skill — 'locally-trained' vs 'imported-from-pack'. */
    origin: 'local' | 'pack';
    /** ISO string when last trained, when available. */
    trainedAt?: string;
    /** Recall breadth 0-100 — drives the runtime recall budget for the skill. */
    recallBreadth?: number;
    /** Title/trigger/body preview for Ghampus keyword filtering. */
    searchPreview?: string;
  }>;
}

export interface RememberToolArgs {
  /** Target engram. Required — Ghampus always knows which engram. */
  engramId: string;
  /** The content to save. Plain markdown / text. */
  content: string;
  /** Optional human-readable label shown in the recent-saves panel. */
  label?: string;
}

export interface RememberToolResult {
  /** Source id created for this save. */
  sourceId: string;
  /** Engram id the save landed in. */
  engramId: string;
  /** Number of nodes the SDK produced from this content. */
  nodeCount: number;
}

export interface RecentSavesArgs {
  /** Maximum number of memories to return. Defaults to 10. */
  limit?: number | undefined;
  /** Only include saves newer than this Unix ms. Default: 7 days ago. */
  sinceMs?: number | undefined;
}

export interface RecentSavesResult {
  saves: Array<{
    sourceId: string;
    engramId: string;
    label: string;
    addedAtMs: number;
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
    case 'list_skills':
      return runListSkills(deps, args as unknown as ListSkillsToolArgs);
    case 'remember':
      return runRemember(deps, args as unknown as RememberToolArgs);
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
  // Surface attached files for contributing engrams so the chat can
  // render "Linked files" cards. The recall prompt itself stays text-
  // only — attachments are out-of-band references that augment the UI.
  // Failures here are non-fatal; an attachment-store read error falls
  // back to an empty list so the recall path still succeeds.
  const attachments = await collectAttachments(deps.host.getCortexDir(), contributing).catch(() => []);
  return {
    prompt: sub.prompt,
    nodesIncluded: sub.nodesIncluded,
    tokensUsed: sub.tokensUsed,
    engramsContributing: contributing,
    sharingProvenance,
    attachments,
  };
}

/**
 * Defensive: even though `collectAttachments` is called only from
 * Ghampus today (which runs as the cortex owner with full access), the
 * `scopeAllowed` parameter is a hard filter so the function refuses to
 * return attachments from engrams outside the caller's scope. When the
 * MCP recall handler (used by sharing-tokened collaborators) eventually
 * surfaces attachment metadata, this gate is already in place.
 *
 * `null` for `scopeAllowed` means "no scope restriction" — caller is the
 * cortex owner. An explicit array restricts results to those graph ids.
 */
async function collectAttachments(
  cortexDir: string,
  graphIds: string[],
  scopeAllowed: string[] | null = null,
): Promise<RecallToolResult['attachments']> {
  if (graphIds.length === 0) return [];
  const inScope = scopeAllowed === null
    ? graphIds
    : graphIds.filter((g) => scopeAllowed.includes(g));
  if (inScope.length === 0) return [];
  const { listAttachments } = await import('./attachments-store.js');
  const all: RecallToolResult['attachments'] = [];
  for (const graphId of inScope) {
    const rows = await listAttachments(cortexDir, { graphId });
    for (const r of rows) {
      all.push({
        id: r.id,
        path: r.path,
        kind: r.kind,
        label: r.label,
        ...(r.note !== undefined ? { note: r.note } : {}),
        graphId: r.graphId,
        ...(r.sourceId !== undefined ? { sourceId: r.sourceId } : {}),
        ...(r.nodeIds !== undefined ? { nodeIds: r.nodeIds } : {}),
        lastVerifiedOk: r.lastVerifiedOk,
        ...(r.sizeBytes !== undefined ? { sizeBytes: r.sizeBytes } : {}),
      });
    }
  }
  // Cap to a reasonable count to keep recall responses bounded.
  return all.slice(0, 50);
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

function runListSkills(deps: AgentToolDeps, args: ListSkillsToolArgs): ListSkillsToolResult {
  if (!deps.skillTrainer) return { skills: [] };
  const raw = deps.skillTrainer.listSkills(args.engramId);
  return {
    skills: raw.map((s) => ({
      sourceId: s.sourceId,
      engramId: s.graphId,
      label: s.label,
      nodeCount: s.nodeCount,
      // The trainer marks pack-imported skills with a provenance entry;
      // everything else is locally-trained (including bundled demo packs
      // ingested via ingest_pack on first boot).
      origin: s.provenance ? 'pack' : 'local',
      ...(s.trainedAt !== undefined ? { trainedAt: s.trainedAt } : {}),
      ...(s.recallBreadth !== undefined ? { recallBreadth: s.recallBreadth } : {}),
      ...(s.searchPreview !== undefined ? { searchPreview: s.searchPreview } : {}),
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

/**
 * Save a memory to an engram via Ghampus. Tagged with `addedBy: 'ghampus'`
 * so `listRecentSaves` can surface it in the "Picking up where we left
 * off" panel — the user feels session continuity without us actually
 * maintaining a session sidebar.
 *
 * Each save gets a fresh sourceRef (`ghampus:<random>`) so re-saves of
 * the same content land as separate sources rather than triggering the
 * SDK's dedupe short-circuit.
 */
async function runRemember(deps: AgentToolDeps, args: RememberToolArgs): Promise<RememberToolResult> {
  if (typeof args.engramId !== 'string' || args.engramId.trim().length === 0) {
    throw new Error('remember requires `engramId`.');
  }
  if (typeof args.content !== 'string' || args.content.trim().length === 0) {
    throw new Error('remember requires non-empty `content`.');
  }
  const ref = args.label
    ? `ghampus:${args.label.slice(0, 60).replace(/[^\w\s-]/g, '').trim()}-${Date.now().toString(36)}`
    : `ghampus:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const content = augmentMemoryWithTemporalContext(args.content).text;
  const obligation = inferObligationFromText(content);
  // `ai-conversation` is the closest existing SourceRecord.kind for a
  // memory captured during an interactive turn. Ghampus saves are tagged
  // `addedBy: 'ghampus'` so listRecentSaves can filter without scanning
  // every source's content.
  const result = await deps.host.ingest(
    args.engramId,
    'ai-conversation',
    ref,
    { kind: 'markdown', content, sourceRef: ref },
    {
      addedBy: 'ghampus',
      ...(obligation ? { obligation } : {}),
    },
  );
  return {
    sourceId: result.sourceId,
    engramId: args.engramId,
    nodeCount: result.nodeIds.length,
  };
}

/** Strip internal sourceId/ref prefixes for user-visible labels. */
export function formatUserVisibleSourceLabel(ref: string, sourceId?: string): string {
  const raw = (ref || sourceId || '').trim();
  if (!raw) return 'Saved memory';

  const stripped = stripInternalSourceRefPrefix(raw);
  if (stripped !== raw) return stripped || 'Saved memory';

  if (/^clip:/i.test(raw)) {
    const rest = raw.slice(raw.indexOf(':') + 1);
    const colon = rest.indexOf(':');
    if (colon !== -1) {
      const title = rest.slice(colon + 1).trim();
      if (title) return title;
    }
    return 'AI memory';
  }
  if (/^skill:/i.test(raw)) {
    const rest = raw.slice(raw.indexOf(':') + 1);
    const colon = rest.indexOf(':');
    const label = colon !== -1 ? rest.slice(colon + 1) : rest;
    return label.replace(/-/g, ' ').trim() || 'Skill';
  }
  if (raw.startsWith('ghampus:')) {
    const body = raw.slice('ghampus:'.length).replace(/-[a-z0-9]+$/i, '').replace(/-/g, ' ').trim();
    return body || 'Saved memory';
  }
  if (raw.startsWith('ai-conversation:')) {
    const rest = raw.slice('ai-conversation:'.length);
    const colon = rest.indexOf(':');
    return colon !== -1 ? rest.slice(colon + 1).trim() : 'AI conversation';
  }
  const cleaned = raw
    .replace(/^(file|url|sharing):/i, '')
    .replace(/^https?:\/\//, '')
    .replace(/\?[^?]*$/, '')
    .trim();
  if (cleaned.length >= 3 && !/^clip:/i.test(cleaned)) return cleaned;
  if (sourceId && !sourceId.startsWith('clip:')) {
    return formatUserVisibleSourceLabel(sourceId);
  }
  return 'Saved memory';
}

/**
 * Return the most recent memories saved through Ghampus (across all
 * engrams). Drives the "Picking up where we left off" panel.
 *
 * Implemented by scanning each engram's source index for sources whose
 * `addedBy` field is `'ghampus'`, then sorting by createdAt. Cheap even
 * for large cortexes — the SourceIndex is in memory and the predicate
 * filters early.
 */
export function listRecentSaves(deps: AgentToolDeps, args: RecentSavesArgs): RecentSavesResult {
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(50, Math.floor(args.limit)) : 10;
  const sinceMs = typeof args.sinceMs === 'number' ? args.sinceMs : Date.now() - 7 * 24 * 60 * 60 * 1000;
  const all: Array<{ sourceId: string; engramId: string; label: string; addedAtMs: number }> = [];
  for (const engramId of deps.host.listGraphs()) {
    const sources = deps.host.listSources(engramId);
    for (const s of sources) {
      if (s.addedBy !== 'ghampus') continue;
      if (s.ingestedAt < sinceMs) continue;
      const label = formatUserVisibleSourceLabel(s.ref, s.sourceId);
      all.push({
        sourceId: s.sourceId,
        engramId,
        label,
        addedAtMs: s.ingestedAt,
      });
    }
  }
  all.sort((a, b) => b.addedAtMs - a.addedAtMs);
  return { saves: all.slice(0, limit) };
}
