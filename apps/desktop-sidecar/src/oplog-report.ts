#!/usr/bin/env node
/**
 * Op-log composition report — read-only diagnostic.
 *
 * Answers "why is this op-log 4.6 GB, and would compaction help?" without
 * materialising a single event: it streams chunk-by-chunk through
 * `safeScanEvents` and keeps only counters, so it runs in constant memory over
 * any size of log.
 *
 * WRITES NOTHING. Safe to run against a live cortex, though the cortex lock
 * means the app should be closed first.
 *
 * Reports only op kinds, ids, timestamps and sizes — never payloads or node
 * text — so the output is safe to share.
 *
 * USAGE
 * Build first (a fresh clone has no dist/):
 *
 *   pnpm --filter @graphnosis-app/desktop-sidecar exec tsc -p tsconfig.json
 *
 * Then from the REPO ROOT:
 *
 *   GRAPHNOSIS_CORTEX=/path/to/cortex GRAPHNOSIS_PASSPHRASE='…' \
 *     pnpm --filter @graphnosis-app/desktop-sidecar oplog-report
 *
 * Optional: pass a retention age in days to model a different cutoff than the
 * compactor's 30 (e.g. `oplog-report 7` to see what a one-week rule would
 * reclaim).
 */

import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { embeddings } from '@graphnosis-app/core';
import { GraphnosisHost } from './host.js';
import { GraphnosisImpl } from './graphnosis-impl.js';
import { safeScanEvents, profileOplogChunks } from './oplog-safe-read.js';
import { createOplogStats, recordEvent, formatOplogReport, formatChunkProfile, formatBytes } from './oplog-stats.js';

/** Matches COMPACTION_MAX_AGE_MS in host.compactOplogIfNeeded. */
const DEFAULT_RETENTION_DAYS = 30;

/** Mirrors DEFAULT_MAX_CHUNK_BYTES in oplog-safe-read. */
const MAX_CHUNK_BYTES = 256 * 1024 * 1024;

async function main(): Promise<void> {
  const cortexDir = process.env.GRAPHNOSIS_CORTEX;
  const passphrase = process.env.GRAPHNOSIS_PASSPHRASE;
  if (!cortexDir || !passphrase) {
    console.error('Set GRAPHNOSIS_CORTEX and GRAPHNOSIS_PASSPHRASE.');
    process.exit(2);
  }
  const ageDays = Number(process.argv[2] ?? DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(ageDays) || ageDays <= 0) {
    console.error(`Retention age must be a positive number of days; got "${process.argv[2]}".`);
    process.exit(2);
  }

  // Stub embeddings on purpose: this never queries, so there is no reason to
  // spawn the local-embed worker pool for a read-only diagnostic.
  const { host } = await GraphnosisHost.open({
    cortexDir,
    passphrase,
    deviceId: `oplog-report-${process.pid}`,
    adapter: new GraphnosisImpl(),
    embed: embeddings.stubEmbed,
    embedAdapterId: 'graphnosis-app:stub@384',
    embedDimensions: 384,
  });

  const oplogDir = path.join(cortexDir, 'oplog');

  // Headers first. This works even when the log cannot be decrypted, so if a
  // giant chunk is about to defeat the full read we learn about it here rather
  // than from an OOM three minutes in.
  const profiles = await profileOplogChunks(oplogDir);
  console.log(formatChunkProfile(profiles, MAX_CHUNK_BYTES));

  const stats = createOplogStats(Date.now() - ageDays * 86_400_000);
  console.log(`Scanning ${oplogDir} — streaming, nothing retained…\n`);

  const scan = await host.scanOplogEvents((ev) => recordEvent(stats, ev));
  if (scan.skippedChunks > 0) {
    console.log(
      `⚠ Skipped ${scan.skippedChunks} oversized chunk(s) holding ` +
      `${formatBytes(scan.skippedBytes)}. Everything below EXCLUDES them.`,
    );
  }

  if (stats.total === 0) {
    console.log('\nNo op-log events found. Check GRAPHNOSIS_CORTEX points at the right cortex.\n');
    return;
  }
  console.log(formatOplogReport(stats, scan, ageDays));
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[oplog-report] failed: ${(e as Error).stack ?? String(e)}`);
    process.exit(1);
  });
}

export { safeScanEvents };
