// Recall consistency — the floor invariant of Graphnosis.
//
// Hypotheses:
//   H1. Identical query + identical state → byte-identical prompt; warm-call
//       raw scores byte-identical; cold→warm tolerance ≤1e-4 (ONNX warmup).
//   H2. Anchored entity surfaces at position #1 at every budget.
//   H3. Case-insensitive equivalence: "tudor" === "Tudor" at top.
//   H4. Diacritic folding: "Mares" matches "Mareș".
//   H5. Pattern #7 — lowercase 1-3-word queries get entity-extracted.
//   H6. Cross-engram noise (docs/people) doesn't displace the anchor.
//   H7. Whitespace + punctuation variants → same top node.
//   H8. Slider-equivalent: increasing maxNodes never drops top-1.
//   H9. Engram scoping still anchors.
//  H10. Cross-query independence (no recall pollution).

import { setupTestCortex, seedStandardData, summarizeRecall, withinEps, assert, section, sdkNote, standalone, runSuite, SuiteResult } from './_helpers.js';
import { extractQueryEntities } from '../apps/desktop-sidecar/src/host.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('recall', recallSuite);
}

async function recallSuite(): Promise<void> {
  const cx = await setupTestCortex('recall');
  try {
    await seedStandardData(cx.host);
    const budget = { maxTokens: 4000, maxNodes: 10 };

    // ── H5 unit: extractQueryEntities pattern coverage ────────────────────
    section('H5 (extractQueryEntities — pattern coverage)');

    const e1 = extractQueryEntities('tudor');
    assert(e1.includes('tudor'), `lowercase single-word "tudor" extracts (pattern #7)`, { e1 });

    const e2 = extractQueryEntities('Tudor');
    assert(e2.includes('Tudor'), `capitalized single-word "Tudor" extracts (pattern #3)`, { e2 });

    const e3 = extractQueryEntities('dobrescu');
    assert(e3.includes('dobrescu'), `lowercase "dobrescu" extracts`, { e3 });

    const e4 = extractQueryEntities('Sorina Dobrescu');
    assert(
      e4.some((e) => e.toLowerCase() === 'sorina dobrescu') || (e4.includes('Sorina') && e4.includes('Dobrescu')),
      `multi-word "Sorina Dobrescu" extracts (pattern #2 whole or #3 parts)`, { e4 },
    );

    const e5 = extractQueryEntities('mares');
    assert(e5.includes('mares'), `lowercase "mares" extracts`, { e5 });

    const e6 = extractQueryEntities('what did the user say about Tudor?');
    assert(e6.includes('Tudor'), `Tudor extracted from sentence query`, { e6 });
    assert(
      !e6.includes('what') && !e6.includes('the') && !e6.includes('user'),
      `pattern #7 skipped for >3 word queries (no false positives on stopwords)`, { e6 },
    );

    // ── H1: Determinism ───────────────────────────────────────────────────
    section('H1 (Determinism — identical inputs → identical outputs)');

    const q = 'tudor';
    const r1 = await cx.host.recall(q, { budget, skipEnrichment: true });
    const r2 = await cx.host.recall(q, { budget, skipEnrichment: true });
    const r3 = await cx.host.recall(q, { budget, skipEnrichment: true });
    const s1 = summarizeRecall(r1), s2 = summarizeRecall(r2), s3 = summarizeRecall(r3);

    assert(r1.prompt === r2.prompt, `recall("${q}") prompt is identical across calls 1 vs 2`);
    assert(r2.prompt === r3.prompt, `recall("${q}") prompt is identical across calls 2 vs 3`);
    assert(JSON.stringify(s1.topNodeIds) === JSON.stringify(s2.topNodeIds), `top node IDs identical across calls 1 vs 2`);
    assert(JSON.stringify(s2.topNodeIds) === JSON.stringify(s3.topNodeIds), `top node IDs identical across calls 2 vs 3`);
    assert(JSON.stringify(s2.topScores) === JSON.stringify(s3.topScores), `raw scores byte-identical AFTER warmup (calls 2 vs 3)`);
    const coldWarmStable = withinEps(s1.topScores, s2.topScores, 1e-4);
    assert(coldWarmStable, `raw scores stable within 1e-4 across cold→warm (calls 1 vs 2)`,
      { cold: s1.topScores, warm: s2.topScores });
    if (!coldWarmStable) {
      const deltas = s1.topScores.map((v, i) => Math.abs(v - (s2.topScores[i] ?? 0)));
      sdkNote(
        'ONNX warmup — cold→warm float divergence',
        `Cold-call scores differ from warm-call scores by max=${Math.max(...deltas).toExponential(2)}. Prompt + node IDs are byte-identical (rounding hides the wobble), but raw scores diverge.`,
        `Pre-warm the ONNX session in adapter.open(), or pin deterministic FP mode so cold inference matches warm precision.`,
      );
    }

    // ── H2 + H5: Anchored node FOUND at every budget ─────────────────────
    section('H2 (Anchored node "Tudor Mareș" surfaces for "tudor" at every budget)');

    const budgets = [
      { label: 'top-1',  budget: { maxTokens: 4000, maxNodes: 1 } },
      { label: 'top-3',  budget: { maxTokens: 4000, maxNodes: 3 } },
      { label: 'top-5',  budget: { maxTokens: 4000, maxNodes: 5 } },
      { label: 'top-10', budget: { maxTokens: 4000, maxNodes: 10 } },
      { label: 'top-20', budget: { maxTokens: 4000, maxNodes: 20 } },
      { label: 'top-50', budget: { maxTokens: 4000, maxNodes: 50 } },
    ];
    for (const b of budgets) {
      const r = await cx.host.recall('tudor', { budget: b.budget, skipEnrichment: true });
      const s = summarizeRecall(r);
      const hasTudor = s.topTextsFull.some((t) => t.toLowerCase().includes('tudor'));
      assert(hasTudor, `recall("tudor") at ${b.label} includes the Tudor Mareș node`, { topTexts: s.topTexts });
      if (hasTudor) {
        const pos = s.topTextsFull.findIndex((t) => t.toLowerCase().includes('tudor'));
        console.log(`     ${b.label}: Tudor at #${pos + 1} of ${s.topNodeIds.length}`);
      }
    }

    // H2 (Dobrescu mirror): same coverage for the other surname
    section('H2-mirror (recall("dobrescu") surfaces Sorina Dobrescu at every budget)');
    for (const b of budgets) {
      const r = await cx.host.recall('dobrescu', { budget: b.budget, skipEnrichment: true });
      const s = summarizeRecall(r);
      const hasMizu = s.topTextsFull.some((t) => t.toLowerCase().includes('dobrescu'));
      assert(hasMizu, `recall("dobrescu") at ${b.label} includes the Dobrescu node`, { topTexts: s.topTexts });
    }

    // ── H3: Case insensitivity ────────────────────────────────────────────
    section('H3 (Case-insensitive equivalence — "tudor" === "Tudor")');
    const rLower = await cx.host.recall('tudor', { budget, skipEnrichment: true });
    const rUpper = await cx.host.recall('Tudor', { budget, skipEnrichment: true });
    const sLower = summarizeRecall(rLower), sUpper = summarizeRecall(rUpper);
    assert(sLower.topNodeIds[0] === sUpper.topNodeIds[0],
      `top node ID is the same for "tudor" vs "Tudor"`,
      { lower: sLower.topNodeIds.slice(0, 3), upper: sUpper.topNodeIds.slice(0, 3) });

    // ── H4: Diacritic folding ─────────────────────────────────────────────
    section('H4 (Diacritic folding — "Mares" matches "Mareș")');
    const rAscii = await cx.host.recall('Mares', { budget, skipEnrichment: true });
    const rUnicode = await cx.host.recall('Mareș', { budget, skipEnrichment: true });
    const sAscii = summarizeRecall(rAscii), sUnicode = summarizeRecall(rUnicode);
    assert(!!sAscii.topTextsFull[0]?.toLowerCase().includes('mare'),
      `recall("Mares") returns the Mareș node`, { topText: sAscii.topTexts[0] });
    assert(!!sUnicode.topTextsFull[0]?.toLowerCase().includes('mare'),
      `recall("Mareș") returns the Mareș node`, { topText: sUnicode.topTexts[0] });
    assert(sAscii.topNodeIds[0] === sUnicode.topNodeIds[0],
      `ASCII "Mares" and Unicode "Mareș" return the same top node`);

    // Note: the SDK's default analyzer (asciiFoldAnalyzer) already folds
    // diacritics — verified by direct probe in May 2026. No SDK action needed.

    // ── H6: Cross-engram interference ─────────────────────────────────────
    section('H6 (Cross-engram noise doesn\'t displace anchor)');
    const rWide = await cx.host.recall('tudor', { budget: { maxTokens: 4000, maxNodes: 20 }, skipEnrichment: true });
    const sWide = summarizeRecall(rWide);
    const tudorPos = sWide.topTextsFull.findIndex((t) => t.toLowerCase().includes('tudor'));
    assert(tudorPos === 0, `Tudor node is at position #1 even with docs noise present`,
      { topTexts: sWide.topTexts.slice(0, 5) });

    // ── H7: Whitespace / punctuation robustness ───────────────────────────
    section('H7 (Whitespace + punctuation robustness)');
    const variants = ['tudor', ' tudor', 'tudor ', '  tudor  ', 'tudor?', 'tudor.', 'tudor!'];
    const baselineTopId = sLower.topNodeIds[0];
    for (const v of variants) {
      const r = await cx.host.recall(v, { budget, skipEnrichment: true });
      const top = summarizeRecall(r).topNodeIds[0];
      assert(top === baselineTopId, `recall(${JSON.stringify(v)}) returns same top node as recall("tudor")`,
        { expected: baselineTopId, got: top });
    }

    // ── H8: Slider-equivalent stability ──────────────────────────────────
    // The SDK now adds a deterministic tie-breaker at the federation sort
    // (secure-sync v0.1.3+): ties are broken by (graphId, nodeId) lexicographic.
    // So the SAME node must surface at #1 across every budget — not just "any
    // node containing the keyword."
    section('H8 (Slider-equivalent — same top node at every budget)');
    const anchoredTopIds = new Set<string>();
    let firstTopId: string | undefined;
    for (const maxNodes of [1, 2, 3, 5, 8, 13, 21]) {
      const r = await cx.host.recall('tudor', { budget: { maxTokens: 4000, maxNodes }, skipEnrichment: true });
      const s = summarizeRecall(r);
      const topId = s.topNodeIds[0];
      const topContainsTudor = !!s.topTextsFull[0]?.toLowerCase().includes('tudor');
      assert(topContainsTudor, `recall("tudor", maxNodes=${maxNodes}) top-1 contains the keyword`,
        { topPreview: s.topTexts[0] });
      if (firstTopId === undefined) firstTopId = topId;
      assert(topId === firstTopId, `recall("tudor", maxNodes=${maxNodes}) top-1 is the SAME node at every budget`,
        { expected: firstTopId, got: topId });
      anchoredTopIds.add(topId ?? '');
    }
    assert(anchoredTopIds.size === 1, `only ONE distinct top-1 node across all 7 budgets (tie-breaker stable)`,
      { winners: [...anchoredTopIds] });

    // ── H9: Engram scoping ───────────────────────────────────────────────
    section('H9 (Engram scoping — onlyGraphIds=["work"] still anchors)');
    const rScoped = await cx.host.recall('tudor', { budget, skipEnrichment: true, onlyGraphIds: ['work'] });
    const sScoped = summarizeRecall(rScoped);
    const tudorInScoped = sScoped.topTextsFull.findIndex((t) => t.toLowerCase().includes('tudor'));
    assert(tudorInScoped === 0, `recall("tudor", onlyGraphIds=["work"]) returns Tudor at position #1`,
      { topTexts: sScoped.topTexts });

    // ── H10: Cross-query independence ────────────────────────────────────
    section('H10 (Cross-query independence)');
    await cx.host.recall('paul', { budget, skipEnrichment: true }); // intervening query
    const rAfter = await cx.host.recall('tudor', { budget, skipEnrichment: true });
    const sAfter = summarizeRecall(rAfter);
    assert(sAfter.topNodeIds[0] === baselineTopId,
      `recall("tudor") top node unchanged by intervening recall("paul")`,
      { expected: baselineTopId, got: sAfter.topNodeIds[0] });

  } finally {
    await cx.cleanup();
  }
}

// Standalone entrypoint (when run directly via `node tests/recall.test.ts`)
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('recall', recallSuite);
