interface Env {
  /** KV namespace bound in Cloudflare Pages → Settings → Functions → KV
   *  namespace bindings. Optional: if unbound the counter is skipped and
   *  the redirect still works. */
  DOWNLOAD_COUNTS?: KVNamespace;
  /** Release version tag (e.g. `v0.6.0`). Set in Cloudflare Pages →
   *  Settings → Environment variables. If absent we fall back to the
   *  `latest` release link, which GitHub auto-resolves. */
  CURRENT_VERSION?: string;
  /** DMG filename on the release. Versioned filenames are the project's
   *  current convention (`Graphnosis_0.6.0_aarch64.dmg`), but this is
   *  env-var-driven so the function doesn't need a redeploy each time
   *  the convention changes. Defaults to the v0.6.0 filename. */
  DMG_FILENAME?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const version = env.CURRENT_VERSION ?? 'latest';
  const filename = env.DMG_FILENAME ?? 'Graphnosis_0.6.0_aarch64.dmg';

  const assetUrl =
    version === 'latest'
      ? `https://github.com/nehloo-interactive/graphnosis-app/releases/latest/download/${filename}`
      : `https://github.com/nehloo-interactive/graphnosis-app/releases/download/${version}/${filename}`;

  // Increment per-version counter — fire and forget, never blocks redirect.
  // KV namespace is optional: if it isn't bound in Pages settings the
  // counter is skipped silently rather than throwing an unhandled
  // exception (which causes Cloudflare Error 1101 and a broken download
  // experience for the user). The redirect always proceeds.
  if (env.DOWNLOAD_COUNTS) {
    const key = `mac:${version}`;
    env.DOWNLOAD_COUNTS.get(key)
      .then((val) => env.DOWNLOAD_COUNTS!.put(key, String(parseInt(val ?? '0') + 1)))
      .catch(() => {});
  }

  return Response.redirect(assetUrl, 302);
};
