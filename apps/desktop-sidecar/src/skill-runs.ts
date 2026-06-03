// Persistent skill-run records (D5).
//
// A skill executed by an AI client captures variables (`@skill: x -> $var`)
// that, until now, lived only for one conversation. This store persists a
// "skill-run" — the captured vars + how far the run got — so a multi-skill
// orchestration can be RESUMED across sessions (e.g. continue tomorrow a deploy
// that paused waiting on approval).
//
// Storage: one encrypted file per run, `<cortexDir>/skill-runs/<runId>.json.enc`
// — same crypto + atomic-write pattern as SkillSnapshotStore. The executor
// upserts via the save_skill_run MCP tool as it walks; resume_skill_run reads
// it back.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';

const { encrypt, decrypt } = crypto;

export interface SkillRunRecord {
  runId: string;
  /** The skill being executed. */
  skillGraphId: string;
  skillSourceId: string;
  /** Human-readable skill title, for listing. */
  planTitle?: string;
  /** Captured variables accumulated across the run ($name without the `$`). */
  capturedVars: Record<string, unknown>;
  /** 1-based index of the last COMPLETED step (0 = nothing done yet). The
   *  executor resumes at completedStepIndex + 1. */
  completedStepIndex: number;
  createdAt: number;
  updatedAt: number;
}

export interface SkillRunStoreOptions {
  cortexDir: string;
  key: Uint8Array;
  salt: Uint8Array;
}

export class SkillRunStore {
  private readonly root: string;
  private readonly key: Uint8Array;
  private readonly salt: Uint8Array;

  constructor(opts: SkillRunStoreOptions) {
    this.root = path.join(opts.cortexDir, 'skill-runs');
    this.key = opts.key;
    this.salt = opts.salt;
  }

  private file(runId: string): string {
    // runId is generated server-side (UUID) — but guard against path traversal
    // in case a client supplies its own.
    const safe = runId.replace(/[^A-Za-z0-9_-]/g, '');
    return path.join(this.root, `${safe}.json.enc`);
  }

  /** Create or overwrite a run record (atomic). */
  async save(rec: SkillRunRecord): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const json = new TextEncoder().encode(JSON.stringify(rec));
    const ct = await encrypt(json, this.key, this.salt);
    const file = this.file(rec.runId);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, Buffer.from(ct));
    await fs.rename(tmp, file);
  }

  /** Read one run record, or null when it doesn't exist. */
  async read(runId: string): Promise<SkillRunRecord | null> {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.file(runId));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    const pt = await decrypt(new Uint8Array(bytes), this.key);
    return JSON.parse(new TextDecoder().decode(pt)) as SkillRunRecord;
  }

  /** Delete a run (e.g. once the orchestration completes). No-op if absent. */
  async delete(runId: string): Promise<void> {
    try { await fs.unlink(this.file(runId)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }

  /** All runs, newest-updated first. */
  async list(): Promise<SkillRunRecord[]> {
    let entries: string[];
    try { entries = await fs.readdir(this.root); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    const out: SkillRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json.enc')) continue;
      const rec = await this.read(entry.slice(0, -'.json.enc'.length));
      if (rec) out.push(rec);
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }
}
