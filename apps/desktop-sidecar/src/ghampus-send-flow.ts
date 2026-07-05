/**
 * Ghampus ghampus:send handler — intent, tool planning, synthesis, finalize.
 * Wired from ipc.ts; modules hold domain logic, this file orchestrates the turn.
 */

import { baseSkillName } from './skill-trainer.js';
import type { GraphnosisHost } from './host.js';
import type { BroadcastRawFn } from './events.js';
import type { LocalLlm } from './correction.js';
import type { McpCallTool, McpCallContext } from './mcp-server.js';
import { appendGhampusHistoryMessage } from './ghampus-history-cache.js';
import { readGhampusSessionRaw } from './ghampus-session-store.js';
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
  parseEditIntent,
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
  buildGhampusIdentityFactsBlock,
  fetchGhampusLlmStatus,
  formatGhampusIdentityDirectAnswer,
  formatModelStatusDirectAnswer,
  getThreadContext,
  rewriteGhampusSelfReferenceFirstPerson,
  resolveGhampusAppVersion,
} from './ghampus-direct-answer.js';
import {
  buildConversationContextBlock,
  buildLightRecallQuery,
  buildSelectionFollowUpSystemPrompt,
  buildSelectionFollowUpUserPrompt,
  buildFragmentReviewSystemPrompt,
  buildFragmentReviewUserPrompt,
  formatFragmentReviewOutput,
  formatRecentThreadHistory,
  parseGhampusSendPayload,
  parseRecentGhampusHistLines,
  type GhampusFragmentReviewPayload,
  type GhampusSelectionContext,
} from './ghampus-selection-followup.js';
import {
  filterStructuredRecallNodes,
  formatMcpToolList,
  formatObligationsAnswer,
  isConsentGateMessage,
  parseRecallNodesIncluded,
  formatProseRecallForGhampusUser,
  formatRecentIngestsSection,
  formatSkillList,
  filterSkillsByKeyword,
  normalizeSkillFilterKeyword,
  looksGroupedResponse,
  normalizeSkillDisplayLabel,
  parseRecentIngestMcpText,
  stripRecallAuditTrail,
  type RecentIngestSource,
  type StructuredRecallNode,
} from './ghampus-recall-format.js';
import {
  finalizeGhampusAnswerWithVerification,
  isRawRecallDump,
  type AnswerPolishSource,
  type FinalizeTraceEvent,
} from './ghampus-answer-finalize.js';
import { GHAMPUS_DOMAIN_GLOSSARY_BLOCK, sanitizeGhampusResponse } from './ghampus-glossary.js';
import {
  GHAMPUS_GROUNDING_RULES_BLOCK,
  buildGhampusBrevityRulesBlock,
  buildThinRecallGroundingBlock,
  isThinRecallContext,
  buildAdviceRecallGroundingBlock,
  applyRecallHonestyGuardrails,
} from './ghampus-grounding.js';
import {
  buildInsightsEmptyGuidance,
  buildResponseLanguageRulesBlock,
  buildRomanianContentRulesBlock,
  detectUserMessageLanguage,
  isHowToQuestionText,
  isSimplePersonLookupQuestion,
  responseLanguageLabel,
  shouldDefaultBriefAnswer,
} from './ghampus-language.js';
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
  mergeSkillImprovementDelta,
  resolveSkillTrainGraphId,
  runGhampusSkillPreview,
  ensureSkillTrainingLicensed,
  SKILL_TRAIN_PRO_UPGRADE_MESSAGE,
  suggestGhampusSkillsForPhrase,
  type GhampusListedSkill,
  type GhampusSkillPreviewCardPayload,
  type GhampusSkillRouteRunner,
} from './ghampus-skill-train.js';
import {
  loadDispatchTriggerLines,
  resolveImplicitSkillFull,
} from './ghampus-skill-dispatch-route.js';
import {
  askGhampusClarification,
  formatMcpErrorForUser,
  tryResolveClarification,
  type GhampusPendingClarificationState,
} from './ghampus-clarification.js';
import { recallDbg } from './log-redact.js';
import {
  clearGhampusTurn,
  isGhampusTurnCancelled,
  registerGhampusTurn,
} from './ghampus-turn-cancel.js';
import { enqueueGhampusSendTurn } from './ghampus-send-queue.js';
import {
  GHAMPUS_TURN_TIMEOUT_MS,
  GHAMPUS_LLM_TIMEOUT_MS,
  ghampusTimeoutUserMessage,
  isGhampusTimeoutError,
  llmCompleteBounded,
} from './ghampus-timeout.js';
import {
  scheduleMemorySuggestionAfterTurn,
  type TurnSuggestionMeta,
} from './ghampus-memory-suggestions.js';

export type GhampusPendingClarification = GhampusPendingClarificationState;

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
  brainEngine?: import('./brain-engine.js').BrainEngine | null;
  skillTrainer?: import('./skill-trainer.js').SkillTrainer | null;
  hasSkillTrainingLicense?: () => boolean | Promise<boolean>;
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
      .replace(/\buser\s+1\d{12,}\b/gi, 'you')
      .replace(/\|fact\|[\d.]+\|/g, '')
      .replace(/^[_]*enriched:\s*".*"\s*→\s*".*"[_]*\s*$/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

type SkillTrainRunnerDeps = GhampusSkillRouteRunner;

function skillRouteRunner(
  state: GhampusSendState,
  ghampusTool: GhampusSkillRouteRunner['ghampusTool'],
  emitGhampusMsg: GhampusSkillRouteRunner['emitGhampusMsg'],
  emitTrace: GhampusSkillRouteRunner['emitTrace'],
  deps: GhampusSendDeps,
  emitSkillPreviewCard?: (card: GhampusSkillPreviewCardPayload) => Promise<void>,
): GhampusSkillRouteRunner {
  return {
    ghampusTool,
    emitGhampusMsg,
    emitTrace,
    setPendingClarification: (v) => state.setPendingClarification(v),
    ...(deps.hasSkillTrainingLicense ? { isSkillTrainingLicensed: deps.hasSkillTrainingLicense } : {}),
    ...(emitSkillPreviewCard ? { emitSkillPreviewCard } : {}),
  };
}

async function runGhampusSkillTrain(
  parsed: import('./ghampus-intent.js').ParsedSkillTrainIntent,
  skillNameOverride: string | undefined,
  runner: SkillTrainRunnerDeps,
  originalText = skillNameOverride ?? parsed.skillName,
): Promise<void> {
  if (!(await ensureSkillTrainingLicensed(runner))) {
    runner.emitTrace({
      stepId: ghampusTraceStepId('train_skill'),
      status: 'error',
      label: 'train skill',
      tool: 'train_skill',
      preview: 'Pro+ required',
    });
    return;
  }

  const skillName = (skillNameOverride ?? parsed.skillName).trim();
  if (!skillName) {
    await runner.emitGhampusMsg(askGhampusClarification({
      kind: 'train_skill',
      originalText,
      phrase: '',
    }, (v) => runner.setPendingClarification?.(v)));
    return;
  }

  const listRes = await runner.ghampusTool('list_skills', {}) as { skills?: GhampusListedSkill[] };
  const skills = listRes.skills ?? [];
  const match = findGhampusSkillMatch(skills, skillName);
  if (!match?.sourceId) {
    const suggestions = suggestGhampusSkillsForPhrase(skills, skillName);
    if (suggestions.length > 0 && runner.setPendingClarification) {
      await runner.emitGhampusMsg(askGhampusClarification({
        kind: 'train_skill',
        originalText,
        phrase: skillName,
        candidates: suggestions,
        ...(parsed.awaitingImprovementDelta ? { awaitingDelta: true } : {}),
      }, (v) => runner.setPendingClarification?.(v)));
      return;
    }
    await runner.emitGhampusMsg(
      `No trained skill matching **${skillName}**. Try \`/skills\` to see what's available, or train one in the Skills page first.`,
    );
    return;
  }

  const improvementDelta = parsed.improvementDelta?.trim() ?? '';
  if (parsed.awaitingImprovementDelta && !improvementDelta && runner.setPendingClarification) {
    const display = normalizeSkillDisplayLabel(match.label);
    await runner.emitGhampusMsg(askGhampusClarification({
      kind: 'train_skill',
      originalText,
      phrase: display,
      awaitingDelta: true,
    }, (v) => runner.setPendingClarification?.(v)));
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

    const trainBody = improvementDelta
      ? mergeSkillImprovementDelta(skillBody, improvementDelta)
      : skillBody;

    const trainArgs: Record<string, unknown> = {
      skill: trainBody,
      skill_name: displayLabel,
      save: true,
    };
    if (parsed.targetEngram) trainArgs.target_engram = parsed.targetEngram;

    const trained = await runner.ghampusTool('train_skill', trainArgs) as { rawText?: string };
    const out = trained.rawText ?? '';
    if (/upgrade_required|"upgrade_required"\s*:\s*true/i.test(out)) {
      await runner.emitGhampusMsg(SKILL_TRAIN_PRO_UPGRADE_MESSAGE);
      runner.emitTrace({
        stepId,
        status: 'error',
        label: 'train skill',
        tool: 'train_skill',
        preview: 'Pro+ required',
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
    const slug = baseSkillName(match.label).replace(/\s+/g, '-');
    const tail = `\n\nPreview the updated SOP with \`/preview ${slug}\`.`;
    await runner.emitGhampusMsg((summary.trim() || `Finished training **${displayLabel}**.`) + tail);
  } catch (e) {
    const errText = e instanceof Error ? e.message : String(e);
    runner.emitTrace({
      stepId,
      status: 'error',
      label: 'train skill',
      tool: 'train_skill',
      preview: formatGhampusToolErrorPreview(errText),
    });
    await runner.emitGhampusMsg(formatMcpErrorForUser(errText, 'Skill training failed'));
  }
}

export async function runGhampusSend(
  deps: GhampusSendDeps,
  params: unknown,
  state: GhampusSendState,
): Promise<{ ok: true }> {
  const { text, turnId, selectionContext, fragmentReview } = parseGhampusSendPayload(params);
  const llm = deps.llm?.() ?? null;
  const cortexDirForHistory = deps.cortexDir ?? deps.host.getCortexDir?.() ?? '';
  const turnStarted = Date.now();
  const traceTurnId = turnId ?? `turn-${turnStarted}`;

  const userMsg: Record<string, unknown> = {
    kind: 'user',
    text,
    ts: Date.now(),
    turnId: traceTurnId,
    ...(selectionContext ? { selectionContext } : {}),
    ...(fragmentReview ? { fragmentReview } : {}),
  };
  if (cortexDirForHistory) {
    await appendGhampusHistoryMessage(cortexDirForHistory, userMsg);
  }
  const { markGhampusUserActivity } = await import('./ghampus-busy.js');
  markGhampusUserActivity();

  if (!llm) {
    const noLlmMsg = {
      kind: 'ghampus',
      text: 'Local LLM is not available. Enable Ollama in **Settings → Models**.',
      ts: Date.now(),
      turnId: traceTurnId,
    };
    if (cortexDirForHistory) {
      await appendGhampusHistoryMessage(cortexDirForHistory, noLlmMsg);
    }
    deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: noLlmMsg });
    return { ok: true };
  }

  enqueueGhampusSendTurn(async () => {
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

    let turnSuggestionMeta: TurnSuggestionMeta = {};
    let recentUserTextsForSuggest: string[] = [];

    let queryText = text;

    const emitGhampusMsg = async (
      responseText: string,
      opts?: { handledBy?: import('./ghampus-skill-train.js').GhampusHandledByInfo },
    ) => {
      finishPlanning();
      const trace = buildTraceSnapshot();
      const responseMsg = {
        kind: 'ghampus',
        text: responseText,
        ts: Date.now(),
        turnId: traceTurnId,
        ...(trace ? { trace } : {}),
        // Routing-legibility chip (feature #41) — present only when the turn was
        // dispatched to a domain Agempus's skill. Additive + optional.
        ...(opts?.handledBy ? { handledBy: opts.handledBy } : {}),
      };
      if (cortexDirForHistory) {
        await appendGhampusHistoryMessage(cortexDirForHistory, responseMsg);
      }
      deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: responseMsg });

      if (cortexDirForHistory) {
        void scheduleMemorySuggestionAfterTurn(
          {
            host: deps.host,
            broadcastRaw: deps.broadcastRaw,
            cortexDir: cortexDirForHistory,
            ...(deps.llm ? { llm: deps.llm } : {}),
          },
          {
            userText: text,
            turnId: traceTurnId,
            turnMeta: turnSuggestionMeta,
            recentUserTexts: recentUserTextsForSuggest,
          },
        ).catch(() => {});
      }
    };

    const emitSkillPreviewCard = async (card: GhampusSkillPreviewCardPayload) => {
      const previewCardMsg = {
        kind: 'skill-preview-improve',
        card,
        ts: Date.now(),
        turnId: traceTurnId,
      };
      if (cortexDirForHistory) {
        await appendGhampusHistoryMessage(cortexDirForHistory, previewCardMsg);
      }
      deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: previewCardMsg });
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
            const sources = parseRecentIngestMcpText(rawText);
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
          case 'walk_skill': {
            const graphId = String(toolArgs.graphId ?? '');
            const sourceId = String(toolArgs.sourceId ?? '');
            const { walkSkillSequence, formatSkillForGhampusPreview } = await import('./skill-trainer.js');
            const crossLinks = await deps.host.skillCallLinks.getForSource(graphId, sourceId).catch(() => []);
            const walked = walkSkillSequence(deps.host, graphId, sourceId, {
              recursive: Boolean(toolArgs.recursive),
              crossEngramLinks: crossLinks ?? [],
            });
            if (walked.steps.length === 0 && walked.goals.length === 0) {
              return { rawText: '' };
            }
            const src = deps.host.getSourceRecord(graphId, sourceId);
            const title = (src?.ref ?? sourceId).replace(/^skill:\d+:/, '').replace(/-/g, ' ').trim();
            return { rawText: formatSkillForGhampusPreview(walked, title) };
          }
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

      const makeSkillRouteRunner = () =>
        skillRouteRunner(state, ghampusTool, emitGhampusMsg, emitTrace, deps, emitSkillPreviewCard);

      const loadHistLines = async (): Promise<GhampusHistTurn[]> => {
        if (!cortexDirForHistory) return [];
        try {
          const raw = await readGhampusSessionRaw(cortexDirForHistory);
          return parseRecentGhampusHistLines(raw, 15);
        } catch {
          return [];
        }
      };

      const histLines = await loadHistLines();
      throwIfCancelled();
      const histForHints = histLines.filter((t) => t.kind === 'user' || t.kind === 'ghampus');
      recentUserTextsForSuggest = histForHints
        .filter((t) => t.kind === 'user')
        .map((t) => (t.text ?? '').trim())
        .filter(Boolean)
        .slice(-6);

      const { isMemorySearchRetryCommand } = await import('./ghampus-language.js');
      if (isMemorySearchRetryCommand(text)) {
        const threadCtx = getThreadContext(histForHints);
        if (threadCtx?.priorUserQuestion?.trim()) {
          queryText = threadCtx.priorUserQuestion.trim();
        }
      }

      // ── Pending clarification ───────────────────────────────────────────
      const pendingClar = state.getPendingClarification();
      if (pendingClar) {
        const skillListRes = pendingClar.kind === 'walk_skill' || pendingClar.kind === 'train_skill'
          ? await ghampusTool('list_skills', {}) as { skills?: GhampusListedSkill[] }
          : null;
        const resolution = tryResolveClarification(pendingClar, text, {
          skills: skillListRes?.skills ?? [],
        });
        state.setPendingClarification(null);

        if (resolution.action === 'save_confirm_yes') {
          turnSuggestionMeta = { skip: true, alreadySaved: true, skipReason: 'clarification' };
          const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string }> };
          const allEngrams = engList.engrams ?? [];
          const matched = allEngrams.find((e) => e.tier === 'personal') ?? allEngrams[0] ?? null;
          if (!matched) { await emitGhampusMsg('No engrams to save to yet. Create one with `/create [name]`.'); return; }
          const hint2 = resolution.engramHint && !LLM_PLACEHOLDERS.has(resolution.engramHint)
            ? resolution.engramHint.toLowerCase()
            : null;
          const target = hint2
            ? allEngrams.find((e) => e.graphId === hint2 || e.graphId.includes(hint2.replace(/[^a-z0-9]+/g, '-')) || e.displayName.toLowerCase().includes(hint2)) ?? matched
            : matched;
          try {
            await ghampusTool('remember', { graphId: target.graphId, text: resolution.content, label: resolution.content.slice(0, 80) });
            await emitGhampusMsg(`Saved to **${target.displayName}**.`);
          } catch (e) {
            const errText = e instanceof Error ? e.message : String(e);
            await emitGhampusMsg(formatMcpErrorForUser(errText, "Couldn't save"));
          }
          return;
        }
        if (resolution.action === 'save_confirm_no') {
          const recallResult = await ghampusTool('recall', { query: resolution.originalText, maxNodes: 20 }).catch(() => null) as { prompt?: string } | null;
          const answer = recallResult?.prompt
            ? await llm.complete({ system: 'You are Ghampus. Answer concisely using the memory context below.', user: `Context:\n${recallResult.prompt}\n\nQuestion: ${resolution.originalText}` }).catch(() => null)
            : null;
          await emitGhampusMsg(answer ?? recallResult?.prompt ?? "I couldn't find anything on that. Try rephrasing.");
          return;
        }
        if (resolution.action === 'walk_skill') {
          turnSuggestionMeta = { skip: true, skipReason: 'skill_train' };
          await runGhampusSkillPreview(
            resolution.phrase,
            makeSkillRouteRunner(),
            resolution.originalText,
          );
          return;
        }
        if (resolution.action === 'train_skill') {
          turnSuggestionMeta = { skip: true, skipReason: 'skill_train' };
          await runGhampusSkillTrain(
            {
              skillName: resolution.skillName,
              targetEngram: resolution.targetEngram ?? null,
              emptyRecall: resolution.emptyRecall ?? false,
              ...(resolution.improvementDelta ? { improvementDelta: resolution.improvementDelta } : {}),
            },
            resolution.skillName,
            makeSkillRouteRunner(),
            resolution.originalText,
          );
          return;
        }
        if (resolution.action === 'create_engram') {
          turnSuggestionMeta = { skip: true };
          const graphId = resolution.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          await deps.host.createGraph(graphId);
          await emitGhampusMsg(`Created engram **${resolution.name}** (\`${graphId}\`).`);
          return;
        }
        if (resolution.action === 'slash_save') {
          turnSuggestionMeta = { skip: true, alreadySaved: true };
          const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string }> };
          const allEngrams = engList.engrams ?? [];
          let matched: { graphId: string; displayName: string; tier?: string } | null =
            allEngrams.find((e) => e.tier === 'personal') ?? allEngrams[0] ?? null;
          if (resolution.engramHint) {
            const explicit = resolveEngramFromUserHint(resolution.engramHint, allEngrams);
            if (!explicit) {
              await emitGhampusMsg(`No engram matching **"${resolution.engramHint}"** yet. Say **create engram ${resolution.engramHint}** to create it.`);
              return;
            }
            matched = explicit;
          }
          if (!matched) { await emitGhampusMsg('No engrams yet. Create one with `/create [name]`.'); return; }
          await ghampusTool('remember', { graphId: matched.graphId, text: resolution.content, label: resolution.content.slice(0, 80) });
          await emitGhampusMsg(`Saved to **${matched.displayName}**.`);
          return;
        }
        if (resolution.action === 'cancelled') {
          if (!/create|engram|creat|make\s+engram|new\s+engram/i.test(text)) {
            state.setPendingEngram(null);
          }
        }
      }

      // ── Fragment comment review (batched selections) ───────────────────
      if (fragmentReview?.comments?.length) {
        turnSuggestionMeta = { skip: true, skipReason: 'direct_answer' };
        const reviewStepId = stableTraceStepId('fragment-review');
        emitTrace({ stepId: reviewStepId, status: 'running', label: 'Reviewing your comments' });
        const system = buildFragmentReviewSystemPrompt();
        const userPrompt = buildFragmentReviewUserPrompt(fragmentReview);
        let answer = await llmCompleteBounded(llm, { system, user: userPrompt, signal: turnSignal }).catch(() => null);
        throwIfCancelled();
        answer = formatFragmentReviewOutput(sanitizeResponse(answer ?? ''), fragmentReview);
        emitTrace({ stepId: reviewStepId, status: 'ok', label: 'Reviewing your comments' });
        await emitGhampusMsg(
          answer.trim()
            || "I couldn't process those comments — try rephrasing or send them one at a time.",
        );
        return;
      }

      // ── Slash commands ──────────────────────────────────────────────────
      if (text.startsWith('/')) {
        turnSuggestionMeta = { skip: true, skipReason: 'slash_command' };
        const [rawCmd = '', ...rawArgParts] = text.slice(1).trim().split(/\s+/);
        const cmd = rawCmd.toLowerCase();
        const argsStr = rawArgParts.join(' ').trim();
        if (cmd === 'help') {
          await emitGhampusMsg(
            '**Ghampus slash commands:**\n\n' +
            '- `/save [content] [@engram]` — save a memory to your cortex\n' +
            '- `/create [engram name]` — create a new engram\n' +
            '- `/engrams` — list all your engrams\n' +
            '- `/skills [filter]` — list your skills (optional name filter)\n' +
            '- `/preview [skill name]` — view a skill SOP (markdown)\n' +
            '- `/walk [skill name]` — alias for `/preview`\n' +
            '- `/train [skill name]` — retrain a skill (Pro)\n' +
            '- `/forget [topic]` — find memories to remove\n' +
            '- `/compare [topic]` — compare sources for contradictions\n' +
            '- `/edit [correction]` — propose a memory correction\n' +
            '- `/insights` — preview Foresight insights in chat\n' +
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
          const res = await ghampusTool('list_skills', {}) as { skills?: Array<{ label: string; vitality?: number; trainedAt?: string }> };
          const keyword = normalizeSkillFilterKeyword(argsStr || null);
          const skills = filterSkillsByKeyword(res.skills ?? [], keyword);
          await emitGhampusMsg(formatSkillList(skills, text, keyword));
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
            await emitGhampusMsg(askGhampusClarification({
              kind: 'slash_train',
              originalText: text,
            }, (v) => state.setPendingClarification(v)));
            return;
          }
          await runGhampusSkillTrain(
            trainParsed,
            undefined,
            makeSkillRouteRunner(),
            text,
          );
          return;
        }
        if (cmd === 'preview' || cmd === 'walk') {
          const previewArgs = argsStr.replace(/^skill\s+/i, '').trim();
          const target = previewArgs
            ? (extractSkillWalkTarget(`preview skill ${previewArgs}`)
              ?? extractSkillWalkTarget(`walk skill ${previewArgs}`)
              ?? previewArgs)
            : '';
          if (!target) {
            await emitGhampusMsg(askGhampusClarification({
              kind: cmd === 'walk' ? 'slash_walk' : 'slash_preview',
              originalText: text,
            }, (v) => state.setPendingClarification(v)));
            return;
          }
          await runGhampusSkillPreview(
            target,
            makeSkillRouteRunner(),
            text,
          );
          return;
        }
        if (cmd === 'forget') {
          if (!argsStr) {
            const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string }> };
            const names = (engList.engrams ?? []).slice(0, 8).map((e) => `**${e.displayName}**`).join(', ');
            await emitGhampusMsg(
              '**Forget a memory** — describe what to remove, optionally scoped to an engram:\n\n'
              + '- `/forget washing a car` — search across all engrams\n'
              + '- `/forget dashboard todo about launch` — narrow by topic\n'
              + '- Or open **Brain → Sources** for surgical node deletion\n\n'
              + (names ? `Your engrams include: ${names}.` : 'Create an engram first if you have none yet.'),
            );
            return;
          }
          const forgetQ = argsStr.trim();
          const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string }> };
          const scoped = extractEngramScopeFromQuery(forgetQ, (engList.engrams ?? []).map((e) => e.graphId));
          const structRes = await ghampusTool('recall_structured', {
            query: forgetQ,
            maxNodes: 15,
            ...(scoped.length === 1 ? { only_engrams: scoped } : {}),
          }) as { nodes?: StructuredRecallNode[] };
          const nodes = filterStructuredRecallNodes(structRes?.nodes ?? [], forgetQ);
          if (nodes.length === 0) {
            await emitGhampusMsg(
              `No matching memories for **${forgetQ}**. Try a shorter phrase, name the engram, or open **Brain → Sources**.`,
            );
            return;
          }
          const preview = nodes.slice(0, 5).map((n, i) => `${i + 1}. ${(n.text ?? '').trim().slice(0, 120)}`).join('\n');
          await emitGhampusMsg(
            `Found **${nodes.length}** candidate${nodes.length === 1 ? '' : 's'} to forget:\n\n${preview}\n\n`
            + 'Open **Brain → Sources** or **Check-in** to remove nodes, or tell me which number to target.',
          );
          return;
        }
        if (cmd === 'edit') {
          if (!argsStr) {
            await emitGhampusMsg(
              '**Edit memory** — describe the correction in plain language:\n\n'
              + '- `/edit washing a car requires rinse before soap` — I will propose a diff for your approval\n'
              + '- Add `in ENGRAM` when you know the target: `/edit in dashboard …`\n\n'
              + 'Nothing is written until you approve the diff in **Check-in**.',
            );
            return;
          }
          const editParsed = parseEditIntent(argsStr) ?? { correction: argsStr, engram: null };
          const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string }> };
          const allEngrams = engList.engrams ?? [];
          let graphId: string | undefined;
          if (editParsed.engram) {
            const resolved = resolveEngramFromUserHint(editParsed.engram, allEngrams);
            if (resolved) graphId = resolved.graphId;
          }
          if (!graphId) {
            const scoped = extractEngramScopeFromQuery(editParsed.correction, allEngrams.map((e) => e.graphId));
            if (scoped.length === 1) graphId = scoped[0];
          }
          if (!graphId && allEngrams.length > 1) {
            await emitGhampusMsg(
              'Which **engram** should I edit? Add `in ENGRAM` to your correction, or name the engram in the text '
              + `(e.g. \`/edit in dashboard …\`). Known engrams: ${allEngrams.slice(0, 6).map((e) => e.displayName).join(', ')}.`,
            );
            return;
          }
          try {
            const editRes = await ghampusTool('edit', {
              correction: editParsed.correction,
              ...(graphId ? { graphId } : {}),
            }) as { rawText?: string };
            const raw = editRes.rawText ?? '';
            let diffId: string | null = null;
            let changeCount = 0;
            try {
              const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as {
                diffId?: string;
                preview?: { edits?: unknown[]; adds?: unknown[] };
              };
              diffId = parsed.diffId ?? null;
              changeCount = (parsed.preview?.edits?.length ?? 0) + (parsed.preview?.adds?.length ?? 0);
            } catch { /* prose fallback */ }
            if (diffId) {
              await emitGhampusMsg(
                `Proposed **${changeCount || 'a'}** change${changeCount === 1 ? '' : 's'} — review and approve in **Check-in** `
                + `(diff \`${diffId}\`). Nothing is saved until you approve.`,
              );
            } else {
              await emitGhampusMsg(
                'Edit proposal ready — open **Check-in** to review the diff. Nothing is saved until you approve.',
              );
            }
          } catch (e) {
            await emitGhampusMsg(formatMcpErrorForUser(e instanceof Error ? e.message : String(e), 'Could not propose edit'));
          }
          return;
        }
        if (cmd === 'compare') {
          if (!argsStr) {
            await emitGhampusMsg(
              '**Compare sources** — give a topic or two source names:\n\n'
              + '- `/compare car wash` — find sources and check for contradictions\n'
              + '- Or open **Foresight → Memory Integrity** for the full compare workbench (free in-app).',
            );
            return;
          }
          const topic = argsStr.trim();
          const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string }> };
          const scoped = extractEngramScopeFromQuery(topic, (engList.engrams ?? []).map((e) => e.graphId));
          const findRes = await ghampusTool('find_source', { content: topic, limit: 6 }) as {
            sources?: Array<{ sourceId?: string; graphId?: string; label?: string; engramName?: string }>;
          };
          const sources = (findRes.sources ?? []).filter((s) => s.sourceId && s.graphId);
          if (sources.length < 2) {
            await emitGhampusMsg(
              `Need at least **two sources** about "${topic}" to compare. `
              + `${sources.length === 1 ? 'Only one match so far — save or ingest another doc on this topic, or ' : ''}`
              + 'try **Foresight → Memory Integrity → Compare** for manual source pick.',
            );
            return;
          }
          const byEngram = new Map<string, typeof sources>();
          for (const s of sources) {
            const gid = s.graphId!;
            if (!byEngram.has(gid)) byEngram.set(gid, []);
            byEngram.get(gid)!.push(s);
          }
          let compared = false;
          for (const [graphId, group] of byEngram) {
            if (group.length < 2) continue;
            const a = group[0]!;
            const b = group[1]!;
            try {
              const cmp = await ghampusTool('compare_sources', {
                engram: graphId,
                sourceA: a.sourceId!,
                sourceB: b.sourceId!,
              }) as { rawText?: string };
              const body = (cmp.rawText ?? '').trim().slice(0, 4000);
              await emitGhampusMsg(
                body
                  ? `**Compare: ${topic}** (${a.label ?? a.sourceId} vs ${b.label ?? b.sourceId})\n\n${body}`
                  : `Compared **${a.label ?? 'source A'}** and **${b.label ?? 'source B'}** — no contradictions flagged.`,
              );
              compared = true;
              break;
            } catch (e) {
              await emitGhampusMsg(formatMcpErrorForUser(e instanceof Error ? e.message : String(e), 'Compare failed'));
              return;
            }
          }
          if (!compared) {
            await emitGhampusMsg(
              `Found sources in different engrams — pick two in **Foresight → Memory Integrity → Compare**, `
              + `or scope your query to one engram (e.g. \`/compare dashboard car wash\`).`,
            );
          }
          return;
        }
        if (cmd === 'save') {
          if (!argsStr) {
            await emitGhampusMsg(askGhampusClarification({
              kind: 'slash_save',
              originalText: text,
            }, (v) => state.setPendingClarification(v)));
            return;
          }
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
        if (cmd === 'create') {
          if (!argsStr) {
            await emitGhampusMsg(askGhampusClarification({
              kind: 'slash_create',
              originalText: text,
            }, (v) => state.setPendingClarification(v)));
            return;
          }
          const graphId = argsStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
          await deps.host.createGraph(graphId);
          await emitGhampusMsg(`Created engram **${argsStr}** (\`${graphId}\`).`);
          return;
        }
        if (cmd === 'insights') {
          const INSIGHTS_PREVIEW_N = 5;
          const all = deps.brainEngine?.getInsights() ?? [];
          if (all.length === 0) {
            await emitGhampusMsg(buildInsightsEmptyGuidance());
            return;
          }
          finishPlanning();
          const previewMsg = {
            kind: 'insights-preview',
            ts: Date.now(),
            turnId: traceTurnId,
            insights: all.slice(0, INSIGHTS_PREVIEW_N).map((i) => ({
              id: i.id,
              graphId: i.graphId,
              kind: i.kind,
              title: i.title,
              body: i.body,
            })),
            totalCount: all.length,
          };
          if (cortexDirForHistory) {
            await appendGhampusHistoryMessage(cortexDirForHistory, previewMsg);
          }
          deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: previewMsg });
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
      const keywordResult = questionIntent(queryText) ?? keywordIntent(queryText);
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
                user: queryText,
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

      const hints = detectGhampusQueryHints(queryText, [], { history: histForHints });
      if (!hints.implicitSkillSlug) {
        const triggerLines = loadDispatchTriggerLines(deps.host, deps.skillTrainer);
        let skillsForFuzzy: GhampusListedSkill[] = [];
        if (triggerLines.length > 0 || !hints.wantsExplicitSkillWalk) {
          try {
            const skillListRes = await ghampusTool('list_skills', {}) as { skills?: GhampusListedSkill[] };
            skillsForFuzzy = skillListRes.skills ?? [];
          } catch { /* optional fuzzy path */ }
        }
        const implicitMatch = resolveImplicitSkillFull(queryText, hints, triggerLines, skillsForFuzzy);
        if (implicitMatch) {
          hints.wantsImplicitSkillWalk = true;
          hints.implicitSkillSlug = implicitMatch.skillSlug;
        }
      }
      intent = finalizeGhampusIntent(queryText, intent, hints);

      if (intent.action === 'remember') {
        turnSuggestionMeta = { skip: true, alreadySaved: true };
        const { content: saveContent, engram: engramHint } = intent;
        if (llmConfidence !== null && llmConfidence < 0.65) {
          turnSuggestionMeta = { skip: true, skipReason: 'clarification' };
          await emitGhampusMsg(askGhampusClarification({
            kind: 'save_memory',
            originalText: text,
            content: saveContent,
            engramHint,
          }, (v) => state.setPendingClarification(v)));
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
        turnSuggestionMeta = { skip: true };
        const graphId = intent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        await deps.host.createGraph(graphId);
        await emitGhampusMsg(`Created engram **${intent.name}** (\`${graphId}\`).`);
        return;
      }

      if (intent.action === 'edit') {
        turnSuggestionMeta = { skip: true, skipReason: 'clarification' };
        const editParsed = parseEditIntent(queryText) ?? {
          correction: intent.correction,
          engram: intent.engram,
        };
        const engList = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string }> };
        const allEngrams = engList.engrams ?? [];
        let graphId: string | undefined;
        if (editParsed.engram) {
          const resolved = resolveEngramFromUserHint(editParsed.engram, allEngrams);
          if (resolved) graphId = resolved.graphId;
        }
        if (!graphId) {
          const scoped = extractEngramScopeFromQuery(editParsed.correction, allEngrams.map((e) => e.graphId));
          if (scoped.length === 1) graphId = scoped[0];
        }
        if (!graphId && allEngrams.length > 1) {
          await emitGhampusMsg(
            'Which **engram** should I edit? Mention it in your correction (`in dashboard …`) '
            + `or reply with the engram name. Known: ${allEngrams.slice(0, 6).map((e) => e.displayName).join(', ')}.`,
          );
          return;
        }
        try {
          const editRes = await ghampusTool('edit', {
            correction: editParsed.correction,
            ...(graphId ? { graphId } : {}),
          }) as { rawText?: string };
          const raw = editRes.rawText ?? '';
          let diffId: string | null = null;
          let changeCount = 0;
          try {
            const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}') as {
              diffId?: string;
              preview?: { edits?: unknown[]; adds?: unknown[] };
            };
            diffId = parsed.diffId ?? null;
            changeCount = (parsed.preview?.edits?.length ?? 0) + (parsed.preview?.adds?.length ?? 0);
          } catch { /* prose fallback */ }
          await emitGhampusMsg(
            diffId
              ? `Proposed **${changeCount || 'a'}** change${changeCount === 1 ? '' : 's'} — approve in **Check-in** (\`${diffId}\`).`
              : 'Edit proposal ready in **Check-in** — nothing is saved until you approve.',
          );
        } catch (e) {
          await emitGhampusMsg(formatMcpErrorForUser(e instanceof Error ? e.message : String(e), 'Could not propose edit'));
        }
        return;
      }

      if (intent.action === 'train_skill') {
        turnSuggestionMeta = { skip: true, skipReason: 'skill_train' };
        const trainParsed = parseSkillTrainIntent(queryText) ?? {
          skillName: intent.skillName,
          targetEngram: intent.targetEngram,
          emptyRecall: intent.emptyRecall,
        };
        await runGhampusSkillTrain(trainParsed, intent.skillName || undefined, makeSkillRouteRunner(), text);
        return;
      }

      if (intent.action === 'ui_only') {
        await emitGhampusMsg(`That requires the **Sources** or **Brain** view — I can't do it from here (${intent.reason}).`);
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
      let scopedEngrams = extractEngramScopeFromQuery(queryText, allEngramIds);
      if (scopedEngrams.length === 0) {
        const priorScopeText = [priorUserQuestion, priorGhampusSnippet].filter(Boolean).join(' ');
        if (priorScopeText) {
          scopedEngrams = extractEngramScopeFromQuery(priorScopeText, allEngramIds);
        }
      }
      const engramListStr = allEngrams.map((e) => `${e.graphId}="${e.displayName}"`).join(', ');
      const plan = await planGhampusToolsWithLlm(queryText, hints, llm, {
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
        turnSuggestionMeta = { skip: true, skipReason: 'direct_answer', directAnswerKind: hints.directAnswerKind };
        const kind = hints.directAnswerKind;

        if (kind === 'model_status') {
          const directStepId = stableTraceStepId('direct');
          emitTrace({ stepId: directStepId, status: 'running', label: 'Checking model status' });
          const status = await fetchGhampusLlmStatus(deps.host);
          throwIfCancelled();
          emitTrace({ stepId: directStepId, status: 'ok', label: 'Checking model status' });
          await emitGhampusMsg(formatModelStatusDirectAnswer(status));
          return;
        }

        if (kind === 'health_check') {
          const directStepId = stableTraceStepId('direct');
          emitTrace({ stepId: directStepId, status: 'running', label: 'Computing vitality' });
          const { buildHealthCheckReportMarkdown } = await import('./ghampus-vitality-health.js');
          const report = await buildHealthCheckReportMarkdown(deps.host, deps.brainEngine, text);
          throwIfCancelled();
          emitTrace({ stepId: directStepId, status: 'ok', label: 'Computing vitality' });
          await emitGhampusMsg(report);
          return;
        }

        const usesTranscript = kind === 'conversation_context' || kind === 'process_critique';
        const recentHistory = usesTranscript
          ? buildConversationContextBlock(histForHints.slice(0, -1), 15)
          : formatRecentThreadHistory(histForHints.slice(0, -1), 8);
        const traceLabel = kind === 'conversation_context'
          ? 'Reviewing this conversation'
          : kind === 'process_critique'
            ? 'Addressing your feedback'
            : kind === 'ghampus_identity'
              ? 'Answering about Ghampus'
              : kind === 'app_help'
                ? 'App help'
                : kind === 'chitchat'
                  ? 'Replying'
                  : kind === 'general_knowledge_offline'
                    ? 'Direct answer'
                    : 'Direct answer';
        let injectedFacts = '';
        if (kind === 'ghampus_identity') {
          injectedFacts = buildGhampusIdentityFactsBlock(resolveGhampusAppVersion());
        }
        const directStepId = stableTraceStepId('direct');
        emitTrace({ stepId: directStepId, status: 'running', label: traceLabel });
        const system = buildDirectAnswerSystemPrompt(kind, queryText, injectedFacts);
        const userPrompt = buildDirectAnswerUserPrompt(queryText, recentHistory, kind);
        let answer = await llmCompleteBounded(llm, {
          system,
          user: userPrompt,
          signal: turnSignal,
        }, kind === 'general_knowledge_offline' || kind === 'chitchat' ? 45_000 : GHAMPUS_LLM_TIMEOUT_MS).catch(() => null);
        throwIfCancelled();
        answer = sanitizeResponse(answer ?? '');
        if (kind === 'ghampus_identity') {
          answer = rewriteGhampusSelfReferenceFirstPerson(answer);
          if (!answer.trim()) {
            answer = formatGhampusIdentityDirectAnswer(resolveGhampusAppVersion());
          }
        }
        emitTrace({ stepId: directStepId, status: 'ok', label: traceLabel });
        await emitGhampusMsg(
          answer.trim()
            || (getThreadContext(histForHints)
              ? "I couldn't answer from the chat thread alone. Say **search memory** or repeat your question — I'll search your cortex."
              : "I couldn't answer that without searching memory. Try your question again with the topic or engram name."),
        );
        return;
      }

      if (plan.earlyRoute === 'mcp-tool-list') {
        turnSuggestionMeta = { skip: true, skipReason: 'direct_answer' };
        const keyword = extractMcpToolFilterKeyword(text);
        const tools = listMcpToolsForGhampus({ filterKeyword: keyword });
        await emitGhampusMsg(formatMcpToolList(tools, text, keyword));
        return;
      }

      if (plan.earlyRoute === 'skill-list') {
        turnSuggestionMeta = { skip: true, skipReason: 'direct_answer' };
        const res = await ghampusTool('list_skills', {}) as { skills?: Array<{ label: string; trainedAt?: string; vitality?: number; searchText?: string }> };
        const keyword = extractSkillFilterKeyword(text);
        const skills = filterSkillsByKeyword(res.skills ?? [], keyword);
        await emitGhampusMsg(formatSkillList(skills, text, keyword));
        return;
      }

      if (plan.earlyRoute === 'consistency-walk') {
        const pairs = deps.brainEngine?.getContradictionPairs() ?? [];
        const dupes = deps.brainEngine?.getDuplicatePairs() ?? [];
        if (pairs.length === 0 && dupes.length === 0) {
          await emitGhampusMsg('Nothing queued for Memory Integrity — no contradictions or duplicate pairs. Ask me again after you ingest new memories.');
          return;
        }
        let body = `**Memory Integrity walk** — ${pairs.length} contradiction(s), ${dupes.length} duplicate pair(s).\n\n`;
        for (const p of pairs.slice(0, 10)) {
          body += `\n---\n**${p.severity ?? 'medium'}** · ${p.temporalVerdict ?? 'genuine_contradiction'}\n`;
          body += `A: ${p.snippetA}\nB: ${p.snippetB}\n`;
          body += `Shared: ${(p.sharedEntities ?? []).slice(0, 4).join(', ')}\n`;
          body += `→ Resolve in **Foresight → Memory Integrity** (Keep A / Keep B / Mark debate). I will not apply edits without your approval.\n`;
        }
        if (dupes.length > 0) {
          body += `\n_${dupes.length} duplicate pair(s) — merge or keep-both in Check-in._\n`;
        }
        await emitGhampusMsg(body);
        return;
      }

      if (plan.earlyRoute === 'skill-walk') {
        turnSuggestionMeta = { skip: true, skipReason: 'skill_train' };
        const target = plan.implicitSkillSlug ?? hints.implicitSkillSlug ?? extractSkillWalkTarget(text) ?? '';
        await runGhampusSkillPreview(
          target,
          makeSkillRouteRunner(),
          text,
        );
        return;
      }

      if (plan.earlyRoute === 'skill-train') {
        turnSuggestionMeta = { skip: true, skipReason: 'skill_train' };
        const trainParsed = parseSkillTrainIntent(queryText);
        if (trainParsed) {
          await runGhampusSkillTrain(
            trainParsed,
            undefined,
            makeSkillRouteRunner(),
            text,
          );
        } else {
          await emitGhampusMsg(askGhampusClarification({
            kind: 'train_skill',
            originalText: text,
            phrase: '',
          }, (v) => state.setPendingClarification(v)));
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
        turnSuggestionMeta = {
          ...turnSuggestionMeta,
          recalled: true,
          ...(scopedEngrams.length === 1 ? { engramHint: scopedEngrams[0] } : {}),
        };
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

      if (hints.wantsRecent) {
        plan.phase2 = plan.phase2.filter(
          (e) => !['recall', 'remind', 'dig_deeper', 'cross_search', 'recall_structured'].includes(e.tool),
        );
        const recentRow = phase1Results.find((r) => r.tool === 'recent');
        const recentSources = (recentRow?.result as { sources?: RecentIngestSource[] })?.sources ?? [];
        for (const s of recentSources.slice(0, 5)) {
          if (!s.sourceId) continue;
          plan.phase2.push({
            tool: 'recall_source',
            args: {
              sourceId: s.sourceId,
              ...(s.graphId ? { engram: s.graphId } : {}),
              maxTokens: 1200,
            },
            phase: 2,
            optional: true,
          });
        }
      }

      const phase1StructuredCount = countStructuredNodesFromResults(phase1Results, queryText);
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

      if (!hasRecallHitsFromResults(allResults) && !hints.skipMemoryTools && !hints.wantsRecent) {
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

      const structuredFilterQuery = plan.recallContextQuery ?? queryText;
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
        && !hints.wantsRecent
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

      const asksForRoles = hints.wantsPersonRole || /\brol(e|uri)\b/i.test(queryText);

      const obResult = allResults.find((r) => r.tool === 'recall_obligations');
      if (obResult) {
        const obData = obResult.result as { obligations?: Parameters<typeof formatObligationsAnswer>[0] };
        const obAnswer = formatObligationsAnswer(obData?.obligations ?? [], queryText);
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
        text: queryText,
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
      const recallContextQuery = plan.recallContextQuery ?? queryText;
      const recallHasHits = hasRecallHitsFromResults(allResults);
      const recentIngestSources = (allResults.find((r) => r.tool === 'recent')?.result as { sources?: RecentIngestSource[] })?.sources ?? [];
      const hasRecentIngests = recentIngestSources.length > 0;

      if (consentBlocked && !recallHasHits && structuredNodes.length === 0 && !hasRecentIngests) {
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

      if (hints.wantsRecent && !hasRecentIngests && !recallHasHits && structuredNodes.length === 0) {
        await emitGhampusMsg(
          "I couldn't find any recently ingested sources in your cortex yet. Save something first with `/save` or **remember**.",
        );
        return;
      }

      const recentChatTurns = hints.wantsThreadGrounding ? 12 : 8;
      const recentChat = formatRecentThreadHistory(histForHints.slice(0, -1), recentChatTurns);
      const recent_chat_block = recentChat
        ? `\n\n<recent_chat>\n${recentChat}\n</recent_chat>`
        : '';

      const threadGroundingBlock = hints.wantsThreadGrounding && hints.threadPriorUserQuestion
        ? `\nTHREAD GROUNDING — the user's message is a short follow-up to the chat below, NOT a new topic.
Prior user question: ${hints.threadPriorUserQuestion}
Answer ONLY that thread topic using <recent_chat> and <cortex_data>. Do NOT introduce unrelated product features, architecture, or capabilities.
If attested memory does not address the thread topic, say what is missing — do not invent or pad.\n`
        : '';

      const sections: string[] = [];
      if (hasRecentIngests) {
        sections.push(
          '## Most recently ingested sources (newest first — authoritative for recency queries)\n'
          + formatRecentIngestsSection(recentIngestSources),
        );
      }
      for (const r of allResults) {
        if (r.tool !== 'recall_source' || !r.result) continue;
        const srcText = String((r.result as { text?: string }).text ?? '').trim();
        if (srcText) {
          sections.push('## Content from a recent save\n' + srcText.slice(0, 2500));
        }
      }
      if (primaryRecall && !hints.wantsRecent) {
        sections.push('## What I found in your cortex (attested memory)\n' + primaryRecall.slice(0, hints.recallMaxTokens > 4000 ? 8000 : 3000));
      } else if (primaryRecall && hints.wantsRecent) {
        sections.push('## Additional semantic recall (secondary — prefer recency list above)\n' + primaryRecall.slice(0, 1500));
      }
      if (structuredNodes.length > 0) {
        sections.push('## Recall hits (structured)\n' + structuredNodes.map((n) => `- ${(n.text ?? '').trim()}`).join('\n'));
      }

      const contextBlock = sections.length
        ? `\n\n<cortex_data>\n${sections.join('\n\n')}\n</cortex_data>`
        : '';

      const langBlock = buildResponseLanguageRulesBlock(queryText);
      const roRules = buildRomanianContentRulesBlock(queryText);
      const thinRecallBlock = isThinRecallContext(structuredNodes.length, digDeeperRan)
        ? `\n${buildThinRecallGroundingBlock()}\n`
        : '';
      const adviceRecallBlock = hints.wantsAdviceRecall
        ? `\n${buildAdviceRecallGroundingBlock()}\n`
        : '';
      const briefMode = shouldDefaultBriefAnswer(queryText, hints);
      const brevityBlock = buildGhampusBrevityRulesBlock({
        expanded: !briefMode,
        simplePersonLookup: isSimplePersonLookupQuestion(queryText) || hints.wantsPersonRole,
        howTo: isHowToQuestionText(queryText),
      });

      const system = `You are Ghampus — the AI built into Graphnosis.

${GHAMPUS_DOMAIN_GLOSSARY_BLOCK}
${GHAMPUS_GROUNDING_RULES_BLOCK}
${threadGroundingBlock}${roRules ? `\n${roRules}\n` : ''}${thinRecallBlock}${adviceRecallBlock}
${brevityBlock}

${langBlock}

Use ONLY attested memory in <cortex_data>. Never invent facts.
${hints.wantsRecent ? 'For recency questions, list sources from "Most recently ingested sources" in strict newest-first order; do not reorder by semantic relevance.\n' : ''}
Never mention knowledge cutoffs, training data limits, or apologize for lacking web access.
If <cortex_data> is empty or thin, say what is missing from the user's cortex — do not guess, invent English title translations, or pad with unrelated facts.
Do NOT invent English titles for Romanian (or other non-English) book or work names — quote titles exactly as stored; if uncertain, use the original-language title without guessing (e.g. keep "Cânturi de pe frunte", never invent "Songs from the Shelf").
Preserve person names exactly as in <cortex_data> — never merge spellings or create OCR-corrupted variants.
Use <recent_chat> when the user refers to your prior Ghampus answers, earlier turns, or asks follow-ups (pronouns like "that/this/it", "you said", "the second point", "check your docs") — resolve those from recent turns FIRST; do not treat them as fresh cortex lookups unless the user pivots to a new topic or person.
Never echo <recent_chat>, <cortex_data>, "## Attested Memory", "## dig_deeper", "## Recent Chat", node counts, avg scores, "Source-filename expansion", "Cross-engram entity hop", or other internal tags/meta in your answer.
${consentBlocked ? '\nNote: cross-engram search was blocked by consent — answer only from the attested memory below.\n' : ''}
OUTPUT: clean markdown for the user — no node IDs, pipe-separated records, or recall-process narration.${contextBlock}${recent_chat_block}`;

      const synthStepId = stableTraceStepId('synth');
      emitTrace({ stepId: synthStepId, status: 'running', label: 'Synthesizing answer with local LLM' });
      let draft = await llmCompleteBounded(llm, { system, user: queryText, signal: turnSignal }).catch(() => null);
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
          system: system + `\n\nRewrite in ${responseLanguageLabel(detectUserMessageLanguage(queryText))} only — no IDs or pipe characters.`,
          user: queryText,
          signal: turnSignal,
        }).catch(() => null);
        if (retry?.trim()) draft = sanitizeResponse(retry);
      }

      if (hints.wantsGrouped && !looksGroupedResponse(draft)) {
        const retry = await llmCompleteBounded(llm, {
          system: system + '\n\nReformat with markdown ### headings grouped as requested.',
          user: queryText,
          signal: turnSignal,
        }).catch(() => null);
        if (retry?.trim()) draft = sanitizeResponse(retry);
      }

      const recallContextForVerify = sections.join('\n\n');
      // Verify against the user's question — not buildRecallQueryForTool expansion tokens
      // (e.g. "role rol team echipa owners" added for search ranking need not appear in hits).
      const recallVerifyQuery = (() => {
        const topic = extractTopicAboutFromQuery(queryText);
        if (topic && (hints.wantsTopicAbout || hints.wantsDefinitional)) return topic;
        return queryText;
      })();
      if (primaryRecall && !recallContextMatchesQuery(primaryRecall, recallVerifyQuery)) {
        recallDbg(
          '[ghampus] recall context may not match planned query',
          `q=${recallVerifyQuery.slice(0, 120)}`,
        );
      }

      const finalAnswer = await finalizeGhampusAnswerWithVerification(llm, queryText, draft, {
        queryHints: hints,
        recallContext: recallContextForVerify,
        recallHasHits,
        polishSource: 'synthesis',
        emitTrace: emitFinalizeTrace,
      });

      const honestAnswer = applyRecallHonestyGuardrails(finalAnswer.trim() || draft, {
        recallContext: recallContextForVerify,
        isAdviceQuery: hints.wantsAdviceRecall,
        recallHasHits,
      });

      await emitGhampusMsg(honestAnswer.trim() || draft);
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
        if (cortexDirForHistory) {
          await appendGhampusHistoryMessage(cortexDirForHistory, stoppedMsg);
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
      if (cortexDirForHistory) {
        await appendGhampusHistoryMessage(cortexDirForHistory, errMsg);
      }
      deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: errMsg });
    } finally {
      clearGhampusTurn(traceTurnId);
      decrementGhampusBusy();
    }
  });

  return { ok: true };
}
