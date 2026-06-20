import type { GraphnosisHost } from './host.js';

export interface VitalityReport {
  overall: number;
  byGraph: Record<string, number>;
  computedAt: number;
  /** True while boot scans / deferred materialize are still reshaping scores —
   *  UI should hold the prior snapshot (or "Computing…") until this clears. */
  settling?: boolean;
  /** Cortex-wide trust aggregates (across ALL engrams) — computed in the same
   *  pass that scores vitality, so the Home dashboard can show decomposable
   *  trust factors without loading every engram's nodes client-side. */
  trust?: {
    activeNodes: number;
    avgConfidence: number;          // 0–1, mean across all active nodes
    highConfidenceFraction: number; // share at confidence ≥ 0.7
    connectedFraction: number;      // share woven to ≥1 other node
    orphans: number;                // active nodes standing alone
  };
}

/**
 * Computes a 0-100 "vitality" score for each engram and an overall cortex
 * score. Higher = a healthier, better-maintained knowledge graph. Cached with
 * a 5-minute TTL so callers can poll freely.
 *
 * Every component is a RATIO that naturally spans 0-1, so the score genuinely
 * ranges across a cortex's lifecycle instead of saturating near 100 for any
 * non-trivial graph. Raw node / edge counts are deliberately NOT rewarded —
 * a 30-node well-woven cortex can out-score a 3000-node bag of orphans.
 *
 * Formula per graph (weights sum to 1.0):
 *   connectivity = connectedActiveNodes / activeNodes        × 0.40
 *   confidence   = clamp((avgConfidence − 0.35) / 0.6)       × 0.25
 *   activity     = clamp(recentOps / 40)  (ops in last 7d)   × 0.20
 *   coherence    = clamp(1 − pendingDuplicatePairs × 0.05)   × 0.15
 *   graphScore   = round(clamp(weighted sum) × 100)
 *
 * overall = active-node–weighted average across graphs.
 */
export class VitalityScorer {
  private cache: VitalityReport | null = null;
  private cacheExpireAt = 0;
  /** Fingerprint of listGraphs() at last compute — stale when the resident set grows mid-boot. */
  private cachedGraphKey = '';
  private static readonly TTL_MS = 5 * 60 * 1000;

  constructor(private readonly host: GraphnosisHost) {}

  async compute(pendingDuplicatePairs: number): Promise<VitalityReport> {
    const graphKey = this.graphSetKey();
    if (this.cache && Date.now() < this.cacheExpireAt && this.cachedGraphKey === graphKey) {
      return this.cache;
    }
    const report = await this.recompute(pendingDuplicatePairs);
    this.cachedGraphKey = graphKey;
    return report;
  }

  invalidate(): void {
    this.cache = null;
    this.cachedGraphKey = '';
  }

  private graphSetKey(): string {
    return this.host.listGraphs().slice().sort().join('\0');
  }

  private async recompute(pendingDuplicatePairs: number): Promise<VitalityReport> {
    const byGraph: Record<string, number> = {};
    let totalWeight = 0;
    let weightedSum = 0;
    // Cortex-wide trust accumulators (across every engram).
    let tActive = 0, tConfSum = 0, tHighConf = 0, tConnected = 0;

    // Per-engram op count from the maintained counter — NOT a full op-log scan.
    // Reading the whole op-log here (2M events) was the ~4.5 GB memory floor that
    // pinned the Home dashboard into GBs. The activity term saturates at 40 ops,
    // so this since-boot count is an accurate "recently active?" signal. (Counter
    // resets on restart; active engrams re-saturate within 40 ops.)
    const recentOpsByGraph = this.host.recentOpsByGraph();

    // Unresolved duplicate pairs are a cortex-wide count, so the coherence
    // term is the same for every engram.
    const coherence = clamp(1 - pendingDuplicatePairs * 0.05);

    for (const graphId of this.host.listGraphs()) {
      const nodes = this.host.listNodes(graphId);
      const now = Date.now();
      const active = nodes.filter(
        (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now),
      );
      const activeCount = active.length;

      // An empty engram has no vitality to measure.
      if (activeCount === 0) {
        byGraph[graphId] = 0;
        continue;
      }

      // Connectivity — fraction of active memories woven into the graph.
      // The core signal: isolated orphans drag it down, a dense web lifts it.
      const edges = this.host.listEdges(graphId);
      const linked = new Set<string>();
      for (const e of edges.directed) { linked.add(e.from); linked.add(e.to); }
      for (const e of edges.undirected) { linked.add(e.a); linked.add(e.b); }
      let connectedActive = 0;
      for (const n of active) {
        if (linked.has(n.id)) connectedActive += 1;
      }
      const connectivity = connectedActive / activeCount;

      // Confidence — average active-node confidence, stretched so the band
      // human-added memories actually occupy (≈0.35–0.95) spans 0–1.
      const confSum = active.reduce((s, n) => s + n.confidence, 0);
      const avgConf = confSum / activeCount;
      const confidence = clamp((avgConf - 0.35) / 0.6);

      // Fold this engram into the cortex-wide trust aggregates.
      tActive += activeCount;
      tConfSum += confSum;
      tHighConf += active.filter((n) => n.confidence >= 0.7).length;
      tConnected += connectedActive;

      // Activity — op-log events in the last 7 days; a maintained cortex
      // scores high, a long-neglected one low.
      const recentOps = recentOpsByGraph[graphId] ?? 0;
      const activity = clamp(recentOps / 40);

      const raw = clamp(
        connectivity * 0.40 +
        confidence * 0.25 +
        activity * 0.20 +
        coherence * 0.15,
      );
      byGraph[graphId] = Math.round(raw * 100);

      totalWeight += activeCount;
      weightedSum += raw * activeCount;
    }

    const overall = totalWeight > 0
      ? Math.round((weightedSum / totalWeight) * 100)
      : 0;

    const report: VitalityReport = {
      overall,
      byGraph,
      computedAt: Date.now(),
      trust: {
        activeNodes: tActive,
        avgConfidence: tActive > 0 ? tConfSum / tActive : 0,
        highConfidenceFraction: tActive > 0 ? tHighConf / tActive : 0,
        connectedFraction: tActive > 0 ? tConnected / tActive : 0,
        orphans: tActive - tConnected,
      },
    };
    this.cache = report;
    this.cacheExpireAt = Date.now() + VitalityScorer.TTL_MS;
    return report;
  }
}

function clamp(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}
