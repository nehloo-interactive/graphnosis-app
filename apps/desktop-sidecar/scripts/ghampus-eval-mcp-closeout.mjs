/**
 * Final MCP close-out after Ghampus full green (m4).
 *
 * Sweeps open/deferred learnings, runs smoke + isolated ghampus gate, writes report.
 *
 * Usage:
 *   GRAPHNOSIS_CORTEX=~/Graphnosis-test node apps/desktop-sidecar/scripts/ghampus-eval-mcp-closeout.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveEvalCortex } from './ghampus-eval-ipc.mjs';

const CORTEX = resolveEvalCortex();
const LEARNINGS = path.join(CORTEX, 'ghampus-eval-mcp-learnings.jsonl');
const REPORT = path.join(CORTEX, 'ghampus-eval-mcp-closeout-report.json');
const REPO_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

async function readLearnings() {
  if (!existsSync(LEARNINGS)) return [];
  const raw = await readFile(LEARNINGS, 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function main() {
  const learnings = await readLearnings();
  const open = learnings.filter((l) => l.status === 'open');
  const deferred = learnings.filter((l) => l.status === 'deferred');
  const fixed = learnings.filter((l) => l.status?.startsWith('fixed'));

  let smokeOk = false;
  let gateOk = false;
  try {
    execSync('pnpm --filter @graphnosis-app/desktop-sidecar smoke', { stdio: 'inherit', cwd: REPO_ROOT });
    smokeOk = true;
  } catch {
    smokeOk = false;
  }
  try {
    execSync('pnpm --filter @graphnosis-app/desktop-sidecar ghampus-eval:gate', {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    });
    gateOk = true;
  } catch {
    gateOk = false;
  }

  const report = {
    ts: Date.now(),
    smokeOk,
    gateOk,
    openCount: open.length,
    deferredCount: deferred.length,
    fixedCount: fixed.length,
    open,
    deferred,
    studyComplete: smokeOk && gateOk && open.filter((l) => l.blocking).length === 0,
  };
  await writeFile(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (!report.studyComplete) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
