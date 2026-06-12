/**
 * GET|DELETE /api/admin/token
 *
 * Inspect or clear an individual token record in KV without revoking the
 * address. Useful when a stale token:email record blocks the domain-allowlist
 * OTP flow (e.g. a token was minted before poll-secret gating was added).
 *
 * GET  ?email=foo@bar.com  — returns the TokenRecord (sans the token value)
 * DELETE ?email=foo@bar.com — deletes token:email so the next poll re-enters
 *                             the domain-allowlist OTP flow
 *
 * Auth: Authorization: Bearer <ADMIN_API_KEY>
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../server/env.js';
import { requireAdminAuth } from '../../../server/admin-auth.js';
import { getToken, deleteToken } from '../../../server/kv.js';

export const prerender = false;

export const GET: APIRoute = async ({ url, request, locals }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  const email = url.searchParams.get('email')?.toLowerCase().trim();
  if (!email) return json({ error: 'missing email query param' }, 400);

  const kv = requireKv(env, 'BILLING_KV');
  const rec = await getToken(kv, email);
  if (!rec) return json({ found: false }, 200);

  return json({
    found: true,
    email,
    exp: rec.exp,
    plan: rec.plan,
    updatedAt: rec.updatedAt,
    hasPollSecret: !!rec.pollSecret,
  }, 200);
};

export const DELETE: APIRoute = async ({ url, request, locals }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  const email = url.searchParams.get('email')?.toLowerCase().trim();
  if (!email) return json({ error: 'missing email query param' }, 400);

  const kv = requireKv(env, 'BILLING_KV');
  const rec = await getToken(kv, email);
  if (!rec) return json({ ok: true, deleted: false, note: 'no token record found' }, 200);

  await deleteToken(kv, email);
  return json({ ok: true, deleted: true, email }, 200);
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
