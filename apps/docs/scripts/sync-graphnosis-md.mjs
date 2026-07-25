// Pre-build script: sync GRAPHNOSIS.md + download fallback artifacts.
//
// 1. Syncs the canonical GRAPHNOSIS.md into public/ (single source of truth).
// 2. Regenerates all /download/{mac,win,linux,linux-deb} lines in public/_redirects
//    from apps/desktop/src-tauri/tauri.conf.json so fallback URLs stay aligned
//    with the version badge in the nav — both derived from tauri.conf.json at
//    build time, no env-var race between CI steps.
// 3. Updates FALLBACK_VERSION in src/pages/download/[platform].ts and
//    functions/download/[platform].ts (last-resort when CURRENT_VERSION is unset).
//
// Primary download redirects are still resolved at runtime by the Astro SSR route
// (src/pages/download/[platform].ts) via CURRENT_VERSION (set by release.yml);
// _redirects + FALLBACK_VERSION are last-resort fallbacks only.
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

let version = '';
try {
  // GitHub's "latest" excludes drafts and pre-releases, so a release that was
  // pulled (marked pre-release) is automatically skipped here too.
  const res = await fetch(
    'https://api.github.com/repos/nehloo-interactive/graphnosis-app/releases/latest',
    { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'graphnosis-docs-prebuild' } },
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const tag = (await res.json()).tag_name ?? '';
  version = tag.replace(/^v/, '');
  if (version) console.log(`[prebuild] latest published release → v${version}`);
} catch (err) {
  // Offline dev, rate limit, API blip — keep whatever is committed rather than
  // rewriting the fallbacks to something unverified.
  version = currentFallback.replace(/^v/, '');
  console.warn(`[prebuild] could not resolve latest published release (${err.message}) — keeping ${currentFallback || 'existing values'}`);
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
