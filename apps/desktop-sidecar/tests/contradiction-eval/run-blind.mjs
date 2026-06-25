/**
 * §12.6 THIRD-PARTY validation — frozen triage over a BLIND set authored + labeled by an
 * external model from the lane definitions only, with no access to the triage rules.
 *
 * We report AGREEMENT, not accuracy: the external labeler is NOT an oracle. Where the
 * deterministic triage and the independent labels concur, that is mutual validation; where
 * they differ, each row is printed for adjudication (real triage error vs labeler mislabel
 * vs genuine taxonomy-boundary ambiguity). Same real triage + production extractor; no LLM.
 *
 *   node tests/contradiction-eval/run-blind.mjs [blind-set.json]
 *
 * Input: a JSON array (or { items: [...] }) of
 *   { id, snippetA, snippetB, expectedLane, rationale?, confidence?, ingest?, expiredA?, expiredB? }
 */
import { readFileSync } from 'node:fs';
import { evaluateContradictionTriage } from '../../dist/contradiction-utils.js';
import { extractEntities } from '../../node_modules/@nehloo/graphnosis/dist/core/extraction/entity-extractor.js';

const file = process.argv[2] ?? 'blind-set.json';
const raw = JSON.parse(readFileSync(new URL('./' + file, import.meta.url), 'utf8'));
const SET = Array.isArray(raw) ? raw : raw.items;
const DAY = 86_400_000, now = Date.now();
const LANES = ['queue', 'supersession', 'negation', 'suppress'];
const shared = (a, b) => { const eb = new Set(extractEntities(b).map((e) => e.toLowerCase())); return extractEntities(a).filter((e) => eb.has(e.toLowerCase())); };
const laneOf = (r) => (r.queue ? 'queue' : r.reason === 'temporal-supersession' ? 'supersession' : r.reason === 'negation-artifact' ? 'negation' : 'suppress');

const rows = SET.map((it) => {
  const sh = shared(it.snippetA, it.snippetB);
  const r = evaluateContradictionTriage({ snippetA: it.snippetA, snippetB: it.snippetB, sharedEntities: sh, ingest: it.ingest ?? false, validUntilA: it.expiredA ? now - DAY : undefined, validUntilB: it.expiredB ? now - DAY : undefined });
  const triage = laneOf(r);
  return { id: it.id, labeled: it.expectedLane, triage, agree: triage === it.expectedLane, reason: r.reason, sev: r.severity, shN: sh.length, conf: it.confidence ?? '?', why: it.rationale ?? '', A: it.snippetA, B: it.snippetB };
});

const n = rows.length, agree = rows.filter((x) => x.agree).length;
console.log(`BLIND third-party set: ${n} pairs (external labeler, blind to the triage rules)`);
console.log(`Agreement (triage vs independent labels): ${agree}/${n} (${(100 * agree / n).toFixed(1)}%)`);
console.log(`  — this is AGREEMENT, not accuracy: the labeler is not an oracle. Adjudicate disagreements below.\n`);

// Confusion matrix: rows = independent label, cols = triage decision.
const w = 13;
console.log('label \\ triage'.padEnd(16) + LANES.map((l) => l.padStart(w)).join(''));
for (const lr of LANES) {
  const cells = LANES.map((lc) => rows.filter((x) => x.labeled === lr && x.triage === lc).length);
  console.log(lr.padEnd(16) + cells.map((c) => String(c).padStart(w)).join(''));
}
const byLabel = (l) => { const t = rows.filter((x) => x.labeled === l); return t.length ? `${t.filter((x) => x.agree).length}/${t.length}` : '—'; };
console.log('\nper-lane agreement: ' + LANES.map((l) => `${l} ${byLabel(l)}`).join('   '));
console.log(`low-confidence labels: ${rows.filter((x) => x.conf === 'low').length}`);

const dis = rows.filter((x) => !x.agree);
console.log(`\nDISAGREEMENTS to adjudicate (${dis.length}):`);
for (const d of dis) {
  console.log(`  [${d.id}] label=${d.labeled}  →  triage=${d.triage}  (${d.reason}, sev=${d.sev}, sharedN=${d.shN}, conf=${d.conf})`);
  console.log(`        A: ${d.A}`);
  console.log(`        B: ${d.B}`);
  if (d.why) console.log(`        labeler rationale: ${d.why}`);
}
