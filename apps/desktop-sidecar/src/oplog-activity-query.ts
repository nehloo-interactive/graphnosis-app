/**
 * Bounded, tail-first op-log reads for Activity — avoids full readAllEvents().
 *
 * Uses the memory-bounded index/decrypt primitives from oplog-safe-read.ts
 * rather than reading each whole `.oplog` file into one Buffer. A stale or
 * long-lived device file can grow into the multi-GB range on a "large
 * cortex"; slurping it whole via fs.readFile() is exactly what throws ENOMEM.
 * Indexing headers via small positional reads and decrypting one chunk's
 * ciphertext at a time keeps this bounded regardless of file size.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { oplog, type OpLogEvent } from '@nehloo-interactive/graphnosis-secure-sync';
import { indexOplogFile, decryptIndexEntry } from './oplog-safe-read.js';

export type ActivityOplogCursor = { ts: number; id: string };

export type ActivityOplogQuery = {
  oplogDir: string;
  key: Uint8Array;
  readOpts: oplog.ReadOpLogOptions;
  since?: number;
  until?: number;
  limit?: number;
  cursor?: ActivityOplogCursor;
  ops?: string[];
  actor?: string;
  actorOf: (ev: OpLogEvent) => { label: string };
};

export type ActivityOplogResult = {
  events: OpLogEvent[];
  actors: string[];
  hasMore: boolean;
  nextCursor?: ActivityOplogCursor;
};

export type IngestGrowthQuery = {
  oplogDir: string;
  key: Uint8Array;
  readOpts: oplog.ReadOpLogOptions;
  /** Number of calendar-day buckets ending today (default 90). */
  days?: number;
};

export type IngestGrowthResult = {
  total: number;
  /** One count per day, oldest → newest (length === days). */
  buckets: number[];
  days: number;
};

function dayStartMs(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ingestGrowthRange(days: number): { since: number; todayStart: number; buckets: number[] } {
  const todayStart = dayStartMs(Date.now());
  const since = todayStart - (days - 1) * 86_400_000;
  return { since, todayStart, buckets: new Array(days).fill(0) as number[] };
}

function bucketIngestEvent(
  ev: OpLogEvent,
  days: number,
  since: number,
  todayStart: number,
  buckets: number[],
): boolean {
  if (ev.op !== 'ingestSource') return false;
  if (ev.ts <= since) return false;
  const idx = days - 1 - Math.floor((todayStart - dayStartMs(ev.ts)) / 86_400_000);
  if (idx < 0 || idx >= days) return false;
  buckets[idx]! += 1;
  return true;
}

function compareNewestFirst(a: OpLogEvent, b: OpLogEvent): number {
  if (b.ts !== a.ts) return b.ts - a.ts;
  return b.id.localeCompare(a.id);
}

function isOlderThanCursor(ev: OpLogEvent, cursor: ActivityOplogCursor): boolean {
  if (ev.ts < cursor.ts) return true;
  if (ev.ts > cursor.ts) return false;
  return ev.id < cursor.id;
}

function eventInRange(
  ev: OpLogEvent,
  since: number | undefined,
  until: number | undefined,
): boolean {
  if (since !== undefined && ev.ts <= since) return false;
  if (until !== undefined && ev.ts > until) return false;
  return true;
}

export async function queryOplogForActivity(q: ActivityOplogQuery): Promise<ActivityOplogResult> {
  if (q.since !== undefined && q.until !== undefined && q.until <= q.since) {
    return { events: [], actors: [], hasMore: false };
  }

  const limit = q.limit ?? 2000;
  const need = limit + 1;
  const opsSet = q.ops?.length ? new Set(q.ops) : null;
  const matches: OpLogEvent[] = [];
  const actorSet = new Set<string>();
  const now = q.readOpts.now ?? Date.now();
  const maxSkew = q.readOpts.maxClockSkewMs ?? 86_400_000;

  let entries: string[] = [];
  try {
    entries = await fs.readdir(q.oplogDir);
  } catch {
    return { events: [], actors: [], hasMore: false };
  }

  outer:
  for (const name of entries) {
    if (!name.endsWith('.oplog')) continue;
    const filePath = path.join(q.oplogDir, name);
    const index = await indexOplogFile(filePath);
    if (index.format === 'empty' || index.entries.length === 0) continue;

    const fh = await fs.open(filePath, 'r');
    try {
      // Tail-first: newest chunk (highest file offset) is scanned first, so
      // pagination can stop as soon as it has enough matches without ever
      // touching older chunks.
      for (let i = index.entries.length - 1; i >= 0; i--) {
        const chunkEvents = await decryptIndexEntry(fh, index.entries[i]!, q.key, name, q.readOpts);
        if (chunkEvents.length === 0) continue;

        let maxTs = chunkEvents[0]!.ts;
        let minTs = chunkEvents[0]!.ts;
        for (const ev of chunkEvents) {
          if (ev.ts > maxTs) maxTs = ev.ts;
          if (ev.ts < minTs) minTs = ev.ts;
        }

        if (q.until !== undefined && minTs > q.until) continue;
        if (q.since !== undefined && maxTs <= q.since) break;

        for (let j = chunkEvents.length - 1; j >= 0; j--) {
          const ev = chunkEvents[j]!;
          if (typeof ev.ts === 'number' && ev.ts > now + maxSkew) continue;
          if (!eventInRange(ev, q.since, q.until)) continue;
          if (opsSet && !opsSet.has(ev.op)) continue;
          if (q.cursor && !isOlderThanCursor(ev, q.cursor)) continue;

          actorSet.add(q.actorOf(ev).label);
          if (q.actor && q.actorOf(ev).label !== q.actor) continue;

          matches.push(ev);
          if (matches.length >= need) break outer;
        }
      }
    } finally {
      await fh.close();
    }
  }

  matches.sort(compareNewestFirst);
  const hasMore = matches.length > limit;
  const page = matches.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page,
    actors: [...actorSet].sort((a, b) => a.localeCompare(b)),
    hasMore,
    ...(last ? { nextCursor: { ts: last.ts, id: last.id } } : {}),
  };
}

/** Tail-first op-log scan that aggregates ingestSource into daily buckets — no event payload. */
export async function queryOplogIngestGrowth(q: IngestGrowthQuery): Promise<IngestGrowthResult> {
  const days = q.days ?? 90;
  const { since, todayStart, buckets } = ingestGrowthRange(days);
  let total = 0;
  const now = q.readOpts.now ?? Date.now();
  const maxSkew = q.readOpts.maxClockSkewMs ?? 86_400_000;

  let entries: string[] = [];
  try {
    entries = await fs.readdir(q.oplogDir);
  } catch {
    return { total: 0, buckets, days };
  }

  outer:
  for (const name of entries) {
    if (!name.endsWith('.oplog')) continue;
    const filePath = path.join(q.oplogDir, name);
    const index = await indexOplogFile(filePath);
    if (index.format === 'empty' || index.entries.length === 0) continue;

    const fh = await fs.open(filePath, 'r');
    try {
      for (let i = index.entries.length - 1; i >= 0; i--) {
        const chunkEvents = await decryptIndexEntry(fh, index.entries[i]!, q.key, name, q.readOpts);
        if (chunkEvents.length === 0) continue;

        let maxTs = chunkEvents[0]!.ts;
        let minTs = chunkEvents[0]!.ts;
        for (const ev of chunkEvents) {
          if (ev.ts > maxTs) maxTs = ev.ts;
          if (ev.ts < minTs) minTs = ev.ts;
        }

        if (minTs > todayStart + 86_400_000) continue;
        if (maxTs <= since) break outer;

        for (let j = chunkEvents.length - 1; j >= 0; j--) {
          const ev = chunkEvents[j]!;
          if (typeof ev.ts === 'number' && ev.ts > now + maxSkew) continue;
          if (ev.ts <= since) continue;
          if (bucketIngestEvent(ev, days, since, todayStart, buckets)) total += 1;
        }
      }
    } finally {
      await fh.close();
    }
  }

  return { total, buckets, days };
}

/** Aggregate ingest growth from a warm full op-log cache. */
export function sliceOplogCacheForIngestGrowth(
  all: OpLogEvent[],
  days = 90,
): IngestGrowthResult {
  const { since, todayStart, buckets } = ingestGrowthRange(days);
  let total = 0;
  for (const ev of all) {
    if (bucketIngestEvent(ev, days, since, todayStart, buckets)) total += 1;
  }
  return { total, buckets, days };
}

/** Slice a warm full op-log cache without re-reading disk. */
export function sliceOplogCacheForActivity(
  all: OpLogEvent[],
  q: Omit<ActivityOplogQuery, 'oplogDir' | 'key' | 'readOpts'>,
): ActivityOplogResult {
  if (q.since !== undefined && q.until !== undefined && q.until <= q.since) {
    return { events: [], actors: [], hasMore: false };
  }
  const limit = q.limit ?? 2000;
  const opsSet = q.ops?.length ? new Set(q.ops) : null;
  const actorSet = new Set<string>();
  const filtered: OpLogEvent[] = [];

  for (const ev of all) {
    if (!eventInRange(ev, q.since, q.until)) continue;
    if (opsSet && !opsSet.has(ev.op)) continue;
    actorSet.add(q.actorOf(ev).label);
  }

  for (const ev of all) {
    if (!eventInRange(ev, q.since, q.until)) continue;
    if (opsSet && !opsSet.has(ev.op)) continue;
    if (q.actor && q.actorOf(ev).label !== q.actor) continue;
    if (q.cursor && !isOlderThanCursor(ev, q.cursor)) continue;
    filtered.push(ev);
  }

  filtered.sort(compareNewestFirst);
  const need = limit + 1;
  const slice = filtered.slice(0, need);
  const hasMore = slice.length > limit;
  const page = slice.slice(0, limit);
  const last = page[page.length - 1];
  return {
    events: page,
    actors: [...actorSet].sort((a, b) => a.localeCompare(b)),
    hasMore,
    ...(last ? { nextCursor: { ts: last.ts, id: last.id } } : {}),
  };
}
