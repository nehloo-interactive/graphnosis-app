/**
 * OIDC Authorization Code + PKCE for desktop federated unlock.
 * Loopback callback, JWKS ID-token verification, group-claim extraction.
 */

import http from 'node:http';
import { createHash, createVerify, randomBytes, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import type { SharingRole } from '../settings/rbac.js';
import {
  DEFAULT_OIDC_SCOPES,
  DEFAULT_SSO_REDIRECT_URI,
  resolveRoleFromIdpGroups,
  type EnterpriseSsoSettings,
  type IdpGroupRoleMapping,
} from '../settings/sso.js';

export interface OidcUnlockConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes?: string[];
  groupsClaim?: string;
  groupRoleMappings: readonly IdpGroupRoleMapping[];
}

export interface OidcUnlockResult {
  ok: true;
  email?: string;
  subject?: string;
  groups: string[];
  resolvedRole: SharingRole;
  idToken: string;
  accessToken?: string;
}

export interface OidcUnlockFailure {
  ok: false;
  reason: string;
  message: string;
}

export type OidcUnlockOutcome = OidcUnlockResult | OidcUnlockFailure;

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer?: string;
}

interface JwkRsa {
  kty: 'RSA';
  kid?: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

function sha256Base64Url(input: string): string {
  return base64Url(createHash('sha256').update(input).digest());
}

function parseRedirect(redirectUri: string): { host: string; port: number; pathname: string } {
  const u = new URL(redirectUri);
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return { host: u.hostname, port, pathname: u.pathname || '/' };
}

function decodeJwtPart(part: string): Record<string, unknown> {
  const json = Buffer.from(part, 'base64url').toString('utf8');
  return JSON.parse(json) as Record<string, unknown>;
}

function parseJwt(idToken: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer } {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  return {
    header: decodeJwtPart(parts[0]!),
    payload: decodeJwtPart(parts[1]!),
    signingInput: `${parts[0]!}.${parts[1]!}`,
    signature: Buffer.from(parts[2]!, 'base64url'),
  };
}

function rsaPublicKeyFromJwk(jwk: JwkRsa): string {
  const n = Buffer.from(jwk.n, 'base64url');
  const e = Buffer.from(jwk.e, 'base64url');
  // Minimal DER encoding for RSA public key (PKCS#1)
  function derLen(len: number): Buffer {
    if (len < 0x80) return Buffer.from([len]);
    const bytes: number[] = [];
    let nLen = len;
    while (nLen > 0) { bytes.unshift(nLen & 0xff); nLen >>= 8; }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  function derInt(buf: Buffer): Buffer {
    let b = buf;
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
    return Buffer.concat([Buffer.from([0x02]), derLen(b.length), b]);
  }
  function derSeq(parts: Buffer[]): Buffer {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([0x30]), derLen(body.length), body]);
  }
  const rsaSeq = derSeq([derInt(n), derInt(e)]);
  const bitString = Buffer.concat([Buffer.from([0x00]), rsaSeq]);
  const bitStrWrap = Buffer.concat([Buffer.from([0x03]), derLen(bitString.length), bitString]);
  const oid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const algSeq = derSeq([oid, Buffer.from([0x05, 0x00])]);
  const spki = derSeq([algSeq, bitStrWrap]);
  const b64 = spki.toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return await res.json() as T;
}

export async function discoverOidcIssuer(issuer: string): Promise<OidcDiscovery> {
  const base = issuer.replace(/\/$/, '');
  const doc = await fetchJson<OidcDiscovery>(`${base}/.well-known/openid-configuration`);
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error('incomplete OIDC discovery document');
  }
  return doc;
}

export async function verifyIdToken(
  idToken: string,
  opts: { issuer: string; clientId: string; nonce: string; jwksUri: string; nowMs?: number },
): Promise<Record<string, unknown>> {
  const { header, payload, signingInput, signature } = parseJwt(idToken);
  const alg = header['alg'];
  if (alg !== 'RS256') throw new Error(`unsupported JWT alg: ${String(alg)}`);

  const jwks = await fetchJson<{ keys: JwkRsa[] }>(opts.jwksUri);
  const kid = typeof header['kid'] === 'string' ? header['kid'] : undefined;
  const candidates = jwks.keys.filter((k) => k.kty === 'RSA' && (!kid || k.kid === kid));
  if (candidates.length === 0) throw new Error('no matching JWK for ID token');

  let verified = false;
  for (const jwk of candidates) {
    try {
      const pem = rsaPublicKeyFromJwk(jwk);
      const ok = createVerify('RSA-SHA256').update(signingInput).verify(pem, signature);
      if (ok) { verified = true; break; }
    } catch { /* try next key */ }
  }
  if (!verified) throw new Error('ID token signature verification failed');

  const now = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const iss = payload['iss'];
  const aud = payload['aud'];
  const exp = payload['exp'];
  const nbf = payload['nbf'];
  const tokenNonce = payload['nonce'];

  const issuerNorm = opts.issuer.replace(/\/$/, '');
  const issNorm = typeof iss === 'string' ? iss.replace(/\/$/, '') : '';
  if (issNorm !== issuerNorm) throw new Error('ID token issuer mismatch');

  const audOk = Array.isArray(aud)
    ? aud.includes(opts.clientId)
    : aud === opts.clientId;
  if (!audOk) throw new Error('ID token audience mismatch');

  if (typeof exp === 'number' && now > exp + 60) throw new Error('ID token expired');
  if (typeof nbf === 'number' && now + 60 < nbf) throw new Error('ID token not yet valid');
  if (tokenNonce !== opts.nonce) throw new Error('ID token nonce mismatch');

  return payload;
}

export function extractGroupsFromClaims(
  claims: Record<string, unknown>,
  groupsClaim: string,
): string[] {
  const raw = claims[groupsClaim];
  if (Array.isArray(raw)) {
    return raw.filter((g): g is string => typeof g === 'string' && g.trim().length > 0);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export function oidcConfigFromSettings(sso: EnterpriseSsoSettings): OidcUnlockConfig | null {
  const oidc = sso.oidc;
  if (!oidc?.issuer?.trim() || !oidc.clientId?.trim()) return null;
  return {
    issuer: oidc.issuer.trim(),
    clientId: oidc.clientId.trim(),
    ...(oidc.clientSecret ? { clientSecret: oidc.clientSecret } : {}),
    redirectUri: oidc.redirectUri?.trim() || DEFAULT_SSO_REDIRECT_URI,
    scopes: oidc.scopes?.length ? oidc.scopes : [...DEFAULT_OIDC_SCOPES],
    groupsClaim: oidc.groupsClaim?.trim() || 'groups',
    groupRoleMappings: sso.groupRoleMappings,
  };
}

export interface RunOidcUnlockOptions {
  config: OidcUnlockConfig;
  /** When set, skip the loopback server and use this code (smoke tests). */
  injectedCode?: string;
  /** When set with injectedCode, skip state check (smoke tests). */
  injectedState?: string;
  /** Override discovery/JWKS fetch (smoke tests). */
  discoveryOverride?: OidcDiscovery;
  /** Override token endpoint response (smoke tests). */
  tokenResponseOverride?: { id_token: string; access_token?: string };
  timeoutMs?: number;
}

export async function runOidcUnlockFlow(opts: RunOidcUnlockOptions): Promise<OidcUnlockOutcome> {
  const config = opts.config;
  const redirectUri = config.redirectUri ?? DEFAULT_SSO_REDIRECT_URI;
  const scopes = config.scopes ?? [...DEFAULT_OIDC_SCOPES];
  const groupsClaim = config.groupsClaim ?? 'groups';

  const state = opts.injectedState ?? base64Url(randomBytes(16));
  const nonce = base64Url(randomBytes(16));
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = sha256Base64Url(codeVerifier);

  let discovery: OidcDiscovery;
  try {
    discovery = opts.discoveryOverride ?? await discoverOidcIssuer(config.issuer);
  } catch (e) {
    return { ok: false, reason: 'discovery_failed', message: String(e) };
  }

  const authUrl = new URL(discovery.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', config.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  let code: string;
  try {
    if (opts.injectedCode) {
      code = opts.injectedCode;
    } else {
      code = await waitForLoopbackCallback({
        redirectUri,
        expectedState: state,
        authorizationUrl: authUrl.toString(),
        timeoutMs: opts.timeoutMs ?? 120_000,
      });
    }
  } catch (e) {
    return { ok: false, reason: 'callback_failed', message: String(e) };
  }

  let tokenJson: { id_token?: string; access_token?: string };
  try {
    if (opts.tokenResponseOverride) {
      tokenJson = opts.tokenResponseOverride;
    } else {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: config.clientId,
        code_verifier: codeVerifier,
      });
      if (config.clientSecret) body.set('client_secret', config.clientSecret);
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      };
      tokenJson = await fetchJson<{ id_token?: string; access_token?: string }>(
        discovery.token_endpoint,
        { method: 'POST', headers, body: body.toString() },
      );
    }
  } catch (e) {
    return { ok: false, reason: 'token_exchange_failed', message: String(e) };
  }

  if (!tokenJson.id_token) {
    return { ok: false, reason: 'missing_id_token', message: 'Token response did not include id_token' };
  }

  let claims: Record<string, unknown>;
  try {
    claims = await verifyIdToken(tokenJson.id_token, {
      issuer: config.issuer,
      clientId: config.clientId,
      nonce,
      jwksUri: discovery.jwks_uri,
    });
  } catch (e) {
    return { ok: false, reason: 'id_token_invalid', message: String(e) };
  }

  const groups = extractGroupsFromClaims(claims, groupsClaim);
  const resolvedRole = resolveRoleFromIdpGroups(config.groupRoleMappings, groups);
  if (resolvedRole === 'owner') {
    return { ok: false, reason: 'owner_not_allowed', message: 'Owner role cannot be granted via IdP groups' };
  }

  const email = typeof claims['email'] === 'string' ? claims['email'] : undefined;
  const subject = typeof claims['sub'] === 'string' ? claims['sub'] : undefined;

  return {
    ok: true,
    groups,
    resolvedRole,
    idToken: tokenJson.id_token,
    ...(email ? { email } : {}),
    ...(subject ? { subject } : {}),
    ...(tokenJson.access_token ? { accessToken: tokenJson.access_token } : {}),
  };
}

export interface WaitForLoopbackOptions {
  redirectUri: string;
  expectedState: string;
  authorizationUrl: string;
  timeoutMs: number;
}

export function waitForLoopbackCallback(opts: WaitForLoopbackOptions): Promise<string> {
  const { host, port, pathname } = parseRedirect(opts.redirectUri);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    return Promise.reject(new Error('SSO redirect URI must be loopback (127.0.0.1 or localhost)'));
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => fn());
    };

    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', `http://${host}:${port}`);
        if (reqUrl.pathname !== pathname) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const err = reqUrl.searchParams.get('error');
        if (err) {
          const desc = reqUrl.searchParams.get('error_description') ?? err;
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body><p>Sign-in failed: ${desc}</p><p>You can close this tab.</p></body></html>`);
          finish(() => reject(new Error(desc)));
          return;
        }
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state') ?? '';
        if (!code) {
          res.writeHead(400);
          res.end('Missing code');
          finish(() => reject(new Error('OIDC callback missing code')));
          return;
        }
        const a = Buffer.from(state);
        const b = Buffer.from(opts.expectedState);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          res.writeHead(400);
          res.end('Invalid state');
          finish(() => reject(new Error('OIDC state mismatch')));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><p>Signed in. Return to Graphnosis — you can close this tab.</p></body></html>');
        finish(() => resolve(code));
      } catch (e) {
        res.writeHead(500);
        res.end('Internal error');
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });

    server.on('error', (e) => finish(() => reject(e)));

    const timer = setTimeout(() => {
      finish(() => reject(new Error('OIDC sign-in timed out')));
    }, opts.timeoutMs);

    server.listen(port, host, () => {
      // Emit marker for Tauri/supervisor to open system browser.
      console.error(`GRAPHNOSIS_SSO_AUTH_URL:${opts.authorizationUrl}`);
    });
  });
}

/** Test helper — build a signed RS256 JWT with a supplied PEM private key. */
export async function signTestIdToken(
  claims: Record<string, unknown>,
  privateKeyPem: string,
  kid = 'test-key',
): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const h = base64Url(Buffer.from(JSON.stringify(header)));
  const p = base64Url(Buffer.from(JSON.stringify(claims)));
  const input = `${h}.${p}`;
  const { createSign } = await import('node:crypto');
  const sig = createSign('RSA-SHA256').update(input).sign(privateKeyPem);
  return `${input}.${base64Url(sig)}`;
}
