import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { constantTimeEqual } from './crypto-compare.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, type McpDeps } from './mcp-server.js';
import { mcpRegistry } from './mcp-registry.js';
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import type { SharingToken, SharingScope, SharingRole } from '@graphnosis-app/core/settings';
import { SHARING_TOKEN_ROLES } from '@graphnosis-app/core/settings';

export interface HttpBridgeOptions {
  deps: McpDeps;
  port: number;
  host: string;
  /** Pass a getter function so token rotation takes effect immediately without
   *  restarting the server — the auth check calls it on every request. */
  token: string | (() => string);
  allowedOrigins: string[];
  /**
   * Live getter for active sharing tokens. Called on every new session so
   * revoking or adding tokens takes effect immediately without restarting
   * the server. Absent = no sharing tokens (only the master token accepted).
   */
  sharingTokens?: () => SharingToken[];
}

interface Session {
  transport: StreamableHTTPServerTransport;
  connId: string;
  lastActivityAt: number;
}

interface PendingCode {
  expiresAt: number;
  redirectUri: string;
}

interface PendingDeviceCode {
  expiresAt: number;
}

// Sessions idle for more than 2 hours are pruned to prevent memory leaks
// from abandoned mobile connections (app backgrounded, network change, etc.).
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function rejectUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401);
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

async function readTextBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { buf += chunk; });
    req.on('end', () => resolve(buf));
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
 * Exposes the Graphnosis MCP tools over a single HTTP endpoint so VS Code
 * Copilot Chat, mobile AI clients, and any MCP-capable HTTP client can
 * connect without a Unix socket.
 *
 * Transport: MCP Streamable HTTP (2025-03-26 spec). Clients POST JSON-RPC
 * to /mcp; the server streams responses back as SSE when the client
 * sends `Accept: text/event-stream`. Sessions are keyed by the
 * `Mcp-Session-Id` header the server sets on the first response.
 *
 * Auth: MCP Authorization spec (OAuth 2.0 Authorization Code + PKCE).
 * VS Code's MCP HTTP client always initiates OAuth discovery before using
 * any configured static headers, so we implement a minimal OAuth server
 * that auto-approves the authorization request (no user click — the
 * browser tab opens and immediately redirects back) and returns the static
 * bearer token as the access_token. After the one-time OAuth handshake,
 * every request carries the correct bearer token.
 *
 * Binds to 127.0.0.1 by default — only reachable locally or over an
 * authenticated VPN (e.g. Tailscale). The user explicitly sets host to
 * '0.0.0.0' in Settings to expose it on the LAN.
 */
export async function startHttpMcpServer(opts: HttpBridgeOptions): Promise<http.Server> {
  const sessions = new Map<string, Session>();

  // Short-lived authorization codes for the OAuth Authorization Code flow.
  // Each entry is created by GET /oauth/authorize and consumed by POST /oauth/token.
  const pendingCodes = new Map<string, PendingCode>();

  // Short-lived device codes for the OAuth Device Authorization Grant (RFC 8628).
  // Used by CLI clients (gh copilot, etc.) that cannot complete a browser redirect.
  // Auto-approved on creation since this is a loopback server.
  const pendingDeviceCodes = new Map<string, PendingDeviceCode>();

  // Ring buffer of the last 50 OAuth/auth events for the /oauth/debug endpoint.
  // Accessible without authentication so issues can be diagnosed from a terminal
  // even on a production build where stderr isn't visible.
  const debugLog: Array<{ ts: string; msg: string }> = [];
  function oauthLog(msg: string): void {
    console.error(`[graphnosis-http-bridge] ${msg}`);
    if (debugLog.length >= 50) debugLog.shift();
    debugLog.push({ ts: new Date().toISOString(), msg });
  }

  // Prune stale sessions and codes periodically.
  const pruneInterval = setInterval(() => {
    const now = Date.now();
    const sessionCutoff = now - SESSION_TTL_MS;
    for (const [sid, s] of sessions) {
      if (s.lastActivityAt < sessionCutoff) {
        void s.transport.close().catch(() => { /* best-effort */ });
        sessions.delete(sid);
        mcpRegistry.unregister(s.connId);
        console.error(`[graphnosis-http-bridge] pruned idle session ${sid}`);
      }
    }
    for (const [code, pending] of pendingCodes) {
      if (pending.expiresAt < now) pendingCodes.delete(code);
    }
    for (const [code, pending] of pendingDeviceCodes) {
      if (pending.expiresAt < now) pendingDeviceCodes.delete(code);
    }
  }, 10 * 60 * 1000).unref();

  const server = http.createServer(async (req, res) => {
    const urlPath = req.url?.split('?')[0] ?? '';
    const base = `http://${req.headers['host'] ?? `127.0.0.1:${opts.port}`}`;

    // ── OPTIONS preflight — must bypass auth ─────────────────────────────────
    if (req.method === 'OPTIONS') {
      const preflightOrigin = req.headers['origin'] as string | undefined;
      if (preflightOrigin) setCorsHeaders(res, preflightOrigin);
      res.writeHead(204);
      res.end();
      return;
    }

    const ua = (req.headers['user-agent'] as string | undefined) ?? '';

    // ── OAuth: debug log endpoint — no auth required, loopback-only ───────────
    // Returns the last 50 OAuth/auth events as JSON. Useful for diagnosing
    // client auth failures in production builds where stderr is not visible.
    // Usage: curl http://127.0.0.1:3457/oauth/debug
    if (urlPath === '/oauth/debug' && req.method === 'GET') {
      const liveToken = typeof opts.token === 'function' ? opts.token() : opts.token;
      const peek = (s: string) => s.length > 8
        ? `${s.slice(0, 4)}…${s.slice(-4)} (len=${s.length})`
        : `(len=${s.length})`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ expectedToken: peek(liveToken), events: debugLog }, null, 2));
      return;
    }

    // ── OAuth: protected resource metadata (RFC 9728) ─────────────────────────
    // Points VS Code to the OAuth authorization server on the same host.
    if (urlPath === '/.well-known/oauth-protected-resource') {
      oauthLog(`oauth discovery: protected-resource (ua: ${ua})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ resource: base, authorization_servers: [base] }));
      return;
    }

    // ── OAuth: authorization server metadata (RFC 8414) ───────────────────────
    if (urlPath === '/.well-known/oauth-authorization-server') {
      oauthLog(`oauth discovery: authorization-server metadata (ua: ${ua})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        device_authorization_endpoint: `${base}/oauth/device/code`,
        response_types_supported: ['code'],
        grant_types_supported: [
          'authorization_code',
          'urn:ietf:params:oauth:grant-type:device_code',
        ],
        code_challenge_methods_supported: ['S256', 'plain'],
        token_endpoint_auth_methods_supported: ['none'],
      }));
      return;
    }

    // ── OAuth: dynamic client registration (RFC 7591) ────────────────────────
    // VS Code registers a client before starting the authorization flow.
    if (urlPath === '/oauth/register' && req.method === 'POST') {
      const clientId = randomUUID();
      oauthLog(`oauth register: issued client_id ${clientId.slice(0, 8)}… (ua: ${ua})`);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'],
        response_types: ['code'],
      }));
      return;
    }

    // ── OAuth: device authorization endpoint (RFC 8628) ──────────────────────
    // For CLI clients (gh copilot, etc.) that cannot open a browser redirect.
    // Auto-approves immediately since this is a loopback server — the CLI gets
    // its token on the first poll without any user interaction.
    if (urlPath === '/oauth/device/code' && req.method === 'POST') {
      const deviceCode = randomUUID();
      const userCode = 'GRAPHNOSIS';
      const verifyUri = `${base}/oauth/activate`;
      pendingDeviceCodes.set(deviceCode, { expiresAt: Date.now() + 5 * 60 * 1000 });
      oauthLog(`oauth device/code: issued device_code ${deviceCode.slice(0, 8)}… (ua: ${ua})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verifyUri,
        // verification_uri_complete is optional per RFC 8628 but required by some CLI clients
        verification_uri_complete: `${verifyUri}?user_code=${userCode}`,
        expires_in: 300,
        interval: 1,
      }));
      return;
    }

    // ── OAuth: device activation page (RFC 8628 §3.3) ────────────────────────
    // Stub page shown when the user visits the verification_uri. Since this is
    // a loopback server that auto-approves, no real user action is needed — but
    // some CLI clients open this URL in a browser as confirmation.
    if (urlPath === '/oauth/activate') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2em"><h2>Graphnosis MCP</h2><p>Authorization approved. You may close this tab and return to your terminal.</p></body></html>');
      return;
    }

    // ── OAuth: authorization endpoint ─────────────────────────────────────────
    // Auto-approves for localhost: generates an auth code and immediately
    // redirects back to VS Code's loopback callback server. No user click needed.
    if (urlPath === '/oauth/authorize' && req.method === 'GET') {
      const params = new URLSearchParams(req.url?.split('?')[1] ?? '');
      const redirectUri = params.get('redirect_uri');
      const state = params.get('state');
      if (!redirectUri || params.get('response_type') !== 'code') {
        oauthLog(`oauth authorize: bad request — missing redirect_uri or response_type (ua: ${ua})`);
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }
      const code = randomUUID();
      pendingCodes.set(code, { expiresAt: Date.now() + 5 * 60 * 1000, redirectUri });
      oauthLog(`oauth authorize: redirecting to ${redirectUri.split('?')[0]}… (ua: ${ua})`);
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      if (state) callback.searchParams.set('state', state);
      res.writeHead(302, { Location: callback.toString() });
      res.end();
      return;
    }

    // ── OAuth: token endpoint ─────────────────────────────────────────────────
    // Exchanges an authorization code or device code for the bearer token.
    if (urlPath === '/oauth/token' && req.method === 'POST') {
      let body: URLSearchParams;
      try {
        body = new URLSearchParams(await readTextBody(req));
      } catch {
        oauthLog(`oauth token: invalid request body (ua: ${ua})`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
      const grantType = body.get('grant_type');
      oauthLog(`oauth token: grant_type=${grantType} (ua: ${ua})`);

      // Device Authorization Grant (RFC 8628) — for CLI clients.
      if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
        const deviceCode = body.get('device_code') ?? '';
        const pending = pendingDeviceCodes.get(deviceCode);
        if (!pending || pending.expiresAt < Date.now()) {
          pendingDeviceCodes.delete(deviceCode);
          oauthLog(`oauth token: device_code not found or expired (ua: ${ua})`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'expired_token' }));
          return;
        }
        pendingDeviceCodes.delete(deviceCode);
        const token = typeof opts.token === 'function' ? opts.token() : opts.token;
        oauthLog(`oauth token: device grant success, token=${token.slice(0, 4)}… (ua: ${ua})`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 86400 }));
        return;
      }

      if (grantType !== 'authorization_code') {
        oauthLog(`oauth token: unsupported grant_type=${grantType} (ua: ${ua})`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
        return;
      }
      const code = body.get('code') ?? '';
      const pending = pendingCodes.get(code);
      if (!pending || pending.expiresAt < Date.now()) {
        pendingCodes.delete(code);
        oauthLog(`oauth token: auth_code not found or expired (ua: ${ua})`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const redirectUri = body.get('redirect_uri');
      if (redirectUri && pending.redirectUri !== redirectUri) {
        pendingCodes.delete(code);
        oauthLog(`oauth token: redirect_uri mismatch (ua: ${ua})`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      pendingCodes.delete(code);
      const token = typeof opts.token === 'function' ? opts.token() : opts.token;
      oauthLog(`oauth token: auth_code grant success, token=${token.slice(0, 4)}… (ua: ${ua})`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 86400 }));
      return;
    }

    // ── Auth ─────────────────────────────────────────────────────────────────
    const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
    const masterToken = typeof opts.token === 'function' ? opts.token() : opts.token;
    // Bearer scheme is case-insensitive per RFC 6750; strip prefix and trim.
    const sentToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';
    if (!sentToken) {
      oauthLog(`auth rejected — no bearer in request ${req.method} ${urlPath} (ua: ${ua})`);
      rejectUnauthorized(res);
      return;
    }
    // Identify whether this is the master token (owner, no scope restriction)
    // or a sharing token (scoped to specific engrams + role).
    let matchedSharingScope: SharingScope | null = null;
    let matchedSharingTokenId: string | null = null;
    if (masterToken && constantTimeEqual(sentToken, masterToken)) {
      // Owner access — no scope restriction.
    } else {
      const sharingTokens = opts.sharingTokens?.() ?? [];
      const now = Date.now();
      const matched = sharingTokens.find((st) => {
        if (st.expiresAt !== undefined && st.expiresAt < now) return false;
        return constantTimeEqual(sentToken, st.id);
      });
      if (!matched) {
        oauthLog(`auth rejected — token mismatch ${req.method} ${urlPath} (ua: ${ua})`);
        rejectUnauthorized(res);
        return;
      }
      matchedSharingScope = matched.scope;
      matchedSharingTokenId = matched.id;
      oauthLog(`auth OK — sharing token "${matched.name}" (role: ${matched.scope.role}) ${req.method} ${urlPath}`);
    }

    // ── CORS ──────────────────────────────────────────────────────────────────
    const origin = req.headers['origin'] as string | undefined;
    if (origin) {
      if (opts.allowedOrigins.length > 0 && !opts.allowedOrigins.includes(origin)) {
        res.writeHead(403);
        res.end('Origin not allowed');
        return;
      }
      setCorsHeaders(res, origin);
    }

    // ── Admin: audit log export — enterprise only, master token only ──────────
    // GET /admin/audit[?from=<ms>&to=<ms>&engram=<id>&format=json|csv]
    // For SIEM ingestion; returns op-log events as JSON (default) or CSV.
    if (urlPath === '/admin/audit' && req.method === 'GET') {
      if (matchedSharingScope !== null) { rejectUnauthorized(res); return; }
      const licenseToken = await opts.deps.host.getLicenseToken();
      if (!(opts.deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'enterprise_required', message: 'Audit log export requires an Enterprise license.' }));
        return;
      }
      const qs = new URL(`http://x${req.url ?? ''}`).searchParams;
      const from = qs.has('from') ? Number(qs.get('from')) : undefined;
      const to = qs.has('to') ? Number(qs.get('to')) : undefined;
      const engramFilter = qs.get('engram') ?? undefined;
      const format = qs.get('format') === 'csv' ? 'csv' : 'json';

      let events = await opts.deps.host.listOplogEvents();
      if (from !== undefined) events = events.filter((ev) => ev.ts >= from);
      if (to !== undefined) events = events.filter((ev) => ev.ts <= to);
      if (engramFilter !== undefined) events = events.filter((ev) => ev.graphId === engramFilter);
      events = events.slice().sort((a, b) => a.ts - b.ts);

      let mcpEvents = await opts.deps.host.listMcpAuditEvents();
      if (from !== undefined) mcpEvents = mcpEvents.filter((ev) => ev.ts >= from);
      if (to !== undefined) mcpEvents = mcpEvents.filter((ev) => ev.ts <= to);
      if (engramFilter !== undefined) {
        mcpEvents = mcpEvents.filter((ev) => ev.engramIds?.includes(engramFilter) ?? false);
      }
      mcpEvents = mcpEvents.slice().sort((a, b) => a.ts - b.ts);

      if (format === 'csv') {
        const csvEsc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const rows = [
          ['eventType', 'id', 'ts', 'isoDate', 'action', 'actor', 'graphIdOrEngrams', 'nodeIds', 'servedTokens', 'servedNodes', 'consentGrantId', 'queryHash', 'queryLen', 'isError', 'transport'].map(csvEsc).join(','),
          ...events.map((ev) => [
            'oplog',
            ev.id ?? '',
            ev.ts,
            new Date(ev.ts).toISOString(),
            ev.op,
            (ev as unknown as Record<string, unknown>)['triggeredBy'] ?? ev.deviceId ?? '',
            ev.graphId ?? '',
            ev.target?.id ?? '',
            '', '', '', '', '', '', '',
          ].map(csvEsc).join(',')),
          ...mcpEvents.map((ev) => [
            'mcp',
            ev.id,
            ev.ts,
            new Date(ev.ts).toISOString(),
            ev.tool,
            ev.clientId,
            (ev.engramIds ?? []).join(';'),
            (ev.nodeIds ?? []).join(';'),
            ev.tokenBudget?.servedTokens ?? '',
            ev.tokenBudget?.servedNodes ?? '',
            ev.consentGrantId ?? '',
            ev.queryHash ?? '',
            ev.queryLen ?? '',
            ev.isError ? 'true' : 'false',
            ev.transport ?? '',
          ].map(csvEsc).join(',')),
        ].join('\r\n');
        res.writeHead(200, {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="graphnosis-audit.csv"',
        });
        res.end(rows);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: events.length, events, mcpCount: mcpEvents.length, mcpEvents }));
      return;
    }

    // ── Admin: SSO token provisioning — enterprise only, master token only ────
    // POST /admin/provision
    // Body: { name, role: "viewer"|"editor", engrams: string[]|"*", expiresAt?: ms }
    // Creates a scoped sharing token for MDM/onboarding distribution.
    if (urlPath === '/admin/provision' && req.method === 'POST') {
      if (matchedSharingScope !== null) { rejectUnauthorized(res); return; }
      const licenseToken = await opts.deps.host.getLicenseToken();
      if (!(opts.deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'enterprise_required', message: 'SSO token provisioning requires an Enterprise license.' }));
        return;
      }

      let body: unknown;
      try { body = await readJsonBody(req); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_json' }));
        return;
      }
      const parsed = body as Record<string, unknown>;
      const name = typeof parsed['name'] === 'string' && parsed['name'].length > 0 ? parsed['name'] : null;
      const rawRole = typeof parsed['role'] === 'string' ? parsed['role'] : null;
      const role: SharingRole | null = rawRole && rawRole !== 'owner'
        && (SHARING_TOKEN_ROLES as readonly string[]).includes(rawRole)
        ? rawRole as SharingRole
        : null;
      const rawEngrams = parsed['engrams'];
      const engrams: string[] | '*' | null = rawEngrams === '*'
        ? '*'
        : (Array.isArray(rawEngrams) && rawEngrams.every((e) => typeof e === 'string'))
          ? (rawEngrams as string[])
          : null;
      // Optional carve-outs — only valid on an entire-cortex ('*') scope.
      const rawExcept = parsed['except'];
      const exceptValid = rawExcept === undefined
        || (Array.isArray(rawExcept) && rawExcept.every((e) => typeof e === 'string' && e.length > 0));
      const except: string[] | undefined = exceptValid && Array.isArray(rawExcept) && rawExcept.length > 0
        ? [...new Set(rawExcept as string[])]
        : undefined;

      if (!name || !role || !engrams || !exceptValid || (except && engrams !== '*')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'invalid_params',
          message: 'Required: name (string), role (sharing role from enterprise RBAC matrix), engrams (string[]|"*"). Optional: except (string[], "*" scope only).',
        }));
        return;
      }

      const enterpriseRoles = new Set<SharingRole>(['skill-train', 'admin-audit']);
      if (enterpriseRoles.has(role)) {
        const licenseToken = await opts.deps.host.getLicenseToken();
        if (!(opts.deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'enterprise_required',
            message: 'Skill trainer and admin/audit roles require an Enterprise license.',
          }));
          return;
        }
      }

      const expiresAt = typeof parsed['expiresAt'] === 'number' ? parsed['expiresAt'] : undefined;
      const now = Date.now();

      // Seat cap enforcement (mirrors sharing:create in ipc.ts)
      const licensePayload = opts.deps.licenseValidator?.verifyToken(licenseToken ?? '') ?? null;
      const current = opts.deps.host.getSettings();
      const existing = current.sharing?.tokens ?? [];
      const activeCount = existing.filter((t) => t.expiresAt === undefined || t.expiresAt >= now).length;
      const seatCap = licensePayload?.seats ?? null;
      if (seatCap !== null && activeCount >= seatCap) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'seat_limit',
          message: `Seat limit reached (${seatCap} seat${seatCap === 1 ? '' : 's'}). Revoke a token to free a seat.`,
          seats: seatCap,
          activeCount,
        }));
        return;
      }

      const newTokenId = randomUUID();
      const newToken: import('@graphnosis-app/core/settings').SharingToken = {
        id: newTokenId,
        name,
        scope: {
          engrams,
          ...(except ? { except } : {}),
          role: role as import('@graphnosis-app/core/settings').SharingRole,
        },
        createdAt: now,
      };
      if (expiresAt !== undefined) newToken.expiresAt = expiresAt;

      await opts.deps.host.setSettings({
        ...current,
        sharing: { tokens: [...existing, newToken] },
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        id: newToken.id,
        name: newToken.name,
        role: newToken.scope.role,
        engrams: newToken.scope.engrams,
        ...(newToken.scope.except ? { except: newToken.scope.except } : {}),
        createdAt: newToken.createdAt,
        expiresAt: expiresAt ?? null,
      }));
      return;
    }

    // ── Route ─────────────────────────────────────────────────────────────────
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
    let transport: StreamableHTTPServerTransport;
    const connId = mcpRegistry.register('http', () => void transport?.close());

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, { transport, connId, lastActivityAt: Date.now() });
        // Tag the registry entry so Team Admin can count sessions per token.
        if (matchedSharingTokenId) {
          mcpRegistry.setConnectionMeta(connId, { sharingTokenId: matchedSharingTokenId });
        }
        oauthLog(`new session ${sid} (conn ${connId})`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
      mcpRegistry.unregister(connId);
    };

    const sessionDeps: McpDeps = {
      ...(matchedSharingScope ? { ...opts.deps, sharingScope: matchedSharingScope } : opts.deps),
      mcpTransport: 'http',
    };
    const { server: mcpServer } = createMcpServer(sessionDeps);
    await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0]);
    pollForClientInfo(connId, mcpServer);
    await transport.handleRequest(req, res, body);
  });

  let serverStarted = false;
  server.on('error', (err) => {
    if (serverStarted) {
      oauthLog(`server error: ${err.message}`);
    }
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
      serverStarted = true;
      console.error(
        `[graphnosis-sidecar] MCP HTTP bridge on http://${opts.host}:${opts.port}/mcp`,
      );
      resolve(server);
    });
  });
}
