/**
 * Bounded waits for Ghampus turns — LLM calls, recall, and full-turn ceiling.
 */

import type { LocalLlm } from './correction.js';

/** Hard ceiling for one ghampus:send turn (plan + recall + synth). */
export const GHAMPUS_TURN_TIMEOUT_MS = 180_000;

/** Per local-LLM call during classify / plan / synthesize. */
export const GHAMPUS_LLM_TIMEOUT_MS = 90_000;

/** Fail Ghampus recall if still queued behind a long ingest. */
export const GHAMPUS_RECALL_QUEUE_TIMEOUT_MS = 20_000;

/** Fail Ghampus recall if embed + search exceeds this (large engram load). */
export const GHAMPUS_RECALL_OP_TIMEOUT_MS = 120_000;

export function mergeAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => s != null);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid);
  const ctrl = new AbortController();
  for (const s of valid) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

export function isGhampusTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timed out|timeout|embedding pipeline busy|took too long/i.test(msg);
}

export function ghampusTimeoutUserMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/embedding pipeline busy|waited \d+s for the embedding/i.test(msg)) {
    return 'Memory search is **busy** — another ingest may still be embedding. Wait a moment and try again, or ask about a specific engram by name.';
  }
  if (/loadGraph timed out|engram.*load/i.test(msg)) {
    return 'Loading an engram took too long — it may be large or need recovery. Try scoping your question to a specific engram, or open **Recovery** in Settings.';
  }
  if (/timed out|timeout/i.test(msg)) {
    return `That took too long (${msg.slice(0, 120)}). Try a narrower question or name the engram you mean.`;
  }
  return msg;
}

export async function llmCompleteBounded(
  llm: LocalLlm,
  input: {
    system: string;
    user: string;
    jsonSchema?: unknown;
    temperature?: number;
    signal?: AbortSignal;
  },
  timeoutMs = GHAMPUS_LLM_TIMEOUT_MS,
): Promise<string> {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => {
    timeoutCtrl.abort(new Error(`LLM timed out after ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);
  const signal = mergeAbortSignals(input.signal, timeoutCtrl.signal);
  try {
    return await llm.complete({ ...input, ...(signal ? { signal } : {}) });
  } finally {
    clearTimeout(timer);
  }
}

/** Race `fn` against a turn deadline; throws on expiry or prior abort. */
export async function withGhampusTurnBudget<T>(
  fn: () => Promise<T>,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    throw new Error(`Ghampus turn timed out after ${Math.round(GHAMPUS_TURN_TIMEOUT_MS / 1000)}s`);
  }
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('cancelled', 'AbortError');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Ghampus turn timed out after ${Math.round(GHAMPUS_TURN_TIMEOUT_MS / 1000)}s`)),
      remaining,
    );
  });
  const work = fn();
  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
