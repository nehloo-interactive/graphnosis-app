/**
 * Sidecar idle housekeeping — op-log corrections sweep + compaction.
 *
 * NOT Ghampus-owned: silent sidecar maintenance (like boot-deferred reconcile),
 * not conversational agent work. No proactive cards — optional dbg() / Activity
 * status only. Ghampus skill maintenance (SkillMaintenanceScheduler) is separate.
 */
import type { GraphnosisHost } from './host.js';
import { isGhampusBusy } from './ghampus-busy.js';
import { clientActiveWithin, CLIENT_QUIET_MS, isIngestActive } from './client-activity.js';
import { dbg } from './log-redact.js';

export interface SidecarIdleMaintenanceDeps {
  host: GraphnosisHost;
}

const TICK_MS = 90_000;
/** First tick after start — mirrors SkillMaintenanceScheduler boot deferral. */
const INITIAL_DELAY_MS = 5 * 60_000;
/** At most one housekeeping pass per 24 h while the sidecar stays up. */
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class SidecarIdleMaintenance {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRunAt = 0;
  private inFlight = false;

  constructor(private deps: SidecarIdleMaintenanceDeps) {}

  start(): void {
    if (this.timer) return;
    setTimeout(() => { void this.tick(); }, INITIAL_DELAY_MS).unref?.();
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.bootNotifyTimer) {
      clearTimeout(this.bootNotifyTimer);
      this.bootNotifyTimer = null;
    }
  }

  /** One-shot nudge after boot sweep + deferred reconcile finish. */
  notifyBootSettled(): void {
    if (this.bootNotifyTimer) clearTimeout(this.bootNotifyTimer);
    this.bootNotifyTimer = setTimeout(() => { void this.tick(); }, 30_000);
    this.bootNotifyTimer.unref?.();
  }

  /** Test hook — bypass interval cap; still respects idle gates unless forced. */
  async tickForTest(force = false): Promise<{ action: 'run' | 'skip'; detail?: string }> {
    return this.tick(force);
  }

  private canRun(): boolean {
    if (isGhampusBusy()) return false;
    if (this.deps.host.isBootSweepActive()) return false;
    if (this.deps.host.isBootEmbBuildActive()) return false;
    if (this.deps.host.isBootDeferredWorkActive()) return false;
    if (isIngestActive()) return false;
    if (clientActiveWithin(CLIENT_QUIET_MS)) return false;
    return true;
  }

  private async tick(force = false): Promise<{ action: 'run' | 'skip'; detail?: string }> {
    if (this.inFlight) return { action: 'skip', detail: 'in-flight' };
    if (!force && this.lastRunAt > 0 && Date.now() - this.lastRunAt < MIN_INTERVAL_MS) {
      return { action: 'skip', detail: 'interval' };
    }
    if (!this.canRun()) return { action: 'skip', detail: 'not-idle' };

    this.inFlight = true;
    try {
      await this.deps.host.refreshAllCorrectionsFromOplog();
      this.lastRunAt = Date.now();
      dbg('[sidecar-idle-maintenance] oplog housekeeping complete');
      return { action: 'run' };
    } catch (e: unknown) {
      console.error(
        `[sidecar-idle-maintenance] oplog housekeeping failed: ${(e as Error).message}`,
      );
      return { action: 'skip', detail: 'error' };
    } finally {
      this.inFlight = false;
    }
  }
}
