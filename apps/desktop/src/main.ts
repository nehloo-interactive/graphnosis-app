import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

// ---- types matching Rust ------------------------------------------------

interface StatusSnapshot {
  unlocked: boolean;
  vault_dir: string | null;
  sidecar_running: boolean;
}

interface GraphSummary {
  graphId: string;
  totalNodes: number;
  activeNodes: number;
  softDeletedNodes: number;
  sources: number;
}

interface SourceRecord {
  sourceId: string;
  kind: string;
  ref: string;
  graphId: string;
  nodeIds: string[];
  ingestedAt: number;
}

interface StatsSummary {
  graphs: GraphSummary[];
  sources: SourceRecord[];
}

// ---- DOM helpers --------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  err: $<HTMLDivElement>('error'),
  viewUnlock: $<HTMLElement>('view-unlock'),
  viewInspector: $<HTMLElement>('view-inspector'),
  vaultDir: $<HTMLInputElement>('vault-dir'),
  passphrase: $<HTMLInputElement>('passphrase'),
  btnPick: $<HTMLButtonElement>('btn-pick'),
  btnUnlock: $<HTMLButtonElement>('btn-unlock'),
  unlockStatus: $<HTMLSpanElement>('unlock-status'),
  btnRefresh: $<HTMLButtonElement>('btn-refresh'),
  btnOpenFolder: $<HTMLButtonElement>('btn-open-folder'),
  btnLock: $<HTMLButtonElement>('btn-lock'),
  btnAddFile: $<HTMLButtonElement>('btn-add-file'),
  vaultLabel: $<HTMLSpanElement>('vault-label'),
  graphStats: $<HTMLDivElement>('graph-stats'),
  sourcesList: $<HTMLDivElement>('sources-list'),
  dropZone: $<HTMLDivElement>('drop-zone'),
};

function showError(msg: string | null): void {
  if (!msg) {
    els.err.classList.add('hidden');
    return;
  }
  els.err.textContent = msg;
  els.err.classList.remove('hidden');
}

function render(status: StatusSnapshot): void {
  if (status.unlocked) {
    els.viewUnlock.classList.add('hidden');
    els.viewInspector.classList.remove('hidden');
    els.vaultLabel.textContent = status.vault_dir ?? 'vault';
    void refreshStats();
  } else {
    els.viewInspector.classList.add('hidden');
    els.viewUnlock.classList.remove('hidden');
  }
}

async function refreshStats(): Promise<void> {
  els.sourcesList.innerHTML = '<p class="subtitle">Loading…</p>';
  try {
    const data = (await invoke('inspector_stats')) as StatsSummary;
    els.graphStats.innerHTML = data.graphs
      .map(
        (g) => `
        <div class="stat-row"><span class="stat-label">${escape(g.graphId)} · total</span><span>${g.totalNodes}</span></div>
        <div class="stat-row"><span class="stat-label">${escape(g.graphId)} · active</span><span>${g.activeNodes}</span></div>
        <div class="stat-row"><span class="stat-label">${escape(g.graphId)} · soft-deleted</span><span>${g.softDeletedNodes}</span></div>
        <div class="stat-row"><span class="stat-label">${escape(g.graphId)} · sources</span><span>${g.sources}</span></div>
      `,
      )
      .join('');
    if (data.sources.length === 0) {
      els.sourcesList.innerHTML = '<p class="subtitle">No sources yet. Use the `remember` MCP tool from Claude or drag a file in.</p>';
    } else {
      els.sourcesList.innerHTML = data.sources
        .slice()
        .sort((a, b) => b.ingestedAt - a.ingestedAt)
        .map(
          (s) => `
          <div class="source-row">
            <span class="source-name">${escape(s.ref)}</span>
            <span class="source-meta">${s.nodeIds.length} node${s.nodeIds.length === 1 ? '' : 's'}</span>
          </div>
        `,
        )
        .join('');
    }
  } catch (e) {
    els.sourcesList.innerHTML = `<p class="error">${escape(String(e))}</p>`;
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

// ---- event wiring -------------------------------------------------------

els.btnPick.addEventListener('click', async () => {
  showError(null);
  try {
    const folder = (await invoke('pick_vault_folder')) as string | null;
    if (folder) els.vaultDir.value = folder;
  } catch (e) {
    showError(String(e));
  }
});

els.btnUnlock.addEventListener('click', async () => {
  showError(null);
  els.btnUnlock.disabled = true;
  els.unlockStatus.textContent = 'Starting sidecar…';
  try {
    const status = (await invoke('unlock_vault', {
      args: { vault_dir: els.vaultDir.value, passphrase: els.passphrase.value },
    })) as StatusSnapshot;
    els.passphrase.value = '';
    els.unlockStatus.textContent = '';
    render(status);
  } catch (e) {
    showError(String(e));
    els.unlockStatus.textContent = '';
  } finally {
    els.btnUnlock.disabled = false;
  }
});

els.btnRefresh.addEventListener('click', () => void refreshStats());

els.btnOpenFolder.addEventListener('click', async () => {
  try {
    await invoke('open_vault_in_finder');
  } catch (e) {
    showError(String(e));
  }
});

els.btnLock.addEventListener('click', async () => {
  try {
    const status = (await invoke('lock_vault')) as StatusSnapshot;
    render(status);
  } catch (e) {
    showError(String(e));
  }
});

els.btnAddFile.addEventListener('click', async () => {
  showError(null);
  try {
    const result = (await invoke('pick_and_ingest_file')) as { sourceId?: string } | null;
    if (result) {
      await refreshStats();
    }
  } catch (e) {
    showError(`Ingest failed: ${e}`);
  }
});

// Tauri window drag-drop events. Webview is the canonical event target for
// file drops in Tauri 2 (browser's drag/drop API gives us no real file paths).
async function ingestDroppedPath(p: string): Promise<void> {
  els.dropZone.classList.add('busy');
  els.dropZone.textContent = `Ingesting ${p.split('/').pop()}…`;
  try {
    await invoke('ingest_file', { graphId: null, path: p });
    await refreshStats();
    els.dropZone.textContent = 'Drop another file here to ingest — or use Add file…';
  } catch (e) {
    showError(`Ingest failed: ${e}`);
    els.dropZone.textContent = 'Drop a file here to ingest — or use Add file…';
  } finally {
    els.dropZone.classList.remove('busy');
  }
}

void (async () => {
  const webview = getCurrentWebview();
  await webview.onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === 'enter' || payload.type === 'over') {
      els.dropZone.classList.add('dragging');
    } else if (payload.type === 'leave') {
      els.dropZone.classList.remove('dragging');
    } else if (payload.type === 'drop') {
      els.dropZone.classList.remove('dragging');
      const paths = (payload as { paths: string[] }).paths ?? [];
      // Ingest the first file; multi-file batches are an obvious future improvement.
      if (paths.length > 0 && paths[0]) {
        void ingestDroppedPath(paths[0]);
      }
    }
  });
})().catch((e) => {
  // Drag-drop wiring failure is non-fatal — the Add file button still works.
  console.warn('drag-drop wiring failed:', e);
});

// Allow Enter in the passphrase field to submit.
els.passphrase.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.btnUnlock.click();
});

// Tray-driven status updates push us into the right view in real time.
void listen<StatusSnapshot>('graphnosis://status', (evt) => render(evt.payload));

// Initial state: ask the backend whether we're already unlocked
// (e.g., auto-unlock from keychain in a future iteration).
void (async () => {
  try {
    const status = (await invoke('status')) as StatusSnapshot;
    render(status);
  } catch (e) {
    showError(String(e));
  }
})();
