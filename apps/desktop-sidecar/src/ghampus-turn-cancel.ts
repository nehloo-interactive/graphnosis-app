/**
 * Per-turn abort for in-flight ghampus:send — user Stop / new send preempts prior turn.
 */

let activeTurn: { turnId: string; abort: AbortController } | null = null;

export function registerGhampusTurn(turnId: string): AbortSignal {
  activeTurn?.abort.abort(new DOMException('superseded by new turn', 'AbortError'));
  const abort = new AbortController();
  activeTurn = { turnId, abort };
  return abort.signal;
}

export function cancelGhampusTurn(turnId?: string): boolean {
  if (!activeTurn) return false;
  if (turnId && activeTurn.turnId !== turnId) return false;
  activeTurn.abort.abort(new DOMException('cancelled by user', 'AbortError'));
  return true;
}

export function clearGhampusTurn(turnId: string): void {
  if (activeTurn?.turnId === turnId) activeTurn = null;
}

export function isGhampusTurnCancelled(turnId: string, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return activeTurn?.turnId === turnId && activeTurn.abort.signal.aborted;
}

/** Test helper — reset between smoketest phases. */
export function resetGhampusTurnCancelForTest(): void {
  activeTurn = null;
}
