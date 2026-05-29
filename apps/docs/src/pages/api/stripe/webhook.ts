/**
 * POST /api/stripe/webhook
 *
 * The ONLY entry point that mints license tokens. Stripe sends events here
 * after subscription state changes; we verify the signature, look at the
 * event type, and write the appropriate token (or clear it).
 *
 * Cloudflare Workers note: the webhook uses
 * `stripe.webhooks.constructEventAsync` (Web Crypto, available in Workers)
 * instead of the Node-only `constructEvent` (which uses node:crypto's HMAC).
 *
 * Events we handle:
 *   - checkout.session.completed              → mint + persist token
 *   - customer.subscription.created           → mint + persist token (covers
 *                                                the rare case where Checkout
 *                                                completes but session.completed
 *                                                arrives after subscription.created)
 *   - customer.subscription.updated           → refresh token (e.g. plan change)
 *   - customer.subscription.deleted           → clear token (cancellation)
 *   - invoice.payment_failed                  → leave token in place — the
 *                                                desktop already handles grace
 *                                                via the token's exp.
 */

import type { APIRoute } from 'astro';
import type Stripe from 'stripe';
import { getStripe, getWebhookSecret } from '../../../server/stripe.js';
import { mintLicenseToken, type LicensePayload } from '../../../server/sign.js';
import { putToken, deleteToken, type TokenRecord } from '../../../server/kv.js';
import { getEnv, requireKv } from '../../../server/env.js';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);
  const sig = request.headers.get('stripe-signature');
  if (!sig) {
    return new Response('Missing Stripe-Signature header.', { status: 400 });
  }

  let event: Stripe.Event;
  try {
    const rawBody = await request.text(); // Stripe needs the raw body, not parsed JSON.
    const stripe = getStripe(env);
    const secret = getWebhookSecret(env);
    // Async variant — uses Web Crypto for HMAC, required on Cloudflare Workers
    // (no node:crypto). Works identically on Node, so this is the portable choice.
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, secret);
  } catch (e) {
    console.error('[billing webhook] signature verification failed', e);
    return new Response('Signature verification failed.', { status: 400 });
  }

  try {
    const kv = requireKv(env, 'BILLING_KV');
    const stripe = getStripe(env);
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const email = session.customer_details?.email ?? session.customer_email;
        if (!email) {
          console.warn('[billing webhook] checkout.session.completed without email', session.id);
          break;
        }
        const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        if (subId) {
          const sub = await stripe.subscriptions.retrieve(subId);
          await mintAndPersist(env, kv, email, sub);
        } else {
          await mintAndPersist(env, kv, email, null);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const email = await emailForSubscription(stripe, sub);
        if (email) await mintAndPersist(env, kv, email, sub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const email = await emailForSubscription(stripe, sub);
        if (email) {
          await deleteToken(kv, email);
          console.log('[billing webhook] subscription deleted; token cleared for', email);
        }
        break;
      }
      default:
        // Ignored — but acknowledge the event so Stripe stops retrying.
        break;
    }
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('[billing webhook] handler error', e);
    // 500 → Stripe will retry. Good when the failure is transient
    // (network, KV write); not so good when the failure is permanent
    // (bad env). We err on the side of retrying.
    return new Response('handler error', { status: 500 });
  }
};

async function emailForSubscription(stripe: Stripe, sub: Stripe.Subscription): Promise<string | null> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return null;
  return customer.email ?? null;
}

async function mintAndPersist(
  env: ReturnType<typeof getEnv>,
  kv: import('@cloudflare/workers-types').KVNamespace,
  email: string,
  sub: Stripe.Subscription | null,
): Promise<void> {
  // Pull plan + features from subscription metadata, falling back to defaults
  // for the monthly-subscription plan we ship today.
  // Default both features for any new subscription. The metadata override
  // exists so future plans (e.g. skill-only) can carry a narrower set.
  const metaFeatures = sub?.metadata?.['features'] ?? 'skill-training,gnn-exploration';
  const features = metaFeatures
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const plan = sub?.metadata?.['plan'] ?? 'monthly-subscription';
  const token = await mintLicenseToken(env, email, features, 35, plan);
  // The signed token carries its own exp; we mirror it into the KV row so
  // /api/subscription/token can answer "is this current?" without re-verifying
  // the signature on every poll.
  const expSeconds = decodeExpFromToken(token);
  const record: TokenRecord = {
    token,
    exp: expSeconds,
    updatedAt: Date.now(),
    plan,
  };
  await putToken(kv, email, record);
  console.log('[billing webhook] minted token for', email, '(features:', features.join(','), ')');
}

function decodeExpFromToken(token: string): number {
  // Token format: base64url(json).base64url(sig). We only need the payload
  // here — and only the exp field — so do a minimal decode.
  const dot = token.lastIndexOf('.');
  if (dot === -1) return 0;
  const payloadB64 = token.slice(0, dot);
  const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - payloadB64.length % 4) % 4);
  // atob is Worker-safe; no Buffer needed.
  let json: string;
  try {
    json = atob(padded);
  } catch {
    return 0;
  }
  try {
    const obj = JSON.parse(json) as LicensePayload;
    return typeof obj.exp === 'number' ? obj.exp : 0;
  } catch {
    return 0;
  }
}
