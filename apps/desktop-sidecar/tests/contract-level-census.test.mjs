// @disclosure: (a) publishable — Version/shape tripwire + contract-level roll-up.
//   Asserts installed package versions and that federation/correction type
//   surfaces still lack fields reserved for a future pin. No defect
//   reproduction. Owner reclass from (b) 2026-08-06 so the tripwire can gate
//   pin moves in CI (SS040.5).
// @disclosure-src: 2.59a §5.2 · promoted from held 2026-08-06
/**
 * THE AGGREGATE: how much of this directory's green total is NOT end-to-end.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `node --test tests/` ends with a single number. Read on its own that number
 * says "N facts about the shipped product hold". For a meaningful slice of this
 * directory it does not: those tests assert against a dependency version that is
 * NOT INSTALLED, so they execute but no production run on this build can reach
 * the state they describe.
 *
 * Per-file labelling (`tests/_contract-level.mjs`) puts a `[CONTRACT-ONLY: …]`
 * prefix on each such test name and prints a per-file banner. That is enough for
 * a reader of the OUTPUT. It is not enough for a reader of the TOTAL, who sees
 * one number and moves on. So this file prints the roll-up, and — more
 * importantly — ASSERTS it, so the roll-up cannot quietly go stale.
 *
 * WHAT IT ASSERTS
 * ---------------
 *  1. every census entry names a file that exists and actually routes its tests
 *     through the helper (so an entry cannot describe a file that stopped using
 *     it and go on being counted);
 *  2. the `contract` / `reachable` numbers pinned for each file match the
 *     `test.contract(` / `test(` call sites actually present in it;
 *  3. no OTHER test file in this directory uses `test.contract` without a census
 *     entry — a new contract-level test cannot dodge the roll-up;
 *  4. the version gates the census rests on are re-read from the INSTALLED
 *     packages, not trusted from a comment. This is the load-bearing one: the
 *     whole reachability argument is "the installed dependency cannot produce
 *     this", and the day it can, these labels become the lie instead.
 *
 * (2) is belt-and-braces with the per-file `after()` hook in `_contract-level.mjs`,
 * which counts REGISTRATIONS at runtime. This one counts CALL SITES in the
 * source. They disagree if a test is registered in a loop or behind a branch,
 * which is itself worth failing over in a census.
 *
 * Run after build: node --test tests/contract-level-census.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CENSUS, CONTRACT_TAG } from './_contract-level.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.resolve(HERE, '..');
const read = (p) => readFileSync(p, 'utf8');

/** Count `test.contract(` / `test(` call sites at the start of a line. */
function callSites(source) {
  return {
    contract: (source.match(/^test\.contract\(/gm) ?? []).length,
    reachable: (source.match(/^test\(/gm) ?? []).length,
  };
}

const files = Object.keys(CENSUS);

test('every census entry names a real file that routes through the helper', () => {
  for (const file of files) {
    const source = read(path.join(HERE, file));
    assert.match(
      source,
      /contractLevelSuite\(/,
      `${file} has a census entry but no longer calls contractLevelSuite() — ` +
      `its tests would be counted as end-to-end again.`,
    );
    assert.ok(
      source.includes(`contractLevelSuite('${file}')`),
      `${file} must pass its OWN name to contractLevelSuite, or it is reporting under another file's entry.`,
    );
  }
});

test('the pinned split matches the call sites actually present in each file', () => {
  const drift = [];
  for (const file of files) {
    const seen = callSites(read(path.join(HERE, file)));
    const pinned = CENSUS[file];
    if (seen.contract !== pinned.contract || seen.reachable !== pinned.reachable) {
      drift.push(
        `${file}: source has ${seen.contract} contract-level / ${seen.reachable} reachable, ` +
        `census pins ${pinned.contract}/${pinned.reachable}`,
      );
    }
  }
  assert.deepEqual(
    drift, [],
    'Re-verify reachability against the INSTALLED artifact before touching the census. ' +
    'Moving a number to silence this is how the overstatement came back.',
  );
});

test('no test file outside the census smuggles in a contract-level test', () => {
  const unregistered = readdirSync(HERE)
    .filter((f) => f.endsWith('.test.mjs') && !files.includes(f) && f !== 'contract-level-census.test.mjs')
    .filter((f) => /test\.contract\(|contractLevelSuite\(/.test(read(path.join(HERE, f))));
  assert.deepEqual(
    unregistered, [],
    'these files use the contract-level helper but have no census entry, so the roll-up below undercounts',
  );
});

test('the version gates the census rests on still hold on the INSTALLED packages', () => {
  const version = (pkg) =>
    JSON.parse(read(path.join(SIDECAR, 'node_modules', pkg, 'package.json'))).version;

  // secure-sync 0.4.0 (SS040.5): the producer that reports per-graph outcomes
  // IS installed. Assert the SHAPE is present — a pin that claims 0.4.0 but
  // ships the old AttachedGraphAudit flat row would silently re-disable
  // incomplete-recall disclosure. Re-censused 2026-08-06: recall-coverage
  // suites moved contract→reachable (contract:0 in _contract-level.mjs).
  assert.equal(version('@nehloo-interactive/graphnosis-secure-sync'), '0.4.0',
    'secure-sync moved. Re-derive which recall-coverage tests are reachable before trusting the census.');
  const fed = read(path.join(SIDECAR, 'node_modules/@nehloo-interactive/graphnosis-secure-sync/dist/federation/index.d.ts'));
  assert.ok(
    /complete:\s*true/.test(fed) && /complete:\s*false/.test(fed),
    'federation 0.4.0 must declare the complete/incomplete discriminated union',
  );
  assert.ok(
    /^\s*failures:/.test(fed) || /failures:\s*GraphFailure/.test(fed),
    'federation 0.4.0 must declare `failures` on the incomplete branch',
  );
  assert.ok(
    /status:\s*'ok'|status:\s*'failed'|GraphRecallStatus/.test(fed),
    'federation 0.4.0 must declare audit status (ok|failed)',
  );
  // Guard the regression: flat AttachedGraphAudit without status must stay gone.
  assert.ok(
    !/interface AttachedGraphAudit/.test(fed),
    'AttachedGraphAudit returned — incomplete-recall disclosure would go dark again',
  );

  // SDK 0.11.0: indelible edit + CorrectionResult.affectedNodeIds are live.
  // Re-censused 2026-08-06 with PLAN.4 asciiFoldAnalyzer pin on App creates.
  // Shape gate FLIPPED — absence of affectedNodeIds would mean we pinned the
  // wrong artifact and the mint-id merge path went dark again.
  assert.equal(version('@nehloo/graphnosis'), '0.11.0',
    'the SDK moved. Re-derive oplog-replay-source-rebind / indelible-edit-node-id before trusting the census.');
  const corrections = read(path.join(SIDECAR, 'node_modules/@nehloo/graphnosis/dist/core/corrections/correction-engine.d.ts'));
  assert.ok(
    /affectedNodeIds/.test(corrections),
    'CorrectionResult on 0.11.0 must carry affectedNodeIds',
  );
});

test('the roll-up is printed, so the green total cannot be read as end-to-end coverage', () => {
  let contract = 0;
  let reachable = 0;
  const rows = [];
  for (const file of files) {
    const e = CENSUS[file];
    contract += e.contract;
    reachable += e.reachable;
    rows.push(`  ${String(e.contract).padStart(3)} of ${String(e.contract + e.reachable).padEnd(3)} ${file}`);
    rows.push(`${' '.repeat(11)}dependency : ${e.dependency}`);
    rows.push(`${' '.repeat(11)}installed  : ${e.installed}`);
    rows.push(`${' '.repeat(11)}required   : ${e.required}`);
  }
  // Deliberately NOT printing a directory-wide denominator computed from these
  // regexes. It would undercount every suite that registers tests any other way
  // — and shipping a number that is quietly wrong is the exact habit this file
  // exists to break. The reader gets the two commands that produce the real
  // figures from the runner itself instead.
  process.stderr.write(
    `\n════ CONTRACT-LEVEL CENSUS — apps/desktop-sidecar/tests ════\n` +
    (contract > 0
      ? `${contract} tests in this directory are CONTRACT-LEVEL against a dependency\n` +
        `version that is NOT INSTALLED. They run, and their assertions are enforced,\n` +
        `but no production run on this build can reach the state they describe.\n` +
        `DO NOT read the suite's pass total as that much end-to-end coverage.\n\n`
      : `No CONTRACT-LEVEL tests remain — every formerly latent producer in this\n` +
        `census is now installed (secure-sync 0.4.0 + SDK 0.11.0). The files below\n` +
        `still route through contractLevelSuite so a future pin regress cannot\n` +
        `quietly revive an unlabelled contract column.\n\n`) +
    `${rows.join('\n')}\n\n` +
    `  contract-level : ${contract}\n` +
    `  reachable      : ${reachable}  (within these ${files.length} files only)\n\n` +
    `Every contract-level test is tagged ${CONTRACT_TAG} in its own name, so the\n` +
    `ratio can be recomputed from the runner rather than trusted from here.\n` +
    `Numerator, then denominator:\n` +
    `  node --test tests/ 2>/dev/null | grep -c "^ok .*${CONTRACT_TAG}"\n` +
    `  node --test tests/ 2>/dev/null | grep -c "^ok "\n` +
    `════════════════════════════════════════════════════════════\n`,
  );

  // Census files must stay registered. contract:0 is legitimate once every
  // producer those suites were waiting on is installed (SS 0.4 + SDK 0.11).
  assert.ok(files.length > 0, 'the census has no entries — the labelling has come undone');
  assert.equal(contract + reachable, files.reduce((n, f) => {
    const s = callSites(read(path.join(HERE, f)));
    return n + s.contract + s.reachable;
  }, 0));
});
