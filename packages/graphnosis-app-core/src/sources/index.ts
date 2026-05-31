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

  /**
   * Insert a brand-new node into a source's ordered nodeIds at a specific
   * position. Position is clamped to [0, nodeIds.length]. Used by the
   * Skills editor when the user clicks "+ insert chunk" between two
   * existing chunks.
   */
  insertNodeAt(sourceId: SourceId, nodeId: NodeId, position: number): void {
    const rec = this.bySource.get(sourceId);
    if (!rec) throw new Error(`Unknown source ${sourceId}`);
    if (rec.nodeIds.includes(nodeId)) return; // idempotent — already attached
    const clamped = Math.max(0, Math.min(position, rec.nodeIds.length));
    rec.nodeIds.splice(clamped, 0, nodeId);
    this.byNode.set(nodeId, sourceId);
  }

  /**
   * Remove a single node from a source's nodeIds list. Does NOT delete the
   * node from the graph — that's the caller's job (typically via
   * applyCorrection with kind='delete'). Returns true if the node was
   * present, false otherwise.
   */
  removeNode(sourceId: SourceId, nodeId: NodeId): boolean {
    const rec = this.bySource.get(sourceId);
    if (!rec) return false;
    const i = rec.nodeIds.indexOf(nodeId);
    if (i === -1) return false;
    rec.nodeIds.splice(i, 1);
    this.byNode.delete(nodeId);
    return true;
  }

  /**
   * Replace a source's nodeIds with a new ordering. The new order MUST be
   * a permutation of the current nodeIds (same multiset — no additions or
   * removals). Throws on mismatch so callers can surface a clear error.
   */
  reorderNodes(sourceId: SourceId, newOrder: NodeId[]): void {
    const rec = this.bySource.get(sourceId);
    if (!rec) throw new Error(`Unknown source ${sourceId}`);
    if (newOrder.length !== rec.nodeIds.length) {
      throw new Error(`reorderNodes: length mismatch (${newOrder.length} vs ${rec.nodeIds.length})`);
    }
    const current = new Set(rec.nodeIds);
    for (const id of newOrder) {
      if (!current.has(id)) throw new Error(`reorderNodes: node ${id} not in source ${sourceId}`);
    }
    const next = new Set(newOrder);
    if (next.size !== newOrder.length) {
      throw new Error(`reorderNodes: duplicate node ids in newOrder`);
    }
    rec.nodeIds = newOrder.slice();
    // byNode mapping unchanged — same set of nodes, just reordered.
  }

  /**
   * Rename a source's human-readable ref (the label shown in the Sources
   * panel and the Skills library). The sourceId is immutable; only the
   * ref changes.
   */
  rename(sourceId: SourceId, newRef: string): void {
    const rec = this.bySource.get(sourceId);
    if (!rec) throw new Error(`Unknown source ${sourceId}`);
    rec.ref = newRef;
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
