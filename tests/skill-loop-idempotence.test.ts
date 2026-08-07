// Regression: edge derivation for capped loops must be idempotent (Lemma 1).
//
// Root cause: linkSkillLoopsAndBranches deleted stale loop edges with an EXACT
// match on the bare evidence tag (`e.evidence === SKILL_LOOP_EVIDENCE`). But a
// CAPPED loop (`@loop: 2 max=4`) is encoded with a suffix — `skill:loop;max=4`
// (see encodeLoopEvidence). The suffixed edge was read back correctly but never
// matched by the stale-deletion pass, so re-deriving edges left the old capped
// edge in place and appended a new one. Two re-derivations → two loop edges,
// breaking the idempotent-fixpoint guarantee Lemma 1 / Theorem 1 / Invariant 3
// rely on.
//
// Fix: the deletion predicate now matches the bare tag OR a `;`-suffixed form
// for both loop and branch evidence. This suite drives linkSkillLoopsAndBranches
// directly against a controlled set of body nodes (stable nodeIds across
// re-derivations — the exact scenario the bug needs), flips the cap between
// runs, and asserts EXACTLY ONE loop edge survives every time.

import {
  linkSkillLoopsAndBranches,
  encodeLoopEvidence,
  parseLoopMax,
  SKILL_LOOP_EVIDENCE,
  SKILL_BRANCH_EVIDENCE,
} from '../apps/desktop-sidecar/src/skill-trainer.js';
import type { GraphnosisHost } from '../apps/desktop-sidecar/src/host.js';
import { assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

// ── Minimal in-memory host ────────────────────────────────────────────────────
// Implements only the surface linkSkillLoopsAndBranches + loadSkillBodyNodes use:
//   getSourceRecord, listNodes, getFullNodeContent, listEdges,
//   unlinkEdgesBatch, linkNodesDirectedBatch
// Using a fake (rather than a full cortex) is what lets us keep STABLE nodeIds
// while changing a step's `max=` cap between derivations — reproducing the
// accumulation bug exactly. The cortex retrain path mints new nodeIds, which
// would mask it.

interface FakeNode { id: string; content: string }
interface FakeEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  weight: number;
  evidence?: string;
}

class FakeHost {
  private nodes: FakeNode[] = [];
  private edges: FakeEdge[] = [];
  private edgeSeq = 0;

  constructor(private readonly sourceId: string) {}

  setNodes(nodes: FakeNode[]): void {
    this.nodes = nodes.map((n) => ({ ...n }));
  }
  /** Mutate one node's content in place (preserves its id) — the "edit the
   *  step's max= cap and re-derive" operation. */
  setNodeContent(id: string, content: string): void {
    const n = this.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`no node ${id}`);
    n.content = content;
  }
  loopEdges(): FakeEdge[] {
    return this.edges.filter(
      (e) =>
        e.evidence === SKILL_LOOP_EVIDENCE ||
        (e.evidence?.startsWith(SKILL_LOOP_EVIDENCE + ';') ?? false),
    );
  }
  branchEdges(): FakeEdge[] {
    return this.edges.filter(
      (e) =>
        e.evidence === SKILL_BRANCH_EVIDENCE ||
        (e.evidence?.startsWith(SKILL_BRANCH_EVIDENCE + ';') ?? false),
    );
  }

  // ── methods consumed by the linker ──────────────────────────────────────────
  getSourceRecord(_graphId: string, sourceId: string) {
    if (sourceId !== this.sourceId) return undefined;
    return { nodeIds: this.nodes.map((n) => n.id) } as ReturnType<GraphnosisHost['getSourceRecord']>;
  }
  listNodes(_graphId: string) {
    return this.nodes.map((n) => ({
      id: n.id,
      contentPreview: n.content,
      confidence: 1,
      validUntil: undefined as number | undefined,
    })) as unknown as ReturnType<GraphnosisHost['listNodes']>;
  }
  getFullNodeContent(_graphId: string, nodeId: string): string | null {
    return this.nodes.find((n) => n.id === nodeId)?.content ?? null;
  }
  listEdges(_graphId: string) {
    return {
      directed: this.edges.map((e) => ({ ...e })),
      undirected: [],
    } as unknown as ReturnType<GraphnosisHost['listEdges']>;
  }
  async unlinkEdgesBatch(_graphId: string, edgeIds: string[]): Promise<number> {
    const before = this.edges.length;
    const drop = new Set(edgeIds);
    this.edges = this.edges.filter((e) => !drop.has(e.id));
    return before - this.edges.length;
  }
  async linkNodesDirectedBatch(
    _graphId: string,
    edges: Array<{ from: string; to: string; type: string; weight?: number; evidence?: string }>,
  ): Promise<number> {
    for (const e of edges) {
      this.edges.push({
        id: `edge-${this.edgeSeq++}`,
        from: e.from,
        to: e.to,
        type: e.type,
        weight: e.weight ?? 0.7,
        evidence: e.evidence,
      });
    }
    return edges.length;
  }
}

const GRAPH = 'docs';
const SKILL = 'skill:loop-idem-test';

/** Body with a capped loop on step 3 referencing step 2. The `max` value is
 *  parameterized so a re-derivation can flip the cap. */
function buildBody(maxCap: number): FakeNode[] {
  return [
    { id: 'n1', content: '1. Gather the inputs.' },
    { id: 'n2', content: '2. Attempt the operation.' },
    { id: 'n3', content: `3. If it failed, @loop: 2 max=${maxCap}` },
    { id: 'n4', content: '4. Report the result.' },
  ];
}

async function suite(): Promise<void> {
  section('encodeLoopEvidence / parseLoopMax — capped vs bare');
  assert(encodeLoopEvidence(4) === 'skill:loop;max=4', 'capped loop encodes with ;max= suffix', encodeLoopEvidence(4));
  assert(encodeLoopEvidence(undefined) === SKILL_LOOP_EVIDENCE, 'uncapped loop encodes as bare tag', encodeLoopEvidence(undefined));
  assert(parseLoopMax('skill:loop;max=4') === 4, 'parseLoopMax reads the cap back', parseLoopMax('skill:loop;max=4'));

  section('linkSkillLoopsAndBranches — capped loop re-derivation is idempotent (Lemma 1)');
  const host = new FakeHost(SKILL);
  host.setNodes(buildBody(4)); // @loop: 2 max=4

  // First derivation → exactly one capped loop edge (max=4).
  const r1 = await linkSkillLoopsAndBranches(host as unknown as GraphnosisHost, GRAPH, SKILL);
  assert(r1.loopEdges === 1, 'first derivation reports one loop edge', r1);
  let loops = host.loopEdges();
  assert(loops.length === 1, 'exactly one loop edge after first derivation', loops.map((e) => e.evidence));
  assert(loops[0]!.evidence === 'skill:loop;max=4', 'loop edge carries the max=4 cap', loops[0]!.evidence);

  // Re-derive WITHOUT changing anything → still exactly one (pure fixpoint).
  await linkSkillLoopsAndBranches(host as unknown as GraphnosisHost, GRAPH, SKILL);
  loops = host.loopEdges();
  assert(loops.length === 1, 'idempotent: re-derive with no change still yields ONE loop edge', loops.map((e) => e.evidence));

  // Change the cap max=4 → max=5 and re-derive. This is the bug's exact trigger:
  // the stale capped edge (skill:loop;max=4) must be deleted and replaced, not
  // accumulated alongside the new skill:loop;max=5.
  host.setNodeContent('n3', '3. If it failed, @loop: 2 max=5');
  await linkSkillLoopsAndBranches(host as unknown as GraphnosisHost, GRAPH, SKILL);
  loops = host.loopEdges();
  assert(
    loops.length === 1,
    'idempotent: changing max=4 → max=5 leaves EXACTLY ONE loop edge (not two stale+new)',
    loops.map((e) => e.evidence),
  );
  assert(loops[0]!.evidence === 'skill:loop;max=5', 'surviving loop edge reflects the new cap (max=5)', loops[0]!.evidence);

  // A further unchanged re-derivation stays at one.
  await linkSkillLoopsAndBranches(host as unknown as GraphnosisHost, GRAPH, SKILL);
  assert(host.loopEdges().length === 1, 'idempotent after multiple re-derivations', host.loopEdges().map((e) => e.evidence));

  section('linkSkillLoopsAndBranches — uncapped ↔ capped transitions also idempotent');
  const host2 = new FakeHost(SKILL);
  // Start uncapped: bare `@loop: 2` → evidence `skill:loop`.
  host2.setNodes([
    { id: 'm1', content: '1. Gather the inputs.' },
    { id: 'm2', content: '2. Attempt the operation.' },
    { id: 'm3', content: '3. If it failed, @loop: 2' },
    { id: 'm4', content: '4. Report the result.' },
  ]);
  await linkSkillLoopsAndBranches(host2 as unknown as GraphnosisHost, GRAPH, SKILL);
  let l2 = host2.loopEdges();
  assert(l2.length === 1 && l2[0]!.evidence === SKILL_LOOP_EVIDENCE, 'uncapped loop yields one bare loop edge', l2.map((e) => e.evidence));

  // Add a cap (bare → suffixed): the bare edge must be deleted, not kept.
  host2.setNodeContent('m3', '3. If it failed, @loop: 2 max=3');
  await linkSkillLoopsAndBranches(host2 as unknown as GraphnosisHost, GRAPH, SKILL);
  l2 = host2.loopEdges();
  assert(l2.length === 1, 'bare → capped transition leaves exactly one loop edge', l2.map((e) => e.evidence));
  assert(l2[0]!.evidence === 'skill:loop;max=3', 'transitioned edge carries the new cap', l2[0]!.evidence);

  // Remove the cap (suffixed → bare): the capped edge must be deleted, not kept.
  host2.setNodeContent('m3', '3. If it failed, @loop: 2');
  await linkSkillLoopsAndBranches(host2 as unknown as GraphnosisHost, GRAPH, SKILL);
  l2 = host2.loopEdges();
  assert(l2.length === 1 && l2[0]!.evidence === SKILL_LOOP_EVIDENCE, 'capped → bare transition leaves one bare loop edge', l2.map((e) => e.evidence));
}

export async function run(): Promise<SuiteResult> {
  return runSuite('skill-loop-idempotence', suite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('skill-loop-idempotence', suite);
