/**
 * Sidecar-side Ghampus activity gate — skill maintenance and other idle-only
 * work defer while Ghampus IPC handlers or the UI report busy.
 */

/** Soft idle while user is in an active chat session — nudges may surface. */
export const GHAMPUS_CHAT_SOFT_IDLE_MS = 2 * 60_000;

let ipcDepth = 0;
let uiBusy = false;
let lastUserMessageAt = 0;

export function incrementGhampusBusy(): void {
  ipcDepth++;
}

export function decrementGhampusBusy(): void {
  ipcDepth = Math.max(0, ipcDepth - 1);
}

export function setGhampusUiBusy(busy: boolean): void {
  uiBusy = busy;
}

export function isGhampusBusy(): boolean {
  return ipcDepth > 0 || uiBusy;
}

/** Record user send — proactive tips defer while chat is active. */
export function markGhampusUserActivity(): void {
  lastUserMessageAt = Date.now();
}

/** Ms since last Ghampus user message (0 if never). */
export function ghampusUserIdleMs(now = Date.now()): number {
  if (lastUserMessageAt <= 0) return Number.POSITIVE_INFINITY;
  return now - lastUserMessageAt;
}

/** True when the user has been quiet long enough for in-chat nudges. */
export function ghampusChatSoftIdle(now = Date.now()): boolean {
  return ghampusUserIdleMs(now) >= GHAMPUS_CHAT_SOFT_IDLE_MS;
}

/** Test helper — reset counters between smoketest phases. */
export function resetGhampusBusyForTest(): void {
  ipcDepth = 0;
  uiBusy = false;
  lastUserMessageAt = 0;
}
