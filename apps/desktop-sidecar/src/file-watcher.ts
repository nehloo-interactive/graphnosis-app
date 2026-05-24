// File-watcher for the auto-reingest-on-save feature.
//
// Watches every file-backed source's disk path; on a meaningful change
// (mtime advanced; file still exists; debounced by 2s) it runs the same
// forget + ingestFile flow the Reingest button uses. The push-event
// channel inside host.save() fires the mutation tick, so the App's
// counters / lists refresh without any extra wiring on the UI side.
//
// Why fs.watch + mtime polling instead of chokidar:
//   - Zero new top-level deps. chokidar is great but it ships a tree of
//     transitive deps we don't otherwise need; fs.watch is built-in.
//   - macOS / Linux fs.watch fires on every fsync; we already need to
//     debounce regardless because editors do save → autosave → save in
//     rapid succession (especially Obsidian / VS Code).
//   - The mtime check (`awaitWriteFinish` analogue) guards against
//     spurious events that don't actually represent a content change.
//
// This module is hookless w.r.t. the host's mutation events — it
// observes the source index, not the graph. The host calls into us on
// ingest / forgetSource lifecycle points so we know what to watch.

import { promises as fs } from 'node:fs';
import nodeFs from 'node:fs';
import type { FSWatcher } from 'node:fs';
import type { GraphnosisHost } from './host.js';
import { ingestFile } from './ingest.js';

// Quick burst-collapse debounce: collapses the editor's rapid "save →
// autosave → save" burst (VS Code, Obsidian, Vim) into a single event.
// Separate from the user-configurable quiet period below.
const BURST_DEBOUNCE_MS = 2_000;

// Default quiet period: how long the file must be stable before we fire
// the actual reingest.  Overridden per-instance by setQuietMs().
const DEFAULT_QUIET_MS = 15 * 60 * 1_000; // 15 minutes

interface WatchedPath {
  watcher: FSWatcher;
  /** Last mtime we observed; used to skip spurious fs.watch fires that
   *  don't represent a real content change (rename touches, etc). */
  lastMtimeMs: number;
  /** Stage-1 burst-collapse timer (BURST_DEBOUNCE_MS). Resets on every
   *  save event; once it fires it schedules the stage-2 quiet timer. */
  burstDebounce: NodeJS.Timeout | null;
  /** Stage-2 quiet-period timer (quietMs). Scheduled by the burst timer
   *  after the save burst settles; this is when reingest actually fires. */
  quietTimer: NodeJS.Timeout | null;
}

interface SourceKey {
  graphId: string;
  sourceId: string;
}

export class FileWatcher {
  private host: GraphnosisHost;
  /** path → watcher state. Multiple sources could in theory point at
   *  the same path (re-ingesting same file under a new source-id) —
   *  the path is the canonical key, and we look the source up by path
   *  on each fire. */
  private watched = new Map<string, WatchedPath>();
  /** path → owning source(s). Used to route a change event back to the
   *  correct (graphId, sourceId) pair for the reingest call. */
  private bySources = new Map<string, SourceKey>();
  /** When false, all new watch() calls are no-ops. Used to honor the
   *  settings flag without tearing down state if the user toggles it
   *  off then back on. */
  private enabled = false;
  /** How long (ms) the file must be stable before reingest fires.
   *  Settable at runtime so a Settings change takes effect on the next
   *  file-change event without restarting the sidecar. */
  private quietMs = DEFAULT_QUIET_MS;

  constructor(host: GraphnosisHost) {
    this.host = host;
  }

  /** Update the quiet period from settings.  Affects the next file-change
   *  event; already-running timers are not retroactively adjusted (they
   *  will fire with the old delay and the new value applies from then on). */
  setQuietMs(ms: number): void {
    this.quietMs = ms;
  }

  /** Flip the watcher on/off in response to settings changes. */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      // Newly enabled — register every existing file source.
      this.syncAll();
    } else {
      // Newly disabled — tear down all watchers but keep our bookkeeping
      // so re-enabling doesn't have to re-scan.
      for (const [, state] of this.watched) {
        state.watcher.close();
        if (state.burstDebounce) clearTimeout(state.burstDebounce);
        if (state.quietTimer)    clearTimeout(state.quietTimer);
      }
      this.watched.clear();
    }
  }

  /** Snapshot every file source in the host and watch each one. Called
   *  on enable + after lifecycle changes that aren't otherwise routed
   *  through the per-source hooks (e.g. initial load). */
  syncAll(): void {
    if (!this.enabled) return;
    const sources = this.host.listSources();
    const seenPaths = new Set<string>();
    for (const s of sources) {
      if (s.kind !== 'file') continue;
      seenPaths.add(s.ref);
      this.watchPath(s.ref, { graphId: s.graphId, sourceId: s.sourceId });
    }
    // Drop watchers for paths that no longer belong to a source (e.g.
    // user forgot the source while we were disabled).
    for (const p of Array.from(this.watched.keys())) {
      if (!seenPaths.has(p)) this.unwatchPath(p);
    }
  }

  /** Called by the host after a successful file ingest. */
  onSourceIngested(graphId: string, sourceId: string, ref: string, kind: string): void {
    if (!this.enabled) return;
    if (kind !== 'file') return;
    this.watchPath(ref, { graphId, sourceId });
  }

  /** Called by the host before forgetSource clears the index. */
  onSourceForgotten(_graphId: string, _sourceId: string, ref: string): void {
    if (!this.enabled) return;
    this.unwatchPath(ref);
  }

  /** Tear everything down — invoked on sidecar shutdown so we don't
   *  leak fs.watch handles. */
  dispose(): void {
    for (const [, state] of this.watched) {
      state.watcher.close();
      if (state.burstDebounce) clearTimeout(state.burstDebounce);
      if (state.quietTimer)    clearTimeout(state.quietTimer);
    }
    this.watched.clear();
    this.bySources.clear();
    this.enabled = false;
  }

  private watchPath(filePath: string, key: SourceKey): void {
    // Refresh the source mapping even if we already watch this path —
    // the source-id could have changed (re-ingest under a new id).
    this.bySources.set(filePath, key);
    if (this.watched.has(filePath)) return;

    let initialMtime = 0;
    try {
      initialMtime = nodeFs.statSync(filePath).mtimeMs;
    } catch {
      // File missing on disk → nothing to watch yet. The user may
      // restore it later; we'll pick it up on the next syncAll().
      return;
    }

    let watcher: FSWatcher;
    try {
      // Non-recursive (single file). `persistent: false` so the watcher
      // doesn't keep the event loop alive if the rest of the sidecar
      // exits — the parent process lifecycle owns us, not the other way
      // around.
      watcher = nodeFs.watch(filePath, { persistent: false });
    } catch (e) {
      console.error(`[file-watcher] failed to watch ${filePath}: ${(e as Error).message}`);
      return;
    }

    const state: WatchedPath = {
      watcher,
      lastMtimeMs: initialMtime,
      burstDebounce: null,
      quietTimer:    null,
    };
    this.watched.set(filePath, state);

    watcher.on('change', () => {
      // Stage 1 — burst collapse (BURST_DEBOUNCE_MS = 2s).
      // Resets on every fs event so a rapid "save → autosave → save"
      // sequence collapses to one signal before stage 2 starts.
      if (state.burstDebounce) clearTimeout(state.burstDebounce);
      // Any new save also cancels a pending quiet timer — the quiet
      // period resets from the LAST save, not the first.
      if (state.quietTimer) { clearTimeout(state.quietTimer); state.quietTimer = null; }

      state.burstDebounce = setTimeout(() => {
        state.burstDebounce = null;
        // Stage 2 — quiet period (user-configured, default 15 min).
        // File must stay unchanged for this long before reingest fires.
        state.quietTimer = setTimeout(() => {
          state.quietTimer = null;
          void this.fire(filePath, state);
        }, this.quietMs);
      }, BURST_DEBOUNCE_MS);
    });

    watcher.on('error', (e) => {
      console.error(`[file-watcher] watcher error on ${filePath}: ${e.message}`);
      this.unwatchPath(filePath);
    });
  }

  private unwatchPath(filePath: string): void {
    const state = this.watched.get(filePath);
    if (state) {
      state.watcher.close();
      if (state.burstDebounce) clearTimeout(state.burstDebounce);
      if (state.quietTimer)    clearTimeout(state.quietTimer);
      this.watched.delete(filePath);
    }
    this.bySources.delete(filePath);
  }

  private async fire(filePath: string, state: WatchedPath): Promise<void> {
    // Bail if the file vanished between debounce and fire (user moved
    // it, deleted it, etc.). The watcher itself fires `rename` events
    // for these cases on macOS, but we double-check stat for safety.
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      console.error(`[file-watcher] ${filePath} disappeared; unwatching.`);
      this.unwatchPath(filePath);
      return;
    }
    if (!stat.isFile()) {
      this.unwatchPath(filePath);
      return;
    }
    // Skip if mtime didn't actually advance — fs.watch on macOS fires
    // on metadata changes too, and we don't want to re-chunk on
    // chmod / touch.
    if (stat.mtimeMs <= state.lastMtimeMs) return;
    state.lastMtimeMs = stat.mtimeMs;

    const key = this.bySources.get(filePath);
    if (!key) return; // raced with unwatchPath
    console.error(`[file-watcher] reingesting ${filePath} (graph=${key.graphId}, source=${key.sourceId})`);
    try {
      // forgetSource clears the existing nodes; ingestFile re-reads from
      // disk. Both save(), so the App's push-event channel sees two
      // mutation ticks. makeSourceId is deterministic from (kind, ref),
      // so the new record has the same sourceId — we still re-bind for
      // safety in case host implementation changes.
      await this.host.forgetSource(key.graphId, key.sourceId, { triggeredBy: 'user:ingest' });
      const record = await ingestFile(this.host, key.graphId, filePath, { triggeredBy: 'user:ingest' });
      this.bySources.set(filePath, { graphId: record.graphId, sourceId: record.sourceId });
    } catch (e) {
      console.error(`[file-watcher] reingest failed for ${filePath}: ${(e as Error).message}`);
    }
  }
}
