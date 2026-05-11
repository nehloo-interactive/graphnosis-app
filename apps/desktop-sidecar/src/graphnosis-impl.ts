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
    // Build must have happened at least once before serializing.
    if (!h.built) h.instance.build(h.graphId);
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
    // Fresh graph: use add* (chainable) then build once. After that, every ingest is an append*.
    if (!h.built) {
      this.addPreBuild(h.instance, input);
      h.instance.build(h.graphId);
      h.built = true;
      const newNodeIds = nodeIdsBySource(h.instance, input.sourceRef);
      return { newNodeIds, newNodes: newNodeIds.length, contradictions: [] };
    }

    const before = new Set(h.instance.graph.nodes.keys());
    const result = await this.appendPostBuild(h.instance, input);
    const newNodeIds: string[] = [];
    for (const id of h.instance.graph.nodes.keys()) if (!before.has(id)) newNodeIds.push(id);
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

  inspectNodes(handle: GraphHandle): Array<{ id: string; confidence: number; validUntil?: number; sourceFile: string; contentPreview: string }> {
    const h = handle as Internal;
    if (!h.built) return [];
    const out: Array<{ id: string; confidence: number; validUntil?: number; sourceFile: string; contentPreview: string }> = [];
    for (const [id, n] of h.instance.graph.nodes) {
      out.push({
        id,
        confidence: n.confidence,
        ...(n.validUntil !== undefined ? { validUntil: n.validUntil } : {}),
        sourceFile: n.source.file,
        contentPreview: n.content.length > 120 ? n.content.slice(0, 117) + '…' : n.content,
      });
    }
    return out;
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
