// Settings combinations: each combo must yield (a) deterministic recall,
// (b) anchored entity still wins. LLM is OFF for the whole suite — the LLM
// path is covered separately in llm.test.ts.

import { setupTestCortex, seedStandardData, summarizeRecall, assert, section, standalone, runSuite, SuiteResult } from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('settings-matrix', settingsSuite);
}

async function settingsSuite(): Promise<void> {
  const cx = await setupTestCortex('settings');
  try {
    await seedStandardData(cx.host);
    const budget = { maxTokens: 4000, maxNodes: 10 };

    // ── skipEnrichment=true vs default (LLM off so both should match) ────
    section('skipEnrichment behavior — LLM-off baseline');
    const rDefault = await cx.host.recall('tudor', { budget });
    const rSkip    = await cx.host.recall('tudor', { budget, skipEnrichment: true });
    assert(rDefault.prompt === rSkip.prompt,
      `with LLM off, skipEnrichment:true and default give identical result`);

    // ── onlyGraphIds variants ─────────────────────────────────────────────
    section('Scoping — onlyGraphIds combinations');
    const combos: Array<{ label: string; ids: string[] }> = [
      { label: 'work only',      ids: ['work'] },
      { label: 'docs only',      ids: ['docs'] },
      { label: 'people only',    ids: ['people'] },
      { label: 'work+people',    ids: ['work', 'people'] },
      { label: 'work+docs',      ids: ['work', 'docs'] },
      { label: 'all three',      ids: ['work', 'people', 'docs'] },
    ];
    for (const combo of combos) {
      const r1 = await cx.host.recall('tudor', { budget, skipEnrichment: true, onlyGraphIds: combo.ids });
      const r2 = await cx.host.recall('tudor', { budget, skipEnrichment: true, onlyGraphIds: combo.ids });
      assert(r1.prompt === r2.prompt,
        `recall("tudor", onlyGraphIds=${JSON.stringify(combo.ids)}) deterministic`);
      // If 'work' is in scope, Tudor MUST appear at top
      if (combo.ids.includes('work')) {
        const s = summarizeRecall(r1);
        assert(!!s.topTextsFull[0]?.toLowerCase().includes('tudor'),
          `[${combo.label}] anchored Tudor node surfaces at top`,
          { topPreview: s.topTexts[0] });
      }
    }

    // ── Budget variants ───────────────────────────────────────────────────
    section('Budget variants — every (maxNodes, maxTokens) combo deterministic');
    const budgetCombos = [
      { maxTokens: 500,  maxNodes: 1 },
      { maxTokens: 1000, maxNodes: 3 },
      { maxTokens: 2000, maxNodes: 5 },
      { maxTokens: 4000, maxNodes: 10 },
      { maxTokens: 8000, maxNodes: 25 },
    ];
    for (const b of budgetCombos) {
      const r1 = await cx.host.recall('tudor', { budget: b, skipEnrichment: true });
      const r2 = await cx.host.recall('tudor', { budget: b, skipEnrichment: true });
      assert(r1.prompt === r2.prompt,
        `recall("tudor", maxTokens=${b.maxTokens}, maxNodes=${b.maxNodes}) deterministic`);
    }

    // ── exceptGraphIds variants ──────────────────────────────────────────
    section('Scoping — exceptGraphIds combinations');
    const excludeCombos: Array<{ label: string; ids: string[] }> = [
      { label: 'exclude docs',          ids: ['docs'] },
      { label: 'exclude people',        ids: ['people'] },
      { label: 'exclude docs+people',   ids: ['docs', 'people'] },
    ];
    for (const combo of excludeCombos) {
      const r1 = await cx.host.recall('tudor', { budget, skipEnrichment: true, exceptGraphIds: combo.ids });
      const r2 = await cx.host.recall('tudor', { budget, skipEnrichment: true, exceptGraphIds: combo.ids });
      assert(r1.prompt === r2.prompt,
        `recall("tudor", exceptGraphIds=${JSON.stringify(combo.ids)}) deterministic`);
      const s = summarizeRecall(r1);
      for (const excluded of combo.ids) {
        assert(!s.graphs.includes(excluded),
          `[${combo.label}] result excludes ${excluded}`,
          { graphs: s.graphs });
      }
    }

  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('settings-matrix', settingsSuite);
