/**
 * POST /api/admin/members/extend
 *
 * Extend the token expiry for a seat without revoking and re-granting.
 * Re-mints the token with exp pushed forward by addDays, preserving the
 * pollSecret so the desktop picks it up silently on next poll.
 *
 * Auth: Authorization: Bearer <ADMIN_API_KEY>
 * Body: { email, addDays }
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../../server/env.js';
import { requireAdminAuth } from '../../../../server/admin-auth.js';
import { mintAndNotify } from '../../../../server/mint.js';
import { getToken } from '../../../../server/kv.js';
import { getMember, getGroup, writeAudit } from '../../../../server/groups.js';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ error: 'invalid_json' }, 400); }

  const email   = (body.email as string | undefined)?.toLowerCase().trim();
  const addDays = typeof body.addDays === 'number' ? body.addDays : 0;
  if (!email)        return json({ error: 'missing email' }, 400);
  if (addDays < 1)   return json({ error: 'addDays must be >= 1' }, 400);

  const kv = requireKv(env, 'BILLING_KV');

  // Get current token to extract plan + features
  const existing = await getToken(kv, email);
  if (!existing) return json({ error: 'no_token', message: 'No active token for this email.' }, 404);

  // Determine plan/features from group membership or existing token record
  const memberRec = await getMember(kv, email);
  const group     = memberRec ? await getGroup(kv, memberRec.groupId) : null;
  const plan      = existing.plan;
  const features  = group?.features ?? ['skill-training', 'gnn-exploration', 'foresight', 'connector-cadence', 'teams'];

  // Compute new TTL from current exp, extended by addDays
  const currentExpSecs  = existing.exp;
  const nowSecs         = Math.floor(Date.now() / 1000);
  const baseSecs        = Math.max(currentExpSecs, nowSecs);
  const newTtlDays      = Math.ceil((baseSecs - nowSecs) / 86400) + addDays;

  const record = await mintAndNotify(env, kv, { email, plan, features, ttlDays: newTtlDays, renews: false });
  await writeAudit(kv, {
    ts: Date.now(), action: 'extend', email, groupId: memberRec?.groupId,
    adminNote: `addDays=${addDays}`,
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
  });

  return json({ ok: true, email, exp: record.exp, plan });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
