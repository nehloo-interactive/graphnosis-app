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

/**
 * Does this error mean "the sidecar has no such method" — i.e. version skew —
 * rather than "the method ran and failed"?
 *
 * The two are NOT interchangeable. A handler that ran and threw says something
 * about this cortex's data; a handler that does not exist says something about
 * the build on the other end of the socket. Any readout that would otherwise
 * present an absent answer as a clean one has to be able to tell them apart.
 *
 * Matching is on the message text because that is the only thing that crosses
 * both transports. `dispatch()` throws `Unknown IPC method: <name>` for a name
 * it has no case for; the local Unix-socket client wraps it (with a stack) and
 * the remote HTTP bridge returns it as the `error` field of a 400 — hence
 * `includes` rather than `startsWith`.
 *
 * NB: over a remote cortex this only works against a shell built after
 * `remote::rpc` started reading the error body. An older shell collapses the
 * whole 400 to "failed with HTTP 400 Bad Request" and this correctly returns
 * false — unknown reads as a plain failure, which is the safe direction.
 */
export function isUnknownIpcMethodError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('Unknown IPC method');
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
