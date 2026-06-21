/**
 * Soak eval on ~/Graphnosis-test (or GRAPHNOSIS_CORTEX). Logs results; does not fail the build by default.
 *
 *   pnpm --filter @graphnosis-app/desktop-sidecar ghampus-eval:soak
 *   GRAPHNOSIS_EVAL_SOAK_GATE=1 ...  — exit 1 on any case failure (optional hard gate)
 *
 * One-time fixture hygiene before soak:
 *   GRAPHNOSIS_EVAL_CLEAN_SEED=1 pnpm --filter @graphnosis-app/desktop-sidecar ghampus-eval:soak
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const LOOP = path.join(__dirname, 'ghampus-eval-loop.mjs');

const CORTEX = process.env.GRAPHNOSIS_CORTEX ?? path.join(os.homedir(), 'Graphnosis-test');
const SOAK_GATE = process.env.GRAPHNOSIS_EVAL_SOAK_GATE === '1';

const child = spawn(process.execPath, [LOOP], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    GRAPHNOSIS_CORTEX: CORTEX,
    GRAPHNOSIS_EVAL_PROFILE: 'deterministic',
    GRAPHNOSIS_EVAL_REPEATS: '1',
    GRAPHNOSIS_EVAL_CASE_GAP_MS: process.env.GRAPHNOSIS_EVAL_CASE_GAP_MS ?? '12000',
    GRAPHNOSIS_EVAL_SEED_WAIT_MS: process.env.GRAPHNOSIS_EVAL_SEED_WAIT_MS ?? '8000',
  },
  stdio: 'inherit',
});

child.on('close', (code) => {
  if (code === 0) {
    console.log(`[ghampus-eval:soak] PASS on ${CORTEX}`);
    process.exit(0);
  }
  if (SOAK_GATE) {
    console.error(`[ghampus-eval:soak] FAIL (SOAK_GATE=1) exit ${code}`);
    process.exit(code ?? 1);
  }
  console.warn(
    `[ghampus-eval:soak] completed with failures (exit ${code}) — soak is informational; see ${CORTEX}/ghampus-eval-results.jsonl`,
  );
  process.exit(0);
});
