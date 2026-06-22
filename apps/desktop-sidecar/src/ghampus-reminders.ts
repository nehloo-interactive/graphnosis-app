/**
 * Ghampus autonomous todo / obligation reminders.
 *
 * Scans the obligation index + heuristic todo lines with parsed due dates.
 * Emits ghampus.reminder events and persists summaries to ghampus-history.jsonl.
 * Sensitive engrams are excluded from scanning (consent-safe autonomous recall).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { effectiveSensitivityTier, sanitizeClassificationSchema } from '@graphnosis-app/core';
import {
  resolveGhampusRemindersSettings,
  type GhampusReminderKind,
} from '@graphnosis-app/core/settings';
import type { GraphnosisHost } from './host.js';
import type { BroadcastRawFn } from './events.js';
import { extractDueDateFromLine, lineLooksTemporalTodo } from './ghampus-temporal-parse.js';
import { extractTodoBulletsFromText } from './ghampus-recall-format.js';
import { isGhampusBusy } from './ghampus-busy.js';
import { shouldDeferGhampusBackground, scaleGhampusStartupDelay } from './background-lane-scheduler.js';

export interface ReminderItem {
  id: string;
  label: string;
  expiresAt: number;
  hasTime: boolean;
  engram?: string;
  overdue: boolean;
  source: 'obligation' | 'heuristic';
}

export interface GhampusReminderPayload {
  id: string;
  kind: GhampusReminderKind;
  title: string;
  text: string;
  ts: number;
  itemCount: number;
  notify: boolean;
}

interface ReminderState {
  version: 1;
  lastStartupDay?: string;
  lastDailyDay?: string;
  lastWeeklyKey?: string;
  notifiedItems: Record<string, number>;
  snoozedItems: Record<string, number>;
  snoozedAllUntil?: number;
}

export interface GhampusReminderSchedulerDeps {
  host: GraphnosisHost;
  broadcastRaw: BroadcastRawFn;
  cortexDir: string;
}

const TICK_MS = 5 * 60_000;
const STATE_FILE = 'ghampus-reminder-state.json';
const DUE_SOON_MS = 24 * 60 * 60_000;
const DUE_NOW_WINDOW_MS = 15 * 60_000;
const PRE_DUE_MS = 60 * 60_000;
const ITEM_NOTIFY_COOLDOWN_MS = 12 * 60 * 60_000;
const WEEKLY_LOOKAHEAD_MS = 7 * 24 * 60 * 60_000;

export const REMINDER_PREFIXES: Record<GhampusReminderKind, string> = {
  startup: '**Your todos — startup**',
  daily: '**Daily todo summary**',
  weekly: '**Weekly todo summary**',
  'due-soon': '**Due soon**',
  'due-now': '**Due now**',
};

function localDayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoWeekKey(d = new Date()): string {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function formatDueLabel(item: ReminderItem, now: number): string {
  if (item.overdue) {
    const days = Math.ceil((now - item.expiresAt) / (24 * 60 * 60_000));
    return days > 0 ? `overdue ${days}d` : 'overdue';
  }
  const diff = item.expiresAt - now;
  if (diff <= 0) return 'due now';
  if (diff < 24 * 60 * 60_000) {
    if (item.hasTime) {
      return `today ${formatClock(item.expiresAt)}`;
    }
    return 'due today';
  }
  const days = Math.ceil(diff / (24 * 60 * 60_000));
  if (days === 1) return item.hasTime ? `tomorrow ${formatClock(item.expiresAt)}` : 'due tomorrow';
  return `due in ${days}d`;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatItemsBody(items: ReminderItem[], now: number, max = 12): string {
  const sorted = [...items].sort((a, b) => a.expiresAt - b.expiresAt);
  const lines = sorted.slice(0, max).map((item) => {
    const engram = item.engram ? ` · ${item.engram}` : '';
    return `- ${item.label.replace(/^-\s*/, '')} (${formatDueLabel(item, now)}${engram})`;
  });
  if (sorted.length > max) lines.push(`- …and ${sorted.length - max} more`);
  return lines.join('\n');
}

async function loadState(cortexDir: string): Promise<ReminderState> {
  try {
    const raw = await fs.readFile(path.join(cortexDir, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as ReminderState;
    if (parsed.version !== 1) throw new Error('bad version');
    return {
      version: 1,
      notifiedItems: parsed.notifiedItems ?? {},
      snoozedItems: parsed.snoozedItems ?? {},
      ...(typeof parsed.lastStartupDay === 'string' ? { lastStartupDay: parsed.lastStartupDay } : {}),
      ...(typeof parsed.lastDailyDay === 'string' ? { lastDailyDay: parsed.lastDailyDay } : {}),
      ...(typeof parsed.lastWeeklyKey === 'string' ? { lastWeeklyKey: parsed.lastWeeklyKey } : {}),
      ...(typeof parsed.snoozedAllUntil === 'number' ? { snoozedAllUntil: parsed.snoozedAllUntil } : {}),
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT' && !(e instanceof SyntaxError)) {
      console.error(`[ghampus-reminders] state load failed: ${err.message}`);
    }
    return { version: 1, notifiedItems: {}, snoozedItems: {} };
  }
}

async function saveState(cortexDir: string, state: ReminderState): Promise<void> {
  const target = path.join(cortexDir, STATE_FILE);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}

function scannableGraphIds(host: GraphnosisHost): string[] {
  const schema = sanitizeClassificationSchema(host.getSettings().compliance?.classificationSchema);
  return host.listGraphs().filter((graphId) => {
    const meta = host.getGraphMetadata(graphId);
    const tier = effectiveSensitivityTier(meta ?? { template: 'personal', displayName: graphId, createdAt: 0 }, schema);
    return tier !== 'sensitive';
  });
}

export class GhampusReminderScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private state: ReminderState = { version: 1, notifiedItems: {}, snoozedItems: {} };
  private stateLoaded = false;
  private tickInFlight = false;

  constructor(private deps: GhampusReminderSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    void this.init().then(() => {
      const base = resolveGhampusRemindersSettings(this.deps.host.getSettings().agent).startupDelayMs;
      const delay = scaleGhampusStartupDelay(this.deps.host, base);
      this.startupTimer = setTimeout(() => { void this.tick(true); }, delay);
      this.startupTimer.unref?.();
      this.timer = setInterval(() => { void this.tick(false); }, TICK_MS);
      this.timer.unref?.();
    });
  }

  stop(): void {
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Test hook — run one scan synchronously. */
  async tickForTest(startup = false): Promise<{ emitted: GhampusReminderKind[]; itemCount: number }> {
    await this.init();
    return this.tick(startup);
  }

  snoozeItem(itemId: string, snoozeMs: number): void {
    this.state.snoozedItems[itemId] = Date.now() + snoozeMs;
    void saveState(this.deps.cortexDir, this.state);
  }

  snoozeAll(snoozeMs: number): void {
    this.state.snoozedAllUntil = Date.now() + snoozeMs;
    void saveState(this.deps.cortexDir, this.state);
  }

  private async init(): Promise<void> {
    if (this.stateLoaded) return;
    this.state = await loadState(this.deps.cortexDir);
    this.stateLoaded = true;
  }

  private isEnabled(): boolean {
    if (this.deps.host.getSettings().agent?.enabled === false) return false;
    return resolveGhampusRemindersSettings(this.deps.host.getSettings().agent).enabled;
  }

  private itemSnoozed(itemId: string, now: number): boolean {
    const until = this.state.snoozedItems[itemId] ?? 0;
    return until > now;
  }

  private recentlyNotified(itemId: string, now: number): boolean {
    const last = this.state.notifiedItems[itemId] ?? 0;
    return now - last < ITEM_NOTIFY_COOLDOWN_MS;
  }

  private markNotified(itemIds: string[], now: number): void {
    for (const id of itemIds) this.state.notifiedItems[id] = now;
    void saveState(this.deps.cortexDir, this.state);
  }

  private async collectItems(now: number): Promise<ReminderItem[]> {
    const host = this.deps.host;
    const graphIds = scannableGraphIds(host);
    const byId = new Map<string, ReminderItem>();

    await host.obligationIndex.ensureLoaded();
    const obligations = host.obligationIndex.list({
      ...(graphIds.length ? { graphIds } : {}),
      includeOverdue: true,
      dueWithinMs: WEEKLY_LOOKAHEAD_MS,
      maxResults: 40,
      now,
    });

    for (const ob of obligations) {
      const meta = host.getGraphMetadata(ob.graphId);
      const node = host.listNodes(ob.graphId).find((n) => n.id === ob.nodeId);
      const preview = (node?.contentPreview ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
      const id = `ob:${ob.graphId}:${ob.nodeId}`;
      byId.set(id, {
        id,
        label: preview || '(obligation)',
        expiresAt: ob.expiresAt,
        hasTime: ob.expiresAt % (24 * 60 * 60_000) !== 0,
        engram: meta?.displayName ?? ob.graphId,
        overdue: ob.expiresAt <= now,
        source: 'obligation',
      });
    }

    const searchQueries = ['deadline due todo', 'termen scadent sarcini'];
    for (const graphId of graphIds) {
      const meta = host.getGraphMetadata(graphId);
      const engram = meta?.displayName ?? graphId;
      const seenTexts = new Set<string>();
      for (const q of searchQueries) {
        let hits: Array<{ nodeId: string; text?: string }>;
        try {
          hits = await host.searchNodes(graphId, q, 8);
        } catch {
          continue;
        }
        for (const hit of hits) {
          const content = host.getFullNodeContent(graphId, hit.nodeId) ?? hit.text ?? '';
          if (!content.trim()) continue;
          const textKey = content.slice(0, 200);
          if (seenTexts.has(textKey)) continue;
          seenTexts.add(textKey);

          const lines = [
            ...extractTodoBulletsFromText(content),
            ...content.split('\n').filter(lineLooksTemporalTodo),
          ];
          for (const line of lines) {
            const parsed = extractDueDateFromLine(line, new Date(now));
            if (!parsed) continue;
            if (parsed.expiresAt < now - 30 * 24 * 60 * 60_000) continue;
            if (parsed.expiresAt > now + WEEKLY_LOOKAHEAD_MS) continue;
            const label = line.replace(/^[-*•]\s*/, '').trim().slice(0, 120);
            const id = `heur:${graphId}:${hashId(label)}`;
            if (byId.has(id)) continue;
            byId.set(id, {
              id,
              label,
              expiresAt: parsed.expiresAt,
              hasTime: parsed.hasTime,
              engram,
              overdue: parsed.expiresAt <= now,
              source: 'heuristic',
            });
          }
        }
      }
    }

    return [...byId.values()].filter((item) => !this.itemSnoozed(item.id, now));
  }

  private async tick(startupPass: boolean): Promise<{ emitted: GhampusReminderKind[]; itemCount: number }> {
    const emitted: GhampusReminderKind[] = [];
    if (this.tickInFlight) return { emitted, itemCount: 0 };
    if (!this.isEnabled()) return { emitted, itemCount: 0 };
    if (isGhampusBusy()) return { emitted, itemCount: 0 };
    if (shouldDeferGhampusBackground(this.deps.host)) return { emitted, itemCount: 0 };

    this.tickInFlight = true;
    try {
      await this.init();
      const now = Date.now();
      if ((this.state.snoozedAllUntil ?? 0) > now) return { emitted, itemCount: 0 };

      const items = await this.collectItems(now);
      if (items.length === 0) return { emitted, itemCount: 0 };

      const settings = resolveGhampusRemindersSettings(this.deps.host.getSettings().agent);
      const day = localDayKey(new Date(now));
      const week = isoWeekKey(new Date(now));

      const overdue = items.filter((i) => i.overdue);
      const dueToday = items.filter((i) => !i.overdue && i.expiresAt - now < 24 * 60 * 60_000);
      const dueWeek = items.filter((i) => !i.overdue && i.expiresAt - now <= WEEKLY_LOOKAHEAD_MS);

      if (startupPass && this.state.lastStartupDay !== day) {
        const summaryItems = [...overdue, ...dueToday, ...dueWeek].slice(0, 15);
        if (summaryItems.length > 0) {
          await this.emitReminder('startup', summaryItems, now, settings.nativeNotifications);
          this.state.lastStartupDay = day;
          this.state.lastDailyDay = day;
          emitted.push('startup');
        }
      } else if (this.state.lastDailyDay !== day) {
        const summaryItems = [...overdue, ...dueToday];
        if (summaryItems.length > 0) {
          await this.emitReminder('daily', summaryItems, now, settings.nativeNotifications);
          this.state.lastDailyDay = day;
          emitted.push('daily');
        }
      }

      if (this.state.lastWeeklyKey !== week && dueWeek.length > 0) {
        await this.emitReminder('weekly', dueWeek, now, settings.nativeNotifications);
        this.state.lastWeeklyKey = week;
        emitted.push('weekly');
      }

      const dueSoon = items.filter((i) =>
        !i.overdue
        && i.expiresAt - now <= DUE_SOON_MS
        && i.expiresAt - now > DUE_NOW_WINDOW_MS
        && !this.recentlyNotified(i.id, now),
      );
      if (dueSoon.length > 0) {
        await this.emitReminder('due-soon', dueSoon, now, settings.nativeNotifications);
        this.markNotified(dueSoon.map((i) => i.id), now);
        emitted.push('due-soon');
      }

      const dueNow = items.filter((i) => {
        if (this.recentlyNotified(i.id, now)) return false;
        const delta = i.expiresAt - now;
        if (i.hasTime) {
          return delta <= DUE_NOW_WINDOW_MS && delta >= -DUE_NOW_WINDOW_MS;
        }
        const sameDay = localDayKey(new Date(i.expiresAt)) === day;
        return sameDay && delta <= PRE_DUE_MS && delta >= -DUE_NOW_WINDOW_MS;
      });
      if (dueNow.length > 0) {
        await this.emitReminder('due-now', dueNow, now, settings.nativeNotifications);
        this.markNotified(dueNow.map((i) => i.id), now);
        emitted.push('due-now');
      }

      await saveState(this.deps.cortexDir, this.state);
      return { emitted, itemCount: items.length };
    } catch (err) {
      console.error('[ghampus-reminders] tick error:', err);
      return { emitted, itemCount: 0 };
    } finally {
      this.tickInFlight = false;
    }
  }

  private async emitReminder(
    kind: GhampusReminderKind,
    items: ReminderItem[],
    now: number,
    notify: boolean,
  ): Promise<void> {
    const prefix = REMINDER_PREFIXES[kind];
    const body = formatItemsBody(items, now);
    const text = `${prefix}\n\n${body}`;
    const title = prefix.replace(/\*\*/g, '');

    const payload: GhampusReminderPayload = {
      id: `reminder-${kind}-${now}`,
      kind,
      title,
      text,
      ts: now,
      itemCount: items.length,
      notify,
    };

    const histPath = path.join(this.deps.cortexDir, 'ghampus-history.jsonl');
    const histLine = JSON.stringify({ kind: 'ghampus', text, ts: now, reminderKind: kind });
    await fs.appendFile(histPath, histLine + '\n').catch(() => {});
    const { appendGhampusHistoryCacheMessage } = await import('./ghampus-history-cache.js');
    appendGhampusHistoryCacheMessage({ kind: 'ghampus', text, ts: now, reminderKind: kind });

    try {
      this.deps.broadcastRaw({ kind: 'ghampus.reminder', name: 'ghampus.reminder', payload });
    } catch { /* non-fatal */ }
  }
}

function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
