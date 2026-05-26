// Pre-build script: sync GRAPHNOSIS.md + write /download/mac redirect.
//
// 1. Syncs the canonical GRAPHNOSIS.md into public/ (single source of truth).
// 2. Regenerates the /download/mac line in public/_redirects from
//    apps/desktop/src-tauri/tauri.conf.json so the version badge in the nav
//    and the download URL always agree — both derived from tauri.conf.json
//    at build time, no env-var race condition between CI steps.
//
// Runs automatically before `dev` and `build` via the `predev` / `prebuild`
// lifecycle hooks.

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── 1. Sync GRAPHNOSIS.md ──────────────────────────────────────────────────

const source = new URL('../../../GRAPHNOSIS.md', import.meta.url);
const dest   = new URL('../public/GRAPHNOSIS.md', import.meta.url);

if (!existsSync(source)) {
  console.error(`[prebuild] canonical GRAPHNOSIS.md not found: ${fileURLToPath(source)}`);
  process.exit(1);
}
copyFileSync(source, dest);
console.log(`[prebuild] synced GRAPHNOSIS.md → public/`);

// ── 2. Write /download/mac redirect ───────────────────────────────────────

const tauriConf = new URL('../../../apps/desktop/src-tauri/tauri.conf.json', import.meta.url);
let version = '';
try {
  const conf = JSON.parse(readFileSync(tauriConf, 'utf8'));
  version = conf.version ?? '';
} catch {
  console.warn('[prebuild] could not read tauri.conf.json — skipping download redirect');
}

const redirectsFile = new URL('../public/_redirects', import.meta.url);
let redirects = existsSync(redirectsFile) ? readFileSync(redirectsFile, 'utf8') : '';

// Strip any existing /download/mac line so we don't accumulate duplicates.
redirects = redirects.split('\n').filter(l => !l.startsWith('/download/mac')).join('\n').trimEnd();

if (version) {
  const dmgUrl =
    `https://github.com/nehloo-interactive/graphnosis-app/releases/download` +
    `/v${version}/Graphnosis_${version}_aarch64.dmg`;
  redirects = (redirects ? redirects + '\n' : '') + `/download/mac  ${dmgUrl}  302`;
  console.log(`[prebuild] /download/mac → ${dmgUrl}`);
}

writeFileSync(redirectsFile, redirects + '\n');
