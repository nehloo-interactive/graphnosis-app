/**
 * Unattended runs — the review + undo surface for the true L3 executor (#40).
 *
 * SAFETY-CRITICAL surface: lists every run the unattended executor performed
 * with no human, expandable into a per-action step trace, with per-run and
 * per-step Undo (enabled only when the action is reversible) and a standing
 * enabled/disabled banner whose toggle is an in-UI kill switch.
 *
 * Modeled on skill-runs-activity.ts (DOM-string render, ipcCallTimeout, status
 * dots, refresh button) so the two ledgers read consistently.
 */
import { ipcCallTimeout } from './ipc';
import { escape } from './util';

let els: Record<string, HTMLElement> = {};

type RunStatus = 'running' | 'complete' | 'failed' | 'aborted';

interface RunHeader {
  runId: string;
  skillSourceId: string;
  skillGraphId: string;
  skillLabel: string;
  startedAt: number;
  trigger: { signalType: string; signalLabel: string; why: string };
  autonomyReason: string;
  status: RunStatus;
  endedAt?: number;
  note?: string;
}

interface UndoClassification {
  reversible: boolean;
  kind: 'supersede' | 'skill-edit' | 'forget' | 'none';
  undoToken?: string;
}

interface RunAction {
  runId: string;
  stepIndex: number;
  label: string;
  pickedModelDisplay: string | null;
  touched: { recalledEngrams: string[]; writtenNodeIds: string[]; mcpTools: string[] };
  outcome: 'ok' | 'error' | 'skipped' | 'refused';
  contradictionWarnings?: Array<{ nodeId: string; conflictsWith: string; severity: string }>;
  undo: UndoClassification;
  redactedPromptPreview: string;
  redactedOutputPreview: string;
  elapsedMs: number;
  ts: number;
  reverted?: boolean;
  /** Set when the reversible-only interlock refused to execute this action
   *  (outcome === 'refused'); the step did NOT run. */
  refusedReason?: string;
}

const IPC_TIMEOUT_MS = 60_000;
let runs: RunHeader[] = [];
const expanded = new Set<string>();
const traceCache = new Map<string, RunAction[]>();

const STATUS_LABELS: Record<RunStatus, string> = {
  running: 'Running',
  complete: 'Complete',
  failed: 'Failed',
  aborted: 'Aborted',
};

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function statusDot(st: RunStatus): string {
  return st === 'complete' ? 'ingestSource'
    : st === 'failed' ? 'forgetSource'
      : st === 'aborted' ? 'supersede'
        : 'addNode';
}

function renderActionRow(a: RunAction): string {
  const outcomeCls = a.outcome === 'error' || a.outcome === 'refused' ? 'forgetSource' : a.outcome === 'skipped' ? 'editNode' : 'ingestSource';
  const touched: string[] = [];
  if (a.touched.recalledEngrams.length) touched.push(`recalled ${a.touched.recalledEngrams.length}`);
  if (a.touched.writtenNodeIds.length) touched.push(`wrote ${a.touched.writtenNodeIds.length} node(s)`);
  if (a.touched.mcpTools.length) touched.push(`tools: ${a.touched.mcpTools.map(escape).join(', ')}`);
  const warn = a.contradictionWarnings?.length
    ? `<div class="subtitle" style="color:var(--warn,#c47);margin-top:2px;">⚠ ${a.contradictionWarnings.length} contradicted-memory warning(s)</div>`
    : '';
  const refused = a.outcome === 'refused'
    ? `<div class="subtitle" style="color:var(--warn,#c47);margin-top:2px;">⛔ refused (not executed)${a.refusedReason ? ` — ${escape(a.refusedReason)}` : ''}</div>`
    : '';
  const undoBtn = a.undo.reversible && a.undo.undoToken && a.undo.kind !== 'none' && !a.reverted
    ? `<button class="btn-sm" data-undo-step="${a.stepIndex}" title="Reverse this action (${escape(a.undo.kind)})">Undo</button>`
    : a.reverted
      ? '<span class="subtitle">reverted</span>'
      : '<span class="subtitle" title="Read/compute-only or irreversible — nothing to undo">—</span>';
  const model = a.pickedModelDisplay ? escape(a.pickedModelDisplay) : 'no model';
  return `<div class="activity-row" style="padding-left:20px;">
    <span class="ar-dot ${outcomeCls}"></span>
    <div class="ar-detail">
      <div><strong>Step ${a.stepIndex}</strong> ${escape(a.label)}
        <span class="activity-actor actor-ai">${escape(a.outcome)}</span></div>
      <div class="subtitle" style="font-size:12px;margin-top:2px;">
        ${model} · ${a.elapsedMs}ms${touched.length ? ' · ' + escape(touched.join(' · ')) : ''}
      </div>
      ${a.redactedOutputPreview ? `<div class="subtitle" style="font-size:11px;margin-top:2px;opacity:.8;">${escape(a.redactedOutputPreview)}</div>` : ''}
      ${refused}
      ${warn}
    </div>
    <div style="margin-left:auto;align-self:center;">${undoBtn}</div>
  </div>`;
}

function renderRunRow(r: RunHeader): string {
  const isOpen = expanded.has(r.runId);
  const undoable = r.status === 'complete' || r.status === 'failed';
  const trace = traceCache.get(r.runId);
  const traceHtml = isOpen
    ? (trace
        ? (trace.length ? trace.map(renderActionRow).join('') : '<p class="subtitle" style="padding-left:20px;">No actions recorded.</p>')
        : '<p class="subtitle" style="padding-left:20px;">Loading trace…</p>')
    : '';
  return `<div class="activity-row unattended-run-row" data-run-id="${escape(r.runId)}">
    <span class="ar-when">${escape(formatWhen(r.startedAt))}</span>
    <span class="ar-dot ${statusDot(r.status)}"></span>
    <div class="ar-detail" style="flex:1;">
      <div>
        <button class="btn-link unattended-expand" data-expand="${escape(r.runId)}" style="background:none;border:none;cursor:pointer;padding:0;font:inherit;color:inherit;">
          ${isOpen ? '▾' : '▸'} <strong>${escape(r.skillLabel)}</strong>
        </button>
        <span class="activity-actor actor-ai">${escape(STATUS_LABELS[r.status])}</span>
        <span class="activity-actor actor-user">Unattended</span>
      </div>
      <div class="subtitle" style="font-size:12px;margin-top:2px;">
        ${escape(r.trigger.signalLabel)} · <code>${escape(r.runId.slice(0, 8))}</code>
        ${r.note ? ` · ${escape(r.note)}` : ''}
      </div>
      ${traceHtml}
    </div>
    ${undoable ? `<div style="align-self:center;"><button class="btn-sm" data-undo-run="${escape(r.runId)}" title="Reverse every reversible action in this run">Undo run</button></div>` : ''}
  </div>`;
}

function renderBanner(status: { enabled: boolean; runsLastHour: number; blockedCount: number }): string {
  const cls = status.enabled ? 'unattended-banner-on' : 'unattended-banner-off';
  const stateLabel = status.enabled
    ? `<strong style="color:var(--warn,#c47);">UNATTENDED EXECUTION ON</strong> — skills can run with no human`
    : '<strong>Unattended execution OFF</strong> — auto-eligible skills are only surfaced (default)';
  const toggle = status.enabled
    ? '<button class="btn-sm" id="unattended-disable" title="Kill switch — stop all unattended runs now">Disable now</button>'
    : '<button class="btn-sm" id="unattended-enable" title="Opt in to unattended execution (interlocks still apply)">Enable</button>';
  return `<div class="unattended-banner ${cls}">
    <div>${stateLabel}
      <span class="subtitle"> · ${status.runsLastHour} run(s) last hour · ${status.blockedCount} refused</span>
    </div>
    <div>${toggle}</div>
  </div>`;
}

export function initUnattendedRuns(unattendedEls: Record<string, HTMLElement>): void {
  els = unattendedEls;
  const refreshBtn = document.getElementById('btn-unattended-refresh');
  refreshBtn?.addEventListener('click', () => { void refreshUnattendedSegment(); });

  // Event delegation on the list for expand / undo / banner toggle.
  const list = els.unattendedList;
  list?.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const expandId = t.closest<HTMLElement>('[data-expand]')?.dataset.expand;
    if (expandId) { void toggleExpand(expandId); return; }
    const undoRun = t.closest<HTMLElement>('[data-undo-run]')?.dataset.undoRun;
    if (undoRun) { void undoRunOrStep(undoRun); return; }
    const undoStep = t.closest<HTMLElement>('[data-undo-step]')?.dataset.undoStep;
    if (undoStep) {
      const runId = t.closest<HTMLElement>('.unattended-run-row')?.dataset.runId;
      if (runId) void undoRunOrStep(runId, Number(undoStep));
    }
  });
}

async function toggleExpand(runId: string): Promise<void> {
  if (expanded.has(runId)) {
    expanded.delete(runId);
    renderList();
    return;
  }
  expanded.add(runId);
  renderList(); // show "Loading trace…"
  try {
    const data = await ipcCallTimeout<{ ok: boolean; actions: RunAction[] }>(
      'unattended:getTrace', { runId }, IPC_TIMEOUT_MS,
    );
    traceCache.set(runId, data.actions ?? []);
  } catch {
    traceCache.set(runId, []);
  }
  renderList();
}

async function undoRunOrStep(runId: string, stepIndex?: number): Promise<void> {
  try {
    await ipcCallTimeout<{ ok: boolean; reverted?: number; reason?: string }>(
      'unattended:undo',
      stepIndex === undefined ? { runId } : { runId, stepIndex },
      IPC_TIMEOUT_MS,
    );
  } catch { /* surfaced on refresh */ }
  traceCache.delete(runId);
  await refreshUnattendedSegment();
}

async function setEnabled(enabled: boolean): Promise<void> {
  try {
    await ipcCallTimeout<{ ok: boolean }>('unattended:setEnabled', { enabled }, IPC_TIMEOUT_MS);
  } catch { /* surfaced on refresh */ }
  await refreshUnattendedSegment();
}

export async function refreshUnattendedSegment(): Promise<void> {
  const list = els.unattendedList;
  if (!list) return;
  // Banner first — the kill switch must be reachable even if listing fails.
  let bannerHtml = '';
  try {
    const status = await ipcCallTimeout<{ ok: boolean; enabled: boolean; runsLastHour: number; blockedCount: number }>(
      'unattended:status', {}, IPC_TIMEOUT_MS,
    );
    bannerHtml = renderBanner(status);
  } catch { bannerHtml = ''; }
  const banner = els.unattendedBanner;
  if (banner) {
    banner.innerHTML = bannerHtml;
    banner.querySelector('#unattended-disable')?.addEventListener('click', () => { void setEnabled(false); });
    banner.querySelector('#unattended-enable')?.addEventListener('click', () => { void setEnabled(true); });
  }
  try {
    const data = await ipcCallTimeout<{ ok: boolean; runs: RunHeader[]; total: number }>(
      'unattended:listRuns', { limit: 200 }, IPC_TIMEOUT_MS,
    );
    runs = data.runs ?? [];
    const stats = els.unattendedStats;
    if (stats) {
      const failed = runs.filter((r) => r.status === 'failed' || r.status === 'aborted').length;
      stats.textContent = `${runs.length} unattended run(s) · ${failed} failed/aborted`;
    }
    renderList();
  } catch (e) {
    list.innerHTML = `<p class="subtitle">Could not load unattended runs: ${escape(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

function renderList(): void {
  const list = els.unattendedList;
  if (!list) return;
  if (!runs.length) {
    list.innerHTML = '<p class="subtitle">No unattended runs yet. The executor is off by default — enable it in the banner above to let auto-eligible (L3, dispatch-safe, reversible, single-pass) skills run with no human.</p>';
    return;
  }
  list.innerHTML = runs.map(renderRunRow).join('');
}

/** Live-update hook — call from the desktop main on an 'unattended.run' broadcast. */
export function onUnattendedRunEvent(): void {
  void refreshUnattendedSegment();
}
