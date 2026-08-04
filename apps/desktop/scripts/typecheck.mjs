#!/usr/bin/env node
//
// Typecheck for apps/desktop — a RATCHET, not a gate.
//
// WHY A RATCHET
// -------------
// This package had no `typecheck` script at all, and 335 standing errors. A
// plain `tsc --noEmit` would be red from the first run, and a check that is
// always red is one nobody runs — which is exactly how the package ended up
// unchecked while every other project in the repo was gated.
//
// So: the current count is the ceiling. New errors fail the build; fixing
// errors lowers the ceiling. The package gets safer monotonically without
// anyone having to stop and fix 335 things first.
//
// WHY TS2304 IS A HARD FAIL REGARDLESS
// ------------------------------------
// "Cannot find name" is not a type nicety — it is a reference to something
// that does not exist. Vite strips types without checking them, so these ship
// as latent ReferenceErrors that throw the first time the line executes. They
// are the one category where "we already had some" is not a reason to allow
// more, so the baseline records them separately and they may only go down.
//
// WHY THE COMPILER PATH IS PRINTED
// --------------------------------
// `npx tsc` at the REPO ROOT resolves to a squatted `tsc` package that exits 0
// and checks nothing — a clean result from it is meaningless. Resolving via
// this package's own dependency avoids that, and the version is printed so a
// green run can be trusted rather than assumed.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(HERE, '..');
const BASELINE_FILE = join(PKG_DIR, '.typecheck-baseline.json');

// Resolve TypeScript through this package, never through PATH or the root.
const require = createRequire(join(PKG_DIR, 'package.json'));
let tscBin;
try {
  tscBin = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
} catch {
  console.error('typecheck: TypeScript is not resolvable from apps/desktop. Run `pnpm install`.');
  process.exit(2);
}

const version = spawnSync(process.execPath, [tscBin, '--version'], { encoding: 'utf8' }).stdout.trim();
console.log(`typecheck: ${version} (${tscBin})`);

const run = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', join(PKG_DIR, 'tsconfig.json')], {
  encoding: 'utf8',
  cwd: PKG_DIR,
});
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
const lines = output.split('\n').filter((l) => l.includes('error TS'));
const total = lines.length;
const ts2304 = lines.filter((l) => l.includes('error TS2304')).length;

const baseline = existsSync(BASELINE_FILE)
  ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
  : null;

if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ total, ts2304 }, null, 2)}\n`);
  console.log(`typecheck: baseline set to ${total} errors (${ts2304} × TS2304).`);
  process.exit(0);
}

if (!baseline) {
  console.error(
    `typecheck: no baseline. Run \`pnpm --filter @graphnosis-app/desktop typecheck --update-baseline\` ` +
    `to record the current ${total}.`,
  );
  process.exit(2);
}

console.log(`typecheck: ${total} errors (baseline ${baseline.total}) · ${ts2304} × TS2304 (baseline ${baseline.ts2304})`);

let failed = false;
if (total > baseline.total) {
  const added = total - baseline.total;
  console.error(`\ntypecheck: FAILED — ${added} NEW type error(s). The ceiling is ${baseline.total}.`);
  // Show only what a reader can act on. The pre-existing 335 are not news.
  for (const l of lines.slice(-Math.min(added + 5, 25))) console.error(`  ${l}`);
  failed = true;
}
if (ts2304 > baseline.ts2304) {
  console.error(
    `\ntypecheck: FAILED — ${ts2304 - baseline.ts2304} new TS2304 "Cannot find name".\n` +
    `  These are not type nits: Vite strips types without checking, so each one ships as a\n` +
    `  ReferenceError that throws the first time its line runs.`,
  );
  for (const l of lines.filter((l) => l.includes('TS2304'))) console.error(`  ${l}`);
  failed = true;
}
if (failed) process.exit(1);

if (total < baseline.total || ts2304 < baseline.ts2304) {
  console.log(
    `\ntypecheck: improved by ${baseline.total - total} — lower the ceiling with ` +
    `\`pnpm --filter @graphnosis-app/desktop typecheck --update-baseline\` so it cannot drift back.`,
  );
}
console.log('typecheck: OK');
