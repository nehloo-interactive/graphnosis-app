// Metadata-read consistency: stats, listGraphs, listNodes, listEdges,
// graphsWithMetadata. These power the App's UI counters and engram pickers,
// so any non-determinism here means UI flicker or stale state.

import { setupTestCortex, seedStandardData, assert, section, standalone, runSuite, SuiteResult } from './_helpers.js';

export async function run(): Promise<SuiteResult> {
  return runSuite('metadata', metadataSuite);
}

async function metadataSuite(): Promise<void> {
  const cx = await setupTestCortex('metadata');
  try {
    await seedStandardData(cx.host);

    // ── listGraphs determinism ───────────────────────────────────────────
    section('listGraphs — order stable');
    const g1 = cx.host.listGraphs();
    const g2 = cx.host.listGraphs();
    assert(JSON.stringify(g1) === JSON.stringify(g2), `listGraphs() byte-identical across calls`);
    assert(g1.length === 3, `listGraphs returns 3 created engrams`, { graphs: g1 });
    assert(g1.includes('work') && g1.includes('people') && g1.includes('docs'),
      `listGraphs contains all created engrams`, { graphs: g1 });

    // ── stats determinism ────────────────────────────────────────────────
    section('stats — byte-stable given unchanged state');
    const s1 = cx.host.stats();
    const s2 = cx.host.stats();
    assert(s1.graphs.length === s2.graphs.length,
      `stats.graphs length stable across calls`,
      { len1: s1.graphs.length, len2: s2.graphs.length });
    // Compare without the embedded nodes[] array (which contains object refs
    // that may not deep-equal even if logically identical).
    const skinny = (s: ReturnType<typeof cx.host.stats>): unknown =>
      s.graphs.map(({ graphId, totalNodes, activeNodes, softDeletedNodes, sources, corrections }) =>
        ({ graphId, totalNodes, activeNodes, softDeletedNodes, sources, corrections }));
    assert(JSON.stringify(skinny(s1)) === JSON.stringify(skinny(s2)),
      `stats per-graph counts byte-identical across calls`);

    // ── stats reflects ingest counts ─────────────────────────────────────
    section('stats — counts match ingested data');
    const workStats = s1.graphs.find((g) => g.graphId === 'work');
    assert(workStats?.sources === 2,
      `stats says work has 2 sources (roster + event)`, { sources: workStats?.sources });
    assert((workStats?.activeNodes ?? 0) > 0,
      `stats says work has > 0 active nodes`, { activeNodes: workStats?.activeNodes });

    // ── listNodes determinism ────────────────────────────────────────────
    section('listNodes — deterministic per engram');
    const n1 = cx.host.listNodes('work');
    const n2 = cx.host.listNodes('work');
    assert(n1.length === n2.length, `listNodes("work") length stable`);
    const nodeIds1 = n1.map((n) => n.id).sort();
    const nodeIds2 = n2.map((n) => n.id).sort();
    assert(JSON.stringify(nodeIds1) === JSON.stringify(nodeIds2),
      `listNodes("work") returns the same set of node IDs across calls`);

    // ── listEdges determinism ────────────────────────────────────────────
    section('listEdges — deterministic per engram');
    const e1 = cx.host.listEdges('work');
    const e2 = cx.host.listEdges('work');
    const dirIds1 = e1.directed.map((e) => e.id).sort();
    const dirIds2 = e2.directed.map((e) => e.id).sort();
    assert(JSON.stringify(dirIds1) === JSON.stringify(dirIds2),
      `listEdges("work").directed IDs stable across calls`,
      { count: dirIds1.length });
    const undirIds1 = e1.undirected.map((e) => e.id).sort();
    const undirIds2 = e2.undirected.map((e) => e.id).sort();
    assert(JSON.stringify(undirIds1) === JSON.stringify(undirIds2),
      `listEdges("work").undirected IDs stable across calls`,
      { count: undirIds1.length });

    // ── graphsWithMetadata determinism ───────────────────────────────────
    section('graphsWithMetadata — stable');
    const gm1 = cx.host.graphsWithMetadata();
    const gm2 = cx.host.graphsWithMetadata();
    assert(JSON.stringify(gm1) === JSON.stringify(gm2),
      `graphsWithMetadata() byte-identical across calls`);

  } finally {
    await cx.cleanup();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('metadata', metadataSuite);
