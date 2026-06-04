interface Env {
  /** Release version tag (e.g. `v1.13.1`). Set in Cloudflare Pages →
   *  Settings → Environment variables. If absent we fall back to the
   *  `latest` release link, which GitHub auto-resolves. */
  CURRENT_VERSION?: string;
  /** MSI filename on the release. Update this env var when a new version
   *  ships — no function redeploy needed. */
  WINDOWS_FILENAME?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const version = env.CURRENT_VERSION ?? 'latest';
  const filename = env.WINDOWS_FILENAME ?? 'Graphnosis_1.13.1_x64_en-US.msi';

  const assetUrl =
    version === 'latest'
      ? `https://github.com/nehloo-interactive/graphnosis-app/releases/latest/download/${filename}`
      : `https://github.com/nehloo-interactive/graphnosis-app/releases/download/${version}/${filename}`;

  return Response.redirect(assetUrl, 302);
};
