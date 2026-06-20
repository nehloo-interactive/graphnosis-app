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

/** Retrain one queued skill — at most one per Ghampus idle window unless batch-confirmed. */
export async function retrainSingleQueuedSkill(
  host: GraphnosisHost,
  skillTrainer: SkillTrainer,
  sourceId: string,
  totalActiveNodes: number,
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
    const autonomy = cfg?.autonomyLevel ?? 'notify';
    const willSave = autonomy !== 'preview-first';
    const result = await skillTrainer.trainSkill({
      skill: detail.text,
      graphId: entry.graphId,
      skillName: detail.label,
      save: willSave,
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
    if (autonomy === 'notify') {
      const notifs = new Set(settings.skillRetrainNotifications ?? []);
      notifs.add(sourceId);
      patch.skillRetrainNotifications = [...notifs];
    }
    if (autonomy === 'preview-first') {
      patch.skillRetrainPending = {
        ...(settings.skillRetrainPending ?? {}),
        [sourceId]: {
          graphId: entry.graphId,
          proposedAt: Date.now(),
          trained: result.trained,
          ...(result.diffNotes !== undefined ? { diffNotes: result.diffNotes } : {}),
          triggerReason: `source-changes:${entry.reason}`,
        },
      };
    }
    if (Object.keys(patch).length > 0) await host.setSettings(patch);
    console.log(`[skill-maintenance] retrained ${detail.label} (${sourceId}) — ${entry.reason}`);
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
