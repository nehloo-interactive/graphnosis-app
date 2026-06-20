/**
 * Skill runs Activity — supervisor run ledger segment (Settings → Activity pane).
 */
import { ipcCallTimeout } from './ipc';
import { escape } from './util';

let els!: Record<string, HTMLElement>;

export interface SkillRunListItem {
  runId: string;
  skillGraphId: string;
  skillSourceId: string;
  planTitle?: string;
  completedStepIndex: number;
  status: 'running' | 'paused' | 'blocked-on-human' | 'complete' | 'failed';
  actorId?: string;
  actorLabel?: string;
  stepLogCount: number;
  capturedVarKeys: string[];
  redactedVars: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

const IPC_TIMEOUT_MS = 60_000;
let runs: SkillRunListItem[] = [];
let statusFilter = '';

const STATUS_LABELS: Record<SkillRunListItem['status'], string> = {
  running: 'Running',
  paused: 'Paused',
  'blocked-on-human': 'Blocked',
  complete: 'Complete',
  failed: 'Failed',
};

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function skillLabel(r: SkillRunListItem): string {
  return r.planTitle || r.skillSourceId.replace(/^skill:/, '').slice(0, 48);
}

function renderRunRow(r: SkillRunListItem): string {
  const st = r.status;
  const dotCls = st === 'complete' ? 'ingestSource'
    : st === 'failed' ? 'forgetSource'
      : st === 'blocked-on-human' ? 'supersede'
        : st === 'paused' ? 'editNode'
          : 'addNode';
  const varsPreview = r.capturedVarKeys.length
    ? r.capturedVarKeys.slice(0, 4).join(', ') + (r.capturedVarKeys.length > 4 ? '…' : '')
    : 'no vars';
  const actor = r.actorLabel ? escape(r.actorLabel) : '—';
  return `<div class="activity-row" data-run-id="${escape(r.runId)}">
    <span class="ar-when">${escape(formatWhen(r.updatedAt))}</span>
    <span class="ar-dot ${dotCls}"></span>
    <div class="ar-detail">
      <div><strong>${escape(skillLabel(r))}</strong>
        <span class="activity-actor actor-ai">${escape(STATUS_LABELS[st])}</span>
        <span class="activity-actor actor-user">${actor}</span></div>
      <div class="subtitle" style="font-size:12px;margin-top:2px;">
        Step ${r.completedStepIndex} · run <code>${escape(r.runId.slice(0, 8))}</code>
        · ${escape(r.skillGraphId)} · vars: ${escape(varsPreview)}
        ${r.stepLogCount ? ` · ${r.stepLogCount} step log` : ''}
      </div>
    </div>
  </div>`;
}

function applyFilter(): SkillRunListItem[] {
  if (!statusFilter) return runs;
  return runs.filter((r) => r.status === statusFilter);
}

export function initSkillRunsActivity(skillEls: Record<string, HTMLElement>): void {
  els = skillEls;
  const refreshBtn = document.getElementById('btn-skill-runs-refresh');
  const filter = document.getElementById('skill-runs-status-filter') as HTMLSelectElement | null;
  refreshBtn?.addEventListener('click', () => { void refreshSkillRunsSegment(); });
  filter?.addEventListener('change', () => {
    statusFilter = filter.value;
    renderSkillRunsList();
  });
}

export async function refreshSkillRunsSegment(): Promise<void> {
  const list = els.skillRunsList;
  if (!list) return;
  list.innerHTML = '<p class="subtitle">Loading skill runs…</p>';
  try {
    const data = await ipcCallTimeout<{ ok: boolean; runs: SkillRunListItem[]; total: number }>(
      'skill:listRuns',
      { limit: 200 },
      IPC_TIMEOUT_MS,
    );
    runs = data.runs ?? [];
    const stats = els.skillRunsStats;
    if (stats) {
      const blocked = runs.filter((r) => r.status === 'blocked-on-human').length;
      const active = runs.filter((r) => r.status === 'running' || r.status === 'paused').length;
      stats.textContent = `${data.total ?? runs.length} runs · ${active} active · ${blocked} blocked on human`;
    }
    renderSkillRunsList();
  } catch (e) {
    list.innerHTML = `<p class="subtitle">Could not load skill runs: ${escape(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

function renderSkillRunsList(): void {
  const list = els.skillRunsList;
  if (!list) return;
  const filtered = applyFilter();
  if (!filtered.length) {
    list.innerHTML = '<p class="subtitle">No skill runs yet. Pro clients can persist multi-step playbook progress via <code>save_skill_run</code>.</p>';
    return;
  }
  list.innerHTML = filtered.map(renderRunRow).join('');
}

/** Blocked/paused runs for Ghampus sidebar badge. */
export async function fetchAttentionSkillRuns(): Promise<SkillRunListItem[]> {
  try {
    const data = await ipcCallTimeout<{ ok: boolean; runs: SkillRunListItem[] }>(
      'skill:listRuns',
      { limit: 50 },
      IPC_TIMEOUT_MS,
    );
    return (data.runs ?? []).filter((r) =>
      r.status === 'blocked-on-human' || r.status === 'paused',
    );
  } catch {
    return [];
  }
}
