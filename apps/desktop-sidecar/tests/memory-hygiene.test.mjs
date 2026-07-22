/**
 * Unit tests for the memory-hygiene guards (memory-hygiene.ts) and their
 * composition with the shared contradiction triage. Guards the 2026-07-21
 * regressions observed live via MCP:
 *   - check_duplicate scored two label-sized nodes ("Graphnosis",
 *     "1.3 What Graphnosis Is") at 1.00 against a probe that never contained
 *     the word — degenerate candidates must be ineligible as duplicates
 *   - one remember echoed 8 raw append-time "contradictions", every one
 *     justified only by the engram's ubiquitous brand entity — the ingest
 *     path must route through evaluateContradictionTriage with the
 *     corpus-common entity predicate
 * Run after build: node --test tests/memory-hygiene.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDegenerateDuplicateCandidate,
  buildEntityDocumentFrequency,
  buildCommonEntityPredicate,
} from '../dist/memory-hygiene.js';
import { evaluateContradictionTriage } from '../dist/contradiction-utils.js';

const LONG_PROBE =
  'Article #7 of the X series, "A Framework for Grounded Engineering: What Loops and Graphs ' +
  'Still Forget", was published 2026-07-21. Five checkable requirements a conforming agent ' +
  'system MUST meet, independent of control flow: provenance, indelibility, determinism, ' +
  'capped authority, co-location. A record built this way is an agempus; the naming stack is ' +
  'discipline > reference architecture > implementation > unit, each layer defensible alone.';

test('label-sized node is never a duplicate of a long note (live repro)', () => {
  assert.equal(isDegenerateDuplicateCandidate(LONG_PROBE, 'Graphnosis'), true);
  assert.equal(isDegenerateDuplicateCandidate(LONG_PROBE, '1.3 What Graphnosis Is'), true);
});

test('short probe with commensurate candidate is eligible', () => {
  assert.equal(
    isDegenerateDuplicateCandidate('Renew the TEDx venue contract', 'Renew the TEDx venue agreement'),
    false,
  );
});

test('length-ratio guard scales with the probe but caps at 600 chars', () => {
  const hugeProbe = LONG_PROBE + ' ' + LONG_PROBE; // ~890 chars, above the 600 cap
  const node100 = 'x'.repeat(100);
  const node130 = 'x'.repeat(130);
  assert.equal(isDegenerateDuplicateCandidate(hugeProbe, node100), true); // 100 < 0.2 * 600
  assert.equal(isDegenerateDuplicateCandidate(hugeProbe, node130), false); // 130 >= 0.2 * 600
});

test('entity document frequency counts each node once, case-insensitively', () => {
  const df = buildEntityDocumentFrequency([
    { entities: ['Graphnosis', 'graphnosis', 'Zenodo'] },
    { entities: ['GRAPHNOSIS'] },
    { entities: ['Zenodo'] },
    { entities: [] },
    {},
  ]);
  assert.equal(df.get('graphnosis'), 2);
  assert.equal(df.get('zenodo'), 2);
  assert.equal(df.get('missing'), undefined);
});

test('common-entity predicate no-ops below the corpus-size floor', () => {
  const nodes = Array.from({ length: 10 }, () => ({ entities: ['Graphnosis'] }));
  const isCommon = buildCommonEntityPredicate(nodes);
  assert.equal(isCommon('Graphnosis'), false);
});

test('common-entity predicate flags hub entities in a large corpus', () => {
  const nodes = [
    ...Array.from({ length: 30 }, () => ({ entities: ['Graphnosis', 'note'] })),
    ...Array.from({ length: 20 }, () => ({ entities: ['Zenodo'] })),
  ];
  const isCommon = buildCommonEntityPredicate(nodes);
  assert.equal(isCommon('graphnosis'), true); // 30/50 > 0.12
  assert.equal(isCommon('Zenodo'), true); // 20/50 > 0.12
  assert.equal(isCommon('agempus'), false);
});

test('ingest triage suppresses the live-repro shape: single hub entity, unrelated notes', () => {
  const nodes = [
    ...Array.from({ length: 45 }, (_, i) => ({ entities: ['Graphnosis', `topic-${i}`] })),
    ...Array.from({ length: 5 }, () => ({ entities: ['Zenodo'] })),
  ];
  const isCommonEntity = buildCommonEntityPredicate(nodes);
  const verdict = evaluateContradictionTriage({
    snippetA: 'Bug investigation: check_duplicate reported score 1.00 on two unrelated label nodes.',
    snippetB: '1.3 What Graphnosis Is — the local-first memory layer plus the agent runtime.',
    sharedEntities: ['Graphnosis', 'graphnosis'],
    ingest: true,
    isCommonEntity,
  });
  assert.equal(verdict.queue, false);
  assert.deepEqual(verdict.meaningfulShared, []);
});

test('ingest triage still queues a genuine conflict with meaningful anchors', () => {
  const isCommonEntity = () => false;
  const verdict = evaluateContradictionTriage({
    snippetA: 'The TEDx venue contract was signed with Aula Magna for November 14, cost 4500 EUR.',
    snippetB: 'The TEDx venue contract was NOT signed with Aula Magna — the November 14 booking fell through.',
    sharedEntities: ['TEDx', 'Aula Magna', 'November 14'],
    ingest: true,
    isCommonEntity,
  });
  assert.equal(verdict.queue, true);
});
