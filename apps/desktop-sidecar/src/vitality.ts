import type { GraphnosisHost } from './host.js';

export interface VitalityReport {
  overall: number;
  byGraph: Record<string, number>;
  computedAt: number;
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
  private static readonly TTL_MS = 5 * 60 * 1000;

  constructor(private readonly host: GraphnosisHost) {}

  async compute(pendingDuplicatePairs: number): Promise<VitalityReport> {
    if (this.cache && Date.now() < this.cacheExpireAt) return this.cache;
    return this.recompute(pendingDuplicatePairs);
  }

  invalidate(): void {
    this.cache = null;
  }

  private async recompute(pendingDuplicatePairs: number): Promise<VitalityReport> {
    const byGraph: Record<string, number> = {};
    let totalWeight = 0;
    let weightedSum = 0;

    // Read recent op-log events once, group by graphId.
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentOpsByGraph: Record<string, number> = {};
    try {
      const events = await this.host.listOplogEvents();
      for (const ev of events) {
        if (ev.ts >= cutoff) {
          recentOpsByGraph[ev.graphId] = (recentOpsByGraph[ev.graphId] ?? 0) + 1;
        }
      }
    } catch {
      // op-log unreadable — treat as zero activity
    }

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
      const avgConf = active.reduce((s, n) => s + n.confidence, 0) / activeCount;
      const confidence = clamp((avgConf - 0.35) / 0.6);

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

    const report: VitalityReport = { overall, byGraph, computedAt: Date.now() };
    this.cache = report;
    this.cacheExpireAt = Date.now() + VitalityScorer.TTL_MS;
    return report;
  }
}

function clamp(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}
