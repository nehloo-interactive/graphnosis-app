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

const tauriConf = new URL('../../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url);
let version = '';
try {
  const conf = JSON.parse(readFileSync(tauriConf, 'utf8'));
  version = conf.version ?? '';
} catch {
  console.warn('[prebuild] could not read tauri.conf.json — skipping download redirects');
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
