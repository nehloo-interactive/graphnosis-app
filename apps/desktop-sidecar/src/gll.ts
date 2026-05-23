/**
 * .gll — per-engram LLM event log (Option C provenance layer)
 *
 * Each <graphId>.gll file sits alongside <graphId>.gai in the graphs/
 * directory. It is an encrypted, append-only JSON-lines file: every line
 * is a base64-encoded AES-GCM ciphertext of one GllEntry JSON object.
 *
 * On read (rollback, audit): split by newlines, base64-decode, decrypt,
 * parse JSON. Skip any line that fails to decrypt (truncated crash write).
 *
 * Rollback: collect all targetNodeIds from gll entries, revert those nodes
 * to their before state (or delete addNode entries). The "Roll back all LLM
 * contributions" button in Settings drives this path.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';

const { encrypt, decrypt } = crypto;

export type GllOperation =
  | 'ingestSource'
  | 'addNode'
  | 'editNode'
  | 'deleteNode'
  | 'supersede';

export type GllOriginatingTool =
  | 'remember'
  | 'apply'
  | 'brain:healing'
  | 'brain:relink';

export interface GllEntry {
  timestamp: number;
  graphId: string;
  operation: GllOperation;
  originatingTool: GllOriginatingTool;
  /** The user-visible prompt / correction text that triggered the mutation. */
  prompt?: string;
  /**
   * How the correction was resolved: deterministic (no LLM), gnn-expanded
   * (GNN candidate expansion, no LLM), or llm-assisted (local LLM involved).
   */
  mode?: 'deterministic' | 'gnn-expanded' | 'llm-assisted';
  targetSourceId?: string;
  targetNodeIds?: string[];
  after?: Record<string, unknown>;
  /** MCP client that triggered the mutation (e.g. "claude-ai", "cursor"). */
  clientName?: string;
}

export class GllWriter {
  constructor(
    private readonly cortexDir: string,
    private readonly key: Uint8Array,
    private readonly salt: Uint8Array,
  ) {}

  gllPath(graphId: string): string {
    return path.join(this.cortexDir, 'graphs', `${graphId}.gll`);
  }

  async append(entry: GllEntry): Promise<void> {
    const json = JSON.stringify(entry);
    const ct = await encrypt(new TextEncoder().encode(json), this.key, this.salt);
    const line = Buffer.from(ct).toString('base64') + '\n';
    await fs.appendFile(this.gllPath(entry.graphId), line, 'utf8');
  }

  async readAll(graphId: string): Promise<GllEntry[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.gllPath(graphId), 'utf8');
    } catch {
      return [];
    }
    const entries: GllEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const ct = Buffer.from(line.trim(), 'base64');
        const pt = await decrypt(new Uint8Array(ct), this.key);
        entries.push(JSON.parse(new TextDecoder().decode(pt)) as GllEntry);
      } catch {
        // Truncated or corrupt line — skip silently.
      }
    }
    return entries;
  }
}
