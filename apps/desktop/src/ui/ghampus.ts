/**
 * Ghampus — local AI agent UI (chat, panels, proactive cards).
 */
import { invoke, listen } from '../platform';
import { app } from './app-context';
import { gAlert, gConfirm, gPrompt } from './dialogs';
import { ipcCall } from './ipc';
import { escapeHtml } from './util';

export function initGhampus(): void {
  wireGhampusSidecarEvents();
  wireGhampusChat();
  wireGhampusControls();
  wireGhampusModelSelect();
  wireSkillMaintenanceSettings();
  wireProactiveSettings();
  wireSavingsBaselineSettings();
  wireGhampusAttachButtons();
  wireAnnotationModalControls();
}

export function isGhampusEnabled(): boolean { return ghampusEnabled; }
export function isGhampusRunning(): boolean { return ghampusRunning; }


// ── Ghampus (local agent) ───────────────────────────────────────────────
let ghampusEnabled = true;
let ghampusPlan: 'free' | 'pro' | 'teams' | 'enterprise' = 'free';
let ghampusCloudRoutingReady = false;
let ghampusRunning = false;  // true while a skill walk or message is in flight

export function setGhampusRunning(running: boolean): void {
  ghampusRunning = running;
  void ipcCall('ghampus:activity', { busy: running }).catch(() => {});
  // "Stop all" only shows while something is actually in flight.
  document.getElementById('btn-ghampus-kill')
    ?.classList.toggle('hidden', !ghampusRunning || !ghampusEnabled);
}

export function updateGhampusVisibility(): void {
  document.getElementById('btn-ghampus-kill')
    ?.classList.toggle('hidden', !ghampusRunning || !ghampusEnabled);
  document.getElementById('btn-ghampus-resume')?.classList.toggle('hidden', ghampusEnabled);
  document.getElementById('ghampus-kill-banner')?.classList.toggle('hidden', ghampusEnabled);
  const chip = document.getElementById('ghampus-plan-chip');
  if (chip) chip.textContent = ghampusPlan.charAt(0).toUpperCase() + ghampusPlan.slice(1);
}

export async function refreshGhampusState(): Promise<void> {
  try {
    const s = await ipcCall<{
      enabled: boolean;
      plan: 'free' | 'pro' | 'teams' | 'enterprise';
      skillMaintenance?: { enabled: boolean; idleOnly: boolean };
      proactive?: { startupDelayMs: number };
    }>('agent:status', {});
    ghampusEnabled = s.enabled;
    ghampusPlan = s.plan;
    updateGhampusVisibility();
    paintSkillMaintenanceSettings(s.skillMaintenance);
    paintProactiveSettings(s.proactive);
  } catch { /* non-fatal — keep last known state */ }
}

function paintProactiveSettings(proactive?: { startupDelayMs: number }): void {
  const minEl = document.getElementById('ghampus-proactive-startup-delay-min') as HTMLInputElement | null;
  if (minEl && proactive) {
    minEl.value = String(Math.round(proactive.startupDelayMs / 60_000));
  }
}

export function wireProactiveSettings(): void {
  const minEl = document.getElementById('ghampus-proactive-startup-delay-min') as HTMLInputElement | null;
  const saveBtn = document.getElementById('btn-ghampus-proactive-delay-save');
  saveBtn?.addEventListener('click', () => {
    const mins = Math.max(0, parseInt(minEl?.value ?? '5', 10) || 0);
    void ipcCall('agent:setProactive', { startupDelayMs: mins * 60_000 }).catch(() => {});
  });
}

const SAVINGS_BASELINE_PRESETS: Record<string, { modelDisplayName: string; inputUsdPer1M: number; outputUsdPer1M: number }> = {
  sonnet: { modelDisplayName: 'Claude Sonnet 4.6 baseline', inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 },
  gpt4o: { modelDisplayName: 'GPT-4o baseline', inputUsdPer1M: 2.5, outputUsdPer1M: 10.0 },
  opus: { modelDisplayName: 'Claude Opus 4.6 baseline', inputUsdPer1M: 15.0, outputUsdPer1M: 75.0 },
  haiku: { modelDisplayName: 'Claude Haiku 4.5 baseline', inputUsdPer1M: 0.8, outputUsdPer1M: 4.0 },
};

function savingsBaselinePresetKey(b: { modelDisplayName: string; inputUsdPer1M: number; outputUsdPer1M: number }): string {
  for (const [key, preset] of Object.entries(SAVINGS_BASELINE_PRESETS)) {
    if (preset.modelDisplayName === b.modelDisplayName
      && preset.inputUsdPer1M === b.inputUsdPer1M
      && preset.outputUsdPer1M === b.outputUsdPer1M) return key;
  }
  return 'sonnet';
}

function paintSavingsBaselineSettings(baseline?: { modelDisplayName: string; inputUsdPer1M: number; outputUsdPer1M: number } | null): void {
  const select = document.getElementById('models-savings-baseline') as HTMLSelectElement | null;
  const label = document.getElementById('models-savings-baseline-label');
  const b = baseline ?? SAVINGS_BASELINE_PRESETS.sonnet;
  if (select) select.value = savingsBaselinePresetKey(b);
  if (label) {
    label.textContent = `Active: ${b.modelDisplayName} ($${b.inputUsdPer1M}/M in · $${b.outputUsdPer1M}/M out)`;
  }
}

export function wireSavingsBaselineSettings(): void {
  const select = document.getElementById('models-savings-baseline') as HTMLSelectElement | null;
  const saveBtn = document.getElementById('btn-models-save-savings-baseline');
  saveBtn?.addEventListener('click', () => {
    const key = select?.value ?? 'sonnet';
    const preset = SAVINGS_BASELINE_PRESETS[key] ?? SAVINGS_BASELINE_PRESETS.sonnet;
    void (async () => {
      try {
        await ipcCall('models:setSavingsBaseline', { savingsBaseline: preset });
        paintSavingsBaselineSettings(preset);
      } catch (e) {
        await gAlert('Could not save savings baseline', e instanceof Error ? e.message : String(e));
      }
    })();
  });
}

function paintSkillMaintenanceSettings(sm?: { enabled: boolean; idleOnly: boolean }): void {
  const enabledEl = document.getElementById('ghampus-skill-maintenance-enabled') as HTMLInputElement | null;
  const idleEl = document.getElementById('ghampus-skill-maintenance-idle') as HTMLInputElement | null;
  if (enabledEl && sm) enabledEl.checked = sm.enabled;
  if (idleEl && sm) idleEl.checked = sm.idleOnly;
}

export function wireSkillMaintenanceSettings(): void {
  const enabledEl = document.getElementById('ghampus-skill-maintenance-enabled') as HTMLInputElement | null;
  const idleEl = document.getElementById('ghampus-skill-maintenance-idle') as HTMLInputElement | null;
  enabledEl?.addEventListener('change', () => {
    void ipcCall('agent:setSkillMaintenance', { enabled: enabledEl.checked }).catch(() => {});
  });
  idleEl?.addEventListener('change', () => {
    void ipcCall('agent:setSkillMaintenance', { idleOnly: idleEl.checked }).catch(() => {});
  });
}

// localStorage tracks when the user last visited the Ghampus tab so the
// notifications panel can filter "what's new since then". A 7-day fallback
// applies on first visit so brand-new users see SOMETHING populated.
const GHAMPUS_LAST_VISITED_KEY = 'graphnosis.ghampusLastVisitedAt';

const NOTIF_ORIGIN_ICONS: Record<string, string> = {
  connector: '🔌',
  'ai-client': '💬',
  sharing: '🤝',
  direct: '📁',
  other: '·',
};

// ── Settings → Models panel ────────────────────────────────────────────
interface ProviderRow {
  id: string;
  displayName: string;
  tagline: string;
  local: boolean;
  builtIn: boolean;
  homepage: string;
  enabled: boolean;
  hasKey?: boolean;
  keyTail?: string;
  adminLocked?: boolean;
  poolSpentUsd?: number;
  needsKey?: boolean;
  /** Loopback server reachability for local providers (ollama, mlx, vllm). */
  reachable?: boolean;
  /** Custom base URL override for OpenAI-compatible local providers. */
  baseUrl?: string;
}

interface ModelsCatalogResponse {
  catalogVersion: string;
  cloudRoutingReady?: boolean;
  providers: ProviderRow[];
  models: Array<{ id: string; provider: string; displayName: string; capabilities: string[] }>;
  strategy: 'adaptive' | 'local-only' | 'always-best';
  monthlyBudgetUsd: number | null;
  spentThisCycleUsd: number;
  savingsBaseline?: { modelDisplayName: string; inputUsdPer1M: number; outputUsdPer1M: number };
}

async function promptProviderApiKey(provider: ProviderRow): Promise<void> {
  const title = provider.hasKey ? `Update API key for ${provider.displayName}` : `Add API key for ${provider.displayName}`;
  const apiKey = await gPrompt(
    title,
    'Paste your key — stored encrypted in your cortex, never sent to Graphnosis servers.',
    { placeholder: 'sk-…', secret: true },
  );
  if (apiKey == null) return;
  const trimmed = apiKey.trim();
  if (!trimmed) {
    await gAlert('API key required', 'API key cannot be empty.');
    return;
  }
  try {
    await ipcCall('models:setProviderKey', { providerId: provider.id, apiKey: trimmed });
    void refreshModelsPanel();
  } catch (e) {
    await gAlert('Could not save API key', e instanceof Error ? e.message : String(e));
  }
}

export async function refreshModelsPanel(): Promise<void> {
  try {
    const data = await ipcCall<ModelsCatalogResponse>('models:catalog', {});
    ghampusCloudRoutingReady = data.cloudRoutingReady === true;
    // Strategy radios
    document.querySelectorAll<HTMLInputElement>('input[name="models-strategy"]').forEach((r) => {
      r.checked = r.value === data.strategy;
      r.onchange = () => {
        if (r.checked) void ipcCall('models:setStrategy', { strategy: r.value });
      };
    });
    // Budget input
    const budgetInput = document.getElementById('models-budget-input') as HTMLInputElement | null;
    if (budgetInput) budgetInput.value = data.monthlyBudgetUsd != null ? String(data.monthlyBudgetUsd) : '';
    const spentLabel = document.getElementById('models-budget-spent');
    if (spentLabel) {
      spentLabel.textContent = data.monthlyBudgetUsd
        ? `spent: $${data.spentThisCycleUsd.toFixed(2)} of $${data.monthlyBudgetUsd.toFixed(2)} this cycle`
        : `spent: $${data.spentThisCycleUsd.toFixed(2)} this cycle · no cap`;
    }
    paintSavingsBaselineSettings(data.savingsBaseline ?? null);
    const saveBtn = document.getElementById('btn-models-save-budget');
    if (saveBtn) {
      saveBtn.onclick = () => {
        void (async () => {
          const v = budgetInput?.value.trim();
          const n = v ? Number(v) : null;
          await ipcCall('models:setBudget', { monthlyBudgetUsd: n });
          void refreshModelsPanel();
        })();
      };
    }
    // Catalog version
    const ver = document.getElementById('models-catalog-version');
    if (ver) ver.textContent = `Catalog version: ${data.catalogVersion} · ${data.models.length} models known`;
    // Provider list
    const list = document.getElementById('models-provider-list');
    if (list) {
      list.innerHTML = data.providers.map((p) => {
        const lockBadge = p.adminLocked
          ? '<span class="models-provider-badge models-provider-badge--admin">🔒 admin</span>'
          : '';
        const localBadge = p.local
          ? '<span class="models-provider-badge models-provider-badge--local">local · free</span>'
          : '';
        const reachBadge = p.local && p.reachable !== undefined
          ? (p.reachable
            ? '<span class="models-provider-badge models-provider-badge--reachable">reachable</span>'
            : '<span class="models-provider-badge models-provider-badge--offline">offline</span>')
          : '';
        const baseUrlHint = p.baseUrl
          ? `<span class="models-provider-meta">${escapeHtml(p.baseUrl)}</span>`
          : (p.id === 'mlx' || p.id === 'vllm')
            ? '<span class="models-provider-meta">default loopback</span>'
            : '';
        const needsKeyBadge = p.needsKey && !p.hasKey
          ? '<span class="models-provider-badge models-provider-badge--needs-key">needs key</span>'
          : '';
        const keyChip = p.hasKey
          ? `<span class="models-provider-key">key ···${escapeHtml(p.keyTail ?? '')}</span>`
          : '';
        const modelCount = data.models.filter((m) => m.provider === p.id).length;
        const toggleDisabled = p.adminLocked || (p.needsKey && !p.hasKey);
        const keyBtn = p.needsKey && !p.adminLocked
          ? `<button type="button" class="g-btn" data-provider-key="${escapeHtml(p.id)}">${p.hasKey ? 'Change key' : 'Add key'}</button>`
          : '';
        const removeKeyBtn = p.needsKey && p.hasKey && !p.adminLocked
          ? `<button type="button" class="g-btn" data-provider-clear-key="${escapeHtml(p.id)}">Remove</button>`
          : '';
        const badges = [lockBadge, localBadge, reachBadge, needsKeyBadge].filter(Boolean).join('');
        const badgesHtml = badges ? `<span class="models-provider-badges">${badges}</span>` : '';
        return `<li class="models-provider-row">
          <label class="models-provider-toggle${toggleDisabled ? ' is-disabled' : ''}">
            <input type="checkbox" ${p.enabled && !toggleDisabled ? 'checked' : ''} ${toggleDisabled ? 'disabled' : ''} data-provider-toggle="${escapeHtml(p.id)}">
            <span class="models-provider-title">
              <strong>${escapeHtml(p.displayName)}</strong>${badgesHtml}
            </span>
          </label>
          <span class="models-provider-tagline">${escapeHtml(p.tagline)}</span>
          ${baseUrlHint}
          <span class="models-provider-count">${modelCount} model${modelCount === 1 ? '' : 's'}</span>
          ${keyChip}
          <span class="models-provider-actions">${keyBtn}${removeKeyBtn}</span>
        </li>`;
      }).join('');
      list.querySelectorAll<HTMLInputElement>('input[data-provider-toggle]').forEach((cb) => {
        cb.onchange = () => {
          const providerId = cb.dataset['providerToggle']!;
          void (async () => {
            try {
              const result = await ipcCall<{ ok?: boolean; message?: string }>('models:setProviderEnabled', { providerId, enabled: cb.checked });
              if (result?.ok === false) {
                cb.checked = !cb.checked;
                alert(result.message ?? 'Could not update provider.');
              }
            } catch (e) {
              cb.checked = !cb.checked;
              alert(e instanceof Error ? e.message : String(e));
            }
            void refreshModelsPanel();
          })();
        };
      });
      list.querySelectorAll<HTMLButtonElement>('button[data-provider-key]').forEach((btn) => {
        btn.onclick = () => {
          const provider = data.providers.find((p) => p.id === btn.dataset['providerKey']);
          if (provider) void promptProviderApiKey(provider);
        };
      });
      list.querySelectorAll<HTMLButtonElement>('button[data-provider-clear-key]').forEach((btn) => {
        btn.onclick = () => {
          void (async () => {
            const providerId = btn.dataset['providerClearKey']!;
            if (!await gConfirm('Remove API key?', 'Remove the stored API key and disable this provider?')) return;
            await ipcCall('models:clearProviderKey', { providerId });
            void refreshModelsPanel();
          })();
        };
      });
    }
  } catch { /* non-fatal */ }
}


export async function refreshAiActivityRollup(): Promise<void> {
  try {
    const data = await ipcCall<{
      windowDays: number;
      byClient: Array<{ client: string; events: number; lastSeenMs: number }>;
      byTool: Array<{ tool: string; events: number; lastSeenMs: number }>;
      skillWalks: Array<{ sourceId: string; whenMs: number }>;
    }>('mcp:activitySummary', {});
    const empty = document.getElementById('activity-ai-rollup-empty');
    const body = document.getElementById('activity-ai-rollup-body');
    const skillsBlock = document.getElementById('activity-ai-skills-block');
    const hasAny = data.byClient.length > 0 || data.byTool.length > 0;
    if (empty) empty.style.display = hasAny ? 'none' : '';
    if (body) body.style.display = hasAny ? 'grid' : 'none';

    const clientList = document.getElementById('activity-ai-clients-list');
    if (clientList) {
      const top = [...data.byClient].sort((a, b) => b.events - a.events).slice(0, 8);
      clientList.innerHTML = top.length === 0
        ? '<li class="subtitle" style="font-size: 12px;">No external client activity in the window.</li>'
        : top.map((c) => `<li style="padding: 4px 0; display: flex; gap: 6px;">
          <span>${escapeHtml(c.client)}</span>
          <span class="subtitle" style="font-size: 12px; margin-left: auto;">${c.events} call${c.events === 1 ? '' : 's'}</span>
        </li>`).join('');
    }
    const toolList = document.getElementById('activity-ai-tools-list');
    if (toolList) {
      const top = [...data.byTool].sort((a, b) => b.events - a.events).slice(0, 8);
      toolList.innerHTML = top.length === 0
        ? '<li class="subtitle" style="font-size: 12px;">No Ghampus tool calls in the window.</li>'
        : top.map((t) => `<li style="padding: 4px 0; display: flex; gap: 6px;">
          <code style="font-size: 12px;">${escapeHtml(t.tool)}</code>
          <span class="subtitle" style="font-size: 12px; margin-left: auto;">${t.events} call${t.events === 1 ? '' : 's'}</span>
        </li>`).join('');
    }
    if (skillsBlock) {
      skillsBlock.style.display = data.skillWalks.length > 0 ? '' : 'none';
      const skillsList = document.getElementById('activity-ai-skills-list');
      if (skillsList) {
        const now = Date.now();
        skillsList.innerHTML = data.skillWalks.slice(0, 5).map((w) => {
          const ago = Math.floor((now - w.whenMs) / 3600000);
          return `<li style="padding: 4px 0;">
            <code style="font-size: 12px;">${escapeHtml(w.sourceId)}</code>
            <span class="subtitle" style="font-size: 12px; margin-left: 8px;">${ago}h ago</span>
          </li>`;
        }).join('');
      }
    }
  } catch { /* non-fatal */ }
}


// ── Attachments — Linked files panel ──────────────────────────────────
const FULL_CORTEX = '__full__';

function resolveAttachGraphId(): string {
  const loadedGraphs = app().getLoadedGraphs();
  const atlasActiveGraph = app().getAtlasActiveGraph();
  return (atlasActiveGraph && atlasActiveGraph !== FULL_CORTEX)
    ? atlasActiveGraph
    : (loadedGraphs.find((g) => !g.graphId.startsWith('__'))?.graphId ?? loadedGraphs[0]?.graphId ?? '');
}

interface AttachmentRow {
  id: string;
  path: string;
  kind: string;
  label: string;
  note?: string;
  graphId: string;
  sourceId?: string;
  nodeIds?: string[];
  lastVerifiedOk: boolean;
  sizeBytes?: number;
  addedAt?: number;
}

const ATTACHMENT_KIND_ICONS: Record<string, string> = {
  image: '🖼',
  pdf: '📕',
  doc: '📄',
  spreadsheet: '📊',
  video: '🎬',
  audio: '🎵',
  archive: '🗜',
  code: '⌨︎',
  onenote: '📓',
  other: '📎',
};

export async function refreshGhampusAttachments(): Promise<void> {
  try {
    const res = await ipcCall<{ attachments: AttachmentRow[] }>('attachments:list', {});
    const badge = document.getElementById('ghampus-files-pill-badge');
    if (badge) {
      if (res.attachments.length > 0) { badge.textContent = String(res.attachments.length); badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }
    const ul = document.getElementById('ghampus-attachments-list');
    if (ul) {
      ul.innerHTML = res.attachments.slice(0, 12).map((a) => {
        const icon = ATTACHMENT_KIND_ICONS[a.kind] ?? '📎';
        const stale = a.lastVerifiedOk ? '' : '<span class="subtitle" style="font-size: 10px; color: var(--g-warn, #c47); padding: 1px 5px; border: 1px solid var(--g-warn, #c47); border-radius: 3px;">not on this device</span>';
        const size = a.sizeBytes ? formatAttachmentBytes(a.sizeBytes) : '';
        // Broken attachments get a "Find new location…" repair button —
        // the user picks the moved file; if we stored a content hash, we
        // verify the new file matches before re-pointing.
        const repairBtn = a.lastVerifiedOk
          ? ''
          : `<button class="g-btn" type="button" data-attach-repair="${escapeHtml(a.id)}" style="font-size: 10px; padding: 1px 6px;">Find new location…</button>`;
        // Vision actions for image attachments: (A) Describe is open to
        // everyone; (B) Extract entities + relationships is Pro; (C)
        // Annotate opens the manual canvas surface.
        const visionBtns = a.kind === 'image' && a.lastVerifiedOk
          ? `<button class="g-btn" type="button" data-attach-describe="${escapeHtml(a.id)}" style="font-size: 10px; padding: 1px 6px;" title="Generate a text description via vision model (A)">🔍 Describe</button>
             <button class="g-btn" type="button" data-attach-extract="${escapeHtml(a.id)}" style="font-size: 10px; padding: 1px 6px;" title="Extract entities + relationships as graph structure (B · Pro)">✨ Extract</button>
             <button class="g-btn" type="button" data-attach-annotate="${escapeHtml(a.id)}" style="font-size: 10px; padding: 1px 6px;" title="Manually annotate boxes + arrows (C)">✏️ Annotate</button>`
          : '';
        return `<li style="padding: 6px 0; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;">
          <span>${icon}</span>
          <strong style="font-size: 13px; cursor: pointer;" data-attach-open="${escapeHtml(a.path)}" title="${a.lastVerifiedOk ? 'Open in default app' : 'File not found — pick its new location'}">${escapeHtml(a.label)}</strong>
          <code style="font-size: 11px; opacity: .6;">${escapeHtml(a.graphId)}</code>
          ${stale}
          <span class="subtitle" style="font-size: 11px;">${size}</span>
          ${repairBtn}
          ${visionBtns}
          <button class="g-btn" type="button" data-attach-detach="${escapeHtml(a.id)}" style="font-size: 10px; padding: 1px 6px; opacity: .6;">remove</button>
        </li>`;
      }).join('');
      ul.querySelectorAll<HTMLButtonElement>('[data-attach-describe]').forEach((b) => {
        b.onclick = () => {
          void (async () => {
            const id = b.dataset['attachDescribe']!;
            b.textContent = '⏳ Describing…';
            b.disabled = true;
            try {
              const result = await ipcCall<{ ok: boolean; description?: string; reason?: string; error?: string }>('attachments:describeImage', { attachmentId: id, ingestAsSource: true });
              if (!result.ok) {
                void gAlert('Vision describe failed', `${result.reason ?? 'unknown'} — ${result.error ?? 'is Ollama running with llama3.2-vision installed?'}`);
                return;
              }
              void gAlert('Saved as memory', `Description ingested into the engram. First lines: "${(result.description ?? '').slice(0, 200)}…"`);
              void refreshGhampusAttachments();
            } finally {
              b.disabled = false;
              b.textContent = '🔍 Describe';
            }
          })();
        };
      });
      ul.querySelectorAll<HTMLButtonElement>('[data-attach-extract]').forEach((b) => {
        b.onclick = () => {
          void (async () => {
            const id = b.dataset['attachExtract']!;
            b.textContent = '⏳ Extracting…';
            b.disabled = true;
            try {
              const result = await ipcCall<{ ok: boolean; nodes?: Array<{ id: string; label: string; category?: string; note?: string }>; edges?: Array<{ from: string; to: string; label?: string; directed?: boolean }>; reason?: string; error?: string; message?: string }>('attachments:extractStructure', { attachmentId: id });
              if (!result.ok) {
                void gAlert('Extraction failed', result.message ?? result.error ?? result.reason ?? 'unknown');
                return;
              }
              const nodes = result.nodes ?? [];
              const edges = result.edges ?? [];
              if (nodes.length === 0) {
                void gAlert('Nothing to extract', 'The model didn\'t find any boxes or labeled elements in this image.');
                return;
              }
              const preview = `${nodes.length} entit${nodes.length === 1 ? 'y' : 'ies'}, ${edges.length} relationship${edges.length === 1 ? '' : 's'}.\n\nEntities:\n${nodes.slice(0, 6).map((n) => `  • ${n.label}${n.category ? ` (${n.category})` : ''}`).join('\n')}${nodes.length > 6 ? `\n  …and ${nodes.length - 6} more` : ''}\n\nSave them to the engram as a new structured memory?`;
              const ok = await gConfirm('Vision extracted a diagram', preview);
              if (!ok) return;
              const commit = await ipcCall<{ ok: boolean; sourceId?: string; reason?: string }>('attachments:commitExtraction', {
                attachmentId: id,
                nodes,
                edges,
              });
              if (!commit.ok) {
                void gAlert('Commit failed', commit.reason ?? 'unknown');
                return;
              }
              void gAlert('Saved', `Extracted graph structure committed as a new source in the engram.`);
              void refreshGhampusAttachments();
            } finally {
              b.disabled = false;
              b.textContent = '✨ Extract';
            }
          })();
        };
      });
      ul.querySelectorAll<HTMLButtonElement>('[data-attach-annotate]').forEach((b) => {
        b.onclick = () => {
          void (async () => {
            const id = b.dataset['attachAnnotate']!;
            void openAnnotationModal(id);
          })();
        };
      });
      ul.querySelectorAll<HTMLButtonElement>('[data-attach-repair]').forEach((b) => {
        b.onclick = () => {
          void (async () => {
            const id = b.dataset['attachRepair']!;
            const newPath = await invoke<string | null>('pick_attachment_file', {}).catch(() => null);
            if (!newPath) return;
            let result = await ipcCall<{ ok: boolean; reason?: string; storedHash?: string; candidateHash?: string }>('attachments:repair', { id, newPath });
            if (!result.ok && result.reason === 'hash_mismatch') {
              const cont = await gConfirm(
                'That file looks different',
                'The file at this path doesn\'t match the content fingerprint Graphnosis recorded when you first attached. It might be a different file, an edited copy, or a similarly-named one. Re-point the attachment anyway?',
              );
              if (!cont) return;
              result = await ipcCall<{ ok: boolean; reason?: string }>('attachments:repair', { id, newPath, force: true });
            }
            if (!result.ok) {
              void gAlert('Repair failed', result.reason ?? 'Unknown error');
              return;
            }
            void refreshGhampusAttachments();
          })();
        };
      });
      ul.querySelectorAll<HTMLElement>('[data-attach-open]').forEach((el) => {
        el.onclick = () => {
          const p = el.dataset['attachOpen']!;
          void invoke('open_attachment_in_default_app', { path: p }).catch((err) => {
            void gAlert('Could not open file', String(err));
          });
        };
      });
      ul.querySelectorAll<HTMLButtonElement>('[data-attach-detach]').forEach((b) => {
        b.onclick = () => {
          void (async () => {
            const id = b.dataset['attachDetach']!;
            if (!await gConfirm('Remove linked file?', 'The file stays on disk — Graphnosis just stops tracking it.')) return;
            await ipcCall('attachments:detach', { id });
            void refreshGhampusAttachments();
          })();
        };
      });
    }
  } catch { /* non-fatal */ }
}

// ── Manual annotation modal (Phase C, V1 scaffolding) ──────────────────
//
// Click on the image to drop a labeled box. Each click prompts for a
// label. Save commits the boxes to the engram as a new structured
// source — each box becomes a node, the engram entity-link pass auto-
// connects them to existing memories about the same labels.
//
// V1 scope deliberately limited to: image background, click-to-add box
// with label, save. No arrows, no resize, no drag, no multi-select. The
// data structure is forward-compatible — adding edges (V2) just extends
// the same payload shape and ships through the same commit IPC.

interface AnnotationBox {
  id: string;
  /** Normalized 0-1 position within the image (top-left of box). */
  x: number;
  y: number;
  /** Normalized width/height. V1 uses a fixed visual size for clarity. */
  w: number;
  h: number;
  label: string;
}

let annotationState: { attachmentId: string; boxes: AnnotationBox[] } | null = null;

async function openAnnotationModal(attachmentId: string): Promise<void> {
  const res = await ipcCall<{ attachments: AttachmentRow[] }>('attachments:list', {}).catch(() => ({ attachments: [] as AttachmentRow[] }));
  const att = res.attachments.find((a) => a.id === attachmentId);
  if (!att) { void gAlert('Attachment not found', ''); return; }
  if (!att.lastVerifiedOk) { void gAlert('File not on this device', 'Repair the attachment first.'); return; }

  const modal = document.getElementById('annotation-modal');
  const img = document.getElementById('annotation-image') as HTMLImageElement | null;
  const overlay = document.getElementById('annotation-overlay');
  if (!modal || !img || !overlay) return;

  annotationState = { attachmentId, boxes: [] };
  // We load the image via a file:// URL — Tauri's webview allows this on
  // explicit user action. For paths that aren't accessible (network
  // shares, etc.) the image just fails to load and the modal stays empty.
  img.src = `file://${att.path}`;
  overlay.innerHTML = '';

  // Click to add a box at the click position.
  overlay.onclick = (e) => {
    void (async () => {
      const rect = overlay.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const label = (await gPrompt('Label for this box', '', { secret: false }))?.trim();
      if (!label) return;
      const box: AnnotationBox = {
        id: `b${annotationState!.boxes.length + 1}`,
        x: Math.max(0, x - 0.06),
        y: Math.max(0, y - 0.02),
        w: 0.12,
        h: 0.04,
        label,
      };
      annotationState!.boxes.push(box);
      renderAnnotationBoxes(overlay);
    })();
  };

  modal.classList.remove('hidden');
}

function renderAnnotationBoxes(overlay: HTMLElement): void {
  overlay.innerHTML = '';
  if (!annotationState) return;
  for (const b of annotationState.boxes) {
    const el = document.createElement('div');
    el.style.cssText = `position: absolute; left: ${(b.x * 100).toFixed(2)}%; top: ${(b.y * 100).toFixed(2)}%; width: ${(b.w * 100).toFixed(2)}%; height: ${(b.h * 100).toFixed(2)}%; border: 2px solid var(--accent, #6366f1); background: rgba(99, 102, 241, .15); border-radius: 4px; display: flex; align-items: center; justify-content: center; pointer-events: none;`;
    const label = document.createElement('span');
    label.textContent = b.label;
    label.style.cssText = 'background: var(--accent, #6366f1); color: white; padding: 2px 8px; border-radius: 3px; font-size: 12px; font-weight: 500; white-space: nowrap;';
    el.appendChild(label);
    overlay.appendChild(el);
  }
}

function wireAnnotationModalControls(): void {
  document.getElementById('btn-annotation-close')?.addEventListener('click', () => {
    document.getElementById('annotation-modal')?.classList.add('hidden');
    annotationState = null;
  });
  document.getElementById('btn-annotation-clear')?.addEventListener('click', () => {
    if (!annotationState) return;
    annotationState.boxes = [];
    const overlay = document.getElementById('annotation-overlay');
    if (overlay) renderAnnotationBoxes(overlay);
  });
  document.getElementById('btn-annotation-save')?.addEventListener('click', () => {
    void (async () => {
      if (!annotationState || annotationState.boxes.length === 0) {
        void gAlert('Nothing to save', 'Click on the image to add at least one labeled box.');
        return;
      }
      // Commit through the same extraction-commit IPC the vision flow
      // uses — annotated boxes become nodes, no edges yet (V2).
      const nodes = annotationState.boxes.map((b) => ({
        id: b.id,
        label: b.label,
        category: 'other' as const,
      }));
      const result = await ipcCall<{ ok: boolean; reason?: string }>('attachments:commitExtraction', {
        attachmentId: annotationState.attachmentId,
        nodes,
        edges: [],
      });
      if (!result.ok) {
        void gAlert('Commit failed', result.reason ?? 'unknown');
        return;
      }
      void gAlert('Saved', `${annotationState.boxes.length} annotated node${annotationState.boxes.length === 1 ? '' : 's'} committed.`);
      document.getElementById('annotation-modal')?.classList.add('hidden');
      annotationState = null;
      void refreshGhampusAttachments();
    })();
  });
}
function formatAttachmentBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function wireGhampusAttachButtons(): void {
  const attachFileBtn = document.getElementById('btn-ghampus-attach-file');
  if (attachFileBtn && !attachFileBtn.dataset.wired) {
    attachFileBtn.dataset.wired = '1';
    attachFileBtn.addEventListener('click', () => {
      void (async () => {
        try {
          const picked = await invoke<string | null>('pick_attachment_file', {});
          if (!picked) return;
          const graphId = resolveAttachGraphId();
          if (!graphId) {
            void gAlert('No engram selected', 'Pick an active engram from the header dropdown first, then attach.');
            return;
          }
          await ipcCall('attachments:attach', { path: picked, graphId });
          void refreshGhampusAttachments();
        } catch (err) {
          void gAlert('Attach failed', String(err));
        }
      })();
    });
  }
  const attachPathBtn = document.getElementById('btn-ghampus-attach-path');
  if (attachPathBtn && !attachPathBtn.dataset.wired) {
    attachPathBtn.dataset.wired = '1';
    attachPathBtn.addEventListener('click', () => {
      void (async () => {
        const p = await gPrompt(
          'Path or URI to attach',
          'Examples:\n  /Users/you/docs/report.pdf\n  //server/share/file.docx\n  onenote:https://...\n  smb://...',
          { secret: false, placeholder: '/path/to/file or URI' },
        );
        if (!p?.trim()) return;
        const graphId = resolveAttachGraphId();
        if (!graphId) {
          void gAlert('No engram found', 'Open Your Cortex, select an engram, then try attaching again.');
          return;
        }
        try {
          await ipcCall('attachments:attach', { path: p.trim(), graphId });
          void refreshGhampusAttachments();
        } catch (err) {
          void gAlert('Attach failed', String(err));
        }
      })();
    });
  }
}

export async function refreshGhampusSavings(): Promise<void> {
  try {
    const res = await ipcCall<{
      windowDays: number;
      totalEvents: number;
      totalSavedUsd: number;
      baselineModel?: string;
      weekly?: Array<{ weekStartMs: number; eventCount: number; savedUsd: number }>;
      byKind: {
        'recall-only': { events: number; savedUsd: number };
        routing: { events: number; savedUsd: number };
        walk: { events: number; savedUsd: number };
      };
      reportLine: string;
    }>('savings:summary', { windowDays: 30 });
    const total = document.getElementById('ghampus-savings-total');
    const recall = document.getElementById('ghampus-savings-recall');
    const routing = document.getElementById('ghampus-savings-routing');
    if (total) total.textContent = `$${res.totalSavedUsd.toFixed(2)}`;
    if (recall) recall.textContent = String(res.byKind['recall-only'].events);
    if (routing) routing.textContent = String(res.byKind.routing.events);

    const sparkEl = document.getElementById('ghampus-savings-sparkline');
    if (sparkEl) {
      const weeks = (res.weekly ?? []).slice(0, 8).reverse();
      if (weeks.length === 0 || res.totalEvents === 0) {
        sparkEl.classList.add('hidden');
        sparkEl.innerHTML = '';
      } else {
        const max = Math.max(...weeks.map((w) => w.savedUsd), 0.001);
        const bars = weeks.map((w) => {
          const pctH = w.savedUsd > 0 ? Math.max(8, Math.round((w.savedUsd / max) * 100)) : 2;
          const label = new Date(w.weekStartMs).toLocaleDateString([], { month: 'short', day: 'numeric' });
          return `<span class="home-spark-bar${w.savedUsd > 0 ? '' : ' empty'}" style="--bar-h:${pctH}%" title="${label}: $${w.savedUsd.toFixed(2)}"></span>`;
        }).join('');
        sparkEl.innerHTML = bars;
        sparkEl.classList.remove('hidden');
        sparkEl.removeAttribute('aria-hidden');
        if (res.baselineModel) {
          sparkEl.setAttribute('title', `Weekly savings vs ${res.baselineModel}`);
        }
      }
    }
  } catch { /* non-fatal */ }
}

export async function refreshGhampusNotifications(): Promise<void> {
  try {
    const lastVisited = Number(localStorage.getItem(GHAMPUS_LAST_VISITED_KEY)) || (Date.now() - 7 * 24 * 60 * 60 * 1000);
    const res = await ipcCall<{
      notifications: Array<{
        id: string;
        engramId: string;
        tier: 'public' | 'personal' | 'sensitive';
        sourceId: string;
        originKind: keyof typeof NOTIF_ORIGIN_ICONS;
        origin: string;
        label: string;
        ingestedAtMs: number;
      }>;
      totalAvailable: number;
    }>('agent:listNotifications', { sinceMs: lastVisited, limit: 12 });

    const badge = document.getElementById('ghampus-notif-pill-badge');
    if (badge) {
      if (res.notifications.length > 0) { badge.textContent = String(res.notifications.length); badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }
    const ul = document.getElementById('ghampus-notifications-list');
    if (ul) {
      const now = Date.now();
      ul.innerHTML = res.notifications.map((n) => {
        const ageMs = now - n.ingestedAtMs;
        const when = ageMs < 60_000 ? 'just now'
          : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)} min ago`
          : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h ago`
          : `${Math.floor(ageMs / 86_400_000)}d ago`;
        const icon = NOTIF_ORIGIN_ICONS[n.originKind] ?? '·';
        const previewLine = n.tier === 'sensitive'
          ? '<span class="subtitle" style="font-style: italic; font-size: 11px;">[preview hidden · sensitive engram]</span>'
          : `<span class="subtitle" style="font-size: 11px;">${escapeHtml(n.label)}</span>`;
        return `<li style="padding: 8px 0; border-bottom: 1px solid var(--g-border, rgba(255,255,255,.05));">
          <div style="display: flex; gap: 8px; align-items: baseline;">
            <span>${icon}</span>
            <strong style="font-size: 13px;">${escapeHtml(n.origin)}</strong>
            <code style="font-size: 11px; opacity: .7;">${escapeHtml(n.engramId)}</code>
            <span class="subtitle" style="margin-left: auto; font-size: 11px;">${when}</span>
          </div>
          <div style="margin: 4px 0 0 24px;">${previewLine}</div>
        </li>`;
      }).join('');
    }
  } catch { /* non-fatal */ }
  try {
    const runs = await ipcCall<{ ok: boolean; runs: Array<{ status: string }> }>(
      'skill:listRuns',
      { status: 'blocked-on-human', limit: 5 },
    );
    const banner = document.getElementById('ghampus-blocked-runs-banner');
    const blocked = runs.runs ?? [];
    if (banner) {
      if (blocked.length) {
        banner.classList.remove('hidden');
        banner.textContent = `${blocked.length} playbook${blocked.length > 1 ? 's' : ''} blocked on human approval — see Activity → Skill runs.`;
      } else {
        banner.classList.add('hidden');
      }
    }
  } catch { /* non-fatal */ }
  // Record the visit AFTER the read so the next refresh shows what arrives
  // between now and the next visit, not what's already on screen.
  localStorage.setItem(GHAMPUS_LAST_VISITED_KEY, String(Date.now()));
}

export async function refreshGhampusSkills(): Promise<void> {
  try {
    const res = await ipcCall<{ skills: Array<{ sourceId: string; engramId: string; label: string; nodeCount: number; origin: 'local' | 'pack'; trainedAt?: string; recallBreadth?: number }> }>('agent:listSkills', {});
    const ul = document.getElementById('ghampus-skills-list');
    const badge = document.getElementById('ghampus-skills-pill-badge');
    if (badge) {
      if (res.skills.length > 0) {
        badge.textContent = String(res.skills.length);
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
    if (ul) {
      if (res.skills.length === 0) {
        ul.innerHTML = '<li class="ghampus-panel-empty">No skills in your library yet.</li>';
      } else {
        ul.innerHTML = res.skills.map((s) => {
          const displayLabel = s.label.replace(/^skill:\d+:/, '');
          const trained = s.trainedAt ? new Date(s.trainedAt).toLocaleDateString() : 'imported';
          const vitality = s.recallBreadth ?? 80;
          // strokeDashoffset = circumference * (1 - vitality/100), circumference ≈ 72 (r=11.5)
          const offset = (72 * (1 - vitality / 100)).toFixed(1);
          const color = vitality >= 70 ? '#10b981' : vitality >= 40 ? '#f59e0b' : '#ef4444';
          return `<li>
            <div class="ghampus-skill-row">
              <svg class="ghampus-skill-vitality" viewBox="0 0 28 28">
                <circle class="track" cx="14" cy="14" r="11.5"/>
                <circle class="fill" cx="14" cy="14" r="11.5"
                  stroke="${color}"
                  stroke-dashoffset="${offset}"/>
              </svg>
              <div class="ghampus-skill-info">
                <div class="ghampus-skill-name">${escapeHtml(displayLabel)}</div>
                <div class="ghampus-skill-meta">${trained}${s.origin === 'pack' ? ' · pack' : ''}</div>
              </div>
              <button class="ghampus-skill-run" type="button"
                      data-skill-source="${escapeHtml(s.sourceId)}">Run ▸</button>
            </div>
          </li>`;
        }).join('');
      }
    }
  } catch { /* non-fatal */ }
}

export async function refreshGhampusRecentSaves(): Promise<void> {
  try {
    const { saves } = await ipcCall<{ saves: Array<{ sourceId: string; engramId: string; label: string; addedAtMs: number }> }>('agent:recentSaves', { limit: 8 });
    const badge = document.getElementById('ghampus-saves-pill-badge');
    if (badge) {
      if (saves.length > 0) { badge.textContent = String(saves.length); badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }
    const ul = document.getElementById('ghampus-recent-saves-list');
    if (ul) {
      if (saves.length === 0) {
        ul.innerHTML = '<li class="ghampus-panel-empty">Nothing saved through chats yet.</li>';
      } else {
        const now = Date.now();
        ul.innerHTML = saves.map((s) => {
          const ageMs = now - s.addedAtMs;
          const when = ageMs < 60_000 ? 'just now'
            : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)} min ago`
            : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h ago`
            : `${Math.floor(ageMs / 86_400_000)}d ago`;
          return `<li><div class="ghampus-panel-item">
            <span class="ghampus-panel-item-label">${escapeHtml(s.label)}</span>
            <span class="ghampus-panel-item-meta">${escapeHtml(s.engramId)}</span>
            <span class="ghampus-panel-item-meta">${when}</span>
          </div></li>`;
        }).join('');
      }
    }
  } catch { /* non-fatal */ }
}

export async function refreshGhampusSharingPanel(): Promise<void> {
  try {
    const info = await ipcCall<{ seats: number | null; activeCount: number; plan: string | null }>('sharing:planInfo', {});
    const list = await ipcCall<Array<{ id: string; name: string; role: string; expiresAt: number | null; createdAt: number }>>('sharing:list', {});
    const ul = document.getElementById('ghampus-sharing-list');
    const badge = document.getElementById('ghampus-shares-pill-badge');
    if (badge) {
      if (info.activeCount > 0) { badge.textContent = String(info.activeCount); badge.classList.remove('hidden'); }
      else { badge.classList.add('hidden'); }
    }
    if (ul) {
      const now = Date.now();
      const WARN_MS = 72 * 60 * 60 * 1000;
      ul.innerHTML = list.map((t) => {
        const expiringSoon = t.expiresAt !== null && t.expiresAt - now < WARN_MS && t.expiresAt - now > 0;
        const expired = t.expiresAt !== null && t.expiresAt <= now;
        const expiryNote = expired
          ? '<span style="color: var(--g-warn, #c47);">expired</span>'
          : expiringSoon
            ? `<span style="color: var(--g-warn, #c47);">expires soon</span>`
            : t.expiresAt === null ? 'no expiry' : new Date(t.expiresAt).toLocaleDateString();
        return `<li><div class="ghampus-panel-item">
          <span class="ghampus-panel-item-label">${escapeHtml(t.name)}</span>
          <span class="ghampus-panel-item-meta">${escapeHtml(t.role)}</span>
          <span class="ghampus-panel-item-meta">${expiryNote}</span>
        </div></li>`;
      }).join('') || '<li class="ghampus-panel-empty">No active shares.</li>';
    }
  } catch { /* non-fatal */ }
}

// ── Ghampus chat surface ──────────────────────────────────────────────────

type GhampusChatMessage =
  | { kind: 'user'; text: string; ts: number }
  | { kind: 'ghampus'; text: string; ts: number }
  | { kind: 'skill-match'; skill: SkillMatchPayload; ts: number }
  | { kind: 'walk-plan'; plan: WalkPlan; ts: number }
  | { kind: 'walk-progress'; steps: WalkStep[]; ts: number }
  | { kind: 'refine-proposal'; proposal: RefineProposal; ts: number }
  | { kind: 'tier-strip'; context: TierContext; ts: number }
  | { kind: 'proactive-card'; card: ProactiveCardPayload; ts: number };

interface ProactiveCardPayload {
  id: string; createdAt: number; signalType: string; signalLabel: string;
  skillSourceId: string; skillGraphId: string; skillLabel: string; why: string; status: string;
  totalStale?: number;
  batchSourceIds?: string[];
}

interface SkillMatchPayload {
  sourceId: string; label: string; steps: number; subSkills: number;
  lastRunAgo: string; vitality: number; description: string;
}
interface WalkPlan {
  sourceId: string; label: string; steps: WalkPlanStep[];
  totalCost: number; privacySafe: boolean; routing: 'adaptive' | 'local-only' | 'always-best';
  cloudRoutingReady?: boolean;
  graphId?: string | null;
  learningHint?: string;
}
interface WalkPlanStep {
  label: string; needs: string[]; model: string; isLocal: boolean; cost: number;
}
interface WalkStep { label: string; status: 'pending' | 'running' | 'done' | 'error'; }
interface RefineProposal {
  sourceId: string; observation: string; proposedStepCode: string;
  captureVars: string[]; footnote: string;
}
interface TierContext { pro: string; free: string; teams: string; }

const AWAY_DIGEST_PREFIX = '**While you were away**';
const QUIET_AWAY_DIGEST_RE = /all quiet/i;

function isQuietAwayDigest(msg: GhampusChatMessage): boolean {
  return msg.kind === 'ghampus'
    && msg.text.startsWith(AWAY_DIGEST_PREFIX)
    && QUIET_AWAY_DIGEST_RE.test(msg.text);
}

/** Collapse repeated quiet away digests in persisted history to the newest one. */
function dedupeAwayDigests(messages: GhampusChatMessage[]): GhampusChatMessage[] {
  let lastQuietIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isQuietAwayDigest(messages[i])) { lastQuietIdx = i; break; }
  }
  if (lastQuietIdx < 0) return messages;
  return messages.filter((msg, i) => !isQuietAwayDigest(msg) || i === lastQuietIdx);
}

function fmtRelTime(ts: number): string {
  const diffS = Math.floor((Date.now() - ts) / 1000);
  if (diffS < 60)  return 'just now';
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  if (diffS < 7 * 86400) return `${Math.floor(diffS / 86400)}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtAbsTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtTime(ts: number): string {
  return `<time datetime="${new Date(ts).toISOString()}" title="${escapeHtml(fmtAbsTime(ts))}">${fmtRelTime(ts)}</time>`;
}

const COPY_ICON = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0">
  <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
  <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5V9.5A1.5 1.5 0 0 0 3.5 11H5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

function copyBtn(plainText: string): string {
  return `<button class="chat-msg-copy" data-copy="${escapeHtml(plainText)}" title="Copy">${COPY_ICON}</button>`;
}

function renderChatMessage(msg: GhampusChatMessage): string {
  switch (msg.kind) {
    case 'user':
      return `<div class="chat-msg user">
        <div class="chat-msg-wrap">
          <div class="chat-msg-bubble">${escapeHtml(msg.text)}</div>
          <div class="chat-msg-meta">
            <div class="chat-msg-time">${fmtTime(msg.ts)}</div>
            ${copyBtn(msg.text)}
          </div>
        </div>
      </div>`;
    case 'ghampus':
      return `<div class="chat-msg ghampus">
        <div class="chat-msg-avatar">
          <img src="/graphnosis-logo-transparent-bg.png" alt="" />
        </div>
        <div class="chat-msg-wrap">
          <div class="chat-msg-bubble chat-msg-bubble--markdown">${app().renderMarkdownLite(msg.text)}</div>
          <div class="chat-msg-meta">
            <div class="chat-msg-time">${fmtTime(msg.ts)}</div>
            ${copyBtn(msg.text)}
          </div>
        </div>
      </div>`;
    case 'skill-match':
      return renderSkillMatchCard(msg.skill, msg.ts);
    case 'walk-plan':
      return renderWalkPlanCard(msg.plan);
    case 'walk-progress':
      return renderWalkProgress(msg.steps);
    case 'refine-proposal':
      return renderRefineCard(msg.proposal);
    case 'tier-strip':
      return renderTierStrip(msg.context);
    case 'proactive-card':
      return renderProactiveCard(msg.card);
    default:
      return '';
  }
}

function renderSkillMatchCard(skill: SkillMatchPayload, ts: number): string {
  const subChip = skill.subSkills > 0
    ? `<span class="skill-meta-chip">${skill.subSkills} sub-skill${skill.subSkills > 1 ? 's' : ''}</span>` : '';
  return `<div class="skill-match-card" data-skill-source="${escapeHtml(skill.sourceId)}">
    <div class="skill-match-card-header">
      <span style="font-size: 16px;">🎓</span>
      <span class="skill-match-card-name">${escapeHtml(skill.label)}</span>
    </div>
    <div class="skill-match-chips">
      <span class="skill-meta-chip">${skill.steps} steps</span>
      ${subChip}
      <span class="skill-meta-chip">last run ${escapeHtml(skill.lastRunAgo)}</span>
      <span class="skill-meta-chip">vitality ${skill.vitality}</span>
    </div>
    <p class="skill-match-desc">${escapeHtml(skill.description)}</p>
    <div class="skill-match-actions">
      <button class="g-btn primary btn-skill-run" style="font-size: 12px; padding: 4px 12px;"
              data-source-id="${escapeHtml(skill.sourceId)}">Run it?</button>
      <button class="g-btn btn-skill-dismiss" style="font-size: 12px; padding: 4px 10px;"
              data-source-id="${escapeHtml(skill.sourceId)}">Not now</button>
    </div>
  </div>`;
}

function renderProactiveCard(card: ProactiveCardPayload): string {
  if (card.signalType === 'skill-stale') {
    return renderSkillStaleCard(card);
  }
  const signalIcon = card.signalType === 'time-based' ? '⏰' : card.signalType === 'recent-ingest' ? '📥' : '🔍';
  const skillName = card.skillLabel.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const whyHtml = escapeHtml(card.why).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return `<div class="chat-msg ghampus">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="chat-msg-wrap">
      <div class="proactive-card" data-card-id="${escapeHtml(card.id)}" data-skill-source="${escapeHtml(card.skillSourceId)}">
        <div class="proactive-card-header">
          <div class="proactive-card-signal">${signalIcon} ${escapeHtml(card.signalLabel)}</div>
          <span class="proactive-card-label">Suggested action</span>
        </div>
        <p class="proactive-card-why">${whyHtml}</p>
        <div class="proactive-card-actions">
          <button class="g-btn primary proactive-card-run" data-card-id="${escapeHtml(card.id)}"
                  data-source-id="${escapeHtml(card.skillSourceId)}">Run ${escapeHtml(skillName)} ▸</button>
          <div class="proactive-snooze-wrap">
            <button class="g-btn proactive-card-snooze" data-card-id="${escapeHtml(card.id)}">Remind me later ▾</button>
            <div class="proactive-snooze-menu hidden">
              <button class="proactive-snooze-opt" data-mins="15">In 15 minutes</button>
              <button class="proactive-snooze-opt" data-mins="30">In 30 minutes</button>
              <button class="proactive-snooze-opt" data-mins="60">In 1 hour</button>
              <button class="proactive-snooze-opt" data-mins="480">This evening</button>
              <button class="proactive-snooze-opt" data-mins="1440">Tomorrow</button>
            </div>
          </div>
          <button class="g-btn proactive-card-dismiss" data-card-id="${escapeHtml(card.id)}">Dismiss</button>
        </div>
      </div>
      <div class="chat-msg-meta">
        <div class="chat-msg-time">${fmtTime(card.createdAt)}</div>
      </div>
    </div>
  </div>`;
}

function renderSkillStaleCard(card: ProactiveCardPayload): string {
  const skillName = card.skillLabel.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const whyHtml = escapeHtml(card.why).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const total = card.totalStale ?? 1;
  const batchBtn = total > 1
    ? `<button class="g-btn proactive-stale-batch" data-card-id="${escapeHtml(card.id)}">Retrain all ${total}</button>`
    : '';
  return `<div class="chat-msg ghampus">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="chat-msg-wrap">
      <div class="proactive-card proactive-card--skill-stale" data-card-id="${escapeHtml(card.id)}" data-skill-source="${escapeHtml(card.skillSourceId)}">
        <div class="proactive-card-header">
          <div class="proactive-card-signal">🔄 ${escapeHtml(card.signalLabel)}</div>
          <span class="proactive-card-label">Skill maintenance</span>
        </div>
        <p class="proactive-card-why">${whyHtml}</p>
        <div class="proactive-card-actions">
          <button class="g-btn primary proactive-stale-run" data-card-id="${escapeHtml(card.id)}"
                  data-source-id="${escapeHtml(card.skillSourceId)}">Retrain now${total === 1 ? ` · ${escapeHtml(skillName)}` : ''}</button>
          ${batchBtn}
          <div class="proactive-snooze-wrap">
            <button class="g-btn proactive-card-snooze" data-card-id="${escapeHtml(card.id)}">Tonight ▾</button>
            <div class="proactive-snooze-menu hidden">
              <button class="proactive-snooze-opt" data-mins="480">This evening</button>
              <button class="proactive-snooze-opt" data-mins="1440">Tomorrow</button>
              <button class="proactive-snooze-opt" data-mins="10080">Next week</button>
            </div>
          </div>
          <button class="g-btn proactive-stale-dismiss" data-card-id="${escapeHtml(card.id)}">Skip</button>
        </div>
      </div>
      <div class="chat-msg-meta">
        <div class="chat-msg-time">${fmtTime(card.createdAt)}</div>
      </div>
    </div>
  </div>`;
}

// ── Proactive card queue with idle-gating ─────────────────────────────────
// Cards arrive from the sidecar and are queued here. They are shown one at
// a time ONLY when the user has been idle — no interruption mid-thought.
const proactiveCardQueue: ProactiveCardPayload[] = [];
let lastGhampusActivity = Date.now();
// Minimum 5 min idle before the first card is ever shown.
const IDLE_BEFORE_FIRST_MS = 5 * 60_000;
// After each card, pick a random wait of 5–30 minutes before the next.
let nextCardAllowedAt = 0;
let proactiveQueueTimer: ReturnType<typeof setInterval> | null = null;

function trackGhampusActivity(): void {
  lastGhampusActivity = Date.now();
}

let _thinkingClearTimer: ReturnType<typeof setTimeout> | null = null;

function showThinkingBubble(): void {
  setGhampusRunning(true);
  if (_thinkingClearTimer) { clearTimeout(_thinkingClearTimer); _thinkingClearTimer = null; }

  if (document.getElementById('ghampus-thinking')) return;

  const thread = document.getElementById('ghampus-thread');
  if (!thread) return;

  document.getElementById('ghampus-thread-empty')?.remove();

  const entry = document.createElement('div');
  entry.id = 'ghampus-thinking';
  entry.className = 'ghampus-thread-entry';
  entry.innerHTML = `<div class="ghampus-thinking-bubble">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="ghampus-thinking-dots">
      <span></span><span></span><span></span>
    </div>
  </div>`;
  thread.appendChild(entry);
  thread.scrollTop = thread.scrollHeight;
}

function clearThinkingBubble(): void {
  // Keep the bubble visible for at least 400 ms so a fast LLM response
  // doesn't make it flash imperceptibly.
  if (_thinkingClearTimer) return;
  _thinkingClearTimer = setTimeout(() => {
    document.getElementById('ghampus-thinking')?.remove();
    _thinkingClearTimer = null;
    setGhampusRunning(false);
  }, 400);
}

/** Sidecar → UI events (message stream, thinking indicator, proactive cards). */
function wireGhampusSidecarEvents(): void {
  void listen<GhampusChatMessage>(
    'graphnosis://ghampus-message',
    (ev) => {
      if (!ev.payload) return;
      clearThinkingBubble();
      clearSkillRunning();
      const pane = document.querySelector<HTMLElement>('.mode-pane[data-pane="ghampus"]');
      const away = !pane || pane.classList.contains('hidden');
      appendToThread(ev.payload);
      if (away && ev.payload.kind === 'ghampus') {
        const preview = ev.payload.text.length > 72
          ? `${ev.payload.text.slice(0, 69)}…`
          : ev.payload.text;
        const id = app().addIngestToast('Ghampus replied', preview);
        app().finishIngestToast(id, 'success');
      }
    },
  );

  void listen<{ thinking: boolean; ts: number }>(
    'graphnosis://ghampus-thinking',
    () => { showThinkingBubble(); },
  );

  void listen<ProactiveCardPayload>(
    'graphnosis://ghampus-card',
    (ev) => {
      if (!ev.payload) return;
      proactiveCardQueue.push(ev.payload);
      startProactiveQueueTimer();
    },
  );
}

function randBetweenMs(minMin: number, maxMin: number): number {
  return (minMin + Math.floor((maxMin - minMin + 1) * (Date.now() % 1000) / 1000)) * 60_000;
}

function dequeueProactiveCard(): void {
  if (proactiveCardQueue.length === 0) return;
  const now = Date.now();
  const idleMs = now - lastGhampusActivity;
  if (idleMs < IDLE_BEFORE_FIRST_MS) return;
  if (nextCardAllowedAt > 0 && now < nextCardAllowedAt) return;

  const card = proactiveCardQueue.shift();
  if (!card) return;

  const pane = document.querySelector<HTMLElement>('.mode-pane[data-pane="ghampus"]');
  if (!pane || pane.classList.contains('hidden')) {
    proactiveCardQueue.unshift(card);
    return;
  }

  // Schedule next card 5–30 minutes from now (random)
  nextCardAllowedAt = now + randBetweenMs(5, 30);

  const msg: GhampusChatMessage = { kind: 'proactive-card', card, ts: card.createdAt };
  appendToThread(msg);
}

function startProactiveQueueTimer(): void {
  if (proactiveQueueTimer) return;
  proactiveQueueTimer = setInterval(dequeueProactiveCard, 30_000); // check every 30 s
}

function renderWalkPlanCard(plan: WalkPlan): string {
  const localOnly = plan.cloudRoutingReady === false || plan.routing === 'local-only';
  const totalFmt = plan.totalCost === 0 ? 'free' : `≈\$${plan.totalCost.toFixed(4)}`;
  const metaParts = [
    `${plan.steps.length} steps`,
    localOnly ? 'local only (Ollama)' : (plan.routing === 'adaptive' ? 'adaptive routing' : plan.routing.replace('-', ' ')),
    plan.privacySafe ? 'privacy-safe (no sensitive engrams)' : '',
  ].filter(Boolean).join(' · ');

  const rows = plan.steps.map((s) => {
    const needChips = s.needs.map((n) => `<span class="walk-plan-need-chip">${escapeHtml(n)}</span>`).join('');
    const costCell = s.cost === 0
      ? `<span class="walk-plan-step-cost free">free</span>`
      : `<span class="walk-plan-step-cost">\$${s.cost.toFixed(4)}</span>`;
    const modelClass = s.isLocal ? 'local' : 'cloud';
    const modelTag = (s.isLocal || localOnly) ? '' : '<span class="walk-plan-model-tag">BYOK</span>';
    const modelName = localOnly && !s.isLocal ? 'Ollama (fallback)' : s.model;
    return `<tr>
      <td>${escapeHtml(s.label)}</td>
      <td><div class="walk-plan-needs">${needChips}</div></td>
      <td><span class="walk-plan-model ${modelClass}">${escapeHtml(modelName)}</span>${modelTag}</td>
      <td>${costCell}</td>
    </tr>`;
  }).join('');

  const hint = plan.learningHint
    ? `<div class="walk-plan-hint"><span>💡</span><span>${escapeHtml(plan.learningHint)}</span></div>`
    : '';

  const confirmRouting = localOnly ? 'local-only' : 'adaptive';
  const confirmLabel = localOnly ? `Walk it locally · ${totalFmt}` : `Walk it · ${totalFmt}`;

  return `<div class="walk-plan-card" data-plan-source="${escapeHtml(plan.sourceId)}">
    <div class="walk-plan-header">
      <span class="walk-plan-title">${escapeHtml(plan.label)} walk plan</span>
      <span class="walk-plan-meta">${escapeHtml(metaParts)}</span>
      <span class="walk-plan-cost-badge">${totalFmt}</span>
    </div>
    <table class="walk-plan-table">
      <thead><tr>
        <th>STEP</th><th>NEEDS</th><th>WILL USE</th><th>EST. COST</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="walk-plan-actions">
      <button class="g-btn primary btn-walk-confirm" style="font-size: 12px; padding: 5px 14px;"
              data-source-id="${escapeHtml(plan.sourceId)}" data-routing="${confirmRouting}"
              ${plan.graphId ? `data-graph-id="${escapeHtml(plan.graphId)}"` : ''}>
        ${confirmLabel}
      </button>
      ${localOnly ? '' : `<button class="g-btn btn-walk-local" style="font-size: 12px; padding: 5px 12px;"
              data-source-id="${escapeHtml(plan.sourceId)}"
              ${plan.graphId ? `data-graph-id="${escapeHtml(plan.graphId)}"` : ''}>
        Local-only this time (slower)
      </button>`}
      <button class="g-btn btn-walk-cancel" style="font-size: 12px; padding: 5px 10px;"
              data-source-id="${escapeHtml(plan.sourceId)}">Cancel</button>
    </div>
    ${hint}
  </div>`;
}

function renderWalkProgress(steps: WalkStep[]): string {
  const rows = steps.map((s, i) => {
    const icon = s.status === 'done' ? '✓'
      : s.status === 'running' ? String(i + 1)
      : s.status === 'error' ? '✕' : '';
    return `<div class="walk-step ${s.status}">
      <div class="walk-step-icon">${icon}</div>
      <span>${escapeHtml(s.label)}</span>
    </div>`;
  }).join('');
  return `<div class="walk-step-list">${rows}</div>`;
}

function renderRefineCard(proposal: RefineProposal): string {
  return `<div class="refine-card" data-refine-source="${escapeHtml(proposal.sourceId)}">
    <div class="refine-card-header">
      <span style="font-size: 15px;">🎓</span>
      <span class="refine-card-title">I've watched this skill walk for 3 weeks straight. Refine it?</span>
    </div>
    <p class="refine-card-obs">${escapeHtml(proposal.observation)}</p>
    <pre class="refine-card-code">${escapeHtml(proposal.proposedStepCode)}</pre>
    <div class="refine-card-actions">
      <button class="btn-refine-primary btn-refine-update"
              data-source-id="${escapeHtml(proposal.sourceId)}">Update ${escapeHtml(proposal.sourceId.split(':').pop() ?? 'skill')}</button>
      <button class="btn-refine-secondary btn-refine-edit"
              data-source-id="${escapeHtml(proposal.sourceId)}">Edit step first</button>
      <button class="btn-refine-secondary btn-refine-skip"
              data-source-id="${escapeHtml(proposal.sourceId)}">Skip this week</button>
      <span class="refine-card-footnote">${escapeHtml(proposal.footnote)}</span>
    </div>
  </div>`;
}

function renderTierStrip(ctx: TierContext): string {
  const proLabel = `<div class="tier-strip-label active">Pro (this view)</div>`;
  const freeLabel = `<div class="tier-strip-label">Free</div>`;
  const teamsLabel = `<div class="tier-strip-label">Teams+</div>`;
  return `<div class="tier-strip">
    <div class="tier-strip-col">${proLabel}<div class="tier-strip-body">${escapeHtml(ctx.pro)}</div></div>
    <div class="tier-strip-col">${freeLabel}<div class="tier-strip-body">${escapeHtml(ctx.free)}</div></div>
    <div class="tier-strip-col">${teamsLabel}<div class="tier-strip-body">${escapeHtml(ctx.teams)}</div></div>
  </div>`;
}

// In-memory thread cache — cleared on pane enter; rebuilt from history IPC.
// When the sidecar stub is not yet wired this stays empty and the empty state shows.
let ghampusThreadMessages: GhampusChatMessage[] = [];

function appendToThread(msg: GhampusChatMessage, opts?: { skipCache?: boolean }): void {
  if (!opts?.skipCache) ghampusThreadMessages.push(msg);
  const container = document.getElementById('ghampus-chat-messages') ?? document.getElementById('ghampus-thread');
  if (!container) return;
  const empty = document.getElementById('ghampus-thread-empty');
  if (empty) empty.remove();
  const node = document.createElement('div');
  node.className = 'ghampus-thread-entry';
  node.innerHTML = renderChatMessage(msg);
  container.appendChild(node);
  wireThreadNodeActions(node, msg);
  const thread = document.getElementById('ghampus-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;
}

function wireThreadNodeActions(node: HTMLElement, msg: GhampusChatMessage): void {
  // Copy button — present on user + ghampus messages.
  node.querySelector<HTMLButtonElement>('.chat-msg-copy')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    const text = btn.dataset.copy ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      btn.classList.add('copied');
      btn.title = 'Copied!';
      setTimeout(() => { btn.classList.remove('copied'); btn.title = 'Copy'; }, 1500);
    });
  });

  if (msg.kind === 'skill-match') {
    node.querySelector<HTMLButtonElement>('.btn-skill-run')?.addEventListener('click', (e) => {
      const sourceId = (e.currentTarget as HTMLButtonElement).dataset.sourceId ?? '';
      void requestWalkPlan(sourceId);
    });
    node.querySelector<HTMLButtonElement>('.btn-skill-dismiss')?.addEventListener('click', (e) => {
      (e.currentTarget as HTMLElement).closest('.ghampus-thread-entry')?.remove();
    });
  }
  if (msg.kind === 'walk-plan') {
    node.querySelector<HTMLButtonElement>('.btn-walk-confirm')?.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const sourceId = btn.dataset.sourceId ?? '';
      const routing = (btn.dataset.routing as 'adaptive' | 'local-only') ?? 'local-only';
      const graphId = btn.dataset.graphId;
      showSkillRunning(msg.plan.label);
      void confirmWalk(sourceId, routing, graphId);
    });
    node.querySelector<HTMLButtonElement>('.btn-walk-local')?.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const sourceId = btn.dataset.sourceId ?? '';
      const graphId = btn.dataset.graphId;
      showSkillRunning(msg.plan.label);
      void confirmWalk(sourceId, 'local-only', graphId);
    });
    node.querySelector<HTMLButtonElement>('.btn-walk-cancel')?.addEventListener('click', (e) => {
      (e.currentTarget as HTMLElement).closest('.ghampus-thread-entry')?.remove();
    });
  }
  if (msg.kind === 'refine-proposal') {
    node.querySelector<HTMLButtonElement>('.btn-refine-update')?.addEventListener('click', (e) => {
      const sourceId = (e.currentTarget as HTMLButtonElement).dataset.sourceId ?? '';
      void sendRefineResponse(sourceId, 'update');
    });
    node.querySelector<HTMLButtonElement>('.btn-refine-edit')?.addEventListener('click', (e) => {
      const sourceId = (e.currentTarget as HTMLButtonElement).dataset.sourceId ?? '';
      void sendRefineResponse(sourceId, 'edit');
    });
    node.querySelector<HTMLButtonElement>('.btn-refine-skip')?.addEventListener('click', (e) => {
      const sourceId = (e.currentTarget as HTMLButtonElement).dataset.sourceId ?? '';
      void sendRefineResponse(sourceId, 'skip');
    });
  }
  if (msg.kind === 'proactive-card') {
    if (msg.card.signalType === 'skill-stale') {
      wireSkillStaleCardActions(node, msg.card);
      return;
    }
    node.querySelector<HTMLButtonElement>('.proactive-card-run')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const cardId = btn.dataset.cardId ?? '';
      const sourceId = btn.dataset.sourceId ?? '';
      await ipcCall('ghampus:inbox:run', { id: cardId }).catch(() => {});
      // Grab the skill label from the button text ("Run Skill Name ▸")
      const btnText = btn.textContent ?? '';
      const skillLabel = btnText.replace(/^Run\s+/, '').replace(/\s*▸\s*$/, '').trim();
      const signalEl = node.querySelector<HTMLElement>('.proactive-card-signal');
      const signalLabel = signalEl?.textContent?.replace(/^[⏰📥🔍]\s*/, '').trim();
      void requestWalkPlan(sourceId, skillLabel || undefined, signalLabel || undefined, card.skillGraphId);
      node.querySelector<HTMLElement>('.proactive-card-actions')?.remove();
    });
    // Snooze toggle — show/hide the dropdown menu
    node.querySelector<HTMLButtonElement>('.proactive-card-snooze')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = (e.currentTarget as HTMLElement)
        .closest('.proactive-snooze-wrap')?.querySelector<HTMLElement>('.proactive-snooze-menu');
      if (menu) menu.classList.toggle('hidden');
    });
    // Snooze option selected
    node.querySelectorAll<HTMLButtonElement>('.proactive-snooze-opt').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const mins = Number((e.currentTarget as HTMLButtonElement).dataset.mins ?? 60);
        const cardId = node.querySelector<HTMLElement>('[data-card-id]')?.dataset.cardId ?? '';
        await ipcCall('ghampus:inbox:snooze', { id: cardId, snoozeMs: mins * 60_000 }).catch(() => {});
        // Push next card window out by the snooze duration too
        nextCardAllowedAt = Math.max(nextCardAllowedAt, Date.now() + mins * 60_000);
        const label = btn.textContent ?? 'later';
        node.querySelector<HTMLElement>('.proactive-card')?.classList.add('proactive-card--snoozed');
        const actionsEl = node.querySelector<HTMLElement>('.proactive-card-actions');
        if (actionsEl) actionsEl.innerHTML = `<span style="font-size:12px;opacity:.5;">Snoozed — I'll remind you ${label.toLowerCase().replace('in ', 'in ')}</span>`;
      });
    });
    node.querySelector<HTMLButtonElement>('.proactive-card-dismiss')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const cardId = btn.dataset.cardId ?? '';
      await ipcCall('ghampus:inbox:dismiss', { id: cardId }).catch(() => {});
      btn.closest('.ghampus-thread-entry')?.remove();
    });
  }
}

function wireSkillStaleCardActions(node: HTMLElement, card: ProactiveCardPayload): void {
  node.querySelector<HTMLButtonElement>('.proactive-stale-run')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const cardId = btn.dataset.cardId ?? '';
    btn.disabled = true;
    setGhampusRunning(true);
    try {
      const res = await ipcCall<{ ok: boolean; retrained?: string[]; errors?: string[] }>(
        'ghampus:skillMaintenance:run',
        { cardId, sourceId: card.skillSourceId },
      );
      const label = card.skillLabel.replace(/-/g, ' ');
      const text = res.ok
        ? `Retrained **${label}** — skill is back in sync with your cortex.`
        : `Retrain didn't complete: ${res.errors?.[0] ?? 'unknown error'}`;
      appendToThread({ kind: 'ghampus', text, ts: Date.now() });
      node.querySelector<HTMLElement>('.proactive-card-actions')?.remove();
    } finally {
      setGhampusRunning(false);
    }
  });
  node.querySelector<HTMLButtonElement>('.proactive-stale-batch')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const cardId = btn.dataset.cardId ?? '';
    const total = card.totalStale ?? 1;
    const ok = await gConfirm(
      'Retrain all stale skills?',
      `This will retrain all ${total} queued skills now. It may take a few minutes.`,
    );
    if (!ok) return;
    btn.disabled = true;
    setGhampusRunning(true);
    try {
      const res = await ipcCall<{ ok: boolean; retrained?: string[] }>(
        'ghampus:skillMaintenance:run',
        { cardId, batch: true },
      );
      const n = res.retrained?.length ?? 0;
      appendToThread({
        kind: 'ghampus',
        text: res.ok
          ? `Retrained **${n}** skill${n === 1 ? '' : 's'} — queue cleared for those entries.`
          : 'Batch retrain did not complete. Check the Skills library for details.',
        ts: Date.now(),
      });
      node.querySelector<HTMLElement>('.proactive-card-actions')?.remove();
    } finally {
      setGhampusRunning(false);
    }
  });
  node.querySelector<HTMLButtonElement>('.proactive-card-snooze')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = (e.currentTarget as HTMLElement)
      .closest('.proactive-snooze-wrap')?.querySelector<HTMLElement>('.proactive-snooze-menu');
    if (menu) menu.classList.toggle('hidden');
  });
  node.querySelectorAll<HTMLButtonElement>('.proactive-snooze-opt').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const mins = Number((e.currentTarget as HTMLButtonElement).dataset.mins ?? 480);
      const cardId = card.id;
      await ipcCall('ghampus:skillMaintenance:snooze', { cardId, snoozeMs: mins * 60_000 }).catch(() => {});
      nextCardAllowedAt = Math.max(nextCardAllowedAt, Date.now() + mins * 60_000);
      const label = btn.textContent ?? 'later';
      node.querySelector<HTMLElement>('.proactive-card')?.classList.add('proactive-card--snoozed');
      const actionsEl = node.querySelector<HTMLElement>('.proactive-card-actions');
      if (actionsEl) {
        actionsEl.innerHTML = `<span style="font-size:12px;opacity:.5;">Snoozed — I'll remind you ${label.toLowerCase()}</span>`;
      }
    });
  });
  node.querySelector<HTMLButtonElement>('.proactive-stale-dismiss')?.addEventListener('click', async () => {
    await ipcCall('ghampus:skillMaintenance:dismiss', { cardId: card.id }).catch(() => {});
    node.closest('.ghampus-thread-entry')?.remove();
  });
}

let _skillRunningTimer: ReturnType<typeof setInterval> | null = null;

const SKILL_RUNNING_PHRASES = [
  'Recalling relevant memories…',
  'Checking for duplicate nodes…',
  'Reviewing contradictions…',
  'Scanning skill steps…',
  'Comparing against known patterns…',
  'Trimming stale references…',
  'Cross-referencing engrams…',
  'Applying cortex updates…',
  'Almost there…',
];

function showSkillRunning(skillLabel: string, signalLabel?: string): void {
  setGhampusRunning(true);
  clearSkillRunning();
  const thread = document.getElementById('ghampus-thread');
  if (!thread) return;
  document.getElementById('ghampus-thread-empty')?.remove();

  const entry = document.createElement('div');
  entry.id = 'ghampus-skill-running';
  entry.className = 'ghampus-thread-entry skill-running-entry';

  const signalHtml = signalLabel
    ? `<div class="skill-running-signal">⏰ ${escapeHtml(signalLabel)}</div>`
    : '';

  entry.innerHTML = `<div class="chat-msg ghampus">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="skill-running-bubble">
      ${signalHtml}
      <div class="skill-running-label">Running <strong>${escapeHtml(skillLabel)}</strong></div>
      <div class="skill-running-bar-track"><div class="skill-running-bar-fill"></div></div>
      <div id="ghampus-skill-running-status" class="skill-running-status">${SKILL_RUNNING_PHRASES[0]}</div>
    </div>
  </div>`;

  thread.appendChild(entry);
  thread.scrollTop = thread.scrollHeight;

  let phraseIdx = 0;
  _skillRunningTimer = setInterval(() => {
    const statusEl = document.getElementById('ghampus-skill-running-status');
    if (!statusEl) return;
    statusEl.classList.add('fade');
    setTimeout(() => {
      phraseIdx = (phraseIdx + 1) % SKILL_RUNNING_PHRASES.length;
      statusEl.textContent = SKILL_RUNNING_PHRASES[phraseIdx];
      statusEl.classList.remove('fade');
      thread.scrollTop = thread.scrollHeight;
    }, 300);
  }, 2800);
}

function clearSkillRunning(): void {
  if (_skillRunningTimer) { clearInterval(_skillRunningTimer); _skillRunningTimer = null; }
  document.getElementById('ghampus-skill-running')?.remove();
  setGhampusRunning(false);
}

async function requestWalkPlan(sourceId: string, skillLabel?: string, signalLabel?: string, graphId?: string): Promise<void> {
  try {
    const plan = await ipcCall<WalkPlan>('ghampus:walkPlan', {
      sourceId,
      ...(graphId ? { graphId } : {}),
    });
    const routing = plan.cloudRoutingReady === false ? 'local-only' : 'adaptive';
    if (!plan.steps || plan.steps.length === 0) {
      const name = skillLabel ?? plan.label ?? sourceId;
      showSkillRunning(name, signalLabel);
      await confirmWalk(sourceId, routing, plan.graphId ?? graphId);
      return;
    }
    appendToThread({ kind: 'walk-plan', plan, ts: Date.now() });
  } catch { /* non-fatal */ }
}

async function confirmWalk(sourceId: string, routing: 'adaptive' | 'local-only', graphId?: string): Promise<void> {
  setGhampusRunning(true);
  try {
    const res = await ipcCall<{
      ok?: boolean;
      reason?: string;
      result?: { steps: Array<{ label: string; output?: string; error?: string }>; ok?: boolean };
    }>('ghampus:confirmWalk', {
      sourceId,
      routing: ghampusCloudRoutingReady ? routing : 'local-only',
      ...(graphId ? { graphId } : {}),
    });
    clearSkillRunning();
    if (res?.result?.steps?.length) {
      const walkSteps: WalkStep[] = res.result.steps.map((s) => ({
        label: s.error ? `${s.label} — ${s.error}` : s.label,
        status: s.error ? 'error' : 'done',
      }));
      appendToThread({ kind: 'walk-progress', steps: walkSteps, ts: Date.now() });
      const summary = res.result.steps
        .filter((s) => s.output && !s.error)
        .map((s) => `**${s.label}**\n${s.output}`)
        .join('\n\n');
      if (summary) {
        appendToThread({ kind: 'ghampus', text: summary, ts: Date.now() });
      }
    } else if (res?.ok === false) {
      void gAlert('Skill walk failed', res.reason ?? 'Could not execute the walk.');
    }
  } catch (e) {
    clearSkillRunning();
    void gAlert('Skill walk error', e instanceof Error ? e.message : String(e));
  } finally {
    setGhampusRunning(false);
  }
}

async function sendRefineResponse(sourceId: string, action: 'update' | 'edit' | 'skip'): Promise<void> {
  try {
    await ipcCall('ghampus:refineResponse', { sourceId, action });
  } catch { /* non-fatal */ }
}

function renderNotifCard(n: {
  id: string; engramId: string; tier: string; originKind: string;
  origin: string; label: string; ingestedAtMs: number;
}, now: number): string {
  const ageMs = now - n.ingestedAtMs;
  const when = ageMs < 60_000 ? 'just now'
    : ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)} min ago`
    : ageMs < 86_400_000 ? `${Math.floor(ageMs / 3_600_000)}h ago`
    : `${Math.floor(ageMs / 86_400_000)}d ago`;
  const icon = (NOTIF_ORIGIN_ICONS as Record<string, string>)[n.originKind] ?? '·';
  const isSensitive = n.tier === 'sensitive';
  const preview = isSensitive
    ? '<div class="notif-card-preview sensitive">[content hidden · sensitive engram]</div>'
    : `<div class="notif-card-preview">${escapeHtml(n.label)}</div>`;
  return `<div class="notif-card" data-notif-id="${escapeHtml(n.id)}">
    <div class="notif-card-header">
      <span>${icon}</span>
      <span class="notif-card-origin">${escapeHtml(n.origin)}</span>
      <span class="notif-card-engram">${escapeHtml(n.engramId)}</span>
      <span class="notif-card-time">${when}</span>
    </div>
    ${preview}
    <div class="notif-card-actions">
      ${isSensitive ? '' : `<button class="g-btn primary btn-notif-switch"
        style="font-size: 11px; padding: 3px 10px;"
        data-engram="${escapeHtml(n.engramId)}">Switch to ${escapeHtml(n.engramId)} to chat</button>`}
      <button class="g-btn btn-notif-dismiss"
        style="font-size: 11px; padding: 3px 8px;"
        data-notif-id="${escapeHtml(n.id)}">Dismiss</button>
    </div>
  </div>`;
}

let refreshGhampusThreadInflight: Promise<void> | null = null;

export async function refreshGhampusThread(): Promise<void> {
  if (refreshGhampusThreadInflight) return refreshGhampusThreadInflight;
  refreshGhampusThreadInflight = refreshGhampusThreadInner().finally(() => {
    refreshGhampusThreadInflight = null;
    reconcileGhampusThreadDom();
  });
  return refreshGhampusThreadInflight;
}

/** Paint any cached messages missing from the DOM (e.g. arrived while tab hidden). */
function reconcileGhampusThreadDom(): void {
  const thread = document.getElementById('ghampus-thread');
  if (!thread) return;
  const domCount = thread.querySelectorAll('.ghampus-thread-entry:not(#ghampus-thinking)').length;
  if (ghampusThreadMessages.length <= domCount) {
    if (ghampusRunning && !document.getElementById('ghampus-thinking')) showThinkingBubble();
    return;
  }
  thread.innerHTML = '';
  for (const msg of ghampusThreadMessages) appendToThread(msg, { skipCache: true });
  if (ghampusRunning) showThinkingBubble();
}

async function refreshGhampusThreadInner(): Promise<void> {
  const thread = document.getElementById('ghampus-thread');
  if (!thread) return;

  // If we already have live messages from this session, leave the DOM alone.
  // Only the first load (or an explicit clear) should fetch history.
  const hasLiveMessages = ghampusThreadMessages.length > 0;
  if (hasLiveMessages) return;

  // Try history first
  let messages: GhampusChatMessage[] = [];
  try {
    const res = await ipcCall<{ messages: GhampusChatMessage[] }>('ghampus:history', {});
    messages = dedupeAwayDigests(res.messages ?? []);
  } catch { /* not yet wired */ }

  if (messages.length > 0) {
    ghampusThreadMessages = [];
    thread.innerHTML = '';
    for (const msg of messages) appendToThread(msg);
    return;
  }

  // Request sidecar away digest only when history is still empty (single-flight
  // above prevents parallel tab-refresh races from appending duplicates).
  try {
    await ipcCall<{ emitted?: boolean }>('ghampus:digest', {});
    const res2 = await ipcCall<{ messages: GhampusChatMessage[] }>('ghampus:history', {});
    const digestMessages = dedupeAwayDigests(res2.messages ?? []);
    if (digestMessages.length > 0) {
      ghampusThreadMessages = [];
      thread.innerHTML = '';
      for (const msg of digestMessages) appendToThread(msg);
      return;
    }
  } catch { /* fall through to notification cards */ }

  // No history — show "while you were away" notification cards as opener
  try {
    const lastVisited = Number(localStorage.getItem(GHAMPUS_LAST_VISITED_KEY))
      || (Date.now() - 7 * 24 * 60 * 60 * 1000);
    const res = await ipcCall<{
      notifications: Array<{
        id: string; engramId: string; tier: string; originKind: string;
        origin: string; label: string; ingestedAtMs: number;
      }>;
      totalAvailable: number;
    }>('agent:listNotifications', { sinceMs: lastVisited, limit: 8 });

    if (res.notifications.length === 0) {
      // Truly nothing — show empty state
      thread.innerHTML = `<div id="ghampus-thread-empty" class="ghampus-thread-empty">
        <div style="width: 36px; height: 36px; border-radius: 10px; background: #14b8a6;
                    display: flex; align-items: center; justify-content: center;
                    font-weight: 700; font-size: 18px; color: #fff; margin-bottom: 12px; opacity: .5;">G</div>
        <p style="margin: 0; font-size: 13px; opacity: .5;">
          Start typing — or wait for Ghampus to pick up where you left off.
        </p>
      </div>`;
      return;
    }

    // Render notification cards as a "while you were away" opener header + cards
    const count = res.notifications.length;
    const total = res.totalAvailable;
    const summaryText = `${total > count ? `${total}` : `${count}`} item${count === 1 ? '' : 's'} arrived since your last visit · last ${Math.round((Date.now() - lastVisited) / 3_600_000)} hours · batched by source`;
    const now = Date.now();

    const headerHtml = `<div style="margin-bottom: 10px;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
        <strong style="font-size: 14px;">While you were away</strong>
        <div style="display: flex; gap: 10px;">
          <button class="ghampus-dashboard-btn" id="btn-ghampus-mute-sources" type="button"
                  style="padding: 0; font-size: 12px;">Mute sources</button>
          <button class="ghampus-dashboard-btn" id="btn-ghampus-mark-all-read" type="button"
                  style="padding: 0; font-size: 12px;">Mark all read</button>
        </div>
      </div>
      <p class="subtitle" style="margin: 0; font-size: 12px;">${escapeHtml(summaryText)}</p>
    </div>`;

    const cardsHtml = res.notifications.map((n) => renderNotifCard(n, now)).join('');

    // Pro upsell if free plan
    const upsell = ghampusPlan === 'free'
      ? `<div style="margin-top: 10px; padding: 10px 14px; border: 1px dashed var(--g-border, rgba(255,255,255,.15));
                     border-radius: 8px; font-size: 12px; opacity: .7; line-height: 1.55;">
           💡 On Pro, Ghampus would open with a single summary instead of a list — and let you chat across all ${count} engrams in one query. Free chats one engram at a time, but you can switch with one click.
         </div>`
      : '';

    thread.innerHTML = `<div class="ghampus-thread-entry ghampus-notif-opener">
      ${headerHtml}${cardsHtml}${upsell}
    </div>`;

    // Wire dismiss and switch buttons
    thread.querySelectorAll<HTMLButtonElement>('.btn-notif-switch').forEach((btn) => {
      btn.addEventListener('click', () => {
        const engramId = btn.dataset.engram ?? '';
        const nameEl = document.getElementById('ghampus-active-engram-name');
        const badge = document.getElementById('ghampus-active-engram');
        if (nameEl) nameEl.textContent = engramId;
        if (badge) badge.classList.remove('hidden');
        updateGhampusInputPlaceholder(engramId);
        // Scroll to input
        document.getElementById('ghampus-input')?.focus();
      });
    });
    thread.querySelectorAll<HTMLButtonElement>('.btn-notif-dismiss').forEach((btn) => {
      btn.addEventListener('click', () => {
        btn.closest('.notif-card')?.remove();
      });
    });
    document.getElementById('btn-ghampus-mark-all-read')?.addEventListener('click', () => {
      thread.querySelectorAll('.notif-card').forEach((c) => c.remove());
    });

    // Show the quiet/snooze footer
    document.getElementById('ghampus-quiet-footer')?.classList.remove('hidden');

    // Update badge count in header
    const badge = document.getElementById('ghampus-notif-badge');
    if (badge && count > 0) {
      badge.textContent = `${count} new`;
      badge.classList.remove('hidden');
    }
  } catch { /* non-fatal */ }
}

function updateGhampusInputPlaceholder(activeEngramId?: string): void {
  const input = document.getElementById('ghampus-input') as HTMLTextAreaElement | null;
  if (!input) return;
  input.placeholder = 'Ask anything — type / to save, recall, or run a skill';
}

function ghampusModelDisplayName(
  modelTag: string,
  catalog?: Array<{ model: string; label: string }>,
): string {
  if (!catalog?.length) return modelTag;
  const exact = catalog.find((c) => c.model === modelTag);
  if (exact) return exact.label;
  const colon = modelTag.indexOf(':');
  const base = colon >= 0 ? modelTag.slice(0, colon) : modelTag;
  const variant = colon >= 0 ? modelTag.slice(colon + 1) : '';
  for (const c of catalog) {
    const cColon = c.model.indexOf(':');
    const cBase = cColon >= 0 ? c.model.slice(0, cColon) : c.model;
    const cVariant = cColon >= 0 ? c.model.slice(cColon + 1) : '';
    if (base !== cBase || !variant || !cVariant) continue;
    // Quantized tags extend the catalog id (e.g. llama3.2:3b-instruct-q4_K_M).
    if (variant === cVariant || variant.startsWith(cVariant) || cVariant.startsWith(variant)) {
      return c.label;
    }
  }
  return modelTag;
}

function paintGhampusModelSelect(status: {
  ollamaReachable: boolean;
  installedModels: string[];
  activeModel: string | null;
  catalog?: Array<{ model: string; label: string }>;
}): void {
  const dot = document.getElementById('ghampus-model-dot');
  const select = document.getElementById('ghampus-model-select') as HTMLSelectElement | null;
  const badge = document.getElementById('ghampus-model-badge');
  if (!dot || !select || !badge) return;

  badge.classList.remove('hidden');

  dot.classList.remove('ghampus-header-model-dot--warn', 'ghampus-header-model-dot--offline');
  if (!status.ollamaReachable) {
    dot.classList.add('ghampus-header-model-dot--offline');
    dot.title = 'Ollama not detected — open Settings → Foresight → Local LLM';
  } else if (status.installedModels.length === 0) {
    dot.classList.add('ghampus-header-model-dot--warn');
    dot.title = 'Ollama connected — no models installed yet';
  } else {
    dot.title = 'Local LLM connected';
  }

  const prev = select.value;
  select.innerHTML = '';
  if (!status.ollamaReachable) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Ollama offline';
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  if (status.installedModels.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No models installed';
    select.appendChild(opt);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  const installedModels = [...new Set(status.installedModels)];
  for (const m of installedModels) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = ghampusModelDisplayName(m, status.catalog);
    if (m === status.activeModel) opt.selected = true;
    select.appendChild(opt);
  }
  if (!select.value && prev && installedModels.includes(prev)) {
    select.value = prev;
  }
}

let ghampusModelSelectWired = false;

function wireGhampusModelSelect(): void {
  if (ghampusModelSelectWired) return;
  ghampusModelSelectWired = true;
  const select = document.getElementById('ghampus-model-select') as HTMLSelectElement | null;
  if (!select) return;
  select.addEventListener('change', () => {
    const model = select.value;
    if (!model) return;
    void (async () => {
      try {
        await ipcCall('llm:setModel', { model });
      } catch {
        void refreshGhampusHeader();
      }
    })();
  });
}

export async function refreshGhampusHeader(): Promise<void> {
  try {
    const [catalogData, llmStatus] = await Promise.all([
      ipcCall<{
        catalogVersion: string;
        cloudRoutingReady?: boolean;
        monthlyBudgetUsd: number | null;
        spentThisCycleUsd: number;
      }>('models:catalog', {}),
      ipcCall<{
        ollamaReachable: boolean;
        installedModels: string[];
        activeModel: string | null;
        catalog?: Array<{ model: string; label: string }>;
      }>('llm:status', {}),
    ]);
    ghampusCloudRoutingReady = catalogData.cloudRoutingReady === true;
    paintGhampusModelSelect(llmStatus);

    // Usage counter
    const counterEl = document.getElementById('ghampus-usage-counter');
    if (counterEl && catalogData.monthlyBudgetUsd !== null) {
      const spent = catalogData.spentThisCycleUsd ?? 0;
      const budget = catalogData.monthlyBudgetUsd;
      const pct = Math.round((spent / budget) * 100);
      counterEl.textContent = `${pct}/100`;
      counterEl.classList.remove('hidden');
    } else if (counterEl && ghampusPlan !== 'free') {
      counterEl.textContent = 'unlimited calls';
      counterEl.title = 'No monthly call limit on your current plan';
      counterEl.classList.remove('hidden');
    }
  } catch { /* non-fatal */ }

  updateGhampusInputPlaceholder();
}

// ── Slash command definitions ─────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { name: 'save',    icon: '💾', args: '[content] [@engram]', desc: 'Save a memory',         template: '/save '         },
  { name: 'create',  icon: '✨', args: '[engram name]',       desc: 'Create a new engram',   template: '/create '       },
  { name: 'engrams', icon: '🗂️', args: '',                    desc: 'List your engrams',     template: '/engrams'       },
  { name: 'skills',  icon: '⚡', args: '',                    desc: 'List your skills',      template: '/skills'        },
  { name: 'forget',  icon: '🗑️', args: '',                    desc: 'Manage / delete memories', template: '/forget'     },
  { name: 'help',    icon: '❓', args: '',                    desc: 'Show all commands',     template: '/help'          },
] as const;

function wireGhampusChat(): void {
  const input = document.getElementById('ghampus-input') as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById('btn-ghampus-send');
  if (!input || !sendBtn) return;

  // ── Slash palette ──────────────────────────────────────────────────────────
  let palette: HTMLDivElement | null = null;
  let paletteActive = 0; // index of highlighted item
  let paletteVisible = false;
  let filteredCmds: typeof SLASH_COMMANDS[number][] = [];

  function buildPalette(filter: string): void {
    filteredCmds = SLASH_COMMANDS.filter(
      (c) => c.name.startsWith(filter) || filter === '',
    ) as typeof SLASH_COMMANDS[number][];

    if (!palette) {
      palette = document.createElement('div');
      palette.className = 'slash-palette';
      input!.closest('.ghampus-input-row')!.appendChild(palette);
    }
    palette.innerHTML =
      `<div class="slash-palette-header">Commands</div>` +
      filteredCmds.map((c, i) =>
        `<div class="slash-palette-item${i === paletteActive ? ' slash-active' : ''}" data-idx="${i}">
          <span class="slash-palette-icon">${c.icon}</span>
          <span class="slash-palette-name">/${c.name}</span>
          ${c.args ? `<span class="slash-palette-args">${escapeHtml(c.args)}</span>` : ''}
          <span class="slash-palette-desc">${escapeHtml(c.desc)}</span>
        </div>`,
      ).join('');

    palette.querySelectorAll<HTMLElement>('.slash-palette-item').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault(); // don't blur the textarea
        const idx = Number(el.dataset['idx']);
        selectPaletteItem(idx);
      });
    });

    paletteVisible = filteredCmds.length > 0;
    palette.style.display = paletteVisible ? '' : 'none';
  }

  function selectPaletteItem(idx: number): void {
    const cmd = filteredCmds[idx];
    if (!cmd) return;
    input!.value = cmd.template;
    hidePalette();
    input!.focus();
    // Move cursor to end
    input!.selectionStart = input!.selectionEnd = input!.value.length;
    autoGrow();
    // Execute no-arg commands immediately
    if (!cmd.args) void sendMessage();
  }

  function hidePalette(): void {
    if (palette) palette.style.display = 'none';
    paletteVisible = false;
    paletteActive = 0;
  }

  function updatePalette(): void {
    const val = input!.value;
    if (!val.startsWith('/')) { hidePalette(); return; }
    const filter = val.slice(1).split(/\s/)[0].toLowerCase();
    // Only show palette while user is still typing the command word (no space yet after it)
    if (val.includes(' ') && !val.match(/^\/\w+$/)) { hidePalette(); return; }
    paletteActive = 0;
    buildPalette(filter);
  }

  // ── Auto-grow textarea ─────────────────────────────────────────────────────
  function autoGrow(): void {
    input!.style.height = 'auto';
    input!.style.height = `${Math.min(input!.scrollHeight, 140)}px`;
  }
  input.addEventListener('input', () => { autoGrow(); updatePalette(); });

  async function sendMessage(): Promise<void> {
    const text = input!.value.trim();
    if (!text) return;
    hidePalette();
    input!.value = '';
    input!.style.height = 'auto';
    const ts = Date.now();
    appendToThread({ kind: 'user', text, ts });
    showThinkingBubble();
    try {
      await ipcCall('ghampus:send', { text });
    } catch {
      clearThinkingBubble();
    }
  }

  input.addEventListener('keydown', (e) => {
    trackGhampusActivity();
    // Palette navigation
    if (paletteVisible) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        paletteActive = (paletteActive + 1) % filteredCmds.length;
        buildPalette(input.value.slice(1).split(/\s/)[0].toLowerCase());
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        paletteActive = (paletteActive - 1 + filteredCmds.length) % filteredCmds.length;
        buildPalette(input.value.slice(1).split(/\s/)[0].toLowerCase());
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && paletteVisible)) {
        e.preventDefault();
        selectPaletteItem(paletteActive);
        return;
      }
      if (e.key === 'Escape') { hidePalette(); return; }
    }

    if (e.key === 'Enter') {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        const pos = input.selectionStart ?? input.value.length;
        input.value = input.value.slice(0, pos) + '\n' + input.value.slice(pos);
        input.selectionStart = input.selectionEnd = pos + 1;
        autoGrow();
      } else if (!e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    }
  });

  // Hide palette on outside click
  document.addEventListener('mousedown', (e) => {
    if (palette && !palette.contains(e.target as Node) && e.target !== input) {
      hidePalette();
    }
  });

  sendBtn.addEventListener('click', () => {
    trackGhampusActivity();
    void sendMessage();
  });

  // Wire pill-based section accordion — one panel open at a time
  const strip = document.getElementById('ghampus-sections-strip');
  if (strip) {
    strip.querySelectorAll<HTMLButtonElement>('.ghampus-section-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        const section = pill.dataset['section'] ?? '';
        const panel = strip.querySelector<HTMLElement>(`.ghampus-section-panel[data-panel="${section}"]`);
        const isOpen = pill.getAttribute('aria-expanded') === 'true';

        // Collapse all pills and panels first
        strip.querySelectorAll<HTMLButtonElement>('.ghampus-section-pill').forEach((p) => {
          p.setAttribute('aria-expanded', 'false');
        });
        strip.querySelectorAll<HTMLElement>('.ghampus-section-panel').forEach((p) => {
          p.classList.remove('open');
        });

        // If it wasn't open, open it now (toggle behaviour)
        if (!isOpen && panel) {
          pill.setAttribute('aria-expanded', 'true');
          panel.classList.add('open');
        }
      });
    });
  }
}
function wireGhampusControls(): void {
  document.getElementById('btn-ghampus-kill')?.addEventListener('click', () => {
    void (async () => {
      await ipcCall('agent:setEnabled', { enabled: false });
      await refreshGhampusState();
    })();
  });
  document.getElementById('btn-ghampus-resume')?.addEventListener('click', () => {
    void (async () => {
      await ipcCall('agent:setEnabled', { enabled: true });
      await refreshGhampusState();
    })();
  });
}

