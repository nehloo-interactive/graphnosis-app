/**
 * Ghampus post-turn memory suggestions — heuristic cards asking the user to
 * save factual info they shared but Ghampus did not persist.
 *
 * Emits `ghampus.memory-suggestion` after a completed turn (async, non-blocking).
 * No cloud LLM required for v1; optional P3 local extract when heuristics are weak.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveGhampusMemorySuggestionsSettings } from '@graphnosis-app/core/settings';
import type { GraphnosisHost } from './host.js';
import type { BroadcastRawFn } from './events.js';
import type { LocalLlm } from './correction.js';
import { listRecentSaves } from './agent-tools.js';
import { extractDueDateFromLine, augmentMemoryWithTemporalContext } from './ghampus-temporal-parse.js';
import { extractEngramScopeFromQuery } from './ghampus-intent.js';
import { isGhampusBusy } from './ghampus-busy.js';

export type MemorySuggestionKind = 'remember' | 'obligation' | 'create_engram';

export interface MemorySuggestionObligation {
  obligationType: 'deadline' | 'renewal' | 'review-by';
  expiresAt: number;
}

export interface GhampusMemorySuggestionPayload {
  id: string;
  kind: MemorySuggestionKind;
  text: string;
  engramHint?: string;
  createEngramName?: string;
  obligation?: MemorySuggestionObligation;
  reason: string;
  ts: number;
}

export type TurnSuggestionSkipReason =
  | 'slash_command'
  | 'already_saved'
  | 'direct_answer'
  | 'skill_train'
  | 'clarification'
  | 'error_turn';

export interface TurnSuggestionMeta {
  skip?: boolean;
  skipReason?: TurnSuggestionSkipReason;
  directAnswerKind?: string;
  recalled?: boolean;
  alreadySaved?: boolean;
  engramHint?: string;
}

export interface ScheduleMemorySuggestionDeps {
  host: GraphnosisHost;
  broadcastRaw: BroadcastRawFn;
  cortexDir: string;
  llm?: () => LocalLlm | null;
}

interface SuggestionState {
  version: 1;
  sessionStartedAt: number;
  dismissedIds: Record<string, number>;
  recentTexts: string[];
}

const STATE_FILE = 'ghampus-suggestion-state.json';
const MAX_SNIPPET_CHARS = 500;
const MIN_USER_MSG_CHARS = 18;
const OVERLAP_THRESHOLD = 0.55;

const MEMORY_SIGNAL_RE = new RegExp(
  [
    '\\b(decided|decide|will\\s|going\\s+to|deadline|due\\s|remember\\s+that|note\\s+that|important[:\\s]|'
    + 'contact|prefers?|preference|committed|launching|hired|promoted|moved\\s+to|budget|contract|signed)\\b',
    '\\b(am\\s+decis|termen|not[aă]|important[:\\s]|voi\\s|am\\s+ales|contact|prefer)\\b',
    '\\b(save\\s+this|keep\\s+in\\s+mind|don\'?t\\s+forget)\\b',
  ].join('|'),
  'i',
);

const CHITCHAT_ONLY_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|sure|got it|cool|great|bye|goodbye|salut|mersi|mulțumesc)[\s!.?]*$/i;

const QUESTION_ONLY_RE = /^(what|who|when|where|why|how|which|can you|could you|tell me|show me|list|recall|remind me)\b/i;

const CREATE_ENGRAM_RE = /\b(new\s+project|starting\s+(a\s+)?project|working\s+on\s+(a\s+)?project)\b/i;

let stateCache: SuggestionState | null = null;
let statePath: string | null = null;
const sessionStartedAt = Date.now();

function defaultState(): SuggestionState {
  return {
    version: 1,
    sessionStartedAt,
    dismissedIds: {},
    recentTexts: [],
  };
}

async function loadState(cortexDir: string): Promise<SuggestionState> {
  if (stateCache && statePath === path.join(cortexDir, STATE_FILE)) return stateCache;
  statePath = path.join(cortexDir, STATE_FILE);
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SuggestionState>;
    stateCache = {
      ...defaultState(),
      ...parsed,
      version: 1,
      sessionStartedAt: parsed.sessionStartedAt === sessionStartedAt
        ? (parsed.sessionStartedAt ?? sessionStartedAt)
        : sessionStartedAt,
      dismissedIds: parsed.dismissedIds ?? {},
      recentTexts: Array.isArray(parsed.recentTexts) ? parsed.recentTexts.slice(-8) : [],
    };
  } catch {
    stateCache = defaultState();
  }
  return stateCache;
}

async function persistState(cortexDir: string): Promise<void> {
  if (!stateCache || !statePath) return;
  await fs.mkdir(cortexDir, { recursive: true }).catch(() => {});
  await fs.writeFile(statePath, JSON.stringify(stateCache, null, 2), 'utf8').catch(() => {});
}

function normalizeForOverlap(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(normalizeForOverlap(a).split(' ').filter((w) => w.length > 2));
  const tb = new Set(normalizeForOverlap(b).split(' ').filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

/** Skip only exact duplicate suggestion text already shown this session. */
function isDuplicateSuggestion(text: string, recent: string[]): boolean {
  const norm = normalizeForOverlap(text);
  return recent.some((prior) => prior === norm);
}

function extractCandidateSnippet(userText: string): string {
  const trimmed = userText.trim();
  const stripped = trimmed
    .replace(/^(remember\s+that|note\s+that|important:\s*|not[aă]:\s*)/i, '')
    .trim();
  const sentences = stripped.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 8);
  const factual = sentences.find((s) => MEMORY_SIGNAL_RE.test(s)) ?? sentences[0] ?? stripped;
  let snippet = factual.trim();
  if (snippet.length > MAX_SNIPPET_CHARS) {
    snippet = `${snippet.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
  }
  return snippet;
}

function detectObligation(userText: string): MemorySuggestionObligation | undefined {
  const due = extractDueDateFromLine(userText);
  if (!due) return undefined;
  const lower = userText.toLowerCase();
  let obligationType: MemorySuggestionObligation['obligationType'] = 'deadline';
  if (/\b(review|revis|verific)\b/i.test(lower)) obligationType = 'review-by';
  else if (/\b(renew|reînno)/i.test(lower)) obligationType = 'renewal';
  return { obligationType, expiresAt: due.expiresAt };
}

function shouldSkipUserMessage(userText: string): string | null {
  const t = userText.trim();
  if (t.length < MIN_USER_MSG_CHARS) return 'message too short';
  if (t.startsWith('/')) return 'slash command';
  if (CHITCHAT_ONLY_RE.test(t)) return 'chitchat';
  if (QUESTION_ONLY_RE.test(t) && !MEMORY_SIGNAL_RE.test(t) && t.endsWith('?')) return 'question only';
  return null;
}

function scoreMemorySignals(userText: string): number {
  let score = 0;
  if (MEMORY_SIGNAL_RE.test(userText)) score += 3;
  if (detectObligation(userText)) score += 4;
  if (/\b(decided|am decis|signed|committed|deadline|termen)\b/i.test(userText)) score += 2;
  if (userText.length > 80) score += 1;
  return score;
}

async function maybeLlmExtractSnippet(
  llm: LocalLlm | null,
  userText: string,
): Promise<string | null> {
  if (!llm || userText.length < 120) return null;
  const { isBusyAbove, tryAcquireLlmSlot, WorkPriority } = await import('./work-priority.js');
  if (isBusyAbove(WorkPriority.P2_GHAMPUS) || isGhampusBusy()) return null;
  const slot = tryAcquireLlmSlot(WorkPriority.P3_ENRICHMENT);
  if (!slot || slot.signal.aborted) return null;
  try {
    const raw = await llm.complete({
      system: 'Extract ONE factual statement the USER wants remembered. Reply with plain text only — max 300 chars. If nothing worth saving, reply SKIP.',
      user: userText.slice(0, 2000),
      signal: slot.signal,
    });
    const out = (raw ?? '').trim();
    if (!out || /^skip$/i.test(out)) return null;
    return out.length > MAX_SNIPPET_CHARS ? `${out.slice(0, MAX_SNIPPET_CHARS - 1)}…` : out;
  } catch {
    return null;
  } finally {
    slot.release();
  }
}

function detectCreateEngramHint(userText: string, recentUserTexts: string[]): string | null {
  if (!CREATE_ENGRAM_RE.test(userText)) return null;
  const nameMatch = userText.match(/\b(?:project|proiect)\s+(?:called|named|numit)?\s*["']?([A-Za-z0-9][\w\s-]{2,40})/i);
  const name = nameMatch?.[1]?.trim();
  if (!name) return null;
  const mentions = [userText, ...recentUserTexts].filter((t) =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t),
  ).length;
  if (mentions < 2) return null;
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function resolveDefaultEngramHint(host: GraphnosisHost, userText: string): Promise<string | undefined> {
  const graphs = host.listGraphs();
  const scoped = extractEngramScopeFromQuery(userText, graphs);
  if (scoped.length === 1) return scoped[0];
  const personal = graphs.find((g) => g === 'personal' || g === 'coding');
  return personal ?? graphs[0];
}

export async function scheduleMemorySuggestionAfterTurn(
  deps: ScheduleMemorySuggestionDeps,
  opts: {
    userText: string;
    turnId: string;
    turnMeta: TurnSuggestionMeta;
    recentUserTexts?: string[];
  },
): Promise<void> {
  const settings = resolveGhampusMemorySuggestionsSettings(deps.host.getSettings().agent);
  if (!settings.enabled) return;

  const cortexDir = deps.cortexDir;
  if (!cortexDir) return;

  if (opts.turnMeta.skip || opts.turnMeta.alreadySaved) return;
  if (opts.turnMeta.skipReason === 'slash_command'
    || opts.turnMeta.skipReason === 'direct_answer'
    || opts.turnMeta.skipReason === 'skill_train'
    || opts.turnMeta.skipReason === 'clarification'
    || opts.turnMeta.skipReason === 'error_turn') return;

  const skipMsg = shouldSkipUserMessage(opts.userText);
  if (skipMsg) return;

  const state = await loadState(cortexDir);
  const now = Date.now();

  let score = scoreMemorySignals(opts.userText);
  const obligation = detectObligation(opts.userText);

  if (opts.turnMeta.recalled && !obligation && score < 3) {
    if (!MEMORY_SIGNAL_RE.test(opts.userText)) return;
  }

  if (score < 2 && !obligation) {
    const llmSnippet = await maybeLlmExtractSnippet(deps.llm?.() ?? null, opts.userText);
    if (!llmSnippet) return;
    opts = { ...opts, userText: llmSnippet };
    score = 3;
  }

  let kind: MemorySuggestionKind = obligation ? 'obligation' : 'remember';
  let text = extractCandidateSnippet(opts.userText);
  if (!text || text.length < 12) return;

  const createSlug = detectCreateEngramHint(opts.userText, opts.recentUserTexts ?? []);
  if (createSlug && score >= 4) {
    kind = 'create_engram';
  }

  const recentSaves = listRecentSaves({ host: deps.host }, { limit: 12, sinceMs: now - 3 * 24 * 60 * 60_000 });
  for (const save of recentSaves.saves) {
    if (tokenOverlap(text, save.label) >= OVERLAP_THRESHOLD) return;
  }
  if (isDuplicateSuggestion(text, state.recentTexts)) return;

  const engramHint = opts.turnMeta.engramHint
    ?? await resolveDefaultEngramHint(deps.host, opts.userText);

  const id = `mem-sug-${opts.turnId}-${now.toString(36)}`;
  if (state.dismissedIds[id]) return;

  const reason = obligation
    ? 'Deadline or due date detected in your message'
    : kind === 'create_engram'
      ? 'You mentioned a new project — create a dedicated engram?'
      : opts.turnMeta.recalled
        ? 'You added new details while we discussed memory'
        : 'Looks like something worth saving to your cortex';

  const payload: GhampusMemorySuggestionPayload = {
    id,
    kind,
    text,
    ...(engramHint ? { engramHint } : {}),
    ...(kind === 'create_engram' && createSlug ? { createEngramName: createSlug } : {}),
    ...(obligation ? { obligation } : {}),
    reason,
    ts: now,
  };

  state.recentTexts = [...state.recentTexts, normalizeForOverlap(text)].slice(-8);
  await persistState(cortexDir);

  deps.broadcastRaw({
    kind: 'ghampus.memory-suggestion',
    name: 'ghampus.memory-suggestion',
    payload,
  });
}

export async function dismissMemorySuggestion(cortexDir: string, id: string): Promise<void> {
  const state = await loadState(cortexDir);
  state.dismissedIds[id] = Date.now();
  const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
  for (const [k, v] of Object.entries(state.dismissedIds)) {
    if (v < cutoff) delete state.dismissedIds[k];
  }
  await persistState(cortexDir);
}

export async function acceptMemorySuggestion(
  host: GraphnosisHost,
  cortexDir: string,
  args: {
    id: string;
    text: string;
    engramId: string;
    kind: MemorySuggestionKind;
    obligation?: MemorySuggestionObligation;
    createEngramName?: string;
  },
): Promise<{ ok: true; engramId: string; sourceId?: string }> {
  await dismissMemorySuggestion(cortexDir, args.id);

  const saveText = augmentMemoryWithTemporalContext(args.text).text;

  if (args.kind === 'create_engram' && args.createEngramName) {
    const slug = args.createEngramName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!host.listGraphs().includes(slug)) {
      await host.createGraph(slug);
    }
    const { ingestClip } = await import('./ingest.js');
    const rec = await ingestClip(host, slug, saveText, saveText.slice(0, 80), {
      addedBy: 'ghampus',
      sourceKind: 'ai-conversation',
      triggeredBy: 'ghampus:memory-suggestion',
      ...(args.obligation ? { obligation: args.obligation } : {}),
    });
    return { ok: true, engramId: slug, sourceId: rec.sourceId };
  }

  const { ingestClip } = await import('./ingest.js');
  const rec = await ingestClip(host, args.engramId, saveText, saveText.slice(0, 80), {
    addedBy: 'ghampus',
    sourceKind: 'ai-conversation',
    triggeredBy: 'ghampus:memory-suggestion',
    ...(args.obligation ? { obligation: args.obligation } : {}),
  });
  return { ok: true, engramId: args.engramId, sourceId: rec.sourceId };
}
