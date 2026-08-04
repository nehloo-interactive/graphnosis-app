//! The DETERMINISTIC half of pair discovery — TF-IDF cosine over the
//! substrate's own live index.
//!
//! WHY THIS IS NOT A RECOMPUTATION
//! -------------------------------
//! `buildUndirectedEdges` in the engine (core/graph/undirected-edges.js)
//! scores every `similar-to` edge as `cosineSimilarity(getTfidfVector(idx,a),
//! getTfidfVector(idx,b))` and writes one when that clears
//! SIMILARITY_THRESHOLD = 0.3. `getTfidfVector` is eight lines — tf * idf,
//! term by term — and this module reads the SAME `documents` / `idf` maps
//! through `adapter.getTfidfIndex`. So a score from here is on the substrate's
//! scale, not merely close to it, and "already has a similar-to edge" and
//! "scored 0.31 here" refer to the same number.
//!
//! WHAT IT IS FOR
//! --------------
//! The `.gll` edge-prediction pass needs candidate pairs that DO NOT already
//! have an edge. The engine's own pass leaves two such populations behind:
//!
//!   (i)  SUB-THRESHOLD — cosine in [0.15, 0.3): related vocabulary, below
//!        the bar for an automatic edge. Never linked, by design.
//!   (ii) BUDGET-STARVED — cosine >= 0.3 but no edge, because
//!        MAX_EDGES_PER_NODE (10) was already spent. Note the engine uses
//!        `break` on node A's budget, not `continue`, so once A is full
//!        EVERY remaining candidate for A is dropped regardless of score —
//!        including ones scoring far higher than the edges A already has.
//!
//! Both are verified to exist on a real corpus before anything relies on
//! them; see the census in the acceptance run.
//!
//! COST
//! ----
//! Candidate generation mirrors the engine's inverted-index discipline —
//! only pairs sharing a term are ever scored, and postings lists longer than
//! MAX_POSTINGS are skipped as too common to be selective. It deliberately
//! does NOT copy MAX_EDGES_PER_NODE: that cap is precisely what creates
//! population (ii), so applying it here would hide the pairs we came for.

/** Live, read-only view of the engine's TF-IDF index. */
export interface TfidfIndexView {
  documents: Map<string, Map<string, number>>;
  idf: Map<string, number>;
}

export interface TfidfPair {
  idA: string;
  idB: string;
  /** TF-IDF cosine on the substrate's scale. Comparable to SIMILARITY_THRESHOLD. */
  similarity: number;
}

/**
 * Terms appearing in more than this many nodes are skipped for candidate
 * generation — same rule and same constant as the engine's own pass
 * (`list.length < 500`). Scoring still uses the full vector; this only
 * bounds which pairs get looked at.
 */
const MAX_POSTINGS = 500;

/** tf * idf for one node, or null when the node is not in the index. */
export function tfidfVector(index: TfidfIndexView, nodeId: string): Map<string, number> | null {
  const tf = index.documents.get(nodeId);
  if (!tf) return null;
  const out = new Map<string, number>();
  for (const [term, tfVal] of tf) {
    const idfVal = index.idf.get(term) ?? 0;
    if (idfVal !== 0) out.set(term, tfVal * idfVal);
  }
  return out;
}

/** Cosine of two sparse TF-IDF vectors. Mirrors core/similarity/cosine.js. */
export function sparseCosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, va] of smaller) {
    const vb = larger.get(term);
    if (vb !== undefined) dot += va * vb;
  }
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * A reusable scorer over one engram's index. Vectors are materialised once
 * and reused, so scoring a pair is a single sparse dot product.
 */
export function makeTfidfScorer(index: TfidfIndexView, nodeIds: Iterable<string>) {
  const vecs = new Map<string, Map<string, number>>();
  for (const id of nodeIds) {
    const v = tfidfVector(index, id);
    if (v && v.size > 0) vecs.set(id, v);
  }
  return {
    /** Node ids that actually have a TF-IDF vector. */
    ids: [...vecs.keys()],
    has(id: string): boolean {
      return vecs.has(id);
    },
    /** TF-IDF cosine, or null when either node is absent from the index. */
    score(a: string, b: string): number | null {
      const va = vecs.get(a);
      const vb = vecs.get(b);
      if (!va || !vb) return null;
      return sparseCosine(va, vb);
    },
    vectors: vecs,
  };
}

export type TfidfScorer = ReturnType<typeof makeTfidfScorer>;

/**
 * Every pair whose TF-IDF cosine is >= `minSim`, discovered via an inverted
 * index so only term-sharing pairs are scored. `onYield` is awaited
 * periodically so a large engram never blocks the event loop.
 *
 * No per-node edge cap: see the file header — the cap is the thing that
 * creates the population this scan exists to find.
 */
export async function findTfidfSimilarPairs(
  scorer: TfidfScorer,
  opts: { minSim: number; maxSim?: number; onYield?: () => Promise<void> },
): Promise<TfidfPair[]> {
  const maxSim = opts.maxSim ?? Infinity;
  const ids = scorer.ids;
  if (ids.length < 2) return [];

  // term -> node indices
  const postings = new Map<string, number[]>();
  for (let i = 0; i < ids.length; i++) {
    const v = scorer.vectors.get(ids[i]!)!;
    for (const term of v.keys()) {
      const list = postings.get(term);
      if (list) list.push(i);
      else postings.set(term, [i]);
    }
  }

  const seen = new Set<string>();
  const out: TfidfPair[] = [];
  let work = 0;
  for (let i = 0; i < ids.length; i++) {
    const v = scorer.vectors.get(ids[i]!)!;
    const candidates = new Set<number>();
    for (const term of v.keys()) {
      const list = postings.get(term);
      if (!list || list.length >= MAX_POSTINGS) continue;
      for (const j of list) if (j > i) candidates.add(j);
    }
    for (const j of candidates) {
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sim = scorer.score(ids[i]!, ids[j]!);
      if (sim === null) continue;
      if (sim >= opts.minSim && sim < maxSim) {
        out.push({ idA: ids[i]!, idB: ids[j]!, similarity: sim });
      }
      if ((++work & 0xffff) === 0 && opts.onYield) await opts.onYield();
    }
    if ((i & 0xff) === 0 && opts.onYield) await opts.onYield();
  }
  return out;
}
