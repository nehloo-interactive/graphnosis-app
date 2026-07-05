/**
 * Connectors — Get Connected page + connector setup modal.
 */
import { IS_TAURI, invoke } from '../platform';
import { app } from './app-context';
import { invokeRetry } from './ipc';
import { escape, escapeHtml, relativeTimeShort } from './util';
import type { ConnectorKind, ConnectorConfigShape, ConnectorStatus, GraphWithMetadata } from './types';

function getLoadedGraphs(): GraphWithMetadata[] {
  return app().getLoadedGraphs();
}

export { type ConnectorKind, type ConnectorConfigShape, type ConnectorStatus };

export let installedConnectorKinds = new Set<ConnectorKind>();
export let connectorPullingGraphIds = new Set<string>();
export let lastConnectorList: { configs: ConnectorConfigShape[]; statuses: ConnectorStatus[] } | null = null;

/** Update pulling-set snapshot (callable from main.ts atlas sync path). */
export function updateConnectorPullSnapshot(res: {
  configs: ConnectorConfigShape[];
  statuses: ConnectorStatus[];
}): void {
  lastConnectorList = res;
  const statusById = new Map(res.statuses.map((s) => [s.id, s]));
  connectorPullingGraphIds = new Set(
    res.configs.filter((c) => statusById.get(c.id)?.pulling).map((c) => c.graphId),
  );
}

const $m = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

let pendingConnectorEditId: string | null = null;
let pendingConnectorKind: ConnectorKind | null = null;

export function initConnectors(): void {
  wireConnectorIntervalControl();
  wireConnectorsUi();
}

const CONNECTOR_KIND_LABEL: Record<ConnectorKind, string> = {
  rss: 'RSS', github: 'GitHub', slack: 'Slack',
  trello: 'Trello', linear: 'Linear', webhook: 'Webhook',
  obsidian: 'Obsidian', gbrain: 'GBrain', 'ai-context': 'AI Context Files',
  x: 'X',
};
const CONNECTOR_KIND_GLYPH: Record<ConnectorKind, string> = {
  rss: '📰', github: '🐙', slack: '💬',
  trello: '📋', linear: '📐', webhook: '🪝',
  obsidian: '🔮', gbrain: '🧠', 'ai-context': '📎',
  x: '𝕏',
};

/** Paint the configured-connector instances onto the Get Connected page
 *  (#gc-connectors-list) — every instance, including multiples of the same
 *  kind. Reuses renderConnectorRow + the shared row-action handlers, so a user
 *  with 3 Obsidian vaults or 12 NAS folders sees + manages each one here. */
export function paintGcConnectorList(configs: ConnectorConfigShape[], statuses: ConnectorStatus[]): void {
  const wrap = document.getElementById('gc-connectors-list');
  const head = document.getElementById('gc-connected-head');
  const intervalRow = document.getElementById('gc-interval-row');
  if (!wrap) return;
  if (configs.length === 0) {
    wrap.innerHTML = '';
    if (head) head.style.display = 'none';
    if (intervalRow) intervalRow.style.display = 'none';
    return;
  }
  if (head) head.style.display = '';
  if (intervalRow) intervalRow.style.display = '';
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  wrap.innerHTML = configs.map((cfg) => renderConnectorRow(cfg, statusById.get(cfg.id))).join('');
  wrap.querySelectorAll<HTMLButtonElement>('button[data-connector-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset['connectorAction'];
      const id = btn.dataset['connectorId'];
      if (!id) return;
      if (action === 'pull') void handleConnectorPull(id, btn);
      else if (action === 'resync') void handleConnectorResync(id, btn);
      else if (action === 'stop') void handleConnectorStop(id, btn);
      else if (action === 'copy-url') void handleConnectorCopyUrl(btn);
      else if (action === 'remove') void handleConnectorRemove(id, btn);
      else if (action === 'edit') void handleConnectorEdit(id, configs);
    });
  });
}

// Fetches the connector list and paints it wherever it's surfaced. The Settings
// Connectors panel was removed, so this no longer depends on #connectors-list —
// it always updates the Get Connected page list + the rail status, and paints
// the legacy Settings list only if that element still exists.
export async function refreshConnectorsList(): Promise<void> {
  try {
    const res = await invokeRetry<{ configs: ConnectorConfigShape[]; statuses: ConnectorStatus[]; pullIntervalMs?: number }>(
      'list_connectors',
    );
    // Reflect installed connectors in the sidebar's Get-connected status list.
    installedConnectorKinds = new Set(res.configs.map((c) => c.kind));
    // Keep the "engrams currently being ingested" set fresh (drives the
    // defer-load-while-ingesting behavior on the 3D Engram picker).
    {
      lastConnectorList = { configs: res.configs, statuses: res.statuses };
      const statusById = new Map(res.statuses.map((s) => [s.id, s]));
      connectorPullingGraphIds = new Set(
        res.configs.filter((c) => statusById.get(c.id)?.pulling).map((c) => c.graphId),
      );
      app().updateAtlasSyncButton();
    }
    app().renderRailGetConnected();
    // The connector list now lives on the Get Connected page (in sync with
    // every connector add/edit/remove, which all call through here).
    paintGcConnectorList(res.configs, res.statuses);
    // Default check-interval control (the per-connector fallback), now on the
    // Get Connected page. Don't clobber a value the user is mid-edit on.
    const intervalInput = document.getElementById('gc-default-interval') as HTMLInputElement | null;
    if (intervalInput && typeof res.pullIntervalMs === 'number' && document.activeElement !== intervalInput) {
      intervalInput.value = String(Math.round(res.pullIntervalMs / 60_000));
    }
    // Legacy Settings list (kept working if the element is still present).
    const wrap = document.getElementById('connectors-list');
    if (wrap) {
      if (!res.configs.length) {
        wrap.innerHTML = '<p style="color: var(--fg-dim); font-size: 14px; padding: 10px 4px; margin: 0;">No connectors installed yet.</p>';
      } else {
        const statusById = new Map(res.statuses.map((s) => [s.id, s]));
        wrap.innerHTML = res.configs.map((cfg) => renderConnectorRow(cfg, statusById.get(cfg.id))).join('');
        wrap.querySelectorAll<HTMLButtonElement>('button[data-connector-action]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const action = btn.dataset['connectorAction'];
            const id = btn.dataset['connectorId'];
            if (!id) return;
            if (action === 'pull') void handleConnectorPull(id, btn);
            else if (action === 'resync') void handleConnectorResync(id, btn);
            else if (action === 'stop') void handleConnectorStop(id, btn);
            else if (action === 'copy-url') void handleConnectorCopyUrl(btn);
            else if (action === 'remove') void handleConnectorRemove(id, btn);
            else if (action === 'edit') void handleConnectorEdit(id, res.configs);
          });
        });
      }
    }
  } catch (e) {
    const gcWrap = document.getElementById('gc-connectors-list');
    const head = document.getElementById('gc-connected-head');
    if (head) head.style.display = '';
    const timedOut = /within \d+s|timed out|did not respond/i.test(String(e));
    if (gcWrap) {
      gcWrap.innerHTML =
        `<div class="gc-connectors-error">` +
        `<p>${timedOut ? 'The sidecar was busy and didn’t answer in time.' : 'Couldn’t load your connectors.'} ` +
        `<span class="subtitle">${escapeHtml(String(e))}</span></p>` +
        `<button id="gc-connectors-retry" class="gc-retry-btn" type="button">↻ Retry</button>` +
        (timedOut ? `<p class="subtitle gc-connectors-trouble">If this keeps happening, a large cortex can make the first read slow — wait a moment and retry, or reopen the app.</p>` : '') +
        `</div>`;
      gcWrap.querySelector<HTMLButtonElement>('#gc-connectors-retry')
        ?.addEventListener('click', () => void refreshConnectorsList());
    }
  }
}

function renderConnectorRow(cfg: ConnectorConfigShape, status?: ConnectorStatus): string {
  const glyph = CONNECTOR_KIND_GLYPH[cfg.kind] ?? '🔌';
  const label = CONNECTOR_KIND_LABEL[cfg.kind] ?? cfg.kind;
  let statusKind: 'enabled' | 'disabled' | 'error' | 'pulling';
  let statusLabel: string;
  if (status?.pulling) { statusKind = 'pulling'; statusLabel = 'pulling…'; }
  else if (status?.paused) { statusKind = 'disabled'; statusLabel = 'paused'; }
  else if (cfg.lastError) { statusKind = 'error'; statusLabel = 'error'; }
  else if (cfg.enabled) { statusKind = 'enabled'; statusLabel = 'enabled'; }
  else { statusKind = 'disabled'; statusLabel = 'disabled'; }

  const lastPullStr = cfg.lastPulledAt
    ? `last pulled ${relativeTimeShort(cfg.lastPulledAt)}`
    : 'never pulled';
  const events = status?.eventsTotal ?? 0;
  const eventsStr = events > 0 ? ` · ${events} event${events === 1 ? '' : 's'} this session` : '';
  const errorStr = cfg.lastError ? ` · ${escapeHtml(cfg.lastError)}` : '';
  // Effective check interval: manual mode, per-connector override, else default.
  const optsRec = cfg.options as Record<string, unknown> | undefined;
  const manualSync = optsRec?.['autoSync'] === false;
  const ovr = optsRec?.['intervalMs'];
  const intervalStr = manualSync
    ? ' · manual — pull on demand'
    : typeof ovr === 'number' && ovr >= 60_000
      ? ` · every ${Math.round(ovr / 60_000)} min`
      : ' · default interval';

  // Webhook URL (push-only connectors) — surfaced so the user can copy it from
  // the row without opening the Edit modal. Only available once the token has
  // been generated (i.e. the webhook has been saved at least once).
  const webhookToken = cfg.kind === 'webhook'
    ? ((cfg.options as Record<string, unknown> | undefined)?.['webhookToken'] as string | undefined)
    : undefined;
  const webhookUrl = webhookToken ? `http://localhost:3458/webhook/${cfg.id}/${webhookToken}` : '';

  // Show the engram's real display name, not the internal slug. Fall back to
  // the slug if the engram isn't loaded (e.g. it was deleted out from under the
  // connector). The data-pres attribute keeps the slug so Presentation Mode
  // redaction still targets the right engram.
  const engramName = getLoadedGraphs().find((g) => g.graphId === cfg.graphId)?.metadata.displayName ?? cfg.graphId;

  return `
    <div class="connector-row" data-connector-id="${escapeHtml(cfg.id)}">
      <span class="connector-row-kind" aria-hidden="true">${glyph}</span>
      <div class="connector-row-body">
        <div class="connector-row-title">
          <span class="connector-row-name" data-pres="engram:${escapeHtml(cfg.graphId)}">${escapeHtml(label)} · ${escapeHtml(cfg.id)}</span>
          <span class="connector-row-status ${statusKind}">${escapeHtml(statusLabel)}</span>
        </div>
        <span class="connector-row-meta">
          → engram <span data-pres="engram:${escapeHtml(cfg.graphId)}">${escapeHtml(engramName)}</span> · ${escapeHtml(lastPullStr)}${escapeHtml(intervalStr)}${escapeHtml(eventsStr)}${errorStr}
        </span>
      </div>
      <div class="connector-row-actions">
        ${cfg.kind === 'webhook'
          ? (webhookUrl ? `<button data-connector-action="copy-url" data-connector-id="${escapeHtml(cfg.id)}" data-webhook-url="${escapeHtml(webhookUrl)}" title="Copy this webhook's URL to the clipboard">Copy URL</button>` : '')
          : (status?.pulling
            ? `<button data-connector-action="stop" data-connector-id="${escapeHtml(cfg.id)}" class="danger" title="Stop ingesting now — pauses this connector until you Pull or Re-sync">⏸ Stop</button>`
            : `<button data-connector-action="pull" data-connector-id="${escapeHtml(cfg.id)}">${status?.paused ? 'Resume' : 'Pull now'}</button>
        <button data-connector-action="resync" data-connector-id="${escapeHtml(cfg.id)}" title="Reset this connector's cursor and re-pull everything from scratch">Re-sync</button>`)}
        <button data-connector-action="edit" data-connector-id="${escapeHtml(cfg.id)}">Edit</button>
        <button data-connector-action="remove" data-connector-id="${escapeHtml(cfg.id)}" class="danger">Remove</button>
      </div>
    </div>`;
}

function relativeTimeShort(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.max(1, Math.floor(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

async function handleConnectorPull(id: string, btn: HTMLButtonElement): Promise<void> {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Pulling…';
  try {
    const res = await invokeRetry<{ eventsIngested: number }>('trigger_connector_pull', { id });
    const tid = app().addIngestToast(`Pulled ${id}`, `${res.eventsIngested} new event(s) ingested`);
    app().finishIngestToast(tid, 'success', `${res.eventsIngested} new event(s) ingested`);
    await refreshConnectorsList();
  } catch (e) {
    const tid = app().addIngestToast(`Pull failed: ${id}`, String(e));
    app().finishIngestToast(tid, 'error', String(e));
  } finally {
    btn.disabled = false;
    if (originalText) btn.textContent = originalText;
  }
}

async function handleConnectorRemove(id: string, btn?: HTMLButtonElement): Promise<void> {
  // Two-click inline confirm (no typing). First click arms the button ("Confirm
  // remove?"); a second click within 4s removes. Auto-resets so a stray first
  // click can't leave it armed forever.
  if (btn) {
    if (btn.dataset['armed'] !== '1') {
      btn.dataset['armed'] = '1';
      btn.dataset['orig'] = btn.textContent ?? 'Remove';
      btn.textContent = 'Confirm remove?';
      btn.classList.add('confirm-armed');
      const reset = (): void => {
        if (!btn.isConnected) return;
        btn.dataset['armed'] = '';
        btn.textContent = btn.dataset['orig'] ?? 'Remove';
        btn.classList.remove('confirm-armed');
      };
      btn.dataset['resetTimer'] = String(window.setTimeout(reset, 4000));
      return;
    }
    clearTimeout(Number(btn.dataset['resetTimer']));
    btn.disabled = true;
    btn.textContent = 'Removing…';
  }
  try {
    await invokeRetry('remove_connector', { id });
    await refreshConnectorsList();
    const tid = app().addIngestToast(`Removed connector "${id}"`, 'Credentials deleted; engram content untouched');
    app().finishIngestToast(tid, 'success', 'Credentials deleted; engram content untouched');
  } catch (e) {
    const tid = app().addIngestToast(`Couldn't remove "${id}"`, String(e));
    app().finishIngestToast(tid, 'error', String(e));
  }
}

// Copy a webhook connector's URL straight from its row — no need to open Edit.
// The URL is baked into the button's data attribute by renderConnectorRow.
async function handleConnectorCopyUrl(btn?: HTMLButtonElement): Promise<void> {
  const url = btn?.dataset['webhookUrl'];
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    if (btn) {
      const orig = btn.textContent ?? 'Copy URL';
      btn.textContent = 'Copied ✓';
      setTimeout(() => { if (btn.isConnected) btn.textContent = orig; }, 1500);
    }
  } catch (e) {
    const tid = app().addIngestToast('Copy failed', String(e));
    app().finishIngestToast(tid, 'error', String(e));
  }
}

// Re-sync a connector from scratch: reset its pull cursor + re-pull everything.
// Use after a partial sync (e.g. files stranded behind the cursor by an earlier
// failed pull). Already-ingested sources dedup-skip; the rest get picked up.
async function handleConnectorResync(id: string, btn?: HTMLButtonElement): Promise<void> {
  const orig = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Re-syncing…'; }
  const tid = app().addIngestToast(`Re-syncing "${id}"`, 'Cursor reset — re-scanning from scratch…');
  try {
    const res = await ipcCall<{ eventsIngested: number }>('connectors.resync', { id });
    app().finishIngestToast(tid, 'success', `${res.eventsIngested} new event(s) ingested this pass`);
    await refreshConnectorsList();
  } catch (e) {
    app().finishIngestToast(tid, 'error', String(e));
  } finally {
    if (btn) { btn.disabled = false; if (orig) btn.textContent = orig; }
  }
}

// Stop an in-progress ingest. The sidecar aborts the drain at the next
// file/batch boundary and pauses the connector until the user Pulls/Re-syncs.
async function handleConnectorStop(id: string, btn?: HTMLButtonElement): Promise<void> {
  if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
  const tid = app().addIngestToast(`Stopping "${id}"`, 'Halting the current ingest…');
  try {
    await ipcCall('connectors.stop', { id });
    app().finishIngestToast(tid, 'success', 'Ingest stopped — Pull or Re-sync to resume.');
    await refreshConnectorsList();
  } catch (e) {
    app().finishIngestToast(tid, 'error', String(e));
    if (btn) { btn.disabled = false; btn.textContent = '⏸ Stop'; }
  }
}

async function handleConnectorEdit(id: string, configs: ConnectorConfigShape[]): Promise<void> {
  const cfg = configs.find((c) => c.id === id);
  if (!cfg) return;
  openConnectorSetupModal(cfg.kind, cfg);
}

// ── Setup modal ────────────────────────────────────────────────────────────

export function openConnectorSetupModal(kind: ConnectorKind, existing?: ConnectorConfigShape): void {
  pendingConnectorEditId = existing?.id ?? null;
  pendingConnectorKind = kind;
  const modal = document.getElementById('connector-setup-modal');
  const title = document.getElementById('connector-setup-title');
  const subtitle = document.getElementById('connector-setup-subtitle');
  const body = document.getElementById('connector-setup-body');
  if (!modal || !title || !subtitle || !body) return;
  title.textContent = (existing ? 'Edit ' : 'Add ') + CONNECTOR_KIND_LABEL[kind] + ' connector';
  subtitle.textContent = connectorSubtitleFor(kind);
  body.innerHTML = renderConnectorSetupBody(kind, existing);
  // Populate engram dropdown after body renders
  populateEngramDropdown('connector-graphid', existing?.graphId);
  // "+ New engram" button — switch the dropdown to new-engram mode and prefill
  // a relevant, unique suggested name.
  document.getElementById('connector-new-engram-btn')?.addEventListener('click', () => {
    const sel = document.getElementById('connector-graphid') as HTMLSelectElement | null;
    const nameInput = document.getElementById('connector-new-engram-name') as HTMLInputElement | null;
    if (sel) { sel.value = '__new__'; sel.dispatchEvent(new Event('change')); }
    if (nameInput) {
      nameInput.style.display = '';
      if (!nameInput.value.trim()) nameInput.value = suggestEngramName(kind);
      nameInput.focus();
      nameInput.select();
    }
  });
  // Folder browse — uses the native dialog in the Tauri app, or a server-side
  // folder picker in browser/personal-server mode (pickFolders abstracts both).
  document.getElementById('connector-aicontext-browse')?.addEventListener('click', async () => {
    const picked = await pickFolders();
    if (!picked.length) return;
    const ta = document.getElementById('connector-aicontext-paths') as HTMLTextAreaElement | null;
    if (!ta) return;
    const current = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
    ta.value = [...new Set([...current, ...picked])].join('\n');
  });
  document.getElementById('connector-obsidian-browse')?.addEventListener('click', async () => {
    const picked = await pickFolders();
    const inp = document.getElementById('connector-obsidian-vault') as HTMLInputElement | null;
    if (inp && picked[0]) inp.value = picked[0];
  });
  document.getElementById('connector-gbrain-browse')?.addEventListener('click', async () => {
    const picked = await pickFolders();
    const inp = document.getElementById('connector-gbrain-repo') as HTMLInputElement | null;
    if (inp && picked[0]) inp.value = picked[0];
  });
  document.getElementById('connector-x-connect')?.addEventListener('click', async () => {
    if (!existing?.id) return; // button is only rendered when `existing` is set
    const btn = document.getElementById('connector-x-connect') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    try {
      const res = await invokeRetry<{ url: string; note?: string }>('get_connector_auth_url', { id: existing.id });
      if (IS_TAURI) await invoke('plugin:opener|open_url', { url: res.url });
      else window.open(res.url, '_blank', 'noopener,noreferrer');
      const tid = app().addIngestToast('X authorization opened', res.note ?? 'Approve in your browser, then return here.');
      app().finishIngestToast(tid, 'success', res.note ?? 'Approve in your browser, then return here.');
    } catch (e) {
      const tid = app().addIngestToast('Could not start X OAuth', String(e));
      app().finishIngestToast(tid, 'error', String(e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Connect X account →'; }
    }
  });
  modal.classList.remove('hidden');
  // This modal lives OUTSIDE <main>, so the page-level Presentation masking +
  // MutationObserver never reach it. Mask it explicitly so the Target Engram
  // dropdown redacts engrams that aren't allowlisted for the demo.
  if (presActive()) applyPresentationMasking(modal);
}

/**
 * Pick one or more folders. In the Tauri app this is the native OS dialog. In
 * browser / personal-server mode there's no native dialog AND the relevant
 * disk is the SERVER's, so we open a server-side folder navigator backed by
 * the `fs.listDir` IPC. Returns selected absolute path(s), or [] if cancelled.
 */
async function pickFolders(): Promise<string[]> {
  if (IS_TAURI) {
    const picked = await invoke<string[]>('pick_folders');
    return picked ?? [];
  }
  const chosen = await browserFolderPicker();
  return chosen ? [chosen] : [];
}

interface ListDirResult { path: string; parent: string; dirs: Array<{ name: string; path: string }>; }

/** Server-side folder navigator (browser/personal-server mode). Walks the
 *  server's directories via the `fs.listDir` IPC; resolves the chosen absolute
 *  path, or null if cancelled. */
function browserFolderPicker(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'folder-picker-overlay';
    overlay.innerHTML =
      `<div class="folder-picker">` +
        `<div class="folder-picker-head"><strong>Choose a folder on the server</strong>` +
          `<button class="folder-picker-x" aria-label="Cancel">×</button></div>` +
        `<div class="folder-picker-path" id="fp-path"></div>` +
        `<div class="folder-picker-list" id="fp-list"></div>` +
        `<div class="folder-picker-actions">` +
          `<button class="folder-picker-cancel">Cancel</button>` +
          `<button class="folder-picker-use primary">Use this folder</button>` +
        `</div>` +
      `</div>`;
    document.body.appendChild(overlay);
    let current = '';
    const pathEl = overlay.querySelector('#fp-path') as HTMLElement;
    const listEl = overlay.querySelector('#fp-list') as HTMLElement;
    const close = (val: string | null): void => { overlay.remove(); resolve(val); };

    const load = async (p?: string): Promise<void> => {
      listEl.innerHTML = '<div class="fp-empty">Loading…</div>';
      try {
        const res = await invoke<ListDirResult>('fs_list_dir', p ? { path: p } : {});
        current = res.path;
        pathEl.textContent = res.path;
        const up = res.parent && res.parent !== res.path
          ? `<button class="fp-row fp-up" data-path="${escapeHtml(res.parent)}">⬆ ..</button>` : '';
        listEl.innerHTML = up + (res.dirs.length
          ? res.dirs.map((d) => `<button class="fp-row" data-path="${escapeHtml(d.path)}">📁 ${escapeHtml(d.name)}</button>`).join('')
          : '<div class="fp-empty">No subfolders here</div>');
        listEl.querySelectorAll<HTMLButtonElement>('.fp-row').forEach((b) =>
          b.addEventListener('click', () => void load(b.dataset['path'])));
      } catch (e) {
        listEl.innerHTML = `<div class="fp-empty">Couldn't read folder: ${escapeHtml(String(e))}</div>`;
      }
    };

    overlay.querySelector('.folder-picker-x')?.addEventListener('click', () => close(null));
    overlay.querySelector('.folder-picker-cancel')?.addEventListener('click', () => close(null));
    overlay.querySelector('.folder-picker-use')?.addEventListener('click', () => close(current || null));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    void load();
  });
}

function connectorSubtitleFor(kind: ConnectorKind): string {
  switch (kind) {
    case 'webhook': return 'Receive POSTed events from Zapier, IFTTT, custom scripts, anything.';
    case 'rss': return 'Pull new entries from any RSS or Atom feed on a schedule.';
    case 'github': return 'Pull issues, pull requests, and releases from repos you watch.';
    case 'slack': return 'Pull starred items and channel history from your workspace.';
    case 'trello': return 'Pull cards and checklists from boards you choose.';
    case 'linear': return 'Pull issues from your teams with status / priority filters.';
    case 'obsidian': return 'Auto-ingest notes from your local Obsidian vault. No API key needed.';
    case 'gbrain': return 'Auto-ingest notes from your local GBrain repo. No API key needed.';
    case 'ai-context': return 'Index CLAUDE.md, AGENTS.md, .cursorrules and other AI context files from your projects.';
    case 'x': return 'Pull your own bookmarks and recent posts from X. Requires a paid X API tier.';
  }
}

// Relevant base label per connector kind — used to suggest a new engram name
// and a connector slug by default.
const CONNECTOR_SUGGEST_BASE: Record<ConnectorKind, string> = {
  rss: 'RSS Feeds', github: 'GitHub', slack: 'Slack', trello: 'Trello',
  linear: 'Linear', obsidian: 'Obsidian Notes', gbrain: 'GBrain Notes',
  'ai-context': 'AI Context', webhook: 'Webhook Inbox', x: 'X',
};

/** A slug like "obsidian-7f3a" — relevant + unlikely to collide. */
function suggestConnectorId(kind: ConnectorKind): string {
  const suffix = Date.now().toString(36).slice(-4);
  return `${kind}-${suffix}`;
}

/** A relevant engram display name, deduped against existing engrams ("… 2"). */
function suggestEngramName(kind: ConnectorKind): string {
  const base = CONNECTOR_SUGGEST_BASE[kind] ?? 'Imported';
  const taken = new Set(getLoadedGraphs().map((g) => (g.metadata.displayName ?? g.graphId).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now().toString(36).slice(-3)}`;
}

function renderConnectorSetupBody(kind: ConnectorKind, existing?: ConnectorConfigShape): string {
  const opts = (existing?.options ?? {}) as Record<string, unknown>;
  const creds = existing?.credentials ?? {};
  const idField = `
    <div class="connector-field">
      <label for="connector-id">Connector ID (slug)</label>
      <input type="text" id="connector-id" placeholder="e.g. my-rss-news" value="${escapeHtml(existing?.id ?? suggestConnectorId(kind))}" ${existing ? 'readonly' : ''} />
      <span class="field-hint">${existing ? 'Cannot change after install.' : 'Letters, numbers, hyphens. Edit or clear to auto-generate.'}</span>
    </div>`;
  const graphField = `
    <div class="connector-field">
      <label for="connector-graphid">Target engram</label>
      <div class="connector-engram-row" style="display:flex;gap:6px;align-items:center;">
        <select id="connector-graphid" style="flex:1;min-width:0;"></select>
        <button type="button" id="connector-new-engram-btn" class="btn-secondary" style="white-space:nowrap;">+ New engram</button>
      </div>
      <input type="text" id="connector-new-engram-name" placeholder="New engram name…" style="display:none;margin-top:6px;" />
      <span class="field-hint">Ingested events become source nodes in this engram.</span>
    </div>`;
  // Opt-in mirror toggle for local-file connectors. Off = additive (default):
  // deleting a file leaves its memory in the cortex. On = the engram mirrors the
  // folder: deleting or renaming a file forgets the corresponding source, and
  // editing a file replaces (not duplicates) it.
  const mirrorDeletesField = `
    <div class="connector-field">
      <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-weight:400;">
        <input type="checkbox" id="connector-mirror-deletes" ${opts['mirrorDeletes'] === true ? 'checked' : ''} style="margin-top:3px;" />
        <span>Mirror deletions
          <span class="field-hint" style="display:block;margin-top:2px;">By default, deleting a file keeps its memory (Graphnosis is durable memory, not a folder mirror). Turn this on to also <strong>remove</strong> a memory when its file is deleted, and replace it when edited. Destructive — affects this engram only.</span>
        </span>
      </label>
    </div>`;
  // Per-connector check interval (optional). Blank = use the global default.
  // Applies to every kind; appended to the form just above the privacy note.
  const curIntervalMin = typeof opts['intervalMs'] === 'number' && (opts['intervalMs'] as number) > 0
    ? String(Math.round((opts['intervalMs'] as number) / 60_000)) : '';
  const intervalField = `
    <div class="connector-field">
      <label for="connector-interval">Check this source every <span style="font-weight:400;color:var(--fg-dim);">(optional)</span></label>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="number" id="connector-interval" min="1" max="1440" step="1" placeholder="default" value="${curIntervalMin}" style="width:120px;" />
        <span>minutes</span>
      </div>
      <span class="field-hint">Leave blank to use the default interval. Local-folder connectors also sync instantly on change.</span>
    </div>`;
  // Self-heal full re-scan cadence (per-connector). Blank = default (30 min);
  // 0 = off (manual re-sync only).
  const curFullRescanMin = typeof opts['fullRescanMinutes'] === 'number'
    ? String(opts['fullRescanMinutes'] as number) : '';
  const fullRescanField = `
    <div class="connector-field">
      <label for="connector-full-rescan">Full re-scan (self-heal) every <span style="font-weight:400;color:var(--fg-dim);">(optional)</span></label>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="number" id="connector-full-rescan" min="0" max="10080" step="1" placeholder="default 30" value="${curFullRescanMin}" style="width:120px;" />
        <span>minutes</span>
      </div>
      <span class="field-hint">Periodically re-checks every source so nothing skipped/failed in a prior run is permanently missed. Blank = 30 min. Set 0 to disable (manual re-sync only).</span>
    </div>`;
  const autoSyncOn = opts['autoSync'] !== false;
  const autoSyncField = `
    <div class="connector-field">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;">
        <input type="checkbox" id="connector-autosync" ${autoSyncOn ? 'checked' : ''} />
        Auto-sync (ingest automatically)
      </label>
      <span class="field-hint">On: pulls on its schedule and on file changes. <strong>Off (manual)</strong>: the connector stays idle until you click <strong>Pull now</strong> or <strong>Re-sync</strong> — set the stage first (e.g. Presentation Mode + select the engram), then start the import on cue.</span>
    </div>`;
  // Shown at the bottom of every connector form — applies universally.
  const privacyNote = `
    <div class="connector-help" style="border-left-color:var(--ok); margin-top:4px;">
      <strong>Continuous sync · fully local · encrypted.</strong>
      Graphnosis keeps pulling updates from this connector on its own schedule — you connect once and it stays current.
      All ingested data is stored encrypted on your machine and never sent to Graphnosis servers. Fully auditable from Graphnosis → Sources.
    </div>`;

  let html = '';
  switch (kind) {
    case 'rss':
      html = `
        <div class="connector-help">
          Paste one feed URL per line. Graphnosis dedupes by entry guid/link so re-pulls are no-ops on already-seen entries.
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-rss-feeds">Feed URL(s)</label>
          <textarea id="connector-rss-feeds" placeholder="https://example.com/feed.xml&#10;https://another.com/rss">${escapeHtml(((opts['feeds'] as string[]) ?? []).join('\n'))}</textarea>
        </div>`;
      break;
    case 'github':
      html = `
        <div class="connector-help">
          <strong>Bring your own Personal Access Token.</strong>
          <ol>
            <li><a href="#" data-extlink="https://github.com/settings/tokens?type=beta">Open GitHub fine-grained tokens →</a></li>
            <li>Create a token with read access to the repos you want indexed.</li>
            <li>Paste it below. Your token never leaves your machine.</li>
          </ol>
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-github-token">Personal Access Token</label>
          <input type="password" id="connector-github-token" placeholder="github_pat_…" value="${escapeHtml(creds['token'] ?? '')}" />
        </div>
        <div class="connector-field">
          <label for="connector-github-repos">Repos to watch (comma-separated)</label>
          <input type="text" id="connector-github-repos" placeholder="owner/repo, another-owner/another-repo" value="${escapeHtml(((opts['repos'] as string[]) ?? []).join(', '))}" />
        </div>
        <div class="connector-field">
          <label>Event types</label>
          <div class="connector-checkboxes">
            <label><input type="checkbox" id="connector-github-issues" ${((opts['issues'] as boolean) ?? true) ? 'checked' : ''} /> Issues</label>
            <label><input type="checkbox" id="connector-github-prs" ${((opts['prs'] as boolean) ?? true) ? 'checked' : ''} /> Pull requests</label>
            <label><input type="checkbox" id="connector-github-releases" ${((opts['releases'] as boolean) ?? false) ? 'checked' : ''} /> Releases</label>
          </div>
        </div>`;
      break;
    case 'slack':
      html = `
        <div class="connector-help">
          <strong>Bring your own Slack app.</strong>
          <ol>
            <li><a href="#" data-extlink="https://api.slack.com/apps">Open api.slack.com/apps →</a></li>
            <li>Create New App → From scratch → name it "Graphnosis".</li>
            <li>OAuth & Permissions → add scopes: <code>channels:history</code>, <code>stars:read</code> (whichever you want indexed).</li>
            <li>Install to Workspace → copy the <strong>Bot Token</strong> (starts with <code>xoxb-</code>) or use a <strong>User Token</strong> (<code>xoxp-</code>).</li>
          </ol>
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-slack-token">Bot or User Token</label>
          <input type="password" id="connector-slack-token" placeholder="xoxb-… or xoxp-…" value="${escapeHtml(creds['token'] ?? '')}" />
        </div>
        <div class="connector-field">
          <label>What to pull</label>
          <div class="connector-checkboxes">
            <label><input type="checkbox" id="connector-slack-starred" ${((opts['starred'] as boolean) ?? true) ? 'checked' : ''} /> Starred items</label>
            <label><input type="checkbox" id="connector-slack-channels" ${((opts['channelHistory'] as boolean) ?? false) ? 'checked' : ''} /> Channel history</label>
          </div>
        </div>`;
      break;
    case 'trello':
      html = `
        <div class="connector-help">
          <strong>Bring your own Trello API key + token.</strong>
          <ol>
            <li><a href="#" data-extlink="https://trello.com/power-ups/admin">Open trello.com/power-ups/admin →</a> create a new Power-Up.</li>
            <li>API Key tab → generate a Server Token by clicking "Token".</li>
            <li>Paste both below.</li>
          </ol>
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field-row">
          <div class="connector-field">
            <label for="connector-trello-key">API Key</label>
            <input type="password" id="connector-trello-key" value="${escapeHtml(creds['apiKey'] ?? '')}" />
          </div>
          <div class="connector-field">
            <label for="connector-trello-token">Token</label>
            <input type="password" id="connector-trello-token" value="${escapeHtml(creds['token'] ?? '')}" />
          </div>
        </div>
        <div class="connector-field">
          <label for="connector-trello-boards">Board IDs (comma-separated)</label>
          <input type="text" id="connector-trello-boards" placeholder="boardId1, boardId2" value="${escapeHtml(((opts['boardIds'] as string[]) ?? []).join(', '))}" />
          <span class="field-hint">Get board IDs from the URL: trello.com/b/<strong>BOARD_ID</strong>/board-name</span>
        </div>`;
      break;
    case 'linear':
      html = `
        <div class="connector-help">
          <strong>Bring your own Linear API key.</strong>
          <ol>
            <li><a href="#" data-extlink="https://linear.app/settings/api">Open linear.app/settings/api →</a></li>
            <li>Create a Personal API key. No OAuth flow — Linear's personal keys are first-class.</li>
            <li>Paste below.</li>
          </ol>
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-linear-key">Personal API Key</label>
          <input type="password" id="connector-linear-key" placeholder="lin_api_…" value="${escapeHtml(creds['apiKey'] ?? '')}" />
        </div>
        <div class="connector-field">
          <label for="connector-linear-team">Team key (optional filter)</label>
          <input type="text" id="connector-linear-team" placeholder="ENG, OPS, …" value="${escapeHtml(creds['teamKey'] ?? '')}" />
          <span class="field-hint">Leave blank to pull from every team you have access to.</span>
        </div>`;
      break;
    case 'obsidian':
      html = `
        <div class="connector-help">
          No API key needed — Graphnosis reads your vault's <code>.md</code> files directly from disk.
          Point it at your vault folder and it will ingest new and modified notes within
          seconds (it watches the folder), with a periodic re-scan as a backstop.
          The <code>.obsidian/</code> config directory is always skipped.
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-obsidian-vault">Vault folder path</label>
          <div style="display:flex; gap:8px; align-items:flex-start;">
            <input type="text" id="connector-obsidian-vault" placeholder="/Users/you/Documents/MyVault" value="${escapeHtml((opts['vaultPath'] as string) ?? '')}" style="flex:1;" />
            <button type="button" id="connector-obsidian-browse" class="btn-secondary" style="white-space:nowrap;">Browse…</button>
          </div>
          <span class="field-hint">Absolute path to the folder Obsidian uses as your vault.</span>
        </div>
        ${mirrorDeletesField}`;
      break;
    case 'gbrain':
      html = `
        <div class="connector-help">
          No API key needed — Graphnosis reads GBrain's <code>.md</code> files directly from your local git repo.
          Point it at the repo folder and it will ingest new and modified notes within
          seconds (it watches the folder), with a periodic re-scan as a backstop.
          GBrain wikilinks (<code>[[wiki/...]]</code>) are preserved in the ingested text.
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-gbrain-repo">GBrain repo path</label>
          <div style="display:flex; gap:8px; align-items:flex-start;">
            <input type="text" id="connector-gbrain-repo" placeholder="/Users/you/Documents/my-gbrain" value="${escapeHtml((opts['repoPath'] as string) ?? '')}" style="flex:1;" />
            <button type="button" id="connector-gbrain-browse" class="btn-secondary" style="white-space:nowrap;">Browse…</button>
          </div>
          <span class="field-hint">Absolute path to the root of your GBrain git repository.</span>
        </div>
        ${mirrorDeletesField}`;
      break;
    case 'ai-context':
      html = `
        <div class="connector-help">
          Indexes standard AI assistant context files across your projects — no credentials required.
          <br /><br />
          <strong>Only these specific filenames are indexed</strong> — no source code or other files are read:
          <code>CLAUDE.md</code>, <code>AGENTS.md</code>, <code>MEMORY.md</code>,
          <code>.cursorrules</code>, <code>.cursor/rules/*.md</code>,
          <code>.github/copilot-instructions.md</code>, <code>GEMINI.md</code>, <code>.windsurfrules</code>.
          <br /><br />
          <strong>~/.claude/CLAUDE.md</strong> is always included automatically.
          <br /><br />
          To index code or all <code>.md</code> files in a repo, use the <strong>GBrain</strong> connector instead.
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-aicontext-paths">Project folders (one per line)</label>
          <textarea id="connector-aicontext-paths" rows="4" placeholder="/Users/you/Developer/my-project&#10;/Users/you/Developer/another-project">${escapeHtml(((opts['paths'] as string[]) ?? []).join('\n'))}</textarea>
          <button type="button" id="connector-aicontext-browse" class="btn-secondary" style="margin-top:6px;">Browse…</button>
          <span class="field-hint">Point at the root of each project folder. Only the known AI context filenames above will be read — nothing else.</span>
        </div>
        ${mirrorDeletesField}`;
      break;
    case 'x': {
      const authUrlNote = existing
        ? `<div class="connector-help connector-help-accent">
            🔑 Client ID/Secret saved. Click <strong>Connect X account</strong> below to authorize via OAuth 2.0 — Graphnosis captures the token automatically via the callback.
          </div>
          <div class="connector-field">
            <button type="button" id="connector-x-connect" class="btn-secondary">Connect X account →</button>
            <span class="field-hint">Opens X's authorization page in your browser. After you approve, come back here — this modal can be closed once it says "authentication complete."</span>
          </div>`
        : `<div class="connector-help connector-help-accent">
            🔑 Save this form first (Client ID + Secret) — then re-open Edit on this connector to see the <strong>Connect X account</strong> button.
          </div>`;
      html = `
        <div class="connector-help">
          <strong>Bring your own X Developer app.</strong>
          <ol>
            <li><a href="#" data-extlink="https://developer.x.com/en/portal/dashboard">Open developer.x.com/portal →</a> and create (or pick) a Project + App.</li>
            <li>App settings → <strong>User authentication settings</strong> → <strong>Set up</strong>.</li>
            <li>Type of App: <strong>Web App, Automated App or Bot</strong> (confidential client — issues a Client Secret).</li>
            <li>App permissions: <strong>Read</strong>. OAuth 2.0: enabled.</li>
            <li><strong>Callback URI / Redirect URL</strong>: must exactly match Graphnosis's OAuth callback — <code>http://localhost:3458/oauth/&lt;connector-id&gt;/callback</code> (use the connector ID you set below; default webhook port is 3458).</li>
            <li>Keys and tokens tab → copy the <strong>OAuth 2.0 Client ID</strong> and <strong>Client Secret</strong>.</li>
          </ol>
          <strong>Most useful endpoints (bookmarks, posts) require a paid X API tier</strong> — the free tier is very limited. Check <a href="#" data-extlink="https://developer.x.com/en/portal/products">developer.x.com/portal/products →</a> before relying on this connector.
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field-row">
          <div class="connector-field">
            <label for="connector-x-client-id">OAuth 2.0 Client ID</label>
            <input type="password" id="connector-x-client-id" value="${escapeHtml(creds['clientId'] ?? '')}" />
          </div>
          <div class="connector-field">
            <label for="connector-x-client-secret">Client Secret</label>
            <input type="password" id="connector-x-client-secret" value="${escapeHtml(creds['clientSecret'] ?? '')}" />
          </div>
        </div>
        ${authUrlNote}
        <div class="connector-field">
          <label>What to pull</label>
          <div class="connector-checkboxes">
            <label><input type="checkbox" id="connector-x-bookmarks" ${((opts['includeBookmarks'] as boolean) ?? true) ? 'checked' : ''} /> Your bookmarks</label>
            <label><input type="checkbox" id="connector-x-posts" ${((opts['includeOwnPosts'] as boolean) ?? true) ? 'checked' : ''} /> Your recent posts</label>
          </div>
          <span class="field-hint">v1 covers your own bookmarks + own posts only. Mentions, timelines, trends, Articles, and DMs are not ingested yet.</span>
        </div>`;
      break;
    }
    case 'webhook': {
      const token = (opts['webhookToken'] as string) || '<generated on save>';
      const url = `http://localhost:3458/webhook/${existing?.id ?? '<id>'}/${token}`;
      html = `
        <div class="connector-help">
          Push-only connector. Anything that can POST JSON can send events here:
          Zapier, IFTTT, custom scripts, GitHub Actions, ngrok-exposed webhooks, etc.
          Expected body shape: <code>{ "text": "...", "label": "...", "source": "..." }</code>.
        </div>
        ${idField}
        ${graphField}
        ${existing ? `
        <div class="connector-field">
          <label>Webhook URL</label>
          <div class="connector-webhook-url-row">
            <code id="connector-webhook-url">${escapeHtml(url)}</code>
            <button type="button" id="btn-copy-webhook-url" class="btn-ghost" style="font-size: 15px; padding: 3px 8px;">Copy</button>
          </div>
          <span class="field-hint">Paste into Zapier / IFTTT / your script's webhook target.</span>
        </div>` : `
        <div class="connector-help connector-help-accent">
          🔑 <strong>Your unique webhook URL appears here once you click Save.</strong> Copy it then, and point your device, script, or Zapier/IFTTT/Make at it.
        </div>`}`;
      break;
    }
  }
  return html + intervalField + fullRescanField + autoSyncField + privacyNote;
}

function populateEngramDropdown(selectId: string, selectedId?: string): void {
  const sel = document.getElementById(selectId) as HTMLSelectElement | null;
  if (!sel) return;
  const fallback = selectedId ?? getLoadedGraphs()[0]?.graphId ?? '';
  const nameInput = document.getElementById('connector-new-engram-name') as HTMLInputElement | null;
  sel.innerHTML =
    `<option value="__new__">New Engram…</option>` +
    [...getLoadedGraphs()]
      // Archived engrams must never appear as a choice. Keep the currently
      // selected one (if it happens to be archived) so editing an existing
      // connector/scope doesn't silently drop its target.
      .filter((g) => !g.metadata.archived || g.graphId === selectedId)
      .sort((a, b) => (a.metadata.displayName ?? a.graphId).localeCompare(b.metadata.displayName ?? b.graphId))
      .map((g) => `<option value="${escapeHtml(g.graphId)}" ${g.graphId === fallback ? 'selected' : ''}>${escapeHtml(g.metadata.displayName ?? g.graphId)}</option>`)
      .join('');
  // Select the fallback (skips __new__ unless no graphs exist)
  if (fallback && Array.from(sel.options).some((o) => o.value === fallback)) sel.value = fallback;
  sel.addEventListener('change', () => {
    if (nameInput) nameInput.style.display = sel.value === '__new__' ? '' : 'none';
  });
}

function collectConnectorFormData(kind: ConnectorKind): Partial<ConnectorConfigShape> | null {
  const id = ($m<HTMLInputElement>('connector-id')?.value || '').trim();
  const graphId = ($m<HTMLSelectElement>('connector-graphid')?.value || '').trim();
  if (!graphId) { alert('Pick a target engram.'); return null; }
  // __new__ is resolved to a real graphId in the save handler before install.
  const credentials: Record<string, string> = {};
  const options: Record<string, unknown> = {};
  switch (kind) {
    case 'rss': {
      const feeds = ($m<HTMLTextAreaElement>('connector-rss-feeds')?.value || '')
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (!feeds.length) { alert('At least one feed URL is required.'); return null; }
      options['feeds'] = feeds;
      break;
    }
    case 'github': {
      const token = $m<HTMLInputElement>('connector-github-token')?.value || '';
      if (!token) { alert('GitHub PAT is required.'); return null; }
      credentials['token'] = token;
      options['repos'] = ($m<HTMLInputElement>('connector-github-repos')?.value || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      options['issues'] = $m<HTMLInputElement>('connector-github-issues')?.checked ?? true;
      options['prs'] = $m<HTMLInputElement>('connector-github-prs')?.checked ?? true;
      options['releases'] = $m<HTMLInputElement>('connector-github-releases')?.checked ?? false;
      break;
    }
    case 'slack': {
      const token = $m<HTMLInputElement>('connector-slack-token')?.value || '';
      if (!token) { alert('Slack token is required.'); return null; }
      credentials['token'] = token;
      options['starred'] = $m<HTMLInputElement>('connector-slack-starred')?.checked ?? true;
      options['channelHistory'] = $m<HTMLInputElement>('connector-slack-channels')?.checked ?? false;
      break;
    }
    case 'trello': {
      const apiKey = $m<HTMLInputElement>('connector-trello-key')?.value || '';
      const token = $m<HTMLInputElement>('connector-trello-token')?.value || '';
      if (!apiKey || !token) { alert('Trello API key + token are both required.'); return null; }
      credentials['apiKey'] = apiKey;
      credentials['token'] = token;
      options['boardIds'] = ($m<HTMLInputElement>('connector-trello-boards')?.value || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      break;
    }
    case 'linear': {
      const apiKey = $m<HTMLInputElement>('connector-linear-key')?.value || '';
      if (!apiKey) { alert('Linear API key is required.'); return null; }
      credentials['apiKey'] = apiKey;
      const team = $m<HTMLInputElement>('connector-linear-team')?.value.trim() || '';
      if (team) credentials['teamKey'] = team;
      break;
    }
    case 'obsidian': {
      const vaultPath = $m<HTMLInputElement>('connector-obsidian-vault')?.value.trim() || '';
      if (!vaultPath) { alert('Vault path is required.'); return null; }
      options['vaultPath'] = vaultPath;
      options['mirrorDeletes'] = $m<HTMLInputElement>('connector-mirror-deletes')?.checked === true;
      break;
    }
    case 'gbrain': {
      const repoPath = $m<HTMLInputElement>('connector-gbrain-repo')?.value.trim() || '';
      if (!repoPath) { alert('Repo path is required.'); return null; }
      options['repoPath'] = repoPath;
      options['mirrorDeletes'] = $m<HTMLInputElement>('connector-mirror-deletes')?.checked === true;
      break;
    }
    case 'ai-context': {
      const paths = ($m<HTMLTextAreaElement>('connector-aicontext-paths')?.value || '')
        .split('\n').map((s) => s.trim()).filter(Boolean);
      options['paths'] = paths;
      options['mirrorDeletes'] = $m<HTMLInputElement>('connector-mirror-deletes')?.checked === true;
      break;
    }
    case 'x': {
      const clientId = $m<HTMLInputElement>('connector-x-client-id')?.value || '';
      const clientSecret = $m<HTMLInputElement>('connector-x-client-secret')?.value || '';
      if (!clientId || !clientSecret) { alert('X Client ID + Client Secret are both required.'); return null; }
      credentials['clientId'] = clientId;
      credentials['clientSecret'] = clientSecret;
      options['includeBookmarks'] = $m<HTMLInputElement>('connector-x-bookmarks')?.checked ?? true;
      options['includeOwnPosts'] = $m<HTMLInputElement>('connector-x-posts')?.checked ?? true;
      break;
    }
    case 'webhook': {
      // Token auto-generated server-side if missing.
      break;
    }
  }
  // Per-connector check interval (optional, universal). Blank → no override
  // (the sidecar falls back to the global default).
  const intervalRaw = ($m<HTMLInputElement>('connector-interval')?.value || '').trim();
  if (intervalRaw) {
    const mins = Math.min(1440, Math.max(1, Math.round(Number(intervalRaw) || 0)));
    options['intervalMs'] = mins > 0 ? mins * 60_000 : undefined;
  } else {
    // Blank → clear any existing override (merge persists, undefined is dropped).
    options['intervalMs'] = undefined;
  }
  // Self-heal full re-scan cadence: blank → default (drop override); 0 → disable.
  const fullRescanRaw = ($m<HTMLInputElement>('connector-full-rescan')?.value || '').trim();
  if (fullRescanRaw === '') {
    options['fullRescanMinutes'] = undefined;
  } else {
    options['fullRescanMinutes'] = Math.min(10080, Math.max(0, Math.round(Number(fullRescanRaw) || 0)));
  }
  // Manual mode: unchecked → connector stays idle until Pull now / Re-sync.
  options['autoSync'] = $m<HTMLInputElement>('connector-autosync')?.checked ?? true;
  return {
    ...(id ? { id } : {}),
    kind,
    graphId,
    enabled: true,
    credentials,
    options,
  };
}

function wireConnectorIntervalControl(): void {
  const intervalInput = document.getElementById('gc-default-interval') as HTMLInputElement | null;
  intervalInput?.addEventListener('change', () => {
    const mins = Math.min(1440, Math.max(1, Math.round(Number(intervalInput.value) || 15)));
    intervalInput.value = String(mins);
    void (async () => {
      try {
        await invoke('update_settings', { settings: { connectors: { pullIntervalMs: mins * 60_000 } } });
        const tid = app().addIngestToast('Connector poll interval', `Now checking every ${mins} min`);
        app().finishIngestToast(tid, 'success', `Now checking every ${mins} min`);
      } catch (e) {
        const tid = app().addIngestToast('Couldn’t update interval', String(e));
        app().finishIngestToast(tid, 'error', String(e));
      }
    })();
  });
}

function wireConnectorsUi(): void {
  // Refresh on cortex unlock + when user toggles the Settings tab.
  document.querySelectorAll<HTMLButtonElement>('.btn-add-connector').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset['kind'] as ConnectorKind | undefined;
      if (kind) openConnectorSetupModal(kind);
    });
  });

  document.getElementById('connector-setup-cancel')?.addEventListener('click', () => {
    document.getElementById('connector-setup-modal')?.classList.add('hidden');
    pendingConnectorEditId = null; pendingConnectorKind = null;
  });

  document.getElementById('connector-setup-save')?.addEventListener('click', async () => {
    if (!pendingConnectorKind) return;
    const btn = document.getElementById('connector-setup-save') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const config = collectConnectorFormData(pendingConnectorKind);
      if (!config) { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } return; }
      // Create a new engram on-the-fly when the user picked "New Engram…".
      if (config.graphId === '__new__') {
        const displayName = ($m<HTMLInputElement>('connector-new-engram-name')?.value || '').trim();
        if (!displayName) { alert('Enter a name for the new engram.'); if (btn) { btn.disabled = false; btn.textContent = 'Save'; } return; }
        const newGraphId = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') +
          '-' + Math.random().toString(36).slice(-4);
        const connCreateResult = await invoke<{ error?: { code: string } }>('create_graph_with_template', { graphId: newGraphId, template: 'personal', displayName });
        if (connCreateResult?.error?.code === 'ENGRAM_LIMIT_REACHED') {
          alert('Free plan: 3 engram limit reached. Upgrade to Pro at graphnosis.com/upgrade to create more engrams.');
          void invoke('plugin:opener|open_url', { url: 'https://graphnosis.com/upgrade' });
          if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
          return;
        }
        await app().reloadGraphsMetadata();
        app().syncEngramPicker();
        config.graphId = newGraphId;
      }
      // If editing, force the id from the existing record.
      if (pendingConnectorEditId) config.id = pendingConnectorEditId;
      await invoke('install_connector', { config });
      document.getElementById('connector-setup-modal')?.classList.add('hidden');
      pendingConnectorEditId = null; pendingConnectorKind = null;
      await refreshConnectorsList();
      const tid = app().addIngestToast('Connector saved', 'Will start pulling on the next interval');
      app().finishIngestToast(tid, 'success', 'Will start pulling on the next interval');
    } catch (e) {
      const tid = app().addIngestToast(`Couldn't save connector`, String(e));
      app().finishIngestToast(tid, 'error', String(e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  });

  // Copy webhook URL button (delegated since the URL row may not exist yet).
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest('#btn-copy-webhook-url') as HTMLButtonElement | null;
    if (!btn) return;
    const code = document.getElementById('connector-webhook-url');
    if (!code) return;
    void navigator.clipboard.writeText(code.textContent ?? '').then(() => {
      const orig = btn.textContent; btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });
}
