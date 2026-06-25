/**
 * Adversarial precision probe (NOT the gate). Same-subject / different-ATTRIBUTE
 * numeric pairs that must NOT be flagged as conflicts — these stress the
 * numeric-conflict heuristic (subject similarity + differing numbers), which could
 * over-fire when the differing number belongs to a different attribute.
 *   node tests/contradiction-eval/probe-precision.mjs
 */
import { evaluateContradictionTriage } from '../../dist/contradiction-utils.js';
import { extractEntities } from '../../node_modules/@nehloo/graphnosis/dist/core/extraction/entity-extractor.js';

const shared = (a, b) => { const eb = new Set(extractEntities(b).map((e) => e.toLowerCase())); return extractEntities(a).filter((e) => eb.has(e.toLowerCase())); };
const lane = (r) => (r.queue ? 'QUEUE' : r.reason);

// All of these should SUPPRESS (different attribute of the same subject, or a non-conflict).
const PROBE = [
  ['Acme Corporation has 50 engineers.', 'Acme Corporation has 200 customers.'],
  ['The Helios Mission has a budget of 5 million.', 'The Helios Mission has a team of 12 people.'],
  ['Project Atlas shipped after 8 months.', 'Project Atlas has 3 active contributors.'],
  ['My commute is 30 minutes by train.', 'My commute is 5 miles each way.'],
  ['I have read 12 books this year.', 'I have written 3 short stories this year.'],
  ['Sarah Chen manages 4 direct reports.', 'Sarah Chen has 15 years of experience.'],
];

let falsePos = 0;
for (const [a, b] of PROBE) {
  const r = evaluateContradictionTriage({ snippetA: a, snippetB: b, sharedEntities: shared(a, b) });
  const l = lane(r);
  if (l === 'QUEUE') falsePos++;
  console.log(`${l === 'QUEUE' ? '✗ FALSE-POSITIVE' : '✓ suppressed     '} [${l}]  "${a}"  vs  "${b}"`);
}
console.log(`\nadversarial false positives: ${falsePos}/${PROBE.length}`);
