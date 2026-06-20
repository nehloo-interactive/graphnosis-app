/**
 * Encrypted obligation index — maps nodeId → temporal obligation metadata.
 *
 * Persisted at `<cortex>/obligation-index.enc`. Rebuilt opportunistically from
 * op-log `ingestSource` / `addNode` rows that carry obligation fields.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';
import type { GraphId, NodeId } from '@graphnosis-app/core';
import type { NodeObligation, ObligationListFilter, ObligationType } from '@graphnosis-app/core';
import { filterObligations, isActiveObligation } from '@graphnosis-app/core';

const { encrypt, decrypt } = crypto;

export interface ObligationWriteInput {
  obligationType: ObligationType;
  effectiveDate?: number;
  expiresAt: number;
}

export interface ObligationIndexOptions {
  cortexDir: string;
  key: Uint8Array;
  salt: Uint8Array;
}

interface PersistedObligationIndex {
  version: 1;
  entries: Record<NodeId, NodeObligation>;
}

export class ObligationIndex {
  private entries = new Map<NodeId, NodeObligation>();
  private dirty = false;
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly opts: ObligationIndexOptions) {}

  private filePath(): string {
    return path.join(this.opts.cortexDir, 'obligation-index.enc');
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath());
      const plain = await decrypt(new Uint8Array(raw), this.opts.key);
      const parsed = JSON.parse(new TextDecoder().decode(plain)) as PersistedObligationIndex;
      if (parsed.version !== 1 || !parsed.entries) return;
      this.entries = new Map(Object.entries(parsed.entries));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.error(`[obligation-index] load failed: ${err.message}`);
      }
    }
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    const payload: PersistedObligationIndex = {
      version: 1,
      entries: Object.fromEntries(this.entries),
    };
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    const ct = await encrypt(plain, this.opts.key, this.opts.salt);
    const target = this.filePath();
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, Buffer.from(ct), { mode: 0o600 });
    await fs.rename(tmp, target);
    this.dirty = false;
  }

  async register(
    graphId: GraphId,
    nodeId: NodeId,
    sourceId: string,
    input: ObligationWriteInput,
  ): Promise<NodeObligation> {
    await this.ensureLoaded();
    const now = Date.now();
    const rec: NodeObligation = {
      graphId,
      nodeId,
      sourceId,
      obligationType: input.obligationType,
      effectiveDate: input.effectiveDate ?? now,
      expiresAt: input.expiresAt,
      createdAt: now,
    };
    this.entries.set(nodeId, rec);
    this.dirty = true;
    await this.persist();
    return rec;
  }

  async removeNodeIds(nodeIds: Iterable<NodeId>): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    for (const id of nodeIds) {
      if (this.entries.delete(id)) changed = true;
    }
    if (!changed) return;
    this.dirty = true;
    await this.persist();
  }

  async removeForSource(graphId: GraphId, sourceId: string): Promise<void> {
    await this.ensureLoaded();
    let changed = false;
    for (const [id, ob] of this.entries) {
      if (ob.graphId === graphId && ob.sourceId === sourceId) {
        this.entries.delete(id);
        changed = true;
      }
    }
    if (!changed) return;
    this.dirty = true;
    await this.persist();
  }

  get(nodeId: NodeId): NodeObligation | undefined {
    return this.entries.get(nodeId);
  }

  list(filter: ObligationListFilter = {}): NodeObligation[] {
    return filterObligations([...this.entries.values()], filter);
  }

  hasActiveForSource(graphId: GraphId, sourceId: string, now = Date.now()): boolean {
    for (const ob of this.entries.values()) {
      if (ob.graphId === graphId && ob.sourceId === sourceId && isActiveObligation(ob, now)) {
        return true;
      }
    }
    return false;
  }

  /** Drop index rows whose nodes no longer exist in the graph. */
  async pruneMissingNodes(
    liveNodeIds: (graphId: GraphId) => Set<string>,
  ): Promise<number> {
    await this.ensureLoaded();
    let removed = 0;
    for (const [nodeId, ob] of this.entries) {
      const live = liveNodeIds(ob.graphId);
      if (!live.has(nodeId)) {
        this.entries.delete(nodeId);
        removed++;
      }
    }
    if (removed > 0) {
      this.dirty = true;
      await this.persist();
    }
    return removed;
  }
}

export function parseObligationFromOplog(
  after: unknown,
): ObligationWriteInput | undefined {
  if (typeof after !== 'object' || after === null) return undefined;
  const o = after as Record<string, unknown>;
  const nested = o.obligation;
  const src = (typeof nested === 'object' && nested !== null ? nested : o) as Record<string, unknown>;
  const obligationType = src.obligationType;
  const expiresAt = src.expiresAt;
  if (
    obligationType !== 'deadline'
    && obligationType !== 'renewal'
    && obligationType !== 'review-by'
  ) return undefined;
  if (typeof expiresAt !== 'number' || expiresAt <= 0) return undefined;
  const effectiveDate = typeof src.effectiveDate === 'number' ? src.effectiveDate : undefined;
  return { obligationType, expiresAt, ...(effectiveDate !== undefined ? { effectiveDate } : {}) };
}
