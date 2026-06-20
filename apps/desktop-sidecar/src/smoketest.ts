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
import { policy } from '@nehloo-interactive/graphnosis-secure-sync';
import { GraphnosisHost } from './host.js';
import { GraphnosisImpl } from './graphnosis-impl.js';
import { proposeCorrection, applyCorrection } from './correction.js';
import { SkillTrainer } from './skill-trainer.js';
import { BUNDLED_DOCS } from './docs-content.generated.js';
import { BUNDLED_SKILL_DEMOS } from './skill-demos.generated.js';

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
}

function log(phase: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ phase, ...data }));
}

main().catch((e) => {
  console.error('SMOKE TEST FAILED');
  console.error(e);
  process.exit(1);
});
