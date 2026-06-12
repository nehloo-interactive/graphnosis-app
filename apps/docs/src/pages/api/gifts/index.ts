/**
 * POST /api/gifts
 *
 * Virality mechanic: allow an existing Pro/Teams subscriber to gift a free
 * 30-day Pro seat to a colleague. No admin key needed — authenticated by
 * the sender's own email + pollSecret (the key stored on their device).
 *
 * Body: { fromEmail, fromKey, toEmail }
 *
 * Limits:
 *   - Sender must have an active (unexpired) Pro or Teams token
 *   - Cap of GIFT_SEAT_CAP (2) gifts per account lifetime
 *   - Recipient must not already have an active token
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../server/env.js';
import { mintAndNotify } from '../../../server/mint.js';
import { getToken } from '../../../server/kv.js';
import { getGiftCount, incrementGiftCount, isRevoked, writeAudit, GIFT_SEAT_CAP } from '../../../server/groups.js';

export const prerender = false;

const GIFT_TTL_DAYS = 30;
const GIFT_FEATURES = ['skill-training', 'gnn-exploration', 'foresight', 'connector-cadence'];

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ error: 'invalid_json' }, 400); }

  const fromEmail = (body.fromEmail as string | undefined)?.toLowerCase().trim();
  const fromKey   = (body.fromKey   as string | undefined)?.trim();
  const toEmail   = (body.toEmail   as string | undefined)?.toLowerCase().trim();

  if (!fromEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail)) return json({ error: 'invalid_from_email' }, 400);
  if (!toEmail   || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(toEmail))   return json({ error: 'invalid_to_email' }, 400);
  if (fromEmail === toEmail) return json({ error: 'cannot_gift_to_self' }, 400);
  if (!fromKey) return json({ error: 'missing fromKey' }, 400);

  const kv = requireKv(env, 'BILLING_KV');

  // Validate sender token + pollSecret
  const senderRecord = await getToken(kv, fromEmail);
  if (!senderRecord || senderRecord.exp < Date.now() / 1000) {
    return json({ error: 'sender_no_active_token' }, 403);
  }
  if (!senderRecord.pollSecret || senderRecord.pollSecret !== fromKey) {
    return json({ error: 'invalid_from_key' }, 401);
  }
  // Require at least a Pro plan on the sender
  const senderPlan = senderRecord.plan ?? '';
  const isPro = senderPlan.includes('pro') || senderPlan.includes('team') || senderPlan.includes('comped');
  if (!isPro) return json({ error: 'sender_not_pro' }, 403);

  // Enforce gift cap
  const giftCount = await getGiftCount(kv, fromEmail);
  if (giftCount >= GIFT_SEAT_CAP) {
    return json({ error: 'gift_limit_reached', limit: GIFT_SEAT_CAP }, 429);
  }

  // Don't gift to someone already having a valid token
  const recipientRecord = await getToken(kv, toEmail);
  if (recipientRecord && recipientRecord.exp > Date.now() / 1000) {
    return json({ error: 'recipient_already_active' }, 409);
  }

  if (await isRevoked(kv, toEmail)) return json({ error: 'recipient_revoked' }, 403);

  const record = await mintAndNotify(env, kv, {
    email:      toEmail,
    plan:       'gifted',
    features:   GIFT_FEATURES,
    ttlDays:    GIFT_TTL_DAYS,
    sendEmail:  true,
    ownerEmail: fromEmail,
  });

  await incrementGiftCount(kv, fromEmail);
  await writeAudit(kv, {
    ts: Date.now(), action: 'gift', email: toEmail,
    adminNote: `from=${fromEmail}`,
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
  });

  const remaining = GIFT_SEAT_CAP - (giftCount + 1);
  return json({ ok: true, toEmail, exp: record.exp, giftsRemaining: remaining });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
