/**
 * Enterprise Compliance settings + Get Connected retention ops.
 */
import { app } from './app-context';
import { gAlert, gConfirm } from './dialogs';
import { ipcCall } from './ipc';
import { escape } from './util';
import { invalidateClassificationSchemaCache, labelColorStyle } from './classification-schema';

interface ComplianceGetResult {
  ok: boolean;
  enterprise: boolean;
  compliance: {
    enabled: boolean;
    defaultRetentionTtlMs?: number;
    defaultExportBeforePurge?: boolean;
    lastRetentionDryRunAt?: number;
  };
}

interface ClassificationLabelRow {
  id: string;
  displayName: string;
  color: string;
  internalTier: 'public' | 'personal' | 'sensitive';
  userAssignable?: boolean;
  enabled?: boolean;
  capOverrides?: { maxTokens?: number; maxNodes?: number };
}

interface ClassificationSchemaResult {
  ok: boolean;
  enterprise: boolean;
  schema: {
    enabled: boolean;
    labels: ClassificationLabelRow[];
    defaultEngramLabel?: string;
  };
}

const DEFAULT_LABELS: ClassificationLabelRow[] = [
  { id: 'green', displayName: 'Non-confidential', color: '#22c55e', internalTier: 'public', userAssignable: true, enabled: true },
  { id: 'yellow', displayName: 'Internal', color: '#eab308', internalTier: 'personal', userAssignable: true, enabled: true },
  { id: 'red', displayName: 'Restricted', color: '#ef4444', internalTier: 'sensitive', userAssignable: true, enabled: true },
];

let schemaDraft: ClassificationLabelRow[] = [...DEFAULT_LABELS];

function renderClassificationLabelEditor(labels: ClassificationLabelRow[]): void {
  const list = document.getElementById('compliance-label-list');
  if (!list) return;
  list.innerHTML = labels.map((l, idx) => {
    const swatch = labelColorStyle(l.color);
    return `<div class="panel" style="padding:10px;margin:0;" data-label-idx="${idx}">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
        <label style="font-size:12px;">ID<input class="cls-id" value="${escape(l.id)}" style="display:block;width:100%;margin-top:2px;" /></label>
        <label style="font-size:12px;">Display name<input class="cls-name" value="${escape(l.displayName)}" style="display:block;width:100%;margin-top:2px;" /></label>
        <label style="font-size:12px;">Color<input class="cls-color" value="${escape(l.color)}" style="display:block;width:100%;margin-top:2px;" /></label>
        <label style="font-size:12px;">Internal tier
          <select class="cls-tier" style="display:block;width:100%;margin-top:2px;">
            <option value="public" ${l.internalTier === 'public' ? 'selected' : ''}>public</option>
            <option value="personal" ${l.internalTier === 'personal' ? 'selected' : ''}>personal</option>
            <option value="sensitive" ${l.internalTier === 'sensitive' ? 'selected' : ''}>sensitive</option>
          </select>
        </label>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:12px;">
        <span style="width:12px;height:12px;border-radius:50%;background:${swatch};display:inline-block;" aria-hidden="true"></span>
        <label><input type="checkbox" class="cls-enabled" ${l.enabled !== false ? 'checked' : ''} /> Enabled in UI</label>
        <label><input type="checkbox" class="cls-assignable" ${l.userAssignable !== false ? 'checked' : ''} /> User assignable</label>
        <label>maxTokens <input class="cls-max-tokens" type="number" min="1" placeholder="tier default" value="${l.capOverrides?.maxTokens ?? ''}" style="width:80px;margin-left:4px;" /></label>
        <label>maxNodes <input class="cls-max-nodes" type="number" min="1" placeholder="tier default" value="${l.capOverrides?.maxNodes ?? ''}" style="width:60px;margin-left:4px;" /></label>
      </div>
    </div>`;
  }).join('');
}

function readClassificationLabelEditor(): ClassificationLabelRow[] {
  const list = document.getElementById('compliance-label-list');
  if (!list) return schemaDraft;
  const rows: ClassificationLabelRow[] = [];
  list.querySelectorAll<HTMLElement>('[data-label-idx]').forEach((row) => {
    const id = (row.querySelector('.cls-id') as HTMLInputElement | null)?.value.trim() ?? '';
    const displayName = (row.querySelector('.cls-name') as HTMLInputElement | null)?.value.trim() ?? '';
    const color = (row.querySelector('.cls-color') as HTMLInputElement | null)?.value.trim() ?? '';
    const internalTier = (row.querySelector('.cls-tier') as HTMLSelectElement | null)?.value as ClassificationLabelRow['internalTier'] ?? 'personal';
    const enabled = (row.querySelector('.cls-enabled') as HTMLInputElement | null)?.checked ?? true;
    const userAssignable = (row.querySelector('.cls-assignable') as HTMLInputElement | null)?.checked ?? true;
    const maxTokensRaw = (row.querySelector('.cls-max-tokens') as HTMLInputElement | null)?.value.trim();
    const maxNodesRaw = (row.querySelector('.cls-max-nodes') as HTMLInputElement | null)?.value.trim();
    if (!id || !displayName || !color) return;
    const capOverrides: ClassificationLabelRow['capOverrides'] = {};
    if (maxTokensRaw) capOverrides.maxTokens = Number(maxTokensRaw);
    if (maxNodesRaw) capOverrides.maxNodes = Number(maxNodesRaw);
    rows.push({
      id,
      displayName,
      color,
      internalTier,
      enabled,
      userAssignable,
      ...(Object.keys(capOverrides).length ? { capOverrides } : {}),
    });
  });
  return rows;
}

async function refreshClassificationSchemaPanel(enterprise: boolean): Promise<void> {
  const section = document.getElementById('gc-section-compliance-schema');
  const upsell = document.getElementById('gc-compliance-schema-upsell');
  const config = document.getElementById('gc-compliance-schema-config');
  if (!section) return;
  section.style.display = '';
  if (!enterprise) {
    upsell?.classList.remove('hidden');
    config?.classList.add('hidden');
    return;
  }
  upsell?.classList.add('hidden');
  config?.classList.remove('hidden');
  try {
    const data = await ipcCall<ClassificationSchemaResult>('compliance.getClassificationSchema', {});
    const schema = data.schema ?? { enabled: false, labels: [] };
    schemaDraft = schema.labels.length > 0 ? schema.labels : [...DEFAULT_LABELS];
    const enabledCb = document.getElementById('compliance-schema-enabled') as HTMLInputElement | null;
    if (enabledCb) enabledCb.checked = schema.enabled === true;
    renderClassificationLabelEditor(schemaDraft);
  } catch {
    renderClassificationLabelEditor(DEFAULT_LABELS);
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysFromMs(ms: number | undefined): string {
  if (!ms || ms <= 0) return '';
  return String(Math.round(ms / MS_PER_DAY));
}

function msFromDaysInput(val: string): number | null {
  const n = Number(val.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n * MS_PER_DAY);
}

export async function refreshComplianceSettingsPanel(): Promise<void> {
  const panel = document.getElementById('settings-panel-compliance');
  const upsell = document.getElementById('settings-panel-compliance-upsell');
  const config = document.getElementById('settings-panel-compliance-config');
  const enterpriseGroup = document.getElementById('settings-group-enterprise');
  if (!panel) return;
  if (enterpriseGroup) enterpriseGroup.style.display = '';
  try {
    const data = await ipcCall<ComplianceGetResult>('compliance.get', {});
    if (!data.enterprise) {
      upsell?.classList.remove('hidden');
      config?.classList.add('hidden');
      return;
    }
    upsell?.classList.add('hidden');
    config?.classList.remove('hidden');
    const c = data.compliance;
    const enabled = document.getElementById('compliance-enabled') as HTMLInputElement | null;
    if (enabled) enabled.checked = c.enabled === true;
    const ttl = document.getElementById('compliance-default-ttl-days') as HTMLInputElement | null;
    if (ttl) ttl.value = daysFromMs(c.defaultRetentionTtlMs);
    const exportCb = document.getElementById('compliance-default-export') as HTMLInputElement | null;
    if (exportCb) exportCb.checked = c.defaultExportBeforePurge !== false;
    const status = document.getElementById('compliance-status-line');
    if (status) {
      const parts = [
        c.enabled ? 'Retention purge enabled' : 'Retention purge off (legal hold still enforced)',
        c.lastRetentionDryRunAt
          ? `Last dry-run ${new Date(c.lastRetentionDryRunAt).toLocaleString()}`
          : '',
      ];
      status.textContent = parts.filter(Boolean).join(' · ');
    }
  } catch {
    if (enterpriseGroup) enterpriseGroup.style.display = '';
    upsell?.classList.remove('hidden');
    config?.classList.add('hidden');
  }
}

export function wireComplianceSettingsPanel(): void {
  document.getElementById('btn-compliance-save')?.addEventListener('click', async () => {
    const status = document.getElementById('compliance-save-status');
    const btn = document.getElementById('btn-compliance-save') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Saving…';
    try {
      const enabled = (document.getElementById('compliance-enabled') as HTMLInputElement | null)?.checked ?? false;
      const ttlDays = (document.getElementById('compliance-default-ttl-days') as HTMLInputElement | null)?.value ?? '';
      const defaultExportBeforePurge =
        (document.getElementById('compliance-default-export') as HTMLInputElement | null)?.checked ?? true;
      const ttlMs = msFromDaysInput(ttlDays);
      await ipcCall('compliance.save', {
        enabled,
        ...(ttlMs ? { defaultRetentionTtlMs: ttlMs } : { defaultRetentionTtlMs: null }),
        defaultExportBeforePurge,
      });
      if (status) status.textContent = 'Saved';
      void refreshComplianceSettingsPanel();
      void refreshComplianceGetConnectedPanel();
    } catch (e) {
      app().showError(`Could not save compliance settings: ${e}`);
      if (status) status.textContent = '';
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById('btn-compliance-retention-dry-run')?.addEventListener('click', () => {
    void runRetentionOp(true);
  });
  document.getElementById('btn-compliance-retention-purge')?.addEventListener('click', () => {
    void runRetentionOp(false);
  });
  document.getElementById('gc-btn-compliance-retention-dry-run')?.addEventListener('click', () => {
    void runRetentionOp(true);
  });
  document.getElementById('gc-btn-compliance-retention-purge')?.addEventListener('click', () => {
    void runRetentionOp(false);
  });

  document.getElementById('btn-compliance-schema-reset')?.addEventListener('click', () => {
    schemaDraft = [...DEFAULT_LABELS];
    renderClassificationLabelEditor(schemaDraft);
    const status = document.getElementById('compliance-schema-status');
    if (status) status.textContent = 'Reset to defaults — click Save to apply.';
  });

  document.getElementById('btn-compliance-schema-save')?.addEventListener('click', async () => {
    const status = document.getElementById('compliance-schema-status');
    const btn = document.getElementById('btn-compliance-schema-save') as HTMLButtonElement | null;
    const enabled = (document.getElementById('compliance-schema-enabled') as HTMLInputElement | null)?.checked ?? false;
    const labels = readClassificationLabelEditor();
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Saving…';
    try {
      const result = await ipcCall<{ ok: boolean; message?: string; reason?: string }>(
        'compliance.setClassificationSchema',
        { enabled, labels },
      );
      if (!result.ok) {
        void gAlert('Could not save schema', result.message ?? result.reason ?? 'Unknown error');
        return;
      }
      invalidateClassificationSchemaCache();
      if (status) status.textContent = 'Classification schema saved.';
      const { renderSettingsGraphsList } = await import('./settings-graphs');
      renderSettingsGraphsList();
    } catch (e) {
      app().showError(`Could not save classification schema: ${e}`);
      if (status) status.textContent = '';
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

async function runRetentionOp(dryRun: boolean): Promise<void> {
  if (!dryRun) {
    const ok = await gConfirm(
      'Run retention purge?',
      'Run retention purge now? Sources past their TTL will be forgotten (with export slices when configured). Legal holds are skipped.',
    );
    if (!ok) return;
  }
  const statusIds = ['compliance-retention-status', 'gc-compliance-retention-status'];
  for (const id of statusIds) {
    const el = document.getElementById(id);
    if (el) el.textContent = dryRun ? 'Running dry-run…' : 'Running purge…';
  }
  try {
    const result = await ipcCall<{
      ok: boolean;
      complianceEnabled: boolean;
      items: Array<{ graphId: string; sourceId: string }>;
      message?: string;
      reason?: string;
    }>('compliance.runRetention', { dryRun });
    if (!result.ok) {
      void gAlert('Retention operation failed', result.message ?? result.reason ?? 'Unknown error');
      return;
    }
    const msg = result.complianceEnabled
      ? `${dryRun ? 'Dry-run' : 'Purge'} complete — ${result.items.length} source(s) ${dryRun ? 'would be' : ''} affected.`
      : 'Compliance retention is disabled — enable it in Settings → Compliance first.';
    for (const id of statusIds) {
      const el = document.getElementById(id);
      if (el) el.textContent = msg;
    }
    if (!dryRun) void app().refreshStats();
  } catch (e) {
    void gAlert('Retention operation error', e instanceof Error ? e.message : String(e));
  }
}

export async function refreshComplianceGetConnectedPanel(): Promise<void> {
  const section = document.getElementById('gc-section-compliance');
  const upsell = document.getElementById('gc-compliance-upsell');
  const config = document.getElementById('gc-compliance-config');
  if (!section) return;
  try {
    const data = await ipcCall<ComplianceGetResult>('compliance.get', {});
    section.style.display = '';
    if (!data.enterprise) {
      upsell?.classList.remove('hidden');
      config?.classList.add('hidden');
      await refreshClassificationSchemaPanel(false);
      return;
    }
    upsell?.classList.add('hidden');
    config?.classList.remove('hidden');
    const status = document.getElementById('gc-compliance-retention-status');
    if (status && data.compliance.lastRetentionDryRunAt) {
      status.textContent = `Last scheduled dry-run: ${new Date(data.compliance.lastRetentionDryRunAt).toLocaleString()}`;
    }
    await refreshClassificationSchemaPanel(true);
  } catch {
    section.style.display = 'none';
  }
}

export function industryTagOptionsHtml(selected: string[] = []): string {
  const presets = ['hipaa', 'pci', 'export-controlled'];
  const all = [...new Set([...presets, ...selected.map((t) => t.toLowerCase())])];
  return all.map((t) => {
    const on = selected.map((s) => s.toLowerCase()).includes(t);
    return `<label class="sgr-industry-tag" style="font-size:12px;display:inline-flex;align-items:center;gap:4px;margin-right:8px;">
      <input type="checkbox" class="sgr-industry-cb" value="${escape(t)}" ${on ? 'checked' : ''} /> ${escape(t)}
    </label>`;
  }).join('');
}
