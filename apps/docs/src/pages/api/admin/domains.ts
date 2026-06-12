/**
 * POST|GET|DELETE /api/admin/domains
 *
 * Manage the domain allowlist. Each domain entry is backed by a GroupRecord
 * that tracks seat usage. Anyone from an allowlisted domain who polls for a
 * token gets one auto-minted (up to the seat cap).
 *
 * Auth: Authorization: Bearer <ADMIN_API_KEY>
 *
 * POST  body: { domain, seatCount, plan?, features?, ttlDays? }
 * GET   ?domain=company.com  — returns DomainRecord + linked GroupRecord
 * DELETE ?domain=company.com  — removes domain record (existing tokens stay valid)
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../server/env.js';
import { requireAdminAuth } from '../../../server/admin-auth.js';
import {
  putDomain, getDomain, deleteDomain,
  putGroup, getGroup, randomHex,
  writeAudit,
  type DomainRecord, type GroupRecord,
} from '../../../server/groups.js';

export const prerender = false;

const DEFAULT_FEATURES = ['skill-training', 'gnn-exploration', 'foresight', 'connector-cadence', 'teams'];
const DEFAULT_TTL_DAYS = 30;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; }
  catch { return json({ error: 'invalid_json' }, 400); }

  const domain = (body.domain as string | undefined)?.toLowerCase().trim();
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return json({ error: 'invalid_domain' }, 400);
  }
  const seatCount = typeof body.seatCount === 'number' ? Math.floor(body.seatCount) : 0;
  if (seatCount < 1) return json({ error: 'seatCount must be >= 1' }, 400);

  const plan     = (body.plan as string | undefined)?.trim() || 'domain-comped';
  const features = Array.isArray(body.features) ? (body.features as string[]) : DEFAULT_FEATURES;
  const ttlDays  = typeof body.ttlDays === 'number' ? body.ttlDays : DEFAULT_TTL_DAYS;

  const kv      = requireKv(env, 'BILLING_KV');
  const groupId = crypto.randomUUID();
  const now     = Date.now();

  const group: GroupRecord = {
    id: groupId,
    ownerEmail: `(domain:${domain})`,
    plan,
    features,
    seatCount,
    members: [],
    adminSecret: randomHex(24),
    createdAt: now,
    updatedAt: now,
    ttlDays,
  };
  await putGroup(kv, group);

  const domainRec: DomainRecord = {
    domain,
    groupId,
    plan,
    features,
    ttlDays,
    createdAt: now,
  };
  await putDomain(kv, domainRec);
  await writeAudit(kv, {
    ts: now, action: 'grant', email: `*@${domain}`, groupId,
    adminNote: `domain allowlist seatCount=${seatCount}`,
    ip: request.headers.get('cf-connecting-ip') ?? undefined,
  });

  return json({ domain: domainRec, group });
};

export const GET: APIRoute = async ({ request, locals, url }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  const domain = url.searchParams.get('domain')?.toLowerCase().trim();
  if (!domain) return json({ error: 'missing domain query param' }, 400);

  const kv     = requireKv(env, 'BILLING_KV');
  const rec    = await getDomain(kv, domain);
  if (!rec) return json({ error: 'not_found' }, 404);
  const group = await getGroup(kv, rec.groupId);

  return json({
    domain: rec,
    group,
    seatsUsed: group?.members.length ?? 0,
    seatsTotal: group?.seatCount ?? 0,
  });
};

export const DELETE: APIRoute = async ({ request, locals, url }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  const domain = url.searchParams.get('domain')?.toLowerCase().trim();
  if (!domain) return json({ error: 'missing domain query param' }, 400);

  const kv = requireKv(env, 'BILLING_KV');
  const rec = await getDomain(kv, domain);
  if (!rec) return json({ error: 'not_found' }, 404);

  await deleteDomain(kv, domain);
  return json({ ok: true, deleted: domain });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
