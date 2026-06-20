import type { GraphMetadata } from '../settings/index.js';
import type { ClassificationSchema } from './classification-schema.js';
import { resolveClassificationPolicy } from './classification-schema.js';

/** Regulated-industry classification tags for per-engram policy tightening. */
export type IndustryTag = 'hipaa' | 'pci' | 'export-controlled' | (string & {});

export type SensitivityTier = 'public' | 'personal' | 'sensitive';

const REGULATED_TAGS = new Set<string>(['hipaa', 'pci', 'export-controlled']);

export function normalizeIndustryTags(raw: unknown): IndustryTag[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= 64);
  return out.length > 0 ? [...new Set(out)] : undefined;
}

export function hasRegulatedIndustryTag(meta: GraphMetadata | undefined): boolean {
  const tags = meta?.industryTags;
  if (!tags?.length) return false;
  return tags.some((t) => REGULATED_TAGS.has(t.toLowerCase()));
}

/** Bump effective tier when regulated industry tags are present. */
export function effectiveSensitivityTier(
  meta: GraphMetadata | undefined,
  schema?: ClassificationSchema,
): SensitivityTier {
  return resolveClassificationPolicy(meta?.classificationLabelId, schema, meta).tier;
}

/** Per-tier hard caps (mirrors secure-sync TIER_CAPS). */
export const TIER_CAPS: Record<SensitivityTier, { maxTokens: number; maxNodes: number }> = {
  public: { maxTokens: 8_000, maxNodes: 50 },
  personal: { maxTokens: 2_000, maxNodes: 20 },
  sensitive: { maxTokens: 500, maxNodes: 5 },
};

/** Industry-tag recall clamp — halves caps for each regulated tag (floor at sensitive). */
export function industryRecallBudgetClamp(
  meta: GraphMetadata | undefined,
  requested: { maxTokens: number; maxNodes: number },
  schema?: ClassificationSchema,
): { maxTokens: number; maxNodes: number } {
  const { tier, caps } = resolveClassificationPolicy(meta?.classificationLabelId, schema, meta);
  let maxTokens = Math.min(requested.maxTokens, caps.maxTokens);
  let maxNodes = Math.min(requested.maxNodes, caps.maxNodes);
  const tags = meta?.industryTags ?? [];
  let regulatedCount = 0;
  for (const t of tags) {
    if (REGULATED_TAGS.has(t.toLowerCase())) regulatedCount++;
  }
  if (regulatedCount > 0) {
    const factor = Math.pow(0.5, regulatedCount);
    maxTokens = Math.max(100, Math.floor(maxTokens * factor));
    maxNodes = Math.max(1, Math.floor(maxNodes * factor));
  }
  return { maxTokens, maxNodes };
}

export function budgetForGraph(
  meta: GraphMetadata | undefined,
  requested: { maxTokens: number; maxNodes: number },
  schema?: ClassificationSchema,
): { maxTokens: number; maxNodes: number } {
  return industryRecallBudgetClamp(meta, requested, schema);
}
