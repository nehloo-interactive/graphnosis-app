// @disclosure: (a) publishable — Harness only — Node ESM loader hooks for the desktop lane. No defect content. Already on scripts/tests-allowlist.txt.
// @disclosure-src: 2.59a §5.2 (Graphnosis/data/audit-archive/findings/PII-DISCLOSURE-TESTTREE-2.59a.md) · held by scripts/disclosure-held.txt · enforced by scripts/check-disclosure-tags.sh
/**
 * Node ESM loader hooks for the `apps/desktop` test lane.
 *
 * `apps/desktop` is a Vite front-end: its source imports things Node's own
 * resolver cannot load. Two of them, and only two:
 *
 *  1. `import './mobile.css'` — Vite turns a CSS import into a side effect.
 *     Node throws ERR_UNKNOWN_FILE_EXTENSION. We shortcircuit `.css` to an
 *     empty module. Styling is not what these tests assert on, so an empty
 *     stub is honest: nothing in the lane reads the export.
 *
 *  2. `@graphnosis-app/core/cortex/cloud-location` — the workspace package's
 *     `exports` map does NOT publish that subpath, so Node refuses it with
 *     ERR_PACKAGE_PATH_NOT_EXPORTED. The real app only resolves it because
 *     `apps/desktop/vite.config.ts` declares an explicit alias to the
 *     package's TS source. The ALIAS table below MIRRORS that vite alias
 *     one-for-one — it is not a test-only shortcut, and if vite.config.ts
 *     grows another alias this table has to grow with it or the lane will
 *     fail loudly (which is the correct failure).
 *
 * Everything else resolves through Node/tsx normally. In particular the
 * desktop sources themselves are NOT stubbed, shimmed, or rewritten: the
 * tests execute the same module text the app ships.
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_SRC = path.join(REPO_ROOT, 'packages', 'graphnosis-app-core', 'src');

/** Mirror of `resolve.alias` in apps/desktop/vite.config.ts. */
const ALIAS = new Map([
  [
    '@graphnosis-app/core/cortex/cloud-location',
    pathToFileURL(path.join(CORE_SRC, 'cortex', 'cloud-location.ts')).href,
  ],
]);

export async function resolve(specifier, context, next) {
  const aliased = ALIAS.get(specifier);
  if (aliased) return { url: aliased, format: 'module', shortCircuit: true };
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('.css')) {
    return { format: 'module', shortCircuit: true, source: 'export default "";' };
  }
  return next(url, context);
}
