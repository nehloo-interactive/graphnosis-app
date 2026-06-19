/** DOM element lookup — single id, cast to generic. */
export const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** True only inside the Tauri desktop shell. */
export function isTauriRuntime(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}
