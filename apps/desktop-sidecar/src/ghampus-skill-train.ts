/**
 * Ghampus skill training route — resolve skill by name, invoke train_skill MCP.
 */

import { baseSkillName } from './skill-trainer.js';
import type { ParsedSkillTrainIntent } from './ghampus-intent.js';
import { resolveEngramFromUserHint, type EngramListEntry } from './ghampus-engram-resolve.js';
import {
  filterSkillsByKeyword,
  normalizeSkillDisplayLabel,
  skillMatchesFilter,
} from './ghampus-recall-format.js';

export type GhampusListedSkill = {
  label: string;
  sourceId?: string;
  engramName?: string;
  searchText?: string;
};

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
