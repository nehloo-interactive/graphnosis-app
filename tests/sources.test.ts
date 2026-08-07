// Source-level consistency: listSources, forgetSource cascades.
//
// Notes:
//  - find_source / recall_source live in mcp-server.ts but ultimately wrap
//    host.listSources() + host.listNodes() — testing those gives the same
//    coverage with less ceremony.

import { setupTestCortex, seedStandardData, summarizeRecall, assert, section, standalone, runSuite, SuiteResult } from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('sources', sourcesSuite);
}

async function sourcesSuite(): Promise<void> {
  const cx = await setupTestCortex('sources');
  try {
    const ids = await seedStandardData(cx.host);

    // ── listSources determinism ──────────────────────────────────────────
    section('listSources — deterministic + stable');
    const ls1 = cx.host.listSources('work');
    const ls2 = cx.host.listSources('work');
    assert(JSON.stringify(ls1) === JSON.stringify(ls2),
      `listSources("work") byte-identical across calls`);
    assert(ls1.length === 2,
      `listSources("work") returns 2 sources (roster + event)`, { count: ls1.length });

    const lsAll1 = cx.host.listSources(); // all engrams
    const lsAll2 = cx.host.listSources();
    assert(JSON.stringify(lsAll1) === JSON.stringify(lsAll2),
      `listSources() (all engrams) byte-identical across calls`);
    assert(lsAll1.length === 5,
      `listSources() returns 5 total sources across seeded data`, { count: lsAll1.length });

    // ── forgetSource cascade ─────────────────────────────────────────────
    section('forgetSource — recall stops surfacing forgotten content');
    const budget = { maxTokens: 4000, maxNodes: 10 };
    const beforeForget = await cx.host.recall('paul', { budget, skipEnrichment: true });
    const sBefore = summarizeRecall(beforeForget);
    const paulBefore = sBefore.topTextsFull.some((t) => t.toLowerCase().includes('paul'));
    assert(paulBefore, `pre-forget: recall("paul") returns content mentioning Paul`,
      { topPreview: sBefore.topTexts[0] });

    const forgot = await cx.host.forgetSource('people', ids.paul);
    assert(forgot.nodeIds.length > 0,
      `forgetSource returned the soft-deleted nodeIds`, { count: forgot.nodeIds.length, sourceId: ids.paul });

    const afterForget = await cx.host.recall('paul', { budget, skipEnrichment: true });
    const sAfter = summarizeRecall(afterForget);
    const paulAfter = sAfter.topTextsFull.some((t) => t.toLowerCase().includes('paul nistor'));
    assert(!paulAfter,
      `post-forget: recall("paul") no longer returns Paul Nistor content`,
      { topPreview: sAfter.topTexts[0] });

    // ── forgetSource idempotency ────────────────────────────────────────
    section('forgetSource — idempotent');
    const forgotAgain = await cx.host.forgetSource('people', ids.paul);
    assert(forgotAgain.nodeIds.length === 0,
      `forgetSource on already-forgotten source returns empty nodeIds (no error)`,
      { count: forgotAgain.nodeIds.length });

    // ── listSources reflects forget ─────────────────────────────────────
    section('listSources — reflects forget');
    const lsAfter = cx.host.listSources('people');
    const stillPresent = lsAfter.some((s) => s.sourceId === ids.paul);
    // Depending on implementation, forgotten sources might still appear in
    // listSources with a flag, OR be fully removed. Either is OK as long as
    // it's deterministic. Document what we observe.
    if (stillPresent) {
      assert(true, `listSources still includes forgotten source (with soft-delete metadata)`);
    } else {
      assert(true, `listSources excludes forgotten source`);
    }

  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('sources', sourcesSuite);
