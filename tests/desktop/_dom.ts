// @disclosure: (a) publishable — Harness only — a jsdom window and a fake transport. No defect content, no shipped-build claim. Already on scripts/tests-allowlist.txt.
// @disclosure-src: 2.59a §5.2 (Graphnosis/data/audit-archive/findings/PII-DISCLOSURE-TESTTREE-2.59a.md) · held by scripts/disclosure-held.txt · enforced by scripts/check-disclosure-tags.sh
/**
 * Test support for the `apps/desktop` lane — a jsdom window, the real
 * index.html, and a fake transport at the ONE seam the front end actually
 * has: `fetch('/api/rpc')`.
 *
 * Why this shape:
 *
 *  • `apps/desktop` had NO test surface at all. The refusal guards that
 *    landed in `ui/memory-integrity-workbench.ts` and in `main.ts`'s
 *    `applyStudioEdit` could only be demonstrated with throwaway scratch
 *    harnesses — nothing in CI executed them. This module is the lane.
 *
 *  • Nothing here stubs a desktop module. `main.ts` is imported whole, with
 *    its ~28k lines of top-level wiring running against the app's real
 *    `index.html`, and the assertions drive it by clicking real buttons.
 *    The only thing faked is the network: `platform.ts` in browser mode
 *    (i.e. `window.__TAURI_INTERNALS__` absent) routes every `ipcCall` →
 *    `invoke('sidecar_ipc_call')` → `browserRpc()` → `fetch('/api/rpc')`.
 *    Replacing global `fetch` therefore leaves the entire UI stack — the
 *    call sites, the guards, the DOM writes — executing for real.
 *
 *  • jsdom is resolved out of `apps/desktop-sidecar`, the only workspace
 *    package that declares it (it is a real dependency there, used by
 *    `src/ingest.ts`). The lane deliberately adds NO new dependency and
 *    requires no install.
 */
import { createRequire, register } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DESKTOP = path.join(REPO_ROOT, 'apps', 'desktop');

// Register the CSS-stub / vite-alias hooks BEFORE any desktop module is
// imported. This module is imported statically by every suite in the lane
// and the desktop sources are pulled in later via `importDesktop()`, so the
// ordering holds.
register(pathToFileURL(path.join(HERE, '_loader.mjs')));

const sidecarRequire = createRequire(
  path.join(REPO_ROOT, 'apps', 'desktop-sidecar', 'package.json'),
);
const { JSDOM } = sidecarRequire('jsdom') as typeof import('jsdom');

export interface RpcCall {
  method: string;
  params: unknown;
}

/** Answer shape for a faked RPC: either a resolved result or a transport throw. */
export type RpcHandler = (call: RpcCall) => unknown;

export interface DesktopDom {
  window: Window & typeof globalThis;
  document: Document;
  /** Every `/api/rpc` call the UI made, in order. */
  calls: RpcCall[];
  /** Swap the RPC handler mid-test (e.g. refuse the first apply, accept the retry). */
  setRpc(handler: RpcHandler): void;
}

const SESSION_KEY = 'graphnosis:session';

/**
 * Globals Node 20 ALSO defines, where the desktop code needs jsdom's version.
 *
 * `document.dispatchEvent(new CustomEvent(...))` — which the workbench does on
 * every action — throws "parameter 1 is not of type 'Event'" if the event was
 * built from Node's constructor, because jsdom brand-checks against its own
 * realm. Skipping already-present keys (the right default, so Node built-ins
 * survive) would leave exactly that landmine, so these are forced.
 *
 * Kept deliberately SHORT. Wholesale replacement of Node globals (URL,
 * performance, structuredClone, …) breaks node:test itself, so only the
 * event constructors the desktop code constructs are forced.
 */
const DOM_REALM_OVERRIDES = new Set(['Event', 'CustomEvent']);

/**
 * Keep the app's background clocks from pinning the event loop open.
 *
 * Importing `main.ts` arms four never-ending timers: d3-timer's wake loop
 * (1s, via `3d-force-graph`/`d3-force-3d`), jsdom's own rAF pump (16.6ms,
 * which is why `pretendToBeVisual` is off below), `platform.ts`'s `sseLoop`
 * reconnect (3s), and a 5s repeater in main.ts itself. All are refs, so the
 * suite ran its assertions, PASSED, and then hung forever without printing a
 * TAP summary — which the runner correctly scores as a crash, not a pass.
 *
 * Unref'ing leaves every timer firing (behavior unchanged) but lets the
 * process exit once the tests are done. Applied once per process.
 */
let timersUnreffed = false;
function unrefBackgroundTimers(): void {
  if (timersUnreffed) return;
  timersUnreffed = true;

  const realInterval = globalThis.setInterval;
  (globalThis as unknown as Record<string, unknown>)['setInterval'] =
    (...args: Parameters<typeof setInterval>): ReturnType<typeof setInterval> => {
      const t = realInterval(...args);
      (t as unknown as { unref?: () => void }).unref?.();
      return t;
    };

  // Self-rescheduling `setTimeout` loops pin the loop just as hard as an
  // interval: `platform.ts`'s `sseLoop` reconnects every 3s forever, and
  // main.ts arms a 5s repeater at import. Only timers at or above the
  // threshold are unref'd — the sub-threshold band is where the tests' own
  // `flush()` (0ms) lives, and leaving it reffed means a suite can never be
  // cut short by its own await.
  const REAL_WORK_MS = 50;
  const realTimeout = globalThis.setTimeout;
  (globalThis as unknown as Record<string, unknown>)['setTimeout'] =
    (...args: Parameters<typeof setTimeout>): ReturnType<typeof setTimeout> => {
      const t = realTimeout(...args);
      if (Number(args[1] ?? 0) >= REAL_WORK_MS) (t as unknown as { unref?: () => void }).unref?.();
      return t;
    };
}

/**
 * Build a jsdom window around a page and install it as the process globals.
 *
 * @param html  `'index'` loads the app's real `apps/desktop/index.html`;
 *              anything else is treated as a literal HTML document, which is
 *              what the leaf-module suites use (they need only the handful of
 *              hooks their module touches).
 */
export function installDesktopDom(html: 'index' | string = 'index'): DesktopDom {
  const markup = html === 'index'
    ? readFileSync(path.join(DESKTOP, 'index.html'), 'utf8')
    : html;

  unrefBackgroundTimers();

  // `pretendToBeVisual: false` on purpose — its only load-bearing effect here
  // would be jsdom's rAF pump, which we supply below as a one-shot unref'd
  // timer instead. The desktop code only ever uses rAF to defer a paint.
  const dom = new JSDOM(markup, { url: 'http://localhost:3456/' });
  const w = dom.window as unknown as Window & typeof globalThis;
  const g = globalThis as unknown as Record<string, unknown>;

  const rafHandles = new Map<number, NodeJS.Timeout>();
  let rafSeq = 0;
  const raf = (cb: FrameRequestCallback): number => {
    const id = ++rafSeq;
    const t = setTimeout(() => { rafHandles.delete(id); cb(Date.now()); }, 0);
    t.unref?.();
    rafHandles.set(id, t);
    return id;
  };
  const caf = (id: number): void => {
    const t = rafHandles.get(id);
    if (t) { clearTimeout(t); rafHandles.delete(id); }
  };
  (w as unknown as Record<string, unknown>)['requestAnimationFrame'] = raf;
  (w as unknown as Record<string, unknown>)['cancelAnimationFrame'] = caf;

  g['window'] = w;
  g['document'] = w.document;
  // `navigator` is a non-writable getter on modern Node globals, so a plain
  // assignment silently no-ops (and `platform.ts` reads navigator.standalone).
  Object.defineProperty(globalThis, 'navigator', {
    value: w.navigator, configurable: true, writable: true,
  });
  for (const key of Object.getOwnPropertyNames(w)) {
    if (key in g && !DOM_REALM_OVERRIDES.has(key)) continue;
    try { g[key] = (w as unknown as Record<string, unknown>)[key]; } catch { /* getter-only */ }
  }
  // Vite `define`. Without it main.ts throws a ReferenceError at import time.
  g['__APP_VERSION__'] = '0.0.0-test';
  // Browser mode: `platform.ts` computes IS_TAURI from this at module scope.
  delete (w as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  // browserRpc() refuses to call out without a session token.
  w.sessionStorage.setItem(SESSION_KEY, 'test-session-token');

  const calls: RpcCall[] = [];
  let handler: RpcHandler = () => ({});

  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  g['fetch'] = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.includes('/api/rpc')) return jsonResponse({ result: null });
    const body = JSON.parse(String(init?.body ?? '{}')) as RpcCall;
    calls.push({ method: body.method, params: body.params });
    try {
      return jsonResponse({ result: handler({ method: body.method, params: body.params }) });
    } catch (e) {
      // A thrown handler models a sidecar-side error, which the wire reports
      // as `{ error }` — NOT as a rejected fetch.
      return jsonResponse({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  (w as unknown as Record<string, unknown>)['fetch'] = g['fetch'];

  return {
    window: w,
    document: w.document,
    calls,
    setRpc(h) { handler = h; },
  };
}

/** Import a module from `apps/desktop/src` by its path relative to that dir. */
export async function importDesktop<T = Record<string, unknown>>(rel: string): Promise<T> {
  return import(pathToFileURL(path.join(DESKTOP, 'src', rel)).href) as Promise<T>;
}

let freshCounter = 0;

/**
 * Import a desktop module with a FRESH module instance (cache-busted).
 *
 * The UI modules keep module-scope state — `memory-integrity-workbench.ts`
 * has a `mounted` latch, `main.ts` has `studioPendingDiffId`. A suite that
 * needs several independent scenarios must get a clean instance per case,
 * or case 2 silently runs against case 1's leftovers and proves nothing.
 */
export async function importDesktopFresh<T = Record<string, unknown>>(rel: string): Promise<T> {
  const href = pathToFileURL(path.join(DESKTOP, 'src', rel)).href;
  return import(`${href}?fresh=${++freshCounter}`) as Promise<T>;
}

/** Let queued microtasks and 0ms timers drain — the UI's click handlers are async. */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

/**
 * Click an element by id, failing loudly when the id is not in the page.
 *
 * Uses `HTMLElement.click()` rather than a synthesized Event: the event must
 * come from jsdom's own realm, and a Node-global `Event` is rejected by
 * jsdom's `dispatchEvent`.
 */
export function click(doc: Document, id: string): void {
  const el = doc.getElementById(id) as HTMLElement | null;
  if (!el) throw new Error(`click(): #${id} is not in the document`);
  el.click();
}
