import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphnosisHost, MutationEvent } from './host.js';

// Push-event socket for the Tauri shell (and any future long-running
// consumer) to subscribe to graph mutations without polling.
//
// Protocol: newline-delimited JSON, server → client only. Each event is:
//   { kind: 'event', name: 'graph.mutation', payload: { graphId, ts } }
//
// Distinct from the main sidecar.sock which is strict request/response.
// We use a SEPARATE socket (events.sock) rather than multiplexing onto
// the main socket because the main socket is explicitly stateless on
// the Rust side ("one connection per request" — see ipc_client.rs).
// Trying to push events on a connection that the client expects to
// close after one response would be brittle.

interface EventFrame {
  kind: 'event';
  name: 'graph.mutation';
  payload: MutationEvent;
}

/** Any arbitrary frame that the IPC layer wants to broadcast to all subscribers. */
export interface RawFrame {
  kind: string;
  name: string;
  payload: unknown;
}

/** Function returned by startEvents so callers can push custom frames. */
export type BroadcastRawFn = (frame: RawFrame) => void;

/** Backpressure threshold. If a socket's pending write buffer grows past
 *  this, we drop subsequent events for that socket and log it. Real-world
 *  cause: the consumer is stuck (UI re-render storm, paused process),
 *  and queueing forever would grow sidecar memory unboundedly. The next
 *  mutation will trigger a new event; the consumer will reconcile via
 *  the periodic `node.cursor` poll. */
const BACKPRESSURE_HIGH_WATER = 1_000_000; // 1 MB

/** Throttle window. The sidecar emits at most one event per this many
 *  ms to all subscribers. Auto-relink can fire 20-50 mutations in <2s;
 *  without throttling that's 20-50 Atlas re-renders. With leading +
 *  trailing semantics the first event still arrives within ~1ms. */
const THROTTLE_MS = 400;

interface ThrottleState {
  pending: MutationEvent | null;
  // Most recent ts seen for a graph during the suppression window.
  // Coalesced into one outgoing event when the trailing fire happens.
  lastSeenByGraph: Map<string, number>;
  trailingTimer: NodeJS.Timeout | null;
  lastFiredAt: number;
}

export interface EventsDeps {
  host: GraphnosisHost;
  socketPath: string;
}

/** Returns true when socketPath is a TCP address like "127.0.0.1:PORT". */
function isTcpAddress(socketPath: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(socketPath);
}

export interface EventsHandle {
  server: net.Server;
  broadcastRaw: BroadcastRawFn;
  /** Subscribe to every outbound frame (mutations + raw progress). Returns an unsubscribe fn. */
  subscribe: (fn: (frame: RawFrame) => void) => () => void;
}

export async function startEvents(deps: EventsDeps): Promise<EventsHandle> {
  if (!isTcpAddress(deps.socketPath)) {
    await fs.mkdir(path.dirname(deps.socketPath), { recursive: true });
    await fs.rm(deps.socketPath, { force: true });
  }

  const sockets = new Set<net.Socket>();
  const inProcessSubscribers = new Set<(frame: RawFrame) => void>();
  const state: ThrottleState = {
    pending: null,
    lastSeenByGraph: new Map(),
    trailingTimer: null,
    lastFiredAt: 0,
  };

  /** Write a raw frame to every connected subscriber — used for progress
   *  events that don't go through the throttled mutation path. */
  const broadcastRaw: BroadcastRawFn = (frame: RawFrame): void => {
    const line = JSON.stringify(frame) + '\n';
    for (const sock of sockets) {
      if (sock.destroyed) { sockets.delete(sock); continue; }
      if (sock.writableLength > BACKPRESSURE_HIGH_WATER) continue;
      sock.write(line, (err) => {
        if (err) { sock.destroy(); sockets.delete(sock); }
      });
    }
    for (const fn of inProcessSubscribers) {
      try { fn(frame); } catch { /* best-effort — SSE client may have disconnected */ }
    }
  };

  const broadcast = (event: MutationEvent): void => {
    const frame: EventFrame = {
      kind: 'event',
      name: 'graph.mutation',
      payload: event,
    };
    broadcastRaw(frame as unknown as RawFrame);
  };

  // Throttle: fire on leading edge, suppress 400ms, fire trailing if
  // any events were swallowed. Per-graph coalescing means a single
  // graph mutated 30 times during the window emits once on leading
  // and once on trailing (with the LATEST ts), not 30 separate events.
  const fireTrailing = (): void => {
    state.trailingTimer = null;
    if (state.lastSeenByGraph.size === 0) return;
    const fireTs = Date.now();
    state.lastFiredAt = fireTs;
    for (const [graphId, ts] of state.lastSeenByGraph) {
      broadcast({ graphId, ts });
    }
    state.lastSeenByGraph.clear();
  };

  const onMutation = (event: MutationEvent): void => {
    const now = Date.now();
    const elapsed = now - state.lastFiredAt;
    if (elapsed >= THROTTLE_MS && state.trailingTimer === null) {
      // Leading edge — fire immediately, start suppression window.
      state.lastFiredAt = now;
      broadcast(event);
      // Arm a trailing timer to flush any events that come in during
      // the window. Cancelled if we fire trailing with an empty buffer.
      state.trailingTimer = setTimeout(fireTrailing, THROTTLE_MS);
    } else {
      // Inside suppression window — coalesce by graphId, keeping latest ts.
      state.lastSeenByGraph.set(event.graphId, event.ts);
      // If somehow no trailing timer is armed (shouldn't happen given the
      // leading branch always arms it, but defensive), arm one now.
      if (state.trailingTimer === null) {
        const wait = Math.max(0, THROTTLE_MS - elapsed);
        state.trailingTimer = setTimeout(fireTrailing, wait);
      }
    }
  };

  const unsubscribe = deps.host.onMutation(onMutation);

  const server = net.createServer((sock) => {
    sockets.add(sock);
    // Send a hello frame so the client can confirm the channel is alive
    // immediately on connect (useful for reconnect verification). Also
    // includes a snapshot of the current cursor so the client can
    // reconcile any events missed between sidecar restart and the new
    // subscription being established.
    const helloFrame = {
      kind: 'hello',
      name: 'graph.events',
      payload: {
        ts: Date.now(),
        cursor: deps.host.getMutationCursor(),
      },
    };
    sock.write(JSON.stringify(helloFrame) + '\n');
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {
      // ECONNRESET / EPIPE when client goes away — non-fatal.
      sockets.delete(sock);
      sock.destroy();
    });
    // We don't expect inbound data on this socket; if a client sends
    // anything, ignore it (don't echo, don't error).
    sock.on('data', () => { /* no-op */ });
  });

  server.on('close', () => {
    unsubscribe();
    inProcessSubscribers.clear();
    if (state.trailingTimer !== null) {
      clearTimeout(state.trailingTimer);
      state.trailingTimer = null;
    }
  });

  const subscribe = (fn: (frame: RawFrame) => void): (() => void) => {
    inProcessSubscribers.add(fn);
    return () => inProcessSubscribers.delete(fn);
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const onListening = () => {
      console.error(`[graphnosis-sidecar] events socket listening on ${deps.socketPath}`);
      resolve({ server, broadcastRaw, subscribe });
    };
    if (isTcpAddress(deps.socketPath)) {
      const colonIdx = deps.socketPath.lastIndexOf(':');
      const host = deps.socketPath.slice(0, colonIdx);
      const port = parseInt(deps.socketPath.slice(colonIdx + 1), 10);
      server.listen(port, host, onListening);
    } else {
      server.listen(deps.socketPath, onListening);
    }
  });
}
