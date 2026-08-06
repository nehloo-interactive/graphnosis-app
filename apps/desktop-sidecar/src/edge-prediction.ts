//! Local-LLM edge prediction — Batch 3 of the GLL overlay arc.
//!
//! Periodically asks the local LLM: "are these two memories meaningfully
//! related?" Writes confirmed relationships into the `.gll` overlay as
//! `GllPredictedEdge` entries — never into the canonical `.gai` engram.
//! The user reviews predictions in the Foresight tab and can
//! Accept (promote to `.gai` via a correction add) or Reject (delete from
//! overlay).
//!
//! Why this exists alongside `.gnn` (the neural-network overlay): the GNN
//! predicts edges from graph structure alone (it doesn't read content).
//! The LLM predicts from CONTENT — it reads both nodes and judges whether
//! there's a semantic relationship worth capturing, and what KIND of
//! relationship (the GNN can only say "these should be connected").
//!
//! CANDIDATE SELECTION — TWO SIGNALS, BOTH ALWAYS CONSULTED
//! ========================================================
//! This pass decides WHICH PAIRS THE LOCAL LLM IS EVER ASKED ABOUT. Anything
//! the selector does not surface is not "ranked low" — it is invisible, and
//! no amount of LLM quality recovers it. So the selector gets two independent
//! rankings, and their DISAGREEMENT is carried into the prompt as evidence
//! rather than used as a filter.
//!
//!   DETERMINISTIC (TF-IDF cosine, `tfidf-pairs.ts`) — always available,
//!   read off the substrate's OWN live index, so its numbers are on the same
//!   scale as the engine's SIMILARITY_THRESHOLD (0.3).
//!
//!   EMBEDDING (LSH over node vectors) — consulted ONLY when
//!   `host.semanticSimilarityAvailable()`. On a placeholder adapter the
//!   vectors are a sha256 of the text; measured on this build the true
//!   cosine between unrelated notes is mean 0.0003 / sd 0.176, a REAL
//!   paraphrase pair scores 0.231 and a pair differing by ONE CHARACTER
//!   scores 0.181 — both far below SIM_MIN — while 16 arbitrary noise pairs
//!   out of 44,850 landed inside [SIM_MIN, SIM_MAX). That is the exact
//!   failure this guard removes: the LLM was asked about noise and never
//!   shown the real near-duplicates.
//!
//! WHY NOT JUST "TF-IDF >= 0.3"
//! ----------------------------
//! Because the engine ALREADY writes a `similar-to` edge at TF-IDF cosine
//! >= 0.3 (core/graph/undirected-edges.js), and this pass predicts MISSING
//! edges. Gating there would mostly surface pairs that already have one. The
//! two populations that are genuinely unlinked are:
//!
//!   (i)  SUB-THRESHOLD, cosine in [TFIDF_MIN, 0.3) — related vocabulary,
//!        below the bar for an automatic edge.
//!   (ii) BUDGET-STARVED, cosine >= 0.3 with no edge, because
//!        MAX_EDGES_PER_NODE (10) was spent. The engine uses `break` on node
//!        A's budget, so once A is full every remaining candidate for A is
//!        dropped regardless of score.
//!
//! Both were confirmed to exist on a real corpus before this code relied on
//! them. Filtering by "has no edge yet" catches both without special-casing.
//!
//! RANKING: INTERLEAVE, NOT A WEIGHTED SUM
//! ---------------------------------------
//! Top N/2 from each ranking, alternating. There is no defensible constant
//! for a weighted sum of a lexical score and a vector score, and any single
//! ranking silently starves one of the two interesting cases. Interleaving
//! guarantees both the paraphrase case (high embedding, low TF-IDF) and the
//! lexical case (high TF-IDF, low embedding) reach the LLM.
//!
//! DISAGREEMENT MUST NOT BECOME A VETO
//! -----------------------------------
//! No candidate is ever suppressed because the two signals disagree.
//! Disagreement is the interesting case:
//!   high TF-IDF + low embedding -> same vocabulary, possibly different meaning
//!   low TF-IDF + high embedding -> paraphrase, different words
//! Both numbers and their gap go into the prompt so the deterministic layer
//! is EVIDENCE, not a gate.
//!
//! Then: drop pairs that already have a `.gai` edge; drop pairs already in
//! `.gll`; take MAX_CANDIDATES.
//!
//! Per pair, the LLM gets a short prompt with both nodes' text and returns
//! JSON `{ related: bool, relationship: string, confidence: number }`.
//! Pairs with `related: false` or confidence < CONFIDENCE_FLOOR are
//! discarded. Survivors become `GllPredictedEdge`s saved to disk.
//!
//! NOTHING HERE WRITES TO THE `.gai`. Predictions land in the `.gll` overlay
//! and only a human Accept promotes one. The TF-IDF index is borrowed
//! read-only.
//!
//! Cost shape:
//!   - One LSH similarity scan (when semantics are available) + one
//!     inverted-index TF-IDF scan per engram per loop.
//!   - One LLM call per surviving candidate — still capped at
//!     MAX_CANDIDATES, so the COST is unchanged; only the COMPOSITION of
//!     what gets asked changes.

import { findSimilarPairs } from './duplicate-scan.js';
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import { makeGllPredictedEdge, type GllPredictedEdge } from './gll-overlay.js';
import { makeTfidfScorer, findTfidfSimilarPairs } from './tfidf-pairs.js';
import { settings as settingsMod } from '@graphnosis-app/core';

/** Cosine similarity floor — below this, we don't even ask the LLM. Tuned
 *  so the candidate pool is genuinely "plausibly related" content, not
 *  noise pairs. */
const SIM_MIN = 0.55;
/** Cosine similarity ceiling — above this, the deterministic duplicate
 *  scan handles it (merge proposal), so we skip to avoid duplicate work. */
const SIM_MAX = 0.92;
/**
 * TF-IDF cosine floor for the deterministic ranking. Deliberately BELOW the
 * engine's SIMILARITY_THRESHOLD of 0.3 — the band [0.15, 0.3) is population
 * (i) above, pairs the substrate looked at and declined to link. There is no
 * ceiling: a pair at 0.6 with no edge is population (ii) and is exactly what
 * we want to surface.
 */
const TFIDF_MIN = 0.15;
/** Max candidate pairs per engram per loop. Keeps LLM cost predictable. */
const MAX_CANDIDATES = 8;
/** Drop predictions the LLM gave less than this confidence (0–1). */
const CONFIDENCE_FLOOR = 0.55;
/** Hard timeout per LLM call. The LLM judgment is single-shot JSON. */
const LLM_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = `You judge whether two memory excerpts from the same person's knowledge graph have a meaningful semantic relationship worth connecting.

You will be given two short text excerpts (A and B), plus the similarity signals a deterministic layer already computed for them. Output ONLY a single JSON object:
  { "related": true|false, "relationship": "<1-3 word label>", "confidence": <0..1> }

Rules:
- "related" is true only when A and B refer to the same person/place/project, elaborate one another, or one logically implies / contradicts / follows the other.
- "related" is false for: tangentially-similar topics, vague thematic overlap, or near-duplicates (those are handled elsewhere).
- "relationship" is a short label like "elaborates", "contradicts", "same-project", "precedes", "mentions". Lowercase, no punctuation.
- "confidence" 0..1 — how sure you are.
- The signals are EVIDENCE, not a verdict. Read the text yourself and judge it.
- When the two signals DISAGREE, that is informative, not disqualifying: high keyword overlap with low meaning overlap suggests shared vocabulary about different things, and low keyword overlap with high meaning overlap suggests a paraphrase. Neither is a reason to answer false by itself.
- When a signal is reported as unavailable, treat it as absent — not as zero, and not as evidence of dissimilarity.
- Output JSON only. No preamble, no explanation, no markdown fences.`;

/** Run one prediction pass for one engram. Returns the new edges (already
 *  appended to the overlay on disk). Idempotent within a loop — calling
 *  twice in a row will find no new pairs because anything already in .gll
 *  is filtered out. */
export async function predictEdgesForEngram(
  host: GraphnosisHost,
  llm: LocalLlm,
  graphId: string,
): Promise<{ candidatesScanned: number; predicted: GllPredictedEdge[]; mix: CandidateMix }> {
  const semanticAvailable = host.semanticSimilarityAvailable();

  // 1. Pull embeddings + the TF-IDF index + existing edges + the current .gll.
  //    The embedding map is loaded either way — it is still the thing the LSH
  //    scan reads — but it is only CONSULTED when the adapter behind it can
  //    make a meaning claim.
  //    Eligibility is applied to BOTH rankings, not just the lexical one: a
  //    pair of `section` nodes is no more linkable because an embedding
  //    ranked it than because TF-IDF did.
  const eligible = new Set(eligibleNodeIds(host, graphId));
  const embs = new Map<string, number[]>();
  if (semanticAvailable) {
    for (const [id, vec] of host.getNodeEmbeddings(graphId)) {
      if (eligible.has(id)) embs.set(id, vec);
    }
  }
  const tfidfIndex = host.getTfidfIndex(graphId);
  const tfidf = tfidfIndex ? makeTfidfScorer(tfidfIndex, eligible) : null;

  // Nothing to work with at all: no usable vectors AND no usable lexical
  // index. Say nothing rather than inventing a pool.
  if (embs.size < 2 && (tfidf === null || tfidf.ids.length < 2)) {
    return { candidatesScanned: 0, predicted: [], mix: emptyMix(semanticAvailable) };
  }

  const edges = host.listEdges(graphId);
  const existingEdgeKeys = new Set<string>();
  for (const e of edges.directed) {
    existingEdgeKeys.add(edgeKey(e.from, e.to));
    existingEdgeKeys.add(edgeKey(e.to, e.from)); // suppress predicting the inverse
  }
  for (const e of edges.undirected) {
    existingEdgeKeys.add(edgeKey(e.a, e.b));
    existingEdgeKeys.add(edgeKey(e.b, e.a));
  }
  const overlay = await host.loadGllOverlay();
  for (const e of overlay.edges) {
    if (e.graphId === graphId) {
      existingEdgeKeys.add(edgeKey(e.from, e.to));
      existingEdgeKeys.add(edgeKey(e.to, e.from));
    }
  }

  const yieldToLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

  // 2a. EMBEDDING ranking — the LSH scan (same helper duplicate-scan uses),
  //     restricted to this engram because getNodeEmbeddings is per-engram.
  //     Skipped entirely when no real embedder is behind the vectors.
  const embPairs = embs.size >= 2
    ? await findSimilarPairs(embs, { minSim: SIM_MIN, maxSim: SIM_MAX, onYield: yieldToLoop })
    : [];

  // 2b. DETERMINISTIC ranking — TF-IDF cosine on the substrate's own scale.
  const tfidfPairs = tfidf && tfidf.ids.length >= 2
    ? await findTfidfSimilarPairs(tfidf, { minSim: TFIDF_MIN, onYield: yieldToLoop })
    : [];

  // 3. Drop pairs that already have an edge (in .gai or .gll), then rank each
  //    signal independently. This single filter is what isolates BOTH unlinked
  //    populations described in the file header.
  const unlinked = <T extends { idA: string; idB: string }>(list: T[]): T[] =>
    list.filter((p) => !existingEdgeKeys.has(edgeKey(p.idA, p.idB)));

  const embRanked = unlinked(embPairs).sort((a, b) => b.similarity - a.similarity);
  const tfidfRanked = unlinked(tfidfPairs).sort((a, b) => b.similarity - a.similarity);

  // 4. Interleave. Every candidate carries BOTH scores wherever both can be
  //    computed — a pair surfaced by one ranking is still scored by the other,
  //    so the prompt always shows the full picture (including a low score from
  //    the ranking that did NOT surface it, which is the informative case).
  const candidates = interleaveCandidates(embRanked, tfidfRanked, tfidf, embs, MAX_CANDIDATES);
  const mix = summarizeMix(candidates, semanticAvailable, embRanked.length, tfidfRanked.length);

  if (candidates.length === 0) {
    return { candidatesScanned: 0, predicted: [], mix };
  }

  // 4. For each candidate, fetch the actual text and ask the LLM.
  const allNodes = host.listNodes(graphId);
  const nodeText = new Map<string, string>();
  for (const n of allNodes) nodeText.set(n.id, n.contentPreview);

  const newEdges: GllPredictedEdge[] = [];
  for (const cand of candidates) {
    const textA = nodeText.get(cand.idA);
    const textB = nodeText.get(cand.idB);
    if (!textA || !textB) continue;
    let judgment: { related: boolean; relationship: string; confidence: number } | null = null;
    try {
      const raw = await Promise.race([
        llm.complete({
          system: SYSTEM_PROMPT,
          user: `A: ${textA.slice(0, 600)}\n\nB: ${textB.slice(0, 600)}\n\n${describeSignals(cand)}`,
        }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`edge-prediction LLM call exceeded ${LLM_TIMEOUT_MS}ms`)), LLM_TIMEOUT_MS),
        ),
      ]);
      judgment = parseJudgment(raw);
    } catch (e) {
      console.error(`[edge-prediction] LLM call failed for ${cand.idA}/${cand.idB}: ${(e as Error).message}`);
      continue;
    }
    if (!judgment || !judgment.related || judgment.confidence < CONFIDENCE_FLOOR) continue;
    newEdges.push(makeGllPredictedEdge({
      graphId,
      from: cand.idA,
      to: cand.idB,
      relationship: judgment.relationship,
      score: judgment.confidence,
      createdAt: Date.now(),
    }));
  }

  if (newEdges.length === 0) {
    return { candidatesScanned: candidates.length, predicted: [], mix };
  }

  // 5. Append + persist. Read-modify-write: load current overlay, append the
  //    new edges, save back. Concurrent prediction passes across engrams are
  //    serialized by the scheduler loop, so we don't need a per-overlay lock.
  const current = await host.loadGllOverlay();
  await host.saveGllOverlay([...current.edges, ...newEdges], current.assertions);
  return { candidatesScanned: candidates.length, predicted: newEdges, mix };
}

/**
 * Map the LLM's free-text relationship label onto the SDK's structural
 * DirectedEdgeType enum. The LLM may say "elaborates", "same-project",
 * "leads-to", etc. — none of those are SDK enum values. We pick the closest
 * structural match; the LLM's original label is preserved as `evidence`
 * (the SDK + UI render that string in preference to the structural type).
 *
 * Default for anything unrecognised is "supports" — the most neutral
 * "these two are related and one bolsters the other" semantic. Avoids
 * misclassifying as something stronger (contradicts, causes).
 */
function mapRelationshipToEdgeType(label: string): 'supports' | 'contradicts' | 'precedes' | 'cites' | 'depends-on' | 'defines' | 'contains' | 'summarizes' | 'causes' | 'discussed-in' {
  const l = label.toLowerCase().trim();
  if (/contradict|conflicts|disagrees|refutes/.test(l)) return 'contradicts';
  if (/precede|before|follow|after|then|next|earlier|later/.test(l)) return 'precedes';
  if (/cite|reference|mention/.test(l)) return 'cites';
  if (/depend|require|need/.test(l)) return 'depends-on';
  if (/define|formaliz|specif/.test(l)) return 'defines';
  if (/contain|include|part-of|component/.test(l)) return 'contains';
  if (/summari|abstract|tldr/.test(l)) return 'summarizes';
  if (/cause|lead|trigger|result/.test(l)) return 'causes';
  if (/same-?(project|topic|theme|engram|context)|about|discusses/.test(l)) return 'discussed-in';
  // 'elaborates', 'extends', 'explains', and most unclassified relationships
  // fall back to 'supports'.
  return 'supports';
}

/** Promote a predicted edge to the canonical `.gai` engram as a directed
 *  edge with the LLM's relationship label preserved as evidence. Removes
 *  the entry from `.gll` only AFTER the promotion succeeds — if the SDK
 *  call fails, the prediction stays in the review queue so the user can
 *  retry or reject. */
export async function acceptPredictedEdge(
  host: GraphnosisHost,
  edgeId: string,
): Promise<{ ok: boolean; reason?: string; edgeType?: string }> {
  const overlay = await host.loadGllOverlay();
  const edge = overlay.edges.find((e) => e.id === edgeId);
  if (!edge) return { ok: false, reason: 'predicted edge not found' };
  const edgeType = mapRelationshipToEdgeType(edge.relationship);
  try {
    await host.linkNodesDirected(edge.graphId, edge.from, edge.to, {
      type: edgeType,
      weight: edge.score,
      // Preserve the LLM's original label — the UI shows this in preference
      // to the structural type so the user sees "elaborates" / "same-project"
      // rather than the structural fallback "supports".
      evidence: edge.relationship,
    });
  } catch (e) {
    console.error(`[edge-prediction] promote ${edgeId} failed: ${(e as Error).message}`);
    return { ok: false, reason: `could not create edge: ${(e as Error).message}` };
  }
  // Promotion succeeded — drop the prediction from the overlay.
  const remaining = overlay.edges.filter((e) => e.id !== edgeId);
  await host.saveGllOverlay(remaining, overlay.assertions);
  console.error(`[edge-prediction] accepted ${edgeId}: ${edge.from} —[${edgeType}: "${edge.relationship}"]→ ${edge.to}`);
  return { ok: true, edgeType };
}

/** Permanently remove a predicted edge from the `.gll` overlay. */
export async function rejectPredictedEdge(
  host: GraphnosisHost,
  edgeId: string,
): Promise<{ ok: boolean }> {
  const overlay = await host.loadGllOverlay();
  const remaining = overlay.edges.filter((e) => e.id !== edgeId);
  await host.saveGllOverlay(remaining, overlay.assertions);
  return { ok: true };
}

/** True when the current settings allow the autonomous edge-prediction loop
 *  to run. Wraps the master + capability + the master-toggle short-circuit
 *  baked into resolveLlmCapabilities. */
export function edgePredictionEnabled(host: GraphnosisHost): boolean {
  return settingsMod.resolveLlmCapabilities(host.getSettings()).edgePrediction;
}

// ── Candidate model ──────────────────────────────────────────────────────────

/**
 * Nodes eligible to be one end of a predicted edge.
 *
 * MEASURED, NOT ASSUMED. A census over a 114-node corpus found the raw
 * TF-IDF ranking dominated by junk: 38 `section` nodes sat at the TOP of the
 * deterministic ranking at cosine 1.000 with degree 0, because
 *
 *   - `buildIndexFromGraph` INCLUDES `section` nodes in the TF-IDF index
 *     deliberately ("short high-signal headings are exactly what people
 *     search for"), but
 *   - `buildUndirectedEdges` EXCLUDES them from edge building
 *     (`c.type !== 'document' && c.type !== 'section'`).
 *
 * So every pair of sections carrying the same filename looked like a
 * high-scoring pair that the substrate had "failed" to link, when in truth
 * the substrate is never allowed to link them. Feeding those to the LLM
 * would have burned the whole MAX_CANDIDATES budget on matching filenames.
 *
 * This mirrors the substrate's own rule, plus the activity filter the rest
 * of the pipeline uses (soft-deleted and expired nodes are not candidates).
 */
export function isEligibleCandidateNode(
  n: { nodeType?: string; confidence: number; validUntil?: number },
  now = Date.now(),
): boolean {
  // Structural, by TYPE. On the corpora measured so far the engine also hands
  // document/section nodes confidence 0.1, so the activity rule below would
  // exclude them anyway — but that is a coincidence of two independent
  // policies, not a guarantee. Confidence is decayable and user-mutable;
  // node type is structural. The type rule is the one that states the actual
  // reason, so it stays and is tested on its own.
  if (n.nodeType === 'document' || n.nodeType === 'section') return false;
  // Soft-deleted or expired: not a candidate for anything.
  if (n.confidence <= 0.2) return false;
  if (n.validUntil !== undefined && n.validUntil <= now) return false;
  return true;
}

function eligibleNodeIds(host: GraphnosisHost, graphId: string): string[] {
  const now = Date.now();
  return host.listNodes(graphId)
    .filter((n) => isEligibleCandidateNode(n, now))
    .map((n) => n.id);
}

/** A pair the LLM will be asked about, with everything both signals know. */
export interface EdgeCandidate {
  idA: string;
  idB: string;
  /** TF-IDF cosine on the substrate's scale, or null when unavailable. */
  tfidfCosine: number | null;
  /** Embedding cosine, or null when no real embedder is behind the vectors. */
  embeddingCosine: number | null;
  /** Which ranking put it in the pool. Diagnostic only — never a filter. */
  surfacedBy: 'embedding' | 'tfidf';
}

/** Composition of one pass's candidate pool. Measured, not assumed. */
export interface CandidateMix {
  semanticSimilarityAvailable: boolean;
  /** Unlinked pairs each ranking found, BEFORE the MAX_CANDIDATES cap. */
  embeddingPoolSize: number;
  tfidfPoolSize: number;
  /** Of the capped pool, how many each ranking contributed. */
  fromEmbedding: number;
  fromTfidf: number;
  /** Candidates carrying both numbers, and how far apart they were. */
  bothSignals: number;
  /** Pairs where the two signals disagree by more than 0.3. NOT suppressed. */
  strongDisagreements: number;
}

function emptyMix(semanticSimilarityAvailable: boolean): CandidateMix {
  return {
    semanticSimilarityAvailable,
    embeddingPoolSize: 0, tfidfPoolSize: 0,
    fromEmbedding: 0, fromTfidf: 0,
    bothSignals: 0, strongDisagreements: 0,
  };
}

/** Signals disagreeing by more than this are called out in the prompt. */
const DISAGREEMENT_BAND = 0.3;

/**
 * Take top N/2 from each ranking by strict alternation, deduping pairs that
 * both rankings found. When one ranking is short (or empty — e.g. no real
 * embedder) the other fills the remaining slots, so the LLM budget is never
 * wasted; what changes is the COMPOSITION, not the count.
 *
 * Every emitted candidate is scored by BOTH signals where both can be
 * computed, including the one that did not surface it. That is the whole
 * point: a pair the embedding ranking loved and TF-IDF scored near zero is a
 * paraphrase, and the LLM should be told so.
 */
export function interleaveCandidates(
  embRanked: ReadonlyArray<{ idA: string; idB: string; similarity: number }>,
  tfidfRanked: ReadonlyArray<{ idA: string; idB: string; similarity: number }>,
  tfidf: { score(a: string, b: string): number | null } | null,
  embs: ReadonlyMap<string, number[]>,
  limit: number,
): EdgeCandidate[] {
  const out: EdgeCandidate[] = [];
  const taken = new Set<string>();
  let i = 0;
  let j = 0;
  // Alternate; the turn flips each round so neither ranking can starve the
  // other, and a spent ranking simply yields its turn to the live one.
  //
  // EXHAUSTION IS RESOLVED BEFORE THE TURN, not after. Deciding the source
  // from the turn alone and relying on the loop guard to stop is not safe:
  // if the chosen list is empty while the other is not, the guard stays true,
  // nothing is consumed, and the loop spins forever. Checking emptiness first
  // makes `src` always defined, so every iteration consumes exactly one entry
  // and termination follows from the indices alone.
  let embeddingTurn = true;
  while (out.length < limit && (i < embRanked.length || j < tfidfRanked.length)) {
    const embLeft = i < embRanked.length;
    const tfidfLeft = j < tfidfRanked.length;
    const useEmb = !tfidfLeft ? true : !embLeft ? false : embeddingTurn;
    const src = useEmb ? embRanked[i++]! : tfidfRanked[j++]!;
    embeddingTurn = !embeddingTurn;
    const key = edgeKey(src.idA, src.idB);
    if (taken.has(key)) continue;
    taken.add(key);
    out.push({
      idA: src.idA,
      idB: src.idB,
      tfidfCosine: useEmb ? (tfidf?.score(src.idA, src.idB) ?? null) : src.similarity,
      embeddingCosine: useEmb ? src.similarity : embeddingCosineOf(embs, src.idA, src.idB),
      surfacedBy: useEmb ? 'embedding' : 'tfidf',
    });
  }
  return out;
}

/** Cosine of two stored vectors, or null when either is missing. Returns null
 *  (not 0) on an empty map — an ABSENT signal, not a claim of dissimilarity. */
function embeddingCosineOf(embs: ReadonlyMap<string, number[]>, a: string, b: string): number | null {
  const va = embs.get(a);
  const vb = embs.get(b);
  if (!va || !vb || va.length === 0 || va.length !== vb.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < va.length; i++) {
    const x = va[i]!;
    const y = vb[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? null : dot / denom;
}

function summarizeMix(
  candidates: ReadonlyArray<EdgeCandidate>,
  semanticSimilarityAvailable: boolean,
  embeddingPoolSize: number,
  tfidfPoolSize: number,
): CandidateMix {
  const mix = emptyMix(semanticSimilarityAvailable);
  mix.embeddingPoolSize = embeddingPoolSize;
  mix.tfidfPoolSize = tfidfPoolSize;
  for (const c of candidates) {
    if (c.surfacedBy === 'embedding') mix.fromEmbedding += 1;
    else mix.fromTfidf += 1;
    if (c.tfidfCosine !== null && c.embeddingCosine !== null) {
      mix.bothSignals += 1;
      if (Math.abs(c.tfidfCosine - c.embeddingCosine) > DISAGREEMENT_BAND) {
        mix.strongDisagreements += 1;
      }
    }
  }
  return mix;
}

/**
 * The signals block appended to the LLM prompt. An unavailable signal is
 * reported as UNAVAILABLE — never as 0, which would be a positive claim of
 * dissimilarity rather than an absence.
 *
 * This block is evidence. It never removes a candidate.
 */
export function describeSignals(cand: EdgeCandidate): string {
  const kw = cand.tfidfCosine === null
    ? 'UNAVAILABLE (no lexical index for this pair)'
    : cand.tfidfCosine.toFixed(3);
  const sem = cand.embeddingCosine === null
    ? 'UNAVAILABLE (no real embedding model is loaded, so meaning overlap is unknown)'
    : cand.embeddingCosine.toFixed(3);
  const lines = [
    'Signals (evidence, not a verdict):',
    `- keyword overlap (TF-IDF cosine, 0-1): ${kw}`,
    `- meaning overlap (embedding cosine, 0-1): ${sem}`,
  ];
  if (cand.tfidfCosine !== null && cand.embeddingCosine !== null) {
    const gap = cand.tfidfCosine - cand.embeddingCosine;
    if (Math.abs(gap) > DISAGREEMENT_BAND) {
      lines.push(gap > 0
        ? `- THE SIGNALS DISAGREE (gap ${gap.toFixed(3)}): much shared vocabulary, little shared meaning. Often the same words about different things - but sometimes a genuine link the embedding missed.`
        : `- THE SIGNALS DISAGREE (gap ${gap.toFixed(3)}): little shared vocabulary, much shared meaning. Often a paraphrase or restatement.`);
    } else {
      lines.push(`- the signals agree (gap ${gap.toFixed(3)}).`);
    }
  }
  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function edgeKey(a: string, b: string): string {
  return `${a}${b}`;
}

function parseJudgment(raw: string): { related: boolean; relationship: string; confidence: number } | null {
  // The LLM sometimes wraps JSON in markdown fences or adds preamble despite
  // the system prompt. Strip both before parsing.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  // Find the first {...} block — handles "Output: { ... }" style preambles.
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    const related = p.related === true;
    const relationship = typeof p.relationship === 'string' ? p.relationship.trim().slice(0, 40) : '';
    const confidenceRaw = typeof p.confidence === 'number' ? p.confidence : Number(p.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
    if (!relationship && related) return null;
    return { related, relationship, confidence };
  } catch {
    return null;
  }
}
