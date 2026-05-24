/**
 * In-process registry for pending consent prompts.
 *
 * When the MCP server hits the consent gate for a (client, tier) that
 * isn't auto-allowed by policy, it registers a pending prompt here,
 * emits a `consent-prompt` event to the Tauri frontend, and awaits the
 * user's click. The frontend resolves the prompt by dispatching the
 * `consent.resolvePrompt` IPC command, which calls `resolve()` below.
 *
 * Shared between mcp-server.ts (registers + awaits) and ipc.ts
 * (resolves) by living in this module — avoids passing a Map through
 * mcpDeps / IpcDeps and keeps the consent-flow state in one place.
 *
 * Times out after a configurable window (default 60 s) — when no
 * frontend is connected (headless sidecar, dev SSH, CI smoke tests)
 * the caller can fall back to the phrase-typing flow.
 */

export type ConsentChoice =
  | { action: 'allow'; durationMs: number }   // user clicked Allow / Allow 1h / Allow today
  | { action: 'deny' }                        // user clicked Deny
  | { action: 'timeout' };                    // no frontend responded in time

export interface PendingPrompt {
  promptId: string;
  clientName: string;
  tiers: Array<'personal' | 'sensitive'>;
  createdAt: number;
}

interface PromptSlot {
  resolve: (c: ConsentChoice) => void;
  timer: ReturnType<typeof setTimeout>;
  meta: PendingPrompt;
}

const pending = new Map<string, PromptSlot>();

/**
 * Register a new pending consent prompt. Returns the prompt metadata
 * (with a fresh `promptId` the frontend will quote back) and a Promise
 * that resolves with the user's choice — or `{action:'timeout'}` if
 * nobody responded in `timeoutMs`.
 */
export function registerPrompt(
  clientName: string,
  tiers: Array<'personal' | 'sensitive'>,
  timeoutMs = 60_000,
): { meta: PendingPrompt; choice: Promise<ConsentChoice> } {
  const promptId = `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const meta: PendingPrompt = { promptId, clientName, tiers, createdAt: Date.now() };
  const choice = new Promise<ConsentChoice>((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(promptId)) resolve({ action: 'timeout' });
    }, timeoutMs);
    // Don't keep the event loop alive just because a consent prompt is
    // pending — the user closing the app should exit cleanly.
    timer.unref?.();
    pending.set(promptId, { resolve, timer, meta });
  });
  return { meta, choice };
}

/**
 * Frontend → sidecar: user clicked a button on the consent modal.
 * Returns true if the prompt was found and resolved, false if it had
 * already timed out or been resolved (stale click — frontend may
 * receive a duplicate event and not realize).
 */
export function resolvePrompt(promptId: string, choice: ConsentChoice): boolean {
  const slot = pending.get(promptId);
  if (!slot) return false;
  clearTimeout(slot.timer);
  pending.delete(promptId);
  slot.resolve(choice);
  return true;
}

/** Used by `consent.listPendingPrompts` for the frontend to re-sync after a reconnect. */
export function listPendingPrompts(): PendingPrompt[] {
  return [...pending.values()].map((s) => s.meta);
}
