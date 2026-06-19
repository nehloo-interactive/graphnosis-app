import type { SourceRecord } from '../types.js';
import type { GraphMetadata } from '../settings/index.js';

/** Thrown when a mutating operation targets a preserved source or engram. */
export class LegalHoldError extends Error {
  readonly code = 'legal_hold' as const;

  constructor(
    readonly graphId: string,
    readonly sourceId: string | undefined,
    readonly matter?: string,
    readonly scope: 'source' | 'engram' = 'source',
  ) {
    super(
      scope === 'engram'
        ? (matter
            ? `Engram is preserved (${matter}) — forget, edit, and transfer are blocked until released.`
            : 'Engram is preserved — forget, edit, and transfer are blocked until released.')
        : (matter
            ? `Source is under legal hold (${matter}) — forget, edit, and transfer are blocked.`
            : 'Source is under legal hold — forget, edit, and transfer are blocked.'),
    );
    this.name = 'LegalHoldError';
  }
}

export function isEngramOnLegalHold(meta: GraphMetadata | undefined): boolean {
  return meta?.legalHold === true;
}

export function assertEngramNotOnLegalHold(
  meta: GraphMetadata | undefined,
  graphId: string,
): void {
  if (isEngramOnLegalHold(meta)) {
    throw new LegalHoldError(graphId, undefined, meta?.legalHoldMatter, 'engram');
  }
}

export function isSourceOnLegalHold(rec: SourceRecord | undefined): boolean {
  return rec?.legalHold === true;
}

export function assertSourceNotOnLegalHold(
  rec: SourceRecord | undefined,
  graphId: string,
  sourceId: string,
  engramMeta?: GraphMetadata,
): void {
  assertEngramNotOnLegalHold(engramMeta, graphId);
  if (isSourceOnLegalHold(rec)) {
    throw new LegalHoldError(graphId, sourceId, rec?.legalHoldMatter, 'source');
  }
}

/** Resolve per-engram retention TTL from graph metadata. Undefined = no TTL. */
export function retentionTtlMsForGraph(meta: GraphMetadata | undefined): number | undefined {
  const ttl = meta?.retentionTtlMs;
  if (typeof ttl !== 'number' || ttl <= 0) return undefined;
  return Math.floor(ttl);
}

/** True when a source has exceeded its engram retention window and is not held. */
export function isRetentionExpired(
  ingestedAt: number,
  ttlMs: number | undefined,
  legalHold: boolean | undefined,
  now = Date.now(),
): boolean {
  if (legalHold) return false;
  if (ttlMs === undefined || ttlMs <= 0) return false;
  return now - ingestedAt >= ttlMs;
}

export function shouldExportBeforePurge(meta: GraphMetadata | undefined): boolean {
  return meta?.retentionExportBeforePurge !== false;
}
