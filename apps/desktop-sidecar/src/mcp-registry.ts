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

export type McpTransportKind = 'socket' | 'stdio' | 'http';

export interface McpConnection {
  id: string;
  transport: McpTransportKind;
  connectedAt: number;
  lastActivityAt: number;
  clientName?: string;
  clientVersion?: string;
  /** Total JSON-RPC messages handled on this connection (for liveness). */
  requestCount: number;
  /** Cumulative tokens served to this connection across all read calls. */
  sessionTokensServed: number;
  /** Cumulative nodes served to this connection across all read calls. */
  sessionNodesServed: number;
  /** Number of distinct engrams accessed this session (enumeration signal). */
  uniqueEngramsAccessed: number;
}

class McpRegistry {
  private connections = new Map<string, McpConnection>();
  /** Tracks distinct engram IDs accessed per connection for breadth detection. */
  private engramSets = new Map<string, Set<string>>();
  /**
   * Per-connection close handler. Set by the transport (socket / http /
   * stdio) at register time so `kick()` and the idle sweep can disconnect
   * a specific connection. The relay's auto-reconnect picks it back up on
   * the next request, so closing is non-destructive — the AI client
   * sees a brief blip at most, no UI interaction required.
   */
  private kickers = new Map<string, () => void>();

  register(transport: McpTransportKind, kicker?: () => void): string {
    const id = randomUUID();
    const now = Date.now();
    this.connections.set(id, {
      id,
      transport,
      connectedAt: now,
      lastActivityAt: now,
      requestCount: 0,
      sessionTokensServed: 0,
      sessionNodesServed: 0,
      uniqueEngramsAccessed: 0,
    });
    this.engramSets.set(id, new Set());
    if (kicker) this.kickers.set(id, kicker);
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
    this.engramSets.delete(id);
    this.kickers.delete(id);
  }

  /**
   * Close a specific connection's transport. Returns true if a kicker was
   * registered, false if the connection is unknown / kicker-less (e.g.
   * stdio path which doesn't expose one). The actual `unregister` is
   * triggered by the transport's own `close` event, not by us — so this
   * is idempotent and safe to call multiple times.
   */
  kick(id: string): boolean {
    const fn = this.kickers.get(id);
    if (!fn) return false;
    try { fn(); } catch { /* socket already gone — fine */ }
    return true;
  }

  /**
   * Sweep idle connections. Force-closes any whose `lastActivityAt` is
   * older than `idleMs`. Returns the list of closed connection IDs.
   * Called from a periodic timer in main.ts to clean up zombie
   * connections left over from AI clients that didn't terminate their
   * relay subprocess on disconnect (notably Claude Desktop after the
   * user removes the connector — the relay survives until Claude
   * restarts, so the sidecar's "live connections" panel showed stale
   * entries indefinitely without this sweep).
   */
  sweepIdle(idleMs: number): string[] {
    const cutoff = Date.now() - idleMs;
    const closed: string[] = [];
    for (const c of this.connections.values()) {
      if (c.lastActivityAt < cutoff && this.kickers.has(c.id)) {
        this.kick(c.id);
        closed.push(c.id);
      }
    }
    return closed;
  }

  list(): McpConnection[] {
    return Array.from(this.connections.values()).sort((a, b) => a.connectedAt - b.connectedAt);
  }

  /**
   * Return the ID of the most-recently-active connection. Used by the
   * session budget enforcer to attribute data served to the calling client
   * without threading a connId through every tool handler.
   */
  getMostRecentActiveId(): string | undefined {
    let best: McpConnection | undefined;
    for (const c of this.connections.values()) {
      if (!best || c.lastActivityAt > best.lastActivityAt) best = c;
    }
    return best?.id;
  }

  /** Record tokens and nodes served; returns updated session totals. */
  trackDataServed(id: string, tokens: number, nodes: number): { tokensServed: number; nodesServed: number } {
    const c = this.connections.get(id);
    if (!c) return { tokensServed: 0, nodesServed: 0 };
    c.sessionTokensServed += tokens;
    c.sessionNodesServed += nodes;
    return { tokensServed: c.sessionTokensServed, nodesServed: c.sessionNodesServed };
  }

  /** Record an engram access; returns the number of distinct engrams accessed. */
  trackEngramAccess(id: string, engramId: string): number {
    const c = this.connections.get(id);
    if (!c) return 0;
    const set = this.engramSets.get(id) ?? new Set<string>();
    set.add(engramId);
    this.engramSets.set(id, set);
    c.uniqueEngramsAccessed = set.size;
    return set.size;
  }

  getSessionStats(id: string): { tokensServed: number; nodesServed: number; uniqueEngramsAccessed: number } | null {
    const c = this.connections.get(id);
    if (!c) return null;
    return {
      tokensServed: c.sessionTokensServed,
      nodesServed: c.sessionNodesServed,
      uniqueEngramsAccessed: c.uniqueEngramsAccessed,
    };
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
