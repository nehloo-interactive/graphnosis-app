/**
 * Global serialization for CPU-heavy embedding operations.
 *
 * fastembed / ONNX Runtime (the local embedding model used by the Graphnosis
 * SDK) is NOT safe for concurrent invocations. Two simultaneous embedding
 * calls race on a shared C++ mutex and terminate the process with:
 *
 *   libc++abi: mutex lock failed: Invalid argument
 *
 * This module exposes a single `withEmbedding()` wrapper that forces all
 * embedding-heavy SDK calls — `host.ingest()`, `host.recall()`,
 * `host.searchNodes()`, `ingestClip()` — to run ONE AT A TIME via a
 * Promise chain. Callers await the wrapper, not the raw SDK call.
 *
 * Performance note: the typical steady-state is a single active embedding
 * task (ingest or recall). Queuing adds no overhead unless two operations
 * genuinely overlap (e.g., a multi-minute PDF ingest + a recall fired
 * before it finishes). In that case the recall blocks until the ingest
 * finishes — which is the correct behaviour.
 */

import { dbg } from './log-redact.js';

let _chain: Promise<void> = Promise.resolve();

/** A single QUEUED op (e.g. one ingestClip) can legitimately run for MINUTES — a
 *  full book or a huge CHANGELOG is thousands of chunk-embeds in one op. So we do
 *  NOT abort at this level (that would falsely kill a large-but-healthy ingest).
 *  We only WARN, for diagnostics. Real wedge detection lives PER-EMBED in
 *  local-embed.ts: one CHUNK embed taking >30s is the true "wedged worker" signal
 *  (a healthy chunk is sub-second), and that's where we kill+respawn the worker. */
const EMBED_STALL_WARN_MS = 30_000;

export type WithEmbeddingOpts = {
  /** Reject if still queued behind a prior op longer than this (ms). */
  queueTimeoutMs?: number;
  /** Reject if queue wait + fn exceeds this (ms). Does not kill an in-flight ONNX call. */
  timeoutMs?: number;
  /** Abort while queued — fn is skipped if already aborted when the chain reaches it. */
  signal?: AbortSignal;
};

function rejectIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('aborted', 'AbortError');
  }
}

/**
 * Run `fn` after all previously queued embedding operations have completed.
 * The returned promise resolves / rejects with fn's result.
 *
 * ```ts
 * const sub = await withEmbedding(() => host.recall(query, { budget }));
 * ```
 */
export function withEmbedding<T>(
  fn: () => Promise<T>,
  label?: string,
  opts?: WithEmbeddingOpts,
): Promise<T> {
  rejectIfAborted(opts?.signal);
  const queuedAt = Date.now();

  const result = _chain.then(async () => {
    rejectIfAborted(opts?.signal);
    const waitMs = Date.now() - queuedAt;
    if (opts?.queueTimeoutMs != null && waitMs > opts.queueTimeoutMs) {
      throw new Error(
        `Memory search waited ${Math.round(waitMs / 1000)}s for the embedding pipeline ` +
        `(another ingest may be running). Try again in a moment.`,
      );
    }
    // Diagnostic warn only — a single queued op (one ingestClip) may legitimately
    // run for minutes (a whole book). The actual wedge recovery is per-embed in
    // local-embed.ts, which kills+respawns the worker for a single hung CHUNK
    // without aborting a large-but-healthy ingest.
    const warn = setTimeout(() => {
      dbg(
        `[embed] ${label ?? 'operation'} still running after ${Math.round(EMBED_STALL_WARN_MS / 1000)}s — ` +
        `a large file (book/changelog) can legitimately take minutes; per-chunk wedge recovery is in local-embed.`,
      );
    }, EMBED_STALL_WARN_MS);
    try {
      const opStarted = Date.now();
      const run = () => Promise.resolve(fn());
      if (opts?.timeoutMs != null) {
        const budget = opts.timeoutMs - waitMs;
        if (budget <= 0) {
          throw new Error(`${label ?? 'Embedding operation'} timed out before starting`);
        }
        return await Promise.race([
          run(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error(
                `${label ?? 'Embedding operation'} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`,
              )),
              budget,
            );
          }),
        ]);
      }
      void opStarted; // reserved for future queue-wait metrics
      return await run();
    } finally {
      clearTimeout(warn);
    }
  });

  if (opts?.signal) {
    opts.signal.addEventListener('abort', () => {
      void result.catch(() => {}); // ensure rejection is observed if aborted while queued
    }, { once: true });
  }

  _chain = result.then(
    () => undefined,
    () => undefined, // don't let fn's rejection stall the chain for the next waiter
  );
  return result;
}
