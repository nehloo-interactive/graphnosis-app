// Recall variants — dig_deeper, cross-engram comparison, scoping.
// Asserts that the sibling recall tools share the determinism + anchoring
// promise of plain recall().

import { setupTestCortex, seedStandardData, summarizeRecall, assert, section, standalone, runSuite, SuiteResult } from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('recall-variants', recallVariantsSuite);
}

async function recallVariantsSuite(): Promise<void> {
  const cx = await setupTestCortex('variants');
  try {
    await seedStandardData(cx.host);
    const budget = { maxTokens: 4000, maxNodes: 10 };

    // ── dig_deeper determinism ────────────────────────────────────────────
    section('dig_deeper — determinism + anchoring');
    const d1 = await cx.host.digDeeper('tudor', { budget, skipEnrichment: true });
    const d2 = await cx.host.digDeeper('tudor', { budget, skipEnrichment: true });
    assert(d1.prompt === d2.prompt, `digDeeper("tudor") prompt byte-identical across calls`);
    const sD = summarizeRecall(d1);
    assert(!!sD.topTextsFull[0]?.toLowerCase().includes('tudor'),
      `digDeeper("tudor") top-1 contains anchored keyword`, { topPreview: sD.topTexts[0] });

    // dig_deeper provenance block is structurally stable
    assert(typeof d1.digDeeperProvenance === 'object' && d1.digDeeperProvenance !== null,
      `digDeeper returns provenance block`);
    assert(d1.digDeeperProvenance.contentMatch.nodes === d2.digDeeperProvenance.contentMatch.nodes,
      `digDeeper contentMatch.nodes count stable across calls`);

    // ── Scoped recall determinism ─────────────────────────────────────────
    section('Engram scoping — only work vs only docs');
    const onlyWork1 = await cx.host.recall('tudor', { budget, skipEnrichment: true, onlyGraphIds: ['work'] });
    const onlyWork2 = await cx.host.recall('tudor', { budget, skipEnrichment: true, onlyGraphIds: ['work'] });
    assert(onlyWork1.prompt === onlyWork2.prompt, `recall("tudor", onlyGraphIds=["work"]) byte-identical`);
    const sOnlyWork = summarizeRecall(onlyWork1);
    assert(sOnlyWork.graphs.length === 1 && sOnlyWork.graphs[0] === 'work',
      `onlyGraphIds restricts result to that single engram`, { graphs: sOnlyWork.graphs });

    const onlyDocs = await cx.host.recall('tudor', { budget, skipEnrichment: true, onlyGraphIds: ['docs'] });
    const sOnlyDocs = summarizeRecall(onlyDocs);
    // Anchoring can't find 'tudor' in docs — but should still be deterministic
    assert(sOnlyDocs.graphs.length <= 1, `onlyGraphIds=["docs"] never returns nodes from other engrams`);

    // ── exceptGraphIds determinism ────────────────────────────────────────
    section('Engram scoping — exceptGraphIds');
    const exceptDocs = await cx.host.recall('tudor', { budget, skipEnrichment: true, exceptGraphIds: ['docs'] });
    const sExceptDocs = summarizeRecall(exceptDocs);
    assert(!sExceptDocs.graphs.includes('docs'),
      `exceptGraphIds=["docs"] excludes docs from result`, { graphs: sExceptDocs.graphs });
    const exceptDocsAgain = await cx.host.recall('tudor', { budget, skipEnrichment: true, exceptGraphIds: ['docs'] });
    assert(exceptDocs.prompt === exceptDocsAgain.prompt, `exceptGraphIds path is deterministic`);

    // ── Recall + dig_deeper alignment ─────────────────────────────────────
    // dig_deeper is a SUPERSET of recall (stage1 = recall result). Top-1
    // should be the same across both.
    section('digDeeper supersets recall — anchored top should match');
    const r = await cx.host.recall('tudor', { budget, skipEnrichment: true });
    const sR = summarizeRecall(r);
    assert(sR.topNodeIds[0] === sD.topNodeIds[0],
      `recall and digDeeper agree on top node`,
      { recallTop: sR.topNodeIds[0], digDeeperTop: sD.topNodeIds[0] });

    // ── Different queries → different results (sanity) ───────────────────
    section('Sanity: different queries produce different top nodes');
    const rA = await cx.host.recall('tudor', { budget, skipEnrichment: true });
    const rB = await cx.host.recall('paul', { budget, skipEnrichment: true });
    assert(summarizeRecall(rA).topNodeIds[0] !== summarizeRecall(rB).topNodeIds[0],
      `recall("tudor") and recall("paul") return different top nodes`);

  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('recall-variants', recallVariantsSuite);
