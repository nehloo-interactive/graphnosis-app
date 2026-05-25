import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type McpDeps } from './mcp-server.js';
import { mcpRegistry } from './mcp-registry.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';

export interface HttpBridgeOptions {
  deps: McpDeps;
  port: number;
  host: string;
  /** Pass a getter function so token rotation takes effect immediately without
   *  restarting the server — the auth check calls it on every request. */
  token: string | (() => string);
  allowedOrigins: string[];
}

interface Session {
  transport: StreamableHTTPServerTransport;
  connId: string;
  lastActivityAt: number;
}

// Sessions idle for more than 2 hours are pruned to prevent memory leaks
// from abandoned mobile connections (app backgrounded, network change, etc.).
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function rejectUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="graphnosis"' });
  res.end('Unauthorized');
}

function setCorsHeaders(res: http.ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Vary', 'Origin');
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { buf += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * Poll a newly-connected MCP server for the client's identity (name +
 * version from the `initialize` handshake). The SDK populates this
 * asynchronously; we probe every 200ms for up to 10s and update the
 * registry entry once a name is present. Mirrors the same polling logic
 * in mcp-socket-server.ts.
 *
 * Unlike the socket variant, we don't attach a cancel handler to the
 * transport — the probe auto-terminates after 10s which is well within
 * any reasonable connect-time.
 */
function pollForClientInfo(connId: string, mcpServer: McpServer): void {
  const started = Date.now();
  const probe = setInterval(() => {
    try {
      const ci = mcpServer.getClientVersion?.();
      if (ci?.name) {
        mcpRegistry.setClientInfo(connId, ci.name, ci.version ?? 'unknown');
        clearInterval(probe);
        return;
      }
    } catch { /* server not fully initialized yet — retry */ }
    if (Date.now() - started > 10_000) clearInterval(probe);
  }, 200);
}

/**
 * Start the optional HTTP/SSE MCP bridge.
 *
 * Exposes the same 6 MCP tools (recall, remember, correct, apply, forget,
 * stats) over a single HTTP endpoint so mobile AI clients — and any
 * MCP-capable HTTP client — can connect without a Unix socket.
 *
 * Transport: MCP Streamable HTTP (2025-03-26 spec). Clients POST JSON-RPC
 * to /mcp; the server streams responses back as SSE when the client
 * sends `Accept: text/event-stream`. Sessions are keyed by the
 * `Mcp-Session-Id` header the server sets on the first response.
 *
 * Auth: every request must carry `Authorization: Bearer <token>`. The token
 * is a UUID auto-generated on first enable and stored in settings.json.
 *
 * Binds to 127.0.0.1 by default — only reachable locally or over an
 * authenticated VPN (e.g. Tailscale). The user explicitly sets host to
 * '0.0.0.0' in Settings to expose it on the LAN.
 */
export async function startHttpMcpServer(opts: HttpBridgeOptions): Promise<http.Server> {
  const sessions = new Map<string, Session>();

  // Prune stale sessions periodically. Unref'd so this interval doesn't
  // prevent clean process exit.
  const pruneInterval = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [sid, s] of sessions) {
      if (s.lastActivityAt < cutoff) {
        void s.transport.close().catch(() => { /* best-effort */ });
        sessions.delete(sid);
        mcpRegistry.unregister(s.connId);
        console.error(`[graphnosis-http-bridge] pruned idle session ${sid}`);
      }
    }
  }, 10 * 60 * 1000).unref();

  const server = http.createServer(async (req, res) => {
    // ── Auth ─────────────────────────────────────────────────────────────────
    const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
    const expectedToken = typeof opts.token === 'function' ? opts.token() : opts.token;
    if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
      rejectUnauthorized(res);
      return;
    }

    // ── CORS ──────────────────────────────────────────────────────────────────
    // Only applies when an Origin header is present (browser / PWA callers).
    // Native mobile apps don't send Origin so they pass through unconditionally.
    const origin = req.headers['origin'] as string | undefined;
    if (origin) {
      if (opts.allowedOrigins.length > 0 && !opts.allowedOrigins.includes(origin)) {
        res.writeHead(403);
        res.end('Origin not allowed');
        return;
      }
      setCorsHeaders(res, origin);
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ── Route ─────────────────────────────────────────────────────────────────
    const urlPath = req.url?.split('?')[0];
    if (urlPath !== '/mcp' && urlPath !== '/') {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // ── GET — open / re-join SSE stream ───────────────────────────────────────
    if (req.method === 'GET') {
      if (!sessionId) {
        res.writeHead(400);
        res.end('Mcp-Session-Id header required for GET');
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404);
        res.end('Session not found');
        return;
      }
      session.lastActivityAt = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }

    // ── DELETE — terminate session ─────────────────────────────────────────────
    if (req.method === 'DELETE') {
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session) {
          await session.transport.close().catch(() => { /* best-effort */ });
          sessions.delete(sessionId);
          mcpRegistry.unregister(session.connId);
        }
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // ── POST — JSON-RPC messages ───────────────────────────────────────────────
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST, DELETE, OPTIONS' });
      res.end('Method Not Allowed');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON body');
      return;
    }

    // Re-join an existing session.
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId)!;
      session.lastActivityAt = Date.now();
      mcpRegistry.touch(session.connId);
      await session.transport.handleRequest(req, res, body);
      return;
    }

    // ── New session ────────────────────────────────────────────────────────────
    // Kicker: closing the transport triggers its `onclose` below, which
    // unregisters the connection. Used by the idle sweep + UI × button.
    let transport: StreamableHTTPServerTransport;
    const connId = mcpRegistry.register('http', () => void transport?.close());

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, connId, lastActivityAt: Date.now() });
        console.error(`[graphnosis-http-bridge] new session ${sid} (conn ${connId})`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      mcpRegistry.unregister(connId);
    };

    const mcpServer = createMcpServer(opts.deps);
    // Cast: StreamableHTTPServerTransport.onclose is typed as optional, but
    // the Transport interface mcpServer.connect() expects requires a
    // non-undefined callback. We assigned it above (line ~220) so it's safe.
    // exactOptionalPropertyTypes catches the structural mismatch but the
    // runtime contract is fine.
    await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0]);
    pollForClientInfo(connId, mcpServer);
    await transport.handleRequest(req, res, body);
  });

  server.on('error', (err) => {
    console.error(`[graphnosis-http-bridge] server error: ${err.message}`);
  });

  server.once('close', () => {
    clearInterval(pruneInterval);
    for (const [, s] of sessions) {
      void s.transport.close().catch(() => { /* best-effort */ });
      mcpRegistry.unregister(s.connId);
    }
    sessions.clear();
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      console.error(
        `[graphnosis-sidecar] MCP HTTP bridge on http://${opts.host}:${opts.port}/mcp`,
      );
      resolve(server);
    });
  });
}
