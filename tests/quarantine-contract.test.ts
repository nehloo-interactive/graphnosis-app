// Quarantine-import contract — the load-bearing exclusion guarantee.
//
// An imported (quarantined) skill must be INVISIBLE to:
//   - the default list_skills scope (SkillTrainer.listSkills())  → feeds list_skills + the watcher
//   - cross-engram @skill: resolution (linkCrossEngramCalls)
//   - the centralized host.isQuarantined / nonQuarantinedGraphs accessors
// …until the owner PROMOTES it, after which it becomes visible.
//
// Also covers importEngram landing in a fresh quarantine engram (not the live
// target) and the per-item promote / reject state machine.

import { SkillTrainer, linkCrossEngramCalls } from '../apps/desktop-sidecar/src/skill-trainer.js';
import { ingestClip } from '../apps/desktop-sidecar/src/ingest.js';
import { importEngram } from '../apps/desktop-sidecar/src/engram-pack.js';
import { buildGezPackage, type GezPayload } from '../apps/desktop-sidecar/src/gez-format.js';
import { createMcpServer, type McpCallTool } from '../apps/desktop-sidecar/src/mcp-server.js';
import { recordConsent } from '@graphnosis-app/core/settings';
import { assert, section, standalone, runSuite, setupTestCortex, type SuiteResult } from './_helpers.js';
import type { GraphnosisHost } from '../apps/desktop-sidecar/src/host.js';

/** Flatten an MCP tool result to its concatenated text. */
function mcpText(r: { content: Array<{ text: string }> }): string {
  return r.content.map((c) => c.text).join('\n');
}

/** Count total nodes a recall returned, across all graphs. */
function recallNodeCount(sub: { byGraph: Map<string, unknown[]> }): number {
  let n = 0;
  for (const nodes of sub.byGraph.values()) n += nodes.length;
  return n;
}

/** Ingest a minimal skill into an engram and return its sourceId. */
async function ingestSkill(host: GraphnosisHost, graphId: string, name: string, body?: string): Promise<string> {
  const ref = `skill:${name}`;
  const content = body ?? `# ${name}\n\n1. Do the first thing.\n2. Do the second thing.`;
  const rec = await host.ingest(graphId, 'skill', ref, { kind: 'markdown', content, sourceRef: ref });
  return rec.sourceId;
}

/** Mark an engram as quarantined holding one item (simulating an import batch). */
async function markQuarantined(host: GraphnosisHost, graphId: string, fromPack: string, sourceId: string): Promise<void> {
  await host.patchGraphMetadata(graphId, {
    sensitivityTier: 'sensitive',
    executionAutonomyLevel: 'L0',
    quarantine: { fromPack, verified: false, importedAt: Date.now(), items: [{ sourceId, state: 'quarantined' }] },
  });
}

function gezSample(): GezPayload {
  return {
    formatVersion: '1', exportedBy: 'peer', exportedAt: Date.now(),
    engramId: 'shared', engramDisplayName: 'Shared', engramTier: 'personal', engramTemplate: 'personal',
    sources: [{ sourceId: 'clip:imported', kind: 'clip', ref: 'imported-note', text: 'imported memory content', ingestedAt: 1 }],
    signerPublicKey: '', signature: '',
  };
}

async function quarantineSuite(): Promise<void> {
  const cortex = await setupTestCortex('quarantine');
  try {
    const host = cortex.host;
    const trainer = new SkillTrainer(host, null);

    // A live, trusted skill engram (visible). Distinctive token so recall can
    // target it specifically.
    await host.createGraph('live');
    await host.replaceGraphMetadata('live', { template: 'skill', displayName: 'Live', createdAt: 1 });
    const liveSkill = await ingestSkill(
      host, 'live', 'live-skill',
      '# live-skill\n\nThis skill mentions the LIVEONLYTOKEN marker.\n1. Do the live thing.\n2. Finish.',
    );

    // A caller skill in 'live' that references an imported skill by name.
    const callerSkill = await ingestSkill(
      host, 'live', 'caller-skill',
      '# caller-skill\n\n1. First do setup.\n2. @skill: imported skill\n',
    );

    // An imported skill engram, marked quarantined. Distinctive token that must
    // NEVER appear in any AI-facing recall while quarantined.
    await host.createGraph('quarantine-batch-1');
    await host.replaceGraphMetadata('quarantine-batch-1', { template: 'skill', displayName: 'Q', createdAt: 2 });
    // IMPORTEDBODYPHRASE is a BODY-only sentinel: it appears in the skill text
    // but never in any test query, so finding it in a recall prompt proves the
    // quarantined node TEXT leaked (not just the query being echoed back in the
    // anchor audit footer).
    const importedSkill = await ingestSkill(
      host, 'quarantine-batch-1', 'imported skill',
      '# imported skill\n\nThis quarantined skill mentions IMPORTEDBODYPHRASE and the imported procedure.\n1. Do the imported thing.\n2. Finish.',
    );
    await markQuarantined(host, 'quarantine-batch-1', 'peer-pack', importedSkill);

    // Obligations: one in the live engram (must surface via recall_obligations)
    // and one in the quarantine engram (must NOT). QUARANTINEDOBLIGATIONPHRASE is
    // a body-only sentinel — its presence in any recall_obligations output proves
    // the quarantined obligation leaked.
    const obligationDueAt = Date.now() + 3 * 24 * 60 * 60 * 1000;
    await ingestClip(host, 'live', 'Renew the live vendor contract on time', 'Live obligation', {
      triggeredBy: 'test:obligation',
      obligation: { obligationType: 'renewal', expiresAt: obligationDueAt },
    });
    await ingestClip(host, 'quarantine-batch-1', 'QUARANTINEDOBLIGATIONPHRASE deadline approaching', 'Quarantined obligation', {
      triggeredBy: 'test:obligation',
      obligation: { obligationType: 'deadline', expiresAt: obligationDueAt },
    });
    await host.obligationIndex.ensureLoaded();

    // MCP server over this host — exercises the AI-facing tool guards exactly
    // as an external client would hit them.
    const { callTool }: { callTool: McpCallTool } = createMcpServer({
      host,
      llm: () => null,
      defaultGraphId: () => 'live',
      pendingDiffs: new Map(),
      skillTrainer: trainer,
    });

    // ── isQuarantined / nonQuarantinedGraphs ──────────────────────────────────
    section('centralized host accessors');
    assert(host.isQuarantined('quarantine-batch-1'), 'quarantine engram reports isQuarantined');
    assert(!host.isQuarantined('live'), 'live engram is not quarantined');
    assert(!host.nonQuarantinedGraphs().includes('quarantine-batch-1'), 'nonQuarantinedGraphs excludes the quarantine engram');
    assert(host.nonQuarantinedGraphs().includes('live'), 'nonQuarantinedGraphs includes live');

    // ── list_skills default scope (feeds watcher + list_skills) ───────────────
    section('INVISIBLE to default list_skills scope before promote');
    const before = trainer.listSkills();
    const beforeIds = new Set(before.map((s) => s.sourceId));
    assert(beforeIds.has(liveSkill), 'live skill is listed');
    assert(!beforeIds.has(importedSkill), 'quarantined imported skill is NOT in default scope', [...beforeIds]);
    // Explicit scope still returns it (review tooling).
    const scoped = trainer.listSkills('quarantine-batch-1');
    assert(scoped.some((s) => s.sourceId === importedSkill), 'explicit scope to the quarantine engram still returns the imported skill');

    // ── cross-engram @skill: resolution ───────────────────────────────────────
    section('INVISIBLE to cross-engram @skill: resolution before promote');
    await linkCrossEngramCalls(host, host.skillCallLinks, 'live', callerSkill, host.listGraphs());
    const linksBefore = await host.skillCallLinks.getForSource('live', callerSkill);
    assert(!linksBefore.some((l) => l.targetGraphId === 'quarantine-batch-1'),
      'no cross-link resolves into the quarantine engram', linksBefore);

    // ── host.recall: the centralized visibility boundary ──────────────────────
    // This is the load-bearing leak: before the fix, host.recall had NO internal
    // quarantine guard, so an explicit onlyGraphIds:[quarantineId] returned the
    // full quarantine node text. Now it must return ZERO nodes by default.
    section('INVISIBLE to host.recall (the centralized boundary)');
    const scopedToQ = await host.recall('imported procedure thing', { onlyGraphIds: ['quarantine-batch-1'] });
    assert(recallNodeCount(scopedToQ) === 0,
      'host.recall({onlyGraphIds:[quarantineId]}) returns ZERO nodes by default', { count: recallNodeCount(scopedToQ) });
    assert(!scopedToQ.byGraph.has('quarantine-batch-1') || scopedToQ.byGraph.get('quarantine-batch-1')!.length === 0,
      'quarantine engram contributes no nodes to a scoped recall');
    assert(!(scopedToQ.prompt ?? '').includes('IMPORTEDBODYPHRASE'),
      'quarantined node text never appears in the scoped recall prompt');

    // Opt-in: the trusted review path can still see them.
    const scopedWithOptIn = await host.recall('imported procedure thing', { onlyGraphIds: ['quarantine-batch-1'], includeQuarantined: true });
    assert(recallNodeCount(scopedWithOptIn) > 0,
      'host.recall with includeQuarantined:true DOES return the quarantine nodes (review path)', { count: recallNodeCount(scopedWithOptIn) });
    assert((scopedWithOptIn.prompt ?? '').includes('IMPORTEDBODYPHRASE'),
      'includeQuarantined surfaces the quarantined node text (review path)');

    // A recall over ALL graphs (default scope) never includes quarantine nodes…
    section('INVISIBLE to a full-cortex recall');
    const fullRecall = await host.recall('imported procedure thing');
    assert(!fullRecall.byGraph.has('quarantine-batch-1') || fullRecall.byGraph.get('quarantine-batch-1')!.length === 0,
      'a full-cortex recall never includes quarantine nodes');
    assert(!(fullRecall.prompt ?? '').includes('IMPORTEDBODYPHRASE'),
      'quarantined node text never appears in a full-cortex recall prompt');
    // …but the live engram is still fully searchable.
    const liveRecall = await host.recall('live thing marker');
    assert((liveRecall.prompt ?? '').includes('LIVEONLYTOKEN') || recallNodeCount(liveRecall) > 0,
      'non-quarantined engrams remain fully searchable');

    // ── direct skill-read MCP tools refuse a quarantined engram ───────────────
    section('AI-facing read tools refuse the quarantine engram');
    const getRes = await callTool('get_skill', { graphId: 'quarantine-batch-1', sourceId: importedSkill });
    assert(getRes.isError === true && mcpText(getRes).includes('quarantined'),
      'get_skill on a quarantined (graphId,sourceId) is refused', mcpText(getRes));
    assert(!mcpText(getRes).includes('IMPORTEDBODYPHRASE'), 'get_skill refusal leaks no skill body');

    const walkRes = await callTool('walk_skill', { graphId: 'quarantine-batch-1', sourceId: importedSkill });
    assert(walkRes.isError === true && mcpText(walkRes).includes('quarantined'),
      'walk_skill on a quarantined skill is refused', mcpText(walkRes));

    const walkStructRes = await callTool('walk_skill_structured', { graphId: 'quarantine-batch-1', sourceId: importedSkill });
    assert(walkStructRes.isError === true && mcpText(walkStructRes).includes('quarantined'),
      'walk_skill_structured on a quarantined skill is refused', mcpText(walkStructRes));

    // list_skills with an explicit quarantine engram → refused on the AI path.
    const listExplicitRes = await callTool('list_skills', { engram: 'quarantine-batch-1' });
    assert(listExplicitRes.isError === true && mcpText(listExplicitRes).includes('quarantined'),
      'list_skills(quarantineGraphId) is refused on the AI path', mcpText(listExplicitRes));
    // The default (no-engram) list_skills still works and excludes the import.
    const listDefaultRes = await callTool('list_skills', {});
    assert(listDefaultRes.isError !== true, 'default list_skills still works');
    assert(!mcpText(listDefaultRes).includes(importedSkill),
      'default list_skills excludes the quarantined skill');

    // recall_source on a quarantined source → refused.
    const recallSrcRes = await callTool('recall_source', { engram: 'quarantine-batch-1', sourceId: importedSkill });
    assert(recallSrcRes.isError === true && mcpText(recallSrcRes).includes('quarantined'),
      'recall_source on a quarantined source is refused', mcpText(recallSrcRes));

    // engram_summary reads node text via listNodes (not host.recall), so it must
    // guard the named engram itself — otherwise it leaks a content-preview sample
    // of an imported-but-unpromoted engram.
    const summaryRes = await callTool('engram_summary', { engram: 'quarantine-batch-1' });
    assert(summaryRes.isError === true && mcpText(summaryRes).includes('quarantined'),
      'engram_summary on a quarantined engram is refused', mcpText(summaryRes));
    assert(!mcpText(summaryRes).includes('IMPORTEDBODYPHRASE'),
      'engram_summary refusal leaks no quarantined node text');
    // The live engram summary still works.
    const summaryLive = await callTool('engram_summary', { engram: 'live' });
    assert(summaryLive.isError !== true, 'engram_summary on the live engram still works', mcpText(summaryLive));

    // ── recall_obligations excludes quarantined obligations ───────────────────
    // recall_obligations reads the obligation index directly (not host.recall),
    // so it must subtract quarantined ids like recall_structured/_with_citations.
    //
    // Isolate the QUARANTINE guard from the consent gate: the quarantine engram is
    // sensitive-tier, and the consent gate already auto-excludes un-consented
    // sensitive engrams from a federated recall (and prompts on an explicit one).
    // Grant a standing sensitive-tier consent for this engram so consent is NOT
    // what hides it — then the only thing keeping its obligations out is the new
    // quarantine subtraction. Without the fix these assertions FAIL (the
    // obligation leaks); with it they pass.
    section('recall_obligations excludes the quarantine engram');
    {
      const cur = host.getSettings();
      const grantedConsents = recordConsent(
        cur.ai.dataAccessConsents, 'unknown-client', 'sensitive', -1, 'test', 'US', '2025-05', 'quarantine-batch-1',
      );
      await host.setSettings({ ai: { ...cur.ai, dataAccessConsents: grantedConsents } });
    }
    const obDefault = await callTool('recall_obligations', {});
    assert(obDefault.isError !== true, 'recall_obligations default scope works', mcpText(obDefault));
    const obPayload = JSON.parse(mcpText(obDefault).split('\n\n')[0]!) as { obligations: Array<{ graphId: string }> };
    assert(!obPayload.obligations.some((o) => o.graphId === 'quarantine-batch-1'),
      'recall_obligations default scope excludes the quarantine engram (despite granted consent)', obPayload.obligations.map((o) => o.graphId));
    assert(!mcpText(obDefault).includes('QUARANTINEDOBLIGATIONPHRASE'),
      'quarantined obligation text never appears in recall_obligations output');
    assert(obPayload.obligations.some((o) => o.graphId === 'live'),
      'recall_obligations still surfaces the live obligation', obPayload.obligations.map((o) => o.graphId));
    // Naming the quarantine engram explicitly (consent granted) still surfaces nothing.
    const obScoped = await callTool('recall_obligations', { only_engrams: ['quarantine-batch-1'] });
    assert(obScoped.isError !== true, 'recall_obligations explicit scope works', mcpText(obScoped));
    const obScopedPayload = JSON.parse(mcpText(obScoped).split('\n\n')[0]!) as { obligations: unknown[] };
    assert(obScopedPayload.obligations.length === 0,
      'recall_obligations(only_engrams:[quarantineId]) returns no obligations', obScopedPayload);
    assert(!mcpText(obScoped).includes('QUARANTINEDOBLIGATIONPHRASE'),
      'explicit-only recall_obligations leaks no quarantined obligation text');

    // ── list_engrams flags quarantine engrams ─────────────────────────────────
    section('list_engrams flags the quarantine engram');
    const listEngramsRes = await callTool('list_engrams', {});
    const engramRows = JSON.parse(mcpText(listEngramsRes).split('\n\n')[0]!) as Array<{ graphId: string; quarantined?: boolean }>;
    const qRow = engramRows.find((r) => r.graphId === 'quarantine-batch-1');
    const liveRow = engramRows.find((r) => r.graphId === 'live');
    assert(qRow?.quarantined === true, 'list_engrams marks the quarantine engram quarantined:true', qRow);
    assert(liveRow?.quarantined === false, 'list_engrams marks the live engram quarantined:false', liveRow);

    // ── review path works: list_quarantined sees the items ────────────────────
    section('review path (list_quarantined) sees the quarantined items');
    const listQRes = await callTool('list_quarantined', {});
    assert(listQRes.isError !== true, 'list_quarantined succeeds for the owner');
    assert(mcpText(listQRes).includes('quarantine-batch-1'),
      'list_quarantined surfaces the quarantine engram for review', mcpText(listQRes));
    assert(mcpText(listQRes).includes(importedSkill),
      'list_quarantined surfaces the quarantined item id for review');

    // ── selective promote: promoted readable, others stay excluded ────────────
    // A second batch with TWO items; promote only the first. The engram stays
    // quarantined (item 2 unadjudicated), so the promoted source is readable via
    // its NEW home while the still-quarantined sibling stays refused.
    section('selective promote keeps unadjudicated siblings excluded');
    await host.createGraph('quarantine-batch-2');
    await host.replaceGraphMetadata('quarantine-batch-2', { template: 'skill', displayName: 'Q2', createdAt: 3 });
    const promoteMe = await ingestSkill(host, 'quarantine-batch-2', 'promote-me',
      '# promote-me\n\nThis skill mentions PROMOTEDTOKEN.\n1. Step one.\n2. Done.');
    const stayQ = await ingestSkill(host, 'quarantine-batch-2', 'stay-q',
      '# stay-q\n\nThis skill mentions STILLQUARANTINEDTOKEN.\n1. Step one.\n2. Done.');
    {
      await host.patchGraphMetadata('quarantine-batch-2', {
        sensitivityTier: 'sensitive', executionAutonomyLevel: 'L0',
        quarantine: { fromPack: 'peer-pack-2', verified: false, importedAt: Date.now(),
          items: [{ sourceId: promoteMe, state: 'quarantined' }, { sourceId: stayQ, state: 'quarantined' }] },
      });
    }
    // Promote only `promoteMe` into 'live'.
    const promoteRes = await callTool('promote_import', { items: [promoteMe], target_engram: 'live' });
    assert(promoteRes.isError !== true, 'promote_import succeeds', mcpText(promoteRes));
    assert(host.isQuarantined('quarantine-batch-2'),
      'batch stays quarantined while item 2 is unadjudicated');
    // The promoted source now lives in 'live' (non-quarantined) → readable.
    const promotedSrc = host.listSources('live').find((s) => s.kind === 'skill' && s.ref.includes('promote-me'));
    assert(!!promotedSrc, 'promoted skill moved into the live engram');
    const getPromoted = await callTool('get_skill', { graphId: 'live', sourceId: promotedSrc!.sourceId });
    assert(getPromoted.isError !== true && mcpText(getPromoted).includes('PROMOTEDTOKEN'),
      'promoted skill is readable via get_skill from its new home', mcpText(getPromoted));
    // The still-quarantined sibling stays refused.
    const getStayQ = await callTool('get_skill', { graphId: 'quarantine-batch-2', sourceId: stayQ });
    assert(getStayQ.isError === true && mcpText(getStayQ).includes('quarantined'),
      'still-quarantined sibling stays refused after a selective promote', mcpText(getStayQ));
    const recallStayQ = await host.recall('STILLQUARANTINEDTOKEN', { onlyGraphIds: ['quarantine-batch-2'] });
    assert(recallNodeCount(recallStayQ) === 0 && !(recallStayQ.prompt ?? '').includes('STILLQUARANTINEDTOKEN'),
      'still-quarantined sibling content stays out of recall');

    // ── promote → becomes visible ─────────────────────────────────────────────
    section('VISIBLE after promote');
    await host.moveSource('quarantine-batch-1', importedSkill, 'live');
    // Lift the per-item flag (what promote_import does).
    const qm = host.getGraphMetadata('quarantine-batch-1')!;
    await host.patchGraphMetadata('quarantine-batch-1', {
      quarantine: { ...qm.quarantine!, items: qm.quarantine!.items.map((it) => ({ ...it, state: 'promoted' as const })) },
    });
    assert(!host.isQuarantined('quarantine-batch-1'), 'engram no longer quarantined once all items promoted');
    const after = trainer.listSkills();
    const afterIds = new Set(after.map((s) => s.sourceId));
    // The moved skill now lives in 'live' (a non-quarantined engram) → visible.
    const movedNowInLive = host.listSources('live').some((s) => s.kind === 'skill' && s.ref.includes('imported'));
    assert(movedNowInLive, 'promoted skill now lives in the live engram');
    assert(afterIds.size >= 2, 'default scope now surfaces the promoted skill', [...afterIds]);

    // re-resolve cross-links: now the caller can resolve into 'live'
    await linkCrossEngramCalls(host, host.skillCallLinks, 'live', callerSkill, host.listGraphs());

    // ── importEngram lands in a FRESH quarantine engram, not the target ───────
    section('importEngram quarantines by default');
    const pack = buildGezPackage(gezSample());
    const beforeGraphs = new Set(host.listGraphs());
    const { result } = await importEngram(host, pack, { withEmbedding: (fn) => fn() });
    assert(!!result.quarantineEngramId, 'import returns a quarantine engram id');
    assert(!beforeGraphs.has(result.quarantineEngramId!), 'a FRESH engram was created for the import');
    assert(host.isQuarantined(result.quarantineEngramId!), 'the import-landing engram is quarantined');
    assert(result.imported === 1, 'the imported source landed');
    assert(!host.listGraphs().includes('shared'), 'nothing leaked into the pack\'s original target engram name (no "shared" engram created)');

    // reject state machine
    section('reject discards + marks rejected');
    const qid = result.quarantineEngramId!;
    const item = host.getGraphMetadata(qid)!.quarantine!.items[0]!;
    await host.forgetSource(qid, item.sourceId, { triggeredBy: 'user:reject-import' });
    const qm2 = host.getGraphMetadata(qid)!;
    await host.patchGraphMetadata(qid, {
      quarantine: { ...qm2.quarantine!, items: qm2.quarantine!.items.map((it) => ({ ...it, state: 'rejected' as const })) },
    });
    assert(!host.isQuarantined(qid), 'engram no longer quarantined once item rejected');
  } finally {
    await cortex.cleanup();
  }
}

export async function run(): Promise<SuiteResult> {
  return runSuite('quarantine-contract', quarantineSuite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('quarantine-contract', quarantineSuite);
