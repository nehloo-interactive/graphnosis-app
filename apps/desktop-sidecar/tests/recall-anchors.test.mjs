/**
 * Regression tests for anchor-specificity scoring in federated recall.
 *
 * Encodes the multi-word-entity failure: when a query names a multi-word
 * proper noun, its single-token fragments ("Lake", "Silver") used to anchor
 * unrelated nodes across every engram at the SAME flat score as the true
 * full-phrase match. Those fragment anchors flooded the 20-node federation
 * budget with noise from large engrams, the real high-scoring match in a
 * small engram lost the tie-break, and the audit then reported that engram
 * as "no matches".
 *
 * Fixtures below are synthetic on purpose — these tests must never carry
 * real cortex content into a public repo.
 *
 * Run after build: node --test tests/recall-anchors.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANCHOR_SCORE,
  ANCHOR_SCORE_FRAGMENT,
  anchorScoreForEntity,
  selectAnchorNodes,
  extractQueryEntities,
} from '../dist/host/recall.js';

test('anchorScoreForEntity: full-phrase beats fragment tier', () => {
  assert.equal(anchorScoreForEntity('Silver Lake Quartet'), ANCHOR_SCORE);
  assert.equal(anchorScoreForEntity('Lake'), ANCHOR_SCORE_FRAGMENT);
  assert.equal(anchorScoreForEntity(undefined), ANCHOR_SCORE_FRAGMENT);
  assert.ok(ANCHOR_SCORE > ANCHOR_SCORE_FRAGMENT);
});

test('extractQueryEntities captures the multi-word phrase', () => {
  const ents = extractQueryEntities('Silver Lake Quartet concert');
  assert.ok(ents.includes('Silver Lake Quartet'), `got: ${ents.join(', ')}`);
});

const node = (id, contentPreview, entities = []) => ({
  id,
  confidence: 1,
  sourceFile: 'clip:x',
  contentPreview,
  entities,
});

test('selectAnchorNodes ranks full-phrase matches above fragment matches', () => {
  const inspected = [
    node('junk-1', 'Deploy the silver-bullet refactor pass', []),
    node('real', 'plan for Silver Lake Quartet concert at Riverside Arts Festival', ['Silver Lake Quartet']),
    node('junk-2', 'Lake district travel checklist for the app', []),
  ];
  const active = new Set(['junk-1', 'real', 'junk-2']);
  const entities = ['Silver Lake Quartet', 'Silver', 'Lake', 'Quartet'];

  const picked = selectAnchorNodes(inspected, active, entities, 2);
  assert.equal(picked[0].nodeId, 'real', 'full-phrase match must rank first');
  assert.equal(picked[0].matchedEntity, 'Silver Lake Quartet');
  // Fragment matches may still fill remaining slots, but at fragment tier.
  for (const p of picked.slice(1)) {
    assert.equal(anchorScoreForEntity(p.matchedEntity), ANCHOR_SCORE_FRAGMENT);
  }
});

test('selectAnchorNodes: fragment-only engram anchors at fragment tier', () => {
  const inspected = [node('n1', 'The lake was calm today', [])];
  const picked = selectAnchorNodes(inspected, new Set(['n1']), ['Silver Lake Quartet', 'Lake'], 3);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].matchedEntity, 'Lake');
  assert.equal(anchorScoreForEntity(picked[0].matchedEntity), ANCHOR_SCORE_FRAGMENT);
});
