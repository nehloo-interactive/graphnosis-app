/**
 * Sidecar idle housekeeping — op-log corrections sweep + compaction.
 *
 * NOT Ghampus-owned: silent sidecar maintenance (like boot-deferred reconcile),
 * not conversational agent work. No proactive cards — optional dbg() / Activity
 * status only. Ghampus skill maintenance (SkillMaintenanceScheduler) is separate.
 */
import type { GraphnosisHost, OplogCompactionResult } from './host.js';
import type { BroadcastRawFn } from './events.js';
import { isGhampusBusy } from './ghampus-busy.js';
import { clientActiveWithin, CLIENT_QUIET_MS, isIngestActive } from './client-activity.js';
import { dbg } from './log-redact.js';
import {
  measureOplogHealth,
  archiveOplogFiles,
  describeOplogHealth,
  readOplogHealthState,
  writeOplogHealthState,
  shouldPrompt,
  formatBytes,
  type OplogHealthReport,
} from './oplog-health.js';

export interface SidecarIdleMaintenanceDeps {
  host: GraphnosisHost;
  cortexDir: string;
  broadcastRaw?: BroadcastRawFn;
}

export function broadcastOplogCompacted(
  broadcastRaw: BroadcastRawFn | undefined,
  compaction: OplogCompactionResult,
  at: number,
): void {
  if (!compaction.compacted || !broadcastRaw || compaction.eventsRemoved === undefined) return;
  try {
    broadcastRaw({
      kind: 'oplog.compacted',
      name: 'oplog.compacted',
      payload: {
        at,
        eventsRemoved: compaction.eventsRemoved,
        eventsBefore: compaction.eventsBefore,
        eventsAfter: compaction.eventsAfter,
        bytesBefore: compaction.bytesBefore,
        bytesAfter: compaction.bytesAfter,
      },
    });
  } catch { /* non-fatal */ }
}

const TICK_MS = 90_000;
/** First tick after start — mirrors SkillMaintenanceScheduler boot deferral. */
const INITIAL_DELAY_MS = 5 * 60_000;
/** At most one housekeeping pass per 24 h while the sidecar stays up. */
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Weekly compliance retention dry-run (log only — never auto-purge). */
const RETENTION_DRY_RUN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export class SidecarIdleMaintenance {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRunAt = 0;
  private lastRetentionDryRunAt = 0;
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
      // ── Op-log health, FIRST ────────────────────────────────────────────
      // Deliberately above refreshAllCorrectionsFromOplog(). That call
      // materialises the whole op-log (host.ts listOplogEvents), which on the
      // measured pathology meant 24.37 GB resident with zero operations
      // queued. A check placed after it pays the exact cost it exists to
      // prevent — and on a cortex already too big to materialise, the tick
      // dies before ever reaching the check.
      const health = await this.checkOplogHealth();

      // Materialising a known-oversized log is how the sidecar gets wedged.
      // Skip the sweep until the user acts; the corrections it refreshes are
      // a convenience, and a responsive app is not.
      if (health?.oversized) {
        this.lastRunAt = Date.now();
        dbg(
          `[sidecar-idle-maintenance] skipping corrections sweep — activity log is `
          + `${formatBytes(health.oplogBytes)} (${health.reasons.join('+')}); awaiting user action`,
        );
        return { action: 'run', detail: 'oplog-oversized' };
      }

      const { compaction } = await this.deps.host.refreshAllCorrectionsFromOplog();
      this.lastRunAt = Date.now();
      if (compaction.compacted) {
        const record = this.deps.host.getLastOplogCompaction();
        broadcastOplogCompacted(this.deps.broadcastRaw, compaction, record?.at ?? Date.now());
        dbg(
          `[sidecar-idle-maintenance] oplog compacted: ${compaction.eventsRemoved?.toLocaleString() ?? '?'} events archived`,
        );
      } else {
        dbg('[sidecar-idle-maintenance] oplog housekeeping complete');
      }
      await this.maybeRunRetentionDryRun(force);
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

  /**
   * DETECT → AUTO-HEAL → ASK, in that order, on the stat-only path.
   *
   * Auto-heal is limited to files that are provably behaviour-neutral to move
   * (see oplog-health.ts). Everything else is a question for the user, asked
   * once and then snoozed — a prompt that reappears every 90 seconds is not a
   * prompt, it is a fault.
   *
   * Public so unlock can run the same pass without waiting out the 5-minute
   * boot deferral: the disk is already full by then.
   */
  async checkOplogHealth(): Promise<OplogHealthReport | null> {
    const cortexDir = this.deps.cortexDir;
    if (!cortexDir) return null;
    try {
      const { currentDeviceId, pinnedDeviceIds } = this.deps.host.getOplogDeviceContext();
      let report = await measureOplogHealth({ cortexDir, currentDeviceId, pinnedDeviceIds });

      // ── AUTO-HEAL ────────────────────────────────────────────────────────
      // Unread-by-construction files. Archived without asking because moving
      // them aside cannot change a single thing the app returns.
      if (report.autoReclaimFiles.length > 0) {
        const result = await archiveOplogFiles(
          cortexDir, report.autoReclaimFiles,
          'automatic: op-log files from devices with no pinned key (skipped unread by every reader)',
          report.files,
        );
        if (result.movedFiles.length > 0) {
          dbg(
            `[sidecar-idle-maintenance] archived ${result.movedFiles.length} unreadable op-log `
            + `file(s), ${formatBytes(result.bytes)} → ${result.archiveName}`,
          );
          this.deps.broadcastRaw?.({
            kind: 'oplog.compacted',
            name: 'oplog.compacted',
            payload: {
              at: Date.now(),
              eventsRemoved: 0,
              bytesBefore: report.oplogBytes,
              bytesAfter: report.oplogBytes - result.bytes,
              archiveName: result.archiveName,
            },
          });
          const state = await readOplogHealthState(cortexDir);
          await writeOplogHealthState(cortexDir, { ...state, lastAutoArchiveAt: Date.now() });
          // Re-measure: the auto pass may have brought it back under threshold,
          // in which case there is nothing to bother the user about.
          report = await measureOplogHealth({ cortexDir, currentDeviceId, pinnedDeviceIds });
        }
      }

      // ── ASK ──────────────────────────────────────────────────────────────
      if (report.oversized) {
        const state = await readOplogHealthState(cortexDir);
        const prompt = describeOplogHealth(report);
        if (prompt && shouldPrompt(state)) {
          this.deps.broadcastRaw?.({
            kind: 'oplog.health',
            name: 'oplog.health',
            payload: {
              at: Date.now(),
              title: prompt.title,
              body: prompt.body,
              actionLabel: prompt.actionLabel,
              bytes: prompt.bytes,
              oplogBytes: report.oplogBytes,
              graphsBytes: report.graphsBytes,
              reasons: report.reasons,
            },
          });
          await writeOplogHealthState(cortexDir, { ...state, lastPromptAt: Date.now() });
        }
      }
      return report;
    } catch (e: unknown) {
      console.error(`[sidecar-idle-maintenance] op-log health check failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async maybeRunRetentionDryRun(force = false): Promise<void> {
    const settings = this.deps.host.getSettings();
    const compliance = settings.compliance;
    if (compliance?.enabled !== true) return;
    const lastAt = compliance.lastRetentionDryRunAt ?? this.lastRetentionDryRunAt;
    if (!force && lastAt > 0 && Date.now() - lastAt < RETENTION_DRY_RUN_INTERVAL_MS) return;
    const cortexDir = this.deps.cortexDir;
    if (!cortexDir) return;
    try {
      const { runRetentionPurge } = await import('./compliance.js');
      const result = await runRetentionPurge(this.deps.host, cortexDir, true);
      await this.deps.host.recordComplianceRetentionDryRun(result.items.length);
      this.lastRetentionDryRunAt = Date.now();
      dbg(`[sidecar-idle-maintenance] compliance retention dry-run: ${result.items.length} candidate(s)`);
    } catch (e: unknown) {
      console.error(`[sidecar-idle-maintenance] retention dry-run failed: ${(e as Error).message}`);
    }
  }
}
