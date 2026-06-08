//! Graphnosis Local Layer — the local-LLM overlay.
//!
//! Parallel to `.gnn` (neural-network predicted edges), this is where the
//! local LLM's outputs land when they look like graph mutations: predicted
//! edges between memories, inferred assertions about the user, "this fact is
//! probably also true given what's in the engram," etc. None of this is ever
//! written into the canonical `.gai` engram. The local LLM cannot mutate
//! attested memory — only the user can, via an explicit correction the user
//! reviews and approves.
//!
//! Layered architecture:
//!
//!     .gai   — canonical engram (user-attested nodes + edges)
//!     .gnn   — neural-network predicted edges overlay (probabilistic)
//!     .gll   — local-LLM predicted edges + assertions overlay (probabilistic)
//!
//! Storage: `<cortexDir>/local-layer.gll` — XChaCha20-Poly1305 encrypted with
//! the cortex data key, identical envelope to `.gnn`. Records node ids and
//! free-text assertion content, so it MUST be encrypted at rest.
//!
//! Recall integration: when `host.recall()` runs, overlay nodes and edges
//! get merged into the rich subgraph result with explicit "[gll]" badges so
//! the AI client can distinguish attested vs inferred content. The user can
//! turn the overlay off entirely (in Foresight) and recall reverts
//! to the canonical `.gai` view byte-for-byte.
//!
//! Reversible: deleting `local-layer.gll` returns the cortex to its
//! pre-LLM-overlay state. No data loss anywhere because nothing the LLM
//! produces has ever overwritten anything the user attested.
//!
//! GDPR-friendly: a user can wipe LLM-inferred data with one click without
//! losing their actual notes. The data subject's attested memory and the
//! AI-inferred derivative are physically separate files.

import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';
import { randomBytes } from 'node:crypto';

/** Filename, relative to the cortex directory. */
export const GLL_OVERLAY_FILE = 'local-layer.gll';

/**
 * One connection the local LLM predicted is likely real. Mirrors
 * GNN's PredictedEdge — the two overlays share data shape on purpose
 * so the recall merge layer can treat them uniformly.
 */
export interface GllPredictedEdge {
  /** Stable unique id. */
  id: string;
  /** Engram the two endpoints belong to. */
  graphId: string;
  /** Endpoint node ids — must reference real .gai nodes (the LLM can't
   *  predict edges to/from nodes that don't exist yet). */
  from: string;
  to: string;
  /** Free-text label the LLM gave the relationship (e.g. "elaborates",
   *  "contradicts", "implies"). Surfaced to the AI client so the inferred
   *  semantics are explicit. */
  relationship: string;
  /** The model's confidence the connection is real, 0–1. */
  score: number;
  /** Unix ms when the prediction was made. */
  createdAt: number;
  /** Optional — model name + tag used at the time of inference, so
   *  predictions made by a now-removed model can be filtered out. */
  modelTag?: string;
}

/**
 * One inferred assertion the local LLM derived from the canonical engram.
 * Distinct from a `.gai` node because it has no source — it's a synthesis,
 * not a recorded fact. Surfaces in recall with a clear "[gll-inferred]"
 * badge so the AI never confuses it with an attested memory.
 */
export interface GllAssertion {
  /** Stable unique id, scoped to the overlay (does NOT collide with .gai
   *  node ids — see makeAssertionId). */
  id: string;
  /** Engram this assertion belongs to. Determines tier + access policy. */
  graphId: string;
  /** The assertion text. Should be short, declarative, single-fact-ish. */
  content: string;
  /** Node ids from the canonical engram that the LLM drew this from.
   *  Empty array allowed (pure synthesis) but discouraged. */
  derivedFrom: string[];
  /** Model confidence, 0–1. */
  score: number;
  /** Unix ms when the assertion was made. */
  createdAt: number;
  /** Optional model tag — same purpose as on GllPredictedEdge. */
  modelTag?: string;
}

interface GllEnvelope {
  version: 1;
  edges: GllPredictedEdge[];
  assertions: GllAssertion[];
}

const CURRENT_VERSION = 1 as const;

/** Prefix used on assertion ids so a merged subgraph can tell at a glance
 *  whether a node id came from `.gai` (no prefix) or `.gll`. */
const ASSERTION_ID_PREFIX = 'gll:';

/** Encode the overlay into an encrypted blob. Fresh random 16-byte salt per
 *  encode — with a raw key it acts purely as a unique IV. */
export async function encodeGllOverlay(
  edges: GllPredictedEdge[],
  assertions: GllAssertion[],
  dataKey: Uint8Array,
): Promise<Uint8Array> {
  const envelope: GllEnvelope = { version: CURRENT_VERSION, edges, assertions };
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const salt = randomBytes(16);
  return crypto.encrypt(plaintext, dataKey, salt);
}

/** Decode an encrypted overlay blob. Returns empty overlay for empty /
 *  missing / corrupt input — a bad overlay must never block the cortex
 *  from unlocking, and the overlay is non-authoritative anyway. */
export async function decodeGllOverlay(
  blob: Uint8Array,
  dataKey: Uint8Array,
): Promise<{ edges: GllPredictedEdge[]; assertions: GllAssertion[] }> {
  if (blob.length === 0) return { edges: [], assertions: [] };
  try {
    const plaintext = await crypto.decrypt(blob, dataKey);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<GllEnvelope>;
    if (!parsed || typeof parsed !== 'object') {
      console.error('[gll-overlay] decoded blob is not an object — treating as empty');
      return { edges: [], assertions: [] };
    }
    if (parsed.version !== CURRENT_VERSION) {
      console.error(`[gll-overlay] unknown overlay version ${parsed.version} — treating as empty`);
      return { edges: [], assertions: [] };
    }
    return {
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      assertions: Array.isArray(parsed.assertions) ? parsed.assertions : [],
    };
  } catch (e) {
    console.error(`[gll-overlay] decode failed: ${(e as Error).message} — treating as empty`);
    return { edges: [], assertions: [] };
  }
}

/** Construct a fresh predicted edge. The id is generated here. */
export function makeGllPredictedEdge(fields: Omit<GllPredictedEdge, 'id'>): GllPredictedEdge {
  return { id: randomBytes(8).toString('hex'), ...fields };
}

/** Construct a fresh assertion. Id carries the `gll:` prefix so a merged
 *  subgraph view can identify overlay nodes without an extra lookup. */
export function makeGllAssertion(fields: Omit<GllAssertion, 'id'>): GllAssertion {
  return { id: ASSERTION_ID_PREFIX + randomBytes(8).toString('hex'), ...fields };
}

/** True when a node id refers to an assertion in this overlay (rather than
 *  an attested node in `.gai`). Used by the recall merge layer to badge
 *  inferred content distinctly. */
export function isAssertionId(nodeId: string): boolean {
  return nodeId.startsWith(ASSERTION_ID_PREFIX);
}
