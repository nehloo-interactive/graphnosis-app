import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  Atlas,
  type AtlasNode,
  type AtlasDirectedEdge,
  type AtlasUndirectedEdge,
  type EdgeCategory,
  CATEGORY_COLOR,
  CATEGORY_LABEL,
} from './atlas';

// ---- types matching Rust ------------------------------------------------

interface StatusSnapshot {
  unlocked: boolean;
  vault_dir: string | null;
  sidecar_running: boolean;
}

interface GraphSummary {
  graphId: string;
  totalNodes: number;
  activeNodes: number;
  softDeletedNodes: number;
  sources: number;
  corrections: number;
  /** Epoch ms of the last successful save on the sidecar side. Bumps on
   *  every mutation (ingest, edit, forget, auto-relink). The App polls
   *  this to know when its node/edge cache is stale. 0 = the engram was
   *  just loaded and hasn't been mutated this session. */
  lastMutationAt: number;
}

interface SourceRecord {
  sourceId: string;
  kind: string;
  ref: string;
  graphId: string;
  nodeIds: string[];
  ingestedAt: number;
}

interface StatsSummary {
  graphs: GraphSummary[];
  sources: SourceRecord[];
}

// Recovery shapes — keep in sync with host.ts. Status names are the strings
// the sidecar emits; we render them with per-status CSS classes.
type RecoveryStatus =
  | 'pending'
  | 'recoverable'
  | 'already-present'
  | 'file-missing'
  | 'url-refetch-not-implemented'
  | 'content-not-in-oplog';

interface RecoveryPlanItem {
  sourceId: string;
  graphId: string;
  kind: 'file' | 'url' | 'ai-conversation' | 'clip';
  ref: string;
  contentHash?: string;
  ingestedAt: number;
  status: RecoveryStatus;
}

interface RecoveryPlan {
  total: number;
  recoverable: number;
  items: RecoveryPlanItem[];
}

interface RecoveryOutcome {
  sourceId: string;
  ref: string;
  ok: boolean;
  error?: string;
  skipped?: 'already-present';
}

interface RecoveryReport {
  attempted: number;
  recovered: number;
  skipped: number;
  failed: number;
  outcomes: RecoveryOutcome[];
}

interface ClaudeConfigResult {
  config_path: string;
  relay_path: string;
  node_path: string;
  socket_path: string;
  already_configured: boolean;
  created_file: boolean;
  preserved_servers: string[];
}

type ContentCacheMode = 'all' | 'ephemeral-only' | 'off';
type ForgetMode = 'soft' | 'purge';
interface AppSettings {
  contentCache: {
    mode: ContentCacheMode;
    maxBytesPerSource: number;
  };
  forget: {
    mode: ForgetMode;
  };
  mcpRelay: {
    initialWaitMs: number;
    reconnectMs: number;
  };
  ui: {
    inspectorDetail: InspectorDetail;
  };
  ai: {
    /** When ON, the sidecar's MCP `initialize` response includes a high-
     *  priority routing block telling the AI to use Graphnosis as the
     *  default memory layer. Default true. */
    useAsDefaultMemory: boolean;
    /** Cap on active node count above which the sidecar skips the
     *  post-ingest cross-doc relink pass (entity Jaccard is O(N²)).
     *  Default 5000. Set 0 to disable. Optional in the wire shape so
     *  older clients can omit; the sidecar fills in the current value. */
    autoRelinkMaxNodes?: number;
  };
  graphMetadata?: Record<string, GraphMetadata>;
}

// Keep in sync with MIN/MAX_RELAY_* in app-core. The UI clamps at these
// values too so the input never sends invalid values to the sidecar.
const RELAY_INITIAL_MIN_MS = 2_000;
const RELAY_INITIAL_MAX_MS = 120_000;
const RELAY_RECONNECT_MIN_MS = 5_000;
const RELAY_RECONNECT_MAX_MS = 24 * 60 * 60 * 1000; // 24h — see app-core settings

type InspectorDetail = 'simple' | 'detailed';
type GraphTemplate =
  | 'personal' | 'journal' | 'reading' | 'learning'
  | 'project' | 'research' | 'codebase' | 'health'
  | 'team' | 'compliance' | 'onboarding';

interface GraphMetadata {
  template: GraphTemplate;
  displayName: string;
  createdAt: number;
}
interface GraphWithMetadata { graphId: string; metadata: GraphMetadata; }

interface NodeRecord {
  id: string;
  confidence: number;
  validUntil?: number;
  sourceFile: string;
  contentPreview: string;
  /** Section heading the node lives under (markdown `#`/`##` etc.). */
  section?: string;
  /** SDK NodeType — 'fact' | 'concept' | 'section' | 'document' | … */
  nodeType?: string;
  /** SDK-extracted entities (proper nouns, dates, acronyms, technical
   *  terms, …). Used by the App's entity-aware candidate ranking when
   *  surfacing "what other memories mention this person/place/topic?"
   *  in the typed-relationship suggestion panel. Empty/undefined if the
   *  node never went through entity extraction. */
  entities?: string[];
}

interface SearchHit { nodeId: string; score: number; text: string; type?: string }

// Catalogue of graph templates. `tier: free` are creatable; `power` and
// `enterprise` show with a lock for now (creation gated until pricing lands).
interface GraphTemplateDef {
  id: GraphTemplate;
  tier: 'free' | 'power' | 'enterprise';
  title: string;
  desc: string;
}
const GRAPH_TEMPLATES: GraphTemplateDef[] = [
  { id: 'personal', tier: 'free', title: 'Personal',
    desc: 'Your daily catch-all. Anything goes — work, life, ideas, references.' },
  { id: 'journal', tier: 'free', title: 'Journal',
    desc: 'Time-ordered reflections. Nodes get strong temporal indexing.' },
  { id: 'reading', tier: 'free', title: 'Reading',
    desc: 'Books, articles, papers. Nodes carry citation provenance.' },
  { id: 'learning', tier: 'free', title: 'Learning',
    desc: 'Study notes with spaced-repetition hints baked in.' },

  { id: 'project', tier: 'power', title: 'Project',
    desc: 'Milestones, decisions, artifacts. Tagged by phase.' },
  { id: 'research', tier: 'power', title: 'Research',
    desc: 'Hypotheses, evidence chains. Contradictions surface inline.' },
  { id: 'codebase', tier: 'power', title: 'Codebase',
    desc: 'Symbols, architecture decisions. Pairs with Cursor / Zed recall.' },
  { id: 'health', tier: 'power', title: 'Health',
    desc: 'Daily metrics + episodes. Locked policy: never shared with consumer AI.' },

  { id: 'team', tier: 'enterprise', title: 'Team',
    desc: 'Shared graph. Role-permissioned. Recall audit logged.' },
  { id: 'compliance', tier: 'enterprise', title: 'Compliance',
    desc: 'Append-only. eDiscovery-friendly export. Retention rules.' },
  { id: 'onboarding', tier: 'enterprise', title: 'Onboarding',
    desc: 'Institutional memory. Lifecycle-managed (offboard wipe).' },
];

interface OpLogEvent {
  id: string;
  ts: number;
  deviceId: string;
  sessionId: string;
  graphId: string;
  op: 'addNode' | 'editNode' | 'deleteNode' | 'addEdge' | 'deleteEdge' | 'supersede' | 'merge' | 'ingestSource' | 'forgetSource';
  target: { kind: 'node' | 'edge' | 'source'; id: string };
  before?: unknown;
  after?: unknown;
}

interface SnapshotInfo {
  id: string;
  createdAt: number;
  sizeBytes: number;
  fileCount: number;
}

// Loaded graphs metadata cache. Populated on unlock via
// list_graphs_with_metadata. Drives engram pickers across the app.
let loadedGraphs: GraphWithMetadata[] = [];

// State for the Graphnosis check-in dashboard. Two tabs (Check-in / Atlas);
// the Check-in tab shows a triage dashboard by default and a results list
// when there's an active search. The Atlas tab renders the 3D viz on the
// shared selection state below.
type GraphnosisTab = 'checkin' | 'atlas';
let graphnosisActiveTab: GraphnosisTab = 'checkin';
let graphnosisListRows: NodeRecord[] = []; // current visible search results
let graphnosisAllNodes: NodeRecord[] = []; // unfiltered cache for the active engram
let graphnosisSelectedId: string | null = null;
let graphnosisSearchTimer: ReturnType<typeof setTimeout> | null = null;
let graphnosisListMode: 'substring' | 'semantic' = 'substring';
let graphnosisSemanticToken = 0; // race-guard

// Review deck state: queue of items waiting for the user's quick verdict,
// plus a set of node IDs the user has already touched this session (so
// the deck doesn't keep showing the same memory after a "Looks right").
interface DeckItem {
  /** For `pending-correction` cards the deck "node" is a synthesized
   *  stand-in built from the first edit's target — it's just enough
   *  for the breadcrumb + node lookup to work. The full diff payload
   *  lives on `pendingDiff`. */
  node: NodeRecord;
  prompt: string;   // plain-English question above the content
  reason: 'low-confidence' | 'orphan' | 'connect' | 'pending-correction';
  /** Set for `connect` cards: the entity that bridges this node to ≥3
   *  others. Interpolated into the prompt and used as the auto-pick
   *  ranking signal for the suggestion panel. */
  bridgeEntity?: string;
  /** Set for `pending-correction` cards: the AI-proposed diff awaiting
   *  the user's approval. The deck card renders the diff preview and
   *  exposes Approve / Reject actions that route through the existing
   *  `apply_correction` / `reject_correction` Tauri commands. */
  pendingDiff?: PendingDiff;
}
let graphnosisDeck: DeckItem[] = [];
let graphnosisDeckIndex = 0;
const graphnosisSessionDispatched = new Set<string>(); // nodeIds confirmed/skipped/fixed this session
let graphnosisTendedThisSession = 0; // counter shown in the recap row
let graphnosisOrphanIds: Set<string> = new Set(); // nodes with no edges, recomputed per data load

// AI-proposed correction diffs awaiting the user's approval. Polled by
// fetchPendingCorrections; surfaced as top-priority `pending-correction`
// cards in the deck queue (folded in here after the user wanted the
// Corrections rail tab removed). Cleared on vault lock.
let graphnosisPendingDiffs: PendingDiff[] = [];

// Per-session cache of "related memories" by source node id, populated
// on-demand via the BGE-semantic search IPC. Used by the detail pane and
// the deck card to surface candidate links for orphan / unrelated memories.
// Cleared when the active engram changes or after a successful link (so
// linked items don't keep being suggested).
interface RelatedItem {
  nodeId: string;
  score: number;
  contentPreview: string;
  sourceFile: string;
}
const graphnosisRelatedCache: Map<string, RelatedItem[]> = new Map();
// Recents are kept per-engram so switching graphs doesn't blow away the
// trail of memories you were just touching in the other one. The map
// keys on graphId; values are node IDs newest-first. Cleared when the
// vault locks (we don't persist this across sessions).
const graphnosisRecentsByGraph: Map<string, string[]> = new Map();
const GRAPHNOSIS_RECENTS_MAX = 6;
function currentRecents(): string[] {
  return atlasActiveGraph ? graphnosisRecentsByGraph.get(atlasActiveGraph) ?? [] : [];
}
let graphnosisEditingId: string | null = null; // node currently in inline-edit mode
// Two-tap inline confirm for the sidebar Forget button. First click sets
// this to the node's id (button turns red, label changes); second click
// actually forgets. We avoid window.confirm() because it can be missed
// or behave oddly in the webview. Auto-resets after a few seconds.
let graphnosisForgetArming: { nodeId: string; resetTimer: ReturnType<typeof setTimeout> } | null = null;

// State for the graph wizard.
let gwSelected: GraphTemplate | null = null;

type DiffEdit =
  | { kind: 'edit'; nodeId: string; content: string; reason: string }
  | { kind: 'supersede'; nodeId: string; content: string; reason: string }
  | { kind: 'delete'; nodeId: string; reason: string };

interface DiffAdd { text: string; label?: string }

interface PendingDiff {
  diffId: string;
  graphId: string;
  createdAt: number;
  reasoning: string | null;
  edits: DiffEdit[];
  adds: DiffAdd[];
}

interface McpConnection {
  id: string;
  transport: 'socket' | 'stdio';
  connectedAt: number;
  lastActivityAt: number;
  clientName?: string;
  clientVersion?: string;
  requestCount: number;
}

interface PurgeReport {
  beforeTotalNodes: number;
  beforeActiveNodes: number;
  beforeSoftDeletedNodes: number;
  afterTotalNodes: number;
  sourcesRebuilt: number;
  sourcesSkipped: number;
  errors: Array<{ sourceId: string; ref: string; error: string }>;
  noop?: boolean;
  aborted?: boolean;
}

// ---- DOM helpers --------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const els = {
  err: $<HTMLDivElement>('error'),
  viewUnlock: $<HTMLElement>('view-unlock'),
  viewApp: $<HTMLElement>('view-app'),
  vaultDir: $<HTMLInputElement>('vault-dir'),
  passphrase: $<HTMLInputElement>('passphrase'),
  btnPick: $<HTMLButtonElement>('btn-pick'),
  btnUnlock: $<HTMLButtonElement>('btn-unlock'),
  unlockStatus: $<HTMLSpanElement>('unlock-status'),
  btnRefresh: $<HTMLButtonElement>('btn-refresh'),
  btnOpenFolder: $<HTMLButtonElement>('btn-open-folder'),
  btnLock: $<HTMLButtonElement>('btn-lock'),
  btnAddFile: $<HTMLButtonElement>('btn-add-file'),
  vaultLabel: $<HTMLSpanElement>('vault-label'),
  sourcesList: $<HTMLDivElement>('sources-list'),
  dropZone: $<HTMLDivElement>('drop-zone'),
  toastStack: $<HTMLDivElement>('g-toast-stack'),
  btnRecover: $<HTMLButtonElement>('btn-recover'),
  recoveryModal: $<HTMLDivElement>('recovery-modal'),
  recoveryTitle: $<HTMLHeadingElement>('recovery-title'),
  recoverySubtitle: $<HTMLParagraphElement>('recovery-subtitle'),
  recoveryBody: $<HTMLDivElement>('recovery-body'),
  recoveryFooterNote: $<HTMLSpanElement>('recovery-footer-note'),
  btnRecoveryClose: $<HTMLButtonElement>('btn-recovery-close'),
  btnRecoveryApply: $<HTMLButtonElement>('btn-recovery-apply'),
  btnSettings: $<HTMLButtonElement>('btn-settings'),
  relayInitial: $<HTMLInputElement>('relay-initial'),
  relayReconnect: $<HTMLInputElement>('relay-reconnect'),
  // (Nodes rail pane removed — its els refs went with it.)
  // Pending-correction badge — now lives on the Graphnosis rail item
  // since the Corrections rail tab was removed (diffs surface as deck
  // cards instead).
  railCorrectionsBadge: $<HTMLSpanElement>('rail-corrections-badge'),
  // New-graph wizard
  btnNewGraph: $<HTMLButtonElement>('btn-new-graph'),
  graphWizardModal: $<HTMLDivElement>('graph-wizard-modal'),
  gwFree: $<HTMLDivElement>('gw-free'),
  gwPower: $<HTMLDivElement>('gw-power'),
  gwEnterprise: $<HTMLDivElement>('gw-enterprise'),
  gwName: $<HTMLInputElement>('gw-name'),
  gwId: $<HTMLInputElement>('gw-id'),
  gwNote: $<HTMLSpanElement>('gw-note'),
  btnGwCancel: $<HTMLButtonElement>('btn-gw-cancel'),
  btnGwCreate: $<HTMLButtonElement>('btn-gw-create'),
  // Status bar
  statusMcpDot: $<HTMLSpanElement>('status-mcp-dot'),
  statusMcpText: $<HTMLSpanElement>('status-mcp-text'),
  statusSaved: $<HTMLSpanElement>('status-saved'),
  // Graphnosis (Check-in dashboard + 3D Atlas)
  gSearch: $<HTMLInputElement>('g-search'),
  gSearchClear: $<HTMLButtonElement>('g-search-clear'),
  gSearchSortSelect: $<HTMLSelectElement>('g-search-sort-select'),
  gRecents: $<HTMLDivElement>('g-recents'),
  gRecentsChips: $<HTMLDivElement>('g-recents-chips'),
  gDashboard: $<HTMLDivElement>('g-dashboard'),
  gSearchResults: $<HTMLDivElement>('g-search-results'),
  gSearchResultsStats: $<HTMLDivElement>('g-search-results-stats'),
  gList: $<HTMLDivElement>('g-list'),
  gHealth: $<HTMLDivElement>('g-health'),
  gHealthGrade: $<HTMLDivElement>('g-health-grade'),
  gHealthFill: $<HTMLDivElement>('g-health-fill'),
  gHealthPhrase: $<HTMLParagraphElement>('g-health-phrase'),
  gHealthDetail: $<HTMLParagraphElement>('g-health-detail'),
  gDeck: $<HTMLDivElement>('g-deck'),
  gDeckCard: $<HTMLDivElement>('g-deck-card'),
  gDeckProgress: $<HTMLSpanElement>('g-deck-progress'),
  gDeckCardHead: $<HTMLDivElement>('g-deck-card-head'),
  btnDeckPrev: $<HTMLButtonElement>('btn-deck-prev'),
  btnDeckNext: $<HTMLButtonElement>('btn-deck-next'),
  gRecapMemories: $<HTMLSpanElement>('g-recap-memories'),
  gRecapSources: $<HTMLSpanElement>('g-recap-sources'),
  gRecapAvg: $<HTMLSpanElement>('g-recap-avg'),
  gRecapCorrections: $<HTMLSpanElement>('g-recap-corrections'),
  gRecapTended: $<HTMLSpanElement>('g-recap-tended'),
  gRecapForgotten: $<HTMLDivElement>('g-recap-forgotten'),
  gRecapForgottenText: $<HTMLSpanElement>('g-recap-forgotten-text'),
  btnGPurge: $<HTMLButtonElement>('btn-g-purge'),
  gMcpList: $<HTMLDivElement>('g-mcp-list'),
  gDetail: $<HTMLElement>('g-detail'),
  gDetailBody: $<HTMLDivElement>('g-detail-body'),
  // Atlas (3D) sub-tab
  atlasContainer: $<HTMLDivElement>('atlas-container'),
  atlasGraphPicker: $<HTMLSelectElement>('atlas-graph-picker'),
  atlasStats: $<HTMLSpanElement>('atlas-stats'),
  btnAtlasReset: $<HTMLButtonElement>('btn-atlas-reset'),
  btnAtlasUnpin: $<HTMLButtonElement>('btn-atlas-unpin'),
  btnAtlasFit: $<HTMLButtonElement>('btn-atlas-fit'),
  btnAtlasAlive: $<HTMLButtonElement>('btn-atlas-alive'),
  atlasLegendList: $<HTMLDivElement>('atlas-legend-list'),
  atlasSourceList: $<HTMLDivElement>('atlas-source-list'),
  // Activity
  activityList: $<HTMLDivElement>('activity-list'),
  activityFilterKind: $<HTMLSelectElement>('activity-filter-kind'),
  activityStats: $<HTMLSpanElement>('activity-stats'),
  btnActivityRefresh: $<HTMLButtonElement>('btn-activity-refresh'),
  // Snapshots
  btnSnapshotsOpen: $<HTMLButtonElement>('btn-snapshots-open'),
  snapshotsModal: $<HTMLDivElement>('snapshots-modal'),
  snapshotsBody: $<HTMLDivElement>('snapshots-body'),
  snapshotsNote: $<HTMLSpanElement>('snapshots-note'),
  btnSnapshotsClose: $<HTMLButtonElement>('btn-snapshots-close'),
  btnSnapshotsCreate: $<HTMLButtonElement>('btn-snapshots-create'),
  btnClaude: $<HTMLButtonElement>('btn-claude'),
  claudeModal: $<HTMLDivElement>('claude-modal'),
  claudeBody: $<HTMLDivElement>('claude-body'),
  claudePreview: $<HTMLDivElement>('claude-preview'),
  claudeFooterNote: $<HTMLSpanElement>('claude-footer-note'),
  btnClaudeClose: $<HTMLButtonElement>('btn-claude-close'),
  btnClaudeApply: $<HTMLButtonElement>('btn-claude-apply'),
  settingsModal: $<HTMLDivElement>('settings-modal'),
  cacheCap: $<HTMLSelectElement>('cache-cap'),
  aiDefaultMemory: $<HTMLInputElement>('ai-default-memory'),
  btnSettingsCancel: $<HTMLButtonElement>('btn-settings-cancel'),
  btnSettingsSave: $<HTMLButtonElement>('btn-settings-save'),
  settingsFooterNote: $<HTMLSpanElement>('settings-footer-note'),
};

// Current plan in the modal — kept in module scope so the Apply button can
// figure out which checkboxes are still checked at click time.
let currentRecoveryPlan: RecoveryPlan | null = null;

// MCP status poller handle. Started after unlock, cleared on lock.
let mcpPollTimer: ReturnType<typeof setInterval> | null = null;

// Latest inspector stats payload. Cached so the Graphnosis dashboard can
// render the active engram's forgotten-on-disk count without re-firing
// the IPC on every recap update. Updated by refreshStats().
let lastInspectorStats: StatsSummary | null = null;

function showError(msg: string | null): void {
  if (!msg) {
    els.err.classList.add('hidden');
    return;
  }
  els.err.textContent = msg;
  els.err.classList.remove('hidden');
}

// ── Ingest toast queue ──────────────────────────────────────────────
//
// Per-file progress + outcome surface. Each `addIngestToast` call
// returns an id; downstream code transitions the toast via
// `finishIngestToast(id, 'success'|'error', message?)`. Success
// auto-dismisses after 4s; errors stick until the user closes them
// so the failure message isn't blink-and-gone.
//
// Two reasons this lives next to showError rather than reusing the
// existing single-banner pattern:
//   1. Batch ingest (multi-file pick / drag) needs N concurrent
//      progress rows, not one shared banner.
//   2. Errors during ingest are durable user feedback — they describe
//      a specific file that needs the user's attention later.

type ToastKind = 'pending' | 'success' | 'error';
let toastSeq = 0;
const liveToasts = new Map<string, HTMLDivElement>();

function addIngestToast(label: string, message?: string): string {
  const id = `t${++toastSeq}`;
  const root = document.createElement('div');
  root.className = 'g-toast g-toast--pending';
  root.dataset.toastId = id;
  root.innerHTML = `
    <span class="g-toast-icon" aria-hidden="true"></span>
    <span class="g-toast-body">
      <span class="g-toast-label"></span>
      <span class="g-toast-msg"></span>
    </span>
    <button class="g-toast-close" title="Dismiss" aria-label="Dismiss">×</button>
  `;
  const labelEl = root.querySelector('.g-toast-label') as HTMLSpanElement;
  const msgEl = root.querySelector('.g-toast-msg') as HTMLSpanElement;
  const closeBtn = root.querySelector('.g-toast-close') as HTMLButtonElement;
  labelEl.textContent = label;
  if (message) msgEl.textContent = message; else msgEl.style.display = 'none';
  closeBtn.addEventListener('click', () => removeIngestToast(id));
  els.toastStack.appendChild(root);
  // Force layout so the transition runs.
  requestAnimationFrame(() => root.classList.add('visible'));
  liveToasts.set(id, root);
  return id;
}

function updateIngestToast(id: string, patch: { label?: string; message?: string }): void {
  const root = liveToasts.get(id);
  if (!root) return;
  if (patch.label !== undefined) {
    const labelEl = root.querySelector('.g-toast-label') as HTMLSpanElement;
    labelEl.textContent = patch.label;
  }
  if (patch.message !== undefined) {
    const msgEl = root.querySelector('.g-toast-msg') as HTMLSpanElement;
    msgEl.textContent = patch.message;
    msgEl.style.display = patch.message ? '' : 'none';
  }
}

function finishIngestToast(id: string, kind: 'success' | 'error', message?: string): void {
  const root = liveToasts.get(id);
  if (!root) return;
  root.classList.remove('g-toast--pending');
  root.classList.add(kind === 'success' ? 'g-toast--success' : 'g-toast--error');
  if (message !== undefined) updateIngestToast(id, { message });
  // Success auto-dismisses; errors persist so the user can read them.
  if (kind === 'success') {
    window.setTimeout(() => removeIngestToast(id), 4_000);
  }
}

function removeIngestToast(id: string): void {
  const root = liveToasts.get(id);
  if (!root) return;
  root.classList.remove('visible');
  // Match the CSS transition (140ms) before yanking from DOM.
  window.setTimeout(() => root.remove(), 180);
  liveToasts.delete(id);
}

/**
 * Run a single-file ingest with a toast. Used by the Add-file button,
 * the drag-drop handler, and the multi-file batch. Returns the result
 * (so callers can chain follow-up work) or rethrows on failure.
 *
 * The IPC `ingest.file` returns `{ sourceId, nodeIds: string[] }` on
 * success; we surface nodeIds.length so the user sees "Saved 5 nodes
 * from handbook.pdf" rather than the opaque source id.
 */
async function ingestSingleFile(path: string): Promise<unknown> {
  const fileName = path.split('/').pop() ?? path;
  const toastId = addIngestToast(`Ingesting ${fileName}…`);
  try {
    const result = (await invoke('ingest_file', { graphId: null, path })) as {
      sourceId?: string;
      nodeIds?: string[];
    };
    const n = result?.nodeIds?.length ?? 0;
    finishIngestToast(toastId, 'success', n > 0 ? `Saved ${n} node${n === 1 ? '' : 's'}` : 'Saved');
    return result;
  } catch (e) {
    finishIngestToast(toastId, 'error', String(e));
    throw e;
  }
}

function render(status: StatusSnapshot): void {
  if (status.unlocked) {
    els.viewUnlock.classList.add('hidden');
    els.viewApp.classList.remove('hidden');
    els.vaultLabel.textContent = shortVaultLabel(status.vault_dir ?? 'vault');
    void refreshStats();
    void fetchGraphsMetadata();
    startMcpPolling();
    activateMode(currentMode);
  } else {
    els.viewApp.classList.add('hidden');
    els.viewUnlock.classList.remove('hidden');
    stopMcpPolling();
  }
}

function shortVaultLabel(p: string): string {
  // Take last two path segments to keep the header compact but recognizable.
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join('/')}`;
}

// ── View router ────────────────────────────────────────────────────────

type Mode = 'atlas' | 'sources' | 'activity' | 'status' | 'settings';
// Graphnosis (mode='atlas') is the default landing pane post-unlock. The
// internal symbol stays 'atlas' for backwards compatibility with the
// existing DOM data-pane attributes.
let currentMode: Mode = 'atlas';

function activateMode(mode: Mode): void {
  currentMode = mode;
  // Rail button visual state
  document.querySelectorAll<HTMLButtonElement>('.rail-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  // Pane visibility
  document.querySelectorAll<HTMLElement>('.mode-pane').forEach((p) => {
    p.classList.toggle('hidden', p.dataset.pane !== mode);
  });
  // Lazy-load per mode
  if (mode === 'sources') void refreshStats(); // sources list rendered inside refreshStats payload
  if (mode === 'atlas') void refreshAtlasView();
  if (mode === 'activity') void refreshActivityView();
  if (mode === 'status') {
    // Status pane re-uses the same data the Graphnosis recap reads.
    // refreshStats() repopulates lastInspectorStats which then drives
    // updateRecap + the forgotten/Purge footer.
    void refreshStats();
    updateRecap();
    void fetchMcpStatus();
  }
}

// Wire the rail buttons once on module load.
document.querySelectorAll<HTMLButtonElement>('.rail-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const m = btn.dataset.mode as Mode | undefined;
    if (m) activateMode(m);
  });
});

function friendlyClient(name?: string): string {
  if (!name) return 'Unknown client';
  // Map known MCP client identifiers to nicer display names. Exact matches
  // first, then prefix patterns for clients that namespace by server name.
  const map: Record<string, string> = {
    'claude-ai': 'Claude Desktop',
    'claude-desktop': 'Claude Desktop',
    'claude-code': 'Claude Code',
    'cursor-vscode': 'Cursor',
    'cursor': 'Cursor',
    'zed': 'Zed',
    'windsurf': 'Windsurf',
  };
  if (map[name]) return map[name] as string;
  // Claude Desktop spawns a per-server "Skills" background agent with the
  // identity `local-agent-mode-<ServerName>` (e.g. `local-agent-mode-Graphnosis`).
  // It's a separate MCP client process from the user-facing app and shows up
  // alongside `claude-ai`.
  if (name.startsWith('local-agent-mode-')) return 'Claude Skills agent';
  return name;
}

function renderMcpStatus(connections: McpConnection[]): void {
  updateStatusBar(connections);
  // Single target now that Overview is gone: the Graphnosis dashboard's
  // AI tools card. The status-bar dot (top) gives the at-a-glance signal
  // from any pane.
  const target = els.gMcpList;
  const reconnectId = 'btn-mcp-reconnect-graphnosis';
  if (connections.length === 0) {
    target.innerHTML = `
      <p class="mcp-empty">
        Nothing tapped in yet. Open Claude Desktop (or your MCP-aware editor)
        — the connection shows up here within a few seconds.
      </p>
      <p class="mcp-empty" style="margin-top: 8px;">
        Already running but stuck? Click <strong>Reconnect</strong> to bounce
        Graphnosis's MCP socket. Any waiting clients will reattach automatically.
        If nothing happens, restart the client (in Claude: ⌘Q, reopen).
      </p>
      <div style="margin-top: 10px;">
        <button id="${reconnectId}">Reconnect</button>
      </div>
    `;
    const btn = document.getElementById(reconnectId) as HTMLButtonElement | null;
    btn?.addEventListener('click', () => void handleMcpReconnect(btn));
    return;
  }
  target.innerHTML = connections
    .map((c) => {
      const name = friendlyClient(c.clientName);
      const version = c.clientVersion ? ` · v${escape(c.clientVersion)}` : '';
      const since = new Date(c.connectedAt).toLocaleTimeString();
      const reqs = c.requestCount === 1 ? '1 request' : `${c.requestCount} requests`;
      const transportLabel = c.transport === 'stdio' ? 'stdio (legacy)' : 'relay';
      return `<div class="mcp-row">
        <span class="mcp-dot" title="Live"></span>
        <div style="flex: 1; min-width: 0;">
          <div class="mcp-client-name">${escape(name)}${version}</div>
          <div class="mcp-meta">Connected ${since} · ${reqs} · ${transportLabel}</div>
        </div>
      </div>`;
    })
    .join('');
}

async function handleMcpReconnect(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Bouncing socket…';
  showError(null);
  try {
    await invoke('mcp_restart_listener');
    btn.textContent = 'Socket restarted · checking…';
    // Wait long enough for any live relay process to detect the new socket
    // and re-handshake (poll interval is ~400ms, handshake adds a beat),
    // then verify by reading the registry. If nothing connected, the
    // user's relay process is dead — the only fix is to restart Claude.
    setTimeout(async () => {
      try {
        const r = (await invoke('mcp_status')) as { connections: McpConnection[] };
        if (r.connections.length > 0) {
          // Live relay reattached — let the normal poll loop take it from here.
          await fetchMcpStatus();
        } else {
          // No relay alive. Bouncing the socket can't help; user needs to
          // restart their MCP client so it spawns a fresh relay process.
          alert(
            'Bounced the socket, but no MCP clients picked it up.\n\n' +
            'This usually means your client (e.g. Claude Desktop) gave up on the ' +
            'previous relay process and needs to be restarted.\n\n' +
            'In Claude Desktop: ⌘Q to quit fully, then reopen. The new Claude session ' +
            'will spawn a fresh relay that connects right away.',
          );
          await fetchMcpStatus();
        }
      } catch (e) {
        showError(`Status check failed: ${e}`);
      }
    }, 2500);
  } catch (e) {
    showError(`Reconnect failed: ${e}`);
    btn.disabled = false;
    btn.textContent = 'Reconnect';
  }
}

async function fetchMcpStatus(): Promise<void> {
  try {
    const r = (await invoke('mcp_status')) as { connections: McpConnection[] };
    renderMcpStatus(r.connections);
  } catch (e) {
    // Vault was locked or sidecar gone — show a quiet idle state rather than
    // spamming the error banner.
    els.gMcpList.innerHTML = `<p class="mcp-empty">MCP status unavailable: ${escape(String(e))}</p>`;
  }
}

// Diff operation → small HTML chunk used inside the pending-correction
// deck card. Same vocabulary the old Corrections rail pane used (EDIT /
// SUPERSEDE / DELETE), just rendered inline now.
function renderDiffOp(op: DiffEdit): string {
  const node = `<span class="mcp-meta">node <code>${escape(op.nodeId.slice(0, 12))}…</code></span>`;
  const reason = `<div class="diff-op-reason">${escape(op.reason)}</div>`;
  if (op.kind === 'delete') {
    return `<div class="diff-op">
      <span class="diff-op-kind delete">DELETE</span>${node}
      ${reason}
    </div>`;
  }
  const kindLabel = op.kind === 'supersede' ? 'SUPERSEDE' : 'EDIT';
  return `<div class="diff-op">
    <span class="diff-op-kind ${op.kind}">${kindLabel}</span>${node}
    <div class="diff-op-content">${escape(op.content)}</div>
    ${reason}
  </div>`;
}

// Called from the deck card's Approve / Reject buttons. Mirrors the
// behavior of the old Corrections rail pane: optimistically advance,
// refresh state on completion.
async function handlePendingDiffAction(diffId: string, action: 'apply' | 'reject'): Promise<void> {
  if (!diffId) return;
  try {
    if (action === 'apply') {
      await invoke('apply_correction', { diffId });
    } else {
      await invoke('reject_correction', { diffId });
    }
    // Drop the diff from in-memory state so the deck queue doesn't
    // re-surface it before the next poller tick refreshes truth.
    graphnosisPendingDiffs = graphnosisPendingDiffs.filter((d) => d.diffId !== diffId);
    if (action === 'apply') {
      graphnosisTendedThisSession++;
      updateRecap();
    }
    rebuildDeckQueue();
    renderDeck();
    void refreshStats();
    void fetchPendingCorrections(); // confirm with sidecar
  } catch (e) {
    showError(`${action} failed: ${e}`);
  }
}

async function fetchPendingCorrections(): Promise<void> {
  try {
    const r = (await invoke('list_pending_corrections')) as { pending: PendingDiff[] };
    // Store in module state; the deck queue reads from this on rebuild.
    // Detect a change to know when to rebuild — avoids re-rendering the
    // deck every poll tick when nothing's new.
    const prevCount = graphnosisPendingDiffs.length;
    const prevIds = new Set(graphnosisPendingDiffs.map((d) => d.diffId));
    graphnosisPendingDiffs = r.pending;
    updatePendingBadge(r.pending.length);
    const changed = r.pending.length !== prevCount
      || r.pending.some((d) => !prevIds.has(d.diffId));
    if (changed && currentMode === 'atlas') {
      // New diff arrived (or one was applied/rejected externally) → fold
      // it into the deck queue and re-render the card.
      rebuildDeckQueue();
      renderDeck();
    }
  } catch {
    // Vault locked / sidecar gone — clear pending state silently.
    graphnosisPendingDiffs = [];
    updatePendingBadge(0);
  }
}

function startMcpPolling(): void {
  if (mcpPollTimer !== null) return;
  // Immediate first paint for both panels + the mutation poll.
  void fetchMcpStatus();
  void fetchPendingCorrections();
  void pollGraphMutations();
  // 3s is a good balance: fast enough that "I just opened Claude" or "Claude
  // just proposed a correction" feels responsive, slow enough not to burn
  // IPC traffic on a static state. The mutation poll piggybacks here so
  // background auto-relink edges + any other sidecar-side change (Claude
  // ingest, applyCorrection) shows up within a tick.
  mcpPollTimer = setInterval(() => {
    void fetchMcpStatus();
    void fetchPendingCorrections();
    void pollGraphMutations();
  }, 3000);
}

// Per-graph "last seen mutation timestamp" cache. Compared against the
// sidecar's `lastMutationAt` on every poll — when it advances, the
// active engram's data gets reloaded so new edges (especially the
// background auto-relink ones) become visible without a manual refresh.
const lastSeenMutationAt: Map<string, number> = new Map();

async function pollGraphMutations(): Promise<void> {
  if (!atlasActiveGraph) return;
  try {
    const data = (await invoke('inspector_stats')) as StatsSummary;
    lastInspectorStats = data;
    let activeChanged = false;
    for (const g of data.graphs) {
      const prev = lastSeenMutationAt.get(g.graphId) ?? 0;
      if (g.lastMutationAt > prev) {
        lastSeenMutationAt.set(g.graphId, g.lastMutationAt);
        if (g.graphId === atlasActiveGraph) activeChanged = true;
      }
    }
    if (!activeChanged) return;
    // Active engram mutated under us — reload nodes + edges. Cheap on
    // small engrams, throttled by the 3s poll cadence on bigger ones.
    await loadGraphnosisData(atlasActiveGraph);
    // Re-render whichever surface is currently in front of the user.
    applyGraphnosisFilter();           // dashboard or search-results
    if (graphnosisSelectedId) renderDetailPane();
    if (mainAtlas && graphnosisActiveTab === 'atlas') pushDataIntoAtlas();
    // Refresh stats UI (recap rows + forgotten footer + corrections counter).
    updateRecap();
    updateGraphnosisForgottenRow();
  } catch {
    // Locked vault / sidecar gone — silent. Other polls will surface the error.
  }
}

function stopMcpPolling(): void {
  if (mcpPollTimer !== null) {
    clearInterval(mcpPollTimer);
    mcpPollTimer = null;
  }
}

async function refreshStats(): Promise<void> {
  els.sourcesList.innerHTML = '<p class="subtitle">Loading…</p>';
  try {
    const data = (await invoke('inspector_stats')) as StatsSummary;
    // Stash for the Graphnosis dashboard so it can render the active
    // engram's forgotten-on-disk count + corrections-applied lifetime
    // counter without a second IPC roundtrip.
    lastInspectorStats = data;
    updateGraphnosisForgottenRow();
    updateRecap(); // Corrections-applied lives on recap; refresh it too.
    // Bump the "last refreshed" timestamp in the status bar.
    if (els.statusSaved) {
      els.statusSaved.textContent = `Refreshed ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (data.sources.length === 0) {
      els.sourcesList.innerHTML = '<p class="subtitle">No sources yet. Use the `remember` MCP tool from Claude or drag a file in.</p>';
    } else {
      els.sourcesList.innerHTML = data.sources
        .slice()
        .sort((a, b) => b.ingestedAt - a.ingestedAt)
        .map(
          (s) => `
          <div class="source-row">
            <span class="source-name" title="${escape(s.ref)}">${escape(s.ref)}</span>
            <span class="source-meta">${s.nodeIds.length} node${s.nodeIds.length === 1 ? '' : 's'}</span>
            <button class="btn-forget" data-graph-id="${escape(s.graphId)}" data-source-id="${escape(s.sourceId)}" data-node-count="${s.nodeIds.length}" data-ref="${escape(s.ref)}">Forget</button>
          </div>
        `,
        )
        .join('');
      // Wire each Forget button — event delegation would also work, but
      // there are typically a handful of sources so direct binding is fine.
      els.sourcesList.querySelectorAll<HTMLButtonElement>('.btn-forget').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const graphId = btn.dataset.graphId ?? '';
          const sourceId = btn.dataset.sourceId ?? '';
          const ref = btn.dataset.ref ?? sourceId;
          const nodeCount = btn.dataset.nodeCount ?? '?';
          if (!graphId || !sourceId) return;
          const ok = confirm(
            `Forget this source?\n\n${ref}\n\n` +
            `${nodeCount} node${nodeCount === '1' ? '' : 's'} will be soft-deleted. ` +
            `The original file is not affected. ` +
            `If content caching is on, the cached copy will also be removed.`,
          );
          if (!ok) return;
          btn.disabled = true;
          btn.textContent = 'Forgetting…';
          try {
            await invoke('forget_source', { graphId, sourceId });
            await refreshStats();
          } catch (e) {
            showError(`Forget failed: ${e}`);
            btn.disabled = false;
            btn.textContent = 'Forget';
          }
        });
      });
    }
  } catch (e) {
    els.sourcesList.innerHTML = `<p class="error">${escape(String(e))}</p>`;
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

// ---- event wiring -------------------------------------------------------

els.btnPick.addEventListener('click', async () => {
  showError(null);
  try {
    const folder = (await invoke('pick_vault_folder')) as string | null;
    if (folder) els.vaultDir.value = folder;
  } catch (e) {
    showError(String(e));
  }
});

els.btnUnlock.addEventListener('click', async () => {
  showError(null);
  // Client-side guards. Sidecar would also reject these, but failing fast in
  // the UI is friendlier than a 30s wait for the timeout error.
  if (!els.vaultDir.value.trim()) {
    showError('Choose a vault folder first.');
    return;
  }
  if (!els.passphrase.value) {
    showError('Enter your vault passphrase.');
    return;
  }
  els.btnUnlock.disabled = true;
  els.unlockStatus.textContent = 'Starting sidecar…';
  try {
    const status = (await invoke('unlock_vault', {
      args: { vault_dir: els.vaultDir.value, passphrase: els.passphrase.value },
    })) as StatusSnapshot;
    els.passphrase.value = '';
    els.unlockStatus.textContent = '';
    render(status);
  } catch (e) {
    // Surface the sidecar's startup error (wrong passphrase, vault corrupt,
    // etc.) directly. The Rust side has already classified it.
    showError(String(e));
    els.unlockStatus.textContent = '';
  } finally {
    els.btnUnlock.disabled = false;
  }
});

els.btnRefresh.addEventListener('click', () => void refreshStats());

els.btnOpenFolder.addEventListener('click', async () => {
  try {
    await invoke('open_vault_in_finder');
  } catch (e) {
    showError(String(e));
  }
});

els.btnLock.addEventListener('click', async () => {
  try {
    const status = (await invoke('lock_vault')) as StatusSnapshot;
    render(status);
  } catch (e) {
    showError(String(e));
  }
});

// ---- recovery flow -----------------------------------------------------
//
// Two-phase: (1) open modal → fetch plan → render rows with checkboxes for
// every `recoverable` item; (2) on Apply, call recovery_apply with the
// checked source IDs → render outcomes inline.

function statusLabel(s: RecoveryStatus): string {
  switch (s) {
    case 'recoverable': return 'Recoverable (from disk)';
    case 'recoverable-from-cache': return 'Recoverable (from cache)';
    case 'already-present': return 'Already in graph';
    case 'file-missing': return 'File missing on disk';
    case 'url-refetch-not-implemented': return 'URL re-fetch (not yet supported)';
    case 'content-not-in-oplog': return 'Content not retained';
    default: return s;
  }
}

function statusGlyph(s: RecoveryStatus): string {
  switch (s) {
    case 'recoverable': return '✓';
    case 'recoverable-from-cache': return '✓';
    case 'already-present': return '·';
    case 'file-missing': return '✗';
    case 'url-refetch-not-implemented': return '?';
    case 'content-not-in-oplog': return '?';
    default: return '?';
  }
}

function renderPlan(plan: RecoveryPlan): void {
  currentRecoveryPlan = plan;
  if (plan.total === 0) {
    els.recoveryBody.innerHTML = '<p class="subtitle">The op-log is empty — nothing to recover.</p>';
    els.recoverySubtitle.textContent = 'Nothing to recover.';
    els.btnRecoveryApply.classList.add('hidden');
    return;
  }

  // Group items by graphId for display.
  const byGraph = new Map<string, RecoveryPlanItem[]>();
  for (const item of plan.items) {
    const arr = byGraph.get(item.graphId) ?? [];
    arr.push(item);
    byGraph.set(item.graphId, arr);
  }

  let html = `<div class="recovery-summary">
    Found <strong>${plan.total}</strong> source${plan.total === 1 ? '' : 's'} in the op-log.
    <strong>${plan.recoverable}</strong> recoverable from disk now.
    Items with missing files or content not on disk can't be replayed.
  </div>`;

  for (const [graphId, items] of byGraph) {
    html += `<p class="recovery-section-title">Graph: ${escape(graphId)}</p>`;
    for (const item of items) {
      const when = new Date(item.ingestedAt).toLocaleString();
      const canCheck = item.status === 'recoverable' || item.status === 'recoverable-from-cache';
      const checkbox = canCheck
        ? `<input type="checkbox" class="recovery-check" data-source-id="${escape(item.sourceId)}" checked />`
        : `<span class="glyph">${statusGlyph(item.status)}</span>`;
      html += `<div class="recovery-item ${item.status}">
        <div>${checkbox}</div>
        <div>
          <div class="ref">${escape(item.ref)}</div>
          <div class="meta">${escape(item.kind)} · ingested ${escape(when)}</div>
        </div>
        <span class="badge">${escape(statusLabel(item.status))}</span>
      </div>`;
    }
  }

  els.recoveryBody.innerHTML = html;
  els.recoverySubtitle.textContent = `${plan.recoverable} of ${plan.total} can be re-ingested. Review and confirm.`;

  if (plan.recoverable > 0) {
    els.btnRecoveryApply.classList.remove('hidden');
    els.btnRecoveryApply.disabled = false;
    els.btnRecoveryApply.textContent = `Recover selected (${plan.recoverable})`;
  } else {
    els.btnRecoveryApply.classList.add('hidden');
  }

  els.recoveryFooterNote.textContent = '';
}

function renderReport(report: RecoveryReport): void {
  let html = `<div class="recovery-summary">
    Attempted <strong>${report.attempted}</strong> ·
    Recovered <strong style="color: var(--ok);">${report.recovered}</strong> ·
    Skipped <strong>${report.skipped}</strong> ·
    Failed <strong style="color: var(--error);">${report.failed}</strong>
  </div>`;

  if (report.outcomes.length === 0) {
    html += '<p class="subtitle">No items processed.</p>';
  }

  for (const o of report.outcomes) {
    const cls = o.ok ? (o.skipped ? 'already-present' : 'recovered') : 'failed';
    const glyph = o.ok ? (o.skipped ? '·' : '✓') : '✗';
    const detail = o.ok
      ? (o.skipped ? 'Already in graph — skipped' : 'Re-ingested successfully')
      : `Failed: ${escape(o.error ?? 'unknown error')}`;
    html += `<div class="recovery-item ${cls}">
      <span class="glyph">${glyph}</span>
      <div>
        <div class="ref">${escape(o.ref)}</div>
        <div class="meta">${detail}</div>
      </div>
      <span class="badge">${o.ok ? (o.skipped ? 'Skipped' : 'Recovered') : 'Failed'}</span>
    </div>`;
  }

  els.recoveryBody.innerHTML = html;
  els.recoveryTitle.textContent = 'Recovery report';
  els.recoverySubtitle.textContent = report.failed === 0 && report.recovered > 0
    ? 'All selected sources were re-ingested.'
    : report.recovered === 0
      ? 'No sources were recovered.'
      : 'Some sources could not be re-ingested. See per-item details below.';
  els.btnRecoveryApply.classList.add('hidden');
  els.btnRecoveryClose.textContent = 'Done';
  els.recoveryFooterNote.textContent = '';
}

function closeRecoveryModal(): void {
  els.recoveryModal.classList.add('hidden');
  // Reset for next open.
  currentRecoveryPlan = null;
  els.recoveryTitle.textContent = 'Recover from op-log';
  els.recoverySubtitle.textContent = 'Scanning the encrypted op-log for sources that can be re-ingested…';
  els.recoveryBody.innerHTML = '<p class="subtitle">Loading…</p>';
  els.btnRecoveryApply.classList.add('hidden');
  els.btnRecoveryApply.disabled = false;
  els.btnRecoveryClose.textContent = 'Close';
  els.recoveryFooterNote.textContent = '';
}

// ---- purge-forgotten flow ----------------------------------------------

async function runPurge(btn: HTMLButtonElement): Promise<void> {
  const graphId = btn.dataset.graphId ?? '';
  if (!graphId) return;
  const ok = confirm(
    `Purge forgotten memories from "${graphId}"?\n\n` +
    `This rebuilds the graph from your remaining sources to physically remove ` +
    `soft-deleted nodes. It can take a few minutes on large vaults.\n\n` +
    `Requirement: every live source must be re-readable — either from the ` +
    `content cache, or from its original file path. If anything is missing, ` +
    `the purge will abort without changing the graph.`,
  );
  if (!ok) return;
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Purging…';
  showError(null);
  try {
    const report = (await invoke('purge_forgotten', { graphId })) as PurgeReport;
    if (report.noop) {
      showError(null);
      alert('Nothing to purge — the graph already had no soft-deleted memories.');
    } else if (report.aborted) {
      const reasons = report.errors.map(e => `• ${e.ref}: ${e.error}`).join('\n');
      alert(
        `Purge aborted to protect your data.\n\n` +
        `These sources couldn't be reconstructed:\n${reasons}\n\n` +
        `Either turn on Content cache (Settings) and re-ingest these sources first, ` +
        `or restore their original files to the recorded paths.`,
      );
    } else {
      const detail = `Rebuilt ${report.sourcesRebuilt} sources. ` +
        `Removed ${report.beforeSoftDeletedNodes} forgotten memories. ` +
        `Graph went from ${report.beforeTotalNodes} → ${report.afterTotalNodes} total nodes.`;
      if (report.errors.length > 0) {
        const issues = report.errors.map(e => `• ${e.ref}: ${e.error}`).join('\n');
        alert(`Purge finished with issues.\n\n${detail}\n\nProblems:\n${issues}`);
      } else {
        alert(`Purge complete.\n\n${detail}`);
      }
    }
    await refreshStats();
  } catch (e) {
    showError(`Purge failed: ${e}`);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ---- configure-claude flow ---------------------------------------------

els.btnClaude.addEventListener('click', () => {
  showError(null);
  els.claudeModal.classList.remove('hidden');
  els.claudePreview.style.display = 'none';
  els.claudePreview.innerHTML = '';
  els.btnClaudeApply.disabled = false;
  els.btnClaudeApply.textContent = 'Apply';
  els.claudeFooterNote.textContent = 'After applying, fully quit Claude Desktop (⌘Q) and reopen it.';
});

els.btnClaudeClose.addEventListener('click', () => {
  els.claudeModal.classList.add('hidden');
});

els.btnClaudeApply.addEventListener('click', async () => {
  els.btnClaudeApply.disabled = true;
  els.btnClaudeApply.textContent = 'Writing…';
  els.claudeFooterNote.textContent = '';
  try {
    const r = (await invoke('configure_claude_desktop')) as ClaudeConfigResult;
    const preservedLine = r.preserved_servers.length > 0
      ? `Preserved ${r.preserved_servers.length} other MCP server${r.preserved_servers.length === 1 ? '' : 's'}: <code>${r.preserved_servers.map(escape).join(', ')}</code>.`
      : 'No other MCP servers were present.';
    const headline = r.already_configured
      ? 'Claude Desktop is already configured to use this App.'
      : r.created_file
        ? 'Created Claude Desktop config and added the Graphnosis entry.'
        : 'Updated Claude Desktop\'s Graphnosis entry.';
    // Read the current AI-routing toggle so we can tell the user whether
    // Claude will be guided to use Graphnosis as default memory. Cheap IPC.
    let routingLine = '';
    try {
      const s = (await invoke('get_settings')) as AppSettings;
      routingLine = s.ai?.useAsDefaultMemory ?? true
        ? `<p style="margin-top: 8px;">Claude will be guided to use Graphnosis as your <strong>default memory</strong> — calling <code>recall</code> proactively for personal-context questions, and <code>correct</code> instead of <code>remember</code> for fixes. Change this any time under <strong>Settings → AI client routing</strong>.</p>`
        : `<p style="margin-top: 8px;">Claude will see Graphnosis as <strong>one memory option among many</strong> — no system-prompt-level routing. Change this under <strong>Settings → AI client routing</strong> if you want Graphnosis to lead.</p>`;
    } catch {
      // If we can't read settings (vault just locked, etc.) skip the line
      // rather than block the success message.
    }
    els.claudePreview.innerHTML = `
      <p><strong>${escape(headline)}</strong></p>
      <p style="margin-top: 6px;">${preservedLine}</p>
      ${routingLine}
      <p style="margin-top: 10px; font-size: 11px; color: var(--fg-dim);">
        <strong>Config file:</strong> <code>${escape(r.config_path)}</code><br/>
        <strong>Relay script:</strong> <code>${escape(r.relay_path)}</code><br/>
        <strong>Node binary:</strong> <code>${escape(r.node_path)}</code><br/>
        <strong>Socket:</strong> <code>${escape(r.socket_path)}</code>
      </p>
    `;
    els.claudePreview.style.display = '';
    els.claudeFooterNote.textContent = 'Now fully quit Claude Desktop (⌘Q, not ⌘W) and reopen it. The Graphnosis tools will reconnect to this App.';
    els.btnClaudeApply.textContent = 'Done';
  } catch (e) {
    els.claudePreview.innerHTML = `<p class="error">${escape(String(e))}</p>`;
    els.claudePreview.style.display = '';
    els.btnClaudeApply.disabled = false;
    els.btnClaudeApply.textContent = 'Retry';
  }
});

// ---- settings flow -----------------------------------------------------

function setCacheModeRadio(mode: ContentCacheMode): void {
  const radios = els.settingsModal.querySelectorAll<HTMLInputElement>('input[name="cache-mode"]');
  radios.forEach((r) => { r.checked = r.value === mode; });
}

function getCacheModeRadio(): ContentCacheMode {
  const checked = els.settingsModal.querySelector<HTMLInputElement>('input[name="cache-mode"]:checked');
  const v = checked?.value;
  return v === 'all' || v === 'ephemeral-only' || v === 'off' ? v : 'all';
}

function clampMs(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// (setInspectorDetailRadio / getInspectorDetailRadio /
//  updateNodesDetailBadge removed — Nodes pane is gone, inspector-detail
//  setting deprecated. The Settings modal no longer renders that block.
//  The setting still exists on AppSettings for backwards-compat with
//  vaults written by older builds; it's just ignored.)

function setForgetModeRadio(mode: ForgetMode): void {
  const radios = els.settingsModal.querySelectorAll<HTMLInputElement>('input[name="forget-mode"]');
  radios.forEach((r) => { r.checked = r.value === mode; });
}

function getForgetModeRadio(): ForgetMode {
  const checked = els.settingsModal.querySelector<HTMLInputElement>('input[name="forget-mode"]:checked');
  return checked?.value === 'purge' ? 'purge' : 'soft';
}

function setCacheCapDropdown(bytes: number): void {
  // Snap to the nearest preset; if user had a custom value from a future
  // version, leave the closest one selected so they see what's nearby.
  const options = Array.from(els.cacheCap.options).map(o => Number.parseInt(o.value, 10));
  const exact = options.indexOf(bytes);
  if (exact >= 0) {
    els.cacheCap.selectedIndex = exact;
    return;
  }
  // Fallback: pick the smallest preset that's still >= bytes (or "no limit").
  let pick = options.length - 1;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    if (opt !== undefined && opt > 0 && opt >= bytes) { pick = i; break; }
  }
  els.cacheCap.selectedIndex = pick;
}

els.btnSettings.addEventListener('click', async () => {
  showError(null);
  els.settingsFooterNote.textContent = '';
  els.settingsModal.classList.remove('hidden');
  try {
    const s = (await invoke('get_settings')) as AppSettings;
    setCacheModeRadio(s.contentCache.mode);
    setCacheCapDropdown(s.contentCache.maxBytesPerSource);
    setForgetModeRadio(s.forget.mode);
    els.relayInitial.value = String(Math.round(s.mcpRelay.initialWaitMs / 1000));
    els.relayReconnect.value = String(Math.round(s.mcpRelay.reconnectMs / 1000));
    // AI routing toggle: defaults to true for older settings payloads that
    // don't include the field yet.
    els.aiDefaultMemory.checked = s.ai?.useAsDefaultMemory ?? true;
  } catch (e) {
    els.settingsFooterNote.textContent = `Could not read settings: ${e}`;
  }
});

els.btnSettingsCancel.addEventListener('click', () => {
  els.settingsModal.classList.add('hidden');
});

els.btnSettingsSave.addEventListener('click', async () => {
  els.btnSettingsSave.disabled = true;
  els.settingsFooterNote.textContent = 'Saving…';
  try {
    const mode = getCacheModeRadio();
    const maxBytesPerSource = Number.parseInt(els.cacheCap.value, 10) || 0;
    const forgetMode = getForgetModeRadio();
    // Clamp to the same min/max the sidecar enforces. Convert seconds → ms.
    const initialWaitMs = clampMs(
      (Number.parseInt(els.relayInitial.value, 10) || 10) * 1000,
      RELAY_INITIAL_MIN_MS,
      RELAY_INITIAL_MAX_MS,
    );
    const reconnectMs = clampMs(
      (Number.parseInt(els.relayReconnect.value, 10) || 60) * 1000,
      RELAY_RECONNECT_MIN_MS,
      RELAY_RECONNECT_MAX_MS,
    );
    await invoke('update_settings', {
      settings: {
        contentCache: { mode, maxBytesPerSource },
        forget: { mode: forgetMode },
        mcpRelay: { initialWaitMs, reconnectMs },
        // ui.inspectorDetail is no longer wired to the UI (the Nodes
        // pane that used it is gone). We still send the field through
        // so the sidecar's settings.update Zod validator doesn't break
        // on older client builds; default to 'simple'.
        ui: { inspectorDetail: 'simple' as InspectorDetail },
        ai: { useAsDefaultMemory: els.aiDefaultMemory.checked },
      },
    });
    els.settingsFooterNote.textContent = 'Saved.';
    setTimeout(() => els.settingsModal.classList.add('hidden'), 350);
  } catch (e) {
    els.settingsFooterNote.textContent = `Save failed: ${e}`;
  } finally {
    els.btnSettingsSave.disabled = false;
  }
});

els.btnRecover.addEventListener('click', async () => {
  showError(null);
  els.recoveryModal.classList.remove('hidden');
  els.recoveryTitle.textContent = 'Recover from op-log';
  els.recoverySubtitle.textContent = 'Scanning the encrypted op-log for sources that can be re-ingested…';
  els.recoveryBody.innerHTML = '<p class="subtitle">Loading…</p>';
  els.btnRecoveryApply.classList.add('hidden');
  try {
    const plan = (await invoke('recovery_plan')) as RecoveryPlan;
    renderPlan(plan);
  } catch (e) {
    els.recoveryBody.innerHTML = `<p class="error">Could not read op-log: ${escape(String(e))}</p>`;
    els.recoverySubtitle.textContent = 'Scan failed.';
  }
});

els.btnRecoveryClose.addEventListener('click', () => {
  closeRecoveryModal();
  // Refresh inspector in case recovery happened.
  void refreshStats();
});

els.btnRecoveryApply.addEventListener('click', async () => {
  if (!currentRecoveryPlan) return;
  const checks = Array.from(
    els.recoveryBody.querySelectorAll<HTMLInputElement>('input.recovery-check:checked'),
  );
  const sourceIds = checks.map(c => c.dataset.sourceId).filter((s): s is string => !!s);
  if (sourceIds.length === 0) {
    els.recoveryFooterNote.textContent = 'Nothing selected.';
    return;
  }
  els.btnRecoveryApply.disabled = true;
  els.btnRecoveryApply.textContent = `Recovering ${sourceIds.length}…`;
  els.recoveryFooterNote.textContent = 'Re-ingesting — this may take a moment.';
  try {
    const report = (await invoke('recovery_apply', { sourceIds })) as RecoveryReport;
    renderReport(report);
  } catch (e) {
    els.recoveryBody.innerHTML = `<p class="error">Recovery failed: ${escape(String(e))}</p>`;
    els.recoverySubtitle.textContent = 'Apply failed.';
    els.btnRecoveryApply.disabled = false;
    els.btnRecoveryApply.textContent = 'Recover selected';
  }
});

// Multi-file batch ingest. Used by both the Add-file button and the
// drag-drop handler. Runs sequentially (one IPC roundtrip per file) so
// each file's progress toast updates in order; parallel ingest would
// race on the graph save() chokepoint and lose the per-file feedback.
async function ingestBatch(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  showError(null);
  let succeeded = 0;
  for (const p of paths) {
    try {
      await ingestSingleFile(p);
      succeeded += 1;
    } catch {
      // Toast already shows the per-file error; continue with the rest
      // so a single bad file doesn't abort a multi-file batch.
    }
  }
  // Refresh stats once per batch (cheaper than per-file). The push-event
  // channel will fire as each save commits, but refreshStats also paints
  // the Sources list which isn't reactive to push events.
  if (succeeded > 0) await refreshStats();
}

els.btnAddFile.addEventListener('click', async () => {
  showError(null);
  try {
    const paths = (await invoke('pick_files')) as string[];
    await ingestBatch(paths);
  } catch (e) {
    showError(`Pick failed: ${e}`);
  }
});

// Tauri window drag-drop events. Webview is the canonical event target for
// file drops in Tauri 2 (browser's drag/drop API gives us no real file paths).

void (async () => {
  const webview = getCurrentWebview();
  await webview.onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === 'enter' || payload.type === 'over') {
      els.dropZone.classList.add('dragging');
    } else if (payload.type === 'leave') {
      els.dropZone.classList.remove('dragging');
    } else if (payload.type === 'drop') {
      els.dropZone.classList.remove('dragging');
      const paths = (payload as { paths: string[] }).paths ?? [];
      // Drop a whole folder full of files at once — iterate the batch.
      // Each file gets its own toast; sequential ingest below.
      if (paths.length > 0) {
        void ingestBatch(paths);
      }
    }
  });
})().catch((e) => {
  // Drag-drop wiring failure is non-fatal — the Add file button still works.
  console.warn('drag-drop wiring failed:', e);
});

// Allow Enter in the passphrase field to submit.
els.passphrase.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.btnUnlock.click();
});

// ── Loaded engrams metadata fetch ────────────────────────────────────
//
// Pre-Graphnosis-as-default, this used to also drive a separate Nodes
// pane's graph picker. With Nodes removed, this just keeps the
// in-memory engram catalog fresh so the rest of the App (Graphnosis
// engram picker, atlas, wizards) has a current view of the vault.

async function fetchGraphsMetadata(): Promise<void> {
  try {
    loadedGraphs = (await invoke('list_graphs_with_metadata')) as GraphWithMetadata[];
    // At unlock, render() fires fetchGraphsMetadata + activateMode in
    // parallel — by the time activateMode's lazy-load ran, loadedGraphs
    // was empty and refresh*View bailed out. Now that the fetch resolved,
    // re-trigger the currently-active mode so its view actually populates.
    if (currentMode === 'atlas') void refreshAtlasView();
  } catch (e) {
    console.error('list_graphs_with_metadata failed', e);
  }
}

// ── Graph wizard ──────────────────────────────────────────────────────

function openGraphWizard(): void {
  showError(null);
  gwSelected = null;
  els.gwName.value = '';
  els.gwId.value = '';
  els.gwNote.textContent = '';
  els.btnGwCreate.disabled = true;
  renderGraphTemplateCards();
  els.graphWizardModal.classList.remove('hidden');
}

function renderGraphTemplateCards(): void {
  const groups: Record<'free' | 'power' | 'enterprise', GraphTemplateDef[]> = {
    free: [], power: [], enterprise: [],
  };
  for (const t of GRAPH_TEMPLATES) groups[t.tier].push(t);
  const renderGroup = (tier: 'free' | 'power' | 'enterprise', items: GraphTemplateDef[]): string =>
    items.map((t) => {
      const locked = tier !== 'free';
      const tierLabel = tier === 'free' ? 'Free' : tier === 'power' ? 'Power' : 'Enterprise';
      const lockHint = locked ? ' · coming soon' : '';
      return `<button type="button" class="graph-template-card ${locked ? 'locked' : ''}" data-template="${escape(t.id)}" data-tier="${tier}" ${locked ? 'disabled' : ''}>
        <span class="gt-tier ${tier}">${tierLabel}${lockHint}</span>
        <div class="gt-title">${escape(t.title)}</div>
        <div class="gt-desc">${escape(t.desc)}</div>
      </button>`;
    }).join('');
  els.gwFree.innerHTML = renderGroup('free', groups.free);
  els.gwPower.innerHTML = renderGroup('power', groups.power);
  els.gwEnterprise.innerHTML = renderGroup('enterprise', groups.enterprise);

  els.graphWizardModal.querySelectorAll<HTMLButtonElement>('.graph-template-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (card.classList.contains('locked')) return;
      els.graphWizardModal.querySelectorAll<HTMLButtonElement>('.graph-template-card').forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      gwSelected = (card.dataset.template as GraphTemplate) ?? null;
      updateGwCreateEnabled();
    });
  });
}

function updateGwCreateEnabled(): void {
  els.btnGwCreate.disabled = !gwSelected || els.gwName.value.trim().length === 0 || !/^[a-zA-Z0-9_-]+$/.test(els.gwId.value.trim());
}

els.gwName.addEventListener('input', () => {
  // Auto-suggest a slug if the user hasn't typed one yet.
  if (els.gwId.value === '' || els.gwId.dataset.userTouched !== '1') {
    els.gwId.value = els.gwName.value.toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
  }
  updateGwCreateEnabled();
});
els.gwId.addEventListener('input', () => {
  els.gwId.dataset.userTouched = '1';
  updateGwCreateEnabled();
});

els.btnNewGraph.addEventListener('click', () => openGraphWizard());
els.btnGwCancel.addEventListener('click', () => els.graphWizardModal.classList.add('hidden'));
els.btnGwCreate.addEventListener('click', async () => {
  if (!gwSelected) return;
  const graphId = els.gwId.value.trim();
  const displayName = els.gwName.value.trim();
  if (loadedGraphs.some((g) => g.graphId === graphId)) {
    els.gwNote.textContent = `An engram with ID "${graphId}" already exists.`;
    return;
  }
  els.btnGwCreate.disabled = true;
  els.btnGwCreate.textContent = 'Creating…';
  els.gwNote.textContent = '';
  try {
    await invoke('create_graph_with_template', { graphId, template: gwSelected, displayName });
    els.graphWizardModal.classList.add('hidden');
    await fetchGraphsMetadata();
    await refreshStats();
    // Land the user on the Graphnosis pane pre-selected to the new
    // engram. The Check-in dashboard's empty state will guide them
    // toward dropping in a file or having Claude remember something.
    atlasActiveGraph = graphId;
    if (els.atlasGraphPicker) els.atlasGraphPicker.value = graphId;
    activateMode('atlas');
    void refreshAtlasView();
  } catch (e) {
    els.gwNote.textContent = `Create failed: ${e}`;
  } finally {
    els.btnGwCreate.disabled = false;
    els.btnGwCreate.textContent = 'Create engram';
  }
});

// ── Status bar wiring ─────────────────────────────────────────────────

function updateStatusBar(connections: McpConnection[]): void {
  if (!els.statusMcpDot) return;
  if (connections.length === 0) {
    els.statusMcpDot.className = 'status-dot warn';
    els.statusMcpText.textContent = 'no clients';
  } else {
    els.statusMcpDot.className = 'status-dot ok';
    els.statusMcpText.textContent = `${connections.length} client${connections.length === 1 ? '' : 's'} connected`;
  }
}

// Pending-corrections badge — now lives on the Graphnosis rail item.
// Surfaces the same count the deck queue is about to show as the first
// few cards; clicking the rail item routes the user there directly.
function updatePendingBadge(count: number): void {
  if (count > 0) {
    els.railCorrectionsBadge.classList.remove('hidden');
    els.railCorrectionsBadge.textContent = String(count);
  } else {
    els.railCorrectionsBadge.classList.add('hidden');
  }
}

// ── Graphnosis view (list-first + tabbed; 3D Atlas is one tab) ──────
//
// The reimagined Graphnosis pane is built around fast keyboard-driven
// navigation: a search field at the top (⌘K), a List tab as the default
// browse surface, and a persistent detail pane on the right that mirrors
// whatever is selected — regardless of which tab the user is on. The 3D
// Atlas is one of three tabs (List / 3D Atlas / Clusters), not the whole
// surface anymore.
//
// All three tabs share one selection model (`graphnosisSelectedId`). When
// the user picks a node anywhere — list row, atlas node click, recents
// chip, connection link in the detail pane — we route through
// `selectGraphnosisNode()`, which (a) updates the cross-tab selection,
// (b) re-renders the list highlight, (c) syncs the Atlas selection if
// it's mounted, (d) re-renders the detail pane, (e) pushes onto recents.

let mainAtlas: Atlas | null = null;
let atlasActiveGraph: string | null = null;
let atlasLoadedForGraph: string | null = null; // guards re-fetch when picker doesn't change
let lastEdgesByGraph: Map<string, { directed: AtlasDirectedEdge[]; undirected: AtlasUndirectedEdge[] }> = new Map();

function pickAtlasGraph(): string | null {
  // First-loaded engram is the default. The Atlas picker UI lets users
  // switch at any time, and the choice persists in `atlasActiveGraph`.
  return loadedGraphs[0]?.graphId ?? null;
}

function nodesToAtlas(records: NodeRecord[]): AtlasNode[] {
  const now = Date.now();
  return records
    .filter((n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now))
    .map((n) => ({
      id: n.id,
      text: n.contentPreview,
      sourceFile: n.sourceFile,
      confidence: n.confidence,
    }));
}

async function fetchActiveNodes(graphId: string): Promise<NodeRecord[]> {
  return (await invoke('list_nodes', { graphId })) as NodeRecord[];
}

async function fetchEdges(graphId: string): Promise<{ directed: AtlasDirectedEdge[]; undirected: AtlasUndirectedEdge[] }> {
  return (await invoke('list_edges', { graphId })) as { directed: AtlasDirectedEdge[]; undirected: AtlasUndirectedEdge[] };
}

// Top-level entry the rail calls when the user picks the Graphnosis pane.
// Refreshes everything: picker, list, detail. Atlas is lazy-loaded.
async function refreshAtlasView(): Promise<void> {
  // Populate the engram picker from loadedGraphs.
  els.atlasGraphPicker.innerHTML = loadedGraphs
    .map((g) => `<option value="${escape(g.graphId)}">${escape(g.metadata.displayName)}</option>`)
    .join('');
  if (loadedGraphs.length === 0) {
    els.atlasStats.textContent = 'No engrams yet';
    els.gDashboard.classList.add('hidden');
    els.gSearchResults.classList.add('hidden');
    renderDetailEmpty();
    return;
  }
  if (!atlasActiveGraph || !loadedGraphs.some((g) => g.graphId === atlasActiveGraph)) {
    atlasActiveGraph = pickAtlasGraph();
  }
  if (atlasActiveGraph) els.atlasGraphPicker.value = atlasActiveGraph;
  if (!atlasActiveGraph) return;

  // Always refresh the data backing the list (fast) + the Atlas data cache.
  await loadGraphnosisData(atlasActiveGraph);
  applyGraphnosisFilter(); // renders the list + stats

  // Atlas is mounted on demand by switchGraphnosisTab when the user
  // opens the 3D tab — NOT here. Pre-mounting inside a hidden tab pane
  // (display: none → 0×0 container) left the renderer + TrackballControls
  // in a state where the canvas resized fine on tab activation but
  // pointer-drag rotation never engaged. Cost of deferring: the detail
  // pane's hover-preview only works once the user has visited the 3D
  // tab at least once. Acceptable trade for "spin always works".
  if (mainAtlas) pushDataIntoAtlas();
}

// Fetch nodes + edges for the active engram and cache them. Also recomputes
// `graphnosisOrphanIds` — used by both the health score and the deck queue
// to identify memories that aren't connected to anything yet.
async function loadGraphnosisData(graphId: string): Promise<void> {
  try {
    const [records, edges] = await Promise.all([
      fetchActiveNodes(graphId),
      fetchEdges(graphId),
    ]);
    graphnosisAllNodes = records;
    lastEdgesByGraph.set(graphId, edges);
    atlasLoadedForGraph = graphId;
    // Edges may have changed → invalidate the related-memories cache for
    // this engram. Cheap; recomputed on next detail-pane / deck render.
    graphnosisRelatedCache.clear();

    const now = Date.now();
    const active = records.filter(
      (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now),
    );
    const activeIds = new Set(active.map((n) => n.id));
    const directed = edges.directed.filter((e) => activeIds.has(e.from) && activeIds.has(e.to));
    const undirected = edges.undirected.filter((e) => activeIds.has(e.a) && activeIds.has(e.b));

    // Orphans = active nodes touched by zero edges. Recompute every load.
    const connected = new Set<string>();
    for (const e of directed) { connected.add(e.from); connected.add(e.to); }
    for (const e of undirected) { connected.add(e.a); connected.add(e.b); }
    graphnosisOrphanIds = new Set(
      active.filter((n) => !connected.has(n.id)).map((n) => n.id),
    );

    const totalEdges = directed.length + undirected.length;
    els.atlasStats.textContent =
      `${active.length} memor${active.length === 1 ? 'y' : 'ies'} · ${totalEdges} link${totalEdges === 1 ? '' : 's'}`;
  } catch (e) {
    console.error('graphnosis load failed', e);
    els.atlasStats.textContent = `Load failed: ${e}`;
    graphnosisAllNodes = [];
    graphnosisOrphanIds = new Set();
  }
}

// ── Check-in dashboard: health gauge + review deck + recap ────────────
//
// The dashboard is what the user sees when they open the Graphnosis pane
// with no active search. Three sections:
//   1. Health — single calming visual on the state of the engram.
//   2. Deck  — one card at a time with quick-verdict actions. Cards are
//              sourced from a queue (lowest-confidence first, then
//              orphans) so the user always sees the items most likely
//              to need attention.
//   3. Recap — quiet numeric summary. No streaks, no badges.
//
// When the user types in the search box, the dashboard hides and a
// list of results takes over the same space. Clearing the search
// restores the dashboard.

// ── Health score ──────────────────────────────────────────────────────
// We blend three signals into a single 0–100 score:
//   - Average confidence of active memories  (weight 0.55)
//   - Fraction of active memories with at least one edge  (weight 0.30)
//   - Recency proxy: fraction of high-confidence memories (weight 0.15)
// We translate the score into a letter grade for at-a-glance reading,
// and a one-line phrase that's the actual user-facing copy.

interface HealthSummary {
  score: number;       // 0–100
  grade: 'A' | 'B' | 'C' | 'D';
  phrase: string;      // friendly one-liner
  detail: string;      // smaller breakdown line under the phrase
  avgConfidence: number;
  connectedFraction: number;
  activeNodes: number;
}

function computeHealth(): HealthSummary {
  const now = Date.now();
  const active = graphnosisAllNodes.filter(
    (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now),
  );
  if (active.length === 0) {
    return {
      score: 0,
      grade: 'D',
      phrase: 'Your memory is empty — drop a file or have Claude remember something to get started.',
      detail: '',
      avgConfidence: 0,
      connectedFraction: 0,
      activeNodes: 0,
    };
  }
  const avgConfidence = active.reduce((s, n) => s + n.confidence, 0) / active.length;
  const orphans = active.filter((n) => graphnosisOrphanIds.has(n.id)).length;
  const connectedFraction = 1 - orphans / active.length;
  const highConfidenceFraction = active.filter((n) => n.confidence >= 0.7).length / active.length;
  const score = Math.round(
    (avgConfidence * 0.55 + connectedFraction * 0.30 + highConfidenceFraction * 0.15) * 100,
  );
  const grade: HealthSummary['grade'] =
    score >= 85 ? 'A' :
    score >= 70 ? 'B' :
    score >= 50 ? 'C' :
    'D';
  // Phrases tuned to feel warm rather than performative.
  const phrase =
    grade === 'A' ? 'Your memory is feeling well-tended.' :
    grade === 'B' ? "Solid. A few things might want your eyes." :
    grade === 'C' ? "Some memories could use a quick check-in." :
    "It's been a while — a few minutes of tending would help.";
  const orphansLabel =
    orphans === 0 ? 'all connected' :
    orphans === 1 ? '1 standing alone' :
    `${orphans} standing alone`;
  const detail = `${active.length} memor${active.length === 1 ? 'y' : 'ies'} · avg trust ${avgConfidence.toFixed(2)} · ${orphansLabel}`;
  return { score, grade, phrase, detail, avgConfidence, connectedFraction, activeNodes: active.length };
}

function renderHealth(): void {
  const h = computeHealth();
  els.gHealthGrade.textContent = h.grade;
  els.gHealthGrade.className = `g-health-grade ${h.grade.toLowerCase()}`;
  els.gHealthFill.style.width = `${h.score}%`;
  // Tint the bar to match the grade.
  els.gHealthFill.style.background =
    h.grade === 'A' ? 'var(--ok)' :
    h.grade === 'B' ? 'var(--accent)' :
    h.grade === 'C' ? '#d9a445' :
    'var(--error)';
  els.gHealthPhrase.textContent = h.phrase;
  els.gHealthDetail.textContent = h.detail;
}

// ── Review deck queue ─────────────────────────────────────────────────

function rebuildDeckQueue(): void {
  const now = Date.now();
  const active = graphnosisAllNodes.filter(
    (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now),
  );
  // Drop structural-noise nodes (SDK 'document'/'section' parents, single
  // bullets, asterisk-only fragments, headings) — these are real nodes in
  // the graph for recall, but they're not units a human can meaningfully
  // review in isolation. Path 1 of the chunking refactor: fix the surface
  // without changing the underlying ingest.
  const reviewable = active.filter((n) => !isStructuralNoise(n));

  // Pending corrections always go to the TOP of the queue — these are
  // explicit AI-proposed diffs the user already gestured at consenting
  // to (by asking Claude to correct something). Don't bury them behind
  // low-confidence churn.
  const pendingCards: DeckItem[] = graphnosisPendingDiffs
    .filter((d) => !graphnosisSessionDispatched.has(`diff:${d.diffId}`))
    .map((diff): DeckItem => {
      // Find a representative node for the breadcrumb (first edit's
      // target). For pure `adds` diffs (no edits), synthesize a stub.
      const firstEdit = diff.edits[0];
      const refNode = firstEdit
        ? graphnosisAllNodes.find((n) => n.id === firstEdit.nodeId)
        : undefined;
      const stubNode: NodeRecord = refNode ?? {
        id: `pending:${diff.diffId}`,
        confidence: 1,
        sourceFile: '',
        contentPreview: diff.reasoning ?? '(new memory proposed by Claude)',
      };
      return {
        node: stubNode,
        prompt: 'Claude proposed an update to your memory. Approve or reject?',
        reason: 'pending-correction',
        pendingDiff: diff,
      };
    });
  // Low-confidence first — these are the most likely to be wrong.
  const lowConfidence = reviewable
    .filter((n) => n.confidence < 0.65 && !graphnosisSessionDispatched.has(n.id))
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, 8)
    .map((node): DeckItem => ({
      node,
      prompt: "Graphnosis isn't fully sure about this one — does it still look right?",
      reason: 'low-confidence',
    }));
  // Then orphans — memories that aren't connected to anything else.
  // Often a signal of bad extraction or one-off facts that may not
  // belong in the graph at all.
  const orphans = reviewable
    .filter((n) => graphnosisOrphanIds.has(n.id) && !graphnosisSessionDispatched.has(n.id))
    .filter((n) => !lowConfidence.some((it) => it.node.id === n.id))
    .slice(0, 6)
    .map((node): DeckItem => ({
      node,
      prompt: "Not connected to anything yet — keep it, or was it a one-off?",
      reason: 'orphan',
    }));
  // Then "connect" cards — nodes whose entities ALSO appear in ≥3 other
  // active nodes. These are entity bridges the user can densify with
  // typed relationships in one pass. We pick the strongest bridge entity
  // for the prompt copy ("This memory mentions {Stela}…"). Excludes
  // nodes already surfaced as low-confidence or orphan to keep the deck
  // varied.
  const taken = new Set<string>([
    ...lowConfidence.map((it) => it.node.id),
    ...orphans.map((it) => it.node.id),
  ]);
  const entityCounts = computeEntityCounts(reviewable);
  const connect = reviewable
    .filter((n) => !taken.has(n.id) && !graphnosisSessionDispatched.has(n.id))
    .map((n) => {
      // Score by the strongest bridge entity this node carries.
      const ents = n.entities ?? [];
      let bestEnt: string | null = null;
      let bestCount = 0;
      for (const e of ents) {
        const c = entityCounts.get(e) ?? 0;
        if (c >= 4 && c > bestCount) {
          bestEnt = e;
          bestCount = c;
        }
      }
      return bestEnt ? { node: n, bridge: bestEnt, count: bestCount } : null;
    })
    .filter((x): x is { node: NodeRecord; bridge: string; count: number } => x !== null)
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map(({ node, bridge }): DeckItem => ({
      node,
      bridgeEntity: bridge,
      prompt: `This memory mentions ${bridge}. Want to connect it to other memories where ${bridge} appears?`,
      reason: 'connect',
    }));

  // Pending corrections lead — they're explicit, time-sensitive, and
  // the user already consented to the correction flow by asking Claude.
  graphnosisDeck = [...pendingCards, ...lowConfidence, ...orphans, ...connect];
  graphnosisDeckIndex = 0;
}

// Tally entity → occurrence count across the reviewable corpus. Used by
// the connect-card source to detect strong bridges (entities mentioned
// in many memories, where typed relationships will be richest).
function computeEntityCounts(nodes: NodeRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of nodes) {
    for (const e of n.entities ?? []) {
      out.set(e, (out.get(e) ?? 0) + 1);
    }
  }
  return out;
}

function renderDeck(): void {
  // Sync nav button disabled states regardless of which branch we hit.
  syncDeckNavButtons();
  if (graphnosisDeck.length === 0 || graphnosisDeckIndex >= graphnosisDeck.length) {
    // Empty state: clear the pinned card-head (no card to show) and
    // praise the user for whatever they did this session in the body.
    const done = graphnosisTendedThisSession;
    els.gDeckProgress.textContent = '';
    els.gDeckCardHead.innerHTML = '';
    els.gDeckCard.innerHTML = `
      <div class="g-deck-empty">
        <div class="g-deck-empty-grade">✓</div>
        <div>
          ${done > 0
            ? `You tended ${done} memor${done === 1 ? 'y' : 'ies'} this session.<br/>Nothing else flagged right now — your memory is in good hands.`
            : 'Nothing flagged right now — your memory is in good hands.'}
        </div>
      </div>
    `;
    return;
  }
  const item = graphnosisDeck[graphnosisDeckIndex];
  if (!item) return; // type-guard for the array access
  const n = item.node;
  const breadcrumb = renderBreadcrumb(n);
  const cleanContent = cleanDisplayContent(n.contentPreview);
  els.gDeckProgress.textContent = `${graphnosisDeckIndex + 1} / ${graphnosisDeck.length}`;
  // Pending-correction cards are a special path — they render the AI's
  // proposed diff (edits + adds + reasoning) in the body and replace
  // the standard 4 actions with Approve / Reject / Skip.
  if (item.reason === 'pending-correction' && item.pendingDiff) {
    renderPendingCorrectionCard(item.pendingDiff, breadcrumb);
    return;
  }
  // Orphan + connect cards get the suggestion panel inline.
  // Low-confidence cards get a small "+ Connect this memory" button that
  // expands the panel on demand — keeps the trivia-fast feel for the
  // common "is this still right?" check.
  const showsPanel = item.reason === 'orphan' || item.reason === 'connect';
  // Write the prompt + content into the PINNED card-head slot (sibling
  // of the deck header, both inside .g-deck-pinned). The suggestion
  // panel + action buttons go into the scrolling card body below.
  els.gDeckCardHead.innerHTML = `
    <p class="g-deck-prompt">${escape(item.prompt)}</p>
    ${breadcrumb ? `<p class="g-deck-breadcrumb">${breadcrumb}</p>` : ''}
    <p class="g-deck-content">${escape(cleanContent)}</p>
    <p class="g-deck-meta">trust ${n.confidence.toFixed(2)}</p>
    ${!showsPanel
      ? `<button class="g-deck-connect-toggle" data-deck-action="open-connect">+ Connect this memory</button>`
      : ''}
  `;
  els.gDeckCard.innerHTML = `
    <div id="g-deck-suggest" class="g-deck-suggest${showsPanel ? '' : ' hidden'}" data-node-id="${escape(n.id)}"></div>
    <div class="g-deck-actions">
      <button class="deck-ok" data-deck-action="ok">✓ Looks right</button>
      <button data-deck-action="fix">✏️ Fix</button>
      <button data-deck-action="forget">🗑 Forget</button>
      <button data-deck-action="skip">Skip</button>
    </div>
  `;
  // Wire actions — query BOTH the card-head (which now holds the
  // "+ Connect this memory" toggle for low-conf cards) AND the card body
  // (which holds Looks-right / Fix / Forget / Skip).
  const actionButtons: HTMLButtonElement[] = [
    ...Array.from(els.gDeckCardHead.querySelectorAll<HTMLButtonElement>('button[data-deck-action]')),
    ...Array.from(els.gDeckCard.querySelectorAll<HTMLButtonElement>('button[data-deck-action]')),
  ];
  actionButtons.forEach((btn) => {
    const action = btn.dataset['deckAction'] as
      | 'ok' | 'fix' | 'forget' | 'skip' | 'open-connect' | undefined;
    if (!action) return;
    if (action === 'open-connect') {
      btn.addEventListener('click', () => {
        const slot = document.getElementById('g-deck-suggest');
        if (!slot) return;
        slot.classList.remove('hidden');
        btn.classList.add('hidden');
        void renderSuggestionPanel({
          sourceNode: n,
          slot,
          variant: 'deck',
          onConnected: (count) => onDeckConnected(count, n),
        });
      });
      return;
    }
    btn.addEventListener('click', () => handleDeckAction(action, n));
  });
  // Mount the suggestion panel for orphan + connect variants.
  if (showsPanel) {
    const slot = document.getElementById('g-deck-suggest');
    if (slot) {
      void renderSuggestionPanel({
        sourceNode: n,
        slot,
        variant: 'deck',
        onConnected: (count) => onDeckConnected(count, n),
      });
    }
  }
}

// Called when the suggestion panel inside a deck card finishes (Connect
// or Cancel). count === 0 is the Cancel / close path: do NOT dispatch
// the card (it can come back in a future session) and re-render the
// deck card so the low-conf variant collapses its panel back to the
// "+ Connect" toggle, and the orphan/connect variants reset the panel's
// own internal state. count > 0 is a real Connect: tick the counter,
// mark the source dispatched, flash, advance.
function onDeckConnected(count: number, sourceNode: NodeRecord): void {
  if (count === 0) {
    renderDeck();
    return;
  }
  graphnosisSessionDispatched.add(sourceNode.id);
  graphnosisTendedThisSession += count;
  updateRecap();
  void showDeckAck(`connected ${count}`, 'ok').then(() => advanceDeck());
}

// Render a pending-correction card — replaces the standard layout. The
// pinned head shows the AI's reasoning + a stable identifier; the body
// shows the edit/supersede/delete operations the diff would apply, plus
// Approve / Reject / Skip actions.
function renderPendingCorrectionCard(diff: PendingDiff, breadcrumb: string): void {
  const when = new Date(diff.createdAt).toLocaleString();
  const reasoning = diff.reasoning
    ? `<p class="g-deck-content" style="border-left-color: var(--accent);">${escape(diff.reasoning)}</p>`
    : `<p class="g-deck-content" style="border-left-color: var(--accent);">(no reasoning provided)</p>`;
  // The pinned head: prompt + breadcrumb + AI reasoning + meta.
  els.gDeckCardHead.innerHTML = `
    <p class="g-deck-prompt">Claude proposed an update to your memory. Approve or reject?</p>
    ${breadcrumb ? `<p class="g-deck-breadcrumb">${breadcrumb}</p>` : ''}
    ${reasoning}
    <p class="g-deck-meta">Proposed ${escape(when)} · in <strong>${escape(diff.graphId)}</strong> · <code>${escape(diff.diffId.slice(0, 8))}…</code></p>
  `;
  // The body: edit/supersede/delete operations + Add operations,
  // followed by the Approve / Reject / Skip action row.
  const editRows = diff.edits.map(renderDiffOp).join('');
  const addRows = diff.adds.map((a) => `
    <div class="diff-op">
      <span class="diff-op-kind add">ADD</span>
      ${a.label ? `<span class="mcp-meta">${escape(a.label)}</span>` : ''}
      <div class="diff-op-content">${escape(a.text)}</div>
    </div>
  `).join('');
  const empty = editRows === '' && addRows === ''
    ? '<p class="subtitle" style="padding: 12px;">Empty diff — nothing to apply.</p>'
    : '';
  els.gDeckCard.innerHTML = `
    <div class="g-pending-ops">
      ${editRows}${addRows}${empty}
    </div>
    <div class="g-deck-actions">
      <button class="deck-ok" data-deck-action="approve">✓ Approve</button>
      <button data-deck-action="reject">✗ Reject</button>
      <button data-deck-action="skip">Skip</button>
    </div>
  `;
  // Wire Approve / Reject / Skip.
  const actionButtons = Array.from(els.gDeckCard.querySelectorAll<HTMLButtonElement>('button[data-deck-action]'));
  actionButtons.forEach((btn) => {
    const action = btn.dataset['deckAction'];
    btn.addEventListener('click', () => {
      if (action === 'skip') {
        // Mark this diff as session-skipped so it doesn't keep reappearing
        // within this session. (It WILL come back if the user re-opens
        // the vault — pending diffs are persisted in the sidecar.)
        graphnosisSessionDispatched.add(`diff:${diff.diffId}`);
        rebuildDeckQueue();
        advanceDeck();
        return;
      }
      if (action === 'approve' || action === 'reject') {
        // Mark as dispatched IMMEDIATELY so it doesn't flicker back from
        // a stale poll while the IPC is in flight.
        graphnosisSessionDispatched.add(`diff:${diff.diffId}`);
        void handlePendingDiffAction(diff.diffId, action === 'approve' ? 'apply' : 'reject');
      }
    });
  });
}

// (fillDeckRelated + handleDeckLink removed — replaced by the shared
// renderSuggestionPanel mounted inline in renderDeck for orphan + connect
// cards and on-demand for low-confidence cards via the "+ Connect this
// memory" toggle.)

async function handleDeckAction(
  action: 'ok' | 'fix' | 'forget' | 'skip',
  node: NodeRecord,
): Promise<void> {
  if (action === 'ok') {
    // Client-side ack only for v1 — real confidence boost via a new IPC
    // is the next step. The user gets visual feedback + the card is
    // removed from this session's queue.
    graphnosisSessionDispatched.add(node.id);
    graphnosisTendedThisSession++;
    updateRecap();
    await showDeckAck('tucked in', 'ok');
    advanceDeck();
    return;
  }
  if (action === 'skip') {
    // Skip just advances — does NOT mark the card permanently dispatched.
    // The user can navigate back to it within this session via the
    // deck nav arrows, and a future session will surface it again if
    // it still meets the queue criteria. (Looks-right / Forget / Fix
    // remain permanent because they encode a real user judgment.)
    advanceDeck();
    return;
  }
  if (action === 'fix') {
    // Fix is the one action that legitimately pulls focus to the sidebar:
    // we hand the user off to the inline-edit textarea. Don't dispatch
    // the card yet — the saveInlineEdit() handler will mark it dispatched
    // when the user actually saves.
    selectGraphnosisNode(node.id);
    startInlineEdit(node.id);
    return;
  }
  if (action === 'forget') {
    // The deck click IS the decision — no confirm dialog. Skip the
    // selection step too: yanking focus to the sidebar before forgetting
    // was the bug Nelu hit (the node "appeared in the sidebar" because
    // selectGraphnosisNode ran before the data mutation cleared it).
    const success = await softDeleteNode(node.id);
    if (success) {
      graphnosisTendedThisSession++;
      updateRecap();
      await showDeckAck('forgotten', 'forget');
      advanceDeck();
    }
    // softDeleteNode already showed an error toast on failure.
  }
}

// Inline visual ack for deck actions. Replaces the card body briefly
// with a centered confirmation, then resolves so the caller can advance.
// Faster than a toast, more obvious than a silent advance.
async function showDeckAck(label: string, kind: 'ok' | 'forget'): Promise<void> {
  const color = kind === 'ok' ? 'var(--ok)' : 'var(--error)';
  const glyph = kind === 'ok' ? '✓' : '🗑';
  const prev = els.gDeckCard.innerHTML;
  els.gDeckCard.innerHTML = `
    <div class="g-deck-ack" style="color: ${color};">
      <div style="font-size: 26px; line-height: 1;">${glyph}</div>
      <div style="margin-top: 6px; font-size: 13px;">${escape(label)}</div>
    </div>
  `;
  flashDeck();
  await new Promise((r) => setTimeout(r, 520));
  // We don't restore `prev` — advanceDeck() will render the next card
  // (or the empty state) immediately after this resolves.
  void prev;
}

function advanceDeck(): void {
  graphnosisDeckIndex++;
  renderDeck();
}

// Go back to the previous card without un-doing any committed action.
// Useful when the user wants to revisit a card they skipped or change
// their mind mid-review. Clamped at index 0.
function previousDeck(): void {
  if (graphnosisDeckIndex > 0) {
    graphnosisDeckIndex--;
    renderDeck();
  }
}

// Step forward through the deck without taking an action. Mirror of
// previousDeck — lets the user scan to a specific card before deciding.
// Clamped to the last card so the empty state is only reached by
// dispatching all cards (which is the deserved-celebration moment).
function skipForwardDeck(): void {
  if (graphnosisDeckIndex < graphnosisDeck.length - 1) {
    graphnosisDeckIndex++;
    renderDeck();
  }
}

// Greys out the deck-header nav arrows at the edges of the queue.
// Next is disabled once we're viewing the LAST card (10 / 10): there's
// no "skip past the end" navigation; the empty-state lives there on
// its own. Prev is disabled at the first card.
function syncDeckNavButtons(): void {
  if (els.btnDeckPrev) {
    els.btnDeckPrev.disabled = graphnosisDeckIndex <= 0;
  }
  if (els.btnDeckNext) {
    els.btnDeckNext.disabled = graphnosisDeckIndex >= graphnosisDeck.length - 1;
  }
}

// Wire the nav buttons once at module load — same pattern as the rail
// buttons. The render() loop only updates their disabled state.
els.btnDeckPrev?.addEventListener('click', () => previousDeck());
els.btnDeckNext?.addEventListener('click', () => skipForwardDeck());

function flashDeck(): void {
  // CSS handles the visual pulse via the `flash` class.
  els.gDeck.classList.remove('flash');
  // Force a reflow so the animation restarts on rapid double-tap.
  void els.gDeck.offsetWidth;
  els.gDeck.classList.add('flash');
}

// ── Recap row ─────────────────────────────────────────────────────────

function updateRecap(): void {
  const now = Date.now();
  const active = graphnosisAllNodes.filter(
    (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now),
  );
  els.gRecapMemories.textContent = String(active.length);
  // Pull the real source count from the latest stats payload — more
  // accurate than deriving from unique sourceFile values on the node
  // cache (a source can have zero active nodes after a Forget cascade
  // and we'd undercount). Falls back to the derived estimate while
  // stats are still loading.
  const fromStats = atlasActiveGraph && lastInspectorStats
    ? lastInspectorStats.graphs.find((g) => g.graphId === atlasActiveGraph)
    : null;
  if (fromStats) {
    els.gRecapSources.textContent = String(fromStats.sources);
    els.gRecapCorrections.textContent = String(fromStats.corrections);
  } else {
    const sources = new Set(active.map((n) => n.sourceFile).filter((s) => s.length > 0));
    els.gRecapSources.textContent = String(sources.size);
    els.gRecapCorrections.textContent = '—';
  }
  const avg = active.length === 0 ? 0 : active.reduce((s, n) => s + n.confidence, 0) / active.length;
  els.gRecapAvg.textContent = avg.toFixed(2);
  els.gRecapTended.textContent = String(graphnosisTendedThisSession);
  // Subtle highlight when the counter > 0.
  els.gRecapTended.classList.toggle('tended-bump', graphnosisTendedThisSession > 0);
  // Refresh the forgotten footer in case the cache changed since the
  // last refreshStats (e.g., after a forget/edit that touched the data).
  updateGraphnosisForgottenRow();
}

// Surface the active engram's forgotten-on-disk count in the recap card.
// Hidden when count is 0 — no need to nag about an empty cleanup queue.
// Reads from the lastInspectorStats cache (populated by refreshStats).
function updateGraphnosisForgottenRow(): void {
  if (!lastInspectorStats || !atlasActiveGraph) {
    els.gRecapForgotten.classList.add('hidden');
    return;
  }
  const g = lastInspectorStats.graphs.find((x) => x.graphId === atlasActiveGraph);
  const forgotten = g?.softDeletedNodes ?? 0;
  if (forgotten <= 0) {
    els.gRecapForgotten.classList.add('hidden');
    return;
  }
  els.gRecapForgottenText.textContent =
    `${forgotten} forgotten memor${forgotten === 1 ? 'y' : 'ies'} still on disk`;
  els.gRecapForgotten.classList.remove('hidden');
  // Tooltip explains the trade-off so users know why this exists as
  // a deliberate action, not an automatic background job.
  els.btnGPurge.title =
    'Rebuild the graph from your remaining sources to physically remove ' +
    'forgotten memories. Slow on large engrams; aborts safely if any source ' +
    "can't be re-read.";
}

// Wire the Graphnosis-side Purge button to the existing runPurge flow.
// The button's data-graph-id is set per render so runPurge picks the
// right engram (which always matches the active Graphnosis selection).
els.btnGPurge.addEventListener('click', () => {
  if (!atlasActiveGraph) return;
  // runPurge reads graphId off the button's dataset. We set it just-in-time
  // here so it always matches the currently-active engram.
  els.btnGPurge.dataset['graphId'] = atlasActiveGraph;
  void runPurge(els.btnGPurge);
});

// ── Dashboard / search-results visibility ────────────────────────────

// User-selectable sort order for search results. Defaults to "relevance"
// — closer matches to the search term rank higher than incidental hits.
// Persists in memory only (session-scoped); reset on app launch.
type SearchSortMode = 'relevance' | 'confidence' | 'source';
let searchSortMode: SearchSortMode = 'relevance';

/**
 * Per-node relevance score against the lowercased query. Higher is better.
 *
 * Heuristics (chosen so the score interleaves cleanly with BGE semantic
 * scores in the 0–~120 range):
 *   - Exact word-boundary match in content: +100, scaled by inverse
 *     position (earlier = closer to "the topic")
 *   - Substring match in content: +50, scaled by inverse position
 *   - Multiple occurrences: +10 per extra hit (capped at 5 extras)
 *   - Match in sourceFile: +20
 *
 * Pure local — no IPC. Called once per row during filter.
 */
function computeRelevance(n: NodeRecord, q: string): number {
  if (q.length === 0) return 0;
  const content = n.contentPreview.toLowerCase();
  const source = n.sourceFile.toLowerCase();
  let score = 0;

  const pos = content.indexOf(q);
  if (pos >= 0) {
    // Position bonus: position 0 → +100, drops to ~+50 by position 200.
    const positionBoost = Math.max(50, 100 - pos * 0.25);
    // Word-boundary detection: previous char (if any) and next char (if any)
    // must NOT be alphanumeric for it to count as a boundary match.
    const prev = pos > 0 ? content.charCodeAt(pos - 1) : 0;
    const after = pos + q.length < content.length ? content.charCodeAt(pos + q.length) : 0;
    const isWordBoundary =
      !(prev >= 48 && prev <= 57) && !(prev >= 97 && prev <= 122) &&
      !(after >= 48 && after <= 57) && !(after >= 97 && after <= 122);
    score += isWordBoundary ? positionBoost : positionBoost * 0.5;
    // Bonus per additional occurrence (regex.split returns [pre, post-each-hit, …]).
    const occurrences = content.split(q).length - 1;
    if (occurrences > 1) score += Math.min(occurrences - 1, 5) * 10;
  }

  if (source.includes(q)) score += 20;

  return score;
}

/**
 * Apply the user-selected sort mode to a list of rows. `relevance`
 * requires the query (uses computeRelevance), the others are simple
 * field comparisons.
 */
function sortSearchResults(rows: NodeRecord[], q: string): NodeRecord[] {
  const sorted = rows.slice();
  switch (searchSortMode) {
    case 'relevance':
      sorted.sort((a, b) => computeRelevance(b, q) - computeRelevance(a, q));
      break;
    case 'confidence':
      sorted.sort((a, b) => b.confidence - a.confidence);
      break;
    case 'source':
      sorted.sort((a, b) => a.sourceFile.localeCompare(b.sourceFile));
      break;
  }
  return sorted;
}

function applyGraphnosisFilter(): void {
  const qRaw = els.gSearch.value.trim();
  const q = qRaw.toLowerCase();

  // No query → show dashboard, hide results.
  if (q.length === 0) {
    els.gSearchResults.classList.add('hidden');
    els.gDashboard.classList.remove('hidden');
    renderDashboard();
    return;
  }

  // Query present → switch to results view.
  els.gDashboard.classList.add('hidden');
  els.gSearchResults.classList.remove('hidden');

  const now = Date.now();
  const active = graphnosisAllNodes.filter(
    (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now),
  );
  const matched = active.filter((n) =>
    n.contentPreview.toLowerCase().includes(q) ||
    n.sourceFile.toLowerCase().includes(q),
  );
  const filtered = sortSearchResults(matched, q);
  graphnosisListRows = filtered;
  graphnosisListMode = 'substring';
  els.gSearchResultsStats.textContent =
    `${filtered.length} match${filtered.length === 1 ? '' : 'es'} for "${qRaw}"`;

  if (filtered.length === 0) {
    // Fall back to BGE-semantic if query is long enough.
    if (qRaw.length >= 3 && atlasActiveGraph) {
      els.gList.innerHTML = '<p class="subtitle">No exact matches — looking by meaning…</p>';
      void runSemanticFallback(qRaw, atlasActiveGraph);
      return;
    }
    els.gList.innerHTML = '<p class="subtitle">No matches. Try different words, or clear the search.</p>';
    return;
  }
  els.gList.innerHTML = filtered.slice(0, 300).map(renderListRow).join('') +
    (filtered.length > 300
      ? `<p class="subtitle" style="margin-top: 10px;">Showing 300 of ${filtered.length} — narrow the search.</p>`
      : '');
  wireListRowHandlers();
  syncListSelectionHighlight();
}

function renderDashboard(): void {
  renderHealth();
  rebuildDeckQueue();
  renderDeck();
  updateRecap();
}

// BGE-semantic fallback — same as before, race-guarded. Renders into the
// shared results list when substring filter yields nothing.
async function runSemanticFallback(query: string, graphId: string): Promise<void> {
  const myToken = ++graphnosisSemanticToken;
  try {
    const hits = (await invoke('search_nodes', { graphId, query, k: 30 })) as SearchHit[];
    if (myToken !== graphnosisSemanticToken) return;
    const now = Date.now();
    const rawRows: NodeRecord[] = hits
      .map((h) => {
        const cached = graphnosisAllNodes.find((n) => n.id === h.nodeId);
        if (cached) return cached;
        return {
          id: h.nodeId,
          confidence: h.score,
          sourceFile: '',
          contentPreview: h.text,
        } satisfies NodeRecord;
      })
      .filter((n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now));
    // For semantic fallback under `relevance` mode, the BGE order IS the
    // relevance order — keep it. Confidence/source modes re-sort.
    const rows = searchSortMode === 'relevance' ? rawRows : sortSearchResults(rawRows, query.toLowerCase());
    graphnosisListRows = rows;
    graphnosisListMode = 'semantic';
    els.gSearchResultsStats.textContent =
      `${rows.length} closest match${rows.length === 1 ? '' : 'es'} by meaning — no exact text match for "${query}"`;
    if (rows.length === 0) {
      els.gList.innerHTML = '<p class="subtitle">Nothing close enough. Try different words.</p>';
      return;
    }
    els.gList.innerHTML = rows.slice(0, 100).map(renderListRow).join('');
    wireListRowHandlers();
    syncListSelectionHighlight();
  } catch (e) {
    if (myToken !== graphnosisSemanticToken) return;
    els.gList.innerHTML = `<p class="subtitle">Semantic search failed: ${escape(String(e))}</p>`;
  }
}

// ── List row rendering (shared by search results) ────────────────────

function renderListRow(n: NodeRecord): string {
  const isActive = n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > Date.now());
  const confidenceDot = !isActive
    ? '○○○'
    : n.confidence >= 0.8 ? '●●●'
    : n.confidence >= 0.5 ? '●●○'
    : '●○○';
  const selected = n.id === graphnosisSelectedId ? ' selected' : '';
  const softCls = isActive ? '' : ' soft-deleted';
  const sourceLabel = n.sourceFile ? prettySourceLabel(n.sourceFile) : '';
  const cleanContent = cleanDisplayContent(n.contentPreview);
  // List rows show the breadcrumb (source › section) on the second line
  // instead of just the source. Section is only added when we have it —
  // most ingest paths set source, fewer set section.
  const metaLine = n.section
    ? `${sourceLabel ? `${escape(sourceLabel)} <span style="opacity: 0.55;">›</span> ` : ''}${escape(n.section)}`
    : escape(sourceLabel);
  return `<div class="g-list-row${selected}${softCls}" data-node-id="${escape(n.id)}" tabindex="-1">
    <span class="g-row-conf" title="trust ${n.confidence.toFixed(2)}">${confidenceDot}</span>
    <div>
      <div class="g-row-text">${escape(cleanContent)}</div>
      ${metaLine ? `<div class="g-row-meta"><span class="g-row-source" title="${escape(n.sourceFile)}">${metaLine}</span></div>` : ''}
    </div>
  </div>`;
}

function wireListRowHandlers(): void {
  els.gList.querySelectorAll<HTMLElement>('.g-list-row').forEach((row) => {
    const id = row.dataset['nodeId'];
    if (!id) return;
    row.addEventListener('click', () => {
      selectGraphnosisNode(id);
      els.gList.focus();
    });
    row.addEventListener('dblclick', () => {
      selectGraphnosisNode(id);
      startInlineEdit(id);
    });
  });
}

function syncListSelectionHighlight(): void {
  els.gList.querySelectorAll<HTMLElement>('.g-list-row').forEach((row) => {
    row.classList.toggle('selected', row.dataset['nodeId'] === graphnosisSelectedId);
  });
}

function scrollSelectedListRowIntoView(): void {
  if (!graphnosisSelectedId) return;
  const row = els.gList.querySelector<HTMLElement>(
    `.g-list-row[data-node-id="${cssEscape(graphnosisSelectedId)}"]`,
  );
  if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

// ── Selection (the heart of cross-tab routing) ────────────────────────

function selectGraphnosisNode(nodeId: string | null): void {
  graphnosisSelectedId = nodeId;
  graphnosisEditingId = null; // cancel any pending edit on selection change
  syncListSelectionHighlight();
  // Mirror selection into the Atlas if mounted — but don't move the camera.
  if (mainAtlas && nodeId) mainAtlas.select(nodeId);
  if (mainAtlas && !nodeId) mainAtlas.resetEmphasis();
  if (nodeId) pushRecent(nodeId);
  renderDetailPane();
}

function pushRecent(nodeId: string): void {
  if (!atlasActiveGraph) return;
  const current = graphnosisRecentsByGraph.get(atlasActiveGraph) ?? [];
  const next = [nodeId, ...current.filter((id) => id !== nodeId)].slice(0, GRAPHNOSIS_RECENTS_MAX);
  graphnosisRecentsByGraph.set(atlasActiveGraph, next);
  renderRecents();
}

function renderRecents(): void {
  const recents = currentRecents();
  if (recents.length === 0) {
    els.gRecents.classList.add('hidden');
    els.gRecentsChips.innerHTML = '';
    return;
  }
  els.gRecents.classList.remove('hidden');
  els.gRecentsChips.innerHTML = recents.map((id) => {
    const n = graphnosisAllNodes.find((nn) => nn.id === id);
    const cleanText = n ? cleanDisplayContent(n.contentPreview) : '';
    const label = cleanText
      ? (cleanText.length > 36 ? cleanText.slice(0, 33) + '…' : cleanText)
      : id.slice(0, 8) + '…';
    return `<button class="g-recent-chip" data-node-id="${escape(id)}" title="${escape(n?.contentPreview ?? id)}">${escape(label)}</button>`;
  }).join('');
  els.gRecentsChips.querySelectorAll<HTMLButtonElement>('.g-recent-chip').forEach((btn) => {
    const id = btn.dataset['nodeId'];
    if (id) btn.addEventListener('click', () => selectGraphnosisNode(id));
  });
}

// ── Detail pane ───────────────────────────────────────────────────────

function renderDetailEmpty(): void {
  els.gDetail.querySelector<HTMLElement>('.g-detail-empty')?.classList.remove('hidden');
  els.gDetailBody.classList.add('hidden');
  els.gDetailBody.innerHTML = '';
}

function renderDetailPane(): void {
  if (!graphnosisSelectedId) {
    renderDetailEmpty();
    return;
  }
  const node = graphnosisAllNodes.find((n) => n.id === graphnosisSelectedId);
  if (!node) {
    renderDetailEmpty();
    return;
  }
  els.gDetail.querySelector<HTMLElement>('.g-detail-empty')?.classList.add('hidden');
  els.gDetailBody.classList.remove('hidden');

  const isActive = node.confidence > 0.2 && (node.validUntil === undefined || node.validUntil > Date.now());
  const confidenceDot = node.confidence >= 0.8 ? '●●●' : node.confidence >= 0.5 ? '●●○' : '●○○';
  // Use the friendly source label for clip:* sources so users don't see
  // the raw "clip:1778…:Educație NYFA" identifier in the detail pane.
  const sourceLabel = node.sourceFile ? prettySourceLabel(node.sourceFile) : null;
  const breadcrumb = renderBreadcrumb(node);
  const cleanContent = cleanDisplayContent(node.contentPreview);

  // If we're in edit mode for this node, render the textarea instead of the
  // static content block. Edit textarea shows the RAW content (asterisks
  // and all) — the user is editing the underlying memory, not just its
  // display. Save sends the raw text back through node.directEdit.
  const isEditing = graphnosisEditingId === node.id;
  const contentBlock = isEditing
    ? `<textarea class="g-detail-edit-textarea" id="g-detail-edit">${escape(node.contentPreview)}</textarea>
       <div class="g-detail-actions">
         <button class="primary" id="btn-detail-save">Save correction</button>
         <button id="btn-detail-cancel-edit">Cancel</button>
       </div>`
    : `<div class="g-detail-content">${escape(cleanContent)}</div>`;

  // Connection list — Atlas-derived. Falls back to empty if Atlas hasn't
  // been initialized yet. For the v1 we just read from cached edges and
  // resolve neighbors by ID; same logic the Atlas would render but
  // independent of whether the 3D viz is mounted.
  const conns = buildConnectionsForNode(node.id);

  // Two-tap forget: the button shows "Forget" by default; first click
  // changes it to "Tap again to confirm" and reddens it. Second click
  // commits. Click elsewhere or wait — it reverts. This avoids the
  // window.confirm() dialog, which can be missed or feel disconnected
  // from the surface the user is already looking at.
  const armed = graphnosisForgetArming?.nodeId === node.id;
  const forgetLabel = !isActive
    ? 'Already forgotten'
    : armed ? 'Tap again to confirm' : 'Forget';
  const forgetClass = armed ? 'btn-forget-armed' : '';
  // Action row (only when not editing — edit buttons are above).
  const actionRow = isEditing ? '' : `
    <div class="g-detail-actions">
      <button class="primary" id="btn-detail-edit">Correct <kbd>E</kbd></button>
      <button id="btn-detail-forget" class="${forgetClass}" ${isActive ? '' : 'disabled'}>${escape(forgetLabel)}${armed || !isActive ? '' : ' <kbd>⌫</kbd>'}</button>
    </div>`;

  els.gDetailBody.innerHTML = `
    <div class="g-detail-conf">${confidenceDot} memory trace${isActive ? '' : ' · forgotten'}</div>
    ${breadcrumb ? `<div class="g-detail-breadcrumb">${breadcrumb}</div>` : ''}
    ${contentBlock}
    <div class="g-detail-meta">
      ${sourceLabel && !node.section ? `source: <code title="${escape(node.sourceFile)}">${escape(sourceLabel)}</code><br/>` : ''}
      ${node.nodeType ? `type: <code>${escape(node.nodeType)}</code><br/>` : ''}
      confidence: ${node.confidence.toFixed(2)}<br/>
      ${node.validUntil ? `valid until: ${new Date(node.validUntil).toLocaleString()}<br/>` : ''}
      id: <code>${escape(node.id.slice(0, 16))}…</code>
    </div>
    ${actionRow}
    ${renderConnectionsBlock(conns)}
    <div class="g-detail-suggest-wrap">
      <button id="btn-detail-connect" class="g-detail-connect-toggle">
        + Connect this memory
      </button>
      <div id="g-detail-suggest" class="g-detail-suggest hidden" data-node-id="${escape(node.id)}"></div>
    </div>
  `;
  // The suggestion panel is collapsed by default in the detail pane.
  // Clicking the button mounts the shared renderer; on Connect or Cancel
  // it collapses again and the Connections section refreshes via
  // renderDetailPane (loadGraphnosisData fired inside linkOne).
  document.getElementById('btn-detail-connect')?.addEventListener('click', () => {
    const slot = document.getElementById('g-detail-suggest');
    const btn = document.getElementById('btn-detail-connect');
    if (!slot || !btn) return;
    slot.classList.remove('hidden');
    btn.classList.add('hidden');
    void renderSuggestionPanel({
      sourceNode: node,
      slot,
      variant: 'detail',
      onConnected: (count) => {
        // Collapse + re-render the detail pane regardless of count so
        // the Connections section picks up any new edges (and so the
        // button reappears for the next round).
        if (count > 0) {
          graphnosisTendedThisSession += count;
          updateRecap();
        }
        renderDetailPane();
      },
    });
  });

  // Wire the action buttons. All reads of selection/state happen at click
  // time, not closure capture — the latter caused a real bug where the
  // sidebar Forget silently no-op'd after a prior selection change.
  document.getElementById('btn-detail-edit')?.addEventListener('click', () => {
    if (graphnosisSelectedId) startInlineEdit(graphnosisSelectedId);
  });
  document.getElementById('btn-detail-forget')?.addEventListener('click', () => {
    void handleSidebarForgetClick();
  });
  document.getElementById('btn-detail-save')?.addEventListener('click', () => {
    void saveInlineEdit();
  });
  document.getElementById('btn-detail-cancel-edit')?.addEventListener('click', () => {
    graphnosisEditingId = null;
    renderDetailPane();
  });

  // Wire connection rows: click → select neighbor; hover → preview-highlight
  // on the Atlas (pre-mounted on pane open, so this always works).
  els.gDetailBody.querySelectorAll<HTMLElement>('.g-detail-conn-row').forEach((row) => {
    const id = row.dataset['neighbor'];
    if (!id) return;
    row.addEventListener('click', () => selectGraphnosisNode(id));
    row.addEventListener('mouseenter', () => mainAtlas?.previewHighlight(id));
    row.addEventListener('mouseleave', () => mainAtlas?.previewHighlight(null));
  });

  // Auto-focus the textarea when entering edit mode.
  if (isEditing) {
    const ta = document.getElementById('g-detail-edit') as HTMLTextAreaElement | null;
    ta?.focus();
    ta?.setSelectionRange(ta.value.length, ta.value.length);
  }
}

interface ConnRow {
  neighborId: string;
  type: string;
  category: EdgeCategory;
  weight: number;
  direction: 'out' | 'in' | 'undirected';
  /** User-chosen label (the SDK's `evidence` field on directed edges).
   *  Set when the edge was created via the typed-relationship picker
   *  with a non-default label (e.g. "Works at" for collaborated-on).
   *  Auto-extracted edges don't carry evidence. */
  evidence?: string;
}

function buildConnectionsForNode(nodeId: string): ConnRow[] {
  // Always read from cached raw edges so we get the `evidence` field on
  // directed edges (the Atlas's getConnections doesn't expose it yet —
  // can be lifted there in a follow-up). For the category we fall back
  // to Atlas's categorizer when available, otherwise 'semantic'.
  const edges = atlasActiveGraph ? lastEdgesByGraph.get(atlasActiveGraph) : undefined;
  if (!edges) {
    // Fallback: if no cached edges yet, ask the Atlas (which keeps its
    // own copy). Loses evidence in this branch — acceptable since it
    // only fires before the first data load completes.
    if (mainAtlas) {
      return mainAtlas.getConnections(nodeId).map((c) => ({
        neighborId: c.neighborId,
        type: c.type,
        category: c.category,
        weight: c.weight,
        direction: c.direction,
      }));
    }
    return [];
  }
  // Atlas-aware category lookup so directed/undirected edges render in
  // the right color in the detail pane. Falls back to 'semantic' when
  // Atlas isn't mounted yet.
  const categoryFor = (type: string): EdgeCategory => {
    if (!mainAtlas) return 'semantic';
    const conns = mainAtlas.getConnections(nodeId);
    const match = conns.find((c) => c.type === type);
    return match?.category ?? 'semantic';
  };
  const out: ConnRow[] = [];
  for (const e of edges.directed) {
    if (e.from === nodeId) {
      const row: ConnRow = { neighborId: e.to, type: e.type, category: categoryFor(e.type), weight: e.weight, direction: 'out' };
      if (e.evidence) row.evidence = e.evidence;
      out.push(row);
    } else if (e.to === nodeId) {
      const row: ConnRow = { neighborId: e.from, type: e.type, category: categoryFor(e.type), weight: e.weight, direction: 'in' };
      if (e.evidence) row.evidence = e.evidence;
      out.push(row);
    }
  }
  for (const e of edges.undirected) {
    if (e.a === nodeId) out.push({ neighborId: e.b, type: e.type, category: categoryFor(e.type), weight: e.weight, direction: 'undirected' });
    else if (e.b === nodeId) out.push({ neighborId: e.a, type: e.type, category: categoryFor(e.type), weight: e.weight, direction: 'undirected' });
  }
  return out;
}

function renderConnectionsBlock(conns: ConnRow[]): string {
  if (conns.length === 0) {
    return `<p class="atlas-tip" style="margin-top: 12px;">No connections — this memory stands alone.</p>`;
  }
  const outs = conns.filter((c) => c.direction === 'out');
  const ins = conns.filter((c) => c.direction === 'in');
  const undirs = conns.filter((c) => c.direction === 'undirected');
  const neighborLabel = (id: string): string => {
    const n = graphnosisAllNodes.find((nn) => nn.id === id);
    const text = n?.contentPreview ?? id;
    return text.length > 60 ? text.slice(0, 57) + '…' : text;
  };
  const section = (label: string, arrow: string, list: ConnRow[]): string => {
    if (list.length === 0) return '';
    return `<div class="g-detail-conn-section">
      <div class="g-detail-conn-title">${escape(label)} (${list.length})</div>
      ${list.map((c) => {
        // Prefer the user-chosen label (evidence) over a humanized
        // SDK type. Auto-extracted edges fall back to humanization
        // ("shares-entity" → "Same topic"-ish via the catalog).
        const displayLabel = c.evidence ?? humanizeSdkType(c.type, c.direction !== 'undirected');
        return `<div class="g-detail-conn-row" data-neighbor="${escape(c.neighborId)}" title="${escape(c.type)} · weight ${c.weight.toFixed(2)}${c.evidence ? ` · evidence: ${c.evidence}` : ''}">
          <span class="g-detail-conn-arrow" style="color: ${cssColorForCategory(c.category)};">${arrow}</span>
          <span class="g-detail-conn-text">${escape(neighborLabel(c.neighborId))}</span>
          <span class="g-detail-conn-type">${escape(displayLabel)}</span>
        </div>`;
      }).join('')}
    </div>`;
  };
  return `<p class="brain-subtitle" style="margin: 14px 0 4px;">${conns.length} connection${conns.length === 1 ? '' : 's'}</p>
    ${section('Outgoing', '→', outs)}
    ${section('Incoming', '←', ins)}
    ${section('Mutual', '↔', undirs)}`;
}

// (fillRelatedPanel + handleLinkClick removed — replaced by the shared
// renderSuggestionPanel mounted on demand via the "+ Connect this memory"
// button under the detail pane's Connections section.)

// ── Inline edit + forget actions ──────────────────────────────────────

function startInlineEdit(nodeId: string): void {
  if (graphnosisSelectedId !== nodeId) selectGraphnosisNode(nodeId);
  graphnosisEditingId = nodeId;
  renderDetailPane();
}

async function saveInlineEdit(): Promise<void> {
  const nodeId = graphnosisEditingId;
  if (!nodeId || !atlasActiveGraph) return;
  const ta = document.getElementById('g-detail-edit') as HTMLTextAreaElement | null;
  if (!ta) return;
  const newContent = ta.value.trim();
  if (!newContent) {
    alert('Cannot save an empty memory. Use Forget if you want it gone.');
    return;
  }
  const node = graphnosisAllNodes.find((n) => n.id === nodeId);
  if (node && newContent === node.contentPreview.trim()) {
    // No-op; just exit edit mode.
    graphnosisEditingId = null;
    renderDetailPane();
    return;
  }
  const saveBtn = document.getElementById('btn-detail-save') as HTMLButtonElement | null;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
  }
  try {
    await invoke('node_direct_edit', {
      graphId: atlasActiveGraph,
      nodeId,
      content: newContent,
      reason: 'Direct edit from Graphnosis App',
    });
    graphnosisEditingId = null;
    // Count this as a "tend" for the session recap, and dispatch the
    // node from the deck so it doesn't reappear after a fix.
    graphnosisSessionDispatched.add(nodeId);
    graphnosisTendedThisSession++;
    // Re-fetch nodes — content changed; the search index will update on
    // the sidecar in the background, but local rows need a refresh.
    await loadGraphnosisData(atlasActiveGraph);
    applyGraphnosisFilter();
    renderDetailPane();
    void refreshStats();
    // If the Atlas is mounted, push refreshed data so labels update too.
    if (mainAtlas && graphnosisActiveTab === 'atlas') pushDataIntoAtlas();
  } catch (e) {
    showError(`Edit failed: ${e}`);
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save correction';
    }
  }
}

// ── Relationship labels catalog ───────────────────────────────────────
//
// User-facing label vocabulary for typed-relationship creation. Each
// label maps to an SDK edge type + directed flag. Directed labels carry
// the user's chosen string as the SDK's `evidence` field so the detail
// pane can render the user's vocabulary ("Works at") instead of the
// structural SDK type ("collaborated-on"). Undirected labels use the
// SDK type itself as the label.
//
// Order matters — the suggestion engine returns labels in this order
// after filtering by nodeType match, so the primary auto-pick is the
// first matching label per pair.

type DirectedSdkType =
  | 'causes' | 'depends-on' | 'precedes' | 'contains' | 'defines'
  | 'cites' | 'contradicts' | 'supports' | 'supersedes' | 'discussed-in'
  | 'knows' | 'works-with' | 'reports-to' | 'collaborated-on'
  | 'prefers' | 'summarizes';

type UndirectedSdkType =
  | 'similar-to' | 'co-occurs' | 'shares-entity' | 'shares-topic'
  | 'same-source' | 'same-person' | 'related-to';

interface RelationshipLabel {
  id: string;                   // stable id used by the popover for keying
  label: string;                // user-facing string (also the evidence for directed)
  sdkType: DirectedSdkType | UndirectedSdkType;
  directed: boolean;
  /** nodeType pairs this label is the natural default for. The empty
   *  array means it's never auto-suggested — only available via the
   *  "More…" expansion in the popover. The wildcard `'*'` matches any
   *  nodeType. */
  defaultFor: Array<[string, string]>;
}

const RELATIONSHIP_LABELS: RelationshipLabel[] = [
  // Person ↔ person — directed
  { id: 'knows',       label: 'Knows',           sdkType: 'knows',           directed: true,
    defaultFor: [['person', 'person']] },
  { id: 'works-with',  label: 'Works with',      sdkType: 'works-with',      directed: true,
    defaultFor: [['person', 'person']] },
  { id: 'reports-to',  label: 'Reports to',      sdkType: 'reports-to',      directed: true,
    defaultFor: [['person', 'person']] },

  // Person ↔ person — undirected (same identity)
  { id: 'same-person', label: 'Same person',     sdkType: 'same-person',     directed: false,
    defaultFor: [['person', 'person']] },

  // Person → organization / project / document — directed
  { id: 'works-at',    label: 'Works at',        sdkType: 'collaborated-on', directed: true,
    defaultFor: [['person', 'organization']] },
  { id: 'founded',     label: 'Founded',         sdkType: 'collaborated-on', directed: true,
    defaultFor: [['person', 'organization']] },
  { id: 'member-of',   label: 'Member of',       sdkType: 'collaborated-on', directed: true,
    defaultFor: [['person', 'organization']] },
  { id: 'leads',       label: 'Leads / works on', sdkType: 'collaborated-on', directed: true,
    defaultFor: [['person', 'concept'], ['person', 'event']] },
  { id: 'wrote',       label: 'Wrote / authored', sdkType: 'cites',           directed: true,
    defaultFor: [['person', 'document']] },

  // Place-bound
  { id: 'lives-in',    label: 'Lives in',         sdkType: 'depends-on',      directed: true,
    defaultFor: [['person', 'concept']] }, // place often comes through as concept
  { id: 'based-in',    label: 'Based in',         sdkType: 'depends-on',      directed: true,
    defaultFor: [['organization', 'concept']] },
  { id: 'located-in',  label: 'Located in',       sdkType: 'contains',        directed: true,
    defaultFor: [['concept', 'concept']] },

  // Doc + conversation
  { id: 'cited-in',    label: 'Cited in',         sdkType: 'cites',           directed: true,
    defaultFor: [['document', 'document'], ['concept', 'document']] },
  { id: 'mentioned-in', label: 'Mentioned in',    sdkType: 'discussed-in',    directed: true,
    defaultFor: [['*', 'conversation']] },

  // Concept relations
  { id: 'depends-on',  label: 'Depends on',       sdkType: 'depends-on',      directed: true,
    defaultFor: [['concept', 'concept']] },
  { id: 'builds-on',   label: 'Builds on',        sdkType: 'supports',        directed: true,
    defaultFor: [['concept', 'concept']] },
  { id: 'contradicts', label: 'Contradicts',      sdkType: 'contradicts',     directed: true,
    defaultFor: [] }, // available in More…, never auto

  // Time
  { id: 'precedes',    label: 'Precedes / follows', sdkType: 'precedes',      directed: true,
    defaultFor: [['event', 'event']] },

  // Generic undirected
  { id: 'partners-with', label: 'Partners with',  sdkType: 'related-to',      directed: false,
    defaultFor: [['organization', 'organization']] },
  { id: 'same-topic',  label: 'Same topic',       sdkType: 'shares-topic',    directed: false,
    defaultFor: [['concept', 'concept'], ['fact', 'fact']] },
  { id: 'related',     label: 'Related',          sdkType: 'related-to',      directed: false,
    defaultFor: [['*', '*']] }, // ultimate fallback
];

/**
 * Lookup the user-facing label for a given SDK type. Used by the detail
 * pane's Connections render when we DON'T have an `evidence` string
 * (auto-extracted edges, or older manual edges from before this feature).
 */
function humanizeSdkType(sdkType: string, directed: boolean): string {
  // Prefer a label whose defaultFor isn't empty (i.e. one we'd actually
  // pick for that type) over generic "Related" — gives nicer fallbacks
  // for auto-extracted edges like `shares-entity` → "Same topic"-ish.
  const candidates = RELATIONSHIP_LABELS.filter((r) => r.sdkType === sdkType && r.directed === directed);
  const meaningful = candidates.find((r) => r.defaultFor.length > 0);
  if (meaningful) return meaningful.label;
  if (candidates[0]) return candidates[0].label;
  // Final fallback: humanize the raw SDK type ("shares-entity" → "Shares entity").
  return sdkType
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Given a (source, candidate) pair, return the primary auto-suggested
 * label + up to 3 alternatives. The primary's `auto: false` flag means
 * the system couldn't decide between competing labels — the user must
 * click the type pill before connecting. (Person+person is the canonical
 * case: Knows / Works with / Reports to are all plausible and the user
 * should choose.)
 */
interface SuggestedLabel {
  id: string;
  label: string;
  sdkType: string;
  directed: boolean;
  auto: boolean;
  fromId: string;
  toId: string;
}
function suggestRelationshipLabels(
  source: NodeRecord,
  candidate: NodeRecord,
): { primary: SuggestedLabel; alternatives: SuggestedLabel[] } {
  const srcType = source.nodeType ?? '*';
  const candType = candidate.nodeType ?? '*';
  const matches = (l: RelationshipLabel): boolean =>
    l.defaultFor.some(([a, b]) =>
      (a === srcType || a === '*') && (b === candType || b === '*'),
    );
  // First pass: labels whose defaultFor explicitly matches this pair.
  // Wildcard ('*') matches last so concrete pairs beat generic fallbacks.
  const exact = RELATIONSHIP_LABELS.filter(
    (l) => l.defaultFor.some(([a, b]) => a === srcType && b === candType),
  );
  const wildcardish = RELATIONSHIP_LABELS.filter((l) => matches(l) && !exact.includes(l));
  const ranked = [...exact, ...wildcardish];
  // Always ensure 'Related' is at the very end as a fallback safety net.
  const related = RELATIONSHIP_LABELS.find((l) => l.id === 'related');
  if (related && !ranked.includes(related)) ranked.push(related);

  const toSuggestion = (l: RelationshipLabel, auto: boolean): SuggestedLabel => ({
    id: l.id,
    label: l.label,
    sdkType: l.sdkType,
    directed: l.directed,
    auto,
    fromId: source.id,
    toId: candidate.id,
  });

  const first = ranked[0];
  if (!first) {
    // Shouldn't happen (Related always matches *,*) but be defensive.
    const fallback = RELATIONSHIP_LABELS.find((l) => l.id === 'related');
    if (!fallback) throw new Error('Relationship catalog missing the Related fallback');
    return { primary: toSuggestion(fallback, true), alternatives: [] };
  }

  // If the top-3 includes ≥2 directed-different labels for the SAME pair
  // (person+person → Knows / Works with / Reports to), call it ambiguous
  // and force the user to pick.
  const top3 = ranked.slice(0, 3);
  const distinctDirected = new Set(top3.filter((l) => l.directed).map((l) => l.id));
  const ambiguous = srcType === 'person' && candType === 'person' && distinctDirected.size >= 2;

  return {
    primary: toSuggestion(first, !ambiguous),
    alternatives: ranked.slice(1, 4).map((l) => toSuggestion(l, true)),
  };
}

// ── Related memories (semantic candidates) ───────────────────────────
//
// The SDK doesn't auto-link memories across separate ingests, so a node
// added via Claude often shows as orphan even when it shares meaning
// with existing nodes (the user's report: "NYFA is in my files too").
// To bridge that gap we surface semantically similar nodes via the
// existing BGE search IPC, and offer a one-tap Link action that creates
// a real undirected edge via the new `node_link` Tauri command.

async function getRelatedMemories(nodeId: string): Promise<RelatedItem[]> {
  // Serve cached result if we already asked. Cache is cleared on data
  // reload + successful link so this stays correct.
  const cached = graphnosisRelatedCache.get(nodeId);
  if (cached) return cached;
  if (!atlasActiveGraph) return [];
  const node = graphnosisAllNodes.find((n) => n.id === nodeId);
  if (!node || !node.contentPreview.trim()) {
    graphnosisRelatedCache.set(nodeId, []);
    return [];
  }
  // Skip the IPC altogether for trivially-short content (single tokens,
  // source-ref junk). Below ~5 chars BGE will mostly return noise.
  if (node.contentPreview.trim().length < 5) {
    graphnosisRelatedCache.set(nodeId, []);
    return [];
  }
  // Existing connections shouldn't show up as "related" candidates.
  const connectedNeighbors = new Set<string>();
  const edges = lastEdgesByGraph.get(atlasActiveGraph);
  if (edges) {
    for (const e of edges.directed) {
      if (e.from === nodeId) connectedNeighbors.add(e.to);
      else if (e.to === nodeId) connectedNeighbors.add(e.from);
    }
    for (const e of edges.undirected) {
      if (e.a === nodeId) connectedNeighbors.add(e.b);
      else if (e.b === nodeId) connectedNeighbors.add(e.a);
    }
  }
  try {
    const hits = (await invoke('search_nodes', {
      graphId: atlasActiveGraph,
      query: node.contentPreview,
      k: 10,
    })) as SearchHit[];
    const now = Date.now();
    const related: RelatedItem[] = [];
    for (const h of hits) {
      if (h.nodeId === nodeId) continue;            // skip self
      if (connectedNeighbors.has(h.nodeId)) continue; // skip existing edges
      // Filter out forgotten / soft-deleted nodes.
      const cached = graphnosisAllNodes.find((n) => n.id === h.nodeId);
      if (cached) {
        if (cached.confidence <= 0.2) continue;
        if (cached.validUntil !== undefined && cached.validUntil < now) continue;
      }
      related.push({
        nodeId: h.nodeId,
        score: h.score,
        contentPreview: cached?.contentPreview ?? h.text,
        sourceFile: cached?.sourceFile ?? '',
      });
      if (related.length >= 5) break;
    }
    graphnosisRelatedCache.set(nodeId, related);
    return related;
  } catch (e) {
    console.error('related lookup failed', e);
    graphnosisRelatedCache.set(nodeId, []);
    return [];
  }
}

// ── Entity-aware candidate ranking ────────────────────────────────────
//
// The typed-relationship suggestion panel needs richer candidates than
// the legacy `getRelatedMemories` flow gives us:
//   • Full NodeRecord (not just preview + score) so the panel can pass
//     nodeType into the relationship suggester
//   • Up to ~12 results (vs the old 5) so the user has real choice
//   • Boost candidates that SHARE ENTITIES with the source — those are
//     the bridges the user is most likely confirming ("Stela also shows
//     up in these other 4 memories")
//   • Falls back to BGE-semantic when entity overlap is thin
//
// Cached per source-node-id; invalidated on data reload + after any
// successful link from either endpoint.

interface Candidate {
  node: NodeRecord;
  /** Combined score (0..~2 with the person-boost). Higher = more likely
   *  to be a meaningful bridge. */
  score: number;
  /** Entities that appear in BOTH source and candidate — the "why this
   *  was suggested" signal. Surfaced in the panel for transparency. */
  sharedEntities: string[];
}

const graphnosisCandidatesCache: Map<string, Candidate[]> = new Map();

function jaccardOverlap<T>(a: Iterable<T>, b: Iterable<T>): { intersection: T[]; jaccard: number } {
  const aSet = new Set(a);
  const bSet = new Set(b);
  const inter: T[] = [];
  for (const x of aSet) if (bSet.has(x)) inter.push(x);
  const unionSize = aSet.size + bSet.size - inter.length;
  return { intersection: inter, jaccard: unionSize === 0 ? 0 : inter.length / unionSize };
}

// Cheap heuristic: does this entity LOOK like a person name?
// 2+ capitalized words, no digits, no dot-notation, no all-caps acronyms.
// Used to boost person-bridge candidates (the user's primary use case).
function isPersonLikeEntity(e: string): boolean {
  if (!e || e.length < 4 || e.length > 60) return false;
  if (/\d/.test(e)) return false;
  if (e.includes('.')) return false;
  if (e === e.toUpperCase() && e.length < 10) return false; // ACRONYM
  const words = e.split(/\s+/);
  if (words.length < 2) return false;
  return words.every((w) => /^[A-ZÀ-Ý][a-zà-ÿ'-]+/.test(w));
}

async function getRelatedCandidates(nodeId: string): Promise<Candidate[]> {
  const cached = graphnosisCandidatesCache.get(nodeId);
  if (cached) return cached;
  if (!atlasActiveGraph) return [];
  const source = graphnosisAllNodes.find((n) => n.id === nodeId);
  if (!source) {
    graphnosisCandidatesCache.set(nodeId, []);
    return [];
  }

  // Existing connections shouldn't show up — the user already linked
  // them. Includes both directions for directed edges.
  const connectedNeighbors = new Set<string>();
  const edges = lastEdgesByGraph.get(atlasActiveGraph);
  if (edges) {
    for (const e of edges.directed) {
      if (e.from === nodeId) connectedNeighbors.add(e.to);
      else if (e.to === nodeId) connectedNeighbors.add(e.from);
    }
    for (const e of edges.undirected) {
      if (e.a === nodeId) connectedNeighbors.add(e.b);
      else if (e.b === nodeId) connectedNeighbors.add(e.a);
    }
  }

  // Pull BGE-semantic candidates (as before) — gives us the long tail.
  let bgeHits: SearchHit[] = [];
  if (source.contentPreview.trim().length >= 5) {
    try {
      bgeHits = (await invoke('search_nodes', {
        graphId: atlasActiveGraph,
        query: source.contentPreview,
        k: 20,
      })) as SearchHit[];
    } catch (e) {
      console.error('candidate lookup failed', e);
    }
  }
  // Normalize BGE scores to 0..1 for the combined ranking.
  const maxBge = bgeHits.reduce((m, h) => Math.max(m, h.score), 0) || 1;
  const bgeScore = new Map<string, number>();
  for (const h of bgeHits) bgeScore.set(h.nodeId, h.score / maxBge);

  // For entity-based candidates, scan the full graph node cache. This
  // is O(N) but N is bounded by the engram's active node count; the
  // cache hit ratio above keeps this rare.
  const sourceEntities = source.entities ?? [];
  const now = Date.now();
  const scored: Candidate[] = [];
  for (const n of graphnosisAllNodes) {
    if (n.id === nodeId) continue;
    if (connectedNeighbors.has(n.id)) continue;
    if (n.confidence <= 0.2) continue;
    if (n.validUntil !== undefined && n.validUntil < now) continue;

    const { intersection, jaccard } = jaccardOverlap(sourceEntities, n.entities ?? []);
    const bge = bgeScore.get(n.id) ?? 0;
    // Only include nodes that have SOME signal — either real entity
    // overlap or a BGE hit above ~0.3 normalized. Pure 0/0 candidates
    // would just be noise.
    if (jaccard === 0 && bge < 0.3) continue;
    // Combined score: weight entity overlap higher than BGE because it
    // gives concrete "we share this person" semantics; the ×1.5 boost
    // for person-shaped entity matches biases toward the user's main
    // use case (connecting memories that mention the same person).
    let score = 0.5 * jaccard + 0.5 * bge;
    if (intersection.some((e) => typeof e === 'string' && isPersonLikeEntity(e))) {
      score *= 1.5;
    }
    scored.push({ node: n, score, sharedEntities: intersection as string[] });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 12);
  graphnosisCandidatesCache.set(nodeId, top);
  return top;
}

// Create a typed edge via the sidecar. Returns true on success.
// Routes to node_link (undirected) or node_link_directed (directed)
// based on the suggestion's `directed` flag. The user-friendly label
// rides on `evidence` for directed edges.
//
// Invalidates BOTH caches (legacy + new candidates) for the two
// endpoints so the just-linked memory stops being suggested.
async function linkOne(suggestion: SuggestedLabel, evidence?: string): Promise<boolean> {
  if (!atlasActiveGraph) return false;
  try {
    if (suggestion.directed) {
      const params: { graphId: string; fromNodeId: string; toNodeId: string; type: string; evidence?: string } = {
        graphId: atlasActiveGraph,
        fromNodeId: suggestion.fromId,
        toNodeId: suggestion.toId,
        type: suggestion.sdkType,
      };
      // Use the explicit evidence override (custom labels), else the
      // suggestion's human label (e.g. "Works at" for collaborated-on).
      const ev = evidence ?? suggestion.label;
      if (ev) params.evidence = ev;
      await invoke('node_link_directed', params);
    } else {
      await invoke('node_link', {
        graphId: atlasActiveGraph,
        fromNodeId: suggestion.fromId,
        toNodeId: suggestion.toId,
        type: suggestion.sdkType,
        reason: `User-confirmed: ${suggestion.label}`,
      });
    }
    // Cache invalidation: both endpoints' lists are now stale.
    graphnosisRelatedCache.delete(suggestion.fromId);
    graphnosisRelatedCache.delete(suggestion.toId);
    graphnosisCandidatesCache.delete(suggestion.fromId);
    graphnosisCandidatesCache.delete(suggestion.toId);
    // Reload edges so the new link is reflected in connections + orphan set.
    await loadGraphnosisData(atlasActiveGraph);
    if (mainAtlas) pushDataIntoAtlas();
    return true;
  } catch (e) {
    showError(`Link failed: ${e}`);
    return false;
  }
}

// Backward-compat shim for the existing 🔗 Link single-button flow that
// always created a generic undirected `related-to` edge. New code should
// build a `SuggestedLabel` and call `linkOne` directly.
async function linkNodes(fromNodeId: string, toNodeId: string): Promise<boolean> {
  const suggestion: SuggestedLabel = {
    id: 'related',
    label: 'Related',
    sdkType: 'related-to',
    directed: false,
    auto: true,
    fromId: fromNodeId,
    toId: toNodeId,
  };
  return linkOne(suggestion);
}

// ── Suggestion panel (shared between deck cards + detail pane) ────────
//
// Renders into the given `slot` element. Same renderer powers two
// surfaces:
//   • Deck cards (orphan + connect + optional low-confidence expansion):
//     panel is inline inside the card; on Connect → showDeckAck + advance
//     via `onConnected`.
//   • Detail pane: panel sits below the existing Connections section;
//     on Connect → re-render detail pane (the Connections list refreshes
//     with the new typed entries) via `onConnected`.
//
// State is closed over inside the function — each call to
// `renderSuggestionPanel` owns its own state. The slot's data-source-id
// is the race-guard: if the user switches to a different node mid-load,
// the async pieces check the slot's current id and bail.

interface SuggestionPanelOpts {
  sourceNode: NodeRecord;
  slot: HTMLElement;
  variant: 'deck' | 'detail';
  /** Called after a successful Connect (any number of edges created).
   *  Deck variant uses this to advance; detail variant uses it to
   *  re-render its own state. */
  onConnected: (count: number) => void;
}

async function renderSuggestionPanel(opts: SuggestionPanelOpts): Promise<void> {
  const { sourceNode, slot, variant, onConnected } = opts;
  slot.dataset['sourceId'] = sourceNode.id;
  slot.classList.add('g-suggest-panel');

  // Per-instance state.
  const selected = new Map<string, SuggestedLabel>(); // candidateId → chosen label
  const customLabels = new Map<string, string>();      // candidateId → custom string
  let searchQuery = '';
  let searchResults: NodeRecord[] | null = null;
  let searchToken = 0;
  let showMore = false;
  let openPopoverFor: string | null = null;

  slot.innerHTML = '<p class="subtitle" style="padding: 8px;">Looking for candidates…</p>';
  const candidates = await getRelatedCandidates(sourceNode.id);
  // Race-guard: another node may have been selected while we awaited.
  if (slot.dataset['sourceId'] !== sourceNode.id) return;

  function suggestionForCandidate(cand: NodeRecord): { primary: SuggestedLabel; alternatives: SuggestedLabel[] } {
    return suggestRelationshipLabels(sourceNode, cand);
  }

  function visibleCandidates(): NodeRecord[] {
    if (searchResults !== null) return searchResults;
    const all = candidates.map((c) => c.node);
    return showMore ? all : all.slice(0, 8);
  }

  function selectedAndReady(): SuggestedLabel[] {
    const out: SuggestedLabel[] = [];
    for (const [, s] of selected) {
      if (!s.auto && !customLabels.get(s.toId)) {
        // For ambiguous rows the user must pick (we set auto=true in
        // the suggestion once they commit a choice).
        continue;
      }
      out.push(s);
    }
    return out;
  }

  function render(): void {
    const rows = visibleCandidates();
    const totalAvailable = candidates.length;
    const hasMore = searchResults === null && totalAvailable > rows.length;
    const readyCount = selectedAndReady().length;
    const selectedTotal = selected.size;
    // Dim is driven by CSS rules over .selected (per-row) + the
    // panel-level .popover-open class — toggled by openPopover/closePopover.
    // We don't toggle has-selection anymore: selecting a row no longer
    // dims the others. (Selected rows dim themselves; popover focus
    // dims everything except the row being edited.)
    void selectedTotal;

    if (rows.length === 0) {
      slot.innerHTML = `
        <div class="g-suggest-header">
          <input type="search" class="g-suggest-search" placeholder="Don't see it? Search this engram…" value="${escape(searchQuery)}" />
          ${variant === 'detail' ? '<button class="g-suggest-close" title="Close">×</button>' : ''}
        </div>
        <p class="subtitle" style="padding: 12px 8px;">
          ${searchResults !== null
            ? 'No matches for that search.'
            : 'No related candidates yet — try searching above, or add more memories so the entity ranker has something to work with.'}
        </p>
      `;
    } else {
      slot.innerHTML = `
        <div class="g-suggest-header">
          <input type="search" class="g-suggest-search" placeholder="Don't see it? Search this engram…" value="${escape(searchQuery)}" />
          ${variant === 'detail' ? '<button class="g-suggest-close" title="Close">×</button>' : ''}
        </div>
        <div class="g-suggest-rows">
          ${rows.map((cand) => renderRow(cand)).join('')}
        </div>
        ${hasMore ? `<button class="g-suggest-show-more">Show ${totalAvailable - rows.length} more</button>` : ''}
        <div class="g-suggest-actions">
          <button class="g-suggest-connect primary" ${readyCount === 0 ? 'disabled' : ''}>
            ✓ Connect${readyCount > 0 ? ` (${readyCount}${readyCount < selectedTotal ? ` of ${selectedTotal}` : ''})` : ''}
          </button>
          <button class="g-suggest-cancel">Cancel</button>
        </div>
        ${selectedTotal > readyCount ? `<p class="g-suggest-warn">${selectedTotal - readyCount} row${selectedTotal - readyCount === 1 ? '' : 's'} still need${selectedTotal - readyCount === 1 ? 's' : ''} a relationship type — click the “Pick a type” pill.</p>` : ''}
      `;
    }

    wireHandlers();
    // If a popover was open before the re-render, restore it.
    if (openPopoverFor) {
      const row = slot.querySelector<HTMLElement>(`.g-suggest-row[data-candidate-id="${cssEscape(openPopoverFor)}"]`);
      if (row) {
        openPopover(openPopoverFor, row);
      } else {
        openPopoverFor = null;
      }
    }
  }

  function renderRow(cand: NodeRecord): string {
    const isSelected = selected.has(cand.id);
    const chosen = selected.get(cand.id);
    const { primary } = suggestionForCandidate(cand);
    const pillLabel = chosen?.label ?? primary.label;
    const pillNeedsPick = !chosen && !primary.auto;
    const clean = cleanDisplayContent(cand.contentPreview);
    const breadcrumb = renderBreadcrumb(cand);
    const customLabel = customLabels.get(cand.id);
    return `
      <div class="g-suggest-row${isSelected ? ' selected' : ''}${pillNeedsPick ? ' needs-pick' : ''}" data-candidate-id="${escape(cand.id)}">
        <label class="g-suggest-check">
          <input type="checkbox" class="g-suggest-check-input" ${isSelected ? 'checked' : ''} />
        </label>
        <div class="g-suggest-row-body">
          <div class="g-suggest-content">${escape(clean)}</div>
          ${breadcrumb ? `<div class="g-suggest-breadcrumb">${breadcrumb}</div>` : ''}
          ${customLabel ? `<div class="g-suggest-custom-shown">Custom label: <em>${escape(customLabel)}</em></div>` : ''}
        </div>
        <button class="g-suggest-type-pill${pillNeedsPick ? ' needs-pick' : ''}" data-pill-for="${escape(cand.id)}">
          ${pillNeedsPick ? 'Pick a type ▾' : `${escape(pillLabel)} ▾`}
        </button>
      </div>
    `;
  }

  function wireHandlers(): void {
    // Search input — debounced 200ms.
    const searchInput = slot.querySelector<HTMLInputElement>('.g-suggest-search');
    searchInput?.addEventListener('input', () => {
      searchQuery = searchInput.value;
      const myToken = ++searchToken;
      setTimeout(() => {
        if (myToken !== searchToken) return;
        if (searchQuery.trim().length === 0) {
          searchResults = null;
          render();
          return;
        }
        void runSearch(searchQuery, myToken);
      }, 200);
    });
    // Esc / Enter in the search box: just blur — let the user pick rows.
    searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (searchQuery.length > 0) {
          searchInput.value = '';
          searchQuery = '';
          searchResults = null;
          render();
        } else if (variant === 'detail') {
          opts.onConnected(0);
        }
        e.preventDefault();
      }
    });
    // Row click toggles selection (unless click was on the type pill).
    slot.querySelectorAll<HTMLElement>('.g-suggest-row').forEach((row) => {
      const candId = row.dataset['candidateId'];
      if (!candId) return;
      const checkbox = row.querySelector<HTMLInputElement>('.g-suggest-check-input');
      const toggle = (): void => {
        if (selected.has(candId)) {
          selected.delete(candId);
          customLabels.delete(candId);
        } else {
          // Use the suggested primary as the default; if it's not auto,
          // we keep selected but disable Connect for this row until the
          // user commits a type via the pill.
          const cand = findCandidate(candId);
          if (!cand) return;
          const { primary } = suggestionForCandidate(cand);
          selected.set(candId, primary);
        }
        render();
      };
      row.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.g-suggest-type-pill')) return; // pill has its own handler
        if (target.closest('.g-suggest-popover')) return;
        toggle();
      });
      checkbox?.addEventListener('change', toggle);
    });
    // Type pill → popover.
    slot.querySelectorAll<HTMLButtonElement>('.g-suggest-type-pill').forEach((btn) => {
      const candId = btn.dataset['pillFor'];
      if (!candId) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest<HTMLElement>('.g-suggest-row');
        if (!row) return;
        if (openPopoverFor === candId) {
          closePopover();
        } else {
          openPopover(candId, row);
        }
      });
    });
    slot.querySelector<HTMLButtonElement>('.g-suggest-show-more')?.addEventListener('click', () => {
      showMore = true;
      render();
    });
    slot.querySelector<HTMLButtonElement>('.g-suggest-connect')?.addEventListener('click', () => {
      void commitSelections();
    });
    slot.querySelector<HTMLButtonElement>('.g-suggest-cancel')?.addEventListener('click', () => {
      // Clear state and notify caller — they decide whether to dismiss
      // the panel (detail variant) or treat it like skip (deck variant).
      selected.clear();
      customLabels.clear();
      onConnected(0);
    });
    slot.querySelector<HTMLButtonElement>('.g-suggest-close')?.addEventListener('click', () => {
      onConnected(0);
    });
  }

  function findCandidate(candId: string): NodeRecord | null {
    if (searchResults) {
      return searchResults.find((n) => n.id === candId) ?? null;
    }
    return candidates.find((c) => c.node.id === candId)?.node ?? null;
  }

  async function runSearch(query: string, myToken: number): Promise<void> {
    if (!atlasActiveGraph) return;
    try {
      const hits = (await invoke('search_nodes', {
        graphId: atlasActiveGraph,
        query,
        k: 20,
      })) as SearchHit[];
      if (myToken !== searchToken) return;
      const now = Date.now();
      searchResults = hits
        .map((h) => {
          const cached = graphnosisAllNodes.find((n) => n.id === h.nodeId);
          if (cached) return cached;
          // Synthesize a minimal NodeRecord for hits not in the local cache.
          return {
            id: h.nodeId,
            confidence: h.score,
            sourceFile: '',
            contentPreview: h.text,
          } satisfies NodeRecord;
        })
        .filter((n) =>
          n.id !== sourceNode.id &&
          n.confidence > 0.2 &&
          (n.validUntil === undefined || n.validUntil > now),
        );
      render();
    } catch (e) {
      console.error('panel search failed', e);
    }
  }

  function openPopover(candId: string, row: HTMLElement): void {
    closePopover();
    openPopoverFor = candId;
    // Visual focus state: panel enters "popover-open" mode (CSS dims
    // every row except the popover-active one); the originating row
    // gets `popover-active` so it stays in full color even when the
    // user already checked it.
    slot.classList.add('popover-open');
    row.classList.add('popover-active');
    const cand = findCandidate(candId);
    if (!cand) return;
    const { primary, alternatives } = suggestionForCandidate(cand);
    const customForRow = customLabels.get(candId) ?? '';
    const popover = document.createElement('div');
    popover.className = 'g-suggest-popover';
    // Mark which row this popover belongs to so global click-outside
    // dismissal can still find it.
    popover.dataset['candidateId'] = candId;
    popover.innerHTML = `
      <div class="g-suggest-popover-section">
        <p class="g-suggest-popover-label">Suggested${primary.auto ? '' : ' — pick one'}</p>
        <button class="g-suggest-popover-option ${selected.get(candId)?.id === primary.id ? 'active' : ''}" data-option="${escape(primary.id)}">
          ${escape(primary.label)} ${primary.directed ? '<span class="g-suggest-dir">→</span>' : ''}
        </button>
        ${alternatives.map((alt) => `
          <button class="g-suggest-popover-option ${selected.get(candId)?.id === alt.id ? 'active' : ''}" data-option="${escape(alt.id)}">
            ${escape(alt.label)} ${alt.directed ? '<span class="g-suggest-dir">→</span>' : ''}
          </button>
        `).join('')}
      </div>
      <div class="g-suggest-popover-section">
        <p class="g-suggest-popover-label">More…</p>
        <div class="g-suggest-popover-more">
          ${RELATIONSHIP_LABELS
            .filter((l) => l.id !== primary.id && !alternatives.some((a) => a.id === l.id))
            .map((l) => `
              <button class="g-suggest-popover-option small ${selected.get(candId)?.id === l.id ? 'active' : ''}" data-option="${escape(l.id)}">
                ${escape(l.label)} ${l.directed ? '<span class="g-suggest-dir">→</span>' : ''}
              </button>
            `).join('')}
        </div>
      </div>
      <div class="g-suggest-popover-section">
        <p class="g-suggest-popover-label">Custom label</p>
        <input type="text" class="g-suggest-custom-input" placeholder="e.g. Old roommate, Ski buddy…" value="${escape(customForRow)}" />
        <p class="g-suggest-custom-hint">Free text — stored as the edge's evidence. Will be a directed “Related” edge.</p>
      </div>
    `;
    // Mount at body level — position: fixed in CSS means the popover
    // floats above any ancestor's overflow:hidden / sticky stacking
    // context. Coordinates derived from the pill's bounding rect.
    document.body.appendChild(popover);
    positionPopoverAt(popover, row);
    // Re-position on viewport changes — keeps the popover anchored
    // even when the deck scrolls under it.
    const reposition = (): void => positionPopoverAt(popover, row);
    window.addEventListener('resize', reposition);
    // Track the scroll container too (the deck's overflow-y: auto).
    const scrollParents: HTMLElement[] = [];
    let cur: HTMLElement | null = row;
    while (cur && cur !== document.body) {
      const overflowY = getComputedStyle(cur).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') scrollParents.push(cur);
      cur = cur.parentElement;
    }
    for (const sp of scrollParents) sp.addEventListener('scroll', reposition, { passive: true });
    // Stash listeners on the popover so closePopover can remove them.
    (popover as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
      window.removeEventListener('resize', reposition);
      for (const sp of scrollParents) sp.removeEventListener('scroll', reposition);
    };
    // Click-outside dismissal: ignore clicks inside the popover or on
    // the originating pill (which has its own toggle handler).
    const outsideHandler = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (popover.contains(target)) return;
      if (target.closest('.g-suggest-type-pill')) return;
      closePopover();
    };
    // Esc-to-close: capture-phase listener so it wins over input/textarea
    // handlers inside the popover that might also bind Esc.
    const escHandler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      closePopover();
    };
    setTimeout(() => {
      document.addEventListener('mousedown', outsideHandler);
      document.addEventListener('keydown', escHandler, true);
    }, 0);
    const prevCleanup = (popover as HTMLElement & { _cleanup?: () => void })._cleanup;
    (popover as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
      prevCleanup?.();
      document.removeEventListener('mousedown', outsideHandler);
      document.removeEventListener('keydown', escHandler, true);
    };

    popover.querySelectorAll<HTMLButtonElement>('.g-suggest-popover-option').forEach((opt) => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const optionId = opt.dataset['option'];
        if (!optionId) return;
        const labelDef = RELATIONSHIP_LABELS.find((l) => l.id === optionId);
        if (!labelDef) return;
        // Once the user explicitly picks, treat it as auto:true so
        // Connect enables for this row.
        const newSuggestion: SuggestedLabel = {
          id: labelDef.id,
          label: labelDef.label,
          sdkType: labelDef.sdkType,
          directed: labelDef.directed,
          auto: true,
          fromId: sourceNode.id,
          toId: candId,
        };
        selected.set(candId, newSuggestion);
        customLabels.delete(candId);
        closePopover();
        render();
      });
    });
    const customInput = popover.querySelector<HTMLInputElement>('.g-suggest-custom-input');
    customInput?.addEventListener('input', () => {
      const v = customInput.value.trim();
      if (v.length === 0) {
        customLabels.delete(candId);
      } else {
        customLabels.set(candId, v);
      }
    });
    customInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = customInput.value.trim();
        if (v.length > 0) {
          // Custom label → directed `related-to` edge with the label as
          // evidence. (The SDK's UndirectedEdge has no evidence field;
          // documented v1 limitation.)
          const newSuggestion: SuggestedLabel = {
            id: 'custom',
            label: v,
            sdkType: 'related-to',
            directed: true, // store as directed so evidence sticks
            auto: true,
            fromId: sourceNode.id,
            toId: candId,
          };
          selected.set(candId, newSuggestion);
          customLabels.set(candId, v);
          closePopover();
          render();
        }
        e.preventDefault();
      }
    });
  }

  function closePopover(): void {
    openPopoverFor = null;
    // Clear focus state — every row resumes its baseline dim rules
    // (selected rows dim themselves, others go back to full color).
    slot.classList.remove('popover-open');
    slot.querySelectorAll<HTMLElement>('.g-suggest-row.popover-active').forEach((r) => {
      r.classList.remove('popover-active');
    });
    // Popovers now live at body level — find by data-candidate-id rather
    // than scanning the slot. Run each one's cleanup (scroll listeners,
    // outside-click handler) before removing the DOM node.
    document.body.querySelectorAll<HTMLElement>('.g-suggest-popover').forEach((p) => {
      const cleanup = (p as HTMLElement & { _cleanup?: () => void })._cleanup;
      cleanup?.();
      p.remove();
    });
  }

  // Position the body-level popover hugging the pill it belongs to.
  // Anchored just under the pill (2px gap so it reads as visually
  // attached), left-aligned with the pill so it opens FROM the button
  // instead of floating off to one side. Flips above when there's no
  // room below; clamps horizontally to keep it on-screen.
  function positionPopoverAt(popover: HTMLElement, row: HTMLElement): void {
    const pill = row.querySelector<HTMLElement>('.g-suggest-type-pill');
    if (!pill) return;
    const rect = pill.getBoundingClientRect();
    const popH = popover.offsetHeight || 320;
    const popW = popover.offsetWidth || 280;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // Vertical: directly under the pill if there's room, otherwise
    // immediately above it. Tight 2px gap reads as "this opened from
    // the button" instead of "this floated in from elsewhere."
    const spaceBelow = vh - rect.bottom;
    const top = spaceBelow >= popH + 8
      ? rect.bottom + 2
      : Math.max(8, rect.top - popH - 2);
    // Horizontal: prefer left-aligned with the pill so the popover
    // opens FROM the pill's edge. If that would overflow the right
    // edge of the viewport, slide left just enough to fit.
    let left = rect.left;
    if (left + popW > vw - 8) {
      left = Math.max(8, vw - popW - 8);
    } else {
      left = Math.max(8, left);
    }
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.style.right = 'auto';
  }

  async function commitSelections(): Promise<void> {
    const ready = selectedAndReady();
    if (ready.length === 0) return;
    const connectBtn = slot.querySelector<HTMLButtonElement>('.g-suggest-connect');
    if (connectBtn) {
      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting…';
    }
    let createdCount = 0;
    for (const s of ready) {
      const evidence = s.id === 'custom' ? customLabels.get(s.toId) : undefined;
      const ok = await linkOne(s, evidence);
      if (ok) createdCount++;
    }
    onConnected(createdCount);
  }

  render();
}

// Strip the SDK's structural markdown markers from the displayed content
// so cards don't show *asterisks*, leading list-numbers, etc. The raw
// content stays in `n.contentPreview` for recall/search — this is purely
// a display polish layer over the in-memory cache.
//
// Examples that show up in real ingests:
//   "*Document pregătit...*"      → "Document pregătit..."
//   "3. Descrierea proiectului"   → "Descrierea proiectului"
//   "- some bullet"               → "some bullet"
//   "## A heading"                → "A heading"
//   ">  quoted line"              → "quoted line"
function cleanDisplayContent(raw: string): string {
  if (!raw) return raw;
  let s = raw.trim();
  // Leading list / heading / quote markers (markdown).
  s = s.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '');
  // Strip enclosing `*`, `**`, `_`, `__` pairs at start+end of the whole
  // string. Don't strip mid-string emphasis — that's intentional content.
  for (const pair of ['**', '__', '*', '_']) {
    if (s.startsWith(pair) && s.endsWith(pair) && s.length > pair.length * 2) {
      s = s.slice(pair.length, -pair.length).trim();
    }
  }
  // Inline backtick strip on bare-code-span content.
  if (s.startsWith('`') && s.endsWith('`') && s.length > 2) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

// A node is "structural noise" if it's a markdown chrome node (the SDK
// emits 'document' and 'section' parent nodes whose content is just the
// heading text). Surfacing these in the review deck is useless — the
// real review unit is the section's leaf nodes grouped under it.
// Also catches absurdly-short fragments (< 25 chars after cleaning) that
// don't carry enough context for a "looks right?" decision.
function isStructuralNoise(n: NodeRecord): boolean {
  if (n.nodeType === 'document' || n.nodeType === 'section') return true;
  const clean = cleanDisplayContent(n.contentPreview);
  if (clean.length < 25) return true;
  // > 50% punctuation/whitespace → noise (e.g., "* * *", "---", "###").
  const punct = clean.replace(/[\w\s]/g, '').length;
  if (punct / clean.length > 0.5) return true;
  return false;
}

// Render the breadcrumb shown above a node's content in the deck and
// detail pane. Pulls source + section together — section is optional
// because not every ingest path (clip, plain text) sets one.
function renderBreadcrumb(n: NodeRecord): string {
  const sourcePart = n.sourceFile ? prettySourceLabel(n.sourceFile) : '';
  if (!sourcePart && !n.section) return '';
  if (sourcePart && n.section) {
    return `${escape(sourcePart)} <span style="opacity: 0.55;">›</span> ${escape(n.section)}`;
  }
  return escape(sourcePart || n.section || '');
}

// Pretty-render a source ref. "clip:1778...:Educație NYFA" becomes
// "remembered via Claude · 3 min ago". File paths stay as filename.
function prettySourceLabel(sourceRef: string): string {
  if (!sourceRef) return '';
  const clipMatch = sourceRef.match(/^clip:(\d+)(?::.*)?$/);
  if (clipMatch && clipMatch[1]) {
    const ts = Number.parseInt(clipMatch[1], 10);
    if (Number.isFinite(ts) && ts > 0) {
      return `remembered via Claude · ${humanTimeSince(ts)}`;
    }
    return 'remembered via Claude';
  }
  // file path → basename
  if (sourceRef.includes('/')) return sourceRef.split('/').pop() ?? sourceRef;
  return sourceRef;
}

// Compact "3 min ago" / "2 days ago" formatter. Defaults to absolute
// date once we're past a couple weeks — relative dates get useless then.
function humanTimeSince(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return 'just now';
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

// Low-level forget: actually does the work. Returns true on success.
// No confirm dialog, no UI side-effects beyond the data mutation —
// callers decide what feedback to show. Used by both the conservative
// sidebar path (with confirm) and the snappy deck path (no confirm).
async function softDeleteNode(nodeId: string): Promise<boolean> {
  if (!atlasActiveGraph) return false;
  try {
    await invoke('node_soft_delete', {
      graphId: atlasActiveGraph,
      nodeId,
      reason: 'Forgotten from Graphnosis App',
    });
    // Mutate local cache so the next render reflects the forget without
    // a round-trip. Re-fetching the whole engram is expensive on big
    // vaults; the next deliberate refresh will catch any drift.
    graphnosisAllNodes = graphnosisAllNodes.map((n) =>
      n.id === nodeId ? { ...n, confidence: 0 } : n,
    );
    // Drop from recents in every engram (defensive — same nodeId can't be
    // in multiple graphs, but the loop is cheap).
    for (const [gId, ids] of graphnosisRecentsByGraph) {
      graphnosisRecentsByGraph.set(gId, ids.filter((id) => id !== nodeId));
    }
    // Don't keep showing the forgotten node in the sidebar.
    if (graphnosisSelectedId === nodeId) {
      graphnosisSelectedId = null;
      renderDetailEmpty();
    }
    // The deck should never re-surface a forgotten node this session.
    graphnosisSessionDispatched.add(nodeId);
    renderRecents();
    void refreshStats();
    if (mainAtlas) {
      // Easiest correctness: re-push the Atlas so it drops the node.
      pushDataIntoAtlas();
    }
    return true;
  } catch (e) {
    showError(`Forget failed: ${e}`);
    return false;
  }
}

// Sidebar Forget — two-tap inline confirm. First click arms the button
// (renderDetailPane re-renders with red styling + "Tap again to confirm").
// Second click on the same node within 4s commits the forget.
async function handleSidebarForgetClick(): Promise<void> {
  const nodeId = graphnosisSelectedId;
  if (!nodeId || !atlasActiveGraph) return;
  // Already armed for THIS node → second tap, commit.
  if (graphnosisForgetArming?.nodeId === nodeId) {
    clearTimeout(graphnosisForgetArming.resetTimer);
    graphnosisForgetArming = null;
    const success = await softDeleteNode(nodeId);
    if (success) {
      graphnosisTendedThisSession++;
      applyGraphnosisFilter();
    }
    return;
  }
  // Different node armed → reset that one first.
  if (graphnosisForgetArming) {
    clearTimeout(graphnosisForgetArming.resetTimer);
    graphnosisForgetArming = null;
  }
  // Arm: button re-renders red + label changes. Auto-resets in 4s.
  graphnosisForgetArming = {
    nodeId,
    resetTimer: setTimeout(() => {
      graphnosisForgetArming = null;
      if (graphnosisSelectedId === nodeId) renderDetailPane();
    }, 4000),
  };
  renderDetailPane();
}

// Keyboard path (Backspace/Delete) — same UX as a sidebar click. Routes
// through handleSidebarForgetClick so the two-tap pattern applies there
// too (one Backspace arms the button, second Backspace commits).
async function forgetSelected(): Promise<void> {
  await handleSidebarForgetClick();
}

// ── Tabs ──────────────────────────────────────────────────────────────

function switchGraphnosisTab(tab: GraphnosisTab): void {
  graphnosisActiveTab = tab;
  document.querySelectorAll<HTMLButtonElement>('.g-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset['gtab'] === tab);
  });
  document.querySelectorAll<HTMLElement>('.g-tab-pane').forEach((p) => {
    p.classList.toggle('hidden', p.dataset['gpane'] !== tab);
  });
  if (tab === 'atlas') {
    void (async () => {
      await mountAtlasIfNeeded();
      pushDataIntoAtlas();
      // Frame the graph after a beat — same idea as before, lets the layout
      // settle before snapping the camera.
      setTimeout(() => mainAtlas?.zoomToFit(700, 60), 1200);
    })();
  } else if (tab === 'checkin') {
    // Returning to the dashboard from the Atlas tab — re-render in case
    // selection/data changed while away.
    if (els.gSearch.value.trim().length === 0) renderDashboard();
  }
}

document.querySelectorAll<HTMLButtonElement>('.g-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset['gtab'] as GraphnosisTab | undefined;
    if (tab) switchGraphnosisTab(tab);
  });
});

// ── Atlas (3D) wiring — lazy-mounted when its tab opens ───────────────

async function mountAtlasIfNeeded(): Promise<void> {
  if (mainAtlas) return;
  mainAtlas = new Atlas({
    container: els.atlasContainer,
    onSelect: (node) => {
      // Route through the shared selection so list + detail stay in sync.
      selectGraphnosisNode(node?.id ?? null);
    },
  });
}

function pushDataIntoAtlas(): void {
  if (!mainAtlas || !atlasActiveGraph) return;
  const nodes = nodesToAtlas(graphnosisAllNodes);
  mainAtlas.setNodes(nodes);
  const edges = lastEdgesByGraph.get(atlasActiveGraph);
  if (edges) {
    const activeIds = new Set(nodes.map((n) => n.id));
    const directed = edges.directed.filter((e) => activeIds.has(e.from) && activeIds.has(e.to));
    const undirected = edges.undirected.filter((e) => activeIds.has(e.a) && activeIds.has(e.b));
    mainAtlas.setEdges(directed, undirected);
  }
  renderAtlasLegend();
  // Apply current selection emphasis if any.
  if (graphnosisSelectedId) mainAtlas.select(graphnosisSelectedId);
}

function renderAtlasLegend(): void {
  if (!mainAtlas) return;
  // Edge categories
  const counts = mainAtlas.edgeCounts();
  const vis = mainAtlas.getCategoryVisibility();
  const cats: EdgeCategory[] = ['reasoning', 'structure', 'social', 'temporal', 'semantic', 'identity'];
  els.atlasLegendList.innerHTML = cats.map((c) => {
    const swatch = `#${CATEGORY_COLOR[c].toString(16).padStart(6, '0')}`;
    const cls = vis[c] ? '' : 'off';
    return `<div class="legend-row ${cls}" data-cat="${c}">
      <span class="legend-swatch" style="background: ${swatch};"></span>
      <span>${escape(CATEGORY_LABEL[c])}</span>
      <span class="legend-count">${counts[c]}</span>
    </div>`;
  }).join('');
  els.atlasLegendList.querySelectorAll<HTMLElement>('.legend-row').forEach((row) => {
    row.addEventListener('click', () => {
      const cat = row.dataset['cat'] as EdgeCategory | undefined;
      if (!cat || !mainAtlas) return;
      const current = mainAtlas.getCategoryVisibility()[cat];
      mainAtlas.setCategoryVisible(cat, !current);
      renderAtlasLegend();
    });
  });

  // Sources — same row pattern but with a dot swatch (matches node color).
  const sources = mainAtlas.sourcesWithCounts();
  els.atlasSourceList.innerHTML = sources.map((s) => {
    const swatch = `#${s.color.toString(16).padStart(6, '0')}`;
    const cls = s.visible ? '' : 'off';
    return `<div class="legend-row ${cls}" data-source-key="${escape(s.key)}" title="${escape(s.key || '(no source)')}">
      <span class="legend-swatch-dot" style="background: ${swatch};"></span>
      <span class="source-name">${escape(s.label)}</span>
      <span class="legend-count">${s.nodeCount}</span>
    </div>`;
  }).join('');
  els.atlasSourceList.querySelectorAll<HTMLElement>('.legend-row').forEach((row) => {
    row.addEventListener('click', () => {
      const key = row.dataset['sourceKey'];
      if (key === undefined || !mainAtlas) return;
      const current = mainAtlas.sourcesWithCounts().find((s) => s.key === key)?.visible ?? true;
      mainAtlas.setSourceVisible(key, !current);
      renderAtlasLegend();
    });
  });
}

els.atlasGraphPicker.addEventListener('change', () => {
  atlasActiveGraph = els.atlasGraphPicker.value;
  graphnosisSelectedId = null;
  // Recents are per-engram; the map is preserved so switching back later
  // restores the trail. renderRecents reads from the current engram.
  renderRecents();
  renderDetailEmpty();
  // Reset the per-session counters — they belong to the engram you were
  // tending. Switching engrams = starting a fresh check-in.
  graphnosisSessionDispatched.clear();
  graphnosisTendedThisSession = 0;
  void refreshAtlasView();
});

els.btnAtlasReset.addEventListener('click', () => {
  mainAtlas?.resetEmphasis();
  selectGraphnosisNode(null);
});

els.btnAtlasUnpin.addEventListener('click', () => {
  mainAtlas?.unpinAll();
});

els.btnAtlasFit.addEventListener('click', () => {
  mainAtlas?.zoomToFit(700, 60);
});

els.btnAtlasAlive.addEventListener('click', () => {
  if (!mainAtlas) return;
  const nowEnabled = mainAtlas.setAliveEnabled(!mainAtlas.isAliveEnabled());
  els.btnAtlasAlive.textContent = nowEnabled ? 'Pause motion' : 'Resume motion';
});

// ── Search input + ⌘K + clear ─────────────────────────────────────────

els.gSearch.addEventListener('input', () => {
  if (graphnosisSearchTimer !== null) clearTimeout(graphnosisSearchTimer);
  const hasValue = els.gSearch.value.length > 0;
  els.gSearchClear.classList.toggle('hidden', !hasValue);
  // 140ms gives a fluid feel without re-rendering on every keystroke when
  // typing fast.
  graphnosisSearchTimer = setTimeout(() => applyGraphnosisFilter(), 140);
});

// Sort dropdown — re-apply the filter when the user picks a new order.
// No debounce; the change is user-initiated and synchronous.
els.gSearchSortSelect.addEventListener('change', () => {
  const v = els.gSearchSortSelect.value;
  if (v === 'relevance' || v === 'confidence' || v === 'source') {
    searchSortMode = v;
    applyGraphnosisFilter();
  }
});

els.gSearchClear.addEventListener('click', () => {
  els.gSearch.value = '';
  els.gSearchClear.classList.add('hidden');
  applyGraphnosisFilter();
  els.gSearch.focus();
});

// ── Keyboard shortcuts (only when Graphnosis pane is active) ──────────
//
// ⌘K — focus the search field, anywhere.
// ↑/↓ — move selection through the list (when not typing in an input).
// Enter — focus list (or open detail; the list is already showing).
// E — start inline edit on selected node.
// Delete/Backspace — forget selected node.
// Esc — deselect, or cancel edit.

document.addEventListener('keydown', (e) => {
  if (currentMode !== 'atlas') return;
  const target = e.target as HTMLElement | null;
  const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

  // ⌘K: focus search from anywhere (even while inside another input).
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    els.gSearch.focus();
    els.gSearch.select();
    return;
  }

  if (inField) {
    // While typing, only Esc has meaning (and Enter for the search field).
    if (e.key === 'Escape') {
      if (target === els.gSearch && els.gSearch.value.length > 0) {
        els.gSearch.value = '';
        els.gSearchClear.classList.add('hidden');
        applyGraphnosisFilter();
        e.preventDefault();
        return;
      }
      if (graphnosisEditingId) {
        graphnosisEditingId = null;
        renderDetailPane();
        e.preventDefault();
        return;
      }
      els.gSearch.blur();
      e.preventDefault();
      return;
    }
    if (target === els.gSearch && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      // Jump from the search field into the first list row.
      e.preventDefault();
      if (graphnosisListRows.length > 0) {
        const first = graphnosisListRows[0];
        if (first) selectGraphnosisNode(first.id);
        els.gList.focus();
        scrollSelectedListRowIntoView();
      }
      return;
    }
    return;
  }

  // Not in a field. Keyboard nav over the list.
  switch (e.key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (graphnosisListRows.length === 0) return;
      const idx = graphnosisSelectedId
        ? graphnosisListRows.findIndex((n) => n.id === graphnosisSelectedId)
        : -1;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const nextIdx = Math.max(0, Math.min(graphnosisListRows.length - 1, (idx === -1 ? 0 : idx + step)));
      const next = graphnosisListRows[nextIdx];
      if (next) {
        selectGraphnosisNode(next.id);
        scrollSelectedListRowIntoView();
      }
      e.preventDefault();
      break;
    }
    case 'Enter': {
      // Enter on a selected list row opens the detail (already shown), and
      // jumps focus into edit. Without selection, focus search.
      if (graphnosisSelectedId) {
        startInlineEdit(graphnosisSelectedId);
      } else {
        els.gSearch.focus();
      }
      e.preventDefault();
      break;
    }
    case 'e':
    case 'E': {
      if (graphnosisSelectedId) {
        startInlineEdit(graphnosisSelectedId);
        e.preventDefault();
      }
      break;
    }
    case 'Backspace':
    case 'Delete': {
      if (graphnosisSelectedId) {
        void forgetSelected();
        e.preventDefault();
      }
      break;
    }
    case 'Escape': {
      if (graphnosisSelectedId) {
        selectGraphnosisNode(null);
        e.preventDefault();
      }
      break;
    }
  }
});

function cssColorForCategory(cat: EdgeCategory): string {
  return `#${CATEGORY_COLOR[cat].toString(16).padStart(6, '0')}`;
}

// ── Activity (op-log timeline) ────────────────────────────────────────

async function refreshActivityView(): Promise<void> {
  els.activityList.innerHTML = '<p class="subtitle">Loading…</p>';
  try {
    const r = (await invoke('list_activity')) as { events: OpLogEvent[] };
    renderActivity(r.events);
  } catch (e) {
    els.activityList.innerHTML = `<p class="error">${escape(String(e))}</p>`;
  }
}

function renderActivity(events: OpLogEvent[]): void {
  const filter = els.activityFilterKind.value;
  const filtered = filter === 'all' ? events : events.filter((e) => e.op === filter);
  filtered.sort((a, b) => b.ts - a.ts); // newest first

  els.activityStats.textContent = `${filtered.length} of ${events.length} event${events.length === 1 ? '' : 's'}`;

  if (filtered.length === 0) {
    els.activityList.innerHTML = '<p class="subtitle">No events match this filter.</p>';
    return;
  }

  // Group by day for readability.
  const byDay = new Map<string, OpLogEvent[]>();
  const dayLabel = (ts: number): string => {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  };
  for (const e of filtered) {
    const key = dayLabel(e.ts);
    const arr = byDay.get(key) ?? [];
    arr.push(e);
    byDay.set(key, arr);
  }

  let html = '';
  for (const [day, dayEvents] of byDay) {
    html += `<p class="activity-day-divider">${escape(day)}</p>`;
    for (const e of dayEvents) {
      html += renderActivityRow(e);
    }
  }
  els.activityList.innerHTML = html;
}

function renderActivityRow(e: OpLogEvent): string {
  const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const label = activityLabel(e);
  const detail = activityDetail(e);
  return `<div class="activity-row">
    <span class="ar-when">${escape(time)}</span>
    <span class="ar-dot ${e.op}"></span>
    <div>
      <div>${label}</div>
      ${detail ? `<div class="ar-detail">${detail}</div>` : ''}
    </div>
  </div>`;
}

function activityLabel(e: OpLogEvent): string {
  switch (e.op) {
    case 'ingestSource': {
      const rec = e.after as { ref?: string; nodeIds?: string[] } | undefined;
      const file = rec?.ref ? (rec.ref.split('/').pop() ?? rec.ref) : 'source';
      const count = rec?.nodeIds?.length ?? 0;
      return `Ingested <strong>${escape(file)}</strong> (+${count} node${count === 1 ? '' : 's'}) in <code>${escape(e.graphId)}</code>`;
    }
    case 'forgetSource':
      return `Forgot source <code>${escape(e.target.id.slice(0, 16))}…</code> in <code>${escape(e.graphId)}</code>`;
    case 'editNode':
      return `Edited a memory in <code>${escape(e.graphId)}</code>`;
    case 'supersede':
      return `Superseded a memory in <code>${escape(e.graphId)}</code>`;
    case 'addNode':
      return `Added a node in <code>${escape(e.graphId)}</code>`;
    case 'deleteNode':
      return `Soft-deleted a node in <code>${escape(e.graphId)}</code>`;
    case 'addEdge':
      return `Added an edge in <code>${escape(e.graphId)}</code>`;
    case 'deleteEdge':
      return `Removed an edge in <code>${escape(e.graphId)}</code>`;
    case 'merge':
      return `Merged nodes in <code>${escape(e.graphId)}</code>`;
    default:
      return `${escape(e.op)} in <code>${escape(e.graphId)}</code>`;
  }
}

function activityDetail(e: OpLogEvent): string {
  if (e.op === 'editNode' || e.op === 'supersede') {
    const after = e.after as { content?: string; reason?: string } | undefined;
    const reason = after?.reason ? `reason: ${escape(after.reason)}` : '';
    return reason;
  }
  return '';
}

els.activityFilterKind.addEventListener('change', () => void refreshActivityView());
els.btnActivityRefresh.addEventListener('click', () => void refreshActivityView());

// ── Snapshots ────────────────────────────────────────────────────────

els.btnSnapshotsOpen.addEventListener('click', () => {
  els.snapshotsModal.classList.remove('hidden');
  els.snapshotsNote.textContent = '';
  void refreshSnapshots();
});
els.btnSnapshotsClose.addEventListener('click', () => {
  els.snapshotsModal.classList.add('hidden');
});
els.btnSnapshotsCreate.addEventListener('click', async () => {
  els.btnSnapshotsCreate.disabled = true;
  els.btnSnapshotsCreate.textContent = 'Snapshotting…';
  els.snapshotsNote.textContent = '';
  try {
    const r = (await invoke('create_snapshot')) as { id: string; sizeBytes: number; fileCount: number };
    els.snapshotsNote.textContent = `Snapshot ${r.id} created — ${r.fileCount} files, ${formatBytes(r.sizeBytes)}.`;
    await refreshSnapshots();
  } catch (e) {
    els.snapshotsNote.textContent = `Snapshot failed: ${e}`;
  } finally {
    els.btnSnapshotsCreate.disabled = false;
    els.btnSnapshotsCreate.textContent = 'Create snapshot now';
  }
});

async function refreshSnapshots(): Promise<void> {
  els.snapshotsBody.innerHTML = '<p class="subtitle">Loading…</p>';
  try {
    const r = (await invoke('list_snapshots')) as { snapshots: SnapshotInfo[] };
    if (r.snapshots.length === 0) {
      els.snapshotsBody.innerHTML = `
        <p class="subtitle">No snapshots yet.</p>
        <p class="subtitle" style="margin-top: 8px; font-size: 11px;">
          Snapshots are useful before a risky re-ingest, a big batch of corrections,
          or any change you might want to undo. They live in <code>&lt;vault&gt;/.snapshots/</code>
          and stay encrypted.
        </p>`;
      return;
    }
    els.snapshotsBody.innerHTML = r.snapshots.map((s) => `
      <div class="snapshot-row">
        <div>
          <div><code>${escape(s.id)}</code></div>
          <div class="snapshot-meta">${escape(new Date(s.createdAt).toLocaleString())}</div>
        </div>
        <div class="snapshot-meta">${s.fileCount} files</div>
        <div class="snapshot-meta">${formatBytes(s.sizeBytes)}</div>
      </div>
    `).join('');
  } catch (e) {
    els.snapshotsBody.innerHTML = `<p class="error">${escape(String(e))}</p>`;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Tray-driven status updates push us into the right view in real time.
void listen<StatusSnapshot>('graphnosis://status', (evt) => render(evt.payload));

// ── Mutation push-channel ───────────────────────────────────────────
//
// The sidecar broadcasts a `graphnosis://graph-mutation` Tauri event
// every time any graph is mutated (ambient ingest, MCP `remember`,
// auto-relink, user corrections). We delegate the refresh work to
// `pollGraphMutations` — same function the 3s timer calls — so the
// push path and the poll path share one ground-truth refresh
// sequence (reload data, re-render dashboard/atlas/detail, update
// recap, update forgotten row).
//
// Three layers of staleness defence:
//   1. Push events  → sub-second updates when everything's healthy
//   2. 3s poll      → catches dropped events (backpressure, socket
//                     reconnect race)
//   3. Hello frame  → catches sidecar-restart drift (events emitted
//                     between sidecar relock and our reconnect)
//
// `pollGraphMutations` itself maintains the canonical
// `lastSeenMutationAt` cursor, so the push path doesn't need its own
// state — calling it is idempotent if the cursor hasn't advanced.

interface GraphMutationPayload {
  graphId: string;
  ts: number;
}

interface EventStreamConnectedPayload {
  ts: number;
  cursor: Record<string, number>;
}

void listen<GraphMutationPayload>('graphnosis://graph-mutation', () => {
  // Don't filter on graphId here — pollGraphMutations checks the
  // active-engram-changed predicate against the full cursor set
  // returned by inspector_stats and only repaints when relevant.
  void pollGraphMutations();
});

// Hello frame fires once per event-stream (re)connect. Run a full
// poll to reconcile cursor drift from the gap between sidecar restart
// and our subscription being established.
void listen<EventStreamConnectedPayload>('graphnosis://event-stream-connected', () => {
  void pollGraphMutations();
});

// Initial state: ask the backend whether we're already unlocked
// (e.g., auto-unlock from keychain in a future iteration).
void (async () => {
  try {
    const status = (await invoke('status')) as StatusSnapshot;
    render(status);
  } catch (e) {
    showError(String(e));
  }
})();
