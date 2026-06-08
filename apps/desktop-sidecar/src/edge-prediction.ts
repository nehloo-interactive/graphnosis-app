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
//! Candidate selection (per engram, per loop):
//!   1. Find pairs of embedded nodes whose cosine similarity is in
//!      [SIM_MIN, SIM_MAX) — high enough to plausibly be related, low
//!      enough to not be near-duplicates (which deterministic dedup
//!      handles).
//!   2. Drop pairs that already have a `.gai` edge between them.
//!   3. Drop pairs already in `.gll` (predicted previously — either still
//!      pending review or accepted/rejected).
//!   4. Sort by descending similarity, take top MAX_CANDIDATES.
//!
//! Per pair, the LLM gets a short prompt with both nodes' text and returns
//! JSON `{ related: bool, relationship: string, confidence: number }`.
//! Pairs with `related: false` or confidence < CONFIDENCE_FLOOR are
//! discarded. Survivors become `GllPredictedEdge`s saved to disk.
//!
//! Cost shape:
//!   - One LSH similarity scan per engram per loop — O(N).
//!   - One LLM call per surviving candidate — capped at MAX_CANDIDATES.
//!   - At default cadence (60 min) + cap 8 per engram, a 4-engram cortex
//!     burns ~32 LLM calls/hour. Fits easily on a 3B model.

import { findSimilarPairs } from './duplicate-scan.js';
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import { makeGllPredictedEdge, type GllPredictedEdge } from './gll-overlay.js';
import { settings as settingsMod } from '@graphnosis-app/core';

/** Cosine similarity floor — below this, we don't even ask the LLM. Tuned
 *  so the candidate pool is genuinely "plausibly related" content, not
 *  noise pairs. */
const SIM_MIN = 0.55;
/** Cosine similarity ceiling — above this, the deterministic duplicate
 *  scan handles it (merge proposal), so we skip to avoid duplicate work. */
const SIM_MAX = 0.92;
/** Max candidate pairs per engram per loop. Keeps LLM cost predictable. */
const MAX_CANDIDATES = 8;
/** Drop predictions the LLM gave less than this confidence (0–1). */
const CONFIDENCE_FLOOR = 0.55;
/** Hard timeout per LLM call. The LLM judgment is single-shot JSON. */
const LLM_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = `You judge whether two memory excerpts from the same person's knowledge graph have a meaningful semantic relationship worth connecting.

You will be given two short text excerpts (A and B). Output ONLY a single JSON object:
  { "related": true|false, "relationship": "<1-3 word label>", "confidence": <0..1> }

Rules:
- "related" is true only when A and B refer to the same person/place/project, elaborate one another, or one logically implies / contradicts / follows the other.
- "related" is false for: tangentially-similar topics, vague thematic overlap, or near-duplicates (those are handled elsewhere).
- "relationship" is a short label like "elaborates", "contradicts", "same-project", "precedes", "mentions". Lowercase, no punctuation.
- "confidence" 0..1 — how sure you are.
- Output JSON only. No preamble, no explanation, no markdown fences.`;

/** Run one prediction pass for one engram. Returns the new edges (already
 *  appended to the overlay on disk). Idempotent within a loop — calling
 *  twice in a row will find no new pairs because anything already in .gll
 *  is filtered out. */
export async function predictEdgesForEngram(
  host: GraphnosisHost,
  llm: LocalLlm,
  graphId: string,
): Promise<{ candidatesScanned: number; predicted: GllPredictedEdge[] }> {
  // 1. Pull embeddings + existing edges + the current .gll for this engram.
  const embs = host.getNodeEmbeddings(graphId);
  if (embs.size < 2) return { candidatesScanned: 0, predicted: [] };

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

  // 2. Candidate scan via the LSH similarity helper (same one duplicate-scan
  //    uses). Restrict to the same engram by passing only this engram's
  //    embeddings — getNodeEmbeddings is already per-engram.
  const pairs = await findSimilarPairs(embs, {
    minSim: SIM_MIN,
    maxSim: SIM_MAX,
    // Yield to the event loop during the LSH scan so the GNN edge-prediction
    // pass doesn't block the UI's IPC on a large engram (matches duplicate-scan).
    onYield: () => new Promise<void>((resolve) => setImmediate(resolve)),
  });
  // 3. Filter pairs that already have an edge anywhere; sort by sim desc;
  //    take top MAX_CANDIDATES.
  const candidates = pairs
    .filter((p) => !existingEdgeKeys.has(edgeKey(p.idA, p.idB)))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, MAX_CANDIDATES);

  if (candidates.length === 0) {
    return { candidatesScanned: 0, predicted: [] };
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
          user: `A: ${textA.slice(0, 600)}\n\nB: ${textB.slice(0, 600)}`,
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
    return { candidatesScanned: candidates.length, predicted: [] };
  }

  // 5. Append + persist. Read-modify-write: load current overlay, append the
  //    new edges, save back. Concurrent prediction passes across engrams are
  //    serialized by the scheduler loop, so we don't need a per-overlay lock.
  const current = await host.loadGllOverlay();
  await host.saveGllOverlay([...current.edges, ...newEdges], current.assertions);
  return { candidatesScanned: candidates.length, predicted: newEdges };
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
