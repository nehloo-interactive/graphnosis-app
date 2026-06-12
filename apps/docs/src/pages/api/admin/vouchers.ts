/**
 * POST|GET /api/admin/vouchers
 *
 * Create and inspect batch voucher codes for non-Stripe gifting at scale
 * (conferences, beta programs, partner portals).
 *
 * Auth: Authorization: Bearer <ADMIN_API_KEY>
 *
 * POST body: { code, plan?, features?, ttlDays, maxRedemptions? }
 * GET  ?code=GRAPHNOSIS-LAUNCH — inspect usage count
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../server/env.js';
import { requireAdminAuth } from '../../../server/admin-auth.js';
import { putVoucher, getVoucher, type VoucherRecord } from '../../../server/groups.js';

export const prerender = false;

const DEFAULT_FEATURES = ['skill-training', 'gnn-exploration', 'foresight', 'connector-cadence', 'teams'];

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ error: 'invalid_json' }, 400); }

  const code = (body.code as string | undefined)?.toUpperCase().trim();
  if (!code || code.length < 3) return json({ error: 'invalid_code' }, 400);

  const ttlDays = typeof body.ttlDays === 'number' ? body.ttlDays : 30;
  const kv      = requireKv(env, 'BILLING_KV');

  // Don't overwrite an existing voucher silently
  const existing = await getVoucher(kv, code);
  if (existing) return json({ error: 'code_exists', redemptionCount: existing.redemptionCount }, 409);

  const rec: VoucherRecord = {
    code,
    plan:             (body.plan as string | undefined)?.trim() || 'voucher',
    features:         Array.isArray(body.features) ? (body.features as string[]) : DEFAULT_FEATURES,
    ttlDays,
    maxRedemptions:   typeof body.maxRedemptions === 'number' ? body.maxRedemptions : 0,
    redemptionCount:  0,
    createdAt:        Date.now(),
  };
  await putVoucher(kv, rec);
  return json(rec, 201);
};

export const GET: APIRoute = async ({ request, locals, url }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  const code = url.searchParams.get('code')?.toUpperCase().trim();
  if (!code) return json({ error: 'missing code query param' }, 400);

  const kv  = requireKv(env, 'BILLING_KV');
  const rec = await getVoucher(kv, code);
  if (!rec) return json({ error: 'not_found' }, 404);
  return json(rec);
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
