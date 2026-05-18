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

let _chain: Promise<void> = Promise.resolve();

/**
 * Run `fn` after all previously queued embedding operations have completed.
 * The returned promise resolves / rejects with fn's result.
 *
 * ```ts
 * const sub = await withEmbedding(() => host.recall(query, { budget }));
 * ```
 */
export function withEmbedding<T>(fn: () => Promise<T>): Promise<T> {
  // Attach fn to the end of the chain. The chain advances regardless of
  // whether fn resolves or rejects — errors are NOT swallowed, they're
  // returned to the caller via the result promise.
  const result = _chain.then(() => fn());
  _chain = result.then(
    () => undefined,
    () => undefined, // don't let fn's rejection stall the chain for the next waiter
  );
  return result;
}
