/**
 * Activity — global op-log timeline (Settings → Activity pane).
 */
import { app } from './app-context';
import { gAlert } from './dialogs';
import { ipcCall, ipcCallTimeout } from './ipc';
import { escape, presSourceAttr } from './util';
import type { OpLogEvent, GraphWithMetadata } from './types';

/** Persisted audit record for the most recent op-log compaction (from sidecar). */
export interface OplogCompactionRecord {
  at: number;
  eventsRemoved: number;
  eventsBefore: number;
  eventsAfter: number;
  bytesBefore?: number;
  bytesAfter?: number;
}

/** Populated by initActivity() from main.ts `els`. */
let els!: Record<string, HTMLElement>;

function getLoadedGraphs(): GraphWithMetadata[] {
  return app().getLoadedGraphs();
}

export function initActivity(activityEls: Record<string, HTMLElement>): void {
  els = activityEls;
  wireActivityEvents();
  wireActivityComplianceExport();
}

interface SharingPlanInfo {
  licensed: boolean;
  enterprise?: boolean;
}

/** Show/hide the Enterprise Evidence Pack panel on the Activity pane. */
export async function refreshActivityCompliancePanel(): Promise<void> {
  const section = document.getElementById('activity-compliance-section');
  const recallPanel = document.getElementById('activity-recall-as-of-panel');
  if (!section) return;
  try {
    const plan = await ipcCall<SharingPlanInfo>('sharing:planInfo', {});
    const show = plan.enterprise === true;
    section.style.display = show ? '' : 'none';
    if (recallPanel) recallPanel.style.display = show ? '' : 'none';
  } catch {
    section.style.display = 'none';
    if (recallPanel) recallPanel.style.display = 'none';
  }
}

function wireActivityComplianceExport(): void {
  const btn = document.getElementById('btn-activity-evidence-export') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const bounds = activityDateBounds();
      const engram = els.activityEngramSelect.value.trim();
      const params: { since?: number; until?: number; engram?: string } = { ...bounds };
      if (engram) params.engram = engram;
      const result = await ipcCallTimeout<{
        ok: boolean;
        pack?: { manifestHash?: string; signatures?: unknown[] };
        manifestHash?: string;
        signatures?: unknown[];
        detachedSig?: unknown;
        reason?: string;
        message?: string;
      }>('compliance.exportEvidencePack', params, ACTIVITY_IPC_TIMEOUT_MS);
      if (!result.ok) {
        void gAlert('Evidence Pack export failed', result.message ?? result.reason ?? 'Unknown error');
        return;
      }
      const pack = result.pack ?? {};
      const json = JSON.stringify(pack, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const datePart = new Date().toISOString().slice(0, 10);
      const scopePart = engram ? `-${engram.replace(/[^a-z0-9_-]+/gi, '_')}` : '';
      a.download = `graphnosis-evidence-pack${scopePart}-${datePart}.json`;
      a.click();
      URL.revokeObjectURL(url);
      const sigPayload = result.detachedSig ?? {
        manifestHash: result.manifestHash ?? pack.manifestHash,
        signatures: result.signatures ?? pack.signatures,
      };
      if (sigPayload && (sigPayload as { signatures?: unknown[] }).signatures?.length) {
        const sigBlob = new Blob([JSON.stringify(sigPayload, null, 2)], { type: 'application/json' });
        const sigUrl = URL.createObjectURL(sigBlob);
        const sigA = document.createElement('a');
        sigA.href = sigUrl;
        sigA.download = `graphnosis-evidence-pack${scopePart}-${datePart}.sig.json`;
        sigA.click();
        URL.revokeObjectURL(sigUrl);
      }
    } catch (e) {
      void gAlert('Evidence Pack export error', e instanceof Error ? e.message : String(e));
    } finally {
      btn.disabled = false;
    }
  });

  const recallBtn = document.getElementById('btn-activity-recall-as-of') as HTMLButtonElement | null;
  if (recallBtn) {
    recallBtn.addEventListener('click', async () => {
      const query = (document.getElementById('activity-recall-as-of-query') as HTMLInputElement | null)?.value.trim() ?? '';
      const seqRaw = (document.getElementById('activity-recall-as-of-seq') as HTMLInputElement | null)?.value.trim();
      const tsRaw = (document.getElementById('activity-recall-as-of-ts') as HTMLInputElement | null)?.value.trim();
      const preview = document.getElementById('activity-recall-as-of-preview');
      if (!query) {
        void gAlert('Recall as of', 'Enter a search query.');
        return;
      }
      if (!seqRaw && !tsRaw) {
        void gAlert('Recall as of', 'Enter an op-log sequence number or Unix timestamp (ms).');
        return;
      }
      recallBtn.disabled = true;
      if (preview) preview.textContent = 'Loading preview…';
      try {
        const engram = els.activityEngramSelect.value.trim();
        const result = await ipcCallTimeout<{
          ok: boolean;
          result?: unknown;
          message?: string;
          reason?: string;
        }>('compliance.recallAsOf', {
          query,
          ...(engram ? { graphId: engram } : {}),
          ...(seqRaw ? { asOfSeq: Number(seqRaw) } : {}),
          ...(tsRaw ? { asOfTs: Number(tsRaw) } : {}),
          maxNodes: 20,
        }, ACTIVITY_IPC_TIMEOUT_MS);
        if (!result.ok) {
          void gAlert('Recall as of failed', result.message ?? result.reason ?? 'Unknown error');
          if (preview) preview.textContent = '';
          return;
        }
        if (preview) {
          preview.textContent = JSON.stringify(result.result ?? {}, null, 2);
        }
      } catch (e) {
        void gAlert('Recall as of error', e instanceof Error ? e.message : String(e));
        if (preview) preview.textContent = '';
      } finally {
        recallBtn.disabled = false;
      }
    });
  }
}

export function getActivityCat(): ActivityCat { return activityCat; }
export function setActivityCat(cat: ActivityCat): void { activityCat = cat; }
export function setActivityActor(actor: string): void { els.activityActorSelect.value = actor; }
export function clearActivityDateFilters(): void {
  els.activityDateFrom.value = '';
  els.activityDateTo.value = '';
  els.activityHourFrom.value = '';
  els.activityHourTo.value = '';
  activityRangeInitialized = false;
  activityNextCursor = undefined;
}
export function resetActivityWindow(): void { activityNextCursor = undefined; }


// ── Activity (op-log timeline) ────────────────────────────────────────

// Growing fetch window: autonomous-brain ops (e.g. mass edge re-links) can fill
// the most-recent N events and bury the user's ingests/edits/forgets, which are
// older. So we start at 2000 and grow the window (see auto-load in renderActivity)
// until there's real variety. The sidecar's incremental cache makes re-slicing a
// bigger window cheap after the first cold read.
// Default ~500 events loaded; the user clicks "Load more" for more. The
// autonomous brain can emit tens of thousands of edge ops a day, so for a
// specific category (Ingested/Forgotten/Edits…) we pass `ops` to the sidecar so
// it pulls THAT type from the full op-log — no longer buried under edge spam.
// 500 felt thin. The render groups+collapses events by day→signature, so the DOM
// is bounded by GROUP count, not event count — the only cost is the op-log fetch,
// and the backend already pulls limit:10000 elsewhere. So we can start much higher
// and step bigger. 2000 initial loads in well under a second and shows real depth;
// "Load more" ramps 2000 at a time to a 20000 hard cap (a brief load at the top
// end, on demand).
const ACTIVITY_PAGE_SIZE = 2000;
/** Client-side IPC budget — op-log reads on iCloud-synced cortexes can exceed 25s. */
const ACTIVITY_IPC_TIMEOUT_MS = 60_000;
let activityHasMore = false;
let activityLoading = false;
let activityNextCursor: { ts: number; id: string } | undefined;
let activityRangeInitialized = false;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First open: default to the last 7 days (inclusive). */
function ensureDefaultActivityRange(): void {
  if (activityRangeInitialized) return;
  activityRangeInitialized = true;
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 6);
  els.activityDateTo.value = toIsoDate(to);
  els.activityDateFrom.value = toIsoDate(from);
}

/** Read date + hour inputs → absolute ms bounds for activity.list (hours are server-side). */
function activityDateBounds(): { since?: number; until?: number } {
  const out: { since?: number; until?: number } = {};
  const from = els.activityDateFrom.value;
  const to = els.activityDateTo.value;
  const hourFrom = els.activityHourFrom.value.trim();
  const hourTo = els.activityHourTo.value.trim();

  let sinceMs: number | undefined;
  let untilMs: number | undefined;

  if (from) {
    const h = hourFrom || '00:00';
    sinceMs = new Date(`${from}T${h}:00`).getTime() - 1;
  }
  if (to) {
    if (hourTo) {
      untilMs = new Date(`${to}T${hourTo}:59.999`).getTime();
    } else {
      untilMs = new Date(`${to}T23:59:59.999`).getTime();
    }
  } else if (from && hourTo) {
    untilMs = new Date(`${from}T${hourTo}:59.999`).getTime();
  }

  if (sinceMs !== undefined && untilMs !== undefined && untilMs <= sinceMs) {
    untilMs = sinceMs + 3_600_000 + 1;
  }

  if (sinceMs !== undefined) out.since = sinceMs;
  if (untilMs !== undefined) out.until = untilMs;
  return out;
}

function activityRangeImpossible(): boolean {
  const bounds = activityDateBounds();
  return bounds.since !== undefined && bounds.until !== undefined && bounds.until <= bounds.since;
}

function activityDateRangeActive(): boolean {
  return Boolean(
    els.activityDateFrom.value || els.activityDateTo.value
    || els.activityHourFrom.value || els.activityHourTo.value,
  );
}

function showActivityLoading(detail?: string): void {
  els.activityList.innerHTML =
    (detail
      ? `<p class="subtitle">${escape(detail)}</p>`
      : '') +
    '<div class="home-skel"></div><div class="home-skel w70"></div><div class="home-skel"></div>';
}

const ACTIVITY_TRANSIENT_RE =
  /connect to sidecar|ECONNREFUSED|ENOENT.*sock|cortex is locked|not running|timed out|did not respond/i;

function isCortexPreloading(): boolean {
  return app().isEngramPreloadInProgress();
}

/** activity.list with retries while the sidecar is busy loading engrams at boot. */
async function activityIpcCall<T>(method: string, params: unknown, ms: number): Promise<T> {
  const maxTries = isCortexPreloading() ? 8 : 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      return await ipcCallTimeout<T>(method, params, ms);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < maxTries - 1 && ACTIVITY_TRANSIENT_RE.test(msg)) {
        await new Promise<void>((r) => setTimeout(r, 750 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function activityIpcErrorBody(msg: string): string {
  const preloading = isCortexPreloading();
  const unreachable = /connect to sidecar|ECONNREFUSED|ENOENT.*sock|cortex is locked|not running/i.test(msg);
  const timedOut = /timed out|did not respond/i.test(msg);
  const syncing = /icloud|sync|op-log|unknown.device|seq.rewind|seq.gap|integrity/i.test(msg);
  if (preloading && (unreachable || timedOut)) {
    return 'Loading cortex — activity will appear once engrams finish loading.';
  }
  if (unreachable) {
    return 'Couldn’t load activity — the memory engine isn’t responding. Lock and unlock again to restart it.';
  }
  if (timedOut) {
    return 'Couldn’t load activity — the op-log read timed out (common on iCloud-synced cortexes). Try again or narrow the date range.';
  }
  if (syncing) {
    return 'Couldn’t load activity — still syncing from iCloud. Wait for sync to finish, then tap Retry.';
  }
  return 'Couldn’t load activity — the memory engine returned an error.';
}

function showActivityIpcError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error('[activity] activity.list failed:', e);
  const body = activityIpcErrorBody(msg);
  const devHint = import.meta.env.DEV && msg
    ? `<span class="activity-dev-err" title="${escape(msg)}"> (${escape(msg.slice(0, 120))}${msg.length > 120 ? '…' : ''})</span>`
    : '';
  els.activityList.innerHTML =
    `<p class="subtitle">${body}${devHint} ` +
    '<button id="btn-activity-retry" class="btn-sm" type="button">Retry</button></p>';
}

export async function refreshActivityView(opts?: { showLoading?: boolean; append?: boolean }): Promise<void> {
  if (activityLoading) {
    if (import.meta.env.DEV) console.warn('[activity] refresh skipped — load already in progress');
    return;
  }
  ensureDefaultActivityRange();
  if (!opts?.append) activityNextCursor = undefined;
  activityLoading = true;
  try {
    if (opts?.showLoading || (!opts?.append && activityEvents.length === 0)) showActivityLoading();
    if (activityRangeImpossible()) {
      activityEvents = [];
      activityHasMore = false;
      activityNextCursor = undefined;
      activityServerActors = [];
      activityWarnings = [];
      applyActivityFilter();
      return;
    }
    const bounds = activityDateBounds();
    const params: {
      limit: number;
      ops?: string[];
      since?: number;
      until?: number;
      actor?: string;
      cursor?: { ts: number; id: string };
    } = { limit: ACTIVITY_PAGE_SIZE };
    if (activityCat !== 'all') params.ops = ACTIVITY_CAT_OPS[activityCat];
    if (bounds.since !== undefined) params.since = bounds.since;
    if (bounds.until !== undefined) params.until = bounds.until;
    if (activityNextCursor) params.cursor = activityNextCursor;
    const actorSel = els.activityActorSelect.value;
    if (actorSel) params.actor = actorSel;
    const r = await activityIpcCall<{
      events: OpLogEvent[];
      actors?: string[];
      warnings?: string[];
      hasMore?: boolean;
      nextCursor?: { ts: number; id: string };
      lastCompaction?: OplogCompactionRecord | null;
    }>('activity.list', params, ACTIVITY_IPC_TIMEOUT_MS);
    const page = r.events ?? [];
    if (opts?.append) {
      const seen = new Set(activityEvents.map((e) => e.id));
      activityEvents = [...activityEvents, ...page.filter((e) => !seen.has(e.id))];
    } else {
      activityEvents = page;
    }
    if (r.actors?.length) {
      activityServerActors = [...new Set([...activityServerActors, ...r.actors])].sort((a, b) => a.localeCompare(b));
    } else if (!opts?.append) {
      activityServerActors = r.actors ?? [];
    }
    activityWarnings = r.warnings ?? [];
    setLastCompactionFromServer(r.lastCompaction);
    activityHasMore = r.hasMore === true;
    activityNextCursor = r.nextCursor;
    try {
      populateActivityEngramSelect();
      populateActivityActorSelect();
      applyActivityFilter();
    } catch (renderErr) {
      console.error('[activity] render failed after activity.list succeeded:', renderErr);
      showActivityIpcError(renderErr);
    }
  } catch (e) {
    if (isCortexPreloading()) {
      showActivityLoading('Loading cortex — activity will appear shortly…');
      window.setTimeout(() => { void refreshActivityView(); }, 4000);
      return;
    }
    showActivityIpcError(e);
  } finally {
    activityLoading = false;
  }
}

/** Load the next cursor page from the sidecar. */
export function loadMoreActivity(): void {
  if (activityLoading || !activityHasMore || !activityNextCursor) return;
  void refreshActivityView({ append: true });
}

// Most-recent events from the last activity.list fetch. Chip/search/engram
// filtering runs against this cache so it's instant (no re-fetch per keystroke).
let activityEvents: OpLogEvent[] = [];
let activityFiltered: OpLogEvent[] = []; // last filtered set
type ActivityCat = 'all' | 'ingested' | 'nodes' | 'edits' | 'edges' | 'merged' | 'forgotten';
let activityCat: ActivityCat = 'all';
// op → friendly category. Granular: ingests, nodes, edits, edges, merges,
// forgets. Drives both the chips and their count badges.
const ACTIVITY_CAT_OPS: Record<Exclude<ActivityCat, 'all'>, OpLogEvent['op'][]> = {
  ingested: ['ingestSource'],
  nodes: ['addNode', 'deleteNode'],
  edits: ['editNode', 'supersede'],
  edges: ['addEdge', 'deleteEdge'],
  merged: ['merge'],
  forgotten: ['forgetSource'],
};
const ACTIVITY_CAT_LABELS: Record<ActivityCat, string> = {
  all: 'All', ingested: 'Ingested', nodes: 'Nodes', edits: 'Edits',
  edges: 'Edges', merged: 'Merged', forgotten: 'Forgotten',
};
function activityCatOf(op: OpLogEvent['op']): Exclude<ActivityCat, 'all'> | null {
  for (const cat of Object.keys(ACTIVITY_CAT_OPS) as Array<Exclude<ActivityCat, 'all'>>) {
    if (ACTIVITY_CAT_OPS[cat].includes(op)) return cat;
  }
  return null;
}

/** Fill the engram scope dropdown from ALL loaded engrams (not just those that
 *  happen to appear in the recent-events window), preserving the selection. */
function populateActivityEngramSelect(): void {
  const prev = els.activityEngramSelect.value;
  const graphs = getLoadedGraphs().filter((g) => !g.metadata.archived);
  const ids = graphs.map((g) => g.graphId)
    .sort((a, b) => app().engramName(a).localeCompare(app().engramName(b)));
  els.activityEngramSelect.innerHTML =
    '<option value="">All engrams</option>' +
    ids.map((id) => `<option value="${escape(id)}">${escape(app().engramName(id))}</option>`).join('');
  if (prev && ids.includes(prev)) els.activityEngramSelect.value = prev;
}

/** Fill the "who" dropdown from the distinct actors present in the loaded
 *  events (You, Autonomous brain, Claude Code / other AI clients, App…),
 *  preserving the current selection. */
// Distinct actor labels are computed SERVER-SIDE across the full op-log scope
// (activity.list returns `actors`), so the dropdown is always complete — no
// dependence on which events happen to be in the recent-N window.
let activityServerActors: string[] = [];
let activityWarnings: string[] = [];
/** Last successful op-log compaction — from activity.list or live event. */
let lastCompactionRecord: OplogCompactionRecord | null = null;

export function notifyOplogCompaction(record: OplogCompactionRecord): void {
  lastCompactionRecord = record;
  if (activityCat === 'all' && !activityDateRangeActive()) {
    applyActivityFilter();
  }
}

function setLastCompactionFromServer(record: OplogCompactionRecord | null | undefined): void {
  if (record) lastCompactionRecord = record;
}
function populateActivityActorSelect(): void {
  const prev = els.activityActorSelect.value;
  els.activityActorSelect.innerHTML =
    '<option value="">Anyone</option>' +
    activityServerActors.map((l) => `<option value="${escape(l)}">${escape(l)}</option>`).join('');
  // Keep the current selection even if it's not in the latest set (e.g. it's
  // the active filter and the server excluded it from `actors`); re-add it.
  if (prev) {
    if (!activityServerActors.includes(prev)) {
      els.activityActorSelect.insertAdjacentHTML('beforeend', `<option value="${escape(prev)}">${escape(prev)}</option>`);
    }
    els.activityActorSelect.value = prev;
  }
}

/** Category is server-filtered (via `ops`); engram + text query run client-side. */
export function applyActivityFilter(): void {
  const engram = els.activityEngramSelect.value;
  const query = els.activitySearch.value.trim().toLowerCase();
  const matchesText = (e: OpLogEvent): boolean => {
    if (!query) return true;
    const hay = `${e.op} ${e.graphId} ${app().engramName(e.graphId)} ${activityLabel(e).replace(/<[^>]+>/g, '')} ${activityDetail(e).replace(/<[^>]+>/g, '')}`.toLowerCase();
    return hay.includes(query);
  };
  els.activityChips.querySelectorAll<HTMLButtonElement>('.g-activity-chip').forEach((chip) => {
    const cat = (chip.dataset.cat ?? 'all') as ActivityCat;
    chip.classList.toggle('active', cat === activityCat);
    chip.textContent = ACTIVITY_CAT_LABELS[cat];
  });
  const rangeActive = activityDateRangeActive();
  els.activityDateClear.classList.toggle('hidden', !rangeActive);
  activityFiltered = activityEvents
    .filter((e) => (!engram || e.graphId === engram) && matchesText(e))
    .slice().sort((a, b) => b.ts - a.ts);
  renderActivity();
}

const activityDayLabel = (ts: number): string => {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};
const activityTime = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Who/what triggered an op — derived from the scattered provenance fields
 *  (addedBy / correctedBy MCP client, triggeredBy user:/brain:/ipc:, edge reason). */
function activityActor(e: OpLogEvent): { label: string; cls: string } {
  // Prefer the server-computed actor (activity.list attaches it) so labels match
  // the dropdown + filter exactly; fall back to client classification otherwise.
  if (e.actor) return { label: e.actor, cls: e.actorCls ?? 'app' };
  const a = (e.after ?? {}) as Record<string, unknown>;
  const b = (e.before ?? {}) as Record<string, unknown>;
  const client = (a['addedBy'] ?? a['correctedBy']) as string | undefined;
  if (client) return { label: app().friendlyClient(client), cls: 'ai' };
  const trig = ((a['triggeredBy'] ?? b['triggeredBy']) as string | undefined) ?? '';
  const reason = ((a['reason'] ?? b['reason']) as string | undefined) ?? '';
  if (trig.startsWith('user:')) return { label: 'You', cls: 'user' };
  if (trig.startsWith('brain:') || /\bbrain:|auto-relink|auto-link/i.test(reason)) return { label: 'Autonomous brain', cls: 'brain' };
  if (/user-confirmed/i.test(reason)) return { label: 'You', cls: 'user' };
  if (trig.startsWith('ipc:')) return { label: 'App', cls: 'app' };
  return { label: 'System', cls: 'app' };
}

/** Grouping key: identical events (same op, engram, actor, detail) collapse. */
function activitySig(e: OpLogEvent): string {
  // Use the grouping-stable detail (omits per-node addNode content) so 350
  // identical "Added a memory node" events still collapse into one ×350 group.
  return `${e.op}|${e.graphId}|${activityActor(e).label}|${activityDetail(e, { forGrouping: true }).replace(/<[^>]+>/g, '')}`;
}

function actorBadge(a: { label: string; cls: string }): string {
  // Presentation Mode: external identities redact — connectors follow the
  // connectors surface, AI clients the mcpClients surface. "You" / "Autonomous
  // brain" / "App" / "System" are generic and stay visible.
  const tag = a.label.startsWith('connector:') ? 'surface:connectors'
    : a.cls === 'ai' ? 'surface:mcpClients' : '';
  const attr = tag ? ` data-pres="${tag}"` : '';
  return `<span class="activity-actor actor-${a.cls}" title="Who made this change"${attr}>${escape(a.label)}</span>`;
}

/** Translate the internal reason/trigger codes into plain language an auditor
 *  can read. The parenthetical in auto-relink reasons IS the shared entity. */
function humanizeReason(reason: string): string {
  const r = reason.toLowerCase();
  const paren = reason.match(/\(([^)]+)\)/)?.[1];
  if (r.includes('consolidation-cleanup')) return 'removed a redundant connection during consolidation';
  if (r.includes('transitive-inference')) return 'inferred from a chain of related memories';
  // NOTE: the SDK's "same-person" heuristic flags any capitalised entity (e.g.
  // "Remote Access", "2026"), so don't assert it's a person — just say both
  // memories reference it. The SAME-PERSON badge already conveys the edge type.
  if (r.startsWith('auto-relink: same-person')) return paren ? `both reference ${paren}` : 'both reference the same entity';
  if (r.startsWith('auto-relink: shares-entity')) return paren ? `both mention ${paren}` : 'both mention the same entity';
  if (r.startsWith('auto-relink')) return paren ? `shared reference — ${paren}` : 'shared reference';
  if (r.startsWith('auto-link')) { const m = reason.match(/(\d+%)/); return m ? `semantically similar (${m[1]})` : 'semantically similar'; }
  if (r.includes('reinforcement')) return 'confidence reinforced by repeated recall';
  if (r.includes('user-confirmed')) return 'you confirmed this connection';
  if (r.startsWith('user:')) return 'you · ' + reason.slice(5);
  if (r.startsWith('brain:')) return 'autonomous brain · ' + reason.slice(6);
  if (r.startsWith('ipc:')) return 'app · ' + reason.slice(4);
  return reason;
}

/** Best-effort node-id → content preview, from the engrams currently loaded in
 *  memory. Rebuilt per render. Cross-engram / unvisited engrams won't resolve
 *  client-side — full coverage needs sidecar enrichment (see the audit plan). */
let _activityNodePreviews = new Map<string, string>();
function rebuildActivityNodePreviews(): void {
  _activityNodePreviews = new Map();
  for (const nodes of app().getGraphnosisGlobalNodes().values()) for (const n of nodes) if (n.contentPreview) _activityNodePreviews.set(n.id, n.contentPreview);
  for (const n of app().getGraphnosisAllNodes()) if (n.contentPreview) _activityNodePreviews.set(n.id, n.contentPreview);
}
function nodePreview(id: string): string | null {
  const p = _activityNodePreviews.get(id);
  return p && p.trim() ? p.trim() : null;
}

function maintenanceRowVisible(record: OplogCompactionRecord): boolean {
  if (activityCat !== 'all') return false;
  if (els.activityEngramSelect.value) return false;
  if (els.activitySearch.value.trim()) return false;
  if (els.activityActorSelect.value && els.activityActorSelect.value !== 'System') return false;
  const bounds = activityDateBounds();
  if (bounds.since !== undefined && record.at <= bounds.since) return false;
  if (bounds.until !== undefined && record.at > bounds.until) return false;
  return true;
}

function renderMaintenanceRow(record: OplogCompactionRecord): string {
  const n = record.eventsRemoved;
  const eventWord = n === 1 ? 'event' : 'events';
  const sizeNote = record.bytesBefore && record.bytesAfter && record.bytesBefore > record.bytesAfter
    ? ` · ${formatCompactionBytes(record.bytesBefore)} → ${formatCompactionBytes(record.bytesAfter)}`
    : '';
  const detail = `Archived ${n.toLocaleString()} older ${eventWord} from the encrypted audit log${sizeNote}`;
  return `<div class="activity-row activity-row-maintenance">
    <span class="ar-when">${escape(activityTime(record.at))}</span>
    <span class="ar-dot maintenance"></span>
    <div>
      <div>Cortex maintenance: compacted audit log ${actorBadge({ label: 'System', cls: 'app' })}</div>
      <div class="ar-detail">${escape(detail)}</div>
    </div>
  </div>`;
}

function formatCompactionBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function renderActivity(): void {
  rebuildActivityNodePreviews(); // for resolving node ids → content in rows
  const total = activityEvents.length;
  const all = activityFiltered;

  if (all.length === 0) {
    const maintenanceHtml = lastCompactionRecord && maintenanceRowVisible(lastCompactionRecord)
      ? `<p class="activity-day-divider">${escape(activityDayLabel(lastCompactionRecord.at))}</p>` +
        renderMaintenanceRow(lastCompactionRecord)
      : '';
    if (els.activityStats) els.activityStats.textContent = `0 of ${total} loaded event${total === 1 ? '' : 's'}`;
    const notice = activityWarnings.length > 0
      ? `<p class="subtitle activity-sync-notice">${escape(activityWarnings[0])}</p>`
      : '';
    const empty = total === 0 && activityWarnings.length > 0
      ? '<p class="subtitle">No activity loaded yet.</p>'
      : '<p class="subtitle">No events match these filters.</p>';
    els.activityList.innerHTML = notice + maintenanceHtml + empty;
    return;
  }

  // Group by day, then collapse identical events (same op · ENGRAM · actor ·
  // detail) within each day. The engram is part of the signature, so groups
  // never merge across engrams. Count top-level items to drive auto-load.
  const byDay = new Map<string, OpLogEvent[]>();
  for (const e of all) {
    const k = activityDayLabel(e.ts);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(e);
  }

  let html = '';
  let topLevelItems = 0;
  if (lastCompactionRecord && maintenanceRowVisible(lastCompactionRecord)) {
    html += `<p class="activity-day-divider">${escape(activityDayLabel(lastCompactionRecord.at))}</p>`;
    html += renderMaintenanceRow(lastCompactionRecord);
    topLevelItems++;
  }
  for (const [day, dayEvents] of byDay) {
    html += `<p class="activity-day-divider">${escape(day)}</p>`;
    const groups = new Map<string, OpLogEvent[]>();
    const order: string[] = [];
    for (const e of dayEvents) {
      const sig = activitySig(e);
      if (!groups.has(sig)) { groups.set(sig, []); order.push(sig); }
      groups.get(sig)!.push(e);
    }
    for (const sig of order) {
      const evs = groups.get(sig)!;
      html += evs.length > 1 ? renderActivityGroup(evs) : renderActivityRow(evs[0]);
      topLevelItems++;
    }
  }

  const scope = activityCat === 'all' ? '' : ` · ${ACTIVITY_CAT_LABELS[activityCat]} only`;
  if (els.activityStats) {
    els.activityStats.textContent = `${topLevelItems} group${topLevelItems === 1 ? '' : 's'} · ${all.length} event${all.length === 1 ? '' : 's'} loaded${scope}`;
  }

  if (activityWarnings.length > 0) {
    html = `<p class="subtitle activity-sync-notice">${escape(activityWarnings[0])}</p>` + html;
  }

  if (activityHasMore) {
    html += `<button id="activity-load-more" class="activity-load-more" type="button">↓ Load more…</button>`;
  }
  els.activityList.innerHTML = html;

  els.activityList.querySelectorAll<HTMLButtonElement>('.activity-group-head').forEach((h) => {
    h.addEventListener('click', () => h.closest('.activity-group')?.classList.toggle('open'));
  });
}

function renderActivityRow(e: OpLogEvent): string {
  const detail = activityDetail(e);
  return `<div class="activity-row">
    <span class="ar-when">${escape(activityTime(e.ts))}</span>
    <span class="ar-dot ${e.op}"></span>
    <div>
      <div>${activityLabel(e)} ${actorBadge(activityActor(e))}</div>
      ${detail ? `<div class="ar-detail" data-pres="node:${escape(e.target.id)}" data-pres-engram="${escape(e.graphId)}"${presSourceAttr(e.target.kind === 'source' ? e.target.id : e.targetSourceId)}>${detail}</div>` : ''}
    </div>
  </div>`;
}

/** Collapsed-by-default box for N identical same-day events. */
/** Per-event descriptor for an expanded subrow — the specific thing each
 *  (otherwise-identical) event touched: the source filename, the corrected
 *  content, the edge endpoints + type, etc. Falls back to the target id. */
function activitySubrowDesc(e: OpLogEvent): string {
  const a = (e.after ?? {}) as Record<string, unknown>;
  const b = (e.before ?? {}) as Record<string, unknown>;
  const clip = (s: string, n: number): string => escape(s.length > n ? s.slice(0, n) + '…' : s);
  if (e.op === 'ingestSource') {
    const ref = a['ref'] as string | undefined;
    return ref ? `<span class="ar-sub-name">${clip(ref, 110)}</span>` : `<code>${escape(e.target.id.slice(0, 16))}…</code>`;
  }
  if (e.op === 'forgetSource') {
    const ref = (b['ref'] ?? a['ref']) as string | undefined;
    return ref ? `<span class="ar-sub-name">${clip(ref, 110)}</span>` : `<code>${escape(e.target.id.slice(0, 16))}…</code>`;
  }
  // Resolve a node id → content preview. Prefer the server-side `resolved`
  // block (works for ANY engram), then the client-side cache (only the open
  // engram), then fall back to the truncated id.
  const nodeRef = (id: string | undefined, max = 70, resolved?: string): string => {
    const p = resolved ?? (id ? nodePreview(id) : undefined);
    if (p) return `<span class="ar-sub-name">“${clip(p, max)}”</span>`;
    return id ? `<code>${escape(id.slice(0, 12))}…</code>` : '';
  };
  if (e.op === 'addNode') {
    return nodeRef(e.target.id, 120, e.resolved?.target);
  }
  if (e.op === 'editNode' || e.op === 'supersede') {
    const content = (a['content'] as string | undefined) ?? e.resolved?.target ?? nodePreview(e.target.id) ?? undefined;
    if (content) return `<span class="ar-sub-name">“${clip(content, 140)}”</span>`;
    const reason = a['reason'] as string | undefined;
    if (reason) return `<span class="ar-why">${escape(humanizeReason(reason))}</span>`;
  }
  if (e.op === 'deleteNode') {
    const preview = (b['preview'] as string | undefined) ?? e.resolved?.target ?? nodePreview(e.target.id) ?? undefined;
    if (preview) return `<span class="ar-sub-name">was: “${clip(preview, 130)}”</span>`;
    const reason = a['reason'] as string | undefined;
    if (reason) return `<span class="ar-why">${escape(humanizeReason(reason))}</span>`;
  }
  if (e.op === 'addEdge' || e.op === 'deleteEdge') {
    const type = a['type'] as string | undefined;
    const from = a['fromNodeId'] as string | undefined;
    const to = a['toNodeId'] as string | undefined;
    const reason = a['reason'] as string | undefined;
    const parts: string[] = [];
    if (type) parts.push(`<span class="ar-kind">${escape(type)}</span>`);
    if (from && to) parts.push(`${nodeRef(from, 46, e.resolved?.from)} → ${nodeRef(to, 46, e.resolved?.to)}`);
    if (reason) parts.push(`<span class="ar-why">${escape(humanizeReason(reason))}</span>`);
    if (parts.length) return parts.join(' · ');
  }
  return `<code>${escape(e.target.id.slice(0, 18))}…</code>`;
}

/** Full (untruncated) plain-text descriptor for a subrow's hover tooltip. */
function activitySubrowTitle(e: OpLogEvent): string {
  const a = (e.after ?? {}) as Record<string, unknown>;
  const full = (id: string | undefined, resolved?: string): string => resolved ?? (id ? (nodePreview(id) ?? id) : '');
  if (e.op === 'addEdge' || e.op === 'deleteEdge') {
    const from = full(a['fromNodeId'] as string | undefined, e.resolved?.from);
    const to = full(a['toNodeId'] as string | undefined, e.resolved?.to);
    const reason = a['reason'] as string | undefined;
    return `From: ${from}\nTo: ${to}${reason ? `\nWhy: ${humanizeReason(reason)}` : ''}`;
  }
  if (e.op === 'ingestSource' || e.op === 'forgetSource') {
    const ref = (a['ref'] ?? (e.before as Record<string, unknown> | undefined)?.['ref']) as string | undefined;
    return ref ?? e.target.id;
  }
  return full(e.target.id, e.resolved?.target) || e.target.id;
}

function renderActivityGroup(evs: OpLogEvent[]): string {
  const e = evs[0];
  // Group head uses the grouping-stable detail (reason/confidence only) since
  // the N events differ in per-item content — that lives in the subrows.
  const detail = activityDetail(e, { forGrouping: true });
  const last = activityTime(evs[0].ts);
  const first = activityTime(evs[evs.length - 1].ts);
  const range = first === last ? last : `${first}–${last}`;
  const children = evs.map((x) => `<div class="activity-subrow" title="${escape(activitySubrowTitle(x))}"><span class="ar-when">${escape(activityTime(x.ts))}</span><span class="activity-subrow-desc" data-pres="node:${escape(x.target.id)}" data-pres-engram="${escape(x.graphId)}"${presSourceAttr(x.target.kind === 'source' ? x.target.id : x.targetSourceId)}>${activitySubrowDesc(x)}</span></div>`).join('');
  return `<div class="activity-group">
    <button class="activity-group-head" type="button">
      <span class="ar-when">${escape(range)}</span>
      <span class="ar-dot ${e.op}"></span>
      <div class="activity-group-main">
        <div>${activityLabel(e)} ${actorBadge(activityActor(e))} <span class="activity-group-count">×${evs.length}</span></div>
        <div class="ar-detail">${evs.length} identical events${detail ? ` · <span data-pres="node:${escape(e.target.id)}" data-pres-engram="${escape(e.graphId)}"${presSourceAttr(e.target.kind === 'source' ? e.target.id : e.targetSourceId)}>${detail}</span>` : ''} — tap to expand</div>
      </div>
      <span class="activity-group-chevron" aria-hidden="true">▾</span>
    </button>
    <div class="activity-group-children">${children}</div>
  </div>`;
}

function activityLabel(e: OpLogEvent): string {
  // Show the friendly engram name, not the raw slug. Fall back to the slug
  // only if the engram isn't loaded (engramName handles that).
  const inEngram = ` in <span class="ar-engram" data-pres="engram:${escape(e.graphId)}">${escape(app().engramName(e.graphId))}</span>`;
  const a = (e.after ?? {}) as Record<string, unknown>;
  switch (e.op) {
    case 'ingestSource': {
      const ref = typeof a['ref'] === 'string' ? a['ref'] as string : 'source';
      const file = ref.split('/').pop() ?? ref;
      const count = Array.isArray(a['nodeIds']) ? (a['nodeIds'] as unknown[]).length : 0;
      const kind = typeof a['kind'] === 'string' ? ` <span class="ar-kind">${escape(a['kind'] as string)}</span>` : '';
      return `Ingested <strong data-pres="source:${escape(e.target.id)}" data-pres-engram="${escape(e.graphId)}">${escape(file)}</strong>${kind} <span class="ar-quiet">+${count} node${count === 1 ? '' : 's'}</span>${inEngram}`;
    }
    case 'forgetSource': {
      const ref = typeof a['ref'] === 'string' ? (a['ref'] as string) : ((e.before as Record<string, unknown> | undefined)?.['ref'] as string | undefined);
      const nc = (e.before as Record<string, unknown> | undefined)?.['nodeCount'];
      const file = ref ? (ref.split('/').pop() ?? ref) : `${e.target.id.slice(0, 12)}…`;
      return `Forgot source <strong data-pres="source:${escape(e.target.id)}" data-pres-engram="${escape(e.graphId)}">${escape(file)}</strong>${typeof nc === 'number' ? ` <span class="ar-quiet">(${nc} node${nc === 1 ? '' : 's'})</span>` : ''}${inEngram}`;
    }
    case 'editNode':   return `Corrected a memory${inEngram}`;
    case 'supersede':  return `Replaced a memory with a corrected version${inEngram}`;
    case 'addNode':    return `Added a memory node${inEngram}`;
    case 'deleteNode': return `Soft-deleted a memory${inEngram}`;
    case 'addEdge': {
      const t = typeof a['type'] === 'string' ? ` <span class="ar-kind">${escape(a['type'] as string)}</span>` : '';
      return `Linked two memories${t}${inEngram}`;
    }
    case 'deleteEdge': return `Unlinked two memories${inEngram}`;
    case 'merge':      return `Merged duplicate memories${inEngram}`;
    default:           return `${escape(e.op)}${inEngram}`;
  }
}

/** The "why / what changed" line — pulled from the op's before/after payload. */
function activityDetail(e: OpLogEvent, opts?: { forGrouping?: boolean }): string {
  const a = (e.after ?? {}) as Record<string, unknown>;
  const b = (e.before ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  const reason = (a['reason'] ?? b['reason']) as string | undefined;
  if (reason) bits.push(`<span class="ar-why">${escape(humanizeReason(reason))}</span>`);
  // Per-item content (the specific node touched) is omitted in `forGrouping`
  // mode so N events with different content still collapse into one ×N group;
  // the expanded subrows (activitySubrowDesc) carry each item's content. It's
  // shown on single (ungrouped) rows and on every subrow.
  if (!opts?.forGrouping) {
    const content = (a['content'] as string | undefined) ?? (e.op === 'editNode' || e.op === 'supersede' ? e.resolved?.target : undefined);
    if (content && (e.op === 'editNode' || e.op === 'supersede')) {
      bits.push(`“${escape(content.slice(0, 120))}${content.length > 120 ? '…' : ''}”`);
    }
    const preview = (b['preview'] as string | undefined) ?? (e.op === 'deleteNode' ? e.resolved?.target : undefined);
    if (preview && (e.op === 'deleteNode' || e.op === 'forgetSource')) {
      bits.push(`was: “${escape(preview.slice(0, 100))}${preview.length > 100 ? '…' : ''}”`);
    }
    if (e.op === 'addNode' && e.resolved?.target) {
      bits.push(`“${escape(e.resolved.target.slice(0, 120))}${e.resolved.target.length > 120 ? '…' : ''}”`);
    }
  }
  if (typeof a['confidence'] === 'number') bits.push(`confidence → ${(a['confidence'] as number).toFixed(2)}`);
  return bits.join(' · ');
}

function wireActivityEvents(): void {
// Retry + load-more survive innerHTML rebuilds (delegated on the list container).
els.activityList.addEventListener('click', (e) => {
  const retry = (e.target as HTMLElement).closest<HTMLButtonElement>('#btn-activity-retry');
  if (retry) {
    e.preventDefault();
    if (activityLoading) return;
    activityNextCursor = undefined;
    retry.disabled = true;
    retry.textContent = 'Retrying…';
    void refreshActivityView({ showLoading: true });
    return;
  }
  const loadMore = (e.target as HTMLElement).closest<HTMLButtonElement>('#activity-load-more');
  if (loadMore) {
    loadMore.innerHTML = '<span class="activity-spinner"></span> Loading…';
    loadMore.disabled = true;
    loadMoreActivity();
  }
});
// Category chips → filter the cached events (no re-fetch).
els.activityChips.addEventListener('click', (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLButtonElement>('.g-activity-chip');
  if (!chip) return;
  activityCat = (chip.dataset.cat ?? 'all') as ActivityCat;
  activityNextCursor = undefined;
  void refreshActivityView();
});
// Text filter + engram scope → also re-filter the cache live.
let activitySearchTimer: number | null = null;
els.activitySearch.addEventListener('input', () => {
  if (activitySearchTimer !== null) clearTimeout(activitySearchTimer);
  activitySearchTimer = window.setTimeout(() => applyActivityFilter(), 120);
});
els.activityEngramSelect.addEventListener('change', () => applyActivityFilter());
els.activityActorSelect.addEventListener('change', () => { activityNextCursor = undefined; void refreshActivityView(); });
// Date/hour range → server since/until bounds — re-fetch from the op-log.
els.activityDateFrom.addEventListener('change', () => { activityNextCursor = undefined; void refreshActivityView(); });
els.activityDateTo.addEventListener('change', () => { activityNextCursor = undefined; void refreshActivityView(); });
els.activityHourFrom.addEventListener('change', () => { activityNextCursor = undefined; void refreshActivityView(); });
els.activityHourTo.addEventListener('change', () => { activityNextCursor = undefined; void refreshActivityView(); });
els.activityDateClear.addEventListener('click', () => {
  els.activityDateFrom.value = '';
  els.activityDateTo.value = '';
  els.activityHourFrom.value = '';
  els.activityHourTo.value = '';
  activityRangeInitialized = false;
  activityNextCursor = undefined;
  void refreshActivityView();
});
// Refresh re-fetches from the sidecar (picks up new events).
els.btnActivityRefresh.addEventListener('click', () => void refreshActivityView());
}

