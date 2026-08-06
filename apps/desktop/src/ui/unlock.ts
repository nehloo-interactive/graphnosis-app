/**
 * Unlock — lock screen flows (passphrase, biometric, WebAuthn).
 */
import { IS_TAURI, invoke, webauthnAuthenticate, webauthnRegister, webauthnStatus } from '../platform';
import { app } from './app-context';
import { gConfirm } from './dialogs';
import type { BiometricStatus, StatusSnapshot } from './types';
import {
  analyzeCortexCloudLocation,
  checkPreUnlockBusy,
  hideUnifiedBusyCard,
  maybeShowCloudOnboarding,
  showUnifiedBusyCard,
} from './cloud-onboarding';

interface CortexLockRecoveryResult {
  recovered: boolean;
  reason?: 'stale_pid' | 'expired_lease' | 'manual';
  message?: string;
}

/** Silent pre-unlock heal — clears dead processes and expired leases only. */
async function tryPreUnlockHeal(cortexDir: string): Promise<void> {
  if (!IS_TAURI || !cortexDir) return;
  try {
    await invoke<CortexLockRecoveryResult>('recover_cortex_lock', {
      path: cortexDir,
      confirmTakeover: false,
    });
  } catch {
    // Non-fatal — unlock will surface a friendly card if still blocked.
  }
}

/** After unexpected sidecar exit, offer one-tap recovery on the lock screen. */
export function offerSidecarRecovery(): void {
  const cortexDir = getCortexDir();
  const cloudInfo = cortexDir ? analyzeCortexCloudLocation(cortexDir) : null;
  const provider = cloudInfo?.providerLabel ?? 'your cloud folder';
  showUnifiedBusyCard({
    variant: cloudInfo?.inCloudFolder ? 'cloud' : 'compromised',
    title: 'The memory engine stopped',
    body: cloudInfo?.inCloudFolder
      ? `Graphnosis couldn't keep running. This often happens after sleep, a sync delay in ${provider}, or if Graphnosis is open on another device.`
      : "Graphnosis couldn't keep running. This can happen after sleep or if the app didn't close cleanly.",
    steps: cloudInfo?.inCloudFolder
      ? [
        'If Graphnosis is open on another Mac, ask them to quit it first.',
        `Wait a minute for ${provider} to finish syncing.`,
        'Tap Restart memory to try again on this Mac.',
      ]
      : [
        'Make sure no other Graphnosis window is open on this Mac.',
        'Tap Restart memory to try again.',
        'If it still fails, tap Continue on this Mac when you are sure nothing else is running.',
      ],
    canReleaseLock: false,
    retryLabel: 'Restart memory',
    releaseLabel: 'Continue on this Mac',
  });
}

/** Populated by initUnlock() from main.ts `els`. */
let els!: Record<string, HTMLElement>;

const UI_ERROR_PREFIX = 'GRAPHNOSIS_UI_ERROR:';

/** True when the lock screen is in remote ("thin-client") mode: no local cortex
 *  folder, no local sidecar — unlock with an access token against a remote
 *  server, exactly like browser mode but inside the desktop window. Driven by
 *  the on-screen toggle (or forced by the GRAPHNOSIS_REMOTE_URL env override). */
let isRemoteMode = false;

const CORTEX_MODE_KEY = 'graphnosis:cortex-mode';
const REMOTE_URL_KEY = 'graphnosis:remote-url';

/** Current server URL typed on the lock screen (remote mode only). */
function getRemoteUrl(): string {
  return (document.getElementById('remote-url') as HTMLInputElement | null)?.value.trim() ?? '';
}

/** Switch the lock screen between local (folder + passphrase) and remote
 *  (server URL + access token), persisting the choice for the next launch. */
function setCortexMode(remote: boolean): void {
  isRemoteMode = remote;
  const title = document.getElementById('unlock-card-title');
  const cortexRow = document.querySelector('#unlock-form-card .row:has(#cortex-dir)') as HTMLElement | null;
  const remoteRow = document.getElementById('remote-server-row');
  const warning = document.querySelector('.passphrase-warning') as HTMLElement | null;
  const pass = els.passphrase as HTMLInputElement;
  const btnLocal = document.getElementById('mode-local');
  const btnRemote = document.getElementById('mode-remote');
  cortexRow?.classList.toggle('hidden', remote);
  remoteRow?.classList.toggle('hidden', !remote);
  // The passphrase warning is about the LOCAL cortex key — irrelevant remotely.
  warning?.classList.toggle('hidden', remote);
  // Touch ID unlocks a LOCAL cortex (it reads a cached passphrase for a cortex
  // folder). In remote mode there's no folder — hide every biometric affordance
  // so it can't fire the local unlock path against a stale folder value. When
  // returning to local, re-evaluate against the current folder.
  if (remote) {
    document.getElementById('btn-touchid-inline')?.classList.add('hidden');
    document.getElementById('touchid-hint')?.classList.add('hidden');
    document.getElementById('touchid-setup-hint')?.classList.add('hidden');
    // Show the REMOTE Touch ID button if a token is stored for this server.
    app().refreshRemoteBiometricButton(getRemoteUrl());
  } else {
    app().refreshRemoteBiometricButton(''); // hide remote affordance in local mode
    const cx = getCortexDir();
    if (cx) app().refreshBiometricButton(cx);
  }
  pass.placeholder = remote ? 'Access token' : 'Your Graphnosis cortex passphrase';
  pass.setAttribute('aria-label', remote ? 'Access token' : 'Passphrase');
  if (title) title.textContent = remote ? 'Connect to a remote cortex' : 'Unlock your local encrypted cortex';
  btnLocal?.classList.toggle('active', !remote);
  btnLocal?.setAttribute('aria-selected', String(!remote));
  btnRemote?.classList.toggle('active', remote);
  btnRemote?.setAttribute('aria-selected', String(remote));
  try { localStorage.setItem(CORTEX_MODE_KEY, remote ? 'remote' : 'local'); } catch { /* private mode */ }
}

/** Configure the local/remote selector. Browser mode is already server-backed,
 *  so the toggle is Tauri-only. When the shell is env-forced into remote mode
 *  (GRAPHNOSIS_REMOTE_URL), lock to remote and prefill the read-only address;
 *  otherwise reveal the toggle and restore the last-used server + mode. */
async function detectRuntimeMode(): Promise<void> {
  if (!IS_TAURI) return; // browser: token flow already applies; no toggle
  const toggle = document.getElementById('cortex-mode-toggle');
  const urlInput = document.getElementById('remote-url') as HTMLInputElement | null;
  let forced = false;
  let forcedBase: string | null = null;
  try {
    const mode = await invoke<{ forcedRemote: boolean; base: string | null }>('runtime_mode');
    forced = mode.forcedRemote;
    forcedBase = mode.base;
  } catch { /* non-fatal — treat as not forced */ }

  if (forced) {
    if (urlInput && forcedBase) { urlInput.value = forcedBase; urlInput.readOnly = true; }
    setCortexMode(true); // toggle stays hidden — remote is mandatory here
    return;
  }

  toggle?.classList.remove('hidden');
  if (urlInput) {
    try { urlInput.value = localStorage.getItem(REMOTE_URL_KEY) ?? ''; } catch { /* private mode */ }
    // Re-probe the remote Touch ID button as the user edits the server URL
    // (a token stored for one server shouldn't show for another).
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    urlInput.addEventListener('input', () => {
      if (!isRemoteMode) return;
      clearTimeout(probeTimer);
      // Re-check mode at fire time too: the user may switch to Local within the
      // debounce window, which would otherwise re-show the remote button.
      probeTimer = setTimeout(() => {
        if (!isRemoteMode) return;
        app().refreshRemoteBiometricButton(getRemoteUrl());
      }, 250);
    });
  }
  document.getElementById('mode-local')?.addEventListener('click', () => setCortexMode(false));
  document.getElementById('mode-remote')?.addEventListener('click', () => setCortexMode(true));
  let last: string | null = null;
  try { last = localStorage.getItem(CORTEX_MODE_KEY); } catch { /* private mode */ }
  setCortexMode(last === 'remote');
}

export function initUnlock(unlockEls: Record<string, HTMLElement>): void {
  els = unlockEls;
  wireUnlockHandlers();
  wireCortexLockHandlers();
  wireLockHandler();
  void configureBiometricButton();
  void configureSsoUnlockButton();
  void detectRuntimeMode();
}

interface CortexLockUiError {
  type: 'cortex_lock';
  variant: 'local' | 'icloud' | 'compromised';
  title: string;
  body: string;
  steps: string[];
  technicalDetails: string;
  canReleaseLock: boolean;
}

/** Show/hide Enterprise SSO unlock affordance from pre-unlock Tauri probe. */
export async function configureSsoUnlockButton(): Promise<void> {
  if (!IS_TAURI) return;
  const btn = document.getElementById('btn-sso-unlock') as HTMLButtonElement | null;
  const hint = document.getElementById('sso-unlock-hint') as HTMLElement | null;
  const passphraseRow = document.querySelector('#unlock-form-card .row:has(#passphrase)') as HTMLElement | null;
  const warning = document.querySelector('.passphrase-warning') as HTMLElement | null;
  if (!btn) return;
  const cortexDir = getCortexDir();
  if (!cortexDir) {
    btn.classList.add('hidden');
    if (hint) hint.classList.add('hidden');
    return;
  }
  try {
    const discover = await invoke<{
      configured: boolean;
      enabled: boolean;
      provisioned: boolean;
      idpReachable: boolean;
      idpReachabilityError?: string | null;
      suggestedButtonLabel: string;
      tenantHint?: string | null;
      breakGlassPassphrase: boolean;
      showButton: boolean;
      available: boolean;
      reason?: string | null;
    }>('discover_sso_unlock', { cortex_dir: cortexDir });

    if (discover.showButton) {
      btn.classList.remove('hidden');
      btn.textContent = discover.suggestedButtonLabel || 'Sign in with company account';
      if (!discover.available) {
        btn.disabled = true;
        btn.title = discover.reason === 'federated_key_not_provisioned'
          ? 'SSO is not fully provisioned yet — ask your admin to save SSO settings while unlocked'
          : 'SSO unlock is not ready on this device';
      } else {
        btn.disabled = false;
        btn.title = '';
      }
      if (hint) {
        if (!discover.idpReachable) {
          hint.textContent = discover.idpReachabilityError
            ?? 'Connect to your company network to sign in';
          hint.classList.remove('hidden');
        } else if (!discover.provisioned) {
          hint.textContent = 'SSO is configured — your admin must save settings once while unlocked to enable sign-in.';
          hint.classList.remove('hidden');
        } else {
          hint.classList.add('hidden');
        }
      }
      if (!discover.breakGlassPassphrase) {
        if (passphraseRow) passphraseRow.classList.add('hidden');
        if (warning) warning.classList.add('hidden');
      } else {
        if (passphraseRow) passphraseRow.classList.remove('hidden');
        if (warning) warning.classList.remove('hidden');
      }
    } else {
      btn.classList.add('hidden');
      if (hint) hint.classList.add('hidden');
      if (passphraseRow) passphraseRow.classList.remove('hidden');
      if (warning) warning.classList.remove('hidden');
    }
  } catch {
    btn.classList.add('hidden');
    if (hint) hint.classList.add('hidden');
  }
}

/** Federated OIDC unlock — system browser + loopback callback via Tauri. */
export async function runSsoUnlock(): Promise<void> {
  if (!IS_TAURI) return;
  const cortexDir = getCortexDir();
  if (!cortexDir) {
    app().showError('Choose a Graphnosis cortex folder first.');
    return;
  }
  app().showError(null);
  hideCortexLockCard();
  await tryPreUnlockHeal(cortexDir);
  if (await checkPreUnlockBusy(cortexDir)) return;
  const proceed = await maybeShowCloudOnboarding(cortexDir);
  if (!proceed) return;

  try {
    const discover = await invoke<{
      idpReachable: boolean;
      idpReachabilityError?: string | null;
      available: boolean;
      breakGlassPassphrase: boolean;
    }>('discover_sso_unlock', { cortex_dir: cortexDir });
    if (!discover.available) {
      app().showError(
        'SSO unlock is not ready on this device. Ask your admin to save Enterprise SSO settings once while unlocked.',
      );
      return;
    }
    if (!discover.idpReachable) {
      const msg = discover.idpReachabilityError ?? 'Connect to your company network to sign in';
      if (!discover.breakGlassPassphrase) {
        app().showError(msg);
        return;
      }
      app().showError(`${msg} — or enter your break-glass passphrase below.`);
      return;
    }
  } catch {
    // Non-fatal — listener will probe again before opening the browser.
  }

  const btn = document.getElementById('btn-sso-unlock') as HTMLButtonElement | null;
  els.btnUnlock.disabled = true;
  if (btn) btn.disabled = true;
  const progressBar = document.getElementById('unlock-progress');
  progressBar?.classList.remove('hidden');
  els.unlockStatus.classList.remove('hidden');
  els.bootStatusText.textContent = 'Opening company sign-in…';
  try {
    const status = await invoke<StatusSnapshot>('sso_unlock_cortex', {
      cortex_dir: cortexDir,
      preferred_default_graph: localStorage.getItem(app().LAST_ENGRAM_KEY) ?? null,
    });
    app().rememberCortexDir(cortexDir);
    (els.passphrase as HTMLInputElement).value = '';
    els.bootStatusText.textContent = '';
    hideCortexLockCard();
    app().render(status);
  } catch (e) {
    handleUnlockFailure(String(e));
    els.bootStatusText.textContent = '';
  } finally {
    if (btn) btn.disabled = false;
    if (!app().getUnlockPending()) els.btnUnlock.disabled = false;
    progressBar?.classList.add('hidden');
    if (!app().getUnlockPending()) els.unlockStatus.classList.add('hidden');
  }
}

/** Lock cortex — transition UI immediately, finish shutdown in the background. */
async function lockCortex(): Promise<void> {
  const btn = els.btnLock as HTMLButtonElement | undefined;
  const locked: StatusSnapshot = { unlocked: false, cortex_dir: null, sidecar_running: false };
  const origLabel = btn?.textContent ?? 'Lock cortex';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Locking…';
  }
  // Belt-and-suspenders: Rust also emits graphnosis://status before shutdown,
  // but paint now so Lock never feels dead on a slow graceful shutdown.
  app().render(locked);
  document.body.classList.remove('remote-cortex');
  try {
    const status = await invoke<StatusSnapshot>('lock_cortex');
    app().render(status);
  } catch (e) {
    app().showError(String(e));
    try {
      app().render(await invoke<StatusSnapshot>('status'));
    } catch { /* best effort — keep lock screen if status read fails */ }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }
}

function wireLockHandler(): void {
  const btn = els.btnLock as HTMLButtonElement | undefined;
  if (!btn) return;
  btn.addEventListener('click', () => void lockCortex());
}

/** Probe Touch ID availability and show/hide lock-screen affordances. */
export async function configureBiometricButton(): Promise<void> {
  if (isRemoteMode) return; // Touch ID is local-only; never offer it remotely
  const cortexDir = getCortexDir();
  if (cortexDir) app().refreshBiometricButton(cortexDir);
}

function parseCortexLockUiError(msg: string): CortexLockUiError | null {
  const idx = msg.indexOf(UI_ERROR_PREFIX);
  if (idx === -1) return null;
  try {
    const parsed = JSON.parse(msg.slice(idx + UI_ERROR_PREFIX.length)) as CortexLockUiError;
    return parsed.type === 'cortex_lock' ? parsed : null;
  } catch {
    return null;
  }
}

function hideCortexLockCard(): void {
  hideUnifiedBusyCard();
}

function showCortexLockCard(payload: CortexLockUiError): void {
  const cortexDir = getCortexDir();
  const cloudInfo = cortexDir ? analyzeCortexCloudLocation(cortexDir) : null;
  const variant = payload.variant === 'icloud'
    ? 'cloud'
    : (payload.variant as 'local' | 'cloud' | 'compromised');
  let steps = payload.steps;
  if (cloudInfo?.inCloudFolder && payload.variant !== 'local') {
    const provider = cloudInfo.providerLabel;
    steps = steps.map((s) => s.replace(/iCloud/gi, provider).replace(/icloud/gi, provider));
  }
  showUnifiedBusyCard({
    variant,
    title: payload.title,
    body: payload.body,
    steps,
    technicalDetails: payload.technicalDetails,
    canReleaseLock: payload.canReleaseLock,
  });
  if (cortexDir) app().refreshBiometricButton(cortexDir);
}

function getCortexDir(): string {
  return (els.cortexDir as HTMLInputElement).value.trim();
}

/** Probe Touch ID readiness for the given cortex path. */
async function probeBiometricStatus(cortexDir: string): Promise<BiometricStatus | null> {
  if (!IS_TAURI || !cortexDir) return null;
  try {
    return await invoke<BiometricStatus>('biometric_available', { cortexDir });
  } catch {
    return null;
  }
}

/** True when the lock screen is already showing Touch ID affordances. */
function isTouchIdUiVisible(): boolean {
  const inlineBtn = document.getElementById('btn-touchid-inline');
  const hint = document.getElementById('touchid-hint');
  return Boolean(
    (inlineBtn && !inlineBtn.classList.contains('hidden'))
    || (hint && !hint.classList.contains('hidden')),
  );
}

/** Same precondition as the inline Touch ID button — hardware + keychain entry. */
async function shouldOfferBiometricUnlock(cortexDir: string): Promise<boolean> {
  if (isTouchIdUiVisible()) return true;
  const status = await probeBiometricStatus(cortexDir);
  return status?.available ?? false;
}

function biometricUnavailableMessage(status: BiometricStatus | null, lockWasReleased: boolean): string {
  if (status?.hint) return status.hint;
  if (lockWasReleased) {
    return 'Lock released. Enter your cortex passphrase and click Unlock, or use Touch ID.';
  }
  if (isTouchIdUiVisible()) {
    return 'Could not unlock yet. Try Touch ID again or enter your cortex passphrase.';
  }
  return 'Enter your cortex passphrase and click Unlock.';
}

/** After clearing or bypassing a cortex lock, retry unlock using the same
 *  credential paths as the main lock screen (passphrase field or Touch ID). */
async function retryUnlockAfterCortexLockAction(lockWasReleased = false): Promise<void> {
  const cortexDir = getCortexDir();
  if (!cortexDir) {
    app().showError('Choose a Graphnosis cortex folder first.');
    return;
  }
  app().refreshBiometricButton(cortexDir);

  if ((els.passphrase as HTMLInputElement).value) {
    await attemptUnlock();
    return;
  }
  if (await shouldOfferBiometricUnlock(cortexDir)) {
    await runBiometricUnlock();
    return;
  }
  const status = await probeBiometricStatus(cortexDir);
  app().showError(
    IS_TAURI
      ? biometricUnavailableMessage(status, lockWasReleased)
      : 'Enter your access token and click Unlock.',
  );
}

function wireCortexLockHandlers(): void {
  const retryBtn = document.getElementById('btn-cortex-lock-retry');
  const releaseBtn = document.getElementById('btn-cortex-lock-release');
  retryBtn?.addEventListener('click', () => {
    hideCortexLockCard();
    void retryUnlockAfterCortexLockAction(false);
  });
  releaseBtn?.addEventListener('click', async () => {
    const cortexDir = (els.cortexDir as HTMLInputElement).value.trim();
    if (!cortexDir) {
      app().showError('Choose a Graphnosis cortex folder first.');
      return;
    }
    const proceed = await gConfirm(
      'Continue on this Mac?',
      'Only do this if Graphnosis is closed on your other Mac and any connected AI apps. '
      + 'Opening here while another session is still running can damage your memory.',
    );
    if (!proceed) return;
    void (async () => {
      releaseBtn.setAttribute('disabled', 'true');
      try {
        const result = await invoke<CortexLockRecoveryResult>('recover_cortex_lock', {
          path: cortexDir,
          confirmTakeover: true,
        });
        if (!result.recovered) {
          app().showError(
            result.message ?? 'Graphnosis may still be running on another device. Ask them to quit first.',
          );
          return;
        }
        hideCortexLockCard();
        await retryUnlockAfterCortexLockAction(true);
      } catch (e) {
        app().showError(`Could not continue on this Mac: ${String(e)}`);
      } finally {
        releaseBtn.removeAttribute('disabled');
      }
    })();
  });
}

// same flow: spawn the Swift sidecar for biometric auth, read the cached
// passphrase, run the normal unlock.
export async function runBiometricUnlock(): Promise<void> {
  // Touch ID reads a cached passphrase for a LOCAL cortex folder — meaningless
  // for a remote server, and it would fire the local unlock path against a
  // stale folder value ("cortex folder does not exist"). Belt to the UI hiding.
  if (isRemoteMode) {
    app().showError('Touch ID unlocks a local cortex. For the remote server, enter your access token.');
    return;
  }
  const cortexDir = getCortexDir();
  if (!cortexDir) {
    app().showError('Choose a Graphnosis cortex folder first.');
    return;
  }
  app().showError(null);
  hideCortexLockCard();
  await tryPreUnlockHeal(cortexDir);
  const inlineBtn = document.getElementById('btn-touchid-inline') as HTMLButtonElement | null;
  if (inlineBtn) inlineBtn.disabled = true;
  els.btnUnlock.disabled = true;
  const progressBar = document.getElementById('unlock-progress');
  progressBar?.classList.remove('hidden');
  els.bootStatusText.textContent = 'Touch the sensor…';
  els.unlockStatus.classList.remove('hidden');
  try {
    const status = await invoke<StatusSnapshot>('biometric_unlock', {
      cortexDir,
      preferredDefaultGraph: localStorage.getItem(app().LAST_ENGRAM_KEY) ?? null,
    });
    app().rememberCortexDir(cortexDir);
    (els.passphrase as HTMLInputElement).value = '';
    els.bootStatusText.textContent = '';
    app().render(status);
  } catch (e) {
    handleUnlockFailure(String(e));
    els.bootStatusText.textContent = '';
  } finally {
    if (inlineBtn) inlineBtn.disabled = false;
    if (!app().getUnlockPending()) els.btnUnlock.disabled = false;
    progressBar?.classList.add('hidden');
    if (!app().getUnlockPending()) els.unlockStatus.classList.add('hidden');
  }
}

// ── Remote-server Touch ID (token behind biometric) ──────────────────────────
// A parallel path to the LOCAL biometric_unlock: the LOCAL guard stays intact
// (runBiometricUnlock bails in remote mode); only this token path is allowed
// when the cortex is remote.

const REMOTE_BIOMETRIC_ENROLL_PREFIX = 'graphnosis:remote-biometric-enrolled:';

function clearRemoteEnrollFlag(serverUrl: string): void {
  try { localStorage.removeItem(REMOTE_BIOMETRIC_ENROLL_PREFIX + serverUrl); } catch { /* private mode */ }
}

/** Remove a server's saved Touch ID token (local convenience copy) and reset
 *  the enroll flag so it can be re-offered. Wired to the lock-screen "Forget"
 *  control, honoring the enrollment prompt's promise. */
export async function forgetRemoteToken(serverUrl: string): Promise<void> {
  const url = (serverUrl || getRemoteUrl()).trim();
  if (!url) return;
  try { await invoke('clear_remote_token', { serverUrl: url }); } catch { /* best-effort */ }
  clearRemoteEnrollFlag(url);
  app().refreshRemoteBiometricButton(url); // no token now → hides the affordance
}

/** True when the REMOTE Touch ID affordances are on screen. */
function isRemoteTouchIdUiVisible(): boolean {
  const btn = document.getElementById('btn-touchid-remote-inline');
  const hint = document.getElementById('touchid-remote-hint');
  return Boolean(
    (btn && !btn.classList.contains('hidden')) || (hint && !hint.classList.contains('hidden')),
  );
}

/** Whether remote Touch ID is offerable: a token is stored for this server AND
 *  biometric hardware is enrolled. The probe never triggers the biometric. */
async function shouldOfferRemoteBiometricUnlock(serverUrl: string): Promise<boolean> {
  if (!IS_TAURI || !serverUrl) return false;
  if (isRemoteTouchIdUiVisible()) return true;
  try {
    const s = await invoke<{ available: boolean }>('biometric_remote_available', { serverUrl });
    return s.available;
  } catch { return false; }
}

/** Touch ID unlock of a REMOTE cortex — biometric-gated retrieval of the stored
 *  token, then the normal remote unlock. Guarded to remote mode. */
export async function runRemoteBiometricUnlock(): Promise<void> {
  if (!isRemoteMode) return;
  const serverUrl = getRemoteUrl();
  if (!serverUrl) { app().showError('Enter your Graphnosis server address.'); return; }
  app().showError(null);
  hideCortexLockCard();
  const inlineBtn = document.getElementById('btn-touchid-remote-inline') as HTMLButtonElement | null;
  if (inlineBtn) inlineBtn.disabled = true;
  els.btnUnlock.disabled = true;
  const progressBar = document.getElementById('unlock-progress');
  progressBar?.classList.remove('hidden');
  els.bootStatusText.textContent = 'Touch the sensor…';
  els.unlockStatus.classList.remove('hidden');
  try {
    const status = await invoke<StatusSnapshot>('biometric_remote_unlock', {
      serverUrl,
      preferredDefaultGraph: localStorage.getItem(app().LAST_ENGRAM_KEY) ?? null,
    });
    try { localStorage.setItem(REMOTE_URL_KEY, serverUrl); } catch { /* private mode */ }
    (els.passphrase as HTMLInputElement).value = '';
    els.bootStatusText.textContent = '';
    document.body.classList.add('remote-cortex');
    app().render(status);
  } catch (e) {
    handleUnlockFailure(String(e));
    els.bootStatusText.textContent = '';
    // A stale token is cleared server-side by the Rust command → drop the enroll
    // flag too so a fresh token re-offers Touch ID, and re-probe to hide the
    // now-defunct button.
    clearRemoteEnrollFlag(getRemoteUrl());
    void app().refreshRemoteBiometricButton(getRemoteUrl());
  } finally {
    if (inlineBtn) inlineBtn.disabled = false;
    if (!app().getUnlockPending()) els.btnUnlock.disabled = false;
    progressBar?.classList.add('hidden');
    if (!app().getUnlockPending()) els.unlockStatus.classList.add('hidden');
  }
}

/** After a successful remote token unlock, offer ONCE per server to save the
 *  token behind Touch ID. Must run while the token field is still populated. */
async function maybeOfferSaveRemoteToken(serverUrl: string, token: string): Promise<void> {
  if (!IS_TAURI || !isRemoteMode || !serverUrl || !token) return;
  const flagKey = REMOTE_BIOMETRIC_ENROLL_PREFIX + serverUrl;
  try { if (localStorage.getItem(flagKey)) return; } catch { /* private mode */ }
  let hardware = false;
  try {
    const s = await invoke<{ hardware_available: boolean; has_saved_passphrase: boolean }>(
      'biometric_remote_available', { serverUrl });
    if (s.has_saved_passphrase) { // already enrolled for this server
      try { localStorage.setItem(flagKey, '1'); } catch { /* private mode */ }
      return;
    }
    hardware = s.hardware_available;
  } catch { return; }
  if (!hardware) return;
  // Ask only once per server, whatever the answer.
  try { localStorage.setItem(flagKey, '1'); } catch { /* private mode */ }
  const ok = await gConfirm(
    'Unlock this server with Touch ID?',
    'Store this server’s access token securely on this Mac and unlock it with Touch ID next '
    + 'time, instead of pasting the token. You can remove it anytime with the Forget button on the lock screen.',
  );
  if (!ok) return;
  try {
    await invoke('store_remote_token', { serverUrl, token });
    void app().refreshRemoteBiometricButton(serverUrl);
  } catch (e) {
    app().showError(`Could not enable Touch ID for this server: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function wireUnlockHandlers(): void {
  const inlineBtn = document.getElementById('btn-touchid-inline') as HTMLButtonElement | null;
  const hint = document.getElementById('touchid-hint') as HTMLElement | null;
  const ssoBtn = document.getElementById('btn-sso-unlock') as HTMLButtonElement | null;
  const remoteInlineBtn = document.getElementById('btn-touchid-remote-inline') as HTMLButtonElement | null;
  const remoteHint = document.getElementById('touchid-remote-hint') as HTMLElement | null;
  const remoteForgetBtn = document.getElementById('touchid-remote-forget') as HTMLButtonElement | null;
  inlineBtn?.addEventListener('click', () => void runBiometricUnlock());
  hint?.addEventListener('click', () => void runBiometricUnlock());
  ssoBtn?.addEventListener('click', () => void runSsoUnlock());
  remoteInlineBtn?.addEventListener('click', () => void runRemoteBiometricUnlock());
  remoteHint?.addEventListener('click', () => void runRemoteBiometricUnlock());
  remoteForgetBtn?.addEventListener('click', () => void forgetRemoteToken(getRemoteUrl()));

  (els.btnUnlock as HTMLButtonElement).addEventListener('click', async () => {
    app().showError(null);
    hideCortexLockCard();
    const cortexDir = getCortexDir();
    // Remote mode has no local folder — treat it like browser mode (token only),
    // but it does need a server address.
    if (IS_TAURI && !isRemoteMode && !cortexDir) {
      app().showError('Choose a Graphnosis cortex folder first.');
      return;
    }
    if (IS_TAURI && isRemoteMode && !getRemoteUrl()) {
      app().showError('Enter your Graphnosis server address.');
      return;
    }
    if (!(els.passphrase as HTMLInputElement).value) {
      if (IS_TAURI && !isRemoteMode && await shouldOfferBiometricUnlock(cortexDir)) {
        await runBiometricUnlock();
        return;
      }
      // Remote mode: empty token but a Touch ID token stored → use it.
      if (IS_TAURI && isRemoteMode && await shouldOfferRemoteBiometricUnlock(getRemoteUrl())) {
        await runRemoteBiometricUnlock();
        return;
      }
      const status = await probeBiometricStatus(cortexDir);
      app().showError(
        IS_TAURI && !isRemoteMode
          ? (isTouchIdUiVisible()
            ? 'Use Touch ID or enter your cortex passphrase.'
            : biometricUnavailableMessage(status, false))
          : (isRemoteMode && isRemoteTouchIdUiVisible()
            ? 'Use Touch ID or enter your access token.'
            : 'Enter your access token.'),
      );
      return;
    }
    await attemptUnlock();
  });
}

/**
 * Run the unlock flow. Extracted from the click handler so we can re-call
 * it after the user confirms "create the missing folder" without rebuilding
 * the click handler's pre-flight checks.
 */
// ── A8 — biometric / security-key unlock (browser mode only) ─────────────────

/** Authenticate with a registered WebAuthn device. On success the session is
 *  minted server-side; render the unlocked state (same transition the token
 *  unlock uses in browser mode). */
export async function webauthnUnlock(): Promise<void> {
  const waBtn = document.getElementById('btn-webauthn-unlock') as HTMLButtonElement | null;
  els.btnUnlock.disabled = true;
  if (waBtn) waBtn.disabled = true;
  const progressBar = document.getElementById('unlock-progress');
  progressBar?.classList.remove('hidden');
  els.unlockStatus.classList.remove('hidden');
  els.bootStatusText.textContent = 'Verifying…';
  try {
    await webauthnAuthenticate();
    // This device evidently holds a usable credential — never re-offer setup.
    markWebauthnDeviceRegistered();
    els.bootStatusText.textContent = '';
    app().render({ unlocked: true, cortex_dir: null, sidecar_running: true } as StatusSnapshot);
  } catch (e) {
    progressBar?.classList.add('hidden');
    els.bootStatusText.textContent = '';
    els.btnUnlock.disabled = false;
    if (waBtn) waBtn.disabled = false;
    const msg = e instanceof Error ? e.message : String(e);
    // iOS surfaces "the request is not allowed…" (NotAllowedError) when the
    // only matching passkey lives on another device and the user dismissed
    // the cross-device QR sheet. Point them at the recovery path instead of
    // echoing the cryptic platform error.
    app().showError(/not allowed by the user agent/i.test(msg)
      ? 'No usable passkey on this device — it may be registered on another machine. '
        + 'Unlock with the access token once, and you\'ll be offered Face ID setup for this device.'
      : msg);
  }
}

/** After a browser token-unlock, offer to register THIS device for biometric
 *  unlock — once per device. Gated on a per-device localStorage flag, NOT the
 *  server's global registered count: a passkey registered on another machine
 *  doesn't help this one (credentials don't always sync across devices), and
 *  the old `registered > 0` gate locked every additional device out of setup
 *  forever — their only auth path became the cross-device QR flow. */
const WEBAUTHN_DEVICE_KEY = 'graphnosis:webauthn-device-registered';
export function markWebauthnDeviceRegistered(): void {
  try { localStorage.setItem(WEBAUTHN_DEVICE_KEY, '1'); } catch { /* private mode */ }
}
let biometricSetupOffered = false;
async function maybeOfferBiometricSetup(): Promise<void> {
  if (IS_TAURI || biometricSetupOffered) return;
  biometricSetupOffered = true;
  let st: { available: boolean; registered: number };
  try { st = await webauthnStatus(); } catch { return; }
  if (!st.available) return;
  try { if (localStorage.getItem(WEBAUTHN_DEVICE_KEY) === '1') return; } catch { /* private mode */ }
  const body = st.registered > 0
    ? 'A passkey exists for this cortex, but it lives on another device. Set up Face ID / biometric unlock on THIS device too, so you don\'t need the access token here?'
    : 'Set up biometric / security-key unlock on this device, so you don\'t need to paste the access token next time?';
  if (!(await gConfirm('Set up biometric unlock?', body))) return;
  const tid = app().addIngestToast('Setting up biometric unlock', 'Follow your device\'s prompt…');
  try {
    await webauthnRegister('This device');
    markWebauthnDeviceRegistered();
    app().finishIngestToast(tid, 'success', 'Biometric unlock enabled for this device.');
  } catch (e) {
    app().finishIngestToast(tid, 'error', `Setup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function friendlyUnlockError(msg: string): string {
  if (/biometric authentication cancelled/i.test(msg)) {
    return 'Touch ID was canceled. Try again or enter your cortex passphrase.';
  }
  if (/no saved passphrase for this cortex/i.test(msg)) {
    return 'Touch ID is not set up for this cortex yet. Unlock with your passphrase once to enable it.';
  }
  if (/Touch ID used a stale saved passphrase/i.test(msg)) {
    return msg;
  }
  if (/company network|idp unreachable|idp_unreachable/i.test(msg)) {
    return msg;
  }
  if (/organization mismatch|tenant_mismatch|issuer_mismatch/i.test(msg)) {
    return msg;
  }
  if (/SSO credentials are not stored/i.test(msg)) {
    return 'SSO is not set up on this Mac yet. Ask your admin to save Enterprise SSO settings once while unlocked on this device — or use your break-glass passphrase.';
  }
  if (/Missing env var:\s*GRAPHNOSIS_PASSPHRASE/i.test(msg)
    || (/missing configuration value/i.test(msg) && /GRAPHNOSIS_PASSPHRASE/i.test(msg))) {
    return IS_TAURI
      ? 'Enter your cortex passphrase and try again.'
      : 'Enter your access token and try again.';
  }
  return msg;
}

function handleUnlockFailure(msg: string): void {
  const lockError = parseCortexLockUiError(msg);
  if (lockError) {
    showCortexLockCard(lockError);
    return;
  }
  app().showError(friendlyUnlockError(msg));
}

export async function attemptUnlock(): Promise<void> {
  if (IS_TAURI && !(els.passphrase as HTMLInputElement).value) {
    app().showError(isRemoteMode ? 'Enter your access token.' : 'Enter your cortex passphrase.');
    return;
  }

  const cortexDir = getCortexDir();
  if (IS_TAURI && cortexDir) {
    await tryPreUnlockHeal(cortexDir);
    if (await checkPreUnlockBusy(cortexDir)) return;
    const proceed = await maybeShowCloudOnboarding(cortexDir);
    if (!proceed) return;
  }

  els.btnUnlock.disabled = true;
  hideCortexLockCard();
  app().showError(null);
  els.bootStatusText.textContent = 'Starting synapse…';
  // Indeterminate progress bar — the unlock has several variable-duration
  // steps (Argon2id key derivation, sidecar spawn, embedding-worker init,
  // engram loads). We don't have meaningful percentages, but a moving bar
  // tells the user something IS happening so they don't second-guess the
  // click and try to mash the button again.
  const progressBar = document.getElementById('unlock-progress');
  progressBar?.classList.remove('hidden');
  // Boot-status line: cleared then shown live as sidecar boot events arrive.
  els.bootStatusText.textContent = '';
  els.unlockStatus.classList.remove('hidden');
  try {
    const remoteUrl = isRemoteMode ? getRemoteUrl() : '';
    // Capture the token before the field is wiped — needed for the Touch ID
    // save offer below.
    const remoteToken = (els.passphrase as HTMLInputElement).value;
    const status = (await invoke('unlock_cortex', {
      args: {
        cortex_dir: getCortexDir(),
        passphrase: (els.passphrase as HTMLInputElement).value,
        preferred_default_graph: localStorage.getItem(app().LAST_ENGRAM_KEY) ?? null,
        remote_url: remoteUrl || null,
      },
    })) as StatusSnapshot;
    // Persist for the next launch. In remote mode there's no local folder to
    // remember, but do remember the server URL so it's pre-filled next time.
    if (isRemoteMode) {
      if (remoteUrl) { try { localStorage.setItem(REMOTE_URL_KEY, remoteUrl); } catch { /* private mode */ } }
    } else {
      app().rememberCortexDir(getCortexDir());
    }
    // Tag the document so local-only affordances (Finder actions, Touch ID)
    // hide themselves when the cortex lives on a remote server.
    document.body.classList.toggle('remote-cortex', isRemoteMode);
    // A different cortex just opened — its non-deterministic preferences
    // (GNN, Local LLM) live in its own settings.json and are reloaded by the
    // fresh sidecar. Clear any half-finished two-step enable-confirm so it
    // can't leak from the previous cortex into this one.
    app().setNnConfirmPending(false);
    app().setNnEnablingInProgress(false);
    app().setLlmConfirmPending(false);
    els.passphrase.value = '';
    els.bootStatusText.textContent = '';
    hideCortexLockCard();
    app().render(status);
    // Offer biometric setup once, after a successful browser token-unlock.
    void maybeOfferBiometricSetup();
    // Remote mode: offer to save the token behind Touch ID (once per server).
    if (isRemoteMode && remoteUrl) void maybeOfferSaveRemoteToken(remoteUrl, remoteToken);
  } catch (e) {
    const msg = String(e);
    // Auto-unlock (QR / ?token=) failed — reveal the lock form again so the
    // user can correct the token. No-op in normal (non-auto) unlock flows.
    document.body.classList.remove('browser-auto-unlock');
    const sub0 = document.getElementById('subtitle');
    if (sub0 && !IS_TAURI) sub0.textContent = 'Your local encrypted memory, indexed for deterministic recall — auditable';
    // First-run friendly: if the cortex folder doesn't exist, don't dead-
    // end — offer to create it on the spot. The Rust error has the form
    // "cortex folder does not exist: <path>"; we parse and confirm.
    const missingPrefix = 'cortex folder does not exist:';
    const lacksPrefix = msg.indexOf(missingPrefix);
    if (lacksPrefix !== -1) {
      const path = msg.slice(lacksPrefix + missingPrefix.length).trim();
      els.bootStatusText.textContent = '';
      progressBar?.classList.add('hidden');
      els.btnUnlock.disabled = false;
      const proceed = await gConfirm(
        'Create cortex folder?',
        `The folder "${path}" doesn't exist yet. Create it now and continue unlocking? `
        + '(If this is a typo, click Cancel and edit the path.)',
      );
      if (!proceed) return;
      try {
        await invoke('create_cortex_dir', { path });
      } catch (createErr) {
        app().showError(`Couldn't create folder: ${String(createErr)}`);
        return;
      }
      // Retry unlock now that the folder exists. Re-enter attemptUnlock
      // (rather than recursing inline) so the progress bar + status state
      // cycle through cleanly.
      await attemptUnlock();
      return;
    }
    handleUnlockFailure(msg);
    els.bootStatusText.textContent = '';
  } finally {
    if (!app().getUnlockPending()) els.btnUnlock.disabled = false;
    progressBar?.classList.add('hidden');
    if (!app().getUnlockPending()) els.unlockStatus.classList.add('hidden');
  }
}
