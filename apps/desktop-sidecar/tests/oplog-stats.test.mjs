/**
 * Op-log composition analysis.
 *
 * The point of this diagnostic is to decide whether a 4.6 GB op-log needs a
 * streaming compactor, a different retention rule, or for some op kind to stop
 * being emitted at all. A wrong answer sends that work in the wrong direction,
 * so the accounting is pinned here — particularly the interaction between
 * recovery anchors (never prunable at any age) and the age cutoff.
 *
 * Run after build: node --test tests/oplog-stats.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createOplogStats,
  recordEvent,
  rankedRows,
  formatBytes,
  formatOplogReport,
  formatChunkProfile,
} from '../dist/oplog-stats.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const CUTOFF = NOW - 30 * DAY;

const old = (op, extra = {}) => ({ op, ts: CUTOFF - DAY, graphId: 'g1', deviceId: 'dev-a', ...extra });
const recent = (op, extra = {}) => ({ op, ts: NOW - DAY, graphId: 'g1', deviceId: 'dev-a', ...extra });

test('counts events and splits anchors from the prunable set', () => {
  const s = createOplogStats(CUTOFF);
  // Anchors — protected at ANY age.
  recordEvent(s, old('ingestSource'));
  recordEvent(s, old('forgetSource'));
  recordEvent(s, old('deleteNode', { before: { sourceId: 'src-1', preview: '1. a step' } }));
  // Old and unprotected — the prunable set.
  recordEvent(s, old('addNode'));
  recordEvent(s, old('addNode'));
  // Recent and unprotected — kept by the age rule, not by anchoring.
  recordEvent(s, recent('addNode'));

  assert.equal(s.total, 6);
  assert.equal(s.anchors, 3);
  assert.equal(s.prunable, 2, 'only old non-anchors are prunable');
});

test('a node-level forget deleteNode is prunable, a forgetSource cascade is not', () => {
  // The distinction the retention rule turns on: only the cascade carries
  // `before.preview`, and only that is the last surviving copy of content.
  const s = createOplogStats(CUTOFF);
  recordEvent(s, old('deleteNode', { after: { triggeredBy: 'user:forget' } }));
  recordEvent(s, old('deleteNode', { before: { sourceId: 'src-1', preview: 'text' } }));
  assert.equal(s.anchors, 1);
  assert.equal(s.prunable, 1);
});

test('ranks op kinds by estimated bytes, not by count', () => {
  // The whole question is which kind costs SPACE. A rare-but-huge event kind
  // must outrank a common tiny one, or the report points at the wrong fix.
  const s = createOplogStats(CUTOFF);
  for (let i = 0; i < 100; i++) recordEvent(s, recent('addNode'));
  for (let i = 0; i < 5; i++) {
    recordEvent(s, recent('ingestSource', { after: { blob: 'x'.repeat(5000) } }));
  }
  const rows = rankedRows(s);
  assert.equal(rows[0].op, 'ingestSource', 'the big-payload kind ranks first');
  assert.equal(rows[1].op, 'addNode');
  assert.ok(rows[1].count > rows[0].count, 'even though it is far less frequent');
});

test('share and anchor counts are tracked per op kind', () => {
  const s = createOplogStats(CUTOFF);
  for (let i = 0; i < 3; i++) recordEvent(s, old('addNode'));
  recordEvent(s, old('ingestSource'));
  const rows = rankedRows(s);
  const add = rows.find((r) => r.op === 'addNode');
  const ing = rows.find((r) => r.op === 'ingestSource');
  assert.equal(add.count, 3);
  assert.ok(Math.abs(add.share - 0.75) < 1e-9);
  assert.equal(add.anchors, 0);
  assert.equal(ing.anchors, 1);
});

test('tracks span, engrams and devices', () => {
  const s = createOplogStats(CUTOFF);
  recordEvent(s, { op: 'addNode', ts: 1000, graphId: 'g1', deviceId: 'dev-a' });
  recordEvent(s, { op: 'addNode', ts: 5000, graphId: 'g2', deviceId: 'dev-b' });
  recordEvent(s, { op: 'addNode', ts: 3000, graphId: 'g1', deviceId: 'dev-a' });
  assert.equal(s.minTs, 1000);
  assert.equal(s.maxTs, 5000);
  assert.equal(s.byGraph.get('g1'), 2);
  assert.equal(s.byGraph.get('g2'), 1);
  assert.equal(s.byDevice.get('dev-a'), 2);
});

test('an event with no timestamp is never counted as prunable', () => {
  // Legacy v1 events can lack ts. Treating "unknown age" as "old enough to
  // delete" would be the wrong direction to be wrong in.
  const s = createOplogStats(CUTOFF);
  recordEvent(s, { op: 'addNode', graphId: 'g1' });
  assert.equal(s.total, 1);
  assert.equal(s.prunable, 0);
});

test('an unserialisable event still counts', () => {
  // A circular payload must not lose the event from the histogram.
  const s = createOplogStats(CUTOFF);
  const circular = { op: 'addNode', ts: NOW };
  circular.self = circular;
  recordEvent(s, circular);
  assert.equal(s.total, 1);
  assert.equal(rankedRows(s)[0].count, 1);
});

test('the report warns when compaction would decline to run', () => {
  // Below 20% reduction the compactor bails — so a working compactor would not
  // help, and the report has to say so rather than implying a fix is available.
  const s = createOplogStats(CUTOFF);
  for (let i = 0; i < 10; i++) recordEvent(s, recent('addNode'));
  const text = formatOplogReport(s, { files: 1, chunks: 4, fileBytes: 1024 }, 30);
  assert.match(text, /Below the 20% minimum-reduction threshold/);
});

test('the report does not warn when there is plenty to reclaim', () => {
  const s = createOplogStats(CUTOFF);
  for (let i = 0; i < 10; i++) recordEvent(s, old('addNode'));
  const text = formatOplogReport(s, { files: 1, chunks: 4, fileBytes: 1024 }, 30);
  assert.doesNotMatch(text, /Below the 20% minimum-reduction threshold/);
  assert.match(text, /older than 30d and prunable:\s+10/);
});

test('the report never contains event payloads', () => {
  // It is meant to be pasteable into an issue.
  const s = createOplogStats(CUTOFF);
  recordEvent(s, recent('deleteNode', {
    before: { sourceId: 'src-1', preview: 'SECRET-NODE-CONTENT-HERE' },
  }));
  const text = formatOplogReport(s, { files: 1, chunks: 1, fileBytes: 512 }, 30);
  assert.doesNotMatch(text, /SECRET-NODE-CONTENT-HERE/);
  assert.doesNotMatch(text, /src-1/);
});

test('a framing-dominated log is called out as such', () => {
  // 4.6 GB on disk against a few hundred MB of plaintext means the file is
  // mostly chunk headers and signatures. Pruning events would barely dent it —
  // the report must point at batching/re-chunking instead of retention.
  const s = createOplogStats(CUTOFF);
  for (let i = 0; i < 100; i++) recordEvent(s, recent('addNode'));
  const framed = formatOplogReport(s, { files: 1, chunks: 100, fileBytes: 50 * 1024 * 1024 }, 30);
  assert.match(framed, /Most of this file is FRAMING/);

  // A densely packed log must NOT trigger it.
  const dense = formatOplogReport(s, { files: 1, chunks: 1, fileBytes: 20_000 }, 30);
  assert.doesNotMatch(dense, /Most of this file is FRAMING/);
});

test('formatBytes scales through the units', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 ** 2), '5.0 MB');
  assert.equal(formatBytes(4.6 * 1024 ** 3), '4.60 GB');
});

// ── Chunk profile (headers only) ──────────────────────────────────────────────
//
// AES-GCM needs a whole chunk in memory to verify its tag, so a single
// oversized chunk is unreadable at ANY heap size — it OOM'd an 8 GB heap
// inside ArrayBufferConstructor. Chunk headers carry ctLen, so the shape of a
// log is readable even when its contents are not. That is what makes this
// diagnostic worth having: it works precisely when the full read cannot.

test('the chunk profile reports size percentiles and density', () => {
  const ctLens = [1000, 2000, 3000, 4000, 5000];
  const text = formatChunkProfile([{
    file: 'a.oplog', fileBytes: 20_000, format: 'v2',
    chunks: 5, declaredEvents: 50, ctBytes: 15_000,
    largestCtLen: 5000, ctLens,
  }], 256 * 1024 * 1024);
  assert.match(text, /a\.oplog/);
  assert.match(text, /10\.0 per chunk/);
  assert.match(text, /p50 2\.9 KB/);
  assert.match(text, /max 4\.9 KB/);
  assert.doesNotMatch(text, /exceed the/, 'no warning for normal chunks');
});

test('oversized chunks are flagged with how much data they hold', () => {
  const MAX = 256 * 1024 * 1024;
  const giant = 2 * 1024 ** 3;
  const ctLens = [5000, 5000, giant].sort((a, b) => a - b);
  const text = formatChunkProfile([{
    file: 'mini.oplog', fileBytes: 4.6 * 1024 ** 3, format: 'v2',
    chunks: 3, declaredEvents: 100, ctBytes: ctLens.reduce((a, b) => a + b, 0),
    largestCtLen: giant, ctLens,
  }], MAX);
  assert.match(text, /1 chunk\(s\) exceed the 256\.0 MB read/);
  assert.match(text, /\d+\.\d% of this file/, 'quantifies what is unreachable');
  assert.match(text, /unreadable at any heap size/);
});

test('an empty op-log profiles without throwing', () => {
  const text = formatChunkProfile([{
    file: 'empty.oplog', fileBytes: 0, format: 'empty',
    chunks: 0, declaredEvents: 0, ctBytes: 0, largestCtLen: 0, ctLens: [],
  }], 256 * 1024 * 1024);
  assert.match(text, /empty\.oplog/);
  assert.doesNotMatch(text, /NaN/);
});
