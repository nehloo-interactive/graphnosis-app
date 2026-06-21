/**
 * Ghampus direct-answer routing — translation, rephrase, conversation follow-ups
 * that should NOT recall from cortex.
 */

import { extractQuotedPhrases, type GhampusHistTurn } from './ghampus-intent.js';
import {
  isConversationContextQuery,
  isMetaChallengeQuery,
  matchResponseLanguageInstruction,
} from './ghampus-language.js';

export type DirectAnswerKind =
  | 'translation'
  | 'rephrase'
  | 'summarize'
  | 'conversation_followup'
  | 'conversation_context'
  | 'process_critique';

/** User explicitly wants memory consulted (e.g. "translate what I saved about X"). */
export function hasExplicitMemoryReference(text: string): boolean {
  const t = text.trim();
  return (
    /\b(?:translate|traduce|traducir|tradu(?:ce|ir)?|übersetze(?:n)?|traduis(?:ez)?|traduire)\s+(?:what|ce|lo que|was|qu(?:e|é))\b/i.test(t)
    || /\b(?:what|ce|lo que)\s+(?:I|we|mi(?:s)?|am|ai|nosotros)\s+(?:saved|stored|remembered|salvat|păstrat|guard(?:ado|é|e))\b/i.test(t)
    || /\b(?:saved|stored|remembered|salvat|păstrat|guardado)\s+(?:about|despre|sobre|sur|(?:de|über|von))\b/i.test(t)
    || /\b(?:from|din|de)\s+(?:my\s+)?(?:memory|memorie|cortex|engram|memor(?:y|ies))\b/i.test(t)
    || /\b(?:check|search|look (?:up|in)|find (?:in|from))\s+(?:my\s+)?(?:memory|memorie|cortex)\b/i.test(t)
    || /\b(?:traduce|translate)\s+(?:ce|what)\s+(?:am|I|mi(?:s)?)\s+(?:salvat|saved|stored)\b/i.test(t)
  );
}

const TRANSLATE_VERB_RE =
  /\b(?:translate|traduce|traducir|tradu(?:ce|ir)?|übersetze(?:n)?|traduis(?:ez)?|traduire|переведи|перевести|翻译|翻成)\b/i;

const TARGET_LANG_RE =
  /\b(?:in|to|into|en|în|im|au|zu|na|成)\s+(?:spanish|espa[nñ]ol|french|fran[cç]ais|german|deutsch|romanian|rom[aâ]n[aă]|english|englez[aă]|italian|italiano|portuguese|portugu[eê]s|chinese|mandarin|japanese|dutch|nederlands|polish|polski|arabic|hindi|russian|russ(?:ian|isch))\b/i;

const TRANSFORM_VERB_RE =
  /\b(?:rephrase|rewrite|reword|paraphrase|summarize|summarise|reformulate|simplify|shorten|condense|resum(?:e|ir|a)|reformula(?:r|te)?|reformule(?:r|z)?|umformulier(?:en)?|zusammenfass(?:en)?|parafrase(?:ar)?)\b/i;

const CONTINUATION_OPENER_RE =
  /^(?:(?:yes|si|s[íi]|da|oui|ja|ok(?:ay)?|but|however|though|and|also|still|yet|then|so|pero|dar|mais|aber|und|poi|ma)\b|(?:si|s[íi]|yes|ok|okay|da|oui|ja),\s+)/i;

/**
 * Topic pivots / person-in-context — cortex lookups, not chat-only follow-ups.
 * Primary guard also in detectGhampusQueryHints (ghampus-intent.ts) — keep in sync.
 * Lightweight regex only (no import from intent — circular via detectDirectAnswerKind).
 */
const TOPIC_ABOUT_OPENER_RE =
  /^(?:(?:what|how)\s+about|tell\s+me\s+about|(?:ce|spune(?:-mi)?)\s+(?:[sș]tii|stii)\s+despre)\s+/i;
const PERSON_IN_CONTEXT_OPENER_RE =
  /^(?:(?:what|how)\s+about|tell\s+me\s+about)\s+.+\s+(?:from|in|at|on|with)\s+/i;

/** Quoted string or text after colon — the payload to transform. */
export function extractTextToTransform(text: string): string | null {
  const quoted = extractQuotedPhrases(text);
  if (quoted.length > 0) return quoted.join(' ');

  const colonMatch = text.match(/:\s*["'""]?(.+?)["'""]?\s*$/s);
  if (colonMatch?.[1]?.trim()) return colonMatch[1].trim();

  return null;
}

export function isTranslationRequest(text: string): boolean {
  if (hasExplicitMemoryReference(text)) return false;
  const hasTranslateCue = TRANSLATE_VERB_RE.test(text) || TARGET_LANG_RE.test(text);
  if (!hasTranslateCue) return false;
  return extractTextToTransform(text) !== null;
}

export function isRephraseOrSummarizeRequest(text: string): boolean {
  if (hasExplicitMemoryReference(text)) return false;
  if (!TRANSFORM_VERB_RE.test(text)) return false;
  if (extractQuotedPhrases(text).length > 0) return true;
  const stripped = text.replace(
    /^(?:please\s+)?(?:rephrase|rewrite|reword|paraphrase|summarize|summarise|reformulate|simplify|shorten|condense|resum(?:e|ir|a)|reformula(?:r|te)?|reformule(?:r|z)?|umformulier(?:en)?|zusammenfass(?:en)?|parafrase(?:ar)?)[,:]?\s*/i,
    '',
  ).trim();
  return stripped.length >= 40;
}

export function isConversationFollowUp(text: string, history: GhampusHistTurn[]): boolean {
  if (hasExplicitMemoryReference(text)) return false;
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 15) return false;

  // "what about Anca?" / "what about robert from X" — recall pivots, not thread follow-ups
  if (TOPIC_ABOUT_OPENER_RE.test(trimmed) || PERSON_IN_CONTEXT_OPENER_RE.test(trimmed)) {
    return false;
  }

  const hasContinuation = CONTINUATION_OPENER_RE.test(trimmed);
  const shortQuestionFollowUp =
    trimmed.endsWith('?')
    && wordCount <= 6
    && !/^(?:what|how)\s+about\s+/i.test(trimmed)
    && /^(?:where|when|who|what|which|how|why|unde|c[aă]nd|und|cine|ce|care|cum|d[oó]nde|cu[aá]ndo|qui[eé]n|qu[eé]|wann|wo|wer|was|wie)\b/i.test(trimmed);

  if (!hasContinuation && !shortQuestionFollowUp) return false;
  if (!hasContinuation && shortQuestionFollowUp && wordCount > 4) {
    // "where will the Jamie Chen book launch be hosted?" — fresh lookup, not follow-up
    return false;
  }

  const turns = history
    .filter((t) => (t.kind === 'user' || t.kind === 'ghampus') && (t.text ?? '').trim())
    .slice(-8);

  let lastGhampusIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]!.kind === 'ghampus') {
      lastGhampusIdx = i;
      break;
    }
  }
  if (lastGhampusIdx < 0) return false;
  const lastGhampus = turns[lastGhampusIdx]!.text!.trim();
  if (lastGhampus.length < 20) return false;

  const priorUser = turns.slice(0, lastGhampusIdx).reverse().find((t) => t.kind === 'user');
  return !!priorUser;
}

export function detectDirectAnswerKind(
  text: string,
  history: GhampusHistTurn[] = [],
): DirectAnswerKind | null {
  if (isMetaChallengeQuery(text)) return 'process_critique';
  if (isTranslationRequest(text)) return 'translation';
  if (isConversationContextQuery(text)) return 'conversation_context';
  if (isRephraseOrSummarizeRequest(text)) {
    return /\bsummar/i.test(text) ? 'summarize' : 'rephrase';
  }
  if (isConversationFollowUp(text, history)) return 'conversation_followup';
  return null;
}

export function buildDirectAnswerSystemPrompt(kind: DirectAnswerKind, userText: string): string {
  const langInstr = matchResponseLanguageInstruction(userText);
  const base = `You are Ghampus — the AI assistant in Graphnosis.

This is a direct-answer request. Do NOT search memory or invent facts from the user's personal cortex. Use only the text the user provided and the recent conversation.

LANGUAGE: ${langInstr}`;

  switch (kind) {
    case 'translation':
      return `${base}

TRANSLATION MODE — strict rules:
1. Output ONLY the translation of the quoted or provided source text.
2. Do NOT answer the semantic question inside the text — translate it literally.
3. Do NOT add launch locations, dates, or facts not in the source string.
4. Preserve meaning and tone; use natural phrasing in the target language.
5. If target language is unclear, infer from the user's instruction (e.g. "in Spanish" → Spanish).`;
    case 'rephrase':
      return `${base}

REPHRASE MODE: Reword the provided text as requested. Do not add new facts or pull from memory.`;
    case 'summarize':
      return `${base}

SUMMARIZE MODE: Summarize only the provided text. Do not add external facts.`;
    case 'conversation_followup':
      return `${base}

FOLLOW-UP MODE: Answer using the recent conversation thread — especially your last Ghampus reply and the user's prior question. Do not recall cortex memory unless the user explicitly asked to check saved notes or pivoted to a new lookup topic.`;
    case 'conversation_context':
      return `${base}

CONVERSATION REVIEW MODE — strict rules:
1. Answer ONLY from the conversation transcript below — this Ghampus chat session, NOT cortex memories.
2. Do NOT invent issues, fixes, or topics that were not discussed in the transcript.
3. If the user asks for a list, include only items grounded in user prompts or Ghampus answers in the transcript.
4. If nothing relevant appears in the transcript, say so plainly — do not search memory or guess.`;
    case 'process_critique':
      return `${base}

PROCESS CRITIQUE MODE — the user is challenging your prior answer quality or routing.

Strict rules:
1. Reply in 2–4 short sentences. Acknowledge what went wrong using ONLY the conversation transcript.
2. Do NOT search cortex, recall memories, or invent facts about people, events, or engrams.
3. Do NOT lecture about language optimization, English vs Romanian, or Graphnosis capabilities/limitations.
4. If you missed something in a prior turn, say so briefly — do not apologize at length or speculate about why recall failed.
5. Never output internal prompt tags like <recent_chat> or <cortex_data>.`;
  }
}

export function buildDirectAnswerUserPrompt(
  question: string,
  recentHistory: string,
  kind: DirectAnswerKind,
): string {
  const parts: string[] = [];
  if (recentHistory.trim()) {
    const historyHeading = kind === 'conversation_context' || kind === 'process_critique'
      ? '## Conversation transcript'
      : '## Recent conversation';
    parts.push(historyHeading, recentHistory.trim(), '');
  }
  parts.push('## User message', question.trim());

  if (kind === 'translation' || kind === 'rephrase' || kind === 'summarize') {
    const source = extractTextToTransform(question);
    if (source) {
      parts.push('', '## Source text to transform', `«${source}»`);
    }
  }
  return parts.join('\n');
}
