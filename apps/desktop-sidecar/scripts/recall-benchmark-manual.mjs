#!/usr/bin/env node
// Pre-release manual recall latency benchmark against a real (large) cortex.
// NOT wired to CI — run before tagging a release when recall-sensitive code changed.
//
// Checklist:
//   1. Unlock your production-sized cortex in the app (or pass GRAPHNOSIS_PASSPHRASE).
//   2. Wait for background brain sweep / embedding queue to settle.
//   3. Run this script (records warm-cache P50/P95 to stdout).
//   4. Compare to your last baseline; investigate regressions > ~20%.
//
// Usage:
//   pnpm --filter @graphnosis-app/desktop-sidecar build
//   GRAPHNOSIS_CORTEX="$HOME/Documents/MyCortex" \
//   GRAPHNOSIS_PASSPHRASE="…" \
//   GRAPHNOSIS_RECALL_BENCH_GRAPH=personal \
//   node apps/desktop-sidecar/scripts/recall-benchmark-manual.mjs
//
// Optional env:
//   GRAPHNOSIS_RECALL_LATENCY_QUERY   — benchmark query (default: connect AI client)
//   GRAPHNOSIS_RECALL_LATENCY_RUNS    — timed runs after warm-up (default: 10)
//   GRAPHNOSIS_RECALL_LATENCY_P50_MS  — fail threshold (default: none — report only)
//
// See apps/docs/src/content/docs/guides/performance.md

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { policy } from '@nehloo-interactive/graphnosis-secure-sync';
import { GraphnosisHost } from '../dist/host.js';
import { GraphnosisImpl } from '../dist/graphnosis-impl.js';
import {
  runRecallLatencyRegression,
  recallLatencyRunCount,
  recallLatencyThresholdMs,
} from '../dist/recall-latency-benchmark.js';

function log(phase, data) {
  console.log(JSON.stringify({ phase, ...data }));
}

async function main() {
  const cortexDir = process.env.GRAPHNOSIS_CORTEX?.trim();
  if (!cortexDir) {
    console.error('GRAPHNOSIS_CORTEX is required');
    process.exit(1);
  }
  const passphrase = process.env.GRAPHNOSIS_PASSPHRASE?.trim()
    ?? process.env.GRAPHNOSIS_RECOVERY_PHRASE?.trim();
  if (!passphrase) {
    console.error('GRAPHNOSIS_PASSPHRASE or GRAPHNOSIS_RECOVERY_PHRASE is required');
    process.exit(1);
  }
  const graphId = process.env.GRAPHNOSIS_RECALL_BENCH_GRAPH?.trim() ?? 'personal';
  const runs = Number(process.env.GRAPHNOSIS_RECALL_LATENCY_RUNS ?? '10');
  const assertThreshold = process.env.GRAPHNOSIS_RECALL_LATENCY_P50_MS?.trim();

  log('manual-recall-benchmark.start', { cortexDir, graphId, runs });

  const { host } = await GraphnosisHost.open({
    cortexDir: path.resolve(cortexDir),
    passphrase,
    deviceId: 'recall-bench-manual',
    adapter: new GraphnosisImpl(),
    policy: { defaultBudget: policy.DEFAULT_BUDGET, graphs: [] },
  });

  const graphs = host.listGraphs();
  if (!graphs.includes(graphId)) {
    console.error(`Engram "${graphId}" not found. Available: ${graphs.join(', ')}`);
    process.exit(1);
  }

  const nodeCount = host.listNodes(graphId).length;
  log('manual-recall-benchmark.cortex', { graphId, nodeCount, graphs: graphs.length });

  try {
    const result = await runRecallLatencyRegression(host, graphId, {
      runs,
      thresholdMs: assertThreshold ? recallLatencyThresholdMs() : Number.MAX_SAFE_INTEGER,
      log,
    });
    log('manual-recall-benchmark.done', {
      p50Ms: result.p50Ms,
      p95Ms: result.p95Ms,
      nodeCount: result.nodeCount,
      note: assertThreshold
        ? `asserted P50 < ${recallLatencyThresholdMs()}ms`
        : 'report-only (set GRAPHNOSIS_RECALL_LATENCY_P50_MS to assert)',
    });
    if (assertThreshold && result.p50Ms > recallLatencyThresholdMs()) {
      process.exit(1);
    }
  } catch (e) {
    console.error('MANUAL RECALL BENCHMARK FAILED');
    console.error(e);
    process.exit(1);
  }
}

const invoked = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (invoked) {
  main();
}
