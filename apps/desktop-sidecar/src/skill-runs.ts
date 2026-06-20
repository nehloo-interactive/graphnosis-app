// Persistent skill-run records (D5 + Team Playbooks 4b).
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
import type { GraphnosisHost } from './host.js';
import { mcpRegistry } from './mcp-registry.js';

const { encrypt, decrypt } = crypto;

export type SkillRunStatus =
  | 'running'
  | 'paused'
  | 'blocked-on-human'
  | 'complete'
  | 'failed';

export interface SkillRunStepLogEntry {
  stepIndex: number;
  actor: string;
  tool?: string;
  outcome: 'ok' | 'error' | 'skipped' | 'human-wait';
  ts: number;
}

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
  /** Run lifecycle state for supervisor dashboards. */
  status: SkillRunStatus;
  /** SSO subject, share token id, or owner sentinel. */
  actorId?: string;
  /** Human-readable actor label (email, share name, client). */
  actorLabel?: string;
  /** Per-step audit trail appended by save_skill_run / agent walks. */
  stepLog?: SkillRunStepLogEntry[];
  createdAt: number;
  updatedAt: number;
}

/** Public list row — redacted vars for Activity / Evidence Pack. */
export interface SkillRunListItem {
  runId: string;
  skillGraphId: string;
  skillSourceId: string;
  planTitle?: string;
  completedStepIndex: number;
  status: SkillRunStatus;
  actorId?: string;
  actorLabel?: string;
  stepLogCount: number;
  capturedVarKeys: string[];
  redactedVars: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface SkillRunStoreOptions {
  cortexDir: string;
  key: Uint8Array;
  salt: Uint8Array;
}

const SENSITIVE_VAR_RE = /pass|secret|token|key|password|credential/i;

/** Redact captured vars for UI / compliance export — keys only + truncated previews. */
export function redactSkillRunVars(vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (SENSITIVE_VAR_RE.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (typeof v === 'string') {
      out[k] = v.length > 120 ? `${v.slice(0, 117)}…` : v;
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else {
      const s = JSON.stringify(v);
      out[k] = s.length > 120 ? `${s.slice(0, 117)}…` : v;
    }
  }
  return out;
}

export function skillRunToListItem(rec: SkillRunRecord): SkillRunListItem {
  return {
    runId: rec.runId,
    skillGraphId: rec.skillGraphId,
    skillSourceId: rec.skillSourceId,
    ...(rec.planTitle ? { planTitle: rec.planTitle } : {}),
    completedStepIndex: rec.completedStepIndex,
    status: rec.status ?? deriveSkillRunStatus(rec),
    ...(rec.actorId ? { actorId: rec.actorId } : {}),
    ...(rec.actorLabel ? { actorLabel: rec.actorLabel } : {}),
    stepLogCount: rec.stepLog?.length ?? 0,
    capturedVarKeys: Object.keys(rec.capturedVars),
    redactedVars: redactSkillRunVars(rec.capturedVars),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

/** Infer status for legacy records missing the field. */
export function deriveSkillRunStatus(rec: { completedStepIndex: number; status?: SkillRunStatus }): SkillRunStatus {
  if (rec.status) return rec.status;
  return rec.completedStepIndex > 0 ? 'paused' : 'running';
}

export interface SkillRunActorContext {
  ssoSession?: { role: string; email?: string; subject?: string };
  sharingScope?: { role: string } | null;
  host?: GraphnosisHost;
}

/** Resolve actor attribution from SSO session or active share token connection. */
export function resolveSkillRunActor(ctx: SkillRunActorContext): { actorId: string; actorLabel: string } {
  if (ctx.ssoSession?.subject?.trim()) {
    return {
      actorId: ctx.ssoSession.subject.trim(),
      actorLabel: ctx.ssoSession.email?.trim() || ctx.ssoSession.subject.trim(),
    };
  }
  if (ctx.ssoSession?.email?.trim()) {
    const email = ctx.ssoSession.email.trim();
    return { actorId: email, actorLabel: email };
  }
  const connId = mcpRegistry.getMostRecentActiveId();
  if (connId && ctx.host) {
    const conn = mcpRegistry.list().find((c) => c.id === connId);
    if (conn?.sharingTokenId) {
      const token = ctx.host.getSettings().sharing?.tokens?.find((t) => t.id === conn.sharingTokenId);
      if (token) {
        return { actorId: token.id, actorLabel: token.name };
      }
      return { actorId: conn.sharingTokenId, actorLabel: 'Share token' };
    }
    if (conn?.clientName) {
      return { actorId: conn.clientName, actorLabel: conn.clientName };
    }
  }
  if (ctx.sharingScope?.role) {
    return { actorId: `role:${ctx.sharingScope.role}`, actorLabel: ctx.sharingScope.role };
  }
  return { actorId: 'owner', actorLabel: 'Cortex owner' };
}

function normalizeRecord(raw: SkillRunRecord): SkillRunRecord {
  return {
    ...raw,
    status: raw.status ?? deriveSkillRunStatus(raw),
    stepLog: Array.isArray(raw.stepLog) ? raw.stepLog : [],
  };
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
    const normalized = normalizeRecord(rec);
    const json = new TextEncoder().encode(JSON.stringify(normalized));
    const ct = await encrypt(json, this.key, this.salt);
    const file = this.file(normalized.runId);
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
    return normalizeRecord(JSON.parse(new TextDecoder().decode(pt)) as SkillRunRecord);
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

  /** List runs as redacted public rows. */
  async listPublic(): Promise<SkillRunListItem[]> {
    const runs = await this.list();
    return runs.map(skillRunToListItem);
  }
}
