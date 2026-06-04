/**
 * GET /account → 303-redirect to Stripe's hosted Customer Portal login.
 *
 * This is the target of the desktop's "Manage or cancel subscription" button.
 * We deliberately do NOT run our own account/auth here: Stripe's hosted portal
 * owns the email login, the session, and the billing UI. Graphnosis serves only
 * this zero-data redirect — no account, no login, no identity on our side,
 * consistent with the "no account" promise. Billing identity (email + card)
 * lives with Stripe, where it has to for any paid product.
 *
 * The portal URL is configured once in the Worker env (STRIPE_PORTAL_LOGIN_URL,
 * from Stripe Dashboard → Customer portal), so it can change without shipping a
 * new desktop build — the button always points at /account.
 */

import type { APIRoute } from 'astro';
import { getStripePortalUrl } from '../server/stripe.js';
import { getEnv } from '../server/env.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const env = getEnv(locals);
  try {
    return Response.redirect(getStripePortalUrl(env), 303);
  } catch {
    // Portal URL not configured yet — show a plain notice instead of a 500.
    const body = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Manage subscription · Graphnosis</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         max-width: 520px; margin: 8vh auto; padding: 0 24px; color: #1a1a1a; line-height: 1.55; }
  h1 { font-size: 24px; }
  .muted { color: #777; font-size: 14px; }
</style></head><body>
  <h1>Billing portal unavailable</h1>
  <p class="muted">The subscription portal isn't reachable right now. Each
     Stripe receipt or invoice email also has a link to manage your subscription
     — or contact support and we'll help.</p>
</body></html>`;
    return new Response(body, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
};
