/**
 * SkillTrainer — personalize AI skills using the user's Graphnosis memory.
 *
 * A "skill" is any AI behavior instruction: a Claude Code skill file, a system
 * prompt, a CLAUDE.md instruction block, a .cursorrules file, a ChatGPT system
 * message — anything that shapes how an AI assistant behaves.
 *
 * The training pipeline:
 *   1. Recall relevant memories from the user's cortex (GNN-informed, deterministic).
 *   2. If a local LLM is available: rewrite the skill to reflect those memories,
 *      producing a diff with per-change memory attribution.
 *      If no LLM: append the top memories as a "Personal Context" block —
 *      still valuable; the AI consuming the skill sees and applies the context.
 *   3. Optionally save the trained version into the Skills engram as a new node
 *      that supersedes the previous version (version history lives in the graph).
 *
 * Subscription gate: train_skill with LLM rewrite requires the monthly upgrades
 * subscription. Memory-augmented mode (no LLM) is always available. The gate is
 * enforced via the `distillation` LLM capability flag — when the user's subscription
 * is active the app sets this flag; when not, the tool degrades gracefully.
 * TODO: wire explicit subscription check when subscription service is wired.
 */

import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import { ingestClip } from './ingest.js';
import { settings as settingsMod } from '@graphnosis-app/core';

// ── Public types ─────────────────────────────────────────────────────────────

export type ExportFormat = 'claude-md' | 'cursorrules' | 'system-prompt' | 'openai' | 'raw';
export type TrainingMode = 'llm' | 'memory-augmented';

export interface TrainSkillInput {
  /** The full text of the skill to personalize. */
  skill: string;
  /** Human-readable name (used as the source label in the Skills engram). */
  skillName?: string;
  /** Restrict memory recall to these engram IDs. Null = federated (all engrams). */
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
}

export interface InfluentialNode {
  nodeId: string;
  graphId: string;
  score: number;
  /** First 120 characters of the node text. */
  preview: string;
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
}

export interface SkillVitalityResult {
  /** 0–100. 100 = just trained, fully fresh. Drops as influential memories evolve. */
  score: number;
  trainedAt?: number;
  /** How many of the skill's influential source nodes have been forgotten since training. */
  staleNodesCount: number;
  /** Human-readable recommendation based on the score. */
  recommendation: string;
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
3. After each personalized line or paragraph, add a brief parenthetical: (from memory)
4. If a memory contradicts the skill, emit a conflict flag on its own line:
   ⚠️ CONFLICT: [skill says X | memory says Y]
5. Any line in the skill prefixed with [ANCHOR] must be preserved exactly as-is.
   Do not modify, paraphrase, or move anchored lines.
6. Keep the output in the same format as the input (markdown stays markdown,
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
): string {
  const lines: string[] = [];
  if (skillName) lines.push(`Skill name: ${skillName}`);
  if (modelTarget) lines.push(`Target AI: ${modelTarget}`);
  lines.push('');
  lines.push('=== ORIGINAL SKILL ===');
  lines.push(skill);
  lines.push('');
  lines.push('=== YOUR MEMORIES ===');
  lines.push(memoriesPrompt.slice(0, 3000));
  lines.push('');
  lines.push('Rewrite the skill to match the user\'s personal style and preferences.');
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

function buildMemoryAugmented(skill: string, memoriesPrompt: string): string {
  // Strip the raw audit footer (--- \nAttached N ...) from the memory block
  // to keep the exported skill clean.
  const auditSepIdx = memoriesPrompt.lastIndexOf('\n\n---\n');
  const cleanMemories = auditSepIdx !== -1
    ? memoriesPrompt.slice(0, auditSepIdx).trim()
    : memoriesPrompt.trim();

  if (!cleanMemories) return skill;

  return [
    skill,
    '',
    '---',
    '**Personal Context (from your Graphnosis memories)**',
    '',
    '_The sections below were surfaced from your memory and are provided as context_',
    '_for any AI reading this skill. No local LLM was available for full rewriting._',
    '',
    cleanMemories,
  ].join('\n');
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

  // ── trainSkill ──────────────────────────────────────────────────────────────

  async trainSkill(input: TrainSkillInput): Promise<TrainSkillResult> {
    const {
      skill,
      skillName,
      focusGraphIds,
      modelTarget,
      save = true,
      graphId,
      addedBy,
    } = input;

    // ── Phase 1: Recall relevant memories (deterministic) ─────────────────────
    const recalled = await this.host.recall(skill, {
      budget: { maxTokens: 3000, maxNodes: 30 },
      ...(focusGraphIds?.length ? { onlyGraphIds: focusGraphIds } : {}),
    });

    const influentialNodes: InfluentialNode[] = [];
    for (const [gid, nodes] of recalled.byGraph) {
      for (const node of nodes) {
        influentialNodes.push({
          nodeId: node.nodeId,
          graphId: gid,
          score: node.score,
          preview: node.text.slice(0, 120),
        });
      }
    }
    // Sort descending by relevance score
    influentialNodes.sort((a, b) => b.score - a.score);
    const topNodes = influentialNodes.slice(0, 10);

    // ── Phase 2: Personalize ──────────────────────────────────────────────────
    const hasMemories = recalled.nodesIncluded > 0;
    let trained: string;
    let diffNotes: string | undefined;
    let mode: TrainingMode;
    let degradedNote: string | undefined;

    const llmReady = this.llm !== null && await this.pingLlm();

    if (llmReady && hasMemories) {
      // LLM path — full rewrite with memory attribution
      try {
        const raw = await this.llmCompleteWithTimeout(
          {
            system: SKILL_TRAINING_SYSTEM_PROMPT,
            user: buildTrainingUserPrompt(skill, recalled.prompt, skillName, modelTarget),
          },
          20_000,
        );
        const parsed = parseTrainingResult(skill, raw);
        trained = parsed.trained;
        diffNotes = parsed.diffNotes;
        mode = 'llm';
      } catch (err) {
        // LLM timeout or error — degrade gracefully
        trained = buildMemoryAugmented(skill, recalled.prompt);
        mode = 'memory-augmented';
        degradedNote =
          `Local LLM was available but timed out (${(err as Error).message}). ` +
          `Fell back to memory-augmented mode — relevant memories are appended below the skill.`;
      }
    } else if (!llmReady && hasMemories) {
      // No LLM — append memories as context block
      trained = buildMemoryAugmented(skill, recalled.prompt);
      mode = 'memory-augmented';
      degradedNote =
        hasMemories
          ? 'Local LLM is not enabled. Relevant memories have been appended as a ' +
            '"Personal Context" block. Enable the Local LLM in Graphnosis ' +
            '(Non-Deterministic Aid → Local LLM) for full skill rewriting with change attribution.'
          : undefined;
    } else {
      // No memories found — return original unchanged
      trained = skill;
      mode = 'memory-augmented';
      degradedNote =
        'No relevant memories were found for this skill. ' +
        'The skill is returned unchanged. Try adding more notes to your ' +
        'Graphnosis cortex about your working style, preferences, and context.';
    }

    // ── Phase 3: Save trained version ─────────────────────────────────────────
    let skillId: string | undefined;
    if (save) {
      const dateStr = new Date().toISOString().slice(0, 10);
      const label = skillName
        ? `${skillName} (trained ${dateStr})`
        : `Trained skill (${dateStr})`;

      // Store as source kind 'skill' in the Skills engram.
      // The header encodes training metadata so it's human-readable in the Sources panel.
      const metadataHeader = [
        `# ${label}`,
        `<!-- Graphnosis skill training metadata`,
        `     trainedAt: ${new Date().toISOString()}`,
        `     mode: ${mode}`,
        `     influentialNodes: ${topNodes.length}`,
        `     modelTarget: ${modelTarget ?? 'generic'}`,
        `-->`,
        '',
      ].join('\n');

      const rec = await ingestClip(
        this.host,
        graphId,
        metadataHeader + trained,
        label,
        {
          addedBy: addedBy ?? 'graphnosis-skill-trainer',
          sourceKind: 'skill',
          triggeredBy: 'mcp:train_skill',
        },
      );
      skillId = rec.sourceId;
    }

    return {
      original: skill,
      trained,
      ...(diffNotes !== undefined ? { diffNotes } : {}),
      influentialNodes: topNodes,
      mode,
      ...(skillId !== undefined ? { skillId } : {}),
      ...(degradedNote !== undefined ? { degradedNote } : {}),
    };
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
    // inspectNodes returns { id, confidence, validUntil?, ... }
    const allNodes = this.host.listNodes(graphId);
    const nodeIdSet = new Set(source.nodeIds);
    const staleNodes = allNodes.filter(
      (n) => nodeIdSet.has(n.id) && n.validUntil !== undefined && n.validUntil <= now,
    );
    const staleNodesCount = staleNodes.length;
    const totalSkillNodes = source.nodeIds.length;

    // Age penalty: 5 points per month, capped at 25
    const monthsOld = (now - trainedAt) / (1000 * 60 * 60 * 24 * 30);
    const agePenalty = Math.min(Math.floor(monthsOld * 5), 25);

    // Staleness penalty: up to 50 pts if all skill nodes are soft-deleted
    const stalenessPenalty = totalSkillNodes > 0
      ? Math.round((staleNodesCount / totalSkillNodes) * 50)
      : 0;

    const score = Math.max(0, 100 - agePenalty - stalenessPenalty);

    let recommendation: string;
    if (score >= 80) {
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

    return { score, trainedAt, staleNodesCount, recommendation };
  }

  // ── exportSkill ────────────────────────────────────────────────────────────

  /**
   * Export a trained skill in a target AI tool's native format.
   *
   * Memory references and node IDs are stripped — only the behavioral content
   * is exported. The "direction of personalization" travels; the memories that
   * caused it stay local.
   */
  exportSkill(skillText: string, format: ExportFormat): string {
    // Strip the "Personal Context (from your Graphnosis memories)" block and
    // the metadata header comment that the trainer prepends on save.
    let cleaned = stripMetadataHeader(skillText);
    cleaned = stripPersonalContextBlock(cleaned);
    cleaned = stripped(cleaned);

    const header = FORMAT_HEADERS[format];
    const wrapper = FORMAT_WRAPPERS[format];

    const withHeader = header ? `${header}\n\n${cleaned}` : cleaned;
    return wrapper ? wrapper(cleaned) : withHeader;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

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
  ): Promise<string> {
    if (!this.llm) throw new Error('LLM not available');
    return Promise.race([
      this.llm.complete(input),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`LLM call exceeded ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }
}

// ── Text-cleaning helpers ─────────────────────────────────────────────────────

/** Remove the metadata HTML comment block the trainer prepends on save. */
function stripMetadataHeader(text: string): string {
  // Matches: # <label>\n<!-- Graphnosis skill training metadata ... -->\n\n
  return text
    .replace(/^#[^\n]+\n<!--[\s\S]*?-->\n+/, '')
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
