#!/usr/bin/env node
/**
 * build-gsk.mjs — compile DefaultSkillPack definitions to signed .gsk binaries.
 *
 * Usage:
 *   node scripts/build-gsk.mjs           # build without signing (community packs)
 *   node scripts/build-gsk.mjs --sign    # sign with GSK_SIGNING_KEY_HEX env var
 *
 * Input:  apps/desktop-sidecar/src/default-skill-packs.ts  (gitignored, local only)
 * Output: dist/packs/<id>-graphnosis-demo-skill.gsk
 *         dist/packs/bundle/<id>-graphnosis-demo-skill.gsk  (bundle:true packs only)
 *
 * When the content file is absent (normal in CI clones), the script exits 0
 * with a warning and does NOT create dist/packs/bundle/. The downstream
 * generate-skill-demos-content.mjs handles a missing bundle/ by writing an
 * empty BUNDLED_SKILL_DEMOS array — valid TypeScript that compiles cleanly.
 *
 * When the content file is present (local authoring workflow), the script
 * relaunches itself under tsx so it can import the TypeScript modules
 * (default-skill-packs.ts → gsk-format.ts → libsodium-wrappers-sumo).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CONTENT_FILE = join(REPO_ROOT, 'apps', 'desktop-sidecar', 'src', 'default-skill-packs.ts');
const OUT_DIR = join(REPO_ROOT, 'dist', 'packs');

const args = process.argv.slice(2);
const sign = args.includes('--sign');

// ── Guard: content file absent (CI / fresh clone) ───────────────────────────

if (!existsSync(CONTENT_FILE)) {
  console.warn('[build-gsk] apps/desktop-sidecar/src/default-skill-packs.ts not found.');
  console.warn('[build-gsk] Skipping pack build — no content to compile.');
  console.warn('[build-gsk] To build locally: author the content file, then re-run with --sign.');
  // Create the top-level output dir so callers that check for its existence
  // don't error. Do NOT create bundle/ — generate-skill-demos-content.mjs
  // checks for the absence of bundle/ to emit its empty-array fallback path.
  mkdirSync(OUT_DIR, { recursive: true });
  process.exit(0);
}

// ── TypeScript evaluation — relaunch under tsx if needed ────────────────────

// When running under plain `node` (not tsx), TypeScript imports would fail.
// Detect whether tsx already loaded us via the sentinel env var.
const alreadyUnderTsx = process.env._GN_BUILD_GSK_TSX === '1';
if (!alreadyUnderTsx) {
  // tsx lives in the root devDependencies and is available after `pnpm install`.
  const tsxBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsxBin)) {
    console.error('[build-gsk] tsx not found at node_modules/.bin/tsx.');
    console.error('[build-gsk] Run `pnpm install` from the repo root first.');
    process.exit(1);
  }
  const result = spawnSync(
    tsxBin,
    [fileURLToPath(import.meta.url), ...args],
    {
      stdio: 'inherit',
      env: { ...process.env, _GN_BUILD_GSK_TSX: '1' },
      cwd: REPO_ROOT,
    },
  );
  process.exit(result.status ?? 1);
}

// ── TypeScript section — only reached when running under tsx ─────────────────
// Everything below can use TypeScript imports. All third-party modules that
// aren't available at the repo root are loaded via dynamic import so the
// plain-node guard above can exit before any resolution attempt.

const { buildGskPackage, generateGraphnosisMd } = await import(
  join(REPO_ROOT, 'apps', 'desktop-sidecar', 'src', 'gsk-format.ts')
);
const { packs } = await import(CONTENT_FILE);

const sodiumModule = await import('libsodium-wrappers-sumo');
const sodium = sodiumModule.default ?? sodiumModule;
await sodium.ready;

const signingKeyHex = sign ? (process.env.GSK_SIGNING_KEY_HEX ?? '') : '';
if (sign && !signingKeyHex) {
  console.error('[build-gsk] --sign requested but GSK_SIGNING_KEY_HEX is not set.');
  process.exit(1);
}
if (sign && Buffer.from(signingKeyHex, 'hex').length !== 64) {
  console.error('[build-gsk] GSK_SIGNING_KEY_HEX must be 64 bytes (128 hex chars).');
  process.exit(1);
}

const BUNDLE_DIR = join(OUT_DIR, 'bundle');
mkdirSync(OUT_DIR, { recursive: true });

let built = 0;
let bundled = 0;
const errors = [];

for (const pack of packs) {
  // Validate content warnings — refuse to compile if any are present.
  if (pack.contentWarnings && pack.contentWarnings.length > 0) {
    console.error(`[build-gsk] ABORT: pack "${pack.id}" has unresolved content warnings:`);
    for (const w of pack.contentWarnings) console.error(`  - ${w}`);
    process.exit(1);
  }

  // Validate contentVerifiedAt — refuse to compile if absent or older than 90 days.
  if (!pack.contentVerifiedAt) {
    console.error(`[build-gsk] ABORT: pack "${pack.id}" is missing contentVerifiedAt.`);
    process.exit(1);
  }
  const verifiedAge = Date.now() - new Date(pack.contentVerifiedAt).getTime();
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
  if (verifiedAge > NINETY_DAYS_MS) {
    console.error(
      `[build-gsk] ABORT: pack "${pack.id}" contentVerifiedAt is older than 90 days (${pack.contentVerifiedAt}).`,
    );
    console.error('[build-gsk] Run a content verification pass and update contentVerifiedAt.');
    process.exit(1);
  }

  // Strip authoring-time fields before serialization.
  const { contentVerifiedAt: _cvat, verifiedBy: _vb, contentWarnings: _cw, bundle, ...packForWire } = pack;

  // Generate graphnosisMd if the pack doesn't supply it.
  const graphnosisMd = packForWire.graphnosisMd ?? generateGraphnosisMd({
    formatVersion: '1',
    kind: packForWire.kind,
    id: packForWire.id,
    displayName: packForWire.displayName,
    description: packForWire.description,
    version: packForWire.version,
    author: packForWire.author,
    tierRequired: packForWire.tierRequired,
    skills: packForWire.skills,
    signature: '',
    graphnosisMd: '',
  });

  const payload = {
    formatVersion: '1',
    kind: packForWire.kind,
    id: packForWire.id,
    displayName: packForWire.displayName,
    description: packForWire.description,
    version: packForWire.version,
    author: packForWire.author,
    tierRequired: packForWire.tierRequired,
    skills: packForWire.skills,
    graphnosisMd,
    signature: '',
  };

  let gskBytes;
  try {
    gskBytes = buildGskPackage(payload, sign ? signingKeyHex : undefined);
  } catch (err) {
    errors.push({ id: pack.id, reason: err instanceof Error ? err.message : String(err) });
    continue;
  }

  const filename = `${pack.id}-graphnosis-demo-skill.gsk`;
  writeFileSync(join(OUT_DIR, filename), gskBytes);
  built++;

  if (bundle) {
    mkdirSync(BUNDLE_DIR, { recursive: true });
    writeFileSync(join(BUNDLE_DIR, filename), gskBytes);
    bundled++;
  }

  console.log(`[build-gsk] built ${filename}${sign ? ' (signed)' : ''}${bundle ? ' → bundle/' : ''}`);
}

if (errors.length > 0) {
  console.error(`[build-gsk] ${errors.length} error(s):`);
  for (const e of errors) console.error(`  ${e.id}: ${e.reason}`);
  process.exit(1);
}

console.log(`[build-gsk] done — ${built} pack(s) built, ${bundled} bundled.`);
