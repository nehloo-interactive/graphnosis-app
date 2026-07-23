/**
 * Ghampus — local AI agent UI (chat, panels, proactive cards).
 */
import { invoke, listen, sendNotification } from '../platform';
import { app } from './app-context';
import { gAlert, gConfirm, gPrompt } from './dialogs';
import { wireGhampusComposeRail } from './ghampus-compose-rail';
import {
  insightPrimaryAction,
  openForesightLaneModal,
  renderInsightCard,
  type ForesightInsightRow,
  type InsightPrimaryAction,
} from './foresight-page';
import { openMemoryIntegrityWorkbench } from './memory-integrity-workbench';
import type { AttentionCounts } from './memory-integrity-workbench';
import { ipcCall } from './ipc';
import { escapeHtml, presEngramAttr, presSkillAttr, presSurfaceAttr, PRES_GHAMPUS_CHAT, PRES_GHAMPUS_PANELS } from './util';

function sweepGhampusPres(root?: ParentNode | null): void {
  if (!app().presActive()) return;
  const r = root ?? document.getElementById('ghampus-chat-wrap');
  if (r) app().applyPresentationMasking(r);
}

export function initGhampus(): void {
  wireGhampusSidecarEvents();
  wireGhampusChat();
  wireGhampusFragmentComments();
  wireGhampusControls();
  wireGhampusModelSelect();
  document.addEventListener('graphnosis:attention-snooze', () => {
    dismissProactiveCardInSession('attention', ATTENTION_NUDGE_ID);
  });
  wireSkillMaintenanceSettings();
  wireReminderSettings();
  wireTipSettings();
  wireMemorySuggestionSettings();
  wireVitalityNudgeSettings();
  wireProactiveSettings();
  wireSavingsBaselineSettings();
  wireGhampusAttachButtons();
  wireAnnotationModalControls();
  wireGhampusThreadTimestamps();
  wireGhampusThreadScrollPin();
  initGhampusNewChatModal();
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
  document.getElementById('btn-ghampus-cancel')
    ?.classList.toggle('hidden', !ghampusRunning || !ghampusEnabled);
}

export function updateGhampusVisibility(): void {
  document.getElementById('btn-ghampus-kill')
    ?.classList.toggle('hidden', !ghampusRunning || !ghampusEnabled);
  document.getElementById('btn-ghampus-cancel')
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
      reminders?: { enabled: boolean; startupDelayMs: number; nativeNotifications: boolean };
      tips?: { enabled: boolean; startupDelayMs: number };
      memorySuggestions?: { enabled: boolean };
      vitalityNudges?: { enabled: boolean; startupDelayMs: number };
    }>('agent:status', {});
    ghampusEnabled = s.enabled;
    ghampusPlan = s.plan;
    updateGhampusVisibility();
    paintSkillMaintenanceSettings(s.skillMaintenance);
    paintProactiveSettings(s.proactive);
    paintReminderSettings(s.reminders);
    paintTipSettings(s.tips);
    paintMemorySuggestionSettings(s.memorySuggestions);
    paintVitalityNudgeSettings(s.vitalityNudges);
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

function paintReminderSettings(rm?: { enabled: boolean; nativeNotifications: boolean }): void {
  const enabledEl = document.getElementById('ghampus-reminders-enabled') as HTMLInputElement | null;
  const notifEl = document.getElementById('ghampus-reminders-native-notif') as HTMLInputElement | null;
  if (enabledEl && rm) enabledEl.checked = rm.enabled;
  if (notifEl && rm) notifEl.checked = rm.nativeNotifications;
}

export function wireReminderSettings(): void {
  const enabledEl = document.getElementById('ghampus-reminders-enabled') as HTMLInputElement | null;
  const notifEl = document.getElementById('ghampus-reminders-native-notif') as HTMLInputElement | null;
  enabledEl?.addEventListener('change', () => {
    void ipcCall('agent:setReminders', { enabled: enabledEl.checked }).catch(() => {});
  });
  notifEl?.addEventListener('change', () => {
    void ipcCall('agent:setReminders', { nativeNotifications: notifEl.checked }).catch(() => {});
  });
}

function paintTipSettings(tp?: { enabled: boolean }): void {
  const enabledEl = document.getElementById('ghampus-tips-enabled') as HTMLInputElement | null;
  if (enabledEl && tp) enabledEl.checked = tp.enabled;
}

export function wireTipSettings(): void {
  const enabledEl = document.getElementById('ghampus-tips-enabled') as HTMLInputElement | null;
  enabledEl?.addEventListener('change', () => {
    void ipcCall('agent:setTips', { enabled: enabledEl.checked }).catch(() => {});
  });
}

function paintMemorySuggestionSettings(ms?: { enabled: boolean }): void {
  const enabledEl = document.getElementById('ghampus-memory-suggestions-enabled') as HTMLInputElement | null;
  if (enabledEl && ms) enabledEl.checked = ms.enabled;
}

export function wireMemorySuggestionSettings(): void {
  const enabledEl = document.getElementById('ghampus-memory-suggestions-enabled') as HTMLInputElement | null;
  enabledEl?.addEventListener('change', () => {
    void ipcCall('agent:setMemorySuggestions', { enabled: enabledEl.checked }).catch(() => {});
  });
}

function paintVitalityNudgeSettings(vn?: { enabled: boolean }): void {
  const enabledEl = document.getElementById('ghampus-vitality-nudges-enabled') as HTMLInputElement | null;
  if (enabledEl && vn) enabledEl.checked = vn.enabled;
}

export function wireVitalityNudgeSettings(): void {
  const enabledEl = document.getElementById('ghampus-vitality-nudges-enabled') as HTMLInputElement | null;
  enabledEl?.addEventListener('change', () => {
    void ipcCall('agent:setVitalityNudges', { enabled: enabledEl.checked }).catch(() => {});
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
                void gAlert('Provider update failed', result.message ?? 'Could not update provider.');
              }
            } catch (e) {
              cb.checked = !cb.checked;
              void gAlert('Provider update failed', e instanceof Error ? e.message : String(e));
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
          <strong style="font-size: 13px; cursor: pointer;" data-attach-open="${escapeHtml(a.path)}" title="${a.lastVerifiedOk ? 'Open in default app' : 'File not found — pick its new location'}"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(a.label)}</strong>
          <code style="font-size: 11px; opacity: .6;"${presEngramAttr(a.graphId)}>${escapeHtml(a.graphId)}</code>
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
    sweepGhampusPres(document.getElementById('ghampus-linked-files-panel') ?? document.getElementById('ghampus-attachments-list'));
  } catch { /* non-fatal */ }
}
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
          : `<span class="subtitle" style="font-size: 11px;"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(n.label)}</span>`;
        return `<li style="padding: 8px 0; border-bottom: 1px solid var(--g-border, rgba(255,255,255,.05));">
          <div style="display: flex; gap: 8px; align-items: baseline;">
            <span>${icon}</span>
            <strong style="font-size: 13px;"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(n.origin)}</strong>
            <code style="font-size: 11px; opacity: .7;"${presEngramAttr(n.engramId)}>${escapeHtml(n.engramId)}</code>
            <span class="subtitle" style="margin-left: auto; font-size: 11px;">${when}</span>
          </div>
          <div style="margin: 4px 0 0 24px;">${previewLine}</div>
        </li>`;
      }).join('');
    }
    sweepGhampusPres(document.getElementById('ghampus-notifications-panel'));
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
                <div class="ghampus-skill-name"${presSkillAttr(s.sourceId, s.engramId)}>${escapeHtml(displayLabel)}</div>
                <div class="ghampus-skill-meta"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${trained}${s.origin === 'pack' ? ' · pack' : ''}</div>
              </div>
              <button class="ghampus-skill-run" type="button"
                      data-skill-label="${escapeHtml(displayLabel)}">Preview ▸</button>
            </div>
          </li>`;
        }).join('');
      }
    }
    sweepGhampusPres(document.getElementById('ghampus-skills-panel'));
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
            <span class="ghampus-panel-item-label"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(s.label)}</span>
            <span class="ghampus-panel-item-meta"${presEngramAttr(s.engramId)}>${escapeHtml(s.engramId)}</span>
            <span class="ghampus-panel-item-meta"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${when}</span>
          </div></li>`;
        }).join('');
      }
    }
    sweepGhampusPres(document.getElementById('ghampus-recent-saves-panel'));
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
          <span class="ghampus-panel-item-label"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(t.name)}</span>
          <span class="ghampus-panel-item-meta"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(t.role)}</span>
          <span class="ghampus-panel-item-meta"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${expiryNote}</span>
        </div></li>`;
      }).join('') || '<li class="ghampus-panel-empty">No active shares.</li>';
    }
    sweepGhampusPres(document.getElementById('ghampus-sharing-panel'));
  } catch { /* non-fatal */ }
}

// ── Ghampus chat surface ──────────────────────────────────────────────────

type GhampusChatMessage =
  | { kind: 'user'; text: string; ts: number; turnId?: string }
  | { kind: 'ghampus'; text: string; ts: number; turnId?: string; trace?: GhampusTurnTrace; handledBy?: HandledByChip }
  | { kind: 'skill-match'; skill: SkillMatchPayload; ts: number }
  | { kind: 'walk-plan'; plan: WalkPlan; ts: number }
  | { kind: 'walk-progress'; steps: WalkStep[]; ts: number }
  | { kind: 'refine-proposal'; proposal: RefineProposal; ts: number }
  | { kind: 'tier-strip'; context: TierContext; ts: number }
  | { kind: 'proactive-card'; card: ProactiveCardPayload; ts: number }
  | { kind: 'tip'; tip: TipCardPayload; ts: number }
  | { kind: 'vitality-nudge'; nudge: VitalityNudgeCardPayload; ts: number }
  | { kind: 'attention-nudge'; counts: AttentionCounts; ts: number }
  | { kind: 'memory-suggestion'; suggestion: MemorySuggestionCardPayload; ts: number }
  | { kind: 'recovery-nudge'; nudge: RecoveryNudgePayload; ts: number }
  | { kind: 'skill-preview-improve'; card: SkillPreviewImproveCardPayload; ts: number; turnId?: string }
  | { kind: 'insights-preview'; insights: ForesightInsightRow[]; totalCount: number; ts: number; turnId?: string };

interface RecoveryNudgePayload {
  id: string;
  graphId: string;
  displayName: string;
  title: string;
  text: string;
}

/** "Handled by {Agempus}" routing chip (feature #41). Names the domain Agempus
 *  (engram) + skill that handled a dispatched turn. Descriptive only — no
 *  re-dispatch action. Optional/additive: absent on non-dispatched turns and
 *  on pre-feature history (the normalizer carries it through when present). */
interface HandledByChip {
  engramName: string;
  engramId: string;
  skillLabel: string;
  skillSlug: string;
}

interface SkillPreviewImproveCardPayload {
  skillLabel: string;
  skillSlug: string;
  proPlus: boolean;
}

interface GhampusFragmentCommentEntry {
  id: string;
  messageId: string;
  quotedText: string;
  userComment: string;
  parentAnswerText: string;
  quoteStartOffset?: number;
  contextBefore?: string;
  contextAfter?: string;
}

const ghampusFragmentComments: GhampusFragmentCommentEntry[] = [];
let ghampusPendingFragmentSelection: {
  messageId: string;
  quotedText: string;
  parentAnswerText: string;
  quoteStartOffset?: number;
  contextBefore?: string;
  contextAfter?: string;
  anchorRect?: DOMRect;
} | null = null;

interface MemorySuggestionCardPayload {
  id: string;
  kind: 'remember' | 'obligation' | 'create_engram';
  text: string;
  engramHint?: string;
  obligation?: { obligationType: string; expiresAt: number };
  reason: string;
  createEngramName?: string;
}

interface TipCardPayload {
  id: string;
  tipId: string;
  title: string;
  body: string;
  category: string;
  examplePrompt?: string;
  expectedOutcome?: string;
}

interface VitalityNudgeCardPayload {
  id: string;
  nudgeId: string;
  title: string;
  body: string;
  nudgeKind: string;
  examplePrompt?: string;
  walkSkillLabel?: string;
}

const ATTENTION_NUDGE_ID = 'memory-integrity-queue';
const ATTENTION_DISMISS_SIG_KEY = 'graphnosis:attention-dismissed-sig';

function isAttentionSnoozed(counts: AttentionCounts): boolean {
  try {
    const sig = `${counts.corrections}:${counts.duplicates}:${counts.contradictions}`;
    return sessionStorage.getItem(ATTENTION_DISMISS_SIG_KEY) === sig;
  } catch {
    return false;
  }
}

function attentionNudgeBody(counts: AttentionCounts): string {
  const parts: string[] = [];
  if (counts.corrections > 0) parts.push(`${counts.corrections} correction${counts.corrections === 1 ? '' : 's'}`);
  if (counts.contradictions > 0) parts.push(`${counts.contradictions} contradiction${counts.contradictions === 1 ? '' : 's'}`);
  if (counts.duplicates > 0) parts.push(`${counts.duplicates} duplicate${counts.duplicates === 1 ? '' : 's'}`);
  return parts.join(' · ') || 'items need review';
}

function renderAttentionNudgeCard(counts: AttentionCounts, ts: number): string {
  const summary = escapeHtml(attentionNudgeBody(counts));
  const correctionsBtn = counts.corrections > 0
    ? `<button type="button" class="g-btn ghampus-attention-corrections">Corrections deck</button>`
    : '';
  return `<div class="chat-msg ghampus">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="chat-msg-wrap">
      <div class="ghampus-tip-card ghampus-attention-nudge-card" data-attention-nudge="1">
        <div class="ghampus-tip-header">
          <span class="ghampus-tip-badge" style="background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--accent);">Memory Integrity</span>
          <span class="ghampus-tip-category">Needs attention</span>
        </div>
        <p class="ghampus-tip-title"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${counts.total} item${counts.total === 1 ? '' : 's'} waiting for you</p>
        <p class="ghampus-tip-body"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${summary} — review and approve before anything is written to your cortex.</p>
        <div class="ghampus-vitality-nudge-actions">
          <button type="button" class="g-btn primary ghampus-attention-review">Review in Memory Integrity</button>
          ${correctionsBtn}
          ${renderCardDismissButton('ghampus-attention-dismiss', 'attention', ATTENTION_NUDGE_ID)}
        </div>
      </div>
      <div class="chat-msg-meta">
        <div class="chat-msg-time">${fmtTime(ts)}</div>
      </div>
    </div>
  </div>`;
}

/** Inject, update, or remove the Memory Integrity attention card in the Ghampus thread. */
export function syncGhampusAttentionNudge(counts: AttentionCounts, visible: boolean): void {
  ghampusThreadMessages = ghampusThreadMessages.filter((m) => m.kind !== 'attention-nudge');
  document.querySelectorAll('.ghampus-thread-entry .ghampus-attention-nudge-card')
    .forEach((el) => el.closest('.ghampus-thread-entry')?.remove());

  if (!visible || counts.total <= 0 || isProactiveCardDismissed('attention', ATTENTION_NUDGE_ID) || isAttentionSnoozed(counts)) return;

  const msg: GhampusChatMessage = { kind: 'attention-nudge', counts: { ...counts }, ts: Date.now() };
  appendToThread(msg);
}

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

type GhampusTraceStatus = 'running' | 'ok' | 'error' | 'skip';

type GhampusTraceStep = {
  stepId: string;
  status: GhampusTraceStatus;
  label: string;
  tool?: string;
  preview?: string;
  ms?: number;
};

type GhampusTurnTrace = {
  turnId: string;
  startedAt: number;
  endedAt?: number;
  steps: GhampusTraceStep[];
};

type GhampusTracePayload = {
  turnId: string;
  stepId: string;
  status: GhampusTraceStatus;
  label: string;
  tool?: string;
  preview?: string;
  ms?: number;
  ts: number;
  elapsedMs?: number;
};

const tracesByTurn = new Map<string, GhampusTurnTrace>();
let liveTraceTurnId: string | null = null;
let liveTraceElapsedTimer: ReturnType<typeof setInterval> | null = null;
let liveTraceScrollPinned = true;
const THREAD_SCROLL_BOTTOM_THRESHOLD = 40;
let threadScrollPinned = true;

function isGhampusThreadAtBottom(
  thread: HTMLElement,
  threshold = THREAD_SCROLL_BOTTOM_THRESHOLD,
): boolean {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight <= threshold;
}

function isGhampusPaneVisible(): boolean {
  const pane = document.querySelector<HTMLElement>('.mode-pane[data-pane="ghampus"]');
  return !!(pane && !pane.classList.contains('hidden'));
}

function scrollGhampusThreadToBottomIfPinned(opts?: { instant?: boolean }): void {
  if (!threadScrollPinned) return;
  const thread = document.getElementById('ghampus-thread');
  if (!thread) return;
  const instant = opts?.instant ?? !isGhampusPaneVisible();
  const apply = () => {
    if (instant) {
      const prev = thread.style.scrollBehavior;
      thread.style.scrollBehavior = 'auto';
      thread.scrollTop = thread.scrollHeight;
      thread.style.scrollBehavior = prev;
    } else {
      thread.scrollTop = thread.scrollHeight;
    }
  };
  if (instant) {
    apply();
    requestAnimationFrame(apply);
  } else {
    requestAnimationFrame(apply);
  }
}

function resetGhampusThreadScrollPin(): void {
  threadScrollPinned = true;
}

function newGhampusTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function traceElapsedMs(trace: GhampusTurnTrace): number {
  const end = trace.endedAt ?? Date.now();
  return Math.max(0, end - trace.startedAt);
}

function formatTraceElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (secs === 0) return `${minutes}m`;
    return `${minutes}m${secs}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  let out = `${hours}h`;
  if (minutes > 0) out += `${minutes}m`;
  if (secs > 0) out += `${secs}s`;
  return out;
}

function formatTraceElapsedMs(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  return formatTraceElapsed(Math.floor(clamped / 1000));
}

function formatTraceMetaText(trace: GhampusTurnTrace): string {
  return `(${trace.steps.length} step${trace.steps.length === 1 ? '' : 's'} · ${formatTraceElapsedMs(traceElapsedMs(trace))})`;
}

function updateLiveTraceSummary(turnId: string): void {
  const trace = tracesByTurn.get(turnId);
  const summaryEl = document.getElementById('ghampus-live-trace-summary');
  if (!trace || !summaryEl) return;
  summaryEl.textContent = formatTraceMetaText(trace);
}

function startLiveTraceElapsedTimer(): void {
  if (liveTraceElapsedTimer || !liveTraceTurnId) return;
  liveTraceElapsedTimer = setInterval(() => {
    if (!liveTraceTurnId) {
      stopLiveTraceElapsedTimer();
      return;
    }
    updateLiveTraceSummary(liveTraceTurnId);
  }, 1000);
}

function stopLiveTraceElapsedTimer(): void {
  if (!liveTraceElapsedTimer) return;
  clearInterval(liveTraceElapsedTimer);
  liveTraceElapsedTimer = null;
}

function ensureTurnTrace(turnId: string, startedAt = Date.now()): GhampusTurnTrace {
  let trace = tracesByTurn.get(turnId);
  if (!trace) {
    trace = { turnId, startedAt, steps: [] };
    tracesByTurn.set(turnId, trace);
  }
  return trace;
}

function upsertTraceStep(payload: GhampusTracePayload): GhampusTurnTrace {
  const trace = ensureTurnTrace(payload.turnId, payload.ts - (payload.elapsedMs ?? 0));
  const idx = trace.steps.findIndex((s) => s.stepId === payload.stepId);
  const step: GhampusTraceStep = {
    stepId: payload.stepId,
    status: payload.status,
    label: payload.label,
    ...(payload.tool ? { tool: payload.tool } : {}),
    ...(payload.preview ? { preview: payload.preview } : {}),
    ...(payload.ms !== undefined ? { ms: payload.ms } : {}),
  };
  if (idx >= 0) trace.steps[idx] = step;
  else trace.steps.push(step);
  return trace;
}

function renderTraceStepHtml(step: GhampusTraceStep): string {
  const statusCls = `ghampus-trace-step--${step.status}`;
  const previewText = step.preview && step.preview !== step.label ? step.preview : '';
  const preview = previewText
    ? `<span class="ghampus-trace-step-preview"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(previewText)}</span>` : '';
  const ms = step.ms !== undefined
    ? `<span class="ghampus-trace-step-ms">${formatTraceElapsedMs(step.ms)}</span>`
    : '';
  return `<div class="ghampus-trace-step ${statusCls}">
    <span class="ghampus-trace-step-label">${escapeHtml(step.label)}</span>
    ${preview}${ms}
  </div>`;
}

function renderTraceMetaSummary(trace: GhampusTurnTrace, opts?: { live?: boolean }): string {
  const meta = formatTraceMetaText(trace);
  if (opts?.live) {
    return `<span class="ghampus-trace-summary-inline ghampus-trace-summary-inline--live" id="ghampus-live-trace-summary"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(meta)}</span>`;
  }
  return `<button type="button" class="ghampus-trace-toggle" aria-expanded="false" title="Show steps">
    <span class="ghampus-trace-chevron" aria-hidden="true">▸</span>
    <span class="ghampus-trace-summary-inline"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(meta)}</span>
  </button>`;
}

function renderTraceStepsOnly(trace: GhampusTurnTrace, opts?: { live?: boolean }): string {
  const steps = trace.steps.map(renderTraceStepHtml).join('');
  const idAttr = opts?.live ? ' id="ghampus-live-trace-steps"' : '';
  return `<div class="ghampus-trace-steps${opts?.live ? ' ghampus-trace-steps--live' : ''}"${idAttr} data-turn-id="${escapeHtml(trace.turnId)}">${steps}</div>`;
}

function wireTracePanel(node: HTMLElement): void {
  node.querySelector<HTMLButtonElement>('.ghampus-trace-toggle')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    const entry = btn.closest('.ghampus-thread-entry');
    const chatMsg = btn.closest('.chat-msg');
    const expanded = entry?.classList.toggle('trace-open') ?? false;
    chatMsg?.classList.toggle('trace-expanded', expanded);
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.querySelector('.ghampus-trace-chevron')?.classList.toggle('open', expanded);
  });
  const steps = node.querySelector<HTMLElement>('.ghampus-trace-steps');
  if (!steps) return;
  steps.addEventListener('scroll', () => {
    const atBottom = steps.scrollHeight - steps.scrollTop - steps.clientHeight < 10;
    if (liveTraceTurnId && steps.id === 'ghampus-live-trace-steps') {
      liveTraceScrollPinned = atBottom;
    }
  });
}

function mergeTraceFromPayload(turnId: string, trace?: GhampusTurnTrace): GhampusTurnTrace | undefined {
  if (trace) {
    const merged = {
      ...trace,
      steps: [...trace.steps],
      endedAt: trace.endedAt ?? Date.now(),
    };
    tracesByTurn.set(turnId, merged);
    return merged;
  }
  const existing = tracesByTurn.get(turnId);
  if (!existing) return undefined;
  existing.endedAt = Date.now();
  return { ...existing, steps: [...existing.steps] };
}

function renderLiveTrace(turnId: string): void {
  const trace = tracesByTurn.get(turnId);
  const stepsHost = document.getElementById('ghampus-live-trace-steps');
  if (!trace || !stepsHost) return;
  const pinned = liveTraceScrollPinned;
  stepsHost.innerHTML = trace.steps.map(renderTraceStepHtml).join('');
  updateLiveTraceSummary(turnId);
  const wrap = stepsHost.closest('.chat-msg-wrap');
  if (wrap) wireTracePanel(wrap);
  if (pinned) stepsHost.scrollTop = stepsHost.scrollHeight;
  scrollGhampusThreadToBottomIfPinned();
  sweepGhampusPres(stepsHost.closest('.ghampus-thread-entry') ?? stepsHost);
}

function clearLiveTraceSteps(): void {
  stopLiveTraceElapsedTimer();
  document.getElementById('ghampus-live-trace-steps')?.replaceChildren();
  const summaryEl = document.getElementById('ghampus-live-trace-summary');
  if (summaryEl) summaryEl.textContent = '';
  liveTraceTurnId = null;
  liveTraceScrollPinned = true;
}

const AWAY_DIGEST_PREFIX = '**While you were away**';
const QUIET_AWAY_DIGEST_RE = /all quiet/i;

function isQuietAwayDigest(msg: GhampusChatMessage): boolean {
  return msg.kind === 'ghampus'
    && msg.text.startsWith(AWAY_DIGEST_PREFIX)
    && QUIET_AWAY_DIGEST_RE.test(msg.text);
}

function sanitizeAwayDigestDisplayText(text: string): string {
  if (!text.startsWith(AWAY_DIGEST_PREFIX)) return text;
  // Legacy digests wrapped the LLM one-liner in _italics_ — strip for display.
  return text.replace(/(?<![\w/])_([^_\n]+?)_(?![\w/])/g, '$1');
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

/** Normalize flat ghampus-history.jsonl rows into typed chat messages. */
function normalizeGhampusHistoryMessages(messages: unknown[]): GhampusChatMessage[] {
  const out: GhampusChatMessage[] = [];
  for (const raw of messages) {
    const m = normalizeGhampusHistoryMessage(raw);
    if (m) out.push(m);
  }
  return out;
}

function normalizeGhampusHistoryMessage(raw: unknown): GhampusChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.kind === 'vitality-nudge' && typeof m.title === 'string') {
    return {
      kind: 'vitality-nudge',
      ts: typeof m.ts === 'number' ? m.ts : Date.now(),
      nudge: {
        id: String(m.id ?? `${String(m.nudgeId ?? 'vnudge')}-${m.ts ?? Date.now()}`),
        nudgeId: String(m.nudgeId ?? 'unknown'),
        title: m.title as string,
        body: String(m.body ?? ''),
        nudgeKind: String(m.nudgeKind ?? 'health-check'),
        ...(typeof m.examplePrompt === 'string' ? { examplePrompt: m.examplePrompt } : {}),
        ...(typeof m.walkSkillLabel === 'string' ? { walkSkillLabel: m.walkSkillLabel } : {}),
      },
    };
  }
  if (m.kind === 'tip' && typeof m.title === 'string') {
    return {
      kind: 'tip',
      ts: typeof m.ts === 'number' ? m.ts : Date.now(),
      tip: {
        id: String(m.id ?? `${String(m.tipId ?? 'tip')}-${m.ts ?? Date.now()}`),
        tipId: String(m.tipId ?? 'unknown'),
        title: m.title,
        body: String(m.body ?? ''),
        category: String(m.category ?? 'job-memory'),
        ...(typeof m.examplePrompt === 'string' ? { examplePrompt: m.examplePrompt } : {}),
        ...(typeof m.expectedOutcome === 'string' ? { expectedOutcome: m.expectedOutcome } : {}),
      },
    };
  }
  if ((m.kind === 'user' || m.kind === 'ghampus') && typeof m.text === 'string' && typeof m.ts === 'number') {
    const text = m.kind === 'ghampus' ? sanitizeAwayDigestDisplayText(m.text) : m.text;
    return { ...(raw as GhampusChatMessage), text };
  }
  if (m.kind === 'insights-preview' && Array.isArray(m.insights)) {
    const rows = (m.insights as unknown[]).filter((row) =>
      row && typeof row === 'object' && typeof (row as Record<string, unknown>).id === 'string',
    ) as ForesightInsightRow[];
    if (rows.length === 0) return null;
    return {
      kind: 'insights-preview',
      ts: typeof m.ts === 'number' ? m.ts : Date.now(),
      ...(typeof m.turnId === 'string' ? { turnId: m.turnId } : {}),
      insights: rows,
      totalCount: typeof m.totalCount === 'number' ? m.totalCount : rows.length,
    };
  }
  if (m.kind === 'skill-preview-improve' && m.card && typeof m.card === 'object') {
    const card = m.card as Record<string, unknown>;
    if (typeof card.skillLabel === 'string' && typeof card.skillSlug === 'string') {
      return {
        kind: 'skill-preview-improve',
        ts: typeof m.ts === 'number' ? m.ts : Date.now(),
        ...(typeof m.turnId === 'string' ? { turnId: m.turnId } : {}),
        card: {
          skillLabel: card.skillLabel,
          skillSlug: card.skillSlug,
          proPlus: Boolean(card.proPlus),
        },
      };
    }
  }
  return null;
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
  return `<time datetime="${new Date(ts).toISOString()}" data-posted-at="${ts}" title="${escapeHtml(fmtAbsTime(ts))}">${fmtRelTime(ts)}</time>`;
}

const GHAMPUS_TIME_TICK_MS = 30_000;
let ghampusTimeTicker: ReturnType<typeof setInterval> | null = null;

function postedAtFromTimeEl(el: HTMLTimeElement): number {
  const fromData = Number(el.dataset.postedAt);
  if (Number.isFinite(fromData) && fromData > 0) return fromData;
  const fromDatetime = Date.parse(el.getAttribute('datetime') ?? '');
  return Number.isFinite(fromDatetime) ? fromDatetime : 0;
}

function updateLiveTimeEl(el: HTMLTimeElement): void {
  const ts = postedAtFromTimeEl(el);
  if (ts <= 0) return;
  const rel = fmtRelTime(ts);
  if (el.textContent !== rel) el.textContent = rel;
  el.title = fmtAbsTime(ts);
}

function refreshGhampusMsgTimes(root: ParentNode = document): void {
  root.querySelectorAll<HTMLTimeElement>('#ghampus-thread .chat-msg-time time').forEach(updateLiveTimeEl);
}

/** Start/stop the live relative-time ticker for Ghampus chat messages. */
export function syncGhampusTimeTicker(active: boolean): void {
  if (active) {
    refreshGhampusMsgTimes();
    if (ghampusTimeTicker) return;
    ghampusTimeTicker = setInterval(() => refreshGhampusMsgTimes(), GHAMPUS_TIME_TICK_MS);
    return;
  }
  if (ghampusTimeTicker) {
    clearInterval(ghampusTimeTicker);
    ghampusTimeTicker = null;
  }
}

function wireGhampusThreadTimestamps(): void {
  const thread = document.getElementById('ghampus-thread');
  if (!thread || thread.dataset.timeHoverWired === '1') return;
  thread.dataset.timeHoverWired = '1';
  thread.addEventListener('mouseover', (e) => {
    const el = (e.target as Element).closest<HTMLTimeElement>('.chat-msg-time time');
    if (el) updateLiveTimeEl(el);
  });
}

function wireGhampusThreadScrollPin(): void {
  const thread = document.getElementById('ghampus-thread');
  if (!thread || thread.dataset.scrollPinWired === '1') return;
  thread.dataset.scrollPinWired = '1';
  thread.addEventListener('scroll', () => {
    threadScrollPinned = isGhampusThreadAtBottom(thread);
  }, { passive: true });
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
    case 'ghampus': {
      const turnAttr = msg.turnId ? ` data-turn-id="${escapeHtml(msg.turnId)}"` : '';
      const msgId = String(msg.turnId ?? msg.ts);
      const traceMeta = msg.trace ? renderTraceMetaSummary(msg.trace) : '';
      const traceSteps = msg.trace ? renderTraceStepsOnly(msg.trace) : '';
      // Routing-legibility chip — only when this turn was dispatched to a
      // domain Agempus's skill. Descriptive (no re-dispatch action); clicking
      // deep-links to the Agents roster scrolled to that Agempus card.
      const handledByChip = msg.handledBy
        ? `<span class="ghampus-handled-by-chip" data-handled-by-engram="${escapeHtml(msg.handledBy.engramId)}" title="Routed to the ${escapeHtml(msg.handledBy.engramName)} Agempus — open the Agents roster"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>Handled by <strong${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(msg.handledBy.engramName)}</strong> · ${escapeHtml(msg.handledBy.skillLabel)}</span>`
        : '';
      return `<div class="chat-msg ghampus"${turnAttr} data-msg-id="${escapeHtml(msgId)}">
        <div class="chat-msg-avatar">
          <img src="/graphnosis-logo-transparent-bg.png" alt="" />
        </div>
        <div class="chat-msg-wrap">
          ${handledByChip}
          <div class="chat-msg-bubble chat-msg-bubble--markdown">${app().renderMarkdownLite(msg.text)}</div>
          <div class="chat-msg-meta">
            <div class="chat-msg-time">${fmtTime(msg.ts)}</div>
            ${copyBtn(msg.text)}
            ${traceMeta}
          </div>
          ${traceSteps}
        </div>
      </div>`;
    }
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
    case 'tip':
      return renderTipCard(msg.tip, msg.ts);
    case 'vitality-nudge':
      return renderVitalityNudgeCard(msg.nudge, msg.ts);
    case 'attention-nudge':
      return renderAttentionNudgeCard(msg.counts, msg.ts);
    case 'memory-suggestion':
      return renderMemorySuggestionCard(msg.suggestion, msg.ts);
    case 'recovery-nudge':
      return renderRecoveryNudgeCard(msg.nudge, msg.ts);
    case 'skill-preview-improve':
      return renderSkillPreviewImproveCard(msg.card, msg.ts);
    case 'insights-preview':
      return renderInsightsPreviewCard(msg.insights, msg.totalCount, msg.ts);
    default:
      return '';
  }
}

function renderSkillMatchCard(skill: SkillMatchPayload, ts: number): string {
  const subChip = skill.subSkills > 0
    ? `<span class="skill-meta-chip"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${skill.subSkills} sub-skill${skill.subSkills > 1 ? 's' : ''}</span>` : '';
  return `<div class="skill-match-card" data-skill-source="${escapeHtml(skill.sourceId)}">
    <div class="skill-match-card-header">
      <span style="font-size: 16px;">🎓</span>
      <span class="skill-match-card-name"${presSkillAttr(skill.sourceId)}>${escapeHtml(skill.label)}</span>
    </div>
    <div class="skill-match-chips">
      <span class="skill-meta-chip"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${skill.steps} steps</span>
      ${subChip}
      <span class="skill-meta-chip"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>last run ${escapeHtml(skill.lastRunAgo)}</span>
      <span class="skill-meta-chip"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>vitality ${skill.vitality}</span>
    </div>
    <p class="skill-match-desc"${presSkillAttr(skill.sourceId)}>${escapeHtml(skill.description)}</p>
    <div class="skill-match-actions">
      <button class="g-btn primary btn-skill-run" style="font-size: 12px; padding: 4px 12px;"
              data-source-id="${escapeHtml(skill.sourceId)}"
              data-skill-label="${escapeHtml(skill.label)}">Preview</button>
      <button class="g-btn btn-skill-dismiss" style="font-size: 12px; padding: 4px 10px;"
              data-source-id="${escapeHtml(skill.sourceId)}">Not now</button>
    </div>
  </div>`;
}

const TIP_CATEGORY_LABELS: Record<string, string> = {
  'job-memory': 'Job memory',
  'slash-commands': 'Slash commands',
  'engram-scoping': 'Engrams',
  'follow-ups': 'Follow-ups',
  'skills': 'Skills',
  'mcp-claude': 'MCP / Claude',
  'recovery': 'Recovery',
  'brain-linking': 'Brain & links',
  'sharing': 'Sharing',
};

/** Proactive cards dismissed this session — not re-shown until reload. */
const sessionDismissedProactiveCards = new Set<string>();

function proactiveCardDismissKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function isProactiveCardDismissed(kind: string, id: string): boolean {
  return sessionDismissedProactiveCards.has(proactiveCardDismissKey(kind, id));
}

function dismissProactiveCardInSession(kind: string, id: string): void {
  sessionDismissedProactiveCards.add(proactiveCardDismissKey(kind, id));
  purgeGhampusThreadDismissed(kind, id);
}

function proactiveDismissIdForMessage(msg: GhampusChatMessage): { kind: string; id: string } | null {
  switch (msg.kind) {
    case 'memory-suggestion':
      return { kind: 'memory-suggestion', id: msg.suggestion.id };
    case 'tip':
      return { kind: 'tip', id: msg.tip.tipId };
    case 'vitality-nudge':
      return { kind: 'vitality', id: msg.nudge.nudgeId };
    case 'attention-nudge':
      return { kind: 'attention', id: ATTENTION_NUDGE_ID };
    case 'recovery-nudge':
      return { kind: 'recovery', id: msg.nudge.graphId };
    case 'proactive-card':
      return { kind: 'proactive', id: msg.card.id };
    default:
      return null;
  }
}

function shouldSkipGhampusThreadMessage(msg: GhampusChatMessage): boolean {
  const dismiss = proactiveDismissIdForMessage(msg);
  if (!dismiss) return false;
  return isProactiveCardDismissed(dismiss.kind, dismiss.id);
}

function purgeGhampusThreadDismissed(kind: string, id: string): void {
  ghampusThreadMessages = ghampusThreadMessages.filter((msg) => {
    const dismiss = proactiveDismissIdForMessage(msg);
    return !(dismiss && dismiss.kind === kind && dismiss.id === id);
  });
}

function fillGhampusPrompt(text: string): void {
  const input = document.getElementById('ghampus-input') as HTMLTextAreaElement | null;
  if (!input) return;
  input.value = text;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  trackGhampusTyping();
}

function renderTryBlock(examplePrompt: string): string {
  return `<div class="ghampus-tip-example">
        <span class="ghampus-tip-example-label">Try</span>
        <code class="ghampus-tip-example-prompt"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(examplePrompt)}</code>
        <button type="button" class="g-btn ghampus-tip-fill-prompt" data-prompt="${escapeHtml(examplePrompt)}">Fill prompt</button>
      </div>`;
}

function renderCardDismissButton(className: string, dismissKind: string, dismissId: string): string {
  return `<button type="button" class="g-btn ${className}" data-dismiss-kind="${escapeHtml(dismissKind)}" data-dismiss-id="${escapeHtml(dismissId)}">Dismiss</button>`;
}

function wireFillPromptButtons(node: HTMLElement): void {
  node.querySelectorAll<HTMLButtonElement>('.ghampus-tip-fill-prompt').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt;
      if (prompt) fillGhampusPrompt(prompt);
    });
  });
}

function wireCardDismissButton(node: HTMLElement, onDismiss?: () => void): void {
  node.querySelectorAll<HTMLButtonElement>('[data-dismiss-kind]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.dismissKind ?? '';
      const id = btn.dataset.dismissId ?? '';
      if (kind && id) dismissProactiveCardInSession(kind, id);
      onDismiss?.();
      btn.closest('.ghampus-thread-entry')?.remove();
    });
  });
}

function renderSkillPreviewImproveCard(card: SkillPreviewImproveCardPayload, ts: number): string {
  const label = escapeHtml(card.skillLabel);
  const slug = escapeHtml(card.skillSlug);
  const improveBtn = card.proPlus
    ? `<button type="button" class="g-btn primary ghampus-skill-improve-btn" data-skill-slug="${slug}" data-skill-label="${label}">Improve skill</button>`
    : '';
  const upgrade = card.proPlus
    ? ''
    : `<p class="ghampus-skill-preview-upgrade">Skill training is on <strong>Pro+</strong> — preview is always available.</p>`;
  return `<div class="chat-msg ghampus">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="chat-msg-wrap">
      <div class="ghampus-skill-preview-improve-card" data-skill-slug="${slug}">
        <span class="ghampus-tip-badge">Skill</span>
        <p class="ghampus-tip-body" style="margin: 6px 0 0;"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>Previewed <strong${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${label}</strong>. Want to refine the SOP?</p>
        ${upgrade}
        <div class="ghampus-skill-preview-improve-actions">
          ${improveBtn}
          <button type="button" class="g-btn ghampus-skill-improve-dismiss" data-skill-slug="${slug}">Dismiss</button>
        </div>
      </div>
      <div class="chat-msg-meta">
        <div class="chat-msg-time">${fmtTime(ts)}</div>
      </div>
    </div>
  </div>`;
}

function newGhampusFragmentCommentId(): string {
  return `fc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function findGhampusMessageTextById(messageId: string): string | null {
  for (let i = ghampusThreadMessages.length - 1; i >= 0; i--) {
    const m = ghampusThreadMessages[i];
    if (m?.kind !== 'ghampus') continue;
    const id = String(m.turnId ?? m.ts);
    if (id === messageId) return m.text;
  }
  return null;
}

function locatePlainTextPoint(root: HTMLElement, offset: number): { node: Text; off: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.textContent?.length ?? 0;
    if (pos + len >= offset) {
      return { node, off: Math.max(0, Math.min(offset - pos, len)) };
    }
    pos += len;
    node = walker.nextNode() as Text | null;
  }
  return null;
}

function findFragmentQuoteOffsetInPlain(
  fullText: string,
  quoted: string,
  opts: { startOffset?: number; contextBefore?: string; contextAfter?: string } = {},
): number {
  if (!quoted) return -1;

  const candidates: number[] = [];
  let scan = 0;
  while (scan <= fullText.length) {
    const idx = fullText.indexOf(quoted, scan);
    if (idx < 0) break;
    candidates.push(idx);
    scan = idx + Math.max(1, quoted.length);
  }
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0]!;

  const contextWindow = 48;
  if (opts.startOffset != null && opts.startOffset >= 0) {
    const exact = candidates.find((pos) => pos === opts.startOffset);
    if (exact != null && fullText.slice(exact, exact + quoted.length) === quoted) {
      return exact;
    }
    let closest = candidates[0]!;
    let minDist = Math.abs(candidates[0]! - opts.startOffset);
    for (const pos of candidates) {
      const d = Math.abs(pos - opts.startOffset);
      if (d < minDist) {
        minDist = d;
        closest = pos;
      }
    }
    if (minDist <= 64) return closest;
  }

  const before = opts.contextBefore ?? '';
  const after = opts.contextAfter ?? '';
  let best = candidates[0]!;
  let bestScore = -1;
  for (const pos of candidates) {
    let score = 0;
    const windowBefore = fullText.slice(Math.max(0, pos - contextWindow), pos);
    const windowAfter = fullText.slice(pos + quoted.length, pos + quoted.length + contextWindow);
    if (before) {
      if (windowBefore.endsWith(before)) score += 8;
      else if (before.length >= 12 && windowBefore.endsWith(before.slice(-12))) score += 5;
      else if (windowBefore.includes(before)) score += 2;
    }
    if (after) {
      if (windowAfter.startsWith(after)) score += 8;
      else if (after.length >= 12 && windowAfter.startsWith(after.slice(0, 12))) score += 5;
      else if (windowAfter.includes(after)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = pos;
    }
  }
  return best;
}

function extractFragmentContextAt(
  fullText: string,
  quoted: string,
  startOffset: number,
): { before?: string; after?: string } {
  const idx = findFragmentQuoteOffsetInPlain(fullText, quoted, { startOffset });
  if (idx < 0) return {};
  const contextWindow = 48;
  const before = fullText.slice(Math.max(0, idx - contextWindow), idx);
  const after = fullText.slice(idx + quoted.length, idx + quoted.length + contextWindow);
  return {
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
}

function getSelectionStartOffset(bubble: HTMLElement, range: Range): number {
  const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let node = walker.nextNode() as Text | null;
  const { startContainer, startOffset } = range;
  while (node) {
    if (node === startContainer) return pos + startOffset;
    pos += node.textContent?.length ?? 0;
    node = walker.nextNode() as Text | null;
  }
  return pos;
}

function wrapPlainTextRangeInBubble(
  root: HTMLElement,
  start: number,
  end: number,
  className: string,
): boolean {
  if (start < 0 || end <= start) return false;
  const startPoint = locatePlainTextPoint(root, start);
  const endPoint = locatePlainTextPoint(root, end);
  if (!startPoint || !endPoint) return false;
  try {
    const range = document.createRange();
    range.setStart(startPoint.node, startPoint.off);
    range.setEnd(endPoint.node, endPoint.off);
    const span = document.createElement('span');
    span.className = className;
    try {
      range.surroundContents(span);
    } catch {
      const contents = range.extractContents();
      span.appendChild(contents);
      range.insertNode(span);
    }
    return true;
  } catch {
    return false;
  }
}

function getGhampusBubblePlainText(bubble: HTMLElement): string {
  return bubble.textContent ?? '';
}

function paintGhampusFragmentCommentsBar(): void {
  const bar = document.getElementById('ghampus-comments-bar');
  const toggle = document.getElementById('btn-ghampus-comments-toggle');
  const reviewBtn = document.getElementById('btn-ghampus-review-comments') as HTMLButtonElement | null;
  const list = document.getElementById('ghampus-comments-list');
  if (!bar || !toggle || !reviewBtn || !list) return;
  const n = ghampusFragmentComments.length;
  bar.classList.toggle('hidden', n === 0);
  toggle.textContent = `${n} comment${n === 1 ? '' : 's'}`;
  reviewBtn.disabled = n === 0;
  list.innerHTML = ghampusFragmentComments.map((c) => `
    <li class="ghampus-comments-bar-item" data-comment-id="${escapeHtml(c.id)}">
      <div class="ghampus-comments-bar-quote"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>"${escapeHtml(c.quotedText.slice(0, 100))}${c.quotedText.length > 100 ? '…' : ''}"</div>
      <div class="ghampus-comments-bar-note"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(c.userComment)}</div>
      <button type="button" class="ghampus-comments-bar-remove" data-comment-id="${escapeHtml(c.id)}">Remove</button>
    </li>`).join('');
  list.querySelectorAll<HTMLButtonElement>('.ghampus-comments-bar-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.commentId ?? '';
      const idx = ghampusFragmentComments.findIndex((c) => c.id === id);
      if (idx >= 0) ghampusFragmentComments.splice(idx, 1);
      paintGhampusFragmentCommentsBar();
      applyGhampusFragmentMarks();
    });
  });
  sweepGhampusPres(bar);
}

function applyGhampusFragmentMarks(): void {
  const thread = document.getElementById('ghampus-thread');
  if (!thread) return;

  const byMessage = new Map<string, GhampusFragmentCommentEntry[]>();
  for (const c of ghampusFragmentComments) {
    const arr = byMessage.get(c.messageId) ?? [];
    arr.push(c);
    byMessage.set(c.messageId, arr);
  }

  for (const [messageId, comments] of byMessage) {
    const msgEl = thread.querySelector<HTMLElement>(`.chat-msg.ghampus[data-msg-id="${CSS.escape(messageId)}"]`);
    const bubble = msgEl?.querySelector<HTMLElement>('.chat-msg-bubble');
    if (!bubble) continue;

    const sourceMd = findGhampusMessageTextById(messageId);
    if (sourceMd) {
      bubble.innerHTML = app().renderMarkdownLite(sourceMd);
    }

    const plain = getGhampusBubblePlainText(bubble);
    const sorted = [...comments].sort((a, b) => {
      const oa = findFragmentQuoteOffsetInPlain(plain, a.quotedText, a);
      const ob = findFragmentQuoteOffsetInPlain(plain, b.quotedText, b);
      return ob - oa;
    });

    for (const c of sorted) {
      const start = findFragmentQuoteOffsetInPlain(plain, c.quotedText, c);
      if (start < 0) continue;
      wrapPlainTextRangeInBubble(bubble, start, start + c.quotedText.length, 'ghampus-fragment-mark');
    }
  }
  sweepGhampusPres(thread);
}

function clearGhampusFragmentComments(): void {
  ghampusFragmentComments.length = 0;
  paintGhampusFragmentCommentsBar();
  applyGhampusFragmentMarks();
}

function hideGhampusCommentPopover(): void {
  document.getElementById('ghampus-comment-popover')?.classList.remove('open');
  ghampusPendingFragmentSelection = null;
  document.getElementById('ghampus-selection-affordance')?.classList.remove('visible');
}

function showGhampusCommentPopover(): void {
  const pending = ghampusPendingFragmentSelection;
  if (!pending) return;
  const pop = document.getElementById('ghampus-comment-popover');
  const quoteEl = document.getElementById('ghampus-comment-popover-quote');
  const input = document.getElementById('ghampus-comment-popover-input') as HTMLTextAreaElement | null;
  if (!pop || !quoteEl || !input) return;
  quoteEl.textContent = `"${pending.quotedText.slice(0, 140)}${pending.quotedText.length > 140 ? '…' : ''}"`;
  input.value = '';
  pop.classList.add('open');
  const rect = pending.anchorRect;
  if (rect) {
    pop.style.left = `${Math.min(rect.left, window.innerWidth - 340)}px`;
    pop.style.top = `${Math.max(8, rect.top - pop.offsetHeight - 8)}px`;
  }
  input.focus();
}

function wireGhampusFragmentComments(): void {
  const thread = document.getElementById('ghampus-thread');
  const affordance = document.getElementById('ghampus-selection-affordance');
  if (!thread || !affordance || thread.dataset.fragmentCommentsWired === '1') return;
  thread.dataset.fragmentCommentsWired = '1';

  const positionAffordance = (rect: DOMRect) => {
    affordance.style.left = `${Math.min(rect.left, window.innerWidth - 120)}px`;
    affordance.style.top = `${Math.max(8, rect.top - 32)}px`;
    affordance.classList.add('visible');
  };

  thread.addEventListener('mouseup', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.ghampus-comment-popover, .ghampus-selection-affordance')) return;
    const bubble = target.closest<HTMLElement>('.chat-msg.ghampus .chat-msg-bubble');
    if (!bubble) {
      affordance.classList.remove('visible');
      return;
    }
    const sel = window.getSelection();
    const selected = sel?.toString().trim() ?? '';
    if (!selected || selected.length < 2) {
      affordance.classList.remove('visible');
      return;
    }
    const chatMsg = bubble.closest<HTMLElement>('.chat-msg.ghampus');
    const messageId = chatMsg?.dataset.msgId ?? chatMsg?.dataset.turnId ?? '';
    if (!messageId) return;
    // Do NOT reset bubble.innerHTML here — that would replace the text nodes
    // the live Selection points into, collapsing it before the Range below is
    // read (selection visibly vanishes, offset/rect end up null). textContent
    // is identical whether or not prior fragment-mark spans are present, so
    // no reset is needed to compute parentAnswerText/offset correctly.
    // applyGhampusFragmentMarks() already does the clean-reset-and-remark pass
    // properly (all comments at once) right after a comment is saved.
    const parentAnswerText = getGhampusBubblePlainText(bubble);
    const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
    const quoteStartOffset = range ? getSelectionStartOffset(bubble, range) : undefined;
    const ctx = extractFragmentContextAt(parentAnswerText, selected, quoteStartOffset ?? 0);
    const rect = range?.getBoundingClientRect();
    ghampusPendingFragmentSelection = {
      messageId,
      quotedText: selected,
      parentAnswerText,
      ...(quoteStartOffset != null ? { quoteStartOffset } : {}),
      ...(ctx.before ? { contextBefore: ctx.before } : {}),
      ...(ctx.after ? { contextAfter: ctx.after } : {}),
      ...(rect && rect.width > 0 ? { anchorRect: rect } : {}),
    };
    if (rect && rect.width > 0) positionAffordance(rect);
  });

  affordance.addEventListener('click', () => showGhampusCommentPopover());
  affordance.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      showGhampusCommentPopover();
    }
  });

  document.getElementById('btn-ghampus-comment-cancel')?.addEventListener('click', () => hideGhampusCommentPopover());
  document.getElementById('btn-ghampus-comment-save')?.addEventListener('click', () => {
    const pending = ghampusPendingFragmentSelection;
    const input = document.getElementById('ghampus-comment-popover-input') as HTMLTextAreaElement | null;
    const note = input?.value.trim() ?? '';
    if (!pending || note.length < 1) return;
    ghampusFragmentComments.push({
      id: newGhampusFragmentCommentId(),
      messageId: pending.messageId,
      quotedText: pending.quotedText,
      userComment: note,
      parentAnswerText: pending.parentAnswerText,
      ...(pending.quoteStartOffset != null ? { quoteStartOffset: pending.quoteStartOffset } : {}),
      ...(pending.contextBefore ? { contextBefore: pending.contextBefore } : {}),
      ...(pending.contextAfter ? { contextAfter: pending.contextAfter } : {}),
    });
    hideGhampusCommentPopover();
    paintGhampusFragmentCommentsBar();
    applyGhampusFragmentMarks();
    window.getSelection()?.removeAllRanges();
  });

  let commentsListOpen = false;
  document.getElementById('btn-ghampus-comments-toggle')?.addEventListener('click', () => {
    commentsListOpen = !commentsListOpen;
    document.getElementById('ghampus-comments-list')?.classList.toggle('open', commentsListOpen);
  });

  document.getElementById('btn-ghampus-review-comments')?.addEventListener('click', () => {
    if (ghampusFragmentComments.length === 0) return;
    void submitGhampusFragmentReview();
  });

  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#ghampus-comment-popover, #ghampus-selection-affordance')) return;
    if (!t.closest('.chat-msg.ghampus .chat-msg-bubble')) {
      document.getElementById('ghampus-selection-affordance')?.classList.remove('visible');
    }
  });
}

async function submitGhampusFragmentReview(): Promise<void> {
  if (ghampusFragmentComments.length === 0) return;
  const turnId = newGhampusTurnId();
  const ts = Date.now();
  const comments = ghampusFragmentComments.map((c) => ({
    messageId: c.messageId,
    quotedText: c.quotedText,
    userComment: c.userComment,
    parentAnswerText: c.parentAnswerText,
    ...(c.quoteStartOffset != null ? { quoteStartOffset: c.quoteStartOffset } : {}),
    ...(c.contextBefore ? { contextBefore: c.contextBefore } : {}),
    ...(c.contextAfter ? { contextAfter: c.contextAfter } : {}),
  }));
  enqueueGhampusSend({
    turnId,
    ts,
    userText: `Review ${comments.length} comment${comments.length === 1 ? '' : 's'} on selected passages`,
    ipcPayload: {
      text: 'Review comments',
      turnId,
      fragmentReview: { type: 'fragment_review' as const, comments },
    },
    onSent: () => { clearGhampusFragmentComments(); },
  });
}

function renderRecoveryNudgeCard(nudge: RecoveryNudgePayload, ts: number): string {
  const bodyHtml = escapeHtml(nudge.text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  return `<div class="chat-msg ghampus">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="chat-msg-wrap">
      <div class="ghampus-recovery-nudge-card" data-graph-id="${escapeHtml(nudge.graphId)}">
        <div class="ghampus-tip-header">
          <span class="ghampus-tip-badge" style="background: var(--warn, #b8860b);">Recovery</span>
          <span class="ghampus-tip-category"${presEngramAttr(nudge.graphId)}>${escapeHtml(nudge.displayName)}</span>
        </div>
        <p class="ghampus-recovery-nudge-body"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${bodyHtml}</p>
        <div class="ghampus-memory-suggestion-actions">
          <button class="g-btn primary ghampus-recovery-open">Open Recovery</button>
          ${renderCardDismissButton('ghampus-recovery-dismiss', 'recovery', nudge.graphId)}
        </div>
      </div>
      <div class="chat-msg-meta">
        <div class="chat-msg-time">${fmtTime(ts)}</div>
      </div>
    </div>
  </div>`;
}

function renderVitalityNudgeCard(nudge: VitalityNudgeCardPayload, ts: number): string {
  const bodyHtml = escapeHtml(nudge.body).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const exampleBlock = nudge.examplePrompt ? renderTryBlock(nudge.examplePrompt) : '';
  const previewBtn = nudge.walkSkillLabel
    ? `<button type="button" class="g-btn primary ghampus-vitality-preview" data-prompt="/preview ${escapeHtml(nudge.walkSkillLabel)}">Preview ${escapeHtml(nudge.walkSkillLabel.replace(/-/g, ' '))}</button>`
    : '';
  const actions = (previewBtn || nudge.examplePrompt)
    ? `<div class="ghampus-vitality-nudge-actions">${previewBtn}${renderCardDismissButton('ghampus-vitality-dismiss', 'vitality', nudge.nudgeId)}</div>`
    : `<div class="ghampus-tip-actions">${renderCardDismissButton('ghampus-vitality-dismiss', 'vitality', nudge.nudgeId)}</div>`;
  return `<div class="chat-msg ghampus">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="chat-msg-wrap">
      <div class="ghampus-tip-card ghampus-vitality-nudge-card" data-nudge-id="${escapeHtml(nudge.nudgeId)}">
        <div class="ghampus-tip-header">
          <span class="ghampus-tip-badge">Vitality</span>
          <span class="ghampus-tip-category">${escapeHtml(nudge.nudgeKind.replace(/-/g, ' '))}</span>
        </div>
        <p class="ghampus-tip-title"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(nudge.title)}</p>
        <p class="ghampus-tip-body"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${bodyHtml}</p>
        ${exampleBlock}${actions}
      </div>
      <div class="chat-msg-meta">
        <div class="chat-msg-time">${fmtTime(ts)}</div>
      </div>
    </div>
  </div>`;
}

function renderTipCard(tip: TipCardPayload, ts: number): string {
  const catLabel = TIP_CATEGORY_LABELS[tip.category] ?? tip.category;
  const bodyHtml = escapeHtml(tip.body).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const exampleBlock = tip.examplePrompt ? renderTryBlock(tip.examplePrompt) : '';
  const outcomeBlock = tip.expectedOutcome
    ? `<div class="ghampus-tip-outcome">
        <span class="ghampus-tip-outcome-label">Expected</span>
        <span class="ghampus-tip-outcome-text"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(tip.expectedOutcome)}</span>
      </div>`
    : '';
  const actions = `<div class="ghampus-tip-actions">${renderCardDismissButton('ghampus-tip-dismiss', 'tip', tip.tipId)}</div>`;
  return `<div class="chat-msg ghampus">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="chat-msg-wrap">
      <div class="ghampus-tip-card" data-tip-id="${escapeHtml(tip.tipId)}">
        <div class="ghampus-tip-header">
          <span class="ghampus-tip-badge">Tip</span>
          <span class="ghampus-tip-category">${escapeHtml(catLabel)}</span>
        </div>
        <p class="ghampus-tip-title"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(tip.title)}</p>
        <p class="ghampus-tip-body"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${bodyHtml}</p>
        ${exampleBlock}${outcomeBlock}${actions}
      </div>
      <div class="chat-msg-meta">
        <div class="chat-msg-time">${fmtTime(ts)}</div>
      </div>
    </div>
  </div>`;
}

function renderMemorySuggestionCard(suggestion: MemorySuggestionCardPayload, ts: number): string {
  const kindLabel = suggestion.kind === 'create_engram'
    ? 'New engram'
    : suggestion.kind === 'obligation'
      ? 'Deadline'
      : 'Memory';
  const preview = escapeHtml(suggestion.text);
  const engramDefault = escapeHtml(suggestion.engramHint ?? 'personal');
  const obligationNote = suggestion.obligation
    ? `<span class="ghampus-memory-suggestion-due">Due ${new Date(suggestion.obligation.expiresAt).toLocaleDateString()}</span>`
    : '';
  const createNote = suggestion.kind === 'create_engram' && suggestion.createEngramName
    ? `<span class="ghampus-memory-suggestion-due">Create engram: ${escapeHtml(suggestion.createEngramName)}</span>`
    : '';
  return `<div class="chat-msg ghampus">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="chat-msg-wrap">
      <div class="ghampus-memory-suggestion-card" data-suggestion-id="${escapeHtml(suggestion.id)}">
        <div class="ghampus-memory-suggestion-header">
          <span class="ghampus-memory-suggestion-badge">Memory</span>
          <span class="ghampus-memory-suggestion-kind">${escapeHtml(kindLabel)}</span>
        </div>
        <p class="ghampus-memory-suggestion-title"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>Save to your cortex?</p>
        <p class="ghampus-memory-suggestion-reason"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(suggestion.reason)}</p>
        <blockquote class="ghampus-memory-suggestion-preview"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${preview}</blockquote>
        ${obligationNote}${createNote}
        <div class="ghampus-memory-suggestion-engram">
          <label class="ghampus-memory-suggestion-engram-label">Engram</label>
          <select class="ghampus-memory-suggestion-engram-select" data-default="${engramDefault}"${presEngramAttr(suggestion.engramHint ?? 'personal')}>
            <option value="${engramDefault}"${presEngramAttr(suggestion.engramHint ?? 'personal')}>${engramDefault}</option>
          </select>
        </div>
        <div class="ghampus-memory-suggestion-actions">
          <button class="g-btn primary ghampus-memory-suggestion-save" data-suggestion-id="${escapeHtml(suggestion.id)}">Save</button>
          <button class="g-btn ghampus-memory-suggestion-later" data-suggestion-id="${escapeHtml(suggestion.id)}">Not now</button>
          <button class="g-btn ghampus-memory-suggestion-dismiss" data-suggestion-id="${escapeHtml(suggestion.id)}">Dismiss</button>
        </div>
      </div>
      <div class="chat-msg-meta">
        <div class="chat-msg-time">${fmtTime(ts)}</div>
      </div>
    </div>
  </div>`;
}

function renderInsightsPreviewCard(
  insights: ForesightInsightRow[],
  totalCount: number,
  ts: number,
): string {
  const foresightDeps = {
    escapeHtml,
    engramName: (graphId: string) => app().engramName(graphId),
  };
  const cards = insights.map((i) =>
    renderInsightCard(i, foresightDeps, { compact: true, showDismiss: true, showAction: true }),
  ).join('');
  const more = totalCount > insights.length
    ? `<p class="ghampus-insights-more">${totalCount - insights.length} more in Foresight</p>`
    : '';
  return `<div class="chat-msg ghampus">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="" />
    </div>
    <div class="chat-msg-wrap">
      <div class="ghampus-insights-preview">
        <div class="ghampus-insights-preview-header">
          <span class="ghampus-insights-preview-title">Foresight insights</span>
          <span class="ghampus-insights-preview-stat">${totalCount} active</span>
        </div>
        <div class="ghampus-insights-preview-grid">${cards}</div>
        ${more}
        <div class="ghampus-insights-preview-footer">
          <button type="button" class="g-btn primary ghampus-insights-open-all">View all</button>
        </div>
      </div>
      <div class="chat-msg-meta">
        <div class="chat-msg-time">${fmtTime(ts)}</div>
      </div>
    </div>
  </div>`;
}

function wireInsightsPreviewActions(node: HTMLElement, insights: ForesightInsightRow[]): void {
  const foresightDeps = {
    escapeHtml,
    engramName: (graphId: string) => app().engramName(graphId),
    openNonDeterministic: () => {},
    onDismissInsight: async (id: string) => {
      await ipcCall('brain:dismissInsight', { id }).catch(() => {});
      node.querySelector(`[data-insight-id="${CSS.escape(id)}"]`)?.remove();
    },
    onInsightAction: async (action: InsightPrimaryAction, insight: ForesightInsightRow) => {
      if (action.kind === 'open-integrity') {
        app().activateMode('goals');
        openMemoryIntegrityWorkbench('queue');
        return;
      }
      const prompt = action.prompt ?? insightPrimaryAction(insight, app().engramName(insight.graphId)).prompt;
      if (prompt) fillGhampusPrompt(prompt);
    },
  };

  node.querySelector<HTMLButtonElement>('.ghampus-insights-open-all')?.addEventListener('click', () => {
    app().activateMode('goals');
    openForesightLaneModal('insights');
  });

  node.querySelectorAll<HTMLButtonElement>('[data-dismiss-insight]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset['dismissInsight'];
      if (id) void foresightDeps.onDismissInsight(id);
    });
  });

  node.querySelectorAll<HTMLButtonElement>('[data-insight-action]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset['insightId'];
      const kind = btn.dataset['insightAction'] as InsightPrimaryAction['kind'] | undefined;
      const prompt = btn.dataset['insightPrompt'];
      if (!id || !kind) return;
      const insight = insights.find((row) => row.id === id);
      if (!insight) return;
      const action = insightPrimaryAction(insight, app().engramName(insight.graphId));
      if (prompt) action.prompt = prompt;
      void foresightDeps.onInsightAction(action, insight);
    });
  });
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
        <p class="proactive-card-why"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${whyHtml}</p>
        <div class="proactive-card-actions">
          <button class="g-btn primary proactive-card-preview" data-card-id="${escapeHtml(card.id)}"
                  data-skill-label="${escapeHtml(card.skillLabel)}"${presSkillAttr(card.skillSourceId, card.skillGraphId)}>Preview ${escapeHtml(skillName)} ▸</button>
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
        <p class="proactive-card-why"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${whyHtml}</p>
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
// a time when Ghampus is visible — gentle rate limits apply while chatting.
const proactiveCardQueue: ProactiveCardPayload[] = [];
let lastGhampusSendAt = Date.now();
let lastGhampusTypingAt = 0;
/** True after the user sends at least one message this session. */
let ghampusChatSessionActive = false;
// Full idle before first card when user has not chatted yet.
const IDLE_BEFORE_FIRST_MS = 5 * 60_000;
// Soft idle after a send — allow a card without requiring a long break.
const IDLE_WHILE_CHAT_MS = 90_000;
// Don't interrupt mid-keystroke.
const TYPING_SUPPRESS_MS = 15_000;
// Max one proactive card per interval while the user is actively chatting.
const CHAT_ACTIVE_CARD_GAP_MS = 15 * 60_000;
// After each card while chatting, wait at least this long before the next.
let nextCardAllowedAt = 0;
let proactiveQueueTimer: ReturnType<typeof setInterval> | null = null;

/** Record a user send — resets soft-idle timer for proactive cards. */
function trackGhampusSendActivity(): void {
  lastGhampusSendAt = Date.now();
  ghampusChatSessionActive = true;
}

function trackGhampusTyping(): void {
  lastGhampusTypingAt = Date.now();
}

type PendingGhampusSend = {
  turnId: string;
  ts: number;
  userText: string;
  ipcPayload: Record<string, unknown>;
  onSent?: () => void;
};

/** Turn ids whose user bubble THIS client already painted locally — used to
 *  drop the sidecar's broadcast echo of our own question while still
 *  rendering questions that originated on other devices. */
const locallyRenderedUserTurns = new Set<string>();

const ghampusSendQueue: PendingGhampusSend[] = [];
let ghampusSendDrain: Promise<void> | null = null;
const ghampusTurnDoneWaiters = new Map<string, Array<() => void>>();

function notifyGhampusTurnDone(turnId: string): void {
  const waiters = ghampusTurnDoneWaiters.get(turnId);
  if (!waiters?.length) return;
  ghampusTurnDoneWaiters.delete(turnId);
  for (const resolve of waiters) resolve();
}

function waitGhampusTurnDone(turnId: string): Promise<void> {
  return new Promise((resolve) => {
    const list = ghampusTurnDoneWaiters.get(turnId) ?? [];
    list.push(resolve);
    ghampusTurnDoneWaiters.set(turnId, list);
  });
}

function clearGhampusSendQueue(): void {
  ghampusSendQueue.length = 0;
  ghampusTurnDoneWaiters.clear();
}

async function drainGhampusSendQueue(): Promise<void> {
  if (ghampusSendDrain) return ghampusSendDrain;
  ghampusSendDrain = (async () => {
    while (ghampusSendQueue.length > 0) {
      const item = ghampusSendQueue.shift()!;
      liveTraceTurnId = item.turnId;
      liveTraceScrollPinned = true;
      resetGhampusThreadScrollPin();
      ensureTurnTrace(item.turnId, item.ts);
      showThinkingBubble();
      const turnDone = waitGhampusTurnDone(item.turnId);
      try {
        await ipcCall('ghampus:send', item.ipcPayload);
        await turnDone;
        item.onSent?.();
      } catch {
        notifyGhampusTurnDone(item.turnId);
        forceClearThinkingBubble();
      }
    }
  })().finally(() => {
    ghampusSendDrain = null;
    if (ghampusSendQueue.length > 0) void drainGhampusSendQueue();
  });
  return ghampusSendDrain;
}

function enqueueGhampusSend(item: PendingGhampusSend): void {
  trackGhampusSendActivity();
  if (item.turnId) locallyRenderedUserTurns.add(item.turnId);
  appendToThread({ kind: 'user', text: item.userText, ts: item.ts, turnId: item.turnId });
  ghampusSendQueue.push(item);
  void drainGhampusSendQueue();
}

let _thinkingClearTimer: ReturnType<typeof setTimeout> | null = null;

function showThinkingBubble(): void {
  setGhampusRunning(true);
  if (_thinkingClearTimer) { clearTimeout(_thinkingClearTimer); _thinkingClearTimer = null; }

  if (document.getElementById('ghampus-thinking')) {
    if (liveTraceTurnId) {
      renderLiveTrace(liveTraceTurnId);
      startLiveTraceElapsedTimer();
    }
    return;
  }

  const container = ghampusChatMessagesEl();
  if (!container) return;

  resetGhampusThreadScrollPin();
  document.getElementById('ghampus-thread-empty')?.remove();

  const entry = document.createElement('div');
  entry.id = 'ghampus-thinking';
  entry.className = 'ghampus-thread-entry';
  const startedAt = liveTraceTurnId
    ? (tracesByTurn.get(liveTraceTurnId)?.startedAt ?? Date.now())
    : Date.now();
  entry.innerHTML = `<div class="chat-msg ghampus ghampus--working">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="chat-msg-wrap">
      <div class="ghampus-thinking-row">
        <div class="ghampus-thinking-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
      <div class="chat-msg-meta">
        <div class="chat-msg-time">${fmtTime(startedAt)}</div>
        <span class="ghampus-trace-summary-inline ghampus-trace-summary-inline--live" id="ghampus-live-trace-summary"></span>
      </div>
      <div id="ghampus-live-trace-steps" class="ghampus-trace-steps ghampus-trace-steps--live"></div>
    </div>
  </div>`;
  container.appendChild(entry);
  scrollGhampusThreadToBottomIfPinned();
  if (liveTraceTurnId) {
    renderLiveTrace(liveTraceTurnId);
    startLiveTraceElapsedTimer();
  }
  sweepGhampusPres(entry);
}

function clearThinkingBubble(): void {
  // Keep the bubble visible for at least 400 ms so a fast LLM response
  // doesn't make it flash imperceptibly.
  if (_thinkingClearTimer) return;
  _thinkingClearTimer = setTimeout(() => {
    forceClearThinkingBubble();
  }, 400);
}

function forceClearThinkingBubble(): void {
  if (_thinkingClearTimer) {
    clearTimeout(_thinkingClearTimer);
    _thinkingClearTimer = null;
  }
  document.getElementById('ghampus-thinking')?.remove();
  clearLiveTraceSteps();
  setGhampusRunning(false);
}

async function cancelGhampusTurn(): Promise<void> {
  const turnId = liveTraceTurnId ?? undefined;
  try {
    await ipcCall('ghampus:cancel', turnId ? { turnId } : {});
  } catch { /* non-fatal */ }
  forceClearThinkingBubble();
}

/** Sidecar → UI events (message stream, thinking indicator, proactive cards). */
function wireGhampusSidecarEvents(): void {
  void listen<GhampusChatMessage>(
    'graphnosis://ghampus-message',
    (ev) => {
      if (!ev.payload) return;
      let msg = ev.payload;
      // A user-kind frame is the broadcast copy of a question typed on SOME
      // device — render it so cross-device conversations stay complete, but
      // drop the echo of a question this UI already painted locally.
      if (msg.kind === 'user' && msg.turnId && locallyRenderedUserTurns.has(msg.turnId)) return;
      // Any sidecar turn terminal (ghampus text, insights card, …) must release the UI send queue.
      if (msg.turnId && msg.kind !== 'user') {
        if (msg.kind === 'ghampus') {
          const trace = mergeTraceFromPayload(msg.turnId, msg.trace);
          if (trace) msg = { ...msg, trace };
        }
        if (msg.turnId === liveTraceTurnId) clearLiveTraceSteps();
        notifyGhampusTurnDone(msg.turnId);
      }
      if (msg.kind === 'ghampus') {
        msg = { ...msg, text: sanitizeAwayDigestDisplayText(msg.text) };
        forceClearThinkingBubble();
      } else {
        clearThinkingBubble();
      }
      clearSkillRunning();
      const pane = document.querySelector<HTMLElement>('.mode-pane[data-pane="ghampus"]');
      const away = !pane || pane.classList.contains('hidden');
      appendToThread(msg);
      if (away && msg.kind === 'ghampus') {
        const preview = msg.text.length > 72
          ? `${msg.text.slice(0, 69)}…`
          : msg.text;
        const id = app().addIngestToast('Ghampus replied', preview);
        app().finishIngestToast(id, 'success');
      }
    },
  );

  void listen<{ thinking: boolean; ts: number; turnId?: string }>(
    'graphnosis://ghampus-thinking',
    (ev) => {
      const turnId = ev.payload?.turnId;
      if (turnId) {
        liveTraceTurnId = turnId;
        liveTraceScrollPinned = true;
        resetGhampusThreadScrollPin();
        ensureTurnTrace(turnId, ev.payload?.ts ?? Date.now());
      }
      showThinkingBubble();
    },
  );

  void listen<GhampusTracePayload>(
    'graphnosis://ghampus-trace',
    (ev) => {
      if (!ev.payload?.turnId) return;
      upsertTraceStep(ev.payload);
      if (ev.payload.turnId === liveTraceTurnId) renderLiveTrace(ev.payload.turnId);
    },
  );

  void listen<ProactiveCardPayload>(
    'graphnosis://ghampus-card',
    (ev) => {
      if (!ev.payload) return;
      proactiveCardQueue.push(ev.payload);
      startProactiveQueueTimer();
    },
  );

  void listen<{
    id: string;
    kind: string;
    title: string;
    text: string;
    ts: number;
    itemCount: number;
    notify: boolean;
  }>(
    'graphnosis://ghampus-reminder',
    (ev) => {
      if (!ev.payload?.text) return;
      const msg: GhampusChatMessage = {
        kind: 'ghampus',
        text: ev.payload.text,
        ts: ev.payload.ts ?? Date.now(),
      };
      appendToThread(msg);
      if (ev.payload.notify) {
        void maybeNotifyReminder(ev.payload.title, ev.payload.text);
      }
    },
  );

  void listen<{
    id: string;
    graphId: string;
    displayName: string;
    title: string;
    text: string;
    ts: number;
  }>(
    'graphnosis://ghampus-recovery-nudge',
    (ev) => {
      if (!ev.payload?.graphId) return;
      if (isProactiveCardDismissed('recovery', ev.payload.graphId)) return;
      const p = ev.payload;
      const msg: GhampusChatMessage = {
        kind: 'recovery-nudge',
        nudge: {
          id: p.id,
          graphId: p.graphId,
          displayName: p.displayName,
          title: p.title,
          text: p.text,
        },
        ts: p.ts ?? Date.now(),
      };
      appendToThread(msg);
    },
  );

  void listen<{
    id: string;
    tipId: string;
    title: string;
    body: string;
    category: string;
    ts: number;
    examplePrompt?: string;
    expectedOutcome?: string;
  }>(
    'graphnosis://ghampus-tip',
    (ev) => {
      if (!ev.payload?.title) return;
      if (isProactiveCardDismissed('tip', ev.payload.tipId)) return;
      const p = ev.payload;
      const msg: GhampusChatMessage = {
        kind: 'tip',
        tip: {
          id: p.id,
          tipId: p.tipId,
          title: p.title,
          body: p.body,
          category: p.category,
          ...(p.examplePrompt ? { examplePrompt: p.examplePrompt } : {}),
          ...(p.expectedOutcome ? { expectedOutcome: p.expectedOutcome } : {}),
        },
        ts: p.ts ?? Date.now(),
      };
      appendToThread(msg);
    },
  );

  void listen<{
    id: string;
    nudgeId: string;
    title: string;
    body: string;
    kind: string;
    ts: number;
    examplePrompt?: string;
    walkSkillLabel?: string;
  }>(
    'graphnosis://ghampus-vitality-nudge',
    (ev) => {
      if (!ev.payload?.title) return;
      if (isProactiveCardDismissed('vitality', ev.payload.nudgeId)) return;
      const p = ev.payload;
      const msg: GhampusChatMessage = {
        kind: 'vitality-nudge',
        nudge: {
          id: p.id,
          nudgeId: p.nudgeId,
          title: p.title,
          body: p.body,
          nudgeKind: p.kind,
          ...(p.examplePrompt ? { examplePrompt: p.examplePrompt } : {}),
          ...(p.walkSkillLabel ? { walkSkillLabel: p.walkSkillLabel } : {}),
        },
        ts: p.ts ?? Date.now(),
      };
      appendToThread(msg);
    },
  );

  void listen<{
    id: string;
    kind: 'remember' | 'obligation' | 'create_engram';
    text: string;
    engramHint?: string;
    createEngramName?: string;
    obligation?: { obligationType: string; expiresAt: number };
    reason: string;
    ts: number;
  }>(
    'graphnosis://ghampus-memory-suggestion',
    (ev) => {
      if (!ev.payload?.text) return;
      if (isProactiveCardDismissed('memory-suggestion', ev.payload.id)) return;
      const p = ev.payload;
      const msg: GhampusChatMessage = {
        kind: 'memory-suggestion',
        suggestion: {
          id: p.id,
          kind: p.kind,
          text: p.text,
          reason: p.reason,
          ...(p.engramHint ? { engramHint: p.engramHint } : {}),
          ...(p.createEngramName ? { createEngramName: p.createEngramName } : {}),
          ...(p.obligation ? { obligation: p.obligation } : {}),
        },
        ts: p.ts ?? Date.now(),
      };
      appendToThread(msg);
    },
  );
}

function randBetweenMs(minMin: number, maxMin: number): number {
  return (minMin + Math.floor((maxMin - minMin + 1) * (Date.now() % 1000) / 1000)) * 60_000;
}

function dequeueProactiveCard(): void {
  if (proactiveCardQueue.length === 0) return;
  if (ghampusRunning) return;

  const now = Date.now();
  if (now - lastGhampusTypingAt < TYPING_SUPPRESS_MS) return;

  const idleSinceSend = now - lastGhampusSendAt;
  const requiredIdle = ghampusChatSessionActive ? IDLE_WHILE_CHAT_MS : IDLE_BEFORE_FIRST_MS;
  if (idleSinceSend < requiredIdle) return;
  if (nextCardAllowedAt > 0 && now < nextCardAllowedAt) return;

  const card = proactiveCardQueue.shift();
  if (!card) return;

  const pane = document.querySelector<HTMLElement>('.mode-pane[data-pane="ghampus"]');
  if (!pane || pane.classList.contains('hidden')) {
    proactiveCardQueue.unshift(card);
    return;
  }

  const gapMs = ghampusChatSessionActive
    ? CHAT_ACTIVE_CARD_GAP_MS
    : randBetweenMs(5, 30);
  nextCardAllowedAt = now + gapMs;

  if (isProactiveCardDismissed('proactive', card.id)) return;

  const msg: GhampusChatMessage = { kind: 'proactive-card', card, ts: card.createdAt };
  appendToThread(msg);
}

function startProactiveQueueTimer(): void {
  if (proactiveQueueTimer) return;
  proactiveQueueTimer = setInterval(dequeueProactiveCard, 30_000); // check every 30 s
}

/** Native notification when a reminder arrives and the Ghampus tab is not focused. */
async function maybeNotifyReminder(title: string, body: string): Promise<void> {
  const pane = document.querySelector<HTMLElement>('.mode-pane[data-pane="ghampus"]');
  const ghampusVisible = pane && !pane.classList.contains('hidden');
  if (ghampusVisible && document.hasFocus?.()) return;
  try {
    sendNotification({
      title: title || 'Ghampus reminder',
      body: body.split('\n').slice(0, 3).join(' ').slice(0, 180),
    });
  } catch { /* non-fatal */ }
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
      <td${presSkillAttr(plan.sourceId, plan.graphId ?? undefined)}>${escapeHtml(s.label)}</td>
      <td><div class="walk-plan-needs">${needChips}</div></td>
      <td><span class="walk-plan-model ${modelClass}"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(modelName)}</span>${modelTag}</td>
      <td>${costCell}</td>
    </tr>`;
  }).join('');

  const hint = plan.learningHint
    ? `<div class="walk-plan-hint"><span>💡</span><span${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(plan.learningHint)}</span></div>`
    : '';

  const confirmRouting = localOnly ? 'local-only' : 'adaptive';
  const confirmLabel = localOnly ? `Walk it locally · ${totalFmt}` : `Walk it · ${totalFmt}`;

  return `<div class="walk-plan-card" data-plan-source="${escapeHtml(plan.sourceId)}">
    <div class="walk-plan-header">
      <span class="walk-plan-title"${presSkillAttr(plan.sourceId, plan.graphId ?? undefined)}>${escapeHtml(plan.label)} walk plan</span>
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
      <span${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(s.label)}</span>
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
    <p class="refine-card-obs"${presSkillAttr(proposal.sourceId)}>${escapeHtml(proposal.observation)}</p>
    <pre class="refine-card-code"${presSkillAttr(proposal.sourceId)}>${escapeHtml(proposal.proposedStepCode)}</pre>
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
    <div class="tier-strip-col">${proLabel}<div class="tier-strip-body"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(ctx.pro)}</div></div>
    <div class="tier-strip-col">${freeLabel}<div class="tier-strip-body"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(ctx.free)}</div></div>
    <div class="tier-strip-col">${teamsLabel}<div class="tier-strip-body"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(ctx.teams)}</div></div>
  </div>`;
}

// In-memory thread cache — cleared on pane enter; rebuilt from history IPC.
// When the sidecar stub is not yet wired this stays empty and the empty state shows.
let ghampusThreadMessages: GhampusChatMessage[] = [];
let ghampusThreadPrefetchDone = false;
let ghampusThreadPrefetchInflight: Promise<void> | null = null;
/** null = untried; false = sidecar lacks ghampus:history:prefetch (version skew). */
let ghampusHistoryPrefetchSupported: boolean | null = null;

const GHAMPUS_THREAD_EMPTY_HTML = `<div id="ghampus-thread-empty" class="ghampus-thread-empty">
  <img src="/graphnosis-logo-transparent-bg.png" alt="" aria-hidden="true"
       class="ghampus-thread-empty-logo" width="40" height="40" />
  <p class="ghampus-thread-empty-copy">
    Start typing — or use <strong>New chat</strong> to archive this thread and begin fresh.
    Use Remember for anything worth keeping in memory.
  </p>
</div>`;

const GHAMPUS_THREAD_LOADING_HTML = `<div id="ghampus-thread-loading" class="ghampus-thread-empty ghampus-thread-loading">
  <img src="/graphnosis-logo-transparent-bg.png" alt="" aria-hidden="true"
       class="ghampus-thread-empty-logo" width="40" height="40" />
  <p class="ghampus-thread-empty-copy">Loading conversation…</p>
</div>`;

/** Ensure the centered message column exists (reconcile used to wipe #ghampus-thread). */
function ensureGhampusChatMessagesContainer(): HTMLElement | null {
  const thread = document.getElementById('ghampus-thread');
  if (!thread) return null;
  let container = document.getElementById('ghampus-chat-messages');
  if (!container) {
    container = document.createElement('div');
    container.id = 'ghampus-chat-messages';
    thread.appendChild(container);
    for (const orphan of Array.from(thread.querySelectorAll(':scope > .ghampus-thread-entry'))) {
      container.appendChild(orphan);
    }
  }
  return container;
}

function ghampusChatMessagesEl(): HTMLElement | null {
  return ensureGhampusChatMessagesContainer()
    ?? document.getElementById('ghampus-thread');
}

function showGhampusThreadLoading(): void {
  const container = ghampusChatMessagesEl();
  if (!container) return;
  if (document.getElementById('ghampus-thread-loading')) return;
  container.innerHTML = GHAMPUS_THREAD_LOADING_HTML;
}

function hideGhampusThreadLoading(): void {
  document.getElementById('ghampus-thread-loading')?.remove();
}

function paintGhampusHistoryMessages(messages: GhampusChatMessage[]): void {
  const container = ghampusChatMessagesEl();
  if (!container || messages.length === 0) return;
  ghampusThreadMessages = [];
  hideGhampusThreadLoading();
  document.getElementById('ghampus-thread-empty')?.remove();
  container.innerHTML = '';
  for (const msg of messages) {
    if (!shouldSkipGhampusThreadMessage(msg)) appendToThread(msg);
  }
  applyGhampusFragmentMarks();
  scrollGhampusThreadToBottomIfPinned({ instant: true });
  sweepGhampusPres(container);
}

/** Drop thread cache on lock / cortex switch — next unlock prefetches fresh history. */
export function resetGhampusThreadCache(): void {
  clearGhampusSendQueue();
  ghampusThreadMessages = [];
  ghampusThreadPrefetchDone = false;
  ghampusThreadPrefetchInflight = null;
  refreshGhampusThreadInflight = null;
  const container = ghampusChatMessagesEl();
  if (container && container.querySelector('.ghampus-thread-entry') == null) {
    container.innerHTML = GHAMPUS_THREAD_EMPTY_HTML;
  }
}

type GhampusNewChatChoice =
  | { action: 'cancel' }
  | { action: 'fresh' }
  | { action: 'remember'; summaryText: string; engramId: string };

type GhampusEngramOption = { graphId: string; displayName: string };

/** All non-archived engrams for Ghampus save-target pickers (matches header picker sort). */
async function loadGhampusEngramOptions(): Promise<GhampusEngramOption[]> {
  await app().reloadGraphsMetadata().catch(() => {});
  return app().getLoadedGraphs()
    .filter((g) => !g.metadata.archived)
    .sort((a, b) => {
      const aIsSkill = a.metadata.template === 'skill' ? 1 : 0;
      const bIsSkill = b.metadata.template === 'skill' ? 1 : 0;
      if (aIsSkill !== bIsSkill) return aIsSkill - bIsSkill;
      return (a.metadata.displayName ?? a.graphId).localeCompare(b.metadata.displayName ?? b.graphId);
    })
    .map((g) => ({
      graphId: g.graphId,
      displayName: app().formatEngramLabel(g),
    }));
}

function fillGhampusEngramSelect(
  select: HTMLSelectElement,
  options: GhampusEngramOption[],
  preferredId?: string,
): void {
  if (options.length === 0) {
    select.innerHTML = '<option value="personal">Personal</option>';
    select.value = 'personal';
    return;
  }
  select.innerHTML = options.map((e) =>
    `<option value="${escapeHtml(e.graphId)}">${escapeHtml(e.displayName)}</option>`,
  ).join('');
  const pick =
    (preferredId && options.some((e) => e.graphId === preferredId) ? preferredId : undefined)
    ?? options.find((e) => e.graphId === 'personal')?.graphId
    ?? options[0].graphId;
  select.value = pick;
}

let ghampusNewChatResolve: ((choice: GhampusNewChatChoice) => void) | null = null;
let ghampusNewChatModalReady = false;

function ghampusThreadHasSubstantiveTurns(): boolean {
  const turns = ghampusThreadMessages.filter(
    (m): m is Extract<GhampusChatMessage, { kind: 'user' | 'ghampus' }> =>
      m.kind === 'user' || m.kind === 'ghampus',
  );
  const userTurns = turns.filter((m) => m.kind === 'user' && m.text.trim().length >= 8);
  return userTurns.length >= 1 || turns.length >= 3;
}

function finishGhampusNewChatModal(choice: GhampusNewChatChoice): void {
  document.getElementById('ghampus-new-chat-modal')?.classList.add('hidden');
  if (ghampusNewChatResolve) {
    ghampusNewChatResolve(choice);
    ghampusNewChatResolve = null;
  }
}

function initGhampusNewChatModal(): void {
  if (ghampusNewChatModalReady) return;
  ghampusNewChatModalReady = true;
  const modal = document.getElementById('ghampus-new-chat-modal');
  const summaryEl = document.getElementById('ghampus-new-chat-summary') as HTMLTextAreaElement | null;
  const engramEl = document.getElementById('ghampus-new-chat-engram') as HTMLSelectElement | null;
  const rememberBtn = document.getElementById('ghampus-new-chat-remember') as HTMLButtonElement | null;
  const freshBtn = document.getElementById('ghampus-new-chat-fresh') as HTMLButtonElement | null;
  const skipBtn = document.getElementById('ghampus-new-chat-skip') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('ghampus-new-chat-cancel') as HTMLButtonElement | null;

  const startFreshWithoutSaving = () => finishGhampusNewChatModal({ action: 'fresh' });

  cancelBtn?.addEventListener('click', () => finishGhampusNewChatModal({ action: 'cancel' }));
  freshBtn?.addEventListener('click', startFreshWithoutSaving);
  skipBtn?.addEventListener('click', startFreshWithoutSaving);
  rememberBtn?.addEventListener('click', () => {
    const summaryText = summaryEl?.value.trim() ?? '';
    const engramId = engramEl?.value.trim() ?? '';
    if (!summaryText) {
      void gAlert('Summary required', 'Add a thread summary to save, or choose Skip & start fresh.');
      return;
    }
    if (!engramId) {
      void gAlert('Choose an engram', 'Pick which engram should receive this summary.');
      return;
    }
    finishGhampusNewChatModal({ action: 'remember', summaryText, engramId });
  });
  modal?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finishGhampusNewChatModal({ action: 'cancel' });
  });
}

async function populateGhampusNewChatModal(): Promise<void> {
  const summaryEl = document.getElementById('ghampus-new-chat-summary') as HTMLTextAreaElement | null;
  const engramEl = document.getElementById('ghampus-new-chat-engram') as HTMLSelectElement | null;
  const rememberBtn = document.getElementById('ghampus-new-chat-remember') as HTMLButtonElement | null;
  if (!summaryEl || !engramEl) return;

  summaryEl.value = '';
  summaryEl.placeholder = 'Summarizing thread…';
  summaryEl.disabled = true;
  if (rememberBtn) {
    rememberBtn.disabled = true;
    rememberBtn.textContent = 'Summarizing…';
  }
  const hint = document.getElementById('ghampus-new-chat-body');
  if (hint) {
    hint.textContent =
      'The current thread stays archived under ghampus/sessions/. Save a summary to memory, or skip and start fresh anytime — you do not need to wait for the summary.';
  }

  try {
    const [engramOptions, res] = await Promise.all([
      loadGhampusEngramOptions(),
      ipcCall<{
        summary: string;
        defaultEngramId: string;
        usedLlm?: boolean;
      }>('ghampus:session:summarize', {}),
    ]);
    fillGhampusEngramSelect(engramEl, engramOptions, res.defaultEngramId);
    summaryEl.value = res.summary ?? '';
    summaryEl.placeholder = 'Edit the summary before saving…';
    const hint = document.getElementById('ghampus-new-chat-body');
    if (hint && res.usedLlm) {
      hint.textContent =
        'Local LLM distilled this thread. Edit anything before saving — the archive still lands under ghampus/sessions/.';
    }
  } catch (err) {
    const engramOptions = await loadGhampusEngramOptions().catch(() => [] as GhampusEngramOption[]);
    if (engramOptions.length) fillGhampusEngramSelect(engramEl, engramOptions);
    summaryEl.placeholder = 'Could not summarize — type what to remember, or start fresh without saving.';
    summaryEl.value = '';
    const hint = document.getElementById('ghampus-new-chat-body');
    if (hint) {
      hint.textContent = `Summarize failed (${err instanceof Error ? err.message : String(err)}). You can still type a summary or start fresh.`;
    }
  } finally {
    summaryEl.disabled = false;
    if (rememberBtn) {
      rememberBtn.disabled = false;
      rememberBtn.textContent = 'Remember & start fresh';
    }
    summaryEl.focus();
  }
}

function promptGhampusNewChatModal(): Promise<GhampusNewChatChoice> {
  initGhampusNewChatModal();
  const modal = document.getElementById('ghampus-new-chat-modal');
  if (!modal) return Promise.resolve({ action: 'cancel' });
  modal.classList.remove('hidden');
  void populateGhampusNewChatModal();
  return new Promise<GhampusNewChatChoice>((resolve) => {
    ghampusNewChatResolve = resolve;
  });
}

async function clearGhampusSessionUi(): Promise<void> {
  resetGhampusThreadCache();
  clearGhampusFragmentComments();
  const thread = ghampusChatMessagesEl();
  if (thread) thread.innerHTML = GHAMPUS_THREAD_EMPTY_HTML;
}

/** Archive the on-disk session and reset the visible thread. */
export async function startFreshGhampusChat(): Promise<void> {
  if (ghampusRunning || ghampusSendQueue.length > 0) {
    const stopFirst = await gConfirm(
      'Ghampus is still working',
      'Cancel the in-flight turn and start a fresh chat?',
    );
    if (!stopFirst) return;
    clearGhampusSendQueue();
    await cancelGhampusTurn();
  }

  if (!ghampusThreadHasSubstantiveTurns()) {
    const confirmed = await gConfirm(
      'Start a fresh Ghampus chat?',
      'The current thread stays in your cortex under ghampus/sessions/ as an archive.',
    );
    if (!confirmed) return;
    await ipcCall('ghampus:session:clear', {});
    await clearGhampusSessionUi();
    return;
  }

  const choice = await promptGhampusNewChatModal();
  if (choice.action === 'cancel') return;

  if (choice.action === 'remember') {
    const res = await ipcCall<{ ok: boolean; remembered?: { engramId: string } }>(
      'ghampus:session:clear',
      {
        rememberSummary: true,
        engramId: choice.engramId,
        summaryText: choice.summaryText,
      },
    );
    if (!res.ok) {
      await gAlert('Could not start fresh', 'Session clear failed — try again.');
      return;
    }
    const engramLabel = app().engramName(choice.engramId);
    await gAlert(
      'Saved & archived',
      `Thread summary saved to ${engramLabel}. Ghampus started a fresh chat.`,
    );
  } else {
    await ipcCall('ghampus:session:clear', {});
  }
  await clearGhampusSessionUi();
}

/** Warm ghampus-history after unlock — non-blocking; paints DOM when data arrives. */
export function prefetchGhampusThread(): void {
  if (ghampusThreadPrefetchDone || ghampusThreadMessages.length > 0) return;
  if (ghampusThreadPrefetchInflight) return;
  ghampusThreadPrefetchInflight = prefetchGhampusThreadInner().finally(() => {
    ghampusThreadPrefetchInflight = null;
    ghampusThreadPrefetchDone = true;
    reconcileGhampusThreadDom();
    scrollGhampusThreadToBottomIfPinned({ instant: true });
  });
}

async function prefetchGhampusThreadInner(): Promise<void> {
  try {
    if (ghampusHistoryPrefetchSupported !== false) {
      try {
        await ipcCall('ghampus:history:prefetch', {});
        ghampusHistoryPrefetchSupported = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Unknown IPC method')) {
          ghampusHistoryPrefetchSupported = false;
        }
      }
    }
    const res = await ipcCall<{ messages: unknown[] }>('ghampus:history', {});
    const messages = dedupeAwayDigests(normalizeGhampusHistoryMessages(res.messages ?? []));
    if (messages.length > 0 && ghampusThreadMessages.length === 0) {
      paintGhampusHistoryMessages(messages);
    }
  } catch { /* non-fatal — refreshGhampusThread is the fallback */ }
}

function appendToThread(msg: GhampusChatMessage, opts?: { skipCache?: boolean }): void {
  if (shouldSkipGhampusThreadMessage(msg)) return;
  if (!opts?.skipCache) ghampusThreadMessages.push(msg);
  const container = ghampusChatMessagesEl();
  if (!container) return;
  const empty = document.getElementById('ghampus-thread-empty');
  if (empty) empty.remove();
  const node = document.createElement('div');
  node.className = 'ghampus-thread-entry';
  node.innerHTML = renderChatMessage(msg);
  container.appendChild(node);
  wireThreadNodeActions(node, msg);
  const wrap = node.querySelector<HTMLElement>('.chat-msg-wrap');
  if (wrap) wireTracePanel(wrap);
  node.querySelectorAll<HTMLTimeElement>('.chat-msg-time time').forEach(updateLiveTimeEl);
  scrollGhampusThreadToBottomIfPinned();
  sweepGhampusPres(node);
}

function wireThreadNodeActions(node: HTMLElement, msg: GhampusChatMessage): void {
  const chatMsg = node.querySelector<HTMLElement>('.chat-msg');
  if (chatMsg) {
    chatMsg.addEventListener('mouseenter', () => { chatMsg.classList.add('is-hover'); });
    chatMsg.addEventListener('mouseleave', () => {
      chatMsg.classList.remove('is-hover');
      chatMsg.querySelector<HTMLButtonElement>('.chat-msg-copy')?.blur();
    });
  }

  // Copy button — present on user + ghampus messages.
  node.querySelector<HTMLButtonElement>('.chat-msg-copy')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLButtonElement;
    const text = btn.dataset.copy ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      btn.classList.add('copied');
      btn.title = 'Copied!';
      btn.blur();
      setTimeout(() => { btn.classList.remove('copied'); btn.title = 'Copy'; }, 1500);
    });
  });

  // "Handled by {Agempus}" chip — descriptive routing chip; clicking deep-links
  // to the Agents roster. No re-dispatch action.
  node.querySelector<HTMLElement>('.ghampus-handled-by-chip')?.addEventListener('click', (e) => {
    e.stopPropagation();
    app().activateMode('agents');
  });

  if (msg.kind === 'skill-match') {
    node.querySelector<HTMLButtonElement>('.btn-skill-run')?.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const slug = (btn.dataset.skillLabel ?? '').trim().replace(/\s+/g, '-');
      if (slug) fillGhampusPrompt(`/preview ${slug}`);
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
  if (msg.kind === 'memory-suggestion') {
    wireMemorySuggestionCardActions(node, msg.suggestion);
  }
  if (msg.kind === 'tip') {
    wireFillPromptButtons(node);
    wireCardDismissButton(node);
  }
  if (msg.kind === 'vitality-nudge') {
    wireFillPromptButtons(node);
    node.querySelector<HTMLButtonElement>('.ghampus-vitality-preview')?.addEventListener('click', (e) => {
      const prompt = (e.currentTarget as HTMLButtonElement).dataset.prompt;
      if (prompt) fillGhampusPrompt(prompt);
    });
    wireCardDismissButton(node);
  }
  if (msg.kind === 'attention-nudge') {
    node.querySelector<HTMLButtonElement>('.ghampus-attention-review')?.addEventListener('click', () => {
      openMemoryIntegrityWorkbench('queue');
    });
    node.querySelector<HTMLButtonElement>('.ghampus-attention-corrections')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('graphnosis:open-corrections-deck'));
    });
    wireCardDismissButton(node, () => {
      document.dispatchEvent(new CustomEvent('graphnosis:attention-dismiss'));
    });
  }
  if (msg.kind === 'recovery-nudge') {
    node.querySelector<HTMLButtonElement>('.ghampus-recovery-open')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('graphnosis:open-recovery'));
    });
    wireCardDismissButton(node);
  }
  if (msg.kind === 'skill-preview-improve') {
    node.querySelector<HTMLButtonElement>('.ghampus-skill-improve-btn')?.addEventListener('click', () => {
      const slug = msg.card.skillSlug;
      fillGhampusPrompt(`Improve ${slug}: `);
    });
    node.querySelector<HTMLButtonElement>('.ghampus-skill-improve-dismiss')?.addEventListener('click', () => {
      node.closest('.ghampus-thread-entry')?.remove();
    });
  }
  if (msg.kind === 'insights-preview') {
    wireInsightsPreviewActions(node, msg.insights);
  }
  if (msg.kind === 'proactive-card') {
    if (msg.card.signalType === 'skill-stale') {
      wireSkillStaleCardActions(node, msg.card);
      return;
    }
    node.querySelector<HTMLButtonElement>('.proactive-card-preview')?.addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const skillSlug = btn.dataset.skillLabel ?? msg.card.skillLabel;
      fillGhampusPrompt(`/preview ${skillSlug}`);
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
      dismissProactiveCardInSession('proactive', cardId);
      await ipcCall('ghampus:inbox:dismiss', { id: cardId }).catch(() => {});
      btn.closest('.ghampus-thread-entry')?.remove();
    });
  }
}

function wireMemorySuggestionCardActions(node: HTMLElement, suggestion: MemorySuggestionCardPayload): void {
  const select = node.querySelector<HTMLSelectElement>('.ghampus-memory-suggestion-engram-select');
  if (select) {
    const defaultId = select.dataset.default ?? suggestion.engramHint ?? 'personal';
    void loadGhampusEngramOptions().then((options) => {
      fillGhampusEngramSelect(select, options, defaultId);
    }).catch(() => {
      fillGhampusEngramSelect(select, [{ graphId: defaultId, displayName: app().engramName(defaultId) }], defaultId);
    });
  }

  const removeCard = () => node.closest('.ghampus-thread-entry')?.remove();
  const fadeActions = (label: string) => {
    const actions = node.querySelector<HTMLElement>('.ghampus-memory-suggestion-actions');
    if (actions) actions.innerHTML = `<span style="font-size:12px;opacity:.55;">${escapeHtml(label)}</span>`;
  };

  node.querySelector<HTMLButtonElement>('.ghampus-memory-suggestion-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const card = btn.closest('.ghampus-memory-suggestion-card');
    const engramId = card?.querySelector<HTMLSelectElement>('.ghampus-memory-suggestion-engram-select')?.value
      ?? suggestion.engramHint
      ?? 'personal';
    btn.disabled = true;
    try {
      await ipcCall('agent:acceptMemorySuggestion', {
        id: suggestion.id,
        text: suggestion.text,
        engramId,
        kind: suggestion.kind,
        ...(suggestion.obligation ? { obligation: suggestion.obligation } : {}),
        ...(suggestion.createEngramName ? { createEngramName: suggestion.createEngramName } : {}),
      });
      fadeActions('Saved to memory');
      appendToThread({
        kind: 'ghampus',
        text: `Saved to **${engramId}**.`,
        ts: Date.now(),
      });
    } catch (err) {
      btn.disabled = false;
      fadeActions(`Couldn't save: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  node.querySelector<HTMLButtonElement>('.ghampus-memory-suggestion-later')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    fadeActions('Not now — ask again later if you share more');
    node.querySelector<HTMLElement>('.ghampus-memory-suggestion-card')?.classList.add('ghampus-memory-suggestion-card--muted');
  });

  node.querySelector<HTMLButtonElement>('.ghampus-memory-suggestion-dismiss')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    dismissProactiveCardInSession('memory-suggestion', suggestion.id);
    await ipcCall('agent:dismissMemorySuggestion', { id: suggestion.id }).catch(() => {});
    removeCard();
  });
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
    dismissProactiveCardInSession('proactive', card.id);
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
  resetGhampusThreadScrollPin();
  scrollGhampusThreadToBottomIfPinned();

  let phraseIdx = 0;
  _skillRunningTimer = setInterval(() => {
    const statusEl = document.getElementById('ghampus-skill-running-status');
    if (!statusEl) return;
    statusEl.classList.add('fade');
    setTimeout(() => {
      phraseIdx = (phraseIdx + 1) % SKILL_RUNNING_PHRASES.length;
      statusEl.textContent = SKILL_RUNNING_PHRASES[phraseIdx];
      statusEl.classList.remove('fade');
      scrollGhampusThreadToBottomIfPinned();
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
    : `<div class="notif-card-preview"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(n.label)}</div>`;
  return `<div class="notif-card" data-notif-id="${escapeHtml(n.id)}">
    <div class="notif-card-header">
      <span>${icon}</span>
      <span class="notif-card-origin"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(n.origin)}</span>
      <span class="notif-card-engram"${presEngramAttr(n.engramId)}>${escapeHtml(n.engramId)}</span>
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
    ensureGhampusChatMessagesContainer();
    applyGhampusChatZoom(readGhampusChatZoom());
    reconcileGhampusThreadDom();
    syncGhampusLlmSetupGuide(lastGhampusLlmStatus);
    scrollGhampusThreadToBottomIfPinned({ instant: true });
  });
  return refreshGhampusThreadInflight;
}

/** Paint any cached messages missing from the DOM (e.g. arrived while tab hidden). */
function reconcileGhampusThreadDom(): void {
  const container = ensureGhampusChatMessagesContainer();
  if (!container) return;
  const visibleMessages = ghampusThreadMessages.filter((m) => !shouldSkipGhampusThreadMessage(m));
  const domCount = container.querySelectorAll('.ghampus-thread-entry:not(#ghampus-thinking)').length;
  if (visibleMessages.length <= domCount) {
    if (ghampusRunning && !document.getElementById('ghampus-thinking')) showThinkingBubble();
    return;
  }
  container.innerHTML = '';
  for (const msg of visibleMessages) appendToThread(msg, { skipCache: true });
  applyGhampusFragmentMarks();
  if (ghampusRunning) showThinkingBubble();
}

async function refreshGhampusThreadInner(): Promise<void> {
  const thread = document.getElementById('ghampus-thread');
  if (!thread) return;

  // If we already have live messages from this session, leave the DOM alone.
  // Only the first load (or an explicit clear) should fetch history.
  const hasLiveMessages = ghampusThreadMessages.length > 0;
  if (hasLiveMessages) {
    scrollGhampusThreadToBottomIfPinned({ instant: true });
    return;
  }

  // Boot prefetch still running — show a subtle loading state, then reuse cache.
  if (ghampusThreadPrefetchInflight) {
    showGhampusThreadLoading();
    await ghampusThreadPrefetchInflight;
    hideGhampusThreadLoading();
    if (ghampusThreadMessages.length > 0) {
      scrollGhampusThreadToBottomIfPinned({ instant: true });
      return;
    }
  }

  // Try history first (sidecar cache should make this instant after prefetch).
  let messages: GhampusChatMessage[] = [];
  try {
    const res = await ipcCall<{ messages: unknown[] }>('ghampus:history', {});
    messages = dedupeAwayDigests(normalizeGhampusHistoryMessages(res.messages ?? []));
  } catch { /* not yet wired */ }

  if (messages.length > 0) {
    paintGhampusHistoryMessages(messages);
    return;
  }

  // Request sidecar away digest only when history is still empty (single-flight
  // above prevents parallel tab-refresh races from appending duplicates).
  try {
    await ipcCall<{ emitted?: boolean }>('ghampus:digest', {});
    const res2 = await ipcCall<{ messages: unknown[] }>('ghampus:history', {});
    const digestMessages = dedupeAwayDigests(normalizeGhampusHistoryMessages(res2.messages ?? []));
    if (digestMessages.length > 0) {
      paintGhampusHistoryMessages(digestMessages);
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
      // Truly nothing — show empty state inside the chat-messages container
      const container = ghampusChatMessagesEl();
      if (!container) return;
      container.innerHTML = `<div id="ghampus-thread-empty" class="ghampus-thread-empty">
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
      <p class="subtitle" style="margin: 0; font-size: 12px;"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(summaryText)}</p>
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
    sweepGhampusPres(thread);

    // Wire dismiss and switch buttons
    thread.querySelectorAll<HTMLButtonElement>('.btn-notif-switch').forEach((btn) => {
      btn.addEventListener('click', () => {
        const engramId = btn.dataset.engram ?? '';
        const nameEl = document.getElementById('ghampus-active-engram-name');
        const badge = document.getElementById('ghampus-active-engram');
        if (nameEl) {
          nameEl.textContent = engramId;
          nameEl.setAttribute('data-pres', `engram:${engramId}`);
        }
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

// ── Local LLM setup guide (in-thread, when Ghampus chat can't run) ─────────────

interface GhampusLlmStatus {
  ollamaReachable: boolean;
  installedModels: string[];
  activeModel: string | null;
  enabled?: boolean;
  catalog?: Array<{ model: string; label: string; recommended?: boolean }>;
}

let lastGhampusLlmStatus: GhampusLlmStatus | null = null;
let ghampusLlmStatusPollTimer: ReturnType<typeof setInterval> | null = null;

function isGhampusLlmReady(status: GhampusLlmStatus): boolean {
  return !!(status.ollamaReachable && status.installedModels.length > 0 && status.enabled);
}

/** Stop polling when the user leaves the Ghampus tab. */
export function stopGhampusLlmStatusPoll(): void {
  if (ghampusLlmStatusPollTimer !== null) {
    clearInterval(ghampusLlmStatusPollTimer);
    ghampusLlmStatusPollTimer = null;
  }
}

function startGhampusLlmStatusPoll(): void {
  if (ghampusLlmStatusPollTimer !== null) return;
  ghampusLlmStatusPollTimer = setInterval(() => { void refreshGhampusHeader(); }, 15_000);
}

function ghampusRecommendedPullTag(catalog?: Array<{ model: string; recommended?: boolean }>): string {
  const rec = catalog?.find((c) => c.recommended) ?? catalog?.[0];
  if (!rec) return 'llama3.2:3b';
  const short = rec.model.match(/^([^:]+:[^-]+)/);
  return short ? short[1] : rec.model;
}

/**
 * Detect the host OS from the renderer alone — fully local, no network and no
 * IPC round-trip. Used only to pick OS-appropriate Ollama install/start steps
 * so the proactive setup card never tells a Windows or Linux user to `brew`.
 */
function ghampusHostOS(): 'mac' | 'windows' | 'linux' | 'unknown' {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = (nav.userAgentData?.platform || nav.platform || nav.userAgent || '').toLowerCase();
  if (hint.includes('mac') || hint.includes('darwin')) return 'mac';
  if (hint.includes('win')) return 'windows';
  if (hint.includes('linux') || hint.includes('x11') || hint.includes('ubuntu') || hint.includes('fedora')) return 'linux';
  return 'unknown';
}

function ghampusHostOSLabel(os: ReturnType<typeof ghampusHostOS>): string {
  return os === 'mac' ? 'Mac' : os === 'windows' ? 'PC' : os === 'linux' ? 'Linux machine' : 'machine';
}

function ghampusLlmSetupIntro(status: GhampusLlmStatus): string {
  if (!status.ollamaReachable) {
    return `Ghampus chat needs Ollama running on your ${ghampusHostOSLabel(ghampusHostOS())}. `
      + 'Embeddings and recall work without it; synthesis does not.';
  }
  if (status.installedModels.length === 0) {
    return 'Ollama is connected — pull a recommended model, then enable the local LLM in Graphnosis.';
  }
  return 'Model installed — enable the local LLM master switch so Ghampus can synthesize answers.';
}

function ghampusLlmSetupSteps(status: GhampusLlmStatus, pullTag: string): string {
  const steps: string[] = [];
  if (!status.ollamaReachable) {
    const os = ghampusHostOS();
    const site = `<a href="#" id="btn-ghampus-llm-ollama-site">ollama.com</a>`;
    if (os === 'mac') {
      steps.push(
        `<li><strong>Install Ollama.</strong> Download from ${site} or run `
        + `<code class="ghampus-llm-setup-cmd">brew install ollama</code> in Terminal.</li>`,
        `<li><strong>Start Ollama.</strong> Open the Ollama app once (menu-bar icon), `
        + `or run <code class="ghampus-llm-setup-cmd">ollama serve</code> if you prefer Terminal.</li>`,
      );
    } else if (os === 'windows') {
      steps.push(
        `<li><strong>Install Ollama.</strong> Download the Windows installer from ${site} `
        + `(or run <code class="ghampus-llm-setup-cmd">winget install Ollama.Ollama</code>) and run it.</li>`,
        `<li><strong>Start Ollama.</strong> Launch Ollama from the Start menu — it runs in the system tray — `
        + `or run <code class="ghampus-llm-setup-cmd">ollama serve</code> in a terminal.</li>`,
      );
    } else if (os === 'linux') {
      steps.push(
        `<li><strong>Install Ollama.</strong> Run `
        + `<code class="ghampus-llm-setup-cmd">curl -fsSL https://ollama.com/install.sh | sh</code>, `
        + `or see ${site} for manual packages.</li>`,
        `<li><strong>Start Ollama.</strong> Run `
        + `<code class="ghampus-llm-setup-cmd">ollama serve</code> `
        + `(or <code class="ghampus-llm-setup-cmd">systemctl start ollama</code> if installed as a service).</li>`,
      );
    } else {
      steps.push(
        `<li><strong>Install Ollama.</strong> Download from ${site} — builds for macOS, Windows, and Linux.</li>`,
        `<li><strong>Start Ollama.</strong> Launch the Ollama app, or run `
        + `<code class="ghampus-llm-setup-cmd">ollama serve</code> in a terminal.</li>`,
      );
    }
  }
  if (!status.ollamaReachable || status.installedModels.length === 0) {
    steps.push(
      `<li><strong>Pull a model.</strong> In Terminal: `
      + `<code class="ghampus-llm-setup-cmd">ollama pull ${escapeHtml(pullTag)}</code> `
      + `(recommended — matches Graphnosis defaults).</li>`,
    );
  }
  if (!status.enabled) {
    steps.push(
      `<li><strong>Enable in Graphnosis.</strong> Open <strong>Foresight → Local LLM</strong>, `
      + `turn on the master switch, and pick your active model.</li>`,
    );
  }
  steps.push(
    `<li><strong>Verify loopback.</strong> Status should show a green connection on `
    + `<code class="ghampus-llm-setup-cmd">127.0.0.1:11434</code> — nothing leaves your machine.</li>`,
  );
  return steps.join('');
}

function buildGhampusLlmSetupGuideHtml(status: GhampusLlmStatus): string {
  const pullTag = ghampusRecommendedPullTag(status.catalog);
  const intro = ghampusLlmSetupIntro(status);
  const steps = ghampusLlmSetupSteps(status, pullTag);
  return `<div class="chat-msg ghampus ghampus-llm-setup-msg">
    <div class="chat-msg-avatar">
      <img src="/graphnosis-logo-transparent-bg.png" alt="Ghampus" />
    </div>
    <div class="chat-msg-wrap">
      <div class="ghampus-llm-setup-card">
        <div class="ghampus-tip-header">
          <span class="ghampus-tip-badge">Setup</span>
          <span class="ghampus-tip-category">Local LLM</span>
        </div>
        <p class="ghampus-tip-title">Set up a local LLM for Ghampus chat</p>
        <p class="ghampus-tip-body">${escapeHtml(intro)}</p>
        <ol class="ghampus-llm-setup-steps">${steps}</ol>
        <p class="ghampus-llm-setup-foot">
          Embeddings and recall work without a local LLM. Ghampus chat synthesis needs Ollama.
          <a href="#" id="btn-ghampus-llm-docs" class="ghampus-llm-setup-link">Full setup guide →</a>
        </p>
        <div class="ghampus-llm-setup-actions">
          <button type="button" class="g-btn primary" id="btn-ghampus-llm-open-setup">Open Local LLM setup →</button>
          <button type="button" class="g-btn" id="btn-ghampus-llm-recheck">Recheck connection</button>
        </div>
      </div>
    </div>
  </div>`;
}

function syncGhampusLlmSetupGuide(status: GhampusLlmStatus | null): void {
  if (!status) return;
  const container = document.getElementById('ghampus-chat-messages');
  if (!container) return;

  const ready = isGhampusLlmReady(status);
  const existing = document.getElementById('ghampus-llm-setup-guide');

  if (ready) {
    existing?.remove();
    stopGhampusLlmStatusPoll();
    return;
  }

  startGhampusLlmStatusPoll();
  const html = buildGhampusLlmSetupGuideHtml(status);
  if (existing) {
    existing.innerHTML = html;
  } else {
    const entry = document.createElement('div');
    entry.id = 'ghampus-llm-setup-guide';
    entry.className = 'ghampus-thread-entry ghampus-llm-setup-entry';
    entry.innerHTML = html;
    container.insertBefore(entry, container.firstChild);
  }
  document.getElementById('ghampus-thread-empty')?.remove();
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
  sweepGhampusPres(badge);
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
        enabled?: boolean;
        catalog?: Array<{ model: string; label: string; recommended?: boolean }>;
      }>('llm:status', {}),
    ]);
    ghampusCloudRoutingReady = catalogData.cloudRoutingReady === true;
    lastGhampusLlmStatus = llmStatus;
    paintGhampusModelSelect(llmStatus);
    syncGhampusLlmSetupGuide(llmStatus);

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

// ── Skill picker drawer (/preview · /train · /skills while typing) ─────────────

type SkillPickerMode = 'preview' | 'train' | 'skills';

type SkillPickerSkill = {
  sourceId: string;
  label: string;
  slug: string;
  displayLabel: string;
  vitality: number | null;
};

const SKILL_PICKER_MODE_CONFIG: Record<SkillPickerMode, {
  title: string;
  hint: string;
  placeholder: string;
  commandPrefix: string;
}> = {
  preview: {
    title: 'Preview a skill',
    hint: '',
    placeholder: 'Filter by name…',
    commandPrefix: '/preview',
  },
  train: {
    title: 'Train a skill',
    hint: '',
    placeholder: 'Filter by name…',
    commandPrefix: '/train',
  },
  skills: {
    title: 'Your skills',
    hint: 'Type to filter your trained skills by name. Pick one to list it in chat, or press Enter to list all matches.',
    placeholder: 'Filter by name…',
    commandPrefix: '/skills',
  },
};

function skillBaseName(label: string): string {
  return label.replace(/^skill:\d+:/, '').trim();
}

function skillHumanLabel(label: string): string {
  return skillBaseName(label).replace(/-/g, ' ');
}

function skillWalkSlug(label: string): string {
  return skillBaseName(label).replace(/\s+/g, '-');
}

function parseSkillPickerCommand(text: string): { mode: SkillPickerMode | null; filter: string } {
  const t = text.trimStart();
  let m = t.match(/^\/preview(?:\s+skill)?(?:\s+(.*))?$/is);
  if (m) return { mode: 'preview', filter: (m[1] ?? '').trimEnd() };
  m = t.match(/^\/walk(?:\s+skill)?(?:\s+(.*))?$/is);
  if (m) return { mode: 'preview', filter: (m[1] ?? '').trimEnd() };
  m = t.match(/^\/train(?:\s+(?:skill\s+)?(.*))?$/is);
  if (m) return { mode: 'train', filter: (m[1] ?? '').trimEnd() };
  m = t.match(/^\/skills(?:\s+(.*))?$/is);
  if (m) return { mode: 'skills', filter: (m[1] ?? '').trimEnd() };
  return { mode: null, filter: '' };
}

type SkillPickerHandle = {
  open: (mode: SkillPickerMode, initialFilter?: string, opts?: { focusFilter?: boolean }) => Promise<void>;
  syncFromInput: (mode: SkillPickerMode, filter: string) => void;
  ensureReady: () => Promise<void>;
  isOpen: () => boolean;
  close: () => void;
  findExactMatch: (filter: string) => SkillPickerSkill | undefined;
};

function skillPickerVitalityClass(v: number | null): string {
  if (v == null) return '';
  if (v >= 70) return 'v-high';
  if (v >= 40) return 'v-mid';
  return 'v-low';
}

function wireSkillPickerDrawer(submitText: (text: string) => Promise<void>): SkillPickerHandle {
  const backdrop = document.getElementById('ghampus-walk-picker');
  const titleEl = document.getElementById('ghampus-walk-picker-title');
  const hintEl = document.getElementById('ghampus-walk-picker-hint');
  const filterEl = document.getElementById('ghampus-walk-picker-filter') as HTMLInputElement | null;
  const listEl = document.getElementById('ghampus-walk-picker-list');
  const emptyEl = document.getElementById('ghampus-walk-picker-empty');
  const noop: SkillPickerHandle = {
    open: async () => {},
    syncFromInput: () => {},
    ensureReady: async () => {},
    isOpen: () => false,
    close: () => {},
    findExactMatch: () => undefined,
  };
  if (!backdrop || !filterEl || !listEl || !emptyEl) return noop;

  let allSkills: SkillPickerSkill[] = [];
  let filtered: SkillPickerSkill[] = [];
  let activeIdx = 0;
  let previousFocus: HTMLElement | null = null;
  let drawerOpen = false;
  let activeMode: SkillPickerMode = 'preview';
  let skillsLoaded = false;
  let loadPromise: Promise<void> | null = null;
  let syncDebounce: ReturnType<typeof setTimeout> | null = null;

  const applyModeChrome = (mode: SkillPickerMode): void => {
    activeMode = mode;
    const cfg = SKILL_PICKER_MODE_CONFIG[mode];
    if (titleEl) titleEl.textContent = cfg.title;
    if (hintEl) {
      hintEl.textContent = cfg.hint;
      hintEl.classList.toggle('hidden', !cfg.hint);
    }
    filterEl.placeholder = cfg.placeholder;
    listEl.setAttribute('aria-label', cfg.title);
  };

  const focusActiveItem = (): void => {
    listEl.querySelector<HTMLButtonElement>(`.ghampus-walk-picker-item[data-idx="${activeIdx}"]`)?.focus();
  };

  const close = (): void => {
    drawerOpen = false;
    backdrop.classList.add('hidden');
    filterEl.value = '';
    filterEl.classList.remove('is-synced');
    activeIdx = 0;
    if (syncDebounce) {
      clearTimeout(syncDebounce);
      syncDebounce = null;
    }
    if (previousFocus && document.contains(previousFocus)) {
      previousFocus.focus();
    }
    previousFocus = null;
  };

  const findExactMatch = (filter: string): SkillPickerSkill | undefined => {
    const q = filter.trim().toLowerCase();
    if (!q) return undefined;
    const slugQ = skillWalkSlug(q).toLowerCase();
    return allSkills.find((s) =>
      s.slug.toLowerCase() === q
      || s.slug.toLowerCase() === slugQ
      || s.displayLabel.toLowerCase() === q
      || s.label.toLowerCase() === q,
    );
  };

  const buildSubmitText = (skill?: SkillPickerSkill, filterOverride?: string): string => {
    const cfg = SKILL_PICKER_MODE_CONFIG[activeMode];
    if (activeMode === 'skills') {
      const f = (skill?.slug ?? filterOverride ?? filterEl.value.trim());
      return f ? `/skills ${f}` : '/skills';
    }
    if (skill) return `${cfg.commandPrefix} ${skill.slug}`;
    return cfg.commandPrefix;
  };

  const submitPickerChoice = async (skill?: SkillPickerSkill, filterOverride?: string): Promise<void> => {
    const text = buildSubmitText(skill, filterOverride);
    close();
    await submitText(text);
  };

  const pickSkill = async (skill: SkillPickerSkill | undefined): Promise<void> => {
    if (activeMode === 'skills') {
      if (skill) await submitPickerChoice(skill);
      else if (filterEl.value.trim()) await submitPickerChoice(undefined, filterEl.value.trim());
      return;
    }
    if (!skill) return;
    await submitPickerChoice(skill);
  };

  const renderList = (): void => {
    const q = filterEl.value.trim().toLowerCase();
    filtered = q
      ? allSkills.filter((s) =>
          s.displayLabel.toLowerCase().includes(q)
          || s.slug.toLowerCase().includes(q)
          || s.label.toLowerCase().includes(q),
        )
      : [...allSkills];
    if (activeIdx >= filtered.length) activeIdx = Math.max(0, filtered.length - 1);

    listEl.innerHTML = filtered.map((s, i) => {
      const vClass = skillPickerVitalityClass(s.vitality);
      const vBadge = s.vitality != null
        ? `<span class="ghampus-walk-picker-vitality ${vClass}">${s.vitality}</span>`
        : '';
      return `<li role="presentation">
        <button type="button" class="ghampus-walk-picker-item${i === activeIdx ? ' is-active' : ''}"
                data-idx="${i}" role="option" aria-selected="${i === activeIdx ? 'true' : 'false'}">
          <span class="ghampus-walk-picker-name"${presSkillAttr(s.sourceId)}>${escapeHtml(s.displayLabel)}</span>
          ${vBadge}
        </button>
      </li>`;
    }).join('');

    const noSkills = allSkills.length === 0;
    const noMatches = filtered.length === 0;
    emptyEl.textContent = noSkills
      ? 'No skills in your library yet. Train one in Skills.'
      : 'No skills match your filter.';
    emptyEl.classList.toggle('hidden', !noMatches);
    listEl.classList.toggle('hidden', noMatches && !noSkills);

    listEl.querySelectorAll<HTMLButtonElement>('.ghampus-walk-picker-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        void pickSkill(filtered[Number(btn.dataset['idx'])]);
      });
    });
    sweepGhampusPres(listEl);
  };

  const loadSkills = async (): Promise<void> => {
    if (skillsLoaded) return;
    try {
      const res = await ipcCall<{ skills: Array<{ sourceId: string; label: string; recallBreadth?: number }> }>(
        'agent:listSkills',
        {},
      );
      allSkills = (res.skills ?? []).map((s) => ({
        sourceId: s.sourceId,
        label: s.label,
        slug: skillWalkSlug(s.label),
        displayLabel: skillHumanLabel(s.label),
        vitality: s.recallBreadth ?? null,
      })).sort((a, b) => a.displayLabel.localeCompare(b.displayLabel));
    } catch {
      allSkills = [];
    }
    skillsLoaded = true;
  };

  const ensureReady = async (): Promise<void> => {
    if (skillsLoaded) return;
    if (!loadPromise) loadPromise = loadSkills();
    await loadPromise;
  };

  const showDrawerShell = (focusFilter: boolean): void => {
    if (!drawerOpen) {
      previousFocus = document.activeElement as HTMLElement | null;
      backdrop.classList.remove('hidden');
      drawerOpen = true;
      listEl.innerHTML = '';
      emptyEl.textContent = 'Loading skills…';
      emptyEl.classList.remove('hidden');
      listEl.classList.add('hidden');
    }
    if (focusFilter) filterEl.focus();
  };

  const applyFilter = (mode: SkillPickerMode, filter: string, focusFilter: boolean): void => {
    applyModeChrome(mode);
    filterEl.value = filter;
    filterEl.classList.toggle('is-synced', !focusFilter);
    activeIdx = 0;
    if (!skillsLoaded) {
      showDrawerShell(focusFilter);
      void ensureReady().then(() => {
        if (!drawerOpen) return;
        renderList();
        if (focusFilter) filterEl.focus();
      });
      return;
    }
    showDrawerShell(focusFilter);
    renderList();
    if (focusFilter) filterEl.focus();
  };

  const open = async (mode: SkillPickerMode, initialFilter = '', opts?: { focusFilter?: boolean }): Promise<void> => {
    applyFilter(mode, initialFilter, opts?.focusFilter ?? true);
    await ensureReady();
    if (!drawerOpen) return;
    renderList();
    if (opts?.focusFilter ?? true) filterEl.focus();
  };

  const syncFromInput = (mode: SkillPickerMode, filter: string): void => {
    if (syncDebounce) clearTimeout(syncDebounce);
    syncDebounce = setTimeout(() => {
      syncDebounce = null;
      applyFilter(mode, filter, false);
    }, 50);
  };

  filterEl.addEventListener('input', () => {
    filterEl.classList.remove('is-synced');
    activeIdx = 0;
    renderList();
  });

  filterEl.addEventListener('focus', () => {
    filterEl.classList.remove('is-synced');
  });

  filterEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!filtered.length) return;
      activeIdx = (activeIdx + 1) % filtered.length;
      renderList();
      focusActiveItem();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!filtered.length) return;
      activeIdx = (activeIdx - 1 + filtered.length) % filtered.length;
      renderList();
      focusActiveItem();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[activeIdx]) void pickSkill(filtered[activeIdx]);
      else if (activeMode === 'skills' && filterEl.value.trim()) void submitPickerChoice(undefined, filterEl.value.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  listEl.addEventListener('keydown', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.ghampus-walk-picker-item');
    if (!btn) return;
    const idx = Number(btn.dataset['idx']);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (idx + 1) % filtered.length;
      renderList();
      focusActiveItem();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (idx - 1 + filtered.length) % filtered.length;
      renderList();
      focusActiveItem();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void pickSkill(filtered[idx]);
    }
  });

  backdrop.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const panel = backdrop.querySelector<HTMLElement>('.ghampus-walk-picker');
    if (!panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  document.getElementById('btn-ghampus-walk-picker-close')?.addEventListener('click', close);

  return { open, syncFromInput, ensureReady, isOpen: () => drawerOpen, close, findExactMatch };
}

// ── Slash command definitions ─────────────────────────────────────────────────
const SLASH_COMMANDS = [
  { name: 'save',    icon: '', args: '[content] [@engram]', desc: 'Save a memory',         template: '/save '         },
  { name: 'recall',  icon: '', args: '[query]',             desc: 'Search your memory',    template: '/recall '       },
  { name: 'edit',    icon: '', args: '[correction]',        desc: 'Correct existing memory', template: '/edit '       },
  { name: 'compare', icon: '', args: '[topic]',             desc: 'Compare sources (Pro)', template: '/compare '      },
  { name: 'create',  icon: '', args: '[engram name]',       desc: 'Create a new engram',   template: '/create '       },
  { name: 'engrams', icon: '', args: '',                    desc: 'List your engrams',     template: '/engrams'       },
  { name: 'skills',  icon: '', args: '[filter]',            desc: 'List your skills',      template: '/skills'        },
  { name: 'preview', icon: '', args: '[skill name]',        desc: 'Preview a skill SOP',   template: '/preview '      },
  { name: 'train',   icon: '', args: '[skill name]',        desc: 'Retrain a skill (Pro)', template: '/train '        },
  { name: 'forget',  icon: '', args: '[topic]',             desc: 'Find memories to remove', template: '/forget '     },
  { name: 'insights', icon: '', args: '',                   desc: 'Preview Foresight insights', template: '/insights' },
  { name: 'help',    icon: '', args: '',                    desc: 'Show all commands',     template: '/help'          },
] as const;

function getLastGhampusThreadSnippet(): string {
  for (let i = ghampusThreadMessages.length - 1; i >= 0; i--) {
    const m = ghampusThreadMessages[i];
    if (m?.kind === 'ghampus' && m.text.trim()) {
      return m.text.replace(/[#*`[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function getGhampusThreadTurnCount(): number {
  return ghampusThreadMessages.filter((m) => m.kind === 'user' || m.kind === 'ghampus').length;
}

function getGhampusSelectionText(): string {
  if (ghampusPendingFragmentSelection?.quotedText) {
    return ghampusPendingFragmentSelection.quotedText;
  }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount < 1) return '';
  const thread = document.getElementById('ghampus-thread');
  if (!thread?.contains(sel.getRangeAt(0).commonAncestorContainer)) return '';
  const text = sel.toString().trim();
  return text.length >= 2 ? text : '';
}

const GHAMPUS_CHAT_ZOOM_KEY = 'graphnosis:ghampusChatZoom';
const GHAMPUS_CHAT_ZOOM_MIN = 0.85;
const GHAMPUS_CHAT_ZOOM_MAX = 1.6;
const GHAMPUS_CHAT_ZOOM_STEP = 0.1;
let ghampusChatZoomWired = false;

function isGhampusPaneActive(): boolean {
  const pane = document.querySelector<HTMLElement>('[data-pane="ghampus"]');
  return !!pane && !pane.classList.contains('hidden');
}

function readGhampusChatZoom(): number {
  try {
    const stored = Number(localStorage.getItem(GHAMPUS_CHAT_ZOOM_KEY));
    if (Number.isFinite(stored) && stored >= GHAMPUS_CHAT_ZOOM_MIN && stored <= GHAMPUS_CHAT_ZOOM_MAX) {
      return Math.round(stored * 100) / 100;
    }
  } catch { /* ignore */ }
  return 1;
}

function applyGhampusChatZoom(zoom: number): void {
  const clamped = Math.min(
    GHAMPUS_CHAT_ZOOM_MAX,
    Math.max(GHAMPUS_CHAT_ZOOM_MIN, Math.round(zoom * 100) / 100),
  );
  try { localStorage.setItem(GHAMPUS_CHAT_ZOOM_KEY, String(clamped)); } catch { /* ignore */ }
  const wrap = document.getElementById('ghampus-chat-wrap');
  if (!wrap) return;
  wrap.style.setProperty('--ghampus-chat-zoom', String(clamped));
  const avatarBase = window.matchMedia('(max-width: 768px)').matches ? 36 : 40;
  const gapBase = window.matchMedia('(max-width: 768px)').matches ? 8 : 10;
  wrap.style.setProperty('--ghampus-chat-avatar-size', `${Math.round(avatarBase * clamped)}px`);
  wrap.style.setProperty('--ghampus-chat-avatar-gap', `${Math.round(gapBase * clamped)}px`);
}

function handleGhampusZoomKeydown(e: KeyboardEvent): boolean {
  if (!isGhampusPaneActive()) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return false;

  if (e.key === '0' && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    applyGhampusChatZoom(1);
    return true;
  }

  const zoomIn = e.key === '=' || e.key === '+'
    || e.code === 'Equal' || e.code === 'NumpadAdd';
  const zoomOut = e.key === '-' || e.key === '_'
    || e.code === 'Minus' || e.code === 'NumpadSubtract';

  if (zoomIn) {
    e.preventDefault();
    applyGhampusChatZoom(readGhampusChatZoom() + GHAMPUS_CHAT_ZOOM_STEP);
    return true;
  }
  if (zoomOut) {
    e.preventDefault();
    applyGhampusChatZoom(readGhampusChatZoom() - GHAMPUS_CHAT_ZOOM_STEP);
    return true;
  }
  return false;
}

function wireGhampusChatZoomShortcuts(): void {
  applyGhampusChatZoom(readGhampusChatZoom());
  if (ghampusChatZoomWired) return;
  ghampusChatZoomWired = true;
  document.addEventListener('keydown', (e) => {
    handleGhampusZoomKeydown(e);
  }, true);
}

function wireGhampusChat(): void {
  const input = document.getElementById('ghampus-input') as HTMLTextAreaElement | null;
  const sendBtn = document.getElementById('btn-ghampus-send');
  if (!input || !sendBtn) return;

  wireGhampusChatZoomShortcuts();

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
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    // Execute no-arg commands immediately
    if (!cmd.args) void sendMessage();
  }

  function hidePalette(): void {
    if (palette) palette.style.display = 'none';
    paletteVisible = false;
    paletteActive = 0;
  }

  const composeRail = wireGhampusComposeRail(input, {
    getSelectedText: getGhampusSelectionText,
    getLastGhampusSnippet: getLastGhampusThreadSnippet,
    getThreadTurnCount: getGhampusThreadTurnCount,
    getHoursSinceActive: () => (Date.now() - lastGhampusSendAt) / 3_600_000,
    shouldHide: () => paletteVisible && !input!.value.trimStart().startsWith('/'),
    onInputChange: () => {
      autoGrow();
      composeRail.update();
    },
    onFillPrompt: fillGhampusPrompt,
    onThreadSummary: () => { void startFreshGhampusChat(); },
  });

  function updatePalette(): void {
    const val = input!.value;
    if (parseSkillPickerCommand(val).mode) { hidePalette(); return; }
    if (!val.startsWith('/')) { hidePalette(); return; }
    const filter = val.slice(1).split(/\s/)[0].toLowerCase();
    // Only show palette while user is still typing the command word (no space yet after it)
    if (val.includes(' ') && !val.match(/^\/\w+$/)) { hidePalette(); return; }
    paletteActive = 0;
    buildPalette(filter);
    composeRail.update();
  }

  // ── Auto-grow textarea ─────────────────────────────────────────────────────
  function autoGrow(): void {
    input!.style.height = 'auto';
    input!.style.height = `${Math.min(input!.scrollHeight, 140)}px`;
  }

  function handleSkillPickerInputSync(): void {
    const parsed = parseSkillPickerCommand(input!.value);
    if (parsed.mode) {
      hidePalette();
      skillPicker.syncFromInput(parsed.mode, parsed.filter);
    } else if (skillPicker.isOpen()) {
      skillPicker.close();
    }
  }

  input.addEventListener('input', () => {
    autoGrow();
    handleSkillPickerInputSync();
    updatePalette();
    composeRail.update();
  });

  function submitGhampusText(text: string): void {
    const ts = Date.now();
    const turnId = newGhampusTurnId();
    enqueueGhampusSend({ turnId, ts, userText: text, ipcPayload: { text, turnId } });
  }

  const skillPicker = wireSkillPickerDrawer(submitGhampusText);

  async function sendMessage(): Promise<void> {
    const text = input!.value.trim();
    if (!text) return;
    hidePalette();
    composeRail.hide();
    const parsed = parseSkillPickerCommand(text);
    if (parsed.mode) {
      const cfg = SKILL_PICKER_MODE_CONFIG[parsed.mode];
      if (!parsed.filter) {
        input!.value = '';
        input!.style.height = 'auto';
        skillPicker.close();
        void skillPicker.open(parsed.mode, '', { focusFilter: true });
        return;
      }
      if (parsed.mode === 'skills') {
        input!.value = '';
        input!.style.height = 'auto';
        skillPicker.close();
        await submitGhampusText(`${cfg.commandPrefix} ${parsed.filter}`);
        return;
      }
      await skillPicker.ensureReady();
      const exact = skillPicker.findExactMatch(parsed.filter);
      if (exact) {
        input!.value = '';
        input!.style.height = 'auto';
        skillPicker.close();
        await submitGhampusText(`${cfg.commandPrefix} ${exact.slug}`);
        return;
      }
      skillPicker.syncFromInput(parsed.mode, parsed.filter);
      return;
    }
    if (skillPicker.isOpen()) skillPicker.close();
    input!.value = '';
    input!.style.height = 'auto';
    await submitGhampusText(text);
  }

  input.addEventListener('keydown', (e) => {
    trackGhampusTyping();
    if (e.key === 'Escape' && skillPicker.isOpen()) {
      e.preventDefault();
      skillPicker.close();
      return;
    }
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

  // Hide slash palette on outside click
  document.addEventListener('mousedown', (e) => {
    if (palette && !palette.contains(e.target as Node) && e.target !== input) {
      hidePalette();
    }
  });

  sendBtn.addEventListener('click', () => {
    trackGhampusSendActivity();
    void sendMessage();
  });

  document.getElementById('btn-ghampus-cancel')?.addEventListener('click', () => {
    void cancelGhampusTurn();
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
  document.getElementById('ghampus-skills-list')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.ghampus-skill-run');
    if (!btn) return;
    const slug = (btn.dataset.skillLabel ?? '').trim().replace(/\s+/g, '-');
    if (slug) fillGhampusPrompt(`/preview ${slug}`);
  });

  document.getElementById('ghampus-chat-messages')?.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('#btn-ghampus-llm-open-setup')) {
      e.preventDefault();
      app.activateMode('goals');
      setTimeout(() => {
        document.getElementById('fcard-llm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
      return;
    }
    if (t.closest('#btn-ghampus-llm-recheck')) {
      e.preventDefault();
      void refreshGhampusHeader();
      return;
    }
    if (t.closest('#btn-ghampus-llm-ollama-site')) {
      e.preventDefault();
      void invoke('open_external_url', { url: 'https://ollama.com/download' });
      return;
    }
    if (t.closest('#btn-ghampus-llm-docs')) {
      e.preventDefault();
      void invoke('plugin:opener|open_url', { url: 'https://docs.graphnosis.com/local-ai' })
        .catch(() => invoke('open_external_url', { url: 'https://docs.graphnosis.com/local-ai' }));
    }
  });

  document.getElementById('btn-ghampus-new-chat')?.addEventListener('click', () => {
    void startFreshGhampusChat();
  });

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

