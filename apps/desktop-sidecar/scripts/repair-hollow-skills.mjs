/**
 * Repair hollow skills (zero live walkable nodes) in graphnosis-skills.
 *
 * Hollow skills survive in-place retrain failures with a "(trained …)" label
 * but no live nodes. This script:
 *   1. Scans ALL skills (or a priority subset when GRAPHNOSIS_PRIORITY_ONLY=1)
 *   2. Skips non-hollow skills — never retrains walkable skills
 *   3. For hollow duplicate stubs: forgets them when a walkable source exists
 *   4. Tries snapshot replay (skill:get → repairHollowSkillSource)
 *   5. Retrains from live source text, snapshot text, donor engram, or known recovery text
 *
 * Usage:
 *   node apps/desktop-sidecar/scripts/repair-hollow-skills.mjs
 *   GRAPHNOSIS_IPC_SOCKET=/path/to/sidecar.sock node apps/desktop-sidecar/scripts/repair-hollow-skills.mjs
 *
 * Optional env:
 *   GRAPHNOSIS_CORTEX              — cortex root (default: ~/Graphnosis-test)
 *   GRAPHNOSIS_IPC_SOCKET          — sidecar IPC socket (default: $CORTEX/sidecar.sock)
 *   GRAPHNOSIS_SKILLS_GRAPH        — target engram (default: graphnosis-skills)
 *   GRAPHNOSIS_DONOR_GRAPH         — fallback engram for donor text (default: graphnosis-trained-skills)
 *   GRAPHNOSIS_PRIORITY_ONLY=1     — only scan PRIORITY set (legacy behavior)
 *   GRAPHNOSIS_DRY_RUN=1           — report only; no forget/retrain
 */
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CORTEX =
  process.env.GRAPHNOSIS_CORTEX ??
  path.join(os.homedir(), 'Graphnosis-test');
const SOCKET =
  process.env.GRAPHNOSIS_IPC_SOCKET ?? path.join(CORTEX, 'sidecar.sock');
const GRAPH_ID = process.env.GRAPHNOSIS_SKILLS_GRAPH ?? 'graphnosis-skills';
const DONOR_GRAPH = process.env.GRAPHNOSIS_DONOR_GRAPH ?? 'graphnosis-trained-skills';
const PRIORITY_ONLY = process.env.GRAPHNOSIS_PRIORITY_ONLY === '1';
const DRY_RUN = process.env.GRAPHNOSIS_DRY_RUN === '1';

/** Skills known to have been hollow in the Autonomous Skill Lifecycle batch. */
const PRIORITY = new Set([
  'skill-maintenance-review',
  'adaptive-skill-creation',
  'dispatch-export-sync',
  'ghampus-operator',
]);

/**
 * Recovery source text captured from train_skill calls when snapshots are empty.
 * Keys are base skill slugs. Only include text we can attribute to the skill itself.
 */
const KNOWN_SOURCES = {
  'compliance-evidence-pack-ops': `compliance-evidence-pack-ops

Evidence Pack Export — Compliance Audit Bundle Walk SOP

Trigger: Testing or verifying Evidence Pack export after compliance work. User asks to export audit bundle, verify Evidence Pack IPC, or smoke compliance export from Activity UI. Enterprise compliance batch close. [dispatch-safe: yes]

Prerequisites: Enterprise license active. compliance.enabled in settings. Sidecar running. At least one engram loaded for scoped export.

Requires: $exportScope:{all|engram}, $dateBounds:{since?:number, until?:number}

Produces: $evidencePackJson, $exportOk, $integrityChecks

Success: Evidence Pack JSON downloaded or returned via IPC with op-log events, MCP audit rows, consent metadata, SHA-256 hashes. No keys, passphrases, or raw recall queries in bundle. [verify: tool]

Out of scope: Legal hold enforcement, retention purge, SAML provisioning.

On failure: Route to bug-investigation if IPC fails; security-review-cadence if bundle contains secrets.

On completion: Log export scope and hash count in batch report if part of compliance batch.

1. Confirm enterprise gate: sharing:planInfo returns enterprise=true. Activity pane shows Evidence Pack section only when enterprise.

2. Choose export path:
   a. UI: Settings → Activity → Evidence Pack button (apps/desktop/src/ui/activity.ts wireActivityComplianceExport)
   b. IPC: compliance.exportEvidencePack with { since?, until?, engram? } (apps/desktop-sidecar/src/ipc.ts)

3. Set $dateBounds from Activity date filters or explicit since/until epoch ms. Optional engram slug scopes the pack.

4. Invoke export. Expect { ok: true, pack: {...} }. On ok:false capture reason/message for bug report.

5. Integrity checks on $evidencePackJson:
   - Contains audit/event metadata with hashes (SHA-256)
   - Contains MCP audit events if MCP was used in window
   - Does NOT contain encryption keys, passphrases, recovery phrases, or raw user queries
   - Op-log events present when window overlaps activity

6. Save sample to sandbox/evidence-pack-<date>.json for batch verification (local only; do not commit).

7. If export fails after code change: run pnpm --filter @graphnosis-app/desktop-sidecar smoke (legal hold + evidence pack tests). @skill: sidecar-change-verify if sidecar touched.

8. Append friction notes to sandbox/skill-improvements/compliance-evidence-pack-ops.md if procedure gaps found (Autonomous Skill Praxis improvement loop).`,

  'ghampus-operator': `ghampus-operator

Ghampus Operator — Proactive dispatch, away digest, savings, linked files, skill routing

Trigger: Operating Ghampus subsystems, debugging proactive cards, away digest, savings tracker, linked file attachments, or Ghampus model routing. Ghampus batch work or operator runbook. Session start when Ghampus-specific work is planned. [dispatch-safe: yes]

Prerequisites: Cortex unlocked. Sidecar running. graphnosis-skills engram loaded for dispatch routing.

Requires: $subsystem:{proactive|digest|savings|linked-files|routing|all}

Produces: $operatorReport

Success: Subsystem verified or issue routed to bug-investigation. Operator notes saved to coding engram. Smoke phases for touched subsystems pass. [verify: tool]

Out of scope: Training new skills (→ adaptive-skill-creation). Full ship (→ ship-workflow). Enterprise compliance export (→ compliance-evidence-pack-ops).

On failure: @skill: bug-investigation

On completion: remember operator findings in coding engram with subsystem tag and date.

1. recall("Ghampus proactive watcher startupDelayMs away digest savings linked files attachments model routing",
   only_engrams=["coding", "graphnosis-skills"]). Surface recent Ghampus batch notes and open issues. @needs: reasoning

2. Skill-dispatch routing for Ghampus context: call list_skills(engram="graphnosis-skills") — titles + sourceIds only.
   When $subsystem touches proactive cards, match context against skill-dispatch Trigger lines
   (apps/desktop-sidecar/src/proactive-dispatch-match.ts, proactive-watcher.ts).
   For matched skills: walk_skill_structured only for those skills — never pre-load the whole library.
   ghampus-operator itself is dispatch-safe; exclude it from proactive auto-proposal (meta runbook). @needs: fast

3. Proactive dispatch ($subsystem=proactive or all):
   - Confirm settings.agent.proactive.startupDelayMs (default 5 min) in Settings → Ghampus → Proactive.
   - ProactiveWatcher respects startupDelayMs on boot before first tick (proactive-watcher.ts).
   - Three-pass matching: dispatch trigger lines → keyword overlap → time-based cadence rules.
   - Anti-spam: max 5 new cards/session; 6h suppress per {signalType, skillSourceId}.
   - Cards surface in Ghampus chat — user Run / Snooze / Dismiss; state in proactive-watcher-state.json. @needs: code

4. Away digest ($subsystem=digest or all):
   - away-digest.ts: groupNotificationsByOrigin, buildGroupedDigestBody, 6h dedupe (AWAY_DIGEST_DEDUPE_MS).
   - Quiet card when nothing new since last visit (isQuietAwayDigestText).
   - IPC ghampus:digest; sensitive tiers redacted in previews.
   - Optional one-line LLM summary via local model when enabled. @needs: summarization

5. Savings panel ($subsystem=savings or all):
   - savings-tracker.ts records recall-only (MCP recall/dig_deeper/cross_search) and routing deltas.
   - settings.models.savingsBaseline drives counterfactual USD (default Claude Sonnet 4.6).
   - Ghampus Settings → Models shows baseline editor; Activity rollup reads savings-log.jsonl.
   - agent-walker recordRoutingSavings after each skill-walk step. @needs: reasoning

6. Linked files ($subsystem=linked-files or all):
   - attachments-store: attach → list → verify → repair by contentHash.
   - UI: Ghampus linked-files panel (apps/desktop/src/ui/ghampus.ts).
   - Smoke: move original path, verify reports broken, repairAttachmentPath restores ok. @needs: code

7. Model routing ($subsystem=routing or all):
   - Settings → Models: Ollama, MLX (http://127.0.0.1:8080/v1), vLLM (http://127.0.0.1:8000/v1).
   - model-router planSkillWalk + deriveStepsFromText @needs annotations pick per-step models.
   - agent-walker dispatches: Ollama native, mlx/vllm OpenAI-compatible, Anthropic/OpenAI BYOK cloud.
   - Unreachable local server → step error, walk continues (graceful degrade). @needs: structured-output

8. Run pnpm --filter @graphnosis-app/desktop-sidecar smoke — proactive-dispatch-match, away-digest,
   linked-files, savings-baseline phases must pass. @needs: fast

9. Synthesize $operatorReport: subsystem status, failures, follow-ups. remember in coding engram. @needs: writing`,

  'skill-dispatch': `skill-dispatch

Skill Dispatch — Entry Point for All Coding Skills

Trigger: Session beginning or situation matching a trained skill. [dispatch-safe: yes]

Requires: $currentContext:string

Produces: $matchedSkills, $invokedSkills

Success: Only applicable skills loaded via list_skills + walk_skill_structured. [verify: state]

1. Call list_skills(engram="graphnosis-skills"). Load titles + sourceIds ONLY. @needs: fast

2. Classify $currentContext against skill Trigger fields; match ship, bug, session-start, etc. @needs: reasoning

3. For each matched skill: walk_skill_structured(graphId, sourceId). Execute steps in order. @needs: structured-output

4. Log friction to sandbox/skill-improvements/<skill-slug>.md if no skill matches.`,

  'ship-workflow': `ship-workflow

Ship Workflow — Batch commits and release

Trigger: Explicit ship signal from user. [dispatch-safe: no]

Requires: $shipScope:string

Success: Grouped commits, changelog compiled, user confirmed tag if requested. [verify: human]

1. git status + git diff --stat — agree scope with user. @needs: reasoning

2. Group changes by concern; one commit per concern with real changelog. @needs: writing

3. Before tag: regenerate docs-content.generated.ts if shipping release. @needs: code

On failure: @skill: bug-investigation`,

  'bug-investigation': `bug-investigation

Bug Investigation — Loop until smoke passes

Trigger: Bug, error, or failing test. [dispatch-safe: no]

Requires: $errorDescription:string

Produces: $rootCause, $fixSummary

Success: pnpm --filter @graphnosis-app/desktop-sidecar smoke passes. [verify: tool]

1. Reproduce the failure; capture exact error output. @needs: reasoning, code

2. Narrow root cause — read stack, bisect recent changes. @needs: code

3. Apply minimal fix matching conventions. @needs: code

4. Run smoke; loop until pass or surface blocker to user. @needs: fast`,

  'session-start': `session-start

Session Start — Recall context before coding

Trigger: Beginning of every coding session. [dispatch-safe: yes]

1. recall("GraphnosisApp open todos priorities recent decisions", only_engrams=["coding"]). @needs: fast

2. recall("graphnosis app skill dispatch session", only_engrams=["graphnosis-skills"]). @needs: fast

3. Surface blockers, ship-pending changes, and today's focus to user. @needs: summarization`,
};

function baseSkillName(ref) {
  return String(ref ?? '')
    .replace(/^skill:\d+:/, '')
    .replace(/\s*\(trained[^)]*\)\s*$/i, '')
    .trim();
}

function normalizeSkillKey(name) {
  return baseSkillName(name).toLowerCase().replace(/\s+/g, '-');
}

function stripMetadataHeader(text) {
  return text
    .replace(/^(?:#[^\n]+|\*\*[^\n]+\*\*)\n+<!--[\s\S]*?-->\n+/, '')
    .trim();
}

function extractCleanSource(text) {
  return stripMetadataHeader(String(text ?? '')).trim();
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
    socket.setTimeout(180_000, () => {
      socket.destroy();
      reject(new Error(`IPC timeout for ${method}`));
    });
  });
}

async function getSourceFromSnapshot(sourceId, history) {
  const candidates = [...history]
    .filter((h) => h.snapshotId)
    .sort((a, b) => (b.ingestedAt ?? 0) - (a.ingestedAt ?? 0));

  for (const entry of candidates) {
    const snap = await ipcCall('skill:getSnapshot', {
      graphId: GRAPH_ID,
      sourceId,
      snapshotId: entry.snapshotId,
    });
    if (!snap?.text) continue;
    const clean = extractCleanSource(snap.text);
    if (clean.length > 80) return clean;
  }
  return null;
}

async function countWalkSteps(sourceId) {
  try {
    const walk = await ipcCall('skill:walkSequence', {
      graphId: GRAPH_ID,
      sourceId,
      recursive: false,
    });
    return (walk?.steps ?? []).length;
  } catch {
    return 0;
  }
}

async function isHollow(sourceId, detail) {
  const nodeCount = detail?.nodeCount ?? 0;
  if (nodeCount === 0) return true;
  const walkSteps = await countWalkSteps(sourceId);
  return walkSteps === 0;
}

async function buildDonorIndex(graphId) {
  const index = new Map();
  try {
    const skills = await ipcCall('skill:list', { graphId });
    for (const s of skills) {
      const key = normalizeSkillKey(s.ref ?? s.label ?? '');
      const walkSteps = await countWalkStepsInGraph(graphId, s.sourceId);
      if (walkSteps === 0) continue;
      const existing = index.get(key);
      if (!existing || (s.nodeCount ?? 0) > (existing.nodeCount ?? 0)) {
        index.set(key, s);
      }
    }
  } catch (err) {
    console.warn(`WARN: could not list donor graph ${graphId}:`, err.message ?? err);
  }
  return index;
}

async function countWalkStepsInGraph(graphId, sourceId) {
  try {
    const walk = await ipcCall('skill:walkSequence', {
      graphId,
      sourceId,
      recursive: false,
    });
    return (walk?.steps ?? []).length;
  } catch {
    return 0;
  }
}

async function resolveSourceText(sourceId, detail, name, donorIndex) {
  let sourceText = extractCleanSource(detail?.text ?? '');
  if (sourceText.length > 80) return { sourceText, from: 'live-text' };

  const historyRes = await ipcCall('skill:history', { graphId: GRAPH_ID, sourceId });
  const history = Array.isArray(historyRes) ? historyRes : historyRes?.versions ?? [];
  const fromSnap = await getSourceFromSnapshot(sourceId, history);
  if (fromSnap) return { sourceText: fromSnap, from: 'snapshot' };

  const key = normalizeSkillKey(name);
  const known = KNOWN_SOURCES[key];
  if (known) return { sourceText: known, from: 'known-recovery' };

  const donor = donorIndex.get(key);
  if (donor) {
    const donorDetail = await ipcCall('skill:get', {
      graphId: DONOR_GRAPH,
      sourceId: donor.sourceId,
    });
    const donorText = extractCleanSource(donorDetail?.text ?? '');
    if (donorText.length > 80) {
      return { sourceText: donorText, from: `donor:${DONOR_GRAPH}` };
    }
  }

  return { sourceText: '', from: 'none' };
}

async function main() {
  const skills = await ipcCall('skill:list', { graphId: GRAPH_ID });
  const donorIndex = await buildDonorIndex(DONOR_GRAPH);

  const byName = new Map();
  for (const s of skills) {
    const name = baseSkillName(s.ref ?? s.label ?? '');
    const key = normalizeSkillKey(name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(s);
  }

  const scanList = PRIORITY_ONLY
    ? skills.filter((s) => PRIORITY.has(normalizeSkillKey(s.ref ?? s.label ?? '')))
    : skills;

  console.log(
    `Scanning ${scanList.length}/${skills.length} skill(s) in ${GRAPH_ID} via ${SOCKET}` +
      (DRY_RUN ? ' [DRY RUN]' : ''),
  );

  const results = [];
  let hollowBefore = 0;

  for (const s of scanList) {
    const name = baseSkillName(s.ref ?? s.label ?? '');
    const key = normalizeSkillKey(name);
    const sourceId = s.sourceId;

    // skill:get triggers repairHollowSkillSource before returning detail
    let detail = await ipcCall('skill:get', { graphId: GRAPH_ID, sourceId });
    const hollow = await isHollow(sourceId, detail);
    const beforeNodes = detail?.nodeCount ?? s.nodeCount ?? 0;
    const beforeWalk = await countWalkSteps(sourceId);

    if (!hollow) {
      results.push({
        name,
        sourceId,
        action: 'skip',
        reason: 'already walkable',
        beforeNodes,
        beforeWalk,
      });
      continue;
    }

    hollowBefore++;

    const siblings = (byName.get(key) ?? []).filter((x) => x.sourceId !== sourceId);
    const walkableSibling = siblings.find((x) => (x.nodeCount ?? 0) > 0);
    if (walkableSibling) {
      const siblingWalk = await countWalkSteps(walkableSibling.sourceId);
      if (siblingWalk > 0) {
        if (!DRY_RUN) {
          await ipcCall('sources.forget', {
            graphId: GRAPH_ID,
            sourceId,
          });
        }
        results.push({
          name,
          sourceId,
          action: DRY_RUN ? 'would-forget-duplicate' : 'forgot-duplicate',
          reason: `walkable sibling ${walkableSibling.sourceId}`,
          beforeNodes,
          beforeWalk,
          keptSourceId: walkableSibling.sourceId,
        });
        console.log(
          `${DRY_RUN ? 'WOULD FORGET' : 'FORGOT'} duplicate ${name}: ${sourceId} (kept ${walkableSibling.sourceId})`,
        );
        continue;
      }
    }

    const { sourceText, from } = await resolveSourceText(sourceId, detail, name, donorIndex);
    if (!sourceText || sourceText.length < 80) {
      results.push({
        name,
        sourceId,
        action: 'fail',
        reason: 'no source text or snapshot',
        beforeNodes,
        beforeWalk,
      });
      console.error(`FAIL ${name}: no source to retrain from`);
      continue;
    }

    if (DRY_RUN) {
      results.push({
        name,
        sourceId,
        action: 'would-retrain',
        from,
        beforeNodes,
        beforeWalk,
        sourceLen: sourceText.length,
      });
      console.log(`WOULD RETRAIN ${name} from ${from} (${sourceText.length} chars)`);
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
          beforeWalk,
        });
        continue;
      }

      detail = await ipcCall('skill:get', { graphId: GRAPH_ID, sourceId });
      const afterNodes = detail?.nodeCount ?? 0;
      const afterWalk = await countWalkSteps(sourceId);
      const ok = afterWalk > 0;

      results.push({
        name,
        sourceId,
        action: ok ? 'retrained' : 'retrain-partial',
        from,
        beforeNodes,
        afterNodes,
        beforeWalk,
        afterWalk,
        mode: trainResult?.mode,
      });
      console.log(
        `${ok ? 'OK' : 'PARTIAL'} ${name} (${from}): nodes ${beforeNodes}→${afterNodes}, walk ${beforeWalk}→${afterWalk}`,
      );
    } catch (err) {
      results.push({
        name,
        sourceId,
        action: 'fail',
        reason: String(err.message ?? err),
        beforeNodes,
        beforeWalk,
      });
      console.error(`FAIL ${name}:`, err.message ?? err);
    }
  }

  // Post-scan hollow count
  let hollowAfter = 0;
  const postSkills = await ipcCall('skill:list', { graphId: GRAPH_ID });
  for (const s of postSkills) {
    const detail = await ipcCall('skill:get', { graphId: GRAPH_ID, sourceId: s.sourceId });
    if (await isHollow(s.sourceId, detail)) hollowAfter++;
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Hollow before: ${hollowBefore} (scanned) / ${postSkills.length} total engram`);
  console.log(`Hollow after:  ${hollowAfter}`);
  console.log(JSON.stringify(results, null, 2));

  const failed = results.filter(
    (r) => r.action === 'fail' || r.action === 'retrain-partial',
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
