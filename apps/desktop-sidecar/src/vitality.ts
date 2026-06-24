import type { GraphnosisHost } from './host.js';

export const VITALITY_WEIGHTS = {
  connectivity: 0.40,
  confidence: 0.25,
  activity: 0.20,
  coherence: 0.15,
} as const;

export interface VitalityFactorScores {
  /** Raw 0–1 factor before weighting. */
  connectivity: number;
  confidence: number;
  activity: number;
  coherence: number;
  /** Weighted contribution to the 0–100 score (factor × weight × 100). */
  weighted: {
    connectivity: number;
    confidence: number;
    activity: number;
    coherence: number;
  };
}

export interface VitalityEngramBreakdown {
  graphId: string;
  score: number;
  activeNodes: number;
  connectedActive: number;
  orphansEstimate: number;
  recentOps: number;
  factors: VitalityFactorScores;
}

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

export interface VitalityDetailedReport extends VitalityReport {
  pendingDuplicatePairs: number;
  pendingContradictionPairs: number;
  byGraphBreakdown: Record<string, VitalityEngramBreakdown>;
  cortexFactors: VitalityFactorScores;
  fixes: string[];
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
 *   coherence    = clamp(1 − pendingDuplicatePairs × 0.05 − pendingContradictionPairs × 0.05) × 0.15
 *   graphScore   = round(clamp(weighted sum) × 100)
 *
 * overall = active-node–weighted average across graphs.
 */
export class VitalityScorer {
  private cache: VitalityReport | null = null;
  private detailedCache: VitalityDetailedReport | null = null;
  private cacheExpireAt = 0;
  /** Fingerprint of listGraphs() at last compute — stale when the resident set grows mid-boot. */
  private cachedGraphKey = '';
  private cachedPendingDups = 0;
  private cachedPendingContra = 0;
  private static readonly TTL_MS = 5 * 60 * 1000;

  constructor(private readonly host: GraphnosisHost) {}

  async compute(pendingDuplicatePairs: number, pendingContradictionPairs = 0): Promise<VitalityReport> {
    const detailed = await this.computeDetailed(pendingDuplicatePairs, pendingContradictionPairs);
    return detailed;
  }

  async computeDetailed(pendingDuplicatePairs: number, pendingContradictionPairs = 0): Promise<VitalityDetailedReport> {
    const graphKey = this.graphSetKey();
    if (
      this.detailedCache
      && Date.now() < this.cacheExpireAt
      && this.cachedGraphKey === graphKey
      && this.cachedPendingDups === pendingDuplicatePairs
      && this.cachedPendingContra === pendingContradictionPairs
    ) {
      return this.detailedCache;
    }
    const report = this.recomputeDetailed(pendingDuplicatePairs, pendingContradictionPairs);
    this.cachedGraphKey = graphKey;
    this.cachedPendingDups = pendingDuplicatePairs;
    this.cachedPendingContra = pendingContradictionPairs;
    return report;
  }

  invalidate(): void {
    this.cache = null;
    this.detailedCache = null;
    this.cachedGraphKey = '';
    this.cachedPendingDups = 0;
    this.cachedPendingContra = 0;
  }

  private graphSetKey(): string {
    return this.host.listGraphs().slice().sort().join('\0');
  }

  private recomputeDetailed(pendingDuplicatePairs: number, pendingContradictionPairs = 0): VitalityDetailedReport {
    const byGraph: Record<string, number> = {};
    const byGraphBreakdown: Record<string, VitalityEngramBreakdown> = {};
    let totalWeight = 0;
    let weightedSum = 0;
    let tActive = 0, tConfSum = 0, tHighConf = 0, tConnected = 0;
    let cfConn = 0, cfConf = 0, cfAct = 0;

    const recentOpsByGraph = this.host.recentOpsByGraph();
    const coherenceRaw = clamp(
      1 - pendingDuplicatePairs * 0.05 - pendingContradictionPairs * 0.05,
    );

    for (const graphId of this.host.listGraphs()) {
      const nodes = this.host.listNodes(graphId);
      const now = Date.now();
      const active = nodes.filter(
        (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now),
      );
      const activeCount = active.length;

      if (activeCount === 0) {
        byGraph[graphId] = 0;
        byGraphBreakdown[graphId] = {
          graphId,
          score: 0,
          activeNodes: 0,
          connectedActive: 0,
          orphansEstimate: 0,
          recentOps: 0,
          factors: buildFactors(0, 0, 0, coherenceRaw),
        };
        continue;
      }

      const edges = this.host.listEdges(graphId);
      const linked = new Set<string>();
      for (const e of edges.directed) { linked.add(e.from); linked.add(e.to); }
      for (const e of edges.undirected) { linked.add(e.a); linked.add(e.b); }
      let connectedActive = 0;
      for (const n of active) {
        if (linked.has(n.id)) connectedActive += 1;
      }
      const connectivity = connectedActive / activeCount;

      const confSum = active.reduce((s, n) => s + n.confidence, 0);
      const avgConf = confSum / activeCount;
      const confidence = clamp((avgConf - 0.35) / 0.6);

      tActive += activeCount;
      tConfSum += confSum;
      tHighConf += active.filter((n) => n.confidence >= 0.7).length;
      tConnected += connectedActive;

      const recentOps = recentOpsByGraph[graphId] ?? 0;
      const activity = clamp(recentOps / 40);

      cfConn += connectivity * activeCount;
      cfConf += confidence * activeCount;
      cfAct += activity * activeCount;

      const factors = buildFactors(connectivity, confidence, activity, coherenceRaw);
      const raw = clamp(
        connectivity * VITALITY_WEIGHTS.connectivity +
        confidence * VITALITY_WEIGHTS.confidence +
        activity * VITALITY_WEIGHTS.activity +
        coherenceRaw * VITALITY_WEIGHTS.coherence,
      );
      const score = Math.round(raw * 100);
      byGraph[graphId] = score;
      byGraphBreakdown[graphId] = {
        graphId,
        score,
        activeNodes: activeCount,
        connectedActive,
        orphansEstimate: activeCount - connectedActive,
        recentOps,
        factors,
      };

      totalWeight += activeCount;
      weightedSum += raw * activeCount;
    }

    const overall = totalWeight > 0
      ? Math.round((weightedSum / totalWeight) * 100)
      : 0;

    const cortexFactors = totalWeight > 0
      ? buildFactors(
        cfConn / totalWeight,
        cfConf / totalWeight,
        cfAct / totalWeight,
        coherenceRaw,
      )
      : buildFactors(0, 0, 0, coherenceRaw);

    const trust = {
      activeNodes: tActive,
      avgConfidence: tActive > 0 ? tConfSum / tActive : 0,
      highConfidenceFraction: tActive > 0 ? tHighConf / tActive : 0,
      connectedFraction: tActive > 0 ? tConnected / tActive : 0,
      orphans: tActive - tConnected,
    };

    const report: VitalityDetailedReport = {
      overall,
      byGraph,
      computedAt: Date.now(),
      trust,
      pendingDuplicatePairs,
      pendingContradictionPairs,
      byGraphBreakdown,
      cortexFactors,
      fixes: suggestVitalityFixes({
        overall,
        pendingDuplicatePairs,
        pendingContradictionPairs,
        byGraphBreakdown,
        trust,
        cortexFactors,
      }),
    };
    this.cache = report;
    this.detailedCache = report;
    this.cacheExpireAt = Date.now() + VitalityScorer.TTL_MS;
    return report;
  }
}

function buildFactors(
  connectivity: number,
  confidence: number,
  activity: number,
  coherence: number,
): VitalityFactorScores {
  return {
    connectivity,
    confidence,
    activity,
    coherence,
    weighted: {
      connectivity: Math.round(connectivity * VITALITY_WEIGHTS.connectivity * 100),
      confidence: Math.round(confidence * VITALITY_WEIGHTS.confidence * 100),
      activity: Math.round(activity * VITALITY_WEIGHTS.activity * 100),
      coherence: Math.round(coherence * VITALITY_WEIGHTS.coherence * 100),
    },
  };
}

export function formatFactorPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function suggestVitalityFixes(input: {
  overall: number;
  pendingDuplicatePairs: number;
  pendingContradictionPairs?: number;
  byGraphBreakdown: Record<string, VitalityEngramBreakdown>;
  trust?: VitalityReport['trust'];
  cortexFactors: VitalityFactorScores;
  focusGraphId?: string | null;
}): string[] {
  const fixes: string[] = [];
  const dupes = input.pendingDuplicatePairs;
  const contras = input.pendingContradictionPairs ?? 0;
  if (dupes > 0) {
    fixes.push(
      dupes > 5
        ? `Clear **${dupes} duplicate pairs** in Check-in — coherence (15% weight) is dragging every engram's score.`
        : `Review **${dupes} pending duplicate pair${dupes === 1 ? '' : 's'}** in Check-in to lift coherence.`,
    );
  }
  if (contras > 0) {
    fixes.push(
      `Resolve **${contras} contradiction${contras === 1 ? '' : 's'}** in Memory Integrity — conflicting memories lower coherence until you Keep A, Keep B, or mark as debate.`,
    );
  }
  const orphans = input.trust?.orphans ?? 0;
  if (orphans > 5) {
    fixes.push(
      `Connect **${orphans.toLocaleString()} orphaned memories** — open the 3D graph or run **cortex-gardening** to weave isolated nodes.`,
    );
  }
  if (input.cortexFactors.activity < 0.25) {
    fixes.push('Recent activity is low — **remember** or **ingest** this week\'s notes to lift the activity factor (20% weight).');
  }
  if (input.cortexFactors.confidence < 0.45) {
    fixes.push('Average confidence is soft — review low-confidence nodes in **Brain** or **Check-in** and edit or forget stale entries.');
  }
  if (input.cortexFactors.connectivity < 0.55) {
    fixes.push('Connectivity is weak — link related memories in the **3D engram view** or let the brain pass auto-link overnight.');
  }

  const focus = input.focusGraphId
    ? input.byGraphBreakdown[input.focusGraphId]
    : null;
  const candidates = Object.values(input.byGraphBreakdown)
    .filter((b) => b.activeNodes === 0 || b.score < 40)
    .sort((a, b) => a.score - b.score);
  const low = focus ?? candidates[0];
  if (low) {
    if (low.activeNodes === 0) {
      fixes.push(`Populate empty engram **${low.graphId}** — ingest sources or \`/save\` a few seed memories.`);
    } else if (low.score < 35 && !input.focusGraphId) {
      fixes.push(`Engram **${low.graphId}** scores **${low.score}** — ask Ghampus \`health check ${low.graphId}\` for a factor breakdown.`);
    }
  }

  if (input.overall < 45 && !fixes.some((f) => f.includes('cortex-gardening'))) {
    fixes.push('Overall vitality is low — try **Walk skill cortex-gardening** to tidy duplicates, orphans, and stale nodes.');
  }

  const unique = [...new Set(fixes)];
  return unique.slice(0, 3);
}

function clamp(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}
