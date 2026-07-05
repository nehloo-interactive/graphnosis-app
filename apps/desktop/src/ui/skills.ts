/**
 * Skills — MemoryStudio trainer, library, .gsk import, vitality, retrain.
 * Extracted from main.ts (ui-modularize Batch 5).
 */
import { invoke } from '../platform';
import { app } from './app-context';
import { gAlert, gConfirm } from './dialogs';
import { ipcCall, ipcCallTimeout, invokeRetry } from './ipc';
import { escape, escapeHtml } from './util';
import type { GraphWithMetadata } from './types';
import {
  AGEMPUS_LEVELS,
  currentAgempusLevel,
  renderAgempusDial,
  vitalityGrade,
  levelRankUi,
  perSkillReadout,
  fetchDispatchReadout,
  skillsDispatchReadoutCache,
  type AutonomyLevel,
  type DispatchSafety,
  type PerSkillDispatchSafe,
  type DispatchSafeReadout,
} from './skills-shared';

type StudioTool = 'skills' | 'recall' | 'dig-deeper' | 'remember' | 'edit' | 'gnn';
type Mode = string;

function getLoadedGraphs(): GraphWithMetadata[] {
  return app().getLoadedGraphs();
}

interface SkillProvenance {
  kind: 'official' | 'community';
  verified: boolean;
  author: string;
  packId?: string;
  packVersion?: string;
  importedAt?: string;
}

interface SkillListEntry {
  sourceId: string;
  graphId: string;
  engramName: string;
  label: string;
  ingestedAt: number;
  nodeCount: number;
  trainedAt?: string;
  mode?: string;
  recallBreadth?: number;
  /** Present only for skills imported from a .gsk pack (author/sig metadata
   *  parsed from the imported-provenance node). Locally-trained skills:
   *  undefined → renderer omits the author badge. */
  provenance?: SkillProvenance;
}

interface SkillDetail extends SkillListEntry {
  text: string;
}

interface SkillInfluentialNode {
  nodeId: string;
  graphId: string;
  score: number;
  preview: string;
  sourceLabel?: string;
  layer?: 'anchored' | 'gnn-expanded' | 'semantic';
  goalAlignment?: 'success' | 'scope' | 'completion';
}

interface SkillTrainResult {
  original: string;
  trained: string;
  diffNotes?: string;
  influentialNodes: SkillInfluentialNode[];
  mode: 'llm' | 'memory-augmented';
  skillId?: string;
  degradedNote?: string;
  // Upgrade gate
  upgrade_required?: boolean;
  upgrade_url?: string;
  message?: string;
}

interface SkillVitality {
  score: number;
  trainedAt?: number;
  staleNodesCount: number;
  recommendation: string;
}

const SKILLS_HIDDEN_KEY = 'skill:hidden';
const SKILLS_LAST_EXPORT_KEY_PREFIX = 'skill:lastExport:';
const SKILLS_VITALITY_TTL_MS = 5 * 60 * 1000;
const SKILLS_VITALITY_AUTO_CAP = 10;
// Crash-survival storage. SKILLS_DRAFT_KEY holds the in-progress compose
// form (text/name/model/etc.); SKILLS_LIBRARY_SNAPSHOT_KEY holds the
// sourceId set we saw on last Skills mount so we can detect new arrivals
// across app sessions (skills the sidecar finished training while the
// desktop wasn't running).
const SKILLS_DRAFT_KEY = 'skill:draft:v1';
const SKILLS_LIBRARY_SNAPSHOT_KEY = 'skill:librarySnapshot:v1';
const SKILLS_DRAFT_AUTOSAVE_DEBOUNCE_MS = 500;

interface SkillsDraft {
  text: string;
  name?: string;
  modelTarget?: string;
  recallBreadth?: number;
  targetEngramId?: string;
  savedAt: number;
}

const skillsHiddenSet: Set<string> = new Set(
  ((): string[] => {
    try {
      const raw = localStorage.getItem(SKILLS_HIDDEN_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  })(),
);

function persistSkillsHidden(): void {
  localStorage.setItem(SKILLS_HIDDEN_KEY, JSON.stringify([...skillsHiddenSet]));
}

// ── Skill draft auto-save ───────────────────────────────────────────────────
//
// Debounced 500ms — every keystroke restarts a timer; the actual write
// happens once the user pauses. This keeps localStorage I/O off the
// critical path while still giving us crash-survival (the worst case is
// losing the last 500ms of typing, which never feels bad).
let skillsDraftSaveTimer: ReturnType<typeof setTimeout> | null = null;

function readSkillsDraft(): SkillsDraft | null {
  try {
    const raw = localStorage.getItem(SKILLS_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SkillsDraft;
    if (typeof parsed?.text !== 'string') return null;
    return parsed;
  } catch { return null; }
}

/** Live chunk preview — debounced; runs after the user pauses typing. */
let skillsChunkPreviewTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSkillsChunkPreview(): void {
  if (skillsChunkPreviewTimer) clearTimeout(skillsChunkPreviewTimer);
  skillsChunkPreviewTimer = setTimeout(() => {
    renderSkillsChunkPreview();
  }, 200);
}

/** Render the live chunk-preview panel under the skill-text textarea.
 *  Same splitting rule the trainer uses on save — `split(/\n{2,}/)` then
 *  trim+filter — so the preview is a faithful preview of node placement. */
function renderSkillsChunkPreview(): void {
  const ta = document.getElementById('skills-input-text') as HTMLTextAreaElement | null;
  const panel = document.getElementById('skills-chunk-preview');
  const countEl = document.getElementById('skills-chunk-preview-count');
  const listEl = document.getElementById('skills-chunk-preview-list');
  const moreEl = document.getElementById('skills-chunk-preview-more');
  if (!ta || !panel || !countEl || !listEl || !moreEl) return;

  const text = ta.value.trim();
  if (!text) {
    panel.classList.add('hidden');
    return;
  }
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) {
    panel.classList.add('hidden');
    return;
  }

  countEl.textContent = paragraphs.length === 1
    ? '1 paragraph node will be created on save'
    : `${paragraphs.length} paragraph nodes will be created on save`;

  // Show the first 3 paragraph previews, each truncated to ~120 chars
  const SHOW = 3, MAX_LEN = 120;
  const truncate = (s: string): string =>
    s.length <= MAX_LEN ? s : s.slice(0, MAX_LEN - 1) + '…';
  listEl.innerHTML = paragraphs.slice(0, SHOW)
    .map((p) => `<li>${escape(truncate(p.replace(/\s+/g, ' ')))}</li>`)
    .join('');
  moreEl.textContent = paragraphs.length > SHOW
    ? `…and ${paragraphs.length - SHOW} more`
    : '';
  panel.classList.remove('hidden');
}

function scheduleSkillsDraftSave(): void {
  if (skillsDraftSaveTimer) clearTimeout(skillsDraftSaveTimer);
  skillsDraftSaveTimer = setTimeout(() => {
    const text = (document.getElementById('skills-input-text') as HTMLTextAreaElement | null)?.value ?? '';
    // Don't persist an empty draft — clearing the textarea should also
    // clear the saved blob so the restore banner doesn't pop next time
    // for an empty draft.
    if (text.trim().length === 0) {
      localStorage.removeItem(SKILLS_DRAFT_KEY);
      return;
    }
    const name = (document.getElementById('skills-input-name') as HTMLInputElement | null)?.value ?? '';
    const modelTarget = (document.getElementById('skills-input-model') as HTMLSelectElement | null)?.value ?? '';
    const targetEngramId = (document.getElementById('skills-input-engram') as HTMLSelectElement | null)?.value ?? '';
    const breadthStr = (document.getElementById('skills-input-breadth') as HTMLInputElement | null)?.value ?? '';
    const breadth = Number.parseInt(breadthStr, 10);
    const draft: SkillsDraft = {
      text,
      savedAt: Date.now(),
      ...(name ? { name } : {}),
      ...(modelTarget ? { modelTarget } : {}),
      ...(targetEngramId ? { targetEngramId } : {}),
      ...(Number.isFinite(breadth) ? { recallBreadth: breadth } : {}),
    };
    try {
      localStorage.setItem(SKILLS_DRAFT_KEY, JSON.stringify(draft));
    } catch { /* quota or storage error — non-fatal */ }
  }, SKILLS_DRAFT_AUTOSAVE_DEBOUNCE_MS);
}

function clearSkillsDraft(): void {
  if (skillsDraftSaveTimer) { clearTimeout(skillsDraftSaveTimer); skillsDraftSaveTimer = null; }
  localStorage.removeItem(SKILLS_DRAFT_KEY);
  hideSkillsDraftRestorePrompt();
}

function showSkillsDraftRestorePrompt(): void {
  const draft = readSkillsDraft();
  const banner = document.getElementById('skills-draft-restore');
  const whenEl = document.getElementById('skills-draft-restore-when');
  if (!banner || !whenEl || !draft) {
    banner?.classList.add('hidden');
    return;
  }
  const ta = document.getElementById('skills-input-text') as HTMLTextAreaElement | null;
  // Only nag when the textarea is empty — if the user is mid-flow on a
  // different skill we don't want to interrupt them with a recovery
  // prompt for an older draft.
  if (ta && ta.value.trim().length > 0) {
    banner.classList.add('hidden');
    return;
  }
  const ageMs = Date.now() - draft.savedAt;
  let whenLabel: string;
  if (ageMs < 60_000) whenLabel = 'less than a minute ago';
  else if (ageMs < 3_600_000) whenLabel = `${Math.round(ageMs / 60_000)} minute(s) ago`;
  else if (ageMs < 86_400_000) whenLabel = `${Math.round(ageMs / 3_600_000)} hour(s) ago`;
  else whenLabel = new Date(draft.savedAt).toLocaleString();
  whenEl.textContent = whenLabel;
  banner.classList.remove('hidden');
}

function hideSkillsDraftRestorePrompt(): void {
  document.getElementById('skills-draft-restore')?.classList.add('hidden');
}

function applySkillsDraft(draft: SkillsDraft): void {
  const ta = document.getElementById('skills-input-text') as HTMLTextAreaElement | null;
  const nameEl = document.getElementById('skills-input-name') as HTMLInputElement | null;
  const modelEl = document.getElementById('skills-input-model') as HTMLSelectElement | null;
  const engramEl = document.getElementById('skills-input-engram') as HTMLSelectElement | null;
  const breadthEl = document.getElementById('skills-input-breadth') as HTMLInputElement | null;
  const breadthLive = document.getElementById('skills-input-breadth-live');
  if (ta) {
    ta.value = draft.text;
    // Trigger the overflow-check so the expand button reappears for long drafts.
    ta.dispatchEvent(new Event('input'));
  }
  if (nameEl && draft.name) nameEl.value = draft.name;
  if (modelEl && draft.modelTarget) modelEl.value = draft.modelTarget;
  if (engramEl && draft.targetEngramId) {
    // Only set if that engram still exists in the picker — engrams may
    // have been archived/deleted since the draft was saved.
    const exists = Array.from(engramEl.options).some((o) => o.value === draft.targetEngramId);
    if (exists) engramEl.value = draft.targetEngramId;
  }
  syncSkillsPreviewWarning();
  if (breadthEl && typeof draft.recallBreadth === 'number') {
    breadthEl.value = String(draft.recallBreadth);
    if (breadthLive) breadthLive.textContent = String(draft.recallBreadth);
  }
  hideSkillsDraftRestorePrompt();
}

// ── Cross-session new-skill detection ───────────────────────────────────────
//
// On every Skills mount, snapshot the current sourceId set. On the *next*
// mount (likely a new app session), compare against the snapshot — any
// new entries are skills the sidecar finished while the desktop wasn't
// running (e.g. autonomous retrain ran during a crash, scheduled retrain
// fired after the user closed the app, etc.).

function readSkillsLibrarySnapshot(): Set<string> {
  try {
    const raw = localStorage.getItem(SKILLS_LIBRARY_SNAPSHOT_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch { return new Set(); }
}

function writeSkillsLibrarySnapshot(): void {
  try {
    const ids = skillsLibrary.map((s) => s.sourceId);
    localStorage.setItem(SKILLS_LIBRARY_SNAPSHOT_KEY, JSON.stringify(ids));
  } catch { /* non-fatal */ }
}

function diffSkillsLibraryAgainstSnapshot(): SkillListEntry[] {
  const previous = readSkillsLibrarySnapshot();
  if (previous.size === 0) {
    // First-ever mount on this device — nothing to diff against. Write
    // the baseline and return empty so we don't false-positive every
    // existing skill as "new".
    return [];
  }
  return skillsLibrary.filter((s) => !previous.has(s.sourceId));
}

function rememberSkillExportFormat(sourceId: string | undefined, format: string): void {
  if (!sourceId) return;
  localStorage.setItem(SKILLS_LAST_EXPORT_KEY_PREFIX + sourceId, format);
}

function recallSkillExportFormat(sourceId: string | undefined): string {
  if (!sourceId) return 'claude-md';
  return localStorage.getItem(SKILLS_LAST_EXPORT_KEY_PREFIX + sourceId) ?? 'claude-md';
}

// Vitality cache: sourceId → { value, fetchedAt }
const skillsVitalityCache = new Map<string, { value: SkillVitality; fetchedAt: number }>();

// Library + trainer state
export let skillsLibrary: SkillListEntry[] = [];
let skillsLibrarySort: 'recent' | 'vitality' | 'name' = 'recent';
let skillsShowHidden = false;
// Skills-library filters (item: filter box + engram dropdown). Display-only —
// they never touch the underlying skill data, just what the library renders.
let skillsFilterText = '';
let skillsFilterEngram = 'all'; // 'all' or a graphId
let skillsActiveSourceId: string | null = null;
// The result currently in review mode (either a fresh training run, or an
// opened library row hydrated via skill:get).
let skillsActiveResult: {
  trained: string;
  diffNotes?: string;
  influentialNodes: SkillInfluentialNode[];
  mode?: string;
  skillId?: string;
  graphId?: string;
  /** Baseline text used by the "Changes" diff view. In preview mode this
   *  is the user's original input; when browsing a saved skill from the
   *  library it's the previous version (fetched via skill:getHistory). */
  baselineText?: string;
  /** Human label describing the baseline — e.g. "your input" or
   *  "previous version (May 28)". Shown above the diff. */
  baselineLabel?: string;
} | null = null;

// Tracks whether the user is currently viewing the trained output or
// the diff. Persisted in-memory for the session; flips on toggle clicks.
let skillsOutputView: 'output' | 'diff' = 'output';
// Set while a skill-card DOM drag is in progress — prevents the Tauri
// file-drop overlay from showing when the user reorders Trained Output blocks.
let isSkillCardDragging = false;
// Bumped on every paintSkillsReview — stale paintTrainedOutputSourceDriven
// completions (slow listNodes, double open after train) must not overwrite
// the panel once a newer skill is selected.
let skillsTrainedOutputGen = 0;

// Identifies goal/constraint nodes by text prefix. Kept in sync with the
// sidecar's GOAL_NODE_RE in skill-trainer.ts.
const SKILL_GOAL_CARD_RE = /^(?:Success:|Out of scope:|On completion:|Trigger:|Prerequisites:|On failure:|Requires:|Produces:)/i;

function formatRelativeTime(ms: number | undefined): string {
  if (!ms) return '—';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  const days = Math.floor(delta / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function parseTrainedAt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

/** Pick the engram a new skill should be saved into — strictly Skills-template
 *  engrams. Train-time recall is empty (source-only); the focus-engram picker
 *  is hidden in the UI. Saving to a non-skill engram would scatter trained
 *  skills across unrelated cortex areas.
 *  Returns null when no Skills engram exists — caller renders the "No
 *  Skills engram yet" placeholder and surfaces the create button. */
function pickDefaultSkillsTargetGraph(): { graphId: string } | null {
  const visible = getLoadedGraphs()
    .filter((g) => !g.metadata.archived && g.loaded !== false && g.metadata.template === 'skill')
    .sort((a, b) => (a.metadata.displayName ?? a.graphId).localeCompare(b.metadata.displayName ?? b.graphId));
  const first = visible[0];
  if (!first) return null;
  return { graphId: first.graphId };
}

/** True when the Skills trainer "Saving to" target won't persist (preview sentinel
 *  or nothing selected). Real Skills-template engram graphIds return false. */
function isSkillsPreviewSaveTarget(value: string | undefined | null): boolean {
  return !value || value === '__preview__';
}

/** Show the ⚠️ preview-mode warning ONLY when the "Saving to" target is the
 *  non-persisting sentinel. Must be called after EVERY change to the select —
 *  including programmatic `value =` assignments (create / import / draft-restore /
 *  retrain flows), which don't fire a 'change' event — otherwise the warning
 *  gets stranded visible even though a real engram is now selected. */
export function syncSkillsPreviewWarning(): void {
  const sel = document.getElementById('skills-input-engram') as HTMLSelectElement | null;
  const warn = document.getElementById('skills-preview-warning');
  if (!sel || !warn) return;
  const showPreviewWarning = isSkillsPreviewSaveTarget(sel.value);
  warn.classList.toggle('hidden', !showPreviewWarning);
}

export function populateSkillsEngramPickers(): void {
  // Bail if the DOM elements aren't in the document yet (called extremely
  // early during boot via syncEngramPicker — before the studio panes are
  // present on some code paths). Also bail if getLoadedGraphs() is empty; we'll
  // re-run as soon as the engram list IPC completes.
  const target = document.getElementById('skills-input-engram') as HTMLSelectElement | null;
  const focus = document.getElementById('skills-input-focus') as HTMLDivElement | null;
  if (!target && !focus) return;
  // (syncSkillsPreviewWarning is defined below; hoisted, safe to call from here.)

  // ── Target engram — Skills-template engrams + preview option ──────────
  // Top option: "Preview only — don't save" (sentinel '__preview__'). The
  // trainer still runs (recall + LLM rewrite + influential nodes), but the
  // result is not persisted into any engram. Below that, Skills-template
  // engrams sorted alphabetically. After Create Skill engram, the new
  // entry shows up in the right alphabetical slot and gets auto-selected
  // (the create flow sets target.value before this re-runs).
  if (target) {
    const skillsEngrams = getLoadedGraphs()
      .filter((g) => !g.metadata.archived && g.loaded !== false && g.metadata.template === 'skill')
      .sort((a, b) => (a.metadata.displayName ?? a.graphId).localeCompare(b.metadata.displayName ?? b.graphId));
    const prev = target.value;
    const previewOpt = '<option value="__preview__">Preview only — don\'t save</option>';
    if (skillsEngrams.length === 0) {
      // No Skills engram exists — Preview is the only option, auto-selected.
      target.innerHTML = previewOpt;
      target.value = '__preview__';
    } else {
      target.innerHTML = [
        previewOpt,
        '<option disabled>──────────</option>',
        ...skillsEngrams.map((g) => `<option value="${escape(g.graphId)}">${escape(app().formatEngramLabel(g))}</option>`),
      ].join('');
      // Preserve a real engram the user already picked; otherwise default to the
      // first Skills engram alphabetically (so saving is the default when one
      // exists). The HTML/bootstrap '__preview__' sentinel is NOT preserved here
      // — it only means "no engrams loaded yet", not an explicit user choice.
      const prevIsRealEngram = prev && prev !== '__preview__'
        && skillsEngrams.some((g) => g.graphId === prev);
      if (prevIsRealEngram) {
        target.value = prev;
      } else {
        const first = skillsEngrams[0];
        if (first) target.value = first.graphId;
      }
    }
    // Keep the ⚠️ preview-mode warning in sync with the value we just set.
    syncSkillsPreviewWarning();
  }

  // ── Focus engrams — hidden (train uses empty recall scope) ───────────
  // Kept for API compat if the section is re-enabled; populateSkillsEngramPickers
  // still fills the list when the DOM node exists.
  if (focus) {
    const ordered = getLoadedGraphs()
      .filter((g) => !g.metadata.archived && g.loaded !== false)
      .sort((a, b) => (a.metadata.displayName ?? a.graphId).localeCompare(b.metadata.displayName ?? b.graphId));
    const prevSelected = new Set(
      Array.from(focus.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map((c) => c.value),
    );
    focus.innerHTML = ordered
      .map((g) => {
        const checked = prevSelected.has(g.graphId) ? ' checked' : '';
        const name = escape(app().formatEngramLabel(g));
        return `
          <label class="skills-focus-item">
            <input type="checkbox" value="${escape(g.graphId)}"${checked} />
            <span data-pres="engram:${escape(g.graphId)}">${name}</span>
          </label>
        `;
      })
      .join('');
  }
}

/**
 * Programmatic counterpart to `createSkillEngramInline` — creates a
 * Skills-template engram with the given display name without showing a
 * prompt. Used by inline flows (e.g. the .gsk importer) where the user
 * has already confirmed creation via a higher-level confirm dialog and
 * we don't want to ask again.
 *
 * Returns the new graphId on success, or null on failure (toast already
 * surfaced to the user). The Skills engram picker is refreshed and the
 * new engram is auto-selected so the caller can read graphId straight
 * back from `#skills-input-engram`.
 */
export async function createSkillsEngramQuiet(displayName: string): Promise<string | null> {
  const trimmed = displayName.trim();
  if (!trimmed) {
    showSkillsToast('Engram name is empty.', 'error');
    return null;
  }
  const baseSlug = app().slugifyEngramName(trimmed);
  const collision = getLoadedGraphs().some((g) => g.graphId === baseSlug);
  const graphId = collision ? `${baseSlug}-${Date.now().toString(36).slice(-5)}` : baseSlug;
  try {
    const skillCreateResult = await invoke<{ error?: { code: string } }>('create_graph_with_template', { graphId, template: 'skill', displayName: trimmed });
    if (skillCreateResult?.error?.code === 'ENGRAM_LIMIT_REACHED') {
      showSkillsToast('Free plan: 3 engram limit reached. Upgrade at graphnosis.com/upgrade', 'error');
      void invoke('plugin:opener|open_url', { url: 'https://graphnosis.com/upgrade' });
      return null;
    }
    await app().reloadGraphsMetadata();
    app().syncEngramPicker();
    const targetSel = document.getElementById('skills-input-engram') as HTMLSelectElement | null;
    if (targetSel) targetSel.value = graphId;
    syncSkillsPreviewWarning(); // real engram now selected — drop the "won't be saved" note
    showSkillsToast(`Created Skills engram "${trimmed}"`, 'success');
    return graphId;
  } catch (e) {
    console.warn('[skills] create skill engram failed', e);
    const msg = e instanceof Error ? e.message : String(e);
    showSkillsToast(`Create failed: ${msg}`, 'error');
    return null;
  }
}

/** Inline "+ Create Skill engram" flow — prompts for a display name, creates
 *  a Skills-template engram via the existing create_graph_with_template
 *  Tauri command, then refreshes the engram list so the new entry appears
 *  in the dropdown (sorted alphabetically) with auto-selection. */
async function createSkillEngramInline(): Promise<void> {
  const rawName = window.prompt('Name your new Skills engram (e.g., "Skills", "Coding Skills", "Customer Support Skills"):', 'Skills');
  if (!rawName) return;
  const displayName = rawName.trim();
  if (!displayName) return;

  // Generate a slug-safe graphId. If a graph by that slug already exists
  // (very common when the user picks "Skills" twice), suffix with a short
  // timestamp so create_graph_with_template doesn't error.
  const baseSlug = app().slugifyEngramName(displayName);
  const collision = getLoadedGraphs().some((g) => g.graphId === baseSlug);
  const graphId = collision ? `${baseSlug}-${Date.now().toString(36).slice(-5)}` : baseSlug;

  try {
    await invoke('create_graph_with_template', { graphId, template: 'skill', displayName });
    // Refresh the in-memory engram list, then repaint the picker — this
    // calls populateSkillsEngramPickers() via app().syncEngramPicker() and the
    // new engram lands in the dropdown auto-sorted. Auto-select it.
    await app().reloadGraphsMetadata();
    app().syncEngramPicker();
    const targetSel = document.getElementById('skills-input-engram') as HTMLSelectElement | null;
    if (targetSel) targetSel.value = graphId;
    syncSkillsPreviewWarning(); // real engram now selected — drop the "won't be saved" note
    showSkillsToast(`Created Skills engram "${displayName}"`, 'success');
  } catch (e) {
    console.warn('[skills] create skill engram failed', e);
    const msg = e instanceof Error ? e.message : String(e);
    showSkillsToast(`Create failed: ${msg}`, 'error');
  }
}

// True only after a skill:list call SUCCEEDS. The orphan-skills warning gates
// on this so a transient skill:list failure (→ empty list) never cries "you
// accidentally removed your skills."
export let skillsLibraryLoadOk = false;
/** Set when the most recent skill:list failed — drives error empty-state copy. */
let skillsLibraryLoadError: string | null = null;
let skillsLibraryFetching = false;

export async function fetchSkillsLibrary(): Promise<void> {
  skillsLibraryFetching = true;
  try {
    skillsLibraryLoadError = null;
    skillsLibrary = (await ipcCallTimeout<SkillListEntry[]>('skill:list', {}, 45_000)) ?? [];
    skillsLibraryLoadOk = true;
  } catch (e) {
    console.warn('[skills] skill:list failed', e);
    skillsLibraryLoadError = e instanceof Error ? e.message : String(e);
    skillsLibrary = [];
    skillsLibraryLoadOk = false;
  } finally {
    skillsLibraryFetching = false;
  }
}

/**
 * Remove sourceIds from the hidden-skills set that no longer exist in any
 * loaded engram. Called once at startup after fetchSkillsLibrary() resolves.
 *
 * A sourceId is an orphan when its skill was permanently deleted (typically
 * because its engram was deleted). The sidecar only returns skills from
 * graphs that are actually loaded — so anything missing from skillsLibrary
 * after a full load is gone for good and should not persist in localStorage.
 */
export function purgeOrphanedHiddenSkills(): void {
  if (skillsHiddenSet.size === 0) return;
  const liveSourceIds = new Set(skillsLibrary.map((s) => s.sourceId));
  let changed = false;
  for (const id of [...skillsHiddenSet]) {
    if (!liveSourceIds.has(id)) {
      skillsHiddenSet.delete(id);
      changed = true;
    }
  }
  if (changed) persistSkillsHidden();
}

/** Force-expand engram group headers in the Skills library list. */
function expandSkillEngramGroups(graphIds: Iterable<string>): void {
  for (const gid of graphIds) skillEngramGroupState.set(gid, true);
}

let _skillsRefreshTimer: number | null = null;
/** Cancels stale mountSkillsPane runs when the user re-enters the tab quickly. */
let _mountSkillsGen = 0;

/** Debounced refetch of skill:list + re-render. Shared by mount, ↻, and
 *  graph-mutation while the Skills tab is open (MCP train_skill, auto-retrain). */
export function scheduleSkillsLibraryRefresh(opts: { syncGraphs?: boolean } = {}): void {
  if (_skillsRefreshTimer) clearTimeout(_skillsRefreshTimer);
  _skillsRefreshTimer = window.setTimeout(() => {
    _skillsRefreshTimer = null;
    void (async () => {
      const prevIds = new Set(skillsLibrary.map((s) => s.sourceId));
      if (opts.syncGraphs !== false) await app().reloadGraphsMetadata();
      await fetchSkillsLibrary();
      const newOnes = skillsLibrary.filter((s) => !prevIds.has(s.sourceId));
      if (newOnes.length > 0) {
        expandSkillEngramGroups(new Set(newOnes.map((s) => s.graphId)));
      }
      purgeOrphanedHiddenSkills();
      renderSkillsLibrary();
      if (newOnes.length > 0) void warmVitalityCache();
    })();
  }, 350);
}

export async function mountSkillsPane(): Promise<void> {
  const gen = ++_mountSkillsGen;
  // Drop the static HTML "Loading…" placeholder immediately when we already
  // have a cached library (re-entry) or can paint loading/empty/error state.
  if (skillsLibrary.length > 0) {
    renderSkillsLibrary();
  } else {
    skillsLibraryFetching = true;
    renderSkillsLibrary();
  }
  try {
    // Metadata + skill:list are independent — run in parallel so a slow
    // graphs.listWithMetadata / refreshCortexScopedStats chain cannot block
    // the library for minutes behind reloadGraphsMetadata alone.
    await Promise.all([
      app().reloadGraphsMetadata().catch((e) => {
        console.warn('[skills] reloadGraphsMetadata failed', e);
      }),
      fetchSkillsLibrary(),
    ]);
    if (gen !== _mountSkillsGen) return;

    populateSkillsEngramPickers();
    purgeOrphanedHiddenSkills();
    // Cross-session resume detection — find any sourceIds in the library
    // that weren't in last mount's snapshot. These are skills the sidecar
    // finished while the desktop wasn't running (autonomous retrain ran
    // overnight, scheduled retrain fired after the user closed the app,
    // train completed on the sidecar but the desktop crashed before the
    // IPC response landed, etc.). Surface them as a single toast so the
    // user knows where to look. Then refresh the snapshot.
    const newSkills = diffSkillsLibraryAgainstSnapshot();
    if (newSkills.length > 0) {
      expandSkillEngramGroups(new Set(newSkills.map((s) => s.graphId)));
      const first = newSkills[0];
      if (first) {
        const others = newSkills.length > 1 ? ` and ${newSkills.length - 1} more` : '';
        showSkillsToast(
          `Ghampus finished training "${humanizeSkillName(first.label) || skillDisplayName(first.label)}"${others} while you were away. Open the library to review.`,
          'success',
        );
      }
    }
    writeSkillsLibrarySnapshot();
    renderSkillsLibrary();
    // Orphan detection: if skill engrams exist but the library is empty, the
    // user may have accidentally forgotten all their skills. Guard hard against
    // false alarms: only when skill:list actually SUCCEEDED (not a transient
    // failure → empty) and we're NOT mid-ingest (a post-ingest refresh can race
    // ahead of skill:list repopulating). Otherwise this fires the alarming
    // "you removed your skills" message during normal, healthy states.
    const skillEngrams = getLoadedGraphs().filter(
      (g) => !g.metadata.archived && g.loaded !== false && g.metadata.template === 'skill',
    );
    if (skillEngrams.length > 0 && skillsLibrary.length === 0 && skillsLibraryLoadOk && app().getIngestJobCount() === 0) {
      showSkillsToast(
        `You have ${skillEngrams.length} Skills engram${skillEngrams.length === 1 ? '' : 's'} but no skills — you may have accidentally removed them. Check Sources in each Skills engram.`,
        'error',
      );
    }
    // Autopraxis badges are non-blocking — paint the list first, then refresh
    // row dots / pending-review indicator when settings IPC returns.
    void Promise.all([fetchRetrainNotifications(), fetchPendingProposals()])
      .then(() => { if (gen === _mountSkillsGen) renderSkillsLibrary(); })
      .catch(() => {});
    // Auto-compute vitality + retrain-schedule lookup for the top N by recency.
    void warmVitalityCache();
    void warmRetrainCache();
    showSkillsDraftRestorePrompt();
    updateSkillsResetButton();
    syncSkillsPreviewWarning();
  } catch (e) {
    console.warn('[skills] mountSkillsPane failed', e);
    skillsLibraryLoadError = e instanceof Error ? e.message : String(e);
    skillsLibraryLoadOk = false;
  } finally {
    if (gen === _mountSkillsGen) renderSkillsLibrary();
  }
}

async function warmRetrainCache(): Promise<void> {
  const visible = filteredSortedLibrary().slice(0, SKILLS_VITALITY_AUTO_CAP);
  const due = visible.filter((s) => !skillsRetrainCache.has(s.sourceId));
  if (due.length === 0) return;
  await Promise.all(due.map((s) => fetchRetrainConfig(s.sourceId).catch(() => null)));
  renderSkillsLibrary();
}

async function warmVitalityCache(): Promise<void> {
  const visible = filteredSortedLibrary().slice(0, SKILLS_VITALITY_AUTO_CAP);
  const now = Date.now();
  const due = visible.filter((s) => {
    const cached = skillsVitalityCache.get(s.sourceId);
    return !cached || (now - cached.fetchedAt) > SKILLS_VITALITY_TTL_MS;
  });
  if (due.length === 0) return;
  // Sequential — vitality is cheap but a burst of 10 parallel recalls would
  // hammer the sidecar. Sequential is fast enough and keeps UI responsive.
  for (const skill of due) {
    try {
      const v = await ipcCall<SkillVitality | null>('skill:vitality', {
        graphId: skill.graphId,
        sourceId: skill.sourceId,
      });
      if (v) skillsVitalityCache.set(skill.sourceId, { value: v, fetchedAt: Date.now() });
    } catch (e) {
      console.warn('[skills] vitality failed for', skill.sourceId, e);
    }
  }
  renderSkillsLibrary();
}

// ── Skill grouping helpers ────────────────────────────────────────────────────

/**
 * Extract the human-readable display name from a Graphnosis source ref.
 *
 * Source refs are stored in the form `{kind}:{timestamp}:{label}` by ingestClip,
 * e.g. `skill:1780131345514:Executive decision recall (imported 2026-05-30)`.
 * Strip the prefix so the UI shows only the label part. Falls back to the raw
 * string for source refs that don't match the pattern (manually-set names,
 * legacy cortexes, trainer-generated labels that use a different format).
 */
export function skillDisplayName(label: string): string {
  return label.replace(/^(?:skill|clip|ai-conversation):\d+:/, '').trim();
}

/** User-facing skill title — friendly name with date suffixes stripped and
 *  dash-slugs title-cased. Prefer this over skillDisplayName in headers. */
function skillFriendlyName(label: string): string {
  return humanizeSkillName(label) || skillDisplayName(label) || 'Untitled skill';
}

/** Strip the metadata comment (and optional ATX/bold title line) from stored
 *  skill text — used when falling back to plain-text Trained Output render. */
function stripSkillMetadataHeader(text: string): string {
  return text
    .replace(/^(?:#[^\n]+|\*\*[^\n]+\*\*)\n+<!--[\s\S]*?-->\n+/, '')
    .replace(/^<!--[\s\S]*?-->\n+/, '')
    .trim();
}

/**
 * Strip the "(imported YYYY-MM-DD)" and "(trained YYYY-MM-DD)" date suffixes
 * from a skill display name to get the canonical base name used for grouping.
 */
function skillBaseName(label: string): string {
  return skillDisplayName(label)
    .replace(/\s*\((?:imported|trained) \d{4}-\d{2}-\d{2}\)/g, '')
    .trim() || skillDisplayName(label);
}

// Display-only humanize: "runtime-diagnosis" → "Runtime Diagnosis". The dash
// slug stays the canonical identifier (sourceId/label, cross-skill @skill:
// references, routing) — this ONLY changes what the user reads in the library.
// Names that already contain spaces (e.g. imported .gsk packs with friendly
// titles) are left as-authored apart from trimming.
function humanizeSkillName(label: string): string {
  const base = skillBaseName(label);
  if (/\s/.test(base)) return base;
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || base;
}

// Friendly engram name for a graphId — the engram's own display name (with the
// 🛠️ skill-engram decoration via formatEngramLabel), falling back to the name
// carried on a skill entry, then the raw slug.
function engramDisplayName(graphId: string): string {
  const g = getLoadedGraphs().find((x) => x.graphId === graphId);
  if (g) return app().formatEngramLabel(g);
  const entry = skillsLibrary.find((s) => s.graphId === graphId);
  return entry?.engramName || graphId;
}

/**
 * Determine what kind of skill entry this is based on its label.
 * - 'imported'  → came from a .gsk pack (has "(imported YYYY-MM-DD)")
 * - 'trained'   → trained/retrained version (has "(trained YYYY-MM-DD)")
 * - 'manual'    → user-authored skill with a plain name
 */
function skillEntryKind(label: string): 'imported' | 'trained' | 'manual' {
  const name = skillDisplayName(label);
  if (/\(trained \d{4}-\d{2}-\d{2}\)/.test(name)) return 'trained';
  if (/\(imported \d{4}-\d{2}-\d{2}\)/.test(name)) return 'imported';
  return 'manual';
}

interface SkillTreeNode {
  entry:    SkillListEntry;
  children: SkillTreeNode[];  // direct trained descendants, oldest first
}

/**
 * Build a recursive skill tree from a flat library list.
 *
 * Parent–child is determined by label prefix: stripping the last
 * "(imported DATE)" or "(trained DATE)" suffix gives the parent's display
 * name. If the parent exists in the library it becomes the actual parent
 * node; otherwise the entry becomes a root.
 *
 *   "Foo (imported 2026-05-30)"                 → root
 *   "Foo (imported 2026-05-30) (trained ...)"    → child of above
 *   "Foo (imported 2026-05-30) (trained ...) (trained ...)" → grandchild
 *
 * This naturally produces an unbounded cascade: a retrained version of a
 * retrained version of an import shows as root → child → grandchild.
 */
function buildSkillTree(library: SkillListEntry[], sortMode: 'recent' | 'vitality' | 'name' = 'recent'): SkillTreeNode[] {
  // Map (engram graphId + displayName) → node for parent lookup. The key MUST
  // be scoped to the backing engram: lineage (import → trained → retrained)
  // only ever lives inside a single engram, while DIFFERENT engrams routinely
  // hold skills that share a display name (e.g. each skill-template family has
  // its own "Untitled skill" / same-named capability). Keying on displayName
  // alone let those cross-engram collisions overwrite each other in the map —
  // entire engrams vanished from the grouped list and per-engram counts came
  // out wrong, while the single-engram filter (which slices to one graphId
  // before this runs) stayed correct. The NUL separator can't appear in a
  // graphId slug or a label, so it's a safe composite delimiter.
  const keyFor = (graphId: string, display: string): string => `${graphId}\u0000${display}`;
  const byDisplay = new Map<string, SkillTreeNode>();
  for (const s of library) {
    const display = skillDisplayName(s.label);
    byDisplay.set(keyFor(s.graphId, display), { entry: s, children: [] });
  }

  const roots: SkillTreeNode[] = [];
  for (const node of byDisplay.values()) {
    const display = skillDisplayName(node.entry.label);
    // Strip the last "(imported|trained DATE)" suffix to get the parent display
    // name, then look the parent up WITHIN the same engram.
    const parentDisplayMatch = display.match(/^(.*?)\s+\((?:imported|trained) \d{4}-\d{2}-\d{2}\)$/);
    const parentDisplay = parentDisplayMatch?.[1]?.trim();
    const parentNode = parentDisplay
      ? byDisplay.get(keyFor(node.entry.graphId, parentDisplay))
      : undefined;
    if (parentNode) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Children are ALWAYS chronological (oldest → newest) — the trained-version
  // history reads as a timeline regardless of the user-chosen sort mode.
  function sortTree(node: SkillTreeNode): void {
    node.children.sort((a, b) => a.entry.ingestedAt - b.entry.ingestedAt);
    node.children.forEach(sortTree);
  }
  roots.forEach(sortTree);

  // Root parents are sorted by the user-selected sort mode. The flat
  // pre-sort done in filteredSortedLibrary() is overridden here because
  // buildSkillTree's grouping pass naturally re-orders parents — without
  // re-applying the sort at this layer, alphabetical ("Name A→Z") stopped
  // working after the tree was introduced.
  if (sortMode === 'name') {
    roots.sort((a, b) => skillBaseName(a.entry.label).localeCompare(skillBaseName(b.entry.label)));
  } else if (sortMode === 'vitality') {
    roots.sort((a, b) => {
      const va = skillsVitalityCache.get(a.entry.sourceId)?.value.score ?? -1;
      const vb = skillsVitalityCache.get(b.entry.sourceId)?.value.score ?? -1;
      return vb - va;
    });
  } else {
    // 'recent' — newest parent first.
    roots.sort((a, b) => b.entry.ingestedAt - a.entry.ingestedAt);
  }

  return roots;
}

/**
 * Tracks which skill tree nodes are currently EXPANDED, keyed by sourceId.
 * Default is collapsed — the user opts in by clicking the ▶ arrow.
 */
const skillGroupsExpanded = new Set<string>();

// User-set expand state for the top-level ENGRAM grouping layer, keyed by
// graphId → expanded?. Absent means "use the default" (collapsed, except a
// single-engram cortex which defaults open). An active filter force-expands
// every matching group regardless, so filtering always reveals its hits.
const skillEngramGroupState = new Map<string, boolean>();

function filteredSortedLibrary(): SkillListEntry[] {
  // Drop skills whose backing engram is no longer loaded — prevents stale
  // IPC calls to a deleted graph ("Graph not loaded: X" errors).
  // ALSO drop skills whose engram is archived — the user explicitly hid
  // that engram via Settings → Cortex Management, and the archive button's
  // confirmation dialog promises "those skills will be hidden". Without
  // this filter the promise was broken: the engram disappeared from the
  // engram picker but its trained skills kept showing in the library.
  const visibleGraphIds = new Set(
    getLoadedGraphs().filter((g) => !g.metadata.archived).map((g) => g.graphId),
  );
  // When getLoadedGraphs() hasn't caught up yet (boot race, fresh engram create),
  // don't hide every skill — trust skill:list until Tauri metadata syncs.
  let list = visibleGraphIds.size === 0
    ? skillsLibrary.slice()
    : skillsLibrary.filter((s) => visibleGraphIds.has(s.graphId));
  if (!skillsShowHidden) {
    list = list.filter((s) => !skillsHiddenSet.has(s.sourceId));
  }
  // Engram dropdown filter.
  if (skillsFilterEngram !== 'all') {
    list = list.filter((s) => s.graphId === skillsFilterEngram);
  }
  // Free-text filter — matches the friendly name, the raw slug, the training
  // mode (a rough "status"), and the engram name, so "name, status etc." all work.
  const q = skillsFilterText.trim().toLowerCase();
  if (q) {
    list = list.filter((s) =>
      humanizeSkillName(s.label).toLowerCase().includes(q) ||
      skillDisplayName(s.label).toLowerCase().includes(q) ||
      (s.mode ?? '').toLowerCase().includes(q) ||
      engramDisplayName(s.graphId).toLowerCase().includes(q),
    );
  }
  if (skillsLibrarySort === 'recent') {
    list.sort((a, b) => {
      const ta = parseTrainedAt(a.trainedAt) ?? a.ingestedAt;
      const tb = parseTrainedAt(b.trainedAt) ?? b.ingestedAt;
      return tb - ta;
    });
  } else if (skillsLibrarySort === 'vitality') {
    list.sort((a, b) => {
      const va = skillsVitalityCache.get(a.sourceId)?.value.score ?? -1;
      const vb = skillsVitalityCache.get(b.sourceId)?.value.score ?? -1;
      return vb - va;
    });
  } else if (skillsLibrarySort === 'name') {
    list.sort((a, b) => a.label.localeCompare(b.label));
  }
  return list;
}

// Keep the engram-filter dropdown in sync with the engrams that actually hold
// skills. Preserves the current selection; reverts to "All engrams" if the
// selected engram is gone (deleted / archived).
function syncSkillsEngramFilterOptions(): void {
  const sel = document.getElementById('skills-library-engram-filter') as HTMLSelectElement | null;
  if (!sel) return;
  const gids = [...new Set(skillsLibrary.map((s) => s.graphId))]
    .filter((gid) => getLoadedGraphs().some((g) => g.graphId === gid && !g.metadata.archived))
    .sort((a, b) => engramDisplayName(a).localeCompare(engramDisplayName(b)));
  if (skillsFilterEngram !== 'all' && !gids.includes(skillsFilterEngram)) {
    skillsFilterEngram = 'all';
  }
  sel.innerHTML = ['<option value="all">All engrams</option>']
    .concat(gids.map((gid) => `<option value="${escapeHtml(gid)}">${escapeHtml(engramDisplayName(gid))}</option>`))
    .join('');
  sel.value = skillsFilterEngram;
}

// Measure the (variable-height) library header + filter row and publish their
// heights as CSS vars so the sticky filter row + engram group headers sit
// exactly below, never under, the rows above. Hardcoded px broke when the
// header was taller than the guess (the filter row slid under it on scroll).
function updateSkillsStickyOffsets(): void {
  const lib = document.querySelector<HTMLElement>('.skills-library');
  const header = document.querySelector<HTMLElement>('.skills-library-header');
  const filters = document.querySelector<HTMLElement>('.skills-library-filters');
  if (!lib || !header) return;
  const h1 = header.offsetHeight;
  const h2 = filters?.offsetHeight ?? 0;
  lib.style.setProperty('--lib-header-h', `${h1}px`);
  lib.style.setProperty('--lib-sticky-h', `${h1 + h2}px`);
}
let _skillsStickyResizeBound = false;

export function renderSkillsLibrary(): void {
  syncSkillsEngramFilterOptions();
  updateSkillsStickyOffsets();
  if (!_skillsStickyResizeBound) {
    _skillsStickyResizeBound = true;
    window.addEventListener('resize', updateSkillsStickyOffsets);
  }
  const list = filteredSortedLibrary();
  const countEl = document.getElementById('skills-library-count');
  const listEl = document.getElementById('skills-library-list');
  const hiddenBtn = document.getElementById('btn-skills-show-hidden');
  const totalHidden = skillsHiddenSet.size;
  if (countEl) countEl.textContent = String(list.length);
  if (hiddenBtn) {
    hiddenBtn.textContent = skillsShowHidden ? `Hide hidden (${totalHidden})` : `Show hidden (${totalHidden})`;
    hiddenBtn.style.visibility = totalHidden > 0 ? 'visible' : 'hidden';
  }
  if (!listEl) return;
  if (list.length === 0) {
    let msg: string;
    if (skillsLibraryLoadError) {
      msg = `Could not load skills (${skillsLibraryLoadError}). Try ↻ or reopen this tab.`;
    } else if (skillsLibraryFetching && skillsLibrary.length === 0) {
      msg = 'Loading skills…';
    } else if (skillsLibrary.length === 0) {
      msg = 'You haven\'t trained any skills yet. Compose one on the right to begin.';
    } else if (skillsShowHidden) {
      msg = 'No skills match your filter.';
    } else {
      const allHidden = skillsLibrary.every((s) => skillsHiddenSet.has(s.sourceId));
      msg = allHidden
        ? 'All your skills are hidden. Click "Show hidden" to bring them back.'
        : 'No skills match your filter.';
    }
    listEl.innerHTML = `<p class="subtitle skills-library-empty">${escape(msg)}</p>`;
    return;
  }

  // Group the lineage trees by their backing ENGRAM → one expandable section
  // per engram, instead of a single long flat list.
  const roots = buildSkillTree(list, skillsLibrarySort);
  const groups = new Map<string, SkillTreeNode[]>();
  for (const r of roots) {
    let arr = groups.get(r.entry.graphId);
    if (!arr) { arr = []; groups.set(r.entry.graphId, arr); }
    arr.push(r);
  }
  const groupEntries = [...groups.entries()]
    .sort((a, b) => engramDisplayName(a[0]).localeCompare(engramDisplayName(b[0])));
  const onlyOneGroup = groupEntries.length <= 1;
  const filterActive = skillsFilterText.trim() !== '' || skillsFilterEngram !== 'all';
  const countNodes = (nodes: SkillTreeNode[]): number =>
    nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);

  // Engrams whose group is currently expanded — their per-skill autonomy
  // readouts are warmed after paint so the dials fill in (one IPC per engram,
  // cached). Collapsed groups are skipped until the user opens them.
  const expandedEngramIds: string[] = [];
  listEl.innerHTML = groupEntries.map(([gid, rootsInGroup]) => {
    // A filter force-expands every group it matches. Otherwise: user state if
    // set, else default (open only when there's a single engram).
    const userState = skillEngramGroupState.get(gid);
    const expanded = filterActive ? true : (userState !== undefined ? userState : onlyOneGroup);
    if (expanded) expandedEngramIds.push(gid);
    const count = countNodes(rootsInGroup);
    const childrenHtml = rootsInGroup.map((n) => renderSkillTreeNode(n)).join('');
    // Every engram in this library is a skill-template engram → an Agempus.
    return `<div class="skill-engram-group${expanded ? ' expanded' : ''}" data-engram-id="${escape(gid)}">
      <button class="skill-engram-group-toggle" aria-expanded="${expanded}">
        <span class="skill-engram-group-arrow">▶</span>
        <span class="skill-engram-group-name" data-pres="engram:${escape(gid)}">${escape(engramDisplayName(gid))}</span>
        <span class="agempus-badge" title="This skill-template engram is an Agempus — a domain agent Ghampus can dispatch to.">Agempus</span>
        <span class="skill-engram-group-count">${count}</span>
      </button>
      ${renderAgempusDial(gid)}
      <div class="skill-engram-group-children">${childrenHtml}</div>
    </div>`;
  }).join('');

  // ── Single delegated listener for the entire list ────────────────────────
  // Handles all depth levels without re-binding on every render.
  // Guard: only attach once — this function is called on every render but
  // the listener must not accumulate. We use a data attribute as the flag.
  // Precedence: toggle > action buttons > row click.
  if (!listEl.dataset['listenerBound']) {
    listEl.dataset['listenerBound'] = '1';
  listEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Agempus autonomy dial segment — set this engram's executionAutonomyLevel.
    // Checked BEFORE the group toggle so clicking the dial never collapses the
    // section. Disabled (L3) segments are inert.
    const dialSeg = target.closest<HTMLButtonElement>('.agempus-dial-seg');
    if (dialSeg) {
      e.stopPropagation();
      if (dialSeg.disabled) return;
      const dialEl = dialSeg.closest<HTMLElement>('.agempus-dial');
      const gid = dialEl?.dataset['agempusEngram'] ?? '';
      const level = dialSeg.dataset['agempusLevel'] as 'L0' | 'L1' | 'L2' | 'L3' | undefined;
      if (gid && level) void setAgempusLevel(gid, level);
      return;
    }

    // Per-skill autonomy control — Inherit toggle or an L0–L3 segment. Checked
    // BEFORE the row-click handler so adjusting a skill's autonomy never opens
    // the trainer. Disabled segments (above the authored dispatch-safe cap) are
    // inert. Reads graphId+sourceId off the wrapping control.
    const skillAutBtn = target.closest<HTMLButtonElement>('.skill-autonomy-seg, .skill-autonomy-inherit');
    if (skillAutBtn) {
      e.stopPropagation();
      if (skillAutBtn.disabled) return;
      const ctl = skillAutBtn.closest<HTMLElement>('.skill-autonomy');
      const gid = ctl?.dataset['skillAutonomyGraph'] ?? '';
      const sid = ctl?.dataset['skillAutonomySource'] ?? '';
      const lvl = skillAutBtn.dataset['skillLevel'] as 'L0' | 'L1' | 'L2' | 'L3' | 'inherit' | undefined;
      if (gid && sid && lvl) void setSkillAutonomyLevel(gid, sid, lvl);
      return;
    }

    // Engram group header — expand/collapse the whole engram section.
    const engramToggle = target.closest<HTMLButtonElement>('.skill-engram-group-toggle');
    if (engramToggle) {
      const groupEl = engramToggle.closest<HTMLElement>('.skill-engram-group');
      const gid = groupEl?.dataset['engramId'] ?? '';
      if (!groupEl || !gid) return;
      const nowExpanded = !groupEl.classList.contains('expanded');
      groupEl.classList.toggle('expanded', nowExpanded);
      skillEngramGroupState.set(gid, nowExpanded);
      engramToggle.setAttribute('aria-expanded', String(nowExpanded));
      // Lazily warm this engram's per-skill autonomy readout the first time it
      // opens so the in-row dials populate without a full library re-render.
      if (nowExpanded) void warmDispatchReadouts([gid]);
      e.stopPropagation();
      return;
    }

    // Arrow toggle — only element that expands/collapses.
    const toggle = target.closest<HTMLButtonElement>('.skill-group-toggle');
    if (toggle) {
      const groupEl = toggle.closest<HTMLElement>('.skill-group');
      const sid = groupEl?.dataset['sourceId'] ?? '';
      if (!groupEl || !sid) return;
      const nowExpanded = !groupEl.classList.contains('expanded');
      groupEl.classList.toggle('expanded', nowExpanded);
      if (nowExpanded) skillGroupsExpanded.add(sid);
      else             skillGroupsExpanded.delete(sid);
      toggle.setAttribute('aria-expanded', String(nowExpanded));
      e.stopPropagation();
      return;
    }

    // Action buttons.
    const actionBtn = target.closest<HTMLButtonElement>('.skill-row-action, .skill-child-action');
    if (actionBtn) {
      const action = actionBtn.dataset['action'];
      const sid = actionBtn.dataset['sourceId'];
      const gid = actionBtn.dataset['graphId'];
      if (!action || !sid || !gid) return;
      if (action === 'forget') {
        // Confirm before hiding — hiding is reversible (Show hidden brings
        // them back) but easy to do by accident on the dense library rows,
        // so a one-line confirm prevents the "wait, where did my skill go?"
        // moment.
        const target = skillsLibrary.find((s) => s.sourceId === sid);
        const displayName = target ? (skillBaseName(target.label) || skillDisplayName(target.label) || 'this skill') : 'this skill';
        const ok = window.confirm(
          `Hide "${displayName}" from the library?\n\nYou can restore it any time with the Show hidden button.`,
        );
        if (!ok) return;
        skillsHiddenSet.add(sid);
        persistSkillsHidden();
        if (skillsActiveSourceId === sid) { skillsActiveSourceId = null; showSkillsComposeMode(); resetSkillsComposeForm(); }
        renderSkillsLibrary();
      } else if (action === 'unhide') {
        skillsHiddenSet.delete(sid); persistSkillsHidden(); renderSkillsLibrary();
      } else if (action === 'retrain') {
        void openSkillInTrainer(sid, gid, { retrain: true });
      } else if (action === 'export') {
        void openSkillInTrainer(sid, gid, { scrollToExport: true });
      } else if (action === 'history') {
        void toggleSkillHistory(actionBtn, sid, gid);
      } else if (action === 'rollback') {
        void rollbackSkillVersion(sid, gid, actionBtn.dataset['snapshotId'] ?? '');
      }
      e.stopPropagation();
      return;
    }

    // Row click → ONLY opens the skill in the Trainer panel. Expand/collapse
    // is exclusively the arrow's job. Treating the row as a combined
    // "open + toggle" target caused accidental tree shuffling when the user
    // just wanted to inspect a parent skill.
    const row = target.closest<HTMLElement>('.skill-row');
    if (row && !target.closest('.skill-group-toggle, .skill-row-action')) {
      const sid = row.dataset['sourceId'];
      const gid = row.dataset['graphId'];
      if (sid && gid) void openSkillInTrainer(sid, gid);
    }
  });
  } // end once-guard

  // Warm per-skill autonomy readouts for the engrams that are currently
  // expanded. Cached engrams are skipped, so this is a no-op once warmed; it
  // repaints (once) when a fresh readout lands so the per-skill dials fill in.
  if (expandedEngramIds.length > 0) void warmDispatchReadouts(expandedEngramIds);
}

// ── Agempus autonomy dial (engram-as-agent) ──────────────────────────────────
//
// Each skill-template engram is an Agempus — a domain agent. Its per-engram
// `executionAutonomyLevel` (GraphMetadata) is the dial: how far Ghampus may take
// a skill matched from THIS engram automatically. We READ the current level off
// loaded-graph metadata and WRITE it via the `graphs.setExecutionAutonomy` IPC.
//
// Guardrails (match what the runtime can actually deliver — see the design note):
//   • The effective level is ALSO capped per skill by each skill's authored
//     `[dispatch-safe:]` tag (decideSkillAutonomy, sidecar). We surface that as a
//     note rather than computing a per-Agempus cap — the skill texts aren't in
//     the list payload, and a real cap readout belongs with the larger Agents
//     view. (SCOPED OUT.)
//   • L3 ("autonomous") drives the live unattended executor + review UI. The
//     segment is selectable but stays capped per skill by the authored
//     `[dispatch-safe:]` tag, and the executor itself is opt-in / OFF by default
//     (toggle + run review in the Unattended tab).
// AGEMPUS_LEVELS, currentAgempusLevel, renderAgempusDial, the DispatchSafe*
// types, levelRankUi, perSkillReadout, fetchDispatchReadout, and the shared
// readout cache now live in ./skills-shared (imported above) so the Agents
// roster (agents.ts) reuses them without forking. See that module.

/** Warm the dispatch-safe readout for the given engrams, then repaint so the
 *  per-skill dials fill in. No-op for engrams already cached. */
async function warmDispatchReadouts(graphIds: Iterable<string>): Promise<void> {
  const due = [...new Set(graphIds)].filter((gid) => !skillsDispatchReadoutCache.has(gid));
  if (due.length === 0) return;
  await Promise.all(due.map((gid) => fetchDispatchReadout(gid)));
  renderSkillsLibrary();
}

const SKILL_AUTONOMY_LEVELS: ReadonlyArray<{ level: AutonomyLevel; label: string; title: string; locked?: boolean }> = [
  { level: 'L0', label: 'L0', title: 'Manual — never surface a card for this skill.' },
  { level: 'L1', label: 'L1', title: 'Suggest — surface a propose-card.' },
  { level: 'L2', label: 'L2', title: 'Preview — surface a preview-then-run card.' },
  { level: 'L3', label: 'L3', title: 'Autonomous — eligible for unattended auto-run when the executor is enabled (opt-in, OFF by default). Capped by this skill’s authored dispatch-safe.' },
];

/**
 * Render a per-skill autonomy control: an "Inherit" toggle + an L0–L3
 * segmented dial showing the skill's EFFECTIVE (capped) level. Segments above
 * the skill's authored cap are greyed/disabled; when the effective level is
 * pinned BELOW the chosen level by the cap, an annotation explains it.
 *
 * Falls back to a "loading" stub when the engram's readout hasn't arrived yet
 * (warmDispatchReadouts repaints when it lands).
 */
function renderSkillAutonomyControl(graphId: string, sourceId: string): string {
  const entry = perSkillReadout(graphId, sourceId);
  if (!entry) {
    // If the engram's readout is already cached but this sourceId isn't in it
    // (e.g. a lineage row that isn't a distinct backing source), render nothing
    // rather than a stuck "loading" stub. Only show the loading stub while the
    // engram's readout is genuinely still pending.
    if (skillsDispatchReadoutCache.has(graphId)) return '';
    // Readout not yet cached — render a passive stub; warm-fetch repaints it.
    return `<div class="skill-autonomy" data-skill-autonomy-graph="${escape(graphId)}" data-skill-autonomy-source="${escape(sourceId)}" data-pending="1">
      <span class="skill-autonomy-label">Autonomy</span>
      <span class="skill-autonomy-loading">…</span>
    </div>`;
  }
  const inheriting = entry.configuredSkillLevel === null;
  const capRank = levelRankUi(entry.cap);
  // The dial highlights the EFFECTIVE level (what the dispatcher honors). When
  // inheriting, that is the family default capped by this skill's safety.
  const active = entry.effectiveLevel;
  // The skill is "pinned by its cap" when the user explicitly chose a level
  // above what the authored dispatch-safe tag allows → effective < configured.
  const pinnedByCap = entry.configuredSkillLevel !== null
    && levelRankUi(entry.configuredSkillLevel) > capRank;

  const segs = SKILL_AUTONOMY_LEVELS.map((s) => {
    const aboveCap = levelRankUi(s.level) > capRank;
    const isActive = !inheriting && s.level === active;
    const disabled = s.locked || aboveCap;
    const cls = `skill-autonomy-seg${isActive ? ' active' : ''}${aboveCap ? ' above-cap' : ''}`;
    const title = aboveCap
      ? `${s.label} exceeds this skill's authored dispatch-safe cap (${entry.cap}).`
      : s.title;
    return `<button type="button" class="${cls}"${disabled ? ' disabled' : ''} data-skill-level="${s.level}" title="${escape(title)}">${escape(s.label)}</button>`;
  }).join('');

  const inheritCls = `skill-autonomy-inherit${inheriting ? ' active' : ''}`;
  const note = pinnedByCap
    ? `<span class="skill-autonomy-note pinned">Pinned to ${entry.effectiveLevel} by authored cap (<code>dispatch-safe: ${escape(entry.dispatchSafe)}</code>).</span>`
    : inheriting
      ? `<span class="skill-autonomy-note">Inheriting family default — effective <strong>${entry.effectiveLevel}</strong> (cap ${entry.cap}).</span>`
      : `<span class="skill-autonomy-note">Override <strong>${entry.configuredSkillLevel}</strong> — effective <strong>${entry.effectiveLevel}</strong> (cap ${entry.cap}).</span>`;

  return `<div class="skill-autonomy" data-skill-autonomy-graph="${escape(graphId)}" data-skill-autonomy-source="${escape(sourceId)}">
    <span class="skill-autonomy-label">Autonomy</span>
    <button type="button" class="${inheritCls}" data-skill-level="inherit" title="Clear the override — inherit the Agempus family default.">Inherit</button>
    <span class="skill-autonomy-track">${segs}</span>
    ${note}
  </div>`;
}

/** Persist (or clear) a per-skill autonomy override, then refresh the engram's
 *  readout + repaint. `level === 'inherit'` clears the override (sends null). */
async function setSkillAutonomyLevel(
  graphId: string,
  sourceId: string,
  level: AutonomyLevel | 'inherit',
): Promise<void> {
  const entry = perSkillReadout(graphId, sourceId);
  // No-op guards: don't write the same override / re-clear when already inherit.
  if (level === 'inherit') {
    if (entry && entry.configuredSkillLevel === null) return;
  } else {
    if (entry && entry.configuredSkillLevel === level) return;
    // Block requests above the authored cap at the UI layer (segment is also
    // disabled). The backend would refuse anyway; this avoids a wasted call.
    if (entry && levelRankUi(level) > levelRankUi(entry.cap)) {
      showSkillsToast(`${level} exceeds this skill's authored dispatch-safe cap (${entry.cap}).`, 'error');
      return;
    }
  }
  try {
    const res = await ipcCall<{ ok: boolean; effectiveLevel: AutonomyLevel }>(
      'skills.setSkillAutonomy',
      { graphId, sourceId, level: level === 'inherit' ? null : level },
    );
    // Invalidate + refetch the readout so the dial reflects the committed
    // configured/effective state (and any cap clamp the backend applied).
    skillsDispatchReadoutCache.delete(graphId);
    await fetchDispatchReadout(graphId);
    renderSkillsLibrary();
    const eff = res?.effectiveLevel;
    if (level === 'inherit') {
      showSkillsToast('Autonomy override cleared — inheriting the family default.', 'success');
    } else if (eff && eff !== level) {
      showSkillsToast(`Requested ${level}, clamped to ${eff} by the authored dispatch-safe cap.`, 'success');
    } else {
      showSkillsToast(`Per-skill autonomy set to ${eff ?? level}.`, 'success');
    }
  } catch (e) {
    console.warn('[skills] setSkillAutonomy failed', e);
    showSkillsToast('Could not update the skill autonomy level. Try again.', 'error');
  }
}

/** Persist an Agempus's autonomy level via IPC, then refresh metadata + repaint
 *  so the dial reflects the committed value. Skipped when unchanged. L3 is a
 *  valid family default — it drives the opt-in unattended executor (OFF by
 *  default), and each skill stays capped by its authored dispatch-safe. */
async function setAgempusLevel(graphId: string, level: 'L0' | 'L1' | 'L2' | 'L3'): Promise<void> {
  if (currentAgempusLevel(graphId) === level) return;
  try {
    await ipcCall('graphs.setExecutionAutonomy', { graphId, level });
    await app().reloadGraphsMetadata();
    // The family default changed → every inheriting skill's effective level may
    // shift. Invalidate + refetch this engram's readout so the per-skill dials
    // repaint with their new effective levels.
    skillsDispatchReadoutCache.delete(graphId);
    await fetchDispatchReadout(graphId);
    renderSkillsLibrary();
    showSkillsToast(`Autonomy set to ${level} for ${engramDisplayName(graphId)}`, 'success');
  } catch (e) {
    console.warn('[agempus] set autonomy failed', e);
    showSkillsToast('Could not update autonomy level. Try again.', 'error');
  }
}

/**
 * Render a skill tree node recursively.
 *
 * Every node uses the same `.skill-row` style regardless of depth — no
 * indentation. Nodes with children get a ▶ toggle and a collapsible
 * `.skill-group-children` wrapper. Children are also rendered via this same
 * function, so the cascade is unbounded: original → trained → retrained →
 * re-retrained all render with the same expandable-row pattern.
 *
 * Expand/collapse is keyed by sourceId (not base name) so each level in the
 * tree is independently collapsible.
 */
function renderSkillTreeNode(node: SkillTreeNode): string {
  const s = node.entry;
  const hasChildren = node.children.length > 0;
  const isExpanded = skillGroupsExpanded.has(s.sourceId);
  const expandedClass = hasChildren && isExpanded ? ' expanded' : '';
  const hasChildrenClass = hasChildren ? ' has-children' : '';

  const childrenHtml = hasChildren
    ? `<div class="skill-group-children">${node.children.map((c) => renderSkillTreeNode(c)).join('')}</div>`
    : '';

  return `
    <div class="skill-group${hasChildrenClass}${expandedClass}" data-source-id="${escape(s.sourceId)}">
      ${renderSkillRow(s, hasChildren, isExpanded)}
      ${childrenHtml}
    </div>
  `;
}

/** Render the parent row of a skill group. `hasChildren` shows the expand
 *  toggle; `groupExpanded` sets its initial aria-expanded state. */
function renderSkillRow(s: SkillListEntry, hasChildren = false, groupExpanded = false): string {
  const vit = skillsVitalityCache.get(s.sourceId)?.value;
  const grade = vit ? vitalityGrade(vit.score) : 'a';
  const vitClass = vit ? `grade-${grade}` : 'uncomputed';
  const vitScore = vit ? `${Math.round(vit.score)}` : '—';
  const vitWidth = vit ? `${Math.round(vit.score)}%` : '0%';
  const trainedAtTs = parseTrainedAt(s.trainedAt) ?? s.ingestedAt;
  const isHidden = skillsHiddenSet.has(s.sourceId);
  const activeClass = skillsActiveSourceId === s.sourceId ? ' active' : '';

  // Kind chip: replaces the raw "(imported …)" / "(trained …)" date text.
  const kind = skillEntryKind(s.label);
  const kindChip = `<span class="skill-kind-chip skill-kind-${kind}">${escape(kind)}</span>`;

  // Author/provenance badge — surfaced for skills imported from a signed .gsk
  // pack. Pre-staging the UI for the future per-user signing identities feature
  // (see Graphnosis memory: "Future: per-user GSK signing identities").
  const prov = s.provenance;
  const authorBadge = prov && prov.verified && prov.kind === 'official'
    ? `<span class="skill-author-badge skill-author-verified" title="Signed by ${escape(prov.author)} — Ed25519 signature verified at import">✓ ${escape(prov.author)}</span>`
    : prov
      ? `<span class="skill-author-badge skill-author-unverified" title="Community pack — unsigned, author unverified">⚠ ${escape(prov.author || 'community')}</span>`
      : '';

  const modeChip = s.mode
    ? `<span class="skill-row-engram" style="background:color-mix(in oklab,var(--ok) 14%,transparent);color:var(--ok)">${escape(s.mode)}</span>`
    : '';
  const retrainCfg = skillsRetrainCache.get(s.sourceId);
  const autoChip = retrainCfg?.enabled
    ? `<span class="skill-row-auto" title="Auto-retrain on a schedule">⏰ auto</span>`
    : '';
  const notifyDot = skillsRetrainNotifications.has(s.sourceId)
    ? `<span class="skill-row-notify" title="Auto-retrained — open to review">🆕</span>`
    : '';
  const pendingChip = skillsRetrainPending[s.sourceId]
    ? `<span class="skill-row-pending" title="Auto-retrain proposed a new version — review pending">📝 review</span>`
    : '';

  // Expand/collapse toggle shown only when the group has children.
  const toggle = hasChildren
    ? `<button class="skill-group-toggle" type="button" aria-expanded="${groupExpanded}" title="Expand to see trained versions">▶</button>`
    : '';

  const actions = isHidden
    ? `<button class="skill-row-action btn-ghost" data-action="unhide" data-source-id="${escape(s.sourceId)}" data-graph-id="${escape(s.graphId)}" title="Restore to library">Restore</button>`
    : `<button class="skill-row-action btn-ghost" data-action="retrain" data-source-id="${escape(s.sourceId)}" data-graph-id="${escape(s.graphId)}" title="Re-train this skill">Retrain</button>
       <button class="skill-row-action btn-ghost" data-action="export" data-source-id="${escape(s.sourceId)}" data-graph-id="${escape(s.graphId)}" title="Export this skill">Export</button>
       <button class="skill-row-action btn-ghost" data-action="history" data-source-id="${escape(s.sourceId)}" data-graph-id="${escape(s.graphId)}" aria-expanded="false" title="Show version history (retrains + rollback)">History ▸</button>
       <button class="skill-row-action btn-ghost" data-action="forget" data-source-id="${escape(s.sourceId)}" data-graph-id="${escape(s.graphId)}" title="Hide from library">Hide</button>`;

  // Show the friendly, humanized BASE name (no date suffixes, dashes → spaces,
  // Title Case) as the visible title — kind/mode chips carry the context. The
  // raw slug stays in the tooltip as the canonical identifier for power users.
  const displayName = skillFriendlyName(s.label);

  return `
    <div class="skill-row${activeClass}" data-source-id="${escape(s.sourceId)}" data-graph-id="${escape(s.graphId)}">
      <div class="skill-row-title" title="${escape(skillDisplayName(s.label))}">${toggle}<span data-pres="skill:${escape(s.sourceId)}" data-pres-engram="${escape(s.graphId)}">${escape(displayName)}</span></div>
      <div class="skill-row-top">
        <span class="skill-row-engram" title="${escape(s.engramName)}" data-pres="engram:${escape(s.graphId)}">${escape(s.engramName)}</span>
        ${kindChip}
        ${authorBadge}
        ${modeChip}
        ${autoChip}
        ${notifyDot}
        ${pendingChip}
        <span class="skill-row-actions">${actions}</span>
      </div>
      <div class="skill-row-meta">
        <span class="skill-vitality ${vitClass}" title="${vit ? escape(vit.recommendation) : 'Vitality not yet computed'}">
          <span class="skill-vitality-bar"><span style="width:${vitWidth}"></span></span>
          <span class="skill-vitality-score">${vitScore}</span>
        </span>
        <span>${escape(formatRelativeTime(trainedAtTs))}</span>
        ${s.nodeCount ? `<span>· ${s.nodeCount} nodes</span>` : ''}
      </div>
      ${isHidden ? '' : renderSkillAutonomyControl(s.graphId, s.sourceId)}
      <div class="skill-history-panel hidden" data-history-for="${escape(s.sourceId)}"></div>
    </div>
  `;
}

interface SkillVersionEntry {
  sourceId: string;
  snapshotId: string;
  label: string;
  ingestedAt: number;
  nodeCount: number;
  isCurrent: boolean;
  trainedAt?: string;
  mode?: string;
}

// Toggle a skill's "Version history" panel, lazy-loading its snapshot chain.
// Retrain history lives in the snapshot side-table (since in-place retrain),
// so it's fetched on demand rather than carried in the library list.
async function toggleSkillHistory(btn: HTMLElement, sourceId: string, graphId: string): Promise<void> {
  const row = btn.closest('.skill-row');
  const panel = row?.querySelector<HTMLElement>('.skill-history-panel');
  if (!panel) return;
  const opening = panel.classList.contains('hidden');
  btn.setAttribute('aria-expanded', String(opening));
  btn.textContent = opening ? 'History ▾' : 'History ▸';
  if (!opening) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  panel.innerHTML = '<div class="skill-history-empty">Loading version history…</div>';
  try {
    const res = await ipcCall<{ ok: boolean; versions: SkillVersionEntry[] }>('skill:history', { graphId, sourceId });
    panel.innerHTML = renderSkillHistory(res?.versions ?? [], graphId, sourceId);
  } catch (e) {
    console.warn('[skills] history load failed:', e);
    panel.innerHTML = '<div class="skill-history-empty">Couldn\'t load version history.</div>';
  }
}

function renderSkillHistory(versions: SkillVersionEntry[], graphId: string, sourceId: string): string {
  if (versions.length <= 1) {
    return '<div class="skill-history-empty">No earlier versions yet — this skill hasn\'t been retrained.</div>';
  }
  const items = versions.map((v) => {
    const when = formatRelativeTime(parseTrainedAt(v.trainedAt) ?? v.ingestedAt);
    const tag = v.isCurrent ? '<span class="skill-history-current">current</span>' : '';
    const restore = v.isCurrent
      ? ''
      : `<button class="skill-row-action btn-ghost skill-history-restore" data-action="rollback" data-source-id="${escape(sourceId)}" data-graph-id="${escape(graphId)}" data-snapshot-id="${escape(v.snapshotId)}" title="Restore this version as current">Restore</button>`;
    return `<li class="skill-history-item">
      <span class="skill-history-when">${escape(when)}</span>
      ${v.mode ? `<span class="skill-history-mode">${escape(v.mode)}</span>` : ''}
      <span class="skill-history-nodes">${v.nodeCount} nodes</span>
      ${tag}${restore}
    </li>`;
  }).join('');
  return `<ul class="skill-history-list">${items}</ul>`;
}

async function rollbackSkillVersion(sourceId: string, graphId: string, snapshotId: string): Promise<void> {
  if (!window.confirm('Restore this earlier version as the current skill?\n\nThe current version is saved as a snapshot first, so this is reversible.')) return;
  try {
    await ipcCall('skill:rollback', { graphId, sourceId, snapshotId });
    await fetchSkillsLibrary();
    skillsVitalityCache.delete(sourceId);
    renderSkillsLibrary();
    // If this skill is open in the trainer, reload it to show the restored text.
    if (skillsActiveSourceId === sourceId) void openSkillInTrainer(sourceId, graphId);
  } catch (e) {
    console.warn('[skills] rollback failed:', e);
    app().showError(`Could not restore version: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Wipe the compose form back to a blank slate — used by genuinely-fresh
 *  entry points ("+ New skill", deleting the open skill). NOT called from the
 *  retrain path, which switches to compose mode and then repopulates the form
 *  with the trained text. Clears content fields (text + name) and the saved
 *  draft; leaves config prefs (target engram, model, recall breadth) intact. */
function resetSkillsComposeForm(): void {
  const ta = document.getElementById('skills-input-text') as HTMLTextAreaElement | null;
  const nameEl = document.getElementById('skills-input-name') as HTMLInputElement | null;
  if (ta) {
    ta.value = '';
    ta.classList.remove('has-overflow', 'expanded');
    ta.style.height = '';
  }
  if (nameEl) nameEl.value = '';
  const autonomyEl = document.getElementById('skills-input-autonomy') as HTMLSelectElement | null;
  if (autonomyEl) autonomyEl.value = 'inherit';
  clearSkillsDraft();
  renderSkillsChunkPreview();
  updateSkillsResetButton();
}

function showSkillsComposeMode(): void {
  document.getElementById('skills-compose')?.classList.remove('hidden');
  document.getElementById('skills-review')?.classList.add('hidden');
  document.getElementById('skills-license-card')?.classList.add('hidden');
  const title = document.getElementById('skills-trainer-title');
  if (title) {
    title.textContent = 'Train a skill';
    title.contentEditable = 'false';
    title.removeAttribute('data-pres'); // not a saved skill — nothing to redact
    title.removeAttribute('data-pres-engram');
  }
  skillsActiveSourceId = null;
  skillsActiveResult = null;
  renderSkillsLibrary();
  updateSkillsResetButton();
  syncSkillsPreviewWarning();
}

function showSkillsReviewMode(title: string): void {
  document.getElementById('skills-compose')?.classList.add('hidden');
  document.getElementById('skills-review')?.classList.remove('hidden');
  document.getElementById('skills-license-card')?.classList.add('hidden');
  const titleEl = document.getElementById('skills-trainer-title');
  if (titleEl) {
    titleEl.textContent = title;
    titleEl.contentEditable = 'true';
    if (!titleEl.dataset['editBound']) {
      titleEl.dataset['editBound'] = '1';
      titleEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLElement).blur(); }
        if (e.key === 'Escape') { (e.target as HTMLElement).blur(); }
      });
      titleEl.addEventListener('blur', async () => {
        const newTitle = titleEl.textContent?.trim();
        if (!newTitle) return;
        const state = skillsActiveResult;
        if (!state?.skillId || !state?.graphId) return;
        try {
          await invoke('source_rename', { graphId: state.graphId, sourceId: state.skillId, newRef: newTitle });
          // Keep the library row label in sync.
          renderSkillsLibrary();
        } catch (e) {
          console.warn('[skills] title rename failed:', e);
        }
      });
    }
  }
  updateSkillsResetButton();
}

/**
 * Render the Trained Output box.
 *
 * For memory-augmented mode: the skill text is shown as a read-only block,
 * followed by each Personal Context node as a contenteditable entry with a
 * × remove button. This lets the user refine the trained output without
 * navigating to the separate Influential Nodes section (which has been removed).
 *
 * For LLM mode and others: falls back to plain text rendering.
 */
/**
 * Phase 4 — Source-driven Trained Output renderer.
 *
 * When called with `{graphId, skillId}` (the common case from
 * paintSkillsReview after a save or library-open), fetches the source's
 * chunks via `source.listNodes` and renders one editable card per node.
 * Edits round-trip to `node:directEdit`, the × button to
 * `source:removeNode`, drag-drop to `source:reorderNodes`, the hover-only
 * `+` slot to `source:insertNode`. The title card additionally fires
 * `source:rename` on blur so the library row label stays in sync.
 *
 * When called without `{graphId, skillId}` (streaming preview, fallback
 * path), just renders the trained text as plain text — no graph round-trip
 * is possible yet because the source doesn't exist.
 */
/** Plain-text Trained Output for saved skills when the source-driven editor
 *  can't bind (no body chunks yet, or IPC returned title/metadata only). */
function paintTrainedOutputPlain(el: HTMLElement, text: string, skillId?: string, graphId?: string): void {
  el.innerHTML = `<div class="skills-output-base">${escapeHtml(text)}</div>`;
  if (skillId && graphId) {
    el.setAttribute('data-pres', `skill:${skillId}`);
    el.setAttribute('data-pres-engram', graphId);
  } else {
    el.removeAttribute('data-pres');
    el.removeAttribute('data-pres-engram');
  }
  if (app().presActive()) app().applyPresentationMasking();
}

function isStaleTrainedOutputRender(gen?: number): boolean {
  return gen !== undefined && gen !== skillsTrainedOutputGen;
}

function trainedOutputPlainFallback(
  el: HTMLElement,
  skillId: string,
  graphId: string,
  trainedFallback: string,
  gen?: number,
): boolean {
  if (isStaleTrainedOutputRender(gen)) return true;
  const raw = trainedFallback.trim();
  if (!raw) return false;
  const stripped = stripSkillMetadataHeader(raw);
  const text = stripped || raw;
  paintTrainedOutputPlain(el, text, skillId, graphId);
  return true;
}

async function fetchTrainedExportFallback(graphId: string, skillId: string): Promise<string> {
  try {
    const exported = await ipcCall<string | { ok?: boolean }>('skill:export', {
      graphId,
      sourceId: skillId,
      format: 'raw',
    });
    return typeof exported === 'string' ? exported.trim() : '';
  } catch {
    return '';
  }
}

function rerenderTrainedOutputSourceDriven(el: HTMLElement, skillId: string, graphId: string): void {
  void paintTrainedOutputSourceDriven(el, skillId, graphId, {
    trainedFallback: skillsActiveResult?.trained ?? '',
    gen: skillsTrainedOutputGen,
  });
}

async function paintTrainedOutputSourceDriven(
  el: HTMLElement,
  skillId: string,
  graphId: string,
  opts: { trainedFallback?: string; gen?: number } = {},
): Promise<void> {
  const gen = opts.gen;
  const trainedFallback = opts.trainedFallback ?? skillsActiveResult?.trained ?? '';
  type ListNodesResult = { ok: boolean; nodes: Array<{ id: string; content: string; role?: string }> };
  let result: ListNodesResult | null = null;
  try {
    // Same sidecar path as skill:get (ipcCall) — avoids a separate Tauri
    // command hop and keeps chunk fetch aligned with the detail the library
    // row just loaded.
    result = await ipcCall<ListNodesResult>('source.listNodes', { graphId, sourceId: skillId });
  } catch (e) {
    if (isStaleTrainedOutputRender(gen)) return;
    if (trainedOutputPlainFallback(el, skillId, graphId, trainedFallback, gen)) return;
    el.textContent = `Could not load skill chunks: ${(e as Error).message}`;
    return;
  }
  if (isStaleTrainedOutputRender(gen)) return;
  if (!result?.ok) {
    if (trainedOutputPlainFallback(el, skillId, graphId, trainedFallback, gen)) return;
    el.textContent = 'Could not load skill chunks.';
    return;
  }
  // Hide metadata chunks (HTML comments) — they're an internal audit artefact.
  // Title chunks stay out of the numbered card list (slug + date as card #1 was
  // confusing) but we render a static heading below so TRAINED OUTPUT still opens
  // with the skill name before Goals / steps.
  const titleNode = result.nodes.find((n) => (n.role ?? '') === 'title');
  const titleHeading = titleNode
    ? skillFriendlyName(titleNode.content.trim())
    : (document.getElementById('skills-trainer-title')?.textContent?.trim() ?? '');
  const visible = result.nodes.filter((n) => {
    const role = n.role ?? '';
    if (role === 'metadata' || role === 'title') return false;
    if (n.content.trim().startsWith('<!--')) return false;
    return true;
  });

  if (visible.length === 0) {
    if (trainedOutputPlainFallback(el, skillId, graphId, trainedFallback, gen)) return;
    // skill:get runs hollow-source repair — re-fetch when the caller's
    // trainedFallback is empty (interrupted in-place retrain left 0 nodes).
    if (!trainedFallback.trim()) {
      try {
        const detail = await ipcCall<{ text?: string } | null>('skill:get', { graphId, sourceId: skillId });
        if (detail?.text?.trim() && trainedOutputPlainFallback(el, skillId, graphId, detail.text, gen)) return;
      } catch { /* fall through */ }
    }
    // Last resort: join any non-metadata node text (includes title-only skills).
    const joined = result.nodes
      .filter((n) => (n.role ?? '') !== 'metadata' && !n.content.trim().startsWith('<!--'))
      .map((n) => n.content.trim())
      .filter(Boolean)
      .join('\n\n');
    if (joined) {
      if (isStaleTrainedOutputRender(gen)) return;
      paintTrainedOutputPlain(el, joined, skillId, graphId);
      return;
    }
    const exported = await fetchTrainedExportFallback(graphId, skillId);
    if (isStaleTrainedOutputRender(gen)) return;
    if (exported) {
      const text = stripSkillMetadataHeader(exported) || exported;
      paintTrainedOutputPlain(el, text, skillId, graphId);
      return;
    }
    el.textContent =
      'No trained content found for this skill. Training may have been interrupted — use Retrain to rebuild it.';
    return;
  }

  // Detect goal nodes to inject a "Goals" section header before the first one.
  // Fallback regex for older sidecars that don't return a role.
  const GOAL_RE = /^(?:Success:|Out of scope:|On completion:|Trigger:|Prerequisites:|On failure:|Requires:|Produces:)/i;
  let goalHeaderInjected = false;

  // First slot: no preceding card → afterNodeId = '' (sidecar inserts before first visible node)
  const parts: string[] = [];
  if (titleHeading && titleHeading !== 'Training in progress…') {
    parts.push(`<div class="skills-output-title-heading">${escapeHtml(titleHeading)}</div>`);
  }
  parts.push(renderInsertSlotHtml(0, ''));
  let bodyN = 0;
  let goalN = 0;
  for (let i = 0; i < visible.length; i++) {
    const node = visible[i]!;
    const isGoal = node.role ? node.role.startsWith('goal-') : GOAL_RE.test(node.content.trim());
    if (!goalHeaderInjected && isGoal) {
      goalHeaderInjected = true;
      parts.push(`<div class="skills-output-section-header">Goals</div>`);
    }
    // Body steps get numeric labels (1, 2, 3…), goal cards get letter labels (a, b, c…)
    // so AI clients and users can reference them as "step 3" or "goal (b)".
    const label = isGoal ? goalLetterLabel(goalN++) : String(++bodyN);
    parts.push(renderCardHtml(node, i, label, isGoal));
    parts.push(renderInsertSlotHtml(i + 1, node.id));
  }
  if (isStaleTrainedOutputRender(gen)) return;
  el.innerHTML = parts.join('');
  // Presentation Mode: redact this skill's trained output (and its title)
  // unless the skill is allowlisted (or its engram is). Tagging the container
  // masks all chunks at once.
  el.setAttribute('data-pres', `skill:${skillId}`);
  el.setAttribute('data-pres-engram', graphId);
  const titleEl = document.getElementById('skills-trainer-title');
  if (titleEl) { titleEl.setAttribute('data-pres', `skill:${skillId}`); titleEl.setAttribute('data-pres-engram', graphId); }
  if (app().presActive()) app().applyPresentationMasking();
  bindCardInteractions(el, skillId, graphId);
}

/** Generate a, b, …, z, aa, ab, …  for goal-card labels. */
function goalLetterLabel(zeroBasedIndex: number): string {
  let n = zeroBasedIndex;
  let label = '';
  do {
    label = String.fromCharCode(97 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

function renderCardHtml(
  node: { id: string; content: string },
  index: number,
  label: string,
  isGoal: boolean,
): string {
  // Drag is handled via pointer-capture on the handle — no HTML5 draggable needed.
  // The handle-col stacks the step number/letter above the ⋮⋮ grip icon.
  const goalClass = isGoal ? ' skills-output-card--goal' : '';
  return (
    `<div class="skills-output-card${goalClass}" data-node-id="${escapeHtml(node.id)}" data-index="${index}" data-is-goal="${isGoal ? '1' : '0'}">` +
      `<div class="skills-output-handle-col">` +
        `<span class="skills-output-step-num" aria-hidden="true">${escapeHtml(label)}</span>` +
        `<button type="button" class="skills-output-drag-handle" aria-label="Drag to reorder" tabindex="-1">⋮⋮</button>` +
      `</div>` +
      `<div class="skills-output-card-text" contenteditable="true" spellcheck="false">${escapeHtml(node.content)}</div>` +
      `<button type="button" class="skills-output-card-remove" title="Remove this chunk">×</button>` +
    `</div>`
  );
}

// afterNodeId: the nodeId of the card immediately before this slot.
// Empty string = slot is before all cards (insert at beginning of visible content).
function renderInsertSlotHtml(afterIndex: number, afterNodeId: string): string {
  return `<div class="skills-output-insert-slot" data-after-index="${afterIndex}" data-after-node-id="${escapeHtml(afterNodeId)}"></div>`;
}

/**
 * Phase 4b/4c/4d wiring — contenteditable + × + drag + insert.
 *
 * Auto-save model: every mutation hits an IPC, optimistically; on failure
 * we revert from a per-card snapshot stored in WeakMap.
 */
function bindCardInteractions(root: HTMLElement, skillId: string, graphId: string): void {
  const snapshots = new WeakMap<HTMLElement, string>();

  // ── Edits ──────────────────────────────────────────────────────────────
  root.querySelectorAll<HTMLElement>('.skills-output-card').forEach((card) => {
    const text = card.querySelector<HTMLElement>('.skills-output-card-text');
    if (!text) return;
    snapshots.set(card, text.innerText);

    let debounce: number | undefined;
    const flush = async (): Promise<void> => {
      const nodeId = card.dataset['nodeId'];
      if (!nodeId) return;
      const newContent = text.innerText.trim();
      if (!newContent) return;
      const prev = snapshots.get(card) ?? '';
      if (newContent === prev) return;
      try {
        await invoke('node_direct_edit', {
          graphId,
          nodeId,
          content: newContent,
          reason: 'Skills editor: inline edit',
        });
        snapshots.set(card, newContent);
      } catch (e) {
        console.warn('[skills] node_direct_edit failed:', e);
        text.innerText = prev; // revert
      }
    };
    text.addEventListener('input', () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => { void flush(); }, 600);
    });
    text.addEventListener('blur', () => {
      window.clearTimeout(debounce);
      void flush();
    });
  });

  // ── × remove ───────────────────────────────────────────────────────────
  root.querySelectorAll<HTMLButtonElement>('.skills-output-card-remove').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest<HTMLElement>('.skills-output-card');
      if (!card) return;
      const nodeId = card.dataset['nodeId'];
      if (!nodeId) return;
      btn.blur();
      // Optimistic remove. The slot that was directly before the removed card
      // is now adjacent to the slot that was after it — two consecutive slots
      // create a visible gap. Remove the "before" slot; the "after" slot stays
      // and becomes the gap between the previous and next cards.
      const prevSlot = card.previousElementSibling;
      card.remove();
      if (prevSlot?.classList.contains('skills-output-insert-slot')) {
        prevSlot.remove();
      }
      fixUpIndices(root);
      try {
        await invoke('source_remove_node', { graphId, sourceId: skillId, nodeId });
      } catch (e) {
        console.warn('[skills] source_remove_node failed:', e);
        // Re-render to recover (cheap, single IPC).
        rerenderTrainedOutputSourceDriven(root, skillId, graphId);
      }
    });
  });

  // Helper: is a card a goal/constraint node?
  const isGoalCard = (c: HTMLElement): boolean =>
    SKILL_GOAL_CARD_RE.test((c.querySelector('.skills-output-card-text')?.textContent ?? '').trim());

  // ── Pointer-capture reorder (replaces HTML5 DnD — more reliable in Tauri) ─
  root.querySelectorAll<HTMLElement>('.skills-output-card').forEach((card) => {
    const handle = card.querySelector<HTMLElement>('.skills-output-drag-handle');
    if (!handle) return;

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); // prevent button click and text selection
      handle.setPointerCapture(e.pointerId);

      let moved = false;
      let targetCard: HTMLElement | null = null;
      let insertBefore = false;
      const startY = e.clientY;
      const draggingGoal = isGoalCard(card);

      const clearIndicators = (): void => {
        root.querySelectorAll<HTMLElement>('.skills-output-card').forEach((c) => {
          c.classList.remove('drop-target-before', 'drop-target-after');
        });
      };

      const onMove = (ev: PointerEvent): void => {
        if (!moved && Math.abs(ev.clientY - startY) > 5) {
          moved = true;
          card.classList.add('dragging');
          isSkillCardDragging = true;
        }
        if (!moved) return;
        clearIndicators();
        targetCard = null;
        insertBefore = false;
        for (const c of Array.from(root.querySelectorAll<HTMLElement>('.skills-output-card'))) {
          if (c === card) continue;
          // Goal cards stay in the Goals section; step cards stay in the procedure.
          if (draggingGoal !== isGoalCard(c)) continue;
          const rect = c.getBoundingClientRect();
          if (ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
            targetCard = c;
            insertBefore = (ev.clientY - rect.top) < rect.height / 2;
            c.classList.add(insertBefore ? 'drop-target-before' : 'drop-target-after');
            break;
          }
        }
      };

      const onUp = async (): Promise<void> => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.releasePointerCapture(e.pointerId);
        card.classList.remove('dragging');
        isSkillCardDragging = false;
        clearIndicators();
        if (!moved || !targetCard) return;
        if (insertBefore) targetCard.parentNode?.insertBefore(card, targetCard);
        else              targetCard.parentNode?.insertBefore(card, targetCard.nextSibling);
        fixUpIndices(root);
        const newOrder = Array.from(root.querySelectorAll<HTMLElement>('.skills-output-card'))
          .map((c) => c.dataset['nodeId'] ?? '').filter(Boolean);
        try {
          await invoke('source_reorder_nodes', { graphId, sourceId: skillId, newOrder });
        } catch {
          rerenderTrainedOutputSourceDriven(root, skillId, graphId);
        }
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  });

  // ── Insert slot click ──────────────────────────────────────────────────
  root.querySelectorAll<HTMLElement>('.skills-output-insert-slot').forEach((slot) => {
    slot.addEventListener('click', () => {
      // afterNodeId: nodeId of the preceding card, or '' for the first slot.
      const afterNodeId: string | null = slot.dataset['afterNodeId'] === ''
        ? null : (slot.dataset['afterNodeId'] ?? null);

      // Detect whether this slot is inside the Goals section.
      const precedingCard = afterNodeId
        ? root.querySelector<HTMLElement>(`.skills-output-card[data-node-id="${CSS.escape(afterNodeId)}"]`)
        : null;
      const prevHeader = slot.previousElementSibling?.classList.contains('skills-output-section-header');
      const inGoalsSection = prevHeader || (precedingCard ? isGoalCard(precedingCard) : false);

      // Goal prefix chips — shown when inserting inside the Goals section.
      const GOAL_CHIPS: Array<{ label: string; prefix: string }> = [
        { label: '✓ Success', prefix: 'Success: ' },
        { label: '✗ Out of scope', prefix: 'Out of scope: ' },
        { label: '⊙ On completion', prefix: 'On completion: ' },
        { label: '⚡ Trigger', prefix: 'Trigger: ' },
        { label: '🔑 Prerequisites', prefix: 'Prerequisites: ' },
        { label: '⚠ On failure', prefix: 'On failure: ' },
      ];

      const draft = document.createElement('div');
      draft.className = 'skills-output-card skills-output-card--draft';
      const chipsHtml = inGoalsSection
        ? `<div class="skills-draft-goal-chips">${GOAL_CHIPS.map((c) =>
            `<button class="skills-goal-chip" type="button" data-prefix="${escapeHtml(c.prefix)}">${escapeHtml(c.label)}</button>`
          ).join('')}</div>`
        : '';
      const placeholder = inGoalsSection
        ? 'Type goal text, or pick a type above…'
        : 'Type paragraph text…';
      // Green check button — explicit Save action aligned to the right.
      // Mirrors the Enter-to-commit shortcut for users who prefer clicking.
      // mousedown.preventDefault() keeps focus on the editable so the blur
      // handler doesn't race the click — same trick as the chip buttons.
      // Inner row groups the editable + save button so the green check
      // sits to the right of the textarea, while the chips (when present)
      // remain stacked above. The outer draft card uses flex-direction:
      // column for the chips; the inner row uses default row direction.
      draft.innerHTML =
        `${chipsHtml}` +
        `<div class="skills-draft-input-row">` +
          `<div class="skills-output-card-text" contenteditable="true" spellcheck="false" placeholder="${placeholder}"></div>` +
          `<button type="button" class="skills-output-card-save" title="Save this paragraph (or press Enter)" aria-label="Save paragraph">✓</button>` +
        `</div>`;
      slot.after(draft);

      const editable = draft.querySelector<HTMLElement>('.skills-output-card-text');

      /** Strip ALL recognised goal prefixes from the start of the editable,
       *  then prepend the new one. So clicking Trigger after Success
       *  REPLACES "Success:" with "Trigger:" instead of stacking them.
       *
       *  The while-loop (rather than a single match) is defensive: if the
       *  text already starts with multiple stacked prefixes from a prior
       *  build/session (e.g. "Out of scope: On completion: hello"), we
       *  peel ALL of them off, not just the outermost. Without this,
       *  successive clicks could still leave dead inner prefixes behind. */
      const swapGoalPrefix = (newPrefix: string): void => {
        if (!editable) return;
        let body = editable.textContent ?? '';
        let stripped = true;
        while (stripped) {
          stripped = false;
          for (const c of GOAL_CHIPS) {
            if (body.startsWith(c.prefix)) {
              body = body.slice(c.prefix.length);
              stripped = true;
              break;
            }
          }
        }
        editable.textContent = newPrefix + body;
        // Move caret to end after replacement
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(editable);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      };

      // Wire chip clicks — REPLACE the existing prefix (not append a new
      // one on top). Previously the chip handler only prepended when the
      // current prefix didn't already match, which silently stacked
      // prefixes when the user clicked Out of scope → On completion →
      // Trigger and produced "On completion: Trigger: Prerequisites: hello".
      draft.querySelectorAll<HTMLButtonElement>('.skills-goal-chip').forEach((chip) => {
        chip.addEventListener('mousedown', (e) => { e.preventDefault(); });
        chip.addEventListener('click', () => {
          editable?.focus();
          swapGoalPrefix(chip.dataset['prefix'] ?? '');
        });
      });

      editable?.focus();
      let committed = false;
      const commit = async (): Promise<void> => {
        if (committed) return;
        committed = true;
        const content = (editable?.textContent ?? '').trim();
        draft.remove();
        if (!content) return;
        try {
          const res = await invoke<{ ok: boolean; nodeId: string }>('source_insert_node', {
            graphId,
            sourceId: skillId,
            afterNodeId,
            content,
          });
          if (!res?.ok) throw new Error('insert failed');
          rerenderTrainedOutputSourceDriven(root, skillId, graphId);
        } catch (e) {
          console.warn('[skills] source_insert_node failed:', e);
          rerenderTrainedOutputSourceDriven(root, skillId, graphId);
        }
      };
      // Wire the green-check Save button. Same mousedown.preventDefault
      // trick keeps the editable focused so blur-commit doesn't race.
      const saveBtn = draft.querySelector<HTMLButtonElement>('.skills-output-card-save');
      saveBtn?.addEventListener('mousedown', (e) => { e.preventDefault(); });
      saveBtn?.addEventListener('click', () => { void commit(); });

      editable?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void commit(); }
        else if (e.key === 'Escape') { committed = true; draft.remove(); }
      });
      editable?.addEventListener('blur', () => { void commit(); }, { once: true });
    });
  });
}

function fixUpIndices(root: HTMLElement): void {
  let bodyN = 0;
  let goalN = 0;
  root.querySelectorAll<HTMLElement>('.skills-output-card').forEach((c, i) => {
    c.dataset['index'] = String(i);
    const isGoal = c.dataset['isGoal'] === '1';
    const label = isGoal ? goalLetterLabel(goalN++) : String(++bodyN);
    const numEl = c.querySelector<HTMLElement>('.skills-output-step-num');
    if (numEl) numEl.textContent = label;
  });
  root.querySelectorAll<HTMLElement>('.skills-output-insert-slot').forEach((s, i) => {
    s.dataset['afterIndex'] = String(i);
  });
}

/**
 * Legacy entry point — kept so streaming preview callers (which don't
 * have a graphId/sourceId yet) can still paint the box with a plain-text
 * preview. After save completes and paintSkillsReview re-runs with
 * skillId/graphId set, the source-driven renderer takes over.
 */
function paintTrainedOutput(
  el: HTMLElement,
  trained: string,
  _mode: string,
  _nodes: SkillInfluentialNode[],
): void {
  // Preview-mode rendering: the user picked "Preview only — don't save"
  // in the Save-into dropdown, so the train flow assembled the text but
  // didn't persist it. Show that text in a visually distinct, copy-
  // friendly textarea — not the source-driven editor (which expects a
  // real saved sourceId) and not just `textContent` on a plain div
  // (which is selectable but doesn't communicate "this is your scratch
  // result, do something with it now or lose it on the next train").
  //
  // The textarea is editable so the user can tweak before copying. Edits
  // live only in the DOM — closing the panel or training again discards
  // them, exactly matching what the user opted into when they chose
  // Preview mode.
  el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'skills-preview-result';

  const banner = document.createElement('div');
  banner.className = 'skills-preview-banner';
  banner.innerHTML =
    `<span aria-hidden="true">📋</span>` +
    `<span>Preview output — not saved. Copy below, or pick a Skills engram in <em>Saving to</em> above and train again to persist.</span>`;
  wrap.appendChild(banner);

  const textarea = document.createElement('textarea');
  textarea.className = 'skills-preview-textarea';
  textarea.value = trained;
  textarea.spellcheck = false;
  textarea.setAttribute('aria-label', 'Trained skill preview');
  wrap.appendChild(textarea);

  const actions = document.createElement('div');
  actions.className = 'skills-preview-actions';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn-primary btn-sm';
  copyBtn.textContent = 'Copy output';
  copyBtn.addEventListener('click', () => {
    // navigator.clipboard works inside Tauri webviews on all platforms
    // we ship to; fall back to a manual select+execCommand path if the
    // permission is blocked (rare).
    const text = textarea.value;
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        const prev = copyBtn.textContent;
        copyBtn.textContent = '✓ Copied';
        copyBtn.disabled = true;
        setTimeout(() => {
          copyBtn.textContent = prev ?? 'Copy output';
          copyBtn.disabled = false;
        }, 1400);
      } catch {
        textarea.select();
        try { document.execCommand('copy'); } catch { /* ignore */ }
      }
    })();
  });
  actions.appendChild(copyBtn);

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'btn-ghost btn-sm';
  selectAllBtn.textContent = 'Select all';
  selectAllBtn.addEventListener('click', () => {
    textarea.focus();
    textarea.setSelectionRange(0, textarea.value.length);
  });
  actions.appendChild(selectAllBtn);
  wrap.appendChild(actions);

  el.appendChild(wrap);
}

// Legacy dead-code block removed in Phase 4a — the rich Personal Context
// editor with goal badges, per-paragraph "_(from X)_" attribution lines,
// and the contenteditable + × remove handlers has been replaced by the
// source-driven editor (paintTrainedOutputSourceDriven + bindCardInteractions).
// Phase 4a — removed legacy paintTrainedOutput dead body, bindTrainedOutputNodes,
// and rebuildTrainedFromOutput. The source-driven editor above is the only
// renderer now. Stubs are kept for the few remaining call sites in the file
// so they degrade to no-ops instead of throwing.
function rebuildTrainedFromOutput(_el: HTMLElement): void { /* no-op: state lives in graph */ }

function paintSkillsReview(result: SkillTrainResult, opts: {
  graphId?: string;
  sourceId?: string;
  engramName?: string;
  /** Baseline override — defaults to result.original (the user's input).
   *  When opening a saved skill from the library, the caller passes the
   *  previous saved version here so the diff compares against history. */
  baselineText?: string;
  baselineLabel?: string;
} = {}): void {
  const trainedOutputGen = ++skillsTrainedOutputGen;
  skillsActiveResult = {
    trained: result.trained,
    ...(result.diffNotes !== undefined ? { diffNotes: result.diffNotes } : {}),
    influentialNodes: result.influentialNodes ?? [],
    ...(result.mode !== undefined ? { mode: result.mode } : {}),
    ...(result.skillId !== undefined ? { skillId: result.skillId } : opts.sourceId ? { skillId: opts.sourceId } : {}),
    ...(opts.graphId !== undefined ? { graphId: opts.graphId } : {}),
    baselineText: opts.baselineText ?? result.original,
    baselineLabel: opts.baselineLabel ?? 'your input',
  };
  // Mode chip
  const modeEl = document.getElementById('skills-review-mode');
  if (modeEl) modeEl.textContent = `mode: ${result.mode}`;
  // Vitality chip — paint from cache if we have one for this skill.
  const vitEl = document.getElementById('skills-review-vitality');
  const cached = opts.sourceId ? skillsVitalityCache.get(opts.sourceId)?.value : null;
  const hasSavedSkill = result.skillId !== undefined || opts.sourceId !== undefined;
  if (vitEl) {
    vitEl.textContent = cached ? `↻ vitality: ${Math.round(cached.score)}` : '↻ vitality: just trained';
    vitEl.classList.toggle('hidden', !hasSavedSkill);
  }
  // Engram chip
  const engEl = document.getElementById('skills-review-engram');
  if (engEl) engEl.textContent = opts.engramName ?? '—';
  // Degraded note (memory-augmented fallback)
  const deg = document.getElementById('skills-degraded-note');
  if (deg) {
    if (result.degradedNote) {
      deg.textContent = result.degradedNote;
      deg.classList.remove('hidden');
    } else {
      deg.classList.add('hidden');
    }
  }
  // Trained output — rich rendering for memory-augmented (editable PC nodes),
  // plain text for LLM mode.
  const out = document.getElementById('skills-review-output') as HTMLElement | null;
  if (out) {
    // Phase 4a — prefer the source-driven editor when we have a saved
    // source to bind to. Falls back to plain-text preview during streaming
    // or for unsaved previews where there is no graph node yet.
    const sourceForRender = result.skillId ?? opts.sourceId;
    const graphForRender = opts.graphId;
    if (sourceForRender && graphForRender) {
      void paintTrainedOutputSourceDriven(out, sourceForRender, graphForRender, {
        trainedFallback: result.trained,
        gen: trainedOutputGen,
      });
    } else {
      paintTrainedOutput(out, result.trained, result.mode ?? '', result.influentialNodes ?? []);
    }
    // Reset the output box scroll position so the user always sees the
    // beginning of the trained text when switching between skills.
    requestAnimationFrame(() => { out.scrollTop = 0; });
  }
  // Diff notes (LLM mode only)
  const diffWrap = document.getElementById('skills-review-diff-wrap');
  const diffEl = document.getElementById('skills-review-diff');
  if (diffWrap && diffEl) {
    if (result.diffNotes) {
      diffEl.textContent = result.diffNotes;
      diffWrap.classList.remove('hidden');
    } else {
      diffWrap.classList.add('hidden');
    }
  }
  // Export format default
  const formatSel = document.getElementById('skills-export-format') as HTMLSelectElement | null;
  if (formatSel) formatSel.value = recallSkillExportFormat(opts.sourceId);
  const exportStatus = document.getElementById('skills-export-status');
  if (exportStatus) exportStatus.textContent = '';
  // Refresh the inline GSK-Pro hint to match current license state.
  void syncSkillsExportProHint();
  // Retrain schedule — fetch the current config for this skill and paint
  // the controls. Pro-gated; will lock the inputs for free users.
  void paintRetrainSchedule();
  // Pending-proposal card — if a preview-first proposal exists for this
  // skill, render it inline so the user can accept/reject before doing
  // anything else.
  paintPendingProposal();
  // On a fresh training result with meaningful changes, auto-switch to
  // the diff view and run the reveal animation so the user sees what
  // Ghampus actually changed. Library-row opens (no original yet) and
  // no-op trainings (output === baseline) stay on the Output view.
  //
  // Preview-mode trains (no saved skillId / sourceId) have nothing
  // meaningful to diff against — the "original" is just the user's input
  // text and the "trained" is input + Personal Context block. Showing the
  // diff in that case hides the newly-rendered preview textarea behind
  // the diff panel; the user opted into preview specifically to get the
  // output, so stay on the Output view.
  const isSaved = result.skillId !== undefined || opts.sourceId !== undefined;
  const hasChanges = !!result.original && result.trained !== result.original;
  const diffAvailable = !!document.getElementById('skills-review-diff-output');
  if (hasChanges && result.original && isSaved && diffAvailable) {
    setOutputView('diff');
    renderDiffView({ animate: true });
  } else {
    setOutputView('output');
    renderDiffView();
  }
  updateSkillsResetButton();
}

/** Switch the trained-output panel between the plain text view and the
 *  diff view. Both elements live in the DOM at the same time; we just
 *  flip the hidden class so the toggle has no perceptible lag. */
function setOutputView(view: 'output' | 'diff'): void {
  const diffEl = document.getElementById('skills-review-diff-output');
  // The Output/Changes toggle + diff panel were removed from index.html during
  // the SOP editor pass — when those nodes aren't in the DOM, never hide the
  // trained-output box or the user sees an empty "Trained output" section.
  if (!diffEl) view = 'output';
  skillsOutputView = view;
  const outEl = document.getElementById('skills-review-output');
  const metaEl = document.getElementById('skills-review-diff-meta');
  outEl?.classList.toggle('hidden', view !== 'output');
  diffEl?.classList.toggle('hidden', view !== 'diff');
  metaEl?.classList.toggle('hidden', view !== 'diff');
  document.querySelectorAll<HTMLButtonElement>('.skills-output-toggle-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset['view'] === view);
  });
}

// Index of the hunk currently highlighted via < > navigation. Reset on
// each renderDiffView() call.
let skillsDiffActiveHunk = 0;

/** Render the diff view from skillsActiveResult.baselineText →
 *  skillsActiveResult.trained. Called whenever the active result changes
 *  (paintSkillsReview) so the diff stays in sync.
 *
 *  When `opts.animate` is true (fresh training completion), each hunk
 *  fades in with a staggered delay so the user feels Ghampus applying
 *  changes one at a time. When false (manual toggle), the diff just
 *  renders statically. */
function renderDiffView(opts: { animate?: boolean } = {}): void {
  const diffEl = document.getElementById('skills-review-diff-output');
  const navEl = document.getElementById('skills-review-diff-nav');
  const metaEl = document.getElementById('skills-review-diff-meta');
  const cursorEl = document.getElementById('skills-review-diff-cursor');
  const prevBtn = document.getElementById('btn-skills-diff-prev') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('btn-skills-diff-next') as HTMLButtonElement | null;
  if (!diffEl || !navEl || !metaEl) return;
  const active = skillsActiveResult;
  if (!active || !active.baselineText || active.baselineText === active.trained) {
    // Distinguish the cases for the user — empty diff has multiple causes
    // and a generic message hides which one applies.
    const noBaseline = !active?.baselineText;
    const identical  = !!active?.baselineText && active.baselineText === active.trained;
    const message = noBaseline
      ? 'No previous version to compare against yet. Click <strong>Retrain</strong> above to produce a new version — the diff will then show what changed.'
      : identical
        ? 'No changes — the trained output is identical to the baseline (<em>' + escape(active?.baselineLabel ?? 'baseline') + '</em>). Retraining didn\'t alter the text this round.'
        : 'No changes to display.';
    diffEl.innerHTML = `<span class="skills-diff-line-meta" style="display:block;padding:8px 4px;line-height:1.5;">${message}</span>`;
    navEl.classList.add('hidden');
    metaEl.textContent = '';
    return;
  }
  const { html, hunkCount, addedLines, removedLines } = renderLineDiff(active.baselineText, active.trained);
  diffEl.classList.toggle('no-animate', !opts.animate);
  diffEl.innerHTML = html;
  // Concrete summary first ("+12 / −0 across 1 block"), then a one-line
  // legend. Free / memory-augmented mode gets an extra sentence pointing
  // out that the change is Personal Context appended at the end —
  // otherwise users see "1 block" and don't realise the meaningful
  // change is the giant block of recalled memories at the bottom.
  const summary = `+${addedLines} added · −${removedLines} removed · ${hunkCount} change block(s) vs ${active.baselineLabel ?? 'baseline'}.`;
  const legend = 'Green = added by Ghampus. Red = removed.';
  const memoryAugmentedHint = active.mode === 'memory-augmented'
    ? ' Ghampus appended a Personal Context block from your engrams at the end of the skill — use the › arrow above the changes to jump straight to it.'
    : '';
  metaEl.textContent = `${summary} ${legend}${memoryAugmentedHint}`;
  if (hunkCount === 0) {
    navEl.classList.add('hidden');
    return;
  }
  navEl.classList.remove('hidden');
  skillsDiffActiveHunk = 0;
  updateDiffCursor(hunkCount);
  // After the reveal animation finishes, auto-scroll to the first hunk.
  // 280ms × hunkCount + 60ms buffer = approximate total reveal duration.
  const revealDoneMs = opts.animate ? Math.min(hunkCount * 90 + 280, 2400) : 0;
  setTimeout(() => { focusDiffHunk(0); }, revealDoneMs);
  if (prevBtn) prevBtn.disabled = false;
  if (nextBtn) nextBtn.disabled = false;
  if (!cursorEl) return;
}

function updateDiffCursor(total: number): void {
  const cursor = document.getElementById('skills-review-diff-cursor');
  if (!cursor) return;
  cursor.textContent = total === 0 ? '0 / 0' : `${skillsDiffActiveHunk + 1} / ${total}`;
}

function focusDiffHunk(index: number): void {
  const hunks = document.querySelectorAll<HTMLElement>('#skills-review-diff-output .skills-diff-hunk');
  if (hunks.length === 0) return;
  const safeIdx = Math.max(0, Math.min(index, hunks.length - 1));
  skillsDiffActiveHunk = safeIdx;
  hunks.forEach((el, i) => el.classList.toggle('skills-diff-hunk-active', i === safeIdx));
  const target = hunks[safeIdx];
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  updateDiffCursor(hunks.length);
}

function stepDiffHunk(direction: 1 | -1): void {
  const hunks = document.querySelectorAll<HTMLElement>('#skills-review-diff-output .skills-diff-hunk');
  if (hunks.length === 0) return;
  const next = (skillsDiffActiveHunk + direction + hunks.length) % hunks.length;
  focusDiffHunk(next);
}

/** Line-based diff. Computes a longest-common-subsequence over the lines
 *  of `a` and `b`, then emits one chunk per line tagged add / del / ctx.
 *  Lines are HTML-escaped. Returns an HTML string ready to assign to
 *  innerHTML.
 *
 *  This is intentionally simple: line granularity is more than enough
 *  for skill-text diffs (lines are how skills are usually structured —
 *  bullet points, paragraphs, sections). Token-level inside a line is
 *  out of scope; if a line is "changed" it shows as one removed + one
 *  added line, which reads cleanly. */
function renderLineDiff(a: string, b: string): { html: string; hunkCount: number; addedLines: number; removedLines: number } {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  // LCS table — bounded O(n*m); for typical skill texts (<500 lines)
  // this is microseconds.
  const n = aLines.length;
  const m = bLines.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (aLines[i - 1] === bLines[j - 1]) {
        lcs[i]![j] = (lcs[i - 1]![j - 1] ?? 0) + 1;
      } else {
        lcs[i]![j] = Math.max(lcs[i - 1]![j] ?? 0, lcs[i]![j - 1] ?? 0);
      }
    }
  }
  // Walk back through the LCS table to produce the chunk list, then
  // reverse so we render top-to-bottom.
  type Chunk = { kind: 'add' | 'del' | 'ctx'; text: string };
  const chunks: Chunk[] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (aLines[i - 1] === bLines[j - 1]) {
      chunks.push({ kind: 'ctx', text: aLines[i - 1] ?? '' });
      i--; j--;
    } else if ((lcs[i - 1]![j] ?? 0) >= (lcs[i]![j - 1] ?? 0)) {
      chunks.push({ kind: 'del', text: aLines[i - 1] ?? '' });
      i--;
    } else {
      chunks.push({ kind: 'add', text: bLines[j - 1] ?? '' });
      j--;
    }
  }
  while (i > 0) { chunks.push({ kind: 'del', text: aLines[i - 1] ?? '' }); i--; }
  while (j > 0) { chunks.push({ kind: 'add', text: bLines[j - 1] ?? '' }); j--; }
  chunks.reverse();
  // Group consecutive non-context lines into hunks. Each hunk gets its
  // own .skills-diff-hunk wrapper so the < > nav can scroll to them
  // and the staggered reveal animation can target each one.
  type Hunk = Chunk[];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  const grouped: Array<{ kind: 'hunk'; lines: Hunk } | { kind: 'ctx'; text: string }> = [];
  for (const c of chunks) {
    if (c.kind === 'ctx') {
      if (current) { hunks.push(current); grouped.push({ kind: 'hunk', lines: current }); current = null; }
      grouped.push({ kind: 'ctx', text: c.text });
    } else {
      if (!current) current = [];
      current.push(c);
    }
  }
  if (current) { hunks.push(current); grouped.push({ kind: 'hunk', lines: current }); }
  // Build the HTML. Each hunk's lines get a per-line animation delay
  // computed from its position so the reveal staggers naturally —
  // hunks 0..N appear in sequence; lines within a hunk appear together.
  let hunkIndex = 0;
  const html = grouped.map((g) => {
    if (g.kind === 'ctx') {
      const text = g.text === '' ? '&nbsp;' : escape(g.text);
      return `<span class="skills-diff-line-ctx">  ${text}</span>`;
    }
    const delay = hunkIndex * 90;
    const lines = g.lines.map((c) => {
      const text = c.text === '' ? '&nbsp;' : escape(c.text);
      const style = `animation-delay: ${delay}ms`;
      if (c.kind === 'add') return `<span class="skills-diff-line-add" style="${style}">+ ${text}</span>`;
      return `<span class="skills-diff-line-del" style="${style}">− ${text}</span>`;
    }).join('');
    hunkIndex++;
    return `<span class="skills-diff-hunk" data-hunk-index="${hunkIndex - 1}">${lines}</span>`;
  }).join('');
  // Aggregate line counts so the meta line can surface concrete numbers
  // ("+12 / −0") instead of vague "Green = added".
  let addedLines = 0;
  let removedLines = 0;
  for (const c of chunks) {
    if (c.kind === 'add') addedLines++;
    else if (c.kind === 'del') removedLines++;
  }
  return { html, hunkCount: hunks.length, addedLines, removedLines };
}

function paintPendingProposal(): void {
  const card = document.getElementById('skills-pending-card');
  const metaEl = document.getElementById('skills-pending-meta');
  const previewEl = document.getElementById('skills-pending-preview');
  if (!card || !metaEl || !previewEl) return;
  const sourceId = skillsActiveResult?.skillId;
  if (!sourceId) {
    card.classList.add('hidden');
    return;
  }
  const proposal = skillsRetrainPending[sourceId];
  if (!proposal) {
    card.classList.add('hidden');
    return;
  }
  const when = new Date(proposal.proposedAt).toLocaleString();
  metaEl.textContent = `Proposed ${when} via ${proposal.triggerReason}. The current saved version is untouched until you accept this proposal.`;
  previewEl.textContent = proposal.trained;
  card.classList.remove('hidden');
}

async function acceptPendingProposal(): Promise<void> {
  const sourceId = skillsActiveResult?.skillId;
  if (!sourceId) return;
  try {
    const result = await ipcCall<{ ok?: boolean; reason?: string; message?: string }>('skill:acceptProposal', { sourceId });
    if (!result?.ok) {
      showSkillsToast(`Accept failed: ${result?.reason ?? 'unknown'}`, 'error');
      return;
    }
    delete skillsRetrainPending[sourceId];
    paintPendingProposal();
    // Refresh library so badges + the trained-version are current.
    await fetchSkillsLibrary();
    renderSkillsLibrary();
    showSkillsToast('Auto-retrain accepted — new version live.', 'success');
  } catch (e) {
    console.warn('[skills] acceptProposal failed', e);
    showSkillsToast('Accept failed.', 'error');
  }
}

async function rejectPendingProposal(): Promise<void> {
  const sourceId = skillsActiveResult?.skillId;
  if (!sourceId) return;
  try {
    await ipcCall<{ ok?: boolean }>('skill:rejectProposal', { sourceId });
    delete skillsRetrainPending[sourceId];
    paintPendingProposal();
    renderSkillsLibrary();
    showSkillsToast('Proposal rejected — current version unchanged.', 'success');
  } catch (e) {
    console.warn('[skills] rejectProposal failed', e);
    showSkillsToast('Reject failed.', 'error');
  }
}

/**
 * Remove one influential node from the active result and rebuild the
 * trained output when the mode supports it (memory-augmented path).
 *
 * For the memory-augmented path, trained = baselineText + personalBlock.
 * The personalBlock is assembled from influentialNodes, so removing a node
 * and rebuilding gives an accurate result. For the LLM path, the node's
 * contribution is woven into prose we can't easily unpick — we remove the
 * node from the display but leave the trained text unchanged.
 */
function removeInfluentialNode(nodeId: string): void {
  if (!skillsActiveResult) return;
  skillsActiveResult.influentialNodes = (skillsActiveResult.influentialNodes ?? [])
    .filter((n) => n.nodeId !== nodeId);

  // Sync the rich output box — remove the node's entry directly from the DOM.
  const out = document.getElementById('skills-review-output') as HTMLElement | null;
  if (out) {
    const nodeEl = out.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
    nodeEl?.remove();
    rebuildTrainedFromOutput(out);
  }
}

function renderInfluentialNode(n: SkillInfluentialNode): string {
  const short = n.nodeId.length > 10 ? n.nodeId.slice(0, 8) + '…' : n.nodeId;
  const layer = n.layer ? `<span class="skills-node-layer">${escape(n.layer)}</span>` : '';
  const src = n.sourceLabel ? `<span class="skills-node-source">${escape(n.sourceLabel)}</span>` : '';
  const goalBadge = n.goalAlignment
    ? `<span class="skills-node-goal" title="This memory matches your skill goals">${
        n.goalAlignment === 'success' ? '✓ goal: success'
        : n.goalAlignment === 'scope' ? '✗ goal: scope'
        : '⊙ goal: completion'
      }</span>`
    : '';
  // Normalise score: anchored=99, gnn-expanded=1.5+, semantic=0–1.
  // Render anchored/gnn nodes as 100% / their rounded integer; semantic as percentage.
  const displayScore = n.score >= 90 ? '100%'
    : n.score > 1 ? `${Math.round(n.score * 10) / 10}×`
    : `${(n.score * 100).toFixed(0)}%`;
  return `
    <div class="skills-node-card">
      <div class="skills-node-card-header">
        <span class="skills-node-id">${escape(short)}</span>
        <span class="skills-node-score">${displayScore}</span>
        ${layer}
        ${goalBadge}
        ${src}
        <button type="button" class="skills-node-remove btn-ghost" data-remove-node="${escape(n.nodeId)}" title="Remove this node from the trained output">×</button>
      </div>
      <div class="skills-node-preview">${escape(n.preview)}</div>
    </div>
  `;
}

/** Sentinel: prevents a second openSkillInTrainer for the same sourceId while
 *  a first one is still mid-IPC. Without this, a user repeatedly clicking a
 *  slow-loading skill stacks N "Failed to load" toasts. */
let _openSkillInFlight: string | null = null;

export async function openSkillInTrainer(
  sourceId: string,
  graphId: string,
  opts: { retrain?: boolean; scrollToExport?: boolean } = {},
): Promise<void> {
  // Click-dedup: ignore repeat clicks for the same sourceId while we're
  // still loading. The user can still click a DIFFERENT skill.
  if (_openSkillInFlight === sourceId) return;
  _openSkillInFlight = sourceId;
  skillsActiveSourceId = sourceId;
  updateSkillsResetButton();

  // Show a thin indeterminate progress bar if the skill hasn't loaded within 350ms.
  const loadBar = document.getElementById('skills-load-bar');
  const loadBarTimer = window.setTimeout(() => loadBar?.classList.remove('hidden'), 350);
  const hideLoadBar = (): void => {
    window.clearTimeout(loadBarTimer);
    loadBar?.classList.add('hidden');
  };

  scrollSkillsPaneToTop();
  // Make the skill's home engram the active engram (top-right picker, recall
  // scope, etc.) — but only if it's not already active, to avoid the heavy
  // atlas-reset / data-reload path on the no-op case. switchActiveEngram
  // never changes the current tab on its own, so the user stays in the
  // Skills view.
  if (graphId && app().getAtlasActiveGraph() !== graphId) {
    try {
      await app().switchActiveEngram(graphId);
    } catch (e) {
      console.warn('[skills] switchActiveEngram failed', e);
    }
  }
  // Clear the 🆕 notification when the user actually opens the skill —
  // this is the "acknowledge" moment for `notify` autonomy.
  if (skillsRetrainNotifications.has(sourceId)) {
    skillsRetrainNotifications.delete(sourceId);
    void ipcCall('skill:clearNotification', { sourceId }).catch(() => {});
  }
  // Class-only swap instead of a full library re-render — moves the .active
  // highlight onto the clicked row without rebuilding the recursive tree.
  // Saves O(total skills) of DOM work on every click; the perceived click
  // → highlight latency was the most visible part of the open-skill delay.
  document.querySelectorAll<HTMLElement>('.skill-row.active, .skill-child-row.active')
    .forEach((el) => el.classList.remove('active'));
  const escapedSid = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(sourceId) : sourceId.replace(/"/g, '\\"');
  document.querySelector<HTMLElement>(
    `.skill-row[data-source-id="${escapedSid}"], .skill-child-row[data-source-id="${escapedSid}"]`,
  )?.classList.add('active');
  // Immediately scroll the trainer column to its own top so the skill name,
  // mode chips, and Vitality button are visible as soon as the panel opens.
  // The trainer is a sticky independently-scrolling column — its scrollTop
  // is separate from .app-canvas, so we reset it here on every selection.
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('.skills-trainer')?.scrollTo({ top: 0 });
  });
  try {
    const detail = await ipcCall<SkillDetail | null>('skill:get', { graphId, sourceId });
    if (!detail) {
      showSkillsToast('Could not load that skill.', 'error');
      return;
    }
    if (opts.retrain) {
      // Drop straight back into compose with the trained text as the new input.
      showSkillsComposeMode();

      // Show skill name in the panel title so the user always knows which
      // skill they're retraining without having to remember from the list.
      const retrainName = skillFriendlyName(detail.label) || 'skill';
      const titleEl = document.getElementById('skills-trainer-title');
      if (titleEl) titleEl.textContent = `Train a skill: ${retrainName}`;

      // Strip the metadata header that trainSkill() / saveFallback() prepend
      // before populating the textarea — the user should see their original
      // skill instruction text, not the raw stored form with the title +
      // metadata comment on top. Matches both the legacy "# label" ATX
      // format and the new "**label**" bold format.
      const cleanedText = detail.text
        .replace(/^(?:#[^\n]+|\*\*[^\n]+\*\*)\n+<!--[\s\S]*?-->\n+/, '')
        .trim();
      (document.getElementById('skills-input-text') as HTMLTextAreaElement | null)!.value = cleanedText;
      updateSkillsResetButton(); // compose populated — reveal "+ New skill"
      const nameInput = document.getElementById('skills-input-name') as HTMLInputElement | null;
      if (nameInput) nameInput.value = retrainName;
      const engSel = document.getElementById('skills-input-engram') as HTMLSelectElement | null;
      if (engSel) engSel.value = detail.graphId;
      syncSkillsPreviewWarning();
      if (typeof detail.recallBreadth === 'number') {
        const breadth = document.getElementById('skills-input-breadth') as HTMLInputElement | null;
        const live = document.getElementById('skills-input-breadth-live');
        if (breadth) breadth.value = String(detail.recallBreadth);
        if (live) live.textContent = String(detail.recallBreadth);
      }

      // Populate goal fields from the stored skill text.
      const parsedGoals = (detail as { goals?: {
        successLooksLike?: string;
        outOfScope?: string;
        expectedOnCompletion?: string;
        trigger?: string;
        prerequisites?: string;
        onFailure?: string;
        requires?: string;
        produces?: string;
      } }).goals;
      const setGoalField = (id: string, val: string | undefined): void => {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) el.value = val ?? '';
      };
      setGoalField('skills-goal-success',  parsedGoals?.successLooksLike);
      setGoalField('skills-goal-scope',    parsedGoals?.outOfScope);
      setGoalField('skills-goal-done',     parsedGoals?.expectedOnCompletion);
      setGoalField('skills-goal-trigger',  parsedGoals?.trigger);
      setGoalField('skills-goal-prereq',   parsedGoals?.prerequisites);
      setGoalField('skills-goal-failure',  parsedGoals?.onFailure);
      setGoalField('skills-goal-requires', parsedGoals?.requires);
      setGoalField('skills-goal-produces', parsedGoals?.produces);

      // Scroll to the top of the skills pane so the title and Skill Text
      // field are immediately visible — avoids the user landing mid-form
      // and not seeing the context for what they're retraining.
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.skills-trainer')
          ?.closest<HTMLElement>('.app-canvas, .studio-scroll, .skills-panel')
          ?.scrollTo({ top: 0, behavior: 'smooth' });
        document.getElementById('skills-trainer-title')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });

      return;
    }
    // Default: open into Review mode with the stored skill text as the trained output.
    setOutputView('output');
    showSkillsReviewMode(skillFriendlyName(detail.label));
    paintSkillsReview(
      {
        original: detail.text,
        trained: detail.text,
        influentialNodes: [], // Stored skills don't carry their influentialNodes; re-train to populate.
        mode: (detail.mode as 'llm' | 'memory-augmented') ?? 'memory-augmented',
        ...(detail.sourceId !== undefined ? { skillId: detail.sourceId } : {}),
      },
      {
        graphId: detail.graphId,
        sourceId: detail.sourceId,
        engramName: detail.engramName,
        // Diff baseline for history browsing — async-fetched below; until
        // it resolves the diff falls back to "no previous version", which
        // renders as the friendly "No changes" message.
      },
    );
    // Fetch this skill's version history in parallel — if there's a prior
    // version, use it as the diff baseline so the user sees what changed
    // between the previous saved version and the one they're viewing now.
    void (async () => {
      try {
        // History under the in-place model: every entry shares the same
        // sourceId; non-current entries carry a non-empty snapshotId.
        // Newest first — index 0 is the live source, index 1 the most
        // recent snapshot. That's our diff baseline.
        const history = await ipcCall<Array<{
          sourceId: string;
          snapshotId: string;
          label: string;
          ingestedAt: number;
          isCurrent: boolean;
        }>>('skill:getHistory', { graphId: detail.graphId, sourceId: detail.sourceId });
        if (!history || history.length < 2) return;
        const prev = history.find((v) => !v.isCurrent && v.snapshotId);
        if (!prev) return;
        const prevDetail = await ipcCall<{ text: string; ts: number } | null>('skill:getSnapshot', {
          graphId: detail.graphId,
          sourceId: detail.sourceId,
          snapshotId: prev.snapshotId,
        });
        if (!prevDetail || !skillsActiveResult) return;
        const dateStr = new Date(prevDetail.ts).toLocaleDateString();
        skillsActiveResult.baselineText = prevDetail.text;
        skillsActiveResult.baselineLabel = `previous version (${dateStr})`;
        renderDiffView();
      } catch (e) {
        console.warn('[skills] history fetch failed', e);
      }
    })();
    if (opts.scrollToExport) {
      // `block: 'nearest'` scrolls the minimum needed to reveal the export
      // controls — and nothing at all if they're already visible. The old
      // `block: 'center'` forced the control to the viewport center, which
      // over-scrolled the page and dragged the lazily-rendered "Solo
      // Memories" deck (which sits below the whole studio) into view
      // half-painted. Defer to the next frame so the review panel has
      // finished rendering before we measure scroll position.
      requestAnimationFrame(() => {
        document.getElementById('skills-export-format')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  } catch (e) {
    console.warn('[skills] skill:get failed', e);
    const msg = e instanceof Error ? e.message : String(e);
    // Distinguish "engram still loading" from real failures so the user
    // knows whether to wait or to investigate. Background loads can leave a
    // skill engram pending for several seconds on big cortexes.
    const stillLoading = msg.includes('not loaded') || msg.includes('not yet loaded') || msg.includes('cortex is locked');
    if (stillLoading) {
      showSkillsToast('Its engram is still loading — try again in a moment.', 'error');
    } else {
      showSkillsToast('Failed to load skill.', 'error');
    }
  } finally {
    hideLoadBar();
    if (_openSkillInFlight === sourceId) _openSkillInFlight = null;
    updateSkillsResetButton();
  }
}

function readSkillsComposeForm(): {
  skill: string;
  graphId: string;
  skillName?: string;
  focusGraphIds?: string[];
  modelTarget?: string;
  save?: boolean;
  recallBreadth?: number | null;
  goals?: {
    successLooksLike: string;
    outOfScope: string;
    expectedOnCompletion: string;
    trigger?: string;
    prerequisites?: string;
    onFailure?: string;
    requires?: string;
    produces?: string;
  };
} | null {
  const skill = (document.getElementById('skills-input-text') as HTMLTextAreaElement | null)?.value.trim() ?? '';
  const rawTarget = (document.getElementById('skills-input-engram') as HTMLSelectElement | null)?.value ?? '';
  if (!skill) {
    showSkillsToast('Paste a skill to train.', 'error');
    return null;
  }
  // "Preview only" sentinel: trainer still runs (recall + LLM rewrite +
  // influential nodes), but the result is not saved into any engram.
  // We still need a real graphId for the recall step — fall back to the
  // currently-active engram, or the first loaded engram. If nothing is
  // loaded at all, the trainer can't run.
  const isPreview = rawTarget === '__preview__';
  let graphId = rawTarget;
  let save = true;
  if (isPreview) {
    save = false;
    const fallback = app().getAtlasActiveGraph()
      ?? getLoadedGraphs().find((g) => !g.metadata.archived && g.loaded !== false)?.graphId;
    if (!fallback) {
      showSkillsToast('No engrams loaded — can\'t run recall for preview.', 'error');
      return null;
    }
    graphId = fallback;
  }
  if (!graphId) {
    showSkillsToast('Pick a target engram.', 'error');
    return null;
  }
  const skillName = (document.getElementById('skills-input-name') as HTMLInputElement | null)?.value.trim() || undefined;
  const focusContainer = document.getElementById('skills-input-focus') as HTMLDivElement | null;
  const focusGraphIds = focusContainer
    ? Array.from(focusContainer.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'))
        .map((c) => c.value)
        .filter((v) => v !== graphId)
    : [];
  const modelTarget = (document.getElementById('skills-input-model') as HTMLSelectElement | null)?.value || undefined;
  const breadthStr = (document.getElementById('skills-input-breadth') as HTMLInputElement | null)?.value;
  const breadth = breadthStr === undefined || breadthStr === '' ? null : Number.parseInt(breadthStr, 10);
  const goalSuccess  = (document.getElementById('skills-goal-success')  as HTMLInputElement | null)?.value.trim() || undefined;
  const goalScope    = (document.getElementById('skills-goal-scope')    as HTMLInputElement | null)?.value.trim() || undefined;
  const goalDone     = (document.getElementById('skills-goal-done')     as HTMLInputElement | null)?.value.trim() || undefined;
  const goalTrigger  = (document.getElementById('skills-goal-trigger')  as HTMLInputElement | null)?.value.trim() || undefined;
  const goalPrereq   = (document.getElementById('skills-goal-prereq')   as HTMLInputElement | null)?.value.trim() || undefined;
  const goalFailure  = (document.getElementById('skills-goal-failure')  as HTMLInputElement | null)?.value.trim() || undefined;
  const goalRequires = (document.getElementById('skills-goal-requires') as HTMLInputElement | null)?.value.trim() || undefined;
  const goalProduces = (document.getElementById('skills-goal-produces') as HTMLInputElement | null)?.value.trim() || undefined;
  const anyGoal = goalSuccess || goalScope || goalDone || goalTrigger || goalPrereq || goalFailure || goalRequires || goalProduces;
  const goals = anyGoal
    ? {
        successLooksLike:     goalSuccess  ?? '',
        outOfScope:           goalScope    ?? '',
        expectedOnCompletion: goalDone     ?? '',
        ...(goalTrigger  ? { trigger:       goalTrigger  } : {}),
        ...(goalPrereq   ? { prerequisites: goalPrereq   } : {}),
        ...(goalFailure  ? { onFailure:     goalFailure  } : {}),
        ...(goalRequires ? { requires:      goalRequires } : {}),
        ...(goalProduces ? { produces:      goalProduces } : {}),
      }
    : undefined;
  const result: ReturnType<typeof readSkillsComposeForm> = { skill, graphId };
  if (skillName !== undefined) (result as { skillName?: string }).skillName = skillName;
  if (focusGraphIds.length > 0) (result as { focusGraphIds?: string[] }).focusGraphIds = focusGraphIds;
  if (modelTarget !== undefined) (result as { modelTarget?: string }).modelTarget = modelTarget;
  (result as { save?: boolean }).save = save;
  (result as { recallBreadth?: number | null }).recallBreadth = Number.isFinite(breadth as number) ? breadth : null;
  const useLlmRewrite = (document.getElementById('skills-input-llm-rewrite') as HTMLInputElement | null)?.checked === true;
  if (useLlmRewrite) (result as { useLlmRewrite?: boolean }).useLlmRewrite = true;
  (result as { goals?: typeof goals }).goals = goals;
  return result;
}

// ── Training-in-progress banner ────────────────────────────────────────────
// Playful neuroscience copy rotated every ~3.2 s while the trainer pipeline
// runs. Mix of:
//   - real neuroscience vocabulary (hippocampus, pre-frontal cortex, engram)
//   - Graphnosis vocabulary the user is paying for (Autonomous Praxis,
//     inferred-layer overlay, synapses)
//   - Ghampus the seahorse — the canonical Graphnosis mascot. Seahorse
//     because the hippocampus is shaped like one ("hippocampus" literally
//     means "seahorse" in Greek), and the cortex is the product's whole
//     value prop. The mascot icon to the left of the bar reinforces this.
const TRAINING_MESSAGES = [
  'Warming the cortex…',
  'Polling your hippocampus for relevant engrams…',
  'Ghampus is paging through your memory…',
  'Summoning influential nodes from the substrate…',
  'Letting the pre-frontal cortex reason about pattern…',
  'Ghampus dove deep into the engram pool…',
  'Compressing autonomous praxis into a portable form…',
  'Aligning with your AI client of choice…',
  'Cross-referencing engrams against the skill draft…',
  'Ghampus is humming a tune about per-line attribution…',
  'Threading per-line attribution through the rewrite…',
  'Asking the local LLM to think harder…',
  'Distilling "what you actually meant" from "what you typed"…',
  'Negotiating with the inferred-layer overlay…',
  'Ghampus left a sticky note on the relevant engram…',
  'Verifying nothing got mis-cited by the synapses…',
  'Stitching the trained praxis back into shape…',
  'Reading the cortex receipts before finalising…',
  'Ghampus is double-checking the citations…',
  'Coercing dendrites into agreeing on what mattered…',
  'Persuading the GLL overlay to keep its predictions in line…',
  'Ghampus is wrangling a particularly stubborn engram…',
  'Annotating each rewrite with the memory it came from…',
  'Letting the cortex breathe between iterations…',
  'Ghampus says: "almost there — just polishing a synapse"…',
];

let trainingBannerRotateTimer: ReturnType<typeof setInterval> | null = null;
let trainingBannerStartedAt: number = 0;
// True while the training banner is visible. Other LLM-bound operations
// (Recall enrichment, Edit/Correct LLM rewrite) check this and skip
// their LLM call to avoid stacking up behind the trainer on Ollama's
// single connection — which would otherwise time out at 300s.
let trainerIsBusy = false;

export function isTrainerBusy(): boolean { return trainerIsBusy; }
let trainingBannerElapsedTimer: ReturnType<typeof setInterval> | null = null;
let trainingBannerCancelFn: (() => void) | null = null;

/** AbortController + watcher pair for the in-flight Train call. The
 *  banner's Cancel button calls cancelFn to abort the IPC and tear down
 *  the banner immediately. */
function setTrainingCancelHandler(fn: (() => void) | null): void {
  trainingBannerCancelFn = fn;
}

// ── Live progressive diff during training ──────────────────────────────────
//
// The sidecar streams LLM rewrite tokens through the graph-mutation event
// channel with graphIds like `__skill_train_chunk__<streamId>`. We buffer
// them per-streamId, debounce the diff rerender to 200ms (re-running LCS
// on every token would be wasteful), and feed the partial text through
// the existing renderDiffView() so the user watches Ghampus rewrite live.

let activeTrainStreamId: string | null = null;
let activeTrainBuffer = '';
let activeTrainBaseline = '';
let trainDiffRerenderTimer: ReturnType<typeof setTimeout> | null = null;
// Debounce for the live-diff rerender during streaming. Each rerender recomputes
// a full O(n×m) line-diff and replaces the panel's innerHTML — main-thread work.
// Kept comfortably above one frame so a fast token stream can't pin the thread.
const TRAIN_DIFF_RERENDER_MS = 350;

function startLiveTrainStream(streamId: string, baselineText: string): void {
  activeTrainStreamId = streamId;
  activeTrainBuffer = '';
  activeTrainBaseline = baselineText;
}

function endLiveTrainStream(): void {
  activeTrainStreamId = null;
  activeTrainBuffer = '';
  activeTrainBaseline = '';
  if (trainDiffRerenderTimer) { clearTimeout(trainDiffRerenderTimer); trainDiffRerenderTimer = null; }
}

export function handleSkillTrainFrame(graphId: string, payload: GraphMutationPayload): void {
  // Three frame types share the same channel, distinguished by prefix.
  if (graphId.startsWith('__skill_train_start__')) {
    const streamId = graphId.slice('__skill_train_start__'.length);
    // The baseline (= user's original input) was captured at trainSkill
    // call site; we read it from the active result if available.
    const baseline = skillsActiveResult?.baselineText ?? '';
    startLiveTrainStream(streamId, baseline);
    // Switch into the review pane's "Changes" view + show the empty
    // diff target so chunk arrivals populate visibly. The full review
    // mode UI activates the moment the first chunk lands.
    if (skillsActiveResult) {
      // No-op for now; chunks below will paint the diff.
    }
    return;
  }
  if (graphId.startsWith('__skill_train_status__')) {
    // Per-operation status text for the global status bar (#status-process).
    // Generic label only — no skill name / memory content — and the element's
    // data-pres tag redacts it in Presentation Mode.
    const label = payload.label;
    if (typeof label === 'string' && label) {
      skillTrainStatusLabel = label;
      app().renderStatusProcess();
    }
    return;
  }
  if (graphId.startsWith('__skill_train_chunk__')) {
    const streamId = graphId.slice('__skill_train_chunk__'.length);
    if (streamId !== activeTrainStreamId) return; // stale frame from a prior call
    const chunk = payload.chunk ?? '';
    if (!chunk) return;
    activeTrainBuffer += chunk;
    // First chunk → switch the view to Changes so the user sees the
    // live diff arriving instead of staring at the compose panel.
    if (activeTrainBuffer.length === chunk.length) {
      ensureLiveReviewModeForStreaming();
    }
    // Debounce rerender so we don't run LCS on every token.
    if (trainDiffRerenderTimer) return;
    trainDiffRerenderTimer = setTimeout(() => {
      trainDiffRerenderTimer = null;
      renderLiveDiff();
    }, TRAIN_DIFF_RERENDER_MS);
    return;
  }
  if (graphId.startsWith('__skill_train_done__')) {
    // The final IPC response will repaint with the canonical result.
    // We just need to stop the live-stream loop.
    endLiveTrainStream();
    // Clear the status-bar training line so background brain phases (if any)
    // reclaim it, or it hides.
    skillTrainStatusLabel = null;
    app().renderStatusProcess();
    return;
  }
}

/** Ensure the trainer column is showing review mode with an empty diff
 *  pane during streaming. We can't call the full paintSkillsReview yet
 *  because we don't have the final result — but we DO want the review
 *  panel structure visible so the diff has somewhere to render. */
function ensureLiveReviewModeForStreaming(): void {
  showSkillsReviewMode('Training in progress…');
  // Clear the "Trained output" and "diff" panels so the stream paints fresh.
  const out = document.getElementById('skills-review-output');
  const diff = document.getElementById('skills-review-diff-output');
  if (out) out.textContent = '';
  if (diff) diff.innerHTML = '';
  // Force the diff view to be the active one — that's what users want
  // to watch fill in — but only when the diff panel exists in the DOM.
  if (diff) setOutputView('diff');
}

/** Re-run the line diff over the current partial buffer and update the
 *  diff view. Auto-scrolls to the last hunk so newly-added changes are
 *  visible as the stream progresses. */
function renderLiveDiff(): void {
  if (!activeTrainStreamId) return;
  const diffEl = document.getElementById('skills-review-diff-output');
  const metaEl = document.getElementById('skills-review-diff-meta');
  if (!diffEl) return;
  // Skip the expensive line-diff + repaint when the panel isn't visible — e.g.
  // the user switched to the 3D Engram tab to watch the graph fill with memories
  // live. Running the O(n×m) LCS on the main thread while the diff is hidden
  // would starve the atlas's render loop (freeze + scatter) for no visible
  // benefit. It repaints when the tab is shown again (see the g-tab handler),
  // and the final trained result repaints on completion regardless.
  if (diffEl.offsetParent === null) return;
  const { html, hunkCount, addedLines, removedLines } = renderLineDiff(activeTrainBaseline, activeTrainBuffer);
  diffEl.classList.add('no-animate'); // streaming = no per-hunk reveal animation; movement comes from new lines arriving
  diffEl.innerHTML = html;
  if (metaEl) metaEl.textContent = `Live — +${addedLines} added · −${removedLines} removed · ${hunkCount} block(s) so far (${activeTrainBuffer.length} chars).`;
  // Auto-scroll the last hunk into view so the user is always looking
  // at the latest change rather than the static early ones. Instant (not
  // smooth) during streaming — a smooth scroll restarts an easing animation on
  // every rerender (~3×/sec), piling continuous main-thread work on top of the
  // diff recompute. The final, settled diff can animate; the live stream
  // shouldn't.
  const hunks = diffEl.querySelectorAll<HTMLElement>('.skills-diff-hunk');
  const last = hunks[hunks.length - 1];
  if (last) last.scrollIntoView({ behavior: 'auto', block: 'nearest' });
}

function showTrainingBanner(): void {
  const banner = document.getElementById('skills-train-progress');
  const textEl = document.getElementById('skills-train-progress-text');
  const elapsedEl = document.getElementById('skills-train-progress-elapsed');
  if (!banner || !textEl) return;
  banner.classList.remove('hidden');
  trainerIsBusy = true;
  // Wake the status-bar GAP pill: switch from greyscale-inactive to
  // pulsing green so the trainer's activity is visible even when the
  // user has scrolled away from MemoryStudio.
  {
    const gap = document.getElementById('status-gap-pill');
    if (gap) {
      gap.classList.remove('pill-inactive');
      gap.classList.add('pill-pulsing');
    }
  }
  // Lock all compose-form inputs while training runs so the user can't
  // accidentally mutate their intent mid-train and confuse the result.
  // The text area gets readOnly (allows scroll+selection); the rest get
  // the standard disabled attribute.
  const ta = document.getElementById('skills-input-text') as HTMLTextAreaElement | null;
  if (ta) ta.readOnly = true;
  ([
    'skills-input-name',
    'skills-input-engram',
    'skills-input-model',
    'skills-input-breadth',
    'skills-input-autonomy',
    'btn-skills-create-engram',
    'skills-goal-success',
    'skills-goal-scope',
    'skills-goal-done',
    'skills-goal-trigger',
    'skills-goal-prereq',
    'skills-goal-failure',
    'skills-goal-requires',
    'skills-goal-produces',
  ] as const).forEach((id) => {
    (document.getElementById(id) as HTMLInputElement | null)?.setAttribute('disabled', '');
  });
  // Disable all Focus Engram checkboxes.
  document.getElementById('skills-input-focus')?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((cb) => { cb.disabled = true; });
  trainingBannerStartedAt = Date.now();
  // First message is the deterministic "Warming the cortex…" so the user
  // sees something stable before the rotation kicks in.
  textEl.textContent = TRAINING_MESSAGES[0] ?? 'Training…';
  if (elapsedEl) elapsedEl.textContent = '0s elapsed';
  let idx = 0;
  if (trainingBannerRotateTimer) clearInterval(trainingBannerRotateTimer);
  trainingBannerRotateTimer = setInterval(() => {
    idx = (idx + 1) % TRAINING_MESSAGES.length;
    textEl.textContent = TRAINING_MESSAGES[idx] ?? 'Training…';
  }, 3200);
  // Elapsed-time ticker — updated once per second so the user can see how
  // long they've actually been waiting. After 30s the message changes
  // tone slightly to acknowledge it's taking a while.
  if (trainingBannerElapsedTimer) clearInterval(trainingBannerElapsedTimer);
  trainingBannerElapsedTimer = setInterval(() => {
    if (!elapsedEl) return;
    const sec = Math.floor((Date.now() - trainingBannerStartedAt) / 1000);
    const display = sec < 60 ? `${sec}s elapsed` : `${Math.floor(sec / 60)}m ${sec % 60}s elapsed`;
    let suffix = '';
    // Tier-agnostic, non-coercive copy. Free users on the memory-augmented
    // path aren't using the LLM at all, so blaming "the LLM" was wrong.
    // The trainer keeps running until it returns or the user clicks
    // Cancel — no auto-cancel, no countdown threats. We just acknowledge
    // the wait and remind them the Cancel button exists.
    if (sec >= 30 && sec < 90) suffix = ' — Ghampus is digging deep…';
    else if (sec >= 90 && sec < 180) suffix = ' — still working. Cancel below to stop anytime.';
    else if (sec >= 180) suffix = ' — this is unusually long. Click Cancel if you want to bail out.';
    elapsedEl.textContent = display + suffix;
  }, 1000);
  // Scroll the entire view all the way to the top so the user sees the
  // banner immediately, regardless of how far down they'd scrolled to
  // hit the Train button. Walks every scrollable ancestor of the banner
  // (the studio-section is the main one, but the g-tab-pane and window
  // can also have non-zero scrollTop on smaller viewports).
  let el: HTMLElement | null = banner.parentElement;
  while (el) {
    if (el.scrollTop > 0) {
      el.scrollTo({ top: 0, behavior: 'smooth' });
    }
    el = el.parentElement;
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hideTrainingBanner(): void {
  trainerIsBusy = false;
  const banner = document.getElementById('skills-train-progress');
  if (banner) banner.classList.add('hidden');
  // Send the GAP pill back to its idle (greyscale) state — still visible
  // but clearly inactive, matching how GLL/GNN behave when their layers
  // aren't busy.
  {
    const gap = document.getElementById('status-gap-pill');
    if (gap) {
      gap.classList.remove('pill-pulsing');
      gap.classList.add('pill-inactive');
    }
  }
  if (trainingBannerRotateTimer) {
    clearInterval(trainingBannerRotateTimer);
    trainingBannerRotateTimer = null;
  }
  if (trainingBannerElapsedTimer) {
    clearInterval(trainingBannerElapsedTimer);
    trainingBannerElapsedTimer = null;
  }
  trainingBannerCancelFn = null;
  // Re-enable all compose-form inputs now that training is done.
  const ta = document.getElementById('skills-input-text') as HTMLTextAreaElement | null;
  if (ta) ta.readOnly = false;
  ([
    'skills-input-name',
    'skills-input-engram',
    'skills-input-model',
    'skills-input-breadth',
    'skills-input-autonomy',
    'btn-skills-create-engram',
    'skills-goal-success',
    'skills-goal-scope',
    'skills-goal-done',
    'skills-goal-trigger',
    'skills-goal-prereq',
    'skills-goal-failure',
    'skills-goal-requires',
    'skills-goal-produces',
  ] as const).forEach((id) => {
    (document.getElementById(id) as HTMLInputElement | null)?.removeAttribute('disabled');
  });
  document.getElementById('skills-input-focus')?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    .forEach((cb) => { cb.disabled = false; });
}

// Bind the Cancel button once at module init — clicking it fires the
// currently-registered cancel handler (set by the in-flight Train call).
document.getElementById('btn-skills-train-cancel')?.addEventListener('click', () => {
  if (trainingBannerCancelFn) trainingBannerCancelFn();
});

/** Read the Train-a-Skill form's Autonomy selector. Returns the chosen
 *  per-skill level, or null when "Inherit from engram" (write no override).
 *  Read BEFORE the form is disabled for the training run. */
function readSkillsComposeAutonomy(): 'L0' | 'L1' | 'L2' | 'L3' | null {
  const v = (document.getElementById('skills-input-autonomy') as HTMLSelectElement | null)?.value ?? 'inherit';
  return v === 'L0' || v === 'L1' || v === 'L2' || v === 'L3' ? v : null;
}

/** Persist the chosen per-skill autonomy override for a just-saved skill.
 *  Mirrors the trainer's clamp policy: the backend caps the level by the
 *  skill's authored dispatch-safe tag and echoes back the EFFECTIVE level —
 *  if it differs from the requested level we surface the clamp note rather
 *  than failing. Skipped silently when the user left "Inherit". */
async function applySkillsComposeAutonomy(
  graphId: string,
  sourceId: string,
  requested: 'L0' | 'L1' | 'L2' | 'L3' | null,
): Promise<void> {
  if (!requested) return; // inherit — no override written
  try {
    const res = await ipcCall<{ ok: boolean; effectiveLevel: 'L0' | 'L1' | 'L2' | 'L3' }>(
      'skills.setSkillAutonomy',
      { graphId, sourceId, level: requested },
    );
    const effective = res?.effectiveLevel ?? requested;
    if (effective !== requested) {
      showSkillsToast(
        `Autonomy requested ${requested} but the skill's authored dispatch-safe cap is lower — clamped to ${effective}.`,
        'success',
      );
    } else {
      showSkillsToast(`Per-skill autonomy set to ${effective}.`, 'success');
    }
  } catch (e) {
    console.warn('[skills] setSkillAutonomy after train failed', e);
    showSkillsToast('Trained, but could not set the per-skill autonomy level. Set it from the library.', 'error');
  }
}

async function runSkillTraining(): Promise<void> {
  const params = readSkillsComposeForm();
  if (!params) return;
  // Captured before the form is disabled for the run; applied after save.
  const requestedAutonomy = readSkillsComposeAutonomy();
  const status = document.getElementById('skills-train-status');
  const btn = document.getElementById('btn-skills-train') as HTMLButtonElement | null;
  if (status) status.textContent = 'Recalling memory… then training…';
  if (btn) btn.disabled = true;
  scrollSkillsPaneToTop();
  showTrainingBanner();
  // Stash the baseline on skillsActiveResult so the streaming chunk
  // handler can read it when the first __skill_train_chunk__ frame lands.
  // (We don't know the streamId yet — the sidecar mints it — so the
  // handler picks the active stream up via the broadcasted start frame.)
  skillsActiveResult = {
    trained: '', // filled in by chunks
    influentialNodes: [],
    baselineText: params.skill,
    baselineLabel: 'your input',
    ...(params.graphId !== undefined ? { graphId: params.graphId } : {}),
  };
  // The only way training stops is when (a) the IPC returns or (b) the
  // user clicks Cancel on the banner. No more auto-timeout — that was
  // paternalistic: the user clicked Train, only the user should decide
  // when to stop. The elapsed counter + Cancel button give the user
  // everything they need to bail on a slow run.
  const cancelPromise = new Promise<never>((_, reject) => {
    setTrainingCancelHandler(() => {
      reject(new Error('cancelled-by-user'));
    });
  });
  try {
    // Pro = LLM rewrite (full skill:train). Free = memory-augmented fallback.
    // Both paths produce a usable trained skill — Pro just produces a higher-
    // quality one with per-line attribution. Training itself is NOT gated;
    // only the LLM-rewrite quality is. So we always try the Pro path first
    // and silently fall through to the free path on upgrade_required.
    const result = await Promise.race([
      ipcCall<SkillTrainResult>('skill:train', params),
      cancelPromise,
    ]);
    if (result && result.upgrade_required) {
      // Free path — same effective experience minus the LLM rewrite quality.
      // We reuse runSkillsFallbackTraining()'s pipeline but suppress its
      // separate status indicator since we're already mid-Train flow.
      // Same timeout/cancel guard applies to this path — without it, a
      // slow recall could hang the banner forever (the bug that surfaced
      // as a 4+ minute "training" run with no auto-cancel).
      if (status) status.textContent = 'Building source-only version…';
      await Promise.race([
        runSkillsFallbackTraining({ silent: true }),
        cancelPromise,
      ]);
      // After the fallback completes, surface a non-blocking upgrade hint
      // inside review mode so the user knows what Pro would add.
      showInlineProUpgradeHint(
        'You\'re on the free source-only path — skill compiled from your text without LLM rewrite. Upgrade to Pro for a local LLM-powered restructure with goal/step clarity.',
        result.upgrade_url ?? 'https://graphnosis.com/upgrade',
      );
      return;
    }
    const engramName = getLoadedGraphs().find((g) => g.graphId === params.graphId)?.metadata.displayName ?? params.graphId;
    showSkillsReviewMode(skillFriendlyName(params.skillName || 'Trained skill'));
    paintSkillsReview(result, {
      graphId: params.graphId,
      ...(result.skillId !== undefined ? { sourceId: result.skillId } : {}),
      engramName,
    });
    // If we saved, refresh the library and open the newly-saved skill in
    // review mode so the Trained Output shows the fresh result — without
    // this, the panel stays on the compose form and the user has to click
    // the row manually to see what was produced.
    if (params.save && result.skillId) {
      // Persist the chosen per-skill autonomy override (if any) before the
      // library refresh so the new row paints with the right effective level.
      await applySkillsComposeAutonomy(params.graphId, result.skillId, requestedAutonomy);
      await fetchSkillsLibrary();
      renderSkillsLibrary();
      skillsActiveSourceId = result.skillId;
      skillsVitalityCache.delete(result.skillId);
      // Drop any cached dispatch-safe readout for this engram so the per-skill
      // dials repaint with the freshly-set effective level.
      skillsDispatchReadoutCache.delete(params.graphId);
      void warmVitalityCache();
      // Review panel already painted from `result` above — do not re-open via
      // skill:get here; a second listNodes pass can race the sidecar flush and
      // overwrite Trained Output with "No trained content found".
    } else if (params.save) {
      await fetchSkillsLibrary();
      renderSkillsLibrary();
      void warmVitalityCache();
    }
    showSkillsToast(`Trained (mode: ${result.mode})`, 'success');
    // Training succeeded → the user's input now lives in the engram (or
    // was deliberately previewed). Clear the autosave draft so the next
    // mount doesn't pop the restore banner for a draft that already
    // landed somewhere durable. (For preview-only mode, we still clear —
    // the user explicitly chose not to save, so we respect that.)
    clearSkillsDraft();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'cancelled-by-user') {
      showSkillsToast('Training cancelled.', 'success');
    } else {
      console.warn('[skills] skill:train failed', e);
      showSkillsToast('Training failed. Check the sidecar logs.', 'error');
    }
  } finally {
    if (btn) btn.disabled = false;
    if (status) status.textContent = '';
    hideTrainingBanner();
    setTrainingCancelHandler(null);
    // Safety net: clear the status-bar training line in case the sidecar's
    // `done` frame never arrived (e.g. trainSkill threw, so the IPC handler
    // skipped the done broadcast).
    if (skillTrainStatusLabel !== null) {
      skillTrainStatusLabel = null;
      app().renderStatusProcess();
    }
  }
}

function showSkillsLicenseCard(result: SkillTrainResult): void {
  const card = document.getElementById('skills-license-card');
  const msg = document.getElementById('skills-license-message');
  if (msg) msg.textContent = result.message ?? 'Upgrade to Graphnosis Pro to train skills with the LLM rewrite pipeline.';
  if (card) {
    card.classList.remove('hidden');
    // The card lives below the composer; scroll it into view so the user
    // actually sees the explanation + the two CTAs instead of having to
    // hunt for them after hitting Train.
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const upgradeBtn = document.getElementById('btn-skills-upgrade') as HTMLButtonElement | null;
  if (upgradeBtn) upgradeBtn.dataset['url'] = result.upgrade_url ?? 'https://graphnosis.com/upgrade';
}

async function runSkillsFallbackTraining(opts: { silent?: boolean } = {}): Promise<void> {
  // Free-tier training path — source-only compile (empty recall at train time).
  // Uses skill:buildContext → SkillTrainer.buildSkillContext(), which returns
  // no personal-cortex nodes under the empty-engram train contract.
  //
  // Two entry points use this:
  //   1. The dedicated "Train without LLM" button (legacy explicit path)
  //   2. The Train button's automatic fallback when skill:train returns
  //      upgrade_required (silent: true, so we don't double-toast).
  const params = readSkillsComposeForm();
  if (!params) return;
  const status = document.getElementById('skills-train-status');
  const btn = document.getElementById('btn-skills-fallback') as HTMLButtonElement | null;
  const trainBtn = document.getElementById('btn-skills-train') as HTMLButtonElement | null;
  if (status && !opts.silent) status.textContent = 'Structuring from source…';
  skillTrainStatusLabel = 'Structuring skill from source…';
  app().renderStatusProcess();
  if (btn) btn.disabled = true;
  if (trainBtn && opts.silent) trainBtn.disabled = true;
  // Standalone-invocation case (user clicked "Train without LLM" directly):
  // show the rotating banner. When opts.silent === true we're inside the
  // outer runSkillTraining() flow which already showed the banner.
  if (!opts.silent) scrollSkillsPaneToTop();
  if (!opts.silent) showTrainingBanner();
  try {
    const ctx = await ipcCall<{
      subgraph: string;
      influentialNodes: SkillInfluentialNode[];
      tokenCount: number;
      nodeCount: number;
    } | null>('skill:buildContext', {
      skill: params.skill,
      graphId: params.graphId,
      focusGraphIds: params.focusGraphIds ?? null,
      recallBreadth: params.recallBreadth ?? null,
      ...(params.goals !== undefined ? { goals: params.goals } : {}),
    });
    if (!ctx) {
      showSkillsToast('Train failed.', 'error');
      return;
    }
    const freshNodes: SkillInfluentialNode[] = [];

    skillTrainStatusLabel = 'Finalizing trained skill…';
    app().renderStatusProcess();
    const trained = params.skill;
    const engramName = getLoadedGraphs().find((g) => g.graphId === params.graphId)?.metadata.displayName ?? params.graphId;
    showSkillsReviewMode(skillFriendlyName(params.skillName || 'Skill (source-only)'));

    // Save if the user picked a real engram — free users persist via skill:saveFallback.
    let savedSkillId: string | undefined;
    if (params.save) {
      skillTrainStatusLabel = 'Saving the trained skill…';
      app().renderStatusProcess();
      try {
        const saved = await ipcCall<{ ok: boolean; skillId?: string }>('skill:saveFallback', {
          graphId: params.graphId,
          text: trained,
          skillName: params.skillName,
          influentialNodeCount: freshNodes.length,
          recallBreadth: params.recallBreadth,
          addedBy: 'desktop-ui',
          ...(params.goals !== undefined ? { goals: params.goals } : {}),
        });
        if (saved?.ok && saved.skillId) {
          savedSkillId = saved.skillId;
          skillsActiveSourceId = saved.skillId;
          await fetchSkillsLibrary();
          renderSkillsLibrary();
          if (savedSkillId) skillsVitalityCache.delete(savedSkillId);
          void warmVitalityCache();
        }
      } catch (e) {
        console.warn('[skills] skill:saveFallback failed', e);
        showSkillsToast('Build complete but could not save — check the sidecar logs.', 'error');
      }
    }

    paintSkillsReview(
      {
        original: params.skill,
        trained,
        influentialNodes: freshNodes,
        mode: 'memory-augmented',
        ...(savedSkillId !== undefined ? { skillId: savedSkillId } : {}),
        degradedNote: 'Trained on the free source-only path — no cortex recall at compile time. Upgrade to Pro for an LLM-powered rewrite with goal/step structure.',
      },
      { graphId: params.graphId, engramName, ...(savedSkillId !== undefined ? { sourceId: savedSkillId } : {}) },
    );
    if (!opts.silent) showSkillsToast(params.save && savedSkillId ? 'Skill saved.' : 'Source-only compile complete.', 'success');
  } catch (e) {
    console.warn('[skills] skill:buildContext failed', e);
    showSkillsToast('Build context failed.', 'error');
  } finally {
    if (btn) btn.disabled = false;
    if (trainBtn) trainBtn.disabled = false;
    if (status) status.textContent = '';
    if (!opts.silent) hideTrainingBanner();
    // Clear the status-bar training line (covers success, error, and the
    // silent fallback invoked from the Pro path).
    if (skillTrainStatusLabel !== null) {
      skillTrainStatusLabel = null;
      app().renderStatusProcess();
    }
  }
}

/** Open the Stripe Checkout URL with the cached cortex email pre-filled,
 *  using the same opener-chain we use everywhere else (Tauri plugin →
 *  open_external_url → window.open). Centralised so every Pro-upgrade
 *  surface uses the same code path. */
function openProUpgradeCheckout(baseUrl?: string): void {
  const url = baseUrl ?? 'https://graphnosis.com/upgrade';
  const cachedEmail = localStorage.getItem(app().BILLING_EMAIL_KEY) ?? '';
  const fullUrl = cachedEmail
    ? `${url}${url.includes('?') ? '&' : '?'}email=${encodeURIComponent(cachedEmail)}`
    : url;
  void invoke('plugin:opener|open_url', { url: fullUrl })
    .catch(() => invoke('open_external_url', { url: fullUrl }))
    .catch(() => { window.open(fullUrl, '_blank'); });
}

/** Open the Settings modal scrolled to the License panel so the user can
 *  paste their token. Falls back to a console message if the Settings
 *  modal can't be opened (shouldn't happen in production). */
function openPasteLicensePanel(): void {
  // Open the dedicated license modal directly. It's account-level state,
  // independent of the per-cortex Settings modal, so we don't need to
  // open Settings first anymore.
  openLicenseModal();
}

/** Show the standalone License modal and refresh its status line so the
 *  current plan/expiry are visible the moment it opens. Also focuses the
 *  paste textarea so a user with a token in clipboard can just ⌘V. */
export function openLicenseModal(): void {
  const modal = document.getElementById('license-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  setTimeout(() => {
    // License status UI lives in main.ts — notify it to refresh without a circular import.
    document.dispatchEvent(new CustomEvent('graphnosis:license-modal-opened'));
    const emailInput = document.getElementById('settings-license-email') as HTMLInputElement | null;
    if (emailInput && !emailInput.value) {
      emailInput.value = localStorage.getItem(app().BILLING_EMAIL_KEY) ?? '';
    }
    const domainEmailInput = document.getElementById('settings-license-domain-email') as HTMLInputElement | null;
    if (domainEmailInput && !domainEmailInput.value) {
      domainEmailInput.value = localStorage.getItem('billing:domainEmail') ?? '';
    }
  }, 30);
}

export function closeLicenseModal(): void {
  const modal = document.getElementById('license-modal');
  if (modal) modal.classList.add('hidden');
  // Reset OTP section so it doesn't linger on next open.
  document.getElementById('license-otp-section')?.classList.add('hidden');
  const otpInput = document.getElementById('settings-license-otp') as HTMLInputElement | null;
  if (otpInput) otpInput.value = '';
  const otpFeedback = document.getElementById('settings-license-otp-feedback');
  if (otpFeedback) otpFeedback.textContent = '';
}

// ── "Go home" affordances → MemoryStudio ───────────────────────────────────
//
// Three click targets all jump the user to MemoryStudio from anywhere in
// the app: the rail logo (image), the top-header title ("Graphnosis"),
// and the top-header tagline. Useful as "lost? click here" navigation,
// especially with the rail collapsed. Mirrored on Enter / Space for
// keyboard users on each target.
function scrollSkillsPaneToTop(): void {
  document.querySelector<HTMLElement>('.app-canvas')?.scrollTo({ top: 0, behavior: 'smooth' });
}

{
  const goHome = (): void => {
    // activateMode('atlas') shows data-pane=atlas and switchGraphnosisTab('checkin').
    app().activateMode('atlas');
    const searchEl = app().els['gSearch'] as HTMLInputElement | undefined;
    if (searchEl?.value) {
      searchEl.value = '';
      searchEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  const wireHome = (id: string): void => {
    const el = document.getElementById(id);
    el?.addEventListener('click', goHome);
    el?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        goHome();
      }
    });
  };
  wireHome('rail-logo-home');
  // Home/Overview Trust & Vitality card — switch to Ghampus chat (not intro modal).
  const openGhampusChat = (): void => {
    app().activateMode('ghampus');
  };
  const wireGhampusChat = (id: string): void => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', openGhampusChat);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGhampusChat(); }
    });
  };
  wireGhampusChat('home-ghampus-btn');
  // Legacy header mark opens the "Meet Ghampus" intro modal (if present).
  const openGhampusModal = (): void => {
    document.getElementById('ghampus-modal')?.classList.remove('hidden');
  };
  const closeGhampusModal = (): void => {
    document.getElementById('ghampus-modal')?.classList.add('hidden');
  };
  for (const id of ['header-ghampus-btn']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('click', openGhampusModal);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGhampusModal(); }
    });
  }
  document.getElementById('btn-ghampus-modal-close')?.addEventListener('click', closeGhampusModal);
  document.getElementById('ghampus-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeGhampusModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = document.getElementById('ghampus-modal');
      if (m && !m.classList.contains('hidden')) closeGhampusModal();
    }
  });
  // GAP pill — same target as goHome, plus snap to the Skills chip so the
  // user lands directly on the trainer that's actually running.
  const gapPill = document.getElementById('status-gap-pill');
  if (gapPill) {
    gapPill.style.cursor = 'pointer';
    gapPill.addEventListener('click', () => {
      app().activateMode('skills');
    });
  }
}

// Global delegated handler for Pro-upgrade buttons — any element with
// data-pro-upgrade-btn (= "Upgrade to Pro") or data-pro-paste-token
// (= "Paste a license token") is routed here, so every gate surface
// across the app gets identical behavior without per-card wiring.
document.addEventListener('click', (e) => {
  // Close any open proactive snooze menus when clicking outside
  if (!(e.target as HTMLElement)?.closest('.proactive-snooze-wrap')) {
    document.querySelectorAll<HTMLElement>('.proactive-snooze-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
  }
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const upgradeBtn = target.closest<HTMLElement>('[data-pro-upgrade-btn]');
  if (upgradeBtn) {
    e.preventDefault();
    const url = upgradeBtn.dataset['url'] ?? upgradeBtn.dataset['proUpgradeUrl'];
    openProUpgradeCheckout(url);
    return;
  }
  const pasteBtn = target.closest<HTMLElement>('[data-pro-paste-token]');
  if (pasteBtn) {
    e.preventDefault();
    openPasteLicensePanel();
    return;
  }
});

/** Surface a non-blocking "Upgrade for LLM rewrite" hint in the review pane
 *  for free users — they got a working result; this just tells them what
 *  Pro would add. Click → Stripe Checkout via the existing upgrade plumbing. */
function showInlineProUpgradeHint(message: string, url: string): void {
  const deg = document.getElementById('skills-degraded-note');
  if (!deg) return;
  deg.innerHTML = `${escape(message)} <a href="#" id="skills-inline-upgrade" style="color:var(--ai-accent); font-weight:600; text-decoration:underline;">Upgrade to Pro →</a>`;
  deg.classList.remove('hidden');
  deg.querySelector<HTMLAnchorElement>('#skills-inline-upgrade')?.addEventListener('click', (e) => {
    e.preventDefault();
    const cachedEmail = localStorage.getItem(app().BILLING_EMAIL_KEY) ?? '';
    const fullUrl = cachedEmail
      ? `${url}${url.includes('?') ? '&' : '?'}email=${encodeURIComponent(cachedEmail)}`
      : url;
    void invoke('plugin:opener|open_url', { url: fullUrl })
      .catch(() => invoke('open_external_url', { url: fullUrl }))
      .catch(() => { window.open(fullUrl, '_blank'); });
  });
}

// ── Autonomous retrain schedule (Pro) ───────────────────────────────────────
//
// One AutoRetrainConfig per skill source, stored in AppSettings.skillAutoRetrain.
// The sidecar's scheduler polls every 5 minutes and fires a fresh trainSkill()
// run when the interval has elapsed since lastAutoRetrain. The UI just owns
// the per-skill toggle + interval input and the "auto" badge in the library.
//
// Pro-gated: writing the config requires a valid skill-training license; the
// sidecar rejects unlicensed writes with upgrade_required and we surface the
// same upgrade card the LLM-rewrite path uses.

interface SkillRetrainConfig {
  enabled: boolean;
  graphId: string;
  trigger: 'scheduled' | 'cortex-growth' | 'vitality-decay' | 'hybrid';
  intervalMs?: number;
  cortexGrowthThreshold?: number;
  vitalityThreshold?: number;
  autonomyLevel: 'notify' | 'auto-accept' | 'preview-first';
  lastAutoRetrain?: number;
  enabledAt?: number;
}

const skillsRetrainCache = new Map<string, SkillRetrainConfig | null>();
let skillsRetrainNotifications: Set<string> = new Set();
let skillsRetrainPending: Record<string, { graphId: string; proposedAt: number; trained: string; diffNotes?: string; triggerReason: string }> = {};

async function fetchRetrainNotifications(): Promise<void> {
  try {
    const res = await ipcCall<{ sourceIds: string[] }>('skill:listNotifications', {});
    skillsRetrainNotifications = new Set(res?.sourceIds ?? []);
  } catch { /* non-fatal */ }
}

async function fetchPendingProposals(): Promise<void> {
  try {
    const res = await ipcCall<{ proposals: typeof skillsRetrainPending }>('skill:listPendingProposals', {});
    skillsRetrainPending = res?.proposals ?? {};
  } catch { /* non-fatal */ }
}

async function fetchRetrainConfig(sourceId: string): Promise<SkillRetrainConfig | null> {
  if (skillsRetrainCache.has(sourceId)) return skillsRetrainCache.get(sourceId) ?? null;
  try {
    const cfg = await ipcCall<SkillRetrainConfig | null>('skill:getRetrainConfig', { sourceId });
    skillsRetrainCache.set(sourceId, cfg);
    return cfg;
  } catch {
    return null;
  }
}

function syncRetrainVisibleFields(trigger: string): void {
  // Show/hide the per-trigger input rows based on which trigger the user
  // picked. Hybrid shows ALL three so the user can configure every dimension.
  const showInterval = trigger === 'scheduled' || trigger === 'hybrid';
  const showGrowth   = trigger === 'cortex-growth' || trigger === 'hybrid';
  const showVitality = trigger === 'vitality-decay' || trigger === 'hybrid';
  document.querySelectorAll<HTMLElement>('[data-retrain-field]').forEach((el) => {
    const field = el.dataset['retrainField'];
    const visible = (field === 'interval' && showInterval)
      || (field === 'growth' && showGrowth)
      || (field === 'vitality' && showVitality);
    el.classList.toggle('hidden', !visible);
  });
}

async function paintRetrainSchedule(): Promise<void> {
  const enabledEl = document.getElementById('skills-retrain-enabled') as HTMLInputElement | null;
  const triggerEl = document.getElementById('skills-retrain-trigger') as HTMLSelectElement | null;
  const intervalEl = document.getElementById('skills-retrain-interval') as HTMLInputElement | null;
  const growthEl = document.getElementById('skills-retrain-growth') as HTMLInputElement | null;
  const vitalityEl = document.getElementById('skills-retrain-vitality') as HTMLInputElement | null;
  const autonomyRadios = document.querySelectorAll<HTMLInputElement>('input[name="skills-retrain-autonomy"]');
  const metaEl = document.getElementById('skills-retrain-meta');
  if (!enabledEl || !triggerEl || !intervalEl || !growthEl || !vitalityEl) return;

  const active = skillsActiveResult;
  // Gate the controls on (a) Pro license and (b) the skill having been
  // saved (no sourceId = nothing to schedule).
  const status = await app().ipcLicenseStatus();
  const isPro = status.present && !!status.valid;
  const sourceId = active?.skillId;
  const canEdit = isPro && !!sourceId;
  // Free users see the upgrade card instead of a row of dead disabled
  // inputs. Pro users see the controls (and they only enable when a
  // skill has been saved — same gate as before).
  const upgradeCard = document.getElementById('skills-retrain-upgrade');
  const controlsWrap = document.getElementById('skills-retrain-controls');
  upgradeCard?.classList.toggle('hidden', isPro);
  controlsWrap?.classList.toggle('hidden', !isPro);
  [enabledEl, triggerEl, intervalEl, growthEl, vitalityEl].forEach((el) => { el.disabled = !canEdit; });
  autonomyRadios.forEach((r) => { r.disabled = !canEdit; });
  if (!isPro) return;  // Card is shown; no need to populate inputs.

  if (!sourceId) {
    enabledEl.checked = false;
    if (metaEl) metaEl.textContent = isPro
      ? 'Save this skill to enable auto-retrain.'
      : 'Save and subscribe to Pro to enable auto-retrain.';
    syncRetrainVisibleFields(triggerEl.value);
    return;
  }

  const cfg = await fetchRetrainConfig(sourceId);
  if (cfg && cfg.enabled) {
    enabledEl.checked = true;
    triggerEl.value = cfg.trigger;
    intervalEl.value = String(Math.max(1, Math.round((cfg.intervalMs ?? 7 * 24 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000))));
    if (typeof cfg.cortexGrowthThreshold === 'number') growthEl.value = String(cfg.cortexGrowthThreshold);
    if (typeof cfg.vitalityThreshold === 'number') vitalityEl.value = String(cfg.vitalityThreshold);
    autonomyRadios.forEach((r) => { r.checked = r.value === cfg.autonomyLevel; });
    if (metaEl) {
      const last = cfg.lastAutoRetrain ? new Date(cfg.lastAutoRetrain).toLocaleString() : 'not yet';
      const next = cfg.trigger === 'scheduled' && cfg.lastAutoRetrain && cfg.intervalMs
        ? new Date(cfg.lastAutoRetrain + cfg.intervalMs).toLocaleString()
        : '—';
      metaEl.textContent = `Last auto-retrain: ${last}${cfg.trigger === 'scheduled' ? ` · Next: ${next}` : ''}`;
    }
  } else {
    enabledEl.checked = false;
    if (metaEl) metaEl.textContent = isPro
      ? 'Auto-retrain is off for this skill.'
      : 'Available on Graphnosis Pro.';
  }
  syncRetrainVisibleFields(triggerEl.value);
}

async function saveRetrainScheduleFromUI(): Promise<void> {
  const enabledEl = document.getElementById('skills-retrain-enabled') as HTMLInputElement | null;
  const triggerEl = document.getElementById('skills-retrain-trigger') as HTMLSelectElement | null;
  const intervalEl = document.getElementById('skills-retrain-interval') as HTMLInputElement | null;
  const growthEl = document.getElementById('skills-retrain-growth') as HTMLInputElement | null;
  const vitalityEl = document.getElementById('skills-retrain-vitality') as HTMLInputElement | null;
  const active = skillsActiveResult;
  if (!enabledEl || !triggerEl || !intervalEl || !growthEl || !vitalityEl || !active?.skillId || !active.graphId) return;

  const enabled = enabledEl.checked;
  const trigger = triggerEl.value as 'scheduled' | 'cortex-growth' | 'vitality-decay' | 'hybrid';
  const days = Math.max(1, Math.min(365, parseInt(intervalEl.value || '7', 10) || 7));
  const intervalMs = days * 24 * 60 * 60 * 1000;
  const cortexGrowthThreshold = Math.max(1, parseInt(growthEl.value || '50', 10) || 50);
  const vitalityThreshold = Math.max(1, Math.min(100, parseInt(vitalityEl.value || '60', 10) || 60));
  const selectedAutonomy = (Array.from(document.querySelectorAll<HTMLInputElement>('input[name="skills-retrain-autonomy"]'))
    .find((r) => r.checked)?.value ?? 'auto-accept') as 'auto-accept' | 'notify' | 'preview-first';

  const config: SkillRetrainConfig | null = enabled
    ? {
        enabled: true,
        graphId: active.graphId,
        trigger,
        // Send only the relevant threshold fields per trigger; 'hybrid' carries all.
        ...((trigger === 'scheduled' || trigger === 'hybrid') ? { intervalMs } : {}),
        ...((trigger === 'cortex-growth' || trigger === 'hybrid') ? { cortexGrowthThreshold } : {}),
        ...((trigger === 'vitality-decay' || trigger === 'hybrid') ? { vitalityThreshold } : {}),
        autonomyLevel: selectedAutonomy,
      }
    : null;

  try {
    const result = await ipcCall<{ ok?: boolean; upgrade_required?: boolean; upgrade_url?: string; message?: string }>(
      'skill:setRetrainConfig',
      { sourceId: active.skillId, config },
    );
    if (result && result.upgrade_required) {
      showSkillsLicenseCard({
        original: '',
        trained: '',
        influentialNodes: [],
        mode: 'memory-augmented',
        upgrade_required: true,
        upgrade_url: result.upgrade_url ?? 'https://graphnosis.com/upgrade',
        message: result.message ?? 'Autonomous retraining is a Pro feature.',
      });
      // Revert the checkbox visually so the UI matches the persisted state.
      enabledEl.checked = false;
      return;
    }
    // Cache invalidation — next render reflects the new state.
    skillsRetrainCache.delete(active.skillId);
    await paintRetrainSchedule();
    // Library row's auto-badge depends on the schedule, so repaint that too.
    renderSkillsLibrary();
    showSkillsToast(enabled ? `Auto-retrain on (every ${days}d)` : 'Auto-retrain off', 'success');
  } catch (e) {
    console.warn('[skills] setRetrainConfig failed', e);
    showSkillsToast('Schedule save failed.', 'error');
  }
}

async function refreshSkillVitality(): Promise<void> {
  if (!skillsActiveResult?.skillId || !skillsActiveResult.graphId) {
    // No saved skill behind this view — almost always the free
    // memory-augmented preview path, which doesn't persist. Re-training
    // won't help on the free tier (skill saving is Pro), so be honest
    // rather than sending the user in a loop.
    showSkillsToast('Vitality is computed for saved skills. The memory-augmented preview isn\'t saved — open a saved skill from the library to see its vitality.', 'error');
    return;
  }
  try {
    const v = await ipcCall<SkillVitality | null>('skill:vitality', {
      graphId: skillsActiveResult.graphId,
      sourceId: skillsActiveResult.skillId,
    });
    if (!v) {
      showSkillsToast('Vitality unavailable.', 'error');
      return;
    }
    skillsVitalityCache.set(skillsActiveResult.skillId, { value: v, fetchedAt: Date.now() });
    const vitEl = document.getElementById('skills-review-vitality');
    if (vitEl) vitEl.textContent = `↻ vitality: ${Math.round(v.score)} — ${v.recommendation}`;
    renderSkillsLibrary();
  } catch (e) {
    console.warn('[skills] vitality refresh failed', e);
  }
}

/** Toggle the inline "PRO — Upgrade to export as .gsk" hint that appears next to
 *  the format dropdown when the user picks GSK without a Pro license.
 *  Called on (a) format-select change and (b) every paintSkillsReview()
 *  so the hint state matches the freshly-fetched license. */
async function syncSkillsExportProHint(): Promise<void> {
  const hint = document.getElementById('skills-export-pro-hint');
  const sel = document.getElementById('skills-export-format') as HTMLSelectElement | null;
  if (!hint || !sel) return;
  if (sel.value !== 'gsk') { hint.classList.add('hidden'); return; }
  let isPro = false;
  try {
    const status = await app().ipcLicenseStatus();
    isPro = !!(status.valid && Array.isArray(status.features) && status.features.includes('skill-training'));
  } catch { isPro = false; }
  hint.classList.toggle('hidden', isPro);
}

async function exportSkillFromUI(action: 'copy' | 'save'): Promise<void> {
  const active = skillsActiveResult;
  if (!active || !active.trained) {
    showSkillsToast('Nothing to export.', 'error');
    return;
  }
  const text = active.trained;
  const formatSel = document.getElementById('skills-export-format') as HTMLSelectElement | null;
  const format = formatSel?.value ?? 'claude-md';
  const status = document.getElementById('skills-export-status');
  try {
    // GSK is Pro-gated. The sidecar returns an upgrade-required object
    // (instead of a string) when the user isn't licensed; surface it via
    // the existing license card. All other formats stay free and return
    // the exported string directly.
    const raw = await ipcCall<string | { upgrade_required: boolean; upgrade_url?: string; message?: string }>('skill:export', { skillText: text, format });
    if (typeof raw === 'object' && raw !== null && 'upgrade_required' in raw && raw.upgrade_required) {
      showSkillsLicenseCard({
        original: '',
        trained: '',
        influentialNodes: [],
        mode: 'memory-augmented',
        upgrade_required: true,
        upgrade_url: raw.upgrade_url ?? 'https://graphnosis.com/upgrade',
        message: raw.message ?? 'GSK export is a Pro feature. Upgrade to export encrypted .gsk skill packs.',
      });
      if (status) status.textContent = 'GSK export (Graphnosis Skill Kit) is a Pro feature.';
      return;
    }
    const exported = raw as string;
    rememberSkillExportFormat(active.skillId, format);
    if (action === 'copy') {
      // GSK is base64-encoded bytes — copying that to the clipboard is rarely
      // useful, so we copy text formats only.
      if (format === 'gsk') {
        showSkillsToast('GSK is a binary format — use Save file.', 'error');
        return;
      }
      await navigator.clipboard.writeText(exported);
      if (status) status.textContent = `Copied (${format})`;
      showSkillsToast(`Copied as ${format}`, 'success');
    } else {
      // Save file — route through the Tauri command we ship in lib.rs
      // (`save_skill_file`) which shows a native save dialog and writes
      // either text or base64-decoded binary depending on format.
      const extByFormat: Record<string, string> = {
        'claude-md': 'md',
        'cursorrules': 'cursorrules',
        'system-prompt': 'txt',
        'openai': 'txt',
        'raw': 'txt',
        'gsk': 'gsk',
      };
      const ext = extByFormat[format] ?? 'txt';
      const defaultName = `${active.skillId ? active.skillId.slice(0, 10) : 'skill'}.${ext}`;
      try {
        const isBinary = format === 'gsk';
        const saved = await invoke<boolean>('save_skill_file', {
          defaultName,
          filterName: format,
          filterExt: ext,
          content: isBinary ? '' : exported,
          binaryB64: isBinary ? exported : null,
        });
        if (saved) {
          if (status) status.textContent = `Saved as ${format}`;
          showSkillsToast(`Saved as ${format}`, 'success');
        }
      } catch (e) {
        console.warn('[skills] save dialog failed', e);
        showSkillsToast('Save failed.', 'error');
      }
    }
  } catch (e) {
    console.warn('[skills] export failed', e);
    showSkillsToast('Export failed.', 'error');
  }
}

interface SkillImportResult {
  ok: boolean;
  reason?: string;
  message?: string;
  verified?: boolean;
  pack?: {
    id: string;
    displayName: string;
    version: string;
    author: string;
    kind: 'official' | 'community';
    description: string;
  };
  engramName?: string;
  graphId?: string;
  imported?: Array<{ name: string; sourceId: string }>;
  skippedEmpty?: string[];
}

/** Read a File picked from the hidden Import .gsk input and ship it to the
 *  sidecar's skill:importGsk handler. The handler decrypts the pack,
 *  optionally verifies its Ed25519 signature, and ingests each skill in the
 *  pack as a kind:'skill' source in the resolved target engram. */
interface SkillPeekResult {
  ok: boolean;
  reason?: string;
  message?: string;
  verified?: boolean;
  pack?: {
    id: string;
    displayName: string;
    version: string;
    author: string;
    kind: 'official' | 'community';
    description: string;
  };
  skills?: Array<{ name: string; sensitivityTier: 'personal' | 'sensitive' }>;
}

/**
 * Drives the .gsk import flow end-to-end:
 *
 *   1. Open native picker via the Rust `pick_gsk_file` command. (Tauri
 *      webviews don't reliably show pickers for hidden <input type="file">,
 *      so the dialog lives in Rust.) Returns base64-encoded bytes.
 *   2. Peek at the pack metadata via the sidecar's `skill:peekGsk` handler
 *      — decrypts only, no ingest. We need this to populate the destination
 *      picker with the pack's actual name + skill list.
 *   3. Show a destination modal recommending a per-pack engram (named after
 *      the pack's displayName) and listing any existing Skills engrams as
 *      override options. Per-pack engrams are the default because packs
 *      already encode their sensitivity context (HIPAA vs Sales etc.);
 *      keeping them in dedicated engrams preserves that isolation.
 *   4. Create the engram if "new" was chosen, then call `skill:importGsk`
 *      with the same base64 + the resolved graphId.
 *
 * Returns silently if the user cancels at any stage.
 */
async function runGskImport(): Promise<void> {
  let gskBase64: string | null;
  try {
    gskBase64 = await invoke<string | null>('pick_gsk_file');
  } catch (e) {
    console.warn('[skills] pick_gsk_file failed', e);
    const msg = e instanceof Error ? e.message : String(e);
    showSkillsToast(`File picker failed: ${msg}`, 'error');
    return;
  }
  if (!gskBase64) return; // user cancelled

  // ── Peek ──────────────────────────────────────────────────────────────
  let peek: SkillPeekResult;
  try {
    peek = await ipcCall<SkillPeekResult>('skill:peekGsk', { gskBase64 });
  } catch (e) {
    console.warn('[skills] peekGsk failed', e);
    const msg = e instanceof Error ? e.message : String(e);
    showSkillsToast(`Could not read pack: ${msg}`, 'error');
    return;
  }
  if (!peek?.ok || !peek.pack) {
    const why = peek?.message ?? peek?.reason ?? 'Unknown error';
    showSkillsToast(`Could not read pack: ${why}`, 'error');
    return;
  }

  // ── Pick destination engram ──────────────────────────────────────────
  const choice = await chooseSkillImportDestination(peek);
  if (!choice) return; // user cancelled the modal

  let graphId = choice.existingGraphId;
  if (!graphId) {
    const created = await createSkillsEngramQuiet(choice.newEngramName ?? peek.pack.displayName);
    if (!created) return; // toast already shown
    graphId = created;
  }

  // ── Import ───────────────────────────────────────────────────────────
  // A multi-skill pack takes several seconds to ingest (one source + several
  // node inserts per skill, plus relink). Hold a persistent progress toast up
  // for the whole duration — ingest AND the library refresh — so the user
  // isn't left wondering whether anything is happening before the new engram
  // appears.
  const destLabel = choice.existingGraphId
    ? (getLoadedGraphs().find((g) => g.graphId === choice.existingGraphId)?.metadata.displayName ?? choice.existingGraphId)
    : (choice.newEngramName ?? peek.pack?.displayName ?? 'new engram');
  const importToastId = app().addIngestToast('Importing memory-trained skills…', `to "${destLabel}"`);
  try {
    const result = await ipcCall<SkillImportResult>('skill:importGsk', {
      graphId,
      gskBase64,
      addedBy: 'desktop-ui',
    });
    if (!result?.ok) {
      const why = result?.message ?? result?.reason ?? 'Unknown error';
      app().finishIngestToast(importToastId, 'error', `Import failed: ${why}`);
      return;
    }
    const n = result.imported?.length ?? 0;
    const skipped = result.skippedEmpty?.length ?? 0;
    const verifiedTag = result.verified ? ' (verified official pack)' : (result.pack?.kind === 'community' ? ' (community pack)' : '');
    const skippedTag = skipped > 0 ? ` · ${skipped} skipped (empty)` : '';
    scrollSkillsPaneToTop();
    // The destination engram may have been freshly created (Tauri side) and
    // not yet pulled into the sidecar's loaded-graph set, so the no-arg
    // skill:list enumeration (graphs.list) can miss it — leaving the library
    // stuck on its prior contents even though the import succeeded. Load the
    // graph into the sidecar first, refresh the engram pickers/group state,
    // then re-list.
    const intoGraph = result.graphId ?? graphId;
    if (intoGraph) await ipcCall('graphs.load', { graphId: intoGraph }).catch(() => {});
    await fetchSkillsLibrary();
    // Belt-and-suspenders: if the freshly imported engram still isn't in the
    // enumerated list, fetch it explicitly (listSources by graphId, which
    // doesn't depend on graph enumeration) and merge so the user sees the new
    // skills immediately rather than after a page revisit.
    if (intoGraph && !skillsLibrary.some((s) => s.graphId === intoGraph)) {
      try {
        const justImported = (await ipcCall<SkillListEntry[]>('skill:list', { graphId: intoGraph })) ?? [];
        const seen = new Set(skillsLibrary.map((s) => s.sourceId));
        skillsLibrary = [...skillsLibrary, ...justImported.filter((s) => !seen.has(s.sourceId))];
      } catch (e) {
        console.warn('[skills] per-graph skill:list fallback failed', e);
      }
    }
    populateSkillsEngramPickers();
    renderSkillsLibrary();
    app().finishIngestToast(
      importToastId,
      'success',
      `Imported ${n} skill${n === 1 ? '' : 's'} into "${result.engramName ?? graphId}"${verifiedTag}${skippedTag}`,
    );
    void warmVitalityCache();
    // Open the freshly imported skill immediately so the user lands on it
    // instead of having to hunt for it in the library. With a multi-skill
    // pack we surface the first; the rest are one click away in the list.
    const first = result.imported?.[0];
    if (first?.sourceId && intoGraph) {
      void openSkillInTrainer(first.sourceId, intoGraph);
    }
  } catch (e) {
    console.warn('[skills] importGsk failed', e);
    const msg = e instanceof Error ? e.message : String(e);
    app().finishIngestToast(importToastId, 'error', `Import failed: ${msg}`);
  }
}

/**
 * Render the destination picker modal for a .gsk import. Resolves with the
 * user's choice — either an existing graphId, or a name for a new engram to
 * create — or null if the user cancelled.
 *
 * Per-pack engram is selected by default. The list of existing options is
 * limited to Skills-template engrams so users aren't tempted to dump skills
 * into their general personal engram.
 */
function chooseSkillImportDestination(
  peek: SkillPeekResult,
): Promise<{ newEngramName?: string; existingGraphId?: string } | null> {
  return new Promise((resolve) => {
    const pack = peek.pack!;
    const existing = getLoadedGraphs()
      .filter((g) => !g.metadata.archived && g.loaded !== false && g.metadata.template === 'skill')
      .sort((a, b) => (a.metadata.displayName ?? a.graphId).localeCompare(b.metadata.displayName ?? b.graphId));
    // The recommended slug for the new engram. If a Skills engram with this
    // slug already exists, default to that existing engram instead — users
    // re-importing the same pack should land back in the same engram.
    const proposedSlug = app().slugifyEngramName(pack.displayName);
    const collisionGraph = existing.find((g) => g.graphId === proposedSlug);

    const verifiedBadge = peek.verified
      ? '<span class="g-pack-badge g-pack-badge--verified">✓ verified official pack</span>'
      : pack.kind === 'community'
        ? '<span class="g-pack-badge g-pack-badge--community">community pack</span>'
        : '';
    const skillsList = (peek.skills ?? [])
      .map((s) => `<li>${escapeHtml(s.name)}${s.sensitivityTier === 'sensitive' ? ' <em>(sensitive)</em>' : ''}</li>`)
      .join('');

    const existingOptions = existing
      .map((g) => {
        const id = g.graphId;
        const label = app().formatEngramLabel(g);
        const isCollision = id === proposedSlug;
        const note = isCollision ? ' <em>(matches pack name)</em>' : '';
        return `
          <label class="g-pack-dest-row">
            <input type="radio" name="gts-dest" value="existing:${escapeHtml(id)}"${isCollision ? ' checked' : ''} />
            <span>${escapeHtml(label)}${note}</span>
          </label>`;
      })
      .join('');

    const newSelectedByDefault = !collisionGraph;

    let overlay = document.getElementById('gts-import-modal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'gts-import-modal';
      overlay.className = 'modal-backdrop hidden';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-labelledby="gts-import-title" style="max-width:560px;max-height:85vh;display:flex;flex-direction:column;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px 8px;flex:0 0 auto;">
          <h3 id="gts-import-title" style="margin:0;font-size:15px;">Import skill pack</h3>
          <button type="button" class="modal-close" id="gts-import-close" aria-label="Close" style="background:none;border:none;font-size:18px;color:var(--fg-dim);cursor:pointer;">✕</button>
        </div>
        <div style="overflow-y:auto;flex:1 1 auto;min-height:0;">
        <div style="padding:0 18px 6px;">
          <div style="font-size:15px;font-weight:600;margin-bottom:2px;">${escapeHtml(pack.displayName)}</div>
          <div style="font-size:12px;color:var(--fg-dim);margin-bottom:8px;">
            v${escapeHtml(pack.version)} · by ${escapeHtml(pack.author)} ${verifiedBadge}
          </div>
          ${pack.description ? `<p style="font-size:12px;color:var(--fg-dim);margin:0 0 10px 0;">${escapeHtml(pack.description)}</p>` : ''}
          ${skillsList ? `
            <div style="font-size:12px;color:var(--fg-dim);margin-bottom:4px;">Contains ${peek.skills?.length ?? 0} skill${(peek.skills?.length ?? 0) === 1 ? '' : 's'}:</div>
            <ul style="font-size:12px;color:var(--fg);margin:0 0 12px 18px;padding:0;">${skillsList}</ul>
          ` : ''}
        </div>
        <div style="padding:6px 18px 14px;border-top:1px solid var(--border-dim);">
          <div style="font-size:12px;color:var(--fg-dim);margin-bottom:8px;">Save to:</div>
          <label class="g-pack-dest-row g-pack-dest-row--primary">
            <input type="radio" name="gts-dest" value="new"${newSelectedByDefault ? ' checked' : ''} />
            <span>
              <strong>New engram: "${escapeHtml(pack.displayName)}"</strong>
              <span style="display:block;font-size:11px;color:var(--fg-dim);">recommended — keeps this pack's domain isolated</span>
            </span>
          </label>
          ${existing.length > 0 ? `<div style="max-height:280px;overflow-y:auto;margin-top:4px;">${existingOptions}</div>` : ''}
        </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;padding:12px 18px 14px;flex:0 0 auto;border-top:1px solid var(--border-dim);">
          <button type="button" id="gts-import-cancel" class="btn-ghost btn-sm">Cancel</button>
          <button type="button" id="gts-import-confirm" class="primary btn-sm">Import →</button>
        </div>
      </div>
    `;
    overlay.classList.remove('hidden');

    const close = (result: { newEngramName?: string; existingGraphId?: string } | null): void => {
      overlay?.classList.add('hidden');
      resolve(result);
    };
    document.getElementById('gts-import-close')?.addEventListener('click', () => close(null), { once: true });
    document.getElementById('gts-import-cancel')?.addEventListener('click', () => close(null), { once: true });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); }, { once: true });
    document.getElementById('gts-import-confirm')?.addEventListener('click', () => {
      const checked = overlay?.querySelector<HTMLInputElement>('input[name="gts-dest"]:checked');
      const value = checked?.value ?? 'new';
      if (value === 'new') {
        close({ newEngramName: pack.displayName });
      } else if (value.startsWith('existing:')) {
        close({ existingGraphId: value.slice('existing:'.length) });
      } else {
        close(null);
      }
    }, { once: true });
  });
}

export function showSkillsToast(msg: string, kind: 'success' | 'error'): void {
  // Route through the real ingest-toast stack (addIngestToast +
  // finishIngestToast). The previous implementation looked for a
  // window.showToast global that was never wired, so every Skills
  // success/error fell into the console.log fallback and stayed
  // invisible — turning every silent failure (e.g. unknown_graph,
  // parse_failed, no target engram) into a real debugging puzzle.
  //
  // We still console.log for parity with prior log scraping; the
  // toast surface is the user-visible channel.
  console.log(`[skills:${kind}] ${msg}`);
  try {
    const id = app().addIngestToast('Skills', msg);
    app().finishIngestToast(id, kind, msg);
  } catch (e) {
    // Defensive: if the toast stack isn't mounted (very early init or
    // test harness), don't throw — the console.log above is enough.
    console.warn('[skills] toast surface unavailable:', e);
  }
}

function bindSkillsHandlers(): void {
  // Bind Train FIRST and unguarded so if anything below throws, the
  // critical user-facing button is still wired. The rest of the binds
  // are wrapped in a try/catch so a single broken bind can't cascade
  // into Skills (or anything else) being non-functional.
  document.getElementById('btn-skills-train')?.addEventListener('click', () => void runSkillTraining());
  try {
    _bindSkillsHandlersInner();
  } catch (e) {
    console.warn('[bindSkillsHandlers] non-fatal init error — Skills UI partially wired:', e);
  }
}

// Show/hide the "← New skill" reset affordance in the trainer header. Visible
// whenever the trainer has work in it — review mode (library skill open),
// compose draft text, or an in-flight selection — so the user can always
// start over. Hidden only on the pristine empty compose form where "New skill"
// would be a no-op. Review mode also carries btn-skills-review-new in the
// meta row (always visible while #skills-review is shown).
export function updateSkillsResetButton(): void {
  const back = document.getElementById('btn-skills-trainer-back');
  if (!back) return;
  const reviewOpen = !document.getElementById('skills-review')?.classList.contains('hidden');
  const ta = document.getElementById('skills-input-text') as HTMLTextAreaElement | null;
  const hasComposeDraft = (ta?.value.trim().length ?? 0) > 0;
  const hasActiveSkill = skillsActiveSourceId !== null || skillsActiveResult !== null;
  back.classList.toggle('hidden', !(reviewOpen || hasComposeDraft || hasActiveSkill));
}

/** Return to a blank "Train a skill" compose form from review or compose. */
async function startNewSkill(): Promise<void> {
  const reviewOpen = !document.getElementById('skills-review')?.classList.contains('hidden');
  const ta = document.getElementById('skills-input-text') as HTMLTextAreaElement | null;
  const hasComposeDraft = (ta?.value.trim().length ?? 0) > 0;
  // Review mode is read-only — no unsaved compose work to lose. Confirm only
  // when the user has draft text in the compose form that isn't saved yet.
  if (!reviewOpen && hasComposeDraft) {
    const ok = await app().confirmPermanent(
      'Start a new skill? This clears the trainer form. If you haven’t trained (saved) this skill into an engram yet, do that first — resetting discards the text shown here.',
    );
    if (!ok) return;
  }
  showSkillsComposeMode();
  resetSkillsComposeForm();
}

function _bindSkillsHandlersInner(): void {
  document.getElementById('btn-skills-trainer-back')?.addEventListener('click', () => { void startNewSkill(); });
  document.getElementById('btn-skills-review-new')?.addEventListener('click', () => { void startNewSkill(); });
  document.getElementById('skills-review-vitality')?.addEventListener('click', () => void refreshSkillVitality());
  // In-review Retrain button — same flow as the list row's Retrain action,
  // but reachable from the inspector view so the user doesn't have to go
  // hunt for the row again.
  document.getElementById('btn-skills-review-retrain')?.addEventListener('click', () => {
    const sid = skillsActiveResult?.skillId ?? skillsActiveSourceId;
    const gid = skillsActiveResult?.graphId;
    if (sid && gid) void openSkillInTrainer(sid, gid, { retrain: true });
  });
  document.getElementById('btn-skills-pending-accept')?.addEventListener('click', () => void acceptPendingProposal());
  document.getElementById('btn-skills-pending-reject')?.addEventListener('click', () => void rejectPendingProposal());
  // Output / Changes view toggle in the review section. Both buttons
  // share a global delegated handler keyed off data-view so adding more
  // views later (raw, side-by-side, etc.) is just another button.
  document.querySelectorAll<HTMLButtonElement>('.skills-output-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset['view'] as 'output' | 'diff' | undefined;
      if (view) setOutputView(view);
    });
  });
  // < > navigation for diff hunks. Each click jumps to the next or
  // previous block of consecutive changes; wraps around at the ends.
  document.getElementById('btn-skills-diff-prev')?.addEventListener('click', () => stepDiffHunk(-1));
  document.getElementById('btn-skills-diff-next')?.addEventListener('click', () => stepDiffHunk(1));
  // Draft auto-save — every meaningful input event in the compose form
  // schedules a debounced 500ms write to localStorage. The next time the
  // user opens the Skills tab (or restarts the app), the restore banner
  // offers them their unsaved work back.
  const onDraftInput = (): void => { scheduleSkillsDraftSave(); };
  document.getElementById('skills-input-text')?.addEventListener('input', () => {
    onDraftInput();
    scheduleSkillsChunkPreview();
    updateSkillsResetButton(); // reveal "+ New skill" as soon as there's content
  });
  document.getElementById('skills-input-name')?.addEventListener('input', onDraftInput);
  document.getElementById('skills-input-model')?.addEventListener('change', onDraftInput);
  document.getElementById('skills-input-engram')?.addEventListener('change', () => {
    onDraftInput();
    syncSkillsPreviewWarning();
  });
  document.getElementById('skills-input-breadth')?.addEventListener('change', onDraftInput);
  // Restore / Discard banner buttons.
  document.getElementById('btn-skills-draft-restore')?.addEventListener('click', () => {
    const draft = readSkillsDraft();
    if (draft) applySkillsDraft(draft);
  });
  document.getElementById('btn-skills-draft-discard')?.addEventListener('click', () => {
    clearSkillsDraft();
  });
  // Retrain schedule controls — every interaction persists immediately so
  // the state always matches the UI. The trigger select ALSO swaps which
  // threshold inputs are visible (and saves only when auto-retrain is on).
  document.getElementById('skills-retrain-enabled')?.addEventListener('change', () => void saveRetrainScheduleFromUI());
  document.getElementById('skills-retrain-trigger')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    syncRetrainVisibleFields(v);
    const enabledEl = document.getElementById('skills-retrain-enabled') as HTMLInputElement | null;
    if (enabledEl?.checked) void saveRetrainScheduleFromUI();
  });
  const persistIfEnabled = (): void => {
    const enabledEl = document.getElementById('skills-retrain-enabled') as HTMLInputElement | null;
    if (enabledEl?.checked) void saveRetrainScheduleFromUI();
  };
  document.getElementById('skills-retrain-interval')?.addEventListener('change', persistIfEnabled);
  document.getElementById('skills-retrain-growth')?.addEventListener('change', persistIfEnabled);
  document.getElementById('skills-retrain-vitality')?.addEventListener('change', persistIfEnabled);
  document.querySelectorAll<HTMLInputElement>('input[name="skills-retrain-autonomy"]').forEach((r) => {
    r.addEventListener('change', persistIfEnabled);
  });
  document.getElementById('btn-skills-copy-output')?.addEventListener('click', async () => {
    const text = skillsActiveResult?.trained;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    showSkillsToast('Copied trained output', 'success');
  });
  document.getElementById('btn-skills-export-copy')?.addEventListener('click', () => void exportSkillFromUI('copy'));
  document.getElementById('btn-skills-export-save')?.addEventListener('click', () => void exportSkillFromUI('save'));
  // Format-select change → toggle the inline Pro hint for the GSK option.
  document.getElementById('skills-export-format')?.addEventListener('change', () => {
    void syncSkillsExportProHint();
  });
  document.getElementById('btn-skills-fallback')?.addEventListener('click', () => void runSkillsFallbackTraining());
  document.getElementById('btn-skills-upgrade')?.addEventListener('click', (e) => {
    // The sidecar returns an upgrade_url (always graphnosis.com/upgrade for
    // now). If absent — local-dev case — fall back to the app().BILLING_BASE_URL
    // injected at build time. If we know the cortex email from a previous
    // license, append it so Stripe pre-fills the form.
    const fromSidecar = (e.currentTarget as HTMLElement).dataset['url'];
    const cachedEmail = localStorage.getItem(app().BILLING_EMAIL_KEY) ?? '';
    const base = fromSidecar && fromSidecar.length > 0 ? fromSidecar : `${app().BILLING_BASE_URL}/upgrade`;
    const url = cachedEmail
      ? `${base}${base.includes('?') ? '&' : '?'}email=${encodeURIComponent(cachedEmail)}`
      : base;
    // Use the Tauri opener plugin (same convention as the rest of main.ts);
    // fall back to open_external_url (our own Rust command) and finally to
    // window.open in case the user is in a non-Tauri preview.
    void invoke('plugin:opener|open_url', { url })
      .catch(() => invoke('open_external_url', { url }))
      .catch(() => { window.open(url, '_blank'); });
  });
  document.getElementById('skills-library-sort')?.addEventListener('change', (e) => {
    skillsLibrarySort = (e.target as HTMLSelectElement).value as typeof skillsLibrarySort;
    renderSkillsLibrary();
  });
  document.getElementById('skills-library-filter')?.addEventListener('input', (e) => {
    skillsFilterText = (e.target as HTMLInputElement).value;
    renderSkillsLibrary();
  });
  document.getElementById('skills-library-engram-filter')?.addEventListener('change', (e) => {
    skillsFilterEngram = (e.target as HTMLSelectElement).value;
    renderSkillsLibrary();
  });
  document.getElementById('btn-skills-library-refresh')?.addEventListener('click', () => {
    // Re-fetch the skills library from the sidecar so newly-ingested skills
    // (e.g. bundled demos that just landed, or a .gsk import that finished
    // in the background) surface in the list. Without this, refresh was a
    // no-op visually — it only cleared the vitality cache.
    skillsVitalityCache.clear();
    scheduleSkillsLibraryRefresh();
  });
  document.getElementById('btn-skills-show-hidden')?.addEventListener('click', () => {
    skillsShowHidden = !skillsShowHidden;
    renderSkillsLibrary();
  });
  // ── Import .gsk skill pack ───────────────────────────────────────────────
  //
  // The Upload button drives runGskImport(), which opens a native OS picker
  // via the Rust `pick_gsk_file` command (Tauri webviews don't reliably show
  // the picker when JS calls `.click()` on a hidden <input type="file">),
  // peeks at the pack metadata via `skill:peekGsk`, shows a destination-engram
  // modal, then ingests via `skill:importGsk` into the chosen engram.
  const gtsBtn = document.getElementById('btn-skills-import-gts') as HTMLButtonElement | null;
  gtsBtn?.addEventListener('click', () => { void runGskImport(); });
  // Live label on the breadth slider.
  document.getElementById('skills-input-breadth')?.addEventListener('input', (e) => {
    const v = (e.target as HTMLInputElement).value;
    const live = document.getElementById('skills-input-breadth-live');
    if (live) live.textContent = v;
  });

  // ── MemoryStudio banner inline navigation ──────────────────────────────
  //
  // The praxis-extended banner copy carries two interactive surfaces:
  //   • data-studio-banner-jump="<chip>"  — switches the active chip to
  //     Remember or Edit so the user can feed the cortex before training.
  //   • data-studio-banner-doclink="<page>" — opens the relevant docs
  //     guide through the system's default browser (via the Tauri opener
  //     plugin; falls back to window.open for non-Tauri previews).
  document.querySelectorAll<HTMLElement>('[data-studio-banner-jump]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const which = el.dataset['studioBannerJump'] as StudioTool | undefined;
      if (which) app().switchStudioTool(which);
    });
  });
  document.querySelectorAll<HTMLAnchorElement>('[data-studio-banner-doclink]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const href = el.getAttribute('href');
      if (!href) return;
      void invoke('plugin:opener|open_url', { url: href })
        .catch(() => invoke('open_external_url', { url: href }))
        .catch(() => { window.open(href, '_blank'); });
    });
  });
  // Banner-internal mode jumps — currently only "Add files to engram"
  // which routes the user to the Sources mode. Same pattern as the chip
  // jump-links above; uses app().activateMode() instead of app().switchStudioTool()
  // because Sources is a top-level mode, not a MemoryStudio sub-tool.
  document.querySelectorAll<HTMLElement>('[data-studio-banner-mode]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const mode = el.dataset['studioBannerMode'] as Mode | undefined;
      if (mode) app().activateMode(mode);
    });
  });
  // "+ Create Skill engram" — inline engram creation. Skills are saved into
  // engrams with template === 'skill'; when no such engram exists yet, this
  // is the only path to a working trainer save.
  // Inline create-engram flow. window.prompt() doesn't render in Tauri's
  // WKWebView, so we use a slide-in input row instead of the legacy prompt.
  // Cancel hides the row; Create runs the programmatic createSkillsEngramQuiet
  // helper (no prompt internally) and selects the new engram on success.
  {
    const createBtn   = document.getElementById('btn-skills-create-engram') as HTMLButtonElement | null;
    const row         = document.getElementById('skills-create-engram-row');
    const nameInput   = document.getElementById('skills-create-engram-name') as HTMLInputElement | null;
    const confirmBtn  = document.getElementById('btn-skills-create-engram-confirm') as HTMLButtonElement | null;
    const cancelBtn   = document.getElementById('btn-skills-create-engram-cancel') as HTMLButtonElement | null;

    const closeRow = (): void => {
      row?.classList.add('hidden');
      if (nameInput) nameInput.value = 'Skills';
      if (createBtn) createBtn.disabled = false;
    };

    const submit = async (): Promise<void> => {
      const name = nameInput?.value.trim() ?? '';
      if (!name) {
        showSkillsToast('Engram name is empty.', 'error');
        nameInput?.focus();
        return;
      }
      if (confirmBtn) confirmBtn.disabled = true;
      const created = await createSkillsEngramQuiet(name);
      if (confirmBtn) confirmBtn.disabled = false;
      if (created) closeRow();
    };

    createBtn?.addEventListener('click', () => {
      row?.classList.remove('hidden');
      createBtn.disabled = true;
      // Defer focus/select to next frame so the hidden→visible transition lands.
      requestAnimationFrame(() => { nameInput?.focus(); nameInput?.select(); });
    });
    cancelBtn?.addEventListener('click', closeRow);
    confirmBtn?.addEventListener('click', () => { void submit(); });
    nameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeRow(); }
    });
  }

  // Preview-mode warning — toggle the inline ⚠️ note whenever the target
  // dropdown changes. Also run once at bind time so the initial state
  // (which defaults to '__preview__' when no Skills engram exists) is
  // reflected immediately on first render.
  // Belt-and-suspenders: delegated listener so the warning re-syncs even if the
  // compose form was re-rendered after bind time.
  document.addEventListener('change', (e) => {
    if ((e.target as HTMLElement | null)?.id === 'skills-input-engram') syncSkillsPreviewWarning();
  });
}
// ── Auto-height textareas & inputs ───────────────────────────────────────────

function autoResizeTextarea(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}
// Both multi-line textareas and single-line-start inputs (now also textareas)
document.querySelectorAll<HTMLTextAreaElement>('.studio-textarea, .studio-text-input').forEach((ta) => {
  // Skip the Skills compose textarea — it manages its own height via the
  // expand/collapse button below it. Auto-resize would defeat the
  // "compact-by-default" UX (pastes would grow the textarea to N lines).
  if (ta.id === 'skills-input-text') return;
  ta.addEventListener('input', () => autoResizeTextarea(ta));
  // Submit on Enter (no newline) for single-line query inputs; Shift+Enter still inserts
  if (ta.classList.contains('studio-text-input')) {
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
    });
  }
});

// ── Skill text expand/collapse ─────────────────────────────────────────────
// Compact-first behavior: the textarea has a fixed 140px height. When the
// content overflows that, we mark the textarea with .has-overflow which
// reveals the dark-gray expand handle attached below it. Clicking the
// handle expands the textarea to fit the full text (capped at viewport).
// State is transient — fresh tab visit always opens collapsed. We also
// re-evaluate overflow on collapse so the handle hides itself if the
// content has been deleted.
{
  const ta = document.getElementById('skills-input-text') as HTMLTextAreaElement | null;
  const btn = document.getElementById('btn-skills-input-expand') as HTMLButtonElement | null;
  if (ta && btn) {
    const COLLAPSED_HEIGHT_PX = 140;
    const syncOverflow = (): void => {
      // Only meaningful in collapsed mode — in expanded mode the textarea
      // grows to fit content so scrollHeight always matches clientHeight.
      // Keep the handle visible when expanded so the user can collapse back.
      if (ta.classList.contains('expanded')) {
        ta.classList.add('has-overflow');
        return;
      }
      const overflows = ta.scrollHeight > COLLAPSED_HEIGHT_PX + 2;
      ta.classList.toggle('has-overflow', overflows);
    };
    // Detect overflow on every meaningful content change.
    ta.addEventListener('input', syncOverflow);
    ta.addEventListener('paste', () => { setTimeout(syncOverflow, 0); });
    ta.addEventListener('change', syncOverflow);
    btn.addEventListener('click', () => {
      const expanded = ta.classList.toggle('expanded');
      btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      btn.title = expanded ? 'Collapse the editor' : 'Expand the editor to see the full text';
      btn.setAttribute('aria-label', expanded ? 'Collapse the editor' : 'Expand the editor');
      syncOverflow();
    });
    // Initial sync in case content is restored on page load.
    syncOverflow();
  }
}


/** Drop hidden-skill localStorage entries for a graph being deleted. */
export function removeHiddenSkillsForGraph(graphId: string): void {
  const orphanedHidden = skillsLibrary
    .filter((s) => s.graphId === graphId)
    .map((s) => s.sourceId);
  orphanedHidden.forEach((id) => getSkillsHiddenSet().delete(id));
  if (orphanedHidden.length > 0) persistSkillsHidden();
}

export function getSkillsHiddenSet(): Set<string> {
  return skillsHiddenSet;
}

function wireSkillsTextExpand(): void {
  const ta = document.getElementById('skills-input-text') as HTMLTextAreaElement | null;
  const btn = document.getElementById('btn-skills-input-expand') as HTMLButtonElement | null;
  if (!ta || !btn) return;
  const COLLAPSED_HEIGHT_PX = 140;
  const syncOverflow = (): void => {
    if (ta.classList.contains('expanded')) {
      ta.classList.add('has-overflow');
      return;
    }
    const overflows = ta.scrollHeight > COLLAPSED_HEIGHT_PX + 2;
    ta.classList.toggle('has-overflow', overflows);
  };
  ta.addEventListener('input', syncOverflow);
  ta.addEventListener('paste', () => { setTimeout(syncOverflow, 0); });
  ta.addEventListener('change', syncOverflow);
  btn.addEventListener('click', () => {
    const expanded = ta.classList.toggle('expanded');
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.title = expanded ? 'Collapse the editor' : 'Expand the editor to see the full text';
    btn.setAttribute('aria-label', expanded ? 'Collapse the editor' : 'Expand the editor');
    syncOverflow();
  });
  syncOverflow();
}

export function initSkills(): void {
  bindSkillsHandlers();
  wireSkillsTextExpand();
}
