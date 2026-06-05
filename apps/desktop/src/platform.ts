/**
 * Platform abstraction layer — provides the same API surface as the Tauri
 * SDK and plugins, routing calls to either the real Tauri bindings (when
 * running inside the desktop app) or the HTTP API server (when running in a
 * plain browser in personal-server mode).
 *
 * Import everything from this module instead of '@tauri-apps/api/*' so that
 * call sites are unchanged between the two modes.
 */

import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { getCurrentWindow as tauriGetCurrentWindow } from '@tauri-apps/api/window';
import { getCurrentWebview as tauriGetCurrentWebview } from '@tauri-apps/api/webview';

// ── Environment detection ────────────────────────────────────────────────────

export const IS_TAURI: boolean =
  typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

// ── Session management (browser mode only) ───────────────────────────────────

const SESSION_KEY = 'graphnosis:session';
let _sessionToken: string | null = null;

export function setBrowserSession(token: string): void {
  _sessionToken = token;
  sessionStorage.setItem(SESSION_KEY, token);
}

export function getBrowserSession(): string | null {
  if (!_sessionToken) {
    _sessionToken = sessionStorage.getItem(SESSION_KEY);
  }
  return _sessionToken;
}

export function clearBrowserSession(): void {
  _sessionToken = null;
  sessionStorage.removeItem(SESSION_KEY);
}

// ── WebAuthn (A8 — biometric / security-key unlock, browser mode) ─────────────

export interface WebAuthnStatus { available: boolean; registered: number; }

/** Whether biometric unlock is usable in this context (secure context required)
 *  and how many devices are registered. Drives the lock-screen affordance. */
export async function webauthnStatus(): Promise<WebAuthnStatus> {
  try {
    const res = await fetch('/api/webauthn/status');
    if (!res.ok) return { available: false, registered: 0 };
    return await res.json() as WebAuthnStatus;
  } catch { return { available: false, registered: 0 }; }
}

/** Authenticate with a registered device, mint + store a session. On success
 *  the caller proceeds exactly as after a token unlock. */
export async function webauthnAuthenticate(): Promise<void> {
  const optRes = await fetch('/api/webauthn/auth/options', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  const opt = await optRes.json() as { challengeId?: string; options?: unknown; error?: string };
  if (!optRes.ok || !opt.challengeId || !opt.options) throw new Error(opt.error ?? 'Could not start biometric unlock.');
  const assertion = await startAuthentication({ optionsJSON: opt.options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
  const verRes = await fetch('/api/webauthn/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId: opt.challengeId, response: assertion }),
  });
  const ver = await verRes.json() as { token?: string; error?: string };
  if (!verRes.ok || !ver.token) throw new Error(ver.error ?? 'Biometric unlock failed.');
  setBrowserSession(ver.token);
  startSse();
}

/** Register THIS device for biometric unlock. Requires an active session. */
export async function webauthnRegister(label: string): Promise<void> {
  const token = getBrowserSession();
  if (!token) throw new Error('Unlock first, then set up biometric unlock.');
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  const optRes = await fetch('/api/webauthn/register/options', { method: 'POST', headers, body: '{}' });
  const opt = await optRes.json() as Record<string, unknown> & { error?: string };
  if (!optRes.ok) throw new Error(opt.error ?? 'Could not start registration.');
  const attestation = await startRegistration({ optionsJSON: opt as Parameters<typeof startRegistration>[0]['optionsJSON'] });
  const verRes = await fetch('/api/webauthn/register/verify', {
    method: 'POST', headers, body: JSON.stringify({ response: attestation, label }),
  });
  const ver = await verRes.json() as { verified?: boolean; error?: string };
  if (!verRes.ok || !ver.verified) throw new Error(ver.error ?? 'Registration failed.');
}

// ── Command → sidecar IPC method translation ─────────────────────────────────
//
// Tauri command names (snake_case) map to sidecar IPC method names (dot.camelCase).
// Commands not in this table are either handled inline in invoke() or are
// Tauri-only features that return a browser-specific value/error.

const CMD: Record<string, string> = {
  // Settings
  get_settings:                'settings.get',
  update_settings:             'settings.update',      // param unwrap: { settings: x } → x

  // Graphs / Engrams
  list_graphs_with_metadata:   'graphs.listWithMetadata',
  create_graph_with_template:  'graphs.createWithTemplate',
  rename_graph:                'graphs.rename',
  delete_graph:                'graphs.delete',
  set_graph_archived:          'graphs.setArchived',
  set_graph_tier:              'graphs.setTier',
  set_graph_metadata:          'graphs.setMetadata',
  accept_engram_suggestion:    'graphs.acceptEngramSuggestion',
  engram_set_config:           'engram.setConfig',

  // Nodes
  list_nodes:                  'nodes.list',
  list_edges:                  'edges.list',
  search_nodes:                'search.nodes',
  node_cursor:                 'node.cursor',
  node_direct_edit:            'node.directEdit',
  node_soft_delete:            'node.softDelete',
  node_link:                   'node.link',
  node_link_directed:          'node.linkDirected',
  node_unlink:                 'node.unlink',

  // Sources
  forget_source:               'sources.forget',
  reingest_source:             'sources.reingest',
  move_source:                 'sources.move',
  list_sources:                'sources.list',
  source_rename:               'source.rename',
  source_insert_node:          'source.insertNode',
  source_remove_node:          'source.removeNode',
  source_reorder_nodes:        'source.reorderNodes',
  source_list_nodes:           'source.listNodes',

  // Ingest
  ingest_file:                 'ingest.file',
  ingest_clip:                 'ingest.clip',
  ingest_web:                  'ingest.web',

  // MCP
  mcp_status:                  'mcp.status',
  mcp_restart_listener:        'mcp.restartListener',
  mcp_disconnect:              'mcp.disconnect',

  // Corrections
  list_pending_corrections:    'corrections.list',
  apply_correction:            'corrections.apply',
  reject_correction:           'corrections.reject',

  // Stats / Activity
  inspector_stats:             'stats.summary',
  list_activity:               'activity.list',
  activity_log:                'activity.log',

  // Snapshots
  create_snapshot:             'snapshots.create',
  list_snapshots:              'snapshots.list',

  // Recovery
  recovery_plan:               'recovery.plan',
  recovery_apply:              'recovery.apply',
  purge_forgotten:             'cortex.purgeForgotten',
  purge_orphan_nodes:          'cortex.purgeOrphanNodes',

  // Filesystem (server-side folder picker + ingest in browser mode)
  fs_list_dir:                 'fs.listDir',
  fs_list_files:               'fs.listFiles',

  // Quarantine
  list_quarantine:             'quarantine.list',
  delete_quarantine:           'quarantine.delete',
  restore_quarantine:          'quarantine.restore',

  // AI / Consent
  revoke_ai_consents:          'ai.revokeConsents',
  ai_get_consent_history:      'ai.getConsentHistory',
  ai_set_client_policy:        'ai.setClientPolicy',
  ai_get_client_policies:      'ai.getClientPolicies',
  ai_get_consent_phrase:       'ai.getConsentPhrase',
  get_consent_phrase:          'ai.getConsentPhrase',
  consent_resolve_prompt:      'consent.resolvePrompt',
  consent_list_pending:        'consent.listPendingPrompts',
  ai_synthesize_search:        'ai.synthesizeSearchResults',
  ai_rerank_search:            'ai.rerankSearchResults',

  // Passphrase / Recovery phrase
  regenerate_recovery_phrase:  'recoveryPhrase.regenerate',
  change_passphrase:           'passphrase.change',

  // Brain engine
  brain_get_vitality:          'brain:getVitality',
  brain_get_insights:          'brain:getInsights',
  brain_get_duplicate_pairs:   'brain:getDuplicatePairs',
  brain_dismiss_insight:       'brain:dismissInsight',
  brain_dismiss_duplicate:     'brain:dismissDuplicatePair',
  brain_resolve_duplicate:     'brain:resolveDuplicatePair',
  brain_develop:               'brain:develop',
  brain_predict:               'brain:predict',
  brain_get_status:            'brain:getStatus',
  brain_get_memory_health:     'brain:getMemoryHealth',
  brain_run_consolidation:     'brain:runConsolidation',
  brain_get_neural_status:     'brain:getNeuralNetworkStatus',
  brain_enable_neural:         'brain:enableNeuralNetwork',
  brain_disable_neural:        'brain:disableNeuralNetwork',
  brain_run_neural:            'brain:runNeuralNetwork',
  brain_remove_neural_edges:   'brain:removeNeuralNetworkEdges',

  // Local LLM
  llm_status:                  'llm:status',
  llm_set_model:               'llm:setModel',
  llm_set_enabled:             'llm:setEnabled',
  llm_set_capability:          'llm:setCapability',
  llm_pull_model:              'llm:pullModel',
  llm_cancel_pull:             'llm:cancelPull',
  llm_verify_local:            'llm:verify',

  // Embedding
  embedding_switch:            'embedding:switch',
  embedding_cancel_switch:     'embedding:cancelSwitch',
  embedding_status:            'embedding:status',

  // Connectors
  list_connectors:             'connectors.list',
  install_connector:           'connectors.install',
  remove_connector:            'connectors.remove',
  trigger_connector_pull:      'connectors.triggerPull',
  get_connector_auth_url:      'connectors.getAuthUrl',

  // Engram reingest
  engram_reingest:             'engram:reingest',
  engrams_reingest_all:        'engram:reingestAll',
  cancel_reingest:             'engram:cancelReingest',

  // Docs / Skill demos
  docs_check_offer:            'docs:checkOffer',
  docs_ingest:                 'docs:ingest',
  docs_decline:                'docs:decline',
  skill_demos_check_offer:     'skillDemos:checkOffer',
  skill_demos_ingest:          'skillDemos:ingest',

  // License
  license_validate:            'license:validate',
  license_claim:               'license:claim',
  license_revoke:              'license:revoke',
};

// ── RPC helper (browser mode) ─────────────────────────────────────────────────

/**
 * Parse a JSON response from the sidecar API, but fail with a legible message
 * when the response isn't JSON. The classic cause: the page was loaded from a
 * dev/static server (or a reverse proxy) that doesn't expose `/api/*`, so the
 * request returns an HTML page — and `res.json()` would otherwise throw an
 * opaque "SyntaxError: The string did not match the expected pattern".
 */
async function parseApiJson<T>(res: Response, endpoint: string): Promise<T> {
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new Error(
      `Expected JSON from ${endpoint} but the server returned "${ct || 'no content-type'}". ` +
      `This page must be served by the Graphnosis sidecar's browser UI (port 3456). ` +
      `If you opened it from a different address or a dev server, the API isn't reachable here.`,
    );
  }
  try {
    return await res.json() as T;
  } catch {
    throw new Error(`Could not parse the response from ${endpoint}. Is the sidecar's browser UI running on this port?`);
  }
}

async function browserRpc<T>(method: string, params?: unknown): Promise<T> {
  const token = getBrowserSession();
  if (!token) throw new Error('Not authenticated. Call POST /api/unlock first.');
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ method, params: params ?? null }),
  });
  // 401 = the session token is no longer valid (sidecar restarted, token
  // rotated, or 24h expiry). The local sessionStorage token is stale; drop it
  // and bounce to the lock screen so the user re-authenticates, rather than
  // surfacing a bare "Unauthorized" on every action.
  if (res.status === 401) {
    clearBrowserSession();
    stopSse();
    emitBrowserEvent('graphnosis://status', { unlocked: false, cortex_dir: null, sidecar_running: false });
    throw new Error('Session expired — please reconnect with your access token.');
  }
  const json = await parseApiJson<{ result?: T; error?: string }>(res, '/api/rpc');
  if (json.error) throw new Error(json.error);
  return json.result as T;
}

// ── invoke() ─────────────────────────────────────────────────────────────────

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (IS_TAURI) {
    const { invoke: ti } = await import('@tauri-apps/api/core');
    return ti<T>(cmd, args);
  }

  // ── URL-opening commands ────────────────────────────────────────────────
  if (cmd === 'plugin:opener|open_url' || cmd === 'open_external_url' || cmd === 'open_url') {
    const url = (args?.url as string | undefined) ?? '';
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    return undefined as unknown as T;
  }

  // ── sidecar_ipc_call — Tauri pass-through wrapper ───────────────────────
  // Tauri forwards { method, params } straight to the sidecar's IPC dispatch.
  // In browser mode the dispatch IS our /api/rpc, so unwrap and forward the
  // inner method (brain:*, llm:*, etc.) rather than the wrapper name.
  if (cmd === 'sidecar_ipc_call') {
    const method = args?.method as string | undefined;
    if (!method) throw new Error('sidecar_ipc_call requires a method');
    return browserRpc<T>(method, args?.params);
  }

  // ── Cortex-folder selection — Tauri-only; server owns the cortex ────────
  if (cmd === 'suggest_cortex_path') return '' as unknown as T;
  if (cmd === 'check_path_exists')   return true as unknown as T;

  // ── verify_local_llm — a Rust local-PROCESS probe (is Ollama loopback-only
  //    on this machine). Meaningless from a remote browser client; return a
  //    benign "nothing to report" result so the LLM UI doesn't error. ───────
  if (cmd === 'verify_local_llm') {
    return {
      pid: null, matched_by: null, connections: [],
      all_loopback: true, external_remotes: [], error: null,
    } as unknown as T;
  }

  // ── Status (sidecar is always running in browser mode) ──────────────────
  if (cmd === 'status') {
    const token = getBrowserSession();
    if (token) startSse(); // resume SSE on page reload with an existing session
    return { unlocked: !!token, cortex_dir: null, sidecar_running: !!token } as unknown as T;
  }

  // ── Lock (clear session, return locked status) ──────────────────────────
  if (cmd === 'lock_cortex') {
    clearBrowserSession();
    stopSse();
    return { unlocked: false, cortex_dir: null, sidecar_running: false } as unknown as T;
  }

  // ── Unlock (exchange token for session) ─────────────────────────────────
  if (cmd === 'unlock_cortex' || cmd === 'unlock_cortex_with_recovery') {
    // main.ts calls invoke('unlock_cortex', { args: { cortex_dir, passphrase, ... } })
    const innerArgs = (args?.args as Record<string, unknown> | undefined) ?? args ?? {};
    const passphrase = (innerArgs.passphrase as string | undefined) ?? (innerArgs.recovery_phrase as string | undefined) ?? '';
    const res = await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: passphrase }),
    });
    const json = await parseApiJson<{ token?: string; error?: string }>(res, '/api/unlock');
    if (!json.token) {
      throw new Error(json.error === 'Invalid token'
        ? 'Invalid access token. Use the token from Settings → Mobile & Remote → Browser access (not the MCP bridge bearer token).'
        : (json.error ?? 'Unlock failed'));
    }
    setBrowserSession(json.token);
    startSse();
    return { unlocked: true, cortex_dir: null, sidecar_running: true } as unknown as T;
  }

  // ── Browser download instead of native save dialog ──────────────────────
  if (cmd === 'save_json_file') {
    const { defaultName = 'export.json', content = '' } = args ?? {};
    const blob = new Blob([content as string], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = defaultName as string; a.click();
    URL.revokeObjectURL(url);
    return undefined as unknown as T;
  }

  if (cmd === 'save_skill_file') {
    const { defaultName = 'skill.gsk', content, binary_b64 } = args ?? {};
    const blob = binary_b64
      ? new Blob([Uint8Array.from(atob(binary_b64 as string), (c) => c.charCodeAt(0))])
      : new Blob([content as string], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = defaultName as string; a.click();
    URL.revokeObjectURL(url);
    return undefined as unknown as T;
  }

  // ── App version ─────────────────────────────────────────────────────────
  if (cmd === 'app_version' || cmd === 'get_version') {
    return (_browserVersion ?? '—') as unknown as T;
  }

  // ── Tauri-only features — graceful no-ops ────────────────────────────────
  const TAURI_ONLY = new Set([
    'pick_cortex_folder', 'pick_files', 'pick_folders', 'pick_gsk_file',
    'open_about_window', 'open_cortex_in_finder', 'reveal_file_in_finder',
    'check_for_updates', 'install_update',
    'configure_mcp_client',
    'biometric_available', 'biometric_unlock',
    'change_passphrase_with_biometric',
    'show_window', 'create_cortex_dir',
    'show_engram_action_notification',
  ]);
  if (TAURI_ONLY.has(cmd)) {
    // Return null/false rather than throwing so callers that don't check can degrade
    // gracefully. The UI hides these affordances when IS_TAURI is false.
    if (cmd === 'biometric_available') return false as unknown as T;
    if (cmd === 'pick_cortex_folder' || cmd === 'pick_files' || cmd === 'pick_folders' || cmd === 'pick_gsk_file') return null as unknown as T;
    return undefined as unknown as T;
  }

  // ── get_mobile_connection_info — partially works via sidecar settings ────
  if (cmd === 'get_mobile_connection_info') {
    const settings = await browserRpc<{ mobile?: { httpBridge?: unknown } }>('settings.get');
    return (settings?.mobile?.httpBridge ?? null) as unknown as T;
  }

  // ── update_settings — unwrap { settings: x } → x ────────────────────────
  if (cmd === 'update_settings') {
    const params = (args?.settings ?? args) as Record<string, unknown>;
    return browserRpc<T>('settings.update', params);
  }

  // ── General command translation ──────────────────────────────────────────
  const ipcMethod = CMD[cmd];
  if (ipcMethod) return browserRpc<T>(ipcMethod, args ?? null);

  // Pass unknown commands through as-is (colon-namespaced sidecar methods
  // called directly, e.g. 'brain:getVitality', 'llm:status').
  return browserRpc<T>(cmd, args ?? null);
}

// ── SSE event routing (browser mode) ─────────────────────────────────────────

// Map SSE frame name → Tauri event name
const SSE_TO_TAURI: Record<string, string> = {
  'graph.mutation':               'graphnosis://graph-mutation',
  'graph.events':                 'graphnosis://event-stream-connected',
  'ingest.progress':              'graphnosis://ingest-progress',
  'ingest.done':                  'graphnosis://ingest-done',
  'recovery.progress':            'graphnosis://recovery-progress',
  'recovery.done':                'graphnosis://recovery-done',
  'engrams-loading':              'graphnosis://engrams-loading',
  'consent-prompt':               'graphnosis://consent-prompt',
  'first-connect-policy':         'graphnosis://first-connect-policy',
  'correction-proposed':          'graphnosis://correction-proposed',
  'mcp-session-budget-warning':   'graphnosis://mcp-session-budget-warning',
  'mcp-session-budget-exceeded':  'graphnosis://mcp-session-budget-exceeded',
  'mcp-bulk-access-warning':      'graphnosis://mcp-bulk-access-warning',
  'engram-create-suggested':      'graphnosis://engram-create-suggested',
  'engram-notification-accepted': 'graphnosis://engram-notification-accepted',
  'llm.pull-progress':            'graphnosis://llm-pull-progress',
  'embedding-switch-progress':    'graphnosis://embedding-switch-progress',
  'reingest.progress':            'graphnosis://reingest-progress',
  'quarantine-recovered':         'graphnosis://cortex-recovered-from-quarantine',
  'engram-budget-warning':        'graphnosis://mcp-session-budget-warning',
};

type ListenHandler<T> = (event: { payload: T }) => void;
const _listeners = new Map<string, Array<ListenHandler<unknown>>>();
let _sseRunning = false;
let _sseAbort: AbortController | null = null;
let _browserVersion: string | null = null;

function dispatchToListeners(eventName: string, payload: unknown): void {
  for (const h of _listeners.get(eventName) ?? []) {
    try { h({ payload }); } catch { /* best-effort */ }
  }
}

async function sseLoop(): Promise<void> {
  const token = getBrowserSession();
  if (!token) return;
  _sseAbort = new AbortController();
  try {
    const res = await fetch('/api/events', {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: _sseAbort.signal,
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const frame = JSON.parse(line.slice(6)) as { kind: string; name: string; payload: unknown };
          // Capture version from hello frame
          if (frame.name === 'graph.events') {
            const p = frame.payload as { version?: string } | undefined;
            if (p?.version) _browserVersion = p.version;
          }
          const tauriEvent = SSE_TO_TAURI[frame.name] ?? SSE_TO_TAURI[frame.kind];
          if (tauriEvent) dispatchToListeners(tauriEvent, frame.payload);
        } catch { /* malformed frame */ }
      }
    }
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return; // intentional stop
  }
  // Reconnect after a pause (network blip, server restart, etc.)
  if (_sseRunning) setTimeout(() => { void sseLoop(); }, 3_000);
}

export function startSse(): void {
  if (_sseRunning || IS_TAURI) return;
  _sseRunning = true;
  void sseLoop();
}

export function stopSse(): void {
  _sseRunning = false;
  _sseAbort?.abort();
  _sseAbort = null;
}

// ── listen() ─────────────────────────────────────────────────────────────────

export function listen<T>(event: string, handler: ListenHandler<T>): Promise<() => void> {
  if (IS_TAURI) {
    return import('@tauri-apps/api/event').then(({ listen: tl }) =>
      tl(event, handler as ListenHandler<unknown>),
    );
  }
  if (!_listeners.has(event)) _listeners.set(event, []);
  _listeners.get(event)!.push(handler as ListenHandler<unknown>);
  startSse();
  return Promise.resolve(() => {
    const arr = _listeners.get(event);
    if (!arr) return;
    const i = arr.indexOf(handler as ListenHandler<unknown>);
    if (i !== -1) arr.splice(i, 1);
  });
}

/** Emit a synthetic Tauri-style event — used in browser mode to drive the
 *  same event-based UI state machine as the Tauri app. */
export function emitBrowserEvent(event: string, payload: unknown): void {
  dispatchToListeners(event, payload);
}

// ── getVersion() ─────────────────────────────────────────────────────────────

export async function getVersion(): Promise<string> {
  if (IS_TAURI) {
    const { getVersion: gv } = await import('@tauri-apps/api/app');
    return gv();
  }
  return _browserVersion
    ?? document.querySelector<HTMLMetaElement>('meta[name="app-version"]')?.content
    ?? '—';
}

// ── Window / Webview ──────────────────────────────────────────────────────────
// In the Tauri desktop app, return the REAL Tauri window/webview (scaleFactor,
// setSize, onDragDropEvent, …). In a plain browser there's no native window, so
// fall back to no-op stubs. Without this delegation, native features (window
// sizing, file drag-drop) were dead even inside the desktop app.

export const getCurrentWindow = (): ReturnType<typeof tauriGetCurrentWindow> =>
  (IS_TAURI
    ? tauriGetCurrentWindow()
    : ({
        setTitle: async () => {}, minimize: async () => {}, close: async () => {},
        show: async () => {}, hide: async () => {},
      } as unknown as ReturnType<typeof tauriGetCurrentWindow>));

export const getCurrentWebview = (): ReturnType<typeof tauriGetCurrentWebview> =>
  (IS_TAURI
    ? tauriGetCurrentWebview()
    : ({} as unknown as ReturnType<typeof tauriGetCurrentWebview>));

// ── Notifications ─────────────────────────────────────────────────────────────

export async function isPermissionGranted(): Promise<boolean> {
  if (IS_TAURI) {
    const m = await import('@tauri-apps/plugin-notification');
    return m.isPermissionGranted();
  }
  return Notification.permission === 'granted';
}

export async function requestPermission(): Promise<'granted' | 'denied' | 'default'> {
  if (IS_TAURI) {
    const m = await import('@tauri-apps/plugin-notification');
    return m.requestPermission() as Promise<'granted' | 'denied' | 'default'>;
  }
  return Notification.requestPermission();
}

export function sendNotification(options: string | { title: string; body?: string }): void {
  if (IS_TAURI) {
    void import('@tauri-apps/plugin-notification').then((m) => m.sendNotification(
      options as Parameters<typeof m.sendNotification>[0],
    ));
    return;
  }
  if (Notification.permission !== 'granted') return;
  const title = typeof options === 'string' ? options : options.title;
  const body  = typeof options === 'string' ? undefined : options.body;
  new Notification(title, { body });
}
