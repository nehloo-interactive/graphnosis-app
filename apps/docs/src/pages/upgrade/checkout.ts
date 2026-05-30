/**
 * GET /upgrade/checkout
 *
 * Creates a Stripe Checkout Session for the monthly-subscription plan
 * and 303-redirects the browser to the hosted Stripe page. Reached from
 * the "Start subscription" CTA on /upgrade (the landing page) and from
 * any in-app "Upgrade to Pro" button that wants to deep-link past the
 * landing page.
 *
 * Previously this lived at /upgrade itself; relocated when /upgrade
 * became a real landing page that explains the offering before sending
 * users to Stripe.
 *
 * Query params:
 *   ?email=foo@bar.com   — optional pre-fill for the Checkout form. If the
 *                          desktop knows the cortex email it can pass it
 *                          here so the customer doesn't re-type it.
 */

import type { APIRoute } from 'astro';
import { getStripe, getMonthlySubscriptionPriceId, getBillingBaseUrl } from '../../server/stripe.js';
import { getEnv } from '../../server/env.js';

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const env = getEnv(locals);
    const stripe = getStripe(env);
    const priceId = getMonthlySubscriptionPriceId(env);
    const baseUrl = getBillingBaseUrl(env);

    const email = url.searchParams.get('email') ?? undefined;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      ...(email ? { customer_email: email } : {}),
      // Stripe substitutes {CHECKOUT_SESSION_ID} into the URL after success
      // so we can read the customer email back from the session on the
      // success page (no need to trust the URL ?email).
      success_url: `${baseUrl}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/upgrade/cancelled`,
      // Subscription metadata — surfaced on the webhook event so we know
      // which features to mint into the license token.
      subscription_data: {
        metadata: {
          // Pro tier ships everything together — autonomous-praxis skill
          // training AND GNN-Exploration. Add or remove feature slugs here
          // when a future plan splits them.
          features: 'skill-training,gnn-exploration',
          plan: 'monthly-subscription',
        },
      },
      // Tax collection is off for now — Graphnosis is treated as a cloud
      // service (not "prewritten software taken into possession"), so
      // Indiana DOR likely doesn't require a sales tax permit for it, and
      // we have no nexus elsewhere yet. Flip to `enabled: true` once
      // (a) revenue makes registration worth the compliance effort and
      // (b) Stripe Tax is fully configured in the dashboard (head office
      // address + default tax code + at least one registration).
      automatic_tax: { enabled: false },
      // Returns the customer to the success page in the SAME browser tab,
      // which is the only path that can hand off to graphnosis:// via the
      // claim-link button we render there. Stripe renamed this value from
      // 'hosted' to 'hosted_page' in a recent API version; the old name
      // now throws "no longer supported" at session creation time.
      ui_mode: 'hosted_page',
    });

    if (!session.url) {
      return new Response('Stripe did not return a Checkout URL.', { status: 500 });
    }
    return Response.redirect(session.url, 303);
  } catch (e) {
    console.error('[billing /upgrade/checkout]', e);
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return new Response(
      `Could not start Checkout: ${msg}\n\nIf you are the operator, see apps/docs/.env.example.`,
      { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }
};
