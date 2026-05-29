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
 * The secret key arrives via the Cloudflare-bound BillingEnv and never leaves
 * the request context. libsodium-wrappers-sumo runs as WASM in Workers.
 */

import sodium from 'libsodium-wrappers-sumo';
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
}

let sodiumReady = false;

async function ensureReady(env: BillingEnv): Promise<Uint8Array> {
  if (!sodiumReady) {
    await sodium.ready;
    sodiumReady = true;
  }
  const hex = requireEnv(env, 'LICENSE_SIGNING_SECRET_KEY_HEX', 'REPLACE_ME_128_HEX_CHARS');
  // libsodium's Ed25519 secret-key (a.k.a. "private key") is 64 bytes:
  // the 32-byte seed concatenated with the 32-byte public key.
  const bytes = hexToBytes(hex);
  if (bytes.length !== sodium.crypto_sign_SECRETKEYBYTES) {
    throw new Error(
      `LICENSE_SIGNING_SECRET_KEY_HEX must encode exactly ${sodium.crypto_sign_SECRETKEYBYTES} bytes (got ${bytes.length}).`,
    );
  }
  return bytes;
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
): Promise<string> {
  const sk = await ensureReady(env);
  const now = Math.floor(Date.now() / 1000);
  const payload: LicensePayload = {
    sub: customer,
    plan,
    features,
    iat: now,
    exp: now + ttlDays * 24 * 60 * 60,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const signature = sodium.crypto_sign_detached(payloadBytes, sk);
  return `${bytesToBase64url(payloadBytes)}.${bytesToBase64url(signature)}`;
}

/**
 * Read the public key derived from the configured secret key. Useful for the
 * one-time setup step where the operator copies the public key into the
 * desktop sidecar's license-validator. Exposed at /api/billing/public-key.
 */
export async function getSigningPublicKeyHex(env: BillingEnv): Promise<string> {
  const sk = await ensureReady(env);
  // libsodium's Ed25519 secret key has the public key embedded in its
  // second half (bytes 32..64).
  const pk = sk.slice(32, 64);
  return bytesToHex(pk);
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
