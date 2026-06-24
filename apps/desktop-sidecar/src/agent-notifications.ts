// Notifications layer for Ghampus.
//
// Surfaces inbound activity — new sources arriving via direct ingest,
// connectors, AI client conversation saves, shared-engram editor writes
// — as a flat, time-ordered feed. Drives the "While you were away" panel.
//
// Distinct from `listRecentSaves` in agent-tools.ts: that one returns
// sources Ghampus *itself* saved (addedBy === 'ghampus'). This one is the
// inverse — every source EXCEPT those, plus a synthesised `kind` so the
// UI can pick the right icon ("github" → 🐙, "claude-ai" → 💬, etc.).

import type { GraphnosisHost } from './host.js';
import { formatUserVisibleSourceLabel } from './agent-tools.js';

export interface AgentNotificationsDeps {
  host: GraphnosisHost;
}

export interface NotificationEntry {
  /** Stable id for dismiss/mark-read tracking — composed of engramId + sourceId. */
  id: string;
  /** Engram this notification belongs to. */
  engramId: string;
  /** Sensitivity tier of the engram — drives whether previews are shown. */
  tier: 'public' | 'personal' | 'sensitive';
  /** Source id (links back to the underlying SourceRecord). */
  sourceId: string;
  /**
   * Origin kind, used for icon + grouping in the UI:
   *   - 'connector'      — pulled by a connector (GitHub, Slack, RSS, etc.)
   *   - 'ai-client'      — saved by an external MCP client (Claude, Cursor)
   *   - 'sharing'        — written via an editor-role sharing token
   *   - 'direct'         — user added it via the app (file picker, paste)
   *   - 'other'          — fallback for anything we can't categorise.
   */
  originKind: 'connector' | 'ai-client' | 'sharing' | 'direct' | 'other';
  /** Free-form attribution string from SourceRecord.addedBy or ref. */
  origin: string;
  /** Human-readable label parsed from the source ref. */
  label: string;
  /** Unix ms when the source was ingested. */
  ingestedAtMs: number;
}

export interface NotificationArgs {
  /** Cap the number of entries returned. Default 20. */
  limit?: number | undefined;
  /**
   * Lower bound on `ingestedAtMs`. Defaults to 7 days ago. The frontend
   * uses localStorage to track "last visited at" and passes that here so
   * the panel shows truly-new activity rather than a rolling window.
   */
  sinceMs?: number | undefined;
}

export interface NotificationResult {
  notifications: NotificationEntry[];
  /** Total available count past the limit, so the UI can show "12 more". */
  totalAvailable: number;
}

/** Map the SourceRecord.addedBy string to the broad UI category. */
function classifyOrigin(addedBy: string | undefined, ref: string): NotificationEntry['originKind'] {
  if (!addedBy) {
    // Direct app ingest (file picker, paste) — addedBy is undefined.
    return 'direct';
  }
  if (addedBy === 'ghampus') return 'other'; // filtered out anyway, defensive
  if (/^(github|slack|rss|obsidian|trello|linear|webhook)/i.test(addedBy)) return 'connector';
  if (/^(claude|cursor|kimi|codex|copilot|vscode|zed|cline)/i.test(addedBy)) return 'ai-client';
  // Sharing-token writes carry the share-name as addedBy in op-log; here
  // we accept anything ref-prefixed `sharing:` as a sharing event.
  if (ref.startsWith('sharing:')) return 'sharing';
  return 'other';
}

/** Strip filename-ish refs to a clean display string. */
function readableLabel(ref: string, sourceId: string): string {
  return formatUserVisibleSourceLabel(ref, sourceId);
}

/**
 * Build the inbound feed across all loaded engrams. Cheap enough for
 * normal cortex sizes (linear scan of source indexes); a future
 * optimisation could maintain a tail-of-recent-ingests list separately,
 * but right now the simple scan keeps the code obvious.
 *
 * Ghampus-saved sources are excluded — they live in the recent-saves
 * panel instead, so users see two clean buckets: "what I saved during
 * chats" and "what arrived from elsewhere".
 */
export function listNotifications(
  deps: AgentNotificationsDeps,
  args: NotificationArgs,
): NotificationResult {
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(50, Math.floor(args.limit)) : 20;
  const sinceMs = typeof args.sinceMs === 'number'
    ? args.sinceMs
    : Date.now() - 7 * 24 * 60 * 60 * 1000;

  const all: NotificationEntry[] = [];
  const tierByEngram = new Map<string, NotificationEntry['tier']>();
  for (const { graphId, metadata } of deps.host.graphsWithMetadata()) {
    const tier = ((metadata as { sensitivityTier?: string }).sensitivityTier ?? 'personal') as NotificationEntry['tier'];
    tierByEngram.set(graphId, tier);
  }

  for (const engramId of deps.host.listGraphs()) {
    const sources = deps.host.listSources(engramId);
    for (const s of sources) {
      if (s.addedBy === 'ghampus') continue;
      if (s.ingestedAt < sinceMs) continue;
      const originKind = classifyOrigin(s.addedBy, s.ref);
      all.push({
        id: `${engramId}:${s.sourceId}`,
        engramId,
        tier: tierByEngram.get(engramId) ?? 'personal',
        sourceId: s.sourceId,
        originKind,
        origin: s.addedBy ?? 'app',
        label: readableLabel(s.ref, s.sourceId),
        ingestedAtMs: s.ingestedAt,
      });
    }
  }
  all.sort((a, b) => b.ingestedAtMs - a.ingestedAtMs);
  return {
    notifications: all.slice(0, limit),
    totalAvailable: all.length,
  };
}
