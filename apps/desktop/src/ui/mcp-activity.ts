/**
 * MCP audit Activity — AI access log segment (Settings → Activity pane).
 */
import { app } from './app-context';
import { ipcCallTimeout } from './ipc';
import { escape } from './util';

/** Populated by initMcpActivity() from main.ts `els`. */
let els!: Record<string, HTMLElement>;

export interface McpAuditTokenBudget {
  requestedTokens?: number;
  requestedNodes?: number;
  servedTokens?: number;
  servedNodes?: number;
}

export interface McpAuditEvent {
  id: string;
  ts: number;
  tool: string;
  clientId: string;
  engramIds?: string[];
  nodeIds?: string[];
  tokenBudget?: McpAuditTokenBudget;
  consentGrantId?: string;
  queryHash?: string;
  queryLen?: number;
  isError?: boolean;
  transport?: 'stdio' | 'socket' | 'http';
}

const MCP_IPC_TIMEOUT_MS = 60_000;
const MCP_WINDOW_START = 500;
const MCP_WINDOW_STEP = 500;
const MCP_WINDOW_MAX = 10000;

let mcpWindow = MCP_WINDOW_START;
let mcpHasMore = false;
let mcpLoading = false;
let mcpEvents: McpAuditEvent[] = [];
let mcpFiltered: McpAuditEvent[] = [];
let mcpServerClients: string[] = [];
let mcpServerTools: string[] = [];

type McpCat = 'all' | 'recall' | 'remember' | 'edit' | 'forget' | 'other';
let mcpCat: McpCat = 'all';

const MCP_CAT_TOOLS: Record<Exclude<McpCat, 'all' | 'other'>, string[]> = {
  recall: ['recall', 'remind', 'dig_deeper'],
  remember: ['remember'],
  edit: ['edit', 'apply'],
  forget: ['forget'],
};
const MCP_KNOWN_TOOLS = new Set(Object.values(MCP_CAT_TOOLS).flat());

const MCP_CAT_LABELS: Record<McpCat, string> = {
  all: 'All', recall: 'Recall', remember: 'Remember', edit: 'Edit', forget: 'Forget', other: 'Other',
};

export function initMcpActivity(mcpEls: Record<string, HTMLElement>): void {
  els = mcpEls;
  wireMcpActivityEvents();
}

export function getMcpActivityCat(): McpCat { return mcpCat; }
export function setMcpActivityCat(cat: McpCat): void { mcpCat = cat; }
export function resetMcpActivityWindow(): void { mcpWindow = MCP_WINDOW_START; }

function mcpDateBounds(): { since?: number; until?: number } {
  const out: { since?: number; until?: number } = {};
  const from = (els.mcpActivityDateFrom as HTMLInputElement).value;
  const to = (els.mcpActivityDateTo as HTMLInputElement).value;
  if (from) out.since = new Date(`${from}T00:00:00`).getTime();
  if (to) out.until = new Date(`${to}T23:59:59.999`).getTime();
  return out;
}

function mcpDateRangeActive(): boolean {
  const from = els.mcpActivityDateFrom as HTMLInputElement;
  const to = els.mcpActivityDateTo as HTMLInputElement;
  return Boolean(from.value || to.value);
}

function showMcpLoading(detail?: string): void {
  els.mcpActivityList.innerHTML =
    (detail ? `<p class="subtitle">${escape(detail)}</p>` : '') +
    '<div class="home-skel"></div><div class="home-skel w70"></div><div class="home-skel"></div>';
}

function mcpHourMinutes(val: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(val);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function populateMcpClientSelect(): void {
  const sel = els.mcpActivityClientSelect as HTMLSelectElement;
  const prev = sel.value;
  sel.innerHTML =
    '<option value="">All clients</option>' +
    mcpServerClients.map((c) =>
      `<option value="${escape(c)}">${escape(app().friendlyClient(c))}</option>`,
    ).join('');
  if (prev && mcpServerClients.includes(prev)) sel.value = prev;
}

function populateMcpToolSelect(): void {
  const sel = els.mcpActivityToolSelect as HTMLSelectElement;
  const prev = sel.value;
  sel.innerHTML =
    '<option value="">All tools</option>' +
    mcpServerTools.map((t) => `<option value="${escape(t)}">${escape(t)}</option>`).join('');
  if (prev && mcpServerTools.includes(prev)) sel.value = prev;
}

function populateMcpEngramSelect(): void {
  const sel = els.mcpActivityEngramSelect as HTMLSelectElement;
  const prev = sel.value;
  const graphs = app().getLoadedGraphs().filter((g) => !g.metadata.archived);
  const ids = graphs.map((g) => g.graphId)
    .sort((a, b) => app().engramName(a).localeCompare(app().engramName(b)));
  sel.innerHTML =
    '<option value="">All engrams</option>' +
    ids.map((id) => `<option value="${escape(id)}">${escape(app().engramName(id))}</option>`).join('');
  if (prev && ids.includes(prev)) sel.value = prev;
}

export async function refreshMcpActivityView(opts?: { showLoading?: boolean }): Promise<void> {
  if (mcpLoading) return;
  mcpLoading = true;
  try {
    if (opts?.showLoading || mcpEvents.length === 0) showMcpLoading();
    const bounds = mcpDateBounds();
    const dateScoped = mcpDateRangeActive();
    const params: {
      limit: number;
      since?: number;
      until?: number;
      client?: string;
      tool?: string;
      tools?: string[];
      engram?: string;
    } = { limit: dateScoped ? MCP_WINDOW_MAX : mcpWindow };
    if (bounds.since !== undefined) params.since = bounds.since;
    if (bounds.until !== undefined) params.until = bounds.until;
    const clientSel = (els.mcpActivityClientSelect as HTMLSelectElement).value;
    if (clientSel) params.client = clientSel;
    const toolSel = (els.mcpActivityToolSelect as HTMLSelectElement).value;
    if (toolSel) params.tool = toolSel;
    const engramSel = (els.mcpActivityEngramSelect as HTMLSelectElement).value;
    if (engramSel) params.engram = engramSel;
    if (mcpCat !== 'all' && mcpCat !== 'other') params.tools = MCP_CAT_TOOLS[mcpCat];

    const r = await ipcCallTimeout<{
      events: McpAuditEvent[];
      clients: string[];
      tools: string[];
      hasMore: boolean;
    }>('audit.mcp.list', params, MCP_IPC_TIMEOUT_MS);

    mcpEvents = r.events ?? [];
    mcpServerClients = r.clients ?? [];
    mcpServerTools = r.tools ?? [];
    mcpHasMore = r.hasMore ?? false;
    if (!dateScoped && mcpEvents.length >= mcpWindow) mcpHasMore = true;

    populateMcpClientSelect();
    populateMcpToolSelect();
    populateMcpEngramSelect();
    applyMcpActivityFilter();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[mcp-activity] audit.mcp.list failed:', e);
    els.mcpActivityList.innerHTML =
      `<p class="subtitle">Couldn't load AI access log — ${escape(msg.slice(0, 120))}${msg.length > 120 ? '…' : ''} ` +
      '<button id="btn-mcp-activity-retry" class="btn-sm" type="button">Retry</button></p>';
  } finally {
    mcpLoading = false;
  }
}

export function loadMoreMcpActivity(): void {
  if (mcpLoading || mcpWindow >= MCP_WINDOW_MAX) return;
  mcpWindow = Math.min(MCP_WINDOW_MAX, mcpWindow + MCP_WINDOW_STEP);
  void refreshMcpActivityView();
}

function applyMcpActivityFilter(): void {
  const query = (els.mcpActivitySearch as HTMLInputElement).value.trim().toLowerCase();
  const hourFrom = mcpHourMinutes((els.mcpActivityHourFrom as HTMLInputElement).value);
  const hourTo = mcpHourMinutes((els.mcpActivityHourTo as HTMLInputElement).value);

  els.mcpActivityChips.querySelectorAll<HTMLButtonElement>('.g-activity-chip').forEach((chip) => {
    const cat = (chip.dataset.cat ?? 'all') as McpCat;
    chip.classList.toggle('active', cat === mcpCat);
    chip.textContent = MCP_CAT_LABELS[cat];
  });

  const rangeActive = mcpDateRangeActive() || hourFrom !== null || hourTo !== null;
  els.mcpActivityDateClear.classList.toggle('hidden', !rangeActive);

  const matchesText = (e: McpAuditEvent): boolean => {
    if (!query) return true;
    const engrams = (e.engramIds ?? []).map((id) => app().engramName(id)).join(' ');
    const hay = `${e.tool} ${e.clientId} ${app().friendlyClient(e.clientId)} ${engrams} ${e.queryHash ?? ''} ${e.transport ?? ''}`.toLowerCase();
    return hay.includes(query);
  };
  const matchesHour = (e: McpAuditEvent): boolean => {
    if (hourFrom === null && hourTo === null) return true;
    const d = new Date(e.ts);
    const mins = d.getHours() * 60 + d.getMinutes();
    const lo = hourFrom ?? 0;
    const hi = hourTo ?? 24 * 60 - 1;
    return lo <= hi ? (mins >= lo && mins <= hi) : (mins >= lo || mins <= hi);
  };
  const matchesCat = (e: McpAuditEvent): boolean => {
    if (mcpCat === 'all') return true;
    if (mcpCat === 'other') return !MCP_KNOWN_TOOLS.has(e.tool);
    return MCP_CAT_TOOLS[mcpCat].includes(e.tool);
  };

  mcpFiltered = mcpEvents
    .filter((e) => matchesText(e) && matchesHour(e) && matchesCat(e))
    .slice()
    .sort((a, b) => b.ts - a.ts);
  renderMcpActivity();
}

const mcpDayLabel = (ts: number): string => {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};
const mcpTime = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function clientBadge(clientId: string): string {
  const label = app().friendlyClient(clientId);
  return `<span class="activity-actor actor-ai" title="MCP client" data-pres="surface:mcpClients">${escape(label)}</span>`;
}

function engramChips(ids?: string[]): string {
  if (!ids?.length) return '';
  return ids.map((id) =>
    `<span class="ar-engram" data-pres="engram:${escape(id)}">${escape(app().engramName(id))}</span>`,
  ).join(' ');
}

function mcpDetail(e: McpAuditEvent): string {
  const bits: string[] = [];
  const tb = e.tokenBudget;
  if (tb?.servedTokens !== undefined || tb?.requestedTokens !== undefined) {
    const served = tb.servedTokens ?? '—';
    const req = tb.requestedTokens ?? '—';
    bits.push(`tokens ${served}/${req}`);
  }
  if (tb?.servedNodes !== undefined || tb?.requestedNodes !== undefined) {
    bits.push(`nodes ${tb.servedNodes ?? '—'}/${tb.requestedNodes ?? '—'}`);
  }
  if (e.queryLen !== undefined) bits.push(`query ${e.queryLen} chars`);
  if (e.queryHash) bits.push(`hash ${escape(e.queryHash.slice(0, 12))}${e.queryHash.length > 12 ? '…' : ''}`);
  if (e.consentGrantId) bits.push(`consent ${escape(e.consentGrantId.slice(0, 12))}…`);
  if (e.transport) bits.push(escape(e.transport));
  if (e.isError) bits.push('<span class="ar-why">error</span>');
  return bits.join(' · ');
}

function mcpLabel(e: McpAuditEvent): string {
  const tool = `<span class="ar-kind">${escape(e.tool)}</span>`;
  const engrams = engramChips(e.engramIds);
  return `${tool}${engrams ? ` · ${engrams}` : ''}`;
}

function renderMcpActivityRow(e: McpAuditEvent): string {
  const detail = mcpDetail(e);
  return `<div class="activity-row">
    <span class="ar-when">${escape(mcpTime(e.ts))}</span>
    <span class="ar-dot mcp-${e.tool}"></span>
    <div>
      <div>${mcpLabel(e)} ${clientBadge(e.clientId)}</div>
      ${detail ? `<div class="ar-detail">${detail}</div>` : ''}
    </div>
  </div>`;
}

function renderMcpActivity(): void {
  const total = mcpEvents.length;
  const all = mcpFiltered;

  if (all.length === 0) {
    if (els.mcpActivityStats) {
      els.mcpActivityStats.textContent = `0 of ${total} loaded event${total === 1 ? '' : 's'}`;
    }
    els.mcpActivityList.innerHTML = total === 0
      ? '<p class="subtitle">No AI access events yet. Connect an MCP client and call recall, remember, or other tools.</p>'
      : '<p class="subtitle">No events match these filters.</p>';
    return;
  }

  const byDay = new Map<string, McpAuditEvent[]>();
  for (const e of all) {
    const k = mcpDayLabel(e.ts);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(e);
  }

  let html = '';
  for (const [day, dayEvents] of byDay) {
    html += `<p class="activity-day-divider">${escape(day)}</p>`;
    for (const e of dayEvents) html += renderMcpActivityRow(e);
  }

  const scope = mcpCat === 'all' ? '' : ` · ${MCP_CAT_LABELS[mcpCat]} only`;
  if (els.mcpActivityStats) {
    els.mcpActivityStats.textContent =
      `${all.length} event${all.length === 1 ? '' : 's'} loaded${scope}`;
  }

  if (mcpHasMore && mcpWindow < MCP_WINDOW_MAX) {
    html += `<button id="mcp-activity-load-more" class="activity-load-more" type="button">↓ Load ${MCP_WINDOW_STEP} more…</button>`;
  } else if (mcpWindow >= MCP_WINDOW_MAX && mcpHasMore) {
    html += `<p class="subtitle" style="text-align:center; padding:10px;">Showing the most recent ${MCP_WINDOW_MAX.toLocaleString()} — narrow the date range to dig deeper.</p>`;
  }
  els.mcpActivityList.innerHTML = html;
}

function wireMcpActivityEvents(): void {
  els.mcpActivityList.addEventListener('click', (e) => {
    const retry = (e.target as HTMLElement).closest<HTMLButtonElement>('#btn-mcp-activity-retry');
    if (retry) {
      e.preventDefault();
      if (mcpLoading) return;
      mcpWindow = MCP_WINDOW_START;
      void refreshMcpActivityView({ showLoading: true });
      return;
    }
    const loadMore = (e.target as HTMLElement).closest<HTMLButtonElement>('#mcp-activity-load-more');
    if (loadMore) {
      loadMore.innerHTML = '<span class="activity-spinner"></span> Loading…';
      loadMore.disabled = true;
      loadMoreMcpActivity();
    }
  });

  els.mcpActivityChips.addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('.g-activity-chip');
    if (!chip) return;
    mcpCat = (chip.dataset.cat ?? 'all') as McpCat;
    mcpWindow = MCP_WINDOW_START;
    void refreshMcpActivityView();
  });

  let searchTimer: number | null = null;
  els.mcpActivitySearch.addEventListener('input', () => {
    if (searchTimer !== null) clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => applyMcpActivityFilter(), 120);
  });
  els.mcpActivityEngramSelect.addEventListener('change', () => { mcpWindow = MCP_WINDOW_START; void refreshMcpActivityView(); });
  els.mcpActivityClientSelect.addEventListener('change', () => { mcpWindow = MCP_WINDOW_START; void refreshMcpActivityView(); });
  els.mcpActivityToolSelect.addEventListener('change', () => { mcpWindow = MCP_WINDOW_START; void refreshMcpActivityView(); });
  els.mcpActivityDateFrom.addEventListener('change', () => { mcpWindow = MCP_WINDOW_START; void refreshMcpActivityView(); });
  els.mcpActivityDateTo.addEventListener('change', () => { mcpWindow = MCP_WINDOW_START; void refreshMcpActivityView(); });
  els.mcpActivityHourFrom.addEventListener('change', () => applyMcpActivityFilter());
  els.mcpActivityHourTo.addEventListener('change', () => applyMcpActivityFilter());
  els.mcpActivityDateClear.addEventListener('click', () => {
    (els.mcpActivityDateFrom as HTMLInputElement).value = '';
    (els.mcpActivityDateTo as HTMLInputElement).value = '';
    (els.mcpActivityHourFrom as HTMLInputElement).value = '';
    (els.mcpActivityHourTo as HTMLInputElement).value = '';
    mcpWindow = MCP_WINDOW_START;
    void refreshMcpActivityView();
  });
  els.btnMcpActivityRefresh.addEventListener('click', () => void refreshMcpActivityView());
}
