/**
 * MCP tool catalog for Ghampus — name + short description only.
 * Mirrors tools exposed by the sidecar MCP server (see mcp-server.ts tools/list).
 * Used for deterministic Ghampus answers; never invent training dates or skill metadata.
 */

export type McpToolCatalogEntry = {
  name: string;
  /** One-line summary — from MCP tool annotations.title where available. */
  shortDescription: string;
};

/** Static catalog — keep in sync with mcp-server ListToolsRequestSchema entries. */
export const MCP_TOOL_CATALOG: McpToolCatalogEntry[] = [
  { name: 'recall', shortDescription: 'Search memory across engrams' },
  { name: 'remind', shortDescription: 'Recall framed as a reminder' },
  { name: 'dig_deeper', shortDescription: 'Deep memory search with expansion passes' },
  { name: 'remember', shortDescription: 'Save a note to an engram' },
  { name: 'edit', shortDescription: 'Propose a correction or update to memory' },
  { name: 'apply', shortDescription: 'Apply an approved memory diff' },
  { name: 'forget', shortDescription: 'Soft-delete specific memory nodes' },
  { name: 'resolve_contradiction', shortDescription: 'Resolve or dismiss a flagged contradiction pair (Pro)' },
  { name: 'suppressed_contradictions', shortDescription: 'Audit triage-suppressed contradiction pairs (Pro)' },
  { name: 'stats', shortDescription: 'Node and source counts per engram' },
  { name: 'develop', shortDescription: 'Strategic planning grounded in memory (Pro)' },
  { name: 'predict', shortDescription: 'Risk and opportunity assessment (Pro)' },
  { name: 'insights', shortDescription: 'Background pattern insights (Pro)' },
  { name: 'vitality', shortDescription: 'Graph health score (0–100)' },
  { name: 'list_engrams', shortDescription: 'List all engrams in the cortex' },
  { name: 'list_attachments', shortDescription: 'List file attachments linked to engrams' },
  { name: 'suggest_engram', shortDescription: 'Suggest an engram for a note' },
  { name: 'browse_engram', shortDescription: 'List sources inside one engram' },
  { name: 'recent', shortDescription: 'Most recently ingested sources' },
  { name: 'get_engram_schema', shortDescription: 'Engram metadata and tier' },
  { name: 'recall_structured', shortDescription: 'Search memory — JSON node array' },
  { name: 'recall_obligations', shortDescription: 'List due deadlines and renewals' },
  { name: 'recall_as_of', shortDescription: 'Point-in-time recall (Enterprise audit)' },
  { name: 'recall_with_citations', shortDescription: 'Search memory with inline citations' },
  { name: 'compare_engrams', shortDescription: 'Same query against two engrams' },
  { name: 'cross_search', shortDescription: 'Federated search over chosen engrams' },
  { name: 'find_source', shortDescription: 'Find a source by keyword' },
  { name: 'recall_source', shortDescription: 'Full text of one saved source' },
  { name: 'transfer_source', shortDescription: 'Move a source between engrams' },
  { name: 'ingest_batch', shortDescription: 'Save up to 20 notes in one call' },
  { name: 'engram_summary', shortDescription: 'Snapshot of one engram' },
  { name: 'audit_memory', shortDescription: 'Cross-engram duplicate audit (Pro)' },
  { name: 'check_duplicate', shortDescription: 'Pre-save duplicate check' },
  { name: 'duplicate_pairs', shortDescription: 'Near-duplicate node pairs (Pro)' },
  { name: 'contradiction_pairs', shortDescription: 'Contradicting memory pairs (Pro)' },
  { name: 'compare_sources', shortDescription: 'Compare two sources for conflicts (Pro)' },
  { name: 'healing_journal', shortDescription: 'Autonomous correction log' },
  { name: 'gnn_status', shortDescription: 'Neural network status (Pro)' },
  { name: 'gnn_neighbors', shortDescription: 'GNN-predicted related nodes (Pro)' },
  { name: 'llm_query', shortDescription: 'Local LLM answer from memory (Pro)' },
  { name: 'llm_distill', shortDescription: 'Extract facts from text (Pro)' },
  { name: 'confirm_data_access', shortDescription: 'Headless consent phrase validation' },
  { name: 'train_skill', shortDescription: 'Train or retrain a skill SOP (Pro)' },
  { name: 'skill_vitality', shortDescription: 'Skill freshness score (Pro)' },
  { name: 'export_skill', shortDescription: 'Export skill as .gsk pack (Pro)' },
  { name: 'export_engram', shortDescription: 'Export engram pack' },
  { name: 'import_engram', shortDescription: 'Import engram pack' },
  { name: 'list_skills', shortDescription: 'List trained skills in the Skills engram' },
  { name: 'walk_skill', shortDescription: 'Explain a skill step-by-step' },
  { name: 'walk_skill_structured', shortDescription: 'Skill execution plan as JSON' },
  { name: 'save_skill_run', shortDescription: 'Persist multi-skill run progress (Pro)' },
  { name: 'resume_skill_run', shortDescription: 'Resume a saved skill run (Pro)' },
  { name: 'get_skill', shortDescription: 'Full text of one trained skill' },
  { name: 'skill_history', shortDescription: 'Training snapshot history (Pro)' },
  { name: 'rollback_skill', shortDescription: 'Revert skill to prior snapshot (Pro)' },
  { name: 'delete_skill', shortDescription: 'Remove a trained skill' },
];

export type ListMcpToolsOpts = {
  /** User-disabled tool names from Settings → MCP Tools. */
  disabled?: Set<string>;
  /** Optional keyword — match tool name or short description. */
  filterKeyword?: string | null;
};

function normalizeFilterKeyword(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/s$/, '');
}

/** True when tool name or description matches a filter keyword. */
export function mcpToolMatchesFilter(tool: McpToolCatalogEntry, keyword: string | null): boolean {
  if (!keyword) return true;
  const hay = `${tool.name} ${tool.shortDescription}`.toLowerCase();
  const needle = keyword.toLowerCase();
  if (hay.includes(needle)) return true;
  const stem = normalizeFilterKeyword(needle);
  if (stem.length >= 3 && hay.includes(stem)) return true;
  const tokens = needle.split(/\s+/).filter((t) => t.length >= 2);
  return tokens.length > 0 && tokens.every((t) => {
    const ts = normalizeFilterKeyword(t);
    return hay.includes(t) || (ts.length >= 3 && hay.includes(ts));
  });
}

export function filterMcpToolsByKeyword(
  tools: McpToolCatalogEntry[],
  keyword: string | null,
): McpToolCatalogEntry[] {
  if (!keyword) return tools;
  return tools.filter((t) => mcpToolMatchesFilter(t, keyword));
}

/** Available MCP tools for Ghampus listing (respects user denylist). */
export function listMcpToolsForGhampus(opts: ListMcpToolsOpts = {}): McpToolCatalogEntry[] {
  const disabled = opts.disabled ?? new Set<string>();
  let tools = MCP_TOOL_CATALOG.filter((t) => !disabled.has(t.name));
  tools = filterMcpToolsByKeyword(tools, opts.filterKeyword ?? null);
  return tools;
}
