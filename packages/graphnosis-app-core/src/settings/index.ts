import { promises as fs } from 'node:fs';
import path from 'node:path';

// User-tunable per-cortex settings. Lives at <cortex>/settings.json (plaintext,
// like policy.json — no graph data here, just config). If we ever store
// anything genuinely sensitive in here we'll switch to encrypted-at-rest.

// ── Connector types ───────────────────────────────────────────────────────────

export type ConnectorKind = 'webhook' | 'rss' | 'github' | 'slack' | 'trello' | 'linear' | 'obsidian' | 'gbrain' | 'ai-context';

export interface ConnectorConfig {
  /** User-chosen slug — must be unique within a cortex. */
  id: string;
  kind: ConnectorKind;
  /** Target engram for ingested events. */
  graphId: string;
  enabled: boolean;
  /**
   * Connector-specific credentials (API keys, OAuth tokens).
   *
   * In-memory: this field is always populated (decrypted on cortex unlock).
   * On-disk:   this field is always `{}` — the encrypted form lives in
   *            `credentialsEnc` below. The host's settings I/O boundary
   *            converts between the two transparently.
   *
   * v0.6.1+: encryption is mandatory; v0.6 (and earlier) wrote plaintext
   * here. The migration is one-way + automatic: any pre-v0.6.1 settings.json
   * with a non-empty `credentials` field is re-encrypted on the next save.
   */
  credentials: Record<string, string>;
  /**
   * Encrypted form of `credentials`. Base64-encoded XChaCha20-Poly1305
   * ciphertext (using the cortex data key). Present only on disk; the host
   * decrypts → `credentials` on load and encrypts → `credentialsEnc` on
   * save. Don't read this field directly in connector code — use
   * `credentials`.
   */
  credentialsEnc?: string;
  /** Connector-specific options (feed URL, repo name, channel list, etc.). */
  options: Record<string, unknown>;
  /** Unix ms timestamp of the last successful pull. Used as the `since` cursor. */
  lastPulledAt?: number;
  /** Last pull error message, if any. Cleared on next successful pull. */
  lastError?: string;
}

export interface ConnectorSettings {
  configs: ConnectorConfig[];
  /** Port for the incoming webhook server. Default 3458. */
  webhookPort: number;
  /** Interface for the webhook server. '127.0.0.1' or '0.0.0.0'. */
  webhookHost: string;
  /** How often to run pull() on each enabled pull-style connector. Default 15 min. */
  pullIntervalMs: number;
}

export type ContentCacheMode =
  | 'all'              // cache every ingest (best recovery; ~2× cortex size on file ingests)
  | 'ephemeral-only'   // only cache clip / ai-conversation / url; files stay on the user's disk
  | 'off';             // never cache; recovery is best-effort from `ref` only

export interface ContentCacheSettings {
  mode: ContentCacheMode;
  /** Skip caching for any single source larger than this. 0 = unlimited. */
  maxBytesPerSource: number;
}

export type ForgetMode =
  | 'soft'    // Fast: drop confidence to 0 and mark validUntil=now. Node stays
              // on disk for audit / undo; user can "Purge now" later.
  | 'purge';  // Slow: after each forget, rebuild the graph from the remaining
              // live sources so soft-deleted nodes never accumulate.

export interface ForgetSettings {
  mode: ForgetMode;
}

export interface McpRelaySettings {
  /**
   * How long the relay waits at startup for the App's mcp.sock to appear.
   * Useful when Claude (or any MCP client) launches before the user has
   * unlocked the cortex. Lower = faster failure feedback; higher = more
   * forgiving cold-launch sequencing.
   */
  initialWaitMs: number;
  /**
   * How long the relay waits, mid-session, for the App to come back online
   * after a disconnect (cortex locked, sidecar bounced, etc.). Within this
   * window the relay keeps Claude attached and replays the original
   * `initialize` to the fresh sidecar.
   */
  reconnectMs: number;
}

// Hard minimums. The relay needs a few seconds at least to handle the
// inherently-slow sidecar boot (Argon2id key derivation, BGE model load on
// cold cache). Anything lower than these reliably trips the relay on a
// healthy unlock — which would be a confusing footgun in Settings.
export const MIN_RELAY_INITIAL_WAIT_MS = 2_000;
export const MIN_RELAY_RECONNECT_MS = 5_000;
// Soft maximums — keep relays from hanging forever on unreachable cortexes.
export const MAX_RELAY_INITIAL_WAIT_MS = 120_000;            // 2 min
export const MAX_RELAY_RECONNECT_MS = 24 * 60 * 60 * 1000;   // 24 h

export type InspectorDetail = 'simple' | 'detailed';

export interface UiSettings {
  /**
   * How much information the Nodes inspector reveals. Simple = content +
   * source + actions. Detailed = adds confidence, validUntil, edge stats,
   * embedding cluster, op-log lineage, contradictions, type tags.
   */
  inspectorDetail: InspectorDetail;
}

/**
 * AI-routing + post-ingest behavior settings.
 */
export interface AiSettings {
  /**
   * When ON (default), the MCP `initialize` response includes a high-priority
   * `instructions` block that tells the AI to treat Graphnosis as the
   * authoritative personal-memory layer (use `recall` proactively, prefer
   * `correct` over `remember` for fixes, etc.).
   *
   * When OFF, the AI still sees the tools (they remain registered) but no
   * system-prompt-level routing fires; the AI picks them like any other
   * tool, based purely on the per-tool descriptions. Useful when comparing
   * Graphnosis to another memory system or when the user wants their AI
   * client's own memory features to lead.
   *
   * Changes take effect when the sidecar next builds an MCP server — in
   * practice: next cortex unlock, or after a `Reconnect` in Settings.
   */
  useAsDefaultMemory: boolean;
  /**
   * Hard cap on active node count above which the sidecar SKIPS the
   * post-ingest cross-doc relink pass (entity-overlap + person-bridge
   * edge inference). At small/medium engram sizes the pass is cheap and
   * adds real value — links a freshly-remembered clip to existing nodes
   * sharing entities. At very large engrams it becomes O(N²) and can
   * stall the sidecar; clamp at this threshold to stay snappy.
   *
   * Set to 0 to disable the post-ingest relink entirely. The user can
   * still run a manual "Reindex this engram" pass when we add that UI.
   */
  autoRelinkMaxNodes: number;
  /**
   * When ON, the sidecar watches every file-backed source's disk path and
   * automatically reingests it on save (debounced ~2s). Mirrors the
   * manual Reingest button but with zero clicks.
   *
   * OFF by default — auto-modifying the engram in response to filesystem
   * activity is surprising behavior on first encounter, and the user
   * may not want every Vim save to ripple back through chunking +
   * embeddings + cross-doc relink. Power users with active note-files
   * (Obsidian, dailies, etc.) flip this on in Settings.
   */
  autoReingestOnFileChange: boolean;
  /**
   * How long (ms) the file must be unchanged before auto-reingest fires.
   * Acts as a long debounce: you can edit for 30 minutes and Graphnosis
   * only re-chunks once you've stopped, not on every Cmd+S.
   * Default 900 000 ms (15 min). Shown in Settings UI when
   * autoReingestOnFileChange is on.
   */
  reingestQuietMs: number;
  /**
   * How aggressively the SDK splits a document into chunked memory nodes.
   *
   *   - 'fine'     ≈ 300-char nodes (more semantic vectors, finer recall,
   *                  higher embedding cost per ingest)
   *   - 'balanced' ≈ 500-char nodes — the SDK's historical default
   *   - 'coarse'   ≈ 2500-char nodes (fewer/bigger nodes, faster + lower
   *                  memory ingest, less precise recall)
   *
   * Threaded through every appendDocument call. Changing this doesn't
   * re-chunk existing nodes — old content keeps its previous shape. Take
   * effect on the next ingest.
   */
  chunkSize: ChunkSizePreset;
  /**
   * How many texts the SDK groups into one `model.embed([...])` call.
   *
   *   - 'small'  → 64 items/call   (low memory, frequent progress)
   *   - 'medium' → 256 items/call  (default)
   *   - 'large'  → 1024 items/call (max throughput on big-RAM machines)
   *   - 'auto'   → totalmem-based: ≥32 GB → large, ≥16 GB → medium, else small
   */
  embedBatch: EmbedBatchPreset;
  /**
   * Master switch for the local LLM. OFF by default — even when Ollama is
   * installed and a model is running, Graphnosis never routes a memory
   * through it until the user explicitly opts in (Go Non-Deterministic →
   * Local LLM). The LLM is non-deterministic, so its use is a deliberate
   * choice, not an automatic consequence of Ollama being detected.
   */
  llmEnabled: boolean;
  /**
   * The Ollama model tag to use for brain features (synapse, insight, develop, predict).
   * Overrides the default from LLM_CATALOG. Set via Settings → Brain / Local AI.
   * Examples: "llama3.2:3b-instruct-q4_K_M", "qwen2.5:3b-instruct-q4_K_M"
   */
  llmModel?: string;
}

export type ChunkSizePreset = 'fine' | 'balanced' | 'coarse';
export type EmbedBatchPreset = 'small' | 'medium' | 'large' | 'auto';

export type GraphTemplate =
  // Free tier
  | 'personal'
  | 'journal'
  | 'reading'
  | 'learning'
  // Power tier (badge shown, not all behaviors enabled tonight)
  | 'project'
  | 'research'
  | 'codebase'
  | 'health'
  // Enterprise tier
  | 'team'
  | 'compliance'
  | 'onboarding';

export interface GraphMetadata {
  /** Template the user picked on creation. Hints downstream UX (badges, sorting, default queries). */
  template: GraphTemplate;
  /** Human-friendly display name; falls back to graphId in older cortexes. */
  displayName: string;
  createdAt: number;
  /**
   * When true the graph is hidden from the cortex picker and all in-app navigation.
   * The data files remain on disk untouched — the user can unarchive at any time.
   */
  archived?: boolean;
  /**
   * Sensitivity tier controlling how much of this graph the AI is allowed to see.
   * Defaults to 'personal' when unset.
   *   public    — unrestricted (4 000 tokens)
   *   personal  — explicit recall only, no proactive injection (2 000 tokens)
   *   sensitive — AI never sees this graph (0 tokens)
   */
  sensitivityTier?: 'public' | 'personal' | 'sensitive';
}

export interface HttpBridgeSettings {
  /** Whether the HTTP bridge is active. False by default. */
  enabled: boolean;
  /** TCP port to bind on. Default 3457. */
  port: number;
  /** Interface to bind on. '127.0.0.1' (loopback only) or '0.0.0.0' (LAN / Tailscale). */
  host: string;
  /**
   * Bearer token mobile clients must present in Authorization headers.
   * Auto-generated (UUID v4) on first enable via the App's Settings UI.
   * Shown once in the UI; user copies it into their mobile MCP client config.
   */
  token: string;
  /**
   * Browser origins allowed to call the bridge (for future browser extensions / PWAs).
   * Empty array = no browser origin is allowed (direct HTTP clients like mobile apps
   * don't send an Origin header so they are unaffected by this list).
   */
  allowedOrigins: string[];
}

export interface VsCodeBridgeSettings {
  /**
   * Auto-generated UUID token for the always-on local HTTP MCP bridge
   * (VS Code Copilot extension). Separate from the mobile bridge token.
   * Generated on first sidecar start and stored here so the VS Code
   * extension can reconnect across restarts without re-configuration.
   */
  localBridgeToken: string;
  /** Port the local bridge binds on. Default 3457. */
  localBridgePort: number;
}

export interface AppSettings {
  contentCache: ContentCacheSettings;
  forget: ForgetSettings;
  mcpRelay: McpRelaySettings;
  ui: UiSettings;
  ai: AiSettings;
  /** Per-graph metadata keyed by graphId. Older cortexes may have no entry for an existing graph. */
  graphMetadata: Record<string, GraphMetadata>;
  /**
   * Mobile & remote-client settings. Absent (undefined) means the HTTP bridge
   * is disabled — old cortexes that have never touched this section behave
   * identically to bridge.enabled = false.
   */
  mobile?: {
    httpBridge: HttpBridgeSettings;
  };
  /**
   * Service connector settings. Absent = no connectors configured.
   * Each ConnectorConfig includes credentials (plaintext) and pull schedule state.
   */
  connectors?: ConnectorSettings;
  /**
   * VS Code / Copilot integration settings. Absent on older cortexes; the
   * sidecar auto-populates on first boot after the feature ships.
   */
  vscode?: VsCodeBridgeSettings;
  /** Docs-engram ingest state. Absent on cortexes that never saw the offer. */
  docsEngram?: {
    /** true once the user clicked "Not now" on the docs-ingest offer. */
    declined?: boolean;
    /** App version at the last successful docs ingest. Drives auto-re-ingest. */
    ingestedAppVersion?: string;
  };
  /**
   * Alive Brain — background intelligence settings. Absent on older cortexes;
   * BrainEngine starts all activities immediately when unset (treats them
   * as "never run"). Persisted to settings.json after each completed run.
   */
  brain?: {
    /** Unix-ms timestamps of each completed background activity. */
    lastRun?: {
      duplicateScan?: number;
      synapse?: number;
      insight?: number;
      temporalDecay?: number;
      goalCheck?: number;
      reinforce?: number;
      consolidation?: number;
      crossEngram?: number;
    };
    /** Count of pending (non-dismissed) insight cards in BrainEngine memory. */
    pendingInsightsCount?: number;
    /** Count of detected duplicate pairs since last dismissal. */
    pendingDuplicatePairsCount?: number;
    /** Temporal decay configuration. */
    temporalDecay?: {
      /** When false, the daily confidence decay loop is skipped entirely. Default true. */
      enabled: boolean;
      /** Percent confidence lost per day of non-recall for a typical node. Default 0.5. */
      dailyRatePercent: number;
      /** When true, nodes that appear in recall results gain a small confidence boost. Default true. */
      reinforceOnRecall: boolean;
      /** Clips and ephemeral notes decay this many times faster than files. Default 3. */
      clipDecayMultiplier: number;
    };
    /** Autonomous Indelibility — connection reinforcement + consolidation. */
    reinforcement?: ReinforcementSettings;
    /** Graphnosis Neural Network — a non-deterministic trained link-predictor. OFF by default. */
    neuralNetwork?: {
      /** When true, the trained link-predictor may add predicted connections. Default false. */
      enabled: boolean;
    };
    /** Ambient clipboard capture — watches clipboard for long text and offers to save it. */
    clipboardCapture?: {
      /** When true, clipboard is polled while the app is focused. Default false. */
      enabled: boolean;
    };
  };
}

/**
 * Autonomous Indelibility configuration. Strengthen-only — no field here ever
 * weakens a memory. Read by ReinforcementEngine; absent on older cortexes, in
 * which case DEFAULT_REINFORCEMENT applies.
 */
export interface ReinforcementSettings {
  /** When false, the reinforcement + consolidation passes are skipped. Default true. */
  enabled: boolean;
  /** Saturating increment rate for co-recalled connections. Default 0.10. */
  reinforceRate: number;
  /** Starting weight for a newly formed connection. Default 0.5. */
  baselineWeight: number;
  /** Co-activation count at which an unlinked pair earns a new connection. Default 3. */
  newConnectionCoActivationThreshold: number;
  /** Hours between consolidation passes. Default 24. */
  consolidationIntervalHours: number;
  /** When false, cross-engram connection formation is skipped. Default true. */
  crossEngramEnabled: boolean;
  /** Minimum embedding similarity for a cross-engram connection. Default 0.82. */
  crossEngramMinSim: number;
}

export const DEFAULT_REINFORCEMENT: ReinforcementSettings = {
  enabled: true,
  reinforceRate: 0.1,
  baselineWeight: 0.5,
  newConnectionCoActivationThreshold: 3,
  consolidationIntervalHours: 24,
  crossEngramEnabled: true,
  crossEngramMinSim: 0.82,
};

export const DEFAULT_SETTINGS: AppSettings = {
  contentCache: {
    // The "you cannot lose memories" default. The cap keeps pathological
    // ingests (e.g. a multi-GB video file) from ballooning the cortex, but
    // is generous enough to cover realistic large reference manuals — e.g.
    // a 4233-page PDF (DaVinci Resolve manual) weighs in around 210MB.
    // Users can raise or lower it in the Settings UI.
    mode: 'all',
    maxBytesPerSource: 512 * 1024 * 1024,
  },
  forget: {
    // Soft by default — fast, undoable, and the user can always run "Purge now"
    // to physically remove forgotten memories when they're sure.
    mode: 'soft',
  },
  mcpRelay: {
    initialWaitMs: 10_000,
    reconnectMs: 24 * 60 * 60 * 1000, // 24h — see mcp-relay.ts for rationale
  },
  ui: {
    inspectorDetail: 'simple',
  },
  ai: {
    // ON by default — the user installed Graphnosis specifically to be
    // their AI's memory; flipping this off is the unusual case.
    useAsDefaultMemory: true,
    // 5000 active nodes is the soft-perf ceiling where entity Jaccard
    // O(N²) starts to feel slow (~25M comparisons). Below that the
    // pass takes < a second on a modern Mac. Power users with bigger
    // cortexes can crank or zero this out in Settings.
    autoRelinkMaxNodes: 5000,
    // OFF by default — see the field comment above for rationale.
    autoReingestOnFileChange: false,
    // 15 min quiet period: file must be stable this long before re-chunk fires.
    reingestQuietMs: 15 * 60 * 1000,
    // Conservative defaults — match the SDK's pre-preset behaviour so
    // existing cortexes don't change shape under users on upgrade.
    chunkSize: 'balanced',
    // 'auto' picks per-machine on first use without the user having to
    // know what 256 vs 1024 means. They can override via Settings.
    embedBatch: 'auto',
    // OFF by default — the local LLM is opt-in. Detection of a running
    // Ollama never auto-enables it; the user turns it on deliberately.
    llmEnabled: false,
  },
  graphMetadata: {},
};

function settingsPath(cortexDir: string): string {
  return path.join(cortexDir, 'settings.json');
}

/**
 * Load settings, falling back to DEFAULT_SETTINGS on missing-file or any parse
 * error. We deliberately don't throw on a corrupt file — the App should boot
 * with safe defaults rather than refuse to unlock. Logged to stderr so devs
 * notice; users see normal behavior.
 */
export async function loadSettings(cortexDir: string): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsPath(cortexDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return mergeWithDefaults(parsed);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      console.error(`[settings] failed to read ${settingsPath(cortexDir)}: ${err.message} — using defaults.`);
    }
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(cortexDir: string, settings: AppSettings): Promise<void> {
  await fs.mkdir(cortexDir, { recursive: true });
  // Write atomically: write to tmp, then rename.
  const target = settingsPath(cortexDir);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2));
  await fs.rename(tmp, target);
}

/**
 * Merge a (possibly partial / older-shape) settings object with the current
 * defaults. Keeps forward-compat when we add new settings — older cortexes
 * just inherit the new defaults without forcing a migration step.
 */
export function mergeWithDefaults(partial: Partial<AppSettings> | null | undefined): AppSettings {
  const cc: Partial<ContentCacheSettings> = partial?.contentCache ?? {};
  const mode: ContentCacheMode =
    cc.mode === 'all' || cc.mode === 'ephemeral-only' || cc.mode === 'off'
      ? cc.mode
      : DEFAULT_SETTINGS.contentCache.mode;
  const maxBytesPerSource = typeof cc.maxBytesPerSource === 'number' && cc.maxBytesPerSource >= 0
    ? cc.maxBytesPerSource
    : DEFAULT_SETTINGS.contentCache.maxBytesPerSource;

  const fg: Partial<ForgetSettings> = partial?.forget ?? {};
  const forgetMode: ForgetMode =
    fg.mode === 'soft' || fg.mode === 'purge'
      ? fg.mode
      : DEFAULT_SETTINGS.forget.mode;

  const mr: Partial<McpRelaySettings> = partial?.mcpRelay ?? {};
  const initialWaitMs = clamp(
    typeof mr.initialWaitMs === 'number' ? mr.initialWaitMs : DEFAULT_SETTINGS.mcpRelay.initialWaitMs,
    MIN_RELAY_INITIAL_WAIT_MS,
    MAX_RELAY_INITIAL_WAIT_MS,
  );
  const reconnectMs = clamp(
    typeof mr.reconnectMs === 'number' ? mr.reconnectMs : DEFAULT_SETTINGS.mcpRelay.reconnectMs,
    MIN_RELAY_RECONNECT_MS,
    MAX_RELAY_RECONNECT_MS,
  );

  const ui: Partial<UiSettings> = partial?.ui ?? {};
  const inspectorDetail: InspectorDetail =
    ui.inspectorDetail === 'simple' || ui.inspectorDetail === 'detailed'
      ? ui.inspectorDetail
      : DEFAULT_SETTINGS.ui.inspectorDetail;

  // AI routing: default ON for older cortexes that didn't have this field —
  // matches the behavior they were already getting (the SERVER_INSTRUCTIONS
  // block always fired before this setting existed).
  const ai: Partial<AiSettings> = partial?.ai ?? {};
  const useAsDefaultMemory = typeof ai.useAsDefaultMemory === 'boolean'
    ? ai.useAsDefaultMemory
    : DEFAULT_SETTINGS.ai.useAsDefaultMemory;
  const autoRelinkMaxNodes = typeof ai.autoRelinkMaxNodes === 'number' && ai.autoRelinkMaxNodes >= 0
    ? Math.floor(ai.autoRelinkMaxNodes)
    : DEFAULT_SETTINGS.ai.autoRelinkMaxNodes;
  const autoReingestOnFileChange = typeof ai.autoReingestOnFileChange === 'boolean'
    ? ai.autoReingestOnFileChange
    : DEFAULT_SETTINGS.ai.autoReingestOnFileChange;
  // Valid values: any positive integer (ms). Clamp to sensible range:
  //   min 60 s (prevents accidental near-instant reingests),
  //   max 7 days (longer makes no practical sense for a file watcher).
  const MIN_QUIET_MS = 60_000;
  const MAX_QUIET_MS = 7 * 24 * 60 * 60 * 1000;
  const reingestQuietMs = typeof ai.reingestQuietMs === 'number' && ai.reingestQuietMs > 0
    ? clamp(Math.floor(ai.reingestQuietMs), MIN_QUIET_MS, MAX_QUIET_MS)
    : DEFAULT_SETTINGS.ai.reingestQuietMs;
  // Chunk size + embed batch presets — accept only the known labels;
  // unrecognised values fall back to the default. Forward-compat: an
  // older cortex with no entries gets the safe defaults at next load.
  const chunkSize: ChunkSizePreset =
    ai.chunkSize === 'fine' || ai.chunkSize === 'balanced' || ai.chunkSize === 'coarse'
      ? ai.chunkSize
      : DEFAULT_SETTINGS.ai.chunkSize;
  const embedBatch: EmbedBatchPreset =
    ai.embedBatch === 'small' || ai.embedBatch === 'medium' ||
    ai.embedBatch === 'large' || ai.embedBatch === 'auto'
      ? ai.embedBatch
      : DEFAULT_SETTINGS.ai.embedBatch;
  const llmEnabled = typeof ai.llmEnabled === 'boolean'
    ? ai.llmEnabled
    : DEFAULT_SETTINGS.ai.llmEnabled;
  const llmModel = typeof ai.llmModel === 'string' && ai.llmModel.length > 0
    ? ai.llmModel
    : undefined;

  const graphMetadata = (partial?.graphMetadata && typeof partial.graphMetadata === 'object')
    ? partial.graphMetadata
    : { ...DEFAULT_SETTINGS.graphMetadata };

  // Mobile / HTTP bridge — entirely optional. Absent = bridge disabled.
  // Pass through as-is if present; validate individual fields with fallbacks.
  let mobile: AppSettings['mobile'] | undefined;
  if (partial?.mobile) {
    const hb: Partial<HttpBridgeSettings> = partial.mobile.httpBridge ?? {};
    mobile = {
      httpBridge: {
        enabled: typeof hb.enabled === 'boolean' ? hb.enabled : false,
        port: typeof hb.port === 'number' && hb.port > 0 && hb.port < 65536
          ? Math.floor(hb.port) : 3457,
        host: typeof hb.host === 'string' && hb.host.length > 0 ? hb.host : '127.0.0.1',
        token: typeof hb.token === 'string' ? hb.token : '',
        allowedOrigins: Array.isArray(hb.allowedOrigins)
          ? (hb.allowedOrigins as unknown[]).filter((o): o is string => typeof o === 'string')
          : [],
      },
    };
  }

  // Connector settings — optional. Absent = no connectors configured.
  // Pass configs through verbatim; validate/clamp the scalar scheduling fields.
  let connectors: ConnectorSettings | undefined;
  if (partial?.connectors) {
    const cs = partial.connectors;
    connectors = {
      configs: Array.isArray(cs.configs) ? cs.configs : [],
      webhookPort: typeof cs.webhookPort === 'number' && cs.webhookPort > 0 && cs.webhookPort < 65536
        ? Math.floor(cs.webhookPort) : 3458,
      webhookHost: cs.webhookHost === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1',
      pullIntervalMs: typeof cs.pullIntervalMs === 'number' && cs.pullIntervalMs >= 60_000
        ? Math.floor(cs.pullIntervalMs) : 15 * 60 * 1000,
    };
  }

  // VS Code bridge — optional. Pass through if present; validate individual fields.
  let vscode: AppSettings['vscode'] | undefined;
  if (partial?.vscode) {
    const v = partial.vscode;
    vscode = {
      localBridgeToken: typeof v.localBridgeToken === 'string' ? v.localBridgeToken : '',
      localBridgePort: typeof v.localBridgePort === 'number' && v.localBridgePort > 0 && v.localBridgePort < 65536
        ? Math.floor(v.localBridgePort) : 3457,
    };
  }

  // Docs-engram ingest state — optional. Absent on cortexes that never saw
  // the offer. Validate the two fields by type; drop anything malformed so a
  // hand-edited settings.json can't corrupt the auto-re-ingest state machine.
  let docsEngram: AppSettings['docsEngram'] | undefined;
  if (partial?.docsEngram) {
    const de = partial.docsEngram;
    docsEngram = {
      ...(typeof de.declined === 'boolean' ? { declined: de.declined } : {}),
      ...(typeof de.ingestedAppVersion === 'string' && de.ingestedAppVersion.length > 0
        ? { ingestedAppVersion: de.ingestedAppVersion }
        : {}),
    };
  }

  // Brain / Alive Brain — pass through if present, validate individual fields.
  let brain: AppSettings['brain'] | undefined;
  if (partial?.brain) {
    const b = partial.brain;
    const td = b.temporalDecay;
    const rf = b.reinforcement;
    brain = {
      ...(b.lastRun !== undefined ? { lastRun: b.lastRun } : {}),
      ...(typeof b.pendingInsightsCount === 'number' ? { pendingInsightsCount: b.pendingInsightsCount } : {}),
      ...(typeof b.pendingDuplicatePairsCount === 'number' ? { pendingDuplicatePairsCount: b.pendingDuplicatePairsCount } : {}),
      ...(td !== undefined ? {
        temporalDecay: {
          enabled: typeof td.enabled === 'boolean' ? td.enabled : true,
          dailyRatePercent: typeof td.dailyRatePercent === 'number' && td.dailyRatePercent > 0 ? td.dailyRatePercent : 0.5,
          reinforceOnRecall: typeof td.reinforceOnRecall === 'boolean' ? td.reinforceOnRecall : true,
          clipDecayMultiplier: typeof td.clipDecayMultiplier === 'number' && td.clipDecayMultiplier > 0 ? td.clipDecayMultiplier : 3,
        },
      } : {}),
      ...(rf !== undefined ? {
        reinforcement: {
          enabled: typeof rf.enabled === 'boolean' ? rf.enabled : DEFAULT_REINFORCEMENT.enabled,
          reinforceRate: typeof rf.reinforceRate === 'number' && rf.reinforceRate > 0 ? rf.reinforceRate : DEFAULT_REINFORCEMENT.reinforceRate,
          baselineWeight: typeof rf.baselineWeight === 'number' && rf.baselineWeight > 0 ? rf.baselineWeight : DEFAULT_REINFORCEMENT.baselineWeight,
          newConnectionCoActivationThreshold: typeof rf.newConnectionCoActivationThreshold === 'number' && rf.newConnectionCoActivationThreshold > 0 ? Math.floor(rf.newConnectionCoActivationThreshold) : DEFAULT_REINFORCEMENT.newConnectionCoActivationThreshold,
          consolidationIntervalHours: typeof rf.consolidationIntervalHours === 'number' && rf.consolidationIntervalHours > 0 ? rf.consolidationIntervalHours : DEFAULT_REINFORCEMENT.consolidationIntervalHours,
          crossEngramEnabled: typeof rf.crossEngramEnabled === 'boolean' ? rf.crossEngramEnabled : DEFAULT_REINFORCEMENT.crossEngramEnabled,
          crossEngramMinSim: typeof rf.crossEngramMinSim === 'number' && rf.crossEngramMinSim > 0 ? rf.crossEngramMinSim : DEFAULT_REINFORCEMENT.crossEngramMinSim,
        },
      } : {}),
      ...(b.neuralNetwork !== undefined ? {
        neuralNetwork: {
          enabled: typeof b.neuralNetwork.enabled === 'boolean' ? b.neuralNetwork.enabled : false,
        },
      } : {}),
    };
  }

  return {
    contentCache: { mode, maxBytesPerSource },
    forget: { mode: forgetMode },
    mcpRelay: { initialWaitMs, reconnectMs },
    ui: { inspectorDetail },
    ai: {
      useAsDefaultMemory, autoRelinkMaxNodes, autoReingestOnFileChange,
      reingestQuietMs, chunkSize, embedBatch, llmEnabled,
      ...(llmModel !== undefined ? { llmModel } : {}),
    },
    graphMetadata,
    ...(mobile !== undefined ? { mobile } : {}),
    ...(connectors !== undefined ? { connectors } : {}),
    ...(vscode !== undefined ? { vscode } : {}),
    ...(docsEngram !== undefined ? { docsEngram } : {}),
    ...(brain !== undefined ? { brain } : {}),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Returns true if the given ingest should be cached based on the current
 * settings. The host calls this right before writing the content blob.
 */
export function shouldCache(
  settings: AppSettings,
  kind: 'file' | 'url' | 'ai-conversation' | 'clip',
  byteLength: number,
): boolean {
  const cc = settings.contentCache;
  if (cc.mode === 'off') return false;
  if (cc.mode === 'ephemeral-only' && kind === 'file') return false;
  if (cc.maxBytesPerSource > 0 && byteLength > cc.maxBytesPerSource) return false;
  return true;
}
