//! Cross-engram connection store — Deterministic Consolidation's multi-graph layer.
//!
//! The SDK's dual-graph edges are strictly intra-engram: an edge references
//! two node ids within ONE graph. To link memories ACROSS engrams — so the
//! cortex stops siloing each engram — Deterministic Consolidation keeps its own
//! store of cross-engram connections, App-owned and separate from the .gai
//! files.
//!
//! Storage: `<cortexDir>/cross-engram-connections.enc` — XChaCha20-Poly1305
//! encrypted with the cortex data key, same primitive as `.gai` files and
//! `healing-journal.enc`. It records ids of memories the user has saved, so
//! it MUST be encrypted at rest like everything else in the cortex.

import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';
import { randomBytes } from 'node:crypto';

/** Filename, relative to the cortex directory. */
export const CROSS_ENGRAM_CONNECTIONS_FILE = 'cross-engram-connections.enc';

/** How a cross-engram connection was first discovered. */
export type CrossEngramBasis =
  /** The two memories' embeddings are highly similar. */
  | 'embedding-sim'
  /** The two memories share a meaningful named entity. */
  | 'entity-overlap';

/** A single associative link between memories in two different engrams. */
export interface CrossEngramConnection {
  /** Stable unique id. */
  id: string;
  /** First engram + node. */
  graphA: string;
  nodeA: string;
  /** Second engram + node. */
  graphB: string;
  nodeB: string;
  /** Strength, 0–1. Seeded from the discovery signal; strengthen-only
   *  thereafter — reinforced when both endpoints are co-recalled. */
  weight: number;
  /** How the connection was discovered. */
  basis: CrossEngramBasis;
  /** Entities shared by the two memories — set when basis is 'entity-overlap'. */
  sharedEntities?: string[];
  /** Unix ms when the connection was formed. */
  createdAt: number;
  /** Unix ms of the most recent reinforcement, if any. */
  lastReinforcedAt?: number;
}

/** Current on-disk envelope. Versioned so future schema changes migrate
 *  cleanly rather than silently mis-parsing. */
interface StoreEnvelope {
  version: 1;
  connections: CrossEngramConnection[];
}

const CURRENT_VERSION = 1 as const;

/**
 * Encode the store into an encrypted blob. A fresh random 16-byte salt is
 * generated per encode — with a raw key (not a passphrase) the salt acts
 * purely as a unique IV, so re-encoding produces different ciphertext each
 * time. That is expected.
 */
export async function encodeConnectionStore(
  connections: CrossEngramConnection[],
  dataKey: Uint8Array,
): Promise<Uint8Array> {
  const envelope: StoreEnvelope = { version: CURRENT_VERSION, connections };
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const salt = randomBytes(16);
  return crypto.encrypt(plaintext, dataKey, salt);
}

/**
 * Decode an encrypted store blob. Returns [] for an empty / missing /
 * corrupt store — a bad store must never block the cortex from unlocking.
 */
export async function decodeConnectionStore(
  blob: Uint8Array,
  dataKey: Uint8Array,
): Promise<CrossEngramConnection[]> {
  if (blob.length === 0) return [];
  try {
    const plaintext = await crypto.decrypt(blob, dataKey);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<StoreEnvelope>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.connections)) {
      console.error('[connection-store] decoded blob has no connections array — treating as empty');
      return [];
    }
    if (parsed.version !== CURRENT_VERSION) {
      console.error(`[connection-store] unknown store version ${parsed.version} — treating as empty`);
      return [];
    }
    return parsed.connections;
  } catch (e) {
    console.error(`[connection-store] decode failed: ${(e as Error).message} — treating as empty`);
    return [];
  }
}

/** Construct a fresh cross-engram connection. The id is generated here. */
export function makeCrossEngramConnection(
  fields: Omit<CrossEngramConnection, 'id'>,
): CrossEngramConnection {
  return { id: randomBytes(8).toString('hex'), ...fields };
}
