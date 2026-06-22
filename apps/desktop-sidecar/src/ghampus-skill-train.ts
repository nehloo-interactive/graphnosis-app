/**
 * Ghampus skill train/walk routes — resolve skill by name, invoke train_skill / walk_skill MCP.
 */

import { baseSkillName } from './skill-trainer.js';
import type { ParsedSkillTrainIntent } from './ghampus-intent.js';
import { resolveEngramFromUserHint, type EngramListEntry } from './ghampus-engram-resolve.js';
import {
  filterSkillsByKeyword,
  normalizeSkillDisplayLabel,
  skillMatchesFilter,
} from './ghampus-recall-format.js';
import {
  askGhampusClarification,
  formatMcpErrorForUser,
  type GhampusPendingClarificationState,
} from './ghampus-clarification.js';
import {
  formatGhampusToolErrorPreview,
  ghampusTraceStepId,
  type GhampusTraceStep,
} from './ghampus-trace.js';

export type GhampusListedSkill = {
  label: string;
  sourceId?: string;
  engramName?: string;
  searchText?: string;
};

export type GhampusSkillRouteRunner = {
  ghampusTool: (name: string, toolArgs?: Record<string, unknown>) => Promise<unknown>;
  emitGhampusMsg: (text: string) => Promise<void>;
  emitTrace: (step: GhampusTraceStep) => void;
  setPendingClarification?: (v: GhampusPendingClarificationState | null) => void;
};

const SKILL_SEARCH_STOP_WORDS = new Set([
  'to', 'the', 'a', 'an', 'for', 'and', 'or', 'my', 'me', 'how', 'what', 'which',
  'find', 'finding', 'look', 'search', 'about', 'please', 'skill', 'sop',
]);

/** Strip NL filler ("to find bugs" → "bug") before fuzzy skill lookup. */
export function normalizeSkillSearchPhrase(phrase: string): string {
  let s = phrase.trim();
  if (!s) return s;
  s = s.replace(/^(?:to\s+)?(?:find|locate|look\s+for|search\s+for|get|show)\s+/i, '');
  s = s.replace(/^(?:for\s+)?(?:finding|fixing|debugging|investigating)\s+/i, '');
  const tokens = s
    .split(/\s+/)
    .map((t) => t.replace(/[^\w-]/g, ''))
    .filter((t) => t.length >= 2 && !SKILL_SEARCH_STOP_WORDS.has(t.toLowerCase()))
    .map((t) => {
      const lower = t.toLowerCase();
      if (lower.endsWith('bugs')) return 'bug';
      if (lower.endsWith('ies') && lower.length > 4) return `${lower.slice(0, -3)}y`;
      if (lower.endsWith('s') && lower.length > 3 && !lower.endsWith('ss')) return lower.slice(0, -1);
      return lower;
    });
  return tokens.join(' ').trim() || phrase.trim();
}

function findExactSkillAmong(
  skills: GhampusListedSkill[],
  needle: string,
): GhampusListedSkill | undefined {
  const normalized = needle.toLowerCase();
  return skills.find((s) => {
    const display = normalizeSkillDisplayLabel(s.label).toLowerCase();
    const base = baseSkillName(s.label).toLowerCase();
    return display === normalized
      || base === normalized
      || base.replace(/\s+/g, '-') === normalized.replace(/\s+/g, '-');
  });
}

export type GhampusSkillWalkResolution =
  | { kind: 'match'; skill: GhampusListedSkill }
  | { kind: 'ambiguous'; phrase: string; candidates: GhampusListedSkill[] }
  | { kind: 'none'; phrase: string };

/** Resolve a walk target via list_skills-style fuzzy match (stricter than train on ambiguity). */
export function resolveGhampusSkillWalkMatch(
  skills: GhampusListedSkill[],
  rawPhrase: string,
): GhampusSkillWalkResolution {
  const phrase = rawPhrase.trim();
  if (!phrase) return { kind: 'none', phrase: '' };

  const attempts = [...new Set(
    [phrase, normalizeSkillSearchPhrase(phrase)].filter(Boolean),
  )];

  for (const attempt of attempts) {
    const filtered = filterSkillsByKeyword(skills, attempt);
    if (filtered.length === 1) {
      const only = filtered[0];
      return only ? { kind: 'match', skill: only } : { kind: 'none', phrase };
    }
    if (filtered.length > 1) {
      const exact = findExactSkillAmong(filtered, attempt);
      if (exact) return { kind: 'match', skill: exact };
      return { kind: 'ambiguous', phrase, candidates: filtered };
    }
  }

  for (const attempt of attempts) {
    const fallback = findGhampusSkillMatch(skills, attempt);
    if (fallback?.sourceId) return { kind: 'match', skill: fallback };
  }

  return { kind: 'none', phrase };
}

/** Top fuzzy skill suggestions when no exact walk/train match. */
export function suggestGhampusSkillsForPhrase(
  skills: GhampusListedSkill[],
  rawPhrase: string,
  limit = 3,
): GhampusListedSkill[] {
  const phrase = rawPhrase.trim();
  if (!phrase || skills.length === 0) return skills.slice(0, limit);

  const attempts = [...new Set([phrase, normalizeSkillSearchPhrase(phrase)].filter(Boolean))];
  for (const attempt of attempts) {
    const filtered = filterSkillsByKeyword(skills, attempt);
    if (filtered.length > 0) return filtered.slice(0, limit);
  }

  const tokens = normalizeSkillSearchPhrase(phrase).split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return skills.slice(0, limit);

  const scored = skills
    .map((skill) => {
      const hay = (skill.searchText ?? skill.label).toLowerCase();
      const score = tokens.filter((t) => hay.includes(t)).length;
      return { skill, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.label.localeCompare(b.skill.label));

  return scored.slice(0, limit).map((row) => row.skill);
}

async function beginSkillClarification(
  runner: GhampusSkillRouteRunner,
  state: GhampusPendingClarificationState,
): Promise<void> {
  if (runner.setPendingClarification) {
    await runner.emitGhampusMsg(askGhampusClarification(state, runner.setPendingClarification));
    return;
  }
  const msg = askGhampusClarification(state, () => {});
  await runner.emitGhampusMsg(msg);
}

export function formatSkillWalkNotFoundMessage(phrase: string): string {
  return `No skill matching **${phrase}**. Try \`/skills\` to list skills, or \`/walk ship-workflow\` with an exact name.`;
}

export function formatSkillWalkAmbiguousMessage(
  phrase: string,
  candidates: GhampusListedSkill[],
): string {
  const names = candidates
    .map((s) => `**${normalizeSkillDisplayLabel(s.label)}**`)
    .join(', ');
  const example = baseSkillName(candidates[0]?.label ?? '').replace(/\s+/g, '-');
  const hint = example ? ` — e.g. \`/walk ${example}\`` : '';
  return `Multiple skills match **${phrase}**: ${names}. Be more specific${hint}.`;
}

export async function runGhampusSkillWalk(
  rawPhrase: string,
  runner: GhampusSkillRouteRunner,
  originalText = rawPhrase,
): Promise<void> {
  const phrase = rawPhrase.trim();
  if (!phrase) {
    await beginSkillClarification(runner, {
      kind: 'walk_skill',
      originalText,
      phrase: '',
    });
    return;
  }

  const listRes = await runner.ghampusTool('list_skills', {}) as { skills?: GhampusListedSkill[] };
  const skills = listRes.skills ?? [];
  const resolved = resolveGhampusSkillWalkMatch(skills, phrase);

  if (resolved.kind === 'none') {
    const suggestions = suggestGhampusSkillsForPhrase(skills, phrase);
    if (suggestions.length > 0 && runner.setPendingClarification) {
      await beginSkillClarification(runner, {
        kind: 'walk_skill',
        originalText,
        phrase: resolved.phrase,
        candidates: suggestions,
      });
      return;
    }
    await runner.emitGhampusMsg(formatSkillWalkNotFoundMessage(resolved.phrase));
    return;
  }
  if (resolved.kind === 'ambiguous') {
    if (runner.setPendingClarification) {
      await beginSkillClarification(runner, {
        kind: 'walk_skill',
        originalText,
        phrase: resolved.phrase,
        candidates: resolved.candidates.slice(0, 5),
      });
      return;
    }
    await runner.emitGhampusMsg(formatSkillWalkAmbiguousMessage(resolved.phrase, resolved.candidates));
    return;
  }

  const match = resolved.skill;
  if (!match.sourceId) {
    await runner.emitGhampusMsg(formatSkillWalkNotFoundMessage(phrase));
    return;
  }

  const engList = await runner.ghampusTool('list_engrams', {}) as {
    engrams?: EngramListEntry[];
  };
  const graphId = resolveSkillTrainGraphId(match, engList.engrams ?? [], null);
  if (!graphId) {
    await runner.emitGhampusMsg(
      'No Skills engram found. Create one from **New Engram → Skill template**, then retry.',
    );
    return;
  }

  const displayLabel = normalizeSkillDisplayLabel(match.label);
  const stepId = ghampusTraceStepId('walk_skill');
  runner.emitTrace({ stepId, status: 'running', label: 'walk skill', tool: 'walk_skill' });

  try {
    const walked = await runner.ghampusTool('walk_skill', {
      graphId,
      sourceId: match.sourceId,
    }) as { rawText?: string };
    const body = walked.rawText?.trim() ?? '';
    if (!body) {
      await runner.emitGhampusMsg(
        `**${displayLabel}** has no walkable steps yet. Open it in the Skills page or retrain it.`,
      );
      runner.emitTrace({
        stepId,
        status: 'error',
        label: 'walk skill',
        tool: 'walk_skill',
        preview: 'empty walk',
      });
      return;
    }
    runner.emitTrace({
      stepId,
      status: 'ok',
      label: 'walk skill',
      tool: 'walk_skill',
      preview: displayLabel,
    });
    await runner.emitGhampusMsg(body.slice(0, 12000));
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    runner.emitTrace({
      stepId,
      status: 'error',
      label: 'walk skill',
      tool: 'walk_skill',
      preview: formatGhampusToolErrorPreview(errText),
    });
    await runner.emitGhampusMsg(
      `Could not walk **${displayLabel}**: ${formatMcpErrorForUser(errText)}`,
    );
  }
}

export function findGhampusSkillMatch(
  skills: GhampusListedSkill[],
  skillName: string,
): GhampusListedSkill | null {
  const trimmed = skillName.trim();
  if (!trimmed) return null;
  const filtered = filterSkillsByKeyword(skills, trimmed);
  if (filtered.length === 1) return filtered[0] ?? null;
  if (filtered.length > 1) {
    const exact = filtered.find((s) => {
      const display = normalizeSkillDisplayLabel(s.label).toLowerCase();
      const base = baseSkillName(s.label).toLowerCase();
      const needle = trimmed.toLowerCase();
      return display === needle || base === needle || base.replace(/\s+/g, '-') === needle.replace(/\s+/g, '-');
    });
    return exact ?? filtered[0] ?? null;
  }
  const needle = trimmed.toLowerCase();
  return skills.find((s) => {
    const display = normalizeSkillDisplayLabel(s.label).toLowerCase();
    const base = baseSkillName(s.label).toLowerCase();
    return display === needle
      || base === needle
      || skillMatchesFilter(s, trimmed);
  }) ?? null;
}

export function extractSkillBodyFromGetSkill(rawText: string): string {
  const parts = rawText.split('\n\n---\n\n');
  if (parts.length > 1) return parts.slice(1).join('\n\n---\n\n').trim();
  return rawText.trim();
}

export function formatSkillTrainStartMessage(
  parsed: ParsedSkillTrainIntent,
  displayLabel: string,
): string {
  const scope = parsed.emptyRecall
    ? 'empty recall scope (source text only)'
    : parsed.targetEngram
      ? `target engram **${parsed.targetEngram}**`
      : 'default Skills engram';
  return `Training **${displayLabel}** — ${scope}. This may take a minute…`;
}

export function resolveSkillTrainGraphId(
  skill: GhampusListedSkill,
  engrams: EngramListEntry[],
  targetEngramHint: string | null,
): string | null {
  if (targetEngramHint) {
    const explicit = resolveEngramFromUserHint(targetEngramHint, engrams);
    if (explicit) return explicit.graphId;
  }
  if (skill.engramName) {
    const fromSkill = resolveEngramFromUserHint(skill.engramName, engrams);
    if (fromSkill) return fromSkill.graphId;
  }
  const skillsEngram = engrams.find((e) => e.graphId === 'graphnosis-skills')
    ?? engrams.find((e) => /skills?/i.test(e.displayName) || e.graphId.includes('skill'));
  return skillsEngram?.graphId ?? engrams[0]?.graphId ?? null;
}
