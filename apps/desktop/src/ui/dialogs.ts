/**
 * In-app confirm / alert / prompt dialogs.
 * Tauri's WKWebView silently swallows window.confirm(), window.alert(),
 * and window.prompt() — these helpers render the app's own modals instead.
 */

let _gConfirmResolve: ((v: boolean) => void) | null = null;
let _gPromptResolve: ((v: string | null) => void) | null = null;

export function initDialogs(): void {
  const confirmModal = document.getElementById('g-confirm-modal');
  const confirmOk = document.getElementById('g-confirm-ok') as HTMLButtonElement | null;
  const confirmCancel = document.getElementById('g-confirm-cancel') as HTMLButtonElement | null;
  const resolveConfirm = (v: boolean) => {
    confirmModal?.classList.add('hidden');
    if (_gConfirmResolve) { _gConfirmResolve(v); _gConfirmResolve = null; }
  };
  confirmOk?.addEventListener('click', () => resolveConfirm(true));
  confirmCancel?.addEventListener('click', () => resolveConfirm(false));
  confirmModal?.addEventListener('keydown', (e) => { if (e.key === 'Escape') resolveConfirm(false); });

  const promptModal = document.getElementById('g-prompt-modal');
  const promptOk = document.getElementById('g-prompt-ok') as HTMLButtonElement | null;
  const promptCancel = document.getElementById('g-prompt-cancel') as HTMLButtonElement | null;
  const promptInput = document.getElementById('g-prompt-input') as HTMLInputElement | null;
  const resolvePrompt = (v: string | null) => {
    promptModal?.classList.add('hidden');
    if (promptInput) promptInput.value = '';
    if (_gPromptResolve) { _gPromptResolve(v); _gPromptResolve = null; }
  };
  const submitPrompt = () => {
    resolvePrompt(promptInput?.value ?? '');
  };
  promptOk?.addEventListener('click', submitPrompt);
  promptCancel?.addEventListener('click', () => resolvePrompt(null));
  promptInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitPrompt(); }
    else if (e.key === 'Escape') { e.preventDefault(); resolvePrompt(null); }
  });
  promptModal?.addEventListener('keydown', (e) => { if (e.key === 'Escape') resolvePrompt(null); });
}

export function gConfirm(title: string, body: string): Promise<boolean> {
  const modal = document.getElementById('g-confirm-modal')!;
  const titleEl = document.getElementById('g-confirm-title')!;
  const bodyEl = document.getElementById('g-confirm-body')!;
  const okBtn = document.getElementById('g-confirm-ok') as HTMLButtonElement;
  const cancelEl = document.getElementById('g-confirm-cancel') as HTMLButtonElement;
  titleEl.textContent = title;
  bodyEl.textContent = body;
  okBtn.textContent = 'Confirm';
  cancelEl.classList.remove('hidden');
  modal.classList.remove('hidden');
  okBtn.focus();
  return new Promise<boolean>((resolve) => { _gConfirmResolve = resolve; });
}

export function gAlert(title: string, body: string): Promise<void> {
  const modal = document.getElementById('g-confirm-modal')!;
  const titleEl = document.getElementById('g-confirm-title')!;
  const bodyEl = document.getElementById('g-confirm-body')!;
  const okBtn = document.getElementById('g-confirm-ok') as HTMLButtonElement;
  const cancelEl = document.getElementById('g-confirm-cancel') as HTMLButtonElement;
  titleEl.textContent = title;
  bodyEl.textContent = body;
  okBtn.textContent = 'OK';
  cancelEl.classList.add('hidden');
  modal.classList.remove('hidden');
  okBtn.focus();
  return new Promise<void>((resolve) => {
    _gConfirmResolve = (v) => { void v; resolve(); };
  });
}

export interface GPromptOptions {
  placeholder?: string;
  /** Use a password field so the key isn't visible on screen. Default true. */
  secret?: boolean;
}

export function gPrompt(title: string, body: string, options?: GPromptOptions): Promise<string | null> {
  const modal = document.getElementById('g-prompt-modal')!;
  const titleEl = document.getElementById('g-prompt-title')!;
  const bodyEl = document.getElementById('g-prompt-body')!;
  const input = document.getElementById('g-prompt-input') as HTMLInputElement;
  const secret = options?.secret !== false;
  titleEl.textContent = title;
  bodyEl.textContent = body;
  input.type = secret ? 'password' : 'text';
  input.placeholder = options?.placeholder ?? '';
  input.value = '';
  modal.classList.remove('hidden');
  requestAnimationFrame(() => { input.focus(); });
  return new Promise<string | null>((resolve) => { _gPromptResolve = resolve; });
}
