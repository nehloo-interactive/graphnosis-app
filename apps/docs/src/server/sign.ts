/**
 * Ed25519 license-token minting — server-side counterpart to the desktop's
 * LicenseValidator (apps/desktop-sidecar/src/license-validator.ts).
 *
 * The token wire format MUST stay byte-for-byte identical to what the
 * validator expects:
 *
 *   <base64url(UTF-8 JSON payload)>.<base64url(64-byte Ed25519 signature)>
 *
 * Payload (JSON):
 *   { sub, plan, features, iat, exp }
 *
 * The Ed25519 signature is over the **raw UTF-8 bytes** of the JSON payload —
 * NOT the base64url-encoded string. The validator decodes the base64url first,
 * then verifies the signature against the resulting bytes.
 *
 * Signing uses the native Web Crypto API (`crypto.subtle`), which is available
 * in Cloudflare Workers without any WASM dependency. The secret key is stored
 * as a 128-hex-char string (64 raw bytes in libsodium format: 32-byte seed
 * followed by 32-byte public key). We import only the 32-byte seed, wrapping
 * it in the fixed PKCS#8 DER header required by Web Crypto's Ed25519 import.
 * Existing keys generated with libsodium are fully compatible — no rotation
 * needed.
 */

import type { BillingEnv } from './env.js';
import { requireEnv } from './env.js';

export interface LicensePayload {
  /** User identifier — we use the customer's email. */
  sub: string;
  /** Subscription plan slug, e.g. "monthly-subscription". */
  plan: string;
  /** Feature keys this token unlocks. */
  features: string[];
  /** Issued-at, Unix seconds. */
  iat: number;
  /** Expiry, Unix seconds. */
  exp: number;
  /** True when the subscription will auto-renew at `exp`; false when it has
   *  been set to cancel at period end (so `exp` is a hard expiry, not a
   *  renewal). Drives the "Renews" vs "Expires" label in the desktop. Older
   *  tokens minted before this field default to renewing. */
  renews?: boolean;
}

// Fixed 16-byte PKCS#8 DER prefix for a bare 32-byte Ed25519 seed.
// RFC 8410 OID 1.3.101.112, version 0, no attributes.
const PKCS8_ED25519_PREFIX = new Uint8Array([
  0x30, 0x2e,             // SEQUENCE, 46 bytes
  0x02, 0x01, 0x00,       // INTEGER 0 (version)
  0x30, 0x05,             // SEQUENCE, 5 bytes (AlgorithmIdentifier)
    0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112
  0x04, 0x22,             // OCTET STRING, 34 bytes (PrivateKey wrapper)
    0x04, 0x20,           // OCTET STRING, 32 bytes (the seed)
]);

let cachedSigningKey: CryptoKey | null = null;

async function getSigningKey(env: BillingEnv): Promise<CryptoKey> {
  if (cachedSigningKey) return cachedSigningKey;
  const hex = requireEnv(env, 'LICENSE_SIGNING_SECRET_KEY_HEX', 'REPLACE_ME_128_HEX_CHARS');
  const keyBytes = hexToBytes(hex);
  if (keyBytes.length !== 64) {
    throw new Error(
      `LICENSE_SIGNING_SECRET_KEY_HEX must encode exactly 64 bytes (got ${keyBytes.length}).`,
    );
  }
  // Bytes 0–31 are the seed; bytes 32–63 are the public key (libsodium layout).
  const seed = keyBytes.subarray(0, 32);
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  cachedSigningKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  return cachedSigningKey;
}

/**
 * Mint a signed license token for `customer`.
 *
 * @param env       The Cloudflare-bound env carrying the signing secret.
 * @param customer  Stable user identifier — Stripe customer email is best so
 *                  the validator's `sub` matches what the desktop knows.
 * @param features  Feature slugs to unlock, e.g. ["skill-training"].
 * @param ttlDays   How long the token stays valid. Default 35 days — a touch
 *                  longer than the monthly subscription cycle so a brief
 *                  Stripe-side hiccup doesn't lock the user out mid-month.
 * @param plan      Subscription plan slug. Defaults to "monthly-subscription".
 */
export async function mintLicenseToken(
  env: BillingEnv,
  customer: string,
  features: string[],
  ttlDays = 35,
  plan = 'monthly-subscription',
  renews = true,
): Promise<string> {
  const signingKey = await getSigningKey(env);
  const now = Math.floor(Date.now() / 1000);
  const payload: LicensePayload = {
    sub: customer,
    plan,
    features,
    iat: now,
    exp: now + ttlDays * 24 * 60 * 60,
    renews,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const signatureBuffer = await crypto.subtle.sign('Ed25519', signingKey, payloadBytes);
  const signature = new Uint8Array(signatureBuffer);
  return `${bytesToBase64url(payloadBytes)}.${bytesToBase64url(signature)}`;
}

/**
 * Read the public key derived from the configured secret key. Useful for the
 * one-time setup step where the operator copies the public key into the
 * desktop sidecar's license-validator. Exposed at /api/billing/public-key.
 */
export async function getSigningPublicKeyHex(env: BillingEnv): Promise<string> {
  const hex = requireEnv(env, 'LICENSE_SIGNING_SECRET_KEY_HEX', 'REPLACE_ME_128_HEX_CHARS');
  const keyBytes = hexToBytes(hex);
  if (keyBytes.length !== 64) {
    throw new Error(
      `LICENSE_SIGNING_SECRET_KEY_HEX must encode exactly 64 bytes (got ${keyBytes.length}).`,
    );
  }
  // Bytes 32–63 are the public key in libsodium layout.
  return bytesToHex(keyBytes.subarray(32, 64));
}

// ── Base64url + hex codecs (Worker-safe — no Buffer) ──────────────────────────

function bytesToBase64url(bytes: Uint8Array): string {
  // btoa is available in Workers. Chunk to avoid call-stack overflow on
  // very long byte arrays (apply has a limit). 16 KB is well below it.
  const CHUNK = 16 * 1024;
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error('LICENSE_SIGNING_SECRET_KEY_HEX must be an even-length hex string.');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
