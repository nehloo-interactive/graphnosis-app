/**
 * Serializes ghampus:send turn processing — one turn at a time on the sidecar.
 */

let turnChain: Promise<void> = Promise.resolve();

export function enqueueGhampusSendTurn(work: () => Promise<void>): void {
  turnChain = turnChain.then(work, work);
}

/** Test helper — reset between smoketest phases. */
export function resetGhampusSendQueueForTest(): void {
  turnChain = Promise.resolve();
}
