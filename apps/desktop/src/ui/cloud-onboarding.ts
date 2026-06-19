/**
 * Unified cloud onboarding — wizard, busy card copy, Settings → Sync panel.
 */
import {
  analyzeCortexCloudLocation,
  detectCortexCloudMode,
  type CortexCloudMode,
  type CortexCloudInfo,
} from '@graphnosis-app/core/cortex/cloud-location';
import { IS_TAURI, invoke } from '../platform';
import { app } from './app-context';
import { ipcCall } from './ipc';

export type { CortexCloudMode, CortexCloudInfo };
export { analyzeCortexCloudLocation, detectCortexCloudMode } from '@graphnosis-app/core/cortex/cloud-location';

const SESSION_LEASE_STALE_MS = 90_000;

export interface SessionLease {
  deviceName: string;
  hostname: string;
  pid?: number;
  updatedAt: number;
}

function isSessionLeaseFresh(lease: SessionLease | null | undefined, now = Date.now()): boolean {
  if (!lease || typeof lease.updatedAt !== 'number') return false;
  return now - lease.updatedAt < SESSION_LEASE_STALE_MS;
}

const ONBOARDING_LS_PREFIX = 'graphnosis_cloud_onboarding_done:';

export interface CloudBusyState {
  mode: CortexCloudMode;
  providerLabel: string;
  deviceName?: string;
  hostname?: string;
  variant: 'session' | 'lock';
}

export interface CloudOnboardingState {
  mode: CortexCloudMode;
  info: CortexCloudInfo;
  onboardingCompleted: boolean;
  sharedConfirm: boolean | null;
}

/** Normalize cortex path the same way the shell does (best-effort in browser). */
export function normalizeCortexPath(cortexPath: string): string {
  let s = cortexPath.trim();
  while (s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))) s = s.slice(0, -1);
  return s;
}

function localOnboardingDone(cortexPath: string): boolean {
  try {
    return localStorage.getItem(ONBOARDING_LS_PREFIX + normalizeCortexPath(cortexPath)) === '1';
  } catch {
    return false;
  }
}

function markLocalOnboardingDone(cortexPath: string): void {
  try {
    localStorage.setItem(ONBOARDING_LS_PREFIX + normalizeCortexPath(cortexPath), '1');
  } catch { /* private mode */ }
}

/** Pre-unlock cloud analysis (no sidecar required). */
export function analyzeCortexPath(cortexPath: string, sharedConfirm?: boolean | null): CloudOnboardingState {
  const normalized = normalizeCortexPath(cortexPath);
  const info = analyzeCortexCloudLocation(normalized);
  const mode = detectCortexCloudMode(normalized, sharedConfirm);
  return {
    mode,
    info,
    onboardingCompleted: localOnboardingDone(normalized),
    sharedConfirm: sharedConfirm ?? null,
  };
}

/** Read session lease before unlock (Tauri reads filesystem directly). */
export async function readPreUnlockSessionLease(cortexPath: string): Promise<{
  lease: SessionLease | null;
  fresh: boolean;
}> {
  const normalized = normalizeCortexPath(cortexPath);
  if (!IS_TAURI || !normalized) return { lease: null, fresh: false };
  try {
    return await invoke<{ lease: SessionLease | null; fresh: boolean }>('read_cortex_session_lease', {
      path: normalized,
    });
  } catch {
    return { lease: null, fresh: false };
  }
}

/** Merge settings-backed onboarding state after unlock. */
export async function refreshCloudOnboardingFromSettings(cortexPath: string): Promise<CloudOnboardingState> {
  const normalized = normalizeCortexPath(cortexPath);
  try {
    const remote = await ipcCall<{
      mode: CortexCloudMode;
      providerLabel: string;
      inCloudFolder: boolean;
      onboardingCompleted: boolean;
      sharedConfirm: boolean | null;
    }>('cloud.getInfo', { cortexDir: normalized });
    if (remote.onboardingCompleted) markLocalOnboardingDone(normalized);
    const info = analyzeCortexCloudLocation(normalized);
    return {
      mode: remote.mode,
      info: { ...info, providerLabel: remote.providerLabel },
      onboardingCompleted: remote.onboardingCompleted || localOnboardingDone(normalized),
      sharedConfirm: remote.sharedConfirm,
    };
  } catch {
    return analyzeCortexPath(normalized);
  }
}

export async function persistSharedConfirm(cortexPath: string, shared: boolean): Promise<void> {
  markLocalOnboardingDone(normalizeCortexPath(cortexPath));
  try {
    await ipcCall('cloud.setSharedConfirm', { cortexDir: normalizeCortexPath(cortexPath), shared });
  } catch { /* pre-unlock — saved locally on next unlock */ }
}

export async function markOnboardingComplete(cortexPath: string): Promise<void> {
  const normalized = normalizeCortexPath(cortexPath);
  markLocalOnboardingDone(normalized);
  try {
    await ipcCall('cloud.completeOnboarding', { cortexDir: normalized });
  } catch { /* sidecar not up yet — localStorage covers until unlock */ }
}

/** Friendly busy-card payload for heartbeat-detected sessions. */
export function sessionBusyCard(state: CloudBusyState): {
  title: string;
  body: string;
  steps: string[];
} {
  const provider = state.providerLabel;
  const device = state.deviceName || state.hostname || 'another device';

  if (state.mode === 'shared-cloud') {
    return {
      title: "Graphnosis couldn't start on this folder",
      body: `Graphnosis on ${device} is using this shared ${provider} folder right now. Only one session can write at a time.`,
      steps: [
        `Ask them to quit Graphnosis on ${device} first.`,
        `Wait for ${provider} to finish syncing, then tap Try again.`,
        'If you are sure nobody else has it open, tap Continue on this Mac.',
      ],
    };
  }
  if (state.mode === 'personal-cloud') {
    return {
      title: "Graphnosis couldn't start on this folder",
      body: `Your memory on ${device} is still open in ${provider}. Graphnosis allows only one active session per folder.`,
      steps: [
        `Lock or quit Graphnosis on ${device}.`,
        `Give ${provider} a minute to sync, then tap Try again.`,
        'If you are sure no other device is using this folder, tap Continue on this Mac.',
      ],
    };
  }
  if (state.mode === 'ambiguous-cloud') {
    return {
      title: "Graphnosis couldn't start on this folder",
      body: `Graphnosis detected activity from ${device} in this cloud folder. Wait for the other session to close before opening here.`,
      steps: [
        'Quit Graphnosis on your other computer or device.',
        'Wait for your cloud folder to finish syncing.',
        'Tap Try again, or Continue on this Mac if you are certain nothing else is running.',
      ],
    };
  }
  return {
    title: "Graphnosis couldn't start on this folder",
    body: `Another Graphnosis session on ${device} is using this folder.`,
    steps: [
      'Quit any other Graphnosis window on this Mac.',
      'If you use Claude Desktop or another AI client with Graphnosis, quit it fully (⌘Q).',
      'Tap Try again, or Continue on this Mac if you are sure nothing else is running.',
    ],
  };
}

export function buildSessionBusyPayload(
  cortexPath: string,
  lease: SessionLease,
): CloudBusyState {
  const info = analyzeCortexCloudLocation(normalizeCortexPath(cortexPath));
  return {
    mode: info.mode === 'ambiguous-cloud' ? 'personal-cloud' : info.mode,
    providerLabel: info.providerLabel,
    deviceName: lease.deviceName,
    hostname: lease.hostname,
    variant: 'session',
  };
}

/** Mode-aware copy for Settings → Sync panel. */
export function syncPanelCopy(mode: CortexCloudMode, providerLabel: string): {
  headline: string;
  bullets: string[];
} {
  switch (mode) {
    case 'personal-cloud':
      return {
        headline: `Synced via ${providerLabel} (your account)`,
        bullets: [
          'Your cortex folder lives in a cloud-synced location on this Mac.',
          'Use the same folder path on your other devices signed into the same cloud account.',
          'Only open Graphnosis on one device at a time — lock before switching.',
        ],
      };
    case 'shared-cloud':
      return {
        headline: `Shared ${providerLabel} folder`,
        bullets: [
          'This cortex is in a folder shared with another account.',
          'Coordinate with collaborators — only one Graphnosis session should write at a time.',
          'Lock Graphnosis before someone else opens the folder on their device.',
        ],
      };
    case 'ambiguous-cloud':
      return {
        headline: `${providerLabel} folder — confirm sharing`,
        bullets: [
          'Graphnosis detected a cloud-synced folder but could not tell if it is personal or shared.',
          'Open onboarding from the lock screen to confirm, or move the cortex to a clearer location.',
        ],
      };
    default:
      return {
        headline: 'Local only',
        bullets: [
          'This cortex is not inside a known cloud-sync folder.',
          'To sync across devices, move or create the cortex inside iCloud Drive, Dropbox, Google Drive, or OneDrive.',
        ],
      };
  }
}

// ── Wizard UI ───────────────────────────────────────────────────────────────

let wizardScreen = 0;
let wizardMode: CortexCloudMode = 'local';
let wizardProvider = 'Cloud folder';
let wizardCortexPath = '';
let wizardResolve: ((proceed: boolean) => void) | null = null;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function wizardEls() {
  return {
    modal: $('cloud-onboarding-modal'),
    title: $('cloud-onboarding-title'),
    body: $('cloud-onboarding-body'),
    actions: $('cloud-onboarding-actions'),
    progress: $('cloud-onboarding-progress'),
  };
}

function setWizardProgress(screen: number, total: number): void {
  const { progress } = wizardEls();
  if (progress) progress.textContent = `Step ${screen + 1} of ${total}`;
}

function renderWizardScreen(screen: number): void {
  const { title, body, actions } = wizardEls();
  if (!title || !body || !actions) return;
  actions.replaceChildren();

  const total = wizardMode === 'local' ? 2 : 4;
  setWizardProgress(screen, total);

  const btn = (label: string, cls: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  if (screen === 0) {
    title.textContent = 'Your cortex location';
    if (wizardMode === 'local') {
      body.textContent = `This folder is on this Mac only — not inside a cloud-sync location. Graphnosis will store everything locally at:\n\n${wizardCortexPath}`;
      actions.append(btn('Continue', 'primary', () => { wizardScreen = 1; renderWizardScreen(1); }));
    } else {
      body.textContent = `Graphnosis detected your cortex inside ${wizardProvider}.\n\nMode: ${modeLabel(wizardMode)}\n\n${wizardCortexPath}`;
      actions.append(btn('Continue', 'primary', () => { wizardScreen = 1; renderWizardScreen(1); }));
    }
    return;
  }

  if (wizardMode === 'local') {
    if (screen === 1) {
      title.textContent = 'Ready to unlock';
      body.textContent = 'Your memory stays on this device. You can move the cortex to a cloud folder later from Settings → Sync.';
      actions.append(btn('Got it — unlock', 'primary', () => finishWizard(true)));
    }
    return;
  }

  if (screen === 1) {
    title.textContent = 'How sync works';
    body.textContent = syncHowItWorks(wizardMode, wizardProvider);
    actions.append(btn('Continue', 'primary', () => { wizardScreen = 2; renderWizardScreen(2); }));
    return;
  }

  if (screen === 2) {
    title.textContent = 'On this Mac';
    body.textContent =
      'Use your passphrase (or Touch ID after the first unlock) on this computer.\n\n' +
      `When you switch devices, lock Graphnosis here first and wait for ${wizardProvider} to finish syncing before opening on the other machine.`;
    actions.append(btn('Continue', 'primary', () => { wizardScreen = 3; renderWizardScreen(3); }));
    return;
  }

  if (screen === 3) {
    title.textContent = 'Before you unlock';
    body.textContent =
      '• Only one Graphnosis session writes to this cortex at a time.\n' +
      '• Lock Graphnosis before opening on another device.\n' +
      `• If unlock fails, wait for ${wizardProvider} to sync — then try again.\n` +
      '• Never force-release the lock while another device might still be running.';
    actions.append(btn('Got it — unlock', 'primary', () => finishWizard(true)));
  }
}

function modeLabel(mode: CortexCloudMode): string {
  switch (mode) {
    case 'personal-cloud': return 'Personal cloud sync (same account, multiple devices)';
    case 'shared-cloud': return 'Shared cloud folder (different accounts)';
    case 'ambiguous-cloud': return 'Cloud folder (confirm sharing on next step)';
    default: return 'Local only';
  }
}

function syncHowItWorks(mode: CortexCloudMode, provider: string): string {
  if (mode === 'personal-cloud') {
    return (
      `Your encrypted cortex lives in ${provider}. The same cloud account on each device sees the same folder.\n\n` +
      'Graphnosis does not upload your memory to our servers — the cloud service syncs the folder you chose.\n\n' +
      'Treat it like one notebook: only one person edits at a time. Lock here before unlocking elsewhere.'
    );
  }
  if (mode === 'shared-cloud') {
    return (
      `This cortex is in a ${provider} folder shared with someone else's account.\n\n` +
      'Both of you can see the folder, but Graphnosis allows only one active writer. Coordinate who has it open.\n\n' +
      'Lock your session before your collaborator unlocks on their device.'
    );
  }
  return (
    `This folder is in ${provider}, but Graphnosis could not tell if it is only yours or shared with another account.\n\n` +
    'If two people might open it, treat it as shared and take turns. If it is only your account across devices, you are syncing personally.'
  );
}

function finishWizard(proceed: boolean): void {
  const { modal } = wizardEls();
  modal?.classList.add('hidden');
  if (proceed) void markOnboardingComplete(wizardCortexPath);
  wizardResolve?.(proceed);
  wizardResolve = null;
}

/** Ambiguous cloud — ask user to confirm sharing. */
export function showSharedConfirmDialog(cortexPath: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const { modal, title, body, actions } = wizardEls();
    if (!modal || !title || !body || !actions) {
      resolve(null);
      return;
    }
    wizardCortexPath = normalizeCortexPath(cortexPath);
    const info = analyzeCortexCloudLocation(wizardCortexPath);
    wizardProvider = info.providerLabel;
    title.textContent = 'Is this folder shared?';
    body.textContent =
      `Graphnosis found your cortex in ${info.providerLabel} but cannot tell if the folder is shared with another account.\n\n` +
      'Is this folder shared with someone else (different login)?';
    actions.replaceChildren();
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'primary';
    yes.textContent = 'Yes — shared with another account';
    yes.addEventListener('click', () => {
      modal.classList.add('hidden');
      void persistSharedConfirm(wizardCortexPath, true);
      resolve(true);
    });
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn-secondary';
    no.textContent = 'No — only my devices';
    no.addEventListener('click', () => {
      modal.classList.add('hidden');
      void persistSharedConfirm(wizardCortexPath, false);
      resolve(false);
    });
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn-secondary';
    skip.textContent = 'Skip for now';
    skip.addEventListener('click', () => {
      modal.classList.add('hidden');
      resolve(null);
    });
    actions.append(yes, no, skip);
    modal.classList.remove('hidden');
  });
}

/**
 * Show the onboarding wizard when needed. Returns true if unlock should proceed.
 * Call before attemptUnlock when cortex path is set.
 */
export async function maybeShowCloudOnboarding(cortexPath: string): Promise<boolean> {
  const normalized = normalizeCortexPath(cortexPath);
  if (!normalized) return true;

  let state = analyzeCortexPath(normalized);
  if (state.mode === 'ambiguous-cloud') {
    const answer = await showSharedConfirmDialog(normalized);
    if (answer !== null) {
      state = analyzeCortexPath(normalized, answer);
    }
  }

  if (state.onboardingCompleted || state.mode === 'local') {
    return true;
  }

  return new Promise((resolve) => {
    const { modal } = wizardEls();
    if (!modal) {
      resolve(true);
      return;
    }
    wizardCortexPath = normalized;
    wizardMode = state.mode;
    wizardProvider = state.info.providerLabel;
    wizardScreen = 0;
    wizardResolve = resolve;
    renderWizardScreen(0);
    modal.classList.remove('hidden');
  });
}

/** Check heartbeat before unlock; returns true if busy (caller should stop unlock). */
export async function checkPreUnlockBusy(cortexPath: string): Promise<boolean> {
  const normalized = normalizeCortexPath(cortexPath);
  if (!normalized) return false;
  const { lease, fresh } = await readPreUnlockSessionLease(normalized);
  if (!fresh || !lease || !isSessionLeaseFresh(lease)) return false;

  const state = buildSessionBusyPayload(normalized, lease);
  const card = sessionBusyCard(state);
  showUnifiedBusyCard({
    variant: 'session',
    title: card.title,
    body: card.body,
    steps: card.steps,
    canReleaseLock: true,
    technicalDetails: `Session heartbeat from ${lease.deviceName} (${lease.hostname}), updated ${new Date(lease.updatedAt).toLocaleString()}.`,
  });
  return true;
}

export interface UnifiedBusyCardPayload {
  variant: 'local' | 'icloud' | 'cloud' | 'compromised' | 'session';
  title: string;
  body: string;
  steps: string[];
  technicalDetails?: string;
  canReleaseLock?: boolean;
  retryLabel?: string;
  releaseLabel?: string;
}

/** Show the unified busy/lock card (used by unlock.ts). */
export function showUnifiedBusyCard(payload: UnifiedBusyCardPayload): void {
  app().showError(null);
  const card = document.getElementById('cortex-lock-card');
  const titleEl = document.getElementById('cortex-lock-title');
  const bodyEl = document.getElementById('cortex-lock-body');
  const stepsEl = document.getElementById('cortex-lock-steps');
  const technicalEl = document.getElementById('cortex-lock-technical');
  const detailsEl = document.getElementById('cortex-lock-details');
  const releaseBtn = document.getElementById('btn-cortex-lock-release');
  const badge = document.getElementById('cortex-lock-mode-badge');
  if (!card || !titleEl || !bodyEl || !stepsEl) {
    app().showError(`${payload.title}\n\n${payload.body}`);
    return;
  }

  titleEl.textContent = payload.title;
  bodyEl.textContent = payload.body;
  stepsEl.replaceChildren(
    ...payload.steps.map((step) => {
      const li = document.createElement('li');
      li.textContent = step;
      return li;
    }),
  );
  if (technicalEl && detailsEl) {
    const tech = payload.technicalDetails?.trim() ?? '';
    technicalEl.textContent = tech || 'No additional details were captured.';
    detailsEl.classList.toggle('hidden', !tech);
  }
  if (releaseBtn) {
    releaseBtn.classList.toggle('hidden', !payload.canReleaseLock || !IS_TAURI);
    releaseBtn.textContent = payload.releaseLabel ?? 'Continue on this Mac';
  }
  const retryBtn = document.getElementById('btn-cortex-lock-retry');
  if (retryBtn) {
    retryBtn.textContent = payload.retryLabel ?? 'Try again';
  }
  if (badge) {
    const labels: Record<string, string> = {
      local: 'This Mac',
      icloud: 'Cloud sync',
      cloud: 'Cloud sync',
      compromised: 'Lock issue',
      session: 'Active elsewhere',
    };
    badge.textContent = labels[payload.variant] ?? 'Busy';
    badge.classList.remove('hidden');
  }
  card.classList.remove('hidden');
}

export function hideUnifiedBusyCard(): void {
  document.getElementById('cortex-lock-card')?.classList.add('hidden');
  document.getElementById('cortex-lock-mode-badge')?.classList.add('hidden');
  const details = document.getElementById('cortex-lock-details') as HTMLDetailsElement | null;
  if (details) details.open = false;
}

/** Refresh Settings → Sync panel (post-unlock). */
export async function refreshSyncSettingsPanel(cortexPath: string | null): Promise<void> {
  const panel = document.getElementById('settings-sync-panel');
  if (!panel || !cortexPath) {
    panel?.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const headline = document.getElementById('settings-sync-headline');
  const list = document.getElementById('settings-sync-bullets');
  const providerEl = document.getElementById('settings-sync-provider');
  if (!headline || !list) return;

  let state: CloudOnboardingState;
  try {
    state = await refreshCloudOnboardingFromSettings(cortexPath);
  } catch {
    state = analyzeCortexPath(cortexPath);
  }

  const copy = syncPanelCopy(state.mode, state.info.providerLabel);
  headline.textContent = copy.headline;
  if (providerEl) providerEl.textContent = state.info.providerLabel;
  list.replaceChildren(
    ...copy.bullets.map((b) => {
      const li = document.createElement('li');
      li.textContent = b;
      return li;
    }),
  );
}

export function initCloudOnboarding(): void {
  document.getElementById('btn-cloud-onboarding-replay')?.addEventListener('click', () => {
    const input = document.getElementById('cortex-dir') as HTMLInputElement | null;
    const path = input?.value.trim();
    if (!path) return;
    try { localStorage.removeItem(ONBOARDING_LS_PREFIX + normalizeCortexPath(path)); } catch { /* */ }
    void maybeShowCloudOnboarding(path);
  });
}

/** Location picker hints for create / choose cortex flow. */
export function cloudLocationChoiceCopy(): { title: string; options: Array<{ id: string; label: string; hint: string }> } {
  return {
    title: 'Where should your cortex live?',
    options: [
      { id: 'local', label: 'This Mac only', hint: 'Fastest — no cloud sync. Good default for a single machine.' },
      { id: 'personal-cloud', label: 'Personal cloud folder', hint: 'iCloud Drive, Dropbox, Google Drive, or OneDrive — same account on each device.' },
      { id: 'shared-cloud', label: 'Shared cloud folder', hint: 'A folder shared with another person\'s account — coordinate who has Graphnosis open.' },
    ],
  };
}

export function initCloudOnboardingHandlers(): void {
  initCloudOnboarding();
}
