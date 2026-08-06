/**
 * Op-log growth detection and REVERSIBLE archival.
 *
 * Why this exists
 * ───────────────
 * The op-log is an append-only journal. Nothing trims it: the compactor at
 * host.ts `compactOplogIfNeeded` is `COMPACTOR_ENABLED = false` and documents
 * why it must stay off. So on a long-lived cortex the journal outgrows the
 * memories it journals — a measured cortex reached 7.0 GB of `oplog/` against
 * 351 MB of `graphs/`, and materialising that log cost ~2.9x in RAM (24.37 GB
 * resident with zero operations queued). Archiving `oplog/` took that install
 * to 1.28 GB and swap to zero.
 *
 * That fix was performed by hand, on a terminal, by the person who wrote the
 * software. This module is that fix made self-service.
 *
 * Three tiers, deliberately ordered
 * ─────────────────────────────────
 *   1. DETECT   — stat-only. Cheap enough to run on every idle tick and at
 *                 unlock. See `measureOplogHealth`.
 *   2. AUTO-HEAL — only the subset that is provably behavior-neutral. See
 *                 `archivable` below. Runs without asking.
 *   3. ASK      — everything else, in one plain sentence with one button. See
 *                 `describeOplogHealth`. Never automatic.
 *
 * What "provably behavior-neutral" means here
 * ────────────────────────────────────────────
 * A v2 `.oplog` chunk is only decrypted after its signing device resolves to a
 * PINNED public key. Both readers in this codebase bail before decryption when
 * it does not:
 *
 *   oplog-safe-read.ts:220-225   `const pub = opts.getDevicePubKey(...)`
 *                                `if (!pub) { issue({kind:'unknown-device'}); return []; }`
 *   SDK oplog/index.ts:293-297   same check, `continue`
 *
 * and host.ts always supplies `getDevicePubKey` (its `safeReadEventsSince` call
 * site, `getDevicePubKey: (deviceId) => this.deviceIdentity.getPubKey(deviceId)`).
 * So a v2 file whose device
 * id is in no pinned set yields ZERO events on every read today and every read
 * tomorrow, while still costing a full I/O walk. Moving it aside changes what
 * the app does exactly not at all — it only stops paying for it.
 *
 * Legacy v1 files are NOT in that set. `readV1File` (SDK oplog/index.ts:398) is
 * unsigned and best-effort, so v1 chunks ARE returned regardless of device. They
 * are archivable only by explicit user action.
 *
 * NEVER DELETE
 * ────────────
 * Every path here renames into `oplog.archive-<timestamp>/` beside `oplog/` and
 * writes a `manifest.json` next to the files. `listOplogArchives` enumerates
 * them and `restoreOplogArchive` puts them back. Nothing in this module calls
 * `unlink`, `rm`, or `rmdir`.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { oplog } from '@nehloo-interactive/graphnosis-secure-sync';

const V2_MAGIC = oplog.OPLOG_V2_MAGIC;

// ── Thresholds ────────────────────────────────────────────────────────────
//
// Two independent tests, OR'd. Each catches what the other misses.

/**
 * FLOOR TEST — an absolute ceiling. Fires no matter how big the cortex is.
 * A journal past this size is a problem on its own terms: it is the
 * materialisation cost (~2.9x in RAM) that hurts, and that cost does not care
 * how many memories justify it.
 *
 * 2 GiB. The measured pathology (7.0 GB) clears it. A healthy live cortex
 * measured while writing this (368 MB) does not.
 */
export const OPLOG_CEILING_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * RATIO TEST — journal vs. the memories it journals. Catches a cortex whose
 * log is disproportionate before it reaches the absolute ceiling. The measured
 * pathology was 19.9x; a healthy install measured 1.54x.
 */
export const OPLOG_RATIO_LIMIT = 3;

/**
 * Ratio floor. Without this the ratio test fires on every NEW cortex, where a
 * few MB of journal legitimately dwarfs an almost-empty `graphs/`. Nobody needs
 * to free up 4 MB.
 */
export const OPLOG_RATIO_MIN_BYTES = 512 * 1024 * 1024;

/** Don't re-prompt more often than this after the user says "not now". */
export const OPLOG_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A file must be untouched for this long before the automatic tier will move
 * it, even when it looks unreadable.
 *
 * `pinned` is TOFU-reconciled from `devices.json` on every load, so "no pinned
 * key" normally means no device anywhere has claimed this file. But those two
 * files sync independently: a peer's `.oplog` can land before the `devices.json`
 * entry that makes it readable, and archiving it in that window would hide a
 * live peer's history behind a Recovery entry the user has no reason to look
 * for. A file that has not been appended to in a month is not mid-sync.
 */
export const OPLOG_AUTO_ARCHIVE_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const STATE_FILE = 'oplog-health.json';
const ARCHIVE_PREFIX = 'oplog.archive-';
const MANIFEST_FILE = 'manifest.json';
/** idLen(2) + deviceId + seq(8) + count(4) + hash(32) + sig(64) + ctLen(4). */
const HEADER_PROBE_BYTES = 512;

// ── Types ─────────────────────────────────────────────────────────────────

export type OplogFileFormat = 'v2' | 'v1' | 'empty' | 'unreadable';

/**
 * `current` — this install's live file; the writer appends to it.
 * `peer`    — another device we have TOFU-pinned; its events are trusted and read.
 * `orphan`  — a device id in no pinned set. For v2 that means every chunk is
 *             already skipped unread (see the module header).
 */
export type OplogFileRole = 'current' | 'peer' | 'orphan';

export interface OplogFileInfo {
  name: string;
  bytes: number;
  format: OplogFileFormat;
  /** null when the header could not be parsed (v1 files carry no device id). */
  deviceId: string | null;
  role: OplogFileRole;
  /** Last write. Used to keep a still-syncing peer out of the automatic tier. */
  mtimeMs: number;
  /** Safe to move aside with ZERO change to what the app can read. */
  archivable: boolean;
}

export interface OplogArchiveInfo {
  name: string;
  at: number;
  bytes: number;
  fileCount: number;
  reason: string;
}

export interface OplogHealthReport {
  cortexDir: string;
  oplogBytes: number;
  oplogFileCount: number;
  graphsBytes: number;
  /** oplogBytes / graphsBytes, or null when there are no graphs yet. */
  ratio: number | null;
  /** True when either threshold test fires. */
  oversized: boolean;
  /** Machine-readable reasons, for logs and tests. */
  reasons: Array<'ceiling' | 'ratio'>;
  files: OplogFileInfo[];
  /** Bytes in files that are behavior-neutral to archive (auto-heal tier). */
  autoReclaimBytes: number;
  autoReclaimFiles: string[];
  /** Bytes the user's one button would free (everything in `oplog/`). */
  promptReclaimBytes: number;
  archives: OplogArchiveInfo[];
}

export interface OplogHealthState {
  v: 1;
  snoozedUntil?: number;
  lastPromptAt?: number;
  lastAutoArchiveAt?: number;
}

// ── Measurement ───────────────────────────────────────────────────────────

async function dirBytes(dir: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0;
  let count = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(dir, { encoding: 'utf8' });
  } catch {
    return { bytes: 0, count: 0 };
  }
  for (const name of entries) {
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile()) { bytes += st.size; count++; }
      else if (st.isDirectory()) {
        const sub = await dirBytes(path.join(dir, name));
        bytes += sub.bytes; count += sub.count;
      }
    } catch { /* raced or unreadable — not worth failing a health check over */ }
  }
  return { bytes, count };
}

function startsWith(buf: Uint8Array, prefix: Uint8Array): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix[i]) return false;
  return true;
}

/**
 * Identify one `.oplog` file with two small positional reads — the magic, then
 * one chunk header. The ciphertext (the entire bulk of the file) is never read
 * and never decrypted, so this costs the same on a 4 KB file and a 7 GB one.
 *
 * This is deliberately NOT `indexOplogFile` from oplog-safe-read.ts. That walks
 * every chunk header to the end of the file — millions of positioned reads on
 * the file sizes this module exists to detect.
 */
export async function probeOplogFile(filePath: string): Promise<{ format: OplogFileFormat; deviceId: string | null }> {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
  } catch {
    return { format: 'unreadable', deviceId: null };
  }
  try {
    const st = await fh.stat();
    if (st.size === 0) return { format: 'empty', deviceId: null };

    const magic = Buffer.alloc(V2_MAGIC.length);
    const { bytesRead } = await fh.read(magic, 0, V2_MAGIC.length, 0);
    if (!startsWith(magic.subarray(0, bytesRead), V2_MAGIC)) {
      // No v2 magic → legacy v1 (length-prefixed, unsigned, no device id on the
      // wire). Read best-effort by readV1File, so its events DO reach the app.
      return { format: 'v1', deviceId: null };
    }

    const probeLen = Math.min(HEADER_PROBE_BYTES, st.size - V2_MAGIC.length);
    if (probeLen < 2) return { format: 'v2', deviceId: null };
    const probe = Buffer.alloc(probeLen);
    const got = await fh.read(probe, 0, probeLen, V2_MAGIC.length);
    const b = probe.subarray(0, got.bytesRead);
    if (b.length < 2) return { format: 'v2', deviceId: null };
    const idLen = b[0]! | (b[1]! << 8);
    if (idLen <= 0 || 2 + idLen > b.length) return { format: 'v2', deviceId: null };
    const deviceId = new TextDecoder().decode(b.subarray(2, 2 + idLen));
    return { format: 'v2', deviceId };
  } catch {
    return { format: 'unreadable', deviceId: null };
  } finally {
    await fh.close().catch(() => { /* closing a probe */ });
  }
}

export interface MeasureOplogHealthOpts {
  cortexDir: string;
  /** This install's device id — its file is never auto-archived. */
  currentDeviceId: string;
  /** Device ids with a pinned public key. Their v2 chunks are read and trusted. */
  pinnedDeviceIds: Iterable<string>;
}

/**
 * Stat-only health measurement. Safe to call on every idle tick.
 *
 * MUST run before `host.refreshAllCorrectionsFromOplog()`, never after: that
 * call materialises the entire op-log (`GraphnosisHost.listOplogEvents()`), which
 * is the 24 GB resident this detector exists to prevent. On a cortex already
 * too large to materialise, a check placed after it never runs at all.
 */
export async function measureOplogHealth(opts: MeasureOplogHealthOpts): Promise<OplogHealthReport> {
  const { cortexDir, currentDeviceId } = opts;
  const pinned = new Set(opts.pinnedDeviceIds);
  const oplogDir = path.join(cortexDir, 'oplog');

  let names: string[] = [];
  try {
    names = (await fsp.readdir(oplogDir)).filter((n) => n.endsWith('.oplog'));
  } catch { /* no oplog dir yet — a fresh cortex is healthy by definition */ }

  const files: OplogFileInfo[] = [];
  let oplogBytes = 0;
  const now = Date.now();
  for (const name of names) {
    const full = path.join(oplogDir, name);
    let bytes = 0;
    let mtimeMs = now;
    try {
      const st = await fsp.stat(full);
      bytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch { continue; }
    const { format, deviceId } = await probeOplogFile(full);

    const role: OplogFileRole =
      deviceId && deviceId === currentDeviceId ? 'current'
      : deviceId && pinned.has(deviceId) ? 'peer'
      : 'orphan';

    // The auto-heal set, and only this. A v2 file from an unpinned device is
    // skipped unread by both readers, so archiving it is observationally a
    // no-op. v1 files are read unsigned and are NOT in this set. The current
    // device's live file is never in it whatever its role resolves to. The age
    // gate keeps a peer whose devices.json entry has not synced yet out of it.
    const archivable =
      format === 'v2'
      && role === 'orphan'
      && deviceId !== currentDeviceId
      && now - mtimeMs >= OPLOG_AUTO_ARCHIVE_MIN_AGE_MS;

    files.push({ name, bytes, format, deviceId, role, mtimeMs, archivable });
    oplogBytes += bytes;
  }

  const graphs = await dirBytes(path.join(cortexDir, 'graphs'));
  const graphsBytes = graphs.bytes;
  const ratio = graphsBytes > 0 ? oplogBytes / graphsBytes : null;

  const reasons: Array<'ceiling' | 'ratio'> = [];
  if (oplogBytes >= OPLOG_CEILING_BYTES) reasons.push('ceiling');
  if (ratio !== null && ratio >= OPLOG_RATIO_LIMIT && oplogBytes >= OPLOG_RATIO_MIN_BYTES) {
    reasons.push('ratio');
  }

  const auto = files.filter((f) => f.archivable);

  return {
    cortexDir,
    oplogBytes,
    oplogFileCount: files.length,
    graphsBytes,
    ratio,
    oversized: reasons.length > 0,
    reasons,
    files,
    autoReclaimBytes: auto.reduce((n, f) => n + f.bytes, 0),
    autoReclaimFiles: auto.map((f) => f.name),
    promptReclaimBytes: oplogBytes,
    archives: await listOplogArchives(cortexDir),
  };
}

// ── Plain language ────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export interface OplogHealthPrompt {
  title: string;
  body: string;
  actionLabel: string;
  /** Bytes the action frees. */
  bytes: number;
}

/**
 * The ASK tier. One sentence, one button, no jargon — the user should not have
 * to learn what an op-log is to keep their disk from filling up. "Op-log",
 * "journal", "compaction" and "device id" are all absent on purpose; the word
 * used is "activity log", which is what the existing Activity-row copy already
 * says ("Archived N older events from the encrypted audit log").
 */
export function describeOplogHealth(report: OplogHealthReport): OplogHealthPrompt | null {
  if (!report.oversized) return null;
  const size = formatBytes(report.promptReclaimBytes);
  const comparison = report.ratio !== null && report.ratio >= OPLOG_RATIO_LIMIT
    ? ` — ${Math.round(report.ratio)}× larger than the memories it protects`
    : '';
  return {
    title: 'Graphnosis is using more space than it needs',
    body:
      `Its activity log has grown to ${size}${comparison}. `
      + 'Freeing it up does not delete any memories, and it can be undone.',
    actionLabel: `Free up ${size}`,
    bytes: report.promptReclaimBytes,
  };
}

// ── Archival (reversible; nothing here deletes) ───────────────────────────

interface ArchiveManifest {
  v: 1;
  at: number;
  reason: string;
  files: Array<{ name: string; bytes: number; format: OplogFileFormat; deviceId: string | null; role: OplogFileRole }>;
}

function archiveStamp(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

export interface ArchiveResult {
  archiveName: string;
  archiveDir: string;
  movedFiles: string[];
  bytes: number;
}

/**
 * Move the named `.oplog` files into a fresh `oplog.archive-<timestamp>/` next
 * to `oplog/`, with a manifest. Rename only — the bytes are never rewritten and
 * never removed, so this is undoable by `restoreOplogArchive`.
 *
 * Archiving the CURRENT device's live file is permitted (that is what the
 * manual fix did) but must only ever be reached through explicit user consent.
 * The writer re-creates the file and re-emits the v2 magic on its next append
 * (SDK oplog/index.ts:98 `needMagic = !(await fileExists(this.filePath()))`),
 * and `nextSeq` lives in device.json, so sequence numbers do not rewind.
 */
export async function archiveOplogFiles(
  cortexDir: string,
  fileNames: string[],
  reason: string,
  info?: OplogFileInfo[],
): Promise<ArchiveResult> {
  const oplogDir = path.join(cortexDir, 'oplog');
  const at = Date.now();
  let archiveName = `${ARCHIVE_PREFIX}${archiveStamp(at)}`;
  let archiveDir = path.join(cortexDir, archiveName);
  // Collision is near-impossible (ms precision) but a silent overwrite of an
  // earlier archive would be a data loss, which this module does not do.
  for (let i = 2; ; i++) {
    try { await fsp.mkdir(archiveDir, { recursive: false, mode: 0o700 }); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      archiveName = `${ARCHIVE_PREFIX}${archiveStamp(at)}-${i}`;
      archiveDir = path.join(cortexDir, archiveName);
    }
  }

  const moved: string[] = [];
  const manifestFiles: ArchiveManifest['files'] = [];
  let bytes = 0;
  for (const name of fileNames) {
    if (name.includes('/') || name.includes('\\') || !name.endsWith('.oplog')) continue;
    const from = path.join(oplogDir, name);
    let size = 0;
    try { size = (await fsp.stat(from)).size; } catch { continue; }
    try {
      await fsp.rename(from, path.join(archiveDir, name));
    } catch {
      continue; // a file that vanished mid-run is not a reason to abort the rest
    }
    moved.push(name);
    bytes += size;
    const meta = info?.find((f) => f.name === name);
    manifestFiles.push({
      name, bytes: size,
      format: meta?.format ?? 'unreadable',
      deviceId: meta?.deviceId ?? null,
      role: meta?.role ?? 'orphan',
    });
  }

  const manifest: ArchiveManifest = { v: 1, at, reason, files: manifestFiles };
  await fsp.writeFile(path.join(archiveDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  return { archiveName, archiveDir, movedFiles: moved, bytes };
}

/** Every archive this module has ever made, newest first. */
export async function listOplogArchives(cortexDir: string): Promise<OplogArchiveInfo[]> {
  let entries: string[] = [];
  try { entries = await fsp.readdir(cortexDir); } catch { return []; }
  const out: OplogArchiveInfo[] = [];
  for (const name of entries) {
    if (!name.startsWith(ARCHIVE_PREFIX)) continue;
    const dir = path.join(cortexDir, name);
    try { if (!(await fsp.stat(dir)).isDirectory()) continue; } catch { continue; }
    let at = 0;
    let reason = '';
    try {
      const m = JSON.parse(await fsp.readFile(path.join(dir, MANIFEST_FILE), 'utf8')) as ArchiveManifest;
      at = m.at ?? 0;
      reason = m.reason ?? '';
    } catch { /* a hand-made archive dir has no manifest; still list it */ }
    const { bytes, count } = await dirBytes(dir);
    out.push({ name, at, bytes, fileCount: Math.max(0, count - 1), reason });
  }
  out.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
  return out;
}

export interface RestoreResult { restored: string[]; skipped: string[] }

/**
 * Put an archive's files back into `oplog/`. Refuses to clobber a file that
 * already exists there — a same-named file back in place means the writer has
 * moved on, and overwriting it would destroy newer events.
 */
export async function restoreOplogArchive(cortexDir: string, archiveName: string): Promise<RestoreResult> {
  if (!archiveName.startsWith(ARCHIVE_PREFIX) || archiveName.includes('/') || archiveName.includes('\\')) {
    throw new Error(`not an op-log archive: ${archiveName}`);
  }
  const archiveDir = path.join(cortexDir, archiveName);
  const oplogDir = path.join(cortexDir, 'oplog');
  await fsp.mkdir(oplogDir, { recursive: true, mode: 0o700 });

  const restored: string[] = [];
  const skipped: string[] = [];
  for (const name of await fsp.readdir(archiveDir)) {
    if (!name.endsWith('.oplog')) continue;
    const to = path.join(oplogDir, name);
    try { await fsp.stat(to); skipped.push(name); continue; } catch { /* free */ }
    await fsp.rename(path.join(archiveDir, name), to);
    restored.push(name);
  }
  return { restored, skipped };
}

// ── Prompt state (snooze) ─────────────────────────────────────────────────

export async function readOplogHealthState(cortexDir: string): Promise<OplogHealthState> {
  try {
    const s = JSON.parse(await fsp.readFile(path.join(cortexDir, STATE_FILE), 'utf8')) as OplogHealthState;
    if (s && s.v === 1) return s;
  } catch { /* absent — never checked before */ }
  return { v: 1 };
}

export async function writeOplogHealthState(cortexDir: string, next: OplogHealthState): Promise<void> {
  const p = path.join(cortexDir, STATE_FILE);
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
  await fsp.rename(tmp, p);
}

export function shouldPrompt(state: OplogHealthState, now = Date.now()): boolean {
  if (state.snoozedUntil && now < state.snoozedUntil) return false;
  return true;
}
