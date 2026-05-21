import type { GraphnosisHost } from './host.js';

export interface VitalityReport {
  overall: number;
  byGraph: Record<string, number>;
  computedAt: number;
}

/**
 * Computes a 0-100 "vitality" score for each engram and an overall cortex
 * score. Higher = more knowledge, better connectivity, recent activity, fewer
 * duplicate pairs. Cached with a 5-minute TTL so callers can poll freely.
 *
 * Formula per graph (each component 0-1, then scaled to 0-100):
 *   nodeScore      = clamp(activeNodes / 50) × 0.30
 *   edgeScore      = clamp(edgeDensity / 3)  × 0.30  (density = edges / nodes)
 *   activityScore  = clamp(recentOps  / 20)  × 0.20  (ops in last 7 days)
 *   avgConfScore   = avg(active node confidence) × 0.20
 *   penalty        = min(duplicatePairs × 0.05, 0.30)
 *   graphScore     = round(clamp(sum − penalty) × 100)
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

    for (const graphId of this.host.listGraphs()) {
      const nodes = this.host.listNodes(graphId);
      const now = Date.now();
      const active = nodes.filter(
        (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now),
      );
      const activeCount = active.length;

      const edges = this.host.listEdges(graphId);
      const edgeCount = edges.directed.length + edges.undirected.length;

      const recentOps = recentOpsByGraph[graphId] ?? 0;

      const nodeScore = clamp(activeCount / 50) * 0.30;
      const edgeDensity = activeCount > 0 ? edgeCount / activeCount : 0;
      const edgeScore = clamp(edgeDensity / 3) * 0.30;
      const activityScore = clamp(recentOps / 20) * 0.20;
      const avgConf = activeCount > 0
        ? active.reduce((s, n) => s + n.confidence, 0) / activeCount
        : 0;
      const avgConfScore = clamp(avgConf) * 0.20;

      const penalty = Math.min(pendingDuplicatePairs * 0.05, 0.30);
      const raw = clamp(nodeScore + edgeScore + activityScore + avgConfScore - penalty);
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
