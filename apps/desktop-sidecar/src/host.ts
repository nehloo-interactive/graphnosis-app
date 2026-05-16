import { promises as fs } from 'node:fs';
import path from 'node:path';
import { crypto, embeddings, federation, oplog, policy, settings as settingsMod, sources, type DeviceId, type GraphId, type SourceRecord, type SubgraphBudget } from '@graphnosis-app/core';
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

export type RecoveryStatus =
  | 'pending'
  | 'recoverable'              // file still exists on disk at the recorded ref
  | 'recoverable-from-cache'   // content blob exists in <vault>/content/
  | 'already-present'
  | 'file-missing'
  | 'url-refetch-not-implemented'
  | 'content-not-in-oplog';

/**
 * Format of a cached content blob (before encryption). We prepend a small
 * JSON header so recovery knows how to re-ingest (parser kind, mime, original
 * ref). Layout: [u32 header-len, LE] [header JSON bytes] [raw content bytes].
 */
interface ContentCacheHeader {
  kind: 'file' | 'url' | 'ai-conversation' | 'clip';
  ref: string;
  // The Graphnosis parser kind we'd hand to appendDocument on recovery.
  // Mirrors AppendDocumentInput['kind'] in graphnosis-adapter.ts.
  docKind: 'markdown' | 'html' | 'json' | 'csv' | 'pdf' | 'text';
  originalSize: number;
  contentHash?: string;
  cachedAt: number;
}

export interface RecoveryPlanItem {
  sourceId: string;
  graphId: GraphId;
  kind: 'file' | 'url' | 'ai-conversation' | 'clip';
  ref: string;
  contentHash?: string;
  ingestedAt: number;
  status: RecoveryStatus;
}

export interface RecoveryPlan {
  total: number;
  recoverable: number;
  items: RecoveryPlanItem[];
}

export interface RecoveryOutcome {
  sourceId: string;
  ref: string;
  ok: boolean;
  error?: string;
  /** Set when we intentionally didn't re-ingest (e.g., already in the graph). */
  skipped?: 'already-present';
}

export interface PurgeError {
  sourceId: string;
  ref: string;
  error: string;
}

export interface PurgeReport {
  beforeTotalNodes: number;
  beforeActiveNodes: number;
  beforeSoftDeletedNodes: number;
  afterTotalNodes: number;
  sourcesRebuilt: number;
  sourcesSkipped: number;
  errors: PurgeError[];
  /** True when there was nothing soft-deleted to purge — the graph wasn't touched. */
  noop?: boolean;
  /** True when phase 1 found unrecoverable sources and we refused to rebuild. */
  aborted?: boolean;
}

export interface RecoveryReport {
  attempted: number;
  recovered: number;
  skipped: number;
  failed: number;
  outcomes: RecoveryOutcome[];
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
  /**
   * Running count of user-initiated corrections per graph. Counts ONLY
   * `editNode` and `supersede` op-log events — these come exclusively from
   * the correction pipeline. Skips `deleteNode` because that op can also
   * come from forgetSource cascades, which would inflate the metric.
   * Populated from the op-log on loadGraph; bumped on applyCorrection.
   */
  private readonly correctionsCount = new Map<GraphId, number>();
  private readonly oplogWriter: oplog.OpLogWriter;
  private readonly policyCfg: policy.PolicyConfig;
  private readonly embed: embeddings.EmbedFn;
  private readonly embedAdapterId: string;
  private readonly embedDimensions: number;
  private settings: settingsMod.AppSettings;

  private constructor(
    private readonly opts: HostOptions,
    derived: crypto.DerivedKey,
    settings: settingsMod.AppSettings,
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
    this.settings = settings;
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
    const settings = await settingsMod.loadSettings(opts.vaultDir);
    return new GraphnosisHost(opts, derived, settings);
  }

  // ── Settings ────────────────────────────────────────────────────────────

  getSettings(): settingsMod.AppSettings {
    return this.settings;
  }

  // ── Search ──────────────────────────────────────────────────────────────
  //
  // Single-graph semantic search, used by the Nodes view in the App. Calls
  // the SDK's hybrid query (TF-IDF + BGE embeddings — whichever the host
  // booted with) and returns flat top-k results. Distinct from `recall()`,
  // which federates across graphs and applies a subgraph token budget.

  async searchNodes(graphId: GraphId, query: string, k = 30): Promise<Array<{ nodeId: string; score: number; text: string; type?: string }>> {
    const g = this.must(graphId);
    // Over-fetch and filter against the active set, then trim. The SDK's
    // hybrid query returns soft-deleted nodes alongside active ones — we
    // must not surface those to the user / AI client. 3× over-fetch is a
    // pragmatic heuristic: enough to recover real top-k after dropping
    // forgotten matches, without making queries quadratic.
    const active = this.activeNodeIds(graphId);
    const raw = await this.opts.adapter.query(g.handle, query, k * 3);
    return raw
      .filter((r) => active.has(r.nodeId))
      .slice(0, k)
      .map((r) => ({
        nodeId: r.nodeId,
        score: r.score,
        text: r.text,
        ...(r.type !== undefined ? { type: r.type } : {}),
      }));
  }

  /**
   * Set of currently-active node IDs for a graph. "Active" matches the
   * inspector's definition: confidence > 0.2 AND validUntil is unset or in
   * the future. Used to drop soft-deleted nodes from `recall` and `search`
   * results, which the SDK's hybrid query returns unconditionally.
   */
  private activeNodeIds(graphId: GraphId): Set<string> {
    const g = this.must(graphId);
    const nodes = this.opts.adapter.inspectNodes(g.handle);
    const now = Date.now();
    return new Set(
      nodes
        .filter((n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now))
        .map((n) => n.id),
    );
  }

  /** Inspect every node in a graph, including soft-deleted ones — used by the Nodes table when there's no active search. */
  listNodes(graphId: GraphId): ReturnType<GraphnosisAdapter['inspectNodes']> {
    const g = this.must(graphId);
    return this.opts.adapter.inspectNodes(g.handle);
  }

  /** Dual-graph edges (directed + undirected) — powers the Atlas wire-frame. */
  listEdges(graphId: GraphId): ReturnType<GraphnosisAdapter['inspectEdges']> {
    const g = this.must(graphId);
    return this.opts.adapter.inspectEdges(g.handle);
  }

  // ── Graph metadata (template, displayName) ──────────────────────────────

  getGraphMetadata(graphId: GraphId): settingsMod.GraphMetadata | undefined {
    return this.settings.graphMetadata[graphId];
  }

  async setGraphMetadata(graphId: GraphId, metadata: settingsMod.GraphMetadata): Promise<void> {
    const next = {
      ...this.settings,
      graphMetadata: {
        ...this.settings.graphMetadata,
        [graphId]: metadata,
      },
    };
    await settingsMod.saveSettings(this.opts.vaultDir, next);
    this.settings = next;
  }

  /** Combined view: every loaded graph + its metadata (or sensible defaults). */
  graphsWithMetadata(): Array<{ graphId: GraphId; metadata: settingsMod.GraphMetadata }> {
    return this.listGraphs().map((graphId) => ({
      graphId,
      metadata: this.settings.graphMetadata[graphId] ?? {
        template: 'personal' as settingsMod.GraphTemplate,
        displayName: graphId,
        createdAt: 0,
      },
    }));
  }

  /** Update settings, persist to <vault>/settings.json, return the merged result. */
  async setSettings(partial: Partial<settingsMod.AppSettings>): Promise<settingsMod.AppSettings> {
    // Shallow merge per top-level key — keeps contentCache fully replaced if
    // the caller passes one, while leaving room for future top-level keys.
    const next: settingsMod.AppSettings = settingsMod.mergeWithDefaults({
      ...this.settings,
      ...partial,
    });
    await settingsMod.saveSettings(this.opts.vaultDir, next);
    this.settings = next;
    return next;
  }

  // ── Content cache (encrypted blobs keyed by sourceId) ───────────────────
  //
  // Each cached source lives at <vault>/content/<sourceId>.bin. Format
  // before encryption: [u32 LE header-len][header JSON][raw content bytes].
  // On `ingest()` we write the blob respecting settings; on `forgetSource()`
  // we delete it. Recovery reads it back via `readContentBlob()`.

  private contentDir(): string {
    return path.join(this.opts.vaultDir, 'content');
  }

  private contentPath(sourceId: string): string {
    return path.join(this.contentDir(), `${sourceId}.bin`);
  }

  private async writeContentBlob(
    sourceId: string,
    header: ContentCacheHeader,
    content: Buffer | Uint8Array,
  ): Promise<void> {
    const contentBytes = content instanceof Buffer
      ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
      : content;
    const headerJson = new TextEncoder().encode(JSON.stringify(header));
    const buf = new Uint8Array(4 + headerJson.length + contentBytes.length);
    new DataView(buf.buffer).setUint32(0, headerJson.length, true);
    buf.set(headerJson, 4);
    buf.set(contentBytes, 4 + headerJson.length);
    const ct = await encrypt(buf, this.key, this.salt);
    await fs.mkdir(this.contentDir(), { recursive: true });
    // Atomic write: write tmp, rename.
    const target = this.contentPath(sourceId);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, Buffer.from(ct));
    await fs.rename(tmp, target);
  }

  private async readContentBlob(
    sourceId: string,
  ): Promise<{ header: ContentCacheHeader; content: Uint8Array } | null> {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.contentPath(sourceId));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const pt = await decrypt(new Uint8Array(bytes), this.key);
    const headerLen = new DataView(pt.buffer, pt.byteOffset, 4).getUint32(0, true);
    const headerJson = new TextDecoder().decode(pt.subarray(4, 4 + headerLen));
    const header = JSON.parse(headerJson) as ContentCacheHeader;
    const content = pt.subarray(4 + headerLen);
    return { header, content };
  }

  private async deleteContentBlob(sourceId: string): Promise<void> {
    try {
      await fs.unlink(this.contentPath(sourceId));
    } catch {
      /* not cached or already gone — non-fatal */
    }
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
    this.correctionsCount.set(graphId, 0);
    await this.save(graphId);
  }

  async loadGraph(graphId: GraphId): Promise<void> {
    if (this.graphs.has(graphId)) return;
    // Recover from an interrupted purge before we try to read .gai. There
    // are two possible leftover states:
    //   .gai exists AND .gai.bak exists  → purge committed but didn't clean
    //                                      up; delete the stale .bak.
    //   .gai missing AND .gai.bak exists → purge crashed mid-rebuild;
    //                                      restore .bak → .gai so the user's
    //                                      data isn't lost.
    await this.recoverFromInterruptedPurge(graphId);
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

    // Seed the corrections counter from the op-log so historical activity is
    // visible after a fresh unlock. One-time scan per graph load; subsequent
    // applyCorrection calls bump the counter in memory.
    this.correctionsCount.set(graphId, await this.countCorrectionsFromOplog(graphId));

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
    // Per-graph mutation tick — bumps every successful save. The App
    // polls this via inspector_stats to know when to refresh its local
    // edges/nodes cache without needing a push channel. Background
    // auto-relink edges in particular need this — there's no user
    // action in the App that would otherwise trigger a reload.
    this.lastMutationAt.set(graphId, Date.now());
  }

  /** Per-engram timestamp of the last successful save. Polled by the
   *  App to know when to invalidate its cached node/edge view. */
  private lastMutationAt: Map<GraphId, number> = new Map();

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

    // Content cache — respect user settings + per-source size cap. Failures
    // are non-fatal (the ingest itself succeeded; the cache is bonus durability).
    try {
      const rawBytes: Uint8Array = typeof input.content === 'string'
        ? new TextEncoder().encode(input.content)
        : input.content instanceof Buffer
          ? new Uint8Array(input.content.buffer, input.content.byteOffset, input.content.byteLength)
          : (input.content as Uint8Array);
      if (settingsMod.shouldCache(this.settings, kind, rawBytes.byteLength)) {
        await this.writeContentBlob(
          sourceId,
          {
            kind,
            ref,
            docKind: input.kind,
            originalSize: rawBytes.byteLength,
            ...(record.contentHash ? { contentHash: record.contentHash } : {}),
            cachedAt: Date.now(),
          },
          rawBytes,
        );
      }
    } catch (e) {
      console.error(`[graphnosis-host] content cache write failed for ${sourceId}: ${(e as Error).message}`);
    }

    await this.save(graphId);
    // Fire-and-forget cross-doc relink. New clip might mention entities
    // that already appear in older nodes — without this pass the SDK
    // leaves it orphan. Coalesced + throttled inside kickoffRelink so
    // back-to-back ingests don't spawn parallel passes.
    this.kickoffRelink(graphId);
    return record;
  }

  // ── Post-ingest auto-relink ─────────────────────────────────────────
  //
  // After every successful ingest we run a cross-doc entity-overlap pass
  // (see adapter.relinkFullGraph) to wire the freshly-added node(s) into
  // existing nodes that share entities. The pass is O(N²); we coalesce
  // back-to-back ingests on the same engram and throttle by node count.
  //
  // `relinkInFlight` tracks active passes per engram; `relinkPending`
  // queues a re-run if another ingest fired while a pass was running
  // (so the latest state is always picked up after the in-flight one
  // settles).

  private relinkInFlight: Map<GraphId, Promise<void>> = new Map();
  private relinkPending: Set<GraphId> = new Set();

  private kickoffRelink(graphId: GraphId): void {
    if (this.relinkInFlight.has(graphId)) {
      // Another pass is running — mark this engram as needing a
      // re-run when it finishes.
      this.relinkPending.add(graphId);
      return;
    }
    const p = this.runRelink(graphId).catch((e) => {
      console.error(`[host] auto-relink failed for ${graphId}: ${(e as Error).message}`);
    }).finally(() => {
      this.relinkInFlight.delete(graphId);
      if (this.relinkPending.delete(graphId)) {
        // Another ingest queued itself while we were running — go again.
        this.kickoffRelink(graphId);
      }
    });
    this.relinkInFlight.set(graphId, p);
  }

  private async runRelink(graphId: GraphId): Promise<void> {
    const g = this.graphs.get(graphId);
    if (!g) return; // engram unloaded mid-pass; nothing to do
    const maxNodes = this.settings.ai.autoRelinkMaxNodes;
    const result = await this.opts.adapter.relinkFullGraph(g.handle, { maxNodes });
    if (result.skipped) {
      // Log skip reasons at debug — useful when users wonder why their
      // big engram isn't getting auto-linked.
      console.error(
        `[host] auto-relink skipped for ${graphId}: ${result.skipReason} ` +
        `(active=${result.activeNodes}, cap=${maxNodes})`,
      );
      return;
    }
    if (result.newEdges.length === 0) {
      // Nothing to do — no entity overlaps formed. Don't dirty/save.
      return;
    }
    // Emit one op-log event per new edge for audit + recovery. Group
    // by the same `addEdge` op kind we use for user-created links; the
    // `after.reason` makes auto vs manual distinguishable.
    for (const e of result.newEdges) {
      this.oplogWriter.emit({
        graphId,
        op: 'addEdge',
        target: { kind: 'edge', id: e.edgeId },
        after: {
          fromNodeId: e.a,
          toNodeId: e.b,
          type: e.type,
          weight: e.weight,
          directed: false,
          reason: `auto-relink: ${e.type} (${e.sharedEntities.slice(0, 3).join(', ')}${e.sharedEntities.length > 3 ? '…' : ''})`,
        },
      });
    }
    g.dirty = true;
    await this.save(graphId);
    console.error(
      `[host] auto-relink wove ${result.newEdges.length} edges across ${result.activeNodes} active nodes in ${graphId}`,
    );
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
    // Forget means forget everywhere — drop the cached content blob too.
    // If the user re-ingests later, we'll cache a fresh copy.
    await this.deleteContentBlob(sourceId);
    g.dirty = true;
    await this.save(graphId);

    // If the user opted into "Purge forever" mode, physically remove the
    // soft-deleted nodes by rebuilding the graph. Failures here are
    // surfaced via the returned report — the soft-delete already succeeded
    // either way, so the user can also re-run "Purge now" manually later.
    let purge: PurgeReport | undefined;
    if (this.settings.forget.mode === 'purge') {
      try {
        purge = await this.purgeSoftDeleted(graphId);
      } catch (e) {
        console.error(`[graphnosis-host] auto-purge after forget failed: ${(e as Error).message}`);
      }
    }
    return { nodeIds, ...(purge ? { purge } : {}) };
  }

  async recall(query: string, opts?: { budget?: SubgraphBudget }): Promise<federation.FederatedSubgraph> {
    // Snapshot active-node IDs per graph BEFORE the federated query runs.
    // We use these to filter SDK results so soft-deleted (forgotten) nodes
    // never leak back into the AI's context. Without this, garbage
    // pre-forget content gets re-attached on recall — exactly the kind of
    // "ghost memory" symptom that breaks user trust in the system.
    const activeByGraph = new Map<GraphId, Set<string>>();
    for (const graphId of this.listGraphs()) {
      activeByGraph.set(graphId, this.activeNodeIds(graphId));
    }
    const runner: federation.FederatedQueryRunner = {
      runQuery: async (graphId, q, k) => {
        const g = this.must(graphId);
        const active = activeByGraph.get(graphId) ?? new Set<string>();
        // Same over-fetch as searchNodes — recover real top-k after dropping
        // forgotten matches without making the SDK call quadratic.
        const raw = await this.opts.adapter.query(g.handle, q, k * 3);
        return raw
          .filter((r) => active.has(r.nodeId))
          .slice(0, k)
          .map((r) => ({ graphId, nodeId: r.nodeId, score: r.score, text: r.text, ...(r.type !== undefined ? { type: r.type } : {}) }));
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
    let correctionDelta = 0;
    for (const edit of patches.edits ?? []) {
      await this.opts.adapter.applyCorrection(g.handle, edit);
      this.oplogWriter.emit({
        graphId,
        op: edit.kind === 'delete' ? 'deleteNode' : edit.kind === 'supersede' ? 'supersede' : 'editNode',
        target: { kind: 'node', id: edit.nodeId },
        after: edit.kind === 'delete' ? undefined : { content: edit.content, reason: edit.reason },
      });
      // Count only user-driven corrections (edit + supersede). Delete is
      // also user-driven here but we exclude it because deleteNode events
      // are ambiguous in the op-log — forgetSource cascades emit them too.
      if (edit.kind === 'edit' || edit.kind === 'supersede') correctionDelta += 1;
    }
    if (correctionDelta > 0) {
      this.correctionsCount.set(graphId, (this.correctionsCount.get(graphId) ?? 0) + correctionDelta);
    }
    g.dirty = true;
    await this.save(graphId);
    // Same auto-relink pass that runs after `ingest` — applyCorrection's
    // `adds` path appends brand-new content via the same SDK code path,
    // so it deserves the same cross-doc wiring.
    if ((patches.adds?.length ?? 0) > 0) {
      this.kickoffRelink(graphId);
    }
  }

  /**
   * Create an undirected edge between two existing nodes. Powers the App's
   * "Link them" affordance: the user sees two semantically similar memories
   * in the Check-in deck/detail pane and confirms they belong together.
   *
   * Idempotent (the adapter dedupes); emits an `addEdge` op-log event only
   * when a fresh edge was created. Persists the graph.
   */
  async linkNodes(
    graphId: GraphId,
    fromNodeId: string,
    toNodeId: string,
    opts?: { type?: import('@nehloo/graphnosis').UndirectedEdge['type']; reason?: string },
  ): Promise<{ edgeId: string; created: boolean }> {
    const g = this.must(graphId);
    const type = opts?.type ?? 'related-to';
    const linkOpts: { type: import('@nehloo/graphnosis').UndirectedEdge['type']; weight: number; reason?: string } = {
      type,
      weight: 0.7,
    };
    if (opts?.reason !== undefined) linkOpts.reason = opts.reason;
    const result = await this.opts.adapter.linkNodes(g.handle, fromNodeId, toNodeId, linkOpts);
    if (result.created) {
      this.oplogWriter.emit({
        graphId,
        op: 'addEdge',
        target: { kind: 'edge', id: result.edgeId },
        after: {
          fromNodeId,
          toNodeId,
          type,
          weight: 0.7,
          directed: false,
          reason: opts?.reason ?? 'User-confirmed related memories',
        },
      });
      g.dirty = true;
      await this.save(graphId);
    }
    return result;
  }

  /**
   * Create a DIRECTED edge between two existing nodes — sibling of
   * `linkNodes` for typed edges (knows, works-with, reports-to,
   * collaborated-on, …) that need to encode direction.
   *
   * The user-friendly label (e.g. "Works at", "Lives in") rides on
   * `evidence` so the detail pane can render it directly instead of
   * humanizing the raw SDK type.
   *
   * Op-log records the same `addEdge` kind as `linkNodes`, with
   * `directed: true` in the `after` payload so a future replayer can
   * dispatch on shape.
   */
  async linkNodesDirected(
    graphId: GraphId,
    fromNodeId: string,
    toNodeId: string,
    opts: { type: import('@nehloo/graphnosis').DirectedEdge['type']; evidence?: string },
  ): Promise<{ edgeId: string; created: boolean }> {
    const g = this.must(graphId);
    const linkOpts: { type: import('@nehloo/graphnosis').DirectedEdge['type']; weight: number; evidence?: string } = {
      type: opts.type,
      weight: 0.7,
    };
    if (opts.evidence !== undefined) linkOpts.evidence = opts.evidence;
    const result = await this.opts.adapter.linkNodesDirected(g.handle, fromNodeId, toNodeId, linkOpts);
    if (result.created) {
      this.oplogWriter.emit({
        graphId,
        op: 'addEdge',
        target: { kind: 'edge', id: result.edgeId },
        after: {
          fromNodeId,
          toNodeId,
          type: opts.type,
          weight: 0.7,
          directed: true,
          evidence: opts.evidence ?? null,
        },
      });
      g.dirty = true;
      await this.save(graphId);
    }
    return result;
  }

  /**
   * Ground-truth inspection across all loaded graphs — includes soft-deleted nodes
   * (the ones recall hides because confidence dropped). Used by the `stats` MCP tool
   * and the future desktop inspector to debug "where did my nodes go?" moments.
   */
  /**
   * One-time pass over the encrypted op-log to count user corrections for
   * this graph. Counts `editNode` + `supersede` events; explicitly excludes
   * `deleteNode` because that op kind is also emitted by forgetSource
   * cascades. Returns 0 on any decryption / read error — we don't want a
   * missing op-log to break stats.
   */
  private async countCorrectionsFromOplog(graphId: GraphId): Promise<number> {
    try {
      const events = await oplog.readAllEvents(
        path.join(this.opts.vaultDir, 'oplog'),
        this.key,
      );
      return events.filter(
        (e) => e.graphId === graphId && (e.op === 'editNode' || e.op === 'supersede'),
      ).length;
    } catch (e) {
      console.error(`[graphnosis-host] count corrections from op-log failed: ${(e as Error).message}`);
      return 0;
    }
  }

  stats(): {
    graphs: Array<{
      graphId: GraphId;
      totalNodes: number;
      activeNodes: number;
      softDeletedNodes: number;
      sources: number;
      corrections: number;
      lastMutationAt: number;
      nodes: ReturnType<GraphnosisAdapter['inspectNodes']>;
    }>;
  } {
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
        corrections: this.correctionsCount.get(graphId) ?? 0,
        // Bumped on every save(); the App polls this so background
        // auto-relink edges show up without a manual refresh. 0 means
        // never mutated this session (the graph was just loaded).
        lastMutationAt: this.lastMutationAt.get(graphId) ?? 0,
        nodes,
      });
    }
    return { graphs: out };
  }

  // ── Purge (physically remove soft-deleted nodes) ────────────────────────
  //
  // The SDK only soft-deletes (confidence drops, validUntil = now). To truly
  // remove forgotten memories we rebuild the graph from the surviving live
  // sources — same trick the recovery flow uses.
  //
  // Two-phase to keep this safe:
  //   1. Plan: snapshot every live source's content (from cache or disk).
  //      Bail out BEFORE touching anything if any source can't be rebuilt.
  //   2. Rebuild: drop the in-memory + on-disk graph, re-ingest each snapshot.
  //
  // Failure modes (returned in `errors`, never thrown unless we hit phase 2):
  //   - source has no cache blob AND no reachable file → unrecoverable
  //   - cache mode is `off` AND source isn't kind=file → unrecoverable
  //
  // Edge cases:
  //   - Source IDs stay stable (makeSourceId is deterministic on kind+ref),
  //     so the op-log stays consistent across the rebuild.
  //   - Node IDs change. The op-log's addNode events keep pointing at the
  //     old IDs, which is fine — they're for replay, not live references.

  async purgeSoftDeleted(graphId: GraphId): Promise<PurgeReport> {
    const g = this.must(graphId);

    // Snapshot before/after for the report.
    const inspectBefore = this.opts.adapter.inspectNodes(g.handle);
    const beforeTotal = inspectBefore.length;
    const beforeActive = inspectBefore.filter(
      (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > Date.now()),
    ).length;
    const beforeSoftDeleted = beforeTotal - beforeActive;

    if (beforeSoftDeleted === 0) {
      return {
        beforeTotalNodes: beforeTotal,
        beforeActiveNodes: beforeActive,
        beforeSoftDeletedNodes: 0,
        afterTotalNodes: beforeTotal,
        sourcesRebuilt: 0,
        sourcesSkipped: g.sourceIndex.list().length,
        errors: [],
        noop: true,
      };
    }

    // Phase 1: gather all live source content in memory.
    type Snapshot = {
      record: SourceRecord;
      content: Uint8Array;
      docKind: 'markdown' | 'html' | 'json' | 'csv' | 'pdf' | 'text';
    };
    const snapshots: Snapshot[] = [];
    const errors: PurgeError[] = [];

    for (const rec of g.sourceIndex.list()) {
      // Cache first — survives source-file moves/deletes.
      let snapshot: Snapshot | null = null;
      try {
        const blob = await this.readContentBlob(rec.sourceId);
        if (blob) {
          snapshot = {
            record: rec,
            content: blob.content,
            docKind: blob.header.docKind,
          };
        }
      } catch (e) {
        errors.push({
          sourceId: rec.sourceId,
          ref: rec.ref,
          error: `cache blob unreadable: ${(e as Error).message}`,
        });
        continue;
      }

      // Disk fallback for file sources without a cache blob.
      if (!snapshot && rec.kind === 'file') {
        try {
          const buf = await fs.readFile(rec.ref);
          const ext = path.extname(rec.ref).toLowerCase().replace(/^\./, '');
          const docKind: Snapshot['docKind'] =
            ext === 'md' || ext === 'markdown' ? 'markdown' :
            ext === 'json' ? 'json' :
            ext === 'html' || ext === 'htm' ? 'html' :
            ext === 'csv' ? 'csv' :
            ext === 'pdf' ? 'pdf' :
            'text';
          snapshot = {
            record: rec,
            content: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
            docKind,
          };
        } catch {
          errors.push({
            sourceId: rec.sourceId,
            ref: rec.ref,
            error: `no cache blob and original file is missing on disk`,
          });
          continue;
        }
      }

      if (!snapshot) {
        // kind=url/clip/ai-conversation with no cache → unrecoverable
        errors.push({
          sourceId: rec.sourceId,
          ref: rec.ref,
          error: `no cache blob (kind=${rec.kind}). Turn on Content cache (Settings → "Cache everything") to enable purge.`,
        });
        continue;
      }

      snapshots.push(snapshot);
    }

    // Refuse to proceed if anything's unrecoverable — we'd lose data.
    if (errors.length > 0) {
      return {
        beforeTotalNodes: beforeTotal,
        beforeActiveNodes: beforeActive,
        beforeSoftDeletedNodes: beforeSoftDeleted,
        afterTotalNodes: beforeTotal,
        sourcesRebuilt: 0,
        sourcesSkipped: 0,
        errors,
        aborted: true,
      };
    }

    // Phase 2: tear down and rebuild. From here, errors are real data risk —
    // so we wrap the work in a backup/restore guard.
    //
    // Safety pass: atomic-rename the current files to .bak. The rebuild then
    // writes to fresh .gai / .bundle / .embcache. If anything fails, we
    // restore from .bak and the user sees no change. If everything succeeds,
    // we delete .bak as the final step (commit). Rename is atomic on POSIX
    // and survives a crash — see startup recovery in loadGraph().
    this.graphs.delete(graphId);
    const backupOk = await this.backupGraphFiles(graphId);
    if (!backupOk) {
      // Couldn't checkpoint — refuse to proceed. Reload in-memory state so
      // the user can keep working.
      try { await this.loadGraph(graphId); } catch { /* nothing to load */ }
      return {
        beforeTotalNodes: beforeTotal,
        beforeActiveNodes: beforeActive,
        beforeSoftDeletedNodes: beforeSoftDeleted,
        afterTotalNodes: beforeTotal,
        sourcesRebuilt: 0,
        sourcesSkipped: 0,
        errors: [{
          sourceId: '*',
          ref: '*',
          error: 'could not create backup before purge — aborted to protect your data',
        }],
        aborted: true,
      };
    }

    let rebuilt = 0;
    try {
      await this.createGraph(graphId);
      for (const snap of snapshots) {
        const content: string | Buffer = snap.docKind === 'pdf'
          ? Buffer.from(snap.content)
          : new TextDecoder().decode(snap.content);
        try {
          await this.ingest(graphId, snap.record.kind, snap.record.ref, {
            kind: snap.docKind,
            content: content as never,
            sourceRef: snap.record.ref,
          });
          rebuilt++;
        } catch (e) {
          // Per-source ingest failure is non-fatal — record and continue.
          // The user gets a partial-rebuild report; nothing is rolled back
          // unless the whole thing throws.
          errors.push({
            sourceId: snap.record.sourceId,
            ref: snap.record.ref,
            error: `rebuild ingest failed: ${(e as Error).message}`,
          });
        }
      }
    } catch (e) {
      // Catastrophic failure — restore from backup and surface.
      this.graphs.delete(graphId);
      const restored = await this.restoreGraphBackup(graphId);
      try { await this.loadGraph(graphId); } catch { /* nothing to load */ }
      throw new Error(
        `Purge failed mid-rebuild${restored ? ' — original graph restored from backup' : ''}: ${(e as Error).message}`,
      );
    }

    // Commit: delete the .bak files now that the new graph is durable on disk.
    await this.deleteGraphBackup(graphId);

    const inspectAfter = this.opts.adapter.inspectNodes(this.must(graphId).handle);
    return {
      beforeTotalNodes: beforeTotal,
      beforeActiveNodes: beforeActive,
      beforeSoftDeletedNodes: beforeSoftDeleted,
      afterTotalNodes: inspectAfter.length,
      sourcesRebuilt: rebuilt,
      sourcesSkipped: snapshots.length - rebuilt,
      errors,
    };
  }

  // ── Backup/restore helpers used by purge (and by startup recovery) ──────

  /**
   * Atomically rename the graph's files to `.bak` siblings. Returns true on
   * success. If any rename fails part-way, attempts to roll back any already-
   * renamed files so the on-disk state stays consistent.
   */
  private async backupGraphFiles(graphId: GraphId): Promise<boolean> {
    const paths = [
      this.graphPath(graphId),
      this.bundlePath(graphId),
      this.cachePath(graphId),
    ];
    const moved: string[] = [];
    for (const p of paths) {
      try {
        await fs.rename(p, `${p}.bak`);
        moved.push(p);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') continue; // nothing there to back up — fine
        // Mid-flight failure: undo any renames we already did.
        for (const undo of moved) {
          try { await fs.rename(`${undo}.bak`, undo); } catch { /* best-effort */ }
        }
        console.error(`[graphnosis-host] backup rename failed for ${p}: ${err.message}`);
        return false;
      }
    }
    return true;
  }

  /**
   * Rename `.bak` files back to their canonical names. Best-effort — logs
   * each failure but doesn't throw, because we're already in a recovery path.
   */
  private async restoreGraphBackup(graphId: GraphId): Promise<boolean> {
    let any = false;
    for (const p of [this.graphPath(graphId), this.bundlePath(graphId), this.cachePath(graphId)]) {
      try {
        await fs.rename(`${p}.bak`, p);
        any = true;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          console.error(`[graphnosis-host] restore failed for ${p}: ${err.message}`);
        }
      }
    }
    return any;
  }

  /** Delete `.bak` files after a successful purge commit. */
  private async deleteGraphBackup(graphId: GraphId): Promise<void> {
    for (const p of [this.graphPath(graphId), this.bundlePath(graphId), this.cachePath(graphId)]) {
      try { await fs.unlink(`${p}.bak`); } catch { /* not present — fine */ }
    }
  }

  /**
   * Called from loadGraph before any read. Handles crash-during-purge leftovers:
   *   - If the canonical file is missing but .bak exists → process died after
   *     the rename-to-bak step. Restore so the user isn't surprised by an
   *     empty vault.
   *   - If both exist → purge committed but didn't delete .bak. Drop the bak.
   */
  private async recoverFromInterruptedPurge(graphId: GraphId): Promise<void> {
    const triples = [
      this.graphPath(graphId),
      this.bundlePath(graphId),
      this.cachePath(graphId),
    ];
    for (const p of triples) {
      const bak = `${p}.bak`;
      const [hasCanonical, hasBak] = await Promise.all([
        this.pathExists(p),
        this.pathExists(bak),
      ]);
      if (!hasBak) continue;
      if (!hasCanonical) {
        // Crash mid-rebuild — restore.
        try {
          await fs.rename(bak, p);
          console.error(`[graphnosis-host] recovered ${p} from interrupted purge backup`);
        } catch (e) {
          console.error(`[graphnosis-host] could not restore ${p} from .bak: ${(e as Error).message}`);
        }
      } else {
        // Stale .bak from a previously-committed purge — clean up.
        try { await fs.unlink(bak); } catch { /* fine */ }
      }
    }
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async safeUnlink(p: string): Promise<void> {
    try { await fs.unlink(p); } catch { /* already gone */ }
  }

  // ── Activity (op-log timeline) ──────────────────────────────────────────

  /**
   * Decrypt + return every op-log event. The App's Activity view groups,
   * sorts, and filters these client-side — sidecar stays a thin pipe.
   * Cached briefly inside readAllEvents (none currently); recomputed on
   * each call. For massive op-logs (>100k events) we'd add windowing.
   */
  async listOplogEvents(): Promise<Awaited<ReturnType<typeof oplog.readAllEvents>>> {
    return oplog.readAllEvents(path.join(this.opts.vaultDir, 'oplog'), this.key);
  }

  // ── Snapshots ───────────────────────────────────────────────────────────
  //
  // A snapshot is an atomic copy of the vault's encrypted files at a
  // point in time. Lives at <vault>/.snapshots/<isoDate>/. Snapshots are
  // already encrypted (same key as the live files), so no extra crypto.
  //
  // Restore is intentionally NOT exposed yet — too easy to footgun without
  // a proper confirm flow + rollback path. List + create is enough for the
  // "pin this moment" use case the user asked for.

  private snapshotsDir(): string {
    return path.join(this.opts.vaultDir, '.snapshots');
  }

  async listSnapshots(): Promise<Array<{ id: string; createdAt: number; sizeBytes: number; fileCount: number }>> {
    try {
      const dirs = await fs.readdir(this.snapshotsDir());
      const out: Array<{ id: string; createdAt: number; sizeBytes: number; fileCount: number }> = [];
      for (const id of dirs) {
        if (id.startsWith('.')) continue;
        const full = path.join(this.snapshotsDir(), id);
        try {
          const stat = await fs.stat(full);
          if (!stat.isDirectory()) continue;
          let sizeBytes = 0;
          let fileCount = 0;
          const walk = async (d: string): Promise<void> => {
            const entries = await fs.readdir(d, { withFileTypes: true });
            for (const e of entries) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) await walk(p);
              else { const s = await fs.stat(p); sizeBytes += s.size; fileCount++; }
            }
          };
          await walk(full);
          out.push({ id, createdAt: stat.birthtimeMs || stat.mtimeMs, sizeBytes, fileCount });
        } catch { /* skip unreadable */ }
      }
      return out.sort((a, b) => b.createdAt - a.createdAt);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Copy every encrypted vault file into `.snapshots/<iso>/`. Atomic on a
   * per-file basis (no rename trickery — these are independent backups).
   * The live files are untouched. Snapshots stay encrypted; no key leak.
   */
  async createSnapshot(): Promise<{ id: string; sizeBytes: number; fileCount: number }> {
    // Save first so anything dirty in memory makes it into the snapshot.
    for (const graphId of this.listGraphs()) {
      const g = this.graphs.get(graphId);
      if (g?.dirty) await this.save(graphId);
    }
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.snapshotsDir(), id);
    await fs.mkdir(dest, { recursive: true });

    // Files worth snapshotting: graphs/*.gai, graphs/*.bundle, graphs/*.embcache,
    // settings.json, salt.bin, policy.json (if present), content/*. NOT the
    // op-log — it's already append-only history, and copying it would double
    // disk for every snapshot.
    const sourceDirs = [
      { src: path.join(this.opts.vaultDir, 'graphs'), dest: path.join(dest, 'graphs') },
      { src: path.join(this.opts.vaultDir, 'content'), dest: path.join(dest, 'content') },
    ];
    const sourceFiles = [
      path.join(this.opts.vaultDir, 'settings.json'),
      path.join(this.opts.vaultDir, 'salt.bin'),
      path.join(this.opts.vaultDir, 'policy.json'),
    ];

    let sizeBytes = 0;
    let fileCount = 0;

    const copyFile = async (src: string, dst: string): Promise<void> => {
      try {
        await fs.copyFile(src, dst);
        const s = await fs.stat(dst);
        sizeBytes += s.size;
        fileCount++;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') return; // source missing — skip
        throw err;
      }
    };

    for (const { src, dest: d } of sourceDirs) {
      try {
        const entries = await fs.readdir(src);
        await fs.mkdir(d, { recursive: true });
        for (const name of entries) {
          if (name.startsWith('.')) continue;
          await copyFile(path.join(src, name), path.join(d, name));
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw err;
      }
    }
    for (const src of sourceFiles) {
      await copyFile(src, path.join(dest, path.basename(src)));
    }

    return { id, sizeBytes, fileCount };
  }

  // ── Recovery ────────────────────────────────────────────────────────────
  //
  // Replay the encrypted op-log to reconstruct sources that were lost from
  // a graph (silent-overwrite bug, manual deletion, corrupt .gai, etc.).
  //
  // Two-phase by design so the user can review before any side effects:
  //   planRecovery()   → list of live sources with per-item recoverability status
  //   applyRecovery()  → re-ingest the selected sources, return per-item outcome
  //
  // Important: node content isn't in the op-log (only sourceIds for addNode
  // events), so we can only recover sources whose original `ref` is still
  // reachable from disk. Pasted text and AI-conversation clips are unrecoverable
  // unless they happened to be saved as files.

  async planRecovery(): Promise<RecoveryPlan> {
    const events = await oplog.readAllEvents(path.join(this.opts.vaultDir, 'oplog'), this.key);
    // Walk in chronological order; ingestSource adds, forgetSource removes.
    const live = new Map<string, RecoveryPlanItem>();
    for (const ev of events) {
      if (ev.op === 'ingestSource' && ev.target.kind === 'source') {
        const rec = ev.after as Partial<SourceRecord> | undefined;
        if (!rec || !rec.ref || !rec.kind) continue;
        live.set(ev.target.id, {
          sourceId: ev.target.id,
          graphId: ev.graphId,
          kind: rec.kind,
          ref: rec.ref,
          ingestedAt: rec.ingestedAt ?? ev.ts,
          status: 'pending',
          ...(rec.contentHash ? { contentHash: rec.contentHash } : {}),
        });
      } else if (ev.op === 'forgetSource' && ev.target.kind === 'source') {
        live.delete(ev.target.id);
      }
    }

    // Annotate each item with recoverability. The order of preference:
    //   1. Already in the loaded graph → skip
    //   2. Content blob in <vault>/content/ → recoverable-from-cache
    //   3. kind=file and the original path still exists → recoverable
    //   4. kind=url → url-refetch-not-implemented
    //   5. Otherwise → file-missing or content-not-in-oplog
    const items: RecoveryPlanItem[] = [];
    for (const item of live.values()) {
      const g = this.graphs.get(item.graphId);
      if (g && g.sourceIndex.list().some(s => s.sourceId === item.sourceId)) {
        items.push({ ...item, status: 'already-present' });
        continue;
      }
      // Cache hit beats everything — survives source-file moves/deletes.
      let cached = false;
      try {
        await fs.stat(this.contentPath(item.sourceId));
        cached = true;
      } catch { /* no cached blob */ }
      if (cached) {
        items.push({ ...item, status: 'recoverable-from-cache' });
        continue;
      }
      if (item.kind === 'file') {
        try {
          await fs.stat(item.ref);
          items.push({ ...item, status: 'recoverable' });
        } catch {
          items.push({ ...item, status: 'file-missing' });
        }
      } else if (item.kind === 'url') {
        items.push({ ...item, status: 'url-refetch-not-implemented' });
      } else {
        items.push({ ...item, status: 'content-not-in-oplog' });
      }
    }

    // Sort: cache-recoverable first (highest confidence), then on-disk recoverable,
    // then everything else, with ingestedAt as a stable tie-breaker.
    items.sort((a, b) => {
      const rank = (s: RecoveryStatus): number =>
        s === 'recoverable-from-cache' ? 0 :
        s === 'recoverable' ? 1 :
        s === 'already-present' ? 2 :
        s === 'url-refetch-not-implemented' ? 3 :
        s === 'file-missing' ? 4 : 5;
      const r = rank(a.status) - rank(b.status);
      return r !== 0 ? r : a.ingestedAt - b.ingestedAt;
    });

    return {
      total: items.length,
      recoverable: items.filter(i =>
        i.status === 'recoverable' || i.status === 'recoverable-from-cache',
      ).length,
      items,
    };
  }

  /**
   * Re-ingest the selected sources. If `sourceIds` is undefined, re-ingests
   * every `recoverable` item from the current plan. Returns a per-item report.
   */
  async applyRecovery(sourceIds?: string[]): Promise<RecoveryReport> {
    const plan = await this.planRecovery();
    const isRecoverable = (s: RecoveryStatus): boolean =>
      s === 'recoverable' || s === 'recoverable-from-cache';
    const want = sourceIds === undefined
      ? plan.items.filter(i => isRecoverable(i.status))
      : plan.items.filter(i => sourceIds.includes(i.sourceId));

    const outcomes: RecoveryOutcome[] = [];

    // Group by graph so we only loadGraph once per target.
    const byGraph = new Map<GraphId, RecoveryPlanItem[]>();
    for (const item of want) {
      const arr = byGraph.get(item.graphId) ?? [];
      arr.push(item);
      byGraph.set(item.graphId, arr);
    }

    for (const [graphId, arr] of byGraph) {
      // Ensure the graph is loaded; create empty if missing.
      if (!this.graphs.has(graphId)) {
        try {
          await this.loadGraph(graphId);
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          if (err.code === 'ENOENT') {
            await this.createGraph(graphId);
          } else {
            for (const item of arr) {
              outcomes.push({
                sourceId: item.sourceId,
                ref: item.ref,
                ok: false,
                error: `could not open graph ${graphId}: ${err.message}`,
              });
            }
            continue;
          }
        }
      }

      for (const item of arr) {
        if (item.status === 'already-present') {
          outcomes.push({ sourceId: item.sourceId, ref: item.ref, ok: true, skipped: 'already-present' });
          continue;
        }
        if (!isRecoverable(item.status)) {
          outcomes.push({
            sourceId: item.sourceId,
            ref: item.ref,
            ok: false,
            error: `not recoverable (status=${item.status})`,
          });
          continue;
        }
        try {
          if (item.status === 'recoverable-from-cache') {
            // Cache path: decrypt blob, re-ingest using the original docKind
            // recorded at ingest time. This is the only recovery path for
            // clip / ai-conversation kinds.
            const blob = await this.readContentBlob(item.sourceId);
            if (!blob) throw new Error('content blob disappeared between plan and apply');
            const content = blob.header.docKind === 'pdf'
              ? Buffer.from(blob.content)
              : new TextDecoder().decode(blob.content);
            await this.ingest(graphId, blob.header.kind, blob.header.ref, {
              kind: blob.header.docKind,
              content: content as never,
              sourceRef: blob.header.ref,
            });
          } else {
            // Disk path: re-read the original file.
            const buf = await fs.readFile(item.ref);
            const ext = path.extname(item.ref).toLowerCase().replace(/^\./, '');
            const docKind: 'markdown' | 'text' | 'json' | 'html' | 'pdf' = (
              ext === 'md' || ext === 'markdown' ? 'markdown' :
              ext === 'json' ? 'json' :
              ext === 'html' || ext === 'htm' ? 'html' :
              ext === 'pdf' ? 'pdf' :
              'text'
            );
            const content = docKind === 'pdf' ? buf : new TextDecoder().decode(buf);
            await this.ingest(graphId, 'file', item.ref, {
              kind: docKind,
              content: content as never,
              sourceRef: item.ref,
            });
          }
          outcomes.push({ sourceId: item.sourceId, ref: item.ref, ok: true });
        } catch (e) {
          outcomes.push({
            sourceId: item.sourceId,
            ref: item.ref,
            ok: false,
            error: (e as Error).message,
          });
        }
      }
    }

    return {
      attempted: outcomes.length,
      recovered: outcomes.filter(o => o.ok && !o.skipped).length,
      skipped: outcomes.filter(o => o.skipped !== undefined).length,
      failed: outcomes.filter(o => !o.ok).length,
      outcomes,
    };
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
