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

// ── Model identity derived from env ──────────────────────────────────────────
//
// GRAPHNOSIS_EMBED_MODEL is set by main.ts BEFORE this module is imported —
// it reads the cortex's settings.json early in boot and forwards the user's
// choice ('english' | 'multilingual'). embed-worker.ts reads the same env
// var so parent and child agree on model + dimension.
//
// IDs are cortex-stable strings; the SDK uses them to detect "did the model
// change?" — when the user switches models, this string changes and every
// engram's cached embeddings get invalidated and rebuilt.
function selectedModel(): 'english' | 'multilingual' {
  return process.env.GRAPHNOSIS_EMBED_MODEL === 'multilingual' ? 'multilingual' : 'english';
}
export const LOCAL_EMBED_ID = selectedModel() === 'multilingual'
  ? 'graphnosis-app:multilingual-e5-large@1024:document'
  : 'graphnosis-app:bge-small-en-v1.5@384:document';
export const LOCAL_EMBED_DIM = selectedModel() === 'multilingual' ? 1024 : 384;

function defaultCacheDir(): string {
  const home = os.homedir();
  // macOS: ~/Library/Caches/GraphnosisApp/models
  // Linux/Win: ~/.cache/GraphnosisApp/models
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'GraphnosisApp', 'models');
  return path.join(home, '.cache', 'GraphnosisApp', 'models');
}

// ── Pool configuration ───────────────────────────────────────────────────────

let WORKER_COUNT = Math.max(1, Number(process.env.GRAPHNOSIS_EMBED_WORKERS ?? 2));
const cacheDir = process.env.GRAPHNOSIS_EMBED_CACHE ?? defaultCacheDir();
const workerScriptPath = fileURLToPath(new URL('./embed-worker.js', import.meta.url));

// ── Worker slot assignment ────────────────────────────────────────────────────
//
// With ≥ 2 workers we split them into two lanes to prevent background
// buildEmbeddings calls from head-of-line-blocking user-facing requests
// (search, recall):
//
//   Foreground lane : slots [0 … WORKER_COUNT-2]   — search, recall, ingest
//   Background lane : slot  [WORKER_COUNT-1]        — buildEmbeddings at boot
//
// With 1 worker there is no split — both lanes use slot 0. When the pool
// is resized at runtime (setWorkerCount) these functions recompute from
// the updated WORKER_COUNT, so the split stays correct after a resize.
//
// Result: during the 30-60 s cold-cache buildEmbeddings burst at boot the
// foreground worker is always free → search/recall respond instantly.

function bgSlot(): number { return WORKER_COUNT > 1 ? WORKER_COUNT - 1 : 0; }
function fgCount(): number { return WORKER_COUNT > 1 ? WORKER_COUNT - 1 : 1; }

// ── Pending request tracking ─────────────────────────────────────────────────

interface PendingEmbed {
  resolve: (vec: number[]) => void;
  reject: (err: Error) => void;
  workerIdx: number;
}

const pending = new Map<number, PendingEmbed>();
let counter = 0;
let nextWorker = 0;    // legacy — used by setWorkerCount's nextWorker reset
let nextFgWorker = 0;  // round-robin index within the foreground lane

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

// ── Private dispatch helper ──────────────────────────────────────────────────

/**
 * Send one embed request to a specific worker slot. If that slot is dead,
 * falls back to any other live worker so callers are never left hanging.
 */
function dispatchEmbed(preferredSlot: number, text: string): Promise<number[]> {
  const id = ++counter;
  // Try the preferred slot first.
  let child = workers[preferredSlot];
  let idx = preferredSlot;
  if (!child?.connected) {
    // Preferred slot is dead — fall back to any live worker.
    child = undefined;
    idx = -1;
    for (let i = 0; i < WORKER_COUNT; i++) {
      const c = workers[i];
      if (c?.connected) { child = c; idx = i; break; }
    }
  }
  if (!child) {
    return Promise.reject(new Error('no live embed worker available'));
  }
  const liveChild = child;
  return new Promise<number[]>((resolve, reject) => {
    pending.set(id, { resolve, reject, workerIdx: idx });
    liveChild.send({ id, text }, (err) => {
      if (err) {
        const p = pending.get(id);
        if (p) { pending.delete(id); p.reject(err); }
      }
    });
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Embed a single text string — **foreground lane** (search, recall, ingest).
 *
 * Dispatches round-robin to slots [0 … fgCount()-1], never touching the
 * background slot. This keeps user-facing embeds responsive even while
 * buildEmbeddings is saturating the background worker at boot.
 *
 * Resilience: dead slots are skipped; if all foreground slots are down the
 * call falls back to any live worker via dispatchEmbed's fallback path.
 */
export const workerEmbed: EmbedFn = (text: string): Promise<number[]> => {
  const fg = fgCount();
  // Round-robin within [0, fg). Try every foreground slot once.
  let preferredSlot = -1;
  for (let tries = 0; tries < fg; tries++) {
    const i = nextFgWorker % fg;
    nextFgWorker = (nextFgWorker + 1) % fg;
    if (workers[i]?.connected) { preferredSlot = i; break; }
  }
  // Fall back to background slot if all foreground slots are dead.
  const slot = preferredSlot >= 0 ? preferredSlot : bgSlot();
  return dispatchEmbed(slot, text);
};

/**
 * Embed a single text string — **background lane** (`buildEmbeddings` at
 * boot, reingest, re-embed migrations).
 *
 * Always targets the last worker slot. With ≥ 2 workers this leaves the
 * foreground slots permanently free for user-facing embed requests, so
 * search/recall never stall behind a long cold-cache rebuild.
 *
 * With 1 worker, `bgSlot()` returns 0 — same as workerEmbed; both calls
 * share the single worker (no isolation, same as before).
 */
export const workerEmbedBackground: EmbedFn = (text: string): Promise<number[]> => {
  return dispatchEmbed(bgSlot(), text);
};

/**
 * Current effective model + ID + dim. Reads the live env var so callers
 * after a `switchEmbedModel` get the new values. The boot-time exports
 * (LOCAL_EMBED_ID / LOCAL_EMBED_DIM) stay as they were — they're for the
 * one-time host construction at boot, not for re-checking after a switch.
 */
export function currentEmbedModel(): { model: 'english' | 'multilingual'; id: string; dim: number } {
  const model = selectedModel();
  return {
    model,
    id: model === 'multilingual'
      ? 'graphnosis-app:multilingual-e5-large@1024:document'
      : 'graphnosis-app:bge-small-en-v1.5@384:document',
    dim: model === 'multilingual' ? 1024 : 384,
  };
}

/**
 * Switch the embedding model at runtime. Terminates every running worker,
 * sets the env var to the new choice, and respawns the pool fresh — the
 * new workers pick up the env var on import and load the corresponding
 * fastembed model on init (downloading it on first use).
 *
 * Returns once at least one new worker has reached 'ready', so the caller
 * can immediately start issuing embed requests. The other slots fill in
 * the background via spawnNextInitial(), same as boot.
 *
 * The host's embedAdapterId is NOT updated here — call host.setEmbedAdapter()
 * with currentEmbedModel() afterwards, then trigger re-embed of every graph.
 */
export async function switchEmbedModel(model: 'english' | 'multilingual'): Promise<void> {
  process.env.GRAPHNOSIS_EMBED_MODEL = model;
  // Stop the initial-fill loop and tear down current workers.
  await terminateEmbedWorker();
  // Reset pool state.
  for (let i = 0; i < WORKER_COUNT; i++) {
    workers[i] = undefined;
    slotFailures[i] = 0;
  }
  initialFillNext = 0;
  // Spawn first slot; the rest chain via spawnNextInitial on 'ready'. Wait
  // for at least the first to be ready so callers don't race ahead.
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('embedding model switch: first worker did not become ready in 60 s')),
      60_000,
    );
    spawnNextInitial();
    const slot0 = workers[0];
    if (!slot0) {
      clearTimeout(timeout);
      reject(new Error('embedding model switch: failed to spawn worker'));
      return;
    }
    const onReady = (msg: { type?: string }): void => {
      if (msg.type === 'ready') {
        slot0.off('message', onReady);
        clearTimeout(timeout);
        resolve();
      }
    };
    slot0.on('message', onReady);
  });
  console.error(`[local-embed] switched to model='${model}'`);
}

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

/**
 * Resize the worker pool at runtime. Safe to call after startup.
 *
 * - Shrink: kills excess workers immediately; the remaining slots carry on.
 * - Grow: adds empty slots and kick-starts the initial fill for the new ones.
 *   New workers use the same fastembed model that is currently active.
 * - No-op when `n` equals the current count.
 *
 * Change is not persisted here — the caller (ipc settings-change handler)
 * is responsible for writing `ai.embedWorkers` to settings.json.
 */
export function setWorkerCount(n: number): void {
  const target = Math.max(1, Math.min(4, Math.round(n)));
  if (target === WORKER_COUNT) return;

  if (target < WORKER_COUNT) {
    // Shrink: kill excess slots.
    for (let i = target; i < WORKER_COUNT; i++) {
      const w = workers[i];
      if (w) {
        w.kill('SIGTERM');
        workers[i] = undefined;
      }
    }
    workers.length = target;
    slotFailures.length = target;
    WORKER_COUNT = target;
    // Cap the fill pointer so spawnNextInitial doesn't try to spawn slots
    // that no longer exist.
    if (initialFillNext > WORKER_COUNT) initialFillNext = WORKER_COUNT;
  } else {
    // Grow: extend arrays first, then spawn the new slots.
    while (workers.length < target) {
      workers.push(undefined);
      slotFailures.push(0);
    }
    WORKER_COUNT = target;
    // If the initial fill already finished for the old count, kick off the
    // new slots now.  Otherwise they'll be picked up by spawnNextInitial
    // automatically as the earlier slots settle.
    while (initialFillNext < WORKER_COUNT) {
      const idx = initialFillNext;
      initialFillNext += 1;
      workers[idx] = spawnWorker(idx);
    }
  }

  // Reset the foreground round-robin so it doesn't wrap around a now-smaller
  // slot range and accidentally target a dead or background slot.
  nextFgWorker = 0;
  nextWorker = 0;
  console.error(`[local-embed] worker pool resized to ${WORKER_COUNT} (fg: 0–${fgCount()-1}, bg: ${bgSlot()})`);
}
