/**
 * Regression test for sub-skill call EDGE ownership (linkSkillCalls).
 *
 * The bug: a trained skill's outbound calls were destroyed moments after being
 * written, so walking any skill reported its sub-skills as missing even though
 * they existed in the same engram.
 *
 * Sequence that did it — all of it inside a single train_skill:
 *   1. linkSkillCalls(A) writes the edge A.step -> B.title
 *   2. refreshIncomingCallsToSkill(A) then re-runs linkSkillCalls for every
 *      OTHER skill, B included
 *   3. B's pass retired every call edge touching B's nodes — matching on
 *      `e.to` as well as `e.from`, so it swallowed A -> B
 *   4. B's pass only rebuilds edges ORIGINATING at B, and A is excluded from
 *      the sweep, so nothing ever put A -> B back
 *
 * A pass must therefore own exactly the edges it originates. This test drives
 * linkSkillCalls directly against an in-memory host so it needs no cortex.
 *
 * Run after build: node --test tests/skill-call-linking.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkSkillCalls } from '../dist/skill-trainer.js';

const GRAPH = 'skills';

/** Minimal in-memory GraphnosisHost covering only what linkSkillCalls touches. */
function makeHost() {
  const nodes = [
    // Skill A: title + one body step that calls B.
    { id: 'a-title', contentPreview: 'caller-skill', confidence: 1 },
    { id: 'a-step', contentPreview: '2. Do the thing:\n   @skill: target-skill', confidence: 1 },
    // Skill B: title only.
    { id: 'b-title', contentPreview: 'target-skill', confidence: 1 },
  ];
  const sources = [
    { sourceId: 'src-a', kind: 'skill', ref: 'skill:1:caller-skill', nodeIds: ['a-title', 'a-step'] },
    { sourceId: 'src-b', kind: 'skill', ref: 'skill:2:target-skill', nodeIds: ['b-title'] },
  ];
  let edges = [];
  let seq = 0;
  return {
    _edges: () => edges,
    getSourceRecord: (_g, sourceId) => sources.find((s) => s.sourceId === sourceId),
    listSources: () => sources,
    listNodes: () => nodes,
    getFullNodeContent: (_g, id) => nodes.find((n) => n.id === id)?.contentPreview,
    listEdges: () => ({ directed: edges, undirected: [] }),
    unlinkEdgesBatch: async (_g, ids) => { edges = edges.filter((e) => !ids.includes(e.id)); },
    linkNodesDirectedBatch: async (_g, batch) => {
      for (const b of batch) edges.push({ id: `e${++seq}`, ...b });
    },
  };
}

const callEdges = (host) => host._edges().filter((e) => e.evidence?.startsWith('skill:calls'));

test('a skill call produces an edge to the target skill title', async () => {
  const host = makeHost();
  await linkSkillCalls(host, GRAPH, 'src-a', GRAPH);
  const edges = callEdges(host);
  assert.equal(edges.length, 1, 'expected exactly one call edge');
  assert.equal(edges[0].from, 'a-step');
  assert.equal(edges[0].to, 'b-title', 'edge should point at the target skill title node');
});

test('linking the TARGET skill does not destroy incoming calls', async () => {
  // This is the regression. Step 1 writes A -> B; step 2 is the sweep that used
  // to delete it. The edge must survive, because rebuilding B's own calls says
  // nothing about who calls B.
  const host = makeHost();
  await linkSkillCalls(host, GRAPH, 'src-a', GRAPH);
  assert.equal(callEdges(host).length, 1, 'precondition: A -> B exists');

  await linkSkillCalls(host, GRAPH, 'src-b', GRAPH);

  const surviving = callEdges(host);
  assert.equal(
    surviving.length, 1,
    'A -> B was deleted by the pass for B; a pass must only retire edges it originates',
  );
  assert.equal(surviving[0].from, 'a-step');
  assert.equal(surviving[0].to, 'b-title');
});

test('re-linking the CALLER replaces its own edges without duplicating', async () => {
  // The other half of ownership: a pass must still fully rebuild its own calls,
  // so retraining a caller does not accumulate stale duplicates.
  const host = makeHost();
  await linkSkillCalls(host, GRAPH, 'src-a', GRAPH);
  await linkSkillCalls(host, GRAPH, 'src-a', GRAPH);
  assert.equal(callEdges(host).length, 1, 'caller re-link should replace, not duplicate');
});

test('call edges survive a full sweep over every other skill', async () => {
  // Mirrors refreshIncomingCallsToSkill: after training A, every OTHER skill is
  // re-linked. A's outbound call must still be there afterwards.
  const host = makeHost();
  await linkSkillCalls(host, GRAPH, 'src-a', GRAPH);
  for (const other of ['src-b']) {
    await linkSkillCalls(host, GRAPH, other, GRAPH);
  }
  assert.equal(callEdges(host).length, 1, 'the sweep must not strip the caller\'s edge');
});
