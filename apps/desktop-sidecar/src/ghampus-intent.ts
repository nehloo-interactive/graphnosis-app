/**
 * Ghampus intent + query-hint detection (extracted from ipc ghampus:send).
 * Unit-tested without live LLM or Ghampus poll.
 */

import { GHAMPUS_DOMAIN_GLOSSARY_BLOCK } from './ghampus-glossary.js';
import {
  parseRememberContentFirstPattern,
  parseRememberInToPattern,
  trimGreedyEngramHint,
} from './ghampus-engram-resolve.js';
import { detectDirectAnswerKind, type DirectAnswerKind } from './ghampus-direct-answer.js';
import {
  isHowToQuestionText,
  isMultilingualListVerbFirstWord,
  isRemindMeRecallQuery,
  isScopedTaskListQuery,
  isTemporalTodoQuery,
  isConversationContextQuery,
  MULTILINGUAL_QUESTION_OPENERS,
  MULTILINGUAL_RECALL_QUESTION_RE,
  PERSON_NAME_RE,
  ROLE_NOUN_RE,
  TASK_DEADLINE_NOUN_RE,
  TASK_NOUN_RE,
  TASK_SCOPE_PREPOSITIONS,
  titleCaseLatinToken,
  WORD_TOKEN_RE,
  WORD_TOKEN_RE_MIN3,
  PERSON_NAME_G,
} from './ghampus-language.js';

export type { DirectAnswerKind } from './ghampus-direct-answer.js';
export {
  detectDirectAnswerKind,
  extractTextToTransform,
  hasExplicitMemoryReference,
  isConversationFollowUp,
  isRephraseOrSummarizeRequest,
  isTranslationRequest,
} from './ghampus-direct-answer.js';

export { isConversationContextQuery, hasMemoryAnchorInQuery, isMetaChallengeQuery } from './ghampus-language.js';

export {
  normalizeEngramKey,
  resolveEngramFromUserHint,
  trimGreedyEngramHint,
  type EngramListEntry,
} from './ghampus-engram-resolve.js';

export type GhampusIntent =
  | { action: 'remember'; content: string; engram: string | null }
  | { action: 'edit'; correction: string; engram: string | null }
  | { action: 'create_engram'; name: string }
  | { action: 'ui_only'; reason: string }
  | { action: 'recall' };

export type GhampusHistTurn = { kind?: string; text?: string };

export interface GhampusQueryHints {
  wantsRecent: boolean;
  wantsSkills: boolean;
  /** User wants an enumerated list of trained skills (not recall over cortex). */
  wantsSkillList: boolean;
  /** Keyword filter for wantsSkillList (e.g. "marketing" from "skills that include marketing"). */
  skillFilterKeyword: string | null;
  /** User wants MCP server tools enumerated — NOT cortex skills (list_skills). */
  wantsMcpToolList: boolean;
  /** Keyword filter for wantsMcpToolList (e.g. "skill" from "mcp tools related to skills"). */
  mcpToolFilterKeyword: string | null;
  /** User is correcting a prior skills-vs-MCP-tools category mix-up. */
  wantsMcpNotSkillsCorrection: boolean;
  wantsStats: boolean;
  wantsSource: boolean;
  wantsCitations: boolean;
  /** User asked for provenance / cite / where did I — prefer recall_with_citations. */
  wantsProvenance: boolean;
  /** How-to, settings path, full document, or TODO file — doc-shaped recall, not skill walk. */
  wantsDocSource: boolean;
  /** Topic spans engrams — no single engram scope; prefer cross_search. */
  wantsCrossEngramSearch: boolean;
  /** User explicitly asked to run/walk/execute a skill SOP — not recall over cortex. */
  wantsExplicitSkillWalk: boolean;
  wantsExhaustive: boolean;
  wantsGrouped: boolean;
  wantsTeamRoster: boolean;
  wantsTeamTaskList: boolean;
  /** "todos/tasks for {project|org|person}" — scoped task list, not a save. */
  wantsProjectTaskList: boolean;
  /** "todos due tomorrow / past due" — temporal obligation lookup. */
  wantsTemporalTodos: boolean;
  asksForRoles: boolean;
  /** Single-person role query (e.g. "ce rol are andrea lewis?") — not a team roster list. */
  wantsPersonRole: boolean;
  /** Person scoped to org/engram (e.g. "what about robert from unpublishedromania?"). */
  wantsPersonInContext: boolean;
  /** "what about X" / "tell me about X" without org scope — topic/person lookup, not save. */
  wantsTopicAbout: boolean;
  /** "what is X" / "cine e ghampus" — tight synthesis, not exhaustive dump. */
  wantsDefinitional: boolean;
  wantsStructuredRecall: boolean;
  hasQuotedSearch: boolean;
  /** Translation / rephrase / conversation follow-up — skip cortex recall tools. */
  skipMemoryTools: boolean;
  /** User asks about this Ghampus chat thread — not cortex memories. */
  wantsConversationContext: boolean;
  directAnswerKind: DirectAnswerKind | null;
  recallMaxNodes: number;
  recallMaxTokens: number;
  skipEnrichmentRecallOpts: { skip_enrichment: true } | Record<string, never>;
}

export type DetectGhampusQueryHintsOpts = {
  history?: GhampusHistTurn[];
};

/** Common query words — excluded from “did recall match the question?” checks. */
const RECALL_QUERY_STOP_WORDS = new Set([
  'what', 'when', 'where', 'who', 'which', 'how', 'why', 'the', 'this', 'that', 'these', 'those',
  'week', 'her', 'his', 'their', 'our', 'your', 'my', 'and', 'for', 'with', 'from', 'about',
  'have', 'has', 'had', 'are', 'was', 'were', 'been', 'being', 'does', 'did', 'will', 'would',
  'all', 'any', 'some', 'every', 'each', 'list', 'show', 'find', 'give', 'tell', 'team', 'members',
  'member', 'tasks', 'task', 'items', 'item', 'working', 'work', 'deadline', 'deadlines',
  'ce', 'cum', 'când', 'cand', 'unde', 'cine', 'care', 'cât', 'cat', 'lucru', 'saptamana', 'săptămâna',
  'aceasta', 'această', 'termenul', 'termen', 'este', 'sunt', 'are', 'pentru', 'persoana', 'persoană',
  'echipei', 'echipa', 'toate', 'sarcinile', 'sarcini', 'produsul', 'versiune', 'versiunea', 'codul',
  'graphnosis', 'eval', 'product', 'version', 'codename', 'ghampus', 'tests',
  'skill', 'skills', 'skilluri', 'skillul', 'proceduri', 'procedura', 'include', 'includes',
  'containing', 'contain', 'contains', 'includ', 'includa', 'conțin', 'contin', 'about',
  'currently', 'doing', 'latest', 'current', 'status', 'update', 'updates',
  'si', 'sau', 'roluri', 'rol', 'roles', 'membri', 'membrii',
  'owners', 'assignees', 'assignee', 'board', 'fondator', 'consilieri',
]);

/** Query/meta tokens — shared with roster name validation. */
export function isRecallQueryStopWord(token: string): boolean {
  return RECALL_QUERY_STOP_WORDS.has(token.toLowerCase());
}

/** Quoted literals the user wants to find in memory text — e.g. 'Alex Smith'. */
export function extractQuotedPhrases(query: string): string[] {
  const out: string[] = [];
  for (const m of query.matchAll(/[''"]([^'"]+)[''"]/g)) {
    const s = m[1]?.trim() ?? '';
    if (s.length >= 2) out.push(s);
  }
  return out;
}

function phraseParts(phrase: string): string[] {
  return phrase.toLowerCase().split(/\s+/).filter((p) => p.length >= 2);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Multi-word phrases require adjacent tokens (allows small punctuation gaps).
 * Prevents "Alex Smith" matching "Alex + Jamie Chen".
 */
export function textMatchesPhrase(text: string, phrase: string): boolean {
  const parts = phraseParts(phrase);
  if (parts.length === 0) return true;
  const normalized = phrase.toLowerCase().replace(/\s+/g, ' ').trim();
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  if (parts.length === 1) return t.includes(parts[0]!);
  if (t.includes(normalized)) return true;
  const escaped = parts.map(escapeRegExp);
  const adjacentRe = new RegExp(
    `\\b${escaped.join('(?:[\\s\\u2019\\u2018\\-]+|\\s*[+&]\\s*)')}\\b`,
    'iu',
  );
  if (adjacentRe.test(text)) return true;
  const hyphenRe = new RegExp(`\\b${escaped.join('-')}\\b`, 'i');
  return hyphenRe.test(text);
}

/** Tokens that must appear in recall context when present in the user's question. */
export function extractSalientRecallTokens(text: string): string[] {
  const out = new Set<string>();
  for (const q of extractQuotedPhrases(text)) {
    for (const tok of q.toLowerCase().match(WORD_TOKEN_RE) ?? []) {
      if (!RECALL_QUERY_STOP_WORDS.has(tok.toLowerCase())) out.add(tok.toLowerCase());
    }
  }
  const lowerTokens = text.toLowerCase().match(WORD_TOKEN_RE_MIN3) ?? [];
  for (const tok of lowerTokens) {
    if (!RECALL_QUERY_STOP_WORDS.has(tok.toLowerCase())) out.add(tok.toLowerCase());
  }
  for (const m of text.matchAll(PERSON_NAME_G)) {
    const n = m[0]?.trim() ?? '';
    if (!n || isRecallQueryStopWord(n.toLowerCase())) continue;
    out.add(n.toLowerCase());
  }
  return [...out];
}

function foldDiacritics(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Sanity check: recall prose plausibly matches the user's question (not expanded tool queries). */
export function recallContextMatchesQuery(recallPrompt: string, query: string): boolean {
  const quoted = extractQuotedPhrases(query);
  if (quoted.length > 0) {
    return quoted.some((q) => textMatchesPhrase(recallPrompt, q));
  }
  const rl = foldDiacritics(recallPrompt.toLowerCase());
  const salient = extractSalientRecallTokens(query).map((t) => foldDiacritics(t));
  if (salient.length === 0) return true;
  const hits = salient.filter((tok) => rl.includes(tok));
  if (salient.length <= 2) return hits.length >= 1;
  return hits.length >= Math.ceil(salient.length / 2);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/** When the user names an engram in the question, scope recall to it. */
export function extractEngramScopeFromQuery(text: string, engramIds: string[]): string[] {
  const lower = text.toLowerCase();
  const salientTokens = new Set<string>(lower.match(/[a-z0-9]{6,}/g) ?? []);
  for (const brand of text.match(/\b[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g) ?? []) {
    salientTokens.add(brand.toLowerCase());
    salientTokens.add(brand.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/\s+/g, ''));
  }
  // "unpublished connect" / "unpublishedconnect" → match unpublished-* slugs
  if (/\bunpublished\s*connect\b/i.test(text) || salientTokens.has('unpublishedconnect')) {
    salientTokens.add('unpublishedconnect');
    salientTokens.add('unpublished');
  }
  const matched = engramIds.filter((id) => {
    const slug = id.toLowerCase();
    if (lower.includes(slug)) return true;
    const spaced = slug.replace(/-/g, ' ');
    if (spaced.length >= 4 && lower.includes(spaced)) return true;
    const slugCompact = slug.replace(/-/g, '');
    if (slugCompact.length < 6) return false;
    for (const tok of salientTokens) {
      const dist = levenshtein(tok, slugCompact);
      const maxLen = Math.max(tok.length, slugCompact.length);
      if (dist <= 2 && dist / maxLen <= 0.15) return true;
      if (
        tok.startsWith('unpublished')
        && slugCompact.startsWith('unpublished')
        && (tok.includes('connect') === slugCompact.includes('connect')
          || slug.includes('connect'))
      ) {
        if (dist <= 4 && dist / maxLen <= 0.25) return true;
      }
    }
    return false;
  });
  return [...new Set(matched)];
}

export interface PersonInContext {
  person: string;
  scope: string | null;
}

function titleCasePersonToken(s: string): string {
  return titleCaseLatinToken(s);
}

/**
 * "what about X from Y" / "ce știi despre X din Y" — person name (lowercase ok) + org/engram scope.
 * Returns null when the pattern does not match.
 */
export function extractPersonInContextFromQuery(text: string): PersonInContext | null {
  const trimmed = text.trim().replace(/[?.!]+$/, '');
  const patterns: RegExp[] = [
    /^(?:what|how)\s+about\s+(.+?)\s+(?:from|in|at|on|with)\s+(.+)$/i,
    /^tell\s+me\s+about\s+(.+?)\s+(?:from|in|at|on|with)\s+(.+)$/i,
    /^(?:ce|spune(?:-mi)?)\s+(?:[sș]tii|stii)\s+despre\s+(.+?)\s+(?:din|de\s+la|în|in)\s+(.+)$/i,
    /^(?:ce|cum)\s+(?:e|este|sunt)\s+(.+?)\s+(?:din|de\s+la|în|in)\s+(.+)$/i,
    /^(?:qu[e']?\s+sais-tu|dis-moi)\s+(?:sur|de)\s+(.+?)\s+(?:de|du|dans|chez)\s+(.+)$/i,
    /^(?:qu[eé]\s+sabes|dime)\s+(?:sobre|de)\s+(.+?)\s+(?:de|en|del)\s+(.+)$/i,
    /^(?:was\s+wei[sß]t\s+du|erz[aä]hl\s+mir)\s+(?:[uü]ber|von)\s+(.+?)\s+(?:von|aus|bei)\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (!m?.[1] || !m?.[2]) continue;
    const personRaw = m[1].trim();
    const scopeRaw = m[2].trim();
    if (!personRaw || personRaw.split(/\s+/).length > 3) continue;
    const personLower = personRaw.toLowerCase();
    if (isRecallQueryStopWord(personLower)) continue;
    if (/\b(team|echipa|echipei|members?|membri|tasks?|sarcini|roles?|roluri)\b/i.test(personRaw)) {
      continue;
    }
    return {
      person: titleCasePersonToken(personRaw),
      scope: scopeRaw.length >= 2 ? scopeRaw : null,
    };
  }
  return null;
}

/** Definitional / identity subjects — allowed as topic-about even if stop words. */
const TOPIC_ABOUT_ALLOWLIST = new Set([
  'ghampus', 'graphnosis', 'cortex', 'engram', 'engrams', 'skill', 'skills', 'skilluri',
]);

/** "what about X" / "tell me about X" without org — topic or person lookup (not save). */
export function extractTopicAboutFromQuery(text: string): string | null {
  const trimmed = text.trim().replace(/[?.!]+$/, '');
  const patterns: RegExp[] = [
    /^(?:what|how)\s+about\s+(.+)$/i,
    /^tell\s+me\s+about\s+(.+)$/i,
    /^(?:ce|spune(?:-mi)?)\s+(?:[sș]tii|stii)\s+despre\s+(.+)$/i,
    /^(?:qu[e']?\s+sais-tu|dis-moi)\s+(?:sur|de|du)\s+(.+)$/i,
    /^(?:qu[eé]\s+sabes|dime)\s+(?:sobre|de)\s+(.+)$/i,
    /^(?:was\s+wei[sß]t\s+du|erz[aä]hl\s+mir)\s+(?:[uü]ber|von)\s+(.+)$/i,
  ];
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (!m?.[1]) continue;
    const topic = m[1].trim();
    if (!topic || topic.split(/\s+/).length > 6) continue;
    if (/\b(from|in|at|on|with|din|de la|în)\s+\S/i.test(topic)) continue;
    if (/\b(team|echipa|echipei|members?|membri|tasks?|sarcini|roles?|roluri|todos?)\b/i.test(topic)) {
      continue;
    }
    const lower = topic.toLowerCase();
    if (isRecallQueryStopWord(lower) && topic.split(/\s+/).length === 1 && !TOPIC_ABOUT_ALLOWLIST.has(lower)) {
      continue;
    }
    return topic;
  }
  return null;
}

/** Definitional / identity questions — recall with tight synthesis, not dump. */
export function isDefinitionalQuery(text: string): boolean {
  const t = text.trim().replace(/[?.!]+$/, '');
  return (
    /^(?:what|who)\s+(?:is|are|was|were)\s+\S/i.test(t)
    || /^(?:ce|care|cine)\s+(?:e|este|sunt|i\s+e|i\s+este)\s+\S/i.test(t)
    || /^(?:qu[e']?\s+est|qui\s+est)\s+\S/i.test(t)
    || /^(?:qu[eé]\s+es|qui[eé]n\s+es)\s+\S/i.test(t)
    || /^was\s+ist\s+\S/i.test(t)
    || /^(?:what|who)\s+(?:is|are)\s+(?:ghampus|graphnosis)\b/i.test(t)
    || /^(?:cine|ce)\s+(?:e|este)\s+(?:ghampus|graphnosis)\b/i.test(t)
  );
}

/** Extract topic keyword from "skills that include marketing" / "skilluri care includ X". */
export function extractSkillFilterKeyword(text: string): string | null {
  const patterns: RegExp[] = [
    /\bskills?\s+(?:that|which)\s+(?:include|contain|cover|mention|have|with)\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\bskilluri\s+(?:care|ce)\s+(?:includ|conțin|contin|cuprind|menționeaz[aă]?|au)\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\b(?:include|contain|covering|with|despre|pentru)\s+["']?([^"'\n,?]+?)["']?\s+skills?\b/i,
    /\bskills?\s+(?:about|on|for|regarding|re:)\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\blist(?:eaz[aă])?\s+(?:all\s+)?skills?\s+(?:that\s+)?(?:include|contain|with|about)\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\bfind\s+skills?\s+(?:about|on|for|with|matching|including)\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\b(?:show|list|find|give me)\s+(?:all\s+)?skills?\s+(?:about|on|for|with|matching)\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    let kw = m?.[1]?.trim() ?? '';
    kw = kw.replace(/\s+(skills?|skilluri)$/i, '').trim();
    if (kw.length >= 2) return kw;
  }
  return null;
}

/** Multilingual — run/walk/execute skill (not how-to product questions). */
export function detectWantsExplicitSkillWalk(text: string): boolean {
  if (/\bhow (?:do|can|to|should)\b/i.test(text) && !/\bwalk(?:_| )?skill\b/i.test(text)) {
    return false;
  }
  return (
    /\b(walk(?:_| )?skill|run the skill|execute the skill|skill procedure)\b/i.test(text)
    || /\b(run|walk|execute)\s+(?:the\s+)?(?:skill|sop|procedur[aăe])\b/i.test(text)
    || /\b(folose[sș]te|execut[aă])\s+(?:skill(?:ul)?|procedur[aă])\b/i.test(text)
    || /\b(lancer?|ex[eé]cuter?)\s+(?:la\s+)?(?:skill|le\s+skill|procedur)/i.test(text)
    || /\b(ejecutar?|correr?)\s+(?:la\s+)?(?:skill|el\s+skill|procedur)/i.test(text)
    || /\b(ausf[uü]hren|starten)\s+(?:den\s+)?(?:skill|die\s+prozedur)/i.test(text)
  );
}

/** Skill name / keyword after walk/run/execute — for skill-walk early route. */
export function extractSkillWalkTarget(text: string): string | null {
  const patterns: RegExp[] = [
    /\bwalk(?:_| )?skill\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\b(?:walk|run|execute)\s+(?:the\s+)?skill\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\b(?:walk|run|execute)\s+["']?([^"'\n,?]+?)["']?\s*(?:\s*$|\s*[?.!]|$)/i,
    /\b(?:folose[sș]te|execut[aă])\s+(?:skill(?:ul)?\s+)?["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\b(?:lancer?|ex[eé]cuter?)\s+(?:la\s+)?(?:skill\s+)?["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\b(?:ejecutar?|correr?)\s+(?:la\s+)?(?:skill\s+)?["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\b(?:ausf[uü]hren|starten)\s+(?:den\s+)?(?:skill\s+)?["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    let kw = m?.[1]?.trim() ?? '';
    kw = kw.replace(/\s+(skill|skillul|sop|procedur[aă])$/i, '').trim();
    if (kw.length >= 2 && !/^(the|a|an|un|una|le|la|den|die|das)$/i.test(kw)) return kw;
  }
  return null;
}

/** Cross-engram topic — spans memory, not scoped to one engram slug in the query. */
export function detectWantsCrossEngramSearch(text: string, scopedEngramIds: string[] = []): boolean {
  if (scopedEngramIds.length > 0) return false;
  return (
    /\b(across (?:all )?engrams?|all engrams?|every engram|cross-engram|multi-engram)\b/i.test(text)
    || /\b(everything (about|on|for)|all (?:my )?memor(?:y|ies) (about|on|for)|anything (about|on|for))\b/i.test(text)
    || /\b(în toate|in toate|peste toate|tot ce (știi|stii|ai)|totul despre)\b/i.test(text)
    || /\b(dans tous les|partout|en tout|über alles|todo lo que)\b/i.test(text)
    || /\bacross\b/i.test(text) && /\b(engrams?|memor(?:y|ies)|cortex)\b/i.test(text)
  );
}

/** Doc-shaped questions — how-to, settings UI path, full source body, TODO file. */
export function detectWantsDocSource(text: string): boolean {
  return (
    isHowToQuestionText(text)
    || /\b(settings?\s*(?:→|->|path|menu|page)|full document|entire (?:file|document|source)|todo file|TODO\.md)\b/i.test(text)
    || /\bshow (?:me )?the (?:full |whole )?(?:document|source|file)\b/i.test(text)
    || /\b(calea|locul|unde (?:e|este|se) (?:setarea|setările|configur))\b/i.test(text)
    || /\b(o[uù] est|d[oó]nde (?:est[aá]|se))\s+(?:la\s+)?(?:configuraci[oó]n|ajustes?)\b/i.test(text)
    || /\b(wo (?:ist|finde)|wie (?:konfiguriere|richte))\b/i.test(text)
  );
}

/** User asked to list MCP server tools — not trained cortex skills. */
export function detectWantsMcpToolList(text: string): boolean {
  if (detectMcpNotSkillsCategoryCorrection(text)) return true;
  if (/\b(?:mcp|model\s+context\s+protocol)\s+tools?\b/i.test(text)) return true;
  if (/\b(?:list|show|find|give me|what are|which|enumerate)\b[\s\S]{0,40}\b(?:mcp|model\s+context\s+protocol)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:mcp|model\s+context\s+protocol)\b[\s\S]{0,40}\b(?:list|show|find|tools?)\b/i.test(text)) {
    return true;
  }
  if (/\bwhat tools (?:do you have|are available|can you use)\b/i.test(text)) return true;
  if (/\b(?:which|what)\s+tools?\b/i.test(text) && /\b(?:mcp|sidecar|synapse|graphnosis)\b/i.test(text)) {
    return true;
  }
  if (
    /\b(?:list|show|enumerate)\b.*\btools?\b/i.test(text)
    && /\b(?:available|have|your|mcp|sidecar)\b/i.test(text)
    && !/\b(?:skilluri|trained skills?|my skills?|all skills?)\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

/** Follow-up when Ghampus listed skills but user wanted MCP tools. */
export function detectMcpNotSkillsCategoryCorrection(text: string): boolean {
  const t = text.trim();
  if (/\b(?:don'?t|do not)\s+list\s+skills?\b/i.test(t)) return true;
  if (/\blist\s+mcp\s+tools?\b/i.test(t)) return true;
  if (
    /\b(?:those|these|they)\s+(?:are|were)\s+skills?\b/i.test(t)
    && /\b(?:not|aren't|are not)\s+(?:mcp\s+)?tools?\b/i.test(t)
  ) {
    return true;
  }
  if (
    /\b(?:not|aren't|are not)\s+skills?\b/i.test(t)
    && /\b(?:mcp\s+)?tools?\b/i.test(t)
    && /\b(?:list|show|want|need)\b/i.test(t)
  ) {
    return true;
  }
  if (/\b(?:wrong category|wrong list|not what i asked)\b/i.test(t) && /\b(?:mcp|tools?)\b/i.test(t)) {
    return true;
  }
  return false;
}

/** Keyword after "mcp tools related to X" / "mcp tools about X". */
export function extractMcpToolFilterKeyword(text: string): string | null {
  const patterns: RegExp[] = [
    /\bmcp\s+tools?\s+(?:related to|about|for|on|with|matching|including|that (?:include|mention|have|cover))\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\b(?:list|show|find)\s+mcp\s+tools?\s+(?:related to|about|for|with|matching|including)\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
    /\bmcp\s+tools?\s+(?:for|about)\s+["']?([^"'\n,?]+?)["']?(?:\s*$|\s*[?.!]|$)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    let kw = m?.[1]?.trim() ?? '';
    kw = kw.replace(/\s+(mcp\s+)?tools?$/i, '').trim();
    if (kw.length >= 2) return kw;
  }
  return null;
}

function detectWantsSkillList(text: string): boolean {
  if (detectWantsMcpToolList(text)) return false;
  const mentionsSkills = /\b(skilluri|skills?|sop|proceduri|procedura)\b/i.test(text);
  if (!mentionsSkills) return false;
  if (/\b(how (?:do|to|should)|walk(?:_| )?skill|execute|run the|folose[sș]t|execut)\b/i.test(text)) {
    return false;
  }
  return (
    /\b(list|show|find|give me|what are|which|enumerate|all my|all the|all)\b.*\b(skill|skilluri|sop|proceduri)/i.test(text)
    || /\b(list|show|find|listeaz[aă]|arat[aă]|enumere|ce)\b.*\b(skill|skilluri|sop|proceduri)/i.test(text)
    || /\b(skill|skilluri|sop)\s+(that|which|who|care)\s+(include|contain|includ|conțin|contin|about|despre|have|cover|mention)/i.test(text)
    || /\b(skill|skilluri|sop)\s+(about|on|for|despre|pentru)\s+\S/i.test(text)
    || (/\b(list all|show all|find all|listeaz[aă] toate|toate skill)/i.test(text) && mentionsSkills)
    || /\bwhat skills\b/i.test(text)
    || /\bce skilluri\b/i.test(text)
  );
}

export function detectGhampusQueryHints(
  text: string,
  scopedEngramIds: string[] = [],
  opts?: DetectGhampusQueryHintsOpts,
): GhampusQueryHints {
  const wantsRecent = /recent|latest|last|new|today|added|ingested|saved recently/i.test(text);
  const wantsExplicitSkillWalk = detectWantsExplicitSkillWalk(text);
  const wantsMcpNotSkillsCorrection = detectMcpNotSkillsCategoryCorrection(text);
  const wantsMcpToolList = detectWantsMcpToolList(text);
  const mcpToolFilterKeyword = wantsMcpToolList ? extractMcpToolFilterKeyword(text) : null;
  const wantsSkillList = detectWantsSkillList(text);
  const skillFilterKeyword = wantsSkillList ? extractSkillFilterKeyword(text) : null;
  const wantsSkills = !wantsMcpToolList && (
    wantsSkillList
    || wantsExplicitSkillWalk
    || /\b(skill|procedure|sop|workflow|step\.by\.step)\b/i.test(text)
    || (/\bwalk\b/i.test(text) && /\b(skill|sop|procedur)/i.test(text))
  );
  const wantsStats = /stat|count|how many|total|size|storage|node|health|vitality/i.test(text);
  const wantsProvenance = /\b(where did (?:i|we)|which source|provenance|surs[aă]|din ce surs[aă])\b/i.test(text);
  const wantsCitations = wantsProvenance
    || /\bcite|citation|proof|evidence\b/i.test(text);
  const wantsSource = /source|file|document|attachment|pdf|url|link|ref/i.test(text)
    && !wantsProvenance
    && !/\bcite\b/i.test(text);
  const wantsDocSource = detectWantsDocSource(text) && !wantsExplicitSkillWalk;
  const wantsCrossEngramSearch = detectWantsCrossEngramSearch(text, scopedEngramIds);
  const wantsProjectTaskList = isScopedTaskListQuery(text);
  const wantsTemporalTodos = isTemporalTodoQuery(text);
  const wantsDefinitional = isDefinitionalQuery(text);
  const topicAbout = extractTopicAboutFromQuery(text);
  const wantsTopicAbout = topicAbout !== null && !wantsDefinitional;
  const wantsExhaustive =
    /\b(list all|show all|find all|give me all|what are all|all (my |the )?(nodes?|todos?|tasks?|items?|entries)|every|enumerate)\b/i.test(text)
    || /\b(list|show)\b.*\b(todos?|tasks?|items?|entries|obligations?|memories)\b/i.test(text)
    || (TASK_NOUN_RE.test(text) && TASK_SCOPE_PREPOSITIONS.test(text))
    || wantsProjectTaskList
    || /\b(listeaz[aă] toate|arat[aă] toate|toate sarcinile|toate taskurile|enumere)\b/i.test(text)
    || /\b(listeaz[aă]|list|show|find|arat[aă])\b.*\b(memor[aăeie]?|memory|memories|not[aăe]?)\b/i.test(text)
    || /\b(care include|that include|includes?|containing|which include)\b/i.test(text);
  const asksForTasksOrDeadlines = TASK_DEADLINE_NOUN_RE.test(text);
  const asksForRoles = ROLE_NOUN_RE.test(text);
  const membriWord = /\bmembri[iî]?\b/i;
  const wantsMembershipList =
    /\b(who are|who is on|who's on|members? of|list (the )?team|team roster)\b/i.test(text)
    || /\b(cine sunt|qui sont|quienes son)\b/i.test(text)
    || membriWord.test(text) && /\b(echipei|echipa|team)\b/i.test(text)
    || /\b(echipei|echipa|team)\b/i.test(text) && membriWord.test(text);
  const wantsTeamRoster = wantsMembershipList && !asksForTasksOrDeadlines;
  const personInContext = extractPersonInContextFromQuery(text);
  const wantsPersonInContext = personInContext !== null;
  const wantsPersonRole =
    (asksForRoles
      && !wantsMembershipList
      && (
        /\b(?:are|au|is|has|for|de)\s+[a-zăâîșț]{2,}(?:\s+[a-zăâîșț]{2,}){1,2}\b/i.test(text)
        || /\b[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+)+\b/.test(text)
      ))
    || (wantsPersonInContext && asksForRoles);
  const hasNamedAssignee = /\b[A-ZĂÂÎȘȚ][a-zăâîșț]+(?:\s+[A-ZĂÂÎȘȚ][a-zăâîșț]+)?\b/.test(text);
  const wantsTeamTaskList =
    asksForTasksOrDeadlines
    && (
      /\b(team|echipei|echipa|echipe|members?|membri)\b/i.test(text)
      || (hasNamedAssignee && !wantsMembershipList)
    );
  const hasQuotedSearch = extractQuotedPhrases(text).length > 0;
  const wantsConversationContext = isConversationContextQuery(text);
  let directAnswerKind = detectDirectAnswerKind(text, opts?.history ?? []);
  // Topic pivots ("what about Anca?") are cortex lookups — not chat-only follow-ups like "si, pero donde?"
  if (
    directAnswerKind === 'conversation_followup'
    && (extractTopicAboutFromQuery(text) !== null || extractPersonInContextFromQuery(text) !== null)
  ) {
    directAnswerKind = null;
  }
  const skipMemoryTools = directAnswerKind !== null;
  const wantsGrouped =
    /\b(by team member|by member|grouped by|group by|per person|by person|by owner|by assignee|organized by|sorted by)\b/i.test(text)
    || /\b(list|show)\b.+\bby\s+\w+/i.test(text)
    || /\b(pe persoan[aă]?|grupat|grupate|per membru|de persoan[aă]?)\b/i.test(text)
    || (asksForTasksOrDeadlines && /\b(team|echipei|echipa|echipe|members?|membri)\b/i.test(text));
  const wantsStructuredRecall =
    !skipMemoryTools
    && !wantsSkillList
    && !wantsMcpToolList
    && !wantsExplicitSkillWalk && (
      wantsExhaustive
      || wantsGrouped
      || wantsTeamRoster
      || wantsTeamTaskList
      || wantsProjectTaskList
      || wantsPersonRole
      || wantsPersonInContext
      || wantsTopicAbout
      || wantsDefinitional
      || wantsDocSource
      || wantsCrossEngramSearch
      || hasQuotedSearch
    );
  const recallMaxNodes = wantsDefinitional ? 15 : (wantsStructuredRecall ? 50 : 20);
  const recallMaxTokens = wantsDefinitional ? 2000 : (wantsStructuredRecall ? 8000 : 2000);
  const skipEnrichmentRecallOpts = wantsStructuredRecall
    ? { skip_enrichment: true as const }
    : {};
  return {
    wantsRecent,
    wantsSkills,
    wantsSkillList,
    skillFilterKeyword,
    wantsMcpToolList,
    mcpToolFilterKeyword,
    wantsMcpNotSkillsCorrection,
    wantsStats,
    wantsSource,
    wantsCitations,
    wantsProvenance,
    wantsDocSource,
    wantsCrossEngramSearch,
    wantsExplicitSkillWalk,
    wantsExhaustive: wantsExhaustive || wantsTeamRoster || (hasQuotedSearch && !skipMemoryTools),
    wantsGrouped,
    wantsTeamRoster,
    wantsTeamTaskList,
    wantsProjectTaskList,
    wantsTemporalTodos,
    asksForRoles,
    wantsPersonRole,
    wantsPersonInContext,
    wantsTopicAbout,
    wantsDefinitional,
    wantsStructuredRecall,
    hasQuotedSearch,
    skipMemoryTools,
    wantsConversationContext,
    directAnswerKind,
    recallMaxNodes,
    recallMaxTokens,
    skipEnrichmentRecallOpts,
  };
}

/**
 * Expand recall queries for modes that need assignment/roster vocabulary in the
 * embedding — without changing what the user asked. Language-agnostic tokens.
 */
function isThinRecallContext(text: string | undefined): boolean {
  if (!text?.trim()) return true;
  const words = text.trim().replace(/[?.!]+$/, '').split(/\s+/).filter(Boolean);
  if (words.length >= 6) return false;
  const contentWords = words.filter((w) => !isRecallQueryStopWord(w.toLowerCase()));
  return contentWords.length < 3;
}

function extractSalientTokensFromSnippet(snippet: string, maxTokens = 8): string {
  const words = snippet
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !isRecallQueryStopWord(w.toLowerCase()));
  const seen = new Set<string>();
  const salient: string[] = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    salient.push(w);
    if (salient.length >= maxTokens) break;
  }
  return salient.join(' ');
}

export function buildGhampusRecallQuery(
  text: string,
  hints: GhampusQueryHints,
  opts?: { priorUserQuestion?: string; priorGhampusSnippet?: string },
): string {
  if (hints.wantsTopicAbout) {
    const topic = extractTopicAboutFromQuery(text);
    if (topic) {
      const prior = opts?.priorUserQuestion?.trim().replace(/[?.!]+$/, '');
      const parts = [topic];
      if (prior) parts.push(prior);
      if (isThinRecallContext(prior)) {
        const salient = extractSalientTokensFromSnippet(opts?.priorGhampusSnippet?.trim().slice(0, 200) ?? '');
        if (salient) parts.push(salient);
      }
      return parts.length > 1 ? parts.join(' ') : `${text} ${topic}`;
    }
  }
  if (hints.wantsPersonInContext) {
    const ctx = extractPersonInContextFromQuery(text);
    if (ctx) {
      const scopePart = ctx.scope ? ` ${ctx.scope}` : '';
      return `${text} ${ctx.person} role rol team echipa members${scopePart}`;
    }
  }
  if (hints.wantsPersonRole) {
    return `${text} role rol team echipa owners members assignee`;
  }
  if (hints.wantsTeamRoster) {
    return `${text} owners members roles roluri assignees board consilieri fondator`;
  }
  if (hints.wantsTeamTaskList || hints.wantsProjectTaskList || (hints.wantsGrouped && /\b(team|echipei|echipa|members?|membri|sarcini|tasks?|todos?)\b/i.test(text))) {
    return `${text} team members tasks deadlines owners assignees roles project`;
  }
  return text;
}

/** Save-confirmation questions — recall/verify, never remember. */
export function isSaveConfirmationQuestion(msg: string): boolean {
  const m = msg.trim();
  const lower = m.toLowerCase().replace(/[?.!]+$/, '');
  if (!/\b(save|saved|remember|remembered|store|stored|keep|kept|salvat|salvezi|salveaz[aă])\b/i.test(lower)) {
    return false;
  }
  return (
    /^(?:did\s+(?:you|u|we)|have\s+(?:you|u|we)|has\s+(?:it|that|this)|had\s+(?:you|u|we)|was\s+it|were\s+(?:they|those)|is\s+it)\b/i.test(lower)
    || /^(?:ai|a[tț]i|ati)\s+(?:salvat|[\u0103\u00e2]i\s+salvat|c[aă]\s+ai\s+salvat|ca\s+ai\s+salvat)/i.test(lower)
    || /^(?:l-ai|l'ai|le-ai)\s+salvat/i.test(lower)
    || /^(?:c[aă]\s+)?ai\s+(?:salvat|re[u\u021B]inut)/i.test(lower)
    || /^(?:a\s+fost|s-a)\s+salvat/i.test(lower)
    || (m.endsWith('?') && /^(?:did|have|has|had|was|were|is|ai|a[tț]i|c[aă])\b/i.test(lower))
  );
}

/** Question-shaped user message — recall, not save. */
export function isQuestionShapedMessage(msg: string): boolean {
  const m = msg.trim();
  const lower = m.toLowerCase();
  if (isSaveConfirmationQuestion(m)) return true;
  if (m.endsWith('?')) return true;
  const firstWord = (lower.split(/\s+/)[0] ?? '').replace(/[?.!,]+$/, '');
  if (MULTILINGUAL_QUESTION_OPENERS.has(firstWord)) return true;
  return /^(?:did|have|has|had|was|were|is|are|do|does|can|could|would|should|ai|a[tț]i|c[aă])\b/i.test(lower);
}

/** True when the user explicitly used a save verb (not fuzzy-matched). */
export function hasExplicitSaveVerb(msg: string): boolean {
  const lower = msg.trim().toLowerCase();
  if (isRemindMeRecallQuery(msg)) return false;
  if (isSaveConfirmationQuestion(msg)) return false;
  if (isQuestionShapedMessage(msg) && !/^(?:save|remember|store|salveaz[aă]?|aminte[sș]te|noteaz[aă]?)\b/i.test(lower)) {
    return false;
  }
  // "did you save" / "have you saved" — save token present but not an imperative.
  if (/^(?:did|have|has|had|was|were|ai|a[tț]i|c[aă])\b/i.test(lower)) return false;
  return /\b(remember|remmber|remeber|save|sav|store|keep|note|jot|noter|salva|guardar|speichern|записать|amintește|aminteste|notează|noteaza|salvează|salveaza|păstrează|pastreaza|enregistr|merken|zapisz|ricorda)\b/i.test(lower)
    && !isRemindMeRecallQuery(lower);
}

const VAGUE_REMEMBER_CONTENT_RE =
  /^(?:it|that|this|the same|same thing|asta|aceasta|acela|aceea|cel(?:a|e)?|cea|eso|esto|das|dies|dass|cel(?:a|e)?)$/i;

/** Content is a pronoun / deictic — needs conversation history. */
export function isVagueRememberContent(content: string): boolean {
  const t = content.trim().replace(/[?.!]+$/, '');
  if (!t) return true;
  return VAGUE_REMEMBER_CONTENT_RE.test(t);
}

/** Remember content would echo the user's question — never save. */
export function wouldSaveQuestionTextAsContent(userText: string, content: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(userText);
  const c = norm(content);
  if (!c) return true;
  if (c === q) return true;
  if (isSaveConfirmationQuestion(userText) && q.includes(c) && c.length >= 8) return true;
  if (isQuestionShapedMessage(userText) && c.length >= 12 && q.includes(c)) return true;
  return false;
}

/**
 * Correction opener + optional "save (it) to ENGRAM".
 * e.g. "no, ACME stands for … — if not in memory, save it to ACME"
 */
export function parseCorrectionSavePattern(msg: string): { content: string; engram: string | null } | null {
  const trimmed = msg.trim();
  if (!/^(?:no|nope|actually|in fact|wrong|incorrect|not quite)\b/i.test(trimmed)) return null;

  let body = trimmed;
  let engram: string | null = null;

  const saveTail = body.match(
    /(?:\s*[-–—]\s*|\s*,?\s*(?:if\s+(?:you\s+)?(?:don'?t|do not)\s+(?:find|have)\s+[^,]+,?\s*)?)(?:save|remember|store|salveaz[aă]?|aminte[sș]te)\s+(?:it\s+)?(?:to|in|into|în|in)\s+["']?([A-Za-z][\w\s.-]{0,40})["']?\s*$/i,
  );
  if (saveTail?.[1]) {
    engram = trimGreedyEngramHint(saveTail[1].trim());
    body = body.slice(0, saveTail.index).trim();
  }

  body = body.replace(/^(?:no|nope|actually|in fact|wrong|incorrect|not quite)[,.]?\s*/i, '').trim();
  body = body.replace(/\s*[-–—]\s*if\s+(?:you\s+)?(?:don'?t|do not)\s+(?:find|have)\s+.+$/i, '').trim();

  if (body.length < 5) return null;

  const looksLikeFact =
    /\b(?:stands for|stand for|means|is short for|refers to|represents|should be|is actually|not)\b/i.test(body)
    || /^[A-Z]{2,}\d*\s+(?:stands for|is|means)\b/i.test(body);

  if (!looksLikeFact && !engram) return null;
  return { content: body, engram };
}

/** Edit/correct/fix memory — routes to correction flow, not remember. */
export function parseEditIntent(msg: string): { correction: string; engram: string | null } | null {
  const m = msg.trim();
  if (isSaveConfirmationQuestion(m) || isRemindMeRecallQuery(m)) return null;

  const editOpen =
    /^(?:edit|correct|fix|update|change|editeaz[aă]|corectez[aă]?|repar[aă]?|actualizeaz[aă]?)\b/i.test(m)
    || /^(?:change|update)\s+(?:what\s+(?:I|you)\s+(?:said|saved|remembered))/i.test(m);

  if (!editOpen) return null;

  const memoryScoped =
    /^(?:edit|correct|fix|update)\s+(?:the\s+)?(?:role|name|date|fact|info|information|details?|memory|memories|note|notes|entry|record|acronym|title|spelling)/i.test(m)
    || /^(?:edit|correct|fix|update)\s+(?:my\s+)?(?:memory|memories|note|notes)/i.test(m)
    || /^(?:editeaz[aă]|corectez[aă]?|actualizeaz[aă]?)\b/i.test(m)
    || /^(?:change|update)\s+(?:what\s+(?:I|you)\s+(?:said|saved|remembered))/i.test(m)
    || /\b(?:memory|memorie|not[aăe]|rolul|rol\b|role|acronym|acronim)\b/i.test(m);

  if (!memoryScoped) return null;

  const engramM = m.match(/\b(?:in|to|into|în|in)\s+["']?([A-Za-z][\w-]+)["']?\s*$/i);
  return { correction: m, engram: engramM?.[1] ? trimGreedyEngramHint(engramM[1]) : null };
}

/** @deprecated alias */
export const wantsEditOrCorrect = parseEditIntent;

/** Resolve vague "it/that/this" from recent Ghampus thread. */
export function resolveRememberContentFromHistory(
  _vagueContent: string,
  history: GhampusHistTurn[],
): string | null {
  const turns = history
    .filter((t) => (t.kind === 'user' || t.kind === 'ghampus') && (t.text ?? '').trim())
    .slice(-5);

  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.kind !== 'user') continue;
    const text = t.text!.trim();
    if (text.length < 8) continue;
    if (/^(?:save|remember|did you|have you|ai salvat)\b/i.test(text)) continue;
    const correction = parseCorrectionSavePattern(text);
    if (correction) return correction.content;
    if (/^(?:no|actually|nope)\b/i.test(text) || /\bstands for\b/i.test(text)) return text;
    return text;
  }

  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.kind === 'ghampus' && (t.text ?? '').length >= 20) {
      return t.text!.trim().slice(0, 500);
    }
  }
  return null;
}

/** Task/todo list lookup — structural match in any language. */
export function isTaskListQuery(msg: string): boolean {
  return isScopedTaskListQuery(msg);
}

/** First words that must never fuzzy-match save verbs (todo ≈ store, liste ≈ save). */
export const FUZZY_SAVE_BLOCKLIST = new Set([
  'todo', 'todos', 'task', 'tasks', 'taskuri', 'taskurile', 'list', 'lists', 'listing',
  'show', 'shows', 'find', 'search', 'give', 'get', 'tell', 'look', 'any', 'all',
  'sarcini', 'sarcinile', 'sarcina', 'tâches', 'taches', 'tareas', 'aufgaben',
  'membri', 'membru', 'echipa', 'echipei', 'roluri', 'rolurile', 'rol',
  'skills', 'skill', 'skilluri', 'skillurile',
  ...MULTILINGUAL_QUESTION_OPENERS,
]);

/** @deprecated use FUZZY_SAVE_BLOCKLIST */
const RECALL_FIRST_WORDS = FUZZY_SAVE_BLOCKLIST;

/** If classified as remember but the message is a lookup/question, force recall. */
export function coerceRecallIfTaskListQuery(intent: GhampusIntent, msg: string): GhampusIntent {
  if (intent.action !== 'remember' && intent.action !== 'edit') return intent;
  if (intent.action === 'edit') return intent;
  if (isSaveConfirmationQuestion(msg)) return { action: 'recall' };
  if (wouldSaveQuestionTextAsContent(msg, intent.content)) return { action: 'recall' };
  if (hasExplicitSaveVerb(msg)) return intent;
  const firstWord = (msg.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[?.!,]+$/, '');
  if (FUZZY_SAVE_BLOCKLIST.has(firstWord) || isMultilingualListVerbFirstWord(firstWord)) {
    return { action: 'recall' };
  }
  if (isTaskListQuery(msg)) return { action: 'recall' };
  if (questionIntent(msg)?.action === 'recall') return { action: 'recall' };
  if (isDefinitionalQuery(msg) || extractTopicAboutFromQuery(msg)) return { action: 'recall' };
  if (/\b(todos?|tasks?|sarcini(?:le)?|taskuri(?:le)?|list|show|find|who|what|cine|care|ce)\b/i.test(msg)) {
    return { action: 'recall' };
  }
  return intent;
}

/** Keyword path — instant, no LLM. */
export function keywordIntent(msg: string): GhampusIntent | null {
  const m = msg.trim();
  const firstWord = (m.split(/\s+/)[0] ?? '').toLowerCase();
  if (isRemindMeRecallQuery(m)) return null;
  if (isSaveConfirmationQuestion(m)) return null;

  const editParsed = parseEditIntent(m);
  if (editParsed) return { action: 'edit', ...editParsed };

  const correctionSave = parseCorrectionSavePattern(m);
  if (correctionSave) {
    return { action: 'remember', content: correctionSave.content, engram: correctionSave.engram };
  }

  // Recall/list verbs must not fuzzy-match save verbs (todos ≈ store, listează ≈ salvează).
  if (FUZZY_SAVE_BLOCKLIST.has(firstWord) || isMultilingualListVerbFirstWord(firstWord)) return null;
  if (/^list\b/i.test(firstWord)) return null;
  const verbScores: Record<string, string[]> = {
    remember: ['remember', 'remeber', 'remmber', 'remmeber', 'remmbr', 'remb', 'recuerda', 'noter', 'запомни', 'merkt', 'amintește', 'aminteste', 'aminti'],
    save: ['save', 'sav', 'saev', 'store', 'stor', 'keep', 'kep', 'note', 'jot', 'add', 'salva', 'speichern', 'zapisz', 'notează', 'noteaza', 'salvează', 'salveaza', 'păstrează', 'pastreaza'],
    create: ['create', 'creat', 'crete', 'make', 'mak', 'new', 'add', 'build', 'créer', 'erstell', 'crea'],
    delete: ['delete', 'delet', 'remove', 'remov', 'drop', 'erase', 'del'],
  };
  const isVerb = (target: keyof typeof verbScores) =>
    (verbScores[target] ?? []).some((v) => {
      if (firstWord === v) return true;
      if (FUZZY_SAVE_BLOCKLIST.has(firstWord)) return false;
      if (Math.abs(firstWord.length - v.length) > 3) return false;
      let common = 0;
      for (const c of firstWord) if (v.includes(c)) common++;
      return common / Math.max(firstWord.length, v.length) >= 0.6;
    });

  const lower = m.toLowerCase();
  const hasEngramWord = /\bengram\b/.test(lower);

  if (isVerb('create') && hasEngramWord) {
    const nameM = m.match(/(?:engram\s+)?(?:called|named|:)?\s*["']?([^"'\n]{1,60})["']?\s*$/i);
    const name = nameM?.[1]?.trim() ?? '';
    if (name && !/^engram$/i.test(name)) return { action: 'create_engram', name };
  }
  if (isVerb('delete') && hasEngramWord) {
    return { action: 'ui_only', reason: 'engram deletion requires Memory Studio' };
  }
  if (isVerb('remember') || isVerb('save')) {
    const afterVerb = m.replace(/^\S+\s+/, '');
    const inTo = parseRememberInToPattern(afterVerb);
    if (inTo) {
      return { action: 'remember', content: inTo.content, engram: inTo.engram };
    }
    const contentFirst = parseRememberContentFirstPattern(afterVerb);
    if (contentFirst) {
      return { action: 'remember', content: contentFirst.content, engram: contentFirst.engram };
    }
    const itToEngram = afterVerb.match(
      /^(?:it|that|this|asta|aceasta)\s+(?:to|in|into|în|in)\s+(.+)$/i,
    );
    if (itToEngram?.[1]) {
      return {
        action: 'remember',
        content: afterVerb.match(/^(it|that|this|asta|aceasta)/i)?.[1] ?? 'it',
        engram: trimGreedyEngramHint(itToEngram[1].trim()),
      };
    }
    const bareMatch = afterVerb.match(/^(?:that\s+|c[aă]\s+)?(.+)$/i);
    const bare = bareMatch?.[1]?.trim() ?? '';
    if (bare.length >= 3) return { action: 'remember', content: bare, engram: null };
  }
  return null;
}

/** Question-shaped messages → recall before keyword save heuristics. */
export function questionIntent(msg: string): GhampusIntent | null {
  const m = msg.trim();
  const lower = m.toLowerCase();
  // "Remind me …" / "amintește-mi …" — recall, not save
  if (isRemindMeRecallQuery(m)) return { action: 'recall' };
  if (isSaveConfirmationQuestion(m)) return { action: 'recall' };
  if (/^ce (știi|stii) despre\b/i.test(m)) return { action: 'recall' };
  if (/^(?:qu[e']?\s+sais-tu|qu[eé]\s+sabes|was\s+wei[sß]t\s+du)\s+/i.test(m)) return { action: 'recall' };
  const hasSaveVerb = hasExplicitSaveVerb(m);
  if (hasSaveVerb) return null;
  if (TASK_NOUN_RE.test(m) && TASK_SCOPE_PREPOSITIONS.test(m)) {
    return { action: 'recall' };
  }
  if (/^remember\s+(when|the\s+time|that\s+night|that\s+day|how|why|who|where)/i.test(m)) return { action: 'recall' };
  if (/^(do you|don't you|dont you|can you|could you)\s+(remember|recall|find|tell|show)/i.test(m)) return { action: 'recall' };
  if (/^(what about|how about|tell me about|anything (on|about|for|in)|what'?s\b|what (is|are|do|did|can|could|was|were|have)\b|how (do|did|is|are|many|much|come)\b|who (is|are|was|were|did|has|have)\b|where (is|are|was|were|did)\b|when (did|was|were|is|are|do|does)\b|why (did|is|are|was|were|do|does)\b|which\b|show me|find (me |out |the )?|look up|search (for |the )?|do i (have|know|remember|own|need)\b|is there\b|are there\b|give me\b|list (my |the |all )?|any info|can i\b|could i\b|would\b|should\b|how to\b)/i.test(lower)) {
    return { action: 'recall' };
  }
  if (isDefinitionalQuery(m)) return { action: 'recall' };
  if (extractTopicAboutFromQuery(m)) return { action: 'recall' };
  // Multilingual question openers (first word)
  const firstWord = (lower.split(/\s+/)[0] ?? '').replace(/[?.!,]+$/, '');
  if (MULTILINGUAL_QUESTION_OPENERS.has(firstWord)) return { action: 'recall' };
  if (/^(spune-mi|dis-moi|dime|erz[aä]hl)\b/i.test(lower)) return { action: 'recall' };
  if (m.endsWith('?') && m.split(/\s+/).length <= 5) return { action: 'recall' };
  if (m.endsWith('?') && !m.includes(':')) return { action: 'recall' };
  return null;
}

export function detectKeywordIntent(msg: string): GhampusIntent {
  const intent = questionIntent(msg) ?? keywordIntent(msg) ?? { action: 'recall' };
  return coerceRecallIfTaskListQuery(intent, msg);
}

const VALID_ACTIONS = new Set(['remember', 'edit', 'create_engram', 'ui_only', 'recall']);

export function parseClassifyIntent(rawJson: string): (GhampusIntent & { confidence?: number }) | null {
  const jsonMatch = rawJson.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as GhampusIntent & { confidence?: number };
    if (!VALID_ACTIONS.has(parsed.action)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function buildClassifySystemPrompt(engramList: string, recentContext = ''): string {
  return (
    'Intent classifier for Graphnosis (personal knowledge graph). ' +
    'Output ONLY a single JSON object — no prose, no code fences, no explanation.\n' +
    'Always include a "confidence" field (0.0–1.0) — how certain you are about the action.\n\n' +
    GHAMPUS_DOMAIN_GLOSSARY_BLOCK + '\n\n' +
    'Schemas:\n' +
    '{"action":"remember","content":"TEXT_TO_SAVE","engram":"ENGRAM_NAME_OR_NULL","confidence":0.95}\n' +
    '{"action":"edit","correction":"CORRECTION_TEXT","engram":"ENGRAM_NAME_OR_NULL","confidence":0.9}\n' +
    '{"action":"create_engram","name":"ENGRAM_NAME","confidence":0.9}\n' +
    '{"action":"ui_only","reason":"engram deletion requires UI"|"rename requires UI"|"merge requires UI","confidence":0.9}\n' +
    '{"action":"recall","confidence":0.85}\n\n' +
    'Rules — apply even with heavy spelling errors or any language:\n' +
    '• Save verbs → action=remember: remember/save/store/note/add/keep/jot/noter/salva/guardar/speichern/записать + all typos (remmber, remeber, sav, stor…)\n' +
    '• "did you save" / "was it saved" / "ai salvat" → action=recall (verification), NEVER remember.\n' +
    '• edit/correct/fix/update memory or role/fact → action=edit with correction=full user text.\n' +
    '• NEVER action=remember for task/todo LIST queries: "todos for X", "tasks for Y", "sarcini pentru Z", "list todos", "show tasks" — these are recall.\n' +
    '• "todo"/"todos" is NOT a save verb — it means task list lookup.\n' +
    '• create/make/new/creat/créer/erstell + engram → action=create_engram\n' +
    '• delete/remove/rename/merge + engram → action=ui_only\n' +
    '• QUESTION RULE: Any message shaped as a question → action=recall, even if it mentions a known engram name.\n' +
    '• CONTEXT RULE: If history shows a recall exchange immediately before, a short follow-up continues recall — do NOT classify as remember.\n' +
    '• Any other message → action=recall\n\n' +
    'Confidence guidance:\n' +
    '• Explicit save verb present → confidence ≥ 0.9\n' +
    '• Clear question word present → confidence ≥ 0.9\n' +
    '• No clear verb, ambiguous noun/phrase → confidence ≤ 0.6\n' +
    '• Short message with no verb and no question mark → confidence ≤ 0.5\n' +
    '• Single entity name (no verb, no ?) → confidence 0.4\n\n' +
    'Engram extraction (for action=remember — only when a genuine save verb is present):\n' +
    '• "verb in/to/into X that Y"  → engram=X (short name only, 1–4 words)  content=Y (everything after "that")\n' +
    '• "verb in/to/into X: Y"      → engram=X  content=Y\n' +
    '• "verb în X că Y" (Romanian) → engram=X  content=Y (everything after "că")\n' +
    '• "verb Y in/to/into X"        → content=Y  engram=X\n' +
    '• "verb Y" with no target      → content=Y  engram=null\n' +
    '• STOP engram at " that ", " că ", ":", " – " — never include note text in engram.\n' +
    '• Example: "remember in BookNotesApp that Morgan hosted…" → engram="BookNotesApp" content="Morgan hosted…"\n' +
    '• If content is unclear (user wrote "save this" with no text) → action=recall\n' +
    `• Known engrams (match names to these when obvious): ${engramList || 'none'}\n` +
    '• content must not be empty for action=remember. If you cannot extract content, use action=recall instead.' +
    recentContext
  );
}

export const LLM_PLACEHOLDERS = new Set(['ENGRAM_NAME_OR_NULL', 'TEXT_TO_SAVE', 'ENGRAM_NAME', 'NULL', 'null', '']);
