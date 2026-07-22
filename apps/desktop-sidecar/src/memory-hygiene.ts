/**
 * Pure guards for memory-hygiene surfaces (check_duplicate / audit_memory and
 * the ingest-path contradiction report). Extracted as plain functions so
 * node --test can exercise them without a host (tests/memory-hygiene.test.mjs).
 *
 * Motivating incident (2026-07-21): check_duplicate reported score 1.00 on
 * two label-sized nodes ("Graphnosis", "1.3 What Graphnosis Is") for a probe
 * that never contained the word — recall-tuned retrieval (synonym expansion +
 * TF-IDF vocab intersection) manufactured the overlap, and the same write
 * echoed 8 raw "contradictions" justified only by the engram's ubiquitous
 * brand entity. Duplicate checking needs direct text-vs-text similarity plus
 * the degeneracy guard below; the ingest contradiction report is routed
 * through the SAME triage the brain engine's scan already uses
 * (contradiction-utils.evaluateContradictionTriage), fed by the common-entity
 * predicate built here.
 */

/** A candidate node this much shorter than the probe can never be a
 *  duplicate the caller could `edit` the probe into. Absolute floor. */
const MIN_DUP_CANDIDATE_CHARS = 24;
/** Candidate must cover at least this fraction of the probe's length
 *  (probe length capped so very long notes don't disqualify everything). */
const MIN_DUP_LENGTH_RATIO = 0.2;
const DUP_PROBE_LENGTH_CAP = 600;

/**
 * True when `nodeText` is too degenerate (label/heading-sized) to count as a
 * duplicate of `probeText`, regardless of its similarity score. A 10-char
 * label cosines high against anything once a query vector collapses onto its
 * single term — commensurate length is a precondition for "duplicate".
 */
export function isDegenerateDuplicateCandidate(probeText: string, nodeText: string): boolean {
  const probeLen = probeText.trim().length;
  const nodeLen = nodeText.trim().length;
  if (nodeLen < MIN_DUP_CANDIDATE_CHARS) return true;
  return nodeLen < MIN_DUP_LENGTH_RATIO * Math.min(probeLen, DUP_PROBE_LENGTH_CAP);
}

/**
 * Entity → number of nodes containing it (each node counts once,
 * case-insensitive). Input shape matches adapter.inspectNodes output.
 */
export function buildEntityDocumentFrequency(
  nodes: Array<{ entities?: string[] }>,
): Map<string, number> {
  const df = new Map<string, number>();
  for (const node of nodes) {
    if (!node.entities || node.entities.length === 0) continue;
    const seen = new Set<string>();
    for (const e of node.entities) {
      const key = e.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      df.set(key, (df.get(key) ?? 0) + 1);
    }
  }
  return df;
}

// Same constants as BrainEngine.getCommonEntityPredicate (#4b) — ONE
// semantics for "this entity is corpus-common" across the scan path and the
// ingest path. An entity in more than COMMON_RATIO of nodes is not a
// meaningful contradiction anchor; below MIN_NODES the corpus is too small
// to learn stopwords and the predicate no-ops.
const COMMON_ENTITY_MIN_NODES = 40;
const COMMON_ENTITY_RATIO = 0.12;

/**
 * Corpus-derived common-entity predicate for
 * contradiction-utils.evaluateContradictionTriage — the stateless twin of
 * BrainEngine.getCommonEntityPredicate (which adds a per-engram TTL cache).
 */
export function buildCommonEntityPredicate(
  nodes: Array<{ entities?: string[] }>,
): (entity: string) => boolean {
  if (nodes.length < COMMON_ENTITY_MIN_NODES) return () => false;
  const df = buildEntityDocumentFrequency(nodes);
  const threshold = nodes.length * COMMON_ENTITY_RATIO;
  return (entity: string) => (df.get(entity.toLowerCase()) ?? 0) > threshold;
}
