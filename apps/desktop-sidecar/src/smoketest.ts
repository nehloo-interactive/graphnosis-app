// Standalone smoke test for the host + SDK integration.
// Runs without Tauri, without MCP, without a local LLM — just exercises the
// encryption -> ingest -> recall path against @nehloo/graphnosis@0.2.3.
//
// Run with:
//   GRAPHNOSIS_CORTEX=/tmp/gn-smoke \
//   GRAPHNOSIS_PASSPHRASE=smoke-test \
//   node --enable-source-maps dist/smoketest.js
//
// On success it prints a JSON line per phase. On failure it throws.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { policy, oplog } from '@nehloo-interactive/graphnosis-secure-sync';
import { GraphnosisHost } from './host.js';
import { GraphnosisImpl } from './graphnosis-impl.js';
import { proposeCorrection, applyCorrection } from './correction.js';
import { SkillTrainer } from './skill-trainer.js';
import { BUNDLED_DOCS } from './docs-content.generated.js';
import { BUNDLED_SKILL_DEMOS } from './skill-demos.generated.js';
import { ingestGraphnosisDocs } from './docs-ingest.js';
import { runRecallLatencyRegression } from './recall-latency-benchmark.js';
import {
  isMcpToolAllowedForRole,
  mcpToolsForRole,
} from '@graphnosis-app/core/settings';
import {
  writeSessionLease,
  readSessionLease,
  clearSessionLease,
  isSessionLeaseFresh,
  isCortexSessionBusy,
} from '@graphnosis-app/core/cortex';

async function main(): Promise<void> {
  const cortexDir = process.env.GRAPHNOSIS_CORTEX ?? path.join(os.tmpdir(), `gn-smoke-${process.pid}`);
  const passphrase = process.env.GRAPHNOSIS_PASSPHRASE ?? 'smoke-test';
  await fs.rm(cortexDir, { recursive: true, force: true });

  log('setup', { cortexDir });
  const policyCfg: policy.PolicyConfig = {
    defaultBudget: policy.DEFAULT_BUDGET,
    graphs: [
      { graphId: 'personal', shareWithAi: true, tier: 'personal' },
      { graphId: 'secrets',  shareWithAi: true, tier: 'sensitive' },
    ],
  };
  const { host, recoveryPhrase } = await GraphnosisHost.open({
    cortexDir,
    passphrase,
    deviceId: 'smoke',
    adapter: new GraphnosisImpl(),
    policy: policyCfg,
  });

  // Verify first-run generates a 24-word recovery phrase and writes recovery.enc
  if (!recoveryPhrase) throw new Error('smoke: expected recoveryPhrase on first open');
  const wordCount = recoveryPhrase.trim().split(/\s+/).length;
  if (wordCount !== 24) throw new Error(`smoke: expected 24-word phrase, got ${wordCount}`);
  const recoveryEncPath = path.join(cortexDir, 'recovery.enc');
  await fs.stat(recoveryEncPath); // throws if missing
  log('recovery-phrase', { words: wordCount, recoveryEncExists: true });

  // Verify round-trip: open again with recovery phrase should succeed
  const { host: hostRecovered } = await GraphnosisHost.open({
    cortexDir,
    passphrase: '',
    deviceId: 'smoke-recovered',
    adapter: new GraphnosisImpl(),
    recoveryPhrase,
  });
  log('recovery-roundtrip', { ok: !!hostRecovered });

  // Verify passphrase rotation: change to a new passphrase, then confirm
  // both that (a) the new passphrase unlocks and (b) the old one doesn't.
  // The dataKey is preserved so all the existing engram files (when we
  // create them below) still decrypt.
  const newPassphrase = 'smoke-rotated-passphrase';
  await hostRecovered.changePassphrase(newPassphrase, { skipOldPassphraseCheck: true });
  log('passphrase-change.applied', {});
  const { host: hostNewPass } = await GraphnosisHost.open({
    cortexDir,
    passphrase: newPassphrase,
    deviceId: 'smoke-new-pass',
    adapter: new GraphnosisImpl(),
  });
  log('passphrase-change.unlock-with-new', { ok: !!hostNewPass });
  let oldPassphraseRejected = false;
  try {
    await GraphnosisHost.open({
      cortexDir,
      passphrase, // original
      deviceId: 'smoke-old-pass-should-fail',
      adapter: new GraphnosisImpl(),
    });
  } catch {
    oldPassphraseRejected = true;
  }
  log('passphrase-change.old-rejected', { ok: oldPassphraseRejected });
  if (!oldPassphraseRejected) {
    throw new Error('smoke: old passphrase should NOT unlock after rotation');
  }
  // Recovery phrase MUST still work after passphrase rotation — the dataKey
  // is unchanged, so recovery.enc still wraps it correctly.
  const { host: hostRecoveredAfterRotation } = await GraphnosisHost.open({
    cortexDir,
    passphrase: '',
    deviceId: 'smoke-recovery-after-rotation',
    adapter: new GraphnosisImpl(),
    recoveryPhrase,
  });
  log('passphrase-change.recovery-still-works', { ok: !!hostRecoveredAfterRotation });

  log('create-graph', { graphId: 'personal' });
  await host.createGraph('personal');

  const sample = `# Trip to Greece
We went to Greece in August 2020. Highlights: Santorini sunsets, Athens old town,
ferry to Naxos. The food in Mykonos was overrated.`;
  log('ingest', {});
  const src = await host.ingest('personal', 'clip', 'smoke:greece', {
    kind: 'markdown',
    content: sample,
    sourceRef: 'smoke:greece',
  });
  log('ingest.done', { sourceId: src.sourceId, nodeIds: src.nodeIds.length });

  // Query entity extraction cache: same query twice → second call hits cache.
  {
    const { cachedExtractQueryEntities, invalidateQueryEnrichmentCache, queryEnrichmentCacheStats } =
      await import('./query-enrichment-cache.js');
    invalidateQueryEnrichmentCache();
    const q = 'When did Nelu visit Romania?';
    cachedExtractQueryEntities(q);
    const afterFirst = queryEnrichmentCacheStats();
    cachedExtractQueryEntities(q);
    const afterSecond = queryEnrichmentCacheStats();
    if (afterFirst.misses !== 1 || afterFirst.hits !== 0) {
      throw new Error(`FAIL: query cache expected 1 miss on first call, got ${JSON.stringify(afterFirst)}`);
    }
    if (afterSecond.hits !== 1 || afterSecond.misses !== 1) {
      throw new Error(`FAIL: query cache expected 1 hit on second call, got ${JSON.stringify(afterSecond)}`);
    }
    log('query-enrichment-cache', { hits: afterSecond.hits, misses: afterSecond.misses, size: afterSecond.size });
  }

  const recall = await host.recall('When did the user go to Greece?', { budget: { maxTokens: 800, maxNodes: 5 } });
  log('recall', {
    tokensUsed: recall.tokensUsed,
    nodesIncluded: recall.nodesIncluded,
    graphs: [...recall.byGraph.keys()],
  });
  console.log('--- recalled context ---');
  console.log(recall.prompt);
  console.log('--- end context ---');

  // Skill compile uses empty train-time recall — personal cortex must not surface.
  log('skill-train-empty-recall', {});
  const skillTrainer = new SkillTrainer(host, null);
  const skillProbe = '# Smoke skill\n\n1. Recall anything about Greece.\n';
  const trainCtx = await skillTrainer.buildSkillContext(skillProbe, 'personal', ['personal'], 0);
  if (trainCtx.nodeCount !== 0 || trainCtx.influentialNodes.length !== 0 || trainCtx.subgraph !== '') {
    throw new Error(
      `FAIL: buildSkillContext must be empty at train time (got nodeCount=${trainCtx.nodeCount}, ` +
      `influential=${trainCtx.influentialNodes.length})`,
    );
  }
  log('skill-train-empty-recall.ok', { nodeCount: trainCtx.nodeCount, recallNodesIncluded: recall.nodesIncluded });

  log('skill-walk-structured', {});
  const walkTrain = await skillTrainer.trainSkill({
    skill: '# Walk smoke skill\n\n1. Verify step one.\n2. Verify step two.\n',
    graphId: 'personal',
    skillName: 'walk-smoke',
    save: true,
    addedBy: 'smoke:walk',
  });
  const walkSourceId = walkTrain.skillId;
  if (!walkSourceId) throw new Error('FAIL: walk smoke skill train did not return skillId');
  const { walkSkillSequence, walkSkillToJson } = await import('./skill-trainer.js');
  const walked = walkSkillSequence(host, 'personal', walkSourceId, { recursive: false });
  if (walked.steps.length < 2) {
    throw new Error(`FAIL: walkSkillSequence expected ≥2 steps, got ${walked.steps.length}`);
  }
  const walkJson = walkSkillToJson(walked, { sourceId: walkSourceId, title: 'Walk smoke skill' });
  if (!walkJson.skill?.sourceId || !Array.isArray(walkJson.steps) || walkJson.steps.length < 2) {
    throw new Error('FAIL: walkSkillToJson missing skill metadata or steps');
  }
  if (!walkJson.steps.every((s) => typeof s.index === 'number' && typeof s.text === 'string')) {
    throw new Error('FAIL: walkSkillToJson steps malformed');
  }
  log('skill-walk-structured.ok', { steps: walkJson.steps.length, requires: walkJson.requires?.length ?? 0 });

  // --- Ghampus skill maintenance — queue → idle tick → retrain one ----------
  log('skill-maintenance', {});
  const { enqueueSkillsForNodeChange, countSkillRetrainQueue, persistSkillCitedNodes } = await import('./skill-retrain-queue.js');
  const citedNode = src.nodeIds[0]!;
  await persistSkillCitedNodes(host, walkSourceId, 'personal', [citedNode]);
  await enqueueSkillsForNodeChange(host, 'personal', [citedNode], 'source-edited', skillTrainer);
  if (countSkillRetrainQueue(host) !== 1) {
    throw new Error(`FAIL: expected 1 queued stale skill, got ${countSkillRetrainQueue(host)}`);
  }
  await host.setSettings({
    ...host.getSettings(),
    agent: { enabled: true, skillMaintenance: { enabled: true, idleOnly: false } },
  });
  const { SkillMaintenanceScheduler } = await import('./skill-maintenance-scheduler.js');
  const { resetGhampusBusyForTest } = await import('./ghampus-busy.js');
  resetGhampusBusyForTest();
  const maintEvents: unknown[] = [];
  const scheduler = new SkillMaintenanceScheduler({
    host,
    skillTrainer,
    broadcastRaw: (frame) => { maintEvents.push(frame); },
    licenseValidator: { hasFeature: () => true } as unknown as import('./license-validator.js').LicenseValidator,
  });
  const tick = await scheduler.tickForTest();
  if (tick.action !== 'retrain') {
    throw new Error(`FAIL: skill maintenance tick expected retrain, got ${tick.action} (${tick.detail ?? ''})`);
  }
  if (countSkillRetrainQueue(host) !== 0) {
    throw new Error('FAIL: skillRetrainQueue should be drained after maintenance retrain');
  }
  log('skill-maintenance.ok', { action: tick.action, detail: tick.detail });

  // --- SOP-preserving rewrite validation (no live LLM) ----------------------
  log('skill-sop-preservation', {});
  const { validateSopPreservation, extractSopPreservationSnapshot } = await import('./skill-sop-rewrite.js');
  const sopSample = [
    'Trigger: user asks to deploy',
    '1. Check CI @skill: verify-ci',
    '2. Deploy @loop: 1 max=3',
    'Requires: $branch',
  ].join('\n');
  const snap = extractSopPreservationSnapshot(sopSample);
  if (!snap.tokens.some((t) => t.includes('@skill:'))) {
    throw new Error('FAIL: extractSopPreservationSnapshot missed @skill: token');
  }
  const goodRewrite = sopSample.replace('Check CI', 'Verify CI status');
  const goodCheck = validateSopPreservation(sopSample, goodRewrite);
  if (!goodCheck.ok) throw new Error(`FAIL: valid rewrite rejected: ${goodCheck.missing.join(', ')}`);
  const badRewrite = sopSample.replace('@skill: verify-ci', '@skill: run-tests');
  const badCheck = validateSopPreservation(sopSample, badRewrite);
  if (badCheck.ok) throw new Error('FAIL: rewrite that changed @skill: name should fail validation');
  log('skill-sop-preservation.ok', { tokenCount: snap.tokens.length });

  // --- Model provider API key encrypt round-trip + cloud dispatch gating ----
  log('model-provider-keys', {});
  const { requireProviderApiKey } = await import('./cloud-llm.js');
  let missingKeyErr = '';
  try {
    requireProviderApiKey(host, 'anthropic');
  } catch (e) {
    missingKeyErr = (e as Error).message;
  }
  if (!missingKeyErr.includes('requires a configured API key')) {
    throw new Error(`FAIL: expected missing-key error, got: ${missingKeyErr}`);
  }
  await host.setSettings({
    ...host.getSettings(),
    models: {
      providers: {
        ollama: { enabled: true },
        anthropic: { enabled: true, apiKey: 'sk-ant-smoke-test-key', hasKey: true, keyTail: '-key' },
      },
      strategy: 'adaptive',
    },
  });
  const loadedKey = requireProviderApiKey(host, 'anthropic');
  if (loadedKey !== 'sk-ant-smoke-test-key') throw new Error('FAIL: provider API key not readable in-memory');
  const settingsRaw = await fs.readFile(path.join(cortexDir, 'settings.json'), 'utf8');
  if (settingsRaw.includes('sk-ant-smoke-test-key')) {
    throw new Error('FAIL: provider API key leaked plaintext into settings.json');
  }
  if (!settingsRaw.includes('apiKeyEnc')) {
    throw new Error('FAIL: provider API key not encrypted to apiKeyEnc on disk');
  }
  log('model-provider-keys.ok', { keyTail: host.getSettings().models?.providers?.anthropic?.keyTail });

  // --- op-log merge on loadGraph (before supersede correction) ------------
  log('oplog-merge-roundtrip', {});
  const gaiPath = path.join(cortexDir, 'graphs', 'personal.gai');
  const bundlePath = path.join(cortexDir, 'graphs', 'personal.bundle');
  const staleGaiBytes = await fs.readFile(gaiPath);
  const staleBundleBytes = await fs.readFile(bundlePath);
  const mergeNodeId = src.nodeIds[1] ?? src.nodeIds[0]!;
  await host.applyCorrection('personal', {
    edits: [{
      kind: 'edit',
      nodeId: mergeNodeId,
      content: 'We went to Greece in September 2020 (op-log merge smoke).',
      reason: 'smoke:oplog-merge',
    }],
  });
  const mergeEvents = (await host.listOplogEvents()).filter((e) => e.graphId === 'personal');
  const reduced = oplog.reduce(mergeEvents).get('personal');
  const mergedNode = reduced?.nodes.get(mergeNodeId);
  const mergedContent = (mergedNode?.data as { content?: string } | undefined)?.content;
  if (typeof mergedContent !== 'string' || !mergedContent.includes('September 2020 (op-log merge smoke)')) {
    throw new Error('FAIL: op-log reduce did not merge editNode into canonical node state');
  }
  const mtimeBeforeReconcile = (await fs.stat(gaiPath)).mtimeMs;
  await fs.writeFile(gaiPath, staleGaiBytes);
  await fs.writeFile(bundlePath, staleBundleBytes);
  await fs.unlink(path.join(cortexDir, 'graphs', 'personal.embcache')).catch(() => {});
  const { host: mergedHost } = await GraphnosisHost.open({
    cortexDir,
    passphrase: newPassphrase,
    deviceId: 'smoke-oplog-merge',
    adapter: new GraphnosisImpl(),
    policy: policyCfg,
  });
  await mergedHost.loadGraph('personal');
  const mtimeAfterReconcile = (await fs.stat(gaiPath)).mtimeMs;
  if (mtimeAfterReconcile <= mtimeBeforeReconcile) {
    throw new Error('FAIL: loadGraph reconcile did not materialize op-log edits to .gai');
  }
  log('oplog-merge-roundtrip.ok', { mergeEventCount: mergeEvents.length, materialized: true });

  // --- op-log tail replay + checkpoint (Batch 6 v2) -------------------------
  log('oplog-tail-checkpoint', {});
  const { crypto: gnCrypto } = await import('@nehloo-interactive/graphnosis-secure-sync');
  const { DeviceIdentity } = await import('./device-identity.js');
  const saltBytes = new Uint8Array(await fs.readFile(path.join(cortexDir, 'salt.bin')));
  const wrap = await gnCrypto.deriveKey(newPassphrase, saltBytes);
  const masterBlob = new Uint8Array(await fs.readFile(path.join(cortexDir, 'master.enc')));
  const dataKey = await gnCrypto.decrypt(masterBlob, wrap.key);
  const ident = await DeviceIdentity.loadOrCreate(cortexDir, dataKey);
  const oplogDir = path.join(cortexDir, 'oplog');
  const tailWriter = new oplog.OpLogWriter({
    dir: oplogDir,
    deviceId: ident.deviceId,
    key: dataKey,
    salt: saltBytes,
    signSecretKey: ident.signSecretKey,
    initialSeq: ident.initialSeq,
    persistSeq: ident.persistSeq.bind(ident),
  });
  const readTailOpts = {
    getDevicePubKey: (d: string) => ident.getPubKey(d),
    onIntegrityIssue: () => {},
  };
  let tailCheckpoint = { maxTs: 0, maxSeq: -1 };
  for (let i = 0; i < 100; i++) {
    const emitted = tailWriter.emit({
      graphId: 'personal',
      op: 'merge',
      target: { kind: 'source', id: '__tail-smoke' },
      after: { phase: 'pre', i },
    });
    if (i === 99) tailCheckpoint = { maxTs: emitted.ts, maxSeq: emitted.seq! };
  }
  await tailWriter.flush();
  await new Promise((r) => setTimeout(r, 50));
  await mergedHost.setGraphMetadata('personal', {
    ...(mergedHost.getSettings().graphMetadata.personal ?? {
      template: 'personal',
      displayName: 'personal',
      createdAt: Date.now(),
    }),
    oplogReconcileCheckpoint: tailCheckpoint,
  });
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 10; i++) {
    tailWriter.emit({
      graphId: 'personal',
      op: 'merge',
      target: { kind: 'source', id: '__tail-smoke' },
      after: { phase: 'tail', i },
    });
  }
  await tailWriter.flush();
  await new Promise((r) => setTimeout(r, 50));
  const tailEvents = await oplog.readEventsSince(oplogDir, dataKey, {
    sinceTs: tailCheckpoint.maxTs,
    ...(tailCheckpoint.maxSeq !== undefined ? { sinceSeq: tailCheckpoint.maxSeq } : {}),
    ...readTailOpts,
  });
  if (tailEvents.length !== 10) {
    throw new Error(`FAIL: readEventsSince expected 10 tail events, got ${tailEvents.length}`);
  }
  await mergedHost.unloadGraph('personal');
  await mergedHost.loadGraph('personal');
  await mergedHost.waitForReconcile('personal');
  const nodesAfterTailReconcile = mergedHost.listNodes('personal').length;
  if (nodesAfterTailReconcile === 0) {
    throw new Error('FAIL: tail reconcile wiped all nodes (adapter.build on fromBuffer handle)');
  }
  const ckAfterLoad = mergedHost.getSettings().graphMetadata.personal?.oplogReconcileCheckpoint;
  if (!ckAfterLoad || ckAfterLoad.maxTs <= tailCheckpoint.maxTs) {
    throw new Error('FAIL: loadGraph tail reconcile did not advance checkpoint');
  }
  const tailAfterLoad = await oplog.readEventsSince(oplogDir, dataKey, {
    sinceTs: ckAfterLoad.maxTs,
    ...(ckAfterLoad.maxSeq !== undefined ? { sinceSeq: ckAfterLoad.maxSeq } : {}),
    ...readTailOpts,
  });
  if (tailAfterLoad.length !== 0) {
    throw new Error(`FAIL: expected no tail events after loadGraph checkpoint, got ${tailAfterLoad.length}`);
  }
  log('oplog-tail-checkpoint.ok', { tailCount: tailEvents.length, checkpoint: ckAfterLoad, nodes: nodesAfterTailReconcile });

  // --- boot deferred reconcile: nodes visible after flush (3D / list_nodes) ---
  log('boot-deferred-reconcile', {});
  await mergedHost.unloadGraph('personal');
  mergedHost.setBootPhaseActive(true);
  mergedHost.setBootSweepActive(true);
  await mergedHost.loadGraph('personal');
  const bootPreFlush = mergedHost.listNodes('personal').length;
  if (bootPreFlush === 0) {
    throw new Error('FAIL: loadGraph committed 0 nodes before boot reconcile flush');
  }
  mergedHost.setBootSweepActive(false);
  mergedHost.setBootPhaseActive(false);
  await mergedHost.flushBootDeferredWork();
  const bootPostFlush = mergedHost.listNodes('personal').length;
  if (bootPostFlush === 0) {
    throw new Error('FAIL: boot flushBootDeferredWork left engram with 0 nodes');
  }
  log('boot-deferred-reconcile.ok', { preFlush: bootPreFlush, postFlush: bootPostFlush });

  // --- oplog housekeeping (refreshAllCorrectionsFromOplog → compactOplogIfNeeded) ---
  // Smoketest corpus is far below the 500k compaction threshold; this verifies
  // the wired path completes without error. Real compaction needs a mature cortex.
  log('oplog-housekeeping', {});
  const housekeeping = await mergedHost.refreshAllCorrectionsFromOplog();
  if (typeof housekeeping.compaction?.compacted !== 'boolean') {
    throw new Error('FAIL: refreshAllCorrectionsFromOplog must return compaction result');
  }
  log('oplog-housekeeping.ok', { compacted: housekeeping.compaction.compacted });

  // --- deterministic correction (no LLM) -----------------------------------
  // `correct` must work with no Local LLM configured: it deterministically
  // supersedes the closest-matching memory with the correction text. The core
  // guarantee is reproducibility — identical input yields an identical diff.
  log('correct-deterministic', {});
  const correctionText = 'Actually, we went to Greece in September 2020, not August.';
  const c1 = await proposeCorrection({ host, correction: correctionText, graphIdHint: 'personal' });
  const c2 = await proposeCorrection({ host, correction: correctionText, graphIdHint: 'personal' });
  if (c1.mode !== 'deterministic') throw new Error(`FAIL: correct should be deterministic with no LLM, got mode '${c1.mode}'`);
  if (JSON.stringify(c1.diff) !== JSON.stringify(c2.diff)) {
    throw new Error('FAIL: deterministic correction is not reproducible — diffs differ between runs');
  }
  const edit0 = c1.diff.edits[0];
  if (c1.diff.edits.length !== 1 || !edit0 || edit0.kind !== 'supersede') {
    throw new Error(`FAIL: expected exactly one supersede edit, got ${JSON.stringify(c1.diff.edits)}`);
  }
  if (edit0.content !== correctionText) {
    throw new Error('FAIL: supersede edit should carry the verbatim correction text');
  }
  if (c1.targetGraphId !== 'personal') {
    throw new Error(`FAIL: correction should target 'personal', got ${String(c1.targetGraphId)}`);
  }
  await applyCorrection({ host, graphId: 'personal', diff: c1.diff });
  log('correct-deterministic.applied', { supersededNode: edit0.nodeId, reproducible: true });

  // --- GNN-expanded correction (Neural Network on) -------------------------
  // With a GNN expander supplying a high-confidence predicted neighbour, the
  // candidate set expands and the supersede target is re-ranked to it — this
  // is what makes `correct` genuinely GNN-influenced (and non-deterministic).
  log('correct-gnn-expanded', {});
  const gnnResult = await proposeCorrection({
    host,
    correction: correctionText,
    graphIdHint: 'personal',
    expandWithGnn: async () => [
      { graphId: 'personal', nodeId: 'gnn-predicted-node', text: 'a GNN-surfaced memory', gnnScore: 0.99 },
    ],
  });
  if (gnnResult.mode !== 'gnn-expanded') {
    throw new Error(`FAIL: expected mode 'gnn-expanded', got '${gnnResult.mode}'`);
  }
  const gnnEdit = gnnResult.diff.edits[0];
  if (!gnnEdit || gnnEdit.kind !== 'supersede' || gnnEdit.nodeId !== 'gnn-predicted-node') {
    throw new Error(`FAIL: a high-confidence GNN candidate should become the supersede target, got ${JSON.stringify(gnnResult.diff.edits)}`);
  }
  if (!gnnResult.candidates.some(c => c.viaGnn)) {
    throw new Error('FAIL: GNN-expanded candidate set should include a viaGnn candidate');
  }
  log('correct-gnn-expanded.ok', { supersededNode: gnnEdit.nodeId, candidates: gnnResult.candidates.length });

  log('encrypted-on-disk-check', {});
  const aikgPath = path.join(cortexDir, 'graphs', 'personal.gai');
  const raw = await fs.readFile(aikgPath);
  if (raw.includes(Buffer.from('Santorini'))) {
    throw new Error('FAIL: plaintext leak — found "Santorini" in .aikg on disk');
  }
  log('encrypted-on-disk-check.ok', { bytes: raw.length });

  // --- save guards: empty shell, shrink, .lkg auto-restore ----------------
  log('save-guards', {});
  const guardId = 'empty-save-guard';
  await host.createGraph(guardId);
  const guardSrc = await host.ingest(guardId, 'clip', 'smoke://empty-guard', {
    kind: 'text',
    content: 'guard-payload-' + 'x'.repeat(60_000),
    sourceRef: 'smoke://empty-guard',
  });
  const guardGai = path.join(cortexDir, 'graphs', `${guardId}.gai`);
  const guardLkg = `${guardGai}.lkg`;
  const guardStat = await fs.stat(guardGai);
  if (guardStat.size < 10 * 1024) {
    throw new Error(`FAIL: save-guards test engram not substantial (${guardStat.size}B)`);
  }
  const goodGaiBytes = await fs.readFile(guardGai);
  const goodGaiCopy = `${guardGai}.good-copy`;
  await fs.copyFile(guardGai, goodGaiCopy);
  await host.unloadGraph(guardId);
  const donorId = 'empty-donor';
  await host.createGraph(donorId);
  const emptyShell = await fs.readFile(path.join(cortexDir, 'graphs', `${donorId}.gai`));
  await host.deleteGraph(donorId);
  // Empty-save: in-memory 0-node shell while on-disk .gai is still substantial
  // (reconcile-before-save pattern — must not persist the empty graph).
  try { await fs.unlink(guardLkg); } catch { /* none yet */ }
  await fs.writeFile(guardGai, emptyShell);
  await host.loadGraph(guardId);
  if (host.listNodes(guardId).length !== 0) {
    throw new Error('FAIL: save-guards empty-save expected 0 nodes from empty shell load');
  }
  await fs.copyFile(goodGaiCopy, guardGai);
  const gaiBytesBefore = await fs.readFile(guardGai);
  host.markGraphDirty(guardId);
  await host.save(guardId);
  const gaiBytesAfter = await fs.readFile(guardGai);
  if (!gaiBytesBefore.equals(gaiBytesAfter)) {
    throw new Error('FAIL: empty-save-guard allowed .gai overwrite on blocked save');
  }
  await fs.unlink(goodGaiCopy);
  log('empty-save-guard.ok', { gaiBytes: gaiBytesBefore.length });

  // Tiny .gai + substantial .lkg → auto-restore on load (writings-qtb9 pattern).
  host.markGraphClean(guardId);
  await host.unloadGraph(guardId);
  await fs.writeFile(guardGai, emptyShell);
  await fs.writeFile(guardLkg, goodGaiBytes);
  await host.loadGraph(guardId);
  const restoredNodes = host.listNodes(guardId).length;
  if (restoredNodes === 0) {
    throw new Error('FAIL: tiny-gai-lkg-restore expected nodes after promoting .lkg');
  }
  let lkgStillThere = false;
  try { await fs.stat(guardLkg); lkgStillThere = true; } catch { /* promoted */ }
  if (lkgStillThere) {
    throw new Error('FAIL: tiny-gai-lkg-restore expected .lkg promoted to .gai');
  }
  log('tiny-gai-lkg-restore.ok', { nodes: restoredNodes });

  // Shrink-save: tiny in-memory graph must not clobber substantial .gai/.lkg.
  const shrinkId = 'shrink-save-guard';
  await host.createGraph(shrinkId);
  await host.ingest(shrinkId, 'clip', 'smoke://shrink-guard', {
    kind: 'text',
    content: 'shrink-payload-' + 'y'.repeat(60_000),
    sourceRef: 'smoke://shrink-guard',
  });
  const shrinkGai = path.join(cortexDir, 'graphs', `${shrinkId}.gai`);
  const shrinkLkg = `${shrinkGai}.lkg`;
  const shrinkBefore = (await fs.stat(shrinkGai)).size;
  if (shrinkBefore < 10 * 1024) {
    throw new Error(`FAIL: shrink-save-guard test engram not substantial (${shrinkBefore}B)`);
  }
  const shrinkGoodCopy = `${shrinkGai}.good-copy`;
  await fs.copyFile(shrinkGai, shrinkGoodCopy);
  await host.unloadGraph(shrinkId);
  await fs.writeFile(shrinkGai, emptyShell);
  try { await fs.unlink(shrinkLkg); } catch { /* none */ }
  await host.loadGraph(shrinkId);
  await host.ingest(shrinkId, 'clip', 'smoke://shrink-tiny', {
    kind: 'text',
    content: 'tiny',
    sourceRef: 'smoke://shrink-tiny',
  });
  await fs.copyFile(shrinkGoodCopy, shrinkGai);
  await fs.writeFile(shrinkLkg, await fs.readFile(shrinkGoodCopy));
  const shrinkGaiMid = await fs.readFile(shrinkGai);
  const shrinkLkgMid = await fs.readFile(shrinkLkg);
  await host.save(shrinkId);
  const shrinkGaiAfter = await fs.readFile(shrinkGai);
  const shrinkLkgAfter = await fs.readFile(shrinkLkg);
  if (!shrinkGaiMid.equals(shrinkGaiAfter) || !shrinkLkgMid.equals(shrinkLkgAfter)) {
    throw new Error('FAIL: shrink-save-guard allowed .gai/.lkg shrink overwrite');
  }
  await fs.unlink(shrinkGoodCopy);
  log('shrink-save-guard.ok', { onDiskBytes: shrinkBefore });

  await host.deleteGraph(guardId);
  await host.deleteGraph(shrinkId);
  log('save-guards.ok', {});

  // --- MCP audit log -------------------------------------------------------
  log('mcp-audit', {});
  await host.appendMcpAuditEvent({
    tool: 'recall',
    clientId: 'smoke-test',
    transport: 'stdio',
    queryLen: 42,
    queryHash: 'abc123deadbeef',
    engramIds: ['personal'],
    tokenBudget: { servedTokens: 100, servedNodes: 3 },
  });
  const auditRows = await host.listMcpAuditEvents();
  const smokeRow = auditRows.find((r) => r.clientId === 'smoke-test' && r.tool === 'recall');
  if (!smokeRow) throw new Error('FAIL: MCP audit row not persisted');
  if (smokeRow.queryHash !== 'abc123deadbeef') {
    throw new Error('FAIL: MCP audit export missing queryHash');
  }
  const byClient = auditRows.filter((r) => r.clientId === 'smoke-test');
  if (!byClient.some((r) => r.tool === 'recall' && r.queryHash === 'abc123deadbeef')) {
    throw new Error('FAIL: MCP audit list filter by client would miss smoke row');
  }
  log('mcp-audit.ok', { rows: auditRows.length });

  // --- Compliance Mode v1: legal hold + evidence pack + recall_as_of --------
  log('compliance-legal-hold', {});
  await host.setEngramPreserve('personal', true, 'smoke-matter');
  let holdBlocked = false;
  try {
    await host.forgetSource('personal', src.sourceId, { triggeredBy: 'user:forget' });
  } catch (e) {
    holdBlocked = (e as { code?: string }).code === 'legal_hold';
  }
  if (!holdBlocked) throw new Error('FAIL: forgetSource should be blocked under engram legal hold');
  await host.setEngramPreserve('personal', false);
  log('compliance-legal-hold.ok', { blocked: true });

  log('compliance-evidence-pack', {});
  const { buildEvidencePack, recallAsOf } = await import('./compliance.js');
  const pack = await buildEvidencePack(host, cortexDir, { engram: 'personal' });
  if (pack.version !== 1 || pack.oplog.count < 1) {
    throw new Error('FAIL: evidence pack missing op-log slice');
  }
  if (pack.mcpAudit.count < 1) {
    throw new Error('FAIL: evidence pack missing MCP audit rows');
  }
  if (!pack.engramHashes.some((h) => h.graphId === 'personal' && h.gaiSha256.length === 64)) {
    throw new Error('FAIL: evidence pack missing engram hash');
  }
  log('compliance-evidence-pack.ok', {
    oplog: pack.oplog.count,
    mcp: pack.mcpAudit.count,
    hashes: pack.engramHashes.length,
  });

  log('compliance-recall-as-of', {});
  const pit = await recallAsOf(host, 'Greece', {
    graphId: 'personal',
    asOfTs: Date.now() + 60_000,
    maxNodes: 10,
  });
  if (!pit.matches.some((m) => m.preview.toLowerCase().includes('greece'))) {
    throw new Error('FAIL: recall_as_of did not surface Greece memory at boundary');
  }
  log('compliance-recall-as-of.ok', { matches: pit.matches.length });

  log('forget', { sourceId: src.sourceId });
  const forgot = await host.forgetSource('personal', src.sourceId);
  log('forget.done', { soft_deleted: forgot.nodeIds.length });

  log('recall-after-forget', {});
  const after = await host.recall('When did the user go to Greece?', { budget: { maxTokens: 800, maxNodes: 5 } });
  log('recall-after-forget.done', { nodesIncluded: after.nodesIncluded });

  // --- sensitivity-tier check ----------------------------------------------
  log('sensitive-graph-create', { graphId: 'secrets' });
  await host.createGraph('secrets');

  // Seed the sensitive graph with > 5 nodes so we can prove the tier cap clamps to 5.
  const big = Array.from({ length: 12 }, (_, i) =>
    `# Secret note ${i + 1}\nThis is secret detail number ${i + 1}. The codeword is alpha-${i + 1}.`,
  ).join('\n\n');
  await host.ingest('secrets', 'clip', 'smoke:secrets', {
    kind: 'markdown',
    content: big,
    sourceRef: 'smoke:secrets',
  });
  // MCP consent gate reads sensitivityTier from engram metadata (policyCfg alone
  // is not enough). UI tier edits write metadata; mirror that for smoke MCP tests.
  const secretsMeta = host.getGraphMetadata('secrets') ?? {
    template: 'personal' as const,
    displayName: 'secrets',
    createdAt: Date.now(),
  };
  await host.setGraphMetadata('secrets', { ...secretsMeta, sensitivityTier: 'sensitive' });

  log('maxed-recall-sensitive', { requested: { maxNodes: 50, maxTokens: 8000 } });
  const maxed = await host.recall('What is the codeword?', {
    budget: { maxTokens: 8000, maxNodes: 50 },
  });
  const secretsAudit = maxed.audit.find(a => a.graphId === 'secrets');
  log('maxed-recall-sensitive.done', {
    nodesIncluded: maxed.nodesIncluded,
    tokensUsed: maxed.tokensUsed,
    secretsAudit,
  });
  // Sensitive-tier federation backstop (security finding #11). The smoke policy
  // (above) deliberately decouples tier from the share flag — secrets is
  // tier:'sensitive' AND shareWithAi:true, the unsafe combination an env-supplied
  // policy could produce. A federated (unscoped) recall must NEVER surface a
  // sensitive engram regardless of that flag, so secrets must contribute zero
  // nodes (and is absent from the shareable audit trail entirely).
  if (secretsAudit && secretsAudit.nodesIncluded > 0) {
    throw new Error(
      `FAIL: sensitive engram leaked into a federated recall — ${secretsAudit.nodesIncluded} nodes. ` +
      `The tier backstop must exclude sensitive engrams from federation even when shareWithAi is true.`,
    );
  }
  log('sensitive-tier-excluded.ok', { includedFromSecrets: secretsAudit?.nodesIncluded ?? 0 });

  // ── Explicit + consented sensitive recall DOES return data, clamped to cap ──
  // The flip side of the backstop: when the user explicitly names a sensitive
  // engram and consent has passed, the recall must return its data (the docs'
  // "you'll receive results once you click Allow"), bounded by the tier cap
  // (≤5 nodes / ≤500 tokens). `consentedGraphIds` is what the MCP layer passes
  // after checkConsentOrThrow approves an explicitly-named engram.
  const consented = await host.recall('What is the codeword?', {
    budget: { maxTokens: 8000, maxNodes: 50 },
    onlyGraphIds: ['secrets'],
    consentedGraphIds: ['secrets'],
  });
  const consentedAudit = consented.audit.find(a => a.graphId === 'secrets');
  if (!consentedAudit || consentedAudit.nodesIncluded === 0) {
    throw new Error('FAIL: a consented, explicitly-named sensitive engram returned no data');
  }
  if (consentedAudit.nodesIncluded > 5) {
    throw new Error(`FAIL: sensitive-tier node cap not enforced — got ${consentedAudit.nodesIncluded} (max 5)`);
  }
  if (consentedAudit.tokensIncluded > 500) {
    throw new Error(`FAIL: sensitive-tier token cap not enforced — got ${consentedAudit.tokensIncluded} (max 500)`);
  }
  log('sensitive-consented-recall.ok', { nodes: consentedAudit.nodesIncluded, tokens: consentedAudit.tokensIncluded });

  // ── Headless consent flow (MCP confirm_data_access) ─────────────────────
  // Real MCP path — not the host-level consentedGraphIds bypass above.
  // No broadcastRaw → headless phrase notice (SSH/CI), not the in-app modal.
  // Phrase: same helper as Settings → AI → Consent Phrases (optional
  // GRAPHNOSIS_SMOKE_CONSENT_PHRASE env for local debugging only).
  // Procedure: security-review-cadence / sidecar-change-verify skills.
  log('consent-headless-flow', {});
  const { createMcpServer, getConsentPhraseForTier } = await import('./mcp-server.js');
  const { mcpRegistry } = await import('./mcp-registry.js');
  const consentPendingDiffs = new Map<string, { graphId: string; diff: import('./correction.js').CorrectionDiff; createdAt: number }>();
  const { callTool: callMcpTool } = createMcpServer({
    host,
    cortexDir,
    llm: () => null,
    defaultGraphId: () => 'personal',
    pendingDiffs: consentPendingDiffs,
  });
  const smokeMcpClient = 'smoke-mcp-consent';
  const smokeConnId = mcpRegistry.register('stdio');
  mcpRegistry.setClientInfo(smokeConnId, smokeMcpClient, 'smoke-1.0');
  try {
    const blocked = await callMcpTool('recall', {
      query: 'What is the codeword?',
      only_engrams: ['secrets'],
      maxTokens: 8000,
      maxNodes: 50,
    });
    if (!blocked.isError) {
      throw new Error('FAIL: sensitive MCP recall should require consent before confirm_data_access');
    }
    const blockedText = blocked.content.map((c) => c.text).join('\n');
    if (!blockedText.includes('GRAPHNOSIS CONSENT REQUIRED')) {
      throw new Error(`FAIL: expected consent-required notice, got: ${blockedText.slice(0, 240)}`);
    }
    log('consent-headless-flow.blocked', { noticeLen: blockedText.length });

    const wrongPhrase = await callMcpTool('confirm_data_access', {
      phrase: 'acorn adapt affix',
      tier: 'sensitive',
      engrams: ['secrets'],
    });
    if (!wrongPhrase.isError) {
      throw new Error('FAIL: wrong consent phrase should be rejected');
    }
    log('consent-headless-flow.wrong-phrase-rejected', {});

    const hmacKey = await host.getOrCreateConsentHmacKey();
    const phrase =
      process.env.GRAPHNOSIS_SMOKE_CONSENT_PHRASE?.trim()
      || getConsentPhraseForTier(hmacKey, 'sensitive').phrase;

    const confirmed = await callMcpTool('confirm_data_access', {
      phrase,
      tier: 'sensitive',
      engrams: ['secrets'],
    });
    if (confirmed.isError) {
      throw new Error(
        `FAIL: confirm_data_access with valid phrase failed: ${confirmed.content.map((c) => c.text).join('\n')}`,
      );
    }
    const confirmText = confirmed.content.map((c) => c.text).join('\n');
    if (!confirmText.toLowerCase().includes('consent recorded')) {
      throw new Error(`FAIL: unexpected confirm_data_access response: ${confirmText.slice(0, 240)}`);
    }
    log('consent-headless-flow.confirmed', {});

    const afterConsent = await callMcpTool('recall', {
      query: 'What is the codeword?',
      only_engrams: ['secrets'],
      maxTokens: 8000,
      maxNodes: 50,
    });
    if (afterConsent.isError) {
      throw new Error(
        `FAIL: recall after consent should succeed: ${afterConsent.content.map((c) => c.text).join('\n')}`,
      );
    }
    const afterText = afterConsent.content.map((c) => c.text).join('\n');
    if (!afterText.includes('alpha-') && !afterText.toLowerCase().includes('codeword')) {
      throw new Error('FAIL: consented MCP recall returned no secret content');
    }
    log('consent-headless-flow.ok', { servedLen: afterText.length });
  } finally {
    mcpRegistry.unregister(smokeConnId);
  }

  // --- bundled docs --------------------------------------------------------
  // The Graphnosis docs ship inside the app — scripts/generate-docs-content.mjs
  // regenerates docs-content.generated.ts from apps/docs on every build. The
  // docs-ingest feature reads this bundle directly (no network), so it must be
  // present and well-formed.
  log('bundled-docs', {});
  if (!Array.isArray(BUNDLED_DOCS) || BUNDLED_DOCS.length === 0) {
    throw new Error('FAIL: BUNDLED_DOCS is empty — scripts/generate-docs-content.mjs did not run');
  }
  for (const d of BUNDLED_DOCS) {
    if (!d.slug || typeof d.markdown !== 'string' || d.markdown.length === 0) {
      throw new Error(`FAIL: malformed bundled doc — ${JSON.stringify(d).slice(0, 120)}`);
    }
  }
  log('bundled-docs.ok', { pages: BUNDLED_DOCS.length });

  // ── Bundled skill-demos integrity ──────────────────────────────────────
  // The three signed Graphnosis demo .gsk packs ship inside the sidecar.
  // scripts/generate-skill-demos-content.mjs reads dist/packs/bundle/*.gsk
  // and base64-encodes them into skill-demos.generated.ts. The sidecar
  // ingests them into the `Skill Demos` engram on first cortex unlock
  // (or app-version bump). If this array is empty in CI, the build
  // pipeline broke — fail fast rather than ship a binary that silently
  // can't onboard new users.
  log('bundled-skill-demos', {});
  if (!Array.isArray(BUNDLED_SKILL_DEMOS) || BUNDLED_SKILL_DEMOS.length === 0) {
    // The bundle is generated from the gitignored pack content
    // (default-skill-packs.ts) + the GSK_SIGNING_KEY_HEX signing key — neither
    // of which exists in environments like the Linux-server CI, so an empty
    // bundle is EXPECTED there. Skip (with a loud log) when explicitly allowed;
    // otherwise fail, so the release pipeline (which DOES build signed packs and
    // does NOT set this flag) still catches a forgotten pack build.
    if (process.env.GRAPHNOSIS_SMOKE_ALLOW_EMPTY_DEMOS === '1') {
      log('bundled-skill-demos.skipped', { reason: 'empty bundle allowed — no pack content / signing key in this environment' });
    } else {
      throw new Error(
        'FAIL: BUNDLED_SKILL_DEMOS is empty — node scripts/build-gsk.mjs --sign && ' +
        'apps/desktop-sidecar/scripts/generate-skill-demos-content.mjs must run before build. ' +
        '(Set GRAPHNOSIS_SMOKE_ALLOW_EMPTY_DEMOS=1 in environments that cannot build signed packs.)',
      );
    }
  } else {
    for (const d of BUNDLED_SKILL_DEMOS) {
      if (!d.id || !d.filename || typeof d.gskBase64 !== 'string' || d.gskBase64.length === 0) {
        throw new Error(`FAIL: malformed bundled skill demo — ${JSON.stringify({ id: d.id, filename: d.filename, base64Len: d.gskBase64?.length }).slice(0, 200)}`);
      }
      // Sanity check the base64 decodes to a non-trivial .gsk header
      // (the format starts with a 4-byte magic string per gsk-format.ts).
      const decodedLen = Buffer.from(d.gskBase64, 'base64').byteLength;
      if (decodedLen < 64) {
        throw new Error(`FAIL: bundled skill demo ${d.id} decoded to only ${decodedLen} bytes — corrupt`);
      }
    }
    log('bundled-skill-demos.ok', { packs: BUNDLED_SKILL_DEMOS.length });
  }

  // --- enterprise RBAC matrix (Batch 4) ------------------------------------
  log('rbac-matrix', {});
  if (isMcpToolAllowedForRole('remember', 'recall-only')) {
    throw new Error('FAIL: recall-only role must not allow remember');
  }
  if (!isMcpToolAllowedForRole('remember', 'editor')) {
    throw new Error('FAIL: editor role must allow remember');
  }
  const auditTools = mcpToolsForRole('admin-audit');
  if (!auditTools.includes('recall_as_of') || !auditTools.includes('audit_memory')) {
    throw new Error('FAIL: admin-audit role must include recall_as_of and audit_memory');
  }
  const trainerTools = mcpToolsForRole('skill-train');
  if (!trainerTools.includes('train_skill') || !trainerTools.includes('export_skill')) {
    throw new Error('FAIL: skill-train role tool set mismatch');
  }
  log('rbac-matrix.ok', {
    recallOnlyTools: mcpToolsForRole('recall-only').length,
    adminAuditTools: auditTools.length,
  });

  // --- enterprise SSO group → role mapping --------------------------------
  log('sso-group-role', {});
  const { resolveRoleFromIdpGroups } = await import('@graphnosis-app/core/settings');
  const mappings = [
    { idpGroup: 'graphnosis-viewers', role: 'recall-only' as const },
    { idpGroup: 'graphnosis-editors', role: 'editor' as const },
    { idpGroup: 'graphnosis-audit', role: 'admin-audit' as const },
  ];
  const resolved = resolveRoleFromIdpGroups(mappings, ['graphnosis-viewers', 'graphnosis-editors']);
  if (resolved !== 'editor') {
    throw new Error(`FAIL: expected editor from dual groups, got ${resolved}`);
  }
  const fallback = resolveRoleFromIdpGroups(mappings, ['unmapped-group']);
  if (fallback !== 'recall-only') {
    throw new Error(`FAIL: unmapped groups should fall back to recall-only, got ${fallback}`);
  }
  log('sso-group-role.ok', { resolved, fallback });

  // --- engram catalog entitlements (Phase 4, engram-only) ------------------
  log('catalog-entitlements', {});
  const {
    resolveCatalogEntitlements,
    checkCatalogInstallEntitlement,
    buildMdmEngramCatalogBundle,
    sanitizeEngramCatalogEntry,
  } = await import('@graphnosis-app/core/settings');
  const catalogEntry = sanitizeEngramCatalogEntry({
    id: 'cat-smoke-1',
    packageId: 'devops-skills',
    displayName: 'DevOps Skills',
    description: 'IT-published skill bundle',
    kind: 'engram-package',
    installMode: 'merge-copy',
    requiredIdpGroups: ['graphnosis-finance'],
    itControlled: true,
    noReshare: true,
    sourceEngramId: 'org-devops-skills',
  });
  if (!catalogEntry) throw new Error('FAIL: catalog entry sanitize');
  const entitled = checkCatalogInstallEntitlement(catalogEntry, ['graphnosis-finance', 'other']);
  if (!entitled.entitled) throw new Error('FAIL: expected finance group to entitle install');
  const denied = checkCatalogInstallEntitlement(catalogEntry, ['graphnosis-viewers']);
  if (denied.entitled) throw new Error('FAIL: viewers group should not entitle package');
  const subs = resolveCatalogEntitlements([catalogEntry], ['graphnosis-finance'], ['cat-smoke-1']);
  if (subs.length !== 1 || !subs[0]!.entitled) {
    throw new Error('FAIL: subscribed user with matching groups should be entitled');
  }
  const browse = resolveCatalogEntitlements([catalogEntry], ['graphnosis-finance'], undefined);
  if (browse.length !== 1 || !browse[0]!.entitled) {
    throw new Error('FAIL: browse mode should show entitled packages without subscription filter');
  }
  const mdm = buildMdmEngramCatalogBundle([catalogEntry], {
    enabled: true,
    protocol: 'oidc',
    breakGlassPassphrase: true,
    groupRoleMappings: [],
    oidc: { issuer: 'https://login.microsoftonline.com/tenant/v2.0', clientId: 'smoke-client', oidcTenantId: 'tenant-guid' },
  }, ['devops-skills']);
  if (!mdm?.sso.issuer || mdm.defaultSubscriptions.length !== 1) {
    throw new Error('FAIL: MDM bundle shape');
  }
  log('catalog-entitlements.ok', { packageId: mdm.defaultSubscriptions[0] });

  log('catalog-sharepoint-map', {});
  const { sharePointRowToCatalogEntry, parseSharePointListUrl } = await import('./catalog-sharepoint.js');
  const spTarget = parseSharePointListUrl('https://contoso.sharepoint.com/sites/IT/Lists/EngramCatalog/AllItems.aspx');
  if (!spTarget || spTarget.listTitle !== 'EngramCatalog') {
    throw new Error('FAIL: SharePoint list URL parse');
  }
  const spEntry = sharePointRowToCatalogEntry({
    Title: 'DevOps Skills',
    PackageId: 'devops-skills',
    RequiredGroups: 'graphnosis-devops; graphnosis-eu',
    SourceEngramId: 'org-devops-skills',
    Kind: 'engram-package',
    InstallMode: 'merge-copy',
    Published: 'Yes',
  }, new Map());
  if (!spEntry || spEntry.packageId !== 'devops-skills' || spEntry.requiredIdpGroups.length !== 2) {
    throw new Error('FAIL: SharePoint row → catalog entry mapping');
  }
  log('catalog-sharepoint-map.ok', { packageId: spEntry.packageId });

  // --- OIDC ID token verification (mock JWKS — no live IdP) ----------------
  log('sso-oidc-verify', {});
  const http = await import('node:http');
  const { generateKeyPairSync } = await import('node:crypto');
  const { signTestIdToken, verifyIdToken, extractGroupsFromClaims } = await import('@graphnosis-app/core/sso');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const pubJwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const jwksBody = JSON.stringify({
    keys: [{ kty: 'RSA', kid: 'smoke-key', n: pubJwk.n, e: pubJwk.e, alg: 'RS256', use: 'sig' }],
  });
  const jwksServer = http.createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jwksBody);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = jwksServer.address();
  if (!addr || typeof addr === 'string') throw new Error('smoke: jwks server address missing');
  const now = Math.floor(Date.now() / 1000);
  const nonce = 'smoke-nonce-abc';
  const idToken = await signTestIdToken({
    iss: 'https://smoke-idp.test',
    aud: 'smoke-client-id',
    sub: 'smoke-user-1',
    email: 'smoke@test.corp',
    nonce,
    groups: ['graphnosis-editors'],
    exp: now + 600,
    iat: now,
  }, privatePem, 'smoke-key');
  const claims = await verifyIdToken(idToken, {
    issuer: 'https://smoke-idp.test',
    clientId: 'smoke-client-id',
    nonce,
    jwksUri: `http://127.0.0.1:${addr.port}/jwks`,
  });
  const groups = extractGroupsFromClaims(claims, 'groups');
  if (!groups.includes('graphnosis-editors')) {
    throw new Error(`FAIL: expected groups claim in ID token, got ${JSON.stringify(groups)}`);
  }
  jwksServer.close();
  log('sso-oidc-verify.ok', { sub: claims['sub'], groups });

  // --- OIDC tenant binding (Entra tid + issuer) -----------------------------
  log('sso-tenant-validate', {});
  const { validateOidcTenantClaims, probeIdpReachability } = await import('@graphnosis-app/core/sso');
  const goodTenant = validateOidcTenantClaims(
    { iss: 'https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0', tid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { issuer: 'https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0' },
  );
  if (!goodTenant.ok) {
    throw new Error(`FAIL: expected matching Entra tenant to pass, got ${goodTenant.reason}`);
  }
  const badTenant = validateOidcTenantClaims(
    { iss: 'https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0', tid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
    { issuer: 'https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0', oidcTenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
  );
  if (badTenant.ok) {
    throw new Error('FAIL: mismatched tid should reject tenant binding');
  }
  log('sso-tenant-validate.ok', { badReason: badTenant.reason });

  // --- IdP reachability probe (mock discovery server) -----------------------
  log('sso-idp-probe', {});
  const discoveryBody = JSON.stringify({
    authorization_endpoint: 'http://127.0.0.1:1/auth',
    token_endpoint: 'http://127.0.0.1:1/token',
    jwks_uri: `http://127.0.0.1:${addr.port}/jwks`,
  });
  const discoveryServer = http.createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(discoveryBody);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => discoveryServer.listen(0, '127.0.0.1', () => resolve()));
  const discAddr = discoveryServer.address();
  if (!discAddr || typeof discAddr === 'string') throw new Error('smoke: discovery server address missing');
  const reachable = await probeIdpReachability(`http://127.0.0.1:${discAddr.port}`);
  discoveryServer.close();
  if (!reachable.reachable) {
    throw new Error(`FAIL: mock IdP should be reachable, got ${reachable.error}`);
  }
  const unreachable = await probeIdpReachability('http://127.0.0.1:1', 500);
  if (unreachable.reachable) {
    throw new Error('FAIL: closed port should be unreachable');
  }
  log('sso-idp-probe.ok', { unreachableError: unreachable.error });

  // --- recall latency regression (warm-cache P50 guard) --------------------
  // Ingests bundled docs into a dedicated engram (~thousands of nodes, offline)
  // then asserts warm recall P50 stays under GRAPHNOSIS_RECALL_LATENCY_P50_MS
  // (default 200ms). Skip with GRAPHNOSIS_SKIP_RECALL_LATENCY=1.
  // Manual large-cortex: scripts/recall-benchmark-manual.mjs (pre-release).
  // performance-regression-check skill → this phase + manual script.
  if (process.env.GRAPHNOSIS_SKIP_RECALL_LATENCY !== '1') {
    log('recall-latency-regression.ingest', {});
    const benchGraphId = 'smoke-latency-bench';
    await host.createGraph(benchGraphId);
    const { ingested, failed } = await ingestGraphnosisDocs(host, benchGraphId);
    if (ingested === 0) {
      throw new Error('FAIL: recall-latency bench docs ingest produced 0 pages');
    }
    log('recall-latency-regression.ingest.done', {
      ingested,
      failed,
      nodes: host.listNodes(benchGraphId).length,
    });
    await runRecallLatencyRegression(host, benchGraphId, { log });
  } else {
    log('recall-latency-regression.skipped', { reason: 'GRAPHNOSIS_SKIP_RECALL_LATENCY=1' });
  }

  // --- session heartbeat lease ---------------------------------------------
  log('session-lease', {});
  await writeSessionLease(cortexDir, {
    deviceName: 'smoke-device',
    hostname: os.hostname(),
    pid: process.pid,
    updatedAt: Date.now(),
  });
  const lease = await readSessionLease(cortexDir);
  if (!lease || !isSessionLeaseFresh(lease)) {
    throw new Error('FAIL: session lease not written or not fresh');
  }
  const busyOther = await isCortexSessionBusy(cortexDir, process.pid + 1);
  if (!busyOther.busy) {
    throw new Error('FAIL: isCortexSessionBusy should detect another pid');
  }
  await clearSessionLease(cortexDir);
  const afterClear = await readSessionLease(cortexDir);
  if (afterClear !== null) {
    throw new Error('FAIL: session lease not cleared');
  }
  log('session-lease.ok', { deviceName: lease.deviceName });
}

function log(phase: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ phase, ...data }));
}

main().catch((e) => {
  console.error('SMOKE TEST FAILED');
  console.error(e);
  process.exit(1);
});
