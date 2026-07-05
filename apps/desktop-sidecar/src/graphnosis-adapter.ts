import type { EmbedFn } from '@graphnosis-app/core/embeddings';

// Thin adapter interface in front of the `@nehloo/graphnosis` SDK.
// Verified against v0.2.3 (dist/sdk/index.d.ts).
//
// This is the single seam against the SDK. Two design notes baked in here:
//
// 1) The SDK distinguishes "pre-build" ingestion (`addMarkdown/...`, returns `this`)
//    from "post-build" ingestion (`appendMarkdown/...`, returns `AppendResult`).
//    The App always operates on already-built graphs after the first save, so we
//    only expose `appendDocument` — the adapter calls `build()` once internally on
//    fresh graphs.
//
// 2) Append calls do NOT return node IDs. The adapter recovers them by diffing
//    `g.graph.nodes` before/after each append. Brittle if two appends interleave,
//    so the host serializes ingest calls per graph.
//
// 3) SDK corrections are soft — `deleteNode(id, reason)` drops confidence to 0.1
//    and sets `validUntil = now`; the node stays for audit. We surface that
//    semantics rather than hiding it.

export interface GraphHandle {
  readonly graphId: string;
}

export interface AppendDocumentInput {
  kind: 'markdown' | 'html' | 'json' | 'csv' | 'pdf' | 'text';
  content: string | Uint8Array;
  sourceRef: string;
}

/**
 * User-tunable ingestion presets. Map to SDK chunking knobs. App settings
 * carry the global default; per-call overrides are possible for power-user
 * flows (e.g. "Add this big PDF with `coarse` chunking just this once").
 *
 * - `fine`     ≈ 300-char nodes, ≤ 2 sentences. More semantic vectors,
 *               finer-grained recall, higher embedding cost.
 * - `balanced` ≈ 500-char nodes, ≤ 3 sentences. Default.
 * - `coarse`   ≈ 2500-char nodes, ≤ 6 sentences. Fewer nodes, lower
 *               memory + faster ingest, less precise recall.
 */
export type ChunkSizePreset = 'fine' | 'balanced' | 'coarse';

/**
 * Embedding batch sizing preset. Controls how many texts the SDK groups
 * into one `embed([...])` adapter call.
 *
 * - `small`  → 64 items/call.   Low memory, frequent progress.
 * - `medium` → 256 items/call.  Default.
 * - `large`  → 1024 items/call. Highest throughput on big-RAM machines.
 * - `auto`   → totalmem ≥ 32 GB → large, ≥ 16 GB → medium, else small.
 */
export type EmbedBatchPreset = 'small' | 'medium' | 'large' | 'auto';

export interface AppendDocumentOptions {
  chunkSize?: ChunkSizePreset;
  /**
   * Single-node guarantee for one-semantic-unit inserts (skill steps, goal
   * lines, recipes). When true, after the SDK append produces its node(s),
   * the adapter collapses the result to EXACTLY ONE node whose content is the
   * verbatim input text — rewriting the first node and deleting any extras the
   * SDK's chunker split off (e.g. a step ending in "etc." or "e.g." that the
   * sentence splitter fractured). Off by default: normal ingestion and recall
   * must keep chunking multi-sentence prose into multiple nodes.
   */
  singleNode?: boolean;
}

export interface BuildEmbeddingsAdapterOpts {
  embed: EmbedFn;
  dimensions: number;
  id: string;
  /** Preset or explicit number — see SDK buildEmbeddings batchSize semantics. */
  batchSize?: EmbedBatchPreset | number;
}

export interface AppendDocumentResult {
  newNodeIds: string[];
  newNodes: number;
  contradictions: unknown[];
}

/** A contradiction the SDK's reflection engine detected between two nodes —
 *  high shared-entity overlap but low content similarity plus a conflict signal.
 *  Returned by `reflectGraph` and (incrementally) inside `AppendDocumentResult`. */
export interface ContradictionResult {
  nodeA: string;
  nodeB: string;
  sharedEntities: string[];
  description: string;
  detectedAt: number;
}

export interface QueryResult {
  nodeId: string;
  score: number;
  text: string;
  type?: string;
  source?: { file: string; line?: number; section?: string };
}

/**
 * Per-graph rich subgraph returned by `queryRich()`. Exposes the edges that
 * the SDK's traversal recovered alongside the flat candidate list, plus a
 * `serialize()` closure that re-runs `serializeSubgraph` on an arbitrary
 * subset of node IDs — used by the host after federation budget filtering to
 * produce a === KNOWLEDGE SUBGRAPH === prompt block containing only the
 * budget-selected nodes and the edges that connect them.
 *
 * SDK types stay inside `graphnosis-impl.ts`; the adapter surface uses plain
 * scalars and the edge-type unions already defined here.
 */
/** Flat node data extracted from the SDK subgraph for cross-graph analysis. */
export interface NodeMergeData {
  id: string;
  content: string;
  type?: string;
  /** Entities the SDK extracted during ingest (proper nouns, dates, technical terms, …). */
  entities: string[];
  score: number;
}

export interface RichSubgraph {
  directedEdges: Array<{ id: string; from: string; to: string; type: DirectedEdgeType; weight: number }>;
  undirectedEdges: Array<{ id: string; nodes: [string, string]; type: UndirectedEdgeType; weight: number }>;
  /** Score map over all traversal nodes (seeds have their TF-IDF/embedding score; expansion nodes 0). */
  scores: Map<string, number>;
  /**
   * Re-serialize to the rich KNOWLEDGE SUBGRAPH text format using only the
   * provided node IDs. Edges where either endpoint is not in the set are
   * omitted automatically. Call this after federation budget selection with
   * the winning nodeIds for that graph.
   */
  serialize(nodeIds: Set<string>): string;
  /**
   * Returns flat node data (including SDK-extracted entities) for the given
   * node IDs. Used by the host to detect cross-graph entity overlap after
   * federation has selected the budget-winning nodes from each graph.
   * Keeps SDK types inside graphnosis-impl.ts — caller receives plain objects.
   */
  getNodeData(nodeIds: Set<string>): NodeMergeData[];
}

export interface RichQueryResult {
  candidates: QueryResult[];
  rich: RichSubgraph;
}

export interface CorrectionEdit {
  /** "edit" replaces content in place; "supersede" creates a new node and links old→new; "delete" soft-deletes. */
  kind: 'edit' | 'supersede' | 'delete';
  nodeId: string;
  /** Required for edit/supersede; ignored for delete. */
  content?: string;
  /** Human-readable reason stored on the node for audit. */
  reason: string;
}

export interface GraphnosisAdapter {
  create(graphId: string): Promise<GraphHandle>;
  loadFromBuffer(graphId: string, buffer: Uint8Array, hmacKey?: Uint8Array): Promise<GraphHandle>;
  toBuffer(handle: GraphHandle, hmacKey?: Uint8Array): Promise<Uint8Array>;

  /** Append a single document and recover the new node IDs. Optional
   *  `opts.chunkSize` tunes how aggressively the doc is split into nodes;
   *  defaults to the SDK's 'balanced' preset when omitted. */
  appendDocument(handle: GraphHandle, input: AppendDocumentInput, opts?: AppendDocumentOptions): Promise<AppendDocumentResult>;

  /** Run the SDK reflection engine over the WHOLE built graph and return the
   *  contradictions it detects (it also writes `contradicts` edges into the
   *  graph as a side effect). Returns [] if the graph isn't built or has no
   *  TF-IDF index. Used by the brain engine's periodic contradiction scan. */
  reflectGraph(handle: GraphHandle): ContradictionResult[];

  query(handle: GraphHandle, query: string, k: number): Promise<QueryResult[]>;

  /**
   * Like `query()` but also returns the traversal's edge structure and a
   * `serialize()` closure for rich === KNOWLEDGE SUBGRAPH === rendering.
   * Use this in the recall path so the federation prompt carries relationship
   * context between nodes instead of flat bullet points.
   */
  queryRich(handle: GraphHandle, query: string, k: number): Promise<RichQueryResult>;

  applyCorrection(handle: GraphHandle, edit: CorrectionEdit): Promise<void>;

  /**
   * Create an undirected edge between two existing nodes. Used by the App's
   * "Link them" affordance when the user confirms two memories belong
   * together (the SDK has no public addEdge — we write directly to the
   * dual-graph's `undirectedEdges` map). Idempotent: if an edge of the
   * same type already exists between the two nodes, we no-op.
   */
  linkNodes(
    handle: GraphHandle,
    fromNodeId: string,
    toNodeId: string,
    opts?: { type?: UndirectedEdgeType; weight?: number; reason?: string },
  ): Promise<{ edgeId: string; created: boolean }>;

  /**
   * Create a DIRECTED edge between two existing nodes. Used by the App's
   * typed-relationship picker (e.g. user picks "Works at" → directed
   * `collaborated-on` from person → org with `evidence: "Works at"`).
   *
   * Order-sensitive dedupe — `(from, to, type)` is the identity. Reversing
   * `from`/`to` creates a different edge. Reverse-direction users want
   * "B reports-to A" should pass that explicit ordering.
   *
   * `evidence` is the SDK's existing free-form provenance field; we use
   * it to carry the human-friendly label (e.g. "Works at", "Lives in")
   * so the detail pane can render the user's vocabulary instead of the
   * structural SDK type.
   */
  linkNodesDirected(
    handle: GraphHandle,
    fromNodeId: string,
    toNodeId: string,
    opts: { type: DirectedEdgeType; weight?: number; evidence?: string },
  ): Promise<{ edgeId: string; created: boolean }>;

  /**
   * Post-ingest cross-document relink. Scans every active node pair
   * for entity overlap and creates `shares-entity` undirected edges
   * where they're missing. Also creates `same-person` edges between
   * nodes that share a person-shaped entity (capitalized multi-word).
   *
   * The SDK's `appendDocument` only links new chunks to OTHER new
   * chunks — never to existing nodes — so a freshly-remembered clip
   * stays orphan even when its entities are mentioned in older nodes.
   * This pass closes that gap.
   *
   * Throttled by `maxNodes`: skips entirely when the active node
   * count exceeds the cap (entity Jaccard is O(N²)). Returns the
   * list of newly-created edge ids + their endpoints so the host
   * can emit one op-log event per edge.
   */
  relinkFullGraph(
    handle: GraphHandle,
    opts?: { maxNodes?: number },
  ): Promise<{
    skipped: boolean;
    skipReason?: string;
    activeNodes: number;
    newEdges: Array<{
      edgeId: string;
      a: string;
      b: string;
      type: 'shares-entity' | 'same-person';
      weight: number;
      sharedEntities: string[];
    }>;
  }>;

  /** Build TF-IDF + structure. The adapter calls this internally before the first append on a fresh graph. */
  build(handle: GraphHandle): Promise<void>;

  /** Build embeddings with a cached local embed function. Caller passes (dimensions, id) for adapter provenance. */
  buildEmbeddings(handle: GraphHandle, opts: BuildEmbeddingsAdapterOpts): Promise<void>;

  /** All node IDs currently in the graph. Used by the host to diff append results. */
  allNodeIds(handle: GraphHandle): string[];

  /**
   * Ground-truth node info — includes soft-deleted (low-confidence) nodes.
   *
   * `section` and `nodeType` were added in the App's Path-1 refactor (the
   * deck/detail surface needs them to render a breadcrumb and to filter
   * structural-noise nodes like 'document' and 'section' out of the
   * review queue). They're nullable because not every ingest path
   * (clip:* sources, plain-text) sets them.
   *
   * `entities` exposes the SDK's per-node extracted entity strings
   * (proper nouns, dates, acronyms, technical terms, …) — used by the
   * App's entity-aware candidate ranking when surfacing "what other
   * memories mention this person/place/topic?". Empty array if the
   * node never went through entity extraction (rare).
   */
  inspectNodes(handle: GraphHandle): Array<{
    id: string;
    confidence: number;
    validUntil?: number;
    sourceFile: string;
    contentPreview: string;
    section?: string;
    nodeType?: string;
    entities?: string[];
  }>;

  /** inspectNodes restricted to a set of node ids — O(ids), not O(all). For the
   *  per-source live-ingest delta (push just the new source's nodes). */
  getNodesByIds(handle: GraphHandle, ids: string[]): Array<{
    id: string;
    confidence: number;
    validUntil?: number;
    sourceFile: string;
    contentPreview: string;
    section?: string;
    nodeType?: string;
    entities?: string[];
  }>;

  /** Release a graph's in-memory structures so the host can evict it and free
   *  the memory. After dispose() the handle must be dropped + reloaded on use. */
  dispose(handle: GraphHandle): void;

  /** Count nodes created at/after `sinceMs` (epoch ms) — vitality's recency
   *  signal, read from the in-memory graph (not the op-log). */
  countRecentNodes(handle: GraphHandle, sinceMs: number): number;

  /** Return the FULL (untruncated) content of a single node. Used for
   *  skill text reassembly where the 500-char inspectNodes preview was
   *  silently truncating goals + recipes off the tail end. */
  getFullNodeContent(handle: GraphHandle, nodeId: string): string | null;

  /** True if buildEmbeddings has run and the graph has an embedding index attached. */
  hasEmbeddings(handle: GraphHandle): boolean;

  /**
   * Remove a single edge by its ID. Works for both directed and
   * undirected edges — the implementation tries both maps. If the edge
   * is not found (already removed, wrong id) it returns `{ removed: false }`
   * rather than throwing so callers can treat it as idempotent.
   *
   * Primary use-case: the App's "change type" button first unlinks the
   * existing edge then re-links with the new type, so the old edge
   * doesn't linger alongside the new one.
   */
  unlinkEdge(
    handle: GraphHandle,
    edgeId: string,
  ): Promise<{ removed: boolean; wasDirected?: boolean }>;

  /**
   * Set the weight of an existing edge (directed or undirected) — the
   * primitive behind Deterministic Consolidation's connection reinforcement.
   * Tries the directed map first, then undirected. The new weight is
   * clamped to [0, 1]. Returns `{ ok: false }` when the edge id is not
   * found — idempotent, like `unlinkEdge`. `prevWeight` is the weight
   * before the change, for op-log auditing.
   */
  reweightEdge(
    handle: GraphHandle,
    edgeId: string,
    newWeight: number,
  ): Promise<{ ok: boolean; wasDirected?: boolean; prevWeight?: number }>;

  /**
   * Snapshot of the dual-graph's edges. Powers the Atlas visualization
   * and the detail pane's Connections section. `evidence` on directed
   * edges carries the user-chosen label when the edge was created via
   * `linkNodesDirected` (e.g. "Works at", "Lives in") — the App renders
   * that label in preference to a humanized SDK type.
   */
  inspectEdges(handle: GraphHandle): {
    directed: Array<{ id: string; from: string; to: string; type: DirectedEdgeType; weight: number; evidence?: string }>;
    undirected: Array<{ id: string; a: string; b: string; type: UndirectedEdgeType; weight: number }>;
  };

  /**
   * Returns the raw embedding vectors for all nodes that have been
   * embedded. Used by BrainEngine's duplicate scan (cosine similarity
   * between node pairs) and semantic synapse formation.
   *
   * Returns an empty map when the graph has no embedding index yet (i.e.
   * before the first `buildEmbeddings` call). Callers must handle the
   * empty-map case gracefully — the brain activities skip or no-op.
   */
  getNodeEmbeddings(handle: GraphHandle): Map<string, number[]>;
}

/**
 * The SDK's full edge-type catalogue. Re-exported through the adapter so the
 * App can render legends + filters without re-importing the SDK directly.
 */
export type DirectedEdgeType =
  | 'causes' | 'depends-on' | 'precedes' | 'contains' | 'defines' | 'cites'
  | 'contradicts' | 'supports' | 'supersedes' | 'discussed-in' | 'knows'
  | 'works-with' | 'reports-to' | 'collaborated-on' | 'prefers' | 'summarizes';

export type UndirectedEdgeType =
  | 'similar-to' | 'co-occurs' | 'shares-entity' | 'shares-topic'
  | 'same-source' | 'same-person' | 'related-to';
