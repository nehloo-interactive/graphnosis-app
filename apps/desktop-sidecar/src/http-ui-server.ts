import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { constantTimeEqual } from './crypto-compare.js';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { dispatch, type IpcDeps } from './ipc.js';
import type { RawFrame } from './events.js';

/**
 * Derive the WebAuthn relying-party ID + expected origin from the request.
 * WebAuthn requires a SECURE CONTEXT — https (e.g. via Tailscale Serve, which
 * sets x-forwarded-proto) or localhost. Plain http to a non-localhost host
 * (http://100.x:3456) is NOT a secure context, so biometric unlock isn't
 * offered there and the token stays the only path. Returns null when insecure.
 */
function deriveRp(req: http.IncomingMessage): { rpID: string; origin: string } | null {
  const hostHeader = (req.headers['host'] as string | undefined) ?? '';
  if (!hostHeader) return null;
  const hostname = hostHeader.split(':')[0] ?? '';
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const xfproto = (req.headers['x-forwarded-proto'] as string | undefined) ?? '';
  const https = xfproto === 'https';
  if (!https && !isLocal) return null; // insecure context — no WebAuthn
  const scheme = https ? 'https' : 'http';
  return { rpID: hostname, origin: `${scheme}://${hostHeader}` };
}

/** A short-lived WebAuthn challenge. */
interface PendingChallenge { challenge: string; expiresAt: number; }
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** The authenticator-transport union (`AuthenticatorTransportFuture[]`), derived
 *  from the library's own option types since it doesn't export the name in a way
 *  we can import here. Our store keeps transports as plain string[]; cast through
 *  this when handing them back to the library. */
type WebAuthnTransports = NonNullable<NonNullable<Parameters<typeof generateRegistrationOptions>[0]['excludeCredentials']>[number]['transports']>;

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

/**
 * Origin allowlist (#20): only reflect Access-Control-Allow-Origin for localhost
 * and the exact configured bind host — never an arbitrary reflected Origin. The
 * web UI is served by this same server, so legitimate use is same-origin (which
 * browsers don't gate on CORS anyway); this blocks cross-origin sites from being
 * granted CORS access. (No cookies are used — auth is a Bearer token — so this is
 * defense-in-depth.)
 */
function isAllowedOrigin(origin: string, host: string, port: number): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  const h = u.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (host !== '0.0.0.0' && h === host && (u.port || '') === String(port)) return true;
  return false;
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
  // WebAuthn challenges (A8). Registration is keyed by the requesting session
  // token; authentication by a server-issued challengeId returned to the client.
  const regChallenges = new Map<string, PendingChallenge>();
  const authChallenges = new Map<string, PendingChallenge>();

  const mintSession = (): string => {
    const t = randomUUID();
    sessions.set(t, { expiresAt: Date.now() + SESSION_TTL_MS });
    return t;
  };

  const pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [t, s] of sessions) {
      if (s.expiresAt < now) sessions.delete(t);
    }
    for (const [k, c] of regChallenges) if (c.expiresAt < now) regChallenges.delete(k);
    for (const [k, c] of authChallenges) if (c.expiresAt < now) authChallenges.delete(k);
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
    if (origin && isAllowedOrigin(origin, opts.host, opts.port)) setCorsHeaders(res, origin);

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
      if (!constantTimeEqual(submitted, opts.token)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: mintSession() }));
      return;
    }

    // ── WebAuthn (A8 — biometric / security-key unlock) ──────────────────
    const sendJson = (code: number, obj: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // GET /api/webauthn/status — does this context support WebAuthn + how many
    // credentials are registered? Drives whether the UI shows the biometric
    // button. Unauthenticated (no secrets revealed).
    if (req.method === 'GET' && urlPath === '/api/webauthn/status') {
      const rp = deriveRp(req);
      const creds = await opts.deps.host.webauthnCredentials.list();
      return sendJson(200, { available: rp !== null, registered: creds.length });
    }

    // POST /api/webauthn/register/options — AUTHED. Begin registering this
    // device. Returns creation options; challenge stored against the session.
    if (req.method === 'POST' && urlPath === '/api/webauthn/register/options') {
      if (!checkSession(req)) { rejectUnauthorized(res); return; }
      const rp = deriveRp(req);
      if (!rp) return sendJson(400, { error: 'WebAuthn needs a secure context (https or localhost).' });
      const existing = await opts.deps.host.webauthnCredentials.loadAll();
      const options = await generateRegistrationOptions({
        rpName: 'Graphnosis',
        rpID: rp.rpID,
        userName: 'graphnosis',
        userID: new TextEncoder().encode('graphnosis-user'),
        attestationType: 'none',
        excludeCredentials: existing.map((c) => ({ id: c.id, ...(c.transports ? { transports: c.transports as WebAuthnTransports } : {}) })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      });
      const sessionToken = (req.headers['authorization'] as string).slice(7);
      regChallenges.set(sessionToken, { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
      return sendJson(200, options);
    }

    // POST /api/webauthn/register/verify — AUTHED. Verify attestation + store
    // the credential. Body: { response, label }.
    if (req.method === 'POST' && urlPath === '/api/webauthn/register/verify') {
      if (!checkSession(req)) { rejectUnauthorized(res); return; }
      const rp = deriveRp(req);
      if (!rp) return sendJson(400, { error: 'WebAuthn needs a secure context.' });
      let body: { response?: unknown; label?: string };
      try { body = (await readJsonBody(req)) as typeof body; } catch { return sendJson(400, { error: 'Invalid JSON' }); }
      const sessionToken = (req.headers['authorization'] as string).slice(7);
      const pending = regChallenges.get(sessionToken);
      if (!pending || pending.expiresAt < Date.now()) return sendJson(400, { error: 'Registration challenge expired — try again.' });
      try {
        const verification = await verifyRegistrationResponse({
          response: body.response as Parameters<typeof verifyRegistrationResponse>[0]['response'],
          expectedChallenge: pending.challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpID,
        });
        regChallenges.delete(sessionToken);
        if (!verification.verified || !verification.registrationInfo) return sendJson(400, { error: 'Registration could not be verified.' });
        const c = verification.registrationInfo.credential;
        await opts.deps.host.webauthnCredentials.add({
          id: c.id,
          publicKey: Buffer.from(c.publicKey).toString('base64url'),
          counter: c.counter,
          ...(c.transports ? { transports: c.transports } : {}),
          label: (body.label && String(body.label).slice(0, 60)) || 'This device',
          createdAt: Date.now(),
        });
        return sendJson(200, { verified: true });
      } catch (e) {
        return sendJson(400, { error: e instanceof Error ? e.message : 'Registration failed' });
      }
    }

    // POST /api/webauthn/auth/options — UNAUTHED (it's the login). Returns
    // request options + a challengeId the client echoes back on verify.
    if (req.method === 'POST' && urlPath === '/api/webauthn/auth/options') {
      const rp = deriveRp(req);
      if (!rp) return sendJson(400, { error: 'WebAuthn needs a secure context.' });
      const creds = await opts.deps.host.webauthnCredentials.loadAll();
      if (creds.length === 0) return sendJson(400, { error: 'No registered devices.' });
      const options = await generateAuthenticationOptions({
        rpID: rp.rpID,
        allowCredentials: creds.map((c) => ({ id: c.id, ...(c.transports ? { transports: c.transports as WebAuthnTransports } : {}) })),
        userVerification: 'preferred',
      });
      const challengeId = randomUUID();
      authChallenges.set(challengeId, { challenge: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS });
      return sendJson(200, { challengeId, options });
    }

    // POST /api/webauthn/auth/verify — UNAUTHED. Verify the assertion; on
    // success mint a session bearer token (same as /api/unlock).
    // Body: { challengeId, response }.
    if (req.method === 'POST' && urlPath === '/api/webauthn/auth/verify') {
      const rp = deriveRp(req);
      if (!rp) return sendJson(400, { error: 'WebAuthn needs a secure context.' });
      let body: { challengeId?: string; response?: { id?: string } };
      try { body = (await readJsonBody(req)) as typeof body; } catch { return sendJson(400, { error: 'Invalid JSON' }); }
      const pending = body.challengeId ? authChallenges.get(body.challengeId) : undefined;
      if (!pending || pending.expiresAt < Date.now()) return sendJson(400, { error: 'Authentication challenge expired — try again.' });
      const credId = body.response?.id;
      const stored = credId ? await opts.deps.host.webauthnCredentials.getById(credId) : null;
      if (!stored) return sendJson(400, { error: 'Unknown credential.' });
      try {
        const verification = await verifyAuthenticationResponse({
          response: body.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'],
          expectedChallenge: pending.challenge,
          expectedOrigin: rp.origin,
          expectedRPID: rp.rpID,
          credential: {
            id: stored.id,
            publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
            counter: stored.counter,
            ...(stored.transports ? { transports: stored.transports as WebAuthnTransports } : {}),
          },
        });
        authChallenges.delete(body.challengeId!);
        if (!verification.verified) return sendJson(401, { error: 'Authentication failed.' });
        await opts.deps.host.webauthnCredentials.updateCounter(stored.id, verification.authenticationInfo.newCounter);
        return sendJson(200, { token: mintSession() });
      } catch (e) {
        return sendJson(400, { error: e instanceof Error ? e.message : 'Authentication failed' });
      }
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
