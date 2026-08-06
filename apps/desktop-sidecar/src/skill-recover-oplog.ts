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
 * where `preview` was captured BEFORE the tombstone rewrite.
 *
 * From 1.35.0 that field carries the node's FULL content, so recovery is exact
 * at any length. Events from earlier builds carry `contentPreview`, capped at
 * 497 characters plus an ellipsis — exact below 500, irrecoverably truncated
 * above it. The trailing ellipsis is how the two are told apart at read time.
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
  /**
   * How many came back truncated — i.e. were written by a pre-1.35.0 build that
   * stored `contentPreview` rather than full content, and hit its 497-char cap.
   * Always 0 for anything forgotten by 1.35.0 or later.
   */
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

    // ── Cross-version dedup ────────────────────────────────────────────────
    // `makeSourceId` is deterministic on (kind, ref) — defined in
    // `@graphnosis-app/core` `sources/index.ts`, stated again in
    // `file-watcher.ts` — so a watched file forgotten under a
    // pre-1.35.0 build and again under this one keeps the SAME sourceId, and
    // one trail can hold BOTH shapes for the same node: the old capped
    // `S.slice(0,497)+'…'` and the new full `S`. They are different strings,
    // so exact-match `seen` lets both through and `restoreSkillNodes` inserts
    // the node TWICE — a duplicate that did not exist before full content was
    // stored, because two capped events used to collapse into one.
    //
    // Resolve by PREFIX, not by cap detection. Deliberately independent of
    // `isCapped`: line 87 calls `.trim()`, which strips leading whitespace and
    // so can shorten a capped entry below its exact 498-char shape. A dedup
    // that depended on recognising the cap would then false-negative and let
    // the duplicate through — the failure this guard exists to prevent.
    const stem = preview.endsWith('…') ? preview.slice(0, -1) : preview;
    // Something already kept extends this entry: it adds nothing.
    if (texts.some((t) => t.startsWith(stem))) continue;
    // This entry extends something already kept: supersede it.
    for (let i = texts.length - 1; i >= 0; i--) {
      const prior = texts[i]!;
      if (!prior.endsWith('…')) continue;
      if (preview.startsWith(prior.slice(0, -1))) {
        texts.splice(i, 1);
        if (isCapped(prior)) truncated--;
      }
    }

    seen.add(preview);
    if (isCapped(preview)) truncated++;
    texts.push(preview);
    if (fromGraphId === undefined && ev.graphId !== undefined) fromGraphId = ev.graphId;
  }

  return { texts, truncated, ...(fromGraphId !== undefined ? { fromGraphId } : {}) };
}

/**
 * True when this entry looks like it was written by a pre-1.35.0 build and hit
 * the preview cap — i.e. text is missing.
 *
 * DELIBERATELY LOOSE, and it stays loose. A real capped preview is exactly 498
 * characters (`graphnosis-impl.ts:954` is `slice(0, 497) + '…'`, and U+2026 is
 * a single UTF-16 unit), so an exact length test looks more precise. It is the
 * wrong trade, because the two errors are not symmetric:
 *
 *   - False POSITIVE — content that legitimately ends in '…' gets counted.
 *     The user sees one spurious line in a warning. Cosmetic.
 *   - False NEGATIVE — a genuinely capped entry goes uncounted, and
 *     `skill-recover.ts` then prints "every node came back whole" over real,
 *     unrecoverable loss. That is the failure class this whole change exists
 *     to remove: a success signal and a silent-loss signal sharing one value.
 *
 * An exact-498 test false-negatives for real: line 87 calls `.trim()`, which
 * strips leading whitespace and shortens the string below 498. So the loose
 * test is the safe one. Dedup does NOT rely on this function — it works on
 * prefixes above, precisely so correctness never depends on cap detection.
 */
function isCapped(text: string): boolean {
  return text.endsWith('…');
}
