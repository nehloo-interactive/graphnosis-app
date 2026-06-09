/**
 * Stripe client + helpers.
 *
 * Each helper takes a BillingEnv (from server/env.ts) instead of reading
 * process.env, because we run on Cloudflare Workers where env values come
 * bound to the request context — there is no global `process.env`.
 */

import Stripe from 'stripe';
import type { BillingEnv } from './env.js';
import { requireEnv } from './env.js';

/** Build a Stripe client from the request's bound env.
 *  The Stripe SDK works on Workers; HTTP calls run via fetch under the hood. */
export function getStripe(env: BillingEnv): Stripe {
  const key = requireEnv(env, 'STRIPE_SECRET_KEY', 'sk_test_REPLACE_ME');
  return new Stripe(key, {
    apiVersion: '2026-04-22.dahlia',
    // Force fetch-based HTTP — Stripe defaults to Node's http on Node, and
    // explicit fetch ensures Workers compatibility. The SDK's adapter picks
    // this up automatically when no httpAgent is set, but we set it
    // explicitly to make the runtime contract obvious.
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function getWebhookSecret(env: BillingEnv): string {
  return requireEnv(env, 'STRIPE_WEBHOOK_SECRET', 'whsec_REPLACE_ME');
}

export function getMonthlySubscriptionPriceId(env: BillingEnv): string {
  return requireEnv(env, 'STRIPE_PRICE_PRO_MONTHLY', 'price_REPLACE_ME');
}

export function getProAnnualPriceId(env: BillingEnv): string {
  return requireEnv(env, 'STRIPE_PRICE_PRO_ANNUAL', 'price_REPLACE_ME');
}

export function getTeamsMonthlyPriceId(env: BillingEnv): string {
  return requireEnv(env, 'STRIPE_PRICE_TEAMS_MONTHLY', 'price_REPLACE_ME');
}

export function getTeamsAnnualPriceId(env: BillingEnv): string {
  return requireEnv(env, 'STRIPE_PRICE_TEAMS_ANNUAL', 'price_REPLACE_ME');
}

export function getBillingBaseUrl(env: BillingEnv): string {
  return requireEnv(env, 'PUBLIC_BILLING_BASE_URL').replace(/\/$/, '');
}

/** Stripe-hosted Customer Portal login URL. The desktop's "Manage or cancel
 *  subscription" button → /account → here. Stripe owns the email auth and the
 *  whole portal, so Graphnosis serves no account page or identity of its own. */
export function getStripePortalUrl(env: BillingEnv): string {
  return requireEnv(env, 'STRIPE_PORTAL_LOGIN_URL', 'https://billing.stripe.com/p/login/REPLACE_ME');
}
