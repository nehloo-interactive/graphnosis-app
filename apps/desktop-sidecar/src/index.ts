#!/usr/bin/env node
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
}
