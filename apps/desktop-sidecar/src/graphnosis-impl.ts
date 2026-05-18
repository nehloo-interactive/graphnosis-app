// Only file in the App that imports the `@nehloo/graphnosis` SDK directly.
// Verified against v0.2.3.

import { Graphnosis } from '@nehloo/graphnosis';
import type { EmbeddingAdapter, GraphNode, NodeId } from '@nehloo/graphnosis';
import type {
  GraphnosisAdapter,
  GraphHandle,
  AppendDocumentInput,
  AppendDocumentOptions,
  AppendDocumentResult,
  BuildEmbeddingsAdapterOpts,
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

  async appendDocument(handle: GraphHandle, input: AppendDocumentInput, opts: AppendDocumentOptions = {}): Promise<AppendDocumentResult> {
    const h = handle as Internal;
    // Fresh graph: most kinds use add* (chainable) then build once. PDF doesn't
    // have a pre-build form in the SDK, so for PDF specifically we build an
    // empty graph first and route through the post-build append path. This
    // makes "first file is a PDF" Just Work instead of throwing.
    //
    // chunkSize: only the post-build path can honor it (the SDK's `addX`
    // pre-build chainables don't take chunk options yet). For pre-build
    // we route through `addX` → `build()`, which uses the SDK's default
    // chunking. Acceptable tradeoff: pre-build only runs on the very
    // first append to a fresh graph; all subsequent appends use the
    // chunk-aware post-build path.
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
    let result = await this.appendPostBuild(h.instance, input, opts);
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
      const fallbackOpts = opts.chunkSize ? { chunkSize: opts.chunkSize } : undefined;
      result = h.instance.appendMarkdown(wrapped, input.sourceRef, fallbackOpts);
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

  async buildEmbeddings(handle: GraphHandle, opts: BuildEmbeddingsAdapterOpts): Promise<void> {
    const h = handle as Internal;
    if (!h.built) h.instance.build(h.graphId);
    const adapter: EmbeddingAdapter = {
      id: opts.id,
      dimensions: opts.dimensions,
      embed: async (texts: string[]) => Promise.all(texts.map(t => opts.embed(t))),
    };
    // Pass batchSize through to the SDK. The SDK accepts either a number
    // or a preset string ('small' | 'medium' | 'large' | 'auto') and
    // resolves the preset to a numeric items-per-call internally.
    await h.instance.buildEmbeddings(
      opts.batchSize !== undefined
        ? { adapter, batchSize: opts.batchSize }
        : { adapter },
    );
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
    entities?: string[];
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
      entities?: string[];
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
        entities?: string[];
      } = {
        id,
        confidence: n.confidence,
        sourceFile: n.source.file,
        contentPreview: n.content.length > 120 ? n.content.slice(0, 117) + '…' : n.content,
      };
      if (n.validUntil !== undefined) rec.validUntil = n.validUntil;
      if (n.source.section) rec.section = n.source.section;
      if (n.type) rec.nodeType = n.type;
      // Pass the SDK's extracted entities through. Used by the App's
      // entity-aware candidate ranking + the deck's "connect" cards
      // ("This memory mentions {entity} — connect to other memories
      // where it appears?"). Empty array is fine for the App's Jaccard
      // calculation; we only attach the field when there's something.
      if (n.entities && n.entities.length > 0) rec.entities = n.entities;
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
    directed: Array<{ id: string; from: string; to: string; type: ReturnType<GraphnosisImpl['_directedType']>; weight: number; evidence?: string }>;
    undirected: Array<{ id: string; a: string; b: string; type: ReturnType<GraphnosisImpl['_undirectedType']>; weight: number }>;
  } {
    const h = handle as Internal;
    if (!h.built) return { directed: [], undirected: [] };
    const directed = [...h.instance.graph.directedEdges.entries()].map(([id, e]) => {
      const rec: { id: string; from: string; to: string; type: ReturnType<GraphnosisImpl['_directedType']>; weight: number; evidence?: string } = {
        id,
        from: e.from,
        to: e.to,
        type: e.type,
        weight: e.weight,
      };
      // Pass through the user-chosen label (set by linkNodesDirected).
      // Auto-extracted edges typically don't set evidence; the App
      // falls back to a humanized SDK type for those.
      if (e.evidence) rec.evidence = e.evidence;
      return rec;
    });
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
    // Keep the metadata count fresh — the gai-writer reads this when
    // serializing, and the pruner only resets it on optimize. Before this
    // fix every manual link left the count stale until the next optimize
    // pass; downstream stats under-reported edge counts.
    if (h.instance.graph.metadata) {
      h.instance.graph.metadata.undirectedEdgeCount = h.instance.graph.undirectedEdges.size;
    }
    return { edgeId, created: true };
  }

  /**
   * Add a DIRECTED edge between two existing nodes. Mirror of `linkNodes`
   * but writes to `graph.directedEdges`. Order-sensitive dedupe on
   * `(from, to, type)` — reversed direction is a different edge.
   *
   * `evidence` carries the user-friendly label ("Works at", "Lives in"
   * etc.) so the App can render the user's vocabulary in the detail
   * pane instead of the structural SDK type.
   */
  async linkNodesDirected(
    handle: GraphHandle,
    fromNodeId: string,
    toNodeId: string,
    opts: { type: import('@nehloo/graphnosis').DirectedEdge['type']; weight?: number; evidence?: string },
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
    const { type } = opts;
    // Dedupe order-sensitively — directed `(A → B knows)` is distinct
    // from `(B → A knows)` and from `(A → B works-with)`. If the user
    // clicks Connect twice on the same row we no-op.
    for (const [eid, e] of h.instance.graph.directedEdges) {
      if (e.from === fromNodeId && e.to === toNodeId && e.type === type) {
        return { edgeId: eid, created: false };
      }
    }
    const edgeId = `e-dlink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const rec: import('@nehloo/graphnosis').DirectedEdge = {
      id: edgeId,
      from: fromNodeId,
      to: toNodeId,
      type,
      weight: opts.weight ?? 0.7,
      createdAt: Date.now(),
    };
    if (opts.evidence) rec.evidence = opts.evidence;
    h.instance.graph.directedEdges.set(edgeId, rec);
    if (h.instance.graph.metadata) {
      h.instance.graph.metadata.directedEdgeCount = h.instance.graph.directedEdges.size;
    }
    return { edgeId, created: true };
  }

  /**
   * Remove a single edge by its ID. Tries directed edges first, then
   * undirected. Returns `{ removed: false }` if the edge is not found
   * rather than throwing — callers can treat this as idempotent.
   */
  async unlinkEdge(
    handle: GraphHandle,
    edgeId: string,
  ): Promise<{ removed: boolean; wasDirected?: boolean }> {
    const h = handle as Internal;
    if (h.instance.graph.directedEdges.has(edgeId)) {
      h.instance.graph.directedEdges.delete(edgeId);
      if (h.instance.graph.metadata) {
        h.instance.graph.metadata.directedEdgeCount = h.instance.graph.directedEdges.size;
      }
      return { removed: true, wasDirected: true };
    }
    if (h.instance.graph.undirectedEdges.has(edgeId)) {
      h.instance.graph.undirectedEdges.delete(edgeId);
      if (h.instance.graph.metadata) {
        h.instance.graph.metadata.undirectedEdgeCount = h.instance.graph.undirectedEdges.size;
      }
      return { removed: true, wasDirected: false };
    }
    return { removed: false };
  }

  /**
   * Cross-document entity-overlap relink. See adapter interface comment
   * for context. Logic:
   *   1. Snapshot every ACTIVE node's entity set.
   *   2. For each pair (i < j), compute the entity Jaccard.
   *   3. If Jaccard ≥ 0.2 AND no existing `shares-entity` edge between
   *      them, add one (weight scaled by overlap strength).
   *   4. For pairs sharing a person-shaped entity (2+ capitalized
   *      words, no digits, not ACRONYM), add a `same-person` edge.
   *      Dedupe by `(nodes, type)`.
   *
   * Pure mutation of `graph.undirectedEdges`. The host calls this
   * post-append and emits one op-log event per new edge for audit /
   * recovery.
   */
  async relinkFullGraph(
    handle: GraphHandle,
    opts: { maxNodes?: number } = {},
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
  }> {
    const h = handle as Internal;
    if (!h.built) {
      return { skipped: true, skipReason: 'graph not built', activeNodes: 0, newEdges: [] };
    }
    const maxNodes = opts.maxNodes ?? 5000;
    // 0 means "disabled" — the user (or default) opted out of post-ingest
    // cross-doc linking. Honor it.
    if (maxNodes === 0) {
      return { skipped: true, skipReason: 'auto-relink disabled (maxNodes=0)', activeNodes: 0, newEdges: [] };
    }
    const now = Date.now();
    // Snapshot active nodes + their entity sets. Skip soft-deleted +
    // structural-noise (document/section) nodes — these are graph
    // chrome and don't carry user-meaningful entities.
    interface NodeSnap {
      id: string;
      entitiesLower: Set<string>;
      personEntities: string[];
    }
    const snaps: NodeSnap[] = [];
    for (const [id, n] of h.instance.graph.nodes) {
      if (n.confidence <= 0.2) continue;
      if (n.validUntil !== undefined && n.validUntil < now) continue;
      if (n.type === 'document' || n.type === 'section') continue;
      const rawEnts = n.entities ?? [];
      if (rawEnts.length === 0) continue;
      const lower = new Set(rawEnts.map((e) => e.toLowerCase()));
      const personEnts = rawEnts.filter(isPersonLikeEntity);
      snaps.push({ id, entitiesLower: lower, personEntities: personEnts });
    }
    if (snaps.length > maxNodes) {
      return {
        skipped: true,
        skipReason: `active node count ${snaps.length} > maxNodes ${maxNodes}`,
        activeNodes: snaps.length,
        newEdges: [],
      };
    }
    if (snaps.length < 2) {
      return { skipped: true, skipReason: 'fewer than 2 candidate nodes', activeNodes: snaps.length, newEdges: [] };
    }

    // Index existing undirected edges by an unordered pair key so the
    // O(N²) scan can check "does this pair already have an edge of
    // this type?" in O(1). Pair key uses sorted ids.
    const existing = new Map<string, Set<string>>(); // pairKey → set of types
    const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (const [, e] of h.instance.graph.undirectedEdges) {
      const [a, b] = e.nodes;
      const k = pairKey(a, b);
      const set = existing.get(k) ?? new Set<string>();
      set.add(e.type);
      existing.set(k, set);
    }
    // The newly-added edges we'll return to the host so it can emit op-log entries.
    const newEdges: Array<{
      edgeId: string;
      a: string;
      b: string;
      type: 'shares-entity' | 'same-person';
      weight: number;
      sharedEntities: string[];
    }> = [];

    const addEdge = (
      a: string,
      b: string,
      type: 'shares-entity' | 'same-person',
      weight: number,
      sharedEntities: string[],
    ): void => {
      const k = pairKey(a, b);
      const types = existing.get(k);
      if (types?.has(type)) return; // already linked with this type
      const edgeId = `e-relink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      h.instance.graph.undirectedEdges.set(edgeId, {
        id: edgeId,
        nodes: [a, b],
        type,
        weight,
        createdAt: Date.now(),
      });
      const nextTypes = types ?? new Set<string>();
      nextTypes.add(type);
      existing.set(k, nextTypes);
      newEdges.push({ edgeId, a, b, type, weight, sharedEntities });
    };

    // Main O(N²) scan. snaps is capped by maxNodes above, so this is
    // bounded. For N=5000 worst case = 12.5M comparisons, each a small
    // Set lookup — finishes in under a second on a modern machine.
    for (let i = 0; i < snaps.length; i++) {
      const si = snaps[i];
      if (!si) continue;
      for (let j = i + 1; j < snaps.length; j++) {
        const sj = snaps[j];
        if (!sj) continue;
        // Jaccard on lowercased entities. We compute intersection +
        // union sizes directly (faster than allocating temporary sets).
        const aSet = si.entitiesLower;
        const bSet = sj.entitiesLower;
        const small = aSet.size <= bSet.size ? aSet : bSet;
        const large = small === aSet ? bSet : aSet;
        let inter = 0;
        const sharedLower: string[] = [];
        for (const e of small) {
          if (large.has(e)) {
            inter++;
            sharedLower.push(e);
          }
        }
        if (inter === 0) continue;
        // Hybrid threshold — Jaccard alone punishes short clips: a
        // remember-clip with {NYFA} vs a file with {NYFA + 12 others}
        // scores Jaccard = 1/13 = 0.077, below the SDK's 0.2 cutoff
        // even though the link is obvious. We OR-in containment
        // (intersection / shorter-set-size) which captures the
        // "all of the short clip's entities are in this longer doc"
        // case cleanly. Either signal at meaningful strength → link.
        const union = aSet.size + bSet.size - inter;
        const jaccard = inter / union;
        const containment = inter / Math.min(aSet.size, bSet.size);
        // Require at least 1 shared entity AND (decent containment
        // OR mild Jaccard). The containment ≥ 0.5 rule fires for
        // small-overlap-but-meaningful clips; the Jaccard ≥ 0.15
        // rule fires for two longish docs with sustained overlap.
        if (containment >= 0.5 || jaccard >= 0.15) {
          // Weight scaled by the strongest signal — favors high
          // containment for short clips, high Jaccard for long
          // docs. Capped at 0.85 so auto links visually sit
          // below SDK-auto-extracted edges (which sit at 0.85+).
          const strength = Math.max(jaccard, containment * 0.6);
          const weight = Math.min(0.85, 0.45 + strength * 0.55);
          addEdge(si.id, sj.id, 'shares-entity', weight, sharedLower);
        }
        // Person-bridge: if any person-shaped entity (2+ capitalized
        // words, not acronym, no digits) appears in both nodes, add
        // `same-person`. Independent of the threshold above — even a
        // single shared person name is a strong signal. NOTE: single-
        // word names like "Stela" don't trigger this path (need 2+
        // words); they still get caught by the shares-entity rule
        // above when there's any meaningful overlap.
        if (si.personEntities.length > 0 && sj.personEntities.length > 0) {
          const sharedPersons: string[] = [];
          for (const p of si.personEntities) {
            const pLower = p.toLowerCase();
            if (sj.entitiesLower.has(pLower)) sharedPersons.push(p);
          }
          if (sharedPersons.length > 0) {
            addEdge(si.id, sj.id, 'same-person', 0.75, sharedPersons);
          }
        }
      }
    }

    // Keep metadata count fresh — the gai-writer reads it.
    if (h.instance.graph.metadata) {
      h.instance.graph.metadata.undirectedEdgeCount = h.instance.graph.undirectedEdges.size;
    }
    return { skipped: false, activeNodes: snaps.length, newEdges };
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

  private async appendPostBuild(g: Graphnosis, input: AppendDocumentInput, opts: AppendDocumentOptions = {}) {
    // SDK accepts `{ chunkSize: ChunkSizePreset }` as the 3rd arg of every
    // append* sugar method. Pass undefined when the user hasn't set a
    // preset so the SDK falls back to its 'balanced' default.
    const ingestOpts = opts.chunkSize ? { chunkSize: opts.chunkSize } : undefined;
    switch (input.kind) {
      case 'text':
        return g.appendText(asString(input.content), input.sourceRef, ingestOpts);
      case 'markdown':
        return g.appendMarkdown(asString(input.content), input.sourceRef, ingestOpts);
      case 'html':
        return g.appendHtml(asString(input.content), input.sourceRef, ingestOpts);
      case 'json':
        return g.appendJson(asString(input.content), input.sourceRef, ingestOpts);
      case 'csv':
        return g.appendCsv(asString(input.content), input.sourceRef, ingestOpts);
      case 'pdf':
        return g.appendPdf(Buffer.from(input.content as Uint8Array), input.sourceRef, ingestOpts);
    }
  }
}

function asString(c: string | Uint8Array): string {
  return typeof c === 'string' ? c : new TextDecoder().decode(c);
}

/**
 * Heuristic person-shape classifier — mirrors the one in the App-side
 * suggestion panel so the relink pass and the user-facing review deck
 * use consistent signals. Person-like = 2+ capitalized words, no digits,
 * no dot-notation, not an ALL-CAPS acronym, length 4–60.
 */
function isPersonLikeEntity(e: string): boolean {
  if (!e || e.length < 4 || e.length > 60) return false;
  if (/\d/.test(e)) return false;
  if (e.includes('.')) return false;
  if (e === e.toUpperCase() && e.length < 10) return false; // ACRONYM
  const words = e.split(/\s+/);
  if (words.length < 2) return false;
  return words.every((w) => /^[A-ZÀ-Ý][a-zà-ÿ'-]+/.test(w));
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
