/**
 * Graphnosis domain glossary for Ghampus LLM prompts — prevents wrong acronym hallucinations.
 */

import {
  stripInternalRecallWireFormat,
  stripLeakedSourceRefsFromUserText,
} from './ghampus-recall-format.js';

/** When the user asks about Ghampus / "who are you" — always I/me/my, never third person. */
export const GHAMPUS_FIRST_PERSON_SELF_RULE = `
SELF-REFERENCE — you ARE Ghampus. When describing yourself, your role, or your capabilities:
- Always use first person: I, me, my — never "Ghampus is…", "Ghampus provides…", or "It runs…".
- Example: "I'm Graphnosis's built-in local assistant…" — NOT "Ghampus is the Graphnosis built-in assistant…".
- Third person is fine only when referring to Graphnosis the product, UI labels, or features outside yourself.`;

/** Shared glossary block for classify, synthesis, polish, and verify prompts. */
export const GHAMPUS_DOMAIN_GLOSSARY_BLOCK = `
GRAPHNOSIS DOMAIN GLOSSARY — use these terms exactly; never invent acronym expansions:
- MCP = Model Context Protocol (tool-server protocol for recall, remember, dig_deeper, etc.). NEVER "Master Certified Professional" or any other expansion.
- Ghampus = Graphnosis's built-in local agent (you — speak as "I", not "Ghampus").
- Engram = an encrypted knowledge-graph partition (a named memory collection).
- Cortex = the user's full encrypted Graphnosis memory store on their device.
- Recall = semantic search over saved memories (MCP tool recall).
- dig_deeper = MCP tool to expand a recall hit with linked context.
- Sidecar = the local Graphnosis background process that hosts MCP and Ghampus.
- Attested memory = a fact saved explicitly by the user (not inferred/GNN overlay).

Do NOT expand acronyms unless the expansion appears verbatim in recall/cortex data. Use Graphnosis terms as-is.
${GHAMPUS_FIRST_PERSON_SELF_RULE}`;

/** Known wrong acronym expansions local LLMs invent — case-insensitive patterns. */
export const HALLUCINATED_ACRONYM_PATTERNS: RegExp[] = [
  /Master Certified Professional/i,
  /Management Certification Program/i,
  /Microsoft Certified Professional/i,
];

/** True when text contains a known wrong MCP (or related) acronym expansion. */
export function isHallucinatedAcronym(text: string): boolean {
  return HALLUCINATED_ACRONYM_PATTERNS.some((re) => re.test(text));
}

const MCP_WRONG_EXPANSION_RE = /\bMCP\s*\(\s*Master Certified Professional\s*\)/gi;
const WRONG_MCP_PHRASE_RE = /Master Certified Professional/gi;

/** Internal LLM prompt wrappers that must never appear in user-facing output. */
const LEAKED_PROMPT_TAG_RES: RegExp[] = [
  /<recent_chat>[\s\S]*?<\/recent_chat>/gi,
  /<cortex_data>[\s\S]*?<\/cortex_data>/gi,
  /<\/?recent_chat>/gi,
  /<\/?cortex_data>/gi,
  /<\/?conversation_transcript>/gi,
];

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

/** Unicode emoji + Graphnosis skill/UI symbol glyphs — never shown in chat bubbles. */
const DISPLAY_EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}⚡🔑✓✕⚠️💡🔁ℹ️◆▹✗▪]/gu;

const HTML_COLOR_SPAN_RE = /<span\b[^>]*\b(?:color|background(?:-color)?)\s*[:=][^>]*>([\s\S]*?)<\/span>/gi;
const HTML_FONT_COLOR_RE = /<font\b[^>]*\bcolor\s*=\s*[^>]*>([\s\S]*?)<\/font>/gi;
const HTML_STYLE_COLOR_SPAN_RE = /<span\b[^>]*style\s*=\s*["'][^"']*(?:color|background)[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;

const LEGACY_SKILL_SECTION_RES: Array<{ re: RegExp; heading: string }> = [
  { re: /^CONSTRAINTS:\s*$/gim, heading: '## Goals' },
  { re: /^## Constraints\s*$/gim, heading: '## Goals' },
  { re: /^PROCEDURE(?:\s*\([^)]*\))?:\s*$/gim, heading: '## Procedure' },
  { re: /^GOALS:\s*$/gim, heading: '## Goals' },
];

/** Internal skill-walk / dispatch markers that must never appear in chat replies. */
const SKILL_INTERNAL_MARKER_RES: RegExp[] = [
  /@loop(?:\s*:\s*\d+|\s+max=\d+)/gi,
  /\[(?:verify|dispatch-safe|requires|produces):\s*[^\]]+\]/gi,
  /^\s*[◆▹✗✓⚡]\s*(?:Prerequisites|Trigger|Produces|Success|Out of scope):.*$/gim,
  /^\s*PROOF RULE:.*$/gim,
  /^\s*ENGRAM MAP\b.*$/gim,
  /^\s*walk_skill_structured\b.*$/gim,
  /^\s*\[gll[·\s][^\]]+\]\s*$/gim,
  /^\s*\[gnn[·\s][^\]]+\]\s*$/gim,
];

function stripSkillInternalMarkers(text: string): string {
  let out = text;
  for (const re of SKILL_INTERNAL_MARKER_RES) {
    out = out.replace(re, '');
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Internal grounding vocabulary ("attested memory", "Cortex Data" as a
 * capitalized noun) is meant for the system prompt / <cortex_data> block,
 * never for the user-facing answer — it reads like the app is asking the
 * user to trust-but-verify, when in fact it's just internal jargon leaking
 * through paraphrase (not caught by the literal <cortex_data> tag strip
 * above, since the model rephrases the section header instead of copying it
 * verbatim). Strips heading lines and trailing "Note" disclaimers that cite
 * this vocabulary; leaves the actual content (e.g. the todo bullets) intact.
 */
const GROUNDING_VOCAB_RE = /\battested memor(?:y|ies)\b|\bcortex data\b/i;

function stripAttestedMemoryDisclaimers(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Heading line naming the internal vocabulary ("#### From Cortex Data
    // (attested memory)") — drop the heading, keep whatever follows.
    if (/^#{1,6}\s+/.test(line) && GROUNDING_VOCAB_RE.test(line)) {
      continue;
    }
    // Bare "Note"/"**Note**" heading whose very next non-blank line cites the
    // vocabulary — drop the heading and that explanatory line together.
    if (/^\*{0,2}Note\*{0,2}:?\s*$/i.test(line.trim())) {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === '') j++;
      if (j < lines.length && GROUNDING_VOCAB_RE.test(lines[j]!)) {
        i = j;
        continue;
      }
    }
    // Inline sentence citing the vocabulary as its own justification (not
    // heading-shaped) — drop the whole line rather than leave a fragment.
    if (GROUNDING_VOCAB_RE.test(line) && /\bextracted from\b|\bfrom your\b|\bbased on\b/i.test(line)) {
      continue;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

type CodePlaceholder = { token: string; value: string };

/** Preserve fenced and inline code while transforming surrounding prose. */
function withCodePreserved(text: string, transform: (plain: string) => string): string {
  const placeholders: CodePlaceholder[] = [];
  let i = 0;
  const stash = (match: string): string => {
    const token = `\x00GH_CODE_${i++}\x00`;
    placeholders.push({ token, value: match });
    return token;
  };
  let out = text.replace(CODE_FENCE_RE, stash);
  out = out.replace(INLINE_CODE_RE, stash);
  out = transform(out);
  for (const { token, value } of placeholders) {
    out = out.split(token).join(value);
  }
  return out;
}

function stripDisplayEmoji(text: string): string {
  return withCodePreserved(text, (plain) => plain.replace(DISPLAY_EMOJI_RE, '').replace(/  +/g, ' '));
}

function stripHtmlColorMarkup(text: string): string {
  let out = text;
  for (const re of [HTML_COLOR_SPAN_RE, HTML_FONT_COLOR_RE, HTML_STYLE_COLOR_SPAN_RE]) {
    out = out.replace(re, '$1');
  }
  return out;
}

function normalizeLegacySkillSectionHeaders(text: string): string {
  let out = text;
  for (const { re, heading } of LEGACY_SKILL_SECTION_RES) {
    out = out.replace(re, heading);
  }
  return out;
}

/** Normalize list markers so the markdown renderer picks them up consistently. */
function normalizeBulletLines(text: string): string {
  return text.split('\n').map((line) => {
    const trimmed = line.trimStart();
    const indent = line.slice(0, line.length - trimmed.length);
    if (/^#{1,6}\s/.test(trimmed)) return line;
    if (/^```/.test(trimmed)) return line;
    if (/^\d+\.\s+/.test(trimmed)) return line;
    if (/^[-*•]\s+/.test(trimmed)) {
      const body = trimmed.replace(/^[-*•]\s+/, '');
      return `${indent}- ${body}`;
    }
    return line;
  }).join('\n');
}

function collapseExcessiveBlankLines(text: string, maxConsecutive = 2): string {
  const limit = maxConsecutive + 1;
  return text.replace(new RegExp(`\\n{${limit},}`, 'g'), '\n'.repeat(maxConsecutive)).trim();
}

/**
 * Deterministic readability pass for all Ghampus chat answers.
 * Safe to run after LLM polish — preserves code blocks and inline code.
 */
export function formatGhampusReadableMarkdown(text: string): string {
  let out = text;
  out = stripHtmlColorMarkup(out);
  out = normalizeLegacySkillSectionHeaders(out);
  out = normalizeBulletLines(out);
  out = stripDisplayEmoji(out);
  out = collapseExcessiveBlankLines(out);
  return out;
}

/**
 * Post-pass fix for obvious wrong MCP expansions before UI display.
 * Deterministic safety net when polish/verify still slip.
 */
export function sanitizeGhampusResponse(text: string): string {
  let out = text;
  for (const re of LEAKED_PROMPT_TAG_RES) {
    out = out.replace(re, '');
  }
  out = out.replace(MCP_WRONG_EXPANSION_RE, 'MCP (Model Context Protocol)');
  out = out.replace(WRONG_MCP_PHRASE_RE, 'Model Context Protocol');
  out = stripSkillInternalMarkers(out);
  out = stripAttestedMemoryDisclaimers(out);
  out = stripLeakedSourceRefsFromUserText(out);
  out = stripInternalRecallWireFormat(out);
  out = formatGhampusReadableMarkdown(out);
  return out;
}
