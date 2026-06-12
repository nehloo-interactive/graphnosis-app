/**
 * GET /upgrade/checkout
 *
 * Creates a Stripe Checkout Session and 303-redirects to Stripe's hosted page.
 * Supports Pro (monthly/annual) and Teams (monthly/annual) plans.
 *
 * Query params:
 *   ?plan=monthly        Pro monthly (default — backward compatible)
 *   ?plan=annual         Pro annual
 *   ?plan=teams-monthly  Teams monthly
 *   ?plan=teams-annual   Teams annual
 *   ?email=foo@bar.com   Optional pre-fill for the Checkout form.
 *   ?seats=N             Seat quantity for teams plans (default: 1).
 *   ?coupon=SLUG         Pre-apply a discount coupon by slug (configured via STRIPE_COUPONS env var).
 */

import type { APIRoute } from 'astro';
import {
  getStripe,
  getMonthlySubscriptionPriceId,
  getProAnnualPriceId,
  getTeamsMonthlyPriceId,
  getTeamsAnnualPriceId,
  getBillingBaseUrl,
} from '../../server/stripe.js';
import { getEnv } from '../../server/env.js';

const PLAN_CONFIGS = {
  'monthly':       { tier: 'pro',   billing: 'monthly', features: 'skill-training,gnn-exploration,foresight,connector-cadence' },
  'annual':        { tier: 'pro',   billing: 'annual',  features: 'skill-training,gnn-exploration,foresight,connector-cadence' },
  'teams-monthly': { tier: 'teams', billing: 'monthly', features: 'skill-training,gnn-exploration,foresight,connector-cadence,teams' },
  'teams-annual':  { tier: 'teams', billing: 'annual',  features: 'skill-training,gnn-exploration,foresight,connector-cadence,teams' },
} as const;

type PlanKey = keyof typeof PLAN_CONFIGS;

export const prerender = false;

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    const env = getEnv(locals);
    const stripe = getStripe(env);
    const baseUrl = getBillingBaseUrl(env);

    const planParam = url.searchParams.get('plan') ?? 'monthly';
    const plan: PlanKey = (planParam in PLAN_CONFIGS) ? planParam as PlanKey : 'monthly';
    const config = PLAN_CONFIGS[plan];

    const priceId = plan === 'monthly'       ? getMonthlySubscriptionPriceId(env)
                  : plan === 'annual'         ? getProAnnualPriceId(env)
                  : plan === 'teams-monthly'  ? getTeamsMonthlyPriceId(env)
                  :                            getTeamsAnnualPriceId(env);

    const email = url.searchParams.get('email') ?? undefined;

    // Seat quantity: only applied to teams plans; clamped to [1, 500].
    const isTeamsPlan = config.tier === 'teams';
    const seatsParam  = parseInt(url.searchParams.get('seats') ?? '1', 10);
    const seats       = isTeamsPlan ? Math.max(1, Math.min(500, Number.isFinite(seatsParam) ? seatsParam : 1)) : 1;

    // Pre-applied coupon: STRIPE_COUPONS env var holds "SLUG=id,SLUG2=id2" pairs.
    const couponSlug = url.searchParams.get('coupon')?.toUpperCase().trim();
    let discounts: { coupon: string }[] | undefined;
    if (couponSlug && env.STRIPE_COUPONS) {
      const couponMap = parseCouponMap(env.STRIPE_COUPONS);
      const couponId  = couponMap[couponSlug];
      if (couponId) discounts = [{ coupon: couponId }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: seats }],
      ...(email ? { customer_email: email } : {}),
      ...(discounts ? { discounts } : {}),
      success_url: `${baseUrl}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/upgrade/cancelled`,
      subscription_data: {
        metadata: {
          features: config.features,
          plan: `${config.tier}-${config.billing}`,
          ...(isTeamsPlan ? { seats: String(seats) } : {}),
        },
      },
      // Allow customers to enter their own promo codes at checkout.
      allow_promotion_codes: !discounts,
      // Tax collection is off for now — Graphnosis is treated as a cloud
      // service (not "prewritten software taken into possession"), so
      // Indiana DOR likely doesn't require a sales tax permit for it, and
      // we have no nexus elsewhere yet. Flip to `enabled: true` once
      // (a) revenue makes registration worth the compliance effort and
      // (b) Stripe Tax is fully configured in the dashboard (head office
      // address + default tax code + at least one registration).
      automatic_tax: { enabled: false },
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

/** Parse "SLUG=id,SLUG2=id2" into { SLUG: "id", SLUG2: "id2" }. */
function parseCouponMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const slug = pair.slice(0, eq).trim().toUpperCase();
    const id   = pair.slice(eq + 1).trim();
    if (slug && id) map[slug] = id;
  }
  return map;
}
