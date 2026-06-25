/**
 * Implicit skill routing for Ghampus — maps ambiguous natural-language requests
 * to trained skills (same trigger table as skill-dispatch / proactive watcher).
 */

import type { GraphnosisHost } from './host.js';
import type { SkillTrainer } from './skill-trainer.js';
import { baseSkillName } from './skill-trainer.js';
import { findSkillDispatchSourceId, extractDispatchTriggerLines } from './skill-dispatch-sync.js';
import { matchDispatchTriggers } from './proactive-dispatch-match.js';
import type { GhampusQueryHints } from './ghampus-intent.js';
import {
  normalizeSkillSearchPhrase,
  resolveGhampusSkillWalkMatch,
  type GhampusListedSkill,
} from './ghampus-skill-train.js';

/** Skills that route to others — never auto-run from chat. */
export const IMPLICIT_SKILL_META_BLOCKLIST = new Set([
  'skill-dispatch',
  'session-start',
  'session-end',
  'self-driving-session',
  'adaptive-skill-creation',
  'autonomous-decision-authority',
  'dispatch-export-sync',
]);

export interface ImplicitSkillMatch {
  skillSlug: string;
  score: number;
  source: 'static' | 'dispatch' | 'fuzzy';
}

type StaticRoute = {
  skillSlug: string;
  patterns: RegExp[];
  /** When matched, skip implicit walk (recall / list queries). */
  exclude?: RegExp[];
};

/** High-confidence phrase → skill slug (sync, no cortex read). */
const STATIC_IMPLICIT_ROUTES: StaticRoute[] = [
  {
    skillSlug: 'consistency-audit',
    patterns: [
      /\b(find|check|scan|audit|review|look\s+for|any|run|show)\b[\s\S]{0,48}\b(contradict|inconsist|conflict(?:ing)?(?:\s+memor)?)/i,
      /\b(contradict(?:ion)?s?|inconsistenc(?:y|ies)|conflicting\s+memor(?:y|ies))\b/i,
      /\b(check|audit)\s+(?:my\s+)?(?:memory|memories|cortex)\s+(?:for\s+)?(?:consistency|conflicts?|contradict)/i,
      /\b(memory\s+integrity|consistency\s+audit)\b/i,
    ],
  },
  {
    skillSlug: 'bug-investigation',
    patterns: [
      /\b(something(?:'s|\s+is)\s+)?(?:broken|not working|failing|failed)\b/i,
      /\b(find|fix|debug|investigate|diagnose|trace)\b[\s\S]{0,40}\b(bug|error|crash|issue|problem|exception|stack)\b/i,
      /\b(what(?:'s|\s+is)\s+(?:the\s+)?(?:bug|error|issue|crash))\b/i,
      /\b(why (?:is|does|did|won't|wont|can't|cant))\b[\s\S]{0,40}\b(fail|break|crash|error)\b/i,
    ],
    exclude: [/\bship\b/i, /\bmemor(?:y|ies)\b/i],
  },
  {
    skillSlug: 'runtime-diagnosis',
    patterns: [
      /\b(sidecar|mcp|boot|startup)\b[\s\S]{0,32}\b(broken|fail|crash|error|won't|wont|not start(?:ing)?|will not start)\b/i,
      /\b(app|sidecar|mcp)\b[\s\S]{0,24}\b(won't start|will not start|not starting|doesn't start|failed to start)\b/i,
    ],
  },
  {
    skillSlug: 'ship-workflow',
    patterns: [
      /\b(let'?s|ready to|time to)\s+(ship|release|publish|tag)\b/i,
      /\b(ship|release|publish|push|tag)\b[\s\S]{0,16}\b(it|now|this|ready)\b/i,
      /\bwhat(?:'s|\s+is)\s+(?:left|pending)\s+(?:to\s+)?(?:ship|release)\b/i,
      /\b(pre[- ]?release|before (?:we )?(?:ship|release|tag))\b/i,
    ],
  },
  {
    skillSlug: 'project-context-management',
    patterns: [
      /\bwhat(?:'s|\s+is)\s+(?:the\s+)?priority\b/i,
      /\bwhat should i (?:work on|do next|focus on)\b/i,
      /\bwhere (?:were|are) we on\b/i,
      /\bwhat(?:'s|\s+are)\s+my\s+(?:open\s+)?(?:tasks?|todos?)\s*(?:\?|$)/i,
    ],
    exclude: [/\b(?:for|in|on|about|despre|pentru)\s+\S/i, /\bteam\b/i],
  },
  {
    skillSlug: 'task-todo-management',
    patterns: [
      /\b(update|sync|clean)\b[\s\S]{0,24}\b(todos?|tasks?)\b/i,
      /\bwhat(?:'s|\s+are)\s+my\s+todos?\s*\?/i,
    ],
    exclude: [/\b(?:for|in|on|about|despre|pentru)\s+\S/i],
  },
  {
    skillSlug: 'security-review-cadence',
    patterns: [
      /\b(security|vuln(?:erabilit)?y)\b[\s\S]{0,32}\b(review|audit|check|scan)\b/i,
      /\b(check|run|do)\b[\s\S]{0,24}\bsecurity\b/i,
    ],
  },
  {
    skillSlug: 'testing-cadence',
    patterns: [
      /\b(run|do)\b[\s\S]{0,20}\b(smoke|tests?|test suite)\b/i,
      /\b(smoke test|run tests)\b/i,
    ],
  },
  {
    skillSlug: 'cortex-gardening',
    patterns: [
      /\b(clean|tidy|garden|prune)\b[\s\S]{0,32}\b(cortex|memor(?:y|ies)|graph)\b/i,
      /\b(duplicate|stale|orphan)\b[\s\S]{0,24}\b(memor(?:y|ies)|nodes?|cortex)\b/i,
    ],
  },
  {
    skillSlug: 'overlay-triage',
    patterns: [
      /\b(review|triage|check)\b[\s\S]{0,32}\b(predictions?|inferred|overlays?|gll|gnn)\b/i,
    ],
  },
  {
    skillSlug: 'docs-maintenance-workflow',
    patterns: [
      /\b(update|fix|review|audit)\b[\s\S]{0,32}\b(docs?|documentation|readme)\b/i,
    ],
    exclude: [/\bhow (?:do|can|to)\b/i],
  },
  {
    skillSlug: 'changelog-management',
    patterns: [
      /\b(compile|write|draft|build)\b[\s\S]{0,24}\b(changelog|release notes)\b/i,
    ],
  },
  {
    skillSlug: 'retrospective-learning',
    patterns: [
      /\b(what went wrong|postmortem|retrospective|lessons learned)\b/i,
      /\b(something went wrong|we messed up|my mistake)\b/i,
    ],
  },
  {
    skillSlug: 'skill-maintenance-review',
    patterns: [
      /\b(retrain|review|clean up)\b[\s\S]{0,24}\b(skills?|cortex skills)\b/i,
      /\b(skill vitality|stale skills)\b/i,
    ],
  },
  {
    skillSlug: 'vibe-coding-workflow',
    patterns: [
      /\b(spike|prototype|quick(?:ly)?|explore)\b[\s\S]{0,24}\b(this|idea|approach|option)\b/i,
      /\blet'?s (?:try|spike|prototype)\b/i,
    ],
  },
  {
    skillSlug: 'ux-decision-gate',
    patterns: [
      /\b(ui|ux|design)\b[\s\S]{0,32}\b(change|redesign|layout|mockup|wireframe)\b/i,
      /\bshould we (?:change|redesign|move)\b[\s\S]{0,32}\b(ui|button|screen|page|modal)\b/i,
    ],
    exclude: [/\bhow (?:do|can|to)\b/i],
  },
  {
    skillSlug: 'performance-regression-check',
    patterns: [
      /\b(slow|latency|perf(?:ormance)?|sluggish)\b[\s\S]{0,32}\b(check|regression|issue|problem)\b/i,
      /\b(check|find)\b[\s\S]{0,24}\b(slowdown|regression|performance)\b/i,
    ],
  },
];

const DISPATCH_MIN_SCORE = 8;
const FUZZY_MAX_WORDS = 8;

export function loadDispatchTriggerLines(
  host: GraphnosisHost,
  skillTrainer?: SkillTrainer | null,
): string[] {
  if (!skillTrainer) return [];
  for (const gid of host.listGraphs()) {
    const sourceId = findSkillDispatchSourceId(host, gid);
    if (!sourceId) continue;
    const detail = skillTrainer.getSkill(gid, sourceId);
    if (detail?.text) return extractDispatchTriggerLines(detail.text);
  }
  return [];
}

export function matchStaticImplicitSkill(text: string): ImplicitSkillMatch | null {
  const t = text.trim();
  if (!t) return null;
  for (const route of STATIC_IMPLICIT_ROUTES) {
    if (route.exclude?.some((re) => re.test(t))) continue;
    if (route.patterns.some((re) => re.test(t))) {
      if (IMPLICIT_SKILL_META_BLOCKLIST.has(route.skillSlug)) continue;
      return { skillSlug: route.skillSlug, score: 10, source: 'static' };
    }
  }
  return null;
}

export function matchDispatchImplicitSkill(
  text: string,
  triggerLines: string[],
): ImplicitSkillMatch | null {
  if (!triggerLines.length) return null;
  const matches = matchDispatchTriggers(text.trim(), triggerLines);
  const best = matches[0];
  if (!best || best.score < DISPATCH_MIN_SCORE) return null;
  if (IMPLICIT_SKILL_META_BLOCKLIST.has(best.skillSlug)) return null;
  return { skillSlug: best.skillSlug, score: best.score, source: 'dispatch' };
}

export function matchFuzzyImplicitSkill(
  text: string,
  skills: GhampusListedSkill[],
): ImplicitSkillMatch | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > FUZZY_MAX_WORDS) return null;
  const phrase = normalizeSkillSearchPhrase(text);
  if (phrase.length < 3) return null;
  const resolved = resolveGhampusSkillWalkMatch(skills, phrase);
  if (resolved.kind !== 'match') return null;
  const slug = baseSkillName(resolved.skill.label).replace(/\s+/g, '-');
  if (IMPLICIT_SKILL_META_BLOCKLIST.has(slug)) return null;
  return { skillSlug: slug, score: 7, source: 'fuzzy' };
}

/** Gate implicit skill walk — avoid hijacking recall / list / how-to paths. */
export function canUseImplicitSkillWalk(text: string, hints: GhampusQueryHints): boolean {
  if (hints.wantsExplicitSkillWalk || hints.wantsSkillTrain || hints.wantsSkillList || hints.wantsMcpToolList) {
    return false;
  }
  if (hints.skipMemoryTools && hints.directAnswerKind) return false;
  if (hints.wantsDocSource) return false;
  if (hints.wantsTeamRoster || hints.wantsPersonRole || hints.wantsPersonInContext) return false;
  if (hints.wantsTopicAbout || hints.wantsDefinitional) return false;
  if (hints.wantsCrossEngramSearch && !hints.wantsConsistencyWalk) return false;
  if (hints.wantsExhaustive && /\b(list|show|find|all|every|enumere|toate)\b/i.test(text)) return false;
  if (/\bhow (?:do|can|to|should)\b/i.test(text) && !hints.wantsConsistencyWalk) return false;
  return true;
}

export function resolveImplicitSkillSync(
  text: string,
  hints: GhampusQueryHints,
): ImplicitSkillMatch | null {
  if (!canUseImplicitSkillWalk(text, hints)) return null;
  return matchStaticImplicitSkill(text);
}

export function resolveImplicitSkillFull(
  text: string,
  hints: GhampusQueryHints,
  triggerLines: string[],
  skills: GhampusListedSkill[] = [],
): ImplicitSkillMatch | null {
  if (!canUseImplicitSkillWalk(text, hints)) return null;
  const staticMatch = matchStaticImplicitSkill(text);
  if (staticMatch) return staticMatch;
  const dispatchMatch = matchDispatchImplicitSkill(text, triggerLines);
  if (dispatchMatch) return dispatchMatch;
  return matchFuzzyImplicitSkill(text, skills);
}
