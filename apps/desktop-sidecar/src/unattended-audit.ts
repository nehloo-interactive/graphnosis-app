// Unattended-executor per-action audit. Encrypted envelope at
// `<cortex>/unattended-runs.jsonl` — encrypted-at-rest with the cortex data key,
// the SAME on-disk posture as the other cortex stores (mcp-audit.ts /
// healing-journal.ts): a single XChaCha20-Poly1305 envelope sealed with
// `host.key`, atomically rewritten under a per-cortex write queue. Nothing here
// touches the disk in cleartext — the redacted prompt/output previews and the
// undo-token previousContent of superseded/forgotten nodes all live inside the
// ciphertext.
//
// SAFETY-CRITICAL: this is the per-action ledger the owner reviews and undoes
// against. The header line for a run is written BEFORE the first step, and each
// action line is `await`ed before the executor runs the next step — losing an
// audit line silently would be worse than blocking the walk. "Append-only in
// spirit": every append reads the current envelope, pushes the new line, and
// atomically rewrites the sealed file (mirrors mcp-audit.ts's appendMcpAuditEntry);
// the per-cortex write queue keeps concurrent appends from clobbering each other
// and preserves order. One header line + one line per step/action per run.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';
import type { RecallContradictionWarning } from './contradiction-health.js';

export const AUDIT_FILE = 'unattended-runs.jsonl';

/** Lifecycle of one unattended run. `aborted` = an interlock flipped mid-walk
 *  (e.g. the kill switch) or admission was withdrawn. */
export type UnattendedRunStatus = 'running' | 'complete' | 'failed' | 'aborted';

/** What an action's side effect was, and whether it can be reversed. `none` =
 *  read/compute-only (the MVP walker's normal case: captured outputs, no
 *  cortex mutation). The other kinds carry an `undoToken` the undo manager
 *  replays. */
export type UndoKind = 'supersede' | 'skill-edit' | 'forget' | 'none';

export interface UndoClassification {
  reversible: boolean;
  kind: UndoKind;
  /** Opaque token the undo manager decodes to replay the inverse. Absent for
   *  `none` (nothing to undo) and for irreversible actions. The token base64s
   *  the pre-state (previousContent of a superseded/forgotten node) — that is
   *  acceptable here ONLY because the whole envelope is sealed at rest; base64
   *  is not encryption and must never be the outermost layer on disk. */
  undoToken?: string;
}

/** One header line — written before the run's first step. */
export interface UnattendedRunHeader {
  type: 'header';
  runId: string;
  skillSourceId: string;
  skillGraphId: string;
  skillLabel: string;
  startedAt: number;
  /** What surfaced this skill (the proactive card's signal). */
  trigger: { signalType: string; signalLabel: string; why: string };
  /** The admission gate's decision reason (decideSkillAutonomy / effective L3). */
  autonomyReason: string;
  status: UnattendedRunStatus;
  /** Set when the run reached a terminal state (complete/failed/aborted). */
  endedAt?: number;
  /** Terminal note — e.g. an abort reason. */
  note?: string;
}

/** One action line — written (awaited) before the next step runs. */
export interface UnattendedAction {
  type: 'action';
  runId: string;
  stepIndex: number;
  label: string;
  /** Display name of the model the step dispatched to (null for sub-skill steps). */
  pickedModelDisplay: string | null;
  /** What this step touched — for review + undo precision. */
  touched: {
    /** Engram ids whose memory the step recalled. */
    recalledEngrams: string[];
    /** Node ids the step wrote / edited / forgot. */
    writtenNodeIds: string[];
    /** MCP tools the step invoked. */
    mcpTools: string[];
  };
  outcome: 'ok' | 'error' | 'skipped' | 'refused';
  /** Walk-time contradiction guard warnings, if any fired on this step. */
  contradictionWarnings?: RecallContradictionWarning[];
  /** Reversibility classification + the token undo replays. */
  undo: UndoClassification;
  /** Redacted (SENSITIVE_VAR_RE) prompt/output previews — never raw secrets. */
  redactedPromptPreview: string;
  redactedOutputPreview: string;
  elapsedMs: number;
  ts: number;
  /** Set once the owner reverts this action via the review UI. */
  reverted?: boolean;
  revertedAt?: number;
  /** When the reversible-only interlock refused to execute this action, the
   *  human-readable reason (outcome === 'refused'). The step did NOT run. */
  refusedReason?: string;
}

type UnattendedLine = UnattendedRunHeader | UnattendedAction;

interface AuditEnvelope {
  version: 1;
  lines: UnattendedLine[];
}

const CURRENT_VERSION = 1 as const;

/** Encode the ledger into a sealed blob ready to write to disk. A fresh 16-byte
 *  salt is generated per encode (with a raw key the salt is purely a unique IV),
 *  so re-encoding the same ledger produces different ciphertext — expected.
 *  Mirrors encodeHealingJournal / encodeMcpAuditLog exactly. */
async function encodeEnvelope(envelope: AuditEnvelope, dataKey: Uint8Array): Promise<Uint8Array> {
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const salt = randomBytes(16);
  return crypto.encrypt(plaintext, dataKey, salt);
}

/** Decode a sealed ledger blob. Returns an empty ledger for missing/empty/corrupt
 *  files — a torn or unreadable ledger must not block the cortex. Mirrors
 *  decodeHealingJournal / decodeMcpAuditLog. */
async function decodeEnvelope(blob: Uint8Array, dataKey: Uint8Array): Promise<UnattendedLine[]> {
  if (blob.length === 0) return [];
  try {
    const plaintext = await crypto.decrypt(blob, dataKey);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<AuditEnvelope>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.lines)) {
      console.error('[unattended-audit] decoded blob has no lines array — treating as empty');
      return [];
    }
    if (parsed.version !== CURRENT_VERSION) {
      console.error(`[unattended-audit] unknown ledger version ${parsed.version} — treating as empty`);
      return [];
    }
    return parsed.lines;
  } catch (e) {
    console.error(`[unattended-audit] decode failed: ${(e as Error).message} — treating as empty`);
    return [];
  }
}

async function writeFileAtomic(target: string, data: Buffer): Promise<void> {
  const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, target);
}

async function readAll(cortexDir: string, dataKey: Uint8Array): Promise<UnattendedLine[]> {
  const p = path.join(cortexDir, AUDIT_FILE);
  let blob: Buffer;
  try {
    blob = await fs.readFile(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  return decodeEnvelope(new Uint8Array(blob), dataKey);
}

/** In-process write queue, keyed per cortexDir — concurrent appends must not
 *  clobber each other (each append is read-modify-write of one sealed file).
 *  Serializing also preserves the append order the readers rely on. Mirrors
 *  mcp-audit.ts's writeQueues. */
const writeQueues = new Map<string, Promise<void>>();

function enqueueAppend(cortexDir: string, dataKey: Uint8Array, line: UnattendedLine): Promise<void> {
  const prev = writeQueues.get(cortexDir) ?? Promise.resolve();
  const next = prev.then(async () => {
    const lines = await readAll(cortexDir, dataKey);
    lines.push(line);
    const blob = await encodeEnvelope({ version: CURRENT_VERSION, lines }, dataKey);
    await writeFileAtomic(path.join(cortexDir, AUDIT_FILE), Buffer.from(blob));
  });
  writeQueues.set(cortexDir, next.finally(() => {
    if (writeQueues.get(cortexDir) === next) writeQueues.delete(cortexDir);
  }));
  return next;
}

/** Append a run header. Awaited — the header must land before the first step. */
export async function appendUnattendedRunHeader(
  cortexDir: string,
  dataKey: Uint8Array,
  header: Omit<UnattendedRunHeader, 'type'>,
): Promise<void> {
  await enqueueAppend(cortexDir, dataKey, { type: 'header', ...header });
}

/** Append one action line. Awaited before the executor runs the next step. */
export async function appendUnattendedAction(
  cortexDir: string,
  dataKey: Uint8Array,
  action: Omit<UnattendedAction, 'type'>,
): Promise<void> {
  await enqueueAppend(cortexDir, dataKey, { type: 'action', ...action });
}

/**
 * Append a terminal header that supersedes the run's opening header — the
 * reader keeps the LAST header it sees per runId, so this updates status without
 * rewriting earlier lines (append-only in spirit). Awaited.
 */
export async function appendUnattendedRunTerminal(
  cortexDir: string,
  dataKey: Uint8Array,
  runId: string,
  patch: { status: UnattendedRunStatus; endedAt: number; note?: string },
): Promise<void> {
  // A terminal line carries only the fields the reader merges; the original
  // header (skill identity, trigger) is read from the opening line.
  const line: Partial<UnattendedRunHeader> & { type: 'header'; runId: string } = {
    type: 'header',
    runId,
    status: patch.status,
    endedAt: patch.endedAt,
    ...(patch.note ? { note: patch.note } : {}),
  };
  await enqueueAppend(cortexDir, dataKey, line as UnattendedRunHeader);
}

/** Wait for any in-flight ledger writes for this cortex to finish. */
export async function flushUnattendedAuditWrites(cortexDir: string): Promise<void> {
  await (writeQueues.get(cortexDir) ?? Promise.resolve());
}

/**
 * Read run headers, newest-first, up to `limit`. Headers are merged per runId so
 * a later terminal line (status/endedAt) overlays the opening header.
 */
export async function readRecentUnattendedRuns(
  cortexDir: string,
  dataKey: Uint8Array,
  limit: number,
): Promise<UnattendedRunHeader[]> {
  const lines = await readAll(cortexDir, dataKey);
  const byRun = new Map<string, UnattendedRunHeader>();
  for (const line of lines) {
    if (line.type !== 'header') continue;
    const prev = byRun.get(line.runId);
    byRun.set(line.runId, prev ? Object.assign({}, prev, line) : line);
  }
  const runs = [...byRun.values()].sort((a, b) => b.startedAt - a.startedAt);
  return runs.slice(0, limit);
}

/** Read one run's merged header + its action trace in step order. */
export async function readRunTrace(
  cortexDir: string,
  dataKey: Uint8Array,
  runId: string,
): Promise<{ header: UnattendedRunHeader | null; actions: UnattendedAction[] }> {
  const lines = await readAll(cortexDir, dataKey);
  let header: UnattendedRunHeader | null = null;
  const actions: UnattendedAction[] = [];
  for (const line of lines) {
    if (line.runId !== runId) continue;
    if (line.type === 'header') {
      header = header ? Object.assign({}, header, line) : line;
    } else {
      actions.push(line);
    }
  }
  actions.sort((a, b) => a.stepIndex - b.stepIndex);
  return { header, actions };
}
