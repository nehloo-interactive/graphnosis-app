/**
 * §12.6 external-validity run — frozen triage over the HELD-OUT set (held-out-set.json),
 * whose instances are disjoint from the 71-pair eval-set and were built after the rules
 * were frozen. Same real triage + production extractor; deterministic, no LLM.
 *   node tests/contradiction-eval/run-heldout.mjs
 */
import { readFileSync } from 'node:fs';
import { evaluateContradictionTriage } from '../../dist/contradiction-utils.js';
import { extractEntities } from '../../node_modules/@nehloo/graphnosis/dist/core/extraction/entity-extractor.js';

const SET = JSON.parse(readFileSync(new URL('./held-out-set.json', import.meta.url), 'utf8')).items;
const DAY = 86_400_000, now = Date.now();
const LANES = ['queue', 'supersession', 'negation', 'suppress'];
const shared = (a, b) => { const eb = new Set(extractEntities(b).map((e) => e.toLowerCase())); return extractEntities(a).filter((e) => eb.has(e.toLowerCase())); };
const laneOf = (r) => (r.queue ? 'queue' : r.reason === 'temporal-supersession' ? 'supersession' : r.reason === 'negation-artifact' ? 'negation' : 'suppress');

const rows = SET.map((it) => {
  const sh = shared(it.snippetA, it.snippetB);
  const r = evaluateContradictionTriage({ snippetA: it.snippetA, snippetB: it.snippetB, sharedEntities: sh, ingest: it.ingest ?? false, validUntilA: it.expiredA ? now - DAY : undefined, validUntilB: it.expiredB ? now - DAY : undefined });
  const act = laneOf(r);
  return { id: it.id, cat: it.category, exp: it.expectedLane, act, ok: act === it.expectedLane, reason: r.reason, sev: r.severity, shN: sh.length, A: it.snippetA, B: it.snippetB };
});
const overall = rows.filter((r) => r.ok).length;
console.log(`HELD-OUT external validity: ${overall}/${rows.length} (${(100 * overall / rows.length).toFixed(1)}%) routed correctly\n`);
for (const e of LANES) { const t = rows.filter((r) => r.exp === e); if (t.length) console.log(`  ${e.padEnd(13)} ${t.filter((r) => r.ok).length}/${t.length}`); }
const fp = rows.filter((r) => r.exp === 'suppress' && r.act === 'queue');
console.log(`  false positives (non-conflict surfaced): ${fp.length}`);
const miss = rows.filter((r) => !r.ok);
console.log(`\nMISSES (${miss.length}):`);
for (const r of miss) console.log(`  [${r.id}] ${r.cat}: expected ${r.exp}, got ${r.act} (${r.reason}, sev=${r.sev}, sharedN=${r.shN})\n        A: ${r.A}\n        B: ${r.B}`);
