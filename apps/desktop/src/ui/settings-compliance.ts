/**
 * Enterprise Compliance settings + Get Connected retention ops.
 */
import { app } from './app-context';
import { gAlert, gConfirm } from './dialogs';
import { ipcCall, isUnknownIpcMethodError } from './ipc';
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
  /** Opaque fingerprint of the palette this load returned. Echoed back on Save. */
  version?: string;
}

const DEFAULT_LABELS: ClassificationLabelRow[] = [
  { id: 'green', displayName: 'Non-confidential', color: '#22c55e', internalTier: 'public', userAssignable: true, enabled: true },
  { id: 'yellow', displayName: 'Internal', color: '#eab308', internalTier: 'personal', userAssignable: true, enabled: true },
  { id: 'red', displayName: 'Restricted', color: '#ef4444', internalTier: 'sensitive', userAssignable: true, enabled: true },
];

let schemaDraft: ClassificationLabelRow[] = [...DEFAULT_LABELS];

/**
 * Whether the label editor is showing a palette the sidecar actually returned.
 *
 * WHY THIS EXISTS — and why "does the list have rows?" cannot replace it.
 *
 * `#gc-compliance-schema-config` ships UN-hidden and `#compliance-label-list`
 * ships EMPTY (index.html). Only `refreshClassificationSchemaPanel()` corrects
 * that, and it is reachable only from inside `refreshComplianceGetConnectedPanel()`'s
 * `try`, after `compliance.get`. When that call throws, the panel keeps its
 * markup default: on screen, licensed-looking, zero rows.
 *
 * `readClassificationLabelEditor()` reads the DOM, so zero rows read back as
 * `labels: []` — and the editor has no add/remove buttons, so blanking every
 * row's id/name/color is the ONLY way a user deliberately drops all labels.
 * A deliberate clear-all and a never-loaded panel therefore produce the SAME
 * pixels and the SAME payload. No amount of inspecting the payload, the row
 * count, or `schemaDraft` (which itself starts life as DEFAULT_LABELS) can
 * tell them apart. The distinction only exists in whether a load succeeded,
 * so that fact is recorded here explicitly instead of being inferred.
 */
type SchemaLoadState = 'never-loaded' | 'loaded' | 'failed';
let schemaLoadState: SchemaLoadState = 'never-loaded';

/**
 * The fingerprint of the palette the last successful load returned.
 *
 * The sidecar refuses a write that REMOVES stored labels unless the caller
 * echoes this back, because echoing it is the only evidence the caller read
 * what it is about to destroy. It is also how the sidecar detects a stale
 * save — another admin or an MDM push changing the palette between this load
 * and this Save — which the load-state guard above cannot see.
 *
 * `null` whenever no load has succeeded, which is exactly when
 * `classificationSchemaIsLoaded()` already blocks Save.
 */
let schemaBaseVersion: string | null = null;

/**
 * THE GUARD. Both the Save/Reset handlers and the disabled-state of their
 * buttons derive from this one predicate, so there is a single place where
 * "may this panel write to the org's palette?" is decided.
 */
function classificationSchemaIsLoaded(): boolean {
  return schemaLoadState === 'loaded';
}

/** Buttons and the enable checkbox follow the guard — never their own copy of it. */
function syncClassificationSchemaControls(): void {
  const savable = classificationSchemaIsLoaded();
  for (const id of ['btn-compliance-schema-save', 'btn-compliance-schema-reset']) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = !savable;
  }
  const enabledCb = document.getElementById('compliance-schema-enabled') as HTMLInputElement | null;
  if (enabledCb) enabledCb.disabled = !savable;
}

/**
 * Paint the failure state: a visible reason where the palette would be, plus a
 * retry. Deliberately NOT `renderClassificationLabelEditor(DEFAULT_LABELS)` —
 * painting the built-in green/yellow/red over a failed read is what let a Save
 * substitute the defaults for the organization's real palette.
 */
function renderClassificationSchemaLoadError(message: string): void {
  const list = document.getElementById('compliance-label-list');
  if (list) {
    list.innerHTML = `<div class="panel" style="padding:12px;margin:0;">
      <p class="subtitle" style="margin:0 0 8px;">${escape(message)}</p>
      <button type="button" id="btn-compliance-schema-retry" class="g-btn">Retry loading the schema</button>
    </div>`;
    document.getElementById('btn-compliance-schema-retry')?.addEventListener('click', () => {
      void refreshComplianceGetConnectedPanel();
    });
  }
  const status = document.getElementById('compliance-schema-status');
  if (status) {
    status.textContent = 'Saving is disabled until the current label palette loads — nothing has been changed.';
  }
}

/**
 * Record a failed load.
 *
 * A panel that ALREADY loaded keeps its `loaded` state: the rows on screen are
 * the real palette plus whatever the user has typed since, and blanking that
 * over a transient `compliance.get` blip would throw away their edits to
 * protect data that is not actually at risk.
 */
function markClassificationSchemaLoadFailed(message: string): void {
  if (schemaLoadState === 'loaded') return;
  schemaLoadState = 'failed';
  renderClassificationSchemaLoadError(message);
  syncClassificationSchemaControls();
}

// ───────────────────────────────────────────────────────────────────────────
// ORPHANED CLASSIFICATION LABELS
//
// Removing a label from the palette — through Save here, or through an MDM
// bundle import — does NOT clear it off the engrams that were tagged with it.
// Those engrams keep a `classificationLabelId` pointing at something that no
// longer exists. That is the owner's deliberate policy: silently re-tagging a
// document to a default is a worse hazard in a compliance feature than leaving
// it visibly broken. "Visibly" is the part that was missing.
//
// The import handler already reports what a push destroyed, but only in its own
// response — a statement that exists for the length of one toast. An admin who
// imported a bundle on Monday had nothing to look at on Friday. This readout is
// that missing persistent state: computed on demand from stored metadata, shown
// every time the section is opened.
//
// NO REPAIR AFFORDANCE HERE ON PURPOSE. The repair policy is undecided; this
// change is disclosure only.
// ───────────────────────────────────────────────────────────────────────────

interface ClassificationOrphanRow {
  graphId: string;
  displayName: string;
  labelId: string;
}

interface ClassificationOrphanResult {
  ok: boolean;
  orphans?: ClassificationOrphanRow[];
  missingLabelIds?: string[];
  checkedAt?: number;
}

/**
 * Whether the orphan readout is showing a real answer.
 *
 * Same reasoning as `schemaLoadState`, and the same failure it exists to
 * prevent: an empty result and a failed fetch must never render as the same
 * thing. "0 orphans" is a claim about the org's data. If the read did not
 * happen, the panel has no basis for that claim and must not make it.
 *
 *   never-loaded → render NOTHING. No claim in either direction.
 *   loaded       → render the count (or an explicit all-clear).
 *   failed       → render "could not check", never an all-clear.
 *   unsupported  → render "this server cannot run the check", never an all-clear.
 *
 * `unsupported` is split out of `failed` because the two need different words
 * and different next steps, not because it is any less serious. "The check
 * failed" tells an admin to retry; retrying is useless when the server has no
 * such handler, and a raw transport error ("HTTP 400 Bad Request") tells them
 * nothing at all. It is the expected state during any rollout where the app
 * updates before the server does, so it is a state the panel should be able to
 * name. What it must NEVER do is collapse into the clean branch: an absent
 * handler is the one situation where nobody has looked at the data, which makes
 * it the last place an all-clear could be earned.
 */
type OrphanLoadState = 'never-loaded' | 'loaded' | 'failed' | 'unsupported';
let orphanLoadState: OrphanLoadState = 'never-loaded';
let orphanRows: ClassificationOrphanRow[] = [];
let orphanMissingLabelIds: string[] = [];
let orphanErrorMessage = '';
let orphanCheckedAt = 0;

/** Engrams named inline before the list collapses into "and N more". */
const ORPHAN_PREVIEW_LIMIT = 5;

/**
 * A remote failure this app could not decode: the bridge collapses every
 * dispatch error into HTTP 400, and a shell older than the fix in `remote::rpc`
 * throws the JSON body away, so all that survives is the status line.
 *
 * When that is all we have, the honest position is that we do not know which
 * failure this was — but we do know one candidate is far and away the most
 * common (the server predating the check), and that candidate has a concrete
 * next step the generic "retry" does not. So the hint is offered as a
 * possibility, not a diagnosis. Returns '' when the message did decode, so a
 * real handler error is never dressed up as a version problem.
 */
function opaqueRemoteFailureHint(message: string): string {
  if (!/^remote IPC .* failed with HTTP \d+/i.test(message)) return '';
  return `<p class="subtitle" style="margin:0 0 8px;font-size:12px;">The server did not say why. The most common cause is a server running an older Graphnosis build that does not have this check — if this cortex is on a remote server, updating it is the first thing to try.</p>`;
}

/**
 * Paint the readout AND the `<summary>` badge from `orphanLoadState`.
 *
 * The badge matters because `#gc-section-compliance-schema` is a `<details>`
 * that ships collapsed: a warning only visible after a click is a warning an
 * admin has to already suspect. It is empty in the clean state — a marker that
 * is always there is a marker nobody reads.
 */
function renderClassificationOrphans(): void {
  const box = document.getElementById('compliance-orphan-readout');
  const badge = document.getElementById('compliance-orphan-badge');
  const setBadge = (text: string, color: string): void => {
    if (!badge) return;
    badge.textContent = text;
    badge.setAttribute(
      'style',
      text === '' ? '' : `margin-left:8px;font-size:12px;font-weight:600;color:${color};`,
    );
  };
  if (!box) return;

  if (orphanLoadState === 'never-loaded') {
    // Not "all clear" — nothing has been checked yet, so nothing is asserted.
    box.innerHTML = '';
    setBadge('', '');
    return;
  }

  if (orphanLoadState === 'unsupported') {
    // Same severity as `failed`, different sentence and a different instruction:
    // the answer is missing because of the build on the other end, and no amount
    // of retrying changes that. Still rendered in the error style, because from
    // the org's point of view an unanswered compliance question is an unanswered
    // compliance question however good the excuse is.
    box.innerHTML = `<div class="panel" style="padding:10px 12px;margin:0 0 10px;border-color:var(--color-status-error-border);background:var(--color-status-error-soft);">
      <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:var(--color-status-error);">This server cannot check for engrams carrying a removed classification label.</p>
      <p class="subtitle" style="margin:0 0 8px;font-size:12px;">The Graphnosis server this cortex lives on is running a build that does not have this check yet. Update the server to a build that includes it, then run the check again.</p>
      <p class="subtitle" style="margin:0 0 8px;font-size:12px;">This is <strong>not</strong> an all-clear — the check did not run, so the number of affected engrams is unknown.</p>
      <p class="subtitle" style="margin:0 0 8px;font-size:11px;color:var(--fg-dim);">${escape(orphanErrorMessage)}</p>
      <button type="button" id="btn-compliance-orphans-retry" class="g-btn">Retry the check</button>
    </div>`;
    document.getElementById('btn-compliance-orphans-retry')?.addEventListener('click', () => {
      void refreshClassificationOrphans();
    });
    setBadge('— check unsupported here', 'var(--color-status-error)');
    return;
  }

  if (orphanLoadState === 'failed') {
    box.innerHTML = `<div class="panel" style="padding:10px 12px;margin:0 0 10px;border-color:var(--color-status-error-border);background:var(--color-status-error-soft);">
      <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:var(--color-status-error);">Could not check for engrams carrying a removed classification label.</p>
      <p class="subtitle" style="margin:0 0 8px;font-size:12px;">${escape(orphanErrorMessage)}</p>
      ${opaqueRemoteFailureHint(orphanErrorMessage)}
      <p class="subtitle" style="margin:0 0 8px;font-size:12px;">This is <strong>not</strong> an all-clear — the check did not run, so the number of affected engrams is unknown.</p>
      <button type="button" id="btn-compliance-orphans-retry" class="g-btn">Retry the check</button>
    </div>`;
    document.getElementById('btn-compliance-orphans-retry')?.addEventListener('click', () => {
      void refreshClassificationOrphans();
    });
    setBadge('— check unavailable', 'var(--color-status-error)');
    return;
  }

  // Everything past this point asserts something about the organization's data,
  // so it is gated on an answer having actually arrived — never on `orphanRows`
  // being empty, which is also exactly what "never populated" looks like. Any
  // state added later lands here and renders nothing rather than an all-clear.
  if (orphanLoadState !== 'loaded') {
    box.innerHTML = '';
    setBadge('', '');
    return;
  }

  if (orphanRows.length === 0) {
    const when = orphanCheckedAt > 0 ? new Date(orphanCheckedAt).toLocaleString() : '';
    box.innerHTML = `<p class="subtitle" style="margin:0 0 10px;font-size:12px;color:var(--ok);">
      No engrams reference a removed classification label.${when ? ` <span style="color:var(--fg-dim);">Checked ${escape(when)}.</span>` : ''}
    </p>`;
    setBadge('', '');
    return;
  }

  const n = orphanRows.length;
  const shown = orphanRows.slice(0, ORPHAN_PREVIEW_LIMIT);
  const rest = n - shown.length;
  const items = shown.map((o) => `<li style="margin:2px 0;">
      <strong>${escape(o.displayName)}</strong>${o.displayName === o.graphId ? '' : ` <span style="color:var(--fg-dim);">(${escape(o.graphId)})</span>`}
      → <code>${escape(o.labelId)}</code>
    </li>`).join('');

  box.innerHTML = `<div class="panel" style="padding:10px 12px;margin:0 0 10px;border-color:var(--color-status-warn-border);background:var(--color-status-warn-soft);">
    <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:var(--color-status-warn);">
      ${n} engram${n === 1 ? '' : 's'} reference${n === 1 ? 's' : ''} a classification label that is no longer in the palette.
    </p>
    <p class="subtitle" style="margin:0 0 6px;font-size:12px;">Missing label id${orphanMissingLabelIds.length === 1 ? '' : 's'}: ${orphanMissingLabelIds.map((id) => `<code>${escape(id)}</code>`).join(', ')}</p>
    <ul style="margin:0 0 6px;padding-left:18px;font-size:12px;list-style:disc;">${items}</ul>
    ${rest > 0 ? `<p class="subtitle" style="margin:0 0 6px;font-size:12px;">…and ${rest} more.</p>` : ''}
    <p class="subtitle" style="margin:0;font-size:12px;">Nothing has been changed — these engrams keep the label id they were given. Re-add the label to the palette, or reclassify them in Settings → Engrams.</p>
  </div>`;
  setBadge(`— ${n} orphaned`, 'var(--color-status-warn)');
}

/**
 * Read the current orphan state from the sidecar and repaint.
 *
 * Never throws: every failure path — a transport error, a refusal, or a
 * response that is not the shape this function understands — lands in `failed`
 * or `unsupported`, because "I could not tell" and "there is nothing to tell"
 * are different answers and only one of them is reassuring.
 *
 * Note this deliberately does NOT copy `markClassificationSchemaLoadFailed`'s
 * "a panel that already loaded keeps its loaded state". That rule protects the
 * label editor's UNSAVED USER EDITS from a transient blip. There is nothing to
 * protect here, and keeping a previous all-clear on screen after a failed
 * re-check is exactly the stale false-clean this readout exists to prevent.
 */
async function refreshClassificationOrphans(): Promise<void> {
  try {
    const res = await ipcCall<ClassificationOrphanResult>('compliance.getClassificationOrphans', {});
    // A shape check, not a formality. A sidecar too old for this method throws
    // (`Unknown IPC method`) and lands in the catch below, but that is not the
    // only way to get a response with no orphan array in it — a refusal, a
    // proxy, or a future handler shape all produce one, and `(res.orphans ?? [])`
    // would quietly turn any of them into a confident "0 orphans".
    if (!res || res.ok !== true || !Array.isArray(res.orphans)) {
      orphanLoadState = 'failed';
      orphanErrorMessage = 'The sidecar did not return an orphan report for this cortex.';
      renderClassificationOrphans();
      return;
    }
    orphanRows = res.orphans;
    orphanMissingLabelIds = Array.isArray(res.missingLabelIds)
      ? res.missingLabelIds
      : [...new Set(res.orphans.map((o) => o.labelId))];
    orphanCheckedAt = typeof res.checkedAt === 'number' ? res.checkedAt : Date.now();
    orphanErrorMessage = '';
    orphanLoadState = 'loaded';
    renderClassificationOrphans();
  } catch (e) {
    // Split, not softened. `unsupported` gets its own words and its own next
    // step; it does NOT get the clean branch, and both paths still say in so
    // many words that this is not an all-clear.
    orphanLoadState = isUnknownIpcMethodError(e) ? 'unsupported' : 'failed';
    orphanErrorMessage = e instanceof Error ? e.message : String(e);
    renderClassificationOrphans();
  }
}

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
    // Not a load — an unlicensed panel has no palette to save over.
    schemaLoadState = 'never-loaded';
    syncClassificationSchemaControls();
    return;
  }
  upsell?.classList.add('hidden');
  config?.classList.remove('hidden');
  try {
    const data = await ipcCall<ClassificationSchemaResult>('compliance.getClassificationSchema', {});
    const schema = data.schema ?? { enabled: false, labels: [] };
    schemaBaseVersion = typeof data.version === 'string' ? data.version : null;
    schemaDraft = schema.labels.length > 0 ? schema.labels : [...DEFAULT_LABELS];
    const enabledCb = document.getElementById('compliance-schema-enabled') as HTMLInputElement | null;
    if (enabledCb) enabledCb.checked = schema.enabled === true;
    renderClassificationLabelEditor(schemaDraft);
    schemaLoadState = 'loaded';
    const status = document.getElementById('compliance-schema-status');
    if (status && status.textContent?.startsWith('Saving is disabled')) status.textContent = '';
    syncClassificationSchemaControls();
  } catch (e) {
    markClassificationSchemaLoadFailed(
      `Could not load the classification schema: ${e instanceof Error ? e.message : String(e)}`,
    );
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

  // Nothing has loaded at wire time, so the palette controls start refused.
  syncClassificationSchemaControls();

  document.getElementById('btn-compliance-schema-reset')?.addEventListener('click', () => {
    // Same guard as Save: "reset to green/yellow/red" is a decision about what
    // to replace, and a panel that never loaded cannot tell the user what that is.
    if (!classificationSchemaIsLoaded()) {
      renderClassificationSchemaLoadError('The current label palette has not loaded, so it cannot be replaced yet.');
      syncClassificationSchemaControls();
      return;
    }
    schemaDraft = [...DEFAULT_LABELS];
    renderClassificationLabelEditor(schemaDraft);
    const status = document.getElementById('compliance-schema-status');
    if (status) status.textContent = 'Reset to defaults — click Save to apply.';
  });

  document.getElementById('btn-compliance-schema-save')?.addEventListener('click', async () => {
    const status = document.getElementById('compliance-schema-status');
    const btn = document.getElementById('btn-compliance-schema-save') as HTMLButtonElement | null;
    // THE REFUSAL. Reading the editor now would read a panel that may never
    // have been populated, and posting that overwrites the org's palette with
    // whatever the markup happened to contain.
    if (!classificationSchemaIsLoaded()) {
      renderClassificationSchemaLoadError('The current label palette has not loaded, so it cannot be saved over.');
      syncClassificationSchemaControls();
      return;
    }
    const enabled = (document.getElementById('compliance-schema-enabled') as HTMLInputElement | null)?.checked ?? false;
    const labels = readClassificationLabelEditor();
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Saving…';
    try {
      const result = await ipcCall<{ ok: boolean; message?: string; reason?: string; version?: string }>(
        'compliance.setClassificationSchema',
        {
          enabled,
          labels,
          // Proof this panel read the palette it is about to overwrite. The
          // sidecar refuses a write that removes stored labels without it, and
          // rejects it outright if the palette moved under us since the load.
          ...(schemaBaseVersion ? { baseVersion: schemaBaseVersion } : {}),
        },
      );
      if (!result.ok) {
        void gAlert('Could not save schema', result.message ?? result.reason ?? 'Unknown error');
        return;
      }
      // The palette just changed, so the fingerprint did too — a second Save in
      // the same session would otherwise look stale to the sidecar.
      schemaBaseVersion = typeof result.version === 'string' ? result.version : null;
      invalidateClassificationSchemaCache();
      // This Save may have just removed labels that engrams are wearing. Re-read
      // rather than reason about it here — the sidecar is the only place that
      // knows what the stored metadata looks like after the write.
      void refreshClassificationOrphans();
      if (status) status.textContent = 'Classification schema saved.';
      const { renderSettingsGraphsList } = await import('./settings-graphs');
      renderSettingsGraphsList();
    } catch (e) {
      app().showError(`Could not save classification schema: ${e}`);
      if (status) status.textContent = '';
    } finally {
      // Re-enable through the guard, not past it.
      syncClassificationSchemaControls();
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

/**
 * Show or clear a load error for the Compliance operations section.
 *
 * `#gc-section-compliance` has no error element in the markup, so one is
 * created here; `#gc-compliance-load-error` and `#gc-btn-compliance-retry` are
 * owned by this function and referenced nowhere else.
 */
function setComplianceOpsLoadError(message: string | null): void {
  const section = document.getElementById('gc-section-compliance');
  if (!section) return;
  const existing = document.getElementById('gc-compliance-load-error');
  if (!message) {
    existing?.remove();
    return;
  }
  const box = existing ?? section.appendChild(document.createElement('div'));
  box.id = 'gc-compliance-load-error';
  box.innerHTML = `<p class="gc-section-hint" style="margin:8px 0;">${escape(message)}</p>
    <button type="button" id="gc-btn-compliance-retry" class="g-btn">Retry</button>`;
  document.getElementById('gc-btn-compliance-retry')?.addEventListener('click', () => {
    void refreshComplianceGetConnectedPanel();
  });
}

export async function refreshComplianceGetConnectedPanel(): Promise<void> {
  const section = document.getElementById('gc-section-compliance');
  const upsell = document.getElementById('gc-compliance-upsell');
  const config = document.getElementById('gc-compliance-config');
  if (!section) return;
  try {
    const data = await ipcCall<ComplianceGetResult>('compliance.get', {});
    section.style.display = '';
    setComplianceOpsLoadError(null);
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
  } catch (e) {
    // Was `section.style.display = 'none'` — the whole section vanished on any
    // IPC throw, so the user saw nothing rather than a failure. Same false-clean
    // class as the schema panel: show the failure and offer a retry.
    const msg = e instanceof Error ? e.message : String(e);
    section.style.display = '';
    upsell?.classList.add('hidden');
    config?.classList.add('hidden');
    setComplianceOpsLoadError(`Could not load compliance settings: ${msg}. Nothing has been changed.`);
    // refreshClassificationSchemaPanel() was never reached, so the label editor
    // still holds its markup default. Say so, and refuse to save over it.
    markClassificationSchemaLoadFailed(`Could not load the classification schema: ${msg}`);
  } finally {
    // `finally`, not a trailing statement: the unlicensed branch above RETURNS
    // from inside the `try`, and the orphan readout is not a statement about
    // this machine's license or about whether the palette loaded — it is a
    // statement about engrams that are already in that state either way. It
    // runs on every path, including the one where `compliance.get` threw (where
    // it will report that it could not check, which is the honest answer).
    // Safe in `finally` because refreshClassificationOrphans() never throws.
    await refreshClassificationOrphans();
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
