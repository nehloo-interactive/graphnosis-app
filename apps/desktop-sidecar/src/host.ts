import { promises as fs } from 'node:fs';
import path from 'node:path';
import { crypto, embeddings, federation, oplog, policy, sources, type DeviceId, type GraphId, type SourceRecord, type SubgraphBudget } from '@graphnosis-app/core';
import type { GraphnosisAdapter, GraphHandle, AppendDocumentInput, CorrectionEdit } from './graphnosis-adapter.js';

const { deriveKey, encrypt, decrypt } = crypto;
const { OpLogWriter } = oplog;
const { EmbeddingCache, cached, stubEmbed } = embeddings;
const { federatedQuery } = federation;
const { SourceIndex, makeSourceId, hashContent } = sources;

export interface HostOptions {
  vaultDir: string;
  deviceId: DeviceId;
  passphrase: string;
  adapter: GraphnosisAdapter;
  policy?: policy.PolicyConfig;
  embed?: embeddings.EmbedFn;
  /** Embedding model provenance — affects the on-disk vector index. Change the id if the model changes. */
  embedAdapterId?: string;
  embedDimensions?: number;
}

interface LoadedGraph {
  handle: GraphHandle;
  sourceIndex: sources.SourceIndex;
  cache: embeddings.EmbeddingCache;
  dirty: boolean;
}

// GraphnosisHost = the App's single integration point for the SDK.
// Owns encryption at rest, op-log emission, embedding cache, and the source index.
// Every mutation funnels through here so the op-log is the durable truth.
export class GraphnosisHost {
  private readonly key: Uint8Array;
  private readonly salt: Uint8Array;
  private readonly graphs = new Map<GraphId, LoadedGraph>();
  private readonly oplogWriter: oplog.OpLogWriter;
  private readonly policyCfg: policy.PolicyConfig;
  private readonly embed: embeddings.EmbedFn;
  private readonly embedAdapterId: string;
  private readonly embedDimensions: number;

  private constructor(
    private readonly opts: HostOptions,
    derived: crypto.DerivedKey,
  ) {
    this.key = derived.key;
    this.salt = derived.salt;
    this.oplogWriter = new OpLogWriter({
      dir: path.join(opts.vaultDir, 'oplog'),
      deviceId: opts.deviceId,
      key: this.key,
      salt: this.salt,
    });
    this.policyCfg = opts.policy ?? { defaultBudget: policy.DEFAULT_BUDGET, graphs: [] };
    this.embed = opts.embed ?? stubEmbed;
    this.embedAdapterId = opts.embedAdapterId ?? 'graphnosis-app:stub@384';
    this.embedDimensions = opts.embedDimensions ?? 384;
  }

  static async open(opts: HostOptions): Promise<GraphnosisHost> {
    await fs.mkdir(opts.vaultDir, { recursive: true });
    const saltPath = path.join(opts.vaultDir, 'salt.bin');
    let salt: Uint8Array | undefined;
    try {
      salt = new Uint8Array(await fs.readFile(saltPath));
    } catch {
      // first run: derive without explicit salt, persist it
    }
    const derived = await deriveKey(opts.passphrase, salt);
    if (!salt) await fs.writeFile(saltPath, Buffer.from(derived.salt));
    return new GraphnosisHost(opts, derived);
  }

  listGraphs(): GraphId[] {
    return [...this.graphs.keys()];
  }

  /** Canonical on-disk path for a graph. New saves always go here (.gai). */
  private graphPath(graphId: GraphId): string {
    return path.join(this.opts.vaultDir, 'graphs', `${graphId}.gai`);
  }

  /** Legacy path from pre-0.2.6 vaults (the App wrote .aikg). Used as a
   * read-time fallback so existing user vaults keep working. */
  private legacyGraphPath(graphId: GraphId): string {
    return path.join(this.opts.vaultDir, 'graphs', `${graphId}.aikg`);
  }

  private bundlePath(graphId: GraphId): string {
    return path.join(this.opts.vaultDir, 'graphs', `${graphId}.bundle`);
  }

  private cachePath(graphId: GraphId): string {
    return path.join(this.opts.vaultDir, 'graphs', `${graphId}.embcache`);
  }

  async createGraph(graphId: GraphId): Promise<void> {
    if (this.graphs.has(graphId)) throw new Error(`Graph ${graphId} already loaded`);
    const handle = await this.opts.adapter.create(graphId);
    const cache = new EmbeddingCache({ path: this.cachePath(graphId), key: this.key, salt: this.salt });
    this.graphs.set(graphId, {
      handle,
      sourceIndex: new SourceIndex(),
      cache,
      dirty: true,
    });
    await this.save(graphId);
  }

  async loadGraph(graphId: GraphId): Promise<void> {
    if (this.graphs.has(graphId)) return;
    // Prefer the canonical .gai path; fall back to the legacy .aikg path so
    // vaults created before 0.2.6 keep loading. The next `save()` will write
    // the .gai file (and we can clean up the .aikg later if both exist).
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.graphPath(graphId));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
      bytes = await fs.readFile(this.legacyGraphPath(graphId));
      console.error(`[graphnosis-host] loaded legacy ${graphId}.aikg — will migrate to .gai on next save`);
    }
    const aikgPlain = await decrypt(new Uint8Array(bytes), this.key);
    // Inner SDK HMAC key (independent of outer encryption) — derived from data key + a fixed label.
    const hmacKey = this.key;
    const handle = await this.opts.adapter.loadFromBuffer(graphId, aikgPlain, hmacKey);
    const sourceIndex = await this.loadBundle(graphId);
    const cache = new EmbeddingCache({ path: this.cachePath(graphId), key: this.key, salt: this.salt });
    await cache.load();
    this.graphs.set(graphId, { handle, sourceIndex, cache, dirty: false });

    // SDK doesn't persist embeddings with .aikg — rebuild from cache (fast if warm,
    // re-embeds from scratch if cache is empty / model changed). Without this, queryHybrid
    // would have no index to consult and we'd silently fall back to TF-IDF.
    try {
      await this.opts.adapter.buildEmbeddings(handle, {
        embed: cached(this.embed, cache),
        dimensions: this.embedDimensions,
        id: this.embedAdapterId,
      });
    } catch (e) {
      console.error(`[graphnosis-host] could not build embeddings on load for ${graphId}: ${(e as Error).message} — query will use TF-IDF only.`);
    }
  }

  private async loadBundle(graphId: GraphId): Promise<sources.SourceIndex> {
    try {
      const buf = await fs.readFile(this.bundlePath(graphId));
      const pt = await decrypt(new Uint8Array(buf), this.key);
      const records = JSON.parse(new TextDecoder().decode(pt)) as SourceRecord[];
      return SourceIndex.fromJSON(records);
    } catch {
      return new SourceIndex();
    }
  }

  async save(graphId: GraphId): Promise<void> {
    const g = this.must(graphId);
    if (!g.dirty) return;
    await fs.mkdir(path.dirname(this.graphPath(graphId)), { recursive: true });
    const buf = await this.opts.adapter.toBuffer(g.handle, this.key);
    const ct = await encrypt(buf, this.key, this.salt);
    await fs.writeFile(this.graphPath(graphId), Buffer.from(ct));
    // Migrate legacy: if a .aikg file from a pre-0.2.6 vault still exists
    // alongside the new .gai we just wrote, remove it now that we've
    // successfully persisted the canonical file.
    try { await fs.unlink(this.legacyGraphPath(graphId)); } catch { /* no legacy file */ }
    const bundleCt = await encrypt(
      new TextEncoder().encode(JSON.stringify(g.sourceIndex.toJSON())),
      this.key,
      this.salt,
    );
    await fs.writeFile(this.bundlePath(graphId), Buffer.from(bundleCt));
    await g.cache.save();
    g.dirty = false;
  }

  async ingest(
    graphId: GraphId,
    kind: SourceRecord['kind'],
    ref: string,
    input: AppendDocumentInput,
  ): Promise<SourceRecord> {
    const g = this.must(graphId);
    const sourceId = makeSourceId(kind, ref);
    const result = await this.opts.adapter.appendDocument(g.handle, input);
    if (result.newNodeIds.length === 0) {
      // Hard fail rather than create an orphan source record. The MCP layer surfaces
      // this as an error to the AI client so the user sees the failure instead of
      // a misleading "Saved" success message.
      throw new Error(
        `Ingest produced 0 nodes for source ${sourceId} (kind=${input.kind}). ` +
        `The content may be empty, dedup-collided with existing nodes, or hit a parser edge case. ` +
        `Try rephrasing the note or saving smaller pieces.`,
      );
    }
    await this.opts.adapter.buildEmbeddings(g.handle, {
      embed: cached(this.embed, g.cache),
      dimensions: this.embedDimensions,
      id: this.embedAdapterId,
    });

    const record: SourceRecord & { contradictions?: unknown[] } = {
      sourceId,
      kind,
      ref,
      ingestedAt: Date.now(),
      graphId,
      nodeIds: result.newNodeIds,
      contentHash: hashContent(input.content),
      ...(result.contradictions.length > 0 ? { contradictions: result.contradictions } : {}),
    };
    g.sourceIndex.add(record);
    g.dirty = true;

    this.oplogWriter.emit({
      graphId,
      op: 'ingestSource',
      target: { kind: 'source', id: sourceId },
      after: record,
    });
    for (const nodeId of result.newNodeIds) {
      this.oplogWriter.emit({
        graphId,
        op: 'addNode',
        target: { kind: 'node', id: nodeId },
        after: { sourceId },
      });
    }
    await this.save(graphId);
    return record;
  }

  async forgetSource(graphId: GraphId, sourceId: string): Promise<{ nodeIds: string[] }> {
    const g = this.must(graphId);
    const nodeIds = g.sourceIndex.forget(sourceId);
    for (const nodeId of nodeIds) {
      // Soft-delete in Graphnosis: node stays for audit, confidence drops, won't be returned by queries.
      await this.opts.adapter.applyCorrection(g.handle, { kind: 'delete', nodeId, reason: `forget source ${sourceId}` });
      this.oplogWriter.emit({
        graphId,
        op: 'deleteNode',
        target: { kind: 'node', id: nodeId },
        before: { sourceId },
      });
    }
    this.oplogWriter.emit({
      graphId,
      op: 'forgetSource',
      target: { kind: 'source', id: sourceId },
    });
    g.dirty = true;
    await this.save(graphId);
    return { nodeIds };
  }

  async recall(query: string, opts?: { budget?: SubgraphBudget }): Promise<federation.FederatedSubgraph> {
    const runner: federation.FederatedQueryRunner = {
      runQuery: async (graphId, q, k) => {
        const g = this.must(graphId);
        const raw = await this.opts.adapter.query(g.handle, q, k);
        return raw.map(r => ({ graphId, nodeId: r.nodeId, score: r.score, text: r.text, ...(r.type !== undefined ? { type: r.type } : {}) }));
      },
    };
    return federatedQuery(runner, this.listGraphs(), query, this.policyCfg, opts?.budget);
  }

  // Correction model mirrors the SDK: content-only edits with a reason; deletes are soft.
  // - `edit`      : replace content in place
  // - `supersede` : create a new node with new content, link old→new, soft-delete old
  // - `delete`    : soft-delete
  // - `adds`      : ingest fresh content as new source-less nodes (used when the correction
  //                 is "you also remember X" rather than "X was wrong")
  async applyCorrection(
    graphId: GraphId,
    patches: { adds?: AppendDocumentInput[]; edits?: CorrectionEdit[] },
  ): Promise<void> {
    const g = this.must(graphId);
    for (const add of patches.adds ?? []) {
      const result = await this.opts.adapter.appendDocument(g.handle, add);
      for (const n of result.newNodeIds) {
        this.oplogWriter.emit({
          graphId,
          op: 'addNode',
          target: { kind: 'node', id: n },
          after: { ref: add.sourceRef },
        });
      }
    }
    for (const edit of patches.edits ?? []) {
      await this.opts.adapter.applyCorrection(g.handle, edit);
      this.oplogWriter.emit({
        graphId,
        op: edit.kind === 'delete' ? 'deleteNode' : edit.kind === 'supersede' ? 'supersede' : 'editNode',
        target: { kind: 'node', id: edit.nodeId },
        after: edit.kind === 'delete' ? undefined : { content: edit.content, reason: edit.reason },
      });
    }
    g.dirty = true;
    await this.save(graphId);
  }

  /**
   * Ground-truth inspection across all loaded graphs — includes soft-deleted nodes
   * (the ones recall hides because confidence dropped). Used by the `stats` MCP tool
   * and the future desktop inspector to debug "where did my nodes go?" moments.
   */
  stats(): { graphs: Array<{ graphId: GraphId; totalNodes: number; activeNodes: number; softDeletedNodes: number; sources: number; nodes: ReturnType<GraphnosisAdapter['inspectNodes']> }> } {
    const out = [];
    for (const [graphId, g] of this.graphs) {
      const nodes = this.opts.adapter.inspectNodes(g.handle);
      const active = nodes.filter(n => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > Date.now()));
      out.push({
        graphId,
        totalNodes: nodes.length,
        activeNodes: active.length,
        softDeletedNodes: nodes.length - active.length,
        sources: g.sourceIndex.list().length,
        nodes,
      });
    }
    return { graphs: out };
  }

  listSources(graphId?: GraphId): SourceRecord[] {
    if (!graphId) {
      const all: SourceRecord[] = [];
      for (const g of this.graphs.values()) all.push(...g.sourceIndex.list());
      return all;
    }
    return this.must(graphId).sourceIndex.list();
  }

  private must(graphId: GraphId): LoadedGraph {
    const g = this.graphs.get(graphId);
    if (!g) throw new Error(`Graph not loaded: ${graphId}`);
    return g;
  }
}
