import type { GraphnosisHost } from './host.js';
import type { DirectedEdgeType } from './graphnosis-adapter.js';
import { findSimilarPairs } from './duplicate-scan.js';
import { type CrossEngramConnection, makeCrossEngramConnection } from './connection-store.js';
import { type AssociationEntry } from './association-index.js';
import { DEFAULT_REINFORCEMENT, type ReinforcementSettings, type AppSettings } from '@graphnosis-app/core/settings';
import { embeddings } from '@graphnosis-app/core';
import { GnnLinkPredictor, type PairFeatures } from './gnn.js';
import { type PredictedEdge, makePredictedEdge } from './gnn-store.js';

const { cosine } = embeddings;

/**
 * Directed edge types that encode fixed structure or lineage. They are
 * never reinforced and never cleaned up — only associative connections
 * (similarity, co-occurrence, related-to, supports, …) are plastic.
 */
const STRUCTURAL_DIRECTED_TYPES: ReadonlySet<string> = new Set([
  'contains', 'defines', 'supersedes', 'precedes', 'cites',
]);

/**
 * Directed edge types whose meaning is transitive — if A→B and B→C both
 * hold for the same type, A→C is a sound inference. Drives consolidation.
 */
const TRANSITIVE_DIRECTED_TYPES: ReadonlySet<DirectedEdgeType> = new Set<DirectedEdgeType>([
  'causes', 'depends-on', 'supports',
]);

/** Per-run ceiling on edges added by transitive inference. */
const MAX_INFERRED_EDGES_PER_RUN = 50;

/** Per-run ceiling on new cross-engram connections. */
const MAX_CROSS_ENGRAM_PER_RUN = 200;
/** Node ceiling for the pooled cross-engram embedding scan. */
const CROSS_ENGRAM_MAX_NODES = 15_000;
/** An entity mentioned by more than this many memories is too generic to
 *  be a meaningful cross-engram bridge. */
const MAX_ENTITY_REFS_FOR_BRIDGE = 20;
/** Shortest entity string worth treating as a cross-engram bridge. */
const MIN_BRIDGE_ENTITY_LENGTH = 4;

/** Co-recall count at which an association pair reaches full link weight. */
const ASSOCIATION_FULL_WEIGHT_COUNT = 10;
/** Per-graph cap on stored association pairs (lowest-count pruned first). */
const MAX_ASSOCIATION_PAIRS = 20_000;
/** Max enrichment memories appended per graph to a recall result. */
const MAX_ENRICHMENT_PER_GRAPH = 4;

/** Graphnosis Neural Network — training-sample and output caps. */
const MAX_GNN_TRAIN_POS = 400;
const MAX_GNN_TRAIN_NEG = 400;
const MAX_GNN_CANDIDATES = 15_000;
const MAX_GNN_EDGES_PER_RUN = 200;
/** Minimum predicted probability for the GNN to add an edge. */
const GNN_SCORE_THRESHOLD = 0.75;
/** Smallest graph (active nodes) the GNN will train on. */
const MIN_GNN_NODES = 12;
/** Per-node cap on 2-hop candidates the GNN considers. */
const GNN_CANDIDATES_PER_NODE = 20;

/**
 * Cap on the recall result set folded into the co-activation accumulator
 * per recall. Recall budgets are ~20 nodes; capping at 12 bounds the
 * O(k²) pair expansion and keeps the "fire together" signal on the
 * strongest hits.
 */
const MAX_COACTIVATION_NODES = 12;

/** Smallest weight change worth a write — avoids op-log / disk churn. */
const MIN_WEIGHT_DELTA = 0.005;

/** A co-recalled node pair and how many times it has fired together. */
interface CoActivatedPair {
  a: string;
  b: string;
  count: number;
}

/** Per-engram data the GNN runner extracts once, then reuses for pooled
 *  training, candidate generation, and re-scoring its own predictions. */
interface GnnGraphContext {
  graphId: string;
  nodeIds: string[];
  neighbors: Map<string, Set<string>>;
  edgeSet: Set<string>;
  /** Ground-truth associative pairs — excludes gnn-predicted edges, so the
   *  model is never trained to merely confirm its own past guesses. */
  positivePairs: Array<[string, string]>;
  /** The engram's existing gnn-predicted edges, for the re-prune pass. */
  predictedEdges: Array<{ from: string; to: string }>;
  embs: Map<string, number[]>;
  entities: Map<string, Set<string>>;
}

/**
 * Deterministic Consolidation's engine. Strengthen-only: connection
 * reinforcement with live edge weights, cross-engram linking, and
 * consolidation. No method here ever weakens a correct, human-added
 * memory — the only edge removal is dead/duplicate-edge cleanup during
 * consolidation, which never touches a link between two live memories.
 *
 * Owned and driven by BrainEngine, which holds the timers; this class
 * holds the algorithms and the in-memory co-activation accumulator.
 */
export class ReinforcementEngine {
  /**
   * graphId → (unordered node-pair key → co-activated pair). The raw
   * "fire together" signal: every recall bumps the count for each pair of
   * memories that surfaced together. Drained by runReinforcementPass.
   */
  private readonly coActivation = new Map<string, Map<string, CoActivatedPair>>();

  // Re-entrancy guards — a timer firing must not overlap a runFullScan.
  private reinforcementRunning = false;
  private consolidationRunning = false;
  private crossEngramRunning = false;

  // Session counters — surfaced in the status line and Memory Health.
  sessionReinforced = 0;
  sessionConnectionsFormed = 0;
  sessionInferred = 0;
  sessionEdgesCleaned = 0;
  sessionCrossEngram = 0;

  /** Summary of the most recent consolidation pass — for the UI status line. */
  lastConsolidation: {
    at: number;
    inferredEdges: number;
    communities: number;
    edgesCleaned: number;
  } | null = null;

  /**
   * The cross-engram connection store, held in memory after first load so
   * recall co-activation can reinforce it cheaply. null until the first
   * runCrossEngramPass loads it from disk.
   */
  private crossEngramConnections: CrossEngramConnection[] | null = null;
  /** Set when in-memory cross-engram weights changed and need persisting. */
  private crossEngramDirty = false;

  /**
   * Lifetime co-recall counts — graphId → pairKey → pair. The predictive
   * substrate: it captures associations the windowed reinforcement misses.
   * null until warmUp() loads it from disk.
   */
  private associationIndex: Map<string, Map<string, CoActivatedPair>> | null = null;
  /** Set when the association index changed and needs persisting. */
  private associationDirty = false;

  private gnnRunning = false;
  /** Edges added by the Graphnosis Neural Network this session. */
  sessionGnnEdges = 0;
  /** Summary of the most recent neural-network run, for the UI. */
  lastNeuralNetwork: { at: number; edgesAdded: number; edgesPruned: number } | null = null;

  /** The GNN prediction overlay, held in memory. null until warmUp loads it.
   *  Kept OUT of the .gai graph so the deterministic graph stays pure. */
  private gnnEdges: PredictedEdge[] | null = null;
  /** Set when the overlay changed and needs persisting. */
  private gnnDirty = false;

  constructor(
    private readonly host: GraphnosisHost,
    private readonly getSettings: () => AppSettings,
    private readonly emitBrain: (graphId: string) => void,
  ) {}

  private cfg(): ReinforcementSettings {
    return this.getSettings().brain?.reinforcement ?? DEFAULT_REINFORCEMENT;
  }

  private emitActivity(phase: string, status: 'start' | 'done'): void {
    this.emitBrain(status === 'start' ? `__brain_start_${phase}__` : `__brain_done_${phase}__`);
  }

  // ── Co-activation accumulator (fed by every federated recall) ─────────────

  /**
   * Record that a set of memories surfaced together in one recall. Every
   * unordered pair within the (capped) set has its counter bumped. Pure
   * in-memory and cheap — safe to call on the hot recall path.
   */
  recordCoActivation(graphId: string, nodeIds: string[]): void {
    const ids = [...new Set(nodeIds)].slice(0, MAX_COACTIVATION_NODES);
    if (ids.length < 2) return;
    let pairs = this.coActivation.get(graphId);
    if (!pairs) { pairs = new Map(); this.coActivation.set(graphId, pairs); }
    // Lifetime association index — updated only once warmUp() has loaded it.
    let assoc: Map<string, CoActivatedPair> | undefined;
    if (this.associationIndex) {
      assoc = this.associationIndex.get(graphId);
      if (!assoc) { assoc = new Map(); this.associationIndex.set(graphId, assoc); }
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const lo = ids[i]! < ids[j]! ? ids[i]! : ids[j]!;
        const hi = ids[i]! < ids[j]! ? ids[j]! : ids[i]!;
        const key = pairKey(lo, hi);
        const existing = pairs.get(key);
        if (existing) existing.count += 1;
        else pairs.set(key, { a: lo, b: hi, count: 1 });
        if (assoc) {
          const lifetime = assoc.get(key);
          if (lifetime) lifetime.count += 1;
          else assoc.set(key, { a: lo, b: hi, count: 1 });
          this.associationDirty = true;
        }
      }
    }
  }

  // ── Reinforcement pass — strengthen-only ─────────────────────────────────

  /**
   * Turn accumulated co-activation into stronger connections. For each
   * co-recalled pair: if a connection exists, strengthen it (saturating —
   * it asymptotes at 1, never overshoots); if none exists and the pair was
   * co-recalled enough times, form a new `related-to` connection at the
   * baseline weight. There is deliberately no weakening branch — a
   * connection that was not co-recalled is simply left untouched.
   */
  async runReinforcementPass(): Promise<void> {
    if (this.reinforcementRunning) return;
    const cfg = this.cfg();
    if (cfg.enabled === false) return;
    if (this.coActivation.size === 0) return; // nothing recalled since last pass
    this.reinforcementRunning = true;
    this.emitActivity('reinforce', 'start');
    try {
      for (const graphId of this.host.listGraphs()) {
        const pairs = this.coActivation.get(graphId);
        if (!pairs || pairs.size === 0) continue;
        await this.reinforceGraph(graphId, pairs, cfg);
      }
      this.coActivation.clear();
      if (this.associationDirty && this.associationIndex) {
        this.pruneAssociationIndex();
        await this.host.saveAssociationIndex(this.flattenAssociationIndex());
        this.associationDirty = false;
      }
      await this.persistLastRun('reinforce');
    } catch (err) {
      console.error('[reinforcement] pass error:', err);
    } finally {
      this.reinforcementRunning = false;
      this.emitActivity('reinforce', 'done');
      this.emitBrain('__brain_done__');
    }
  }

  private async reinforceGraph(
    graphId: string,
    pairs: Map<string, CoActivatedPair>,
    cfg: ReinforcementSettings,
  ): Promise<void> {
    const edges = this.host.listEdges(graphId);
    // Index every *associative* connection by its unordered endpoint pair.
    const edgeByPair = new Map<string, { id: string; weight: number }>();
    for (const e of edges.undirected) {
      edgeByPair.set(unorderedKey(e.a, e.b), { id: e.id, weight: e.weight });
    }
    for (const e of edges.directed) {
      if (STRUCTURAL_DIRECTED_TYPES.has(e.type)) continue;
      const k = unorderedKey(e.from, e.to);
      if (!edgeByPair.has(k)) edgeByPair.set(k, { id: e.id, weight: e.weight });
    }

    const updates: Array<{ edgeId: string; weight: number }> = [];
    const newLinks: Array<{ a: string; b: string; count: number }> = [];
    for (const [key, pair] of pairs) {
      const edge = edgeByPair.get(key);
      if (edge) {
        // Saturating reinforcement — asymptotes at 1, scaled by how often
        // the pair was co-recalled. Strong edges plateau on their own.
        const boost = cfg.reinforceRate * (1 - edge.weight) * Math.min(1, pair.count / 2);
        const next = Math.min(1, edge.weight + boost);
        if (next - edge.weight > MIN_WEIGHT_DELTA) {
          updates.push({ edgeId: edge.id, weight: next });
        }
      } else if (pair.count >= cfg.newConnectionCoActivationThreshold) {
        // Repeatedly co-recalled with no connection yet → form one.
        newLinks.push({ a: pair.a, b: pair.b, count: pair.count });
      }
    }

    if (updates.length > 0) {
      this.sessionReinforced += await this.host.setEdgeWeightsBatch(graphId, updates);
    }
    if (newLinks.length > 0) {
      const created = await this.host.linkNodesBatch(
        graphId,
        newLinks.map((l) => ({
          a: l.a,
          b: l.b,
          type: 'related-to' as const,
          weight: cfg.baselineWeight,
          reason: `reinforcement: co-recalled ${l.count}×`,
        })),
      );
      this.sessionConnectionsFormed += created;
    }
  }

  // ── Consolidation pass — integrate & tidy, never weaken ──────────────────

  /**
   * The daily "sleep" pass. Three deterministic steps, none of which
   * weakens a memory: transitive inference (A→B→C ⇒ A→C — makes memories
   * MORE connected), community detection (a structural read, no
   * mutation), and redundancy cleanup (removes only edges touching an
   * already-deleted node — never a link between two live memories).
   */
  async runConsolidationPass(): Promise<void> {
    if (this.consolidationRunning) return;
    const cfg = this.cfg();
    if (cfg.enabled === false) return;
    this.consolidationRunning = true;
    this.emitActivity('consolidate', 'start');
    let inferredEdges = 0;
    let communities = 0;
    let edgesCleaned = 0;
    try {
      for (const graphId of this.host.listGraphs()) {
        inferredEdges += await this.inferTransitiveEdges(graphId);
        communities += this.detectCommunities(graphId);
        edgesCleaned += await this.cleanupRedundantEdges(graphId);
      }
      this.sessionInferred += inferredEdges;
      this.sessionEdgesCleaned += edgesCleaned;
      this.lastConsolidation = { at: Date.now(), inferredEdges, communities, edgesCleaned };
      await this.persistLastRun('consolidation');
    } catch (err) {
      console.error('[consolidation] pass error:', err);
    } finally {
      this.consolidationRunning = false;
      this.emitActivity('consolidate', 'done');
      this.emitBrain('__brain_done__');
    }
  }

  /**
   * Transitive inference — for every A→B→C chain of the same transitive
   * type with no existing A→C, add A→C at the product weight (decayed by
   * 0.5 for the inferential hop). Purely additive: a memory becomes more
   * connected, never less. Capped per run.
   */
  private async inferTransitiveEdges(graphId: string): Promise<number> {
    const edges = this.host.listEdges(graphId);
    const out = new Map<string, Array<{ to: string; weight: number; type: DirectedEdgeType }>>();
    const existing = new Set<string>();
    for (const e of edges.directed) {
      existing.add(`${e.from}>${e.to}`);
      if (!TRANSITIVE_DIRECTED_TYPES.has(e.type)) continue;
      let arr = out.get(e.from);
      if (!arr) { arr = []; out.set(e.from, arr); }
      arr.push({ to: e.to, weight: e.weight, type: e.type });
    }
    const toCreate: Array<{ from: string; to: string; type: DirectedEdgeType; weight: number; evidence: string }> = [];
    outer: for (const [a, aOut] of out) {
      for (const ab of aOut) {
        const bOut = out.get(ab.to);
        if (!bOut) continue;
        for (const bc of bOut) {
          if (bc.type !== ab.type) continue;
          const c = bc.to;
          if (c === a) continue;
          const key = `${a}>${c}`;
          if (existing.has(key)) continue;
          const weight = ab.weight * bc.weight * 0.5;
          if (weight < 0.15) continue;
          existing.add(key); // never infer the same chain twice in one run
          toCreate.push({ from: a, to: c, type: ab.type, weight, evidence: `inferred: ${a}→${ab.to}→${c}` });
          if (toCreate.length >= MAX_INFERRED_EDGES_PER_RUN) break outer;
        }
      }
    }
    if (toCreate.length === 0) return 0;
    return this.host.linkNodesDirectedBatch(graphId, toCreate);
  }

  /**
   * Deterministic weighted label propagation — a structural read that
   * reports how many distinct clusters the live memories fall into. No
   * mutation; it feeds the consolidation status line and Memory Health.
   */
  private detectCommunities(graphId: string): number {
    const now = Date.now();
    const live = this.host.listNodes(graphId)
      .filter((n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now))
      .map((n) => n.id)
      .sort();
    if (live.length < 3) return 0;
    const liveSet = new Set(live);
    const adj = new Map<string, Array<{ to: string; weight: number }>>();
    const addAdj = (a: string, b: string, w: number): void => {
      if (!liveSet.has(a) || !liveSet.has(b)) return;
      let arr = adj.get(a);
      if (!arr) { arr = []; adj.set(a, arr); }
      arr.push({ to: b, weight: w });
    };
    const edges = this.host.listEdges(graphId);
    for (const e of edges.undirected) { addAdj(e.a, e.b, e.weight); addAdj(e.b, e.a, e.weight); }
    for (const e of edges.directed) { addAdj(e.from, e.to, e.weight); addAdj(e.to, e.from, e.weight); }

    const label = new Map<string, string>();
    for (const id of live) label.set(id, id);
    for (let iter = 0; iter < 5; iter++) {
      let changed = false;
      for (const id of live) {
        const neighbors = adj.get(id);
        if (!neighbors || neighbors.length === 0) continue;
        const score = new Map<string, number>();
        for (const nb of neighbors) {
          const lbl = label.get(nb.to)!;
          score.set(lbl, (score.get(lbl) ?? 0) + nb.weight);
        }
        let best = label.get(id)!;
        let bestScore = -1;
        // Sort labels for a deterministic tie-break.
        for (const lbl of [...score.keys()].sort()) {
          const s = score.get(lbl)!;
          if (s > bestScore) { bestScore = s; best = lbl; }
        }
        if (best !== label.get(id)) { label.set(id, best); changed = true; }
      }
      if (!changed) break;
    }
    return new Set(label.values()).size;
  }

  /**
   * Redundancy cleanup — the design's ONLY edge removal. Removes edges
   * that touch an already-deleted node (soft-deleted / expired / absent)
   * plus exact-duplicate parallel edges. It never removes a connection
   * between two live, valid memories.
   */
  private async cleanupRedundantEdges(graphId: string): Promise<number> {
    const now = Date.now();
    const nodes = this.host.listNodes(graphId);
    const allIds = new Set<string>();
    const deadIds = new Set<string>();
    for (const n of nodes) {
      allIds.add(n.id);
      if (n.validUntil !== undefined && n.validUntil <= now) deadIds.add(n.id);
    }
    const isDead = (id: string): boolean => deadIds.has(id) || !allIds.has(id);

    const edges = this.host.listEdges(graphId);
    const toRemove: string[] = [];
    const seen = new Set<string>();
    for (const e of edges.directed) {
      if (isDead(e.from) || isDead(e.to)) { toRemove.push(e.id); continue; }
      const key = `d:${e.from}>${e.to}|${e.type}`;
      if (seen.has(key)) toRemove.push(e.id);
      else seen.add(key);
    }
    for (const e of edges.undirected) {
      if (isDead(e.a) || isDead(e.b)) { toRemove.push(e.id); continue; }
      const key = `u:${unorderedKey(e.a, e.b)}|${e.type}`;
      if (seen.has(key)) toRemove.push(e.id);
      else seen.add(key);
    }
    if (toRemove.length === 0) return 0;
    return this.host.unlinkEdgesBatch(graphId, toRemove);
  }

  // ── Cross-engram connections — the multi-graph layer ─────────────────────

  /** Snapshot of the cross-engram connection store (for IPC / the UI). */
  getCrossEngramConnections(): CrossEngramConnection[] {
    return this.crossEngramConnections ?? [];
  }

  /**
   * Called from BrainEngine.onRecall with every `graphId#nodeId` key from a
   * federated recall. Strengthens any cross-engram connection whose BOTH
   * endpoints were co-recalled — strengthen-only, saturating. In-memory;
   * persisted by the next runCrossEngramPass.
   */
  noteCrossEngramRecall(activated: Set<string>): void {
    const store = this.crossEngramConnections;
    if (!store || activated.size < 2) return;
    const cfg = this.cfg();
    for (const c of store) {
      if (activated.has(`${c.graphA}#${c.nodeA}`) && activated.has(`${c.graphB}#${c.nodeB}`)) {
        const next = Math.min(1, c.weight + cfg.reinforceRate * (1 - c.weight));
        if (next - c.weight > MIN_WEIGHT_DELTA) {
          c.weight = next;
          this.crossEngramDirty = true;
        }
        c.lastReinforcedAt = Date.now();
      }
    }
  }

  /**
   * Form associative links between memories in DIFFERENT engrams, so the
   * cortex stops siloing. Two deterministic, bounded bases: embedding
   * similarity (LSH over a pooled map) and shared named entities. Also
   * persists any cross-engram reinforcement accumulated since the last run.
   */
  async runCrossEngramPass(): Promise<void> {
    if (this.crossEngramRunning) return;
    const cfg = this.cfg();
    if (cfg.enabled === false || cfg.crossEngramEnabled === false) return;
    this.crossEngramRunning = true;
    this.emitActivity('cross-engram', 'start');
    try {
      if (this.crossEngramConnections === null) {
        this.crossEngramConnections = await this.host.loadConnectionStore();
      }
      const store = this.crossEngramConnections;
      const graphIds = this.host.listGraphs();
      if (graphIds.length >= 2) {
        const existing = new Set(
          store.map((c) => crossKey(c.graphA, c.nodeA, c.graphB, c.nodeB)),
        );
        const formed: CrossEngramConnection[] = [];
        await this.formCrossEngramByEmbedding(graphIds, cfg, existing, formed);
        this.formCrossEngramByEntity(graphIds, existing, formed);
        if (formed.length > 0) {
          store.push(...formed);
          this.sessionCrossEngram += formed.length;
          this.crossEngramDirty = true;
        }
      }
      if (this.crossEngramDirty) {
        await this.host.saveConnectionStore(store);
        this.crossEngramDirty = false;
        await this.persistLastRun('crossEngram');
      }
    } catch (err) {
      console.error('[cross-engram] pass error:', err);
    } finally {
      this.crossEngramRunning = false;
      this.emitActivity('cross-engram', 'done');
      this.emitBrain('__brain_done__');
    }
  }

  /** Embedding-similarity basis — pool every engram's vectors under opaque
   *  keys, run the graph-agnostic LSH once, keep only cross-graph pairs. */
  private async formCrossEngramByEmbedding(
    graphIds: string[],
    cfg: ReinforcementSettings,
    existing: Set<string>,
    formed: CrossEngramConnection[],
  ): Promise<void> {
    const pooled = new Map<string, number[]>();
    const meta = new Map<string, { graphId: string; nodeId: string }>();
    let idx = 0;
    for (const gid of graphIds) {
      if (pooled.size >= CROSS_ENGRAM_MAX_NODES) break;
      for (const [nodeId, vec] of this.host.getNodeEmbeddings(gid)) {
        if (pooled.size >= CROSS_ENGRAM_MAX_NODES) break;
        const k = `n${idx++}`;
        pooled.set(k, vec);
        meta.set(k, { graphId: gid, nodeId });
      }
    }
    if (pooled.size < 2) return;
    const pairs = await findSimilarPairs(pooled, { minSim: cfg.crossEngramMinSim, maxSim: 1.01 });
    for (const p of pairs) {
      if (formed.length >= MAX_CROSS_ENGRAM_PER_RUN) break;
      const a = meta.get(p.idA);
      const b = meta.get(p.idB);
      if (!a || !b || a.graphId === b.graphId) continue;
      const ck = crossKey(a.graphId, a.nodeId, b.graphId, b.nodeId);
      if (existing.has(ck)) continue;
      existing.add(ck);
      formed.push(makeCrossEngramConnection({
        graphA: a.graphId, nodeA: a.nodeId,
        graphB: b.graphId, nodeB: b.nodeId,
        weight: Math.min(0.85, 0.45 + p.similarity * 0.4),
        basis: 'embedding-sim',
        createdAt: Date.now(),
      }));
    }
  }

  /** Entity-overlap basis — a global entity→refs index; any entity shared
   *  by memories in different engrams bridges them. Generic, hyper-common
   *  entities are skipped — they are noise, not a meaningful bridge. */
  private formCrossEngramByEntity(
    graphIds: string[],
    existing: Set<string>,
    formed: CrossEngramConnection[],
  ): void {
    const now = Date.now();
    const index = new Map<string, Array<{ graphId: string; nodeId: string }>>();
    for (const gid of graphIds) {
      for (const n of this.host.listNodes(gid)) {
        if (n.confidence <= 0.2 || (n.validUntil !== undefined && n.validUntil <= now)) continue;
        for (const ent of n.entities ?? []) {
          const norm = ent.trim().toLowerCase();
          if (norm.length < MIN_BRIDGE_ENTITY_LENGTH) continue;
          let arr = index.get(norm);
          if (!arr) { arr = []; index.set(norm, arr); }
          arr.push({ graphId: gid, nodeId: n.id });
        }
      }
    }
    for (const [entity, refs] of index) {
      if (formed.length >= MAX_CROSS_ENGRAM_PER_RUN) break;
      if (refs.length < 2 || refs.length > MAX_ENTITY_REFS_FOR_BRIDGE) continue;
      for (let i = 0; i < refs.length && formed.length < MAX_CROSS_ENGRAM_PER_RUN; i++) {
        for (let j = i + 1; j < refs.length && formed.length < MAX_CROSS_ENGRAM_PER_RUN; j++) {
          const a = refs[i]!;
          const b = refs[j]!;
          if (a.graphId === b.graphId) continue;
          const ck = crossKey(a.graphId, a.nodeId, b.graphId, b.nodeId);
          if (existing.has(ck)) continue;
          existing.add(ck);
          formed.push(makeCrossEngramConnection({
            graphA: a.graphId, nodeA: a.nodeId,
            graphB: b.graphId, nodeB: b.nodeId,
            weight: 0.5,
            basis: 'entity-overlap',
            sharedEntities: [entity],
            createdAt: now,
          }));
        }
      }
    }
  }

  // ── Predictive recall enrichment ─────────────────────────────────────────

  /** Load the persistent association index and the GNN overlay off disk —
   *  called once at start. */
  async warmUp(): Promise<void> {
    try {
      const entries = await this.host.loadAssociationIndex();
      const idx = new Map<string, Map<string, CoActivatedPair>>();
      for (const e of entries) {
        let g = idx.get(e.graphId);
        if (!g) { g = new Map(); idx.set(e.graphId, g); }
        const lo = e.a < e.b ? e.a : e.b;
        const hi = e.a < e.b ? e.b : e.a;
        g.set(pairKey(lo, hi), { a: lo, b: hi, count: e.count });
      }
      this.associationIndex = idx;
    } catch (err) {
      console.error('[reinforcement] association index load failed:', err);
      this.associationIndex = new Map(); // proceed with an empty index
    }
    try {
      this.gnnEdges = await this.host.loadGnnStore();
    } catch (err) {
      console.error('[reinforcement] GNN overlay load failed:', err);
      this.gnnEdges = []; // proceed with an empty overlay
    }
  }

  /**
   * Enrich a recall result in place — strengthen-only and read-only w.r.t.
   * the graph. It appends an "Anticipated & related memories" section to
   * `sub.prompt`: the memories most strongly *implied* by what was just
   * recalled (pattern completion) and most strongly *associated* with it
   * (predictive recall), via one spreading-activation pass over the
   * combined reinforced-edge + lifetime-co-recall graph.
   */
  enrichRecall(sub: { byGraph: Map<string, Array<{ nodeId: string }>>; prompt: string }): void {
    if (this.cfg().enabled === false) return;
    const blocks: string[] = [];
    for (const [graphId, items] of sub.byGraph) {
      const seeds = new Set(items.map((i) => i.nodeId));
      if (seeds.size === 0) continue;
      const ranked = this.associativeSpread(graphId, seeds);
      if (ranked.length === 0) continue;
      const byId = new Map(this.host.listNodes(graphId).map((n) => [n.id, n] as const));
      const lines: string[] = [];
      for (const r of ranked) {
        if (lines.length >= MAX_ENRICHMENT_PER_GRAPH) break;
        const node = byId.get(r.nodeId);
        if (!node) continue;
        const snippet = node.contentPreview.replace(/\s+/g, ' ').trim().slice(0, 160);
        if (snippet) lines.push(`- ${snippet}`);
      }
      if (lines.length > 0) blocks.push(lines.join('\n'));
    }
    if (blocks.length > 0) {
      sub.prompt += '\n\n## Anticipated & related memories\n'
        + 'Memories strongly associated with what you just recalled, '
        + 'surfaced by Deterministic Consolidation:\n'
        + blocks.join('\n');
    }
    this.appendGnnPredictions(sub);
  }

  /**
   * Append the opt-in Graphnosis Neural Network's predictions as a SEPARATE,
   * clearly-fenced section — never folded into the deterministic block above.
   * Predictions come entirely from the `.gnn` overlay, so deterministic
   * recall is structurally uncontaminated: the reader can see exactly which
   * lines are model guesses. No-op unless the user has enabled the GNN.
   */
  private appendGnnPredictions(
    sub: { byGraph: Map<string, Array<{ nodeId: string }>>; prompt: string },
  ): void {
    if (this.getSettings().brain?.neuralNetwork?.enabled !== true) return;
    const overlay = this.gnnEdges;
    if (!overlay || overlay.length === 0) return;
    const lines: string[] = [];
    for (const [graphId, items] of sub.byGraph) {
      const seeds = new Set(items.map((i) => i.nodeId));
      if (seeds.size === 0) continue;
      // A predicted edge is relevant when exactly one endpoint was recalled —
      // the other endpoint is the anticipated, not-yet-linked memory.
      const best = new Map<string, number>();
      for (const pe of overlay) {
        if (pe.graphId !== graphId) continue;
        const fromSeed = seeds.has(pe.from);
        const toSeed = seeds.has(pe.to);
        if (fromSeed === toSeed) continue;
        const other = fromSeed ? pe.to : pe.from;
        if ((best.get(other) ?? 0) < pe.score) best.set(other, pe.score);
      }
      if (best.size === 0) continue;
      const byId = new Map(this.host.listNodes(graphId).map((n) => [n.id, n] as const));
      const ranked = [...best.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, MAX_ENRICHMENT_PER_GRAPH);
      for (const [nodeId, score] of ranked) {
        const node = byId.get(nodeId);
        if (!node) continue;
        const snippet = node.contentPreview.replace(/\s+/g, ' ').trim().slice(0, 160);
        if (snippet) lines.push(`- (${Math.round(score * 100)}% predicted) ${snippet}`);
      }
    }
    if (lines.length > 0) {
      sub.prompt += '\n\n## Neural-network predictions (experimental, non-deterministic)\n'
        + 'Connections the optional Graphnosis Neural Network predicts but '
        + 'which are NOT in the deterministic memory graph. They may be wrong — '
        + 'treat them as leads to verify, never as recalled fact:\n'
        + lines.join('\n');
    }
  }

  /**
   * 2-hop spreading activation from the recalled set over the combined
   * graph of reinforced edges + lifetime co-recall associations. Returns
   * non-seed nodes ranked by accumulated activation. Deterministic.
   */
  private associativeSpread(
    graphId: string,
    seeds: Set<string>,
  ): Array<{ nodeId: string; score: number }> {
    const adj = new Map<string, Array<{ to: string; w: number }>>();
    const link = (a: string, b: string, w: number): void => {
      if (w <= 0) return;
      let la = adj.get(a); if (!la) { la = []; adj.set(a, la); } la.push({ to: b, w });
      let lb = adj.get(b); if (!lb) { lb = []; adj.set(b, lb); } lb.push({ to: a, w });
    };
    const edges = this.host.listEdges(graphId);
    for (const e of edges.undirected) link(e.a, e.b, e.weight);
    for (const e of edges.directed) {
      if (!STRUCTURAL_DIRECTED_TYPES.has(e.type)) link(e.from, e.to, e.weight);
    }
    const assoc = this.associationIndex?.get(graphId);
    if (assoc) {
      for (const p of assoc.values()) {
        link(p.a, p.b, Math.min(1, p.count / ASSOCIATION_FULL_WEIGHT_COUNT));
      }
    }
    const activation = new Map<string, number>();
    let frontier = new Map<string, number>();
    for (const s of seeds) frontier.set(s, 1);
    const DECAY = 0.5;
    for (let hop = 0; hop < 2; hop++) {
      const next = new Map<string, number>();
      for (const [node, act] of frontier) {
        const neighbors = adj.get(node);
        if (!neighbors) continue;
        for (const nb of neighbors) {
          const delta = act * nb.w * DECAY;
          if (delta < 0.01) continue;
          next.set(nb.to, (next.get(nb.to) ?? 0) + delta);
          if (!seeds.has(nb.to)) activation.set(nb.to, (activation.get(nb.to) ?? 0) + delta);
        }
      }
      frontier = next;
    }
    return [...activation.entries()]
      .map(([nodeId, score]) => ({ nodeId, score }))
      .sort((x, y) => y.score - x.score);
  }

  private pruneAssociationIndex(): void {
    if (!this.associationIndex) return;
    for (const [graphId, submap] of this.associationIndex) {
      if (submap.size <= MAX_ASSOCIATION_PAIRS) continue;
      const sorted = [...submap.entries()].sort((x, y) => y[1].count - x[1].count);
      this.associationIndex.set(graphId, new Map(sorted.slice(0, MAX_ASSOCIATION_PAIRS)));
    }
  }

  private flattenAssociationIndex(): AssociationEntry[] {
    const out: AssociationEntry[] = [];
    if (!this.associationIndex) return out;
    for (const [graphId, submap] of this.associationIndex) {
      for (const p of submap.values()) out.push({ graphId, a: p.a, b: p.b, count: p.count });
    }
    return out;
  }

  // ── Graphnosis Neural Network (opt-in, non-deterministic) ────────────────

  /**
   * Train the link-predictor and reconcile its predictions across the whole
   * cortex. Training is FEDERATED — positives and negatives from every
   * engram are pooled into one training set, so the model learns from far
   * more than any single engram could offer (the features are
   * graph-agnostic). Each run is self-correcting: it re-scores its own past
   * `gnn-predicted` edges and prunes the ones that no longer hold up, then
   * adds fresh predictions. Non-deterministic; gated behind the
   * off-by-default settings toggle. It only ever touches `gnn-predicted`
   * edges — never a deterministic, reinforced, or human-added connection.
   */
  async runNeuralNetwork(): Promise<{ trained: boolean; edgesAdded: number; edgesPruned: number }> {
    if (this.gnnRunning) return { trained: false, edgesAdded: 0, edgesPruned: 0 };
    if (this.getSettings().brain?.neuralNetwork?.enabled !== true) {
      return { trained: false, edgesAdded: 0, edgesPruned: 0 };
    }
    this.gnnRunning = true;
    this.emitActivity('neural-network', 'start');
    let edgesAdded = 0;
    let edgesPruned = 0;
    let trained = false;
    try {
      if (this.gnnEdges === null) {
        this.gnnEdges = await this.host.loadGnnStore();
      }
      // Phase 1 — one context per engram + a pooled, cortex-wide training set.
      const contexts: GnnGraphContext[] = [];
      const trainingSet: Array<{ features: PairFeatures; label: 0 | 1 }> = [];
      for (const graphId of this.host.listGraphs()) {
        const ctx = this.buildGnnContext(graphId);
        if (!ctx) continue;
        contexts.push(ctx);
        const positives = sampleArray(ctx.positivePairs, MAX_GNN_TRAIN_POS);
        for (const [a, b] of positives) {
          trainingSet.push({ features: this.gnnFeatures(ctx, a, b), label: 1 });
        }
        const negTarget = Math.min(MAX_GNN_TRAIN_NEG, Math.max(positives.length, 4) * 2);
        let negAdded = 0;
        for (let tries = 0; tries < negTarget * 20 && negAdded < negTarget; tries++) {
          const a = ctx.nodeIds[(Math.random() * ctx.nodeIds.length) | 0]!;
          const b = ctx.nodeIds[(Math.random() * ctx.nodeIds.length) | 0]!;
          if (a === b || ctx.edgeSet.has(unorderedKey(a, b))) continue;
          trainingSet.push({ features: this.gnnFeatures(ctx, a, b), label: 0 });
          negAdded += 1;
        }
      }
      if (contexts.length > 0 && trainingSet.length >= 8) {
        // Phase 2 — train ONE cortex-wide model.
        const model = new GnnLinkPredictor();
        model.train(trainingSet);
        trained = true;
        // Phase 3 — per engram: recompute the overlay slice from scratch
        // (replace, never accumulate) and tally the delta vs. the prior set.
        for (const ctx of contexts) {
          const delta = this.predictNewEdges(ctx, model);
          edgesAdded += delta.added;
          edgesPruned += delta.pruned;
        }
        this.sessionGnnEdges += edgesAdded;
        this.lastNeuralNetwork = { at: Date.now(), edgesAdded, edgesPruned };
        if (this.gnnDirty) {
          await this.host.saveGnnStore(this.gnnEdges ?? []);
          this.gnnDirty = false;
        }
      }
    } catch (err) {
      console.error('[gnn] run error:', err);
    } finally {
      this.gnnRunning = false;
      this.emitActivity('neural-network', 'done');
      this.emitBrain('__brain_done__');
    }
    return { trained, edgesAdded, edgesPruned };
  }

  /** Extract a reusable per-engram context, or null if the engram is too
   *  small to train on. `positivePairs` is ground truth only — it excludes
   *  the GNN's own predictions. */
  private buildGnnContext(graphId: string): GnnGraphContext | null {
    const now = Date.now();
    const nodes = this.host.listNodes(graphId).filter(
      (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now),
    );
    if (nodes.length < MIN_GNN_NODES) return null;
    const nodeIds = nodes.map((n) => n.id);
    const idSet = new Set(nodeIds);
    const embs = this.host.getNodeEmbeddings(graphId);
    const entities = new Map<string, Set<string>>();
    for (const n of nodes) {
      entities.set(n.id, new Set((n.entities ?? []).map((e) => e.toLowerCase())));
    }
    const neighbors = new Map<string, Set<string>>();
    for (const id of nodeIds) neighbors.set(id, new Set<string>());
    const edgeSet = new Set<string>();
    const positivePairs: Array<[string, string]> = [];
    const consider = (a: string, b: string): void => {
      if (a === b || !idSet.has(a) || !idSet.has(b)) return;
      neighbors.get(a)!.add(b);
      neighbors.get(b)!.add(a);
      const k = unorderedKey(a, b);
      if (edgeSet.has(k)) return;
      edgeSet.add(k);
      positivePairs.push([a, b]);
    };
    const edges = this.host.listEdges(graphId);
    for (const e of edges.undirected) consider(e.a, e.b);
    for (const e of edges.directed) {
      if (!STRUCTURAL_DIRECTED_TYPES.has(e.type)) consider(e.from, e.to);
    }
    // The GNN overlay's own predictions for this engram — used to compute the
    // added/pruned delta against this run's fresh set. They are deliberately
    // NOT added to edgeSet, neighbors, or positivePairs: every run re-scores
    // every candidate pair from scratch so "Run again" recomputes the overlay
    // rather than piling fresh edges on top of the old set. Features and
    // training data stay ground-truth only regardless.
    const predictedEdges: Array<{ from: string; to: string }> = [];
    for (const pe of this.gnnEdges ?? []) {
      if (pe.graphId !== graphId || !idSet.has(pe.from) || !idSet.has(pe.to)) continue;
      predictedEdges.push({ from: pe.from, to: pe.to });
    }
    return { graphId, nodeIds, neighbors, edgeSet, positivePairs, predictedEdges, embs, entities };
  }

  /** Deterministic feature vector for a candidate pair within an engram. */
  private gnnFeatures(ctx: GnnGraphContext, u: string, v: string): PairFeatures {
    const eu = ctx.embs.get(u);
    const ev = ctx.embs.get(v);
    let cos = 0;
    if (eu && ev && eu.length > 0 && eu.length === ev.length) {
      cos = Math.max(0, cosine(eu, ev));
    }
    const nu = ctx.neighbors.get(u) ?? EMPTY_SET;
    const nv = ctx.neighbors.get(v) ?? EMPTY_SET;
    const [smallN, largeN] = nu.size <= nv.size ? [nu, nv] : [nv, nu];
    let common = 0;
    for (const x of smallN) if (largeN.has(x)) common += 1;
    const eU = ctx.entities.get(u) ?? EMPTY_SET;
    const eV = ctx.entities.get(v) ?? EMPTY_SET;
    const [smallE, largeE] = eU.size <= eV.size ? [eU, eV] : [eV, eU];
    let shared = 0;
    for (const x of smallE) if (largeE.has(x)) shared += 1;
    return {
      cosine: cos,
      commonNeighbors: Math.min(1, common / 8),
      prefAttachment: Math.min(1, Math.log1p(nu.size * nv.size) / 8),
      sharedEntities: Math.min(1, shared / 4),
    };
  }

  /** Re-score every 2-hop candidate non-edge for this engram against the
   *  freshly trained model and REPLACE the engram's slice of the GNN overlay
   *  with the fresh top-N. Each run recomputes from scratch, so repeated runs
   *  refresh the overlay instead of accumulating. Self-correction is folded
   *  in: a previously-predicted pair that no longer makes the cut is dropped.
   *  Returns the delta vs. the prior set. Mutates the overlay, never the
   *  .gai graph. */
  private predictNewEdges(
    ctx: GnnGraphContext,
    model: GnnLinkPredictor,
  ): { added: number; pruned: number } {
    const candidates: Array<[string, string]> = [];
    const candSeen = new Set<string>();
    for (const u of ctx.nodeIds) {
      if (candidates.length >= MAX_GNN_CANDIDATES) break;
      const nu = ctx.neighbors.get(u) ?? EMPTY_SET;
      let perNode = 0;
      for (const mid of nu) {
        if (perNode >= GNN_CANDIDATES_PER_NODE) break;
        for (const w of ctx.neighbors.get(mid) ?? EMPTY_SET) {
          if (w === u || nu.has(w)) continue;
          const k = unorderedKey(u, w);
          if (candSeen.has(k) || ctx.edgeSet.has(k)) continue;
          candSeen.add(k);
          candidates.push([u, w]);
          perNode += 1;
          if (perNode >= GNN_CANDIDATES_PER_NODE || candidates.length >= MAX_GNN_CANDIDATES) break;
        }
      }
    }
    if (!this.gnnEdges) return { added: 0, pruned: 0 };
    const scored = candidates
      .map(([a, b]) => ({ a, b, score: model.score(this.gnnFeatures(ctx, a, b)) }))
      .filter((c) => c.score >= GNN_SCORE_THRESHOLD)
      .sort((x, y) => y.score - x.score)
      .slice(0, MAX_GNN_EDGES_PER_RUN);
    // Delta vs. this engram's previous overlay slice.
    const oldPairs = new Set(ctx.predictedEdges.map((p) => unorderedKey(p.from, p.to)));
    const newPairs = new Set(scored.map((c) => unorderedKey(c.a, c.b)));
    let added = 0;
    for (const k of newPairs) if (!oldPairs.has(k)) added += 1;
    let pruned = 0;
    for (const k of oldPairs) if (!newPairs.has(k)) pruned += 1;
    if (added === 0 && pruned === 0) return { added: 0, pruned: 0 };
    // Replace this engram's slice — drop its old predictions, leave every
    // other engram's untouched, append the freshly scored set.
    this.gnnEdges = this.gnnEdges.filter((e) => e.graphId !== ctx.graphId);
    for (const c of scored) {
      this.gnnEdges.push(makePredictedEdge({
        graphId: ctx.graphId,
        from: c.a < c.b ? c.a : c.b,
        to: c.a < c.b ? c.b : c.a,
        score: c.score,
        createdAt: Date.now(),
      }));
    }
    this.gnnDirty = true;
    return { added, pruned };
  }

  /** Discard the entire GNN overlay — the live undo for the neural network.
   *  The .gai graph is untouched (the overlay never lived there). */
  async removeGnnEdges(): Promise<number> {
    if (this.gnnEdges === null) this.gnnEdges = await this.host.loadGnnStore();
    const removed = this.gnnEdges.length;
    if (removed > 0) {
      this.gnnEdges = [];
      await this.host.saveGnnStore(this.gnnEdges);
    }
    this.gnnDirty = false;
    this.sessionGnnEdges = Math.max(0, this.sessionGnnEdges - removed);
    this.lastNeuralNetwork = null;
    this.emitBrain('__brain_done__');
    return removed;
  }

  /** Count predicted edges currently in the GNN overlay. */
  countGnnEdges(): number {
    return this.gnnEdges?.length ?? 0;
  }

  /** The GNN overlay — predicted connections, for the 3D Engram. */
  getPredictedEdges(): readonly PredictedEdge[] {
    return this.gnnEdges ?? [];
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async persistLastRun(key: 'reinforce' | 'consolidation' | 'crossEngram'): Promise<void> {
    try {
      const current = this.host.getSettings();
      await this.host.setSettings({
        brain: {
          ...current.brain,
          lastRun: { ...current.brain?.lastRun, [key]: Date.now() },
        },
      });
    } catch { /* non-fatal — lastRun is a cosmetic timestamp */ }
  }
}

/** Stable key for an already-ordered (lo, hi) node pair. */
function pairKey(lo: string, hi: string): string {
  return `${lo}>${hi}`;
}

/** Stable unordered key for any two node ids. */
function unorderedKey(a: string, b: string): string {
  return a < b ? `${a}>${b}` : `${b}>${a}`;
}

/** Stable unordered key for a cross-engram node pair (dedup only). */
function crossKey(gA: string, nA: string, gB: string, nB: string): string {
  const x = `${gA}#${nA}`;
  const y = `${gB}#${nB}`;
  return x < y ? `${x}::${y}` : `${y}::${x}`;
}

/** Shared empty set — a safe fallback for missing adjacency lookups. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** Random subset of up to `max` items via a partial Fisher–Yates shuffle. */
function sampleArray<T>(arr: ReadonlyArray<T>, max: number): T[] {
  if (arr.length <= max) return arr.slice();
  const copy = arr.slice();
  for (let i = 0; i < max; i++) {
    const j = i + ((Math.random() * (copy.length - i)) | 0);
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy.slice(0, max);
}
