/**
 * Memory Integrity Workbench — Foresight sub-surface for contradictions,
 * duplicates, corrections queue, compare-sources, and resolution history.
 */

export type IntegrityTab = 'queue' | 'entity' | 'sources' | 'history' | 'filtered' | 'actions';

export interface IntegrityPair {
  id: string;
  graphId: string;
  nodeA: string;
  nodeB: string;
  snippetA: string;
  snippetB: string;
  sharedEntities: string[];
  description: string;
  detectedAt: number;
  kind?: 'semantic' | 'policy';
  severity?: 'low' | 'medium' | 'high';
  temporalVerdict?: 'genuine_contradiction' | 'temporal_supersession' | 'negation_artifact';
  sourceA?: string;
  sourceB?: string;
  resolvedAt?: number;
  resolution?: string;
}

export interface AttentionCounts {
  corrections: number;
  duplicates: number;
  contradictions: number;
  total: number;
}

type IpcFn = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

export interface WorkbenchDeps {
  ipcCall: IpcFn;
  escapeHtml: (s: string) => string;
  engramName: (graphId: string) => string;
  openTrivia: () => void;
  openGhampusWalk: (prompt: string) => void;
  activateMode: (mode: string) => void;
  openForesightLane?: (lane: string) => void;
}

let mounted = false;
let activeTab: IntegrityTab = 'queue';
let deps: WorkbenchDeps | null = null;
let ensureMounted: (() => void) | null = null;

/** main.ts registers mount so early opens (before renderForesight) still paint the workbench. */
export function setMemoryIntegrityBootstrap(fn: () => void): void {
  ensureMounted = fn;
}

function el(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function tabBtn(tab: IntegrityTab, label: string, active: boolean): string {
  return `<button type="button" class="btn-sm mi-tab${active ? ' primary' : ''}" data-mi-tab="${tab}">${label}</button>`;
}

function severityBadge(sev?: string): string {
  if (!sev) return '';
  return `<span class="mi-sev mi-sev-${sev}">${sev}</span>`;
}

function verdictLabel(v?: string): string {
  if (v === 'temporal_supersession') return 'Likely superseded';
  if (v === 'negation_artifact') return 'Negation artifact';
  if (v === 'genuine_contradiction') return 'Genuine conflict';
  return '';
}

function renderPairCard(pair: IntegrityPair, d: WorkbenchDeps, actions = true): string {
  const verdict = verdictLabel(pair.temporalVerdict);
  return `<div class="mi-pair-card" data-pair-id="${d.escapeHtml(pair.id)}">
    <div class="mi-pair-head">
      ${pair.kind === 'policy' ? '<span class="sgr-badge">Policy</span>' : ''}
      ${severityBadge(pair.severity)}
      ${verdict ? `<span class="mi-verdict">${d.escapeHtml(verdict)}</span>` : ''}
      <span class="lb-engram-chip">${d.escapeHtml(d.engramName(pair.graphId))}</span>
    </div>
    <div class="lb-dup-card-pair">
      <div class="lb-snippet"><span class="lb-snippet-tag">A</span>${d.escapeHtml(pair.snippetA)}</div>
      <div class="lb-snippet"><span class="lb-snippet-tag">B</span>${d.escapeHtml(pair.snippetB)}</div>
    </div>
    <p class="brain-subtitle">${d.escapeHtml(pair.description)} · ${d.escapeHtml((pair.sharedEntities ?? []).slice(0, 4).join(', '))}</p>
    ${actions ? `<div class="mi-pair-actions">
      <button type="button" class="btn-sm primary" data-mi-resolve="keep-a" data-id="${d.escapeHtml(pair.id)}">Keep A</button>
      <button type="button" class="btn-sm" data-mi-resolve="keep-b" data-id="${d.escapeHtml(pair.id)}">Keep B</button>
      <button type="button" class="btn-sm" data-mi-resolve="mark-debate" data-id="${d.escapeHtml(pair.id)}">Mark debate</button>
      <button type="button" class="btn-sm" data-mi-ghampus="${d.escapeHtml(pair.id)}">Ask Ghampus</button>
    </div>` : `<p class="brain-subtitle">Resolved: ${d.escapeHtml(pair.resolution ?? '—')}</p>`}
  </div>`;
}

async function renderQueue(d: WorkbenchDeps): Promise<void> {
  const host = el('mi-tab-body');
  if (!host) return;
  host.innerHTML = '<p class="lb-empty">Loading queue…</p>';
  const [pairs, dupes, counts] = await Promise.all([
    d.ipcCall<IntegrityPair[]>('brain:getContradictionPairs', {}),
    d.ipcCall<Array<{ id: string; snippetA: string; snippetB: string; graphId: string }>>('brain:getDuplicatePairs', {}),
    d.ipcCall<AttentionCounts>('brain:getAttentionCounts', {}),
  ]);
  const parts: string[] = [];
  if (counts.corrections > 0) {
    parts.push(`<div class="mi-summary-row"><strong>${counts.corrections}</strong> pending correction${counts.corrections === 1 ? '' : 's'}
      <button type="button" class="btn-sm primary" data-mi-open-corrections>Review corrections</button></div>`);
  }
  if (dupes.length > 0) {
    parts.push(`<div class="mi-summary-row"><strong>${dupes.length}</strong> duplicate pair${dupes.length === 1 ? '' : 's'} in Check-in</div>`);
  }
  if (pairs.length === 0 && counts.corrections === 0 && dupes.length === 0) {
    host.innerHTML = '<p class="home-card-empty">Nothing needs attention in this workbench — no verified pairs to resolve. '
      + 'Foresight Insights may still show CONFLICT hints from your local LLM; open Insights for those.</p>';
    return;
  }
  const QUEUE_PREVIEW = 3;
  const previewPairs = pairs.slice(0, QUEUE_PREVIEW);
  parts.push(previewPairs.length
    ? previewPairs.map((p) => renderPairCard(p, d)).join('')
      + (pairs.length > QUEUE_PREVIEW
        ? `<p class="brain-subtitle" style="margin-top:8px;">${pairs.length - QUEUE_PREVIEW} more in queue — scroll to review or resolve these first.</p>`
        : '')
    : '<p class="brain-subtitle">No verified contradiction pairs queued — only entity-linked conflicts that pass deterministic checks appear here. '
      + 'See Foresight Insights for LLM conflict hints.</p>');
  host.innerHTML = parts.join('');
  host.querySelector('[data-mi-open-corrections]')?.addEventListener('click', () => d.openTrivia());
  host.querySelectorAll<HTMLButtonElement>('[data-mi-resolve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset['id'];
      const action = btn.dataset['miResolve'];
      if (!id || !action) return;
      try {
        await d.ipcCall('brain:resolveContradictionPair', { id, action });
      } catch { /* ignore */ }
      void renderQueue(d);
      document.dispatchEvent(new CustomEvent('graphnosis:attention-changed'));
    });
  });
  host.querySelectorAll<HTMLButtonElement>('[data-mi-ghampus]').forEach((btn) => {
    btn.addEventListener('click', () => {
      d.openGhampusWalk('Walk me through my memory contradictions — explain each conflict and draft fixes I can approve.');
    });
  });
}

async function renderHistory(d: WorkbenchDeps): Promise<void> {
  const host = el('mi-tab-body');
  if (!host) return;
  const rows = await d.ipcCall<IntegrityPair[]>('brain:getContradictionHistory', {});
  host.innerHTML = rows.length
    ? rows.slice(0, 40).map((p) => renderPairCard(p, d, false)).join('')
    : '<p class="home-card-empty">No resolved contradictions yet.</p>';
}

async function renderSources(d: WorkbenchDeps): Promise<void> {
  const host = el('mi-tab-body');
  if (!host) return;
  const graphId = (document.getElementById('mi-source-graph') as HTMLSelectElement | null)?.value ?? '';
  const sources = graphId
    ? await d.ipcCall<Array<{ sourceId: string; ref: string; contradictions?: unknown[] }>>('sources.list', { graphId })
    : [];
  const opts = sources.map((s) => {
    const n = s.contradictions?.length ?? 0;
    const badge = n > 0 ? ` (${n} conflicts)` : '';
    return `<option value="${d.escapeHtml(s.sourceId)}">${d.escapeHtml(s.ref)}${badge}</option>`;
  }).join('');
  host.innerHTML = `
    <div class="mi-sources-form">
      <label class="brain-subtitle">Engram</label>
      <select id="mi-source-graph" class="mi-select"></select>
      <label class="brain-subtitle">Source A</label>
      <select id="mi-source-a" class="mi-select">${opts}</select>
      <label class="brain-subtitle">Source B</label>
      <select id="mi-source-b" class="mi-select">${opts}</select>
      <button type="button" id="mi-compare-btn" class="btn-sm primary">Compare sources</button>
    </div>
    <div id="mi-compare-out" class="mi-compare-out"></div>`;
  const gSel = host.querySelector('#mi-source-graph') as HTMLSelectElement;
  if (gSel) {
    const graphs = await d.ipcCall<Array<{ graphId: string; displayName?: string }>>('graphs.listWithMetadata', {});
    gSel.innerHTML = graphs.map((g) =>
      `<option value="${d.escapeHtml(g.graphId)}"${g.graphId === graphId ? ' selected' : ''}>${d.escapeHtml(g.displayName ?? g.graphId)}</option>`,
    ).join('');
    gSel.addEventListener('change', () => { void renderSources(d); });
  }
  host.querySelector('#mi-compare-btn')?.addEventListener('click', async () => {
    const gid = (host.querySelector('#mi-source-graph') as HTMLSelectElement)?.value;
    const a = (host.querySelector('#mi-source-a') as HTMLSelectElement)?.value;
    const b = (host.querySelector('#mi-source-b') as HTMLSelectElement)?.value;
    const out = host.querySelector('#mi-compare-out');
    if (!gid || !a || !b || !out) return;
    out.innerHTML = '<p class="lb-empty">Comparing…</p>';
    try {
      const found = await d.ipcCall<IntegrityPair[]>('brain:compareSources', { graphId: gid, sourceA: a, sourceB: b });
      out.innerHTML = found.length
        ? found.map((p) => renderPairCard(p, d)).join('')
        : '<p class="home-card-empty">No conflicts detected between these sources.</p>';
    } catch {
      out.innerHTML = '<p class="home-card-empty">Compare failed — try again.</p>';
    }
  });
}

async function renderActions(d: WorkbenchDeps): Promise<void> {
  const host = el('mi-tab-body');
  if (!host) return;
  host.innerHTML = `
    <p class="brain-subtitle">Run an on-demand contradiction audit or ask Ghampus to walk you through the queue.</p>
    <div class="mi-actions-row">
      <button type="button" class="btn-sm primary" id="mi-scan-now">Scan whole cortex now</button>
      <button type="button" class="btn-sm" id="mi-ghampus-walk">Ask Ghampus to walk me through</button>
    </div>
    <p id="mi-scan-status" class="brain-subtitle"></p>`;
  host.querySelector('#mi-scan-now')?.addEventListener('click', async () => {
    const status = host.querySelector('#mi-scan-status');
    if (status) status.textContent = 'Scanning…';
    try {
      const r = await d.ipcCall<{ added: number }>('brain:runContradictionScan', { deep: true });
      if (status) status.textContent = r.added > 0 ? `Added ${r.added} new pair(s) to the queue.` : 'Scan complete — no new conflicts found.';
      void renderQueue(d);
    } catch {
      if (status) status.textContent = 'Scan failed.';
    }
  });
  host.querySelector('#mi-ghampus-walk')?.addEventListener('click', () => {
    d.openGhampusWalk('Run a consistency audit on my cortex — walk me through contradictions and duplicates one at a time.');
  });
}

async function renderEntity(d: WorkbenchDeps): Promise<void> {
  const host = el('mi-tab-body');
  if (!host) return;
  host.innerHTML = `
    <p class="brain-subtitle">Search what your cortex believes about an entity — conflicts are highlighted in the queue tab.</p>
    <div class="mi-entity-row">
      <input id="mi-entity-q" type="search" placeholder="Entity or topic (e.g. vegan, Graphnosis launch)" />
      <button type="button" class="btn-sm primary" id="mi-entity-go">Search</button>
    </div>
    <div id="mi-entity-out"></div>`;
  host.querySelector('#mi-entity-go')?.addEventListener('click', async () => {
    const q = (host.querySelector('#mi-entity-q') as HTMLInputElement)?.value.trim();
    const out = host.querySelector('#mi-entity-out');
    if (!q || !out) return;
    out.innerHTML = '<p class="lb-empty">Searching…</p>';
    try {
      const r = await d.ipcCall<{ results?: Array<{ graphId: string; nodeId: string; contentPreview?: string; snippet?: string }> }>(
        'recall',
        { q, k: 12 },
      );
      const hits = r.results ?? [];
      out.innerHTML = hits.length
        ? hits.map((h) => `<div class="mi-entity-hit"><span class="lb-engram-chip">${d.escapeHtml(d.engramName(h.graphId))}</span><p>${d.escapeHtml((h.contentPreview ?? h.snippet ?? '').slice(0, 200))}</p></div>`).join('')
        : '<p class="home-card-empty">No memories matched.</p>';
    } catch {
      out.innerHTML = '<p class="home-card-empty">Search unavailable.</p>';
    }
  });
}

interface SuppressedPair {
  graphId: string;
  snippetA: string;
  snippetB: string;
  severity?: string;
  temporalVerdict?: string;
  reason: string;
  sharedEntities: string[];
  fromIngest: boolean;
  detectedAt: number;
}

const REASON_LABEL: Record<string, string> = {
  'insufficient-entities': 'Too few shared anchors',
  'low-severity': 'Low severity',
  'negation-artifact': 'Negation artifact',
  'temporal-supersession': 'Superseded over time',
  'ingest-gate': 'Held at ingest',
};

function renderSuppressedCard(p: SuppressedPair, d: WorkbenchDeps): string {
  return `<div class="mi-pair-card">
    <div class="mi-pair-head">
      <span class="sgr-badge">${d.escapeHtml(REASON_LABEL[p.reason] ?? p.reason)}</span>
      ${severityBadge(p.severity)}
      ${p.fromIngest ? '<span class="brain-subtitle">ingest</span>' : ''}
      <span class="lb-engram-chip">${d.escapeHtml(d.engramName(p.graphId))}</span>
    </div>
    <div class="lb-dup-card-pair">
      <div class="lb-snippet"><span class="lb-snippet-tag">A</span>${d.escapeHtml(p.snippetA)}</div>
      <div class="lb-snippet"><span class="lb-snippet-tag">B</span>${d.escapeHtml(p.snippetB)}</div>
    </div>
    ${p.sharedEntities.length ? `<p class="brain-subtitle">${d.escapeHtml(p.sharedEntities.slice(0, 4).join(', '))}</p>` : ''}
  </div>`;
}

async function renderFiltered(d: WorkbenchDeps): Promise<void> {
  const host = el('mi-tab-body');
  if (!host) return;
  host.innerHTML = '<p class="lb-empty">Loading…</p>';
  const rows = await d.ipcCall<SuppressedPair[]>('brain:getSuppressedContradictions', {});
  if (rows.length === 0) {
    host.innerHTML = '<p class="home-card-empty">Nothing filtered. The triage records pairs it detects but holds back from the queue — none so far.</p>';
    return;
  }
  const superseded = rows.filter((r) => r.reason === 'temporal-supersession');
  const filtered = rows.filter((r) => r.reason !== 'temporal-supersession');
  const parts: string[] = [
    '<p class="brain-subtitle">Pairs the deterministic triage detected but held back from the review queue — recorded here so nothing is silently dropped. Read-only.</p>',
  ];
  if (superseded.length) {
    parts.push(`<p class="mi-summary-row"><strong>Superseded over time (${superseded.length})</strong></p>`);
    parts.push(superseded.map((p) => renderSuppressedCard(p, d)).join(''));
  }
  if (filtered.length) {
    parts.push(`<p class="mi-summary-row"><strong>Filtered as false-positive (${filtered.length})</strong></p>`);
    parts.push(filtered.map((p) => renderSuppressedCard(p, d)).join(''));
  }
  host.innerHTML = parts.join('');
}

async function renderTab(d: WorkbenchDeps): Promise<void> {
  switch (activeTab) {
    case 'queue': return renderQueue(d);
    case 'history': return renderHistory(d);
    case 'sources': return renderSources(d);
    case 'actions': return renderActions(d);
    case 'entity': return renderEntity(d);
    case 'filtered': return renderFiltered(d);
  }
}

export function mountMemoryIntegrityWorkbench(d: WorkbenchDeps): void {
  deps = d;
  const root = el('memory-integrity-workbench');
  if (!root || mounted) return;
  mounted = true;
  root.innerHTML = `
    <div class="mi-tabs">${tabBtn('queue', 'Queue', true)}${tabBtn('entity', 'Entity', false)}${tabBtn('sources', 'Sources', false)}${tabBtn('history', 'History', false)}${tabBtn('filtered', 'Filtered', false)}${tabBtn('actions', 'Actions', false)}</div>
    <div id="mi-tab-body" class="mi-tab-body"></div>`;
  root.querySelectorAll<HTMLButtonElement>('[data-mi-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = (btn.dataset['miTab'] as IntegrityTab) ?? 'queue';
      root.querySelectorAll('[data-mi-tab]').forEach((b) => b.classList.remove('primary'));
      btn.classList.add('primary');
      if (deps) void renderTab(deps);
    });
  });
  void renderTab(d);
}

export function refreshMemoryIntegrityWorkbench(): void {
  if (!deps) return;
  const root = el('memory-integrity-workbench');
  root?.querySelectorAll('[data-mi-tab]').forEach((b) => {
    b.classList.toggle('primary', (b as HTMLElement).dataset['miTab'] === activeTab);
  });
  void renderTab(deps);
}

export function openMemoryIntegrityWorkbench(tab: IntegrityTab = 'queue'): void {
  activeTab = tab;
  ensureMounted?.();
  refreshMemoryIntegrityWorkbench();
  deps?.activateMode('goals');
  if (deps?.openForesightLane) {
    deps.openForesightLane('integrity');
  } else {
    requestAnimationFrame(() => {
      el('memory-integrity-workbench')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

export async function fetchAttentionCounts(d: Pick<WorkbenchDeps, 'ipcCall'>): Promise<AttentionCounts> {
  try {
    return await d.ipcCall<AttentionCounts>('brain:getAttentionCounts', {});
  } catch {
    return { corrections: 0, duplicates: 0, contradictions: 0, total: 0 };
  }
}

export function renderAttentionStrip(
  counts: AttentionCounts,
  d: Pick<WorkbenchDeps, 'escapeHtml' | 'openTrivia'>,
): void {
  const strip = el('home-attention-strip');
  if (!strip) return;
  if (counts.total <= 0) {
    strip.classList.add('hidden');
    strip.innerHTML = '';
    return;
  }
  const parts: string[] = [];
  if (counts.corrections > 0) {
    parts.push(`${counts.corrections} correction${counts.corrections === 1 ? '' : 's'}`);
  }
  if (counts.contradictions > 0) {
    parts.push(`${counts.contradictions} contradiction${counts.contradictions === 1 ? '' : 's'}`);
  }
  if (counts.duplicates > 0) {
    parts.push(`${counts.duplicates} duplicate${counts.duplicates === 1 ? '' : 's'}`);
  }
  strip.classList.remove('hidden');
  strip.innerHTML =
    `<span class="home-attention-text"><strong>Needs attention:</strong> ${d.escapeHtml(parts.join(' · '))}</span>` +
    `<button type="button" class="home-attention-cta" data-attention-review>Review in Memory Integrity →</button>` +
    (counts.corrections > 0 ? `<button type="button" class="home-attention-link" data-attention-corrections>Corrections deck</button>` : '');
  strip.querySelector('[data-attention-review]')?.addEventListener('click', () => openMemoryIntegrityWorkbench('queue'));
  strip.querySelector('[data-attention-corrections]')?.addEventListener('click', () => d.openTrivia());
}
