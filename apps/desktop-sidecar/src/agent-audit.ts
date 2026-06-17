// Ghampus audit log. Append-only JSONL at `<cortex>/agent-audit.jsonl`.
//
// Distinct from the MCP audit lines that go to stderr — the agent audit
// lives on disk, inside the cortex, so it persists across sessions and
// the user can inspect it from the desktop UI. The `agent-audit.jsonl`
// path is encrypted-at-rest with the rest of the cortex.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentAuditEntry } from './agent-types.js';

const AUDIT_FILE = 'agent-audit.jsonl';

/**
 * Append one entry. Writes synchronously (await fs.appendFile) so the
 * caller can `await` and know the line landed before returning to the
 * user — losing audit lines silently would be worse than blocking.
 *
 * The file is created on first write. Each line is a single JSON object;
 * newlines inside values would never appear here because the entry's
 * fields are typed (numbers, strings, booleans) and JSON.stringify
 * escapes any embedded newline.
 */
export async function appendAuditEntry(cortexDir: string, entry: AgentAuditEntry): Promise<void> {
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(path.join(cortexDir, AUDIT_FILE), line, 'utf8');
}

/**
 * Read the last `limit` entries, newest first. Returns an empty array when
 * the file doesn't exist yet — readers should treat that as "no calls
 * happened" rather than an error.
 */
export async function readRecentAuditEntries(
  cortexDir: string,
  limit: number,
): Promise<AgentAuditEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(cortexDir, AUDIT_FILE), 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const tail = lines.slice(-limit).reverse();
  const out: AgentAuditEntry[] = [];
  for (const l of tail) {
    try {
      out.push(JSON.parse(l) as AgentAuditEntry);
    } catch {
      // Skip corrupt lines silently — append-only files can have a torn
      // tail on power loss; we'd rather show the rest than throw.
    }
  }
  return out;
}
