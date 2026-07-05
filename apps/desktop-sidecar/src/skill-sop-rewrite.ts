/**
 * SOP-preserving skill rewrite — prompt + validation helpers.
 *
 * Used when `useLlmRewrite=true` on skill training. The LLM may polish prose
 * and clarify steps, but must not drop or rephrase Graphnosis skill DSL tokens
 * (@skill:, @loop:, goal headers, etc.).
 */

/** Lines prefixed with [ANCHOR] must survive rewrite byte-for-byte. */
const ANCHOR_LINE_RE = /^\[ANCHOR\]/;

/** Structured tokens whose presence is checked after rewrite. */
const SOP_TOKEN_PATTERNS: RegExp[] = [
  /@skill:\s*[^\n]+/gi,
  /@loop:\s*\d+(?:\s+max=\d+)?/gi,
  /@branch:\s*\d+/gi,
  /@parallel:\s*\[[^\]]*\]/gi,
  // Per-step model-routing tag (e.g. "@needs: reasoning, structured-output").
  // Parsed by deriveStepsFromText (model-router.ts NEEDS_PATTERN); dropping it
  // silently changes which model a step routes to. Matched tightly to the
  // capability list so it does not swallow trailing prose.
  /@needs?:\s*[a-z][a-z-]*(?:\s*,\s*[a-z][a-z-]*)*/gi,
  // Recall/privacy binding (e.g. only_engrams=["coding"] or only_engrams: [...]).
  // Dropping it changes which engrams a recall step reads — a correctness and
  // privacy regression. Accept both '=' and ':' forms.
  /only_engrams\s*[:=]\s*\[[^\]]*\]/gi,
  /\[\[skill:[^\]]+\]\]/gi,
  /\[\[loop:[^\]]+\]\]/gi,
  /\[\[branch:[^\]]+\]\]/gi,
  /^Success:\s.+$/gim,
  /^Out of scope:\s.+$/gim,
  /^On completion:\s.+$/gim,
  /^Trigger:\s.+$/gim,
  /^Prerequisites:\s.+$/gim,
  /^On failure:\s.+$/gim,
  /^Requires:\s.+$/gim,
  /^Produces:\s.+$/gim,
];

export interface SopPreservationSnapshot {
  anchors: string[];
  tokens: string[];
}

/** Collect SOP markers from skill source text (normalized for comparison). */
export function extractSopPreservationSnapshot(text: string): SopPreservationSnapshot {
  const anchors: string[] = [];
  for (const line of text.split('\n')) {
    if (ANCHOR_LINE_RE.test(line.trim())) anchors.push(line.trim());
  }
  const tokens: string[] = [];
  for (const re of SOP_TOKEN_PATTERNS) {
    const flags = re.flags;
    const globalRe = new RegExp(re.source, flags.includes('g') ? flags : `${flags}g`);
    for (const m of text.matchAll(globalRe)) {
      if (m[0]) tokens.push(normalizeSopToken(m[0]));
    }
  }
  return { anchors, tokens: [...new Set(tokens)] };
}

function normalizeSopToken(token: string): string {
  return token.replace(/\s+/g, ' ').trim();
}

export interface SopPreservationResult {
  ok: boolean;
  /** Markers present in original but missing from rewrite. */
  missing: string[];
}

/** True when every anchor line and DSL token from `original` appears in `rewritten`. */
export function validateSopPreservation(original: string, rewritten: string): SopPreservationResult {
  const snap = extractSopPreservationSnapshot(original);
  const missing: string[] = [];
  for (const anchor of snap.anchors) {
    if (!rewritten.includes(anchor)) missing.push(anchor);
  }
  const rewrittenNorm = rewritten.replace(/\s+/g, ' ');
  for (const token of snap.tokens) {
    if (!rewrittenNorm.includes(token.replace(/\s+/g, ' '))) missing.push(token);
  }
  return { ok: missing.length === 0, missing };
}

export const SKILL_SOP_REWRITE_SYSTEM_PROMPT = `\
You are a Graphnosis skill editor. Rewrite the user's skill instruction to be clearer \
and more actionable while preserving its executable structure.

Hard rules — violating any rule makes the output unusable:
1. Do NOT add personal memories, user-specific facts, or "(from memory: …)" markers. \
   You only see the skill text — no cortex recall.
2. Preserve every line that starts with [ANCHOR] exactly as-is (same characters, same position relative to neighbors).
3. Preserve every structured token exactly — same spelling, punctuation, and arguments:
   - @skill: … (including args and -> $capture)
   - @loop: N and optional max=M
   - @branch: N
   - @parallel: [ … ] and optional -> [ … ]
   - @needs: <capabilities> — the per-step model-routing tag (preserve verbatim)
   - only_engrams=[ … ] / only_engrams: [ … ] — recall/privacy bindings (preserve verbatim)
   - Goal headers: Success:, Out of scope:, On completion:, Trigger:, Prerequisites:, \
     On failure:, Requires:, Produces:
   - Wiki-style [[skill:…]], [[loop:…]], [[branch:…]] if present
4. Keep numbered/bulleted step order unless merging two adjacent vague lines — never reorder steps that contain DSL tokens.
5. You may improve surrounding prose, fix typos, and tighten wording around preserved tokens.
6. Do not invent new @skill: / @loop: references that were not in the original.

After the rewritten skill, emit exactly this separator on its own line:
=== DIFF NOTES ===
Then list one bullet per substantive edit (clarity, typo, reorder of non-DSL prose only). \
If you made no changes, say so in one bullet.`;

export function buildSopRewriteUserPrompt(
  skill: string,
  skillName?: string,
  modelTarget?: string,
  goals?: import('./gsk-format.js').SkillGoals,
): string {
  const lines: string[] = [];
  if (skillName) lines.push(`Skill name: ${skillName}`);
  if (modelTarget) lines.push(`Target AI client: ${modelTarget}`);
  if (goals) {
    lines.push('');
    lines.push('=== AUTHOR-STATED GOALS (preserve as goal header lines) ===');
    if (goals.successLooksLike) lines.push(`Success looks like: ${goals.successLooksLike}`);
    if (goals.outOfScope) lines.push(`Out of scope: ${goals.outOfScope}`);
    if (goals.expectedOnCompletion) lines.push(`Expected on completion: ${goals.expectedOnCompletion}`);
    if (goals.trigger) lines.push(`Trigger: ${goals.trigger}`);
    if (goals.prerequisites) lines.push(`Prerequisites: ${goals.prerequisites}`);
    if (goals.onFailure) lines.push(`On failure: ${goals.onFailure}`);
    if (goals.requires) lines.push(`Requires: ${goals.requires}`);
    if (goals.produces) lines.push(`Produces: ${goals.produces}`);
  }
  lines.push('');
  lines.push('=== SKILL TO REWRITE ===');
  lines.push(skill);
  lines.push('');
  lines.push(
    'Rewrite for clarity while preserving every SOP/DSL token listed in the system rules. ' +
    'Do not personalize from memory.',
  );
  return lines.join('\n');
}
