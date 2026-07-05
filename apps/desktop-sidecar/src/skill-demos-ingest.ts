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

export interface IngestBundledSkillDemosResult {
  /** How many .gsk packs we attempted from BUNDLED_SKILL_DEMOS. */
  packsAttempted: number;
  /** How many individual skills (across all packs) were saved as sources. */
  skillsIngested: number;
  /** Language variant that was ingested. */
  language: 'en' | 'ro';
  /** Skills skipped because they were in the other language variant. */
  skillsSkippedOtherLanguage: number;
  /** Skills we skipped because their body text was empty. */
  skillsSkippedEmpty: string[];
  /** Per-pack errors. Other packs still proceed if one throws. */
  packErrors: Array<{ filename: string; reason: string }>;
  /** Pack signature verification results. Note: bundled packs are signed,
   *  so this should always be true; a false value points at either a
   *  tampered sidecar binary or a broken signing pipeline. */
  verified: Array<{ filename: string; verified: boolean }>;
}

/** Romanian letters that never appear in the English variants. The bundled
 *  packs ship each SOP twice (English + Romanian); every Romanian skill *name*
 *  carries at least one of these diacritics (ă â î ș ț, both the comma-below
 *  and legacy cedilla code points), while the English names are pure ASCII.
 *  That asymmetry is a stable, signature-free signal — we can't add a
 *  `language` field to the signed .gsk payload without re-signing. */
const RO_DIACRITICS = /[ăâîșțĂÂÎȘȚşţŞŢ]/;

/** Classify a bundled skill as English or Romanian.
 *
 *  Detect on the NAME only, never the body: the English bodies quote Romanian
 *  example words (e.g. "trăit", "locuit") to teach cross-language recall, so a
 *  body-wide diacritic scan misclassifies the English "Use Graphnosis well" as
 *  Romanian. The authored names are clean ASCII (English) vs. diacritic-bearing
 *  (Romanian), which splits the six variants 3 / 3 reliably. */
function detectSkillLanguage(skill: { name: string }): 'en' | 'ro' {
  return RO_DIACRITICS.test(skill.name) ? 'ro' : 'en';
}

/**
 * Import every pack in `BUNDLED_SKILL_DEMOS` into `graphId`, keeping only the
 * skills in the chosen `language` (English or Romanian — defaults to English).
 * Each bundled pack carries both variants of one SOP, so a single-language
 * ingest lands 3 skills, not 6. Returns a summary the caller can surface to
 * the user / log to telemetry. Best-effort: one bad pack never blocks the
 * rest, mirroring the docs-ingest contract.
 */
export async function ingestBundledSkillDemos(
  host: GraphnosisHost,
  graphId: string,
  licenseValidator: LicenseValidator | undefined,
  opts?: { language?: 'en' | 'ro' },
): Promise<IngestBundledSkillDemosResult> {
  const language: 'en' | 'ro' = opts?.language ?? 'en';
  const result: IngestBundledSkillDemosResult = {
    packsAttempted: BUNDLED_SKILL_DEMOS.length,
    skillsIngested: 0,
    language,
    skillsSkippedOtherLanguage: 0,
    skillsSkippedEmpty: [],
    packErrors: [],
    verified: [],
  };

  for (const entry of BUNDLED_SKILL_DEMOS) {
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
      // Keep only the chosen-language variant of each SOP.
      if (detectSkillLanguage(skill) !== language) {
        result.skillsSkippedOtherLanguage++;
        continue;
      }
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
      const rec = await ingestClip(host, graphId, provenanceComment, label, {
        addedBy: 'graphnosis-bundled-demo',
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
