// Recall latency benchmark — warm-cache P50 guard for CI and pre-release checks.
//
// CI: `smoketest.ts` calls `runRecallLatencyRegression` at the end (phase
// `recall-latency-regression`). See also `performance-regression-check` skill.
//
// Manual large-cortex: `scripts/recall-benchmark-manual.mjs` (pre-release only).

import type { GraphnosisHost } from './host.js';
import { policy } from '@nehloo-interactive/graphnosis-secure-sync';

// Bundled docs bench engram is ~3400 nodes (32 pages). Warm hybrid recall on
// dev/CI hardware lands ~170–220 ms P50 after snapshot optimization; 250 ms
// leaves headroom for GC spikes without masking real regressions.
export const DEFAULT_RECALL_LATENCY_P50_MS = 250;
export const DEFAULT_RECALL_LATENCY_RUNS = 5;
export const DEFAULT_RECALL_LATENCY_QUERY =
  'How do I connect an AI client to Graphnosis?';

export type RecallLatencyResult = {
  graphId: string;
  nodeCount: number;
  runs: number;
  thresholdMs: number;
  timesMs: number[];
  p50Ms: number;
  p95Ms: number;
};

function roundMs(n: number): number {
  return Math.round(n * 10) / 10;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, idx)]!;
}

function parsePositiveInt(envVal: string | undefined, fallback: number): number {
  if (!envVal?.trim()) return fallback;
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function recallLatencyThresholdMs(): number {
  return parsePositiveInt(
    process.env.GRAPHNOSIS_RECALL_LATENCY_P50_MS,
    DEFAULT_RECALL_LATENCY_P50_MS,
  );
}

export function recallLatencyRunCount(): number {
  return parsePositiveInt(
    process.env.GRAPHNOSIS_RECALL_LATENCY_RUNS,
    DEFAULT_RECALL_LATENCY_RUNS,
  );
}

/**
 * Warm-cache recall latency benchmark. Throws when P50 exceeds `thresholdMs`.
 */
export async function runRecallLatencyRegression(
  host: GraphnosisHost,
  graphId: string,
  opts?: {
    query?: string;
    thresholdMs?: number;
    runs?: number;
    log?: (phase: string, data: Record<string, unknown>) => void;
  },
): Promise<RecallLatencyResult> {
  const log = opts?.log ?? (() => undefined);
  const thresholdMs = opts?.thresholdMs ?? recallLatencyThresholdMs();
  const runs = opts?.runs ?? recallLatencyRunCount();
  const query = opts?.query
    ?? process.env.GRAPHNOSIS_RECALL_LATENCY_QUERY?.trim()
    ?? DEFAULT_RECALL_LATENCY_QUERY;
  const budget = policy.DEFAULT_BUDGET;
  const nodeCount = host.listNodes(graphId).length;

  log('recall-latency-regression.setup', {
    graphId,
    nodeCount,
    thresholdMs,
    runs,
    query,
  });

  const benchOpts = { budget, onlyGraphIds: [graphId], skipEnrichment: true as const };

  // Warm embeddings + graph caches (not a timed run).
  await host.recall(query, benchOpts);

  const timesMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await host.recall(query, benchOpts);
    timesMs.push(performance.now() - t0);
  }

  const sorted = [...timesMs].sort((a, b) => a - b);
  const p50Ms = roundMs(percentile(sorted, 50));
  const p95Ms = roundMs(percentile(sorted, 95));
  const roundedTimes = timesMs.map(roundMs);

  const result: RecallLatencyResult = {
    graphId,
    nodeCount,
    runs,
    thresholdMs,
    timesMs: roundedTimes,
    p50Ms,
    p95Ms,
  };

  log('recall-latency-regression.result', { ...result });

  if (p50Ms > thresholdMs) {
    throw new Error(
      `FAIL: recall P50 ${p50Ms}ms exceeds threshold ${thresholdMs}ms ` +
      `(graph=${graphId}, nodes=${nodeCount}, times=${roundedTimes.join(', ')})`,
    );
  }

  log('recall-latency-regression.ok', { p50Ms, p95Ms, nodeCount });
  return result;
}
