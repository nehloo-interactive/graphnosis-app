/**
 * GET /api/billing/public-key
 *
 * Returns the Ed25519 public key derived from LICENSE_SIGNING_SECRET_KEY_HEX
 * as a hex string. The operator pastes this once into the desktop sidecar's
 * apps/desktop-sidecar/src/license-validator.ts (SIGNING_PUBLIC_KEY array)
 * so the desktop verifies tokens signed by this server.
 *
 * Public information by design — see the lengthy "Security note" in
 * license-validator.ts. Forging tokens requires the SECRET key, not the
 * public one.
 */

import type { APIRoute } from 'astro';
import { getSigningPublicKeyHex } from '../../../server/sign.js';
import { getEnv } from '../../../server/env.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  try {
    const env = getEnv(locals);
    const hex = await getSigningPublicKeyHex(env);
    return new Response(JSON.stringify({ publicKeyHex: hex }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : 'unknown' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
};
