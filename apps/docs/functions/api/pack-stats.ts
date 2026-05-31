/**
 * Cloudflare Pages Function — read-only admin endpoint for pack download
 * stats. Gated behind a shared secret env var so the URL alone doesn't
 * leak the numbers.
 *
 * Usage (curl):
 *   curl 'https://your-domain/api/pack-stats?secret=THE_SECRET'
 *
 * Response shape:
 *   {
 *     totalToday: number,
 *     packs: [
 *       { id: "software-developer", total: 42, today: 3 },
 *       ...
 *     ]
 *   }
 *
 * Setup:
 *   - Cloudflare dashboard → Pages → graphnosis-docs → Settings →
 *     Environment variables → add `PACK_STATS_ADMIN_SECRET = <random-32-bytes>`
 *   - The KV binding `PACK_STATS` must already exist (set up for
 *     /packs/[pack].ts; same namespace).
 *
 * Costs nothing per call when the KV namespace is small (~hundreds of keys).
 * For bigger marketplaces consider switching to D1 with a single SELECT.
 */

interface Env {
  PACK_STATS?: KVNamespace;
  PACK_STATS_ADMIN_SECRET?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const url = new URL(request.url);
  const provided = url.searchParams.get('secret');
  const expected = env.PACK_STATS_ADMIN_SECRET;

  // Constant-time-ish check would be ideal, but Cloudflare Workers don't
  // ship `crypto.timingSafeEqual`. The brute-force attack surface against
  // a 32-byte random secret over the open internet is irrelevant; an
  // attacker would exhaust their rate-limit budget billions of guesses
  // short of the keyspace.
  if (!expected || provided !== expected) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (!env.PACK_STATS) {
    return new Response(JSON.stringify({ error: 'PACK_STATS KV binding not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const today = new Date().toISOString().slice(0, 10);

  // KV list is paginated; with ~95 packs × 3 keys we're well under the
  // 1000-per-page cap so a single list call returns everything.
  const list = await env.PACK_STATS.list({ prefix: 'pack:' });

  // Aggregate per-pack totals from the list result. Each key is
  // pack:<id>:total or pack:<id>:day:YYYY-MM-DD.
  const packs: Record<string, { total: number; today: number }> = {};

  // Fetch values in parallel — ~95 GETs, well within free tier limits.
  await Promise.all(list.keys.map(async (k) => {
    const value = await env.PACK_STATS!.get(k.name);
    const count = value ? parseInt(value, 10) || 0 : 0;

    // Parse the key. Shape: pack:<id>:<bucket>(:<date>)?
    const rest = k.name.slice('pack:'.length);
    const lastColon = rest.lastIndexOf(':');
    // For `pack:<id>:total`, lastColon points before "total".
    // For `pack:<id>:day:<date>`, lastColon points before "<date>" but
    // there's an additional ":day" earlier — handle both shapes.
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

  const siteToday = await env.PACK_STATS.get(`site:day:${today}`);

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
