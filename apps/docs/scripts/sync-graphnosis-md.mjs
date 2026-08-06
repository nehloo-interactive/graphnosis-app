// Pre-build script: sync GRAPHNOSIS.md + download fallback artifacts.
//
// 1. Syncs the canonical GRAPHNOSIS.md into public/ (single source of truth).
// 2. Regenerates all /download/{mac,win,linux,linux-deb} lines in public/_redirects
//    from apps/desktop/src-tauri/tauri.conf.json so fallback URLs stay aligned
//    with the version badge in the nav — both derived from tauri.conf.json at
//    build time, no env-var race between CI steps.
// 3. Updates FALLBACK_VERSION in src/pages/download/[platform].ts and
//    functions/download/[platform].ts.
//
// WHAT ACTUALLY SERVES /download/* — corrected 2026-08-05.
//
// This file used to claim that redirects are "resolved at runtime via
// CURRENT_VERSION (set by release.yml); _redirects + FALLBACK_VERSION are
// last-resort fallbacks only." That was never true in production. CURRENT_VERSION
// has never existed on the Pages project — confirmed absent from the dashboard —
// so `CURRENT_VERSION || FALLBACK_VERSION` in the Function has ALWAYS taken the
// fallback branch, and the value this script writes at build time is the only
// thing users ever get. It is the primary mechanism, not the safety net.
//
// Two consequences worth keeping in mind when editing below:
//   - a failure here is a user-visible wrong download link, not a degraded one;
//   - the fallback deliberately tracks the latest PUBLISHED release, so during
//     a release build it lags by one version until the new assets exist.
//
// Runs automatically before `dev` and `build` via the `predev` / `prebuild`
// lifecycle hooks.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RELEASES_BASE =
  'https://github.com/nehloo-interactive/graphnosis-app/releases/download';

const DOWNLOAD_PREFIXES = ['/download/mac', '/download/win', '/download/linux-deb', '/download/linux'];

// ── 1. Sync GRAPHNOSIS.md ──────────────────────────────────────────────────

const source = new URL('../../../GRAPHNOSIS.md', import.meta.url);
const dest   = new URL('../public/GRAPHNOSIS.md', import.meta.url);

if (!existsSync(source)) {
  console.error(`[prebuild] canonical GRAPHNOSIS.md not found: ${fileURLToPath(source)}`);
  process.exit(1);
}
copyFileSync(source, dest);
console.log(`[prebuild] synced GRAPHNOSIS.md → public/`);

// ── 2. Write /download/* redirect fallbacks ─────────────────────────────────
//
// IMPORTANT: these fallbacks track the latest PUBLISHED release, NOT the
// version in tauri.conf.json.
//
// tauri.conf.json is bumped in the release commit, before the tag is pushed and
// long before CI has built anything. Deriving the fallbacks from it published a
// docs deploy pointing at release assets that did not exist yet — every
// /download/* link 404'd for the ~25 minutes the build took, on every release.
// A last-resort fallback must never lead the artifacts it points at; pointing at
// the previous release is always safe, since CURRENT_VERSION (set by release.yml
// only after the builds succeed) takes precedence the moment the new one is live.

const currentFallback = (() => {
  // Whatever the handler currently ships with is our offline-safe default.
  try {
    const handler = readFileSync(new URL('../functions/download/[platform].ts', import.meta.url), 'utf8');
    return handler.match(/const FALLBACK_VERSION = '(v[^']+)'/)?.[1] ?? '';
  } catch {
    return '';
  }
})();

// A DEPLOY BUILD MAY NOT GUESS; A LOCAL ONE MAY.
// Cloudflare Pages sets CF_PAGES, most CI sets CI. Neither is set on a laptop,
// where an offline `pnpm dev` is legitimate and must not require the network.
const isDeployBuild = Boolean(process.env['CF_PAGES'] || process.env['CI']);

let version = '';
try {
  // GitHub's "latest" excludes drafts and pre-releases, so a release that was
  // pulled (marked pre-release) is automatically skipped here too.
  //
  // AUTHENTICATE WHENEVER A TOKEN EXISTS. Unauthenticated, this endpoint allows
  // 60 requests per hour PER IP, and Cloudflare's build runners share addresses.
  // That ceiling is not theoretical: the live download page served v1.28.0 —
  // the committed constant below — while releases up to v1.34.0 existed, because
  // this call failed and the catch quietly kept the old value. A token raises the
  // ceiling to 5000/hr. Set GITHUB_TOKEN in the Pages build environment.
  const token = process.env['GITHUB_TOKEN'] || process.env['GH_TOKEN'] || '';
  const res = await fetch(
    'https://api.github.com/repos/nehloo-interactive/graphnosis-app/releases/latest',
    {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'graphnosis-docs-prebuild',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 429 ? ' — rate limited; set GITHUB_TOKEN' : '';
    throw new Error(`GitHub API ${res.status}${hint}`);
  }
  const tag = (await res.json()).tag_name ?? '';
  version = tag.replace(/^v/, '');
  // An empty tag used to fall through as "success" and leave the fallbacks
  // untouched, which is the same silent-staleness this block now refuses.
  if (!version) throw new Error('release payload carried no tag_name');
  console.log(
    `[prebuild] latest published release → v${version}` +
    `${token ? ' (authenticated)' : ' (UNAUTHENTICATED — 60/hr, shared per IP)'}`,
  );
} catch (err) {
  // THIS CATCH IS WHY THE DOWNLOAD PAGE SERVED A STALE RELEASE.
  //
  // Keeping the committed constant is right offline. It is wrong in a deploy
  // build, where the result is a live download page pointing at an old release
  // with nothing, anywhere, reporting a problem — a warning in a build log that
  // succeeds is not a report. Deploy builds fail instead; laptops carry on.
  if (isDeployBuild) {
    console.error(
      `[prebuild] FATAL: could not resolve the latest published release (${err.message}).\n` +
      `[prebuild] Refusing to publish download links derived from the committed constant ` +
      `(${currentFallback || 'none'}), which would silently point users at a stale release.\n` +
      `[prebuild] If this is a rate limit, set GITHUB_TOKEN in the Pages build environment.`,
    );
    process.exit(1);
  }
  version = currentFallback.replace(/^v/, '');
  console.warn(
    `[prebuild] could not resolve latest published release (${err.message}) — ` +
    `keeping ${currentFallback || 'existing values'} (local build; a deploy build would fail here)`,
  );
}

const redirectsFile = new URL('../public/_redirects', import.meta.url);
let redirects = existsSync(redirectsFile) ? readFileSync(redirectsFile, 'utf8') : '';

// Strip existing download fallback lines so we don't accumulate duplicates.
redirects = redirects
  .split('\n')
  .filter((line) => !DOWNLOAD_PREFIXES.some((prefix) => line.startsWith(prefix)))
  .join('\n')
  .trimEnd();

if (version) {
  const tag = `v${version}`;
  const asset = (file) => `${RELEASES_BASE}/${tag}/${file}`;
  const lines = [
    `/download/win        ${asset(`Graphnosis_${version}_x64_en-US.msi`)}   302`,
    `/download/linux      ${asset(`Graphnosis_${version}_amd64.AppImage`)}  302`,
    `/download/linux-deb  ${asset(`Graphnosis_${version}_amd64.deb`)}        302`,
    `/download/mac        ${asset(`Graphnosis_${version}_aarch64.dmg`)}  302`,
  ];
  redirects = (redirects ? redirects + '\n' : '') + lines.join('\n');
  for (const line of lines) {
    console.log(`[prebuild] ${line.split(/\s+/)[0]} → ${line.split(/\s+/)[1]}`);
  }
}

writeFileSync(redirectsFile, redirects + '\n');

// ── 3. Sync FALLBACK_VERSION in download handlers ───────────────────────────

const FALLBACK_VERSION_FILES = [
  new URL('../src/pages/download/[platform].ts', import.meta.url),
  new URL('../functions/download/[platform].ts', import.meta.url),
];

const FALLBACK_VERSION_RE = /const FALLBACK_VERSION = 'v[^']+';/;

function syncFallbackVersion(fileUrl, tag) {
  const path = fileURLToPath(fileUrl);
  if (!existsSync(fileUrl)) {
    console.warn(`[prebuild] ${path} not found — skipping FALLBACK_VERSION sync`);
    return;
  }
  const before = readFileSync(fileUrl, 'utf8');
  const match = before.match(FALLBACK_VERSION_RE);
  if (!match) {
    console.warn(`[prebuild] FALLBACK_VERSION pattern not found in ${path}`);
    return;
  }
  const next = `const FALLBACK_VERSION = '${tag}';`;
  if (match[0] === next) {
    console.log(`[prebuild] FALLBACK_VERSION already ${tag} in ${path}`);
    return;
  }
  writeFileSync(fileUrl, before.replace(FALLBACK_VERSION_RE, next));
  console.log(`[prebuild] FALLBACK_VERSION → ${tag} in ${path}`);
}

if (version) {
  const tag = `v${version}`;
  for (const file of FALLBACK_VERSION_FILES) {
    syncFallbackVersion(file, tag);
  }
}
