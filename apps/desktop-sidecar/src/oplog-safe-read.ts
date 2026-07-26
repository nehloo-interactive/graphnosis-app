/**
 * Memory-bounded op-log file reader.
 *
 * Both the pinned SDK (`@nehloo-interactive/graphnosis-secure-sync`'s
 * `oplog.readAllEvents` / `oplog.readEventsSince`) and this app's earlier
 * activity-query helper (`oplog-activity-query.ts`) parsed a `.oplog` file by
 * calling `fs.readFile()` on the WHOLE file, then scanning the returned
 * Buffer for chunk boundaries in memory. That's fine for the common case
 * (per-device files are usually well under 100MB), but a single stale or
 * long-lived device file can grow into the multi-GB range on a "large
 * cortex" — and slurping several GB into one contiguous allocation is
 * exactly the kind of request `fs.readFile()` (backed by libuv) rejects with
 * ENOMEM once the OS won't hand back a big-enough contiguous buffer.
 *
 * This module fixes that at the root: it INDEXES chunk headers via small
 * positional reads (a few hundred bytes at a time, seeking forward using
 * each header's declared ciphertext length) without ever reading a chunk's
 * ciphertext body during indexing. Only when a chunk's events are actually
 * needed do we read+decrypt that one chunk's ciphertext — bounding memory to
 * roughly the size of the single largest chunk (one writer flush batch),
 * not the size of the file.
 *
 * Wire-format parity: this intentionally mirrors the SDK's `oplog/index.ts`
 * v2/v1 chunk layout exactly (see that file's comments for the format
 * description). We can't change the SDK's own reader (it's a pinned external
 * dependency — see CLAUDE.md), so this is a drop-in, memory-safe substitute
 * used from our own call sites instead.
 */
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  crypto,
  oplog,
  type DeviceId,
  type OpLogEvent,
} from '@nehloo-interactive/graphnosis-secure-sync';

const { decrypt, verify } = crypto;
const V2_MAGIC = oplog.OPLOG_V2_MAGIC;

/** Not re-exported at the package's top level (only nested under the `oplog`
 *  namespace's option types), so derive it structurally. */
type OpLogIntegrityIssue = Parameters<NonNullable<oplog.ReadOpLogOptions['onIntegrityIssue']>>[0];
const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Covers idLen(2) + deviceId + seq(8) + count(4) + hash(32) + sig(64) + ctLen(4)
 *  for any realistic deviceId (hostnames / uuids / hashes are well under 400
 *  bytes). Widened on the rare occasion a header doesn't fit. */
const HEADER_PROBE_BYTES = 512;

interface V2IndexEntry {
  kind: 'v2';
  deviceId: string;
  startSeq: number;
  count: number;
  ctHash: Uint8Array;
  sig: Uint8Array;
  ctAt: number;
  ctLen: number;
  next: number;
}

interface V1IndexEntry {
  kind: 'v1';
  ctAt: number;
  ctLen: number;
  next: number;
}

export type IndexEntry = V2IndexEntry | V1IndexEntry;

export interface OplogFileIndex {
  format: 'v2' | 'v1' | 'empty';
  entries: IndexEntry[];
}

function readU16(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8);
}
function readU32(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
}
function startsWithBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}
function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Bounded positional read — never reads more than `length` bytes into memory. */
async function readAt(fh: FileHandle, position: number, length: number): Promise<Uint8Array> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

function parseV2Fixed(b: Uint8Array, at: number): { entry: Omit<V2IndexEntry, 'kind'>; headerLen: number } | null {
  let c = 0;
  if (c + 2 > b.length) return null;
  const idLen = readU16(b, c); c += 2;
  if (c + idLen > b.length) return null;
  const deviceId = new TextDecoder().decode(b.subarray(c, c + idLen)); c += idLen;
  if (c + 12 > b.length) return null;
  const seqLo = readU32(b, c); c += 4;
  const seqHi = readU32(b, c); c += 4;
  const startSeq = seqHi * 0x1_0000_0000 + seqLo;
  const count = readU32(b, c); c += 4;
  if (c + 32 > b.length) return null;
  const ctHash = b.slice(c, c + 32); c += 32;
  if (c + 64 > b.length) return null;
  const sig = b.slice(c, c + 64); c += 64;
  if (c + 4 > b.length) return null;
  const ctLen = readU32(b, c); c += 4;
  const headerLen = c;
  return {
    entry: { deviceId, startSeq, count, ctHash, sig, ctAt: at + headerLen, ctLen, next: at + headerLen + ctLen },
    headerLen,
  };
}

/** Parse one v2 chunk header at `at` using only small positional reads — the
 *  ciphertext body (the bulk of the file) is never read here. */
async function parseV2HeaderAt(fh: FileHandle, at: number, fileSize: number): Promise<V2IndexEntry | null> {
  const probeLen = Math.min(HEADER_PROBE_BYTES, fileSize - at);
  if (probeLen < 2) return null;
  let probe = await readAt(fh, at, probeLen);
  let parsed = parseV2Fixed(probe, at);

  // Only possible if a deviceId is unusually long; widen once with a bigger
  // (still bounded, not whole-file) probe rather than guessing up front.
  if (!parsed && probe.length === probeLen && at + probeLen < fileSize) {
    const wideLen = Math.min(probeLen + 65_536, fileSize - at);
    if (wideLen > probeLen) {
      probe = await readAt(fh, at, wideLen);
      parsed = parseV2Fixed(probe, at);
    }
  }
  if (!parsed) return null;
  if (parsed.entry.ctLen === 0 || parsed.entry.next > fileSize) return null;
  return { kind: 'v2', ...parsed.entry };
}

async function parseV1HeaderAt(fh: FileHandle, at: number, fileSize: number): Promise<V1IndexEntry | null> {
  if (at + 4 > fileSize) return null;
  const lenBytes = await readAt(fh, at, 4);
  if (lenBytes.length < 4) return null;
  const len = readU32(lenBytes, 0);
  if (len === 0 || at + 4 + len > fileSize) return null;
  return { kind: 'v1', ctAt: at + 4, ctLen: len, next: at + 4 + len };
}

/**
 * Build a header-only index of every chunk in an op-log file. Memory cost is
 * O(number of chunks), never O(file size) — the ciphertext bodies are
 * skipped over via `next`, not read.
 */
export async function indexOplogFile(filePath: string): Promise<OplogFileIndex> {
  const fh = await fsp.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const fileSize = stat.size;
    if (fileSize === 0) return { format: 'empty', entries: [] };

    const magicProbe = await readAt(fh, 0, Math.min(V2_MAGIC.length, fileSize));
    const isV2 = startsWithBytes(magicProbe, V2_MAGIC);
    const entries: IndexEntry[] = [];
    let at = isV2 ? V2_MAGIC.length : 0;

    while (at < fileSize) {
      const entry = isV2 ? await parseV2HeaderAt(fh, at, fileSize) : await parseV1HeaderAt(fh, at, fileSize);
      if (!entry) break;
      entries.push(entry);
      at = entry.next;
    }
    return { format: isV2 ? 'v2' : 'v1', entries };
  } finally {
    await fh.close();
  }
}

export interface DecryptEntryOptions {
  getDevicePubKey?: (deviceId: DeviceId) => Uint8Array | undefined;
  onIntegrityIssue?: (issue: OpLogIntegrityIssue) => void;
}

/** Read + decrypt exactly one chunk's ciphertext (bounded to `entry.ctLen`
 *  bytes) and return its events. Never touches the rest of the file. */
export async function decryptIndexEntry(
  fh: FileHandle,
  entry: IndexEntry,
  key: Uint8Array,
  fileName: string,
  opts: DecryptEntryOptions,
): Promise<OpLogEvent[]> {
  const issue = (i: OpLogIntegrityIssue) => opts.onIntegrityIssue?.(i);
  const ct = await readAt(fh, entry.ctAt, entry.ctLen);

  if (entry.kind === 'v2') {
    if (opts.getDevicePubKey) {
      const pub = opts.getDevicePubKey(entry.deviceId as DeviceId);
      if (!pub) {
        issue({ kind: 'unknown-device', deviceId: entry.deviceId as DeviceId, file: fileName,
          detail: 'no pinned public key for device; chunk not trusted' });
        return [];
      }
      const idBytes = new TextEncoder().encode(entry.deviceId);
      const signed = concatBytes([
        V2_MAGIC,
        u16(idBytes.length), idBytes,
        u32(entry.startSeq >>> 0), u32(Math.floor(entry.startSeq / 0x1_0000_0000)),
        u32(entry.count >>> 0),
        entry.ctHash,
      ]);
      const ok = await verify(entry.sig, signed, pub);
      if (!ok) {
        issue({ kind: 'signature-invalid', deviceId: entry.deviceId as DeviceId, file: fileName,
          detail: `Ed25519 signature failed for seq ${entry.startSeq}..${entry.startSeq + entry.count - 1}` });
        return [];
      }
    }
    const actualHash = new Uint8Array(createHash('sha256').update(ct).digest());
    if (!bytesEqual(actualHash, entry.ctHash)) {
      issue({ kind: 'signature-invalid', deviceId: entry.deviceId as DeviceId, file: fileName,
        detail: `content hash mismatch for seq ${entry.startSeq}..${entry.startSeq + entry.count - 1}` });
      return [];
    }
  }

  let pt: Uint8Array;
  try {
    pt = await decrypt(ct, key);
  } catch (e) {
    issue({
      kind: 'malformed',
      ...(entry.kind === 'v2' ? { deviceId: entry.deviceId as DeviceId } : {}),
      file: fileName,
      detail: `decrypt failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return [];
  }

  const events: OpLogEvent[] = [];
  for (const ln of new TextDecoder().decode(pt).split('\n')) {
    if (!ln) continue;
    try { events.push(JSON.parse(ln) as OpLogEvent); }
    catch {
      issue({
        kind: 'malformed',
        ...(entry.kind === 'v2' ? { deviceId: entry.deviceId as DeviceId } : {}),
        file: fileName,
        detail: 'decrypted line not JSON',
      });
    }
  }
  return events;
}

/** Detect dropped / replayed / reordered events via per-device seq continuity
 *  (same semantics as the SDK's internal check). */
function checkSequenceContinuity(
  events: OpLogEvent[],
  file: string,
  onIntegrityIssue?: (i: OpLogIntegrityIssue) => void,
): void {
  if (!onIntegrityIssue) return;
  const byDevice = new Map<DeviceId, number[]>();
  for (const ev of events) {
    if (typeof ev.seq !== 'number') continue;
    let arr = byDevice.get(ev.deviceId);
    if (!arr) { arr = []; byDevice.set(ev.deviceId, arr); }
    arr.push(ev.seq);
  }
  for (const [deviceId, seqs] of byDevice) {
    seqs.sort((a, b) => a - b);
    // Summarise per device rather than emitting one line per gap. A real cortex
    // produced THOUSANDS of these in a single run, which buried the actual
    // output — and a wall of identical warnings reads as noise, so the one that
    // matters gets skimmed past too. The counts carry the same information.
    let gaps = 0;
    let missing = 0;
    let rewinds = 0;
    let firstGap: string | undefined;
    for (let i = 1; i < seqs.length; i++) {
      const cur = seqs[i]!;
      const prev = seqs[i - 1]!;
      if (cur === prev) {
        rewinds++;
      } else if (cur > prev + 1) {
        gaps++;
        missing += cur - prev - 1;
        firstGap ??= `${prev}→${cur}`;
      }
    }
    if (rewinds > 0) {
      onIntegrityIssue({ kind: 'seq-rewind', deviceId, file,
        detail: `${rewinds} duplicate seq(s) — possible replay` });
    }
    if (gaps > 0) {
      onIntegrityIssue({ kind: 'seq-gap', deviceId, file,
        detail: `${gaps} gap(s) covering ${missing} missing seq(s), first at ${firstGap}` +
                ' — possible dropped events' });
    }
  }
}

async function collectFileEvents(
  filePath: string,
  fileName: string,
  key: Uint8Array,
  opts: oplog.ReadOpLogOptions,
  filter?: (ev: OpLogEvent) => boolean,
): Promise<OpLogEvent[]> {
  const index = await indexOplogFile(filePath);
  if (index.format === 'empty' || index.entries.length === 0) return [];

  const now = opts.now ?? Date.now();
  const maxSkew = opts.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;
  const fh = await fsp.open(filePath, 'r');
  const fileEvents: OpLogEvent[] = [];
  try {
    for (const entry of index.entries) {
      const chunkEvents = await decryptIndexEntry(fh, entry, key, fileName, opts);
      for (const ev of chunkEvents) fileEvents.push(ev);
    }
  } finally {
    await fh.close();
  }

  checkSequenceContinuity(fileEvents, fileName, opts.onIntegrityIssue);

  const out: OpLogEvent[] = [];
  for (const ev of fileEvents) {
    if (typeof ev.ts === 'number' && ev.ts > now + maxSkew) {
      opts.onIntegrityIssue?.({ kind: 'future-timestamp', deviceId: ev.deviceId, file: fileName,
        detail: `event ts ${ev.ts} exceeds now+${maxSkew}ms; dropped` });
      continue;
    }
    if (!filter || filter(ev)) out.push(ev);
  }
  return out;
}

function sortEvents(events: OpLogEvent[]): OpLogEvent[] {
  events.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  return events;
}

async function collectOplogDirSafe(
  dir: string,
  key: Uint8Array,
  opts: oplog.ReadOpLogOptions,
  filter?: (ev: OpLogEvent) => boolean,
): Promise<OpLogEvent[]> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const out: OpLogEvent[] = [];
  for (const name of names) {
    if (!name.endsWith('.oplog')) continue;
    const fileEvents = await collectFileEvents(path.join(dir, name), name, key, opts, filter);
    for (const ev of fileEvents) out.push(ev);
  }
  return sortEvents(out);
}

/**
 * Streaming, filter-first collector — for callers that want a FEW events out of
 * a very large log.
 *
 * `safeReadAllEvents` bounds the ciphertext held in memory, but it still
 * materialises every decrypted event as a JS object and returns them all. On a
 * multi-GB op-log that is millions of objects: a 4.6 GB log OOM'd a 4 GB heap
 * inside JSON.parse. Even `collectFileEvents`' existing `filter` does not help,
 * because it accumulates the file's full event list first to run the
 * sequence-continuity check.
 *
 * This keeps ONLY events matching `filter`, and does the continuity check
 * streaming (per-device last-seq) instead of over a retained array — so peak
 * memory is one chunk plus the matches, not the whole log.
 *
 * Use it whenever the result set is small and known up front: recovery for a
 * specific set of sourceIds, an audit for one engram, etc. For "give me
 * everything", `safeReadAllEvents` is still the right call.
 */
/** One file's chunk-size profile, from headers only — nothing is decrypted. */
export interface OplogChunkProfile {
  file: string;
  fileBytes: number;
  format: 'v2' | 'v1' | 'empty';
  chunks: number;
  /** Declared event count summed across chunks (v2 headers only; 0 for v1). */
  declaredEvents: number;
  /** Ciphertext bytes summed across chunks. */
  ctBytes: number;
  largestCtLen: number;
  /** Ascending ciphertext lengths, for percentile reporting. */
  ctLens: number[];
}

/**
 * Profile the op-log WITHOUT decrypting a single chunk.
 *
 * Chunk headers carry `ctLen` and (on v2) the event `count`, so the shape of a
 * log — how many chunks, how big, how densely packed — is readable from
 * positional header reads alone. That matters when the log cannot be decrypted
 * at all: a chunk large enough to OOM the heap still reports its size here.
 *
 * Cheap and safe to run first, before committing to a full read.
 */
export async function profileOplogChunks(dir: string): Promise<OplogChunkProfile[]> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: OplogChunkProfile[] = [];
  for (const name of names) {
    if (!name.endsWith('.oplog')) continue;
    const filePath = path.join(dir, name);
    const index = await indexOplogFile(filePath);
    let fileBytes = 0;
    try {
      fileBytes = (await fsp.stat(filePath)).size;
    } catch { /* diagnostic only */ }
    const ctLens = index.entries.map((e) => e.ctLen).sort((a, b) => a - b);
    out.push({
      file: name,
      fileBytes,
      format: index.format,
      chunks: index.entries.length,
      declaredEvents: index.entries.reduce(
        (n, e) => n + (e.kind === 'v2' ? e.count : 0), 0,
      ),
      ctBytes: ctLens.reduce((n, v) => n + v, 0),
      largestCtLen: ctLens.length > 0 ? ctLens[ctLens.length - 1]! : 0,
      ctLens,
    });
  }
  return out;
}

export async function safeScanEvents(
  dir: string,
  key: Uint8Array,
  visit: (ev: OpLogEvent, file: string) => void,
  opts: oplog.ReadOpLogOptions & { maxChunkBytes?: number } = {},
): Promise<OplogScanStats> {
  const maxChunkBytes = opts.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  let skippedChunks = 0;
  let skippedBytes = 0;
  const stats: OplogScanStats = {
    files: 0, chunks: 0, events: 0, fileBytes: 0, skippedChunks: 0, skippedBytes: 0,
  };
  let names: string[] = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return stats;
  }

  const now = opts.now ?? Date.now();
  const maxSkew = opts.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS;

  for (const name of names) {
    if (!name.endsWith('.oplog')) continue;
    const filePath = path.join(dir, name);
    const index = await indexOplogFile(filePath);
    if (index.format === 'empty' || index.entries.length === 0) continue;
    stats.files++;
    stats.chunks += index.entries.length;
    try {
      stats.fileBytes += (await fsp.stat(filePath)).size;
    } catch { /* size is diagnostic only */ }

    // Streaming continuity check: remember only the last seq per device rather
    // than retaining every event to compare afterwards.
    const lastSeq = new Map<DeviceId, number>();
    // Per-file, per-device tallies, flushed as ONE issue each when the file is
    // done. Reporting every gap individually drowned the caller's own output.
    const tallies = new Map<DeviceId, { gaps: number; missing: number; rewinds: number; firstGap?: string }>();
    const seqTally = (deviceId: DeviceId) => {
      let t = tallies.get(deviceId);
      if (!t) { t = { gaps: 0, missing: 0, rewinds: 0 }; tallies.set(deviceId, t); }
      return t;
    };
    const fh = await fsp.open(filePath, 'r');
    try {
      for (const entry of index.entries) {
        // AES-GCM cannot be streamed — verifying the tag needs the whole
        // ciphertext in memory — so a single oversized chunk is unreadable at
        // ANY heap size. Observed in the field: a 4.6 GB op-log whose bulk sat
        // in a handful of giant chunks OOM'd an 8 GB heap inside
        // ArrayBufferConstructor. Skipping such a chunk loses its events, which
        // is bad; taking down the whole read loses ALL of them, which is worse.
        if (entry.ctLen > maxChunkBytes) {
          skippedChunks++;
          skippedBytes += entry.ctLen;
          opts.onIntegrityIssue?.({ kind: 'malformed', file: name,
            detail: `chunk at ${entry.ctAt} is ${entry.ctLen} bytes, above the ` +
                    `${maxChunkBytes}-byte read ceiling — skipped` });
          continue;
        }
        const chunkEvents = await decryptIndexEntry(fh, entry, key, name, opts);
        for (const ev of chunkEvents) {
          if (typeof ev.seq === 'number') {
            const prev = lastSeq.get(ev.deviceId);
            if (prev !== undefined) {
              // Tally, don't report. Emitting per gap produced thousands of
              // identical lines on a real cortex — see the summary flush below.
              if (ev.seq === prev) {
                const t = seqTally(ev.deviceId);
                t.rewinds++;
              } else if (ev.seq > prev + 1) {
                const t = seqTally(ev.deviceId);
                t.gaps++;
                t.missing += ev.seq - prev - 1;
                t.firstGap ??= `${prev}→${ev.seq}`;
              }
            }
            if (prev === undefined || ev.seq > prev) lastSeq.set(ev.deviceId, ev.seq);
          }
          if (typeof ev.ts === 'number' && ev.ts > now + maxSkew) {
            opts.onIntegrityIssue?.({ kind: 'future-timestamp', deviceId: ev.deviceId, file: name,
              detail: `event ts ${ev.ts} exceeds now+${maxSkew}ms; dropped` });
            continue;
          }
          stats.events++;
          visit(ev, name);
        }
      }
    } finally {
      await fh.close();
    }
    for (const [deviceId, t] of tallies) {
      if (t.rewinds > 0) {
        opts.onIntegrityIssue?.({ kind: 'seq-rewind', deviceId, file: name,
          detail: `${t.rewinds} duplicate seq(s) — possible replay` });
      }
      if (t.gaps > 0) {
        opts.onIntegrityIssue?.({ kind: 'seq-gap', deviceId, file: name,
          detail: `${t.gaps} gap(s) covering ${t.missing} missing seq(s), ` +
                  `first at ${t.firstGap} — possible dropped events` });
      }
    }
  }
  stats.skippedChunks = skippedChunks;
  stats.skippedBytes = skippedBytes;
  return stats;
}

/**
 * Per-chunk read ceiling. A chunk is one writer flush batch; normal ones are
 * kilobytes (a real cortex measured p50 ≈ 6 KB).
 *
 * The ceiling is a LAST RESORT against a chunk so large that AES-GCM cannot
 * verify its tag without the whole ciphertext resident. Skipping one is
 * lossy — a skipped chunk means recovery tools silently cannot see the events
 * inside it — so the ceiling must sit well above anything a real writer
 * produces, not merely above the common case.
 *
 * 256 MB was too tight: a field cortex had a legitimate 347 MB chunk, which
 * this then skipped during a skill recovery that was searching for exactly
 * that kind of history. 1 GB still decrypts inside the 8 GB heap these tools
 * request, and is far past any plausible flush batch.
 *
 * Override with GRAPHNOSIS_OPLOG_MAX_CHUNK_BYTES when a log needs it.
 */
const DEFAULT_MAX_CHUNK_BYTES = (() => {
  const raw = process.env.GRAPHNOSIS_OPLOG_MAX_CHUNK_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1024 * 1024 * 1024;
})();

/** File-level totals from a streaming scan. Counters only — never events. */
export interface OplogScanStats {
  files: number;
  chunks: number;
  /** Events visited (after the future-timestamp drop). */
  events: number;
  /** Total on-disk bytes of the .oplog files scanned. */
  fileBytes: number;
  /** Chunks skipped for exceeding the per-chunk read ceiling. */
  skippedChunks: number;
  /** Ciphertext bytes in those skipped chunks — i.e. data NOT scanned. */
  skippedBytes: number;
}

/**
 * Streaming, filter-first collector — for callers that want a FEW events out of
 * a very large log.
 *
 * `safeReadAllEvents` bounds the ciphertext held in memory, but it still
 * materialises every decrypted event as a JS object and returns them all. On a
 * multi-GB op-log that is millions of objects: a 4.6 GB log OOM'd a 4 GB heap
 * inside JSON.parse.
 *
 * Use it whenever the result set is small and known up front: recovery for a
 * specific set of sourceIds, an audit for one engram, etc. For "give me
 * everything", `safeReadAllEvents` is still the right call — and for pure
 * analysis that keeps nothing at all, use `safeScanEvents` directly.
 */
export async function safeCollectEvents(
  dir: string,
  key: Uint8Array,
  filter: (ev: OpLogEvent) => boolean,
  opts: oplog.ReadOpLogOptions = {},
): Promise<OpLogEvent[]> {
  const out: OpLogEvent[] = [];
  await safeScanEvents(dir, key, (ev) => { if (filter(ev)) out.push(ev); }, opts);
  return sortEvents(out);
}

/**
 * Drop-in, memory-bounded replacement for `oplog.readAllEvents()`. Same
 * result shape and integrity-reporting semantics; internally bounded to
 * roughly one chunk's ciphertext in memory at a time rather than the whole
 * file (or whole directory).
 */
export async function safeReadAllEvents(
  dir: string,
  key: Uint8Array,
  opts: oplog.ReadOpLogOptions = {},
): Promise<OpLogEvent[]> {
  return collectOplogDirSafe(dir, key, opts);
}

export interface SafeReadEventsSinceOptions extends oplog.ReadOpLogOptions {
  sinceTs: number;
  sinceSeq?: number;
}

function isAfterCheckpoint(ev: OpLogEvent, sinceTs: number, sinceSeq?: number): boolean {
  if (ev.ts > sinceTs) return true;
  if (ev.ts < sinceTs) return false;
  if (sinceSeq === undefined) return false;
  return typeof ev.seq === 'number' && ev.seq > sinceSeq;
}

/** Drop-in, memory-bounded replacement for `oplog.readEventsSince()`. Note
 *  the filter is applied per-event after decrypt (same as the SDK) — the
 *  chunk header doesn't carry a timestamp range, so this doesn't skip
 *  decrypting older chunks. The memory-safety win over the SDK's version is
 *  unchanged: bounded to one chunk at a time, not the whole file. */
export async function safeReadEventsSince(
  dir: string,
  key: Uint8Array,
  since: SafeReadEventsSinceOptions,
): Promise<OpLogEvent[]> {
  const { sinceTs, sinceSeq, ...opts } = since;
  return collectOplogDirSafe(dir, key, opts, (ev) => isAfterCheckpoint(ev, sinceTs, sinceSeq));
}
