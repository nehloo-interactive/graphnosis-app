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
// DID TSC ACTUALLY RUN? Check before believing anything it did not say.
//
// This counts errors by string-matching tsc's output, and the failure mode of
// every such counter is the same: NO OUTPUT PARSES AS NO ERRORS. If tsc fails to
// spawn, is killed, runs out of memory, or rejects the config, `output` is empty,
// `total` is 0, 0 is below the baseline of 316, and this script prints
// "improved by 316" and exits 0. A green ratchet would then mean the compiler
// never ran — which is precisely the class of defect the ratchet exists to catch,
// reproduced inside the catcher.
//
// tsc's exit codes: 0 = clean, 1 = type errors found, 2+ = tsc itself failed.
if (run.error) {
  console.error(`typecheck: FAILED — could not run tsc: ${run.error.message}`);
  process.exit(2);
}
if (run.status === null) {
  console.error(`typecheck: FAILED — tsc was killed by signal ${run.signal}. No result to trust.`);
  process.exit(2);
}

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
const errorLines = output.split('\n').filter((l) => l.includes('error TS'));

// SEPARATE TYPE ERRORS FROM CONFIG ERRORS, because counting them together is a
// second way to manufacture a clean run — and the first version of this guard
// missed it. Pointing tsc at a nonexistent tsconfig emits exactly one line,
// `error TS5058: The specified path does not exist`. That line CONTAINS
// "error TS", so a naive count reports 1 error against a baseline of 316 and
// prints "improved by 315" before exiting 0. The compiler never checked a single
// file.
//
// A per-file type error always carries a `path(line,col):` prefix. A global
// error — bad config, unreadable file, unknown flag; the TS5xxx/TS6xxx families —
// never does. Only the former is a type error, and the latter is always fatal
// regardless of how many there are.
const isPerFile = (l) => /\(\d+,\d+\):\s*error TS/.test(l);
const globalErrors = errorLines.filter((l) => !isPerFile(l));
const lines = errorLines.filter(isPerFile);
const total = lines.length;
const ts2304 = lines.filter((l) => l.includes('error TS2304')).length;

if (globalErrors.length > 0) {
  console.error(
    `typecheck: FAILED — tsc reported ${globalErrors.length} configuration/invocation error(s).\n` +
    '  These are not type errors and must not be counted as any. The ratchet below\n' +
    '  would otherwise read a compiler that never ran as a large improvement.\n',
  );
  for (const l of globalErrors.slice(0, 10)) console.error(`  ${l}`);
  process.exit(2);
}

// The contradiction guard: tsc reported a failure and we parsed no errors out of
// it. Either tsc failed for a reason that is not a type error (a bad tsconfig,
// an unreadable file) or this parser no longer matches tsc's output format. Both
// mean the number below is fiction, and fiction that reads as an improvement.
if (run.status !== 0 && total === 0) {
  console.error(
    `typecheck: FAILED — tsc exited ${run.status} but produced no parseable "error TS" lines.\n` +
    '  The count cannot be trusted: either tsc failed for a non-type reason, or its\n' +
    '  output format changed and this parser is now blind. Raw output follows.\n',
  );
  console.error(output.split('\n').slice(0, 20).map((l) => `  ${l}`).join('\n'));
  process.exit(2);
}

// The inverse: tsc says clean, and we somehow parsed errors. Equally impossible,
// equally a sign the parse is wrong.
if (run.status === 0 && total > 0) {
  console.error(
    `typecheck: FAILED — tsc exited 0 but ${total} "error TS" line(s) were parsed.\n` +
    '  One of the two is wrong; refusing to report either as a result.',
  );
  process.exit(2);
}

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
