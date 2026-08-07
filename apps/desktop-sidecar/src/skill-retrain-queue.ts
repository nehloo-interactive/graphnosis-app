/**
 * Staleness queue — skills whose cited memory nodes changed since training.
 */
import type { SkillCitedNodesEntry, SkillRetrainQueueEntry } from '@graphnosis-app/core';
import type { GraphnosisHost } from './host.js';
import type { SkillTrainer } from './skill-trainer.js';

export async function persistSkillCitedNodes(
  host: GraphnosisHost,
  skillSourceId: string,
  graphId: string,
  nodeIds: string[],
): Promise<void> {
  if (nodeIds.length === 0) return;
  const nodes: Record<string, string> = {};
  for (const id of nodeIds) nodes[id] = graphId;
  const settings = host.getSettings();
  await host.setSettings({
    skillCitedNodes: {
      ...(settings.skillCitedNodes ?? {}),
      [skillSourceId]: { graphId, nodes },
    },
  });
}

/**
 * Move skill citations from a node the graph RETIRED onto the node it minted
 * in its place.
 *
 * WHY. `skillCitedNodes` is written once, AT TRAIN TIME, and is the only thing
 * `enqueueSkillsForNodeChange` matches against. A correction that retires and
 * mints (`supersede` on every supported SDK including the installed 0.8.0;
 * `edit` too from 0.10.0) leaves the citation naming the RETIRED husk. The
 * first correction still queues the skill, because `applyCorrection` hands the
 * enqueue BOTH the pre-correction id and the minted one — but from then on the
 * skill cites an id no future correction will ever target again, so the SECOND
 * correction to that same memory matches nothing and the skill silently stops
 * noticing that its own evidence changed. `computeSkillVitality`'s cited-node
 * drift count reads the same map and goes wrong the same way: it looks up the
 * husk, finds it retired, and reports permanent drift that retraining cannot
 * clear.
 *
 * BATCHED ON PURPOSE — do not "simplify" this back to one call per edit.
 * `host.setSettings` is a full serialize + encrypt + fsync of settings.json
 * behind a write queue. `applyCorrection` takes a BATCH of edits and the brain
 * engine drives it in bulk, so a per-edit write would turn one correction batch
 * into N disk writes and N listener broadcasts. Every move in the batch is
 * folded into a single settings object and written once — and not at all when
 * no skill cites any of the moved nodes, which is the overwhelmingly common
 * case.
 *
 * MATCH ON THE VALUE, not `entry.graphId`. In a `SkillCitedNodesEntry`,
 * `graphId` is the engram the SKILL lives in, while `nodes[nodeId]` is the
 * engram the CITED node lives in — cited nodes routinely span other personal
 * engrams (see `syncSkillCitedNodesFromRecipes`). The node we corrected is in
 * `graphId`, so the value is what has to match; keying off `entry.graphId`
 * would rebind citations in the wrong engram and miss the right ones.
 *
 * Returns true when something actually moved (a settings write happened).
 */
export async function rebindSkillCitedNodes(
  host: GraphnosisHost,
  graphId: string,
  moves: Array<{ from: string; to: string }>,
): Promise<boolean> {
  const real = moves.filter((m) => m.from !== m.to && m.to.length > 0);
  if (real.length === 0) return false;
  const cited = host.getSettings().skillCitedNodes ?? {};
  const next: Record<string, SkillCitedNodesEntry> = {};
  let changed = false;

  for (const [sourceId, entry] of Object.entries(cited) as Array<[string, SkillCitedNodesEntry]>) {
    let nodes: Record<string, string> | undefined;
    for (const { from, to } of real) {
      // Only a citation of THIS engram's node moves. A same-id citation that
      // resolves to a different engram is a different node.
      if (entry.nodes[from] !== graphId) continue;
      nodes ??= { ...entry.nodes };
      delete nodes[from];
      // Idempotent when the skill already cites the minted id (a skill trained
      // after an earlier rebind): the husk simply drops out.
      nodes[to] = graphId;
    }
    if (nodes) {
      next[sourceId] = { ...entry, nodes };
      changed = true;
    } else {
      next[sourceId] = entry;
    }
  }

  if (!changed) return false;
  await host.setSettings({ skillCitedNodes: next });
  return true;
}

export async function enqueueSkillsForNodeChange(
  host: GraphnosisHost,
  graphId: string,
  nodeIds: string[],
  reason: SkillRetrainQueueEntry['reason'],
  skillTrainer?: SkillTrainer,
): Promise<void> {
  if (nodeIds.length === 0) return;
  const cited = host.getSettings().skillCitedNodes ?? {};
  const queue = { ...(host.getSettings().skillRetrainQueue ?? {}) };
  const nodeSet = new Set(nodeIds);
  let changed = false;

  for (const [sourceId, entry] of Object.entries(cited) as Array<[string, SkillCitedNodesEntry]>) {
    const affected = Object.entries(entry.nodes)
      .filter(([nid, eg]) => nodeSet.has(nid) && eg === graphId)
      .map(([nid]) => nid);
    if (affected.length === 0) continue;

    let skillLabel: string | undefined;
    try {
      skillLabel = skillTrainer?.getSkill(entry.graphId, sourceId)?.label;
    } catch { /* skill engram may be unloaded */ }

    const prior = queue[sourceId];
    const mergedIds = new Set([...(prior?.affectedNodeIds ?? []), ...affected]);
    queue[sourceId] = {
      graphId: entry.graphId,
      sourceId,
      ...(skillLabel ? { skillLabel } : {}),
      queuedAt: Date.now(),
      reason,
      affectedNodeIds: [...mergedIds],
    };
    changed = true;
  }

  if (changed) await host.setSettings({ skillRetrainQueue: queue });
}

export async function clearSkillRetrainQueueEntry(
  host: GraphnosisHost,
  sourceId: string,
): Promise<void> {
  const queue = { ...(host.getSettings().skillRetrainQueue ?? {}) };
  if (!(sourceId in queue)) return;
  delete queue[sourceId];
  await host.setSettings({ skillRetrainQueue: queue });
}

export function countSkillRetrainQueue(host: GraphnosisHost): number {
  return Object.keys(host.getSettings().skillRetrainQueue ?? {}).length;
}

/** Enqueue skills whose cited memory nodes are missing or soft-deleted. */
export async function auditSkillCitedNodeDrift(
  host: GraphnosisHost,
  skillTrainer?: SkillTrainer,
): Promise<number> {
  const cited = host.getSettings().skillCitedNodes ?? {};
  const now = Date.now();
  let enqueued = 0;

  for (const [sourceId, entry] of Object.entries(cited)) {
    const missing: string[] = [];
    for (const [nodeId, graphId] of Object.entries(entry.nodes)) {
      if (!host.listGraphs().includes(graphId)) {
        missing.push(nodeId);
        continue;
      }
      const nodes = host.listNodes(graphId);
      const n = nodes.find((x) => x.id === nodeId);
      if (!n || n.confidence <= 0.2 || (n.validUntil !== undefined && n.validUntil <= now)) {
        missing.push(nodeId);
      }
    }
    if (missing.length === 0) continue;
    await enqueueSkillsForNodeChange(host, entry.graphId, missing, 'source-forgotten', skillTrainer);
    enqueued++;
  }
  return enqueued;
}

/** Oldest queued skill that is still valid — used by Ghampus maintenance. */
export function pickNextQueueEntry(
  host: GraphnosisHost,
  skillTrainer: SkillTrainer,
): SkillRetrainQueueEntry | null {
  const settings = host.getSettings();
  const queue = settings.skillRetrainQueue ?? {};
  const entries = Object.entries(queue).sort(([, a], [, b]) => a.queuedAt - b.queuedAt);

  for (const [sourceId, entry] of entries) {
    const cfg = settings.skillAutoRetrain?.[sourceId];
    if (cfg && !cfg.enabled) continue;
    if (!host.listGraphs().includes(entry.graphId)) continue;
    const detail = skillTrainer.getSkill(entry.graphId, sourceId);
    if (!detail) {
      void clearSkillRetrainQueueEntry(host, sourceId);
      continue;
    }
    return entry;
  }
  return null;
}

export interface RetrainQueuedSkillResult {
  ok: boolean;
  reason?: string;
  label?: string;
}

export interface RetrainQueuedSkillOpts {
  /** Open contradictions on the target skill engram (Memory Integrity). */
  hasOpenContradictions?: boolean;
}

/** Retrain one queued skill — at most one per Ghampus idle window unless batch-confirmed. */
export async function retrainSingleQueuedSkill(
  host: GraphnosisHost,
  skillTrainer: SkillTrainer,
  sourceId: string,
  totalActiveNodes: number,
  opts?: RetrainQueuedSkillOpts,
): Promise<RetrainQueuedSkillResult> {
  const settings = host.getSettings();
  const entry = settings.skillRetrainQueue?.[sourceId];
  if (!entry) return { ok: false, reason: 'not-queued' };

  const cfg = settings.skillAutoRetrain?.[sourceId];
  if (cfg && !cfg.enabled) return { ok: false, reason: 'autoretrain-disabled' };
  if (!host.listGraphs().includes(entry.graphId)) return { ok: false, reason: 'graph-unloaded' };

  const detail = skillTrainer.getSkill(entry.graphId, sourceId);
  if (!detail) {
    await clearSkillRetrainQueueEntry(host, sourceId);
    return { ok: false, reason: 'skill-missing' };
  }

  try {
    const { decideTrainAdmission } = await import('./skill-train-admission.js');
    const { resolveEvolveAutonomyLevel, capPraxisByEvolve } = await import('@graphnosis-app/core/settings');
    // Staleness without Praxis opt-in → draft only. Never silent-save.
    const praxisEnabled = !!cfg?.enabled;
    const hasOpenContradictions = opts?.hasOpenContradictions === true;
    const engramEvolve = resolveEvolveAutonomyLevel(host.getGraphMetadata(entry.graphId));
    const rawAutonomy = cfg?.autonomyLevel ?? 'preview-first';
    const praxisAutonomy = capPraxisByEvolve(rawAutonomy, engramEvolve);
    const admission = decideTrainAdmission({
      caller: 'staleness-queue',
      skillLabel: detail.label,
      isNewSkill: false,
      requestedSave: true,
      praxisEnabled,
      praxisAutonomy,
      hasOpenContradictions,
    });
    if (admission.refuse) {
      return { ok: false, reason: admission.reason };
    }
    const result = await skillTrainer.trainSkill({
      skill: detail.text,
      graphId: entry.graphId,
      skillName: detail.label,
      save: admission.save,
      ...(detail.recallBreadth !== undefined ? { recallBreadth: detail.recallBreadth } : {}),
      addedBy: 'graphnosis-staleness-queue',
    });
    await clearSkillRetrainQueueEntry(host, sourceId);

    const patch: Parameters<typeof host.setSettings>[0] = {};
    if (cfg) {
      const next = { ...(settings.skillAutoRetrain ?? {}) };
      next[sourceId] = {
        ...cfg,
        lastAutoRetrain: Date.now(),
        lastNodeCountSnapshot: totalActiveNodes,
      };
      patch.skillAutoRetrain = next;
    }
    if (admission.notify) {
      const notifs = new Set(settings.skillRetrainNotifications ?? []);
      notifs.add(sourceId);
      patch.skillRetrainNotifications = [...notifs];
    }
    if (admission.stashAsProposal && !admission.save) {
      patch.skillRetrainPending = {
        ...(settings.skillRetrainPending ?? {}),
        [sourceId]: {
          graphId: entry.graphId,
          proposedAt: Date.now(),
          trained: result.trained,
          kind: 'retrain',
          sourceId,
          ...(result.diffNotes !== undefined ? { diffNotes: result.diffNotes } : {}),
          triggerReason: `source-changes:${entry.reason}`,
        },
      };
    }
    if (Object.keys(patch).length > 0) await host.setSettings(patch);
    console.log(
      `[skill-maintenance] ${admission.save ? 'saved' : 'drafted'} ${detail.label} (${sourceId}) — ${entry.reason} (${admission.reason})`,
    )

    // Re-bind cited nodes from recall recipes (empty-engram train contract).
    try {
      const { syncSkillCitedNodesFromRecipes } = await import('./skill-recall-bindings.js');
      await syncSkillCitedNodesFromRecipes(host, entry.graphId, sourceId);
    } catch { /* non-fatal */ }

    // Refresh dispatch registry when skill-dispatch or dispatch-export-sync retrained.
    try {
      const { scheduleDispatchSyncAfterRetrain } = await import('./skill-dispatch-sync.js');
      await scheduleDispatchSyncAfterRetrain(host, skillTrainer, entry.graphId, sourceId);
    } catch { /* non-fatal */ }

    return { ok: true, label: detail.label };
  } catch (e) {
    console.warn(`[skill-maintenance] retrain failed for ${sourceId}:`, e);
    return { ok: false, reason: (e as Error).message };
  }
}

/** Legacy batch drain — kept for tests; production uses Ghampus scheduler (one per window). */
export async function processSkillRetrainQueue(
  host: GraphnosisHost,
  skillTrainer: SkillTrainer,
  totalActiveNodes: number,
): Promise<void> {
  const entry = pickNextQueueEntry(host, skillTrainer);
  if (!entry) return;
  await retrainSingleQueuedSkill(host, skillTrainer, entry.sourceId, totalActiveNodes);
}

export type { SkillCitedNodesEntry };
