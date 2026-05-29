/**
 * Cloudflare KV-backed billing state.
 *
 * Two logical maps stored under the same KV namespace (`BILLING_KV`):
 *
 *   - claim:{code}    →  ClaimRecord JSON
 *                        One-time codes minted on Stripe Checkout success
 *                        that turn into graphnosis://claim deep links.
 *                        Marked consumed (deleted) on first claim.
 *
 *   - token:{email}   →  TokenRecord JSON
 *                        Current signed Ed25519 license token per customer,
 *                        refreshed on every Stripe subscription event.
 *
 * KV is eventually consistent (~60s globally), which is fine for both
 * cases — claim codes are scoped to one device + read within seconds of
 * write; tokens are read on cortex unlock and re-fetched periodically.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

export interface ClaimRecord {
  email: string;
  subscriptionId?: string;
  createdAt: number;
}

export interface TokenRecord {
  token: string;
  exp: number;
  updatedAt: number;
  plan: string;
}

const CLAIM_TTL_SECONDS = 30 * 60;        // 30 min — magic-link claim window
const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days — longer than token exp

// ── Claims ────────────────────────────────────────────────────────────────────

export async function putClaim(kv: KVNamespace, code: string, rec: ClaimRecord): Promise<void> {
  await kv.put(`claim:${code}`, JSON.stringify(rec), {
    expirationTtl: CLAIM_TTL_SECONDS,
  });
}

/**
 * Consume a claim code: read and delete in one logical op. KV doesn't have
 * atomic compare-and-delete, but the window between read and delete is
 * <100ms; a race here would only matter if the same code were claimed
 * twice concurrently from two devices, which is implausible UX.
 */
export async function takeClaim(kv: KVNamespace, code: string): Promise<ClaimRecord | null> {
  const raw = await kv.get(`claim:${code}`);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as ClaimRecord;
    await kv.delete(`claim:${code}`);
    return rec;
  } catch {
    return null;
  }
}

// ── Tokens ────────────────────────────────────────────────────────────────────

export async function putToken(kv: KVNamespace, email: string, rec: TokenRecord): Promise<void> {
  await kv.put(`token:${email.toLowerCase()}`, JSON.stringify(rec), {
    expirationTtl: TOKEN_TTL_SECONDS,
  });
}

export async function getToken(kv: KVNamespace, email: string): Promise<TokenRecord | null> {
  const raw = await kv.get(`token:${email.toLowerCase()}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenRecord;
  } catch {
    return null;
  }
}

export async function deleteToken(kv: KVNamespace, email: string): Promise<void> {
  await kv.delete(`token:${email.toLowerCase()}`);
}
