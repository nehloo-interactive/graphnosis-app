/**
 * Live train ghampus-qa-loop on test cortex ghampus-qa-skills engram.
 *
 * Usage:
 *   GRAPHNOSIS_CORTEX=/Users/you/Graphnosis-test \
 *   GRAPHNOSIS_SKILLS_GRAPH=ghampus-qa-skills \
 *   node apps/desktop-sidecar/scripts/train-ghampus-qa-loop.mjs
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const CORTEX = process.env.GRAPHNOSIS_CORTEX ?? path.join(os.homedir(), 'Graphnosis-test');
const SOCKET = process.env.GRAPHNOSIS_IPC_SOCKET ?? path.join(CORTEX, 'sidecar.sock');
const GRAPH_ID = process.env.GRAPHNOSIS_SKILLS_GRAPH ?? 'ghampus-qa-skills';
const SKILL_NAME = 'ghampus-qa-loop';

const repairScript = readFileSync(
  new URL('./repair-hollow-skills.mjs', import.meta.url),
  'utf8',
);
const knownMatch = repairScript.match(/'ghampus-qa-loop': `([\s\S]*?)`,\n\n  'skill-dispatch'/);
if (!knownMatch) {
  console.error('FAIL: could not extract ghampus-qa-loop source from repair-hollow-skills.mjs');
  process.exit(1);
}
const SKILL_TEXT = knownMatch[1];

let nextId = 1;

function ipcCall(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const payload = JSON.stringify({ id, method, params }) + '\n';
    const socket = net.connect(SOCKET);
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id === id) {
          socket.destroy();
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });
    socket.on('error', reject);
    socket.setTimeout(180_000, () => {
      socket.destroy();
      reject(new Error(`IPC timeout for ${method}`));
    });
  });
}

function baseSkillName(ref) {
  return String(ref ?? '')
    .replace(/^skill:\d+:/, '')
    .replace(/\s*\(trained[^)]*\)\s*$/i, '')
    .trim();
}

async function findExistingSourceId() {
  const skills = await ipcCall('skill:list', { graphId: GRAPH_ID });
  for (const s of skills) {
    const name = baseSkillName(s.ref ?? s.label ?? '');
    if (name.toLowerCase().replace(/\s+/g, '-') === SKILL_NAME) {
      return s.sourceId;
    }
  }
  return null;
}

async function getMetrics(sourceId) {
  const detail = await ipcCall('skill:get', { graphId: GRAPH_ID, sourceId });
  const walk = await ipcCall('skill:walkSequence', {
    graphId: GRAPH_ID,
    sourceId,
    recursive: false,
  });
  return {
    nodeCount: detail?.nodeCount ?? 0,
    walkSteps: (walk?.steps ?? []).length,
    steps: walk?.steps ?? [],
  };
}

async function main() {
  console.log(`Training ${SKILL_NAME} via ${SOCKET} on ${GRAPH_ID} (${SKILL_TEXT.length} chars)`);

  const graphs = await ipcCall('graphs.list', {});
  const ids = new Set((graphs ?? []).map((g) => g.graphId ?? g.id ?? g));
  if (!ids.has(GRAPH_ID)) {
    await ipcCall('graphs.create', { graphId: GRAPH_ID });
    await ipcCall('graphs.load', { graphId: GRAPH_ID });
  }

  const existingSourceId = await findExistingSourceId();
  if (existingSourceId) {
    const before = await getMetrics(existingSourceId);
    console.log(`Found existing sourceId=${existingSourceId} nodes=${before.nodeCount} walk=${before.walkSteps}`);
  }

  const trainResult = await ipcCall('skill:train', {
    skill: SKILL_TEXT,
    graphId: GRAPH_ID,
    skillName: SKILL_NAME,
    save: true,
    useLlmRewrite: false,
  });

  if (trainResult?.upgrade_required) {
    console.error('FAIL: upgrade_required');
    process.exit(1);
  }

  const sourceId = existingSourceId ?? trainResult?.sourceId ?? trainResult?.skillId;
  const finalSourceId = sourceId ?? (await findExistingSourceId());
  if (!finalSourceId) {
    console.error('FAIL: could not resolve sourceId after train');
    process.exit(1);
  }
  const after = await getMetrics(finalSourceId);
  const ok = after.walkSteps > 0 && after.nodeCount > 0;

  console.log('\n=== RESULT ===');
  console.log(JSON.stringify({
    name: SKILL_NAME,
    graphId: GRAPH_ID,
    sourceId: finalSourceId,
    nodeCount: after.nodeCount,
    walkSteps: after.walkSteps,
    mode: trainResult?.mode,
    ok,
    stepPreview: after.steps.slice(0, 3).map((s) => ({
      index: s.index,
      text: String(s.text ?? '').slice(0, 120),
    })),
  }, null, 2));

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
