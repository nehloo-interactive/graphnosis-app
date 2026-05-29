/**
 * POST /api/auth/magic-link
 * Body: { email }
 *
 * For users who lost the original Stripe success-page email. We look up the
 * current token for that email; if one exists, we issue a fresh claim code
 * and email a new graphnosis:// deep link.
 *
 * This is NOT an "anyone can request a token" endpoint — we only mail to
 * addresses already known to the KV (i.e. who already paid). Unknown addresses
 * return 204 to avoid disclosing customer status.
 */

import type { APIRoute } from 'astro';
import { getToken, putClaim } from '../../../server/kv.js';
import { sendMagicLink } from '../../../server/email.js';
import { getBillingBaseUrl } from '../../../server/stripe.js';
import { getEnv, requireKv } from '../../../server/env.js';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  let body: { email?: string };
  try {
    body = (await request.json()) as { email?: string };
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const email = body.email?.toLowerCase().trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return new Response(JSON.stringify({ error: 'invalid_email' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  const env = getEnv(locals);
  const kv = requireKv(env, 'BILLING_KV');
  const rec = await getToken(kv, email);
  if (!rec) {
    return new Response(null, { status: 204 });
  }
  const code = generateClaimCode();
  await putClaim(kv, code, { email, createdAt: Date.now() });
  const baseUrl = getBillingBaseUrl(env);
  const deepLink = `graphnosis://claim?code=${encodeURIComponent(code)}`;
  const webFallback = `${baseUrl}/claim?code=${encodeURIComponent(code)}`;
  try {
    await sendMagicLink(env, { to: email, deepLink, webFallback });
  } catch (e) {
    console.error('[billing /api/auth/magic-link] sendMagicLink failed', e);
    return new Response(JSON.stringify({ error: 'send_failed' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }
  return new Response(null, { status: 204 });
};

function generateClaimCode(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Workers don't have Buffer — build the base64 ourselves.
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
