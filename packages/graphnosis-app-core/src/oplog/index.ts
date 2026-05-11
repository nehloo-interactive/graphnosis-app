import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DeviceId, OpLogEvent, GraphId } from '../types.js';
import { encrypt, decrypt } from '../crypto/index.js';

// Append-only encrypted op-log. One file per device, materialized into .aikg locally.
// Sync layer (iCloud/Drive) syncs the directory of op-log files, not the .aikg.

export interface OpLogWriterOptions {
  dir: string;
  deviceId: DeviceId;
  key: Uint8Array;
  salt: Uint8Array;
}

export class OpLogWriter {
  private sessionId = randomUUID();
  private buffer: OpLogEvent[] = [];
  private flushing = false;

  constructor(private readonly opts: OpLogWriterOptions) {}

  private filePath(): string {
    return path.join(this.opts.dir, `${this.opts.deviceId}.oplog`);
  }

  emit(partial: Omit<OpLogEvent, 'id' | 'ts' | 'deviceId' | 'sessionId'>): OpLogEvent {
    const ev: OpLogEvent = {
      id: randomUUID(),
      ts: Date.now(),
      deviceId: this.opts.deviceId,
      sessionId: this.sessionId,
      ...partial,
    };
    this.buffer.push(ev);
    void this.flush();
    return ev;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      const batch = this.buffer.splice(0, this.buffer.length);
      const line = batch.map(e => JSON.stringify(e)).join('\n') + '\n';
      const ct = await encrypt(new TextEncoder().encode(line), this.opts.key, this.opts.salt);
      await fs.mkdir(this.opts.dir, { recursive: true });
      await fs.appendFile(this.filePath(), Buffer.from(prefixLen(ct)));
    } finally {
      this.flushing = false;
      if (this.buffer.length > 0) void this.flush();
    }
  }
}

export async function readAllEvents(dir: string, passphraseOrKey: string | Uint8Array): Promise<OpLogEvent[]> {
  const out: OpLogEvent[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.endsWith('.oplog')) continue;
    const buf = await fs.readFile(path.join(dir, name));
    const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    let cursor = 0;
    while (cursor < u8.length) {
      const len = new DataView(u8.buffer, u8.byteOffset + cursor, 4).getUint32(0, true);
      cursor += 4;
      const chunk = u8.subarray(cursor, cursor + len);
      cursor += len;
      const pt = await decrypt(chunk, passphraseOrKey);
      const text = new TextDecoder().decode(pt);
      for (const ln of text.split('\n')) {
        if (!ln) continue;
        out.push(JSON.parse(ln) as OpLogEvent);
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  return out;
}

// Deterministic merge: per (graphId, target.id, field) last-writer-wins by ts, tie-break by deviceId.
// Provenance retained — caller can read full event stream for audit.
export function reduce(events: OpLogEvent[]): Map<GraphId, MaterializedGraphState> {
  const graphs = new Map<GraphId, MaterializedGraphState>();
  for (const ev of events) {
    let g = graphs.get(ev.graphId);
    if (!g) {
      g = { nodes: new Map(), edges: new Map(), sources: new Map() };
      graphs.set(ev.graphId, g);
    }
    applyEvent(g, ev);
  }
  return graphs;
}

export interface MaterializedGraphState {
  nodes: Map<string, { data: unknown; ts: number; deviceId: DeviceId }>;
  edges: Map<string, { data: unknown; ts: number; deviceId: DeviceId }>;
  sources: Map<string, { data: unknown; ts: number; deviceId: DeviceId }>;
}

function applyEvent(g: MaterializedGraphState, ev: OpLogEvent): void {
  const bucket: Map<string, { data: unknown; ts: number; deviceId: DeviceId }> =
    ev.target.kind === 'node' ? g.nodes :
    ev.target.kind === 'edge' ? g.edges :
    g.sources;
  const existing = bucket.get(ev.target.id);
  const wins = !existing || ev.ts > existing.ts ||
    (ev.ts === existing.ts && ev.deviceId > existing.deviceId);
  if (!wins) return;
  if (ev.op === 'deleteNode' || ev.op === 'deleteEdge' || ev.op === 'forgetSource') {
    bucket.delete(ev.target.id);
    return;
  }
  bucket.set(ev.target.id, { data: ev.after, ts: ev.ts, deviceId: ev.deviceId });
}

function prefixLen(chunk: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, chunk.length, true);
  const out = new Uint8Array(len.length + chunk.length);
  out.set(len, 0);
  out.set(chunk, len.length);
  return out;
}
