#!/usr/bin/env node
/**
 * Standalone cortex-recovery CLI — replays the encrypted op-log to reconstruct
 * a graph emptied by the pre-fix silent-overwrite bug (or any other accident).
 *
 * In the normal product flow this is exposed via the App's "Recover" UI,
 * which calls `host.planRecovery()` / `host.applyRecovery()` over IPC. This
 * CLI is the no-App fallback — useful when the App won't start (e.g., the
 * cortex is in a weird state) or for power-user scripted recovery.
 *
 * Usage:
 *   GRAPHNOSIS_CORTEX=/path/to/cortex GRAPHNOSIS_PASSPHRASE='...' \
 *     node dist/recover.js plan        # print recovery plan, no writes
 *
 *   GRAPHNOSIS_CORTEX=/path/to/cortex GRAPHNOSIS_PASSPHRASE='...' \
 *     node dist/recover.js apply       # re-ingest every `recoverable` item
 *
 * IMPORTANT: nothing else can hold the cortex lock while this runs. Quit the
 * App and Claude Desktop's MCP relay (if it's pointing at this cortex) first.
 */

import { embeddings } from '@graphnosis-app/core';
import { GraphnosisHost, type RecoveryPlanItem } from './host.js';
import { GraphnosisImpl } from './graphnosis-impl.js';
import { workerEmbed, LOCAL_EMBED_ID, LOCAL_EMBED_DIM } from './local-embed.js';

async function bootHost(cortexDir: string, passphrase: string): Promise<GraphnosisHost> {
  const adapter = new GraphnosisImpl();

  // Best-effort local embeddings — recovery still works on the stub.
  let embedFn = embeddings.stubEmbed;
  let embedAdapterId = 'graphnosis-app:stub@384';
  let embedDimensions = 384;
  try {
    const probe = await workerEmbed('graphnosis recovery probe');
    if (probe.length === LOCAL_EMBED_DIM) {
      embedFn = workerEmbed;
      embedAdapterId = LOCAL_EMBED_ID;
      embedDimensions = LOCAL_EMBED_DIM;
    }
  } catch (e) {
    console.error(`[recover] embeddings unavailable: ${(e as Error).message} — falling back to stub.`);
  }

  const { host } = await GraphnosisHost.open({
    cortexDir,
    passphrase,
    deviceId: `recovery-${process.pid}`,
    adapter,
    embed: embedFn,
    embedAdapterId,
    embedDimensions,
  });
  return host;
}

function statusGlyph(item: RecoveryPlanItem): string {
  switch (item.status) {
    case 'recoverable': return '✓';
    case 'already-present': return '·';
    case 'file-missing': return '✗';
    case 'url-refetch-not-implemented': return '?';
    case 'content-not-in-oplog': return '?';
    default: return '?';
  }
}

async function planMode(host: GraphnosisHost, cortexDir: string): Promise<void> {
  const plan = await host.planRecovery();
  console.log(`\nRecovery plan for cortex: ${cortexDir}`);
  console.log(`Found ${plan.total} source(s) in op-log (${plan.recoverable} recoverable).\n`);

  const byGraph = new Map<string, RecoveryPlanItem[]>();
  for (const item of plan.items) {
    const arr = byGraph.get(item.graphId) ?? [];
    arr.push(item);
    byGraph.set(item.graphId, arr);
  }

  for (const [graphId, arr] of byGraph) {
    console.log(`── graph: ${graphId} (${arr.length} source${arr.length === 1 ? '' : 's'})`);
    for (const item of arr) {
      const when = new Date(item.ingestedAt).toISOString();
      console.log(`   ${statusGlyph(item)}  [${item.kind}] ${item.ref}`);
      console.log(`       status=${item.status}, ingested=${when}, sourceId=${item.sourceId.slice(0, 16)}…`);
    }
    console.log('');
  }

  console.log('Legend:');
  console.log('  ✓ recoverable          file still on disk; will be re-ingested by `apply`');
  console.log('  · already-present      source already in the loaded graph; will be skipped');
  console.log('  ✗ file-missing         file gone from disk; unrecoverable');
  console.log('  ? content-not-in-oplog pasted/clip text; original content not retained on disk');
  console.log('  ? url-refetch          URL ingest re-fetch not implemented in this pass\n');
}

async function applyMode(host: GraphnosisHost): Promise<void> {
  console.log('\nApplying recovery…\n');
  const report = await host.applyRecovery();
  for (const o of report.outcomes) {
    if (o.ok && o.skipped) {
      console.log(`  · skipped (${o.skipped}): ${o.ref}`);
    } else if (o.ok) {
      console.log(`  ✓ recovered: ${o.ref}`);
    } else {
      console.error(`  ✗ FAILED ${o.ref}: ${o.error}`);
    }
  }
  console.log(`\nDone. attempted=${report.attempted} recovered=${report.recovered} skipped=${report.skipped} failed=${report.failed}\n`);
}

async function main(): Promise<void> {
  const cortexDir = process.env.GRAPHNOSIS_CORTEX;
  const passphrase = process.env.GRAPHNOSIS_PASSPHRASE;
  const mode = process.argv[2];

  if (!cortexDir || !passphrase) {
    console.error('Set GRAPHNOSIS_CORTEX and GRAPHNOSIS_PASSPHRASE env vars.');
    process.exit(2);
  }
  if (mode !== 'plan' && mode !== 'apply') {
    console.error('Usage: recover.js <plan|apply>');
    process.exit(2);
  }

  const host = await bootHost(cortexDir, passphrase);
  if (mode === 'plan') {
    await planMode(host, cortexDir);
  } else {
    await applyMode(host);
  }
}

main().catch((e) => {
  console.error('[recover] fatal:', e);
  process.exit(1);
});
