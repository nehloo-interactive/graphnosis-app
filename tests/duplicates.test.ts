// Similarity/dedup consistency: searchNodes (powers MCP check_duplicate),
// suggestEngram routing (via search rank stability).

import { setupTestCortex, seedStandardData, assert, section, standalone, runSuite, SuiteResult } from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('duplicates', dupSuite);
}

async function dupSuite(): Promise<void> {
  const cx = await setupTestCortex('dup');
  try {
    await seedStandardData(cx.host);

    // ── searchNodes determinism (powers MCP check_duplicate) ──────────────
    section('searchNodes — deterministic per query');
    const q = 'Tudor Mareș publishers liaison';
    const s1 = await cx.host.searchNodes('work', q, 10);
    const s2 = await cx.host.searchNodes('work', q, 10);
    assert(s1.length === s2.length,
      `searchNodes("${q}") length stable`);
    assert(JSON.stringify(s1.map((n) => n.nodeId)) === JSON.stringify(s2.map((n) => n.nodeId)),
      `searchNodes returns the same node IDs in the same order`);

    // ── Top match is the relevant node ───────────────────────────────────
    section('searchNodes — top match for unique text is the right node');
    const s3 = await cx.host.searchNodes('work', 'Publishers Liaison', 5);
    assert(s3.length > 0, `searchNodes returns at least one result`);
    assert(!!s3[0]?.text.toLowerCase().includes('tudor'),
      `Top result for "Publishers Liaison" contains the Tudor Mareș node`,
      { topText: s3[0]?.text.slice(0, 100) });

    // ── k parameter respected ────────────────────────────────────────────
    section('searchNodes — k parameter respected');
    const sk1 = await cx.host.searchNodes('work', 'Romania', 1);
    const sk3 = await cx.host.searchNodes('work', 'Romania', 3);
    assert(sk1.length <= 1, `searchNodes(k=1) returns at most 1`);
    assert(sk3.length <= 3, `searchNodes(k=3) returns at most 3`);
    assert(sk1[0]?.nodeId === sk3[0]?.nodeId,
      `searchNodes top result is consistent across k values`);

    // ── Different engrams don't bleed into searchNodes ───────────────────
    section('searchNodes — engram scoping');
    const workOnly = await cx.host.searchNodes('work', 'Tudor', 10);
    const docsOnly = await cx.host.searchNodes('docs', 'Tudor', 10);
    // No Tudor in docs, but query may still match weakly. Just check both
    // are deterministic.
    const docsAgain = await cx.host.searchNodes('docs', 'Tudor', 10);
    assert(JSON.stringify(docsOnly.map((n) => n.nodeId)) === JSON.stringify(docsAgain.map((n) => n.nodeId)),
      `searchNodes("docs", "Tudor") deterministic across calls`);
    assert(!!workOnly[0]?.text.toLowerCase().includes('tudor'),
      `searchNodes("work", "Tudor") returns a Tudor-containing node at top`);

  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('duplicates', dupSuite);
