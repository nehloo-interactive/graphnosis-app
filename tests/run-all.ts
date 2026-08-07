// Aggregate runner: imports every test suite's exported `run()`, executes
// them sequentially (recall ones share the embedding queue so parallel
// suites would compete), and prints a summary table + collected SDK notes.
//
// Exit 0 if all hard assertions passed across all suites; 1 if any failed.

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SuiteResult, SdkNote } from './_helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDECAR_DIR = path.join(REPO_ROOT, 'apps', 'desktop-sidecar');
const SIDECAR_TESTS = path.join(SIDECAR_DIR, 'tests');
const DESKTOP_TESTS = path.join(REPO_ROOT, 'tests', 'desktop');
const NODE_SUITE_CONCURRENCY = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Redirect machine-local Graphnosis state for the whole run.
//
// Some suites drive shipped dispatch handlers that write machine-local config
// (outside the cortex). That state is redirected here via GRAPHNOSIS_STATE
// before any suite imports, so a developer laptop's live home config is never
// touched — not even an mtime. Spawned `node --test` children inherit the env.
// ─────────────────────────────────────────────────────────────────────────────
const RUN_STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'gn-run-all-state-'));
process.env.GRAPHNOSIS_STATE = RUN_STATE_DIR;
process.on('exit', () => {
  try { rmSync(RUN_STATE_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─────────────────────────────────────────────────────────────────────────────
// HAND-LISTED SUITES.
//
// The two node:test lanes below are DISCOVERED from disk; this array is not,
// and that asymmetry is exactly how a suite goes dark. `tests/*proof.ts` files
// are `run()`-exporting modules imported into THIS process, so there is no
// filename convention safe to glob (a scratch file dropped in tests/ would be
// executed). The cost is that a new root-level suite is invisible until its row
// is added here — `mdm-classification-palette-report-proof` passed standalone
// for weeks with ZERO coverage in the aggregate run for that reason.
//
// SO: adding a root-level suite file is not finished until its row is here.
// Cross-check with:
//   ls tests/*.ts | grep -v '^tests/_' | grep -v run-all
// against the `module:` entries below.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `heldIfMissing: true` — DEC.1 route (d). The row may be committed while the
 * module stays gitignored. A fresh clone reports HELD rather than throwing, and
 * HELD never counts toward PASS or FAIL. Remove the flag only when the module
 * is allowlisted and tracked.
 */
const SUITES: Array<{ name: string; module: string; heldIfMissing?: boolean }> = [
  // Static lint, no cortex, sub-second — runs first so a suite that has been
  // silently emptied is reported before 300s of behavioural tests.
  // heldIfMissing: true on every suite NOT on scripts/tests-allowlist.txt so a
  // fresh clone of the published runner stays green (HELD, not FAIL).
  { name: 'lint-vacuous-negatives', module: './lint-vacuous-negatives.test.js', heldIfMissing: true },
  { name: 'classification-schema', module: './classification-schema.test.js' },
  { name: 'recall-passages-pure', module: './recall-passages-pure-proof.js', heldIfMissing: true },
  { name: 'recall',          module: './recall.test.js' },
  { name: 'recall-variants', module: './recall-variants.test.js' },
  { name: 'sources',         module: './sources.test.js' },
  { name: 'metadata',        module: './metadata.test.js' },
  { name: 'duplicates',      module: './duplicates.test.js' },
  { name: 'mutations',       module: './mutations.test.js' },
  { name: 'oplog-merge',     module: './oplog-merge.test.js' },
  { name: 'forget-recovery-fidelity', module: './forget-recovery-fidelity.test.js', heldIfMissing: true },
  { name: 'persistence',     module: './persistence.test.js' },
  { name: 'concurrency',     module: './concurrency.test.js' },
  { name: 'settings-matrix', module: './settings-matrix.test.js' },
  { name: 'edge-cases',      module: './edge-cases.test.js' },
  { name: 'skill-walk',      module: './skill-walk.test.js' },
  { name: 'skill-walk-sourceid-resolution', module: './skill-walk-sourceid-resolution.test.js', heldIfMissing: true },
  { name: 'skill-sop-rewrite', module: './skill-sop-rewrite.test.js' },
  { name: 'skill-name-match', module: './skill-name-match.test.js' },
  { name: 'skill-call-lint', module: './skill-call-lint.test.js', heldIfMissing: true },
  { name: 'skill-call-resolver', module: './skill-call-resolver.test.js', heldIfMissing: true },
  { name: 'skill-needs-infer', module: './skill-needs-infer.test.js' },
  { name: 'skill-privacy-lock', module: './skill-privacy-lock.test.js' },
  { name: 'skill-recipe-binding', module: './skill-recipe-binding.test.js' },
  { name: 'contradiction-health', module: './contradiction-health.test.js', heldIfMissing: true },
  { name: 'skill-autonomy',    module: './skill-autonomy.test.js' },
  { name: 'skill-role',        module: './skill-role.test.js', heldIfMissing: true },
  { name: 'engram-autonomy',   module: './engram-autonomy.test.js', heldIfMissing: true },
  { name: 'contradiction-health-scheduler', module: './contradiction-health-scheduler.test.js', heldIfMissing: true },
  { name: 'skill-chunk-singlenode', module: './skill-chunk-singlenode.test.js' },
  { name: 'skill-loop-idempotence', module: './skill-loop-idempotence.test.js' },
  { name: 's7-drift-hook', module: './s7-drift-hook.test.js' },
  { name: 'skill-goal-header-normalize', module: './skill-goal-header-normalize.test.js' },
  { name: 'skills-listing', module: './skills-listing.test.js', heldIfMissing: true },
  { name: 'dispatch-safe-readout', module: './dispatch-safe-readout.test.js' },
  { name: 'per-skill-autonomy', module: './per-skill-autonomy.test.js', heldIfMissing: true },
  { name: 'unattended-executor', module: './unattended-executor.test.js' },
  { name: 'agent-walker-loops', module: './agent-walker-loops.test.js' },
  { name: 'skill-demos-reingest-guard', module: './skill-demos-reingest-guard.test.js', heldIfMissing: true },
  { name: 'gsk-lineage',     module: './gsk-lineage.test.js', heldIfMissing: true },
  { name: 'pack-crypto',     module: './pack-crypto.test.js' },
  { name: 'quarantine-contract', module: './quarantine-contract.test.js' },
  { name: 'agempus-disable-enforcement', module: './agempus-disable-enforcement.test.js', heldIfMissing: true },
  { name: 'mcp-audit',       module: './mcp-audit.test.js' },
  { name: 'mcp-tool-list-changed', module: './mcp-tool-list-changed.test.js', heldIfMissing: true },
  { name: 'llm',             module: './llm.test.js' },
  // Publication-gated proofs — stay gitignored until class (a). HELD on clone.
  { name: 'defect-b-proof',  module: './defect-b-proof.js', heldIfMissing: true },
  { name: 'defect-b-settings-update', module: './defect-b-settings-update-proof.js', heldIfMissing: true },
  { name: 'defect-a-proof',  module: './defect-a-proof.js', heldIfMissing: true },
  { name: 'compliance-schema-server-guard', module: './compliance-schema-server-guard-proof.js', heldIfMissing: true },
  { name: 'compliance-orphan-readout', module: './compliance-orphan-readout-proof.js', heldIfMissing: true },
  { name: 'mdm-classification-palette-report', module: './mdm-classification-palette-report-proof.js', heldIfMissing: true },
];

function isModuleNotFound(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: string; message?: string; cause?: unknown };
  if (err.code === 'ERR_MODULE_NOT_FOUND') return true;
  if (typeof err.message === 'string' && /Cannot find module|ERR_MODULE_NOT_FOUND/.test(err.message)) {
    return true;
  }
  return isModuleNotFound(err.cause);
}

process.on('uncaughtException', (e) => {
  console.error('\n💥 UNCAUGHT:', e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(2);
});
process.on('unhandledRejection', (e) => {
  console.error('\n💥 REJECTION:', e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(2);
});

// ─────────────────────────────────────────────────────────────────────────────
// SIDECAR node:test SUITES (apps/desktop-sidecar/tests/*.test.mjs)
//
// These guard the discarded-correction-outcome class (refusal honesty, GLL /
// op-log write suppression, mint rebinding, recall coverage, …). They are
// node:test files, not `run()`-exporting modules, so they cannot be `import`ed
// into the table above — each is spawned as `node --test` and its TAP summary
// is folded into the SAME results array, the SAME totals and the SAME exit
// code. One runner, one verdict.
//
// The list is DISCOVERED, not hand-maintained: a new sibling .mjs suite is
// registered the moment it lands on disk. That is the actual fix — a hardcoded
// list is the defect that put us here.
//
// ORDERING / STALE-BUILD: these suites import from `dist/`, while the TS suites
// above run against `src/` through tsx. So `compileSidecar()` runs FIRST and is
// itself reported as a suite row — a compile failure is a red run, never a
// silently-green run against a stale dist.
// ─────────────────────────────────────────────────────────────────────────────

function discoverNodeSuites(): string[] {
  return readdirSync(SIDECAR_TESTS)
    .filter((f) => f.endsWith('.test.mjs') && !f.startsWith('_'))
    .sort();
}

interface ExecResult { code: number; stdout: string; stderr: string }

function exec(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function compileSidecar(): Promise<SuiteResult> {
  const started = Date.now();
  const tsc = path.join(SIDECAR_DIR, 'node_modules', '.bin', 'tsc');
  const r = await exec(tsc, ['-p', 'tsconfig.json'], SIDECAR_DIR);
  const durationMs = Date.now() - started;
  if (r.code === 0) {
    return { name: 'sidecar-build', passed: 1, failed: 0, failures: [], sdkNotes: [], durationMs };
  }
  const detail = (r.stdout + r.stderr).trim().split('\n').slice(0, 20);
  return {
    name: 'sidecar-build',
    passed: 0,
    failed: 1,
    failures: [`tsc -p tsconfig.json exited ${r.code}`, ...detail],
    sdkNotes: [],
    durationMs,
  };
}

function parseTap(name: string, r: ExecResult, durationMs: number, prefix = 'sidecar', rerun?: string): SuiteResult {
  const out = r.stdout + '\n' + r.stderr;
  const passMatch = /^# pass (\d+)$/m.exec(out);
  const failMatch = /^# fail (\d+)$/m.exec(out);
  const passed = passMatch ? Number(passMatch[1]) : 0;
  let failed = failMatch ? Number(failMatch[1]) : 0;

  const failures: string[] = [];
  for (const line of out.split('\n')) {
    if (/^not ok \d+ - /.test(line)) failures.push(line.replace(/^not ok \d+ - /, '').trim());
  }
  // A crash before/instead of a TAP summary must not read as "0 pass, 0 fail".
  if (!passMatch || !failMatch) {
    failed = Math.max(failed, 1);
    failures.push(`no TAP summary (exit ${r.code}); tail: ${out.trim().split('\n').slice(-5).join(' | ')}`);
  } else if (failed > 0 && failures.length === 0) {
    failures.push(`${failed} failing assertion(s) — see \`${rerun ?? `node --test tests/${name}.test.mjs`}\``);
  } else if (failed === 0 && r.code !== 0) {
    failed += 1;
    failures.push(`exit ${r.code} despite a clean TAP summary`);
  }
  return { name: `${prefix}:${name}`, passed, failed, failures, sdkNotes: [], durationMs };
}

async function runNodeSuites(files: string[]): Promise<SuiteResult[]> {
  const results = new Array<SuiteResult>(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const file = files[i];
      const name = file.replace(/\.test\.mjs$/, '');
      const started = Date.now();
      const r = await exec(process.execPath, ['--test', '--test-reporter=tap', `tests/${file}`], SIDECAR_DIR);
      results[i] = parseTap(name, r, Date.now() - started);
      const res = results[i];
      console.log(`  ${res.failed > 0 ? '❌' : '✅'} ${res.name.padEnd(46)} ${res.passed} pass / ${res.failed} fail`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(NODE_SUITE_CONCURRENCY, files.length) }, worker),
  );
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// DESKTOP node:test SUITES (tests/desktop/*.test.ts)
//
// `apps/desktop` had NO test surface. The refusal guards in
// `ui/memory-integrity-workbench.ts` and in `main.ts`'s `applyStudioEdit` were
// real fixes that no CI path could defend — the workbench one was only ever
// shown with a throwaway scratch harness, and the `applyStudioEdit` early
// return was structural: nothing executed it. This lane is the fix.
//
// The suites run under jsdom via `tests/desktop/_dom.ts` (which registers
// `_loader.mjs` for Vite's CSS imports and the one vite `resolve.alias`), and
// they drive the SHIPPED modules — `main.ts` is imported whole against the
// app's real `index.html` — with only `fetch('/api/rpc')` faked.
//
// Like the sidecar lane: DISCOVERED, not hand-maintained; spawned as
// `node --import tsx --test`; folded into the SAME totals and exit code.
//
// Each suite gets its own process on purpose. They install jsdom globals
// (window, document, navigator) onto `globalThis` and import ~28k lines of
// front-end module state; sharing a process with the tsx suites above — or
// with each other — would let one suite's DOM leak into the next.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Typecheck the lane's own sources.
 *
 * The desktop suites run through tsx, which strips types without checking
 * them — the same class of blind spot the sidecar lane closes by compiling
 * dist/ first. Scoped to `tests/desktop/**` only: `apps/desktop` itself has
 * 344 pre-existing tsc errors and is NOT typechecked here.
 */
async function typecheckDesktopLane(): Promise<SuiteResult> {
  const started = Date.now();
  const tsc = path.join(SIDECAR_DIR, 'node_modules', '.bin', 'tsc');
  const r = await exec(tsc, ['-p', 'tests/desktop/tsconfig.json'], REPO_ROOT);
  const durationMs = Date.now() - started;
  if (r.code === 0) {
    return { name: 'desktop-lane-typecheck', passed: 1, failed: 0, failures: [], sdkNotes: [], durationMs };
  }
  const detail = (r.stdout + r.stderr).trim().split('\n').slice(0, 20);
  return {
    name: 'desktop-lane-typecheck',
    passed: 0,
    failed: 1,
    failures: [`tsc -p tests/desktop/tsconfig.json exited ${r.code}`, ...detail],
    sdkNotes: [],
    durationMs,
  };
}

function discoverDesktopSuites(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(DESKTOP_TESTS);
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith('.test.ts') && !f.startsWith('_')).sort();
}

async function runDesktopSuites(files: string[]): Promise<SuiteResult[]> {
  const results = new Array<SuiteResult>(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const file = files[i];
      const name = file.replace(/\.test\.ts$/, '');
      const rel = `tests/desktop/${file}`;
      const started = Date.now();
      const r = await exec(
        process.execPath,
        ['--import', 'tsx', '--test', '--test-reporter=tap', rel],
        REPO_ROOT,
      );
      results[i] = parseTap(name, r, Date.now() - started, 'desktop', `node --import tsx --test ${rel}`);
      const res = results[i];
      console.log(`  ${res.failed > 0 ? '❌' : '✅'} ${res.name.padEnd(46)} ${res.passed} pass / ${res.failed} fail`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(NODE_SUITE_CONCURRENCY, files.length) }, worker),
  );
  return results;
}

interface AggregateResult {
  results: SuiteResult[];
  totalPassed: number;
  totalFailed: number;
  totalHeld: number;
  totalSdkNotes: number;
  totalDurationMs: number;
}

/**
 * Typecheck the vacuous-negative-assertion lint engine.
 *
 * Same reasoning as `typecheckDesktopLane`: the engine runs through tsx, which
 * strips types without checking them, and it is a static analyzer built out of
 * offset arithmetic and partial parses — the one place where a silent type
 * error becomes a silent false negative. Scoped to that one file.
 */
async function typecheckLintLane(): Promise<SuiteResult> {
  const started = Date.now();
  const tsc = path.join(SIDECAR_DIR, 'node_modules', '.bin', 'tsc');
  const r = await exec(tsc, ['-p', 'tests/lint/tsconfig.json'], REPO_ROOT);
  const durationMs = Date.now() - started;
  if (r.code === 0) {
    return { name: 'lint-lane-typecheck', passed: 1, failed: 0, failures: [], sdkNotes: [], durationMs };
  }
  const detail = (r.stdout + r.stderr).trim().split('\n').slice(0, 20);
  return {
    name: 'lint-lane-typecheck',
    passed: 0,
    failed: 1,
    failures: [`tsc -p tests/lint/tsconfig.json exited ${r.code}`, ...detail],
    sdkNotes: [],
    durationMs,
  };
}

async function runAll(): Promise<AggregateResult> {
  const results: SuiteResult[] = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalHeld = 0;
  let totalDurationMs = 0;
  const allSdkNotes: SdkNote[] = [];

  const lintCheck = await typecheckLintLane();
  results.push(lintCheck);
  totalPassed += lintCheck.passed;
  totalFailed += lintCheck.failed;
  totalDurationMs += lintCheck.durationMs;
  console.log(`  ${lintCheck.failed > 0 ? '❌' : '✅'} ${lintCheck.name.padEnd(46)} ${lintCheck.passed} pass / ${lintCheck.failed} fail`);

  for (const s of SUITES) {
    console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
    console.log(`║  RUNNING: ${s.name.padEnd(54)}║`);
    console.log(`╚══════════════════════════════════════════════════════════════════╝`);
    try {
      const mod = await import(s.module);
      if (typeof mod.run !== 'function') {
        results.push({
          name: s.name,
          passed: 0, failed: 1,
          failures: [`Suite ${s.name} has no exported run() function`],
          sdkNotes: [],
          durationMs: 0,
        });
        totalFailed += 1;
        continue;
      }
      const r: SuiteResult = await mod.run();
      results.push(r);
      totalPassed += r.passed;
      totalFailed += r.failed;
      totalDurationMs += r.durationMs;
      allSdkNotes.push(...r.sdkNotes);
    } catch (e) {
      // DEC.1 (d): publication-gated rows report HELD when the module is not
      // in the tree. HELD is not PASS (0 toward green) and not FAIL (exit 0).
      if (s.heldIfMissing && isModuleNotFound(e)) {
        const held: SuiteResult = {
          name: s.name,
          passed: 0,
          failed: 0,
          failures: [`HELD — not published (${s.module} absent from this tree)`],
          sdkNotes: [],
          durationMs: 0,
          held: true,
        };
        results.push(held);
        totalHeld += 1;
        console.log(`  ⏸  ${s.name.padEnd(46)} HELD — not published`);
        continue;
      }
      results.push({
        name: s.name,
        passed: 0, failed: 1,
        failures: [`Crash: ${(e as Error).message}`],
        sdkNotes: [],
        durationMs: 0,
      });
      totalFailed += 1;
    }
  }

  // ── Sidecar node:test family ─────────────────────────────────────────────
  const nodeFiles = discoverNodeSuites();
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  RUNNING: ${`sidecar node:test × ${nodeFiles.length}`.padEnd(54)}║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝`);

  const build = await compileSidecar();
  results.push(build);
  totalPassed += build.passed;
  totalFailed += build.failed;
  totalDurationMs += build.durationMs;

  if (build.failed > 0) {
    console.log(`  ❌ sidecar-build FAILED — skipping ${nodeFiles.length} node:test suites (they run against dist/)`);
    for (const f of nodeFiles) {
      results.push({
        name: `sidecar:${f.replace(/\.test\.mjs$/, '')}`,
        passed: 0, failed: 1,
        failures: ['not run: sidecar-build failed'],
        sdkNotes: [], durationMs: 0,
      });
      totalFailed += 1;
    }
  } else {
    const nodeResults = await runNodeSuites(nodeFiles);
    for (const r of nodeResults) {
      results.push(r);
      totalPassed += r.passed;
      totalFailed += r.failed;
      totalDurationMs += r.durationMs;
    }
  }

  // ── Desktop (apps/desktop) node:test family ──────────────────────────────
  const desktopFiles = discoverDesktopSuites();
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  RUNNING: ${`desktop node:test × ${desktopFiles.length}`.padEnd(54)}║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝`);
  if (desktopFiles.length === 0) {
    // Not a silent skip: `apps/desktop` having no lane is the exact defect
    // this section exists to prevent, so an empty directory is a red run.
    results.push({
      name: 'desktop',
      passed: 0, failed: 1,
      failures: [`no suites found in ${DESKTOP_TESTS} — the apps/desktop lane is missing`],
      sdkNotes: [], durationMs: 0,
    });
    totalFailed += 1;
  } else {
    const laneCheck = await typecheckDesktopLane();
    results.push(laneCheck);
    totalPassed += laneCheck.passed;
    totalFailed += laneCheck.failed;
    totalDurationMs += laneCheck.durationMs;
    console.log(`  ${laneCheck.failed > 0 ? '❌' : '✅'} ${laneCheck.name.padEnd(46)} ${laneCheck.passed} pass / ${laneCheck.failed} fail`);

    const desktopResults = await runDesktopSuites(desktopFiles);
    for (const r of desktopResults) {
      results.push(r);
      totalPassed += r.passed;
      totalFailed += r.failed;
      totalDurationMs += r.durationMs;
    }
  }

  // ── Summary table ────────────────────────────────────────────────────────
  console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  AGGREGATE SUMMARY                                                ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝`);
  console.log(`\n  ${'SUITE'.padEnd(38)}${'PASS'.padStart(7)}${'FAIL'.padStart(7)}${'HELD'.padStart(7)}${'NOTES'.padStart(7)}${'TIME'.padStart(9)}`);
  console.log(`  ${'─'.repeat(75)}`);
  for (const r of results) {
    const time = `${(r.durationMs / 1000).toFixed(1)}s`;
    const held = r.held ? '1' : '0';
    console.log(`  ${r.name.padEnd(38)}${String(r.passed).padStart(7)}${String(r.failed).padStart(7)}${held.padStart(7)}${String(r.sdkNotes.length).padStart(7)}${time.padStart(9)}`);
  }
  console.log(`  ${'─'.repeat(75)}`);
  const totalTime = `${(totalDurationMs / 1000).toFixed(1)}s`;
  console.log(`  ${'TOTAL'.padEnd(38)}${String(totalPassed).padStart(7)}${String(totalFailed).padStart(7)}${String(totalHeld).padStart(7)}${String(allSdkNotes.length).padStart(7)}${totalTime.padStart(9)}`);
  if (totalHeld > 0) {
    console.log(`\n  ⏸  ${totalHeld} suite(s) HELD — not published. HELD is not PASS and does not fail the run.`);
  }

  // ── Failures detail ──────────────────────────────────────────────────────
  if (totalFailed > 0) {
    console.log(`\n  ❌ FAILED ASSERTIONS:`);
    for (const r of results) {
      if (r.held || r.failures.length === 0) continue;
      console.log(`\n  [${r.name}]`);
      for (const f of r.failures) console.log(`    - ${f}`);
    }
  }
  if (totalHeld > 0) {
    console.log(`\n  ⏸  HELD (absent modules):`);
    for (const r of results) {
      if (!r.held) continue;
      console.log(`\n  [${r.name}]`);
      for (const f of r.failures) console.log(`    - ${f}`);
    }
  }

  // ── SDK observations block ───────────────────────────────────────────────
  if (allSdkNotes.length > 0) {
    console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
    console.log(`║  📋 SDK OBSERVATIONS (advisory — not failures)                    ║`);
    console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);
    // Group by suite.
    const bySuite = new Map<string, SdkNote[]>();
    for (const n of allSdkNotes) {
      const arr = bySuite.get(n.suite) ?? [];
      arr.push(n);
      bySuite.set(n.suite, arr);
    }
    for (const [suite, notes] of bySuite) {
      console.log(`  ▸ ${suite}`);
      for (const n of notes) {
        console.log(`    • ${n.label}`);
        console.log(`        observation: ${n.observation}`);
        console.log(`        suggestion:  ${n.suggestion}`);
      }
      console.log();
    }
  }

  return { results, totalPassed, totalFailed, totalHeld, totalSdkNotes: allSdkNotes.length, totalDurationMs };
}

void (async () => {
  const r = await runAll();
  process.exit(r.totalFailed > 0 ? 1 : 0);
})();
