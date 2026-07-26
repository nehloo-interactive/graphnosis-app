/**
 * Regression test for transferring a SKILL source between engrams.
 *
 * The bug: `host.moveSource` (the SDK primitive) keeps only the SEED node of a
 * multi-node source. For a trained skill the seed is its
 * `<!-- Graphnosis skill training metadata -->` comment — so transferring a
 * skill to another Skills engram replaced the entire procedure with its own
 * training header. The Skills UI still showed vitality 100 and "1 nodes"; the
 * skill was gone.
 *
 * `promote_import` already worked around this via
 * promoteSkillSourcePreservingNodes. The two TRANSFER paths did not:
 *   - MCP  `transfer_source`   (mcp-server.ts)
 *   - App  `sources.move`      (ipc.ts, the Sources page)
 *
 * moveSourcePreservingSkillNodes is the shared fix. Non-skill sources must keep
 * taking the raw primitive — the repair re-derives node roles from SOP section
 * prefixes, which is meaningless for a PDF or a clip.
 *
 * Run after build: node --test tests/skill-source-move.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveSourcePreservingSkillNodes } from '../dist/skill-trainer.js';

const FROM = 'skills-a';
const TO = 'skills-b';

const SKILL_NODES = [
  '<!-- Graphnosis skill training metadata\n     mode: source-only\n-->',
  'Report Format',
  'Trigger: the user asks for a formatted report',
  'Success: every page uses the same layout [verify: human]',
  '1. Set the page to A4 portrait with 15mm margins',
  '2. Render figure captions below each figure',
];

/**
 * In-memory host reproducing the SDK's lossy move: the destination record keeps
 * only the first (seed) node. Everything else is dropped, exactly as the real
 * primitive does for a multi-node source.
 */
function makeHost({ kind = 'skill' } = {}) {
  const content = new Map();
  SKILL_NODES.forEach((text, i) => content.set(`n${i}`, text));
  const records = new Map([
    [`${FROM}/src-1`, { sourceId: 'src-1', kind, nodeIds: SKILL_NODES.map((_, i) => `n${i}`) }],
  ]);
  let inserted = 0;
  const relinks = [];
  const snapshotMoves = [];
  return {
    _relinks: () => relinks,
    _snapshotMoves: () => snapshotMoves,
    // Snapshots are keyed <graphId>/<sourceId>, so a move has to carry the
    // retrain history across or the skill lands with an empty History panel.
    skillSnapshots: {
      move: async (fromG, toG, sid) => { snapshotMoves.push({ fromG, toG, sid }); return true; },
    },
    _record: (g) => records.get(`${g}/src-1`),
    getSourceRecord: (g, sid) => records.get(`${g}/${sid}`),
    getFullNodeContent: (_g, id) => content.get(id),
    listSources: (g) => (records.has(`${g}/src-1`) ? [records.get(`${g}/src-1`)] : []),
    listNodes: () => [],
    listEdges: () => ({ directed: [], undirected: [] }),
    unlinkEdgesBatch: async () => {},
    linkNodesBatch: async () => {},
    triggerRelink: (g) => relinks.push(g),
    getGraphMetadata: () => ({ template: 'skill' }),
    async moveSource(fromG, sid, toG) {
      const rec = records.get(`${fromG}/${sid}`);
      const seed = rec.nodeIds[0];
      const dropped = rec.nodeIds.slice(1);
      records.delete(`${fromG}/${sid}`);
      records.set(`${toG}/${sid}`, { ...rec, nodeIds: [seed] });
      return { newRecord: records.get(`${toG}/${sid}`), forgottenNodeIds: dropped };
    },
    async insertNodeAt(g, sid, _pos, text) {
      const rec = records.get(`${g}/${sid}`);
      const id = `ins${inserted++}`;
      content.set(id, text);
      rec.nodeIds.push(id);
    },
  };
}

test('a transferred skill keeps every node, not just its metadata header', async () => {
  const host = makeHost();
  const before = host._record(FROM).nodeIds.length;
  assert.equal(before, SKILL_NODES.length);

  const res = await moveSourcePreservingSkillNodes(host, FROM, 'src-1', TO);

  const after = host._record(TO);
  assert.equal(after.nodeIds.length, before, 'every node survived the move');
  assert.equal(res.repaired, SKILL_NODES.length - 1, 'the dropped nodes were repaired');

  const texts = after.nodeIds.map((id) => host.getFullNodeContent(TO, id));
  for (const original of SKILL_NODES) {
    assert.ok(texts.includes(original), `lost node: ${original.slice(0, 40)}`);
  }
});

test('the transferred skill is still walkable — steps and goals survive', async () => {
  // The failure mode users saw: only the training-metadata comment remained,
  // so the skill lint-scored 0/8 and walk_skill returned an empty procedure.
  const host = makeHost();
  await moveSourcePreservingSkillNodes(host, FROM, 'src-1', TO);
  const texts = host._record(TO).nodeIds.map((id) => host.getFullNodeContent(TO, id));

  assert.ok(texts.some((t) => t.startsWith('Trigger:')), 'goal nodes survived');
  assert.ok(texts.some((t) => /^1\. Set the page/.test(t)), 'step 1 survived');
  assert.ok(texts.some((t) => /^2\. Render figure captions/.test(t)), 'step 2 survived');
  assert.ok(
    texts.filter((t) => t.includes('Graphnosis skill training metadata')).length === 1,
    'the metadata header is present exactly once, not duplicated by the repair',
  );
});

test('a moved skill carries its retrain history with it', async () => {
  // Snapshots live at <cortexDir>/skill-snapshots/<graphId>/<sourceId>/. Moving
  // engrams changed the graphId, so list() hit ENOENT and the Skills panel said
  // "No earlier versions yet" — the history was never deleted, just stranded.
  const host = makeHost();
  await moveSourcePreservingSkillNodes(host, FROM, 'src-1', TO);
  assert.deepEqual(host._snapshotMoves(), [{ fromG: FROM, toG: TO, sid: 'src-1' }]);
});

test('repairing a skill move re-links its SOP edges', async () => {
  // Dropped nodes take their edges with them, so a repaired move must rebuild
  // the sequence/goal/loop/branch/call edge set or the skill walks as a flat
  // list of orphans.
  const host = makeHost();
  await moveSourcePreservingSkillNodes(host, FROM, 'src-1', TO);
  assert.ok(host._relinks().includes(TO), 'relink was triggered on the destination');
});

test('non-skill sources still take the raw primitive', async () => {
  // The repair re-derives node roles from SOP section prefixes — applying it to
  // a PDF or a clip would mislabel every chunk.
  const host = makeHost({ kind: 'file' });
  const res = await moveSourcePreservingSkillNodes(host, FROM, 'src-1', TO);
  assert.equal(res.repaired, 0);
  assert.equal(host._record(TO).nodeIds.length, 1, 'primitive behaviour unchanged');
  assert.deepEqual(res.forgottenNodeIds, ['n1', 'n2', 'n3', 'n4', 'n5']);
});

test('a lossless move reports zero repairs', async () => {
  // If the SDK primitive is ever fixed to carry all nodes, the wrapper must
  // become a no-op rather than duplicating content.
  const host = makeHost();
  host.moveSource = async (fromG, sid, toG) => {
    const rec = host.getSourceRecord(fromG, sid);
    const moved = { ...rec };
    host.getSourceRecord = (g, s) => (g === toG && s === sid ? moved : undefined);
    return { newRecord: moved, forgottenNodeIds: [] };
  };
  const res = await moveSourcePreservingSkillNodes(host, FROM, 'src-1', TO);
  assert.equal(res.repaired, 0);
  assert.equal(res.newRecord.nodeIds.length, SKILL_NODES.length);
});
