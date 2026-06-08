#!/usr/bin/env node
/**
 * Build script for the Anthropic Connectors Directory MCPB bundle.
 *
 * Produces mcpb/server/ containing:
 *   index.js          — esbuild-bundled sidecar (ESM, minified)
 *   package.json      — {"type":"module"} so Node treats index.js as ESM
 *   node_modules/
 *     better-sqlite3/ — native SQLite binding (core graph storage)
 *     @msgpackr-extract/<platform>/ — native msgpack decompressor
 *
 * Embeddings (fastembed / onnxruntime) are intentionally excluded.
 * GRAPHNOSIS_EMBED_DISABLE=1 in the manifest env skips embedding init;
 * the sidecar degrades to TF-IDF recall automatically.
 *
 * Usage: node apps/desktop-sidecar/scripts/mcpb-build.mjs
 */

import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SIDECAR = resolve(__dirname, '..');
const ROOT    = resolve(SIDECAR, '../..');
const OUT     = resolve(ROOT, 'mcpb/server');
const PNPM    = resolve(ROOT, 'node_modules/.pnpm');

async function findPnpmPkg(name) {
  // name is like "better-sqlite3@12" or "@msgpackr-extract+*"
  const { readdirSync } = await import('node:fs');
  const entries = readdirSync(PNPM).filter(e => e.startsWith(name));
  if (!entries.length) throw new Error(`pnpm package not found: ${name}`);
  // prefer latest (sort desc)
  entries.sort((a, b) => b.localeCompare(a));
  return join(PNPM, entries[0], 'node_modules');
}

console.log('mcpb-build: cleaning output dir...');
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// ── 1. Bundle JS ─────────────────────────────────────────────────────────────
console.log('mcpb-build: bundling sidecar with esbuild...');
await build({
  entryPoints: [join(SIDECAR, 'dist/index.js')],
  bundle:   true,
  platform: 'node',
  target:   'node18',
  format:   'esm',
  minify:   true,
  outfile:  join(OUT, 'index.js'),
  external: [
    'fastembed',
    'onnxruntime-node',
    '@anush008/*',
    'better-sqlite3',
    '@msgpackr-extract/*',
    './xhr-sync-worker.js',
  ],
  logLevel: 'warning',
});

// ── 2. package.json — ESM marker ─────────────────────────────────────────────
await writeFile(join(OUT, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

// ── 3. Native modules ─────────────────────────────────────────────────────────
const natDir = join(OUT, 'node_modules');
await mkdir(natDir, { recursive: true });

// better-sqlite3
console.log('mcpb-build: copying better-sqlite3...');
const sqliteSrc = join(await findPnpmPkg('better-sqlite3@'), 'better-sqlite3');
await cp(join(sqliteSrc, 'package.json'), join(natDir, 'better-sqlite3/package.json'), { recursive: false });
await cp(join(sqliteSrc, 'lib'),          join(natDir, 'better-sqlite3/lib'),           { recursive: true });
await cp(join(sqliteSrc, 'build/Release/better_sqlite3.node'),
         join(natDir, 'better-sqlite3/build/Release/better_sqlite3.node'),
         { recursive: false });
// better-sqlite3 loads bindings via `node-pre-gyp` or direct path — ensure dir exists
await mkdir(join(natDir, 'better-sqlite3/build/Release'), { recursive: true });

// @msgpackr-extract — platform-specific optional dep
console.log('mcpb-build: copying @msgpackr-extract...');
const platform = process.platform; // darwin | win32 | linux
const arch     = process.arch;     // arm64 | x64
// npm package names: @msgpackr-extract/msgpackr-extract-darwin-arm64 etc.
const extractPkgName = `@msgpackr-extract+msgpackr-extract-${platform}-${arch}`;
const extractSrc = join(await findPnpmPkg(extractPkgName), `@msgpackr-extract`);
if (existsSync(extractSrc)) {
  await cp(extractSrc, join(natDir, '@msgpackr-extract'), { recursive: true });
  console.log(`mcpb-build: copied @msgpackr-extract for ${platform}-${arch}`);
} else {
  console.warn(`mcpb-build: @msgpackr-extract not found for ${platform}-${arch} — msgpack will fall back to pure-JS`);
}

// ── 4. Done ───────────────────────────────────────────────────────────────────
const { statSync } = await import('node:fs');
const bundleSize = (statSync(join(OUT, 'index.js')).size / 1024 / 1024).toFixed(1);
console.log(`mcpb-build: done. bundle=${bundleSize}MB, output=${OUT}`);
console.log('mcpb-build: next → cd mcpb && mcpb pack . ../graphnosis.mcpb');
