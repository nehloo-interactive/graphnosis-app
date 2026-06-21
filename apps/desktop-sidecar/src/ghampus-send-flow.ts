/**
 * Ghampus ghampus:send handler — intent, tool planning, synthesis, finalize.
 * Wired from ipc.ts; modules hold domain logic, this file orchestrates the turn.
 */

import type { GraphnosisHost } from './host.js';
import type { BroadcastRawFn } from './events.js';
import type { LocalLlm } from './correction.js';
import type { McpCallTool, McpCallContext } from './mcp-server.js';
import { GHAMPUS_MCP_CLIENT_ID } from './mcp-server.js';
import { listRecentSaves } from './agent-tools.js';
import {
  buildClassifySystemPrompt,
  detectGhampusQueryHints,
  extractEngramScopeFromQuery,
  extractSkillFilterKeyword,
  extractSkillWalkTarget,
  extractMcpToolFilterKeyword,
  extractTopicAboutFromQuery,
  keywordIntent,
  LLM_PLACEHOLDERS,
  parseClassifyIntent,
  parseSkillTrainIntent,
  questionIntent,
  recallContextMatchesQuery,
  type GhampusHistTurn,
  type GhampusIntent,
  type GhampusQueryHints,
} from './ghampus-intent.js';
import {
  finalizeGhampusIntent,
  tryFormatterFallback,
} from './ghampus-intent-guards.js';
import {
  planGhampusToolsWithLlm,
  extractTopSourceIdFromRecallPrompt,
  appendPostRecallEscalation,
  buildPostPhase2DigDeeperEntry,
  buildPostEmptyRecallRetryEntries,
  countStructuredNodesFromResults,
  extractRecallMetricsFromResults,
  hasRecallHitsFromResults,
  planHasDigDeeper,
  type GhampusToolPlanEntry,
} from './ghampus-tool-plan.js';
import {
  buildDirectAnswerSystemPrompt,
  buildDirectAnswerUserPrompt,
} from './ghampus-direct-answer.js';
import {
  buildConversationContextBlock,
  buildLightRecallQuery,
  buildSelectionFollowUpSystemPrompt,
  buildSelectionFollowUpUserPrompt,
  formatRecentThreadHistory,
  parseGhampusSendPayload,
  parseRecentGhampusHistLines,
  type GhampusSelectionContext,
} from './ghampus-selection-followup.js';
import {
  filterStructuredRecallNodes,
  formatMcpToolList,
  formatObligationsAnswer,
  isConsentGateMessage,
  parseRecallNodesIncluded,
  formatProseRecallForGhampusUser,
  formatSkillList,
  filterSkillsByKeyword,
  looksGroupedResponse,
  normalizeSkillDisplayLabel,
  stripRecallAuditTrail,
  type StructuredRecallNode,
} from './ghampus-recall-format.js';
import {
  finalizeGhampusAnswerWithVerification,
  isRawRecallDump,
  type AnswerPolishSource,
  type FinalizeTraceEvent,
} from './ghampus-answer-finalize.js';
import { GHAMPUS_DOMAIN_GLOSSARY_BLOCK, sanitizeGhampusResponse } from './ghampus-glossary.js';
import { GHAMPUS_GROUNDING_RULES_BLOCK, isThinRecallContext } from './ghampus-grounding.js';
import { listMcpToolsForGhampus } from './mcp-tool-catalog.js';
import {
  formatGhampusToolErrorPreview,
  formatGhampusTraceLabel,
  ghampusTraceStepId,
  summarizeGhampusToolResult,
  type GhampusTracePayload,
  type GhampusTraceStep,
  type GhampusTurnTraceSnapshot,
} from './ghampus-trace.js';
import { resolveEngramFromUserHint } from './ghampus-engram-resolve.js';
import {
  extractSkillBodyFromGetSkill,
  findGhampusSkillMatch,
  formatSkillTrainStartMessage,
  resolveSkillTrainGraphId,
  type GhampusListedSkill,
} from './ghampus-skill-train.js';
import { recallDbg } from './log-redact.js';
import {
  clearGhampusTurn,
  isGhampusTurnCancelled,
  registerGhampusTurn,
} from './ghampus-turn-cancel.js';
import {
  GHAMPUS_TURN_TIMEOUT_MS,
  ghampusTimeoutUserMessage,
  isGhampusTimeoutError,
  llmCompleteBounded,
} from './ghampus-timeout.js';

export type GhampusPendingClarification = {
  originalText: string;
  content: string;
  engramHint: string | null;
};

export type GhampusPendingEngram = {
  content: string;
  engramHint: string;
};

export type GhampusSendState = {
  getPendingClarification: () => GhampusPendingClarification | null;
  setPendingClarification: (v: GhampusPendingClarification | null) => void;
  getPendingEngram: () => GhampusPendingEngram | null;
  setPendingEngram: (v: GhampusPendingEngram | null) => void;
};

export type GhampusSendDeps = {
  host: GraphnosisHost;
  cortexDir?: string;
  llm?: () => LocalLlm | null;
  callMcpTool?: McpCallTool;
  broadcastRaw: BroadcastRawFn;
};

const INFERRED_LAYER_MARKER = '--- INFERRED LAYER (overlays — NOT attested memory) ---';
const GHAMPUS_MCP_CTX: McpCallContext = { actingClientName: GHAMPUS_MCP_CLIENT_ID };

const RECALL_FAMILY_TOOLS = new Set([
  'recall', 'remind', 'cross_search', 'dig_deeper', 'recall_with_citations',
]);

function bestRecallPromptFromResults(
  results: Array<{ tool: string; result: unknown }>,
): string {
  let best = '';
  for (const r of results) {
    if (!RECALL_FAMILY_TOOLS.has(r.tool) || !r.result) continue;
    const p = (r.result as { prompt?: string })?.prompt ?? '';
    if (!p || isConsentGateMessage(p)) continue;
    if (p.length > best.length) best = p;
  }
  return best;
}

function splitAttestedInferred(raw: string): { attested: string; inferred: string } {
  const idx = raw.indexOf(INFERRED_LAYER_MARKER);
  if (idx < 0) return { attested: raw, inferred: '' };
  return {
    attested: raw.slice(0, idx).trim(),
    inferred: raw.slice(idx).trim(),
  };
}

function cleanRecallPromptAttested(attestedRaw: string): string {
  return stripRecallAuditTrail(
    attestedRaw
      .replace(
        /\[[\w-]+\|[\w-]+\|[\d.]+\|src:([^\]]+)\]\s*/g,
        (_m: string, srcRef: string) => {
          const label = srcRef
            .replace(/^skill:\d+:/, '')
            .replace(/^[^:]+:[^:]+:/, '')
            .replace(/-/g, ' ')
            .trim();
          return label ? `[from ${label}] ` : '';
        },
      )
      .replace(/^[\w-]+ [~-]\[[\w:.-]+\][~>-]+ [\w-]+.*$/gm, '')
      .replace(/\b[a-z]\w*\|[\w:.|-]+/g, '')
      .replace(/\bn\d+\b/g, '')
      .replace(/src:[\w:/.-]+/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

function cleanRecallPrompt(raw: string): string {
  return cleanRecallPromptAttested(splitAttestedInferred(raw).attested);
}

const leakPatterns = [
  /\bn\d+\b/,
  /\|fact\|/,
  /\|\d+\.\d+\|/,
  /src:[\w:/.-]{6,}/,
  /skill:\d{10,}/,
  /clip:[a-f0-9]{16,}/,
];

function hasLeakedIDs(t: string): boolean {
  return leakPatterns.some((re) => re.test(t));
}

function sanitizeResponse(t: string): string {
  return sanitizeGhampusResponse(
    t
      .replace(/\[[\w-]+\|[\w-]+\|[\d.]+\|[^\]]+\]\s*/g, '')
      .replace(/\b[a-z]\w*\|[\w:.|-]+/g, '')
      .replace(/\b[\w-]+ [~-]\[[\w:.-]+\][~>-]+ [\w-]+\b/g, '')
      .replace(/\bsrc:[\w:/.-]+/g, '')
      .replace(/\bskill:\d+:[^\s,)]+/g, (m) => m.replace(/^skill:\d+:/, ''))
      .replace(/\bclip:[a-f0-9]+\b/g, '')
      .replace(/\bn\d+\b/g, '')
      .replace(/\|fact\|[\d.]+\|/g, '')
      .replace(/^[_]*enriched:\s*".*"\s*→\s*".*"[_]*\s*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

type SkillTrainRunnerDeps = {
  ghampusTool: (name: string, toolArgs?: Record<string, unknown>) => Promise<unknown>;
  emitGhampusMsg: (text: string) => Promise<void>;
  emitTrace: (step: GhampusTraceStep) => void;
};

async function runGhampusSkillTrain(
  parsed: import('./ghampus-intent.js').ParsedSkillTrainIntent,
  skillNameOverride: string | undefined,
  runner: SkillTrainRunnerDeps,
): Promise<void> {
  const skillName = (skillNameOverride ?? parsed.skillName).trim();
  if (!skillName) {
    await runner.emitGhampusMsg(
      'Which skill should I train? Example: `train skill enterprise-compliance-lens` or `/train ship-workflow`',
    );
    return;
  }

  const listRes = await runner.ghampusTool('list_skills', {}) as { skills?: GhampusListedSkill[] };
  const skills = listRes.skills ?? [];
  const match = findGhampusSkillMatch(skills, skillName);
  if (!match?.sourceId) {
    await runner.emitGhampusMsg(
      `No trained skill matching **${skillName}**. Try \`/skills\` to see what's available, or train one in the Skills page first.`,
    );
    return;
  }

  const engList = await runner.ghampusTool('list_engrams', {}) as {
    engrams?: Array<{ graphId: string; displayName: string; tier: string }>;
  };
  const graphId = resolveSkillTrainGraphId(match, engList.engrams ?? [], parsed.targetEngram);
  if (!graphId) {
    await runner.emitGhampusMsg(
      'No Skills engram found. Create one from **New Engram → Skill template**, then retry.',
    );
    return;
  }

  const displayLabel = normalizeSkillDisplayLabel(match.label);
  await runner.emitGhampusMsg(formatSkillTrainStartMessage(parsed, displayLabel));

  const stepId = ghampusTraceStepId('train_skill');
  runner.emitTrace({ stepId, status: 'running', label: 'train skill', tool: 'train_skill' });

  try {
    const got = await runner.ghampusTool('get_skill', { graphId, sourceId: match.sourceId }) as { rawText?: string };
    const skillBody = extractSkillBodyFromGetSkill(got.rawText ?? '');
    if (!skillBody.trim()) {
      await runner.emitGhampusMsg(
        `Could not read skill text for **${displayLabel}**. Open it in the Skills page and retry.`,
      );
      runner.emitTrace({
        stepId,
        status: 'error',
        label: 'train skill',
        tool: 'train_skill',
        preview: 'empty skill body',
      });
      return;
    }

    const trainArgs: Record<string, unknown> = {
      skill: skillBody,
      skill_name: displayLabel,
      save: true,
    };
    if (parsed.targetEngram) trainArgs.target_engram = parsed.targetEngram;

    const trained = await runner.ghampusTool('train_skill', trainArgs) as { rawText?: string };
    const out = trained.rawText ?? '';
    if (/upgrade_required|"upgrade_required"\s*:\s*true/i.test(out)) {
      await runner.emitGhampusMsg(
        'Skill training requires **Graphnosis Pro**. Subscribe at [graphnosis.com/upgrade](https://graphnosis.com/upgrade) or use the Skills page.',
      );
      runner.emitTrace({
        stepId,
        status: 'error',
        label: 'train skill',
        tool: 'train_skill',
        preview: 'Pro required',
      });
      return;
    }

    runner.emitTrace({
      stepId,
      status: 'ok',
      label: 'train skill',
      tool: 'train_skill',
      preview: displayLabel,
    });
    const summary = out.includes('## Skill Training Complete')
      ? (out.split('### Trained Skill')[0]?.trim() ?? out.slice(0, 1200))
      : out.slice(0, 1200);
    await runner.emitGhampusMsg(summary.trim() || `Finished training **${displayLabel}**.`);
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    runner.emitTrace({
      stepId,
      status: 'error',
      label: 'train skill',
      tool: 'train_skill',
      preview: formatGhampusToolErrorPreview(errText),
    });
    await runner.emitGhampusMsg(`Skill training failed: ${errText}`);
  }
}

export async function runGhampusSend(
  deps: GhampusSendDeps,
  params: unknown,
  state: GhampusSendState,
): Promise<{ ok: true }> {
  const { text, turnId, selectionContext } = parseGhampusSendPayload(params);
  const llm = deps.llm?.() ?? null;
  const cortexDirForHistory = deps.cortexDir ?? deps.host.getCortexDir?.() ?? '';
  const histPath = cortexDirForHistory ? `${cortexDirForHistory}/ghampus-history.jsonl` : '';
  const turnStarted = Date.now();
  const traceTurnId = turnId ?? `turn-${turnStarted}`;

  const userMsg: Record<string, unknown> = {
    kind: 'user',
    text,
    ts: Date.now(),
    turnId: traceTurnId,
    ...(selectionContext ? { selectionContext } : {}),
  };
  if (histPath) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(histPath, JSON.stringify(userMsg) + '\n').catch(() => {});
  }

  if (!llm) {
    const noLlmMsg = {
      kind: 'ghampus',
      text: 'Local LLM is not available. Enable Ollama in **Settings → Models**.',
      ts: Date.now(),
      turnId: traceTurnId,
    };
    if (histPath) {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(histPath, JSON.stringify(noLlmMsg) + '\n').catch(() => {});
    }
    deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: noLlmMsg });
    return { ok: true };
  }

  void (async () => {
    const { incrementGhampusBusy, decrementGhampusBusy } = await import('./ghampus-busy.js');
    incrementGhampusBusy();
    const turnSignal = registerGhampusTurn(traceTurnId);
    const turnDeadline = Date.now() + GHAMPUS_TURN_TIMEOUT_MS;
    const throwIfCancelled = (): void => {
      if (isGhampusTurnCancelled(traceTurnId, turnSignal)) {
        throw new DOMException('cancelled by user', 'AbortError');
      }
      if (Date.now() > turnDeadline) {
        throw new Error(`Ghampus turn timed out after ${Math.round(GHAMPUS_TURN_TIMEOUT_MS / 1000)}s`);
      }
    };
    deps.broadcastRaw({
      kind: 'ghampus.thinking',
      name: 'ghampus.thinking',
      payload: { thinking: true, ts: Date.now(), turnId: traceTurnId },
    });

    const traceStepIdByKey = new Map<string, string>();
    const traceSteps = new Map<string, GhampusTraceStep>();
    const stableTraceStepId = (key: string): string => {
      const existing = traceStepIdByKey.get(key);
      if (existing) return existing;
      const id = `${key}-${Math.random().toString(36).slice(2, 7)}`;
      traceStepIdByKey.set(key, id);
      return id;
    };

    const emitTrace = (partial: Omit<GhampusTracePayload, 'turnId' | 'ts' | 'elapsedMs'>) => {
      const payload: GhampusTracePayload = {
        turnId: traceTurnId,
        ts: Date.now(),
        elapsedMs: Date.now() - turnStarted,
        ...partial,
      };
      const step: GhampusTraceStep = {
        stepId: payload.stepId,
        status: payload.status,
        label: payload.label,
        ...(payload.tool ? { tool: payload.tool } : {}),
        ...(payload.preview ? { preview: payload.preview } : {}),
        ...(payload.ms !== undefined ? { ms: payload.ms } : {}),
      };
      traceSteps.set(payload.stepId, step);
      deps.broadcastRaw({ kind: 'ghampus.trace', name: 'ghampus.trace', payload });
    };

    const planningStepId = stableTraceStepId('planning');
    let planningDone = false;
    const finishPlanning = (status: 'ok' | 'error' = 'ok', preview?: string): void => {
      if (planningDone) return;
      planningDone = true;
      emitTrace({
        stepId: planningStepId,
        status,
        label: 'Planning…',
        ...(preview ? { preview } : {}),
      });
    };
    emitTrace({ stepId: planningStepId, status: 'running', label: 'Planning…' });

    let finishSearching: (status?: 'ok' | 'error') => void = () => {};

    const buildTraceSnapshot = (): GhampusTurnTraceSnapshot | undefined => {
      if (traceSteps.size === 0) return undefined;
      return {
        turnId: traceTurnId,
        startedAt: turnStarted,
        endedAt: Date.now(),
        steps: [...traceSteps.values()],
        elapsedMs: Date.now() - turnStarted,
      };
    };

    const emitFinalizeTrace = (ev: FinalizeTraceEvent) => {
      if (typeof ev === 'string') {
        emitTrace({ stepId: stableTraceStepId('finalize-generic'), status: 'running', label: ev });
        return;
      }
      emitTrace({
        stepId: stableTraceStepId(`finalize-${ev.stepKey}`),
        status: ev.status ?? 'running',
        label: ev.label,
      });
    };

    const emitGhampusMsg = async (responseText: string) => {
      finishPlanning();
      const trace = buildTraceSnapshot();
      const responseMsg = {
        kind: 'ghampus',
        text: responseText,
        ts: Date.now(),
        turnId: traceTurnId,
        ...(trace ? { trace } : {}),
      };
      if (histPath) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(histPath, JSON.stringify(responseMsg) + '\n').catch(() => {});
      }
      deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: responseMsg });
    };

    const finalizeAndEmitGhampusMsg = async (
      draft: string,
      opts: {
        polishSource: AnswerPolishSource;
        queryHints?: GhampusQueryHints;
        recallContext?: string;
      },
    ): Promise<void> => {
      const trimmed = draft.trim();
      if (!trimmed) {
        await emitGhampusMsg(draft);
        return;
      }
      const finalizeOpts = {
        polishSource: opts.polishSource,
        emitTrace: emitFinalizeTrace,
        ...(opts.queryHints !== undefined ? { queryHints: opts.queryHints } : {}),
        ...(opts.recallContext !== undefined ? { recallContext: opts.recallContext } : {}),
      };
      if (isRawRecallDump(trimmed) || opts.polishSource === 'synthesis' || opts.polishSource === 'fallback') {
        const finalized = await finalizeGhampusAnswerWithVerification(llm, text, trimmed, finalizeOpts);
        await emitGhampusMsg(finalized.trim() || trimmed);
        return;
      }
      if (opts.polishSource === 'formatter') {
        const finalized = await finalizeGhampusAnswerWithVerification(llm, text, trimmed, {
          ...finalizeOpts,
          polishSource: 'formatter',
        });
        await emitGhampusMsg(finalized.trim() || trimmed);
        return;
      }
      await emitGhampusMsg(trimmed);
    };

    try {
      const ghampusTool = async (name: string, toolArgs: Record<string, unknown> = {}): Promise<unknown> => {
        if (!deps.callMcpTool) throw new Error(`[ghampus] callMcpTool not wired — cannot call ${name}`);
        const result = await deps.callMcpTool(name, toolArgs, GHAMPUS_MCP_CTX);
        if (result.isError) {
          const errText = result.content[0]?.text ?? `MCP ${name} error`;
          throw new Error(errText);
        }
        const rawText = result.content[0]?.text ?? '';
        switch (name) {
          case 'list_engrams': {
            try {
              const jsonText = rawText.slice(0, rawText.lastIndexOf(']') + 1).trim();
              const rows = JSON.parse(jsonText);
              return { engrams: Array.isArray(rows) ? rows : [] };
            } catch { return { engrams: [] }; }
          }
          case 'list_skills': {
            if (!rawText || rawText.startsWith('No trained')) return { skills: [] };
            const skills: GhampusListedSkill[] = [];
            const blocks = rawText.split('\n\n').filter((b: string) => b.startsWith('**'));
            for (const block of blocks) {
              const lines = block.split('\n');
              const label = lines[0]?.replace(/^\*\*|\*\*$/g, '') ?? '';
              const trainedAt = lines.find((l: string) => l.includes('Trained:'))?.match(/Trained:\s+(\S+)/)?.[1];
              const sourceId = lines.find((l: string) => l.trim().startsWith('sourceId:'))?.match(/sourceId:\s+(\S+)/)?.[1];
              const engramName = lines.find((l: string) => l.includes('Engram:'))?.match(/Engram:\s+([^|]+)/)?.[1]?.trim();
              if (label) {
                skills.push({
                  label,
                  ...(sourceId ? { sourceId } : {}),
                  ...(engramName ? { engramName } : {}),
                  ...(trainedAt ? { trainedAt } : {}),
                  searchText: block,
                });
              }
            }
            return { skills };
          }
          case 'stats': {
            try {
              const jsonText = rawText.slice(0, rawText.lastIndexOf('}') + 1).trim();
              return JSON.parse(jsonText);
            } catch { return {}; }
          }
          case 'recall':
          case 'remind':
          case 'dig_deeper':
          case 'recall_with_citations':
          case 'cross_search':
            return {
              prompt: rawText,
              nodesIncluded: parseRecallNodesIncluded(rawText),
              tokensUsed: 0,
              engramsContributing: [],
              sharingProvenance: [],
              attachments: [],
            };
          case 'recall_source':
            return { text: rawText };
          case 'recent': {
            const lines = rawText.split('\n').filter((l: string) => l.startsWith('•'));
            const sources = lines.map((l: string) => {
              const m = l.match(/^•\s+(\S+)\s+\[[^\]]+\]\s+(\S+)\s+\(([^)]+)\)/);
              return m ? { ingestedAt: m[1], label: m[2], engramName: m[3] } : null;
            }).filter(Boolean);
            return { sources };
          }
          case 'find_source': {
            const lines = rawText.split('\n').filter((l: string) => l.startsWith('•'));
            const sources = lines.map((l: string) => {
              const parts = l.replace(/^•\s+/, '').split('|').map((s: string) => s.trim());
              const label = parts[0]?.replace(/^\[[^\]]+\]\s+/, '') ?? '';
              const engramName = (parts[1] ?? '').replace(/^\(|\)$/g, '').trim();
              const sourceId = (parts[3] ?? '').replace(/^id:\s*/, '').trim();
              return label ? { label, engramName, sourceId } : null;
            }).filter(Boolean);
            return { sources };
          }
          case 'remember':
            return { ok: true };
          case 'walk_skill':
            return { rawText };
          case 'get_skill':
          case 'train_skill':
            return { rawText };
          case 'recall_structured': {
            try {
              const jsonText = rawText.slice(0, rawText.lastIndexOf('}') + 1).trim();
              return JSON.parse(jsonText) as { nodes?: StructuredRecallNode[]; nodesIncluded?: number; _notice?: string };
            } catch { return { nodes: [] }; }
          }
          case 'recall_obligations': {
            try {
              const jsonText = rawText.slice(0, rawText.lastIndexOf('}') + 1).trim();
              return JSON.parse(jsonText) as {
                obligations?: Array<{
                  engram?: string;
                  obligationType?: string;
                  expiresAt?: number;
                  daysUntil?: number;
                  overdue?: boolean;
                  preview?: string;
                }>;
                count?: number;
              };
            } catch { return { obligations: [], count: 0 }; }
          }
          default:
            return { rawText };
        }
      };

      const loadHistLines = async (): Promise<GhampusHistTurn[]> => {
        if (!histPath) return [];
        try {
          const { readFile } = await import('node:fs/promises');
          const raw = await readFile(histPath, 'utf8').catch(() => '');
          return parseRecentGhampusHistLines(raw, 15);
        } catch {
          return [];
        }
      };

      const histLines = await loadHistLines();
      throwIfCancelled();
      const histForHints = histLines.filter((t) => t.kind === 'user' || t.kind === 'ghampus');

      // ── Pending clarification ───────────────────────────────────────────
      const pendingClar = state.getPendingClarification();
      if (pendingClar) {
        const t = text.trim().toLowerCase().replace(/[!.]+$/, '');
        const confirmsSave = /^(yes|save( it)?|do it|store( it)?|keep( it)?|confirm|ok|okay|sure|yep|yeah|si|oui|ja|да|s[íi])$/i.test(t);
        const confirmsRecall = /^(no|recall|search|look( it)? up|find( it)?|don'?t save|nope|nah|cancel|skip|non|nein|нет|否)$/i.test(t);
        if (confirmsSave) {
          state.setPendingClarification(null);
          const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string }> };
          const allEngrams = engList.engrams ?? [];
          const matched = allEngrams.find((e) => e.tier === 'personal') ?? allEngrams[0] ?? null;
          if (!matched) { await emitGhampusMsg('No engrams to save to yet. Create one with `/create [name]`.'); return; }
          const hint2 = pendingClar.engramHint && !LLM_PLACEHOLDERS.has(pendingClar.engramHint) ? pendingClar.engramHint.toLowerCase() : null;
          const target = hint2
            ? allEngrams.find((e) => e.graphId === hint2 || e.graphId.includes(hint2.replace(/[^a-z0-9]+/g, '-')) || e.displayName.toLowerCase().includes(hint2)) ?? matched
            : matched;
          try {
            await ghampusTool('remember', { graphId: target.graphId, text: pendingClar.content, label: pendingClar.content.slice(0, 80) });
            await emitGhampusMsg(`Saved to **${target.displayName}**.`);
          } catch (e) {
            await emitGhampusMsg(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
          }
          return;
        }
        if (confirmsRecall) {
          state.setPendingClarification(null);
          const recallResult = await ghampusTool('recall', { query: pendingClar.originalText, maxNodes: 20 }).catch(() => null) as { prompt?: string } | null;
          const answer = recallResult?.prompt
            ? await llm.complete({ system: 'You are Ghampus. Answer concisely using the memory context below.', user: `Context:\n${recallResult.prompt}\n\nQuestion: ${pendingClar.originalText}` }).catch(() => null)
            : null;
          await emitGhampusMsg(answer ?? recallResult?.prompt ?? "I couldn't find anything on that. Try rephrasing.");
          return;
        }
        state.setPendingClarification(null);
        if (!/create|engram|creat|make\s+engram|new\s+engram/i.test(text)) {
          state.setPendingEngram(null);
        }
      }

      // ── Slash commands ──────────────────────────────────────────────────
      if (text.startsWith('/')) {
        const [rawCmd = '', ...rawArgParts] = text.slice(1).trim().split(/\s+/);
        const cmd = rawCmd.toLowerCase();
        const argsStr = rawArgParts.join(' ').trim();
        if (cmd === 'help') {
          await emitGhampusMsg(
            '**Ghampus slash commands:**\n\n' +
            '- `/save [content] [@engram]` — save a memory to your cortex\n' +
            '- `/create [engram name]` — create a new engram\n' +
            '- `/engrams` — list all your engrams\n' +
            '- `/skills` — list all your skills\n' +
            '- `/train [skill name]` — retrain a skill (Pro)\n' +
            '- `/forget` — manage / delete memories (opens Memory Studio)\n' +
            '- `/help` — show this list',
          );
          return;
        }
        if (cmd === 'engrams') {
          const res = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string; loaded: boolean }> };
          const list = res.engrams ?? [];
          await emitGhampusMsg(list.length
            ? `**Your engrams (${list.length}):**\n\n${list.map((e) => `- **${e.displayName}** \`${e.graphId}\` (${e.tier}${e.loaded ? '' : ', not loaded'})`).join('\n')}`
            : 'No engrams found. Create one with `/create [name]`.');
          return;
        }
        if (cmd === 'skills') {
          const res = await ghampusTool('list_skills', {}) as { skills?: Array<{ label: string; vitality?: number }> };
          const skills = res.skills ?? [];
          await emitGhampusMsg(skills.length
            ? `**Your skills (${skills.length}):**\n\n${skills.map((s) => `- **${s.label.replace(/^skill:\d+:/, '').replace(/-/g, ' ')}**${s.vitality != null ? ` · vitality ${s.vitality}` : ''}`).join('\n')}`
            : 'No skills found. Train one in the Skills page.');
          return;
        }
        if (cmd === 'train') {
          const trainParsed = argsStr
            ? (parseSkillTrainIntent(`train skill ${argsStr}`) ?? {
                skillName: argsStr.replace(/\s+against\s+(?:an\s+)?empty\s+engram\s*$/i, '').trim(),
                targetEngram: null,
                emptyRecall: /\bagainst\s+(?:an\s+)?empty\s+engram\b/i.test(argsStr),
              })
            : null;
          if (!trainParsed?.skillName) {
            await emitGhampusMsg('Usage: `/train [skill name]` — e.g. `/train enterprise-compliance-lens`');
            return;
          }
          await runGhampusSkillTrain(trainParsed, undefined, { ghampusTool, emitGhampusMsg, emitTrace });
          return;
        }
        if (cmd === 'forget') {
          await emitGhampusMsg('To delete or edit memories, go to **Memory Studio** and find the node or source you want to remove.');
          return;
        }
        if (cmd === 'save' && argsStr) {
          const atMatch = argsStr.match(/\s@([\w-]+)$/);
          const engramSlug = atMatch?.[1]?.toLowerCase() ?? null;
          const saveContent = atMatch ? argsStr.slice(0, argsStr.lastIndexOf(atMatch[0])).trim() : argsStr;
          const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string }> };
          const allEngrams = engList.engrams ?? [];
          let matched = allEngrams.find((e) => e.tier === 'personal') ?? allEngrams[0] ?? null;
          if (engramSlug) {
            const explicit = allEngrams.find((e) => e.graphId === engramSlug || e.graphId.includes(engramSlug) || e.displayName.toLowerCase().includes(engramSlug));
            if (!explicit) {
              await emitGhampusMsg(`No engram matching \`@${engramSlug}\`.`);
              return;
            }
            matched = explicit;
          }
          if (!matched) { await emitGhampusMsg('No engrams yet. Create one with `/create [name]`.'); return; }
          await ghampusTool('remember', { graphId: matched.graphId, text: saveContent, label: saveContent.slice(0, 80) });
          await emitGhampusMsg(`Saved to **${matched.displayName}**.`);
          return;
        }
        if (cmd === 'create' && argsStr) {
          const graphId = argsStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          await deps.host.createGraph(graphId);
          await emitGhampusMsg(`Created engram **${argsStr}** (\`${graphId}\`).`);
          return;
        }
        await emitGhampusMsg(`Unknown command \`/${cmd}\`. Try \`/help\`.`);
        return;
      }

      // ── Selection follow-up (highlighted passage) ───────────────────────
      if (selectionContext) {
        emitTrace({ stepId: stableTraceStepId('selection'), status: 'running', label: 'Answering about selection' });
        const recentHistory = formatRecentThreadHistory(histLines.slice(0, -1), 6);
        const recallQ = buildLightRecallQuery(selectionContext.selectedText, text);
        let recallSnippet = '';
        try {
          const recallRes = await ghampusTool('recall', { query: recallQ, maxNodes: 8, maxTokens: 1500 }) as { prompt?: string };
          recallSnippet = formatProseRecallForGhampusUser(recallRes.prompt ?? '', 1500);
        } catch { /* optional */ }
        const system = buildSelectionFollowUpSystemPrompt(text);
        const userPrompt = buildSelectionFollowUpUserPrompt(text, selectionContext, recentHistory, recallSnippet);
        const selectionSynthId = stableTraceStepId('selection-synth');
        emitTrace({ stepId: selectionSynthId, status: 'running', label: 'Synthesizing answer with local LLM' });
        let answer = await llmCompleteBounded(llm, { system, user: userPrompt, signal: turnSignal }).catch(() => null);
        throwIfCancelled();
        answer = sanitizeResponse(answer ?? '');
        if (!answer.trim()) answer = "I couldn't answer about that selection — try rephrasing.";
        emitTrace({ stepId: selectionSynthId, status: 'ok', label: 'Synthesizing answer with local LLM' });
        await emitGhampusMsg(answer);
        return;
      }

      // ── Intent classification ─────────────────────────────────────────────
      const keywordResult = questionIntent(text) ?? keywordIntent(text);
      let intent: GhampusIntent = keywordResult ?? { action: 'recall' };
      let llmConfidence: number | null = null;

      if (!keywordResult) {
        const { isBusyAbove, tryAcquireLlmSlot, WorkPriority } = await import('./work-priority.js');
        const { isGhampusBusy } = await import('./ghampus-busy.js');
        if (!isBusyAbove(WorkPriority.P2_GHAMPUS) || isGhampusBusy()) {
          const classifySlot = tryAcquireLlmSlot(WorkPriority.P2_GHAMPUS);
          if (classifySlot && !classifySlot.signal.aborted) {
            try {
              const contextTurns = histForHints.slice(0, -1).slice(-6);
              const recentContext = contextTurns.length > 0
                ? '\n\nConversation history (most recent last):\n' +
                  contextTurns.map((t) => `${t.kind === 'user' ? 'User' : 'Ghampus'}: ${(t.text ?? '').slice(0, 300)}`).join('\n')
                : '';
              const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string }> };
              const engramList = (engList.engrams ?? []).map((e) => `${e.graphId}="${e.displayName}"`).join(', ');
              const classifyRaw = await llmCompleteBounded(llm, {
                system: buildClassifySystemPrompt(engramList, recentContext),
                user: text,
                signal: turnSignal,
              });
              throwIfCancelled();
              const parsed = parseClassifyIntent(classifyRaw);
              if (parsed) {
                intent = parsed;
                llmConfidence = parsed.confidence ?? null;
              }
            } catch { /* keyword fallback */ } finally {
              classifySlot.release();
            }
          }
        }
      }

      const hints = detectGhampusQueryHints(text, [], { history: histForHints });
      intent = finalizeGhampusIntent(text, intent, hints);

      if (intent.action === 'remember') {
        const { content: saveContent, engram: engramHint } = intent;
        if (llmConfidence !== null && llmConfidence < 0.65) {
          state.setPendingClarification({ originalText: text, content: saveContent, engramHint });
          await emitGhampusMsg(`Should I **save** this to your cortex, or **search** memory instead?\n\n"${saveContent.slice(0, 200)}${saveContent.length > 200 ? '…' : ''}"`);
          return;
        }
        const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string }> };
        const allEngrams = engList.engrams ?? [];
        let matched: { graphId: string; displayName: string; tier?: string } | null =
          allEngrams.find((e) => e.tier === 'personal') ?? allEngrams[0] ?? null;
        if (engramHint) {
          const explicit = resolveEngramFromUserHint(engramHint, allEngrams);
          if (!explicit) {
            state.setPendingEngram({ content: saveContent, engramHint });
            await emitGhampusMsg(`There's no engram named **"${engramHint}"** yet. Say **"create engram ${engramHint}"** to create it.`);
            return;
          }
          matched = explicit;
        }
        if (!matched) {
          await emitGhampusMsg('No engrams to save to yet. Create one with `/create [name]`.');
          return;
        }
        await ghampusTool('remember', { graphId: matched.graphId, text: saveContent, label: saveContent.slice(0, 80) });
        await emitGhampusMsg(`Saved to **${matched.displayName}**.`);
        return;
      }

      if (intent.action === 'create_engram') {
        const graphId = intent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        await deps.host.createGraph(graphId);
        await emitGhampusMsg(`Created engram **${intent.name}** (\`${graphId}\`).`);
        return;
      }

      if (intent.action === 'train_skill') {
        const trainParsed = parseSkillTrainIntent(text) ?? {
          skillName: intent.skillName,
          targetEngram: intent.targetEngram,
          emptyRecall: intent.emptyRecall,
        };
        await runGhampusSkillTrain(trainParsed, intent.skillName || undefined, {
          ghampusTool,
          emitGhampusMsg,
          emitTrace,
        });
        return;
      }

      if (intent.action === 'ui_only') {
        await emitGhampusMsg(`That requires **Memory Studio** — I can't do it from here (${intent.reason}).`);
        return;
      }

      // ── Tool plan ───────────────────────────────────────────────────────
      const engListForPlan = await ghampusTool('list_engrams', {}) as {
        engrams?: Array<{ graphId: string; displayName: string; tier?: string }>;
      };
      const allEngrams = engListForPlan.engrams ?? [];
      const allEngramIds = allEngrams.map((e) => e.graphId);
      const crossSearchEngramIds = allEngrams
        .filter((e) => e.tier !== 'sensitive')
        .map((e) => e.graphId);
      const histBeforeCurrent = histForHints.slice(0, -1);
      const priorUserQuestion = histBeforeCurrent
        .slice()
        .reverse()
        .find((t) => t.kind === 'user' && (t.text ?? '').trim())
        ?.text;
      const priorGhampusSnippet = histBeforeCurrent
        .slice()
        .reverse()
        .find((t) => t.kind === 'ghampus' && (t.text ?? '').trim())
        ?.text
        ?.trim()
        .slice(0, 200);
      let scopedEngrams = extractEngramScopeFromQuery(text, allEngramIds);
      if (scopedEngrams.length === 0) {
        const priorScopeText = [priorUserQuestion, priorGhampusSnippet].filter(Boolean).join(' ');
        if (priorScopeText) {
          scopedEngrams = extractEngramScopeFromQuery(priorScopeText, allEngramIds);
        }
      }
      const engramListStr = allEngrams.map((e) => `${e.graphId}="${e.displayName}"`).join(', ');
      const plan = await planGhampusToolsWithLlm(text, hints, llm, {
        scopedEngrams,
        allEngramIds,
        crossSearchEngramIds,
        engramList: engramListStr,
        ...(priorUserQuestion ? { priorUserQuestion } : {}),
        ...(priorGhampusSnippet ? { priorGhampusSnippet } : {}),
      }, turnSignal);
      throwIfCancelled();
      finishPlanning();

      // ── Early routes (skipMemoryTools / formatters) ─────────────────────
      if (plan.earlyRoute === 'direct-answer' && hints.directAnswerKind) {
        const kind = hints.directAnswerKind;
        const usesTranscript = kind === 'conversation_context' || kind === 'process_critique';
        const recentHistory = usesTranscript
          ? buildConversationContextBlock(histForHints.slice(0, -1), 15)
          : formatRecentThreadHistory(histForHints.slice(0, -1), 8);
        const traceLabel = kind === 'conversation_context'
          ? 'Reviewing this conversation'
          : kind === 'process_critique'
            ? 'Addressing your feedback'
            : 'Direct answer';
        const directStepId = stableTraceStepId('direct');
        emitTrace({ stepId: directStepId, status: 'running', label: traceLabel });
        const system = buildDirectAnswerSystemPrompt(kind, text);
        const userPrompt = buildDirectAnswerUserPrompt(text, recentHistory, kind);
        let answer = await llmCompleteBounded(llm, { system, user: userPrompt, signal: turnSignal }).catch(() => null);
        throwIfCancelled();
        answer = sanitizeResponse(answer ?? '');
        emitTrace({ stepId: directStepId, status: 'ok', label: traceLabel });
        await emitGhampusMsg(answer.trim() || "I couldn't answer from the conversation alone.");
        return;
      }

      if (plan.earlyRoute === 'mcp-tool-list') {
        const keyword = extractMcpToolFilterKeyword(text);
        const tools = listMcpToolsForGhampus({ filterKeyword: keyword });
        await emitGhampusMsg(formatMcpToolList(tools, text, keyword));
        return;
      }

      if (plan.earlyRoute === 'skill-list') {
        const res = await ghampusTool('list_skills', {}) as { skills?: Array<{ label: string; trainedAt?: string; vitality?: number; searchText?: string }> };
        const keyword = extractSkillFilterKeyword(text);
        const skills = filterSkillsByKeyword(res.skills ?? [], keyword);
        await emitGhampusMsg(formatSkillList(skills, text, keyword));
        return;
      }

      if (plan.earlyRoute === 'skill-walk') {
        const target = extractSkillWalkTarget(text);
        if (target) {
          emitTrace({ stepId: ghampusTraceStepId('walk_skill'), status: 'running', label: 'walk skill', tool: 'walk_skill' });
          const walked = await ghampusTool('walk_skill', { label: target }).catch((e) => ({ rawText: e instanceof Error ? e.message : String(e) }));
          const body = typeof walked === 'object' && walked && 'rawText' in walked ? String((walked as { rawText: string }).rawText) : String(walked);
          emitTrace({ stepId: ghampusTraceStepId('walk_skill'), status: 'ok', label: 'walk skill', tool: 'walk_skill' });
          await emitGhampusMsg(body.slice(0, 12000));
        } else {
          await emitGhampusMsg('Which skill should I walk? Example: `walk skill ship-workflow`');
        }
        return;
      }

      if (plan.earlyRoute === 'skill-train') {
        const trainParsed = parseSkillTrainIntent(text);
        if (trainParsed) {
          await runGhampusSkillTrain(trainParsed, undefined, { ghampusTool, emitGhampusMsg, emitTrace });
        } else {
          await emitGhampusMsg('Which skill should I train? Example: `train skill ship-workflow`');
        }
        return;
      }

      let consentBlocked = false;

      const recallFamilyTools = new Set([
        'recall', 'remind', 'dig_deeper', 'recall_structured', 'cross_search', 'recall_with_citations',
      ]);
      const planUsesRecall = [...plan.phase1, ...plan.phase2].some((e) => recallFamilyTools.has(e.tool));
      const searchingStepId = stableTraceStepId('searching-memories');
      let searchingDone = false;
      finishSearching = (status: 'ok' | 'error' = 'ok'): void => {
        if (!searchingDone) {
          searchingDone = true;
          if (planUsesRecall) {
            emitTrace({ stepId: searchingStepId, status, label: 'Searching memories…' });
          }
        }
      };
      if (planUsesRecall) {
        emitTrace({ stepId: searchingStepId, status: 'running', label: 'Searching memories…' });
      }

      const runPlannedTool = async (entry: GhampusToolPlanEntry): Promise<{ tool: string; result: unknown; ms: number }> => {
        const stepId = ghampusTraceStepId(entry.tool);
        const label = entry.label ?? formatGhampusTraceLabel(entry.tool, entry.args);
        const t0 = Date.now();
        emitTrace({ stepId, status: 'running', label, tool: entry.tool });
        try {
          throwIfCancelled();
          const result = await ghampusTool(entry.tool, entry.args);
          const ms = Date.now() - t0;
          const resultPreview = summarizeGhampusToolResult(entry.tool, result);
          emitTrace({
            stepId,
            status: 'ok',
            label,
            tool: entry.tool,
            ...(resultPreview ? { preview: resultPreview } : {}),
            ms,
          });
          return { tool: entry.tool, result, ms };
        } catch (err) {
          const errText = err instanceof Error ? err.message : String(err);
          if (isConsentGateMessage(errText)) consentBlocked = true;
          emitTrace({
            stepId,
            status: 'error',
            label,
            tool: entry.tool,
            preview: formatGhampusToolErrorPreview(errText),
            ms: Date.now() - t0,
          });
          if (!entry.optional) throw err;
          return { tool: entry.tool, result: null, ms: Date.now() - t0 };
        }
      };

      const phase1Results: Array<{ tool: string; result: unknown }> = [];
      for (const entry of plan.phase1) {
        phase1Results.push(await runPlannedTool(entry));
      }

      const phase1StructuredCount = countStructuredNodesFromResults(phase1Results, text);
      const phase1RecallMetrics = extractRecallMetricsFromResults(phase1Results);
      appendPostRecallEscalation(
        plan,
        hints,
        phase1StructuredCount,
        phase1RecallMetrics,
        scopedEngrams.length > 0 ? scopedEngrams : undefined,
        allEngramIds,
        crossSearchEngramIds,
      );

      let recallPromptRaw = bestRecallPromptFromResults(phase1Results);

      if (plan.preferRecallSourceId && recallPromptRaw) {
        const sourceId = extractTopSourceIdFromRecallPrompt(recallPromptRaw);
        if (sourceId) {
          plan.phase2.unshift({
            tool: 'recall_source',
            args: { sourceId, maxTokens: 4000 },
            phase: 2,
            optional: true,
          });
        }
      }

      const phase2Results: Array<{ tool: string; result: unknown }> = [];
      for (const entry of plan.phase2) {
        phase2Results.push(await runPlannedTool(entry));
      }

      finishSearching();

      let allResults = [...phase1Results, ...phase2Results];

      if (!hasRecallHitsFromResults(allResults) && !hints.skipMemoryTools) {
        const retryEntries = buildPostEmptyRecallRetryEntries(
          plan,
          hints,
          scopedEngrams.length > 0 ? scopedEngrams : undefined,
          allEngramIds,
          allResults,
          crossSearchEngramIds,
        );
        for (const retryEntry of retryEntries) {
          allResults.push(await runPlannedTool(retryEntry));
          if (hasRecallHitsFromResults(allResults)) break;
        }
      }

      const structuredFilterQuery = plan.recallContextQuery ?? text;
      let structuredNodes: StructuredRecallNode[] = [];
      for (const r of allResults) {
        if (r.tool === 'recall_structured') {
          const data = r.result as { nodes?: StructuredRecallNode[] };
          structuredNodes = filterStructuredRecallNodes(data?.nodes ?? [], structuredFilterQuery);
        }
      }

      const digDeeperRan = allResults.some((r) => r.tool === 'dig_deeper');
      if (
        !hints.skipMemoryTools
        && !hints.wantsExhaustive
        && isThinRecallContext(structuredNodes.length, digDeeperRan)
        && !planHasDigDeeper(plan)
      ) {
        const escalation = buildPostPhase2DigDeeperEntry(
          plan,
          hints,
          scopedEngrams.length > 0 ? scopedEngrams : undefined,
        );
        const escResult = await runPlannedTool(escalation);
        allResults = [...allResults, escResult];
        if (escResult.tool === 'dig_deeper') {
          const deeperPrompt = (escResult.result as { prompt?: string })?.prompt ?? '';
          if (deeperPrompt.length > recallPromptRaw.length) recallPromptRaw = deeperPrompt;
        }
        for (const r of allResults) {
          if (r.tool === 'recall_structured') {
            const data = r.result as { nodes?: StructuredRecallNode[] };
            structuredNodes = filterStructuredRecallNodes(data?.nodes ?? [], structuredFilterQuery);
          }
        }
      }

      const asksForRoles = hints.wantsPersonRole || /\brol(e|uri)\b/i.test(text);

      const obResult = allResults.find((r) => r.tool === 'recall_obligations');
      if (obResult) {
        const obData = obResult.result as { obligations?: Parameters<typeof formatObligationsAnswer>[0] };
        const obAnswer = formatObligationsAnswer(obData?.obligations ?? [], text);
        if (obAnswer) {
          await finalizeAndEmitGhampusMsg(obAnswer, {
            polishSource: 'formatter',
            queryHints: hints,
            recallContext: (obData?.obligations ?? []).map((o) => o.preview ?? '').join('\n'),
          });
          return;
        }
      }

      const formatterAnswer = tryFormatterFallback({
        text,
        hints,
        nodes: structuredNodes,
        asksForRoles,
      });
      if (formatterAnswer && !isRawRecallDump(formatterAnswer)) {
        await finalizeAndEmitGhampusMsg(formatterAnswer, {
          polishSource: 'formatter',
          queryHints: hints,
          recallContext: structuredNodes.map((n) => (n.text ?? '').trim()).join('\n'),
        });
        return;
      }

      // Collect recall prose for synthesis (best hit across all recall-family tools).
      let primaryRecallRaw = bestRecallPromptFromResults(allResults) || recallPromptRaw;

      const { attested: attestedRaw } = splitAttestedInferred(primaryRecallRaw);
      const primaryRecall = cleanRecallPromptAttested(attestedRaw);
      const recallContextQuery = plan.recallContextQuery ?? text;
      const recallHasHits = hasRecallHitsFromResults(allResults);

      if (consentBlocked && !recallHasHits && structuredNodes.length === 0) {
        await emitGhampusMsg(
          'I need your approval in **Graphnosis** to search across engrams that require consent. '
          + 'Check the Allow / Deny dialog, or open **Settings → AI → Consent Phrases** to unlock sensitive-tier recall. '
          + 'You can also ask about a specific engram by name.',
        );
        return;
      }

      if (!recallHasHits && structuredNodes.length === 0 && !hints.wantsStats && !hints.wantsRecent) {
        const scopedNote = scopedEngrams.length > 0
          ? ` I also searched more broadly across your cortex after scoped recall in \`${scopedEngrams.join('`, `')}\` came up empty.`
          : '';
        await emitGhampusMsg(
          `I couldn't find any **attested memories** matching that in your cortex.${scopedNote} `
          + 'Try rephrasing with proper nouns (e.g. event name, host name), or save notes on this topic first.',
        );
        return;
      }

      const recentChat = formatRecentThreadHistory(histForHints.slice(0, -1), 8);
      const recent_chat_block = recentChat
        ? `\n\n<recent_chat>\n${recentChat}\n</recent_chat>`
        : '';

      const sections: string[] = [];
      if (primaryRecall) {
        sections.push('## What I found in your cortex (attested memory)\n' + primaryRecall.slice(0, hints.recallMaxTokens > 4000 ? 8000 : 3000));
      }
      if (structuredNodes.length > 0) {
        sections.push('## Recall hits (structured)\n' + structuredNodes.map((n) => `- ${(n.text ?? '').trim()}`).join('\n'));
      }

      const contextBlock = sections.length
        ? `\n\n<cortex_data>\n${sections.join('\n\n')}\n</cortex_data>`
        : '';

      const system = `You are Ghampus — the AI built into Graphnosis.

${GHAMPUS_DOMAIN_GLOSSARY_BLOCK}
${GHAMPUS_GROUNDING_RULES_BLOCK}

Use ONLY attested memory in <cortex_data>. Never invent facts.
Never mention knowledge cutoffs, training data limits, or apologize for lacking web access.
If <cortex_data> is empty or thin, say what is missing from the user's cortex — do not guess.
Use <recent_chat> when the user refers to your prior Ghampus answers, earlier turns, or asks follow-ups (pronouns like "that/this/it", "you said", "the second point") — resolve those from recent turns first; do not treat them as fresh cortex lookups unless the user pivots to a new topic or person.
Never echo <recent_chat>, <cortex_data>, or other internal tags in your answer.
${consentBlocked ? '\nNote: cross-engram search was blocked by consent — answer only from the attested memory below.\n' : ''}
OUTPUT: clean markdown, no node IDs or pipe-separated records.${contextBlock}${recent_chat_block}`;

      const synthStepId = stableTraceStepId('synth');
      emitTrace({ stepId: synthStepId, status: 'running', label: 'Synthesizing answer with local LLM' });
      let draft = await llmCompleteBounded(llm, { system, user: text, signal: turnSignal }).catch(() => null);
      throwIfCancelled();
      draft = sanitizeResponse(draft ?? '');
      emitTrace({ stepId: synthStepId, status: 'ok', label: 'Synthesizing answer with local LLM' });

      if (!draft.trim()) {
        if (structuredNodes.length > 0) {
          draft = structuredNodes.map((n) => `- ${(n.text ?? '').trim()}`).join('\n');
        } else if (!recallHasHits) {
          await emitGhampusMsg(
            "I couldn't find attested memories for that question. Try rephrasing with the event or person names you remember.",
          );
          return;
        } else {
          await emitGhampusMsg("I couldn't synthesize an answer — try rephrasing.");
          return;
        }
      }

      if (hasLeakedIDs(draft)) {
        const retry = await llmCompleteBounded(llm, {
          system: system + '\n\nRewrite in plain English only — no IDs or pipe characters.',
          user: text,
          signal: turnSignal,
        }).catch(() => null);
        if (retry?.trim()) draft = sanitizeResponse(retry);
      }

      if (hints.wantsGrouped && !looksGroupedResponse(draft)) {
        const retry = await llmCompleteBounded(llm, {
          system: system + '\n\nReformat with markdown ### headings grouped as requested.',
          user: text,
          signal: turnSignal,
        }).catch(() => null);
        if (retry?.trim()) draft = sanitizeResponse(retry);
      }

      const recallContextForVerify = sections.join('\n\n');
      // Verify against the user's question — not buildRecallQueryForTool expansion tokens
      // (e.g. "role rol team echipa owners" added for search ranking need not appear in hits).
      const recallVerifyQuery = (() => {
        const topic = extractTopicAboutFromQuery(text);
        if (topic && (hints.wantsTopicAbout || hints.wantsDefinitional)) return topic;
        return text;
      })();
      if (primaryRecall && !recallContextMatchesQuery(primaryRecall, recallVerifyQuery)) {
        recallDbg(
          '[ghampus] recall context may not match planned query',
          `q=${recallVerifyQuery.slice(0, 120)}`,
        );
      }

      const finalAnswer = await finalizeGhampusAnswerWithVerification(llm, text, draft, {
        queryHints: hints,
        recallContext: recallContextForVerify,
        polishSource: 'synthesis',
        emitTrace: emitFinalizeTrace,
      });

      await emitGhampusMsg(finalAnswer.trim() || draft);
    } catch (err) {
      if (isGhampusTurnCancelled(traceTurnId, turnSignal)
          || (err instanceof DOMException && err.name === 'AbortError')) {
        finishPlanning('error', 'Stopped');
        finishSearching('error');
        const stoppedTrace = buildTraceSnapshot();
        const stoppedMsg = {
          kind: 'ghampus',
          text: 'Stopped.',
          ts: Date.now(),
          turnId: traceTurnId,
          ...(stoppedTrace ? { trace: stoppedTrace } : {}),
        };
        if (histPath) {
          const { appendFile } = await import('node:fs/promises');
          await appendFile(histPath, JSON.stringify(stoppedMsg) + '\n').catch(() => {});
        }
        deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: stoppedMsg });
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      finishPlanning('error', 'Error');
      finishSearching('error');
      const preview = formatGhampusToolErrorPreview(msg);
      const userText = isGhampusTimeoutError(err)
        ? ghampusTimeoutUserMessage(err)
        : preview === msg && !msg.trim().startsWith('[') && !msg.trim().startsWith('{')
          ? `Error: ${preview}`
          : "Something went wrong while searching your memory. Try rephrasing your question.";
      const errTrace = buildTraceSnapshot();
      const errMsg = {
        kind: 'ghampus',
        text: userText,
        ts: Date.now(),
        turnId: traceTurnId,
        ...(errTrace ? { trace: errTrace } : {}),
      };
      if (histPath) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(histPath, JSON.stringify(errMsg) + '\n').catch(() => {});
      }
      deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: errMsg });
    } finally {
      clearGhampusTurn(traceTurnId);
      decrementGhampusBusy();
    }
  })();

  return { ok: true };
}
