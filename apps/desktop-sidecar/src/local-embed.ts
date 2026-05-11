import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { FlagEmbedding, EmbeddingModel } from 'fastembed';
import type { EmbedFn } from '@graphnosis-app/core/embeddings';

// Local embedding model via fastembed-js (ONNX runtime, fully offline after first download).
// BGE-small-en-v1.5: 384-dim, ~33MB on disk, ~30-50ms per embed on M-series.
//
// Adapter provenance id is stable per (model, dimension, intent) — this is what
// @nehloo/graphnosis uses as the index identity. Change it if you swap models.

export const LOCAL_EMBED_ID = 'graphnosis-app:bge-small-en-v1.5@384:document';
export const LOCAL_EMBED_DIM = 384;

let modelPromise: Promise<FlagEmbedding> | null = null;

function defaultCacheDir(): string {
  const home = os.homedir();
  // macOS: ~/Library/Caches/GraphnosisApp/models
  // Linux/Win: ~/.cache/GraphnosisApp/models
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'GraphnosisApp', 'models');
  return path.join(home, '.cache', 'GraphnosisApp', 'models');
}

async function loadModel(): Promise<FlagEmbedding> {
  if (!modelPromise) {
    const cacheDir = process.env.GRAPHNOSIS_EMBED_CACHE ?? defaultCacheDir();
    console.error(`[graphnosis-sidecar] initializing local embedding model (BGE-small-en-v1.5) — cache=${cacheDir}`);
    modelPromise = (async () => {
      // fastembed doesn't mkdir its cache — we have to.
      await fs.mkdir(cacheDir, { recursive: true });
      return FlagEmbedding.init({
        model: EmbeddingModel.BGESmallENV15,
        cacheDir,
        showDownloadProgress: false, // stdout is the MCP transport; logs go to stderr
        maxLength: 512,
      });
    })();
  }
  return modelPromise;
}

// Single-text embed for the @graphnosis-app/core `EmbedFn` interface.
// Internally batched calls (passageEmbed/embed) yield AsyncGenerator<number[][]>;
// for one text we take the first batch's first vector.
export const localEmbed: EmbedFn = async (text: string): Promise<number[]> => {
  const model = await loadModel();
  const trimmed = text.trim().slice(0, 8000);
  if (!trimmed) return new Array(LOCAL_EMBED_DIM).fill(0);
  for await (const batch of model.embed([trimmed], 1)) {
    const first = batch[0];
    if (first) return first;
  }
  throw new Error('Local embedding model returned no vectors');
};
