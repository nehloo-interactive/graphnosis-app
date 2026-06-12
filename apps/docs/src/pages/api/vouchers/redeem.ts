/**
 * POST /api/vouchers/redeem
 *
 * Public endpoint — no admin auth required. Allows anyone with a valid voucher
 * code to claim a seat by providing their email address.
 *
 * Rate-limit: configure a Cloudflare rate-limit rule on /api/vouchers/redeem
 * (5 req/min per IP) in the Cloudflare dashboard.
 *
 * Body: { code, email, sendEmail? }
 * Returns: { ok: true, exp, plan, permanent } on success
 *          { error: 'not_found' | 'exhausted' | 'already_redeemed' } on failure
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../server/env.js';
import { mintAndNotify } from '../../../server/mint.js';
import { getVoucher, putVoucher, isRevoked, writeAudit } from '../../../server/groups.js';
import { getToken } from '../../../server/kv.js';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ error: 'invalid_json' }, 400); }

  const code  = (body.code as string | undefined)?.toUpperCase().trim();
  const email = (body.email as string | undefined)?.toLowerCase().trim();
  if (!code)  return json({ error: 'missing code' }, 400);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'invalid_email' }, 400);
  }

  const kv     = requireKv(env, 'BILLING_KV');
  const voucher = await getVoucher(kv, code);
  if (!voucher) return json({ error: 'not_found' }, 404);

  if (voucher.maxRedemptions > 0 && voucher.redemptionCount >= voucher.maxRedemptions) {
    return json({ error: 'exhausted', message: 'This voucher has no remaining redemptions.' }, 410);
  }

  // Don't re-issue if this email already has a valid token (prevent double-dipping).
  const existingToken = await getToken(kv, email);
  if (existingToken && existingToken.exp > Date.now() / 1000) {
    return json({ error: 'already_redeemed', message: 'This email already has an active token.' }, 409);
  }

  if (await isRevoked(kv, email)) {
    return json({ error: 'revoked' }, 403);
  }

  const sendEmail = body.sendEmail === true;
  const record = await mintAndNotify(env, kv, {
    email,
    plan:      voucher.plan,
    features:  voucher.features,
    ttlDays:   voucher.ttlDays,
    sendEmail,
  });

  // Increment usage counter
  voucher.redemptionCount += 1;
  await putVoucher(kv, voucher);

  await writeAudit(kv, {
    ts: Date.now(), action: 'voucher-redeem', email,
    adminNote: `code=${code}`,
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
  });

  return json({ ok: true, exp: record.exp, plan: voucher.plan, permanent: voucher.ttlDays === 0 });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
