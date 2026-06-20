// Tracks when a real client (an AI MCP tool call, or a user-initiated desktop
// IPC request) last touched the sidecar. The heavy background brain passes
// (duplicate scan, edge prediction) check this and DEFER while a client is
// active, so AI recalls and the UI always win the single-threaded event loop —
// the sidecar can otherwise peg the CPU on housekeeping and time out MCP/UI
// requests (a memory tool that goes unresponsive defeats the whole purpose).
//
// IMPORTANT: the desktop app's recurring reconciliation polls must NOT count as
// activity, or background work would never get to run. dispatch() filters those
// via BACKGROUND_POLL_METHODS below.

let lastClientActivityAt = 0;

/** Record that a client just made a request. */
export function markClientActivity(): void {
  lastClientActivityAt = Date.now();
}

/** True if a client was active within the last `ms` milliseconds. */
export function clientActiveWithin(ms: number): boolean {
  return Date.now() - lastClientActivityAt < ms;
}

/** Desktop-app reconciliation / status polls — frequent and NOT user intent, so
 *  they don't mark activity (else the ~3s poll cadence would starve background
 *  work permanently). */
export const BACKGROUND_POLL_METHODS = new Set<string>([
  'stats.summary',
  'mcp.status',
  'corrections.list',
  'llm:status',
  'embedding:status',
  'license:status',
  'brain:getVitality',
  'consent.listPendingPrompts',
  'skill:listPendingProposals',
]);

/** How long after a client request to treat the sidecar as "busy serving
 *  clients" — heavy background passes defer within this window. */
export const CLIENT_QUIET_MS = 8_000;

const ingestIdleListeners: Array<() => void> = [];
let clientIdleTimer: NodeJS.Timeout | null = null;
const clientIdleListeners: Array<() => void> = [];

function emitIngestIdle(): void {
  if (ingestTotal > 0) return;
  const listeners = ingestIdleListeners.splice(0);
  for (const cb of listeners) {
    try { cb(); } catch { /* listener must not abort the chain */ }
  }
}

function scheduleClientIdleCheck(): void {
  if (clientIdleListeners.length === 0) return;
  if (clientIdleTimer) return;
  clientIdleTimer = setTimeout(() => {
    clientIdleTimer = null;
    if (clientActiveWithin(CLIENT_QUIET_MS)) {
      scheduleClientIdleCheck();
      return;
    }
    const listeners = clientIdleListeners.splice(0);
    for (const cb of listeners) {
      try { cb(); } catch { /* listener must not abort the chain */ }
    }
  }, CLIENT_QUIET_MS);
  clientIdleTimer.unref();
}

/** One-shot: fires when no ingest is in flight (immediately if already idle). */
export function onIngestIdle(cb: () => void): () => void {
  if (!isIngestActive()) {
    queueMicrotask(cb);
    return () => {};
  }
  ingestIdleListeners.push(cb);
  return () => {
    const i = ingestIdleListeners.indexOf(cb);
    if (i >= 0) ingestIdleListeners.splice(i, 1);
  };
}

/** One-shot: fires once the client has been quiet for CLIENT_QUIET_MS. */
export function onClientIdle(cb: () => void): () => void {
  if (!clientActiveWithin(CLIENT_QUIET_MS)) {
    queueMicrotask(cb);
    return () => {};
  }
  clientIdleListeners.push(cb);
  scheduleClientIdleCheck();
  return () => {
    const i = clientIdleListeners.indexOf(cb);
    if (i >= 0) clientIdleListeners.splice(i, 1);
  };
}

/** Called after a non-background IPC/MCP request completes — arms client-idle waiters. */
export function notifyClientRequestComplete(isBackground: boolean): void {
  if (isBackground) return;
  scheduleClientIdleCheck();
}

// ── Ingest gate ─────────────────────────────────────────────────────────────
// ANY active ingest (connector pull, drag-drop file, MCP ingest_batch) hammers
// the single thread + the embed workers. If ANY background pass — autonomous
// brain (duplicate scan, consolidation, cross-engram, synapse, insight, temporal
// decay, goals, reinforcement), the GNN (neural-network edge prediction), or the
// GLL overlay — runs concurrently, it competes for the one thread and starves
// the ingest's embed IPC → the ingest crawls and the UI/MCP times out ("lost
// connection"). So ALL background work stands down while ANY ingest is in flight
// and the periodic timers re-run it once the cortex goes cool. This is an
// explicit count (not the timing-fragile clientActiveWithin heartbeat), kept per
// engram so we know WHICH engrams are hot, plus a total for the global gate.
const ingestCountByGraph = new Map<string, number>();
let ingestTotal = 0;
export function beginIngest(graphId?: string): void {
  ingestTotal++;
  if (graphId) ingestCountByGraph.set(graphId, (ingestCountByGraph.get(graphId) ?? 0) + 1);
}
export function endIngest(graphId?: string): void {
  if (ingestTotal > 0) ingestTotal--;
  if (graphId) {
    const n = (ingestCountByGraph.get(graphId) ?? 0) - 1;
    if (n > 0) ingestCountByGraph.set(graphId, n); else ingestCountByGraph.delete(graphId);
  }
  if (ingestTotal === 0) emitIngestIdle();
}
/** True while ONE OR MORE engrams are actively ingesting — every background pass
 *  defers on this (single thread: any concurrent work slows the ingest). */
export function isIngestActive(): boolean { return ingestTotal > 0; }
/** True while THIS engram is actively ingesting — for per-engram pass skips. */
export function isGraphIngesting(graphId: string): boolean { return (ingestCountByGraph.get(graphId) ?? 0) > 0; }
