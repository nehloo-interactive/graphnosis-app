import { createHash } from 'node:crypto';
import type { GraphId, NodeId, SourceId, SourceRecord } from '../types.js';

// In-memory source index. Persisted as part of the encrypted graph bundle by the app.
// Maps sourceId -> nodes derived from it, so "Forget source" is a clean operation.

export class SourceIndex {
  private bySource = new Map<SourceId, SourceRecord>();
  private byNode = new Map<NodeId, SourceId>();

  add(record: SourceRecord): void {
    this.bySource.set(record.sourceId, record);
    for (const n of record.nodeIds) this.byNode.set(n, record.sourceId);
  }

  attachNode(sourceId: SourceId, nodeId: NodeId): void {
    const rec = this.bySource.get(sourceId);
    if (!rec) throw new Error(`Unknown source ${sourceId}`);
    if (!rec.nodeIds.includes(nodeId)) rec.nodeIds.push(nodeId);
    this.byNode.set(nodeId, sourceId);
  }

  list(graphId?: GraphId): SourceRecord[] {
    const all = [...this.bySource.values()];
    return graphId ? all.filter(r => r.graphId === graphId) : all;
  }

  get(sourceId: SourceId): SourceRecord | undefined {
    return this.bySource.get(sourceId);
  }

  nodesOf(sourceId: SourceId): NodeId[] {
    return this.bySource.get(sourceId)?.nodeIds ?? [];
  }

  sourceOf(nodeId: NodeId): SourceId | undefined {
    return this.byNode.get(nodeId);
  }

  forget(sourceId: SourceId): NodeId[] {
    const rec = this.bySource.get(sourceId);
    if (!rec) return [];
    for (const n of rec.nodeIds) this.byNode.delete(n);
    this.bySource.delete(sourceId);
    return rec.nodeIds;
  }

  toJSON(): SourceRecord[] {
    return [...this.bySource.values()];
  }

  static fromJSON(records: SourceRecord[]): SourceIndex {
    const idx = new SourceIndex();
    for (const r of records) idx.add(r);
    return idx;
  }
}

export function makeSourceId(kind: SourceRecord['kind'], ref: string): SourceId {
  const h = createHash('sha256').update(kind).update('\0').update(ref).digest('hex').slice(0, 24);
  return `${kind}:${h}`;
}

export function hashContent(bytes: Uint8Array | string): string {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  return createHash('sha256').update(buf).digest('hex');
}
