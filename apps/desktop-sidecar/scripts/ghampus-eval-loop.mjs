/**
 * Ghampus eval loop — train/test harness for Ghampus memory assistant QA.
 *
 * Cortex modes:
 *   GRAPHNOSIS_CORTEX — defaults to ~/Graphnosis-test (required for writes)
 *   GRAPHNOSIS_EVAL_READONLY=1 — recall-only; skips seed/remember/train
 *
 * Eval knobs:
 *   GRAPHNOSIS_EVAL_MODE=1 — temperature 0 on local LLM (set before sidecar start)
 *   GRAPHNOSIS_EVAL_REPEATS=3 — identical prompt repeats per case (default 3)
 *   GRAPHNOSIS_EVAL_MIN_AGREEMENT=1.0 — consistency gate
 *   GRAPHNOSIS_EVAL_MODELS=llama3.2:3b-instruct-q4_K_M,qwen2.5:3b-instruct-q4_K_M
 *   GRAPHNOSIS_EVAL_PROFILE=deterministic|gll-only|gnn-only|all-overlays
 *   GRAPHNOSIS_EVAL_CASES=case-id-1,case-id-2
 *   GRAPHNOSIS_EVAL_TAGS=smoke,intent,multilingual,ro
 *   GRAPHNOSIS_EVAL_LANG=ro — Romanian cases only (lang=ro or tag ro)
 *   GRAPHNOSIS_EVAL_MAX_ROUNDS=5 — outer agent macro-loop cap (skill)
 *   GRAPHNOSIS_EVAL_ALL_PROFILES=1 — run gll/gnn overlay matrix (default: deterministic only)
 *   GRAPHNOSIS_EVAL_FORCE_RESEED=1 — ingest fixtures even when seed marker exists
 *   GRAPHNOSIS_EVAL_CLEAN_SEED=1 — forget seed-labelled sources before ingest
 *   GRAPHNOSIS_EVAL_CASE_GAP_MS — pause between cases (soak: 12000 recommended)
 *
 * Regression gate (isolated cortex, blocks on failure):
 *   pnpm --filter @graphnosis-app/desktop-sidecar ghampus-eval:gate
 *
 * Soak (~/Graphnosis-test, logs failures but exit 0 unless GRAPHNOSIS_EVAL_SOAK_GATE=1):
 *   pnpm --filter @graphnosis-app/desktop-sidecar ghampus-eval:soak
 *
 * Usage:
 *   pnpm --filter @graphnosis-app/desktop-sidecar build
 *   GRAPHNOSIS_CORTEX=~/Graphnosis-test node apps/desktop-sidecar/scripts/ghampus-eval-loop.mjs --fast
 *   GRAPHNOSIS_CORTEX=~/Graphnosis-test node apps/desktop-sidecar/scripts/ghampus-eval-loop.mjs
 *
 * Outputs (in cortex dir):
 *   ghampus-eval-results.jsonl
 *   ghampus-eval-drift.jsonl (on consistency failures)
 */
import { readFileSync, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendJsonl,
  ipcCall,
  pollGhampusResponse,
  resolveEvalCortex,
  resolveEvalSocket,
  sleep,
} from './ghampus-eval-ipc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '../src/fixtures/ghampus-eval');
const DIST = path.join(__dirname, '../dist');

const FAST = process.argv.includes('--fast');
const CORTEX = resolveEvalCortex();
const SOCKET = resolveEvalSocket(CORTEX);
const REPEATS = Number(process.env.GRAPHNOSIS_EVAL_REPEATS ?? 3);
const MIN_AGREEMENT = Number(process.env.GRAPHNOSIS_EVAL_MIN_AGREEMENT ?? 1.0);
const READONLY = process.env.GRAPHNOSIS_EVAL_READONLY === '1';
const PROFILE_FILTER = process.env.GRAPHNOSIS_EVAL_PROFILE;
const CASE_FILTER = process.env.GRAPHNOSIS_EVAL_CASES?.split(',').map((s) => s.trim()).filter(Boolean);
const TAG_FILTER = process.env.GRAPHNOSIS_EVAL_TAGS?.split(',').map((s) => s.trim()).filter(Boolean);
const LANG_FILTER = process.env.GRAPHNOSIS_EVAL_LANG?.trim().toLowerCase();

const EVAL_ENGRAM = 'ghampus-tests';
const SEED_MARKER = 'ghampus-tests:seed-v1';

async function loadModules() {
  const intentPath = path.join(DIST, 'ghampus-intent.js');
  const oraclePath = path.join(DIST, 'ghampus-eval-oracle.js');
  const guardPath = path.join(DIST, 'ghampus-eval-guard.js');
  if (!existsSync(intentPath) || !existsSync(oraclePath)) {
    throw new Error('Build required: pnpm --filter @graphnosis-app/desktop-sidecar build');
  }
  const intent = await import(intentPath);
  const oracle = await import(oraclePath);
  const guard = await import(guardPath);
  return { intent, oracle, guard };
}

function loadCases() {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES, 'cases.json'), 'utf8'));
  let cases = raw.cases ?? [];
  if (CASE_FILTER?.length) cases = cases.filter((c) => CASE_FILTER.includes(c.id));
  if (TAG_FILTER?.length) cases = cases.filter((c) => (c.tags ?? []).some((t) => TAG_FILTER.includes(t)));
  if (LANG_FILTER) {
    cases = cases.filter((c) => c.lang === LANG_FILTER || (c.tags ?? []).includes(LANG_FILTER));
  }
  return cases;
}

function loadOverlayProfiles() {
  return JSON.parse(readFileSync(path.join(FIXTURES, 'overlay-profiles.json'), 'utf8'));
}

function loadClientScripts() {
  return JSON.parse(readFileSync(path.join(FIXTURES, 'client-sim-scripts.json'), 'utf8'));
}

async function snapshotGraphIds(socketPath) {
  const graphs = await ipcCall(socketPath, 'graphs.list', {});
  return new Set((graphs ?? []).map((g) => g.graphId ?? g.id ?? g));
}

async function listEvalSources(socketPath) {
  const raw = await ipcCall(socketPath, 'sources.list', { graphId: EVAL_ENGRAM });
  if (Array.isArray(raw)) return raw;
  return raw?.sources ?? [];
}

async function ensureEvalEngram(socketPath, guard, snapshotIds) {
  if (READONLY) return;
  guard.assertEvalWriteAllowed(EVAL_ENGRAM, CORTEX, snapshotIds);
  const graphs = await ipcCall(socketPath, 'graphs.list', {});
  const ids = new Set((graphs ?? []).map((g) => g.graphId ?? g.id ?? g));
  if (!ids.has(EVAL_ENGRAM)) {
    await ipcCall(socketPath, 'graphs.create', { graphId: EVAL_ENGRAM });
  }
  await ipcCall(socketPath, 'graphs.load', { graphId: EVAL_ENGRAM });
}

async function forgetSeedSources(socketPath, forgetAll = false) {
  const sources = await listEvalSources(socketPath);
  let n = 0;
  for (const s of sources) {
    const label = String(s.label ?? s.name ?? '');
    const sourceId = s.sourceId ?? s.id;
    if (!sourceId) continue;
    if (forgetAll || label.includes(SEED_MARKER) || label.includes('Ghampus Eval')) {
      await ipcCall(socketPath, 'sources.forget', { graphId: EVAL_ENGRAM, sourceId });
      n++;
    }
  }
  if (n > 0) console.log(`[ghampus-eval] forgot ${n} source(s) on ${EVAL_ENGRAM}`);
}

async function seedFixtures(socketPath, guard, snapshotIds) {
  if (READONLY) return;
  guard.assertEvalWriteAllowed(EVAL_ENGRAM, CORTEX, snapshotIds);
  if (process.env.GRAPHNOSIS_EVAL_CLEAN_SEED === '1') {
    await forgetSeedSources(socketPath, true);
  }
  const force = process.env.GRAPHNOSIS_EVAL_FORCE_RESEED === '1';
  const hasSources = (await listEvalSources(socketPath)).length > 0;
  if (!force && hasSources && process.env.GRAPHNOSIS_EVAL_CLEAN_SEED !== '1') {
    console.log(`[ghampus-eval] ${EVAL_ENGRAM} already has sources — skip ingest (use GRAPHNOSIS_EVAL_FORCE_RESEED=1 or CLEAN_SEED=1)`);
    return;
  }
  const team = readFileSync(path.join(FIXTURES, 'seed-team-memory.md'), 'utf8');
  const product = readFileSync(path.join(FIXTURES, 'seed-product-facts.md'), 'utf8');
  const teamRo = readFileSync(path.join(FIXTURES, 'seed-team-memory-ro.md'), 'utf8');
  const productRo = readFileSync(path.join(FIXTURES, 'seed-product-facts-ro.md'), 'utf8');
  console.log(`[ghampus-eval] ingesting fixtures → ${EVAL_ENGRAM}`);
  await ipcCall(socketPath, 'ingest.clip', {
    graphId: EVAL_ENGRAM,
    text: [team, product, teamRo, productRo].join('\n\n'),
    label: SEED_MARKER,
  });
  await sleep(Number(process.env.GRAPHNOSIS_EVAL_SEED_WAIT_MS ?? 5000));
}

async function applyOverlayProfile(socketPath, profileId, profiles) {
  const p = profiles[profileId];
  if (!p) throw new Error(`Unknown overlay profile: ${profileId}`);
  if (p.neuralNetwork) {
    await ipcCall(socketPath, 'brain:enableNeuralNetwork', {});
  } else {
    await ipcCall(socketPath, 'brain:disableNeuralNetwork', {});
  }
  await ipcCall(socketPath, 'llm:setEnabled', { enabled: p.llmEnabled });
  for (const [cap, enabled] of Object.entries(p.llmCapabilities ?? {})) {
    await ipcCall(socketPath, 'llm:setCapability', { capability: cap, enabled });
  }
}

async function getGhampusBaseline(socketPath) {
  const hist = await ipcCall(socketPath, 'ghampus:history', {});
  return (hist?.messages ?? []).filter((m) => m?.kind === 'ghampus').length;
}

async function runMcpTool(socketPath, tool, args) {
  const res = await ipcCall(socketPath, 'agent:runTool', { tool, args });
  if (!res?.ok) throw new Error(`agent:runTool ${tool} failed: ${JSON.stringify(res)}`);
  const result = res.result;
  if (typeof result === 'string') return result;
  if (result?.prompt) return String(result.prompt);
  if (result?.nodes) return JSON.stringify(result);
  return JSON.stringify(result ?? {});
}

/** Ghampus-like MCP chain for parity oracle (recall + dig_deeper + recall_structured). */
async function runMcpOracleChain(socketPath, query) {
  const q = String(query ?? '').trim();
  const parts = [];
  for (const [tool, args] of [
    ['recall', { query: q, maxNodes: 50, skip_enrichment: true }],
    ['dig_deeper', { query: q, maxNodes: 50, skip_enrichment: true }],
    ['recall_structured', { query: q, maxNodes: 50 }],
  ]) {
    try {
      parts.push(await runMcpTool(socketPath, tool, args));
    } catch (err) {
      parts.push(`[${tool} error: ${err instanceof Error ? err.message : String(err)}]`);
    }
  }
  return parts.join('\n\n---\n\n');
}

async function runMcpRecall(socketPath, args) {
  const toolArgs = { ...(args ?? {}) };
  if (toolArgs.q && !toolArgs.query) toolArgs.query = toolArgs.q;
  return runMcpTool(socketPath, 'recall', toolArgs);
}

function expectedToAction(expected) {
  if (expected === 'question') return 'recall';
  return expected;
}

function scoreCaseIntent(intent, oracle, text, expectedIntent) {
  const detected = intent.detectKeywordIntent(text);
  const actual = detected.action;
  return oracle.scoreIntent(expectedToAction(expectedIntent), actual);
}

async function runFastPass(intent, oracle, cases) {
  let failed = 0;
  for (const c of cases) {
    if (c.category === 'intent' && c.expectedIntent) {
      const intentRes = scoreCaseIntent(intent, oracle, c.text, c.expectedIntent);
      const row = { mode: 'fast', caseId: c.id, pass: intentRes.pass, reason: intentRes.reason };
      await appendJsonl(path.join(CORTEX, 'ghampus-eval-results.jsonl'), row);
      if (!intentRes.pass) failed++;
    }
  }
  return failed;
}

async function runLiveCase(socketPath, intent, oracle, c, profileId, model, repeatIdx) {
  const profiles = loadOverlayProfiles();
  await applyOverlayProfile(socketPath, profileId, profiles);
  if (model) await ipcCall(socketPath, 'llm:setModel', { model });

  const row = {
    ts: Date.now(),
    caseId: c.id,
    profile: profileId,
    model,
    repeat: repeatIdx,
    category: c.category,
  };

  if (c.category === 'intent' && c.expectedIntent) {
    const intentRes = scoreCaseIntent(intent, oracle, c.text ?? '', c.expectedIntent);
    row.intent = intentRes;
    row.pass = intentRes.pass;
    return row;
  }

  if (c.category === 'client-sim' && c.clientPersona) {
    const scripts = loadClientScripts();
    const script = scripts[c.clientPersona];
    if (!script) {
      row.pass = false;
      row.error = `missing client persona ${c.clientPersona}`;
      return row;
    }
    const texts = [];
    for (const step of script.steps ?? []) {
      if (step.action === 'ghampus:send') {
        const sentAt = Date.now();
        await ipcCall(socketPath, 'ghampus:send', { text: step.text });
        texts.push(await pollGhampusResponse(socketPath, 0, undefined, sentAt));
      } else if (step.action === 'mcp' && step.tool === 'recall') {
        texts.push(await runMcpRecall(socketPath, step.args ?? {}));
      }
    }
    const combined = texts.join('\n');
    const recallRes = c.canonicalKey ? oracle.scoreRecall(combined, c.canonicalKey) : { pass: true };
    row.pass = recallRes.pass;
    row.recall = recallRes;
    row.responsePreview = combined.slice(0, 400);
    return row;
  }

  const text = c.text ?? '';
  const sentAt = Date.now();
  await ipcCall(socketPath, 'ghampus:send', { text });
  const response = await pollGhampusResponse(socketPath, 0, undefined, sentAt);
  row.responsePreview = response.slice(0, 400);

  let pass = true;
  if (c.canonicalKey) {
    const recallRes = oracle.scoreRecall(response, c.canonicalKey);
    row.recall = recallRes;
    pass = recallRes.pass;
  }

  if (c.category === 'parity' && c.canonicalKey) {
    const mcpText = c.text
      ? await runMcpOracleChain(socketPath, c.text)
      : await runMcpRecall(socketPath, { q: 'eval product version Seahorse' });
    const parityRes = oracle.compareMcpGhampusParity(response, mcpText, c.canonicalKey);
    row.parity = parityRes;
    row.mcpOracle = 'recall+dig_deeper+recall_structured';
    pass = pass && parityRes.pass;
  }

  row.pass = pass;
  return row;
}

async function main() {
  const { intent, oracle, guard } = await loadModules();
  const cases = loadCases();
  const profiles = loadOverlayProfiles();
  const profileIds = PROFILE_FILTER
    ? [PROFILE_FILTER]
    : process.env.GRAPHNOSIS_EVAL_ALL_PROFILES === '1'
      ? ['deterministic', 'gll-only', 'gnn-only', 'all-overlays']
      : ['deterministic'];

  console.log(`Ghampus eval: cortex=${CORTEX} fast=${FAST} cases=${cases.length} repeats=${REPEATS}`);

  let snapshotIds = new Set();
  try {
    snapshotIds = await snapshotGraphIds(SOCKET);
    if (!READONLY) {
      await ensureEvalEngram(SOCKET, guard, snapshotIds);
      await seedFixtures(SOCKET, guard, snapshotIds);
    }
  } catch (err) {
    if (FAST) {
      console.warn('Sidecar unavailable — running offline fast oracle only');
      const failed = await runFastPass(intent, oracle, cases);
      process.exit(failed > 0 ? 1 : 0);
    }
    throw err;
  }

  if (FAST) {
    const failed = await runFastPass(intent, oracle, cases);
    if (failed > 0) {
      console.error(`FAST FAIL: ${failed} case(s)`);
      process.exit(1);
    }
    console.log('FAST PASS');
    process.exit(0);
  }

  const llmStatus = await ipcCall(SOCKET, 'llm:status', {});
  const installed = new Set(llmStatus?.installedModels ?? []);
  const modelOverride = process.env.GRAPHNOSIS_EVAL_MODELS?.split(',').map((s) => s.trim()).filter(Boolean);
  const catalogModels = modelOverride ?? (llmStatus?.activeModel ? [llmStatus.activeModel] : ['llama3.2:3b-instruct-q4_K_M']);
  const models = catalogModels.filter((m) => installed.has(m) || !installed.size);

  let totalFailed = 0;
  const repeatBuckets = new Map();

  for (const profileId of profileIds) {
    for (const model of models) {
      for (const c of cases) {
        const caseProfiles = c.overlayProfiles ?? ['deterministic'];
        if (!caseProfiles.includes(profileId)) continue;

        const runs = [];
        for (let r = 0; r < REPEATS; r++) {
          const row = await runLiveCase(SOCKET, intent, oracle, c, profileId, model, r);
          runs.push(row);
          await appendJsonl(path.join(CORTEX, 'ghampus-eval-results.jsonl'), row);
          if (!row.pass) totalFailed++;
          await sleep(Number(process.env.GRAPHNOSIS_EVAL_CASE_GAP_MS ?? 3000));
        }

        const responseTexts = runs.map((r) => r.responsePreview ?? '').filter(Boolean);
        if (responseTexts.length >= 2 && c.category !== 'intent') {
          const consistency = oracle.scoreConsistencyDetailed(responseTexts, MIN_AGREEMENT);
          const key = `${c.id}:${profileId}:${model}`;
          repeatBuckets.set(key, consistency);
          if (!consistency.pass) {
            totalFailed++;
            await appendJsonl(path.join(CORTEX, 'ghampus-eval-drift.jsonl'), {
              ts: Date.now(),
              caseId: c.id,
              profile: profileId,
              model,
              consistency,
              runs: responseTexts,
            });
          }
        }
      }
    }
  }

  if (totalFailed > 0) {
    console.error(`FAIL: ${totalFailed} failure(s)`);
    process.exit(1);
  }
  console.log('PASS: all cases green');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
