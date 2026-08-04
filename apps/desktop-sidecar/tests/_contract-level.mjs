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
    installed: '0.3.0',
    required: 'a federation that reports per-graph outcomes',
    tag: 'secure-sync 0.3.0 installed; needs per-graph failure reporting',
    evidence:
      'node_modules/@nehloo-interactive/graphnosis-secure-sync/dist/federation/index.d.ts — ' +
      '`AttachedGraphAudit` is `{ graphId, tier, nodesIncluded, tokensIncluded }` and ' +
      '`FederatedSubgraph` has no `complete` and no `failures`; `dist/federation/index.js` ' +
      'is a bare `Promise.all`, i.e. all-or-nothing, so no partial result exists to report.',
    why:
      'These feed `summarizeRecallCoverage` a subgraph carrying `complete`, `failures`, ' +
      'or an audit `status`/`error`. Strip those fields — which is all the installed ' +
      'federation can hand back — and every one of them computes a DIFFERENT coverage ' +
      '(measured: complete:true, zero failures, full answered count).',
    contract: 10,
    reachable: 5,
  },
  'recall-coverage-withheld.test.mjs': {
    dependency: '@nehloo-interactive/graphnosis-secure-sync',
    installed: '0.3.0',
    required: 'a federation that reports per-graph outcomes',
    tag: 'secure-sync 0.3.0 installed; needs per-graph failure reporting',
    evidence: 'same as recall-coverage-partial.test.mjs',
    why:
      'The whole file is the privacy property of the withheld+failed union. The ' +
      'installed federation emits neither `withheld` nor `failures`, so it cannot ' +
      'produce that union at all — every case here is synthetic by necessity.',
    contract: 6,
    reachable: 0,
  },
  'recall-partial-prompt.test.mjs': {
    dependency: '@nehloo-interactive/graphnosis-secure-sync',
    installed: '0.3.0',
    required: 'a federation that reports per-graph outcomes',
    tag: 'secure-sync 0.3.0 installed; needs per-graph failure reporting',
    evidence: 'same as recall-coverage-partial.test.mjs',
    why:
      'The two COMPLETE-path tests are genuinely end-to-end: they drive the real ' +
      '`hostRecall` over the real installed federation, and that is the only branch ' +
      'the installed build can reach. The three partial-path tests stamp the future ' +
      'shape onto the subgraph after federation returned it.',
    contract: 3,
    reachable: 2,
  },
  'oplog-replay-source-rebind.test.mjs': {
    dependency: '@nehloo/graphnosis',
    installed: '0.7.4',
    required: '0.10.0 (indelible `edit`)',
    tag: '@nehloo/graphnosis 0.7.4 installed; needs 0.10.0 indelible edit',
    evidence:
      'dist/core/corrections/correction-engine.js:22 — on 0.7.4 `applyEdit` mutates the ' +
      'node in place and returns `affectedNodeId: correction.nodeId`, so ' +
      '`resultNodeId === nodeId` and the rebind branch never fires on an edit. These ' +
      "four route `kind:'edit'` through the installed `applySupersede` instead, which " +
      'is the same retire-and-mint 0.10.0 made `edit`.',
    why:
      'Tests 1-5 and 10 are end-to-end on the installed SDK: `applySupersede` ' +
      '(correction-engine.js:111) still delegates to `applyAdd`, which mints a fresh ' +
      '`nanoid()`, so that half of the bug class is live today. The four labelled here ' +
      'are the `edit` half, which is latent until the SDK is bumped.',
    contract: 4,
    reachable: 6,
  },
  'indelible-edit-node-id.test.mjs': {
    dependency: '@nehloo/graphnosis',
    installed: '0.7.4',
    required: '0.11.0 (`CorrectionResult.affectedNodeIds`)',
    tag: '@nehloo/graphnosis 0.7.4 installed; needs 0.11.0 affectedNodeIds',
    evidence:
      'node_modules/@nehloo/graphnosis/dist/core/corrections/correction-engine.d.ts — ' +
      "`CorrectionResult` is `{ applied, nodesAdded, nodesModified, nodesSuperseded, " +
      'errors }`, with no `affectedNodeIds`. The installed SDK cannot return a ' +
      'differing id, so it cannot distinguish the fixed code from the broken code.',
    why:
      'Three tests drive the fake SDK at `sdkVersion: \'0.11.0\'` and assert on a ' +
      'MINTED id. The rest run the installed 0.7.4 shape, or the refusal path, or a ' +
      'static read of the source — all reachable today.',
    contract: 3,
    reachable: 8,
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
