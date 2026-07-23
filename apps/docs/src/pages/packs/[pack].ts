/**
 * GET /packs/<filename> — pack download with anonymous download counting.
 *
 * Replaces the dead apps/docs/functions/packs/[pack].ts: when Astro's
 * Cloudflare adapter emits _worker.js the functions/ directory is bypassed
 * entirely (same story as /subscribe and /download/*). The route bumps the
 * counters and hands the actual bytes to the ASSETS fetcher — the same
 * two-step the old Pages Function did.
 *
 * WHY THE FILES LIVE IN public/packs-data/ (not public/packs/): the adapter
 * auto-excludes every public/ file from the Worker in _routes.json, and
 * excludes beat includes — static files under /packs/ would shadow this
 * route and downloads would silently stop being counted again. (Forcing the
 * pattern back in via routes.extend.include makes the adapter enumerate all
 * 95 .gsk files as individual excludes and blow the 100-rule budget.) With
 * /packs/ empty of static files, this route is auto-included like
 * /download/*, public URLs are unchanged, and /packs-data/* stays on the
 * static path but is not linked from anywhere.
 *
 * No PII is stored:
 *   - No IP addresses, no user-agent, no cookies, no referrer
 *   - Counters only: total per pack, daily per pack, daily site-wide
 *   - Counter keys are deterministic from the pack id + date
 *
 * DEVIATION from the dead function: counters live in BILLING_KV (prefixes
 * `pack:` / `site:`, disjoint from every billing prefix — claim/token/otp/
 * group/member/domain/voucher/gifted/gsub/revoked) instead of the dedicated
 * PACK_STATS namespace the old function asked for. That namespace was never
 * provisioned (wrangler.toml declares only BILLING_KV, and the function went
 * dead within days of shipping), so there is no data to migrate and no
 * reason to add a second namespace + a dashboard setup step. Key names are
 * unchanged, so stray historical counts would remain readable if an old
 * PACK_STATS namespace ever turned up and got merged.
 *
 * Failure mode: if the KV bump fails (binding missing in plain `astro dev`,
 * network blip in prod), we still serve the file. Downloads are never
 * blocked by tracking.
 *
 * URL pattern: /packs/<pack-id>-graphnosis-demo-skill.gsk
 *   - The `[pack]` route param captures the FULL filename, including the
 *     `-graphnosis-demo-skill.gsk` suffix. We parse the pack id out of that.
 *   - Anything that doesn't match the expected suffix is served as-is
 *     (e.g. random files in /packs/) and not counted.
 */

import type { APIRoute } from 'astro';
import type { KVNamespace } from '@cloudflare/workers-types';
import { getEnv } from '../../server/env.js';

export const prerender = false;

export const GET: APIRoute = async ({ params, locals, request }) => {
  const env = getEnv(locals);

  // Route param is the FULL filename, URI-decoded by Astro.
  const filename = typeof params.pack === 'string' ? params.pack : '';

  // ── Hand off to the static asset layer ─────────────────────────────────
  // Serve the file from its real home, dist/packs-data/<filename> (see the
  // header for why it isn't under /packs/). `new Request(url, request)`
  // carries method + headers over, so Range/If-None-Match still work. Only
  // headers are awaited here — the body streams to the client while the KV
  // bump runs in waitUntil, so tracking never delays the download.
  const assetUrl = new URL(`/packs-data/${encodeURIComponent(filename)}`, request.url);
  const response = env.ASSETS
    ? await env.ASSETS.fetch(new Request(assetUrl.toString(), request))
    : new Response('Not found', { status: 404 });

  // Only count requests that match the expected naming pattern AND actually
  // served a file. Gating on response.ok keeps random probing (the dead
  // Pages Function counted any well-shaped filename, existing or not — a
  // KV key-spam vector) and 304 revalidations of already-downloaded packs
  // out of the counters.
  const SUFFIX = '-graphnosis-demo-skill.gsk';
  const kv = env.BILLING_KV as KVNamespace | undefined;
  if (response.ok && filename.endsWith(SUFFIX) && kv) {
    const packId = filename.slice(0, -SUFFIX.length);
    // Validate the pack id — kebab-case ASCII only. Rejects any attempt to
    // inject KV keys via crafted filenames (e.g. ".." or quote chars).
    if (/^[a-z0-9-]{1,80}$/.test(packId)) {
      const today = new Date().toISOString().slice(0, 10); // 2026-05-31
      const bump = bumpCounters(kv, packId, today);
      // waitUntil keeps the Worker alive for the writes after the response
      // has been sent; in plain `astro dev` there is no Cloudflare ctx, so
      // fall back to letting the promise float.
      const ctx = (locals as {
        runtime?: { ctx?: { waitUntil(p: Promise<unknown>): void } };
      }).runtime?.ctx;
      if (ctx?.waitUntil) ctx.waitUntil(bump);
      else void bump;
    }
  }

  return response;
};

/**
 * Three increments per download. KV is eventually-consistent across regions,
 * which is fine for an anonymous download counter — the absolute count
 * settles within seconds and we don't display it in real time anyway.
 *
 * Keys (identical to the dead Pages Function — the readable contract):
 *   pack:<id>:total            — running lifetime total for one pack
 *   pack:<id>:day:<YYYY-MM-DD> — per-pack per-day count
 *   site:day:<YYYY-MM-DD>      — site-wide per-day count
 *
 * KV has no atomic increment, so bump = read + write. Concurrent bumps for
 * the same key can race and undercount slightly; edge caching of reads (60s
 * TTL floor — `cacheTtl: 0` is INVALID and throws, a latent bug in the dead
 * Pages Function this replaces) adds a little more slack. Acceptable by
 * design for an anonymous, non-realtime download counter.
 */
async function bumpCounters(kv: KVNamespace, packId: string, day: string): Promise<void> {
  const keys = [
    `pack:${packId}:total`,
    `pack:${packId}:day:${day}`,
    `site:day:${day}`,
  ];
  await Promise.all(keys.map(async (key) => {
    try {
      const raw = await kv.get(key);
      const current = raw ? parseInt(raw, 10) || 0 : 0;
      await kv.put(key, String(current + 1));
    } catch (e) {
      // Swallow — tracking must NEVER affect downloads.
      console.error(`[pack-counter] kv error for ${key}:`, e);
    }
  }));
}
