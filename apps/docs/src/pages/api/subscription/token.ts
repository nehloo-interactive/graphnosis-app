/**
 * GET /api/subscription/token?email=foo@bar.com
 *
 * The desktop's "status poll on unlock" endpoint. Returns the current signed
 * license token for an email, or 204 No Content if none exists.
 *
 * Auth model: email + a per-subscription `key` (the poll secret). The signed
 * token is replayable — anyone who *holds* it gets the entitlement — so we must
 * not hand it to anyone who merely knows the email. The poll secret is minted
 * with the token, delivered once via the claim deep link, and stored by the
 * device. A caller without the matching key gets 204 (indistinguishable from
 * "no subscription") so the endpoint also doesn't confirm whether an email is a
 * customer. Legacy records minted before the secret existed return 204 too,
 * forcing a fresh claim — fail closed.
 *
 * We additionally rate-limit naively per-isolate (one call per email per 2s).
 * On Cloudflare Workers each colo runs its own isolate, so this is a soft cap;
 * harden with KV-based rate limits before scaling.
 */

import type { APIRoute } from 'astro';
import { getToken, putToken, putOtp, getOtp, deleteOtp, OTP_MAX_ATTEMPTS, OTP_TTL_SECONDS, type TokenRecord } from '../../../server/kv.js';
import { getEnv, requireKv } from '../../../server/env.js';
import {
  getDomain, getGroup, putGroup, putMember, isRevoked, writeAudit,
  effectiveTtlDays, type GroupMember,
} from '../../../server/groups.js';
import { mintLicenseToken } from '../../../server/sign.js';
import { sendOtpEmail } from '../../../server/email.js';

export const prerender = false;

const lastPolledAt = new Map<string, number>();
const MIN_INTERVAL_MS = 2000;

export const GET: APIRoute = async ({ url, locals }) => {
  const email = url.searchParams.get('email')?.toLowerCase().trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'invalid_email' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  console.log('[billing token] GET email:', email, 'domain:', email.split('@')[1] ?? '');
  const now = Date.now();
  const prev = lastPolledAt.get(email) ?? 0;
  if (now - prev < MIN_INTERVAL_MS) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  lastPolledAt.set(email, now);

  const env = getEnv(locals);
  const kv  = requireKv(env, 'BILLING_KV');

  // ── Revocation check: revoked addresses always get 410 ─────────────────────
  if (await isRevoked(kv, email)) {
    return new Response(JSON.stringify({ error: 'revoked' }), {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let rec = await getToken(kv, email);

  // ── Domain allowlist: auto-mint for matching domain if no token exists ──────
  if (!rec) {
    const domain     = email.split('@')[1] ?? '';
    const domainRec  = domain ? await getDomain(kv, domain) : null;
    if (!domainRec) {
      console.log('[billing token] no domain record for', domain, '— returning 204');
    }
    if (domainRec) {
      const group = await getGroup(kv, domainRec.groupId);
      if (!group) {
        console.warn('[billing token] domain record exists but group missing — groupId:', domainRec.groupId);
        // Domain record exists but group was deleted — skip auto-mint
      } else if (group.members.length >= group.seatCount) {
        return new Response(
          JSON.stringify({ error: 'seat_limit_reached', seatCount: group.seatCount }),
          { status: 402, headers: { 'Content-Type': 'application/json' } },
        );
      } else {
        // ── OTP gate: verify email ownership before issuing a domain seat ──────
        const otpParam = url.searchParams.get('otp')?.trim();

        if (!otpParam) {
          // No OTP provided — generate one, send it, ask the user to verify.
          const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
          await putOtp(kv, email, { code, expiresAt: Date.now() + OTP_TTL_SECONDS * 1000, attempts: 0 });
          await sendOtpEmail(env, { to: email, code });
          console.log('[billing token] OTP sent for domain auto-mint', email, 'domain:', domain);
          return new Response(
            JSON.stringify({ status: 'otp_required' }),
            { status: 202, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // OTP provided — verify it before minting.
        const otpRec = await getOtp(kv, email);
        if (!otpRec || Date.now() > otpRec.expiresAt) {
          await deleteOtp(kv, email);
          return new Response(
            JSON.stringify({ error: 'otp_expired' }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (!timingSafeEqual(otpParam, otpRec.code)) {
          otpRec.attempts += 1;
          if (otpRec.attempts >= OTP_MAX_ATTEMPTS) {
            await deleteOtp(kv, email);
            return new Response(
              JSON.stringify({ error: 'otp_invalid', attemptsLeft: 0 }),
              { status: 401, headers: { 'Content-Type': 'application/json' } },
            );
          }
          await putOtp(kv, email, otpRec);
          return new Response(
            JSON.stringify({ error: 'otp_invalid', attemptsLeft: OTP_MAX_ATTEMPTS - otpRec.attempts }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          );
        }
        // Valid — clear the OTP and fall through to mint.
        await deleteOtp(kv, email);

        // Auto-mint a token for this domain member
        const ttlDays = effectiveTtlDays(domainRec.ttlDays);
        const token   = await mintLicenseToken(env, email, domainRec.features ?? [], ttlDays, domainRec.plan, false);
        const expSecs = decodeExp(token);
        const pollSecret = randomSecret();
        rec = { token, exp: expSecs, updatedAt: Date.now(), plan: domainRec.plan, pollSecret };
        await putToken(kv, email, rec);

        // Add to group member list
        const member: GroupMember = { email, activatedAt: Date.now() };
        group.members.push(member);
        group.updatedAt = Date.now();
        await putGroup(kv, group);
        await putMember(kv, email, { groupId: group.id });

        await writeAudit(kv, {
          ts: Date.now(), action: 'domain-auto', email,
          groupId: group.id, adminNote: `domain=${domain} otp-verified`,
        });
        console.log('[billing token] domain-auto minted for', email, 'domain:', domain);

        // Return immediately — no poll-secret check needed for a freshly minted token
        return new Response(
          JSON.stringify({ token: rec.token, exp: rec.exp, plan: rec.plan, updatedAt: rec.updatedAt, pollSecret }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
    }
  }

  if (!rec) {
    return new Response(null, { status: 204 });
  }

  // ── Poll-secret gate ─────────────────────────────────────────────────────────
  // Require the poll secret. Missing/mismatched key, or a legacy record with no
  // secret, all return 204 — never reveal the token to an unauthenticated
  // caller, and never confirm the email is a customer. Constant-time-ish compare.
  //
  // Exception: if the email belongs to a domain-allowlist user and the poll
  // secret is missing/wrong (stale token minted before secret gating), fall
  // back to OTP re-auth so the user can self-heal without admin intervention.
  const key = url.searchParams.get('key') ?? '';
  if (!rec.pollSecret || !timingSafeEqual(key, rec.pollSecret)) {
    const domain2 = email.split('@')[1] ?? '';
    const domainRec2 = domain2 ? await getDomain(kv, domain2) : null;
    if (domainRec2) {
      const otpParam2 = url.searchParams.get('otp')?.trim();
      if (!otpParam2) {
        const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
        await putOtp(kv, email, { code, expiresAt: Date.now() + OTP_TTL_SECONDS * 1000, attempts: 0 });
        await sendOtpEmail(env, { to: email, code });
        console.log('[billing token] OTP re-auth for stale domain token', email, 'domain:', domain2);
        return new Response(
          JSON.stringify({ status: 'otp_required' }),
          { status: 202, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // OTP provided — verify and re-mint with a fresh poll secret
      const otpRec2 = await getOtp(kv, email);
      if (!otpRec2 || Date.now() > otpRec2.expiresAt) {
        await deleteOtp(kv, email);
        return new Response(JSON.stringify({ error: 'otp_expired' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      if (!timingSafeEqual(otpParam2, otpRec2.code)) {
        otpRec2.attempts += 1;
        if (otpRec2.attempts >= OTP_MAX_ATTEMPTS) {
          await deleteOtp(kv, email);
          return new Response(JSON.stringify({ error: 'otp_invalid', attemptsLeft: 0 }), { status: 401, headers: { 'Content-Type': 'application/json' } });
        }
        await putOtp(kv, email, otpRec2);
        return new Response(JSON.stringify({ error: 'otp_invalid', attemptsLeft: OTP_MAX_ATTEMPTS - otpRec2.attempts }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      await deleteOtp(kv, email);
      const ttlDays2 = effectiveTtlDays(domainRec2.ttlDays);
      const token2   = await mintLicenseToken(env, email, domainRec2.features ?? [], ttlDays2, domainRec2.plan, false);
      const expSecs2 = decodeExp(token2);
      const pollSecret2 = randomSecret();
      rec = { token: token2, exp: expSecs2, updatedAt: Date.now(), plan: domainRec2.plan, pollSecret: pollSecret2 };
      await putToken(kv, email, rec);
      await writeAudit(kv, { ts: Date.now(), action: 'domain-auto', email, adminNote: `domain=${domain2} otp-reauth` });
      console.log('[billing token] domain token refreshed via OTP re-auth for', email);
      return new Response(
        JSON.stringify({ token: rec.token, exp: rec.exp, plan: rec.plan, updatedAt: rec.updatedAt, pollSecret: pollSecret2 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(null, { status: 204 });
  }
  return new Response(
    JSON.stringify({ token: rec.token, exp: rec.exp, plan: rec.plan, updatedAt: rec.updatedAt }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

/** Length-independent constant-time string compare (avoids leaking the secret
 *  via response-timing). Returns false fast only on the cheap length check. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function decodeExp(token: string): number {
  const dot = token.lastIndexOf('.');
  if (dot === -1) return 0;
  const b64 = token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  try {
    const obj = JSON.parse(atob(padded)) as { exp?: number };
    return typeof obj.exp === 'number' ? obj.exp : 0;
  } catch { return 0; }
}

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
