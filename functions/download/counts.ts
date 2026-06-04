interface Env {
  /** Optional GitHub PAT for higher rate limits (5 000/hr vs 60/hr).
   *  Set in Cloudflare Pages → Settings → Environment variables. */
  GITHUB_TOKEN?: string;
}

const REPO = 'nehloo-interactive/graphnosis-app';

function classifyAsset(name: string): 'mac' | 'windows' | 'linux' | null {
  if (name.endsWith('.dmg') || name.endsWith('.app.tar.gz')) return 'mac';
  if (
    name.endsWith('.msi') ||
    name.endsWith('.msi.zip') ||
    name.endsWith('-setup.exe') ||
    name.endsWith('.nsis.zip')
  )
    return 'windows';
  if (name.endsWith('.deb') || name.endsWith('.AppImage') || name.endsWith('.AppImage.tar.gz'))
    return 'linux';
  return null;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const reqHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'graphnosis-app-pages',
  };

  if (env.GITHUB_TOKEN) {
    reqHeaders['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
    headers: reqHeaders,
  });

  if (!res.ok) {
    return new Response(
      JSON.stringify({ error: `GitHub API responded with ${res.status}` }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const releases = (await res.json()) as Array<{
    tag_name: string;
    name: string;
    published_at: string;
    assets: Array<{ name: string; download_count: number }>;
  }>;

  let total = 0;
  const byPlatform = { mac: 0, windows: 0, linux: 0 };
  const byRelease: Record<
    string,
    { name: string; published_at: string; assets: Record<string, number>; total: number }
  > = {};

  for (const release of releases) {
    const releaseTotal = release.assets.reduce((sum, a) => sum + a.download_count, 0);
    total += releaseTotal;
    for (const asset of release.assets) {
      const platform = classifyAsset(asset.name);
      if (platform) byPlatform[platform] += asset.download_count;
    }
    byRelease[release.tag_name] = {
      name: release.name,
      published_at: release.published_at,
      assets: Object.fromEntries(release.assets.map((a) => [a.name, a.download_count])),
      total: releaseTotal,
    };
  }

  return new Response(JSON.stringify({ total, byPlatform, releases: byRelease }, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
