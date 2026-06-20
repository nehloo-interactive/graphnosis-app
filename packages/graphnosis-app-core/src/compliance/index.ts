import type { SourceRecord } from '../types.js';
import type { ComplianceSettings, GraphMetadata } from '../settings/index.js';

/** Resolve retention TTL: per-engram override, then cortex default, then none. */
export function retentionTtlMsForGraph(
  meta: GraphMetadata | undefined,
  compliance?: ComplianceSettings,
): number | undefined {
  const ttl = meta?.retentionTtlMs ?? compliance?.defaultRetentionTtlMs;
  if (typeof ttl !== 'number' || ttl <= 0) return undefined;
  return Math.floor(ttl);
}

/** Whether to export before purge — per-engram wins, then cortex default (true). */
export function shouldExportBeforePurge(
  meta: GraphMetadata | undefined,
  compliance?: ComplianceSettings,
): boolean {
  if (meta?.retentionExportBeforePurge !== undefined) return meta.retentionExportBeforePurge;
  if (compliance?.defaultExportBeforePurge !== undefined) return compliance.defaultExportBeforePurge;
  return true;
}

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

export type { IndustryTag, SensitivityTier } from './industry.js';
export {
  normalizeIndustryTags,
  hasRegulatedIndustryTag,
  effectiveSensitivityTier,
  TIER_CAPS,
  industryRecallBudgetClamp,
  budgetForGraph,
} from './industry.js';
export type {
  ClassificationColor,
  ClassificationLabel,
  ClassificationSchema,
  ClassificationPolicy,
} from './classification-schema.js';
export {
  DEFAULT_CLASSIFICATION_LABELS,
  findClassificationLabel,
  userAssignableLabels,
  resolveClassificationPolicy,
  sanitizeClassificationLabel,
  sanitizeClassificationSchema,
  classificationSchemaFromCompliance,
} from './classification-schema.js';
export { detectPolicyContradictions, type PolicyContradictionCandidate } from './policy-contradiction.js';
export type { ObligationType, NodeObligation, ObligationListFilter } from './obligation.js';
export {
  isActiveObligation,
  obligationDueWithin,
  sortObligationsByExpiresAt,
  filterObligations,
} from './obligation.js';
