// Op-log merge materialization: loadGraph replays merged op-log state over the
// .gai/.bundle cache so peer forgets and missing bundle rows converge.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';
import {
  setupTestCortex,
  seedStandardData,
  summarizeRecall,
  assert,
  section,
  standalone,
  runSuite,
  type SuiteResult,
} from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('oplog-merge', oplogMergeSuite);
}

async function writeEmptyBundle(cortexDir: string, graphId: string, passphrase: string): Promise<void> {
  const salt = new Uint8Array(await fs.readFile(path.join(cortexDir, 'salt.bin')));
  const { key } = await crypto.deriveKey(passphrase, salt);
  const ct = await crypto.encrypt(new TextEncoder().encode('[]'), key, salt);
  await fs.writeFile(path.join(cortexDir, 'graphs', `${graphId}.bundle`), Buffer.from(ct));
}

async function oplogMergeSuite(): Promise<void> {
  const cx = await setupTestCortex('oplog-merge');
  try {
    const ids = await seedStandardData(cx.host);
    const budget = { maxTokens: 4000, maxNodes: 10 };
    const bundlePath = path.join(cx.cortexDir, 'graphs', 'work.bundle');

    // ── Stale bundle: op-log forget wins over cached source index ─────────
    section('Peer forget in op-log removes stale bundle source on loadGraph');
    const bundleBeforeForget = await fs.readFile(bundlePath);
    await cx.host.forgetSource('work', ids.roster);
    await cx.host.save('work');
    // Simulate iCloud syncing an older .bundle while the op-log already has forgetSource.
    await fs.writeFile(bundlePath, bundleBeforeForget);
    {
      const host2 = await cx.reopen('oplog-merge-reopen-forget');
      await host2.loadGraph('work');
      await host2.waitForReconcile('work');
      await host2.waitForEmbeddings('work');
      const sources = host2.listSources('work').map((s) => s.sourceId);
      assert(!sources.includes(ids.roster),
        `loadGraph merge drops source forgotten in op-log`,
        { sources });
      const r = await host2.recall('Tudor', { budget, skipEnrichment: true });
      const s = summarizeRecall(r);
      assert(s.topTextsFull.some((t) => t.includes('Tudor')),
        `recall still finds roster body nodes after bundle/op-log reconcile`);
    }

    // ── Empty bundle: peer ingest rows restored from op-log + content cache ─
    section('Missing bundle rows restored from merged op-log on loadGraph');
    await writeEmptyBundle(cx.cortexDir, 'people', cx.passphrase);
    {
      const host3 = await cx.reopen('oplog-merge-reopen-recover');
      await host3.loadGraph('people');
      await host3.waitForReconcile('people');
      await host3.waitForEmbeddings('people');
      const sources = host3.listSources('people').map((s) => s.sourceId);
      assert(sources.includes(ids.paul),
        `loadGraph merge restores source missing from bundle`,
        { sources });
      const r = await host3.recall('Paul Nistor', { budget, skipEnrichment: true });
      const s = summarizeRecall(r);
      assert(s.topTextsFull.some((t) => t.toLowerCase().includes('paul nistor')),
        `recall finds Paul after bundle rebuild from op-log`);
    }

    // ── In-sync reload is a no-op (no duplicate sources) ─────────────────
    section('In-sync reload does not duplicate sources');
    {
      const host4 = await cx.reopen('oplog-merge-reopen-stable');
      await host4.loadGraph('docs');
      await host4.waitForEmbeddings('docs');
      const n1 = host4.listSources('docs').length;
      await host4.unloadGraph('docs');
      await host4.loadGraph('docs');
      const n2 = host4.listSources('docs').length;
      assert(n1 === n2 && n1 === 2,
        `second loadGraph does not duplicate sources`, { n1, n2 });
    }

    // ── Stale .gai: op-log edit wins over cached graph bytes ─────────────
    section('Stale .gai replay — correction materialized from op-log');
    {
      const gaiPath = path.join(cx.cortexDir, 'graphs', 'work.gai');
      const staleGai = await fs.readFile(gaiPath);
      const workNodes = cx.host.listSources('work').flatMap((s) => s.nodeIds);
      const nodeId = workNodes[0]!;
      await cx.host.applyCorrection('work', {
        edits: [{
          kind: 'edit',
          nodeId,
          content: '# Stale gai\nCORRECTED_OPLOG_MERGE_SENTINEL from op-log merge.',
          reason: 'oplog-merge stale .gai test',
        }],
      });
      await new Promise((r) => setTimeout(r, 80));
      await fs.writeFile(gaiPath, staleGai);
      const host5 = await cx.reopen('oplog-merge-reopen-stale-gai');
      await host5.loadGraph('work');
      await host5.waitForReconcile('work');
      await host5.waitForEmbeddings('work');
      const content = host5.getFullNodeContent('work', nodeId) ?? '';
      assert(content.includes('CORRECTED_OPLOG_MERGE_SENTINEL'),
        'loadGraph merged op-log edit onto stale .gai cache');
    }
  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('oplog-merge', oplogMergeSuite);
