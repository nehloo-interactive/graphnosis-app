/**
 * GET /api/pack-stats?secret=… — read-only admin endpoint for pack download
 * stats, gated behind a shared secret env var so the URL alone doesn't leak
 * the numbers.
 *
 * Replaces the dead apps/docs/functions/api/pack-stats.ts (functions/ is
 * bypassed by the adapter's _worker.js). Counters are written by
 * src/pages/packs/[pack].ts into BILLING_KV — see that file's header for why
 * BILLING_KV and not the never-provisioned PACK_STATS namespace.
 *
 * Response shape (unchanged from the dead function):
 *   {
 *     totalToday: number,
 *     packs: [ { id: "software-developer", total: 42, today: 3 }, ... ]
 *   }
 *
 * Setup: set `PACK_STATS_ADMIN_SECRET` (generate: openssl rand -hex 32) as a
 * Secret in Cloudflare Pages → Settings → Variables and Secrets. Unset (or
 * left as a *REPLACE_ME* placeholder) → every request gets 401.
 */

import type { APIRoute } from 'astro';
import { getEnv } from '../../server/env.js';

export const prerender = false;

export const GET: APIRoute = async ({ locals, request }) => {
  const env = getEnv(locals);
  const url = new URL(request.url);
  const provided = url.searchParams.get('secret');
  const expected = env.PACK_STATS_ADMIN_SECRET;

  // Constant-time comparison isn't available on Workers; a 32-byte random
  // secret over the open internet makes timing attacks moot anyway.
  if (!expected || expected.includes('REPLACE_ME') || provided !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }
  const kv = env.BILLING_KV;
  if (!kv) {
    return new Response(JSON.stringify({ error: 'BILLING_KV binding not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const today = new Date().toISOString().slice(0, 10);

  // KV list is paginated; ~95 packs × a handful of keys stays well under the
  // 1000-per-page cap, so a single list call returns everything. Billing
  // keys use other prefixes (claim:/token:/…) — `pack:` is counters-only.
  const list = await kv.list({ prefix: 'pack:' });

  const packs: Record<string, { total: number; today: number }> = {};

  await Promise.all(list.keys.map(async (k) => {
    const value = await kv.get(k.name);
    const count = value ? parseInt(value, 10) || 0 : 0;

    // Key shapes: pack:<id>:total  or  pack:<id>:day:YYYY-MM-DD
    const rest = k.name.slice('pack:'.length);
    const isTotal = rest.endsWith(':total');
    const dayMatch = rest.match(/^([a-z0-9-]+):day:(\d{4}-\d{2}-\d{2})$/);

    if (isTotal) {
      const id = rest.slice(0, -':total'.length);
      packs[id] ??= { total: 0, today: 0 };
      packs[id].total = count;
    } else if (dayMatch && dayMatch[2] === today) {
      const id = dayMatch[1]!;
      packs[id] ??= { total: 0, today: 0 };
      packs[id].today = count;
    }
  }));

  const siteToday = await kv.get(`site:day:${today}`);

  const packList = Object.entries(packs)
    .map(([id, v]) => ({ id, total: v.total, today: v.today }))
    .sort((a, b) => b.total - a.total);

  return new Response(JSON.stringify({
    totalToday: siteToday ? parseInt(siteToday, 10) || 0 : 0,
    packs: packList,
  }, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
};
