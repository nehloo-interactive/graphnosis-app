/**
 * POST /subscribe — newsletter / enterprise-waitlist signup via Resend.
 *
 * Replaces the dead apps/docs/functions/subscribe.ts: when Astro's Cloudflare
 * adapter emits _worker.js the functions/ directory is bypassed entirely, so
 * Pages Functions never run on this project. Downloads hit the same wall and
 * moved to src/pages/download/[platform].ts; this route is the same fix for
 * the Newsletter.astro / Enterprise.astro forms, which POST {email, source}
 * here as JSON.
 *
 * Uses the segments flavor of Resend's contacts API (POST /contacts with
 * segments:[{id}]) — the current convention, superseding the per-audience
 * endpoint the dead Pages Function still used. Requires RESEND_API_KEY plus
 * RESEND_NEWSLETTER_SEGMENT_ID / RESEND_ENTERPRISE_SEGMENT_ID in the
 * Cloudflare Pages env (Settings → Variables and Secrets).
 */

import type { APIRoute } from 'astro';
import { getEnv } from '../server/env.js';

export const prerender = false;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });

export const POST: APIRoute = async ({ request, locals }) => {
  let email = '';
  let source = 'newsletter';

  const contentType = request.headers.get('content-type') ?? '';
  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as { email?: string; source?: string };
      email = body.email ?? '';
      source = body.source ?? 'newsletter';
    } else {
      const form = await request.formData();
      email = (form.get('email') as string) ?? '';
      source = (form.get('source') as string) ?? 'newsletter';
    }
  } catch {
    return json(400, { error: 'Invalid request body.' });
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: 'Invalid email address.' });
  }

  const env = getEnv(locals);
  // Mirror requireEnv()'s placeholder convention: a committed *REPLACE_ME*
  // value (wrangler.toml [vars] / .env.example) counts as unconfigured.
  const configured = (v?: string) => (v && !v.includes('REPLACE_ME') ? v : undefined);
  const apiKey = configured(env.RESEND_API_KEY);
  const segmentId = configured(
    source === 'enterprise'
      ? env.RESEND_ENTERPRISE_SEGMENT_ID
      : env.RESEND_NEWSLETTER_SEGMENT_ID
  );

  if (!apiKey || !segmentId) {
    const missing = !apiKey
      ? 'RESEND_API_KEY'
      : source === 'enterprise'
        ? 'RESEND_ENTERPRISE_SEGMENT_ID'
        : 'RESEND_NEWSLETTER_SEGMENT_ID';
    console.error(
      `[subscribe] ${missing} is not configured — set it in apps/docs/wrangler.toml [vars] (segment ids) or as a Cloudflare Pages secret (API key)`
    );
    return json(503, { error: 'Subscriptions are temporarily unavailable.' });
  }

  const res = await fetch('https://api.resend.com/contacts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, segments: [{ id: segmentId }] }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string };
    console.error(`[subscribe] Resend ${res.status}: ${err.message ?? 'unknown error'}`);
    return json(502, { error: err.message ?? 'Failed to subscribe.' });
  }

  return json(200, { ok: true });
};

export const OPTIONS: APIRoute = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
