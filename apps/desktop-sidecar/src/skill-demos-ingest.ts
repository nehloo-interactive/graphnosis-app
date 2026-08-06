// Imports the three official Graphnosis demo skill packs bundled inside the
// sidecar binary into a target engram. Called on first cortex unlock by the
// `skillDemos:ingest` IPC, and again on every app-version bump so updated
// demos reach existing users.
//
// The pack bytes are base64-encoded into `skill-demos.generated.ts` at build
// time by `scripts/generate-skill-demos-content.mjs`, which reads them from
// `dist/packs/bundle/*.gsk`. They are signed by the Graphnosis Ed25519 key,
// so the same verifyGskSignature path the user-loaded import IPC uses also
// verifies these — a tampered binary is detected before anything lands in
// the graph.
//
// Flow mirrors `skill:importGsk`: decrypt → verify → for each skill in the
// pack, build the metadata + title + body + recipes + 8-category-goals
// section list, seed via ingestClip, insertNodeAt the rest, wire all SOP
// edges. We duplicate the loop body (rather than calling the IPC handler
// directly) because the IPC handler returns user-facing shapes and we don't
// need any of that — just side-effect ingest.

import type { GraphnosisHost } from './host.js';
import type { LicenseValidator } from './license-validator.js';
import { BUNDLED_SKILL_DEMOS } from './skill-demos.generated.js';
import { parseGskPackage, type GskPayload } from './gsk-format.js';
import { ingestClip } from './ingest.js';
import { linkSkillSequence, linkSkillGoals } from './skill-trainer.js';

/**
 * The `addedBy` stamp every source this module writes carries (set at the
 * ingestClip call below).
 *
 * Exported because it is not bookkeeping — it is the ONLY thing that tells a
 * source this ingest wrote apart from one an owner put in the same engram, and
 * `skillDemos:ingest` reads it to decide whether wiping the engram is safe.
 * Written once, at the same moment the source record is created, so it cannot
 * drift out of step with the thing it describes.
 *
 * Changing this string orphans every source written by an older build: they
 * stop matching and start reading as owner work. That is the safe direction of
 * failure — the ingest refuses instead of deleting — but it does mean a rename
 * silently retires the demo-refresh path for existing users.
 */
export const BUNDLED_DEMO_ADDED_BY = 'graphnosis-bundled-demo';

export interface IngestBundledSkillDemosResult {
  /** How many .gsk packs we attempted — one when `packFilename` selected a
   *  single Agempus pack, otherwise all of BUNDLED_SKILL_DEMOS. */
  packsAttempted: number;
  /** How many individual skills (across all attempted packs) were saved. */
  skillsIngested: number;
  /** Skills we skipped because their body text was empty. */
  skillsSkippedEmpty: string[];
  /** Per-pack errors. Other packs still proceed if one throws. */
  packErrors: Array<{ filename: string; reason: string }>;
  /** Pack signature verification results. Note: bundled packs are signed,
   *  so this should always be true; a false value points at either a
   *  tampered sidecar binary or a broken signing pipeline. */
  verified: Array<{ filename: string; verified: boolean }>;
  /**
   * Set ONLY when `skillDemos:ingest` REFUSED to run because the target engram
   * holds sources this ingest did not write — see the guard in ipc.ts, which is
   * where this is constructed (never by `ingestBundledSkillDemos`, which by
   * then has already been cleared to run).
   *
   * Absent on every normal run, so a caller that ignores the field still sees
   * the old shape. But an ignoring caller also renders a refusal as a bland
   * "0 skills ingested" success, which is the exact failure this whole guard
   * exists to end — so a UI that shows the result MUST branch on this.
   */
  refused?: {
    reason: 'foreign-sources';
    /** How many sources blocked the wipe. The number is the actionable part. */
    foreignSourceCount: number;
    /** Refs of the blocking sources so the UI can name the work being
     *  protected. Capped — this is for recognition, not an inventory. */
    foreignSourceRefs: string[];
  };
}

/** A source found in the demos engram that this ingest did not write. */
export interface ForeignSkillDemoSource {
  sourceId: string;
  ref: string;
  /** `undefined` = added straight through the App UI (drag-drop, paste, file
   *  picker); a string = whichever client, trainer or connector wrote it.
   *  Either way: not ours. Carried so a diagnostic can say who. */
  addedBy: string | undefined;
}

/**
 * The sources in a demos engram that this module did not write.
 *
 * Anything whose `addedBy` is not `BUNDLED_DEMO_ADDED_BY` is foreign: a skill
 * the owner trained into the engram (`graphnosis-skill-trainer`, ipc.ts:7756),
 * a memory an MCP client saved (the client's name), a file the owner dragged in
 * (no `addedBy` at all), or a correction's add — `applyCorrection` routes adds
 * through `ingest` as a fresh `clip` source (host.ts:7338), so those surface
 * here too.
 *
 * Deliberately NO allowlist of "other writers we consider safe". A writer we
 * have not thought of has to read as foreign, because the cost of guessing
 * wrong is deleting the owner's work, while the cost of a false positive is a
 * demo pack that stays one version behind.
 */
export function findForeignSkillDemoSources(
  sources: ReadonlyArray<{ sourceId: string; ref: string; addedBy?: string }>,
): ForeignSkillDemoSource[] {
  return sources
    .filter((s) => s.addedBy !== BUNDLED_DEMO_ADDED_BY)
    .map((s) => ({ sourceId: s.sourceId, ref: s.ref, addedBy: s.addedBy }));
}

/** Romanian letters that never appear in the English variants. The bundled
 * Import one bundled pack — or every pack, when `packFilename` is omitted —
 * into `graphId`. Returns a summary the caller can surface to the user / log
 * to telemetry. Best-effort: one bad pack never blocks the rest, mirroring the
 * docs-ingest contract.
 *
 * `packFilename` exists because the bundle is no longer one engram's worth of
 * demos: it carries the three default Agempi (Onboarding, Ghampus Hush,
 * Coach), each of which installs into its OWN engram. The caller loops the
 * table and names the pack per engram; passing nothing keeps the old
 * everything-into-one-engram behaviour for any remaining caller.
 *
 * A `packFilename` that matches no bundled pack is reported as a packError
 * with `packsAttempted: 0` rather than silently ingesting all three — a typo'd
 * filename must not quietly fan every Agempus into one engram.
 *
 * The Romanian-diacritics language classifier that used to live here is gone
 * along with the `language` option: it existed because each old demo pack
 * shipped its SOP twice (EN + RO) and one had to be filtered out. The Agempus
 * packs are English-only, so the filter had nothing left to do — and left in
 * place it would have been an inert branch that silently dropped any skill
 * whose name happened to contain a diacritic.
 */
export async function ingestBundledSkillDemos(
  host: GraphnosisHost,
  graphId: string,
  licenseValidator: LicenseValidator | undefined,
  opts?: { packFilename?: string },
): Promise<IngestBundledSkillDemosResult> {
  const packs = opts?.packFilename
    ? BUNDLED_SKILL_DEMOS.filter((p) => p.filename === opts.packFilename)
    : BUNDLED_SKILL_DEMOS;
  const result: IngestBundledSkillDemosResult = {
    packsAttempted: packs.length,
    skillsIngested: 0,
    skillsSkippedEmpty: [],
    packErrors: [],
    verified: [],
  };
  if (opts?.packFilename && packs.length === 0) {
    result.packErrors.push({
      filename: opts.packFilename,
      reason: 'no bundled pack with that filename',
    });
    return result;
  }

  for (const entry of packs) {
    let payload: GskPayload;
    try {
      const bytes = Buffer.from(entry.gskBase64, 'base64');
      payload = parseGskPackage(bytes);
    } catch (e) {
      result.packErrors.push({
        filename: entry.filename,
        reason: `parse failed: ${e instanceof Error ? e.message : 'unknown'}`,
      });
      continue;
    }

    // Verify the signature. Bundled packs are always signed; a verification
    // failure here means either the bundled bytes were tampered with after
    // the build (extremely unlikely — they're inside the sidecar binary) or
    // the public key in license-validator.ts has been rotated without
    // re-bundling. Either way, we still ingest (with verified=false), and
    // surface the discrepancy in `result.verified` for diagnostics.
    let verified = false;
    try {
      verified = licenseValidator ? await licenseValidator.verifyGskSignature(payload) : false;
    } catch {
      verified = false;
    }
    result.verified.push({ filename: entry.filename, verified });

    for (const skill of payload.skills) {
      const body = (skill.trainedTextFallback?.trim() || skill.baseText?.trim() || '').trim();
      if (!body) {
        result.skillsSkippedEmpty.push(skill.name);
        continue;
      }
      const label = skill.name;

      // Section list — mirrors the skill:importGsk IPC handler shape.
      const provenanceComment =
        `<!-- bundled-demo ${new Date().toISOString()} · pack:${payload.id} v${payload.version} · ${payload.kind} · verified:${verified} · author:${payload.author} -->`;

      const formatRecipePlain = (
        r: { name: string; trigger: string; steps: Array<{ tool: string; query: string }> },
      ): string => {
        const lines: string[] = [`${r.name}: ${r.trigger}`];
        for (const s of r.steps) lines.push(`- ${s.tool}: ${s.query}`);
        return lines.join('\n');
      };

      const sections: Array<{ role: string; text: string }> = [];
      sections.push({ role: 'title', text: label });
      for (const para of body.split(/\n{2,}/)) {
        const t = para.trim();
        if (t) sections.push({ role: 'body', text: t });
      }
      for (const r of skill.recallRecipes ?? []) {
        sections.push({ role: 'recipe', text: formatRecipePlain(r) });
      }
      // All 8 goal categories. The pack's goals shape is the same as a
      // user-trained skill, so iterate them in the same order trainSkill
      // does to keep the on-screen layout consistent between
      // bundled-imported and self-trained skills.
      const g = skill.goals;
      if (g?.successLooksLike) sections.push({ role: 'goal-success', text: `Success: ${g.successLooksLike}` });
      if (g?.outOfScope) sections.push({ role: 'goal-scope', text: `Out of scope: ${g.outOfScope}` });
      if (g?.expectedOnCompletion) sections.push({ role: 'goal-done', text: `On completion: ${g.expectedOnCompletion}` });
      if (g?.trigger) sections.push({ role: 'goal-trigger', text: `Trigger: ${g.trigger}` });
      if (g?.prerequisites) sections.push({ role: 'goal-prereq', text: `Prerequisites: ${g.prerequisites}` });
      if (g?.onFailure) sections.push({ role: 'goal-failure', text: `On failure: ${g.onFailure}` });
      if (g?.requires) sections.push({ role: 'goal-requires', text: `Requires: ${g.requires}` });
      if (g?.produces) sections.push({ role: 'goal-produces', text: `Produces: ${g.produces}` });

      // Seed the source with the provenance comment, then insertNodeAt
      // each section in order. Same pattern as skill:importGsk.
      // The `addedBy` stamp is load-bearing beyond audit: the reingest guard in
      // `skillDemos:ingest` reads it back to decide whether the engram is still
      // ours to wipe. Hence the shared constant rather than a literal here —
      // a drift between the write and the read would make the guard see every
      // source as foreign and refuse forever.
      const rec = await ingestClip(host, graphId, provenanceComment, label, {
        addedBy: BUNDLED_DEMO_ADDED_BY,
        sourceKind: 'skill',
        triggeredBy: 'bundled-demo:ingest',
      });
      for (const s of sections) {
        const len = host.getSourceRecord(graphId, rec.sourceId)?.nodeIds.length ?? 1;
        await host.insertNodeAt(graphId, rec.sourceId, len, s.text, {
          skipRelink: true,
          role: s.role,
          triggeredBy: 'bundled-demo:ingest',
          singleNode: true,
        });
      }
      // Wire SOP edges — sequence + goals are the two consistently useful
      // ones at import time. The richer linkers (loops, branches, calls,
      // ctx) are run lazily by the App when the user opens the skill in
      // the Trained Output editor; running them here would add latency to
      // the first-unlock path with no immediate user-visible payoff.
      await linkSkillSequence(host, graphId, rec.sourceId);
      await linkSkillGoals(host, graphId, rec.sourceId);

      result.skillsIngested++;
    }
  }

  // Single coalesced relink at the end so the new sources can find their
  // cross-source entity overlaps in one pass instead of N.
  if (result.skillsIngested > 0) {
    host.triggerRelink(graphId);
  }
  return result;
}
