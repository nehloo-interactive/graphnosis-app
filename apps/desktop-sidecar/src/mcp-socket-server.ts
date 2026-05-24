import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createMcpServer, type McpDeps } from './mcp-server.js';
import { SocketServerTransport } from './mcp-socket-transport.js';
import { mcpRegistry } from './mcp-registry.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import type { Socket } from 'node:net';

/**
 * Poll the SDK Server for its client identity after the `initialize`
 * handshake. The SDK populates this asynchronously; we check every 200ms
 * for up to 10s. Stops as soon as we get a value or the socket closes.
 */
function pollForClientInfo(connId: string, mcpServer: McpServer, socket: Socket): void {
  const started = Date.now();
  const probe = setInterval(() => {
    try {
      const ci = mcpServer.getClientVersion?.();
      if (ci?.name) {
        mcpRegistry.setClientInfo(connId, ci.name, ci.version ?? 'unknown');
        clearInterval(probe);
        return;
      }
    } catch { /* server not fully ready — try again next tick */ }
    if (Date.now() - started > 10_000) clearInterval(probe);
  }, 200);
  socket.once('close', () => clearInterval(probe));
}

/**
 * Listen on a Unix socket for MCP clients. Each incoming connection gets a
 * fresh MCP `Server` instance bound to that connection's socket, with all the
 * usual Graphnosis tools wired. Multiple clients can connect concurrently —
 * they share the underlying `host` state (one in-memory graph, one source
 * index, one set of pending diffs) so writes from any client are visible to
 * all the others on their next read.
 *
 * Companion script `mcp-relay.ts` is what MCP clients (e.g. Claude Desktop)
 * actually invoke — it just byte-pipes its stdin/stdout to this socket. So
 * the protocol on this socket and on stdio are identical: newline-delimited
 * JSON-RPC.
 */
export async function startSocketMcpServer(opts: {
  deps: McpDeps;
  socketPath: string;
}): Promise<net.Server> {
  // Make sure the parent directory exists, then clean any stale socket file
  // from a prior unclean shutdown so `listen()` doesn't EADDRINUSE.
  await fs.mkdir(path.dirname(opts.socketPath), { recursive: true });
  await fs.rm(opts.socketPath, { force: true });

  const server = net.createServer((socket) => {
    socket.on('error', (err) => {
      console.error(`[graphnosis-sidecar] MCP socket client error: ${err.message}`);
    });

    // `destroy()` is the kicker — fires the same 'close' handler below,
    // which triggers `unregister`. Lets the idle sweep + the AI-tools
    // panel's × button force-close this connection.
    const connId = mcpRegistry.register('socket', () => socket.destroy());
    socket.on('close', () => mcpRegistry.unregister(connId));

    const transport = new SocketServerTransport(socket);

    // Passive request counter — taps the same socket as the transport but
    // doesn't intercept the SDK's message flow. Each newline-terminated
    // chunk on the wire is exactly one JSON-RPC message (matches the
    // newline framing the transport uses). Counts requests AND notifications
    // alike; that's fine for "is this connection alive and busy?" purposes.
    {
      let countBuf = '';
      socket.on('data', (chunk: Buffer | string) => {
        countBuf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let idx: number;
        while ((idx = countBuf.indexOf('\n')) !== -1) {
          countBuf = countBuf.slice(idx + 1);
          mcpRegistry.touch(connId);
        }
      });
    }

    const mcpServer = createMcpServer(opts.deps);

    void mcpServer.connect(transport).then(() => {
      // After the SDK processes `initialize`, it stores the client's reported
      // name+version. We poll briefly to surface them in the App's connection
      // panel. Poll instead of intercepting the message stream — earlier
      // experiments with property-descriptor wrapping on `transport.onmessage`
      // silently broke the SDK's response path. This way the SDK runs
      // untouched and we just observe.
      pollForClientInfo(connId, mcpServer, socket);
    }).catch((err) => {
      console.error(`[graphnosis-sidecar] failed to connect MCP server to socket transport: ${err.message}`);
      socket.destroy();
      mcpRegistry.unregister(connId);
    });
  });

  server.on('error', (err) => {
    console.error(`[graphnosis-sidecar] MCP socket listener error: ${err.message}`);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.socketPath, () => {
      console.error(`[graphnosis-sidecar] MCP socket listening on ${opts.socketPath}`);
      resolve(server);
    });
  });
}
