/**
 * Op-log reconstruction of a skill destroyed by a transfer.
 *
 * Kept as its own dependency-free module (no host, no adapter, no embeddings)
 * so it can be unit-tested without booting a cortex — importing the CLI spawns
 * the embed worker pool and never exits.
 *
 * WHY THE OP-LOG IS THE ONLY SOURCE
 * ---------------------------------
 * `host.moveSource` re-ingests a source in the destination from its cached
 * content blob. For a trained skill that blob holds only the seed chunk — the
 * `<!-- Graphnosis skill training metadata -->` comment — because the trainer
 * ingests the seed and then appends every body/goal node individually via
 * `insertNodeAt`. So a transfer replaces the whole procedure with its own
 * training header.
 *
 * Everything else that might hold the original text is a dead end, all three
 * confirmed by reading `host.forgetSource`:
 *
 *   1. Soft-deleted nodes do NOT retain their text. Before soft-deleting,
 *      forgetSource OVERWRITES each node's content with a tombstone
 *      (`__gn-forgotten:<stamp>:<i>:<nodeId>__`) to release its hash from the
 *      SDK's dedup table. The original is gone from the `.gai`.
 *   2. That rewrite calls `adapter.applyCorrection` DIRECTLY, bypassing the
 *      host-level emit that would have recorded the pre-edit content.
 *   3. `addNode` events carry no content — only `sourceId` / `ref` / `role`.
 *
 * What survives is one event per node:
 *   `op: 'deleteNode', before: { sourceId, preview }`
 * where `preview` was captured BEFORE the tombstone rewrite. That is
 * `contentPreview`, capped at 500 characters by the adapter — so recovery is
 * exact for anything shorter and truncated beyond it.
 */

/** The tombstone forgetSource writes over a node's content before deleting it. */
const TOMBSTONE_RE = /^__gn-forgotten:/;

/** Minimal shape this module needs from an op-log event. */
export interface ForgetTrailEvent {
  op?: string;
  graphId?: string;
  target?: { kind?: string; id?: string };
  before?: unknown;
}

export interface OplogRecovery {
  /** Recovered node texts, in source order. */
  texts: string[];
  /** How many of them hit the 500-char preview cap and came back truncated. */
  truncated: number;
  /** The engram the forget trail was found in — i.e. where the skill came from. */
  fromGraphId?: string;
}

/**
 * Rebuild a skill's nodes from the op-log's forget trail.
 *
 * Op-log order is emission order, which for a forget is the source's own node
 * order, so the reconstruction preserves step sequence.
 *
 * Reads `before`, NOT `after`: the first version of this looked for
 * `after.contentPreview`, a field the forget path never writes, and therefore
 * recovered nothing at all.
 */
export function recoverFromForgetTrail(
  events: readonly ForgetTrailEvent[],
  sourceId: string,
  alreadyPresent: ReadonlySet<string> = new Set(),
): OplogRecovery {
  const seen = new Set<string>(alreadyPresent);
  const texts: string[] = [];
  let truncated = 0;
  let fromGraphId: string | undefined;

  for (const ev of events) {
    if (ev.op !== 'deleteNode') continue;
    if (ev.target?.kind !== 'node') continue;
    const before = (ev.before ?? {}) as Record<string, unknown>;
    if (before.sourceId !== sourceId) continue;
    const preview = typeof before.preview === 'string' ? before.preview.trim() : '';
    if (!preview || seen.has(preview)) continue;
    // Defensive: never resurrect a tombstone as if it were user content.
    if (TOMBSTONE_RE.test(preview)) continue;
    seen.add(preview);
    // The adapter caps contentPreview at 500 chars and marks the cut with '…'.
    if (preview.endsWith('…')) truncated++;
    texts.push(preview);
    if (fromGraphId === undefined && ev.graphId !== undefined) fromGraphId = ev.graphId;
  }

  return { texts, truncated, ...(fromGraphId !== undefined ? { fromGraphId } : {}) };
}
