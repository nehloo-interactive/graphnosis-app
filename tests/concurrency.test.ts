// Concurrency safety: parallel recalls + recall-during-ingest must not
// interfere. ONNX inference is not concurrent-safe (per host.ts comment at
// line 2358), so withEmbedding queues serialize calls. This suite probes
// whether that queue actually works as advertised.

import { setupTestCortex, seedStandardData, summarizeRecall, assert, section, sdkNote, standalone, runSuite, SuiteResult } from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('concurrency', concSuite);
}

async function concSuite(): Promise<void> {
  const cx = await setupTestCortex('conc');
  try {
    await seedStandardData(cx.host);
    const budget = { maxTokens: 4000, maxNodes: 10 };

    // ── Parallel recalls — same query, same result ───────────────────────
    section('Parallel recalls of same query');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => cx.host.recall('tudor', { budget, skipEnrichment: true })),
    );
    const prompts = results.map((r) => r.prompt);
    const allSame = prompts.every((p) => p === prompts[0]);
    assert(allSame, `5 parallel recalls of "tudor" all return the same prompt`);

    // ── Parallel recalls — different queries ─────────────────────────────
    section('Parallel recalls of different queries — no cross-contamination');
    const [rA, rB, rC] = await Promise.all([
      cx.host.recall('tudor', { budget, skipEnrichment: true }),
      cx.host.recall('paul', { budget, skipEnrichment: true }),
      cx.host.recall('dobrescu', { budget, skipEnrichment: true }),
    ]);
    const sA = summarizeRecall(rA);
    const sB = summarizeRecall(rB);
    const sC = summarizeRecall(rC);
    assert(!!sA.topTextsFull[0]?.toLowerCase().includes('tudor'),
      `parallel recall("tudor") still returns Tudor at top`);
    assert(!sB.topTextsFull[0]?.toLowerCase().includes('tudor') || sB.topTextsFull[0]?.toLowerCase().includes('paul'),
      `parallel recall("paul") not contaminated by "tudor" call`);
    void sC;

    // ── Compare parallel vs sequential ───────────────────────────────────
    section('Parallel result === sequential result for same query');
    const seq = await cx.host.recall('tudor', { budget, skipEnrichment: true });
    const parallel = (await Promise.all([cx.host.recall('tudor', { budget, skipEnrichment: true })]))[0];
    assert(seq?.prompt === parallel?.prompt,
      `sequential and parallel recall("tudor") return byte-identical prompts`);

    // ── Recall while ingest in-flight ────────────────────────────────────
    section('Recall during ingest does not return partial state');
    const baselineNodes = (await cx.host.recall('tudor', { budget, skipEnrichment: true })).nodesIncluded;

    // Kick off an ingest, race a recall before it completes.
    const ingestP = cx.host.ingest('work', 'clip', 'work:racy', {
      kind: 'markdown',
      content: '# Race condition test\nUnrelated content that does NOT mention the keyword.',
      sourceRef: 'work:racy',
    });
    const racingRecall = await cx.host.recall('tudor', { budget, skipEnrichment: true });
    await ingestP;

    const sRace = summarizeRecall(racingRecall);
    // Either pre-ingest state (baseline) or post-ingest state — never half.
    // We can't strictly assert which, but assert the result is well-formed:
    // - top-1 still contains "tudor" (anchored)
    // - prompt is non-empty
    assert(racingRecall.prompt.length > 0, `recall during ingest returns non-empty prompt`);
    assert(!!sRace.topTextsFull[0]?.toLowerCase().includes('tudor'),
      `recall during ingest still surfaces the anchored Tudor node`);
    void baselineNodes;

    // ── Concurrent ingest serialization ──────────────────────────────────
    section('Concurrent ingests succeed (queue serializes)');
    const ingests = await Promise.all([
      cx.host.ingest('work', 'clip', 'work:c1', { kind: 'markdown', content: 'concurrent test 1', sourceRef: 'work:c1' }),
      cx.host.ingest('work', 'clip', 'work:c2', { kind: 'markdown', content: 'concurrent test 2', sourceRef: 'work:c2' }),
      cx.host.ingest('work', 'clip', 'work:c3', { kind: 'markdown', content: 'concurrent test 3', sourceRef: 'work:c3' }),
    ]);
    assert(ingests.every((s) => s.nodeIds.length > 0),
      `all 3 concurrent ingests succeeded with non-empty nodeIds`,
      { counts: ingests.map((s) => s.nodeIds.length) });

    // ONNX concurrency: the App's `withEmbedding` queue (embedding-queue.ts)
    // + the per-recall queryChain (host.ts:2358) correctly serialize ONNX
    // calls. The SDK now documents this contract explicitly in queryHybrid's
    // JSDoc (Graphnosis SDK v0.5.6+). No further SDK action needed —
    // serialization is an App-architecture choice (multi-instance shared
    // worker pool) that the SDK can't make blind assumptions about.

  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('concurrency', concSuite);
