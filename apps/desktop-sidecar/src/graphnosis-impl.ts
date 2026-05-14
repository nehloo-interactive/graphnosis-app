// Only file in the App that imports the `@nehloo/graphnosis` SDK directly.
// Verified against v0.2.3.

import { Graphnosis } from '@nehloo/graphnosis';
import type { EmbeddingAdapter, GraphNode, NodeId } from '@nehloo/graphnosis';
import type {
  GraphnosisAdapter,
  GraphHandle,
  AppendDocumentInput,
  AppendDocumentResult,
  QueryResult,
  CorrectionEdit,
} from './graphnosis-adapter.js';
import type { EmbedFn } from '@graphnosis-app/core/embeddings';

interface Internal extends GraphHandle {
  instance: Graphnosis;
  built: boolean;
}

export class GraphnosisImpl implements GraphnosisAdapter {
  async create(graphId: string): Promise<Internal> {
    return { graphId, instance: new Graphnosis({ name: graphId }), built: false };
  }

  async loadFromBuffer(graphId: string, buffer: Uint8Array, hmacKey?: Uint8Array): Promise<Internal> {
    const instance = new Graphnosis({ name: graphId });
    // The SDK's fromBuffer takes a Node Buffer and a fail-closed hmacKey policy.
    instance.fromBuffer(Buffer.from(buffer), hmacKey ? { hmacKey: Buffer.from(hmacKey) } : undefined);
    return { graphId, instance, built: true };
  }

  async toBuffer(handle: GraphHandle, hmacKey?: Uint8Array): Promise<Uint8Array> {
    const h = handle as Internal;
    // Build must have happened at least once before serializing. Critically,
    // we update h.built here too — previously we built the SDK graph but
    // forgot to flip our local flag, which left subsequent ingests routing
    // through addPreBuild and throwing for kinds (e.g. PDF) that don't have
    // a pre-build form.
    if (!h.built) {
      h.instance.build(h.graphId);
      h.built = true;
    }
    const buf = h.instance.toBuffer(hmacKey ? { hmacKey: Buffer.from(hmacKey) } : undefined);
    return new Uint8Array(buf);
  }

  async build(handle: GraphHandle): Promise<void> {
    const h = handle as Internal;
    h.instance.build(h.graphId);
    h.built = true;
  }

  async appendDocument(handle: GraphHandle, input: AppendDocumentInput): Promise<AppendDocumentResult> {
    const h = handle as Internal;
    // Fresh graph: most kinds use add* (chainable) then build once. PDF doesn't
    // have a pre-build form in the SDK, so for PDF specifically we build an
    // empty graph first and route through the post-build append path. This
    // makes "first file is a PDF" Just Work instead of throwing.
    if (!h.built) {
      if (input.kind === 'pdf') {
        h.instance.build(h.graphId);
        h.built = true;
        // Fall through to the post-build path below.
      } else {
        this.addPreBuild(h.instance, input);
        h.instance.build(h.graphId);
        h.built = true;
        const newNodeIds = nodeIdsBySource(h.instance, input.sourceRef);
        return { newNodeIds, newNodes: newNodeIds.length, contradictions: [] };
      }
    }

    const before = new Set(h.instance.graph.nodes.keys());
    let result = await this.appendPostBuild(h.instance, input);
    let newNodeIds: string[] = [];
    for (const id of h.instance.graph.nodes.keys()) if (!before.has(id)) newNodeIds.push(id);

    // Fallback: when `text` ingest produces no nodes (SDK's appendText doesn't
    // always emit nodes for structured short text with punctuation, URLs, etc.),
    // retry as markdown with a synthetic header derived from the source ref.
    // This keeps the "single-chunk" intent for clean prose but ensures nothing
    // silently fails — better a slightly noisier ingest than zero ingest.
    if (newNodeIds.length === 0 && input.kind === 'text' && typeof input.content === 'string') {
      const label = labelFromSourceRef(input.sourceRef);
      const wrapped = `# ${label}\n\n${input.content}`;
      const fallbackBefore = new Set(h.instance.graph.nodes.keys());
      result = h.instance.appendMarkdown(wrapped, input.sourceRef);
      for (const id of h.instance.graph.nodes.keys()) {
        if (!fallbackBefore.has(id)) newNodeIds.push(id);
      }
    }

    return { newNodeIds, newNodes: result.newNodes, contradictions: result.contradictions };
  }

  async query(handle: GraphHandle, query: string, k: number): Promise<QueryResult[]> {
    const h = handle as Internal;
    if (!h.built) h.instance.build(h.graphId);
    // Prefer hybrid (TF-IDF + embeddings) when an embedding index is attached — covers
    // semantic queries where the user's wording doesn't share tokens with the content.
    // Fall back to TF-IDF when no embeddings are available, or if hybrid throws (e.g.,
    // adapter id mismatch between cached and current embed function).
    const res = h.instance.hasEmbeddings()
      ? await h.instance.queryHybrid(query, { maxNodes: k }).catch((e: Error) => {
          console.error(`[graphnosis-sidecar] queryHybrid failed (${e.message}) — falling back to TF-IDF`);
          return h.instance.query(query, { maxNodes: k });
        })
      : h.instance.query(query, { maxNodes: k });
    return res.subgraph.nodes.map((n: GraphNode) => ({
      nodeId: n.id,
      // Seeds carry scores; non-seed expansion nodes don't. Look up if present, else 0.
      score: res.seeds.find((s: { nodeId: string; score: number }) => s.nodeId === n.id)?.score ?? 0,
      text: n.content,
      type: n.type,
      source: {
        file: n.source.file,
        ...(n.source.line !== undefined ? { line: n.source.line } : {}),
        ...(n.source.section !== undefined ? { section: n.source.section } : {}),
      },
    }));
  }

  async applyCorrection(handle: GraphHandle, edit: CorrectionEdit): Promise<void> {
    const h = handle as Internal;
    if (!h.built) h.instance.build(h.graphId);
    switch (edit.kind) {
      case 'edit':
        if (edit.content === undefined) throw new Error('edit requires content');
        h.instance.edit(edit.nodeId, edit.content, edit.reason);
        return;
      case 'supersede':
        if (edit.content === undefined) throw new Error('supersede requires content');
        h.instance.supersede(edit.nodeId, edit.content, edit.reason);
        return;
      case 'delete':
        h.instance.deleteNode(edit.nodeId, edit.reason);
        return;
    }
  }

  async buildEmbeddings(handle: GraphHandle, opts: { embed: EmbedFn; dimensions: number; id: string }): Promise<void> {
    const h = handle as Internal;
    if (!h.built) h.instance.build(h.graphId);
    const adapter: EmbeddingAdapter = {
      id: opts.id,
      dimensions: opts.dimensions,
      embed: async (texts: string[]) => Promise.all(texts.map(t => opts.embed(t))),
    };
    await h.instance.buildEmbeddings({ adapter });
  }

  allNodeIds(handle: GraphHandle): string[] {
    const h = handle as Internal;
    if (!h.built) return [];
    return [...h.instance.graph.nodes.keys()];
  }

  hasEmbeddings(handle: GraphHandle): boolean {
    const h = handle as Internal;
    return h.built && h.instance.hasEmbeddings();
  }

  inspectNodes(handle: GraphHandle): Array<{
    id: string;
    confidence: number;
    validUntil?: number;
    sourceFile: string;
    contentPreview: string;
    section?: string;
    nodeType?: string;
  }> {
    const h = handle as Internal;
    if (!h.built) return [];
    const out: Array<{
      id: string;
      confidence: number;
      validUntil?: number;
      sourceFile: string;
      contentPreview: string;
      section?: string;
      nodeType?: string;
    }> = [];
    for (const [id, n] of h.instance.graph.nodes) {
      const rec: {
        id: string;
        confidence: number;
        validUntil?: number;
        sourceFile: string;
        contentPreview: string;
        section?: string;
        nodeType?: string;
      } = {
        id,
        confidence: n.confidence,
        sourceFile: n.source.file,
        contentPreview: n.content.length > 120 ? n.content.slice(0, 117) + '…' : n.content,
      };
      if (n.validUntil !== undefined) rec.validUntil = n.validUntil;
      if (n.source.section) rec.section = n.source.section;
      if (n.type) rec.nodeType = n.type;
      out.push(rec);
    }
    return out;
  }

  /**
   * Snapshot every edge in the dual-graph. The SDK stores directed and
   * undirected edges separately (different semantics) so we keep that split
   * — the App's Atlas renders them differently (arrows vs lines).
   */
  inspectEdges(handle: GraphHandle): {
    directed: Array<{ id: string; from: string; to: string; type: ReturnType<GraphnosisImpl['_directedType']>; weight: number }>;
    undirected: Array<{ id: string; a: string; b: string; type: ReturnType<GraphnosisImpl['_undirectedType']>; weight: number }>;
  } {
    const h = handle as Internal;
    if (!h.built) return { directed: [], undirected: [] };
    const directed = [...h.instance.graph.directedEdges.entries()].map(([id, e]) => ({
      id,
      from: e.from,
      to: e.to,
      type: e.type,
      weight: e.weight,
    }));
    const undirected = [...h.instance.graph.undirectedEdges.entries()].map(([id, e]) => ({
      id,
      a: e.nodes[0],
      b: e.nodes[1],
      type: e.type,
      weight: e.weight,
    }));
    return { directed, undirected };
  }
  // Phantom methods purely to anchor the return-type inference for the
  // inspectEdges signature without re-importing the SDK types here.
  private _directedType(): import('@nehloo/graphnosis').DirectedEdge['type'] { throw new Error('phantom'); }
  private _undirectedType(): import('@nehloo/graphnosis').UndirectedEdge['type'] { throw new Error('phantom'); }

  /**
   * Add an undirected edge between two existing nodes. The SDK has no
   * public `addEdge`, so we write directly into `graph.undirectedEdges`.
   * Idempotent: if an edge of the same type already connects these two
   * nodes (in either order), we return the existing edge instead of
   * creating a duplicate.
   *
   * For the App's "Link them" workflow we default to `related-to` with
   * weight 0.7 — meaningful but below auto-extracted edges (which sit
   * at 0.85+), so manual links don't pollute the dominant-edge view.
   */
  async linkNodes(
    handle: GraphHandle,
    fromNodeId: string,
    toNodeId: string,
    opts: { type?: import('@nehloo/graphnosis').UndirectedEdge['type']; weight?: number; reason?: string } = {},
  ): Promise<{ edgeId: string; created: boolean }> {
    const h = handle as Internal;
    if (!h.built) {
      throw new Error('Cannot link nodes on an unbuilt graph');
    }
    if (fromNodeId === toNodeId) {
      throw new Error('Cannot link a node to itself');
    }
    if (!h.instance.graph.nodes.has(fromNodeId)) {
      throw new Error(`Node not found: ${fromNodeId}`);
    }
    if (!h.instance.graph.nodes.has(toNodeId)) {
      throw new Error(`Node not found: ${toNodeId}`);
    }
    const type = opts.type ?? 'related-to';
    // Dedupe: scan existing undirected edges for the same pair + type.
    // Order-independent (undirected) so both directions count as a match.
    for (const [eid, e] of h.instance.graph.undirectedEdges) {
      if (e.type !== type) continue;
      const [a, b] = e.nodes;
      if ((a === fromNodeId && b === toNodeId) || (a === toNodeId && b === fromNodeId)) {
        return { edgeId: eid, created: false };
      }
    }
    const edgeId = `e-link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    h.instance.graph.undirectedEdges.set(edgeId, {
      id: edgeId,
      nodes: [fromNodeId, toNodeId],
      type,
      weight: opts.weight ?? 0.7,
      createdAt: Date.now(),
    });
    return { edgeId, created: true };
  }

  // -- internals --

  private addPreBuild(g: Graphnosis, input: AppendDocumentInput): void {
    switch (input.kind) {
      case 'text':
        // Headerless prose → single-section wrap. Keeps "wife name Maria" as the searchable
        // node content instead of letting the markdown parser title-ify it as "Untitled".
        g.addText(asString(input.content), input.sourceRef);
        return;
      case 'markdown':
        g.addMarkdown(asString(input.content), input.sourceRef);
        return;
      case 'html':
        g.addHtml(asString(input.content), input.sourceRef);
        return;
      case 'json':
        g.addJson(asString(input.content), input.sourceRef);
        return;
      case 'csv':
        g.addCsv(asString(input.content), input.sourceRef);
        return;
      case 'pdf':
        // No pre-build addPdf in v0.2.3 — fall through to a post-build append.
        throw new Error('PDF ingest requires an already-built graph; ingest a markdown first or rebuild.');
    }
  }

  private async appendPostBuild(g: Graphnosis, input: AppendDocumentInput) {
    switch (input.kind) {
      case 'text':
        return g.appendText(asString(input.content), input.sourceRef);
      case 'markdown':
        return g.appendMarkdown(asString(input.content), input.sourceRef);
      case 'html':
        return g.appendHtml(asString(input.content), input.sourceRef);
      case 'json':
        return g.appendJson(asString(input.content), input.sourceRef);
      case 'csv':
        return g.appendCsv(asString(input.content), input.sourceRef);
      case 'pdf':
        return g.appendPdf(Buffer.from(input.content as Uint8Array), input.sourceRef);
    }
  }
}

function asString(c: string | Uint8Array): string {
  return typeof c === 'string' ? c : new TextDecoder().decode(c);
}

function nodeIdsBySource(g: Graphnosis, sourceRef: string): NodeId[] {
  const out: NodeId[] = [];
  for (const [id, n] of g.graph.nodes) {
    if (n.source.file === sourceRef) out.push(id);
  }
  return out;
}

// Recover a human-readable label from a sourceRef of shape "clip:<ts>:<label>"
// or fall back to the raw ref.
function labelFromSourceRef(sourceRef: string): string {
  const parts = sourceRef.split(':');
  if (parts.length >= 3 && parts[0] === 'clip') return parts.slice(2).join(':');
  return sourceRef;
}
