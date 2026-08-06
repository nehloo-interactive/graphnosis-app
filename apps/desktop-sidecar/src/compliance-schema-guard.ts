/**
 * Server-side protection for the IT classification label palette.
 *
 * WHY THIS EXISTS
 * ---------------
 * `compliance.setClassificationSchema` is a whole-document write: whatever
 * `labels` array arrives replaces the stored palette outright. The renderer now
 * refuses to Save until a load has demonstrably succeeded, but that guard lives
 * in the renderer. The sidecar itself had no way to tell these two apart:
 *
 *   - an admin who loaded the palette and deliberately cleared or replaced it;
 *   - a caller that never read the palette and is posting whatever its markup
 *     happened to contain (an empty list, or the built-in green/yellow/red).
 *
 * Both arrive as a well-formed payload that sanitizes clean. `{enabled:true,
 * labels:[]}` was written straight over the organization's palette.
 *
 * WHAT IS CHECKED, AND WHY IT IS NOT A LIST OF BAD SHAPES
 * ------------------------------------------------------
 * The condition is a property of the TRANSITION, not of the payload: does this
 * write remove labels that are stored right now? Empty-labels, defaults-over-
 * custom, and any partial drop nobody has enumerated yet all satisfy it, so the
 * guard does not need to know their shapes.
 *
 * A write that removes stored labels must carry `baseVersion` — the opaque
 * fingerprint the sidecar handed out with the schema. Echoing it back is
 * evidence the caller READ what it is about to destroy. It is deliberately not
 * a `confirm: true` intent flag: a flag is a claim, a fingerprint is proof, and
 * a flag cannot detect the second failure mode below.
 *
 * When `baseVersion` IS supplied it is enforced on every write, destructive or
 * not. That closes the stale-write window: admin A loads, an MDM push or admin
 * B changes the palette, A saves and silently reverts B. A's payload came from
 * a genuinely loaded panel, so no intent flag would ever catch it.
 *
 * WHAT THIS DOES NOT COVER
 * ------------------------
 *   - A caller that reads the schema, takes the version, and then posts
 *     garbage. That is byte-identical to a real admin and no server-side check
 *     can separate them.
 *   - A write with NO `baseVersion` that removes nothing (pure additions, field
 *     edits) still races a concurrent writer last-write-wins. It is allowed on
 *     purpose so the guard does not hard-break callers that destroy nothing;
 *     an up-to-date client always sends `baseVersion` and is fully protected.
 *   - Label CONTENT. Renaming every label in place removes no ids and passes.
 *   - Other writers of `compliance.classificationSchema` do not pass through
 *     this handler. `catalog:importMdmBundle` is the other live one; it shares
 *     `droppedClassificationLabelIds` below but deliberately REPORTS instead of
 *     refusing — see THE MDM EXCEPTION.
 *
 * THE MDM EXCEPTION — WHY THE BUNDLE PATH REPORTS INSTEAD OF REFUSING
 * -------------------------------------------------------------------
 * `baseVersion` is a fingerprint of the RECEIVING machine's stored palette. An
 * MDM bundle is a broadcast file: one JSON, N machines, palettes that have
 * already drifted apart. A single file cannot carry N fingerprints, so
 * requiring one there is not a stricter guard — it is an unsatisfiable one, and
 * every legitimate policy push would fail on any machine that was not already
 * byte-identical to the author's.
 *
 * The direction of authority is also inverted. Here the panel is supposed to
 * MIRROR the server, so a write that diverges from what it loaded is evidence
 * the caller never loaded. With MDM the FILE is authoritative and the machine's
 * palette is the thing being corrected; demanding the authority prove it read
 * the subordinate state gets the relationship backwards. Intent is established
 * out of band — someone authored or exported that bundle and device management
 * placed it — so the failure mode this guard exists for (a caller that does not
 * know its own state) cannot arise there.
 *
 * What was missing on that path was never consent. It was DISCLOSURE: the write
 * landed with no statement of what it had removed.
 */
import { createHash } from 'node:crypto';
import type { ClassificationSchema } from '@graphnosis-app/core';

/** Fingerprint handed out when no schema is stored yet. */
export const NO_CLASSIFICATION_SCHEMA_VERSION = 'v1:none';

/**
 * Stable fingerprint of a stored schema.
 *
 * Canonicalized field by field rather than by hashing the raw settings object:
 * the stored value passes through `sanitizeClassificationSchema`, which drops
 * defaulted keys (`userAssignable`, `enabled`), so hashing the raw JSON would
 * change the version depending on which optional keys the last writer happened
 * to include. Label ORDER is preserved — it is the palette's display order and
 * reordering is a real edit.
 */
export function classificationSchemaVersion(schema: ClassificationSchema | undefined): string {
  if (!schema) return NO_CLASSIFICATION_SCHEMA_VERSION;
  const canonical = JSON.stringify({
    enabled: schema.enabled === true,
    defaultEngramLabel: schema.defaultEngramLabel ?? null,
    labels: schema.labels.map((l) => ({
      id: l.id,
      displayName: l.displayName,
      color: l.color,
      internalTier: l.internalTier,
      userAssignable: l.userAssignable !== false,
      enabled: l.enabled !== false,
      maxTokens: l.capOverrides?.maxTokens ?? null,
      maxNodes: l.capOverrides?.maxNodes ?? null,
    })),
  });
  return `v1:${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

/**
 * Label ids that would stop existing if `nextLabelIds` replaced `current`.
 *
 * The single definition of "what does this write destroy", shared by the
 * refusing caller (`checkClassificationSchemaWrite`, the settings panel) and
 * the reporting caller (`catalog:importMdmBundle`). Two call sites answering
 * that question with two copies of the arithmetic is how they drift.
 */
export function droppedClassificationLabelIds(
  current: ClassificationSchema | undefined,
  nextLabelIds: readonly string[],
): string[] {
  const currentIds = (current?.labels ?? []).map((l) => l.id);
  if (currentIds.length === 0) return [];
  const nextIds = new Set(nextLabelIds.map((id) => id.trim()));
  return currentIds.filter((id) => !nextIds.has(id));
}

/**
 * The only field of a `graphMetadata` entry this module reads, plus the display
 * name a report needs to be readable. Deliberately structural rather than
 * importing `GraphMetadata`: this module must be callable with the raw settings
 * map from the sidecar AND with a hand-built fixture in a test, and widening it
 * to the full type buys nothing here.
 */
export interface ClassificationLabelHolder {
  displayName?: string;
  classificationLabelId?: string;
}

/** One engram's classification-label assignment, as stored in settings. */
export interface ClassificationLabelAssignment {
  graphId: string;
  /** `displayName` when the metadata has one, else the id — never blank. */
  displayName: string;
  labelId: string;
}

/**
 * Every engram that carries a classification label id.
 *
 * READ FROM `settings.graphMetadata`, NOT `host.listGraphs()`. `listGraphs()`
 * returns only the engrams currently loaded into memory, and an UNLOADED engram
 * wearing a label nobody can resolve any more is precisely the one that never
 * surfaces on its own. Enumerating the stored metadata is the only way to see
 * it.
 *
 * This is the single enumeration shared by every caller that needs the
 * question answered — the MDM import report (`catalog:importMdmBundle`) and the
 * on-demand read (`compliance.getClassificationOrphans`). Two call sites
 * walking `graphMetadata` with two copies of the filter is how they drift, and
 * a drift here reads as "nothing wrong".
 */
export function classificationLabelAssignments(
  graphMetadata: Record<string, ClassificationLabelHolder | undefined> | undefined,
): ClassificationLabelAssignment[] {
  return Object.entries(graphMetadata ?? {}).flatMap(([graphId, meta]) => {
    const labelId = meta?.classificationLabelId;
    if (typeof labelId !== 'string' || labelId === '') return [];
    const displayName = typeof meta?.displayName === 'string' && meta.displayName !== ''
      ? meta.displayName
      : graphId;
    return [{ graphId, displayName, labelId }];
  });
}

/**
 * Assignments pointing at a label id that is NOT in `knownLabelIds` — i.e. the
 * engrams whose classification no longer resolves to anything.
 *
 * Note how this differs from `droppedClassificationLabelIds` above, which
 * answers "what does THIS WRITE destroy" and is therefore scoped to one
 * transition. This one answers "what is broken RIGHT NOW", against whatever
 * palette happens to be stored, however it got that way — a settings-panel
 * save, an MDM push, or an import that happened on someone else's Monday.
 * An empty `knownLabelIds` (no palette stored at all) makes every labelled
 * engram dangling, which is the honest answer: there is no palette for those
 * ids to resolve against.
 */
export function danglingClassificationAssignments(
  graphMetadata: Record<string, ClassificationLabelHolder | undefined> | undefined,
  knownLabelIds: readonly string[],
): ClassificationLabelAssignment[] {
  const known = new Set(knownLabelIds);
  return classificationLabelAssignments(graphMetadata).filter((a) => !known.has(a.labelId));
}

export interface ClassificationSchemaWriteRefusal {
  reason: 'stale_schema_version' | 'unconfirmed_destructive_write';
  message: string;
  /** The fingerprint the caller must load and echo to proceed. */
  expectedBaseVersion: string;
  /** Label ids that would stop existing if this write were applied. */
  droppedLabelIds?: string[];
}

/**
 * Decide whether a classification-schema write may proceed.
 *
 * Returns `null` to allow, or a refusal describing exactly what would be lost.
 * Called with the ids the CALLER asked for (post-validation, pre-sanitize) so
 * the decision never depends on `sanitizeClassificationSchema` happening to
 * reject a shape — that rejection is a side effect of a shape check, not a
 * guard, and must not be load-bearing.
 */
export function checkClassificationSchemaWrite(input: {
  current: ClassificationSchema | undefined;
  nextLabelIds: readonly string[];
  baseVersion?: string | undefined;
}): ClassificationSchemaWriteRefusal | null {
  const expectedBaseVersion = classificationSchemaVersion(input.current);

  // Enforced whenever supplied, destructive or not — this is the stale-write
  // check, and a stale write is not necessarily a destructive one.
  if (input.baseVersion !== undefined && input.baseVersion !== expectedBaseVersion) {
    return {
      reason: 'stale_schema_version',
      message:
        'The classification label palette changed since it was loaded. '
        + 'Reload the current palette and reapply the change — saving now would '
        + 'overwrite someone else\'s edit.',
      expectedBaseVersion,
    };
  }

  const droppedLabelIds = droppedClassificationLabelIds(input.current, input.nextLabelIds);
  if (droppedLabelIds.length === 0) return null;

  if (input.baseVersion === undefined) {
    return {
      reason: 'unconfirmed_destructive_write',
      message:
        `This write would remove ${droppedLabelIds.length} existing classification `
        + `label(s) (${droppedLabelIds.join(', ')}). Load the current palette first `
        + 'and send its `baseVersion` to confirm the replacement.',
      expectedBaseVersion,
      droppedLabelIds,
    };
  }

  return null;
}
