/**
 * App bootstrap — wait for the Tauri runtime before loading main.ts.
 *
 * In the desktop DEV build the window loads an EXTERNAL url (http://localhost:5173)
 * and Tauri injects `window.__TAURI_INTERNALS__` a tick AFTER the module graph
 * first evaluates. platform.ts computes `IS_TAURI` once at module-load; if that
 * happens too early it latches to `false` and the whole desktop app drops into
 * browser/HTTP mode — `invoke` tries a non-existent `/api/rpc` proxy (stuck at
 * unlock), the native window/webview APIs are stubbed (no drag-drop, window
 * sizing fails), and the mobile "rotate to portrait" layout shows.
 *
 * Production (tauri://) injects at document-start, so this resolves instantly.
 * A genuine browser/mobile client never gets the runtime — the short wait simply
 * expires and the app proceeds in browser mode, exactly as intended.
 */
const hasTauri = (): boolean =>
  typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

async function boot(): Promise<void> {
  if (!hasTauri()) {
    // Poll up to ~600ms. Tauri dev injects within a few tens of ms; a real
    // browser never injects, so this is the (one-time) browser-load penalty.
    for (let i = 0; i < 30 && !hasTauri(); i++) {
      await new Promise<void>((r) => setTimeout(r, 20));
    }
  }
  await import('./main.ts');
}

void boot();
