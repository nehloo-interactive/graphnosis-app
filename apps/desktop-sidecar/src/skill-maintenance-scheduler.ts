/**
 * Ghampus skill maintenance — drains AppSettings.skillRetrainQueue during idle
 * windows. At most one automatic retrain per tick window; batch retrains only
 * when the user confirms on a proactive card.
 */
import { resolveGhampusSkillMaintenance } from '@graphnosis-app/core/settings';
import type { SkillRetrainQueueEntry } from '@graphnosis-app/core';
import type { GraphnosisHost } from './host.js';
import type { SkillTrainer } from './skill-trainer.js';
import type { BroadcastRawFn } from './events.js';
import type { LicenseValidator } from './license-validator.js';
import { isGhampusBusy } from './ghampus-busy.js';
import {
  countSkillRetrainQueue,
  pickNextQueueEntry,
  retrainSingleQueuedSkill,
} from './skill-retrain-queue.js';

export interface SkillStaleCard {
  id: string;
  createdAt: number;
  signalType: 'skill-stale';
  signalLabel: string;
  skillSourceId: string;
  skillGraphId: string;
  skillLabel: string;
  totalStale: number;
  batchSourceIds: string[];
  why: string;
  status: 'pending' | 'running' | 'snoozed' | 'dismissed' | 'done';
}

export interface SkillMaintenanceSchedulerDeps {
  host: GraphnosisHost;
  skillTrainer: SkillTrainer;
  broadcastRaw: BroadcastRawFn;
  licenseValidator: LicenseValidator;
}

const TICK_MS = 90_000;
const SNOOZE_ON_DISMISS_MS = 6 * 60 * 60 * 1000;

export class SkillMaintenanceScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingCard: SkillStaleCard | null = null;
  private retrainedThisWindow = false;
  private windowStartedAt = 0;

  constructor(private deps: SkillMaintenanceSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    setTimeout(() => { void this.tick(); }, 5 * 60_000);
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getPendingCard(): SkillStaleCard | null {
    return this.pendingCard?.status === 'pending' || this.pendingCard?.status === 'running'
      ? this.pendingCard
      : null;
  }

  dismissCard(id: string): void {
    if (this.pendingCard?.id === id) this.pendingCard.status = 'dismissed';
  }

  snoozeCard(id: string, snoozeMs: number): void {
    if (this.pendingCard?.id === id) this.pendingCard.status = 'snoozed';
    void this.setSnoozedUntil(Date.now() + snoozeMs);
  }

  /** Test hook — bypass boot delay and return what happened. */
  async tickForTest(): Promise<{ action: 'idle' | 'card' | 'retrain' | 'skip'; detail?: string }> {
    return this.tick(true);
  }

  async runRetrain(sourceIds: string[]): Promise<{ ok: boolean; retrained: string[]; errors: string[] }> {
    const retrained: string[] = [];
    const errors: string[] = [];
    const totalActiveNodes = this.countActiveNodes();

    for (const sourceId of sourceIds) {
      try {
        const result = await retrainSingleQueuedSkill(
          this.deps.host,
          this.deps.skillTrainer,
          sourceId,
          totalActiveNodes,
        );
        if (result.ok) {
          retrained.push(sourceId);
          this.retrainedThisWindow = true;
        } else if (result.reason) {
          errors.push(`${sourceId}: ${result.reason}`);
        }
      } catch (e) {
        errors.push(`${sourceId}: ${(e as Error).message}`);
      }
    }

    if (this.pendingCard && sourceIds.includes(this.pendingCard.skillSourceId)) {
      this.pendingCard.status = retrained.length > 0 ? 'done' : 'pending';
    }

    return { ok: retrained.length > 0, retrained, errors };
  }

  private async tick(_test = false): Promise<{ action: 'idle' | 'card' | 'retrain' | 'skip'; detail?: string }> {
    const now = Date.now();
    if (now - this.windowStartedAt >= TICK_MS) {
      this.retrainedThisWindow = false;
      this.windowStartedAt = now;
    }

    const settings = this.deps.host.getSettings();
    if (settings.agent?.enabled === false) return { action: 'skip', detail: 'ghampus-disabled' };

    const maintenance = resolveGhampusSkillMaintenance(settings.agent);
    if (!maintenance.enabled) return { action: 'skip', detail: 'maintenance-disabled' };
    if (maintenance.snoozedUntil && now < maintenance.snoozedUntil) {
      return { action: 'skip', detail: 'snoozed' };
    }
    if (this.retrainedThisWindow) return { action: 'skip', detail: 'window-cap' };
    if (!this.canRun()) return { action: 'idle', detail: 'not-idle' };

    const licenseToken = await this.deps.host.getLicenseToken();
    if (!this.deps.licenseValidator.hasFeature(licenseToken, 'skill-training')) {
      return { action: 'skip', detail: 'unlicensed' };
    }

    const entry = pickNextQueueEntry(this.deps.host, this.deps.skillTrainer);
    if (!entry) {
      if (this.pendingCard) this.pendingCard = null;
      return { action: 'idle', detail: 'queue-empty' };
    }

    const totalStale = countSkillRetrainQueue(this.deps.host);
    const batchSourceIds = this.listQueueSourceIds();

    if (maintenance.idleOnly) {
      if (this.pendingCard?.status === 'pending' && this.pendingCard.skillSourceId === entry.sourceId) {
        return { action: 'idle', detail: 'card-pending' };
      }
      const card = this.buildCard(entry, totalStale, batchSourceIds);
      this.pendingCard = card;
      this.emitCard(card);
      return { action: 'card', detail: entry.sourceId };
    }

    const result = await this.runRetrain([entry.sourceId]);
    return result.ok
      ? { action: 'retrain', detail: entry.sourceId }
      : { action: 'skip', detail: result.errors[0] ?? 'retrain-failed' };
  }

  private canRun(): boolean {
    if (isGhampusBusy()) return false;
    if (this.deps.host.isBootSweepActive()) return false;
    if (this.deps.host.isBootEmbBuildActive()) return false;
    if (this.deps.host.isBootDeferredWorkActive()) return false;
    return true;
  }

  private listQueueSourceIds(): string[] {
    return Object.keys(this.deps.host.getSettings().skillRetrainQueue ?? {});
  }

  private countActiveNodes(): number {
    return this.deps.host.listGraphs().reduce((sum, gid) => {
      const meta = this.deps.host.getGraphMetadata(gid);
      if (meta?.archived) return sum;
      return sum + this.deps.host.listNodes(gid).length;
    }, 0);
  }

  private buildCard(
    entry: SkillRetrainQueueEntry,
    totalStale: number,
    batchSourceIds: string[],
  ): SkillStaleCard {
    const label = entry.skillLabel ?? entry.sourceId;
    const display = label.replace(/^skill:\d+:/, '').replace(/-/g, ' ');
    const signalLabel = totalStale === 1
      ? `1 skill stale — "${display}" needs retraining`
      : `${totalStale} skills stale — source memories changed since last train`;
    const why = totalStale === 1
      ? `**${display}** was trained from cortex memories that have since been edited or removed. Retraining keeps the skill aligned with your current memory.`
      : `**${totalStale} skills** cite memories that changed since they were last trained. I can retrain one now, or all ${totalStale} if you confirm.`;

    return {
      id: `stale-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      signalType: 'skill-stale',
      signalLabel,
      skillSourceId: entry.sourceId,
      skillGraphId: entry.graphId,
      skillLabel: label.replace(/^skill:\d+:/, ''),
      totalStale,
      batchSourceIds,
      why,
      status: 'pending',
    };
  }

  private emitCard(card: SkillStaleCard): void {
    try {
      this.deps.broadcastRaw({
        kind: 'ghampus.card',
        name: 'ghampus.card',
        payload: card,
      });
    } catch { /* non-fatal */ }
  }

  private async setSnoozedUntil(until: number): Promise<void> {
    const current = this.deps.host.getSettings();
    const agent = current.agent ?? { enabled: true };
    const sm = resolveGhampusSkillMaintenance(agent);
    await this.deps.host.setSettings({
      agent: {
        ...agent,
        skillMaintenance: { ...sm, snoozedUntil: until },
      },
    });
  }

  /** Dismiss + snooze — card won't reappear until the window elapses. */
  async dismissAndSnooze(cardId: string): Promise<void> {
    this.dismissCard(cardId);
    await this.setSnoozedUntil(Date.now() + SNOOZE_ON_DISMISS_MS);
  }
}
