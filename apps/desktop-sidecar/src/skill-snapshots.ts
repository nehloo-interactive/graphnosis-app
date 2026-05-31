// ── Skill snapshots — per-source JSONL side-table for retrain history ───────
//
// Replaces the legacy "new source per retrain" model. Each retrain now
// rewrites the existing skill source in-place; before the mutations run,
// we snapshot the source's full pre-retrain state (node texts in order,
// the metadata fields, the label) to an encrypted file on disk. The user
// can list those snapshots and roll back to any of them.
//
// Encryption parity: snapshots use the same data key + salt that protect
// the `.gai` files. A user who can unlock the cortex can read the
// snapshots; nothing else can.
//
// Layout on disk:
//   <cortexDir>/skill-snapshots/<graphId>/<sourceId>/<snapshotId>.json.enc
//
//   snapshotId is the millisecond timestamp of the retrain (zero-padded
//   to 16 chars so a lexicographic sort matches a chronological sort).
//
// One file per snapshot keeps append cost O(1) regardless of history
// size, makes per-snapshot pruning a single `fs.unlink`, and avoids the
// "re-encrypt the whole history blob every retrain" cost of a JSONL.
// Listing snapshots is one `fs.readdir`; reading is one `fs.readFile`.
//
// Retention: indefinite. The Skills UI exposes a per-snapshot delete
// button; nothing auto-prunes. If a user ever asks for capped retention
// that's a setting we add later, not a default we bake in.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';

const { encrypt, decrypt } = crypto;

/** Per-node payload inside a snapshot. We store the role too because the
 *  re-ingest path on rollback uses it to set the op-log `role` field and
 *  to drive the SOP classifier (metadata vs title vs body vs goal). */
export interface SnapshotNode {
  /** Full node content (untruncated). */
  content: string;
  /** Role label the original insertNodeAt was tagged with. Optional —
   *  some legacy nodes were inserted without a role. The reclassifier
   *  in `classifyNodesByRole` infers role from content shape when this
   *  is missing. */
  role?: string;
}

export interface SkillSnapshot {
  /** Millisecond timestamp of the retrain that produced this snapshot,
   *  formatted as a 16-char zero-padded string. Doubles as the filename
   *  stem and as a stable sort key. */
  snapshotId: string;
  /** Wall-clock millis of the snapshot. Equal to Number(snapshotId). */
  ts: number;
  /** sourceId this snapshot belongs to. Redundant with the filesystem
   *  path but makes the file self-describing if the path layout ever
   *  changes. */
  sourceId: string;
  /** The skill's source ref at the time of the snapshot. */
  ref: string;
  /** The skill's display label at the time of the snapshot (i.e. the
   *  title node's text). Shown in the history UI. */
  label: string;
  /** Optional metadata extracted from the source's metadata-comment
   *  node, surfaced in the history UI without forcing a full read of
   *  the snapshot. */
  trainedAt?: string;
  mode?: 'llm' | 'memory-augmented';
  /** Full node sequence at the time of the snapshot, in source-order.
   *  Replaying this array via insertNodeAt restores the source to its
   *  pre-mutation state. */
  nodes: SnapshotNode[];
}

/** Slim summary returned by `list()` — avoids decrypting + parsing every
 *  snapshot file just to render the history panel. The detail view does
 *  the full read via `read()`. */
export interface SkillSnapshotSummary {
  snapshotId: string;
  ts: number;
  label: string;
  nodeCount: number;
  trainedAt?: string;
  mode?: string;
}

export interface SkillSnapshotStoreOptions {
  cortexDir: string;
  /** Data key from the host. Same key that encrypts `.gai` files. */
  key: Uint8Array;
  /** Salt from the host. Constant across one cortex's lifetime. */
  salt: Uint8Array;
}

export class SkillSnapshotStore {
  private readonly root: string;
  private readonly key: Uint8Array;
  private readonly salt: Uint8Array;

  constructor(opts: SkillSnapshotStoreOptions) {
    this.root = path.join(opts.cortexDir, 'skill-snapshots');
    this.key = opts.key;
    this.salt = opts.salt;
  }

  /** Write a new snapshot. Idempotent on `snapshotId` collisions — the
   *  file is overwritten. In practice retrain timestamps don't collide
   *  (millisecond-grained), but the overwrite is safer than throwing. */
  async append(graphId: string, snapshot: SkillSnapshot): Promise<void> {
    const dir = this.snapshotDir(graphId, snapshot.sourceId);
    await fs.mkdir(dir, { recursive: true });
    const json = new TextEncoder().encode(JSON.stringify(snapshot));
    const ct = await encrypt(json, this.key, this.salt);
    const file = path.join(dir, `${snapshot.snapshotId}.json.enc`);
    // Atomic write: tmp file + rename. Same pattern host.save() uses for
    // .gai writes so a force-quit mid-write can't corrupt the snapshot.
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, Buffer.from(ct));
    await fs.rename(tmp, file);
  }

  /** List all snapshots for one source, newest first. Decrypts each
   *  snapshot's header fields (everything but `nodes[]`) so the
   *  history UI can render without paying for the full read. */
  async list(graphId: string, sourceId: string): Promise<SkillSnapshotSummary[]> {
    const dir = this.snapshotDir(graphId, sourceId);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const snapshots: SkillSnapshotSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json.enc')) continue;
      const snapshotId = entry.slice(0, -'.json.enc'.length);
      const full = await this.read(graphId, sourceId, snapshotId);
      if (!full) continue;
      snapshots.push({
        snapshotId: full.snapshotId,
        ts: full.ts,
        label: full.label,
        nodeCount: full.nodes.length,
        ...(full.trainedAt !== undefined ? { trainedAt: full.trainedAt } : {}),
        ...(full.mode !== undefined ? { mode: full.mode } : {}),
      });
    }
    // Newest first — UI surface is "most recent retrain at top".
    snapshots.sort((a, b) => b.ts - a.ts);
    return snapshots;
  }

  /** Read one full snapshot (including `nodes[]`) for rollback or
   *  inspection. Returns null when the file is missing — never throws
   *  for the common "not found" case so the caller can surface a
   *  user-friendly error. */
  async read(graphId: string, sourceId: string, snapshotId: string): Promise<SkillSnapshot | null> {
    const file = path.join(this.snapshotDir(graphId, sourceId), `${snapshotId}.json.enc`);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const pt = await decrypt(new Uint8Array(bytes), this.key);
    return JSON.parse(new TextDecoder().decode(pt)) as SkillSnapshot;
  }

  /** Delete one snapshot. No-op if it's already gone. */
  async delete(graphId: string, sourceId: string, snapshotId: string): Promise<void> {
    const file = path.join(this.snapshotDir(graphId, sourceId), `${snapshotId}.json.enc`);
    try {
      await fs.unlink(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
  }

  /** Forget every snapshot for a source — called when the skill itself
   *  is deleted via the Skills panel. Best-effort: a missing directory
   *  is fine (the user may have never retrained it). */
  async deleteAll(graphId: string, sourceId: string): Promise<void> {
    const dir = this.snapshotDir(graphId, sourceId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Non-fatal — the .gai delete already happened; orphan snapshots
      // (impossible to reach without the deleted source) are inert.
    }
  }

  /** Format a snapshotId from a ts. Exported so trainSkill can produce
   *  the same id format that list/read/delete expect. */
  static idFromTs(ts: number): string {
    return String(ts).padStart(16, '0');
  }

  private snapshotDir(graphId: string, sourceId: string): string {
    // sourceId can contain ':' (e.g. "skill:1780...:Foo") which is fine
    // on macOS / Linux. On Windows the path API would reject ':' as a
    // drive separator — but the App targets macOS / Linux first; the
    // Windows port (if any) can encode ':' to '_' at that point.
    return path.join(this.root, graphId, sourceId);
  }
}
