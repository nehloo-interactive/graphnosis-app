#!/usr/bin/env node
/**
 * MCP relay: byte-pipes stdio ↔ a Graphnosis MCP endpoint, with auto-reconnect.
 *
 *   Claude Desktop ── stdio ──> mcp-relay.js ── Unix socket ──> App's sidecar
 *   Claude Desktop ── stdio ──> mcp-relay.js ── HTTPS ────────> remote MCP bridge
 *
 * TWO TARGETS, ONE ARGUMENT. `process.argv[2]` is either
 *   - a Unix socket path (the original, unchanged behavior), or
 *   - an `http://` / `https://` URL of a remote Graphnosis MCP bridge.
 * No Unix path can begin with `http://`, so the discriminator is unambiguous
 * and the socket path behavior is byte-compatible with every existing config.
 *
 * NO SECRET EVER APPEARS IN ARGV (CWE-214). In URL mode the bearer token is
 * read from `$GRAPHNOSIS_STATE/remote-mcp-credentials.json` (default
 * `~/.graphnosis/remote-mcp-credentials.json`), which must be mode
 * 0600. It is NOT read from argv and NOT read from the MCP client's config
 * file, because a client config becomes a spawned process's argv — visible to
 * every process on the machine via `ps`. That is the defect this mode exists
 * to close. The deprecated `--header "Authorization: Bearer …"` / `--bearer`
 * forms are still ACCEPTED so existing setups keep working, but they warn
 * loudly and self-heal into the 0600 file.
 *
 * There is NO silent fallback to unauthenticated. A missing, unreadable, or
 * group/world-accessible credential file is a hard, specific, non-zero exit.
 *
 * The relay does no protocol parsing in steady state — it just shuffles
 * newline-delimited JSON-RPC bytes between Claude and the endpoint. The two
 * exceptions are:
 *
 *   1. It snapshots the first `initialize` request Claude sends, so it can
 *      replay it transparently to a fresh sidecar after a reconnect.
 *
 *   2. After a reconnect, it parses outbound messages from the sidecar
 *      briefly to identify and SWALLOW the response to the replayed
 *      initialize — Claude already received its init response from the
 *      original sidecar and would choke on a duplicate.
 *
 * Connect/reconnect timing:
 *   - Initial startup: waits up to $GRAPHNOSIS_RELAY_WAIT_MS (default 10s)
 *     for the socket to appear and accept a connection. Useful when Claude
 *     boots before the user unlocks the App.
 *   - Mid-session disconnect: waits up to $GRAPHNOSIS_RELAY_RECONNECT_MS
 *     (default 60s) for the App to come back. Lets users lock/unlock the
 *     cortex without restarting Claude.
 *   - If either deadline passes with no socket: relay exits → Claude shows
 *     "Server disconnected" → user must restart Claude after re-unlocking.
 *
 * PACKAGING INVARIANT — DO NOT ADD NON-BUILTIN IMPORTS, AND DO NOT SPLIT THIS
 * FILE. packages/graphnosis-mcp-relay/scripts/build.mjs:34-36 copies the
 * compiled `dist/mcp-relay.js` VERBATIM, as a single file, into an npm package
 * that declares no `dependencies`. Any sibling import or third-party import
 * would publish an unresolvable module and break `npx @graphnosis/mcp-relay`
 * silently. That is why the credential store below is inline rather than a
 * shared module.
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { existsSync, readFileSync, statSync, writeFileSync, chmodSync, renameSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// Hard-coded fallbacks. Used only when settings.json is missing or invalid
// AND no env-var override is present. Match DEFAULT_SETTINGS in app-core.
const FALLBACK_INITIAL_WAIT_MS = 10_000;
// 24h — the relay should patiently survive everyday usage patterns: lunch
// breaks, going-to-bed-with-the-app-locked, machine sleep + wake, etc. At
// ~400ms poll interval the per-day CPU cost is negligible. Old default
// (60s) meant a 1-hour stepping-away forced a Claude restart; that was
// an unforced UX loss. Users can still dial this lower in Settings.
// Infinity — the relay sits idle until the sidecar comes back, never
// gives up on its own. Cost is one parked Node process per Claude
// session ever opened (small; the loop is just `await delay(400ms)`
// in a tight retry). Users who want a finite timeout can still set
// it via the `GRAPHNOSIS_RELAY_RECONNECT_MS` env var or
// `settings.json:mcpRelay.reconnectMs`.
const FALLBACK_RECONNECT_WAIT_MS = Infinity;
const POLL_INTERVAL_MS = 400;
const PROGRESS_LOG_EVERY_MS = 3_000;

// Exit codes. 0-3 predate this change and are unmoved (3 = endpoint never
// became reachable). 4/5 are new and specific so a wrapper script — or a
// support transcript — can tell "your token is missing" from "your token
// file is world-readable" without parsing prose.
const EXIT_NO_CREDENTIAL = 4;
const EXIT_INSECURE_CREDENTIAL = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Credential store — $GRAPHNOSIS_STATE/remote-mcp-credentials.json, mode 0600
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY A FILE AND NOT AN ENV VAR: an env var is inherited by every child
// process, lands in crash reports and `/proc/<pid>/environ`, and — decisively —
// the MCP client config would still have to carry the literal value in order
// to set it. That is the same escape one hop later.
//
// WHY A MAP KEYED BY ENDPOINT AND NOT A SCALAR: one client machine legitimately
// talks to several bridges (own laptop, a team server, a collaborator's share).
// A single `mcp-bearer` file would silently send the wrong token to the wrong
// host — a cross-tenant credential leak dressed up as a convenience.
//
// The state dir is the established machine-local one, shared with
// license-seed-cache.ts and catalog-subscriptions.ts.
//
// INLINE COPY OF src/state-dir.ts — ON PURPOSE. Those two modules import the
// single shared `stateDir()`; this file cannot, because of the PACKAGING
// INVARIANT at the top: `dist/mcp-relay.js` is copied verbatim, as one
// dependency-free file, into the `@graphnosis/mcp-relay` npm package, so a
// sibling import would publish an unresolvable module. Keep the two in step —
// the behavior below is character-for-character the same contract:
//   $GRAPHNOSIS_STATE when set and non-blank (resolved to an absolute path),
//   otherwise exactly `path.join(os.homedir(), '.graphnosis')`.
//
// RESOLVED PER CALL. A module-scope `const` is what made the sidecar ignore
// GRAPHNOSIS_STATE in the first place; a memoized getter would freeze at first
// use and reproduce it. `process.env` is an object lookup — nothing to cache.
function stateDir(): string {
  const override = process.env.GRAPHNOSIS_STATE;
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), '.graphnosis');
}
function credentialFile(): string {
  return path.join(stateDir(), 'remote-mcp-credentials.json');
}

interface CredentialEntry {
  bearer: string;
  updatedAt: number;
}
interface CredentialFileV1 {
  v: 1;
  credentials: Record<string, CredentialEntry>;
}

/**
 * Canonical key for an endpoint. Lowercase scheme + host, keep port and path,
 * drop trailing slashes. `HTTPS://Host:8443/mcp/` and `https://host:8443/mcp`
 * are the same bridge and must not produce two entries.
 */
function normalizeEndpoint(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const port = u.port ? `:${u.port}` : '';
    const p = u.pathname.replace(/\/+$/, '');
    return `${u.protocol.toLowerCase()}//${u.hostname.toLowerCase()}${port}${p}`;
  } catch {
    return raw.trim().replace(/\/+$/, '');
  }
}

type CredentialFailure = {
  reason: 'missing-credential' | 'unreadable-credential' | 'insecure-credential-permissions';
  exitCode: number;
  lines: string[];
};

function isFailure(v: unknown): v is CredentialFailure {
  return typeof v === 'object' && v !== null && 'reason' in v;
}

const octal = (mode: number): string => `0${(mode & 0o777).toString(8).padStart(3, '0')}`;

/**
 * Read the bearer for `endpoint`, or describe exactly why we cannot.
 *
 * Refuses loudly on every failure mode. There is deliberately no "no
 * credential → connect anonymously" branch: an unauthenticated connection that
 * appears to work is the false-clean class this codebase has been removing.
 */
function readRemoteCredential(endpoint: string): { bearer: string } | CredentialFailure {
  const key = normalizeEndpoint(endpoint);
  // One resolution for this call — the stat, the read and every message below
  // must all name the SAME file. Fresh on every call; not cached across calls.
  const credFile = credentialFile();

  // Permission gate first: if the file is readable by group/other, its contents
  // are already compromised and we must not use them, let alone report success.
  // POSIX only — Windows has no 0600, and claiming we checked would be a lie.
  if (process.platform !== 'win32') {
    let mode: number | null = null;
    try {
      mode = statSync(credFile).mode;
    } catch {
      mode = null; // absent or unstatable — handled by the read below
    }
    // (mode & 0o077), not (mode === 0o600): 0400 is STRICTER and must pass.
    if (mode !== null && (mode & 0o077) !== 0) {
      return {
        reason: 'insecure-credential-permissions',
        exitCode: EXIT_INSECURE_CREDENTIAL,
        lines: [
          `credential file has permissions ${octal(mode)} — it must not be readable by group or other.`,
          `  file:     ${credFile}`,
          `  observed: ${octal(mode)}`,
          `  required: 0600 (or stricter)`,
          `  fix:      chmod 600 ${credFile}`,
          'refusing to use a credential other accounts on this machine can read.',
        ],
      };
    }
  } else {
    process.stderr.write(
      '[graphnosis-relay] note: file-permission check SKIPPED on Windows — ' +
      'this build did not verify that the credential file is owner-only.\n',
    );
  }

  let raw: string;
  try {
    raw = readFileSync(credFile, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        reason: 'missing-credential',
        exitCode: EXIT_NO_CREDENTIAL,
        lines: [
          `no credential file for ${key}.`,
          `  expected: ${credFile}`,
          '  fix:      run the command below on THIS machine, then paste the bearer token',
          '            and press Ctrl-D:',
          `            graphnosis-mcp-relay --set-credential ${key}`,
          '  or:       open Graphnosis → Settings → AI clients and re-apply your client;',
          '            it writes this file for you.',
          'the token is never taken from argv or from the client config — that is what',
          'made it visible to `ps` on every process on the machine.',
        ],
      };
    }
    return {
      reason: 'unreadable-credential',
      exitCode: EXIT_NO_CREDENTIAL,
      lines: [
        `credential file could not be read: ${(e as Error).message}`,
        `  file: ${credFile}`,
      ],
    };
  }

  let parsed: Partial<CredentialFileV1>;
  try {
    parsed = JSON.parse(raw) as Partial<CredentialFileV1>;
  } catch (e) {
    return {
      reason: 'unreadable-credential',
      exitCode: EXIT_NO_CREDENTIAL,
      lines: [
        `credential file is not valid JSON: ${(e as Error).message}`,
        `  file: ${credFile}`,
        `  fix:  graphnosis-mcp-relay --set-credential ${key}`,
      ],
    };
  }

  const store = (parsed.credentials ?? {}) as Record<string, Partial<CredentialEntry>>;
  const bearer = typeof store[key]?.bearer === 'string' ? store[key]!.bearer!.trim() : '';
  if (!bearer) {
    // Name the keys that ARE present. A near-miss (wrong port, http vs https,
    // trailing slash) must not read as "you have no credentials at all".
    const present = Object.keys(store);
    return {
      reason: 'missing-credential',
      exitCode: EXIT_NO_CREDENTIAL,
      lines: [
        `credential file has no entry for ${key}.`,
        `  file: ${credFile}`,
        present.length > 0
          ? `  it does have entries for: ${present.join(', ')}`
          : '  it has no entries at all.',
        `  fix:  graphnosis-mcp-relay --set-credential ${key}`,
      ],
    };
  }
  return { bearer };
}

/**
 * Write/replace the bearer for `endpoint`, 0600, tmp-then-rename.
 *
 * Mirrors license-seed-cache.ts:115-125 — including the explicit chmod, because
 * writeFile's `mode` applies only when it CREATES the file, so a pre-existing
 * tmp with looser bits would otherwise survive.
 */
function writeRemoteCredential(endpoint: string, bearer: string): void {
  const key = normalizeEndpoint(endpoint);
  // One resolution for this call: tmp and target must share a directory or the
  // rename below would cross state roots (and devices).
  const dir = stateDir();
  const credFile = path.join(dir, 'remote-mcp-credentials.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // The directory mode above is a no-op when ~/.graphnosis already exists, and
  // in practice it usually does (it is also the default cortex folder). Say so
  // rather than implying a guarantee that was not evaluated. We deliberately do
  // NOT chmod the directory: it holds the owner's documents, and silently
  // narrowing it here would break unrelated access with no visible cause.
  if (process.platform !== 'win32') {
    try {
      const dirMode = statSync(dir).mode;
      if ((dirMode & 0o077) !== 0) {
        process.stderr.write(
          `[graphnosis-relay] note: ${dir} is ${octal(dirMode)} (group/other can list it). ` +
          'The credential FILE is 0600, which is what stops another account reading the token; ' +
          `tightening the directory is optional defense in depth: chmod 700 ${dir}\n`,
        );
      }
    } catch { /* non-fatal diagnostic */ }
  }

  let existing: CredentialFileV1 = { v: 1, credentials: {} };
  try {
    const parsed = JSON.parse(readFileSync(credFile, 'utf8')) as Partial<CredentialFileV1>;
    if (parsed && typeof parsed === 'object' && parsed.credentials && typeof parsed.credentials === 'object') {
      existing = { v: 1, credentials: parsed.credentials };
    }
  } catch { /* absent or corrupt — start fresh rather than fail the write */ }

  existing.credentials[key] = { bearer: bearer.trim(), updatedAt: Date.now() };

  const tmp = `${credFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(existing, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, credFile);
  chmodSync(credFile, 0o600);
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

// Resolve the socket path. When no arg is given, default to the standard
// ~/.graphnosis/mcp.sock so callers can omit it entirely. When a path IS
// given, expand a leading `~` and `${HOME}`/`$HOME` ourselves: some MCP hosts
// spawn stdio servers without a shell and don't interpolate these — notably
// on Windows, where `HOME` is usually unset and `${HOME}` would otherwise
// reach us as a literal, unusable path. os.homedir() is cross-platform.
//
// DELIBERATELY DOES NOT FOLLOW $GRAPHNOSIS_STATE, unlike the credential store
// above. Three reasons, in order of weight:
//
//  1. IT WOULD POINT AT THE WRONG DIRECTORY. Nothing derives the socket from
//     the state dir. The listening side is main.ts:1273 —
//     `process.env.GRAPHNOSIS_MCP_SOCKET ?? path.join(env.cortexDir, 'mcp.sock')`
//     — so the server's socket tracks GRAPHNOSIS_MCP_SOCKET, else the CORTEX
//     dir. `deploy/launcher/graphnosis-server.sh` sets GRAPHNOSIS_CORTEX and
//     never sets GRAPHNOSIS_MCP_SOCKET, so on a relocated deployment the
//     server listens at `$GRAPHNOSIS_CORTEX/mcp.sock`. Making this default
//     chase $GRAPHNOSIS_STATE would aim the client at a directory where no
//     socket is ever created — it would BREAK the exact deployment it was
//     meant to fix.
//  2. THIS DEFAULT IS A PUBLISHED CONTRACT. `${HOME}/.graphnosis/mcp.sock` is
//     in the @graphnosis/mcp-relay README and in every Claude Desktop config
//     written from it. The relay runs on the CLIENT machine; an env var meant
//     for a SERVER install has no business silently moving a client's socket.
//  3. THE KNOB ALREADY EXISTS, on both ends: argv[2] here (`~`/`${HOME}`
//     expanded above), and GRAPHNOSIS_MCP_SOCKET there — which the docs
//     describe as "a fixed per-user path so an MCP client configured once
//     keeps working across cortex switches"
//     (apps/docs/.../environment-variables.md). Relocated deployments point
//     both ends at one path explicitly; that is the supported route.
function resolveSocketPath(raw: string | undefined): string {
  if (!raw || !raw.trim()) {
    return path.join(os.homedir(), '.graphnosis', 'mcp.sock');
  }
  return raw
    .trim()
    .replace(/^~(?=$|[/\\])/, os.homedir())
    .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, os.homedir());
}

const rawTarget = (process.argv[2] ?? '').trim();
const isUrlTarget = /^https?:\/\//i.test(rawTarget);
/**
 * `--set-credential` is the only subcommand. Everything else in argv[2] keeps
 * its historical meaning, so no existing config changes behavior.
 */
const isSetCredential = rawTarget === '--set-credential';
/** Unix-socket mode only. Untouched semantics; empty string otherwise. */
const socketPath: string = (isUrlTarget || isSetCredential) ? '' : resolveSocketPath(process.argv[2]);
/** URL mode only. Empty string in socket mode. */
const endpointUrl: string = isUrlTarget ? rawTarget : '';

/**
 * DEPRECATED argv forms, kept so every config written before this change keeps
 * working: `--header "Authorization: Bearer <t>"` (what the old generator and
 * the old docs emitted, via mcp-remote) and `--bearer <t>`.
 */
function parseDeprecatedBearer(argv: string[]): { value: string; flag: string } | null {
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const next = argv[i + 1];
    if (a === '--bearer' && next) return { value: next.trim(), flag: '--bearer' };
    if (a.startsWith('--bearer=')) return { value: a.slice('--bearer='.length).trim(), flag: '--bearer=' };
    if (a === '--header' && next) {
      const m = /^authorization:\s*bearer\s+(.+)$/i.exec(next.trim());
      if (m?.[1]) return { value: m[1].trim(), flag: '--header' };
    }
    if (a.startsWith('--header=')) {
      const m = /^authorization:\s*bearer\s+(.+)$/i.exec(a.slice('--header='.length).trim());
      if (m?.[1]) return { value: m[1].trim(), flag: '--header=' };
    }
  }
  return null;
}

// ── Subcommand: --set-credential <url>  (token on STDIN, never argv) ──────────
//
// Registers stdin handlers and exits from inside them. Module evaluation
// continues past this point, but the Relay is not started (see the guard at
// the bottom of the file) — so nothing else in this process touches the
// network or the socket.
function runSetCredential(target: string): void {
  if (!target || !/^https?:\/\//i.test(target)) {
    process.stderr.write(
      'usage: graphnosis-mcp-relay --set-credential <https://host.tailnet.ts.net:8443/mcp>\n' +
      '       then paste the bearer token on stdin and press Ctrl-D.\n' +
      '       (the token is read from stdin ON PURPOSE — passing it as an argument\n' +
      '        would make it readable by every process on this machine via `ps`.)\n',
    );
    process.exit(2);
  }
  let stdinBuf = '';
  process.stdin.setEncoding('utf8');
  if (process.stdin.isTTY) {
    process.stderr.write(`[graphnosis-relay] paste the bearer token for ${normalizeEndpoint(target)}, then press Ctrl-D:\n`);
  }
  process.stdin.on('data', (c: string) => { stdinBuf += c; });
  process.stdin.on('end', () => {
    const token = stdinBuf.trim();
    if (!token) {
      process.stderr.write('[graphnosis-relay] no token on stdin — nothing written.\n');
      process.exit(2);
    }
    try {
      writeRemoteCredential(target, token);
    } catch (e) {
      process.stderr.write(`[graphnosis-relay] could not write ${credentialFile()}: ${(e as Error).message}\n`);
      process.exit(1);
    }
    // Length only. Never echo the token, not even a prefix.
    process.stderr.write(
      `[graphnosis-relay] stored credential (length ${token.length}) for ${normalizeEndpoint(target)}\n` +
      `[graphnosis-relay] file: ${credentialFile()} (mode 0600)\n`,
    );
    process.exit(0);
  });
}
if (isSetCredential) runSetCredential((process.argv[3] ?? '').trim());

// ─────────────────────────────────────────────────────────────────────────────
// Timings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the relay timings, preferring (in order):
 *   1. Env vars — power-user override for the rare debug session.
 *   2. <cortex>/settings.json — what the user picked in the App's Settings UI.
 *   3. Hard-coded fallbacks.
 * The settings file is the same one the sidecar reads; we share the shape.
 *
 * URL mode SKIPS the settings read entirely: the cortex lives on the other
 * machine, so there is no local settings.json to consult, and deriving a
 * directory from a URL to read a config out of would be a fabricated source.
 */
function resolveTimings(): { initialWaitMs: number; reconnectMs: number } {
  let initialWaitMs = FALLBACK_INITIAL_WAIT_MS;
  let reconnectMs = FALLBACK_RECONNECT_WAIT_MS;
  if (!isUrlTarget && !isSetCredential) {
    // The cortex dir is the directory containing the socket file.
    const cortexDir = path.dirname(socketPath);
    try {
      const raw = readFileSync(path.join(cortexDir, 'settings.json'), 'utf8');
      const parsed = JSON.parse(raw) as { mcpRelay?: { initialWaitMs?: number; reconnectMs?: number } };
      if (typeof parsed.mcpRelay?.initialWaitMs === 'number') initialWaitMs = parsed.mcpRelay.initialWaitMs;
      if (typeof parsed.mcpRelay?.reconnectMs === 'number') reconnectMs = parsed.mcpRelay.reconnectMs;
    } catch { /* missing or invalid — keep fallbacks */ }
  }
  // Env vars trump settings.json.
  if (process.env.GRAPHNOSIS_RELAY_WAIT_MS) {
    initialWaitMs = parseInt(process.env.GRAPHNOSIS_RELAY_WAIT_MS, 10) || initialWaitMs;
  }
  if (process.env.GRAPHNOSIS_RELAY_RECONNECT_MS) {
    reconnectMs = parseInt(process.env.GRAPHNOSIS_RELAY_RECONNECT_MS, 10) || reconnectMs;
  }
  return { initialWaitMs, reconnectMs };
}

const { initialWaitMs, reconnectMs: reconnectWaitMs } = resolveTimings();
const fmtBudget = (ms: number): string => Number.isFinite(ms) ? `${Math.round(ms / 1000)}s` : 'unbounded';
if (!isSetCredential) {
  process.stderr.write(
    `[graphnosis-relay] timings: initial=${fmtBudget(initialWaitMs)}, ` +
    `reconnect=${fmtBudget(reconnectWaitMs)}\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Transports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the Relay needs from an endpoint. Everything protocol-shaped —
 * initialize snapshot/replay, id suppression, fast-fail, notification
 * buffering — stays in `Relay` and is transport-agnostic.
 */
interface Transport {
  connect(isReconnect: boolean): Promise<void>;
  write(line: string): void;
  writable(): boolean;
  waitReachable(budgetMs: number): Promise<boolean>;
  /** Non-null when a failure is terminal (bad credential) and retrying is pointless. */
  fatal(): { lines: string[]; exitCode: number } | null;
  close(): void;
  describe(): string;
}

/**
 * Unix-socket transport — a verbatim move of the original connect / probe /
 * wait logic. No behavior change: same `net.createConnection`, same probe
 * cadence, same log strings.
 */
class UnixSocketTransport implements Transport {
  private socket: net.Socket | null = null;
  constructor(
    private readonly onData: (text: string) => void,
    private readonly onClose: () => void,
  ) {}

  describe(): string { return socketPath; }
  fatal(): null { return null; }

  async connect(_isReconnect: boolean): Promise<void> {
    this.socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('connect', () => resolve());
      this.socket!.once('error', (err) => reject(err));
    });
    this.socket.on('data', (chunk: Buffer | string) => {
      this.onData(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    this.socket.once('end', () => this.onClose());
    this.socket.once('close', () => this.onClose());
    this.socket.on('error', (err) => {
      // 'error' arrives separately from 'end'/'close'; the disconnect
      // handler is idempotent so an extra trigger is fine.
      process.stderr.write(`[graphnosis-relay] socket error: ${err.message}\n`);
    });
  }

  write(line: string): void { this.socket?.write(line); }
  writable(): boolean { return !!this.socket && this.socket.writable; }
  close(): void { this.socket?.end(); }

  /**
   * Liveness probe — `existsSync` isn't enough because a stale socket file can
   * outlive its listener (sidecar SIGKILLed, crashed mid-startup, race between
   * fs.rm and listen()).
   */
  private tryConnect(): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = net.createConnection(socketPath);
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        probe.destroy();
        resolve(ok);
      };
      probe.once('connect', () => finish(true));
      probe.once('error', () => finish(false));
    });
  }

  async waitReachable(waitMs: number): Promise<boolean> {
    const started = Date.now();
    let lastLog = -PROGRESS_LOG_EVERY_MS;
    while (Date.now() - started < waitMs) {
      if (await this.tryConnect()) return true;
      const elapsed = Date.now() - started;
      if (elapsed - lastLog >= PROGRESS_LOG_EVERY_MS) {
        process.stderr.write(
          `[graphnosis-relay] socket ${socketPath} not ready — ` +
          `still waiting (${Math.round(elapsed / 1000)}s elapsed, ${Number.isFinite(waitMs) ? `${Math.round(waitMs / 1000)}s budget` : 'no budget'})\n`,
        );
        lastLog = elapsed;
      }
      await delay(POLL_INTERVAL_MS);
    }
    return false;
  }
}

/**
 * Streamable-HTTP transport for a remote Graphnosis MCP bridge.
 *
 * Implements the server contract in mcp-http-server.ts directly against
 * node:https / node:http — see the packaging invariant at the top of this file
 * for why we cannot import the MCP SDK's client transport here.
 *
 *   POST   <url>            JSON-RPC in, JSON or SSE out; the first response
 *                           carries `Mcp-Session-Id` (mcp-http-server.ts:749-758)
 *   GET    <url>            re-join the SSE stream with that header (:688-703)
 *   DELETE <url>            terminate the session (:706-718)
 */
class HttpTransport implements Transport {
  private readonly url: URL;
  private readonly agentMod: typeof http | typeof https;
  private bearer = '';
  private sessionId: string | null = null;
  private healthy = false;
  private closed = false;
  private fatalState: { lines: string[]; exitCode: number } | null = null;
  private stream: http.IncomingMessage | null = null;
  /**
   * Gate that holds messages 2..n until the FIRST POST has produced a session
   * id, so they cannot race ahead and be rejected as session-less.
   *
   * It is released on the response HEADERS (where `Mcp-Session-Id` arrives), not
   * on the response body ending — an initialize answered with a long-lived SSE
   * stream would otherwise block every later message for as long as that stream
   * stayed open.
   */
  private sessionReady: Promise<void> | null = null;
  private releaseSessionReady: (() => void) | null = null;

  constructor(
    private readonly onData: (text: string) => void,
    private readonly onClose: () => void,
  ) {
    this.url = new URL(endpointUrl);
    this.agentMod = this.url.protocol === 'http:' ? http : https;
  }

  describe(): string { return this.url.toString(); }
  fatal(): { lines: string[]; exitCode: number } | null { return this.fatalState; }

  /**
   * Load the bearer from the 0600 file. Any failure is terminal and specific —
   * never a fallback to an unauthenticated connection.
   */
  private loadCredential(): boolean {
    if (this.bearer) return true;
    const got = readRemoteCredential(this.url.toString());
    if (isFailure(got)) {
      this.fatalState = { lines: got.lines, exitCode: got.exitCode };
      return false;
    }
    this.bearer = got.bearer;
    return true;
  }

  /** Adopt a token supplied via the deprecated argv flags, and persist it 0600. */
  adoptDeprecatedBearer(value: string, flag: string): void {
    this.bearer = value;
    process.stderr.write(
      `[graphnosis-relay] ⚠️  DEPRECATED: the bearer token was passed on the command line (${flag}).\n` +
      '[graphnosis-relay] ⚠️  A process argument is world-readable — every process on this machine\n' +
      '[graphnosis-relay] ⚠️  can read it with `ps aux` (CWE-214: Invocation of Process Using\n' +
      '[graphnosis-relay] ⚠️  Visible Sensitive Information). TREAT THIS TOKEN AS EXPOSED and\n' +
      '[graphnosis-relay] ⚠️  rotate it in Graphnosis → Settings → Mobile & Remote → MCP access.\n',
    );
    try {
      writeRemoteCredential(this.url.toString(), value);
      process.stderr.write(
        `[graphnosis-relay] saved it to ${credentialFile()} (mode 0600). Re-apply this client from\n` +
        '[graphnosis-relay] Graphnosis → Settings → AI clients, or delete the flag by hand — the\n' +
        `[graphnosis-relay] relay now finds the token without it: graphnosis-mcp-relay ${normalizeEndpoint(endpointUrl)}\n`,
      );
    } catch (e) {
      process.stderr.write(
        `[graphnosis-relay] could not save it to ${credentialFile()}: ${(e as Error).message} — ` +
        'continuing with the command-line value for this session only.\n',
      );
    }
  }

  async connect(isReconnect: boolean): Promise<void> {
    if (!this.loadCredential()) throw new Error(this.fatalState?.lines[0] ?? 'no credential');
    // A reconnect means the far side very likely restarted; its session table
    // is empty. Drop our id so the replayed initialize mints a fresh session
    // instead of 404-ing forever against a session that no longer exists.
    if (isReconnect) {
      this.sessionId = null;
      this.releaseGate();       // free anything still queued behind the old gate
      this.sessionReady = null; // the replayed initialize opens a fresh one
      this.stream?.destroy();
      this.stream = null;
    }
    this.healthy = true;
    this.closed = false;
  }

  writable(): boolean { return this.healthy && !this.closed; }

  private openSessionGate(): void {
    if (this.sessionReady) return;
    this.sessionReady = new Promise<void>((resolve) => { this.releaseSessionReady = resolve; });
  }

  /** Let queued messages through. Idempotent; safe to call when nothing waits. */
  private releaseGate(): void {
    const release = this.releaseSessionReady;
    this.releaseSessionReady = null;
    if (release) release();
  }

  write(line: string): void {
    const body = line.endsWith('\n') ? line : `${line}\n`;
    if (this.sessionId) {
      void this.post(body);
      return;
    }
    if (!this.sessionReady) {
      // First message of the session (the initialize). Everything after it
      // waits behind the gate until this request's headers come back.
      this.openSessionGate();
      void this.post(body).finally(() => this.releaseGate());
      return;
    }
    void this.sessionReady.then(() => this.post(body));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearer}`,
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      ...extra,
    };
  }

  private post(body: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const req = this.agentMod.request(
        this.url,
        {
          method: 'POST',
          headers: this.headers({
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Content-Length': String(Buffer.byteLength(body)),
          }),
        },
        (res) => {
          const sid = res.headers['mcp-session-id'];
          if (typeof sid === 'string' && sid && !this.sessionId) {
            this.sessionId = sid;
            // Release on HEADERS, not on body end — see `sessionReady`.
            this.releaseGate();
            this.openStream();
          }
          const status = res.statusCode ?? 0;

          if (status === 401 || status === 403) {
            res.resume();
            this.healthy = false;
            this.fatalState = {
              exitCode: EXIT_NO_CREDENTIAL,
              lines: [
                `the bridge rejected our credential (HTTP ${status}) for ${this.url.toString()}.`,
                `  file: ${credentialFile()}`,
                '  the stored token is wrong, revoked, or belongs to a different bridge.',
                `  fix:  graphnosis-mcp-relay --set-credential ${normalizeEndpoint(endpointUrl)}`,
              ],
            };
            process.stderr.write(
              `[graphnosis-relay] ${this.fatalState.lines.join('\n[graphnosis-relay] ')}\n`,
            );
            resolve();
            this.onClose();
            return;
          }
          if (status === 404 && this.sessionId) {
            // Session gone (bridge restarted). Force a reconnect + replay.
            res.resume();
            this.sessionId = null;
            this.healthy = false;
            resolve();
            this.onClose();
            return;
          }
          if (status === 202 || status === 204) { res.resume(); resolve(); return; }

          const ctype = String(res.headers['content-type'] ?? '');
          if (ctype.includes('text/event-stream')) {
            this.consumeSse(res, () => resolve());
            return;
          }
          let buf = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => { buf += c; });
          res.on('end', () => {
            const t = buf.trim();
            if (t) this.emitJsonRpc(t);
            resolve();
          });
          res.on('error', () => resolve());
        },
      );
      req.on('error', (err) => {
        process.stderr.write(`[graphnosis-relay] request error: ${err.message}\n`);
        this.healthy = false;
        resolve();
        this.onClose();
      });
      req.end(body);
    });
  }

  /** Long-lived GET stream for server→client messages (notifications, etc.). */
  private openStream(): void {
    if (this.stream || this.closed || !this.sessionId) return;
    const req = this.agentMod.request(
      this.url,
      { method: 'GET', headers: this.headers({ Accept: 'text/event-stream' }) },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) { res.resume(); return; }
        this.stream = res;
        this.consumeSse(res, () => {
          this.stream = null;
          if (!this.closed && this.healthy) {
            // The bridge dropped the notification stream. Treat as a
            // disconnect so the Relay's reconnect+replay path runs.
            this.healthy = false;
            this.onClose();
          }
        });
      },
    );
    // A failed GET stream is not fatal on its own — request/response still
    // works over POST. Log and carry on.
    req.on('error', (err) => {
      process.stderr.write(`[graphnosis-relay] event stream error: ${err.message}\n`);
    });
    req.end();
  }

  /** Minimal SSE frame reader: accumulate `data:` lines, flush on a blank line. */
  private consumeSse(res: http.IncomingMessage, onEnd: () => void): void {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk.replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data.trim()) this.emitJsonRpc(data.trim());
      }
    });
    res.on('end', onEnd);
    res.on('error', onEnd);
  }

  /**
   * Hand one JSON-RPC payload to the Relay as a single newline-terminated line.
   * A JSON body may be pretty-printed or a batch array; stdio framing is
   * one message per line, so re-serialize compactly and split batches.
   */
  private emitJsonRpc(payload: string): void {
    try {
      const parsed: unknown = JSON.parse(payload);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) this.onData(`${JSON.stringify(item)}\n`);
    } catch {
      this.onData(`${payload.replace(/\n/g, ' ')}\n`);
    }
  }

  /**
   * Reachability + authorization probe. A bare GET without a session id returns
   * 400 from an authorized bridge (mcp-http-server.ts:689-692) and 401 from an
   * unauthorized one — so one cheap request distinguishes "server not up yet"
   * (retry) from "your token is wrong" (stop). A 401 must NOT consume the
   * reconnect budget: waiting 24h on a credential error is a false-clean.
   */
  async waitReachable(waitMs: number): Promise<boolean> {
    if (!this.loadCredential()) return false;
    const started = Date.now();
    let lastLog = -PROGRESS_LOG_EVERY_MS;
    for (;;) {
      const r = await this.probe();
      if (r === 'ok') return true;
      if (r === 'unauthorized') return false; // fatalState already set
      if (Date.now() - started >= waitMs) return false;
      const elapsed = Date.now() - started;
      if (elapsed - lastLog >= PROGRESS_LOG_EVERY_MS) {
        process.stderr.write(
          `[graphnosis-relay] endpoint ${this.url.toString()} not reachable — ` +
          `still waiting (${Math.round(elapsed / 1000)}s elapsed, ${Number.isFinite(waitMs) ? `${Math.round(waitMs / 1000)}s budget` : 'no budget'})\n`,
        );
        lastLog = elapsed;
      }
      await delay(POLL_INTERVAL_MS);
    }
  }

  private probe(): Promise<'ok' | 'unauthorized' | 'unreachable'> {
    return new Promise((resolve) => {
      const req = this.agentMod.request(
        this.url,
        { method: 'GET', headers: { Authorization: `Bearer ${this.bearer}`, Accept: 'text/event-stream' }, timeout: 8000 },
        (res) => {
          const status = res.statusCode ?? 0;
          res.resume();
          if (status === 401 || status === 403) {
            this.fatalState = {
              exitCode: EXIT_NO_CREDENTIAL,
              lines: [
                `the bridge at ${this.url.toString()} rejected our credential (HTTP ${status}).`,
                `  file: ${credentialFile()}`,
                '  the stored token is wrong, revoked, or belongs to a different bridge.',
                `  fix:  graphnosis-mcp-relay --set-credential ${normalizeEndpoint(endpointUrl)}`,
              ],
            };
            resolve('unauthorized');
            return;
          }
          // 400 "Mcp-Session-Id header required for GET" is the authorized
          // answer to a session-less GET. Anything < 500 means the bridge is
          // answering, which is what "reachable" means here.
          resolve(status > 0 && status < 500 ? 'ok' : 'unreachable');
        },
      );
      req.on('timeout', () => { req.destroy(); resolve('unreachable'); });
      req.on('error', () => resolve('unreachable'));
      req.end();
    });
  }

  close(): void {
    this.closed = true;
    this.healthy = false;
    this.stream?.destroy();
    if (!this.sessionId) return;
    const req = this.agentMod.request(this.url, { method: 'DELETE', headers: this.headers() }, (res) => res.resume());
    req.on('error', () => { /* best-effort teardown */ });
    req.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Relay
// ─────────────────────────────────────────────────────────────────────────────

class Relay {
  /** Endpoint transport (Unix socket or HTTPS). */
  private transport: Transport;
  /** First `initialize` line Claude sent us — used to re-init a fresh sidecar. */
  private initLine: string | null = null;
  /** Newline-buffered stdin from Claude (in case a chunk arrives split). */
  private stdinBuf = '';
  /**
   * Outbound messages from Claude that arrived while the sidecar was down.
   * Flushed on reconnect in order, preserving framing.
   */
  private pendingOutbound: string[] = [];
  /**
   * When non-null, we're parsing inbound sidecar lines and dropping the one
   * whose `id` matches — that's our replayed initialize, Claude shouldn't
   * see it. After we filter it, we switch back to fast-path passthrough.
   */
  private suppressInboundId: string | null = null;
  /** Newline buffer used only during the suppress phase. */
  private inboundLineBuf = '';
  private shuttingDown = false;
  private connected = false;
  private reconnecting = false;

  constructor() {
    const onData = (text: string): void => this.onEndpointData(text);
    const onClose = (): void => void this.onEndpointDisconnect();
    if (isUrlTarget) {
      const http2 = new HttpTransport(onData, onClose);
      const dep = parseDeprecatedBearer(process.argv);
      if (dep) http2.adoptDeprecatedBearer(dep.value, dep.flag);
      this.transport = http2;
    } else {
      this.transport = new UnixSocketTransport(onData, onClose);
    }
  }

  /** Print a terminal credential failure and exit with its specific code. */
  private exitFatal(): never {
    const f = this.transport.fatal();
    if (f) {
      for (const line of f.lines) process.stderr.write(`[graphnosis-relay] ${line}\n`);
      process.exit(f.exitCode);
    }
    process.exit(3);
  }

  async run(): Promise<void> {
    const ok = await this.transport.waitReachable(initialWaitMs);
    if (!ok) {
      if (this.transport.fatal()) this.exitFatal();
      if (isUrlTarget) {
        process.stderr.write(
          `[graphnosis-relay] timed out after ${Math.round(initialWaitMs / 1000)}s — ` +
          `${endpointUrl} did not answer.\n`,
        );
        process.stderr.write(
          '[graphnosis-relay] check that the cortex is unlocked on the server, that its MCP ' +
          'bridge is enabled (Settings → Mobile & Remote → MCP access), and that this machine ' +
          'can reach that host (for the Tailscale setup: `tailscale status`).\n',
        );
        process.exit(3);
      }
      // Distinguish the two failures that look identical from here. A socket
      // FILE that exists while nothing accepts on it means a sidecar served
      // this path at some point and no longer does — overwhelmingly because
      // the app is attached to a REMOTE cortex, where it deliberately spawns
      // no local sidecar. Telling that user to "unlock the app" sends them to
      // look at an app that is already unlocked and working.
      let staleSocketFile = false;
      try {
        staleSocketFile = existsSync(socketPath);
      } catch { /* treat as absent */ }

      process.stderr.write(
        `[graphnosis-relay] timed out after ${Math.round(initialWaitMs / 1000)}s — ` +
        `nothing is serving ${socketPath}.\n`,
      );
      process.stderr.write(
        staleSocketFile
          ? '[graphnosis-relay] the socket file exists but no sidecar is accepting on it. ' +
            'If Graphnosis is connected to a REMOTE cortex it serves no local socket, and this ' +
            'client cannot use the relay — point it at the remote bridge instead ' +
            '(Settings → AI clients will write that config for you).\n'
          : '[graphnosis-relay] no socket file. Open and unlock Graphnosis on this machine, ' +
            'then restart this MCP client.\n',
      );
      process.exit(3);
    }
    await this.connect(false);

    process.stdin.on('data', (chunk) => this.onStdinData(chunk));
    process.stdin.on('end', () => {
      this.shuttingDown = true;
      this.transport.close();
      process.exit(0);
    });
  }

  private async connect(isReconnect: boolean): Promise<void> {
    await this.transport.connect(isReconnect);
    this.connected = true;
    process.stderr.write(
      isReconnect
        ? `[graphnosis-relay] reconnected to ${this.transport.describe()}\n`
        : `[graphnosis-relay] connected to ${this.transport.describe()}\n`,
    );

    // On reconnect: replay Claude's original initialize so the fresh sidecar
    // recognizes this as a known session. We rewrite its `id` to a unique
    // marker so we can intercept the response and avoid sending Claude a
    // duplicate.
    if (isReconnect && this.initLine) {
      try {
        const orig = JSON.parse(this.initLine.trim()) as { method?: string; params?: unknown };
        const replayId = `__graphnosis_relay_replay_${Date.now()}__`;
        const replay = JSON.stringify({
          jsonrpc: '2.0',
          id: replayId,
          method: 'initialize',
          params: orig.params,
        }) + '\n';
        this.suppressInboundId = replayId;
        this.transport.write(replay);
      } catch (e) {
        process.stderr.write(`[graphnosis-relay] could not replay initialize: ${(e as Error).message}\n`);
      }
    }

    // Flush anything Claude sent us while we were reconnecting.
    if (this.pendingOutbound.length > 0) {
      for (const line of this.pendingOutbound) {
        this.transport.write(line);
      }
      this.pendingOutbound = [];
    }
  }

  private onStdinData(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.stdinBuf += text;
    let idx: number;
    while ((idx = this.stdinBuf.indexOf('\n')) !== -1) {
      const line = this.stdinBuf.slice(0, idx + 1);
      this.stdinBuf = this.stdinBuf.slice(idx + 1);

      // Capture the original initialize for later replay. Only the first one;
      // Claude sends it exactly once per session.
      if (this.initLine === null) {
        try {
          const msg = JSON.parse(line.trim()) as { method?: string };
          if (msg.method === 'initialize') this.initLine = line;
        } catch { /* not JSON; ignore */ }
      }

      if (this.transport.writable()) {
        this.transport.write(line);
      } else {
        // Endpoint is down (cortex locked, restart, crash, network gone). If
        // this line is a JSON-RPC REQUEST (has an `id`), respond immediately
        // with an error so Claude doesn't sit waiting forever. NOTIFICATIONS
        // (no `id`) we keep buffering for replay on reconnect — notifications
        // don't expect a response, and dropping them silently is fine for
        // short outages.
        //
        // Without this, locking Graphnosis mid-conversation makes the next
        // tool call hang for up to reconnectWaitMs (default 24h) — terrible
        // UX. Fast-fail lets the user re-issue after unlocking.
        let requestId: string | number | undefined;
        let methodName: string | undefined;
        try {
          const msg = JSON.parse(line.trim()) as { id?: unknown; method?: unknown };
          if (typeof msg.id === 'string' || typeof msg.id === 'number') requestId = msg.id;
          if (typeof msg.method === 'string') methodName = msg.method;
        } catch { /* not JSON — keep buffering as a notification analog */ }

        if (requestId !== undefined) {
          const fatal = this.transport.fatal();
          // JSON-RPC error code -32000 is the convention for server-side errors.
          const errorReply = JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            error: fatal
              ? {
                  code: -32000,
                  message:
                    `Graphnosis cannot authenticate to ${endpointUrl}. ` +
                    fatal.lines.join(' '),
                  data: { reason: 'remote-credential', method: methodName },
                }
              : isUrlTarget
                ? {
                    code: -32000,
                    message:
                      `Graphnosis is not reachable at ${endpointUrl}. Check that the cortex is ` +
                      'unlocked on that machine and its MCP bridge is running, then ask me to ' +
                      'retry the previous step.',
                    data: { reason: 'remote-unreachable', method: methodName },
                  }
                : {
                    code: -32000,
                    message:
                      'Graphnosis is locked. Open the Graphnosis app and unlock your cortex, ' +
                      'then ask me to retry the previous step.',
                    data: { reason: 'cortex-locked', method: methodName },
                  },
          }) + '\n';
          process.stdout.write(errorReply);
          process.stderr.write(
            `[graphnosis-relay] fast-failed request id=${String(requestId)} method=${String(methodName)} — sidecar is not connected\n`,
          );
        } else {
          // Notification — buffer for replay on reconnect.
          this.pendingOutbound.push(line);
        }
      }
    }
  }

  private onEndpointData(text: string): void {
    if (this.suppressInboundId === null) {
      // Fast path: byte-for-byte passthrough.
      process.stdout.write(text);
      return;
    }

    // Suppress path: parse lines, drop the one whose id matches our replay.
    this.inboundLineBuf += text;
    let idx: number;
    while ((idx = this.inboundLineBuf.indexOf('\n')) !== -1) {
      const line = this.inboundLineBuf.slice(0, idx + 1);
      this.inboundLineBuf = this.inboundLineBuf.slice(idx + 1);
      let matched = false;
      try {
        const msg = JSON.parse(line.trim()) as { id?: unknown };
        if (msg.id === this.suppressInboundId) {
          matched = true;
          this.suppressInboundId = null;
        }
      } catch { /* not JSON or partial — pass it through */ }
      if (!matched) {
        process.stdout.write(line);
      }
      if (this.suppressInboundId === null) {
        // We're done filtering; switch back to fast path. Flush whatever
        // remains in the buffer as raw passthrough.
        if (this.inboundLineBuf) {
          process.stdout.write(this.inboundLineBuf);
          this.inboundLineBuf = '';
        }
        break;
      }
    }
  }

  private async onEndpointDisconnect(): Promise<void> {
    if (!this.connected || this.shuttingDown || this.reconnecting) return;
    this.reconnecting = true;
    this.connected = false;

    // A credential failure is terminal — retrying for 24h with a token the
    // bridge already rejected would look like a network problem and hide the
    // real one.
    if (this.transport.fatal()) this.exitFatal();

    process.stderr.write(
      `[graphnosis-relay] sidecar disconnected — keeping Claude attached and ` +
      `waiting ${Number.isFinite(reconnectWaitMs) ? `up to ${Math.round(reconnectWaitMs / 1000)}s` : 'indefinitely'} for the App to come back…\n`,
    );

    const ok = await this.transport.waitReachable(reconnectWaitMs);
    if (!ok) {
      if (this.transport.fatal()) this.exitFatal();
      process.stderr.write(
        `[graphnosis-relay] reconnect timed out. Closing the pipe — Claude will ` +
        `mark Graphnosis as disconnected.\n`,
      );
      process.stdout.end();
      process.exit(0);
    }

    try {
      await this.connect(true);
      this.reconnecting = false;
    } catch (e) {
      process.stderr.write(`[graphnosis-relay] reconnect failed: ${(e as Error).message}\n`);
      process.stdout.end();
      process.exit(0);
    }
  }
}

if (!isSetCredential) {
  void new Relay().run().catch((e) => {
    process.stderr.write(`[graphnosis-relay] fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
