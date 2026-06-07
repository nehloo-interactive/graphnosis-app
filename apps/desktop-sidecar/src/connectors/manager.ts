import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import type { GraphnosisHost } from '../host.js';
import { ingestClip } from '../ingest.js';
import { withEmbedding } from '../embedding-queue.js';
import { markClientActivity, beginIngest, endIngest } from '../client-activity.js';
import type { ConnectorConfig, ConnectorSettings } from '@graphnosis-app/core';
import type { Connector, ConnectorEvent, ConnectorStatus } from './interface.js';
import { isConnectorKindDisabled } from '../admin-policy.js';
import { WebhookConnector } from './webhook.js';
import { RssConnector } from './rss.js';
import { GitHubConnector } from './github.js';
import { SlackConnector } from './slack.js';
import { TrelloConnector } from './trello.js';
import { LinearConnector } from './linear.js';
import { ObsidianConnector } from './obsidian.js';
import { GBrainConnector } from './gbrain.js';
import { AiContextConnector } from './ai-context.js';

interface RunningConnector {
  connector: Connector;
  pullTimer: ReturnType<typeof setInterval> | null;
  eventsTotal: number;
  pulling: boolean;
  /** Last time this pull made forward progress (a file ingested, or the pull
   *  started). The watchdog uses it to tell a slow-but-advancing ingest from a
   *  genuinely wedged one — so it never false-fires on a legit large vault. */
  lastProgressAt: number;
  /** User hit "Stop": abort the in-flight drain at the next file/batch boundary. */
  stopRequested: boolean;
  /** User paused this connector — auto-poll/watch pulls are gated off until a
   *  manual triggerPull/resync resumes it. Runtime-only (resets on restart). */
  paused: boolean;
  /** Active filesystem watchers (one per watched path) for live ingest. */
  watchers: FSWatcher[];
  /** Debounce timer coalescing a burst of file-change events into one pull. */
  watchDebounce: ReturnType<typeof setTimeout> | null;
  /** Last time a FULL (cursor-ignoring) re-scan ran. The auto-poll/watch paths
   *  are incremental for speed, but periodically promote to a full re-scan so a
   *  file that was skipped / produced 0 nodes / crashed mid-run in a previous
   *  pass is ALWAYS eventually re-checked — no source is permanently stranded
   *  behind the cursor without any manual action. Init 0 → the first pull after
   *  boot is a full self-heal sweep. */
  lastFullScanAt: number;
}

/** Per-batch ceiling when draining a backlog. High enough that a normal vault
 *  ingests in one pass (cursor → now, no edge cases); the cursor-advancing
 *  drain loop only engages for pathologically large folders. */
const BASE_PULL_LIMIT = 2000;
const MAX_PULL_LIMIT = 20000;
const MAX_DRAIN_ITERS = 50;
// Incremental flush cadence inside a batch: persist + release every N ingested
// files so a large vault doesn't accumulate the whole batch in memory before a
// single save, and so progress survives a stall/quit. Balances durability vs
// avoiding the O(n²) per-file full-save storm.
// 20 (was 50): now that embcache saves are compact binary (no JSON churn), more
// frequent checkpoints are cheap — so an interrupted sync persists progress
// sooner (a stall at file 36 used to lose everything when the checkpoint was 50).
const CONNECTOR_SAVE_CHECKPOINT = 20;
// Watchdog: if a pull has been "in flight" with ZERO forward progress for this
// long, it has wedged (e.g. on a crashed embed worker) and would otherwise pin
// `pulling=true` forever, killing the connector permanently. We abandon the
// dangling pull and let the next poll retry. Generous, and progress-gated, so a
// legitimately slow large-vault ingest (which keeps advancing) never trips it.
const PULL_STALL_WATCHDOG_MS = 5 * 60_000;
/** Quiet window after the last file-change event before a watcher pulls. */
const WATCH_DEBOUNCE_MS = 1500;
// Self-heal cadence: an auto-poll/watch pull is incremental (cursor-based) for
// speed, but is promoted to a FULL re-scan if this long has passed since the
// last full one. Guarantees that a source skipped / 0-noded / crashed in a prior
// pass is ALWAYS eventually re-checked WITHOUT any manual action — no file is
// permanently stranded behind the cursor. Cheap on a warm cortex (re-scanned
// files hit the .embcache + dedup as no-ops; only genuinely-missing ones land).
const FULL_RESCAN_INTERVAL_MS = 30 * 60_000; // 30 min

export class ConnectorManager {
  private running = new Map<string, RunningConnector>();
  private webhookServer: http.Server | null = null;
  private settings: ConnectorSettings;

  constructor(
    private readonly host: GraphnosisHost,
    settings: ConnectorSettings,
    /** Emit a frontend event frame (kind → graphnosis://<kind>). Used to push
     *  per-source ingest progress so the 3D graph shows a progress bar during a
     *  connector pull (the drag-drop path emits these from Rust; connectors had
     *  no equivalent, so the bar never appeared for syncs). Optional/no-op-safe. */
    private readonly broadcast?: (frame: { kind: string; name: string; payload: unknown }) => void,
  ) {
    this.settings = settings;
  }

  /** Boot all enabled connectors and start the webhook HTTP server if needed. */
  async start(): Promise<void> {
    for (const cfg of this.settings.configs) {
      if (cfg.enabled) {
        this.mountConnector(cfg);
      }
    }
    await this.startWebhookServerIfNeeded();
  }

  /** Clean up all timers, watchers, and close the webhook server. */
  async stop(): Promise<void> {
    for (const rc of this.running.values()) {
      if (rc.pullTimer) clearInterval(rc.pullTimer);
      this.stopWatchers(rc);
    }
    this.running.clear();
    if (this.webhookServer) {
      await new Promise<void>((resolve) => this.webhookServer!.close(() => resolve()));
      this.webhookServer = null;
    }
  }

  /** Re-apply the admin/IT policy live: stop any running connector whose kind
   *  is now disabled, and (re)mount enabled connectors whose kind is now
   *  allowed. Called after the policy changes so blocked data flows stop
   *  immediately instead of waiting for the next sidecar boot. */
  reapplyPolicy(): void {
    // Stop running connectors that are now blocked.
    for (const [id, rc] of [...this.running.entries()]) {
      const kind = this.settings.configs.find((c) => c.id === id)?.kind;
      if (kind && isConnectorKindDisabled(kind)) {
        if (rc.pullTimer) clearInterval(rc.pullTimer);
        this.stopWatchers(rc);
        this.running.delete(id);
        console.error(`[connector:${id}] stopped — kind '${kind}' disabled by policy.`);
      }
    }
    // Mount enabled connectors that are now allowed but not running.
    for (const cfg of this.settings.configs) {
      if (cfg.enabled && !this.running.has(cfg.id) && !isConnectorKindDisabled(cfg.kind)) {
        this.mountConnector(cfg);
      }
    }
  }

  // ── IPC-facing methods ────────────────────────────────────────────────────

  /** List all connector configs with their current runtime statuses. */
  list(): { configs: ConnectorConfig[]; statuses: ConnectorStatus[]; pullIntervalMs: number } {
    const configs = this.settings.configs;
    const statuses: ConnectorStatus[] = configs.map(cfg => {
      const rc = this.running.get(cfg.id);
      // Conditional spread so we never set an explicit `undefined` on
      // optional fields — required under exactOptionalPropertyTypes.
      return {
        id: cfg.id,
        kind: cfg.kind,
        enabled: cfg.enabled,
        ...(cfg.lastPulledAt !== undefined ? { lastPulledAt: cfg.lastPulledAt } : {}),
        ...(cfg.lastError !== undefined ? { lastError: cfg.lastError } : {}),
        eventsTotal: rc?.eventsTotal ?? 0,
        pulling: rc?.pulling ?? false,
        paused: rc?.paused ?? false,
      };
    });
    return { configs, statuses, pullIntervalMs: this.settings.pullIntervalMs };
  }

  /** Install or update a connector. Auto-generates missing required options. */
  async install(partial: Partial<ConnectorConfig> & { kind: ConnectorConfig['kind'] }): Promise<ConnectorConfig> {
    const existing = this.settings.configs.find(c => c.id === partial.id);
    const id = partial.id ?? existing?.id ?? slugify(partial.kind);
    const cfg: ConnectorConfig = {
      id,
      kind: partial.kind,
      graphId: partial.graphId ?? this.host.listGraphs()[0] ?? 'personal',
      enabled: partial.enabled ?? true,
      credentials: { ...(existing?.credentials ?? {}), ...(partial.credentials ?? {}) },
      options: { ...(existing?.options ?? {}), ...(partial.options ?? {}) },
      // Conditional spread to preserve absent-vs-undefined distinction
      // required under exactOptionalPropertyTypes.
      ...(existing?.lastPulledAt !== undefined ? { lastPulledAt: existing.lastPulledAt } : {}),
      ...(existing?.lastError !== undefined ? { lastError: existing.lastError } : {}),
    };

    // Webhook connectors need a per-connector token for the URL path.
    if (cfg.kind === 'webhook' && !cfg.options['webhookToken']) {
      cfg.options['webhookToken'] = randomUUID();
    }

    const newConfigs = existing
      ? this.settings.configs.map(c => c.id === id ? cfg : c)
      : [...this.settings.configs, cfg];
    await this.persistConfigs(newConfigs);

    // Mount or remount the connector if enabled.
    const rc = this.running.get(id);
    if (rc) { if (rc.pullTimer) clearInterval(rc.pullTimer); this.stopWatchers(rc); this.running.delete(id); }
    if (cfg.enabled) this.mountConnector(cfg);

    // Restart webhook server when a new webhook connector is added.
    await this.startWebhookServerIfNeeded();

    return cfg;
  }

  /** Remove a connector. */
  async remove(id: string): Promise<void> {
    const rc = this.running.get(id);
    if (rc) { if (rc.pullTimer) clearInterval(rc.pullTimer); this.stopWatchers(rc); }
    this.running.delete(id);
    const newConfigs = this.settings.configs.filter(c => c.id !== id);
    await this.persistConfigs(newConfigs);
  }

  /** Remove every connector that feeds the given engram. Called when the engram
   *  is deleted so no connector is left dangling, auto-polling into a graph that
   *  no longer exists. Returns the connector ids that were removed. */
  async removeForGraph(graphId: string): Promise<string[]> {
    const ids = this.settings.configs.filter(c => c.graphId === graphId).map(c => c.id);
    for (const id of ids) {
      this.stopPull(id); // request abort of any in-flight pull
      // stopPull only SETS the abort flag — the in-flight pull (possibly mid
      // embed) keeps running until it hits the next file boundary. WAIT for it
      // to actually idle before we delete the engram, or deleteGraph runs
      // concurrently with a live ingest → the contention/stall + re-created
      // files we keep hitting. Bounded so a wedged embed can't hang the delete.
      await this.waitForPullIdle(id, 5_000);
      try { await this.remove(id); }
      catch (e) { console.error(`[connectors] failed to remove '${id}' feeding deleted engram '${graphId}': ${(e as Error).message}`); }
    }
    if (ids.length > 0) console.error(`[connectors] removed ${ids.length} connector(s) feeding deleted engram '${graphId}'`);
    return ids;
  }

  /** Wait (up to timeoutMs) for a connector's in-flight pull to finish, so a
   *  caller (e.g. engram delete) can proceed without racing a live ingest.
   *  Returns early once idle; gives up after the timeout (a wedged embed). */
  private async waitForPullIdle(id: string, timeoutMs: number): Promise<void> {
    const rc = this.running.get(id);
    if (!rc) return;
    const deadline = Date.now() + timeoutMs;
    while (rc.pulling && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    if (rc.pulling) console.error(`[connector:${id}] still pulling after ${timeoutMs}ms — proceeding with removal anyway (pull will abort on next boundary).`);
  }

  /** Re-sync from scratch: reset the pull cursor to 0 (so the next pull treats
   *  `since` as undefined → full re-scan) and pull immediately. Already-ingested
   *  sources dedup-skip; anything missing (e.g. files stranded behind the cursor
   *  by an earlier failed pull) is picked up. Push-only connectors (webhook)
   *  have nothing to re-sync. */
  async resync(id: string): Promise<{ eventsIngested: number }> {
    const cfg = this.settings.configs.find(c => c.id === id);
    if (!cfg) throw new Error(`Connector '${id}' not found`);
    const rc = this.running.get(id);
    if (!rc) throw new Error(`Connector '${id}' is not running (disabled or not started)`);
    if (!rc.connector.pull) throw new Error(`Connector '${id}' (${cfg.kind}) is push-only — nothing to re-sync`);
    rc.paused = false; rc.stopRequested = false; // a manual re-sync resumes a stopped connector
    await this.setCursor(cfg, 0); // 0 is falsy → doPull passes since=undefined → full re-scan
    const count = await this.doPull(cfg, rc);
    return { eventsIngested: count };
  }

  /** Stop an in-progress ingest and pause this connector. The active drain
   *  aborts at the next file/batch boundary; the poll timer + watchers stay
   *  alive but are gated off by `paused` until a manual triggerPull/resync
   *  resumes it. The user's escape hatch for a slow or wedged ingest. */
  stopPull(id: string): void {
    const rc = this.running.get(id);
    if (!rc) return;
    rc.paused = true;
    rc.stopRequested = true; // abort the active drain at the next boundary
  }

  /** Manually trigger a pull for a specific connector. Returns ingested event count. */
  async triggerPull(id: string): Promise<{ eventsIngested: number }> {
    const cfg = this.settings.configs.find(c => c.id === id);
    if (!cfg) throw new Error(`Connector '${id}' not found`);
    const rc = this.running.get(id);
    if (!rc) throw new Error(`Connector '${id}' is not running (disabled or not started)`);
    if (!rc.connector.pull) throw new Error(`Connector '${id}' (${cfg.kind}) is push-only (no pull method)`);
    rc.paused = false; rc.stopRequested = false; // a manual pull resumes a stopped connector
    // Manual "Sync now" = FULL re-scan (ignore the incremental cursor). The
    // cursor is strict-newer-than, so any file that was skipped or failed in an
    // earlier pass (mtime now <= cursor) is never revisited by an incremental
    // pull — that's how a vault ends up stuck at 71/95. A full re-scan re-checks
    // every file; already-ingested ones are cheap (embeddings hit the .embcache,
    // and the SDK no-ops identical content), only the missing ones actually land.
    // (Auto/background pulls stay incremental — only this manual path forces full.)
    const count = await this.doPull(cfg, rc, { forceFull: true });
    return { eventsIngested: count };
  }

  /** Get the OAuth authorization URL for a connector. */
  getAuthUrl(id: string): { url: string; note?: string } {
    const cfg = this.settings.configs.find(c => c.id === id);
    if (!cfg) throw new Error(`Connector '${id}' not found`);
    const connector = buildConnector(cfg);
    if (!connector.getAuthUrl) {
      throw new Error(`Connector '${id}' (${cfg.kind}) does not use OAuth`);
    }
    const callbackUrl = `http://${this.settings.webhookHost === '0.0.0.0' ? 'localhost' : this.settings.webhookHost}:${this.settings.webhookPort}/oauth/${id}/callback`;
    const url = connector.getAuthUrl(callbackUrl);
    const note = cfg.kind === 'trello'
      ? 'Trello will show you the token on the page — copy it and update credentials.token in connector settings.'
      : `After approving, Graphnosis will capture the token automatically via the callback at ${callbackUrl}`;
    return { url, note };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private mountConnector(cfg: ConnectorConfig): void {
    // Admin/IT policy: a disabled connector KIND never mounts (enforced here in
    // the sidecar, the single choke point — the UI can't be trusted to gate).
    if (isConnectorKindDisabled(cfg.kind)) {
      // Expected operational state, not an error — log at .log so the entry-point
      // noise filter (see index.ts) suppresses it unless GRAPHNOSIS_DEBUG is set.
      console.log(`[connector:${cfg.id}] skipping mount — connector kind '${cfg.kind}' is disabled by policy.`);
      return;
    }
    // Skip connectors whose target engram has been archived. An archived
    // engram is hidden from the picker and should receive no new data —
    // running the connector against it can cause write-race quarantine loops
    // (the connector writes concurrently with op-log recovery, producing a
    // new corrupt .gai that gets quarantined again on the next boot).
    const targetMeta = this.host.getSettings().graphMetadata[cfg.graphId];
    if (targetMeta?.archived) {
      // Expected operational state, not an error — log at .log so the entry-point
      // noise filter (see index.ts) suppresses it unless GRAPHNOSIS_DEBUG is set.
      console.log(
        `[connector:${cfg.id}] skipping mount — target engram '${cfg.graphId}' is archived.` +
        ` Unarchive the engram in Settings to re-enable this connector.`,
      );
      return;
    }

    const connector = buildConnector(cfg);
    const hasPull = typeof connector.pull === 'function';
    // Manual mode: when `autoSync` is explicitly false the connector mounts but
    // stays DORMANT — no poll timer, no file watch, no initial pull. It ingests
    // only on an explicit Pull now / Re-sync. Lets the user set the stage (turn
    // on Presentation Mode, select the engram) before kicking off a recorded
    // demo of the import. Default true = ingest automatically, as before.
    const autoSync = cfg.options['autoSync'] !== false;
    const pullTimer = (hasPull && autoSync)
      ? setInterval(() => {
          void this.doPull(cfg, rc).catch(err => {
            console.error(`[connector:${cfg.id}] scheduled pull failed: ${(err as Error).message}`);
          });
        }, this.intervalForCfg(cfg)).unref()
      : null;

    const rc: RunningConnector = { connector, pullTimer, eventsTotal: 0, pulling: false, lastProgressAt: 0, stopRequested: false, paused: false, watchers: [], watchDebounce: null, lastFullScanAt: 0 };
    this.running.set(cfg.id, rc);

    // Start filesystem watchers for live ingest (local-file connectors).
    if (hasPull && autoSync && typeof connector.watchPaths === 'function') {
      this.startWatchers(cfg, rc, connector.watchPaths());
    }

    // Run an immediate pull on mount so the engram is populated right away.
    if (hasPull && autoSync) {
      void this.doPull(cfg, rc).catch(err => {
        console.error(`[connector:${cfg.id}] initial pull failed: ${(err as Error).message}`);
      });
    }
  }

  /**
   * Start a debounced recursive filesystem watcher per path. A burst of file
   * changes (e.g. dropping a folder) coalesces into a single pull after a
   * quiet window. Recursive `fs.watch` is supported on macOS/Windows and
   * recent Node/Bun on Linux; if the platform rejects it we log once and fall
   * back to the poll timer (still correct, just not instant).
   */
  private startWatchers(cfg: ConnectorConfig, rc: RunningConnector, paths: string[]): void {
    for (const p of paths) {
      try {
        const w = fsWatch(p, { recursive: true, persistent: false }, () => {
          // Debounce: reset the timer on every change; pull once it goes quiet.
          if (rc.watchDebounce) clearTimeout(rc.watchDebounce);
          rc.watchDebounce = setTimeout(() => {
            rc.watchDebounce = null;
            void this.doPull(cfg, rc).catch(err => {
              console.error(`[connector:${cfg.id}] watch-triggered pull failed: ${(err as Error).message}`);
            });
          }, WATCH_DEBOUNCE_MS);
        });
        w.on('error', (err) => {
          console.error(`[connector:${cfg.id}] watcher error on ${p}: ${err.message} — falling back to polling.`);
        });
        rc.watchers.push(w);
      } catch (err) {
        console.error(
          `[connector:${cfg.id}] could not watch ${p}: ${(err as Error).message} — ` +
          `relying on the ${Math.round(this.settings.pullIntervalMs / 60000)}-min poll instead.`,
        );
      }
    }
  }

  /** Tear down a connector's watchers + pending debounce. */
  private stopWatchers(rc: RunningConnector): void {
    if (rc.watchDebounce) { clearTimeout(rc.watchDebounce); rc.watchDebounce = null; }
    for (const w of rc.watchers) { try { w.close(); } catch { /* already closed */ } }
    rc.watchers = [];
  }

  /**
   * Pull and ingest, draining a backlog in cursor-advancing batches. Each batch
   * is capped at BASE_PULL_LIMIT so a huge folder can't be loaded into memory
   * all at once; the cursor advances by the newest file actually ingested so
   * the tail is never silently dropped (the old bug: cursor jumped to `now`,
   * stranding files beyond the cap). Yields to the event loop between batches
   * so the sidecar keeps servicing UI IPC during a large ingest. (Embeddings
   * already run in a worker thread; only the op-log/graph write is on the main
   * thread, and it is single-writer by design.)
   */
  private async doPull(cfg: ConnectorConfig, rc: RunningConnector, opts?: { forceFull?: boolean }): Promise<number> {
    if (rc.paused) return 0;  // user stopped this connector; auto-poll/watch pulls no-op
    if (rc.pulling) {
      // A pull is "in flight". If it's still making progress (or just started),
      // don't overlap — return. But if it's been wedged with zero progress past
      // the watchdog window, the previous pull hung (likely a crashed embed
      // worker); abandon it so this poll can recover instead of dying forever.
      if (Date.now() - rc.lastProgressAt < PULL_STALL_WATCHDOG_MS) return 0;
      console.error(`[connector:${cfg.id}] pull wedged with no progress for >${Math.round(PULL_STALL_WATCHDOG_MS / 60_000)}min — abandoning the stuck pull and retrying.`);
    }
    // Decide if THIS pull is a full re-scan. Either the caller forced it (manual
    // "Pull now" / "Re-sync"), OR it's been long enough since the last full one
    // that the periodic self-heal sweep is due (so auto-poll/watch eventually
    // re-check every file with no manual action). A full re-scan resets the
    // cursor ONCE here so the batch loop re-scans from time 0 and paginates
    // forward normally (resetting inside the loop would re-pull batch 1 forever);
    // the loop re-advances the cursor to the newest mtime by the end, so the next
    // incremental pull resumes from there.
    const fullRescan = (opts?.forceFull ?? false)
      || (Date.now() - rc.lastFullScanAt > this.fullRescanIntervalMs(cfg));
    if (fullRescan) {
      cfg.lastPulledAt = 0; // 0 is falsy → since=undefined → full scan
      rc.lastFullScanAt = Date.now();
      console.error(`[connector:${cfg.id}] full re-scan (${opts?.forceFull ? 'manual' : 'periodic self-heal'}) — re-checking all sources`);
    }
    rc.pulling = true;
    rc.lastProgressAt = Date.now();
    // Heartbeat: keep the brain's heavy background passes DEFERRED for the ENTIRE
    // pull, not just per ingested file. A slow/wedged embed opens a gap longer
    // than CLIENT_QUIET_MS between files; without this the brain wakes mid-pull
    // and runs its cross-engram pass — which loads EVERY engram's embeddings into
    // an LSH pool. On a large resident cortex that memory spike tips the embed
    // worker into swap and the pull stalls for good (observed: the wedge). The
    // timer marks activity so clientActiveWithin() stays true across slow embeds.
    const heartbeat = setInterval(() => markClientActivity(), 5_000);
    // Explicit ingest gate (belt-and-suspenders to the heartbeat above): every
    // background pass checks isIngestActive()/isGraphIngesting() and stands down
    // for the WHOLE pull, regardless of heartbeat timing. Paired with endIngest()
    // in the finally so it's always released, even on error.
    beginIngest(cfg.graphId);
    let total = 0;
    try {
      // Ensure the target engram is actually LOADED before pulling. A connector
      // can point at an engram that exists on disk but isn't in memory (not yet
      // lazy-loaded, evicted, or a "Create engram" that didn't finish loading).
      // Without this, every file's ingest throws "Graph not loaded" and the
      // whole vault fails one noisy line at a time.
      if (!this.host.listGraphs().includes(cfg.graphId)) {
        try {
          await this.host.loadGraph(cfg.graphId);
        } catch (e) {
          console.error(`[connector:${cfg.id}] target engram '${cfg.graphId}' is unavailable (${(e as Error).message}); skipping pull until it loads.`);
          return 0;
        }
        if (!this.host.listGraphs().includes(cfg.graphId)) {
          console.error(`[connector:${cfg.id}] target engram '${cfg.graphId}' does not exist — skipping pull. Re-create the engram or remove this connector.`);
          return 0;
        }
      }
      let limit = BASE_PULL_LIMIT;
      for (let iter = 0; iter < MAX_DRAIN_ITERS; iter++) {
        if (rc.stopRequested) { console.error(`[connector:${cfg.id}] stopped by user — halting drain.`); break; }
        const since = cfg.lastPulledAt ? new Date(cfg.lastPulledAt) : undefined;
        const events = await rc.connector.pull!(since, limit);
        if (events.length === 0) break;

        const { count, transientFailures } = await this.ingestEvents(cfg, events, rc);
        total += count;
        rc.eventsTotal += count;

        // CRITICAL: never advance the cursor over files that FAILED to ingest
        // (e.g. a transient sidecar/graph error, or the engram momentarily
        // unloaded). The old code set the cursor to `now` whenever a batch was
        // under-full, regardless of success — so an all-fail run stranded the
        // entire vault behind the cursor ("ingest stopped midway, most files
        // missing"). Leave the cursor put and stop; the next poll retries the
        // same window and already-ingested files dedup-skip.
        if (transientFailures > 0) {
          console.error(`[connector:${cfg.id}] ${transientFailures} file(s) failed this batch — leaving cursor for retry on the next poll.`);
          break;
        }

        // Feed/API connectors don't carry file mtimes — one logical pull,
        // advance the cursor to now (legacy behavior) and stop.
        const fileBacked = events.some(e => typeof e.mtimeMs === 'number');
        if (!fileBacked) {
          await this.setCursor(cfg, Date.now());
          break;
        }

        // Not capped → we drained everything matched up to now.
        if (events.length < limit) {
          await this.setCursor(cfg, Date.now());
          break;
        }

        // Capped: advance the cursor to the newest file we ingested so the next
        // batch is the next-oldest slice (no overlap, no loss).
        const maxMtime = events.reduce((m, e) => (e.mtimeMs && e.mtimeMs > m ? e.mtimeMs : m), 0);
        const prev = cfg.lastPulledAt ?? 0;
        if (maxMtime > prev) {
          await this.setCursor(cfg, maxMtime);
          limit = BASE_PULL_LIMIT; // progress made — reset the batch size
        } else if (limit < MAX_PULL_LIMIT) {
          // A full batch shares one mtime at the boundary; advancing would strand
          // its tied tail. Widen the window so they all arrive in one batch.
          limit = Math.min(limit * 2, MAX_PULL_LIMIT);
        } else {
          // Pathological: >MAX_PULL_LIMIT files share a single timestamp.
          // Advance anyway to avoid an infinite loop; a manual re-pull recovers
          // any stragglers once their mtimes differ.
          console.error(`[connector:${cfg.id}] >${MAX_PULL_LIMIT} files share one timestamp; advancing cursor.`);
          await this.setCursor(cfg, Date.now());
          break;
        }

        // Yield so UI IPC stays responsive between batches.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      // Mirror mode (opt-in): prune sources whose files were deleted on disk.
      await this.pruneMirroredDeletes(cfg, rc);
      await this.updateConnectorState(cfg.id, { lastError: undefined });
      return total;
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[connector:${cfg.id}] pull error: ${msg}`);
      await this.updateConnectorState(cfg.id, { lastError: msg });
      return total;
    } finally {
      clearInterval(heartbeat);
      endIngest(cfg.graphId); // release the background-pass gate (always, even on error)
      rc.pulling = false;
    }
  }

  /** Persist a new pull cursor in memory + settings. */
  private async setCursor(cfg: ConnectorConfig, lastPulledAt: number): Promise<void> {
    cfg.lastPulledAt = lastPulledAt;
    await this.updateConnectorState(cfg.id, { lastPulledAt });
  }

  private async ingestEvents(cfg: ConnectorConfig, events: ConnectorEvent[], rc: RunningConnector): Promise<{ count: number; transientFailures: number }> {
    if (events.length === 0) return { count: 0, transientFailures: 0 };
    // DIAGNOSTIC: batch size — emits one ingest.progress per file below, so if
    // this prints N>0 the progress bar should appear. Pair with the batch-done
    // line + the per-file "ingest failed" lines to see why files go missing.
    console.error(`[connector:${cfg.id}] ingestEvents: batch of ${events.length} file(s)`);
    const mirror = cfg.options['mirrorDeletes'] === true;
    let count = 0;
    let transientFailures = 0;
    let sinceYield = 0;
    let sinceCheckpoint = 0;
    let processed = 0;
    for (const ev of events) {
      // User hit Stop — flush what we've saved (the tail save below) and bail.
      if (rc.stopRequested) break;
      // Signal activity so the brain's backpressure DEFERS its heavy passes
      // (duplicate scan, etc.) while this connector ingest runs — otherwise the
      // brain fights the ingest for the single thread and the ingest stalls.
      markClientActivity();
      // On-graph progress bar: announce the file as we START it. (Emitting only
      // AFTER a file completes meant a multi-minute big file, or a re-scan that
      // no-ops every already-ingested file, showed NOTHING.) processed/total so
      // the bar appears immediately and tracks the current file. Best-effort.
      processed++;
      try {
        this.broadcast?.({
          kind: 'ingest.progress', name: 'ingest.progress',
          payload: {
            jobId: `connector:${cfg.id}`, graphId: cfg.graphId,
            fileName: ev.label ?? ev.sourceRef ?? 'source', phase: 'embedding',
            chunksDone: processed, chunksTotal: events.length,
          },
        });
      } catch { /* cosmetic */ }
      // Cooperative yield: with MANY SMALL files, each ingest's await often
      // resolves on the microtask queue (cached/cheap embeddings + a synchronous
      // op-log write), so the macrotask queue — where the IPC socket is serviced
      // — never runs and the UI freezes mid-batch. A setImmediate every few
      // files hands the event loop back so IPC stays responsive. (doPull only
      // yields between BATCHES, which isn't enough inside one large batch.)
      if (++sinceYield >= 4) { sinceYield = 0; await new Promise<void>((r) => setImmediate(r)); }
      try {
        const rec = await withEmbedding(() =>
          ingestClip(this.host, cfg.graphId, ev.text, ev.label, {
            addedBy: `connector:${cfg.kind}`,
            sourceKind: ev.sourceKind ?? 'clip',
            triggeredBy: `connector:${cfg.kind}`,
            // Defer the per-file full-engram save + relink — both run ONCE at the
            // end of this batch (below). Without this, a vault ingest fires a full
            // toBuffer+encrypt per file (O(n²)), pegging the sidecar into the
            // post-ingest GC stalls that dropped the IPC connection.
            skipSave: true,
            skipAutoRelink: true,
          }),
        );
        // Mirror mode: track file → source so we can prune on delete, and
        // replace (not duplicate) when a file is modified and re-ingested.
        if (mirror && ev.sourceRef && rec?.sourceId) {
          const prev = await this.host.connectorFileMap.get(ev.sourceRef);
          if (prev && prev !== rec.sourceId) {
            try { await this.host.forgetSource(cfg.graphId, prev, { triggeredBy: 'connector:mirror-replace' }); }
            catch { /* old source already gone — fine */ }
          }
          await this.host.connectorFileMap.set(ev.sourceRef, rec.sourceId);
        }
        count++;
        rc.lastProgressAt = Date.now(); // forward progress — keeps the watchdog from tripping
        // (Per-file progress is broadcast at the TOP of the loop, before ingest,
        // so it appears immediately for big/no-op files. Dotted kind required:
        // the Rust forwarder allowlists dotted kinds + rewrites '.'→'-'.)
        // Incremental checkpoint flush — persist + release every N files so a
        // big batch doesn't ingest entirely in memory before a single save, and
        // so progress is durable if the pull stalls or the app quits mid-vault.
        if (++sinceCheckpoint >= CONNECTOR_SAVE_CHECKPOINT) {
          sinceCheckpoint = 0;
          try { await this.host.save(cfg.graphId); }
          catch (e) { console.error(`[connector:${cfg.id}] checkpoint save failed: ${(e as Error).message}`); }
        }
      } catch (err) {
        const msg = (err as Error).message;
        // Re-scanning an unchanged vault re-emits every file; ingest then
        // produces 0 new nodes ("already saved or nothing to extract") — a
        // benign no-op, not a failure. Don't spam one error per file; only
        // surface genuine failures (and count them so doPull doesn't advance
        // the cursor past files that didn't actually get in).
        if (/produced 0 nodes|already saved or nothing to extract/i.test(msg)) {
          // DIAGNOSTIC: which files no-op, and why. A genuinely-new file should
          // NOT land here — if it does, either it's empty/unparseable ("0 nodes")
          // or the dedup is wrongly treating it as already-present ("already
          // saved"). This is how we tell why the vault stalls below its file count.
          console.error(`[connector:${cfg.id}] no-op skip ${ev.label}: ${msg}`);
          continue;
        }
        transientFailures++;
        // If the target engram vanished mid-batch (deleted/unloaded under us),
        // EVERY remaining file would fail the same way — stop now instead of
        // logging one error per file. The cursor stays put (transientFailures>0)
        // and the next poll's ensure-loaded handles the now-missing engram.
        if (/Graph not loaded/i.test(msg)) {
          console.error(`[connector:${cfg.id}] target engram '${cfg.graphId}' was removed mid-pull — stopping this batch.`);
          break;
        }
        console.error(`[connector:${cfg.id}] ingest failed for ${ev.sourceRef}: ${msg}`);
      }
    }
    // Flush the tail since the last checkpoint, then ONE relink for the batch
    // (the per-file save+relink were deferred — turning an O(n²) per-file save
    // storm into O(files / CONNECTOR_SAVE_CHECKPOINT)).
    if (sinceCheckpoint > 0) {
      try { await this.host.save(cfg.graphId); }
      catch (e) { console.error(`[connector:${cfg.id}] batch save failed: ${(e as Error).message}`); }
    }
    console.error(`[connector:${cfg.id}] ingestEvents done: ${count} ingested, ${transientFailures} transient-failure(s) of ${events.length}`);
    if (count > 0) this.host.triggerRelink(cfg.graphId);
    // Batch finished — hide the on-graph progress bar (frontend hides only once
    // ALL in-flight ingests are done, so back-to-back batches don't flicker).
    try {
      this.broadcast?.({
        kind: 'ingest.done', name: 'ingest.done', // dotted → graphnosis://ingest-done
        payload: { jobId: `connector:${cfg.id}`, graphId: cfg.graphId, fileName: '', nodesAdded: count },
      });
    } catch { /* cosmetic */ }
    return { count, transientFailures };
  }

  /**
   * Mirror mode (opt-in): forget any source whose backing file the connector no
   * longer sees on disk. Off by default — connectors are additive, so a deleted
   * file leaves its memory in the cortex unless the user enabled mirrorDeletes.
   */
  private async pruneMirroredDeletes(cfg: ConnectorConfig, rc: RunningConnector): Promise<number> {
    if (cfg.options['mirrorDeletes'] !== true) return 0;
    if (typeof rc.connector.listCurrentSourceRefs !== 'function') return 0;
    const prefix = `${cfg.kind}:${cfg.id}:`;
    const mapped = await this.host.connectorFileMap.entriesForPrefix(prefix);
    if (mapped.length === 0) return 0;
    const current = new Set(await rc.connector.listCurrentSourceRefs());
    let pruned = 0;
    for (const [sourceRef, sourceId] of mapped) {
      if (current.has(sourceRef)) continue; // file still there
      try {
        await this.host.forgetSource(cfg.graphId, sourceId, { triggeredBy: 'connector:mirror-prune' });
        await this.host.connectorFileMap.delete(sourceRef);
        pruned++;
      } catch (e) {
        console.error(`[connector:${cfg.id}] mirror-prune failed for ${sourceRef}: ${(e as Error).message}`);
      }
    }
    if (pruned > 0) console.error(`[connector:${cfg.id}] mirror mode: pruned ${pruned} deleted file(s).`);
    return pruned;
  }

  private async startWebhookServerIfNeeded(): Promise<void> {
    const hasWebhookConnector = this.settings.configs.some(
      c => c.enabled && (c.kind === 'webhook' || buildConnector(c).handleWebhook),
    );
    const hasOAuthConnector = this.settings.configs.some(
      c => c.enabled && buildConnector(c).getAuthUrl,
    );

    if (!hasWebhookConnector && !hasOAuthConnector) return;
    if (this.webhookServer) return; // already running

    this.webhookServer = await startWebhookHttpServer(
      this.settings.webhookPort,
      this.settings.webhookHost,
      this,
    );
  }

  /** Called by the webhook HTTP server when a request arrives. */
  async handleWebhookRequest(
    connectorId: string,
    token: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<ConnectorEvent[]> {
    const cfg = this.settings.configs.find(c => c.id === connectorId);
    if (!cfg) throw new Error(`Unknown connector: ${connectorId}`);

    // Validate the per-connector token to prevent path enumeration.
    const expectedToken = cfg.options['webhookToken'] as string | undefined;
    if (expectedToken && token !== expectedToken) {
      throw new Error('Invalid webhook token');
    }

    const rc = this.running.get(connectorId);
    const connector = rc?.connector ?? buildConnector(cfg);
    if (!connector.handleWebhook) throw new Error(`Connector '${connectorId}' does not support webhooks`);

    const events = await connector.handleWebhook(body, headers);
    if (rc) {
      await this.ingestEvents(cfg, events, rc);
      rc.eventsTotal += events.length;
    }
    return events;
  }

  /** Called by the webhook HTTP server when an OAuth callback arrives. */
  async handleOAuthCallback(connectorId: string, code: string, state: string): Promise<void> {
    const cfg = this.settings.configs.find(c => c.id === connectorId);
    if (!cfg) throw new Error(`Unknown connector: ${connectorId}`);
    const connector = buildConnector(cfg);
    if (!connector.handleOAuthCallback) throw new Error(`Connector '${connectorId}' does not support OAuth`);
    const credentials = await connector.handleOAuthCallback(code, state);
    // Merge new credentials and persist.
    const updated = { ...cfg, credentials };
    const newConfigs = this.settings.configs.map(c => c.id === connectorId ? updated : c);
    await this.persistConfigs(newConfigs);
    console.error(`[connector:${connectorId}] OAuth credentials stored`);
  }

  private async updateConnectorState(
    id: string,
    patch: { lastPulledAt?: number; lastError?: string | undefined },
  ): Promise<void> {
    const newConfigs: ConnectorConfig[] = this.settings.configs.map(c => {
      if (c.id !== id) return c;
      // patch.lastError can be `undefined` to mean "clear it"; we represent
      // that on-disk by omitting the field. Build the next config without
      // the field if patch.lastError is explicitly undefined.
      const { lastError: _oldLastError, ...rest } = c;
      const next: ConnectorConfig = {
        ...rest,
        ...(patch.lastPulledAt !== undefined ? { lastPulledAt: patch.lastPulledAt } : {}),
        ...('lastError' in patch && patch.lastError !== undefined
          ? { lastError: patch.lastError }
          : c.lastError !== undefined && !('lastError' in patch)
            ? { lastError: c.lastError }
            : {}),
      };
      return next;
    });
    await this.persistConfigs(newConfigs);
  }

  private async persistConfigs(configs: ConnectorConfig[]): Promise<void> {
    this.settings = { ...this.settings, configs };
    await this.host.setSettings({ connectors: this.settings });
  }

  /** Current poll interval (ms) — surfaced to the UI via `list()`. */
  getPullIntervalMs(): number {
    return this.settings.pullIntervalMs;
  }

  /**
   * Change the poll interval at runtime. Clamps to a 60s floor, persists, and
   * swaps the live timers on every running pull-capable connector (without
   * re-pulling). Watchers are unaffected — they already give near-instant
   * ingest; this only governs the backstop poll.
   */
  /** Effective pull interval for a connector: its own `options.intervalMs`
   *  override (≥ 60s) if set, else the global default. */
  private intervalForCfg(cfg: { options?: Record<string, unknown> }): number {
    const v = cfg.options?.['intervalMs'];
    if (typeof v === 'number' && v >= 60_000) return Math.floor(v);
    return this.settings.pullIntervalMs;
  }

  /** Per-connector self-heal cadence (minutes between periodic full re-scans).
   *  Unset → the FULL_RESCAN_INTERVAL_MS default (30 min). 0 (or negative) →
   *  disabled: no automatic full re-scan, only manual "Pull now"/"Re-sync". */
  private fullRescanIntervalMs(cfg: { options?: Record<string, unknown> }): number {
    const v = cfg.options?.['fullRescanMinutes'];
    if (typeof v === 'number') return v <= 0 ? Infinity : Math.floor(v) * 60_000;
    return FULL_RESCAN_INTERVAL_MS;
  }

  async setPullInterval(ms: number): Promise<number> {
    const clamped = Math.max(60_000, Math.floor(ms));
    this.settings = { ...this.settings, pullIntervalMs: clamped };
    await this.host.setSettings({ connectors: this.settings });
    for (const [id, rc] of this.running) {
      if (!rc.connector.pull) continue;
      if (rc.pullTimer) clearInterval(rc.pullTimer);
      const cfg = this.settings.configs.find(c => c.id === id);
      if (!cfg) continue;
      // Respect a per-connector override; otherwise use the new global default.
      rc.pullTimer = setInterval(() => {
        void this.doPull(cfg, rc).catch(err => {
          console.error(`[connector:${id}] scheduled pull failed: ${(err as Error).message}`);
        });
      }, this.intervalForCfg(cfg)).unref();
    }
    return clamped;
  }
}

// ── Connector factory ─────────────────────────────────────────────────────────

function buildConnector(cfg: ConnectorConfig): Connector {
  switch (cfg.kind) {
    case 'webhook': return new WebhookConnector(cfg);
    case 'rss':     return new RssConnector(cfg);
    case 'github':  return new GitHubConnector(cfg);
    case 'slack':   return new SlackConnector(cfg);
    case 'trello':   return new TrelloConnector(cfg);
    case 'linear':   return new LinearConnector(cfg);
    case 'obsidian': return new ObsidianConnector(cfg);
    case 'gbrain':      return new GBrainConnector(cfg);
    case 'ai-context':  return new AiContextConnector(cfg);
    default: throw new Error(`Unknown connector kind: ${(cfg as ConnectorConfig).kind}`);
  }
}

// ── Webhook HTTP server ───────────────────────────────────────────────────────

async function startWebhookHttpServer(
  port: number,
  host: string,
  manager: ConnectorManager,
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    // ── OAuth callback: GET /oauth/<connectorId>/callback?code=…&state=… ──
    const oauthMatch = url.match(/^\/oauth\/([^/]+)\/callback/);
    if (oauthMatch && req.method === 'GET') {
      const connectorId = decodeURIComponent(oauthMatch[1]!);
      const qs = new URL(url, `http://${host}`).searchParams;
      const code = qs.get('code') ?? '';
      const state = qs.get('state') ?? '';
      try {
        await manager.handleOAuthCallback(connectorId, code, state);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Graphnosis: authentication complete. You can close this tab.</h2>');
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`OAuth error: ${(err as Error).message}`);
      }
      return;
    }

    // ── Webhook push: POST /webhook/<connectorId>/<token> ──────────────────
    const webhookMatch = url.match(/^\/webhook\/([^/]+)\/([^/?]+)/);
    if (webhookMatch && req.method === 'POST') {
      const connectorId = decodeURIComponent(webhookMatch[1]!);
      const token = decodeURIComponent(webhookMatch[2]!);
      let body: unknown;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400);
        res.end('Invalid JSON body');
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      try {
        const events = await manager.handleWebhookRequest(connectorId, token, body, headers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, eventsIngested: events.length }));
      } catch (err) {
        const msg = (err as Error).message;
        const status = msg.includes('Invalid webhook token') || msg.includes('Unknown connector') ? 403 : 500;
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(msg);
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.on('error', (err) => {
    console.error(`[connectors] webhook server error: ${err.message}`);
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.error(`[graphnosis-sidecar] connector webhook server on http://${host}:${port}`);
      resolve(server);
    });
  });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { buf += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function slugify(kind: string): string {
  return `${kind}-${randomUUID().slice(0, 8)}`;
}
