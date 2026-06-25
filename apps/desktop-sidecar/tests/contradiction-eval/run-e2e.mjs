/**
 * §12.x — thin end-to-end confirmation.
 *
 *   node tests/contradiction-eval/run-e2e.mjs
 *
 * Goal: prove the triage benchmark is NOT tested in a vacuum. For representative
 * pairs, build a REAL graph with the SDK's production buildGraph (real chunking +
 * entity extraction), read the entities the graph nodes actually carry, and confirm
 * (a) they match the standalone extraction the triage harness used, and (b) the real
 * triage routes the pair the same way on those production entities.
 *
 * This models the user-facing compareSources / Memory-Integrity path (two saved
 * memories compared on demand) — the path the deterministic triage actually drives.
 * (The periodic auto-scan uses reflect()/detectContradictions, which skips <60-char
 * nodes and needs explicit conflict language, so atomic memories don't flow through it.)
 */
import { readFileSync } from 'node:fs';
import { buildGraph } from '../../node_modules/@nehloo/graphnosis/dist/core/graph/graph-builder.js';
import { extractEntities } from '../../node_modules/@nehloo/graphnosis/dist/core/extraction/entity-extractor.js';
import { evaluateContradictionTriage } from '../../dist/contradiction-utils.js';

const set = JSON.parse(readFileSync(new URL('./eval-set.json', import.meta.url), 'utf8')).items;
const PICK = ['P01', 'P02', 'P04', 'P05', 'P11', 'U01'];

const mkDoc = (id, content) => ({
  title: id, sections: [{ title: id, content, depth: 1, children: [] }],
  sourceFile: `e2e:${id}`, metadata: {},
});
const contentNodes = (g) => [...g.nodes.values()].filter((n) => n.type !== 'document' && n.type !== 'section');
const shared = (ea, eb) => { const lb = new Set(eb.map((e) => e.toLowerCase())); return ea.filter((e) => lb.has(e.toLowerCase())); };
const laneOf = (r) => (r.queue ? 'queue' : r.reason === 'temporal-supersession' ? 'supersession' : r.reason === 'negation-artifact' ? 'negation' : 'suppress');
const sortEq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

console.log('id   expected   sharedFromGraph                          entitiesMatch  triage(prod)');
let allMatch = true, allAgree = true;
for (const id of PICK) {
  const it = set.find((x) => x.id === id);
  const g = buildGraph([mkDoc(id + 'A', it.snippetA), mkDoc(id + 'B', it.snippetB)], 'e2e');
  const ns = contentNodes(g);
  const nodeA = ns.find((n) => n.content.includes(it.snippetA.slice(0, 18))) ?? ns[0];
  const nodeB = ns.find((n) => n !== nodeA && n.content.includes(it.snippetB.slice(0, 18))) ?? ns.find((n) => n !== nodeA);
  const entA = nodeA?.entities ?? [];
  const entB = nodeB?.entities ?? [];
  const sharedProd = shared(entA, entB);
  const sharedStd = shared(extractEntities(it.snippetA), extractEntities(it.snippetB));
  const match = sortEq(sharedProd, sharedStd);
  const res = evaluateContradictionTriage({ snippetA: it.snippetA, snippetB: it.snippetB, sharedEntities: sharedProd, ingest: it.ingest ?? false });
  const lane = laneOf(res);
  if (!match) allMatch = false;
  // "agree" = production-entity triage lands in the same lane the standalone harness reported
  const stdRes = evaluateContradictionTriage({ snippetA: it.snippetA, snippetB: it.snippetB, sharedEntities: sharedStd, ingest: it.ingest ?? false });
  if (laneOf(stdRes) !== lane) allAgree = false;
  console.log(
    id.padEnd(5),
    it.expectedLane.padEnd(11),
    JSON.stringify(sharedProd).padEnd(40),
    String(match).padEnd(15),
    `${lane} (sev=${res.severity})`,
  );
}
console.log(`\nproduction-graph entities == standalone extraction on all picks : ${allMatch}`);
console.log(`triage lane identical on production vs standalone entities       : ${allAgree}`);
