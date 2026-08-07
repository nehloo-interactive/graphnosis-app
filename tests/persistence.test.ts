// Persistence consistency: close + reopen → byte-identical recall.
// This is the proof that Graphnosis's encrypted on-disk state survives a
// process restart with no loss of recall determinism.

import { setupTestCortex, seedStandardData, summarizeRecall, assert, section, sdkNote, standalone, runSuite, SuiteResult } from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('persistence', persistSuite);
}

async function persistSuite(): Promise<void> {
  const cx = await setupTestCortex('persist');
  try {
    await seedStandardData(cx.host);
    const budget = { maxTokens: 4000, maxNodes: 10 };

    // ── Snapshot recall result ───────────────────────────────────────────
    section('Pre-close recall');
    const before = await cx.host.recall('tudor', { budget, skipEnrichment: true });
    const sBefore = summarizeRecall(before);
    assert(!!sBefore.topTextsFull[0]?.toLowerCase().includes('tudor'),
      `pre-close: recall("tudor") returns Tudor node`);

    // ── Re-open with same passphrase + different deviceId ────────────────
    section('Re-open cortex with new host instance');
    const host2 = await cx.reopen('persist-reopened');
    assert(host2 !== cx.host, `reopen returns a different host instance`);
    // After reopen, graphs aren't auto-loaded — they're loaded on demand.
    // For tests we load them explicitly. The real app does this via
    // loadAllGraphsFromDisk() at boot in main.ts.
    for (const g of ['work', 'people', 'docs']) {
      try { await host2.loadGraph(g); } catch { /* graph file may not exist */ }
    }
    // CRITICAL: wait for the background embedding build before recall.
    // host.loadGraph kicks off buildEmbeddings asynchronously; without this
    // wait, recall would run with TF-IDF + anchoring only and return a
    // different (smaller) result than the warm-state pre-close recall.
    // This wait is the App-side fix for the persistence-determinism issue
    // captured in SDK-OBSERVATIONS.md #2.
    for (const g of ['work', 'people', 'docs']) {
      try { await host2.waitForEmbeddings(g); } catch { /* fine */ }
    }

    // ── State is preserved ───────────────────────────────────────────────
    section('Graph list survives reopen');
    const graphs1 = cx.host.listGraphs().sort();
    const graphs2 = host2.listGraphs().sort();
    assert(JSON.stringify(graphs1) === JSON.stringify(graphs2),
      `listGraphs identical pre-close vs post-reopen`,
      { before: graphs1, after: graphs2 });

    // ── Recall returns byte-identical result ─────────────────────────────
    section('Recall byte-identical after reopen');
    const after = await host2.recall('tudor', { budget, skipEnrichment: true });
    const sAfter = summarizeRecall(after);
    const promptMatch = before.prompt === after.prompt;
    const idsMatch = JSON.stringify(sBefore.topNodeIds) === JSON.stringify(sAfter.topNodeIds);
    // STRICT: prompt and IDs must be byte-identical. The TF-IDF score wobble
    // that motivated the old sdkNote was fixed in the SDK at v0.5.6:
    // rebuildIndex's section-exclusion stale bug was making post-reopen idf
    // differ from incremental-build idf. Now both build paths use the same
    // policy (exclude only `document` type) and scores are byte-identical.
    assert(promptMatch,
      `recall("tudor") prompt byte-identical pre-close vs post-reopen`,
      { promptLen: { before: before.prompt.length, after: after.prompt.length } });
    assert(idsMatch, `top node IDs identical pre-close vs post-reopen`,
      { before: sBefore.topNodeIds, after: sAfter.topNodeIds });
    void sdkNote;
    if (false) {
      // Same content set?
      const beforeSet = new Set(sBefore.topNodeIds);
      const afterSet = new Set(sAfter.topNodeIds);
      const sameSet = beforeSet.size === afterSet.size && [...beforeSet].every((id) => afterSet.has(id));
      sdkNote(
        'Recall result diverges after host reopen',
        `Same query + same cortex + same passphrase + freshly-loaded graphs produced a different recall result post-reopen. ` +
        (sameSet
          ? `Node SET is identical (${sBefore.topNodeIds.length} nodes), but ORDER differs — points to non-deterministic tie-breaking in federation or per-engram queryHybrid.`
          : `Node SET differs (before=${sBefore.topNodeIds.length}, after=${sAfter.topNodeIds.length}). Some content from the first session is being scored differently after reload — could be embedding cache, lexical index state, or score normalization.`),
        `Investigate whether re-loaded graphs have identical internal state (TF-IDF freq counts, embedding index ordering) to first-load state. If not, persist that state explicitly.`,
      );
    }

    // ── Source list survives ─────────────────────────────────────────────
    section('Sources survive reopen');
    const sources1 = cx.host.listSources('work').map((s) => s.sourceId).sort();
    const sources2 = host2.listSources('work').map((s) => s.sourceId).sort();
    assert(JSON.stringify(sources1) === JSON.stringify(sources2),
      `listSources("work") identical after reopen`);

    // ── Subsequent recalls deterministic on the new host ─────────────────
    section('Determinism on the reopened host');
    const after2 = await host2.recall('tudor', { budget, skipEnrichment: true });
    assert(after.prompt === after2.prompt,
      `consecutive recalls on reopened host are byte-identical`);

  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('persistence', persistSuite);
