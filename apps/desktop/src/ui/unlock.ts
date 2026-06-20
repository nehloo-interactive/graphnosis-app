/**
 * Unlock — lock screen flows (passphrase, biometric, WebAuthn).
 */
import { IS_TAURI, invoke, webauthnAuthenticate, webauthnRegister, webauthnStatus } from '../platform';
import { app } from './app-context';
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

export function initUnlock(unlockEls: Record<string, HTMLElement>): void {
  els = unlockEls;
  wireUnlockHandlers();
  wireCortexLockHandlers();
  wireLockHandler();
  void configureBiometricButton();
  void configureSsoUnlockButton();
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
  releaseBtn?.addEventListener('click', () => {
    const cortexDir = (els.cortexDir as HTMLInputElement).value.trim();
    if (!cortexDir) {
      app().showError('Choose a Graphnosis cortex folder first.');
      return;
    }
    const proceed = confirm(
      'Continue on this Mac?\n\n' +
      'Only do this if Graphnosis is closed on your other Mac and any connected AI apps.\n\n' +
      'Opening here while another session is still running can damage your memory.',
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

function wireUnlockHandlers(): void {
  const inlineBtn = document.getElementById('btn-touchid-inline') as HTMLButtonElement | null;
  const hint = document.getElementById('touchid-hint') as HTMLElement | null;
  const ssoBtn = document.getElementById('btn-sso-unlock') as HTMLButtonElement | null;
  inlineBtn?.addEventListener('click', () => void runBiometricUnlock());
  hint?.addEventListener('click', () => void runBiometricUnlock());
  ssoBtn?.addEventListener('click', () => void runSsoUnlock());

  (els.btnUnlock as HTMLButtonElement).addEventListener('click', async () => {
    app().showError(null);
    hideCortexLockCard();
    const cortexDir = getCortexDir();
    if (IS_TAURI && !cortexDir) {
      app().showError('Choose a Graphnosis cortex folder first.');
      return;
    }
    if (!(els.passphrase as HTMLInputElement).value) {
      if (IS_TAURI && await shouldOfferBiometricUnlock(cortexDir)) {
        await runBiometricUnlock();
        return;
      }
      const status = await probeBiometricStatus(cortexDir);
      app().showError(
        IS_TAURI
          ? (isTouchIdUiVisible()
            ? 'Use Touch ID or enter your cortex passphrase.'
            : biometricUnavailableMessage(status, false))
          : 'Enter your access token.',
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
    els.bootStatusText.textContent = '';
    app().render({ unlocked: true, cortex_dir: null, sidecar_running: true } as StatusSnapshot);
  } catch (e) {
    progressBar?.classList.add('hidden');
    els.bootStatusText.textContent = '';
    els.btnUnlock.disabled = false;
    if (waBtn) waBtn.disabled = false;
    app().showError(e instanceof Error ? e.message : String(e));
  }
}

/** After a browser token-unlock, offer to register this device for biometric
 *  unlock — once, only when available and none registered yet. */
let biometricSetupOffered = false;
async function maybeOfferBiometricSetup(): Promise<void> {
  if (IS_TAURI || biometricSetupOffered) return;
  biometricSetupOffered = true;
  let st: { available: boolean; registered: number };
  try { st = await webauthnStatus(); } catch { return; }
  if (!st.available || st.registered > 0) return;
  if (!confirm('Set up biometric / security-key unlock on this device, so you don\'t need to paste the access token next time?')) return;
  const tid = app().addIngestToast('Setting up biometric unlock', 'Follow your device\'s prompt…');
  try {
    await webauthnRegister('This device');
    app().finishIngestToast(tid, 'success', 'Biometric unlock enabled for this device.');
  } catch (e) {
    app().finishIngestToast(tid, 'error', `Setup failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function friendlyUnlockError(msg: string): string {
  if (/biometric authentication cancelled/i.test(msg)) {
    return 'Touch ID was cancelled. Try again or enter your cortex passphrase.';
  }
  if (/no saved passphrase for this cortex/i.test(msg)) {
    return 'Touch ID is not set up for this cortex yet. Unlock with your passphrase once to enable it.';
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
    app().showError('Enter your cortex passphrase.');
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
    const status = (await invoke('unlock_cortex', {
      args: {
        cortex_dir: getCortexDir(),
        passphrase: (els.passphrase as HTMLInputElement).value,
        preferred_default_graph: localStorage.getItem(app().LAST_ENGRAM_KEY) ?? null,
      },
    })) as StatusSnapshot;
    // Persist for the next launch — see app().rememberCortexDir().
    app().rememberCortexDir(getCortexDir());
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
      const proceed = confirm(
        `The folder "${path}" doesn't exist yet.\n\n` +
        `Create it now and continue unlocking?\n\n` +
        `(If this is a typo, click Cancel and edit the path.)`
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
