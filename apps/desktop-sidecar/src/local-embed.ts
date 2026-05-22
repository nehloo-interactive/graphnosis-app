/**
 * Local embedding pool — fastembed (BGE-small-en-v1.5, 384-dim) via forked
 * child processes.
 *
 * We use child_process.fork() rather than worker_threads because
 * onnxruntime-node is a native N-API addon that calls V8 APIs without the
 * isolate lock — running it in a Worker thread causes an immediate fatal
 * crash. Each forked child has its own V8 isolate and main thread, so the
 * native addon runs safely, and the parent event loop is never blocked by
 * ONNX inference.
 *
 * Pool size default: 2 processes (~200 MB RAM total).
 * Override: GRAPHNOSIS_EMBED_WORKERS=N (min 1).
 */
import { fork, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { EmbedFn } from '@graphnosis-app/core/embeddings';

// ── Bun-compiled mode detection ─────────────────────────────────────────────
//
// In a `bun build --compile` binary, module paths live in Bun's virtual
// filesystem (`/$bunfs/`), Node's `child_process.fork(path)` against such
// paths re-execs the parent binary. Without an env-var router (see
// src/index.ts), that re-exec runs the full sidecar startup which itself
// calls fork() — exponential fork bomb (May 2026 incident: 1,770 processes).
//
// To safely run workers in compiled mode we now:
//   1. Spawn `process.execPath` (the binary itself) with
//      `GRAPHNOSIS_WORKER_ROLE=embed` set in the child's env.
//   2. The router at src/index.ts sees that env var and dynamic-imports
//      ONLY `embed-worker.js` — local-embed.ts never loads in the worker,
//      so it can't fork again no matter what.
//   3. We add a defensive abort here too: if THIS file is somehow loaded
//      with GRAPHNOSIS_WORKER_ROLE set, we throw immediately. That should
//      never happen if the router is correct, but it's a cheap belt.
//
// Belt #1: structural — worker entry doesn't import local-embed.ts.
// Belt #2: env-var check below — refuses to spawn if we're already a worker.
const IS_COMPILED_BIN = (() => {
  try {
    if (import.meta.url.startsWith('file:///$bunfs/')) return true;
    if (import.meta.url.includes('/$bunfs/')) return true;
  } catch { /* import.meta.url may throw in some embedded contexts */ }
  const exe = process.execPath || '';
  if (exe.endsWith('/node')) return false;
  if (exe.includes('graphnosis-sidecar')) return true;
  return false;
})();

if (process.env['GRAPHNOSIS_WORKER_ROLE']) {
  // Safety belt: a worker process should NEVER import local-embed.ts. If
  // we're here, something in the import graph routes back into the main
  // sidecar code from the worker entry — which would re-spawn workers,
  // which would re-spawn, etc. Throw loudly so the bug is visible before
  // damage spreads.
  throw new Error(
    `local-embed.ts loaded inside a worker process (GRAPHNOSIS_WORKER_ROLE=` +
    `${process.env['GRAPHNOSIS_WORKER_ROLE']}). This is a fork-bomb risk; ` +
    `aborting. Check the router in src/index.ts and the worker entry's import graph.`,
  );
}

export const LOCAL_EMBED_ID = 'graphnosis-app:bge-small-en-v1.5@384:document';
export const LOCAL_EMBED_DIM = 384;

function defaultCacheDir(): string {
  const home = os.homedir();
  // macOS: ~/Library/Caches/GraphnosisApp/models
  // Linux/Win: ~/.cache/GraphnosisApp/models
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'GraphnosisApp', 'models');
  return path.join(home, '.cache', 'GraphnosisApp', 'models');
}

// ── Pool configuration ───────────────────────────────────────────────────────

const WORKER_COUNT = Math.max(1, Number(process.env.GRAPHNOSIS_EMBED_WORKERS ?? 2));
const cacheDir = process.env.GRAPHNOSIS_EMBED_CACHE ?? defaultCacheDir();
const workerScriptPath = fileURLToPath(new URL('./embed-worker.js', import.meta.url));

// ── Pending request tracking ─────────────────────────────────────────────────

interface PendingEmbed {
  resolve: (vec: number[]) => void;
  reject: (err: Error) => void;
  workerIdx: number;
}

const pending = new Map<number, PendingEmbed>();
let counter = 0;
let nextWorker = 0;

// ── Pool state ───────────────────────────────────────────────────────────────
//
// `workers` has one slot per pool index; a slot holds `undefined` while it is
// dead or not yet spawned. Embeds are only ever dispatched to a live slot
// (see workerEmbed) — a dead worker must never block a caller.
const workers: (ChildProcess | undefined)[] =
  new Array<ChildProcess | undefined>(WORKER_COUNT).fill(undefined);
/** Consecutive unexpected exits per slot. A slot that keeps dying is given up
 *  on after MAX_SLOT_FAILURES so it can't spin in an endless respawn loop —
 *  embedding simply continues on the surviving worker(s). */
const slotFailures = new Array<number>(WORKER_COUNT).fill(0);
const MAX_SLOT_FAILURES = 3;
/** Next slot index for the initial, one-worker-at-a-time pool fill. */
let initialFillNext = 0;

// ── Child process lifecycle ──────────────────────────────────────────────────

function spawnWorker(idx: number): ChildProcess {
  // Two spawn shapes, same IPC channel + env:
  //   - Compiled binary: re-exec the parent binary itself with
  //     GRAPHNOSIS_WORKER_ROLE=embed. The router at src/index.ts routes
  //     the child into embed-worker.ts only — main sidecar code never
  //     loads in the worker. Uses spawn() + 'ipc' stdio to get the same
  //     `process.send()` channel that fork() sets up.
  //   - Dev mode (node script): use fork() against the embed-worker.js
  //     dist file. Same channel, same protocol.
  // Both paths produce a ChildProcess with `.send()` / `.on('message')`
  // semantics so the rest of this module doesn't branch.
  const env = {
    ...process.env,
    GRAPHNOSIS_EMBED_CACHE_DIR: cacheDir,
    // Set in BOTH paths — harmless in dev, essential in compiled.
    GRAPHNOSIS_WORKER_ROLE: 'embed',
  };
  const child = IS_COMPILED_BIN
    ? spawn(process.execPath, [], {
        env,
        // Same stdio shape as fork(): silence stdin/stdout, inherit
        // stderr, IPC channel on fd 3.
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      })
    : fork(workerScriptPath, [], {
        env,
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });

  child.on('message', (msg: { type?: string; id?: number; vec?: number[]; error?: string }) => {
    if (msg.type === 'ready') {
      console.error(`[local-embed] worker-${idx} ready`);
      slotFailures[idx] = 0; // healthy again — reset the failure counter
      spawnNextInitial();    // chain the next slot of the initial pool fill
      return;
    }
    const id = msg.id;
    if (id == null) return;
    const p = pending.get(id);
    if (!p) return; // already resolved/rejected (e.g., child restarted mid-flight)
    pending.delete(id);
    if (msg.error) {
      p.reject(new Error(`[embed-worker-${idx}] ${msg.error}`));
    } else if (msg.vec) {
      p.resolve(msg.vec);
    } else {
      p.reject(new Error(`[embed-worker-${idx}] empty response (no vec, no error)`));
    }
  });

  child.on('error', (err) => {
    console.error(`[local-embed] worker-${idx} error: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    // code === null when killed by signal (expected on terminateEmbedWorker).
    if (code === 0 || signal === 'SIGTERM') return;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    // Reject every in-flight request routed to this child so its callers
    // fail fast instead of hanging on a response that will never arrive.
    for (const [id, p] of pending) {
      if (p.workerIdx === idx) {
        pending.delete(id);
        p.reject(new Error(`embed-worker-${idx} crashed (${reason})`));
      }
    }
    workers[idx] = undefined;
    const failures = (slotFailures[idx] ?? 0) + 1;
    slotFailures[idx] = failures;
    if (failures > MAX_SLOT_FAILURES) {
      console.error(
        `[local-embed] worker-${idx} exited ${failures}x (${reason}) — giving up ` +
        `on this slot; embedding continues on the remaining worker(s).`,
      );
      // Still advance the initial fill so a doomed slot can't stall the rest
      // of the pool from ever spawning.
      spawnNextInitial();
      return;
    }
    console.error(`[local-embed] worker-${idx} exited unexpectedly (${reason}), respawning`);
    workers[idx] = spawnWorker(idx);
  });

  return child;
}

/**
 * Spawn the next not-yet-started slot of the initial pool — one worker at a
 * time. Called once at boot for slot 0, then again each time a slot first
 * settles (reaches 'ready', or is given up on after repeated failures).
 *
 * Serializing the initial spawns is deliberate: in a `bun build --compile`
 * binary, fastembed's native tokenizer addon (`@anush008/tokenizers-*`) is
 * extracted from the embedded virtual filesystem on first require. Two worker
 * processes doing that concurrently raced, and one died at import with
 * "Cannot require module @anush008/tokenizers-darwin-arm64" — which then, via
 * the leaked-promise bug fixed alongside this, hung the whole sidecar at boot.
 */
function spawnNextInitial(): void {
  if (initialFillNext >= WORKER_COUNT) return;
  const idx = initialFillNext;
  initialFillNext += 1;
  workers[idx] = spawnWorker(idx);
}

// Kick off the initial fill — slot 0 now; each later slot is spawned once its
// predecessor reaches 'ready' (or is given up on). Compiled mode re-execs the
// parent binary with GRAPHNOSIS_WORKER_ROLE=embed (the router at src/index.ts
// keeps the worker importing only embed-worker.ts); dev mode forks embed-worker.js.
spawnNextInitial();
console.error(
  `[local-embed] embed pool: ${WORKER_COUNT} worker(s), spawned sequentially ` +
  `(${IS_COMPILED_BIN ? 'compiled — re-exec of parent binary' : 'dev — fork of embed-worker.js'})`,
);

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Embed a single text string. Dispatches round-robin to the next LIVE child
 * process, skipping any slot that is dead or not yet spawned; returns a
 * Promise that resolves with the 384-dim vector once the child responds.
 *
 * Resilience: a dead worker is never sent a task, and a `send()` that fails
 * anyway (worker died in the race window) rejects the request promise at
 * once. Previously a failed send left the `pending` entry unsettled forever,
 * which hung every caller — and, at boot, the entire sidecar startup.
 */
export const workerEmbed: EmbedFn = (text: string): Promise<number[]> => {
  const id = ++counter;
  // Round-robin to the next live slot — try every slot once before failing.
  let child: ChildProcess | undefined;
  let idx = -1;
  for (let tries = 0; tries < WORKER_COUNT; tries++) {
    const i = nextWorker % WORKER_COUNT;
    nextWorker = (nextWorker + 1) % WORKER_COUNT;
    const candidate = workers[i];
    if (candidate && candidate.connected) {
      child = candidate;
      idx = i;
      break;
    }
  }
  if (!child) {
    return Promise.reject(new Error('no live embed worker available'));
  }
  const liveChild = child;
  return new Promise<number[]>((resolve, reject) => {
    pending.set(id, { resolve, reject, workerIdx: idx });
    // The callback fires with an error if the IPC channel is already gone
    // (worker died between the liveness check above and this send) — reject
    // the pending entry at once instead of leaving it to hang forever.
    liveChild.send({ id, text }, (err) => {
      if (err) {
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          p.reject(err);
        }
      }
    });
  });
};

/**
 * Gracefully terminate all embedding child processes. Call on sidecar shutdown
 * so they don't linger as orphan processes after the main process exits.
 */
export async function terminateEmbedWorker(): Promise<void> {
  // Stop the initial fill from spawning anything further during shutdown.
  initialFillNext = WORKER_COUNT;
  await Promise.allSettled(
    workers.map((child) =>
      child === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            child.kill('SIGTERM');
          }),
    ),
  );
}
