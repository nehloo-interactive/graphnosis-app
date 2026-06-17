// Savings tracker — measures the dollar value Graphnosis delivers vs the
// counterfactual world where the same work happened on a baseline paid
// model with no local memory layer.
//
// Two distinct savings sources we account for:
//
//   1. Recall-instead-of-LLM.  When Ghampus answers a question entirely
//      from `recall` without firing any LLM call, the counterfactual
//      cost is "what would it have cost to send that 2000-token context
//      to Claude Sonnet to compute the same answer?" Recorded as
//      `kind: 'recall-only'`.
//
//   2. Routing-savings.  When the router picks a cheaper model that
//      satisfied the step over a more expensive baseline, the delta
//      is recorded as `kind: 'routing'`.
//
// Storage: append-only JSONL at `<cortex>/savings-log.jsonl`. Encrypted
// at rest with the cortex. The aggregate panel in Ghampus and Settings
// reads tail-of-file and rolls up by week/month.

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** A single savings event recorded after a turn or skill walk. */
export interface SavingsEntry {
  /** Unix ms when the event was recorded. */
  recordedAt: number;
  /** Why this counted as savings. */
  kind: 'recall-only' | 'routing' | 'walk';
  /** Optional context — which tool / skill / conversation triggered it. */
  source?: string;
  /** What we would have paid in the counterfactual world. */
  baselineUsd: number;
  /** What we actually paid (or amortised out of pool). */
  actualUsd: number;
  /** baseline − actual. */
  savedUsd: number;
  /** Optional free-text description for the audit log. */
  note?: string;
}

const SAVINGS_FILE = 'savings-log.jsonl';

/**
 * Default "what we would have paid" baseline — Claude Sonnet 4 per-token
 * rates at typical prompt sizes. Overridable per-cortex via
 * `settings.models.savingsBaseline`. Conservative pick: Sonnet is
 * neither the cheapest paid model nor the most expensive, so the
 * resulting savings number doesn't oversell or undersell.
 */
export const DEFAULT_BASELINE = {
  modelDisplayName: 'Claude Sonnet 4.6 baseline',
  inputUsdPer1M: 3.00,
  outputUsdPer1M: 15.00,
};

export function computeBaselineCostUsd(
  inputTokens: number,
  outputTokens: number,
  baseline = DEFAULT_BASELINE,
): number {
  return (inputTokens / 1_000_000) * baseline.inputUsdPer1M
    + (outputTokens / 1_000_000) * baseline.outputUsdPer1M;
}

/**
 * Record a `recall-only` event — the user got their answer via
 * Graphnosis recall without firing any LLM call. Baseline assumes the
 * same context size would have been sent to the baseline model.
 */
export async function recordRecallOnlySavings(
  cortexDir: string,
  args: { inputTokensSaved: number; outputTokensSaved: number; source?: string },
): Promise<void> {
  const baselineUsd = computeBaselineCostUsd(args.inputTokensSaved, args.outputTokensSaved);
  await appendSavings(cortexDir, {
    recordedAt: Date.now(),
    kind: 'recall-only',
    baselineUsd,
    actualUsd: 0,
    savedUsd: baselineUsd,
    ...(args.source !== undefined ? { source: args.source } : {}),
    note: 'Graphnosis recall answered without an LLM call',
  });
}

/**
 * Record a routing-savings event — the router picked a cheaper model
 * than the baseline. Use this after each model call inside a walk.
 */
export async function recordRoutingSavings(
  cortexDir: string,
  args: {
    actualUsd: number;
    inputTokens: number;
    outputTokens: number;
    pickedModelDisplayName: string;
    source?: string;
  },
): Promise<void> {
  const baselineUsd = computeBaselineCostUsd(args.inputTokens, args.outputTokens);
  const savedUsd = Math.max(0, baselineUsd - args.actualUsd);
  await appendSavings(cortexDir, {
    recordedAt: Date.now(),
    kind: 'routing',
    baselineUsd,
    actualUsd: args.actualUsd,
    savedUsd,
    ...(args.source !== undefined ? { source: args.source } : {}),
    note: `routed to ${args.pickedModelDisplayName} vs baseline`,
  });
}

async function appendSavings(cortexDir: string, entry: SavingsEntry): Promise<void> {
  await fs.appendFile(path.join(cortexDir, SAVINGS_FILE), JSON.stringify(entry) + '\n', 'utf8');
}

export interface SavingsSummary {
  /** Window the summary covers. */
  windowDays: number;
  totalEvents: number;
  /** Sum of `savedUsd` across the window. */
  totalSavedUsd: number;
  /** Sum of `baselineUsd` — counterfactual total. */
  totalBaselineUsd: number;
  /** Sum of `actualUsd` — what we really paid. */
  totalActualUsd: number;
  /** Per-kind breakdown. */
  byKind: {
    'recall-only': { events: number; savedUsd: number };
    routing: { events: number; savedUsd: number };
    walk: { events: number; savedUsd: number };
  };
  /** Per-week buckets, newest first. Each entry covers a 7-day window
   *  starting at `weekStartMs`. UIs render these as a sparkline / bar chart. */
  weekly: Array<{
    weekStartMs: number;
    eventCount: number;
    savedUsd: number;
  }>;
  /**
   * Plain-language report line the UI can show on the Ghampus tab.
   * Picks the right tense + plural form. Conservative: zero events
   * gets a "we'll start tracking" message rather than "$0 saved" which
   * reads like a failure.
   */
  reportLine: string;
}

/**
 * Read the savings log + aggregate. Default window is 30 days. Cheap on
 * normal cortex sizes (one append-only JSONL file); for huge cortexes a
 * future optimisation could maintain a rolling aggregate in settings.
 */
export async function summariseSavings(
  cortexDir: string,
  windowDays = 30,
): Promise<SavingsSummary> {
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(cortexDir, SAVINGS_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return emptySummary(windowDays);
    }
    throw err;
  }
  const entries: SavingsEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as SavingsEntry;
      if (e.recordedAt < sinceMs) continue;
      entries.push(e);
    } catch { /* tolerate torn tails */ }
  }
  if (entries.length === 0) return emptySummary(windowDays);

  let totalSavedUsd = 0;
  let totalBaselineUsd = 0;
  let totalActualUsd = 0;
  const byKind = {
    'recall-only': { events: 0, savedUsd: 0 },
    routing: { events: 0, savedUsd: 0 },
    walk: { events: 0, savedUsd: 0 },
  };
  for (const e of entries) {
    totalSavedUsd += e.savedUsd;
    totalBaselineUsd += e.baselineUsd;
    totalActualUsd += e.actualUsd;
    byKind[e.kind].events += 1;
    byKind[e.kind].savedUsd += e.savedUsd;
  }

  const weekly = bucketByWeek(entries);

  return {
    windowDays,
    totalEvents: entries.length,
    totalSavedUsd,
    totalBaselineUsd,
    totalActualUsd,
    byKind,
    weekly,
    reportLine: buildReportLine(totalSavedUsd, entries.length, windowDays),
  };
}

function emptySummary(windowDays: number): SavingsSummary {
  return {
    windowDays,
    totalEvents: 0,
    totalSavedUsd: 0,
    totalBaselineUsd: 0,
    totalActualUsd: 0,
    byKind: {
      'recall-only': { events: 0, savedUsd: 0 },
      routing: { events: 0, savedUsd: 0 },
      walk: { events: 0, savedUsd: 0 },
    },
    weekly: [],
    reportLine: 'Once you start using Ghampus, I\'ll track what your memory layer saves you vs sending every prompt to a paid model.',
  };
}

function bucketByWeek(entries: SavingsEntry[]): SavingsSummary['weekly'] {
  if (entries.length === 0) return [];
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  const buckets = new Map<number, { eventCount: number; savedUsd: number }>();
  for (const e of entries) {
    const weekStart = Math.floor(e.recordedAt / oneWeekMs) * oneWeekMs;
    const bucket = buckets.get(weekStart) ?? { eventCount: 0, savedUsd: 0 };
    bucket.eventCount += 1;
    bucket.savedUsd += e.savedUsd;
    buckets.set(weekStart, bucket);
  }
  return Array.from(buckets.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([weekStartMs, agg]) => ({ weekStartMs, ...agg }));
}

function buildReportLine(savedUsd: number, events: number, windowDays: number): string {
  if (events === 0) {
    return 'Once you start using Ghampus, I\'ll track what your memory layer saves you vs sending every prompt to a paid model.';
  }
  const win = windowDays === 30 ? 'this month' : `over the last ${windowDays} days`;
  if (savedUsd < 0.01) {
    return `Tracked ${events} event${events === 1 ? '' : 's'} ${win}. Savings rounding to under a cent — local routing + recall paid off the cost difference.`;
  }
  return `You've saved ≈ $${savedUsd.toFixed(2)} ${win} across ${events} event${events === 1 ? '' : 's'} vs sending the same prompts to a baseline paid model.`;
}
