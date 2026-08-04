/**
 * Regression test for `GraphnosisImpl.applyCorrectionChecked`.
 *
 * The bug this locks down: the adapter used to call the SDK's
 * `edit` / `supersede` / `deleteNode` and DISCARD the `CorrectionResult`.
 * The SDK does not report a failed correction by throwing — it returns
 * `{ applied: 0, ..., errors: ['...'] }`. Discarding that made a correction
 * that never landed indistinguishable from one that did, so the user was told
 * "done" and the host wrote an op-log event for a mutation the graph never
 * took.
 *
 * Second thing locked down: WHICH node carries the corrected content
 * afterwards. `supersede` already mints a new node on SDK 0.8.0 and the SDK's
 * `correct()` drops that id on the floor; SDK 0.10.0 makes `edit` behave the
 * same way (retire target, mint replacement). The adapter recovers the id by
 * diffing the node map, which works on both versions — so `resultNodeId` must
 * follow the new node, not the target.
 *
 * Run after build: node --test tests/correction-outcome.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphnosisImpl } from '../dist/graphnosis-impl.js';

/**
 * Minimal stand-in for the SDK's `Graphnosis`. Only the surface
 * applyCorrectionChecked actually touches: `graph.nodes`, `build`, and the
 * three correction methods. `outcome` decides what the fake SDK returns, and
 * `mintOnSupersede` / `mintOnEdit` decide whether a new node appears in the
 * map — that is the ONLY signal the adapter has for the new id.
 */
function makeInstance({ ok = true, error = null, mintOnSupersede = true, mintOnEdit = false } = {}) {
  const nodes = new Map([
    ['n1', { id: 'n1', content: 'original' }],
    ['n2', { id: 'n2', content: 'other' }],
  ]);
  const calls = [];
  let minted = 0;

  const result = (type) => ({
    applied: ok ? 1 : 0,
    nodesAdded: 0,
    nodesModified: ok && type === 'edit' ? 1 : 0,
    nodesSuperseded: ok && type === 'supersede' ? 1 : 0,
    errors: error ? [error] : [],
  });

  const mint = () => {
    minted += 1;
    const id = `minted-${minted}`;
    nodes.set(id, { id, content: 'replacement' });
    return id;
  };

  return {
    graph: { nodes },
    _calls: () => calls,
    build() { calls.push({ fn: 'build' }); },
    edit(nodeId, content, reason) {
      calls.push({ fn: 'edit', nodeId, content, reason });
      if (ok && mintOnEdit) mint();
      return result('edit');
    },
    supersede(nodeId, content, reason) {
      calls.push({ fn: 'supersede', nodeId, content, reason });
      if (ok && mintOnSupersede) mint();
      return result('supersede');
    },
    deleteNode(nodeId, reason) {
      calls.push({ fn: 'deleteNode', nodeId, reason });
      return result('delete');
    },
  };
}

const handleFor = (instance) => ({ graphId: 'g', instance, built: true });

test('a FAILED correction reports applied:false and surfaces the SDK errors', async () => {
  const instance = makeInstance({ ok: false, error: 'node not found: n1' });
  const impl = new GraphnosisImpl();

  const outcome = await impl.applyCorrectionChecked(handleFor(instance), {
    kind: 'edit',
    nodeId: 'n1',
    content: 'new text',
    reason: 'user correction',
  });

  // The whole point: the SDK returned normally, so the ONLY evidence the
  // correction failed is in the value we used to throw away.
  assert.equal(outcome.applied, false, 'a correction the SDK refused must not report applied');
  assert.deepEqual(outcome.errors, ['node not found: n1']);
  assert.equal(outcome.nodeId, 'n1');
});

test('a correction the SDK applied but flagged with errors is NOT reported as applied', async () => {
  // Defensive: `applied: 1` alongside a non-empty `errors` is a partial failure.
  const instance = makeInstance({ ok: true, error: 'tfidf index stale' });
  const impl = new GraphnosisImpl();

  const outcome = await impl.applyCorrectionChecked(handleFor(instance), {
    kind: 'delete',
    nodeId: 'n1',
    reason: 'forget',
  });

  assert.equal(outcome.applied, false);
  assert.deepEqual(outcome.errors, ['tfidf index stale']);
});

test('a successful in-place edit keeps resultNodeId on the target (SDK 0.8.0 semantics)', async () => {
  const instance = makeInstance({ mintOnEdit: false });
  const impl = new GraphnosisImpl();

  const outcome = await impl.applyCorrectionChecked(handleFor(instance), {
    kind: 'edit',
    nodeId: 'n1',
    content: 'new text',
    reason: 'user correction',
  });

  assert.equal(outcome.applied, true);
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.nodeId, 'n1');
  assert.equal(outcome.resultNodeId, 'n1', 'no node was minted, so the target still holds the content');
});

test('supersede reports the NEW node id, which the SDK result does not expose', async () => {
  const instance = makeInstance({ mintOnSupersede: true });
  const impl = new GraphnosisImpl();

  const outcome = await impl.applyCorrectionChecked(handleFor(instance), {
    kind: 'supersede',
    nodeId: 'n1',
    content: 'replacement text',
    reason: 'superseded by newer fact',
  });

  assert.equal(outcome.applied, true);
  assert.equal(outcome.nodeId, 'n1', 'nodeId stays the correction TARGET');
  assert.equal(outcome.resultNodeId, 'minted-1', 'resultNodeId must follow the newly minted node');
  assert.equal(outcome.nodesSuperseded, 1);
});

test('an indelible edit (SDK 0.10.0 shape) also reports the minted node id', async () => {
  // 0.10.0 retires the target and mints a replacement. The adapter learns the
  // new id from the node-map diff, not from a result field — so this works
  // without knowing 0.10.0's field name.
  const instance = makeInstance({ mintOnEdit: true });
  const impl = new GraphnosisImpl();

  const outcome = await impl.applyCorrectionChecked(handleFor(instance), {
    kind: 'edit',
    nodeId: 'n1',
    content: 'new text',
    reason: 'user correction',
  });

  assert.equal(outcome.applied, true);
  assert.equal(outcome.nodeId, 'n1');
  assert.equal(outcome.resultNodeId, 'minted-1');
});

test('delete reports the target as the affected node', async () => {
  const instance = makeInstance();
  const impl = new GraphnosisImpl();

  const outcome = await impl.applyCorrectionChecked(handleFor(instance), {
    kind: 'delete',
    nodeId: 'n2',
    reason: 'forget source',
  });

  assert.equal(outcome.applied, true);
  assert.equal(outcome.resultNodeId, 'n2');
  assert.deepEqual(instance._calls().at(-1), { fn: 'deleteNode', nodeId: 'n2', reason: 'forget source' });
});

// The adapter interface HAS now been widened, so this test's original assertion
// — `returned === undefined`, "signature must stay void until the adapter
// interface is widened" — described a temporary state that no longer exists.
//
// Its INTENT survives untouched and is what is asserted here: a caller that
// ignores the return value must be completely unaffected. That was the whole
// reason the shim existed. What changed is the mechanism, not the guarantee, so
// the assertion moves rather than the test being deleted or relaxed.
test('existing callers that ignore the result are unaffected; applyCorrection now RETURNS the outcome', async () => {
  const instance = makeInstance();
  const impl = new GraphnosisImpl();

  const edit = { kind: 'edit', nodeId: 'n1', content: 'new text', reason: 'user correction' };

  // A caller written against the old `Promise<void>` shape: awaits, ignores.
  await impl.applyCorrection(handleFor(instance), edit);
  assert.deepEqual(instance._calls(), [
    { fn: 'edit', nodeId: 'n1', content: 'new text', reason: 'user correction' },
  ], 'a caller that ignores the result still drives exactly the same SDK call');

  // The same call now also HANDS BACK what happened, which is the point of 2.1.
  const instance2 = makeInstance();
  const returned = await new GraphnosisImpl().applyCorrection(handleFor(instance2), edit);
  assert.notEqual(returned, undefined, 'applyCorrection must no longer discard the outcome');
  assert.equal(returned.applied, true);
  assert.equal(returned.nodeId, 'n1');
  assert.equal(typeof returned.resultNodeId, 'string',
    'the id the correction PRODUCED must reach the caller — that is what four upgrade blockers needed');
  assert.deepEqual(returned.errors, []);
});

test('missing content still throws for edit and supersede (unchanged behaviour)', async () => {
  const impl = new GraphnosisImpl();

  await assert.rejects(
    () => impl.applyCorrectionChecked(handleFor(makeInstance()), { kind: 'edit', nodeId: 'n1', reason: 'r' }),
    /edit requires content/,
  );
  await assert.rejects(
    () => impl.applyCorrectionChecked(handleFor(makeInstance()), { kind: 'supersede', nodeId: 'n1', reason: 'r' }),
    /supersede requires content/,
  );
  // The void wrapper must propagate the same rejection.
  await assert.rejects(
    () => impl.applyCorrection(handleFor(makeInstance()), { kind: 'edit', nodeId: 'n1', reason: 'r' }),
    /edit requires content/,
  );
});

test('an unbuilt handle is built before the correction is applied', async () => {
  const instance = makeInstance();
  const impl = new GraphnosisImpl();

  await impl.applyCorrectionChecked({ graphId: 'g', instance, built: false }, {
    kind: 'delete',
    nodeId: 'n1',
    reason: 'forget',
  });

  assert.equal(instance._calls()[0].fn, 'build', 'build must run first, as before');
});
