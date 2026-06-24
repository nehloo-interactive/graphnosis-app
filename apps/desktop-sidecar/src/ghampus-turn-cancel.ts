/**
 * Per-turn abort for in-flight ghampus:send — explicit Stop cancels one turn.
 * New sends no longer preempt prior turns; ghampus-send-queue serializes them.
 */

const activeTurns = new Map<string, AbortController>();
let latestTurnId: string | null = null;

export function registerGhampusTurn(turnId: string): AbortSignal {
  const abort = new AbortController();
  activeTurns.set(turnId, abort);
  latestTurnId = turnId;
  return abort.signal;
}

export function cancelGhampusTurn(turnId?: string): boolean {
  const id = turnId ?? latestTurnId;
  if (!id) return false;
  const ctrl = activeTurns.get(id);
  if (!ctrl) return false;
  ctrl.abort(new DOMException('cancelled by user', 'AbortError'));
  return true;
}

export function clearGhampusTurn(turnId: string): void {
  activeTurns.delete(turnId);
  if (latestTurnId === turnId) {
    latestTurnId = activeTurns.size > 0
      ? [...activeTurns.keys()].at(-1) ?? null
      : null;
  }
}

export function isGhampusTurnCancelled(turnId: string, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return activeTurns.get(turnId)?.signal.aborted ?? false;
}

/** Test helper — reset between smoketest phases. */
export function resetGhampusTurnCancelForTest(): void {
  activeTurns.clear();
  latestTurnId = null;
}
