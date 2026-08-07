// Shared test helpers for the Graphnosis consistency suite.
// Used by every tests/*.test.ts file.
//
// The suite is gitignored (per user choice) — these helpers live alongside
// the test files in apps/desktop-sidecar/tests/. Imports reach back into the
// sidecar's src/ via `../src/`.
//
// Design notes:
//   - Every test gets a FRESH tmpdir cortex via setupTestCortex(). No shared
//     state between tests. Cleanup runs on success and on error.
//   - Assertions use bare `assert(cond, label, detail?)` with module-level
//     pass/fail counters that the runner reads after each suite completes.
//   - `sdkNote(label, observation, suggestion)` is an ADVISORY log — it never
//     fails the suite, but each note is collected and printed in the final
//     SDK OBSERVATIONS block. This is how we capture SDK-level quirks
//     surfaced by the App's consistency tests without changing the SDK in
//     this round.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { policy } from '@nehloo-interactive/graphnosis-secure-sync';
import { GraphnosisHost } from '../apps/desktop-sidecar/src/host.js';
import { GraphnosisImpl } from '../apps/desktop-sidecar/src/graphnosis-impl.js';
import { ROSTER, EVENT, DOCS_RETURN, DOCS_HOWITWORKS, PEOPLE_PAUL, SENSITIVE_NOTE } from './_fixtures.js';

// ── Module-level counters (consumed by runSuite + run-all) ─────────────────
export interface SuiteResult {
  name: string;
  passed: number;
  failed: number;
  failures: string[];
  sdkNotes: SdkNote[];
  durationMs: number;
  /**
   * Publication-gated suite whose module is absent from this tree (gitignored
   * proof, not yet allowlisted). Structurally distinct from pass and fail:
   * never increments pass totals, never fails the aggregate exit code.
   */
  held?: boolean;
}

export interface SdkNote {
  suite: string;
  label: string;
  observation: string;
  suggestion: string;
}

let currentSuite = 'unnamed';
let passed = 0;
let failed = 0;
const failures: string[] = [];
const sdkNotes: SdkNote[] = [];

export function setSuiteName(name: string): void {
  currentSuite = name;
}

export function section(name: string): void {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${name}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

export function assert(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) {
      const s = JSON.stringify(detail, null, 2);
      console.log(`    detail: ${s.length > 800 ? s.slice(0, 800) + '…' : s}`);
    }
  }
}

/** Soft assertion: prints + records an SDK-level observation without failing
 *  the suite. The aggregate runner collects these and prints them under
 *  "SDK OBSERVATIONS" so they can be discussed and planned separately. */
export function sdkNote(label: string, observation: string, suggestion: string): void {
  sdkNotes.push({ suite: currentSuite, label, observation, suggestion });
  console.log(`  📋 SDK NOTE: ${label}`);
  console.log(`     ${observation}`);
  console.log(`     suggestion: ${suggestion}`);
}

export function getSuiteCounters(): { passed: number; failed: number; failures: string[]; sdkNotes: SdkNote[] } {
  return { passed, failed, failures: [...failures], sdkNotes: [...sdkNotes] };
}

export function resetSuiteCounters(): void {
  passed = 0;
  failed = 0;
  failures.length = 0;
  sdkNotes.length = 0;
}

// ── Cortex setup ───────────────────────────────────────────────────────────

export interface TestCortex {
  host: GraphnosisHost;
  cortexDir: string;
  passphrase: string;
  /** Re-open the same cortex (e.g. for persistence tests). The existing
   *  `host` field becomes stale — use the returned host. */
  reopen: (deviceId?: string) => Promise<GraphnosisHost>;
  cleanup: () => Promise<void>;
}

/** Standard test cortex: 4 engrams (work, people, docs at personal tier;
 *  secrets at sensitive tier). Fresh tmpdir, fresh passphrase, fresh state. */
export async function setupTestCortex(name: string): Promise<TestCortex> {
  const cortexDir = path.join(os.tmpdir(), `gn-${name}-${process.pid}-${Date.now()}`);
  const passphrase = `test-${name}`;
  await fs.rm(cortexDir, { recursive: true, force: true });

  const policyCfg: policy.PolicyConfig = {
    defaultBudget: policy.DEFAULT_BUDGET,
    graphs: [
      { graphId: 'work',     shareWithAi: true, tier: 'personal' },
      { graphId: 'people',   shareWithAi: true, tier: 'personal' },
      { graphId: 'docs',     shareWithAi: true, tier: 'personal' },
      { graphId: 'secrets',  shareWithAi: true, tier: 'sensitive' },
    ],
  };

  const { host } = await GraphnosisHost.open({
    cortexDir,
    passphrase,
    deviceId: `test-${name}`,
    adapter: new GraphnosisImpl(),
    policy: policyCfg,
  });

  return {
    host,
    cortexDir,
    passphrase,
    reopen: async (deviceId = `test-${name}-reopen`) => {
      const opened = await GraphnosisHost.open({
        cortexDir,
        passphrase,
        deviceId,
        adapter: new GraphnosisImpl(),
        policy: policyCfg,
      });
      return opened.host;
    },
    cleanup: async () => {
      try { await fs.rm(cortexDir, { recursive: true, force: true }); } catch {}
    },
  };
}

/** Ingest the standard 5-source fixture set into the test cortex.
 *  This is the SAME data across most suites so failures are comparable.
 *  Returns the actual sourceIds (computed by makeSourceId(kind, ref)) so
 *  tests can pass them to forgetSource / recallSource. */
export interface SeedSourceIds {
  roster: string;
  event: string;
  docsReturn: string;
  docsHowItWorks: string;
  paul: string;
}
export async function seedStandardData(host: GraphnosisHost): Promise<SeedSourceIds> {
  await host.createGraph('work');
  await host.createGraph('people');
  await host.createGraph('docs');

  const roster      = await host.ingest('work',   'clip', 'work:roster',  { kind: 'markdown', content: ROSTER,          sourceRef: 'work:roster' });
  const event       = await host.ingest('work',   'clip', 'work:event',   { kind: 'markdown', content: EVENT,           sourceRef: 'work:event' });
  const docsReturn  = await host.ingest('docs',   'clip', 'docs:return',  { kind: 'markdown', content: DOCS_RETURN,     sourceRef: 'docs:return' });
  const docsHowit   = await host.ingest('docs',   'clip', 'docs:howit',   { kind: 'markdown', content: DOCS_HOWITWORKS, sourceRef: 'docs:howit' });
  const paul        = await host.ingest('people', 'clip', 'people:paul',  { kind: 'markdown', content: PEOPLE_PAUL,     sourceRef: 'people:paul' });

  return {
    roster: roster.sourceId,
    event: event.sourceId,
    docsReturn: docsReturn.sourceId,
    docsHowItWorks: docsHowit.sourceId,
    paul: paul.sourceId,
  };
}

/** Seed sensitive engram for tier-gating tests (separate so most suites
 *  don't pay the cost or trip the consent gate accidentally). */
export async function seedSensitive(host: GraphnosisHost): Promise<void> {
  await host.createGraph('secrets');
  await host.ingest('secrets', 'clip', 'secrets:codeword', {
    kind: 'markdown', content: SENSITIVE_NOTE, sourceRef: 'secrets:codeword',
  });
}

/** Bulk-ingest N synthetic nodes into `work` engram for concurrency/stress.
 *  Each node is distinct so dedup doesn't collapse them. */
export async function seedLargeCortex(host: GraphnosisHost, n: number): Promise<void> {
  await host.createGraph('work');
  const lines = Array.from({ length: n }, (_, i) =>
    `# Note ${i + 1}\nThis is synthetic content item ${i + 1}. Keyword bulk-${i + 1} unique-${i + 1}.`,
  ).join('\n\n');
  await host.ingest('work', 'clip', 'work:bulk', {
    kind: 'markdown', content: lines, sourceRef: 'work:bulk',
  });
}

// ── Recall result helpers ─────────────────────────────────────────────────

export type RecallResult = Awaited<ReturnType<GraphnosisHost['recall']>>;

export interface RecallSummary {
  graphs: string[];
  topNodeIds: string[];
  /** Full text per node — use for substring assertions like .includes('tudor'). */
  topTextsFull: string[];
  /** 80-char preview per node — use for log output, not assertions. */
  topTexts: string[];
  topScores: number[];
}

/** Stable flatten + sort: score DESC, nodeId ASC for tie-breaking.
 *  Tied scores would otherwise sort unstably and produce false
 *  "non-deterministic" failures. */
export function summarizeRecall(r: RecallResult): RecallSummary {
  const flat: Array<{ graphId: string; nodeId: string; score: number; text: string }> = [];
  for (const [graphId, nodes] of r.byGraph) {
    for (const n of nodes) flat.push({ graphId, nodeId: n.nodeId, score: n.score, text: n.text });
  }
  flat.sort((a, b) => (b.score - a.score) || a.nodeId.localeCompare(b.nodeId));
  return {
    graphs: [...r.byGraph.keys()],
    topNodeIds: flat.map((n) => n.nodeId),
    topTextsFull: flat.map((n) => n.text),
    topTexts: flat.map((n) => n.text.slice(0, 80)),
    topScores: flat.map((n) => n.score),
  };
}

export function withinEps(a: number[], b: number[], eps: number): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => Math.abs(v - (b[i] ?? 0)) < eps);
}

// ── Suite runner ──────────────────────────────────────────────────────────

/** Run one suite, return its result. Resets counters between suites. */
export async function runSuite(name: string, fn: () => Promise<void>): Promise<SuiteResult> {
  resetSuiteCounters();
  setSuiteName(name);
  const start = Date.now();
  try {
    await fn();
  } catch (e) {
    failed++;
    failures.push(`SUITE CRASH: ${(e as Error).message}`);
    console.error(`\n  ❌ Suite "${name}" crashed:`, e);
  }
  const durationMs = Date.now() - start;
  const counters = getSuiteCounters();
  return {
    name,
    passed: counters.passed,
    failed: counters.failed,
    failures: counters.failures,
    sdkNotes: counters.sdkNotes,
    durationMs,
  };
}

/** Standalone entrypoint helper: when a test file is run directly (not via
 *  run-all), it calls `await standalone('recall', runRecallSuite)` and gets
 *  a process.exit(0|1). When imported by run-all, it calls the exported
 *  `run()` function which returns a SuiteResult. */
export async function standalone(name: string, fn: () => Promise<void>): Promise<void> {
  // Catch + pretty-print uncaught errors at the suite level — ts-node/esm's
  // default handler prints them as opaque null-prototype objects with no
  // stack, which makes debugging nearly impossible.
  process.on('uncaughtException', (e) => {
    console.error('\n💥 UNCAUGHT EXCEPTION:');
    console.error(e instanceof Error ? (e.stack ?? e.message) : JSON.stringify(e, null, 2));
    process.exit(2);
  });
  process.on('unhandledRejection', (e) => {
    console.error('\n💥 UNHANDLED REJECTION:');
    console.error(e instanceof Error ? (e.stack ?? e.message) : JSON.stringify(e, null, 2));
    process.exit(2);
  });
  try {
    const r = await runSuite(name, fn);
    printSuiteSummary(r);
    process.exit(r.failed > 0 ? 1 : 0);
  } catch (e) {
    console.error('\n💥 SUITE CRASH:');
    console.error(e instanceof Error ? (e.stack ?? e.message) : JSON.stringify(e, null, 2));
    process.exit(2);
  }
}

export function printSuiteSummary(r: SuiteResult): void {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  SUMMARY — ${r.name}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  PASSED: ${r.passed}`);
  console.log(`  FAILED: ${r.failed}`);
  console.log(`  TIME:   ${(r.durationMs / 1000).toFixed(1)}s`);
  if (r.failures.length > 0) {
    console.log(`\n  FAILED tests:`);
    for (const f of r.failures) console.log(`    - ${f}`);
  }
  if (r.sdkNotes.length > 0) {
    console.log(`\n  📋 SDK OBSERVATIONS (advisory):`);
    for (const n of r.sdkNotes) {
      console.log(`    - ${n.label}`);
      console.log(`      ${n.observation}`);
      console.log(`      suggestion: ${n.suggestion}`);
    }
  }
}
