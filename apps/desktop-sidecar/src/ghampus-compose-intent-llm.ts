/**
 * Optional local-LLM intent refinement for the Ghampus compose rail.
 * Heuristics run first (sync); this module augments ambiguous idle inputs
 * with a short-timeout classify pass — language-agnostic, offline when configured.
 */
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import {
  buildClassifySystemPrompt,
  keywordIntent,
  parseClassifyIntent,
  type GhampusIntent,
} from './ghampus-intent.js';
import { resolveComposeSaveEngramHint } from './ghampus-compose-assist.js';
import type { PrimaryIntent } from './ghampus-compose-assist.js';
import { llmCompleteBounded } from './ghampus-timeout.js';
import { tryAcquireLlmSlot, WorkPriority } from './work-priority.js';

/** Short ceiling — compose rail must not stall typing. */
export const COMPOSE_INTENT_LLM_TIMEOUT_MS = 3500;

export interface ComposeIntentFields {
  primaryIntent: PrimaryIntent;
  intentLabel: string;
  mcpToolHint: string | null;
  saveIntent: boolean;
  slashSave: boolean;
  slashCommand: string | null;
  selectedEngramHint: string | null;
}

export interface ComposeIntentRefineResult {
  refined: boolean;
  intentSource?: 'llm';
  llmConfidence?: number | null;
  fields?: ComposeIntentFields;
}

/** Heuristic intent is idle but the user typed something substantive. */
export function needsComposeLlmRefine(text: string, primaryIntent: PrimaryIntent): boolean {
  const t = text.trim();
  if (primaryIntent !== 'idle') return false;
  if (t.length < 3 || t.length > 240) return false;
  if (t.startsWith('/')) return false;
  return true;
}

/** Gate LLM upgrades — never override heuristics; require confidence per action. */
export function shouldAcceptLlmComposeIntent(intent: GhampusIntent & { confidence?: number }): boolean {
  const c = intent.confidence ?? 0.5;
  switch (intent.action) {
    case 'remember':
      return c >= 0.75;
    case 'edit':
      return c >= 0.7;
    case 'create_engram':
      return c >= 0.85;
    case 'train_skill':
      return c >= 0.8;
    case 'ui_only':
      return false;
    case 'recall':
      return c >= 0.6;
    default:
      return false;
  }
}

export function mapGhampusIntentToComposeFields(
  intent: GhampusIntent,
  originalText: string,
): ComposeIntentFields {
  switch (intent.action) {
    case 'remember': {
      const kw = keywordIntent(originalText);
      const hint = intent.engram?.toLowerCase()
        ?? resolveComposeSaveEngramHint(originalText, kw)?.toLowerCase()
        ?? null;
      return {
        primaryIntent: 'save',
        intentLabel: 'Saving to memory',
        mcpToolHint: 'remember',
        saveIntent: true,
        slashSave: false,
        slashCommand: null,
        selectedEngramHint: hint,
      };
    }
    case 'edit':
      return {
        primaryIntent: 'edit',
        intentLabel: 'Correcting memory',
        mcpToolHint: 'edit',
        saveIntent: false,
        slashSave: false,
        slashCommand: null,
        selectedEngramHint: intent.engram?.toLowerCase() ?? null,
      };
    case 'create_engram':
      return {
        primaryIntent: 'create_engram',
        intentLabel: 'Creating engram',
        mcpToolHint: 'list_engrams',
        saveIntent: false,
        slashSave: false,
        slashCommand: null,
        selectedEngramHint: null,
      };
    case 'train_skill':
      return {
        primaryIntent: 'skill',
        intentLabel: 'Training a skill',
        mcpToolHint: 'train_skill',
        saveIntent: false,
        slashSave: false,
        slashCommand: null,
        selectedEngramHint: intent.targetEngram?.toLowerCase() ?? null,
      };
    case 'ui_only':
      return {
        primaryIntent: 'idle',
        intentLabel: '',
        mcpToolHint: null,
        saveIntent: false,
        slashSave: false,
        slashCommand: null,
        selectedEngramHint: null,
      };
    case 'recall':
    default:
      return {
        primaryIntent: 'recall',
        intentLabel: 'Searching memory',
        mcpToolHint: 'recall',
        saveIntent: false,
        slashSave: false,
        slashCommand: null,
        selectedEngramHint: null,
      };
  }
}

function isLlmEnabled(host: GraphnosisHost): boolean {
  return host.getSettings().ai.llmEnabled === true;
}

export async function refineComposeIntentWithLlm(
  deps: { host: GraphnosisHost; llm: LocalLlm | null },
  text: string,
): Promise<ComposeIntentRefineResult> {
  if (!deps.llm || !isLlmEnabled(deps.host)) return { refined: false };

  const slot = tryAcquireLlmSlot(WorkPriority.P3_ENRICHMENT);
  if (!slot || slot.signal.aborted) return { refined: false };

  try {
    const engrams = deps.host.listGraphs().map((graphId) => {
      const meta = deps.host.getGraphMetadata(graphId);
      return `${graphId}="${meta?.displayName ?? graphId}"`;
    });
    const classifyRaw = await llmCompleteBounded(
      deps.llm,
      {
        system: buildClassifySystemPrompt(engrams.join(', ')),
        user: text.trim(),
        signal: slot.signal,
      },
      COMPOSE_INTENT_LLM_TIMEOUT_MS,
    );
    const parsed = parseClassifyIntent(classifyRaw);
    if (!parsed || !shouldAcceptLlmComposeIntent(parsed)) {
      return { refined: false, llmConfidence: parsed?.confidence ?? null };
    }
    const fields = mapGhampusIntentToComposeFields(parsed, text);
    if (fields.primaryIntent === 'idle') return { refined: false, llmConfidence: parsed.confidence ?? null };
    return {
      refined: true,
      intentSource: 'llm',
      llmConfidence: parsed.confidence ?? null,
      fields,
    };
  } catch {
    return { refined: false };
  } finally {
    slot.release();
  }
}
