//! Near-duplicate detection over node embeddings via random-hyperplane LSH.
//!
//! The contradiction scan needs every pair of nodes whose cosine similarity
//! sits in a "very similar but not identical" band. A brute O(n²) sweep is
//! fine for a few hundred nodes but explodes on a real cortex (tens of
//! thousands of nodes across many engrams) — so we previously capped at a
//! couple hundred nodes and missed almost everything.
//!
//! Locality-sensitive hashing fixes both problems at once: it's ~O(n) to
//! bucket every node, and only near-identical vectors land in the same
//! bucket, so we exhaustively cover the whole engram while doing a tiny
//! fraction of the comparisons.
//!
//! Recall is probabilistic. With K=12 bits per table and L=12 tables, a
//! pair at cosine 0.85 collides in ≥1 table ~70% of the time; at 0.95+ it's
//! ~98%+. High-similarity pairs — the ones that matter for near-duplicate
//! detection — are caught almost every pass; the rest catch up because the
//! scan re-runs on a schedule with fresh random hyperplanes each time, so
//! cumulative recall climbs toward 100% over a few passes. L is kept
//! modest deliberately: hashing cost is linear in L, and the post-boot CPU
//! budget matters more than the last few points of single-pass recall on a
//! scan that repeats anyway.

import { embeddings } from '@graphnosis-app/core';

const { cosine } = embeddings;

export interface SimilarPair {
  idA: string;
  idB: string;
  similarity: number;
}

// LSH tuning. K = sign bits per table (bucket selectivity); L = number of
// independent tables (collision chances). See the file header for the
// recall math behind these values.
const LSH_K = 12;
const LSH_L = 12;

/** Standard-normal sample (Box–Muller) for random hyperplane normals. */
function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Find pairs of embedded nodes whose cosine similarity is in
 * `[minSim, maxSim)`, using random-hyperplane LSH instead of a brute
 * O(n²) sweep. Exhaustive across every entry in `embs` (no cap).
 *
 * `onYield`, if given, is awaited periodically so a large scan never
 * blocks the event loop / IPC for long.
 */
export async function findSimilarPairs(
  embs: Map<string, number[]>,
  opts: { minSim: number; maxSim: number; onYield?: () => Promise<void> },
): Promise<SimilarPair[]> {
  const ids = [...embs.keys()];
  const rawVecs = [...embs.values()];
  const n = ids.length;
  if (n < 2) return [];
  const dim = rawVecs[0]!.length;
  if (dim === 0) return [];

  // Typed copies — V8 runs the projection dot-products far faster over
  // Float64Array than over boxed number[].
  const vecs: Float64Array[] = rawVecs.map((v) => Float64Array.from(v));

  // K×L random hyperplane normals, one flat Float64Array per hyperplane.
  const planeCount = LSH_K * LSH_L;
  const planes: Float64Array[] = [];
  for (let p = 0; p < planeCount; p++) {
    const hp = new Float64Array(dim);
    for (let d = 0; d < dim; d++) hp[d] = gaussian();
    planes.push(hp);
  }

  // buckets[t]: hashKey → node indices that hashed there in table t.
  const buckets: Array<Map<number, number[]>> = [];
  for (let t = 0; t < LSH_L; t++) buckets.push(new Map());

  // Hash every vector into all L tables.
  for (let i = 0; i < n; i++) {
    const v = vecs[i]!;
    for (let t = 0; t < LSH_L; t++) {
      let key = 0;
      for (let k = 0; k < LSH_K; k++) {
        const hp = planes[t * LSH_K + k]!;
        let dot = 0;
        for (let d = 0; d < dim; d++) dot += v[d]! * hp[d]!;
        key = (key << 1) | (dot >= 0 ? 1 : 0);
      }
      const tb = buckets[t]!;
      const arr = tb.get(key);
      if (arr) arr.push(i);
      else tb.set(key, [i]);
    }
    if ((i & 255) === 0 && opts.onYield) await opts.onYield();
  }

  // Verify within-bucket pairs. A genuinely-similar pair may collide in
  // several tables — we re-verify cheaply rather than holding a giant
  // candidate set, and dedup only the (small) result list.
  const resultSeen = new Set<number>();
  const results: SimilarPair[] = [];
  let work = 0;
  for (let t = 0; t < LSH_L; t++) {
    for (const idxs of buckets[t]!.values()) {
      for (let a = 0; a < idxs.length; a++) {
        for (let b = a + 1; b < idxs.length; b++) {
          let i = idxs[a]!;
          let j = idxs[b]!;
          if (i > j) { const tmp = i; i = j; j = tmp; }
          const sim = cosine(rawVecs[i]!, rawVecs[j]!);
          if (sim >= opts.minSim && sim < opts.maxSim) {
            const key = i * n + j;
            if (!resultSeen.has(key)) {
              resultSeen.add(key);
              results.push({ idA: ids[i]!, idB: ids[j]!, similarity: sim });
            }
          }
          if ((++work & 0xffff) === 0 && opts.onYield) await opts.onYield();
        }
      }
    }
    if (opts.onYield) await opts.onYield();
  }
  return results;
}
