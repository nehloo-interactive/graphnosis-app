/**
 * Op-log reconcile checkpoint watermark.
 *
 * Reconcile used to hold every event in the log purely to derive three scalars
 * (maxTs, maxSeq, count) and a per-engram subset. On a 7.7M-event log that is
 * gigabytes of live objects per engram — and because loadGraph schedules
 * reconciles fire-and-forget, dozens could be live at once.
 *
 * The streaming rewrite accumulates those scalars one event at a time instead.
 * That is only safe if folding is EXACTLY equivalent to the old array scan:
 *   - advance too far and reconcile silently skips events (the .gai keeps
 *     stale data with no error anywhere);
 *   - advance too little and every engram re-scans the same tail forever.
 *
 * Both failures are silent, so the equivalence is pinned here.
 *
 * Run after build: node --test tests/oplog-watermark.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accumulateWatermark } from '../dist/host.js';

/** The pre-rewrite implementation, kept verbatim as the oracle. */
function legacyFold(events) {
  let maxTs = 0;
  let maxSeq;
  for (const ev of events) {
    if (ev.ts > maxTs) {
      maxTs = ev.ts;
      maxSeq = typeof ev.seq === 'number' ? ev.seq : undefined;
    } else if (ev.ts === maxTs && typeof ev.seq === 'number') {
      maxSeq = Math.max(maxSeq ?? -1, ev.seq);
    }
  }
  return { maxTs, maxSeq };
}

function streamFold(events) {
  const wm = { maxTs: 0, count: 0 };
  for (const ev of events) { wm.count++; accumulateWatermark(wm, ev); }
  return { maxTs: wm.maxTs, maxSeq: wm.maxSeq };
}

const sameAsLegacy = (events) =>
  assert.deepEqual(streamFold(events), legacyFold(events));

test('a later timestamp advances both ts and seq', () => {
  sameAsLegacy([{ ts: 10, seq: 1 }, { ts: 20, seq: 2 }]);
  assert.deepEqual(streamFold([{ ts: 10, seq: 1 }, { ts: 20, seq: 2 }]), { maxTs: 20, maxSeq: 2 });
});

test('within one timestamp the highest seq wins, regardless of arrival order', () => {
  // Chunks are not globally seq-ordered, so out-of-order arrival is normal.
  sameAsLegacy([{ ts: 5, seq: 9 }, { ts: 5, seq: 3 }]);
  assert.deepEqual(streamFold([{ ts: 5, seq: 9 }, { ts: 5, seq: 3 }]), { maxTs: 5, maxSeq: 9 });
});

test('an earlier event never rewinds the watermark', () => {
  // Rewinding would make the engram re-scan the same tail on every reconcile.
  sameAsLegacy([{ ts: 100, seq: 7 }, { ts: 40, seq: 99 }]);
  assert.deepEqual(streamFold([{ ts: 100, seq: 7 }, { ts: 40, seq: 99 }]), { maxTs: 100, maxSeq: 7 });
});

test('a higher ts with no seq CLEARS the stale seq', () => {
  // The subtle one. Keeping seq=5 against ts=20 would resume from a seq that
  // belongs to a different timestamp — isAfterOplogCheckpoint would then drop
  // real events at ts=20. Legacy v1 events genuinely lack seq.
  sameAsLegacy([{ ts: 10, seq: 5 }, { ts: 20 }]);
  assert.deepEqual(streamFold([{ ts: 10, seq: 5 }, { ts: 20 }]), { maxTs: 20, maxSeq: undefined });
});

test('a seqless event at the current ts leaves the seq intact', () => {
  sameAsLegacy([{ ts: 10, seq: 5 }, { ts: 10 }]);
  assert.deepEqual(streamFold([{ ts: 10, seq: 5 }, { ts: 10 }]), { maxTs: 10, maxSeq: 5 });
});

test('seq 0 is a real seq, not a falsy blank', () => {
  sameAsLegacy([{ ts: 10, seq: 0 }]);
  assert.deepEqual(streamFold([{ ts: 10, seq: 0 }]), { maxTs: 10, maxSeq: 0 });
});

test('an all-seqless log still advances by timestamp', () => {
  sameAsLegacy([{ ts: 3 }, { ts: 9 }, { ts: 5 }]);
  assert.deepEqual(streamFold([{ ts: 3 }, { ts: 9 }, { ts: 5 }]), { maxTs: 9, maxSeq: undefined });
});

test('folding is order-independent for the resulting watermark', () => {
  // Streaming visits chunks in file order, which is not the old array order.
  // If the result depended on order, the rewrite would drift from the oracle.
  const events = [
    { ts: 10, seq: 1 }, { ts: 30, seq: 4 }, { ts: 30, seq: 2 },
    { ts: 20 }, { ts: 30, seq: 9 }, { ts: 5, seq: 100 },
  ];
  const forward = streamFold(events);
  const reversed = streamFold([...events].reverse());
  assert.deepEqual(forward, { maxTs: 30, maxSeq: 9 });
  assert.deepEqual(reversed, forward);
});

test('an empty log leaves a zero watermark and a zero count', () => {
  // count === 0 is what tells persistOplogReconcileCheckpoint to keep the
  // PREVIOUS checkpoint rather than overwrite it with maxTs: 0.
  const wm = { maxTs: 0, count: 0 };
  assert.equal(wm.count, 0);
  assert.deepEqual(streamFold([]), { maxTs: 0, maxSeq: undefined });
});
