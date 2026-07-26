/**
 * Child-process embedding script (spawned via child_process.fork()).
 *
 * Using fork() rather than worker_threads because onnxruntime-node is an
 * N-API native addon that uses V8 handles without acquiring the V8 isolate
 * lock. Running it inside a worker_threads Worker crashes with:
 *   "FATAL ERROR: HandleScope::HandleScope Entering the V8 API without
 *    proper locking in place"
 * A forked child process has its own V8 isolate and main thread, so the
 * native addon runs safely.
 *
 * Protocol (via process IPC):
 *   parent → child : { id: number, text: string }
 *   child → parent : { id: number, vec: number[] }   (success — 384 floats)
 *   child → parent : { id: number, error: string }   (failure)
 *   child → parent : { type: 'ready' }               (model loaded)
 */
import { promises as fs } from 'node:fs';
import { setPriority } from 'node:os';
import { FlagEmbedding, EmbeddingModel } from 'fastembed';

// Run at below-normal OS priority so embedding doesn't crowd out foreground
// apps (Claude, the UI, etc.). Nice value 1 = PRIORITY_BELOW_NORMAL on
// macOS/Linux. Silently skip if setPriority throws (non-fatal).
try { setPriority(process.pid, 1); } catch { /* best-effort */ }

// Passed from parent via env — always set when spawned by local-embed.ts.
const cacheDir: string = process.env.GRAPHNOSIS_EMBED_CACHE_DIR ?? process.env.HOME ?? '/tmp';

// ── Model selection (parameterized via env) ─────────────────────────────────
//
// The parent (local-embed.ts) sets GRAPHNOSIS_EMBED_MODEL before spawning:
//   'english'       → BGE-small-en-v1.5 (384-dim, ~30 MB) — default.
//   'multilingual'  → multilingual-e5-large (1024-dim, ~2.2 GB) — opt-in.
//
// The dimension must match the parent's LOCAL_EMBED_DIM, which derives the
// same value from the same env var, so the SDK's vector index gets the
// right size at init.
const MODEL_CHOICE = (process.env.GRAPHNOSIS_EMBED_MODEL ?? 'english') as 'english' | 'multilingual';
const MODEL_TAG = MODEL_CHOICE === 'multilingual'
  ? EmbeddingModel.MLE5Large
  : EmbeddingModel.BGESmallENV15;
const DIM = MODEL_CHOICE === 'multilingual' ? 1024 : 384;

// If the sidecar parent dies without running graceful shutdown (force-quit,
// SIGKILL, tokio Drop race), forked/spawned workers become launchd orphans
// and keep burning CPU on ONNX. Exit when the parent is gone.
const bootPpid = process.ppid;
if (bootPpid > 1) {
  setInterval(() => {
    if (process.ppid === 1) {
      process.exit(0);
      return;
    }
    try {
      process.kill(bootPpid, 0);
    } catch {
      process.exit(0);
    }
  }, 2_000).unref?.();
}

/**
 * Send to the parent, tolerating a parent that has already gone away.
 *
 * The parent exits as soon as its work is done; a worker mid-batch then writes
 * to a closed IPC channel. Node surfaces that as EPIPE on an 'error' event with
 * no listener, which terminates the worker with a stack trace — and because the
 * native embedder is torn down at the same moment, it follows with
 * "mutex lock failed: Invalid argument". The result was a page of crash output
 * printed AFTER a run that had completely succeeded, which is both alarming and
 * a good way to hide a real error next to it.
 *
 * There is nothing to recover here: no parent means no one is waiting for this
 * vector, so drop it and go quietly.
 */
function sendToParent(msg: unknown): void {
  try {
    process.send?.(msg as never);
  } catch {
    process.exit(0);
  }
}

// Same reason, for the async path: an EPIPE raised after we return lands here
// rather than at the send call site.
process.on('error', (e: NodeJS.ErrnoException) => {
  if (e?.code === 'EPIPE' || e?.code === 'ERR_IPC_CHANNEL_CLOSED') process.exit(0);
  console.error(`[embed-worker] ${e?.stack ?? String(e)}`);
  process.exit(1);
});

const modelReady: Promise<FlagEmbedding> = (async () => {
  await fs.mkdir(cacheDir, { recursive: true });
  const model = await FlagEmbedding.init({
    model: MODEL_TAG,
    cacheDir: cacheDir,           // always a string (env var or defaultCacheDir in parent)
    showDownloadProgress: false,  // stdout is the MCP transport; logs go to stderr
    maxLength: 512,
  });
  sendToParent({ type: 'ready', model: MODEL_CHOICE, dim: DIM });
  return model;
})();

process.on('message', async (req: { id: number; text: string }) => {
  try {
    const model = await modelReady;
    const trimmed = req.text.trim().slice(0, 8000);

    // Empty text: return a zero vector (consistent with previous behaviour).
    if (!trimmed) {
      sendToParent({ id: req.id, vec: new Array<number>(DIM).fill(0) });
      return;
    }

    let vec: number[] | undefined;
    for await (const batch of model.embed([trimmed], 1)) {
      const first = batch[0];
      if (first) { vec = Array.from(first); break; }
    }
    if (!vec) throw new Error('fastembed returned no vectors');
    sendToParent({ id: req.id, vec });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    sendToParent({ id: req.id, error });
  }
});
