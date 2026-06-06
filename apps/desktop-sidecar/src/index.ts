#!/usr/bin/env node
// MUST be first: tsyringe (pulled transitively by @simplewebauthn/server →
// @peculiar/x509, used for WebAuthn) requires the reflect-metadata polyfill to
// be loaded at the entry point, or it throws at module-init. The Bun-compiled
// binary evaluates this eagerly at startup, so it must precede every other
// import (including the deferred dynamic imports below).
import 'reflect-metadata';

// Quiet routine operational chatter (per-operation host/brain/connector logs)
// unless GRAPHNOSIS_DEBUG is set. These are debug noise, not user-facing signal.
// The filter is an ALLOWLIST of known-benign informational patterns: only lines
// matching NOISY are dropped, so no real error or warning is ever suppressed.
// We wrap console.error/warn too (not just log/info) because dbg() — which emits
// most of this chatter — writes to stderr (it must: the MCP stdio transport owns
// stdout). Without wrapping stderr, the per-ingest "auto-relink wove …" summaries
// flooded the dev terminal during large/connector ingests. Patched at the entry
// point so it also catches SDK-host logs ([graphnosis-host], [host], etc.).
if (!process.env['GRAPHNOSIS_DEBUG']) {
  const NOISY: RegExp[] = [
    /auto-relink wove/,
    /auto-relink skipped/,
    /oplog compaction skipped/,
    /corrections sweep:/,
    /pruned \d+ stale connection/,
    /autonomously healed \d+ duplicate/,
    /skipping mount/, // connector skip (disabled kind / archived engram) — expected state
  ];
  const wrap = (orig: (...a: unknown[]) => void) => (...args: unknown[]): void => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (NOISY.some((re) => re.test(first))) return;
    orig(...args);
  };
  console.log = wrap(console.log.bind(console)) as typeof console.log;
  console.info = wrap(console.info.bind(console)) as typeof console.info;
  // stderr too — dbg() lands here, and so do the noisiest per-ingest summaries.
  // Real errors don't match NOISY, so they still surface.
  console.error = wrap(console.error.bind(console)) as typeof console.error;
  console.warn = wrap(console.warn.bind(console)) as typeof console.warn;
}
/**
 * Entry router. Single file that Bun's `--compile` consumes as the binary's
 * entry point.
 *
 * Why a router? When the sidecar runs as a `bun build --compile` binary,
 * `child_process.fork()` against an embedded virtual-fs script path
 * re-execs the parent binary itself. If the parent ran its full module
 * graph at startup, the re-execed child would also re-run `local-embed.ts`
 * which spawns workers, which re-exec the parent, etc. — exponential fork
 * bomb (May 2026 incident).
 *
 * This router DEFERS all heavy imports to dynamic `await import()` calls
 * that fire only AFTER we've inspected `process.env.GRAPHNOSIS_WORKER_ROLE`.
 * Two roles:
 *
 *   - WORKER_ROLE=embed (or 'pdf', future)
 *       Only loads the worker entry script. local-embed.ts is NEVER
 *       imported in the worker process, so it CANNOT spawn more workers
 *       even if a configuration bug puts the env var on the wrong path.
 *       This is the structural safety belt.
 *
 *   - WORKER_ROLE unset (default)
 *       Loads `main.ts` — the actual sidecar. main.ts owns its own
 *       lifecycle: IPC server, events server, MCP relay, graph host.
 *
 * Anything that needs to run unconditionally (e.g. global error handlers)
 * should live in this file, BEFORE the dynamic imports, so it fires
 * regardless of role.
 */

// Surface uncaught exceptions to stderr with a clear prefix so Tauri's
// supervisor (which mirrors stderr to the dev terminal AND classifies
// startup failures from a ring buffer) can find them. Without this hook,
// the default Node behavior is silent stack trace + exit — workers would
// die invisibly inside spawn handlers.
process.on('uncaughtException', (err) => {
  console.error(`[graphnosis-sidecar] uncaughtException: ${err.stack ?? err.message}`);
  // Don't exit — let the host classify and decide. workers will be re-spawned
  // by local-embed.ts's `child.on('exit')` handler.
});
process.on('unhandledRejection', (reason) => {
  console.error(`[graphnosis-sidecar] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

// Empty export turns this file into an ES module — required for top-level
// `await` to be legal under TypeScript's strict mode. No runtime effect.
export {};

const role = process.env['GRAPHNOSIS_WORKER_ROLE'];

if (role === 'embed') {
  // Embed worker entry. Loads fastembed + onnxruntime, listens on the
  // child_process IPC channel for embed requests. embed-worker.js has
  // top-level side effects (process.on('message', …)) that keep the
  // process alive — no need to await indefinitely here.
  await import('./embed-worker.js');
} else {
  // Full sidecar. main.ts boots cortex lock, IPC, events, MCP, host.
  await import('./main.js');
  // ── Memory watchdog (diagnostic — DISABLED, kept for future use) ─────────
  // Logs RSS + off-heap (`external` = Buffers like per-save toBuffer/op-log;
  // `arrayBuffers` = embeddings/typed arrays) + `heapUsed` every 30s, so we can
  // see WHAT grows when the sidecar's RSS balloons on a large cortex. We used it
  // to confirm the footprint is genuinely held (a forced GC reclaimed ~0) and
  // that the off-heap figures track the brain consolidation pass. Uncomment to
  // re-arm next time the footprint needs investigating.
  //
  // const mb = (b: number): number => Math.round(b / 1048576);
  // setInterval(() => {
  //   const m = process.memoryUsage();
  //   console.error(
  //     `[mem] rss=${mb(m.rss)}MB external=${mb(m.external)}MB arrayBuffers=${mb(m.arrayBuffers)}MB ` +
  //     `heapUsed=${mb(m.heapUsed)}MB`,
  //   );
  // }, 30_000).unref();
}
