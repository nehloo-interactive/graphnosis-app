//! Association index — Deterministic Consolidation's predictive substrate.
//!
//! Reinforcement strengthens an edge only when a pair is co-recalled enough
//! times within one 30-minute window. That misses low-frequency but real
//! associations — two memories recalled together once a week never hit the
//! threshold, so no edge forms. The association index closes that gap: it
//! accumulates the LIFETIME co-recall count for every node pair, across all
//! windows and sessions. It is the deterministic "transition model" behind
//! predictive recall.
//!
//! Storage: `<cortexDir>/association-index.enc` — XChaCha20-Poly1305
//! encrypted with the cortex data key, same as the other App-owned stores.

import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';
import { randomBytes } from 'node:crypto';

/** Filename, relative to the cortex directory. */
export const ASSOCIATION_INDEX_FILE = 'association-index.enc';

/** One node pair and how many times the two have been recalled together. */
export interface AssociationEntry {
  graphId: string;
  /** Endpoint node ids, lexically ordered so `a < b`. */
  a: string;
  b: string;
  /** Lifetime co-recall count. */
  count: number;
}

interface IndexEnvelope {
  version: 1;
  entries: AssociationEntry[];
}

const CURRENT_VERSION = 1 as const;

/** Encode the index into an encrypted blob. Fresh random 16-byte salt per
 *  encode — with a raw key it acts purely as a unique IV. */
export async function encodeAssociationIndex(
  entries: AssociationEntry[],
  dataKey: Uint8Array,
): Promise<Uint8Array> {
  const envelope: IndexEnvelope = { version: CURRENT_VERSION, entries };
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const salt = randomBytes(16);
  return crypto.encrypt(plaintext, dataKey, salt);
}

/** Decode an encrypted index blob. Returns [] for empty / missing /
 *  corrupt — a bad index must never block the cortex from unlocking. */
export async function decodeAssociationIndex(
  blob: Uint8Array,
  dataKey: Uint8Array,
): Promise<AssociationEntry[]> {
  if (blob.length === 0) return [];
  try {
    const plaintext = await crypto.decrypt(blob, dataKey);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<IndexEnvelope>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      console.error('[association-index] decoded blob has no entries array — treating as empty');
      return [];
    }
    if (parsed.version !== CURRENT_VERSION) {
      console.error(`[association-index] unknown version ${parsed.version} — treating as empty`);
      return [];
    }
    return parsed.entries;
  } catch (e) {
    console.error(`[association-index] decode failed: ${(e as Error).message} — treating as empty`);
    return [];
  }
}
