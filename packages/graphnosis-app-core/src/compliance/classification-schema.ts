import type { ComplianceSettings, GraphMetadata } from '../settings/index.js';
import type { SensitivityTier } from './industry.js';
import { TIER_CAPS, hasRegulatedIndustryTag } from './industry.js';

/** IT-defined label color — hex (#rrggbb) or design token (green, yellow, red). */
export type ClassificationColor = string;

export interface ClassificationLabel {
  id: string;
  displayName: string;
  color: ClassificationColor;
  internalTier: SensitivityTier;
  /** When false, hidden from user assignable pickers (IT-only / catalog defaults). Default true. */
  userAssignable?: boolean;
  /** When false, label is disabled in UI and MDM export. Default true. */
  enabled?: boolean;
  /** Optional recall cap overrides — merged on top of internalTier defaults. */
  capOverrides?: { maxTokens?: number; maxNodes?: number };
}

export interface ClassificationSchema {
  enabled: boolean;
  labels: ClassificationLabel[];
  /** Default label id for new personal engrams when schema is enabled. */
  defaultEngramLabel?: string;
}

export interface ClassificationPolicy {
  tier: SensitivityTier;
  caps: { maxTokens: number; maxNodes: number };
  label?: ClassificationLabel;
}

export const DEFAULT_CLASSIFICATION_LABELS: ClassificationLabel[] = [
  {
    id: 'green',
    displayName: 'Non-confidential',
    color: '#22c55e',
    internalTier: 'public',
    userAssignable: true,
    enabled: true,
  },
  {
    id: 'yellow',
    displayName: 'Internal',
    color: '#eab308',
    internalTier: 'personal',
    userAssignable: true,
    enabled: true,
  },
  {
    id: 'red',
    displayName: 'Restricted',
    color: '#ef4444',
    internalTier: 'sensitive',
    userAssignable: true,
    enabled: true,
  },
];

const LABEL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function isEnabledLabel(label: ClassificationLabel | undefined): label is ClassificationLabel {
  return !!label && label.enabled !== false;
}

export function findClassificationLabel(
  schema: ClassificationSchema | undefined,
  labelId: string | undefined,
): ClassificationLabel | undefined {
  if (!schema?.enabled || !labelId?.trim()) return undefined;
  const label = schema.labels.find((l) => l.id === labelId);
  return isEnabledLabel(label) ? label : undefined;
}

/** Labels visible in user-facing assign pickers. */
export function userAssignableLabels(schema: ClassificationSchema | undefined): ClassificationLabel[] {
  if (!schema?.enabled) return [];
  return schema.labels.filter((l) => isEnabledLabel(l) && l.userAssignable !== false);
}

function bumpTierForIndustry(base: SensitivityTier, meta: GraphMetadata | undefined): SensitivityTier {
  if (!hasRegulatedIndustryTag(meta)) return base;
  if (base === 'public') return 'personal';
  if (base === 'personal') return 'sensitive';
  return 'sensitive';
}

/**
 * Resolve effective tier + recall caps from IT label schema, engram metadata, and industry tags.
 * When schema is enabled and `classificationLabelId` is set, label.internalTier drives policy.
 */
export function resolveClassificationPolicy(
  labelId: string | undefined,
  schema: ClassificationSchema | undefined,
  meta?: GraphMetadata,
): ClassificationPolicy {
  const effectiveLabelId = labelId ?? meta?.classificationLabelId;
  const label = findClassificationLabel(schema, effectiveLabelId);

  let tier: SensitivityTier = label?.internalTier ?? meta?.sensitivityTier ?? 'personal';
  let caps = {
    maxTokens: label?.capOverrides?.maxTokens ?? TIER_CAPS[tier].maxTokens,
    maxNodes: label?.capOverrides?.maxNodes ?? TIER_CAPS[tier].maxNodes,
  };

  tier = bumpTierForIndustry(tier, meta);

  if (tier !== (label?.internalTier ?? meta?.sensitivityTier ?? 'personal')) {
    caps = {
      maxTokens: TIER_CAPS[tier].maxTokens,
      maxNodes: TIER_CAPS[tier].maxNodes,
    };
  }

  return {
    tier,
    caps,
    ...(label ? { label } : {}),
  };
}

export function sanitizeClassificationLabel(raw: unknown): ClassificationLabel | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  const displayName = typeof r.displayName === 'string' ? r.displayName.trim() : '';
  const color = typeof r.color === 'string' ? r.color.trim() : '';
  const internalTier = r.internalTier;
  if (!LABEL_ID_RE.test(id) || !displayName || displayName.length > 64 || !color || color.length > 32) {
    return null;
  }
  if (internalTier !== 'public' && internalTier !== 'personal' && internalTier !== 'sensitive') {
    return null;
  }
  const capsRaw = r.capOverrides && typeof r.capOverrides === 'object'
    ? r.capOverrides as Record<string, unknown>
    : null;
  const maxTokens = typeof capsRaw?.maxTokens === 'number' && capsRaw.maxTokens > 0
    ? Math.floor(capsRaw.maxTokens)
    : undefined;
  const maxNodes = typeof capsRaw?.maxNodes === 'number' && capsRaw.maxNodes > 0
    ? Math.floor(capsRaw.maxNodes)
    : undefined;
  const capOverrides = maxTokens !== undefined || maxNodes !== undefined
    ? { ...(maxTokens !== undefined ? { maxTokens } : {}), ...(maxNodes !== undefined ? { maxNodes } : {}) }
    : undefined;
  return {
    id,
    displayName,
    color,
    internalTier,
    ...(r.userAssignable === false ? { userAssignable: false } : {}),
    ...(r.enabled === false ? { enabled: false } : {}),
    ...(capOverrides ? { capOverrides } : {}),
  };
}

export function sanitizeClassificationSchema(raw: unknown): ClassificationSchema | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const enabled = r.enabled === true;
  const labelsRaw = Array.isArray(r.labels) ? r.labels : [];
  const labels: ClassificationLabel[] = [];
  const seen = new Set<string>();
  for (const item of labelsRaw) {
    const label = sanitizeClassificationLabel(item);
    if (!label || seen.has(label.id)) continue;
    seen.add(label.id);
    labels.push(label);
  }
  const defaultEngramLabel = typeof r.defaultEngramLabel === 'string' && r.defaultEngramLabel.trim()
    ? r.defaultEngramLabel.trim()
    : undefined;
  if (!enabled && labels.length === 0 && !defaultEngramLabel) return undefined;
  return {
    enabled,
    labels,
    ...(defaultEngramLabel && labels.some((l) => l.id === defaultEngramLabel)
      ? { defaultEngramLabel }
      : {}),
  };
}

export function classificationSchemaFromCompliance(
  compliance: ComplianceSettings | undefined,
): ClassificationSchema | undefined {
  return sanitizeClassificationSchema(compliance?.classificationSchema);
}
