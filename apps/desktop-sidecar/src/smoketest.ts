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

  log('encrypted-on-disk-check', {});
  const aikgPath = path.join(cortexDir, 'graphs', 'personal.gai');
  const raw = await fs.readFile(aikgPath);
  if (raw.includes(Buffer.from('Santorini'))) {
    throw new Error('FAIL: plaintext leak — found "Santorini" in .aikg on disk');
  }
  log('encrypted-on-disk-check.ok', { bytes: raw.length });

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
  if (!secretsAudit) throw new Error('FAIL: secrets graph missing from audit trail');
  if (secretsAudit.nodesIncluded > 5) {
    throw new Error(`FAIL: sensitive-tier cap not enforced — got ${secretsAudit.nodesIncluded} nodes (max 5)`);
  }
  if (secretsAudit.tokensIncluded > 500) {
    throw new Error(`FAIL: sensitive-tier token cap not enforced — got ${secretsAudit.tokensIncluded} tokens (max 500)`);
  }
  log('sensitive-tier-cap.ok', { nodes: secretsAudit.nodesIncluded, tokens: secretsAudit.tokensIncluded });
}

function log(phase: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ phase, ...data }));
}

main().catch((e) => {
  console.error('SMOKE TEST FAILED');
  console.error(e);
  process.exit(1);
});
