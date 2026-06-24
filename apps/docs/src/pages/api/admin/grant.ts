/**
 * POST /api/admin/grant
 *
 * Comp or gift a single seat directly — no Stripe required. Mints a signed
 * license token for the given email, stores it in KV, and optionally sends
 * an activation email.
 *
 * Auth: Authorization: Bearer <ADMIN_API_KEY>
 *
 * Body (JSON):
 *   email        string   — recipient email
 *   plan?        string   — plan slug (default: "comped")
 *   features?    string[] — feature slugs (default: full Pro + teams)
 *   ttlDays?     number   — token lifetime in days; 0 = permanent (default: 90)
 *   sendEmail?   boolean  — send activation email via Resend (default: false)
 *
 * Returns: { ok: true, email, plan, exp, permanent }
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../server/env.js';
import { requireAdminAuth } from '../../../server/admin-auth.js';
import { mintAndNotify } from '../../../server/mint.js';
import { writeAudit } from '../../../server/groups.js';

export const prerender = false;

const DEFAULT_FEATURES = ['skill-training', 'gnn-exploration', 'foresight', 'connector-cadence', 'teams', 'memory-integrity'];
const DEFAULT_TTL_DAYS = 90;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ error: 'invalid_json' }, 400); }

  const email = (body.email as string | undefined)?.toLowerCase().trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'invalid_email' }, 400);
  }

  const plan     = (body.plan as string | undefined)?.trim() || 'comped';
  const features = Array.isArray(body.features) ? (body.features as string[]) : DEFAULT_FEATURES;
  const ttlDays  = typeof body.ttlDays === 'number' ? body.ttlDays : DEFAULT_TTL_DAYS;
  const sendEmail = body.sendEmail === true;

  const kv = requireKv(env, 'BILLING_KV');
  const record = await mintAndNotify(env, kv, { email, plan, features, ttlDays, sendEmail });

  await writeAudit(kv, {
    ts: Date.now(),
    action: 'grant',
    email,
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
    adminNote: `plan=${plan} ttlDays=${ttlDays}`,
  });

  return json({ ok: true, email, plan, exp: record.exp, permanent: ttlDays === 0 });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
