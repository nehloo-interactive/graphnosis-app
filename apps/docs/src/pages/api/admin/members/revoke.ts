/**
 * POST /api/admin/members/revoke
 *
 * Immediately offboard a user: tombstone their email in KV so the next token
 * poll returns 410 Gone and the desktop clears its license cache.
 * Removes them from their group (if any) and deletes their token record.
 *
 * Auth: Authorization: Bearer <ADMIN_API_KEY>
 * Body: { email }
 *
 * To undo: call PATCH /api/admin/groups/:groupId with addMembers to re-add.
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../../server/env.js';
import { requireAdminAuth } from '../../../../server/admin-auth.js';
import {
  revokeEmail, getMember, getGroup, putGroup, deleteMember, writeAudit,
} from '../../../../server/groups.js';
import { deleteToken } from '../../../../server/kv.js';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ error: 'invalid_json' }, 400); }

  const email = (body.email as string | undefined)?.toLowerCase().trim();
  if (!email) return json({ error: 'missing email' }, 400);

  const kv = requireKv(env, 'BILLING_KV');

  // Remove from group if member
  const memberRec = await getMember(kv, email);
  if (memberRec) {
    const group = await getGroup(kv, memberRec.groupId);
    if (group) {
      group.members = group.members.filter(m => m.email !== email);
      group.updatedAt = Date.now();
      await putGroup(kv, group);
    }
    await deleteMember(kv, email);
  }

  await deleteToken(kv, email);
  await revokeEmail(kv, email);
  await writeAudit(kv, {
    ts: Date.now(), action: 'revoke', email,
    groupId: memberRec?.groupId,
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
  });

  return json({ ok: true, revoked: email });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
