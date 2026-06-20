import { invoke } from '../platform';

/** Generic pass-through to the sidecar IPC dispatch via Tauri `sidecar_ipc_call`. */
export async function ipcCall<T = unknown>(method: string, params: unknown): Promise<T> {
  return invoke<T>('sidecar_ipc_call', { method, params });
}

/** ipcCall with a hard client-side deadline. */
export function ipcCallTimeout<T = unknown>(method: string, params: unknown, ms = 8000): Promise<T> {
  return Promise.race([
    ipcCall<T>(method, params),
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`ipc '${method}' timed out after ${ms}ms`)), ms)),
  ]);
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

const TRANSIENT_RE = /connection|socket|ECONNREFUSED|not running|sidecar/i;

/** Run `fn` under P0 UI work scope so sidecar skips/defers P2/P3 LLM work.
 *  Awaits scope enter/exit IPC so sidecar ref-count stays paired — fire-and-forget
 *  toggles could leave P0 stuck and starve boot/engram loads behind LLM gates. */
export async function withUiWorkScope<T>(fn: () => Promise<T>): Promise<T> {
  await ipcCall('ui:workScope', { priority: 0, active: true }).catch((err) => {
    console.warn('[ui:workScope] enter failed:', err instanceof Error ? err.message : String(err));
  });
  try {
    return await fn();
  } finally {
    await ipcCall('ui:workScope', { priority: 0, active: false }).catch((err) => {
      console.warn('[ui:workScope] exit failed:', err instanceof Error ? err.message : String(err));
    });
  }
}

/** Retry a raw Tauri invoke on transient sidecar-connection failure. */
export async function invokeRetry<T>(
  cmd: string,
  args?: Record<string, unknown>,
  tries = 3,
  delayMs = 600,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await invoke<T>(cmd, args);
    } catch (e) {
      lastErr = e;
      const msg = String(e);
      if (attempt < tries - 1 && TRANSIENT_RE.test(msg)) {
        await new Promise<void>((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
