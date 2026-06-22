/**
 * One-time Ghampus card when an engram needs manual .lkg recovery
 * (auto-promote failed or save remains blocked after load).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphId } from '@nehloo-interactive/graphnosis-secure-sync';
import type { GraphnosisHost } from './host.js';
import type { BroadcastRawFn } from './events.js';
import { appendGhampusHistoryCacheMessage } from './ghampus-history-cache.js';

export interface EngramRecoveryNeededPayload {
  graphId: GraphId;
  displayName: string;
  reason: string;
  gaiBytes?: number;
  lkgBytes?: number;
}

export interface GhampusRecoveryNudgePayload {
  id: string;
  graphId: GraphId;
  displayName: string;
  title: string;
  text: string;
  ts: number;
}

const SESSION_NUDGED = new Set<GraphId>();

export function resetRecoveryNudgeSession(): void {
  SESSION_NUDGED.clear();
}

/** Emit a Ghampus recovery card once per engram per sidecar session. */
export async function emitGhampusRecoveryNudge(
  host: GraphnosisHost,
  broadcastRaw: BroadcastRawFn,
  payload: EngramRecoveryNeededPayload,
): Promise<void> {
  if (SESSION_NUDGED.has(payload.graphId)) return;
  SESSION_NUDGED.add(payload.graphId);

  const title = `${payload.displayName} needs recovery`;
  const sizeHint =
    payload.lkgBytes && payload.gaiBytes
      ? ` On disk, the last-known-good snapshot (${Math.round(payload.lkgBytes / 1024)} KB) is much larger than the current file (${Math.round(payload.gaiBytes / 1024)} KB).`
      : '';
  const text =
    `**${title}**\n\n` +
    `This engram could not be auto-restored.${sizeHint} ` +
    'Open **Recovery** and tap **Restore from last known good** to restore the last-known-good backup — ' +
    `or use **Recover from op-log** if that fails.\n\n` +
    `[Open Recovery](#recovery)`;

  const nudge: GhampusRecoveryNudgePayload = {
    id: `recovery-nudge-${payload.graphId}-${Date.now()}`,
    graphId: payload.graphId,
    displayName: payload.displayName,
    title,
    text,
    ts: Date.now(),
  };

  const cortexDir = host.getCortexDir();
  const histLine = JSON.stringify({
    kind: 'ghampus',
    text,
    ts: nudge.ts,
    recoveryNudge: true,
    graphId: payload.graphId,
  });
  await fs.appendFile(path.join(cortexDir, 'ghampus-history.jsonl'), histLine + '\n').catch(() => {});
  appendGhampusHistoryCacheMessage({
    kind: 'ghampus',
    text,
    ts: nudge.ts,
    recoveryNudge: true,
    graphId: payload.graphId,
  });

  try {
    broadcastRaw({ kind: 'ghampus.recovery-nudge', name: 'ghampus.recovery-nudge', payload: nudge });
  } catch { /* non-fatal */ }
}
