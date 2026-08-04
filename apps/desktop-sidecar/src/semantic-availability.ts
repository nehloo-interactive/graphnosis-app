//! Is there a real embedder behind the vectors? One explicit, propagating
//! answer, derived from ADAPTER IDENTITY.
//!
//! THE DEFECT THIS EXISTS TO CLOSE
//! ------------------------------
//! `main.ts` boots `embed: stubEmbed` under the id `graphnosis-app:stub@384`
//! and logs "falling back to TF-IDF-only retrieval". That log was FALSE.
//! `stubEmbed` (packages/graphnosis-app-core/src/embeddings) is a sha256 of
//! the text spread over 384 dims — it RETURNS VECTORS. So every "do we have
//! embeddings?" check in the stack answers yes, the whole embedding path
//! executes, and four consumers proceed on noise.
//!
//! Measured on this build, on the real engine:
//!   - the stub vector's norm is ~10.06, and the SDK's embedding seed scorer
//!     (`floatCosine` in core/query/seed-finder.js) is a RAW DOT PRODUCT with
//!     no normalisation — it assumes unit-norm vectors, as every real
//!     embedder emits. So the "cosine" it hands back is unbounded: measured
//!     up to 101.2, against a threshold the tool schema caps at 1.0.
//!   - 48.1% of UNRELATED text pairs score >= 1.0 — the strictest threshold
//!     `check_duplicate` / `audit_memory` permit.
//!   - on the true (normalised) cosine the stub is pure noise: mean 0.0003,
//!     sd 0.176 over 44,850 unrelated pairs. A REAL paraphrase pair scores
//!     0.231 and a pair differing by ONE CHARACTER scores 0.181 — both below
//!     the .gll candidate floor of 0.55, while 16 arbitrary noise pairs sat
//!     inside it.
//!
//! WHY IDENTITY, NOT "DID NUMBERS COME BACK"
//! -----------------------------------------
//! Every runtime probe of the form "is there an embedding index / did the
//! vector have a non-zero length / did the query return hits" answers YES on
//! the stub. Those probes cannot distinguish a model from a hash. The only
//! signal that CAN is who produced the vectors. `handlers-audit.ts` already
//! reasoned this way for its keyword fallback — it never sets
//! `keywordFallback` from a score, only from the absence of an index.
//!
//! WHICH WAY THIS FAILS
//! --------------------
//! - No id at all -> UNAVAILABLE. An absent provenance is not a claim that a
//!   model exists; treating it as one is the same defect one level up.
//! - A recognised placeholder id -> UNAVAILABLE.
//! - Any other well-formed id -> AVAILABLE. We only assert "no semantics"
//!   when we can positively identify a placeholder. Claiming a real adapter
//!   is fake would be its own dishonesty, and would silently disable
//!   retrieval for anyone wiring in a provider this file has not heard of.

/**
 * Embedding adapter ids that are KNOWN not to carry meaning. Enumerated from
 * every construction site in this repo, not assumed to be one string:
 *
 *   main.ts:714, engram-cli.ts:32, recover.ts:32, skill-recover.ts:107,
 *   oplog-report.ts:66, host.ts:1287 (the `opts.embedAdapterId ?? …` default)
 *
 * all name the same adapter today. The token rule below is what keeps a
 * re-dimensioned or renamed stub from slipping past this list.
 */
export const PLACEHOLDER_EMBED_ADAPTER_IDS: readonly string[] = [
  'graphnosis-app:stub@384',
];

/**
 * Model-segment tokens that mark an adapter as a placeholder regardless of
 * vendor or dimension — so `graphnosis-app:stub@1024`, or a future
 * `x:placeholder@N`, is caught without editing the list above.
 *
 * `static` is deliberately ABSENT. `staticEmbedAdapter` (the SDK's
 * `@nehloo/graphnosis/adapters/static`) looks vectors up in a caller-supplied
 * map: the vectors are exactly as meaningful as the caller made them, and
 * `tests/_embed-oracle.mjs` depends on `oracle:static@8` being treated as a
 * real, available space. Calling it a placeholder would break the only
 * harness in the repo that can verify vector MEANING.
 */
const PLACEHOLDER_MODEL_TOKENS: readonly string[] = [
  'stub', 'placeholder', 'noop', 'none', 'null', 'fake', 'mock', 'dummy',
];

/**
 * The model segment of an adapter id. Ids in this codebase are
 * `<vendor>:<model>@<dim>[:<intent>]` — e.g.
 * `graphnosis-app:bge-small-en-v1.5@384:document`, `openai:text-embed-3@1536`,
 * `graphnosis-app:stub@384`. Returns null when the id is not that shape.
 */
function modelSegment(id: string): string | null {
  const colon = id.indexOf(':');
  if (colon < 0) return null;
  const rest = id.slice(colon + 1);
  const at = rest.indexOf('@');
  const model = at < 0 ? rest : rest.slice(0, at);
  return model.length > 0 ? model.toLowerCase() : null;
}

/** True when this adapter id names a stub / placeholder embedder. */
export function isPlaceholderEmbedAdapterId(id: string | null | undefined): boolean {
  if (typeof id !== 'string') return true;      // absence, not a model
  const trimmed = id.trim();
  if (trimmed === '') return true;              // ditto
  if (PLACEHOLDER_EMBED_ADAPTER_IDS.includes(trimmed)) return true;
  const model = modelSegment(trimmed);
  return model !== null && PLACEHOLDER_MODEL_TOKENS.includes(model);
}

/**
 * THE capability state. `false` means: nothing in this process can make a
 * claim about what two texts MEAN. Consumers must say so rather than
 * substituting a number.
 */
export function semanticSimilarityAvailable(embedAdapterId: string | null | undefined): boolean {
  return !isPlaceholderEmbedAdapterId(embedAdapterId);
}

/** One-line explanation for logs and user-facing copy. */
export function semanticUnavailableReason(embedAdapterId: string | null | undefined): string {
  if (typeof embedAdapterId !== 'string' || embedAdapterId.trim() === '') {
    return 'no embedding adapter is recorded, so no vector in this process has known provenance';
  }
  return `the embedding adapter is '${embedAdapterId.trim()}', a placeholder that returns hash-derived vectors carrying no meaning`;
}
