// Pre-build script: sync GRAPHNOSIS.md + write /download/* redirect fallbacks.
//
// 1. Syncs the canonical GRAPHNOSIS.md into public/ (single source of truth).
// 2. Regenerates all /download/{mac,win,linux,linux-deb} lines in public/_redirects
//    from apps/desktop/src-tauri/tauri.conf.json so fallback URLs stay aligned
//    with the version badge in the nav — both derived from tauri.conf.json at
//    build time, no env-var race between CI steps.
//
// Primary download redirects are still resolved at runtime by the Astro SSR route
// (src/pages/download/[platform].ts) via CURRENT_VERSION; these lines are
// last-resort fallbacks only (see public/_redirects header comment).
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
