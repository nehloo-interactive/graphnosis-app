/**
 * Ghampus recall tool planning — per-tool query args before ghampusTool() runs.
 * Deterministic for known intents; LLM-planned for open questions.
 */

import type { DirectAnswerKind } from './ghampus-direct-answer.js';
import type { LocalLlm } from './correction.js';
import { llmCompleteBounded } from './ghampus-timeout.js';
import { TASK_NOUN_RE, TASK_DEADLINE_NOUN_RE } from './ghampus-language.js';
import {
  buildGhampusRecallQuery,
  detectGhampusQueryHints,
  extractEngramScopeFromQuery,
  extractPersonInContextFromQuery,
  extractQuotedPhrases,
  extractSalientRecallTokens,
  extractTopicAboutFromQuery,
  type GhampusQueryHints,
} from './ghampus-intent.js';
import { clampDigDeeperMaxTokens } from './ghampus-intent-guards.js';
import { isThinRecallContext } from './ghampus-grounding.js';
import {
  extractPersonNamesFromQuery,
  extractProjectScopeFromQuery,
  filterStructuredRecallNodes,
  inferTeamLabelFromQuery,
  type StructuredRecallNode,
} from './ghampus-recall-format.js';

export type GhampusToolPlanEntry = {
  tool: string;
  args: Record<string, unknown>;
  label?: string;
  phase: 1 | 2;
  optional?: boolean;
};

export type GhampusToolPlan = {
  /** Skip recall/LLM entirely — ipc handles via early route */
  earlyRoute?: 'skill-list' | 'skill-walk' | 'skill-train' | 'mcp-tool-list' | 'slash' | 'direct-answer' | 'consistency-walk';
  phase1: GhampusToolPlanEntry[];
  phase2: GhampusToolPlanEntry[];
  userText: string;
  /** Primary semantic query for matching checks (recallContextMatchesQuery) */
  recallContextQuery?: string;
  /** After phase-1 recall, prefer recall_source on this sourceId (how-to path). */
  preferRecallSourceId?: boolean;
  directAnswerKind?: DirectAnswerKind | null;
  /** Implicit skill-dispatch match — walk this slug when earlyRoute is skill-walk. */
  implicitSkillSlug?: string | null;
};

const LLM_TOOL_ALLOWLIST = new Set([
  'recall',
  'dig_deeper',
  'recall_structured',
  'list_engrams',
  'list_skills',
  'stats',
  'recent',
  'find_source',
  'cross_search',
  'recall_with_citations',
]);

const MCP_RECALL_MAX_TOKENS = 8000;
const MCP_RECALL_MAX_NODES = 50;

export type PlanGhampusToolsOpts = {
  scopedEngrams?: string[];
  /** All loaded engram graphIds — required for cross_search planning. */
  allEngramIds?: string[];
  /** Personal/public engrams only — optional cross_search escalation skips sensitive tier. */
  crossSearchEngramIds?: string[];
  /** Prior user turn — expands topic-about follow-ups ("what about Anca?"). */
  priorUserQuestion?: string;
  /** Last Ghampus answer before current turn — salient tokens when prior question is thin. */
  priorGhampusSnippet?: string;
};

/** First non-skill sourceId from MCP recall wire format — for how-to find_source follow-up. */
export function extractTopSourceIdFromRecallPrompt(prompt: string, excludeSkills = true): string | null {
  for (const m of prompt.matchAll(/src:([^\]]+)/g)) {
    const ref = m[1]?.trim() ?? '';
    if (!ref) continue;
    if (excludeSkills && /^skill:/i.test(ref)) continue;
    return ref;
  }
  return null;
}

function crossSearchEngrams(opts?: PlanGhampusToolsOpts): string[] {
  return opts?.crossSearchEngramIds ?? opts?.allEngramIds ?? [];
}

function extractHowToSourceKeywords(text: string): string {
  const salient = extractSalientRecallTokens(text);
  if (salient.length >= 1) return salient.slice(0, 4).join(' ');
  return extractSourceKeywords(text);
}

/** Primary person name from the query (title-cased when extractable). */
export function extractPersonFromQuery(text: string): string | null {
  const ctx = extractPersonInContextFromQuery(text);
  if (ctx?.person) return ctx.person;
  const names = extractPersonNamesFromQuery(text);
  return names.find((n) => n.includes(' ')) ?? names[0] ?? null;
}

/** Org/engram scope string from person-in-context or engram slug mentions. */
export function extractOrgScope(text: string, engramIds: string[] = []): string[] {
  const ctx = extractPersonInContextFromQuery(text);
  const fromQuery = extractEngramScopeFromQuery(text, engramIds);
  const out = new Set(fromQuery);
  if (ctx?.scope) {
    const scopeSlug = ctx.scope.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (scopeSlug.length >= 2) out.add(scopeSlug);
    for (const id of engramIds) {
      const slug = id.toLowerCase();
      const spaced = slug.replace(/-/g, ' ');
      const scopeLower = ctx.scope.toLowerCase();
      if (slug.includes(scopeLower.replace(/[^a-z0-9]+/g, ''))
        || (spaced.length >= 4 && scopeLower.includes(spaced))) {
        out.add(id);
      }
    }
  }
  return [...out];
}

function entityFocusedQuery(text: string): string {
  const salient = extractSalientRecallTokens(text);
  if (salient.length >= 2) return salient.slice(0, 6).join(' ');
  const trimmed = text.trim();
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

function extractSourceKeywords(text: string): string {
  return text
    .replace(/source|file|document|attachment|pdf|url|link|ref|show me|find|get/gi, '')
    .trim()
    .slice(0, 80);
}

function withEngramScope(
  args: Record<string, unknown>,
  scopedEngrams?: string[],
): Record<string, unknown> {
  if (!scopedEngrams?.length) return args;
  return { ...args, only_engrams: scopedEngrams };
}

function recallArgs(
  query: string,
  hints: GhampusQueryHints,
  scopedEngrams?: string[],
  overrides?: { maxNodes?: number; maxTokens?: number },
): Record<string, unknown> {
  return withEngramScope(
    {
      query,
      maxNodes: overrides?.maxNodes ?? hints.recallMaxNodes,
      maxTokens: overrides?.maxTokens ?? hints.recallMaxTokens,
      ...hints.skipEnrichmentRecallOpts,
    },
    scopedEngrams,
  );
}

function digDeeperArgs(
  query: string,
  hints: GhampusQueryHints,
  scopedEngrams?: string[],
  overrides?: { maxNodes?: number; maxTokens?: number },
): Record<string, unknown> {
  const maxTokens = clampDigDeeperMaxTokens(
    overrides?.maxTokens ?? hints.recallMaxTokens,
    hints.wantsStructuredRecall,
  );
  return recallArgs(query, hints, scopedEngrams, {
    maxNodes: overrides?.maxNodes ?? hints.recallMaxNodes,
    maxTokens,
  });
}

function structuredArgs(
  query: string,
  hints: GhampusQueryHints,
  scopedEngrams?: string[],
  maxNodes?: number,
): Record<string, unknown> {
  return withEngramScope(
    {
      query,
      maxNodes: maxNodes ?? (hints.wantsStructuredRecall ? hints.recallMaxNodes : 25),
    },
    scopedEngrams,
  );
}

const QUERY_REQUIRED_TOOLS = new Set([
  'recall',
  'dig_deeper',
  'recall_structured',
  'cross_search',
  'recall_with_citations',
]);

/** Every recall-family plan entry must carry a non-empty query string. */
function ensureToolQuery(
  tool: string,
  args: Record<string, unknown>,
  userText: string,
  hints: GhampusQueryHints,
): void {
  if (!QUERY_REQUIRED_TOOLS.has(tool)) return;
  const q = String(args.query ?? '').trim();
  if (q.length >= 1) return;
  args.query = buildRecallQueryForTool(tool, userText, hints).slice(0, 500);
}

/** Backfill missing recall queries on every plan entry (LLM planner safety net). */
export function ensurePlanRecallQueries(plan: GhampusToolPlan, hints: GhampusQueryHints): void {
  for (const e of [...plan.phase1, ...plan.phase2]) {
    ensureToolQuery(e.tool, e.args, plan.userText, hints);
  }
}

/**
 * Purpose-built recall query per tool — not a copy-paste of user text.
 */
export function buildRecallQueryForTool(
  tool: string,
  text: string,
  hints: GhampusQueryHints,
): string {
  const person = extractPersonFromQuery(text);
  const personCtx = extractPersonInContextFromQuery(text);
  const quoted = extractQuotedPhrases(text);
  const teamLabel = inferTeamLabelFromQuery(text);

  if (hints.hasQuotedSearch && quoted.length > 0) {
    const phrase = quoted[0]!;
    if (tool === 'recall_structured') return phrase;
    if (tool === 'dig_deeper') return `${phrase} exact phrase memory`;
    return phrase;
  }

  if (hints.wantsTeamRoster) {
    if (tool === 'recall_structured') {
      const label = teamLabel ?? 'team';
      return `${label} roles roluri members owners roster membri echipa`;
    }
    if (tool === 'dig_deeper') {
      return `${text} team members owners roles roluri membri echipa board consilieri`;
    }
    return `${text} owners members roles roluri assignees board consilieri fondator`;
  }

  if (hints.wantsTopicAbout || hints.wantsDefinitional) {
    const topic = extractTopicAboutFromQuery(text) ?? text.trim();
    if (tool === 'recall_structured') return entityFocusedQuery(topic);
    if (tool === 'dig_deeper') return `${topic} definition role description`;
    return topic;
  }

  if (hints.wantsPersonInContext && personCtx) {
    const scopePart = personCtx.scope ? ` ${personCtx.scope}` : '';
    if (tool === 'recall_structured') return personCtx.person;
    if (tool === 'dig_deeper') return `${personCtx.person} ${personCtx.scope ?? ''} role team echipa`.trim();
    return `${text} ${personCtx.person} role rol team echipa members${scopePart}`;
  }

  if (hints.wantsPersonRole) {
    if (tool === 'recall_structured') return person ?? entityFocusedQuery(text);
    if (tool === 'dig_deeper') {
      return person
        ? `${person} role rol poziție funcție title job`
        : `${text} role rol assignee owner`;
    }
    return `${text} role rol team echipa owners members assignee`;
  }

  if (hints.wantsTeamTaskList || hints.wantsProjectTaskList || (hints.wantsGrouped && /\b(team|echipei|echipa|members?|membri|sarcini|tasks?|todos?)\b/i.test(text))) {
    if (tool === 'recall_structured') return entityFocusedQuery(text);
    if (tool === 'dig_deeper') return `${text} tasks deadlines assignees owners roles team members project`;
    return `${text} team members tasks deadlines owners assignees roles project`;
  }

  if (hints.wantsDocSource) {
    const focused = entityFocusedQuery(text);
    if (tool === 'recall_structured') return focused;
    if (tool === 'dig_deeper') return `${focused} setup configuration steps settings`;
    return text;
  }

  if (hints.wantsCrossEngramSearch) {
    const topic = extractTopicAboutFromQuery(text) ?? entityFocusedQuery(text);
    if (tool === 'recall_structured') return topic;
    if (tool === 'dig_deeper') return `${topic} related context details`;
    return topic;
  }

  if (tool === 'recall_structured') return entityFocusedQuery(text);
  if (tool === 'dig_deeper') return buildGhampusRecallQuery(text, hints);
  return text;
}

function entry(
  tool: string,
  args: Record<string, unknown>,
  phase: 1 | 2,
  optional?: boolean,
  label?: string,
): GhampusToolPlanEntry {
  return { tool, args, phase, ...(optional ? { optional: true } : {}), ...(label ? { label } : {}) };
}

/** True when the query is asking about the user's own todos/tasks/deadlines
 * (as opposed to, say, docs or roster questions that happen to share nouns).
 * Also used to route away from the free-form LLM tool planner (see
 * hasStrongStructuredIntent) — the planner's schema has no engram-scoping
 * field, and it commonly picks find_source/dig_deeper unscoped, which can
 * take 20s+ scanning the bundled docs/skill-demos engrams for a query that
 * can never find a todo there. */
export function detectTodoIntentQuery(text: string, hints: GhampusQueryHints): boolean {
  return Boolean(
    hints.wantsTemporalTodos || hints.wantsProjectTaskList || hints.wantsTeamTaskList
      || TASK_NOUN_RE.test(text) || TASK_DEADLINE_NOUN_RE.test(text),
  );
}

function hasStrongStructuredIntent(text: string, hints: GhampusQueryHints): boolean {
  return hints.wantsMcpToolList
    || hints.wantsSkillList
    || hints.wantsExplicitSkillWalk
    || hints.wantsImplicitSkillWalk
    || hints.wantsTeamRoster
    || hints.wantsPersonRole
    || hints.wantsPersonInContext
    || hints.wantsTopicAbout
    || hints.wantsDefinitional
    || hints.wantsTeamTaskList
    || hints.wantsProjectTaskList
    || hints.wantsDocSource
    || hints.wantsCrossEngramSearch
    || hints.wantsProvenance
    || (hints.wantsExhaustive && hints.hasQuotedSearch)
    || hints.wantsStats
    || hints.wantsRecent
    || hints.wantsSource
    || detectTodoIntentQuery(text, hints);
}

function appendCitationAndSourcePhase2(
  phase2: GhampusToolPlanEntry[],
  text: string,
  hints: GhampusQueryHints,
  skipDigDeeper = false,
): void {
  if (hints.wantsCitations || hints.wantsProvenance) {
    phase2.push(entry(
      'recall_with_citations',
      { query: text, maxNodes: 10, maxTokens: 1500 },
      2,
      true,
      'recall_with_citations',
    ));
  }
  void skipDigDeeper;
}

export function planGhampusTools(
  text: string,
  hints: GhampusQueryHints,
  opts?: PlanGhampusToolsOpts,
): GhampusToolPlan {
  const scoped = opts?.scopedEngrams;
  const userText = text;

  if (hints.skipMemoryTools && hints.directAnswerKind) {
    return {
      earlyRoute: 'direct-answer',
      phase1: [],
      phase2: [],
      userText,
      directAnswerKind: hints.directAnswerKind,
    };
  }

  if (hints.wantsMcpToolList) {
    return {
      earlyRoute: 'mcp-tool-list',
      phase1: [],
      phase2: [],
      userText,
    };
  }

  if (hints.wantsSkillTrain) {
    return {
      earlyRoute: 'skill-train',
      phase1: [],
      phase2: [],
      userText,
    };
  }

  if (hints.wantsSkillList) {
    return {
      earlyRoute: 'skill-list',
      phase1: [],
      phase2: [],
      userText,
    };
  }

  if (hints.wantsImplicitSkillWalk && hints.implicitSkillSlug) {
    return {
      earlyRoute: 'skill-walk',
      phase1: [],
      phase2: [],
      userText,
      implicitSkillSlug: hints.implicitSkillSlug,
    };
  }

  if (hints.wantsConsistencyWalk) {
    return {
      earlyRoute: 'consistency-walk',
      phase1: [],
      phase2: [],
      userText,
    };
  }

  if (hints.wantsExplicitSkillWalk) {
    return {
      earlyRoute: 'skill-walk',
      phase1: [],
      phase2: [],
      userText,
    };
  }

  const recallContextQuery = buildGhampusRecallQuery(
    text,
    hints,
    opts?.priorUserQuestion || opts?.priorGhampusSnippet
      ? {
          ...(opts.priorUserQuestion ? { priorUserQuestion: opts.priorUserQuestion } : {}),
          ...(opts.priorGhampusSnippet ? { priorGhampusSnippet: opts.priorGhampusSnippet } : {}),
        }
      : undefined,
  );

  if (hints.wantsStats) {
    return {
      phase1: [entry('list_engrams', {}, 1)],
      phase2: [entry('stats', {}, 2)],
      userText,
      recallContextQuery: text,
    };
  }

  if (hints.wantsRecent) {
    return {
      phase1: [
        entry('list_engrams', {}, 1),
        entry('recent', { limit: 20 }, 1),
      ],
      phase2: [],
      userText,
      recallContextQuery: text,
    };
  }

  if (hints.wantsProvenance || hints.wantsCitations) {
    const phase1: GhampusToolPlanEntry[] = [
      entry('recall', recallArgs(text, hints, scoped, { maxNodes: 20, maxTokens: 2500 }), 1, false, 'recall'),
      entry('list_engrams', {}, 1),
    ];
    const phase2: GhampusToolPlanEntry[] = [
      entry(
        'recall_with_citations',
        { query: text, maxNodes: 10, maxTokens: 1500 },
        2,
        false,
        'recall_with_citations',
      ),
      entry(
        'recall_structured',
        structuredArgs(entityFocusedQuery(text), hints, scoped, 15),
        2,
        true,
        'recall_structured',
      ),
    ];
    return { phase1, phase2, userText, recallContextQuery: text };
  }

  if (hints.wantsSource) {
    const srcKw = extractSourceKeywords(text);
    const phase1: GhampusToolPlanEntry[] = [entry('list_engrams', {}, 1)];
    if (srcKw.length > 2) {
      phase1.push(entry('find_source', { content: srcKw }, 1));
    }
    return {
      phase1,
      phase2: [
        entry('recall', recallArgs(text, hints, scoped), 2),
      ],
      userText,
      recallContextQuery: text,
    };
  }

  if (hints.wantsCrossEngramSearch && !scoped?.length) {
    const topic = extractTopicAboutFromQuery(text) ?? entityFocusedQuery(text);
    const engramIds = opts?.allEngramIds ?? [];
    const phase1: GhampusToolPlanEntry[] = [
      entry(
        'recall',
        recallArgs(buildRecallQueryForTool('recall', text, hints), hints),
        1,
        false,
        'recall',
      ),
      entry('list_engrams', {}, 1),
    ];
    const phase2: GhampusToolPlanEntry[] = [];
    if (engramIds.length > 0) {
      phase2.push(entry(
        'cross_search',
        { query: topic, engrams: engramIds, maxNodes: hints.recallMaxNodes },
        2,
        false,
        'cross_search',
      ));
    }
    phase2.push(entry(
      'recall_structured',
      structuredArgs(buildRecallQueryForTool('recall_structured', text, hints), hints),
      2,
      false,
      'recall_structured',
    ));
    appendCitationAndSourcePhase2(phase2, text, hints);
    return { phase1, phase2, userText, recallContextQuery: topic };
  }

  if (hints.wantsDocSource) {
    const recallQ = buildRecallQueryForTool('recall', text, hints);
    const structQ = buildRecallQueryForTool('recall_structured', text, hints);
    const digQ = buildRecallQueryForTool('dig_deeper', text, hints);
    const srcKw = extractHowToSourceKeywords(text);
    const phase1: GhampusToolPlanEntry[] = [
      entry(
        'recall',
        recallArgs(recallQ, hints, scoped, { maxNodes: 25, maxTokens: 3000 }),
        1,
        false,
        'recall',
      ),
      entry('list_engrams', {}, 1),
    ];
    const phase2: GhampusToolPlanEntry[] = [
      entry(
        'recall_structured',
        structuredArgs(structQ, hints, scoped, 20),
        2,
        false,
        'recall_structured',
      ),
      entry(
        'dig_deeper',
        digDeeperArgs(digQ, hints, scoped, { maxNodes: 25, maxTokens: 2500 }),
        2,
        true,
        'dig_deeper',
      ),
    ];
    if (srcKw.length > 2) {
      phase2.push(entry('find_source', { content: srcKw, limit: 3 }, 2, true, 'find_source'));
    }
    appendCitationAndSourcePhase2(phase2, text, hints);
    return {
      phase1,
      phase2,
      userText,
      recallContextQuery: text,
      preferRecallSourceId: true,
    };
  }

  if (hints.wantsTeamRoster) {
    const phase1: GhampusToolPlanEntry[] = [
      entry(
        'recall',
        recallArgs(buildRecallQueryForTool('recall', text, hints), hints, scoped),
        1,
      ),
      entry('list_engrams', {}, 1),
    ];
    const phase2: GhampusToolPlanEntry[] = [
      entry(
        'dig_deeper',
        digDeeperArgs(buildRecallQueryForTool('dig_deeper', text, hints), hints, scoped, {
          maxNodes: hints.recallMaxNodes,
          maxTokens: hints.recallMaxTokens,
        }),
        2,
      ),
      entry(
        'recall_structured',
        structuredArgs(buildRecallQueryForTool('recall_structured', text, hints), hints, scoped),
        2,
      ),
    ];
    appendCitationAndSourcePhase2(phase2, text, hints);
    return { phase1, phase2, userText, recallContextQuery };
  }

  if (hints.wantsPersonRole) {
    const phase1 = [
      entry(
        'recall',
        recallArgs(buildRecallQueryForTool('recall', text, hints), hints, scoped),
        1,
      ),
      entry('list_engrams', {}, 1),
    ];
    const phase2 = [
      entry(
        'dig_deeper',
        digDeeperArgs(buildRecallQueryForTool('dig_deeper', text, hints), hints, scoped, {
          maxNodes: 30,
          maxTokens: 3000,
        }),
        2,
      ),
      entry(
        'recall_structured',
        structuredArgs(
          buildRecallQueryForTool('recall_structured', text, hints),
          hints,
          scoped,
          20,
        ),
        2,
      ),
    ];
    appendCitationAndSourcePhase2(phase2, text, hints);
    return { phase1, phase2, userText, recallContextQuery };
  }

  if (hints.wantsPersonInContext) {
    const orgScope = scoped?.length ? scoped : undefined;
    const phase1 = [
      entry(
        'recall',
        recallArgs(buildRecallQueryForTool('recall', text, hints), hints, orgScope),
        1,
      ),
      entry('list_engrams', {}, 1),
    ];
    const phase2 = [
      entry(
        'dig_deeper',
        digDeeperArgs(buildRecallQueryForTool('dig_deeper', text, hints), hints, orgScope, {
          maxNodes: 30,
          maxTokens: 3000,
        }),
        2,
      ),
      entry(
        'recall_structured',
        structuredArgs(
          buildRecallQueryForTool('recall_structured', text, hints),
          hints,
          orgScope,
          20,
        ),
        2,
      ),
    ];
    appendCitationAndSourcePhase2(phase2, text, hints);
    return { phase1, phase2, userText, recallContextQuery };
  }

  if (hints.wantsTemporalTodos) {
    const dueWithinDays = /\btomorrow\b/i.test(text) ? 2 : /\btoday\b/i.test(text) ? 1 : 7;
    return {
      // A real scoped `recall` in phase1 (not just recall_obligations/
      // recall_structured, both phase2) matters beyond finding content here —
      // appendPostRecallEscalation decides whether to pile on dig_deeper +
      // recall-unscoped + cross_search purely from phase1 results. Without a
      // recall entry, extractRecallMetricsFromResults always sees nodeCount 0
      // and unconditionally escalates, even when this branch's own phase2
      // tools would have found the answer — costing ~20s of guaranteed
      // escalation calls on every single temporal-todo query, hit or miss.
      phase1: [
        entry('recall', recallArgs(buildRecallQueryForTool('recall', text, hints), hints, scoped, {
          maxNodes: hints.recallMaxNodes,
          maxTokens: hints.recallMaxTokens,
        }), 1, true, 'recall'),
        entry('list_engrams', {}, 1),
      ],
      phase2: [
        entry('recall_obligations', { due_within_days: dueWithinDays, max_results: 30 }, 2),
        entry(
          'recall_structured',
          structuredArgs(buildRecallQueryForTool('recall_structured', text, hints), hints, scoped),
          2,
          true,
          'recall_structured',
        ),
      ],
      userText,
      recallContextQuery: text,
    };
  }

  if (hints.wantsTeamTaskList || hints.wantsProjectTaskList) {
    const projectScope = extractProjectScopeFromQuery(text);
    const srcContent = projectScope
      ? `${projectScope} todos tasks TODO checklist sarcini`
      : extractSourceKeywords(text);
    // Same reasoning as the wantsTemporalTodos branch above: without a real
    // `recall` in phase1, appendPostRecallEscalation always sees nodeCount 0
    // (recall_structured/find_source don't count) and unconditionally appends
    // dig_deeper + recall-unscoped + cross_search — ~20s of guaranteed
    // escalation on every call, regardless of whether recall_structured below
    // already finds the answer.
    const phase1: GhampusToolPlanEntry[] = [
      entry('recall', recallArgs(buildRecallQueryForTool('recall', text, hints), hints, scoped, {
        maxNodes: hints.recallMaxNodes,
        maxTokens: hints.recallMaxTokens,
      }), 1, true, 'recall'),
      entry('list_engrams', {}, 1),
    ];
    // find_source's MCP schema takes one `engram` string, not an only_engrams
    // array — it can't be scoped to "every user engram except the bundled
    // docs/skill-demos ones." Passing no engram means it embedding-searches
    // EVERY graph including the docs bundle (observed: 20s+ alone). So: scope
    // it when there's exactly one target engram, and skip it outright rather
    // than run it unscoped when there are several (recall_structured/dig_deeper
    // below already cover this query with proper multi-engram scoping).
    if (srcContent.length > 2 && (scoped?.length ?? 0) <= 1) {
      phase1.unshift(entry(
        'find_source',
        { content: srcContent, limit: 5, ...(scoped?.length === 1 ? { engram: scoped[0] } : {}) },
        1,
        false,
        'find_source',
      ));
    }
    const phase2: GhampusToolPlanEntry[] = [
      entry(
        'recall_structured',
        structuredArgs(buildRecallQueryForTool('recall_structured', text, hints), hints, scoped),
        2,
        false,
        'recall_structured',
      ),
    ];
    if (!hints.wantsProjectTaskList) {
      phase2.unshift(entry(
        'dig_deeper',
        digDeeperArgs(buildRecallQueryForTool('dig_deeper', text, hints), hints, scoped, {
          maxNodes: hints.recallMaxNodes,
          maxTokens: hints.recallMaxTokens,
        }),
        2,
        true,
        'dig_deeper',
      ));
      phase1.push(entry(
        'recall',
        recallArgs(buildRecallQueryForTool('recall', text, hints), hints, scoped),
        1,
        true,
        'recall',
      ));
    }
    appendCitationAndSourcePhase2(phase2, text, hints);
    return { phase1, phase2, userText, recallContextQuery };
  }

  if (hints.wantsExhaustive && hints.hasQuotedSearch) {
    const phase1 = [
      entry(
        'recall',
        recallArgs(buildRecallQueryForTool('recall', text, hints), hints, scoped),
        1,
      ),
      entry('list_engrams', {}, 1),
    ];
    const phase2 = [
      entry(
        'dig_deeper',
        digDeeperArgs(buildRecallQueryForTool('dig_deeper', text, hints), hints, scoped, {
          maxNodes: hints.recallMaxNodes,
          maxTokens: hints.recallMaxTokens,
        }),
        2,
      ),
      entry(
        'recall_structured',
        structuredArgs(buildRecallQueryForTool('recall_structured', text, hints), hints, scoped),
        2,
      ),
    ];
    appendCitationAndSourcePhase2(phase2, text, hints);
    return { phase1, phase2, userText, recallContextQuery: quotedPhraseContext(text) };
  }

  if (hints.wantsTopicAbout || hints.wantsDefinitional) {
    const priorContext = [opts?.priorUserQuestion, opts?.priorGhampusSnippet]
      .filter((s): s is string => Boolean(s?.trim()))
      .join(' ');
    const engramScope = scoped?.length
      ? scoped
      : priorContext.length > 0
        ? extractOrgScope(priorContext, opts?.allEngramIds ?? [])
        : undefined;
    const scopedForRecall = engramScope?.length ? engramScope : scoped;
    const recallQ = buildRecallQueryForTool('recall', text, hints);
    const contextualQ = priorContext.length > 0 ? recallContextQuery : recallQ;
    const digQ = priorContext.length > 0
      ? recallContextQuery
      : buildRecallQueryForTool('dig_deeper', text, hints);
    const structQ = priorContext.length > 0
      ? recallContextQuery
      : buildRecallQueryForTool('recall_structured', text, hints);
    const planRecallContextQuery = priorContext.length > 0 ? recallContextQuery : recallQ;
    const phase1: GhampusToolPlanEntry[] = [
      entry(
        'recall',
        recallArgs(contextualQ, hints, scopedForRecall),
        1,
      ),
      entry('list_engrams', {}, 1),
    ];
    const phase2: GhampusToolPlanEntry[] = [
      entry(
        'dig_deeper',
        digDeeperArgs(digQ, hints, scopedForRecall, {
          maxNodes: hints.recallMaxNodes,
          maxTokens: Math.min(hints.recallMaxTokens, 3000),
        }),
        2,
        true,
        'dig_deeper',
      ),
      entry(
        'recall_structured',
        structuredArgs(structQ, hints, scopedForRecall),
        2,
        true,
        'recall_structured',
      ),
    ];
    appendCitationAndSourcePhase2(phase2, text, hints);
    return { phase1, phase2, userText, recallContextQuery: planRecallContextQuery };
  }

  if (hints.wantsThreadGrounding && hints.threadPriorUserQuestion) {
    const contextualQ = recallContextQuery;
    const phase1: GhampusToolPlanEntry[] = [
      entry('recall', recallArgs(contextualQ, hints, scoped), 1),
      entry('list_engrams', {}, 1),
    ];
    const phase2: GhampusToolPlanEntry[] = [
      entry(
        'dig_deeper',
        digDeeperArgs(contextualQ, hints, scoped, {
          maxNodes: hints.recallMaxNodes,
          maxTokens: Math.min(hints.recallMaxTokens, 4000),
        }),
        2,
        true,
        'dig_deeper',
      ),
      entry(
        'recall_structured',
        structuredArgs(contextualQ, hints, scoped),
        2,
        true,
        'recall_structured',
      ),
    ];
    appendCitationAndSourcePhase2(phase2, text, hints);
    return { phase1, phase2, userText, recallContextQuery: contextualQ };
  }

  // Default open question
  const phase1: GhampusToolPlanEntry[] = [
    entry('recall', recallArgs(text, hints, scoped), 1),
    entry('list_engrams', {}, 1),
  ];
  if (hints.wantsSkills && !hints.wantsDocSource && !hints.wantsRecent) {
    phase1.push(entry('list_skills', {}, 1));
  }

  const phase2: GhampusToolPlanEntry[] = [
    entry(
      'dig_deeper',
      digDeeperArgs(buildRecallQueryForTool('dig_deeper', text, hints), hints, scoped, {
        maxNodes: hints.recallMaxNodes,
        maxTokens: Math.min(hints.recallMaxTokens, 3000),
      }),
      2,
      true,
      'dig_deeper',
    ),
    entry(
      'recall_structured',
      structuredArgs(buildRecallQueryForTool('recall_structured', text, hints), hints, scoped),
      2,
      true,
    ),
  ];
  appendCitationAndSourcePhase2(phase2, text, hints);
  if (hints.wantsSource) {
    const srcKw = extractSourceKeywords(text);
    if (srcKw.length > 2) {
      phase2.push(entry('find_source', { content: srcKw }, 2, true));
    }
  }

  return {
    phase1,
    phase2,
    userText,
    recallContextQuery: text,
  };
}

function quotedPhraseContext(text: string): string {
  const q = extractQuotedPhrases(text);
  return q[0] ?? text;
}

type LlmPlanRow = {
  tool?: string;
  query?: string;
  content?: string;
  maxNodes?: number;
  maxTokens?: number;
  limit?: number;
  optional?: boolean;
};

type LlmPlanJson = {
  phase1?: LlmPlanRow[];
  phase2?: LlmPlanRow[];
  recallContextQuery?: string;
};

function clampNum(n: unknown, max: number, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

function rowToEntry(
  row: LlmPlanRow,
  phase: 1 | 2,
  hints: GhampusQueryHints,
  userText: string,
  scoped?: string[],
): GhampusToolPlanEntry | null {
  const tool = String(row.tool ?? '').trim();
  if (!LLM_TOOL_ALLOWLIST.has(tool)) return null;
  const args: Record<string, unknown> = {};
  if (row.query) args.query = String(row.query).slice(0, 500);
  if (row.content) args.content = String(row.content).slice(0, 200);
  if (tool === 'recall' || tool === 'dig_deeper') {
    args.maxNodes = clampNum(row.maxNodes, MCP_RECALL_MAX_NODES, hints.recallMaxNodes);
    const defaultTokens = tool === 'dig_deeper'
      ? clampDigDeeperMaxTokens(hints.recallMaxTokens, hints.wantsStructuredRecall)
      : hints.recallMaxTokens;
    args.maxTokens = clampNum(row.maxTokens, MCP_RECALL_MAX_TOKENS, defaultTokens);
    if (tool === 'dig_deeper') {
      args.maxTokens = clampDigDeeperMaxTokens(Number(args.maxTokens), hints.wantsStructuredRecall);
    }
    Object.assign(args, hints.skipEnrichmentRecallOpts);
  }
  if (tool === 'recall_structured') {
    args.maxNodes = clampNum(row.maxNodes, MCP_RECALL_MAX_NODES, 25);
  }
  if (tool === 'cross_search') {
    args.maxNodes = clampNum(row.maxNodes, MCP_RECALL_MAX_NODES, hints.recallMaxNodes);
  }
  if (tool === 'recall_with_citations') {
    args.maxNodes = clampNum(row.maxNodes, MCP_RECALL_MAX_NODES, 10);
    args.maxTokens = clampNum(row.maxTokens, MCP_RECALL_MAX_TOKENS, 1500);
  }
  if (tool === 'recent') args.limit = clampNum(row.limit, 50, 10);
  ensureToolQuery(tool, args, userText, hints);
  const optional = row.optional === true || (tool === 'recall_structured' && phase === 2);
  return entry(tool, withEngramScope(args, scoped), phase, optional);
}

function parseLlmPlanJson(raw: string): LlmPlanJson | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as LlmPlanJson;
  } catch {
    return null;
  }
}

function planFromLlmJson(
  parsed: LlmPlanJson,
  text: string,
  hints: GhampusQueryHints,
  scoped?: string[],
): GhampusToolPlan | null {
  const phase1: GhampusToolPlanEntry[] = [];
  const phase2: GhampusToolPlanEntry[] = [];
  for (const row of parsed.phase1 ?? []) {
    const e = rowToEntry(row, 1, hints, text, scoped);
    if (e) phase1.push(e);
  }
  for (const row of parsed.phase2 ?? []) {
    const e = rowToEntry(row, 2, hints, text, scoped);
    if (e) phase2.push(e);
  }
  if (phase1.length === 0 && phase2.length === 0) return null;
  if (!phase1.some((e) => e.tool === 'recall') && !phase2.some((e) => e.tool === 'recall')) {
    phase1.unshift(entry('recall', recallArgs(text, hints, scoped), 1));
  }
  if (!phase1.some((e) => e.tool === 'list_engrams')) {
    phase1.push(entry('list_engrams', {}, 1));
  }
  if (
    !phase1.some((e) => e.tool === 'recall_structured')
    && !phase2.some((e) => e.tool === 'recall_structured')
  ) {
    phase2.push(
      entry(
        'recall_structured',
        structuredArgs(buildRecallQueryForTool('recall_structured', text, hints), hints, scoped),
        2,
        true,
        'recall_structured',
      ),
    );
  }
  const plan: GhampusToolPlan = {
    phase1,
    phase2,
    userText: text,
    recallContextQuery: parsed.recallContextQuery?.trim() || text,
  };
  ensurePlanRecallQueries(plan, hints);
  return plan;
}

export type PlanGhampusToolsWithLlmOpts = PlanGhampusToolsOpts & {
  engramList?: string;
};

export function planHasDigDeeper(plan: GhampusToolPlan): boolean {
  return [...plan.phase1, ...plan.phase2].some((e) => e.tool === 'dig_deeper');
}

export function countStructuredNodesFromResults(
  results: Array<{ tool: string; result: unknown }>,
  userText: string,
): number {
  for (const r of results) {
    if (r.tool === 'recall_structured') {
      const data = r.result as { nodes?: StructuredRecallNode[] };
      return filterStructuredRecallNodes(data?.nodes ?? [], userText).length;
    }
  }
  return 0;
}

export function extractRecallMetricsFromResults(
  results: Array<{ tool: string; result: unknown }>,
): { promptLen: number; nodeCount: number } {
  let promptLen = 0;
  let nodeCount = 0;
  for (const r of results) {
    if (r.tool === 'recall' || r.tool === 'remind' || r.tool === 'cross_search' || r.tool === 'dig_deeper') {
      const res = r.result as { prompt?: string; nodesIncluded?: number };
      const prompt = res?.prompt ?? '';
      if (prompt.length > promptLen) promptLen = prompt.length;
      nodeCount = Math.max(nodeCount, Number(res?.nodesIncluded ?? 0));
    }
    if (r.tool === 'recall_structured') {
      const data = r.result as { nodes?: StructuredRecallNode[]; nodesIncluded?: number };
      nodeCount = Math.max(nodeCount, Number(data?.nodesIncluded ?? data?.nodes?.length ?? 0));
    }
  }
  return { promptLen, nodeCount };
}

/** True when any recall-family tool returned attested nodes. */
export function hasRecallHitsFromResults(results: Array<{ tool: string; result: unknown }>): boolean {
  return extractRecallMetricsFromResults(results).nodeCount > 0;
}

function planHasTool(plan: GhampusToolPlan, tool: string): boolean {
  return [...plan.phase1, ...plan.phase2].some((e) => e.tool === tool);
}

function planHasRecallQuery(plan: GhampusToolPlan, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return [...plan.phase1, ...plan.phase2].some((e) => {
    if (!['recall', 'dig_deeper', 'cross_search', 'recall_structured'].includes(e.tool)) return false;
    return String(e.args.query ?? '').trim().toLowerCase() === q;
  });
}

/** Alternate queries when the first scoped recall misses (entity focus, spacing, event terms). */
export function buildAlternateRecallQueries(text: string, hints: GhampusQueryHints): string[] {
  const out = new Set<string>();
  const entity = entityFocusedQuery(text);
  if (entity.length >= 3 && entity !== text.trim()) out.add(entity);

  const spacedBrand = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (spacedBrand !== text) {
    const focused = entityFocusedQuery(spacedBrand);
    if (focused.length >= 3) out.add(focused);
  }

  if (/\bunpublished\s*connect\b/i.test(text) || /\bunpublishedconnect\b/i.test(text)) {
    out.add('UnpublishedCONNECT first edition host hosted venue');
    out.add('unpublished connect first edition hosted host');
  }

  if (/\bhosted\b/i.test(text) && /\b(first|edition|inaugural)\b/i.test(text)) {
    out.add(`${entityFocusedQuery(text)} host hosted venue organizer`);
  }

  if (hints.wantsDefinitional || /\bwho\b/i.test(text)) {
    const salient = extractSalientRecallTokens(text).slice(0, 4).join(' ');
    if (salient.length >= 3) out.add(salient);
  }

  return [...out].filter((q) => q.trim().length >= 3).slice(0, 4);
}

/**
 * Phase-1 recall returned zero nodes — broaden search before phase-2 runs.
 * Returns true when entries were appended.
 */
export function appendEmptyRecallEscalation(
  plan: GhampusToolPlan,
  hints: GhampusQueryHints,
  scopedEngrams: string[] | undefined,
  allEngramIds: string[] | undefined,
  crossSearchEngramIds?: string[],
): boolean {
  if (hints.skipMemoryTools || hints.wantsRecent) return false;
  const csEngrams = crossSearchEngramIds ?? allEngramIds;
  // "Unscoped" here means "widen to every engram this turn considers in
  // scope" — NOT "remove all restriction." When allEngramIds has already been
  // narrowed (e.g. system engrams excluded for a todo-intent query), widening
  // to it must stay narrowed too, or every escalation wave quietly re-admits
  // the excluded engrams and the original scoping is defeated call by call.
  const widenScope = allEngramIds?.length ? allEngramIds : undefined;

  let appended = false;

  if (!planHasTool(plan, 'recall_structured')) {
    plan.phase2.push(
      entry(
        'recall_structured',
        structuredArgs(
          buildRecallQueryForTool('recall_structured', plan.userText, hints),
          hints,
          scopedEngrams,
        ),
        2,
        true,
        'recall_structured-empty',
      ),
    );
    appended = true;
  }

  if (scopedEngrams?.length && allEngramIds?.length) {
    const entityQ = buildRecallQueryForTool('recall', plan.userText, hints);
    if (!planHasRecallQuery(plan, entityQ)) {
      plan.phase2.unshift(
        entry(
          'recall',
          recallArgs(entityQ, hints, widenScope, {
            maxNodes: hints.recallMaxNodes,
            maxTokens: hints.recallMaxTokens,
          }),
          2,
          true,
          'recall-unscoped',
        ),
      );
      appended = true;
    }

    if (!planHasTool(plan, 'cross_search')) {
      const topic = entityFocusedQuery(plan.userText);
      plan.phase2.push(
        entry(
          'cross_search',
          { query: topic, engrams: csEngrams, maxNodes: hints.recallMaxNodes },
          2,
          true,
          'cross_search-empty',
        ),
      );
      appended = true;
    }
  } else if (!planHasTool(plan, 'cross_search') && (csEngrams?.length ?? 0) >= 2) {
    plan.phase2.push(
      entry(
        'cross_search',
        recallArgs(
          buildRecallQueryForTool('cross_search', plan.userText, hints),
          hints,
          widenScope,
          { maxNodes: hints.recallMaxNodes, maxTokens: hints.recallMaxTokens },
        ),
        2,
        true,
        'cross_search-empty',
      ),
    );
    appended = true;
  }

  for (const altQ of buildAlternateRecallQueries(plan.userText, hints)) {
    if (planHasRecallQuery(plan, altQ)) continue;
    plan.phase2.push(
      entry(
        'recall',
        recallArgs(altQ, hints, widenScope, {
          maxNodes: hints.recallMaxNodes,
          maxTokens: hints.recallMaxTokens,
        }),
        2,
        true,
        'recall-alt-query',
      ),
    );
    appended = true;
  }

  if (!planHasDigDeeper(plan)) {
    plan.phase2.unshift(
      entry(
        'dig_deeper',
        digDeeperArgs(
          buildRecallQueryForTool('dig_deeper', plan.userText, hints),
          hints,
          widenScope,
          { maxNodes: hints.recallMaxNodes, maxTokens: hints.recallMaxTokens },
        ),
        2,
        true,
        'dig_deeper-empty',
      ),
    );
    appended = true;
  } else if (scopedEngrams?.length) {
    const scopedDig = [...plan.phase1, ...plan.phase2].some(
      (e) => e.tool === 'dig_deeper' && Array.isArray(e.args.only_engrams) && e.args.only_engrams.length > 0,
    );
    if (scopedDig && !planHasRecallQuery(plan, buildRecallQueryForTool('dig_deeper', plan.userText, hints))) {
      plan.phase2.push(
        entry(
          'dig_deeper',
          digDeeperArgs(
            buildRecallQueryForTool('dig_deeper', plan.userText, hints),
            hints,
            widenScope,
            { maxNodes: hints.recallMaxNodes, maxTokens: hints.recallMaxTokens },
          ),
          2,
          true,
          'dig_deeper-unscoped',
        ),
      );
      appended = true;
    }
  }

  return appended;
}

/** Last-chance retries after phase-2 still returned zero nodes. */
export function buildPostEmptyRecallRetryEntries(
  plan: GhampusToolPlan,
  hints: GhampusQueryHints,
  scopedEngrams: string[] | undefined,
  allEngramIds: string[] | undefined,
  ranResults: Array<{ tool: string; result: unknown }>,
  crossSearchEngramIds?: string[],
): GhampusToolPlanEntry[] {
  if (hints.skipMemoryTools || hints.wantsRecent || hasRecallHitsFromResults(ranResults)) return [];
  const csEngrams = crossSearchEngramIds ?? allEngramIds;
  const widenScope = allEngramIds?.length ? allEngramIds : undefined;

  const entries: GhampusToolPlanEntry[] = [];
  const entityQ = entityFocusedQuery(plan.userText);
  const ranTools = new Set(ranResults.map((r) => r.tool));
  const ranQueries = new Set(
    ranResults.map((r) => String((r.result as { query?: string })?.query ?? '').toLowerCase()).filter(Boolean),
  );

  const hadScopedDig = [...plan.phase1, ...plan.phase2].some(
    (e) => e.tool === 'dig_deeper' && Array.isArray(e.args.only_engrams) && e.args.only_engrams.length > 0,
  );
  if (scopedEngrams?.length && hadScopedDig && !entries.some((e) => e.label === 'dig_deeper-unscoped-retry')) {
    entries.push(
      entry(
        'dig_deeper',
        digDeeperArgs(
          buildRecallQueryForTool('dig_deeper', plan.userText, hints),
          hints,
          widenScope,
          { maxNodes: hints.recallMaxNodes, maxTokens: hints.recallMaxTokens },
        ),
        2,
        true,
        'dig_deeper-unscoped-retry',
      ),
    );
  }

  if (!ranTools.has('cross_search') && (csEngrams?.length ?? 0) >= 2) {
    entries.push(
      entry(
        'cross_search',
        { query: entityQ, engrams: csEngrams, maxNodes: hints.recallMaxNodes },
        2,
        true,
        'cross_search-retry',
      ),
    );
  }

  for (const altQ of buildAlternateRecallQueries(plan.userText, hints)) {
    const altLower = altQ.toLowerCase();
    if (ranQueries.has(altLower)) continue;
    entries.push(
      entry(
        'recall',
        recallArgs(altQ, hints, widenScope, {
          maxNodes: hints.recallMaxNodes,
          maxTokens: hints.recallMaxTokens,
        }),
        2,
        true,
        'recall-alt-retry',
      ),
    );
    if (entries.length >= 3) break;
  }

  return entries;
}

/**
 * After phase-1 recall, escalate thin plans with dig_deeper (+ optional cross_search).
 * Returns true when entries were appended.
 */
export function appendPostRecallEscalation(
  plan: GhampusToolPlan,
  hints: GhampusQueryHints,
  structuredNodeCount: number,
  recallMetrics: { promptLen: number; nodeCount: number },
  scopedEngrams?: string[],
  allEngramIds?: string[],
  crossSearchEngramIds?: string[],
): boolean {
  if (hints.skipMemoryTools || hints.wantsRecent) return false;

  if (recallMetrics.nodeCount === 0) {
    return appendEmptyRecallEscalation(plan, hints, scopedEngrams, allEngramIds, crossSearchEngramIds);
  }

  if (planHasDigDeeper(plan)) return false;

  const thinStructured = isThinRecallContext(structuredNodeCount, false);
  const thinRecall = recallMetrics.promptLen < 280 && recallMetrics.nodeCount < 5;
  if (!thinStructured && !thinRecall) return false;

  plan.phase2.unshift(
    entry(
      'dig_deeper',
      digDeeperArgs(buildRecallQueryForTool('dig_deeper', plan.userText, hints), hints, scopedEngrams, {
        maxNodes: hints.recallMaxNodes,
        maxTokens: hints.recallMaxTokens,
      }),
      2,
      true,
      'dig_deeper',
    ),
  );

  const wantsCross = hints.wantsCrossEngramSearch
    || (scopedEngrams !== undefined && scopedEngrams.length >= 2);
  if (
    wantsCross
    && !plan.phase1.some((e) => e.tool === 'cross_search')
    && !plan.phase2.some((e) => e.tool === 'cross_search')
  ) {
    plan.phase2.push(
      entry(
        'cross_search',
        recallArgs(buildRecallQueryForTool('cross_search', plan.userText, hints), hints, scopedEngrams, {
          maxNodes: hints.recallMaxNodes,
          maxTokens: hints.recallMaxTokens,
        }),
        2,
        true,
      ),
    );
  }
  return true;
}

export function buildPostPhase2DigDeeperEntry(
  plan: GhampusToolPlan,
  hints: GhampusQueryHints,
  scopedEngrams?: string[],
): GhampusToolPlanEntry {
  return entry(
    'dig_deeper',
    digDeeperArgs(buildRecallQueryForTool('dig_deeper', plan.userText, hints), hints, scopedEngrams, {
      maxNodes: hints.recallMaxNodes,
      maxTokens: hints.recallMaxTokens,
    }),
    2,
    true,
    'dig_deeper-escalation',
  );
}

export async function planGhampusToolsWithLlm(
  text: string,
  hints: GhampusQueryHints,
  llm: LocalLlm,
  opts?: PlanGhampusToolsWithLlmOpts,
  signal?: AbortSignal,
): Promise<GhampusToolPlan> {
  if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
  if (hints.skipMemoryTools || hints.wantsSkillList || hints.wantsExplicitSkillWalk || hints.wantsImplicitSkillWalk || hints.wantsMcpToolList) {
    return planGhampusTools(text, hints, opts);
  }
  if (hasStrongStructuredIntent(text, hints)) {
    return planGhampusTools(text, hints, opts);
  }

  const system = (
    'Tool planner for Graphnosis Ghampus recall. Output ONLY one JSON object — no prose, no fences.\n' +
    'Pick MCP tools and purpose-built search queries (not copy-paste of the full user message when a shorter entity query works).\n\n' +
    'Schema:\n' +
    '{"recallContextQuery":"…","phase1":[{"tool":"recall","query":"…","maxNodes":20,"maxTokens":2000}],"phase2":[{"tool":"dig_deeper","query":"…","optional":true}]}\n\n' +
    'Allowed tools: recall, dig_deeper, recall_structured, list_engrams, list_skills, stats, recent, find_source, cross_search, recall_with_citations\n' +
    'maxTokens ≤ 8000, maxNodes ≤ 50. phase1 should include recall + list_engrams when searching memory.\n' +
    `Known engrams (reference): ${opts?.engramList || 'none'}`
  );

  try {
    const raw = await llmCompleteBounded(llm, {
      system,
      user: `User question:\n${text}`,
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    const parsed = parseLlmPlanJson(raw);
    if (parsed) {
      const fromLlm = planFromLlmJson(parsed, text, hints, opts?.scopedEngrams);
      if (fromLlm) return fromLlm;
    }
  } catch (e) {
    if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) throw e;
    /* fall through to heuristic plan */
  }

  return planGhampusTools(text, hints, opts);
}

/** Re-export for callers that only have raw text. */
export { detectGhampusQueryHints };
