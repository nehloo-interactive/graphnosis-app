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

export interface AppendDocumentResult {
  newNodeIds: string[];
  newNodes: number;
  contradictions: unknown[];
}

export interface QueryResult {
  nodeId: string;
  score: number;
  text: string;
  type?: string;
  source?: { file: string; line?: number; section?: string };
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

  /** Append a single document and recover the new node IDs. */
  appendDocument(handle: GraphHandle, input: AppendDocumentInput): Promise<AppendDocumentResult>;

  query(handle: GraphHandle, query: string, k: number): Promise<QueryResult[]>;

  applyCorrection(handle: GraphHandle, edit: CorrectionEdit): Promise<void>;

  /** Build TF-IDF + structure. The adapter calls this internally before the first append on a fresh graph. */
  build(handle: GraphHandle): Promise<void>;

  /** Build embeddings with a cached local embed function. Caller passes (dimensions, id) for adapter provenance. */
  buildEmbeddings(handle: GraphHandle, opts: { embed: EmbedFn; dimensions: number; id: string }): Promise<void>;

  /** All node IDs currently in the graph. Used by the host to diff append results. */
  allNodeIds(handle: GraphHandle): string[];

  /** Ground-truth node info — includes soft-deleted (low-confidence) nodes. */
  inspectNodes(handle: GraphHandle): Array<{ id: string; confidence: number; validUntil?: number; sourceFile: string; contentPreview: string }>;

  /** True if buildEmbeddings has run and the graph has an embedding index attached. */
  hasEmbeddings(handle: GraphHandle): boolean;
}
