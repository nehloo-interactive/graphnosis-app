import { promises as fs, existsSync, readdirSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import {
  embeddings,
  settings as settingsMod,
  sources,
  assertEngramNotOnLegalHold,
  assertSourceNotOnLegalHold,
  effectiveSensitivityTier,
  normalizeIndustryTags,
  resolveClassificationPolicy,
  sanitizeClassificationSchema,
  type SourceRecord,
} from '@graphnosis-app/core';
import { crypto, federation, oplog, policy, type DeviceId, type GraphId, type SubgraphBudget } from '@nehloo-interactive/graphnosis-secure-sync';
import type { GraphnosisAdapter, GraphHandle, AppendDocumentInput, CorrectionEdit } from './graphnosis-adapter.js';
import * as healingJournalMod from './healing-journal.js';
import * as connectionStoreMod from './connection-store.js';
import * as associationIndexMod from './association-index.js';
import * as gnnStoreMod from './gnn-store.js';
import * as gllOverlayMod from './gll-overlay.js';
import { redactId, redactPair, dbg } from './log-redact.js';
import { GllWriter } from './gll.js';
import { SkillSnapshotStore } from './skill-snapshots.js';
import { SkillCallLinkStore } from './skill-call-links.js';
import { SkillRunStore } from './skill-runs.js';
import { WebAuthnCredentialStore } from './webauthn-store.js';
import { ConnectorFileMapStore } from './connectors/file-map-store.js';
import { ObligationIndex, type ObligationWriteInput } from './obligation-index.js';
import {
  encryptModelProviderKeysInSettings,
  decryptModelProviderKeysInSettings,
} from './model-provider-keys.js';
import { DeviceIdentity } from './device-identity.js';
import { FEDERATED_MASTER_FILE, federatedMasterPath, generateFederatedUnlockKey } from '@graphnosis-app/core/sso';
import type { WorkPriority } from './work-priority.js';
import { hostRecall, hostDigDeeper, type RecallHost } from './host/recall-methods.js';
import { extractQueryEntities } from './host/recall.js';
import { invalidateQueryEnrichmentCache } from './query-enrichment-cache.js';
import { bundledDocForRef } from './docs-ingest.js';
import { actorOf } from './activity-actors.js';
import { queryOplogForActivity, sliceOplogCacheForActivity } from './oplog-activity-query.js';

const { deriveKey, encrypt, decrypt } = crypto;
const { OpLogWriter } = oplog;
const { EmbeddingCache, cached, stubEmbed } = embeddings;
const { federatedQuery } = federation;
const { SourceIndex, makeSourceId, hashContent } = sources;

export { extractQueryEntities } from './host/recall.js';
export interface HostOptions {
  cortexDir: string;
  deviceId: DeviceId;
  passphrase: string;
  adapter: GraphnosisAdapter;
  policy?: policy.PolicyConfig;
  embed?: embeddings.EmbedFn;
  /**
   * Low-priority embed function used for background operations (boot-time
   * buildEmbeddings, re-embed migrations). When provided, this is routed to a
   * dedicated background worker slot so the foreground `embed` slots remain
   * free for user-facing search/recall requests.
   *
   * Defaults to `embed` when not supplied (single-worker fallback).
   */
  embedBackground?: embeddings.EmbedFn;
  /** Embedding model provenance — affects the on-disk vector index. Change the id if the model changes. */
  embedAdapterId?: string;
  embedDimensions?: number;
  /**
   * When set, the sidecar is running in recovery mode: the user provided
   * their 24-word BIP-39 phrase instead of their passphrase. `open()` reads
   * `<cortexDir>/recovery.enc`, decrypts it with this phrase to recover the
   * raw data key, then bypasses the normal Argon2id derivation step.
   *
   * `passphrase` is ignored when `recoveryPhrase` is provided.
   */
  recoveryPhrase?: string;
  /**
   * Federated org unlock key (Phase 2 SSO). When set, unwraps `federated.master.enc`
   * instead of `master.enc` with the owner passphrase. Ignored when `recoveryPhrase` is set.
   */
  federatedUnlockKey?: string;
}

/** Return type of `GraphnosisHost.open()`. The `recoveryPhrase` field is
 *  set ONLY on the very first unlock of a brand-new cortex — it is the
 *  24-word BIP-39 phrase that can recover the data key if the passphrase
 *  is ever forgotten. Show it to the user ONCE and then discard it. */
export interface OpenResult {
  host: GraphnosisHost;
  recoveryPhrase?: string;
}

export type RecoveryStatus =
  | 'pending'
  | 'recoverable'              // file still exists on disk at the recorded ref
  | 'recoverable-from-cache'   // content blob exists in <cortex>/content/
  | 'already-present'
  | 'file-missing'
  | 'url-refetch-not-implemented'
  | 'content-not-in-oplog';

/** Disk state for one engram where .lkg is substantially larger than .gai. */
export interface LkgRecoveryCandidate {
  graphId: GraphId;
  displayName: string;
  gaiBytes: number;
  lkgBytes: number;
  needsPromote: boolean;
  loaded: boolean;
}

export type EngramRecoveryNeededHandler = (payload: {
  graphId: GraphId;
  displayName: string;
  reason: string;
  gaiBytes?: number;
  lkgBytes?: number;
}) => void;

/**
 * Format of a cached content blob (before encryption). We prepend a small
 * JSON header so recovery knows how to re-ingest (parser kind, mime, original
 * ref). Layout: [u32 header-len, LE] [header JSON bytes] [raw content bytes].
 */
interface ContentCacheHeader {
  kind: 'file' | 'url' | 'ai-conversation' | 'clip' | 'skill';
  ref: string;
  // The Graphnosis parser kind we'd hand to appendDocument on recovery.
  // Mirrors AppendDocumentInput['kind'] in graphnosis-adapter.ts.
  docKind: 'markdown' | 'html' | 'json' | 'csv' | 'pdf' | 'text';
  originalSize: number;
  contentHash?: string;
  cachedAt: number;
}

export interface RecoveryPlanItem {
  sourceId: string;
  graphId: GraphId;
  kind: 'file' | 'url' | 'ai-conversation' | 'clip' | 'skill';
  ref: string;
  contentHash?: string;
  ingestedAt: number;
  status: RecoveryStatus;
}

export interface RecoveryPlan {
  total: number;
  recoverable: number;
  items: RecoveryPlanItem[];
}

export interface RecoveryOutcome {
  sourceId: string;
  ref: string;
  ok: boolean;
  error?: string;
  /** Set when we intentionally didn't re-ingest (e.g., already in the graph). */
  skipped?: 'already-present';
}

export interface PurgeError {
  sourceId: string;
  ref: string;
  error: string;
}

export interface PurgeReport {
  beforeTotalNodes: number;
  beforeActiveNodes: number;
  beforeSoftDeletedNodes: number;
  afterTotalNodes: number;
  sourcesRebuilt: number;
  sourcesSkipped: number;
  errors: PurgeError[];
  /** True when there was nothing soft-deleted to purge — the graph wasn't touched. */
  noop?: boolean;
  /** True when phase 1 found unrecoverable sources and we refused to rebuild. */
  aborted?: boolean;
}

export interface RecoveryReport {
  attempted: number;
  recovered: number;
  skipped: number;
  failed: number;
  outcomes: RecoveryOutcome[];
}

interface LoadedGraph {
  handle: GraphHandle;
  sourceIndex: sources.SourceIndex;
  cache: embeddings.EmbeddingCache;
  dirty: boolean;
  /** In-flight buildEmbeddings promise (during cold-load only). Resolves to
   *  void when the background embed pass finishes; null once resolved.
   *  Callers that need deterministic recall after loadGraph (tests, scripted
   *  flows) `await host.waitForEmbeddings(graphId)` to gate on this. */
  embeddingsBuilding: Promise<void> | null;
  /** In-flight oplog reconcile (fire-and-forget in prod; tests await via
   *  waitForReconcile). Null when idle or queued for post-boot flush. */
  reconcileBuilding: Promise<void> | null;
  /** In-flight hollow-bundle materialize (async outside boot; tests await via
   *  waitForBundleMaterialize). */
  bundleMaterializing: Promise<void> | null;
  /** Source count from .bundle at loadGraph time — frozen so async reconcile does
   *  not treat a mid-reconcile ingest as "bundle had sources" for op-log recovery. */
  bundleSourcesAtLoad: number;
}

/** Payload emitted on every successful graph mutation. Consumers (the IPC
 *  layer's events socket, future in-process subscribers) listen to this to
 *  push UI refreshes or wake agent-style workers. */
export interface MutationEvent {
  graphId: GraphId;
  /** Wall-clock ms at the moment `save()` committed. Matches the value
   *  returned from `getMutationCursor()` so consumers can dedupe push
   *  events against a reconciliation poll. */
  ts: number;
}

/** Minimal interface the host uses to notify a filesystem watcher about
 *  source lifecycle changes. Defined as an interface (not a direct
 *  import) so the host doesn't need to know about chokidar / fs.watch
 *  implementation details, and so we can null it out without dragging
 *  the file-watcher module into hosts that don't need it. */
export interface SourceLifecycleListener {
  onSourceIngested(graphId: string, sourceId: string, ref: string, kind: string): void;
  onSourceForgotten(graphId: string, sourceId: string, ref: string): void;
  syncAll(): void;
}

// GraphnosisHost = the App's single integration point for the SDK.
// Owns encryption at rest, op-log emission, embedding cache, and the source index.
// Every mutation funnels through here so the op-log is the durable truth.

/** Per-source live-ingest delta — the new nodes a single source added, so the
 *  UI can append them to the 3D graph as each source finishes WITHOUT a full
 *  re-fetch (the "watch it grow source-by-source" path). */
export interface GraphDelta {
  graphId: GraphId;
  sourceId: string;
  nodes: ReturnType<GraphnosisAdapter['inspectNodes']>;
}

/** Result of an op-log compaction attempt (no-op when thresholds not met). */
export interface OplogCompactionResult {
  compacted: boolean;
  eventsRemoved?: number;
  eventsBefore?: number;
  eventsAfter?: number;
  bytesBefore?: number;
  bytesAfter?: number;
}

export type OplogHousekeepingResult = {
  compaction: OplogCompactionResult;
};

export class GraphnosisHost {
  // ── Mutation events ────────────────────────────────────────────────
  //
  // Every successful save() bumps lastMutationAt AND emits on this
  // EventEmitter. Anyone watching the host for changes (IPC layer's
  // events socket, future federation listeners, in-process consumers)
  // subscribes via onMutation() instead of polling lastMutationAt.
  //
  // The emit point is save() — the single chokepoint every mutation
  // funnels through — so we don't risk forgetting to fire when a new
  // mutation method is added.
  private readonly mutationEvents = new EventEmitter();
  // `key` and `salt` are NOT readonly because passphrase rotation may rewrite
  // `salt.bin` and (in a future key-rotation feature) re-encrypt files with a
  // new dataKey. For the current passphrase-change flow, the dataKey is
  // preserved — only the wrap key derived from the passphrase changes —
  // so neither this.key nor this.salt actually mutate at runtime; the fields
  // remain assignable in case a true key rotation ships later.
  private key: Uint8Array;
  private salt: Uint8Array;
  private readonly graphs = new Map<GraphId, LoadedGraph>();
  /** LRU: last user/AI access time per engram. Background brain passes do NOT
   *  bump this, so an engram only the brain touches can still go cold + evict.
   *  Drives maybeEvict()'s coldest-first ordering + the idle-grace guard. */
  private readonly lastAccessAt = new Map<GraphId, number>();
  /** Engrams that have successfully loaded at least once this session. An
   *  LRU-EVICTED engram stays in this set — it's still available (reloads
   *  transparently on access), so graphsWithMetadata reports it as loaded
   *  rather than "pending", and the UI doesn't grey/disable it in the picker.
   *  Only a genuine delete removes it. */
  private readonly everLoaded = new Set<GraphId>();
  /** Sink for per-source live-ingest deltas (wired by main.ts to the events
   *  socket). Null in headless/CI — then we skip building the delta entirely. */
  private graphDeltaBroadcaster: ((d: GraphDelta) => void) | null = null;

  /** Register (or clear) the live-ingest delta sink. */
  setGraphDeltaBroadcaster(fn: ((d: GraphDelta) => void) | null): void {
    this.graphDeltaBroadcaster = fn;
  }
  /**
   * Running count of user-initiated corrections per graph. Counts ONLY
   * `editNode` and `supersede` op-log events — these come exclusively from
   * the correction pipeline. Skips `deleteNode` because that op can also
   * come from forgetSource cascades, which would inflate the metric.
   * Populated from the op-log on loadGraph; bumped on applyCorrection.
   */
  private readonly correctionsCount = new Map<GraphId, number>();
  /** One-time read cache for the op-log events used by countCorrectionsFromOplog.
   *  The op-log is shared across all engrams, so reading it 17× during startup
   *  costs 7-12s per engram (143s total). We read it once on first call and
   *  reuse the result for all subsequent calls within the same second. The cache
   *  is intentionally short-lived (1s TTL) so a correction applied right after
   *  startup isn't counted twice. */
  private _oplogReadCache: { events: Awaited<ReturnType<typeof oplog.readAllEvents>>; at: number; seq: number } | null = null;
  /**
   * Monotonic write counter — bumped on every op-log emit (and on
   * invalidate/compaction). The read cache records the seq it was read at; as
   * long as no write has happened since, `listOplogEvents()` serves the cache
   * INDEFINITELY (no cold re-read of the whole 2M-event log on idle Home
   * opens). A write advances the seq → the next read refreshes. This replaces
   * the old 60-second TTL, which forced a 16s full re-read every minute even
   * when nothing had changed.
   */
  private _oplogWriteSeq = 0;
  /**
   * In-flight op-log read promise. Set while `readAllEvents` is running;
   * cleared when it resolves or rejects. Shared across concurrent callers of
   * `listOplogEvents()` so a single 16-second read services all waiters
   * rather than spawning N concurrent disk reads.
   */
  private _oplogReadPromise: Promise<Awaited<ReturnType<typeof oplog.readAllEvents>>> | null = null;
  /** In-process cache for mcp-audit.enc reads — invalidated on append. */
  private _mcpAuditCache: import('./mcp-audit.js').McpAuditEvent[] | null = null;
  /**
   * Incremented by `invalidateOplogCache()`. Captured by each in-flight read;
   * the read only writes to `_oplogReadCache` when the generation still matches,
   * preventing a stale in-flight read from overwriting fresh post-write data.
   */
  private _oplogReadGeneration = 0;
  /** True while loadAllGraphsFromDisk is running — serialises cold-cache
   *  buildEmbeddings so N engrams don't all contend on the background worker. */
  private bootSweepActive = false;
  private bootEmbBuildInFlight = 0;
  private bootEmbBuildWaiters: Array<() => void> = [];
  private bootEmbBuildIdleListeners: Array<() => void> = [];
  private static readonly BOOT_EMB_BUILD_MAX = 1;
  /** True from sidecar open until the disk sweep finishes (not until deferred
   *  oplog reconcile). While active, oplog reconcile + sourceRef sweeps are
   *  queued — each reconcile calls sync adapter.build() and replaying 22 of
   *  them concurrently monopolizes the event loop and starves IPC mid-sweep. */
  private bootPhaseActive = false;
  private bootReconcileQueue: GraphId[] = [];
  /** Hollow .gai shells (bundle has sources, 0 nodes) — materialize after boot sweep. */
  private bootMaterializeQueue: GraphId[] = [];
  /** sourceRef sweeps deferred from boot — run on first engram access. */
  private deferredSourceRefSweep = new Set<GraphId>();
  private bootDeferredFlushPromise: Promise<void> | null = null;
  /** Dedupes concurrent loadGraph calls (boot sweep timeout + UI graphs.load). */
  private loadGraphInflight = new Map<GraphId, Promise<void>>();
  /** Shrink-save blocks this session — pause brain mutations after threshold. */
  private shrinkSaveBlockedCount = new Map<GraphId, number>();
  /** Engrams where autonomous brain writes stand down until a successful save. */
  private brainMutationsPaused = new Set<GraphId>();
  /** One warn per engram per session when brain mutations pause. */
  private brainMutationsPauseWarned = new Set<GraphId>();
  /** One save-blocked warn per engram per session (shrink or empty shell). */
  private saveBlockedWarned = new Set<GraphId>();
  /** One in-app recovery nudge per engram per session (save blocked / promote failed). */
  private recoveryNeededEmitted = new Set<GraphId>();
  /** Optional hook — main.ts wires Ghampus nudge + boot toast. */
  private onRecoveryNeeded: EngramRecoveryNeededHandler | null = null;
  /** Dedupe noisy op-log integrity callbacks (future-timestamp per device+file). */
  private _oplogIntegrityWarned = new Set<string>();
  private readonly oplogWriter: oplog.OpLogWriter;
  /** Append-only LLM event log — one .gll file per engram. */
  readonly gllWriter: GllWriter;
  /** Per-source side-table holding pre-retrain snapshots of every
   *  skill. Backs `skill_history` + `rollback_skill`. */
  readonly skillSnapshots: SkillSnapshotStore;
  /** Cross-engram skill-call side-table (D1). The SDK can't represent
   *  cross-graph edges, so `@skill:` calls that resolve to a skill in another
   *  engram are persisted here and surfaced by the walk. */
  readonly skillCallLinks: SkillCallLinkStore;
  /** Persistent skill-run records (D5) — captured vars + progress so a
   *  multi-skill orchestration can resume across sessions. */
  readonly skillRuns: SkillRunStore;
  /** Registered WebAuthn credentials (A8) — biometric/security-key unlock for
   *  the browser UI. Authenticates access to the server, not cortex decryption. */
  readonly webauthnCredentials: WebAuthnCredentialStore;
  /** Connector file→source map — only used by connectors in opt-in mirror mode
   *  (prune/update on file delete/modify). */
  readonly connectorFileMap: ConnectorFileMapStore;
  /** Temporal Job Memory — deadline / renewal / review-by index keyed by nodeId. */
  readonly obligationIndex: ObligationIndex;
  private policyCfg: policy.PolicyConfig;
  // Mutable so runtime model switches (Settings → Search model) can update
  // them without rebuilding the host. The actual re-embed of every graph
  // is driven by reembedAllGraphs() below; these fields keep the in-memory
  // values in sync so subsequent load/build calls use the new id + dim + fn.
  private embed: embeddings.EmbedFn;
  /** Background-lane embed — targets a dedicated worker slot to avoid
   *  blocking the foreground lane during boot-time buildEmbeddings. */
  private embedBackground: embeddings.EmbedFn;
  private embedAdapterId: string;
  private embedDimensions: number;
  private settings: settingsMod.AppSettings;
  /** Optional filesystem watcher — see SourceLifecycleListener. Null when
   *  the watcher feature isn't wired (smoke tests, headless tools). */
  private fileWatcher: SourceLifecycleListener | null = null;
  /** Settings-change listeners — fired AFTER persistence + in-memory swap
   *  so consumers (the file-watcher) always see the canonical new value. */
  private readonly settingsListeners = new Set<(s: settingsMod.AppSettings) => void>();
  /**
   * Serialises concurrent setSettings() calls.
   *
   * Problem: the brain engine fires frequent background writes
   * (`{ brain: { lastVitality, lastRun, … } }`) that read this.settings
   * BEFORE a concurrent user-initiated write has committed its result.
   * The stale merge then wins the disk race and clobbers fields like
   * `ai.autoReingestOnFileChange` that the user just changed.
   *
   * Fix: chain every setSettings call onto the previous one so each
   * write starts only after the prior write has committed to both disk
   * and this.settings. The merge inside each call therefore always sees
   * the latest committed state, never a stale snapshot.
   */
  private settingsWriteQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly opts: HostOptions,
    derived: crypto.DerivedKey,
    settings: settingsMod.AppSettings,
    private readonly deviceIdentity: DeviceIdentity,
  ) {
    this.key = derived.key;
    this.salt = derived.salt;
    // Surface any peer-key tamper alerts found while reconciling the synced
    // device registry (a changed public key for a previously-pinned device).
    for (const alert of deviceIdentity.peerKeyAlerts) {
      console.error(`[graphnosis-host] op-log integrity: ${alert.detail}`);
    }
    this.oplogWriter = new OpLogWriter({
      dir: path.join(opts.cortexDir, 'oplog'),
      deviceId: deviceIdentity.deviceId,
      key: this.key,
      salt: this.salt,
      signSecretKey: deviceIdentity.signSecretKey,
      initialSeq: deviceIdentity.initialSeq,
      persistSeq: deviceIdentity.persistSeq,
    });
    // Intercept every emit to advance the write-seq, so listOplogEvents() knows
    // the cached read is stale ONLY after an actual write — not on a timer.
    // (All op writes in this host go through this.oplogWriter.emit(...), so this
    // single wrap covers them centrally without touching each call site.)
    {
      const rawEmit = this.oplogWriter.emit.bind(this.oplogWriter);
      this.oplogWriter.emit = (...args: Parameters<typeof rawEmit>) => {
        this._oplogWriteSeq++;
        return rawEmit(...args);
      };
    }
    this.gllWriter = new GllWriter(opts.cortexDir, this.key, this.salt);
    this.skillSnapshots = new SkillSnapshotStore({
      cortexDir: opts.cortexDir,
      key: this.key,
      salt: this.salt,
    });
    this.skillCallLinks = new SkillCallLinkStore({
      cortexDir: opts.cortexDir,
      key: this.key,
      salt: this.salt,
    });
    this.skillRuns = new SkillRunStore({
      cortexDir: opts.cortexDir,
      key: this.key,
      salt: this.salt,
    });
    this.webauthnCredentials = new WebAuthnCredentialStore({
      cortexDir: opts.cortexDir,
      key: this.key,
      salt: this.salt,
    });
    this.connectorFileMap = new ConnectorFileMapStore({
      cortexDir: opts.cortexDir,
      key: this.key,
      salt: this.salt,
    });
    this.obligationIndex = new ObligationIndex({
      cortexDir: opts.cortexDir,
      key: this.key,
      salt: this.salt,
    });
    this.embed = opts.embed ?? stubEmbed;
    // Background lane: use the dedicated background embed when provided;
    // fall back to the foreground embed (single-worker setups).
    this.embedBackground = opts.embedBackground ?? this.embed;
    this.embedAdapterId = opts.embedAdapterId ?? 'graphnosis-app:stub@384';
    this.embedDimensions = opts.embedDimensions ?? 384;
    this.settings = settings;
    // Seed policy from settings-persisted tiers. Env-supplied policy entries win
    // (power-user / admin override path); settings fill in the rest.
    const base = opts.policy ?? { defaultBudget: policy.DEFAULT_BUDGET, graphs: [] };
    const envGraphIds = new Set(base.graphs.map((g) => g.graphId));
    const schema = this.complianceSchema();
    const fromSettings: policy.GraphPolicy[] = Object.entries(settings.graphMetadata)
      .filter(([id, m]) => m.sensitivityTier && !envGraphIds.has(id))
      .map(([id, m]) => ({
        graphId: id,
        tier: effectiveSensitivityTier(m, schema) as policy.SensitivityTier,
        shareWithAi: effectiveSensitivityTier(m, schema) !== 'sensitive',
      }));
    this.policyCfg = { ...base, graphs: [...base.graphs, ...fromSettings] };
  }

  static async open(opts: HostOptions): Promise<OpenResult> {
    await fs.mkdir(opts.cortexDir, { recursive: true });
    const saltPath = path.join(opts.cortexDir, 'salt.bin');
    const masterEncPath = path.join(opts.cortexDir, 'master.enc');
    const federatedEncPath = federatedMasterPath(opts.cortexDir);
    const recoveryEncPath = path.join(opts.cortexDir, 'recovery.enc');

    // ── cortex unlock architecture ──────────────────────────────────────
    //
    // Two-tier key model (industry standard):
    //   passphrase ──Argon2id──▶ wrapKey ──decrypts──▶ master.enc ──▶ dataKey
    //   recovery phrase ──Argon2id──▶ recoveryWrapKey ──▶ recovery.enc ──▶ same dataKey
    //
    // The dataKey is persistent for the lifetime of the cortex and is what
    // every other file is encrypted with. The passphrase only derives a
    // *wrap* key that opens master.enc. This makes "change passphrase"
    // an instant operation: rewrap master.enc with a wrap key from the new
    // passphrase. The dataKey, and therefore every encrypted file, is
    // untouched.
    //
    // Legacy cortexes (created before v0.3 added master.enc) have NO
    // master.enc — the passphrase-derived key IS the dataKey. We detect
    // this on first open with the new code and write master.enc using the
    // legacy dataKey both as the value AND as the wrap key (since they're
    // equal in the legacy model). After this migration, the cortex is
    // indistinguishable from one that started with the new format.
    //
    // recovery.enc was always a separate wrap; it works the same in both
    // models because it already wraps the dataKey directly.

    let salt: Uint8Array | undefined;
    try {
      salt = new Uint8Array(await fs.readFile(saltPath));
    } catch {
      // first run: salt doesn't exist yet
    }

    let dataKey: Uint8Array;
    let derivedSalt: Uint8Array;
    let recoveryPhrase: string | undefined;

    if (opts.recoveryPhrase) {
      // ── Recovery path ──────────────────────────────────────────────────
      if (!salt) {
        throw new Error(
          'Cannot recover: cortex salt.bin not found. ' +
          'This cortex may not have been initialized yet.',
        );
      }
      let recoveryBlob: Uint8Array;
      try {
        recoveryBlob = new Uint8Array(await fs.readFile(recoveryEncPath));
      } catch {
        throw new Error(
          'Cannot recover: recovery.enc not found in this cortex folder. ' +
          'This cortex may have been created before recovery was supported.',
        );
      }
      dataKey = await decrypt(recoveryBlob, opts.recoveryPhrase);
      derivedSalt = salt;
    } else if (!salt) {
      // ── First run: brand-new cortex ───────────────────────────────────
      // Derive the passphrase wrap key (this also generates the salt).
      const wrap = await deriveKey(opts.passphrase);
      derivedSalt = wrap.salt;

      // Generate a fresh, random data key. This is what every other file
      // in the cortex will be encrypted with for the rest of its life.
      dataKey = randomBytes(32);

      // Write salt.bin (atomic).
      await writeFileAtomic(saltPath, Buffer.from(derivedSalt));

      // Write master.enc: dataKey wrapped with passphrase wrap key.
      const masterBlob = await encrypt(dataKey, wrap.key, wrap.salt);
      await writeFileAtomic(masterEncPath, Buffer.from(masterBlob));

      // Generate the 24-word BIP-39 recovery phrase (256-bit entropy) and
      // write recovery.enc: dataKey wrapped with recovery-phrase wrap key.
      // NOTE: we call deriveKey ONCE for the phrase, not twice. The SDK's
      // makeRecoveryWrap() has a double-derivation bug, so we use the
      // lower-level primitives directly to guarantee correctness.
      recoveryPhrase = generateMnemonic(wordlist, 256);
      const recDerived = await deriveKey(recoveryPhrase);
      const recBlob = await encrypt(dataKey, recDerived.key, recDerived.salt);
      await writeFileAtomic(recoveryEncPath, Buffer.from(recBlob));
    } else {
      // ── Returning user: salt exists ───────────────────────────────────
      const useFederated = Boolean(opts.federatedUnlockKey?.length) && !opts.recoveryPhrase;
      const wrap = useFederated
        ? await deriveKey(opts.federatedUnlockKey!, salt)
        : await deriveKey(opts.passphrase, salt);
      derivedSalt = salt;

      // Check whether this cortex has been migrated to the master.enc model.
      let masterBlob: Uint8Array | null = null;
      let federatedBlob: Uint8Array | null = null;
      try {
        if (useFederated) {
          federatedBlob = new Uint8Array(await fs.readFile(federatedEncPath));
        } else {
          masterBlob = new Uint8Array(await fs.readFile(masterEncPath));
        }
      } catch {
        // master.enc / federated.master.enc absent
      }

      if (useFederated) {
        if (!federatedBlob) {
          throw new Error(
            'FATAL: federated SSO unlock is not provisioned for this cortex. ' +
            'Ask the cortex owner to enable Enterprise SSO while unlocked.',
          );
        }
        try {
          dataKey = await decrypt(federatedBlob, wrap.key);
        } catch (e) {
          throw new Error(
            `FATAL: federated SSO unlock failed: Decryption failed ` +
            `(wrong org key or federated.master.enc tampered): ${(e as Error).message}`,
          );
        }
      } else if (masterBlob) {
        // New-format cortex: unwrap dataKey from master.enc.
        try {
          dataKey = await decrypt(masterBlob, wrap.key);
        } catch (e) {
          // Wrong passphrase OR corrupt master.enc. Preserve the legacy
          // error string so the Rust stderr classifier keeps surfacing
          // "Wrong passphrase" to the user.
          throw new Error(
            `FATAL: failed to load existing graph: Decryption failed ` +
            `(wrong passphrase or master.enc tampered): ${(e as Error).message}`,
          );
        }
      } else {
        // ── Legacy cortex migration ────────────────────────────────────
        // Pre-v0.3 cortexes: the passphrase-derived key IS the dataKey.
        // Adopt it, then write master.enc so future opens use the new
        // path and a passphrase rotation becomes possible.
        dataKey = wrap.key;
        const newMasterBlob = await encrypt(dataKey, wrap.key, wrap.salt);
        try {
          await writeFileAtomic(masterEncPath, Buffer.from(newMasterBlob));
          console.error(
            '[graphnosis-host] migrated cortex to wrapped-key format ' +
            '(master.enc) — passphrase changes are now supported.',
          );
        } catch (e) {
          // Migration write failure is non-fatal; the cortex unlocks fine
          // without master.enc, and we'll try again on the next launch.
          console.error(
            `[graphnosis-host] could not write master.enc during migration: ` +
            `${(e as Error).message} — will retry next open.`,
          );
        }

        // ── Recovery phrase backfill ────────────────────────────────────
        // Legacy cortexes also predate the 24-word recovery phrase. Generate
        // one now so the user gets the same fallback as a fresh cortex.
        // Skip if recovery.enc already exists (e.g. from a partial earlier
        // migration on a previous launch).
        let recoveryEncExists = false;
        try {
          await fs.access(recoveryEncPath);
          recoveryEncExists = true;
        } catch { /* doesn't exist yet — good, we'll create it */ }
        if (!recoveryEncExists) {
          try {
            const phrase = generateMnemonic(wordlist, 256);
            const recDerived = await deriveKey(phrase);
            const recBlob = await encrypt(dataKey, recDerived.key, recDerived.salt);
            await writeFileAtomic(recoveryEncPath, Buffer.from(recBlob));
            recoveryPhrase = phrase;
            console.error(
              '[graphnosis-host] generated recovery phrase for legacy cortex ' +
              '— will be shown once via cortex.created event.',
            );
          } catch (e) {
            // Don't leak a phrase the disk doesn't have.
            recoveryPhrase = undefined;
            console.error(
              `[graphnosis-host] could not backfill recovery.enc for legacy cortex: ` +
              `${(e as Error).message} — will retry next open.`,
            );
          }
        }
      }
    }

    const derived: crypto.DerivedKey = {
      key: dataKey,
      salt: derivedSalt,
      opslimit: 0,
      memlimit: 0,
    };

    const settings = await settingsMod.loadSettings(opts.cortexDir);
    // Decrypt connector credentials with the cortex data key before handing
    // settings to the host. On-disk credentialsEnc → in-memory credentials.
    // Legacy plaintext-credentials configs (pre-v0.6.1) pass through
    // unchanged and get re-saved encrypted on the next setSettings() call.
    const withCreds = await decryptConnectorCredentialsInSettings(settings, dataKey);
    // Decrypt the network bridge bearer tokens (mobile / HTTP-UI / VS Code) the
    // same way: on-disk `*Enc` → in-memory plaintext. Legacy plaintext tokens
    // pass through and re-encrypt on the next persistSettings() call.
    const decryptedSettings = await decryptBridgeTokensInSettings(withCreds, dataKey);
    const withSso = await decryptSsoSecretsInSettings(decryptedSettings, dataKey);
    const withModelKeys = await decryptModelProviderKeysInSettings(withSso, dataKey);
    // Load (or create on first unlock) this install's stable device identity:
    // a persisted deviceId, an Ed25519 keypair (secret encrypted under dataKey),
    // the op-log sequence counter, and the TOFU registry of peer device keys.
    const deviceIdentity = await DeviceIdentity.loadOrCreate(opts.cortexDir, dataKey);
    const host = new GraphnosisHost(opts, derived, withModelKeys, deviceIdentity);
    return recoveryPhrase ? { host, recoveryPhrase } : { host };
  }

  /**
   * Generate a fresh 24-word BIP-39 recovery phrase, wrap the (unchanged)
   * data key with it, and atomically replace `recovery.enc`. Returns the
   * new phrase so the UI can show it to the user once.
   *
   * The dataKey is preserved — every encrypted file in the cortex still
   * decrypts with the same key. Only `recovery.enc` (the wrapped backup)
   * is replaced. The OLD recovery phrase, whatever it was, no longer
   * unwraps anything in this cortex; the NEW phrase is the only fallback
   * to the passphrase from this point on.
   *
   * Use cases:
   *   - Legacy cortex where the one-time modal didn't show / wasn't seen
   *   - User believes the old phrase was exposed and wants to rotate
   *   - Periodic refresh as part of a security hygiene routine
   */
  async regenerateRecoveryPhrase(): Promise<string> {
    const recoveryEncPath = path.join(this.opts.cortexDir, 'recovery.enc');
    const phrase = generateMnemonic(wordlist, 256);
    const recDerived = await deriveKey(phrase);
    const recBlob = await encrypt(this.key, recDerived.key, recDerived.salt);
    await writeFileAtomic(recoveryEncPath, Buffer.from(recBlob));
    console.error('[graphnosis-host] regenerated recovery.enc — old phrase no longer valid.');
    return phrase;
  }

  /**
   * Provision or rotate the federated org unlock key used for IdP-gated unlock.
   * Writes `federated.master.enc` wrapping the current dataKey. Owner-only.
   */
  async provisionFederatedUnlockKey(existingKey?: string): Promise<{ federatedUnlockKey: string }> {
    const key = existingKey?.trim() || generateFederatedUnlockKey();
    const wrap = await deriveKey(key, this.salt);
    const blob = await encrypt(this.key, wrap.key, wrap.salt);
    await writeFileAtomic(federatedMasterPath(this.opts.cortexDir), Buffer.from(blob));
    const current = this.settings;
    await this.setSettings({
      sso: {
        ...(current.sso ?? { enabled: false, protocol: 'oidc', breakGlassPassphrase: true, groupRoleMappings: [] }),
        federatedUnlockReady: true,
        federatedUnlockKey: key,
      },
    }, { userInitiated: true });
    console.error(`[graphnosis-host] provisioned ${FEDERATED_MASTER_FILE} for federated SSO unlock.`);
    return { federatedUnlockKey: key };
  }

  /** Generate an org Ed25519 signing keypair for evidence-pack co-signing. */
  async provisionOrgSigningKey(): Promise<{ publicKey: string; secretKey: string }> {
    const kp = await crypto.generateSigningKeyPair();
    const publicKey = Buffer.from(kp.publicKey).toString('base64');
    const secretKey = Buffer.from(kp.secretKey).toString('base64');
    return { publicKey, secretKey };
  }

  /**
   * — and therefore every other file in the cortex — is unchanged. Recovery
   * phrase remains valid: it still unwraps the (unchanged) dataKey via
   * recovery.enc.
   *
   * Throws if the cortex hasn't yet been migrated to the master.enc model.
   * Legacy cortexes auto-migrate on their next normal unlock; user just
   * needs to lock and unlock once before changing the passphrase.
   *
   * Throws if `oldPassphrase` doesn't decrypt the current master.enc — this
   * prevents a recovery-mode-unlocked session from silently rotating to a
   * passphrase that wouldn't actually unlock the cortex. The caller is
   * expected to verify the recovery flow's "are you sure you want to change
   * the passphrase?" path: in recovery mode there's no old passphrase to
   * supply, so the caller should set `skipOldPassphraseCheck: true` and
   * provide ONLY the new passphrase. (The recovery phrase itself authorizes
   * the rotation in that case.)
   */
  async changePassphrase(
    newPassphrase: string,
    opts?: { oldPassphrase?: string; skipOldPassphraseCheck?: boolean },
  ): Promise<void> {
    const masterEncPath = path.join(this.opts.cortexDir, 'master.enc');
    const saltPath = path.join(this.opts.cortexDir, 'salt.bin');

    // Sanity: master.enc must exist (migration must have happened).
    let masterBlob: Uint8Array;
    try {
      masterBlob = new Uint8Array(await fs.readFile(masterEncPath));
    } catch {
      throw new Error(
        'Cannot change passphrase: this cortex has not yet been migrated to ' +
        'the wrapped-key format. Lock and unlock the cortex once with your ' +
        'current passphrase to migrate, then try again.',
      );
    }

    // Verify old passphrase if provided (normal path) or skipped (recovery path).
    if (!opts?.skipOldPassphraseCheck) {
      const oldPassphrase = opts?.oldPassphrase;
      if (oldPassphrase === undefined) {
        throw new Error(
          'changePassphrase: old passphrase is required unless skipOldPassphraseCheck is set.',
        );
      }
      const oldWrap = await deriveKey(oldPassphrase, this.salt);
      let oldDataKey: Uint8Array;
      try {
        oldDataKey = await decrypt(masterBlob, oldWrap.key);
      } catch {
        throw new Error('Old passphrase is incorrect.');
      }
      // Defence-in-depth: the unwrapped dataKey must match the host's
      // in-memory key. If it doesn't, something is very wrong — refuse to
      // proceed rather than silently corrupt the cortex.
      if (!buffersEqual(oldDataKey, this.key)) {
        throw new Error(
          'Integrity check failed: master.enc decrypts to a different key ' +
          'than the host has in memory. Aborting passphrase change.',
        );
      }
    }

    // Derive the new wrap key. We reuse the current salt — Argon2id with a
    // different passphrase produces a fresh key, and reusing the salt keeps
    // the rotation atomic (one file write instead of two). Future key
    // rotation can refresh the salt as part of a heavier flow.
    const newWrap = await deriveKey(newPassphrase, this.salt);
    const newMasterBlob = await encrypt(this.key, newWrap.key, newWrap.salt);

    // Atomic write — a crash mid-rename leaves the old master.enc intact.
    await writeFileAtomic(masterEncPath, Buffer.from(newMasterBlob));

    // salt.bin doesn't need to change (we reused the salt), but touch it to
    // refresh its mtime — useful for backup tools and debugging.
    try { await fs.utimes(saltPath, new Date(), new Date()); } catch { /* fine */ }
  }

  // ── Settings ────────────────────────────────────────────────────────────

  getSettings(): settingsMod.AppSettings {
    return this.settings;
  }

  /** Absolute path to the cortex root. Exposed for IPC handlers that need
   *  to enumerate or operate on files outside the host's encrypted graph
   *  abstraction — e.g. listing `.gai.corrupt-*` quarantine artifacts. */
  getCortexDir(): string {
    return this.opts.cortexDir;
  }

  // ── Healing journal ──────────────────────────────────────────────────────
  //
  // The Autonomous Brain's auto-heal log lives in `<cortex>/healing-journal.enc`,
  // encrypted with the cortex data key. The host owns the filesystem + key
  // wiring; the record shape + encode/decode logic live in healing-journal.ts.
  // BrainEngine holds the journal in memory and calls these on boot + after
  // each heal — same pattern as how it owns `this.duplicatePairs`.

  /** Load + decrypt the healing journal. Returns [] if none exists yet. */
  async loadHealingJournal(): Promise<healingJournalMod.HealingRecord[]> {
    const file = path.join(this.opts.cortexDir, healingJournalMod.HEALING_JOURNAL_FILE);
    let blob: Buffer;
    try {
      blob = await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      console.error(`[host] could not read healing journal: ${(e as Error).message}`);
      return [];
    }
    return healingJournalMod.decodeHealingJournal(new Uint8Array(blob), this.key);
  }

  /** Encrypt + atomically write the healing journal. */
  async saveHealingJournal(records: healingJournalMod.HealingRecord[]): Promise<void> {
    const file = path.join(this.opts.cortexDir, healingJournalMod.HEALING_JOURNAL_FILE);
    const blob = await healingJournalMod.encodeHealingJournal(records, this.key);
    await writeFileAtomic(file, Buffer.from(blob));
  }

  // ── Brain insights ───────────────────────────────────────────────────────
  //
  // Insights are AI-generated observations (patterns, gaps, opportunities,
  // conflicts) produced by the local LLM over the user's engrams. They are
  // stored as plain JSON — no encryption — since they are LLM output derived
  // from the user's memory, not attested memory itself. Same pattern as
  // healing journal but simpler (no custom binary codec needed).

  private static readonly INSIGHTS_FILE = 'brain-insights.json';

  /** Load persisted insights. Returns [] if no file exists yet. */
  async loadInsights<T>(): Promise<T[]> {
    const file = path.join(this.opts.cortexDir, GraphnosisHost.INSIGHTS_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      console.error(`[host] could not read brain insights: ${(e as Error).message}`);
      return [];
    }
    try {
      return JSON.parse(raw) as T[];
    } catch {
      console.error('[host] brain-insights.json is malformed — starting fresh');
      return [];
    }
  }

  /** Atomically write insights to disk. */
  async saveInsights<T>(insights: T[]): Promise<void> {
    const file = path.join(this.opts.cortexDir, GraphnosisHost.INSIGHTS_FILE);
    await writeFileAtomic(file, Buffer.from(JSON.stringify(insights)));
  }

  private static readonly CONTRADICTIONS_FILE = 'brain-contradictions.json';
  private static readonly CONTRADICTION_DISMISSALS_FILE = 'brain-contradiction-dismissals.json';

  /** Load persisted contradiction review queue. Returns [] if no file exists yet. */
  async loadContradictionPairs<T>(): Promise<T[]> {
    const file = path.join(this.opts.cortexDir, GraphnosisHost.CONTRADICTIONS_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      console.error(`[host] could not read brain contradictions: ${(e as Error).message}`);
      return [];
    }
    try {
      return JSON.parse(raw) as T[];
    } catch {
      console.error('[host] brain-contradictions.json is malformed — starting fresh');
      return [];
    }
  }

  /** Atomically write contradiction queue to disk. */
  async saveContradictionPairs<T>(pairs: T[]): Promise<void> {
    const file = path.join(this.opts.cortexDir, GraphnosisHost.CONTRADICTIONS_FILE);
    await writeFileAtomic(file, Buffer.from(JSON.stringify(pairs)));
  }

  /** Persisted dismissal keys — pairs the user marked debate / both true. */
  async loadContradictionDismissals(): Promise<string[]> {
    const file = path.join(this.opts.cortexDir, GraphnosisHost.CONTRADICTION_DISMISSALS_FILE);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return [];
    }
  }

  async saveContradictionDismissals(keys: string[]): Promise<void> {
    const file = path.join(this.opts.cortexDir, GraphnosisHost.CONTRADICTION_DISMISSALS_FILE);
    await writeFileAtomic(file, Buffer.from(JSON.stringify(keys)));
  }

  private static readonly SUPPRESSED_CONTRADICTIONS_FILE = 'brain-contradictions-suppressed.json';

  /** Load the triage-suppressed contradiction audit ring. [] if none exists yet. */
  async loadSuppressedContradictions<T>(): Promise<T[]> {
    const file = path.join(this.opts.cortexDir, GraphnosisHost.SUPPRESSED_CONTRADICTIONS_FILE);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      console.error(`[host] could not read suppressed contradictions: ${(e as Error).message}`);
      return [];
    }
    try {
      return JSON.parse(raw) as T[];
    } catch {
      console.error('[host] brain-contradictions-suppressed.json is malformed — starting fresh');
      return [];
    }
  }

  /** Atomically write the suppressed-contradiction audit ring to disk. */
  async saveSuppressedContradictions<T>(items: T[]): Promise<void> {
    const file = path.join(this.opts.cortexDir, GraphnosisHost.SUPPRESSED_CONTRADICTIONS_FILE);
    await writeFileAtomic(file, Buffer.from(JSON.stringify(items)));
  }

  /** Load + decrypt the cross-engram connection store. [] if none exists yet. */
  async loadConnectionStore(): Promise<connectionStoreMod.CrossEngramConnection[]> {
    const file = path.join(this.opts.cortexDir, connectionStoreMod.CROSS_ENGRAM_CONNECTIONS_FILE);
    let blob: Buffer;
    try {
      blob = await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      console.error(`[host] could not read connection store: ${(e as Error).message}`);
      return [];
    }
    return connectionStoreMod.decodeConnectionStore(new Uint8Array(blob), this.key);
  }

  /** Encrypt + atomically write the cross-engram connection store. */
  async saveConnectionStore(connections: connectionStoreMod.CrossEngramConnection[]): Promise<void> {
    const file = path.join(this.opts.cortexDir, connectionStoreMod.CROSS_ENGRAM_CONNECTIONS_FILE);
    const blob = await connectionStoreMod.encodeConnectionStore(connections, this.key);
    await writeFileAtomic(file, Buffer.from(blob));
  }

  /** Load + decrypt the association index. [] if none exists yet. */
  async loadAssociationIndex(): Promise<associationIndexMod.AssociationEntry[]> {
    const file = path.join(this.opts.cortexDir, associationIndexMod.ASSOCIATION_INDEX_FILE);
    let blob: Buffer;
    try {
      blob = await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      console.error(`[host] could not read association index: ${(e as Error).message}`);
      return [];
    }
    return associationIndexMod.decodeAssociationIndex(new Uint8Array(blob), this.key);
  }

  /** Encrypt + atomically write the association index. */
  async saveAssociationIndex(entries: associationIndexMod.AssociationEntry[]): Promise<void> {
    const file = path.join(this.opts.cortexDir, associationIndexMod.ASSOCIATION_INDEX_FILE);
    const blob = await associationIndexMod.encodeAssociationIndex(entries, this.key);
    await writeFileAtomic(file, Buffer.from(blob));
  }

  /** Load + decrypt the Graphnosis Neural Network overlay. [] if none yet. */
  async loadGnnStore(): Promise<gnnStoreMod.PredictedEdge[]> {
    const file = path.join(this.opts.cortexDir, gnnStoreMod.GNN_STORE_FILE);
    let blob: Buffer;
    try {
      blob = await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      console.error(`[host] could not read GNN overlay: ${(e as Error).message}`);
      return [];
    }
    return gnnStoreMod.decodeGnnStore(new Uint8Array(blob), this.key);
  }

  /** Encrypt + atomically write the Graphnosis Neural Network overlay. */
  async saveGnnStore(edges: gnnStoreMod.PredictedEdge[]): Promise<void> {
    const file = path.join(this.opts.cortexDir, gnnStoreMod.GNN_STORE_FILE);
    const blob = await gnnStoreMod.encodeGnnStore(edges, this.key);
    await writeFileAtomic(file, Buffer.from(blob));
  }

  /** Load + decrypt the Graphnosis Local Layer (LLM overlay). Empty if none yet. */
  async loadGllOverlay(): Promise<{ edges: gllOverlayMod.GllPredictedEdge[]; assertions: gllOverlayMod.GllAssertion[] }> {
    const file = path.join(this.opts.cortexDir, gllOverlayMod.GLL_OVERLAY_FILE);
    let blob: Buffer;
    try {
      blob = await fs.readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { edges: [], assertions: [] };
      console.error(`[host] could not read GLL overlay: ${(e as Error).message}`);
      return { edges: [], assertions: [] };
    }
    return gllOverlayMod.decodeGllOverlay(new Uint8Array(blob), this.key);
  }

  /** Encrypt + atomically write the Graphnosis Local Layer (LLM overlay). */
  async saveGllOverlay(
    edges: gllOverlayMod.GllPredictedEdge[],
    assertions: gllOverlayMod.GllAssertion[],
  ): Promise<void> {
    const file = path.join(this.opts.cortexDir, gllOverlayMod.GLL_OVERLAY_FILE);
    const blob = await gllOverlayMod.encodeGllOverlay(edges, assertions, this.key);
    await writeFileAtomic(file, Buffer.from(blob));
  }

  /**
   * Append a synthesized assertion to the GLL overlay. Assertions are
   * LLM-derived facts that draw from existing nodes but aren't anchored to
   * any single source — distinct from attested .gai nodes. They surface in
   * recall with the [gll·assertion N%] badge and are explicitly NOT to be
   * `remember`'d into canonical memory by AI clients (that would promote a
   * prediction into truth, breaking the overlay invariant).
   *
   * Caller responsibility:
   *   - `derivedFrom`: ideally a non-empty list of canonical node ids that
   *     supported the assertion. Empty arrays are allowed (pure synthesis)
   *     but the merge layer will be less useful — assertions get surfaced
   *     when their `derivedFrom` intersects the recall result.
   *   - `score`: model confidence 0-1. Used in the [gll·assertion N%] badge.
   *
   * Returns the new assertion (with its generated id).
   */
  async addGllAssertion(input: {
    graphId: GraphId;
    content: string;
    derivedFrom: string[];
    score: number;
    modelTag?: string;
  }): Promise<gllOverlayMod.GllAssertion> {
    // Validate graphId exists — refuse to attach assertions to engrams the
    // user has deleted. Avoids orphan overlay entries.
    if (!this.graphs.has(input.graphId)) {
      throw new Error(`addGllAssertion: unknown engram ${input.graphId}`);
    }
    const assertion = gllOverlayMod.makeGllAssertion({
      graphId: input.graphId,
      content: input.content.trim(),
      derivedFrom: input.derivedFrom,
      score: Math.max(0, Math.min(1, input.score)),
      createdAt: Date.now(),
      ...(input.modelTag !== undefined ? { modelTag: input.modelTag } : {}),
    });
    const current = await this.loadGllOverlay();
    await this.saveGllOverlay(current.edges, [...current.assertions, assertion]);
    return assertion;
  }

  /** Remove an assertion from the GLL overlay by id. Used by the UI's
   *  reject/dismiss path on the assertion review surface. */
  async removeGllAssertion(assertionId: string): Promise<{ ok: boolean }> {
    const current = await this.loadGllOverlay();
    const remaining = current.assertions.filter((a) => a.id !== assertionId);
    if (remaining.length === current.assertions.length) return { ok: false };
    await this.saveGllOverlay(current.edges, remaining);
    return { ok: true };
  }

  /**
   * Copy every engram's `.gai` file into `<cortexDir>/snapshots/<label>-<ts>/`
   * — the safety snapshot taken before the Graphnosis Neural Network is first
   * enabled, so the pre-neural-network graph state is preserved on disk.
   * Returns the snapshot directory path.
   */
  async snapshotGraphs(label: string): Promise<string> {
    // Flush any dirty in-memory graphs first so the snapshot captures the
    // CURRENT state. snapshotGraphs only copies the on-disk `.gai` files, so
    // without this an engram mutated since its last save (the normal case
    // right after an ingest) would be snapshotted stale — or skipped entirely
    // if it has never been persisted. save() is a no-op for clean graphs.
    for (const graphId of this.graphs.keys()) {
      await this.save(graphId);
    }
    const safe = `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}`;
    const graphsDir = path.join(this.opts.cortexDir, 'graphs');
    // Unified snapshot location: .snapshots/ matches the existing
    // listSnapshots() helper + the Rust list_snapshots Tauri command, so
    // pre-operation safety snapshots (GNN enable, embedding migration,
    // reingest-all, restore-safety) become visible in the Snapshots panel.
    const destDir = path.join(this.opts.cortexDir, '.snapshots', safe);
    await fs.mkdir(destDir, { recursive: true });
    let files: string[];
    try {
      files = await fs.readdir(graphsDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return destDir;
      throw e;
    }
    for (const f of files) {
      if (!f.endsWith('.gai')) continue;
      await fs.copyFile(path.join(graphsDir, f), path.join(destDir, f));
    }
    return destDir;
  }

  /**
   * Restore every .gai file from a snapshot. Copies them over the current
   * canonical paths under `<cortex>/graphs/`, then drops the in-memory graph
   * cache so the next access reloads from the restored disk state. Returns
   * the count of files restored.
   *
   * Safety:
   *   - Takes a NEW snapshot of the current state first ("pre-restore-<label>")
   *     so the restore itself is reversible if the user clicked the wrong row.
   *   - Skips engrams currently being mutated by an in-flight save (best
   *     effort via `dirty` flag — concurrent writes during a restore are
   *     not supported and the UI should disable other actions while this runs).
   */
  async restoreSnapshot(snapshotLabel: string): Promise<{ restored: number; safetySnapshot: string }> {
    // Defensive: snapshot label MUST be a plain folder name with no path
    // separators or `..` — anything else and we refuse, no matter how the
    // request reached us. Eliminates path-traversal risk from the IPC
    // surface.
    if (snapshotLabel.includes('/') || snapshotLabel.includes('\\') || snapshotLabel.includes('..')) {
      throw new Error(`invalid snapshot label: ${snapshotLabel}`);
    }
    // Unified `.snapshots/` location — matches listSnapshots() + snapshotGraphs().
    const snapshotsDir = path.join(this.opts.cortexDir, '.snapshots');
    const normalized = path.join(snapshotsDir, snapshotLabel);
    // Step 1: safety snapshot of current state so this operation is undoable.
    const safetySnapshot = await this.snapshotGraphs(`pre-restore-${snapshotLabel}`);
    // Step 2: copy snapshot .gai files over the canonical graphs/ directory.
    const graphsDir = path.join(this.opts.cortexDir, 'graphs');
    await fs.mkdir(graphsDir, { recursive: true });
    let files: string[];
    try {
      files = await fs.readdir(normalized);
    } catch (e) {
      throw new Error(`snapshot directory unreadable: ${(e as Error).message}`);
    }
    let restored = 0;
    for (const f of files) {
      if (!f.endsWith('.gai')) continue;
      await fs.copyFile(path.join(normalized, f), path.join(graphsDir, f));
      restored += 1;
    }
    // Step 3: drop in-memory graph cache so next loadGraph reads fresh from disk.
    // The brain engine's reinforcement / cross-engram stores reference node ids
    // that may no longer exist in the restored state — we don't proactively
    // prune them; subsequent passes will skip stale entries naturally.
    this.graphs.clear();
    invalidateQueryEnrichmentCache();
    console.error(`[host] restored ${restored} engram(s) from snapshot ${snapshotLabel}; in-memory cache cleared, next access reloads from disk`);
    return { restored, safetySnapshot };
  }

  /** Permanently delete a snapshot directory by label (folder name). */
  async deleteSnapshot(snapshotLabel: string): Promise<void> {
    if (snapshotLabel.includes('/') || snapshotLabel.includes('\\') || snapshotLabel.includes('..')) {
      throw new Error(`invalid snapshot label: ${snapshotLabel}`);
    }
    const snapshotsDir = path.join(this.opts.cortexDir, '.snapshots');
    const target = path.join(snapshotsDir, snapshotLabel);
    await fs.rm(target, { recursive: true, force: true });
  }

  // ── Embedding adapter switch (runtime model swap) ───────────────────────
  //
  // Update the in-memory embed function + adapter id + dimensions. Does NOT
  // re-embed any graph on its own — call `reembedAllGraphs()` afterwards to
  // rebuild every engram's vector index against the new model. Splitting
  // these lets the caller stage the switch (snapshot → set adapter → re-embed
  // with progress events) without the host imposing the order.
  setEmbedAdapter(embed: embeddings.EmbedFn, adapterId: string, dimensions: number): void {
    this.embed = embed;
    this.embedAdapterId = adapterId;
    this.embedDimensions = dimensions;
    console.error(`[host] embed adapter switched: ${adapterId} (${dimensions}d)`);
  }

  /**
   * Re-build embeddings for every loaded engram against the current
   * `embedAdapterId`. The SDK detects the id change and discards every
   * cached vector before re-running `embed()` over each node's content.
   *
   * Per-engram progress is reported via `onProgress`. Sequential, not
   * parallel — concurrent ONNX inference across multiple workers can race
   * the C++ mutex (see queryChain in recall) and re-embed is heavy enough
   * that throughput is dominated by the worker pool's capacity anyway.
   */
  async reembedAllGraphs(
    onProgress?: (event: { graphId: string; index: number; total: number; nodesInGraph: number }) => void,
    signal?: AbortSignal,
  ): Promise<{ graphsRebuilt: number; cancelled: boolean; errors: Array<{ graphId: string; error: string }> }> {
    const graphIds = this.listGraphs();
    const errors: Array<{ graphId: string; error: string }> = [];
    let rebuilt = 0;
    let cancelled = false;
    for (let i = 0; i < graphIds.length; i++) {
      if (signal?.aborted) { cancelled = true; break; }
      const graphId = graphIds[i]!;
      const g = this.graphs.get(graphId);
      if (!g) continue;
      // Use the inspector to get node count for the progress event.
      const nodes = this.opts.adapter.inspectNodes(g.handle);
      onProgress?.({ graphId, index: i, total: graphIds.length, nodesInGraph: nodes.length });
      try {
        // Reset the embedding cache for this graph — a model change invalidates
        // every cached vector. Without this, the SDK's buildEmbeddings would
        // happily reuse 384-dim vectors against a 1024-dim model and produce
        // a corrupt index.
        g.cache = new EmbeddingCache({ path: this.cachePath(graphId), key: this.key, salt: this.salt });
        await this.opts.adapter.buildEmbeddings(g.handle, {
          embed: cached(this.embed, g.cache),
          dimensions: this.embedDimensions,
          id: this.embedAdapterId,
          batchSize: this.settings.ai.embedBatch,
        });
        g.dirty = true;
        await this.save(graphId);
        rebuilt += 1;
      } catch (e) {
        const error = (e as Error).message;
        console.error(`[host] reembedAllGraphs: engram[${redactId(graphId)}] failed: ${error}`);
        errors.push({ graphId, error });
      }
    }
    // Final progress event so the UI can flip from "embedding…" to "done".
    onProgress?.({ graphId: '', index: graphIds.length, total: graphIds.length, nodesInGraph: 0 });
    return { graphsRebuilt: rebuilt, cancelled, errors };
  }

  // ── Search ──────────────────────────────────────────────────────────────
  //
  // Single-graph semantic search, used by the Nodes view in the App. Calls
  // the SDK's hybrid query (TF-IDF + BGE embeddings — whichever the host
  // booted with) and returns flat top-k results. Distinct from `recall()`,
  // which federates across graphs and applies a subgraph token budget.

  async searchNodes(graphId: GraphId, query: string, k = 30): Promise<Array<{ nodeId: string; score: number; text: string; type?: string }>> {
    const g = this.must(graphId);
    // Over-fetch and filter against the active set, then trim. The SDK's
    // hybrid query returns soft-deleted nodes alongside active ones — we
    // must not surface those to the user / AI client. 3× over-fetch is a
    // pragmatic heuristic: enough to recover real top-k after dropping
    // forgotten matches, without making queries quadratic.
    const active = this.activeNodeIds(graphId);
    const raw = await this.opts.adapter.query(g.handle, query, k * 3);
    return raw
      .filter((r) => active.has(r.nodeId))
      .slice(0, k)
      .map((r) => ({
        nodeId: r.nodeId,
        score: r.score,
        text: r.text,
        ...(r.type !== undefined ? { type: r.type } : {}),
      }));
  }

  /**
   * Single inspectNodes pass for recall — active ID set + full node list.
   * Avoids scanning the same engram twice per recall (active filter + anchoring).
   */
  recallNodeSnapshot(graphId: GraphId): {
    active: Set<string>;
    nodes: ReturnType<GraphnosisAdapter['inspectNodes']>;
  } {
    const g = this.must(graphId);
    const nodes = this.opts.adapter.inspectNodes(g.handle);
    const now = Date.now();
    // Exclude-from-recall toggle: drop nodes belonging to sources the user
    // excluded. Applied ONLY here, so it scopes to recall / dig_deeper / node
    // search — excluded sources still appear in the Sources list, stats, and 3D.
    const excluded = this.settings.graphMetadata[graphId]?.excludedSources;
    const excludedNodes = excluded && excluded.length > 0
      ? new Set(excluded.flatMap((sid) => this.getSourceRecord(graphId, sid)?.nodeIds ?? []))
      : null;
    const active = new Set(
      nodes
        .filter((n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now))
        .filter((n) => !excludedNodes || !excludedNodes.has(n.id))
        .map((n) => n.id),
    );
    return { active, nodes };
  }

  /**
   * Set of currently-active node IDs for a graph. "Active" matches the
   * inspector's definition: confidence > 0.2 AND validUntil is unset or in
   * the future. Used to drop soft-deleted nodes from `recall` and `search`
   * results, which the SDK's hybrid query returns unconditionally.
   */
  private activeNodeIds(graphId: GraphId): Set<string> {
    return this.recallNodeSnapshot(graphId).active;
  }

  /** Inspect every node in a graph, including soft-deleted ones — used by the Nodes table when there's no active search. */
  listNodes(graphId: GraphId): ReturnType<GraphnosisAdapter['inspectNodes']> {
    const g = this.must(graphId);
    const nodes = this.opts.adapter.inspectNodes(g.handle);
    return nodes.map((n) => {
      const ob = this.obligationIndex.get(n.id);
      if (!ob || ob.graphId !== graphId) return n;
      return {
        ...n,
        obligationType: ob.obligationType,
        effectiveDate: ob.effectiveDate,
        expiresAt: ob.expiresAt,
      };
    });
  }

  /** Get the FULL untruncated content of a single node. The general
   *  `listNodes` path returns contentPreview (capped at 500 chars) which
   *  drops the tail of long nodes — getSkill / skill display needs the
   *  whole thing so trailing Goals / Recipes blocks render correctly. */
  getFullNodeContent(graphId: GraphId, nodeId: string): string | null {
    const g = this.must(graphId);
    return this.opts.adapter.getFullNodeContent(g.handle, nodeId);
  }

  /** Return the sourceId that a given node was derived from, or undefined when unknown. */
  getNodeSource(graphId: GraphId, nodeId: string): string | undefined {
    return this.must(graphId).sourceIndex.sourceOf(nodeId);
  }

  /** Dual-graph edges (directed + undirected) — powers the Atlas wire-frame. */
  listEdges(graphId: GraphId): ReturnType<GraphnosisAdapter['inspectEdges']> {
    const g = this.must(graphId);
    return this.opts.adapter.inspectEdges(g.handle);
  }

  /**
   * Raw embedding vectors for all embedded nodes — used by BrainEngine's
   * duplicate scan (cosine pairwise comparison). Returns an empty map
   * when the graph has no embedding index yet.
   */
  getNodeEmbeddings(graphId: GraphId): Map<string, number[]> {
    const g = this.graphs.get(graphId);
    if (!g) return new Map();
    return this.opts.adapter.getNodeEmbeddings(g.handle);
  }

  /**
   * Run the SDK reflection engine over one built engram and return the
   * contradictions it detects (high shared-entity overlap + low content
   * similarity + a conflict signal). Used by BrainEngine's periodic
   * contradiction scan. Returns [] for an unknown or unbuilt graph.
   */
  reflectGraph(graphId: GraphId): import('./graphnosis-adapter.js').ContradictionResult[] {
    const g = this.graphs.get(graphId);
    if (!g) return [];
    return this.opts.adapter.reflectGraph(g.handle);
  }

  /** Active IT classification schema from compliance settings. */
  complianceSchema(): ReturnType<typeof sanitizeClassificationSchema> {
    return sanitizeClassificationSchema(this.settings.compliance?.classificationSchema);
  }

  private patchPolicyTier(graphId: GraphId, meta: settingsMod.GraphMetadata): void {
    const tier = effectiveSensitivityTier(meta, this.complianceSchema());
    const graphs = this.policyCfg.graphs.filter((g) => g.graphId !== graphId);
    graphs.push({ graphId, shareWithAi: tier !== 'sensitive', tier });
    this.policyCfg = { ...this.policyCfg, graphs };
  }

  /** Assign IT classification label — updates metadata tier + live policy. */
  async setGraphClassificationLabel(graphId: GraphId, labelId: string | null): Promise<void> {
    const schema = this.complianceSchema();
    const existing: settingsMod.GraphMetadata = this.settings.graphMetadata[graphId] ?? {
      template: 'personal' as settingsMod.GraphTemplate,
      displayName: graphId,
      createdAt: 0,
    };
    const updated: settingsMod.GraphMetadata = { ...existing };
    if (labelId === null || labelId === '') {
      delete updated.classificationLabelId;
    } else {
      updated.classificationLabelId = labelId;
    }
    const { tier } = resolveClassificationPolicy(updated.classificationLabelId, schema, updated);
    updated.sensitivityTier = tier;
    await this.setGraphMetadata(graphId, updated);
    this.patchPolicyTier(graphId, updated);
  }

  /** Device + optional org Ed25519 signers for compliance evidence packs. */
  getEvidencePackSigners(): Array<{
    kind: 'device' | 'org';
    deviceId?: string;
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }> {
    const out: Array<{
      kind: 'device' | 'org';
      deviceId?: string;
      publicKey: Uint8Array;
      secretKey: Uint8Array;
    }> = [{
      kind: 'device',
      deviceId: this.deviceIdentity.deviceId,
      publicKey: this.deviceIdentity.signPublicKey,
      secretKey: this.deviceIdentity.signSecretKey,
    }];
    const org = this.settings.sso?.orgSignSecret;
    const orgPub = this.settings.sso?.orgSignPublicKey;
    if (org && orgPub) {
      try {
        out.push({
          kind: 'org',
          publicKey: new Uint8Array(Buffer.from(orgPub, 'base64')),
          secretKey: new Uint8Array(Buffer.from(org, 'base64')),
        });
      } catch { /* skip malformed org key */ }
    }
    return out;
  }

  /** Log a compliance retention dry-run to the op-log (Activity) — never purges. */
  async recordComplianceRetentionDryRun(itemCount: number): Promise<void> {
    this.oplogWriter.emit({
      graphId: '__compliance',
      op: 'merge',
      target: { kind: 'source', id: '__compliance:retention-dry-run' },
      after: {
        action: 'retentionDryRun',
        itemCount,
        triggeredBy: 'compliance:scheduler',
      },
    });
    this.invalidateOplogCache();
    const prev = this.getSettings().compliance;
    await this.setSettings({
      compliance: {
        enabled: prev?.enabled === true,
        ...(prev?.defaultRetentionTtlMs !== undefined ? { defaultRetentionTtlMs: prev.defaultRetentionTtlMs } : {}),
        ...(prev?.defaultExportBeforePurge !== undefined ? { defaultExportBeforePurge: prev.defaultExportBeforePurge } : {}),
        ...(prev?.classificationSchema ? { classificationSchema: prev.classificationSchema } : {}),
        lastRetentionDryRunAt: Date.now(),
      },
    });
  }

  async updateGraphComplianceFields(
    graphId: GraphId,
    fields: {
      retentionTtlMs?: number | null;
      retentionExportBeforePurge?: boolean;
      industryTags?: string[] | null;
    },
  ): Promise<void> {
    const existing: settingsMod.GraphMetadata = this.settings.graphMetadata[graphId] ?? {
      template: 'personal' as settingsMod.GraphTemplate,
      displayName: graphId,
      createdAt: 0,
    };
    const updated: settingsMod.GraphMetadata = { ...existing };
    if (fields.retentionTtlMs === null) {
      delete updated.retentionTtlMs;
    } else if (typeof fields.retentionTtlMs === 'number' && fields.retentionTtlMs > 0) {
      updated.retentionTtlMs = Math.floor(fields.retentionTtlMs);
    }
    if (fields.retentionExportBeforePurge !== undefined) {
      updated.retentionExportBeforePurge = fields.retentionExportBeforePurge;
    }
    if (fields.industryTags === null) {
      delete updated.industryTags;
    } else if (fields.industryTags !== undefined) {
      const normalized = normalizeIndustryTags(fields.industryTags);
      if (normalized?.length) updated.industryTags = normalized;
      else delete updated.industryTags;
    }
    await this.setGraphMetadata(graphId, updated);
    this.patchPolicyTier(graphId, updated);
  }

  /**
   * Slightly increase the confidence of a node that was recalled and acted on.
   * This is the reinforcement half of temporal decay — nodes the user finds
   * useful strengthen; nodes that go unrecalled for a long time weaken.
   *
   * Skipped if the node is already high-confidence (> 0.9) or soft-deleted
   * (confidence ≤ 0.2). Non-fatal: any failure is logged and swallowed so
   * BrainEngine's recall loop isn't disrupted.
   */
  async reinforceNode(graphId: GraphId, nodeId: string): Promise<void> {
    const g = this.graphs.get(graphId);
    if (!g) return;
    const nodes = this.opts.adapter.inspectNodes(g.handle);
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (node.confidence <= 0.2 || node.confidence > 0.9) return;
    const newConfidence = Math.min(0.95, node.confidence + 0.03);
    try {
      await this.opts.adapter.applyCorrection(g.handle, {
        kind: 'edit',
        nodeId,
        content: node.contentPreview,
        reason: 'brain:reinforcement',
      });
      this.oplogWriter.emit({
        graphId,
        op: 'editNode',
        target: { kind: 'node', id: nodeId },
        after: { confidence: newConfidence, reason: 'brain:reinforcement', triggeredBy: 'brain:reinforcement' },
      });
      g.dirty = true;
      await this.save(graphId);
    } catch (err) {
      console.error(`[brain] reinforceNode(${redactPair(graphId, nodeId)}) failed:`, err);
    }
  }

  // ── Graph metadata (template, displayName) ──────────────────────────────

  getGraphMetadata(graphId: GraphId): settingsMod.GraphMetadata | undefined {
    return this.settings.graphMetadata[graphId];
  }

  async setGraphMetadata(graphId: GraphId, metadata: settingsMod.GraphMetadata): Promise<void> {
    // Route through setSettings so this write is serialised with concurrent
    // writes via settingsWriteQueue. A direct persistSettings() call bypasses
    // the queue and can race with setSettings() — the loser reads a stale
    // this.settings snapshot and overwrites fields the winner just committed.
    await this.setSettings({
      graphMetadata: {
        ...this.settings.graphMetadata,
        [graphId]: metadata,
      },
    });
  }

  /**
   * Combined view: every loaded graph + its metadata (or sensible defaults).
   *
   * With `includeUnloaded: true`, also include engrams that have a metadata
   * entry in settings but haven't been loaded into memory yet (still queued
   * by `loadAllGraphsFromDisk`). Each entry carries a `loaded` flag so the
   * caller can distinguish ready-to-use engrams from ones still warming up.
   * The engram picker uses this so the dropdown shows the full set during
   * boot — otherwise it'd grow incrementally as each background load
   * finished, which is jarring (and gives the impression engrams are
   * appearing out of nowhere).
   */
  graphsWithMetadata(
    opts: { includeUnloaded?: boolean } = {},
  ): Array<{ graphId: GraphId; metadata: settingsMod.GraphMetadata; loaded: boolean }> {
    const loadedSet = new Set<GraphId>(this.listGraphs());
    const loadedRows = this.listGraphs().map((graphId) => ({
      graphId,
      metadata: this.settings.graphMetadata[graphId] ?? {
        template: 'personal' as settingsMod.GraphTemplate,
        displayName: graphId,
        createdAt: 0,
      },
      loaded: true,
    }));
    if (!opts.includeUnloaded) return loadedRows;
    const pendingRows = Object.entries(this.settings.graphMetadata)
      .filter(([graphId]) => !loadedSet.has(graphId))
      .map(([graphId, metadata]) => {
        const onDisk = this.graphOnDisk(graphId);
        // An LRU-evicted engram (everLoaded) is still available — report it as
        // loaded so the picker doesn't grey/disable it. Metadata-only rows
        // with no .gai (e.g. never-created system engrams) aren't part of the
        // boot sweep — don't grey them as "still loading from disk".
        const loaded = !onDisk || this.everLoaded.has(graphId);
        return { graphId, metadata, loaded };
      });
    return [...loadedRows, ...pendingRows];
  }

  /**
   * Toggle the archived flag on a graph's metadata. Archived graphs are hidden
   * from all in-app pickers but their files remain intact on disk. The graph
   * must already exist (be loaded) — archiving a nonexistent graph is a no-op.
   */
  async setGraphArchived(graphId: GraphId, archived: boolean): Promise<void> {
    const existing: settingsMod.GraphMetadata = this.settings.graphMetadata[graphId] ?? {
      template: 'personal' as settingsMod.GraphTemplate,
      displayName: graphId,
      createdAt: 0,
    };
    await this.setGraphMetadata(graphId, { ...existing, archived });
  }

  /**
   * Toggle a source's "exclude from AI recall" flag (persisted in graph
   * metadata). When excluded, the source's nodes are dropped by activeNodeIds()
   * — so they vanish from recall / dig_deeper / node-search — but stay fully
   * present in the Sources list, stats, 3D, and remain forgettable. Takes effect
   * on the next recall (no re-index needed).
   */
  async setSourceExcluded(graphId: GraphId, sourceId: string, excluded: boolean): Promise<void> {
    // Same fallback as setGraphArchived — an engram created without explicit
    // metadata (e.g. via createGraph) still gets a record so the flag persists.
    const existing: settingsMod.GraphMetadata = this.settings.graphMetadata[graphId] ?? {
      template: 'personal' as settingsMod.GraphTemplate,
      displayName: graphId,
      createdAt: 0,
    };
    const set = new Set(existing.excludedSources ?? []);
    if (excluded) set.add(sourceId); else set.delete(sourceId);
    await this.setGraphMetadata(graphId, { ...existing, excludedSources: [...set] });
  }

  async setGraphTier(graphId: GraphId, tier: 'public' | 'personal' | 'sensitive'): Promise<void> {
    const existing: settingsMod.GraphMetadata = this.settings.graphMetadata[graphId] ?? {
      template: 'personal' as settingsMod.GraphTemplate,
      displayName: graphId,
      createdAt: 0,
    };
    const updated = { ...existing, sensitivityTier: tier };
    if (this.complianceSchema()?.enabled) {
      delete updated.classificationLabelId;
    }
    await this.setGraphMetadata(graphId, updated);
    this.patchPolicyTier(graphId, updated);
  }

  /** Update an engram's sensitivity tier and/or per-graph consent interval in
   *  one call. Supersedes setGraphTier when both fields need updating together.
   *  - tier: live policyCfg is patched immediately (no restart needed)
   *  - consentIntervalMs: stored in metadata only; resolved by checkConsentOrThrow
   *    at recall time using "stricter wins" against the global tier default */
  async updateEngramConfig(
    graphId: GraphId,
    config: { tier?: 'public' | 'personal' | 'sensitive'; consentIntervalMs?: number; clearConsentInterval?: boolean },
  ): Promise<void> {
    if (!config.tier && config.consentIntervalMs === undefined && !config.clearConsentInterval) return;
    const existing: settingsMod.GraphMetadata = this.settings.graphMetadata[graphId] ?? {
      template: 'personal' as settingsMod.GraphTemplate,
      displayName: graphId,
      createdAt: 0,
    };
    const updated: settingsMod.GraphMetadata = {
      ...existing,
      ...(config.tier !== undefined ? { sensitivityTier: config.tier } : {}),
      ...(config.consentIntervalMs !== undefined ? { consentIntervalMs: config.consentIntervalMs } : {}),
    };
    if (config.clearConsentInterval) {
      delete (updated as { consentIntervalMs?: number }).consentIntervalMs;
    }
    if (config.tier !== undefined && this.complianceSchema()?.enabled) {
      delete updated.classificationLabelId;
    }
    await this.setGraphMetadata(graphId, updated);
    if (config.tier !== undefined) {
      this.patchPolicyTier(graphId, updated);
    }
  }

  /** Retrieve or generate (once, on first call) the HMAC key used for consent
   *  phrase rotation. Stored in settings but NEVER exposed via MCP tools or IPC
   *  responses — intentionally limited to the sidecar's phrase generation code.
   *
   *  Concurrency: the IPC layer calls this from two parallel `get_consent_phrase`
   *  invocations (personal + sensitive) when the Settings panel opens. Without
   *  serialization, both branches would generate a key and race on the atomic
   *  settings.json rename — one wins, the other fails with ENOENT. We cache the
   *  in-flight save promise so concurrent callers share the same write. */
  private _hmacKeyInFlight: Promise<string> | null = null;

  async getOrCreateConsentHmacKey(): Promise<string> {
    if (this.settings.consentHmacKey) return this.settings.consentHmacKey;
    if (this._hmacKeyInFlight) return this._hmacKeyInFlight;
    this._hmacKeyInFlight = (async (): Promise<string> => {
      // Re-check in case another waiter completed the write while we queued.
      if (this.settings.consentHmacKey) return this.settings.consentHmacKey;
      const key = randomBytes(32).toString('hex');
      await this.setSettings({ consentHmacKey: key });
      return key;
    })();
    try {
      return await this._hmacKeyInFlight;
    } finally {
      this._hmacKeyInFlight = null;
    }
  }

  // ── LRU memory eviction ────────────────────────────────────────────────
  // A large multi-engram cortex holds every loaded engram's embedding index
  // resident (≈GBs each), so 20+ engrams pin enough RAM to trigger JSC
  // stop-the-world GC stalls that freeze the IPC loop. These keep at most
  // GRAPH_RESIDENT_CAP engrams in memory; the rest are unloaded (disk intact)
  // and lazily reloaded on next access. Embedding VECTORS persist in the .gai,
  // so a reload is a parse — never a re-embed.

  /** Record user/AI access to an engram (LRU recency). Called from the IPC
   *  entry for graphId-bearing methods — NOT from background brain passes, so
   *  brain-only engrams can still go cold and be evicted. */
  touchGraph(graphId: GraphId): void {
    this.lastAccessAt.set(graphId, Date.now());
  }

  /** Ensure an engram is resident before a user/AI op touches it (reloading it
   *  if LRU eviction unloaded it). Tolerant: a genuinely missing engram is left
   *  for the caller's must() to report "Graph not loaded" as before. */
  async ensureLoaded(graphId: GraphId): Promise<void> {
    this.touchGraph(graphId);
    if (this.graphs.has(graphId)) return;
    try { await this.loadGraph(graphId); }
    catch { /* engram may not exist; caller surfaces it normally */ }
    void this.maybeEvict();
  }

  /** Unload a clean, idle engram from memory (disk untouched) so it can lazily
   *  reload later. No-op if dirty, mid-embed-build, or already gone — we never
   *  drop unsaved work or interrupt a cold-load. */
  async unloadGraph(graphId: GraphId): Promise<void> {
    const g = this.graphs.get(graphId);
    if (!g || g.dirty || g.embeddingsBuilding) return;
    try { await g.cache.save(); } catch { /* best-effort embedding-cache flush */ }
    // Release the SDK graph's in-memory structures (SDK >=0.6.0 dispose()) BEFORE
    // dropping the reference, so GC can actually reclaim — a plain graphs.delete()
    // freed almost nothing because internal Maps/indexes stayed referenced.
    try { this.opts.adapter.dispose(g.handle); } catch { /* best-effort */ }
    this.graphs.delete(graphId);
    this.lastAccessAt.delete(graphId);
    dbg(`[host] evicted engram[${redactId(graphId)}] from memory (LRU) — lazy-reloads on next access`);
  }

  /** LRU sweep: while more than GRAPH_RESIDENT_CAP engrams are resident, unload
   *  the coldest eligible ones (clean, not embed-building, idle > GRAPH_IDLE_MS).
   *  Run after each load + on a periodic timer (see main.ts). */
  async maybeEvict(): Promise<void> {
    // LRU eviction is DISABLED. The SDK has no dispose()/unload() for a graph
    // handle, so `graphs.delete()` only drops the JS reference and relies on GC
    // to reclaim the native embedding buffers — which lags under memory
    // pressure, so eviction doesn't reliably free RAM. Meanwhile any access
    // (a stray search/recall) reloads the engram, so we pay constant
    // evict→reload churn (incl. a `search.nodes` flood on just-deleted engrams)
    // for no memory benefit, and it made live-ingest WORSE than the pre-LRU
    // (v1.13.3) baseline where engrams simply stayed resident and stable.
    // Re-enable only once the SDK can actually release a graph's memory (or we
    // switch to lazy-boot so memory never balloons in the first place).
    if (!LRU_EVICTION_ENABLED) return;
    if (this.graphs.size <= GRAPH_RESIDENT_CAP) return;
    const now = Date.now();
    const evictable = [...this.graphs.keys()]
      .filter((id) => {
        const g = this.graphs.get(id)!;
        return !g.dirty && !g.embeddingsBuilding
          && now - (this.lastAccessAt.get(id) ?? 0) > GRAPH_IDLE_MS;
      })
      .sort((a, b) => (this.lastAccessAt.get(a) ?? 0) - (this.lastAccessAt.get(b) ?? 0)); // coldest first
    let over = this.graphs.size - GRAPH_RESIDENT_CAP;
    let evicted = 0;
    for (const id of evictable) {
      if (over <= 0) break;
      await this.unloadGraph(id);
      over--; evicted++;
    }
    // The unloaded engrams are now dereferenced but Bun won't return their pages
    // to the OS until GC runs. Force it once per sweep (cheap relative to the
    // GBs reclaimed) so eviction actually drops RSS, not just the logical heap.
    if (evicted > 0) {
      (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true);
    }
  }

  /**
   * Permanently delete a graph and all its on-disk files. The graph is removed
   * from the in-memory map and from settings.graphMetadata.
   *
   * Safe guards:
   *   - Does nothing if `graphId` is not loaded (already gone).
   *   - Removes metadata even if file deletion partially fails, so the graph
   *     doesn't ghost in the picker after a crash.
   *   - Deletes main files + backup siblings (.bak) + embedding cache.
   */
  async deleteGraph(graphId: GraphId): Promise<void> {
    // Remove from in-memory graph map first — stops any in-flight reads.
    this.graphs.delete(graphId);
    this.everLoaded.delete(graphId); // truly gone — no longer "available"
    this.lastAccessAt.delete(graphId);

    // Delete every on-disk artifact for this graph, including the legacy
    // .aikg path (pre-0.2.6 cortexes) so it doesn't get rediscovered on
    // the next startup by loadAllGraphsFromDisk().
    const candidates = [
      this.graphPath(graphId),
      this.legacyGraphPath(graphId),
      this.bundlePath(graphId),
      this.cachePath(graphId),
      `${this.graphPath(graphId)}.bak`,
      `${this.legacyGraphPath(graphId)}.bak`,
      `${this.bundlePath(graphId)}.bak`,
      `${this.cachePath(graphId)}.bak`,
      `${this.graphPath(graphId)}${LKG_SUFFIX}`,
      `${this.bundlePath(graphId)}${LKG_SUFFIX}`,
      // Per-engram local-LLM overlay log (`<graphId>.gll`, sits alongside the
      // .gai). Was being orphaned on delete — left behind as a ghost file even
      // though the engram is gone.
      path.join(path.dirname(this.graphPath(graphId)), `${graphId}.gll`),
    ];
    for (const p of candidates) {
      try { await fs.unlink(p); } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          console.error(`[graphnosis-host] deleteGraph: failed to remove ${p}: ${err.message}`);
        }
      }
    }

    // Strip metadata from settings so the graph can't reappear on next boot.
    // Route through setSettings (same serialisation fix as setGraphMetadata).
    const { [graphId]: _removed, ...rest } = this.settings.graphMetadata;
    await this.setSettings({ graphMetadata: rest });

    // Purge stale cross-engram connections that referenced this graph.
    try {
      const connections = await this.loadConnectionStore();
      const cleaned = connections.filter((c) => c.graphA !== graphId && c.graphB !== graphId);
      if (cleaned.length !== connections.length) {
        await this.saveConnectionStore(cleaned);
      }
    } catch (e) {
      console.error(`[graphnosis-host] deleteGraph: could not prune connection store: ${(e as Error).message}`);
    }

    // Purge cross-engram skill-call links (D1) that referenced this graph as
    // caller or target, so the side-table doesn't dangle after engram delete.
    try {
      await this.skillCallLinks.pruneGraph(graphId);
    } catch (e) {
      console.error(`[graphnosis-host] deleteGraph: could not prune skill-call links: ${(e as Error).message}`);
    }

    // Purge stale GNN predicted edges that referenced this graph.
    try {
      const gnnEdges = await this.loadGnnStore();
      const cleanedEdges = gnnEdges.filter((e) => e.graphId !== graphId);
      if (cleanedEdges.length !== gnnEdges.length) {
        await this.saveGnnStore(cleanedEdges);
      }
    } catch (e) {
      console.error(`[graphnosis-host] deleteGraph: could not prune GNN store: ${(e as Error).message}`);
    }

    // Purge stale GLL overlay entries that referenced this graph.
    try {
      const gll = await this.loadGllOverlay();
      const cleanedGllEdges = gll.edges.filter((e) => e.graphId !== graphId);
      const cleanedGllAssertions = gll.assertions.filter((a) => a.graphId !== graphId);
      if (cleanedGllEdges.length !== gll.edges.length || cleanedGllAssertions.length !== gll.assertions.length) {
        await this.saveGllOverlay(cleanedGllEdges, cleanedGllAssertions);
      }
    } catch (e) {
      console.error(`[graphnosis-host] deleteGraph: could not prune GLL overlay: ${(e as Error).message}`);
    }
  }

  /** Update settings, persist to <cortex>/settings.json, return the merged result. */
  async setSettings(partial: Partial<settingsMod.AppSettings>, opts?: { userInitiated?: boolean }): Promise<settingsMod.AppSettings> {
    // Serialise through settingsWriteQueue so concurrent callers (the brain
    // engine fires background writes every few seconds) always merge from the
    // latest committed this.settings, never from a stale snapshot captured
    // before a concurrent write committed. Without this, a brain-engine write
    // in flight at the same time as a user preference save reads the old
    // this.settings and its disk write can land after the user's write,
    // silently reverting fields like ai.autoReingestOnFileChange to false.
    let resolveSlot!: () => void;
    const slot = new Promise<void>(r => { resolveSlot = r; });
    const prev = this.settingsWriteQueue;
    this.settingsWriteQueue = slot;

    let next!: settingsMod.AppSettings;
    try {
      await prev; // wait for any concurrent write to finish and commit
      // Merge now — this.settings reflects the latest committed state.
      // Shallow merge per top-level key — keeps contentCache fully replaced if
      // the caller passes one, while leaving room for future top-level keys.
      const mergedTop = { ...this.settings, ...partial };
      // User-owned brain toggles must survive concurrent BACKGROUND writes. The
      // brain fires `{ brain: { ...current.brain, lastRun } }` every few seconds;
      // if its `current` snapshot predates a user's Low-power toggle, that stale
      // brain object would clobber the freshly-saved value (observed: turning
      // Low-power OFF reverted to ON). Background writes (no userInitiated flag)
      // therefore can't change lowPowerMode / clipboardCapture — those keep the
      // committed value; only an explicit user settings save changes them.
      if (partial.brain && !opts?.userInitiated && this.settings.brain) {
        mergedTop.brain = {
          ...partial.brain,
          ...(this.settings.brain.lowPowerMode !== undefined ? { lowPowerMode: this.settings.brain.lowPowerMode } : {}),
          ...(this.settings.brain.clipboardCapture !== undefined ? { clipboardCapture: this.settings.brain.clipboardCapture } : {}),
        };
      }
      next = settingsMod.mergeWithDefaults(mergedTop);
      await this.persistSettings(next);
    } finally {
      resolveSlot(); // unblock the next queued write regardless of outcome
    }
    // Notify listeners with the persisted value so they don't react to
    // a stale in-flight patch.
    for (const fn of this.settingsListeners) {
      try { fn(next); } catch (e) {
        console.error(`[graphnosis-host] settings listener failed: ${(e as Error).message}`);
      }
    }
    return next;
  }

  /**
   * Single I/O boundary for settings writes. Encrypts connector credentials
   * with the cortex data key before writing to disk, then swaps the
   * in-memory copy (with decrypted credentials) and notifies listeners.
   *
   * All three saveSettings paths in this file (setGraphMetadata,
   * deleteGraph, setSettings) route through here so credentials never
   * leak to settings.json in plaintext — including when an unrelated
   * write piggybacks on a settings save and would otherwise re-serialise
   * the in-memory plaintext credentials by accident.
   */
  private async persistSettings(next: settingsMod.AppSettings): Promise<void> {
    const withEncCreds = await encryptConnectorCredentialsInSettings(next, this.key);
    const withEncBridges = await encryptBridgeTokensInSettings(withEncCreds, this.key);
    const withEncModelKeys = await encryptModelProviderKeysInSettings(withEncBridges, this.key);
    const onDiskNext = await encryptSsoSecretsInSettings(withEncModelKeys, this.key);
    await settingsMod.saveSettings(this.opts.cortexDir, onDiskNext);
    this.settings = next;
  }

  /** Subscribe to settings updates. Returns an unsubscribe function.
   *  Fires after the new value is persisted and swapped in. */
  onSettingsChanged(handler: (s: settingsMod.AppSettings) => void): () => void {
    this.settingsListeners.add(handler);
    return () => this.settingsListeners.delete(handler);
  }

  // ── License token (encrypted at rest) ────────────────────────────────────
  //
  // The license token is an Ed25519-signed JWT-like string issued by the Nehloo
  // signing service. It is stored in settings.json as `licenseEnc` —
  // XChaCha20-Poly1305 ciphertext of the raw token string, encrypted with the
  // cortex data key, base64-encoded. Decryption happens on demand; the plaintext
  // token never sits in the in-memory AppSettings struct.
  //
  // NEVER log, return via MCP, or broadcast the raw token. It is PII-adjacent
  // (contains the user's email / UUID) and is the proof of subscription.

  /**
   * Decrypt and return the raw license token string, or `null` when the cortex
   * has no stored token or decryption fails (tampered / re-encrypted with a
   * different key). The returned string should be passed directly to
   * `LicenseValidator.hasFeature()` — do not log or transmit it.
   */
  async getLicenseToken(): Promise<string | null> {
    const enc = this.settings.licenseEnc;
    if (!enc) return null;
    try {
      const blob = new Uint8Array(Buffer.from(enc, 'base64'));
      const plaintext = await decrypt(blob, this.key);
      return new TextDecoder().decode(plaintext);
    } catch {
      // Decryption failure = token is unusable. Treat as no license.
      return null;
    }
  }

  /**
   * Encrypt `token` with the cortex data key and persist it as `licenseEnc`
   * in settings. Called by the billing flow when the Nehloo signing service
   * issues a new or renewed token (e.g. after Stripe subscription events).
   *
   * TODO: wire this method into the IPC handler once the billing UI ships.
   */
  async setLicenseToken(token: string): Promise<void> {
    const plaintext = new TextEncoder().encode(token);
    const salt = randomBytes(16);
    const blob = await encrypt(plaintext, this.key, salt);
    const licenseEnc = Buffer.from(blob).toString('base64');
    await this.setSettings({ licenseEnc });
  }

  /** Install (or remove) the filesystem watcher hook. Pass null to clear.
   *  When installed, the host calls back into the listener on every
   *  successful ingest/forgetSource so the watcher can mirror the active
   *  set of file paths. The host also runs `syncAll()` once on install
   *  so the watcher picks up sources loaded before it was attached. */
  setFileWatcher(listener: SourceLifecycleListener | null): void {
    this.fileWatcher = listener;
    if (listener) listener.syncAll();
  }

  // ── Content cache (encrypted blobs keyed by sourceId) ───────────────────
  //
  // Each cached source lives at <cortex>/content/<sourceId>.bin. Format
  // before encryption: [u32 LE header-len][header JSON][raw content bytes].
  // On `ingest()` we write the blob respecting settings; on `forgetSource()`
  // we delete it. Recovery reads it back via `readContentBlob()`.

  private contentDir(): string {
    return path.join(this.opts.cortexDir, 'content');
  }

  private contentPath(sourceId: string): string {
    return path.join(this.contentDir(), `${sourceId}.bin`);
  }

  private async writeContentBlob(
    sourceId: string,
    header: ContentCacheHeader,
    content: Buffer | Uint8Array,
  ): Promise<void> {
    const contentBytes = content instanceof Buffer
      ? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
      : content;
    const headerJson = new TextEncoder().encode(JSON.stringify(header));
    const buf = new Uint8Array(4 + headerJson.length + contentBytes.length);
    new DataView(buf.buffer).setUint32(0, headerJson.length, true);
    buf.set(headerJson, 4);
    buf.set(contentBytes, 4 + headerJson.length);
    const ct = await encrypt(buf, this.key, this.salt);
    await fs.mkdir(this.contentDir(), { recursive: true });
    // Atomic write: write tmp, rename.
    const target = this.contentPath(sourceId);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, Buffer.from(ct));
    await fs.rename(tmp, target);
  }

  private async readContentBlob(
    sourceId: string,
  ): Promise<{ header: ContentCacheHeader; content: Uint8Array } | null> {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.contentPath(sourceId));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const pt = await decrypt(new Uint8Array(bytes), this.key);
    const headerLen = new DataView(pt.buffer, pt.byteOffset, 4).getUint32(0, true);
    const headerJson = new TextDecoder().decode(pt.subarray(4, 4 + headerLen));
    const header = JSON.parse(headerJson) as ContentCacheHeader;
    const content = pt.subarray(4 + headerLen);
    return { header, content };
  }

  private async deleteContentBlob(sourceId: string): Promise<void> {
    try {
      await fs.unlink(this.contentPath(sourceId));
    } catch {
      /* not cached or already gone — non-fatal */
    }
  }

  listGraphs(): GraphId[] {
    return [...this.graphs.keys()];
  }

  /** True while the sidecar is still in its boot window (default load + sweep +
   *  deferred housekeeping). Brain passes, connector pulls, and auto-relink defer. */
  isBootSweepActive(): boolean {
    return this.bootPhaseActive || this.bootSweepActive;
  }

  /** True while boot-deferred oplog reconcile / housekeeping is in flight. */
  isBootDeferredWorkActive(): boolean {
    return this.bootDeferredFlushPromise !== null;
  }

  /** True while a boot-throttled embedding-cache rebuild is still in flight.
   *  loadGraph returns before buildEmbeddings finishes; brain passes defer until
   *  the last boot-slot rebuild completes so duplicate scan doesn't race cold caches. */
  isBootEmbBuildActive(): boolean {
    return this.bootEmbBuildInFlight > 0;
  }

  /** One-shot: fires when no boot embedding-cache rebuilds are in flight. */
  onBootEmbBuildIdle(cb: () => void): () => void {
    if (!this.isBootEmbBuildActive()) {
      queueMicrotask(cb);
      return () => {};
    }
    this.bootEmbBuildIdleListeners.push(cb);
    return () => {
      const i = this.bootEmbBuildIdleListeners.indexOf(cb);
      if (i >= 0) this.bootEmbBuildIdleListeners.splice(i, 1);
    };
  }

  private emitBootEmbBuildIdle(): void {
    if (this.bootEmbBuildInFlight > 0) return;
    const listeners = this.bootEmbBuildIdleListeners.splice(0);
    for (const cb of listeners) {
      try { cb(); } catch (e: unknown) {
        console.error(`[graphnosis-host] bootEmbBuildIdle listener failed: ${(e as Error).message}`);
      }
    }
  }

  /** Mark the sidecar boot window — defer oplog reconcile until flushBootDeferredWork. */
  setBootPhaseActive(active: boolean): void {
    this.bootPhaseActive = active;
  }

  /** Background oplog reconcile after boot — does not block notifyBootSettled(). */
  flushBootDeferredWork(): Promise<void> {
    if (this.bootDeferredFlushPromise) return this.bootDeferredFlushPromise;
    this.bootDeferredFlushPromise = this.runBootDeferredWork();
    return this.bootDeferredFlushPromise;
  }

  private async runBootDeferredWork(): Promise<void> {
    const materializeGraphIds = this.bootMaterializeQueue.splice(0);
    const reconcileGraphIds = this.bootReconcileQueue.splice(0);
    if (materializeGraphIds.length === 0 && reconcileGraphIds.length === 0) {
      this.bootDeferredFlushPromise = null;
      return;
    }
    if (materializeGraphIds.length > 0) {
      dbg(
        `[graphnosis-host] boot deferred work: ${materializeGraphIds.length} bundle materialize(s)`,
      );
      for (const graphId of materializeGraphIds) {
        const entry = this.graphs.get(graphId);
        if (!entry) continue;
        const t0 = Date.now();
        try {
          await this.runBundleMaterialize(graphId, entry);
          dbg(
            `[graphnosis-host] boot materialize engram[${redactId(graphId)}]: ${Date.now() - t0}ms`,
          );
        } catch (e: unknown) {
          console.error(
            `[graphnosis-host] boot materialize failed engram[${redactId(graphId)}] after ${Date.now() - t0}ms: ${(e as Error).message}`,
          );
        }
        await this.yieldToLoop();
      }
    }
    if (reconcileGraphIds.length === 0) {
      this.bootDeferredFlushPromise = null;
      return;
    }
    dbg(
      `[graphnosis-host] boot deferred work: ${reconcileGraphIds.length} oplog reconcile(s)`,
    );

    type OplogEventBatch = Awaited<ReturnType<typeof oplog.readAllEvents>>;
    let fullEvents: OplogEventBatch | null = null;
    let tailEvents: OplogEventBatch | null = null;

    const needsFull = reconcileGraphIds.some(
      (graphId) => this.settings.graphMetadata[graphId]?.oplogReconcileCheckpoint === undefined,
    );
    const tailCheckpoints = reconcileGraphIds
      .map((graphId) => this.settings.graphMetadata[graphId]?.oplogReconcileCheckpoint)
      .filter((ck): ck is NonNullable<typeof ck> => ck !== undefined);

    if (needsFull) {
      fullEvents = await this.listOplogEvents();
    } else if (tailCheckpoints.length > 0) {
      const minCk = this.minOplogReconcileCheckpoint(tailCheckpoints);
      const oplogDir = path.join(this.opts.cortexDir, 'oplog');
      tailEvents = await oplog.readEventsSince(oplogDir, this.key, {
        ...this.oplogReadOptions(),
        sinceTs: minCk.maxTs,
        ...(minCk.maxSeq !== undefined ? { sinceSeq: minCk.maxSeq } : {}),
      });
    }

    const prefetch = { fullEvents, tailEvents };

    for (const graphId of reconcileGraphIds) {
      const entry = this.graphs.get(graphId);
      if (!entry) continue;
      const t0 = Date.now();
      try {
        const outcome = await this.reconcileGraphFromOplog(graphId, entry, prefetch);
        if (outcome === 'skipped') {
          dbg(
            `[graphnosis-host] boot reconcile engram[${redactId(graphId)}]: skipped (checkpoint current)`,
          );
        } else {
          dbg(
            `[graphnosis-host] boot reconcile engram[${redactId(graphId)}]: ${Date.now() - t0}ms`,
          );
        }
      } catch (e: unknown) {
        console.error(
          `[graphnosis-host] boot reconcile failed engram[${redactId(graphId)}] after ${Date.now() - t0}ms: ${(e as Error).message}`,
        );
      }
      await this.yieldToLoop();
    }
    this.bootDeferredFlushPromise = null;
  }

  private scheduleReconcile(graphId: GraphId, entry: LoadedGraph): void {
    if (this.bootPhaseActive || this.bootSweepActive) {
      if (!this.bootReconcileQueue.includes(graphId)) {
        this.bootReconcileQueue.push(graphId);
      }
      return;
    }
    entry.reconcileBuilding = this.reconcileGraphFromOplog(graphId, entry)
      .then(() => {})
      .catch((e: unknown) => {
        console.error(
          `[graphnosis-host] op-log reconcile failed for engram[${redactId(graphId)}]: ${(e as Error).message} — continuing with on-disk .gai`,
        );
      })
      .finally(() => {
        if (this.graphs.get(graphId) === entry) entry.reconcileBuilding = null;
      });
  }

  private scheduleSourceRefSweep(graphId: GraphId): void {
    if (this.bootPhaseActive || this.bootSweepActive) {
      // Orphan cleanup is idempotent — defer to first access, not boot critical path.
      this.deferredSourceRefSweep.add(graphId);
      return;
    }
    void this.sweepSourceRefArtifacts(graphId).catch((e: unknown) => {
      console.error(
        `[graphnosis-host] sourceRef-artifact sweep failed for engram[${redactId(graphId)}]: ${(e as Error).message}`,
      );
    });
  }

  /** Re-ingest bundle sources when .gai is empty but .bundle survived — deferred
   *  during boot so loadGraph returns after early commit (not after 32-page ingest). */
  private scheduleBundleMaterialize(graphId: GraphId, entry: LoadedGraph): void {
    if (this.opts.adapter.inspectNodes(entry.handle).length > 0) return;
    if (entry.sourceIndex.list().length === 0) return;
    if (this.bootPhaseActive || this.bootSweepActive) {
      if (!this.bootMaterializeQueue.includes(graphId)) {
        this.bootMaterializeQueue.push(graphId);
      }
      return;
    }
    if (entry.bundleMaterializing) return;
    entry.bundleMaterializing = this.runBundleMaterialize(graphId, entry)
      .catch((e: unknown) => {
        console.error(
          `[graphnosis-host] bundle materialize failed for engram[${redactId(graphId)}]: ${(e as Error).message}`,
        );
      })
      .finally(() => {
        if (this.graphs.get(graphId) === entry) entry.bundleMaterializing = null;
      });
  }

  private async runBundleMaterialize(graphId: GraphId, entry: LoadedGraph): Promise<void> {
    if (this.graphs.get(graphId) !== entry) return;
    const dirty = await this.materializeEmptyGraphFromBundle(graphId, entry);
    if (!dirty) return;
    entry.dirty = true;
    try {
      await this.save(graphId);
      this.invalidateOplogCache();
    } catch (e) {
      console.error(
        `[graphnosis-host] bundle materialize save failed for engram[${redactId(graphId)}]: ${(e as Error).message}`,
      );
    }
  }

  /** Called by the sidecar boot sweep — gates concurrent embedding rebuilds. */
  setBootSweepActive(active: boolean): void {
    this.bootSweepActive = active;
    if (!active) {
      while (
        this.bootEmbBuildWaiters.length > 0
        && this.bootEmbBuildInFlight < GraphnosisHost.BOOT_EMB_BUILD_MAX
      ) {
        const next = this.bootEmbBuildWaiters.shift();
        if (next) {
          this.bootEmbBuildInFlight++;
          next();
        }
      }
      // Relinks queued while the sweep ran — kick them off now that engrams are
      // resident and the brain isn't competing for decrypt/embed slots.
      for (const graphId of this.relinkDeferredDuringBoot) {
        this.kickoffRelink(graphId);
      }
      this.relinkDeferredDuringBoot.clear();
    }
  }

  private yieldToLoop(): Promise<void> {
    return new Promise<void>((resolve) => setImmediate(resolve));
  }

  private async acquireBootEmbBuildSlot(): Promise<void> {
    if (this.bootEmbBuildInFlight < GraphnosisHost.BOOT_EMB_BUILD_MAX) {
      this.bootEmbBuildInFlight++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.bootEmbBuildWaiters.push(resolve);
    });
    this.bootEmbBuildInFlight++;
  }

  private releaseBootEmbBuildSlot(): void {
    this.bootEmbBuildInFlight = Math.max(0, this.bootEmbBuildInFlight - 1);
    const next = this.bootEmbBuildWaiters.shift();
    if (next) {
      this.bootEmbBuildInFlight++;
      next();
    }
    this.emitBootEmbBuildIdle();
  }

  /** Canonical on-disk path for a graph. New saves always go here (.gai). */
  private graphPath(graphId: GraphId): string {
    return path.join(this.opts.cortexDir, 'graphs', `${graphId}.gai`);
  }

  /** Legacy path from pre-0.2.6 cortexes (the App wrote .aikg). Used as a
   * read-time fallback so existing user cortexes keep working. */
  private legacyGraphPath(graphId: GraphId): string {
    return path.join(this.opts.cortexDir, 'graphs', `${graphId}.aikg`);
  }

  private bundlePath(graphId: GraphId): string {
    return path.join(this.opts.cortexDir, 'graphs', `${graphId}.bundle`);
  }

  private cachePath(graphId: GraphId): string {
    return path.join(this.opts.cortexDir, 'graphs', `${graphId}.embcache`);
  }

  /** True when a canonical or legacy graph file exists on disk. */
  isGraphOnDisk(graphId: GraphId): boolean {
    return existsSync(this.graphPath(graphId)) || existsSync(this.legacyGraphPath(graphId));
  }

  /** Source count from the encrypted .bundle without loading the full engram.
   *  Used by docs:checkOffer when the engram is on disk but not yet resident
   *  (boot sweep still in progress) — avoids treating "not loaded" as 0 sources. */
  async countBundleSources(graphId: GraphId): Promise<number> {
    if (!this.graphOnDisk(graphId)) return 0;
    const bundle = await this.loadBundle(graphId);
    return bundle.list().length;
  }

  private graphOnDisk(graphId: GraphId): boolean {
    return this.isGraphOnDisk(graphId);
  }

  /** Engrams with a .gai/.aikg on disk, excluding already-resident ids. Archived
   *  engrams are still loaded at boot — archived only hides them from pickers. */
  listBootPendingEngramIds(residentIds: Iterable<GraphId> = []): GraphId[] {
    const resident = new Set(residentIds);
    const graphsDir = path.join(this.opts.cortexDir, 'graphs');
    let entries: string[];
    try {
      entries = readdirSync(graphsDir);
    } catch {
      return [];
    }
    const out: GraphId[] = [];
    const seen = new Set<string>();
    for (const name of entries) {
      const m = name.match(/^(.+)\.(gai|aikg)$/);
      if (!m) continue;
      const graphId = m[1] as GraphId;
      if (resident.has(graphId) || seen.has(graphId)) continue;
      seen.add(graphId);
      out.push(graphId);
    }
    return out;
  }

  private kickoffDeferredSourceRefSweep(graphId: GraphId): void {
    if (!this.deferredSourceRefSweep.has(graphId)) return;
    this.deferredSourceRefSweep.delete(graphId);
    void this.sweepSourceRefArtifacts(graphId).catch((e: unknown) => {
      console.error(
        `[graphnosis-host] sourceRef-artifact sweep failed for engram[${redactId(graphId)}]: ${(e as Error).message}`,
      );
    });
  }

  async createGraph(graphId: GraphId): Promise<void> {
    if (this.graphs.has(graphId)) throw new Error(`Graph ${graphId} already loaded`);
    // Case-insensitive guard: macOS and Windows filesystems are
    // case-insensitive, so `<graphId>.gai` for `MyNotes` and `mynotes` would
    // be the SAME file on disk — silent overwrite. Reject a graphId that
    // differs from an existing engram only in case.
    const lower = graphId.toLowerCase();
    for (const existing of this.graphs.keys()) {
      if (existing.toLowerCase() === lower) {
        throw new Error(
          `An engram "${existing}" already exists — engram names are case-insensitive.`,
        );
      }
    }
    const handle = await this.opts.adapter.create(graphId);
    const cache = new EmbeddingCache({ path: this.cachePath(graphId), key: this.key, salt: this.salt });
    this.everLoaded.add(graphId); // newly created engram is available (survives LRU evict)
    this.graphs.set(graphId, {
      handle,
      sourceIndex: new SourceIndex(),
      cache,
      dirty: true,
      embeddingsBuilding: null,
      reconcileBuilding: null,
      bundleMaterializing: null,
      bundleSourcesAtLoad: 0,
    });
    this.correctionsCount.set(graphId, 0);
    await this.save(graphId);
  }

  async loadGraph(graphId: GraphId): Promise<void> {
    const inflight = this.loadGraphInflight.get(graphId);
    if (inflight) return inflight;
    if (this.graphs.has(graphId)) return;
    // Ghost metadata: settings row without .gai/.aikg. Fail fast with a clean
    // ENOENT so callers (graphs.load, ensureLoaded) never reach the legacy
    // .aikg open and spam raw filesystem stack traces.
    if (!this.isGraphOnDisk(graphId)) {
      const meta = this.getGraphMetadata(graphId);
      const msg = meta !== undefined
        ? `engram '${graphId}' has metadata but no graph file on disk`
        : `engram '${graphId}' not found on disk`;
      const enoentErr = new Error(msg) as NodeJS.ErrnoException;
      enoentErr.code = 'ENOENT';
      throw enoentErr;
    }
    const p = this.loadGraphInner(graphId).finally(() => {
      this.loadGraphInflight.delete(graphId);
    });
    this.loadGraphInflight.set(graphId, p);
    return p;
  }

  private async loadGraphInner(graphId: GraphId): Promise<void> {
    const tLoad = Date.now();
    let tDecrypt = 0;
    let tFromBuffer = 0;
    let tBundle = 0;
    // Recover from an interrupted purge before we try to read .gai. There
    // are two possible leftover states:
    //   .gai exists AND .gai.bak exists  → purge committed but didn't clean
    //                                      up; delete the stale .bak.
    //   .gai missing AND .gai.bak exists → purge crashed mid-rebuild;
    //                                      restore .bak → .gai so the user's
    //                                      data isn't lost.
    await this.recoverFromInterruptedPurge(graphId);
    const hmacKey = this.key;
    let handle!: GraphHandle;
    let usedTinyLkgRestore = false;
    let loadedGaiBytes = 0;

    // Auto-restore: empty .gai shell + substantial .lkg (writings-qtb9 pattern).
    const gaiPath = this.graphPath(graphId);
    const lkgPath = `${gaiPath}${LKG_SUFFIX}`;
    let gaiSize = 0;
    let lkgSize = 0;
    try { gaiSize = (await fs.stat(gaiPath)).size; } catch { /* missing → legacy path below */ }
    try { lkgSize = (await fs.stat(lkgPath)).size; } catch { /* no .lkg */ }
    loadedGaiBytes = gaiSize;
    if (gaiSize > 0 && gaiSize < EMPTY_SAVE_BLOCK_MIN_BYTES && lkgSize > EMPTY_SAVE_BLOCK_MIN_BYTES) {
      const restored = await this.tryRestoreTinyGaiFromLkg(graphId, hmacKey, gaiSize, lkgSize);
      if (restored) {
        handle = restored;
        usedTinyLkgRestore = true;
      }
    }

    if (!usedTinyLkgRestore) {
    // Prefer the canonical .gai path; fall back to the legacy .aikg path so
    // cortexes created before 0.2.6 keep loading. The next `save()` will write
    // the .gai file (and we can clean up the .aikg later if both exist).
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.graphPath(graphId));
      loadedGaiBytes = bytes.length;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
      try {
        bytes = await fs.readFile(this.legacyGraphPath(graphId));
        loadedGaiBytes = bytes.length;
        console.error(
          `[graphnosis-host] loaded legacy engram[${redactId(graphId)}].aikg — will migrate to .gai on next save`,
        );
      } catch (legacyErr) {
        const lerr = legacyErr as NodeJS.ErrnoException;
        if (lerr.code !== 'ENOENT') throw legacyErr;
        const enoentErr = new Error(
          `engram '${graphId}' not found on disk (no .gai or .aikg)`,
        ) as NodeJS.ErrnoException;
        enoentErr.code = 'ENOENT';
        throw enoentErr;
      }
    }
    const tDecrypt0 = Date.now();
    const aikgPlain = await decrypt(new Uint8Array(bytes!), this.key);
    tDecrypt = Date.now() - tDecrypt0;
    await this.yieldToLoop();
    // Inner SDK HMAC key (independent of outer encryption) — derived from data key + a fixed label.
    try {
      const tFromBuffer0 = Date.now();
      handle = await this.opts.adapter.loadFromBuffer(graphId, aikgPlain, hmacKey);
      tFromBuffer = Date.now() - tFromBuffer0;
      await this.yieldToLoop();
    } catch (e) {
      // ── Auto-quarantine on integrity failure ──────────────────────────
      // HMAC / checksum mismatch from loadFromBuffer means the .gai bytes
      // are corrupt — almost always caused by a save() being interrupted
      // mid-write before we made writes atomic. Keep retrying the same
      // file on every launch would block the engram from ever recovering.
      //
      // Rename .gai + .bundle to .gai.corrupt-<ts> and re-throw as ENOENT
      // so callers (loadAllGraphsFromDisk → applyRecovery) can treat the
      // engram as missing and rebuild from the op-log. The quarantined
      // files are kept on disk for forensic / manual recovery — never
      // deleted automatically.
      const msg = (e as Error).message ?? '';
      const looksCorrupt =
        msg.includes('checksum') || msg.includes('HMAC') ||
        msg.includes('Invalid .gai') || msg.includes('signature');
      if (looksCorrupt) {
        // Before quarantining-to-empty, try the last-known-good sibling (.lkg):
        // the canonical .gai may be a single bad write while the prior good
        // generation is still on disk. On success we continue loading with the
        // recovered handle instead of throwing.
        const recovered = await this.tryLoadFromLkg(graphId, hmacKey, msg);
        if (recovered) {
          handle = recovered;
        } else {
        const ts = Date.now();
        const quarantinedGai = `${this.graphPath(graphId)}.corrupt-${ts}`;
        const quarantinedBundle = `${this.bundlePath(graphId)}.corrupt-${ts}`;
        try { await fs.rename(this.graphPath(graphId), quarantinedGai); } catch { /* may not exist */ }
        try { await fs.rename(this.bundlePath(graphId), quarantinedBundle); } catch { /* may not exist */ }
        // Also delete the embedding cache. The .embcache stores pre-computed
        // vectors keyed by node content-hash — all of those hashes belong to
        // nodes that are now gone (or will be replaced by op-log recovery).
        // Leaving it behind means the next boot loads a large stale cache
        // (can be 10–15 MB for a 2000-node engram), parses it for 500–700 ms,
        // then builds embeddings for the rebuilt/empty graph into an unrelated
        // cache. Deleting it is safe: it's derived data, always rebuildable.
        try { await fs.unlink(this.cachePath(graphId)); } catch { /* already gone */ }
        await this.appendRecoveryLog({
          event: 'quarantined', graphId, error: msg, sizeBytes: loadedGaiBytes,
          quarantinedAs: path.basename(quarantinedGai), lkgFallback: 'unavailable',
        });
        console.error(
          `[graphnosis-host] quarantined corrupt engram '${graphId}': ` +
          `${msg}. Files moved to ${path.basename(quarantinedGai)} and ${path.basename(quarantinedBundle)}; ` +
          `embedding cache deleted. Run "Recover from op-log" to rebuild from sources.`,
        );
        const enoentErr = new Error(
          `engram '${graphId}' was corrupted (${msg}) and has been quarantined — ` +
          `use Recover from op-log to rebuild`,
        ) as NodeJS.ErrnoException;
        enoentErr.code = 'ENOENT';
        throw enoentErr;
        }
      } else {
        throw e;
      }
    }
    } // !usedTinyLkgRestore
    const tBundle0 = Date.now();
    let sourceIndex = await this.loadBundle(graphId);
    tBundle = Date.now() - tBundle0;
    await this.yieldToLoop();
    // Materialize the SDK graph before commit. fromBuffer usually leaves the
    // graph queryable, but build() is idempotent and matches what oplog
    // reconcile runs — without it, inspectNodes can briefly return [] on some
    // .gai shapes until reconcile finishes.
    await this.opts.adapter.build(handle);
    // Tiny .gai with a much larger .lkg (partial write / hollow shell, including
    // partial loads with some nodes): promote .lkg before a rebuild save hits
    // shrink-save guard (2.7MB over 13MB pattern).
    let committedNodes = this.opts.adapter.inspectNodes(handle).length;
    if (
      !usedTinyLkgRestore &&
      lkgSize > EMPTY_SAVE_BLOCK_MIN_BYTES &&
      lkgSize > loadedGaiBytes / SHRINK_SAVE_BLOCK_RATIO
    ) {
      const restored = await this.tryRestoreTinyGaiFromLkg(graphId, hmacKey, loadedGaiBytes, lkgSize);
      if (restored) {
        handle = restored;
        await this.opts.adapter.build(handle);
        loadedGaiBytes = lkgSize;
        committedNodes = this.opts.adapter.inspectNodes(handle).length;
        sourceIndex = await this.loadBundle(graphId);
        usedTinyLkgRestore = true;
      } else {
        this.emitRecoveryNeeded(graphId, 'lkg_auto_promote_failed', loadedGaiBytes, lkgSize);
      }
    }
    const cache = new EmbeddingCache({ path: this.cachePath(graphId), key: this.key, salt: this.salt });
    const bundleSources = sourceIndex.list().length;
    const entry: LoadedGraph = {
      handle, sourceIndex, cache, dirty: false,
      embeddingsBuilding: null, reconcileBuilding: null, bundleMaterializing: null,
      bundleSourcesAtLoad: bundleSources,
    };

    // ── Early commit: make the engram available in the picker immediately ──
    //
    // The cache is constructed here but NOT yet loaded from disk — load()
    // happens in the background below. Committing to graphs.set BEFORE
    // cache.load() means:
    //   - Each engram appears in listGraphs() (and the UI picker) as soon as
    //     its graph structure + source bundle are parsed, rather than after a
    //     potentially large embedding-cache JSON is deserialized (for a 2000-
    //     node engram that JSON can be 10–15 MB and take 300–800 ms to parse).
    //   - Total perceived picker latency drops by ~0.3–0.8 s per engram.
    //
    // Safety: dirty is false, so save() is a no-op until the user triggers
    // a write. The cache object reference is shared with the background task
    // below, so once cache.load() completes, lookups in cached() start
    // returning hits without any further coordination.
    this.graphs.set(graphId, entry);
    this.everLoaded.add(graphId); // mark available even after a future LRU evict
    this.touchGraph(graphId); // boot-loaded engrams must not look idle to LRU
    this.correctionsCount.set(graphId, 0);
    const tEarlyCommit = Date.now() - tLoad;
    // Hollow shell: bundle lists sources but .gai has 0 nodes — schedule async
    // re-ingest so loadGraph returns immediately (32 doc pages must not block boot).
    if (committedNodes === 0 && bundleSources > 0) {
      this.scheduleBundleMaterialize(graphId, entry);
    }
    dbg(
      `[graphnosis-host] loadGraph engram[${redactId(graphId)}]: decrypt=${tDecrypt}ms fromBuffer=${tFromBuffer}ms bundle=${tBundle}ms earlyCommit=${tEarlyCommit}ms nodes=${committedNodes}`,
    );
    if (committedNodes === 0 && loadedGaiBytes > EMPTY_SAVE_BLOCK_MIN_BYTES) {
      if (bundleSources > 0) {
        console.error(
          `[graphnosis-host] loadGraph engram[${redactId(graphId)}]: WARNING committed 0 nodes from ${loadedGaiBytes}B .gai with ${bundleSources} bundle source(s) — check oplog reconcile`,
        );
      } else {
        console.error(
          `[graphnosis-host] loadGraph engram[${redactId(graphId)}]: WARNING committed 0 nodes from ${loadedGaiBytes}B .gai — engram will appear empty until recovery`,
        );
      }
      // Small empty shells (~450B template engrams, never ingested) are expected — no warning.
    }

    // Converge .gai + source bundle with the merged multi-device op-log.
    // Queued during boot — each reconcile calls sync adapter.build() and
    // replaying N of them concurrently starves IPC mid-sweep.
    this.scheduleReconcile(graphId, entry);

    // ── Background: load the embedding cache, then kick off rebuild ────────
    //
    // Cache load is best-effort — a corrupted or oversized cache must NOT
    // prevent the graph from being used. Fall back to a fresh empty cache;
    // buildEmbeddings below will repopulate it from the embed workers.
    //
    // buildEmbeddings fires AFTER cache.load() so it sees any warm entries
    // (cache hits avoid re-embedding already-computed nodes).
    //
    // The combined promise is stored on `entry.embeddingsBuilding` so callers
    // that need deterministic recall after loadGraph can `await
    // host.waitForEmbeddings(graphId)`. Production callers (UI) generally do
    // NOT wait — they're happy with TF-IDF-only results in the build window
    // and accept the upgrade once embeddings arrive. Tests and headless
    // scripts DO wait for stable comparisons.
    const buildPromise = cache.load()
      .catch((e: unknown) => {
        console.error(
          `[graphnosis-host] embcache load failed for ${graphId}: ${(e as Error).message} ` +
          `— starting with a fresh empty cache (embeddings will rebuild from scratch).`,
        );
      })
      .then(async () => {
        // IMPORTANT: use embedBackground (the dedicated background-lane
        // worker) not the foreground embed. With ≥ 2 workers this reserves
        // the foreground worker(s) for user-facing search/recall so they
        // never stall behind a cold-cache rebuild on a large engram.
        const bootSlot = this.bootSweepActive;
        if (bootSlot) await this.acquireBootEmbBuildSlot();
        try {
          await this.opts.adapter.buildEmbeddings(handle, {
            embed: cached(this.embedBackground, cache),
            dimensions: this.embedDimensions,
            id: this.embedAdapterId,
            batchSize: this.settings.ai.embedBatch,
          });
        } catch (e) {
          console.error(`[graphnosis-host] could not build embeddings on load for engram[${redactId(graphId)}]: ${(e as Error).message} — query will use TF-IDF only.`);
        } finally {
          if (bootSlot) this.releaseBootEmbBuildSlot();
          // Clear so callers can know the build is no longer in flight.
          if (this.graphs.get(graphId) === entry) entry.embeddingsBuilding = null;
        }
      });
    entry.embeddingsBuilding = buildPromise;
    // Orphan sourceRef cleanup — queued during boot like oplog reconcile.
    this.scheduleSourceRefSweep(graphId);
  }

  /**
   * Find and soft-delete orphan nodes whose CONTENT is literally a
   * sourceRef ("skill:<ts>:<label>" / "clip:<ts>:<label>" /
   * "ai-conversation:<ts>:<label>") and which are NOT referenced by any
   * source's nodeIds list.
   *
   * Background: the SDK's `appendText` wraps input as
   * `# ${sourceRef}\n\n${text}` before chunking, so the H1 always has
   * the raw sourceRef as its content. When that H1 chunk gets created
   * but the host-side splice into `source.nodeIds` fails or is skipped
   * (e.g. on a "0 chars" filter throw, on a content-hash dedup, or on
   * any caller error path), the H1 is left in the SDK graph with no
   * source pointer — a live orphan. The adapter-side filter we ship
   * NOW prevents new orphans; this sweep cleans up any that
   * accumulated before the fix shipped.
   *
   * Defensive: only sweeps nodes whose content matches the strict
   * sourceRef shape AND which carry a real source pointer in their
   * SDK metadata (`n.source.file`) that ALSO equals their content.
   * Real user notes that happen to contain `clip:1779...` as ordinary
   * text will not match.
   *
   * Idempotent: re-running the sweep on an already-clean graph is a
   * no-op. Each soft-delete bumps confidence to 0, so a second pass
   * filters them out before doing any work.
   */
  private async sweepSourceRefArtifacts(graphId: GraphId): Promise<void> {
    const g = this.graphs.get(graphId);
    if (!g) return;
    // Build the set of nodeIds that ARE referenced by some source.
    const referenced = new Set<string>();
    for (const s of g.sourceIndex.list()) {
      for (const nid of s.nodeIds) referenced.add(nid);
    }
    // sourceRef shape: "<kind>:<13-digit-ms-timestamp>:<label>". Tight
    // enough to avoid sweeping legitimate user notes that contain the
    // word "skill:" in prose.
    const SOURCE_REF_RE = /^(skill|clip|ai-conversation):\d{10,16}:.+/;
    const nodes = this.opts.adapter.inspectNodes(g.handle);
    const now = Date.now();
    const victims: string[] = [];
    for (const n of nodes) {
      // Already soft-deleted? skip — no need to delete twice.
      if (n.confidence <= 0.2) continue;
      if (n.validUntil !== undefined && n.validUntil <= now) continue;
      // Already linked to a source? skip — it's a real chunk, not an
      // orphan, even if its content looks like a sourceRef.
      if (referenced.has(n.id)) continue;
      // Defensive content check (full text, trimmed). contentPreview
      // is truncated to ~120 chars — the sourceRef pattern is always
      // shorter than that, but using full content avoids edge cases.
      const full = this.opts.adapter.getFullNodeContent(g.handle, n.id) ?? '';
      const trimmed = full.trim();
      if (!SOURCE_REF_RE.test(trimmed)) continue;
      // Second defensive check: the SDK's per-node `sourceFile`
      // should equal this same sourceRef — that's how appendText sets
      // it. If a user manually edited a node to have this exact text,
      // their node would have a DIFFERENT sourceFile (the real file
      // they ingested). This guard preserves user data.
      if (n.sourceFile && n.sourceFile !== trimmed) continue;
      victims.push(n.id);
    }
    if (victims.length === 0) return;
    for (const id of victims) {
      try {
        await this.opts.adapter.applyCorrection(g.handle, {
          kind: 'delete',
          nodeId: id,
          reason: 'sourceRef-header orphan sweep (post-load housekeeping)',
        });
      } catch {
        // Non-fatal — leave the node soft-alive; recall confidence
        // filters will still hide it from users.
      }
    }
    // Persist the deletions so they survive a restart. The sweep is
    // idempotent so re-running doesn't write again.
    g.dirty = true;
    try { await this.save(graphId); } catch { /* save failure is non-fatal */ }
    console.error(
      `[graphnosis-host] sourceRef-artifact sweep: removed ${victims.length} orphan node(s) from engram[${redactId(graphId)}]`,
    );
  }

  /** Resolve when the background embedding build for `graphId` finishes
   *  (no-op if no build is in flight, or if the graph isn't loaded).
   *  Used by tests + scripted flows to guarantee that recall sees a fully-
   *  built embedding index, eliminating the cold-load non-determinism. */
  async waitForEmbeddings(graphId: GraphId): Promise<void> {
    const g = this.graphs.get(graphId);
    if (!g || !g.embeddingsBuilding) return;
    await g.embeddingsBuilding;
  }

  /** Resolve when the background oplog reconcile for `graphId` finishes.
   *  Does NOT flush the whole boot-deferred batch (materialize + reconcile for
   *  every queued engram) — nodes.list must return promptly for hollow shells
   *  while bundle materialize runs in the background. Headless tests that need
   *  a full flush call flushBootDeferredWork() explicitly. */
  async waitForReconcile(graphId: GraphId): Promise<void> {
    const g = this.graphs.get(graphId);
    if (g?.reconcileBuilding) {
      await g.reconcileBuilding;
    }
  }

  /** Resolve when hollow-bundle materialize finishes (smoke tests / headless). */
  async waitForBundleMaterialize(graphId: GraphId): Promise<void> {
    for (let pass = 0; pass < 8; pass++) {
      const g = this.graphs.get(graphId);
      if (g?.bundleMaterializing) {
        await g.bundleMaterializing;
      }
      if (this.bootMaterializeQueue.includes(graphId)) {
        await this.flushBootDeferredWork();
        continue;
      }
      // Safety net: deferred flush may have finished before this graph was queued.
      if (g && this.opts.adapter.inspectNodes(g.handle).length === 0 && g.sourceIndex.list().length > 0) {
        await this.runBundleMaterialize(graphId, g);
      }
      return;
    }
  }

  private async loadBundle(graphId: GraphId): Promise<sources.SourceIndex> {
    try {
      const buf = await fs.readFile(this.bundlePath(graphId));
      const pt = await decrypt(new Uint8Array(buf), this.key);
      const records = JSON.parse(new TextDecoder().decode(pt)) as SourceRecord[];
      return SourceIndex.fromJSON(records);
    } catch {
      return new SourceIndex();
    }
  }

  /** Per-graph save coalescing + a global concurrency cap.
   *
   *  PER-GRAPH (correctness + coalesce): at most ONE save runs and ONE save is
   *  queued behind it per graphId. Extra save() calls that arrive while a save
   *  is already queued collapse onto that queued one — saveInner re-reads the
   *  live handle at toBuffer time, so a single trailing save captures every
   *  intervening mutation. A burst that dirties one engram 100× in 2s thus
   *  performs 2 saves, not 100. (The per-graph serialization is also required
   *  for correctness: writeFileAtomicWithBackup renames the .gai aside to .lkg
   *  and back, and a concurrent same-graph save could move the file out from
   *  under verify-after-write — a spurious ENOENT -> false rollback that
   *  discards a good write, observed during burst connector ingest.)
   *
   *  GLOBAL (memory): saveInner holds, live at once, the full toBuffer Buffer
   *  + the full ciphertext + the write copy — 2-3× the engram size in off-heap
   *  Buffers. Without a global cap, a brain pass or multi-engram ingest that
   *  dirties N large engrams runs N saves concurrently → an N× `external`
   *  spike (observed: 11 GB on a 17-engram cortex) that swaps the machine and
   *  drives the lag + fans. A small semaphore bounds peak at ~one engram. The
   *  work is CPU-bound on a single-threaded loop anyway, so capping concurrency
   *  costs almost no wall-clock. */
  private saveRunning: Map<GraphId, Promise<void>> = new Map();
  private savePending: Map<GraphId, Promise<void>> = new Map();
  private saveSlots = GLOBAL_SAVE_CONCURRENCY;
  private saveSlotQueue: Array<() => void> = [];

  private acquireSaveSlot(): Promise<void> {
    if (this.saveSlots > 0) { this.saveSlots--; return Promise.resolve(); }
    return new Promise<void>((resolve) => this.saveSlotQueue.push(resolve));
  }
  private releaseSaveSlot(): void {
    const next = this.saveSlotQueue.shift();
    if (next) next();          // hand the held slot straight to the next waiter
    else this.saveSlots++;     // no waiter — return the slot to the pool
  }

  /** Run one saveInner under the global concurrency cap. */
  private async runSaveCapped(graphId: GraphId): Promise<void> {
    await this.acquireSaveSlot();
    try { await this.saveInner(graphId); }
    finally { this.releaseSaveSlot(); }
  }

  /** Start a save and track it as the in-flight save for this graph, clearing
   *  the tracker on completion (only if we're still the current one). */
  private startSave(graphId: GraphId): Promise<void> {
    const run = this.runSaveCapped(graphId);
    // `tracked` is bookkeeping only and is never awaited; the real error reaches
    // the caller via the returned `run`. Swallow on `tracked` so a failed save
    // can't surface as an unhandledRejection from this un-awaited chain.
    const tracked: Promise<void> = run
      .catch(() => { /* surfaced to the caller via the awaited `run` */ })
      .finally(() => {
        if (this.saveRunning.get(graphId) === tracked) this.saveRunning.delete(graphId);
      });
    this.saveRunning.set(graphId, tracked);
    return run;
  }

  /** Mark a loaded graph dirty so the next `save()` persists it. Smoketest
   *  uses this to simulate boot reconcile marking a 0-node in-memory graph
   *  dirty before saveInner runs. */
  markGraphDirty(graphId: GraphId): void {
    this.must(graphId).dirty = true;
  }

  /** Smoketest-only counterpart to {@link markGraphDirty}. */
  markGraphClean(graphId: GraphId): void {
    this.must(graphId).dirty = false;
  }

  async save(graphId: GraphId): Promise<void> {
    const running = this.saveRunning.get(graphId);
    // Nothing in flight for this graph — start immediately.
    if (!running) return this.startSave(graphId);
    // A save is in flight. Coalesce onto a single trailing save: if one is
    // already queued, every further caller shares it (one trailing save
    // captures all mutations). Otherwise schedule the trailing save now.
    const pending = this.savePending.get(graphId);
    if (pending) return pending;
    const trailing = running.catch(() => { /* prior failure must not block the next */ })
      .then(() => {
        this.savePending.delete(graphId);
        return this.startSave(graphId);
      });
    this.savePending.set(graphId, trailing);
    return trailing;
  }

  /** Refuse to persist a 0-node graph over a substantial on-disk .gai or .lkg.
   *  Boot-time reconcile (and the pre-b5f10e2 adapter.build wipe) could mark an
   *  engram dirty and save an empty shell — writeFileAtomicWithBackup rolls the
   *  good .gai to .lkg first, so one bad save leaves .gai empty and .lkg intact
   *  (writings-qtb9, Jun 2026). Returns the max on-disk .gai/.lkg byte size. */
  private async substantialGraphBytesOnDisk(graphId: GraphId): Promise<number> {
    return maxFileAndLkgBytes(this.graphPath(graphId), LKG_SUFFIX);
  }

  private async shouldBlockShrinkSave(
    graphId: GraphId,
    newBytes: number,
    kind: 'gai' | 'bundle',
  ): Promise<boolean> {
    const target = kind === 'gai' ? this.graphPath(graphId) : this.bundlePath(graphId);
    return wouldBlockShrinkSaveAtPath(target, newBytes, LKG_SUFFIX);
  }

  private async logBlockedShrinkSave(
    graphId: GraphId,
    newBytes: number,
    kind: 'gai' | 'bundle',
  ): Promise<void> {
    const target = kind === 'gai' ? this.graphPath(graphId) : this.bundlePath(graphId);
    const onDisk = await maxFileAndLkgBytes(target, LKG_SUFFIX);
    await this.appendRecoveryLog({
      event: 'shrink_save_blocked', graphId, newBytes, onDiskBytes: onDisk, kind,
    });
    if (!this.saveBlockedWarned.has(graphId)) {
      this.saveBlockedWarned.add(graphId);
      console.warn(
        `[graphnosis-host] save blocked for engram[${redactId(graphId)}]: refusing to write ${newBytes}B ` +
        `${kind} over ${onDisk}B on-disk .gai/.lkg (would clobber last-known-good). ` +
        `Use Recovery → promote .lkg to restore; further blocks for this engram suppressed this session.`,
      );
      const { gaiBytes, lkgBytes } = await this.getGaiLkgByteSizes(graphId);
      this.emitRecoveryNeeded(graphId, 'shrink_save_blocked', gaiBytes, lkgBytes);
    }
    const blocked = (this.shrinkSaveBlockedCount.get(graphId) ?? 0) + 1;
    this.shrinkSaveBlockedCount.set(graphId, blocked);
    if (blocked >= SHRINK_SAVE_BRAIN_PAUSE_THRESHOLD && !this.brainMutationsPaused.has(graphId)) {
      this.brainMutationsPaused.add(graphId);
      if (!this.brainMutationsPauseWarned.has(graphId)) {
        this.brainMutationsPauseWarned.add(graphId);
        await this.appendRecoveryLog({
          event: 'brain_mutations_paused',
          graphId,
          blockedSaves: blocked,
          reason: 'persistent_shrink_save_blocked',
        });
        console.warn(
          `[graphnosis-host] brain mutations paused for engram[${redactId(graphId)}] after ${blocked} blocked saves ` +
          `(in-memory graph much smaller than on-disk .lkg). Use Recovery or promote .lkg to restore — ` +
          `mutations resume after a successful save.`,
        );
      }
    }
  }

  /** True when shrink-save has blocked repeatedly — autonomous brain skips this engram. */
  isBrainMutationsPaused(graphId: GraphId): boolean {
    return this.brainMutationsPaused.has(graphId);
  }

  /** Wire once from main.ts to surface recovery-needed events to the UI. */
  setRecoveryNeededHandler(handler: EngramRecoveryNeededHandler | null): void {
    this.onRecoveryNeeded = handler;
  }

  /** True when on-disk .lkg is substantially larger than .gai (shrink-save risk). */
  needsLkgPromote(gaiBytes: number, lkgBytes: number): boolean {
    return lkgBytes > EMPTY_SAVE_BLOCK_MIN_BYTES
      && lkgBytes > gaiBytes / SHRINK_SAVE_BLOCK_RATIO;
  }

  async getGaiLkgByteSizes(graphId: GraphId): Promise<{ gaiBytes: number; lkgBytes: number }> {
    const gaiPath = this.graphPath(graphId);
    let gaiBytes = 0;
    let lkgBytes = 0;
    try { gaiBytes = (await fs.stat(gaiPath)).size; } catch { /* missing */ }
    try { lkgBytes = (await fs.stat(`${gaiPath}${LKG_SUFFIX}`)).size; } catch { /* no .lkg */ }
    return { gaiBytes, lkgBytes };
  }

  /** Scan loaded + on-disk engrams for .lkg/.gai size mismatch. */
  async listLkgRecoveryCandidates(): Promise<LkgRecoveryCandidate[]> {
    const ids = new Set<GraphId>(this.listGraphs());
    try {
      const graphsDir = path.join(this.opts.cortexDir, 'graphs');
      for (const name of await fs.readdir(graphsDir)) {
        if (name.endsWith('.gai')) ids.add(name.slice(0, -4));
      }
    } catch { /* no graphs dir yet */ }

    const out: LkgRecoveryCandidate[] = [];
    for (const graphId of ids) {
      const { gaiBytes, lkgBytes } = await this.getGaiLkgByteSizes(graphId);
      if (lkgBytes <= EMPTY_SAVE_BLOCK_MIN_BYTES) continue;
      const needsPromote = this.needsLkgPromote(gaiBytes, lkgBytes);
      if (!needsPromote) continue;
      const meta = this.getGraphMetadata(graphId);
      out.push({
        graphId,
        displayName: meta?.displayName ?? graphId,
        gaiBytes,
        lkgBytes,
        needsPromote,
        loaded: this.graphs.has(graphId),
      });
    }
    return out.sort((a, b) => b.lkgBytes - a.lkgBytes);
  }

  /** Promote .lkg → .gai on disk and reload the engram if it is resident. */
  async promoteLkgAndReload(graphId: GraphId): Promise<{ ok: boolean; error?: string; nodes?: number }> {
    const { gaiBytes, lkgBytes } = await this.getGaiLkgByteSizes(graphId);
    if (!this.needsLkgPromote(gaiBytes, lkgBytes)) {
      return { ok: true };
    }
    const restored = await this.tryRestoreTinyGaiFromLkg(graphId, this.key, gaiBytes, lkgBytes);
    if (!restored) {
      return { ok: false, error: 'Could not decrypt or promote last-known-good (.lkg)' };
    }
    if (this.graphs.has(graphId)) {
      await this.reloadGraphFromDisk(graphId);
    }
    const g = this.graphs.get(graphId);
    const nodes = g ? this.opts.adapter.inspectNodes(g.handle).length : undefined;
    this.recoveryNeededEmitted.delete(graphId);
    this.shrinkSaveBlockedCount.delete(graphId);
    this.brainMutationsPaused.delete(graphId);
    this.saveBlockedWarned.delete(graphId);
    return { ok: true, ...(nodes !== undefined ? { nodes } : {}) };
  }

  /** Boot / post-promote: unload resident engram and load fresh from promoted .gai. */
  async reloadGraphFromDisk(graphId: GraphId): Promise<void> {
    const existing = this.graphs.get(graphId);
    if (existing) {
      if (existing.embeddingsBuilding) await existing.embeddingsBuilding.catch(() => {});
      if (existing.reconcileBuilding) await existing.reconcileBuilding.catch(() => {});
      if (existing.bundleMaterializing) await existing.bundleMaterializing.catch(() => {});
      try { await existing.cache.save(); } catch { /* best-effort */ }
      try { this.opts.adapter.dispose(existing.handle); } catch { /* best-effort */ }
      this.graphs.delete(graphId);
      this.lastAccessAt.delete(graphId);
    }
    this.loadGraphInflight.delete(graphId);
    await this.loadGraphInner(graphId);
  }

  /** Auto-promote every mismatched engram at boot; nudge UI when promote fails. */
  async runBootLkgRecoveryScan(): Promise<{ promoted: string[]; failed: LkgRecoveryCandidate[] }> {
    const promoted: string[] = [];
    const failed: LkgRecoveryCandidate[] = [];
    for (const c of await this.listLkgRecoveryCandidates()) {
      const result = await this.promoteLkgAndReload(c.graphId);
      if (result.ok) {
        promoted.push(c.graphId);
      } else {
        failed.push(c);
        this.emitRecoveryNeeded(c.graphId, result.error ?? 'lkg_promote_failed', c.gaiBytes, c.lkgBytes);
      }
    }
    return { promoted, failed };
  }

  private emitRecoveryNeeded(
    graphId: GraphId,
    reason: string,
    gaiBytes?: number,
    lkgBytes?: number,
  ): void {
    if (this.recoveryNeededEmitted.has(graphId)) return;
    this.recoveryNeededEmitted.add(graphId);
    const meta = this.getGraphMetadata(graphId);
    try {
      this.onRecoveryNeeded?.({
        graphId,
        displayName: meta?.displayName ?? graphId,
        reason,
        ...(gaiBytes !== undefined ? { gaiBytes } : {}),
        ...(lkgBytes !== undefined ? { lkgBytes } : {}),
      });
    } catch { /* UI hook must not break save/load */ }
  }

  /** Skip auto-relink / brain edge writes when shrink-save would block persistence. */
  private async shouldSkipMutationsForShrinkRisk(graphId: GraphId): Promise<boolean> {
    if (this.isBrainMutationsPaused(graphId)) return true;
    const { gaiBytes, lkgBytes } = await this.getGaiLkgByteSizes(graphId);
    return this.needsLkgPromote(gaiBytes, lkgBytes);
  }

  private async shouldBlockEmptySave(graphId: GraphId, nodeCount: number): Promise<boolean> {
    if (nodeCount > 0) return false;
    return (await this.substantialGraphBytesOnDisk(graphId)) > EMPTY_SAVE_BLOCK_MIN_BYTES;
  }

  private async saveInner(graphId: GraphId): Promise<void> {
    // Skip silently if the graph is no longer loaded — it was deleted/unloaded
    // (e.g. the user removed the engram while a connector batch was mid-flight).
    // There's nothing to persist, and throwing here would surface as an
    // unhandledRejection from the un-awaited save bookkeeping promise.
    const g = this.graphs.get(graphId);
    if (!g || !g.dirty) return;
    const nodeCount = this.opts.adapter.inspectNodes(g.handle).length;
    if (await this.shouldBlockEmptySave(graphId, nodeCount)) {
      const onDisk = await this.substantialGraphBytesOnDisk(graphId);
      await this.appendRecoveryLog({
        event: 'empty_save_blocked', graphId, nodeCount, onDiskBytes: onDisk,
      });
      if (!this.saveBlockedWarned.has(graphId)) {
        this.saveBlockedWarned.add(graphId);
        console.warn(
          `[graphnosis-host] save blocked for engram[${redactId(graphId)}]: refusing to persist ` +
          `0 nodes over ${onDisk}B on-disk .gai/.lkg — restore from .lkg or op-log recovery. ` +
          `Further blocks for this engram suppressed this session.`,
        );
        const { gaiBytes, lkgBytes } = await this.getGaiLkgByteSizes(graphId);
        this.emitRecoveryNeeded(graphId, 'empty_save_blocked', gaiBytes, lkgBytes);
      }
      return; // keep dirty=true so a recovered graph can save later
    }
    await fs.mkdir(path.dirname(this.graphPath(graphId)), { recursive: true });
    const buf = await this.opts.adapter.toBuffer(g.handle, this.key);
    const ct = await encrypt(buf, this.key, this.salt);
    if (await this.shouldBlockShrinkSave(graphId, ct.length, 'gai')) {
      await this.logBlockedShrinkSave(graphId, ct.length, 'gai');
      return;
    }
    // Atomic write: write to .tmp, fsync via writeFile flush, then rename.
    // POSIX rename is atomic — either the new file is fully there or the old
    // file is unchanged. A direct fs.writeFile() to the final path can leave
    // a half-written file if the process is killed mid-write (force-quit,
    // OS kill, crash). For a 20k-node engram that's 30+MB of ciphertext,
    // the write window is many seconds — wide enough that we've seen real
    // checksum-mismatch corruption in the wild (davinci-manual.gai, May 2026).
    // Atomic write that also rolls the prior good .gai to .lkg, so a bad write
    // can be rolled back here (verify below) or fallen back to at next load.
    await writeFileAtomicWithBackup(this.graphPath(graphId), Buffer.from(ct), LKG_SUFFIX);

    // Verify-after-write (large engrams only): re-read + reparse the bytes we
    // just committed while the good in-memory graph is still here. If the file
    // doesn't load back, roll the canonical file to last-known-good, log it,
    // and fail loudly — instead of letting corruption surface at the next boot.
    const verify = VERIFY_AFTER_WRITE_ENABLED
      ? await this.verifyGraphFileReadable(graphId, ct.length)
      : null;
    if (verify) {
      await this.appendRecoveryLog({
        event: 'verify_after_write_failed', graphId, kind: verify.kind, bytes: ct.length, error: verify.message,
      });
      if (verify.kind === 'parse') {
        // Genuine integrity failure — the bytes are bad. Roll the canonical
        // file back to last-known-good and fail loudly.
        const restored = await this.restoreLkg(this.graphPath(graphId));
        g.dirty = true; // keep dirty so a later save retries
        throw new Error(
          `save verification failed for engram '${redactId(graphId)}': ${verify.message}` +
          (restored ? ' — rolled back to last-known-good (.lkg)' : ' — no backup available to roll back'),
        );
      }
      // kind === 'read': could not re-read the file (transient / moved). Do
      // NOT roll back — that would discard a good write. The save itself
      // succeeded; just note it and move on.
      console.error(
        `[graphnosis-host] post-write verify could not re-read engram '${redactId(graphId)}' ` +
        `(${verify.message}); keeping the write, not rolling back.`,
      );
    }

    // Migrate legacy: if a .aikg file from a pre-0.2.6 cortex still exists
    // alongside the new .gai we just wrote, remove it now that we've
    // successfully persisted the canonical file.
    try { await fs.unlink(this.legacyGraphPath(graphId)); } catch { /* no legacy file */ }
    const bundleCt = await encrypt(
      new TextEncoder().encode(JSON.stringify(g.sourceIndex.toJSON())),
      this.key,
      this.salt,
    );
    if (await this.shouldBlockShrinkSave(graphId, bundleCt.length, 'bundle')) {
      await this.logBlockedShrinkSave(graphId, bundleCt.length, 'bundle');
      return;
    }
    await writeFileAtomicWithBackup(this.bundlePath(graphId), Buffer.from(bundleCt), LKG_SUFFIX);
    await g.cache.save();
    g.dirty = false;
    this.shrinkSaveBlockedCount.delete(graphId);
    this.brainMutationsPaused.delete(graphId);
    this.saveBlockedWarned.delete(graphId);
    // Per-graph mutation tick — bumps every successful save. Doubles
    // as the cursor returned by `getMutationCursor()` for reconciliation
    // polls. Background auto-relink edges also flow through here, so
    // even silent mutations are observable.
    const ts = Date.now();
    this.lastMutationAt.set(graphId, ts);
    this.mutationEvents.emit('mutation', { graphId, ts } satisfies MutationEvent);
  }

  // ── Integrity hardening: durable log, verify-after-write, .lkg fallback ────

  /** Append a structured, STRUCTURAL-ONLY event to `<cortex>/recovery.log`
   *  (never memory content) so corruption / recovery incidents are diagnosable
   *  after the fact, rather than living only in ephemeral stderr. Best-effort:
   *  a logging failure must never break the save/load it's annotating. */
  private async appendRecoveryLog(event: Record<string, unknown>): Promise<void> {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
      await fs.appendFile(path.join(this.opts.cortexDir, 'recovery.log'), line, 'utf8');
    } catch { /* diagnostics must never break the operation */ }
  }

  /** Re-read + decrypt + reparse the just-written .gai into a throwaway
   *  instance to confirm it's loadable. Returns null on success, or the error
   *  message. Gated by ciphertext size — only large engrams pay the reparse
   *  cost (and only they have ever hit a size-dependent serialization fault). */
  private lastVerifyAt: Map<GraphId, number> = new Map();

  private async verifyGraphFileReadable(
    graphId: GraphId,
    ctLen: number,
  ): Promise<{ kind: 'read' | 'parse'; message: string } | null> {
    if (ctLen < VERIFY_AFTER_WRITE_MIN_BYTES) return null;
    // Throttle per graph so a burst of saves doesn't reparse the file each time.
    const now = Date.now();
    if (now - (this.lastVerifyAt.get(graphId) ?? 0) < VERIFY_MIN_INTERVAL_MS) return null;
    this.lastVerifyAt.set(graphId, now);
    // A READ failure (e.g. ENOENT because a concurrent op moved the file) is
    // NOT corruption — it must never trigger a rollback that discards the good
    // write we just made. Only a PARSE failure (decrypt/checksum/HMAC) means
    // the bytes themselves are bad.
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.graphPath(graphId));
    } catch (e) {
      return { kind: 'read', message: (e as Error).message ?? 'unreadable' };
    }
    try {
      const plain = await decrypt(new Uint8Array(bytes), this.key);
      // Throwaway graphId so the verify load can't clobber the live instance.
      await this.opts.adapter.loadFromBuffer(`${graphId} verify`, plain, this.key);
      return null;
    } catch (e) {
      return { kind: 'parse', message: (e as Error).message ?? 'unknown error' };
    }
  }

  /** Restore `<target>.lkg` back over `<target>` (used when verify-after-write
   *  fails). Returns true if a backup existed and was restored. */
  private async restoreLkg(target: string): Promise<boolean> {
    try {
      await fs.rename(`${target}${LKG_SUFFIX}`, target);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[graphnosis-host] could not restore ${target} from .lkg: ${(e as Error).message}`);
      }
      return false;
    }
  }

  /** When the canonical .gai fails its integrity check on load, try the
   *  last-known-good sibling (.lkg) before quarantining-to-empty. On success,
   *  quarantines the bad .gai/.bundle pair and promotes the .lkg pair to
   *  canonical, returning the loaded handle. Returns null if there's no usable
   *  .lkg (caller then falls through to the existing quarantine path). */
  private async tryLoadFromLkg(
    graphId: GraphId,
    hmacKey: Uint8Array,
    badMsg: string,
  ): Promise<GraphHandle | null> {
    const gaiPath = this.graphPath(graphId);
    const lkgPath = `${gaiPath}${LKG_SUFFIX}`;
    if (!(await this.pathExists(lkgPath))) return null;
    let handle: GraphHandle;
    try {
      const lkgBytes = await fs.readFile(lkgPath);
      const lkgPlain = await decrypt(new Uint8Array(lkgBytes), this.key);
      handle = await this.opts.adapter.loadFromBuffer(graphId, lkgPlain, hmacKey);
    } catch (e) {
      await this.appendRecoveryLog({
        event: 'lkg_also_failed', graphId, badGaiError: badMsg, lkgError: (e as Error).message,
      });
      return null;
    }
    // Promote: quarantine the bad .gai/.bundle, restore the .lkg pair.
    const ts = Date.now();
    try { await fs.rename(gaiPath, `${gaiPath}.corrupt-${ts}`); } catch { /* may be gone */ }
    try { await fs.rename(this.bundlePath(graphId), `${this.bundlePath(graphId)}.corrupt-${ts}`); } catch { /* may be gone */ }
    try { await fs.rename(lkgPath, gaiPath); } catch (e) {
      console.error(`[graphnosis-host] could not promote .lkg for '${redactId(graphId)}': ${(e as Error).message}`);
    }
    try { await fs.rename(`${this.bundlePath(graphId)}${LKG_SUFFIX}`, this.bundlePath(graphId)); } catch { /* bundle .lkg may not exist */ }
    // The embedding cache belonged to the bad generation — drop it so it
    // rebuilds for the restored graph instead of serving stale vectors.
    try { await fs.unlink(this.cachePath(graphId)); } catch { /* already gone */ }
    await this.appendRecoveryLog({ event: 'recovered_from_lkg', graphId, badGaiError: badMsg });
    return handle;
  }

  /** When .gai is a tiny empty shell but .lkg is substantial, promote .lkg
   *  without waiting for an integrity failure (writings-qtb9, Jun 2026). */
  private async tryRestoreTinyGaiFromLkg(
    graphId: GraphId,
    hmacKey: Uint8Array,
    gaiBytes: number,
    lkgBytes: number,
  ): Promise<GraphHandle | null> {
    const gaiPath = this.graphPath(graphId);
    const lkgPath = `${gaiPath}${LKG_SUFFIX}`;
    let handle: GraphHandle;
    try {
      const lkgPlain = await decrypt(new Uint8Array(await fs.readFile(lkgPath)), this.key);
      handle = await this.opts.adapter.loadFromBuffer(graphId, lkgPlain, hmacKey);
    } catch (e) {
      await this.appendRecoveryLog({
        event: 'lkg_restore_failed', graphId, gaiBytes, lkgBytes, error: (e as Error).message,
      });
      return null;
    }
    const ts = Date.now();
    try { await fs.rename(gaiPath, `${gaiPath}.corrupt-${ts}`); } catch { /* may be gone */ }
    try { await fs.rename(lkgPath, gaiPath); } catch (e) {
      console.error(`[graphnosis-host] could not promote .lkg for '${redactId(graphId)}': ${(e as Error).message}`);
      return null;
    }
    const bundleLkg = `${this.bundlePath(graphId)}${LKG_SUFFIX}`;
    try { await fs.rename(bundleLkg, this.bundlePath(graphId)); } catch { /* optional */ }
    try { await fs.unlink(this.cachePath(graphId)); } catch { /* stale cache */ }
    await this.appendRecoveryLog({ event: 'recovered_from_lkg', graphId, gaiBytes, lkgBytes, reason: 'tiny_gai_shell' });
    return handle;
  }

  /** Subscribe to graph mutations. Returns an unsubscribe function. */
  onMutation(handler: (e: MutationEvent) => void): () => void {
    this.mutationEvents.on('mutation', handler);
    return () => this.mutationEvents.off('mutation', handler);
  }

  /** Snapshot of {graphId: lastMutationTs} for all loaded graphs. Used
   *  by the App as a cheap reconciliation cursor — compare against a
   *  locally-cached value to detect missed push events.
   *  Graphs not yet mutated this session report 0. */
  getMutationCursor(): Record<GraphId, number> {
    const out: Record<GraphId, number> = {};
    for (const graphId of this.listGraphs()) {
      out[graphId] = this.lastMutationAt.get(graphId) ?? 0;
    }
    return out;
  }

  /** Per-engram timestamp of the last successful save. Polled by the
   *  App to know when to invalidate its cached node/edge view. */
  private lastMutationAt: Map<GraphId, number> = new Map();

  /**
   * Expose the relink debounce as a public method so batch callers (e.g.
   * `ingestGraphnosisDocs`) can pass `skipAutoRelink: true` to suppress the
   * per-document relink and call `triggerRelink()` once at the end instead.
   */
  triggerRelink(graphId: GraphId): void {
    this.kickoffRelink(graphId);
  }

  /**
   * Await any debounced or in-flight auto-relink for one engram.
   * Benchmark / perf phases call this after bulk ingest so timed recalls
   * don't race relinkFullGraph (multi-second ONNX contention on large engrams).
   */
  async waitForRelinkIdle(graphId: GraphId): Promise<void> {
    const debounced = this.relinkDebounce.get(graphId);
    if (debounced !== undefined) {
      clearTimeout(debounced);
      this.relinkDebounce.delete(graphId);
      this.startRelinkPass(graphId);
    }
    for (;;) {
      const inFlight = this.relinkInFlight.get(graphId);
      if (inFlight) {
        await inFlight.catch(() => undefined);
        continue;
      }
      if (!this.relinkPending.has(graphId)) break;
      this.relinkPending.delete(graphId);
      this.startRelinkPass(graphId);
    }
  }

  async ingest(
    graphId: GraphId,
    kind: SourceRecord['kind'],
    ref: string,
    input: AppendDocumentInput,
    opts?: {
      addedBy?: string;
      triggeredBy?: string;
      skipAutoRelink?: boolean;
      skipSave?: boolean;
      skipOplogEmit?: boolean;
      obligation?: ObligationWriteInput;
    },
  ): Promise<SourceRecord> {
    const g = this.must(graphId);
    const sourceId = makeSourceId(kind, ref);
    // Short-circuit on duplicate sourceId. Without this, re-ingesting the
    // same file/clip created orphan SDK chunks (the header metadata gets a
    // fresh contentHash per call, so SDK dedup catches the body but not the
    // header) — bloating the graph by ~1 node per re-ingest call. The App's
    // contract is: same sourceId → same source. If you want a NEW version,
    // forgetSource() the old one first, then ingest under a new sourceRef.
    // Callers that want to FORCE re-ingest (e.g. reingestSource) bypass this
    // check by using the dedicated `reingestSource` method.
    const existing = g.sourceIndex.list().find((s) => s.sourceId === sourceId);
    if (existing) {
      // Return the existing source record unchanged. Identical behavior to
      // a successful no-op ingest (zero new nodes), but explicit instead of
      // creating ghost metadata chunks.
      return existing;
    }
    // Settings carry the user's chunk size + embed batch presets. Pass
    // through so the SDK uses them on this ingest. Reading on every call
    // (cheap object access) so changes via Settings UI take effect on the
    // very next file ingest without a sidecar restart.
    const ai = this.settings.ai;
    const result = await this.opts.adapter.appendDocument(g.handle, input, { chunkSize: ai.chunkSize });
    if (result.newNodeIds.length === 0) {
      // Hard fail rather than create an orphan source record. The MCP layer
      // surfaces this as an error to the AI client so the user sees the
      // failure instead of a misleading "Saved" success message.
      //
      // Pre-compute a couple of cheap signals to give the user a clearer
      // diagnostic than the original three-causes-in-one error:
      //   - byteLen=0 → file/content literally empty
      //   - sourceIndex already has this sourceId → user re-ingested same
      //     ref; treat as a dedup case rather than a parser failure
      //   - everything else → SDK parser produced no chunks for valid
      //     content. Could be markdown parser edge case, content too
      //     short to chunk, dedup against ANOTHER source with same
      //     content-hash inside the SDK, etc.
      const byteLen = typeof input.content === 'string'
        ? new TextEncoder().encode(input.content).byteLength
        : (input.content as Uint8Array | Buffer).byteLength;
      const sameSourceReingested = g.sourceIndex.list().some((s) => s.sourceId === sourceId);
      let reason: string;
      if (byteLen === 0) {
        reason = `${sourceId} — file is empty (0 bytes).`;
      } else if (sameSourceReingested) {
        reason = `${sourceId} — already saved (this exact source is already in your graph).`;
      } else {
        reason = `${sourceId} — already saved or nothing to extract (kind=${input.kind}, ${byteLen} bytes). ` +
                 `If this is a fresh file, the parser may have skipped it as malformed or too short to chunk.`;
      }
      throw new Error(`Ingest produced 0 nodes for source ${reason}`);
    }
    await this.opts.adapter.buildEmbeddings(g.handle, {
      embed: cached(this.embed, g.cache),
      dimensions: this.embedDimensions,
      id: this.embedAdapterId,
      batchSize: ai.embedBatch,
    });

    const record: SourceRecord & { contradictions?: unknown[] } = {
      sourceId,
      kind,
      ref,
      ingestedAt: Date.now(),
      graphId,
      nodeIds: result.newNodeIds,
      contentHash: hashContent(input.content),
      ...(opts?.addedBy ? { addedBy: opts.addedBy } : {}),
      ...(result.contradictions.length > 0 ? { contradictions: result.contradictions } : {}),
    };
    g.sourceIndex.add(record);
    g.dirty = true;

    // Live-ingest delta: push just THIS source's new nodes to any UI watching
    // the engram, so the 3D graph shows each source appear as it finishes —
    // O(newNodeIds), no full re-fetch. Only built when a sink is wired.
    if (this.graphDeltaBroadcaster && result.newNodeIds.length > 0) {
      try {
        this.graphDeltaBroadcaster({
          graphId, sourceId,
          nodes: this.opts.adapter.getNodesByIds(g.handle, result.newNodeIds),
        });
      } catch { /* delta is best-effort; never fail the ingest over it */ }
    }

    const trigAttr = opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {};
    const obligationPayload = opts?.obligation
      ? {
          obligationType: opts.obligation.obligationType,
          effectiveDate: opts.obligation.effectiveDate ?? Date.now(),
          expiresAt: opts.obligation.expiresAt,
        }
      : undefined;
    if (!opts?.skipOplogEmit) {
      this.oplogWriter.emit({
        graphId,
        op: 'ingestSource',
        target: { kind: 'source', id: sourceId },
        after: {
          ...record,
          ...trigAttr,
          ...(obligationPayload ? { obligation: obligationPayload } : {}),
        },
      });
      for (const nodeId of result.newNodeIds) {
        this.oplogWriter.emit({
          graphId,
          op: 'addNode',
          target: { kind: 'node', id: nodeId },
          after: {
            sourceId,
            ...trigAttr,
            ...(obligationPayload ? { obligation: obligationPayload } : {}),
          },
        });
      }
    }

    if (opts?.obligation && result.newNodeIds.length > 0) {
      await this.obligationIndex.register(
        graphId,
        result.newNodeIds[0]!,
        sourceId,
        opts.obligation,
      );
    }

    // Content cache — respect user settings + per-source size cap. Failures
    // are non-fatal (the ingest itself succeeded; the cache is bonus durability).
    try {
      const rawBytes: Uint8Array = typeof input.content === 'string'
        ? new TextEncoder().encode(input.content)
        : input.content instanceof Buffer
          ? new Uint8Array(input.content.buffer, input.content.byteOffset, input.content.byteLength)
          : (input.content as Uint8Array);
      if (settingsMod.shouldCache(this.settings, kind, rawBytes.byteLength)) {
        await this.writeContentBlob(
          sourceId,
          {
            kind,
            ref,
            docKind: input.kind,
            originalSize: rawBytes.byteLength,
            ...(record.contentHash ? { contentHash: record.contentHash } : {}),
            cachedAt: Date.now(),
          },
          rawBytes,
        );
      }
    } catch (e) {
      console.error(`[graphnosis-host] content cache write failed for ${sourceId}: ${(e as Error).message}`);
    }

    // Per-file save is a FULL-engram toBuffer+encrypt+write. In a batch ingest
    // (connector vault, bulk import) that's O(n²) serialization on a growing
    // engram — the dominant CPU + off-heap-Buffer churn behind the post-ingest
    // GC stalls. Batch callers pass skipSave:true and call save(graphId) ONCE
    // at the end of the batch instead. Durability is unaffected: the op-log
    // already recorded this ingest above, so a crash before the batch save
    // replays from the op-log.
    if (!opts?.skipSave) await this.save(graphId);
    // Notify the optional file-watcher so it can start watching this
    // path for on-disk changes. No-op when no watcher is installed or
    // when the source isn't file-backed.
    this.fileWatcher?.onSourceIngested(graphId, sourceId, ref, kind);
    // Fire-and-forget cross-doc relink. New clip might mention entities
    // that already appear in older nodes — without this pass the SDK
    // leaves it orphan. Coalesced + throttled inside kickoffRelink so
    // back-to-back ingests don't spawn parallel passes.
    //
    // Batch callers (e.g. ingestGraphnosisDocs) pass skipAutoRelink: true
    // to suppress the per-doc relink and call triggerRelink() once at the
    // end — this prevents O(N) relink passes when embedding is slower than
    // the RELINK_DEBOUNCE_MS window.
    if (!opts?.skipAutoRelink) {
      this.kickoffRelink(graphId);
    }
    return record;
  }

  /**
   * Ingest content split into multiple chunks under ONE source record.
   *
   * Each chunk runs:
   *   1. `appendDocument` — fast pure-JS text processing, runs freely outside
   *      the mutex so progress events can fire during parsing.
   *   2. `buildEmbeddings` — slow ONNX embedding, runs inside `wrap` to
   *      serialize against other embedding operations.
   *
   * A single SourceRecord is written after all chunks complete, so the UI
   * shows one entry for the whole document regardless of how many chunks were
   * used. Designed for large PDFs where a single `ingest()` call saturates the
   * Node.js event loop for minutes and starves IPC / progress traffic.
   *
   * Content caching is skipped — file-backed sources re-read from disk on
   * recovery; caching concatenated PDF text would be expensive and redundant.
   */
  async ingestChunked(
    graphId: GraphId,
    kind: SourceRecord['kind'],
    ref: string,
    chunks: AppendDocumentInput[],
    wrap: <T>(fn: () => Promise<T>) => Promise<T>,
    onChunk?: (chunksDone: number, totalChunks: number, nodesTotal: number) => void,
    opts?: { addedBy?: string; triggeredBy?: string },
  ): Promise<SourceRecord> {
    if (chunks.length === 0) throw new Error('ingestChunked: at least one chunk required');
    const g = this.must(graphId);
    const sourceId = makeSourceId(kind, ref);
    const allNodeIds: string[] = [];
    const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

    const ai = this.settings.ai;
    for (const [i, chunk] of chunks.entries()) {
      // Text → node extraction: fast JS, no mutex needed.
      const result = await this.opts.adapter.appendDocument(g.handle, chunk, { chunkSize: ai.chunkSize });
      // ONNX embedding: slow, fastembed/ort is not concurrency-safe — serialize.
      await wrap(() => this.opts.adapter.buildEmbeddings(g.handle, {
        embed: cached(this.embed, g.cache),
        dimensions: this.embedDimensions,
        id: this.embedAdapterId,
        batchSize: ai.embedBatch,
      }));
      allNodeIds.push(...result.newNodeIds);
      onChunk?.(i + 1, chunks.length, allNodeIds.length);
      // Yield so the event loop can service IPC connections between chunks.
      await yieldToLoop();
    }

    if (allNodeIds.length === 0) {
      const alreadyExists = g.sourceIndex.list().some((s) => s.sourceId === sourceId);
      throw new Error(
        `Ingest produced 0 nodes for source ${sourceId}` +
        (alreadyExists
          ? ' — already saved (this source is already in your graph).'
          : ' — content may be empty or unparseable.'),
      );
    }

    const record: SourceRecord = {
      sourceId,
      kind,
      ref,
      ingestedAt: Date.now(),
      graphId,
      nodeIds: allNodeIds,
      ...(opts?.addedBy ? { addedBy: opts.addedBy } : {}),
      // contentHash omitted — file-backed PDFs recover from disk, not cache.
    };
    g.sourceIndex.add(record);
    g.dirty = true;

    const trigAttrChunked = opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {};
    this.oplogWriter.emit({
      graphId,
      op: 'ingestSource',
      target: { kind: 'source', id: sourceId },
      after: { ...record, ...trigAttrChunked },
    });
    for (const nodeId of allNodeIds) {
      this.oplogWriter.emit({
        graphId,
        op: 'addNode',
        target: { kind: 'node', id: nodeId },
        after: { sourceId, ...trigAttrChunked },
      });
    }

    await this.save(graphId);
    this.fileWatcher?.onSourceIngested(graphId, sourceId, ref, kind);
    this.kickoffRelink(graphId);
    return record;
  }

  // ── Post-ingest auto-relink ─────────────────────────────────────────
  //
  // After every successful ingest we run a cross-doc entity-overlap pass
  // (see adapter.relinkFullGraph) to wire the freshly-added node(s) into
  // existing nodes that share entities. The pass is O(N²); we coalesce
  // back-to-back ingests on the same engram and throttle by node count.
  //
  // `relinkInFlight` tracks active passes per engram; `relinkPending`
  // queues a re-run if another ingest fired while a pass was running
  // (so the latest state is always picked up after the in-flight one
  // settles).

  private relinkInFlight: Map<GraphId, Promise<void>> = new Map();
  private relinkPending: Set<GraphId> = new Set();
  /** Engrams that need a relink once the boot engram sweep finishes. */
  private relinkDeferredDuringBoot: Set<GraphId> = new Set();
  private relinkDebounce: Map<GraphId, ReturnType<typeof setTimeout>> = new Map();

  // Debounce delay before starting a relink pass. Resets on every new
  // ingest so back-to-back batch ingests only trigger one pass at the end.
  private static RELINK_DEBOUNCE_MS = 1500;

  private kickoffRelink(graphId: GraphId): void {
    if (this.bootSweepActive) {
      this.relinkDeferredDuringBoot.add(graphId);
      return;
    }
    // Reset (or start) the debounce timer on every ingest call so rapid
    // batch ingests coalesce into a single pass once ingest goes quiet.
    const existing = this.relinkDebounce.get(graphId);
    if (existing !== undefined) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.relinkDebounce.delete(graphId);
      this.startRelinkPass(graphId);
    }, GraphnosisHost.RELINK_DEBOUNCE_MS);
    this.relinkDebounce.set(graphId, timer);
  }

  private startRelinkPass(graphId: GraphId): void {
    if (this.relinkInFlight.has(graphId)) {
      // A pass is already running (started by a previous debounce window) —
      // queue one re-run so the latest state is picked up after it settles.
      this.relinkPending.add(graphId);
      return;
    }
    const p = this.runRelink(graphId).catch((e) => {
      console.error(`[host] auto-relink failed for engram[${redactId(graphId)}]: ${(e as Error).message}`);
    }).finally(() => {
      this.relinkInFlight.delete(graphId);
      if (this.relinkPending.delete(graphId)) {
        this.startRelinkPass(graphId);
      }
    });
    this.relinkInFlight.set(graphId, p);
  }

  private async runRelink(graphId: GraphId): Promise<void> {
    if (await this.shouldSkipMutationsForShrinkRisk(graphId)) return;
    const g = this.graphs.get(graphId);
    if (!g) return; // engram unloaded mid-pass; nothing to do
    const maxNodes = this.settings.ai.autoRelinkMaxNodes;
    const result = await this.opts.adapter.relinkFullGraph(g.handle, { maxNodes });
    if (result.skipped) {
      // Log skip reasons at debug — useful when users wonder why their
      // big engram isn't getting auto-linked.
      console.error(
        `[host] auto-relink skipped for engram[${redactId(graphId)}]: ${result.skipReason} ` +
        `(active=${result.activeNodes}, cap=${maxNodes})`,
      );
      return;
    }
    if (result.newEdges.length === 0) {
      // Nothing to do — no entity overlaps formed. Don't dirty/save.
      return;
    }
    // Emit one op-log event per new edge for audit + recovery. Group
    // by the same `addEdge` op kind we use for user-created links; the
    // `after.reason` makes auto vs manual distinguishable.
    for (const e of result.newEdges) {
      this.oplogWriter.emit({
        graphId,
        op: 'addEdge',
        target: { kind: 'edge', id: e.edgeId },
        after: {
          fromNodeId: e.a,
          toNodeId: e.b,
          type: e.type,
          weight: e.weight,
          directed: false,
          reason: `auto-relink: ${e.type} (${e.sharedEntities.slice(0, 3).join(', ')}${e.sharedEntities.length > 3 ? '…' : ''})`,
        },
      });
    }
    g.dirty = true;
    await this.save(graphId);
    // Per-ingest auto-relink summary — useful for "is the engram growing?"
    // diagnostics but pure noise in production logs. Debug-only.
    dbg(
      `[host] auto-relink wove ${result.newEdges.length} edges across ${result.activeNodes} active nodes in engram[${redactId(graphId)}]`,
    );
  }

  // ── Re-ingest (re-chunk + re-embed from cached content) ─────────────────
  //
  // Different from re-embed (Batch 4): re-embed runs new vectors over
  // EXISTING chunks. Re-ingest recreates the chunks themselves from the
  // original source content, then re-embeds. Use cases:
  //   - User switched chunk size and wants existing memory to use the new
  //     setting.
  //   - SDK shipped better section detection / NER and they want their
  //     existing memory to benefit.
  //   - User suspects ingest-time decisions were wrong for a specific source.
  //
  // Requires the cached content blob for each source (the encrypted .bin
  // at <cortex>/content/<sourceId>.bin). Sources whose cache was off or
  // expired are skipped with a clear reason.
  //
  // Atomicity: soft-delete current nodes BEFORE the new ingest. If the new
  // ingest fails the old nodes stay soft-deleted (recoverable from the
  // op-log / snapshot). We don't try to roll back inside the host — that's
  // the snapshot machinery's job.

  /** Reingest one source from its cached content blob. Throws when the
   *  cache is unavailable so the caller can decide how to surface that
   *  (skip in a loop, error to the user in single-source mode). */
  async reingestSource(graphId: GraphId, sourceId: string): Promise<{ skipped: false; newNodeIds: string[] } | { skipped: true; reason: string }> {
    const g = this.must(graphId);
    const record = g.sourceIndex.get(sourceId);
    if (!record) {
      return { skipped: true, reason: 'source not found in index' };
    }
    const blob = await this.readContentBlob(sourceId);
    if (!blob) {
      const bundled = bundledDocForRef(record.ref);
      if (bundled) {
        await this.forgetSource(graphId, sourceId, { triggeredBy: 'user:reingest' });
        await this.purgeOrphanNodes(graphId);
        const result = await this.ingest(
          graphId,
          record.kind,
          record.ref,
          bundled,
          { triggeredBy: 'user:reingest', skipOplogEmit: true, skipAutoRelink: true, ...(record.addedBy ? { addedBy: record.addedBy } : {}) },
        );
        return { skipped: false, newNodeIds: result.nodeIds };
      }
      return { skipped: true, reason: 'content cache unavailable (cache was off or expired at ingest time)' };
    }
    // Soft-delete the existing nodes for this source so the new ingest's
    // chunks replace them. forgetSource also wipes the cache blob — but we
    // already loaded it into memory above, so the order is safe.
    await this.forgetSource(graphId, sourceId, { triggeredBy: 'user:reingest' });
    // Purge any orphan nodes left over from a previous partial reingest.
    // Without this, a crash or IPC timeout mid-ingest can leave active nodes
    // in the SDK graph with no source record — those orphan hashes then block
    // the full chunk count from being restored.
    await this.purgeOrphanNodes(graphId);
    // Reconstruct AppendDocumentInput from the cache header + bytes.
    const docInput: AppendDocumentInput = {
      kind: blob.header.docKind,
      content: blob.header.docKind === 'pdf'
        ? Buffer.from(blob.content)
        : new TextDecoder().decode(blob.content),
      sourceRef: record.ref,
    };
    const result = await this.ingest(
      graphId,
      record.kind,
      record.ref,
      docInput,
      { triggeredBy: 'user:reingest', ...(record.addedBy ? { addedBy: record.addedBy } : {}) },
    );
    return { skipped: false, newNodeIds: result.nodeIds };
  }

  /** Reingest every source in one engram. Progress fires before each
   *  source so the UI can name the current item. */
  async reingestAllSources(
    graphId: GraphId,
    onProgress?: (event: { graphId: string; sourceId: string; ref: string; index: number; total: number }) => void,
    signal?: AbortSignal,
  ): Promise<{ reingested: number; cancelled: boolean; skipped: Array<{ sourceId: string; reason: string }>; failed: Array<{ sourceId: string; ref: string; error: string }> }> {
    const g = this.must(graphId);
    // Snapshot the source list NOW — reingest mutates sourceIndex (forget +
    // re-add with the same sourceId), so iterating live would be brittle.
    const sourcesToProcess = g.sourceIndex.list().slice();
    let reingested = 0;
    let cancelled = false;
    const skipped: Array<{ sourceId: string; reason: string }> = [];
    const failed: Array<{ sourceId: string; ref: string; error: string }> = [];
    for (let i = 0; i < sourcesToProcess.length; i++) {
      if (signal?.aborted) { cancelled = true; break; }
      const src = sourcesToProcess[i]!;
      onProgress?.({ graphId, sourceId: src.sourceId, ref: src.ref, index: i, total: sourcesToProcess.length });
      try {
        const result = await this.reingestSource(graphId, src.sourceId);
        if (result.skipped) {
          skipped.push({ sourceId: src.sourceId, reason: result.reason });
        } else {
          reingested += 1;
        }
      } catch (e) {
        failed.push({ sourceId: src.sourceId, ref: src.ref, error: (e as Error).message });
        console.error(`[host] reingestAllSources(${redactPair(graphId, src.sourceId)}) failed: ${(e as Error).message}`);
      }
    }
    onProgress?.({ graphId, sourceId: '', ref: '', index: sourcesToProcess.length, total: sourcesToProcess.length });
    return { reingested, cancelled, skipped, failed };
  }

  /** Reingest every source across every loaded engram. Sequential — keeps
   *  the worker pool happy and progress events monotonic. */
  async reingestAllGraphs(
    onProgress?: (event: { graphId: string; graphIndex: number; graphsTotal: number; sourceId: string; ref: string; index: number; total: number }) => void,
    signal?: AbortSignal,
  ): Promise<{ reingested: number; cancelled: boolean; skipped: number; failed: number; perGraph: Array<{ graphId: string; reingested: number; skipped: Array<{ sourceId: string; reason: string }>; failed: Array<{ sourceId: string; ref: string; error: string }> }> }> {
    const graphIds = this.listGraphs();
    let totalReingested = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let cancelled = false;
    const perGraph: Array<{ graphId: string; reingested: number; skipped: Array<{ sourceId: string; reason: string }>; failed: Array<{ sourceId: string; ref: string; error: string }> }> = [];
    for (let gi = 0; gi < graphIds.length; gi++) {
      if (signal?.aborted) { cancelled = true; break; }
      const graphId = graphIds[gi]!;
      const result = await this.reingestAllSources(graphId, (evt) => {
        onProgress?.({ graphIndex: gi, graphsTotal: graphIds.length, ...evt });
      }, signal);
      totalReingested += result.reingested;
      totalSkipped += result.skipped.length;
      totalFailed += result.failed.length;
      perGraph.push({ graphId, ...result });
      if (result.cancelled) { cancelled = true; break; }
    }
    return { reingested: totalReingested, cancelled, skipped: totalSkipped, failed: totalFailed, perGraph };
  }

  /** Block forget / edit / transfer when engram or source is under legal hold. */
  private assertMutationAllowed(graphId: GraphId, sourceId?: string, nodeId?: string): void {
    const meta = this.getGraphMetadata(graphId);
    assertEngramNotOnLegalHold(meta, graphId);
    if (sourceId) {
      const rec = this.getSourceRecord(graphId, sourceId);
      assertSourceNotOnLegalHold(rec, graphId, sourceId, meta);
      return;
    }
    if (nodeId) {
      const sid = this.getNodeSource(graphId, nodeId);
      if (sid) {
        const rec = this.getSourceRecord(graphId, sid);
        assertSourceNotOnLegalHold(rec, graphId, sid, meta);
      }
    }
  }

  /**
   * Toggle engram-level preservation (legal hold). Persisted in graph metadata
   * and recorded in the op-log for audit export.
   */
  async setEngramPreserve(
    graphId: GraphId,
    preserved: boolean,
    matter?: string,
  ): Promise<void> {
    this.must(graphId);
    const existing: settingsMod.GraphMetadata = this.settings.graphMetadata[graphId] ?? {
      template: 'personal' as settingsMod.GraphTemplate,
      displayName: graphId,
      createdAt: 0,
    };
    const updated: settingsMod.GraphMetadata = { ...existing };
    if (preserved) {
      updated.legalHold = true;
      updated.legalHoldAt = Date.now();
      if (matter) updated.legalHoldMatter = matter;
      else delete updated.legalHoldMatter;
    } else {
      delete updated.legalHold;
      delete updated.legalHoldAt;
      delete updated.legalHoldMatter;
    }
    await this.setGraphMetadata(graphId, updated);
    this.oplogWriter.emit({
      graphId,
      op: 'merge',
      target: { kind: 'source', id: '__compliance:engram-preserve' },
      after: { action: 'setEngramPreserve', preserved, matter, triggeredBy: 'compliance' },
    });
    this.invalidateOplogCache();
  }

  async setSourceLegalHold(
    graphId: GraphId,
    sourceId: string,
    held: boolean,
    matter?: string,
  ): Promise<void> {
    const g = this.must(graphId);
    const rec = g.sourceIndex.get(sourceId);
    if (!rec) throw new Error(`Source ${sourceId} not found in engram ${graphId}.`);
    const updated: SourceRecord = { ...rec };
    if (held) {
      updated.legalHold = true;
      updated.legalHoldAt = Date.now();
      if (matter) updated.legalHoldMatter = matter;
      else delete updated.legalHoldMatter;
    } else {
      delete updated.legalHold;
      delete updated.legalHoldAt;
      delete updated.legalHoldMatter;
    }
    g.sourceIndex.upsert(updated);
    g.dirty = true;
    await this.save(graphId);
    this.oplogWriter.emit({
      graphId,
      op: 'merge',
      target: { kind: 'source', id: sourceId },
      after: { action: 'setLegalHold', held, matter, triggeredBy: 'compliance' },
    });
    this.invalidateOplogCache();
  }

  async forgetSource(graphId: GraphId, sourceId: string, opts?: { triggeredBy?: string; skipOplogEmit?: boolean }): Promise<{ nodeIds: string[] }> {
    const g = this.must(graphId);
    if (opts?.triggeredBy !== 'compliance:retention') {
      this.assertMutationAllowed(graphId, sourceId);
    }
    // Grab the ref BEFORE the forget so we can notify the file-watcher.
    // sourceIndex.forget() removes the record; we'd otherwise lose the path.
    const priorRecord = g.sourceIndex.get(sourceId);
    const nodeIds = g.sourceIndex.forget(sourceId);
    const forgetTrigAttr = opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {};
    const forgetStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    for (let i = 0; i < nodeIds.length; i++) {
      const nodeId = nodeIds[i]!;
      // Capture the content preview BEFORE soft-deleting so the activity log can show it.
      const contentPreview = this.opts.adapter.inspectNodes(g.handle).find(n => n.id === nodeId)?.contentPreview;
      // ── Dedup-table release pass ────────────────────────────────────────
      // Rewrite the node's content to a unique tombstone BEFORE soft-deleting.
      // The SDK keeps a content-hash dedup table covering EVERY node — even
      // soft-deleted ones (see addDocumentsToGraph in
      // node_modules/@nehloo/graphnosis/dist/core/graph/incremental.js).
      // Without tombstoning, a later `ingest` or `insertNodeAt` whose content
      // matches an old node from THIS forgotten source returns zero new ids,
      // breaking re-imports and in-place retrain migrations.
      //
      // By overwriting content first via applyCorrection({kind:'edit', ...}),
      // we release the ORIGINAL content hash from the dedup table; the next
      // insert with that text creates a fresh node. The audit trail is
      // preserved — both ops appear in the op-log in order — and the user-
      // visible "forget" semantics are unchanged: confidence still drops to
      // soft-deleted on the immediately-following delete.
      try {
        await this.opts.adapter.applyCorrection(g.handle, {
          kind: 'edit',
          nodeId,
          content: `__gn-forgotten:${forgetStamp}:${i}:${nodeId}__`,
          reason: `forget source ${sourceId} (dedup-table release)`,
        });
      } catch {
        // Edit refused — proceed to delete anyway. The resurrection fallback
        // in graphnosis-impl.ts picks up any subsequent dedup hits.
      }
      // Soft-delete in Graphnosis: node stays for audit, confidence drops, won't be returned by queries.
      await this.opts.adapter.applyCorrection(g.handle, { kind: 'delete', nodeId, reason: `forget source ${sourceId}` });
      if (!opts?.skipOplogEmit) {
        this.oplogWriter.emit({
          graphId,
          op: 'deleteNode',
          target: { kind: 'node', id: nodeId },
          before: { sourceId, preview: contentPreview, ...forgetTrigAttr },
        });
      }
    }
    if (!opts?.skipOplogEmit) {
      this.oplogWriter.emit({
        graphId,
        op: 'forgetSource',
        target: { kind: 'source', id: sourceId },
        before: { ref: priorRecord?.ref, kind: priorRecord?.kind, nodeCount: nodeIds.length, ...forgetTrigAttr },
      });
    }
    // Forget means forget everywhere — drop the cached content blob too.
    // If the user re-ingests later, we'll cache a fresh copy.
    await this.deleteContentBlob(sourceId);
    g.dirty = true;
    await this.save(graphId);

    // Prune cross-engram connections and GNN edges that reference the
    // now-forgotten nodes. They're soft-deleted (confidence 0, never recalled)
    // so any cross-engram link anchored to one of them is permanently inert.
    if (nodeIds.length > 0) {
      const forgottenSet = new Set(nodeIds);
      try {
        const connections = await this.loadConnectionStore();
        const cleanedConns = connections.filter(
          (c) => !forgottenSet.has(c.nodeA) && !forgottenSet.has(c.nodeB),
        );
        if (cleanedConns.length !== connections.length) {
          await this.saveConnectionStore(cleanedConns);
        }
      } catch (e) {
        console.error(`[graphnosis-host] forgetSource: could not prune connection store: ${(e as Error).message}`);
      }
      try {
        const gnnEdges = await this.loadGnnStore();
        const cleanedEdges = gnnEdges.filter(
          (e) => !forgottenSet.has(e.from) && !forgottenSet.has(e.to),
        );
        if (cleanedEdges.length !== gnnEdges.length) {
          await this.saveGnnStore(cleanedEdges);
        }
      } catch (e) {
        console.error(`[graphnosis-host] forgetSource: could not prune GNN store: ${(e as Error).message}`);
      }
    }

    if (nodeIds.length > 0) {
      const { enqueueSkillsForNodeChange } = await import('./skill-retrain-queue.js');
      await enqueueSkillsForNodeChange(this, graphId, nodeIds, 'source-forgotten');
    }

    // Tell the file-watcher to stop watching this path. Doing this AFTER
    // save() (vs. before) means the path stays in the watch set during
    // the brief window where the encrypted bundle is being rewritten —
    // harmless either way since the watcher debounces, but the post-save
    // order keeps the "watch set mirrors persisted state" invariant.
    if (priorRecord) {
      this.fileWatcher?.onSourceForgotten(graphId, sourceId, priorRecord.ref);
    }

    // If the user opted into "Purge forever" mode, physically remove the
    // soft-deleted nodes by rebuilding the graph. Failures here are
    // surfaced via the returned report — the soft-delete already succeeded
    // either way, so the user can also re-run "Purge now" manually later.
    let purge: PurgeReport | undefined;
    if (this.settings.forget.mode === 'purge') {
      try {
        purge = await this.purgeSoftDeleted(graphId);
      } catch (e) {
        console.error(`[graphnosis-host] auto-purge after forget failed: ${(e as Error).message}`);
      }
    }
    return { nodeIds, ...(purge ? { purge } : {}) };
  }

  /**
   * Soft-delete any "orphan" nodes in an engram — active nodes (confidence > 0.1)
   * that are not referenced by any source record in the source index.
   *
   * Orphans arise when a previous ingest or reingest call created nodes in the
   * SDK graph and saved them to disk, but a crash or IPC timeout prevented the
   * matching source record from being persisted. Those active nodes then block
   * future re-ingest of the same content because `addDocumentsToGraph` sees
   * their content hashes in `existingHashes` and skips the duplicate chunks.
   *
   * Called automatically before every reingest so the full chunk count is
   * always restored even after a prior partial failure.
   */
  async purgeOrphanNodes(graphId: GraphId): Promise<string[]> {
    const g = this.must(graphId);
    // Build the set of all node IDs that belong to a known source record.
    const trackedIds = new Set<string>();
    for (const src of g.sourceIndex.list()) {
      for (const nodeId of src.nodeIds ?? []) {
        trackedIds.add(nodeId);
      }
    }
    // Find active nodes not tracked by any source.
    const allNodes = this.opts.adapter.inspectNodes(g.handle);
    const orphans = allNodes.filter((n) => n.confidence > 0.1 && !trackedIds.has(n.id));
    if (orphans.length === 0) return [];
    console.log(`[host] purgeOrphanNodes(${graphId}): soft-deleting ${orphans.length} orphan node(s)`);
    for (const node of orphans) {
      await this.opts.adapter.applyCorrection(g.handle, {
        kind: 'delete',
        nodeId: node.id,
        reason: 'purge orphan node — no source record (previous ingest crashed mid-save)',
      });
    }
    g.dirty = true;
    await this.save(graphId);
    return orphans.map((n) => n.id);
  }

  /**
   * Move a source (and all its nodes) from one engram to another.
   *
   * For file-backed sources the original file is re-read from disk.
   * For cached non-file sources (clip, ai-conversation) the encrypted
   * content blob is decrypted here BEFORE the forget so it isn't deleted.
   * Throws if a non-file source has no cached content.
   */
  async moveSource(
    fromGraphId: GraphId,
    sourceId: string,
    toGraphId: GraphId,
  ): Promise<{ newRecord: SourceRecord; forgottenNodeIds: string[] }> {
    if (fromGraphId === toGraphId) throw new Error('Source and destination engram must be different.');
    const fromG = this.must(fromGraphId);
    this.must(toGraphId); // ensure destination exists
    this.assertMutationAllowed(fromGraphId, sourceId);
    assertEngramNotOnLegalHold(this.getGraphMetadata(toGraphId), toGraphId);

    const rec = fromG.sourceIndex.get(sourceId);
    if (!rec) throw new Error(`Source ${sourceId} not found in engram ${fromGraphId}.`);

    let newRecord: SourceRecord;
    let forgottenNodeIds: string[];

    if (rec.kind === 'file') {
      // File sources: re-read from disk into target, then forget from source.
      const { ingestFile } = await import('./ingest.js');
      const { withEmbedding } = await import('./embedding-queue.js');
      ({ nodeIds: forgottenNodeIds } = await this.forgetSource(fromGraphId, sourceId, { triggeredBy: 'user:ingest' }));
      newRecord = await ingestFile(this, toGraphId, rec.ref, {
        wrapIngest: (fn) => withEmbedding(fn),
        triggeredBy: 'user:ingest',
      });
    } else {
      // Non-file sources (clip, ai-conversation): prefer the encrypted blob
      // (exact original bytes). Fall back to reconstructing from embedded node
      // text when the blob is absent (e.g. caching was off when the clip was
      // saved, or the blob was pruned). Node text is always in memory.
      const blob = await this.readContentBlob(sourceId);
      let input: AppendDocumentInput;
      if (blob) {
        input = { kind: blob.header.docKind, content: blob.content, sourceRef: blob.header.ref };
      } else {
        const allNodes = this.listNodes(fromGraphId) as Array<{ id: string; text?: string; contentPreview?: string }>;
        const nodeTexts = allNodes
          .filter((n) => this.getNodeSource(fromGraphId, n.id) === sourceId)
          .map((n) => n.text ?? n.contentPreview ?? '')
          .filter(Boolean);
        if (!nodeTexts.length) {
          throw new Error(
            `Cannot move source ${sourceId} (${rec.kind}): no cached content and no recoverable node text available.`,
          );
        }
        input = { kind: 'markdown', content: nodeTexts.join('\n\n'), sourceRef: rec.ref };
      }
      ({ nodeIds: forgottenNodeIds } = await this.forgetSource(fromGraphId, sourceId, { triggeredBy: 'user:ingest' }));
      newRecord = await this.ingest(toGraphId, rec.kind, rec.ref, input, { triggeredBy: 'user:ingest' });
    }

    // NOTE: kickoffRelink(toGraphId) is already called inside this.ingest() above.
    // Calling it again here would double-fire the debounce, causing two relink
    // passes instead of one when a file source is moved (which calls ingest directly).
    return { newRecord, forgottenNodeIds };
  }

  /**
   * Optional observer notified with the result of every federated recall —
   * wired by the sidecar to ReinforcementEngine so co-recalled memories can
   * have their connections strengthened ("fire together, wire together").
   * Never throws into the recall path.
   */
  private plasticityObserver: ((sub: federation.FederatedSubgraph) => void) | undefined;

  /** Register the recall observer. Called once at sidecar startup. */
  setPlasticityObserver(fn: (sub: federation.FederatedSubgraph) => void): void {
    this.plasticityObserver = fn;
  }

  /**
   * Optional local-LLM getter wired by the sidecar at boot. Returns the
   * shared OllamaLlm instance, or null if the user hasn't installed Ollama.
   * The host calls it lazily on recall so the master toggle + capability
   * flags are always evaluated from current settings, never cached.
   */
  private llmGetter: (() => import('./correction.js').LocalLlm | null) | undefined;

  /** Register the local-LLM getter. Called once at sidecar startup. */
  setLocalLlmGetter(fn: () => import('./correction.js').LocalLlm | null): void {
    this.llmGetter = fn;
  }

  async recall(query: string, opts?: { budget?: SubgraphBudget; onlyGraphIds?: string[]; exceptGraphIds?: string[]; perGraphAnchorMax?: number; skipEnrichment?: boolean; noLoadOnDemand?: boolean; consentedGraphIds?: string[]; recallPriority?: WorkPriority }): Promise<federation.FederatedSubgraph> {
    return hostRecall(this as unknown as RecallHost, query, opts);
  }

  async digDeeper(query: string, opts?: { budget?: SubgraphBudget; onlyGraphIds?: string[]; exceptGraphIds?: string[]; skipEnrichment?: boolean; consentedGraphIds?: string[]; recallPriority?: WorkPriority }): Promise<federation.FederatedSubgraph & {
    digDeeperProvenance: {
      contentMatch: { nodes: number; avgScore: number };
      sourceFilenameExpansion: { nodes: number; sources: string[] };
      crossEngramEntityHop: { nodes: number; viaEntities: string[]; sourceEngrams: number };
    };
  }> {
    return hostDigDeeper(this as unknown as RecallHost, query, opts);
  }

  zeroResultHint(): string {
    const llmEnabled = this.settings.ai.llmEnabled === true;
    // Always include the dig_deeper escalation suggestion — it's the single
    // highest-leverage retry path and most "zero results" cases the user
    // reports are actually recoverable through it.
    const digDeeperLine =
      '\n\n🔁 BEFORE telling the user "nothing found": retry the same query with\n' +
      '   `dig_deeper`. It adds source-filename expansion, cross-engram entity\n' +
      '   hop, and GNN graph expansion on top of `recall`, and routinely\n' +
      '   surfaces memory that bare recall misses (especially document-\n' +
      '   targeted queries: "what does the X paper say…" / "anything from the\n' +
      '   Y thesis…"). Only after `dig_deeper` also comes up empty should\n' +
      '   you say the memory isn\'t there.';
    if (llmEnabled) {
      return (
        'ℹ️ No memories matched this query, even with local LLM reranking.\n' +
        '   The information is likely not stored, or is in an engram you don\'t\n' +
        '   have access to. Try `stats` to see what engrams exist, or rephrase\n' +
        '   the query — different synonyms, the proper nouns the user mentioned\n' +
        '   verbatim, or the same query translated into the language the user\n' +
        '   typically writes notes in.' + digDeeperLine
      );
    }
    return (
      'ℹ️ No memories matched this query. A few possible reasons:\n\n' +
      '  • The memory may be stored in a different language than the query.\n' +
      '    The lexical index does not bridge languages — try querying with\n' +
      '    the key content words translated into the language(s) the user\n' +
      '    typically writes notes in. Proper nouns stay as-is.\n' +
      '  • The query may be phrased differently than the stored note.\n' +
      '    Try rephrasing with synonyms, or include the key proper nouns\n' +
      '    (names, projects, places) verbatim.\n' +
      '  • The memory may genuinely not be there — try `stats` or\n' +
      '    `list_engrams` to see what\'s stored.\n\n' +
      '💡 For higher-quality recall across phrasings and languages, the user\n' +
      '   can enable the local LLM in Graphnosis → Settings → AI → Local LLM.\n' +
      '   This adds a semantic reranking layer that bridges synonyms,\n' +
      '   languages, and paraphrases — without sending any data off-device.' +
      digDeeperLine
    );
  }

  // Correction model mirrors the SDK: content-only edits with a reason; deletes are soft.
  // - `edit`      : replace content in place
  // - `supersede` : create a new node with new content, link old→new, soft-delete old
  // - `delete`    : soft-delete
  // - `adds`      : ingest fresh content as new source-less nodes (used when the correction
  //                 is "you also remember X" rather than "X was wrong")
  async applyCorrection(
    graphId: GraphId,
    patches: { adds?: AppendDocumentInput[]; edits?: CorrectionEdit[] },
    opts?: { correctedBy?: string; triggeredBy?: string },
  ): Promise<void> {
    const g = this.must(graphId);
    for (const edit of patches.edits ?? []) {
      if (edit.kind === 'delete' || edit.kind === 'edit' || edit.kind === 'supersede') {
        this.assertMutationAllowed(graphId, undefined, edit.nodeId);
      }
    }
    // Attribution: every op-log event emitted by this call carries the
    // `correctedBy` field when the correction was driven by an MCP client
    // (e.g. "claude-ai"). Lets the audit log show "Claude edited this
    // node" alongside the content/reason. The field is silently omitted
    // when the user applied the correction directly via the App UI.
    const attribution = {
      ...(opts?.correctedBy ? { correctedBy: opts.correctedBy } : {}),
      ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
    };
    // Route correction-adds through the full ingest path so each add gets a
    // source record in sourceIndex. Without this, correction-origin nodes are
    // invisible to browse_engram (which reads sourceIndex) and to
    // transfer_source (which needs a sourceId to move content).
    for (const add of patches.adds ?? []) {
      await this.ingest(
        graphId,
        'clip',
        add.sourceRef ?? `correction:${Date.now()}`,
        add,
        { triggeredBy: opts?.triggeredBy ?? 'user:correct', ...(opts?.correctedBy ? { addedBy: opts.correctedBy } : {}) },
      );
    }
    let correctionDelta = 0;
    for (const edit of patches.edits ?? []) {
      await this.opts.adapter.applyCorrection(g.handle, edit);
      this.oplogWriter.emit({
        graphId,
        op: edit.kind === 'delete' ? 'deleteNode' : edit.kind === 'supersede' ? 'supersede' : 'editNode',
        target: { kind: 'node', id: edit.nodeId },
        after: edit.kind === 'delete' ? attribution : { content: edit.content, reason: edit.reason, ...attribution },
      });
      // Count only user-driven corrections (edit + supersede). Delete is
      // also user-driven here but we exclude it because deleteNode events
      // are ambiguous in the op-log — forgetSource cascades emit them too.
      if (edit.kind === 'edit' || edit.kind === 'supersede') correctionDelta += 1;
    }
    if (correctionDelta > 0) {
      this.correctionsCount.set(graphId, (this.correctionsCount.get(graphId) ?? 0) + correctionDelta);
    }
    g.dirty = true;
    await this.save(graphId);
    // Same auto-relink pass that runs after `ingest` — applyCorrection's
    // `adds` path appends brand-new content via the same SDK code path,
    // so it deserves the same cross-doc wiring.
    if ((patches.adds?.length ?? 0) > 0) {
      this.kickoffRelink(graphId);
    }
    const changedNodeIds = (patches.edits ?? []).map((e) => e.nodeId);
    if (changedNodeIds.length > 0) {
      const supersede = (patches.edits ?? []).some((e) => e.kind === 'supersede');
      const deleted = (patches.edits ?? []).some((e) => e.kind === 'delete');
      const reason = deleted ? 'source-forgotten' as const
        : supersede ? 'source-superseded' as const
        : 'source-edited' as const;
      const { enqueueSkillsForNodeChange } = await import('./skill-retrain-queue.js');
      await enqueueSkillsForNodeChange(this, graphId, changedNodeIds, reason);
    }
  }

  /**
   * Re-introduce a piece of content as fresh, source-less node(s) and
   * return the new node ids.
   *
   * Used by the autonomous-healing review pass: when the LLM second
   * opinion overturns an auto-heal as a false positive (`unmerged`), the
   * superseded memory's frozen content snapshot is added back into the
   * graph as a live node, so the now-un-merged pair can be sent to the
   * Check-in deck for human judgment.
   *
   * Goes through the same `appendDocument` path — and emits the same
   * `addNode` op-log events and auto-relink pass — as `applyCorrection`'s
   * `adds`, but surfaces the node ids the caller needs to build a review
   * card.
   */
  // ──────────────────────────────────────────────────────────────────────
  // Source-mutating methods used by the Skills w/ Goals editor — let the
  // App treat the chunks visible in the Trained Output box as a true
  // 2-way binding with the source's nodeIds. See plan:
  //   /Users/nelulazar/.claude/plans/let-s-plan-the-skills-piped-beacon.md
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Insert a fresh node at `position` inside an existing source's nodeIds.
   * Mints ONE new node via the SDK's appendDocument (kind:'text', tiny
   * payload so the chunker stays single-node), splices it into
   * `sourceIndex.bySource[sourceId].nodeIds` at the requested position,
   * emits `addNode` + `reorderSource` op-log events, saves, and triggers
   * the standard debounced auto-relink unless `skipRelink` is set.
   *
   * `role` is stored in the node's `source.section` field so the editor
   * can chip-tag titles / recipes / goals later. Empty role is fine.
   */
  async insertNodeAt(
    graphId: GraphId,
    sourceId: string,
    position: number,
    content: string,
    opts?: { triggeredBy?: string; skipRelink?: boolean; role?: string },
  ): Promise<{ nodeId: string }> {
    const g = this.must(graphId);
    const rec = g.sourceIndex.get(sourceId);
    if (!rec) throw new Error(`source ${sourceId} not found in engram ${graphId}`);

    // Tiny payload — SDK chunker should keep this as a single node.
    // `role` is metadata for op-log audit + (future) editor chip-tagging;
    // it's not part of the SDK's AppendDocumentInput, so we don't pass it
    // down — only emit it in the op-log entry below.
    const input: AppendDocumentInput = {
      kind: 'text',
      content,
      sourceRef: rec.ref,
    };
    const result = await this.opts.adapter.appendDocument(
      g.handle,
      input,
      { chunkSize: this.settings.ai.chunkSize },
    );
    if (result.newNodeIds.length === 0) {
      throw new Error(`insertNodeAt: SDK returned no node ids for content of ${content.length} chars`);
    }
    // When result.newNodeIds.length > 1 the SDK split the content into N cards;
    // we splice them all in sequence at the requested position below. (No log —
    // splitting is normal and fired constantly during skill train/import.)

    // Splice the new nodeIds into the source at `position`.
    for (let i = 0; i < result.newNodeIds.length; i++) {
      const nid = result.newNodeIds[i]!;
      g.sourceIndex.insertNodeAt(sourceId, nid, position + i);
      this.oplogWriter.emit({
        graphId,
        op: 'addNode',
        target: { kind: 'node', id: nid },
        after: {
          ref: rec.ref,
          ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
          ...(opts?.role ? { role: opts.role } : {}),
        },
      });
    }
    // Order changed — emit one reorderSource event. 'reorderSource' is not
    // in the SDK's OpKind union, so cast at the emit site. The op-log is
    // an audit channel; nothing replays it for state reconstruction
    // (applyRecovery re-ingests from sources, not from op replay).
    this.oplogWriter.emit({
      graphId,
      op: 'reorderSource' as never,
      target: { kind: 'source', id: sourceId },
      after: {
        nodeIds: rec.nodeIds.slice(),
        ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
      },
    });

    g.dirty = true;
    await this.save(graphId);
    if (!opts?.skipRelink) this.kickoffRelink(graphId);
    return { nodeId: result.newNodeIds[0]! };
  }

  /**
   * Reorder a source's nodeIds. `newOrder` must be a permutation of the
   * current nodeIds (same multiset). Throws otherwise. Order changes don't
   * affect entity overlap, so no relink is triggered.
   */
  async reorderSourceNodes(
    graphId: GraphId,
    sourceId: string,
    newOrder: string[],
    opts?: { triggeredBy?: string },
  ): Promise<void> {
    const g = this.must(graphId);
    const rec = g.sourceIndex.get(sourceId);
    if (!rec) throw new Error(`source ${sourceId} not found in engram ${graphId}`);
    g.sourceIndex.reorderNodes(sourceId, newOrder); // throws on mismatch
    this.oplogWriter.emit({
      graphId,
      op: 'reorderSource' as never,
      target: { kind: 'source', id: sourceId },
      after: {
        nodeIds: newOrder.slice(),
        ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
      },
    });
    g.dirty = true;
    await this.save(graphId);
  }

  /**
   * Soft-delete a node AND remove it from its source's nodeIds list in
   * one consistent saved state. The node is soft-deleted via the same
   * applyCorrection({kind:'delete'}) path as `node.softDelete`.
   */
  async removeNodeFromSource(
    graphId: GraphId,
    sourceId: string,
    nodeId: string,
    opts?: { triggeredBy?: string; reason?: string },
  ): Promise<void> {
    const g = this.must(graphId);
    const rec = g.sourceIndex.get(sourceId);
    if (!rec) throw new Error(`source ${sourceId} not found in engram ${graphId}`);
    if (!rec.nodeIds.includes(nodeId)) {
      throw new Error(`node ${nodeId} not in source ${sourceId}`);
    }

    // Soft-delete the graph node first (op-log gets a deleteNode event).
    await this.opts.adapter.applyCorrection(g.handle, {
      kind: 'delete',
      nodeId,
      reason: opts?.reason ?? 'removed from trained output',
    });
    this.oplogWriter.emit({
      graphId,
      op: 'deleteNode',
      target: { kind: 'node', id: nodeId },
      after: {
        reason: opts?.reason ?? 'removed from trained output',
        ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
      },
    });
    // Then drop the id from the source's ordered list.
    g.sourceIndex.removeNode(sourceId, nodeId);
    this.oplogWriter.emit({
      graphId,
      op: 'reorderSource' as never,
      target: { kind: 'source', id: sourceId },
      after: {
        nodeIds: rec.nodeIds.slice(),
        ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
      },
    });
    g.dirty = true;
    await this.save(graphId);
    // Entity overlap may have changed (the deleted node's entities are
    // gone); kickoffRelink will re-evaluate edges across remaining nodes.
    this.kickoffRelink(graphId);
  }

  /**
   * Soft-delete EVERY node currently in a source and empty its nodeIds
   * list. The source record itself stays — its sourceId, sourceRef,
   * ingestedAt, kind, and any other metadata are preserved. Callers
   * follow this with a sequence of `insertNodeAt` calls to re-populate
   * the source with fresh content.
   *
   * Powers the in-place retrain flow: `trainSkill` finds the existing
   * source for a skill, snapshots it, calls `clearSourceNodes`, then
   * inserts the freshly-trained metadata + title + body + goals into the
   * SAME sourceId. Result: cross-source edges (skill:calls from other
   * skills) that pointed at this skill's title see a freshly-inserted
   * title node WITH A NEW NODE ID — those edges are restored by
   * `refreshIncomingCallsToSkill` at the end of trainSkill.
   *
   * One coalesced `save()` at the end (each per-node delete sets dirty
   * but doesn't write to disk individually) — much faster than calling
   * `removeNodeFromSource` in a loop, which would save after every node.
   * For a 50-node skill that's the difference between ~50 fsync round-
   * trips and 1.
   */
  async clearSourceNodes(
    graphId: GraphId,
    sourceId: string,
    opts?: { triggeredBy?: string; reason?: string },
  ): Promise<{ removedNodeIds: string[] }> {
    const g = this.must(graphId);
    const rec = g.sourceIndex.get(sourceId);
    if (!rec) throw new Error(`source ${sourceId} not found in engram ${graphId}`);
    // Snapshot the ids BEFORE we start mutating — sourceIndex.removeNode
    // mutates rec.nodeIds in place.
    const removedNodeIds = rec.nodeIds.slice();
    if (removedNodeIds.length === 0) return { removedNodeIds };
    const reason = opts?.reason ?? 'cleared for in-place retrain';
    const clearStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    for (let i = 0; i < removedNodeIds.length; i++) {
      const nodeId = removedNodeIds[i]!;
      // ── Dedup-table release pass ────────────────────────────────────────
      // Rewrite the node's content to a unique tombstone BEFORE soft-deleting.
      // The SDK keeps a content-hash dedup table covering every node — even
      // soft-deleted ones — so a follow-up `appendDocument` with identical
      // content returns zero new ids and the in-place retrain dies with
      // "SDK returned no node ids for content of N chars".
      //
      // By overwriting the node's content first, we release the ORIGINAL
      // content hash from the dedup table; the next insert with that text
      // creates a fresh node successfully. The tombstone we write here is
      // unique per (clearStamp, index, nodeId) so no two tombstones collide
      // with each other either.
      //
      // Failure to edit is non-fatal — the soft-delete below still happens
      // and the node won't surface in recall. The downside is just that the
      // next insert with identical content may hit dedup and need the
      // graphnosis-impl.ts resurrection fallback to recover.
      try {
        await this.opts.adapter.applyCorrection(g.handle, {
          kind: 'edit',
          nodeId,
          content: `__gn-cleared:${clearStamp}:${i}:${nodeId}__`,
          reason: `${reason} (dedup-table release)`,
        });
      } catch {
        // Edit refused — proceed to delete anyway. Resurrection fallback
        // in graphnosis-impl.ts will pick up the slack on next insert.
      }
      try {
        await this.opts.adapter.applyCorrection(g.handle, {
          kind: 'delete',
          nodeId,
          reason,
        });
      } catch {
        // Continue clearing even if one delete fails — orphaned node
        // remains soft-alive in the graph but is no longer in source.nodeIds.
      }
      this.oplogWriter.emit({
        graphId,
        op: 'deleteNode',
        target: { kind: 'node', id: nodeId },
        after: {
          reason,
          ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
        },
      });
      g.sourceIndex.removeNode(sourceId, nodeId);
    }
    this.oplogWriter.emit({
      graphId,
      op: 'reorderSource' as never,
      target: { kind: 'source', id: sourceId },
      after: {
        nodeIds: [],
        ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
      },
    });
    g.dirty = true;
    await this.save(graphId);
    // Defer relink — caller will populate the source and run their own
    // SOP edge linkers after the inserts are done.
    return { removedNodeIds };
  }

  /**
   * Rename a source's `ref` (the human-readable label shown in the
   * Sources panel + Skills library). Used by the Skills editor when the
   * user edits the title chunk: the chunk text update goes through
   * node.directEdit; this call updates the library row in sync.
   */
  async renameSource(
    graphId: GraphId,
    sourceId: string,
    newRef: string,
    opts?: { triggeredBy?: string },
  ): Promise<void> {
    const g = this.must(graphId);
    const rec = g.sourceIndex.get(sourceId);
    if (!rec) throw new Error(`source ${sourceId} not found in engram ${graphId}`);
    g.sourceIndex.rename(sourceId, newRef);
    this.oplogWriter.emit({
      graphId,
      op: 'renameSource' as never,
      target: { kind: 'source', id: sourceId },
      after: {
        newRef,
        ...(opts?.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
      },
    });
    g.dirty = true;
    await this.save(graphId);
  }

  /**
   * Read a source record by id (lightweight wrapper around the in-memory
   * SourceIndex). Used by the section-walker in `skill:importGsk` to
   * compute the current `nodeIds.length` so it can append at the end.
   */
  getSourceRecord(graphId: GraphId, sourceId: string) {
    const g = this.must(graphId);
    return g.sourceIndex.get(sourceId);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Overlay-recompute guard. The GNN edge-prediction loop + GLL inference
  // loop check this flag and skip their work while it's set. `trainSkill`
  // wraps its run in setSkipOverlayRecompute(true) → ... → false so the
  // overlays don't write predictions against a half-built skill source.
  // ──────────────────────────────────────────────────────────────────────
  private _skipOverlayRecompute = false;
  setSkipOverlayRecompute(skip: boolean): void { this._skipOverlayRecompute = skip; }
  getSkipOverlayRecompute(): boolean { return this._skipOverlayRecompute; }

  async addLooseContent(graphId: GraphId, content: string, sourceRef: string): Promise<string[]> {
    const g = this.must(graphId);
    const input: AppendDocumentInput = { kind: 'markdown', content, sourceRef };
    const result = await this.opts.adapter.appendDocument(
      g.handle,
      input,
      { chunkSize: this.settings.ai.chunkSize },
    );
    for (const n of result.newNodeIds) {
      this.oplogWriter.emit({
        graphId,
        op: 'addNode',
        target: { kind: 'node', id: n },
        after: { ref: sourceRef },
      });
    }
    g.dirty = true;
    await this.save(graphId);
    if (result.newNodeIds.length > 0) this.kickoffRelink(graphId);
    return result.newNodeIds;
  }

  /**
   * Apply a temporal decay correction to a single node. Called by TemporalEngine
   * during its daily decay pass. Distinct from reinforceNode so the reason
   * string is accurate in the op-log.
   *
   * We emit a lightweight 'editNode' event rather than a full supersede so
   * the audit log doesn't get cluttered with decay lineage chains — decay
   * is a background maintenance operation, not a factual correction.
   */
  async applyDecayCorrection(
    graphId: GraphId,
    nodeId: string,
    contentPreview: string,
    newConfidence: number,
  ): Promise<void> {
    const g = this.graphs.get(graphId);
    if (!g) return;
    await this.opts.adapter.applyCorrection(g.handle, {
      kind: 'edit',
      nodeId,
      content: contentPreview,
      reason: 'brain:temporal-decay',
    });
    this.oplogWriter.emit({
      graphId,
      op: 'editNode',
      target: { kind: 'node', id: nodeId },
      after: { confidence: newConfidence, reason: 'brain:temporal-decay', triggeredBy: 'brain:reinforcement' },
    });
    g.dirty = true;
    await this.save(graphId);
  }

  /**
   * Create an undirected edge between two existing nodes. Powers the App's
   * "Link them" affordance: the user sees two semantically similar memories
   * in the Check-in deck/detail pane and confirms they belong together.
   *
   * Idempotent (the adapter dedupes); emits an `addEdge` op-log event only
   * when a fresh edge was created. Persists the graph.
   */
  async linkNodes(
    graphId: GraphId,
    fromNodeId: string,
    toNodeId: string,
    opts?: { type?: import('@nehloo/graphnosis').UndirectedEdge['type']; reason?: string },
  ): Promise<{ edgeId: string; created: boolean }> {
    const g = this.must(graphId);
    const type = opts?.type ?? 'related-to';
    const linkOpts: { type: import('@nehloo/graphnosis').UndirectedEdge['type']; weight: number; reason?: string } = {
      type,
      weight: 0.7,
    };
    if (opts?.reason !== undefined) linkOpts.reason = opts.reason;
    const result = await this.opts.adapter.linkNodes(g.handle, fromNodeId, toNodeId, linkOpts);
    if (result.created) {
      this.oplogWriter.emit({
        graphId,
        op: 'addEdge',
        target: { kind: 'edge', id: result.edgeId },
        after: {
          fromNodeId,
          toNodeId,
          type,
          weight: 0.7,
          directed: false,
          reason: opts?.reason ?? 'User-confirmed related memories',
        },
      });
      g.dirty = true;
      await this.save(graphId);
    }
    return result;
  }

  /**
   * Form many undirected edges in one pass. Same per-edge behavior as
   * `linkNodes` — idempotent dedup, an `addEdge` op-log event carrying
   * `reason` — but with a SINGLE graph save at the end instead of one per
   * edge. Used by the autonomous brain's auto-link tier, which weaves
   * dozens of "related" edges per scan; one save per edge would be far
   * too costly. Returns the count of edges actually created (re-linking an
   * already-existing pair is a no-op and is not counted).
   */
  async linkNodesBatch(
    graphId: GraphId,
    edges: Array<{
      a: string;
      b: string;
      type?: import('@nehloo/graphnosis').UndirectedEdge['type'];
      weight?: number;
      reason?: string;
    }>,
  ): Promise<number> {
    const g = this.must(graphId);
    let created = 0;
    for (const e of edges) {
      const type = e.type ?? 'related-to';
      const weight = e.weight ?? 0.7;
      const linkOpts: { type: import('@nehloo/graphnosis').UndirectedEdge['type']; weight: number; reason?: string } = {
        type,
        weight,
      };
      if (e.reason !== undefined) linkOpts.reason = e.reason;
      try {
        const result = await this.opts.adapter.linkNodes(g.handle, e.a, e.b, linkOpts);
        if (result.created) {
          this.oplogWriter.emit({
            graphId,
            op: 'addEdge',
            target: { kind: 'edge', id: result.edgeId },
            after: {
              fromNodeId: e.a,
              toNodeId: e.b,
              type,
              weight,
              directed: false,
              reason: e.reason ?? 'auto-link',
            },
          });
          created += 1;
        }
      } catch (err) {
        console.error(`[host] linkNodesBatch edge ${e.a}->${e.b} failed: ${(err as Error).message}`);
      }
    }
    if (created > 0) {
      g.dirty = true;
      await this.save(graphId);
    }
    return created;
  }

  /**
   * Create a DIRECTED edge between two existing nodes — sibling of
   * `linkNodes` for typed edges (knows, works-with, reports-to,
   * collaborated-on, …) that need to encode direction.
   *
   * The user-friendly label (e.g. "Works at", "Lives in") rides on
   * `evidence` so the detail pane can render it directly instead of
   * humanizing the raw SDK type.
   *
   * Op-log records the same `addEdge` kind as `linkNodes`, with
   * `directed: true` in the `after` payload so a future replayer can
   * dispatch on shape.
   */
  async linkNodesDirected(
    graphId: GraphId,
    fromNodeId: string,
    toNodeId: string,
    opts: { type: import('@nehloo/graphnosis').DirectedEdge['type']; weight?: number; evidence?: string },
  ): Promise<{ edgeId: string; created: boolean }> {
    const g = this.must(graphId);
    const weight = opts.weight ?? 0.7;
    const linkOpts: { type: import('@nehloo/graphnosis').DirectedEdge['type']; weight: number; evidence?: string } = {
      type: opts.type,
      weight,
    };
    if (opts.evidence !== undefined) linkOpts.evidence = opts.evidence;
    const result = await this.opts.adapter.linkNodesDirected(g.handle, fromNodeId, toNodeId, linkOpts);
    if (result.created) {
      this.oplogWriter.emit({
        graphId,
        op: 'addEdge',
        target: { kind: 'edge', id: result.edgeId },
        after: {
          fromNodeId,
          toNodeId,
          type: opts.type,
          weight,
          directed: true,
          evidence: opts.evidence ?? null,
        },
      });
      g.dirty = true;
      await this.save(graphId);
    }
    return result;
  }

  /**
   * Form many DIRECTED edges in one pass — the directed sibling of
   * `linkNodesBatch`. Same per-edge dedup as `linkNodesDirected`, with a
   * single graph save at the end. Used by Consolidation's transitive
   * inference, which can add dozens of inferred edges per run. Returns
   * the count actually created.
   */
  async linkNodesDirectedBatch(
    graphId: GraphId,
    edges: Array<{
      from: string;
      to: string;
      type: import('@nehloo/graphnosis').DirectedEdge['type'];
      weight?: number;
      evidence?: string;
    }>,
  ): Promise<number> {
    const g = this.must(graphId);
    let created = 0;
    for (const e of edges) {
      const weight = e.weight ?? 0.7;
      const linkOpts: { type: import('@nehloo/graphnosis').DirectedEdge['type']; weight: number; evidence?: string } = {
        type: e.type,
        weight,
      };
      if (e.evidence !== undefined) linkOpts.evidence = e.evidence;
      try {
        const result = await this.opts.adapter.linkNodesDirected(g.handle, e.from, e.to, linkOpts);
        if (result.created) {
          this.oplogWriter.emit({
            graphId,
            op: 'addEdge',
            target: { kind: 'edge', id: result.edgeId },
            after: {
              fromNodeId: e.from,
              toNodeId: e.to,
              type: e.type,
              weight,
              directed: true,
              evidence: e.evidence ?? null,
            },
          });
          created += 1;
        }
      } catch (err) {
        console.error(`[host] linkNodesDirectedBatch edge ${e.from}->${e.to} failed: ${(err as Error).message}`);
      }
    }
    if (created > 0) {
      g.dirty = true;
      await this.save(graphId);
    }
    return created;
  }

  /**
   * Remove a single edge. Delegates to the adapter (pure in-memory Map
   * delete) then saves. Emits an op-log `removeEdge` event so the audit
   * trail stays intact even though the edge is gone from the graph.
   *
   * Returns `{ removed: false }` without saving when the edge doesn't
   * exist — idempotent / safe to call twice on the same id.
   */
  async unlinkEdge(
    graphId: GraphId,
    edgeId: string,
  ): Promise<{ removed: boolean; wasDirected?: boolean }> {
    const g = this.must(graphId);
    const result = await this.opts.adapter.unlinkEdge(g.handle, edgeId);
    if (result.removed) {
      this.oplogWriter.emit({
        graphId,
        op: 'deleteEdge',
        target: { kind: 'edge', id: edgeId },
        after: { wasDirected: result.wasDirected ?? false },
      });
      g.dirty = true;
      await this.save(graphId);
    }
    return result;
  }

  /**
   * Reinforcement primitive — set the weight of many edges in one pass.
   * Loops `adapter.reweightEdge` (pure in-memory), then a SINGLE graph save
   * and a SINGLE summary op-log event. The autonomous reinforcement pass
   * touches dozens of edges every cycle; one save + one op-log row per edge
   * would be far too costly and would flood the audit log.
   *
   * The op kind is `addEdge` (the pinned op-log has no `editEdge`); the
   * `after.reweight` marker tells a replayer the row is a re-assertion of
   * existing edge weights, not a fresh edge. Returns the count changed.
   */
  async setEdgeWeightsBatch(
    graphId: GraphId,
    updates: Array<{ edgeId: string; weight: number }>,
  ): Promise<number> {
    const g = this.must(graphId);
    let changed = 0;
    let firstEdgeId = '';
    for (const u of updates) {
      try {
        const result = await this.opts.adapter.reweightEdge(g.handle, u.edgeId, u.weight);
        if (result.ok) {
          changed += 1;
          if (firstEdgeId === '') firstEdgeId = u.edgeId;
        }
      } catch (err) {
        console.error(`[host] setEdgeWeightsBatch edge ${u.edgeId} failed: ${(err as Error).message}`);
      }
    }
    if (changed > 0) {
      this.oplogWriter.emit({
        graphId,
        op: 'addEdge',
        target: { kind: 'edge', id: firstEdgeId },
        after: { reweight: true, count: changed, reason: 'brain:reinforcement' },
      });
      g.dirty = true;
      await this.save(graphId);
    }
    return changed;
  }

  /**
   * Batched edge removal — one graph save for many unlinks. Used by
   * Consolidation's redundancy cleanup (dead edges to soft-deleted nodes,
   * exact-duplicate parallel edges). Each removed edge still gets its own
   * `deleteEdge` op-log event so op-log replay / sync stays correct; only
   * the disk save is batched. Returns the count actually removed.
   */
  async unlinkEdgesBatch(graphId: GraphId, edgeIds: string[]): Promise<number> {
    const g = this.must(graphId);
    let removed = 0;
    for (const edgeId of edgeIds) {
      try {
        const result = await this.opts.adapter.unlinkEdge(g.handle, edgeId);
        if (result.removed) {
          removed += 1;
          this.oplogWriter.emit({
            graphId,
            op: 'deleteEdge',
            target: { kind: 'edge', id: edgeId },
            after: { wasDirected: result.wasDirected ?? false, reason: 'brain:consolidation-cleanup' },
          });
        }
      } catch (err) {
        console.error(`[host] unlinkEdgesBatch edge ${edgeId} failed: ${(err as Error).message}`);
      }
    }
    if (removed > 0) {
      g.dirty = true;
      await this.save(graphId);
    }
    return removed;
  }

  /**
   * Ground-truth inspection across all loaded graphs — includes soft-deleted nodes
   * (the ones recall hides because confidence dropped). Used by the `stats` MCP tool
   * and the future desktop inspector to debug "where did my nodes go?" moments.
   */
  /**
   * One-time pass over the encrypted op-log to count user corrections for
   * this graph. Counts `editNode` + `supersede` events; explicitly excludes
   * `deleteNode` because that op kind is also emitted by forgetSource
   * cascades. Returns 0 on any decryption / read error — we don't want a
   * missing op-log to break stats.
   */
  /**
   * Read the op-log ONCE and populate corrections counts for every loaded
   * engram. Call this after loadAllGraphsFromDisk() to avoid O(N) oplog
   * reads. Per-engram calls (even fire-and-forget) caused 17 concurrent
   * oplog decryptions that starved the loading loop's readFile calls.
   */
  async refreshAllCorrectionsFromOplog(): Promise<OplogHousekeepingResult> {
    const noop: OplogHousekeepingResult = { compaction: { compacted: false } };
    try {
      const t0 = Date.now();
      // Route through listOplogEvents() so this call shares the in-flight
      // Promise with any concurrent callers (e.g. vitality.compute() firing
      // 2 s after boot). Without sharing, two independent readAllEvents()
      // calls would each run for ~16 s on a large op-log — doubling the
      // startup delay. listOplogEvents() also writes to _oplogReadCache, so
      // subsequent callers within the 60-s TTL window get instant results.
      const events = await this.listOplogEvents();

      for (const graphId of this.graphs.keys()) {
        this.correctionsCount.set(graphId, this._correctionsCountForGraph(graphId, events));
      }
      // Background sweep summary — debug-only when fast. If the sweep takes
      // unusually long (>5s) we surface it as a real warning so latency
      // regressions are visible without DEBUG flipped on.
      const sweepMs = Date.now() - t0;
      const sweepMsg = `[graphnosis-host] corrections sweep: ${events.length} events → ${this.graphs.size} engrams in ${sweepMs}ms`;
      if (sweepMs > 5000) console.warn(sweepMsg);
      else                dbg(sweepMsg);

      const compaction = await this.compactOplogIfNeeded(events);
      return { compaction };
    } catch (e) {
      console.error(`[graphnosis-host] corrections sweep failed: ${(e as Error).message}`);
      return noop;
    }
  }

  /** Most recent successful op-log compaction on this device (persisted audit trail). */
  getLastOplogCompaction(): settingsMod.OplogCompactionRecord | null {
    return this.settings.cortex?.oplogMaintenance?.lastCompaction ?? null;
  }

  private async countCorrectionsFromOplog(graphId: GraphId): Promise<number> {
    try {
      const events = await this.listOplogEvents(); // uses shared 60s cache
      return this._correctionsCountForGraph(graphId, events);
    } catch (e) {
      console.error(`[graphnosis-host] count corrections from op-log failed: ${(e as Error).message}`);
      return 0;
    }
  }

  /**
   * Compute the corrections count for one engram from a cached event list.
   *
   * After an op-log compaction, old `editNode`/`supersede` events are pruned
   * from the log and their count is saved as `correctionsCountBaseline` in
   * settings. The live events only contain the recent delta (ts ≥
   * correctionsBaselineAsOf). We add both to get the true total.
   *
   * Before any compaction has run: baseline = 0, baselineAsOf = 0, so every
   * event passes the `e.ts >= 0` filter and the result is identical to the
   * previous full-scan behaviour.
   */
  private _correctionsCountForGraph(
    graphId: GraphId,
    events: Awaited<ReturnType<typeof oplog.readAllEvents>>,
  ): number {
    const meta = this.settings.graphMetadata[graphId];
    const baseline = meta?.correctionsCountBaseline ?? 0;
    const baselineAsOf = meta?.correctionsBaselineAsOf ?? 0;
    const delta = events.filter(
      (e) => e.graphId === graphId &&
             e.ts >= baselineAsOf &&
             (e.op === 'editNode' || e.op === 'supersede'),
    ).length;
    return baseline + delta;
  }

  /**
   * Op-log compaction — prune mutation events older than COMPACTION_MAX_AGE_MS
   * while preserving all recovery anchors (`ingestSource`, `forgetSource`)
   * and all recent events unconditionally.
   *
   * Pruned `editNode`/`supersede` counts are saved as a per-engram baseline
   * in settings.json so `refreshAllCorrectionsFromOplog` can reconstruct the
   * correct total without the full history.
   *
   * Only this device's `.oplog` file is compacted; other devices' files are
   * read-only from our perspective and are left untouched.
   *
   * Write safety (delta-append):
   *   1. Note the current byte-size of the original file.
   *   2. Write the compacted content to `<deviceId>.oplog.compacting`.
   *   3. Append any bytes appended to the original since step 1 (the "delta"
   *      — any events emitted concurrently during our write).
   *   4. Atomically rename the compacting file over the original.
   * This means in-flight emit() calls during the write are never lost: they
   * end up in the delta that gets appended before the rename.
   */
  private async compactOplogIfNeeded(
    events: Awaited<ReturnType<typeof oplog.readAllEvents>>,
  ): Promise<OplogCompactionResult> {
    const noop: OplogCompactionResult = { compacted: false };
    /** Minimum event count before we bother compacting. */
    const COMPACTION_THRESHOLD = 500_000;
    /** Keep all events newer than this many days regardless of type. */
    const COMPACTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    /** Skip compaction if < this fraction of events would be pruned (not worth the I/O). */
    const COMPACTION_MIN_REDUCTION = 0.2;
    /** Max events per encrypted chunk (keeps individual encrypt() calls small). */
    const CHUNK_SIZE = 100;

    if (events.length < COMPACTION_THRESHOLD) return noop;

    const oplogDir = path.join(this.opts.cortexDir, 'oplog');
    const oplogFile = path.join(oplogDir, `${this.deviceIdentity.deviceId}.oplog`);
    const compactingFile = oplogFile + '.compacting';
    const cutoff = Date.now() - COMPACTION_MAX_AGE_MS;

    // ── Partition events ────────────────────────────────────────────────────
    const keepEvents: Awaited<ReturnType<typeof oplog.readAllEvents>> = [];
    // Per-engram count of pruned editNode/supersede (for the baseline update).
    const prunedCorrectionsByEngram = new Map<string, number>();
    let prunedCount = 0;

    for (const ev of events) {
      // Recovery anchors are NEVER pruned — they are the source-of-truth for
      // op-log replay and "what did this user ever ingest?" queries.
      if (ev.op === 'ingestSource' || ev.op === 'forgetSource') {
        keepEvents.push(ev);
        continue;
      }
      // Recent events are kept regardless of type.
      if (ev.ts >= cutoff) {
        keepEvents.push(ev);
        continue;
      }
      // This event will be pruned. Track pruned corrections for the baseline.
      if (ev.op === 'editNode' || ev.op === 'supersede') {
        prunedCorrectionsByEngram.set(
          ev.graphId,
          (prunedCorrectionsByEngram.get(ev.graphId) ?? 0) + 1,
        );
      }
      prunedCount++;
    }

    if (prunedCount < events.length * COMPACTION_MIN_REDUCTION) {
      // "Skipped because not enough to prune" — common, debug-only.
      dbg(
        `[graphnosis-host] oplog compaction skipped: only ${prunedCount}/${events.length} events` +
        ` prunable (<${Math.round(COMPACTION_MIN_REDUCTION * 100)}% reduction threshold).`,
      );
      return noop;
    }

    dbg(
      `[graphnosis-host] oplog compaction starting: ${events.length} → ${keepEvents.length} events` +
      ` (pruning ${prunedCount}), corrections baseline update for ${prunedCorrectionsByEngram.size} engram(s)…`,
    );
    const t0 = Date.now();

    // ── Note current file size for delta-append ─────────────────────────────
    let originalSize = 0;
    try {
      originalSize = (await fs.stat(oplogFile)).size;
    } catch { /* file may not exist on a fresh cortex */ }

    // ── Write compacted events to staging file ──────────────────────────────
    try {
      await fs.unlink(compactingFile).catch(() => { /* may not exist */ });

      for (let i = 0; i < keepEvents.length; i += CHUNK_SIZE) {
        const batch = keepEvents.slice(i, i + CHUNK_SIZE);
        // Write signed v2 chunks (re-signed by this device's key). The file magic
        // goes once, at the start. Pruned events leave seq gaps, which the reader
        // reports as benign — this is the device rewriting its own history.
        const chunk = await oplog.encodeSignedChunk(
          this.deviceIdentity.deviceId, batch, this.key, this.salt, this.deviceIdentity.signSecretKey,
        );
        const payload = i === 0
          ? Buffer.concat([Buffer.from(oplog.OPLOG_V2_MAGIC), Buffer.from(chunk)])
          : Buffer.from(chunk);
        await fs.appendFile(compactingFile, payload, { mode: 0o600 });
      }

      // ── Delta-append: capture events emitted during our write ───────────
      // Any emit() calls that fired while we were writing went to the original
      // file via appendFile(oplogFile). Read those bytes and tack them onto
      // the compacting file before we rename, so no events are lost.
      try {
        const currentSize = (await fs.stat(oplogFile)).size;
        if (currentSize > originalSize) {
          const deltaLen = currentSize - originalSize;
          const delta = Buffer.alloc(deltaLen);
          const fh = await fs.open(oplogFile, 'r');
          try {
            await fh.read(delta, 0, deltaLen, originalSize);
          } finally {
            await fh.close();
          }
          await fs.appendFile(compactingFile, delta);
        }
      } catch (deltaErr) {
        // Delta read failure is non-fatal: the compacted file is still valid;
        // we just might lose a handful of in-flight events from the last
        // seconds of the write. Log and continue to the rename.
        console.error(
          `[graphnosis-host] oplog compaction: delta-append failed (non-fatal):` +
          ` ${(deltaErr as Error).message}`,
        );
      }

      // ── Atomic rename ───────────────────────────────────────────────────
      await fs.rename(compactingFile, oplogFile);

      // ── Persist corrections baseline to settings.json ───────────────────
      // Do this AFTER the rename so settings always lag the file (safer than
      // having the baseline updated but the file not yet compacted).
      for (const [graphId, prunedCount2] of prunedCorrectionsByEngram) {
        const existing = this.settings.graphMetadata[graphId];
        if (!existing) continue;
        const prevBaseline = existing.correctionsCountBaseline ?? 0;
        await this.setGraphMetadata(graphId, {
          ...existing,
          correctionsCountBaseline: prevBaseline + prunedCount2,
          correctionsBaselineAsOf: cutoff,
        });
      }

      // Invalidate the cache so the next listOplogEvents() re-reads the
      // compacted file rather than serving the stale pre-compaction snapshot.
      this.invalidateOplogCache();

      let bytesAfter = 0;
      try {
        bytesAfter = (await fs.stat(oplogFile)).size;
      } catch { /* non-fatal */ }

      const result: OplogCompactionResult = {
        compacted: true,
        eventsRemoved: prunedCount,
        eventsBefore: events.length,
        eventsAfter: keepEvents.length,
        bytesBefore: originalSize,
        bytesAfter,
      };
      await this.persistOplogCompactionRecord(result);

      dbg(
        `[graphnosis-host] oplog compaction done in ${Date.now() - t0}ms —` +
        ` ${events.length} → ${keepEvents.length} events.`,
      );
      return result;
    } catch (e) {
      // Compaction failure is fully non-fatal: the original oplog is intact
      // (we only renamed a staging file). Clean up and continue.
      await fs.unlink(compactingFile).catch(() => { /* already gone */ });
      console.error(`[graphnosis-host] oplog compaction failed (non-fatal): ${(e as Error).message}`);
      return noop;
    }
  }

  private async persistOplogCompactionRecord(result: OplogCompactionResult): Promise<void> {
    if (!result.compacted || result.eventsRemoved === undefined) return;
    const base: settingsMod.OplogCompactionRecord = {
      at: Date.now(),
      eventsRemoved: result.eventsRemoved,
      eventsBefore: result.eventsBefore ?? 0,
      eventsAfter: result.eventsAfter ?? 0,
      ...(result.bytesBefore !== undefined ? { bytesBefore: result.bytesBefore } : {}),
      ...(result.bytesAfter !== undefined ? { bytesAfter: result.bytesAfter } : {}),
    };
    let record = base;
    try {
      const { compactionManifestHash, signManifestHash } = await import('./compliance.js');
      const manifestHash = compactionManifestHash(base);
      const signers = this.getEvidencePackSigners();
      if (signers.length > 0) {
        const signatures = await signManifestHash(manifestHash, signers);
        const deviceSig = signatures.find((s) => s.signer === 'device');
        const orgSig = signatures.find((s) => s.signer === 'org');
        record = {
          ...base,
          manifestHash,
          ...(deviceSig ? { deviceSignature: deviceSig.signature } : {}),
          ...(orgSig ? { orgSignature: orgSig.signature } : {}),
        };
      }
    } catch { /* signing is best-effort */ }
    await this.setSettings({
      cortex: {
        ...this.settings.cortex,
        oplogMaintenance: { lastCompaction: record },
      },
    });
  }

  stats(): {
    graphs: Array<{
      graphId: GraphId;
      totalNodes: number;
      activeNodes: number;
      softDeletedNodes: number;
      sources: number;
      corrections: number;
      lastMutationAt: number;
      nodes: ReturnType<GraphnosisAdapter['inspectNodes']>;
    }>;
  } {
    const out = [];
    for (const [graphId, g] of this.graphs) {
      const nodes = this.opts.adapter.inspectNodes(g.handle);
      const active = nodes.filter(n => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > Date.now()));
      out.push({
        graphId,
        totalNodes: nodes.length,
        activeNodes: active.length,
        softDeletedNodes: nodes.length - active.length,
        sources: g.sourceIndex.list().length,
        corrections: this.correctionsCount.get(graphId) ?? 0,
        // Bumped on every save(); the App polls this so background
        // auto-relink edges show up without a manual refresh. 0 means
        // never mutated this session (the graph was just loaded).
        lastMutationAt: this.lastMutationAt.get(graphId) ?? 0,
        nodes,
      });
    }
    return { graphs: out };
  }

  // ── Purge (physically remove soft-deleted nodes) ────────────────────────
  //
  // The SDK only soft-deletes (confidence drops, validUntil = now). To truly
  // remove forgotten memories we rebuild the graph from the surviving live
  // sources — same trick the recovery flow uses.
  //
  // Two-phase to keep this safe:
  //   1. Plan: snapshot every live source's content (from cache or disk).
  //      Bail out BEFORE touching anything if any source can't be rebuilt.
  //   2. Rebuild: drop the in-memory + on-disk graph, re-ingest each snapshot.
  //
  // Failure modes (returned in `errors`, never thrown unless we hit phase 2):
  //   - source has no cache blob AND no reachable file → unrecoverable
  //   - cache mode is `off` AND source isn't kind=file → unrecoverable
  //
  // Edge cases:
  //   - Source IDs stay stable (makeSourceId is deterministic on kind+ref),
  //     so the op-log stays consistent across the rebuild.
  //   - Node IDs change. The op-log's addNode events keep pointing at the
  //     old IDs, which is fine — they're for replay, not live references.

  async purgeSoftDeleted(graphId: GraphId): Promise<PurgeReport> {
    const g = this.must(graphId);

    // Snapshot before/after for the report.
    const inspectBefore = this.opts.adapter.inspectNodes(g.handle);
    const beforeTotal = inspectBefore.length;
    const beforeActive = inspectBefore.filter(
      (n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > Date.now()),
    ).length;
    const beforeSoftDeleted = beforeTotal - beforeActive;

    if (beforeSoftDeleted === 0) {
      return {
        beforeTotalNodes: beforeTotal,
        beforeActiveNodes: beforeActive,
        beforeSoftDeletedNodes: 0,
        afterTotalNodes: beforeTotal,
        sourcesRebuilt: 0,
        sourcesSkipped: g.sourceIndex.list().length,
        errors: [],
        noop: true,
      };
    }

    // Phase 1: gather all live source content in memory.
    type Snapshot = {
      record: SourceRecord;
      content: Uint8Array;
      docKind: 'markdown' | 'html' | 'json' | 'csv' | 'pdf' | 'text';
    };
    const snapshots: Snapshot[] = [];
    const errors: PurgeError[] = [];

    for (const rec of g.sourceIndex.list()) {
      // Cache first — survives source-file moves/deletes.
      let snapshot: Snapshot | null = null;
      try {
        const blob = await this.readContentBlob(rec.sourceId);
        if (blob) {
          snapshot = {
            record: rec,
            content: blob.content,
            docKind: blob.header.docKind,
          };
        }
      } catch (e) {
        errors.push({
          sourceId: rec.sourceId,
          ref: rec.ref,
          error: `cache blob unreadable: ${(e as Error).message}`,
        });
        continue;
      }

      // Disk fallback for file sources without a cache blob.
      if (!snapshot && rec.kind === 'file') {
        try {
          const buf = await fs.readFile(rec.ref);
          const ext = path.extname(rec.ref).toLowerCase().replace(/^\./, '');
          const docKind: Snapshot['docKind'] =
            ext === 'md' || ext === 'markdown' ? 'markdown' :
            ext === 'json' ? 'json' :
            ext === 'html' || ext === 'htm' ? 'html' :
            ext === 'csv' ? 'csv' :
            ext === 'pdf' ? 'pdf' :
            'text';
          snapshot = {
            record: rec,
            content: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
            docKind,
          };
        } catch {
          errors.push({
            sourceId: rec.sourceId,
            ref: rec.ref,
            error: `no cache blob and original file is missing on disk`,
          });
          continue;
        }
      }

      if (!snapshot) {
        // kind=url/clip/ai-conversation with no cache → unrecoverable
        errors.push({
          sourceId: rec.sourceId,
          ref: rec.ref,
          error: `no cache blob (kind=${rec.kind}). Turn on Content cache (Settings → "Cache everything") to enable purge.`,
        });
        continue;
      }

      snapshots.push(snapshot);
    }

    // Refuse to proceed if anything's unrecoverable — we'd lose data.
    if (errors.length > 0) {
      return {
        beforeTotalNodes: beforeTotal,
        beforeActiveNodes: beforeActive,
        beforeSoftDeletedNodes: beforeSoftDeleted,
        afterTotalNodes: beforeTotal,
        sourcesRebuilt: 0,
        sourcesSkipped: 0,
        errors,
        aborted: true,
      };
    }

    // Phase 2: tear down and rebuild. From here, errors are real data risk —
    // so we wrap the work in a backup/restore guard.
    //
    // Safety pass: atomic-rename the current files to .bak. The rebuild then
    // writes to fresh .gai / .bundle / .embcache. If anything fails, we
    // restore from .bak and the user sees no change. If everything succeeds,
    // we delete .bak as the final step (commit). Rename is atomic on POSIX
    // and survives a crash — see startup recovery in loadGraph().
    this.graphs.delete(graphId);
    const backupOk = await this.backupGraphFiles(graphId);
    if (!backupOk) {
      // Couldn't checkpoint — refuse to proceed. Reload in-memory state so
      // the user can keep working.
      try { await this.loadGraph(graphId); } catch { /* nothing to load */ }
      return {
        beforeTotalNodes: beforeTotal,
        beforeActiveNodes: beforeActive,
        beforeSoftDeletedNodes: beforeSoftDeleted,
        afterTotalNodes: beforeTotal,
        sourcesRebuilt: 0,
        sourcesSkipped: 0,
        errors: [{
          sourceId: '*',
          ref: '*',
          error: 'could not create backup before purge — aborted to protect your data',
        }],
        aborted: true,
      };
    }

    let rebuilt = 0;
    try {
      await this.createGraph(graphId);
      for (const snap of snapshots) {
        const content: string | Buffer = snap.docKind === 'pdf'
          ? Buffer.from(snap.content)
          : new TextDecoder().decode(snap.content);
        try {
          await this.ingest(graphId, snap.record.kind, snap.record.ref, {
            kind: snap.docKind,
            content: content as never,
            sourceRef: snap.record.ref,
          });
          rebuilt++;
        } catch (e) {
          // Per-source ingest failure is non-fatal — record and continue.
          // The user gets a partial-rebuild report; nothing is rolled back
          // unless the whole thing throws.
          errors.push({
            sourceId: snap.record.sourceId,
            ref: snap.record.ref,
            error: `rebuild ingest failed: ${(e as Error).message}`,
          });
        }
        // Yield to the event loop between each source so IPC/MCP requests
        // (health checks, mcp.status calls, SIGTERM handlers) can be serviced
        // during purge. Without this, embedding on each source blocks the
        // single-threaded event loop for seconds, causing mcp.status timeouts
        // and SIGTERM to be ignored until the entire purge finishes.
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    } catch (e) {
      // Catastrophic failure — restore from backup and surface.
      this.graphs.delete(graphId);
      const restored = await this.restoreGraphBackup(graphId);
      try { await this.loadGraph(graphId); } catch { /* nothing to load */ }
      throw new Error(
        `Purge failed mid-rebuild${restored ? ' — original graph restored from backup' : ''}: ${(e as Error).message}`,
      );
    }

    // Commit: delete the .bak files now that the new graph is durable on disk.
    await this.deleteGraphBackup(graphId);

    const inspectAfter = this.opts.adapter.inspectNodes(this.must(graphId).handle);
    return {
      beforeTotalNodes: beforeTotal,
      beforeActiveNodes: beforeActive,
      beforeSoftDeletedNodes: beforeSoftDeleted,
      afterTotalNodes: inspectAfter.length,
      sourcesRebuilt: rebuilt,
      sourcesSkipped: snapshots.length - rebuilt,
      errors,
    };
  }

  // ── Backup/restore helpers used by purge (and by startup recovery) ──────

  /**
   * Atomically rename the graph's files to `.bak` siblings. Returns true on
   * success. If any rename fails part-way, attempts to roll back any already-
   * renamed files so the on-disk state stays consistent.
   */
  private async backupGraphFiles(graphId: GraphId): Promise<boolean> {
    const paths = [
      this.graphPath(graphId),
      this.bundlePath(graphId),
      this.cachePath(graphId),
    ];
    const moved: string[] = [];
    for (const p of paths) {
      try {
        await fs.rename(p, `${p}.bak`);
        moved.push(p);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') continue; // nothing there to back up — fine
        // Mid-flight failure: undo any renames we already did.
        for (const undo of moved) {
          try { await fs.rename(`${undo}.bak`, undo); } catch { /* best-effort */ }
        }
        console.error(`[graphnosis-host] backup rename failed for ${p}: ${err.message}`);
        return false;
      }
    }
    return true;
  }

  /**
   * Rename `.bak` files back to their canonical names. Best-effort — logs
   * each failure but doesn't throw, because we're already in a recovery path.
   */
  private async restoreGraphBackup(graphId: GraphId): Promise<boolean> {
    let any = false;
    for (const p of [this.graphPath(graphId), this.bundlePath(graphId), this.cachePath(graphId)]) {
      try {
        await fs.rename(`${p}.bak`, p);
        any = true;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') {
          console.error(`[graphnosis-host] restore failed for ${p}: ${err.message}`);
        }
      }
    }
    return any;
  }

  /** Delete `.bak` files after a successful purge commit. */
  private async deleteGraphBackup(graphId: GraphId): Promise<void> {
    for (const p of [this.graphPath(graphId), this.bundlePath(graphId), this.cachePath(graphId)]) {
      try { await fs.unlink(`${p}.bak`); } catch { /* not present — fine */ }
    }
  }

  /**
   * Called from loadGraph before any read. Handles crash-during-purge leftovers:
   *   - If the canonical file is missing but .bak exists → process died after
   *     the rename-to-bak step. Restore so the user isn't surprised by an
   *     empty cortex.
   *   - If both exist → purge committed but didn't delete .bak. Drop the bak.
   */
  private async recoverFromInterruptedPurge(graphId: GraphId): Promise<void> {
    const triples = [
      this.graphPath(graphId),
      this.bundlePath(graphId),
      this.cachePath(graphId),
    ];
    for (const p of triples) {
      const bak = `${p}.bak`;
      const [hasCanonical, hasBak] = await Promise.all([
        this.pathExists(p),
        this.pathExists(bak),
      ]);
      if (!hasBak) continue;
      if (!hasCanonical) {
        // Crash mid-rebuild — restore.
        try {
          await fs.rename(bak, p);
          console.error(`[graphnosis-host] recovered ${p} from interrupted purge backup`);
        } catch (e) {
          console.error(`[graphnosis-host] could not restore ${p} from .bak: ${(e as Error).message}`);
        }
      } else {
        // Stale .bak from a previously-committed purge — clean up.
        try { await fs.unlink(bak); } catch { /* fine */ }
      }
    }
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async safeUnlink(p: string): Promise<void> {
    try { await fs.unlink(p); } catch { /* already gone */ }
  }

  // ── Activity (op-log timeline) ──────────────────────────────────────────

  /**
   * Decrypt + return every op-log event. The App's Activity view groups,
   * sorts, and filters these client-side — sidecar stays a thin pipe.
   * Cached briefly inside readAllEvents (none currently); recomputed on
   * each call. For massive op-logs (>100k events) we'd add windowing.
   */
  /** Per-engram recent-activity signal for vitality — count of nodes created in
   *  the last 7 days, read from the IN-MEMORY graph (node.createdAt), NOT the
   *  op-log. Keeps the op-log cold (memory) AND survives restart (derived from
   *  the persisted graph, so vitality no longer drops on every relaunch). */
  recentOpsByGraph(): Record<string, number> {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const out: Record<string, number> = {};
    for (const graphId of this.listGraphs()) {
      const g = this.graphs.get(graphId);
      if (g) { try { out[graphId] = this.opts.adapter.countRecentNodes(g.handle, cutoff); } catch { out[graphId] = 0; } }
    }
    return out;
  }

  /** Shared options for every op-log read: verify each device's signature
   *  against its TOFU-pinned public key and surface integrity problems loudly
   *  (drop/replay/reorder/forgery) rather than silently skipping them. */
  private oplogReadOptions(): oplog.ReadOpLogOptions {
    return {
      getDevicePubKey: (deviceId) => this.deviceIdentity.getPubKey(deviceId),
      onIntegrityIssue: (i) => {
        // future-timestamp fires once per bad event; dedupe like legacy v1
        // malformed (one summary per device+file per session).
        if (i.kind === 'future-timestamp') {
          const key = `${i.deviceId ?? ''}:${i.file}`;
          if (this._oplogIntegrityWarned.has(key)) return;
          this._oplogIntegrityWarned.add(key);
        }
        console.error(`[graphnosis-host] op-log integrity (${i.kind})${i.deviceId ? ` device=${redactId(i.deviceId)}` : ''} in ${i.file}: ${i.detail}`);
      },
    };
  }

  async listOplogEvents(): Promise<Awaited<ReturnType<typeof oplog.readAllEvents>>> {
    // ── Cache hit ──────────────────────────────────────────────────────────
    // Serve the cache INDEFINITELY as long as no op has been written since it
    // was read (write-seq unchanged). This is the incremental fix: idle Home
    // opens no longer trigger a 16s full re-read every 60s — only an actual
    // write does. (The cache always holds real readAllEvents output, so every
    // consumer — vitality, memory-health, Audit, corrections — stays correct.)
    if (this._oplogReadCache && this._oplogReadCache.seq === this._oplogWriteSeq) {
      return this._oplogReadCache.events;
    }
    // ── Share an in-flight read ────────────────────────────────────────────
    // The op-log can be very large (2+ million events on an active cortex).
    // Reading + decrypting it takes 10–20 s. Without sharing, two callers
    // that arrive within that window (e.g. refreshAllCorrectionsFromOplog()
    // at boot + vitality.compute() 2 s later) each spawn their own 16 s
    // read of the same file — effectively doubling the startup delay.
    //
    // The shared promise ensures only one `readAllEvents` is in flight at a
    // time. All concurrent waiters attach to the same Promise and get the
    // same result when it resolves.
    if (this._oplogReadPromise) return this._oplogReadPromise;

    const gen = this._oplogReadGeneration;
    // Capture the write-seq at the START of the read. If a write lands while
    // readAllEvents is running, the cached seq stays behind current → the next
    // read refreshes (errs toward re-reading, never serving stale).
    const seqAtStart = this._oplogWriteSeq;
    this._oplogReadPromise = oplog.readAllEvents(
      path.join(this.opts.cortexDir, 'oplog'),
      this.key,
      this.oplogReadOptions(),
    ).then((events) => {
      // Only write to the cache if invalidateOplogCache() hasn't been called
      // since this read started. If the generation advanced, a write event
      // happened mid-read and the data is already stale — let the next caller
      // trigger a fresh read.
      if (this._oplogReadGeneration === gen) {
        this._oplogReadCache = { events, at: Date.now(), seq: seqAtStart };
      }
      this._oplogReadPromise = null;
      return events;
    }).catch((e: unknown) => {
      this._oplogReadPromise = null;
      throw e;
    });
    return this._oplogReadPromise;
  }

  /** Bounded Activity query — tail-first reverse scan; empty range returns instantly. */
  async listOplogEventsForActivity(params: {
    since?: number;
    until?: number;
    limit?: number;
    cursor?: { ts: number; id: string };
    ops?: string[];
    actor?: string;
  }): Promise<{
    events: Awaited<ReturnType<typeof oplog.readAllEvents>>;
    actors: string[];
    hasMore: boolean;
    nextCursor?: { ts: number; id: string };
  }> {
    const base: Omit<import('./oplog-activity-query.js').ActivityOplogQuery, 'oplogDir' | 'key' | 'readOpts'> = {
      actorOf,
    };
    if (params.since !== undefined) base.since = params.since;
    if (params.until !== undefined) base.until = params.until;
    if (params.limit !== undefined) base.limit = params.limit;
    if (params.cursor !== undefined) base.cursor = params.cursor;
    if (params.ops !== undefined) base.ops = params.ops;
    if (params.actor !== undefined) base.actor = params.actor;
    if (params.since !== undefined && params.until !== undefined && params.until <= params.since) {
      return { events: [], actors: [], hasMore: false };
    }
    if (this._oplogReadCache && this._oplogReadCache.seq === this._oplogWriteSeq) {
      return sliceOplogCacheForActivity(this._oplogReadCache.events, base);
    }
    return queryOplogForActivity({
      oplogDir: path.join(this.opts.cortexDir, 'oplog'),
      key: this.key,
      readOpts: this.oplogReadOptions(),
      ...base,
    });
  }


  async listMcpAuditEvents(): Promise<import('./mcp-audit.js').McpAuditEvent[]> {
    if (this._mcpAuditCache) return this._mcpAuditCache;
    const { listMcpAuditEvents } = await import('./mcp-audit.js');
    const events = await listMcpAuditEvents(this.opts.cortexDir, this.key);
    this._mcpAuditCache = events;
    return events;
  }

  async appendMcpAuditEvent(
    partial: Omit<import('./mcp-audit.js').McpAuditEvent, 'id' | 'ts'>,
  ): Promise<void> {
    const { appendMcpAuditEvent } = await import('./mcp-audit.js');
    await appendMcpAuditEvent(this.opts.cortexDir, this.key, partial);
    this._mcpAuditCache = null;
  }

  /** Expire the op-log read cache so the next listOplogEvents() re-reads from disk.
   *  Call after writing a new op-log entry (correction, remember, forget) to ensure
   *  vitality and corrections counts reflect the change within 60 s. */
  invalidateOplogCache(): void {
    this._oplogReadCache = null;
    // Advance the write-seq too, so a stale in-flight read can't repopulate a
    // cache that then looks "fresh" (seq match) to the serve-check.
    this._oplogWriteSeq++;
    // Clear the in-flight promise so the next caller starts a fresh read
    // rather than getting the result of a read that started before this
    // write (and therefore won't include the new event).
    this._oplogReadPromise = null;
    // Increment generation so any still-running in-flight read doesn't
    // overwrite the cache with pre-write data when it eventually completes.
    this._oplogReadGeneration++;
  }

  // ── Snapshots ───────────────────────────────────────────────────────────
  //
  // A snapshot is an atomic copy of the cortex's encrypted files at a
  // point in time. Lives at <cortex>/.snapshots/<isoDate>/. Snapshots are
  // already encrypted (same key as the live files), so no extra crypto.
  //
  // Restore is intentionally NOT exposed yet — too easy to footgun without
  // a proper confirm flow + rollback path. List + create is enough for the
  // "pin this moment" use case the user asked for.

  private snapshotsDir(): string {
    return path.join(this.opts.cortexDir, '.snapshots');
  }

  async listSnapshots(): Promise<Array<{ id: string; createdAt: number; sizeBytes: number; fileCount: number }>> {
    try {
      const dirs = await fs.readdir(this.snapshotsDir());
      const out: Array<{ id: string; createdAt: number; sizeBytes: number; fileCount: number }> = [];
      for (const id of dirs) {
        if (id.startsWith('.')) continue;
        const full = path.join(this.snapshotsDir(), id);
        try {
          const stat = await fs.stat(full);
          if (!stat.isDirectory()) continue;
          let sizeBytes = 0;
          let fileCount = 0;
          const walk = async (d: string): Promise<void> => {
            const entries = await fs.readdir(d, { withFileTypes: true });
            for (const e of entries) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) await walk(p);
              else { const s = await fs.stat(p); sizeBytes += s.size; fileCount++; }
            }
          };
          await walk(full);
          out.push({ id, createdAt: stat.birthtimeMs || stat.mtimeMs, sizeBytes, fileCount });
        } catch { /* skip unreadable */ }
      }
      return out.sort((a, b) => b.createdAt - a.createdAt);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /**
   * Copy every encrypted cortex file into `.snapshots/<iso>/`. Atomic on a
   * per-file basis (no rename trickery — these are independent backups).
   * The live files are untouched. Snapshots stay encrypted; no key leak.
   */
  async createSnapshot(): Promise<{ id: string; sizeBytes: number; fileCount: number }> {
    // Save first so anything dirty in memory makes it into the snapshot.
    for (const graphId of this.listGraphs()) {
      const g = this.graphs.get(graphId);
      if (g?.dirty) await this.save(graphId);
    }
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.snapshotsDir(), id);
    await fs.mkdir(dest, { recursive: true });

    // Files worth snapshotting: graphs/*.gai, graphs/*.bundle, graphs/*.embcache,
    // settings.json, salt.bin, policy.json (if present), content/*, master.enc,
    // recovery.enc. NOT the op-log — it's already append-only history, and
    // copying it would double disk for every snapshot.
    //
    // master.enc + recovery.enc MUST be in the snapshot. Restoring a snapshot
    // without them would leave the cortex unlockable (passphrase derives the
    // wrap key fine, but there's no wrapped data key to unwrap). Adding them
    // here closes a previously-silent gap that would have bricked any cortex
    // restored from a snapshot taken after the v0.3 wrapped-key migration.
    const sourceDirs = [
      { src: path.join(this.opts.cortexDir, 'graphs'), dest: path.join(dest, 'graphs') },
      { src: path.join(this.opts.cortexDir, 'content'), dest: path.join(dest, 'content') },
    ];
    const sourceFiles = [
      path.join(this.opts.cortexDir, 'settings.json'),
      path.join(this.opts.cortexDir, 'salt.bin'),
      path.join(this.opts.cortexDir, 'policy.json'),
      path.join(this.opts.cortexDir, 'master.enc'),
      path.join(this.opts.cortexDir, 'recovery.enc'),
    ];

    let sizeBytes = 0;
    let fileCount = 0;

    const copyFile = async (src: string, dst: string): Promise<void> => {
      try {
        await fs.copyFile(src, dst);
        const s = await fs.stat(dst);
        sizeBytes += s.size;
        fileCount++;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') return; // source missing — skip
        throw err;
      }
    };

    for (const { src, dest: d } of sourceDirs) {
      try {
        const entries = await fs.readdir(src);
        await fs.mkdir(d, { recursive: true });
        for (const name of entries) {
          if (name.startsWith('.')) continue;
          await copyFile(path.join(src, name), path.join(d, name));
        }
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw err;
      }
    }
    for (const src of sourceFiles) {
      await copyFile(src, path.join(dest, path.basename(src)));
    }

    return { id, sizeBytes, fileCount };
  }

  // ── Op-log merge / materialization ─────────────────────────────────────
  //
  // On loadGraph, converge the on-disk .gai cache with the merged op-log
  // (all devices' *.oplog files). Corrections (edit/supersede/delete) and
  // source lifecycle (ingest/forget/reorder) from peer devices are replayed
  // here; missing recoverable sources are re-ingested without duplicating
  // op-log rows (skipOplogEmit).

  private async reconcileGraphFromOplog(
    graphId: GraphId,
    entry: LoadedGraph,
    prefetch?: {
      fullEvents?: Awaited<ReturnType<typeof oplog.readAllEvents>> | null;
      tailEvents?: Awaited<ReturnType<typeof oplog.readAllEvents>> | null;
    },
  ): Promise<'skipped' | 'ran'> {
    if (this.graphs.get(graphId) !== entry) return 'skipped';
    const checkpoint = this.settings.graphMetadata[graphId]?.oplogReconcileCheckpoint;
    const tailReplay = checkpoint !== undefined;
    type OplogEventBatch = Awaited<ReturnType<typeof oplog.readAllEvents>>;
    let events: OplogEventBatch;

    if (tailReplay && checkpoint) {
      if (prefetch?.tailEvents != null) {
        events = this.filterOplogEventsSince(prefetch.tailEvents, checkpoint);
      } else if (prefetch?.fullEvents != null) {
        events = this.filterOplogEventsSince(prefetch.fullEvents, checkpoint);
      } else {
        const oplogDir = path.join(this.opts.cortexDir, 'oplog');
        events = await oplog.readEventsSince(oplogDir, this.key, {
          ...this.oplogReadOptions(),
          sinceTs: checkpoint.maxTs,
          ...(checkpoint.maxSeq !== undefined ? { sinceSeq: checkpoint.maxSeq } : {}),
        });
      }
    } else {
      events = prefetch?.fullEvents ?? await this.listOplogEvents();
    }

    const graphEvents = events.filter((e) => e.graphId === graphId);

    await this.opts.adapter.build(entry.handle);

    let dirty = await this.materializeEmptyGraphFromBundle(graphId, entry);

    if (graphEvents.length === 0) {
      if (dirty) {
        entry.dirty = true;
        await this.save(graphId);
        this.invalidateOplogCache();
      }
      if (events.length > 0) await this.persistOplogReconcileCheckpoint(graphId, events);
      return dirty ? 'ran' : 'skipped';
    }

    const liveSources = this.buildLiveSourceMapFromOplog(graphId, graphEvents, entry);

    const bundleHadSources = entry.bundleSourcesAtLoad > 0;
    for (const [sourceId, rec] of liveSources) {
      const local = entry.sourceIndex.get(sourceId);
      if (!local) {
        // Empty .gai shell with no bundle metadata (save-guards pattern) — do not
        // hydrate solely from op-log; hollow engrams must carry sources in .bundle.
        if (!bundleHadSources) continue;
        if (await this.recoverSourceFromOplog(graphId, entry, rec)) dirty = true;
      } else if (JSON.stringify(local.nodeIds) !== JSON.stringify(rec.nodeIds)) {
        try {
          entry.sourceIndex.reorderNodes(sourceId, rec.nodeIds);
          dirty = true;
        } catch {
          // nodeId mismatch between .gai and op-log — leave for manual recovery
        }
      }
    }

    // Full replay reconstructs the live source set from the entire log; tail
    // replay only applies deltas — never sweep sources absent from the tail slice.
    if (!tailReplay) {
      for (const s of [...entry.sourceIndex.list()]) {
        if (!liveSources.has(s.sourceId)) {
          await this.reconcileForgetSource(graphId, entry, s.sourceId);
          dirty = true;
        }
      }
    } else {
      for (const ev of graphEvents) {
        if (ev.op === 'forgetSource' && ev.target.kind === 'source') {
          if (entry.sourceIndex.get(ev.target.id)) {
            await this.reconcileForgetSource(graphId, entry, ev.target.id);
            dirty = true;
          }
        }
      }
    }

    dirty = await this.replayNodeCorrectionsFromOplog(entry, graphEvents) || dirty;

    if (dirty) {
      entry.dirty = true;
      await this.save(graphId);
      this.invalidateOplogCache();
    }

    await this.persistOplogReconcileCheckpoint(graphId, events);
    return 'ran';
  }

  private isAfterOplogCheckpoint(
    ev: Awaited<ReturnType<typeof oplog.readAllEvents>>[number],
    sinceTs: number,
    sinceSeq?: number,
  ): boolean {
    if (ev.ts > sinceTs) return true;
    if (ev.ts < sinceTs) return false;
    if (sinceSeq === undefined) return false;
    return typeof ev.seq === 'number' && ev.seq > sinceSeq;
  }

  private filterOplogEventsSince(
    events: Awaited<ReturnType<typeof oplog.readAllEvents>>,
    checkpoint: { maxTs: number; maxSeq?: number },
  ): Awaited<ReturnType<typeof oplog.readAllEvents>> {
    return events.filter((ev) =>
      this.isAfterOplogCheckpoint(ev, checkpoint.maxTs, checkpoint.maxSeq),
    );
  }

  private minOplogReconcileCheckpoint(
    checkpoints: Array<{ maxTs: number; maxSeq?: number }>,
  ): { maxTs: number; maxSeq?: number } {
    return checkpoints.reduce((min, ck) => {
      if (ck.maxTs < min.maxTs) return ck;
      if (ck.maxTs > min.maxTs) return min;
      const ckSeq = ck.maxSeq ?? -1;
      const minSeq = min.maxSeq ?? -1;
      return ckSeq < minSeq ? ck : min;
    });
  }

  /** forgetSource during loadGraph reconcile — entry is not yet in graphs.set(). */
  private async reconcileForgetSource(
    graphId: GraphId,
    entry: LoadedGraph,
    sourceId: string,
  ): Promise<void> {
    const priorRecord = entry.sourceIndex.get(sourceId);
    const nodeIds = entry.sourceIndex.forget(sourceId);
    for (const nodeId of nodeIds) {
      const local = this.opts.adapter.inspectNodes(entry.handle).find((n) => n.id === nodeId);
      if (!local || local.confidence <= 0.2) continue;
      await this.opts.adapter.applyCorrection(entry.handle, {
        kind: 'delete',
        nodeId,
        reason: 'oplog-sync: source forgotten on peer device',
      });
    }
    if (priorRecord && nodeIds.length > 0) {
      // skip op-log emit — replaying existing history
    }
  }

  /** Advance per-engram reconcile checkpoint to the high-water of `events`. */
  private async persistOplogReconcileCheckpoint(
    graphId: GraphId,
    events: Awaited<ReturnType<typeof oplog.readAllEvents>>,
  ): Promise<void> {
    const next = this.mergeOplogReconcileCheckpoint(
      this.settings.graphMetadata[graphId]?.oplogReconcileCheckpoint,
      events,
    );
    if (!next) return;
    const existing: settingsMod.GraphMetadata = this.settings.graphMetadata[graphId] ?? {
      template: 'personal' as settingsMod.GraphTemplate,
      displayName: graphId,
      createdAt: 0,
    };
    await this.setGraphMetadata(graphId, { ...existing, oplogReconcileCheckpoint: next });
  }

  private mergeOplogReconcileCheckpoint(
    prev: settingsMod.GraphMetadata['oplogReconcileCheckpoint'],
    events: Awaited<ReturnType<typeof oplog.readAllEvents>>,
  ): { maxTs: number; maxSeq?: number } | undefined {
    if (events.length === 0) return prev;
    let maxTs = prev?.maxTs ?? 0;
    let maxSeq = prev?.maxSeq;
    for (const ev of events) {
      if (ev.ts > maxTs) {
        maxTs = ev.ts;
        maxSeq = typeof ev.seq === 'number' ? ev.seq : undefined;
      } else if (ev.ts === maxTs && typeof ev.seq === 'number') {
        maxSeq = Math.max(maxSeq ?? -1, ev.seq);
      }
    }
    return { maxTs, ...(maxSeq !== undefined ? { maxSeq } : {}) };
  }

  /** Clear tail-replay checkpoint after full op-log recovery rebuilds the engram. */
  private async clearOplogReconcileCheckpoint(graphId: GraphId): Promise<void> {
    const existing = this.settings.graphMetadata[graphId];
    if (!existing?.oplogReconcileCheckpoint) return;
    const { oplogReconcileCheckpoint: _removed, ...rest } = existing;
    await this.setGraphMetadata(graphId, rest);
  }

  /** Walk op-log source events chronologically — ingestSource wins over reorderSource partials. */
  private buildLiveSourceMapFromOplog(
    graphId: GraphId,
    graphEvents: Awaited<ReturnType<typeof oplog.readAllEvents>>,
    entry: LoadedGraph,
  ): Map<string, SourceRecord> {
    const live = new Map<string, SourceRecord>();
    for (const ev of graphEvents) {
      if (ev.op === 'ingestSource' && ev.target.kind === 'source') {
        const rec = ev.after as Partial<SourceRecord> | undefined;
        if (!rec?.ref || !rec?.kind) continue;
        live.set(ev.target.id, {
          sourceId: ev.target.id,
          graphId,
          kind: rec.kind,
          ref: rec.ref,
          ingestedAt: rec.ingestedAt ?? ev.ts,
          nodeIds: rec.nodeIds ?? [],
          ...(rec.contentHash ? { contentHash: rec.contentHash } : {}),
          ...(rec.addedBy ? { addedBy: rec.addedBy } : {}),
        });
      } else if (ev.op === 'forgetSource' && ev.target.kind === 'source') {
        live.delete(ev.target.id);
      } else if ((ev.op as string) === 'reorderSource' && ev.target.kind === 'source') {
        const after = ev.after as { nodeIds?: string[] } | undefined;
        const base = live.get(ev.target.id) ?? entry.sourceIndex.get(ev.target.id);
        if (base && after?.nodeIds) {
          live.set(ev.target.id, { ...base, nodeIds: after.nodeIds });
        }
      }
    }
    return live;
  }

  private async recoverSourceFromOplog(
    graphId: GraphId,
    _entry: LoadedGraph,
    rec: SourceRecord,
  ): Promise<boolean> {
    try {
      await fs.stat(this.contentPath(rec.sourceId));
      const blob = await this.readContentBlob(rec.sourceId);
      if (!blob) return false;
      const content = blob.header.docKind === 'pdf'
        ? Buffer.from(blob.content)
        : new TextDecoder().decode(blob.content);
      await this.ingest(graphId, blob.header.kind, blob.header.ref, {
        kind: blob.header.docKind,
        content: content as never,
        sourceRef: blob.header.ref,
      }, { triggeredBy: 'oplog-sync', skipOplogEmit: true, skipAutoRelink: true });
      return true;
    } catch { /* no cache blob */ }

    const bundled = bundledDocForRef(rec.ref);
    if (bundled) {
      try {
        await this.ingest(graphId, rec.kind, rec.ref, bundled, {
          triggeredBy: 'oplog-sync',
          skipOplogEmit: true,
          skipAutoRelink: true,
          ...(rec.addedBy ? { addedBy: rec.addedBy } : {}),
        });
        return true;
      } catch { /* bundled ingest failed */ }
    }

    if (rec.kind === 'file') {
      try {
        const buf = await fs.readFile(rec.ref);
        const ext = path.extname(rec.ref).toLowerCase().replace(/^\./, '');
        const docKind: 'markdown' | 'text' | 'json' | 'html' | 'pdf' = (
          ext === 'md' || ext === 'markdown' ? 'markdown' :
          ext === 'json' ? 'json' :
          ext === 'html' || ext === 'htm' ? 'html' :
          ext === 'pdf' ? 'pdf' :
          'text'
        );
        const content = docKind === 'pdf' ? buf : new TextDecoder().decode(buf);
        await this.ingest(graphId, 'file', rec.ref, {
          kind: docKind,
          content: content as never,
          sourceRef: rec.ref,
        }, { triggeredBy: 'oplog-sync', skipOplogEmit: true, skipAutoRelink: true });
        return true;
      } catch { /* file gone */ }
    }
    return false;
  }

  /** Re-ingest bundle sources when .gai loaded empty but source metadata survived. */
  private async materializeEmptyGraphFromBundle(
    graphId: GraphId,
    entry: LoadedGraph,
  ): Promise<boolean> {
    if (this.opts.adapter.inspectNodes(entry.handle).length > 0) return false;
    const sources = entry.sourceIndex.list();
    if (sources.length === 0) return false;

    let dirty = false;
    let reingested = 0;
    for (const src of sources) {
      try {
        const result = await this.reingestSource(graphId, src.sourceId);
        if (!result.skipped) {
          reingested++;
          dirty = true;
        }
      } catch (e) {
        console.error(
          `[graphnosis-host] materialize bundle source failed engram[${redactId(graphId)}] ` +
          `source[${redactId(src.sourceId)}]: ${(e as Error).message}`,
        );
      }
    }
    const nodesAfter = this.opts.adapter.inspectNodes(entry.handle).length;
    if (nodesAfter === 0 && sources.length > 0) {
      console.error(
        `[graphnosis-host] loadGraph reconcile engram[${redactId(graphId)}]: WARNING still 0 nodes after ` +
        `materialize (${sources.length} bundle source(s), ${reingested} re-ingested)`,
      );
    } else if (reingested > 0) {
      dbg(
        `[graphnosis-host] materialized engram[${redactId(graphId)}] from bundle: ` +
        `${reingested}/${sources.length} source(s), ${nodesAfter} nodes`,
      );
    }
    return dirty;
  }

  /** Replay edit/supersede/delete node ops in ts order (multi-device LWW is in reduce; here we apply the stream). */
  private async replayNodeCorrectionsFromOplog(
    entry: LoadedGraph,
    graphEvents: Awaited<ReturnType<typeof oplog.readAllEvents>>,
  ): Promise<boolean> {
    let dirty = false;
    for (const ev of graphEvents) {
      if (ev.target.kind !== 'node') continue;
      const nodeId = ev.target.id;
      if (ev.op === 'deleteNode') {
        const local = this.opts.adapter.inspectNodes(entry.handle).find((n) => n.id === nodeId);
        if (!local || local.confidence <= 0.2) continue;
        await this.opts.adapter.applyCorrection(entry.handle, {
          kind: 'delete',
          nodeId,
          reason: 'oplog-sync: deleted on peer device',
        });
        dirty = true;
        continue;
      }
      if (ev.op !== 'editNode' && ev.op !== 'supersede') continue;
      const after = ev.after as { content?: string; reason?: string } | undefined;
      if (typeof after?.content !== 'string') continue;
      const local = this.opts.adapter.inspectNodes(entry.handle).find((n) => n.id === nodeId);
      if (!local) continue;
      const preview = after.content.slice(0, 200);
      if (local.contentPreview === preview || local.contentPreview === after.content) continue;
      await this.opts.adapter.applyCorrection(entry.handle, {
        kind: ev.op === 'supersede' ? 'supersede' : 'edit',
        nodeId,
        content: after.content,
        reason: String(after.reason ?? 'oplog-sync'),
      });
      dirty = true;
    }
    return dirty;
  }

  // ── Recovery ────────────────────────────────────────────────────────────
  //
  // Replay the encrypted op-log to reconstruct sources that were lost from
  // a graph (silent-overwrite bug, manual deletion, corrupt .gai, etc.).
  //
  // Two-phase by design so the user can review before any side effects:
  //   planRecovery()   → list of live sources with per-item recoverability status
  //   applyRecovery()  → re-ingest the selected sources, return per-item outcome
  //
  // Important: node content isn't in the op-log (only sourceIds for addNode
  // events), so we can only recover sources whose original `ref` is still
  // reachable from disk. Pasted text and AI-conversation clips are unrecoverable
  // unless they happened to be saved as files.

  async planRecovery(): Promise<RecoveryPlan> {
    const events = await oplog.readAllEvents(path.join(this.opts.cortexDir, 'oplog'), this.key, this.oplogReadOptions());
    // Walk in chronological order; ingestSource adds, forgetSource removes.
    const live = new Map<string, RecoveryPlanItem>();
    for (const ev of events) {
      if (ev.op === 'ingestSource' && ev.target.kind === 'source') {
        const rec = ev.after as Partial<SourceRecord> | undefined;
        if (!rec || !rec.ref || !rec.kind) continue;
        live.set(ev.target.id, {
          sourceId: ev.target.id,
          graphId: ev.graphId,
          kind: rec.kind,
          ref: rec.ref,
          ingestedAt: rec.ingestedAt ?? ev.ts,
          status: 'pending',
          ...(rec.contentHash ? { contentHash: rec.contentHash } : {}),
        });
      } else if (ev.op === 'forgetSource' && ev.target.kind === 'source') {
        live.delete(ev.target.id);
      }
    }

    // Annotate each item with recoverability. The order of preference:
    //   1. Already in the loaded graph → skip
    //   2. Content blob in <cortex>/content/ → recoverable-from-cache
    //   3. kind=file and the original path still exists → recoverable
    //   4. kind=url → url-refetch-not-implemented
    //   5. Otherwise → file-missing or content-not-in-oplog
    const items: RecoveryPlanItem[] = [];
    for (const item of live.values()) {
      const g = this.graphs.get(item.graphId);
      if (g && g.sourceIndex.list().some(s => s.sourceId === item.sourceId)) {
        items.push({ ...item, status: 'already-present' });
        continue;
      }
      // Cache hit beats everything — survives source-file moves/deletes.
      let cached = false;
      try {
        await fs.stat(this.contentPath(item.sourceId));
        cached = true;
      } catch { /* no cached blob */ }
      if (cached) {
        items.push({ ...item, status: 'recoverable-from-cache' });
        continue;
      }
      if (item.kind === 'file') {
        try {
          await fs.stat(item.ref);
          items.push({ ...item, status: 'recoverable' });
        } catch {
          items.push({ ...item, status: 'file-missing' });
        }
      } else if (item.kind === 'url') {
        items.push({ ...item, status: 'url-refetch-not-implemented' });
      } else {
        items.push({ ...item, status: 'content-not-in-oplog' });
      }
    }

    // Sort: cache-recoverable first (highest confidence), then on-disk recoverable,
    // then everything else, with ingestedAt as a stable tie-breaker.
    items.sort((a, b) => {
      const rank = (s: RecoveryStatus): number =>
        s === 'recoverable-from-cache' ? 0 :
        s === 'recoverable' ? 1 :
        s === 'already-present' ? 2 :
        s === 'url-refetch-not-implemented' ? 3 :
        s === 'file-missing' ? 4 : 5;
      const r = rank(a.status) - rank(b.status);
      return r !== 0 ? r : a.ingestedAt - b.ingestedAt;
    });

    return {
      total: items.length,
      recoverable: items.filter(i =>
        i.status === 'recoverable' || i.status === 'recoverable-from-cache',
      ).length,
      items,
    };
  }

  /**
   * Re-ingest the selected sources. If `sourceIds` is undefined, re-ingests
   * every `recoverable` item from the current plan. Returns a per-item report.
   *
   * Optional callbacks let the IPC layer broadcast per-source progress events
   * so the UI can render a live progress bar — re-ingesting a 4233-page PDF
   * takes ~80 minutes and the user needs to see something happening.
   */
  async applyRecovery(
    sourceIds?: string[],
    callbacks?: {
      onSourceStart?: (sourceId: string, ref: string, index: number, total: number) => void;
      onSourceDone?: (outcome: RecoveryOutcome, index: number, total: number) => void;
    },
  ): Promise<RecoveryReport> {
    const plan = await this.planRecovery();
    const isRecoverable = (s: RecoveryStatus): boolean =>
      s === 'recoverable' || s === 'recoverable-from-cache';
    const want = sourceIds === undefined
      ? plan.items.filter(i => isRecoverable(i.status))
      : plan.items.filter(i => sourceIds.includes(i.sourceId));

    const outcomes: RecoveryOutcome[] = [];
    const total = want.length;
    let globalIndex = 0;

    // Group by graph so we only loadGraph once per target.
    const byGraph = new Map<GraphId, RecoveryPlanItem[]>();
    for (const item of want) {
      const arr = byGraph.get(item.graphId) ?? [];
      arr.push(item);
      byGraph.set(item.graphId, arr);
    }

    for (const [graphId, arr] of byGraph) {
      // Ensure the graph is loaded; create empty if missing.
      if (!this.graphs.has(graphId)) {
        try {
          await this.loadGraph(graphId);
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          if (err.code === 'ENOENT') {
            await this.createGraph(graphId);
          } else {
            for (const item of arr) {
              const outcome: RecoveryOutcome = {
                sourceId: item.sourceId,
                ref: item.ref,
                ok: false,
                error: `could not open graph ${graphId}: ${err.message}`,
              };
              outcomes.push(outcome);
              globalIndex += 1;
              callbacks?.onSourceDone?.(outcome, globalIndex, total);
            }
            continue;
          }
        }
      }

      for (const item of arr) {
        globalIndex += 1;
        callbacks?.onSourceStart?.(item.sourceId, item.ref, globalIndex, total);

        let outcome: RecoveryOutcome;
        if (item.status === 'already-present') {
          outcome = { sourceId: item.sourceId, ref: item.ref, ok: true, skipped: 'already-present' };
        } else if (!isRecoverable(item.status)) {
          outcome = {
            sourceId: item.sourceId,
            ref: item.ref,
            ok: false,
            error: `not recoverable (status=${item.status})`,
          };
        } else {
          try {
            if (item.status === 'recoverable-from-cache') {
              // Cache path: decrypt blob, re-ingest using the original docKind
              // recorded at ingest time. This is the only recovery path for
              // clip / ai-conversation kinds.
              const blob = await this.readContentBlob(item.sourceId);
              if (!blob) throw new Error('content blob disappeared between plan and apply');
              const content = blob.header.docKind === 'pdf'
                ? Buffer.from(blob.content)
                : new TextDecoder().decode(blob.content);
              await this.ingest(graphId, blob.header.kind, blob.header.ref, {
                kind: blob.header.docKind,
                content: content as never,
                sourceRef: blob.header.ref,
              });
            } else {
              // Disk path: re-read the original file.
              const buf = await fs.readFile(item.ref);
              const ext = path.extname(item.ref).toLowerCase().replace(/^\./, '');
              const docKind: 'markdown' | 'text' | 'json' | 'html' | 'pdf' = (
                ext === 'md' || ext === 'markdown' ? 'markdown' :
                ext === 'json' ? 'json' :
                ext === 'html' || ext === 'htm' ? 'html' :
                ext === 'pdf' ? 'pdf' :
                'text'
              );
              const content = docKind === 'pdf' ? buf : new TextDecoder().decode(buf);
              await this.ingest(graphId, 'file', item.ref, {
                kind: docKind,
                content: content as never,
                sourceRef: item.ref,
              });
            }
            outcome = { sourceId: item.sourceId, ref: item.ref, ok: true };
          } catch (e) {
            outcome = {
              sourceId: item.sourceId,
              ref: item.ref,
              ok: false,
              error: (e as Error).message,
            };
          }
        }
        outcomes.push(outcome);
        callbacks?.onSourceDone?.(outcome, globalIndex, total);
      }
      if (outcomes.some((o) => o.ok && !o.skipped)) {
        await this.clearOplogReconcileCheckpoint(graphId);
      }
    }

    return {
      attempted: outcomes.length,
      recovered: outcomes.filter(o => o.ok && !o.skipped).length,
      skipped: outcomes.filter(o => o.skipped !== undefined).length,
      failed: outcomes.filter(o => !o.ok).length,
      outcomes,
    };
  }

  listSources(graphId?: GraphId): SourceRecord[] {
    if (!graphId) {
      const all: SourceRecord[] = [];
      for (const g of this.graphs.values()) all.push(...g.sourceIndex.list());
      return all;
    }
    return this.must(graphId).sourceIndex.list();
  }

  private must(graphId: GraphId): LoadedGraph {
    const g = this.graphs.get(graphId);
    if (!g) throw new Error(`Graph not loaded: ${graphId}`);
    this.kickoffDeferredSourceRefSweep(graphId);
    return g;
  }
}

// ── Atomic file write helper ────────────────────────────────────────────────
//
// Writes data to a sibling .tmp path, fsync's it to disk, then atomically
// renames it onto the target. On POSIX, rename(2) is atomic: a concurrent
// reader sees either the old file or the new one, never a half-written
// blob. This protects every .gai / .bundle write against process kills
// (force-quit, OOM, crash, OS shutdown) that would otherwise leave the
// canonical file mid-flight and unreadable on next load (HMAC mismatch).
//
// fsync matters: without it, a kernel buffer flush can happen AFTER the
// rename completes, so a power loss in that window still leaves the new
// file's bytes only partially on stable storage. We open + write + fsync
// + close + rename — the standard atomic-write pattern.
async function writeFileAtomic(target: string, data: Buffer): Promise<void> {
  // The tmp suffix MUST be unique per concurrent call to the same target.
  // The old `${pid}-${Date.now()}` shape collided when two saves of the same
  // graph happened in the same millisecond — observed when snapshotGraphs
  // looped save() across engrams while a background auto-relink save was
  // also in flight. Both calls computed the same tmp name, opened the same
  // file with 'w', then both tried to rename it; the second rename failed
  // with ENOENT because the file was already gone. Adding 8 random bytes
  // makes collisions impossible even within the same millisecond.
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const fh = await fs.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, target);
}

/** Suffix for the rolling last-known-good sibling of a graph/bundle file. A
 *  separate namespace from purge's `.bak` (which startup recovery treats as a
 *  transient purge artifact) so the two never collide. */
const LKG_SUFFIX = '.lkg';

/** Never overwrite a substantial on-disk .gai/.lkg with a 0-node serialize.
 *  Empty template shells are ~450B; anything above this threshold had real data. */
const EMPTY_SAVE_BLOCK_MIN_BYTES = 10 * 1024;
/** Refuse a save when new ciphertext is less than half the best on-disk size —
 *  blocks rotating a tiny .gai over a good .lkg (personal, Jun 2026). */
const SHRINK_SAVE_BLOCK_RATIO = 0.5;
/** After this many shrink-save blocks on one engram, pause autonomous brain writes. */
const SHRINK_SAVE_BRAIN_PAUSE_THRESHOLD = 3;

async function maxFileAndLkgBytes(target: string, lkgSuffix: string): Promise<number> {
  let max = 0;
  for (const p of [target, `${target}${lkgSuffix}`]) {
    try {
      const st = await fs.stat(p);
      if (st.size > max) max = st.size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return max;
}

async function wouldBlockShrinkSaveAtPath(
  target: string,
  newBytes: number,
  lkgSuffix: string,
): Promise<boolean> {
  const best = await maxFileAndLkgBytes(target, lkgSuffix);
  if (best <= EMPTY_SAVE_BLOCK_MIN_BYTES) return false;
  if (newBytes < best * SHRINK_SAVE_BLOCK_RATIO) return true;
  try {
    const tStat = await fs.stat(target);
    const lStat = await fs.stat(`${target}${lkgSuffix}`);
    if (
      lStat.size > EMPTY_SAVE_BLOCK_MIN_BYTES &&
      tStat.size < lStat.size * SHRINK_SAVE_BLOCK_RATIO
    ) {
      return true;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return false;
}

/** Global cap on concurrent saveInner bodies across ALL graphs. Each save
 *  holds 2-3× its engram size in off-heap Buffers (toBuffer + ciphertext +
 *  write copy) live at once; an uncapped burst that dirties N large engrams
 *  ran N saves concurrently → an N× `external` spike (11 GB observed on a
 *  17-engram cortex) that swapped the machine. 2 keeps a little overlap (one
 *  save can encrypt while another serializes) without the N× blowup; the work
 *  is CPU-bound on a single-threaded loop, so a low cap costs little time. */
const GLOBAL_SAVE_CONCURRENCY = 2;

/** LRU eviction cap: keep at most this many engram graphs resident in memory.
 *  Set high so a normal cortex keeps EVERY engram resident (correct stats,
 *  complete federated recall, no on-demand churn spike) — the memory floor is
 *  Bun/JSC's allocator, not the engrams (~870 MB for a whole cortex), so there's
 *  no point evicting them. Eviction stays as a safety valve only for a
 *  pathologically large cortex (> this many engrams). Cold engrams beyond the cap
 *  unload (disk intact) and lazily reload on access. Tunable. */
const GRAPH_RESIDENT_CAP = 64;
/** Master switch for LRU eviction. ON: the SDK now exposes dispose() (>=0.6.0),
 *  so unloadGraph clears the graph's structures and GC reclaims them — the
 *  earlier re-enable failed because there was no dispose() AND a forced GC was in
 *  play (UI showed 0 nodes/0 edges). With lazy-boot only ~1 engram is resident at
 *  idle (≤ cap → no eviction); eviction only fires after many engrams load (e.g.
 *  a federated recall), trimming the coldest idle ones. Disk data is untouched. */
const LRU_EVICTION_ENABLED = true;
/** Don't evict an engram accessed within this window — protects the active
 *  engram and anything in an in-flight, multi-step workflow from being pulled
 *  out from under the user mid-use. */
const GRAPH_IDLE_MS = 90_000;

/** Verify-after-write re-reads + reparses the just-written .gai. That costs a
 *  full parse, so we only do it for engrams big enough to matter — small ones
 *  parse instantly and have never hit a size-dependent serialization failure.
 *  8 MB sits comfortably below the ~17 MB checksum-threshold that bit large
 *  engrams, so anything approaching the danger zone is covered. */
const VERIFY_AFTER_WRITE_MIN_BYTES = 8 * 1024 * 1024;

/** DISABLED pending the sidecar memory-leak investigation. verify-after-write
 *  spins up a THROWAWAY full Graphnosis instance per large-engram save (a
 *  24 MB+ parse) via loadFromBuffer — a leading suspect for runaway RSS. The
 *  .lkg load-time fallback + the SDK checksum fix already protect against
 *  corruption, so this is redundant. Flip back on once the leak is ruled out. */
const VERIFY_AFTER_WRITE_ENABLED = false;

/** Per-graph throttle for verify-after-write. A burst ingest (docs ingest,
 *  connectors, op-log recovery) can fire hundreds of save()s on one engram in
 *  quick succession; re-reading + reparsing a 12 MB+ file on every one of them
 *  starves the sidecar (observed: `docs:ingest` timing out at 300s). Verifying
 *  at most once per this interval per graph keeps the integrity spot-check
 *  without the per-save cliff — anything missed in the window is still caught
 *  at next load by the .lkg fallback. */
const VERIFY_MIN_INTERVAL_MS = 20_000;

/**
 * Like writeFileAtomic, but first preserves the current good file as a
 * last-known-good sibling (`<target>.lkg`). Sequence: write new bytes to a
 * unique fsync'd tmp, rename the current file aside to `.lkg`, then rename tmp
 * into place. The window where `target` is briefly absent is two back-to-back
 * metadata renames (microseconds) — NOT the multi-second body write — and a
 * crash there still leaves the `.lkg` for loadGraph's fallback to recover.
 */
async function writeFileAtomicWithBackup(target: string, data: Buffer, lkgSuffix: string): Promise<void> {
  if (await wouldBlockShrinkSaveAtPath(target, data.length, lkgSuffix)) {
    throw new Error(
      `shrink_save_blocked: refusing to write ${data.length}B over substantial on-disk ${path.basename(target)}`,
    );
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const fh = await fs.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  // Roll the current good file to .lkg (overwrites any prior .lkg atomically).
  try {
    await fs.rename(target, `${target}${lkgSuffix}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // first-ever write: nothing to back up
  }
  await fs.rename(tmp, target);
}

/** Constant-time byte-array compare for the master.enc integrity check.
 *  Not strictly necessary (both sides are in our own memory), but it costs
 *  nothing and signals intent — never compare key material with `===`. */
function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ── Connector credential encryption (v0.6.1+) ───────────────────────────────
//
// Connector credentials (API keys, OAuth tokens) MUST never sit plaintext on
// disk. The v0.6 release shipped them in settings.json plaintext; v0.6.1
// migrates them to XChaCha20-Poly1305 ciphertext using the cortex data key,
// base64-encoded into a `credentialsEnc` field. The in-memory `credentials`
// field stays populated so connector code doesn't need to re-decrypt on every
// pull.
//
// Migration is automatic and one-way: if a config has plaintext `credentials`
// and no `credentialsEnc`, the next `persistSettings` call encrypts it and
// blanks out the plaintext field on disk. Users with legacy v0.6 cortexes
// upgrade transparently the first time anything writes to settings.

/** Encrypt every connector's `credentials` field into `credentialsEnc`,
 *  blanking the in-disk plaintext field. Returns a deep copy of `settings`
 *  with the on-disk shape. Safe to call when no connectors are configured. */
async function encryptConnectorCredentialsInSettings(
  settings: settingsMod.AppSettings,
  dataKey: Uint8Array,
): Promise<settingsMod.AppSettings> {
  const conn = settings.connectors;
  if (!conn?.configs?.length) return settings;
  const newConfigs = await Promise.all(conn.configs.map(async (c) => {
    // Empty credentials and no existing ciphertext → nothing to encrypt.
    if ((!c.credentials || Object.keys(c.credentials).length === 0) && !c.credentialsEnc) {
      const { credentialsEnc: _drop, ...rest } = c;
      return { ...rest, credentials: {} };
    }
    // Already-encrypted (decryption skipped on load for some reason) → keep as-is.
    if ((!c.credentials || Object.keys(c.credentials).length === 0) && c.credentialsEnc) {
      return { ...c, credentials: {} };
    }
    const plaintext = new TextEncoder().encode(JSON.stringify(c.credentials));
    // Fresh random 16-byte salt per encryption; sodium uses it as the
    // pwhash salt slot in the blob header. Since we pass the dataKey
    // directly (not a passphrase), the salt is effectively a unique IV.
    const salt = randomBytes(16);
    const blob = await crypto.encrypt(plaintext, dataKey, salt);
    const credentialsEnc = Buffer.from(blob).toString('base64');
    return { ...c, credentials: {}, credentialsEnc };
  }));
  return {
    ...settings,
    connectors: { ...conn, configs: newConfigs },
  };
}

/** Decrypt every connector's `credentialsEnc` back into `credentials`. Leaves
 *  legacy configs with plaintext `credentials` (no `credentialsEnc`)
 *  untouched — those re-encrypt on the next save. Safe to call when no
 *  connectors are configured or when all credentials are already plaintext. */
async function decryptConnectorCredentialsInSettings(
  settings: settingsMod.AppSettings,
  dataKey: Uint8Array,
): Promise<settingsMod.AppSettings> {
  const conn = settings.connectors;
  if (!conn?.configs?.length) return settings;
  const newConfigs = await Promise.all(conn.configs.map(async (c) => {
    // No ciphertext → either empty or legacy plaintext (both already correct
    // in-memory).
    if (!c.credentialsEnc) {
      const { credentialsEnc: _drop, ...rest } = c;
      return rest;
    }
    try {
      const blob = new Uint8Array(Buffer.from(c.credentialsEnc, 'base64'));
      const plaintext = await crypto.decrypt(blob, dataKey);
      const credentials = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, string>;
      const { credentialsEnc: _drop, ...rest } = c;
      return { ...rest, credentials };
    } catch (e) {
      // Decryption failure is non-fatal: log, blank credentials, continue.
      // The user will see the connector as "auth expired" / unconfigured
      // and can re-paste credentials in the UI. Better than a hard fail
      // that prevents cortex unlock.
      console.error(`[graphnosis-host] connector '${c.id}' credentials decryption failed: ${(e as Error).message}`);
      const { credentialsEnc: _drop, ...rest } = c;
      return { ...rest, credentials: {} };
    }
  }));
  return {
    ...settings,
    connectors: { ...conn, configs: newConfigs },
  };
}

// ── Network bridge token encryption ─────────────────────────────────────────
//
// The mobile bridge, browser HTTP-UI, and VS Code local bridge each hold a
// bearer token in settings.json. Those tokens grant network access to the
// cortex's MCP tool surface, so they MUST NOT sit plaintext on disk (a backup,
// iCloud/Drive sync, or another local user could lift them). We encrypt each
// with the cortex data key into a sibling `*Enc` field, exactly like connector
// credentials: in-memory plaintext (read post-unlock when the bridges start),
// on-disk ciphertext. Migration is automatic — a legacy plaintext token with no
// `*Enc` is encrypted and the plaintext blanked on the next persistSettings().

/** Encrypt a token string to base64 XChaCha20-Poly1305 under the data key. The
 *  random salt acts as a unique IV (the dataKey is passed directly, not a
 *  passphrase). */
async function encryptTokenField(plaintext: string, dataKey: Uint8Array): Promise<string> {
  const salt = randomBytes(16);
  const blob = await crypto.encrypt(new TextEncoder().encode(plaintext), dataKey, salt);
  return Buffer.from(blob).toString('base64');
}

async function decryptTokenField(enc: string, dataKey: Uint8Array): Promise<string> {
  const blob = new Uint8Array(Buffer.from(enc, 'base64'));
  return new TextDecoder().decode(await crypto.decrypt(blob, dataKey));
}

/** Encrypt the three bridge bearer tokens into their `*Enc` fields and blank the
 *  plaintext on disk. Returns the on-disk shape. Empty tokens are left as-is. */
async function encryptBridgeTokensInSettings(
  settings: settingsMod.AppSettings,
  dataKey: Uint8Array,
): Promise<settingsMod.AppSettings> {
  let out = settings;

  const hb = out.mobile?.httpBridge;
  if (hb?.token) {
    const tokenEnc = await encryptTokenField(hb.token, dataKey);
    out = { ...out, mobile: { ...out.mobile!, httpBridge: { ...hb, token: '', tokenEnc } } };
  }

  const hu = out.mobile?.httpUi;
  if (hu?.token) {
    const tokenEnc = await encryptTokenField(hu.token, dataKey);
    out = { ...out, mobile: { ...out.mobile!, httpUi: { ...hu, token: '', tokenEnc } } };
  }

  const vs = out.vscode;
  if (vs?.localBridgeToken) {
    const localBridgeTokenEnc = await encryptTokenField(vs.localBridgeToken, dataKey);
    out = { ...out, vscode: { ...vs, localBridgeToken: '', localBridgeTokenEnc } };
  }

  return out;
}

/** Decrypt the three bridge `*Enc` fields back into their plaintext token
 *  fields and drop the ciphertext from the in-memory struct. A decrypt failure
 *  is non-fatal: blank the token (the bridge shows as unconfigured / re-pair)
 *  rather than blocking cortex unlock. */
async function decryptBridgeTokensInSettings(
  settings: settingsMod.AppSettings,
  dataKey: Uint8Array,
): Promise<settingsMod.AppSettings> {
  let out = settings;

  const recover = async (enc: string, label: string): Promise<string> => {
    try {
      return await decryptTokenField(enc, dataKey);
    } catch (e) {
      console.error(`[graphnosis-host] ${label} token decryption failed: ${(e as Error).message}`);
      return '';
    }
  };

  const hb = out.mobile?.httpBridge;
  if (hb?.tokenEnc) {
    const token = await recover(hb.tokenEnc, 'mobile bridge');
    const { tokenEnc: _drop, ...rest } = hb;
    out = { ...out, mobile: { ...out.mobile!, httpBridge: { ...rest, token } } };
  }

  const hu = out.mobile?.httpUi;
  if (hu?.tokenEnc) {
    const token = await recover(hu.tokenEnc, 'HTTP-UI');
    const { tokenEnc: _drop, ...rest } = hu;
    out = { ...out, mobile: { ...out.mobile!, httpUi: { ...rest, token } } };
  }

  const vs = out.vscode;
  if (vs?.localBridgeTokenEnc) {
    const localBridgeToken = await recover(vs.localBridgeTokenEnc, 'VS Code bridge');
    const { localBridgeTokenEnc: _drop, ...rest } = vs;
    out = { ...out, vscode: { ...rest, localBridgeToken } };
  }

  return out;
}

async function encryptSsoSecretsInSettings(
  settings: settingsMod.AppSettings,
  dataKey: Uint8Array,
): Promise<settingsMod.AppSettings> {
  const sso = settings.sso;
  if (!sso) return settings;
  let nextSso = { ...sso };
  let changed = false;

  if (sso.oidc?.clientSecret) {
    const clientSecretEnc = await encryptTokenField(sso.oidc.clientSecret, dataKey);
    const { clientSecret: _drop, ...oidcRest } = sso.oidc;
    nextSso = {
      ...nextSso,
      oidc: { ...oidcRest, clientSecretEnc },
    };
    changed = true;
  }
  if (sso.federatedUnlockKey) {
    const federatedUnlockKeyEnc = await encryptTokenField(sso.federatedUnlockKey, dataKey);
    const { federatedUnlockKey: _drop, ...rest } = nextSso;
    nextSso = { ...rest, federatedUnlockKeyEnc };
    changed = true;
  }
  if (sso.orgSignSecret) {
    const orgSignSecretEnc = await encryptTokenField(sso.orgSignSecret, dataKey);
    const { orgSignSecret: _drop, ...rest } = nextSso;
    nextSso = { ...rest, orgSignSecretEnc };
    changed = true;
  }
  return changed ? { ...settings, sso: nextSso } : settings;
}

async function decryptSsoSecretsInSettings(
  settings: settingsMod.AppSettings,
  dataKey: Uint8Array,
): Promise<settingsMod.AppSettings> {
  const sso = settings.sso;
  if (!sso) return settings;
  let nextSso = { ...sso };
  let changed = false;

  const recover = async (enc: string, label: string): Promise<string> => {
    try {
      return await decryptTokenField(enc, dataKey);
    } catch (e) {
      console.error(`[graphnosis-host] ${label} decryption failed: ${(e as Error).message}`);
      return '';
    }
  };

  if (sso.oidc?.clientSecretEnc) {
    const clientSecret = await recover(sso.oidc.clientSecretEnc, 'SSO client secret');
    const { clientSecretEnc: _drop, ...oidcRest } = sso.oidc;
    nextSso = {
      ...nextSso,
      oidc: { ...oidcRest, ...(clientSecret ? { clientSecret } : {}) },
    };
    changed = true;
  }
  if (sso.federatedUnlockKeyEnc) {
    const federatedUnlockKey = await recover(sso.federatedUnlockKeyEnc, 'federated unlock key');
    const { federatedUnlockKeyEnc: _drop, ...rest } = nextSso;
    nextSso = { ...rest, ...(federatedUnlockKey ? { federatedUnlockKey } : {}) };
    changed = true;
  }
  if (sso.orgSignSecretEnc) {
    const orgSignSecret = await recover(sso.orgSignSecretEnc, 'org signing key');
    const { orgSignSecretEnc: _drop, ...rest } = nextSso;
    nextSso = { ...rest, ...(orgSignSecret ? { orgSignSecret } : {}) };
    changed = true;
  }
  return changed ? { ...settings, sso: nextSso } : settings;
}
