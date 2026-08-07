// Mutation/state-transition predictability:
//   - After ingest: recall surfaces new content.
//   - After forgetSource: recall stops surfacing it.
//   - Idempotent forget.
//   - Determinism is restored after each mutation (same recall = same result).

import { setupTestCortex, seedStandardData, summarizeRecall, assert, section, sdkNote, standalone, runSuite, SuiteResult } from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('mutations', mutSuite);
}

async function mutSuite(): Promise<void> {
  const cx = await setupTestCortex('mutations');
  try {
    const ids = await seedStandardData(cx.host);
    const budget = { maxTokens: 4000, maxNodes: 10 };

    // ── INGEST → recall surfaces new content ─────────────────────────────
    section('Ingest → recall finds new node');
    const newSrc = await cx.host.ingest('work', 'clip', 'work:new', {
      kind: 'markdown',
      content: '# New topic\nThe MAGIC_SENTINEL_TOKEN_42 appears in this brand-new note.\nAlso mentions Ioana Radu in passing.',
      sourceRef: 'work:new',
    });
    assert(newSrc.nodeIds.length > 0, `ingest returns nodeIds`);

    const r = await cx.host.recall('MAGIC_SENTINEL_TOKEN_42', { budget, skipEnrichment: true });
    const s = summarizeRecall(r);
    assert(s.topTextsFull.some((t) => t.includes('MAGIC_SENTINEL_TOKEN_42')),
      `recall finds the brand-new sentinel token`,
      { topPreview: s.topTexts[0] });

    // ── Determinism preserved AFTER ingest ───────────────────────────────
    section('Determinism survives ingest');
    const r1 = await cx.host.recall('Tudor', { budget, skipEnrichment: true });
    const r2 = await cx.host.recall('Tudor', { budget, skipEnrichment: true });
    assert(r1.prompt === r2.prompt, `recall("Tudor") prompt byte-identical post-ingest`);

    // ── FORGET → recall excludes ──────────────────────────────────────────
    section('forgetSource → recall stops surfacing content');
    const beforePaul = await cx.host.recall('Paul Nistor', { budget, skipEnrichment: true });
    const sBefore = summarizeRecall(beforePaul);
    assert(sBefore.topTextsFull.some((t) => t.toLowerCase().includes('paul nistor')),
      `pre-forget: Paul Nistor appears in recall`);

    const forgot = await cx.host.forgetSource('people', ids.paul);
    assert(forgot.nodeIds.length > 0, `forgetSource soft-deleted nodes`,
      { count: forgot.nodeIds.length });

    const afterPaul = await cx.host.recall('Paul Nistor', { budget, skipEnrichment: true });
    const sAfter = summarizeRecall(afterPaul);
    assert(!sAfter.topTextsFull.some((t) => t.toLowerCase().includes('paul nistor')),
      `post-forget: Paul Nistor does NOT appear in recall`,
      { topPreview: sAfter.topTexts[0] });

    // ── Idempotent forget ─────────────────────────────────────────────────
    section('Idempotent forget');
    const forgotAgain = await cx.host.forgetSource('people', ids.paul);
    assert(forgotAgain.nodeIds.length === 0,
      `Second forgetSource on same id returns empty nodeIds (no error)`);

    // ── Determinism preserved AFTER forget ───────────────────────────────
    section('Determinism survives forget');
    const r3 = await cx.host.recall('Tudor', { budget, skipEnrichment: true });
    const r4 = await cx.host.recall('Tudor', { budget, skipEnrichment: true });
    assert(r3.prompt === r4.prompt, `recall("Tudor") prompt byte-identical post-forget`);

    // ── Re-ingest same sourceRef → no-op, returns existing source ────────
    section('Re-ingest of identical sourceRef');
    const firstIngest = await cx.host.ingest('work', 'clip', 'work:reingest', {
      kind: 'markdown',
      content: '# Re-ingest test\nThis content will be re-ingested with the same sourceRef.',
      sourceRef: 'work:reingest',
    });
    assert(firstIngest.nodeIds.length > 0, `first ingest created nodes`);

    const reIngest = await cx.host.ingest('work', 'clip', 'work:reingest', {
      kind: 'markdown',
      content: '# Re-ingest test\nThis content will be re-ingested with the same sourceRef.',
      sourceRef: 'work:reingest',
    });
    assert(reIngest.sourceId === firstIngest.sourceId,
      `re-ingest returns the SAME sourceId (host short-circuits duplicate sourceRef)`);
    assert(reIngest.nodeIds.length === firstIngest.nodeIds.length,
      `re-ingest returns the SAME nodeIds — no orphan metadata chunks`,
      { first: firstIngest.nodeIds, reIngest: reIngest.nodeIds });
    void sdkNote; // silence unused import if no notes fire in this run

  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('mutations', mutSuite);
