/**
 * Settings — preferences modal, settings pane, theme, consent, billing, LLM prefs.
 * Extracted from main.ts (ui-modularize Batch 7).
 */
import { listen } from '@tauri-apps/api/event';
import { invoke } from '../platform';
import { app, el, type QuarantineConfirmOptions } from './app-context';
import { gAlert } from './dialogs';
import { ipcCall } from './ipc';
import { renderSettingsGraphsList } from './settings-graphs';
import { escape, escapeHtml, formatBytes } from './util';
import type { ContentCacheMode, ForgetMode } from './types';

export type UiTheme = 'auto' | 'light' | 'dark';
type InspectorDetail = 'simple' | 'detailed';

interface AppSettings {
  contentCache: { mode: ContentCacheMode; maxBytesPerSource: number };
  forget: { mode: ForgetMode };
  mcpRelay: { initialWaitMs: number; reconnectMs: number };
  ui: { inspectorDetail: InspectorDetail; theme?: UiTheme; defaultLandingMode?: string };
  ai: NonNullable<Record<string, unknown>> & {
    useAsDefaultMemory?: boolean;
    autoReingestOnFileChange?: boolean;
    reingestQuietMs?: number;
    chunkSize?: string;
    embedBatch?: string;
    embedWorkers?: number;
    consentIntervalPersonalMs?: number;
    consentIntervalSensitiveMs?: number;
    extraPrecautionMode?: boolean;
    dataAccessConsents?: Array<{
      consentId: string; grantedAt: number; expiresAt: number;
      withdrawnAt?: number; clientName: string; tier: string; windowMs: number;
    }>;
    sessionTokenCap?: number;
    sessionTokenCapEnabled?: boolean;
    sessionNodeCap?: number;
    sessionNodeCapEnabled?: boolean;
    sessionBreadthCap?: number;
    sessionBreadthCapEnabled?: boolean;
    searchLlmOnly?: boolean;
    clientTypes?: Record<string, 'chat' | 'agent'>;
  };
  brain?: { clipboardCapture?: { enabled: boolean }; lowPowerMode?: boolean };
}

const RELAY_INITIAL_MIN_MS = 2_000;
const RELAY_INITIAL_MAX_MS = 120_000;
const RELAY_RECONNECT_MIN_MS = 5_000;
const RELAY_RECONNECT_MAX_MS = 24 * 60 * 60 * 1000;

/** Host callbacks wired from main.ts — keeps settings-prefs decoupled from brain/search globals. */
export interface SettingsPrefsHost {
  showError: (msg: string | null) => void;
  setBlockedClientNames: (names: Set<string>) => void;
  refreshHomePolicy: () => void;
  fetchMcpStatus: () => void;
  setClipboardCaptureEnabled: (enabled: boolean) => void;
  updateLowPowerIndicator: (on: boolean) => void;
  syncSearchLlmCheckboxes: () => void;
  refreshLayerPills: () => void;
  refreshStudioLlmBadge: () => void;
  renderRailGetConnected: () => void;
  getBrainLlmReady: () => boolean;
  setBrainLlmReady: (v: boolean) => void;
  getOllamaReadyForSearch: () => boolean;
  setOllamaReadyForSearch: (v: boolean) => void;
  getLocalLlmReachable: () => boolean;
  setLocalLlmReachable: (v: boolean) => void;
  getStudioActiveBackend: () => { id: string; displayName: string; baseUrl: string } | null;
  setStudioActiveBackend: (b: { id: string; displayName: string; baseUrl: string; api: string; processNames: string[]; knownExternalHosts: string[]; defaultPort: number } | null) => void;
  updateLoopbackBadge: (baseUrl: string) => void;
  loadVerification: () => { baseUrl: string; backendId: string } | null;
  clearVerification: () => void;
  getBrainNeuralNetworkEnabled: () => boolean;
  getBrainActivePhaseCount: () => number;
  refreshPillPulse: () => void;
  showSkillsToast: (msg: string, kind: 'success' | 'error') => void;
  addIngestToast: (label: string, message?: string) => string;
  finishIngestToast: (id: string, kind: 'success' | 'error', message?: string) => void;
  notifyIfBackground: (opts: { title: string; body: string }) => void;
  activateMode: (mode: string) => void;
}

let host: SettingsPrefsHost | null = null;

function h(): SettingsPrefsHost {
  if (!host) throw new Error('SettingsPrefsHost not wired — call initSettingsPrefs() from main.ts');
  return host;
}

function showError(msg: string | null): void { h().showError(msg); }

// ── Theme (light / dark / auto) ──────────────────────────────────────────
//
// The CSS exposes three theme states via `data-theme` on <html>:
//   - absent       → "auto": follows OS prefers-color-scheme
//   - "light"      → force light
//   - "dark"       → force dark
//
// applyTheme() writes the attribute (and clears it for auto), updates the
// status-bar toggle's icon state, and syncs the Settings → Appearance radio
// group. wireThemeToggle() attaches click handlers (cycle on bar button,
// onchange on radios) and persists every change via update_settings.
//
// We intentionally do NOT await the persist call — the visual change is
// instant; persistence is best-effort. If the sidecar is mid-restart the
// user's choice is recovered from settings on next boot anyway.
// removed dup: 'auto' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'graphnosis:theme';

/** Read theme from localStorage. Defaults to 'dark' on first install. */
function loadStoredTheme(): UiTheme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'auto' || stored === 'light' || stored === 'dark') return stored;
  return 'dark'; // first-install default
}

let _currentTheme: UiTheme = loadStoredTheme();

// Apply immediately on script load so the lock screen already uses the
// right theme — no flicker waiting for unlock + get_settings round-trip.
(function bootTheme() {
  const root = document.documentElement;
  if (_currentTheme === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', _currentTheme);
  }
  // Also prime the toggle icon so it never flashes as a blank white square
  // before applyTheme() is called during full init.
  const toggle = document.getElementById('btn-theme-toggle');
  if (toggle) toggle.setAttribute('data-theme-state', _currentTheme);
})();

export function applyTheme(theme: UiTheme): void {
  _currentTheme = theme;
  const root = document.documentElement;
  if (theme === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  // Sync the status-bar toggle (icon state)
  const toggle = document.getElementById('btn-theme-toggle');
  if (toggle) {
    toggle.setAttribute('data-theme-state', theme);
    const label =
      theme === 'auto'  ? 'Theme: auto (click to switch to Light)' :
      theme === 'light' ? 'Theme: light (click to switch to Dark)' :
                          'Theme: dark (click to switch to Auto)';
    toggle.setAttribute('title', label);
  }
  // Sync the Settings → Appearance radio group
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="ui-theme"]');
  radios.forEach((r) => { r.checked = r.value === theme; });
}

async function persistTheme(theme: UiTheme): Promise<void> {
  // localStorage is the primary store — survives before/after unlock,
  // applies immediately on next load without waiting for IPC.
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  try {
    // Sidecar settings as secondary store (keeps them in sync for completeness).
    await invoke('update_settings', { settings: { ui: { theme } } });
  } catch {
    // Non-fatal — theme is already applied visually and saved locally.
  }
}

export function wireThemeToggle(): void {
  const toggle = document.getElementById('btn-theme-toggle');
  if (toggle && !toggle.dataset.wired) {
    toggle.dataset.wired = '1';
    toggle.addEventListener('click', () => {
      // Cycle: auto → light → dark → auto
      const next: UiTheme =
        _currentTheme === 'auto'  ? 'light' :
        _currentTheme === 'light' ? 'dark'  : 'auto';
      applyTheme(next);
      void persistTheme(next);
    });
  }
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="ui-theme"]');
  radios.forEach((r) => {
    // Stamp the current selection on every call (not just first-wire) so the
    // picker shows the right option when the Settings panel is opened.
    r.checked = r.value === _currentTheme;
    if (r.dataset.wired) return;
    r.dataset.wired = '1';
    r.addEventListener('change', () => {
      if (!r.checked) return;
      const v = r.value as UiTheme;
      if (v === 'auto' || v === 'light' || v === 'dark') {
        applyTheme(v);
        void persistTheme(v);
      }
    });
  });
}
// ---- settings flow -----------------------------------------------------

function setCacheModeRadio(mode: ContentCacheMode): void {
  const radios = el('settingsModal').querySelectorAll<HTMLInputElement>('input[name="cache-mode"]');
  radios.forEach((r) => { r.checked = r.value === mode; });
}

function getCacheModeRadio(): ContentCacheMode {
  const checked = el('settingsModal').querySelector<HTMLInputElement>('input[name="cache-mode"]:checked');
  const v = checked?.value;
  return v === 'all' || v === 'ephemeral-only' || v === 'off' ? v : 'all';
}

function clampMs(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// (setInspectorDetailRadio / getInspectorDetailRadio /
//  updateNodesDetailBadge removed — Nodes pane is gone, inspector-detail
//  setting deprecated. The Settings modal no longer renders that block.
//  The setting still exists on AppSettings for backwards-compat with
//  cortexes written by older builds; it's just ignored.)

async function syncForgetMode(): Promise<void> {
  try {
    const s = (await invoke('get_settings')) as AppSettings;
    app().setCurrentForgetMode(s.forget.mode);
  } catch {
    // Leave currentForgetMode at its last-known value — non-fatal.
  }
}

function setForgetModeRadio(mode: ForgetMode): void {
  const radios = el('settingsModal').querySelectorAll<HTMLInputElement>('input[name="forget-mode"]');
  radios.forEach((r) => { r.checked = r.value === mode; });
}

function getForgetModeRadio(): ForgetMode {
  const checked = el('settingsModal').querySelector<HTMLInputElement>('input[name="forget-mode"]:checked');
  return checked?.value === 'purge' ? 'purge' : 'soft';
}

function setCacheCapDropdown(bytes: number): void {
  // Snap to the nearest preset; if user had a custom value from a future
  // version, leave the closest one selected so they see what's nearby.
  const options = Array.from(el('cacheCap').options).map(o => Number.parseInt(o.value, 10));
  const exact = options.indexOf(bytes);
  if (exact >= 0) {
    el('cacheCap').selectedIndex = exact;
    return;
  }
  // Fallback: pick the smallest preset that's still >= bytes (or "no limit").
  let pick = options.length - 1;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (opt !== undefined && opt > 0 && opt >= bytes) { pick = i; break; }
  }
  el('cacheCap').selectedIndex = pick;
}

// ── Engram engine toolbar picker ────────────────────────────────────
//
// The toolbar picker has been removed. Engine switching is no longer
// exposed in the UI — force-3d is always the active engine.
// (switchEngramEngine remains in main.ts — atlas concern, not settings prefs.)

el('btnSettings').addEventListener('click', async () => {
  showError(null);
  el('settingsFooterNote').textContent = '';
  el('settingsModal').classList.remove('hidden');
  try {
    const s = (await invoke('get_settings')) as AppSettings;
    setCacheModeRadio(s.contentCache.mode);
    setCacheCapDropdown(s.contentCache.maxBytesPerSource);
    setForgetModeRadio(s.forget.mode);
    app().setCurrentForgetMode(s.forget.mode);
    el('relayInitial').value = String(Math.round(s.mcpRelay.initialWaitMs / 1000));
    el('relayReconnect').value = String(Math.round(s.mcpRelay.reconnectMs / 1000));
    // AI routing toggle: defaults to true for older settings payloads that
    // don't include the field yet.
    el('aiDefaultMemory').checked = s.ai?.useAsDefaultMemory ?? true;
    // Auto-reingest: off by default for the same reason — safer to make
    // the user opt in than to surprise them by re-chunking on Vim save.
    el('aiAutoReingest').checked = s.ai?.autoReingestOnFileChange ?? false;
    // Quiet period selector: default 15 min. Match the closest option value.
    el('aiReingestQuietMs').value = String(s.ai?.reingestQuietMs ?? 900_000);
    // Show/hide the delay row based on current checkbox state.
    el('reingestDelayRow').style.display = el('aiAutoReingest').checked ? 'flex' : 'none';
    // Ingest performance presets — both default-safe if absent from older
    // settings payloads. The sidecar's mergeWithDefaults fills these in
    // on the next save regardless.
    el('aiChunkSize').value = s.ai?.chunkSize ?? 'balanced';
    el('aiEmbedBatch').value = s.ai?.embedBatch ?? 'auto';
    const savedWorkers = s.ai?.embedWorkers ?? 2;
    el('aiEmbedWorkers').value = String(savedWorkers);
    el('aiEmbedWorkersVal').textContent = `${savedWorkers} worker${savedWorkers === 1 ? '' : 's'}`;
    // Clipboard capture: disabled by default.
    el('settingClipboardCapture').checked = s.brain?.clipboardCapture?.enabled ?? false;
    el('settingLowPower').checked = s.brain?.lowPowerMode ?? false;
    // Orbit debug HUD: session-only, reflects live engine state.
    const hudCb = el('settingsModal').querySelector<HTMLInputElement>('#debug-orbit-hud');
    if (hudCb) hudCb.checked = app().getMainAtlas()?.isOrbitDebugHUDVisible?.() ?? false;
  } catch (e) {
    el('settingsFooterNote').textContent = `Could not read settings: ${e}`;
  }
  void refreshLlmStatus();
  startOllamaStatusPoll();
  void refreshEmbeddingPicker();
});

/**
 * Search model picker (Settings → Search model). Renders two radio rows for
 * English-first vs Multilingual, plus an Apply button. Clicking Apply opens
 * the re-embedding progress modal and kicks off `embedding:setModel`. Skipped
 * silently if the picker host element isn't in the DOM (no settings panel
 * open).
 */
interface EmbeddingStatus {
  active: { model: 'english' | 'multilingual'; id: string; dim: number };
  stored: 'english' | 'multilingual';
  needsApply: boolean;
  catalog: Array<{ id: 'english' | 'multilingual'; label: string; description: string; sizeMb: number }>;
}
export async function refreshEmbeddingPicker(): Promise<void> {
  const host = document.getElementById('embedding-picker');
  if (!host) return;
  let status: EmbeddingStatus;
  try {
    status = await ipcCall<EmbeddingStatus>('embedding:status', {});
  } catch {
    host.innerHTML = '<p class="subtitle">Could not read embedding status.</p>';
    return;
  }
  // Track the user's pending selection in the radio group; defaults to active.
  let pendingChoice: 'english' | 'multilingual' = status.active.model;
  const row = (opt: EmbeddingStatus['catalog'][number]): string => {
    const active = opt.id === status.active.model;
    const sizeText = opt.sizeMb >= 1000
      ? `${(opt.sizeMb / 1000).toFixed(1)} GB`
      : `${opt.sizeMb} MB`;
    return `<label style="display:flex; align-items:flex-start; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:8px; cursor:pointer;${active ? ' background:rgba(91,141,239,0.08);' : ''}">`
      + `<input type="radio" name="embedding-choice" value="${opt.id}" ${active ? 'checked' : ''} style="margin-top:3px;" />`
      + `<span style="display:flex; flex-direction:column; gap:3px;">`
      + `<strong style="font-size:13px;">${opt.label}${active ? ' · <em style="color:var(--ok);font-weight:normal;">active</em>' : ''}</strong>`
      + `<span class="subtitle" style="font-size:12px; margin:0;">${opt.description}</span>`
      + `<span class="subtitle" style="font-size:11px; margin:0; opacity:0.7;">Download: ${sizeText}</span>`
      + `</span>`
      + `</label>`;
  };
  host.innerHTML =
    status.catalog.map(row).join('')
    + `<div style="display:flex; align-items:center; gap:10px; margin-top:8px;">`
    + `<button id="embedding-apply" class="btn-sm primary" disabled>Apply</button>`
    + `<span id="embedding-apply-note" class="subtitle" style="margin:0; font-size:12px;"></span>`
    + `</div>`;
  const applyBtn = host.querySelector<HTMLButtonElement>('#embedding-apply');
  const note = host.querySelector<HTMLSpanElement>('#embedding-apply-note');
  const radios = host.querySelectorAll<HTMLInputElement>('input[name="embedding-choice"]');
  const updateApplyState = (): void => {
    if (!applyBtn) return;
    applyBtn.disabled = pendingChoice === status.active.model;
    if (note) {
      note.textContent = applyBtn.disabled
        ? 'No change selected.'
        : `Will re-embed every engram with ${pendingChoice === 'multilingual' ? 'multilingual-e5-large' : 'BGE-small-en-v1.5'}.`;
    }
  };
  radios.forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) {
        pendingChoice = r.value as 'english' | 'multilingual';
        updateApplyState();
      }
    });
  });
  applyBtn?.addEventListener('click', () => {
    openEmbeddingProgressModal(pendingChoice);
  });
  updateApplyState();
}

// ── Settings tab (mode-pane data-pane="settings") render ───────────────────
//
// Engrams management, recovery phrase, and quarantined files used to live
// inside the Preferences modal. They are now top-level panels in the Settings
// tab (side rail) so the user doesn't need to open a modal to access them.
//
// This function is called every time the user activates the Settings tab
// (see activateMode in mode-switch logic). Re-rendering on each visit means
// changes made elsewhere (recovery from op-log, new ingest, quarantine
// happening at startup) are reflected without a manual refresh.

// Settings → Access control. Toggles for each connector kind + known AI client.
// Editable when the sidecar is the user's (admin); read-only when IT-managed
// (env-pinned). "Unchecked = blocked"; every change routes through policy.set,
// which the sidecar enforces (and refuses if managed).
async function renderPolicySettings(): Promise<void> {
  const body = document.getElementById('settings-policy-body');
  if (!body) return;
  let p: { disabledConnectorKinds: string[]; disabledClients: string[]; managed: boolean; connectorKinds: string[]; knownClients: string[] } | null = null;
  try { p = await ipcCall('policy.get', {}); } catch { body.innerHTML = '<p class="subtitle" style="margin:0;">Access-control policy unavailable.</p>'; return; }
  if (!p) { body.innerHTML = ''; return; }
  h().setBlockedClientNames(new Set((p.disabledClients ?? []).map((s) => s.toLowerCase())));
  const disC = new Set(p.disabledConnectorKinds);
  const disK = new Set(p.disabledClients);
  const ro = p.managed;
  const toggle = (attr: string, val: string, blocked: boolean): string => {
    // Presentation Mode: redact the identity label (AI client / connector kind)
    // — the checkbox stays usable. Clients follow mcpClients, connectors connectors.
    const surface = attr === 'data-policy-client' ? 'surface:mcpClients' : 'surface:connectors';
    return `<label class="policy-toggle${blocked ? ' blocked' : ''}">` +
      `<input type="checkbox" ${attr}="${escapeHtml(val)}"${blocked ? '' : ' checked'}${ro ? ' disabled' : ''}>` +
      `<span data-pres="${surface}">${escapeHtml(val)}</span></label>`;
  };
  const connToggles = p.connectorKinds.map((k) => toggle('data-policy-connector', k, disC.has(k))).join('');
  const clientToggles = p.knownClients.length
    ? p.knownClients.map((c) => toggle('data-policy-client', c, disK.has(c))).join('')
    : '<p class="subtitle" style="margin:0;">No AI clients have connected yet — they’ll appear here once they do.</p>';
  body.innerHTML =
    (ro ? '<p class="policy-managed-note">🔒 Managed by your administrator — read-only on this device.</p>' : '') +
    `<div class="policy-group"><p class="policy-group-label">Connector kinds</p><div class="policy-toggles">${connToggles}</div></div>` +
    `<div class="policy-group"><p class="policy-group-label">AI clients</p><div class="policy-toggles">${clientToggles}</div></div>` +
    (ro ? '' : '<p class="subtitle" style="margin:8px 0 0;">Unchecked = blocked. Changes apply immediately and are enforced in the sidecar.</p>');
  if (ro) return;
  const apply = async (): Promise<void> => {
    const disabledConnectorKinds = [...body.querySelectorAll<HTMLInputElement>('[data-policy-connector]')]
      .filter((i) => !i.checked).map((i) => i.dataset['policyConnector'] ?? '').filter(Boolean);
    const disabledClients = [...body.querySelectorAll<HTMLInputElement>('[data-policy-client]')]
      .filter((i) => !i.checked).map((i) => i.dataset['policyClient'] ?? '').filter(Boolean);
    try {
      await ipcCall('policy.set', { disabledConnectorKinds, disabledClients });
      // Update the local block cache immediately so every connected-client
      // surface (status bar, rail indicator, MCP list, Home card) re-paints
      // the blocked state on the very next render without waiting for a poll.
      h().setBlockedClientNames(new Set(disabledClients.map((s) => s.toLowerCase())));
      h().refreshHomePolicy();
      h().fetchMcpStatus(); // re-render status bar + rail indicator + MCP list
    } catch (e) {
      console.warn('[policy] set failed', e);
    }
    void renderPolicySettings(); // re-render to reflect blocked styling + any rejection
  };
  body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((i) => i.addEventListener('change', () => void apply()));
}

export function renderSettingsTab(): void {
  void renderPolicySettings(); // Access-control toggles (admin) / read-only (IT-managed)
  // Engrams + quarantine moved out of the Settings tab into the dedicated
  // Cortex Management modal (red-ish button under Cortex tools). Renders
  // for those happen when the modal opens — see #btn-cortex-management.
  //
  // What remains on the Settings tab is just the Recovery phrase panel
  // (regenerate button), which is non-destructive and worth top-level
  // visibility.
  const regenBtn = document.getElementById('btn-regenerate-recovery-phrase') as HTMLButtonElement | null;
  const regenHint = document.getElementById('recovery-phrase-settings-hint');
  const cortexReady = !app().getUnlockPending() && !el('viewApp').classList.contains('hidden');
  if (regenBtn) {
    regenBtn.disabled = !cortexReady;
    if (regenHint) {
      regenHint.textContent = cortexReady
        ? 'Shows the new phrase once — write it down before dismissing.'
        : 'Unlock your cortex first to regenerate the recovery phrase.';
    }
    regenBtn.onclick = () => {
      if (!cortexReady) return;
      showQuarantineConfirm({
        title: 'Generate a fresh recovery phrase?',
        subtitle: 'The current recovery phrase will stop working. The new one becomes your only fallback to the passphrase.',
        warningHtml:
          '<strong>You will see the new phrase exactly once.</strong> Have a way to write down 24 words ready before you continue ' +
          '(a password manager, a notepad, a printed piece of paper). After you dismiss the modal, the phrase cannot be retrieved.',
        confirmPhrase: 'regenerate recovery phrase',
        confirmLabel: 'Generate & show me the phrase',
        onConfirm: async () => {
          try {
            const phrase = await invoke<string>('regenerate_recovery_phrase');
            if (typeof phrase === 'string' && phrase.length > 0) {
              app().showRecoveryPhraseModal(phrase);
            } else {
              throw new Error('Sidecar returned an empty phrase.');
            }
          } catch (e) {
            void gAlert('Recovery phrase regeneration failed', e instanceof Error ? e.message : String(e));
            throw e;
          }
        },
      });
    };
  }

  // Wire the Cortex Management button (red-ish) every time the tab is
  // activated. Idempotent because we replace .onclick each time.
  const cmBtn = document.getElementById('btn-cortex-management') as HTMLButtonElement | null;
  if (cmBtn) cmBtn.onclick = openCortexManagementModal;
}

// ── Cortex Management modal ────────────────────────────────────────────────
//
// Single home for destructive engram operations: archive/delete graphs and
// review/restore/delete quarantined files. Opened from Settings → Cortex
// Tools → "Cortex Management…". Every action inside is gated by typed
// confirmation; the modal itself is just the entry surface.

export function openCortexManagementModal(): void {
  const modal = document.getElementById('cortex-management-modal') as HTMLDivElement | null;
  if (!modal) return;
  modal.classList.remove('hidden');
  // Render the three sections each time the modal opens so they reflect
  // current state (recently-quarantined engram, recently-recovered one
  // whose `recovered ✓` badge just appeared, recent forget calls that
  // bumped the soft-deleted count, etc.). Force a fresh stats fetch so
  // the forgotten-memories list is current; refreshStats invokes
  // updateGraphnosisForgottenRow() in its completion path.
  renderSettingsGraphsList();
  void renderQuarantineList();
  void refreshStats();

  const closeBtn = document.getElementById('btn-cortex-management-close') as HTMLButtonElement | null;
  if (closeBtn) closeBtn.onclick = () => modal.classList.add('hidden');
}

// ── Quarantine cleanup UI ───────────────────────────────────────────────
//
// Lists every <engram>.gai.corrupt-<ts> and <engram>.bundle.corrupt-<ts>
// in the cortex's graphs/ folder. Each row has a typed-confirmation Delete
// button (and a Restore button when it's safe to restore — i.e. no live
// canonical file exists for the engram).

interface QuarantineItem {
  name: string;        // filename, e.g. "davinci-manual.gai.corrupt-1715901234567"
  engramId: string;    // "davinci-manual"
  kind: 'gai' | 'bundle';
  timestamp: number;
  sizeBytes: number;
  liveEngramExists: boolean;
  /** Node count of the live engram with this id. 0 means either no live
   *  engram OR an empty stub left behind by quarantine — in both cases the
   *  quarantined file is NOT yet recovered and may be the only copy. */
  liveNodeCount?: number;
}

function formatTimestamp(ts: number): string {
  try {
    // The Rust auto-quarantine code uses Date.now() (milliseconds).
    // But manually-renamed files (e.g. when a user follows a "rename to
    // .corrupt-$(date +%s)" instruction in a doc / support thread) end up
    // with a SECONDS timestamp. Detect a seconds-shaped value (< year 2001
    // in ms = 1e12) and promote to ms so the display is sensible either way.
    const ms = ts < 1e12 ? ts * 1000 : ts;
    return new Date(ms).toLocaleString();
  } catch {
    return String(ts);
  }
}

async function renderQuarantineList(): Promise<void> {
  const container = document.getElementById('settings-quarantine-list');
  if (!container) return;
  try {
    const result = await invoke<{ items?: QuarantineItem[] }>('list_quarantine');
    const items = result?.items ?? [];
    if (items.length === 0) {
      container.innerHTML =
        '<p class="subtitle" style="font-size: 14px;">' +
        'No quarantined files. Nothing to clean up. ✨' +
        '</p>';
      return;
    }
    container.innerHTML = items.map((item) => {
      // "Recovered" means a live engram with this id ACTUALLY HAS CONTENT.
      // liveEngramExists alone is not enough: after an integrity failure the
      // loader leaves an EMPTY stub engram with the same id, so that flag is
      // true from the moment of corruption — before "Recover from op-log" has
      // run. Gating on node count avoids telling the user a 23 MB file is
      // "safe to delete" while their only copy is the quarantined one.
      const liveNodes = item.liveNodeCount ?? 0;
      const recovered = item.liveEngramExists && liveNodes > 0;
      const safeToDelete = recovered;
      const safeBadge = recovered
        ? '<span style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: color-mix(in oklab, var(--ok) 18%, transparent); color: var(--ok); font-weight: 600;">recovered ✓</span>'
        : item.liveEngramExists
          ? '<span style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: color-mix(in oklab, var(--error) 18%, transparent); color: var(--error); font-weight: 600;">live engram is empty — not recovered</span>'
          : '<span style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: color-mix(in oklab, var(--error) 18%, transparent); color: var(--error); font-weight: 600;">not yet recovered</span>';
      // Restore only when NO live engram occupies the id. When an empty stub
      // is in the way, the sidecar would refuse the rename (canonical exists)
      // and the corrupt bytes would re-quarantine on next load anyway — the
      // right path there is "Recover from op-log", not Restore.
      const restoreBtn = !item.liveEngramExists
        ? `<button class="btn-qrestore" data-qname="${escape(item.name)}" data-qengram="${escape(item.engramId)}" style="font-size: 15px; padding: 2px 8px;">Restore</button>`
        : '';
      return (
        '<div class="settings-graph-row" style="align-items: flex-start;">' +
          '<div style="flex: 1; min-width: 0;">' +
            `<div style="display: flex; gap: 8px; align-items: baseline;"><strong style="font-family: ui-monospace, monospace; font-size: 14px;">${escape(item.engramId)}</strong> ${safeBadge} <span class="sgr-id">${item.kind}</span></div>` +
            `<div class="subtitle" style="font-size: 15px; margin-top: 2px;">${escape(item.name)}</div>` +
            `<div class="subtitle" style="font-size: 15px;">Quarantined ${escape(formatTimestamp(item.timestamp))} · ${formatBytes(item.sizeBytes)}` +
              (item.liveEngramExists
                ? ` · live engram: ${recovered ? `${liveNodes.toLocaleString()} node${liveNodes === 1 ? '' : 's'}` : 'empty (0 nodes)'}`
                : '') +
            '</div>' +
          '</div>' +
          '<div style="display: flex; gap: 6px; flex-shrink: 0;">' +
            restoreBtn +
            `<button class="btn-qdelete" data-qname="${escape(item.name)}" data-qengram="${escape(item.engramId)}" data-qsafe="${safeToDelete ? '1' : '0'}" data-qliveempty="${item.liveEngramExists && !recovered ? '1' : '0'}" style="font-size: 15px; padding: 2px 8px; color: var(--error); border-color: color-mix(in oklab, var(--error) 40%, var(--border));">Delete</button>` +
          '</div>' +
        '</div>'
      );
    }).join('');

    // Wire up Delete buttons
    container.querySelectorAll<HTMLButtonElement>('.btn-qdelete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.qname ?? '';
        const engramId = btn.dataset.qengram ?? '';
        const safe = btn.dataset.qsafe === '1';
        const liveButEmpty = btn.dataset.qliveempty === '1';
        const warning = safe
          ? `The engram <strong>${escape(engramId)}</strong> has already been recovered (a live copy with content exists). The quarantined file <code>${escape(name)}</code> is no longer needed and can be safely deleted.`
          : liveButEmpty
            ? `<strong>⚠ Looks recovered, but it is NOT.</strong> An engram named <strong>${escape(engramId)}</strong> exists, but it is <strong>empty (0 nodes)</strong> — it's the blank stub left behind when the file was quarantined, not your recovered data. The quarantined file <code>${escape(name)}</code> is very likely the <strong>only on-disk copy</strong> of these bytes.<br><br>Run <em>Recover from op-log</em> and confirm the engram comes back with its content <strong>before</strong> deleting this.`
            : `<strong>⚠ This engram has NOT been recovered yet.</strong> The quarantined file <code>${escape(name)}</code> may be the only on-disk copy of these bytes. Deleting it now means you will lose the chance to manually recover from it later — you'll have to rely on the op-log and original sources.<br><br>We strongly recommend you run <em>Recover from op-log</em> first and verify the engram comes back, then return here to delete.`;
        showQuarantineConfirm({
          title: `Delete ${name}?`,
          subtitle: 'Permanent — the file is unlinked from disk and cannot be undone.',
          warningHtml: warning,
          confirmPhrase: `delete ${engramId}`,
          confirmLabel: 'Delete file',
          onConfirm: async () => {
            await invoke('delete_quarantine', { name });
            await renderQuarantineList();
          },
        });
      });
    });

    // Wire up Restore buttons
    container.querySelectorAll<HTMLButtonElement>('.btn-qrestore').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.qname ?? '';
        const engramId = btn.dataset.qengram ?? '';
        showQuarantineConfirm({
          title: `Restore ${name}?`,
          subtitle: 'The file will be renamed back to its original name and Graphnosis will try to load it on next unlock.',
          warningHtml:
            `Only do this if you have reason to believe the quarantine was spurious — e.g. you accidentally interrupted a save and the file is actually fine, or you're restoring a backup. ` +
            `If the file is actually corrupt, the next unlock will quarantine it again immediately.`,
          confirmPhrase: `restore ${engramId}`,
          confirmLabel: 'Restore file',
          onConfirm: async () => {
            await invoke('restore_quarantine', { name });
            await renderQuarantineList();
          },
        });
      });
    });
  } catch (e) {
    container.innerHTML = `<p class="error" style="font-size: 14px;">${escape(String(e))}</p>`;
  }
}


export function showQuarantineConfirm(opts: QuarantineConfirmOptions): void {
  const modal = document.getElementById('quarantine-confirm-modal') as HTMLDivElement | null;
  const modalInner = document.getElementById('qcm-modal-inner') as HTMLDivElement | null;
  const titleEl = document.getElementById('qcm-title');
  const subtitleEl = document.getElementById('qcm-subtitle');
  const warningEl = document.getElementById('qcm-warning');
  const confirmRow = document.getElementById('qcm-confirm-row') as HTMLDivElement | null;
  const inputLabel = document.getElementById('qcm-input-label');
  const input = document.getElementById('qcm-input') as HTMLInputElement | null;
  const statusEl = document.getElementById('qcm-status');
  const cancelBtn = document.getElementById('btn-qcm-cancel') as HTMLButtonElement | null;
  const confirmBtn = document.getElementById('btn-qcm-confirm') as HTMLButtonElement | null;
  if (!modal || !titleEl || !subtitleEl || !warningEl || !inputLabel || !input || !statusEl || !cancelBtn || !confirmBtn) return;

  const readOnly = opts.confirmPhrase === '';

  titleEl.textContent = opts.title;
  subtitleEl.textContent = opts.subtitle;
  warningEl.innerHTML = opts.warningHtml;
  statusEl.textContent = '';

  // Read-only mode (e.g. consent history): hide input row, show only Close.
  if (confirmRow) confirmRow.style.display = readOnly ? 'none' : '';
  if (modalInner) modalInner.style.maxWidth = readOnly ? '640px' : '480px';
  cancelBtn.style.display = readOnly ? 'none' : '';
  confirmBtn.textContent = readOnly ? 'Close' : opts.confirmLabel;
  confirmBtn.disabled = false;

  input.oninput = null;

  if (!readOnly) {
    input.value = '';
    input.placeholder = opts.confirmPhrase;
    inputLabel.innerHTML = `Type <code style="font-family: ui-monospace, monospace; padding: 1px 5px; background: var(--bg-elev); border-radius: 3px;">${escape(opts.confirmPhrase)}</code> to confirm:`;
    confirmBtn.disabled = true;
    input.oninput = (): void => {
      confirmBtn.disabled = input.value.trim() !== opts.confirmPhrase;
    };
  }

  const close = (): void => {
    modal.classList.add('hidden');
    input.oninput = null;
  };

  cancelBtn.onclick = close;
  confirmBtn.onclick = async () => {
    if (readOnly) { close(); return; }
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = 'Working…';
    try {
      await opts.onConfirm();
      close();
    } catch (e) {
      statusEl.textContent = '';
      warningEl.innerHTML = `<strong style="color: var(--error);">Failed:</strong> ${escape(String(e))}`;
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  };

  modal.classList.remove('hidden');
  if (!readOnly) input.focus();
}

// Show/hide the quiet-period selector whenever the checkbox changes.
el('aiAutoReingest').addEventListener('change', () => {
  el('reingestDelayRow').style.display = el('aiAutoReingest').checked ? 'flex' : 'none';
});

// Live label for the embed-workers slider.
el('aiEmbedWorkers').addEventListener('input', () => {
  const n = parseInt(el('aiEmbedWorkers').value, 10);
  el('aiEmbedWorkersVal').textContent = `${n} worker${n === 1 ? '' : 's'}`;
});

el('btnSettingsCancel').addEventListener('click', () => {
  stopOllamaStatusPoll();
  el('settingsModal').classList.add('hidden');
});

el('btnSettingsSave').addEventListener('click', async () => {
  el('btnSettingsSave').disabled = true;
  el('settingsFooterNote').textContent = 'Saving…';
  try {
    const mode = getCacheModeRadio();
    const maxBytesPerSource = Number.parseInt(el('cacheCap').value, 10) || 0;
    const forgetMode = getForgetModeRadio();
    app().setCurrentForgetMode(forgetMode);   // keep in-memory copy in sync
    // Clamp to the same min/max the sidecar enforces. Convert seconds → ms.
    const initialWaitMs = clampMs(
      (Number.parseInt(el('relayInitial').value, 10) || 90) * 1000,
      RELAY_INITIAL_MIN_MS,
      RELAY_INITIAL_MAX_MS,
    );
    const reconnectMs = clampMs(
      (Number.parseInt(el('relayReconnect').value, 10) || 60) * 1000,
      RELAY_RECONNECT_MIN_MS,
      RELAY_RECONNECT_MAX_MS,
    );
    const clipEnabled = el('settingClipboardCapture').checked;
    await invoke('update_settings', {
      settings: {
        contentCache: { mode, maxBytesPerSource },
        forget: { mode: forgetMode },
        mcpRelay: { initialWaitMs, reconnectMs },
        // ui.inspectorDetail is no longer wired to the UI (the Nodes
        // pane that used it is gone). We still send the field through
        // so the sidecar's settings.update Zod validator doesn't break
        // on older client builds; default to 'simple'.
        // theme: preserve whatever the user picked via the status-bar
        // toggle or the Appearance picker — otherwise saving Preferences
        // would silently reset it to 'auto'.
        ui: { inspectorDetail: 'simple' as InspectorDetail, theme: _currentTheme },
        ai: {
          useAsDefaultMemory: el('aiDefaultMemory').checked,
          autoReingestOnFileChange: el('aiAutoReingest').checked,
          reingestQuietMs: parseInt(el('aiReingestQuietMs').value, 10) || 900_000,
          chunkSize: el('aiChunkSize').value as 'fine' | 'balanced' | 'coarse',
          embedBatch: el('aiEmbedBatch').value as 'small' | 'medium' | 'large' | 'auto',
          embedWorkers: parseInt(el('aiEmbedWorkers').value, 10) || 2,
        },
        brain: { clipboardCapture: { enabled: clipEnabled }, lowPowerMode: el('settingLowPower').checked },
      },
    });
    // Apply clipboard capture immediately so the user doesn't need to relaunch.
    h().setClipboardCaptureEnabled(clipEnabled);
    // Low-power mode pauses the BRAIN only (the sidecar reads brain.lowPowerMode
    // live). It deliberately does NOT touch the 3D animation — stopping motion
    // lets the graph settle + spread, which reads as "dimmed/dead". The animation
    // is a minor cost next to the brain, and the user controls it separately via
    // the "Alive Engram" toggle. So low-power keeps the graph bright + lively.
    h().updateLowPowerIndicator(el('settingLowPower').checked); // reflect in the status bar
    // Orbit debug HUD: session-only toggle, not persisted to settings.
    const hudCb = el('settingsModal').querySelector<HTMLInputElement>('#debug-orbit-hud');
    if (hudCb && app().getMainAtlas()) {
      const atlas = app().getMainAtlas()!;
      if (hudCb.checked) atlas.startOrbitDebugHUD?.();
      else atlas.stopOrbitDebugHUD?.();
    }
    el('settingsFooterNote').textContent = 'Saved.';
    stopOllamaStatusPoll();
    setTimeout(() => el('settingsModal').classList.add('hidden'), 350);
  } catch (e) {
    el('settingsFooterNote').textContent = `Save failed: ${e}`;
  } finally {
    el('btnSettingsSave').disabled = false;
  }
});
// Periodic poll that keeps the Ollama status badge current while the
// settings modal is open. Started on open, cleared on close.
let ollamaStatusPollTimer: ReturnType<typeof setInterval> | null = null;

export function startOllamaStatusPoll(): void {
  if (ollamaStatusPollTimer !== null) return;
  ollamaStatusPollTimer = setInterval(() => { void refreshLlmStatus(); }, 30_000);
}

export function stopOllamaStatusPoll(): void {
  if (ollamaStatusPollTimer !== null) {
    clearInterval(ollamaStatusPollTimer);
    ollamaStatusPollTimer = null;
  }
}

// ── LLM / Ollama settings ─────────────────────────────────────────────────

/** Two-step inline confirm flag for enabling the (non-deterministic) local
 *  LLM — mirrors `nnConfirmPending` for the neural network. State lives in
 *  app-context via bindAppContext (getLlmConfirmPending / setLlmConfirmPending). */

/**
 * Render the local-LLM master switch into #llm-enable-block. The LLM is
 * opt-in: a running Ollama is never enough to turn it on. Mirrors the neural
 * network's flow — a two-step confirm guards the non-deterministic opt-in;
 * once on, a one-click Turn off.
 */
function renderLlmEnableBlock(reachable: boolean, hasModels: boolean, enabled: boolean): void {
  const host = el('llmEnableBlock');
  const setupDone = reachable && hasModels;

  if (app().getLlmConfirmPending()) {
    // Confirmation state: show an inline card explaining the non-determinism
    // risk; Cancel bounces back, Confirm enables.
    host.innerHTML =
      `<div class="llm-confirm-inline">`
      + `<p><strong>Before you enable the local LLM</strong> — the local AI model is non-deterministic. `
      + `The same memory can yield slightly different results across runs. `
      + `Everything runs entirely on your device; nothing is sent to the cloud. `
      + `A snapshot of your cortex is saved before the first enable.</p>`
      + `<div class="lb-goal-form-actions">`
      + `<button data-llm="cancel" class="btn-sm">Cancel</button>`
      + `<button data-llm="confirm" class="btn-sm primary">Enable Local LLM</button>`
      + `</div>`
      + `</div>`;
  } else {
    // Normal state: compact card with checkbox toggle. The right-hand status
    // chip combines two signals so the user never confuses "Ollama is
    // reachable" with "the master LLM toggle is on" — both have to be true
    // for any LLM-backed feature (insights, synapses, edge prediction) to
    // actually work. Previous wording ("● Ollama connected" alone) misled
    // users into thinking the LLM was on when only Ollama was up.
    const dimmed = setupDone ? '' : ' style="opacity: 0.55;"';
    const statusChip = (() => {
      if (!reachable) return `<span class="llm-enable-card-status" style="color: var(--err, #d04a4a);">● Ollama not detected</span>`;
      if (!hasModels)  return `<span class="llm-enable-card-status" style="color: #d6a728;">● Ollama up · no model installed</span>`;
      if (!enabled)    return `<span class="llm-enable-card-status" style="color: #d6a728;">● Ollama ready · master toggle OFF</span>`;
      return `<span class="llm-enable-card-status" style="color: var(--ok, #3aa67a);">● ON · Ollama ready</span>`;
    })();
    const recheckBtn = `<button data-llm="recheck" class="btn-sm" style="margin-left:10px;">Recheck</button>`;
    const subtitle = !setupDone
      ? '<p class="brain-subtitle" style="margin: 6px 0 0; padding: 0 14px 12px;">Finish the Ollama setup below to enable the local LLM.</p>'
      : enabled
        ? '<p class="brain-subtitle" style="margin: 6px 0 0; padding: 0 14px 12px;">On — Graphnosis is routing the enabled capabilities through your local model. Runs entirely on your device.</p>'
        : '<p class="brain-subtitle" style="margin: 6px 0 0; padding: 0 14px 12px;">Off — check the box on the left to enable. Graphnosis won\'t route any memory through the local LLM until you do.</p>';

    host.innerHTML =
      `<div class="llm-enable-card${enabled ? ' llm-card-active' : ''}"${dimmed}>`
      + `<label class="llm-enable-card-label" style="cursor: ${setupDone ? 'pointer' : 'not-allowed'};">`
      + `<input type="checkbox" data-llm="toggle" ${enabled ? 'checked' : ''} ${setupDone ? '' : 'disabled'} />`
      + `<strong>Local LLM</strong>`
      + `</label>`
      + `<span style="display:flex; align-items:center; gap:8px;">`
      + statusChip
      + `<span class="studio-llm-loopback" title=""></span>`
      + recheckBtn
      + `</span>`
      + `</div>`
      + subtitle;
    // Sync the newly-rendered loopback chip with the current backend state
    // (the global click handler already routes its click to the explainer).
    if (h().getStudioActiveBackend()) h().updateLoopbackBadge(h().getStudioActiveBackend()!.baseUrl);
  }

  const on = (action: string, fn: (ev: Event) => void): void => {
    host.querySelector(`[data-llm="${action}"]`)?.addEventListener('click', fn);
  };
  on('toggle', (ev) => {
    const cb = ev.currentTarget as HTMLInputElement;
    if (!setupDone) { cb.checked = false; return; }
    if (cb.checked && !enabled) {
      // Turning on requires a one-time confirmation — bounce checkbox back.
      cb.checked = false;
      app().setLlmConfirmPending(true);
      renderLlmEnableBlock(reachable, hasModels, enabled);
    } else if (!cb.checked && enabled) {
      void ipcCall('llm:setEnabled', { enabled: false }).then(() => { void refreshLlmStatus(); });
    }
  });
  on('recheck', () => { void refreshLlmStatus(); });
  on('cancel', () => { app().setLlmConfirmPending(false); renderLlmEnableBlock(reachable, hasModels, enabled); });
  on('confirm', () => {
    app().setLlmConfirmPending(false);
    void ipcCall('llm:setEnabled', { enabled: true }).then(() => { void refreshLlmStatus(); });
  });
}

interface LlmCapabilityFlags {
  recallEnrichment: boolean;
  correctionParsing: boolean;
  distillation: boolean;
  insights: boolean;
  edgePrediction: boolean;
}

/**
 * Per-capability checkboxes under the master Local LLM toggle. Each capability
 * maps to one of the side-effect classes:
 *   - Recall enrichment: NO graph mutation (query rewrite at recall time)
 *   - Correction parsing: proposes diffs the user must approve
 *   - Distillation: returns text to the AI client
 *   - Insights: writes only to the LLM event/overlay layer
 *   - Edge prediction: opt-in autonomous loop, writes to .gll overlay
 *
 * The whole block is dimmed (and inputs disabled) when the master switch is
 * off — turning master on restores prior per-capability choices because the
 * settings are persisted independently.
 */
function renderLlmCapabilityBlock(masterEnabled: boolean, caps: LlmCapabilityFlags | undefined): void {
  const hostEl = el('llmCapBlock');
  if (!hostEl) return;
  // No caps from older sidecars — leave the block empty rather than guessing.
  if (!caps) { hostEl.innerHTML = ''; return; }
  const dim = masterEnabled ? '' : ' opacity: 0.5;';
  const disabledAttr = masterEnabled ? '' : 'disabled';
  const row = (id: keyof LlmCapabilityFlags, title: string, blurb: string): string =>
    `<label class="llm-cap-row" style="display:flex; gap:10px; align-items:flex-start; padding:8px 14px; cursor:${masterEnabled ? 'pointer' : 'not-allowed'};">`
    + `<input type="checkbox" data-cap="${id}" ${caps[id] ? 'checked' : ''} ${disabledAttr} style="margin-top:3px;" />`
    + `<span style="display:flex; flex-direction:column; gap:2px;">`
    + `<strong style="font-size:13px;">${title}</strong>`
    + `<span class="brain-subtitle" style="font-size:12px; margin:0;">${blurb}</span>`
    + `</span>`
    + `</label>`;
  hostEl.innerHTML =
    `<div class="llm-cap-card" style="border:1px solid var(--border); border-radius:8px;${dim}">`
    + `<div style="padding:10px 14px 6px; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted);">Capabilities</div>`
    + row('recallEnrichment', 'Enrich recall queries',
          'Rewrites your query at recall time — adds synonyms, translates across languages, strips framing. <em>No changes to your memory.</em>')
    + row('correctionParsing', 'Parse corrections',
          'Upgrades the <code>correct</code> tool to author multi-memory diffs. You always review and approve before anything is written.')
    + row('distillation', 'Distill facts from text',
          'Lets AI clients call <code>llm_distill</code> to extract structured facts from raw text.')
    + row('insights', 'Surface insights and predictions',
          'Background loop that finds patterns, gaps, and opportunities. Powers <code>insights</code>, <code>develop</code>, <code>predict</code>, <code>llm_query</code>. Writes only to the LLM overlay, never to your engrams.')
    + row('edgePrediction', 'Predict edges autonomously',
          'Opt-in. A background loop proposes new connections between co-recalled memories. Predictions land in the <code>.gll</code> overlay — separate from your canonical engram, fully reversible.')
    + `</div>`;
  hostEl.querySelectorAll<HTMLInputElement>('input[data-cap]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const capability = cb.dataset.cap as keyof LlmCapabilityFlags;
      const enabled = cb.checked;
      void ipcCall('llm:setCapability', { capability, enabled })
        .then(() => { void refreshLlmStatus(); })
        .catch(() => { void refreshLlmStatus(); });
    });
  });
}

export async function refreshLlmStatus(): Promise<void> {
  try {
    const status = await ipcCall<{
      ollamaReachable: boolean;
      installedModels: string[];
      activeModel: string | null;
      enabled: boolean;
      capabilities?: LlmCapabilityFlags;
      catalog?: Array<{ id: string; name: string }>;
      backend?: { id: string; displayName: string; baseUrl: string; api: string; processNames: string[]; knownExternalHosts: string[]; defaultPort: number };
    }>('llm:status', {});

    // MemoryStudio loopback badge — drives the green/amber pill in the LLM
    // panel header. Updated on every llm:status refresh so changes to the
    // backend URL (e.g. user points to a remote Ollama) reflect immediately.
    if (status.backend) {
      // If the backend URL/process changed, reset the session probe flag AND
      // drop any stored verification record — a new backend needs fresh
      // verification before we can claim "Last verified" again.
      const changed = h().getStudioActiveBackend()?.baseUrl !== status.backend.baseUrl
        || h().getStudioActiveBackend()?.id !== status.backend.id;
      if (changed) {
        const stored = h().loadVerification();
        if (stored && (stored.baseUrl !== status.backend.baseUrl || stored.backendId !== status.backend.id)) {
          h().clearVerification();
        }
      }
      h().setStudioActiveBackend(status.backend);
      h().updateLoopbackBadge(status.backend.baseUrl);
    }

    h().setLocalLlmReachable(status.ollamaReachable);

    if (status.ollamaReachable) {
      el('ollamaStatusBadge').textContent = '● Connected';
      el('ollamaStatusBadge').className = 'ok';
      el('ollamaPullRow').style.display = 'flex';
      el('ollamaNotInstalled').style.display = 'none';
      el('ollamaConnectedHelp').style.display = '';

      const hasModels = status.installedModels.length > 0;
      // Background brain features (insights, synapse formation) need Ollama up,
      // a model installed, AND the user's explicit opt-in toggle.
      h().setBrainLlmReady(hasModels && status.enabled);
      // On-demand search features (Synthesize, Enhanced ranking) only need
      // Ollama up + a model — no master-switch required.
      h().setOllamaReadyForSearch(hasModels);
      h().syncSearchLlmCheckboxes();
      // Active-model row is only useful once at least one model is installed.
      el('ollamaModelRow').style.display = hasModels ? 'flex' : 'none';
      el('ollamaConnectedHelp').innerHTML = hasModels
        ? '✅ Ollama is connected. To add another model, pick it below and click '
          + '<strong>Pull</strong>. To switch which model Graphnosis uses, choose it '
          + 'as the <strong>Active model</strong> and click <strong>Apply</strong>.'
        : '✅ Ollama is connected — last step. Pick a model below and click '
          + '<strong>Pull</strong> to download it (one-time). '
          + '<strong>Llama 3.2 3B</strong> is the recommended starting point. '
          + 'Then turn the local LLM on at the top of this section.';

      // Populate model selector
      el('ollamaModelSelect').innerHTML = '';
      for (const m of status.installedModels) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === status.activeModel) opt.selected = true;
        el('ollamaModelSelect').appendChild(opt);
      }
      renderLlmEnableBlock(true, hasModels, status.enabled);
      renderLlmCapabilityBlock(status.enabled, status.capabilities);
    } else {
      el('ollamaStatusBadge').textContent = '● Not detected';
      el('ollamaStatusBadge').className = 'err';
      el('ollamaModelRow').style.display = 'none';
      el('ollamaPullRow').style.display = 'none';
      el('ollamaConnectedHelp').style.display = 'none';
      el('ollamaNotInstalled').style.display = '';
      h().setBrainLlmReady(false);
      h().setOllamaReadyForSearch(false);
      h().syncSearchLlmCheckboxes();
      renderLlmEnableBlock(false, false, status.enabled);
      renderLlmCapabilityBlock(status.enabled, status.capabilities);
    }
    h().renderRailGetConnected();
    h().refreshLayerPills();
  } catch { /* non-fatal */ }
  // Outside the try so a failure earlier in refreshLlmStatus doesn't skip the
  // badge refresh — the helper makes its own llm:status call and is the
  // single source of truth for the Edit/Correct "LLM-assisted" pill.
  h().refreshStudioLlmBadge();
}

// "Recheck" — re-probe Ollama after the user installs/starts it, without
// having to close and reopen Settings.
el('btnOllamaRecheck').addEventListener('click', () => {
  el('ollamaStatusBadge').textContent = 'Checking…';
  el('ollamaStatusBadge').className = '';
  void refreshLlmStatus();
});

// Platform tabs inside Prefer the Terminal? — flip the visible pane and
// aria-selected based on the clicked tab. Delegated so we don't bind one
// listener per tab.
document.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement | null;
  if (!target?.matches('.ollama-cli-tab')) return;
  const tabId = target.dataset.cliTab;
  if (!tabId) return;
  const root = target.closest('.ollama-cli-box');
  if (!root) return;
  root.querySelectorAll<HTMLElement>('.ollama-cli-tab').forEach((t) => {
    t.setAttribute('aria-selected', t.dataset.cliTab === tabId ? 'true' : 'false');
  });
  root.querySelectorAll<HTMLElement>('.ollama-cli-pane').forEach((p) => {
    p.style.display = p.dataset.cliPane === tabId ? '' : 'none';
  });
});

el('btnOllamaApplyModel').addEventListener('click', async () => {
  const model = el('ollamaModelSelect').value;
  if (!model) return;
  try {
    await ipcCall('llm:setModel', { model });
    el('settingsFooterNote').textContent = `Model set to ${model}`;
  } catch (e) {
    el('settingsFooterNote').textContent = `Failed: ${(e as Error).message}`;
  }
});

// Live progress for `ollama pull`, streamed line-by-line from the sidecar.
interface LlmPullProgressPayload {
  model: string;
  status?: string;
  completed?: number;
  total?: number;
}
void listen<LlmPullProgressPayload>('graphnosis://llm-pull-progress', (evt) => {
  const p = evt.payload;
  el('ollamaPullProgress').style.display = '';
  if (p.completed && p.total && p.total > 0) {
    const pct = Math.round((p.completed / p.total) * 100);
    el('ollamaPullBar').style.width = `${pct}%`;
    el('ollamaPullLabel').textContent = `${p.status ?? 'Downloading'} — ${pct}%`;
  } else {
    el('ollamaPullLabel').textContent = p.status ?? 'Downloading…';
  }
});

// ── Embedding model switch progress ────────────────────────────────────────
//
// Driven by the 'embedding.switch-progress' event channel forwarded from the
// sidecar. Phases: 'snapshot' → 'downloading-model' → 'reembedding' (per-
// engram counter) → 'done'. The modal is opened by the Settings → Search
// model Apply button (openEmbeddingProgressModal).
interface EmbeddingSwitchProgressPayload {
  phase: 'snapshot' | 'downloading-model' | 'reembedding' | 'done';
  model?: 'english' | 'multilingual';
  graphId?: string;
  index?: number;
  total?: number;
  nodesInGraph?: number;
  graphsRebuilt?: number;
  cancelled?: boolean;
  errors?: Array<{ graphId: string; error: string }>;
}
function openEmbeddingProgressModal(target: 'english' | 'multilingual'): void {
  const modal = document.getElementById('embedding-switch-modal');
  const phaseEl = document.getElementById('embedding-switch-phase');
  const detailEl = document.getElementById('embedding-switch-detail');
  const barEl = document.getElementById('embedding-switch-bar');
  const counterEl = document.getElementById('embedding-switch-counter');
  const closeBtn = document.getElementById('embedding-switch-close') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('embedding-switch-cancel') as HTMLButtonElement | null;
  if (!modal || !phaseEl || !detailEl || !barEl || !counterEl || !closeBtn || !cancelBtn) return;
  modal.classList.remove('hidden');
  closeBtn.disabled = true;
  closeBtn.onclick = () => {
    modal.classList.add('hidden');
    void refreshEmbeddingPicker();
  };
  // Cancel: fire the cooperative abort. The host loop bails between
  // engrams; the 'done' progress event will fire with cancelled=true and
  // re-enable the Close button.
  cancelBtn.disabled = false;
  cancelBtn.onclick = () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling…';
    void ipcCall('embedding:cancelSwitch', {}).catch(() => { /* non-fatal */ });
  };
  phaseEl.textContent = 'Starting…';
  detailEl.textContent = `Switching to ${target === 'multilingual' ? 'multilingual-e5-large' : 'BGE-small-en-v1.5'}.`;
  barEl.style.width = '0%';
  counterEl.textContent = '';
  void ipcCall<{ ok: boolean; switched: boolean; graphsRebuilt?: number; errors?: Array<{ graphId: string; error: string }> }>('embedding:setModel', { model: target })
    .then((result) => {
      // The 'done' progress event will also flip the close button — this
      // is the fallback in case the event arrived earlier or got lost.
      closeBtn.disabled = false;
      if (!result.switched) {
        phaseEl.textContent = 'No change';
        detailEl.textContent = 'That model was already active.';
      }
    })
    .catch((err) => {
      closeBtn.disabled = false;
      phaseEl.textContent = 'Switch failed';
      detailEl.textContent = String((err as Error).message ?? err);
    });
}
void listen<EmbeddingSwitchProgressPayload>('graphnosis://embedding-switch-progress', (evt) => {
  const phaseEl = document.getElementById('embedding-switch-phase');
  const detailEl = document.getElementById('embedding-switch-detail');
  const barEl = document.getElementById('embedding-switch-bar');
  const counterEl = document.getElementById('embedding-switch-counter');
  const closeBtn = document.getElementById('embedding-switch-close') as HTMLButtonElement | null;
  if (!phaseEl || !detailEl || !barEl || !counterEl || !closeBtn) return;
  const p = evt.payload;
  switch (p.phase) {
    case 'snapshot':
      phaseEl.textContent = 'Snapshotting engrams…';
      detailEl.textContent = 'Saving the current vectors so they\'re recoverable.';
      barEl.style.width = '5%';
      break;
    case 'downloading-model':
      phaseEl.textContent = 'Loading new model…';
      detailEl.textContent = p.model === 'multilingual'
        ? 'First time: downloading multilingual-e5-large (~2.2 GB). Cached for next time.'
        : 'First time: downloading BGE-small-en-v1.5 (~30 MB). Cached for next time.';
      barEl.style.width = '15%';
      break;
    case 'reembedding': {
      const idx = p.index ?? 0;
      const total = p.total ?? 1;
      const pct = Math.min(95, 20 + Math.round((idx / Math.max(1, total)) * 75));
      barEl.style.width = `${pct}%`;
      phaseEl.textContent = 'Re-embedding your memory…';
      if (p.graphId) {
        detailEl.textContent = `Engram: ${p.graphId} (${idx + 1} of ${total}, ${p.nodesInGraph ?? '?'} nodes)`;
      } else {
        detailEl.textContent = 'Finishing…';
      }
      counterEl.textContent = `${idx} / ${total} engrams done`;
      break;
    }
    case 'done': {
      barEl.style.width = '100%';
      phaseEl.textContent = p.cancelled ? 'Cancelled' : 'Done';
      const errs = p.errors ?? [];
      if (p.cancelled) {
        detailEl.textContent = `Cancelled after re-embedding ${p.graphsRebuilt ?? 0} engrams. The remaining engrams kept their old vectors (recoverable from the snapshot if needed).`;
      } else {
        detailEl.textContent = errs.length === 0
          ? `Re-embedded ${p.graphsRebuilt ?? 0} engrams. Your memory now uses the new model.`
          : `Re-embedded ${p.graphsRebuilt ?? 0} engrams; ${errs.length} failed: ${errs.map((e) => e.graphId).join(', ')}.`;
      }
      counterEl.textContent = '';
      closeBtn.disabled = false;
      // Reset the cancel button so it isn't stuck on "Cancelling…" if the
      // user reopens the modal for a future operation.
      const cancelBtn = document.getElementById('embedding-switch-cancel') as HTMLButtonElement | null;
      if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.textContent = 'Cancel'; }
      break;
    }
  }
});

// ── GLL predicted edges (review queue) ──────────────────────────────────────
//
// Populated by the autonomous edge-prediction loop in brain-engine (gated on
// llmCapabilities.edgePrediction). Each row carries the relationship label
// the LLM proposed + a confidence percent + previews of both endpoints, and
// Accept / Reject buttons. Refreshed on demand via the buttons; no live
// subscription (low-frequency content, doesn't need it).
interface GllPredictedEdgeRow {
  id: string;
  graphId: string;
  from: string;
  to: string;
  relationship: string;
  score: number;
  createdAt: number;
  modelTag?: string;
  fromPreview: string;
  toPreview: string;
}
async function refreshGllPredictedEdges(): Promise<void> {
  const listEl = document.getElementById('gll-predicted-list');
  const countEl = document.getElementById('gll-predicted-count');
  if (!listEl) return;
  let edges: GllPredictedEdgeRow[];
  try {
    const result = await ipcCall<{ edges: GllPredictedEdgeRow[] } | undefined>('gll:listPredictedEdges', {});
    // Be defensive: the IPC can return undefined when the sidecar is still
    // booting or the cortex isn't unlocked yet. Show a useful "waiting"
    // state rather than the bare word "undefined" — that was the actual
    // bug behind "Could not load predicted edges: undefined".
    if (!result || !Array.isArray(result.edges)) {
      listEl.innerHTML = '<p class="brain-subtitle">Predicted edges aren\'t available yet. This usually means the sidecar is still warming up or the cortex isn\'t fully loaded — click <strong>Refresh list</strong> in a moment.</p>';
      if (countEl) countEl.textContent = '';
      return;
    }
    edges = result.edges;
  } catch (e) {
    // Robust error formatting — Tauri's invoke can reject with strings,
    // bare objects, or Errors. Cover all three shapes so the user never
    // sees a literal "undefined".
    const message = e instanceof Error
      ? (e.message || e.name || 'unknown error')
      : (typeof e === 'string'
          ? e
          : (e && typeof e === 'object' ? JSON.stringify(e) : 'unknown error'));
    listEl.innerHTML = `<p class="brain-subtitle">Could not load predicted edges: ${message}. If you just opened the app, click <strong>Refresh list</strong> after a moment.</p>`;
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) {
    countEl.textContent = edges.length === 0
      ? 'No predictions yet.'
      : `${edges.length} pending`;
  }
  if (edges.length === 0) {
    listEl.innerHTML = '<p class="brain-subtitle">Nothing predicted yet. Either prediction hasn\'t run, or the LLM didn\'t find anything worth proposing in the latest scan.</p>';
    return;
  }
  const trimPreview = (s: string): string => s.length > 90 ? s.slice(0, 87) + '…' : s;
  listEl.innerHTML = edges.map((e) => {
    const pct = Math.round(e.score * 100);
    const when = new Date(e.createdAt).toLocaleString();
    return `<div class="gll-edge-row" data-edge-id="${e.id}" data-score="${e.score}" data-relationship="${e.relationship.replace(/"/g, '&quot;')}" style="border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:8px;">`
      + `<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px;">`
      + `<div style="font-size:12px; opacity:0.7;"><strong>${e.graphId}</strong> · ${when} · <em>${pct}% confidence</em></div>`
      + `<div style="display:flex; gap:6px;">`
      + `<button data-gll-action="accept" data-edge-id="${e.id}" class="btn-sm primary">Accept</button>`
      + `<button data-gll-action="reject" data-edge-id="${e.id}" class="btn-sm">Reject</button>`
      + `</div>`
      + `</div>`
      + `<div style="margin-top:8px; font-size:13px;">`
      + `<div style="margin-bottom:4px;"><strong>A:</strong> ${trimPreview(e.fromPreview)}</div>`
      + `<div style="font-weight:600; color:var(--accent,#5b8def); margin:4px 0;">↓ ${e.relationship}</div>`
      + `<div><strong>B:</strong> ${trimPreview(e.toPreview)}</div>`
      + `</div>`
      + `</div>`;
  }).join('');
}
/** Confidence below this triggers a confirmation dialog before promoting a
 *  predicted edge to .gai. High-confidence accepts go straight through —
 *  the user already exercised judgment by clicking Accept. Lower-confidence
 *  ones get an explicit "are you sure?" so a fat-finger click on a 55%
 *  prediction doesn't permanently write a wrong edge into canonical memory. */
const GLL_HIGH_CONFIDENCE = 0.75;

document.addEventListener('click', (ev) => {
  const target = ev.target as HTMLElement | null;
  if (!target?.matches('[data-gll-action]')) return;
  const action = target.dataset.gllAction;
  const id = target.dataset.edgeId;
  if (!action || !id) return;
  if (action === 'reject') {
    void ipcCall('gll:rejectPredictedEdge', { id }).then(() => { void refreshGllPredictedEdges(); });
    return;
  }
  // Accept path. Read the row's confidence + relationship from the data-*
  // attributes we put on the row when rendering so we can decide whether
  // to confirm.
  const row = target.closest<HTMLElement>('.gll-edge-row');
  const score = row ? parseFloat(row.dataset.score ?? '0') : 0;
  const relationship = row?.dataset.relationship ?? 'related';
  if (score < GLL_HIGH_CONFIDENCE) {
    const pct = Math.round(score * 100);
    const ok = confirm(
      `Promote this prediction to your canonical graph?\n\n` +
      `Confidence: ${pct}% (below the ${Math.round(GLL_HIGH_CONFIDENCE * 100)}% high-confidence bar)\n` +
      `Relationship: "${relationship}"\n\n` +
      `Once promoted, the edge lives in your engram and is treated as your attested memory. ` +
      `You can always remove it later via the engram inspector, but the action is recorded in the op-log.\n\n` +
      `Promote anyway?`,
    );
    if (!ok) return;
  }
  void ipcCall('gll:acceptPredictedEdge', { id }).then((result: unknown) => {
    void refreshGllPredictedEdges();
    // Surface the structural edge type the heuristic picked, so the user
    // sees what was actually written (relationship label preserved as
    // evidence, but the SDK enum slot is one of a fixed set).
    const r = result as { ok?: boolean; edgeType?: string; reason?: string } | undefined;
    if (r?.ok && r.edgeType) {
      // Quiet success — no toast; the row disappearing is the feedback.
      console.log(`[gll] promoted as [${r.edgeType}: "${relationship}"]`);
    } else if (r && !r.ok) {
      alert(`Could not promote: ${r.reason ?? 'unknown error'}`);
    }
  });
});
const btnGllRunNow = document.getElementById('btn-gll-run-now') as HTMLButtonElement | null;
btnGllRunNow?.addEventListener('click', () => {
  btnGllRunNow.disabled = true;
  btnGllRunNow.textContent = 'Predicting…';
  void ipcCall('gll:runPredictionNow', {})
    .then(() => { void refreshGllPredictedEdges(); })
    .finally(() => {
      btnGllRunNow.disabled = false;
      btnGllRunNow.textContent = 'Run prediction now';
    });
});
document.getElementById('btn-gll-refresh')?.addEventListener('click', () => {
  void refreshGllPredictedEdges();
});
// Initial render once after first paint; subsequent refreshes are
// button-driven (low-frequency content; no need to subscribe to events).
// Delay 5s so the sidecar IPC is reliably up before we ask — the previous
// 2s window raced cortex-unlock and produced a "could not load: undefined"
// flash on slow boots.
setTimeout(() => { void refreshGllPredictedEdges(); }, 5_000);

// ── Reingest-all progress ──────────────────────────────────────────────────
//
// Driven by the 'reingest.progress' event channel. Phases:
// 'snapshot' → 'reingesting' (per-source counter) → 'done' (with summary).
// Triggered by the "Reingest all sources" button in Settings → Ingest.
interface ReingestPerGraphResult {
  graphId: string;
  reingested: number;
  skipped: Array<{ sourceId: string; reason: string }>;
  failed: Array<{ sourceId: string; ref: string; error: string }>;
}
interface ReingestProgressPayload {
  phase: 'snapshot' | 'reingesting' | 'done';
  graphId?: string;
  graphIndex?: number;
  graphsTotal?: number;
  sourceId?: string;
  ref?: string;
  index?: number;
  total?: number;
  reingested?: number;
  cancelled?: boolean;
  skipped?: number | Array<{ sourceId: string; reason: string }>;
  failed?: number | Array<{ sourceId: string; error: string }>;
  perGraph?: ReingestPerGraphResult[];
}
/**
 * Open the shared reingest-progress modal and kick off a reingest.
 *
 * Pass `graphId` + `displayName` to scope the operation to a single engram
 * (calls `engram:reingestAll`). Omit both to reingest every engram
 * (`engrams:reingestAll`).
 */
export function openReingestModal(opts?: { graphId: string; displayName: string }): void {
  const modal = document.getElementById('reingest-modal');
  const phaseEl = document.getElementById('reingest-phase');
  const detailEl = document.getElementById('reingest-detail');
  const barEl = document.getElementById('reingest-bar');
  const counterEl = document.getElementById('reingest-counter');
  const summaryEl = document.getElementById('reingest-summary');
  const closeBtn = document.getElementById('reingest-close') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('reingest-cancel') as HTMLButtonElement | null;
  if (!modal || !phaseEl || !detailEl || !barEl || !counterEl || !summaryEl || !closeBtn || !cancelBtn) return;
  modal.classList.remove('hidden');
  closeBtn.disabled = true;
  closeBtn.onclick = () => modal.classList.add('hidden');
  // Cancel is enabled for the duration of the operation; the done event
  // re-disables and resets the label so a subsequent run starts clean.
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => {
    cancelBtn.disabled = true;
    cancelBtn.textContent = 'Cancelling…';
    void ipcCall('reingest:cancel', {}).catch(() => { /* non-fatal */ });
  };
  phaseEl.textContent = 'Starting…';
  detailEl.textContent = opts
    ? `Taking a snapshot of "${opts.displayName}" first.`
    : 'Taking a snapshot of every engram first.';
  barEl.style.width = '0%';
  counterEl.textContent = '';
  summaryEl.style.display = 'none';
  summaryEl.innerHTML = '';
  const ipc = opts
    ? ipcCall('engram:reingestAll', { graphId: opts.graphId })
    : ipcCall('engrams:reingestAll', {});
  void ipc.catch((err) => {
    closeBtn.disabled = false;
    phaseEl.textContent = 'Reingest failed';
    detailEl.textContent = String((err as Error).message ?? err);
  });
}
void listen<ReingestProgressPayload>('graphnosis://reingest-progress', (evt) => {
  const phaseEl = document.getElementById('reingest-phase');
  const detailEl = document.getElementById('reingest-detail');
  const barEl = document.getElementById('reingest-bar');
  const counterEl = document.getElementById('reingest-counter');
  const summaryEl = document.getElementById('reingest-summary');
  const closeBtn = document.getElementById('reingest-close') as HTMLButtonElement | null;
  if (!phaseEl || !detailEl || !barEl || !counterEl || !summaryEl || !closeBtn) return;
  const p = evt.payload;
  switch (p.phase) {
    case 'snapshot':
      phaseEl.textContent = 'Snapshotting engrams…';
      detailEl.textContent = 'Saving current chunks/vectors so they\'re recoverable.';
      barEl.style.width = '5%';
      break;
    case 'reingesting': {
      const gi = p.graphIndex ?? 0;
      const gt = Math.max(1, p.graphsTotal ?? 1);
      const idx = p.index ?? 0;
      const total = Math.max(1, p.total ?? 1);
      // Outer (engram) progress: 10% → 95% across all engrams. Inner (source)
      // progress is added proportionally inside the current engram's slot.
      const outer = 10 + (gi / gt) * 85;
      const innerSlot = (1 / gt) * 85;
      const pct = Math.min(95, outer + (idx / total) * innerSlot);
      barEl.style.width = `${pct}%`;
      phaseEl.textContent = 'Reingesting your memory…';
      if (p.sourceId) {
        detailEl.textContent = `${p.graphId ?? ''} — ${p.ref ?? p.sourceId} (${idx + 1} of ${total})`;
      } else {
        detailEl.textContent = `Engram ${gi + 1} of ${gt}: finishing up…`;
      }
      counterEl.textContent = `Engram ${gi + 1} / ${gt} · Source ${Math.min(idx + 1, total)} / ${total}`;
      break;
    }
    case 'done': {
      barEl.style.width = '100%';
      phaseEl.textContent = p.cancelled ? 'Cancelled' : 'Done';
      const reingested = p.reingested ?? 0;
      const skippedCount = typeof p.skipped === 'number' ? p.skipped : (p.skipped?.length ?? 0);
      const failedCount = typeof p.failed === 'number' ? p.failed : (p.failed?.length ?? 0);
      detailEl.textContent = p.cancelled
        ? `Cancelled after reingesting ${reingested} source(s). ${skippedCount} skipped before cancel. Remaining sources kept their old chunks (recoverable from snapshot).`
        : `Reingested ${reingested} source(s). ${skippedCount} skipped. ${failedCount} failed.`;
      counterEl.textContent = '';
      // Reset the cancel button so a future reingest starts clean.
      const cancelBtn = document.getElementById('reingest-cancel') as HTMLButtonElement | null;
      if (cancelBtn) { cancelBtn.disabled = true; cancelBtn.textContent = 'Cancel'; }
      // Detailed per-engram summary when we have the structured data.
      if (Array.isArray(p.perGraph) && p.perGraph.length > 0) {
        const rows = p.perGraph.map((g) => {
          const displayName = app().getLoadedGraphs().find((lg) => lg.graphId === g.graphId)?.metadata.displayName ?? g.graphId;
          const parts: string[] = [`<strong>${escape(displayName)}</strong>: ${g.reingested} reingested`];
          if (g.skipped.length > 0) parts.push(`${g.skipped.length} skipped`);
          if (g.failed.length > 0) parts.push(`<span style="color:var(--error)">${g.failed.length} failed</span>`);
          let detail = `<div style="margin-bottom:6px;">${parts.join(' · ')}</div>`;
          // List individual failures with their error messages so the user
          // can see exactly what went wrong (lock files, missing cache, etc.)
          if (g.failed.length > 0) {
            const failLines = g.failed.map((f) => {
              const name = escape(f.ref ? (f.ref.split('/').pop() ?? f.ref) : (f.sourceId.split(':').pop() ?? f.sourceId));
              const err  = escape(f.error ?? 'unknown error');
              return `<div style="margin-left:10px;font-size:11px;color:var(--error);margin-bottom:2px;">✗ ${name}: ${err}</div>`;
            });
            detail += failLines.join('');
          }
          return detail;
        });
        summaryEl.innerHTML = rows.join('');
        summaryEl.style.display = '';
      }
      closeBtn.disabled = false;
      break;
    }
  }
});

const btnReingestAll = document.getElementById('btn-reingest-all') as HTMLButtonElement | null;
btnReingestAll?.addEventListener('click', () => {
  if (!confirm('Reingest every source across every engram?\n\nThis re-chunks and re-embeds all your saved memory using current settings. A snapshot is taken first. Can take several minutes on large cortexes.')) return;
  openReingestModal();
});

el('btnOllamaPull').addEventListener('click', async () => {
  const model = el('ollamaPullSelect').value;
  if (!model) return;
  el('ollamaPullProgress').style.display = '';
  el('ollamaPullBar').style.width = '0%';
  el('ollamaPullLabel').textContent = `Pulling ${model}…`;
  el('btnOllamaPull').disabled = true;

  try {
    await ipcCall('llm:pullModel', { model });
    el('ollamaPullLabel').textContent = `${model} ready`;
    await refreshLlmStatus();
  } catch (e) {
    el('ollamaPullLabel').textContent = `Failed: ${(e as Error).message}`;
  } finally {
    el('btnOllamaPull').disabled = false;
    setTimeout(() => { el('ollamaPullProgress').style.display = 'none'; }, 3000);
  }
});

el('btnOpenOllamaSite').addEventListener('click', (e) => {
  e.preventDefault();
  void invoke('open_external_url', { url: 'https://ollama.com/download' });
});

// ── Permanent-consent confirmation modal (A3, A10) ────────────────────────
export function confirmPermanent(bodyText: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById('permanent-confirm-modal');
    const body = document.getElementById('permanent-confirm-body');
    const okBtn = document.getElementById('btn-permanent-confirm-ok') as HTMLButtonElement | null;
    const cancelBtn = document.getElementById('btn-permanent-confirm-cancel') as HTMLButtonElement | null;
    if (!modal || !okBtn || !cancelBtn) { resolve(true); return; }
    if (body) body.textContent = bodyText;
    modal.classList.remove('hidden');
    const cleanup = () => {
      modal.classList.add('hidden');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
    };
    okBtn.onclick = () => { cleanup(); resolve(true); };
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
  });
}

// ── Copy-to-clipboard for consent phrases (A3) ────────────────────────────
let clipboardWarningShown = false;
async function copyPhraseToClipboard(tier: 'personal' | 'sensitive'): Promise<void> {
  const phraseEl = document.getElementById(`consent-phrase-${tier}`);
  const phrase = phraseEl?.textContent?.trim();
  if (!phrase || phrase === '—') return;
  if (!clipboardWarningShown) {
    const ok = await confirmPermanent(
      'Heads up: any app on this machine with clipboard access can read this phrase while it sits in the clipboard. ' +
      'Type it directly into your AI conversation when possible. Continue?',
    );
    if (!ok) return;
    clipboardWarningShown = true;
  }
  try {
    await navigator.clipboard.writeText(phrase);
    const btn = document.getElementById(`btn-copy-phrase-${tier}`) as HTMLButtonElement | null;
    if (btn) {
      btn.classList.add('copied');
      const orig = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.classList.remove('copied'); if (btn) btn.textContent = orig; }, 1500);
    }
  } catch (e) {
    showError(`Could not copy: ${e}`);
  }
}
document.getElementById('btn-copy-phrase-personal')?.addEventListener('click', () => void copyPhraseToClipboard('personal'));
document.getElementById('btn-copy-phrase-sensitive')?.addEventListener('click', () => void copyPhraseToClipboard('sensitive'));

// ── Consent phrase panel ──────────────────────────────────────────────────

let consentPhraseTimer: ReturnType<typeof setInterval> | null = null;

async function refreshConsentPhrases(): Promise<void> {
  const personalEl = document.getElementById('consent-phrase-personal') as HTMLSpanElement | null;
  const sensitiveEl = document.getElementById('consent-phrase-sensitive') as HTMLSpanElement | null;
  const errEl = document.getElementById('consent-phrase-error') as HTMLParagraphElement | null;
  if (!personalEl && !sensitiveEl) return;
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  try {
    const [personal, sensitive] = await Promise.all([
      invoke<{ phrase: string; expiresAt: number }>('get_consent_phrase', { tier: 'personal' }),
      invoke<{ phrase: string; expiresAt: number }>('get_consent_phrase', { tier: 'sensitive' }),
    ]);
    if (personalEl) personalEl.textContent = personal.phrase;
    if (sensitiveEl) sensitiveEl.textContent = sensitive.phrase;
    updatePhraseCountdown('personal', personal.expiresAt);
    updatePhraseCountdown('sensitive', sensitive.expiresAt);
  } catch (e) {
    const msg = String(e);
    if (errEl) {
      errEl.style.display = 'block';
      errEl.textContent = msg.includes('not found') || msg.includes('unknown command')
        ? 'Consent phrase command not registered — restart Graphnosis (pnpm dev:desktop) to load the new build.'
        : `Could not load consent phrases: ${msg}`;
    }
  }
}

function updatePhraseCountdown(tier: 'personal' | 'sensitive', expiresAt: number): void {
  const el = document.getElementById(`consent-phrase-${tier}-countdown`) as HTMLSpanElement | null;
  if (!el) return;
  const msLeft = expiresAt - Date.now();
  if (msLeft <= 0) { el.textContent = 'Rotating…'; return; }
  const hLeft = Math.floor(msLeft / 3_600_000);
  const mLeft = Math.floor((msLeft % 3_600_000) / 60_000);
  const sLeft = Math.floor((msLeft % 60_000) / 1_000);
  if (hLeft > 0) el.textContent = `expires in ${hLeft}h ${mLeft}m`;
  else if (mLeft > 0) el.textContent = `expires in ${mLeft}m ${sLeft}s`;
  else el.textContent = `expires in ${sLeft}s`;
}

function startConsentPhraseTimer(): void {
  stopConsentPhraseTimer();
  consentPhraseTimer = setInterval(() => {
    // Refresh countdown every second; re-fetch phrase on the minute boundary.
    const pEl = document.getElementById('consent-phrase-personal') as HTMLSpanElement | null;
    const sEl = document.getElementById('consent-phrase-sensitive') as HTMLSpanElement | null;
    if (!pEl && !sEl) { stopConsentPhraseTimer(); return; }
    void refreshConsentPhrases();
  }, 30_000); // refresh every 30s so countdown stays roughly accurate
}

function stopConsentPhraseTimer(): void {
  if (consentPhraseTimer !== null) { clearInterval(consentPhraseTimer); consentPhraseTimer = null; }
}

// ── Active consent list auto-refresh ─────────────────────────────────────
// The consent table is rendered on modal open and then kept live.
// Two timers work together:
//   • clockTimer (5 s) — re-renders from cached data, no IPC round-trip.
//     Catches consents that expired since the last IPC fetch.
//   • fetchTimer (15 s) — re-fetches settings from the sidecar and re-renders,
//     so newly-granted or newly-revoked consents appear without reopening.
let consentListClockTimer: ReturnType<typeof setInterval> | null = null;
let consentListFetchTimer: ReturnType<typeof setInterval> | null = null;
// Last-fetched consent array; clock timer re-renders from this without IPC.
let _cachedConsents: AppSettings['ai']['dataAccessConsents'] = [];

function startConsentListTimer(): void {
  stopConsentListTimer();
  // Clock-only re-render every 5 s — cheap, no IPC.
  consentListClockTimer = setInterval(() => {
    renderActiveConsents(_cachedConsents);
  }, 5_000);
  // Full re-fetch every 15 s to pick up grants/revocations from AI clients.
  consentListFetchTimer = setInterval(() => {
    void invoke('get_settings').then((s) => {
      _cachedConsents = (s as AppSettings).ai?.dataAccessConsents ?? [];
      renderActiveConsents(_cachedConsents);
    });
  }, 15_000);
}

function stopConsentListTimer(): void {
  if (consentListClockTimer !== null) { clearInterval(consentListClockTimer); consentListClockTimer = null; }
  if (consentListFetchTimer !== null) { clearInterval(consentListFetchTimer); consentListFetchTimer = null; }
}

// ── Active consent records rendering ─────────────────────────────────────

function formatConsentExpiry(record: { expiresAt: number; windowMs: number }): string {
  if (record.windowMs === -1 || record.expiresAt >= Number.MAX_SAFE_INTEGER - 1) return 'permanent';
  if (record.expiresAt <= Date.now()) return 'expired';
  return `expires ${new Date(record.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function renderActiveConsents(consents: AppSettings['ai']['dataAccessConsents']): void {
  const container = document.getElementById('consent-active-list');
  if (!container) return;
  const now = Date.now();
  // Hard expiry gate: exclude withdrawn records AND any record whose
  // expiresAt is in the past regardless of windowMs value.
  const active = (consents ?? []).filter(
    (c) => !c.withdrawnAt &&
           (c.windowMs === -1 || (typeof c.expiresAt === 'number' && c.expiresAt > now)),
  );
  if (active.length === 0) {
    container.innerHTML = '<p class="subtitle" style="font-size:14px;">No active AI consents.</p>';
    return;
  }
  const tierColors: Record<string, string> = {
    personal: '#d4a004', sensitive: '#ef4444', public: '#22c55e',
  };
  container.innerHTML = `
    <table class="consent-active-table">
      <thead><tr><th>AI client</th><th>Tier</th><th>Expiry</th><th></th></tr></thead>
      <tbody>
        ${active.map((c) => `
          <tr>
            <td><span data-pres="surface:mcpClients">${escape(c.clientName)}</span></td>
            <td><span style="color:${tierColors[c.tier] ?? 'inherit'}; font-weight:600;">${escape(c.tier)}</span></td>
            <td style="font-size:13px; color:var(--fg-dim);">${formatConsentExpiry(c)}</td>
            <td><button class="btn-revoke-one" data-consent-id="${escape(c.consentId)}" data-client="${escape(c.clientName)}" data-tier="${escape(c.tier)}" style="font-size:12px; padding:2px 8px;">Revoke</button></td>
          </tr>
        `).join('')}
      </tbody>
    </table>`;

  container.querySelectorAll<HTMLButtonElement>('.btn-revoke-one').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const clientName = btn.dataset.client ?? '';
      const tier = btn.dataset.tier as 'personal' | 'sensitive';
      btn.disabled = true;
      try {
        await invoke('revoke_ai_consents', { clientName, tier });
        const s = (await invoke('get_settings')) as AppSettings;
        _cachedConsents = s.ai?.dataAccessConsents ?? [];
        renderActiveConsents(_cachedConsents);
      } catch (e) {
        showError(`Could not revoke: ${e}`);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// ── Settings modal — AI consent wiring ───────────────────────────────────

function describeInterval(tier: 'personal' | 'sensitive', value: string, optionLabel: string): string {
  if (value === '-1') return `AI clients can access ${tier} data without re-confirming — until you revoke.`;
  if (value === '0')  return `Graphnosis will ask for a phrase before every ${tier}-tier recall.`;
  return `Graphnosis will remember ${tier} consent for ${optionLabel.toLowerCase()}, then ask again.`;
}

function updateConsentIntervalHint(): void {
  const selP = document.getElementById('consent-interval-personal') as HTMLSelectElement | null;
  const selS = document.getElementById('consent-interval-sensitive') as HTMLSelectElement | null;
  const hint = document.getElementById('consent-interval-hint');
  if (!hint) return;
  const lines: string[] = [];
  if (selP) lines.push(describeInterval('personal', selP.value, selP.options[selP.selectedIndex]?.text ?? ''));
  if (selS) lines.push(describeInterval('sensitive', selS.value, selS.options[selS.selectedIndex]?.text ?? ''));
  hint.textContent = lines.join(' · ');
}

// Extend Settings open to load consent data.
const _originalSettingsOpen = el('btnSettings').onclick;
el('btnSettings').addEventListener('click', async () => {
  // Phrases
  void refreshConsentPhrases();
  startConsentPhraseTimer();
  startConsentListTimer();

  // Interval selectors
  try {
    const s = (await invoke('get_settings')) as AppSettings;
    const iPersonal = document.getElementById('consent-interval-personal') as HTMLSelectElement | null;
    const iSensitive = document.getElementById('consent-interval-sensitive') as HTMLSelectElement | null;
    if (iPersonal) {
      iPersonal.value = String(s.ai?.consentIntervalPersonalMs ?? -1);
    }
    if (iSensitive) {
      iSensitive.value = String(s.ai?.consentIntervalSensitiveMs ?? 3_600_000);
    }
    updateConsentIntervalHint();
    _cachedConsents = s.ai?.dataAccessConsents ?? [];
    renderActiveConsents(_cachedConsents);

    // Extra-precaution mode toggle — gates personal-tier recall behind the
    // in-app consent modal (off by default, sensitive tier always gated).
    const extraCb = document.getElementById('extra-precaution-mode') as HTMLInputElement | null;
    if (extraCb) {
      extraCb.checked = s.ai?.extraPrecautionMode === true;
      extraCb.onchange = () => {
        void invoke('update_settings', {
          patch: { ai: { extraPrecautionMode: extraCb.checked } },
        }).catch((e) => console.error('extraPrecautionMode update failed', e));
      };
    }

    // Use Local LLM only for search — single checkbox.
    const llmOnlyCb = document.getElementById('search-llm-only') as HTMLInputElement | null;
    if (llmOnlyCb) llmOnlyCb.checked = s.ai?.searchLlmOnly === true;

    // Session caps — load each checkbox + numeric value, sync disabled state.
    const capRows: Array<[string, keyof NonNullable<AppSettings['ai']>, keyof NonNullable<AppSettings['ai']>, number]> = [
      ['session-token-cap', 'sessionTokenCap', 'sessionTokenCapEnabled', 100_000],
      ['session-node-cap', 'sessionNodeCap', 'sessionNodeCapEnabled', 500],
      ['session-breadth-cap', 'sessionBreadthCap', 'sessionBreadthCapEnabled', 6],
    ];
    for (const [id, valKey, enabledKey, fallback] of capRows) {
      const cb = document.getElementById(`${id}-enabled`) as HTMLInputElement | null;
      const num = document.getElementById(id) as HTMLInputElement | null;
      if (!cb || !num) continue;
      const aiAny = (s.ai ?? {}) as Record<string, unknown>;
      const enabled = aiAny[enabledKey] === true;
      const val = typeof aiAny[valKey] === 'number' ? (aiAny[valKey] as number) : fallback;
      cb.checked = enabled;
      num.value = String(val);
      num.disabled = !enabled;
    }
  } catch { /* settings unavailable — leave defaults */ }
});

// Session-cap checkboxes: enable/disable the paired number input.
for (const id of ['session-token-cap', 'session-node-cap', 'session-breadth-cap']) {
  const cb = document.getElementById(`${id}-enabled`) as HTMLInputElement | null;
  const num = document.getElementById(id) as HTMLInputElement | null;
  if (!cb || !num) continue;
  cb.addEventListener('change', () => { num.disabled = !cb.checked; });
}

// Interval hint updates live as dropdown changes.
// Picking "Permanent" requires a brief confirmation modal.
for (const id of ['consent-interval-personal', 'consent-interval-sensitive']) {
  const sel = document.getElementById(id) as HTMLSelectElement | null;
  if (!sel) continue;
  let previousValue = sel.value;
  sel.addEventListener('change', async () => {
    if (sel.value === '-1' && previousValue !== '-1') {
      const tier = id.endsWith('personal') ? 'personal' : 'sensitive';
      const ok = await confirmPermanent(
        `AI clients will be able to access ${tier} memories without re-confirming, until you revoke. ` +
        'Revoke anytime in Settings → AI.',
      );
      if (!ok) {
        sel.value = previousValue;
        return;
      }
    }
    previousValue = sel.value;
    updateConsentIntervalHint();
  });
}

// Stop timers when modal closes.
el('btnSettingsCancel').addEventListener('click', () => { stopConsentPhraseTimer(); stopConsentListTimer(); });

// Extend Settings save to persist consent interval settings.
const _origSave = el('btnSettingsSave').onclick;
void _origSave; // reference to suppress unused-variable lint
el('btnSettingsSave').addEventListener('click', async () => {
  const iPersonal = document.getElementById('consent-interval-personal') as HTMLSelectElement | null;
  const iSensitive = document.getElementById('consent-interval-sensitive') as HTMLSelectElement | null;
  if (!iPersonal && !iSensitive) return;
  stopConsentPhraseTimer();
  stopConsentListTimer();
  try {
    const current = (await invoke('get_settings')) as AppSettings;
    const pVal = parseInt(iPersonal?.value ?? '-1', 10);
    const sVal = parseInt(iSensitive?.value ?? '3600000', 10);

    // Session caps — read checkbox + number from DOM.
    const readCap = (id: string, fallback: number): { enabled: boolean; value: number } => {
      const cb = document.getElementById(`${id}-enabled`) as HTMLInputElement | null;
      const num = document.getElementById(id) as HTMLInputElement | null;
      const enabled = !!cb?.checked;
      const value = num ? (parseInt(num.value, 10) || fallback) : fallback;
      return { enabled, value };
    };
    const tokenCap = readCap('session-token-cap', 100_000);
    const nodeCap = readCap('session-node-cap', 500);
    const breadthCap = readCap('session-breadth-cap', 6);

    // Use Local LLM only for search — single checkbox.
    const llmOnlyCb = document.getElementById('search-llm-only') as HTMLInputElement | null;
    const searchLlmOnly = !!llmOnlyCb?.checked;

    await invoke('update_settings', {
      // Patch ONLY ai — this handler owns consent intervals + session caps.
      // Spreading `...current` (the whole settings) re-saved a STALE `brain`
      // object and raced the main save handler, clobbering brain.lowPowerMode
      // (turning Low-power OFF reverted to ON). The IPC merges per top-level key,
      // so omitting brain/ui/etc. leaves them untouched.
      settings: {
        ai: {
          ...current.ai,
          consentIntervalPersonalMs: isNaN(pVal) ? -1 : pVal,
          consentIntervalSensitiveMs: isNaN(sVal) ? 3_600_000 : sVal,
          sessionTokenCapEnabled: tokenCap.enabled,
          sessionTokenCap: tokenCap.value,
          sessionNodeCapEnabled: nodeCap.enabled,
          sessionNodeCap: nodeCap.value,
          sessionBreadthCapEnabled: breadthCap.enabled,
          sessionBreadthCap: breadthCap.value,
          searchLlmOnly,
        },
      },
    });
  } catch { /* save failure is already handled by main save handler */ }
});

// Revoke all consents button.
document.getElementById('btn-revoke-all-consents')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-revoke-all-consents') as HTMLButtonElement;
  btn.disabled = true;
  try {
    await invoke('revoke_ai_consents', {});
    const s = (await invoke('get_settings')) as AppSettings;
    _cachedConsents = s.ai?.dataAccessConsents ?? [];
    renderActiveConsents(_cachedConsents);
  } catch (e) {
    showError(`Could not revoke: ${e}`);
  } finally {
    btn.disabled = false;
  }
});

// View consent history — shows all records including expired/withdrawn.
document.getElementById('btn-view-consent-history')?.addEventListener('click', async () => {
  try {
    const history = await ipcCall<{ records: AppSettings['ai']['dataAccessConsents'] }>('ai.getConsentHistory', {});
    const records = history?.records ?? [];
    const rows = records
      .sort((a, b) => b.grantedAt - a.grantedAt)
      .map((r) => {
        const status = r.withdrawnAt ? 'revoked' : (r.windowMs === -1 || r.expiresAt > Date.now()) ? 'active' : 'expired';
        const statusColor = status === 'active' ? 'var(--ok)' : status === 'revoked' ? 'var(--error)' : 'var(--fg-dim)';
        return `<tr>
          <td>${new Date(r.grantedAt).toLocaleString()}</td>
          <td>${escape(r.clientName)}</td>
          <td>${escape(r.tier)}</td>
          <td style="color:${statusColor}; font-size:13px;">${status}</td>
        </tr>`;
      }).join('');
    showQuarantineConfirm({
      title: 'Consent history',
      subtitle: `${records.length} record${records.length === 1 ? '' : 's'} — all time`,
      warningHtml: records.length === 0
        ? '<p class="subtitle">No consent records yet.</p>'
        : `<table class="consent-active-table"><thead><tr><th>Granted</th><th>Client</th><th>Tier</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`,
      confirmPhrase: '',
      confirmLabel: 'Close',
      onConfirm: async () => {},
    });
  } catch (e) {
    showError(`Could not load consent history: ${e}`);
  }
});

// A8 — Export consent records as JSON (local backup / device transfer).
document.getElementById('btn-export-consent-records')?.addEventListener('click', async () => {
  try {
    const history = await ipcCall<{ records: AppSettings['ai']['dataAccessConsents'] }>('ai.getConsentHistory', {});
    const records = history?.records ?? [];
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      notice: 'These consent records are stored locally on your device. Nehloo has no access to them.',
      records,
    }, null, 2);
    const defaultName = `graphnosis-consent-records-${new Date().toISOString().slice(0, 10)}.json`;
    // Tauri WebViews don't support blob-URL downloads — use the native save dialog.
    await invoke('save_json_file', { defaultName, content: payload });
  } catch (e) {
    showError(`Could not export consent records: ${e}`);
  }
});

// ── Consent event listeners ───────────────────────────────────────────────

void listen<{ clientName: string; tier: string; expiresAt: number }>(
  'graphnosis://mcp-consent-granted',
  (ev) => {
    if (!ev.payload) return;
    const { clientName, tier, expiresAt } = ev.payload;
    const until = expiresAt >= Number.MAX_SAFE_INTEGER - 1
      ? 'permanently'
      : `until ${new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const toastId = h().addIngestToast(
      `${escape(clientName)} granted ${escape(tier)} access`,
      `Valid ${until}. Revoke in Settings → AI.`,
    );
    h().finishIngestToast(toastId, 'success');
    // Refresh active consents table if settings modal is open.
    void (async () => {
      try {
        const s = (await invoke('get_settings')) as AppSettings;
        _cachedConsents = s.ai?.dataAccessConsents ?? [];
        renderActiveConsents(_cachedConsents);
      } catch { /* ignore */ }
    })();
  },
);

void listen<{ clientName: string; tier: string }>(
  'graphnosis://mcp-consent-lockout',
  (ev) => {
    if (!ev.payload) return;
    const { clientName, tier } = ev.payload;
    const toastId = h().addIngestToast(
      `Too many failed attempts — ${escape(clientName)} / ${escape(tier)}`,
      'Consent reset. Check Settings → AI to re-grant access.',
    );
    h().finishIngestToast(toastId, 'error');
    void h().notifyIfBackground({
      title: 'Graphnosis — consent lockout',
      body: `Too many failed phrase attempts for ${clientName} (${tier}). Access revoked.`,
    });
  },
);

// Recall rate limit — fires when a client exceeds 10 recalls per 60s.
void listen<{ recentCalls: number; windowMs: number; maxPerWindow: number; waitMs: number }>(
  'graphnosis://mcp-recall-rate-limited',
  (ev) => {
    if (!ev.payload) return;
    const { recentCalls, maxPerWindow, waitMs } = ev.payload;
    const waitS = Math.ceil(waitMs / 1000);
    const toastId = h().addIngestToast(
      'Recall rate limit hit',
      `${recentCalls}/${maxPerWindow} recalls in the last minute. Throttled for ${waitS}s.`,
    );
    h().finishIngestToast(toastId, 'error');
  },
);

// Session replay blocker — fires when a near-duplicate query is detected.
void listen<{ similarity: number; previousQuery: string; ageSeconds: number }>(
  'graphnosis://mcp-session-replay-blocked',
  (ev) => {
    if (!ev.payload) return;
    const { similarity, ageSeconds } = ev.payload;
    const toastId = h().addIngestToast(
      'Session replay blocked',
      `Query was ${Math.round(similarity * 100)}% similar to one issued ${ageSeconds}s ago. Modify your query.`,
    );
    h().finishIngestToast(toastId, 'error');
  },
);

// ── License token (Graphnosis Pro) ──────────────────────────────────────────

export const BILLING_BASE_URL: string = (() => {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const v = env?.['PUBLIC_BILLING_BASE_URL'];
    if (v && v.trim().length > 0) return v.replace(/\/$/, '');
  } catch { /* non-Vite host */ }
  return 'https://graphnosis.com';
})();

export const BILLING_EMAIL_KEY = 'billing:email';
const BILLING_DOMAIN_EMAIL_KEY = 'billing:domainEmail';
const BILLING_POLL_KEY = 'billing:pollKey';
// Poll secret for the domain seat subscription — returned by verifyOtp.
// Kept separate so it never clobbers the Stripe pollSecret: both slots can
// be active simultaneously when the user has a personal sub + a domain seat.
const BILLING_DOMAIN_POLL_KEY = 'billing:domainPollKey';
// Timestamp of the last successful background poll. Throttles the silent
// unlock-time poll to once per 24 hours so the server never sends a
// spurious OTP email on every cortex unlock.
const BILLING_LAST_POLL_TS_KEY = 'billing:lastPollTs';
// Set when the user explicitly clicks "Activate work email" and the server
// returns otp_required. Cleared on verify, reset, or clearing the domain field.
// Prevents treating an abandoned domain OTP attempt as a silent refresh target.
const BILLING_DOMAIN_OTP_PENDING_KEY = 'billing:domainOtpPending';
const BILLING_POLL_THROTTLE_MS = 24 * 60 * 60 * 1000; // 24 h

interface LicenseTokenEntry {
  source: 'personal' | 'domain';
  plan: string;
  features: string[];
  sub: string;
  expiresAt: number;
  expiringSoon: boolean;
  renews: boolean;
}

interface LicenseStatus {
  present: boolean;
  valid?: boolean;
  plan?: string;
  features?: string[];
  sub?: string;
  expiresAt?: number;
  expiringSoon?: boolean;
  /** True when the subscription auto-renews at expiresAt; false when set to
   *  cancel at period end. Absent (legacy token) → treated as renewing. */
  renews?: boolean;
  /** All active license slots — personal subscription and/or domain seat. */
  tokens?: LicenseTokenEntry[];
}

export async function ipcLicenseStatus(): Promise<LicenseStatus> {
  try {
    return (await ipcCall<LicenseStatus>('license:status', {})) ?? { present: false };
  } catch {
    return { present: false };
  }
}

export async function ipcLicenseSetToken(token: string): Promise<{
  ok: boolean; reason?: string; plan?: string; features?: string[]; sub?: string; expiresAt?: number;
}> {
  return ipcCall('license:setToken', { token });
}

function clearBillingLocalCache(): void {
  localStorage.removeItem(BILLING_EMAIL_KEY);
  localStorage.removeItem(BILLING_DOMAIN_EMAIL_KEY);
  localStorage.removeItem(BILLING_POLL_KEY);
  localStorage.removeItem(BILLING_DOMAIN_POLL_KEY);
  localStorage.removeItem(BILLING_LAST_POLL_TS_KEY);
  localStorage.removeItem(BILLING_DOMAIN_OTP_PENDING_KEY);
}

function getStoredDomainEmail(): string {
  return localStorage.getItem(BILLING_DOMAIN_EMAIL_KEY)?.trim() ?? '';
}

function markDomainOtpPending(email: string): void {
  localStorage.setItem(BILLING_DOMAIN_OTP_PENDING_KEY, email.toLowerCase());
}

function clearDomainOtpPending(): void {
  localStorage.removeItem(BILLING_DOMAIN_OTP_PENDING_KEY);
}

export function clearAbandonedDomainVerificationCache(): void {
  // Domain/work email + pending OTP live in localStorage, which survives cortex
  // reset. Drop stale entries when no domain seat token is stored so unlock-time
  // polls cannot keep hitting the billing server for an abandoned verification.
  void ipcLicenseStatus().then((status) => {
    const hasDomainSeat = status.tokens?.some((t) => t.source === 'domain') ?? false;
    if (hasDomainSeat) {
      clearDomainOtpPending();
      return;
    }
    const domainEmail = getStoredDomainEmail();
    const pending = localStorage.getItem(BILLING_DOMAIN_OTP_PENDING_KEY);
    if (pending) {
      localStorage.removeItem(BILLING_DOMAIN_EMAIL_KEY);
      clearDomainOtpPending();
    }
    // Legacy builds wrote the work address into billing:email — scrub it when
    // it matches the abandoned domain address so Stripe refresh/poll won't reuse it.
    const stripeEmail = localStorage.getItem(BILLING_EMAIL_KEY)?.trim() ?? '';
    if (stripeEmail && domainEmail && stripeEmail.toLowerCase() === domainEmail.toLowerCase()) {
      localStorage.removeItem(BILLING_EMAIL_KEY);
    }
  }).catch(() => { /* non-fatal */ });
}

async function ipcLicenseClear(): Promise<void> {
  try { await ipcCall('license:clear', {}); } catch { /* ignore — local cleanup still runs */ }
  clearBillingLocalCache();
}

/** Best-known Stripe/personal receipt email — never the domain-seat address. */
async function getBillingEmail(): Promise<string | null> {
  const status = await ipcLicenseStatus();
  const personal = status.tokens?.find((t) => t.source === 'personal');
  if (personal?.sub?.includes('@')) return personal.sub;
  if (status.sub && status.sub.includes('@')) {
    const domain = status.tokens?.find((t) => t.source === 'domain');
    if (!domain || status.sub.toLowerCase() !== domain.sub.toLowerCase()) return status.sub;
  }
  const cached = localStorage.getItem(BILLING_EMAIL_KEY);
  return cached && cached.includes('@') ? cached : null;
}

export async function pollLicenseTokenFromServer(explicitEmail?: string): Promise<{ ok: boolean; reason?: string; plan?: string } | null> {
  let email = explicitEmail;
  let key: string | undefined;

  if (!explicitEmail) {
    // Silent unlock-time poll: only refresh a Stripe claim the device already
    // holds a poll secret for. Never auto-poll domain/work emails (OTP gate) or
    // trigger Stripe OTP recovery — those require an explicit user click.
    const status = await ipcLicenseStatus();
    if (status.present && status.valid) return null;
    key = localStorage.getItem(BILLING_POLL_KEY) ?? undefined;
    if (!key) return null;
    email = localStorage.getItem(BILLING_EMAIL_KEY)?.trim() ?? '';
    if (!email.includes('@')) return null;
    const domainEmail = getStoredDomainEmail();
    if (domainEmail && email.toLowerCase() === domainEmail.toLowerCase()) return null;
    if (localStorage.getItem(BILLING_DOMAIN_OTP_PENDING_KEY)) return null;
    const lastPoll = Number(localStorage.getItem(BILLING_LAST_POLL_TS_KEY) ?? 0);
    if (Date.now() - lastPoll < BILLING_POLL_THROTTLE_MS) return null;
    // Stamp before the network call so a failed/otp_required response cannot
    // cause a retry loop on every subsequent unlock within the throttle window.
    localStorage.setItem(BILLING_LAST_POLL_TS_KEY, String(Date.now()));
  } else {
    email = explicitEmail;
    key = localStorage.getItem(BILLING_POLL_KEY) ?? undefined;
  }

  if (!email) return null;

  try {
    // Done in the sidecar (Node) — a browser fetch to graphnosis.com is blocked
    // by CORS in BOTH dev (localhost:5173) and the installed app (tauri://…),
    // since the billing API only allows its own web origin. The sidecar has no
    // such restriction, validates the token, and persists it on success.
    const result = await ipcCall<{ ok: boolean; reason?: string; plan?: string }>(
      'license:pollServer', { email, key, baseUrl: BILLING_BASE_URL },
    );
    if (result?.ok) {
      console.log('[license] refreshed from server', result.plan);
      if (explicitEmail) {
        localStorage.setItem(BILLING_LAST_POLL_TS_KEY, String(Date.now()));
      }
      void refreshSettingsLicenseStatus();
    } else if (result?.reason && result.reason !== 'no_token' && result.reason !== 'otp_required') {
      console.warn('[license] server poll:', result.reason);
    }
    return result ?? null;
  } catch (e) {
    console.warn('[license] poll failed', e);
    return null;
  }
}

/** Disable "Activate work email" when the input matches the currently active sub. */
function syncDomainActivateBtn(): void {
  const btn = document.getElementById('btn-settings-license-domain-activate') as HTMLButtonElement | null;
  const input = document.getElementById('settings-license-domain-email') as HTMLInputElement | null;
  if (!btn || !input) return;
  const activeSub = (document.getElementById('license-modal') as HTMLElement | null)?.dataset.activeSub ?? '';
  btn.disabled = !!activeSub && input.value.trim().toLowerCase() === activeSub.toLowerCase();
}

/** Turn a raw plan slug into a human-readable label.
 *  e.g. "enterprise-annual" → "Enterprise Annual", "pro" → "Pro" */
export function humanizePlanName(plan: string): string {
  return plan.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** When subscribed, hide the "get a license" sections (Subscribe / Refresh /
 *  Paste) and show "Manage subscription"; otherwise the reverse. */
function setLicenseSectionMode(subscribed: boolean): void {
  document.querySelectorAll<HTMLElement>('#license-modal .license-acquire')
    .forEach((s) => s.classList.toggle('hidden', subscribed));
  document.querySelectorAll<HTMLElement>('#license-modal .license-manage')
    .forEach((s) => s.classList.toggle('hidden', !subscribed));
}

export async function refreshSettingsLicenseStatus(): Promise<void> {
  const el = document.getElementById('settings-license-status');
  if (!el) return;
  const status = await ipcLicenseStatus();
  if (!status.present) {
    el.innerHTML = '<span class="subtitle">No license stored. Paste a token below or refresh.</span>';
    (document.getElementById('license-modal') as HTMLElement | null)?.removeAttribute('data-active-sub');
    syncDomainActivateBtn();
    setLicenseSectionMode(false);
    return;
  }
  if (!status.valid) {
    el.innerHTML = '<span class="subtitle" style="color:var(--error);">Stored token is invalid or expired.</span>';
    (document.getElementById('license-modal') as HTMLElement | null)?.removeAttribute('data-active-sub');
    syncDomainActivateBtn();
    setLicenseSectionMode(false);
    return;
  }
  setLicenseSectionMode(true); // active subscription → show manage, hide acquire
  // Store the active sub email so the domain-activate button can compare against it.
  const modal = document.getElementById('license-modal');
  if (modal) modal.dataset.activeSub = status.sub ?? '';
  syncDomainActivateBtn();

  // Build a row per active token (personal subscription + domain seat can coexist).
  const tokens = status.tokens && status.tokens.length > 0
    ? status.tokens
    : [{ source: 'personal' as const, plan: status.plan ?? '', features: status.features ?? [], sub: status.sub ?? '', expiresAt: status.expiresAt ?? 0, expiringSoon: status.expiringSoon ?? false, renews: status.renews !== false }];

  const rowsHtml = tokens.map((t, i) => {
    const expires = t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : '—';
    const feats = t.features.join(', ');
    const renewing = t.renews !== false;
    const dateLabel = renewing ? 'Renews' : 'Expires';
    const warn = t.expiringSoon && !renewing
      ? ' <span style="color:var(--color-status-warn-gold);font-weight:600;">— expires soon</span>'
      : '';
    const sourceLabel = tokens.length > 1
      ? `<span style="font-size:11px;color:var(--fg-muted);margin-left:6px;">(${t.source === 'domain' ? 'domain seat' : 'personal'})</span>`
      : '';
    const divider = i > 0 ? 'border-top:1px solid var(--border);margin-top:6px;padding-top:6px;' : '';
    // Email + expiry are PII — always redacted in Presentation Mode.
    return `
      <div style="display:flex; flex-direction:column; gap:2px;${divider}">
        <span><strong style="color:var(--ok);">${escape(humanizePlanName(t.plan || 'Pro'))}</strong>${sourceLabel} active for <strong data-pres="surface:__licensepii__">${escape(t.sub)}</strong></span>
        <span class="subtitle">Features: ${escape(feats)} · ${dateLabel} <span data-pres="surface:__licensepii__">${escape(expires)}</span>${warn}</span>
      </div>`;
  }).join('');

  el.innerHTML = `<div style="display:flex; flex-direction:column; gap:0;">${rowsHtml}</div>`;
}

export function bindSettingsLicensePanel(): void {
  // Tracks whether the OTP section was triggered by the Stripe recovery path
  // (vs. the domain seat path). Determines which slot to write the token into
  // and which localStorage key to use for the poll secret.
  let stripeOtpPending = false;

  const applyBtn = document.getElementById('btn-settings-license-apply') as HTMLButtonElement | null;
  const refreshBtn = document.getElementById('btn-settings-license-refresh') as HTMLButtonElement | null;
  const input = document.getElementById('settings-license-input') as HTMLTextAreaElement | null;
  const feedback = document.getElementById('settings-license-feedback');

  // Manage / cancel — opens the email-verified billing portal on graphnosis.com
  // (NOT a by-email portal link, which would have the same leak as the old
  // token poll; the server gates portal access behind magic-link auth).
  document.getElementById('btn-license-manage')?.addEventListener('click', () => {
    void invoke('plugin:opener|open_url', { url: `${BILLING_BASE_URL}/account` });
  });

  applyBtn?.addEventListener('click', async () => {
    const token = input?.value.trim() ?? '';
    if (!token) {
      if (feedback) feedback.textContent = 'Paste a token first.';
      return;
    }
    applyBtn.disabled = true;
    if (feedback) feedback.textContent = 'Validating…';
    try {
      const result = await ipcLicenseSetToken(token);
      if (result.ok) {
        if (feedback) feedback.textContent = `Saved — ${humanizePlanName(result.plan ?? 'Pro')} active.`;
        if (input) input.value = '';
        if (result.sub) {
          localStorage.setItem(BILLING_EMAIL_KEY, result.sub);
          const ei = document.getElementById('settings-license-email') as HTMLInputElement | null;
          if (ei) ei.value = result.sub;
        }
        await refreshSettingsLicenseStatus();
      } else {
        if (feedback) feedback.textContent = `Rejected: ${result.reason ?? 'invalid_or_expired'}`;
      }
    } catch (e) {
      console.warn('[license] apply failed', e);
      if (feedback) feedback.textContent = 'Apply failed.';
    } finally {
      applyBtn.disabled = false;
    }
  });

  const emailInput = document.getElementById('settings-license-email') as HTMLInputElement | null;
  const domainEmailInput = document.getElementById('settings-license-domain-email') as HTMLInputElement | null;
  const domainActivateBtn = document.getElementById('btn-settings-license-domain-activate') as HTMLButtonElement | null;
  const domainFeedback = document.getElementById('settings-license-domain-feedback');

  // Persist Stripe email to localStorage on blur.
  emailInput?.addEventListener('blur', () => {
    const v = emailInput.value.trim();
    if (v) localStorage.setItem(BILLING_EMAIL_KEY, v);
  });

  // Persist domain/work email to localStorage on blur; sync button state on every keystroke.
  domainEmailInput?.addEventListener('blur', () => {
    const v = domainEmailInput.value.trim();
    if (v) {
      localStorage.setItem(BILLING_DOMAIN_EMAIL_KEY, v);
    } else {
      localStorage.removeItem(BILLING_DOMAIN_EMAIL_KEY);
      clearDomainOtpPending();
    }
  });
  domainEmailInput?.addEventListener('input', () => syncDomainActivateBtn());

  // ── Stripe / Pro refresh path ──────────────────────────────────────────────
  refreshBtn?.addEventListener('click', async () => {
    const email = (emailInput?.value ?? '').trim()
      || (await getBillingEmail())
      || '';
    if (!email) {
      emailInput?.focus();
      if (feedback) feedback.textContent = 'Enter your Stripe receipt email first.';
      return;
    }
    localStorage.setItem(BILLING_EMAIL_KEY, email);
    if (emailInput && !emailInput.value) emailInput.value = email;
    refreshBtn.disabled = true;
    if (feedback) feedback.textContent = 'Asking the billing server…';
    try {
      const result = await pollLicenseTokenFromServer(email);
      if (result?.reason === 'otp_required') {
        // Server triggered OTP re-auth for Stripe recovery (stale/missing poll secret).
        stripeOtpPending = true;
        const otpSection = document.getElementById('license-otp-section');
        const otpEmailDisplay = document.getElementById('license-otp-email-display');
        if (otpEmailDisplay) otpEmailDisplay.textContent = email;
        otpSection?.classList.remove('hidden');
        otpSection?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        document.getElementById('settings-license-otp')?.focus();
        if (feedback) feedback.textContent = 'Check your inbox for a 6-digit recovery code.';
        return;
      }
      if (result?.reason === 'http_429') {
        if (feedback) feedback.textContent = 'Too many requests — wait a moment and try again.';
        return;
      }
      if (result?.reason === 'http_410') {
        if (feedback) feedback.textContent = 'This address has been revoked. Contact your administrator.';
        return;
      }
      if (result?.reason?.startsWith('http_')) {
        if (feedback) feedback.textContent = `Server error (${result.reason}). Try again shortly.`;
        return;
      }
      if (result?.reason === 'network_blocked' || result?.reason?.startsWith('fetch_failed')) {
        if (feedback) feedback.textContent = 'Could not reach the billing server — check your connection and try again.';
        return;
      }
      if (result?.reason === 'no_token') {
        // 204 from billing server. If a poll key was present, it was stale or
        // belonged to a different subscription (domain-seat key clobbered the
        // Stripe key). Clear it and retry without — for Stripe personal
        // subscriptions the server should return the token on a bare email lookup.
        const hadStaleKey = !!localStorage.getItem(BILLING_POLL_KEY);
        if (hadStaleKey) {
          localStorage.removeItem(BILLING_POLL_KEY);
          if (feedback) feedback.textContent = 'Retrying…';
          const retry = await pollLicenseTokenFromServer(email);
          if (retry?.ok) {
            const retryStatus = await ipcLicenseStatus();
            if (feedback) feedback.textContent = retryStatus.valid
              ? `Refreshed — ${humanizePlanName(retryStatus.plan ?? 'Pro')} active.`
              : `No subscription found for ${email}.`;
            return;
          }
          // Retry also failed — fall through to the "check email" message.
        }
        if (feedback) {
          feedback.innerHTML = 'No subscription found. Email <a href="mailto:support@graphnosis.com">support@graphnosis.com</a> to recover your license.';
        }
        return;
      }
      if (result && !result.ok) {
        if (feedback) feedback.textContent = `Activation failed — ${result.reason ?? 'unknown'}`;
        return;
      }
      const status = await ipcLicenseStatus();
      if (feedback) {
        feedback.textContent = status.valid
          ? `Refreshed — ${humanizePlanName(status.plan ?? 'Pro')} active.`
          : `No subscription found for ${email}.`;
      }
    } finally {
      refreshBtn.disabled = false;
    }
  });

  // ── Domain / work-email activation path ───────────────────────────────────
  domainActivateBtn?.addEventListener('click', async () => {
    const email = (domainEmailInput?.value ?? '').trim();
    if (!email) {
      domainEmailInput?.focus();
      if (domainFeedback) domainFeedback.textContent = 'Enter your work email address.';
      return;
    }
    localStorage.setItem(BILLING_DOMAIN_EMAIL_KEY, email);
    domainActivateBtn.disabled = true;
    if (domainFeedback) domainFeedback.textContent = 'Sending verification code…';
    try {
      // Explicitly omit the poll key — always drive through the domain OTP path.
      const result = await ipcCall<{ ok: boolean; reason?: string; plan?: string }>(
        'license:pollServer', { email, baseUrl: BILLING_BASE_URL },
      );
      if (result?.reason === 'otp_required') {
        markDomainOtpPending(email);
        const otpSection = document.getElementById('license-otp-section');
        const otpEmailDisplay = document.getElementById('license-otp-email-display');
        if (otpEmailDisplay) otpEmailDisplay.textContent = email;
        otpSection?.classList.remove('hidden');
        otpSection?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        document.getElementById('settings-license-otp')?.focus();
        if (domainFeedback) domainFeedback.textContent = 'Check your inbox for a 6-digit code.';
        return;
      }
      if (result?.reason === 'http_402') {
        if (domainFeedback) domainFeedback.textContent = 'Seat limit reached for this domain. Contact your administrator.';
        return;
      }
      if (result?.reason === 'http_410') {
        if (domainFeedback) domainFeedback.textContent = 'This address has been revoked. Contact your administrator.';
        return;
      }
      if (result?.reason === 'network_blocked') {
        if (domainFeedback) domainFeedback.textContent = 'Could not reach the license server — your network or firewall may be blocking the connection. Try on a different network, or contact your IT team.';
        return;
      }
      if (result?.reason?.startsWith('fetch_failed')) {
        if (domainFeedback) domainFeedback.textContent = 'Network error reaching the license server. Check your connection and try again.';
        return;
      }
      if (result?.reason?.startsWith('http_')) {
        if (domainFeedback) domainFeedback.textContent = `Server error (${result.reason}). Try again shortly.`;
        return;
      }
      const status = await ipcLicenseStatus();
      if (domainFeedback) {
        domainFeedback.textContent = status.valid
          ? `Activated — ${humanizePlanName(status.plan ?? 'Pro')} seat active.`
          : `No domain seat found for ${email} [${result?.reason ?? 'null'}] — check the address or contact your administrator.`;
      }
      if (status.valid) clearDomainOtpPending();
    } catch (e) {
      console.error('[domain-activate] ipcCall threw:', e);
      if (domainFeedback) domainFeedback.textContent = `Activation failed: ${(e as Error).message ?? String(e)}`;
    } finally {
      domainActivateBtn.disabled = false;
    }
  });

  // ── OTP verification handlers (domain path only) ───────────────────────────
  const otpInput     = document.getElementById('settings-license-otp') as HTMLInputElement | null;
  const otpSubmitBtn = document.getElementById('btn-settings-license-otp-submit') as HTMLButtonElement | null;
  const otpResendBtn = document.getElementById('btn-settings-license-otp-resend') as HTMLButtonElement | null;
  const otpFeedback  = document.getElementById('settings-license-otp-feedback');

  otpInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') otpSubmitBtn?.click();
  });

  otpSubmitBtn?.addEventListener('click', async () => {
    const code = otpInput?.value.trim() ?? '';
    if (!/^\d{6}$/.test(code)) {
      if (otpFeedback) otpFeedback.textContent = 'Enter the 6-digit code from the email.';
      return;
    }
    const email = stripeOtpPending
      ? ((emailInput?.value ?? '').trim() || localStorage.getItem(BILLING_EMAIL_KEY) || '')
      : ((domainEmailInput?.value ?? '').trim() || getStoredDomainEmail());
    if (!email) return;
    const otpTarget = stripeOtpPending ? 'primary' : 'domain';
    otpSubmitBtn.disabled = true;
    if (otpFeedback) otpFeedback.textContent = 'Verifying…';
    try {
      const result = await ipcCall<{ ok: boolean; reason?: string; attemptsLeft?: number; plan?: string; sub?: string; pollSecret?: string }>(
        'license:verifyOtp', { email, code, baseUrl: BILLING_BASE_URL, target: otpTarget },
      );
      if (result?.ok) {
        if (stripeOtpPending) {
          // Stripe recovery: token stored in primary slot by sidecar; persist poll secret + email.
          if (result.pollSecret) localStorage.setItem(BILLING_POLL_KEY, result.pollSecret);
          if (result.sub) localStorage.setItem(BILLING_EMAIL_KEY, result.sub);
          stripeOtpPending = false;
          document.getElementById('license-otp-section')?.classList.add('hidden');
          if (otpInput) otpInput.value = '';
          if (feedback) feedback.textContent = `Restored — ${humanizePlanName(result.plan ?? 'Pro')} active.`;
        } else {
          if (result.pollSecret) localStorage.setItem(BILLING_DOMAIN_POLL_KEY, result.pollSecret);
          // Domain seat email is stored in the domain slot only — NOT in BILLING_EMAIL_KEY.
          // Writing it there would cause the background Stripe poll to hit the billing
          // server with an OTP-required domain address on every unlock, sending a new
          // verification email each time.
          if (result.sub) localStorage.setItem(BILLING_DOMAIN_EMAIL_KEY, result.sub);
          clearDomainOtpPending();
          document.getElementById('license-otp-section')?.classList.add('hidden');
          if (otpInput) otpInput.value = '';
          if (domainFeedback) domainFeedback.textContent = `Activated — ${humanizePlanName(result.plan ?? 'Pro')} seat claimed.`;
        }
        await refreshSettingsLicenseStatus();
      } else if (result?.reason === 'network_blocked') {
        if (otpFeedback) otpFeedback.textContent = 'Could not reach the license server — your network or firewall may be blocking the connection. Try on a different network.';
      } else if (result?.reason?.startsWith('fetch_failed')) {
        if (otpFeedback) otpFeedback.textContent = 'Network error. Check your connection and try again.';
      } else if (result?.reason === 'otp_expired') {
        if (otpFeedback) otpFeedback.textContent = 'Code expired — click Resend to get a new one.';
      } else if (result?.reason === 'malformed' || result?.reason === 'invalid_or_expired') {
        if (otpFeedback) otpFeedback.textContent = 'Token could not be verified — check console for details. Contact support.';
      } else if ((result?.attemptsLeft ?? 1) <= 0) {
        if (otpFeedback) otpFeedback.textContent = 'Too many wrong attempts — click Resend for a new code.';
      } else {
        const left = result?.attemptsLeft;
        if (otpFeedback) otpFeedback.textContent = left !== undefined
          ? `Wrong code — ${left} attempt${left === 1 ? '' : 's'} left.`
          : 'Invalid code. Try again.';
      }
    } catch (e) {
      console.warn('[license] otp verify failed', e);
      if (otpFeedback) otpFeedback.textContent = 'Verification failed. Try again.';
    } finally {
      otpSubmitBtn.disabled = false;
    }
  });

  otpResendBtn?.addEventListener('click', async () => {
    const email = stripeOtpPending
      ? ((emailInput?.value ?? '').trim() || localStorage.getItem(BILLING_EMAIL_KEY) || '')
      : ((domainEmailInput?.value ?? '').trim() || getStoredDomainEmail());
    if (!email) return;
    otpResendBtn.disabled = true;
    if (otpFeedback) otpFeedback.textContent = 'Sending…';
    try {
      const result = await ipcCall<{ ok: boolean; reason?: string }>(
        'license:pollServer', { email, baseUrl: BILLING_BASE_URL },
      );
      if (result?.reason === 'otp_required') {
        if (!stripeOtpPending) markDomainOtpPending(email);
        if (otpFeedback) otpFeedback.textContent = 'New code sent. Check your inbox.';
        if (otpInput) otpInput.value = '';
      } else {
        if (otpFeedback) otpFeedback.textContent = `Could not resend (${result?.reason ?? 'unknown'}).`;
      }
    } catch (e) {
      if (otpFeedback) otpFeedback.textContent = 'Failed to resend. Try again.';
    } finally {
      otpResendBtn.disabled = false;
    }
  });

  // ── Reset button — clears stored token + cached emails ────────────────
  document.getElementById('btn-license-reset')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-license-reset') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    await ipcLicenseClear();
    // Clear input fields
    if (emailInput) emailInput.value = '';
    if (domainEmailInput) domainEmailInput.value = '';
    if (otpInput) otpInput.value = '';
    document.getElementById('license-otp-section')?.classList.add('hidden');
    // Reset feedback text
    const feedbacks = document.querySelectorAll<HTMLElement>(
      '#license-modal .subtitle[id$="-feedback"]',
    );
    feedbacks.forEach((el) => { el.textContent = ''; });
    await refreshSettingsLicenseStatus();
    if (btn) btn.disabled = false;
  });

  // Show current status when the License modal opens (cheap; runs each
  // time the user pops the modal so freshly-applied tokens show up).
  void refreshSettingsLicenseStatus();
}

export function getCurrentTheme(): UiTheme { return _currentTheme; }

/** Reconcile theme from sidecar settings after unlock. */
export function reconcileThemeFromSettings(sidecarTheme: UiTheme | undefined): void {
  if (sidecarTheme && sidecarTheme !== _currentTheme) {
    localStorage.setItem(THEME_STORAGE_KEY, sidecarTheme);
    applyTheme(sidecarTheme);
  }
  wireThemeToggle();
}

export function openLicenseModal(): void {
  const modal = document.getElementById('license-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  setTimeout(() => {
    void refreshSettingsLicenseStatus();
    const emailInput = document.getElementById('settings-license-email') as HTMLInputElement | null;
    if (emailInput && !emailInput.value) {
      emailInput.value = localStorage.getItem(BILLING_EMAIL_KEY) ?? '';
    }
    const domainEmailInput = document.getElementById('settings-license-domain-email') as HTMLInputElement | null;
    if (domainEmailInput && !domainEmailInput.value) {
      domainEmailInput.value = localStorage.getItem(BILLING_DOMAIN_EMAIL_KEY) ?? '';
    }
  }, 30);
}

export function closeLicenseModal(): void {
  const modal = document.getElementById('license-modal');
  if (modal) modal.classList.add('hidden');
  document.getElementById('license-otp-section')?.classList.add('hidden');
  const otpInput = document.getElementById('settings-license-otp') as HTMLInputElement | null;
  if (otpInput) otpInput.value = '';
  const otpFeedback = document.getElementById('settings-license-otp-feedback');
  if (otpFeedback) otpFeedback.textContent = '';
}

function wireSettingsJumpLinks(): void {
  document.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement | null)?.closest('[data-jump-settings]') as HTMLElement | null;
    if (!link) return;
    e.preventDefault();
    const target = link.dataset['jumpSettings'];
    if (target === 'connectors' || target === 'ai-clients') { app().activateMode('get-connected'); return; }
    app().activateMode('settings');
    setTimeout(() => {
      const targetId = target === 'connectors' ? 'settings-panel-connectors'
        : target === 'ai-clients' ? 'settings-panel-ai-clients' : null;
      if (!targetId) return;
      const panel = document.getElementById(targetId);
      if (!panel) return;
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      panel.style.transition = 'box-shadow 200ms ease';
      panel.style.boxShadow = '0 0 0 2px var(--accent)';
      setTimeout(() => { panel.style.boxShadow = ''; }, 1500);
    }, 50);
  });
}

function wireLicenseModalLaunchers(): void {
  document.getElementById('btn-settings-open-license')?.addEventListener('click', () => openLicenseModal());
  document.getElementById('btn-pane-open-license')?.addEventListener('click', () => openLicenseModal());
  document.getElementById('btn-license-modal-close')?.addEventListener('click', () => closeLicenseModal());
  document.getElementById('license-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLicenseModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('license-modal');
    if (modal && !modal.classList.contains('hidden')) closeLicenseModal();
  });
}

export function refreshLicenseLauncherStatus(): void {
  const targets = [
    document.getElementById('settings-license-launcher-status'),
    document.getElementById('settings-pane-license-status'),
  ].filter((el): el is HTMLElement => !!el);
  if (targets.length === 0) return;
  void (async () => {
    const status = await ipcLicenseStatus();
    let text: string;
    if (!status.present) {
      text = 'Free plan — click to subscribe or paste a token';
    } else if (!status.valid) {
      text = 'Stored token is invalid or expired — click to refresh';
    } else {
      const when = status.expiresAt ? new Date(status.expiresAt).toLocaleDateString() : '—';
      const renewing = status.renews !== false;
      text = `${humanizePlanName(status.plan ?? 'Pro')} active · ${renewing ? 'renews' : 'expires'} ${when}`;
    }
    for (const el of targets) el.textContent = text;
  })();
}

function wireLicenseLauncherObserver(): void {
  const settingsModal = document.getElementById('settings-modal');
  if (settingsModal) {
    new MutationObserver(() => {
      if (!settingsModal.classList.contains('hidden')) refreshLicenseLauncherStatus();
    }).observe(settingsModal, { attributes: true, attributeFilter: ['class'] });
  }
}

export function initSettingsPrefs(deps: SettingsPrefsHost): void {
  host = deps;
  wireThemeToggle();
  bindSettingsLicensePanel();
  wireSettingsJumpLinks();
  wireLicenseModalLaunchers();
  wireLicenseLauncherObserver();
}
