/**
 * Typed access to Cloudflare Workers env (secrets, plain vars, KV bindings).
 *
 * Astro's Cloudflare adapter surfaces Worker env as
 * `Astro.locals.runtime.env` in .astro components and `context.locals.runtime.env`
 * in API routes. We don't reach for `process.env` on Workers — Workers have
 * no process; env values arrive bound to the request context.
 *
 * Every server-side helper (Stripe, Resend, Ed25519 signing, KV) takes a
 * `BillingEnv` so route handlers stay testable and the type system catches
 * missing vars at build time.
 */

import type { KVNamespace } from '@cloudflare/workers-types';

export interface BillingEnv {
  // Secrets
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  LICENSE_SIGNING_SECRET_KEY_HEX?: string;
  RESEND_API_KEY?: string;
  /** Admin API key for protected /api/admin/* endpoints.
   *  Set as a Cloudflare Secret; use `Authorization: Bearer <key>` to authenticate. */
  ADMIN_API_KEY?: string;
  // Plain text
  STRIPE_PRICE_PRO_MONTHLY?: string;
  STRIPE_PRICE_PRO_ANNUAL?: string;
  STRIPE_PRICE_TEAMS_MONTHLY?: string;
  STRIPE_PRICE_TEAMS_ANNUAL?: string;
  RESEND_FROM_ADDRESS?: string;
  PUBLIC_BILLING_BASE_URL?: string;
  /** Stripe-hosted Customer Portal login URL (billing.stripe.com/p/login/…).
   *  Configured in the Stripe Dashboard → Customer portal. /account redirects
   *  here so billing identity lives entirely with Stripe — Graphnosis serves
   *  no account page of its own. */
  STRIPE_PORTAL_LOGIN_URL?: string;
  /** Comma-separated Stripe coupon slugs mapped to IDs, e.g.
   *  "PARTNER50=coupon_abc,LAUNCH=coupon_xyz". Used by /upgrade/checkout?coupon=SLUG. */
  STRIPE_COUPONS?: string;
  // Download redirect vars — set by release.yml's update-cloudflare jobs
  CURRENT_VERSION?: string;    // e.g. "v1.13.6"
  DMG_FILENAME?: string;       // e.g. "Graphnosis_1.13.6_aarch64.dmg"
  WINDOWS_FILENAME?: string;   // e.g. "Graphnosis_1.13.6_x64_en-US.msi"
  // KV namespace binding
  BILLING_KV?: KVNamespace;
}

/**
 * Astro's runtime.env is loosely typed (`Runtime['env']` is `unknown`-ish on
 * the typings, depending on adapter version). We do a single narrowing cast
 * here so every caller gets a typed `BillingEnv` without sprinkling
 * assertions across the codebase.
 */
export function getEnv(locals: App.Locals): BillingEnv {
  const runtime = (locals as { runtime?: { env?: BillingEnv } }).runtime;
  // In local `astro dev` there is no Cloudflare runtime, so fall back to
  // Vite's import.meta.env which reads the .env file.
  return (runtime?.env ?? import.meta.env) as BillingEnv;
}

/** Require a string value; throw a clear error when missing. */
export function requireEnv(env: BillingEnv, key: keyof BillingEnv, placeholder?: string): string {
  const v = env[key] as string | undefined;
  if (!v || (placeholder && v === placeholder)) {
    throw new Error(`${String(key)} is not configured. See apps/docs/.env.example.`);
  }
  return v;
}

/** Require a KVNamespace binding; throw when missing. */
export function requireKv(env: BillingEnv, key: 'BILLING_KV'): KVNamespace {
  const v = env[key];
  if (!v) {
    throw new Error(`${key} KV binding is not configured. Add a KV namespace binding in Cloudflare Pages → Settings.`);
  }
  return v;
}
