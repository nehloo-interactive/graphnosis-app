/**
 * GET /api/subscription/token?email=foo@bar.com
 *
 * The desktop's "status poll on unlock" endpoint. Returns the current signed
 * license token for an email, or 204 No Content if none exists.
 *
 * Auth model: this endpoint is intentionally email-only — no separate auth
 * token, no API key. Rationale:
 *
 *   • The returned token is itself signed and self-verifying; possession of
 *     the email is not enough to forge anything. The worst a passive attacker
 *     who learns the email can do is read the same token the customer has.
 *
 *   • The desktop holds the cortex passphrase, which it uses to encrypt the
 *     token at rest. An attacker who controls the desktop already has more
 *     than the email gives them.
 *
 * We rate-limit naively per-isolate (one call per email per 2s). On
 * Cloudflare Workers each colo runs its own isolate, so this is a soft cap
 * not a hard one; harden with KV-based rate limits before launching to a
 * hostile audience.
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
  return new Response(
    JSON.stringify({ token: rec.token, exp: rec.exp, plan: rec.plan, updatedAt: rec.updatedAt }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
