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
      // Format detection: "GEMB" magic = compact binary; anything else = legacy
      // JSON (Record<string,number[]>), which we read once and re-save as binary.
      if (pt.length >= 4 && pt[0] === 0x47 && pt[1] === 0x45 && pt[2] === 0x4d && pt[3] === 0x42) {
        this.loadBinary(pt);
      } else {
        const json = JSON.parse(new TextDecoder().decode(pt)) as Record<string, number[]>;
        for (const [k, v] of Object.entries(json)) this.mem.set(k, Float32Array.from(v));
        this.dirty = true; // migrate to the compact binary format on next save
      }
    } catch {
      // missing cache is fine
    }
  }

  /** Parse the binary format: [GEMB][ver u8][count u32] then per entry
   *  [keyLen u8][key utf8][dim u16][dim×f32 LE]. Vectors are copied into fresh
   *  aligned Float32Arrays so we don't retain the whole file buffer. */
  private loadBinary(pt: Uint8Array): void {
    const dv = new DataView(pt.buffer, pt.byteOffset, pt.byteLength);
    let off = 5; // skip magic(4) + version(1)
    const count = dv.getUint32(off, true); off += 4;
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      const keyLen = dv.getUint8(off); off += 1;
      const key = dec.decode(pt.subarray(off, off + keyLen)); off += keyLen;
      const dim = dv.getUint16(off, true); off += 2;
      const vec = new Float32Array(dim);
      new Uint8Array(vec.buffer).set(pt.subarray(off, off + dim * 4)); // bulk copy (LE, local)
      off += dim * 4;
      this.mem.set(key, vec);
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    // Compact binary — ~15× smaller than the old JSON and, crucially, NO
    // number[] boxing or giant-string churn (JSON.stringify of the whole growing
    // cache per checkpoint spiked heap to GBs during big ingests).
    let size = 9; // magic(4) + ver(1) + count(4)
    for (const [k, v] of this.mem) size += 1 + Buffer.byteLength(k) + 2 + v.length * 4;
    const out = Buffer.allocUnsafe(size);
    out.write('GEMB', 0, 'ascii'); out.writeUInt8(1, 4); out.writeUInt32LE(this.mem.size, 5);
    let off = 9;
    for (const [k, v] of this.mem) {
      const kb = Buffer.from(k, 'utf8');
      out.writeUInt8(kb.length, off); off += 1;
      kb.copy(out, off); off += kb.length;
      out.writeUInt16LE(v.length, off); off += 2;
      out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), off); off += v.length * 4; // bulk (LE, local)
    }
    const ct = await encrypt(new Uint8Array(out), this.opts.key, this.opts.salt);
    // 0o600: the embedding cache is encrypted, but restrict it anyway so other
    // local users can't copy it for offline analysis.
    await fs.writeFile(this.opts.path, Buffer.from(ct), { mode: 0o600 });
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
