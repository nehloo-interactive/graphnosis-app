import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** A file matched by a local-file connector scan. */
export interface ScannedFile {
  path: string;
  mtimeMs: number;
}

/**
 * Recursively collect files under `root` that end with `ext` and were modified
 * after `sinceMs`. Dotfiles and dot-directories are skipped (covers `.git`,
 * `.obsidian`, etc.), plus any extra names in `skipDirs`.
 *
 * Results are sorted **oldest-first** by mtime so a caller can drain them
 * chronologically under a per-pull cap and advance its cursor to the newest
 * file it actually ingested — the key to not silently losing the tail of a
 * large folder drop.
 */
export async function collectFilesNewerThan(
  root: string,
  sinceMs: number,
  opts: { ext: string; skipDirs?: string[] },
): Promise<ScannedFile[]> {
  const skip = new Set(opts.skipDirs ?? []);
  const out: ScannedFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); }
    catch { return; } // unreadable dir — skip
    for (const entry of entries) {
      if (entry.startsWith('.') || skip.has(entry)) continue;
      const full = path.join(dir, entry);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          await walk(full);
        } else if (entry.endsWith(opts.ext) && s.mtimeMs > sinceMs) {
          out.push({ path: full, mtimeMs: s.mtimeMs });
        }
      } catch { /* inaccessible entry — skip */ }
    }
  }

  await walk(root);
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}
