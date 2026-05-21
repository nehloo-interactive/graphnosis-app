import { promises as fs } from 'node:fs';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { embeddings, settings as settingsMod, sources, type SourceRecord } from '@graphnosis-app/core';
import { crypto, federation, oplog, policy, type DeviceId, type GraphId, type SubgraphBudget } from '@nehloo-interactive/graphnosis-secure-sync';
import type { GraphnosisAdapter, GraphHandle, AppendDocumentInput, CorrectionEdit } from './graphnosis-adapter.js';
import * as healingJournalMod from './healing-journal.js';
import * as connectionStoreMod from './connection-store.js';
import * as associationIndexMod from './association-index.js';
import * as gnnStoreMod from './gnn-store.js';

const { deriveKey, encrypt, decrypt } = crypto;
const { OpLogWriter } = oplog;
const { EmbeddingCache, cached, stubEmbed } = embeddings;
const { federatedQuery } = federation;
const { SourceIndex, makeSourceId, hashContent } = sources;

export interface HostOptions {
  cortexDir: string;
  deviceId: DeviceId;
  passphrase: string;
  adapter: GraphnosisAdapter;
  policy?: policy.PolicyConfig;
  embed?: embeddings.EmbedFn;
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

/**
 * Format of a cached content blob (before encryption). We prepend a small
 * JSON header so recovery knows how to re-ingest (parser kind, mime, original
 * ref). Layout: [u32 header-len, LE] [header JSON bytes] [raw content bytes].
 */
interface ContentCacheHeader {
  kind: 'file' | 'url' | 'ai-conversation' | 'clip';
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
  kind: 'file' | 'url' | 'ai-conversation' | 'clip';
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
  /**
   * Running count of user-initiated corrections per graph. Counts ONLY
   * `editNode` and `supersede` op-log events — these come exclusively from
   * the correction pipeline. Skips `deleteNode` because that op can also
   * come from forgetSource cascades, which would inflate the metric.
   * Populated from the op-log on loadGraph; bumped on applyCorrection.
   */
  private readonly correctionsCount = new Map<GraphId, number>();
  private readonly oplogWriter: oplog.OpLogWriter;
  private policyCfg: policy.PolicyConfig;
  private readonly embed: embeddings.EmbedFn;
  private readonly embedAdapterId: string;
  private readonly embedDimensions: number;
  private settings: settingsMod.AppSettings;
  /** Optional filesystem watcher — see SourceLifecycleListener. Null when
   *  the watcher feature isn't wired (smoke tests, headless tools). */
  private fileWatcher: SourceLifecycleListener | null = null;
  /** Settings-change listeners — fired AFTER persistence + in-memory swap
   *  so consumers (the file-watcher) always see the canonical new value. */
  private readonly settingsListeners = new Set<(s: settingsMod.AppSettings) => void>();

  private constructor(
    private readonly opts: HostOptions,
    derived: crypto.DerivedKey,
    settings: settingsMod.AppSettings,
  ) {
    this.key = derived.key;
    this.salt = derived.salt;
    this.oplogWriter = new OpLogWriter({
      dir: path.join(opts.cortexDir, 'oplog'),
      deviceId: opts.deviceId,
      key: this.key,
      salt: this.salt,
    });
    this.embed = opts.embed ?? stubEmbed;
    this.embedAdapterId = opts.embedAdapterId ?? 'graphnosis-app:stub@384';
    this.embedDimensions = opts.embedDimensions ?? 384;
    this.settings = settings;
    // Seed policy from settings-persisted tiers. Env-supplied policy entries win
    // (power-user / admin override path); settings fill in the rest.
    const base = opts.policy ?? { defaultBudget: policy.DEFAULT_BUDGET, graphs: [] };
    const envGraphIds = new Set(base.graphs.map((g) => g.graphId));
    const fromSettings: policy.GraphPolicy[] = Object.entries(settings.graphMetadata)
      .filter(([id, m]) => m.sensitivityTier && !envGraphIds.has(id))
      .map(([id, m]) => ({
        graphId: id,
        tier: m.sensitivityTier as policy.SensitivityTier,
        shareWithAi: m.sensitivityTier !== 'sensitive',
      }));
    this.policyCfg = { ...base, graphs: [...base.graphs, ...fromSettings] };
  }

  static async open(opts: HostOptions): Promise<OpenResult> {
    await fs.mkdir(opts.cortexDir, { recursive: true });
    const saltPath = path.join(opts.cortexDir, 'salt.bin');
    const masterEncPath = path.join(opts.cortexDir, 'master.enc');
    const recoveryEncPath = path.join(opts.cortexDir, 'recovery.enc');

    // ── Cortex unlock architecture ──────────────────────────────────────
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
      const wrap = await deriveKey(opts.passphrase, salt);
      derivedSalt = salt;

      // Check whether this cortex has been migrated to the master.enc model.
      let masterBlob: Uint8Array | null = null;
      try {
        masterBlob = new Uint8Array(await fs.readFile(masterEncPath));
      } catch {
        // master.enc absent → legacy cortex
      }

      if (masterBlob) {
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
    const decryptedSettings = await decryptConnectorCredentialsInSettings(settings, dataKey);
    const host = new GraphnosisHost(opts, derived, decryptedSettings);
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
   * Rewrap master.enc with a key derived from `newPassphrase`. The dataKey
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

  /**
   * Copy every engram's `.gai` file into `<cortexDir>/snapshots/<label>-<ts>/`
   * — the safety snapshot taken before the Graphnosis Neural Network is first
   * enabled, so the pre-neural-network graph state is preserved on disk.
   * Returns the snapshot directory path.
   */
  async snapshotGraphs(label: string): Promise<string> {
    const safe = `${label.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}`;
    const graphsDir = path.join(this.opts.cortexDir, 'graphs');
    const destDir = path.join(this.opts.cortexDir, 'snapshots', safe);
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
   * Set of currently-active node IDs for a graph. "Active" matches the
   * inspector's definition: confidence > 0.2 AND validUntil is unset or in
   * the future. Used to drop soft-deleted nodes from `recall` and `search`
   * results, which the SDK's hybrid query returns unconditionally.
   */
  private activeNodeIds(graphId: GraphId): Set<string> {
    const g = this.must(graphId);
    const nodes = this.opts.adapter.inspectNodes(g.handle);
    const now = Date.now();
    return new Set(
      nodes
        .filter((n) => n.confidence > 0.2 && (n.validUntil === undefined || n.validUntil > now))
        .map((n) => n.id),
    );
  }

  /** Inspect every node in a graph, including soft-deleted ones — used by the Nodes table when there's no active search. */
  listNodes(graphId: GraphId): ReturnType<GraphnosisAdapter['inspectNodes']> {
    const g = this.must(graphId);
    return this.opts.adapter.inspectNodes(g.handle);
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
        after: { confidence: newConfidence, reason: 'brain:reinforcement' },
      });
      g.dirty = true;
      await this.save(graphId);
    } catch (err) {
      console.error(`[brain] reinforceNode(${graphId}/${nodeId}) failed:`, err);
    }
  }

  // ── Graph metadata (template, displayName) ──────────────────────────────

  getGraphMetadata(graphId: GraphId): settingsMod.GraphMetadata | undefined {
    return this.settings.graphMetadata[graphId];
  }

  async setGraphMetadata(graphId: GraphId, metadata: settingsMod.GraphMetadata): Promise<void> {
    const next = {
      ...this.settings,
      graphMetadata: {
        ...this.settings.graphMetadata,
        [graphId]: metadata,
      },
    };
    await this.persistSettings(next);
  }

  /** Combined view: every loaded graph + its metadata (or sensible defaults). */
  graphsWithMetadata(): Array<{ graphId: GraphId; metadata: settingsMod.GraphMetadata }> {
    return this.listGraphs().map((graphId) => ({
      graphId,
      metadata: this.settings.graphMetadata[graphId] ?? {
        template: 'personal' as settingsMod.GraphTemplate,
        displayName: graphId,
        createdAt: 0,
      },
    }));
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

  async setGraphTier(graphId: GraphId, tier: 'public' | 'personal' | 'sensitive'): Promise<void> {
    const existing: settingsMod.GraphMetadata = this.settings.graphMetadata[graphId] ?? {
      template: 'personal' as settingsMod.GraphTemplate,
      displayName: graphId,
      createdAt: 0,
    };
    await this.setGraphMetadata(graphId, { ...existing, sensitivityTier: tier });
    // Patch the live policy so the change takes effect immediately without restart.
    const graphs = this.policyCfg.graphs.filter((g) => g.graphId !== graphId);
    graphs.push({ graphId, shareWithAi: tier !== 'sensitive', tier });
    this.policyCfg = { ...this.policyCfg, graphs };
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
    const { [graphId]: _removed, ...rest } = this.settings.graphMetadata;
    const next = { ...this.settings, graphMetadata: rest };
    await this.persistSettings(next);
  }

  /** Update settings, persist to <cortex>/settings.json, return the merged result. */
  async setSettings(partial: Partial<settingsMod.AppSettings>): Promise<settingsMod.AppSettings> {
    // Shallow merge per top-level key — keeps contentCache fully replaced if
    // the caller passes one, while leaving room for future top-level keys.
    const next: settingsMod.AppSettings = settingsMod.mergeWithDefaults({
      ...this.settings,
      ...partial,
    });
    await this.persistSettings(next);
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
    const onDiskNext = await encryptConnectorCredentialsInSettings(next, this.key);
    await settingsMod.saveSettings(this.opts.cortexDir, onDiskNext);
    this.settings = next;
  }

  /** Subscribe to settings updates. Returns an unsubscribe function.
   *  Fires after the new value is persisted and swapped in. */
  onSettingsChanged(handler: (s: settingsMod.AppSettings) => void): () => void {
    this.settingsListeners.add(handler);
    return () => this.settingsListeners.delete(handler);
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

  async createGraph(graphId: GraphId): Promise<void> {
    if (this.graphs.has(graphId)) throw new Error(`Graph ${graphId} already loaded`);
    const handle = await this.opts.adapter.create(graphId);
    const cache = new EmbeddingCache({ path: this.cachePath(graphId), key: this.key, salt: this.salt });
    this.graphs.set(graphId, {
      handle,
      sourceIndex: new SourceIndex(),
      cache,
      dirty: true,
    });
    this.correctionsCount.set(graphId, 0);
    await this.save(graphId);
  }

  async loadGraph(graphId: GraphId): Promise<void> {
    if (this.graphs.has(graphId)) return;
    // Recover from an interrupted purge before we try to read .gai. There
    // are two possible leftover states:
    //   .gai exists AND .gai.bak exists  → purge committed but didn't clean
    //                                      up; delete the stale .bak.
    //   .gai missing AND .gai.bak exists → purge crashed mid-rebuild;
    //                                      restore .bak → .gai so the user's
    //                                      data isn't lost.
    await this.recoverFromInterruptedPurge(graphId);
    // Prefer the canonical .gai path; fall back to the legacy .aikg path so
    // cortexes created before 0.2.6 keep loading. The next `save()` will write
    // the .gai file (and we can clean up the .aikg later if both exist).
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.graphPath(graphId));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
      bytes = await fs.readFile(this.legacyGraphPath(graphId));
      console.error(`[graphnosis-host] loaded legacy ${graphId}.aikg — will migrate to .gai on next save`);
    }
    const aikgPlain = await decrypt(new Uint8Array(bytes), this.key);
    // Inner SDK HMAC key (independent of outer encryption) — derived from data key + a fixed label.
    const hmacKey = this.key;
    let handle: GraphHandle;
    try {
      handle = await this.opts.adapter.loadFromBuffer(graphId, aikgPlain, hmacKey);
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
        const ts = Date.now();
        const quarantinedGai = `${this.graphPath(graphId)}.corrupt-${ts}`;
        const quarantinedBundle = `${this.bundlePath(graphId)}.corrupt-${ts}`;
        try { await fs.rename(this.graphPath(graphId), quarantinedGai); } catch { /* may not exist */ }
        try { await fs.rename(this.bundlePath(graphId), quarantinedBundle); } catch { /* may not exist */ }
        console.error(
          `[graphnosis-host] quarantined corrupt engram '${graphId}': ` +
          `${msg}. Files moved to ${path.basename(quarantinedGai)} and ${path.basename(quarantinedBundle)}. ` +
          `Run "Recover from op-log" to rebuild from sources.`,
        );
        const enoentErr = new Error(
          `engram '${graphId}' was corrupted (${msg}) and has been quarantined — ` +
          `use Recover from op-log to rebuild`,
        ) as NodeJS.ErrnoException;
        enoentErr.code = 'ENOENT';
        throw enoentErr;
      }
      throw e;
    }
    const sourceIndex = await this.loadBundle(graphId);

    // ── Cache load is best-effort ─────────────────────────────────────────
    // A corrupted/oversized embcache must NOT prevent the graph from being
    // listed. We've seen large graphs (20k+ nodes, 160MB+ embcache) silently
    // disappear from the picker when cache.load() threw — even though the
    // .gai itself was perfectly readable. Fall back to a fresh empty cache;
    // buildEmbeddings (below) will repopulate it.
    const cache = new EmbeddingCache({ path: this.cachePath(graphId), key: this.key, salt: this.salt });
    try {
      await cache.load();
    } catch (e) {
      console.error(
        `[graphnosis-host] embcache load failed for ${graphId}: ${(e as Error).message} ` +
        `— starting with a fresh empty cache (embeddings will rebuild from scratch).`,
      );
    }

    // Commit the graph to the in-memory map AS EARLY AS POSSIBLE so that
    // even if downstream work (corrections-count scan, embedding rebuild)
    // fails or hangs, the graph still appears in listGraphs() and the UI
    // picker. Anything after this point is enrichment, not gating.
    this.graphs.set(graphId, { handle, sourceIndex, cache, dirty: false });

    // Seed the corrections counter from the op-log so historical activity is
    // visible after a fresh unlock. One-time scan per graph load; subsequent
    // applyCorrection calls bump the counter in memory. Best-effort: a
    // corrupt op-log shouldn't hide the graph.
    try {
      this.correctionsCount.set(graphId, await this.countCorrectionsFromOplog(graphId));
    } catch (e) {
      console.error(
        `[graphnosis-host] corrections-count scan failed for ${graphId}: ${(e as Error).message}`,
      );
      this.correctionsCount.set(graphId, 0);
    }

    // SDK doesn't persist embeddings with .aikg — rebuild from cache (fast if warm,
    // re-embeds from scratch if cache is empty / model changed). Without this, queryHybrid
    // would have no index to consult and we'd silently fall back to TF-IDF.
    try {
      await this.opts.adapter.buildEmbeddings(handle, {
        embed: cached(this.embed, cache),
        dimensions: this.embedDimensions,
        id: this.embedAdapterId,
        batchSize: this.settings.ai.embedBatch,
      });
    } catch (e) {
      console.error(`[graphnosis-host] could not build embeddings on load for ${graphId}: ${(e as Error).message} — query will use TF-IDF only.`);
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

  async save(graphId: GraphId): Promise<void> {
    const g = this.must(graphId);
    if (!g.dirty) return;
    await fs.mkdir(path.dirname(this.graphPath(graphId)), { recursive: true });
    const buf = await this.opts.adapter.toBuffer(g.handle, this.key);
    const ct = await encrypt(buf, this.key, this.salt);
    // Atomic write: write to .tmp, fsync via writeFile flush, then rename.
    // POSIX rename is atomic — either the new file is fully there or the old
    // file is unchanged. A direct fs.writeFile() to the final path can leave
    // a half-written file if the process is killed mid-write (force-quit,
    // OS kill, crash). For a 20k-node engram that's 30+MB of ciphertext,
    // the write window is many seconds — wide enough that we've seen real
    // checksum-mismatch corruption in the wild (davinci-manual.gai, May 2026).
    await writeFileAtomic(this.graphPath(graphId), Buffer.from(ct));
    // Migrate legacy: if a .aikg file from a pre-0.2.6 cortex still exists
    // alongside the new .gai we just wrote, remove it now that we've
    // successfully persisted the canonical file.
    try { await fs.unlink(this.legacyGraphPath(graphId)); } catch { /* no legacy file */ }
    const bundleCt = await encrypt(
      new TextEncoder().encode(JSON.stringify(g.sourceIndex.toJSON())),
      this.key,
      this.salt,
    );
    await writeFileAtomic(this.bundlePath(graphId), Buffer.from(bundleCt));
    await g.cache.save();
    g.dirty = false;
    // Per-graph mutation tick — bumps every successful save. Doubles
    // as the cursor returned by `getMutationCursor()` for reconciliation
    // polls. Background auto-relink edges also flow through here, so
    // even silent mutations are observable.
    const ts = Date.now();
    this.lastMutationAt.set(graphId, ts);
    this.mutationEvents.emit('mutation', { graphId, ts } satisfies MutationEvent);
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

  async ingest(
    graphId: GraphId,
    kind: SourceRecord['kind'],
    ref: string,
    input: AppendDocumentInput,
    opts?: { addedBy?: string },
  ): Promise<SourceRecord> {
    const g = this.must(graphId);
    const sourceId = makeSourceId(kind, ref);
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

    this.oplogWriter.emit({
      graphId,
      op: 'ingestSource',
      target: { kind: 'source', id: sourceId },
      after: record,
    });
    for (const nodeId of result.newNodeIds) {
      this.oplogWriter.emit({
        graphId,
        op: 'addNode',
        target: { kind: 'node', id: nodeId },
        after: { sourceId },
      });
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

    await this.save(graphId);
    // Notify the optional file-watcher so it can start watching this
    // path for on-disk changes. No-op when no watcher is installed or
    // when the source isn't file-backed.
    this.fileWatcher?.onSourceIngested(graphId, sourceId, ref, kind);
    // Fire-and-forget cross-doc relink. New clip might mention entities
    // that already appear in older nodes — without this pass the SDK
    // leaves it orphan. Coalesced + throttled inside kickoffRelink so
    // back-to-back ingests don't spawn parallel passes.
    this.kickoffRelink(graphId);
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
    opts?: { addedBy?: string },
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

    this.oplogWriter.emit({
      graphId,
      op: 'ingestSource',
      target: { kind: 'source', id: sourceId },
      after: record,
    });
    for (const nodeId of allNodeIds) {
      this.oplogWriter.emit({
        graphId,
        op: 'addNode',
        target: { kind: 'node', id: nodeId },
        after: { sourceId },
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
  private relinkDebounce: Map<GraphId, ReturnType<typeof setTimeout>> = new Map();

  // Debounce delay before starting a relink pass. Resets on every new
  // ingest so back-to-back batch ingests only trigger one pass at the end.
  private static RELINK_DEBOUNCE_MS = 1500;

  private kickoffRelink(graphId: GraphId): void {
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
      console.error(`[host] auto-relink failed for ${graphId}: ${(e as Error).message}`);
    }).finally(() => {
      this.relinkInFlight.delete(graphId);
      if (this.relinkPending.delete(graphId)) {
        this.startRelinkPass(graphId);
      }
    });
    this.relinkInFlight.set(graphId, p);
  }

  private async runRelink(graphId: GraphId): Promise<void> {
    const g = this.graphs.get(graphId);
    if (!g) return; // engram unloaded mid-pass; nothing to do
    const maxNodes = this.settings.ai.autoRelinkMaxNodes;
    const result = await this.opts.adapter.relinkFullGraph(g.handle, { maxNodes });
    if (result.skipped) {
      // Log skip reasons at debug — useful when users wonder why their
      // big engram isn't getting auto-linked.
      console.error(
        `[host] auto-relink skipped for ${graphId}: ${result.skipReason} ` +
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
    console.error(
      `[host] auto-relink wove ${result.newEdges.length} edges across ${result.activeNodes} active nodes in ${graphId}`,
    );
  }

  async forgetSource(graphId: GraphId, sourceId: string): Promise<{ nodeIds: string[] }> {
    const g = this.must(graphId);
    // Grab the ref BEFORE the forget so we can notify the file-watcher.
    // sourceIndex.forget() removes the record; we'd otherwise lose the path.
    const priorRecord = g.sourceIndex.get(sourceId);
    const nodeIds = g.sourceIndex.forget(sourceId);
    for (const nodeId of nodeIds) {
      // Soft-delete in Graphnosis: node stays for audit, confidence drops, won't be returned by queries.
      await this.opts.adapter.applyCorrection(g.handle, { kind: 'delete', nodeId, reason: `forget source ${sourceId}` });
      this.oplogWriter.emit({
        graphId,
        op: 'deleteNode',
        target: { kind: 'node', id: nodeId },
        before: { sourceId },
      });
    }
    this.oplogWriter.emit({
      graphId,
      op: 'forgetSource',
      target: { kind: 'source', id: sourceId },
    });
    // Forget means forget everywhere — drop the cached content blob too.
    // If the user re-ingests later, we'll cache a fresh copy.
    await this.deleteContentBlob(sourceId);
    g.dirty = true;
    await this.save(graphId);

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
   * Move a source (and all its nodes) from one engram to another.
   *
   * For file-backed sources the original file is re-read from disk.
   * For cached non-file sources (clip, ai-conversation) the encrypted
   * content blob is decrypted here BEFORE the forget so it isn't deleted.
   * Throws if a non-file source has no cached content.
   */
  async moveSource(fromGraphId: GraphId, sourceId: string, toGraphId: GraphId): Promise<SourceRecord> {
    if (fromGraphId === toGraphId) throw new Error('Source and destination engram must be different.');
    const fromG = this.must(fromGraphId);
    this.must(toGraphId); // ensure destination exists

    const rec = fromG.sourceIndex.get(sourceId);
    if (!rec) throw new Error(`Source ${sourceId} not found in engram ${fromGraphId}.`);

    let newRecord: SourceRecord;

    if (rec.kind === 'file') {
      // File sources: re-read from disk into target, then forget from source.
      const { ingestFile } = await import('./ingest.js');
      const { withEmbedding } = await import('./embedding-queue.js');
      await this.forgetSource(fromGraphId, sourceId);
      newRecord = await ingestFile(this, toGraphId, rec.ref, {
        wrapIngest: (fn) => withEmbedding(fn),
      });
    } else {
      // Non-file sources (clip, ai-conversation): read encrypted blob first,
      // then forget (which deletes the blob), then ingest from memory.
      const blob = await this.readContentBlob(sourceId);
      if (!blob) {
        throw new Error(
          `Cannot move source ${sourceId} (${rec.kind}): no cached content available. ` +
          `Try forgetting and re-ingesting it instead.`,
        );
      }
      const { header, content } = blob;
      const input: AppendDocumentInput = {
        kind: header.docKind,
        content,
        sourceRef: header.ref,
      };
      await this.forgetSource(fromGraphId, sourceId);
      newRecord = await this.ingest(toGraphId, rec.kind, rec.ref, input);
    }

    this.kickoffRelink(toGraphId);
    return newRecord;
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

  async recall(query: string, opts?: { budget?: SubgraphBudget }): Promise<federation.FederatedSubgraph> {
    // Snapshot active-node IDs per graph BEFORE the federated query runs.
    // We use these to filter SDK results so soft-deleted (forgotten) nodes
    // never leak back into the AI's context. Without this, garbage
    // pre-forget content gets re-attached on recall — exactly the kind of
    // "ghost memory" symptom that breaks user trust in the system.
    const activeByGraph = new Map<GraphId, Set<string>>();
    for (const graphId of this.listGraphs()) {
      activeByGraph.set(graphId, this.activeNodeIds(graphId));
    }
    const runner: federation.FederatedQueryRunner = {
      runQuery: async (graphId, q, k) => {
        const g = this.must(graphId);
        const active = activeByGraph.get(graphId) ?? new Set<string>();
        // Same over-fetch as searchNodes — recover real top-k after dropping
        // forgotten matches without making the SDK call quadratic.
        const raw = await this.opts.adapter.query(g.handle, q, k * 3);
        return raw
          .filter((r) => active.has(r.nodeId))
          .slice(0, k)
          .map((r) => ({ graphId, nodeId: r.nodeId, score: r.score, text: r.text, ...(r.type !== undefined ? { type: r.type } : {}) }));
      },
    };
    const sub = await federatedQuery(runner, this.listGraphs(), query, this.policyCfg, opts?.budget);
    try {
      this.plasticityObserver?.(sub);
    } catch (err) {
      console.error(`[host] plasticity observer failed: ${(err as Error).message}`);
    }
    return sub;
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
    opts?: { correctedBy?: string },
  ): Promise<void> {
    const g = this.must(graphId);
    // Attribution: every op-log event emitted by this call carries the
    // `correctedBy` field when the correction was driven by an MCP client
    // (e.g. "claude-ai"). Lets the audit log show "Claude edited this
    // node" alongside the content/reason. The field is silently omitted
    // when the user applied the correction directly via the App UI.
    const attribution = opts?.correctedBy ? { correctedBy: opts.correctedBy } : {};
    const ingestOpts = { chunkSize: this.settings.ai.chunkSize };
    for (const add of patches.adds ?? []) {
      const result = await this.opts.adapter.appendDocument(g.handle, add, ingestOpts);
      for (const n of result.newNodeIds) {
        this.oplogWriter.emit({
          graphId,
          op: 'addNode',
          target: { kind: 'node', id: n },
          after: { ref: add.sourceRef, ...attribution },
        });
      }
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
      after: { confidence: newConfidence, reason: 'brain:temporal-decay' },
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
  private async countCorrectionsFromOplog(graphId: GraphId): Promise<number> {
    try {
      const events = await oplog.readAllEvents(
        path.join(this.opts.cortexDir, 'oplog'),
        this.key,
      );
      return events.filter(
        (e) => e.graphId === graphId && (e.op === 'editNode' || e.op === 'supersede'),
      ).length;
    } catch (e) {
      console.error(`[graphnosis-host] count corrections from op-log failed: ${(e as Error).message}`);
      return 0;
    }
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
  async listOplogEvents(): Promise<Awaited<ReturnType<typeof oplog.readAllEvents>>> {
    return oplog.readAllEvents(path.join(this.opts.cortexDir, 'oplog'), this.key);
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
    const events = await oplog.readAllEvents(path.join(this.opts.cortexDir, 'oplog'), this.key);
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
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const fh = await fs.open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
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
