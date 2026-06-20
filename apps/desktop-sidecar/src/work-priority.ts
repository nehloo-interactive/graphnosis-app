/**
 * Sidecar work priority orchestration — single LLM slot with preemption.
 *
 * P0 Active UI (home cards, engram switch) > P1 user recall/MCP > P2 Ghampus
 * classify / proactive dispatch > P3 recall query enrichment (best-effort).
 *
 * Lower numeric priority = higher precedence. P1 entering scope aborts in-flight
 * P2/P3 LLM work. P0 defers *new* P2/P3 slots (isBusyAbove) but does not abort
 * an in-flight Ghampus user query — tab navigation must not kill classify/synth.
 */

import { isGhampusBusy } from './ghampus-busy.js';

export const WorkPriority = {
  P0_UI: 0,
  P1_USER: 1,
  P2_GHAMPUS: 2,
  P3_ENRICHMENT: 3,
} as const;

export type WorkPriority = (typeof WorkPriority)[keyof typeof WorkPriority];

const scopeDepth: number[] = [0, 0, 0, 0];

let llmOwner: WorkPriority | null = null;
let llmAbort: AbortController | null = null;

function preemptLlmBelow(priority: WorkPriority): void {
  if (llmOwner !== null && llmOwner > priority) {
    // P0 home-card bursts defer new Ghampus slots but must not abort an active
    // user chat classify/synthesize pass mid-stream (user switched tabs away).
    if (
      priority === WorkPriority.P0_UI
      && llmOwner === WorkPriority.P2_GHAMPUS
      && isGhampusBusy()
    ) {
      return;
    }
    llmAbort?.abort(new DOMException('preempted by higher priority work', 'AbortError'));
    llmOwner = null;
    llmAbort = null;
  }
}

/** Enter a scoped burst of work at `priority`. Returns an end function. */
export function beginScope(priority: WorkPriority): () => void {
  setScopeActive(priority, true);
  return () => setScopeActive(priority, false);
}

/** Increment/decrement scope depth — used by IPC ui:workScope paired active flags. */
export function setScopeActive(priority: WorkPriority, active: boolean): void {
  const depth = scopeDepth[priority] ?? 0;
  if (active) {
    scopeDepth[priority] = depth + 1;
    preemptLlmBelow(priority);
  } else {
    scopeDepth[priority] = Math.max(0, depth - 1);
  }
}

/** True when any higher-priority (lower number) scope is active. */
export function isBusyAbove(priority: WorkPriority): boolean {
  for (let p = 0; p < priority; p++) {
    if (scopeDepth[p]! > 0) return true;
  }
  return false;
}

/** Whether recall query enrichment should skip immediately (raw query, no wait). */
export function shouldSkipRecallEnrichment(recallPriority: WorkPriority): boolean {
  if (recallPriority <= WorkPriority.P1_USER) {
    // User/MCP recall: only P0 UI bursts block enrichment.
    return isBusyAbove(WorkPriority.P1_USER);
  }
  // Background recall: defer while P0–P2 active.
  return isBusyAbove(WorkPriority.P3_ENRICHMENT);
}

/**
 * Try to acquire the single background LLM slot for `priority`.
 * Returns null when higher-priority work owns the slot or is queued — callers
 * must skip/degrade, never wait (UX-first orchestration).
 */
export function tryAcquireLlmSlot(
  priority: WorkPriority,
): { signal: AbortSignal; release: () => void } | null {
  if (llmOwner !== null && llmOwner < priority) return null;
  preemptLlmBelow(priority);
  if (llmOwner !== null) return null;

  const controller = new AbortController();
  llmOwner = priority;
  llmAbort = controller;
  return {
    signal: controller.signal,
    release: () => {
      if (llmOwner === priority && llmAbort === controller) {
        llmOwner = null;
        llmAbort = null;
      }
    },
  };
}

/** Resolve enrichment / Ghampus LLM slot priority from recall context. */
export function enrichmentLlmPriority(recallPriority: WorkPriority): WorkPriority {
  return recallPriority <= WorkPriority.P1_USER ? WorkPriority.P1_USER : WorkPriority.P3_ENRICHMENT;
}

/** Test helper — reset counters between smoketest phases. */
export function resetWorkPriorityForTest(): void {
  scopeDepth.fill(0);
  llmOwner = null;
  llmAbort = null;
}
