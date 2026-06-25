/**
 * §12.x — Contradiction-triage precision/recall harness.
 *
 *   node tests/contradiction-eval/run-eval.mjs
 *
 * Runs the REAL deterministic triage (apps/desktop-sidecar/dist/contradiction-utils.js,
 * §8.2 Definition 2) over the frozen labeled set, with shared entities computed by the
 * REAL production extractor (@nehloo/graphnosis extractEntities). No LLM, no graph build,
 * fully deterministic. Reports a confusion matrix over the four routing lanes plus
 * per-class recall and false-positive suppression.
 *
 * Scope: this measures the TRIAGE stage (given a candidate pair sharing entities, is it
 * routed correctly?). Upstream detection/candidate-generation recall is a separate question.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateContradictionTriage } from '../../dist/contradiction-utils.js';
import { extractEntities } from '../../node_modules/@nehloo/graphnosis/dist/core/extraction/entity-extractor.js';

const SET = JSON.parse(readFileSync(new URL('./eval-set.json', import.meta.url), 'utf8'));
const items = SET.items;
const DAY = 86_400_000;

function sharedEntities(a, b) {
  const ea = extractEntities(a);
  const eb = extractEntities(b);
  const lowerB = new Set(eb.map((e) => e.toLowerCase()));
  return ea.filter((e) => lowerB.has(e.toLowerCase()));
}

function laneOf(res) {
  if (res.queue) return 'queue';
  if (res.reason === 'temporal-supersession') return 'supersession';
  if (res.reason === 'negation-artifact') return 'negation';
  return 'suppress'; // insufficient-entities | low-severity | ingest-gate
}

const LANES = ['queue', 'supersession', 'negation', 'suppress'];
const now = Date.now();

const rows = [];
for (const it of items) {
  const shared = sharedEntities(it.snippetA, it.snippetB);
  const res = evaluateContradictionTriage({
    snippetA: it.snippetA,
    snippetB: it.snippetB,
    sharedEntities: shared,
    ingest: it.ingest ?? false,
    validUntilA: it.expiredA ? now - DAY : undefined,
    validUntilB: it.expiredB ? now - DAY : undefined,
  });
  const actual = laneOf(res);
  rows.push({
    id: it.id, category: it.category, source: it.source,
    expected: it.expectedLane, actual, correct: actual === it.expectedLane,
    reason: res.reason, severity: res.severity, temporalVerdict: res.temporalVerdict,
    sharedN: shared.length, shared, snippetA: it.snippetA, snippetB: it.snippetB, note: it.note,
  });
}

// ---- per-item table ----
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log('\n=== PER-ITEM ===');
console.log(pad('id', 5), pad('expected→actual', 26), pad('reason', 22), pad('sev', 7), pad('tv', 22), 'shN  ok');
for (const r of rows) {
  console.log(
    pad(r.id, 5),
    pad(`${r.expected} → ${r.actual}`, 26),
    pad(r.reason, 22),
    pad(r.severity, 7),
    pad(r.temporalVerdict, 22),
    pad(r.sharedN, 4),
    r.correct ? '✓' : '✗',
  );
}

// ---- confusion matrix (expected × actual) ----
const cm = {};
for (const e of LANES) { cm[e] = {}; for (const a of LANES) cm[e][a] = 0; }
for (const r of rows) cm[r.expected][r.actual]++;
console.log('\n=== CONFUSION MATRIX (rows = expected, cols = actual) ===');
console.log(pad('exp\\act', 14), LANES.map((l) => pad(l, 13)).join(''));
for (const e of LANES) {
  console.log(pad(e, 14), LANES.map((a) => pad(cm[e][a], 13)).join(''));
}

// ---- per-class + headline ----
const byClass = {};
for (const e of LANES) {
  const tot = rows.filter((r) => r.expected === e);
  const ok = tot.filter((r) => r.correct);
  byClass[e] = { total: tot.length, correct: ok.length, pct: tot.length ? +(100 * ok.length / tot.length).toFixed(1) : null };
}
const expSuppress = rows.filter((r) => r.expected === 'suppress');
const falsePos = expSuppress.filter((r) => r.actual === 'queue'); // a non-conflict wrongly surfaced
const overall = rows.filter((r) => r.correct).length;

console.log('\n=== PER-CLASS ROUTING ACCURACY ===');
for (const e of LANES) {
  if (byClass[e].total) console.log(`  ${pad(e, 14)} ${byClass[e].correct}/${byClass[e].total}  (${byClass[e].pct}%)`);
}
console.log('\n=== HEADLINE ===');
console.log(`  overall routing accuracy : ${overall}/${rows.length} (${(100 * overall / rows.length).toFixed(1)}%)`);
console.log(`  live-conflict recall     : ${byClass.queue.correct}/${byClass.queue.total} queued (${byClass.queue.pct}%)`);
console.log(`  supersession routing     : ${byClass.supersession.correct}/${byClass.supersession.total} (${byClass.supersession.pct}%)`);
console.log(`  negation routing         : ${byClass.negation.correct}/${byClass.negation.total} (${byClass.negation.pct}%)`);
console.log(`  false-positive suppress. : ${byClass.suppress.correct}/${byClass.suppress.total} (${byClass.suppress.pct}%)  — wrongly surfaced: ${falsePos.length}`);

// ---- misses, for the report ----
const misses = rows.filter((r) => !r.correct);
console.log('\n=== MISSES (expected ≠ actual) ===');
for (const r of misses) {
  console.log(`  [${r.id}] ${r.category}: expected ${r.expected}, got ${r.actual} (${r.reason}, sev=${r.severity}, sharedN=${r.sharedN})`);
  console.log(`        A: ${r.snippetA}`);
  console.log(`        B: ${r.snippetB}`);
}

writeFileSync(new URL('./eval-results.json', import.meta.url),
  JSON.stringify({ generatedFrom: 'eval-set.json', n: rows.length, overall, byClass, falsePositives: falsePos.length, confusion: cm, rows }, null, 2));
console.log('\n[eval] wrote eval-results.json');

if (misses.length > 0) {
  console.error(`\n[eval] FAILED — ${misses.length} routing miss(es)`);
  process.exit(1);
}
console.log('\n[eval] PASSED');
