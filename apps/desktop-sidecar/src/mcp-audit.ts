/**
 * Durable encrypted MCP audit log at `<cortex>/mcp-audit.enc`.
 *
 * Append-only in spirit: each tool call appends one event. The file is a
 * single encrypted envelope (same pattern as healing-journal) — fine for
 * enterprise export volumes in Batch 1; compaction can land later.
 *
 * PRIVACY: raw queries are never stored — only length + stable hash.
 */

import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';

export const MCP_AUDIT_FILE = 'mcp-audit.enc';

export interface McpAuditTokenBudget {
  requestedTokens?: number;
  requestedNodes?: number;
  servedTokens?: number;
  servedNodes?: number;
}

export interface McpAuditEvent {
  id: string;
  ts: number;
  tool: string;
  clientId: string;
  engramIds?: string[];
  nodeIds?: string[];
  tokenBudget?: McpAuditTokenBudget;
  /** ConsentRecord.consentId when a gated tier was authorised for this call. */
  consentGrantId?: string;
  queryHash?: string;
  queryLen?: number;
  isError?: boolean;
  transport?: 'stdio' | 'socket' | 'http';
}

interface AuditEnvelope {
  version: 1;
  events: McpAuditEvent[];
}

const CURRENT_VERSION = 1 as const;

/** Stable short hash for correlating identical queries without retaining content. */
export function hashMcpQuery(query: string): string {
  return createHash('sha256').update(query).digest('hex').slice(0, 16);
}

async function readEnvelope(cortexDir: string, dataKey: Uint8Array): Promise<AuditEnvelope> {
  const p = path.join(cortexDir, MCP_AUDIT_FILE);
  let blob: Buffer;
  try {
    blob = await fs.readFile(p);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { version: CURRENT_VERSION, events: [] };
    throw e;
  }
  if (blob.length === 0) return { version: CURRENT_VERSION, events: [] };
  try {
    const plaintext = await crypto.decrypt(new Uint8Array(blob), dataKey);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<AuditEnvelope>;
    if (!parsed || parsed.version !== CURRENT_VERSION || !Array.isArray(parsed.events)) {
      console.error('[mcp-audit] corrupt envelope — treating as empty');
      return { version: CURRENT_VERSION, events: [] };
    }
    return parsed as AuditEnvelope;
  } catch (e) {
    console.error(`[mcp-audit] decode failed: ${(e as Error).message} — treating as empty`);
    return { version: CURRENT_VERSION, events: [] };
  }
}

async function writeEnvelope(cortexDir: string, dataKey: Uint8Array, envelope: AuditEnvelope): Promise<void> {
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const salt = randomBytes(16);
  const ct = await crypto.encrypt(plaintext, dataKey, salt);
  const p = path.join(cortexDir, MCP_AUDIT_FILE);
  await fs.writeFile(p, Buffer.from(ct), { mode: 0o600 });
}

/** In-process write queue — concurrent MCP tool calls must not clobber each other. */
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(cortexDir: string, task: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(cortexDir) ?? Promise.resolve();
  const next = prev.then(task, task);
  writeQueues.set(cortexDir, next.finally(() => {
    if (writeQueues.get(cortexDir) === next) writeQueues.delete(cortexDir);
  }));
  return next;
}

export async function appendMcpAuditEvent(
  cortexDir: string,
  dataKey: Uint8Array,
  partial: Omit<McpAuditEvent, 'id' | 'ts'>,
): Promise<McpAuditEvent> {
  const entry: McpAuditEvent = {
    id: randomBytes(8).toString('hex'),
    ts: Date.now(),
    ...partial,
  };
  await enqueueWrite(cortexDir, async () => {
    const envelope = await readEnvelope(cortexDir, dataKey);
    envelope.events.push(entry);
    await writeEnvelope(cortexDir, dataKey, envelope);
  });
  return entry;
}

export async function listMcpAuditEvents(
  cortexDir: string,
  dataKey: Uint8Array,
): Promise<McpAuditEvent[]> {
  const envelope = await readEnvelope(cortexDir, dataKey);
  return envelope.events.slice();
}
