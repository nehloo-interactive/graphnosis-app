/**
 * Serializes heavy background lanes so boot doesn't run docs re-ingest,
 * brain first scan, Ghampus scans, and idle maintenance all at full tilt.
 *
 * Lanes are cooperative — callers enqueue; only one lane runs at a time when
 * `serializeBackgroundLanes` is enabled (low-impact / low-power tiers).
 */
import type { GraphnosisHost } from './host.js';
import { clientActiveWithin, CLIENT_QUIET_MS, isIngestActive } from './client-activity.js';
import { resolvePerformanceProfile } from './performance-profile.js';

export type BackgroundLane =
  | 'docs-ingest'
  | 'brain-pass'
  | 'ghampus-scan'
  | 'idle-maintenance';

type QueuedTask = {
  lane: BackgroundLane;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
};

const queue: QueuedTask[] = [];
let activeLane: BackgroundLane | null = null;
let draining = false;

export function isBackgroundLaneActive(): boolean {
  return activeLane !== null;
}

export function currentBackgroundLane(): BackgroundLane | null {
  return activeLane;
}

function shouldSerialize(host: GraphnosisHost): boolean {
  return resolvePerformanceProfile(host.getSettings()).serializeBackgroundLanes;
}

/** Run `fn` immediately, or enqueue when serialization is on and another lane is active. */
export function enqueueBackgroundLane(
  host: GraphnosisHost,
  lane: BackgroundLane,
  fn: () => Promise<void>,
): Promise<void> {
  if (!shouldSerialize(host)) {
    return fn();
  }
  return new Promise<void>((resolve, reject) => {
    queue.push({ lane, run: fn, resolve, reject });
    void drainQueue(host);
  });
}

async function drainQueue(host: GraphnosisHost): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      if (isIngestActive() || clientActiveWithin(CLIENT_QUIET_MS)) {
        await new Promise<void>((r) => setTimeout(r, 2_000));
        continue;
      }
      const task = queue.shift();
      if (!task) break;
      activeLane = task.lane;
      try {
        await task.run();
        task.resolve();
      } catch (e) {
        task.reject(e);
      } finally {
        activeLane = null;
        // Brief pause between lanes so IPC can breathe.
        await new Promise<void>((r) => setTimeout(r, 250));
      }
    }
  } finally {
    draining = false;
  }
}

/** Ghampus reminders/tips/proactive defer while ingest, boot emb rebuild, or a heavy lane runs. */
export function shouldDeferGhampusBackground(host: GraphnosisHost): boolean {
  if (isIngestActive()) return true;
  if (host.isBootSweepActive()) return true;
  if (host.isBootEmbBuildActive()) return true;
  if (host.isBootDeferredWorkActive()) return true;
  if (isBackgroundLaneActive()) return true;
  if (clientActiveWithin(CLIENT_QUIET_MS)) return true;
  return false;
}

/** Post-boot docs re-ingest delay from performance tier. */
export function resolveDocsReingestDelayMs(host: GraphnosisHost): number {
  return resolvePerformanceProfile(host.getSettings()).docsReingestDelayMs;
}

/** Scale Ghampus startup timers for low-impact / low-power tiers. */
export function scaleGhampusStartupDelay(host: GraphnosisHost, baseMs: number): number {
  const mult = resolvePerformanceProfile(host.getSettings()).ghampusStartupDelayMultiplier;
  return Math.round(baseMs * mult);
}
