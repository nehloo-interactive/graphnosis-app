/**
 * Op-log compaction must never prune a recovery anchor.
 *
 * Compaction drops events older than 30 days once a log passes 500k events.
 * Until now it spared only `ingestSource` / `forgetSource`, on the assumption
 * that content is always recoverable from its ORIGIN — a file on disk or the
 * encrypted content blob written during `ingest()`.
 *
 * That assumption fails for content whose only home is the graph. A trained
 * skill's body is appended node-by-node via `insertNodeAt`, which never
 * extends the source's content blob, and forgetSource overwrites each node
 * with a `__gn-forgotten:…` tombstone before soft-deleting it. The single
 * surviving copy is the `deleteNode` event carrying `before.preview`.
 * Pruning it makes the loss permanent.
 *
 * Run after build: node --test tests/oplog-retention.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOplogRecoveryAnchor, splitBlobByNodeOffsets } from '../dist/oplog-retention.js';

test('the replay spine is always retained', () => {
  assert.equal(isOplogRecoveryAnchor({ op: 'ingestSource' }), true);
  assert.equal(isOplogRecoveryAnchor({ op: 'forgetSource' }), true);
});

test('a forgetSource cascade node is retained — it is the only copy left', () => {
  // Exactly what host.forgetSource emits per node.
  assert.equal(
    isOplogRecoveryAnchor({
      op: 'deleteNode',
      before: { sourceId: 'skill:1785:report-format', preview: '1. Set the page to A4 portrait' },
    }),
    true,
  );
});

test('a node-level forget stays prunable', () => {
  // The `forget` MCP tool routes through applyCorrection({kind:'delete'}),
  // which does NOT tombstone — the node keeps its text in the .gai, so no
  // op-log copy is needed to bring it back. Retaining these would pin the
  // bulk of a large log for no recovery benefit.
  assert.equal(
    isOplogRecoveryAnchor({ op: 'deleteNode', after: { triggeredBy: 'user:forget' } }),
    false,
  );
  assert.equal(isOplogRecoveryAnchor({ op: 'deleteNode', before: {} }), false);
  assert.equal(isOplogRecoveryAnchor({ op: 'deleteNode' }), false);
});

test('an empty preview is not treated as recoverable content', () => {
  assert.equal(isOplogRecoveryAnchor({ op: 'deleteNode', before: { preview: '' } }), false);
  assert.equal(isOplogRecoveryAnchor({ op: 'deleteNode', before: { preview: null } }), false);
  assert.equal(isOplogRecoveryAnchor({ op: 'deleteNode', before: { preview: 42 } }), false);
});

test('ordinary high-volume events remain prunable', () => {
  // Compaction has to stay worthwhile — these are the bulk of a large log.
  for (const op of ['addNode', 'editNode', 'supersede', 'addEdge', 'recall']) {
    assert.equal(isOplogRecoveryAnchor({ op }), false, `${op} should be prunable`);
  }
});

test('an unknown or missing op is prunable, not accidentally retained', () => {
  assert.equal(isOplogRecoveryAnchor({}), false);
  assert.equal(isOplogRecoveryAnchor({ op: 'somethingNew' }), false);
});

// ── Node-exact blob reconstruction ────────────────────────────────────────────
//
// `refreshSkillContentBlob` rebuilds a skill's content blob from its nodes and
// records each node's BYTE offset. `moveSource` uses those offsets to restore
// the nodes verbatim instead of re-running the chunker — which merges or drops
// short lines (a one-line title, a bare goal header) and undoes the
// `singleNode` boundaries that keep each step one walkable node.

/** Mirrors the offset walk in host.refreshSkillContentBlob. */
function buildBlob(nodes) {
  const enc = new TextEncoder();
  const sepLen = enc.encode('\n\n').length;
  const offsets = [];
  let cursor = 0;
  for (const n of nodes) {
    offsets.push(cursor);
    cursor += enc.encode(n).length + sepLen;
  }
  return { content: enc.encode(nodes.join('\n\n')), offsets };
}

test('a rebuilt blob round-trips back to the exact same nodes', () => {
  const nodes = [
    '<!-- Graphnosis skill training metadata -->',
    'Demo Skill',
    'Trigger: someone asks for the demo',
    '1. First step of the procedure',
    '2. Second step of the procedure',
  ];
  const { content, offsets } = buildBlob(nodes);
  assert.deepEqual(splitBlobByNodeOffsets(content, offsets), nodes);
});

test('short one-line nodes survive — the ones the chunker used to swallow', () => {
  // A bare title line was exactly what got lost when moveSource re-chunked.
  const nodes = ['Demo Skill', 'x', '1. a step'];
  const { content, offsets } = buildBlob(nodes);
  assert.deepEqual(splitBlobByNodeOffsets(content, offsets), nodes);
});

test('offsets are byte-based, so non-ASCII nodes are not corrupted', () => {
  // The skills library is multilingual; slicing a decoded string by character
  // index would cut multi-byte characters in half.
  const nodes = [
    'Rezumat ședință',
    'Trigger: utilizatorul cere un rezumat',
    '1. Citește notițele — apoi rezumă-le',
    '2. 会議のメモを要約する',
  ];
  const { content, offsets } = buildBlob(nodes);
  assert.deepEqual(splitBlobByNodeOffsets(content, offsets), nodes);
});

test('a node containing blank lines is not split at them', () => {
  // This is the whole point of offsets over a naive split(/\n{2,}/).
  const nodes = ['Title', '1. step one\n\n   with an indented continuation', '2. step two'];
  const { content, offsets } = buildBlob(nodes);
  assert.deepEqual(splitBlobByNodeOffsets(content, offsets), nodes);
});

test('a single-node blob round-trips', () => {
  const { content, offsets } = buildBlob(['only one node here']);
  assert.deepEqual(splitBlobByNodeOffsets(content, offsets), ['only one node here']);
});

test('corrupt offsets yield nothing rather than garbage', () => {
  // Better to fall through to the chunker path than to write sliced-up
  // fragments into the user's skill.
  const { content } = buildBlob(['a node', 'another node']);
  assert.deepEqual(splitBlobByNodeOffsets(content, [0, 99_999]), []);
  assert.deepEqual(splitBlobByNodeOffsets(content, [-1]), []);
  assert.deepEqual(splitBlobByNodeOffsets(content, []), []);
});
