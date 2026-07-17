/**
 * Unit tests for the correction diff parser (correction.ts:extractJson) and the
 * nodeId bracket-strip in scopeLlmCorrectionDiff. Guards the "Local LLM returned
 * malformed JSON" regressions:
 *   - a ```json fence wrapping the object
 *   - an inner ```code``` fence inside a superseding-content string (the case a
 *     non-greedy fence capture used to truncate)
 *   - trailing commas / truncated (unbalanced-brace) output
 *   - a nodeId the model echoed with stray brackets, e.g. "[abc]"
 * Run after build: node --test tests/correction-parse.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, scopeLlmCorrectionDiff, resolveCandidateNodeId, proposeCorrection } from '../dist/correction.js';

const FENCE = '```'; // three backticks, no escaping headaches

test('parses a clean JSON object', () => {
  const out = extractJson('{ "edits": [], "adds": [], "reasoning": "ok" }');
  assert.deepEqual(out, { edits: [], adds: [], reasoning: 'ok' });
});

test('strips a ```json code fence', () => {
  const raw = FENCE + 'json\n{ "edits": [], "adds": [] }\n' + FENCE;
  assert.deepEqual(extractJson(raw), { edits: [], adds: [] });
});

test('survives an inner ```code``` fence inside superseding content', () => {
  // The regression: a non-greedy fence capture stopped at the first inner
  // fence and truncated the object. The brace-slice parser keeps the whole
  // object, inner fences and all.
  const content = 'see ' + FENCE + 'js const x = 1 ' + FENCE + ' end';
  const raw = FENCE + 'json\n{ "edits": [ { "kind": "supersede", "nodeId": "qqpR", "content": '
    + JSON.stringify(content) + ', "reason": "fix" } ], "adds": [] }\n' + FENCE;
  const out = extractJson(raw);
  assert.equal(out.edits.length, 1);
  assert.equal(out.edits[0].nodeId, 'qqpR');
  assert.equal(out.edits[0].content, content);
});

test('drops trailing commas', () => {
  const out = extractJson('{ "edits": [ { "kind": "delete", "nodeId": "a", "reason": "r" }, ], "adds": [], }');
  assert.equal(out.edits.length, 1);
  assert.equal(out.edits[0].nodeId, 'a');
});

test('repairs a truncated (unbalanced-brace) object', () => {
  // Model ran out of tokens mid-array: missing the closing ] and }.
  const out = extractJson('{ "edits": [ { "kind": "supersede", "nodeId": "a", "content": "x", "reason": "r" }');
  assert.equal(out.edits.length, 1);
  assert.equal(out.edits[0].nodeId, 'a');
});

test('throws when there is no JSON object at all', () => {
  assert.throws(() => extractJson('I could not do that.'), /no JSON object/);
});

test('throws on unrecoverable garbage', () => {
  assert.throws(() => extractJson('{ "edits": [ {{{ nonsense ]]] '), /unparseable JSON/);
});

test('scope guardrails strip stray brackets the model echoed onto a nodeId', () => {
  const candidates = [{ graphId: 'g1', nodeId: 'nodeA', text: 'Top', viaGnn: false }];
  const { diff, scopeWarnings } = scopeLlmCorrectionDiff(
    { edits: [{ kind: 'supersede', nodeId: '[nodeA]', content: 'fixed', reason: 'r' }], adds: [] },
    candidates,
    'fix the title',
  );
  assert.equal(diff.edits.length, 1, 'bracketed nodeId should still match candidate');
  assert.equal(diff.edits[0].nodeId, 'nodeA');
  assert.equal(scopeWarnings.length, 0);
});

test('resolveCandidateNodeId — exact, transposition, ambiguous, no-match', () => {
  const ids = ['qqpR_gIDLNHrB-rkJ1j3J', 'YDgik5pqV5LQ3RfV3e-sh'];
  // exact
  assert.equal(resolveCandidateNodeId('qqpR_gIDLNHrB-rkJ1j3J', ids), 'qqpR_gIDLNHrB-rkJ1j3J');
  // transposition qqpR -> qpqR (distance 1) recovers the correct id
  assert.equal(resolveCandidateNodeId('qpqR_gIDLNHrB-rkJ1j3J', ids), 'qqpR_gIDLNHrB-rkJ1j3J');
  // no close match -> null (do not guess)
  assert.equal(resolveCandidateNodeId('totally-different-id', ids), null);
  // ambiguous: two candidates equidistant -> null
  assert.equal(resolveCandidateNodeId('aaa', ['aab', 'aac']), null);
});

test('transposed nodeId recovers the correct target (does NOT drop the edit)', () => {
  const candidates = [
    { graphId: 'g1', nodeId: 'qqpR_gIDLNHrB-rkJ1j3J', text: 'the todo node', viaGnn: false },
    { graphId: 'g1', nodeId: 'YDgik5pqV5LQ3RfV3e-sh', text: 'unrelated file-path node', viaGnn: false },
  ];
  const { diff, scopeWarnings } = scopeLlmCorrectionDiff(
    { edits: [{ kind: 'supersede', nodeId: 'qpqR_gIDLNHrB-rkJ1j3J', content: 'DONE', reason: 'done' }], adds: [] },
    candidates,
    'mark the press release todo as done, node qqpR_gIDLNHrB-rkJ1j3J only',
  );
  assert.equal(diff.edits.length, 1);
  assert.equal(diff.edits[0].nodeId, 'qqpR_gIDLNHrB-rkJ1j3J', 'must resolve to the correct node, not the file-path one');
  assert.equal(scopeWarnings.length, 0);
});

test('honours a non-top in-pool candidate — no forced candidates[0]', () => {
  // Recall ranks the "lives in Madrid" node #1 (shared entity "Diana Gini"),
  // but the model correctly targets the TODO node at #2. The guardrail must keep
  // the model's choice, not force the top match.
  const candidates = [
    { graphId: 'g1', nodeId: 'KC5nq3w3XSEMGX0rl76kp', text: 'Diana Gini lives in Madrid', viaGnn: false },
    { graphId: 'g1', nodeId: 'qqpR_gIDLNHrB-rkJ1j3J', text: 'TODO: press release for Game On launch', viaGnn: false },
  ];
  const { diff, scopeWarnings } = scopeLlmCorrectionDiff(
    { edits: [{ kind: 'supersede', nodeId: 'qqpR_gIDLNHrB-rkJ1j3J', content: 'DONE - press release', reason: 'done' }], adds: [] },
    candidates,
    'mark the press release todo as done',
  );
  assert.equal(diff.edits.length, 1, 'the model-chosen non-top candidate must survive');
  assert.equal(diff.edits[0].nodeId, 'qqpR_gIDLNHrB-rkJ1j3J', 'must NOT be forced onto the unrelated top match');
  assert.equal(scopeWarnings.length, 0);
});

test('proposeCorrection NEVER substitutes an unrelated top-match on an unmatched id', async () => {
  const fakeHost = {
    recall: async () => ({
      byGraph: new Map([['g1', [
        { nodeId: 'KC5nq3w3XSEMGX0rl76kp', text: 'Diana Gini lives in Madrid' },
        { nodeId: 'qqpR_gIDLNHrB-rkJ1j3J', text: 'TODO press release' },
      ]]]),
    }),
  };
  const fakeLlm = {
    name: 'fake',
    // Model returns a nodeId that matches NO candidate (and isn't fuzzy-close).
    complete: async () => JSON.stringify({
      edits: [{ kind: 'supersede', nodeId: 'ZZZZ-not-a-real-id', content: 'DONE', reason: 'done' }],
      adds: [],
    }),
  };
  const res = await proposeCorrection({ host: fakeHost, llm: fakeLlm, correction: 'mark the todo done' });
  assert.equal(res.diff.edits.length, 0, 'no edit should be proposed');
  assert.ok(
    !res.diff.edits.some((e) => e.nodeId === 'KC5nq3w3XSEMGX0rl76kp'),
    'must NOT fall back to superseding the unrelated top recall match',
  );
  assert.match(res.diff.reasoning ?? '', /scope|match|change/i);
});
