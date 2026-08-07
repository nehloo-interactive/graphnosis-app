/**
 * Local-LLM companion voice for Ghampus proactive pings.
 *
 * When Local LLM is on and Ollama is reachable, Ghampus can author short
 * status / question / todo / schedule check-ins from a FACTS pack only —
 * never invents memories, never writes attested data. Cross-Agempi outreach
 * is expressed as allowlisted `@skill:` safe-previews (read-only SOP walks).
 */

import type { LocalLlm } from './correction.js';
import type { GraphnosisHost } from './host.js';
import type { BrainEngine } from './brain-engine.js';
import { fetchGhampusLlmStatus } from './ghampus-direct-answer.js';
import {
  isSafeAutoPreviewSkill,
  normalizeSkillSlug,
  SAFE_AUTO_PREVIEW_SKILLS,
} from './ghampus-safe-preview.js';

export interface CompanionFacts {
  hourLabel: string;
  notifications: number;
  corrections: number;
  contradictions: number;
  duplicates: number;
  obligationsDue: number;
  obligationsOverdue: number;
  obligationLabels: string[];
  poweredAgents: string[];
  suggestSkills: string[];
}

export interface CompanionPingResult {
  /** Markdown body for the Ghampus thread. */
  text: string;
  /** Allowlisted skill slugs to safe-preview after the ping. */
  pingSkills: string[];
  usedLlm: boolean;
}

/** True when master switch is on AND Ollama answers /api/tags. */
export async function isLocalLlmReadyForCompanion(host: GraphnosisHost): Promise<boolean> {
  const status = await fetchGhampusLlmStatus(host);
  return status.enabled && status.ollamaReachable;
}

function hourLabel(now: Date): string {
  const h = now.getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

export async function collectCompanionFacts(deps: {
  host: GraphnosisHost;
  brainEngine: BrainEngine | null;
  getPendingCorrections?: () => number;
  sinceMs: number;
  now?: number;
}): Promise<CompanionFacts> {
  const now = deps.now ?? Date.now();
  const { listNotifications } = await import('./agent-notifications.js');
  const { notifications } = listNotifications(
    { host: deps.host },
    { sinceMs: deps.sinceMs, limit: 20 },
  );
  const attention = deps.brainEngine?.getAttentionCounts() ?? {
    contradictions: 0,
    duplicates: 0,
    total: 0,
  };
  const corrections = deps.getPendingCorrections?.() ?? 0;

  await deps.host.obligationIndex.ensureLoaded();
  const due = deps.host.obligationIndex.list({
    dueWithinMs: 7 * 24 * 60 * 60_000,
    includeOverdue: true,
    maxResults: 8,
    now,
  });
  const overdue = due.filter((ob) => ob.expiresAt <= now);
  const obligationLabels = due.slice(0, 5).map((ob) => {
    const when = new Date(ob.expiresAt).toLocaleDateString();
    const kind = ob.obligationType ?? 'deadline';
    return `${kind} · ${when}`;
  });

  const poweredAgents: string[] = [];
  for (const graphId of deps.host.listGraphs()) {
    if (deps.host.skillsDisabled(graphId)) continue;
    const meta = deps.host.getGraphMetadata(graphId) as { displayName?: string; engramTemplate?: string } | undefined;
    if (meta?.engramTemplate === 'skill' || /skills?/i.test(meta?.displayName ?? graphId)) {
      poweredAgents.push(meta?.displayName ?? graphId);
    }
  }

  const suggestSkills: string[] = [];
  if (attention.contradictions > 0) suggestSkills.push('consistency-audit');
  if (attention.duplicates > 0 || corrections > 0) suggestSkills.push('cortex-gardening');
  if (due.length > 0) suggestSkills.push('task-todo-management');

  return {
    hourLabel: hourLabel(new Date(now)),
    notifications: notifications.length,
    corrections,
    contradictions: attention.contradictions,
    duplicates: attention.duplicates,
    obligationsDue: due.length,
    obligationsOverdue: overdue.length,
    obligationLabels,
    poweredAgents: poweredAgents.slice(0, 8),
    suggestSkills: [...new Set(suggestSkills)].filter(isSafeAutoPreviewSkill),
  };
}

function factsToPromptBlock(facts: CompanionFacts): string {
  return [
    `time_of_day: ${facts.hourLabel}`,
    `inbound_items: ${facts.notifications}`,
    `corrections_pending: ${facts.corrections}`,
    `contradictions_open: ${facts.contradictions}`,
    `duplicate_pairs_open: ${facts.duplicates}`,
    `obligations_due_7d: ${facts.obligationsDue}`,
    `obligations_overdue: ${facts.obligationsOverdue}`,
    `obligation_labels: ${facts.obligationLabels.join(' | ') || 'none'}`,
    `powered_agempi: ${facts.poweredAgents.join(', ') || 'none'}`,
    `suggested_skills: ${facts.suggestSkills.join(', ') || 'none'}`,
    `allowlisted_skills: ${[...SAFE_AUTO_PREVIEW_SKILLS].join(', ')}`,
  ].join('\n');
}

/** Parse trailing PING_SKILL lines; strip them from visible text. */
export function extractPingSkills(raw: string): { text: string; pingSkills: string[] } {
  const lines = raw.trim().split('\n');
  const pingSkills: string[] = [];
  const kept: string[] = [];
  for (const line of lines) {
    const m = /^\s*PING_SKILL:\s*([a-z0-9-]+)\s*$/i.exec(line);
    if (m?.[1]) {
      const slug = normalizeSkillSlug(m[1]);
      if (isSafeAutoPreviewSkill(slug) && !pingSkills.includes(slug)) pingSkills.push(slug);
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), pingSkills };
}

function fallbackCompanionText(facts: CompanionFacts): string {
  const title =
    facts.hourLabel === 'morning' ? 'Good morning'
      : facts.hourLabel === 'afternoon' ? 'Afternoon check-in'
        : 'Evening check-in';
  const bits: string[] = [`**${title}** — here's a quick pulse.`];
  if (facts.notifications > 0) {
    bits.push(`${facts.notifications} inbound item(s) since last time.`);
  }
  if (facts.contradictions + facts.duplicates + facts.corrections > 0) {
    bits.push(
      `Memory Integrity: ${facts.corrections} correction(s), ${facts.contradictions} contradiction(s), ${facts.duplicates} duplicate pair(s).`,
    );
  }
  if (facts.obligationsDue > 0) {
    bits.push(
      `Schedules / todos: ${facts.obligationsDue} obligation(s) in the next 7 days` +
      (facts.obligationsOverdue > 0 ? ` (${facts.obligationsOverdue} overdue)` : '') +
      (facts.obligationLabels.length
        ? ` — ${facts.obligationLabels.slice(0, 3).join('; ')}`
        : '') +
      '.',
    );
  }
  if (facts.suggestSkills.length > 0) {
    bits.push(
      `I'll ping the relevant Agempi with read-only \`@skill:\` previews: ` +
      facts.suggestSkills.map((s) => `\`${s}\``).join(', ') +
      `. Nothing mutates until you choose.`,
    );
  } else {
    bits.push('Nothing urgent on the board — ask me anything, or type `/` for save · recall · skills.');
  }
  bits.push('What should we tackle first?');
  return bits.join('\n\n');
}

/**
 * Author a companion ping. Uses Local LLM when ready; otherwise deterministic fallback.
 * Never invents facts beyond the pack. Never writes memory.
 */
export async function composeCompanionPing(
  llm: LocalLlm | null | undefined,
  facts: CompanionFacts,
): Promise<CompanionPingResult> {
  if (!llm) {
    return {
      text: fallbackCompanionText(facts),
      pingSkills: facts.suggestSkills.slice(0, 2),
      usedLlm: false,
    };
  }

  const system =
    'You are Ghampus, a confidential local AI assistant in Graphnosis. ' +
    'Write a short proactive ping (max 120 words) in plain markdown with **bold** sparingly. ' +
    'Use ONLY the FACTS block — never invent memories, people, or deadlines. ' +
    'Include: (1) a status pulse, (2) one clear question OR next step for the user, ' +
    '(3) if suggested_skills is non-empty, say you will ping those Agempi via @skill: for a READ-ONLY plan. ' +
    'Do not claim you edited or saved anything. ' +
    'After the message, output zero or more lines exactly like: PING_SKILL: slug ' +
    '(only from allowlisted_skills / suggested_skills).';

  const user =
    `FACTS:\n${factsToPromptBlock(facts)}\n\n` +
    'Write the ping now.';

  try {
    const raw = await llm.complete({ system, user });
    const { text, pingSkills } = extractPingSkills(raw);
    const cleaned = text
      .replace(/^["']|["']$/g, '')
      .trim();
    if (cleaned.length < 40) {
      return {
        text: fallbackCompanionText(facts),
        pingSkills: facts.suggestSkills.slice(0, 2),
        usedLlm: false,
      };
    }
    const skills = pingSkills.length > 0
      ? pingSkills.slice(0, 2)
      : facts.suggestSkills.slice(0, 2);
    return { text: cleaned, pingSkills: skills, usedLlm: true };
  } catch {
    return {
      text: fallbackCompanionText(facts),
      pingSkills: facts.suggestSkills.slice(0, 2),
      usedLlm: false,
    };
  }
}
