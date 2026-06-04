/**
 * GET /api/subscription/token?email=foo@bar.com
 *
 * The desktop's "status poll on unlock" endpoint. Returns the current signed
 * license token for an email, or 204 No Content if none exists.
 *
 * Auth model: email + a per-subscription `key` (the poll secret). The signed
 * token is replayable — anyone who *holds* it gets the entitlement — so we must
 * not hand it to anyone who merely knows the email. The poll secret is minted
 * with the token, delivered once via the claim deep link, and stored by the
 * device. A caller without the matching key gets 204 (indistinguishable from
 * "no subscription") so the endpoint also doesn't confirm whether an email is a
 * customer. Legacy records minted before the secret existed return 204 too,
 * forcing a fresh claim — fail closed.
 *
 * We additionally rate-limit naively per-isolate (one call per email per 2s).
 * On Cloudflare Workers each colo runs its own isolate, so this is a soft cap;
 * harden with KV-based rate limits before scaling.
 */

import type { APIRoute } from 'astro';
import { getToken } from '../../../server/kv.js';
import { getEnv, requireKv } from '../../../server/env.js';

export const prerender = false;

const lastPolledAt = new Map<string, number>();
const MIN_INTERVAL_MS = 2000;

export const GET: APIRoute = async ({ url, locals }) => {
  const email = url.searchParams.get('email')?.toLowerCase().trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'invalid_email' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const now = Date.now();
  const prev = lastPolledAt.get(email) ?? 0;
  if (now - prev < MIN_INTERVAL_MS) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  lastPolledAt.set(email, now);

  const env = getEnv(locals);
  const kv = requireKv(env, 'BILLING_KV');
  const rec = await getToken(kv, email);
  if (!rec) {
    return new Response(null, { status: 204 });
  }
  // Require the poll secret. Missing/mismatched key, or a legacy record with no
  // secret, all return 204 — never reveal the token to an unauthenticated
  // caller, and never confirm the email is a customer. Constant-time-ish compare.
  const key = url.searchParams.get('key') ?? '';
  if (!rec.pollSecret || !timingSafeEqual(key, rec.pollSecret)) {
    return new Response(null, { status: 204 });
  }
  return new Response(
    JSON.stringify({ token: rec.token, exp: rec.exp, plan: rec.plan, updatedAt: rec.updatedAt }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

/** Length-independent constant-time string compare (avoids leaking the secret
 *  via response-timing). Returns false fast only on the cheap length check. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
