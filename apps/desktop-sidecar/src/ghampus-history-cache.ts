/**
 * In-memory cache for ghampus-history.jsonl — warmed on sidecar boot so
 * ghampus:history IPC returns instantly when the desktop prefetches or the
 * Ghampus tab opens.
 */
import { readFile } from 'node:fs/promises';

const HISTORY_LIMIT = 100;

type HistMessage = unknown;

interface CacheEntry {
  cortexDir: string;
  messages: HistMessage[];
  ready: boolean;
}

let cache: CacheEntry | null = null;
let loadInflight: Promise<HistMessage[]> | null = null;

function parseHistLines(raw: string): HistMessage[] {
  return raw.trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) as HistMessage; }
    catch { return null; }
  }).filter((m): m is HistMessage => m != null);
}

function histPathFor(cortexDir: string): string {
  return `${cortexDir}/ghampus-history.jsonl`;
}

/** Drop cache — e.g. cortex switch or sidecar restart. */
export function invalidateGhampusHistoryCache(): void {
  cache = null;
  loadInflight = null;
}

/** Append one message after a write — keeps cache warm without a full re-read. */
export function appendGhampusHistoryCacheMessage(msg: HistMessage): void {
  if (!cache?.ready) return;
  cache.messages = [...cache.messages, msg].slice(-HISTORY_LIMIT);
}

async function loadGhampusHistory(cortexDir: string): Promise<HistMessage[]> {
  if (cache?.cortexDir === cortexDir && cache.ready) return cache.messages;
  if (loadInflight) return loadInflight;

  loadInflight = (async () => {
    const raw = await readFile(histPathFor(cortexDir), 'utf8').catch(() => '');
    const messages = parseHistLines(raw).slice(-HISTORY_LIMIT);
    cache = { cortexDir, messages, ready: true };
    return messages;
  })().finally(() => {
    loadInflight = null;
  });

  return loadInflight;
}

/** Fire-and-forget warm — safe during boot; does not block IPC lane. */
export function prefetchGhampusHistory(cortexDir: string): void {
  if (!cortexDir) return;
  void loadGhampusHistory(cortexDir).catch(() => {
    /* non-fatal — ghampus:history falls back to on-demand read */
  });
}

export async function getGhampusHistory(cortexDir: string): Promise<{ messages: HistMessage[]; cached: boolean }> {
  if (!cortexDir) return { messages: [], cached: false };
  if (cache?.cortexDir === cortexDir && cache.ready) {
    return { messages: cache.messages, cached: true };
  }
  const messages = await loadGhampusHistory(cortexDir);
  return { messages, cached: false };
}
