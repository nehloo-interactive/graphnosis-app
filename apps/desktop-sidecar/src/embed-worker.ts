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
import { FlagEmbedding, EmbeddingModel } from 'fastembed';

// Passed from parent via env — always set when spawned by local-embed.ts.
const cacheDir: string = process.env.GRAPHNOSIS_EMBED_CACHE_DIR ?? process.env.HOME ?? '/tmp';
const DIM = 384;

// Initialise the model eagerly so the first request doesn't pay the load cost.
const modelReady: Promise<FlagEmbedding> = (async () => {
  await fs.mkdir(cacheDir, { recursive: true });
  const model = await FlagEmbedding.init({
    model: EmbeddingModel.BGESmallENV15,
    cacheDir: cacheDir,           // always a string (env var or defaultCacheDir in parent)
    showDownloadProgress: false,  // stdout is the MCP transport; logs go to stderr
    maxLength: 512,
  });
  process.send?.({ type: 'ready' });
  return model;
})();

process.on('message', async (req: { id: number; text: string }) => {
  try {
    const model = await modelReady;
    const trimmed = req.text.trim().slice(0, 8000);

    // Empty text: return a zero vector (consistent with previous behaviour).
    if (!trimmed) {
      process.send?.({ id: req.id, vec: new Array<number>(DIM).fill(0) });
      return;
    }

    let vec: number[] | undefined;
    for await (const batch of model.embed([trimmed], 1)) {
      const first = batch[0];
      if (first) { vec = Array.from(first); break; }
    }
    if (!vec) throw new Error('fastembed returned no vectors');
    process.send?.({ id: req.id, vec });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    process.send?.({ id: req.id, error });
  }
});
