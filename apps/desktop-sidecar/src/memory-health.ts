import type { GraphnosisHost } from './host.js';
import type { ReinforcementEngine } from './reinforcement-engine.js';

/** Directed edge types that are fixed structure — excluded from the
 *  saturation check (a `contains` edge is weight 1.0 by construction). */
const STRUCTURAL: ReadonlySet<string> = new Set([
  'contains', 'defines', 'supersedes', 'precedes', 'cites',
]);

export interface MemoryHealth {
  /** Headline 0–100 score — a blend of the sub-metrics below. */
  overall: number;
  /** Fraction of memories reachable within their engram (no orphans). */
  connectivity: number;
  /** How interlinked the cortex is beyond raw structure — cross-engram
   *  links + inferred edges, normalized. */
  integration: number;
  /** Average confidence of active memories. Should trend up over time. */
  confidence: number;
  /** 1 = no unresolved contradictions; drops as conflicts accumulate. */
  coherence: number;
  /** Recent reinforcement activity — is the memory actively in use. */
  reinforcementActivity: number;
  /** 1 = edge weights are well-spread; → 0 warns of saturation. */
  weightSpread: number;
  /** Raw count of cross-engram connections. */
  crossEngramConnections: number;
  /** Raw count of inferred (consolidation-derived) edges. */
  inferredEdges: number;
  /** Unix ms the report was computed. */
  computedAt: number;
}

/**
 * Computes a retrieval-quality "Memory Health" report for the Autonomous
 * Indelibility tab. Unlike the older VitalityScorer (still used by the
 * `vitality` MCP tool), this rewards whether memories are *findable,
 * trustworthy and well-integrated* — not raw node/edge count. Cached with
 * a 5-minute TTL so the UI can poll freely.
 */
export class MemoryHealthScorer {
  private cache: MemoryHealth | null = null;
  private cacheExpireAt = 0;
  private static readonly TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly host: GraphnosisHost,
    private readonly reinforcement: ReinforcementEngine,
  ) {}

  async compute(): Promise<MemoryHealth> {
    if (this.cache && Date.now() < this.cacheExpireAt) return this.cache;
    return this.recompute();
  }

  invalidate(): void {
    this.cache = null;
  }

  private recompute(): MemoryHealth {
    const now = Date.now();
    let totalActive = 0;
    let confidenceSum = 0;
    let connectivityWeightedSum = 0;
    let inferredEdges = 0;
    let saturatedEdges = 0;
    let totalAssocEdges = 0;
    let unresolvedContradictions = 0;

    for (const graphId of this.host.listGraphs()) {
      const nodes = this.host.listNodes(graphId);
      const active = nodes.filter(
        (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now),
      );
      const liveIds = new Set(active.map((n) => n.id));
      totalActive += active.length;
      for (const n of active) confidenceSum += n.confidence;

      const edges = this.host.listEdges(graphId);

      // Connectivity — union-find over this engram's live nodes.
      const uf = new UnionFind(active.map((n) => n.id));
      for (const e of edges.undirected) {
        if (liveIds.has(e.a) && liveIds.has(e.b)) uf.union(e.a, e.b);
      }
      for (const e of edges.directed) {
        if (liveIds.has(e.from) && liveIds.has(e.to)) uf.union(e.from, e.to);
      }
      const graphConnectivity = active.length > 0 ? uf.largestComponentSize() / active.length : 1;
      connectivityWeightedSum += graphConnectivity * active.length;

      // Inferred edges, saturation, unresolved contradictions.
      for (const e of edges.directed) {
        if (typeof e.evidence === 'string' && e.evidence.startsWith('inferred:')) inferredEdges += 1;
        if (e.type === 'contradicts' && liveIds.has(e.from) && liveIds.has(e.to)) {
          unresolvedContradictions += 1;
        }
        if (!STRUCTURAL.has(e.type)) {
          totalAssocEdges += 1;
          if (e.weight > 0.95) saturatedEdges += 1;
        }
      }
      for (const e of edges.undirected) {
        totalAssocEdges += 1;
        if (e.weight > 0.95) saturatedEdges += 1;
      }
    }

    const connectivity = totalActive > 0 ? connectivityWeightedSum / totalActive : 1;
    const confidence = totalActive > 0 ? confidenceSum / totalActive : 0;
    const crossEngramConnections = this.reinforcement.getCrossEngramConnections().length;
    const integration = clamp(
      (crossEngramConnections + inferredEdges) / Math.max(1, totalActive * 0.25),
    );
    const coherence = unresolvedContradictions === 0
      ? 1
      : clamp(1 - unresolvedContradictions / Math.max(1, totalActive));
    const reinforcementActivity = clamp(
      (this.reinforcement.sessionReinforced + this.reinforcement.sessionConnectionsFormed) / 50,
    );
    const weightSpread = totalAssocEdges > 0 ? 1 - saturatedEdges / totalAssocEdges : 1;

    const overall = Math.round(100 * clamp(
      connectivity * 0.30 +
      confidence * 0.30 +
      integration * 0.15 +
      coherence * 0.15 +
      reinforcementActivity * 0.05 +
      weightSpread * 0.05,
    ));

    const report: MemoryHealth = {
      overall,
      connectivity,
      integration,
      confidence,
      coherence,
      reinforcementActivity,
      weightSpread,
      crossEngramConnections,
      inferredEdges,
      computedAt: now,
    };
    this.cache = report;
    this.cacheExpireAt = now + MemoryHealthScorer.TTL_MS;
    return report;
  }
}

function clamp(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Minimal union-find with path compression — for the connectivity metric. */
class UnionFind {
  private readonly parent = new Map<string, string>();

  constructor(ids: string[]) {
    for (const id of ids) this.parent.set(id, id);
  }

  private find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    if (!this.parent.has(a) || !this.parent.has(b)) return;
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  largestComponentSize(): number {
    const counts = new Map<string, number>();
    let max = 0;
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const c = (counts.get(root) ?? 0) + 1;
      counts.set(root, c);
      if (c > max) max = c;
    }
    return max;
  }
}
