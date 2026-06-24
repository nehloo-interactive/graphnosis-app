/**
 * Pre-display answer finalization — polish gate + LLM rewrite before Ghampus UI.
 *
 * Hybrid of:
 *  A) finalizeGhampusAnswer — low-temp LLM polish pass against original question
 *  B) needsAnswerPolish / isRawRecallDump — gate raw recall dumps & audit patterns
 *  C) Deterministic formatters skip polish when output is already clean (see ipc emitGhampusResponse)
 */

import type { GhampusQueryHints } from './ghampus-intent.js';
import {
  GHAMPUS_DOMAIN_GLOSSARY_BLOCK,
  isHallucinatedAcronym,
  sanitizeGhampusResponse,
} from './ghampus-glossary.js';
import {
  detectLikelyHallucination,
  formatGroundingVerifyFeedback,
  GHAMPUS_GROUNDING_RULES_BLOCK,
} from './ghampus-grounding.js';
import { isHowToQuestionText, wantsBriefAnswerText, matchResponseLanguageInstruction, buildRomanianContentRulesBlock, buildResponseLanguageRulesBlock, answerLanguageMismatchUserQuery, shouldDefaultBriefAnswer } from './ghampus-language.js';
import {
  looksLikeSubgraphDump,
  stripRecallAuditTrail,
} from './ghampus-recall-format.js';
import type { LocalLlm } from './correction.js';

export type AnswerPolishSource = 'formatter' | 'slash' | 'synthesis' | 'fallback';

export type FinalizeAnswerHints = {
  skipPolish?: boolean;
  polishSource?: AnswerPolishSource;
  queryHints?: GhampusQueryHints;
  /** Attested recall sections — used to verify answers stay grounded. */
  recallContext?: string;
};

const RAW_DUMP_HEADER_RE = /^Found \*\*\d+\*\* matching memor/i;
const REASON_PREFIX_RE = /^(?:I couldn't synthesize|I couldn't verify|Here's what I found|I couldn't produce)/i;
const POLISH_TEMPERATURE = 0.2;

export function wantsBriefAnswer(userText: string): boolean {
  return wantsBriefAnswerText(userText);
}

/** How-to / setup question — default to moderate brevity even without "be brief". */
export function isHowToQuestion(userText: string): boolean {
  return isHowToQuestionText(userText);
}

function countTopLevelBullets(text: string): number {
  return (text.match(/^[-*•]\s+/gm) ?? []).length;
}

/** Skill procedure dumps, code fences, pricing tables — not direct answers. */
export function hasAnswerDumpPatterns(draft: string): boolean {
  if (/Here's what I found:/i.test(draft)) return true;
  if (/Found \*\*\d+\*\* matching/i.test(draft)) return true;
  if (/skill:\d+/i.test(draft)) return true;
  if (/src:skill:/i.test(draft)) return true;
  if (/```/.test(draft)) return true;
  if (/^Step \d+:/im.test(draft)) return true;
  if (/\b(?:enterprise-sales-prep|deployment-platform-ops|skill-dispatch)\b/i.test(draft)) return true;
  if (/\$\d+(?:\/mo|\/month| per )/i.test(draft)) return true;
  if (/\b(?:pricing tier|Starter|Pro tier|Enterprise tier)\b/i.test(draft)) return true;
  return false;
}

/** True when text still looks like an MCP/recall dump — must not reach users. */
export function isRawRecallDump(draft: string): boolean {
  const t = draft.trim();
  if (!t) return false;
  if (/^⚠️\s*GRAPHNOSIS CONSENT (?:NEEDED|REQUIRED)/i.test(t)) return true;
  if (looksLikeSubgraphDump(t)) return true;
  if (RAW_DUMP_HEADER_RE.test(t)) return true;
  if (/^Attached \d+ memory node\(s\)/m.test(t)) return true;
  if (/Per-graph \(tier · nodes · tokens\)/.test(t)) return true;
  if (/\(from attested memory\)/i.test(t)) return true;
  if (/_\s*\(from [^)]+\)\s*_/i.test(t)) return true;
  if (/^\[from [^\]]+\]/im.test(t)) return true;
  if (/^## Recall hits \(structured\)/m.test(t)) return true;
  if (/^#{1,3}\s+(?:Attested Memory|dig_deeper|Recent Chat)/im.test(t)) return true;
  if (/Source-filename expansion|Cross-engram entity hop/i.test(t)) return true;
  if (/\bavg\.?\s*score\b/i.test(t) && /\d+\s+node/i.test(t)) return true;
  if (/via dig_deeper \(multi-strategy\)/i.test(t)) return true;

  const body = REASON_PREFIX_RE.test(t)
    ? t.replace(REASON_PREFIX_RE, '').replace(/^[:\s-]+/, '').trim()
    : t;
  if (body !== t && isRawRecallDump(body)) return true;

  const bullets = body.match(/^[-*•]\s+/gm) ?? [];
  const hasHeadings = /^#{1,3}\s+\S/m.test(body);
  if (bullets.length > 5 && !hasHeadings && RAW_DUMP_HEADER_RE.test(body) === false) {
    const longBullets = bullets.filter((_, i) => {
      const lines = body.split('\n');
      const line = lines.find((l) => l.match(/^[-*•]\s+/));
      return (line?.length ?? 0) > 120;
    });
    if (longBullets.length >= 3 || bullets.length > 8) return true;
  }

  return false;
}

/** @deprecated alias — use needsAnswerPolish */
export function shouldPolishAnswer(draft: string, hints?: FinalizeAnswerHints): boolean {
  return needsAnswerPolish('', draft, hints);
}

function isShortDeterministicFormatterOutput(draft: string, hints?: FinalizeAnswerHints): boolean {
  const trimmed = draft.trim();
  if (!trimmed || trimmed.length > 800) return false;
  if (isRawRecallDump(trimmed)) return false;
  if (hasAnswerDumpPatterns(trimmed)) return false;

  const qh = hints?.queryHints;
  if (qh?.wantsPersonRole && /^\*\*[^*]+\*\*\s*[—–-]\s*.+$/m.test(trimmed) && trimmed.split('\n').length <= 4) {
    return true;
  }
  if (qh?.wantsSkillList && /^\*\*.*skills?\b.*\*\*/i.test(trimmed)) {
    return true;
  }
  if (qh?.wantsMcpToolList && /^\*\*.*MCP tools?\b.*\*\*/i.test(trimmed)) {
    return true;
  }
  if (qh?.wantsTeamRoster && /^#{1,2}\s+Team\b/im.test(trimmed)) {
    return true;
  }
  if (qh?.wantsProjectTaskList && /^#{1,2}\s+Tasks\b/im.test(trimmed) && !RAW_DUMP_HEADER_RE.test(trimmed)) {
    return true;
  }
  if (/^\*\*[^*]+\*\*\s*[—–-]\s*.+$/m.test(trimmed) && trimmed.length < 200) {
    return true;
  }
  return false;
}

function alreadyCleanHowToAnswer(userText: string, draft: string): boolean {
  if (!isHowToQuestion(userText)) return false;
  const t = draft.trim();
  if (!t || t.length > 1400) return false;
  if (hasAnswerDumpPatterns(t)) return false;
  if (isRawRecallDump(t)) return false;
  const bullets = countTopLevelBullets(t);
  return bullets > 0 && bullets <= 6;
}

/** Gate: polish when draft looks like a raw dump or failed formatter output. */
export function needsAnswerPolish(
  userText: string,
  draft: string,
  hints?: FinalizeAnswerHints,
): boolean {
  if (hints?.skipPolish || hints?.polishSource === 'slash') return false;
  if (!draft?.trim()) return false;

  if (hints?.polishSource === 'formatter' && isShortDeterministicFormatterOutput(draft, hints)) {
    if (answerLanguageMismatchUserQuery(userText, draft)) return true;
    return false;
  }

  if (isRawRecallDump(draft)) return true;
  if (hasAnswerDumpPatterns(draft)) return true;

  const qh = hints?.queryHints;
  if (qh?.wantsExhaustive) {
    // Exhaustive lists intentionally long — only polish obvious dumps.
    if (isRawRecallDump(draft) || hasAnswerDumpPatterns(draft)) return true;
    return false;
  }

  if (countTopLevelBullets(draft) > 4 && hints?.polishSource !== 'formatter') return true;

  if (qh?.wantsProjectTaskList && RAW_DUMP_HEADER_RE.test(draft)) return true;

  const src = hints?.polishSource;
  if (src === 'fallback' || src === 'synthesis') {
    const stripped = stripRecallAuditTrail(draft);
    if (isRawRecallDump(stripped)) return true;
    if (hasAnswerDumpPatterns(stripped)) return true;
    if (isHowToQuestion(userText) && !alreadyCleanHowToAnswer(userText, stripped)) return true;
  }

  if (isHowToQuestion(userText) && src === 'synthesis' && !alreadyCleanHowToAnswer(userText, draft)) {
    return true;
  }

  if (src === 'synthesis') {
    const hall = detectLikelyHallucination(draft, hints?.recallContext ?? '');
    if (hall.likely) return true;

    if (shouldDefaultBriefAnswer(userText, qh)) {
      const t = draft.trim();
      if (/^#{1,3}\s+\S/m.test(t)) return true;
      if (/## (?:Attested Memory|dig_deeper|Recent Chat|Recall hits)/i.test(t)) return true;
      if (countTopLevelBullets(t) > 2 && !isHowToQuestion(userText)) return true;
      if (t.length > 700 && !isHowToQuestion(userText) && !qh?.wantsProjectTaskList) return true;
    }
  }

  if (answerLanguageMismatchUserQuery(userText, draft)) return true;

  return false;
}

const POLISH_MAX_CHARS = 6000;

function buildPolishSystem(userText: string, hints?: FinalizeAnswerHints): string {
  const qh = hints?.queryHints;
  const brief = shouldDefaultBriefAnswer(userText, qh);
  const howTo = isHowToQuestion(userText);
  const maxBullets = brief ? (howTo ? 6 : 2) : (howTo ? 6 : 8);
  const langRule = matchResponseLanguageInstruction(userText);
  const langBlock = buildResponseLanguageRulesBlock(userText);
  const roRules = buildRomanianContentRulesBlock(userText);

  const brevityRule = brief
    ? '- Default brevity: 1-3 sentences for simple questions; no section headers unless the user asked for a list or grouped format.'
    : '- The user asked for detail — organize with bullets or short sections as helpful.';

  const structureRule = brief
    ? '- Structure: one lead sentence, then at most 2 short bullets if needed — no ## headers for simple questions.'
    : '- Structure: one lead sentence that answers directly, then ## or ### section headers with bullet lists where helpful.';

  return `You are Ghampus inside Graphnosis. The user asked a question and a draft answer was prepared from memory tools.

Rewrite the draft as a direct answer to the user's question. Rules:
- Answer ONLY the question — do NOT repeat or echo the question.
${brevityRule}
${structureRule}
- Use markdown: ## / ### headers for sections, "- " bullet lists, short paragraphs with blank lines between sections.
- No emoji, emoticons, or decorative symbols (⚡ ✓ ⚠️ etc.) — plain text only.
- No colored text, HTML spans, or font tags — markdown bold only when emphasis helps scanning.
- Do NOT include audit footers, "Found N matching memories", "Here's what I found", or "_(from …)_" citations.
- Do NOT echo internal recall wire format: "## Attested Memory", "## dig_deeper", "## Recent Chat", node counts, avg scores, "Source-filename expansion", or "Cross-engram entity hop".
- Do NOT dump raw memory bullets, skill procedure text (Step 1:, Step 2:), or unrelated skill SOPs.
- Do NOT include pricing tiers or sales prep unless the user asked about pricing or sales.
- Do NOT include code blocks unless the user asked for code or configuration examples directly relevant to their question.
- Synthesize only facts relevant to the question from the draft — never invent names, dates, steps, or English translations of titles.
- When recall is thin, say what is missing — do not pad with guessed translations or invented titles.
- Preserve person names exactly as in the draft/recall — never merge spellings or blend OCR-corrupted variants.
- Use markdown bullet lists (max ${maxBullets} bullets${howTo && brief ? ' for how-to/setup' : ''}) or short prose.
- Remove duplicate or nested bullets; one level only.
- ${langRule}
${langBlock}
${roRules ? `\n${roRules}` : ''}

${GHAMPUS_DOMAIN_GLOSSARY_BLOCK}
${GHAMPUS_GROUNDING_RULES_BLOCK}`;
}

export type FinalizeTraceEvent =
  | string
  | {
      label: string;
      status?: 'running' | 'ok';
      /** Stable key — running/ok with the same key updates one trace row. */
      stepKey: string;
    };

export type FinalizeGhampusAnswerOpts = FinalizeAnswerHints & {
  emitTrace?: (event: FinalizeTraceEvent) => void;
  /** When set, forces a polish pass even if the draft already looks clean. */
  forcePolish?: boolean;
  /** Critic feedback from a prior verify pass — injected into the polish prompt. */
  verifyFeedback?: string;
  /** 1-based polish iteration — used for trace labels on re-polish. */
  polishPass?: number;
};

export type VerifyAnswerResult = {
  answersQuestion: boolean;
  isDumpOrNoise: boolean;
  tooLong: boolean;
  isHallucinatedAcronym?: boolean;
  inventsFactsNotInContext?: boolean;
  wrongLanguage?: boolean;
  feedback: string;
  suggestedFocus: string;
};

export const VERIFY_MAX_ITERATIONS = 2;

export type FinalizeWithVerificationOpts = FinalizeGhampusAnswerOpts & {
  maxIterations?: number;
  /** When true, skip the critic verify loop (single polish only). */
  skipVerification?: boolean;
};

/** Skip verify loop for deterministic short formatters and already-clean drafts. */
export function shouldSkipVerification(
  _userText: string,
  draft: string,
  hints?: FinalizeAnswerHints,
): boolean {
  const trimmed = draft.trim();
  if (!trimmed) return true;

  // Synthesis answers always go through grounding verify — short drafts can still hallucinate.
  if (hints?.polishSource === 'synthesis') return false;

  if (hints?.polishSource === 'formatter' && isShortDeterministicFormatterOutput(trimmed, hints)) {
    if (answerLanguageMismatchUserQuery(_userText, trimmed)) return false;
    return true;
  }

  const qh = hints?.queryHints;
  if (qh?.wantsSkillList && trimmed.length < 500) return true;

  if (trimmed.length < 400 && !hasAnswerDumpPatterns(trimmed) && !isRawRecallDump(trimmed)) {
    return true;
  }

  return false;
}

/** Parse critic JSON from LLM output — tolerates fenced code blocks. */
export function parseVerifyAnswerJson(raw: string): VerifyAnswerResult | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let jsonText = trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) jsonText = fence[1].trim();
  else {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) jsonText = trimmed.slice(start, end + 1);
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const result: VerifyAnswerResult = {
      answersQuestion: Boolean(parsed.answersQuestion),
      isDumpOrNoise: Boolean(parsed.isDumpOrNoise),
      tooLong: Boolean(parsed.tooLong),
      feedback: String(parsed.feedback ?? '').trim(),
      suggestedFocus: String(parsed.suggestedFocus ?? '').trim(),
    };
    if (parsed.isHallucinatedAcronym !== undefined) {
      result.isHallucinatedAcronym = Boolean(parsed.isHallucinatedAcronym);
    }
    if (parsed.inventsFactsNotInContext !== undefined) {
      result.inventsFactsNotInContext = Boolean(parsed.inventsFactsNotInContext);
    }
    if (parsed.wrongLanguage !== undefined) {
      result.wrongLanguage = Boolean(parsed.wrongLanguage);
    }
    return result;
  } catch {
    return null;
  }
}

/** True when the critic accepts the polished answer. */
export function isVerifyResultOk(result: VerifyAnswerResult): boolean {
  return result.answersQuestion
    && !result.isDumpOrNoise
    && !result.tooLong
    && !result.isHallucinatedAcronym
    && !result.inventsFactsNotInContext
    && !result.wrongLanguage;
}

/** Whether another polish iteration should run after a failed verify. */
export function wouldContinueVerifyLoop(
  iteration: number,
  maxIterations: number,
  verify: VerifyAnswerResult | null,
): boolean {
  if (verify === null) return false;
  if (isVerifyResultOk(verify)) return false;
  return iteration + 1 < maxIterations;
}

export function formatVerifyFeedback(result: VerifyAnswerResult, userText?: string, hints?: FinalizeAnswerHints): string {
  const parts: string[] = [];
  if (result.feedback) parts.push(result.feedback);
  if (result.suggestedFocus) parts.push(`Focus on: ${result.suggestedFocus}`);
  if (!result.answersQuestion) parts.push('The answer must directly address the user\'s question.');
  if (result.isDumpOrNoise) parts.push('Remove skill dumps, pricing tiers, and unrelated memory bullets.');
  if (result.tooLong) {
    const brief = userText ? shouldDefaultBriefAnswer(userText, hints?.queryHints) : true;
    parts.push(brief
      ? 'Shorten to 1-3 sentences with no section headers — name the person/role directly.'
      : 'Shorten to at most 6 bullets for how-to answers.');
  }
  if (result.isHallucinatedAcronym) {
    parts.push('Wrong acronym expansion — MCP means Model Context Protocol in Graphnosis, not Master Certified Professional.');
  }
  if (result.inventsFactsNotInContext) {
    parts.push('Remove anything not supported by the recall context below — no invented dates, milestones, features, or setup steps.');
  }
  if (result.wrongLanguage) {
    parts.push(userText
      ? `Rewrite in ${matchResponseLanguageInstruction(userText).replace(/\.$/, '')} — translate recall content; do not echo foreign-language prose from memory.`
      : 'Rewrite in the same language as the user\'s question — translate recall content as needed.');
  }
  return parts.join(' ');
}

function buildPolishUser(
  userText: string,
  draft: string,
  verifyFeedback?: string,
  recallContext?: string,
): string {
  let user = `User question:\n${userText}\n\nDraft answer (from memory tools):\n${draft.slice(0, POLISH_MAX_CHARS)}`;
  if (recallContext?.trim()) {
    user += `\n\nRecall context (ONLY facts from here may appear in the answer):\n${recallContext.slice(0, POLISH_MAX_CHARS)}`;
  }
  if (verifyFeedback?.trim()) {
    user += `\n\nPrevious attempt feedback (fix these issues):\n${verifyFeedback.trim()}`;
  }
  return user;
}

function buildVerifySystem(userText: string, hints?: FinalizeAnswerHints): string {
  const brief = shouldDefaultBriefAnswer(userText, hints?.queryHints);
  const tooLongRule = brief
    ? `- tooLong: true if the answer has markdown section headers (##) for a simple question, more than 3 sentences, more than 2 top-level bullets (unless how-to with ≤6 steps), or repeats recall metadata like "## Attested Memory", "dig_deeper", "Recent Chat".`
    : `- tooLong: true if a how-to/setup answer has more than 6 top-level bullets unless the user asked to list everything exhaustively.`;

  return `You are a critic reviewing a Ghampus assistant answer before it is shown to the user.
Return ONLY valid JSON with this exact shape:
{
  "answersQuestion": boolean,
  "isDumpOrNoise": boolean,
  "tooLong": boolean,
  "isHallucinatedAcronym": boolean,
  "inventsFactsNotInContext": boolean,
  "wrongLanguage": boolean,
  "feedback": "one sentence what's wrong",
  "suggestedFocus": "what to emphasize"
}

Rules:
- answersQuestion: false if the text does not directly address the user's question.
- isDumpOrNoise: true for skill procedure dumps, pricing tiers, unrelated bullet lists, "Here's what I found", memory audit trails, "## Attested Memory", "## dig_deeper", "## Recent Chat", node counts, avg scores, cross-engram hop meta, skill SOPs not relevant to the question.
${tooLongRule}
- feedback: one concise sentence describing the main problem (empty string if all checks pass).
- suggestedFocus: what the answer should emphasize instead (empty string if all checks pass).
- Match the language of the user's question in feedback and suggestedFocus when non-empty.
- wrongLanguage: true when the answer is not in the same language as the user's question (e.g. Romanian prose answering an English question, or English prose answering a Romanian question). Recall snippet language does not justify a mismatch.

${buildResponseLanguageRulesBlock(userText)}

${GHAMPUS_DOMAIN_GLOSSARY_BLOCK}
${GHAMPUS_GROUNDING_RULES_BLOCK}

- isHallucinatedAcronym: true when the answer invents wrong acronym expansions (e.g. MCP as "Master Certified Professional"). MCP in Graphnosis always means Model Context Protocol.
- inventsFactsNotInContext: true when the answer states dates, milestones, product features, URLs, setup steps, invented English title translations, or corrupted/blended person names NOT present in the recall context provided. "Obsidian Vault" engram name must not be conflated with the Obsidian app unless context says so.`;
}

function buildVerifyUser(userText: string, answer: string, recallContext?: string): string {
  let out = `User question:\n${userText}\n\nAnswer to review:\n${answer.slice(0, POLISH_MAX_CHARS)}`;
  if (recallContext?.trim()) {
    out += `\n\nRecall context (authoritative — answer must not exceed these facts):\n${recallContext.slice(0, POLISH_MAX_CHARS)}`;
  }
  return out;
}

async function runLlmPass(
  llm: LocalLlm,
  system: string,
  user: string,
  fallback: string,
  logTag: string,
): Promise<string> {
  try {
    const { tryAcquireLlmSlot, WorkPriority } = await import('./work-priority.js');
    const slot = tryAcquireLlmSlot(WorkPriority.P2_GHAMPUS);
    if (!slot) return fallback;
    try {
      if (slot.signal.aborted) return fallback;
      return await llm.complete({
        system,
        user,
        signal: slot.signal,
      } as Parameters<LocalLlm['complete']>[0]);
    } finally {
      slot.release();
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return fallback;
    console.warn(`[ghampus:finalize] ${logTag} failed:`, err instanceof Error ? err.message : String(err));
    return fallback;
  }
}

/**
 * LLM polish pass — rewrites draft against original question.
 * When forcePolish is set, skips the needsAnswerPolish gate (re-polish after verify).
 */
function polishTraceLabel(pass: number): string {
  return pass > 1 ? `Polishing answer (${pass})` : 'Polishing answer';
}

function emitFinalizeTrace(hints: FinalizeGhampusAnswerOpts | undefined, event: FinalizeTraceEvent): void {
  hints?.emitTrace?.(event);
}

/** Final deterministic presentation pass — sanitize, strip audit noise, fix acronyms. */
function applyFinalFormatting(text: string, hints?: FinalizeGhampusAnswerOpts): string {
  emitFinalizeTrace(hints, {
    label: 'Formatting answer',
    status: 'running',
    stepKey: 'format',
  });
  const formatted = sanitizeGhampusResponse(stripRecallAuditTrail(text));
  emitFinalizeTrace(hints, {
    label: 'Formatting answer',
    status: 'ok',
    stepKey: 'format',
  });
  return formatted;
}

async function polishGhampusAnswerDraft(
  llm: LocalLlm,
  userText: string,
  draft: string,
  hints?: FinalizeGhampusAnswerOpts,
): Promise<string> {
  const pass = hints?.polishPass ?? 1;
  emitFinalizeTrace(hints, {
    label: polishTraceLabel(pass),
    stepKey: `polish-${pass}`,
  });

  const system = buildPolishSystem(userText, hints);
  const user = buildPolishUser(userText, draft, hints?.verifyFeedback, hints?.recallContext);

  const out = await runLlmPass(llm, system, user, draft, 'polish');
  const polished = sanitizeGhampusResponse(stripRecallAuditTrail(out?.trim() ?? ''));
  if (!polished || polished.length < 8) return draft;
  if (isRawRecallDump(polished)) return draft;
  return polished;
}

async function verifyGhampusAnswer(
  llm: LocalLlm,
  userText: string,
  answer: string,
  recallContext?: string,
  hints?: FinalizeAnswerHints,
): Promise<VerifyAnswerResult | null> {
  const raw = await runLlmPass(
    llm,
    buildVerifySystem(userText, hints),
    buildVerifyUser(userText, answer, recallContext),
    '',
    'verify',
  );
  if (!raw) return null;
  return parseVerifyAnswerJson(raw);
}

function applyGroundingChecks(
  answer: string,
  verify: VerifyAnswerResult | null,
  recallContext?: string,
): VerifyAnswerResult | null {
  if (!verify) return verify;

  let updated = verify;
  if (isHallucinatedAcronym(answer)) {
    updated = {
      ...updated,
      isHallucinatedAcronym: true,
    };
    if (!updated.feedback) {
      updated.feedback = 'Wrong acronym expansion detected (e.g. MCP as Master Certified Professional).';
    }
  }

  if (recallContext !== undefined) {
    const hall = detectLikelyHallucination(answer, recallContext);
    if (hall.likely) {
      updated = {
        ...updated,
        inventsFactsNotInContext: true,
      };
      if (!updated.feedback) {
        updated.feedback = formatGroundingVerifyFeedback(hall.reasons);
      }
    }
  }

  return updated;
}

function applyLanguageMismatchCheck(
  userText: string,
  answer: string,
  verify: VerifyAnswerResult | null,
): VerifyAnswerResult | null {
  if (!verify || verify.wrongLanguage) return verify;
  if (!answerLanguageMismatchUserQuery(userText, answer)) return verify;
  return {
    ...verify,
    wrongLanguage: true,
    feedback: verify.feedback || 'Answer language does not match the user\'s question.',
  };
}

/**
 * LLM polish pass — rewrites draft against original question before UI display.
 * Returns draft unchanged when polish is skipped or LLM unavailable.
 */
export async function finalizeGhampusAnswer(
  llm: LocalLlm | null,
  userText: string,
  draft: string,
  hints?: FinalizeGhampusAnswerOpts,
): Promise<string> {
  if (!hints?.forcePolish && !needsAnswerPolish(userText, draft, hints)) return draft;
  if (!llm) return draft;
  return polishGhampusAnswerDraft(llm, userText, draft, hints);
}

/**
 * Polish + optional critic verify loop — re-polishes with feedback until OK or max iterations.
 */
export async function finalizeGhampusAnswerWithVerification(
  llm: LocalLlm | null,
  userText: string,
  draft: string,
  hints?: FinalizeWithVerificationOpts,
): Promise<string> {
  if (!needsAnswerPolish(userText, draft, hints)) return draft;
  if (!llm) return draft;

  let current = draft;
  let verifyFeedback: string | undefined = hints?.verifyFeedback;
  const maxIter = hints?.maxIterations ?? VERIFY_MAX_ITERATIONS;
  const skipVerify = hints?.skipVerification ?? shouldSkipVerification(userText, draft, hints);

  for (let i = 0; i < maxIter; i++) {
    const passHints: FinalizeGhampusAnswerOpts = {
      ...(hints?.skipPolish !== undefined ? { skipPolish: hints.skipPolish } : {}),
      ...(hints?.polishSource !== undefined ? { polishSource: hints.polishSource } : {}),
      ...(hints?.queryHints !== undefined ? { queryHints: hints.queryHints } : {}),
      ...(hints?.emitTrace !== undefined ? { emitTrace: hints.emitTrace } : {}),
      ...(hints?.forcePolish !== undefined ? { forcePolish: hints.forcePolish } : {}),
      ...(hints?.recallContext !== undefined ? { recallContext: hints.recallContext } : {}),
      polishPass: i + 1,
      ...(verifyFeedback ? { verifyFeedback } : {}),
    };
    current = await polishGhampusAnswerDraft(llm, userText, current, passHints);
    current = sanitizeGhampusResponse(current);

    if (skipVerify) break;

    emitFinalizeTrace(hints, {
      label: 'Checking answer',
      stepKey: `check-${i + 1}`,
    });

    let verify = await verifyGhampusAnswer(llm, userText, current, hints?.recallContext, hints);
    verify = applyGroundingChecks(current, verify, hints?.recallContext);
    verify = applyLanguageMismatchCheck(userText, current, verify);
    if (!wouldContinueVerifyLoop(i, maxIter, verify)) {
      break;
    }

    verifyFeedback = formatVerifyFeedback(verify!, userText, hints);
  }

  return applyFinalFormatting(current, hints);
}
