/**
 * Forget all ghampus-tests sources labelled with the eval seed marker, then ingest once.
 * Requires live sidecar on GRAPHNOSIS_CORTEX (app unlocked).
 *
 *   pnpm --filter @graphnosis-app/desktop-sidecar ghampus-eval:clean-seed
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ipcCall, resolveEvalCortex, resolveEvalSocket, sleep } from './ghampus-eval-ipc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '../src/fixtures/ghampus-eval');
const EVAL_ENGRAM = 'ghampus-tests';
const SEED_MARKER = 'ghampus-tests:seed-v1';

async function listSources(socketPath) {
  const raw = await ipcCall(socketPath, 'sources.list', { graphId: EVAL_ENGRAM });
  if (Array.isArray(raw)) return raw;
  return raw?.sources ?? [];
}

async function main() {
  const cortex = resolveEvalCortex();
  const socket = resolveEvalSocket(cortex);
  console.log(`[ghampus-eval:clean-seed] cortex=${cortex}`);

  const graphs = await ipcCall(socket, 'graphs.list', {});
  const ids = new Set((graphs ?? []).map((g) => g.graphId ?? g.id ?? g));
  if (!ids.has(EVAL_ENGRAM)) {
    await ipcCall(socket, 'graphs.create', { graphId: EVAL_ENGRAM });
  }
  await ipcCall(socket, 'graphs.load', { graphId: EVAL_ENGRAM });

  const sources = await listSources(socket);
  let forgotten = 0;
  for (const s of sources) {
    const sourceId = s.sourceId ?? s.id;
    if (!sourceId) continue;
    await ipcCall(socket, 'sources.forget', { graphId: EVAL_ENGRAM, sourceId });
    forgotten++;
  }
  console.log(`[ghampus-eval:clean-seed] forgot ${forgotten} source(s) on ${EVAL_ENGRAM}`);

  const team = readFileSync(path.join(FIXTURES, 'seed-team-memory.md'), 'utf8');
  const product = readFileSync(path.join(FIXTURES, 'seed-product-facts.md'), 'utf8');
  const teamRo = readFileSync(path.join(FIXTURES, 'seed-team-memory-ro.md'), 'utf8');
  const productRo = readFileSync(path.join(FIXTURES, 'seed-product-facts-ro.md'), 'utf8');
  await ipcCall(socket, 'ingest.clip', {
    graphId: EVAL_ENGRAM,
    text: [team, product, teamRo, productRo].join('\n\n'),
    label: SEED_MARKER,
  });
  const waitMs = Number(process.env.GRAPHNOSIS_EVAL_SEED_WAIT_MS ?? 8000);
  console.log(`[ghampus-eval:clean-seed] ingested; waiting ${waitMs}ms for indexing…`);
  await sleep(waitMs);
  const after = await listSources(socket);
  console.log(`[ghampus-eval:clean-seed] done — ${after.length} source(s) on ${EVAL_ENGRAM}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
