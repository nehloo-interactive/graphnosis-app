// Cross-engram skill-call side-table (D1).
//
// A skill in engram A can reference a skill in engram B via `@skill: name`.
// The SDK's edge model is strictly intra-graph (an edge's endpoints are bare
// NodeIds resolved within ONE graph), so a true cross-graph edge can't be
// represented. Instead we persist cross-engram resolutions in this side-table
// next to the cortex — keyed by the calling node — and the walk consults it to
// surface the target so an AI executor can follow it.
//
// Storage: a single encrypted file `<cortexDir>/skill-call-links.json.enc`
// holding a flat array. The link set is small (one entry per cross-engram
// call), so a single file + in-memory cache is simpler than per-source files,
// and writes are atomic (tmp + rename), matching SkillSnapshotStore.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';

const { encrypt, decrypt } = crypto;

/** One resolved cross-engram skill call. */
export interface SkillCallLink {
  /** Engram + source + node of the CALLING step. */
  callerGraphId: string;
  callerSourceId: string;
  callerNodeId: string;
  /** The `@skill:` target name as written. */
  targetName: string;
  /** Engram + source + title of the resolved target skill (another engram). */
  targetGraphId: string;
  targetSourceId: string;
  targetTitle: string;
  /** Variable names passed as args. */
  args: string[];
  /** Variable to capture the return under. */
  captureAs?: string;
  /** True when the reference came from an `On failure:` recovery goal. */
  onFailure: boolean;
  /** True when the call is a member of a `@parallel:` group. */
  parallel: boolean;
}

export interface SkillCallLinkStoreOptions {
  cortexDir: string;
  /** Data key from the host — same key that encrypts `.gai` files. */
  key: Uint8Array;
  salt: Uint8Array;
}

export class SkillCallLinkStore {
  private readonly file: string;
  private readonly key: Uint8Array;
  private readonly salt: Uint8Array;
  private cache: SkillCallLink[] | null = null;

  constructor(opts: SkillCallLinkStoreOptions) {
    this.file = path.join(opts.cortexDir, 'skill-call-links.json.enc');
    this.key = opts.key;
    this.salt = opts.salt;
  }

  /** Load the full link set (cached after first read). Returns [] when the
   *  file doesn't exist yet. */
  async loadAll(): Promise<SkillCallLink[]> {
    if (this.cache) return this.cache;
    try {
      const bytes = await fs.readFile(this.file);
      const pt = await decrypt(new Uint8Array(bytes), this.key);
      const parsed = JSON.parse(new TextDecoder().decode(pt)) as SkillCallLink[];
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.cache = [];
      else throw e;
    }
    return this.cache;
  }

  private async persist(links: SkillCallLink[]): Promise<void> {
    this.cache = links;
    const json = new TextEncoder().encode(JSON.stringify(links));
    const ct = await encrypt(json, this.key, this.salt);
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, Buffer.from(ct));
    await fs.rename(tmp, this.file);
  }

  /** Replace ALL links originating from one caller source (idempotent rewire —
   *  same contract as the intra-graph linkSkillCalls). */
  async setForSource(callerGraphId: string, callerSourceId: string, links: SkillCallLink[]): Promise<void> {
    const all = await this.loadAll();
    const kept = all.filter((l) => !(l.callerGraphId === callerGraphId && l.callerSourceId === callerSourceId));
    await this.persist([...kept, ...links]);
  }

  /** All links originating from one caller source. */
  async getForSource(callerGraphId: string, callerSourceId: string): Promise<SkillCallLink[]> {
    return (await this.loadAll()).filter(
      (l) => l.callerGraphId === callerGraphId && l.callerSourceId === callerSourceId,
    );
  }

  /** Drop every link that touches a graph (caller OR target) — call when an
   *  engram is deleted so the side-table doesn't dangle. No-op if nothing matches. */
  async pruneGraph(graphId: string): Promise<void> {
    const all = await this.loadAll();
    const kept = all.filter((l) => l.callerGraphId !== graphId && l.targetGraphId !== graphId);
    if (kept.length !== all.length) await this.persist(kept);
  }
}
