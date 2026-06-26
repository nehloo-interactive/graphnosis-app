/**
 * Unit tests for local-LLM edit scope guardrails (correction.ts).
 * Run after build: node --test tests/correction-scope.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeLlmCorrectionDiff,
  correctionImpliesMultiNodeEdit,
  correctionImpliesDelete,
} from '../dist/correction.js';

const candidates = [
  { graphId: 'g1', nodeId: 'nodeA', text: 'Top match', viaGnn: false },
  { graphId: 'g1', nodeId: 'nodeB', text: 'Second match', viaGnn: false },
  { graphId: 'g1', nodeId: 'nodeC', text: 'Third match', viaGnn: false },
];

test('scopeLlmCorrectionDiff keeps only top node for simple correction', () => {
  const { diff, scopeWarnings } = scopeLlmCorrectionDiff(
    {
      edits: [
        { kind: 'supersede', nodeId: 'nodeA', content: 'fixed A', reason: 'r' },
        { kind: 'supersede', nodeId: 'nodeB', content: 'fixed B', reason: 'r' },
        { kind: 'delete', nodeId: 'nodeC', reason: 'r' },
      ],
      adds: [],
    },
    candidates,
    'the role title should be Senior Engineer',
  );
  assert.equal(diff.edits.length, 1);
  assert.equal(diff.edits[0].nodeId, 'nodeA');
  assert.ok(scopeWarnings.some((w) => w.includes('nodeB')));
  assert.ok(scopeWarnings.some((w) => w.includes('nodeC')));
});

test('scopeLlmCorrectionDiff drops invented nodeIds', () => {
  const { diff, scopeWarnings } = scopeLlmCorrectionDiff(
    {
      edits: [{ kind: 'supersede', nodeId: 'notInPool', content: 'x', reason: 'r' }],
      adds: [],
    },
    candidates,
    'fix typo',
  );
  assert.equal(diff.edits.length, 0);
  assert.ok(scopeWarnings.some((w) => w.includes('not in the candidate pool')));
});

test('scopeLlmCorrectionDiff strips delete unless user asked', () => {
  const { diff } = scopeLlmCorrectionDiff(
    {
      edits: [{ kind: 'delete', nodeId: 'nodeA', reason: 'r' }],
      adds: [],
    },
    candidates,
    'update the deadline to Friday',
  );
  assert.equal(diff.edits.length, 0);
});

test('scopeLlmCorrectionDiff allows delete when correction requests removal', () => {
  const { diff } = scopeLlmCorrectionDiff(
    {
      edits: [{ kind: 'delete', nodeId: 'nodeA', reason: 'r' }],
      adds: [],
    },
    candidates,
    'forget this note — remove it from memory',
  );
  assert.equal(diff.edits.length, 1);
  assert.equal(diff.edits[0].kind, 'delete');
});

test('correctionImpliesMultiNodeEdit detects explicit multi-target language', () => {
  assert.equal(correctionImpliesMultiNodeEdit('fix both memories about the trip'), true);
  assert.equal(correctionImpliesMultiNodeEdit('change the role to VP'), false);
});

test('correctionImpliesDelete detects removal intent', () => {
  assert.equal(correctionImpliesDelete('please delete that entry'), true);
  assert.equal(correctionImpliesDelete('correct the spelling'), false);
});
