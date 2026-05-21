// Standalone smoke test for the Alive Brain engine.
// Runs without Tauri, without MCP, and WITHOUT a local LLM — exercises every
// brain feature that works offline: vitality scoring, duplicate scan,
// temporal decay, develop/predict fallback, insights, goal ingest, and the
// Deterministic Consolidation engine — edge reweighting, connection
// reinforcement (strengthen-only), consolidation, cross-engram connections,
// and the Memory Health metric.
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
import { makeCrossEngramConnection } from './connection-store.js';
import { makePredictedEdge } from './gnn-store.js';
import { GnnLinkPredictor, type PairFeatures } from './gnn.js';
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

  // 13 — reweightEdge / setEdgeWeightsBatch changes an edge's weight.
  {
    const nodeIds = host.listNodes('personal').map((n) => n.id);
    assert(nodeIds.length >= 2, 'need ≥2 nodes for the reweight test');
    const { edgeId } = await host.linkNodes('personal', nodeIds[0]!, nodeIds[1]!, { type: 'related-to' });
    const changed = await host.setEdgeWeightsBatch('personal', [{ edgeId, weight: 0.99 }]);
    assert(changed === 1, 'setEdgeWeightsBatch must report 1 edge changed');
    const reweighted = host.listEdges('personal').undirected.find((e) => e.id === edgeId);
    assert(
      reweighted !== undefined && Math.abs(reweighted.weight - 0.99) < 1e-6,
      `reweightEdge must set the weight to 0.99, got ${reweighted?.weight}`,
    );
    log('reweight-edge', { edgeId, weight: reweighted?.weight });
  }

  // 14 — Reinforcement pass strengthens a co-recalled edge and weakens NOTHING.
  {
    const before = host.listEdges('personal');
    assert(before.undirected.length > 0, 'need ≥1 undirected edge for the reinforcement test');
    const weightsBefore = new Map<string, number>();
    for (const e of [...before.undirected, ...before.directed]) weightsBefore.set(e.id, e.weight);
    // Reset the probe edge low so reinforcement has headroom to climb.
    const probe = before.undirected[0]!;
    await host.setEdgeWeightsBatch('personal', [{ edgeId: probe.id, weight: 0.5 }]);
    weightsBefore.set(probe.id, 0.5);
    for (let i = 0; i < 4; i++) brain.reinforcement.recordCoActivation('personal', [probe.a, probe.b]);
    frames.length = 0;
    await brain.reinforcement.runReinforcementPass();
    let increased = 0;
    for (const e of [...host.listEdges('personal').undirected, ...host.listEdges('personal').directed]) {
      const w0 = weightsBefore.get(e.id);
      if (w0 === undefined) continue;
      assert(e.weight >= w0 - 1e-9, `STRENGTHEN-ONLY violated: edge ${e.id} fell ${w0} → ${e.weight}`);
      if (e.weight > w0 + 1e-9) increased += 1;
    }
    assert(increased >= 1, 'reinforcement must strengthen at least one co-recalled edge');
    assert(
      frames.some((f) => frameGraphId(f) === '__brain_done_reinforce__'),
      'reinforcement pass must emit a done frame',
    );
    log('reinforcement', { edgesStrengthened: increased, sessionReinforced: brain.reinforcement.sessionReinforced });
  }

  // 15 — Consolidation pass runs end-to-end and records a summary.
  {
    frames.length = 0;
    await brain.reinforcement.runConsolidationPass();
    assert(
      frames.some((f) => frameGraphId(f) === '__brain_start_consolidate__')
        && frames.some((f) => frameGraphId(f) === '__brain_done_consolidate__'),
      'consolidation must emit start + done frames',
    );
    const cons = brain.reinforcement.lastConsolidation;
    assert(
      cons !== null && typeof cons.inferredEdges === 'number' && typeof cons.communities === 'number',
      'consolidation must record a summary',
    );
    log('consolidation', { ...cons });
  }

  // 16 — Cross-engram pass + encrypted connection-store round-trip.
  {
    await host.createGraph('work');
    await host.ingest('work', 'clip', 'work:seed', {
      kind: 'markdown',
      content: 'The mobile app launch needs two engineers and a Q3 2026 deadline.',
      sourceRef: 'work:seed',
    });
    frames.length = 0;
    await brain.reinforcement.runCrossEngramPass();
    assert(Array.isArray(brain.getCrossEngramConnections()), 'getCrossEngramConnections must return an array');
    // Verify the encrypted store round-trips through encrypt → disk → decrypt.
    const conn = makeCrossEngramConnection({
      graphA: 'personal', nodeA: 'n-a', graphB: 'work', nodeB: 'n-b',
      weight: 0.6, basis: 'entity-overlap', sharedEntities: ['mobile app'], createdAt: Date.now(),
    });
    await host.saveConnectionStore([conn]);
    const loaded = await host.loadConnectionStore();
    assert(
      loaded.length === 1 && loaded[0]!.id === conn.id && loaded[0]!.weight === 0.6,
      'connection store must round-trip through encrypt/decrypt',
    );
    log('cross-engram', { storeRoundTrip: true, formed: brain.getCrossEngramConnections().length });
  }

  // 17 — Memory Health returns a valid retrieval-quality report.
  {
    const mh = await brain.getMemoryHealth();
    assert(
      typeof mh.overall === 'number' && mh.overall >= 0 && mh.overall <= 100,
      `memory health overall must be 0-100, got ${mh.overall}`,
    );
    for (const k of ['connectivity', 'integration', 'confidence', 'coherence', 'reinforcementActivity', 'weightSpread'] as const) {
      assert(typeof mh[k] === 'number' && mh[k] >= 0 && mh[k] <= 1, `memory health ${k} must be 0-1`);
    }
    log('memory-health', { overall: mh.overall, connectivity: mh.connectivity, weightSpread: mh.weightSpread });
  }

  // 18 — Association index (predictive substrate) round-trips encrypted.
  {
    await host.saveAssociationIndex([{ graphId: 'personal', a: 'node-x', b: 'node-y', count: 7 }]);
    const loaded = await host.loadAssociationIndex();
    assert(
      loaded.length === 1 && loaded[0]!.count === 7 && loaded[0]!.graphId === 'personal',
      'association index must round-trip through encrypt/decrypt',
    );
    log('association-index', { roundTrip: true });
  }

  // 19 — Recall enrichment appends an "Anticipated & related memories" section.
  {
    const ids = host.listNodes('personal').map((n) => n.id);
    assert(ids.length >= 2, 'need ≥2 nodes for the enrichment test');
    await host.linkNodes('personal', ids[0]!, ids[1]!, { type: 'related-to' });
    const sub = {
      byGraph: new Map<string, Array<{ nodeId: string }>>([['personal', [{ nodeId: ids[0]! }]]]),
      prompt: 'BASE-PROMPT',
    };
    brain.reinforcement.enrichRecall(sub);
    assert(sub.prompt.startsWith('BASE-PROMPT'), 'enrichRecall must keep the original prompt');
    assert(
      sub.prompt.includes('Anticipated & related memories'),
      'enrichRecall must append the anticipated-memories section',
    );
    log('recall-enrichment', { promptGrew: sub.prompt.length > 'BASE-PROMPT'.length });
  }

  // 20 — The MLP link-predictor trains without NaN and learns the pattern.
  {
    const model = new GnnLinkPredictor();
    const samples: Array<{ features: PairFeatures; label: 0 | 1 }> = [];
    for (let i = 0; i < 20; i++) {
      samples.push({ features: { cosine: 0.9, commonNeighbors: 0.8, prefAttachment: 0.5, sharedEntities: 0.6 }, label: 1 });
      samples.push({ features: { cosine: 0.05, commonNeighbors: 0, prefAttachment: 0.1, sharedEntities: 0 }, label: 0 });
    }
    const loss = model.train(samples);
    assert(Number.isFinite(loss), `MLP training loss must be finite, got ${loss}`);
    const posScore = model.score({ cosine: 0.9, commonNeighbors: 0.8, prefAttachment: 0.5, sharedEntities: 0.6 });
    const negScore = model.score({ cosine: 0.05, commonNeighbors: 0, prefAttachment: 0.1, sharedEntities: 0 });
    assert(posScore >= 0 && posScore <= 1 && negScore >= 0 && negScore <= 1, 'MLP scores must be in [0,1]');
    assert(posScore > negScore, 'MLP must learn to score the positive pattern above the negative');
    log('gnn-mlp', {
      loss: Number(loss.toFixed(4)),
      posScore: Number(posScore.toFixed(3)),
      negScore: Number(negScore.toFixed(3)),
    });
  }

  // 21 — GNN run completes when enabled; the .gnn overlay round-trips and clears.
  {
    const cur = host.getSettings();
    await host.setSettings({ brain: { ...cur.brain, neuralNetwork: { enabled: true } } });
    const gnnSeed = [
      'The team shipped the authentication service in March.',
      'Database migrations are reviewed by two engineers before merge.',
      'The mobile client caches data for offline use.',
      'Customer support uses a shared inbox for tickets.',
      'The staging environment mirrors production configuration.',
      'Release notes are published on the company blog.',
      'The payments integration uses Stripe webhooks.',
      'Load testing runs every Friday afternoon.',
      'The design system is documented in Figma.',
      'On-call rotation covers nights and weekends.',
      'The data warehouse refreshes every six hours.',
      'New hires complete a security training module.',
      'The API gateway enforces rate limits per client.',
      'Feature flags are managed in a central dashboard.',
      'Incident postmortems are blameless and shared widely.',
      'The search index is rebuilt nightly.',
      'Backups are encrypted and stored in a separate region.',
      'The marketing website is statically generated and cached.',
      'Code coverage must stay above seventy percent to merge.',
      'Quarterly planning happens in the first week of the quarter.',
      'The analytics pipeline batches events every ten minutes.',
      'Pull requests require one approval from a senior engineer.',
      'The error tracker pages the on-call engineer for new crashes.',
      'Documentation is written in Markdown and reviewed like code.',
      'The container registry prunes untagged images weekly.',
      'Secrets are rotated automatically every ninety days.',
      'The onboarding checklist takes new hires about three days.',
      'Performance budgets are enforced in continuous integration.',
      'The customer database is sharded by account region.',
      'Email notifications are sent through a dedicated service.',
      'The recommendation model retrains on a weekly schedule.',
      'Accessibility audits run before every major release.',
      'The mobile app supports both light and dark themes.',
      'Internal tools are built on a shared component library.',
      'The billing system reconciles invoices at month end.',
      'Service dashboards are reviewed in the weekly operations meeting.',
    ].join('\n');
    await host.createGraph('gnntest');
    await host.ingest('gnntest', 'clip', 'gnn:seed', {
      kind: 'markdown',
      content: gnnSeed,
      sourceRef: 'gnn:seed',
    });
    // Federated training: one model pooled across every engram.
    const run1 = await brain.reinforcement.runNeuralNetwork();
    assert(run1.trained === true, 'runNeuralNetwork must complete a federated training run when enabled');
    assert(run1.edgesAdded >= 0 && run1.edgesPruned >= 0, 'GNN run counts must be non-negative');

    // Predictions live in the encrypted `.gnn` overlay, never in the
    // deterministic `.gai` graph. The in-memory overlay and its count agree.
    const gids = host.listNodes('gnntest').map((n) => n.id);
    assert(gids.length >= 2, 'gnntest needs nodes for the overlay test');
    const overlay = brain.reinforcement.getPredictedEdges();
    assert(
      overlay.length === brain.reinforcement.countGnnEdges(),
      'getPredictedEdges() length must match countGnnEdges()',
    );
    for (const pe of overlay) {
      assert(pe.score >= 0 && pe.score <= 1, 'predicted-edge score must be in [0,1]');
      assert(
        pe.graphId.length > 0 && pe.from.length > 0 && pe.to.length > 0,
        'a predicted edge must carry graph + endpoint ids',
      );
    }

    // The `.gnn` overlay store round-trips through encrypt → disk → decrypt.
    const probe = makePredictedEdge({
      graphId: 'gnntest', from: gids[0]!, to: gids[1]!, score: 0.91, createdAt: Date.now(),
    });
    await host.saveGnnStore([probe]);
    const reloaded = await host.loadGnnStore();
    assert(
      reloaded.length === 1 && reloaded[0]!.id === probe.id && reloaded[0]!.score === 0.91,
      'the .gnn overlay must round-trip through encrypt/decrypt',
    );

    // Self-correcting re-run: re-score + prune its own predictions, add new.
    const run2 = await brain.reinforcement.runNeuralNetwork();
    assert(
      run2.trained === true && run2.edgesPruned >= 0 && run2.edgesAdded >= 0,
      'GNN re-run must complete and report non-negative prune/add counts',
    );

    // Manual undo clears the entire overlay — the `.gai` graph is untouched.
    const removed = await brain.reinforcement.removeGnnEdges();
    assert(
      brain.reinforcement.countGnnEdges() === 0,
      'no predicted edges may remain in the overlay after removal',
    );
    log('gnn-run', {
      trained: run1.trained,
      edgesAdded: run1.edgesAdded,
      gnntestNodes: gids.length,
      overlayRoundTrip: true,
      run2Pruned: run2.edgesPruned,
      undoRemoved: removed,
    });
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
