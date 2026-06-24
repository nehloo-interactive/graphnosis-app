/**
 * POST /api/admin/groups
 *
 * Create a group subscription. Mints tokens for any initial members, writes
 * member backlinks, and optionally sends team-invite emails.
 *
 * Auth: Authorization: Bearer <ADMIN_API_KEY>
 *
 * Body (JSON):
 *   ownerEmail       string    — billing contact / admin for this group
 *   plan?            string    — plan slug (default: "comped-team")
 *   features?        string[]  — feature slugs (default: full Pro + teams)
 *   seatCount        number    — total seats in this group
 *   members?         string[]  — emails to provision immediately
 *   ttlDays?         number    — token TTL in days; 0 = permanent (default: 90)
 *   sendEmail?       boolean   — send invite emails to initial members (default: false)
 *   onboardingBundle? string   — optional bundle tag sent on first claim
 *
 * Returns: GroupRecord + adminSecret (shown once — store it!)
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../server/env.js';
import { requireAdminAuth } from '../../../server/admin-auth.js';
import { mintAndNotify } from '../../../server/mint.js';
import {
  putGroup, putMember, writeAudit, randomHex,
  type GroupRecord, type GroupMember,
} from '../../../server/groups.js';

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

  const ownerEmail = (body.ownerEmail as string | undefined)?.toLowerCase().trim();
  if (!ownerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
    return json({ error: 'invalid_owner_email' }, 400);
  }
  const seatCount = typeof body.seatCount === 'number' ? Math.floor(body.seatCount) : 0;
  if (seatCount < 1) return json({ error: 'seatCount must be >= 1' }, 400);

  const plan            = (body.plan as string | undefined)?.trim() || 'comped-team';
  const features        = Array.isArray(body.features) ? (body.features as string[]) : DEFAULT_FEATURES;
  const ttlDays         = typeof body.ttlDays === 'number' ? body.ttlDays : DEFAULT_TTL_DAYS;
  const sendEmail       = body.sendEmail === true;
  const onboardingBundle = body.onboardingBundle as string | undefined;
  const rawMembers      = Array.isArray(body.members) ? (body.members as string[]) : [];
  const memberEmails    = rawMembers.map(e => e.toLowerCase().trim()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

  if (memberEmails.length > seatCount) {
    return json({ error: 'members list exceeds seatCount' }, 400);
  }

  const kv = requireKv(env, 'BILLING_KV');
  const groupId     = crypto.randomUUID();
  const adminSecret = randomHex(24);
  const now         = Date.now();

  const members: GroupMember[] = [];
  const errors: string[] = [];

  for (const email of memberEmails) {
    try {
      await mintAndNotify(env, kv, { email, plan, features, ttlDays, sendEmail, ownerEmail });
      await putMember(kv, email, { groupId });
      members.push({ email });
      await writeAudit(kv, { ts: Date.now(), action: 'member-add', email, groupId });
    } catch (e) {
      errors.push(`${email}: ${(e as Error).message}`);
    }
  }

  const group: GroupRecord = {
    id: groupId,
    ownerEmail,
    plan,
    features,
    seatCount,
    members,
    adminSecret,
    createdAt: now,
    updatedAt: now,
    ttlDays,
    onboardingBundle,
  };
  await putGroup(kv, group);
  await writeAudit(kv, {
    ts: now,
    action: 'group-create',
    email: ownerEmail,
    groupId,
    adminNote: `seatCount=${seatCount} plan=${plan}`,
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
  });

  return json({ ...group, errors: errors.length ? errors : undefined });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
