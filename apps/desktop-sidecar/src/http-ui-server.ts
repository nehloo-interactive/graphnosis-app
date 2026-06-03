import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dispatch, type IpcDeps } from './ipc.js';
import type { RawFrame } from './events.js';

export interface HttpUiOptions {
  deps: IpcDeps;
  port: number;
  host: string;
  /** Static auth token the user enters once to obtain a browser session token. */
  token: string;
  /** Directory containing the compiled web UI (index.html + assets). Optional —
   *  serves a status placeholder when absent. */
  staticDir?: string;
  /** Subscribe to every outbound event frame (mutations + raw progress).
   *  Provided by the EventsHandle returned from startEvents(). */
  subscribeEvents: (fn: (frame: RawFrame) => void) => () => void;
}

interface Session {
  expiresAt: number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.webp': 'image/webp',
};

function rejectUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
}

function setCorsHeaders(res: http.ServerResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Vary', 'Origin');
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
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

function sendSse(res: http.ServerResponse, data: unknown): void {
  if (res.destroyed) return;
  try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
}

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, staticDir: string): Promise<void> {
  let relPath = (req.url?.split('?')[0] ?? '/').replace(/\.\./g, '');
  if (relPath === '/' || !relPath) relPath = '/index.html';

  const fullPath = path.resolve(staticDir, relPath.replace(/^\//, ''));
  if (!fullPath.startsWith(path.resolve(staticDir))) {
    res.writeHead(403); res.end(); return;
  }

  try {
    const data = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      ...cacheHeaders(relPath),
    });
    res.end(data);
  } catch {
    // SPA fallback: unknown routes → index.html
    try {
      const indexPath = path.join(staticDir, 'index.html');
      const data = await fs.readFile(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cacheHeaders('/index.html') });
      res.end(data);
    } catch {
      res.writeHead(404); res.end('Not Found');
    }
  }
}

/**
 * Cache policy: hashed assets under /assets/ are content-addressed and may be
 * cached forever; everything else (notably index.html) must revalidate so a
 * rebuilt UI reaches the browser on the next refresh instead of serving a
 * stale shell that points at deleted asset hashes.
 */
function cacheHeaders(relPath: string): Record<string, string> {
  if (relPath.startsWith('/assets/')) {
    return { 'Cache-Control': 'public, max-age=31536000, immutable' };
  }
  return { 'Cache-Control': 'no-cache' };
}

function servePlaceholder(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Graphnosis — Server Mode</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0e0e0f; color: #c9d1d9;
           display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { max-width: 420px; text-align: center; padding: 2.5rem 2rem; }
    h1 { font-size: 1.4rem; margin: 0 0 0.75rem; }
    p  { color: #8b949e; font-size: 0.9rem; line-height: 1.6; margin: 0.5rem 0; }
    code { background: #161b22; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.85em; }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%;
           background: #3fb950; margin-right: 6px; vertical-align: middle; }
  </style>
</head>
<body>
<div class="card">
  <p><span class="dot"></span>Sidecar online</p>
  <h1>Graphnosis is running in server mode</h1>
  <p>The browser UI is not yet built for this deployment.</p>
  <p>The JSON-RPC API is available at <code>/api/rpc</code>.<br>
     Authenticate at <code>POST /api/unlock</code>.</p>
</div>
</body>
</html>`);
}

/**
 * Start the HTTP UI server for browser access.
 *
 * Exposes three API surfaces on a single HTTP port (default :3456):
 *   POST /api/unlock   — exchange the static token for a session bearer token
 *   POST /api/rpc      — JSON-RPC dispatch to all IPC methods (requires session)
 *   GET  /api/events   — SSE stream of all sidecar events (requires session)
 *   GET  /*            — static web UI files (SPA fallback to index.html)
 *
 * Auth model:
 *   1. User calls POST /api/unlock with { token: "<GRAPHNOSIS_HTTP_UI_TOKEN>" }
 *   2. Sidecar returns { token: "<sessionUUID>" }
 *   3. All subsequent requests carry Authorization: Bearer <sessionUUID>
 *   4. Sessions expire after 24 hours (or on sidecar restart)
 *
 * Designed for Tailscale access: bind 0.0.0.0 when GRAPHNOSIS_BIND is set,
 * 127.0.0.1 by default. No TLS required within a trusted tailnet.
 */
export async function startHttpUiServer(opts: HttpUiOptions): Promise<http.Server> {
  const sessions = new Map<string, Session>();

  const pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) {
      if (s.expiresAt < now) sessions.delete(t);
    }
  }, 60 * 60 * 1000).unref();

  const checkSession = (req: http.IncomingMessage): boolean => {
    const auth = (req.headers['authorization'] as string | undefined) ?? '';
    const sessionToken = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!sessionToken) return false;
    const session = sessions.get(sessionToken);
    return !!session && session.expiresAt >= Date.now();
  };

  const server = http.createServer(async (req, res) => {
    const urlPath = req.url?.split('?')[0] ?? '/';

    const origin = req.headers['origin'] as string | undefined;
    if (origin) setCorsHeaders(res, origin);

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── POST /api/unlock ─────────────────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/api/unlock') {
      let body: unknown;
      try { body = await readJsonBody(req); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const submitted = (body as { token?: string }).token ?? '';
      if (submitted !== opts.token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
        return;
      }
      const sessionToken = randomUUID();
      sessions.set(sessionToken, { expiresAt: Date.now() + SESSION_TTL_MS });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: sessionToken }));
      return;
    }

    // ── GET /api/events — SSE ────────────────────────────────────────────
    if (req.method === 'GET' && urlPath === '/api/events') {
      if (!checkSession(req)) { rejectUnauthorized(res); return; }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();

      sendSse(res, {
        kind: 'hello',
        name: 'graph.events',
        payload: { ts: Date.now(), cursor: opts.deps.host.getMutationCursor() },
      });

      const onFrame = (frame: RawFrame): void => sendSse(res, frame);
      const unsubscribe = opts.subscribeEvents(onFrame);

      const heartbeat = setInterval(() => {
        if (res.destroyed) { clearInterval(heartbeat); return; }
        try { res.write(':heartbeat\n\n'); } catch { clearInterval(heartbeat); }
      }, 30_000).unref();

      req.on('close', () => {
        unsubscribe();
        clearInterval(heartbeat);
      });
      return;
    }

    // ── POST /api/rpc — IPC dispatch ─────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/api/rpc') {
      if (!checkSession(req)) { rejectUnauthorized(res); return; }

      let body: unknown;
      try { body = await readJsonBody(req); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const rpc = body as { method?: string; params?: unknown };
      if (!rpc.method || typeof rpc.method !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing or invalid "method" field' }));
        return;
      }

      try {
        const result = await dispatch(opts.deps, rpc.method, rpc.params);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result }));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // One-line message only — a failed RPC (unknown method, bad params) is
        // a client-side issue, not a server fault; dumping the full stack on
        // every such call just clutters the console.
        console.error(`[graphnosis-http-ui] RPC '${rpc.method}' failed: ${message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    // ── GET /* — static files / SPA ─────────────────────────────────────
    if (req.method === 'GET') {
      if (opts.staticDir) {
        await serveStatic(req, res, opts.staticDir);
      } else {
        servePlaceholder(res);
      }
      return;
    }

    res.writeHead(405, { Allow: 'GET, POST, OPTIONS' });
    res.end('Method Not Allowed');
  });

  let serverStarted = false;
  server.on('error', (err) => {
    if (serverStarted) {
      console.error(`[graphnosis-http-ui] server error: ${err.message}`);
    }
  });

  server.once('close', () => {
    clearInterval(pruneTimer);
    sessions.clear();
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      serverStarted = true;
      const bind = opts.host === '0.0.0.0' ? `*:${opts.port}` : `${opts.host}:${opts.port}`;
      console.error(`[graphnosis-sidecar] HTTP UI on http://${bind}`);
      resolve(server);
    });
  });
}
