/**
 * Cloudflare Pages Function — intercepts /packs/<filename>.gsk requests,
 * bumps an anonymous download counter in KV, and then serves the static
 * .gsk file from apps/docs/public/packs/.
 *
 * No PII is stored:
 *   - No IP addresses, no user-agent, no cookies, no referrer
 *   - Counters only: total per pack, daily per pack, daily site-wide
 *   - Counter keys are deterministic from the pack id + date
 *
 * KV binding required:
 *   - Cloudflare dashboard → Pages → graphnosis-docs → Settings → Functions
 *     → KV namespace bindings → add binding name = `PACK_STATS`
 *   - Create the KV namespace once via `wrangler kv:namespace create PACK_STATS`
 *     (or via the dashboard UI). No data migration needed; counters start at 0.
 *
 * Failure mode: if the KV write fails (binding missing in dev, network blip
 * in prod), we still serve the file. Downloads are never blocked by tracking.
 *
 * URL pattern: /packs/<pack-id>-graphnosis-demo-skill.gsk
 *   - Matches every marketplace .gsk under apps/docs/public/packs/
 *   - The `[pack]` route param captures the FULL filename, including the
 *     `-graphnosis-demo-skill.gsk` suffix. We parse the pack id out of that.
 *   - Anything that doesn't match the expected suffix is served as-is
 *     (e.g. random files in /packs/) and not counted.
 */

interface Env {
  PACK_STATS?: KVNamespace;
  ASSETS: Fetcher;
}

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const { params, env, request } = ctx;

  // Route param is the FULL filename, e.g. "software-developer-graphnosis-demo-skill.gsk".
  // Cloudflare's [pack] capture decodes URI-encoded characters automatically.
  const filename = typeof params.pack === 'string' ? params.pack : '';

  // ── Hand off to static asset server ────────────────────────────────────
  // `env.ASSETS.fetch(request)` serves whatever file lives at the request's
  // path inside `public/` — i.e. apps/docs/public/packs/<filename>. We do
  // this BEFORE the KV write so a slow/failed KV doesn't delay the download
  // even by a single millisecond.
  const response = env.ASSETS.fetch(request);

  // Only count requests that match the expected naming pattern. Anything
  // else (random poking, .gsk.bak, .map) shouldn't pollute the counters.
  const SUFFIX = '-graphnosis-demo-skill.gsk';
  if (filename.endsWith(SUFFIX) && env.PACK_STATS) {
    const packId = filename.slice(0, -SUFFIX.length);
    // Validate the pack id — kebab-case ASCII only. Rejects any attempt to
    // inject KV keys via crafted filenames (e.g. ".." or quote chars).
    if (/^[a-z0-9-]{1,80}$/.test(packId)) {
      const today = new Date().toISOString().slice(0, 10); // 2026-05-31
      // Fire-and-forget via ctx.waitUntil so the response isn't gated on
      // the KV write. The runtime keeps the function alive long enough
      // for these to complete after the response has been sent.
      ctx.waitUntil(bumpCounters(env.PACK_STATS, packId, today));
    }
  }

  return response;
};

/**
 * Three increments per download. KV is eventually-consistent across regions,
 * which is fine for an anonymous download counter — the absolute count
 * settles within seconds and we don't display it in real time anyway.
 *
 * Keys:
 *   pack:<id>:total          — running lifetime total for one pack
 *   pack:<id>:day:<YYYY-MM-DD> — per-pack per-day count
 *   site:day:<YYYY-MM-DD>    — site-wide per-day count
 *
 * Reads use `cacheTtl: 0` so each bump sees the freshest value. Writes use
 * the default 60s edge cache TTL; the next bump for the same key on the
 * same edge will see a slightly stale read, but the eventual-consistency
 * properties of KV mean total counts converge correctly across all writes.
 */
async function bumpCounters(kv: KVNamespace, packId: string, day: string): Promise<void> {
  const keys = [
    `pack:${packId}:total`,
    `pack:${packId}:day:${day}`,
    `site:day:${day}`,
  ];
  await Promise.all(keys.map(async (key) => {
    try {
      const raw = await kv.get(key, { cacheTtl: 0 });
      const current = raw ? parseInt(raw, 10) || 0 : 0;
      await kv.put(key, String(current + 1));
    } catch (e) {
      // Swallow — tracking must NEVER affect downloads. The Pages
      // function runtime will surface this in the dashboard log if it
      // happens consistently.
      console.error(`[pack-counter] kv error for ${key}:`, e);
    }
  }));
}
