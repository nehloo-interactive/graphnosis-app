/**
 * Sidecar-side Ghampus activity gate — skill maintenance and other idle-only
 * work defer while Ghampus IPC handlers or the UI report busy.
 */

let ipcDepth = 0;
let uiBusy = false;

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

/** Test helper — reset counters between smoketest phases. */
export function resetGhampusBusyForTest(): void {
  ipcDepth = 0;
  uiBusy = false;
}
