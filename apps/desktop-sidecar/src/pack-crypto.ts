/**
 * Pack crypto v2 — shared encryption framing for `.gez` and `.gsk` packs.
 *
 * v1 packs (`GEZ1` / `GSK1`) encrypt the JSON payload under a FIXED key hardcoded
 * in the open-source bundle — obfuscation only; the real integrity guarantee is
 * the per-pack Ed25519 signature in the payload. v2 packs (`GEZ2` / `GSK2`) add
 * RECIPIENT-CONTROLLED confidentiality: the payload is encrypted under a per-pack
 * RANDOM 32-byte content key (CEK), and that CEK is itself wrapped in a small
 * cleartext key envelope according to an encryption mode:
 *
 *   encMode 0 (none)       — CEK = the fixed obfuscation key (v2 framing, "treat
 *                            as public"; exists only so the header path is uniform).
 *   encMode 1 (passphrase) — CEK = Argon2id(passphrase, salt). Salt + Argon2id
 *                            params travel in the cleartext envelope so any holder
 *                            of the passphrase can re-derive. Best for air-gap /
 *                            physical media (passphrase shared out-of-band).
 *   encMode 2 (recipient)  — CEK is sealed to one or more X25519 public keys via
 *                            `crypto_box_seal`. Only the holder of the matching
 *                            X25519 secret key opens it. Multiple recipients each
 *                            get a sealed copy of the same CEK.
 *
 * Confidentiality (CEK envelope) and authenticity (Ed25519 signature) are
 * ORTHOGONAL layers: the signature still covers the JSON payload exactly as in
 * v1, so a recipient-encrypted pack is still verifiable. Recipient X25519 keys are
 * DERIVED from the cortex's existing Ed25519 pack-signing key
 * (`crypto_sign_ed25519_*_to_curve25519`), so "verified signer" == "sealed-to
 * recipient" — no new keystore.
 *
 * v2 wire format (after the 4-byte magic):
 *   [1-byte encMode]
 *   [4-byte big-endian envelopeLen][envelopeLen-byte UTF-8 JSON KeyEnvelope]
 *   [12-byte IV][16-byte authTag][N-byte ciphertext]   (AES-256-GCM under CEK)
 *
 * All primitives are already in the bundled `libsodium-wrappers-sumo` — no new
 * dependency.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import sodium from 'libsodium-wrappers-sumo';

// ── Types ──────────────────────────────────────────────────────────────────────

export type EncMode = 'none' | 'passphrase' | 'recipient';

/** Numeric on-wire encoding of the encryption mode (1 byte after the magic). */
const ENC_MODE_BYTE: Record<EncMode, number> = { none: 0, passphrase: 1, recipient: 2 };
const ENC_MODE_FROM_BYTE: Record<number, EncMode> = { 0: 'none', 1: 'passphrase', 2: 'recipient' };

/** Cleartext key envelope, JSON-serialized into the v2 frame. */
export type KeyEnvelope =
  | { mode: 'none' }
  | {
      mode: 'passphrase';
      kdf: 'argon2id';
      /** Base64 Argon2id salt. */
      saltB64: string;
      /** libsodium opslimit used to derive the CEK. */
      opslimit: number;
      /** libsodium memlimit used to derive the CEK. */
      memlimit: number;
    }
  | {
      mode: 'recipient';
      /** One sealed copy of the CEK per recipient X25519 public key. */
      recipients: Array<{ label?: string; sealedCekB64: string }>;
    };

/** Encryption option accepted by the v2 builders. */
export type EncryptForOption =
  | { passphrase: string }
  | { recipientPubKeys: string[] };

/** Decryption option accepted by the v2 parsers. */
export interface DecryptOptions {
  /** Passphrase for an encMode='passphrase' pack. */
  passphrase?: string;
  /** Base64 X25519 secret key for an encMode='recipient' pack. */
  recipientSecretKeyB64?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const IV_LEN = 12;
const TAG_LEN = 16;
const CEK_LEN = 32; // AES-256

// ── Recipient-key derivation (X25519 from Ed25519) ──────────────────────────────

/**
 * Convert an Ed25519 signing key pair into the matching X25519 recipient key
 * pair via `crypto_sign_ed25519_*_to_curve25519`. The caller passes the cortex's
 * existing 64-byte Ed25519 secret key (hex) — the same key used to SIGN packs —
 * so the published recipient public key is bound to the verified signer identity.
 *
 * Returns base64 X25519 public + secret keys.
 */
export async function ed25519ToCurveKeypairB64(
  ed25519SecretKeyHex: string,
): Promise<{ publicKeyB64: string; secretKeyB64: string }> {
  await sodium.ready;
  const edSk = new Uint8Array(Buffer.from(ed25519SecretKeyHex, 'hex'));
  if (edSk.length !== 64) {
    throw new Error(`Ed25519 secret key has wrong length (got ${edSk.length}, expected 64).`);
  }
  const edPk = edSk.subarray(32); // public key = last 32 bytes in libsodium's combined format
  const curveSk = sodium.crypto_sign_ed25519_sk_to_curve25519(edSk);
  const curvePk = sodium.crypto_sign_ed25519_pk_to_curve25519(edPk);
  return {
    publicKeyB64: Buffer.from(curvePk).toString('base64'),
    secretKeyB64: Buffer.from(curveSk).toString('base64'),
  };
}

/** Just the X25519 recipient PUBLIC key (base64) derived from an Ed25519 secret. */
export async function recipientPublicKeyB64FromEd25519(
  ed25519SecretKeyHex: string,
): Promise<string> {
  return (await ed25519ToCurveKeypairB64(ed25519SecretKeyHex)).publicKeyB64;
}

// ── CEK derivation per mode ─────────────────────────────────────────────────────

/** Build a key envelope + CEK for the chosen encryption mode. */
async function deriveCekForEncrypt(
  fixedKey: Buffer,
  encrypt: EncryptForOption | undefined,
): Promise<{ mode: EncMode; envelope: KeyEnvelope; cek: Buffer }> {
  await sodium.ready;

  if (!encrypt) {
    return { mode: 'none', envelope: { mode: 'none' }, cek: fixedKey };
  }

  if ('passphrase' in encrypt) {
    if (!encrypt.passphrase) throw new Error('Passphrase encryption requested but passphrase is empty.');
    const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
    const opslimit = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE;
    const memlimit = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE;
    const cek = sodium.crypto_pwhash(
      CEK_LEN,
      encrypt.passphrase,
      salt,
      opslimit,
      memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    return {
      mode: 'passphrase',
      envelope: {
        mode: 'passphrase',
        kdf: 'argon2id',
        saltB64: Buffer.from(salt).toString('base64'),
        opslimit,
        memlimit,
      },
      cek: Buffer.from(cek),
    };
  }

  // recipient mode
  if (!encrypt.recipientPubKeys?.length) {
    throw new Error('Recipient encryption requested but no recipient public keys were provided.');
  }
  const cek = randomBytes(CEK_LEN);
  const recipients = encrypt.recipientPubKeys.map((pkB64) => {
    const pk = new Uint8Array(Buffer.from(pkB64, 'base64'));
    if (pk.length !== sodium.crypto_box_PUBLICKEYBYTES) {
      throw new Error(
        `Recipient public key has wrong length (got ${pk.length}, expected ${sodium.crypto_box_PUBLICKEYBYTES}).`,
      );
    }
    const sealed = sodium.crypto_box_seal(new Uint8Array(cek), pk);
    return { sealedCekB64: Buffer.from(sealed).toString('base64') };
  });
  return { mode: 'recipient', envelope: { mode: 'recipient', recipients }, cek };
}

/** Recover the CEK from a key envelope on the decrypt path. */
async function recoverCekForDecrypt(
  fixedKey: Buffer,
  envelope: KeyEnvelope,
  opts: DecryptOptions,
): Promise<Buffer> {
  await sodium.ready;

  if (envelope.mode === 'none') return fixedKey;

  if (envelope.mode === 'passphrase') {
    if (!opts.passphrase) {
      throw new Error('This pack is passphrase-encrypted — a passphrase is required to decrypt it.');
    }
    const salt = new Uint8Array(Buffer.from(envelope.saltB64, 'base64'));
    const cek = sodium.crypto_pwhash(
      CEK_LEN,
      opts.passphrase,
      salt,
      envelope.opslimit,
      envelope.memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    return Buffer.from(cek);
  }

  // recipient mode
  if (!opts.recipientSecretKeyB64) {
    throw new Error('This pack is recipient-encrypted — your recipient secret key is required to decrypt it.');
  }
  const curveSk = new Uint8Array(Buffer.from(opts.recipientSecretKeyB64, 'base64'));
  if (curveSk.length !== sodium.crypto_box_SECRETKEYBYTES) {
    throw new Error(
      `Recipient secret key has wrong length (got ${curveSk.length}, expected ${sodium.crypto_box_SECRETKEYBYTES}).`,
    );
  }
  // Need the matching public key for crypto_box_seal_open.
  const curvePk = sodium.crypto_scalarmult_base(curveSk);
  for (const r of envelope.recipients) {
    const sealed = new Uint8Array(Buffer.from(r.sealedCekB64, 'base64'));
    try {
      // crypto_box_seal_open THROWS (not returns null) when this sealed copy
      // was not sealed to our key — try the next recipient slot.
      const opened = sodium.crypto_box_seal_open(sealed, curvePk, curveSk);
      if (opened && opened.length === CEK_LEN) return Buffer.from(opened);
    } catch {
      // not our sealed copy — keep trying
    }
  }
  throw new Error('None of this pack\'s sealed keys could be opened with your recipient key.');
}

// ── v2 encode / decode ──────────────────────────────────────────────────────────

/**
 * Encrypt a JSON string into a v2 pack body (everything AFTER the 4-byte magic).
 * The caller prepends the appropriate magic (`GEZ2` / `GSK2`).
 */
export async function encodePackV2Body(
  json: string,
  fixedKey: Buffer,
  encrypt?: EncryptForOption,
): Promise<Buffer> {
  const { mode, envelope, cek } = await deriveCekForEncrypt(fixedKey, encrypt);

  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelopeJson = Buffer.from(JSON.stringify(envelope), 'utf8');
  const envelopeLen = Buffer.alloc(4);
  envelopeLen.writeUInt32BE(envelopeJson.length, 0);

  return Buffer.concat([
    Buffer.from([ENC_MODE_BYTE[mode]]),
    envelopeLen,
    envelopeJson,
    iv,
    authTag,
    ciphertext,
  ]);
}

/**
 * Decrypt a v2 pack body (everything AFTER the 4-byte magic) back to its JSON
 * string. Returns the JSON plus the detected encMode for provenance display.
 * Throws on a missing key, a wrong passphrase/recipient key (AEAD failure), or a
 * tampered ciphertext (AEAD failure).
 */
export async function decodePackV2Body(
  body: Buffer,
  fixedKey: Buffer,
  opts: DecryptOptions = {},
): Promise<{ json: string; encMode: EncMode }> {
  if (body.length < 1 + 4) {
    throw new Error('Pack v2 body is too short to contain a key envelope.');
  }
  const modeByte = body.readUInt8(0);
  const encMode = ENC_MODE_FROM_BYTE[modeByte];
  if (!encMode) throw new Error(`Pack v2 has an unknown encryption mode byte (${modeByte}).`);

  const envelopeLen = body.readUInt32BE(1);
  const envelopeStart = 5;
  const envelopeEnd = envelopeStart + envelopeLen;
  if (body.length < envelopeEnd + IV_LEN + TAG_LEN) {
    throw new Error('Pack v2 body is truncated (envelope/IV/tag region incomplete).');
  }

  let envelope: KeyEnvelope;
  try {
    envelope = JSON.parse(body.subarray(envelopeStart, envelopeEnd).toString('utf8')) as KeyEnvelope;
  } catch {
    throw new Error('Pack v2 key envelope is not valid JSON.');
  }

  const iv = body.subarray(envelopeEnd, envelopeEnd + IV_LEN);
  const authTag = body.subarray(envelopeEnd + IV_LEN, envelopeEnd + IV_LEN + TAG_LEN);
  const ciphertext = body.subarray(envelopeEnd + IV_LEN + TAG_LEN);

  const cek = await recoverCekForDecrypt(fixedKey, envelope, opts);

  const decipher = createDecipheriv('aes-256-gcm', cek, iv);
  decipher.setAuthTag(authTag);
  let json: string;
  try {
    json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Pack decryption failed — wrong passphrase/recipient key, or the pack was tampered with.');
  }
  return { json, encMode };
}

/** Read just the encMode byte from a v2 body (provenance display, no key needed). */
export function peekEncMode(body: Buffer): EncMode | undefined {
  if (body.length < 1) return undefined;
  return ENC_MODE_FROM_BYTE[body.readUInt8(0)];
}
