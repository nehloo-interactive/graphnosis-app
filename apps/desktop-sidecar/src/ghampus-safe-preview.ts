/**
 * Safe auto-preview lane — walk allowlisted integrity/gardening skills as
 * READ-ONLY SOP markdown into the Ghampus thread.
 *
 * Never executes mutating steps. Never touches attested memory. This is the
 * "act safely" half of the personal-assistant loop: Ghampus shows the plan
 * without waiting for a click, then the owner still confirms any real run.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveGhampusSafeAutoPreviewSettings } from '@graphnosis-app/core/settings';
import type { GraphnosisHost } from './host.js';
import type { SkillTrainer } from './skill-trainer.js';
import type { BroadcastRawFn } from './events.js';
import { walkSkillSequence, formatSkillForGhampusPreview } from './skill-trainer.js';

/** Skills Ghampus may auto-preview without human click. Keep this list tight. */
export const SAFE_AUTO_PREVIEW_SKILLS = new Set([
  'cortex-gardening',
  'consistency-audit',
  'skill-maintenance-review',
  'task-todo-management',
]);

const STATE_FILE = 'ghampus-safe-preview-state.json';
const COOLDOWN_MS = 12 * 60 * 60_000;
const MAX_PREVIEW_CHARS = 4500;

interface PreviewState {
  version: 1;
  lastBySkill: Record<string, number>;
}

export interface SafePreviewDeps {
  host: GraphnosisHost;
  skillTrainer: SkillTrainer | null;
  broadcastRaw: BroadcastRawFn;
  cortexDir: string;
}

export function normalizeSkillSlug(label: string): string {
  return label
    .replace(/^skill:\d+:/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isSafeAutoPreviewSkill(label: string): boolean {
  return SAFE_AUTO_PREVIEW_SKILLS.has(normalizeSkillSlug(label));
}

async function loadState(cortexDir: string): Promise<PreviewState> {
  try {
    const raw = await fs.readFile(path.join(cortexDir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as PreviewState;
    if (parsed?.version === 1 && parsed.lastBySkill) return parsed;
  } catch { /* fresh */ }
  return { version: 1, lastBySkill: {} };
}

async function saveState(cortexDir: string, state: PreviewState): Promise<void> {
  await fs.writeFile(path.join(cortexDir, STATE_FILE), JSON.stringify(state), 'utf8');
}

function findSkill(
  trainer: SkillTrainer,
  slug: string,
): { sourceId: string; graphId: string; label: string } | null {
  const skills = trainer.listSkills();
  const hit = skills.find((s) => normalizeSkillSlug(s.label) === slug)
    ?? skills.find((s) => normalizeSkillSlug(s.label).includes(slug));
  if (!hit) return null;
  return {
    sourceId: hit.sourceId,
    graphId: hit.graphId,
    label: hit.label.replace(/^skill:\d+:/, ''),
  };
}

/**
 * Auto-walk a safe skill into Ghampus as a read-only preview message.
 * Returns true when a preview was emitted.
 */
export async function runSafeSkillPreview(
  deps: SafePreviewDeps,
  skillLabel: string,
  reason: string,
): Promise<{ emitted: boolean; detail?: string }> {
  const settings = resolveGhampusSafeAutoPreviewSettings(deps.host.getSettings().agent);
  if (!settings.enabled) return { emitted: false, detail: 'disabled' };
  if (deps.host.getSettings().agent?.enabled === false) {
    return { emitted: false, detail: 'ghampus-disabled' };
  }
  if (!deps.skillTrainer) return { emitted: false, detail: 'no-trainer' };

  const slug = normalizeSkillSlug(skillLabel);
  if (!SAFE_AUTO_PREVIEW_SKILLS.has(slug)) {
    return { emitted: false, detail: 'not-allowlisted' };
  }

  const now = Date.now();
  const state = await loadState(deps.cortexDir);
  const last = state.lastBySkill[slug] ?? 0;
  if (now - last < COOLDOWN_MS) {
    return { emitted: false, detail: 'cooldown' };
  }

  const skill = findSkill(deps.skillTrainer, slug);
  if (!skill) return { emitted: false, detail: 'skill-missing' };
  if (deps.host.skillsDisabled(skill.graphId)) {
    return { emitted: false, detail: 'agent-off' };
  }

  let sop: string;
  try {
    const crossLinks = await deps.host.skillCallLinks
      .getForSource(skill.graphId, skill.sourceId)
      .catch(() => []);
    const walked = walkSkillSequence(deps.host, skill.graphId, skill.sourceId, {
      recursive: false,
      crossEngramLinks: crossLinks ?? [],
    });
    if (walked.steps.length === 0 && walked.goals.length === 0) {
      return { emitted: false, detail: 'empty-sop' };
    }
    sop = formatSkillForGhampusPreview(walked, skill.label.replace(/-/g, ' '));
  } catch (err) {
    console.warn('[ghampus-safe-preview] walk failed:', err);
    return { emitted: false, detail: 'walk-failed' };
  }

  let body = sop.trim();
  if (body.length > MAX_PREVIEW_CHARS) {
    body = `${body.slice(0, MAX_PREVIEW_CHARS).trimEnd()}\n\n… _(truncated — say \`/preview ${slug}\` for the full SOP)_`;
  }

  const pretty = skill.label.replace(/-/g, ' ');
  const text =
    `I went ahead and **previewed ${pretty}** — read-only. Nothing was changed in your cortex.\n\n` +
    `_${reason}_\n\n` +
    `${body}\n\n` +
    `When you're ready to act, run it from Skills / Cursor, or say \`/preview ${slug}\` again. ` +
    `I will never silently edit attested memories.`;

  const ts = now;
  const msg = {
    kind: 'ghampus' as const,
    text,
    ts,
    messageId: `preview-${slug}-${ts}`,
    citations: [
      { kind: 'skill-walk' as const, label: pretty, detail: 'Read-only safe preview' },
    ],
  };
  const { appendGhampusHistoryMessage } = await import('./ghampus-history-cache.js');
  await appendGhampusHistoryMessage(deps.cortexDir, msg);

  try {
    deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: msg });
  } catch { /* non-fatal */ }

  state.lastBySkill[slug] = now;
  await saveState(deps.cortexDir, state);
  console.log(`[ghampus-safe-preview] emitted preview for ${slug}`);
  return { emitted: true, detail: slug };
}
