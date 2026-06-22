/**
 * Ghampus incomplete-intent guidance — stateful follow-ups instead of raw errors or silent failure.
 */

import {
  filterSkillsByKeyword,
  normalizeSkillDisplayLabel,
  skillMatchesFilter,
} from './ghampus-recall-format.js';
import { baseSkillName } from './skill-trainer.js';
import type { GhampusListedSkill } from './ghampus-skill-train.js';
import { formatGhampusToolErrorPreview } from './ghampus-trace.js';

export type GhampusClarificationKind =
  | 'save_memory'
  | 'walk_skill'
  | 'train_skill'
  | 'create_engram'
  | 'slash_save'
  | 'slash_walk'
  | 'slash_train'
  | 'slash_create';

export type GhampusPendingClarificationState =
  | {
      kind: 'save_memory';
      originalText: string;
      content: string;
      engramHint: string | null;
    }
  | {
      kind: 'walk_skill' | 'train_skill';
      originalText: string;
      phrase: string;
      candidates?: GhampusListedSkill[];
    }
  | {
      kind: 'create_engram' | 'slash_create';
      originalText: string;
    }
  | {
      kind: 'slash_save';
      originalText: string;
    }
  | {
      kind: 'slash_walk' | 'slash_train';
      originalText: string;
    };

/** @deprecated alias — ipc + send-flow import this name */
export type GhampusPendingClarification = GhampusPendingClarificationState;

export type IncompleteIntentContext = {
  phrase?: string;
  candidates?: GhampusListedSkill[];
  content?: string;
  engramHint?: string | null;
  suggestedName?: string;
};

export type ClarificationResolution =
  | {
      action: 'save_confirm_yes';
      content: string;
      engramHint: string | null;
      originalText: string;
    }
  | { action: 'save_confirm_no'; originalText: string }
  | { action: 'walk_skill'; phrase: string; originalText: string }
  | {
      action: 'train_skill';
      skillName: string;
      originalText: string;
      targetEngram?: string | null;
      emptyRecall?: boolean;
    }
  | { action: 'create_engram'; name: string }
  | { action: 'slash_save'; content: string; engramHint: string | null }
  | { action: 'cancelled' };

function skillSlug(skill: GhampusListedSkill): string {
  return baseSkillName(skill.label).replace(/\s+/g, '-');
}

function pickSkillByName(skills: GhampusListedSkill[], name: string): GhampusListedSkill | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const filtered = filterSkillsByKeyword(skills, trimmed);
  if (filtered.length === 1) return filtered[0] ?? null;
  if (filtered.length > 1) {
    const needle = trimmed.toLowerCase();
    const exact = filtered.find((s) => {
      const display = normalizeSkillDisplayLabel(s.label).toLowerCase();
      const base = baseSkillName(s.label).toLowerCase();
      return display === needle || base === needle || base.replace(/\s+/g, '-') === needle.replace(/\s+/g, '-');
    });
    return exact ?? filtered[0] ?? null;
  }
  const needle = trimmed.toLowerCase();
  return skills.find((s) => {
    const display = normalizeSkillDisplayLabel(s.label).toLowerCase();
    const base = baseSkillName(s.label).toLowerCase();
    return display === needle || base === needle || skillMatchesFilter(s, trimmed);
  }) ?? null;
}

function formatSkillPickList(candidates: GhampusListedSkill[], verb: 'walk' | 'train'): string {
  return candidates
    .slice(0, 5)
    .map((s) => {
      const label = normalizeSkillDisplayLabel(s.label);
      const slug = skillSlug(s);
      return `- **${label}** (\`/${verb} ${slug}\`)`;
    })
    .join('\n');
}

/** Consistent conversational tone for missing or ambiguous intent. */
export function formatIncompleteIntentMessage(
  kind: GhampusClarificationKind,
  context: IncompleteIntentContext = {},
): string {
  const phrase = context.phrase?.trim() ?? '';
  const candidates = context.candidates ?? [];

  switch (kind) {
    case 'save_memory': {
      const preview = (context.content ?? '').slice(0, 200);
      const suffix = (context.content?.length ?? 0) > 200 ? '…' : '';
      return `Should I **save** this to your cortex, or **search** memory instead?\n\n"${preview}${suffix}"\n\nReply **save** to store it, or **search** to look it up.`;
    }
    case 'walk_skill':
      if (candidates.length > 1) {
        if (candidates.length === 2 && phrase) {
          const top = normalizeSkillDisplayLabel(candidates[0]!.label);
          return `Did you mean **${top}** for "${phrase}"?\n\nReply **yes**, pick one:\n${formatSkillPickList(candidates, 'walk')}\n\nOr name the skill more precisely.`;
        }
        return phrase
          ? `Multiple skills match **${phrase}**. Which one should I walk?\n\n${formatSkillPickList(candidates, 'walk')}\n\nReply with a skill name.`
          : `Which skill should I walk?\n\n${formatSkillPickList(candidates, 'walk')}\n\nReply with a skill name, e.g. \`/walk ship-workflow\`.`;
      }
      if (candidates.length === 1 && phrase) {
        const only = normalizeSkillDisplayLabel(candidates[0]!.label);
        return `Did you mean **${only}** for "${phrase}"? Reply **yes** to walk it, or name another skill.`;
      }
      if (candidates.length > 0 && phrase) {
        return `I couldn't find an exact skill for **${phrase}**. Here are skills that might help:\n\n${formatSkillPickList(candidates.slice(0, 3), 'walk')}\n\nReply with a skill name, or try \`/skills\` to see all.`;
      }
      return 'Which skill should I walk? Example: `/walk ship-workflow` or say `walk skill bug-investigation`.';
    case 'train_skill':
      if (candidates.length > 1) {
        return phrase
          ? `Multiple skills match **${phrase}**. Which one should I train?\n\n${formatSkillPickList(candidates, 'train')}\n\nReply with a skill name.`
          : `Which skill should I train?\n\n${formatSkillPickList(candidates, 'train')}\n\nReply with a skill name, e.g. \`/train ship-workflow\`.`;
      }
      if (candidates.length > 0 && phrase) {
        return `I couldn't find an exact skill for **${phrase}**. Did you mean one of these?\n\n${formatSkillPickList(candidates.slice(0, 3), 'train')}\n\nReply with a skill name, or try \`/skills\`.`;
      }
      return 'Which skill should I train? Example: `/train enterprise-compliance-lens` or `train skill ship-workflow`.';
    case 'create_engram':
    case 'slash_create':
      return 'What should I name the new engram? Example: `/create my-project-notes` or just type the name.';
    case 'slash_save':
      return 'What should I save? Example: `/save Meeting notes from today @coding` — or type the note (optionally ending with `@engram`).';
    case 'slash_walk':
      return 'Which skill should I walk? Example: `/walk ship-workflow` or reply with a skill name like `bug-investigation`.';
    case 'slash_train':
      return 'Which skill should I train? Example: `/train ship-workflow` or reply with a skill name.';
    default:
      return 'Could you say a bit more? I need one more detail to continue.';
  }
}

function stateToIncompleteContext(state: GhampusPendingClarificationState): IncompleteIntentContext {
  const ctx: IncompleteIntentContext = {};
  if ('phrase' in state) ctx.phrase = state.phrase;
  if ('candidates' in state && state.candidates?.length) ctx.candidates = state.candidates;
  if ('content' in state) ctx.content = state.content;
  if ('engramHint' in state) ctx.engramHint = state.engramHint;
  return ctx;
}

/** Persist clarification state and return the user-facing question. */
export function askGhampusClarification(
  state: GhampusPendingClarificationState,
  setPending: (v: GhampusPendingClarificationState | null) => void,
): string {
  setPending(state);
  return formatIncompleteIntentMessage(state.kind, stateToIncompleteContext(state));
}

const SAVE_YES_RE =
  /^(yes|save( it)?|do it|store( it)?|keep( it)?|confirm|ok|okay|sure|yep|yeah|si|oui|ja|да|s[íi])$/i;
const SAVE_NO_RE =
  /^(no|recall|search|look( it)? up|find( it)?|don'?t save|nope|nah|cancel|skip|non|nein|нет|否)$/i;
const AFFIRMATIVE_RE = /^(yes|yep|yeah|y|ok|okay|sure|correct|right|da|oui|si|s[íi])$/i;

function resolveSkillFromFollowUp(
  userText: string,
  candidates: GhampusListedSkill[] | undefined,
  allSkills: GhampusListedSkill[] | undefined,
): GhampusListedSkill | null {
  const t = userText.trim();
  if (!t) return null;

  if (AFFIRMATIVE_RE.test(t.replace(/[!.]+$/, '')) && candidates?.length === 1) {
    return candidates[0] ?? null;
  }

  const numMatch = t.match(/^(\d)[.)]?$/);
  if (numMatch && candidates?.length) {
    const idx = Number(numMatch[1]) - 1;
    return candidates[idx] ?? null;
  }

  if (candidates?.length) {
    const fromList = pickSkillByName(candidates, t);
    if (fromList?.sourceId) return fromList;
  }

  if (allSkills?.length) {
    const fromAll = pickSkillByName(allSkills, t);
    if (fromAll?.sourceId) return fromAll;
  }

  return null;
}

export type TryResolveClarificationOpts = {
  /** Full skill list — used to resolve free-text follow-ups for walk/train. */
  skills?: GhampusListedSkill[];
};

/** Handle the user's reply when a clarification is pending. */
export function tryResolveClarification(
  pending: GhampusPendingClarificationState,
  userText: string,
  opts: TryResolveClarificationOpts = {},
): ClarificationResolution {
  const t = userText.trim().toLowerCase().replace(/[!.]+$/, '');

  if (pending.kind === 'save_memory') {
    if (SAVE_YES_RE.test(t)) {
      return {
        action: 'save_confirm_yes',
        content: pending.content,
        engramHint: pending.engramHint,
        originalText: pending.originalText,
      };
    }
    if (SAVE_NO_RE.test(t)) {
      return { action: 'save_confirm_no', originalText: pending.originalText };
    }
    return { action: 'cancelled' };
  }

  if (pending.kind === 'walk_skill') {
    const picked = resolveSkillFromFollowUp(userText, pending.candidates, opts.skills);
    if (picked) {
      return {
        action: 'walk_skill',
        phrase: baseSkillName(picked.label),
        originalText: pending.originalText,
      };
    }
    if (userText.trim().length >= 2) {
      return {
        action: 'walk_skill',
        phrase: userText.trim(),
        originalText: pending.originalText,
      };
    }
    return { action: 'cancelled' };
  }

  if (pending.kind === 'train_skill') {
    const picked = resolveSkillFromFollowUp(userText, pending.candidates, opts.skills);
    if (picked) {
      return {
        action: 'train_skill',
        skillName: baseSkillName(picked.label),
        originalText: pending.originalText,
      };
    }
    if (userText.trim().length >= 2) {
      return {
        action: 'train_skill',
        skillName: userText.trim(),
        originalText: pending.originalText,
      };
    }
    return { action: 'cancelled' };
  }

  if (pending.kind === 'create_engram' || pending.kind === 'slash_create') {
    const name = userText.trim();
    if (name.length >= 1 && !/^engram$/i.test(name)) {
      return { action: 'create_engram', name };
    }
    return { action: 'cancelled' };
  }

  if (pending.kind === 'slash_save') {
    const atMatch = userText.match(/\s@([\w-]+)$/);
    const engramHint = atMatch?.[1]?.toLowerCase() ?? null;
    const content = atMatch
      ? userText.slice(0, userText.lastIndexOf(atMatch[0]!)).trim()
      : userText.trim();
    if (content.length >= 2) {
      return { action: 'slash_save', content, engramHint };
    }
    return { action: 'cancelled' };
  }

  if (pending.kind === 'slash_walk') {
    if (userText.trim().length >= 2) {
      return {
        action: 'walk_skill',
        phrase: userText.trim(),
        originalText: pending.originalText,
      };
    }
    return { action: 'cancelled' };
  }

  if (pending.kind === 'slash_train') {
    if (userText.trim().length >= 2) {
      return {
        action: 'train_skill',
        skillName: userText.trim(),
        originalText: pending.originalText,
      };
    }
    return { action: 'cancelled' };
  }

  return { action: 'cancelled' };
}

/** Never surface raw Zod JSON to the user. */
export function formatMcpErrorForUser(errText: string, prefix?: string): string {
  const preview = formatGhampusToolErrorPreview(errText);
  if (!prefix) return preview;
  return `${prefix}: ${preview}`;
}
