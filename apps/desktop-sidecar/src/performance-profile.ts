/**
 * Machine + settings-aware performance profile for sidecar background work.
 *
 * Tiers (Settings → Performance):
 *   - Normal      — default throughput.
 *   - Low impact  — spread boot tasks, fewer embed workers, yields between chunks.
 *   - Low power   — brain.lowPowerMode (brain passes stand down entirely).
 */
import os from 'node:os';
import type { AppSettings } from '@graphnosis-app/core/settings';

export const MAX_EMBED_WORKERS = 4;

export type PerformanceTier = 'normal' | 'low-impact' | 'low-power';

export interface PerformanceProfile {
  tier: PerformanceTier;
  /** Hard cap on embed worker processes for this tier. */
  maxEmbedWorkers: number;
  /** Ms to wait after unlock before post-boot docs re-ingest. */
  docsReingestDelayMs: number;
  /** Multiplier applied to Ghampus startup delays (reminders, tips, proactive). */
  ghampusStartupDelayMultiplier: number;
  /** Sleep after each background-lane embed chunk (0 = none). */
  embedChunkYieldMs: number;
  /** Extra yield every N duplicate-scan pair comparisons in low-impact. */
  duplicateScanYieldEvery: number;
  /** When true, heavy background lanes run one at a time via the scheduler. */
  serializeBackgroundLanes: boolean;
  /** Brain autonomous passes stand down (low-power only). */
  brainPaused: boolean;
}

function totalRamGb(): number {
  return os.totalmem() / (1024 ** 3);
}

function isAppleSilicon(): boolean {
  if (process.platform !== 'darwin') return false;
  if (process.arch === 'arm64') return true;
  const model = os.cpus()[0]?.model ?? '';
  return /Apple/i.test(model);
}

/** Conservative default when settings.ai.embedWorkers is unset. */
export function resolveDefaultEmbedWorkers(): number {
  const ramGb = totalRamGb();
  const apple = isAppleSilicon();
  if (ramGb < 16 || (apple && ramGb < 24)) return 1;
  if (ramGb < 32 || apple) return 2;
  return 2;
}

export function resolvePerformanceTier(settings: AppSettings): PerformanceTier {
  if (settings.brain?.lowPowerMode === true) return 'low-power';
  if (settings.brain?.backgroundActivity === 'low-impact') return 'low-impact';
  return 'normal';
}

export function resolvePerformanceProfile(settings: AppSettings): PerformanceProfile {
  const tier = resolvePerformanceTier(settings);
  switch (tier) {
    case 'low-power':
      return {
        tier,
        maxEmbedWorkers: 1,
        docsReingestDelayMs: 5 * 60_000,
        ghampusStartupDelayMultiplier: 2,
        embedChunkYieldMs: 8,
        duplicateScanYieldEvery: 512,
        serializeBackgroundLanes: true,
        brainPaused: true,
      };
    case 'low-impact':
      return {
        tier,
        maxEmbedWorkers: 2,
        docsReingestDelayMs: 3 * 60_000,
        ghampusStartupDelayMultiplier: 1.5,
        embedChunkYieldMs: 4,
        duplicateScanYieldEvery: 1024,
        serializeBackgroundLanes: true,
        brainPaused: false,
      };
    default:
      return {
        tier: 'normal',
        maxEmbedWorkers: MAX_EMBED_WORKERS,
        docsReingestDelayMs: 90_000,
        ghampusStartupDelayMultiplier: 1,
        embedChunkYieldMs: 0,
        duplicateScanYieldEvery: 2048,
        serializeBackgroundLanes: false,
        brainPaused: false,
      };
  }
}

/** Effective worker count: user setting, env override, profile cap, hard max. */
export function resolveEffectiveEmbedWorkers(
  settings: AppSettings,
  envOverride?: number,
): number {
  const profile = resolvePerformanceProfile(settings);
  const fromSettings = settings.ai.embedWorkers;
  const base = typeof fromSettings === 'number' && fromSettings >= 1
    ? fromSettings
    : (typeof envOverride === 'number' && envOverride >= 1
      ? envOverride
      : resolveDefaultEmbedWorkers());
  return Math.max(1, Math.min(profile.maxEmbedWorkers, MAX_EMBED_WORKERS, Math.round(base)));
}

/** Wrap a background embed fn with optional yield (low-impact / low-power). */
export function wrapEmbedWithYield(
  embedFn: (text: string) => Promise<number[]>,
  getYieldMs: () => number,
): (text: string) => Promise<number[]> {
  return async (text: string) => {
    const vec = await embedFn(text);
    const ms = getYieldMs();
    if (ms > 0) {
      await new Promise<void>((r) => setTimeout(r, ms));
    }
    return vec;
  };
}
