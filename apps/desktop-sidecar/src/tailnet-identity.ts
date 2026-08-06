/**
 * Tailnet identity authorization for the MCP HTTP bridge.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 * The recommended remote path already requires Tailscale:
 *
 *     tailscale serve --bg --https=8443 http://127.0.0.1:3457
 *
 * Tailscale Serve terminates TLS and proxies to the bridge on loopback,
 * injecting identity headers it derives from the tailnet connection:
 * `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic`,
 * `Tailscale-App-Capabilities`, `Tailscale-Headers-Info` (confirmed against the
 * running tailscaled 1.94.2 on this machine). That identity is strictly better
 * than a pre-shared bearer: it is per-person, revocable in the tailnet ACL, and
 * never copied into a config file.
 *
 * ── THE TRAP, and why most of this file exists ───────────────────────────────
 * A header is trustworthy ONLY when the client cannot set it. `Tailscale-User-
 * Login` is an ordinary HTTP header. If the bridge trusted it while listening
 * on anything a client can dial directly — and `mobile.httpBridge.host` is
 * user-settable to '0.0.0.0' (see the "Interface to bind on" field on
 * `MobileHttpBridgeSettings` in app-core `settings/index.ts`, and the
 * `mobile.httpBridge` patch the desktop Settings panel sends in main.ts) —
 * then ANY caller could send `Tailscale-User-Login: owner@example.com` and
 * authenticate as the owner. That is a total auth bypass, strictly worse than
 * the shared secret it replaces.
 *
 * So identity is never accepted on the header's say-so. SIX conditions must all
 * hold; each is stated as its own check below with the attack it defeats:
 *
 *   1. Feature explicitly enabled AND a non-empty allow-list.   (default: OFF)
 *   2. The TCP peer is loopback — `req.socket.remoteAddress`, kernel truth, not
 *      a header. A remote client dialing a 0.0.0.0-bound bridge fails here.
 *      THIS is the check that defeats the forgery.
 *   3. The request carries proxy markers (X-Forwarded-Proto: https + an
 *      X-Forwarded-For), i.e. it came through a local TLS terminator rather
 *      than being a local-direct call. Local-direct already has its own path
 *      (the loopback OAuth flow) and must not be overloaded.
 *   4. Tailscale Serve is VERIFIED — not assumed — to currently front this
 *      bridge's own port, by reading `tailscale serve status --json`.
 *   5. The identity is RE-DERIVED OUT OF BAND: the first X-Forwarded-For hop
 *      must be a tailnet address (100.64.0.0/10 or fd7a:115c:a1e0::/48), and
 *      `tailscale whois` for that address must return the SAME login as the
 *      header. The header is never trusted alone — it is only permitted to
 *      AGREE with tailscaled.
 *   6. The re-derived login must appear in the allow-list.
 *
 * ── Residual risk, stated rather than argued away ────────────────────────────
 * A SECOND header-forwarding reverse proxy in front of the bridge (nginx
 * alongside or instead of Tailscale Serve) could let a remote client reach the
 * bridge from loopback with an attacker-chosen `Tailscale-User-Login` AND an
 * attacker-chosen `X-Forwarded-For`. Check 4 confirms that Serve fronts our
 * port; it CANNOT confirm that THIS connection arrived through Serve, and no
 * in-band check can. The mitigation is documentation ("identity auth is
 * unsupported behind a non-Tailscale reverse proxy") plus the allow-list, which
 * bounds the blast radius to logins the owner configured. This is not claimed
 * to be airtight against an operator who puts a hostile proxy on their own
 * loopback.
 *
 * Local processes gain nothing from this path: an unprivileged local process
 * can ALREADY obtain the master token unauthenticated in two calls via
 * POST /oauth/device/code → POST /oauth/token (mcp-http-server.ts:314-332,
 * :391-407, both local-direct gated). Loopback is already a fully-trusted zone
 * on this bridge, so conditioning identity trust on loopback adds zero new
 * local privilege.
 */

import type {
  SharingScope,
  TailnetIdentityGrant,
  TailnetIdentitySettings,
} from '@graphnosis-app/core/settings';
import { SHARING_TOKEN_ROLES } from '@graphnosis-app/core/settings';

// Single source of truth for the persisted shape is app-core's settings module
// (HttpBridgeSettings.identity). Re-exported here so callers of the gate don't
// need two imports.
export type { TailnetIdentityGrant, TailnetIdentitySettings };

/**
 * The out-of-band facts we need from tailscaled. Injected so the bridge can be
 * tested without a live tailnet — a test that needs a real tailnet is a test
 * that will rot and then be deleted.
 */
export interface TailnetVerifier {
  /** True when `tailscale serve` currently proxies an https handler to 127.0.0.1:<port>. */
  servesLocalPort(port: number): Promise<boolean>;
  /** The tailnet login owning `ip`, per `tailscale whois`. Null when unknown. */
  whoisLogin(ip: string): Promise<string | null>;
}

export type IdentityDecision =
  | { ok: true; login: string; scope: SharingScope }
  | { ok: false; reason: string };

/** Minimal request shape the gate needs. Keeps this module free of node:http. */
export interface IdentityRequestView {
  headers: Record<string, string | string[] | undefined>;
  remoteAddress: string | undefined;
}

/**
 * True for a Tailscale address: CGNAT 100.64.0.0/10 (IPv4) or the tailnet ULA
 * prefix fd7a:115c:a1e0::/48 (IPv6). Anything else is not a tailnet peer, so
 * `whois` would either fail or answer about an unrelated host — we must not ask.
 */
export function isTailnetAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase();
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (m) {
    const o1 = Number(m[1]);
    const o2 = Number(m[2]);
    // 100.64.0.0/10 → first octet 100, second octet 64..127.
    return o1 === 100 && o2 >= 64 && o2 <= 127;
  }
  return a.startsWith('fd7a:115c:a1e0:');
}

/** First hop of an X-Forwarded-For chain — the original client, per RFC 7239 usage. */
export function firstForwardedHop(xff: string | string[] | undefined): string | null {
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim() ?? '';
  if (!first) return null;
  // Strip a bracketed IPv6 form and any :port suffix on IPv4.
  if (first.startsWith('[')) return first.slice(1, first.indexOf(']') > 0 ? first.indexOf(']') : undefined);
  const parts = first.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1] ?? '')) return parts[0] ?? null;
  return first;
}

function headerValue(h: string | string[] | undefined): string {
  return (Array.isArray(h) ? h[0] : h)?.trim() ?? '';
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr;
  return a === '::1' || a.startsWith('127.');
}

/**
 * Decide whether this request may authenticate by tailnet identity.
 *
 * Returns `{ ok: false, reason }` for every rejection. The caller MUST treat a
 * rejection as "identity did not authorize" and fall through to the bearer
 * check — never as "authorize anyway".
 */
export async function authorizeTailnetIdentity(
  req: IdentityRequestView,
  cfg: TailnetIdentitySettings | undefined,
  bridgePort: number,
  verifier: TailnetVerifier,
): Promise<IdentityDecision> {
  // ── Check 1: explicitly enabled, with a non-empty allow-list ───────────────
  if (!cfg?.enabled) return { ok: false, reason: 'identity-disabled' };
  if (!Array.isArray(cfg.allowedLogins) || cfg.allowedLogins.length === 0) {
    return { ok: false, reason: 'identity-allowlist-empty' };
  }

  const claimedLogin = headerValue(req.headers['tailscale-user-login']).toLowerCase();
  if (!claimedLogin) return { ok: false, reason: 'no-identity-header' };

  // ── Check 2: the TCP peer is loopback. KERNEL TRUTH, NOT A HEADER. ─────────
  // A client dialing a 0.0.0.0-bound bridge from the LAN or the tailnet fails
  // here no matter what headers it sets. This is the load-bearing check.
  if (!isLoopback(req.remoteAddress)) {
    return { ok: false, reason: 'identity-header-from-non-loopback-peer' };
  }

  // ── Check 3: arrived through a local TLS terminator, not local-direct ──────
  const fwdProto = headerValue(req.headers['x-forwarded-proto']).split(',')[0]?.trim();
  if (fwdProto !== 'https') return { ok: false, reason: 'not-proxied-https' };
  const hop = firstForwardedHop(req.headers['x-forwarded-for']);
  if (!hop) return { ok: false, reason: 'no-forwarded-for' };

  // ── Check 5a: the claimed origin must be a tailnet address ─────────────────
  // Ordered BEFORE the serve-status call and before whois: asking tailscaled to
  // identify a public IP is both pointless and a needless out-of-band lookup on
  // an attacker-chosen value.
  if (!isTailnetAddress(hop)) return { ok: false, reason: 'forwarded-hop-not-tailnet' };

  // ── Check 4: Tailscale Serve is VERIFIED to front this exact port ──────────
  let serves = false;
  try {
    serves = await verifier.servesLocalPort(bridgePort);
  } catch {
    serves = false;
  }
  if (!serves) return { ok: false, reason: 'tailscale-serve-not-fronting-this-port' };

  // ── Check 5b: re-derive the identity out of band and require agreement ─────
  let derived: string | null = null;
  try {
    derived = await verifier.whoisLogin(hop);
  } catch {
    derived = null;
  }
  if (!derived) return { ok: false, reason: 'whois-unknown' };
  if (derived.trim().toLowerCase() !== claimedLogin) {
    return { ok: false, reason: 'whois-disagrees-with-identity-header' };
  }

  // ── Check 6: the re-derived login is on the allow-list ─────────────────────
  const grant = cfg.allowedLogins.find(
    (g) => typeof g?.login === 'string' && g.login.trim().toLowerCase() === derived.trim().toLowerCase(),
  );
  if (!grant) return { ok: false, reason: 'login-not-allowlisted' };

  // An identity session must NOT silently become owner. `owner` is deliberately
  // absent from SHARING_TOKEN_ROLES (rbac.ts:40-47) precisely because it is not
  // a mintable share; refusing it here keeps that invariant true for this new
  // grant path too, instead of inventing a second way to reach owner.
  const role = grant.scope?.role;
  if (!role || !(SHARING_TOKEN_ROLES as readonly string[]).includes(role)) {
    return { ok: false, reason: 'grant-role-not-mintable' };
  }

  return { ok: true, login: derived.trim().toLowerCase(), scope: grant.scope };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default verifier — shells out to the tailscale CLI
// ─────────────────────────────────────────────────────────────────────────────

/** Same candidate list as the tailscale-binary probe in ipc.ts — the macOS GUI
 *  app keeps its CLI off $PATH. */
const TAILSCALE_BINS = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
];

const SERVE_STATUS_CACHE_MS = 30_000;

async function runTailscale(args: string[], timeoutMs: number): Promise<string | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  for (const bin of TAILSCALE_BINS) {
    try {
      const { stdout } = await run(bin, args, { timeout: timeoutMs });
      return stdout;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * True when `proxy` (a `tailscale serve` handler target) points at loopback on
 * exactly `port`.
 *
 * Parsed, not substring-matched. `proxy.includes(':3457')` — the shape used for
 * the cosmetic URL detection in ipc.ts (the `proxy.includes(`:${uiPort}`)` /
 * `proxy.includes(`:${mcpPort}`)` pair) — also matches ':34570', which
 * is fine for picking a QR-code URL and NOT fine for an authorization check.
 */
export function proxyTargetsLocalPort(proxy: string, port: number): boolean {
  const raw = proxy.trim();
  if (!raw) return false;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!isLoopback(u.hostname) && u.hostname !== 'localhost') return false;
    const p = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    return p === port;
  } catch {
    return false;
  }
}

export function createTailscaleVerifier(): TailnetVerifier {
  let serveCache: { at: number; ports: Set<number> } | null = null;

  async function readServePorts(): Promise<Set<number>> {
    const out = await runTailscale(['serve', 'status', '--json'], 3000);
    const ports = new Set<number>();
    if (!out?.trim()) return ports;
    try {
      const status = JSON.parse(out) as {
        Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
      };
      for (const cfg of Object.values(status.Web ?? {})) {
        for (const handler of Object.values(cfg.Handlers ?? {})) {
          const proxy = handler.Proxy ?? '';
          const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`;
          try {
            const u = new URL(withScheme);
            if (isLoopback(u.hostname) || u.hostname === 'localhost') {
              ports.add(u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80));
            }
          } catch { /* unparseable handler — ignore it rather than trust it */ }
        }
      }
    } catch { /* no/!JSON serve status — treat as "no mapping", i.e. deny */ }
    return ports;
  }

  return {
    async servesLocalPort(port: number): Promise<boolean> {
      const now = Date.now();
      if (serveCache && now - serveCache.at < SERVE_STATUS_CACHE_MS) {
        if (serveCache.ports.has(port)) return true;
        // A cached miss is re-checked once before denying: the operator may
        // have just run `tailscale serve`, and making them wait out a cache
        // window would look like a broken feature.
      }
      const ports = await readServePorts();
      serveCache = { at: now, ports };
      return ports.has(port);
    },

    async whoisLogin(ip: string): Promise<string | null> {
      // Defense in depth: never hand a non-tailnet value to the CLI.
      if (!isTailnetAddress(ip)) return null;
      const out = await runTailscale(['whois', '--json', ip], 3000);
      if (!out?.trim()) return null;
      try {
        const parsed = JSON.parse(out) as { UserProfile?: { LoginName?: string } };
        const login = parsed.UserProfile?.LoginName?.trim();
        return login ? login : null;
      } catch {
        return null;
      }
    },
  };
}
