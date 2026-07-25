/**
 * Unit tests for the MCP HTTP bridge's OAuth shim security posture:
 *  - advertised metadata honors X-Forwarded-Proto/-Host (TLS-terminating proxy)
 *  - auto-approving OAuth endpoints are local-direct only (proxied → 403)
 *  - the direct loopback flow (VS Code / gh copilot) keeps working unchanged
 * Run after build: node --test tests/mcp-http-oauth.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHttpMcpServer } from '../dist/mcp-http-server.js';

const MASTER = 'test-master-token-0000';
let server;
let port;

before(async () => {
  server = await startHttpMcpServer({
    // The OAuth + metadata + auth paths under test never dereference deps.
    deps: {},
    port: 0,
    host: '127.0.0.1',
    token: () => MASTER,
    allowedOrigins: [],
  });
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(() => resolve())));

const url = (p) => `http://127.0.0.1:${port}${p}`;
// What a request relayed by tailscale serve (or nginx) looks like: the TCP
// peer is loopback, but the forwarding headers mark it as originating remotely.
const PROXY_HEADERS = {
  'X-Forwarded-Proto': 'https',
  'X-Forwarded-Host': 'mini.tailnet.ts.net:8443',
  'X-Forwarded-For': '100.100.101.39',
};

test('metadata advertises http + local host on direct requests', async () => {
  const res = await fetch(url('/.well-known/oauth-authorization-server'));
  assert.equal(res.status, 200);
  const meta = await res.json();
  assert.equal(meta.issuer, `http://127.0.0.1:${port}`);
  assert.ok(meta.authorization_endpoint.startsWith(`http://127.0.0.1:${port}/`));
});

test('metadata honors X-Forwarded-Proto/-Host behind a TLS proxy', async () => {
  const res = await fetch(url('/.well-known/oauth-authorization-server'), { headers: PROXY_HEADERS });
  assert.equal(res.status, 200);
  const meta = await res.json();
  assert.equal(meta.issuer, 'https://mini.tailnet.ts.net:8443');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint', 'device_authorization_endpoint']) {
    assert.ok(
      meta[key].startsWith('https://mini.tailnet.ts.net:8443/'),
      `${key} should advertise the https proxy origin, got ${meta[key]}`,
    );
  }
});

test('non-https X-Forwarded-Proto never changes the scheme', async () => {
  const res = await fetch(url('/.well-known/oauth-authorization-server'), {
    headers: { 'X-Forwarded-Proto': 'javascript:' },
  });
  const meta = await res.json();
  assert.ok(meta.issuer.startsWith('http://'), `scheme must stay http, got ${meta.issuer}`);
});

test('proxied requests to auto-approve endpoints get 403', async () => {
  const cases = [
    ['GET', '/oauth/debug'],
    ['POST', '/oauth/register'],
    ['POST', '/oauth/device/code'],
    ['GET', '/oauth/activate'],
    ['GET', '/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcb'],
    ['POST', '/oauth/token'],
  ];
  for (const [method, path] of cases) {
    const res = await fetch(url(path), { method, headers: PROXY_HEADERS, redirect: 'manual' });
    assert.equal(res.status, 403, `${method} ${path} should be 403 when proxied, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.error, 'access_denied');
  }
});

test('any single X-Forwarded-* header disqualifies local trust', async () => {
  for (const header of ['X-Forwarded-For', 'X-Forwarded-Proto', 'X-Forwarded-Host']) {
    const res = await fetch(url('/oauth/device/code'), { method: 'POST', headers: { [header]: 'x' } });
    assert.equal(res.status, 403, `${header} alone should force 403`);
  }
});

test('local-direct device flow still auto-approves and returns the master token', async () => {
  const codeRes = await fetch(url('/oauth/device/code'), { method: 'POST' });
  assert.equal(codeRes.status, 200);
  const { device_code } = await codeRes.json();
  assert.ok(device_code);
  const tokenRes = await fetch(url('/oauth/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code,
    }),
  });
  assert.equal(tokenRes.status, 200);
  const tok = await tokenRes.json();
  assert.equal(tok.access_token, MASTER);
});

test('local-direct authorization-code flow still auto-approves', async () => {
  const redirectUri = 'http://127.0.0.1:9/cb';
  const authRes = await fetch(
    url(`/oauth/authorize?response_type=code&state=st1&redirect_uri=${encodeURIComponent(redirectUri)}`),
    { redirect: 'manual' },
  );
  assert.equal(authRes.status, 302);
  const loc = new URL(authRes.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'st1');
  const code = loc.searchParams.get('code');
  assert.ok(code);
  const tokenRes = await fetch(url('/oauth/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  assert.equal(tokenRes.status, 200);
  assert.equal((await tokenRes.json()).access_token, MASTER);
});

test('local-direct register and debug still respond', async () => {
  const reg = await fetch(url('/oauth/register'), { method: 'POST', body: '{}' });
  assert.equal(reg.status, 201);
  assert.ok((await reg.json()).client_id);
  const dbg = await fetch(url('/oauth/debug'));
  assert.equal(dbg.status, 200);
  assert.ok((await dbg.json()).expectedToken);
});

test('/mcp still rejects missing and wrong bearer tokens', async () => {
  const noAuth = await fetch(url('/mcp'), { method: 'POST', body: '{}' });
  assert.equal(noAuth.status, 401);
  const badAuth = await fetch(url('/mcp'), {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-token' },
    body: '{}',
  });
  assert.equal(badAuth.status, 401);
});
