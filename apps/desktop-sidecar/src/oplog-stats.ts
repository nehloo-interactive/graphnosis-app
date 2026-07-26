/**
 * Op-log composition analysis — what is actually IN a multi-GB op-log, and what
 * would compaction reclaim?
 *
 * WHY
 * ---
 * A cortex in the field reached 4.6 GB, past Node's 2 GiB fs.readFile cap, which
 * broke op-log reconcile for most of its engrams. Compaction never rescued it
 * because of a feedback loop: `compactOplogIfNeeded` takes the fully
 * materialised event list as an argument, so shrinking the log requires exactly
 * the operation that fails once the log is big enough to need shrinking.
 *
 * Before tuning the retention rule — or writing a streaming compactor — it is
 * worth knowing which op kinds actually dominate. If the bulk is `addNode` and
 * edge churn from relink passes (events that carry no content at all), the fix
 * may be to stop emitting them rather than to prune them later.
 *
 * This module is the measurement. Pure counters, no event retention, so it runs
 * over any size of log in constant memory. Paired with `safeScanEvents`, which
 * streams chunk-by-chunk.
 *
 * PRIVACY
 * -------
 * Records ONLY op kinds, ids and sizes — never event payloads, never node text.
 * The report is safe to paste into an issue. `graphId`s are counted but the
 * caller decides whether to print them.
 */

import { isOplogRecoveryAnchor } from './oplog-retention.js';

/** The minimum event shape this analysis needs. */
export interface StatEvent {
  op?: string;
  ts?: number;
  graphId?: string;
  deviceId?: string;
  before?: unknown;
  after?: unknown;
}

interface OpBucket {
  count: number;
  /** Serialized bytes summed over the sampled events only. */
  sampledBytes: number;
  sampled: number;
  /** How many would survive age-based compaction as recovery anchors. */
  anchors: number;
}

export interface OplogStats {
  total: number;
  /** op kind → bucket. */
  byOp: Map<string, OpBucket>;
  byGraph: Map<string, number>;
  byDevice: Map<string, number>;
  minTs?: number;
  maxTs?: number;
  /** Events that `isOplogRecoveryAnchor` protects from pruning at any age. */
  anchors: number;
  /** Events older than the compaction cutoff AND not anchors — the prunable set. */
  prunable: number;
  /** Cutoff used for `prunable`, as a wall-clock ms timestamp. */
  cutoffTs: number;
}

/**
 * Measuring exact serialized size of every event would mean a JSON.stringify per
 * event — tens of millions of them. Sampling the first N of each op kind gives a
 * good enough average, since events of one kind are near-uniform in shape.
 */
const BYTE_SAMPLE_PER_OP = 2000;

export function createOplogStats(cutoffTs: number): OplogStats {
  return {
    total: 0,
    byOp: new Map(),
    byGraph: new Map(),
    byDevice: new Map(),
    anchors: 0,
    prunable: 0,
    cutoffTs,
  };
}

export function recordEvent(stats: OplogStats, ev: StatEvent): void {
  stats.total++;
  const op = ev.op ?? '(none)';

  let bucket = stats.byOp.get(op);
  if (!bucket) {
    bucket = { count: 0, sampledBytes: 0, sampled: 0, anchors: 0 };
    stats.byOp.set(op, bucket);
  }
  bucket.count++;
  if (bucket.sampled < BYTE_SAMPLE_PER_OP) {
    try {
      bucket.sampledBytes += JSON.stringify(ev).length;
      bucket.sampled++;
    } catch { /* unserialisable event — skip the sample, keep the count */ }
  }

  const anchor = isOplogRecoveryAnchor(ev);
  if (anchor) {
    stats.anchors++;
    bucket.anchors++;
  } else if (typeof ev.ts === 'number' && ev.ts < stats.cutoffTs) {
    stats.prunable++;
  }

  if (ev.graphId) stats.byGraph.set(ev.graphId, (stats.byGraph.get(ev.graphId) ?? 0) + 1);
  if (ev.deviceId) stats.byDevice.set(ev.deviceId, (stats.byDevice.get(ev.deviceId) ?? 0) + 1);

  if (typeof ev.ts === 'number') {
    if (stats.minTs === undefined || ev.ts < stats.minTs) stats.minTs = ev.ts;
    if (stats.maxTs === undefined || ev.ts > stats.maxTs) stats.maxTs = ev.ts;
  }
}

/** Mean serialized bytes for an op kind, from its sample. */
export function avgBytes(bucket: OpBucket): number {
  return bucket.sampled === 0 ? 0 : bucket.sampledBytes / bucket.sampled;
}

/** Estimated total serialized bytes contributed by one op kind. */
export function estimatedBytes(bucket: OpBucket): number {
  return avgBytes(bucket) * bucket.count;
}

export interface OplogStatsRow {
  op: string;
  count: number;
  share: number;
  avgBytes: number;
  estBytes: number;
  anchors: number;
}

/** Op kinds ordered by estimated bytes — the ones actually costing space. */
export function rankedRows(stats: OplogStats): OplogStatsRow[] {
  const rows: OplogStatsRow[] = [];
  for (const [op, b] of stats.byOp) {
    rows.push({
      op,
      count: b.count,
      share: stats.total === 0 ? 0 : b.count / stats.total,
      avgBytes: avgBytes(b),
      estBytes: estimatedBytes(b),
      anchors: b.anchors,
    });
  }
  rows.sort((a, b) => b.estBytes - a.estBytes);
  return rows;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padLeft(s: string, n: number): string {
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

/**
 * Render the report.
 *
 * `fileBytes` is the real on-disk total (ciphertext + framing). Estimated bytes
 * are PLAINTEXT JSON, so the two will not match — the ratio between them is
 * itself informative, and the report says so rather than pretending otherwise.
 */
export function formatOplogReport(
  stats: OplogStats,
  scan: { files: number; chunks: number; fileBytes: number },
  ageDays: number,
): string {
  const out: string[] = [];
  const rows = rankedRows(stats);
  const estTotal = rows.reduce((n, r) => n + r.estBytes, 0);

  out.push('');
  out.push('═══ Op-log composition ═══');
  out.push('');
  out.push(`  files on disk    ${scan.files}  (${formatBytes(scan.fileBytes)}, ${scan.chunks.toLocaleString()} chunks)`);
  out.push(`  events           ${stats.total.toLocaleString()}`);
  if (scan.chunks > 0) {
    const perChunk = stats.total / scan.chunks;
    out.push(`  per chunk        ${perChunk.toFixed(1)} events, ` +
             `${formatBytes(scan.fileBytes / scan.chunks)} on disk`);
  }
  if (stats.minTs !== undefined && stats.maxTs !== undefined) {
    const days = (stats.maxTs - stats.minTs) / 86_400_000;
    out.push(`  span             ${new Date(stats.minTs).toISOString().slice(0, 10)} → ` +
             `${new Date(stats.maxTs).toISOString().slice(0, 10)} (${days.toFixed(0)} days)`);
    if (days > 0) {
      out.push(`  rate             ~${Math.round(stats.total / days).toLocaleString()} events/day`);
    }
  }
  out.push('');

  out.push('  ── by op kind, ranked by estimated size ──');
  out.push(`  ${pad('op', 18)}${padLeft('count', 12)}${padLeft('share', 8)}` +
           `${padLeft('avg', 10)}${padLeft('est. total', 12)}`);
  for (const r of rows) {
    out.push(
      `  ${pad(r.op, 18)}${padLeft(r.count.toLocaleString(), 12)}` +
      `${padLeft(`${(r.share * 100).toFixed(1)}%`, 8)}` +
      `${padLeft(formatBytes(r.avgBytes), 10)}${padLeft(formatBytes(r.estBytes), 12)}`,
    );
  }
  out.push('');
  out.push(`  estimated plaintext total: ${formatBytes(estTotal)} ` +
           `(vs ${formatBytes(scan.fileBytes)} on disk — encrypted + framed)`);
  // Every chunk carries a header plus a 64-byte Ed25519 signature on top of the
  // AES framing. A writer that flushes tiny batches therefore pays that cost
  // per handful of events, and overhead can dwarf the payload. When it does,
  // compaction is the wrong lever — batching the writer is.
  if (estTotal > 0) {
    const overhead = scan.fileBytes / estTotal;
    out.push(`  on-disk / plaintext ratio: ${overhead.toFixed(1)}×`);
    if (overhead >= 3 && scan.chunks > 0 && stats.total / scan.chunks < 50) {
      out.push('');
      out.push('  ⚠ Most of this file is FRAMING, not content: few events per chunk,');
      out.push('    each paying a chunk header + 64-byte signature + AES overhead.');
      out.push('    Pruning events will not reclaim much — batch the writer, or');
      out.push('    re-chunk on compaction, before tuning retention.');
    }
  }
  out.push('');

  out.push('  ── what compaction could reclaim ──');
  const pruneShare = stats.total === 0 ? 0 : stats.prunable / stats.total;
  out.push(`  recovery anchors (never pruned, any age):  ${stats.anchors.toLocaleString()}`);
  out.push(`  older than ${ageDays}d and prunable:              ${stats.prunable.toLocaleString()}` +
           ` (${(pruneShare * 100).toFixed(1)}%)`);
  const keep = stats.total - stats.prunable;
  out.push(`  would remain:                              ${keep.toLocaleString()}`);
  if (pruneShare < 0.2) {
    out.push('');
    out.push('  ⚠ Below the 20% minimum-reduction threshold, so compaction would');
    out.push('    decline to run even if it could. Shrinking this log needs the');
    out.push('    retention rule changed, or the dominant op kind not emitted —');
    out.push('    not just a working compactor.');
  }
  out.push('');

  const graphs = [...stats.byGraph.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (graphs.length > 0) {
    out.push('  ── top engrams by event count ──');
    for (const [g, n] of graphs) {
      out.push(`  ${pad(g, 26)}${padLeft(n.toLocaleString(), 12)}`);
    }
    out.push('');
  }

  if (stats.byDevice.size > 0) {
    out.push('  ── by device ──');
    for (const [d, n] of [...stats.byDevice.entries()].sort((a, b) => b[1] - a[1])) {
      out.push(`  ${pad(d, 26)}${padLeft(n.toLocaleString(), 12)}`);
    }
    out.push('');
  }
  return out.join('\n');
}
