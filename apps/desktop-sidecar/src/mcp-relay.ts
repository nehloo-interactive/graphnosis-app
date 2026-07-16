#!/usr/bin/env node
/**
 * MCP relay: byte-pipes stdio ↔ Unix socket, with auto-reconnect.
 *
 *   Claude Desktop ── stdio ──> mcp-relay.js ── Unix socket ──> App's sidecar
 *
 * The relay does no protocol parsing in steady state — it just shuffles
 * newline-delimited JSON-RPC bytes between Claude and the sidecar. The two
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
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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

// Resolve the socket path. When no arg is given, default to the standard
// ~/.graphnosis/mcp.sock so callers can omit it entirely. When a path IS
// given, expand a leading `~` and `${HOME}`/`$HOME` ourselves: some MCP hosts
// spawn stdio servers without a shell and don't interpolate these — notably
// on Windows, where `HOME` is usually unset and `${HOME}` would otherwise
// reach us as a literal, unusable path. os.homedir() is cross-platform.
function resolveSocketPath(raw: string | undefined): string {
  if (!raw || !raw.trim()) {
    return path.join(os.homedir(), '.graphnosis', 'mcp.sock');
  }
  return raw
    .trim()
    .replace(/^~(?=$|[/\\])/, os.homedir())
    .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, os.homedir());
}
const socketPath: string = resolveSocketPath(process.argv[2]);

/**
 * Resolve the relay timings, preferring (in order):
 *   1. Env vars — power-user override for the rare debug session.
 *   2. <cortex>/settings.json — what the user picked in the App's Settings UI.
 *   3. Hard-coded fallbacks.
 * The settings file is the same one the sidecar reads; we share the shape.
 */
function resolveTimings(): { initialWaitMs: number; reconnectMs: number } {
  let initialWaitMs = FALLBACK_INITIAL_WAIT_MS;
  let reconnectMs = FALLBACK_RECONNECT_WAIT_MS;
  // The cortex dir is the directory containing the socket file.
  const cortexDir = path.dirname(socketPath);
  try {
    const raw = readFileSync(path.join(cortexDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as { mcpRelay?: { initialWaitMs?: number; reconnectMs?: number } };
    if (typeof parsed.mcpRelay?.initialWaitMs === 'number') initialWaitMs = parsed.mcpRelay.initialWaitMs;
    if (typeof parsed.mcpRelay?.reconnectMs === 'number') reconnectMs = parsed.mcpRelay.reconnectMs;
  } catch { /* missing or invalid — keep fallbacks */ }
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
process.stderr.write(
  `[graphnosis-relay] timings: initial=${fmtBudget(initialWaitMs)}, ` +
  `reconnect=${fmtBudget(reconnectWaitMs)}\n`,
);

class Relay {
  /** Live socket to the sidecar, or null while we're reconnecting. */
  private socket: net.Socket | null = null;
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

  async run(): Promise<void> {
    const ok = await waitForSocket(initialWaitMs);
    if (!ok) {
      process.stderr.write(
        `[graphnosis-relay] timed out after ${Math.round(initialWaitMs / 1000)}s — ` +
        `socket ${socketPath} never appeared. Unlock the Graphnosis App, then restart this MCP client.\n`,
      );
      process.exit(3);
    }
    await this.connect(false);

    process.stdin.on('data', (chunk) => this.onStdinData(chunk));
    process.stdin.on('end', () => {
      this.shuttingDown = true;
      this.socket?.end();
      process.exit(0);
    });
  }

  private async connect(isReconnect: boolean): Promise<void> {
    this.socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      this.socket!.once('connect', () => resolve());
      this.socket!.once('error', (err) => reject(err));
    });
    process.stderr.write(
      isReconnect
        ? `[graphnosis-relay] reconnected to ${socketPath}\n`
        : `[graphnosis-relay] connected to ${socketPath}\n`,
    );

    this.socket.on('data', (chunk) => this.onSocketData(chunk));
    this.socket.once('end', () => void this.onSocketDisconnect());
    this.socket.once('close', () => void this.onSocketDisconnect());
    this.socket.on('error', (err) => {
      // 'error' arrives separately from 'end'/'close'; the disconnect
      // handler is idempotent so an extra trigger is fine.
      process.stderr.write(`[graphnosis-relay] socket error: ${err.message}\n`);
    });

    // On reconnect: replay Claude's original initialize so the fresh sidecar
    // recognises this as a known session. We rewrite its `id` to a unique
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
        this.socket.write(replay);
      } catch (e) {
        process.stderr.write(`[graphnosis-relay] could not replay initialize: ${(e as Error).message}\n`);
      }
    }

    // Flush anything Claude sent us while we were reconnecting.
    if (this.pendingOutbound.length > 0) {
      for (const line of this.pendingOutbound) {
        this.socket.write(line);
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

      if (this.socket && this.socket.writable) {
        this.socket.write(line);
      } else {
        // Sidecar is down (cortex locked, restart, crash). If this line is a
        // JSON-RPC REQUEST (has an `id`), respond immediately with an error so
        // Claude doesn't sit waiting forever. NOTIFICATIONS (no `id`) we keep
        // buffering for replay on reconnect — notifications don't expect a
        // response, and dropping them silently is fine for short outages.
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
          // JSON-RPC error code -32000 is the convention for server-side errors.
          const errorReply = JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            error: {
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

  private onSocketData(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

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

  private async onSocketDisconnect(): Promise<void> {
    if (!this.socket || this.shuttingDown) return;
    const dead = this.socket;
    this.socket = null;
    dead.destroy();

    process.stderr.write(
      `[graphnosis-relay] sidecar disconnected — keeping Claude attached and ` +
      `waiting ${Number.isFinite(reconnectWaitMs) ? `up to ${Math.round(reconnectWaitMs / 1000)}s` : 'indefinitely'} for the App to come back…\n`,
    );

    const ok = await waitForSocket(reconnectWaitMs);
    if (!ok) {
      process.stderr.write(
        `[graphnosis-relay] reconnect timed out. Closing the pipe — Claude will ` +
        `mark Graphnosis as disconnected.\n`,
      );
      process.stdout.end();
      process.exit(0);
    }

    try {
      await this.connect(true);
    } catch (e) {
      process.stderr.write(`[graphnosis-relay] reconnect failed: ${(e as Error).message}\n`);
      process.stdout.end();
      process.exit(0);
    }
  }
}

/**
 * Liveness probe — `existsSync` isn't enough because a stale socket file can
 * outlive its listener (sidecar SIGKILLed, crashed mid-startup, race between
 * fs.rm and listen()).
 */
function tryConnect(): Promise<boolean> {
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

async function waitForSocket(waitMs: number): Promise<boolean> {
  const started = Date.now();
  let lastLog = -PROGRESS_LOG_EVERY_MS;
  while (Date.now() - started < waitMs) {
    if (await tryConnect()) return true;
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

void new Relay().run().catch((e) => {
  process.stderr.write(`[graphnosis-relay] fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
