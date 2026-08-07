/**
 * Scheduled Ghampus check-ins — assistant voice, not tip cards.
 *
 * On an idle cadence, summarize cortex health + inbound activity and (when
 * needed) hand off to the safe auto-preview lane for gardening / audit SOPs.
 *
 * When Local LLM is on + reachable, the check-in is LLM-authored from a facts
 * pack (questions, status, todos, schedules) and can ping other Agempi via
 * allowlisted `@skill:` read-only previews.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveGhampusCheckInSettings } from '@graphnosis-app/core/settings';
import type { GraphnosisHost } from './host.js';
import type { BrainEngine } from './brain-engine.js';
import type { SkillTrainer } from './skill-trainer.js';
import type { BroadcastRawFn } from './events.js';
import type { LocalLlm } from './correction.js';
import { isGhampusBusy, ghampusChatSoftIdle } from './ghampus-busy.js';
import { shouldDeferGhampusBackground, scaleGhampusStartupDelay } from './background-lane-scheduler.js';
import { runSafeSkillPreview, isSafeAutoPreviewSkill } from './ghampus-safe-preview.js';
import {
  collectCompanionFacts,
  composeCompanionPing,
  isLocalLlmReadyForCompanion,
} from './ghampus-llm-companion.js';

const STATE_FILE = 'ghampus-check-in-state.json';
const TICK_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 4 * 60 * 60_000;
const DEFAULT_STARTUP_DELAY_MS = 7 * 60_000;

interface CheckInState {
  version: 1;
  lastCheckInAt?: number;
}

export interface GhampusCheckInSchedulerDeps {
  host: GraphnosisHost;
  brainEngine: BrainEngine | null;
  skillTrainer: SkillTrainer | null;
  broadcastRaw: BroadcastRawFn;
  cortexDir: string;
  /** Pending LLM-diff corrections count (from ipc pendingDiffs). */
  getPendingCorrections?: () => number;
  /** Live Local LLM client — used only when enabled + Ollama reachable. */
  getLlm?: () => LocalLlm | null;
}

async function loadState(cortexDir: string): Promise<CheckInState> {
  try {
    const raw = await fs.readFile(path.join(cortexDir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as CheckInState;
    if (parsed?.version === 1) return parsed;
  } catch { /* fresh */ }
  return { version: 1 };
}

async function saveState(cortexDir: string, state: CheckInState): Promise<void> {
  await fs.writeFile(path.join(cortexDir, STATE_FILE), JSON.stringify(state), 'utf8');
}

function hourGreeting(now: Date): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Afternoon check-in';
  return 'Evening check-in';
}

export function buildCheckInText(input: {
  now: Date;
  notifications: number;
  corrections: number;
  contradictions: number;
  duplicates: number;
  suggestSkill: string | null;
}): string {
  const greeting = hourGreeting(input.now);
  const lines: string[] = [`**${greeting}** — here's where things stand.`];

  if (input.notifications > 0) {
    lines.push(
      `${input.notifications} new inbound item${input.notifications === 1 ? '' : 's'} since we last talked.`,
    );
  } else {
    lines.push('No new inbound memories since the last check-in.');
  }

  const integrityBits: string[] = [];
  if (input.corrections > 0) {
    integrityBits.push(`${input.corrections} correction${input.corrections === 1 ? '' : 's'}`);
  }
  if (input.contradictions > 0) {
    integrityBits.push(`${input.contradictions} contradiction${input.contradictions === 1 ? '' : 's'}`);
  }
  if (input.duplicates > 0) {
    integrityBits.push(`${input.duplicates} duplicate pair${input.duplicates === 1 ? '' : 's'}`);
  }

  if (integrityBits.length > 0) {
    lines.push(
      `**Memory Integrity** still needs you: ${integrityBits.join(', ')}. ` +
      `I won't silently rewrite attested facts — open Foresight → Memory Integrity to adjudicate.`,
    );
  } else {
    lines.push('Memory Integrity looks quiet — no open contradictions or corrections queued.');
  }

  if (input.suggestSkill && isSafeAutoPreviewSkill(input.suggestSkill)) {
    const pretty = input.suggestSkill.replace(/-/g, ' ');
    lines.push(
      `Next: I'll **preview ${pretty}** (read-only SOP) so you can see the steps. ` +
      `Nothing runs until you choose to.`,
    );
  } else {
    lines.push('Ask me anything, or type `/` for save · recall · skills.');
  }

  return lines.join('\n\n');
}

export class GhampusCheckInScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private state: CheckInState = { version: 1 };

  constructor(private deps: GhampusCheckInSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    const cfg = resolveGhampusCheckInSettings(this.deps.host.getSettings().agent);
    if (!cfg.enabled) return;
    const delay = scaleGhampusStartupDelay(this.deps.host, cfg.startupDelayMs);
    setTimeout(() => { void this.tick(); }, delay);
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tickForTest(force = false): Promise<{ emitted: boolean }> {
    return this.tick(force);
  }

  private async tick(force = false): Promise<{ emitted: boolean }> {
    if (this.tickInFlight) return { emitted: false };
    this.tickInFlight = true;
    try {
      const cfg = resolveGhampusCheckInSettings(this.deps.host.getSettings().agent);
      if (!cfg.enabled) return { emitted: false };
      if (this.deps.host.getSettings().agent?.enabled === false) return { emitted: false };
      if (!force) {
        if (isGhampusBusy()) return { emitted: false };
        if (shouldDeferGhampusBackground(this.deps.host)) return { emitted: false };
        if (!ghampusChatSoftIdle()) return { emitted: false };
      }

      this.state = await loadState(this.deps.cortexDir);
      const now = Date.now();
      const last = this.state.lastCheckInAt ?? 0;
      if (!force && now - last < cfg.intervalMs) return { emitted: false };

      const sinceMs = last > 0 ? last : now - cfg.intervalMs;
      const facts = await collectCompanionFacts({
        host: this.deps.host,
        brainEngine: this.deps.brainEngine,
        ...(this.deps.getPendingCorrections
          ? { getPendingCorrections: this.deps.getPendingCorrections }
          : {}),
        sinceMs,
        now,
      });

      // Skip empty quiet check-ins unless forced — avoid spam when all is well.
      const hasSignal =
        facts.notifications > 0
        || facts.contradictions > 0
        || facts.duplicates > 0
        || facts.corrections > 0
        || facts.obligationsDue > 0;
      if (!force && !hasSignal && last > 0) return { emitted: false };

      const llmReady = await isLocalLlmReadyForCompanion(this.deps.host);
      const llm = llmReady ? (this.deps.getLlm?.() ?? null) : null;

      let text: string;
      let pingSkills: string[];
      if (llmReady) {
        const ping = await composeCompanionPing(llm, facts);
        text = ping.text;
        pingSkills = ping.pingSkills;
        if (ping.usedLlm) {
          console.log('[ghampus-check-in] LLM companion ping authored');
        }
      } else {
        const suggestSkill = facts.suggestSkills[0] ?? null;
        text = buildCheckInText({
          now: new Date(now),
          notifications: facts.notifications,
          corrections: facts.corrections,
          contradictions: facts.contradictions,
          duplicates: facts.duplicates,
          suggestSkill,
        });
        pingSkills = suggestSkill && isSafeAutoPreviewSkill(suggestSkill) ? [suggestSkill] : [];
      }

      const msg = {
        kind: 'ghampus' as const,
        text,
        ts: now,
        messageId: `checkin-${now}`,
        citations: [
          { kind: 'other' as const, label: 'Scheduled check-in', detail: llmReady ? 'LLM companion pulse' : 'Templated pulse' },
        ],
      };
      const { appendGhampusHistoryMessage } = await import('./ghampus-history-cache.js');
      await appendGhampusHistoryMessage(this.deps.cortexDir, msg);
      try {
        this.deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: msg });
      } catch { /* non-fatal */ }

      this.state.lastCheckInAt = now;
      await saveState(this.deps.cortexDir, this.state);

      // Ping other Agempi via allowlisted @skill: read-only previews.
      for (const skill of pingSkills.slice(0, 2)) {
        void runSafeSkillPreview(
          {
            host: this.deps.host,
            skillTrainer: this.deps.skillTrainer,
            broadcastRaw: this.deps.broadcastRaw,
            cortexDir: this.deps.cortexDir,
          },
          skill,
          llmReady
            ? `Ghampus companion ping → @skill:${skill} (read-only).`
            : 'From your scheduled check-in — integrity / schedule needs attention.',
        );
      }

      console.log(`[ghampus-check-in] emitted check-in llm=${llmReady} skills=${pingSkills.join(',') || 'none'}`);
      return { emitted: true };
    } catch (err) {
      console.error('[ghampus-check-in] tick error:', err);
      return { emitted: false };
    } finally {
      this.tickInFlight = false;
    }
  }
}

export { DEFAULT_INTERVAL_MS, DEFAULT_STARTUP_DELAY_MS };
