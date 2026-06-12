/**
 * Shared mint-and-notify helper used by admin grant, group management,
 * voucher redemption, and the webhook flow.
 *
 * Centralises: mintLicenseToken → putToken → optional claim code + invite email.
 */

import type { KVNamespace } from '@cloudflare/workers-types';
import type { BillingEnv } from './env.js';
import { mintLicenseToken } from './sign.js';
import { putToken, putClaim, type TokenRecord } from './kv.js';
import { sendMagicLink, sendTeamInvite } from './email.js';
import { getBillingBaseUrl } from './stripe.js';
import { effectiveTtlDays } from './groups.js';

export interface MintOptions {
  email: string;
  plan: string;
  features: string[];
  /** Token lifetime in days. 0 = permanent (exp → year 2100). */
  ttlDays: number;
  /** Whether the subscription auto-renews. Pass false for comped/fixed-term seats. */
  renews?: boolean;
  /** If true, generate a claim code and send an activation email. */
  sendEmail?: boolean;
  /** Use the team-invite template (mentions ownerEmail) instead of the standard Pro template. */
  ownerEmail?: string;
}

/**
 * Mint a signed token for `email`, persist it in KV, and optionally send
 * an activation email. Returns the stored `TokenRecord`.
 */
export async function mintAndNotify(
  env: BillingEnv,
  kv: KVNamespace,
  opts: MintOptions,
): Promise<TokenRecord> {
  const { email, plan, features, ttlDays, renews = false, sendEmail = false, ownerEmail } = opts;
  const effectiveDays = effectiveTtlDays(ttlDays);
  const token = await mintLicenseToken(env, email, features, effectiveDays, plan, renews);

  // Decode exp from the freshly minted token to mirror into the KV record.
  const expSeconds = decodeExpFromToken(token);

  // Preserve existing pollSecret across re-mints so a live device's stored key stays valid.
  const { getToken } = await import('./kv.js');
  const existing = await getToken(kv, email);
  const pollSecret = existing?.pollSecret ?? randomSecret();

  const record: TokenRecord = { token, exp: expSeconds, updatedAt: Date.now(), plan, pollSecret };
  await putToken(kv, email, record);

  if (sendEmail) {
    const baseUrl = getBillingBaseUrl(env);
    const code = generateClaimCode();
    await putClaim(kv, code, { email, createdAt: Date.now() });
    const deepLink   = `graphnosis://claim?code=${encodeURIComponent(code)}`;
    const webFallback = `${baseUrl}/claim?code=${encodeURIComponent(code)}`;

    if (ownerEmail) {
      await sendTeamInvite(env, { to: email, ownerEmail, deepLink, webFallback });
    } else {
      await sendMagicLink(env, { to: email, deepLink, webFallback });
    }
  }

  return record;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function decodeExpFromToken(token: string): number {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return 0;
  const payloadB64 = token.slice(0, dot);
  const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - payloadB64.length % 4) % 4);
  try {
    const json = atob(padded);
    const obj = JSON.parse(json) as { exp?: number };
    return typeof obj.exp === 'number' ? obj.exp : 0;
  } catch { return 0; }
}

function generateClaimCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
