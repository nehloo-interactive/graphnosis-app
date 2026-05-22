// Sync the canonical GRAPHNOSIS.md into the docs site's public/ folder.
//
// /GRAPHNOSIS.md at the repo root is the single source of truth — the
// standing memory instructions shipped to AI clients. The docs site serves
// a downloadable copy at /GRAPHNOSIS.md; rather than maintain two files that
// can silently drift, this script regenerates the public/ copy from the
// canonical one. It runs automatically before `dev` and `build` via the
// `predev` / `prebuild` lifecycle hooks, so the served copy is always current.
//
// apps/docs/public/GRAPHNOSIS.md is git-ignored — it is a build artifact,
// not a source. Never edit it by hand; edit /GRAPHNOSIS.md instead.

import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = new URL('../../../GRAPHNOSIS.md', import.meta.url);
const dest = new URL('../public/GRAPHNOSIS.md', import.meta.url);

if (!existsSync(source)) {
  console.error(
    `[sync-graphnosis-md] canonical source not found: ${fileURLToPath(source)}`,
  );
  process.exit(1);
}

copyFileSync(source, dest);
console.log(
  `[sync-graphnosis-md] synced ${fileURLToPath(source)} -> ${fileURLToPath(dest)}`,
);
