/**
 * Retrain polluted skills using source-only compile (empty train-time recall).
 * Usage: node apps/desktop-sidecar/scripts/retrain-clean-skills.mjs
 */
import net from 'node:net';

const SOCKET =
  process.env.GRAPHNOSIS_IPC_SOCKET ??
  '/Users/nelulazar/Graphnosis-test/sidecar.sock';
const GRAPH_ID = 'graphnosis-skills';

const PRIORITY = new Set([
  'skill-dispatch',
  'bug-investigation',
  'ship-workflow',
  'changelog-management',
  'sidecar-change-verify',
  'runtime-diagnosis',
  'security-review-cadence',
  'session-start',
  'project-context-management',
  'performance-regression-check',
  'docs-maintenance-workflow',
  'generated-artifact-freshness-check',
  'deployment-platform-ops',
  'retrospective-learning',
  'agentic-communication-style',
  'recall-before-coding',
  'public-repo-ship-audit',
]);

const POLLUTION_RE =
  /# Graphnosis context|KNOWLEDGE SUBGRAPH|_\s*\(from cortex recall\)_|Personal Context \(from your Graphnosis memories\)|^--- NODES ---/m;

function stripMetadataHeader(text) {
  return text
    .replace(/^(?:#[^\n]+|\*\*[^\n]+\*\*)\n+<!--[\s\S]*?-->\n+/, '')
    .trim();
}

function stripPersonalContextBlock(text) {
  const marker = '\n---\n**Personal Context (from your Graphnosis memories)**';
  const idx = text.indexOf(marker);
  return idx !== -1 ? text.slice(0, idx).trim() : text;
}

function extractCleanSource(text) {
  let t = text;
  const ctxIdx = t.indexOf('# Graphnosis context');
  if (ctxIdx !== -1) t = t.slice(0, ctxIdx);
  t = stripPersonalContextBlock(stripMetadataHeader(t));
  return t.trim();
}

function isPollutedNode(content, role) {
  if (role === 'recalled-memory') return true;
  const t = content.trim();
  if (!t || t.startsWith('<!--')) return false;
  return POLLUTION_RE.test(t);
}

function baseSkillName(ref) {
  return ref.replace(/^skill:\d+:/, '').replace(/\s*\(trained[^)]*\)\s*$/i, '').trim();
}

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
    socket.setTimeout(120000, () => {
      socket.destroy();
      reject(new Error(`IPC timeout for ${method}`));
    });
  });
}

async function getCleanSourceFromSnapshot(sourceId, history) {
  const POLLUTION_CUTOFF = Date.parse('2026-06-19T06:50:00.000Z');
  const candidates = history
    .filter((h) => h.snapshotId && h.ingestedAt < POLLUTION_CUTOFF)
    .sort((a, b) => b.ingestedAt - a.ingestedAt);

  for (const entry of candidates) {
    const snap = await ipcCall('skill:getSnapshot', {
      graphId: GRAPH_ID,
      sourceId,
      snapshotId: entry.snapshotId,
    });
    if (!snap?.text) continue;
    const clean = extractCleanSource(snap.text);
    if (clean.length > 80 && !POLLUTION_RE.test(clean)) return clean;
  }
  return null;
}

async function main() {
  const skills = await ipcCall('skill:list', { graphId: GRAPH_ID });
  const results = [];

  const targets = skills.filter((s) => {
    const name = baseSkillName(s.ref ?? s.label ?? '');
    if (PRIORITY.has(name)) return true;
    const trained = s.trainedAt ? Date.parse(s.trainedAt) : s.ingestedAt;
    if (trained >= Date.parse('2026-06-19T00:00:00.000Z')) return true;
    return false;
  });

  console.log(`Scanning ${targets.length} candidate skills in ${GRAPH_ID}`);

  for (const s of targets) {
    const name = baseSkillName(s.ref ?? s.label ?? '');
    const sourceId = s.sourceId;
    let detail = await ipcCall('skill:get', { graphId: GRAPH_ID, sourceId });
    const beforeVitality = await ipcCall('skill:vitality', {
      graphId: GRAPH_ID,
      sourceId,
    });
    const beforeNodes = detail?.nodeCount ?? s.nodeCount ?? 0;
    const polluted =
      POLLUTION_RE.test(detail?.text ?? '') ||
      beforeNodes > 45 ||
      PRIORITY.has(name);

    if (!polluted) {
      results.push({
        name,
        sourceId,
        action: 'skip',
        reason: 'no pollution detected',
        beforeNodes,
        vitality: beforeVitality?.score,
      });
      continue;
    }

    let sourceText = extractCleanSource(detail?.text ?? '');
    if (!sourceText || sourceText.length < 80 || POLLUTION_RE.test(sourceText)) {
      const historyRes = await ipcCall('skill:history', { graphId: GRAPH_ID, sourceId });
      const history = Array.isArray(historyRes) ? historyRes : historyRes?.versions ?? [];
      const fromSnap = await getCleanSourceFromSnapshot(sourceId, history);
      if (fromSnap) sourceText = fromSnap;
    }

    if (!sourceText || sourceText.length < 80) {
      results.push({
        name,
        sourceId,
        action: 'fail',
        reason: 'could not extract clean source',
        beforeNodes,
        vitality: beforeVitality?.score,
      });
      continue;
    }

    try {
      const trainResult = await ipcCall('skill:train', {
        skill: sourceText,
        graphId: GRAPH_ID,
        skillName: name,
        save: true,
        useLlmRewrite: false,
      });

      if (trainResult?.upgrade_required) {
        results.push({
          name,
          sourceId,
          action: 'fail',
          reason: 'upgrade_required',
          beforeNodes,
          vitality: beforeVitality?.score,
        });
        continue;
      }

      detail = await ipcCall('skill:get', { graphId: GRAPH_ID, sourceId });
      const afterVitality = await ipcCall('skill:vitality', {
        graphId: GRAPH_ID,
        sourceId,
      });
      const afterNodes = detail?.nodeCount ?? 0;
      const stillPolluted = POLLUTION_RE.test(detail?.text ?? '');

      results.push({
        name,
        sourceId,
        action: stillPolluted ? 'retrain-partial' : 'retrained',
        beforeNodes,
        afterNodes,
        vitalityBefore: beforeVitality?.score,
        vitalityAfter: afterVitality?.score,
        mode: trainResult?.mode,
        influentialNodes: trainResult?.influentialNodes?.length ?? 0,
        stillPolluted,
      });
      console.log(
        `${stillPolluted ? 'PARTIAL' : 'OK'} ${name}: nodes ${beforeNodes}→${afterNodes}, vitality ${beforeVitality?.score}→${afterVitality?.score}`,
      );
    } catch (err) {
      results.push({
        name,
        sourceId,
        action: 'fail',
        reason: String(err.message ?? err),
        beforeNodes,
        vitality: beforeVitality?.score,
      });
      console.error(`FAIL ${name}:`, err.message ?? err);
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
