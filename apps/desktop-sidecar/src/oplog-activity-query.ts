/**
 * Bounded, tail-first op-log reads for Activity — avoids full readAllEvents().
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  crypto,
  oplog,
  type OpLogEvent,
} from '@nehloo-interactive/graphnosis-secure-sync';

const { decrypt, verify } = crypto;
const V2_MAGIC = oplog.OPLOG_V2_MAGIC;

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

function readU16(u8: Uint8Array, at: number): number {
  return u8[at]! | (u8[at + 1]! << 8);
}

function readU32(u8: Uint8Array, at: number): number {
  return (
    u8[at]!
    | (u8[at + 1]! << 8)
    | (u8[at + 2]! << 16)
    | (u8[at + 3]! << 24)
  ) >>> 0;
}

function startsWith(u8: Uint8Array, prefix: Uint8Array): boolean {
  if (u8.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (u8[i] !== prefix[i]) return false;
  }
  return true;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

interface ParsedV2ChunkFull {
  deviceId: string;
  startSeq: number;
  count: number;
  ctHash: Uint8Array;
  sig: Uint8Array;
  ct: Uint8Array;
  next: number;
}

function parseV2ChunkHeader(u8: Uint8Array, at: number): ParsedV2ChunkFull | null {
  let c = at;
  if (c + 2 > u8.length) return null;
  const idLen = readU16(u8, c); c += 2;
  if (c + idLen > u8.length) return null;
  const deviceId = new TextDecoder().decode(u8.subarray(c, c + idLen)); c += idLen;
  if (c + 12 > u8.length) return null;
  const seqLo = readU32(u8, c); c += 4;
  const seqHi = readU32(u8, c); c += 4;
  const startSeq = seqHi * 0x1_0000_0000 + seqLo;
  const count = readU32(u8, c); c += 4;
  if (c + 32 > u8.length) return null;
  const ctHash = u8.subarray(c, c + 32); c += 32;
  if (c + 64 > u8.length) return null;
  const sig = u8.subarray(c, c + 64); c += 64;
  if (c + 4 > u8.length) return null;
  const ctLen = readU32(u8, c); c += 4;
  if (ctLen === 0 || c + ctLen > u8.length) return null;
  const ct = u8.subarray(c, c + ctLen);
  return { deviceId, startSeq, count, ctHash, sig, ct, next: c + ctLen };
}

function indexV2ChunkStarts(u8: Uint8Array): number[] {
  const starts: number[] = [];
  if (!startsWith(u8, V2_MAGIC)) return starts;
  let at = V2_MAGIC.length;
  while (at < u8.length) {
    const parsed = parseV2ChunkHeader(u8, at);
    if (!parsed) break;
    starts.push(at);
    at = parsed.next;
  }
  return starts;
}

function indexV1Chunks(u8: Uint8Array): Array<{ ctAt: number; ctLen: number }> {
  const chunks: Array<{ ctAt: number; ctLen: number }> = [];
  let cursor = 0;
  while (cursor + 4 <= u8.length) {
    const len = readU32(u8, cursor);
    if (len === 0 || cursor + 4 + len > u8.length) break;
    chunks.push({ ctAt: cursor + 4, ctLen: len });
    cursor += 4 + len;
  }
  return chunks;
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

async function decryptV2ChunkEvents(
  u8: Uint8Array,
  at: number,
  key: Uint8Array,
  readOpts: oplog.ReadOpLogOptions,
  fileName: string,
): Promise<OpLogEvent[]> {
  const parsed = parseV2ChunkHeader(u8, at);
  if (!parsed) return [];
  const issue = (detail: string) => {
    readOpts.onIntegrityIssue?.({
      kind: 'malformed',
      deviceId: parsed.deviceId,
      file: fileName,
      detail,
    });
  };

  if (readOpts.getDevicePubKey) {
    const pub = readOpts.getDevicePubKey(parsed.deviceId);
    if (!pub) {
      issue('no pinned public key for device; chunk not trusted');
      return [];
    }
    const signed = concat([
      V2_MAGIC,
      u16(new TextEncoder().encode(parsed.deviceId).length),
      new TextEncoder().encode(parsed.deviceId),
      u32(parsed.startSeq >>> 0),
      u32(Math.floor(parsed.startSeq / 0x1_0000_0000)),
      u32(parsed.count >>> 0),
      parsed.ctHash,
    ]);
    const ok = await verify(parsed.sig, signed, pub);
    if (!ok) {
      issue(`Ed25519 signature failed for seq ${parsed.startSeq}`);
      return [];
    }
  }

  let pt: Uint8Array;
  try {
    pt = await decrypt(parsed.ct, key);
  } catch (e) {
    issue(`decrypt failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  const events: OpLogEvent[] = [];
  for (const ln of new TextDecoder().decode(pt).split('\n')) {
    if (!ln) continue;
    try { events.push(JSON.parse(ln) as OpLogEvent); }
    catch { issue('decrypted line not JSON'); }
  }
  return events;
}

async function decryptV1ChunkEvents(ct: Uint8Array, key: Uint8Array): Promise<OpLogEvent[]> {
  try {
    const pt = await decrypt(ct, key);
    const events: OpLogEvent[] = [];
    for (const ln of new TextDecoder().decode(pt).split('\n')) {
      if (!ln) continue;
      try { events.push(JSON.parse(ln) as OpLogEvent); }
      catch { /* skip malformed line */ }
    }
    return events;
  } catch {
    return [];
  }
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
    const buf = await fs.readFile(path.join(q.oplogDir, name));
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const isV2 = startsWith(u8, V2_MAGIC);
    const v2Starts = isV2 ? indexV2ChunkStarts(u8) : [];
    const v1Chunks = isV2 ? [] : indexV1Chunks(u8);
    const chunkCount = isV2 ? v2Starts.length : v1Chunks.length;

    for (let i = chunkCount - 1; i >= 0; i--) {
      const chunkEvents = isV2
        ? await decryptV2ChunkEvents(u8, v2Starts[i]!, q.key, q.readOpts, name)
        : await decryptV1ChunkEvents(
          u8.subarray(v1Chunks[i]!.ctAt, v1Chunks[i]!.ctAt + v1Chunks[i]!.ctLen),
          q.key,
        );

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
    const buf = await fs.readFile(path.join(q.oplogDir, name));
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const isV2 = startsWith(u8, V2_MAGIC);
    const v2Starts = isV2 ? indexV2ChunkStarts(u8) : [];
    const v1Chunks = isV2 ? [] : indexV1Chunks(u8);
    const chunkCount = isV2 ? v2Starts.length : v1Chunks.length;

    for (let i = chunkCount - 1; i >= 0; i--) {
      const chunkEvents = isV2
        ? await decryptV2ChunkEvents(u8, v2Starts[i]!, q.key, q.readOpts, name)
        : await decryptV1ChunkEvents(
          u8.subarray(v1Chunks[i]!.ctAt, v1Chunks[i]!.ctAt + v1Chunks[i]!.ctLen),
          q.key,
        );

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
