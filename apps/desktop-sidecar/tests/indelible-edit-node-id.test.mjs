/**
 * A node id does NOT survive a correction. `appendDocument` must record the id
 * the correction PRODUCED.
 *
 * THE BUG
 * -------
 * Three call sites in `graphnosis-impl.ts` called the SDK's `edit()` and then
 * kept using the id they passed IN:
 *
 *   - the appendText sourceRef-artifact rewrite,
 *   - the `singleNode` multi-chunk merge,
 *   - the `singleNode` verbatim rewrite (which never updated the id at all).
 *
 * On SDK 0.8.0 that was fine: `edit` overwrote content in place. SDK 0.10.0
 * made `edit` INDELIBLE — it retires the target and mints a NEW node. From
 * that version on, the id these sites keep is a RETIRED node and the corrected
 * text lives on a node nobody recorded. `appendDocument`'s return value is
 * spliced straight into `sourceIndex.bySource[].nodeIds` by
 * `host.insertNodeAt`, which is why trained-skill steps became unwalkable
 * after an upgrade.
 *
 * WHY THE SDK RESULT SHAPE HERE IS SIMULATED
 * ------------------------------------------
 * The fix reads `CorrectionResult.affectedNodeIds`, added in SDK 0.11.0. The
 * SDK installed in this workspace is **0.8.0**, whose `CorrectionResult` is
 * exactly `{ applied, nodesAdded, nodesModified, nodesSuperseded, errors }` —
 * no `affectedNodeIds` at all (see
 * `node_modules/@nehloo/graphnosis/dist/core/corrections/correction-engine.d.ts`).
 * The installed SDK therefore CANNOT produce a differing id, so a real-SDK test
 * could not distinguish the fixed code from the broken code.
 *
 * So the fake SDK below emits BOTH result shapes deliberately:
 *
 *   - `sdkVersion: '0.8.0'`  → result WITHOUT `affectedNodeIds`, no node minted.
 *                              This is the real installed shape. It proves the
 *                              optional chain is required (a non-optional
 *                              `res.affectedNodeIds[0]` throws a TypeError here)
 *                              and that the fallback to the target id is right.
 *   - `sdkVersion: '0.11.0'` → result WITH `affectedNodeIds: ['<minted>']` and
 *                              the target retired. This shape is SIMULATED from
 *                              the SDK working tree's `correct()`
 *                              (`Graphnosis/src/sdk/index.ts`, which builds
 *                              `affectedNodeIds: result.success && result.affectedNodeId
 *                              ? [result.affectedNodeId] : []`). It is not
 *                              produced by any package installed here.
 *
 * WHICH TESTS BELOW ARE COVERAGE AND WHICH ARE A CONTRACT — 3 of 11.
 * -----------------------------------------------------------------
 * The three that drive `sdkVersion: '0.11.0'` and assert on a MINTED id are
 * registered through `test.contract`, so their names carry a `[CONTRACT-ONLY:
 * …]` prefix in the runner's output and the file prints a banner. Nothing
 * installed produces that result shape, so a green on them says the code is
 * ready for 0.11.0 — not that anything on this build behaves that way.
 *
 * The other eight are reachable today: three assert the INSTALLED 0.8.0 result
 * shape, three the refusal path (which does not depend on the version), one the
 * no-edit-needed short circuit, and one is a static read of the source text.
 *
 * Run after build: node --test tests/indelible-edit-node-id.test.mjs
 */
import assert from 'node:assert/strict';
import { contractLevelSuite } from './_contract-level.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GraphnosisImpl } from '../dist/graphnosis-impl.js';

/** `test` = reachable on the installed SDK 0.8.0; `test.contract` = needs 0.11.0. */
const test = contractLevelSuite('indelible-edit-node-id.test.mjs');

/**
 * Minimal stand-in for the SDK's `Graphnosis` — only the surface
 * `appendDocument` touches: `graph.nodes`, `appendText`, `edit`, `deleteNode`.
 *
 * @param chunks     content of each node `appendText` produces, in order
 * @param sdkVersion '0.8.0' (in-place edit, no result field) or '0.11.0'
 *                   (indelible edit, minted id reported in `affectedNodeIds`)
 * @param editFails  make `edit` REFUSE — the SDK reports this by RETURNING
 *                   `{ applied: 0, errors: [...] }`, never by throwing
 */
function makeInstance({ chunks, sourceRef, sdkVersion = '0.11.0', editFails = false } = {}) {
  const nodes = new Map();
  const calls = [];
  let minted = 0;

  return {
    graph: { nodes },
    _calls: () => calls,
    _nodeIds: () => [...nodes.keys()],
    build() { calls.push({ fn: 'build' }); },
    appendText(text, ref) {
      calls.push({ fn: 'appendText', text, ref });
      chunks.forEach((content, i) => {
        const id = `c${i + 1}`;
        nodes.set(id, { id, content, type: 'chunk', source: { file: ref }, confidence: 1 });
      });
      return { newNodes: chunks.length, contradictions: [] };
    },
    edit(nodeId, content, reason) {
      calls.push({ fn: 'edit', nodeId, content, reason });
      if (editFails) {
        // The exact failure shape the SDK returns. It does NOT throw.
        return { applied: 0, nodesAdded: 0, nodesModified: 0, nodesSuperseded: 0, errors: [`node not found: ${nodeId}`] };
      }
      if (sdkVersion === '0.8.0') {
        // Installed shape: content overwritten in place, NO affectedNodeIds key.
        const n = nodes.get(nodeId);
        if (n) n.content = content;
        return { applied: 1, nodesAdded: 0, nodesModified: 1, nodesSuperseded: 0, errors: [] };
      }
      // SIMULATED 0.11.0: target retired, replacement minted, id reported back.
      minted += 1;
      const newId = `minted-${minted}`;
      const old = nodes.get(nodeId);
      if (old) { old.confidence = 0; old.validUntil = Date.now(); }
      nodes.set(newId, { id: newId, content, type: 'chunk', source: { file: sourceRef }, confidence: 1 });
      return { applied: 1, nodesAdded: 0, nodesModified: 0, nodesSuperseded: 1, errors: [], affectedNodeIds: [newId] };
    },
    deleteNode(nodeId, reason) {
      calls.push({ fn: 'deleteNode', nodeId, reason });
      const n = nodes.get(nodeId);
      if (n) n.confidence = 0;
      return { applied: 1, nodesAdded: 0, nodesModified: 0, nodesSuperseded: 0, errors: [] };
    },
  };
}

const handleFor = (instance) => ({ graphId: 'g', instance, built: true });

/** Capture console.error for the duration of `fn`. */
async function captureErrors(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.join(' ')); };
  try { return { value: await fn(), lines }; } finally { console.error = original; }
}

const STEP = 'Step 4. Collect the letters of support, etc.) and verify each one.';
const SKILL_REF = 'skill:1730000000:demo-step';

// ── singleNode: multi-chunk merge ───────────────────────────────────────────

test('singleNode merge records the id the correction PRODUCED, not the one passed in', async () => {
  // Simulated SDK 0.11.0 result shape (see file header) — the installed 0.8.0
  // cannot produce a differing id, so this is the only way to exercise it.
  const instance = makeInstance({ chunks: ['Step 4. Collect the letters of support, etc.', 'and verify each one.'], sourceRef: SKILL_REF, sdkVersion: '0.11.0' });
  const impl = new GraphnosisImpl();

  const result = await impl.appendDocument(
    handleFor(instance),
    { kind: 'text', content: STEP, sourceRef: SKILL_REF },
    { singleNode: true },
  );

  assert.deepEqual(result.newNodeIds, ['minted-1'],
    'the merged step lives on the minted node; returning the retired target is the bug');
  assert.notEqual(result.newNodeIds[0], 'c1', 'c1 was retired by the edit and must not be recorded');
  // The recorded node must actually carry the verbatim step text.
  assert.equal(instance.graph.nodes.get(result.newNodeIds[0]).content, STEP);
  // And it must be live, not retired.
  assert.equal(instance.graph.nodes.get(result.newNodeIds[0]).confidence, 1);
});

test('singleNode merge on the INSTALLED 0.8.0 result shape still records the target', async () => {
  // No `affectedNodeIds` key at all. The optional chain must yield undefined
  // and fall back to the target — which is the correct answer for an in-place
  // edit. A non-optional `res.affectedNodeIds[0]` would throw a TypeError here.
  const instance = makeInstance({ chunks: ['Step 4. Collect the letters of support, etc.', 'and verify each one.'], sourceRef: SKILL_REF, sdkVersion: '0.8.0' });
  const impl = new GraphnosisImpl();

  const result = await impl.appendDocument(
    handleFor(instance),
    { kind: 'text', content: STEP, sourceRef: SKILL_REF },
    { singleNode: true },
  );

  assert.deepEqual(result.newNodeIds, ['c1']);
  assert.equal(instance.graph.nodes.get('c1').content, STEP);
});

test('a REFUSED singleNode merge is surfaced instead of swallowed', async () => {
  const instance = makeInstance({ chunks: ['fragment a', 'fragment b'], sourceRef: SKILL_REF, editFails: true });
  const impl = new GraphnosisImpl();

  const { value: result, lines } = await captureErrors(() => impl.appendDocument(
    handleFor(instance),
    { kind: 'text', content: STEP, sourceRef: SKILL_REF },
    { singleNode: true },
  ));

  // The SDK returned normally, so the refusal is only visible in the result —
  // the removed `catch {}` could not see it at all.
  assert.equal(lines.length, 1, 'the refusal must be reported');
  assert.match(lines[0], /single-node merge refused for c1/);
  assert.match(lines[0], /node not found: c1/);
  assert.deepEqual(result.newNodeIds, ['c1'], 'unchanged fallback: keep the first chunk');
  // Fragments must NOT be deleted when the merge that was supposed to absorb
  // them never happened.
  assert.equal(instance._calls().some(c => c.fn === 'deleteNode'), false);
});

// ── singleNode: single-chunk verbatim rewrite (the site with `catch {}`) ─────

test('singleNode verbatim rewrite records the produced id — the old code never updated it at all', async () => {
  // Simulated SDK 0.11.0 result shape (see file header).
  const instance = makeInstance({ chunks: ['Step 4. Collect the letters of support, etc.'], sourceRef: SKILL_REF, sdkVersion: '0.11.0' });
  const impl = new GraphnosisImpl();

  const result = await impl.appendDocument(
    handleFor(instance),
    { kind: 'text', content: STEP, sourceRef: SKILL_REF },
    { singleNode: true },
  );

  assert.deepEqual(result.newNodeIds, ['minted-1'],
    'the verbatim text is on the minted node; the old code returned the retired c1');
  assert.equal(instance.graph.nodes.get('minted-1').content, STEP);
  assert.equal(instance.graph.nodes.get('c1').confidence, 0, 'c1 is retired — recording it would be recording a dead node');
});

test('singleNode verbatim rewrite on the INSTALLED 0.8.0 result shape keeps the target', async () => {
  const instance = makeInstance({ chunks: ['Step 4. Collect the letters of support, etc.'], sourceRef: SKILL_REF, sdkVersion: '0.8.0' });
  const impl = new GraphnosisImpl();

  const result = await impl.appendDocument(
    handleFor(instance),
    { kind: 'text', content: STEP, sourceRef: SKILL_REF },
    { singleNode: true },
  );

  assert.deepEqual(result.newNodeIds, ['c1']);
  assert.equal(instance.graph.nodes.get('c1').content, STEP);
});

test('a REFUSED verbatim rewrite is reported — the deleted `catch { /* ignore */ }` hid exactly this', async () => {
  const instance = makeInstance({ chunks: ['Step 4. Collect the letters of support, etc.'], sourceRef: SKILL_REF, editFails: true });
  const impl = new GraphnosisImpl();

  const { value: result, lines } = await captureErrors(() => impl.appendDocument(
    handleFor(instance),
    { kind: 'text', content: STEP, sourceRef: SKILL_REF },
    { singleNode: true },
  ));

  assert.equal(lines.length, 1);
  assert.match(lines[0], /verbatim rewrite refused for c1/);
  assert.deepEqual(result.newNodeIds, ['c1'], 'the SDK chunking stands when the rewrite is refused');
});

test('no edit is attempted when the single chunk already carries the verbatim text', async () => {
  const instance = makeInstance({ chunks: [STEP], sourceRef: SKILL_REF });
  const impl = new GraphnosisImpl();

  const result = await impl.appendDocument(
    handleFor(instance),
    { kind: 'text', content: STEP, sourceRef: SKILL_REF },
    { singleNode: true },
  );

  assert.deepEqual(result.newNodeIds, ['c1']);
  assert.equal(instance._calls().some(c => c.fn === 'edit'), false, 'unchanged: nothing to correct');
});

// ── the appendText sourceRef-artifact rewrite ───────────────────────────────

test('the sourceRef-artifact rewrite records the produced id', async () => {
  // appendText prepends a synthetic `# <sourceRef>` H1, so short content
  // collapses to artifact nodes whose content IS the raw sourceRef. The
  // adapter rewrites the first one to the real text instead of deleting it and
  // returning nothing. Simulated SDK 0.11.0 result shape (see file header).
  const ref = 'clip:1730000000:short-note';
  const instance = makeInstance({ chunks: [ref, ref], sourceRef: ref, sdkVersion: '0.11.0' });
  const impl = new GraphnosisImpl();

  const result = await impl.appendDocument(
    handleFor(instance),
    { kind: 'text', content: 'wife name Maria', sourceRef: ref },
  );

  assert.deepEqual(result.newNodeIds, ['minted-1'],
    'the rewritten content is on the minted node, not on the retired artifact');
  assert.equal(instance.graph.nodes.get('minted-1').content, 'wife name Maria');
  // The duplicate artifact (document + section pair) is still cleaned up.
  assert.deepEqual(
    instance._calls().filter(c => c.fn === 'deleteNode').map(c => c.nodeId),
    ['c2'],
  );
});

test('the sourceRef-artifact rewrite on the INSTALLED 0.8.0 result shape keeps the target', async () => {
  const ref = 'clip:1730000000:short-note';
  const instance = makeInstance({ chunks: [ref, ref], sourceRef: ref, sdkVersion: '0.8.0' });
  const impl = new GraphnosisImpl();

  const result = await impl.appendDocument(
    handleFor(instance),
    { kind: 'text', content: 'wife name Maria', sourceRef: ref },
  );

  assert.deepEqual(result.newNodeIds, ['c1']);
  assert.equal(instance.graph.nodes.get('c1').content, 'wife name Maria');
});

test('a REFUSED artifact rewrite falls through to the delete path and reports why', async () => {
  const ref = 'clip:1730000000:short-note';
  const instance = makeInstance({ chunks: [ref, ref], sourceRef: ref, editFails: true });
  const impl = new GraphnosisImpl();

  const { value: result, lines } = await captureErrors(() => impl.appendDocument(
    handleFor(instance),
    { kind: 'text', content: 'wife name Maria', sourceRef: ref },
  ));

  assert.match(lines.join('\n'), /artifact rewrite refused for c1/);
  assert.deepEqual(result.newNodeIds, [],
    'better to make the caller throw "no node ids" than to record a node whose content is the raw sourceRef');
  assert.deepEqual(
    instance._calls().filter(c => c.fn === 'deleteNode').map(c => c.nodeId),
    ['c1', 'c2'],
  );
});

// ── the property that makes the pattern version-agnostic ────────────────────

test('the source never subscripts affectedNodeIds without an optional chain', async () => {
  // On the installed 0.8.0 the field is ABSENT, so `res.affectedNodeIds[0]`
  // throws a TypeError on every correction. This guard survives an SDK upgrade
  // (unlike asserting on the .d.ts) because the app still supports both.
  const src = readFileSync(fileURLToPath(new URL('../src/graphnosis-impl.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const unguarded = [...src.matchAll(/affectedNodeIds\s*[[.]/g)]
    .filter(m => !/affectedNodeIds\s*\?\./.test(src.slice(m.index, m.index + 24)));

  assert.deepEqual(unguarded.map(m => src.slice(m.index, m.index + 40)), [],
    'affectedNodeIds must always be read through `?.` — it does not exist on SDK 0.8.0');
});
