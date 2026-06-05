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
