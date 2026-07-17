/**
 * Ghampus intent guardrails — session 2026-06-20 patterns
 *
 * Single gate before remember/save execution and before raw recall dumps.
 * Fixes fuzzy save misclassification (todo≈store), question-shaped saves,
 * and formatter bypass in emitRawRecallFallback.
 */

import {
  detectGhampusQueryHints,
  extractPersonInContextFromQuery,
  FUZZY_SAVE_BLOCKLIST,
  hasExplicitSaveVerb,
  isSaveConfirmationQuestion,
  isScopedSearchInEngramQuery,
  isTaskListQuery,
  questionIntent,
  wouldSaveQuestionTextAsContent,
  type GhampusIntent,
  type GhampusQueryHints,
} from './ghampus-intent.js';
import {
  isMultilingualListVerbFirstWord,
  isMultilingualSearchVerbFirstWord,
  MULTILINGUAL_RECALL_QUESTION_RE,
  TASK_NOUN_RE,
  TASK_DEADLINE_NOUN_RE,
  TEAM_NOUN_RE,
} from './ghampus-language.js';
import {
  extractPersonNamesFromQuery,
  extractTeamRosterEntries,
  formatGroupedRecallList,
  formatPersonInContextAnswer,
  formatPersonRoleAnswer,
  formatTeamRosterList,
  formatTeamRosterWithRoles,
  formatProjectTodosAnswer,
  formatTeamTasksByPerson,
  extractProjectScopeFromQuery,
  type StructuredRecallNode,
} from './ghampus-recall-format.js';

/** Re-export blocklist for tests importing from guards. */
export { FUZZY_SAVE_BLOCKLIST };

/** Alias — explicit save verb required before remember. */
export function isExplicitSaveIntent(text: string): boolean {
  return hasExplicitSaveVerb(text);
}

function normalizedFirstWord(text: string): string {
  return (text.trim().split(/\s+/)[0] ?? '').toLowerCase().replace(/[?.!,]+$/, '');
}

/** True when the first token is a recall/list/question opener — never fuzzy-match save verbs. */
export function isBlocklistedFirstWord(text: string): boolean {
  const first = normalizedFirstWord(text);
  if (!first) return false;
  if (FUZZY_SAVE_BLOCKLIST.has(first)) return true;
  if (isMultilingualListVerbFirstWord(first)) return true;
  if (isMultilingualSearchVerbFirstWord(first)) return true;
  return false;
}

function isQuestionOrLookupShaped(text: string, hints: GhampusQueryHints): boolean {
  if (questionIntent(text)?.action === 'recall') return true;
  if (isTaskListQuery(text)) return true;
  if (hints.wantsProjectTaskList || hints.wantsSkillList || hints.wantsMcpToolList || hints.wantsTeamRoster) return true;
  if (hints.wantsTeamTaskList || hints.wantsPersonRole || hints.wantsPersonInContext) return true;
  if (hints.wantsTopicAbout || hints.wantsDefinitional) return true;
  if (/\b(todos?|tasks?|list|show|find|search|give me|tell me|what|who|which)\b/i.test(text)
    || TASK_NOUN_RE.test(text)
    || MULTILINGUAL_RECALL_QUESTION_RE.test(text)) {
    return !hasExplicitSaveVerb(text);
  }
  return false;
}

/**
 * Coerce misclassified remember → recall before any save path.
 * Combines task-list, question, list verbs, blocklisted first words, and hint routes.
 */
export function coerceRecallGuards(
  intent: GhampusIntent,
  text: string,
  hints?: GhampusQueryHints,
): GhampusIntent {
  if (intent.action === 'edit') return intent;
  if (intent.action !== 'remember') return intent;
  if (isSaveConfirmationQuestion(text)) return { action: 'recall' };
  if (intent.content && wouldSaveQuestionTextAsContent(text, intent.content)) return { action: 'recall' };
  if (isExplicitSaveIntent(text)) return intent;

  const h = hints ?? detectGhampusQueryHints(text);

  if (isBlocklistedFirstWord(text)) return { action: 'recall' };
  if (isTaskListQuery(text)) return { action: 'recall' };
  if (isQuestionOrLookupShaped(text, h)) return { action: 'recall' };
  if (/\b(todos?|tasks?|list|show|find|who|what|which)\b/i.test(text) || TASK_NOUN_RE.test(text)) {
    return { action: 'recall' };
  }
  return { action: 'recall' };
}

/** @deprecated alias — use coerceRecallGuards */
export const coerceRecallIfMisclassified = coerceRecallGuards;

/** Single gate before action execution — always call after LLM/keyword classify. */
export function finalizeGhampusIntent(
  text: string,
  intent: GhampusIntent,
  hints?: GhampusQueryHints,
): GhampusIntent {
  if (isSaveConfirmationQuestion(text)) return { action: 'recall' };
  if (intent.action === 'create_engram' && isScopedSearchInEngramQuery(text)) {
    return { action: 'recall' };
  }
  const h = hints ?? detectGhampusQueryHints(text);
  const coerced = coerceRecallGuards(intent, text, h);
  if (coerced.action === 'remember') {
    const { content } = coerced;
    if (wouldSaveQuestionTextAsContent(text, content)) return { action: 'recall' };
    if (!content?.trim()) return { action: 'recall' };
  }
  return coerced;
}

/** True when a deterministic formatter should handle the answer (no raw node dump). */
export function hasFormatterRoute(
  hints: GhampusQueryHints,
  nodes: StructuredRecallNode[],
): boolean {
  if (hints.wantsSkillList) return true;
  if (hints.wantsMcpToolList) return true;
  if (hints.wantsPersonInContext || hints.wantsPersonRole) return nodes.length > 0;
  if (hints.wantsTeamRoster) return nodes.length > 0;
  if (hints.wantsTeamTaskList || hints.wantsProjectTaskList) return nodes.length > 0;
  if (hints.wantsDefinitional) return nodes.length > 0;
  if (hints.wantsTopicAbout) return nodes.length > 0;
  if (hints.wantsGrouped && nodes.length > 0) return true;
  if (hints.wantsExhaustive && nodes.length > 0 && !hints.wantsDefinitional) return true;
  return false;
}

/**
 * Raw structured dump policy for emitRawRecallFallback.
 * Returns false when any formatter route applies — never dump in those cases.
 */
export function shouldUseStructuredDump(
  _text: string,
  hints: GhampusQueryHints,
  nodes: StructuredRecallNode[],
): boolean {
  if (hasFormatterRoute(hints, nodes)) return false;
  if (hints.wantsPersonInContext || hints.wantsPersonRole) return false;
  if (nodes.length === 0) return false;
  return true;
}

export type FormatterFallbackOpts = {
  text: string;
  hints: GhampusQueryHints;
  nodes: StructuredRecallNode[];
  primaryRecall?: string;
  asksForRoles?: boolean;
};

/**
 * Try deterministic formatters before falling back to structured dump or prose.
 * Returns null when no formatter produced an answer.
 */
export function tryFormatterFallback(opts: FormatterFallbackOpts): string | null {
  const { text, hints, nodes, asksForRoles } = opts;
  if (nodes.length === 0) return null;

  if (hints.wantsTeamRoster) {
    return asksForRoles
      ? formatTeamRosterWithRoles(nodes, text)
      : formatTeamRosterList(nodes, text);
  }

  if (hints.wantsPersonRole || hints.wantsPersonInContext) {
    const personCtx = extractPersonInContextFromQuery(text);
    const persons = extractPersonNamesFromQuery(text);
    const targetPerson =
      personCtx?.person
      ?? persons.find((p: string) => p.includes(' '))
      ?? persons[0];
    if (targetPerson) {
      if (hints.wantsPersonRole && !hints.wantsPersonInContext) {
        return formatPersonRoleAnswer(targetPerson, nodes, text);
      }
      return formatPersonInContextAnswer(targetPerson, nodes, text)
        ?? formatPersonRoleAnswer(targetPerson, nodes, text);
    }
  }

  if (hints.wantsProjectTaskList || hints.wantsTemporalTodos) {
    return formatProjectTodosAnswer(nodes, text, extractProjectScopeFromQuery(text))
      ?? formatTeamTasksByPerson(nodes, text);
  }

  if (hints.wantsTeamTaskList) {
    return formatTeamTasksByPerson(nodes, text);
  }

  if (hints.wantsGrouped) {
    return formatGroupedRecallList(nodes, text);
  }

  if (hints.wantsDefinitional || hints.wantsTopicAbout) {
    const top = nodes.slice(0, 5).map((n) => `- ${(n.text ?? '').trim().replace(/\s+/g, ' ')}`).join('\n');
    if (top) return top;
  }

  // Any task/todo question ("list my todos", "what are my todos?") — format as
  // todos, never as a roster and never via LLM synthesis: todo bullets
  // ("Calendar — fix sync") match the roster "Name — role" shape, and synthesis
  // pads thin recall with invented items.
  if (TASK_NOUN_RE.test(text) || TASK_DEADLINE_NOUN_RE.test(text)) {
    return formatProjectTodosAnswer(nodes, text, extractProjectScopeFromQuery(text))
      ?? formatTeamTasksByPerson(nodes, text);
  }

  if (
    hints.wantsExhaustive
    && TEAM_NOUN_RE.test(text)
    && extractTeamRosterEntries(nodes).length >= 2
  ) {
    return asksForRoles
      ? formatTeamRosterWithRoles(nodes, text)
      : formatTeamRosterList(nodes, text);
  }

  // No raw structured dump here — send-flow synthesizes + finalize when no formatter matches.
  return null;
}

/** dig_deeper token ceiling — escalation guardrail (session 2026-06-20). */
export const DIG_DEEPER_MAX_TOKENS = 4000;

export function clampDigDeeperMaxTokens(requested: number, structured = false): number {
  const cap = structured ? DIG_DEEPER_MAX_TOKENS : Math.min(DIG_DEEPER_MAX_TOKENS, 3000);
  return Math.min(Math.max(1, requested), cap);
}
