/**
 * GET /api/admin/debug-token?email=foo@bar.com
 *
 * Dry-run trace of the token endpoint logic for a given email.
 * Returns step-by-step diagnostics without writing anything to KV
 * or sending any email. Used to identify why a domain email isn't
 * triggering the OTP flow.
 *
 * Auth: Authorization: Bearer <ADMIN_API_KEY>
 */

import type { APIRoute } from 'astro';
import { getEnv, requireKv } from '../../../server/env.js';
import { requireAdminAuth } from '../../../server/admin-auth.js';
import { getToken } from '../../../server/kv.js';
import { getDomain, getGroup, isRevoked } from '../../../server/groups.js';

export const prerender = false;

export const GET: APIRoute = async ({ url, request, locals }) => {
  const env = getEnv(locals);
  const authError = requireAdminAuth(request, env);
  if (authError) return authError;

  const rawEmail = url.searchParams.get('email') ?? '';
  const email = rawEmail.toLowerCase().trim();
  const trace: Record<string, unknown> = { rawEmail, email };

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ ...trace, step: 'email_validation', result: 'FAIL: invalid email' });
  }
  trace.emailValid = true;

  const kv = requireKv(env, 'BILLING_KV');

  const revoked = await isRevoked(kv, email);
  trace.revoked = revoked;
  if (revoked) return json({ ...trace, step: 'revocation_check', result: 'FAIL: email is revoked (would return 410)' });

  const tokenRec = await getToken(kv, email);
  trace.hasToken = !!tokenRec;
  trace.tokenHasPollSecret = tokenRec ? !!tokenRec.pollSecret : null;
  trace.tokenPlan = tokenRec?.plan ?? null;
  trace.tokenExp = tokenRec?.exp ?? null;

  const domain = email.split('@')[1] ?? '';
  trace.domain = domain;

  const domainRec = domain ? await getDomain(kv, domain) : null;
  trace.domainFound = !!domainRec;
  if (domainRec) {
    trace.domainGroupId = domainRec.groupId;
    trace.domainPlan    = domainRec.plan;
    trace.domainTtlDays = domainRec.ttlDays;
    trace.domainFeatures = domainRec.features;
  }

  if (!domainRec) {
    return json({
      ...trace,
      step: 'domain_lookup',
      result: `FAIL: no domain record for "${domain}" — token endpoint would return 204`,
      kvKey: `domain:${domain}`,
    });
  }

  const group = await getGroup(kv, domainRec.groupId);
  trace.groupFound = !!group;
  if (group) {
    trace.groupSeatCount = group.seatCount;
    trace.groupMembersCount = group.members.length;
    trace.seatsAvailable = group.members.length < group.seatCount;
  }

  if (!group) {
    return json({
      ...trace,
      step: 'group_lookup',
      result: `FAIL: group ${domainRec.groupId} not found — token endpoint would silently return 204`,
    });
  }

  if (group.members.length >= group.seatCount) {
    return json({
      ...trace,
      step: 'seat_check',
      result: `FAIL: seat limit reached (${group.members.length}/${group.seatCount}) — would return 402`,
    });
  }

  if (!tokenRec) {
    return json({
      ...trace,
      step: 'otp_gate',
      result: 'OK: would send OTP and return 202 otp_required',
    });
  }

  if (!tokenRec.pollSecret) {
    return json({
      ...trace,
      step: 'stale_token_otp_fallback',
      result: 'OK (stale token, no pollSecret): would send OTP and return 202 otp_required via re-auth path',
    });
  }

  return json({
    ...trace,
    step: 'poll_secret_gate',
    result: 'Token exists with pollSecret — would return 200 only if correct key provided, else 204',
  });
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
