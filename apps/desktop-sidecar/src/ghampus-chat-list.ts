/**
 * The Ghampus chat list — every past session on disk, newest first.
 *
 * Sessions live as one JSONL file per thread under cortex/ghampus/sessions/
 * (see ghampus-session-store.ts). This module reads that directory and gives
 * each thread a short display title: the local LLM writes one when it is
 * available, otherwise the first user message is truncated.
 *
 * Titles are cached in cortex/ghampus/session-titles.json keyed by session id,
 * so a thread is titled once rather than on every list. The cache records the
 * turn count it was built from — a growing thread (normally only the active
 * one) is re-titled when it gains turns, a finished one never is.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalLlm } from './correction.js';
import { extractSessionTurns, type SessionTurn } from './ghampus-session-summary.js';
import { ensureActiveGhampusSession } from './ghampus-session-store.js';

/** Hard ceiling on a title, enforced on both the LLM and the fallback path. */
export const CHAT_TITLE_MAX_CHARS = 32;

/** Sessions listed per call. Older threads stay on disk, they are just not listed. */
const MAX_SESSIONS_LISTED = 200;

/** Threads re-titled by the LLM in one list pass, so opening the rail stays cheap. */
const MAX_LLM_TITLES_PER_PASS = 4;

export interface GhampusChatSummary {
  sessionId: string;
  title: string;
  /** True when the title came from the local LLM rather than the truncation fallback. */
  titleFromLlm: boolean;
  turnCount: number;
  /** Epoch ms of the last turn, or the file mtime for a thread with no parsable turns. */
  updatedAt: number;
  active: boolean;
}

interface TitleCacheEntry {
  title: string;
  turnCount: number;
  fromLlm: boolean;
}

type TitleCache = Record<string, TitleCacheEntry>;

function titleCachePath(cortexDir: string): string {
  return join(cortexDir, 'ghampus', 'session-titles.json');
}

function sessionsDir(cortexDir: string): string {
  return join(cortexDir, 'ghampus', 'sessions');
}

async function readTitleCache(cortexDir: string): Promise<TitleCache> {
  const raw = await readFile(titleCachePath(cortexDir), 'utf8').catch(() => '');
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as TitleCache) : {};
  } catch {
    return {};
  }
}

async function writeTitleCache(cortexDir: string, cache: TitleCache): Promise<void> {
  await writeFile(titleCachePath(cortexDir), JSON.stringify(cache, null, 2), 'utf8')
    .catch(() => {
      /* non-fatal — the next list re-derives titles, it just costs the LLM again */
    });
}

/**
 * Collapse to a single line and cut to `CHAT_TITLE_MAX_CHARS`.
 *
 * The ellipsis is NOT appended here. The rail renders the full string in one
 * unwrapped line and lets CSS `text-overflow: ellipsis` add the "…", so the
 * visual truncation follows the real column width rather than a character
 * count guessed on this side. The `title` attribute carries the full string.
 */
export function normalizeChatTitle(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= CHAT_TITLE_MAX_CHARS) return flat;
  return flat.slice(0, CHAT_TITLE_MAX_CHARS).trimEnd();
}

/** The no-LLM path: the message that opened the thread, truncated. */
export function fallbackChatTitle(turns: SessionTurn[]): string {
  const firstUser = turns.find((t) => t.role === 'user' && t.text.trim());
  const seed = firstUser?.text ?? turns[0]?.text ?? '';
  return normalizeChatTitle(seed) || 'Untitled chat';
}

async function titleWithLlm(llm: LocalLlm, turns: SessionTurn[]): Promise<string | null> {
  const { isBusyAbove, tryAcquireLlmSlot, WorkPriority } = await import('./work-priority.js');
  if (isBusyAbove(WorkPriority.P2_GHAMPUS)) return null;
  const slot = tryAcquireLlmSlot(WorkPriority.P3_ENRICHMENT);
  if (!slot || slot.signal.aborted) return null;
  try {
    const transcript = turns.slice(0, 12).map((t) => {
      const who = t.role === 'user' ? 'User' : 'Ghampus';
      return `${who}: ${t.text.replace(/\s+/g, ' ').slice(0, 300)}`;
    }).join('\n');
    const raw = await llm.complete({
      system:
        'Write a short title for this chat, describing what it is about. '
        + `Maximum ${CHAT_TITLE_MAX_CHARS} characters. No quotes, no trailing period, `
        + 'no preamble — reply with the title text only.',
      user: transcript.slice(0, 4000),
      signal: slot.signal,
    });
    const title = normalizeChatTitle((raw ?? '').replace(/^["'\s]+|["'\s]+$/g, ''));
    return title || null;
  } catch {
    return null;
  } finally {
    slot.release();
  }
}

async function readSessionTurns(cortexDir: string, sessionId: string): Promise<SessionTurn[]> {
  const raw = await readFile(join(sessionsDir(cortexDir), `${sessionId}.jsonl`), 'utf8')
    .catch(() => '');
  if (!raw.trim()) return [];
  const messages = raw.trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  }).filter((m): m is unknown => m != null);
  return extractSessionTurns(messages);
}

/**
 * Every chat thread on disk, newest first.
 *
 * `llm` is optional: without it every title comes from the truncation
 * fallback, which is a real title rather than a placeholder — so the list is
 * fully usable on a machine with no local model configured.
 */
export async function listGhampusChats(
  cortexDir: string,
  llm?: LocalLlm | null,
): Promise<{ chats: GhampusChatSummary[]; activeSessionId: string }> {
  if (!cortexDir) return { chats: [], activeSessionId: '' };

  const activeSessionId = await ensureActiveGhampusSession(cortexDir);
  const entries = await readdir(sessionsDir(cortexDir)).catch(() => [] as string[]);
  const sessionIds = entries
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => name.slice(0, -'.jsonl'.length));
  if (sessionIds.length === 0) return { chats: [], activeSessionId };

  const cache = await readTitleCache(cortexDir);
  let cacheDirty = false;
  let llmBudget = MAX_LLM_TITLES_PER_PASS;

  const chats: GhampusChatSummary[] = [];
  for (const sessionId of sessionIds) {
    const turns = await readSessionTurns(cortexDir, sessionId);
    const filePath = join(sessionsDir(cortexDir), `${sessionId}.jsonl`);
    const mtime = await stat(filePath).then((s) => s.mtimeMs).catch(() => 0);
    const updatedAt = turns.length > 0 ? (turns[turns.length - 1]?.ts ?? mtime) : mtime;

    // An empty thread is the freshly-started active session. Listing it as a
    // chat would show an entry with nothing in it, so skip it — it reappears
    // the moment it has a turn.
    if (turns.length === 0) continue;

    const cached = cache[sessionId];
    const stale = !cached || cached.turnCount !== turns.length;
    let title = cached?.title ?? '';
    let titleFromLlm = cached?.fromLlm ?? false;

    if (stale) {
      title = fallbackChatTitle(turns);
      titleFromLlm = false;
      if (llm && llmBudget > 0) {
        llmBudget -= 1;
        const llmTitle = await titleWithLlm(llm, turns);
        if (llmTitle) {
          title = llmTitle;
          titleFromLlm = true;
        }
      }
      cache[sessionId] = { title, turnCount: turns.length, fromLlm: titleFromLlm };
      cacheDirty = true;
    }

    chats.push({
      sessionId,
      title,
      titleFromLlm,
      turnCount: turns.length,
      updatedAt,
      active: sessionId === activeSessionId,
    });
  }

  // Drop cache entries whose session file is gone, so the file cannot grow
  // without bound across cortex lifetimes.
  const live = new Set(sessionIds);
  for (const key of Object.keys(cache)) {
    if (!live.has(key)) {
      delete cache[key];
      cacheDirty = true;
    }
  }
  if (cacheDirty) await writeTitleCache(cortexDir, cache);

  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  return { chats: chats.slice(0, MAX_SESSIONS_LISTED), activeSessionId };
}

/**
 * Make an existing thread the active one.
 *
 * Nothing is deleted: the thread being left stays in sessions/ and is still
 * listed, so this is reversible by opening it again.
 */
export async function openGhampusChat(
  cortexDir: string,
  sessionId: string,
): Promise<{ ok: boolean; activeSessionId: string }> {
  if (!cortexDir || !sessionId) return { ok: false, activeSessionId: '' };
  // Reject anything that could escape sessions/ — the id reaches us from the UI.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes('..')) {
    return { ok: false, activeSessionId: await ensureActiveGhampusSession(cortexDir) };
  }
  const exists = await stat(join(sessionsDir(cortexDir), `${sessionId}.jsonl`))
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return { ok: false, activeSessionId: await ensureActiveGhampusSession(cortexDir) };
  }
  await ensureActiveGhampusSession(cortexDir);
  await writeFile(join(cortexDir, 'ghampus', 'active-session.txt'), sessionId, 'utf8');
  return { ok: true, activeSessionId: sessionId };
}
