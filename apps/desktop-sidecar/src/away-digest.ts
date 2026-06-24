/**
 * "While you were away" digest builder for Ghampus.
 * Groups inbound notifications by originKind, redacts sensitive tiers,
 * and optionally synthesizes a one-line summary via local LLM.
 */

import type { NotificationEntry } from './agent-notifications.js';
import type { LocalLlm } from './correction.js';

export const AWAY_DIGEST_PREFIX = '**While you were away**';
export const QUIET_AWAY_DIGEST_RE = /all quiet/i;
export const AWAY_DIGEST_DEDUPE_MS = 6 * 60 * 60 * 1000;

const ORIGIN_KIND_LABELS: Record<NotificationEntry['originKind'], string> = {
  connector: 'connectors',
  'ai-client': 'AI clients',
  sharing: 'shared edits',
  direct: 'direct adds',
  other: 'other sources',
};

export interface AwayDigestHistMsg {
  kind?: string;
  text?: string;
  ts?: number;
}

/** True when a persisted ghampus message is a quiet away digest. */
export function isQuietAwayDigestText(text: string): boolean {
  return text.startsWith(AWAY_DIGEST_PREFIX) && QUIET_AWAY_DIGEST_RE.test(text);
}

/**
 * Check whether a recent away digest was already emitted (6h dedupe window).
 * `quietOnly` restricts to quiet digests — used when there's nothing new to report.
 */
export function hasRecentAwayDigest(
  tail: AwayDigestHistMsg[],
  quietOnly: boolean,
  now = Date.now(),
): boolean {
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    if (m?.kind !== 'ghampus' || !String(m.text ?? '').startsWith(AWAY_DIGEST_PREFIX)) continue;
    const ts = typeof m.ts === 'number' ? m.ts : 0;
    if (now - ts >= AWAY_DIGEST_DEDUPE_MS) continue;
    if (quietOnly && !isQuietAwayDigestText(String(m.text))) continue;
    return true;
  }
  return false;
}

/** Group notifications by originKind with counts. */
export function groupNotificationsByOrigin(
  notifications: NotificationEntry[],
): Map<NotificationEntry['originKind'], NotificationEntry[]> {
  const groups = new Map<NotificationEntry['originKind'], NotificationEntry[]>();
  for (const n of notifications) {
    const arr = groups.get(n.originKind) ?? [];
    arr.push(n);
    groups.set(n.originKind, arr);
  }
  return groups;
}

function formatPreview(n: NotificationEntry): string {
  if (n.tier === 'sensitive') return '[preview hidden · sensitive engram]';
  return n.label;
}

/** Build grouped digest body (no LLM). */
export function buildGroupedDigestBody(
  notifications: NotificationEntry[],
  totalAvailable: number,
): string {
  const groups = groupNotificationsByOrigin(notifications);
  const count = notifications.length;
  const header =
    totalAvailable > count
      ? `${totalAvailable} items since your last visit`
      : `${count} item${count === 1 ? '' : 's'} since your last visit`;

  const groupLines: string[] = [];
  for (const [kind, items] of groups) {
    const label = ORIGIN_KIND_LABELS[kind] ?? kind;
    const previews = items.slice(0, 3).map((n) => formatPreview(n)).join('; ');
    const more = items.length > 3 ? ` (+${items.length - 3} more)` : '';
    groupLines.push(`- **${items.length}** from ${label}: ${previews}${more}`);
  }

  return `${header}\n\n${groupLines.join('\n')}`;
}

/** Strip markdown wrappers LLMs often add — Ghampus renders plain + **bold** only. */
export function sanitizeDigestSummaryLine(raw: string): string {
  let line = raw.trim().split('\n')[0]?.trim() ?? '';
  line = line.replace(/^["']|["']$/g, '');
  line = line.replace(/^\*\*(.+)\*\*$/, '$1');
  line = line.replace(/^_(.+)_$/, '$1');
  line = line.replace(/[*_`]/g, '');
  return line.trim();
}

/** Optional local-LLM one-liner over grouped counts — no sensitive content in prompt. */
export async function maybeSummarizeDigest(
  llm: LocalLlm | null | undefined,
  notifications: NotificationEntry[],
): Promise<string | null> {
  if (!llm || notifications.length === 0) return null;

  const groups = groupNotificationsByOrigin(notifications);
  const summaryInput = Array.from(groups.entries())
    .map(([kind, items]) => `${ORIGIN_KIND_LABELS[kind] ?? kind}: ${items.length}`)
    .join(', ');

  const prompt =
    `Summarize this inbound activity digest in one friendly sentence (max 25 words). ` +
    `Only use the counts provided — do not invent details.\n\nCounts: ${summaryInput}`;

  try {
    const output = await llm.complete({
      system:
        'You write concise activity digests in plain text only. No markdown, no underscores, no bold, no quotes.',
      user: prompt,
    });
    const line = sanitizeDigestSummaryLine(output);
    return line.length > 10 ? line : null;
  } catch {
    return null;
  }
}

/** Strip LLM markdown wrappers from away-digest lines (legacy _italics_ one-liners). */
export function sanitizeAwayDigestBody(text: string): string {
  if (!text.startsWith(AWAY_DIGEST_PREFIX)) return text;
  return text.replace(/(?<![\w/])_([^_\n]+?)_(?![\w/])/g, '$1');
}

/** Full away digest text for ghampus-history.jsonl. */
export async function buildAwayDigestText(
  notifications: NotificationEntry[],
  totalAvailable: number,
  llm?: LocalLlm | null,
): Promise<string> {
  if (notifications.length === 0) {
    return `${AWAY_DIGEST_PREFIX} (just now) — all quiet. Nothing new arrived in your cortex.`;
  }

  const body = buildGroupedDigestBody(notifications, totalAvailable);
  const [headline, ...groupLines] = body.split('\n');
  const summary = await maybeSummarizeDigest(llm ?? null, notifications);
  const summaryBlock = summary ? `\n\n${summary}` : '';
  const groupsBlock = groupLines.filter(Boolean).join('\n');
  return sanitizeAwayDigestBody(`${AWAY_DIGEST_PREFIX} — ${headline}${summaryBlock}\n\n${groupsBlock}`);
}
