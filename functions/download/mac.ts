interface Env {
  DOWNLOAD_COUNTS: KVNamespace;
  CURRENT_VERSION: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const version = env.CURRENT_VERSION ?? 'latest';

  const assetUrl =
    version === 'latest'
      ? 'https://github.com/nehloo-interactive/graphnosis-app/releases/latest/download/Graphnosis.dmg'
      : `https://github.com/nehloo-interactive/graphnosis-app/releases/download/${version}/Graphnosis.dmg`;

  // Increment per-version counter — fire and forget, never blocks redirect
  const key = `mac:${version}`;
  env.DOWNLOAD_COUNTS.get(key)
    .then((val) => env.DOWNLOAD_COUNTS.put(key, String(parseInt(val ?? '0') + 1)))
    .catch(() => {});

  return Response.redirect(assetUrl, 302);
};
