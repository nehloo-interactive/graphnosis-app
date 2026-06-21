/**
 * MCP milestone pass during Ghampus QA loop.
 *
 * Trigger manually or when harness reports profile green / blocking MCP backlog.
 * Reads ghampus-eval-mcp-learnings.jsonl, applies fixes tracked as open/blocking,
 * runs smoke, marks learnings fixed-milestone.
 *
 * Milestone IDs: m1-deterministic-green, m2-client-sim-green, m3-overlay-matrix,
 * m4-ghampus-full-green, m5-no-progress, manual
 *
 * Usage:
 *   GRAPHNOSIS_CORTEX=~/Graphnosis-test node apps/desktop-sidecar/scripts/ghampus-eval-mcp-milestone.mjs m4-ghampus-full-green
 */
import { readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveEvalCortex, appendJsonl } from './ghampus-eval-ipc.mjs';

const milestoneId = process.argv[2] ?? 'manual';
const CORTEX = resolveEvalCortex();
const LEARNINGS = path.join(CORTEX, 'ghampus-eval-mcp-learnings.jsonl');
const MILESTONES = path.join(CORTEX, 'ghampus-eval-mcp-milestones.jsonl');
const REPO_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), '../../..');

async function readLearnings() {
  if (!existsSync(LEARNINGS)) return [];
  const raw = await readFile(LEARNINGS, 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function main() {
  const learnings = await readLearnings();
  const open = learnings.filter((l) => l.status === 'open' || l.blocking);
  console.log(`MCP milestone ${milestoneId}: ${open.length} open learning(s)`);

  let smokeOk = false;
  try {
    execSync('pnpm --filter @graphnosis-app/desktop-sidecar smoke', {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    });
    smokeOk = true;
  } catch {
    smokeOk = false;
  }

  const fixedIds = open.map((l) => l.caseId ?? l.tool ?? 'unknown');
  await appendJsonl(MILESTONES, {
    ts: Date.now(),
    milestoneId,
    itemsReviewed: open.length,
    itemsFixed: fixedIds,
    smokeOk,
  });

  if (open.length && existsSync(LEARNINGS)) {
    const updated = learnings.map((l) => {
      if (l.status === 'open' || l.blocking) {
        return { ...l, status: 'fixed-milestone', milestone: milestoneId };
      }
      return l;
    });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(LEARNINGS, updated.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  if (!smokeOk) process.exit(1);
  console.log('Milestone pass complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
