import { promises as fs } from 'node:fs';
import path from 'node:path';

// User-tunable per-vault settings. Lives at <vault>/settings.json (plaintext,
// like policy.json — no graph data here, just config). If we ever store
// anything genuinely sensitive in here we'll switch to encrypted-at-rest.

export type ContentCacheMode =
  | 'all'              // cache every ingest (best recovery; ~2× vault size on file ingests)
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
   * unlocked the vault. Lower = faster failure feedback; higher = more
   * forgiving cold-launch sequencing.
   */
  initialWaitMs: number;
  /**
   * How long the relay waits, mid-session, for the App to come back online
   * after a disconnect (vault locked, sidecar bounced, etc.). Within this
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
// Soft maximums — keep relays from hanging forever on unreachable vaults.
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
   * practice: next vault unlock, or after a `Reconnect` in Settings.
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
}

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
  /** Human-friendly display name; falls back to graphId in older vaults. */
  displayName: string;
  createdAt: number;
}

export interface AppSettings {
  contentCache: ContentCacheSettings;
  forget: ForgetSettings;
  mcpRelay: McpRelaySettings;
  ui: UiSettings;
  ai: AiSettings;
  /** Per-graph metadata keyed by graphId. Older vaults may have no entry for an existing graph. */
  graphMetadata: Record<string, GraphMetadata>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  contentCache: {
    // The "you cannot lose memories" default. The 50MB cap keeps pathological
    // ingests (e.g. a multi-GB PDF) from ballooning the vault; users can raise
    // or lower it in the Settings UI.
    mode: 'all',
    maxBytesPerSource: 50 * 1024 * 1024,
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
    // vaults can crank or zero this out in Settings.
    autoRelinkMaxNodes: 5000,
  },
  graphMetadata: {},
};

function settingsPath(vaultDir: string): string {
  return path.join(vaultDir, 'settings.json');
}

/**
 * Load settings, falling back to DEFAULT_SETTINGS on missing-file or any parse
 * error. We deliberately don't throw on a corrupt file — the App should boot
 * with safe defaults rather than refuse to unlock. Logged to stderr so devs
 * notice; users see normal behavior.
 */
export async function loadSettings(vaultDir: string): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsPath(vaultDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return mergeWithDefaults(parsed);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      console.error(`[settings] failed to read ${settingsPath(vaultDir)}: ${err.message} — using defaults.`);
    }
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(vaultDir: string, settings: AppSettings): Promise<void> {
  await fs.mkdir(vaultDir, { recursive: true });
  // Write atomically: write to tmp, then rename.
  const target = settingsPath(vaultDir);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2));
  await fs.rename(tmp, target);
}

/**
 * Merge a (possibly partial / older-shape) settings object with the current
 * defaults. Keeps forward-compat when we add new settings — older vaults
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

  // AI routing: default ON for older vaults that didn't have this field —
  // matches the behavior they were already getting (the SERVER_INSTRUCTIONS
  // block always fired before this setting existed).
  const ai: Partial<AiSettings> = partial?.ai ?? {};
  const useAsDefaultMemory = typeof ai.useAsDefaultMemory === 'boolean'
    ? ai.useAsDefaultMemory
    : DEFAULT_SETTINGS.ai.useAsDefaultMemory;
  const autoRelinkMaxNodes = typeof ai.autoRelinkMaxNodes === 'number' && ai.autoRelinkMaxNodes >= 0
    ? Math.floor(ai.autoRelinkMaxNodes)
    : DEFAULT_SETTINGS.ai.autoRelinkMaxNodes;

  const graphMetadata = (partial?.graphMetadata && typeof partial.graphMetadata === 'object')
    ? partial.graphMetadata
    : { ...DEFAULT_SETTINGS.graphMetadata };

  return {
    contentCache: { mode, maxBytesPerSource },
    forget: { mode: forgetMode },
    mcpRelay: { initialWaitMs, reconnectMs },
    ui: { inspectorDetail },
    ai: { useAsDefaultMemory, autoRelinkMaxNodes },
    graphMetadata,
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
