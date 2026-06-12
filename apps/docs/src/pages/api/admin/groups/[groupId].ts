/**
 * GET|PATCH|DELETE /api/admin/groups/:groupId
 *
 * Auth: Authorization: Bearer <ADMIN_API_KEY>
 *
 * GET   — return GroupRecord
 * PATCH — add/remove members, update seatCount
 *   Body: { addMembers?, removeMembers?, seatCount?, ttlDays?, sendEmail? }
 * DELETE — dissolve group: remove all member tokens + backlinks, delete group record
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../../server/env.js';
import { requireAdminAuth } from '../../../../server/admin-auth.js';
import { mintAndNotify } from '../../../../server/mint.js';
import {
  getGroup, putGroup, deleteGroup,
  putMember, deleteMember,
  revokeEmail,
  writeAudit,
  type GroupMember,
} from '../../../../server/groups.js';
import { deleteToken } from '../../../../server/kv.js';

export const prerender = false;

export const GET: APIRoute = async ({ request, locals, params }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  const kv = requireKv(env, 'BILLING_KV');
  const group = await getGroup(kv, params.groupId ?? '');
  if (!group) return json({ error: 'not_found' }, 404);
  return json(group);
};

export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  const kv = requireKv(env, 'BILLING_KV');
  const group = await getGroup(kv, params.groupId ?? '');
  if (!group) return json({ error: 'not_found' }, 404);

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ error: 'invalid_json' }, 400); }

  const addRaw    = Array.isArray(body.addMembers)    ? (body.addMembers as string[])    : [];
  const removeRaw = Array.isArray(body.removeMembers) ? (body.removeMembers as string[]) : [];
  const addEmails    = addRaw.map(e => e.toLowerCase().trim()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const removeEmails = removeRaw.map(e => e.toLowerCase().trim()).filter(Boolean);

  if (typeof body.seatCount === 'number') group.seatCount = Math.floor(body.seatCount);
  if (typeof body.ttlDays   === 'number') group.ttlDays   = body.ttlDays;
  const sendEmail  = body.sendEmail === true;
  const ttlDays    = group.ttlDays ?? 90;

  // Remove members
  for (const email of removeEmails) {
    group.members = group.members.filter(m => m.email !== email);
    await deleteMember(kv, email);
    await deleteToken(kv, email);
    await revokeEmail(kv, email);
    await writeAudit(kv, { ts: Date.now(), action: 'member-remove', email, groupId: group.id,
      ip: request.headers.get('cf-connecting-ip') ?? undefined });
  }

  // Add members (respect seat cap)
  const errors: string[] = [];
  for (const email of addEmails) {
    if (group.members.length >= group.seatCount) {
      errors.push(`${email}: seat limit reached (${group.seatCount})`);
      continue;
    }
    if (group.members.some(m => m.email === email)) continue; // already a member
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
  return json({ ...group, errors: errors.length ? errors : undefined });
};

export const DELETE: APIRoute = async ({ request, locals, params }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  const kv = requireKv(env, 'BILLING_KV');
  const group = await getGroup(kv, params.groupId ?? '');
  if (!group) return json({ error: 'not_found' }, 404);

  for (const member of group.members) {
    await deleteMember(kv, member.email);
    await deleteToken(kv, member.email);
  }
  await deleteGroup(kv, group.id);
  await writeAudit(kv, {
    ts: Date.now(), action: 'group-delete', email: group.ownerEmail, groupId: group.id,
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
  });
  return json({ ok: true, deleted: group.id });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
