import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { encrypt, decrypt } from '@nehloo-interactive/graphnosis-secure-sync/crypto';

export type EmbedFn = (text: string) => Promise<number[]>;

// Disk-backed cache: content hash -> embedding vector. Encrypted with the user's data key.
// Adapter wraps a fresh model call with: cache.get(hash) ?? model.embed(text)

export interface EmbeddingCacheOptions {
  path: string;
  key: Uint8Array;
  salt: Uint8Array;
}

export class EmbeddingCache {
  private mem = new Map<string, Float32Array>();
  private dirty = false;

  constructor(private readonly opts: EmbeddingCacheOptions) {}

  static hashOf(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
  }

  async load(): Promise<void> {
    try {
      const buf = await fs.readFile(this.opts.path);
      const pt = await decrypt(new Uint8Array(buf), this.opts.key);
      const json = JSON.parse(new TextDecoder().decode(pt)) as Record<string, number[]>;
      for (const [k, v] of Object.entries(json)) this.mem.set(k, Float32Array.from(v));
    } catch {
      // missing cache is fine
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    const obj: Record<string, number[]> = {};
    for (const [k, v] of this.mem) obj[k] = Array.from(v);
    const ct = await encrypt(new TextEncoder().encode(JSON.stringify(obj)), this.opts.key, this.opts.salt);
    await fs.writeFile(this.opts.path, Buffer.from(ct));
    this.dirty = false;
  }

  get(text: string): Float32Array | undefined {
    return this.mem.get(EmbeddingCache.hashOf(text));
  }

  set(text: string, vec: Float32Array | number[]): void {
    this.mem.set(EmbeddingCache.hashOf(text), vec instanceof Float32Array ? vec : Float32Array.from(vec));
    this.dirty = true;
  }
}

// Wrap a fresh embed function with cache-first behavior. Pass this into Graphnosis' embedding adapter.
export function cached(embed: EmbedFn, cache: EmbeddingCache): EmbedFn {
  return async (text: string): Promise<number[]> => {
    const hit = cache.get(text);
    if (hit) return Array.from(hit);
    const vec = await embed(text);
    cache.set(text, vec);
    return vec;
  };
}

// Default local-embeddings stub. Real implementation in the sidecar uses `fastembed` / ONNX.
// Exported so tests and the federation layer can run without a model installed.
export const stubEmbed: EmbedFn = async (text: string): Promise<number[]> => {
  const h = createHash('sha256').update(text, 'utf8').digest();
  const dim = 384;
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = (h[i % h.length]! / 255) * 2 - 1;
  return out;
};

export function cosine(a: number[] | Float32Array, b: number[] | Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!, bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
