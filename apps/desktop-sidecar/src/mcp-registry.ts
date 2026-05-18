import { randomUUID } from 'node:crypto';

/**
 * In-memory registry of live MCP connections. Used by the App's inspector to
 * show the user which AI clients are currently talking to this sidecar.
 *
 * We track:
 *   - transport kind (`socket` for relay-connected clients, `stdio` for the
 *     legacy direct-spawn path)
 *   - clientInfo from the MCP `initialize` handshake (e.g. Claude Desktop
 *     sends `{ name: "claude-ai", version: "..." }`)
 *   - connection start time, last-activity time
 *
 * The registry is process-local; restarting the sidecar wipes it. That's
 * the right behavior — the App reads it fresh on every poll.
 */

export type McpTransportKind = 'socket' | 'stdio';

export interface McpConnection {
  id: string;
  transport: McpTransportKind;
  connectedAt: number;
  lastActivityAt: number;
  clientName?: string;
  clientVersion?: string;
  /** Total JSON-RPC messages handled on this connection (for liveness). */
  requestCount: number;
}

class McpRegistry {
  private connections = new Map<string, McpConnection>();

  register(transport: McpTransportKind): string {
    const id = randomUUID();
    const now = Date.now();
    this.connections.set(id, {
      id,
      transport,
      connectedAt: now,
      lastActivityAt: now,
      requestCount: 0,
    });
    return id;
  }

  setClientInfo(id: string, name: string, version: string): void {
    const c = this.connections.get(id);
    if (!c) return;
    c.clientName = name;
    c.clientVersion = version;
  }

  touch(id: string): void {
    const c = this.connections.get(id);
    if (!c) return;
    c.lastActivityAt = Date.now();
    c.requestCount += 1;
  }

  unregister(id: string): void {
    this.connections.delete(id);
  }

  list(): McpConnection[] {
    return Array.from(this.connections.values()).sort((a, b) => a.connectedAt - b.connectedAt);
  }

  /**
   * Return the clientName of the most-recently-active connection, or
   * undefined if no connection has a clientName set. Used to attribute
   * MCP-driven source ingests and corrections to the calling client
   * (e.g. "claude-ai" → "via Claude" badge on the Sources list).
   *
   * Single-source-of-truth caveat: when multiple MCP clients are connected
   * simultaneously and one calls `remember` while another is also active,
   * we attribute to whichever has the most recent `touch()` — which in
   * practice will be the caller itself, since touch() runs on every
   * incoming request. Race risk is real but narrow.
   */
  getMostRecentClientName(): string | undefined {
    let best: McpConnection | undefined;
    for (const c of this.connections.values()) {
      if (!c.clientName) continue;
      if (!best || c.lastActivityAt > best.lastActivityAt) best = c;
    }
    return best?.clientName;
  }
}

export const mcpRegistry = new McpRegistry();
