import * as gllOverlayMod from '../gll-overlay.js';
import * as gnnStoreMod from '../gnn-store.js';
import type { GraphnosisAdapter } from '../graphnosis-adapter.js';

// ── Rich recall prompt builder ───────────────────────────────────────────────
//
// Replaces the federation module's flat bullet-point renderPrompt with the
// SDK's === KNOWLEDGE SUBGRAPH === format per engram, plus a cross-graph
// connections section that surfaces entity overlap between budget-selected
// nodes from different engrams.
//
// Flow:
//   1. Per-graph: serializeSubgraph(budget-filtered nodes + intra-graph edges)
//   2. Cross-graph: entity overlap detection over ALL selected nodes across
//      graphs. The secure-sync federation is the backbone that decides which
//      nodes matter; this layer makes the implicit semantic connections explicit.
//
// Falls back to flat bullets for any graph whose rich subgraph wasn't captured.
export function buildRichRecallPrompt(
  byGraph: Map<string, Array<{ nodeId: string; text: string }>>,
  perGraphRich: Map<string, import('../graphnosis-adapter.js').RichSubgraph>,
  displayName: (graphId: string) => string,
): string {
  type NodeMergeData = import('../graphnosis-adapter.js').NodeMergeData;

  const sections: string[] = [
    '# Graphnosis context',
    'The following memories from the user\'s personal knowledge graphs may be relevant.',
  ];

  // ── Per-graph rich sections ──────────────────────────────────────────────
  // Collect node data for cross-graph analysis while we're iterating.
  const perGraphNodes = new Map<string, NodeMergeData[]>();
  for (const [graphId, nodes] of byGraph) {
    if (nodes.length === 0) continue;
    sections.push(`\n## ${displayName(graphId)}`);
    const rich = perGraphRich.get(graphId);
    if (rich) {
      const selectedIds = new Set(nodes.map(n => n.nodeId));
      sections.push(rich.serialize(selectedIds));
      perGraphNodes.set(graphId, rich.getNodeData(selectedIds));
    } else {
      for (const n of nodes) sections.push(`- ${n.text}`);
    }
  }

  // ── Cross-graph entity connections ────────────────────────────────────────
  // Only meaningful when 2+ graphs contributed nodes.
  if (perGraphNodes.size >= 2) {
    const crossSection = buildCrossGraphSection(perGraphNodes, displayName);
    if (crossSection) sections.push(crossSection);
  }

  return sections.join('\n');
}

/**
 * Detects entity overlap between budget-selected nodes from different engrams.
 * Returns a formatted section string, or null when there are no cross-graph
 * connections (common when only one engram has relevant content).
 *
 * Algorithm:
 *   1. Build entity → [(graphId, nodeId, preview)] from SDK-extracted entities.
 *   2. Entities that appear in 2+ different graphs are cross-graph connections.
 *   3. Render as a readable list so the AI can see which facts across engrams
 *      refer to the same person / place / concept.
 *
 * Uses the entities field populated by the SDK's NER pass during ingest, so
 * cross-graph detection is as rich as the ingested content allows.
 */
function buildCrossGraphSection(
  perGraphNodes: Map<string, import('../graphnosis-adapter.js').NodeMergeData[]>,
  displayName: (graphId: string) => string,
): string | null {
  // entity (normalized) → Map<graphId, content previews>
  const entityIndex = new Map<string, Map<string, string[]>>();

  for (const [graphId, nodes] of perGraphNodes) {
    for (const node of nodes) {
      for (const raw of node.entities) {
        const entity = raw.trim();
        if (entity.length < 3) continue;
        let graphMap = entityIndex.get(entity);
        if (!graphMap) { graphMap = new Map(); entityIndex.set(entity, graphMap); }
        const previews = graphMap.get(graphId) ?? [];
        // Short preview: first 60 chars of node content
        const preview = node.content.length > 60 ? node.content.slice(0, 57) + '…' : node.content;
        if (!previews.includes(preview)) previews.push(preview);
        graphMap.set(graphId, previews);
      }
    }
  }

  // Keep only entities that appear in 2+ distinct graphs
  const crossEntityLines: string[] = [];
  for (const [entity, graphMap] of entityIndex) {
    if (graphMap.size < 2) continue;
    const parts: string[] = [];
    for (const [graphId, previews] of graphMap) {
      parts.push(`${displayName(graphId)}: "${previews[0]}"`);
    }
    crossEntityLines.push(`  "${entity}" → ${parts.join(' | ')}`);
  }

  if (crossEntityLines.length === 0) return null;

  return [
    '\n--- CROSS-GRAPH CONNECTIONS ---',
    'Entities shared across engrams (federation via secure-sync, entity overlap detected by app layer):',
    ...crossEntityLines,
  ].join('\n');
}

// ── Overlay merge (GLL + GNN → recall prompt) ───────────────────────────────
//
// Both overlays are non-authoritative — they hold probabilistic outputs that
// must never blend silently into the canonical recall. So instead of merging
// them into the per-graph rich subgraph section, we append a dedicated
// "INFERRED LAYER" footer where every line carries a [gll] or [gnn] badge
// plus a score the AI can use to weight its response.
//
// We surface only overlay entries that TOUCH the budget-selected node set —
// otherwise the section would balloon with predictions about memories the AI
// can't see anyway. For assertions: at least one of their `derivedFrom` ids
// must be in the included set. For edges: both endpoints must be included.
//
// Returns null when no overlay entry intersects the included set, so the
// caller can suppress the section entirely (no empty "INFERRED LAYER" header).
export function buildOverlaySection(
  includedIdsByGraph: Map<string, Set<string>>,
  gll: { edges: gllOverlayMod.GllPredictedEdge[]; assertions: gllOverlayMod.GllAssertion[] },
  gnn: gnnStoreMod.PredictedEdge[],
  displayName: (graphId: string) => string,
): string | null {
  // Map graph → list of overlay rows so we can render per-engram blocks.
  const rowsByGraph = new Map<string, string[]>();
  const pushRow = (graphId: string, row: string): void => {
    const arr = rowsByGraph.get(graphId) ?? [];
    arr.push(row);
    rowsByGraph.set(graphId, arr);
  };

  // GLL assertions — synthesized facts the local LLM drew from canonical nodes.
  for (const a of gll.assertions) {
    const includedSet = includedIdsByGraph.get(a.graphId);
    if (!includedSet) continue;
    const overlap = a.derivedFrom.filter((id) => includedSet.has(id));
    // Surface an assertion only when at least one of its source nodes is in
    // the recall result OR when derivedFrom is empty (pure synthesis bound
    // to this engram). Otherwise we'd flood the AI with predictions about
    // unrelated parts of the graph.
    if (a.derivedFrom.length > 0 && overlap.length === 0) continue;
    const scorePct = Math.round(a.score * 100);
    const fromRef = overlap.length > 0 ? ` from [${overlap.slice(0, 3).join(', ')}]` : '';
    pushRow(a.graphId, `  [gll·assertion ${scorePct}%] ${a.content}${fromRef}`);
  }

  // GLL predicted edges — relationships the LLM inferred between attested
  // nodes. Only surface when both endpoints are in the included set so the
  // AI can actually map the edge to nodes it's seeing.
  for (const e of gll.edges) {
    const includedSet = includedIdsByGraph.get(e.graphId);
    if (!includedSet) continue;
    if (!includedSet.has(e.from) || !includedSet.has(e.to)) continue;
    const scorePct = Math.round(e.score * 100);
    pushRow(e.graphId, `  [gll·edge ${scorePct}%] ${e.from} —[${e.relationship}]→ ${e.to}`);
  }

  // GNN predicted edges — neural-network inferred connections. Same gating
  // as GLL edges: both endpoints must be in the included set.
  for (const e of gnn) {
    const includedSet = includedIdsByGraph.get(e.graphId);
    if (!includedSet) continue;
    if (!includedSet.has(e.from) || !includedSet.has(e.to)) continue;
    const scorePct = Math.round(e.score * 100);
    pushRow(e.graphId, `  [gnn·edge ${scorePct}%] ${e.from} —→ ${e.to}`);
  }

  if (rowsByGraph.size === 0) return null;

  const sections: string[] = [
    '--- INFERRED LAYER (overlays — NOT attested memory) ---',
    'These are probabilistic predictions and synthesized assertions from the',
    'local LLM (.gll) and neural network (.gnn) overlays. They are NEVER',
    'written to the canonical engram. Treat them as hints, not facts; the',
    'attested memory above is the authoritative source.',
  ];
  for (const [graphId, rows] of rowsByGraph) {
    sections.push(`\n### ${displayName(graphId)}`);
    sections.push(...rows);
  }
  return sections.join('\n');
}

// ── Entity-anchored seed inclusion (deterministic) ──────────────────────────
//
// A pre-ranking pass that force-includes any node whose extracted entities or
// content literally contains an entity from the query. This is the cheap
// deterministic answer to the failure mode "query mentions 'Nelu', node
// content is 'Nelu a locuit pe Aleea Plaiului', and yet recall returns
// nothing because TF-IDF scored the node low and the embedding model is
// English-first."
//
// Crucially: this works WITHOUT the local LLM, in any language, for any user.
// It complements `enrichRecallQuery` (which only helps when Ollama is on) by
// covering the same failure deterministically. With both enabled, enrichment
// widens the lexical/embedding match and anchoring guarantees literal entity
// matches survive ranking — the two compose cleanly.
//
// Anchor selection rules:
//   - Entities extracted from the raw query (capitalized words ≥ 3 chars,
//     quoted strings, hyphenated names, all-caps acronyms ≥ 2 chars,
//     ISO-ish dates).
//   - For each engram, match candidate nodes via (a) SDK-extracted
//     entities[] (case-insensitive) and (b) contentPreview substring scan
//     (case-insensitive) as a fallback for nodes whose NER pass missed
//     something.
//   - Cap per engram via `perGraphAnchorMax` (default 3) to keep the budget
//     allocation honest.
//   - Anchor results carry a synthetic score (ANCHOR_SCORE) high enough to
//     guarantee they survive the federation's per-graph top-k cut. The
//     federation budget still applies — anchors and regular candidates
//     compete for tokens, but anchors win ties.

export const ANCHOR_SCORE = 99;

// ── GNN-driven recall (Batch 11) ────────────────────────────────────────────
//
// The GNN overlay (.gnn) is read at recall-time to actually IMPROVE recall,
// not just decorate it with hints in the inferred-layer section.
//
// Two integration points, both in host.recall():
//   1. Graph expansion: each top-k node's recall-grade GNN neighbors get
//      added as additional candidates. Catches the "obviously related but
//      not directly mentioned" memories the deterministic match missed.
//   2. Anchor extension: each entity-anchor node's recall-grade GNN
//      neighbors also become anchors. Extends "Nelu" anchoring to include
//      nodes the GNN learned are tightly related to Nelu-mentioning nodes.
//
// Tightly-bounded by a recall-grade confidence threshold (stricter than
// the broader display/persistence threshold) so low-confidence predictions
// don't pollute retrieval. Also gated by `brain.neuralNetwork.enabled` —
// no-op when GNN is off so users who haven't opted in see no behavior
// change.

/** Stricter than the broader GNN_SCORE_THRESHOLD used at training/persist
 *  time. Only predictions above this confidence are allowed to influence
 *  WHICH NODES GET RETRIEVED — the broader set is fine for visualization
 *  and AI-client hints, but recall must be conservative. */
export const GNN_RECALL_THRESHOLD = 0.85;
/** Max GNN-predicted neighbors added per top-k seed during recall expansion.
 *  Keeps the candidate pool from blowing up — a top-k of 20 with 3 expansions
 *  each adds up to 60 candidates, well within federation budget allocation. */
export const GNN_EXPANSION_PER_SEED = 3;
/** Max GNN-predicted neighbors added per entity anchor during anchor
 *  extension. Smaller than EXPANSION_PER_SEED because anchors are already
 *  forced-included; their neighbors are bonus inclusions. */
export const GNN_ANCHOR_EXPANSION_PER_SEED = 2;
/** Synthetic score for GNN-expansion candidates. Above typical TF-IDF noise
 *  (~0.5 floor) so they get federation budget consideration, below ANCHOR_SCORE
 *  (99) so true anchors still win, below the highest organic matches so a
 *  perfect TF-IDF hit isn't displaced by a graph-expansion neighbor. */
export const GNN_EXPANSION_SCORE = 1.5;

// ── dig_deeper tuning ───────────────────────────────────────────────────────
// Max chunks to pull per source-filename-matched source. Set conservatively
// so a single matched source doesn't eclipse content matches from elsewhere.
export const DIG_DEEPER_PER_SOURCE_CAP = 5;
// Max total nodes pulled via cross-engram entity hop. Bounded because the
// connection store can be large and we don't want one entity to flood the
// result with N nodes from N other engrams.
export const DIG_DEEPER_CROSS_ENGRAM_CAP = 10;

/** Adjacency view over the GNN overlay, scoped to recall-grade edges only.
 *  Built once at the start of recall() and reused inside every runQuery
 *  callback. O(E) build, O(1) lookups thereafter. */
export type GnnRecallAdjacency = Map<string, Map<string, Array<{ neighborId: string; score: number }>>>;

export function buildGnnRecallAdjacency(
  gnnEdges: gnnStoreMod.PredictedEdge[],
  graphIds: Set<string>,
): GnnRecallAdjacency {
  const out: GnnRecallAdjacency = new Map();
  for (const e of gnnEdges) {
    if (!graphIds.has(e.graphId)) continue;
    if (e.score < GNN_RECALL_THRESHOLD) continue;
    let perGraph = out.get(e.graphId);
    if (!perGraph) { perGraph = new Map(); out.set(e.graphId, perGraph); }
    // Undirected: add both directions so any-direction lookup works.
    const pushNeighbor = (a: string, b: string): void => {
      let arr = perGraph!.get(a);
      if (!arr) { arr = []; perGraph!.set(a, arr); }
      arr.push({ neighborId: b, score: e.score });
    };
    pushNeighbor(e.from, e.to);
    pushNeighbor(e.to, e.from);
  }
  // Sort each adjacency list by score desc so consumers can take top-N
  // without re-sorting per lookup.
  for (const perGraph of out.values()) {
    for (const arr of perGraph.values()) {
      arr.sort((a, b) => b.score - a.score);
    }
  }
  return out;
}

/** Pull up to `perSeedMax` recall-grade neighbors per seed nodeId, dedup
 *  across seeds, drop any already in `existingIds`. Returns the chosen
 *  neighbors with their text content (looked up from `inspected`). */
export function expandViaGnn(
  adj: Map<string, Array<{ neighborId: string; score: number }>> | undefined,
  inspected: ReturnType<GraphnosisAdapter['inspectNodes']>,
  active: Set<string>,
  seedIds: string[],
  existingIds: Set<string>,
  perSeedMax: number,
): Array<{ nodeId: string; text: string }> {
  if (!adj || seedIds.length === 0 || perSeedMax <= 0) return [];
  const chosen = new Map<string, string>(); // nodeId → contentPreview
  const textById = new Map<string, string>();
  for (const n of inspected) textById.set(n.id, n.contentPreview);
  for (const seed of seedIds) {
    const neighbors = adj.get(seed);
    if (!neighbors) continue;
    let added = 0;
    for (const { neighborId } of neighbors) {
      if (added >= perSeedMax) break;
      if (existingIds.has(neighborId) || chosen.has(neighborId)) continue;
      if (!active.has(neighborId)) continue;
      const text = textById.get(neighborId);
      if (!text) continue;
      chosen.set(neighborId, text);
      added += 1;
    }
  }
  return Array.from(chosen, ([nodeId, text]) => ({ nodeId, text }));
}

// Tiny stopword list — only used to gate lowercase candidate tokens that
// might sneak through capitalization heuristics. Capitalized words always
// pass (even "The" or "And") because the federation cap dedupes/limits them.
const ENTITY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'have',
  'are', 'was', 'were', 'has', 'had', 'not', 'but', 'all', 'any',
]);

/**
 * Strip diacritics via NFD normalization → drop combining marks. Folds
 * "România" → "Romania", "São Paulo" → "Sao Paulo", "Zürich" → "Zurich",
 * "Łukasz" → "Lukasz", etc. Used during entity extraction + anchor matching
 * so a user typing the ASCII form of a proper noun still anchors on the
 * Unicode-with-diacritics form stored in nodes (and vice-versa).
 *
 * Critical for any non-English content. The SDK's TF-IDF default analyzer
 * (asciiFoldAnalyzer) ALSO folds — verified May 2026 with a direct probe:
 * `Romania` and `România` produce identical query seeds at identical scores.
 * The host-side fold here is belt + suspenders: it covers the entity-
 * anchoring path even if the SDK's analyzer is later swapped (e.g. for
 * `unicodeAnalyzer` to preserve Turkish phonemic diacritics).
 */
export function foldDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function extractQueryEntities(query: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (entity: string): void => {
    const trimmed = entity.trim();
    if (trimmed.length < 2) return;
    // Dedup AND stopword-check on the diacritic-folded lowercase form so
    // "România" and "Romania" collapse to one entity (whichever came first
    // is what gets preserved in the output for downstream matching, but
    // both forms are caught).
    const key = foldDiacritics(trimmed).toLowerCase();
    if (seen.has(key)) return;
    if (ENTITY_STOPWORDS.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  // 1. Quoted phrases — strongest signal, treat as single entity.
  for (const m of query.matchAll(/["'`]([^"'`]{2,})["'`]/g)) {
    add(m[1] ?? '');
  }
  // 2. Capitalized multi-word sequences (e.g. "New York", "Aleea Plaiului").
  for (const m of query.matchAll(/\b[A-ZĂÂÎȘȚĂÄÖÜß][\p{L}'-]+(?:\s+[A-ZĂÂÎȘȚĂÄÖÜß][\p{L}'-]+)+\b/gu)) {
    add(m[0]);
  }
  // 3. Single capitalized tokens ≥ 3 chars (Nelu, London, OpenAI).
  for (const m of query.matchAll(/\b[A-ZĂÂÎȘȚĂÄÖÜß][\p{L}'-]{2,}\b/gu)) {
    add(m[0]);
  }
  // 4. All-caps acronyms ≥ 2 chars (MCP, GDPR, AI).
  for (const m of query.matchAll(/\b[A-ZĂÂÎȘȚ]{2,}\b/g)) {
    add(m[0]);
  }
  // 5. Hyphenated compound names (Anne-Marie, Jean-Luc).
  for (const m of query.matchAll(/\b[\p{L}]{2,}(?:-[\p{L}]{2,})+\b/gu)) {
    add(m[0]);
  }
  // 6. Date-ish patterns (2024-03-15, 15/03/2024).
  for (const m of query.matchAll(/\b\d{2,4}[-/]\d{1,2}[-/]\d{1,4}\b/g)) {
    add(m[0]);
  }
  // 7. Short-query fallback: when the user types a 1–3 word query, treat each
  //    standalone lowercase token ≥3 chars as a potential entity. Without
  //    this, `recall("robert")` extracts NO entities (patterns 2/3/4 all
  //    require capitalization) and falls back to pure semantic search, which
  //    for a short common name gets distracted by adjacent context and misses
  //    the literal "Robert Gomboș" node sitting right in the cortex.
  //    Anchor matching downstream is already case-insensitive + diacritic-
  //    folded, so the entity string "robert" still hits a node containing
  //    "Robert Gomboș". Skipped for longer queries (sentences, conversational
  //    prompts) where every word becoming an anchor would over-fire.
  const wordTokens = query.trim().split(/\s+/);
  if (wordTokens.length > 0 && wordTokens.length <= 3) {
    for (const m of query.matchAll(/\b[\p{Ll}][\p{L}'-]{2,}\b/gu)) {
      add(m[0]);
    }
  }
  return out;
}

/**
 * Find anchor nodes for one engram. Returns at most `max` node descriptors
 * whose entities or content literally match one of the query entities.
 * Order: SDK-entity hits first (stronger signal), then content-substring hits.
 */
export function selectAnchorNodes(
  inspected: ReturnType<GraphnosisAdapter['inspectNodes']>,
  active: Set<string>,
  entities: string[],
  max: number,
): Array<{ nodeId: string; text: string }> {
  if (entities.length === 0 || max <= 0) return [];
  // Fold diacritics on BOTH sides so an ASCII-typed query ("Romania",
  // "Bistrita") matches Unicode content ("România", "Bistrița"), and vice
  // versa. Without this, recall on any non-English content with diacritics
  // (Romanian, French, German, Polish, Vietnamese, etc.) silently misses
  // even the most obvious literal-entity hits.
  const foldedEntities = entities.map((e) => foldDiacritics(e).toLowerCase());
  const entityHits: Array<{ nodeId: string; text: string }> = [];
  const contentHits: Array<{ nodeId: string; text: string }> = [];
  for (const node of inspected) {
    if (!active.has(node.id)) continue;
    const nodeEntitiesFolded = (node.entities ?? []).map((e) => foldDiacritics(e).toLowerCase());
    const entityMatch = foldedEntities.some((q) =>
      nodeEntitiesFolded.some((ne) => ne === q || ne.includes(q) || q.includes(ne)),
    );
    if (entityMatch) {
      entityHits.push({ nodeId: node.id, text: node.contentPreview });
      continue;
    }
    const contentFolded = foldDiacritics(node.contentPreview).toLowerCase();
    if (foldedEntities.some((q) => contentFolded.includes(q))) {
      contentHits.push({ nodeId: node.id, text: node.contentPreview });
    }
  }
  return [...entityHits, ...contentHits].slice(0, max);
}

// ── Source-filename match detection ─────────────────────────────────────────
//
// "Why did Virginia return 3 nodes from an engram of 1,362 chunks from the
// 'Virginia Linul thesis'?" → because TF-IDF indexes chunk CONTENT, not
// source FILENAMES. The engram's source ref is `/.../Virginia Linul/
// Teza doctorat Virginia Linul DIN ISTORICUL...pdf` — every chunk shares
// that ref — but only the chunks where her name appears literally in the
// body text get content-matched.
//
// This detector spots that case: scans the source list of each scoped
// engram for refs whose filename/path contains a query entity, and reports
// which ones are heavily-represented by the document but NOT well-served
// by the content-level recall. The recall response then shows a hint
// pointing the AI at recall_source / find_source — the right tool for
// "give me everything from that named document."
//
// Important non-action: this DOES NOT change retrieval. We're not inflating
// the candidate pool with source-filename matches. That's a separate (much
// larger) discussion — see the "smart recall redesign" deferred item.

/** Minimal host surface for source-filename hint detection. */
export interface SourceFilenameHost {
  listGraphs(): string[];
  listSources(graphId: string): import('@graphnosis-app/core').SourceRecord[];
}

export function detectSourceFilenameMatches(
  host: SourceFilenameHost,
  scopedGraphIds: string[],
  queryEntities: string[],
  byGraph: Map<string, Array<{ nodeId: string }>>,
): Array<{ graphId: string; sourceId: string; refLabel: string; matchedOn: string }> {
  if (queryEntities.length === 0) return [];
  const foldedEntities = queryEntities.map((e) => foldDiacritics(e).toLowerCase());
  const out: Array<{ graphId: string; sourceId: string; refLabel: string; matchedOn: string }> = [];
  // For each engram, walk its sources; check filename/path against entities.
  // Then we count how many of THIS engram's recalled nodes came from this
  // source — if "most of the document" already surfaced via content match,
  // suppress the hint (the user got what they wanted).
  for (const graphId of scopedGraphIds) {
    // Skip engrams that aren't loaded (listSources throws on unknown graph)
    if (!host.listGraphs().includes(graphId)) continue;
    const recalledIds = new Set((byGraph.get(graphId) ?? []).map((n) => n.nodeId));
    const sources = host.listSources(graphId);
    for (const src of sources) {
      const ref = src.ref ?? '';
      if (!ref) continue;
      const refFolded = foldDiacritics(ref).toLowerCase();
      const matched = foldedEntities.find((q) => refFolded.includes(q));
      if (!matched) continue;
      // The SourceRecord already carries the full nodeIds list — use it directly.
      const srcNodeIds = src.nodeIds ?? [];
      if (srcNodeIds.length === 0) continue;
      const recalledFromSource = srcNodeIds.filter((id) => recalledIds.has(id)).length;
      // Heuristic: suppress the hint when ≥ 30% of source chunks are already
      // in the result (the user is getting good coverage). Below that, the
      // hint is genuinely useful ("only 3 of 1362 surfaced — try recall_source").
      const coverageRatio = recalledFromSource / srcNodeIds.length;
      if (coverageRatio >= 0.30) continue;
      // Use the basename of the file path for a cleaner label, but fall back
      // to the full ref if it's not path-shaped (e.g., URL).
      const basename = ref.includes('/')
        ? ref.split('/').pop() ?? ref
        : ref;
      out.push({
        graphId,
        sourceId: src.sourceId,
        refLabel: basename.length > 60 ? basename.slice(0, 57) + '…' : basename,
        matchedOn: matched,
      });
    }
  }
  return out;
}

// ── Recall enrichment (local LLM, non-mutating) ─────────────────────────────
//
// Asks the local LLM to rewrite the raw user query into a search-friendlier
// string before it hits the lexical + embedding index. The transformation
// rules match the AI-client guidance in GRAPHNOSIS.md:
//
//   1. Strip framing words ("remind me", "what did I say about", etc.)
//   2. Add 1–2 synonyms in the same language as the query
//   3. If the query contains language hints, also include translated content
//      words in 1–2 other plausible languages — proper nouns stay verbatim
//
// The graph is never touched. Output replaces the query string fed to the
// federated retrieval; the original query is preserved for audit, the
// rewritten one shows up in the "_enriched: ..._" footer.
//
// Guard rails:
//   - 30s watchdog timeout — hung-Ollama safety net only, NOT UX pacing.
//     Enrichment skips immediately when P0–P2 work is active (work-priority).
//   - Cap output at 200 chars; longer output is treated as a malformed
//     response and we fall back to the original query
//   - Strip leading/trailing punctuation and newlines; the LLM sometimes
//     wraps with "Here is the query:" preamble despite the system prompt
const ENRICHMENT_TIMEOUT_MS = 30_000;
const ENRICHMENT_SYSTEM_PROMPT = `You rewrite a search query for a personal knowledge-graph lookup.

Rules:
1. Strip framing words ("remind me", "what did I say about", "do you know if", and equivalents in any language). Keep only the semantic content.
2. Keep the language(s) of the original query.
3. Add 1-2 close synonyms in the same language to widen lexical matches.
4. If the query mentions a topic that the user might have stored in a different language, also include 2-3 translated content words from one other plausible language (English is a good fallback).
5. Keep proper nouns (names of people, places, projects) VERBATIM — exact spelling and capitalization. Never transliterate.
6. Output ONLY the rewritten query string. No preamble, no explanation, no quotes, no markdown. 3-12 content words, space-separated.

Examples:
Input: "remind me where Nelu lived"
Output: Nelu lived where home location locuit unde

Input: "aminteste-mi unde a locuit nelu"
Output: Nelu unde locuit trait casa locuinta lived home

Input: "what did I say about the marketing project?"
Output: marketing project campaign proiect marketing campanie`;

function raceEnrichment<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('enrichment aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = (): void => {
      finish(() => reject(new DOMException('enrichment aborted', 'AbortError')));
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`enrichment timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (err) => finish(() => reject(err)),
    );
  });
}

export async function enrichRecallQuery(
  llm: import('../correction.js').LocalLlm,
  query: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const completion = await raceEnrichment(
    llm.complete({
      system: ENRICHMENT_SYSTEM_PROMPT,
      user: query,
      ...(signal ? { signal } : {}),
    }),
    signal,
    ENRICHMENT_TIMEOUT_MS,
  );
  const cleaned = completion
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '') // strip surrounding quotes
    .replace(/^Output:\s*/i, '')      // drop common preamble
    .replace(/\n.*/s, '')             // first line only — guard against multi-line output
    .trim();
  // Sanity: empty, too long, or identical to input ⇒ no useful enrichment.
  if (!cleaned || cleaned.length > 200 || cleaned.toLowerCase() === query.toLowerCase()) {
    return null;
  }

  // Additive guard: ensure every significant word from the original query
  // appears verbatim in the enriched result. Small local LLMs often drop
  // proper nouns (names, project identifiers) despite the system prompt.
  // If any original word is absent, prepend it so the lexical index still
  // anchors on the user's exact terms alongside the enriched expansions.
  const enrichedLower = cleaned.toLowerCase();
  const missing = query
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !enrichedLower.includes(w.toLowerCase()));
  const result = missing.length > 0 ? `${missing.join(' ')} ${cleaned}` : cleaned;
  return result.length > 300 ? result.slice(0, 300) : result;
}
