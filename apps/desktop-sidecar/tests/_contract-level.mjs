// @disclosure: (a) publishable — Harness only — registers the contract-level test
//   lane and carries the census payload. No defect mechanism, no shipped-build claim.
// @disclosure-src: reclassified (b) -> (a) 2026-08-03 by owner decision (Q1 A). Held as
//   (b) fix-not-adopted, it broke a fresh clone: the TRACKED suite
//   indelible-edit-node-id.test.mjs imports it, so a clean checkout hit
//   ERR_MODULE_NOT_FOUND and silently dropped 11 tests (157 with 1 hard failure, vs
//   167/167 with it present). A held helper that a published suite imports is not held.
/**
 * CONTRACT-LEVEL TESTS — the ones a green total must not be read as covering.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some suites in this directory assert against a dependency version that is
 * NOT INSTALLED. Their assertions are correct and they really do execute — but
 * the state they describe cannot arise from any production run on the build
 * that is actually here, because the producer of that state does not exist yet.
 * They are contract tests for a future dependency wearing the same clothes as
 * an end-to-end test.
 *
 * Left unlabelled, `# pass 338` reads as 338 facts about the shipped product.
 * It is not. This module makes the difference visible in three places at once:
 *
 *   1. IN EVERY TEST NAME. A contract-level test is registered with a
 *      `[CONTRACT-ONLY …]` prefix, so the runner's own `ok N - …` line carries
 *      it. Nothing has to be read alongside the output to see it, and
 *      `node --test tests/ | grep -c CONTRACT-ONLY` counts them.
 *   2. IN A PER-FILE BANNER printed after the file's tests, naming the
 *      dependency, the version installed, the version required, and the
 *      evidence for the claim.
 *   3. IN AN AGGREGATE, asserted and printed by `contract-level-census.test.mjs`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not `skip` and it does not mark `todo`. Both would stop these
 * assertions from failing the build, and the assertions are the only thing
 * holding these contracts in place — `recall-coverage.ts` in particular has NO
 * other coverage, since every one of its interesting branches is contract-level.
 * A label is the honest fix; disabling would trade an overstated number for a
 * silently rotting module. Every assertion still runs and still fails the run.
 *
 * DRIFT PROTECTION
 * ----------------
 * Each entry below pins the census. A file whose observed counts stop matching
 * its entry fails — so a new test cannot quietly join either column, and a
 * contract-level test cannot quietly become "reachable" by relabelling.
 */
import { test as nodeTest, after } from 'node:test';

/**
 * The pinned census. `contract` + `reachable` must equal the number of tests
 * the file registers through this helper.
 *
 * `installed` / `required` are the MEASURED and the NEEDED version of the
 * dependency that gates the contract-level column, and `evidence` is how to
 * re-verify the gate without trusting this comment.
 */
export const CENSUS = Object.freeze({
  'recall-coverage-partial.test.mjs': {
    dependency: '@nehloo-interactive/graphnosis-secure-sync',
    installed: '0.4.0',
    required: 'a federation that reports per-graph outcomes',
    tag: 'secure-sync 0.4.0 — coverage disclosure is live (no contract column)',
    evidence:
      'node_modules/@nehloo-interactive/graphnosis-secure-sync/dist/federation/index.d.ts — ' +
      '`FederatedSubgraph` is `CompleteFederatedSubgraph | IncompleteFederatedSubgraph` with ' +
      '`complete` / `failures` / `withheld`; audit rows are `AnsweredGraphAudit | FailedGraphAudit`. ' +
      'Re-verified on installed 0.4.0. Re-censused 2026-08-06: former CONTRACT-ONLY rows ' +
      'became reachable when the producer landed.',
    why:
      'Kept in the census so the suite still routes through contractLevelSuite (drift ' +
      'protection). contract:0 because 0.4.0 can emit every shape these tests assert.',
    contract: 0,
    reachable: 15,
  },
  'recall-coverage-withheld.test.mjs': {
    dependency: '@nehloo-interactive/graphnosis-secure-sync',
    installed: '0.4.0',
    required: 'a federation that reports per-graph outcomes',
    tag: 'secure-sync 0.4.0 — coverage disclosure is live (no contract column)',
    evidence: 'same as recall-coverage-partial.test.mjs',
    why:
      'Privacy properties of withheld+failed are now production shapes; still unit-tested ' +
      'with synthetic inputs for the intersection e2e cannot safely force.',
    contract: 0,
    reachable: 6,
  },
  'recall-partial-prompt.test.mjs': {
    dependency: '@nehloo-interactive/graphnosis-secure-sync',
    installed: '0.4.0',
    required: 'a federation that reports per-graph outcomes',
    tag: 'secure-sync 0.4.0 — coverage disclosure is live (no contract column)',
    evidence: 'same as recall-coverage-partial.test.mjs',
    why:
      'Partial-path tests stamp incomplete shapes for determinism; the producer that ' +
      'emits them is installed, so they are no longer CONTRACT-ONLY.',
    contract: 0,
    reachable: 5,
  },
  'oplog-replay-source-rebind.test.mjs': {
    dependency: '@nehloo/graphnosis',
    installed: '0.11.0',
    required: '0.10.0 (indelible `edit`)',
    tag: '@nehloo/graphnosis 0.11.0 — indelible edit is live (no contract column)',
    evidence:
      'node_modules/@nehloo/graphnosis/dist/core/corrections/correction-engine.d.ts — ' +
      '`CorrectionResult.affectedNodeIds` present on 0.11.0. Re-censused 2026-08-06: ' +
      'former CONTRACT-ONLY edit-rebind rows became reachable with the SDK pin.',
    why:
      'Kept in the census for drift protection via contractLevelSuite. contract:0 ' +
      'because indelible edit + mint-on-edit are installed behaviour.',
    contract: 0,
    reachable: 10,
  },
  'indelible-edit-node-id.test.mjs': {
    dependency: '@nehloo/graphnosis',
    installed: '0.11.0',
    required: '0.11.0 (`CorrectionResult.affectedNodeIds`)',
    tag: '@nehloo/graphnosis 0.11.0 — affectedNodeIds is live (no contract column)',
    evidence:
      'node_modules/@nehloo/graphnosis/dist/core/corrections/correction-engine.d.ts — ' +
      '`affectedNodeIds: NodeId[]` on CorrectionResult. Re-censused 2026-08-06.',
    why:
      'Fake-SDK rows that asserted the 0.11 mint shape are now reachable against ' +
      'the installed producer; legacy 0.8.0-shape fakes remain as regression guards.',
    contract: 0,
    reachable: 11,
  },
});

/** How a contract-level test announces itself in the runner's own output. */
export const CONTRACT_TAG = 'CONTRACT-ONLY';

/**
 * Register a suite's tests through the census.
 *
 * Returns a `test`-compatible function for the reachable tests, with a
 * `.contract` variant for the ones that cannot execute on the installed build.
 * Both run. Both fail the build. Only the label differs.
 *
 *   const test = contractLevelSuite('my-file.test.mjs');
 *   test('this one is real end-to-end', () => { … });
 *   test.contract('this one needs the next release', () => { … });
 */
export function contractLevelSuite(fileKey) {
  const entry = CENSUS[fileKey];
  if (!entry) {
    throw new Error(
      `contractLevelSuite: no census entry for ${fileKey}. Add one to tests/_contract-level.mjs ` +
      `so the aggregate in contract-level-census.test.mjs stays true.`,
    );
  }
  const tag = `[${CONTRACT_TAG}: ${entry.tag}]`;
  const seen = { contract: 0, reachable: 0 };

  const suite = (name, fn) => {
    seen.reachable += 1;
    return nodeTest(name, fn);
  };
  suite.contract = (name, fn) => {
    seen.contract += 1;
    return nodeTest(`${tag} ${name}`, fn);
  };

  after(() => {
    const total = seen.contract + seen.reachable;
    if (seen.contract !== entry.contract || seen.reachable !== entry.reachable) {
      throw new Error(
        `contract-level census drift in ${fileKey}: registered ${seen.contract} contract-level ` +
        `and ${seen.reachable} reachable, but tests/_contract-level.mjs pins ` +
        `${entry.contract}/${entry.reachable}. Re-verify reachability against the INSTALLED ` +
        `artifact, then update the census — do not update the census to match a guess.`,
      );
    }
    if (seen.contract === 0) return;
    process.stderr.write(
      `\n── CONTRACT-LEVEL NOTICE — ${fileKey} ──\n` +
      `${seen.contract} of ${total} tests in this file are CONTRACT-LEVEL, not end-to-end.\n` +
      `They assert against ${entry.dependency} ${entry.required}; installed is ${entry.installed}.\n` +
      `They execute and their assertions are enforced, but NO production run on the\n` +
      `installed build can reach the state they describe. Do not count them as\n` +
      `coverage of shipped behaviour.\n` +
      `  why      : ${entry.why}\n` +
      `  evidence : ${entry.evidence}\n` +
      `────────────────────────────────────────\n`,
    );
  });

  return suite;
}
