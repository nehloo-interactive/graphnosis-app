/**
 * Admin API authentication helper.
 *
 * All /api/admin/* endpoints call `requireAdminAuth` first. If it returns
 * a Response the handler returns it immediately; null means auth passed.
 *
 * Auth scheme: `Authorization: Bearer <ADMIN_API_KEY>`
 * The comparison is timing-safe to prevent timing-oracle attacks.
 */

import type { BillingEnv } from './env.js';

export function requireAdminAuth(request: Request, env: BillingEnv): Response | null {
  const apiKey = env.ADMIN_API_KEY;
  if (!apiKey || apiKey === 'REPLACE_ME') {
    return new Response(
      JSON.stringify({ error: 'misconfigured', message: 'ADMIN_API_KEY is not set. See apps/docs/.env.example.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    return new Response(
      JSON.stringify({ error: 'unauthorized', message: 'Missing Authorization: Bearer <key> header.' }),
      { status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' } },
    );
  }

  const provided = header.slice(7); // strip "Bearer "
  if (!timingSafeEqual(provided, apiKey)) {
    return new Response(
      JSON.stringify({ error: 'unauthorized', message: 'Invalid admin API key.' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return null; // auth ok
}

/** Constant-time string comparison (prevents timing-oracle on the API key). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still compare to burn time proportional to the longer string.
    let diff = 0;
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
