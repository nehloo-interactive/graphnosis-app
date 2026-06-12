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
import { putToken, getToken, deleteToken, type TokenRecord } from '../../../server/kv.js';
import { getEnv, requireEnv, requireKv } from '../../../server/env.js';
import {
  getGroupBySubscription, putGroup, putGroupSubscriptionIndex,
  randomHex, writeAudit, type GroupRecord,
} from '../../../server/groups.js';

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  const env = getEnv(locals);

  // ── Early config guard ──────────────────────────────────────────────────────
  // Fail fast with a clear log if required secrets or bindings are missing.
  // Without this, a missing secret silently reaches deep into the handler and
  // logs an unhelpful "handler error" with no detail.
  try {
    requireEnv(env, 'STRIPE_SECRET_KEY', 'sk_test_REPLACE_ME');
    requireEnv(env, 'STRIPE_WEBHOOK_SECRET', 'whsec_REPLACE_ME');
    requireEnv(env, 'LICENSE_SIGNING_SECRET_KEY_HEX', 'REPLACE_ME_128_HEX_CHARS');
    requireKv(env, 'BILLING_KV');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[billing webhook] misconfiguration —', msg);
    return new Response(`Server misconfiguration: ${msg}`, { status: 500 });
  }

  // ── Signature verification ──────────────────────────────────────────────────
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
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[billing webhook] signature verification failed —', msg);
    return new Response('Signature verification failed.', { status: 400 });
  }

  // ── Event processing ────────────────────────────────────────────────────────
  try {
    const kv = requireKv(env, 'BILLING_KV');
    const stripe = getStripe(env);
    console.log('[billing webhook] handling event', event.type, event.id);

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
          console.log('[billing webhook] retrieving subscription', subId);
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
        console.log('[billing webhook] retrieving customer for subscription', sub.id);
        const email = await emailForSubscription(stripe, sub);
        if (email) await mintAndPersist(env, kv, email, sub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        console.log('[billing webhook] retrieving customer for deleted subscription', sub.id);
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
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[billing webhook] handler error —', msg);
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
  const metaFeatures = sub?.metadata?.['features'] ?? 'skill-training,gnn-exploration';
  const features = metaFeatures
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const plan = sub?.metadata?.['plan'] ?? 'monthly-subscription';
  // Renewal state: a subscription set to cancel at period end is still active
  // (token stays valid until `exp`) but won't auto-renew — the desktop shows
  // "Expires" instead of "Renews". Stripe fires customer.subscription.updated
  // when the user toggles cancel_at_period_end, so a fresh token reflecting the
  // new state is minted automatically. No subscription object → treat as
  // renewing (manual/admin mint).
  const renews = sub ? !(sub.cancel_at_period_end ?? false) : true;
  console.log('[billing webhook] minting token for', email, '(plan:', plan, 'features:', features.join(','), 'renews:', renews, ')');
  const token = await mintLicenseToken(env, email, features, 35, plan, renews);
  // The signed token carries its own exp; we mirror it into the KV row so
  // /api/subscription/token can answer "is this current?" without re-verifying
  // the signature on every poll.
  const expSeconds = decodeExpFromToken(token);
  // Poll secret: gate the by-email poll so only the device that claimed this
  // subscription (and thus holds the secret) can pull the token. Preserve any
  // existing secret across refreshes so a live device's stored key stays valid;
  // mint a fresh one only on first issue.
  const existing = await getToken(kv, email);
  const pollSecret = existing?.pollSecret ?? randomSecret();
  const record: TokenRecord = {
    token,
    exp: expSeconds,
    updatedAt: Date.now(),
    plan,
    pollSecret,
  };
  await putToken(kv, email, record);
  console.log('[billing webhook] token persisted for', email);

  // ── Teams plan: create or update the GroupRecord ──────────────────────────
  if (plan.startsWith('teams') && sub) {
    const seatCount = sub.items?.data[0]?.quantity ?? 1;
    const subId     = sub.id;
    const existing  = await getGroupBySubscription(kv, subId);
    if (existing) {
      // Seat count may have changed (upgrade/downgrade) — update it, but
      // don't clobber the member list (admin manages members separately).
      if (existing.seatCount !== seatCount) {
        existing.seatCount = seatCount;
        existing.updatedAt = Date.now();
        await putGroup(kv, existing);
        console.log('[billing webhook] updated group seatCount to', seatCount, 'for', subId);
      }
    } else {
      const groupId = crypto.randomUUID();
      const group: GroupRecord = {
        id: groupId,
        ownerEmail: email,
        plan,
        features,
        seatCount,
        members: [{ email }],
        subscriptionId: subId,
        adminSecret: randomHex(24),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttlDays: 35,
      };
      await putGroup(kv, group);
      await putGroupSubscriptionIndex(kv, subId, groupId);
      await writeAudit(kv, { ts: Date.now(), action: 'group-create', email, groupId,
        adminNote: `stripe sub=${subId} seatCount=${seatCount}` });
      console.log('[billing webhook] created group', groupId, 'for', email, 'seats:', seatCount);
      console.log('[billing webhook] team management URL: /api/groups/' + groupId + '?secret=' + group.adminSecret);
    }
  }
}

/** 32-byte URL-safe random secret (Web Crypto — Worker-safe). */
function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
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
