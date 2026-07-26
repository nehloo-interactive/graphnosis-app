/**
 * Which op-log events survive compaction, regardless of age.
 *
 * Kept as its own dependency-free module so the rule can be unit-tested
 * without booting a host — and so it is legible. It used to be an inline
 * `ev.op === 'ingestSource' || ev.op === 'forgetSource'` buried in
 * `compactOplogIfNeeded`, which made it easy to miss that a third kind had
 * become load-bearing.
 *
 * THE RETENTION CONTRACT
 * ----------------------
 * Graphnosis recovers content by re-reading its ORIGIN — a file on disk, or
 * the encrypted content blob written during `ingest()`. The op-log records
 * what happened, not what things said: `addNode` carries no content, and
 * `editNode` records the NEW content rather than the old. That is sound for
 * every ordinary source, because the origin is still there to re-read.
 *
 * It breaks for content whose only home is the graph itself. A trained skill
 * is the case in practice: the trainer ingests its metadata seed (→ blob) and
 * then appends every step and goal line via `insertNodeAt`, which never
 * extends the blob. Delete that source and the body exists nowhere — the .gai
 * copy is overwritten by forgetSource's dedup-release tombstone before the
 * soft delete.
 *
 * The one surviving trace is the per-node `deleteNode` event forgetSource
 * emits with `before: { sourceId, preview }`, captured just before that
 * rewrite. So it is a recovery anchor and must outlive compaction.
 */

/**
 * Byte length of the separator `refreshSkillContentBlob` writes between nodes.
 * `'\n\n'` is 2 bytes in UTF-8.
 */
const NODE_SEPARATOR_BYTES = 2;

/**
 * Split a rebuilt content blob back into its exact original nodes.
 *
 * Offsets are BYTE offsets, so the slicing happens on bytes and each segment is
 * decoded individually — splitting a decoded string by character index would
 * corrupt any node containing non-ASCII text (the skills library is
 * multilingual).
 *
 * The inverse of the offset walk in `refreshSkillContentBlob`.
 */
export function splitBlobByNodeOffsets(
  content: Uint8Array,
  offsets: readonly number[],
): string[] {
  const decoder = new TextDecoder();
  const out: string[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]!;
    if (start < 0 || start > content.length) return [];
    // Each segment ends where the next one begins, minus the separator; the
    // last runs to the end of the blob.
    const end = i + 1 < offsets.length
      ? Math.max(start, offsets[i + 1]! - NODE_SEPARATOR_BYTES)
      : content.length;
    if (end > content.length) return [];
    const text = decoder.decode(content.subarray(start, end)).trim();
    if (text) out.push(text);
  }
  return out;
}

/** The minimum shape retention needs. Structural, to avoid an SDK type import. */
export interface RetainableEvent {
  op?: string;
  before?: unknown;
}

/**
 * True when an event must never be pruned by age-based compaction.
 *
 * - `ingestSource` / `forgetSource` — the replay spine: what was ever ingested,
 *   and what was later removed.
 * - `deleteNode` **carrying `before.preview`** — the forgetSource cascade, the
 *   only surviving copy of graph-only node content.
 *
 * Deliberately narrow on that last one. Node-level `forget` also emits
 * `deleteNode`, but with no `before.preview`, because those nodes keep their
 * text in the .gai and need no op-log copy to come back. Retaining every
 * `deleteNode` would pin the bulk of a large log for no recovery benefit.
 */
export function isOplogRecoveryAnchor(ev: RetainableEvent): boolean {
  if (ev.op === 'ingestSource' || ev.op === 'forgetSource') return true;
  if (ev.op !== 'deleteNode') return false;
  const before = ev.before as { preview?: unknown } | undefined;
  return typeof before?.preview === 'string' && before.preview.length > 0;
}
