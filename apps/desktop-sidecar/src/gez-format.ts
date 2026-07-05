/**
 * GEZ format — Graphnosis Engram Zero pack serialization.
 *
 * A `.gez` file is AES-256-GCM encrypted JSON. Same crypto structure as `.gsk`
 * (magic bytes, IV, auth tag, ciphertext). The Ed25519 signature covers the
 * payload so recipients can verify it was produced by this cortex owner.
 *
 * The signature key here is PER-CORTEX, not the Nehloo master key: on export the
 * sidecar signs with a locally-derived key (HMAC-SHA512 of the data key + "gez").
 * The matching public key is embedded in the pack. Recipients verify offline.
 *
 * This means `.gez` packs are self-authenticating: the recipient just needs the
 * pack file — no network call, no Nehloo server, no CA chain.
 *
 * Format:  [4-byte magic][12-byte IV][16-byte auth tag][N-byte ciphertext]
 * Payload: GezPayload (JSON, compressed before encryption for large engrams).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';
import {
  encodePackV2Body,
  decodePackV2Body,
  peekEncMode,
  type EncMode,
  type EncryptForOption,
  type DecryptOptions,
} from './pack-crypto.js';

// ── GEZ payload types ─────────────────────────────────────────────────────────

export interface GezSourceEntry {
  /** Source ID (preserved for conflict detection on re-import). */
  sourceId: string;
  /** Source kind — used to tag the re-ingested record on import. */
  kind: 'clip' | 'file' | 'url' | 'ai-conversation' | 'skill';
  /** Human-readable label shown in Sources list after import. */
  ref: string;
  /** Full text content of the source (all chunks concatenated). */
  text: string;
  /** Timestamp of original ingestion. Preserved for provenance. */
  ingestedAt: number;
  /** Who originally added this source. Forwarded to the imported record. Absent when not known. */
  addedBy?: string | undefined;
}

export interface GezPayload {
  formatVersion: '1';
  /** Exporting cortex's device ID — for provenance / display. */
  exportedBy: string;
  /** Wall-clock timestamp when the pack was created. */
  exportedAt: number;
  /** Source engram ID. */
  engramId: string;
  /** Display name of the exported engram. */
  engramDisplayName: string;
  /** Sensitivity tier of the source engram. */
  engramTier: 'public' | 'personal' | 'sensitive';
  /** Template kind of the source engram. */
  engramTemplate: string;
  /** All sources in the engram, with full text content. */
  sources: GezSourceEntry[];
  /**
   * Base64-encoded Ed25519 public key used to sign this pack.
   * The matching private key is derived from the exporting cortex's data key.
   * Recipients call verifyGezSignature() to validate.
   * Empty string for unsigned/community packs.
   */
  signerPublicKey: string;
  /**
   * Base64-encoded Ed25519 signature over the payload JSON with this field set to "".
   * Empty string for unsigned packs.
   */
  signature: string;
}

export interface GezImportResult {
  /** Number of sources successfully ingested. */
  imported: number;
  /** Number of sources skipped because a matching sourceId already existed. */
  skipped: number;
  /** Number of sources that failed to ingest. */
  failed: number;
  /** Per-source outcomes. */
  outcomes: Array<{
    sourceId: string;
    ref: string;
    status: 'imported' | 'skipped' | 'failed';
    newSourceId?: string;
    error?: string;
  }>;
  /** True if the pack's signature verified successfully. */
  signatureVerified: boolean;
  /** True if the pack was unsigned (no signature to verify). */
  unsigned: boolean;
  /**
   * Quarantine landing info. When the import was quarantined (the default), the
   * sources land in this dedicated quarantine engram — excluded from recall,
   * dispatch, the proactive watcher, and cross-skill resolution until the owner
   * promotes them. Absent only for an explicit non-quarantined import.
   */
  quarantineEngramId?: string;
}

// ── Encryption constants ──────────────────────────────────────────────────────

// 32-byte AES-256-GCM key. Obfuscation-grade: the real integrity check is
// the per-pack Ed25519 signature.
// ASCII: "GraphnosisGEZKey2026EngramPackFo"
const GEZ_ENC_KEY = Buffer.from([
  0x47, 0x72, 0x61, 0x70, 0x68, 0x6e, 0x6f, 0x73,
  0x69, 0x73, 0x47, 0x45, 0x5a, 0x4b, 0x65, 0x79,
  0x32, 0x30, 0x32, 0x36, 0x45, 0x6e, 0x67, 0x72,
  0x61, 0x6d, 0x50, 0x61, 0x63, 0x6b, 0x46, 0x6f,
]);

const MAGIC = Buffer.from('GEZ1');
const MAGIC_V2 = Buffer.from('GEZ2');

/** Sign a GezPayload in place, returning the finalized payload + JSON string.
 *  The Ed25519 signature path is IDENTICAL for v1 and v2 — confidentiality and
 *  authenticity are orthogonal layers. */
function signGezPayload(payload: GezPayload, signingKeyHex?: string): { finalPayload: GezPayload; json: string } {
  let signature = '';
  let signerPublicKey = '';

  if (signingKeyHex) {
    const secretKey = Buffer.from(signingKeyHex, 'hex');
    if (secretKey.length === 64) {
      signerPublicKey = Buffer.from(secretKey.subarray(32)).toString('base64');
      const payloadForSigning = JSON.stringify({ ...payload, signature: '', signerPublicKey });
      const payloadBytes = new TextEncoder().encode(payloadForSigning);
      const sigBytes = sodium.crypto_sign_detached(payloadBytes, secretKey);
      signature = Buffer.from(sigBytes).toString('base64');
    }
  }

  const finalPayload: GezPayload = { ...payload, signature, signerPublicKey };
  return { finalPayload, json: JSON.stringify(finalPayload) };
}

// ── buildGezPackage ───────────────────────────────────────────────────────────

/**
 * Serialize and encrypt a GezPayload into `.gez` bytes.
 *
 * Pass `signingKeyHex` (64-byte Ed25519 secret key, hex) to produce a signed
 * pack. Omit for an unsigned community pack — `signature` stays "".
 *
 * For signed packs the matching public key is embedded in `signerPublicKey`
 * so recipients can verify without contacting the exporter.
 */
export function buildGezPackage(payload: GezPayload, signingKeyHex?: string): Buffer {
  const { json } = signGezPayload(payload, signingKeyHex);

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', GEZ_ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, iv, authTag, encrypted]);
}

// ── parseGezPackage ───────────────────────────────────────────────────────────

/**
 * Decrypt and parse a `.gez` Buffer. Returns the GezPayload on success.
 * Throws on malformed data, bad magic, or decryption failure.
 * Does NOT verify the Ed25519 signature — call `verifyGezSignature` separately.
 */
export function parseGezPackage(data: Buffer): GezPayload {
  if (data.length < MAGIC.length + 12 + 16 + 2) {
    throw new Error('GEZ data is too short to be a valid pack.');
  }

  const magic = data.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error('Not a valid GEZ pack (bad magic bytes). Expected GEZ1 header.');
  }

  const iv        = data.subarray(4, 16);
  const authTag   = data.subarray(16, 32);
  const ciphertext = data.subarray(32);

  const decipher = createDecipheriv('aes-256-gcm', GEZ_ENC_KEY, iv);
  decipher.setAuthTag(authTag);

  let json: string;
  try {
    json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('GEZ decryption failed. The file may be corrupted or from an incompatible version.');
  }

  try {
    return JSON.parse(json) as GezPayload;
  } catch {
    throw new Error('GEZ payload is not valid JSON.');
  }
}

// ── v2: buildGezPackageV2 / parseGezPackageV2 ──────────────────────────────────

/**
 * Build a v2 `.gez` pack (`GEZ2` magic) with recipient-controlled confidentiality.
 *
 * The Ed25519 signature path is unchanged from v1. The payload JSON is encrypted
 * under a per-pack random content key (CEK) that is itself wrapped per `encrypt`:
 *   - omit `encrypt`            → encMode 'none' (v2 framing, treat as public)
 *   - `{ passphrase }`          → Argon2id-derived CEK
 *   - `{ recipientPubKeys }`    → CEK sealed to each X25519 recipient
 */
export async function buildGezPackageV2(
  payload: GezPayload,
  opts: { signingKeyHex?: string; encrypt?: EncryptForOption } = {},
): Promise<Buffer> {
  await sodium.ready;
  const { json } = signGezPayload(payload, opts.signingKeyHex);
  const body = await encodePackV2Body(json, GEZ_ENC_KEY, opts.encrypt);
  return Buffer.concat([MAGIC_V2, body]);
}

/**
 * Decrypt + parse a v2 `.gez` pack. Supply `passphrase` / `recipientSecretKeyB64`
 * matching the pack's encMode. Returns the payload plus the detected encMode.
 * Does NOT verify the Ed25519 signature — call `verifyGezSignature` separately.
 */
export async function parseGezPackageV2(
  data: Buffer,
  opts: DecryptOptions = {},
): Promise<{ payload: GezPayload; encMode: EncMode }> {
  await sodium.ready;
  if (data.length < MAGIC_V2.length + 1 + 4) {
    throw new Error('GEZ v2 data is too short to be a valid pack.');
  }
  if (!data.subarray(0, 4).equals(MAGIC_V2)) {
    throw new Error('Not a valid GEZ v2 pack (bad magic bytes). Expected GEZ2 header.');
  }
  const { json, encMode } = await decodePackV2Body(data.subarray(4), GEZ_ENC_KEY, opts);
  let payload: GezPayload;
  try {
    payload = JSON.parse(json) as GezPayload;
  } catch {
    throw new Error('GEZ v2 payload is not valid JSON.');
  }
  return { payload, encMode };
}

/**
 * Magic-byte dispatcher: parse a `.gez` Buffer regardless of version.
 *   - GEZ1 → v1 obfuscation path (no key needed; flagged encMode 'none').
 *   - GEZ2 → v2 path (passphrase / recipientSecretKeyB64 from `opts` as needed).
 * Returns the payload plus the encMode (v1 always reports 'none').
 */
export async function parseGezPackageAny(
  data: Buffer,
  opts: DecryptOptions = {},
): Promise<{ payload: GezPayload; encMode: EncMode; version: 1 | 2 }> {
  if (data.length >= 4 && data.subarray(0, 4).equals(MAGIC_V2)) {
    const { payload, encMode } = await parseGezPackageV2(data, opts);
    return { payload, encMode, version: 2 };
  }
  return { payload: parseGezPackage(data), encMode: 'none', version: 1 };
}

/** Read a `.gez` pack's encMode without decrypting (provenance display). */
export function peekGezEncMode(data: Buffer): EncMode {
  if (data.length >= 4 && data.subarray(0, 4).equals(MAGIC_V2)) {
    return peekEncMode(data.subarray(4)) ?? 'none';
  }
  return 'none';
}

// ── verifyGezSignature ────────────────────────────────────────────────────────

/**
 * Verify the Ed25519 signature on a GEZ pack using the embedded public key.
 *
 * Returns:
 *   - `{ verified: true }` — valid signature
 *   - `{ verified: false, unsigned: true }` — no signature present
 *   - throws if signature is present but invalid
 *
 * Call AFTER parseGezPackage.
 */
export async function verifyGezSignature(
  payload: GezPayload,
): Promise<{ verified: boolean; unsigned?: boolean }> {
  if (!payload.signature || !payload.signerPublicKey) {
    return { verified: false, unsigned: true };
  }

  await sodium.ready;

  const payloadForVerification = JSON.stringify({
    ...payload,
    signature: '',
    signerPublicKey: payload.signerPublicKey,
  });
  const payloadBytes = new TextEncoder().encode(payloadForVerification);

  let sigBytes: Uint8Array;
  let pubKeyBytes: Uint8Array;
  try {
    sigBytes = new Uint8Array(Buffer.from(payload.signature, 'base64'));
    pubKeyBytes = new Uint8Array(Buffer.from(payload.signerPublicKey, 'base64'));
  } catch {
    throw new Error('GEZ signature or public key is not valid base64.');
  }

  if (sigBytes.length !== sodium.crypto_sign_BYTES) {
    throw new Error(`GEZ signature has wrong length (got ${sigBytes.length}, expected ${sodium.crypto_sign_BYTES}).`);
  }
  if (pubKeyBytes.length !== sodium.crypto_sign_PUBLICKEYBYTES) {
    throw new Error(`GEZ public key has wrong length (got ${pubKeyBytes.length}, expected ${sodium.crypto_sign_PUBLICKEYBYTES}).`);
  }

  const valid = sodium.crypto_sign_verify_detached(sigBytes, payloadBytes, pubKeyBytes);
  if (!valid) {
    throw new Error('GEZ signature verification failed — pack may have been tampered with.');
  }
  return { verified: true };
}
