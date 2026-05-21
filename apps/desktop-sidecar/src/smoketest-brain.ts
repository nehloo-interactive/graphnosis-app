// Standalone smoke test for the Alive Brain engine.
// Runs without Tauri, without MCP, and WITHOUT a local LLM — exercises every
// brain feature that works offline: vitality scoring, duplicate scan,
// temporal decay, develop/predict fallback, insights, and goal ingest.
//
// Run with:
//   GRAPHNOSIS_CORTEX=/tmp/gn-brain-smoke \
//   GRAPHNOSIS_PASSPHRASE=smoke-test \
//   node --enable-source-maps dist/smoketest-brain.js
//
// On success it prints a JSON line per phase and ends with {"phase":"PASS"}.
// On failure it throws and exits non-zero.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { policy } from '@nehloo-interactive/graphnosis-secure-sync';
import { GraphnosisHost } from './host.js';
import { GraphnosisImpl } from './graphnosis-impl.js';
import { BrainEngine } from './brain-engine.js';
import { findSimilarPairs } from './duplicate-scan.js';
import type { RawFrame } from './events.js';

async function main(): Promise<void> {
  const cortexDir = process.env.GRAPHNOSIS_CORTEX ?? path.join(os.tmpdir(), `gn-brain-smoke-${process.pid}`);
  const passphrase = process.env.GRAPHNOSIS_PASSPHRASE ?? 'smoke-test';
  await fs.rm(cortexDir, { recursive: true, force: true });

  log('setup', { cortexDir });
  const policyCfg: policy.PolicyConfig = {
    defaultBudget: policy.DEFAULT_BUDGET,
    graphs: [{ graphId: 'personal', shareWithAi: true, tier: 'personal' }],
  };
  const { host } = await GraphnosisHost.open({
    cortexDir,
    passphrase,
    deviceId: 'brain-smoke',
    adapter: new GraphnosisImpl(),
    policy: policyCfg,
  });

  await host.createGraph('personal');
  log('create-graph', { graphId: 'personal' });

  // Seed content the brain can reason over.
  const sample = `# Mobile App Launch
We decided to launch the mobile app in Q3 2026. The team has a limited budget.
Marketing will focus on social channels. We plan to hire two engineers.

## Known risks
The timeline is tight. Past projects slipped by about two months each.`;
  await host.ingest('personal', 'clip', 'brain:seed', {
    kind: 'markdown',
    content: sample,
    sourceRef: 'brain:seed',
  });
  log('seed-ingest', { nodes: host.listNodes('personal').length });

  // Construct the brain with NO LLM and a frame-capturing broadcast.
  const frames: RawFrame[] = [];
  const broadcast = (f: RawFrame): void => { frames.push(f); };
  const brain = new BrainEngine(host, null, broadcast);

  // 1 — VitalityScorer returns a 0-100 score.
  const vitality = await brain.getVitalityReport();
  assert(
    typeof vitality.overall === 'number' && vitality.overall >= 0 && vitality.overall <= 100,
    `vitality.overall must be 0-100, got ${vitality.overall}`,
  );
  log('vitality', { overall: vitality.overall, byGraph: vitality.byGraph });

  // 2 — BrainEngine starts and stops without throwing.
  brain.start();
  log('brain-started', {});
  await sleep(600); // let the immediate loop kick-offs run
  brain.stop();
  log('brain-stopped', { framesEmitted: frames.length });

  // 3 — getDuplicatePairs() returns a valid array (empty before any scan —
  // start() now defers the first sweep past a boot grace period).
  const duplicatePairs = brain.getDuplicatePairs();
  assert(Array.isArray(duplicatePairs), 'getDuplicatePairs must return an array');
  log('duplicatePairs', { count: duplicatePairs.length });

  // 4 — Temporal decay runs and returns a structured report. Freshly
  //     ingested nodes are < 1 day old so nodesDecayed is expected to be 0;
  //     this proves the loop executes cleanly end-to-end.
  const decay = await brain.temporalEngine.runDecay();
  assert(
    typeof decay.graphsProcessed === 'number' && typeof decay.nodesDecayed === 'number',
    'runDecay must return a DecayReport',
  );
  log('temporal-decay', { ...decay });

  // 5 — develop() returns a non-empty plan (recalled-context fallback w/o LLM).
  const plan = await brain.runDevelop({
    context: 'mobile app launch',
    strategy: 'lean MVP',
    goals: 'ship in Q3 2026',
  });
  assert(plan.synthesisMarkdown.length > 0, 'develop must return non-empty synthesis');
  log('develop', {
    synthesisLength: plan.synthesisMarkdown.length,
    referencedNodes: plan.referencedNodeIds.length,
    graphIds: plan.graphIds,
  });

  // 6 — predict() returns a non-null result with array fields (empty w/o LLM).
  const prediction = await brain.runPredict({ action: 'hire two engineers next month' });
  assert(
    prediction !== null && Array.isArray(prediction.risks) && Array.isArray(prediction.opportunities),
    'predict must return a valid PredictionResult',
  );
  log('predict', {
    risks: prediction.risks.length,
    opportunities: prediction.opportunities.length,
    referencedNodes: prediction.referencedNodeIds.length,
  });

  // 7 — getInsights() returns [] without an LLM.
  const insights = brain.getInsights();
  assert(Array.isArray(insights) && insights.length === 0, 'getInsights must be [] without LLM');
  log('insights', { count: insights.length });

  // 8 — Goal ingest + list round-trip.
  const goalNodeId = await brain.ingestGoal('personal', plan);
  const goals = await brain.listGoals();
  assert(Array.isArray(goals), 'listGoals must return an array');
  log('goal', { ingestedNodeId: goalNodeId, goalsFound: goals.length });

  // 9 — computeVitality() (the duplicate-pair-count-aware variant) stays in range.
  const v2 = await brain.computeVitality();
  assert(v2.overall >= 0 && v2.overall <= 100, 'computeVitality must be 0-100');
  log('compute-vitality', { overall: v2.overall });

  // 10 — getStatus() reports intervals + lastRun without throwing.
  const status = brain.getStatus();
  assert(typeof status.scanning === 'boolean', 'getStatus.scanning must be boolean');
  assert((status.intervals['duplicateScan'] ?? 0) > 0, 'getStatus must report intervals');
  log('status', { scanning: status.scanning, intervalKeys: Object.keys(status.intervals).length });

  // 11 — runFullScan() completes and emits a wrapping fullscan start/done.
  await brain.runFullScan();
  const frameGraphId = (f: RawFrame): string =>
    (f.payload as { graphId?: string } | undefined)?.graphId ?? '';
  const sawFullscanStart = frames.some((f) => frameGraphId(f) === '__brain_start_fullscan__');
  const sawFullscanDone = frames.some((f) => frameGraphId(f) === '__brain_done_fullscan__');
  assert(sawFullscanStart && sawFullscanDone, 'runFullScan must emit fullscan start + done frames');
  log('full-scan', { fullscanStart: sawFullscanStart, fullscanDone: sawFullscanDone });

  // 12 — LSH near-duplicate search finds a similar pair, skips a distant one.
  {
    const dim = 16;
    const at = (idx: number, val: number): number[] =>
      Array.from({ length: dim }, (_, i) => (i === idx ? val : 0));
    const A = at(0, 1);                                    // unit on axis 0
    const B = [0.98, 0.198997, ...new Array<number>(dim - 2).fill(0)]; // cos(A,B) ≈ 0.98
    const C = at(dim - 1, 1);                              // orthogonal to A
    const pairs = await findSimilarPairs(
      new Map<string, number[]>([['A', A], ['B', B], ['C', C]]),
      { minSim: 0.85, maxSim: 0.99 },
    );
    const foundAB = pairs.some(
      (p) => (p.idA === 'A' && p.idB === 'B') || (p.idA === 'B' && p.idB === 'A'),
    );
    assert(foundAB, 'findSimilarPairs must detect the near-duplicate A/B pair');
    assert(
      !pairs.some((p) => p.idA === 'C' || p.idB === 'C'),
      'findSimilarPairs must not pair the distant vector C',
    );
    log('lsh', { pairs: pairs.length, foundAB });
  }

  log('PASS', { brainFramesEmitted: frames.length });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(phase: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ phase, ...data }));
}

main().catch((e) => {
  console.error('[smoketest-brain] FAILED:', e);
  process.exit(1);
});
