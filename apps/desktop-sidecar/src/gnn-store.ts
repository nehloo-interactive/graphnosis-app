//! Graphnosis Neural Network overlay — the non-deterministic prediction layer.
//!
//! The GNN's predicted connections are deliberately kept OUT of the `.gai`
//! graph. They live here, in a separate overlay, so the deterministic graph
//! stays pure: core recall traverses only `.gai` and is always perfectly
//! consistent. The GNN's predictions surface only through the clearly
//! labelled recall-enrichment section and the 3D Engram's (toggleable)
//! prediction layer — never silently inside a deterministic answer.
//!
//! Storage: `<cortexDir>/neural-network.gnn` — XChaCha20-Poly1305 encrypted
//! with the cortex data key, same primitive as the `.gai` files. It records
//! node ids, so it MUST be encrypted at rest like everything else.
//!
//! Because nothing here touches `.gai`, "undo" is trivial — discard the
//! overlay — and there is no way for the neural network to corrupt a
//! deterministic memory.

import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';
import { randomBytes } from 'node:crypto';

/** Filename, relative to the cortex directory. */
export const GNN_STORE_FILE = 'neural-network.gnn';

/** One connection the Graphnosis Neural Network predicted is likely real. */
export interface PredictedEdge {
  /** Stable unique id. */
  id: string;
  /** Engram the two endpoints belong to. */
  graphId: string;
  /** Endpoint node ids. */
  from: string;
  to: string;
  /** The model's predicted probability the connection is real, 0–1. */
  score: number;
  /** Unix ms when the prediction was made. */
  createdAt: number;
}

interface GnnEnvelope {
  version: 1;
  edges: PredictedEdge[];
}

const CURRENT_VERSION = 1 as const;

/** Encode the overlay into an encrypted blob. Fresh random 16-byte salt per
 *  encode — with a raw key it acts purely as a unique IV. */
export async function encodeGnnStore(
  edges: PredictedEdge[],
  dataKey: Uint8Array,
): Promise<Uint8Array> {
  const envelope: GnnEnvelope = { version: CURRENT_VERSION, edges };
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const salt = randomBytes(16);
  return crypto.encrypt(plaintext, dataKey, salt);
}

/** Decode an encrypted overlay blob. Returns [] for empty / missing /
 *  corrupt — a bad overlay must never block the cortex from unlocking, and
 *  the overlay is non-authoritative anyway (it is only predictions). */
export async function decodeGnnStore(
  blob: Uint8Array,
  dataKey: Uint8Array,
): Promise<PredictedEdge[]> {
  if (blob.length === 0) return [];
  try {
    const plaintext = await crypto.decrypt(blob, dataKey);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<GnnEnvelope>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.edges)) {
      console.error('[gnn-store] decoded blob has no edges array — treating as empty');
      return [];
    }
    if (parsed.version !== CURRENT_VERSION) {
      console.error(`[gnn-store] unknown store version ${parsed.version} — treating as empty`);
      return [];
    }
    return parsed.edges;
  } catch (e) {
    console.error(`[gnn-store] decode failed: ${(e as Error).message} — treating as empty`);
    return [];
  }
}

/** Construct a fresh predicted edge. The id is generated here. */
export function makePredictedEdge(fields: Omit<PredictedEdge, 'id'>): PredictedEdge {
  return { id: randomBytes(8).toString('hex'), ...fields };
}
