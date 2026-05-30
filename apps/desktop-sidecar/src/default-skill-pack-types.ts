/**
 * default-skill-pack-types.ts
 *
 * Pure TypeScript schema for authoring default GTS skill packs.
 * This file defines shapes only — no content, no skill text, no recipes.
 * It is safe to commit.
 *
 * The content file (default-skill-packs.ts) is gitignored. It is authored
 * locally, verified by scripts/build-gts.mjs, then compiled to .gts binaries
 * that are also gitignored. Neither the content nor the binaries enter the repo.
 *
 * Relationship to gts-format.ts
 * ─────────────────────────────
 * GtsPayload / GtsSkill / RecallRecipe* from gts-format.ts are the wire types
 * consumed by buildGtsPackage(). DefaultSkillPack and friends are the authoring
 * types consumed by build-gts.mjs before it calls buildGtsPackage(). They add
 * authoring-time fields (contentWarnings, verifiedAt) that are stripped before
 * serialization.
 */

// ── Re-export wire types for convenience ─────────────────────────────────────
// Importers of this file get the full type surface without touching gts-format.ts.

export type {
  RecallRecipeStep,
  RecallRecipe,
  GtsSkill,
  GtsPayload,
} from './gts-format.js';

// ── Authoring-time types ──────────────────────────────────────────────────────

/**
 * A single step in a recall recipe, as authored.
 * Mirrors RecallRecipeStep — reproduced here so the authoring file can import
 * from one place without a direct gts-format dependency.
 */
export interface AuthoredRecallStep {
  /** MCP tool name. Must be one of the 35 tools listed in GRAPHNOSIS.md. */
  tool:
    | 'recall' | 'remind' | 'dig_deeper' | 'remember' | 'forget'
    | 'apply' | 'stats' | 'vitality'
    | 'list_engrams' | 'suggest_engram' | 'browse_engram' | 'recent' | 'get_engram_schema'
    | 'recall_structured' | 'recall_with_citations' | 'compare_engrams' | 'cross_search'
    | 'find_source' | 'recall_source' | 'transfer_source'
    | 'ingest_batch' | 'engram_summary'
    | 'duplicate_pairs' | 'healing_journal' | 'gnn_status' | 'confirm_data_access'
    | 'audit_memory' | 'check_duplicate'
    | 'edit'
    | 'develop' | 'predict' | 'insights' | 'gnn_neighbors' | 'llm_query' | 'llm_distill'
    | 'train_skill' | 'skill_vitality' | 'export_skill';
  /** Query string passed to the tool. Must be original; no copyrighted phrasing. */
  query: string;
  /** Restrict recall to named engrams. Use template names, not user-specific IDs. */
  onlyEngrams?: string[];
  /** Only run this step if the previous step returned fewer than N nodes. */
  ifResultsBelow?: number;
}

/**
 * A named recall recipe as authored.
 * `trigger` describes in plain language when the AI should invoke this recipe.
 */
export interface AuthoredRecallRecipe {
  name: string;
  trigger: string;
  steps: AuthoredRecallStep[];
}

/**
 * A single skill within a default pack, as authored.
 *
 * `baseText` is the skill instruction text that the Skills Trainer will
 * personalize against the user's cortex. It must:
 *   - Be wholly original (no copyrighted methodology text)
 *   - Contain no trademarked framework names used prescriptively
 *   - Reference only Graphnosis MCP tools and general professional vocabulary
 *   - Use [ANCHOR] prefix on lines that must survive personalization unchanged
 *
 * `trainedTextFallback` is the human-readable version used when no local LLM
 * is available. Write this first — it is the product, not an afterthought.
 */
export interface AuthoredSkill {
  name: string;
  /** Must be 'skill' — only engram template type for trained skills. */
  engramTemplate: 'skill';
  sensitivityTier: 'personal' | 'sensitive';
  baseText: string;
  trainedTextFallback: string;
  recallRecipes: AuthoredRecallRecipe[];
  /** Optional: reference to an official pack this delta builds upon. */
  basedOn?: string;
  /** Semantic instructions for the trainer to apply during LLM personalization. */
  trainingDelta?: Array<{ section: string; instruction: string }>;
}

/**
 * A full default skill pack definition, as authored before compilation.
 *
 * `tierRequired` gates the pack on first import:
 *   'free'  — recall recipes + fallback text work without Pro
 *   'pro'   — LLM personalization of baseText requires Pro (Skills Trainer)
 *
 * `kind` determines signing behavior in build-gts.mjs:
 *   'official'  — build-gts.mjs will sign with the master Ed25519 key
 *   'community' — no signature; import UI shows "unverified" badge
 *
 * Fields stripped before compilation (never reach the .gts wire format):
 *   contentVerifiedAt, verifiedBy, contentWarnings
 */
export interface DefaultSkillPack {
  /** Stable unique identifier. Use kebab-case. Never reuse across packs. */
  id: string;
  displayName: string;
  description: string;
  /** Semantic version string, e.g. "1.0.0". */
  version: string;
  /** Author string shown in the import UI. Use "Graphnosis" for official packs. */
  author: string;
  kind: 'official' | 'community';
  tierRequired: 'free' | 'pro';
  skills: AuthoredSkill[];
  /**
   * Full GRAPHNOSIS.md content to drop into a project root.
   * build-gts.mjs can generate this from skills[].recallRecipes if omitted.
   */
  graphnosisMd?: string;

  // ── Authoring-time fields (stripped before buildGtsPackage) ──────────────

  /**
   * ISO 8601 timestamp of the last content verification pass.
   * build-gts.mjs refuses to compile if this is absent or older than 90 days.
   */
  contentVerifiedAt: string;
  /** Name or identifier of whoever ran the verification pass. */
  verifiedBy: string;
  /**
   * Any content warnings noted during verification (must be empty to compile).
   * If non-empty, build-gts.mjs will print them and abort.
   */
  contentWarnings: string[];
}

// ── Build contract ────────────────────────────────────────────────────────────

/**
 * The shape that default-skill-packs.ts (gitignored) must export.
 * build-gts.mjs imports this and validates it before calling buildGtsPackage().
 *
 * Example default-skill-packs.ts (gitignored, never committed):
 *
 *   import type { DefaultSkillPacksExport } from './default-skill-pack-types.js';
 *   export const packs: DefaultSkillPacksExport = [ ... ];
 */
export type DefaultSkillPacksExport = DefaultSkillPack[];
