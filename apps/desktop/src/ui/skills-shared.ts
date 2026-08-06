/**
 * Skills-shared — helpers shared between the Skills library page (skills.ts)
 * and the Agents/Agempi roster (agents.ts). Extracted (feature #41) so the two
 * surfaces never fork the Agempus dial / vitality-grade / dispatch-safe readout
 * logic. NO behavior change to the Skills page — these are the exact same
 * helpers, just lifted into one module both pages import.
 */
import { app } from './app-context';
import { ipcCall } from './ipc';
import { escape } from './util';
import type { GraphWithMetadata } from './types';

function getLoadedGraphs(): GraphWithMetadata[] {
  return app().getLoadedGraphs();
}

// ── Autonomy levels ──────────────────────────────────────────────────────────
export type AutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type DispatchSafety = 'yes' | 'partial' | 'no';

// Each skill-template engram is an Agempus — a domain agent. Its per-engram
// family-default autonomy dial. L3 ("autonomous") drives the unattended
// executor (opt-in, OFF by default; toggle + run review live in the Unattended
// tab). It only ever auto-runs skills that clear their authored dispatch-safe
// cap plus the executor's live gates, so the segment is selectable but bounded.
export const AGEMPUS_LEVELS: ReadonlyArray<{ level: AutonomyLevel; label: string; title: string; locked?: boolean }> = [
  // Named rather than numbered. L0–L3 told the user the ORDER but never the
  // meaning, so the tooltip was doing all the work and the control read as a
  // volume knob. The names say what actually happens; the tooltip stays as the
  // detail. Level ids are untouched — they are persisted in engram metadata and
  // compared across the sidecar, so only the labels change.
  //
  // L3 is "Unattended", not "Autonomous", for two reasons: the product already
  // calls that surface the Unattended tab, so the name points at where the runs
  // are reviewed; and "Autonomous" would collide with the "Autonomy" heading
  // directly above the dial.
  { level: 'L0', label: 'Handheld', title: 'Handheld — never surfaces a card. You run this skill yourself, every time.' },
  { level: 'L1', label: 'Guided', title: 'Guided — surfaces a propose-card for you to accept or dismiss (default).' },
  { level: 'L2', label: "Tell'n'Go", title: "Tell'n'Go — surfaces a card flagged preview-then-run: you see the plan, then it runs." },
  { level: 'L3', label: 'Unattended', title: 'Unattended — auto-runs eligible skills with no human in the loop. Opt-in and OFF by default; enable it and review every run in the Unattended tab. Always capped by each skill\'s authored dispatch-safe.' },
];

// Default level shown when an engram has no per-engram override. Mirrors core
// DEFAULT_EXECUTION_AUTONOMY_LEVEL ('L1').
const AGEMPUS_DEFAULT_LEVEL: 'L1' = 'L1';

export function currentAgempusLevel(graphId: string): AutonomyLevel {
  const g = getLoadedGraphs().find((x) => x.graphId === graphId);
  const lvl = g?.metadata.executionAutonomyLevel;
  return lvl === 'L0' || lvl === 'L1' || lvl === 'L2' || lvl === 'L3' ? lvl : AGEMPUS_DEFAULT_LEVEL;
}

/** Render the read-only Agempus family-default dial. The active segment
 *  reflects the per-engram override or the documented default. L3 is selectable
 *  (drives the opt-in unattended executor).
 *  (In the Skills page the dial is interactive via delegated click handlers
 *  keyed off `data-agempus-engram` + `data-agempus-level`; in the Agents page
 *  it is presented read-only.) */
export function renderAgempusDial(graphId: string): string {
  const active = currentAgempusLevel(graphId);
  const segs = AGEMPUS_LEVELS.map((s) => {
    const isActive = s.level === active && !s.locked;
    const cls = `agempus-dial-seg${isActive ? ' active' : ''}`;
    const disabled = s.locked ? ' disabled' : '';
    const title = s.locked ? `${s.title}` : s.title;
    return `<button class="${cls}"${disabled} data-agempus-level="${s.level}" title="${escape(title)}">${escape(s.label)}</button>`;
  }).join('');
  return `<div class="agempus-dial" data-agempus-engram="${escape(graphId)}">
    <span class="agempus-dial-label" title="The autonomy every skill in this Agempus inherits, unless you set a per-skill override below. Always capped by each skill's authored dispatch-safe:. Unattended auto-runs eligible skills with no human — it is opt-in and OFF by default; enable it and review every run in the Unattended tab.">Autonomy</span>
    <span class="agempus-dial-track">${segs}</span>
  </div>`;
}

// ── Vitality grade ───────────────────────────────────────────────────────────
export function vitalityGrade(score: number): 'a' | 'b' | 'c' | 'd' {
  if (score >= 85) return 'a';
  if (score >= 65) return 'b';
  if (score >= 40) return 'c';
  return 'd';
}

// ── Dispatch-safe readout ────────────────────────────────────────────────────
//
// The dispatchSafeReadout IPC returns, per engram, one entry per skill carrying
// its authored cap, the user's raw override (configuredSkillLevel, null =
// inheriting), and the EFFECTIVE (capped, resolved) level the dispatcher honors.
export interface PerSkillDispatchSafe {
  sourceId: string;
  label: string;
  dispatchSafe: DispatchSafety;
  cap: AutonomyLevel;
  configuredSkillLevel: AutonomyLevel | null;
  effectiveLevel: AutonomyLevel;
}

export interface DispatchSafeReadout {
  graphId: string;
  configuredLevel: AutonomyLevel;
  dispatchSafeCap: AutonomyLevel;
  effectiveLevel: AutonomyLevel;
  perSkill: PerSkillDispatchSafe[];
}

export function levelRankUi(level: AutonomyLevel): number {
  return level === 'L0' ? 0 : level === 'L1' ? 1 : level === 'L2' ? 2 : 3;
}

// graphId → readout. Shared cache across both pages so an expanded Skills group
// and the Agents roster never double-fetch the same engram's readout.
export const skillsDispatchReadoutCache = new Map<string, DispatchSafeReadout>();
// In-flight fetches keyed by graphId — coalesces concurrent requests.
const skillsDispatchReadoutFetching = new Map<string, Promise<DispatchSafeReadout | null>>();

/** Look up one skill's per-skill readout entry from the engram cache. */
export function perSkillReadout(graphId: string, sourceId: string): PerSkillDispatchSafe | undefined {
  return skillsDispatchReadoutCache.get(graphId)?.perSkill.find((p) => p.sourceId === sourceId);
}

/** Fetch (and cache) one engram's dispatch-safe readout. Coalesces concurrent
 *  callers. Returns null on failure (callers render the inherit fallback). */
export async function fetchDispatchReadout(graphId: string): Promise<DispatchSafeReadout | null> {
  const existing = skillsDispatchReadoutFetching.get(graphId);
  if (existing) return existing;
  const p = (async (): Promise<DispatchSafeReadout | null> => {
    try {
      const res = await ipcCall<{ ok: boolean; readout: DispatchSafeReadout | null }>(
        'graphs.dispatchSafeReadout',
        { graphId },
      );
      const readout = res?.readout ?? null;
      if (readout) skillsDispatchReadoutCache.set(graphId, readout);
      return readout;
    } catch (e) {
      console.warn('[skills-shared] dispatchSafeReadout failed for', graphId, e);
      return null;
    } finally {
      skillsDispatchReadoutFetching.delete(graphId);
    }
  })();
  skillsDispatchReadoutFetching.set(graphId, p);
  return p;
}

/** Batched all-engrams dispatch-safe readout — one IPC call populates the cache
 *  for every engram. Used by the Agents roster mount so it never fans out N
 *  per-engram calls. Returns the count cached (0 on failure). */
export async function fetchAllDispatchReadouts(): Promise<number> {
  try {
    const res = await ipcCall<{ ok: boolean; readouts?: DispatchSafeReadout[] }>(
      'graphs.dispatchSafeReadout',
      {},
    );
    const readouts = res?.readouts ?? [];
    for (const r of readouts) {
      if (r && r.graphId) skillsDispatchReadoutCache.set(r.graphId, r);
    }
    return readouts.length;
  } catch (e) {
    console.warn('[skills-shared] batched dispatchSafeReadout failed', e);
    return 0;
  }
}
