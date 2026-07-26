/**
 * Op-log reconstruction for skills destroyed by a transfer.
 *
 * The first version of this recovery path read `after.contentPreview` on node
 * events and recovered NOTHING, because that is not where the content goes.
 * What `host.forgetSource` actually emits, per node, is:
 *
 *     { op: 'deleteNode', target: {kind:'node'}, before: { sourceId, preview } }
 *
 * where `preview` was captured immediately BEFORE forgetSource overwrites the
 * node with a `__gn-forgotten:…` tombstone to release its dedup hash. That
 * tombstone rewrite goes straight to the adapter, bypassing the host emit that
 * would have recorded full content — and `addNode` events carry no content at
 * all. So this trail is the ONLY surviving copy, capped at the adapter's
 * 500-char contentPreview limit.
 *
 * These tests pin the exact event shape. If the emit in forgetSource ever
 * changes key or payload, recovery silently returns nothing again — which is
 * precisely the failure that made this file necessary.
 *
 * Run after build: node --test tests/skill-recover.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoverFromForgetTrail } from '../dist/skill-recover-oplog.js';

const SOURCE = 'skill:1785:report-format';
const ORIGIN = 'skills-alpha';

/** Mirrors the emit in host.forgetSource, in node order. */
function forgetEvents(sourceId, graphId, previews) {
  return previews.map((preview, i) => ({
    id: `ev${i}`,
    ts: 1_000 + i,
    graphId,
    op: 'deleteNode',
    target: { kind: 'node', id: `n${i}` },
    before: { sourceId, preview, triggeredBy: 'user:ingest' },
  }));
}

test('reconstructs a skill from the forget trail, in source order', () => {
  const previews = [
    '<!-- Graphnosis skill training metadata -->',
    'Report Format',
    'Trigger: the user asks for a formatted report',
    '1. Set the page to A4 portrait with 15mm margins',
    '2. Render figure captions below each figure',
  ];
  const res = recoverFromForgetTrail(forgetEvents(SOURCE, ORIGIN, previews), SOURCE);
  assert.deepEqual(res.texts, previews, 'order preserved — walk sequence depends on it');
  assert.equal(res.truncated, 0);
  assert.equal(res.fromGraphId, ORIGIN, 'reports which engram it was forgotten from');
});

test('reads `before`, not `after` — the regression that recovered nothing', () => {
  // The shape the first version looked for. It must NOT be what makes this work.
  const wrong = [{
    id: 'e0', ts: 1, graphId: ORIGIN,
    op: 'deleteNode', target: { kind: 'node', id: 'n0' },
    after: { sourceId: SOURCE, contentPreview: '1. do the thing' },
  }];
  assert.deepEqual(recoverFromForgetTrail(wrong, SOURCE).texts, []);

  const right = forgetEvents(SOURCE, ORIGIN, ['1. do the thing']);
  assert.deepEqual(recoverFromForgetTrail(right, SOURCE).texts, ['1. do the thing']);
});

test('only deleteNode events count', () => {
  // addNode carries sourceId but never content; counting it would inject blanks.
  const events = [
    { id: 'a', ts: 1, graphId: ORIGIN, op: 'addNode', target: { kind: 'node', id: 'n0' },
      after: { sourceId: SOURCE } },
    ...forgetEvents(SOURCE, ORIGIN, ['1. real content']),
  ];
  assert.deepEqual(recoverFromForgetTrail(events, SOURCE).texts, ['1. real content']);
});

test('other skills\' forget trails are not mixed in', () => {
  const events = [
    ...forgetEvents('some-other-skill', ORIGIN, ['1. not mine', '2. also not mine']),
    ...forgetEvents(SOURCE, ORIGIN, ['1. mine']),
  ];
  assert.deepEqual(recoverFromForgetTrail(events, SOURCE).texts, ['1. mine']);
});

test('tombstones are never resurrected as content', () => {
  // If a preview were ever captured AFTER the dedup-release rewrite, restoring
  // it would write `__gn-forgotten:…` into the user's skill as a step.
  const events = forgetEvents(SOURCE, ORIGIN, [
    '__gn-forgotten:abc123:0:n0__',
    '1. genuine step',
  ]);
  assert.deepEqual(recoverFromForgetTrail(events, SOURCE).texts, ['1. genuine step']);
});

test('truncated previews are counted, not silently accepted', () => {
  // The adapter caps contentPreview at 500 chars and marks the cut with '…'.
  const long = `1. ${'x'.repeat(495)}…`;
  const res = recoverFromForgetTrail(forgetEvents(SOURCE, ORIGIN, [long, '2. short one']), SOURCE);
  assert.equal(res.texts.length, 2, 'truncated content is still recovered…');
  assert.equal(res.truncated, 1, '…but the loss is reported so the user can review it');
});

test('content already present is not duplicated', () => {
  // The surviving metadata node is still attached to the damaged source, so a
  // repair must not append a second copy of it.
  const meta = '<!-- Graphnosis skill training metadata -->';
  const res = recoverFromForgetTrail(
    forgetEvents(SOURCE, ORIGIN, [meta, '1. a step']),
    SOURCE,
    new Set([meta]),
  );
  assert.deepEqual(res.texts, ['1. a step']);
});

test('a repeated forget of the same text yields one copy', () => {
  const res = recoverFromForgetTrail(
    forgetEvents(SOURCE, ORIGIN, ['1. a step', '1. a step']), SOURCE,
  );
  assert.deepEqual(res.texts, ['1. a step']);
});

test('no trail for the sourceId returns empty, not a throw', () => {
  const res = recoverFromForgetTrail([], SOURCE);
  assert.deepEqual(res.texts, []);
  assert.equal(res.fromGraphId, undefined);
});
