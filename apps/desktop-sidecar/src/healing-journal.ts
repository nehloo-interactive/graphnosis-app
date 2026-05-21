//! Healing journal — the autonomous brain's audit + re-review substrate.
//!
//! When the Autonomous Brain auto-heals a near-duplicate (merging two
//! memories that say the same thing), it does so with *deterministic*
//! rules: exact-duplicate detection and strict token-set containment.
//! Those rules are conservative and provably safe — they never lose
//! information — but they're "dumb": they can't judge nuance.
//!
//! Every auto-heal writes a record here. The record freezes BOTH nodes'
//! full content at heal time, so that if a local LLM later becomes
//! available, a second-opinion pass (`runHealingReview` in brain-engine)
//! can re-judge the *exact inputs* the deterministic rule saw and, if
//! warranted, reverse the call — flip the merge direction, un-merge a
//! pair that shouldn't have been merged, or resynthesize a better
//! combined node.
//!
//! This is "eventually-consistent intelligence": heal fast now with safe
//! rules, upgrade the decisions when smarter capability arrives. The
//! content snapshots are kept FOREVER (not dropped after first review)
//! so that even a future, stronger model can take another look.
//!
//! Storage: `<cortexDir>/healing-journal.enc` — XChaCha20-Poly1305
//! encrypted with the cortex data key, same primitive as `.gai` files
//! and `connectors.enc`. The journal contains memory content snapshots,
//! so it MUST be encrypted at rest like everything else in the cortex.

import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';
import { randomBytes } from 'node:crypto';

/** Filename, relative to the cortex directory. */
export const HEALING_JOURNAL_FILE = 'healing-journal.enc';

/** Which deterministic rule decided this pair was safe to auto-heal. */
export type HealingRule =
  /** `digitMasked(A) === digitMasked(B)` — identical once numbers are
   *  masked. The same record captured twice. Either node may survive;
   *  we keep the higher-confidence / more-recent one. */
  | 'exact-duplicate'
  /** One node's token set strictly contains the other's — the survivor
   *  says everything the superseded one said, plus more. No information
   *  is lost by dropping the shorter node. */
  | 'superset-duplicate';

/** Verdict from the LLM second-opinion pass, once a local model is
 *  available. Absent until `llmReviewed` flips true. */
export type HealingLlmVerdict =
  /** Deterministic rule was correct. Nothing to do. */
  | 'confirmed'
  /** Rule kept the wrong node — the merge direction should flip. */
  | 'reversed'
  /** The pair should NOT have been merged (they're genuinely distinct
   *  or genuinely contradictory). The superseded node is restored and
   *  the pair is handed to the Check-in deck for human judgment. */
  | 'unmerged'
  /** Merge was right, but neither original text is ideal — the LLM
   *  wrote a better combined node that supersedes the survivor. */
  | 'resynthesized';

/**
 * One auto-heal event. Append-only in spirit: the fields below `llmNote`
 * are filled in later by the review pass; everything above is frozen at
 * heal time and never mutated.
 */
export interface HealingRecord {
  /** Stable unique id for this heal event. */
  id: string;
  /** Engram the heal happened in. */
  graphId: string;
  /** Unix ms when the deterministic rule did the heal. */
  healedAt: number;
  /** Cosine similarity of the two nodes' embeddings at detection time. */
  similarity: number;
  /** Which deterministic rule fired. */
  rule: HealingRule;

  /** The node that remains active in the graph. */
  survivingNodeId: string;
  /** The node that was soft-deleted (superseded). Recoverable from the
   *  op-log; this id lets the review pass find it. */
  supersededNodeId: string;

  /** Full text content of the surviving node, frozen at heal time.
   *  NOT truncated — the LLM review pass needs the complete input. */
  survivingContentSnapshot: string;
  /** Full text content of the superseded node, frozen at heal time. */
  supersededContentSnapshot: string;

  /** Human/audit-readable reason the deterministic rule picked this
   *  survivor (e.g. "kept higher confidence: 0.91 vs 0.62"). */
  decisionReason: string;

  /** False until the LLM second-opinion pass has looked at this record. */
  llmReviewed: boolean;
  /** Verdict from the review pass. Absent until `llmReviewed` is true. */
  llmVerdict?: HealingLlmVerdict;
  /** Unix ms when the review pass ran. Absent until reviewed. */
  llmReviewedAt?: number;
  /** Optional free-text note from the LLM explaining a non-`confirmed`
   *  verdict — surfaced in the Autonomous Brain healing log. */
  llmNote?: string;
}

/** Current on-disk envelope. Versioned so future schema changes can
 *  migrate cleanly rather than silently mis-parsing. */
interface JournalEnvelope {
  version: 1;
  records: HealingRecord[];
}

const CURRENT_VERSION = 1 as const;

/**
 * Encode a journal into an encrypted blob ready to write to disk.
 *
 * `dataKey` is the cortex data key (`host.key`). A fresh random 16-byte
 * salt is generated per encode — with a raw key (not a passphrase) the
 * salt acts purely as a unique IV, so re-encoding the same journal
 * produces different ciphertext each time. That's fine and expected.
 */
export async function encodeHealingJournal(
  records: HealingRecord[],
  dataKey: Uint8Array,
): Promise<Uint8Array> {
  const envelope: JournalEnvelope = { version: CURRENT_VERSION, records };
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const salt = randomBytes(16);
  return crypto.encrypt(plaintext, dataKey, salt);
}

/**
 * Decode an encrypted journal blob. Returns [] for an empty/missing
 * journal — callers treat "no journal yet" and "empty journal" the same.
 *
 * A decryption or parse failure is non-fatal: we log to stderr and
 * return [] rather than throwing, so a corrupt journal can't block the
 * cortex from unlocking. The op-log still holds the supersede lineage —
 * the journal is an enrichment layer, not the source of truth for
 * whether a heal happened.
 */
export async function decodeHealingJournal(
  blob: Uint8Array,
  dataKey: Uint8Array,
): Promise<HealingRecord[]> {
  if (blob.length === 0) return [];
  try {
    const plaintext = await crypto.decrypt(blob, dataKey);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<JournalEnvelope>;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
      console.error('[healing-journal] decoded blob has no records array — treating as empty');
      return [];
    }
    if (parsed.version !== CURRENT_VERSION) {
      // No migrations needed yet — v1 is the only version. When a v2
      // lands, branch here. For now an unknown version is treated as
      // unreadable rather than risking a mis-parse.
      console.error(`[healing-journal] unknown journal version ${parsed.version} — treating as empty`);
      return [];
    }
    return parsed.records;
  } catch (e) {
    console.error(`[healing-journal] decode failed: ${(e as Error).message} — treating as empty`);
    return [];
  }
}

/** Construct a fresh, un-reviewed healing record. The id is generated
 *  here so callers don't have to. */
export function makeHealingRecord(fields: Omit<HealingRecord, 'id' | 'llmReviewed'>): HealingRecord {
  return {
    id: randomBytes(8).toString('hex'),
    llmReviewed: false,
    ...fields,
  };
}
