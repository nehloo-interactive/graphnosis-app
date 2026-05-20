import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import {
  Atlas,
  type AtlasNode,
  type AtlasDirectedEdge,
  type AtlasUndirectedEdge,
  type EdgeCategory,
  CATEGORY_COLOR,
  CATEGORY_LABEL,
} from './atlas';
import {
  createAtlasEngine,
  ATLAS_ENGINES,
  type AtlasEngineKind,
} from './atlas-engine';

// ---- types matching Rust ------------------------------------------------

interface StatusSnapshot {
  unlocked: boolean;
  cortex_dir: string | null;
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
  /** MCP client name when this source was added or last corrected via an
   *  AI tool call (e.g. "claude-ai", "cursor"). Undefined for user-driven
   *  ingests (drag-drop, paste, file picker). */
  addedBy?: string;
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

/** Result of any `configure_mcp_client` call (Claude Desktop, Claude Code,
 *  Cursor — all share this shape). Backwards-compat name kept since the
 *  modal + helpers still reference it across the file. */
interface ClaudeConfigResult {
  /** Display name of the client we just configured (e.g. "Claude Desktop"). */
  client_name: string;
  /** One-sentence "restart X" hint shown in the modal footer after Apply. */
  restart_hint: string;
  config_path: string;
  relay_path: string;
  node_path: string;
  socket_path: string;
  already_configured: boolean;
  created_file: boolean;
  preserved_servers: string[];
}

/** Identifiers accepted by the Rust `configure_mcp_client` command. */
type McpClientId = 'claude-desktop' | 'claude-code' | 'cursor';

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
    /** When ON, the sidecar watches each file-backed source's disk path
     *  and re-ingests automatically on save. Off by default; see the
     *  Settings UI for the user-facing tradeoff. Optional on the wire
     *  for the same forward-compat reason as autoRelinkMaxNodes. */
    autoReingestOnFileChange?: boolean;
    /** Quiet period (ms): file must be unchanged this long before reingest fires.
     *  Default 900 000 (15 min). Only relevant when autoReingestOnFileChange is on. */
    reingestQuietMs?: number;
    /** SDK chunk-size preset: 'fine' / 'balanced' / 'coarse'. Default 'balanced'. */
    chunkSize?: 'fine' | 'balanced' | 'coarse';
    /** SDK embed-batch preset: 'small' / 'medium' / 'large' / 'auto'. Default 'auto'. */
    embedBatch?: 'small' | 'medium' | 'large' | 'auto';
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
  archived?: boolean;
  sensitivityTier?: 'public' | 'personal' | 'sensitive';
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
type GraphnosisTab = 'checkin' | 'atlas' | 'brain';
let graphnosisActiveTab: GraphnosisTab = 'checkin';
let graphnosisListRows: NodeRecord[] = []; // current visible search results
let graphnosisAllNodes: NodeRecord[] = []; // unfiltered cache for the active engram
let graphnosisSelectedId: string | null = null;
// Whether the current selection was set by explicit user action (search
// click, memory-trace click, 3D node click, sidebar connection click)
// vs implicitly (trivia card surfacing a candidate). Read by
// switchGraphnosisTab to decide whether to carry the selection forward
// when the 3D Engram tab opens — implicit selections get reset so the
// user lands on a clean unhighlighted graph, explicit ones persist so
// the user sees the node they navigated to.
let graphnosisSelectionExplicit = false;
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
const DECK_PAGE_SIZE = 30;          // cards served per session page
let graphnosisDeckPool: DeckItem[] = [];   // full ordered set for this session
let graphnosisDeckPageStart = 0;           // index into pool where current page starts
let graphnosisDeck: DeckItem[] = [];
let graphnosisDeckIndex = 0;
const graphnosisSessionDispatched = new Set<string>(); // nodeIds confirmed/skipped/fixed this session
let graphnosisTendedThisSession = 0; // counter shown in the recap row
let graphnosisOrphanIds: Set<string> = new Set(); // nodes with no edges, recomputed per data load

// AI-proposed correction diffs awaiting the user's approval. Polled by
// fetchPendingCorrections; surfaced as top-priority `pending-correction`
// cards in the deck queue (folded in here after the user wanted the
// Corrections rail tab removed). Cleared on cortex lock.
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
// cortex locks (we don't persist this across sessions).
const graphnosisRecentsByGraph: Map<string, string[]> = new Map();

function currentRecents(): string[] {
  return atlasActiveGraph ? graphnosisRecentsByGraph.get(atlasActiveGraph) ?? [] : [];
}
let graphnosisEditingId: string | null = null; // node currently in inline-edit mode
// Current forget mode — synced from settings whenever they are loaded/saved.
// Used to show the right deletion-behaviour note in the forget confirmation UI.
let currentForgetMode: ForgetMode = 'soft';

// State for the graph wizard.
let gwSelected: GraphTemplate | null = null;

// Sources that the user has temporarily disabled — excluded from the
// Atlas visualization until re-enabled. Keyed by sourceId; value is
// the ref (= node sourceFile path) used as the atlas sourceKey.
// Survives graph data reloads; reset on cortex lock.
const disabledSources = new Map<string, string>();

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
  cortexDir: $<HTMLInputElement>('cortex-dir'),
  passphrase: $<HTMLInputElement>('passphrase'),
  btnPick: $<HTMLButtonElement>('btn-pick'),
  btnUnlock: $<HTMLButtonElement>('btn-unlock'),
  unlockStatus: $<HTMLSpanElement>('unlock-status'),
  btnRefresh: $<HTMLButtonElement>('btn-refresh'),
  btnOpenFolder: $<HTMLButtonElement>('btn-open-folder'),
  btnLock: $<HTMLButtonElement>('btn-lock'),
  btnAddFile: $<HTMLButtonElement>('btn-add-file'),
  cortexLabel: $<HTMLSpanElement>('cortex-label'),
  activeEngramLabel: $<HTMLSpanElement>('active-engram-label'),
  sourcesList: $<HTMLDivElement>('sources-list'),
  sourcesFilter: $<HTMLInputElement>('sources-filter'),
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
  gMemoryTrace: $<HTMLDivElement>('g-memory-trace'),
  gMemoryTraceList: $<HTMLDivElement>('g-memory-trace-list'),
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
  gMcpList: $<HTMLDivElement>('g-mcp-list'),
  gDetail: $<HTMLElement>('g-detail'),
  gDetailBody: $<HTMLDivElement>('g-detail-body'),
  // Atlas (3D) sub-tab
  atlasContainer: $<HTMLDivElement>('atlas-container'),
  atlasGraphPicker: $<HTMLSelectElement>('atlas-graph-picker'),
  btnAtlasReset: $<HTMLButtonElement>('btn-atlas-reset'),
  btnAtlasFit: $<HTMLButtonElement>('btn-atlas-fit'),
  btnAtlasAlive: $<HTMLButtonElement>('btn-atlas-alive'),
  atlasLegendList: $<HTMLDivElement>('atlas-legend-list'),
  atlasSourceList: $<HTMLDivElement>('atlas-source-list'),
  // Activity
  activityList: $<HTMLDivElement>('activity-list'),
  activityFilterKind: $<HTMLSelectElement>('activity-filter-kind'),
  activityStats: $<HTMLSpanElement>('activity-stats'),
  btnActivityRefresh: $<HTMLButtonElement>('btn-activity-refresh'),
  // Snapshot offer (pre-ingest prompt)
  snapshotOfferModal: $<HTMLDivElement>('snapshot-offer-modal'),
  snapshotOfferNote: $<HTMLSpanElement>('snapshot-offer-note'),
  btnSnapshotSkip: $<HTMLButtonElement>('btn-snapshot-skip'),
  btnSnapshotConfirm: $<HTMLButtonElement>('btn-snapshot-confirm'),
  // Snapshots
  btnSnapshotsOpen: $<HTMLButtonElement>('btn-snapshots-open'),
  snapshotsModal: $<HTMLDivElement>('snapshots-modal'),
  snapshotsBody: $<HTMLDivElement>('snapshots-body'),
  snapshotsNote: $<HTMLSpanElement>('snapshots-note'),
  btnSnapshotsClose: $<HTMLButtonElement>('btn-snapshots-close'),
  btnSnapshotsCreate: $<HTMLButtonElement>('btn-snapshots-create'),
  btnConfigureClaudeDesktop: $<HTMLButtonElement>('btn-configure-claude-desktop'),
  btnConfigureClaudeCode: $<HTMLButtonElement>('btn-configure-claude-code'),
  btnConfigureCursor: $<HTMLButtonElement>('btn-configure-cursor'),
  claudeModal: $<HTMLDivElement>('claude-modal'),
  claudeModalTitle: $<HTMLHeadingElement>('claude-modal-title'),
  claudeModalSubtitle: $<HTMLParagraphElement>('claude-modal-subtitle'),
  claudeModalApplyHint: $<HTMLParagraphElement>('claude-modal-apply-hint'),
  claudeBody: $<HTMLDivElement>('claude-body'),
  claudePreview: $<HTMLDivElement>('claude-preview'),
  claudeFooterNote: $<HTMLSpanElement>('claude-footer-note'),
  btnClaudeClose: $<HTMLButtonElement>('btn-claude-close'),
  btnClaudeApply: $<HTMLButtonElement>('btn-claude-apply'),
  settingsModal: $<HTMLDivElement>('settings-modal'),
  cacheCap: $<HTMLSelectElement>('cache-cap'),
  aiDefaultMemory: $<HTMLInputElement>('ai-default-memory'),
  aiAutoReingest: $<HTMLInputElement>('ai-auto-reingest'),
  aiReingestQuietMs: $<HTMLSelectElement>('ai-reingest-quiet-ms'),
  aiChunkSize: $<HTMLSelectElement>('ai-chunk-size'),
  aiEmbedBatch: $<HTMLSelectElement>('ai-embed-batch'),
  reingestDelayRow: $<HTMLDivElement>('reingest-delay-row'),
  btnSettingsCancel: $<HTMLButtonElement>('btn-settings-cancel'),
  btnSettingsSave: $<HTMLButtonElement>('btn-settings-save'),
  settingsFooterNote: $<HTMLSpanElement>('settings-footer-note'),
  // Guided tour
  tourOverlay: $<HTMLDivElement>('tour-overlay'),
  tourStepIndicator: $<HTMLDivElement>('tour-step-indicator'),
  tourTitle: $<HTMLHeadingElement>('tour-title'),
  tourBody: $<HTMLParagraphElement>('tour-body'),
  tourConnectArea: $<HTMLDivElement>('tour-connect-area'),
  tourSkip: $<HTMLButtonElement>('tour-skip'),
  tourPrev: $<HTMLButtonElement>('tour-prev'),
  tourNext: $<HTMLButtonElement>('tour-next'),
  railGetConnected: $<HTMLDivElement>('rail-get-connected'),
  railGcClients: $<HTMLDivElement>('rail-gc-clients'),
  railGcMobile: $<HTMLDivElement>('rail-gc-mobile'),
  railGcConnectors: $<HTMLDivElement>('rail-gc-connectors'),
  // Brain / Alive — status bar
  brainVitality: $<HTMLSpanElement>('brain-vitality'),
  llmStatusChip: $<HTMLSpanElement>('llm-status-chip'),
  // Living Brain pane
  lbVitalityRing: $<HTMLDivElement>('lb-vitality-ring'),
  lbVitalityScore: $<HTMLSpanElement>('lb-vitality-score'),
  lbVitalityTitle: $<HTMLHeadingElement>('lb-vitality-title'),
  lbVitalityDetail: $<HTMLParagraphElement>('lb-vitality-detail'),
  btnLbRefresh: $<HTMLButtonElement>('btn-lb-refresh'),
  lbContradictions: $<HTMLDivElement>('lb-contradictions'),
  lbInsights: $<HTMLDivElement>('lb-insights'),
  lbGoals: $<HTMLDivElement>('lb-goals'),
  lbFeed: $<HTMLDivElement>('lb-feed'),
  lbGoalForm: $<HTMLDivElement>('lb-goal-form'),
  lbGoalContext: $<HTMLInputElement>('lb-goal-context'),
  lbGoalStrategy: $<HTMLInputElement>('lb-goal-strategy'),
  lbGoalGoals: $<HTMLInputElement>('lb-goal-goals'),
  btnLbGoalCancel: $<HTMLButtonElement>('btn-lb-goal-cancel'),
  btnLbGoalDevelop: $<HTMLButtonElement>('btn-lb-goal-develop'),
  btnNewGoal: $<HTMLButtonElement>('btn-new-goal'),
  // Ollama settings
  ollamaStatusBadge: $<HTMLSpanElement>('ollama-status-badge'),
  ollamaModelRow: $<HTMLDivElement>('ollama-model-row'),
  ollamaModelSelect: $<HTMLSelectElement>('ollama-model-select'),
  btnOllamaApplyModel: $<HTMLButtonElement>('btn-ollama-apply-model'),
  ollamaPullRow: $<HTMLDivElement>('ollama-pull-row'),
  ollamaPullSelect: $<HTMLSelectElement>('ollama-pull-select'),
  btnOllamaPull: $<HTMLButtonElement>('btn-ollama-pull'),
  ollamaPullProgress: $<HTMLDivElement>('ollama-pull-progress'),
  ollamaPullBar: $<HTMLDivElement>('ollama-pull-bar'),
  ollamaPullLabel: $<HTMLSpanElement>('ollama-pull-label'),
  ollamaNotInstalled: $<HTMLDivElement>('ollama-not-installed'),
  btnOpenOllamaSite: $<HTMLAnchorElement>('btn-open-ollama-site'),
};

// Current plan in the modal — kept in module scope so the Apply button can
// figure out which checkboxes are still checked at click time.
let currentRecoveryPlan: RecoveryPlan | null = null;

// Brain engine state — refreshed by refreshBrainState()
let brainVitalityReport: { overall: number; byGraph: Record<string, number>; computedAt: number } | null = null;
let brainInsights: Array<{ id: string; graphId: string; kind: string; title: string; body: string; relevantNodeIds: string[]; createdAt: number; dismissed?: boolean }> = [];
let brainContradictions: Array<{ id: string; graphId: string; nodeA: string; nodeB: string; snippetA: string; snippetB: string; similarity: number; detectedAt: number }> = [];

// MCP status poller handle. Started after unlock, cleared on lock.
let mcpPollTimer: ReturnType<typeof setInterval> | null = null;

// Latest inspector stats payload. Cached so the Graphnosis dashboard can
// render the active engram's forgotten-on-disk count without re-firing
// the IPC on every recap update. Updated by refreshStats().
let lastInspectorStats: StatsSummary | null = null;
let sourcesFilterTerm = '';

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
const liveToastTimers = new Map<string, ReturnType<typeof setInterval>>();

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
    <div class="g-toast-progress"><div class="g-toast-progress-fill"></div></div>
    <span class="g-toast-elapsed">0:00 elapsed</span>
  `;
  const labelEl = root.querySelector('.g-toast-label') as HTMLSpanElement;
  const msgEl = root.querySelector('.g-toast-msg') as HTMLSpanElement;
  const elapsedEl = root.querySelector('.g-toast-elapsed') as HTMLSpanElement;
  const closeBtn = root.querySelector('.g-toast-close') as HTMLButtonElement;
  labelEl.textContent = label;
  msgEl.textContent = message ?? '';
  closeBtn.addEventListener('click', () => removeIngestToast(id));
  els.toastStack.appendChild(root);
  requestAnimationFrame(() => root.classList.add('visible'));
  liveToasts.set(id, root);
  // Tick elapsed time every second.
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    elapsedEl.textContent = `${m}:${String(s).padStart(2, '0')} elapsed`;
  }, 1000);
  liveToastTimers.set(id, timer);
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
  }
}

function finishIngestToast(id: string, kind: 'success' | 'error', message?: string): void {
  const root = liveToasts.get(id);
  if (!root) return;
  // Stop elapsed timer — CSS hides the progress bar + elapsed span.
  const timer = liveToastTimers.get(id);
  if (timer !== undefined) { clearInterval(timer); liveToastTimers.delete(id); }
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
  const timer = liveToastTimers.get(id);
  if (timer !== undefined) { clearInterval(timer); liveToastTimers.delete(id); }
  root.classList.remove('visible');
  // Match the CSS transition (140ms) before yanking from DOM.
  window.setTimeout(() => root.remove(), 180);
  liveToasts.delete(id);
}

// ── Native macOS notification helpers ──────────────────────────────────────
// We request permission lazily on first send (less intrusive than asking at
// startup) and cache the result for the rest of the session.
let _notifPermission: boolean | null = null;

async function ensureNotifPermission(): Promise<boolean> {
  if (_notifPermission !== null) return _notifPermission;
  try {
    _notifPermission = await isPermissionGranted();
    if (!_notifPermission) {
      const result = await requestPermission();
      _notifPermission = result === 'granted';
    }
  } catch {
    _notifPermission = false;
  }
  return _notifPermission;
}

/** Is the app currently in the background (menu-bar collapsed, window not
 *  focused, or hidden behind other windows)? Used to gate "the AI needs
 *  you" notifications — we don't want to nag the user when they're already
 *  looking at the App and would see the banner anyway.
 *
 *  We ask Tauri's window API instead of DOM hasFocus / visibilityState
 *  because a menu-bar NSPanel doesn't reliably toggle DOM signals when the
 *  user collapses it — the WebView stays "focused" from the DOM's POV
 *  even when the panel is hidden behind the menu-bar icon. The Tauri
 *  window API reports the real OS-level visibility + focus state. */
async function isAppBackgrounded(): Promise<boolean> {
  try {
    const w = getCurrentWindow();
    const [visible, focused] = await Promise.all([w.isVisible(), w.isFocused()]);
    if (!visible) return true;   // panel collapsed / window hidden
    if (!focused) return true;   // another app on top
    return false;
  } catch {
    // Fall back to DOM signals if the Tauri API isn't available for any
    // reason (e.g., webview booted outside the Tauri shell during dev).
    if (document.visibilityState === 'hidden') return true;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return true;
    return false;
  }
}

/**
 * Fire a system notification only when the app is in the background.
 * Used for AI-driven confirmations (engram-create-suggested,
 * correction.proposed) so the user gets a poke when they're elsewhere
 * but isn't double-notified when they're already looking at the banner.
 */
async function notifyIfBackground(opts: { title: string; body: string }): Promise<void> {
  if (!(await isAppBackgrounded())) return;
  if (!(await ensureNotifPermission())) {
    // Surface this in the dev terminal so it's obvious why a missed
    // notification didn't actually fire — silent failures here were the
    // hardest part of debugging the background-confirmation flow.
    console.warn('[notify] background notification skipped — OS permission not granted');
    return;
  }
  try {
    sendNotification({ title: opts.title, body: opts.body });
  } catch (e) {
    console.warn('[notify] sendNotification failed:', e);
  }
}

async function notifyIngestDone(fileName: string, nodesAdded: number, error?: string): Promise<void> {
  if (!(await ensureNotifPermission())) return;
  try {
    if (error) {
      sendNotification({ title: 'Graphnosis — Ingest failed', body: `${fileName}: ${error}` });
    } else {
      const mem = nodesAdded === 1 ? '1 memory' : `${nodesAdded.toLocaleString()} memories`;
      sendNotification({
        title: 'Graphnosis',
        body: nodesAdded > 0 ? `"${fileName}" ingested — ${mem} added.` : `"${fileName}" ingested.`,
      });
    }
  } catch {
    // Notification API unavailable — silently ignore.
  }
}

// Map jobId → { toastId, fileName } so progress/done events can find the right toast.
// Also tracks fileName so the notification body can name the file.
interface IngestJob { toastId: string; fileName: string; }
const ingestJobToasts = new Map<string, IngestJob>();

// Escape-hatch: if the events socket was interrupted and the done event was
// missed, pending toasts would stick forever. After MAX_PENDING_MS with no
// progress tick we auto-dismiss with a neutral "check Sources" message.
const MAX_PENDING_MS = 8 * 60 * 1000; // 8 minutes

/**
 * Run a single-file ingest with a toast. The sidecar now processes the
 * file in the background and returns { accepted, jobId } immediately —
 * no timeout possible. Progress and completion arrive via the events
 * socket as `graphnosis://ingest-progress` and `graphnosis://ingest-done`
 * Tauri events, which update the toast live.
 */
async function ingestSingleFile(path: string): Promise<unknown> {
  const fileName = path.split('/').pop() ?? path;
  const toastId = addIngestToast(`Ingesting ${fileName}…`);
  // Escape-hatch timer: if the done event is missed (e.g. events socket
  // disconnected mid-ingest), auto-dismiss the toast after MAX_PENDING_MS.
  const escapeTimer = window.setTimeout(() => {
    const job = [...ingestJobToasts.entries()].find(([, j]) => j.toastId === toastId);
    if (job) {
      ingestJobToasts.delete(job[0]);
      finishIngestToast(toastId, 'success', 'Completed — check Sources for details');
      void pushDataIntoAtlas();
      void refreshStats();
    }
  }, MAX_PENDING_MS);
  try {
    const result = (await invoke('ingest_file', { graphId: atlasActiveGraph || null, path })) as {
      accepted?: boolean;
      jobId?: string;
    };
    if (result?.jobId) {
      ingestJobToasts.set(result.jobId, { toastId, fileName });
    } else {
      // Sidecar didn't return a jobId — cancel the escape-hatch timer.
      window.clearTimeout(escapeTimer);
    }
    return result;
  } catch (e) {
    window.clearTimeout(escapeTimer);
    finishIngestToast(toastId, 'error', String(e));
    throw e;
  }
}

// Listen for progress events — update the toast's message with live node count.
void listen<{ jobId: string; graphId: string; fileName: string; phase: string; nodesAdded: number; pagesProcessed?: number; totalPages?: number; pagesExtracted?: number }>(
  'graphnosis://ingest-progress',
  (evt) => {
    const job = ingestJobToasts.get(evt.payload.jobId);
    if (!job) return;
    const { toastId } = job;
    const { phase, nodesAdded, pagesProcessed, totalPages, pagesExtracted, chunksDone, chunksTotal } = evt.payload;
    let message: string;
    if (phase === 'parsing' && pagesProcessed != null && totalPages != null) {
      message = `Parsing page ${pagesProcessed} of ${totalPages}…`;
    } else if (phase === 'parsing') {
      message = nodesAdded > 0 ? `Parsing… ${nodesAdded} node${nodesAdded === 1 ? '' : 's'} so far` : 'Parsing…';
    } else if (phase === 'embedding') {
      if (chunksDone != null && chunksTotal != null && chunksTotal > 1) {
        // Chunked PDF embedding — show section progress so the user knows
        // it's still working on a large document.
        const nodeNote = nodesAdded > 0 ? ` · ${nodesAdded} node${nodesAdded === 1 ? '' : 's'}` : '';
        message = `Creating memories… section ${chunksDone} of ${chunksTotal}${nodeNote}`;
      } else {
        message = pagesExtracted != null
          ? `Creating memories from ${pagesExtracted} page${pagesExtracted === 1 ? '' : 's'}…`
          : 'Creating memories…';
      }
    } else {
      message = nodesAdded > 0 ? `Saving… ${nodesAdded} node${nodesAdded === 1 ? '' : 's'} so far` : 'Saving…';
    }
    updateIngestToast(toastId, { message });
  },
);

// Listen for done events — resolve the toast and fire a native notification.
void listen<{ jobId: string; graphId: string; fileName: string; nodesAdded: number; nodeIds?: string[]; error?: string }>(
  'graphnosis://ingest-done',
  (evt) => {
    const job = ingestJobToasts.get(evt.payload.jobId);
    if (!job) return;
    const { toastId, fileName } = job;
    ingestJobToasts.delete(evt.payload.jobId);
    if (evt.payload.error) {
      finishIngestToast(toastId, 'error', evt.payload.error);
      void notifyIngestDone(fileName, 0, evt.payload.error);
    } else {
      const n = evt.payload.nodesAdded;
      finishIngestToast(toastId, 'success', n > 0 ? `Saved ${n} node${n === 1 ? '' : 's'}` : 'Saved');
      void notifyIngestDone(fileName, n);
      // Auto-jump to the 3D Engram view when the LAST ingest in a batch
      // completes successfully — the user just added memories, they almost
      // certainly want to see the new shape of the graph. Guards:
      //   - n > 0: don't switch on a no-op ingest (dedup, empty file)
      //   - ingestJobToasts.size === 0: don't switch mid-batch; wait for
      //     the final file in a multi-file drop. (We already .delete()'d
      //     this job id above, so size === 0 means no more in flight.)
      if (n > 0 && ingestJobToasts.size === 0) {
        // Side rail → Graphnosis (atlas mode-pane). The 3D Engram inner
        // tab lives inside that pane.
        if (currentMode !== 'atlas') activateMode('atlas');
        // Inner tab → 3D Engram. switchGraphnosisTab handles the mount,
        // pushDataIntoAtlas, and zoomToFit; no node gets auto-selected.
        switchGraphnosisTab('atlas');
      }
    }
    // Trigger the atlas/sources refresh now that the graph has new data.
    // (Still runs even when we don't jump — keeps Check-in / Sources fresh.)
    void pushDataIntoAtlas();
    void refreshStats();
    // Re-fit the camera after the last job in a batch so the new nodes are
    // in view. Use a longer delay than the tab-switch fit (1.2s) — large
    // graphs take a few seconds for the force layout to stabilise.
    if (ingestJobToasts.size === 0 && mainAtlas && graphnosisActiveTab === 'atlas') {
      setTimeout(() => mainAtlas?.zoomToFit(700, 20), 4000);
    }
  },
);

/**
 * Status snapshot deferred while the one-time recovery phrase modal is on
 * screen. We want the recovery phrase to be a gate on the lock screen, not
 * a popup that lands on top of the dashboard, so the unlock → app transition
 * is paused until the user acknowledges and dismisses the modal.
 *
 * Set by `render()` when called with `unlocked: true` while the modal is
 * visible. Applied (and cleared) by the modal's close button. Survives across
 * any number of intervening render() calls — only the most recent unlocked
 * snapshot is kept.
 */
let queuedStatusAfterRecovery: StatusSnapshot | null = null;

function render(status: StatusSnapshot): void {
  // Gate the unlock transition on the recovery-phrase modal being dismissed.
  // The modal is shown by `graphnosis://cortex-created` (fired before the
  // status event from the Rust unlock command), so by the time we get here
  // with `unlocked: true`, the modal is already visible. Defer instead of
  // transitioning underneath it.
  if (status.unlocked) {
    const recoveryModal = document.getElementById('recovery-phrase-modal');
    if (recoveryModal && !recoveryModal.classList.contains('hidden')) {
      queuedStatusAfterRecovery = status;
      return;
    }
  }

  if (status.unlocked) {
    els.viewUnlock.classList.add('hidden');
    els.viewApp.classList.remove('hidden');
    els.cortexLabel.textContent = shortCortexLabel(status.cortex_dir ?? 'cortex');
    refreshActiveEngramLabel();
    void refreshStats();
    void syncForgetMode();
    void fetchGraphsMetadata();
    void refreshConnectorsList();
    startMcpPolling();
    void refreshBrainState();
    void refreshLlmStatus();
    activateMode(currentMode);
  } else {
    els.viewApp.classList.add('hidden');
    els.viewUnlock.classList.remove('hidden');
    stopMcpPolling();
    // Clear ephemeral disable state on lock so a re-unlock starts fresh.
    disabledSources.clear();
    // Hide every modal that might be left visible from the previous unlocked
    // session — Vite HMR preserves DOM, so a modal open at the moment of a
    // lock can persist into the next render.
    document.querySelectorAll<HTMLElement>('.modal-backdrop').forEach((m) => {
      m.classList.add('hidden');
      m.classList.remove('over-sidebar');
      const inner = m.querySelector<HTMLElement>('.modal');
      if (inner) {
        inner.style.position = '';
        inner.style.top = '';
        inner.style.left = '';
        inner.style.width = '';
        inner.style.height = '';
      }
    });
    // Whenever we land on the lock screen, re-probe biometric availability
    // for whatever cortex path is currently in the input. Covers cases
    // where the initial prefill skipped (no localStorage entry) but the
    // user has since unlocked once (passphrase stored in keychain) and
    // is now seeing the lock screen again.
    const currentPath = els.cortexDir.value.trim();
    if (currentPath) void refreshBiometricButton(currentPath);
  }
}

/**
 * Update the "on engram <name>" label in the app header. Single chokepoint
 * for the active-engram display so we don't drift between places that
 * mutate `atlasActiveGraph`. Called from `render()` on unlock and from
 * the picker change handler. Reads the friendly display name from the
 * loaded-graphs metadata, falling back to the raw graphId.
 */
function refreshActiveEngramLabel(): void {
  if (!els.activeEngramLabel) return;
  const id = atlasActiveGraph;
  if (!id) {
    els.activeEngramLabel.textContent = '—';
    return;
  }
  const meta = loadedGraphs.find((g) => g.graphId === id);
  els.activeEngramLabel.textContent = meta?.metadata.displayName ?? id;
}

/** Rebuild the topbar engram <select> options from loadedGraphs (sorted A-Z).
 *  Called whenever loadedGraphs changes so the picker is always up-to-date
 *  regardless of which pane is active. */
function syncEngramPicker(): void {
  const visibleGraphs = loadedGraphs
    .filter((g) => !g.metadata.archived)
    .sort((a, b) => (a.metadata.displayName ?? a.graphId).localeCompare(b.metadata.displayName ?? b.graphId));
  els.atlasGraphPicker.innerHTML = visibleGraphs
    .map((g) => `<option value="${escape(g.graphId)}">${escape(g.metadata.displayName ?? g.graphId)}</option>`)
    .join('');
  if (!atlasActiveGraph || !visibleGraphs.some((g) => g.graphId === atlasActiveGraph)) {
    atlasActiveGraph = pickAtlasGraph();
  }
  if (atlasActiveGraph) els.atlasGraphPicker.value = atlasActiveGraph;
  refreshActiveEngramLabel();
}

/** Render the "Get connected" shortcut buttons in the left sidebar. */
function renderRailGetConnected(): void {
  if (!els.railGcClients) return;

  const makeBtn = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rail-shortcut-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  els.railGcClients.innerHTML = '';
  els.railGcClients.appendChild(makeBtn('Claude Desktop', () => openConfigureClientModal('claude-desktop')));
  els.railGcClients.appendChild(makeBtn('Claude Code', () => openConfigureClientModal('claude-code')));
  els.railGcClients.appendChild(makeBtn('Cursor', () => openConfigureClientModal('cursor')));

  els.railGcMobile.innerHTML = '';
  els.railGcMobile.appendChild(makeBtn('📱 Mobile access', () => void openMobileWizard()));

  els.railGcConnectors.innerHTML = '';
  const connectorShortcuts: Array<[ConnectorKind, string]> = [
    ['rss','RSS'],['github','GitHub'],['slack','Slack'],['trello','Trello'],
    ['linear','Linear'],['obsidian','Obsidian'],['gbrain','GBrain'],['ai-context','AI Context Files'],
  ];
  for (const [kind, label] of connectorShortcuts) {
    els.railGcConnectors.appendChild(makeBtn(label, () => openConnectorSetupModal(kind)));
  }
}

function shortCortexLabel(p: string): string {
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
  if (mode === 'settings') {
    // Engrams management, recovery phrase, quarantine cleanup — see
    // renderSettingsTab(). Re-rendering on each activation keeps the
    // panels in sync with whatever happened elsewhere (recovery from
    // op-log, new ingest, startup-time quarantine, etc.).
    renderSettingsTab();
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
    // Cortex was locked or sidecar gone — show a quiet idle state rather than
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
    // Cortex locked / sidecar gone — clear pending state silently.
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
    // Locked cortex / sidecar gone — silent. Other polls will surface the error.
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
      // Group sources by engram, preserving the order engrams appear in
      // loadedGraphs (active first, then archived). Within each group sort
      // newest-first by ingestedAt.
      const groupOrder = loadedGraphs.map((g) => g.graphId);
      const byEngram = new Map<string, SourceRecord[]>();
      for (const s of data.sources) {
        if (!byEngram.has(s.graphId)) byEngram.set(s.graphId, []);
        byEngram.get(s.graphId)!.push(s);
      }
      // Sort each group's sources newest-first.
      for (const group of byEngram.values()) {
        group.sort((a, b) => b.ingestedAt - a.ingestedAt);
      }
      // Order groups by the engram order from loadedGraphs; unknowns at end.
      const orderedGroupIds = [
        ...groupOrder.filter((id) => byEngram.has(id)),
        ...[...byEngram.keys()].filter((id) => !groupOrder.includes(id)),
      ];

      const renderSourceRow = (s: SourceRecord): string => {
        // Reingest is only meaningful for file-backed sources: the
        // SDK can re-read the disk path. URLs would need a fresh
        // network fetch (separate concern), clips have no canonical
        // file, ai-conversation has no source-of-truth file at all.
        const reingestBtn = s.kind === 'file'
          ? `<button class="btn-reingest" data-graph-id="${escape(s.graphId)}" data-source-id="${escape(s.sourceId)}" data-ref="${escape(s.ref)}" title="Re-read this file from disk and replace the existing nodes">Reingest</button>`
          : '';
        const finderBtn = s.kind === 'file'
          ? `<button class="btn-show-finder" data-ref="${escape(s.ref)}" title="Reveal this file in Finder">Show in Finder</button>`
          : '';
        // Disable/Enable toggle hidden pending a redesign — see the
        // "source disable / session filtering for power users" TODO in
        // the Coding engram. The current implementation was client-only
        // (no persistence, no sidecar filter for check-in / 3D / stats /
        // recall) and gave the false impression that disabled sources
        // were excluded everywhere. Until we land a real design (demo
        // mode, per-recall exclusion, or tag-based filters), the button
        // is omitted from the row. Forget remains for permanent removal.
        // "via Claude" attribution badge for sources added through an MCP
        // client (remember/correct tools). User-added sources (drag-drop,
        // paste, file picker) have no `addedBy` and get no badge.
        const addedByBadge = s.addedBy
          ? `<span class="source-added-by" title="Added by ${escape(s.addedBy)} via MCP">via ${escape(s.addedBy)}</span>`
          : '';
        // Move-to button: only show when there are other non-archived engrams.
        const moveTargets = loadedGraphs.filter((g) => g.graphId !== s.graphId && !g.metadata.archived);
        const moveBtn = moveTargets.length > 0
          ? `<button class="btn-move-source" data-graph-id="${escape(s.graphId)}" data-source-id="${escape(s.sourceId)}" title="Move this source to another engram">Move to…</button>`
          : '';
        return `
          <div class="source-row" data-source-id="${escape(s.sourceId)}">
            <span class="source-name" title="${escape(s.ref)}">${escape(s.kind === 'file' ? (s.ref.split('/').pop() ?? s.ref) : formatLegendLabel(s.ref))}</span>
            <span class="source-meta">${s.nodeIds.length} node${s.nodeIds.length === 1 ? '' : 's'}</span>
            ${addedByBadge}
            ${finderBtn}
            ${reingestBtn}
            ${moveBtn}
            <button class="btn-forget" data-graph-id="${escape(s.graphId)}" data-source-id="${escape(s.sourceId)}" data-node-count="${s.nodeIds.length}" data-ref="${escape(s.ref)}">Forget</button>
          </div>`;
      };

      els.sourcesList.innerHTML = orderedGroupIds.map((graphId) => {
        const displayName = loadedGraphs.find((g) => g.graphId === graphId)?.metadata.displayName ?? graphId;
        const sources = byEngram.get(graphId)!;
        return `
          <div class="sources-engram-group">
            <div class="sources-engram-heading">${escape(displayName)}</div>
            ${sources.map(renderSourceRow).join('')}
          </div>`;
      }).join('');
      // Disable/Enable toggle — hides/shows this source's nodes in the
      // Atlas without permanently forgetting them. State survives graph
      // data reloads (pushDataIntoAtlas re-applies it); resets on lock.
      els.sourcesList.querySelectorAll<HTMLButtonElement>('.btn-source-disable, .btn-source-enable').forEach((btn) => {
        btn.addEventListener('click', () => {
          const sourceId = btn.dataset.sourceId ?? '';
          const ref = btn.dataset.ref ?? '';
          if (!sourceId) return;
          const nowDisabled = !disabledSources.has(sourceId);
          if (nowDisabled) {
            disabledSources.set(sourceId, ref);
          } else {
            disabledSources.delete(sourceId);
          }
          mainAtlas?.setSourceVisible(ref, !nowDisabled);
          // Update button and row in place — no full re-render needed.
          const row = els.sourcesList.querySelector<HTMLDivElement>(`[data-source-id="${CSS.escape(sourceId)}"]`);
          if (row) {
            row.classList.toggle('source-row-disabled', nowDisabled);
            btn.textContent = nowDisabled ? 'Enable' : 'Disable';
            btn.className = nowDisabled ? 'btn-source-enable' : 'btn-source-disable';
          }
        });
      });
      // Wire each Forget button — two-step inline confirmation flow.
      // First click expands an input; the source is only forgotten once the
      // user types "forget" and clicks the enabled confirm button.
      // Pressing Escape or clicking outside collapses back without any action.
      els.sourcesList.querySelectorAll<HTMLButtonElement>('.btn-forget').forEach((btn) => {
        btn.addEventListener('click', () => {
          const graphId = btn.dataset.graphId ?? '';
          const sourceId = btn.dataset.sourceId ?? '';
          const ref = btn.dataset.ref ?? sourceId;
          if (!graphId || !sourceId) return;

          // If this row already has a confirm widget open, do nothing (guard
          // against double-clicks while the widget is animating into view).
          const row = btn.closest<HTMLDivElement>('.source-row');
          if (!row || row.querySelector('.source-row-forget-confirm')) return;

          // --- Build the inline confirm widget ---
          const widget = document.createElement('div');
          widget.className = 'source-row-forget-confirm';
          widget.innerHTML =
            `<input type="text" class="source-row-forget-input" placeholder='type "forget" to confirm' autocomplete="off" spellcheck="false" />` +
            `<button class="source-row-forget-go" disabled>Forget</button>`;

          const input = widget.querySelector<HTMLInputElement>('.source-row-forget-input')!;
          const goBtn = widget.querySelector<HTMLButtonElement>('.source-row-forget-go')!;

          // Hide the original Forget button and insert the widget after it.
          btn.style.display = 'none';
          btn.insertAdjacentElement('afterend', widget);
          input.focus();

          // Enable/disable the confirm button as the user types.
          input.addEventListener('input', () => {
            goBtn.disabled = input.value.trim().toLowerCase() !== 'forget';
          });

          // Collapse helper — removes widget, restores button, no action.
          const collapse = (): void => {
            widget.remove();
            btn.style.display = '';
          };

          // Escape collapses; Enter confirms if enabled.
          input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); collapse(); }
            if (e.key === 'Enter' && !goBtn.disabled) { e.preventDefault(); goBtn.click(); }
          });

          // Clicking outside the widget collapses it. Use a mousedown listener
          // on the document so we catch clicks on the confirm button too (the
          // click on goBtn fires before blur, so we handle that case inline).
          const onDocMousedown = (e: MouseEvent): void => {
            if (!widget.contains(e.target as Node)) {
              collapse();
              document.removeEventListener('mousedown', onDocMousedown, true);
            }
          };
          document.addEventListener('mousedown', onDocMousedown, true);

          // Confirm: perform the actual forget.
          goBtn.addEventListener('click', async () => {
            document.removeEventListener('mousedown', onDocMousedown, true);
            widget.remove();
            btn.style.display = '';
            btn.disabled = true;
            btn.textContent = 'Forgetting…';
            try {
              await invoke('forget_source', { graphId, sourceId });
              // Remove the row in place — no full re-render so scroll position is preserved.
              const row = els.sourcesList.querySelector<HTMLDivElement>(`[data-source-id="${CSS.escape(sourceId)}"]`);
              row?.remove();
            } catch (e) {
              showError(`Forget failed: ${e}`);
              btn.disabled = false;
              btn.textContent = 'Forget';
            }
          });
        });
      });
      // Reingest button: forget + re-read the file from disk. Surface
      // progress via the same toast plumbing the drag-drop path uses, so
      // long PDF re-parses don't look like a frozen UI.
      els.sourcesList.querySelectorAll<HTMLButtonElement>('.btn-reingest').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const graphId = btn.dataset.graphId ?? '';
          const sourceId = btn.dataset.sourceId ?? '';
          const ref = btn.dataset.ref ?? sourceId;
          if (!graphId || !sourceId) return;
          const fileName = ref.split('/').pop() ?? ref;
          btn.disabled = true;
          btn.textContent = 'Reingesting…';
          const toastId = addIngestToast(`Reingesting ${fileName}…`);
          try {
            const result = (await invoke('reingest_source', { graphId, sourceId })) as {
              nodeIds?: string[];
            };
            const n = result?.nodeIds?.length ?? 0;
            finishIngestToast(toastId, 'success', n > 0 ? `Re-saved ${n} node${n === 1 ? '' : 's'}` : 'Reingested');
            await refreshStats();
          } catch (e) {
            finishIngestToast(toastId, 'error', String(e));
            showError(`Reingest failed: ${e}`);
            btn.disabled = false;
            btn.textContent = 'Reingest';
          }
        });
      });
      // Move-to: inline engram picker that replaces the button row temporarily.
      els.sourcesList.querySelectorAll<HTMLButtonElement>('.btn-move-source').forEach((btn) => {
        btn.addEventListener('click', () => {
          const fromGraphId = btn.dataset.graphId ?? '';
          const sourceId = btn.dataset.sourceId ?? '';
          if (!fromGraphId || !sourceId) return;

          const row = btn.closest<HTMLDivElement>('.source-row');
          if (!row || row.querySelector('.source-row-move-picker')) return;

          const targets = loadedGraphs.filter((g) => g.graphId !== fromGraphId && !g.metadata.archived);

          const picker = document.createElement('div');
          picker.className = 'source-row-move-picker';
          picker.innerHTML =
            `<span class="source-row-move-label">Move to:</span>` +
            `<select class="source-row-move-select">` +
            `<option value="__new__">New Engram…</option>` +
            [...targets].sort((a, b) => (a.metadata.displayName ?? a.graphId).localeCompare(b.metadata.displayName ?? b.graphId)).map((g) =>
              `<option value="${escape(g.graphId)}">${escape(g.metadata.displayName || g.graphId)}</option>`
            ).join('') +
            `</select>` +
            `<input type="text" class="source-row-move-name-input" placeholder="New engram name…" style="display:none" />` +
            `<button class="source-row-move-go">Move</button>` +
            `<button class="source-row-move-cancel">Cancel</button>`;

          const select    = picker.querySelector<HTMLSelectElement>('.source-row-move-select')!;
          const nameInput = picker.querySelector<HTMLInputElement>('.source-row-move-name-input')!;
          const goBtn     = picker.querySelector<HTMLButtonElement>('.source-row-move-go')!;
          const cancelBtn = picker.querySelector<HTMLButtonElement>('.source-row-move-cancel')!;

          select.addEventListener('change', () => {
            nameInput.style.display = select.value === '__new__' ? '' : 'none';
          });

          btn.style.display = 'none';
          row.appendChild(picker);

          cancelBtn.addEventListener('click', () => {
            picker.remove();
            btn.style.display = '';
          });

          goBtn.addEventListener('click', async () => {
            let toGraphId = select.value;
            let toName = targets.find((g) => g.graphId === toGraphId)?.metadata.displayName ?? toGraphId;

            if (toGraphId === '__new__') {
              const displayName = nameInput.value.trim();
              if (!displayName) { nameInput.focus(); return; }
              // Slug: lowercase, spaces→dash, strip non-alphanumeric except -_
              const slug = displayName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
              const suffix = Math.random().toString(36).slice(-4);
              toGraphId = `${slug || 'engram'}-${suffix}`;
              toName = displayName;
              try {
                await invoke('create_graph_with_template', { graphId: toGraphId, template: 'personal', displayName });
                loadedGraphs = (await invoke('list_graphs_with_metadata')) as typeof loadedGraphs;
                syncEngramPicker();
              } catch (e) {
                showError(`Could not create engram "${displayName}": ${e}`);
                return;
              }
            }

            picker.remove();
            btn.disabled = true;
            btn.style.display = '';
            btn.textContent = 'Moving…';
            try {
              await invoke('move_source', { fromGraphId, sourceId, toGraphId });
              const canvas = document.querySelector<HTMLElement>('.app-canvas');
              const savedScroll = canvas?.scrollTop ?? 0;
              await refreshStats();
              if (canvas) canvas.scrollTop = savedScroll;
            } catch (e) {
              showError(`Move to "${toName}" failed: ${e}`);
              btn.disabled = false;
              btn.textContent = 'Move to…';
            }
          });
        });
      });

      // Show in Finder — reveals the file (selects it) in macOS Finder.
      els.sourcesList.querySelectorAll<HTMLButtonElement>('.btn-show-finder').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const ref = btn.dataset.ref ?? '';
          if (!ref) return;
          try {
            await invoke('reveal_file_in_finder', { path: ref });
          } catch (e) {
            showError(`Could not reveal file: ${e}`);
          }
        });
      });
    }
  } catch (e) {
    els.sourcesList.innerHTML = `<p class="error">${escape(String(e))}</p>`;
  }
  applySourcesFilter();
}

function applySourcesFilter(): void {
  const term = sourcesFilterTerm.toLowerCase();
  els.sourcesList.querySelectorAll<HTMLElement>('[data-source-id]').forEach((row) => {
    const ref = (row.dataset.ref ?? '').toLowerCase();
    const name = (row.querySelector('.source-name')?.textContent ?? '').toLowerCase();
    row.style.display = (!term || ref.includes(term) || name.includes(term)) ? '' : 'none';
  });
  // Hide engram group headings when none of their source rows match
  els.sourcesList.querySelectorAll<HTMLElement>('.sources-engram-group').forEach((group) => {
    const hasVisible = !term || Array.from(group.querySelectorAll<HTMLElement>('[data-source-id]'))
      .some((r) => r.style.display !== 'none');
    group.style.display = hasVisible ? '' : 'none';
  });
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

// ---- event wiring -------------------------------------------------------

els.sourcesFilter.addEventListener('input', () => {
  sourcesFilterTerm = els.sourcesFilter.value.trim();
  applySourcesFilter();
});

// Re-probe biometric availability whenever the cortex-folder input changes
// (typed, pasted, picked-via-dialog). Debounced because the input fires per
// keystroke. Without this, the Touch ID button stays stale if the user
// switches cortexes by typing rather than clicking Choose.
{
  let timer: number | null = null;
  els.cortexDir.addEventListener('input', () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void refreshBiometricButton(els.cortexDir.value.trim());
    }, 250);
  });
}

els.btnPick.addEventListener('click', async () => {
  showError(null);
  try {
    const folder = (await invoke('pick_cortex_folder')) as string | null;
    if (folder) {
      els.cortexDir.value = folder;
      els.passphrase.focus();
      void refreshBiometricButton(folder);
    }
  } catch (e) {
    showError(String(e));
  }
});

// Touch ID — both the "Touch ID" button (next to Unlock) and the inline
// fingerprint icon (inside the passphrase field's right edge) fire the
// same flow: spawn the Swift sidecar for biometric auth, read the cached
// passphrase, run the normal unlock.
async function runBiometricUnlock(): Promise<void> {
  if (!els.cortexDir.value.trim()) {
    showError('Choose a Graphnosis Cortex folder first.');
    return;
  }
  showError(null);
  const inlineBtn = document.getElementById('btn-touchid-inline') as HTMLButtonElement | null;
  if (inlineBtn) inlineBtn.disabled = true;
  els.btnUnlock.disabled = true;
  els.unlockStatus.textContent = 'Touch the sensor…';
  const progressBar = document.getElementById('unlock-progress');
  progressBar?.classList.remove('hidden');
  try {
    const status = await invoke<StatusSnapshot>('biometric_unlock', {
      cortexDir: els.cortexDir.value,
    });
    rememberCortexDir(els.cortexDir.value);
    els.passphrase.value = '';
    els.unlockStatus.textContent = '';
    render(status);
  } catch (e) {
    showError(String(e));
    els.unlockStatus.textContent = '';
  } finally {
    if (inlineBtn) inlineBtn.disabled = false;
    els.btnUnlock.disabled = false;
    progressBar?.classList.add('hidden');
  }
}

{
  const inlineBtn = document.getElementById('btn-touchid-inline') as HTMLButtonElement | null;
  inlineBtn?.addEventListener('click', () => void runBiometricUnlock());
}

els.btnUnlock.addEventListener('click', async () => {
  showError(null);
  // Client-side guards. Sidecar would also reject these, but failing fast in
  // the UI is friendlier than a 30s wait for the timeout error.
  if (!els.cortexDir.value.trim()) {
    showError('Choose a Graphnosis Cortex folder first.');
    return;
  }
  if (!els.passphrase.value) {
    showError('Enter your Cortex passphrase.');
    return;
  }
  await attemptUnlock();
});

/**
 * Run the unlock flow. Extracted from the click handler so we can re-call
 * it after the user confirms "create the missing folder" without rebuilding
 * the click handler's pre-flight checks.
 */
async function attemptUnlock(): Promise<void> {
  els.btnUnlock.disabled = true;
  els.unlockStatus.textContent = 'Starting synapse…';
  // Indeterminate progress bar — the unlock has several variable-duration
  // steps (Argon2id key derivation, sidecar spawn, embedding-worker init,
  // engram loads). We don't have meaningful percentages, but a moving bar
  // tells the user something IS happening so they don't second-guess the
  // click and try to mash the button again.
  const progressBar = document.getElementById('unlock-progress');
  progressBar?.classList.remove('hidden');
  try {
    const status = (await invoke('unlock_cortex', {
      args: { cortex_dir: els.cortexDir.value, passphrase: els.passphrase.value },
    })) as StatusSnapshot;
    // Persist for the next launch — see rememberCortexDir().
    rememberCortexDir(els.cortexDir.value);
    els.passphrase.value = '';
    els.unlockStatus.textContent = '';
    render(status);
  } catch (e) {
    const msg = String(e);
    // First-run friendly: if the cortex folder doesn't exist, don't dead-
    // end — offer to create it on the spot. The Rust error has the form
    // "Cortex folder does not exist: <path>"; we parse and confirm.
    const missingPrefix = 'Cortex folder does not exist:';
    const lacksPrefix = msg.indexOf(missingPrefix);
    if (lacksPrefix !== -1) {
      const path = msg.slice(lacksPrefix + missingPrefix.length).trim();
      els.unlockStatus.textContent = '';
      progressBar?.classList.add('hidden');
      els.btnUnlock.disabled = false;
      const proceed = confirm(
        `The folder "${path}" doesn't exist yet.\n\n` +
        `Create it now and continue unlocking?\n\n` +
        `(If this is a typo, click Cancel and edit the path.)`
      );
      if (!proceed) return;
      try {
        await invoke('create_cortex_dir', { path });
      } catch (createErr) {
        showError(`Couldn't create folder: ${String(createErr)}`);
        return;
      }
      // Retry unlock now that the folder exists. Re-enter attemptUnlock
      // (rather than recursing inline) so the progress bar + status state
      // cycle through cleanly.
      await attemptUnlock();
      return;
    }
    // All other startup errors (wrong passphrase, cortex corrupt, sidecar
    // missing, etc.) — surface as-is. The Rust side already classified it.
    showError(msg);
    els.unlockStatus.textContent = '';
  } finally {
    els.btnUnlock.disabled = false;
    progressBar?.classList.add('hidden');
  }
}

els.btnRefresh.addEventListener('click', () => void refreshStats());

els.btnOpenFolder.addEventListener('click', async () => {
  try {
    await invoke('open_cortex_in_finder');
  } catch (e) {
    showError(String(e));
  }
});

document.getElementById('btn-help')?.addEventListener('click', () => {
  void invoke('plugin:opener|open_url', { url: 'https://docs.graphnosis.com' });
});

els.btnLock.addEventListener('click', async () => {
  try {
    const status = (await invoke('lock_cortex')) as StatusSnapshot;
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
    `soft-deleted nodes. It can take a few minutes on large cortexes.\n\n` +
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

// ---- configure-AI-client flow ------------------------------------------
//
// One modal serves all three MCP-aware clients (Claude Desktop / Claude
// Code / Cursor). The selected client_id is stored on the modal's dataset
// when a Configure button is clicked, and the Apply handler reads it back
// so the same listener works for every client without per-client wiring.
//
// Adding a new client: register the Tauri side in `lib.rs`'s McpClient
// enum + `mcp_client_config_path`, then add another `data-mcp-client`
// button to the AI-client panel and a small per-client copy block below.

interface ClientUiCopy {
  /** Modal title shown above the subtitle when this client is being configured. */
  title: string;
  /** One-line description above the Apply button. */
  subtitle: string;
}

const MCP_CLIENT_COPY: Record<McpClientId, ClientUiCopy> = {
  'claude-desktop': {
    title: 'Configure Claude Desktop',
    subtitle: "Make Claude Desktop's Graphnosis tools talk to Graphnosis Synapse instead of spawning its own. Both share one in-memory graph and one cortex lock.",
  },
  'claude-code': {
    title: 'Configure Claude Code (CLI)',
    subtitle: "Make the `claude` CLI's Graphnosis tools talk to Graphnosis Synapse. Writes the user-level `~/.claude.json` so it applies in every project. Project-scoped `.mcp.json` files are left untouched.",
  },
  'cursor': {
    title: 'Configure Cursor',
    subtitle: "Make Cursor's Graphnosis MCP tools talk to Graphnosis Synapse. Writes the user-level `~/.cursor/mcp.json`; project-scoped MCP configs are unaffected.",
  },
};

function openConfigureClientModal(clientId: McpClientId): void {
  showError(null);
  const copy = MCP_CLIENT_COPY[clientId];
  els.claudeModal.dataset['mcpClient'] = clientId;
  // Clear any stale apply-done state from a previous configure session
  // — without this, opening the modal a second time would show the
  // Apply button labelled "Done" and clicking it would just close.
  delete els.claudeModal.dataset['applyDone'];
  els.claudeModalTitle.textContent = copy.title;
  els.claudeModalSubtitle.textContent = copy.subtitle;
  els.claudeModalApplyHint.innerHTML = 'Click <strong>Apply</strong> to update the client\'s config.';
  els.claudeModalApplyHint.style.display = '';
  els.claudeModal.classList.remove('hidden');
  els.claudePreview.style.display = 'none';
  els.claudePreview.innerHTML = '';
  els.btnClaudeApply.disabled = false;
  els.btnClaudeApply.textContent = 'Apply';
  // Per-client restart hint set by the success path; show a generic
  // placeholder until then.
  els.claudeFooterNote.textContent = 'After applying, restart the client so it re-reads the config.';
}

els.btnConfigureClaudeDesktop.addEventListener('click', () => openConfigureClientModal('claude-desktop'));
els.btnConfigureClaudeCode.addEventListener('click', () => openConfigureClientModal('claude-code'));
els.btnConfigureCursor.addEventListener('click', () => openConfigureClientModal('cursor'));

els.btnClaudeClose.addEventListener('click', () => {
  els.claudeModal.classList.add('hidden');
});

els.btnClaudeApply.addEventListener('click', async () => {
  // Post-success state: the button is labelled "Done" and clicking it
  // should dismiss the modal, NOT re-fire the apply IPC (which would
  // pointlessly re-write the same config and re-render the success
  // screen). The flag is set after a successful apply and cleared on
  // the next openConfigureClientModal().
  if (els.claudeModal.dataset['applyDone'] === '1') {
    els.claudeModal.classList.add('hidden');
    return;
  }
  const clientId = (els.claudeModal.dataset['mcpClient'] as McpClientId | undefined) ?? 'claude-desktop';
  els.btnClaudeApply.disabled = true;
  els.btnClaudeApply.textContent = 'Writing…';
  els.claudeFooterNote.textContent = '';
  try {
    const r = (await invoke('configure_mcp_client', { clientId })) as ClaudeConfigResult;
    const preservedLine = r.preserved_servers.length > 0
      ? `Preserved ${r.preserved_servers.length} other MCP server${r.preserved_servers.length === 1 ? '' : 's'}: <code>${r.preserved_servers.map(escape).join(', ')}</code>.`
      : 'No other MCP servers were present.';
    const headline = r.already_configured
      ? `${r.client_name} is already configured to use this App.`
      : r.created_file
        ? `Created ${r.client_name} config and added the Graphnosis entry.`
        : `Updated ${r.client_name}'s Graphnosis entry.`;
    // Read the current AI-routing toggle so we can tell the user whether
    // the client will be guided to use Graphnosis as default memory. Cheap IPC.
    let routingLine = '';
    try {
      const s = (await invoke('get_settings')) as AppSettings;
      routingLine = s.ai?.useAsDefaultMemory ?? true
        ? `<p style="margin-top: 8px;">${escape(r.client_name)} will be guided to use Graphnosis as your <strong>default memory</strong> — calling <code>recall</code> proactively for personal-context questions, and <code>correct</code> instead of <code>remember</code> for fixes. Change this any time under <strong>Settings → AI client routing</strong>.</p>`
        : `<p style="margin-top: 8px;">${escape(r.client_name)} will see Graphnosis as <strong>one memory option among many</strong> — no system-prompt-level routing. Change this under <strong>Settings → AI client routing</strong> if you want Graphnosis to lead.</p>`;
    } catch {
      // If we can't read settings (cortex just locked, etc.) skip the line
      // rather than block the success message.
    }
    els.claudePreview.innerHTML = `
      <p><strong>${escape(headline)}</strong></p>
      <p style="margin-top: 6px;">${preservedLine}</p>
      ${routingLine}
      <p style="margin-top: 10px; font-size: 15px; color: var(--fg-dim);">
        <strong>Config file:</strong> <code>${escape(r.config_path)}</code><br/>
        <strong>Relay binary:</strong> <code>${escape(r.relay_path)}</code><br/>
        <strong>Socket:</strong> <code>${escape(r.socket_path)}</code>
      </p>
    `;
    els.claudePreview.style.display = '';
    els.claudeFooterNote.textContent = r.restart_hint;
    // Post-success: the apply already happened, so the modal's "Click
    // Apply…" hint is stale — hide it. Repurpose the Apply button as
    // a dismiss "Done" by re-enabling it and routing its next click to
    // close (instead of re-firing the apply IPC). The dataset flag is
    // read by the click handler; we DON'T detach the listener because
    // a fresh openConfigureClientModal() resets the flag back to apply
    // mode for the next session.
    els.claudeModalApplyHint.style.display = 'none';
    els.btnClaudeApply.disabled = false;
    els.btnClaudeApply.textContent = 'Done';
    els.claudeModal.dataset['applyDone'] = '1';
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
//  cortexes written by older builds; it's just ignored.)

async function syncForgetMode(): Promise<void> {
  try {
    const s = (await invoke('get_settings')) as AppSettings;
    currentForgetMode = s.forget.mode;
  } catch {
    // Leave currentForgetMode at its last-known value — non-fatal.
  }
}

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

// ── Engram engine toolbar picker ────────────────────────────────────
//
// The toolbar picker has been removed. Engine switching is no longer
// exposed in the UI — force-3d is always the active engine.

async function switchEngramEngine(kind: AtlasEngineKind): Promise<void> {
  const current = currentAtlasEngineKind();
  if (kind === current && mainAtlas) return; // nothing to do
  localStorage.setItem(ATLAS_ENGINE_STORAGE_KEY, kind);
  // Tear down the current engine (frees WebGL context, removes the
  // canvas from the DOM) and re-mount with the new kind.
  if (mainAtlas) {
    mainAtlas.dispose();
    mainAtlas = null;
  }
  // Clear the container in case the previous engine left scaffolding
  // (the stub engine, for example, injects a "Coming soon" panel).
  els.atlasContainer.innerHTML = '';
  await mountAtlasIfNeeded();
  // Re-push the current graph's data into the new engine.
  if (atlasActiveGraph) pushDataIntoAtlas();
  renderAtlasLegend();
}


// ── Settings — graph management ───────────────────────────────────────────

/**
 * Render the "Graphs in this cortex" list inside Settings.
 * Shows every graph (including archived ones) with Archive/Unarchive and
 * Delete actions. Delete requires two clicks: first arms the button, second
 * confirms. Armed state resets if the user moves away.
 */
function renderSettingsGraphsList(): void {
  const container = document.getElementById('settings-graphs-list');
  if (!container) return;

  if (loadedGraphs.length === 0) {
    container.innerHTML = '<p style="font-size:14px; color:var(--fg-dim); margin:0;">No graphs loaded.</p>';
    return;
  }

  const TIER_CAPS: Record<string, string> = {
    public:    '4 000 tokens — unrestricted',
    personal:  '2 000 tokens — explicit recall only',
    sensitive: '0 tokens — AI blocked',
  };
  container.innerHTML = loadedGraphs.map((g) => {
    const archived = g.metadata.archived ?? false;
    const isActive = g.graphId === atlasActiveGraph;
    const tier = g.metadata.sensitivityTier ?? 'personal';
    return `
      <div class="settings-graph-row${archived ? ' is-archived' : ''}" data-sgr-id="${escape(g.graphId)}">
        <span class="sgr-name" title="Click to rename" data-sgr-id="${escape(g.graphId)}">${escape(g.metadata.displayName)}</span>
        <span class="sgr-id">${escape(g.graphId)}</span>
        ${archived ? '<span class="sgr-badge">archived</span>' : ''}
        ${isActive ? '<span class="sgr-badge">active</span>' : ''}
        <select class="sgr-tier-select" data-sgr-id="${escape(g.graphId)}" title="${TIER_CAPS[tier]}">
          <option value="public"    ${tier === 'public'    ? 'selected' : ''}>public</option>
          <option value="personal"  ${tier === 'personal'  ? 'selected' : ''}>personal</option>
          <option value="sensitive" ${tier === 'sensitive' ? 'selected' : ''}>sensitive</option>
        </select>
        <button class="btn-graph-archive" data-sgr-id="${escape(g.graphId)}" data-archived="${archived}">
          ${archived ? 'Unarchive' : 'Archive'}
        </button>
        <button class="btn-graph-delete" data-sgr-id="${escape(g.graphId)}" data-name="${escape(g.metadata.displayName)}">
          Delete
        </button>
      </div>`;
  }).join('');

  // ── Archive / Unarchive ──────────────────────────────────────────────────
  container.querySelectorAll<HTMLButtonElement>('.btn-graph-archive').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const graphId = btn.dataset['sgrId'] ?? '';
      const nowArchived = btn.dataset['archived'] === 'true';
      const nextArchived = !nowArchived;
      const displayName = loadedGraphs.find((g) => g.graphId === graphId)?.metadata.displayName ?? graphId;
      if (!graphId) return;

      btn.disabled = true;
      try {
        await invoke('set_graph_archived', { graphId, archived: nextArchived });
        // Refresh loadedGraphs so the picker and the list reflect the change.
        loadedGraphs = (await invoke('list_graphs_with_metadata')) as GraphWithMetadata[];
        // If we just archived the active graph, switch to a visible one.
        if (nextArchived && atlasActiveGraph === graphId) {
          atlasActiveGraph = pickAtlasGraph(); refreshActiveEngramLabel();
        }
        await refreshAtlasView();
        renderSettingsGraphsList();
      } catch (e) {
        showError(`Could not ${nextArchived ? 'archive' : 'unarchive'} "${displayName}": ${e}`);
        btn.disabled = false;
      }
    });
  });

  // ── Inline rename ───────────────────────────────────────────────────────
  container.querySelectorAll<HTMLSpanElement>('.sgr-name').forEach((span) => {
    span.style.cursor = 'pointer';
    span.addEventListener('click', () => {
      const graphId = span.dataset['sgrId'] ?? '';
      const current = span.textContent ?? '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = current;
      input.className = 'sgr-rename-input';
      span.replaceWith(input);
      input.focus();
      input.select();

      const commit = async () => {
        const newName = input.value.trim();
        if (!newName || newName === current) { input.replaceWith(span); return; }
        input.disabled = true;
        try {
          await invoke('rename_graph', { graphId, displayName: newName });
          const g = loadedGraphs.find((x) => x.graphId === graphId);
          if (g) g.metadata.displayName = newName;
          span.textContent = newName;
        } catch (e) {
          showError(`Could not rename: ${e}`);
        } finally {
          input.replaceWith(span);
        }
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = current; input.blur(); }
      });
    });
  });

  // ── Sensitivity tier ────────────────────────────────────────────────────
  const TIER_INFO: Record<string, { headline: string; bullets: string[]; warning?: string }> = {
    public: {
      headline: 'AI has full access to this engram.',
      bullets: [
        'Up to <strong>4 000 tokens</strong> of content per recall query',
        'Proactive injection enabled — AI may surface memories unprompted',
        'Best for reference material, documentation, and public notes',
      ],
    },
    personal: {
      headline: 'AI can access this engram only when explicitly asked.',
      bullets: [
        'Up to <strong>2 000 tokens</strong> of content per recall query',
        'Proactive injection <strong>disabled</strong> — AI only sees content when you call <code>recall</code>',
        'Best for personal notes, journal entries, and work summaries',
      ],
    },
    sensitive: {
      headline: 'AI is completely blocked from this engram.',
      bullets: [
        '<strong>0 tokens</strong> — the sidecar returns no results for any query',
        'The AI is never told why — it simply receives no results',
        'You can still browse and search these memories in Graphnosis',
        'Best for health records, financial data, or anything strictly private',
      ],
      warning: 'The AI will never see content from this engram, even if you ask it to recall memories from here.',
    },
  };

  container.querySelectorAll<HTMLSelectElement>('.sgr-tier-select').forEach((sel) => {
    let prevTier = sel.value;
    sel.addEventListener('change', () => {
      const graphId = sel.dataset['sgrId'] ?? '';
      const tier = sel.value as 'public' | 'personal' | 'sensitive';
      const g = loadedGraphs.find((x) => x.graphId === graphId);
      if (!graphId) return;

      const modal = document.getElementById('tier-confirm-modal')!;
      const engramLabel = document.getElementById('tier-confirm-engram')!;
      const body = document.getElementById('tier-confirm-body')!;
      const okBtn = document.getElementById('tier-confirm-ok') as HTMLButtonElement;
      const cancelBtn = document.getElementById('tier-confirm-cancel') as HTMLButtonElement;

      const info = TIER_INFO[tier];
      engramLabel.textContent = g?.metadata.displayName ?? graphId;
      body.innerHTML = `
        <div style="padding:12px 14px; border-radius:8px; background:var(--bg-elev); border:1px solid var(--border);">
          <p style="margin:0 0 10px; font-weight:600; font-size:14px; color:var(--fg);">${tier} — ${info?.headline ?? ''}</p>
          <ul style="margin:0; padding-left:18px; display:flex; flex-direction:column; gap:5px; font-size:14px; color:var(--fg-dim);">
            ${(info?.bullets ?? []).map((b) => `<li>${b}</li>`).join('')}
          </ul>
          ${info?.warning ? `<p style="margin:10px 0 0; font-size:15px; color:#e0a055; padding:8px 10px; border-radius:6px; background:color-mix(in oklab,#e0a055 10%,transparent);">${info.warning}</p>` : ''}
        </div>`;

      modal.classList.remove('hidden');

      const cleanup = () => {
        modal.classList.add('hidden');
        okBtn.onclick = null;
        cancelBtn.onclick = null;
      };

      cancelBtn.onclick = () => {
        sel.value = prevTier;
        cleanup();
      };

      okBtn.onclick = async () => {
        cleanup();
        sel.disabled = true;
        try {
          await invoke('set_graph_tier', { graphId, tier });
          if (g) g.metadata.sensitivityTier = tier;
          sel.title = TIER_CAPS[tier] ?? '';
          prevTier = tier;
        } catch (e) {
          showError(`Could not update tier: ${e}`);
          sel.value = g?.metadata.sensitivityTier ?? 'personal';
        } finally {
          sel.disabled = false;
        }
      };
    });
  });

  // ── Delete (type-to-confirm) ─────────────────────────────────────────────
  container.querySelectorAll<HTMLButtonElement>('.btn-graph-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const graphId = btn.dataset['sgrId'] ?? '';
      const displayName = btn.dataset['name'] ?? graphId;
      if (!graphId) return;

      // Find the parent row and inject the inline confirmation form.
      const row = btn.closest<HTMLElement>('.settings-graph-row');
      if (!row) return;

      // Hide the original action buttons while confirming.
      btn.style.display = 'none';
      const archiveBtn = row.querySelector<HTMLButtonElement>('.btn-graph-archive');
      if (archiveBtn) archiveBtn.style.display = 'none';

      const confirmDiv = document.createElement('div');
      confirmDiv.className = 'sgr-confirm-delete';
      confirmDiv.innerHTML = `
        <span class="sgr-confirm-label">Type <strong>${escape(displayName)}</strong> to delete forever:</span>
        <input type="text" class="sgr-confirm-input" placeholder="${escape(displayName)}" autocomplete="off" />
        <button class="sgr-confirm-go" disabled>Delete forever</button>
        <button class="sgr-confirm-cancel">Cancel</button>
      `;
      row.appendChild(confirmDiv);

      const input = confirmDiv.querySelector<HTMLInputElement>('.sgr-confirm-input')!;
      const goBtn = confirmDiv.querySelector<HTMLButtonElement>('.sgr-confirm-go')!;
      const cancelBtn = confirmDiv.querySelector<HTMLButtonElement>('.sgr-confirm-cancel')!;

      // Focus input so user can start typing immediately.
      input.focus();

      // Enable Delete button only when typed name matches exactly.
      input.addEventListener('input', () => {
        goBtn.disabled = input.value !== displayName;
      });

      cancelBtn.addEventListener('click', () => renderSettingsGraphsList());

      goBtn.addEventListener('click', async () => {
        goBtn.disabled = true;
        goBtn.textContent = 'Deleting…';
        cancelBtn.disabled = true;
        input.disabled = true;
        try {
          await invoke('delete_graph', { graphId });
          loadedGraphs = (await invoke('list_graphs_with_metadata')) as GraphWithMetadata[];
          if (atlasActiveGraph === graphId) {
            atlasActiveGraph = pickAtlasGraph(); refreshActiveEngramLabel();
            if (mainAtlas) { mainAtlas.dispose(); mainAtlas = null; }
          }
          await refreshAtlasView();
          renderSettingsGraphsList();
        } catch (e) {
          showError(`Could not delete "${displayName}": ${e}`);
          renderSettingsGraphsList();
        }
      });
    });
  });
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
    currentForgetMode = s.forget.mode;
    els.relayInitial.value = String(Math.round(s.mcpRelay.initialWaitMs / 1000));
    els.relayReconnect.value = String(Math.round(s.mcpRelay.reconnectMs / 1000));
    // AI routing toggle: defaults to true for older settings payloads that
    // don't include the field yet.
    els.aiDefaultMemory.checked = s.ai?.useAsDefaultMemory ?? true;
    // Auto-reingest: off by default for the same reason — safer to make
    // the user opt in than to surprise them by re-chunking on Vim save.
    els.aiAutoReingest.checked = s.ai?.autoReingestOnFileChange ?? false;
    // Quiet period selector: default 15 min. Match the closest option value.
    els.aiReingestQuietMs.value = String(s.ai?.reingestQuietMs ?? 900_000);
    // Show/hide the delay row based on current checkbox state.
    els.reingestDelayRow.style.display = els.aiAutoReingest.checked ? 'flex' : 'none';
    // Ingest performance presets — both default-safe if absent from older
    // settings payloads. The sidecar's mergeWithDefaults fills these in
    // on the next save regardless.
    els.aiChunkSize.value = s.ai?.chunkSize ?? 'balanced';
    els.aiEmbedBatch.value = s.ai?.embedBatch ?? 'auto';
    // Orbit debug HUD: session-only, reflects live engine state.
    const hudCb = els.settingsModal.querySelector<HTMLInputElement>('#debug-orbit-hud');
    if (hudCb) hudCb.checked = mainAtlas?.isOrbitDebugHUDVisible?.() ?? false;
  } catch (e) {
    els.settingsFooterNote.textContent = `Could not read settings: ${e}`;
  }
  void refreshLlmStatus();
});

// ── Settings tab (mode-pane data-pane="settings") render ───────────────────
//
// Engrams management, recovery phrase, and quarantined files used to live
// inside the Preferences modal. They are now top-level panels in the Settings
// tab (side rail) so the user doesn't need to open a modal to access them.
//
// This function is called every time the user activates the Settings tab
// (see activateMode in mode-switch logic). Re-rendering on each visit means
// changes made elsewhere (recovery from op-log, new ingest, quarantine
// happening at startup) are reflected without a manual refresh.

function renderSettingsTab(): void {
  // Engrams + quarantine moved out of the Settings tab into the dedicated
  // Cortex Management modal (red-ish button under Cortex tools). Renders
  // for those happen when the modal opens — see #btn-cortex-management.
  //
  // What remains on the Settings tab is just the Recovery phrase panel
  // (regenerate button), which is non-destructive and worth top-level
  // visibility.
  const regenBtn = document.getElementById('btn-regenerate-recovery-phrase') as HTMLButtonElement | null;
  if (regenBtn) {
    regenBtn.onclick = () => {
      showQuarantineConfirm({
        title: 'Generate a fresh recovery phrase?',
        subtitle: 'The current recovery phrase will stop working. The new one becomes your only fallback to the passphrase.',
        warningHtml:
          '<strong>You will see the new phrase exactly once.</strong> Have a way to write down 24 words ready before you continue ' +
          '(a password manager, a notepad, a printed piece of paper). After you dismiss the modal, the phrase cannot be retrieved.',
        confirmPhrase: 'regenerate recovery phrase',
        confirmLabel: 'Generate & show me the phrase',
        onConfirm: async () => {
          const phrase = await invoke<string>('regenerate_recovery_phrase');
          if (typeof phrase === 'string' && phrase.length > 0) {
            showRecoveryPhraseModal(phrase);
          } else {
            throw new Error('Sidecar returned an empty phrase.');
          }
        },
      });
    };
  }

  // Wire the Cortex Management button (red-ish) every time the tab is
  // activated. Idempotent because we replace .onclick each time.
  const cmBtn = document.getElementById('btn-cortex-management') as HTMLButtonElement | null;
  if (cmBtn) cmBtn.onclick = openCortexManagementModal;
}

// ── Cortex Management modal ────────────────────────────────────────────────
//
// Single home for destructive engram operations: archive/delete graphs and
// review/restore/delete quarantined files. Opened from Settings → Cortex
// Tools → "Cortex Management…". Every action inside is gated by typed
// confirmation; the modal itself is just the entry surface.

function openCortexManagementModal(): void {
  const modal = document.getElementById('cortex-management-modal') as HTMLDivElement | null;
  if (!modal) return;
  modal.classList.remove('hidden');
  // Render the three sections each time the modal opens so they reflect
  // current state (recently-quarantined engram, recently-recovered one
  // whose `recovered ✓` badge just appeared, recent forget calls that
  // bumped the soft-deleted count, etc.). Force a fresh stats fetch so
  // the forgotten-memories list is current; refreshStats invokes
  // updateGraphnosisForgottenRow() in its completion path.
  renderSettingsGraphsList();
  void renderQuarantineList();
  void refreshStats();

  const closeBtn = document.getElementById('btn-cortex-management-close') as HTMLButtonElement | null;
  if (closeBtn) closeBtn.onclick = () => modal.classList.add('hidden');
}

// ── Quarantine cleanup UI ───────────────────────────────────────────────
//
// Lists every <engram>.gai.corrupt-<ts> and <engram>.bundle.corrupt-<ts>
// in the cortex's graphs/ folder. Each row has a typed-confirmation Delete
// button (and a Restore button when it's safe to restore — i.e. no live
// canonical file exists for the engram).

interface QuarantineItem {
  name: string;        // filename, e.g. "davinci-manual.gai.corrupt-1715901234567"
  engramId: string;    // "davinci-manual"
  kind: 'gai' | 'bundle';
  timestamp: number;
  sizeBytes: number;
  liveEngramExists: boolean;
}

function formatTimestamp(ts: number): string {
  try {
    // The Rust auto-quarantine code uses Date.now() (milliseconds).
    // But manually-renamed files (e.g. when a user follows a "rename to
    // .corrupt-$(date +%s)" instruction in a doc / support thread) end up
    // with a SECONDS timestamp. Detect a seconds-shaped value (< year 2001
    // in ms = 1e12) and promote to ms so the display is sensible either way.
    const ms = ts < 1e12 ? ts * 1000 : ts;
    return new Date(ms).toLocaleString();
  } catch {
    return String(ts);
  }
}

async function renderQuarantineList(): Promise<void> {
  const container = document.getElementById('settings-quarantine-list');
  if (!container) return;
  try {
    const result = await invoke<{ items?: QuarantineItem[] }>('list_quarantine');
    const items = result?.items ?? [];
    if (items.length === 0) {
      container.innerHTML =
        '<p class="subtitle" style="font-size: 14px;">' +
        'No quarantined files. Nothing to clean up. ✨' +
        '</p>';
      return;
    }
    container.innerHTML = items.map((item) => {
      const safeToDelete = item.liveEngramExists; // engram was successfully recovered
      const safeBadge = safeToDelete
        ? '<span style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: color-mix(in oklab, var(--ok) 18%, transparent); color: var(--ok); font-weight: 600;">recovered ✓</span>'
        : '<span style="font-size: 10px; padding: 1px 6px; border-radius: 4px; background: color-mix(in oklab, var(--error) 18%, transparent); color: var(--error); font-weight: 600;">not yet recovered</span>';
      const restoreBtn = !item.liveEngramExists
        ? `<button class="btn-qrestore" data-qname="${escape(item.name)}" data-qengram="${escape(item.engramId)}" style="font-size: 15px; padding: 2px 8px;">Restore</button>`
        : '';
      return (
        '<div class="settings-graph-row" style="align-items: flex-start;">' +
          '<div style="flex: 1; min-width: 0;">' +
            `<div style="display: flex; gap: 8px; align-items: baseline;"><strong style="font-family: ui-monospace, monospace; font-size: 14px;">${escape(item.engramId)}</strong> ${safeBadge} <span class="sgr-id">${item.kind}</span></div>` +
            `<div class="subtitle" style="font-size: 15px; margin-top: 2px;">${escape(item.name)}</div>` +
            `<div class="subtitle" style="font-size: 15px;">Quarantined ${escape(formatTimestamp(item.timestamp))} · ${formatBytes(item.sizeBytes)}</div>` +
          '</div>' +
          '<div style="display: flex; gap: 6px; flex-shrink: 0;">' +
            restoreBtn +
            `<button class="btn-qdelete" data-qname="${escape(item.name)}" data-qengram="${escape(item.engramId)}" data-qsafe="${safeToDelete ? '1' : '0'}" style="font-size: 15px; padding: 2px 8px; color: var(--error); border-color: color-mix(in oklab, var(--error) 40%, var(--border));">Delete</button>` +
          '</div>' +
        '</div>'
      );
    }).join('');

    // Wire up Delete buttons
    container.querySelectorAll<HTMLButtonElement>('.btn-qdelete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.qname ?? '';
        const engramId = btn.dataset.qengram ?? '';
        const safe = btn.dataset.qsafe === '1';
        const warning = safe
          ? `The engram <strong>${escape(engramId)}</strong> has already been recovered (a live copy exists). The quarantined file <code>${escape(name)}</code> is no longer needed and can be safely deleted.`
          : `<strong>⚠ This engram has NOT been recovered yet.</strong> The quarantined file <code>${escape(name)}</code> may be the only on-disk copy of these bytes. Deleting it now means you will lose the chance to manually recover from it later — you'll have to rely on the op-log and original sources.<br><br>We strongly recommend you run <em>Recover from op-log</em> first and verify the engram comes back, then return here to delete.`;
        showQuarantineConfirm({
          title: `Delete ${name}?`,
          subtitle: 'Permanent — the file is unlinked from disk and cannot be undone.',
          warningHtml: warning,
          confirmPhrase: `delete ${engramId}`,
          confirmLabel: 'Delete file',
          onConfirm: async () => {
            await invoke('delete_quarantine', { name });
            await renderQuarantineList();
          },
        });
      });
    });

    // Wire up Restore buttons
    container.querySelectorAll<HTMLButtonElement>('.btn-qrestore').forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.qname ?? '';
        const engramId = btn.dataset.qengram ?? '';
        showQuarantineConfirm({
          title: `Restore ${name}?`,
          subtitle: 'The file will be renamed back to its original name and Graphnosis will try to load it on next unlock.',
          warningHtml:
            `Only do this if you have reason to believe the quarantine was spurious — e.g. you accidentally interrupted a save and the file is actually fine, or you're restoring a backup. ` +
            `If the file is actually corrupt, the next unlock will quarantine it again immediately.`,
          confirmPhrase: `restore ${engramId}`,
          confirmLabel: 'Restore file',
          onConfirm: async () => {
            await invoke('restore_quarantine', { name });
            await renderQuarantineList();
          },
        });
      });
    });
  } catch (e) {
    container.innerHTML = `<p class="error" style="font-size: 14px;">${escape(String(e))}</p>`;
  }
}

interface QuarantineConfirmOptions {
  title: string;
  subtitle: string;
  warningHtml: string;
  confirmPhrase: string;     // user must type exactly this
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}

function showQuarantineConfirm(opts: QuarantineConfirmOptions): void {
  const modal = document.getElementById('quarantine-confirm-modal') as HTMLDivElement | null;
  const titleEl = document.getElementById('qcm-title');
  const subtitleEl = document.getElementById('qcm-subtitle');
  const warningEl = document.getElementById('qcm-warning');
  const inputLabel = document.getElementById('qcm-input-label');
  const input = document.getElementById('qcm-input') as HTMLInputElement | null;
  const statusEl = document.getElementById('qcm-status');
  const cancelBtn = document.getElementById('btn-qcm-cancel') as HTMLButtonElement | null;
  const confirmBtn = document.getElementById('btn-qcm-confirm') as HTMLButtonElement | null;
  if (!modal || !titleEl || !subtitleEl || !warningEl || !inputLabel || !input || !statusEl || !cancelBtn || !confirmBtn) return;

  titleEl.textContent = opts.title;
  subtitleEl.textContent = opts.subtitle;
  warningEl.innerHTML = opts.warningHtml;
  inputLabel.innerHTML = `Type <code style="font-family: ui-monospace, monospace; padding: 1px 5px; background: var(--bg-elev); border-radius: 3px;">${escape(opts.confirmPhrase)}</code> to confirm:`;
  input.value = '';
  input.placeholder = opts.confirmPhrase;
  statusEl.textContent = '';
  confirmBtn.textContent = opts.confirmLabel;
  confirmBtn.disabled = true;

  const onInput = (): void => {
    confirmBtn.disabled = input.value.trim() !== opts.confirmPhrase;
  };
  input.oninput = onInput;

  const close = (): void => {
    modal.classList.add('hidden');
    input.oninput = null;
  };

  cancelBtn.onclick = close;
  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = 'Working…';
    try {
      await opts.onConfirm();
      close();
    } catch (e) {
      statusEl.textContent = '';
      warningEl.innerHTML = `<strong style="color: var(--error);">Failed:</strong> ${escape(String(e))}`;
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  };

  modal.classList.remove('hidden');
  input.focus();
}

// Show/hide the quiet-period selector whenever the checkbox changes.
els.aiAutoReingest.addEventListener('change', () => {
  els.reingestDelayRow.style.display = els.aiAutoReingest.checked ? 'flex' : 'none';
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
    currentForgetMode = forgetMode;   // keep in-memory copy in sync
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
        ai: {
          useAsDefaultMemory: els.aiDefaultMemory.checked,
          autoReingestOnFileChange: els.aiAutoReingest.checked,
          reingestQuietMs: parseInt(els.aiReingestQuietMs.value, 10) || 900_000,
          chunkSize: els.aiChunkSize.value as 'fine' | 'balanced' | 'coarse',
          embedBatch: els.aiEmbedBatch.value as 'small' | 'medium' | 'large' | 'auto',
        },
      },
    });
    // Orbit debug HUD: session-only toggle, not persisted to settings.
    const hudCb = els.settingsModal.querySelector<HTMLInputElement>('#debug-orbit-hud');
    if (hudCb && mainAtlas) {
      if (hudCb.checked) mainAtlas.startOrbitDebugHUD?.();
      else mainAtlas.stopOrbitDebugHUD?.();
    }
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

// In-flight recovery state — tracked at module scope so progress events
// fired by the sidecar can update the panel even after the user has navigated
// away (closed the modal) and come back. Survives modal close because the
// listeners are wired once at startup.
let currentRecoveryJobId: string | null = null;

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

  // Offer to snapshot the current state first. Recovery re-ingests sources,
  // which writes new nodes / edges / embcache and overwrites engram files.
  // If something goes wrong mid-recovery (rare with atomic writes + the
  // async progress flow, but possible) the user can restore the snapshot.
  // Skipping is fine — recovery itself doesn't destroy existing data.
  await showSnapshotOffer({
    subtitle:
      "About to re-ingest " + sourceIds.length + " source" +
      (sourceIds.length === 1 ? '' : 's') +
      ". A snapshot lets you roll back the entire Cortex if recovery " +
      "produces an unexpected state. Recommended for large recoveries.",
  });

  els.btnRecoveryApply.disabled = true;
  els.btnRecoveryApply.textContent = `Recovering ${sourceIds.length}…`;
  els.recoveryFooterNote.textContent =
    'Re-ingesting in the background — this can take 60+ minutes for a large PDF. ' +
    'You can close this panel and keep using the app; just don\'t quit Graphnosis. ' +
    'A notification will fire when recovery completes.';
  els.recoveryBody.innerHTML =
    '<div id="recovery-progress" style="padding: 12px 0;">' +
    '  <p id="recovery-progress-label" class="subtitle" style="margin: 0 0 8px;">Starting recovery…</p>' +
    '  <div style="height: 8px; background: var(--bg); border-radius: 4px; overflow: hidden;">' +
    '    <div id="recovery-progress-bar" style="height: 100%; width: 0%; background: var(--accent); transition: width 200ms;"></div>' +
    '  </div>' +
    '  <p id="recovery-progress-current" class="subtitle" style="margin: 8px 0 0; font-size: 15px;"></p>' +
    '</div>';
  try {
    const ack = (await invoke('recovery_apply', { sourceIds })) as { accepted?: boolean; jobId?: string };
    if (ack?.jobId) {
      currentRecoveryJobId = ack.jobId;
    }
  } catch (e) {
    els.recoveryBody.innerHTML = `<p class="error">Recovery could not be started: ${escape(String(e))}</p>`;
    els.recoverySubtitle.textContent = 'Apply failed.';
    els.btnRecoveryApply.disabled = false;
    els.btnRecoveryApply.textContent = 'Recover selected';
    currentRecoveryJobId = null;
  }
});

// ── Recovery progress + completion listeners ────────────────────────────
// These fire whether or not the recovery panel is open. If it's open, we
// update the progress bar live. If it's closed, we still post a native
// notification + refresh stats when the job completes.

interface RecoveryProgressPayload {
  jobId: string;
  phase: 'started' | 'source-start' | 'source-done';
  sourceId?: string;
  ref?: string;
  index?: number;
  total?: number;
  outcome?: { sourceId: string; ref: string; ok: boolean; error?: string; skipped?: string };
}

interface RecoveryDonePayload {
  jobId: string;
  report?: RecoveryReport;
  error?: string;
}

void listen<RecoveryProgressPayload>('graphnosis://recovery-progress', (evt) => {
  if (!currentRecoveryJobId || evt.payload.jobId !== currentRecoveryJobId) return;
  const { phase, ref, index, total } = evt.payload;
  if (phase === 'started') {
    const label = document.getElementById('recovery-progress-label');
    if (label) label.textContent = 'Reading op-log…';
    return;
  }
  if (total === undefined || index === undefined) return;
  const pct = Math.round((index - (phase === 'source-start' ? 1 : 0)) / total * 100);
  const bar = document.getElementById('recovery-progress-bar') as HTMLDivElement | null;
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  const label = document.getElementById('recovery-progress-label');
  if (label) label.textContent = `Source ${index} of ${total}`;
  const current = document.getElementById('recovery-progress-current');
  if (current) {
    const fileName = ref ? (ref.split('/').pop() ?? ref) : '';
    if (phase === 'source-start') {
      current.textContent = `Re-ingesting ${fileName}…`;
    } else if (phase === 'source-done') {
      const ok = evt.payload.outcome?.ok ?? false;
      const err = evt.payload.outcome?.error;
      current.textContent = ok
        ? `✓ ${fileName}`
        : `✗ ${fileName} — ${err ?? 'failed'}`;
    }
  }
});

void listen<RecoveryDonePayload>('graphnosis://recovery-done', (evt) => {
  if (!currentRecoveryJobId || evt.payload.jobId !== currentRecoveryJobId) return;
  currentRecoveryJobId = null;
  if (evt.payload.error) {
    // If the panel is still open, surface it there
    const isOpen = !els.recoveryModal.classList.contains('hidden');
    if (isOpen) {
      els.recoveryBody.innerHTML = `<p class="error">Recovery failed: ${escape(evt.payload.error)}</p>`;
      els.recoverySubtitle.textContent = 'Apply failed.';
      els.btnRecoveryApply.disabled = false;
      els.btnRecoveryApply.textContent = 'Recover selected';
    }
    void notifyRecoveryDone(0, 0, evt.payload.error);
    return;
  }
  const report = evt.payload.report;
  if (report) {
    const isOpen = !els.recoveryModal.classList.contains('hidden');
    if (isOpen) {
      renderReport(report);
    }
    void notifyRecoveryDone(report.recovered, report.failed);
    void refreshStats();
    void pushDataIntoAtlas();
  }
});

async function notifyRecoveryDone(recovered: number, failed: number, error?: string): Promise<void> {
  try {
    if (_notifPermission === null) {
      _notifPermission = await isPermissionGranted();
      if (!_notifPermission) {
        const result = await requestPermission();
        _notifPermission = result === 'granted';
      }
    }
    if (!_notifPermission) return;
    if (error) {
      sendNotification({ title: 'Graphnosis — Recovery failed', body: error });
    } else {
      const lines: string[] = [];
      if (recovered > 0) lines.push(`${recovered} source${recovered === 1 ? '' : 's'} recovered`);
      if (failed > 0) lines.push(`${failed} failed`);
      sendNotification({
        title: 'Graphnosis — Recovery complete',
        body: lines.join(' · ') || 'Done.',
      });
    }
  } catch { /* silent */ }
}

// Extensions the sidecar's ingest pipeline knows how to parse. Mirror of
// the set in apps/desktop-sidecar/src/ingest.ts (MARKDOWN_EXTS + …); kept
// in sync by hand because the sidecar runs in its own process. Anything
// else gets surfaced as "unsupported" before we round-trip to the sidecar
// — saves a confusing "couldn't parse" toast later in the pipeline.
const INGEST_SUPPORTED_EXTS = new Set([
  '.md', '.markdown', '.txt', '.html', '.htm', '.json', '.csv', '.pdf', '.docx',
]);

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return '';
  return p.slice(dot).toLowerCase();
}

/** Split paths into supported + rejected (unsupported extension OR no
 *  extension at all — drag-and-drop happily delivers folders/aliases). */
function partitionIngestPaths(paths: string[]): { supported: string[]; rejected: string[] } {
  const supported: string[] = [];
  const rejected: string[] = [];
  for (const p of paths) {
    if (INGEST_SUPPORTED_EXTS.has(extOf(p))) supported.push(p);
    else rejected.push(p);
  }
  return { supported, rejected };
}

/** Friendly, user-facing list of what we CAN ingest. */
const INGEST_SUPPORTED_HUMAN = 'PDF · DOCX · Markdown · TXT · HTML · JSON · CSV';

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

// ── Pre-ingest snapshot offer ─────────────────────────────────────────
//
// Presents a non-blocking modal after the user picks files (or drops them)
// but before ingestBatch fires. Resolves true if the user wants a snapshot
// first, false to skip. The caller decides what to do with that answer.

interface SnapshotOfferOptions {
  /** Override the default subtitle copy. Use for non-ingest triggers
   *  (recovery from op-log, passphrase change, etc.) so the user sees a
   *  context-appropriate explanation of what they're snapshotting against. */
  subtitle?: string;
  /** Override the confirm button label. Defaults to "Snapshot & Continue". */
  confirmLabel?: string;
}

function showSnapshotOffer(opts?: SnapshotOfferOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = els.snapshotOfferModal;
    const note = els.snapshotOfferNote;
    const btnSkip = els.btnSnapshotSkip;
    const btnConfirm = els.btnSnapshotConfirm;
    const subtitle = document.getElementById('snapshot-offer-subtitle');

    // Restore default subtitle on every open in case a previous caller
    // customized it; if the caller wants a custom subtitle they pass one.
    const defaultSubtitle =
      "Pin the current state of your Cortex before ingesting. If this file " +
      "changes something you didn't expect, you can restore from the snapshot.";
    if (subtitle) subtitle.textContent = opts?.subtitle ?? defaultSubtitle;

    note.textContent = '';
    btnConfirm.disabled = false;
    btnConfirm.textContent = opts?.confirmLabel ?? 'Snapshot & Continue';
    modal.classList.remove('hidden');

    const cleanup = (answer: boolean): void => {
      modal.classList.add('hidden');
      // Remove listeners so they don't fire on future invocations.
      btnSkip.removeEventListener('click', onSkip);
      btnConfirm.removeEventListener('click', onConfirm);
      modal.removeEventListener('click', onBackdrop);
      resolve(answer);
    };

    const onSkip = (): void => cleanup(false);
    const onBackdrop = (e: MouseEvent): void => {
      // Clicking the backdrop (not the modal panel itself) acts as Skip.
      if (e.target === modal) cleanup(false);
    };
    const onConfirm = async (): Promise<void> => {
      btnConfirm.disabled = true;
      btnConfirm.textContent = 'Snapshotting…';
      note.textContent = '';
      try {
        const r = (await invoke('create_snapshot')) as { id: string; sizeBytes: number; fileCount: number };
        note.textContent = `Snapshot saved (${r.fileCount} files).`;
        // Brief pause so the user can see the confirmation, then proceed.
        await new Promise<void>((res) => setTimeout(res, 600));
        cleanup(true);
      } catch (e) {
        note.textContent = `Snapshot failed: ${e}`;
        btnConfirm.disabled = false;
        btnConfirm.textContent = 'Retry';
        // Leave modal open so user can retry or skip.
      }
    };

    btnSkip.addEventListener('click', onSkip);
    btnConfirm.addEventListener('click', () => void onConfirm());
    modal.addEventListener('click', onBackdrop);
  });
}

els.btnAddFile.addEventListener('click', async () => {
  showError(null);
  try {
    const paths = (await invoke('pick_files')) as string[];
    if (paths.length === 0) return;
    // Defense-in-depth: the native dialog already filters extensions, but
    // "All files" is one click away. Re-check here so a stray .key / .zip /
    // folder never makes it to the sidecar.
    const { supported, rejected } = partitionIngestPaths(paths);
    if (rejected.length > 0) {
      const names = rejected.map((p) => p.split('/').pop() ?? p).join(', ');
      if (supported.length === 0) {
        showError(`Can't ingest ${names}. Supported: ${INGEST_SUPPORTED_HUMAN}.`);
        return;
      }
      showError(`Skipped ${rejected.length} unsupported file${rejected.length === 1 ? '' : 's'} (${names}). Supported: ${INGEST_SUPPORTED_HUMAN}.`);
    }
    // Offer snapshot after file selection so the user knows what they're about
    // to ingest. Skip proceeds immediately; Snapshot & Continue waits for the
    // snapshot to finish before handing off to ingestBatch.
    await showSnapshotOffer();
    await ingestBatch(supported);
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
      if (paths.length === 0) return;
      // Filter unsupported drops before the snapshot prompt — no point
      // asking the user to wait for a snapshot if the file we're about
      // to "ingest" can't be parsed. Surface what was rejected so the
      // drop didn't silently no-op.
      const { supported, rejected } = partitionIngestPaths(paths);
      if (rejected.length > 0) {
        const names = rejected.map((p) => p.split('/').pop() ?? p).join(', ');
        if (supported.length === 0) {
          showError(`Can't ingest ${names}. Supported: ${INGEST_SUPPORTED_HUMAN}.`);
          return;
        }
        showError(`Skipped ${rejected.length} unsupported file${rejected.length === 1 ? '' : 's'} (${names}). Supported: ${INGEST_SUPPORTED_HUMAN}.`);
      }
      void showSnapshotOffer().then(() => ingestBatch(supported));
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
// engram picker, atlas, wizards) has a current view of the cortex.

async function fetchGraphsMetadata(): Promise<void> {
  try {
    loadedGraphs = (await invoke('list_graphs_with_metadata')) as GraphWithMetadata[];
    // Always keep the topbar picker in sync regardless of active pane.
    syncEngramPicker();
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
  els.gwNote.innerHTML = '🔒 <strong>Stays on your machine.</strong> Your engram is stored only in your local Cortex folder — never uploaded or synced. When you use Graphnosis with an AI client, relevant memories are shared with that AI to enrich your conversations. Nothing else leaves your device. <button id="gw-gh-link" style="background:none;border:none;padding:0;color:inherit;opacity:0.6;font-size:inherit;cursor:pointer;white-space:nowrap;text-decoration:underline;">View source on GitHub ↗</button>';
  document.getElementById('gw-gh-link')?.addEventListener('click', () => {
    void invoke('plugin:opener|open_url', { url: 'https://github.com/nehloo-interactive/graphnosis-app' });
  });
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
  els.gwNote.textContent = 'Creating…';
  try {
    await invoke('create_graph_with_template', { graphId, template: gwSelected, displayName });
    els.graphWizardModal.classList.add('hidden');
    await fetchGraphsMetadata();
    await refreshStats();
    // Land the user on the Graphnosis pane pre-selected to the new
    // engram. The Check-in dashboard's empty state will guide them
    // toward dropping in a file or having Claude remember something.
    atlasActiveGraph = graphId; refreshActiveEngramLabel();
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
  const railIndicator = document.getElementById('rail-mcp-indicator');
  if (connections.length === 0) {
    // Status bar
    els.statusMcpDot.className = 'status-dot';
    els.statusMcpText.textContent = 'No AI client connected';
    // Rail indicator
    if (railIndicator) {
      railIndicator.innerHTML =
        '<span class="rail-mcp-dot"></span><span class="rail-mcp-name">No client</span>';
    }
  } else {
    // Pick the first alphabetically by friendly display name so the shown
    // client is deterministic when multiple are connected.
    const sorted = [...connections].sort((a, b) =>
      friendlyClient(a.clientName).localeCompare(friendlyClient(b.clientName))
    );
    const primary = friendlyClient(sorted[0]?.clientName);
    // Status bar
    els.statusMcpDot.className = 'status-dot ok';
    els.statusMcpText.textContent = primary;
    // Rail indicator — same info, compact form
    if (railIndicator) {
      railIndicator.innerHTML =
        `<span class="rail-mcp-dot connected"></span><span class="rail-mcp-name" title="${escape(primary)}">${escape(primary)}</span>`;
    }
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
  // First non-archived engram is the default. The Atlas picker UI lets users
  // switch at any time, and the choice persists in `atlasActiveGraph`.
  return loadedGraphs.find((g) => !g.metadata.archived)?.graphId ?? null;
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
  syncEngramPicker();
  const visibleGraphs = loadedGraphs.filter((g) => !g.metadata.archived);
  if (visibleGraphs.length === 0) {
    els.gDashboard.classList.add('hidden');
    els.gSearchResults.classList.add('hidden');
    renderDetailEmpty();
    return;
  }
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

  } catch (e) {
    // Real-world bug seen here: a forget triggered graph-mutation →
    // pollGraphMutations → loadGraphnosisData, and a transient IPC blip
    // landed in this catch. The old behavior nuked graphnosisAllNodes
    // and graphnosisOrphanIds to empty, which cascaded into pushDataIntoAtlas
    // (setNodes([])), an empty Sources list, and a zeroed legend — the
    // whole engram view disappeared even though the user only forgot
    // ONE node. Now: keep the previous cache so the UI stays usable;
    // the next successful poll (3 s cadence) will reconcile any drift.
    console.error('graphnosis load failed; keeping previous in-memory data', e);
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
    .slice(0, 60)        // pool: up to 60; served 30 at a time across pages
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
    .slice(0, 30)
    .map((node): DeckItem => ({
      node,
      prompt: "Not connected to anything yet — keep it, or was it a one-off?",
      reason: 'orphan',
    }));
  // Then "connect" cards — nodes whose entities ALSO appear in ≥3 other
  // active nodes. These are entity bridges the user can densify with
  // typed relationships in one pass. We pick the strongest bridge entity
  // for the prompt copy. Excludes nodes already surfaced as low-confidence
  // or orphan to keep the deck varied.
  //
  // Entity selection is two-pass:
  //   1. Prefer entities that appear verbatim in the visible contentPreview
  //      so the prompt is verifiably accurate ("this memory mentions X").
  //   2. Fall back to any strong entity from the SDK extraction (which may
  //      come from the full chunk text, not the truncated preview) — use
  //      softer prompt language in that case.
  const taken = new Set<string>([
    ...lowConfidence.map((it) => it.node.id),
    ...orphans.map((it) => it.node.id),
  ]);
  const entityCounts = computeEntityCounts(reviewable);
  const connect = reviewable
    .filter((n) => !taken.has(n.id) && !graphnosisSessionDispatched.has(n.id))
    .map((n) => {
      const ents = n.entities ?? [];
      const previewLower = n.contentPreview.toLowerCase();

      // Pass 1: entity visible in the truncated preview.
      let bestEnt: string | null = null;
      let bestCount = 0;
      let inPreview = false;
      for (const e of ents) {
        const c = entityCounts.get(e) ?? 0;
        if (c >= 4 && c > bestCount && previewLower.includes(e.toLowerCase())) {
          bestEnt = e; bestCount = c; inPreview = true;
        }
      }
      // Pass 2: any strong entity if nothing matched the preview.
      if (!bestEnt) {
        for (const e of ents) {
          const c = entityCounts.get(e) ?? 0;
          if (c >= 4 && c > bestCount) {
            bestEnt = e; bestCount = c;
          }
        }
      }

      return bestEnt ? { node: n, bridge: bestEnt, count: bestCount, inPreview } : null;
    })
    .filter((x): x is { node: NodeRecord; bridge: string; count: number; inPreview: boolean } => x !== null)
    // Prefer cards where the entity is visible in the preview — those produce
    // accurate, verifiable prompts. Within each tier sort by entity frequency.
    .sort((a, b) => {
      if (a.inPreview !== b.inPreview) return a.inPreview ? -1 : 1;
      return b.count - a.count;
    })
    // Cap cards per bridge entity so a single dominant entity doesn't
    // monopolize the deck. The previous behavior surfaced 30 cards all
    // pointing to the same most-frequent entity ("DRP" in Nelu's test
    // engram) — useful in theory but feels mechanically repetitive in
    // practice. With this cap, the deck stays varied: at most 6 cards
    // per bridge, with the remaining slots filled by less-frequent
    // entities the user might otherwise never review.
    .reduce<Array<{ node: NodeRecord; bridge: string; count: number; inPreview: boolean }>>(
      (acc, item) => {
        const perBridge = acc.filter((x) => x.bridge === item.bridge).length;
        if (perBridge < 6) acc.push(item);
        return acc;
      },
      [],
    )
    .slice(0, 30)        // pool: up to 30 connect cards across pages
    .map(({ node, bridge, inPreview }): DeckItem => ({
      node,
      bridgeEntity: bridge,
      // Rotate phrasings so 30 cards with the same bridge entity don't
      // all read as the literal same sentence. The bridge name itself
      // shows up underneath as a small chip — see g-deck-bridge-chip
      // in the card head HTML — so the prompt stays short and varied.
      // Templates are brain/synapse-flavored to match the tour's
      // hippocampus/seahorse story. Pick is deterministic per node so
      // navigating back to the same card shows the same prompt.
      prompt: pickConnectPrompt(node.id, inPreview),
      reason: 'connect',
    }));

  // Pending corrections lead — they're explicit, time-sensitive, and
  // the user already consented to the correction flow by asking Claude.
  // Build the full pool; serve the first page of DECK_PAGE_SIZE now.
  graphnosisDeckPool = [...pendingCards, ...lowConfidence, ...orphans, ...connect];
  graphnosisDeckPageStart = 0;
  graphnosisDeck = graphnosisDeckPool.slice(0, DECK_PAGE_SIZE);
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

// ── Check-in taglines ──────────────────────────────────────────────────
//
// Rotated randomly under the "Wire two memories together" headline so the
// trivia tool feels playful instead of clinical. All references stay
// inside the brain-as-software metaphor (engrams, synapses, hippocampus,
// neuroscientists, the seahorse). One is picked per card render via
// pickCheckinTagline(); same-card re-renders (search override) reuse the
// initial pick by caching it on the source node — see renderDeckTriviaCandidate.

const CHECKIN_TAGLINES: ReadonlyArray<string> = [
  "Your hippocampus would be proud.",
  "Neurons firing… probably.",
  "The synapse is listening.",
  "Two engrams walked into a graph…",
  "Memory consolidation, but with extra clicks.",
  "Cajal would have approved.",
  "Cogito ergo memorize.",
  "REM sleep, but for your second brain.",
  "Even your seahorse is impressed.",
  "Wire it once, recall it forever.",
  "Hebb's rule: cells that fire together, wire together.",
  "This is what neuroplasticity feels like.",
  "Your AI's hippocampus thanks you.",
  "Building neural overpasses.",
  "Memory palace, IRL.",
  "Stitching two thoughts together — like a brain surgeon, but cozier.",
  "Cross-reference like a librarian on espresso.",
  "Pavlov rings a bell.",
  "If neurons could subscribe, they would.",
  "Even Mnemosyne would take notes.",
  "Don't worry, your real brain won't notice.",
  "Spotting patterns is your superpower.",
  "Aristotle linked ideas this way. Probably.",
  "Connecting axons across the cortex.",
  "Two memories, one click — sweep the synapses.",
  "Plug them in. The dendrites await.",
  "Long-term potentiation: now with a UI.",
  "Glia approve this message.",
  "The Default Mode Network is taking a coffee break — your turn.",
  "Sherlock had a memory palace too.",
  "Funes the Memorious wishes he had this.",
  "Mind the synaptic gap.",
  "Encoding > Storage > Retrieval. You're at step two.",
  "Bonus engram unlocked.",
  "The corpus callosum sends its regards.",
  "More productive than your morning coffee.",
  "Marcel Proust enters the chat.",
  "What a sea-hippocampus this is.",
];

function pickCheckinTagline(): string {
  const i = Math.floor(Math.random() * CHECKIN_TAGLINES.length);
  return CHECKIN_TAGLINES[i] ?? CHECKIN_TAGLINES[0]!;
}

/**
 * Short, varied prompts for connect-reason deck cards. Rotated by a stable
 * hash of the node id so the same card always shows the same prompt —
 * scrolling back via the deck arrows doesn't reshuffle. The bridge entity
 * is shown separately as a chip (see g-deck-bridge-chip), so the prompt
 * stays generic and the audit detail is in the chip.
 *
 * Two pools: in-preview (we can verifiably claim the entity appears in
 * this memory's text) and not-in-preview (entity is in the SDK-extracted
 * set but might not be visible in the previewed chunk). Both pools stay
 * short and action-oriented.
 */
const CONNECT_PROMPTS_IN_PREVIEW: ReadonlyArray<string> = [
  'Wire this memory to its neighbors?',
  'This one has cousins in your engram — connect them?',
  'Mind the synaptic gap — bridge this to a related memory?',
  'Two threads, one topic. Connect them?',
  'A memory in the same neighborhood. Wire them up?',
  'Same context, different memory. Worth a link?',
  'Build a synapse between these two?',
  'These share ground. Tell us how.',
];

const CONNECT_PROMPTS_NOT_IN_PREVIEW: ReadonlyArray<string> = [
  'Across your engram, these share context. Connect?',
  'Same neighborhood — link this one to a relative?',
  'These overlap somewhere in your memories. Wire them?',
  'A nearby memory in the graph. Worth wiring up?',
  'Cousins, possibly. Tell us how they relate.',
  'These look like they belong together. Are they?',
];

function pickConnectPrompt(nodeId: string, inPreview: boolean): string {
  // Stable hash → same card always reads the same on revisit.
  let h = 0;
  for (let i = 0; i < nodeId.length; i++) h = (h * 31 + nodeId.charCodeAt(i)) | 0;
  const pool = inPreview ? CONNECT_PROMPTS_IN_PREVIEW : CONNECT_PROMPTS_NOT_IN_PREVIEW;
  return pool[Math.abs(h) % pool.length] ?? pool[0]!;
}

/**
 * Open the relationship-type picker modal. Lists every entry in
 * RELATIONSHIP_LABELS so the user can pick any type when the inline
 * Connect-as buttons don't cover what they want. Calls `onPick` with the
 * chosen label and closes the modal. Cancel just closes.
 */
function openRelTypePickerModal(onPick: (label: RelationshipLabel) => void): void {
  const modal = document.getElementById('rel-type-picker-modal') as HTMLDivElement | null;
  const list = document.getElementById('rel-type-picker-list');
  const cancelBtn = document.getElementById('btn-rel-type-cancel') as HTMLButtonElement | null;
  if (!modal || !list || !cancelBtn) return;

  const innerModal = modal.querySelector<HTMLElement>('.modal');
  const sourceTextEl = document.querySelector<HTMLElement>('.g-deck-content');
  const candidateTextEl = document.querySelector<HTMLElement>('.g-deck-trivia-text');
  const tabButtons = document.querySelectorAll<HTMLButtonElement>('.g-tab');
  const deckCard = document.getElementById('g-deck-card');

  // ── Close + cleanup ────────────────────────────────────────────────────
  // Define handlers first so they can reference closeAndCleanup, then wire
  // them at the bottom. Single chokepoint = no listener leaks across opens.
  const onTextClick = (): void => closeAndCleanup();
  const onTabSwitch = (e: Event): void => {
    const t = e.currentTarget as HTMLElement;
    if (t.dataset['gtab'] && t.dataset['gtab'] !== 'checkin') closeAndCleanup();
  };
  const onDeckBackdropClick = (e: MouseEvent): void => {
    if (innerModal && innerModal.contains(e.target as Node)) return;
    closeAndCleanup();
  };
  const onEscape = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeAndCleanup();
  };

  function closeAndCleanup(): void {
    modal!.classList.add('hidden');
    modal!.classList.remove('over-sidebar');
    if (innerModal) {
      innerModal.style.position = '';
      innerModal.style.top = '';
      innerModal.style.left = '';
      innerModal.style.width = '';
      innerModal.style.height = '';
    }
    sourceTextEl?.removeEventListener('click', onTextClick);
    candidateTextEl?.removeEventListener('click', onTextClick);
    tabButtons.forEach((b) => b.removeEventListener('click', onTabSwitch));
    deckCard?.removeEventListener('click', onDeckBackdropClick, { capture: true } as EventListenerOptions);
    document.removeEventListener('keydown', onEscape);
  }

  // ── Content ────────────────────────────────────────────────────────────
  list.innerHTML = RELATIONSHIP_LABELS.map((l) => `
    <button class="rel-type-row" data-rel-id="${escape(l.id)}">
      <span>${escape(l.label)}</span>
      <span class="rel-type-row-meta">${l.directed ? '→ directed' : '↔ undirected'} · ${escape(l.sdkType)}</span>
    </button>
  `).join('');

  list.querySelectorAll<HTMLButtonElement>('.rel-type-row').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset['relId'] ?? '';
      const label = RELATIONSHIP_LABELS.find((l) => l.id === id);
      if (label) {
        closeAndCleanup();
        onPick(label);
      }
    };
  });

  // ── Position over the right sidebar ───────────────────────────────────
  const sidebar = document.getElementById('g-detail');
  if (innerModal && sidebar && !sidebar.classList.contains('hidden')) {
    const rect = sidebar.getBoundingClientRect();
    modal.classList.add('over-sidebar');
    innerModal.style.position = 'fixed';
    innerModal.style.top = `${rect.top}px`;
    innerModal.style.left = `${rect.left}px`;
    innerModal.style.width = `${rect.width}px`;
    innerModal.style.height = `${rect.height}px`;
  }

  // ── Wire dismissals ────────────────────────────────────────────────────
  // The picker auto-closes when the user "moves away" from picking a
  // relationship type: clicks either node text, switches inner tab to
  // 3D Engram, clicks outside the picker on the deck card, or hits Escape.
  sourceTextEl?.addEventListener('click', onTextClick);
  candidateTextEl?.addEventListener('click', onTextClick);
  tabButtons.forEach((b) => b.addEventListener('click', onTabSwitch));
  deckCard?.addEventListener('click', onDeckBackdropClick, { capture: true });
  document.addEventListener('keydown', onEscape);
  cancelBtn.onclick = closeAndCleanup;

  modal.classList.remove('hidden');
}

function renderDeck(): void {
  // Sync nav button disabled states regardless of which branch we hit.
  syncDeckNavButtons();
  if (graphnosisDeck.length === 0 || graphnosisDeckIndex >= graphnosisDeck.length) {
    const done = graphnosisTendedThisSession;
    const nextPageStart = graphnosisDeckPageStart + DECK_PAGE_SIZE;
    const hasMore = nextPageStart < graphnosisDeckPool.length;
    const remaining = graphnosisDeckPool.length - nextPageStart;
    els.gDeckProgress.textContent = '';
    els.gDeckCardHead.innerHTML = '';
    // Empty engram — show onboarding card for new users
    if (graphnosisAllNodes.length === 0) {
      els.gDeckCard.innerHTML = `
        <div class="g-deck-onboarding">
          <div class="g-deck-onboarding-top">
            <p class="g-deck-onboarding-tagline">Your local encrypted memory, indexed for every AI tool.</p>
            <div class="g-deck-onboarding-steps">
              <div class="g-deck-onboarding-step">
                <span class="g-deck-onboarding-num">1</span>
                <div class="g-deck-onboarding-step-body">
                  <strong>Connect an AI client or add a data source</strong> — so Graphnosis has something to remember.
                </div>
              </div>
              <div class="g-deck-onboarding-step">
                <span class="g-deck-onboarding-num">2</span>
                <div class="g-deck-onboarding-step-body">
                  <strong>Ingest a file</strong> — drag a PDF, markdown file, or any document onto the app.
                  <div style="margin-top: 6px;"><button id="ob-ingest-btn" class="rail-shortcut-btn">Add file to engram…</button></div>
                </div>
              </div>
              <div class="g-deck-onboarding-step">
                <span class="g-deck-onboarding-num">3</span>
                <div class="g-deck-onboarding-step-body">
                  <strong>Ask your AI</strong> — open Claude, Cursor, or any connected client and try:
                </div>
              </div>
            </div>
          </div>
          <div class="g-deck-onboarding-bottom">
            <div class="g-deck-onboarding-connect" id="ob-connect-btns"></div>
            <div class="g-deck-onboarding-cmds">
              <span class="g-deck-cmd-chip" title="Click to copy" data-cmd="recall [topic]">recall [topic]</span>
              <span class="g-deck-cmd-chip" title="Click to copy" data-cmd="remember [something]">remember [something]</span>
              <span class="g-deck-cmd-chip" title="Click to copy" data-cmd="remind me about [topic]">remind me about [topic]</span>
              <span class="g-deck-cmd-chip" title="Click to copy" data-cmd="correct [memory]">correct [memory]</span>
              <span class="g-deck-cmd-chip" title="Click to copy" data-cmd="forget [topic]">forget [topic]</span>
            </div>
          </div>
        </div>`;
      // Populate connect buttons
      const wrap = document.getElementById('ob-connect-btns');
      if (wrap) {
        const clients: Array<[string, () => void]> = [
          ['Claude Desktop', () => openConfigureClientModal('claude-desktop')],
          ['Claude Code',    () => openConfigureClientModal('claude-code')],
          ['Cursor',         () => openConfigureClientModal('cursor')],
          ['📱 Mobile',      () => void openMobileWizard()],
        ];
        clients.forEach(([label, fn]) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'rail-shortcut-btn'; b.textContent = label;
          b.addEventListener('click', fn);
          wrap.appendChild(b);
        });
      }
      // Step 2 ingest button
      document.getElementById('ob-ingest-btn')?.addEventListener('click', () => els.btnAddFile.click());
      // Copy-to-clipboard for cmd chips — CSS class drives the green flash + fade
      els.gDeckCard.querySelectorAll<HTMLElement>('.g-deck-cmd-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          void navigator.clipboard.writeText(chip.dataset['cmd'] ?? chip.textContent ?? '');
          chip.classList.add('copied');
          setTimeout(() => chip.classList.remove('copied'), 1000);
        });
      });
      return;
    }

    els.gDeckCard.innerHTML = `
      <div class="g-deck-empty">
        <div class="g-deck-empty-grade">✓</div>
        <div>
          ${done > 0
            ? `You tended ${done} memor${done === 1 ? 'y' : 'ies'} this session.`
            : ''}
          ${hasMore
            ? `${done > 0 ? '<br/>' : ''}${remaining} more memor${remaining === 1 ? 'y' : 'ies'} flagged for review.`
            : done > 0
              ? '<br/>Nothing else flagged right now — your memory is in good hands.'
              : 'Nothing flagged right now — your memory is in good hands.'}
        </div>
        ${hasMore ? `<button class="deck-continue-btn">Continue with next ${Math.min(DECK_PAGE_SIZE, remaining)} →</button>` : ''}
      </div>
    `;
    if (hasMore) {
      els.gDeckCard.querySelector<HTMLButtonElement>('.deck-continue-btn')?.addEventListener('click', () => {
        graphnosisDeckPageStart = nextPageStart;
        graphnosisDeck = graphnosisDeckPool.slice(graphnosisDeckPageStart, graphnosisDeckPageStart + DECK_PAGE_SIZE);
        graphnosisDeckIndex = 0;
        renderDeck();
      });
    }
    return;
  }
  const item = graphnosisDeck[graphnosisDeckIndex];
  if (!item) return;
  const n = item.node;
  const breadcrumb = renderBreadcrumb(n);
  const cleanContent = cleanDisplayContent(n.contentPreview);
  els.gDeckProgress.textContent = `${graphnosisDeckIndex + 1} / ${graphnosisDeck.length}`;

  // Auto-load the source node in the right sidebar so the user can see
  // its full details (all connections, metadata) while reviewing.
  // `trace: true` also pushes the node into the left-rail Memory Trace so
  // the user can quickly hop back to memories they've reviewed.
  selectGraphnosisNode(n.id, { trace: true });

  // Pending-correction cards keep their own layout.
  if (item.reason === 'pending-correction' && item.pendingDiff) {
    renderPendingCorrectionCard(item.pendingDiff, breadcrumb);
    return;
  }

  // ── Pinned card head: the source node being reviewed ────────────────
  //
  // Layout mirrors the candidate panel below it so the two memories read
  // as a matched pair:
  //   [prompt]
  //   [common-topic chip]
  //   [content]
  //   [type chip] [trust chip]  filename
  //
  // The bridge entity (per-card specificity) lives in its own chip above
  // the content. The bottom meta line uses the same grayed chip styling
  // as the candidate panel — fact/memory/concept chip, trust chip, then
  // the filename as plain mono text (NOT a chip — it's a location, not
  // a category).
  const bridgeChip = item.bridgeEntity
    ? `<p class="g-deck-bridge-chip">Common topic: <strong>${escape(item.bridgeEntity)}</strong></p>`
    : '';
  const sourceType = n.nodeType ?? 'memory';
  // breadcrumb is already escape()'d HTML like "CLAUDE.md › Environment".
  // Drop it directly as the breadcrumb position in the meta row — mirrors
  // how the candidate panel shows its filename after the trust chip.
  els.gDeckCardHead.innerHTML = `
    <p class="g-deck-prompt">${escape(item.prompt)}</p>
    ${bridgeChip}
    <p class="g-deck-content">${escape(cleanContent)}</p>
    <div class="g-deck-trivia-meta">
      <span class="g-deck-trivia-type">${escape(sourceType)}</span>
      <span class="g-deck-trivia-conf">trust ${n.confidence.toFixed(2)}</span>
      ${breadcrumb ? `<span class="g-deck-trivia-file" title="${escape(renderBreadcrumbPlain(n))}">${breadcrumb}</span>` : ''}
      <!-- Skip + Forget sit at the right end of the meta row so the
           card-level actions are tucked beside the source provenance
           (file › section) rather than taking a full-width action row
           below. They're rendered small (.g-deck-meta-btn) but carry
           the same data-deck-action wiring as before. -->
      <span class="g-deck-trivia-actions">
        <button data-deck-action="skip" class="g-deck-meta-btn">Skip</button>
        <button data-deck-action="forget" class="g-deck-meta-btn deck-forget">🗑 Forget</button>
      </span>
    </div>
  `;
  // Clicking the source node text re-selects it in the right sidebar
  // (useful after the user clicked the candidate and wants to switch back)
  // AND pushes the node into the left-rail Memory Trace.
  els.gDeckCardHead.querySelector<HTMLElement>('.g-deck-content')?.addEventListener('click', () => {
    selectGraphnosisNode(n.id, { trace: true });
  });

  // ── Card body: search + single candidate panel ───────────────────────
  // Show the top-ranked connected candidate, with quick-action buttons.
  // The search lets the user swap to any other memory in this engram.
  els.gDeckCard.innerHTML = `
    <div class="g-deck-trivia-intro">
      <p class="g-deck-trivia-intro-headline">Wire two memories together — like neurons forming a new pathway.</p>
      <p class="g-deck-trivia-intro-tagline">${escape(pickCheckinTagline())}</p>
    </div>
    <div id="g-deck-trivia-candidate" class="g-deck-trivia-candidate">
      <p class="subtitle" style="padding: 12px;">Finding a connected memory…</p>
    </div>
  `;

  // Wire the top-level card actions. Skip + Forget moved into the pinned
  // meta row (rendered in gDeckCardHead above), but they retain the same
  // data-deck-action wiring. Forget targets the SOURCE node (the memory
  // currently under review) — distinct from the candidate-panel
  // relationship buttons, which connect the source to whatever candidate
  // is currently displayed.
  els.gDeckCardHead.querySelectorAll<HTMLButtonElement>('button[data-deck-action]').forEach((btn) => {
    btn.addEventListener('click', () =>
      handleDeckAction(btn.dataset['deckAction'] as 'skip' | 'forget', n));
  });

  // Note: the "Choose another memory" search input was removed — users
  // can navigate between cards via the deck arrows + the existing ⌘K
  // search; an inline-on-card search was redundant and added clutter.

  // Load candidates and render the first one.
  void renderDeckTriviaCandidate(n);
}

// ── Trivia candidate panel ─────────────────────────────────────────────
//
// Loads the top-ranked related candidate for the source node and renders
// it as a full-height panel with text, metadata, Forget/Skip buttons, and
// quick relationship-suggestion buttons (plus "Other" to open the modal).
// The search input in the same card body lets the user pick a different one.

let deckTriviaCurrentCandidate: NodeRecord | null = null;

async function renderDeckTriviaCandidate(sourceNode: NodeRecord, override?: NodeRecord): Promise<void> {
  const slot = document.getElementById('g-deck-trivia-candidate');
  if (!slot) return;

  // If an override was provided (from search), use it; otherwise load candidates.
  let candidate: NodeRecord | null = override ?? null;
  if (!candidate) {
    slot.innerHTML = '<p class="subtitle" style="padding:12px;">Finding a connected memory…</p>';
    const candidates = await getRelatedCandidates(sourceNode.id);
    candidate = candidates[0]?.node ?? null;
  }
  deckTriviaCurrentCandidate = candidate;

  if (!candidate) {
    slot.innerHTML = `
      <div class="g-deck-trivia-no-candidate">
        <p>No connected memories found. Search above to pick one, or click <strong>Looks right</strong> to move on.</p>
      </div>
    `;
    return;
  }

  // Compute relationship suggestions between source → candidate. Show as
  // many Connect-as buttons inline as we can — the more the user sees at
  // a glance, the rarer the trip to the "Other…" picker modal. We also
  // top up with always-useful generic types (Same topic, Related, Mentioned in)
  // so even uninformative type pairs (memory ↔ memory with no node-type
  // info) still surface a handful of one-click options.
  const ALWAYS_AVAILABLE_REL_IDS = [
    'same-topic', 'related', 'mentioned-in', 'depends-on',
    'cited-in', 'builds-on', 'contradicts',
  ];
  const { primary, alternatives } = suggestRelationshipLabels(sourceNode, candidate);
  const auto: SuggestedLabel[] = [primary, ...alternatives];
  // Dedupe-by-id, then append always-available generics that aren't already
  // present. Cap the inline list at 10 to avoid wrapping into a tall stack;
  // anything beyond that lives in the Other… modal.
  const seen = new Set(auto.map((s) => s.id));
  const generics: SuggestedLabel[] = [];
  for (const id of ALWAYS_AVAILABLE_REL_IDS) {
    if (seen.has(id)) continue;
    const l = RELATIONSHIP_LABELS.find((rl) => rl.id === id);
    if (!l) continue;
    generics.push({
      id: l.id, label: l.label, sdkType: l.sdkType, directed: l.directed,
      auto: true, fromId: sourceNode.id, toId: candidate.id,
    });
    seen.add(id);
  }
  const topSuggestions = [...auto, ...generics].slice(0, 10);
  const relBtns = topSuggestions.map((s) =>
    `<button class="g-deck-rel-btn" data-rel-id="${escape(s.id)}" data-rel-directed="${s.directed}"
             title="${escape(s.label)}">${escape(s.label)}</button>`
  ).join('');

  // Use the shared renderBreadcrumb so the candidate gets the same
  // "file › section <name>" treatment as the source node head and the
  // detail pane (was rendering bare filename before, which made the
  // candidate's provenance look inconsistent with the source's).
  const candBreadcrumb = renderBreadcrumb(candidate);
  const candType = candidate.nodeType ?? 'memory';
  const candPreview = cleanDisplayContent(candidate.contentPreview);

  // Layout intent: the candidate panel is now purely about deciding
  // whether and how to CONNECT the source to this candidate. Reading
  // order is SOURCE (top of card) → [relationship] → CANDIDATE — so
  // "Connect as: …" sits ABOVE the candidate text. Putting the buttons
  // between source and candidate makes the directional intent visually
  // obvious ("source --[same topic]--> candidate") without needing
  // explicit arrows. Meta chips (type, trust, file › section) remain
  // at the bottom as supporting context.
  slot.innerHTML = `
    <div class="g-deck-trivia-body">
      <div class="g-deck-trivia-rel">
        <span class="g-deck-trivia-rel-label">Connect as:</span>
        ${relBtns}
        <button class="g-deck-trivia-other">Other…</button>
      </div>
      <p class="g-deck-trivia-text">${escape(candPreview)}</p>
      <div class="g-deck-trivia-meta">
        <span class="g-deck-trivia-type">${escape(candType)}</span>
        <span class="g-deck-trivia-conf">trust ${candidate.confidence.toFixed(2)}</span>
        ${candBreadcrumb ? `<span class="g-deck-trivia-file" title="${escape(renderBreadcrumbPlain(candidate))}">${candBreadcrumb}</span>` : ''}
      </div>
    </div>
  `;

  // Forget / Skip used to live inside the candidate panel; they've moved
  // to the top-level card actions where they unambiguously target the
  // SOURCE node (the memory under review). The candidate panel is now
  // purely about connecting source → candidate.

  // Quick-connect relationship buttons.
  slot.querySelectorAll<HTMLButtonElement>('.g-deck-rel-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!candidate) return;
      const relId = btn.dataset['relId'] ?? '';
      const directed = btn.dataset['relDirec'] === 'true' || (btn.dataset['relDirected'] === 'true');
      const label = RELATIONSHIP_LABELS.find((l) => l.id === relId);
      if (!label) return;
      const suggestion: SuggestedLabel = {
        id: label.id, label: label.label, sdkType: label.sdkType,
        directed: label.directed, auto: true,
        fromId: sourceNode.id, toId: candidate.id,
      };
      btn.disabled = true;
      const ok = await linkOne(suggestion);
      if (ok) {
        graphnosisTendedThisSession++;
        updateRecap();
        await showDeckAck(`connected as "${label.label}"`, 'ok');
        graphnosisSessionDispatched.add(sourceNode.id);
        advanceDeck();
      } else {
        btn.disabled = false;
      }
    });
  });

  // "Other…" → open a modal listing every relationship TYPE. The old
  // implementation opened a node-search panel ("Don't see it? Search this
  // engram…") that conflated "pick a different candidate" with "pick a
  // relationship type" — and the search box on the card body already
  // covers the first case. Now Other… is purely about the relationship
  // type when the inline buttons don't cover the user's intent.
  slot.querySelector<HTMLButtonElement>('.g-deck-trivia-other')?.addEventListener('click', () => {
    if (!candidate) return;
    openRelTypePickerModal(async (picked) => {
      if (!candidate) return;
      const suggestion: SuggestedLabel = {
        id: picked.id, label: picked.label, sdkType: picked.sdkType,
        directed: picked.directed, auto: true,
        fromId: sourceNode.id, toId: candidate.id,
      };
      const ok = await linkOne(suggestion);
      if (ok) {
        graphnosisTendedThisSession++;
        updateRecap();
        await showDeckAck(`connected as "${picked.label}"`, 'ok');
        graphnosisSessionDispatched.add(sourceNode.id);
        advanceDeck();
      }
    });
  });

  // Wire click on candidate text → open it in the right sidebar AND
  // push to the left-rail Memory Trace so the user can revisit it later.
  slot.querySelector<HTMLElement>('.g-deck-trivia-text')?.addEventListener('click', () => {
    if (candidate) selectGraphnosisNode(candidate.id, { trace: true });
  });
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
        // the cortex — pending diffs are persisted in the sidecar.)
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
    // Two-step inline confirm: the meta-row actions transform in place
    // into "Sure? [Cancel] [Forget anyway]". Forgetting a memory is the
    // most permanent action in the deck — a single mis-click shouldn't be
    // enough. Modal would be heavier than this inline pattern needs.
    // Targets the new compact actions container inside the pinned head.
    const actionsRow = els.gDeckCardHead.querySelector<HTMLElement>('.g-deck-trivia-actions');
    if (!actionsRow) return;
    // If the confirm UI is already showing, ignore re-clicks (idempotent).
    if (actionsRow.classList.contains('deck-forget-confirm')) return;

    const previousHtml = actionsRow.innerHTML;
    actionsRow.innerHTML = `
      <span class="deck-forget-confirm-msg subtitle">Sure?</span>
      <button class="deck-forget-cancel g-deck-meta-btn">Cancel</button>
      <button class="deck-forget-go deck-forget g-deck-meta-btn">🗑 Forget</button>
    `;
    actionsRow.classList.add('deck-forget-confirm');

    const onDeckForgetKey = (e: KeyboardEvent): void => {
      if (!actionsRow.classList.contains('deck-forget-confirm')) {
        document.removeEventListener('keydown', onDeckForgetKey, true);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        document.removeEventListener('keydown', onDeckForgetKey, true);
        actionsRow.querySelector<HTMLButtonElement>('.deck-forget-go')?.click();
      } else if (e.key === 'Escape') {
        document.removeEventListener('keydown', onDeckForgetKey, true);
        actionsRow.querySelector<HTMLButtonElement>('.deck-forget-cancel')?.click();
      }
    };
    document.addEventListener('keydown', onDeckForgetKey, true);

    actionsRow.querySelector<HTMLButtonElement>('.deck-forget-cancel')?.addEventListener('click', () => {
      document.removeEventListener('keydown', onDeckForgetKey, true);
      actionsRow.classList.remove('deck-forget-confirm');
      actionsRow.innerHTML = previousHtml;
      // Re-wire the restored Skip/Forget buttons.
      actionsRow.querySelectorAll<HTMLButtonElement>('button[data-deck-action]').forEach((btn) => {
        btn.addEventListener('click', () =>
          handleDeckAction(btn.dataset['deckAction'] as 'skip' | 'forget', node));
      });
    });

    actionsRow.querySelector<HTMLButtonElement>('.deck-forget-go')?.addEventListener('click', async () => {
      const goBtn = actionsRow.querySelector<HTMLButtonElement>('.deck-forget-go');
      const cancelBtn = actionsRow.querySelector<HTMLButtonElement>('.deck-forget-cancel');
      if (goBtn) { goBtn.disabled = true; goBtn.textContent = 'Forgetting…'; }
      if (cancelBtn) cancelBtn.disabled = true;
      const success = await softDeleteNode(node.id);
      if (success) {
        graphnosisTendedThisSession++;
        updateRecap();
        await showDeckAck('forgotten', 'forget');
        advanceDeck();
      } else {
        // Restore the action bar so user can retry.
        actionsRow.classList.remove('deck-forget-confirm');
        actionsRow.innerHTML = previousHtml;
        actionsRow.querySelectorAll<HTMLButtonElement>('button[data-deck-action]').forEach((btn) => {
          btn.addEventListener('click', () =>
            handleDeckAction(btn.dataset['deckAction'] as 'skip' | 'forget', node));
        });
      }
    });
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
      <div style="margin-top: 6px; font-size: 14px;">${escape(label)}</div>
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

// Surface all engrams that have forgotten memories still on disk.
// Renders one row per engram (with its display name and count) so the
// user can purge each one independently. Hidden entirely when no engram
// has a non-zero soft-deleted count.
// Reads from the lastInspectorStats cache (populated by refreshStats).
function updateGraphnosisForgottenRow(): void {
  // The forgotten-memories list now lives inside the Cortex Management
  // modal (Settings → Cortex Management). The companion "Nothing forgotten"
  // empty-state line below the list is shown when no engram has soft-deleted
  // nodes — so the modal section always says something, instead of leaving
  // the header awkwardly alone.
  const emptyMsg = document.getElementById('cm-no-forgotten');
  if (!lastInspectorStats) {
    els.gRecapForgotten.classList.add('hidden');
    emptyMsg?.classList.remove('hidden');
    return;
  }
  const withForgotten = lastInspectorStats.graphs.filter((g) => g.softDeletedNodes > 0);
  if (withForgotten.length === 0) {
    els.gRecapForgotten.classList.add('hidden');
    els.gRecapForgotten.innerHTML = '';
    emptyMsg?.classList.remove('hidden');
    return;
  }
  emptyMsg?.classList.add('hidden');
  const purgeTitle =
    'Rebuild the graph from your remaining sources to physically remove ' +
    'forgotten memories. Slow on large engrams; aborts safely if any source ' +
    "can't be re-read.";
  els.gRecapForgotten.innerHTML = withForgotten.map((g) => {
    const name = loadedGraphs.find((lg) => lg.graphId === g.graphId)?.metadata.displayName ?? g.graphId;
    const n = g.softDeletedNodes;
    return `
      <div class="g-recap-forgotten-row">
        <span class="g-recap-forgotten-label" title="${escape(name)}">
          ${escape(name)} — ${n} forgotten memor${n === 1 ? 'y' : 'ies'}
        </span>
        <button class="btn-g-purge" data-graph-id="${escape(g.graphId)}" title="${purgeTitle}">Purge now</button>
      </div>`;
  }).join('');
  els.gRecapForgotten.classList.remove('hidden');
  // Wire each Purge button — rendered fresh each call so direct binding is fine.
  els.gRecapForgotten.querySelectorAll<HTMLButtonElement>('.btn-g-purge').forEach((btn) => {
    btn.addEventListener('click', () => void runPurge(btn));
  });
}

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
  // Infinite scroll: render the first batch, then let the IntersectionObserver
  // mount more as the user scrolls. Keeps initial paint cheap even on huge
  // result sets, while removing the old "Show X more" cliff.
  renderListWithInfiniteScroll(filtered);
}

// ── Infinite-scroll list renderer ─────────────────────────────────────
//
// One pager per active result set. Render the first INFINITE_SCROLL_BATCH
// rows immediately, then place a sentinel <div> at the bottom of the list;
// when it enters the viewport, append the next batch and re-mount the
// sentinel below.
//
// Why this shape (vs. just listening to scroll):
//   - IntersectionObserver is debounced by the browser, no rAF needed.
//   - Selection highlights + keyboard nav can target any rendered row;
//     we never replace earlier rows, only append.
//   - Resetting on new search is just "render again from 0" — no shared
//     mutable state to clean up beyond the previous observer (which we
//     disconnect explicitly).
const INFINITE_SCROLL_BATCH = 100;
let listScrollObserver: IntersectionObserver | null = null;
let listScrollSource: NodeRecord[] = [];
let listScrollDisplayed = 0;

function renderListWithInfiniteScroll(rows: NodeRecord[]): void {
  // Tear down any prior observer so we don't fire callbacks against a list
  // that's already been replaced (stale sentinel sitting in the previous
  // result set's DOM fragment).
  if (listScrollObserver) {
    listScrollObserver.disconnect();
    listScrollObserver = null;
  }
  listScrollSource = rows;
  listScrollDisplayed = 0;

  if (rows.length === 0) {
    els.gList.innerHTML = '';
    return;
  }
  els.gList.innerHTML = '';
  appendNextListBatch();
}

function appendNextListBatch(): void {
  const start = listScrollDisplayed;
  const end = Math.min(start + INFINITE_SCROLL_BATCH, listScrollSource.length);
  if (start >= end) return;

  // Strip any previous sentinel (it's about to be replaced lower in the list).
  const oldSentinel = els.gList.querySelector('.g-list-sentinel');
  if (oldSentinel) oldSentinel.remove();

  const html = listScrollSource.slice(start, end).map(renderListRow).join('');
  els.gList.insertAdjacentHTML('beforeend', html);
  listScrollDisplayed = end;

  // Wire just the freshly-added rows. Earlier rows already have handlers
  // — re-wiring everything would leak listeners on long scrolls.
  wireListRowHandlersFrom(start);
  syncListSelectionHighlight();

  if (end < listScrollSource.length) {
    // More to come — drop a sentinel and re-observe it.
    const sentinel = document.createElement('div');
    sentinel.className = 'g-list-sentinel';
    sentinel.style.height = '1px';
    els.gList.appendChild(sentinel);
    if (!listScrollObserver) {
      listScrollObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            appendNextListBatch();
            break;
          }
        }
      }, {
        // root: the scrollable list container itself, with a wide rootMargin
        // so we start fetching the next batch before the user hits the bottom.
        root: els.gList,
        rootMargin: '400px',
      });
    }
    listScrollObserver.observe(sentinel);
  } else if (listScrollObserver) {
    // We've rendered everything — stop watching.
    listScrollObserver.disconnect();
    listScrollObserver = null;
  }
}

function wireListRowHandlersFrom(startIndex: number): void {
  // Bind click/dblclick only to rows at or beyond `startIndex` to avoid
  // double-binding earlier batches on each scroll-triggered append.
  const rows = els.gList.querySelectorAll<HTMLElement>('.g-list-row');
  for (let i = startIndex; i < rows.length; i++) {
    const row = rows[i] as HTMLElement;
    const id = row.dataset['nodeId'];
    if (!id) continue;
    row.addEventListener('click', () => {
      // `trace: true` so search-result picks (and dashboard list picks)
      // accumulate in the left-rail Memory Trace — clicks here are
      // explicit user attention worth remembering for hop-back later.
      selectGraphnosisNode(id, { trace: true });
      els.gList.focus();
    });
    row.addEventListener('dblclick', () => {
      selectGraphnosisNode(id, { trace: true });
      startInlineEdit(id);
    });
  }
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
    renderListWithInfiniteScroll(rows);
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
      ${metaLine ? `<div class="g-row-meta"><span class="g-row-source" title="${escape(renderBreadcrumbPlain(n))}">${metaLine}</span></div>` : ''}
    </div>
  </div>`;
}

function wireListRowHandlers(): void {
  els.gList.querySelectorAll<HTMLElement>('.g-list-row').forEach((row) => {
    const id = row.dataset['nodeId'];
    if (!id) return;
    row.addEventListener('click', () => {
      // `trace: true` so search-result picks (and dashboard list picks)
      // accumulate in the left-rail Memory Trace — clicks here are
      // explicit user attention worth remembering for hop-back later.
      selectGraphnosisNode(id, { trace: true });
      els.gList.focus();
    });
    row.addEventListener('dblclick', () => {
      selectGraphnosisNode(id, { trace: true });
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

function selectGraphnosisNode(nodeId: string | null, { trace = false }: { trace?: boolean } = {}): void {
  // If the same node is re-selected and the detail pane isn't in edit mode,
  // skip the full re-render — replacing innerHTML reflows the sticky header
  // and resets the parent scroll container to the top, losing the user's
  // reading position inside the connections list.
  const alreadyShown = nodeId !== null
    && nodeId === graphnosisSelectedId
    && graphnosisEditingId === null;

  graphnosisSelectedId = nodeId;
  // Track WHY the selection happened. `trace: true` is the call signature
  // used for user-initiated navigation (search row click, memory-trace
  // click, 3D graph node click, detail-pane connection click). Trivia
  // candidate auto-cycle calls use `trace: true` too — but the user IS
  // explicitly interacting with the candidate when they click it. Setters
  // that happen invisibly (e.g. when the deck auto-advances) DON'T pass
  // trace. We use this flag in switchGraphnosisTab to decide whether the
  // selection should persist onto the 3D Engram view or be reset.
  graphnosisSelectionExplicit = trace;
  graphnosisEditingId = null; // cancel any pending edit on selection change
  syncListSelectionHighlight();
  // Mirror selection into the Atlas if mounted — but don't move the camera.
  if (mainAtlas && nodeId) mainAtlas.select(nodeId);
  if (mainAtlas && !nodeId) mainAtlas.resetEmphasis();
  els.btnAtlasReset.classList.toggle('node-selected', !!nodeId);
  // Only add to memory trace for explicit user clicks in the 3D graph or right sidebar.
  if (nodeId && trace) pushRecent(nodeId);

  if (!alreadyShown) {
    // Different node: re-render and let the panel naturally scroll to top so
    // the user sees the new node's header first.
    renderDetailPane();
  }
  // Same node, not editing: detail pane content is already correct — no need
  // to touch it. Scroll position is preserved.
}

function pushRecent(nodeId: string): void {
  if (!atlasActiveGraph) return;
  const current = graphnosisRecentsByGraph.get(atlasActiveGraph) ?? [];
  const next = [nodeId, ...current.filter((id) => id !== nodeId)]; // no cap — sidebar scrolls
  graphnosisRecentsByGraph.set(atlasActiveGraph, next);
  renderRecents();
}

function renderRecents(): void {
  const recents = currentRecents();
  if (recents.length === 0) {
    els.gMemoryTrace.classList.add('hidden');
    els.gMemoryTraceList.innerHTML = '';
    return;
  }
  els.gMemoryTrace.classList.remove('hidden');
  els.gMemoryTraceList.innerHTML = recents.map((id) => {
    const n = graphnosisAllNodes.find((nn) => nn.id === id);
    const cleanText = n ? cleanDisplayContent(n.contentPreview) : '';
    const label = cleanText
      ? (cleanText.length > 36 ? cleanText.slice(0, 33) + '…' : cleanText)
      : id.slice(0, 8) + '…';
    return `<button class="rail-memory-chip" data-node-id="${escape(id)}" title="${escape(n?.contentPreview ?? id)}">${escape(label)}</button>`;
  }).join('');
  els.gMemoryTraceList.querySelectorAll<HTMLButtonElement>('.rail-memory-chip').forEach((btn) => {
    const id = btn.dataset['nodeId'];
    if (id) btn.addEventListener('click', () => {
      // trace:true — memory-trace clicks are explicit navigation; the
      // selection should persist when the user switches to the 3D Engram
      // tab to see where this node sits in the graph.
      selectGraphnosisNode(id, { trace: true });
      mainAtlas?.focus(id);
    });
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
  // Full breadcrumb (file › section section-name) — section was dropped
  // briefly and re-added once the labeling clarified what it represents
  // (the sub-heading inside the source file, useful for situating where
  // a quote came from).
  const breadcrumbHtml = renderBreadcrumb(node);
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

  // Action row (only when not editing — edit buttons are above).
  // Lives INSIDE the sticky header so the three buttons stay pinned with
  // the node content and only the connections list scrolls below. Three
  // equal-width buttons via flex:1 each. "+ Connect" sits to the right
  // of Forget so the destructive action stays close to Correct and the
  // additive Connect is the trailing option.
  const actionRow = isEditing ? '' : `
    <div id="g-detail-forget-wrap" class="g-detail-actions g-detail-actions-compact">
      <button class="primary g-detail-btn-sm" id="btn-detail-edit">Correct <kbd>E</kbd></button>
      <button class="g-detail-btn-sm" id="btn-detail-forget" ${isActive ? '' : 'disabled'}>${isActive ? 'Forget <kbd>⌫</kbd>' : 'Already forgotten'}</button>
      <button class="g-detail-btn-sm g-detail-connect-toggle" id="btn-detail-connect">+ Connect</button>
    </div>`;

  // Type + trust + memory-trace status all live in one compact meta strip
  // ABOVE the filename. "Trust" is the user-facing rename of the internal
  // confidence score (0..1 → "trust: 0.90"). The trace dot still leads as
  // the at-a-glance signal.
  const typeChip = node.nodeType ? `<span class="g-detail-chip">type: <code>${escape(node.nodeType)}</code></span>` : '';
  const trustChip = `<span class="g-detail-chip">trust: <code>${node.confidence.toFixed(2)}</code></span>`;
  const validUntilChip = node.validUntil ? `<span class="g-detail-chip">valid until: ${new Date(node.validUntil).toLocaleString()}</span>` : '';

  els.gDetailBody.innerHTML = `
    <div class="g-detail-header">
      <div class="g-detail-conf">${confidenceDot} memory trace${isActive ? '' : ' · forgotten'}</div>
      <div class="g-detail-chips">${typeChip}${trustChip}${validUntilChip}</div>
      ${breadcrumbHtml ? `<div class="g-detail-breadcrumb" title="${escape(renderBreadcrumbPlain(node))}">${breadcrumbHtml}</div>` : ''}
      ${contentBlock}
      ${actionRow}
    </div>
    <div class="g-detail-scroll-body">
    <div id="g-detail-conn-wrap" class="g-detail-conn-wrap">
      ${renderConnectionsBlock(conns)}
    </div>
    <div class="g-detail-suggest-wrap">
      <div id="g-detail-suggest" class="g-detail-suggest hidden" data-node-id="${escape(node.id)}"></div>
    </div>
    </div>
  `;
  // The suggestion panel is collapsed by default in the detail pane.
  // Clicking the button mounts the shared renderer; on Connect or Cancel
  // it collapses again and the Connections section refreshes via
  // renderDetailPane (loadGraphnosisData fired inside linkOne).
  document.getElementById('btn-detail-connect')?.addEventListener('click', () => {
    const slot = document.getElementById('g-detail-suggest');
    const btn = document.getElementById('btn-detail-connect');
    const connWrap = document.getElementById('g-detail-conn-wrap');
    if (!slot || !btn) return;
    slot.classList.remove('hidden');
    // Keep + Connect visible (but disabled) so the header doesn't
    // visually shift when the panel opens — clicking it while the
    // panel is open is a no-op via :disabled. Temporarily hide the
    // existing connections list since it's about to be replaced (after
    // a successful Connect) and would otherwise compete with the
    // candidate picker for the user's attention.
    btn.setAttribute('disabled', '');
    btn.classList.add('is-busy');
    if (connWrap) connWrap.classList.add('hidden');
    void renderSuggestionPanel({
      sourceNode: node,
      slot,
      variant: 'detail',
      onConnected: (count) => {
        // Re-render the detail pane regardless of count so the
        // Connections section picks up any new edges and the button
        // re-enables (renderDetailPane rebuilds the whole subtree).
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

  // Wire connection rows: click → select neighbor; hover → preview-highlight.
  // Clicks on the retype button are intercepted before bubbling to the row.
  els.gDetailBody.querySelectorAll<HTMLElement>('.g-detail-conn-row').forEach((row) => {
    const id = row.dataset['neighbor'];
    if (!id) return;
    row.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.g-conn-retype-btn')) return;
      selectGraphnosisNode(id, { trace: true });
    });
    row.addEventListener('mouseenter', () => mainAtlas?.previewHighlight(id));
    row.addEventListener('mouseleave', () => mainAtlas?.previewHighlight(null));
  });

  // Retype button: show a popover with all RELATIONSHIP_LABELS filtered by
  // directed/undirected. Selecting a label calls node_link / node_link_directed.
  els.gDetailBody.querySelectorAll<HTMLButtonElement>('.g-conn-retype-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close any existing retype popover.
      document.querySelector('.g-conn-retype-popover')?.remove();
      const edgeId  = btn.dataset['edgeId']   ?? '';
      const fromId  = btn.dataset['from']    ?? '';
      const toId    = btn.dataset['to']      ?? '';
      const directed = btn.dataset['directed'] === 'true';
      const currentType = btn.dataset['current'] ?? '';

      const labels = RELATIONSHIP_LABELS.filter((l) => l.directed === directed);
      const pop = document.createElement('div');
      pop.className = 'g-conn-retype-popover g-suggest-popover';
      pop.innerHTML = `
        <div class="g-suggest-popover-section">
          <p class="g-suggest-popover-label">Change connection type</p>
          ${labels.map((l) => `
            <button class="g-suggest-popover-option${l.sdkType === currentType ? ' active' : ''}" data-sdk="${escape(l.sdkType)}" data-label="${escape(l.label)}" data-directed="${l.directed}">
              ${escape(l.label)}${l.directed ? ' <span class="g-suggest-dir">→</span>' : ''}
            </button>`).join('')}
          <button class="g-suggest-popover-option g-suggest-popover-disconnect" data-disconnect="1" title="Remove this edge entirely — the two memories are no longer connected.">
            🗑 Disconnect these memories
          </button>
        </div>`;
      document.body.appendChild(pop);
      // Position below the button.
      const rect = btn.getBoundingClientRect();
      pop.style.position = 'fixed';
      pop.style.top  = `${rect.bottom + 4}px`;
      pop.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;

      const close = (): void => { pop.remove(); document.removeEventListener('mousedown', outside); };
      const outside = (ev: MouseEvent): void => { if (!pop.contains(ev.target as Node)) close(); };
      setTimeout(() => document.addEventListener('mousedown', outside), 0);

      pop.querySelectorAll<HTMLButtonElement>('.g-suggest-popover-option').forEach((opt) => {
        opt.addEventListener('click', async () => {
          // "Disconnect" path: remove the edge entirely and don't replace
          // it. The two memories are no longer related per the user's
          // judgement. No retype, no new edge — just unlink.
          if (opt.dataset['disconnect'] === '1') {
            close();
            if (!edgeId) return;
            try {
              await invoke('node_unlink', { graphId: atlasActiveGraph, edgeId });
              await loadGraphnosisData(atlasActiveGraph!);
              if (mainAtlas) pushDataIntoAtlas();
              renderDetailPane();
            } catch (err) {
              console.error('[disconnect]', err);
            }
            return;
          }
          const sdkType = opt.dataset['sdk'] ?? '';
          const optLabel = opt.dataset['label'] ?? '';
          const isDir = opt.dataset['directed'] === 'true';
          close();
          try {
            // Remove the old edge before creating the new one so both
            // don't linger in the graph simultaneously.
            if (edgeId) {
              await invoke('node_unlink', { graphId: atlasActiveGraph, edgeId });
            }
            if (isDir) {
              await invoke('node_link_directed', {
                graphId: atlasActiveGraph,
                fromNodeId: fromId,
                toNodeId: toId,
                type: sdkType,
                evidence: optLabel,
              });
            } else {
              await invoke('node_link', {
                graphId: atlasActiveGraph,
                fromNodeId: fromId,
                toNodeId: toId,
                type: sdkType,
                reason: `User retyped: ${optLabel}`,
              });
            }
            await loadGraphnosisData(atlasActiveGraph!);
            if (mainAtlas) pushDataIntoAtlas();
            renderDetailPane();
          } catch (err) {
            console.error('[retype]', err);
          }
        });
      });
    });
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
  /** SDK edge id — needed to identify which specific edge to retype. */
  edgeId: string;
  /** from/to as the SDK sees it (not necessarily the selected node) */
  fromNodeId: string;
  toNodeId: string;
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
      const row: ConnRow = { edgeId: e.id, fromNodeId: e.from, toNodeId: e.to, neighborId: e.to, type: e.type, category: categoryFor(e.type), weight: e.weight, direction: 'out' };
      if (e.evidence) row.evidence = e.evidence;
      out.push(row);
    } else if (e.to === nodeId) {
      const row: ConnRow = { edgeId: e.id, fromNodeId: e.from, toNodeId: e.to, neighborId: e.from, type: e.type, category: categoryFor(e.type), weight: e.weight, direction: 'in' };
      if (e.evidence) row.evidence = e.evidence;
      out.push(row);
    }
  }
  for (const e of edges.undirected) {
    if (e.a === nodeId) out.push({ edgeId: e.id, fromNodeId: e.a, toNodeId: e.b, neighborId: e.b, type: e.type, category: categoryFor(e.type), weight: e.weight, direction: 'undirected' });
    else if (e.b === nodeId) out.push({ edgeId: e.id, fromNodeId: e.a, toNodeId: e.b, neighborId: e.a, type: e.type, category: categoryFor(e.type), weight: e.weight, direction: 'undirected' });
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
  const neighborSourceFile = (id: string): string => {
    const n = graphnosisAllNodes.find((nn) => nn.id === id);
    const src = n?.sourceFile ?? '';
    return src ? src.split('/').pop() ?? src : '';
  };
  const section = (label: string, arrow: string, list: ConnRow[]): string => {
    if (list.length === 0) return '';
    return `<div class="g-detail-conn-section">
      <div class="g-detail-conn-title">${escape(label)} (${list.length})</div>
      ${list.map((c) => {
        const displayLabel = c.evidence ?? humanizeSdkType(c.type, c.direction !== 'undirected');
        const srcFile = neighborSourceFile(c.neighborId);
        const isDirected = c.direction !== 'undirected';
        const meta = [
          escape(displayLabel),
          `confidence: ${c.weight.toFixed(2)}`,
          srcFile ? escape(srcFile) : '',
        ].filter(Boolean).join(' · ');
        return `<div class="g-detail-conn-row" data-neighbor="${escape(c.neighborId)}"
          data-edge-id="${escape(c.edgeId)}"
          data-from="${escape(c.fromNodeId)}"
          data-to="${escape(c.toNodeId)}"
          data-directed="${isDirected}">
          <span class="g-detail-conn-arrow" style="color: ${cssColorForCategory(c.category)};">${arrow}</span>
          <div style="flex:1;min-width:0;">
            <div class="g-detail-conn-text">${escape(neighborLabel(c.neighborId))}</div>
            <div class="g-detail-conn-meta">
              ${meta}
              <button class="g-conn-retype-btn" data-edge-id="${escape(c.edgeId)}" data-from="${escape(c.fromNodeId)}" data-to="${escape(c.toNodeId)}" data-directed="${isDirected}" data-current="${escape(c.type)}">change ▾</button>
            </div>
          </div>
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
    // Used to cap at 8 with a "Show N more" button. Dropped: the candidate
    // pool is already bounded (~20 via BGE search) and the rows area scrolls
    // inside the suggestion panel, so showing all of them costs ~12 extra
    // DOM rows worth of render time. Removing the cliff lets users see the
    // full ranked list at once.
    return candidates.map((c) => c.node);
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
    const readyCount = selectedAndReady().length;
    const selectedTotal = selected.size;
    // Dim is driven by CSS rules over .selected (per-row) + the
    // panel-level .popover-open class — toggled by openPopover/closePopover.
    // We don't toggle has-selection anymore: selecting a row no longer
    // dims the others. (Selected rows dim themselves; popover focus
    // dims everything except the row being edited.)
    void selectedTotal;

    // Preserve the candidate-rows scroll position across re-renders.
    // Every row click triggers render() which replaces slot.innerHTML —
    // the new .g-suggest-rows element starts at scrollTop=0, so the
    // user's scroll context vanishes on each tick. Snapshot before the
    // wipe, restore right after the new DOM is in place. Same trick
    // we use to keep the popover open across re-renders below.
    const prevRows = slot.querySelector<HTMLElement>('.g-suggest-rows');
    const prevScrollTop = prevRows?.scrollTop ?? 0;

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
    // Restore the candidate-rows scroll position so a checkbox click in
    // the middle of the list doesn't yank the user back to the top.
    if (prevScrollTop > 0) {
      const newRows = slot.querySelector<HTMLElement>('.g-suggest-rows');
      if (newRows) newRows.scrollTop = prevScrollTop;
    }
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
  // Strip HTML tags before any other processing.
  s = s.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
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
// Plain-text version of the breadcrumb suitable for a title="" tooltip.
// Matches what renderBreadcrumb prints (filename + section), without the
// HTML span used for the separator dim styling. Used in hover tooltips
// where leaking the full file path felt like an info leak (the user
// already sees the friendly name on the row; the tooltip just confirms
// it without exposing absolute paths from disk).
function renderBreadcrumbPlain(n: NodeRecord): string {
  const sourcePart = n.sourceFile ? prettySourceLabel(n.sourceFile) : '';
  if (!sourcePart && !n.section) return '';
  if (sourcePart && n.section) return `${sourcePart} › section ${n.section}`;
  if (n.section && !sourcePart) return `section ${n.section}`;
  return sourcePart;
}

function renderBreadcrumb(n: NodeRecord): string {
  const sourcePart = n.sourceFile ? prettySourceLabel(n.sourceFile) : '';
  if (!sourcePart && !n.section) return '';
  // "section " prefix in front of the section name clarifies what the
  // second breadcrumb segment is — without it users have read the bare
  // string ("Environment") as a separate node attribute rather than the
  // sub-heading inside the source file. Applied wherever the breadcrumb
  // renders (deck card head, detail pane, suggestion candidates).
  if (sourcePart && n.section) {
    return `${escape(sourcePart)} <span style="opacity: 0.55;">›</span> section ${escape(n.section)}`;
  }
  if (n.section && !sourcePart) return `section ${escape(n.section)}`;
  return escape(sourcePart);
}

// Pretty-render a source ref. "clip:1778...:Educație NYFA" becomes
// "remembered via Claude · 3 min ago". File paths stay as filename.
function prettySourceLabel(sourceRef: string): string {
  if (!sourceRef) return '';
  if (sourceRef.startsWith('ai-conversation:')) {
    const rest = sourceRef.slice('ai-conversation:'.length);
    const secondColon = rest.indexOf(':');
    const topic = secondColon !== -1 ? rest.slice(secondColon + 1) : '';
    return topic ? `AI: ${topic}` : 'AI conversation';
  }
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

// Returns the human-readable note explaining what "forget" will do given
// the current forget mode. Shown inside the confirmation UI.
function forgetModeNote(): string {
  if (currentForgetMode === 'purge') {
    return 'Permanently deleted — this memory will be removed from your cortex and cannot be recovered.';
  }
  return 'Soft-deleted — the memory will be hidden from your graph and AI context. It stays in your cortex and can be purged later from Settings → Purge soft-deleted.';
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
    // cortexes; the next deliberate refresh will catch any drift.
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

// Sidebar Forget — opens an inline type-to-confirm form inside the
// #g-detail-forget-wrap element. User must type "delete" before the
// confirm button enables. Keyboard shortcut (Backspace) either opens the
// form or, if it's already open, focuses the input so the user can type.
function handleSidebarForgetClick(): void {
  const nodeId = graphnosisSelectedId;
  if (!nodeId || !atlasActiveGraph) return;
  openSidebarForgetConfirm(nodeId);
}

function openSidebarForgetConfirm(nodeId: string): void {
  const wrap = document.getElementById('g-detail-forget-wrap');
  if (!wrap) return;
  // If the confirm form is already open, just focus the input.
  const existingInput = wrap.querySelector<HTMLInputElement>('.g-forget-input');
  if (existingInput) { existingInput.focus(); return; }

  wrap.innerHTML = `
    <div class="g-forget-confirm">
      <p class="g-forget-note">${escape(forgetModeNote())}</p>
      <div class="g-forget-confirm-row">
        <input type="text" class="g-forget-input" placeholder='Type "delete" to confirm' autocomplete="off" />
        <button class="g-forget-go" disabled>Forget</button>
        <button class="g-forget-cancel">Cancel</button>
      </div>
    </div>
  `;

  const input = wrap.querySelector<HTMLInputElement>('.g-forget-input')!;
  const goBtn = wrap.querySelector<HTMLButtonElement>('.g-forget-go')!;
  const cancelBtn = wrap.querySelector<HTMLButtonElement>('.g-forget-cancel')!;

  input.focus();
  input.addEventListener('input', () => {
    goBtn.disabled = input.value.trim().toLowerCase() !== 'delete';
  });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !goBtn.disabled) { e.preventDefault(); goBtn.click(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
  });
  cancelBtn.addEventListener('click', () => renderDetailPane());
  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    goBtn.textContent = 'Forgetting…';
    input.disabled = true;
    cancelBtn.disabled = true;
    const success = await softDeleteNode(nodeId);
    if (success) {
      graphnosisTendedThisSession++;
      applyGraphnosisFilter();
    } else {
      renderDetailPane(); // restore on failure
    }
  });
}

// Keyboard path (Backspace/Delete) — opens the confirm form if not open,
// or focuses the input if already open so the user can type right away.
function forgetSelected(): void {
  handleSidebarForgetClick();
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
    // Selection carry-over: explicit user navigation (search hit, memory
    // trace click, etc.) persists onto the 3D view so the user sees the
    // node they were exploring. Implicit selections (trivia card auto-
    // surfacing a candidate) get cleared so the graph opens with no
    // highlighted node — the user picks fresh in the 3D space.
    if (!graphnosisSelectionExplicit) {
      graphnosisSelectedId = null;
      // Don't call selectGraphnosisNode(null) — that would re-render the
      // detail pane and reset the explicit flag again. Just clear state.
      if (mainAtlas) mainAtlas.resetEmphasis();
      syncListSelectionHighlight();
      renderDetailEmpty();
    }
    void (async () => {
      await mountAtlasIfNeeded();
      pushDataIntoAtlas();
      // Frame the graph after a beat — same idea as before, lets the layout
      // settle before snapping the camera.
      setTimeout(() => mainAtlas?.zoomToFit(700, 20), 1200);
    })();
  } else if (tab === 'checkin') {
    // Returning to the dashboard from the Atlas tab — re-render in case
    // selection/data changed while away.
    if (els.gSearch.value.trim().length === 0) renderDashboard();
  } else if (tab === 'brain') {
    void renderLivingBrain();
  }
}

document.querySelectorAll<HTMLButtonElement>('.g-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset['gtab'] as GraphnosisTab | undefined;
    if (tab) switchGraphnosisTab(tab);
  });
});

// ── Atlas wiring — lazy-mounted when its tab opens ───────────────────
//
// Engine is selectable via Settings → Atlas engine. The factory in
// atlas-engine.ts hands back the chosen implementation; unavailable
// engines (sigma-2d, three-custom, deckgl-2d) render a "Coming soon"
// placeholder until they're built. Default is force-3d (today's
// current 3d-force-graph renderer).

const ATLAS_ENGINE_STORAGE_KEY = 'graphnosis.atlasEngine';

function currentAtlasEngineKind(): AtlasEngineKind {
  const raw = localStorage.getItem(ATLAS_ENGINE_STORAGE_KEY);
  const valid: AtlasEngineKind[] = ['force-3d', 'sigma-2d'];
  if (raw && (valid as string[]).includes(raw)) return raw as AtlasEngineKind;
  return 'force-3d';
}

async function mountAtlasIfNeeded(): Promise<void> {
  if (mainAtlas) return;
  const kind = currentAtlasEngineKind();
  mainAtlas = await createAtlasEngine(kind, {
    container: els.atlasContainer,
    onSelect: (node) => {
      // Route through the shared selection so list + detail stay in sync.
      selectGraphnosisNode(node?.id ?? null, { trace: true });
    },
  }) as unknown as Atlas; // cast: factory returns AtlasEngine; main.ts
                          // still types as Atlas during the transition.
                          // To be tightened when all engines are real.
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
  // Re-apply disabled sources — setNodes() defaults all sources to
  // visible, so we have to push our disable state in after each rebuild.
  for (const ref of disabledSources.values()) {
    mainAtlas.setSourceVisible(ref, false);
  }
  renderAtlasLegend();
  // Apply current selection emphasis if any.
  if (graphnosisSelectedId) mainAtlas.select(graphnosisSelectedId);
}

/**
 * Pretty-print a source label for the atlas legend. The atlas's source
 * registry uses the raw sourceRef as the legend label, which for AI-
 * created memories looks like `ai-conversation:<timestamp-or-id>:<topic>`
 * — readable to debuggers, not to users.
 *
 * We collapse anything starting with a recognized source-kind prefix to
 * a short human form ("AI: <topic>", "Clip: <topic>"). Falls through
 * unchanged for user-supplied labels like "collaboration" or "book.md".
 *
 * Truncation isn't done here — CSS `text-overflow: ellipsis` on
 * `.source-name` handles it; the full string lives in the row's
 * `title` attribute for hover.
 */
function formatLegendLabel(raw: string | undefined | null): string {
  if (!raw) return '(no source)';
  // ai-conversation:<id>:<topic>  →  AI: <topic>
  // ai-conversation:<id>          →  AI: <id>     (fallback when label missing)
  if (raw.startsWith('ai-conversation:')) {
    const rest = raw.slice('ai-conversation:'.length);
    const secondColon = rest.indexOf(':');
    return secondColon !== -1 ? `AI: ${rest.slice(secondColon + 1)}` : `AI: ${rest}`;
  }
  // clip:<id>:<topic>  →  Clip: <topic>  — same pattern for consistency.
  if (raw.startsWith('clip:')) {
    const rest = raw.slice('clip:'.length);
    const secondColon = rest.indexOf(':');
    return secondColon !== -1 ? `Clip: ${rest.slice(secondColon + 1)}` : `Clip: ${rest}`;
  }
  return raw;
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
    row.addEventListener('mouseenter', () => {
      const cat = row.dataset['cat'] as EdgeCategory | undefined;
      if (cat) mainAtlas?.hoverCategory(cat);
    });
    row.addEventListener('mouseleave', () => mainAtlas?.hoverCategory(null));
    row.addEventListener('click', (e) => {
      mainAtlas?.hoverCategory(null); // clear preview on click-commit
      const cat = row.dataset['cat'] as EdgeCategory | undefined;
      if (!cat || !mainAtlas) return;
      // Cmd/Ctrl-click: additive toggle (multi-select). Plain click: isolate
      // — show only this category, hide every other. Matches the Photoshop /
      // Figma / iTunes convention for filterable legend rows.
      if (e.metaKey || e.ctrlKey) {
        const current = mainAtlas.getCategoryVisibility()[cat];
        mainAtlas.setCategoryVisible(cat, !current);
      } else {
        const allVis = mainAtlas.getCategoryVisibility();
        const isolatedAlready =
          allVis[cat] && cats.every((c) => c === cat || !allVis[c]);
        if (isolatedAlready) {
          // Second click on the already-isolated row reverts to "show all".
          for (const c of cats) mainAtlas.setCategoryVisible(c, true);
        } else {
          for (const c of cats) mainAtlas.setCategoryVisible(c, c === cat);
        }
      }
      renderAtlasLegend();
    });
  });

  // Sources — same row pattern but with a dot swatch (matches node color).
  const sources = mainAtlas.sourcesWithCounts();
  els.atlasSourceList.innerHTML = sources.map((s) => {
    const swatch = `#${s.color.toString(16).padStart(6, '0')}`;
    const cls = s.visible ? '' : 'off';
    // Pretty-print AI-conversation sources: the raw label looks like
    // "ai-conversation:1779139479066:Milestone — first end-to-end..."
    // which is just noise next to clean user-labelled sources like
    // "collaboration" or "book-notes.md". Collapse to "AI: <topic>" so
    // the legend reads like a list of things, not internal source refs.
    // The full original label stays in the title attribute for hover.
    const pretty = formatLegendLabel(s.label);
    return `<div class="legend-row ${cls}" data-source-key="${escape(s.key)}" title="${escape(s.label || s.key || '(no source)')}">
      <span class="legend-swatch-dot" style="background: ${swatch};"></span>
      <span class="source-name">${escape(pretty)}</span>
      <span class="legend-count">${s.nodeCount}</span>
    </div>`;
  }).join('');
  els.atlasSourceList.querySelectorAll<HTMLElement>('.legend-row').forEach((row) => {
    row.addEventListener('mouseenter', () => {
      const key = row.dataset['sourceKey'];
      if (key !== undefined) mainAtlas?.hoverSource(key);
    });
    row.addEventListener('mouseleave', () => mainAtlas?.hoverSource(null));
    row.addEventListener('click', (e) => {
      mainAtlas?.hoverSource(null); // clear preview on click-commit
      const key = row.dataset['sourceKey'];
      if (key === undefined || !mainAtlas) return;
      const sourcesSnapshot = mainAtlas.sourcesWithCounts();
      // Same semantic as category rows: Cmd/Ctrl-click = additive toggle,
      // plain click = isolate this source (re-click reverts to show all).
      if (e.metaKey || e.ctrlKey) {
        const current = sourcesSnapshot.find((s) => s.key === key)?.visible ?? true;
        mainAtlas.setSourceVisible(key, !current);
      } else {
        const target = sourcesSnapshot.find((s) => s.key === key);
        const isolatedAlready =
          (target?.visible ?? false) &&
          sourcesSnapshot.every((s) => s.key === key || !s.visible);
        if (isolatedAlready) {
          for (const s of sourcesSnapshot) mainAtlas.setSourceVisible(s.key, true);
        } else {
          for (const s of sourcesSnapshot) mainAtlas.setSourceVisible(s.key, s.key === key);
        }
      }
      renderAtlasLegend();
    });
  });
}

els.atlasGraphPicker.addEventListener('change', () => void (async () => {
  atlasActiveGraph = els.atlasGraphPicker.value;
  refreshActiveEngramLabel();
  graphnosisSelectedId = null;
  // Clear any active search — the old query + results belong to the engram
  // you just left. Without this, switching engrams while a search is open
  // leaves stale result rows (and stale health stats) on screen until the
  // user manually clears the box. Reset the input, hide the clear button,
  // and let applyGraphnosisFilter (called below via refreshAtlasView's
  // sibling render) fall back to the dashboard.
  els.gSearch.value = '';
  els.gSearchClear.classList.add('hidden');
  // Recents are per-engram; the map is preserved so switching back later
  // restores the trail. renderRecents reads from the current engram.
  renderRecents();
  renderDetailEmpty();
  // Reset the per-session counters — they belong to the engram you were
  // tending. Switching engrams = starting a fresh check-in.
  graphnosisSessionDispatched.clear();
  graphnosisTendedThisSession = 0;
  await refreshAtlasView();
  // After switching engrams, reset the camera so the new graph fills the
  // view instead of inheriting the physics/camera state of the previous one.
  // Short delay lets the physics simulation settle before zoomToFit runs.
  setTimeout(() => mainAtlas?.zoomToFit(700, 20), 800);
})());

els.btnAtlasReset.addEventListener('click', () => {
  mainAtlas?.resetEmphasis();
  selectGraphnosisNode(null);
});

els.btnAtlasFit.addEventListener('click', () => {
  mainAtlas?.zoomToFit(700, 20);
});

els.btnAtlasAlive.addEventListener('click', () => {
  if (!mainAtlas) return;
  const nowEnabled = mainAtlas.setAliveEnabled(!mainAtlas.isAliveEnabled());
  els.btnAtlasAlive.textContent = nowEnabled ? '🧠 Alive Brain: On' : '⏸ Alive Brain: Off';
});

// ── 3D Atlas navigation cheatsheet ─────────────────────────────────────
// Small overlay in the bottom-left of the atlas pane that explains the
// rotate/pan/zoom + selection shortcuts. Dismissable; the user's choice
// persists in localStorage so they don't see it every time once they've
// learned the bindings.
{
  const helpEl = document.getElementById('atlas-nav-help') as HTMLDivElement | null;
  const closeBtn = document.getElementById('btn-atlas-nav-close') as HTMLButtonElement | null;
  // The legend (top-left) and the axes gizmo (bottom-right) need to step
  // out of the cheatsheet's footprint when it's shown, then reclaim the
  // freed space when it's dismissed. We flag this on the .atlas-stage so
  // CSS can drive both adjustments with a single ancestor selector — and
  // it stays correct regardless of which child renders first.
  const stage = helpEl?.closest('.atlas-stage') as HTMLElement | null;
  const syncStageFlag = (visible: boolean) => {
    stage?.classList.toggle('nav-help-visible', visible);
  };
  // Always show on launch. The old behaviour persisted a "hidden" flag in
  // localStorage so dismissing the cheatsheet stuck across sessions, but
  // the navigation bindings are subtle enough (drag rotate, shift+drag
  // pan, scroll zoom) that a refresher every launch costs little and
  // helps occasional users. The close button still works for THIS
  // session — the cheatsheet just reappears on next app launch.
  if (helpEl) {
    helpEl.classList.remove('hidden');
    syncStageFlag(true);
  }
  closeBtn?.addEventListener('click', () => {
    helpEl?.classList.add('hidden');
    syncStageFlag(false);
    // Intentionally NOT persisted — see comment above.
  });
}

// ── Search input + ⌘K + clear ─────────────────────────────────────────

els.gSearch.addEventListener('focus', () => {
  // Search box is always visible above both tabs. If the user clicks into it
  // while on the Atlas tab, switch to Check-in so results are visible.
  if (graphnosisActiveTab === 'atlas') switchGraphnosisTab('checkin');
});

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
        // trace:true — explicit keyboard navigation (Enter or ArrowDown
        // from the search box) is the user picking a result; should
        // persist onto 3D Engram tab.
        if (first) selectGraphnosisNode(first.id, { trace: true });
        els.gList.focus();
        scrollSelectedListRowIntoView();
      }
      return;
    }
    return;
  }

  // Typing a printable character while looking at the 3D graph → auto-switch
  // to Check-in so the keystroke lands in the search field naturally.
  if (graphnosisActiveTab === 'atlas' && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
    switchGraphnosisTab('checkin');
    els.gSearch.focus();
    // Don't preventDefault — the character propagates into the now-focused search input.
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
        // trace:true — Arrow-key nav over the list is explicit user
        // navigation; persists onto 3D Engram tab.
        selectGraphnosisNode(next.id, { trace: true });
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
        <p class="subtitle" style="margin-top: 8px; font-size: 15px;">
          Snapshots are useful before a risky re-ingest, a big batch of corrections,
          or any change you might want to undo. They live in <code>&lt;cortex&gt;/.snapshots/</code>
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

// Atlas perf A/B harness — exposes `atlasPerfApply()` to DevTools so you
// can flip a flag and immediately see the effect on the live graph.
// `globalThis.atlasPerf` is defined in atlas.ts with the flag defaults.
globalThis.atlasPerfApply = (): void => {
  mainAtlas?.reapplyPerfFlags();
};

// Tray-driven status updates push us into the right view in real time.
void listen<StatusSnapshot>('graphnosis://status', (evt) => render(evt.payload));

// ── Atlas render-loop power management ──────────────────────────────
//
// Three.js (via 3d-force-graph) runs its WebGL render loop at 60fps
// regardless of whether the window is visible. For a 2000+ node graph
// with active physics that's a constant ~5-15% CPU drain on every
// machine, every second the App is open — including while the user is
// on another desktop space, has the app minimized, or has the App
// window unfocused behind another window.
//
// We pause the loop on visibilitychange (whole window hidden) and on
// window blur (focus moved to another app). Resume on visibility +
// focus. Together these cover macOS Mission Control / window minimize,
// Cmd-Tabbing away, lock screen, and switching to another Space.
//
// Side effect: when the App is the active window but the user has
// navigated to a non-Atlas pane (e.g., Sources), the renderer keeps
// running. Not worth additional plumbing — the pane-switching case
// is rare and brief compared to "window not focused for hours."

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) mainAtlas?.pauseAnimation();
    else mainAtlas?.resumeAnimation();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('blur', () => mainAtlas?.pauseAnimation());
  window.addEventListener('focus', () => mainAtlas?.resumeAnimation());
}

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

void listen<GraphMutationPayload>('graphnosis://graph-mutation', (evt) => {
  const graphId = evt.payload.graphId ?? '';
  if (graphId.startsWith('__brain')) {
    handleBrainFrame(graphId);
    return;
  }
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

// ── Sidecar IPC helper ────────────────────────────────────────────────────
// Generic pass-through to the sidecar's IPC dispatch via the Tauri command
// `sidecar_ipc_call`. Used for brain and LLM methods.
async function ipcCall<T = unknown>(method: string, params: unknown): Promise<T> {
  return invoke<T>('sidecar_ipc_call', { method, params });
}

// ── Brain / Alive state ───────────────────────────────────────────────────

type BrainGoal = {
  nodeId: string; graphId: string; title: string;
  milestones: string[]; targetDate?: number; createdAt: number;
};
let brainGoals: BrainGoal[] = [];

const BRAIN_PHASE_LABELS: Record<string, string> = {
  'contradiction-scan': 'Scanning for contradictions',
  synapse: 'Forming new connections',
  insight: 'Synthesizing insights',
  temporal: 'Applying memory decay',
  'goal-check': 'Checking goals',
};

/** Pull all brain state from the sidecar into module cache, then repaint. */
async function refreshBrainState(): Promise<void> {
  try {
    const [vitality, insights, contradictions, goals] = await Promise.all([
      ipcCall<NonNullable<typeof brainVitalityReport>>('brain:getVitality', {}),
      ipcCall<typeof brainInsights>('brain:getInsights', {}),
      ipcCall<typeof brainContradictions>('brain:getContradictions', {}),
      ipcCall<BrainGoal[]>('brain:listGoals', {}),
    ]);
    brainVitalityReport = vitality;
    brainInsights = insights;
    brainContradictions = contradictions;
    brainGoals = goals;
    updateBrainUI();
  } catch { /* non-fatal — brain may not be initialized yet */ }
}

/** Status-bar chip + atlas animation + Living Brain pane. Cheap; no IPC. */
function updateBrainUI(): void {
  if (!brainVitalityReport) return;
  const v = brainVitalityReport.overall;

  els.brainVitality.style.display = '';
  els.brainVitality.textContent = `🧠 ${v}`;
  els.brainVitality.style.opacity = String(0.4 + (v / 100) * 0.6);

  mainAtlas?.setBrainVitality?.(v);

  renderLivingBrainPane();
}

// ── Living Brain pane ─────────────────────────────────────────────────────

/** Full refresh: pull state + LLM status, then paint. Tab-open + Refresh. */
async function renderLivingBrain(): Promise<void> {
  els.lbVitalityTitle.textContent = 'Checking your brain…';
  ensureFeedPlaceholder();
  await Promise.all([refreshBrainState(), refreshLlmStatus()]);
  // refreshBrainState only repaints on success — paint again so a failed
  // fetch still resolves to an honest "brain unavailable" state.
  renderLivingBrainPane();
}

/** Paint the pane from cached module state — no IPC, safe to call often. */
function renderLivingBrainPane(): void {
  renderLbVitality();
  renderLbContradictions();
  renderLbInsights();
  renderLbGoals();
  ensureFeedPlaceholder();
}

function vitalityCopy(v: number): [string, string] {
  if (v >= 75) return ['Your second brain is thriving', 'Well-connected, active, and consistent — keep feeding it.'];
  if (v >= 50) return ['Your second brain is healthy', 'Solid shape. More links and activity will push it higher.'];
  if (v >= 25) return ['Your second brain is waking up', 'Add memories, connect them, and resolve contradictions to strengthen it.'];
  return ['Your second brain is dormant', 'Ingest more knowledge and let the brain form connections.'];
}

function renderLbVitality(): void {
  if (!brainVitalityReport) {
    els.lbVitalityTitle.textContent = 'Brain is starting up…';
    els.lbVitalityDetail.textContent = 'Give it a moment after unlocking, then hit Refresh.';
    return;
  }
  const v = brainVitalityReport.overall;
  els.lbVitalityRing.style.setProperty('--v', String(v));
  els.lbVitalityScore.textContent = String(v);
  const [title, detail] = vitalityCopy(v);
  els.lbVitalityTitle.textContent = title;
  els.lbVitalityDetail.textContent = detail;
}

function renderLbContradictions(): void {
  const host = els.lbContradictions;
  if (brainContradictions.length === 0) {
    host.innerHTML = '<p class="lb-empty">No contradictions detected — your memories are consistent.</p>';
    return;
  }
  host.innerHTML = brainContradictions.map((c) => `
    <div class="lb-contradiction">
      <div class="lb-contradiction-pair">
        <div class="lb-snippet"><span class="lb-snippet-tag">A</span>${escape(c.snippetA)}</div>
        <div class="lb-snippet"><span class="lb-snippet-tag">B</span>${escape(c.snippetB)}</div>
      </div>
      <div class="lb-contradiction-foot">
        <span class="brain-subtitle">${Math.round(c.similarity * 100)}% similar — likely the same fact stated two ways</span>
        <button class="btn-sm" data-dismiss-contradiction="${escape(c.id)}">Dismiss</button>
      </div>
    </div>`).join('');
  host.querySelectorAll<HTMLButtonElement>('[data-dismiss-contradiction]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset['dismissContradiction'];
      if (!id) return;
      try { await ipcCall('brain:dismissContradiction', { id }); } catch { /* ignore */ }
      brainContradictions = brainContradictions.filter((c) => c.id !== id);
      renderLbContradictions();
    });
  });
}

function renderLbInsights(): void {
  const host = els.lbInsights;
  const active = brainInsights.filter((i) => !i.dismissed);
  if (active.length === 0) {
    host.innerHTML = '<p class="lb-empty">No insights yet. These surface every few hours when a local LLM is available.</p>';
    return;
  }
  host.innerHTML = active.map((i) => `
    <div class="lb-insight">
      <span class="lb-insight-kind">${escape(i.kind)}</span>
      <div class="lb-insight-title">${escape(i.title)}</div>
      <div class="lb-insight-body">${escape(i.body)}</div>
      <div style="margin-top:6px;"><button class="btn-sm" data-dismiss-insight="${escape(i.id)}">Dismiss</button></div>
    </div>`).join('');
  host.querySelectorAll<HTMLButtonElement>('[data-dismiss-insight]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset['dismissInsight'];
      if (!id) return;
      try { await ipcCall('brain:dismissInsight', { id }); } catch { /* ignore */ }
      brainInsights = brainInsights.filter((i) => i.id !== id);
      renderLbInsights();
    });
  });
}

function renderLbGoals(): void {
  const host = els.lbGoals;
  if (brainGoals.length === 0) {
    host.innerHTML = '<p class="lb-empty">No goals yet — develop one below and the brain will track it.</p>';
    return;
  }
  const now = Date.now();
  host.innerHTML = brainGoals.map((g) => {
    let deadline = 'No deadline set';
    if (g.targetDate) {
      const days = Math.ceil((g.targetDate - now) / 86_400_000);
      deadline = days <= 0
        ? '<span class="lb-goal-deadline-soon">Overdue</span>'
        : days <= 7
          ? `<span class="lb-goal-deadline-soon">${days} day${days === 1 ? '' : 's'} left</span>`
          : `${days} days left`;
    }
    const milestones = g.milestones.length > 0
      ? `<div class="lb-goal-meta">Milestones: ${escape(g.milestones.slice(0, 3).join(' · '))}</div>`
      : '';
    return `<div class="lb-goal">
      <div class="lb-goal-title">${escape(g.title)}</div>
      <div class="lb-goal-meta">${deadline}</div>
      ${milestones}
    </div>`;
  }).join('');
}

/** Show the empty-state line only when the feed has no real activity items. */
function ensureFeedPlaceholder(): void {
  if (!els.lbFeed.querySelector('.lb-feed-item')) {
    els.lbFeed.innerHTML =
      '<p class="lb-empty">No recent activity yet — the brain scans in the background every few minutes.</p>';
  }
}

function handleBrainFrame(graphId: string): void {
  if (graphId.startsWith('__brain_start_')) {
    const phase = graphId.slice('__brain_start_'.length, -2);
    els.lbFeed.querySelector('.lb-empty')?.remove();
    const label = BRAIN_PHASE_LABELS[phase] ?? phase;
    const item = document.createElement('div');
    item.className = 'lb-feed-item brain-thinking';
    item.dataset['phase'] = phase;
    item.textContent = `${label}… · ${new Date().toLocaleTimeString()}`;
    els.lbFeed.prepend(item);
    while (els.lbFeed.querySelectorAll('.lb-feed-item').length > 25) {
      els.lbFeed.querySelector('.lb-feed-item:last-child')?.remove();
    }
  } else if (graphId.startsWith('__brain_done_')) {
    const phase = graphId.slice('__brain_done_'.length, -2);
    if (phase) {
      const item = els.lbFeed.querySelector<HTMLElement>(
        `.lb-feed-item[data-phase="${CSS.escape(phase)}"].brain-thinking`,
      );
      if (item) {
        item.classList.remove('brain-thinking');
        const label = BRAIN_PHASE_LABELS[phase] ?? phase;
        item.textContent = `${label} — done · ${new Date().toLocaleTimeString()}`;
      }
    }
    // The event channel only carries graphId + ts — pull the fresh report.
    void refreshBrainState();
  }
}

els.btnLbRefresh.addEventListener('click', () => { void renderLivingBrain(); });

// ── LLM / Ollama settings ─────────────────────────────────────────────────

async function refreshLlmStatus(): Promise<void> {
  try {
    const status = await ipcCall<{ ollamaReachable: boolean; installedModels: string[]; activeModel: string | null; catalog?: Array<{ id: string; name: string }> }>('llm:status', {});

    if (status.ollamaReachable) {
      els.ollamaStatusBadge.textContent = '● Connected';
      els.ollamaStatusBadge.className = 'ok';
      els.ollamaModelRow.style.display = 'flex';
      els.ollamaPullRow.style.display = 'flex';
      els.ollamaNotInstalled.style.display = 'none';
      els.llmStatusChip.style.display = 'none';

      // Populate model selector
      els.ollamaModelSelect.innerHTML = '';
      for (const m of status.installedModels) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === status.activeModel) opt.selected = true;
        els.ollamaModelSelect.appendChild(opt);
      }
    } else {
      els.ollamaStatusBadge.textContent = '● Not running';
      els.ollamaStatusBadge.className = 'err';
      els.ollamaModelRow.style.display = 'none';
      els.ollamaPullRow.style.display = 'none';
      els.ollamaNotInstalled.style.display = '';
      els.llmStatusChip.style.display = '';
    }
  } catch { /* non-fatal */ }
}

els.btnOllamaApplyModel.addEventListener('click', async () => {
  const model = els.ollamaModelSelect.value;
  if (!model) return;
  try {
    await ipcCall('llm:setModel', { model });
    els.settingsFooterNote.textContent = `Model set to ${model}`;
  } catch (e) {
    els.settingsFooterNote.textContent = `Failed: ${(e as Error).message}`;
  }
});

// Live progress for `ollama pull`, streamed line-by-line from the sidecar.
interface LlmPullProgressPayload {
  model: string;
  status?: string;
  completed?: number;
  total?: number;
}
void listen<LlmPullProgressPayload>('graphnosis://llm-pull-progress', (evt) => {
  const p = evt.payload;
  els.ollamaPullProgress.style.display = '';
  if (p.completed && p.total && p.total > 0) {
    const pct = Math.round((p.completed / p.total) * 100);
    els.ollamaPullBar.style.width = `${pct}%`;
    els.ollamaPullLabel.textContent = `${p.status ?? 'Downloading'} — ${pct}%`;
  } else {
    els.ollamaPullLabel.textContent = p.status ?? 'Downloading…';
  }
});

els.btnOllamaPull.addEventListener('click', async () => {
  const model = els.ollamaPullSelect.value;
  if (!model) return;
  els.ollamaPullProgress.style.display = '';
  els.ollamaPullBar.style.width = '0%';
  els.ollamaPullLabel.textContent = `Pulling ${model}…`;
  els.btnOllamaPull.disabled = true;

  try {
    await ipcCall('llm:pullModel', { model });
    els.ollamaPullLabel.textContent = `${model} ready`;
    await refreshLlmStatus();
  } catch (e) {
    els.ollamaPullLabel.textContent = `Failed: ${(e as Error).message}`;
  } finally {
    els.btnOllamaPull.disabled = false;
    setTimeout(() => { els.ollamaPullProgress.style.display = 'none'; }, 3000);
  }
});

els.btnOpenOllamaSite.addEventListener('click', (e) => {
  e.preventDefault();
  void invoke('open_external_url', { url: 'https://ollama.ai' });
});

els.llmStatusChip.addEventListener('click', () => {
  // Open settings modal and scroll to brain section
  document.getElementById('settings-modal')?.classList.remove('hidden');
  document.getElementById('settings-brain-llm')?.scrollIntoView({ behavior: 'smooth' });
  void refreshLlmStatus();
});

// ── Goal develop form (Living Brain pane) ─────────────────────────────────

function resetGoalForm(): void {
  els.lbGoalForm.classList.add('hidden');
  els.btnNewGoal.style.display = '';
  els.lbGoalContext.value = '';
  els.lbGoalStrategy.value = '';
  els.lbGoalGoals.value = '';
}

els.btnNewGoal.addEventListener('click', () => {
  els.lbGoalForm.classList.remove('hidden');
  els.btnNewGoal.style.display = 'none';
  els.lbGoalContext.focus();
});

els.btnLbGoalCancel.addEventListener('click', resetGoalForm);

els.btnLbGoalDevelop.addEventListener('click', async () => {
  const context = els.lbGoalContext.value.trim();
  if (!context) { els.lbGoalContext.focus(); return; }
  const strategy = els.lbGoalStrategy.value.trim() || 'balanced growth';
  const goals = els.lbGoalGoals.value.trim() || 'meaningful progress';
  els.btnLbGoalDevelop.disabled = true;
  const toastId = addIngestToast('Developing your goal…');
  try {
    await ipcCall('brain:develop', {
      context, strategy, goals,
      saveAsGoal: true,
      ...(atlasActiveGraph ? { goalGraphId: atlasActiveGraph } : {}),
    });
    finishIngestToast(toastId, 'success', 'Goal developed and saved');
    resetGoalForm();
    await refreshBrainState();
  } catch (e) {
    finishIngestToast(toastId, 'error', (e as Error).message);
  } finally {
    els.btnLbGoalDevelop.disabled = false;
  }
});

// ── Engram-create suggestions ─────────────────────────────────────────────
//
// An AI client called `remember` with target_engram=<name>, but the engram
// doesn't exist. The sidecar refuses the write and broadcasts this event.
// We surface a banner; user decides whether to create the engram. The AI
// never auto-creates engrams — that's a deliberate human-in-the-loop call.
interface EngramSuggestCandidate {
  graphId: string;
  displayName: string;
  score: number;
  reason: 'substring' | 'tokens' | 'edit-distance';
}
interface EngramSuggestPayload {
  suggestedName: string;
  label?: string;
  text: string;
  preview: string;
  sourceKind?: 'clip' | 'ai-conversation';
  requestedBy?: string;
  /** Close-match candidates ranked by score. Empty → no close match,
   *  banner offers only "Create new". When non-empty, user picks one
   *  (or still falls through to "Create new" with the requested name). */
  candidates?: EngramSuggestCandidate[];
}

// Selection state for the banner: null = "Create new", string = existing graphId.
let pendingEngramSuggestion: EngramSuggestPayload | null = null;
let engramSuggestSelection: string | null = null;

function showEngramSuggestion(p: EngramSuggestPayload): void {
  pendingEngramSuggestion = p;
  const banner = document.getElementById('engram-suggest-banner');
  const headlineEl = document.getElementById('engram-suggest-headline');
  const previewEl = document.getElementById('engram-suggest-preview');
  const candWrap = document.getElementById('engram-suggest-candidates');
  if (!banner || !headlineEl || !previewEl || !candWrap) return;

  const client = p.requestedBy || 'An AI client';
  const candidates = p.candidates ?? [];
  // Default selection: top candidate if any, else "create new"
  engramSuggestSelection = candidates.length ? candidates[0]!.graphId : null;

  if (candidates.length) {
    headlineEl.innerHTML =
      `<strong>${escapeHtml(client)}</strong> wants to save into ` +
      `“<strong>${escapeHtml(p.suggestedName)}</strong>”. ` +
      `Did you mean one of these?`;
  } else {
    headlineEl.innerHTML =
      `<strong>${escapeHtml(client)}</strong> wants to save into a new engram ` +
      `“<strong>${escapeHtml(p.suggestedName)}</strong>”`;
  }
  // Render the full text (scrollable in CSS) so the user can actually
  // read what's about to be saved before clicking Create. The `preview`
  // field on the broadcast is just a 280-char truncation; the full body
  // is shipped as `p.text` for exactly this purpose.
  previewEl.textContent = p.text || p.preview || '';
  previewEl.scrollTop = 0;

  // Render candidate radio rows (if any), plus a synthetic "Create new" row.
  candWrap.innerHTML = '';
  if (candidates.length) {
    for (const c of candidates) {
      candWrap.appendChild(renderCandRow(c.graphId, c.displayName, reasonLabel(c.reason, c.score)));
    }
    candWrap.appendChild(renderCandRow(null, `Create new “${p.suggestedName}”`, 'fresh engram'));
    candWrap.classList.remove('hidden');
  } else {
    candWrap.classList.add('hidden');
  }

  updateEngramSuggestPrimary();
  banner.classList.remove('hidden');
}

function renderCandRow(graphId: string | null, label: string, reason: string): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'engram-suggest-cand';
  row.dataset.candId = graphId ?? '__new__';
  if (engramSuggestSelection === graphId) row.classList.add('selected');
  row.innerHTML = `
    <span class="engram-suggest-cand-radio" aria-hidden="true"></span>
    <span class="engram-suggest-cand-name"></span>
    <span class="engram-suggest-cand-reason"></span>
  `;
  (row.querySelector('.engram-suggest-cand-name') as HTMLElement).textContent = label;
  (row.querySelector('.engram-suggest-cand-reason') as HTMLElement).textContent = reason;
  row.addEventListener('click', () => {
    engramSuggestSelection = graphId;
    // Repaint selection state on siblings without rebuilding the list.
    const wrap = document.getElementById('engram-suggest-candidates');
    if (wrap) {
      wrap.querySelectorAll('.engram-suggest-cand').forEach((el) => {
        const elId = (el as HTMLElement).dataset.candId === '__new__' ? null : (el as HTMLElement).dataset.candId ?? null;
        el.classList.toggle('selected', elId === engramSuggestSelection);
      });
    }
    updateEngramSuggestPrimary();
  });
  return row;
}

function reasonLabel(reason: EngramSuggestCandidate['reason'], score: number): string {
  const pct = Math.round(score * 100);
  switch (reason) {
    case 'substring': return `contains your text · ${pct}%`;
    case 'tokens':    return `same words · ${pct}%`;
    case 'edit-distance': return `close spelling · ${pct}%`;
  }
}

function updateEngramSuggestPrimary(): void {
  const btn = document.getElementById('engram-suggest-primary') as HTMLButtonElement | null;
  const p = pendingEngramSuggestion;
  if (!btn || !p) return;
  if (engramSuggestSelection) {
    // Find display name for that candidate to put on the button label.
    const cand = (p.candidates ?? []).find((c) => c.graphId === engramSuggestSelection);
    btn.textContent = cand ? `Save to “${cand.displayName}”` : 'Save to selected';
  } else {
    btn.textContent = `Create “${p.suggestedName}” & save`;
  }
}

function hideEngramSuggestion(): void {
  pendingEngramSuggestion = null;
  engramSuggestSelection = null;
  document.getElementById('engram-suggest-banner')?.classList.add('hidden');
}

function slugifyEngramName(name: string): string {
  const base = name.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  return base || `engram-${Date.now()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

document.getElementById('engram-suggest-primary')?.addEventListener('click', () => {
  const p = pendingEngramSuggestion;
  if (!p) return;
  const btn = document.getElementById('engram-suggest-primary') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  // If selection is an existing graphId, save into it (sidecar handler
  // skips create when the graph already exists). Otherwise mint a new
  // engram from the AI-suggested name.
  const intoExisting = engramSuggestSelection;
  const graphId = intoExisting ?? slugifyEngramName(p.suggestedName);
  const displayName = intoExisting
    ? (p.candidates?.find((c) => c.graphId === intoExisting)?.displayName ?? intoExisting)
    : p.suggestedName;
  void (async () => {
    try {
      await invoke('accept_engram_suggestion', {
        graphId,
        template: 'personal',
        displayName,
        text: p.text,
        label: p.label ?? 'Conversation note',
        sourceKind: p.sourceKind ?? 'ai-conversation',
      });
      hideEngramSuggestion();
      // Refresh the top-bar engram dropdown + stats so a freshly-created
      // engram shows up immediately (pollGraphMutations alone only repaints
      // panes that watch mutation cursors — it doesn't reload the engram
      // list). When the user saved into an existing engram this is a
      // no-op for the dropdown but still refreshes stats, which is fine.
      if (!intoExisting) {
        await fetchGraphsMetadata();
      }
      void refreshStats();
      void pollGraphMutations();
      const title = intoExisting ? `Saved to “${displayName}”` : `Created engram “${displayName}”`;
      const tid = addIngestToast(title, 'Saved AI suggestion');
      finishIngestToast(tid, 'success', 'Saved AI suggestion');
    } catch (e) {
      const tid = addIngestToast(`Couldn't save`, String(e));
      finishIngestToast(tid, 'error', String(e));
    } finally {
      if (btn) btn.disabled = false;
    }
  })();
});

document.getElementById('engram-suggest-dismiss')?.addEventListener('click', () => {
  hideEngramSuggestion();
});

void listen<EngramSuggestPayload>('graphnosis://engram-create-suggested', (ev) => {
  if (!ev.payload) return;
  showEngramSuggestion(ev.payload);
  // If the user has the App in the background (menu bar collapsed, or
  // another app focused), poke them with a system notification. The
  // banner will be waiting when they come back.
  const who = ev.payload.requestedBy ?? 'An AI client';
  const hasCandidates = (ev.payload.candidates?.length ?? 0) > 0;
  void notifyIfBackground({
    title: 'Graphnosis — confirmation needed',
    body: hasCandidates
      ? `${who} wants to save into “${ev.payload.suggestedName}” — close matches found. Click Graphnosis to choose.`
      : `${who} wants to save into a new engram “${ev.payload.suggestedName}”. Click Graphnosis to confirm.`,
  });
});

// ── Correction proposals from the `correct` MCP tool ─────────────────────
// The AI proposed a structured diff for an existing memory. The diff lives
// in the sidecar's pendingDiffs map; the App shows it in the pending-
// corrections panel after the next poll. We use this event to (a) refresh
// the panel immediately so there's no lag and (b) notify the user when
// the App is backgrounded, since otherwise the correction can sit
// unnoticed for hours.
interface CorrectionProposedPayload {
  diffId: string;
  graphId: string;
  correction: string;
  requestedBy?: string;
  changeCount: number;
}
void listen<CorrectionProposedPayload>('graphnosis://correction-proposed', (ev) => {
  if (!ev.payload) return;
  // Refresh the pending-corrections panel right away so the diff is
  // visible the moment the user opens the App.
  void fetchPendingCorrections();
  const who = ev.payload.requestedBy ?? 'An AI client';
  const n = ev.payload.changeCount;
  const changes = n === 1 ? '1 change' : `${n} changes`;
  void notifyIfBackground({
    title: 'Graphnosis — correction proposed',
    body: `${who} proposed ${changes} to your memory. Click Graphnosis to review.`,
  });
});

// ── First-run guided tour ─────────────────────────────────────────────────
//
// Shows once (keyed on localStorage flag 'graphnosis_tour_done').
// No external libraries. Pure DOM manipulation.

const TOUR_STEPS: Array<{ title: string; body: string; connectArea?: boolean }> = [
  {
    title: 'Welcome to Graphnosis',
    body: 'Your local encrypted memory, indexed for every AI tool.\nThis quick tour takes about a minute.',
  },
  {
    title: 'Your Cortex: a local, encrypted memory',
    body: 'Choose a folder on your Mac. That\'s your Cortex — an encrypted memory storage, like the human brain\'s cortex, that stays entirely on your device. Never uploaded. Never shared.\n\nGraphnosis will give you a 24-word recovery phrase the first time you unlock it. Write it down — that\'s the only fallback if you ever forget your passphrase.',
  },
  {
    title: 'Add your memories privately — and index them',
    body: 'Add files, websites, or clips to your Cortex. Graphnosis extracts meaningful nodes — ideas, facts, references — and indexes them for your AI, like the human brain\'s hippocampus.\n\nWant your Cortex to grow on its own? Settings → Connectors lets you wire in RSS feeds, GitHub repos, Slack stars, Trello boards, Linear issues, or any webhook. Bring your own credentials — Graphnosis is just the receiver — and new items flow in on a 15-minute schedule, encrypted at rest.\n\n(Yes, that\'s why the logo is a seahorse. "Hippocampus" is Greek for seahorse — the brain region was named after the shape in 1564.)',
  },
  {
    title: 'Your AI now remembers you',
    body: 'Connect any MCP-aware AI (Claude, Cursor, and more). When you start a conversation, Graphnosis retrieves and attaches the most relevant memories, like the human brain\'s prefrontal cortex. The AI answers as if it already knew you.\n\nThe bridge between your AI and your Cortex is the synapse — Graphnosis\'s background process, named after the connections that pass signals between neurons in the brain. It only fires when your Cortex is unlocked and the app is running.\n\nBecause your files are already indexed inside Graphnosis, your AI doesn\'t have to re-parse the same PDFs, notes, or spreadsheets every prompt. Faster, more consistent, less token cost. Keep the app running with your Cortex unlocked while you use your AI client — closing the app means closing the memory.',
  },
  {
    title: 'Your local, encrypted, private memory',
    body: 'Your memory never leaves your device automatically. When your AI does recall something from your Graphnosis Cortex, only the relevant excerpt travels to that AI service — nothing more. Your Cortex files are passphrase-protected, so even if you ever choose to share or move them, they remain yours alone.',
  },
  {
    title: 'Your local encrypted memory.\nIndexed for every AI tool.',
    body: 'Pick where you want to start — connect an AI client, set up mobile access, or wire in a data source. You can always do this later from Settings.',
    connectArea: true,
  },
];

function startTour(): void {
  if (localStorage.getItem('graphnosis_tour_done')) return;

  let currentStep = 0;

  function completeTour(): void {
    localStorage.setItem('graphnosis_tour_done', '1');
    els.tourOverlay.classList.add('hidden');
  }

  function renderTourStep(): void {
    const step = TOUR_STEPS[currentStep];
    if (!step) return;
    const total = TOUR_STEPS.length;
    const isFirst = currentStep === 0;
    const isLast = currentStep === total - 1;

    // Title and body
    els.tourTitle.textContent = step.title;
    els.tourBody.textContent = step.body;

    // Logo — shown only on the first step
    const tourLogo = document.getElementById('tour-logo');
    if (tourLogo) tourLogo.classList.toggle('hidden', !isFirst);

    // Connect area — shown only on the final step
    if (step.connectArea) {
      els.tourConnectArea.classList.add('visible');
      els.tourConnectArea.innerHTML = `
        <div class="tour-connect-label">Connect an AI client</div>
        <div class="tour-connect-group" id="tca-clients"></div>
        <div class="tour-connect-label" style="margin-top:8px;">Mobile &amp; remote access</div>
        <div class="tour-connect-group" id="tca-mobile"></div>
        <div class="tour-connect-label" style="margin-top:8px;">Data connectors</div>
        <div class="tour-connect-group" id="tca-connectors"></div>`;
      const makeBtn = (label: string, onClick: () => void): HTMLButtonElement => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'tour-connect-btn'; b.textContent = label;
        b.addEventListener('click', () => { completeTour(); onClick(); });
        return b;
      };
      document.getElementById('tca-clients')?.append(
        makeBtn('Claude Desktop', () => openConfigureClientModal('claude-desktop')),
        makeBtn('Claude Code', () => openConfigureClientModal('claude-code')),
        makeBtn('Cursor', () => openConfigureClientModal('cursor')),
      );
      document.getElementById('tca-mobile')?.append(
        makeBtn('📱 Set up mobile access', () => void openMobileWizard()),
      );
      const connectorKinds: Array<[string, string]> = [
        ['rss','RSS'],['github','GitHub'],['slack','Slack'],['trello','Trello'],
        ['linear','Linear'],['obsidian','Obsidian'],['gbrain','GBrain'],['ai-context','AI Context Files'],
        ['webhook','Webhook'],
      ];
      connectorKinds.forEach(([kind, label]) => {
        document.getElementById('tca-connectors')?.appendChild(
          makeBtn(label, () => openConnectorSetupModal(kind as ConnectorKind)),
        );
      });
    } else {
      els.tourConnectArea.classList.remove('visible');
      els.tourConnectArea.innerHTML = '';
    }

    // Step dots
    els.tourStepIndicator.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('span');
      dot.className = 'tour-dot' + (i === currentStep ? ' active' : '');
      els.tourStepIndicator.appendChild(dot);
    }

    // Back button — hidden on first step
    els.tourPrev.classList.toggle('hidden', isFirst);

    // Next button — changes label on last step
    if (isLast) {
      els.tourNext.textContent = 'Get started →';
    } else {
      els.tourNext.textContent = 'Next →';
    }
  }

  // Wire up button handlers (idempotent — event listeners are attached once)
  els.tourSkip.onclick = () => completeTour();

  els.tourPrev.onclick = () => {
    if (currentStep > 0) {
      currentStep--;
      renderTourStep();
    }
  };

  els.tourNext.onclick = () => {
    if (currentStep < TOUR_STEPS.length - 1) {
      currentStep++;
      renderTourStep();
    } else {
      completeTour();
    }
  };

  // Render first step and show the overlay
  renderTourStep();
  els.tourOverlay.classList.remove('hidden');
}

// ── Recovery phrase modal ─────────────────────────────────────────────────
//
// Shown exactly once, right after a brand-new cortex is created. The Tauri
// Rust layer reads `.recovery-pending` from the cortex dir immediately after
// the sidecar IPC socket appears, then emits `graphnosis://cortex.created`
// with the plaintext 24-word phrase as the payload. We show the phrase in a
// 4×6 grid and require the user to tick an acknowledgment box before they
// can continue.

function showRecoveryPhraseModal(phrase: string): void {
  const modal = document.getElementById('recovery-phrase-modal') as HTMLDivElement | null;
  const grid = document.getElementById('recovery-phrase-grid') as HTMLDivElement | null;
  const ack = document.getElementById('recovery-phrase-ack') as HTMLInputElement | null;
  const closeBtn = document.getElementById('btn-recovery-phrase-close') as HTMLButtonElement | null;
  if (!modal || !grid || !ack || !closeBtn) return;

  // Populate the 4×6 grid
  const words = phrase.trim().split(/\s+/);
  grid.innerHTML = words.map((w, i) =>
    `<div class="recovery-phrase-word">` +
    `<span class="word-num">${i + 1}.</span>` +
    `<span class="word-text">${w}</span>` +
    `</div>`,
  ).join('');

  ack.checked = false;
  closeBtn.disabled = true;

  ack.onchange = () => {
    closeBtn.disabled = !ack.checked;
  };

  closeBtn.onclick = () => {
    modal.classList.add('hidden');
    // Flush any unlock-transition that was deferred by render() while the
    // modal was on screen. This is what makes the modal a true GATE on the
    // lock screen: dismissing it now transitions to the app view.
    if (queuedStatusAfterRecovery) {
      const s = queuedStatusAfterRecovery;
      queuedStatusAfterRecovery = null;
      render(s);
    }
  };

  modal.classList.remove('hidden');
}

void listen<string>('graphnosis://cortex-created', (evt) => {
  showRecoveryPhraseModal(evt.payload);
});

// ── Set-new-passphrase modal (fires after recovery-mode unlock) ─────────
//
// The Rust side emits `graphnosis://unlocked-via-recovery` immediately after
// a successful `unlock_cortex_with_recovery` call. We show a modal offering
// the user a chance to set a fresh passphrase so they can unlock normally
// next time. They can skip — the existing (forgotten) passphrase keeps
// working in theory, and the recovery phrase remains their fallback.

function showSetNewPassphraseModal(): void {
  const modal = document.getElementById('set-new-passphrase-modal') as HTMLDivElement | null;
  const newInput = document.getElementById('snp-new') as HTMLInputElement | null;
  const confirmInput = document.getElementById('snp-confirm') as HTMLInputElement | null;
  const errorEl = document.getElementById('snp-error') as HTMLParagraphElement | null;
  const statusEl = document.getElementById('snp-status') as HTMLElement | null;
  const skipBtn = document.getElementById('btn-snp-skip') as HTMLButtonElement | null;
  const saveBtn = document.getElementById('btn-snp-save') as HTMLButtonElement | null;
  if (!modal || !newInput || !confirmInput || !errorEl || !statusEl || !skipBtn || !saveBtn) return;

  newInput.value = '';
  confirmInput.value = '';
  errorEl.textContent = '';
  errorEl.classList.add('hidden');
  statusEl.textContent = '';
  saveBtn.disabled = false;
  skipBtn.disabled = false;

  const close = (): void => { modal.classList.add('hidden'); };

  skipBtn.onclick = close;

  saveBtn.onclick = async () => {
    const np = newInput.value;
    const cp = confirmInput.value;
    errorEl.classList.add('hidden');
    if (np.length < 8) {
      errorEl.textContent = 'Passphrase must be at least 8 characters.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (np !== cp) {
      errorEl.textContent = 'The two entries don\'t match.';
      errorEl.classList.remove('hidden');
      return;
    }
    // Optional safety snapshot before mutating master.enc. The operation
    // is atomic + reversible (the recovery phrase still works on the new
    // passphrase since it wraps the same dataKey), but a snapshot adds
    // defense against an unexpected outcome — and master.enc is the file
    // the entire Cortex depends on for unlocking, so paranoia is cheap.
    saveBtn.disabled = true;
    skipBtn.disabled = true;
    statusEl.textContent = 'Offering snapshot…';
    await showSnapshotOffer({
      subtitle:
        "About to rewrap the master key with your new passphrase. The dataKey " +
        "and your encrypted memories are not touched — only master.enc is " +
        "rewritten — but a snapshot gives you a rollback path just in case.",
      confirmLabel: 'Snapshot & Set Passphrase',
    });
    statusEl.textContent = 'Rewrapping master key…';
    try {
      const result = await invoke<{ ok?: boolean; keychainUpdated?: boolean }>(
        'change_passphrase',
        { args: { new_passphrase: np } },
      );
      const kc = result?.keychainUpdated ?? false;
      statusEl.textContent = kc
        ? 'Saved. Keychain updated.'
        : 'Saved. (Keychain update failed — you may be prompted on next launch.)';
      // Tiny delay so the user sees the success message before the modal closes.
      window.setTimeout(close, 1200);
    } catch (e) {
      saveBtn.disabled = false;
      skipBtn.disabled = false;
      statusEl.textContent = '';
      errorEl.textContent = String(e);
      errorEl.classList.remove('hidden');
    }
  };

  modal.classList.remove('hidden');
  newInput.focus();
}

void listen('graphnosis://unlocked-via-recovery', () => {
  // Small delay so the recovery-unlock UI has time to dismiss before the
  // new modal pops up — otherwise we get a flicker through two modals.
  window.setTimeout(showSetNewPassphraseModal, 250);
});

// ── "Forgot passphrase?" recovery unlock flow ─────────────────────────────

{
  const link = document.getElementById('link-forgot-passphrase') as HTMLElement | null;
  const section = document.getElementById('recovery-unlock-section') as HTMLElement | null;
  const cancelBtn = document.getElementById('btn-recovery-cancel') as HTMLButtonElement | null;
  const recoverBtn = document.getElementById('btn-recovery-unlock') as HTMLButtonElement | null;
  const phraseInput = document.getElementById('recovery-phrase-input') as HTMLTextAreaElement | null;
  const cortexDirInput = document.getElementById('cortex-dir') as HTMLInputElement | null;
  const unlockStatus = document.getElementById('unlock-status') as HTMLElement | null;

  link?.addEventListener('click', (e) => {
    e.preventDefault();
    section?.classList.toggle('hidden');
    if (!section?.classList.contains('hidden')) {
      phraseInput?.focus();
    }
  });

  cancelBtn?.addEventListener('click', () => {
    section?.classList.add('hidden');
    if (phraseInput) phraseInput.value = '';
  });

  recoverBtn?.addEventListener('click', async () => {
    const cortexDir = cortexDirInput?.value.trim() ?? '';
    const phrase = phraseInput?.value.trim() ?? '';
    if (!cortexDir) {
      if (unlockStatus) unlockStatus.textContent = 'Choose a Cortex folder first.';
      return;
    }
    const wordCount = phrase.split(/\s+/).filter(Boolean).length;
    if (wordCount !== 24) {
      if (unlockStatus) unlockStatus.textContent = `Recovery phrase must be exactly 24 words (you entered ${wordCount}).`;
      return;
    }
    if (recoverBtn) recoverBtn.disabled = true;
    if (unlockStatus) unlockStatus.textContent = 'Recovering…';
    // Reuse the same indeterminate progress bar as the normal unlock path —
    // recovery-mode unlock is similar work plus the recovery.enc unwrap.
    const progressBar = document.getElementById('unlock-progress');
    progressBar?.classList.remove('hidden');
    try {
      const result = await invoke<StatusSnapshot>('unlock_cortex_with_recovery', {
        args: { cortex_dir: cortexDir, recovery_phrase: phrase },
      });
      // Persist for the next launch — same flow as the passphrase path.
      rememberCortexDir(cortexDir);
      if (phraseInput) phraseInput.value = '';
      section?.classList.add('hidden');
      render(result);
    } catch (e) {
      if (unlockStatus) unlockStatus.textContent = String(e);
    } finally {
      if (recoverBtn) recoverBtn.disabled = false;
      progressBar?.classList.add('hidden');
    }
  });
}

// ── Last-used cortex memory ─────────────────────────────────────────────
//
// Pre-fill the cortex-folder input on the unlock screen with the path the
// user most recently unlocked. This is purely a UX convenience — the path
// itself is not a secret, so localStorage is fine. (The passphrase lives in
// the OS keychain via the Rust side; that's the real secret.)
//
// Written on every successful unlock (passphrase OR recovery-phrase path).
// Read on app launch and immediately injected into the input so the user
// just types their passphrase and hits Enter on a returning session.
const LAST_CORTEX_KEY = 'graphnosis_last_cortex_dir';

function rememberCortexDir(dir: string | null | undefined): void {
  if (!dir) return;
  try { localStorage.setItem(LAST_CORTEX_KEY, dir); } catch { /* private mode / quota */ }
}

function prefillLastCortexDir(): void {
  try {
    const last = localStorage.getItem(LAST_CORTEX_KEY);
    if (last && !els.cortexDir.value.trim()) {
      els.cortexDir.value = last;
      // Path is already filled — the next thing the user needs to type is
      // their passphrase. Focus that input so they can just start typing
      // and hit Enter, skipping the click-into-passphrase-field step.
      window.setTimeout(() => els.passphrase.focus(), 0);
      // Also probe whether Touch ID is set up for this cortex. If yes,
      // surface the button alongside the passphrase Unlock button.
      void refreshBiometricButton(last);
      return;
    }
    // No last-used path — suggest a sensible default (`~/GraphnosisCortex`).
    // The folder doesn't need to exist yet; sidecar.host.open() creates it
    // on first unlock. Pre-filling spares brand-new users from having to
    // click Choose and pick a folder name before they can even type a
    // passphrase.
    if (!els.cortexDir.value.trim()) {
      void (async () => {
        try {
          const suggested = await invoke<string>('suggest_cortex_path');
          if (suggested && !els.cortexDir.value.trim()) {
            els.cortexDir.value = suggested;
            window.setTimeout(() => els.passphrase.focus(), 0);
          }
        } catch { /* fine — leave input empty + show placeholder */ }
      })();
    }
  } catch { /* fine */ }
}

// ── Touch ID button (lock screen) ─────────────────────────────────────────
//
// Shown when:
//   1. The cortex-folder input has a path (otherwise we don't know what
//      to unlock — biometric is per-cortex via the stored passphrase).
//   2. macOS Touch ID is set up (Swift sidecar's --check returns 0).
//   3. We have a stored passphrase in the Keychain for that path.
//
// Click → Rust spawns the Swift sidecar in --prompt mode → user touches
// the sensor → on success, Rust reads the passphrase and runs the regular
// unlock_cortex flow. On cancel/failure, button re-enables and user can
// fall back to typing the passphrase.

async function refreshBiometricButton(cortexDir: string): Promise<void> {
  // Two UI surfaces share the same availability state:
  //   - The inline fingerprint icon inside the passphrase field's right edge
  //   - The "Unlock with Touch ID →" hint right-justified on the label row
  // Both hide together when biometric isn't ready.
  const inlineBtn = document.getElementById('btn-touchid-inline') as HTMLButtonElement | null;
  const hint = document.getElementById('touchid-hint') as HTMLElement | null;
  if (!cortexDir.trim()) {
    inlineBtn?.classList.add('hidden');
    hint?.classList.add('hidden');
    return;
  }
  try {
    const available = await invoke<boolean>('biometric_available', { cortexDir });
    inlineBtn?.classList.toggle('hidden', !available);
    hint?.classList.toggle('hidden', !available);
  } catch {
    // Command failure → hide the Touch ID affordances. No console log —
    // the user can see the button isn't there, and there's nothing they
    // can do client-side to fix the underlying issue.
    inlineBtn?.classList.add('hidden');
    hint?.classList.add('hidden');
  }
}

// ── Mobile & Remote Access wizard ─────────────────────────────────────────

interface MobileConnectionInfo {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
  localIps: string[];
  tailscaleIp?: string;
}

let mobileConnInfo: MobileConnectionInfo | null = null;
let mobileWizardStep = 0;
let mobileTokenRevealed = false;

function $m<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function mobileSetStep(step: number): void {
  mobileWizardStep = step;

  // Update dots
  const dots = document.querySelectorAll<HTMLElement>('.wizard-step-dot');
  dots.forEach((d, i) => {
    d.classList.toggle('done', i < step);
    d.classList.toggle('active', i === step);
  });
  const label = $m<HTMLSpanElement>('mobile-step-label');
  if (label) label.textContent = `Step ${step + 1} of 3`;

  // Show/hide steps
  for (let i = 0; i < 3; i++) {
    $m<HTMLDivElement>(`mobile-step-${i}`)?.classList.toggle('active', i === step);
  }

  // Back / Next / Close button visibility
  const btnBack = $m<HTMLButtonElement>('btn-mobile-back');
  const btnNext = $m<HTMLButtonElement>('btn-mobile-next');
  const btnClose = $m<HTMLButtonElement>('btn-mobile-close');
  if (btnBack) btnBack.classList.toggle('hidden', step === 0);
  if (btnNext) {
    btnNext.classList.toggle('hidden', step === 2);
    btnNext.textContent = step === 0 ? 'Save & Next' : 'Next';
    btnNext.disabled = step === 0 && !($m<HTMLInputElement>('mobile-bridge-enabled')?.checked);
  }
  if (btnClose) btnClose.textContent = step === 2 ? 'Done' : 'Cancel';

  if (step === 1) renderMobileStep1();
  if (step === 2) renderMobileStep2();
}

function renderMobileStep1(): void {
  const info = mobileConnInfo;
  if (!info) return;
  const ipList = $m<HTMLDivElement>('mobile-ip-list');
  const tailTip = $m<HTMLDivElement>('mobile-tailscale-tip');
  const noTailTip = $m<HTMLDivElement>('mobile-no-tailscale-tip');
  if (!ipList) return;
  ipList.innerHTML = '';
  if (info.tailscaleIp) {
    const row = document.createElement('div');
    row.className = 'mobile-ip-row';
    row.innerHTML = `<span class="mobile-ip-tag tailscale">Tailscale</span><strong>${info.tailscaleIp}</strong>`;
    ipList.appendChild(row);
    if (tailTip) tailTip.style.display = '';
    if (noTailTip) noTailTip.style.display = 'none';
  } else {
    if (tailTip) tailTip.style.display = 'none';
    if (noTailTip) noTailTip.style.display = '';
  }
  for (const ip of info.localIps) {
    const row = document.createElement('div');
    row.className = 'mobile-ip-row';
    row.innerHTML = `<span class="mobile-ip-tag">LAN</span>${ip}`;
    ipList.appendChild(row);
  }
  if (info.localIps.length === 0 && !info.tailscaleIp) {
    ipList.innerHTML = '<p class="subtitle" style="font-size:14px;">No network interfaces detected (VPN-only or no network).</p>';
  }
}

function renderMobileStep2(): void {
  const info = mobileConnInfo;
  if (!info) return;
  const preferredIp = info.tailscaleIp ?? info.localIps[0] ?? '127.0.0.1';
  const url = `http://${preferredIp}:${info.port}`;
  const urlEl = $m<HTMLSpanElement>('mobile-mcp-url');
  const tokEl = $m<HTMLSpanElement>('mobile-mcp-token');
  if (urlEl) urlEl.textContent = url;
  if (tokEl) {
    tokEl.textContent = mobileTokenRevealed ? info.token : info.token.replace(/./g, '•');
    tokEl.setAttribute('data-token', info.token);
  }
  const footerNote = $m<HTMLSpanElement>('mobile-footer-note');
  if (footerNote) footerNote.textContent = 'Changes take effect the next time the Cortex is unlocked.';

  // VS Code / Copilot Chat config snippet. Always uses 127.0.0.1 — the
  // local bridge is always on loopback regardless of the mobile bind setting.
  const vscodeEl = $m<HTMLSpanElement>('mobile-vscode-config');
  if (vscodeEl && info.token) {
    const mcpJson = JSON.stringify(
      {
        servers: {
          graphnosis: {
            type: 'http',
            url: `http://127.0.0.1:${info.port}/mcp`,
            headers: { Authorization: `Bearer ${info.token}` },
          },
        },
      },
      null,
      2,
    );
    vscodeEl.textContent = mcpJson;
  }
}

function mobileCopyBtn(btn: HTMLButtonElement, text: string): void {
  void navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('copied');
    }, 1800);
  });
}

async function openMobileWizard(): Promise<void> {
  const modal = $m<HTMLDivElement>('mobile-setup-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  mobileTokenRevealed = false;
  const footerNote = $m<HTMLSpanElement>('mobile-footer-note');

  try {
    mobileConnInfo = (await invoke('get_mobile_connection_info')) as MobileConnectionInfo;
  } catch (e) {
    if (footerNote) footerNote.textContent = `Error: ${e}`;
    return;
  }

  // Populate step 0 fields from current settings
  const enabledCb = $m<HTMLInputElement>('mobile-bridge-enabled');
  const badge = $m<HTMLElement>('mobile-bridge-badge');
  const portInput = $m<HTMLInputElement>('mobile-bridge-port');
  const hostSelect = $m<HTMLSelectElement>('mobile-bridge-host');
  const portRow = $m<HTMLDivElement>('mobile-port-row');
  const note0 = $m<HTMLParagraphElement>('mobile-step0-note');

  if (enabledCb) enabledCb.checked = mobileConnInfo.enabled;
  if (badge) {
    badge.textContent = mobileConnInfo.enabled ? 'On' : 'Off';
    badge.className = `mobile-badge ${mobileConnInfo.enabled ? 'on' : 'off'}`;
  }
  if (portInput) portInput.value = String(mobileConnInfo.port);
  if (hostSelect) hostSelect.value = mobileConnInfo.host;
  if (portRow) portRow.style.display = mobileConnInfo.enabled ? '' : 'none';
  if (note0) note0.textContent = mobileConnInfo.enabled && mobileConnInfo.token
    ? 'Bridge is active. You can skip to Step 3 to copy connection details.'
    : '';

  // If already enabled and has a token, jump straight to connection details.
  const startStep = (mobileConnInfo.enabled && mobileConnInfo.token) ? 2 : 0;
  mobileSetStep(startStep);
}

// Wire up the mobile wizard once DOM is ready.
{
  document.getElementById('btn-mobile-setup')?.addEventListener('click', () => {
    void openMobileWizard();
  });

  document.getElementById('btn-mobile-close')?.addEventListener('click', () => {
    $m<HTMLDivElement>('mobile-setup-modal')?.classList.add('hidden');
  });

  document.getElementById('btn-mobile-back')?.addEventListener('click', () => {
    if (mobileWizardStep > 0) mobileSetStep(mobileWizardStep - 1);
  });

  document.getElementById('btn-mobile-next')?.addEventListener('click', async () => {
    if (mobileWizardStep === 0) {
      // Persist the enable/port/host settings before advancing.
      const enabledCb = $m<HTMLInputElement>('mobile-bridge-enabled');
      const portInput = $m<HTMLInputElement>('mobile-bridge-port');
      const hostSelect = $m<HTMLSelectElement>('mobile-bridge-host');
      const footerNote = $m<HTMLSpanElement>('mobile-footer-note');
      const btn = $m<HTMLButtonElement>('btn-mobile-next');
      if (btn) btn.disabled = true;
      try {
        const patch = {
          mobile: {
            httpBridge: {
              enabled: enabledCb?.checked ?? false,
              port: parseInt(portInput?.value ?? '3457', 10),
              host: hostSelect?.value ?? '127.0.0.1',
            },
          },
        };
        const updated = (await invoke('update_settings', { settings: patch })) as MobileConnectionInfo & { mobile?: { httpBridge?: MobileConnectionInfo } };
        // Re-fetch to get the auto-generated token.
        mobileConnInfo = (await invoke('get_mobile_connection_info')) as MobileConnectionInfo;
      } catch (e) {
        if (footerNote) footerNote.textContent = `Save failed: ${e}`;
        if (btn) btn.disabled = false;
        return;
      }
      if (btn) btn.disabled = false;
    }
    mobileSetStep(mobileWizardStep + 1);
  });

  // Toggle reveal for the token field
  document.getElementById('mobile-token-reveal')?.addEventListener('click', (e) => {
    mobileTokenRevealed = !mobileTokenRevealed;
    const btn = e.currentTarget as HTMLButtonElement;
    btn.textContent = mobileTokenRevealed ? 'Hide' : 'Show';
    const tokEl = $m<HTMLSpanElement>('mobile-mcp-token');
    const token = tokEl?.getAttribute('data-token') ?? '';
    if (tokEl) tokEl.textContent = mobileTokenRevealed ? token : token.replace(/./g, '•');
  });

  // Enable toggle shows/hides port row
  document.getElementById('mobile-bridge-enabled')?.addEventListener('change', (e) => {
    const cb = e.currentTarget as HTMLInputElement;
    const portRow = $m<HTMLDivElement>('mobile-port-row');
    const badge = $m<HTMLElement>('mobile-bridge-badge');
    const btnNext = $m<HTMLButtonElement>('btn-mobile-next');
    if (portRow) portRow.style.display = cb.checked ? '' : 'none';
    if (badge) {
      badge.textContent = cb.checked ? 'On' : 'Off';
      badge.className = `mobile-badge ${cb.checked ? 'on' : 'off'}`;
    }
    if (btnNext && mobileWizardStep === 0) btnNext.disabled = !cb.checked;
  });

  // Copy buttons (static delegation). Checks data-token attribute first
  // (for the obfuscated token field), then falls back to textContent.
  document.getElementById('mobile-setup-modal')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.copy-btn[data-copy-target]');
    if (!btn) return;
    const targetId = btn.getAttribute('data-copy-target')!;
    const target = document.getElementById(targetId);
    if (!target) return;
    const text = target.getAttribute('data-token') ?? target.textContent ?? '';
    mobileCopyBtn(btn, text);
  });

  // VS Code config copy button — copies the full .vscode/mcp.json snippet.
  document.getElementById('btn-copy-vscode-config')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const text = document.getElementById('mobile-vscode-config')?.textContent ?? '';
    if (text) mobileCopyBtn(btn, text);
  });

  // "Install extension" — opens VS Code Marketplace page.
  document.getElementById('btn-open-vscode-extension')?.addEventListener('click', () => {
    void invoke('plugin:opener|open_url', {
      url: 'https://marketplace.visualstudio.com/items?itemName=nehloo-interactive.graphnosis',
    });
  });

  // "Copy token" — copies just the bearer token for pasting into VS Code settings.
  document.getElementById('btn-copy-vscode-token')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const token = mobileConnInfo?.token ?? '';
    if (token) mobileCopyBtn(btn, token);
  });

  // Tailscale link → open external browser
  document.getElementById('link-tailscale')?.addEventListener('click', (e) => {
    e.preventDefault();
    void invoke('open_external_url', { url: 'https://tailscale.com/download' });
  });
}

// ── Custom engram picker (drops DOWN, not OS-default UP) ────────────────────
//
// Replaces the native <select> open behavior with a custom button +
// absolute-positioned dropdown. The hidden native <select> stays in DOM
// as the source of truth so existing `.value` assignments and `change`
// listeners across the codebase keep working unchanged.
//
// Sync strategy:
//   - Native select INNER HTML changes (refreshAtlasView repopulates) →
//     MutationObserver triggers re-render of the custom dropdown
//   - Native select VALUE changes (atlasActiveGraph rebind) → property
//     setter intercept delegates to the prototype getter/setter and then
//     fires our re-render hook
//   - User clicks a custom option → set native select.value (via our
//     intercept) + dispatch 'change' event → all listeners fire normally

function installCustomEngramPicker(): void {
  const sel = document.getElementById('atlas-graph-picker') as HTMLSelectElement | null;
  if (!sel || sel.dataset['customDropdownInstalled'] === '1') return;
  sel.dataset['customDropdownInstalled'] = '1';

  // 1. Build the wrapper + button + dropdown around the existing select.
  const wrap = document.createElement('span');
  wrap.className = 'engram-picker-wrap';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'header-engram-picker';
  btn.id = 'engram-picker-button';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `<span class="engram-picker-button-label">—</span><span class="engram-picker-chevron" aria-hidden="true">▾</span>`;
  const dropdown = document.createElement('div');
  dropdown.className = 'engram-picker-dropdown hidden';
  dropdown.id = 'engram-picker-dropdown';
  dropdown.setAttribute('role', 'listbox');

  sel.parentElement?.insertBefore(wrap, sel);
  wrap.appendChild(btn);
  wrap.appendChild(dropdown);
  wrap.appendChild(sel);
  // Hide the native select but keep it in DOM as the data source.
  sel.style.display = 'none';

  const labelEl = btn.querySelector('.engram-picker-button-label') as HTMLSpanElement;

  // 2. Render dropdown options from the current state of the native select.
  const renderOptions = (): void => {
    const opts = Array.from(sel.options);
    dropdown.innerHTML = opts.map((o) => `
      <button type="button" class="engram-picker-option${o.value === sel.value ? ' selected' : ''}" data-value="${escapeHtml(o.value)}" role="option" aria-selected="${o.value === sel.value}">${escapeHtml(o.text)}</button>
    `).join('');
    const curOpt = opts.find((o) => o.value === sel.value) ?? opts[0];
    labelEl.textContent = curOpt?.text ?? '—';
  };

  // 3. Intercept `.value` setter so external assignments (`sel.value = X`)
  //    propagate to our custom render. The native getter/setter on the
  //    prototype is delegated to — we just add a side effect on set.
  const proto = HTMLSelectElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.get && desc?.set) {
    Object.defineProperty(sel, 'value', {
      get(): string { return desc.get!.call(sel) as string; },
      set(v: string) {
        desc.set!.call(sel, v);
        renderOptions();
      },
      configurable: true,
    });
  }

  // 4. Watch for innerHTML changes — refreshAtlasView rebuilds options
  //    by setting select.innerHTML directly; we need to re-render too.
  new MutationObserver(renderOptions).observe(sel, { childList: true });

  // 5. Toggle dropdown on button click.
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden');
    btn.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      // Scroll the currently-selected option into view on open.
      dropdown.querySelector('.engram-picker-option.selected')?.scrollIntoView({ block: 'nearest' });
    }
  });

  // 6. Option click → set value, dispatch change, close.
  dropdown.addEventListener('click', (e) => {
    const opt = (e.target as HTMLElement | null)?.closest('.engram-picker-option') as HTMLButtonElement | null;
    if (!opt) return;
    const v = opt.dataset['value'] ?? '';
    sel.value = v;  // intercepted setter re-renders + updates label
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    dropdown.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  });

  // 7. Close on outside click.
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target as Node)) {
      dropdown.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  // 8. Escape closes; Enter/Space on button opens; arrow keys not wired in
  //    v0.6 — basic mouse-driven UX is the priority. Add full keyboard
  //    navigation in a follow-up if anyone asks.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !dropdown.classList.contains('hidden')) {
      dropdown.classList.add('hidden');
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  // 9. Initial paint (in case options are already populated).
  renderOptions();
}

// ── Settings → Connectors panel ─────────────────────────────────────────────
//
// Wires the Settings pane's connectors list + per-kind setup modals to the
// sidecar's connectors.* IPC (via the Tauri commands list_connectors,
// install_connector, remove_connector, trigger_connector_pull,
// get_connector_auth_url). BYO-credentials by design: every kind that needs
// auth (GitHub, Slack, Trello, Linear) takes credentials the user generated
// in that service's developer console — Graphnosis is never in the OAuth
// callback chain. v0.6.1 adds transparent encryption of the credentials
// field at the host I/O boundary; this UI never sees ciphertext.
//
// Connector "kind" determines the modal's body shape (different services
// need different inputs). Six kinds shipped: rss, github, slack, trello,
// linear, webhook.

type ConnectorKind = 'webhook' | 'rss' | 'github' | 'slack' | 'trello' | 'linear' | 'obsidian' | 'gbrain' | 'ai-context';

interface ConnectorConfigShape {
  id: string;
  kind: ConnectorKind;
  graphId: string;
  enabled: boolean;
  credentials: Record<string, string>;
  options: Record<string, unknown>;
  lastPulledAt?: number;
  lastError?: string;
}

interface ConnectorStatus {
  id: string;
  kind: string;
  enabled: boolean;
  lastPulledAt?: number;
  lastError?: string;
  eventsTotal: number;
  pulling: boolean;
}

const CONNECTOR_KIND_LABEL: Record<ConnectorKind, string> = {
  rss: 'RSS', github: 'GitHub', slack: 'Slack',
  trello: 'Trello', linear: 'Linear', webhook: 'Webhook',
  obsidian: 'Obsidian', gbrain: 'GBrain', 'ai-context': 'AI Context Files',
};
const CONNECTOR_KIND_GLYPH: Record<ConnectorKind, string> = {
  rss: '📰', github: '🐙', slack: '💬',
  trello: '📋', linear: '📐', webhook: '🪝',
  obsidian: '🔮', gbrain: '🧠', 'ai-context': '📎',
};

async function refreshConnectorsList(): Promise<void> {
  const wrap = document.getElementById('connectors-list');
  if (!wrap) return;
  try {
    const res = await invoke<{ configs: ConnectorConfigShape[]; statuses: ConnectorStatus[] }>(
      'list_connectors',
    );
    if (!res.configs.length) {
      wrap.innerHTML = `
        <div class="connector-row" style="grid-template-columns: 1fr;">
          <span style="color: var(--fg-dim); font-size: 14px;">
            No connectors installed yet. Pick one below to start auto-ingesting from your existing tools.
          </span>
        </div>`;
      return;
    }
    const statusById = new Map(res.statuses.map((s) => [s.id, s]));
    wrap.innerHTML = res.configs
      .map((cfg) => renderConnectorRow(cfg, statusById.get(cfg.id)))
      .join('');
    // Wire row buttons after render
    wrap.querySelectorAll<HTMLButtonElement>('button[data-connector-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset['connectorAction'];
        const id = btn.dataset['connectorId'];
        if (!id) return;
        if (action === 'pull') void handleConnectorPull(id, btn);
        else if (action === 'remove') void handleConnectorRemove(id);
        else if (action === 'edit') void handleConnectorEdit(id, res.configs);
      });
    });
  } catch (e) {
    wrap.innerHTML = `<div class="connector-row" style="grid-template-columns: 1fr;">
      <span style="color: #f87171; font-size: 14px;">Couldn't load connectors: ${escapeHtml(String(e))}</span>
    </div>`;
  }
}

function renderConnectorRow(cfg: ConnectorConfigShape, status?: ConnectorStatus): string {
  const glyph = CONNECTOR_KIND_GLYPH[cfg.kind] ?? '🔌';
  const label = CONNECTOR_KIND_LABEL[cfg.kind] ?? cfg.kind;
  let statusKind: 'enabled' | 'disabled' | 'error' | 'pulling';
  let statusLabel: string;
  if (status?.pulling) { statusKind = 'pulling'; statusLabel = 'pulling…'; }
  else if (cfg.lastError) { statusKind = 'error'; statusLabel = 'error'; }
  else if (cfg.enabled) { statusKind = 'enabled'; statusLabel = 'enabled'; }
  else { statusKind = 'disabled'; statusLabel = 'disabled'; }

  const lastPullStr = cfg.lastPulledAt
    ? `last pulled ${relativeTimeShort(cfg.lastPulledAt)}`
    : 'never pulled';
  const events = status?.eventsTotal ?? 0;
  const eventsStr = events > 0 ? ` · ${events} event${events === 1 ? '' : 's'} this session` : '';
  const errorStr = cfg.lastError ? ` · ${escapeHtml(cfg.lastError)}` : '';

  return `
    <div class="connector-row" data-connector-id="${escapeHtml(cfg.id)}">
      <span class="connector-row-kind" aria-hidden="true">${glyph}</span>
      <div class="connector-row-body">
        <div class="connector-row-title">
          <span class="connector-row-name">${escapeHtml(label)} · ${escapeHtml(cfg.id)}</span>
          <span class="connector-row-status ${statusKind}">${escapeHtml(statusLabel)}</span>
        </div>
        <span class="connector-row-meta">
          → engram ${escapeHtml(cfg.graphId)} · ${escapeHtml(lastPullStr)}${escapeHtml(eventsStr)}${errorStr}
        </span>
      </div>
      <div class="connector-row-actions">
        ${cfg.kind !== 'webhook' ? `<button data-connector-action="pull" data-connector-id="${escapeHtml(cfg.id)}">Pull now</button>` : ''}
        <button data-connector-action="edit" data-connector-id="${escapeHtml(cfg.id)}">Edit</button>
        <button data-connector-action="remove" data-connector-id="${escapeHtml(cfg.id)}" class="danger">Remove</button>
      </div>
    </div>`;
}

function relativeTimeShort(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.max(1, Math.floor(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

async function handleConnectorPull(id: string, btn: HTMLButtonElement): Promise<void> {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Pulling…';
  try {
    const res = await invoke<{ eventsIngested: number }>('trigger_connector_pull', { id });
    const tid = addIngestToast(`Pulled ${id}`, `${res.eventsIngested} new event(s) ingested`);
    finishIngestToast(tid, 'success', `${res.eventsIngested} new event(s) ingested`);
    await refreshConnectorsList();
  } catch (e) {
    const tid = addIngestToast(`Pull failed: ${id}`, String(e));
    finishIngestToast(tid, 'error', String(e));
  } finally {
    btn.disabled = false;
    if (originalText) btn.textContent = originalText;
  }
}

async function handleConnectorRemove(id: string): Promise<void> {
  if (!confirm(`Remove connector "${id}"? Its credentials will be deleted and it'll stop pulling. Already-ingested events stay in your engram.`)) return;
  try {
    await invoke('remove_connector', { id });
    await refreshConnectorsList();
    const tid = addIngestToast(`Removed connector "${id}"`, 'Credentials deleted; engram content untouched');
    finishIngestToast(tid, 'success', 'Credentials deleted; engram content untouched');
  } catch (e) {
    const tid = addIngestToast(`Couldn't remove "${id}"`, String(e));
    finishIngestToast(tid, 'error', String(e));
  }
}

async function handleConnectorEdit(id: string, configs: ConnectorConfigShape[]): Promise<void> {
  const cfg = configs.find((c) => c.id === id);
  if (!cfg) return;
  openConnectorSetupModal(cfg.kind, cfg);
}

// ── Setup modal ────────────────────────────────────────────────────────────

let pendingConnectorEditId: string | null = null;
let pendingConnectorKind: ConnectorKind | null = null;

function openConnectorSetupModal(kind: ConnectorKind, existing?: ConnectorConfigShape): void {
  pendingConnectorEditId = existing?.id ?? null;
  pendingConnectorKind = kind;
  const modal = document.getElementById('connector-setup-modal');
  const title = document.getElementById('connector-setup-title');
  const subtitle = document.getElementById('connector-setup-subtitle');
  const body = document.getElementById('connector-setup-body');
  if (!modal || !title || !subtitle || !body) return;
  title.textContent = (existing ? 'Edit ' : 'Add ') + CONNECTOR_KIND_LABEL[kind] + ' connector';
  subtitle.textContent = connectorSubtitleFor(kind);
  body.innerHTML = renderConnectorSetupBody(kind, existing);
  // Populate engram dropdown after body renders
  populateEngramDropdown('connector-graphid', existing?.graphId);
  // Wire folder browse button for ai-context connector
  document.getElementById('connector-aicontext-browse')?.addEventListener('click', async () => {
    const picked = await invoke<string[]>('pick_folders');
    if (!picked.length) return;
    const ta = document.getElementById('connector-aicontext-paths') as HTMLTextAreaElement | null;
    if (!ta) return;
    const existing = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...picked])];
    ta.value = merged.join('\n');
  });
  modal.classList.remove('hidden');
}

function connectorSubtitleFor(kind: ConnectorKind): string {
  switch (kind) {
    case 'webhook': return 'Receive POSTed events from Zapier, IFTTT, custom scripts, anything.';
    case 'rss': return 'Pull new entries from any RSS or Atom feed on a schedule.';
    case 'github': return 'Pull issues, pull requests, and releases from repos you watch.';
    case 'slack': return 'Pull starred items and channel history from your workspace.';
    case 'trello': return 'Pull cards and checklists from boards you choose.';
    case 'linear': return 'Pull issues from your teams with status / priority filters.';
    case 'obsidian': return 'Auto-ingest notes from your local Obsidian vault. No API key needed.';
    case 'gbrain': return 'Auto-ingest notes from your local GBrain repo. No API key needed.';
    case 'ai-context': return 'Index CLAUDE.md, AGENTS.md, .cursorrules and other AI context files from your projects.';
  }
}

function renderConnectorSetupBody(kind: ConnectorKind, existing?: ConnectorConfigShape): string {
  const opts = (existing?.options ?? {}) as Record<string, unknown>;
  const creds = existing?.credentials ?? {};
  const idField = `
    <div class="connector-field">
      <label for="connector-id">Connector ID (slug)</label>
      <input type="text" id="connector-id" placeholder="e.g. my-rss-news" value="${escapeHtml(existing?.id ?? '')}" ${existing ? 'readonly' : ''} />
      <span class="field-hint">${existing ? 'Cannot change after install.' : 'Letters, numbers, hyphens. Auto-generated if blank.'}</span>
    </div>`;
  const graphField = `
    <div class="connector-field">
      <label for="connector-graphid">Target engram</label>
      <select id="connector-graphid"></select>
      <input type="text" id="connector-new-engram-name" placeholder="New engram name…" style="display:none;margin-top:6px;" />
      <span class="field-hint">Ingested events become source nodes in this engram.</span>
    </div>`;
  switch (kind) {
    case 'rss':
      return `
        <div class="connector-help">
          Paste one feed URL per line. Graphnosis dedupes by entry guid/link so re-pulls are no-ops on already-seen entries.
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-rss-feeds">Feed URL(s)</label>
          <textarea id="connector-rss-feeds" placeholder="https://example.com/feed.xml&#10;https://another.com/rss">${escapeHtml(((opts['feeds'] as string[]) ?? []).join('\n'))}</textarea>
        </div>`;
    case 'github':
      return `
        <div class="connector-help">
          <strong>Bring your own Personal Access Token.</strong>
          <ol>
            <li><a href="#" data-extlink="https://github.com/settings/tokens?type=beta">Open GitHub fine-grained tokens →</a></li>
            <li>Create a token with read access to the repos you want indexed.</li>
            <li>Paste it below. Your token never leaves your machine.</li>
          </ol>
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-github-token">Personal Access Token</label>
          <input type="password" id="connector-github-token" placeholder="github_pat_…" value="${escapeHtml(creds['token'] ?? '')}" />
        </div>
        <div class="connector-field">
          <label for="connector-github-repos">Repos to watch (comma-separated)</label>
          <input type="text" id="connector-github-repos" placeholder="owner/repo, another-owner/another-repo" value="${escapeHtml(((opts['repos'] as string[]) ?? []).join(', '))}" />
        </div>
        <div class="connector-field">
          <label>Event types</label>
          <div class="connector-checkboxes">
            <label><input type="checkbox" id="connector-github-issues" ${((opts['issues'] as boolean) ?? true) ? 'checked' : ''} /> Issues</label>
            <label><input type="checkbox" id="connector-github-prs" ${((opts['prs'] as boolean) ?? true) ? 'checked' : ''} /> Pull requests</label>
            <label><input type="checkbox" id="connector-github-releases" ${((opts['releases'] as boolean) ?? false) ? 'checked' : ''} /> Releases</label>
          </div>
        </div>`;
    case 'slack':
      return `
        <div class="connector-help">
          <strong>Bring your own Slack app.</strong>
          <ol>
            <li><a href="#" data-extlink="https://api.slack.com/apps">Open api.slack.com/apps →</a></li>
            <li>Create New App → From scratch → name it "Graphnosis".</li>
            <li>OAuth & Permissions → add scopes: <code>channels:history</code>, <code>stars:read</code> (whichever you want indexed).</li>
            <li>Install to Workspace → copy the <strong>Bot Token</strong> (starts with <code>xoxb-</code>) or use a <strong>User Token</strong> (<code>xoxp-</code>).</li>
          </ol>
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-slack-token">Bot or User Token</label>
          <input type="password" id="connector-slack-token" placeholder="xoxb-… or xoxp-…" value="${escapeHtml(creds['token'] ?? '')}" />
        </div>
        <div class="connector-field">
          <label>What to pull</label>
          <div class="connector-checkboxes">
            <label><input type="checkbox" id="connector-slack-starred" ${((opts['starred'] as boolean) ?? true) ? 'checked' : ''} /> Starred items</label>
            <label><input type="checkbox" id="connector-slack-channels" ${((opts['channelHistory'] as boolean) ?? false) ? 'checked' : ''} /> Channel history</label>
          </div>
        </div>`;
    case 'trello':
      return `
        <div class="connector-help">
          <strong>Bring your own Trello API key + token.</strong>
          <ol>
            <li><a href="#" data-extlink="https://trello.com/power-ups/admin">Open trello.com/power-ups/admin →</a> create a new Power-Up.</li>
            <li>API Key tab → generate a Server Token by clicking "Token".</li>
            <li>Paste both below.</li>
          </ol>
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field-row">
          <div class="connector-field">
            <label for="connector-trello-key">API Key</label>
            <input type="password" id="connector-trello-key" value="${escapeHtml(creds['apiKey'] ?? '')}" />
          </div>
          <div class="connector-field">
            <label for="connector-trello-token">Token</label>
            <input type="password" id="connector-trello-token" value="${escapeHtml(creds['token'] ?? '')}" />
          </div>
        </div>
        <div class="connector-field">
          <label for="connector-trello-boards">Board IDs (comma-separated)</label>
          <input type="text" id="connector-trello-boards" placeholder="boardId1, boardId2" value="${escapeHtml(((opts['boardIds'] as string[]) ?? []).join(', '))}" />
          <span class="field-hint">Get board IDs from the URL: trello.com/b/<strong>BOARD_ID</strong>/board-name</span>
        </div>`;
    case 'linear':
      return `
        <div class="connector-help">
          <strong>Bring your own Linear API key.</strong>
          <ol>
            <li><a href="#" data-extlink="https://linear.app/settings/api">Open linear.app/settings/api →</a></li>
            <li>Create a Personal API key. No OAuth flow — Linear's personal keys are first-class.</li>
            <li>Paste below.</li>
          </ol>
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-linear-key">Personal API Key</label>
          <input type="password" id="connector-linear-key" placeholder="lin_api_…" value="${escapeHtml(creds['apiKey'] ?? '')}" />
        </div>
        <div class="connector-field">
          <label for="connector-linear-team">Team key (optional filter)</label>
          <input type="text" id="connector-linear-team" placeholder="ENG, OPS, …" value="${escapeHtml(creds['teamKey'] ?? '')}" />
          <span class="field-hint">Leave blank to pull from every team you have access to.</span>
        </div>`;
    case 'obsidian':
      return `
        <div class="connector-help">
          No API key needed — Graphnosis reads your vault's <code>.md</code> files directly from disk.
          Point it at your vault folder and it will auto-ingest new and modified notes on each pull.
          The <code>.obsidian/</code> config directory is always skipped.
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-obsidian-vault">Vault folder path</label>
          <input type="text" id="connector-obsidian-vault" placeholder="/Users/you/Documents/MyVault" value="${escapeHtml((opts['vaultPath'] as string) ?? '')}" />
          <span class="field-hint">Absolute path to the folder Obsidian uses as your vault.</span>
        </div>`;
    case 'gbrain':
      return `
        <div class="connector-help">
          No API key needed — Graphnosis reads GBrain's <code>.md</code> files directly from your local git repo.
          Point it at the repo folder and it will auto-ingest new and modified notes on each pull.
          GBrain wikilinks (<code>[[wiki/...]]</code>) are preserved in the ingested text.
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-gbrain-repo">GBrain repo path</label>
          <input type="text" id="connector-gbrain-repo" placeholder="/Users/you/Documents/my-gbrain" value="${escapeHtml((opts['repoPath'] as string) ?? '')}" />
          <span class="field-hint">Absolute path to the root of your GBrain git repository.</span>
        </div>`;
    case 'ai-context':
      return `
        <div class="connector-help">
          Indexes standard AI assistant context files across your projects — no credentials required.
          <br /><br />
          <strong>Only these specific filenames are indexed</strong> — no source code or other files are read:
          <code>CLAUDE.md</code>, <code>AGENTS.md</code>, <code>MEMORY.md</code>,
          <code>.cursorrules</code>, <code>.cursor/rules/*.md</code>,
          <code>.github/copilot-instructions.md</code>, <code>GEMINI.md</code>, <code>.windsurfrules</code>.
          <br /><br />
          <strong>~/.claude/CLAUDE.md</strong> is always included automatically.
          <br /><br />
          To index code or all <code>.md</code> files in a repo, use the <strong>GBrain</strong> connector instead.
        </div>
        ${idField}
        ${graphField}
        <div class="connector-field">
          <label for="connector-aicontext-paths">Project folders (one per line)</label>
          <textarea id="connector-aicontext-paths" rows="4" placeholder="/Users/you/Developer/my-project&#10;/Users/you/Developer/another-project">${escapeHtml(((opts['paths'] as string[]) ?? []).join('\n'))}</textarea>
          <button type="button" id="connector-aicontext-browse" class="btn-secondary" style="margin-top:6px;">Browse…</button>
          <span class="field-hint">Point at the root of each project folder. Only the known AI context filenames above will be read — nothing else.</span>
        </div>`;
    case 'webhook': {
      const token = (opts['webhookToken'] as string) || '<generated on save>';
      const url = `http://localhost:3458/webhook/${existing?.id ?? '<id>'}/${token}`;
      return `
        <div class="connector-help">
          Push-only connector. Anything that can POST JSON can send events here:
          Zapier, IFTTT, custom scripts, GitHub Actions, ngrok-exposed webhooks, etc.
          Expected body shape: <code>{ "text": "...", "label": "...", "source": "..." }</code>.
        </div>
        ${idField}
        ${graphField}
        ${existing ? `
        <div class="connector-field">
          <label>Webhook URL</label>
          <div class="connector-webhook-url-row">
            <code id="connector-webhook-url">${escapeHtml(url)}</code>
            <button type="button" id="btn-copy-webhook-url" class="btn-ghost" style="font-size: 15px; padding: 3px 8px;">Copy</button>
          </div>
          <span class="field-hint">Paste into Zapier / IFTTT / your script's webhook target.</span>
        </div>` : `
        <div class="connector-help" style="border-left-color: var(--fg-dim);">
          The unique webhook URL is generated when you click Save.
        </div>`}`;
    }
  }
}

function populateEngramDropdown(selectId: string, selectedId?: string): void {
  const sel = document.getElementById(selectId) as HTMLSelectElement | null;
  if (!sel) return;
  const fallback = selectedId ?? loadedGraphs[0]?.graphId ?? '';
  const nameInput = document.getElementById('connector-new-engram-name') as HTMLInputElement | null;
  sel.innerHTML =
    `<option value="__new__">New Engram…</option>` +
    [...loadedGraphs]
      .sort((a, b) => (a.metadata.displayName ?? a.graphId).localeCompare(b.metadata.displayName ?? b.graphId))
      .map((g) => `<option value="${escapeHtml(g.graphId)}" ${g.graphId === fallback ? 'selected' : ''}>${escapeHtml(g.metadata.displayName ?? g.graphId)}</option>`)
      .join('');
  // Select the fallback (skips __new__ unless no graphs exist)
  if (fallback && Array.from(sel.options).some((o) => o.value === fallback)) sel.value = fallback;
  sel.addEventListener('change', () => {
    if (nameInput) nameInput.style.display = sel.value === '__new__' ? '' : 'none';
  });
}

function collectConnectorFormData(kind: ConnectorKind): Partial<ConnectorConfigShape> | null {
  const id = ($m<HTMLInputElement>('connector-id')?.value || '').trim();
  const graphId = ($m<HTMLSelectElement>('connector-graphid')?.value || '').trim();
  if (!graphId) { alert('Pick a target engram.'); return null; }
  // __new__ is resolved to a real graphId in the save handler before install.
  const credentials: Record<string, string> = {};
  const options: Record<string, unknown> = {};
  switch (kind) {
    case 'rss': {
      const feeds = ($m<HTMLTextAreaElement>('connector-rss-feeds')?.value || '')
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (!feeds.length) { alert('At least one feed URL is required.'); return null; }
      options['feeds'] = feeds;
      break;
    }
    case 'github': {
      const token = $m<HTMLInputElement>('connector-github-token')?.value || '';
      if (!token) { alert('GitHub PAT is required.'); return null; }
      credentials['token'] = token;
      options['repos'] = ($m<HTMLInputElement>('connector-github-repos')?.value || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      options['issues'] = $m<HTMLInputElement>('connector-github-issues')?.checked ?? true;
      options['prs'] = $m<HTMLInputElement>('connector-github-prs')?.checked ?? true;
      options['releases'] = $m<HTMLInputElement>('connector-github-releases')?.checked ?? false;
      break;
    }
    case 'slack': {
      const token = $m<HTMLInputElement>('connector-slack-token')?.value || '';
      if (!token) { alert('Slack token is required.'); return null; }
      credentials['token'] = token;
      options['starred'] = $m<HTMLInputElement>('connector-slack-starred')?.checked ?? true;
      options['channelHistory'] = $m<HTMLInputElement>('connector-slack-channels')?.checked ?? false;
      break;
    }
    case 'trello': {
      const apiKey = $m<HTMLInputElement>('connector-trello-key')?.value || '';
      const token = $m<HTMLInputElement>('connector-trello-token')?.value || '';
      if (!apiKey || !token) { alert('Trello API key + token are both required.'); return null; }
      credentials['apiKey'] = apiKey;
      credentials['token'] = token;
      options['boardIds'] = ($m<HTMLInputElement>('connector-trello-boards')?.value || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      break;
    }
    case 'linear': {
      const apiKey = $m<HTMLInputElement>('connector-linear-key')?.value || '';
      if (!apiKey) { alert('Linear API key is required.'); return null; }
      credentials['apiKey'] = apiKey;
      const team = $m<HTMLInputElement>('connector-linear-team')?.value.trim() || '';
      if (team) credentials['teamKey'] = team;
      break;
    }
    case 'obsidian': {
      const vaultPath = $m<HTMLInputElement>('connector-obsidian-vault')?.value.trim() || '';
      if (!vaultPath) { alert('Vault path is required.'); return null; }
      options['vaultPath'] = vaultPath;
      break;
    }
    case 'gbrain': {
      const repoPath = $m<HTMLInputElement>('connector-gbrain-repo')?.value.trim() || '';
      if (!repoPath) { alert('Repo path is required.'); return null; }
      options['repoPath'] = repoPath;
      break;
    }
    case 'ai-context': {
      const paths = ($m<HTMLTextAreaElement>('connector-aicontext-paths')?.value || '')
        .split('\n').map((s) => s.trim()).filter(Boolean);
      options['paths'] = paths;
      break;
    }
    case 'webhook': {
      // Token auto-generated server-side if missing.
      break;
    }
  }
  return {
    ...(id ? { id } : {}),
    kind,
    graphId,
    enabled: true,
    credentials,
    options,
  };
}

// Wire up the connectors UI.
{
  // Refresh on cortex unlock + when user toggles the Settings tab.
  document.querySelectorAll<HTMLButtonElement>('.btn-add-connector').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset['kind'] as ConnectorKind | undefined;
      if (kind) openConnectorSetupModal(kind);
    });
  });

  document.getElementById('connector-setup-cancel')?.addEventListener('click', () => {
    document.getElementById('connector-setup-modal')?.classList.add('hidden');
    pendingConnectorEditId = null; pendingConnectorKind = null;
  });

  document.getElementById('connector-setup-save')?.addEventListener('click', async () => {
    if (!pendingConnectorKind) return;
    const btn = document.getElementById('connector-setup-save') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const config = collectConnectorFormData(pendingConnectorKind);
      if (!config) { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } return; }
      // Create a new engram on-the-fly when the user picked "New Engram…".
      if (config.graphId === '__new__') {
        const displayName = ($m<HTMLInputElement>('connector-new-engram-name')?.value || '').trim();
        if (!displayName) { alert('Enter a name for the new engram.'); if (btn) { btn.disabled = false; btn.textContent = 'Save'; } return; }
        const newGraphId = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') +
          '-' + Math.random().toString(36).slice(-4);
        await invoke('create_graph_with_template', { graphId: newGraphId, template: 'personal', displayName });
        loadedGraphs = await invoke<GraphWithMetadata[]>('list_graphs_with_metadata');
        syncEngramPicker();
        config.graphId = newGraphId;
      }
      // If editing, force the id from the existing record.
      if (pendingConnectorEditId) config.id = pendingConnectorEditId;
      await invoke('install_connector', { config });
      document.getElementById('connector-setup-modal')?.classList.add('hidden');
      pendingConnectorEditId = null; pendingConnectorKind = null;
      await refreshConnectorsList();
      const tid = addIngestToast('Connector saved', 'Will start pulling on the next interval');
      finishIngestToast(tid, 'success', 'Will start pulling on the next interval');
    } catch (e) {
      const tid = addIngestToast(`Couldn't save connector`, String(e));
      finishIngestToast(tid, 'error', String(e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  });

  // External links in the help panels (deep-links to provider dev consoles).
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement | null)?.closest('a[data-extlink]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const url = a.dataset['extlink'];
    if (url) void invoke('open_external_url', { url });
  });

  // Copy webhook URL button (delegated since the URL row may not exist yet).
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest('#btn-copy-webhook-url') as HTMLButtonElement | null;
    if (!btn) return;
    const code = document.getElementById('connector-webhook-url');
    if (!code) return;
    void navigator.clipboard.writeText(code.textContent ?? '').then(() => {
      const orig = btn.textContent; btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
  });

  // ── Custom engram picker dropdown — forces "drop down" direction ────────
  // The native <select id="atlas-graph-picker"> opens in whatever direction
  // macOS thinks fits (often upward, centered on the selected option). We
  // replace its open behavior with a custom button + absolute-positioned
  // dropdown that always opens DOWNWARD. The native <select> stays in DOM
  // (hidden) as the source of truth — `.value` and `change` event listeners
  // throughout the codebase keep working without modification.
  installCustomEngramPicker();

  // Sources → Settings jump links. The "want this list to grow on its own?"
  // hint above the source list points at the AI-clients and connectors
  // panels in Settings. We switch panes, then scroll the target panel into
  // view with a brief highlight so the user's eye lands on the right place.
  document.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement | null)?.closest('[data-jump-settings]') as HTMLElement | null;
    if (!link) return;
    e.preventDefault();
    const target = link.dataset['jumpSettings'];
    activateMode('settings');
    // Defer scroll so the pane has finished its display:block transition.
    setTimeout(() => {
      const targetId = target === 'connectors' ? 'settings-panel-connectors'
        : target === 'ai-clients' ? 'settings-panel-ai-clients'
        : null;
      if (!targetId) return;
      const panel = document.getElementById(targetId);
      if (!panel) return;
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Brief 1.5s accent ring so the user's eye lands on the right panel.
      panel.style.transition = 'box-shadow 200ms ease';
      panel.style.boxShadow = '0 0 0 2px var(--accent)';
      setTimeout(() => { panel.style.boxShadow = ''; }, 1500);
    }, 50);
  });
}

// Initial state: ask the backend whether we're already unlocked
// (e.g., auto-unlock from keychain in a future iteration).
void (async () => {
  try {
    // Restore the last cortex path before any UI renders so the unlock
    // screen — if that's where we land — already has the path filled in.
    prefillLastCortexDir();
    const status = (await invoke('status')) as StatusSnapshot;
    // If the backend reports an unlocked session, persist its cortex
    // path too (covers the auto-unlock-from-keychain future case).
    if (status.unlocked) rememberCortexDir(status.cortex_dir);
    render(status);
    renderRailGetConnected();
    startTour();
  } catch (e) {
    showError(String(e));
  }
})();

// ── Window drag via Tauri startDragging API ───────────────────────────────
// CSS -webkit-app-region:drag is set on .app-header but Tauri 2 on macOS
// also needs the JS side.  We call startDragging() on primary mousedown on
// the header, skipping interactive children so buttons/inputs still work.
{
  const appHeader = document.querySelector('.app-header') as HTMLElement | null;
  if (appHeader) {
    appHeader.addEventListener('mousedown', (e: MouseEvent) => {
      if (e.button !== 0) return; // only left-button drags
      const t = e.target as HTMLElement;
      if (t.closest('button, input, select, a, [contenteditable]')) return;
      void getCurrentWindow().startDragging();
    });
  }
}

