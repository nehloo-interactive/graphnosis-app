/**
 * GET|POST /api/groups/:groupId
 *
 * Owner self-service endpoint. Protected by the group's adminSecret
 * (passed as ?secret=… query param), NOT the admin API key.
 *
 * GET ?secret=…  — return sanitised group info (member list, seat usage)
 * POST ?secret=… body: { add?: string[], remove?: string[], sendEmail? }
 *                — add/remove members (enforces seat cap)
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../server/env.js';
import { mintAndNotify } from '../../../server/mint.js';
import {
  getGroup, putGroup, putMember, deleteMember,
  revokeEmail, writeAudit, type GroupMember,
} from '../../../server/groups.js';
import { deleteToken } from '../../../server/kv.js';

export const prerender = false;

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const GET: APIRoute = async ({ locals, params, url }) => {
  const env = getEnv(locals);
  const kv  = requireKv(env, 'BILLING_KV');

  const group = await getGroup(kv, params.groupId ?? '');
  if (!group) return json({ error: 'not_found' }, 404);

  const secret = url.searchParams.get('secret') ?? '';
  if (!timingSafeEqual(secret, group.adminSecret)) return json({ error: 'unauthorized' }, 401);

  return json({
    id:          group.id,
    ownerEmail:  group.ownerEmail,
    plan:        group.plan,
    seatCount:   group.seatCount,
    seatsUsed:   group.members.length,
    members:     group.members.map(m => ({
      email:       m.email,
      activated:   !!m.activatedAt,
      activatedAt: m.activatedAt,
    })),
    createdAt:   group.createdAt,
    updatedAt:   group.updatedAt,
  });
};

export const POST: APIRoute = async ({ request, locals, params, url }) => {
  const env = getEnv(locals);
  const kv  = requireKv(env, 'BILLING_KV');

  const group = await getGroup(kv, params.groupId ?? '');
  if (!group) return json({ error: 'not_found' }, 404);

  const secret = url.searchParams.get('secret') ?? '';
  if (!timingSafeEqual(secret, group.adminSecret)) return json({ error: 'unauthorized' }, 401);

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ error: 'invalid_json' }, 400); }

  const addRaw    = Array.isArray(body.add)    ? (body.add    as string[]) : [];
  const removeRaw = Array.isArray(body.remove) ? (body.remove as string[]) : [];
  const addEmails    = addRaw.map(e => e.toLowerCase().trim()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const removeEmails = removeRaw.map(e => e.toLowerCase().trim()).filter(Boolean);
  const sendEmail    = body.sendEmail === true;
  const ttlDays      = group.ttlDays ?? 90;

  const errors: string[] = [];

  for (const email of removeEmails) {
    group.members = group.members.filter(m => m.email !== email);
    await deleteMember(kv, email);
    await deleteToken(kv, email);
    await revokeEmail(kv, email);
    await writeAudit(kv, { ts: Date.now(), action: 'member-remove', email, groupId: group.id });
  }

  for (const email of addEmails) {
    if (group.members.length >= group.seatCount) {
      errors.push(`${email}: seat limit reached (${group.seatCount})`);
      continue;
    }
    if (group.members.some(m => m.email === email)) continue;
    try {
      await mintAndNotify(env, kv, {
        email, plan: group.plan, features: group.features, ttlDays, sendEmail,
        ownerEmail: group.ownerEmail,
      });
      await putMember(kv, email, { groupId: group.id });
      const member: GroupMember = { email };
      group.members.push(member);
      await writeAudit(kv, { ts: Date.now(), action: 'member-add', email, groupId: group.id });
    } catch (e) {
      errors.push(`${email}: ${(e as Error).message}`);
    }
  }

  group.updatedAt = Date.now();
  await putGroup(kv, group);
  return json({ seatsUsed: group.members.length, seatCount: group.seatCount, errors: errors.length ? errors : undefined });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
