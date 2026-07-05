/**
 * SkillTrainer — compile AI skills into structured Graphnosis SOPs.
 *
 * A "skill" is any AI behavior instruction: a Claude Code skill file, a system
 * prompt, a CLAUDE.md instruction block, a .cursorrules file, a ChatGPT system
 * message — anything that shapes how an AI assistant behaves.
 *
 * The training pipeline:
 *   1. Parse and chunk the authored skill source (deterministic). Train-time
 *      recall is scoped to an **empty engram** — no federated pull from coding,
 *      notes, or other personal engrams (see ENABLE_CORTEX_RECALL_AT_TRAIN).
 *   2. Optional Pro path: SOP-preserving local LLM rewrite when useLlmRewrite=true
 *      and a reachable LLM is available — polishes prose without cortex recall.
 *   3. Save the trained version into the Skills engram (in-place rewrite).
 *      Personal context belongs at walk/runtime via recallRecipes, not here.
 *
 * Subscription gate: the full training pipeline (both LLM-rewrite and memory-augmented
 * paths) requires a monthly-subscription subscription. The gate is enforced at the MCP
 * transport layer in `mcp-server.ts` via `LicenseValidator.hasFeature(token, 'skill-training')`,
 * which verifies an Ed25519-signed token issued by the Nehloo signing service. Free users
 * can store raw skills in the Skills engram but cannot run the training pipeline.
 */

import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import { isRecallRecipeParagraph, parseRecallRecipeText } from './skill-recall-bindings.js';
import {
  buildGskPackage,
  generateGraphnosisMd,
  nextGskExportVersion,
} from './gsk-format.js';
import { ingestClip } from './ingest.js';
import { SkillSnapshotStore } from './skill-snapshots.js';
import type { SkillCallLinkStore, SkillCallLink } from './skill-call-links.js';
import { settings as settingsMod } from '@graphnosis-app/core';
import {
  SKILL_SOP_REWRITE_SYSTEM_PROMPT,
  buildSopRewriteUserPrompt,
  validateSopPreservation,
} from './skill-sop-rewrite.js';

// ── Public types ─────────────────────────────────────────────────────────────

export type ExportFormat = 'claude-md' | 'cursorrules' | 'system-prompt' | 'openai' | 'raw' | 'gsk';
export type TrainingMode = 'llm' | 'memory-augmented';

export interface TrainSkillInput {
  /** The full text of the skill to personalize. */
  skill: string;
  /** Human-readable name (used as the source label in the Skills engram). */
  skillName?: string;
  /**
   * Ignored at train time (empty-engram contract). Kept for API compat with
   * MCP focus_engrams and the Skills UI focus checkboxes.
   */
  focusGraphIds?: string[] | null;
  /** Target AI tool — shapes export hints in the diff notes. */
  modelTarget?: string;
  /**
   * Whether to save the trained version into the Skills engram.
   * Default true. Pass false to get a preview without persisting.
   */
  save?: boolean;
  /** The resolved graphId of the Skills engram to write into. */
  graphId: string;
  /** MCP client name — threaded into the audit trail. */
  addedBy?: string;
  /**
   * Recall breadth (0–100). 0 = broad (maxNodes=50), 100 = exact (maxNodes=12).
   * Null = auto (reads stored breadth from skill metadata, starts at 50).
   * After each training the pipeline self-tunes this value based on cited/fetched ratio.
   */
  recallBreadth?: number | null;
  /** Structured goals — drives goal-aligned recall to surface targeted memories. */
  goals?: import('./gsk-format.js').SkillGoals;
  /**
   * Opt-in: when true, run the SOP-preserving local-LLM rewrite path — clarity
   * polish only, no personal memory woven in (empty-engram contract). Default
   * false — the trainer chunks the user's pasted text into paragraph nodes as-is.
   */
  useLlmRewrite?: boolean;
  /**
   * Opt-in: bind recall *recipes* at train time instead of the empty-engram
   * default. Runs a relevance-gated recall to find which engrams hold context
   * relevant to this skill, and emits a `recall(… only_engrams: […])` recipe
   * into the body — no frozen personal content (the skill stays portable),
   * resolved live at walk time (so it never goes stale). Default false preserves
   * the empty-engram train invariant.
   */
  bindRecipes?: boolean;
  /**
   * Optional per-skill execution-autonomy override to set AFTER the skill is
   * saved (only honored when `save !== false`). Omitted = no override is
   * written, so the skill keeps INHERITING the engram default — the empty-train
   * default. CLAMPED to the skill's authored dispatch-safe cap; a requested
   * level above the cap is lowered to the cap and surfaced via
   * `TrainSkillResult.autonomyNote`. Stored in graph metadata
   * (`skillAutonomyLevels[sourceId]`), not the skill body, so it survives
   * future retraining.
   */
  autonomyLevel?: import('@graphnosis-app/core/settings').ExecutionAutonomyLevel;
}

export interface InfluentialNode {
  nodeId: string;
  graphId: string;
  score: number;
  /** First 120 characters of the node text. */
  preview: string;
  /** Human-readable source name (file name, URL hostname, or clip label). */
  sourceLabel?: string;
  /** Where this node came from in the recall pipeline. */
  layer?: 'anchored' | 'gnn-expanded' | 'semantic';
  /** Which goal dimension this node matched, if any. */
  goalAlignment?: 'success' | 'scope' | 'completion';
}

/**
 * Pre-computed recall context for a skill — the deterministic Phase 1 output.
 * Separating this from the LLM rewrite step lets the UI show which memories
 * will be used before committing to a potentially slow training run.
 */
export interface SkillContext {
  /** Full rich knowledge subgraph (DIRECTED/UNDIRECTED/SESSION SUMMARIES preserved). */
  subgraph: string;
  /** Ranked influential nodes with source labels. */
  influentialNodes: InfluentialNode[];
  tokenCount: number;
  nodeCount: number;
}

/**
 * Autonomous re-training schedule stored in the skill node's metadata.
 * Written on save; read by the scheduler to decide when to retrain.
 */
export interface AutoRetrainConfig {
  enabled: boolean;
  trigger: 'scheduled' | 'cortex-growth' | 'vitality-decay' | 'hybrid';
  /** For 'scheduled' and 'hybrid': retrain interval in milliseconds. */
  intervalMs?: number;
  /** For 'cortex-growth': retrain when this many new nodes have been added. */
  cortexGrowthThreshold?: number;
  /** For 'vitality-decay': retrain when vitality drops below this score. */
  vitalityThreshold?: number;
  /** 'notify' = draft + notification; 'auto-accept' = promote automatically; 'preview-first' = show cortex diff first. */
  autonomyLevel: 'notify' | 'auto-accept' | 'preview-first';
  lastAutoRetrain?: string;
  nextScheduled?: string;
}

export interface TrainSkillResult {
  original: string;
  trained: string;
  /** LLM-authored diff notes, one bullet per change. Only present in 'llm' mode. */
  diffNotes?: string;
  /** Top nodes from the user's cortex that influenced the personalization. */
  influentialNodes: InfluentialNode[];
  mode: TrainingMode;
  /** sourceId of the saved skill version in the Skills engram (if save=true). */
  skillId?: string;
  /** Explanation when mode='memory-augmented' (no LLM available). */
  degradedNote?: string;
  /**
   * Set when an `autonomyLevel` was requested and a skill was saved: reports the
   * applied per-skill autonomy level, including a clamp note when the request
   * exceeded the authored dispatch-safe cap. Absent when no override was asked
   * for (or the skill wasn't saved).
   */
  autonomyNote?: string;
}

export interface SkillVitalityResult {
  /** 0–100. 100 = just trained, fully fresh. Drops as influential memories evolve. */
  score: number;
  trainedAt?: number;
  /** How many of the skill's own graph nodes have been soft-deleted since training. */
  staleNodesCount: number;
  /** Sub-score breakdown — points subtracted from 100 — so callers can show the
   *  user WHY a skill is aging and what would help (retrain clears age+staleness). */
  agePenalty?: number;
  stalenessPenalty?: number;
  citedDriftPenalty?: number;
  /** Total cited memory nodes bound via recall recipes. */
  citedNodesCount?: number;
  /** Cited memory nodes that were edited, forgotten, or are missing from cortex. */
  missingCitedNodesCount?: number;
  /** True when recall-recipe bindings no longer match live cortex. */
  driftDetected?: boolean;
  /** Human-readable recommendation based on the score. */
  recommendation: string;
}

export interface SkillProvenance {
  /** 'official' = signed by Graphnosis (or other future trusted authors).
   *  'community' = unsigned, anyone could have authored it. */
  kind: 'official' | 'community';
  /** True when the Ed25519 signature on the imported .gsk pack verified
   *  against the trusted public key. Always false for community packs. */
  verified: boolean;
  /** Author string carried in the .gsk pack at build time. */
  author: string;
  /** Source pack id and version, useful for change tracking and re-import. */
  packId?: string;
  packVersion?: string;
  /** Upstream pack this skill was derived from (delta / re-export lineage). */
  upstreamPackId?: string;
  importedAt?: string;
}

export interface SkillListEntry {
  sourceId: string;
  graphId: string;
  engramName: string;
  label: string;
  ingestedAt: number;
  nodeCount: number;
  trainedAt?: string;
  mode?: string;
  recallBreadth?: number;
  /** Concatenated node previews for keyword search (title/trigger/body). */
  searchPreview?: string;
  /** Present only for skills imported from a .gsk pack (parsed from the
   *  imported-provenance node written by skill:importGsk). Locally-trained
   *  skills have no provenance entry. */
  provenance?: SkillProvenance;
}

export interface SkillDetail extends SkillListEntry {
  text: string;
  /** Parsed goals from the stored text, if present. */
  goals?: import('./gsk-format.js').SkillGoals;
}

export interface SkillVersionEntry {
  /** sourceId is the same across every version of a given skill —
   *  history now lives in side-table snapshots, not in sibling sources. */
  sourceId: string;
  /** Identifier of the on-disk snapshot. Empty string means "this entry
   *  represents the current live source, not a snapshot" — exactly one
   *  entry per skill carries the empty value. */
  snapshotId: string;
  label: string;
  ingestedAt: number;
  nodeCount: number;
  isCurrent: boolean;
  trainedAt?: string;
  mode?: string;
}

// ── LLM prompts ──────────────────────────────────────────────────────────────

const SKILL_TRAINING_SYSTEM_PROMPT = `\
You are a skill personalization engine for Graphnosis.

Your task: rewrite the provided AI skill/instruction to better match the user's
specific working style, preferences, and context — as revealed by their personal
memory notes below.

Rules:
1. Preserve the skill's core purpose and overall structure.
2. Only change what the memories support — do NOT invent preferences not in the notes.
3. After each personalized line or paragraph, add a brief parenthetical: (from memory: "source label · date")
4. If a memory contradicts the skill, emit a conflict flag on its own line:
   ⚠️ CONFLICT: [skill says X | memory says Y]
5. Any line in the skill prefixed with [ANCHOR] must be preserved exactly as-is.
   Do not modify, paraphrase, or move anchored lines.
6. If the skill includes a ## Goals section, personalise TOWARD the stated success
   criteria and AWAY from anything listed as out of scope. Goal-aligned memories
   (tagged "goal-aligned") carry extra weight — prefer them when resolving conflicts.
7. Keep the output in the same format as the input (markdown stays markdown,
   plain prose stays plain prose, etc.).

After the full rewritten skill, emit exactly this separator on its own line:
=== DIFF NOTES ===
Then list one bullet per change, each citing the memory passage that drove it.
Example:
- Changed tone to "direct and concise": your note "I hate long-winded explanations" (Jun 2025)
- Added TypeScript as primary language: your preference from Dev Decisions engram

If no memories are relevant enough to justify any change, output the original
skill unchanged, then:
=== DIFF NOTES ===
- No changes made — no memories were relevant enough to warrant personalization.`;

// ── Format templates ──────────────────────────────────────────────────────────

const FORMAT_HEADERS: Record<ExportFormat, string> = {
  'claude-md': `<!-- Trained Graphnosis skill — add to your project's CLAUDE.md -->`,
  'cursorrules': `# Graphnosis-trained rule — add to .cursorrules`,
  'system-prompt': `<!-- Graphnosis-trained system prompt -->`,
  'openai': `<!-- Graphnosis-trained OpenAI system message -->`,
  'raw': '',
  'gsk': '',
};

const FORMAT_WRAPPERS: Partial<Record<ExportFormat, (text: string) => string>> = {
  'openai': (text) =>
    `{"role": "system", "content": ${JSON.stringify(text)}}`,
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildTrainingUserPrompt(
  skill: string,
  memoriesPrompt: string,
  skillName?: string,
  modelTarget?: string,
  goals?: import('./gsk-format.js').SkillGoals,
): string {
  const lines: string[] = [];
  if (skillName) lines.push(`Skill name: ${skillName}`);
  if (modelTarget) lines.push(`Target AI: ${modelTarget}`);
  if (goals) {
    lines.push('');
    lines.push('=== SKILL GOALS ===');
    if (goals.successLooksLike) lines.push(`Success looks like: ${goals.successLooksLike}`);
    if (goals.outOfScope)       lines.push(`Out of scope: ${goals.outOfScope}`);
    if (goals.expectedOnCompletion) lines.push(`Expected on completion: ${goals.expectedOnCompletion}`);
  }
  lines.push('');
  lines.push('=== ORIGINAL SKILL ===');
  lines.push(skill);
  lines.push('');
  lines.push('=== YOUR MEMORIES ===');
  lines.push(memoriesPrompt.slice(0, 3000));
  lines.push('');
  lines.push('Rewrite the skill to match the user\'s personal style and preferences, honouring the Goals above.');
  return lines.join('\n');
}

function parseTrainingResult(
  original: string,
  raw: string,
): { trained: string; diffNotes: string } {
  const sep = '=== DIFF NOTES ===';
  const idx = raw.indexOf(sep);
  if (idx === -1) {
    // LLM didn't follow the format — return as-is, no diff notes
    return { trained: raw.trim() || original, diffNotes: '' };
  }
  return {
    trained: raw.slice(0, idx).trim() || original,
    diffNotes: raw.slice(idx + sep.length).trim(),
  };
}

/**
 * Phase 3b: returns an ARRAY of plain-text paragraphs (no markdown), one
 * paragraph per recalled memory. The caller iterates and inserts each as a
 * `role: 'recalled-memory'` chunk via `insertNodeAt`.
 *
 * No more `## Personal Context` heading — attribution lives inline at the
 * end of each paragraph as `_(from X)_`. The export-time formatter is the
 * only place that decides on markdown decoration.
 */
function buildMemoryAugmented(memoriesPrompt: string): string[] {
  // Strip the raw audit footer (--- \nAttached N ...) from the memory block.
  const auditSepIdx = memoriesPrompt.lastIndexOf('\n\n---\n');
  const cleanMemories = auditSepIdx !== -1
    ? memoriesPrompt.slice(0, auditSepIdx).trim()
    : memoriesPrompt.trim();
  if (!cleanMemories) return [];
  // Split on blank-line boundaries — every recalled paragraph becomes its
  // own chunk. Filter empties; preserve original phrasing. Tag each with the
  // attribution marker the structured parser (RECALLED_MARKER_RE) uses to
  // recognise context nodes, so memory-augmented recalls are never
  // mis-classified as procedure steps.
  return cleanMemories.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `${p}\n_(from cortex recall)_`);
}

/**
 * Skill train recall contract.
 *
 * Training/retraining must NOT federate into the user's personal cortex.
 * Skills stay portable SOPs grounded in authored source text (+ parsed
 * structure saved into the Skills engram). MCP train_skill, IPC skill:train,
 * autoretrain, and UI preview all share this gate via buildSkillContext().
 *
 * Personal memory augmentation belongs at walk/runtime (recallRecipes), not
 * at compile/train time — otherwise unrelated nodes pollute skill bodies.
 */
const ENABLE_CORTEX_RECALL_AT_TRAIN = false;

// ── Breadth helpers ───────────────────────────────────────────────────────────

/**
 * Map a 0–100 recallBreadth value to concrete recall budget parameters.
 * 0 = broad (many nodes, wide context), 100 = exact (few, high-precision).
 */
function breadthToBudget(breadth: number): { maxTokens: number; maxNodes: number } {
  const t = Math.max(0, Math.min(100, breadth)) / 100;
  return {
    maxTokens: Math.round(6000 - (6000 - 1200) * t),
    maxNodes:  Math.round(50   - (50   - 12)   * t),
  };
}

/**
 * After a training run, nudge the stored recallBreadth based on how many of the
 * fetched nodes were actually cited (appeared in the trained output).
 * Low utilization → breadth was too wide → increase (fewer nodes next time).
 * High utilization → breadth was too narrow → decrease (more nodes next time).
 */
function nudgeBreadth(current: number, fetchedNodes: number, citedNodes: number): number {
  if (fetchedNodes === 0) return current;
  const citedRatio = citedNodes / fetchedNodes;
  let next = current;
  if (citedRatio < 0.15) next = current + 10;
  else if (citedRatio > 0.80) next = current - 10;
  return Math.max(10, Math.min(90, next));
}

/**
 * Infer which layer a node came from based on its score.
 * ANCHOR_SCORE = 99, GNN_EXPANSION_SCORE = 1.5 (from host.ts constants).
 * Regular semantic nodes score in [0, 1].
 */
function inferNodeLayer(score: number): 'anchored' | 'gnn-expanded' | 'semantic' {
  if (score >= 90) return 'anchored';
  if (score > 1.0) return 'gnn-expanded';
  return 'semantic';
}

// ── SkillTrainer ──────────────────────────────────────────────────────────────

export class SkillTrainer {
  /**
   * @param host  Live GraphnosisHost (recall + ingest access).
   * @param llm   Local LLM instance, or null when none is available / capability
   *              is disabled. Pass `deps.llm('distillation')` from the MCP layer.
   */
  constructor(
    private readonly host: GraphnosisHost,
    private readonly llm: LocalLlm | null,
  ) {}

  // ── buildSkillContext ────────────────────────────────────────────────────────

  /**
   * Phase 1 (deterministic): recall context preview for a skill.
   *
   * Under the empty-engram train contract (ENABLE_CORTEX_RECALL_AT_TRAIN=false),
   * returns an empty context — no nodes from personal engrams. All train
   * entry points (MCP, IPC, autoretrain, UI buildContext preview) share this.
   *
   * `recallBreadth` = null reads the stored value from skill metadata (or starts
   * at 50 on first use). Pass 0–100 to override. Ignored when recall is disabled.
   */
  async buildSkillContext(
    skill: string,
    graphId: string,
    focusGraphIds?: string[] | null,
    recallBreadth?: number | null,
    goals?: import('./gsk-format.js').SkillGoals,
  ): Promise<SkillContext> {
    if (!ENABLE_CORTEX_RECALL_AT_TRAIN) {
      void skill;
      void graphId;
      void focusGraphIds;
      void recallBreadth;
      void goals;
      return {
        subgraph: '',
        influentialNodes: [],
        tokenCount: 0,
        nodeCount: 0,
      };
    }

    const effectiveBreadth = recallBreadth ?? 50;
    const { maxTokens, maxNodes } = breadthToBudget(effectiveBreadth);

    const recalled = await this.host.recall(skill, {
      budget: { maxTokens, maxNodes },
      ...(focusGraphIds?.length ? { onlyGraphIds: focusGraphIds } : {}),
    });

    // Build nodeId → source label reverse map across all relevant graphs.
    const nodeToSource = new Map<string, string>();
    const graphsToScan = focusGraphIds ?? this.host.listGraphs();
    for (const gid of graphsToScan) {
      try {
        const sources = this.host.listSources(gid);
        for (const src of sources) {
          // Derive a human-readable label: filename from a file path, hostname
          // from a URL, or clip ID fragment as a last resort.
          // skill / clip / ai-conversation refs are stored as "{kind}:{ts}:{label}"
          // by ingestClip — strip the prefix so only the human name appears.
          const label = src.ref
            ? (/^(?:skill|clip|ai-conversation):\d+:/.test(src.ref)
                ? src.ref.replace(/^(?:skill|clip|ai-conversation):\d+:/, '')
                : src.ref.includes('/') ? src.ref.split('/').pop() ?? src.ref
                : src.ref.startsWith('http') ? new URL(src.ref).hostname
                : src.ref)
            : src.sourceId.slice(0, 12);
          for (const nid of src.nodeIds) {
            nodeToSource.set(nid, label);
          }
        }
      } catch { /* graph not yet loaded — skip */ }
    }

    const influentialNodes: InfluentialNode[] = [];
    for (const [gid, nodes] of recalled.byGraph) {
      for (const node of nodes) {
        const sourceLabel = nodeToSource.get(node.nodeId);
        influentialNodes.push({
          nodeId: node.nodeId,
          graphId: gid,
          score: node.score,
          preview: node.text.slice(0, 120),
          ...(sourceLabel !== undefined ? { sourceLabel } : {}),
          layer: inferNodeLayer(node.score),
        });
      }
    }
    influentialNodes.sort((a, b) => b.score - a.score);

    // ── Goal-aligned recall ────────────────────────────────────────────────────
    // For each goal dimension (success / scope / completion), run a focused
    // recall query and tag matching nodes so the UI can surface them separately
    // from general context. Goal-aligned memories are particularly high-value
    // because they directly speak to what the skill is trying to achieve —
    // they should guide personalization more than general context nodes.
    if (goals) {
      const goalDimensions: Array<{ query: string; alignment: NonNullable<InfluentialNode['goalAlignment']> }> = [];
      if (goals.successLooksLike) {
        goalDimensions.push({
          query: `${goals.successLooksLike} success outcome achieved`,
          alignment: 'success',
        });
      }
      if (goals.outOfScope) {
        goalDimensions.push({
          query: `${goals.outOfScope} boundary limit out of scope`,
          alignment: 'scope',
        });
      }
      if (goals.expectedOnCompletion) {
        goalDimensions.push({
          query: `${goals.expectedOnCompletion} completion deliverable result`,
          alignment: 'completion',
        });
      }

      const goalNodeBudget = { maxTokens: 800, maxNodes: 4 };
      const seenNodeIds = new Set(influentialNodes.map((n) => n.nodeId));

      for (const dim of goalDimensions) {
        try {
          const goalRecalled = await this.host.recall(dim.query, {
            budget: goalNodeBudget,
            ...(focusGraphIds?.length ? { onlyGraphIds: focusGraphIds } : {}),
          });
          for (const [gid, nodes] of goalRecalled.byGraph) {
            for (const node of nodes) {
              if (seenNodeIds.has(node.nodeId)) {
                // Already in the list — upgrade its goalAlignment tag
                const existing = influentialNodes.find((n) => n.nodeId === node.nodeId);
                if (existing && !existing.goalAlignment) {
                  existing.goalAlignment = dim.alignment;
                }
              } else {
                seenNodeIds.add(node.nodeId);
                const sourceLabel = nodeToSource.get(node.nodeId);
                influentialNodes.push({
                  nodeId: node.nodeId,
                  graphId: gid,
                  score: node.score,
                  preview: node.text.slice(0, 120),
                  ...(sourceLabel !== undefined ? { sourceLabel } : {}),
                  layer: inferNodeLayer(node.score),
                  goalAlignment: dim.alignment,
                });
              }
            }
          }
        } catch { /* goal recall failure is non-fatal — training still proceeds */ }
      }

      // Re-sort so goal-aligned nodes (high signal) float up alongside anchored nodes.
      influentialNodes.sort((a, b) => {
        if (a.goalAlignment && !b.goalAlignment) return -1;
        if (!a.goalAlignment && b.goalAlignment) return 1;
        return b.score - a.score;
      });
    }

    return {
      subgraph: recalled.prompt,
      influentialNodes,
      tokenCount: recalled.tokensUsed,
      nodeCount: recalled.nodesIncluded,
    };
  }

  // ── trainSkill ──────────────────────────────────────────────────────────────

  /**
   * Opt-in (bindRecipes): derive a relevance-gated recall recipe block for a
   * skill. Recalls the user's NON-skill engrams with a query built from the
   * skill title, keeps engrams holding a hit at/above the relevance floor, and
   * returns a recipe paragraph (`Personal context: …` / `- recall: … only_engrams: [...]`).
   * Returns null when the skill already has a recipe, or nothing is relevant.
   * Emits a binding (query + engram names), never frozen personal content.
   */
  private async deriveRecallRecipeBlock(
    skill: string,
    graphId: string,
    skillName: string | undefined,
    recallBreadth: number,
  ): Promise<string | null> {
    const paras = skill.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    if (paras.some((p) => isRecallRecipeParagraph(p))) return null;
    const title = extractSkillTitle(skill) || skillName || 'this skill';
    const query = `${title} prior context decisions preferences`.replace(/\s+/g, ' ').trim();
    const candidates = this.host.listGraphs().filter((g) => g !== graphId && !/skill/i.test(g));
    if (candidates.length === 0) return null;
    const { maxTokens, maxNodes } = breadthToBudget(recallBreadth);
    let recalled: Awaited<ReturnType<GraphnosisHost['recall']>>;
    try {
      recalled = await this.host.recall(query, { budget: { maxTokens, maxNodes }, onlyGraphIds: candidates });
    } catch {
      return null;
    }
    const RELEVANCE_FLOOR = 0.78;
    const engrams: string[] = [];
    for (const [gid, nodes] of recalled.byGraph) {
      if (!engrams.includes(gid) && nodes.some((n) => n.score >= RELEVANCE_FLOOR)) engrams.push(gid);
    }
    if (engrams.length === 0) return null;
    const list = engrams.map((g) => `"${g}"`).join(', ');
    return `Personal context: ${title}\n- recall: ${query} only_engrams: [${list}]`;
  }

  async trainSkill(input: TrainSkillInput & {
    /** Streaming callback for live progressive diff. When provided AND the
     *  underlying LLM supports `completeStream`, the trainer streams the
     *  LLM rewrite token-by-token. The caller (IPC handler) typically
     *  forwards each chunk to the desktop over broadcastRaw so the user
     *  can watch the rewrite arrive in real time. Memory-augmented mode
     *  doesn't stream — it's a deterministic local synthesis. */
    onChunk?: (chunk: string) => void;
    /** Per-operation status callback. Fires once at the start of each phase of
     *  the training run with a short, generic, NON-sensitive label (no skill
     *  name, engram name, or memory content) so the caller can surface it in
     *  the UI status bar. The skill name, if the UI chooses to show it, is the
     *  caller's responsibility to add and to redact in Presentation Mode. */
    onStatus?: (label: string) => void;
  }): Promise<TrainSkillResult> {
    const {
      skillName,
      focusGraphIds,
      modelTarget,
      save = true,
      graphId,
      addedBy,
      recallBreadth: inputBreadth,
      onChunk,
      onStatus,
    } = input;
    // Mutable so the opt-in recipe-binding pass (below) can prepend a recall
    // recipe before parsing. Defaults to the verbatim authored text.
    let skill = input.skill;

    // Phase 3b — wrap the whole training run in the overlay-recompute guard
    // so the GNN edge-prediction loop and the LLM edge-prediction loop don't
    // write predictions against the half-built skill source mid-train. The
    // `finally` block guarantees the flag is cleared even if the LLM rewrite
    // throws.
    this.host.setSkipOverlayRecompute(true);
    try {
    // ── Phase 1: Build skill context (empty train-time recall scope) ──────────
    onStatus?.('Structuring skill from source…');
    const effectiveBreadth = inputBreadth ?? 50;
    // Opt-in recipe-binding: bind relevant engrams as a recall RECIPE (not frozen
    // content) so the body stays clean, portable, and fresh. Default-off path is
    // the empty-engram contract.
    if (input.bindRecipes) {
      onStatus?.('Binding recall recipes from cortex…');
      const recipe = await this.deriveRecallRecipeBlock(skill, graphId, skillName, effectiveBreadth);
      if (recipe) skill = insertRecipeBeforeFirstStep(skill, recipe);
    }
    const context = await this.buildSkillContext(skill, graphId, focusGraphIds, effectiveBreadth, input.goals);
    const topNodes = context.influentialNodes.slice(0, 10);

    // ── Phase 2: Personalize ──────────────────────────────────────────────────
    const hasMemories = context.nodeCount > 0;
    // Relevance gate (default-clean): only fold recalled memories into a skill
    // when at least one is genuinely on-topic — goal-aligned, or scoring at or
    // above the relevance floor. A procedural SOP whose cortex holds no matching
    // notes recalls only tangential, low-score nodes; gating them out keeps the
    // skill pure authored text instead of polluting it with unrelated memory
    // nodes. Applies to both the LLM-rewrite and memory-augmented paths, so the
    // LLM never gets junk context to confabulate around either.
    const RELEVANCE_FLOOR = 0.78;
    const hasRelevantMemories = hasMemories && context.influentialNodes.some(
      (n) => n.goalAlignment !== undefined || n.score >= RELEVANCE_FLOOR,
    );
    let trained: string;
    let diffNotes: string | undefined;
    let mode: TrainingMode;
    let degradedNote: string | undefined;
    // Paragraph-list of recalled memories (memory-augmented path). Each
    // paragraph becomes its own `role: 'recalled-memory'` chunk on save.
    let recalledParagraphs: string[] = [];

    // OPT-IN: SOP-preserving LLM rewrite — off by default. Desktop UI exposes
    // an advanced checkbox; MCP callers pass useLlmRewrite=true explicitly.
    const wantsLlmRewrite = input.useLlmRewrite === true;
    const llmReady = wantsLlmRewrite && this.llm !== null && await this.pingLlm();

    if (llmReady) {
      // SOP-preserving rewrite — no memory context (empty-engram contract).
      onStatus?.('Polishing skill structure with local LLM…');
      try {
        const raw = await this.llmCompleteWithTimeout(
          {
            system: SKILL_SOP_REWRITE_SYSTEM_PROMPT,
            user: buildSopRewriteUserPrompt(skill, skillName, modelTarget, input.goals),
          },
          onChunk && this.llm?.completeStream ? 5 * 60 * 1000 : 20_000,
          onChunk,
        );
        const parsed = parseTrainingResult(skill, raw);
        const preservation = validateSopPreservation(skill, parsed.trained);
        if (!preservation.ok) {
          trained = skill;
          diffNotes = undefined;
          mode = 'memory-augmented';
          degradedNote =
            `LLM rewrite dropped SOP markers (${preservation.missing.slice(0, 3).join('; ')}` +
            `${preservation.missing.length > 3 ? '…' : ''}). Kept original text.`;
        } else {
          trained = parsed.trained;
          diffNotes = parsed.diffNotes;
          mode = 'llm';
        }
      } catch (err) {
        trained = skill;
        mode = 'memory-augmented';
        degradedNote =
          `Local LLM rewrite failed (${(err as Error).message}). Kept original skill text.`;
      }
    } else if (wantsLlmRewrite && !llmReady) {
      trained = skill;
      mode = 'memory-augmented';
      degradedNote =
        'Local LLM is not enabled or unreachable. Enable distillation in Settings → Local LLM, ' +
        'or leave "Polish with local LLM" unchecked for fast chunk-and-save.';
    } else if (!llmReady && hasRelevantMemories) {
      // No LLM — append memories as context paragraphs (saved as separate
      // 'recalled-memory' chunks below; the joined `trained` string is just
      // the preview the caller renders).
      onStatus?.('Synthesizing from your memories…');
      recalledParagraphs = buildMemoryAugmented(context.subgraph);
      trained = recalledParagraphs.length > 0
        ? `${skill}\n\n${recalledParagraphs.join('\n\n')}`
        : skill;
      mode = 'memory-augmented';
      degradedNote =
        hasMemories
          ? 'Local LLM is not enabled. Relevant memories have been appended as a ' +
            '"Personal Context" block. Enable the Local LLM in Graphnosis ' +
            '(Foresight → Local LLM) for full skill rewriting with change attribution.'
          : undefined;
    } else {
      // Expected default: source-only compile (empty train-time recall scope).
      trained = skill;
      mode = 'memory-augmented';
      degradedNote = undefined;
    }

    // ── Self-tune recallBreadth ────────────────────────────────────────────────
    // Count cited nodes: (from memory: occurrences in LLM output, or all fetched in augmented mode.
    const citedNodes = mode === 'llm'
      ? (trained.match(/\(from memory:/g) ?? []).length
      : context.nodeCount;
    const tunedBreadth = nudgeBreadth(effectiveBreadth, context.nodeCount, citedNodes);

    // ── Phase 3: Save trained version (in-place rewrite) ────────────────────
    // Retrains REUSE the existing skill source: same sourceId, same place in
    // the engram's source index, cross-source `skill:calls` edges from other
    // skills still resolve. Before mutating, the source's pre-retrain state
    // is captured to an encrypted snapshot file under
    //   <cortexDir>/skill-snapshots/<graphId>/<sourceId>/<ts>.json.enc
    // — that's what powers `skill_history` and `rollback_skill`.
    //
    // Old model (replaced): every retrain created a NEW source with a fresh
    // sourceId, leaving the prior source(s) alongside it. After a few
    // retrains the graph carried 4+ separate "Skill X (trained YYYY-MM-DD)"
    // sources with orphaned metadata/title nodes drawn as red islands in
    // the atlas. The new model collapses to one source per skill.
    let skillId: string | undefined;
    let autonomyNote: string | undefined;
    if (save) {
      onStatus?.('Saving the trained skill…');
      const dateStr = new Date().toISOString().slice(0, 10);
      const label = skillName
        ? `${skillName} (trained ${dateStr})`
        : `Trained skill (${dateStr})`;
      const baseName = baseSkillName(label);
      // Normalized key so an innocent slug-vs-title-case difference in the
      // passed skill_name (e.g. "enterprise-compliance-lens" vs the stored
      // "Enterprise Compliance Lens") still matches the existing source for an
      // in-place retrain instead of silently forking a duplicate.
      const baseNameKey = skillNameMatchKey(baseName);

      const metadataComment = [
        `<!-- Graphnosis skill training metadata`,
        `     trainedAt: ${new Date().toISOString()}`,
        `     mode: ${mode}`,
        `     influentialNodes: ${topNodes.length}`,
        `     modelTarget: ${modelTarget ?? 'generic'}`,
        `     recallBreadth: ${tunedBreadth}`,
        `-->`,
      ].join('\n');

      // Body paragraphs come from the LLM output (LLM mode) or the user's
      // original skill text (memory-augmented mode). Recalled memories are
      // separately tracked in recalledParagraphs.
      const bodySource = mode === 'llm' ? trained : skill;
      // Goal-header robustness: split any single semicolon-joined goal-header
      // line (Trigger: …; Prerequisites: …; …) into one line per goal field
      // BEFORE paragraph sectioning, so each field becomes its own chunk and is
      // classified into its goal role. No-op for headers already one-per-line and
      // for ordinary step text (see normalizeInlineGoalHeader). Re-split on the
      // blank lines it introduces so the new fields become distinct paragraphs.
      const bodyParagraphs = normalizeInlineGoalHeader(bodySource)
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);

      // ── Strip a slug-only first body line ────────────────────────────────
      // Some SOPs lead with a junk line that is just the skill's kebab slug
      // (e.g. "sponsor-and-vendor-negotiation") on its own, with no goal prefix
      // and no leading step number. The title node already carries the name, so
      // that line is duplicative — drop it before sectioning so it doesn't
      // become its own node. Only the very first physical body line is checked,
      // and only when it matches the skill's normalized slug exactly.
      if (bodyParagraphs.length > 0) {
        const firstPara = bodyParagraphs[0]!;
        const firstLine = firstPara.split('\n')[0]!.trim();
        const isSlugOnly =
          !!firstLine &&
          !GOAL_NODE_RE.test(firstLine) &&
          !/^\s*\d+\.\s/.test(firstLine) &&
          skillNameMatchKey(firstLine) === baseNameKey &&
          baseNameKey.length > 0;
        if (isSlugOnly) {
          const rest = firstPara.split('\n').slice(1).join('\n').trim();
          if (rest) bodyParagraphs[0] = rest;
          else bodyParagraphs.shift();
        }
      }

      // ── Ingest metadata comment + title + body paragraphs ─────────────────
      // Recalled-memory paragraphs are handled separately below (Phase 2:
      // position-aware placement into the SOP sequence).
      //
      // Goal-category paragraphs authored INLINE in the skill text (e.g. a
      // "Trigger: …" or "Success: …" line) are pulled out of the body so they
      // join the structured goal block as a top meta-header — otherwise they
      // stay scattered among the numbered steps and the Trained Output editor
      // shows a jumbled 1,2,a,3,b… gutter. Position is presentational: walk_skill
      // and export both extract goals by category, so regrouping is safe.
      const goalRoleForLine = (line: string): string | null => {
        const t = line.trim();
        if (/^Success:\s/i.test(t)) return 'goal-success';
        if (/^Out of scope:\s/i.test(t)) return 'goal-scope';
        if (/^On completion:\s/i.test(t)) return 'goal-done';
        if (/^Trigger:\s/i.test(t)) return 'goal-trigger';
        if (/^Prerequisites:\s/i.test(t)) return 'goal-prereq';
        if (/^On failure:\s/i.test(t)) return 'goal-failure';
        if (/^Requires:\s/i.test(t)) return 'goal-requires';
        if (/^Produces:\s/i.test(t)) return 'goal-produces';
        return null;
      };
      // Split each paragraph at goal-LINE boundaries — not just whole-paragraph
      // — so goal lines mashed INTO a step paragraph (no blank line separating
      // them, e.g. a step followed by "Produces: …\nSuccess: …") still separate
      // out into their own goal chunks. Each goal-prefixed line becomes its own
      // goal chunk; runs of consecutive non-goal lines stay grouped as one body
      // chunk. A line that continues a goal onto a second physical line stays
      // with the body run after it, which is acceptable — these skills author
      // each goal on a single line.
      const bodySections: Array<{ role: string; text: string }> = [];
      const inlineGoalSections: Array<{ role: string; text: string }> = [];
      for (const p of bodyParagraphs) {
        let bodyRun: string[] = [];
        const flushBodyRun = (): void => {
          const text = bodyRun.join('\n').trim();
          if (text) {
            // A run gathered between goal lines may itself contain several
            // semantic units (numbered steps / bullets) that were authored with
            // only single newlines between them. Split it so each becomes its
            // own node — the single-node guarantee then applies per step.
            for (const unit of splitBodyRunIntoUnits(bodyRun)) {
              bodySections.push({
                role: isRecallRecipeParagraph(unit) ? 'recipe' : 'body',
                text: unit,
              });
            }
          }
          bodyRun = [];
        };
        for (const line of p.split('\n')) {
          const goalRole = goalRoleForLine(line);
          if (goalRole) {
            flushBodyRun();
            inlineGoalSections.push({ role: goalRole, text: line.trim() });
          } else {
            bodyRun.push(line);
          }
        }
        flushBodyRun();
      }
      // All 8 goal categories. Must mirror the .gsk import path. Earlier
      // versions only emitted the original 3 (Success / Out of scope / On
      // completion), silently dropping Trigger / Prerequisites / On failure /
      // Requires / Produces even when the form passed them.
      const goalSections: Array<{ role: string; text: string }> = [];
      if (input.goals?.successLooksLike)
        goalSections.push({ role: 'goal-success', text: `Success: ${input.goals.successLooksLike}` });
      if (input.goals?.outOfScope)
        goalSections.push({ role: 'goal-scope', text: `Out of scope: ${input.goals.outOfScope}` });
      if (input.goals?.expectedOnCompletion)
        goalSections.push({ role: 'goal-done', text: `On completion: ${input.goals.expectedOnCompletion}` });
      if (input.goals?.trigger)
        goalSections.push({ role: 'goal-trigger', text: `Trigger: ${input.goals.trigger}` });
      if (input.goals?.prerequisites)
        goalSections.push({ role: 'goal-prereq', text: `Prerequisites: ${input.goals.prerequisites}` });
      if (input.goals?.onFailure)
        goalSections.push({ role: 'goal-failure', text: `On failure: ${input.goals.onFailure}` });
      if (input.goals?.requires)
        goalSections.push({ role: 'goal-requires', text: `Requires: ${input.goals.requires}` });
      if (input.goals?.produces)
        goalSections.push({ role: 'goal-produces', text: `Produces: ${input.goals.produces}` });

      // ── Find existing source for this skill (in-place retrain detection) ──
      // Match by base name (label minus the `(trained YYYY-MM-DD)` suffix)
      // across all skill sources in this engram. There SHOULD be at most one
      // per name; if there are duplicates from before the in-place model
      // shipped, pick the most recent and forget the older leftovers below.
      const allSkillSources = this.host.listSources(graphId).filter((s) => s.kind === 'skill');
      const matchingSkills = allSkillSources
        .filter((s) => skillNameMatchKey(s.ref) === baseNameKey)
        .sort((a, b) => b.ingestedAt - a.ingestedAt);
      const existingSource = matchingSkills[0];
      let inPlaceRenameRef: string | undefined;

      // Snapshot + clear before in-place mutation.
      if (existingSource) {
        // Capture every live node's content + role into the snapshot file.
        // Soft-deleted nodes are excluded so a rollback recreates only the
        // user-visible state.
        const now = Date.now();
        const nodeMap = new Map(this.host.listNodes(graphId).map((n) => [n.id, n]));
        const liveNodes: Array<{ content: string; role?: string }> = [];
        let snapTrainedAt: string | undefined;
        let snapMode: 'llm' | 'memory-augmented' | undefined;
        for (const nid of existingSource.nodeIds) {
          const meta = nodeMap.get(nid);
          if (!meta) continue;
          if (meta.confidence <= 0.2) continue;
          if (meta.validUntil !== undefined && meta.validUntil <= now) continue;
          const content = this.host.getFullNodeContent(graphId, nid) ?? '';
          if (!content) continue;
          liveNodes.push({ content });
          // Pre-extract trainedAt + mode from the metadata-comment node so the
          // history UI can render the snapshot summary without decrypting the
          // whole `nodes[]` array.
          if (content.trimStart().startsWith('<!--')) {
            const parsed = parseSkillMetadata(content);
            if (parsed.trainedAt !== undefined) snapTrainedAt = parsed.trainedAt;
            if (parsed.mode === 'llm' || parsed.mode === 'memory-augmented') snapMode = parsed.mode;
          }
        }
        const snapshotTs = Date.now();
        const snapshotId = SkillSnapshotStore.idFromTs(snapshotTs);
        inPlaceRenameRef = `skill:${snapshotTs}:${baseName}`;
        await this.host.skillSnapshots.append(graphId, {
          snapshotId,
          ts: snapshotTs,
          sourceId: existingSource.sourceId,
          ref: existingSource.ref,
          label: existingSource.ref.replace(/^skill:\d+:/, ''),
          ...(snapTrainedAt !== undefined ? { trainedAt: snapTrainedAt } : {}),
          ...(snapMode !== undefined ? { mode: snapMode } : {}),
          nodes: liveNodes,
        });

        // Migration: clean up older duplicate sources from pre-in-place model.
        // Their content has already migrated forward (we kept the most recent
        // as `existingSource`); the older ones are dead weight in the atlas.
        for (const dup of matchingSkills.slice(1)) {
          try {
            await this.host.forgetSource(graphId, dup.sourceId, {
              triggeredBy: 'mcp:train_skill:migrate-duplicates',
            });
          } catch { /* non-fatal */ }
        }

        // Clear all current nodes from the existing source. The sourceId,
        // sourceRef, and cross-source skill:calls edges referencing this
        // source's title survive — but title-NODE-id-bound edges become
        // stale and are repaired by refreshIncomingCallsToSkill below.
        await this.host.clearSourceNodes(graphId, existingSource.sourceId, {
          triggeredBy: 'mcp:train_skill:in-place',
          reason: 'pre-retrain clear (snapshot saved)',
        });

        skillId = existingSource.sourceId;
        // Rename AFTER inserts succeed — renaming before insertNodeAt left
        // hollow sources (TRAINED label, zero nodes) when an insert failed
        // after clearSourceNodes (SDK dedup / appendText edge cases).
      } else {
        // First-time train for this skill name → create a fresh source.
        // ingestClip seeds the source with the metadata comment as the first
        // node; the title + body + goals follow via insertNodeAt below. The
        // metadata insert is therefore SKIPPED in this branch.
        const rec = await ingestClip(
          this.host,
          graphId,
          metadataComment,
          label,
          {
            addedBy: addedBy ?? 'graphnosis-skill-trainer',
            sourceKind: 'skill',
            triggeredBy: 'mcp:train_skill',
          },
        );
        skillId = rec.sourceId;
      }

      // ── Insert content into `skillId` (works for both paths) ─────────────
      // For the in-place path: source.nodeIds is empty after clearSourceNodes;
      //   we insert metadata + title + body + goals from scratch.
      // For the first-time path: source already has the metadata seed from
      //   ingestClip; we insert title + body + goals only.
      const insertAtEnd = async (text: string, role: string): Promise<void> => {
        const len = this.host.getSourceRecord(graphId, skillId!)?.nodeIds.length ?? 0;
        await this.host.insertNodeAt(graphId, skillId!, len, text, {
          skipRelink: true, role, triggeredBy: 'mcp:train_skill', singleNode: true,
        });
      };

      if (existingSource) {
        await insertAtEnd(metadataComment, 'metadata');
      }
      await insertAtEnd(label, 'title');

      // Goals form a contract meta-header at the TOP — right after the title,
      // before the numbered steps — matching how walk_skill narrates a skill
      // (CONSTRAINTS first, then PROCEDURE) and giving the Trained Output editor
      // a clean "title → Goals (a,b,c) → Steps (1,2,3)" gutter. Inline-authored
      // goal lines (pulled from the body above) join the structured goal fields.
      for (const s of inlineGoalSections) {
        await insertAtEnd(s.text, s.role);
      }
      for (const s of goalSections) {
        await insertAtEnd(s.text, s.role);
      }

      // Body steps — the numbered procedure.
      for (const s of bodySections) {
        await insertAtEnd(s.text, s.role);
      }

      // ── Phase 2: append recalled-memory paragraphs as trailing context ───
      // Recalled memories are NEVER interleaved into the numbered procedure —
      // they land after the body as marked 'recalled-memory' nodes so they
      // can't be mis-read as steps. Combined with the upstream relevance gate
      // (only genuinely on-topic memories reach this point) and the attribution
      // marker added in buildMemoryAugmented, this keeps procedural SOPs
      // structurally clean while still surfacing the context.
      if (mode === 'memory-augmented' && recalledParagraphs.length > 0) {
        for (const text of recalledParagraphs) {
          await insertAtEnd(text, 'recalled-memory');
        }
      }

      if (inPlaceRenameRef && skillId) {
        await this.host.renameSource(graphId, skillId, inPlaceRenameRef, {
          triggeredBy: 'mcp:train_skill:in-place',
        });
      }

      this.host.triggerRelink(graphId);
      await linkSkillSequence(this.host, graphId, skillId);
      await linkSkillGoals(this.host, graphId, skillId);
      await linkSkillLoopsAndBranches(this.host, graphId, skillId);
      await linkSkillContextEdges(this.host, graphId, skillId);
      await linkSkillCalls(this.host, graphId, skillId, graphId);
      // D1 — resolve any `@skill:` refs that DON'T match a skill in this engram
      // against other skill engrams, persisting hits in the cross-engram table.
      await linkCrossEngramCalls(this.host, this.host.skillCallLinks, graphId, skillId, skillEngramIds(this.host));
      // Phase 5 — Decision 7: edges FROM other skills TO this skill's title
      // node may have become stale (title nodeId likely changed on retrain).
      // Re-run linkSkillCalls on every OTHER skill so any `@skill: <this>`
      // reference gets re-pointed to the new title node.
      await refreshIncomingCallsToSkill(this.host, graphId, skillId);
      // Bind cited memory nodes from recall recipes (empty-engram train contract).
      {
        const { syncSkillCitedNodesFromRecipes } = await import('./skill-recall-bindings.js');
        await syncSkillCitedNodesFromRecipes(this.host, graphId, skillId);
        // Legacy: train-time influential nodes (when ENABLE_CORTEX_RECALL_AT_TRAIN is on).
        if (topNodes.length > 0) {
          const settings = this.host.getSettings();
          const prior = settings.skillCitedNodes?.[skillId]?.nodes ?? {};
          const merged: Record<string, string> = { ...prior };
          for (const n of topNodes) merged[n.nodeId] = n.graphId ?? graphId;
          await this.host.setSettings({
            skillCitedNodes: {
              ...(settings.skillCitedNodes ?? {}),
              [skillId]: { graphId, nodes: merged },
            },
          });
        }
      }
      // Post-retrain dispatch registry sync for routing skills.
      try {
        const { scheduleDispatchSyncAfterRetrain } = await import('./skill-dispatch-sync.js');
        await scheduleDispatchSyncAfterRetrain(this.host, this, graphId, skillId);
      } catch { /* non-fatal */ }

      // Optional per-skill autonomy override — only when a level was requested
      // (omitted = no override written, so the skill keeps inheriting the engram
      // default). Clamped to the skill's authored dispatch-safe cap; a request
      // above the cap is lowered and reported via `autonomyNote`. Persisted in
      // graph metadata (not the skill body) so it survives future retraining.
      if (input.autonomyLevel && skillId) {
        const { levelRank } = await import('./skill-autonomy.js');
        const readout = this.host.dispatchSafeReadout(graphId)[0];
        const entry = readout?.perSkill.find((p) => p.sourceId === skillId);
        const cap = entry?.cap ?? 'L3';
        const requested = input.autonomyLevel;
        const applied = levelRank(requested) > levelRank(cap) ? cap : requested;
        await this.host.setSkillExecutionAutonomy(graphId, skillId, applied);
        autonomyNote = applied === requested
          ? `Per-skill autonomy set to ${applied}.`
          : `Per-skill autonomy requested ${requested} but the authored dispatch-safe cap is ${cap}; clamped to ${applied}.`;
      }
    }

    return {
      original: skill,
      trained,
      ...(diffNotes !== undefined ? { diffNotes } : {}),
      influentialNodes: topNodes,
      mode,
      ...(skillId !== undefined ? { skillId } : {}),
      ...(degradedNote !== undefined ? { degradedNote } : {}),
      ...(autonomyNote !== undefined ? { autonomyNote } : {}),
    };
    } finally {
      this.host.setSkipOverlayRecompute(false);
    }
  }

  // ── computeSkillVitality ───────────────────────────────────────────────────

  /**
   * Estimate how fresh a trained skill is.
   *
   * Vitality starts at 100 when a skill is trained, then drops as:
   * - The skill's own nodes are superseded (soft-deleted) by a retrain.
   * - Time passes: slow linear decay, ~5 pts/month, capped at 25 pts.
   *
   * Note: tracking which *external* memory nodes influenced a skill (for
   * a richer staleness signal) requires persisting cross-engram edges at
   * training time — that is the next evolution of this feature.
   *
   * Returns { score: 0 } when the skill cannot be found.
   */
  computeSkillVitality(
    graphId: string,
    sourceId: string,
  ): SkillVitalityResult {
    // Find the source record for this skill
    const sources = this.host.listSources(graphId);
    const source = sources.find((s) => s.sourceId === sourceId);
    if (!source) {
      return {
        score: 0,
        staleNodesCount: 0,
        recommendation: 'Skill source not found. It may have been deleted or moved.',
      };
    }

    const trainedAt = source.ingestedAt;
    const now = Date.now();

    // Count skill nodes that have been soft-deleted (validUntil in the past).
    const allNodes = this.host.listNodes(graphId);
    const nodeIdSet = new Set(source.nodeIds);
    const staleNodes = allNodes.filter(
      (n) => nodeIdSet.has(n.id) && n.validUntil !== undefined && n.validUntil <= now,
    );
    const staleNodesCount = staleNodes.length;
    const totalSkillNodes = source.nodeIds.length;

    // Recall-recipe cited-node drift vs live cortex.
    const citedEntry = this.host.getSettings().skillCitedNodes?.[sourceId];
    let citedNodesCount = 0;
    let missingCitedNodesCount = 0;
    if (citedEntry) {
      for (const [nodeId, eg] of Object.entries(citedEntry.nodes)) {
        citedNodesCount++;
        if (!this.host.listGraphs().includes(eg)) {
          missingCitedNodesCount++;
          continue;
        }
        const extNodes = this.host.listNodes(eg);
        const n = extNodes.find((x) => x.id === nodeId);
        if (!n || n.confidence <= 0.2 || (n.validUntil !== undefined && n.validUntil <= now)) {
          missingCitedNodesCount++;
        }
      }
    }

    // Age penalty: 5 points per month, capped at 25
    const monthsOld = (now - trainedAt) / (1000 * 60 * 60 * 24 * 30);
    const agePenalty = Math.min(Math.floor(monthsOld * 5), 25);

    // Staleness penalty: up to 50 pts if all skill nodes are soft-deleted
    const stalenessPenalty = totalSkillNodes > 0
      ? Math.round((staleNodesCount / totalSkillNodes) * 50)
      : 0;

    // Cited-memory drift penalty: up to 40 pts when all cited nodes are gone
    const driftDetected = citedNodesCount > 0 && missingCitedNodesCount > 0;
    const citedDriftPenalty = citedNodesCount > 0
      ? Math.round((missingCitedNodesCount / citedNodesCount) * 40)
      : 0;

    const score = Math.max(0, 100 - agePenalty - stalenessPenalty - citedDriftPenalty);

    let recommendation: string;
    if (driftDetected && score < 60) {
      recommendation =
        `${missingCitedNodesCount} of ${citedNodesCount} cited memory node(s) changed since last bind — retrain recommended.`;
    } else if (score >= 80) {
      recommendation = 'Skill is fresh — no retraining needed.';
    } else if (score >= 60) {
      recommendation =
        'Skill is aging. Consider retraining if you have added new preferences or context recently.';
    } else if (score >= 40) {
      recommendation =
        "Skill is moderately stale. Retraining recommended — call train_skill with this skill's text.";
    } else {
      recommendation =
        'Skill is stale. Call train_skill to personalize against your current cortex.';
    }

    return {
      score,
      trainedAt,
      staleNodesCount,
      agePenalty,
      stalenessPenalty,
      citedDriftPenalty,
      ...(citedNodesCount > 0 ? { citedNodesCount, missingCitedNodesCount, driftDetected } : {}),
      recommendation,
    };
  }

  // ── debugInjectCitedDrift (DEV/TEST ONLY) ──────────────────────────────────

  /**
   * DEV/TEST ONLY — deterministic cited-drift injection for the Appendix-S7 pilot
   * (paper #3). The pilot must estimate the baseline staleness-event rate λ₀, but
   * real cited-drift moves only with wall-clock age or owner-approved `edit`s, so
   * it cannot be produced automatically in a single session. This seeds
   * `skillCitedNodes` for a SANDBOX skill so computeSkillVitality's REAL
   * `citedDriftPenalty` term responds on demand: the skill's own (present) body
   * nodes plus `missingCount` synthetic nodes pointing at a non-existent engram,
   * yielding citedDriftPenalty = round(missingCount / (bodyNodes + missingCount) * 40).
   * It exercises the same code path real drift triggers — nothing is faked in the
   * scorer — so the measured λ₀ is faithful.
   *
   * Guarded twice; refuses to touch anything real:
   *   1. process.env.GRAPHNOSIS_DEV === '1'  (throws in production)
   *   2. graphId must be a sandbox engram (^s7-pilot / ^sandbox-)
   */
  async debugInjectCitedDrift(
    graphId: string,
    sourceId: string,
    missingCount: number,
  ): Promise<SkillVitalityResult> {
    if (process.env.GRAPHNOSIS_DEV !== '1') {
      throw new Error('debugInjectCitedDrift is dev-only — set GRAPHNOSIS_DEV=1');
    }
    if (!/^(s7-pilot|sandbox-)/.test(graphId)) {
      throw new Error(
        `debugInjectCitedDrift refuses non-sandbox engram "${graphId}" (allowlist: s7-pilot*, sandbox-*)`,
      );
    }
    const source = this.host.listSources(graphId).find((s) => s.sourceId === sourceId);
    if (!source) {
      throw new Error(`debugInjectCitedDrift: skill ${sourceId} not found in ${graphId}`);
    }
    const missing = Math.max(0, Math.floor(missingCount));
    const nodes: Record<string, string> = {};
    // Present cited nodes = the skill's real body nodes (found in graphId, live).
    for (const id of source.nodeIds) nodes[id] = graphId;
    // "Drifted" cited nodes = synthetic ids in a non-existent engram → counted missing.
    for (let i = 0; i < missing; i++) nodes[`s7-drift-gone-${i}`] = `${graphId}-gone-nonexistent`;
    const settings = this.host.getSettings();
    await this.host.setSettings({
      skillCitedNodes: {
        ...(settings.skillCitedNodes ?? {}),
        [sourceId]: { graphId, nodes },
      },
    });
    return this.computeSkillVitality(graphId, sourceId);
  }

  // ── exportSkill ────────────────────────────────────────────────────────────

  /**
   * Export a trained skill in a target AI tool's native format.
   *
   * Memory references and node IDs are stripped — only the behavioral content
   * is exported. The "direction of personalization" travels; the memories that
   * caused it stay local.
   *
   * For the 'gsk' format, returns a Buffer (encrypted JSON). All other formats
   * return a string.
   */
  exportSkill(skillText: string, format: ExportFormat): string | Buffer {
    if (format === 'gsk') {
      // Delegate to gsk-format for pack building. The caller (MCP handler or IPC
      // handler) is responsible for providing the full GskPayload; this path
      // returns a minimal single-skill pack from just the skill text.
      const payload = {
        formatVersion: '1' as const,
        kind: 'community' as const,
        id: `exported-${Date.now()}`,
        displayName: 'Exported Skill',
        description: 'Single skill exported from Graphnosis.',
        version: nextGskExportVersion(null),
        author: 'community',
        tierRequired: 'pro' as const,
        skills: [{
          name: 'Exported Skill',
          engramTemplate: 'skill' as const,
          sensitivityTier: 'personal' as const,
          baseText: skillText,
          recallRecipes: [],
        }],
        graphnosisMd: '',
        signature: '',
      };
      return buildGskPackage(payload);
    }

    // Strip the "Personal Context (from your Graphnosis memories)" block and
    // the metadata header comment that the trainer prepends on save.
    let cleaned = stripMetadataHeader(skillText);
    cleaned = stripPersonalContextBlock(cleaned);
    cleaned = stripped(cleaned);

    const header = FORMAT_HEADERS[format];
    const wrapper = FORMAT_WRAPPERS[format];

    // Claude Code skills want YAML frontmatter (name + description) at byte 0,
    // where `description` is the Trigger goal. This is the AI-facing export path
    // (the MCP `export_skill` tool routes here), so emit frontmatter instead of
    // the comment header to produce a drop-in `.claude/skills` file.
    if (format === 'claude-md') {
      const fm = buildClaudeMdFrontmatter(extractSkillTitle(cleaned), extractTriggerBlock(cleaned));
      if (fm) return `${fm}\n\n${cleaned}`;
    }

    const withHeader = header ? `${header}\n\n${cleaned}` : cleaned;
    return wrapper ? wrapper(cleaned) : withHeader;
  }

  /**
   * Phase 3c — source-driven export.
   * Reads the skill source's chunks (in nodeIds order, with full untruncated
   * content) and runs them through `formatTrainedOutputAsMarkdown` for the
   * target format. This is the export path used by the new editable
   * Trained Output editor where chunks are plain text in storage but
   * markdown at export.
   */
  exportSkillFromSource(graphId: string, sourceId: string, format: ExportFormat): string | Buffer {
    const rec = this.host.getSourceRecord(graphId, sourceId);
    if (!rec) {
      // Soft fallback — empty string lets the UI render a "nothing to export"
      // message instead of crashing.
      return '';
    }
    const now = Date.now();
    const wantedIds = new Set(rec.nodeIds);
    const liveIds = new Set<string>();
    for (const n of this.host.listNodes(graphId)) {
      if (!wantedIds.has(n.id)) continue;
      if (n.confidence <= 0.2) continue;
      if (n.validUntil !== undefined && n.validUntil <= now) continue;
      liveIds.add(n.id);
      if (liveIds.size === wantedIds.size) break;
    }
    const chunks: string[] = rec.nodeIds
      .filter((id) => liveIds.has(id))
      .map((id) => this.host.getFullNodeContent(graphId, id) ?? '')
      .filter(Boolean);

    if (format === 'gsk') {
      return this.buildGskFromSource(graphId, sourceId, chunks);
    }
    const body = formatTrainedOutputAsMarkdown(chunks, format);
    const header = FORMAT_HEADERS[format];
    const wrapper = FORMAT_WRAPPERS[format];
    // A claude-md body already leads with its own YAML frontmatter, which must
    // sit at byte 0 — never prepend the comment header in front of it.
    const startsWithFrontmatter = body.startsWith('---\n');
    const withHeader = header && !startsWithFrontmatter ? `${header}\n\n${body}` : body;
    return wrapper ? wrapper(body) : withHeader;
  }

  /** Build a semver-aware GSK pack from a trained skill source. */
  private buildGskFromSource(graphId: string, sourceId: string, chunks: string[]): Buffer {
    const rec = this.host.getSourceRecord(graphId, sourceId);
    const text = chunks.join('\n\n');
    const provenance = parseSkillProvenance(text);
    const goals = parseSkillGoals(text);
    const title = extractSkillTitle(text) || baseSkillName(rec?.ref ?? sourceId);
    const skillName = baseSkillName(title);

    const bodyLines: string[] = [];
    const recipeLines: string[] = [];
    for (const chunk of chunks) {
      const t = chunk.trim();
      if (!t || t.startsWith('<!--')) continue;
      if (parseRecallRecipeText(t)) recipeLines.push(t);
      else if (!/^Success:|^Out of scope:|^On completion:|^Trigger:|^Prerequisites:|^On failure:|^Requires:|^Produces:/i.test(t)
        && !t.startsWith('#') && t !== title) {
        bodyLines.push(t);
      }
    }

    const recallRecipes = recipeLines
      .map((r) => parseRecallRecipeText(r))
      .filter(Boolean)
      .map((r) => ({
        name: r!.name,
        trigger: r!.trigger,
        steps: r!.steps.map((s) => ({
          tool: s.tool,
          query: s.query,
          ...(s.onlyEngrams ? { onlyEngrams: s.onlyEngrams } : {}),
          ...(s.ifResultsBelow !== undefined ? { ifResultsBelow: s.ifResultsBelow } : {}),
        })),
      }));

    const version = nextGskExportVersion(provenance?.packVersion, 'patch');
    const packId = provenance?.packId ?? `exported-${skillName}`;
    const payload = {
      formatVersion: '1' as const,
      kind: (provenance?.kind ?? 'community') as 'official' | 'community',
      id: packId,
      displayName: skillName,
      description: `Exported skill: ${skillName}`,
      version,
      author: provenance?.author ?? 'community',
      tierRequired: 'pro' as const,
      ...(provenance?.packId ? { upstreamPackId: provenance.packId } : {}),
      skills: [{
        name: skillName,
        engramTemplate: 'skill' as const,
        sensitivityTier: 'personal' as const,
        baseText: bodyLines.join('\n\n'),
        recallRecipes,
        ...(goals ? { goals } : {}),
        ...(provenance?.packId ? { basedOn: provenance.packId } : {}),
      }],
      graphnosisMd: '',
      signature: '',
    };
    payload.graphnosisMd = generateGraphnosisMd(payload);
    return buildGskPackage(payload);
  }


  // ── Skill management ──────────────────────────────────────────────────────

  /**
   * When an in-place retrain clears a source then fails mid-insert, the
   * source survives with zero live nodes but a fresh "(trained …)" ref.
   * Re-play the newest snapshot that still has node content so getSkill /
   * listNodes / export can serve the skill again without a manual retrain.
   */
  async repairHollowSkillSource(graphId: string, sourceId: string): Promise<boolean> {
    const sources = this.host.listSources(graphId);
    const src = sources.find((s) => s.sourceId === sourceId && s.kind === 'skill');
    if (!src) return false;

    const now = Date.now();
    const wantedIds = new Set(src.nodeIds);
    let hasLiveContent = false;
    for (const n of this.host.listNodes(graphId)) {
      if (!wantedIds.has(n.id)) continue;
      if (n.confidence <= 0.2) continue;
      if (n.validUntil !== undefined && n.validUntil <= now) continue;
      const content = this.host.getFullNodeContent(graphId, n.id) ?? '';
      if (content) {
        hasLiveContent = true;
        break;
      }
    }
    if (hasLiveContent) return false;

    const summaries = await this.host.skillSnapshots.list(graphId, sourceId);
    const donorSummary = summaries.find((s) => s.nodeCount > 0);
    if (!donorSummary) return false;

    const snapshot = await this.host.skillSnapshots.read(graphId, sourceId, donorSummary.snapshotId);
    if (!snapshot || snapshot.nodes.length === 0) return false;

    if (src.nodeIds.length > 0) {
      await this.host.clearSourceNodes(graphId, sourceId, {
        triggeredBy: 'skill:repair-hollow',
        reason: 'hollow skill — restoring from snapshot',
      });
    }

    for (const node of snapshot.nodes) {
      const len = this.host.getSourceRecord(graphId, sourceId)?.nodeIds.length ?? 0;
      await this.host.insertNodeAt(graphId, sourceId, len, node.content, {
        skipRelink: true,
        ...(node.role !== undefined ? { role: node.role } : {}),
        triggeredBy: 'skill:repair-hollow',
        singleNode: true,
      });
    }

    this.host.triggerRelink(graphId);
    await linkSkillSequence(this.host, graphId, sourceId);
    await linkSkillGoals(this.host, graphId, sourceId);
    await linkSkillLoopsAndBranches(this.host, graphId, sourceId);
    await linkSkillContextEdges(this.host, graphId, sourceId);
    await linkSkillCalls(this.host, graphId, sourceId, graphId);
    await linkCrossEngramCalls(this.host, this.host.skillCallLinks, graphId, sourceId, skillEngramIds(this.host));
    await refreshIncomingCallsToSkill(this.host, graphId, sourceId);
    return true;
  }

  listSkills(graphId?: string): SkillListEntry[] {
    // Listing across ALL engrams must surface every skill, regardless of the
    // host engram's template. train_skill resolves `target_engram` by name with
    // no template check, so a skill can be (and is) trained into engrams whose
    // template is NOT 'skill' (e.g. a 'project' or 'personal' engram). Every
    // other skill path — skillEngramIds(), cross-engram call linking, walk_skill,
    // get_skill — keys off `kind === 'skill'`, so gating the all-engrams listing
    // by `template === 'skill'` silently dropped those skills here alone. Include
    // any non-archived engram that actually holds at least one skill source.
    const graphIds = graphId
      ? [graphId]
      : this.host.listGraphs().filter((gid) => {
          const meta = this.host.getGraphMetadata(gid);
          if (meta?.archived === true) return false;
          // QUARANTINE CONTRACT: imported-but-unpromoted engrams are excluded
          // from the DEFAULT (all-engrams) skill scope — feeding both the
          // proactive watcher's usableSkills and list_skills' default scope.
          // An explicit `graphId` (e.g. the quarantine-review tooling) can still
          // enumerate them. Routed through the centralized host.isQuarantined.
          if (this.host.isQuarantined(gid)) return false;
          return this.host.listSources(gid).some((s) => s.kind === 'skill');
        });
    const entries: SkillListEntry[] = [];
    const now = Date.now();
    for (const gid of graphIds) {
      const meta = this.host.getGraphMetadata(gid);
      const sources = this.host.listSources(gid).filter((s) => s.kind === 'skill');
      if (sources.length === 0) continue;
      const nodes = this.host.listNodes(gid);
      const activeBySource = new Map<string, number>();
      for (const n of nodes) {
        if (n.confidence > 0.2 && (!n.validUntil || n.validUntil > now)) {
          for (const src of sources) {
            if (src.nodeIds.includes(n.id)) {
              activeBySource.set(src.sourceId, (activeBySource.get(src.sourceId) ?? 0) + 1);
            }
          }
        }
      }
      for (const src of sources) {
        const nodeText = src.nodeIds
          .map((id) => nodes.find((n) => n.id === id)?.contentPreview ?? '')
          .join('\n');
        const parsed = parseSkillMetadata(nodeText);
        const provenance = parseSkillProvenance(nodeText);
        const searchPreview = nodeText
          .replace(/<!--[\s\S]*?-->/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000);
        entries.push({
          sourceId: src.sourceId,
          graphId: gid,
          engramName: meta?.displayName ?? gid,
          label: src.ref,
          ingestedAt: src.ingestedAt,
          nodeCount: activeBySource.get(src.sourceId) ?? 0,
          ...(searchPreview ? { searchPreview } : {}),
          ...(parsed.trainedAt !== undefined ? { trainedAt: parsed.trainedAt } : {}),
          ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
          ...(parsed.recallBreadth !== undefined ? { recallBreadth: parsed.recallBreadth } : {}),
          ...(provenance !== undefined ? { provenance } : {}),
        });
      }
    }
    return entries.sort((a, b) => b.ingestedAt - a.ingestedAt);
  }

  getSkill(graphId: string, sourceId: string): SkillDetail | null {
    const sources = this.host.listSources(graphId);
    const src = sources.find((s) => s.sourceId === sourceId && s.kind === 'skill');
    if (!src) return null;
    const meta = this.host.getGraphMetadata(graphId);
    const now = Date.now();
    // Build a sparse content map keyed only by THIS skill's node IDs.
    // Previously we materialized a Map of every node in the engram via
    // listNodes(graphId).filter().map(...) — O(N_total) allocations per
    // click, dominated by Map construction on Skills engrams with many
    // sibling skills. Iterating once with a wanted-id Set + early break
    // on full match keeps us at O(N_seen_until_complete) and avoids the
    // full-engram Map allocation.
    // Walk the engram once to apply confidence + validUntil filters; then
    // pull the FULL untruncated content per matching id. listNodes returns
    // contentPreview (capped at 500 chars by inspectNodes), which silently
    // ate the trailing Goals + Recipes blocks on long imported skills.
    // getFullNodeContent reads straight from the SDK store with no cap.
    const wantedIds = new Set(src.nodeIds);
    const liveIds = new Set<string>();
    for (const n of this.host.listNodes(graphId)) {
      if (!wantedIds.has(n.id)) continue;
      if (n.confidence <= 0.2) continue;
      if (n.validUntil !== undefined && n.validUntil <= now) continue;
      liveIds.add(n.id);
      if (liveIds.size === wantedIds.size) break;
    }
    const chunks = src.nodeIds
      .filter((id) => liveIds.has(id))
      .map((id) => this.host.getFullNodeContent(graphId, id) ?? '')
      .filter(Boolean);
    const text = chunks.join('\n\n');
    const parsed = parseSkillMetadata(text);
    const goals = parseSkillGoals(text);
    const provenance = parseSkillProvenance(text);
    return {
      sourceId: src.sourceId,
      graphId,
      engramName: meta?.displayName ?? graphId,
      label: src.ref,
      ingestedAt: src.ingestedAt,
      nodeCount: chunks.length,
      text,
      ...(parsed.trainedAt !== undefined ? { trainedAt: parsed.trainedAt } : {}),
      ...(parsed.mode !== undefined ? { mode: parsed.mode } : {}),
      ...(parsed.recallBreadth !== undefined ? { recallBreadth: parsed.recallBreadth } : {}),
      ...(goals !== undefined ? { goals } : {}),
      ...(provenance !== undefined ? { provenance } : {}),
    };
  }

  /**
   * History of a skill = the current source state + every pre-retrain
   * snapshot we have on disk. Each snapshot becomes one entry; the
   * current source becomes the newest entry, identified by `isCurrent`
   * and an empty `snapshotId`.
   *
   * Newest first (matches the user expectation of "most recent retrain
   * at the top of the panel").
   */
  async getSkillHistory(graphId: string, sourceId: string): Promise<SkillVersionEntry[]> {
    const sources = this.host.listSources(graphId).filter((s) => s.kind === 'skill');
    const target = sources.find((s) => s.sourceId === sourceId);
    if (!target) return [];

    // Current state entry — derived from the live source nodes.
    const now = Date.now();
    const nodeMap = new Map(this.host.listNodes(graphId).map((n) => [n.id, n]));
    const activeNodeIds = target.nodeIds.filter((id) => {
      const n = nodeMap.get(id);
      return n && n.confidence > 0.2 && (!n.validUntil || n.validUntil > now);
    });
    const currentText = activeNodeIds.map((id) => nodeMap.get(id)?.contentPreview ?? '').join('\n');
    const currentParsed = parseSkillMetadata(currentText);
    const current: SkillVersionEntry = {
      sourceId: target.sourceId,
      snapshotId: '',
      label: target.ref,
      ingestedAt: target.ingestedAt,
      nodeCount: activeNodeIds.length,
      isCurrent: true,
      ...(currentParsed.trainedAt !== undefined ? { trainedAt: currentParsed.trainedAt } : {}),
      ...(currentParsed.mode !== undefined ? { mode: currentParsed.mode } : {}),
    };

    // Snapshot entries — already returned newest-first by the store.
    const snapshots = await this.host.skillSnapshots.list(graphId, sourceId);
    const past: SkillVersionEntry[] = snapshots.map((s) => ({
      sourceId: target.sourceId,
      snapshotId: s.snapshotId,
      label: s.label,
      ingestedAt: s.ts,
      nodeCount: s.nodeCount,
      isCurrent: false,
      ...(s.trainedAt !== undefined ? { trainedAt: s.trainedAt } : {}),
      ...(s.mode !== undefined ? { mode: s.mode } : {}),
    }));

    return [current, ...past];
  }

  /**
   * Restore a skill to a prior snapshot. Behaviour:
   *   - `snapshotId` empty / missing  → no-op (the "current" entry was
   *     already current; rolling back to it is meaningless).
   *   - `snapshotId` matches an on-disk snapshot → clear the current
   *     source's nodes (snapshotting their state first, so this very
   *     rollback can itself be rolled back), then re-insert the
   *     snapshot's nodes verbatim in source order.
   *
   * Cross-source `skill:calls` edges are re-stitched at the end by
   * `refreshIncomingCallsToSkill` — same machinery as a normal retrain.
   */
  async rollbackSkill(
    graphId: string,
    sourceId: string,
    snapshotId: string,
  ): Promise<{ restoredNodeCount: number }> {
    const sources = this.host.listSources(graphId).filter((s) => s.kind === 'skill');
    const target = sources.find((s) => s.sourceId === sourceId);
    if (!target) throw new Error(`Skill source ${sourceId} not found in graph ${graphId}.`);
    if (!snapshotId) {
      // Rolling back to "current" is a no-op.
      return { restoredNodeCount: target.nodeIds.length };
    }

    const snapshot = await this.host.skillSnapshots.read(graphId, sourceId, snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot ${snapshotId} not found for skill ${sourceId} in graph ${graphId}.`);
    }

    // Snapshot the CURRENT state before overwriting it — so the user can
    // undo the rollback if it turns out to be the wrong choice. Same
    // path as trainSkill, just a different `triggeredBy` for the audit
    // trail.
    {
      const now = Date.now();
      const nodeMap = new Map(this.host.listNodes(graphId).map((n) => [n.id, n]));
      const liveNodes: Array<{ content: string }> = [];
      for (const nid of target.nodeIds) {
        const meta = nodeMap.get(nid);
        if (!meta) continue;
        if (meta.confidence <= 0.2) continue;
        if (meta.validUntil !== undefined && meta.validUntil <= now) continue;
        const content = this.host.getFullNodeContent(graphId, nid) ?? '';
        if (!content) continue;
        liveNodes.push({ content });
      }
      const ts = Date.now();
      await this.host.skillSnapshots.append(graphId, {
        snapshotId: SkillSnapshotStore.idFromTs(ts),
        ts,
        sourceId,
        ref: target.ref,
        label: target.ref.replace(/^skill:\d+:/, ''),
        nodes: liveNodes,
      });
    }

    // Wipe the current source state and replay the snapshot in order.
    await this.host.clearSourceNodes(graphId, sourceId, {
      triggeredBy: 'skill:rollback',
      reason: `rollback to snapshot ${snapshotId}`,
    });
    for (const node of snapshot.nodes) {
      const len = this.host.getSourceRecord(graphId, sourceId)?.nodeIds.length ?? 0;
      await this.host.insertNodeAt(graphId, sourceId, len, node.content, {
        skipRelink: true,
        ...(node.role !== undefined ? { role: node.role } : {}),
        triggeredBy: 'skill:rollback',
        singleNode: true,
      });
    }

    // Rebuild every SOP edge — node ids changed, so all previous edges
    // touching this source are now stale and need re-derivation.
    this.host.triggerRelink(graphId);
    await linkSkillSequence(this.host, graphId, sourceId);
    await linkSkillGoals(this.host, graphId, sourceId);
    await linkSkillLoopsAndBranches(this.host, graphId, sourceId);
    await linkSkillContextEdges(this.host, graphId, sourceId);
    await linkSkillCalls(this.host, graphId, sourceId, graphId);
    await linkCrossEngramCalls(this.host, this.host.skillCallLinks, graphId, sourceId, skillEngramIds(this.host));
    await refreshIncomingCallsToSkill(this.host, graphId, sourceId);

    return { restoredNodeCount: snapshot.nodes.length };
  }

  /**
   * Delete a skill and every snapshot belonging to it.
   *
   * `allVersions` is preserved as a parameter for API compatibility but
   * is now a no-op: under the in-place model every "version" of a skill
   * lives in one source, so deleting that source IS deleting all
   * versions. The flag was meaningful under the previous "one source
   * per retrain" model; we keep it as `_allVersions` so the IPC signature
   * doesn't break and downstream callers can be migrated lazily.
   */
  async deleteSkill(
    graphId: string,
    sourceId: string,
    _allVersions = false,
  ): Promise<{ forgottenSourceIds: string[] }> {
    const sources = this.host.listSources(graphId).filter((s) => s.kind === 'skill');
    const target = sources.find((s) => s.sourceId === sourceId);
    if (!target) throw new Error(`Skill "${sourceId}" not found in graph "${graphId}".`);
    await this.host.forgetSource(graphId, target.sourceId, { triggeredBy: 'skill:delete' });
    // Then purge the per-source snapshot directory so a re-trained skill
    // under the same name doesn't surface old history that no longer
    // logically belongs to it.
    await this.host.skillSnapshots.deleteAll(graphId, target.sourceId);
    return { forgottenSourceIds: [target.sourceId] };
  }

  private async pingLlm(): Promise<boolean> {
    if (!this.llm) return false;
    // Check the 'distillation' capability at call time so user setting changes
    // take effect on the next call without a sidecar restart. Mirrors the
    // pattern in BrainEngine.pingLlm() which gates on 'insights'.
    if (!settingsMod.resolveLlmCapabilities(this.host.getSettings()).distillation) return false;
    const llmWithPing = this.llm as { ping?: () => Promise<boolean> };
    if (typeof llmWithPing.ping === 'function') {
      try {
        return await llmWithPing.ping();
      } catch {
        return false;
      }
    }
    return true;
  }

  private async llmCompleteWithTimeout(
    input: { system: string; user: string },
    timeoutMs = 20_000,
    onChunk?: (chunk: string) => void,
  ): Promise<string> {
    if (!this.llm) throw new Error('LLM not available');
    // Pick streaming when both the caller wants it AND the LLM supports it.
    // Otherwise fall back to non-streaming complete() — same Promise race
    // against the timeout in either path.
    const llmCall: Promise<string> = (onChunk && this.llm.completeStream)
      ? this.llm.completeStream(input, onChunk)
      : this.llm.complete(input);
    return Promise.race([
      llmCall,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`LLM call exceeded ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }
}


// ── Skill sequence edges ──────────────────────────────────────────────────────

/**
 * Evidence tag that marks all directed edges created by this module to encode
 * the ordered "step N → step N+1" chain of a skill's paragraphs.
 *
 * Keeping it unique lets `linkSkillSequence` find and replace stale edges after
 * any structural mutation (insert, remove, reorder) without touching
 * SDK-generated or user-created edges.
 */
export const SKILL_SEQ_EVIDENCE = 'skill:seq';

/**
 * Synchronise `precedes` directed edges between a skill source's live content
 * nodes so the graph always reflects the paragraph order the user sees in the
 * Trained Output editor.
 *
 * Steps:
 *  1. Read live nodeIds for `sourceId` in storage order.
 *  2. Strip metadata comment nodes (they're audit artefacts, not steps).
 *  3. Delete all existing `skill:seq` edges that touch any node in the source.
 *  4. Re-add `precedes` edges for each consecutive live pair.
 *
 * Idempotent — safe to call after every mutation.
 */
export async function linkSkillSequence(
  host: GraphnosisHost,
  graphId: string,
  sourceId: string,
): Promise<void> {
  const src = host.getSourceRecord(graphId, sourceId);
  if (!src) return;

  const now = Date.now();
  const allNodes = host.listNodes(graphId);
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  // Live content nodes in source order — exclude soft-deleted and metadata chunks.
  const liveIds = src.nodeIds.filter((id) => {
    const n = nodeMap.get(id);
    if (!n || n.confidence <= 0.2) return false;
    if (n.validUntil !== undefined && n.validUntil <= now) return false;
    // Skip metadata comment nodes (provenance / training header).
    return !n.contentPreview.trimStart().startsWith('<!--');
  });

  // Remove stale skill-sequence edges touching any node in this source.
  const nodeSet = new Set(src.nodeIds);
  const { directed } = host.listEdges(graphId);
  const staleIds = directed
    .filter((e) => e.evidence === SKILL_SEQ_EVIDENCE && (nodeSet.has(e.from) || nodeSet.has(e.to)))
    .map((e) => e.id);
  if (staleIds.length > 0) {
    await host.unlinkEdgesBatch(graphId, staleIds);
  }

  if (liveIds.length < 2) return;

  const edges = [];
  for (let i = 0; i < liveIds.length - 1; i++) {
    edges.push({
      from: liveIds[i]!,
      to: liveIds[i + 1]!,
      type: 'precedes' as const,
      weight: 0.9,
      evidence: SKILL_SEQ_EVIDENCE,
    });
  }
  await host.linkNodesDirectedBatch(graphId, edges);
}

// ── SOP edge constants ────────────────────────────────────────────────────────

export const SKILL_GOAL_EVIDENCE   = 'skill:goal';
export const SKILL_LOOP_EVIDENCE   = 'skill:loop';
export const SKILL_BRANCH_EVIDENCE = 'skill:branch';

/** Encode a loop edge's evidence with an optional max-iteration cap (D2 loop
 *  convergence guard). `skill:loop` = no cap; `skill:loop;max=5` = stop after
 *  5 iterations. The cap is surfaced in walk_skill_structured so AI executors
 *  enforce it instead of looping forever on a body that makes no progress. */
export function encodeLoopEvidence(maxIterations?: number): string {
  return maxIterations && maxIterations > 0
    ? `${'skill:loop'};max=${maxIterations}`
    : 'skill:loop';
}
/** Extract the max-iteration cap from a loop edge's evidence, or undefined. */
export function parseLoopMax(evidence: string | undefined): number | undefined {
  const m = evidence?.match(/(?:^|;)max=(\d+)/);
  return m ? parseInt(m[1]!, 10) : undefined;
}
export const SKILL_CTX_EVIDENCE    = 'skill:ctx';
export const SKILL_CALLS_EVIDENCE  = 'skill:calls';

// ── Loop / branch pattern sets (tiered by language) ───────────────────────────

// Tier 1: explicit syntax (language-neutral, always matched first).
// Optional `max=N` after the target step encodes a loop-convergence guard:
// `@loop: 2 max=5` → loop back to step 2, at most 5 iterations. Group 1 = the
// target step, group 2 = the optional max-iteration cap.
const LOOP_EXPLICIT: RegExp[] = [
  /@loop:\s*(\d+)(?:\s+max=(\d+))?/i,
  /\[\[loop:\s*(\d+)(?:\s+max=(\d+))?\]\]/i,
];
// Tier 2: English
const LOOP_EN: RegExp[] = [
  /\bgo\s+back\s+to\s+step\s+(\d+|\w+)\b/i,
  /\breturn\s+to\s+step\s+(\d+|\w+)\b/i,
  /\brepeat\s+(?:from\s+)?step\s+(\d+|\w+)\b/i,
  /\bretry\s+(?:from\s+)?step\s+(\d+|\w+)\b/i,
  /\bloop\s+back\s+to\s+step\s+(\d+|\w+)\b/i,
  /\brestart\s+(?:from\s+)?(?:step\s+)?(\d+|\w+)\b/i,
];
// Tier 3: Romanian
const LOOP_RO: RegExp[] = [
  /\bîntoarce-te\s+la\s+pasul\s+(\d+|\w+)\b/i,
  /\brevino\s+la\s+pasul\s+(\d+|\w+)\b/i,
  /\brepet[ăa]\s+de\s+la\s+pasul\s+(\d+|\w+)\b/i,
  /\breia\s+de\s+la\s+pasul\s+(\d+|\w+)\b/i,
];
// Tier 4: Spanish / French / German / Italian / Portuguese
const LOOP_EU: RegExp[] = [
  /\bvuelve\s+al\s+paso\s+(\d+|\w+)\b/i,
  /\bregresa\s+al\s+paso\s+(\d+|\w+)\b/i,
  /\brevenir\s+[aà]\s+l.étape\s+(\d+|\w+)\b/i,
  /\bzurück\s+zu\s+Schritt\s+(\d+|\w+)\b/i,
  /\btorna\s+al\s+passo\s+(\d+|\w+)\b/i,
  /\bvolte\s+ao\s+passo\s+(\d+|\w+)\b/i,
];
const LOOP_PATTERNS: RegExp[] = [...LOOP_EXPLICIT, ...LOOP_EN, ...LOOP_RO, ...LOOP_EU];

const BRANCH_EXPLICIT: RegExp[] = [
  /@branch:\s*(\d+)/i,
  /\[\[branch:\s*(\d+)\]\]/i,
];
const BRANCH_EN: RegExp[] = [
  /\bif\s+.+,\s+(?:skip\s+to|proceed\s+to|go\s+to)\s+step\s+(\d+|\w+)\b/i,
  /\bdepending\s+on\s+.+,\s+(?:proceed|continue)\s+(?:to\s+step\s+)?(\d+|\w+)\b/i,
  /\botherwise,?\s+(?:skip|go|proceed)\s+to\s+step\s+(\d+|\w+)\b/i,
];
const BRANCH_RO: RegExp[] = [
  /\bdacă\s+.+,\s+(?:mergi|du-te)\s+la\s+pasul\s+(\d+|\w+)\b/i,
  /\bîn\s+caz\s+contrar,?\s+(?:mergi|treci)\s+la\s+pasul\s+(\d+|\w+)\b/i,
];
const BRANCH_EU: RegExp[] = [
  /\bsi\s+.+,\s+(?:ve|salta)\s+al\s+paso\s+(\d+|\w+)\b/i,
  /\bsi\s+.+,\s+passer\s+[aà]\s+l.étape\s+(\d+|\w+)\b/i,
  /\bwenn\s+.+,\s+(?:gehe|weiter)\s+zu\s+Schritt\s+(\d+|\w+)\b/i,
];
const BRANCH_PATTERNS: RegExp[] = [...BRANCH_EXPLICIT, ...BRANCH_EN, ...BRANCH_RO, ...BRANCH_EU];

const SKILL_CALL_PATTERNS: RegExp[] = [
  /@skill:\s*(.+)/i,
  /\[\[skill:\s*([^\]]+)\]\]/i,
  /\b(?:run|use|apply|follow|execute|invoke)\s+the\s+"?([^"]+?)"?\s+skill\b/i,
  /\b(?:run|use|apply|follow|execute|invoke)\s+"?([^"]+?)"?\s+skill\b/i,
  /\b(?:aplică|folosește|urmează)\s+skill-ul\s+"?([^"]+?)"?\b/i,
  /\b(?:aplica|usa|seguir)\s+(?:el\s+)?skill\s+"?([^"]+?)"?\b/i,
];

// ── SOP shared utilities ──────────────────────────────────────────────────────

function sopTokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\W+/).filter((t) => t.length > 1));
}

function jaccardSop(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Known abbreviations whose trailing period is NOT a sentence boundary.
// Stored dot-stripped + lowercased; "e.g." / "i.e." are matched by stripping
// the internal dots of the trailing token before lookup (so "e.g" → "eg").
const SENTENCE_ABBREVIATIONS = new Set([
  'etc', 'eg', 'ie', 'vs', 'no', 'dr', 'mr', 'mrs', 'ms', 'inc',
  'ltd', 'co', 'fig', 'cf', 'al',
]);

/** True when the chunk ending in a period should NOT be treated as a sentence
 *  end: it ends in a known abbreviation ("etc.", "e.g.", "i.e."), a code token
 *  (501c3, 990), or a decimal (3.5). */
function suppressesSentenceBoundary(chunk: string): boolean {
  // Strip the terminal punctuation we split on, then grab the trailing token
  // (letters/digits, allowing internal periods so "e.g" / "501.c" survive).
  const body = chunk.replace(/[.!?]+$/, '');
  const tail = body.match(/[\w.]+$/)?.[0] ?? '';
  if (!tail) return false;
  // Decimal or numeric/code token (digits, optionally mixed with letters/dots).
  if (/\d/.test(tail) && /^[\w.]+$/.test(tail)) return true;
  // Known abbreviation, with internal dots removed (e.g → eg, i.e → ie).
  const flat = tail.replace(/\./g, '').toLowerCase();
  return SENTENCE_ABBREVIATIONS.has(flat);
}

export function splitSentences(text: string): string[] {
  // First-pass split on terminal punctuation followed by whitespace + an
  // uppercase (incl. accented) start-of-sentence letter.
  const rough = text.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚÀÂÊÔÛÄÖÜÃÕ])/);

  // Re-join any split where the chunk before the boundary ends in an
  // abbreviation, a code token, or a decimal — those periods aren't real
  // sentence ends. The split regex already guards lowercase / decimal
  // next-chars; this guards the abbreviation + code cases it misses.
  const merged: string[] = [];
  for (const part of rough) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && /[.!?]$/.test(prev) && suppressesSentenceBoundary(prev)) {
      merged[merged.length - 1] = `${prev} ${part}`;
    } else {
      merged.push(part);
    }
  }

  return merged.map((s) => s.trim()).filter(Boolean);
}

/** A line that begins a recall-recipe STEP (e.g. "- recall: …"). Mirrors the
 *  bullet form recall recipes use so the recipe-block detector below can tell a
 *  recipe continuation from a free-standing bullet step. */
const RECIPE_STEP_LINE_RE =
  /^[-—]\s*(?:recall|remind|dig_deeper|recall_structured|recall_with_citations|cross_search)\s*:/i;

/** True when `line` begins a new semantic body unit: a numbered step or a
 *  bullet (recall-recipe blocks are handled by the caller, which keeps their
 *  step bullets whole). Numbered steps use the same abbreviation/decimal guard
 *  as splitSentences so a wrapped continuation line like "3.5 percent overhead"
 *  (no space after the dot) is NOT mistaken for a "3." step — `^\s*\d+\.\s`
 *  already requires whitespace after the dot, and we additionally reject a
 *  leading token that suppresses a sentence boundary (decimals, code tokens,
 *  known abbreviations like "etc."). */
function startsNewBodyUnit(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[-*]\s/.test(t) && !RECIPE_STEP_LINE_RE.test(t)) return true;
  // A numbered step is "N." followed by whitespace. The required whitespace is
  // itself the decimal guard: a decimal like "3.5 percent" or a code token like
  // "501.c" has NO space after the dot, so it never opens a node here. (The
  // abbreviation/decimal handling for in-line text lives in splitSentences /
  // suppressesSentenceBoundary; step boundaries are purely line-anchored.)
  if (/^\d+\.\s/.test(t)) return true;
  return false;
}

/**
 * Split a run of body lines (already separated from goal lines) into individual
 * semantic units so each numbered step / bullet / recall-recipe becomes its own
 * stored node — even when the author used only single newlines between steps.
 *
 * A new unit begins at any line matching a numbered step (`1. `), a bullet
 * (`- ` / `* `), or a recall-recipe header (a "name: trigger" line immediately
 * followed by recipe-step bullets). Lines that are neither stay attached to the
 * current unit (continuation / wrapped text). Recall-recipe blocks are kept
 * whole — their step bullets are NOT split off as free-standing bullets.
 *
 * The abbreviation-safe guard (suppressesSentenceBoundary) protects decimals,
 * code tokens, and "etc."/"e.g." so a step's wrapped line never opens a node.
 */
export function splitBodyRunIntoUnits(lines: readonly string[]): string[] {
  const units: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const text = current.join('\n').trim();
    if (text) units.push(text);
    current = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (!t) { current.push(line); continue; }

    // Recall-recipe header: a "name: trigger" line whose NEXT non-empty line is
    // a recipe step. Start a fresh unit and absorb every following recipe-step
    // bullet so the recipe stays a single node.
    let next = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trim()) { next = lines[j]!.trim(); break; }
    }
    const isRecipeHeader =
      /^[^\s:].*:/.test(t) && !GOAL_NODE_RE.test(t) && RECIPE_STEP_LINE_RE.test(next);
    if (isRecipeHeader) {
      flush();
      current.push(line);
      // Consume contiguous recipe-step bullet lines into this same unit.
      while (i + 1 < lines.length) {
        const peek = lines[i + 1]!.trim();
        if (peek === '' || RECIPE_STEP_LINE_RE.test(peek)) { current.push(lines[++i]!); }
        else break;
      }
      flush();
      continue;
    }

    if (startsNewBodyUnit(line) && current.some((l) => l.trim())) {
      flush();
    }
    current.push(line);
  }
  flush();
  return units;
}

function isNonLatinScript(text: string): boolean {
  return /[؀-ۿऀ-ॿ฀-๿぀-鿿가-힯]/.test(text);
}

/** Resolve a step reference captured from a pattern (e.g. "3", "pasul 3", "two") to a 0-based index. */
function resolveStepRef(
  ref: string,
  bodyNodes: ReadonlyArray<{ id: string; content: string }>,
): number | null {
  // Prefer numeric: find the first integer in the captured group
  const numMatch = ref.match(/\d+/);
  if (numMatch) {
    const n = parseInt(numMatch[0], 10);
    if (n >= 1 && n <= bodyNodes.length) return n - 1;
  }
  // Fallback: token overlap with node first-line
  const refToks = sopTokenize(ref);
  let best = -1, bestScore = 0;
  for (let i = 0; i < bodyNodes.length; i++) {
    const nodeToks = sopTokenize(bodyNodes[i]!.content.slice(0, 100));
    const score = jaccardSop(refToks, nodeToks);
    if (score > bestScore && score >= 0.2) { bestScore = score; best = i; }
  }
  return best >= 0 ? best : null;
}

/** Load live, non-metadata body nodes for a skill source (same filter as linkSkillSequence). */
function loadSkillBodyNodes(
  host: GraphnosisHost,
  graphId: string,
  sourceId: string,
): Array<{ id: string; content: string }> {
  const src = host.getSourceRecord(graphId, sourceId);
  if (!src) return [];
  const now = Date.now();
  const allNodes = host.listNodes(graphId);
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
  return src.nodeIds
    .filter((id) => {
      const n = nodeMap.get(id);
      if (!n || n.confidence <= 0.2) return false;
      if (n.validUntil !== undefined && n.validUntil <= now) return false;
      return !n.contentPreview.trimStart().startsWith('<!--');
    })
    .map((id) => ({
      id,
      content: host.getFullNodeContent(graphId, id) ?? nodeMap.get(id)!.contentPreview,
    }));
}

// ── linkSkillLoopsAndBranches ─────────────────────────────────────────────────

/**
 * Scan each live body node for loop and branch references; write directed
 * `precedes` (evidence `skill:loop`) and `depends-on` (evidence `skill:branch`)
 * edges. Idempotent — stale edges are removed before fresh ones are added.
 */
export async function linkSkillLoopsAndBranches(
  host: GraphnosisHost,
  graphId: string,
  sourceId: string,
): Promise<{ loopEdges: number; branchEdges: number }> {
  const bodyNodes = loadSkillBodyNodes(host, graphId, sourceId);
  if (bodyNodes.length < 2) return { loopEdges: 0, branchEdges: 0 };

  const nodeSet = new Set(bodyNodes.map((n) => n.id));
  const { directed } = host.listEdges(graphId);
  const stale = directed
    .filter(
      (e) =>
        // Loop edges may carry a `;max=N` cap suffix (see encodeLoopEvidence),
        // so match the base tag exactly OR with a `;`-prefixed suffix. Matching
        // only the bare form would leave stale capped-loop edges behind, breaking
        // idempotent edge derivation (Lemma 1). Branch edges are always bare, but
        // we apply the same suffix-tolerant match for consistency.
        (e.evidence === SKILL_LOOP_EVIDENCE ||
          e.evidence?.startsWith(SKILL_LOOP_EVIDENCE + ';') ||
          e.evidence === SKILL_BRANCH_EVIDENCE ||
          e.evidence?.startsWith(SKILL_BRANCH_EVIDENCE + ';')) &&
        (nodeSet.has(e.from) || nodeSet.has(e.to)),
    )
    .map((e) => e.id);
  if (stale.length > 0) await host.unlinkEdgesBatch(graphId, stale);

  const loopBatch: Array<{ from: string; to: string; type: 'precedes'; weight: number; evidence: string }> = [];
  const branchBatch: Array<{ from: string; to: string; type: 'depends-on'; weight: number; evidence: string }> = [];

  for (let i = 0; i < bodyNodes.length; i++) {
    const node = bodyNodes[i]!;

    for (const pat of LOOP_PATTERNS) {
      const m = node.content.match(pat);
      if (!m) continue;
      const j = resolveStepRef(m[1] ?? '', bodyNodes);
      if (j === null || j === i) continue;
      if (j < i) {
        // True loop: step i references an earlier step. Carry the optional
        // `max=N` convergence guard (group 2 of the explicit patterns).
        const maxIterations = m[2] ? parseInt(m[2], 10) : undefined;
        loopBatch.push({ from: node.id, to: bodyNodes[j]!.id, type: 'precedes', weight: 0.7, evidence: encodeLoopEvidence(maxIterations) });
      } else {
        // Forward skip — treat as branch
        branchBatch.push({ from: node.id, to: bodyNodes[j]!.id, type: 'depends-on', weight: 0.75, evidence: SKILL_BRANCH_EVIDENCE });
      }
      break; // one loop pattern per node is enough
    }

    for (const pat of BRANCH_PATTERNS) {
      const m = node.content.match(pat);
      if (!m) continue;
      const j = resolveStepRef(m[1] ?? '', bodyNodes);
      if (j === null || j === i) continue;
      branchBatch.push({ from: node.id, to: bodyNodes[j]!.id, type: 'depends-on', weight: 0.75, evidence: SKILL_BRANCH_EVIDENCE });
      break;
    }
  }

  if (loopBatch.length > 0)   await host.linkNodesDirectedBatch(graphId, loopBatch);
  if (branchBatch.length > 0) await host.linkNodesDirectedBatch(graphId, branchBatch);
  return { loopEdges: loopBatch.length, branchEdges: branchBatch.length };
}

// ── linkSkillContextEdges ─────────────────────────────────────────────────────

/**
 * Write `supports` (evidence `skill:ctx`) edges from inline recalled-memory
 * nodes to the body step they follow in source order.
 */
export async function linkSkillContextEdges(
  host: GraphnosisHost,
  graphId: string,
  sourceId: string,
): Promise<void> {
  const src = host.getSourceRecord(graphId, sourceId);
  if (!src) return;
  const now = Date.now();
  const allNodes = host.listNodes(graphId);
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  const liveIds = src.nodeIds.filter((id) => {
    const n = nodeMap.get(id);
    return n && n.confidence > 0.2 && !(n.validUntil !== undefined && n.validUntil <= now);
  });

  const { directed } = host.listEdges(graphId);
  const nodeSet = new Set(liveIds);
  const stale = directed
    .filter((e) => e.evidence === SKILL_CTX_EVIDENCE && (nodeSet.has(e.from) || nodeSet.has(e.to)))
    .map((e) => e.id);
  if (stale.length > 0) await host.unlinkEdgesBatch(graphId, stale);

  // Recalled-memory heuristic: content ends with "_(from ...)_" attribution marker
  const RECALLED_MARKER = /_\(from [^)]+\)_\s*$/;
  const batch: Array<{ from: string; to: string; type: 'supports'; weight: number; evidence: string }> = [];

  let lastBodyId: string | null = null;
  for (const id of liveIds) {
    const n = nodeMap.get(id);
    if (!n) continue;
    const preview = n.contentPreview;
    if (preview.trimStart().startsWith('<!--')) continue;
    if (RECALLED_MARKER.test(preview)) {
      if (lastBodyId) {
        batch.push({ from: id, to: lastBodyId, type: 'supports', weight: 0.6, evidence: SKILL_CTX_EVIDENCE });
      }
    } else {
      lastBodyId = id;
    }
  }
  if (batch.length > 0) await host.linkNodesDirectedBatch(graphId, batch);
}

// ── linkSkillGoals ────────────────────────────────────────────────────────────

/** Regex that identifies goal/constraint nodes by their content prefix.
 *
 * Six supported categories:
 *   Success:       — what good outcome looks like
 *   Out of scope:  — what the skill must refuse
 *   On completion: — expected deliverable
 *   Trigger:       — when an AI should invoke this skill autonomously
 *   Prerequisites: — what must be true before step 1 runs
 *   On failure:    — fallback / recovery behavior
 */
const GOAL_NODE_RE = /^(?:Success:|Out of scope:|On completion:|Trigger:|Prerequisites:|On failure:|Requires:|Produces:)/i;

/**
 * Write `contains` (evidence `skill:goal`) directed edges from the skill's
 * TITLE node to each goal/constraint node (Success, Out of scope, On completion).
 *
 * This makes goals reachable from the skill's hub node without polluting the
 * sequential `precedes` chain. An AI that recalls any goal node can hop to
 * the title and from there reach all body steps — goal nodes serve as
 * entry-points to the full skill structure.
 *
 * Idempotent — stale edges are removed first.
 */
export async function linkSkillGoals(
  host: GraphnosisHost,
  graphId: string,
  sourceId: string,
): Promise<{ goalEdges: number }> {
  const src = host.getSourceRecord(graphId, sourceId);
  if (!src) return { goalEdges: 0 };

  const now = Date.now();
  const allNodes = host.listNodes(graphId);
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  const liveIds = src.nodeIds.filter((id) => {
    const n = nodeMap.get(id);
    return n && n.confidence > 0.2 && !(n.validUntil !== undefined && n.validUntil <= now);
  });

  // Title = first live, non-metadata node in source order
  const titleId = liveIds.find((id) => {
    const n = nodeMap.get(id)!;
    return !n.contentPreview.trimStart().startsWith('<!--');
  });
  if (!titleId) return { goalEdges: 0 };

  const goalIds = liveIds.filter((id) => {
    const n = nodeMap.get(id)!;
    return GOAL_NODE_RE.test(n.contentPreview.trim());
  });

  // Remove stale skill:goal edges touching this source's nodes
  const nodeSet = new Set(liveIds);
  const { directed } = host.listEdges(graphId);
  const stale = directed
    .filter((e) => e.evidence === SKILL_GOAL_EVIDENCE && (nodeSet.has(e.from) || nodeSet.has(e.to)))
    .map((e) => e.id);
  if (stale.length > 0) await host.unlinkEdgesBatch(graphId, stale);

  if (goalIds.length === 0) return { goalEdges: 0 };

  // Title → goal edges (skill contains these constraints)
  const edges = goalIds.map((goalId) => ({
    from: titleId,
    to: goalId,
    type: 'contains' as const,
    weight: 0.85,
    evidence: SKILL_GOAL_EVIDENCE,
  }));
  await host.linkNodesDirectedBatch(graphId, edges);
  return { goalEdges: edges.length };
}

// ── Structured call syntax parser ──────────────────────────────────────────

export interface ParsedSkillCall {
  /** Target skill name (lowercased, trimmed). */
  target: string;
  /** Variable names passed as arguments (without the leading `$`). Empty array if none. */
  args: string[];
  /** Capture variable name (without the leading `$`). undefined if `-> $X` is absent. */
  captureAs?: string;
}

/**
 * Parse a node's text for the first structured `@skill:` call.
 *
 * Supported forms (richest match wins):
 *   `@skill: name`
 *   `@skill: name -> $capture`
 *   `@skill: name(arg=value, arg=$priorVar)`
 *   `@skill: name(arg=value, arg=$priorVar) -> $capture`
 *
 * Also matches the natural-language forms `[[skill: name]]` and
 * `use/run/follow/etc. the X skill` — though those don't carry args/capture.
 * Returns null when no call is found.
 */
export function parseSkillCall(text: string): ParsedSkillCall | null {
  // Prefer the full structured form. Anchored at start of line/word boundary.
  // Capture groups: 1=target, 2=arg-list (optional), 3=capture (optional)
  const structured = text.match(
    /@skill:\s*([A-Za-z0-9 _\-]+?)\s*(?:\(([^)]*)\))?\s*(?:->\s*\$([A-Za-z_][\w]*))?(?:\s*$|[\n.;])/i,
  );
  if (structured) {
    const target = (structured[1] ?? '').trim().toLowerCase();
    const rawArgs = structured[2];
    const captureAs = structured[3];
    const args: string[] = [];
    if (rawArgs) {
      for (const part of rawArgs.split(',')) {
        // Accept `arg=value`, `arg=$var`, or just `$var` / `var`
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf('=');
        const valueSide = eq >= 0 ? trimmed.slice(eq + 1).trim() : trimmed;
        const m = valueSide.match(/^\$?([A-Za-z_][\w]*)$/);
        if (m && m[1]) args.push(m[1]);
        else if (eq >= 0) {
          // For literal values (arg=foo), record the LHS as the argument name
          const lhs = trimmed.slice(0, eq).trim().match(/^([A-Za-z_][\w]*)$/);
          if (lhs && lhs[1]) args.push(lhs[1]);
        }
      }
    }
    return {
      target,
      args,
      ...(captureAs ? { captureAs } : {}),
    };
  }

  // Fallback patterns from the existing detector (no args / no capture)
  for (const pat of SKILL_CALL_PATTERNS) {
    const m = text.match(pat);
    if (!m) continue;
    const target = (m[1] ?? '').trim().toLowerCase();
    if (!target) continue;
    return { target, args: [] };
  }
  return null;
}

/** Encode parsed call metadata into the edge `evidence` string.
 *
 *   'skill:calls'                                          — bare reference
 *   'skill:calls;capture=foo'                              — captures return
 *   'skill:calls;args=a,b;capture=foo'                     — args + capture
 *   'skill:calls;onFailure=true'                           — call appears in `On failure:` block
 *   'skill:calls;args=a;capture=foo;onFailure=true'        — combinations
 */
export function encodeCallEvidence(parsed: ParsedSkillCall, opts: { onFailure?: boolean; parallel?: boolean } = {}): string {
  const parts: string[] = [SKILL_CALLS_EVIDENCE];
  if (parsed.args.length > 0) parts.push(`args=${parsed.args.join(',')}`);
  if (parsed.captureAs) parts.push(`capture=${parsed.captureAs}`);
  if (opts.onFailure) parts.push('onFailure=true');
  if (opts.parallel) parts.push('parallel=true');
  return parts.join(';');
}

/** Decode an `evidence` string written by encodeCallEvidence. */
export function parseCallEvidence(evidence: string | undefined): { args: string[]; captureAs?: string; onFailure: boolean; parallel: boolean } {
  const out: { args: string[]; captureAs?: string; onFailure: boolean; parallel: boolean } = { args: [], onFailure: false, parallel: false };
  if (!evidence) return out;
  const parts = evidence.split(';');
  for (let i = 1; i < parts.length; i++) { // skip 'skill:calls' base tag
    const part = parts[i]!;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'args') out.args = value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
    else if (key === 'capture') out.captureAs = value;
    else if (key === 'onFailure') out.onFailure = value === 'true';
    else if (key === 'parallel') out.parallel = value === 'true';
  }
  return out;
}

/** A parsed `@parallel:` group — concurrent sub-skill invocations (D4).
 *  Syntax: `@parallel: [skillA, skillB(arg=$x)] -> [$a, $b]` — dispatch the
 *  listed skills concurrently, capturing each return under the matching var. */
export interface ParsedParallelCall {
  members: Array<{ target: string; args: string[]; captureAs?: string }>;
}

/** Parse the first `@parallel: [...] -> [...]` group in a node's text. Returns
 *  null when absent. Each member may carry `(arg=$x)`; captures map positionally
 *  to the `-> [$a, $b]` list. */
export function parseParallelCall(text: string): ParsedParallelCall | null {
  const m = text.match(/@parallel:\s*\[([^\]]*)\]\s*(?:->\s*\[([^\]]*)\])?/i);
  if (!m) return null;
  const targets = (m[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const captures = (m[2] ?? '').split(',').map((s) => s.trim().replace(/^\$/, ''));
  const members: ParsedParallelCall['members'] = [];
  targets.forEach((t, i) => {
    const cm = t.match(/^([A-Za-z0-9 _\-]+?)\s*(?:\(([^)]*)\))?$/);
    const target = (cm?.[1] ?? t).trim().toLowerCase();
    if (!target) return;
    const args: string[] = [];
    if (cm?.[2]) {
      for (const part of cm[2].split(',')) {
        const eq = part.indexOf('=');
        const valueSide = (eq >= 0 ? part.slice(eq + 1) : part).trim();
        const vm = valueSide.match(/^\$?([A-Za-z_]\w*)$/);
        if (vm?.[1]) args.push(vm[1]);
      }
    }
    const cap = captures[i];
    members.push({ target, args, ...(cap ? { captureAs: cap } : {}) });
  });
  return members.length > 0 ? { members } : null;
}

// ── linkSkillCalls ────────────────────────────────────────────────────────────

/**
 * Detect sub-skill invocations in body node text AND in `On failure:` goal nodes.
 * Writes `contains` directed edges from the referencing node to the called
 * skill's title node. Args/capture/onFailure metadata is encoded in the edge's
 * `evidence` string (see encodeCallEvidence).
 */
export async function linkSkillCalls(
  host: GraphnosisHost,
  graphId: string,
  sourceId: string,
  skillsGraphId: string,
): Promise<{ callEdges: number }> {
  const src = host.getSourceRecord(graphId, sourceId);
  if (!src) return { callEdges: 0 };

  const now = Date.now();
  const allNodes = host.listNodes(graphId);
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  // Live, non-metadata nodes in source order. We scan ALL of them (body steps
  // AND goal nodes) because `On failure:` goal nodes can also carry @skill: refs.
  const liveNodes = src.nodeIds
    .filter((id) => {
      const n = nodeMap.get(id);
      return n && n.confidence > 0.2 && !(n.validUntil !== undefined && n.validUntil <= now)
        && !n.contentPreview.trimStart().startsWith('<!--');
    })
    .map((id) => ({
      id,
      content: host.getFullNodeContent(graphId, id) ?? nodeMap.get(id)!.contentPreview,
    }));

  // Build name → {sourceId, titleNodeId} map from all OTHER skills in the engram
  const skillSources = host.listSources(skillsGraphId).filter(
    (s) => s.kind === 'skill' && s.sourceId !== sourceId,
  );
  const targetNodeMap = new Map(host.listNodes(skillsGraphId).map((n) => [n.id, n]));
  type SkillRef = { sourceId: string; titleNodeId: string; name: string };
  const skillIndex: SkillRef[] = [];
  for (const s of skillSources) {
    const titleId = s.nodeIds.find((id) => {
      const n = targetNodeMap.get(id);
      return n && n.confidence > 0.2 && !(n.validUntil !== undefined && n.validUntil <= now)
        && !n.contentPreview.trimStart().startsWith('<!--');
    });
    if (!titleId) continue;
    const name = (host.getFullNodeContent(skillsGraphId, titleId) ?? targetNodeMap.get(titleId)!.contentPreview)
      .trim().toLowerCase();
    skillIndex.push({ sourceId: s.sourceId, titleNodeId: titleId, name });
    const refLabel = s.ref.replace(/^skill:\d+:/, '').trim().toLowerCase();
    if (refLabel && refLabel !== name) {
      skillIndex.push({ sourceId: s.sourceId, titleNodeId: titleId, name: refLabel });
    }
  }

  const nodeSet = new Set(liveNodes.map((n) => n.id));
  const { directed } = host.listEdges(graphId);
  const stale = directed
    // Match any edge whose evidence starts with the SKILL_CALLS_EVIDENCE base tag,
    // since structured-call edges have `;capture=...` etc. appended.
    .filter((e) => e.evidence?.startsWith(SKILL_CALLS_EVIDENCE) &&
      (nodeSet.has(e.from) || nodeSet.has(e.to)))
    .map((e) => e.id);
  if (stale.length > 0) await host.unlinkEdgesBatch(graphId, stale);

  const batch: Array<{ from: string; to: string; type: 'contains'; weight: number; evidence: string }> = [];

  const resolveTarget = (captured: string): SkillRef | null => {
    let best: SkillRef | null = null;
    let bestLen = 0;
    for (const ref of skillIndex) {
      if (captured.includes(ref.name) || ref.name.includes(captured)) {
        if (ref.name.length > bestLen) { bestLen = ref.name.length; best = ref; }
      }
    }
    return best;
  };

  for (const node of liveNodes) {
    // D4 — a `@parallel: [...]` group emits one call edge per member, each
    // tagged `parallel=true` so the walk groups them into a concurrent dispatch.
    const parallel = parseParallelCall(node.content);
    if (parallel) {
      for (const member of parallel.members) {
        const target = resolveTarget(member.target);
        if (!target) continue;
        batch.push({
          from: node.id,
          to: target.titleNodeId,
          type: 'contains',
          weight: 0.95,
          evidence: encodeCallEvidence(
            { target: member.target, args: member.args, ...(member.captureAs ? { captureAs: member.captureAs } : {}) },
            { parallel: true },
          ),
        });
      }
      continue;
    }

    const parsed = parseSkillCall(node.content);
    if (!parsed || !parsed.target) continue;
    const target = resolveTarget(parsed.target);
    if (!target) continue;

    // Detect whether this node is an `On failure:` goal (cross-skill recovery)
    const isFailureGoal = /^On failure:/i.test(node.content.trim());
    const evidence = encodeCallEvidence(parsed, { onFailure: isFailureGoal });

    batch.push({
      from: node.id,
      to: target.titleNodeId,
      type: 'contains',
      weight: 0.95,
      evidence,
    });
  }

  if (batch.length > 0) await host.linkNodesDirectedBatch(graphId, batch);
  return { callEdges: batch.length };
}

// ── Cross-engram skill calls (D1) ─────────────────────────────────────────────

/** Engrams that contain at least one trained skill — the candidate set for
 *  cross-engram call resolution. */
export function skillEngramIds(host: GraphnosisHost): string[] {
  return host.listGraphs().filter((g) => host.listSources(g).some((s) => s.kind === 'skill'));
}

interface SkillIndexEntry { sourceId: string; titleNodeId: string; title: string; matchName: string; }

/** Build a name→skill index for one engram: each skill contributes its title
 *  (lowercased) and its source-ref label as match names. Mirrors the inline
 *  index linkSkillCalls builds, reused for cross-engram resolution. */
function buildSkillIndex(host: GraphnosisHost, graphId: string, excludeSourceId?: string): SkillIndexEntry[] {
  const now = Date.now();
  const nodeMap = new Map(host.listNodes(graphId).map((n) => [n.id, n]));
  const isLive = (id: string): boolean => {
    const n = nodeMap.get(id);
    return !!n && n.confidence > 0.2 && !(n.validUntil !== undefined && n.validUntil <= now)
      && !n.contentPreview.trimStart().startsWith('<!--');
  };
  const out: SkillIndexEntry[] = [];
  for (const s of host.listSources(graphId)) {
    if (s.kind !== 'skill' || s.sourceId === excludeSourceId) continue;
    const titleId = s.nodeIds.find(isLive);
    if (!titleId) continue;
    const title = (host.getFullNodeContent(graphId, titleId) ?? nodeMap.get(titleId)!.contentPreview).trim();
    const name = title.toLowerCase();
    out.push({ sourceId: s.sourceId, titleNodeId: titleId, title, matchName: name });
    const refLabel = s.ref.replace(/^skill:\d+:/, '').trim().toLowerCase();
    if (refLabel && refLabel !== name) out.push({ sourceId: s.sourceId, titleNodeId: titleId, title, matchName: refLabel });
  }
  return out;
}

/** Longest-match resolve a target name against a skill index (same heuristic as
 *  linkSkillCalls.resolveTarget). */
function resolveInIndex(index: SkillIndexEntry[], target: string): SkillIndexEntry | null {
  let best: SkillIndexEntry | null = null;
  let bestLen = 0;
  for (const e of index) {
    if (target.includes(e.matchName) || e.matchName.includes(target)) {
      if (e.matchName.length > bestLen) { bestLen = e.matchName.length; best = e; }
    }
  }
  return best;
}

/**
 * Resolve `@skill:` / `@parallel:` references that DON'T match a skill in the
 * caller's own engram against OTHER skill engrams, and persist the hits in the
 * cross-engram side-table (D1). The SDK can't represent a cross-graph edge, so
 * this is how cross-engram calls are recorded; the walk consults the table to
 * surface them. Idempotent per caller source (replaces its prior links).
 *
 * @param candidateGraphIds engrams to search for targets (the caller's own is
 *   skipped — same-engram calls are handled by intra-graph edges in
 *   linkSkillCalls).
 */
export async function linkCrossEngramCalls(
  host: GraphnosisHost,
  store: SkillCallLinkStore,
  callerGraphId: string,
  callerSourceId: string,
  candidateGraphIds: string[],
): Promise<{ crossLinks: number }> {
  const src = host.getSourceRecord(callerGraphId, callerSourceId);
  if (!src) { await store.setForSource(callerGraphId, callerSourceId, []); return { crossLinks: 0 }; }

  const now = Date.now();
  const callerNodeMap = new Map(host.listNodes(callerGraphId).map((n) => [n.id, n]));
  const liveNodes = src.nodeIds
    .filter((id) => {
      const n = callerNodeMap.get(id);
      return n && n.confidence > 0.2 && !(n.validUntil !== undefined && n.validUntil <= now)
        && !n.contentPreview.trimStart().startsWith('<!--');
    })
    .map((id) => ({ id, content: host.getFullNodeContent(callerGraphId, id) ?? callerNodeMap.get(id)!.contentPreview }));

  const ownIndex = buildSkillIndex(host, callerGraphId, callerSourceId);
  const otherIndices = candidateGraphIds
    // QUARANTINE CONTRACT: a cross-engram `@skill:` reference must NEVER resolve
    // INTO a quarantined (imported-but-unpromoted) engram — that would make an
    // un-adjudicated skill reachable via dispatch. Routed through host.isQuarantined.
    .filter((g) => g !== callerGraphId && !host.isQuarantined(g))
    .map((g) => ({ graphId: g, index: buildSkillIndex(host, g) }));

  const links: SkillCallLink[] = [];
  const record = (nodeId: string, targetName: string, args: string[], captureAs: string | undefined, onFailure: boolean, parallel: boolean): void => {
    if (resolveInIndex(ownIndex, targetName)) return; // same-engram → intra-graph edge already handles it
    for (const oi of otherIndices) {
      const hit = resolveInIndex(oi.index, targetName);
      if (hit) {
        links.push({
          callerGraphId, callerSourceId, callerNodeId: nodeId, targetName,
          targetGraphId: oi.graphId, targetSourceId: hit.sourceId, targetTitle: hit.title.slice(0, 200),
          args, ...(captureAs ? { captureAs } : {}), onFailure, parallel,
        });
        return; // first matching engram wins
      }
    }
  };

  for (const node of liveNodes) {
    const parallel = parseParallelCall(node.content);
    if (parallel) {
      for (const m of parallel.members) record(node.id, m.target, m.args, m.captureAs, false, true);
      continue;
    }
    const parsed = parseSkillCall(node.content);
    if (parsed?.target) {
      const isFailure = /^On failure:/i.test(node.content.trim());
      record(node.id, parsed.target, parsed.args, parsed.captureAs, isFailure, false);
    }
  }

  await store.setForSource(callerGraphId, callerSourceId, links);
  return { crossLinks: links.length };
}

/**
 * After skill A is saved, edges FROM other skills TO A's title node may have
 * become stale (the title node id likely changed during retrain). Re-run
 * linkSkillCalls on every OTHER skill source in the same engram so any
 * `@skill: A` reference gets re-pointed to A's new title node.
 *
 * O(n_skills) per retrain — acceptable for typical Skills engrams.
 */
export async function refreshIncomingCallsToSkill(
  host: GraphnosisHost,
  graphId: string,
  sourceId: string,
): Promise<{ rewired: number }> {
  const others = host.listSources(graphId).filter(
    (s) => s.kind === 'skill' && s.sourceId !== sourceId,
  );
  let rewired = 0;
  for (const s of others) {
    try {
      const res = await linkSkillCalls(host, graphId, s.sourceId, graphId);
      rewired += res.callEdges;
    } catch { /* per-source failure is non-fatal */ }
  }
  return { rewired };
}

// ── placeRecalledNodes (Phase 2 — surgical placement) ────────────────────────

interface PlacementCandidate { text: string; layer: InfluentialNode['layer'] }
interface PlacementResult    { text: string; position: number | 'context'; confidence: number }

function tripletCoherence(
  prev: string | null,
  candidate: string,
  next: string | null,
): number {
  const prevSents = prev ? splitSentences(prev) : [];
  const candSents = splitSentences(candidate);
  const nextSents = next ? splitSentences(next) : [];

  const prevLast = prevSents[prevSents.length - 1] ?? '';
  const candFirst = candSents[0] ?? '';
  const candLast  = candSents[candSents.length - 1] ?? '';
  const nextFirst = nextSents[0] ?? '';

  const scoreIn  = prev  ? jaccardSop(sopTokenize(prevLast), sopTokenize(candFirst)) : 0.5;
  const scoreOut = next  ? jaccardSop(sopTokenize(candLast),  sopTokenize(nextFirst)) : 0.5;
  return (scoreIn + scoreOut) / 2;
}

function placeRecalledNodesDeterministic(
  candidates: PlacementCandidate[],
  bodyTexts: string[],
): PlacementResult[] {
  return candidates.map((cand) => {
    if (isNonLatinScript(cand.text) && bodyTexts.some(isNonLatinScript)) {
      // Non-Latin script + no LLM → safe fallback
      return { text: cand.text, position: 'context', confidence: 0 };
    }
    const candToks = sopTokenize(cand.text);
    let bestPos = 'context' as number | 'context';
    let bestScore = 0.25; // minimum threshold to earn an inline position
    for (let p = 0; p <= bodyTexts.length; p++) {
      const prev = bodyTexts[p - 1] ?? null;
      const next = bodyTexts[p] ?? null;
      const sim =
        0.6 * jaccardSop(candToks, sopTokenize(prev ?? '')) +
        0.4 * jaccardSop(candToks, sopTokenize(next ?? ''));
      const coh = tripletCoherence(prev, cand.text, next);
      const score = 0.5 * sim + 0.5 * coh;
      if (score > bestScore) { bestScore = score; bestPos = p; }
    }
    return { text: cand.text, position: bestPos, confidence: bestScore };
  });
}

/**
 * Decide where each recalled candidate paragraph belongs in the skill sequence.
 *
 * With LLM: sends a single structured prompt; falls back to deterministic on failure.
 * Without LLM: uses Jaccard similarity + triplet coherence.
 *
 * Returns positions relative to body-node order (0 = before first body node,
 * N = after last body node). `'context'` = append to context section at the end.
 */
export async function placeRecalledNodes(
  candidates: PlacementCandidate[],
  bodyTexts: string[],
  llm: import('./correction.js').LocalLlm | null,
): Promise<PlacementResult[]> {
  if (candidates.length === 0 || bodyTexts.length === 0) {
    return candidates.map((c) => ({ text: c.text, position: 'context', confidence: 0 }));
  }

  if (llm) {
    try {
      const stepsBlock = bodyTexts.map((t, i) => `[${i + 1}] ${t.slice(0, 200)}`).join('\n');
      const fragsBlock = candidates.map((c, i) => `[${i}] "${c.text.slice(0, 150)}"`).join('\n');
      const raw = await llm.complete({
        system: [
          'The skill content may be in any language or a mix of languages.',
          'You are placing recalled memory fragments into a step-by-step procedure.',
          'The sequence must read like a coherent SOP — prev step → fragment → next step must flow logically.',
          'Return ONLY JSON: {"placements":[{"index":0,"position":2,"confidence":0.87},...]}',
          'position = 0 means before step 1, N means after step N, "context" = no good fit.',
          'confidence < 0.5 or position="context" → context section.',
        ].join(' '),
        user: `== PROCEDURE STEPS ==\n${stepsBlock}\n\n== RECALLED FRAGMENTS TO PLACE ==\n${fragsBlock}`,
      });
      const parsed = JSON.parse(raw.trim()) as {
        placements: Array<{ index: number; position: number | 'context'; confidence: number }>;
      };
      const results: PlacementResult[] = candidates.map((c) => ({
        text: c.text, position: 'context' as const, confidence: 0,
      }));
      for (const p of parsed.placements ?? []) {
        if (p.index < 0 || p.index >= results.length) continue;
        const pos = p.position === 'context' || p.confidence < 0.5 ? 'context' : p.position;
        results[p.index] = { text: candidates[p.index]!.text, position: pos, confidence: p.confidence };
      }
      return results;
    } catch {
      // LLM failed — fall through to deterministic
    }
  }

  return placeRecalledNodesDeterministic(candidates, bodyTexts);
}

// ── walkSkillSequence + formatSkillForRecall (Phase 3) ───────────────────────

export interface StepNode {
  nodeId: string;
  text: string;
  /** 0-based index in the linear chain */
  index: number;
  isBranchPoint: boolean;
  isLoopBack: boolean;
  /** Resolved sub-skill call. `targetGraphId` is set only for a cross-engram
   *  call (D1 — target lives in another engram, resolved via the side-table);
   *  absent for same-engram calls. */
  callsSkill?: {
    targetSourceId: string;
    targetTitle: string;
    targetGraphId?: string;
    /** Variable names passed as args (from `@skill: name(arg=$var)`). */
    args: string[];
    /** Variable name to store the call's return under (from `-> $capture`). */
    captureAs?: string;
  };
  /** Resolved concurrent sub-skill calls (D4 — from `@parallel: [a, b] -> [$x,
   *  $y]`). When present, the executor dispatches all members concurrently.
   *  Mutually exclusive with callsSkill. Members may be cross-engram (D1). */
  parallelCalls?: Array<{
    targetSourceId: string;
    targetTitle: string;
    targetGraphId?: string;
    args: string[];
    captureAs?: string;
  }>;
  /** Skill-call reference text that did not resolve to any existing skill.
   *  Surfaces in the JSON plan so the AI executor knows there's an
   *  unfulfillable reference (sub-skill not found / typo / cross-engram). */
  unresolvedCall?: string;
}

export interface FailureHandler {
  /** The full text of the `On failure:` goal node, with the prefix stripped. */
  description: string;
  /** Resolved recovery skill — present when an `@skill: name` reference inside
   *  the `On failure:` goal was matched to an existing skill in this engram. */
  targetSourceId?: string;
  targetTitle?: string;
  args: string[];
  /** Set when the `@skill:` reference inside the goal didn't resolve. */
  unresolvedCall?: string;
}

export interface GoalNode {
  text: string;
  kind: 'success' | 'scope' | 'completion' | 'trigger' | 'prereq' | 'failure' | 'requires' | 'produces' | 'generic';
}

export interface WalkedSkill {
  steps: StepNode[];
  goals: GoalNode[];
  contextNodes: Array<{ text: string; anchorStepIndex: number | null }>;
  /** [fromStepIndex, toStepIndex, maxIterations?] tuples for loop edges. The
   *  optional third element is the D2 loop-convergence cap (`@loop: N max=M`). */
  loops: Array<[number, number, number?]>;
  /** [fromStepIndex, toStepIndex] pairs for branch edges */
  branches: Array<[number, number]>;
  /** Recovery skills declared in `On failure:` goal nodes. */
  failureHandlers: FailureHandler[];
}

const RECALLED_MARKER_RE = /_\(from [^)]+\)_\s*$/;

/**
 * Walk a skill source as an SOP, returning steps in source order annotated
 * with loop, branch, and sub-skill metadata derived from the edge graph.
 *
 * The linear chain is always reconstructed from `nodeIds` source order
 * (not by traversing edges), so loop back-edges never cause infinite recursion.
 */
export function walkSkillSequence(
  host: GraphnosisHost,
  graphId: string,
  sourceId: string,
  opts: { recursive?: boolean; crossEngramLinks?: SkillCallLink[] } = {},
): WalkedSkill {
  const src = host.getSourceRecord(graphId, sourceId);
  if (!src) return { steps: [], goals: [], contextNodes: [], loops: [], branches: [], failureHandlers: [] };

  const now = Date.now();
  const allNodes = host.listNodes(graphId);
  const nodeMap = new Map(allNodes.map((n) => [n.id, n]));

  // Live nodes in source order, excluding metadata comments
  const liveIds = src.nodeIds.filter((id) => {
    const n = nodeMap.get(id);
    return n && n.confidence > 0.2 && !(n.validUntil !== undefined && n.validUntil <= now)
      && !n.contentPreview.trimStart().startsWith('<!--');
  });

  // Partition: body steps / goal constraints / recalled-memory context nodes.
  // Keep failure-goal node ids tracked separately — they may carry @skill: refs
  // that walkSkillSequence promotes into failureHandlers below.
  const bodyIds: string[] = [];
  const goalNodes: GoalNode[] = [];
  const ctxIds: string[] = [];
  const failureGoalIds: string[] = [];
  for (const id of liveIds) {
    const n = nodeMap.get(id)!;
    const preview = n.contentPreview.trim();
    const fullText = host.getFullNodeContent(graphId, id) ?? preview;
    if (RECALLED_MARKER_RE.test(preview)) {
      ctxIds.push(id);
    } else {
      const goalKind = classifyGoalKind(preview);
      if (goalKind) {
        if (goalKind === 'failure') failureGoalIds.push(id);
        goalNodes.push({ text: fullText, kind: goalKind });
      } else {
        bodyIds.push(id);
      }
    }
  }

  const stepIndexOf = new Map(bodyIds.map((id, i) => [id, i]));
  const nodeSet = new Set(liveIds);
  const { directed } = host.listEdges(graphId);

  // Loop edges carry an optional `;max=N` cap, so match the base tag (exact or
  // with a suffix) rather than strict equality.
  const loopEdges   = directed.filter((e) => (e.evidence === SKILL_LOOP_EVIDENCE || e.evidence?.startsWith(SKILL_LOOP_EVIDENCE + ';')) && nodeSet.has(e.from) && nodeSet.has(e.to));
  const branchEdges = directed.filter((e) => e.evidence === SKILL_BRANCH_EVIDENCE && nodeSet.has(e.from) && nodeSet.has(e.to));
  // Call edges' evidence starts with 'skill:calls' but may carry suffixes
  // like ';capture=foo;args=a,b;onFailure=true'.
  const callEdges   = directed.filter((e) => e.evidence?.startsWith(SKILL_CALLS_EVIDENCE) && nodeSet.has(e.from));
  const ctxEdges    = directed.filter((e) => e.evidence === SKILL_CTX_EVIDENCE    && nodeSet.has(e.from));

  // Resolve sub-skill call targets — find the owning source for each target node
  // so we can return its sourceId (not the current skill's sourceId, which was
  // the bug). A node may have MULTIPLE call edges when it's a `@parallel:` group
  // (D4), so collect them per node rather than one-per-node.
  interface CallMeta {
    targetSourceId: string;
    targetTitle: string;
    args: string[];
    captureAs?: string;
    onFailure: boolean;
    parallel: boolean;
  }
  const callsByNode = new Map<string, CallMeta[]>();
  const allSources = host.listSources(graphId);
  for (const e of callEdges) {
    const targetText = host.getFullNodeContent(graphId, e.to) ??
      nodeMap.get(e.to)?.contentPreview ?? '';
    const owner = allSources.find((s) => s.nodeIds.includes(e.to));
    const evidence = parseCallEvidence(e.evidence ?? '');
    const arr = callsByNode.get(e.from) ?? [];
    arr.push({
      targetSourceId: owner?.sourceId ?? src.sourceId,
      targetTitle: targetText.trim().slice(0, 200),
      args: evidence.args,
      ...(evidence.captureAs ? { captureAs: evidence.captureAs } : {}),
      onFailure: evidence.onFailure,
      parallel: evidence.parallel,
    });
    callsByNode.set(e.from, arr);
  }

  // Cross-engram side-table hits (D1) scoped to this caller node. These carry a
  // targetGraphId; in-engram edge calls don't.
  const crossLinks = opts.crossEngramLinks ?? [];
  interface UnifiedCall { targetSourceId: string; targetTitle: string; args: string[]; captureAs?: string; parallel: boolean; targetGraphId?: string }

  const steps: StepNode[] = bodyIds.map((id, i) => {
    const text = host.getFullNodeContent(graphId, id) ?? nodeMap.get(id)!.contentPreview;
    const inEngram: UnifiedCall[] = (callsByNode.get(id) ?? []).map((c) => ({
      targetSourceId: c.targetSourceId, targetTitle: c.targetTitle, args: c.args,
      ...(c.captureAs ? { captureAs: c.captureAs } : {}), parallel: c.parallel,
    }));
    const cross: UnifiedCall[] = crossLinks.filter((l) => l.callerNodeId === id).map((l) => ({
      targetSourceId: l.targetSourceId, targetTitle: l.targetTitle, args: l.args,
      ...(l.captureAs ? { captureAs: l.captureAs } : {}), parallel: l.parallel, targetGraphId: l.targetGraphId,
    }));
    const calls: UnifiedCall[] = [...inEngram, ...cross];
    const parallelMembers = calls.filter((c) => c.parallel);
    const single = calls.find((c) => !c.parallel);
    // Detect unresolved calls: text references a sub-skill (@skill: or
    // @parallel:) but neither an edge nor a cross-engram link resolved.
    const parsedFromText = parseSkillCall(text);
    const parsedParallel = parseParallelCall(text);
    const unresolvedName = calls.length === 0
      ? (parsedParallel?.members[0]?.target ?? parsedFromText?.target)
      : undefined;
    return {
      nodeId: id,
      text,
      index: i,
      isBranchPoint: branchEdges.some((e) => e.from === id),
      isLoopBack:    loopEdges.some((e) => e.from === id),
      ...(parallelMembers.length > 0 ? {
        parallelCalls: parallelMembers.map((m) => ({
          targetSourceId: m.targetSourceId,
          targetTitle: m.targetTitle,
          args: m.args,
          ...(m.captureAs ? { captureAs: m.captureAs } : {}),
          ...(m.targetGraphId ? { targetGraphId: m.targetGraphId } : {}),
        })),
      } : single ? {
        callsSkill: {
          targetSourceId: single.targetSourceId,
          targetTitle: single.targetTitle,
          args: single.args,
          ...(single.captureAs ? { captureAs: single.captureAs } : {}),
          ...(single.targetGraphId ? { targetGraphId: single.targetGraphId } : {}),
        },
      } : {}),
      ...(unresolvedName ? { unresolvedCall: unresolvedName } : {}),
    };
  });

  // ── Failure handlers — promote `On failure:` goal-node calls ────────────
  // Each `On failure:` goal node may have a `@skill: name` ref. If it
  // resolved (edge exists with onFailure=true), surface the target. If it
  // didn't resolve, surface the unresolved name so the AI client sees the gap.
  const failureHandlers: FailureHandler[] = [];
  for (const goalNodeId of failureGoalIds) {
    const text = host.getFullNodeContent(graphId, goalNodeId) ??
      nodeMap.get(goalNodeId)?.contentPreview ?? '';
    const description = text.replace(GOAL_PREFIX_STRIP_RE, '').trim();
    // Failure goals carry a single recovery call (not a parallel group).
    const meta = (callsByNode.get(goalNodeId) ?? [])[0];
    if (meta && meta.onFailure) {
      failureHandlers.push({
        description,
        targetSourceId: meta.targetSourceId,
        targetTitle: meta.targetTitle,
        args: meta.args,
      });
    } else {
      const parsedFromText = parseSkillCall(text);
      if (parsedFromText && parsedFromText.target) {
        failureHandlers.push({
          description,
          args: parsedFromText.args,
          unresolvedCall: parsedFromText.target,
        });
      } else {
        // Pure-prose failure description (no skill call) — still useful to the AI.
        failureHandlers.push({ description, args: [] });
      }
    }
  }

  // If recursive, inline sub-skill steps
  if (opts.recursive) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]!;
      if (!step.callsSkill) continue;
      try {
        // Try to find the target sourceId by walking call edges from this node
        const callEdge = callEdges.find((e) => e.from === step.nodeId);
        if (!callEdge) continue;
        // Find which source owns the target node
        const targetSources = host.listSources(graphId).filter((s) =>
          s.nodeIds.includes(callEdge.to),
        );
        if (!targetSources[0]) continue;
        const subWalked = walkSkillSequence(host, graphId, targetSources[0].sourceId, { recursive: false });
        const subSteps = subWalked.steps.map((ss) => ({
          ...ss,
          index: i + ss.index, // offset for display
          text: `  [Sub-skill: ${step.callsSkill!.targetTitle}] ${ss.text}`,
        }));
        steps.splice(i + 1, 0, ...subSteps);
      } catch { /* sub-skill expansion failure is non-fatal */ }
    }
  }

  const contextNodes = ctxIds.map((id) => {
    const text = host.getFullNodeContent(graphId, id) ?? nodeMap.get(id)!.contentPreview;
    const ctxEdge = ctxEdges.find((e) => e.from === id);
    const anchorStepIndex = ctxEdge ? (stepIndexOf.get(ctxEdge.to) ?? null) : null;
    return { text, anchorStepIndex };
  });

  const loops: Array<[number, number, number?]> = loopEdges
    .map((e) => [stepIndexOf.get(e.from) ?? -1, stepIndexOf.get(e.to) ?? -1, parseLoopMax(e.evidence)] as [number, number, number?])
    .filter(([a, b]) => a >= 0 && b >= 0);
  const branches: Array<[number, number]> = branchEdges
    .map((e) => [stepIndexOf.get(e.from) ?? -1, stepIndexOf.get(e.to) ?? -1] as [number, number])
    .filter(([a, b]) => a >= 0 && b >= 0);

  return { steps, goals: goalNodes, contextNodes, loops, branches, failureHandlers };
}

const GOAL_KIND_PREFIX: Record<GoalNode['kind'], string> = {
  success:    '✓ Success:',
  scope:      '✗ Out of scope:',
  completion: '⊙ On completion:',
  trigger:    '⚡ Trigger:',
  prereq:     '🔑 Prerequisites:',
  failure:    '⚠ On failure:',
  requires:   '🔌 Requires:',
  produces:   '📤 Produces:',
  generic:    '→',
};

/** Strip-prefix regex used by formatSkillForRecall and walkSkillToJson to
 *  remove the redundant `Success:` / `Out of scope:` / etc. text prefix
 *  before re-emitting with the symbol prefix above. */
const GOAL_PREFIX_STRIP_RE = /^(?:Success:|Out of scope:|On completion:|Trigger:|Prerequisites:|On failure:|Requires:|Produces:)\s*/i;

/** Strip emoji / markdown decoration before classifying or rendering goal lines. */
function stripGoalLineDecorators(text: string): string {
  return text.trim()
    .replace(/^(?:[-*•]\s*)+/, '')
    .replace(/^(?:[⚡🔑✓✗⚠📤🔌⊙→◆▹▪]+\s*)+/, '')
    .replace(/^\*\*(.+?)\*\*\s*/, '$1 ')
    .trim();
}

function classifyGoalKind(preview: string): GoalNode['kind'] | null {
  const t = stripGoalLineDecorators(preview);
  if (/^Success:/i.test(t)) return 'success';
  if (/^Out of scope:/i.test(t)) return 'scope';
  if (/^On completion:/i.test(t)) return 'completion';
  if (/^Trigger:/i.test(t)) return 'trigger';
  if (/^Prerequisites:/i.test(t)) return 'prereq';
  if (/^On failure:/i.test(t)) return 'failure';
  if (/^Requires:/i.test(t)) return 'requires';
  if (/^Produces:/i.test(t)) return 'produces';
  return null;
}

function formatGoalMarkdownLines(kind: GoalNode['kind'], rawText: string): string[] {
  const label = GOAL_KIND_MD_LABEL[kind];
  const body = stripGoalLineDecorators(rawText).replace(GOAL_PREFIX_STRIP_RE, '').trim();
  if (!body || body === ':string') return [];
  const merged = body.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  return [`- **${label}:** ${merged}`];
}

/** Format a WalkedSkill as a readable SOP text for AI clients.
 *
 * Output order: CONSTRAINTS block (goals) → PROCEDURE (sequential steps).
 * Goals first because an AI reading the skill needs to know its operating
 * boundaries BEFORE it starts following steps. */
export function formatSkillForRecall(walked: WalkedSkill): string {
  const lines: string[] = [];

  // ── Constraints block ────────────────────────────────────────────────────
  if (walked.goals.length > 0) {
    lines.push('CONSTRAINTS:');
    for (const g of walked.goals) {
      const prefix = GOAL_KIND_PREFIX[g.kind];
      // Strip the redundant "Success: / Out of scope: / On completion:" prefix
      // from the stored text since we're replacing it with the symbol prefix.
      const body = g.text.replace(GOAL_PREFIX_STRIP_RE, '').trim();
      lines.push(`  ${prefix} ${body}`);
    }
    lines.push('');
  }

  // ── Procedure ────────────────────────────────────────────────────────────
  if (walked.steps.length > 0) {
    lines.push(`PROCEDURE (${walked.steps.length} step${walked.steps.length === 1 ? '' : 's'}):`);
    for (const step of walked.steps) {
      lines.push(`  Step ${step.index + 1}: ${step.text}`);
      for (const ctx of walked.contextNodes) {
        if (ctx.anchorStepIndex === step.index) lines.push(`    → Context: ${ctx.text}`);
      }
      if (step.callsSkill) {
        const argsPart = step.callsSkill.args.length > 0
          ? ` with $${step.callsSkill.args.join(', $')}`
          : '';
        const capturePart = step.callsSkill.captureAs
          ? `, capture result as $${step.callsSkill.captureAs}`
          : '';
        lines.push(`    → INVOKES SKILL: ${step.callsSkill.targetTitle}${argsPart}${capturePart}`);
      }
      if (step.parallelCalls && step.parallelCalls.length > 0) {
        const names = step.parallelCalls.map((p) => {
          const a = p.args.length > 0 ? ` with $${p.args.join(', $')}` : '';
          const c = p.captureAs ? ` → $${p.captureAs}` : '';
          return `${p.targetTitle}${a}${c}`;
        });
        lines.push(`    → INVOKES IN PARALLEL: ${names.join(' | ')}`);
      }
      if (step.unresolvedCall) {
        lines.push(`    → ⚠ UNRESOLVED CALL: "${step.unresolvedCall}" — sub-skill not found in this engram`);
      }
      if (step.isBranchPoint) {
        const targets = walked.branches.filter(([f]) => f === step.index).map(([, t]) => `step ${t + 1}`);
        lines.push(`    → BRANCHES to ${targets.join(' or ')} on condition`);
      }
      if (step.isLoopBack) {
        const stepLoops = walked.loops.filter(([f]) => f === step.index);
        const targets = stepLoops.map(([, t]) => `step ${t + 1}`);
        const maxCap = stepLoops.find(([, , m]) => m !== undefined)?.[2];
        const capPart = maxCap !== undefined ? ` (max ${maxCap} iteration${maxCap === 1 ? '' : 's'})` : '';
        lines.push(`    → LOOPS BACK to ${targets.join(', ')}${capPart}`);
      }
    }
  }

  const unanchored = walked.contextNodes.filter((c) => c.anchorStepIndex === null);
  if (unanchored.length > 0) {
    lines.push('');
    lines.push('Supporting Context:');
    for (const ctx of unanchored) lines.push(`  - ${ctx.text}`);
  }

  if (walked.failureHandlers.length > 0) {
    lines.push('');
    lines.push('FAILURE HANDLERS:');
    for (const h of walked.failureHandlers) {
      if (h.targetTitle) {
        const argsPart = h.args.length > 0 ? ` with $${h.args.join(', $')}` : '';
        lines.push(`  → On failure: ${h.description}`);
        lines.push(`     RECOVERY SKILL: ${h.targetTitle}${argsPart}`);
      } else if (h.unresolvedCall) {
        lines.push(`  → On failure: ${h.description}`);
        lines.push(`     ⚠ UNRESOLVED RECOVERY SKILL: "${h.unresolvedCall}"`);
      } else {
        lines.push(`  → On failure: ${h.description}`);
      }
    }
  }

  return lines.join('\n');
}

const GOAL_KIND_MD_LABEL: Record<GoalNode['kind'], string> = {
  success: 'Success',
  scope: 'Out of scope',
  completion: 'On completion',
  trigger: 'Trigger',
  prereq: 'Prerequisites',
  failure: 'On failure',
  requires: 'Requires',
  produces: 'Produces',
  generic: 'Note',
};

/** Preview layout variant C: markdown `#`/`##`/`###` headers with generous blank-line
 *  spacing between blocks. Visual hierarchy is completed in desktop CSS
 *  (`.chat-msg-bubble--markdown .gh-md-h*`) — size, weight, and borders only. */
const PREVIEW_GARBAGE_STEP_RES = [
  /^:\w+$/,
  /^[\w]+:\s*:\w+$/,
  /^<!--\s*generated by dispatch-export-sync/i,
  /^Requires:\s*\$/i,
  /^Produces:\s*\$/i,
  /^Goals\s*$/i,
  /^LAZY LOADING DESIGN:/i,
  /^skill-dispatch\s*$/i,
];

function normalizePreviewSkillSlug(raw: string): string {
  return raw.trim().toLowerCase()
    .replace(/^skill:\d+:/, '')
    .replace(/^#+\s*/, '')
    .replace(/\s*\(trained[^)]*\)/i, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

function isPreviewGarbageStep(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (PREVIEW_GARBAGE_STEP_RES.some((re) => re.test(t))) return true;
  if (/^#\s*[\w-]+(?:\s+\(trained\s+\d{4}-\d{2}-\d{2}\))?\s*$/i.test(t)) return true;
  return false;
}

function isDuplicatePreviewStubStep(stepText: string, skillTitle: string): boolean {
  const slug = normalizePreviewSkillSlug(skillTitle);
  if (!slug) return false;
  const stepSlug = normalizePreviewSkillSlug(stepText);
  if (!stepSlug) return false;
  if (stepSlug === slug) return true;
  if (stepSlug.startsWith(slug) && /trained/i.test(stepText)) return true;
  return false;
}

function stripPreviewStepDecorators(text: string): string {
  return text
    .replace(/\s*@loop:\s*\d+(?:\s+max=\d+)?/gi, '')
    .replace(/\s*@skill:\s*[\w-]+(?:\([^)]*\))?/gi, '')
    .replace(/\s*@parallel:\s*\[[^\]]+\](?:\s*->\s*\[[^\]]+\])?/gi, '')
    .trim();
}

const PREVIEW_STEP_TITLE_MAX = 48;

const PREVIEW_STEP_LABEL_RES: Array<{ re: RegExp; title: string }> = [
  { re: /^ALSO\s+out\s+of\s+scope\s*:\s*/i, title: 'Also out of scope' },
  { re: /^Out\s+of\s+scope\s*:\s*/i, title: 'Out of scope' },
  { re: /^ROUTE\s+FIRST\s*[:,]?\s*/i, title: 'Route first' },
  { re: /^On\s+failure\s*:\s*/i, title: 'On failure' },
  { re: /^On\s+completion\s*:\s*/i, title: 'On completion' },
  { re: /^PREREQUISITE\s*:\s*/i, title: 'Prerequisite' },
  { re: /^NOTE\s*:\s*/i, title: 'Note' },
];

function shortenPreviewStepTitle(raw: string): string {
  return raw.replace(/[.!?]+$/, '').trim();
}

function splitLongPreviewLine(line: string): { title: string; rest: string } {
  const dashParts = line.split(/\s+[—–-]\s+/);
  if (dashParts.length >= 2) {
    const head = shortenPreviewStepTitle(dashParts[0]!);
    if (head.length > 0 && head.length <= PREVIEW_STEP_TITLE_MAX) {
      return { title: head, rest: dashParts.slice(1).join(' — ').trim() };
    }
  }
  const semiMatch = line.match(/^([^;]{8,48});+\s*(.+)$/);
  if (semiMatch) {
    return { title: shortenPreviewStepTitle(semiMatch[1]!), rest: semiMatch[2]!.trim() };
  }
  const colonMatch = line.match(/^([^:]{4,40}):\s*(.+)$/);
  if (colonMatch) {
    return { title: shortenPreviewStepTitle(colonMatch[1]!), rest: colonMatch[2]!.trim() };
  }
  const sentMatch = line.match(/^(.{16,56}[.!?])\s+(.+)$/);
  if (sentMatch) {
    return { title: shortenPreviewStepTitle(sentMatch[1]!), rest: sentMatch[2]!.trim() };
  }
  if (line.length > PREVIEW_STEP_TITLE_MAX) {
    const cut = line.slice(0, PREVIEW_STEP_TITLE_MAX).replace(/\s+\S*$/, '').trim();
    const title = cut || line.slice(0, PREVIEW_STEP_TITLE_MAX).trim();
    const rest = line.slice(title.length).replace(/^[\s—–-]+/, '').trim();
    if (rest.length >= 12) {
      return { title: shortenPreviewStepTitle(title), rest };
    }
  }
  return { title: shortenPreviewStepTitle(line), rest: '' };
}

/** Turn dense routing / scope lines into bullets when it helps scanning. */
function formatPreviewStepBodyLines(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  const single = lines[0]!;
  const routeParts = single.split(/\s*(?:→|->)\s*/).filter(Boolean);
  if (routeParts.length >= 3) return routeParts.map((p) => `- ${p.trim()}`);
  const dashBodyParts = single.split(/\s+[—–-]\s+/).filter(Boolean);
  if (dashBodyParts.length >= 2 && single.length > 56) {
    return dashBodyParts.map((p) => `- ${p.trim()}`);
  }
  const semiParts = single.split(/\s*;\s+/).filter((p) => p.length > 20);
  if (semiParts.length >= 2) return semiParts.map((p) => `- ${p.trim()}`);
  const commaToolParts = single.split(/\s*,\s+(?=(?:audit_|walk_|list_|recall|duplicate_|compare_|edit\b|remember\b))/i).filter(Boolean);
  if (commaToolParts.length >= 2 && single.length > 48) {
    return commaToolParts.map((p) => `- ${p.trim()}`);
  }
  return [single];
}

/** First line → short step heading; remaining lines → body under the step. */
function extractPreviewStepContent(rawText: string): { title: string; body: string } {
  let text = rawText.trim();
  text = text.replace(/^(?:Step\s+\d+[.:]?\s*)?(?:\d+[.)]\s*)/i, '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const firstLine = stripPreviewStepDecorators(lines[0] ?? text);

  for (const { re, title: labelTitle } of PREVIEW_STEP_LABEL_RES) {
    if (re.test(firstLine)) {
      const remainder = firstLine.replace(re, '').trim();
      const bodyParts = [
        ...(remainder ? [remainder] : []),
        ...lines.slice(1).map(stripPreviewStepDecorators).filter(Boolean),
      ];
      return { title: labelTitle, body: formatPreviewStepBodyLines(bodyParts.join('\n')).join('\n') };
    }
  }

  const { title, rest } = splitLongPreviewLine(firstLine);
  const bodyParts = [
    ...(rest ? [rest] : []),
    ...lines.slice(1).map(stripPreviewStepDecorators).filter(Boolean),
  ];
  return {
    title: title || 'Details',
    body: formatPreviewStepBodyLines(bodyParts.join('\n')).join('\n'),
  };
}

function formatPreviewSkillTitle(title: string): string {
  return title.trim()
    .replace(/^skill:\d+:/, '')
    .replace(/\s*\(trained\s+\d{4}-\d{2}-\d{2}\)\s*$/i, '')
    .trim();
}

/** Ghampus `/preview` — readable markdown SOP (headers + bullets, no emoji prefixes). */
export function formatSkillForGhampusPreview(walked: WalkedSkill, title?: string): string {
  const lines: string[] = [];
  const displayTitle = title?.trim() ? formatPreviewSkillTitle(title) : '';

  if (displayTitle) {
    lines.push(`# ${displayTitle}`);
    lines.push('');
  }

  if (walked.goals.length > 0) {
    lines.push('## Goals');
    lines.push('');
    for (const g of walked.goals) {
      for (const line of formatGoalMarkdownLines(g.kind, g.text)) lines.push(line);
    }
    lines.push('');
  }

  const previewSteps = walked.steps.filter((step) => {
    if (isPreviewGarbageStep(step.text)) return false;
    if (displayTitle && isDuplicatePreviewStubStep(step.text, displayTitle)) return false;
    return true;
  });

  if (previewSteps.length > 0) {
    lines.push(`## Procedure (${previewSteps.length} step${previewSteps.length === 1 ? '' : 's'})`);
    lines.push('');
    let stepNum = 0;
    for (const step of previewSteps) {
      stepNum += 1;
      const { title: stepTitle, body } = extractPreviewStepContent(step.text);
      if (stepNum > 1) {
        lines.push('');
        lines.push('');
      }
      lines.push(`### Step ${stepNum} — ${stepTitle}`);
      lines.push('');
      if (body) {
        lines.push(body);
        lines.push('');
      }

      const subBullets: string[] = [];
      for (const ctx of walked.contextNodes) {
        if (ctx.anchorStepIndex === step.index) subBullets.push(`Context: ${ctx.text}`);
      }
      if (step.callsSkill) {
        const argsPart = step.callsSkill.args.length > 0
          ? ` with ${step.callsSkill.args.map((a) => `$${a}`).join(', ')}`
          : '';
        const capturePart = step.callsSkill.captureAs
          ? `, capture as $${step.callsSkill.captureAs}`
          : '';
        subBullets.push(`Invokes skill: ${step.callsSkill.targetTitle}${argsPart}${capturePart}`);
      }
      if (step.parallelCalls && step.parallelCalls.length > 0) {
        const names = step.parallelCalls.map((p) => {
          const a = p.args.length > 0 ? ` with ${p.args.map((x) => `$${x}`).join(', ')}` : '';
          const c = p.captureAs ? ` → $${p.captureAs}` : '';
          return `${p.targetTitle}${a}${c}`;
        });
        subBullets.push(`Invokes in parallel: ${names.join(' | ')}`);
      }
      if (step.unresolvedCall) {
        subBullets.push(`Unresolved call: "${step.unresolvedCall}" — sub-skill not found in this engram`);
      }
      if (step.isBranchPoint) {
        const targets = walked.branches.filter(([f]) => f === step.index).map(([, t]) => `step ${t + 1}`);
        subBullets.push(`Branches to ${targets.join(' or ')} on condition`);
      }
      if (step.isLoopBack) {
        const stepLoops = walked.loops.filter(([f]) => f === step.index);
        const targets = stepLoops.map(([, t]) => `step ${t + 1}`);
        const maxCap = stepLoops.find(([, , m]) => m !== undefined)?.[2];
        const capPart = maxCap !== undefined ? ` (max ${maxCap} iteration${maxCap === 1 ? '' : 's'})` : '';
        subBullets.push(`Loops back to ${targets.join(', ')}${capPart}`);
      }
      if (subBullets.length > 0) {
        for (const b of subBullets) lines.push(`- ${b}`);
        lines.push('');
      }
    }
  }

  const unanchored = walked.contextNodes.filter((c) => c.anchorStepIndex === null);
  if (unanchored.length > 0) {
    lines.push('## Supporting context');
    for (const ctx of unanchored) lines.push(`- ${ctx.text}`);
    lines.push('');
  }

  if (walked.failureHandlers.length > 0) {
    lines.push('## Failure handlers');
    for (const h of walked.failureHandlers) {
      lines.push(`- ${h.description}`);
      if (h.targetTitle) {
        const argsPart = h.args.length > 0 ? ` with ${h.args.map((a) => `$${a}`).join(', ')}` : '';
        lines.push(`  - Recovery skill: ${h.targetTitle}${argsPart}`);
      } else if (h.unresolvedCall) {
        lines.push(`  - Unresolved recovery skill: "${h.unresolvedCall}"`);
      }
    }
  }

  return lines.join('\n').trim();
}

// ── walkSkillToJson — structured execution plan (Phase 5) ─────────────────────

/** Machine-readable execution plan for a skill, consumed by `walk_skill_structured`.
 *  Designed for AI executors that need to actually run the SOP — invoke sub-skills,
 *  capture return values, handle failure paths. See plan doc for field semantics. */
export interface SkillExecutionPlan {
  skill: { sourceId: string; title: string; engramName?: string };
  /** Variable names this skill expects from its caller (parsed from `Requires:`). */
  requires: string[];
  /** Inline type hints for required vars (D3), e.g. {branch:"string",
   *  policy:"{phased|atomic}"}. Only present for vars that declared a `:type`.
   *  Lets an AI executor validate the values it passes before invoking. */
  requiresTypes?: Record<string, string>;
  /** Variable names this skill makes available to callers (parsed from `Produces:`). */
  produces: string[];
  constraints: {
    success?: string;
    outOfScope?: string;
    completion?: string;
    trigger?: string;
    prerequisites?: string;
  };
  steps: Array<{
    /** 1-based step number for human reference. */
    index: number;
    text: string;
    calls?: {
      targetSourceId: string;
      targetTitle: string;
      /** Set only for a cross-engram call (D1) — the engram the target lives in. */
      targetGraphId?: string;
      args: string[];
      captureAs?: string;
    };
    /** Concurrent sub-skill calls (D4). When present, dispatch all members in
     *  parallel and capture each return under its captureAs. Members may be
     *  cross-engram (targetGraphId set). */
    parallel?: Array<{
      targetSourceId: string;
      targetTitle: string;
      targetGraphId?: string;
      args: string[];
      captureAs?: string;
    }>;
    /** Sub-skill name that didn't resolve to any skill in the same engram. */
    unresolvedCall?: string;
    /** 1-based step indices the branch may go to. */
    branchesTo?: number[];
    /** 1-based step indices this step loops back to. */
    loopsBackTo?: number[];
    /** Max iterations for this step's loop-back (D2 convergence guard,
     *  `@loop: N max=M`). Absent = no cap; the executor decides when to stop. */
    maxIterations?: number;
    /** Anchored recalled-memory paragraphs. */
    supportingContext: string[];
  }>;
  failureHandlers: Array<{
    description: string;
    targetSourceId?: string;
    targetTitle?: string;
    args: string[];
    unresolvedCall?: string;
  }>;
  /** Recalled memories not anchored to any specific step. */
  unanchoredContext: string[];
}

/** Parse a `Requires:` / `Produces:` goal body into a list of variable names.
 *  Strips the prefix, then splits on commas/whitespace, then strips leading `$`.
 *  Returns deduplicated names in source order. */
function parseVarList(rawText: string): string[] {
  const body = rawText.replace(GOAL_PREFIX_STRIP_RE, '').trim();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of body.split(/[\s,]+/)) {
    if (!tok) continue;
    const name = tok.replace(/^\$/, '').replace(/[^\w].*$/, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Parse a `Requires:` body into name + optional inline type hint (D3 arg
 *  typing). Supports `$branch:string`, `$count:number`, and enum hints like
 *  `$policy:{phased|atomic}`. Untyped names still parse (type undefined). Splits
 *  on top-level commas (so an enum's internal `|` and any spaces are preserved),
 *  and also whitespace-splits comma-chunks that carry no type, so the legacy
 *  space-separated untyped form keeps working. Deduplicated, source order. */
export function parseTypedVarList(rawText: string): Array<{ name: string; type?: string }> {
  const body = rawText.replace(GOAL_PREFIX_STRIP_RE, '').trim();
  // Top-level comma split that ignores commas inside `{...}` enum braces.
  const chunks: string[] = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { chunks.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) chunks.push(cur);

  const out: Array<{ name: string; type?: string }> = [];
  const seen = new Set<string>();
  const add = (tok: string): void => {
    const m = tok.trim().match(/^\$?([A-Za-z_]\w*)\s*(?::\s*(.+))?$/);
    if (!m || !m[1] || seen.has(m[1])) return;
    seen.add(m[1]);
    out.push({ name: m[1], ...(m[2] && m[2].trim() ? { type: m[2].trim() } : {}) });
  };
  for (const chunk of chunks) {
    if (chunk.includes(':')) add(chunk);                       // typed token
    else for (const w of chunk.trim().split(/\s+/)) if (w) add(w); // bare name(s)
  }
  return out;
}

/** Convert a walked skill into a structured execution plan.
 *
 * Designed to be the single source of truth for `walk_skill_structured` MCP
 * tool and any other programmatic consumer. The text-shaped output from
 * `formatSkillForRecall` is for humans; this JSON is for AI executors. */
export function walkSkillToJson(
  walked: WalkedSkill,
  meta: { sourceId: string; title: string; engramName?: string },
): SkillExecutionPlan {
  // Aggregate Requires: / Produces: var names across all matching goal nodes.
  // Requires uses the typed parser (D3) so inline `:type` hints surface; names
  // are deduplicated across goals in first-seen order.
  const requiresTyped = walked.goals
    .filter((g) => g.kind === 'requires')
    .flatMap((g) => parseTypedVarList(g.text));
  const requires: string[] = [];
  const requiresTypes: Record<string, string> = {};
  const seenReq = new Set<string>();
  for (const v of requiresTyped) {
    if (seenReq.has(v.name)) continue;
    seenReq.add(v.name);
    requires.push(v.name);
    if (v.type) requiresTypes[v.name] = v.type;
  }
  const produces = walked.goals
    .filter((g) => g.kind === 'produces')
    .flatMap((g) => parseVarList(g.text));

  // First-of-kind wins for the narrative constraints (success/scope/etc.).
  const firstByKind = (kind: GoalNode['kind']): string | undefined => {
    const g = walked.goals.find((x) => x.kind === kind);
    return g ? g.text.replace(GOAL_PREFIX_STRIP_RE, '').trim() : undefined;
  };
  const constraints: SkillExecutionPlan['constraints'] = {};
  const setIf = (key: keyof SkillExecutionPlan['constraints'], val: string | undefined): void => {
    if (val) constraints[key] = val;
  };
  setIf('success',       firstByKind('success'));
  setIf('outOfScope',    firstByKind('scope'));
  setIf('completion',    firstByKind('completion'));
  setIf('trigger',       firstByKind('trigger'));
  setIf('prerequisites', firstByKind('prereq'));

  // Build step records — use 1-based indices throughout the JSON so the AI's
  // narrative answers ("step 3", "step 5") line up with the structured plan.
  const steps: SkillExecutionPlan['steps'] = walked.steps.map((s) => {
    const branchesTo = walked.branches.filter(([f]) => f === s.index).map(([, t]) => t + 1);
    const stepLoops = walked.loops.filter(([f]) => f === s.index);
    const loopsBackTo = stepLoops.map(([, t]) => t + 1);
    // The convergence cap for this step's loop (first capped edge wins).
    const maxIterations = stepLoops.find(([, , m]) => m !== undefined)?.[2];
    const supportingContext = walked.contextNodes
      .filter((c) => c.anchorStepIndex === s.index)
      .map((c) => c.text);
    return {
      index: s.index + 1,
      text: s.text,
      ...(s.callsSkill ? {
        calls: {
          targetSourceId: s.callsSkill.targetSourceId,
          targetTitle: s.callsSkill.targetTitle,
          ...(s.callsSkill.targetGraphId ? { targetGraphId: s.callsSkill.targetGraphId } : {}),
          args: s.callsSkill.args,
          ...(s.callsSkill.captureAs ? { captureAs: s.callsSkill.captureAs } : {}),
        },
      } : {}),
      ...(s.parallelCalls && s.parallelCalls.length > 0 ? {
        parallel: s.parallelCalls.map((p) => ({
          targetSourceId: p.targetSourceId,
          targetTitle: p.targetTitle,
          ...(p.targetGraphId ? { targetGraphId: p.targetGraphId } : {}),
          args: p.args,
          ...(p.captureAs ? { captureAs: p.captureAs } : {}),
        })),
      } : {}),
      ...(s.unresolvedCall ? { unresolvedCall: s.unresolvedCall } : {}),
      ...(branchesTo.length > 0 ? { branchesTo } : {}),
      ...(loopsBackTo.length > 0 ? { loopsBackTo } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      supportingContext,
    };
  });

  const failureHandlers: SkillExecutionPlan['failureHandlers'] = walked.failureHandlers.map((h) => ({
    description: h.description,
    ...(h.targetSourceId ? { targetSourceId: h.targetSourceId } : {}),
    ...(h.targetTitle ? { targetTitle: h.targetTitle } : {}),
    args: h.args,
    ...(h.unresolvedCall ? { unresolvedCall: h.unresolvedCall } : {}),
  }));

  const unanchoredContext = walked.contextNodes
    .filter((c) => c.anchorStepIndex === null)
    .map((c) => c.text);

  return {
    skill: {
      sourceId: meta.sourceId,
      title: meta.title,
      ...(meta.engramName ? { engramName: meta.engramName } : {}),
    },
    requires,
    ...(Object.keys(requiresTypes).length > 0 ? { requiresTypes } : {}),
    produces,
    constraints,
    steps,
    failureHandlers,
    unanchoredContext,
  };
}

// ── Skill-management helpers ──────────────────────────────────────────────────

/**
 * Normalize a skill label OR a full source ref down to its stable base name,
 * so the in-place retrain matcher can compare a freshly-built label against
 * existing sources regardless of which shape they carry.
 *
 * Inputs this must collapse to the SAME base name:
 *   - "session-start (trained 2026-06-11)"            (a freshly-built label)
 *   - "skill:1781082401696:session-start (trained …)"  (a first-train source ref)
 *   - "skill:1781148773662:session-start"              (a ref after an in-place
 *                                                       retrain renamed it via
 *                                                       `skill:${ts}:${baseName}`)
 *
 * Source refs are stored as `{kind}:{ts}:{label}`, so we must strip the
 * `skill:<digits>:` prefix as well as the trailing `(trained YYYY-MM-DD)`
 * stamp. The previous version stripped only the suffix — which left the
 * `skill:<ts>:` prefix on every ref, so `baseSkillName(ref) === baseName`
 * was NEVER true and every retrain silently created a duplicate source
 * instead of rewriting in place.
 */
export function baseSkillName(label: string): string {
  return label
    .replace(/^skill:\d+:/u, '')
    .replace(/\s*\(trained \d{4}-\d{2}-\d{2}\)\s*$/u, '')
    .trim();
}

/**
 * Normalized key for in-place retrain matching. Case- and punctuation-
 * insensitive form of the base skill name, so "Enterprise Compliance Lens",
 * "enterprise-compliance-lens", and "skill:123:Enterprise Compliance Lens"
 * all collapse to the same key. Without this, train_skill called with a
 * skill_name that differs only in case/punctuation from the stored label
 * fails the `=== baseName` test and forks a DUPLICATE source instead of
 * retraining in place (observed 2026-06-26: a slug passed for a title-cased
 * skill created a second "enterprise-compliance-lens" source).
 */
export function skillNameMatchKey(label: string): string {
  return baseSkillName(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

interface ParsedSkillMeta { trainedAt?: string; mode?: string; recallBreadth?: number; }

/**
 * Parse the structured Goals block from stored skill text.
 * Returns undefined if no Goals block is present.
 *
 * Stored format (bold text, no ATX heading — see note in trainSkill):
 *   **Goals**
 *   **✓ Success:** ...
 *   **✗ Out of scope:** ...
 *   **⊙ On completion:** ...
 */
function parseSkillGoals(text: string): import('./gsk-format.js').SkillGoals | undefined {
  // Match either the old ## Goals format (backward compat) or the new bold format.
  const block = text.match(/(?:##\s*Goals|(?<!\*)\*\*Goals\*\*)\s*\n+([\s\S]*?)(?:\n(?:##|\*\*)|\s*$)/);
  if (!block) return undefined;
  const body = block[1] ?? '';
  // New format: **✓ Success:** / **✗ Out of scope:** / **⊙ On completion:**
  // Old format: **Success looks like:** / **Out of scope:** / **Expected on completion:**
  const success = (body.match(/\*\*[✓]?\s*Success(?:\s+looks like)?:\*\*\s*([^\n]+)/)?.[1] ?? '').trim();
  const scope   = (body.match(/\*\*[✗]?\s*Out of scope:\*\*\s*([^\n]+)/)?.[1] ?? '').trim();
  const done    = (body.match(/\*\*[⊙]?\s*(?:On completion|Expected on completion):\*\*\s*([^\n]+)/)?.[1] ?? '').trim();
  if (!success && !scope && !done) return undefined;
  return {
    successLooksLike: success ?? '',
    outOfScope: scope ?? '',
    expectedOnCompletion: done ?? '',
  };
}

function parseSkillMetadata(text: string): ParsedSkillMeta {
  const result: ParsedSkillMeta = {};
  const match = text.match(/<!--\s*Graphnosis skill training metadata([\s\S]*?)-->/u);
  if (!match) return result;
  const block = match[1]!;
  const get = (key: string): string | undefined => {
    const m = block.match(new RegExp(`${key}:\\s*(.+)`, 'u'));
    return m?.[1]?.trim();
  };
  const ta = get('trainedAt'); if (ta !== undefined) result.trainedAt = ta;
  const mo = get('mode'); if (mo !== undefined) result.mode = mo;
  const rb = get('recallBreadth');
  if (rb !== undefined && rb !== 'undefined') result.recallBreadth = Number(rb);
  return result;
}

/**
 * Parse the imported-provenance comment node written by `skill:importGsk` in
 * ipc.ts. Shape:
 *   <!-- imported <iso> · pack:<id> v<ver> · <kind> · verified:<bool> · author:<name> -->
 *
 * Returns undefined for locally-trained skills (no provenance node).
 */
function parseSkillProvenance(text: string): import('./skill-trainer.js').SkillProvenance | undefined {
  const withUpstream = text.match(
    /<!--\s*imported\s+(\S+)\s+·\s+pack:(\S+)\s+v(\S+)(?:\s+·\s+upstream:(\S+))?\s+·\s+(official|community)\s+·\s+verified:(true|false)\s+·\s+author:([^-]+?)\s*-->/,
  );
  if (withUpstream) {
    return {
      importedAt: withUpstream[1]!,
      packId: withUpstream[2]!,
      packVersion: withUpstream[3]!,
      ...(withUpstream[4] ? { upstreamPackId: withUpstream[4]! } : {}),
      kind: withUpstream[5]! as 'official' | 'community',
      verified: withUpstream[6]! === 'true',
      author: withUpstream[7]!.trim(),
    };
  }
  const legacy = text.match(
    /<!--\s*imported\s+(\S+)\s+·\s+pack:(\S+)\s+v(\S+)\s+·\s+(official|community)\s+·\s+verified:(true|false)\s+·\s+author:([^-]+?)\s*-->/,
  );
  if (!legacy) return undefined;
  return {
    importedAt: legacy[1]!,
    packId: legacy[2]!,
    packVersion: legacy[3]!,
    kind: legacy[4]! as 'official' | 'community',
    verified: legacy[5]! === 'true',
    author: legacy[6]!.trim(),
  };
}

// ── Text-cleaning helpers ─────────────────────────────────────────────────────

/**
 * The 8 authored goal-header keywords, in their canonical surface form. These
 * are the prefixes `classifyChunkRole` / `GOAL_NODE_RE` / `goalRoleForLine`
 * recognise; keep this list in sync with them.
 */
const GOAL_HEADER_KEYWORDS = [
  'Trigger',
  'Prerequisites',
  'Requires',
  'Produces',
  'Success',
  'Out of scope',
  'On failure',
  'On completion',
] as const;

/**
 * Matches `"; <GoalKeyword>:"` — a semicolon+space separator immediately
 * followed by one of the 8 goal keywords and its colon. Used to split an
 * inline-authored goal header that joined every field on one line. The
 * capture is the keyword so we can re-anchor the split at the boundary.
 *
 * Order matters only for the alternation's first-match-wins on overlapping
 * prefixes; none of these 8 are prefixes of each other so ordering is moot,
 * but we list multi-word keywords explicitly so `Out of scope` / `On failure`
 * / `On completion` match in full.
 */
const GOAL_HEADER_SPLIT_RE = new RegExp(
  `;\\s+(?=(?:${GOAL_HEADER_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')}):)`,
  'gu',
);

/** Anchored test: does a trimmed line BEGIN with one of the 8 goal keywords + ":"? */
const GOAL_HEADER_START_RE = new RegExp(
  `^(?:${GOAL_HEADER_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')}):`,
  'u',
);

/**
 * Trainer goal-header robustness — normalize a skill BODY before chunking.
 *
 * Bug it fixes: when an author writes the whole goal header on ONE
 * semicolon-joined line —
 *
 *   Trigger: …; Prerequisites: …; Requires: …; Produces: …; Success: …;
 *   Out of scope: …; On failure: …; On completion: …
 *
 * — that physical line carries only ONE leading goal keyword (`Trigger:`), so
 * the line-level goal splitter classifies the whole thing as `goal-trigger`
 * and the other 7 fields ride along inside the trigger's value. The skill then
 * stores 1/8 goal nodes instead of 8/8. Skills that put each goal field on its
 * own line already get 8/8.
 *
 * Fix: detect any single line that BEGINS with a goal keyword and contains one
 * or more `"; <GoalKeyword>:"` segments, and rewrite it as one line per goal
 * field (blank-line separated paragraphs) so each becomes its own chunk and is
 * classified independently. Deterministic, no LLM.
 *
 * Safety: the split fires ONLY on `"; "` immediately followed by one of the 8
 * exact keywords + `":"`. A semicolon inside step text (e.g.
 * "Do X; then do Y") or inside a goal VALUE (e.g.
 * "Success: parsed; validated; saved") is never split — none of those follow
 * a goal keyword. Lines that don't start with a goal keyword are left untouched
 * entirely, so ordinary body steps are never reshaped.
 */
export function normalizeInlineGoalHeader(body: string): string {
  // Operate line by line so we only ever touch a physical line that itself
  // begins with a goal keyword — body steps and multi-line prose are untouched.
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const trimmedStart = line.replace(/^\s+/u, '');
    if (!GOAL_HEADER_START_RE.test(trimmedStart)) {
      out.push(line);
      continue;
    }
    // This line starts with a goal keyword. Split it at every "; <GoalKeyword>:"
    // boundary. If there is no such boundary the line is already one-per-line —
    // emit it unchanged (single-element split).
    const parts = trimmedStart.split(GOAL_HEADER_SPLIT_RE).map((p) => p.trim()).filter(Boolean);
    if (parts.length <= 1) {
      out.push(line);
      continue;
    }
    // Emit each goal field as its own blank-line-separated paragraph so the
    // downstream chunker turns each into its own classified chunk.
    for (let i = 0; i < parts.length; i++) {
      out.push(parts[i]!);
      if (i < parts.length - 1) out.push('');
    }
  }
  return out.join('\n');
}

/**
 * Phase 3c — Heuristic role classifier for chunk-driven export.
 *
 * Chunks are stored as plain text (no markdown decoration), with `role`
 * passed as an op-log audit hint only. We don't persist role per chunk in
 * a sidecar map; instead we recover it heuristically from content + position
 * so the export-time markdown formatter can re-emit `# title`, `## Recall
 * Recipes`, `## Goals`, etc., as the target tool expects.
 *
 * Rules (applied in order):
 *  - First non-metadata chunk → 'title'
 *  - Starts with `<!--` → 'metadata' (skipped on export)
 *  - Starts with `Success:` / `Out of scope:` / `On completion:` → goal-*
 *  - Looks like a recipe (line 2 starts with `— `) → 'recipe'
 *  - Otherwise → 'body'
 */
export function classifyChunkRole(content: string, index: number, classified: number): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('<!--')) return 'metadata';
  // First non-metadata chunk is the title.
  if (classified === 0) return 'title';
  if (/^Success:\s/i.test(trimmed)) return 'goal-success';
  if (/^Out of scope:\s/i.test(trimmed)) return 'goal-scope';
  if (/^On completion:\s/i.test(trimmed)) return 'goal-done';
  if (/^Trigger:\s/i.test(trimmed)) return 'goal-trigger';
  if (/^Prerequisites:\s/i.test(trimmed)) return 'goal-prereq';
  if (/^On failure:\s/i.test(trimmed)) return 'goal-failure';
  if (/^Requires:\s/i.test(trimmed)) return 'goal-requires';
  if (/^Produces:\s/i.test(trimmed)) return 'goal-produces';
  // Recipe shape: first line is "name: trigger", subsequent lines start "— ".
  const lines = trimmed.split('\n');
  if (lines.length >= 2 && lines[1]!.startsWith('— ')) return 'recipe';
  // Recalled-memory marker (from buildMemoryAugmented attribution).
  if (/_\(from [^)]+\)_\s*$/.test(trimmed)) return 'recalled-memory';
  return 'body';
}

/**
 * Phase 3c — Format a list of plain-text chunks as target-format markdown.
 *
 * For 'raw' format: joins chunks with blank-line separators, no decoration.
 * For 'claude-md' / 'cursorrules' / 'system-prompt' / 'openai': emits
 * `# title`, body paragraphs verbatim, `## Recall Recipes`, `## Goals`,
 * with recipes and goals grouped into single sections.
 *
 * Metadata chunks (`<!-- ... -->`) are skipped entirely.
 */
export function formatTrainedOutputAsMarkdown(chunks: string[], format: ExportFormat): string {
  if (format === 'raw') {
    // Plain text, no markdown — but still strip metadata comments since
    // those are an internal audit artefact.
    return chunks
      .filter((c) => !c.trim().startsWith('<!--'))
      .join('\n\n')
      .trim();
  }
  const titleLines: string[] = [];
  const bodyLines: string[] = [];
  const recipeLines: string[] = [];
  const goalLines: string[] = [];
  const memoryLines: string[] = [];
  let titleText = '';
  let triggerText = '';
  let classifiedCount = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const role = classifyChunkRole(chunk, i, classifiedCount);
    if (role === 'metadata') continue;
    classifiedCount++;
    const text = chunk.trim();
    switch (role) {
      case 'title':
        if (!titleText) titleText = text;
        titleLines.push(`# ${text}`);
        break;
      case 'body':
        bodyLines.push(text);
        break;
      case 'recipe':
        recipeLines.push(text);
        break;
      case 'goal-success':
        goalLines.push(`- ✓ **Success:** ${text.replace(/^Success:\s*/i, '')}`);
        break;
      case 'goal-scope':
        goalLines.push(`- ✗ **Out of scope:** ${text.replace(/^Out of scope:\s*/i, '')}`);
        break;
      case 'goal-done':
        goalLines.push(`- ⊙ **On completion:** ${text.replace(/^On completion:\s*/i, '')}`);
        break;
      case 'goal-trigger': {
        const t = text.replace(/^Trigger:\s*/i, '');
        if (!triggerText) triggerText = t;
        goalLines.push(`- ⚡ **Trigger:** ${t}`);
        break;
      }
      case 'goal-prereq':
        goalLines.push(`- ◆ **Prerequisites:** ${text.replace(/^Prerequisites:\s*/i, '')}`);
        break;
      case 'goal-failure':
        goalLines.push(`- ⛑ **On failure:** ${text.replace(/^On failure:\s*/i, '')}`);
        break;
      case 'goal-requires':
        goalLines.push(`- ▸ **Requires:** ${text.replace(/^Requires:\s*/i, '')}`);
        break;
      case 'goal-produces':
        goalLines.push(`- ▹ **Produces:** ${text.replace(/^Produces:\s*/i, '')}`);
        break;
      case 'recalled-memory':
        memoryLines.push(text);
        break;
      default:
        bodyLines.push(text);
    }
  }
  const parts: string[] = [];
  // Claude Code skills read a YAML frontmatter block (`name` + `description`) at
  // byte 0; `description` is the "when to use this skill" routing signal — which
  // is exactly the Trigger goal. Emitting it makes a claude-md export a drop-in
  // `.claude/skills` file. Only for claude-md; the other text formats don't use
  // frontmatter.
  if (format === 'claude-md') {
    const fm = buildClaudeMdFrontmatter(titleText, triggerText);
    if (fm) parts.push(fm);
  }
  if (titleLines.length) parts.push(titleLines.join('\n'));
  if (bodyLines.length) parts.push(bodyLines.join('\n\n'));
  if (memoryLines.length) parts.push(memoryLines.join('\n\n'));
  if (recipeLines.length) parts.push(`## Recall Recipes\n\n${recipeLines.join('\n\n')}`);
  if (goalLines.length) parts.push(`## Goals\n\n${goalLines.join('\n')}`);
  return parts.join('\n\n');
}

// ── Claude Code skill frontmatter helpers ──────────────────────────────────
//
// Shared by both export paths (exportSkill raw-text + exportSkillFromSource
// chunk) so an `export_skill('claude-md')` produces a drop-in Claude Code
// skill regardless of which path runs.

/** Slug for a Claude Code skill `name:` field — the title segment before an
 *  em/en/hyphen separator, lowercased, non-alphanumerics → single hyphens. */
function slugifySkillTitle(title: string): string {
  const head = title.split(/\s+[—–-]\s+/)[0] ?? title;
  return head.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

/** Collapse a Trigger goal to a single-line description and drop the trailing
 *  `[dispatch-safe: …]` routing tag (that's for skill-dispatch, not humans). */
function triggerToDescription(trigger: string): string {
  return trigger
    .replace(/\[dispatch-safe:[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Insert a recall-recipe paragraph just before the first numbered step, so it
 *  parses as a `recipe` node (not the title or a goal) and binds at walk time.
 *  Exported for testing. */
export function insertRecipeBeforeFirstStep(skill: string, recipe: string): string {
  const lines = skill.split('\n');
  const idx = lines.findIndex((l) => /^\s*\d+\.\s/.test(l));
  if (idx < 0) return `${skill.trimEnd()}\n\n${recipe}\n`;
  const before = lines.slice(0, idx).join('\n').replace(/\s+$/, '');
  const after = lines.slice(idx).join('\n');
  return `${before}\n\n${recipe}\n\n${after}`;
}

/** First non-comment, non-goal line of a raw trained-text blob = the title. */
function extractSkillTitle(text: string): string {
  for (const ln of text.split('\n')) {
    const t = ln.trim();
    if (!t || t.startsWith('<!--') || GOAL_NODE_RE.test(t)) continue;
    return t.replace(/^#+\s*/, '');
  }
  return '';
}

/** The Trigger goal block (the `Trigger:` line plus indented continuation
 *  lines) pulled from a raw trained-text blob, as a single line. */
function extractTriggerBlock(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inTrigger = false;
  for (const ln of lines) {
    if (/^Trigger:\s/i.test(ln)) {
      inTrigger = true;
      out.push(ln.replace(/^Trigger:\s*/i, '').trim());
      continue;
    }
    if (inTrigger) {
      // Continuation = indented, non-empty, and not the start of another goal.
      if (/^\s+\S/.test(ln) && !GOAL_NODE_RE.test(ln.trim())) {
        out.push(ln.trim());
        continue;
      }
      break;
    }
  }
  return out.join(' ').trim();
}

/** Build a Claude Code skill YAML frontmatter block from a title + Trigger
 *  goal text, or null when either is missing. The description is emitted as a
 *  JSON-stringified scalar — valid YAML double-quoting that escapes the quotes,
 *  colons, and pipes that Trigger phrases routinely contain. */
function buildClaudeMdFrontmatter(title: string, triggerGoal: string): string | null {
  const name = slugifySkillTitle(title);
  const description = triggerToDescription(triggerGoal);
  if (!name || !description) return null;
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---`;
}

/** Remove the metadata HTML comment block the trainer prepends on save.
 *  Matches both the legacy ATX form (`# label`) and the new bold form
 *  (`**label**`) — the bold form replaced the ATX H1 to stop the SDK
 *  chunker from duplicating the title node. */
function stripMetadataHeader(text: string): string {
  return text
    .replace(/^(?:#[^\n]+|\*\*[^\n]+\*\*)\n+<!--[\s\S]*?-->\n+/, '')
    .trim();
}

/** Remove the "Personal Context" block appended in memory-augmented mode. */
function stripPersonalContextBlock(text: string): string {
  const marker = '\n---\n**Personal Context (from your Graphnosis memories)**';
  const idx = text.indexOf(marker);
  return idx !== -1 ? text.slice(0, idx).trim() : text;
}

/** Remove node ID tags like [n1|fact|0.95|...] and edge lines from the export. */
function stripped(text: string): string {
  return text
    // Remove KNOWLEDGE SUBGRAPH headers
    .replace(/^=== KNOWLEDGE SUBGRAPH.*$/gm, '')
    // Remove node-format lines [nodeId|type|score|...] content
    .replace(/^\[[\w|.:@\-]+\] /gm, '')
    // Remove directed / undirected edge lines
    .replace(/^(?:n\w+ -\[|n\w+ ~\[).*$/gm, '')
    // Remove session summary headers
    .replace(/^--- SESSION SUMMARIES ---$/gm, '')
    .replace(/^--- NODES ---$/gm, '')
    .replace(/^--- DIRECTED ---$/gm, '')
    .replace(/^--- UNDIRECTED ---$/gm, '')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
