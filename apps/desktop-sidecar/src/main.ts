#!/usr/bin/env node

import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { embeddings } from '@graphnosis-app/core';
import { policy } from '@nehloo-interactive/graphnosis-secure-sync';
import { GraphnosisHost } from './host.js';
import { GraphnosisImpl } from './graphnosis-impl.js';
import { startIpc } from './ipc.js';
import { startEvents } from './events.js';
import { startStdioMcpServer } from './mcp-server.js';
import { startSocketMcpServer } from './mcp-socket-server.js';
import { mcpRegistry } from './mcp-registry.js';
import { startHttpMcpServer } from './mcp-http-server.js';
import { ConnectorManager } from './connectors/manager.js';
import { LLM_CATALOG, makeLlm } from './local-llm.js';
import { workerEmbed, terminateEmbedWorker, LOCAL_EMBED_ID, LOCAL_EMBED_DIM } from './local-embed.js';
import type { LocalLlm } from './correction.js';
import type { CorrectionDiff } from './correction.js';
import type { BroadcastRawFn } from './events.js';
import { FileWatcher } from './file-watcher.js';
import { BrainEngine } from './brain-engine.js';

interface CliEnv {
  cortexDir: string;
  passphrase: string;
  deviceId: string;
  defaultGraph: string;
  llmId?: string;
  /** Set when Tauri starts the sidecar in recovery mode (forgot passphrase). */
  recoveryPhrase?: string;
}

function loadEnv(): CliEnv {
  const required = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`Missing env var: ${k}`);
    return v;
  };
  // Recovery mode: user provided 24-word phrase instead of passphrase.
  // GRAPHNOSIS_PASSPHRASE is not set (or ignored) in this case.
  const recoveryPhrase = process.env.GRAPHNOSIS_RECOVERY_PHRASE;
  return {
    cortexDir: required('GRAPHNOSIS_CORTEX'),
    passphrase: recoveryPhrase
      ? (process.env.GRAPHNOSIS_PASSPHRASE ?? '')
      : required('GRAPHNOSIS_PASSPHRASE'),
    deviceId: process.env.GRAPHNOSIS_DEVICE_ID ?? `${os.hostname()}-${process.pid}`,
    defaultGraph: process.env.GRAPHNOSIS_DEFAULT_GRAPH ?? 'personal',
    ...(process.env.GRAPHNOSIS_LLM ? { llmId: process.env.GRAPHNOSIS_LLM } : {}),
    ...(recoveryPhrase ? { recoveryPhrase } : {}),
  };
}

/**
 * Acquire an exclusive file lock on the cortex dir so two sidecars cannot
 * write to the same .aikg file simultaneously (multi-writer corruption,
 * where one sidecar's saves get clobbered by another's stale in-memory
 * state). The lock is auto-released on process exit; stale locks from
 * killed processes are detected and recovered.
 *
 * If another sidecar already holds the lock, we exit with a clear message
 * — Claude Desktop will show this in mcp-server-Graphnosis.log.
 */
/**
 * Scan `<cortex>/graphs/` for `.gai` (and legacy `.aikg`) files and load
 * each one that isn't already in memory. Failures per-file are logged
 * but non-fatal — sidecar keeps starting even if one engram won't
 * decrypt, so the user can still work with their other graphs.
 */
async function loadAllGraphsFromDisk(
  host: GraphnosisHost,
  cortexDir: string,
  defaultGraphId: string,
  broadcastRaw?: BroadcastRawFn,
): Promise<void> {
  const graphsDir = path.join(cortexDir, 'graphs');
  let entries: string[];
  try {
    entries = await fs.readdir(graphsDir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return; // first-run cortex — only the default graph exists
    console.error(`[graphnosis-sidecar] could not list ${graphsDir}: ${err.message}`);
    return;
  }
  const seen = new Set<string>(host.listGraphs());
  // Collect the list of graphIds to load first; then dispatch them
  // SEQUENTIALLY with a yield between each. Earlier this used Promise.all
  // for parallelism, but host.loadGraph contains sync decryption that
  // monopolizes the Node event loop — 12 concurrent loads starved the IPC
  // socket for ~25s, freezing the lock screen on "Loading memories…" while
  // the boot's list_nodes('personal') call sat in the IPC queue. Sequential
  // + setImmediate yield lets IPC interleave so the default engram stays
  // queryable throughout the background load. Per-graph try/catch keeps
  // "partial failure is partial visibility" intact: one bad graph doesn't
  // block the rest.
  const toLoad: string[] = [];
  for (const name of entries) {
    // Match both the canonical .gai and the legacy .aikg path; strip the
    // extension to get the graphId. Skip .bak / .tmp leftovers from
    // interrupted purges.
    const m = name.match(/^(.+)\.(gai|aikg)$/);
    if (!m) continue;
    const graphId = m[1] as string;
    if (graphId === defaultGraphId) continue; // already loaded
    if (seen.has(graphId)) continue;
    toLoad.push(graphId);
  }

  const total = toLoad.length;
  let loaded = 0;

  if (broadcastRaw && total > 0) {
    broadcastRaw({ kind: 'engrams-loading', name: 'engrams-loading', payload: { loaded: 0, total } });
  }

  for (const graphId of toLoad) {
    const startedAt = Date.now();
    try {
      await host.loadGraph(graphId);
      console.error(
        `[graphnosis-sidecar] loaded engram '${graphId}' from disk (${Date.now() - startedAt}ms)`,
      );
    } catch (e) {
      const err = e as Error;
      // Stack trace included — when a graph silently doesn't show up in
      // the picker, the user's first stop is the dev terminal, and the
      // bare message often doesn't pinpoint which step failed (decrypt /
      // loadFromBuffer / bundle / cache).
      console.error(
        `[graphnosis-sidecar] FAILED to load engram '${graphId}': ${err.message}`,
      );
      if (err.stack) console.error(err.stack);
    }
    loaded++;
    if (broadcastRaw) {
      broadcastRaw({ kind: 'engrams-loading', name: 'engrams-loading', payload: { loaded, total } });
    }
    // Yield to the event loop so any pending IPC requests (notably the
    // boot's list_nodes / list_edges for the default engram) can run
    // before the next load locks the loop again.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * Self-heal: ensure every loaded graph has a `graphMetadata` entry in
 * `settings.json`. Graphs without an entry are invisible to the App's
 * engram picker (which reads `settings.graphMetadata` keys), even though
 * they exist on disk and are loaded into memory.
 *
 * Bug class this fixes: cortexes created before the metadata feature
 * shipped, or where the initial `setGraphMetadata` call silently failed,
 * leave the graph in a "ghost" state visible only via a manual
 * settings.json edit. Backfilling on every startup is idempotent and
 * costs ~one Object.entries pass — cheap insurance against the user
 * losing access to a graph because of an older bug we can't audit.
 *
 * Defaults written:
 *   - template:    'personal'  (the most generic; user can rename in Settings)
 *   - displayName: <graphId>   (raw id is at least recognizable)
 *   - createdAt:   1            (epoch-1 sorts at the top of the picker
 *                                without overwriting genuinely-old graphs
 *                                if the user later edits this entry)
 */
async function backfillGraphMetadata(host: GraphnosisHost): Promise<void> {
  const ids = host.listGraphs();
  const missing: string[] = [];
  for (const id of ids) {
    if (host.getGraphMetadata(id) === undefined) {
      missing.push(id);
    }
  }
  if (missing.length === 0) return;
  console.error(
    `[graphnosis-sidecar] backfill: ${missing.length} graph(s) missing metadata: ${missing.join(', ')} — writing defaults`,
  );
  // Serial loop, not Promise.all — setGraphMetadata reads `this.settings`,
  // mutates a copy, writes the file, and assigns back. Concurrent calls
  // would race on read-modify-write and lose intermediate entries.
  for (const id of missing) {
    try {
      await host.setGraphMetadata(id, {
        template: 'personal',
        displayName: id,
        createdAt: 1,
      });
      console.error(`[graphnosis-sidecar] backfilled metadata for '${id}'`);
    } catch (e) {
      const err = e as Error;
      console.error(`[graphnosis-sidecar] backfill FAILED for '${id}': ${err.message}`);
    }
  }
}

async function acquireCortexLock(cortexDir: string): Promise<() => Promise<void>> {
  await fs.mkdir(cortexDir, { recursive: true });
  // proper-lockfile locks a target file, not a directory; use a sentinel.
  const lockTarget = path.join(cortexDir, '.lockfile');
  // Ensure the sentinel exists so proper-lockfile has something to lock.
  await fs.writeFile(lockTarget, `pid=${process.pid}\nhost=${os.hostname()}\nstarted=${new Date().toISOString()}\n`);
  try {
    const release = await lockfile.lock(lockTarget, {
      // If a previous process held the lock but died, ~10s of inactivity
      // (no mtime update) is treated as stale and recovered.
      stale: 10_000,
      // Up to ~5 retries spaced 200ms..2s apart — handles brief overlap
      // during a Claude Desktop ⌘Q + reopen.
      retries: { retries: 5, minTimeout: 200, maxTimeout: 2_000, factor: 2 },
      // Release on any process exit signal so the next sidecar can start cleanly.
      realpath: false,
      // Override the default handler which does `throw err` — throwing inside
      // proper-lockfile's async stale-checker produces an unhandled rejection
      // that kills the sidecar in Node.js 20+. The compromised state just means
      // the .lockfile.lock file disappeared externally (macOS tmp-cleaner, etc.);
      // no competing writer has taken over, so re-acquiring is safe.
      onCompromised: (err: Error) => {
        console.error(
          `[graphnosis-sidecar] lockfile compromised (${err.message}); ` +
          're-acquiring to stay alive…',
        );
        void lockfile.lock(lockTarget, { realpath: false }).catch((e: Error) => {
          // A second failure means something else holds the lock — exit cleanly
          // rather than running as a potentially conflicting writer.
          console.error(
            `[graphnosis-sidecar] could not re-acquire compromised lock: ${e.message}. Exiting.`,
          );
          process.exit(0);
        });
      },
    });
    console.error(`[graphnosis-sidecar] cortex lock acquired on ${lockTarget}`);
    return release;
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[graphnosis-sidecar] FATAL: could not acquire cortex lock on ${cortexDir}: ${msg}`);
    console.error('[graphnosis-sidecar] another Graphnosis sidecar is already writing to this cortex. ' +
      'Quit Claude Desktop fully (⌘Q, not ⌘W) and reopen, or check `ps -ax | grep graphnosis` for orphan processes to kill.');
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const env = loadEnv();

  // Acquire the cortex lock BEFORE touching any files. If another sidecar
  // is holding it, we exit immediately rather than starting a competing writer.
  const releaseLock = await acquireCortexLock(env.cortexDir);

  // Ensure the lock is released cleanly on common termination paths.
  const safeRelease = async (): Promise<void> => {
    // Terminate embed workers before releasing the lock so they don't linger
    // as orphan threads after the main process exits.
    await terminateEmbedWorker().catch(() => { /* non-fatal on shutdown */ });
    try { await releaseLock(); } catch { /* lock already released */ }
  };
  process.on('SIGINT', () => { void safeRelease().then(() => process.exit(0)); });
  process.on('SIGTERM', () => { void safeRelease().then(() => process.exit(0)); });
  process.on('beforeExit', () => { void safeRelease(); });

  // Final safety net for orphan-sidecar prevention. If our parent (the Tauri
  // shell, or Claude Desktop, or whatever spawned us) dies without killing
  // us first — force quit, crash, panic, ⌘Q-skipping-cleanup — the OS
  // reparents us to launchd (PID 1 on macOS/Linux). We poll for that and
  // self-terminate, releasing the cortex lock cleanly. .unref() so this
  // interval doesn't itself keep the event loop alive.
  const originalPpid = process.ppid;
  if (originalPpid > 1) {
    setInterval(() => {
      if (process.ppid === 1 && originalPpid !== 1) {
        console.error('[graphnosis-sidecar] parent process died; exiting cleanly.');
        void safeRelease().then(() => process.exit(0));
      }
    }, 2000).unref();
  }

  const adapter = new GraphnosisImpl();

  // Policy can be supplied via $GRAPHNOSIS_POLICY (path to JSON) for tiered graphs.
  // Shape: { graphs: [{ graphId, tier?: 'public'|'personal'|'sensitive', shareWithAi? }] }
  // Until the desktop UI manages this, env-driven is the override path.
  // Missing file is warned, not fatal — easier to bootstrap.
  let policyCfg: policy.PolicyConfig | undefined;
  if (process.env.GRAPHNOSIS_POLICY) {
    try {
      const { promises: fs } = await import('node:fs');
      const raw = await fs.readFile(process.env.GRAPHNOSIS_POLICY, 'utf8');
      const parsed = JSON.parse(raw) as { graphs?: policy.GraphPolicy[] };
      policyCfg = { defaultBudget: policy.DEFAULT_BUDGET, graphs: parsed.graphs ?? [] };
      console.error(`[graphnosis-sidecar] policy loaded from ${process.env.GRAPHNOSIS_POLICY} (${policyCfg.graphs.length} graphs)`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        console.error(`[graphnosis-sidecar] WARNING: GRAPHNOSIS_POLICY=${process.env.GRAPHNOSIS_POLICY} not found — running with defaults. Create the file to apply per-graph tiers.`);
      } else {
        console.error(`[graphnosis-sidecar] WARNING: failed to read policy file: ${err.message} — running with defaults.`);
      }
    }
  }

  // Local embedding model — real semantic search via fastembed (ONNX, BGE-small-en-v1.5).
  // First call downloads the model (~33MB) to the cache dir; subsequent calls are offline.
  // If init fails (e.g., onnxruntime native binary missing on this platform), we degrade
  // to the SHA-derived stub so the server still boots — TF-IDF still works.
  let embedFn = embeddings.stubEmbed;
  let embedAdapterId = 'graphnosis-app:stub@384';
  let embedDimensions = 384;
  if (process.env.GRAPHNOSIS_EMBED_DISABLE !== '1') {
    try {
      // Probe with a tiny embed so any model-download / native-binary issue surfaces at boot.
      const probe = await workerEmbed('graphnosis boot probe');
      if (probe.length !== LOCAL_EMBED_DIM) throw new Error(`unexpected embedding dim ${probe.length}`);
      embedFn = workerEmbed;
      embedAdapterId = LOCAL_EMBED_ID;
      embedDimensions = LOCAL_EMBED_DIM;
      console.error(`[graphnosis-sidecar] local embeddings ready (${LOCAL_EMBED_ID})`);
    } catch (e) {
      console.error(`[graphnosis-sidecar] WARNING: local embeddings unavailable (${(e as Error).message}) — falling back to TF-IDF-only retrieval. Set GRAPHNOSIS_EMBED_DISABLE=1 to silence.`);
    }
  }

  const { host, recoveryPhrase } = await GraphnosisHost.open({
    cortexDir: env.cortexDir,
    passphrase: env.passphrase,
    deviceId: env.deviceId,
    adapter,
    embed: embedFn,
    embedAdapterId,
    embedDimensions,
    ...(policyCfg ? { policy: policyCfg } : {}),
    ...(env.recoveryPhrase ? { recoveryPhrase: env.recoveryPhrase } : {}),
  });

  // First-run: stash the recovery phrase in a temp file so Tauri can read
  // it immediately after the sidecar's IPC socket appears. Tauri reads +
  // deletes the file, then emits it to the webview. The file is 0600 and
  // lives only for the few hundred milliseconds between socket-up and the
  // Tauri unlock command returning. Recovery phrase is 24 space-separated
  // words — no special encoding needed.
  if (recoveryPhrase) {
    const pendingPath = path.join(env.cortexDir, '.recovery-pending');
    await fs.writeFile(pendingPath, recoveryPhrase, { encoding: 'utf8' });
    await fs.chmod(pendingPath, 0o600);
  }

  // Stale-preference guard: if the frontend asked for an engram that no
  // longer exists on disk (e.g. user deleted it but localStorage still
  // remembers it), silently fall back to 'personal'. Without this, the
  // ENOENT branch below would happily createGraph(staleName) and stamp it
  // with the 'personal' template metadata — a silent surprise where the
  // user sees a new empty engram instead of their actual data.
  if (env.defaultGraph !== 'personal') {
    const candidatePath = path.join(env.cortexDir, 'graphs', `${env.defaultGraph}.gai`);
    const legacyPath    = path.join(env.cortexDir, 'graphs', `${env.defaultGraph}.aikg`);
    const exists = await Promise.all([
      fs.access(candidatePath).then(() => true).catch(() => false),
      fs.access(legacyPath).then(() => true).catch(() => false),
    ]).then(([a, b]) => a || b);
    if (!exists) {
      console.error(
        `[graphnosis-sidecar] preferred default '${env.defaultGraph}' not found on disk — falling back to 'personal'`,
      );
      env.defaultGraph = 'personal';
    }
  }

  // Ensure default graph exists/loads.
  //
  // CRITICAL: only fall back to createGraph if the file genuinely doesn't
  // exist (ENOENT). Any other failure — particularly decryption errors —
  // means the cortex HAS data we can't read with this passphrase, and we
  // must abort the unlock rather than silently overwrite a real cortex
  // with an empty one. Earlier behavior treated *any* loadGraph failure
  // as "first-time setup, create fresh" which is a silent data-loss bug
  // for wrong-passphrase unlocks.
  try {
    const t0 = Date.now();
    await host.loadGraph(env.defaultGraph);
    // Surface the default-graph load explicitly so the startup log lists
    // ALL engrams (was previously silent for the default — confusing when
    // diagnosing "where did my data go?" because the default appears
    // missing from the boot log even when it loaded fine).
    try {
      const nodeCount = host.listNodes(env.defaultGraph).length;
      console.error(
        `[graphnosis-sidecar] loaded engram '${env.defaultGraph}' (default) from disk (${Date.now() - t0}ms, ${nodeCount} nodes)`,
      );
    } catch {
      console.error(
        `[graphnosis-sidecar] loaded engram '${env.defaultGraph}' (default) from disk (${Date.now() - t0}ms)`,
      );
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      // No graph file on disk yet → genuinely a first unlock for this cortex.
      await host.createGraph(env.defaultGraph);
      // Seed default-graph metadata so the new Graphs UI has something to
      // show on first launch (template + display name). Existing cortexes
      // without metadata fall back to defaults in graphsWithMetadata().
      await host.setGraphMetadata(env.defaultGraph, {
        template: 'personal',
        displayName: 'Personal',
        createdAt: Date.now(),
      });
    } else {
      // Anything else (decryption failure, corrupt file, signature mismatch,
      // permission errors) is fatal. Surface it loudly so the UI shows
      // "Wrong passphrase or cortex corrupted" instead of pretending all is well.
      console.error(`[graphnosis-sidecar] FATAL: failed to load existing graph: ${err.message}`);
      console.error('[graphnosis-sidecar] This usually means the passphrase is wrong, or the .gai file is corrupted.');
      console.error('[graphnosis-sidecar] Refusing to overwrite the existing cortex with a fresh empty graph.');
      throw e;
    }
  }

  // Backfill metadata for the default graph before IPC starts — the engram
  // picker reads graphMetadata keys, so the default engram must have an entry
  // or it won't appear in the picker at unlock time. Idempotent: skips graphs
  // that already have metadata. Secondary engrams are backfilled later in the
  // background task once they finish loading.
  await backfillGraphMetadata(host);

  // Background load of all other engrams — starts after IPC is up so
  // broadcastRaw is available for progress events. The default engram is
  // already loaded and fully usable; the picker gains entries as each
  // additional graph finishes decrypting.

  // Filesystem auto-reingest. Off by default; honors the
  // `ai.autoReingestOnFileChange` flag in settings.json. We wire the
  // watcher into the host so ingest/forget lifecycle points keep the
  // watch set in sync without polling.
  const fileWatcher = new FileWatcher(host);
  host.setFileWatcher(fileWatcher);
  const initialSettings = host.getSettings();
  fileWatcher.setEnabled(initialSettings.ai.autoReingestOnFileChange);
  fileWatcher.setQuietMs(initialSettings.ai.reingestQuietMs);
  // Re-evaluate on every settings change so toggling the flag or
  // adjusting the quiet period takes effect immediately.
  host.onSettingsChanged((s) => {
    fileWatcher.setEnabled(s.ai.autoReingestOnFileChange);
    fileWatcher.setQuietMs(s.ai.reingestQuietMs);
  });
  process.on('SIGINT', () => fileWatcher.dispose());
  process.on('SIGTERM', () => fileWatcher.dispose());

  let llm: LocalLlm | null = null;
  const choice = LLM_CATALOG.find(c => c.id === env.llmId) ?? LLM_CATALOG.find(c => c.recommended);
  if (choice) {
    try {
      llm = makeLlm(choice);
    } catch (e) {
      console.error(`[graphnosis-sidecar] Local LLM (${choice.id}) unavailable: ${(e as Error).message}`);
    }
  }

  const pendingDiffs = new Map<string, { graphId: string; diff: CorrectionDiff; createdAt: number }>();

  // Push-event channel — start BEFORE the MCP server and IPC so
  // `broadcastRaw` is available to wire into mcpDeps and the IPC
  // startup. Order matters here: the `remember` MCP tool uses
  // broadcastRaw to surface "engram missing — create?" prompts to the
  // App's UI, and the first ingest.file event arrives once IPC is up.
  const eventsSocketPath = process.env.GRAPHNOSIS_EVENTS_SOCKET
    ?? path.join(env.cortexDir, 'events.sock');
  const { broadcastRaw } = await startEvents({ host, socketPath: eventsSocketPath });

  const brainEngine = new BrainEngine(host, llm, broadcastRaw);
  // Wire recall → reinforcement: every federated recall feeds the
  // co-activation accumulator so co-recalled memories strengthen.
  host.setPlasticityObserver((sub) => brainEngine.onRecall(sub));

  const mcpDeps = {
    host,
    // The local LLM is opt-in — `correct` and any other LLM-backed MCP tool
    // sees null until the user enables it, even when Ollama is reachable.
    llm: () => (host.getSettings().ai.llmEnabled === true ? llm : null),
    defaultGraphId: () => env.defaultGraph,
    pendingDiffs,
    broadcastRaw,
    brainEngine,
  };

  // MCP server over Unix socket. Lets multiple clients (Claude Desktop via
  // mcp-relay.js, plus anything else) share this one sidecar's in-memory
  // state. Disabled when run as a Claude-spawned stdio child (the relay
  // pattern is the new path; the legacy stdio path stays for backwards compat).
  const mcpSocketPath = process.env.GRAPHNOSIS_MCP_SOCKET
    ?? path.join(env.cortexDir, 'mcp.sock');
  let mcpServer = await startSocketMcpServer({ deps: mcpDeps, socketPath: mcpSocketPath });

  // Exposed to the App via IPC so the user can manually bounce the listener
  // when a client appears stuck. Closes the current server, then opens a new
  // one bound to the same path. Any relay in auto-reconnect-wait sees the
  // socket reappear and reconnects on its next probe.
  const restartMcpListener = async (): Promise<void> => {
    await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
    mcpServer = await startSocketMcpServer({ deps: mcpDeps, socketPath: mcpSocketPath });
  };

  // Optional HTTP bridge for mobile and remote MCP clients. Disabled by
  // default; user enables in Settings → "Mobile & Remote". Requires a
  // sidecar restart to take effect (same as mcpRelay settings).
  const httpBridgeCfg = host.getSettings().mobile?.httpBridge;
  if (httpBridgeCfg?.enabled && httpBridgeCfg.token) {
    const httpServer = await startHttpMcpServer({
      deps: mcpDeps,
      port: httpBridgeCfg.port,
      host: httpBridgeCfg.host,
      token: httpBridgeCfg.token,
      allowedOrigins: httpBridgeCfg.allowedOrigins,
    });
    process.on('SIGINT', () => httpServer.close());
    process.on('SIGTERM', () => httpServer.close());
  }

  // Always-on local HTTP bridge for the VS Code / Copilot extension.
  // Binds exclusively on 127.0.0.1 — never reachable from outside the machine.
  // Token is auto-generated on first start and persisted in settings so the
  // extension reconnects without re-configuration. Skipped only if the mobile
  // bridge is already bound to the same loopback port (avoids EADDRINUSE).
  {
    const currentSettings = host.getSettings();
    const localPort = currentSettings.vscode?.localBridgePort ?? 3457;
    const mobileConflicts = httpBridgeCfg?.enabled
      && httpBridgeCfg.host === '127.0.0.1'
      && httpBridgeCfg.port === localPort;

    if (!mobileConflicts) {
      let localToken = currentSettings.vscode?.localBridgeToken;
      if (!localToken) {
        localToken = randomUUID();
        await host.setSettings({ vscode: { localBridgeToken: localToken, localBridgePort: localPort } });
      }
      try {
        const localHttpServer = await startHttpMcpServer({
          deps: mcpDeps,
          port: localPort,
          host: '127.0.0.1',
          token: localToken,
          allowedOrigins: [],
        });
        process.on('SIGINT', () => localHttpServer.close());
        process.on('SIGTERM', () => localHttpServer.close());
        console.error(`[graphnosis-sidecar] local HTTP bridge (VS Code) on http://127.0.0.1:${localPort}/mcp`);
      } catch (e) {
        console.error(`[graphnosis-sidecar] local HTTP bridge on :${localPort} failed (port in use?): ${(e as Error).message}`);
      }
    }
  }

  // Service connector manager. Always created (even with zero configs) so
  // connectors.install works on a fresh cortex. Started after IPC so webhook
  // and pull traffic doesn't race against the IPC socket being ready.
  const connectorsCfg = host.getSettings().connectors ?? {
    configs: [], webhookPort: 3458, webhookHost: '127.0.0.1', pullIntervalMs: 15 * 60 * 1000,
  };
  const connectorManager = new ConnectorManager(host, connectorsCfg);

  // Tauri shell IPC (custom JSON-RPC, not MCP).
  const ipcSocketPath = process.env.GRAPHNOSIS_IPC_SOCKET
    ?? path.join(env.cortexDir, 'sidecar.sock');
  await startIpc({
    host,
    socketPath: ipcSocketPath,
    pendingDiffs,
    restartMcpListener,
    broadcastRaw,
    connectorManager,
    brainEngine,
    llm: () => (host.getSettings().ai.llmEnabled === true ? llm : null),
  });
  console.error(`[graphnosis-sidecar] IPC listening on ${ipcSocketPath}`);

  // Fire background engram load — intentionally not awaited so the sidecar
  // is immediately usable on the default engram. broadcastRaw is live here,
  // so the UI receives incremental progress events as each graph finishes.
  void (async () => {
    await loadAllGraphsFromDisk(host, env.cortexDir, env.defaultGraph, broadcastRaw);
    await backfillGraphMetadata(host);
  })();

  await connectorManager.start();
  brainEngine.start();
  process.on('SIGINT', () => { void connectorManager.stop(); brainEngine.stop(); });
  process.on('SIGTERM', () => { void connectorManager.stop(); brainEngine.stop(); });

  // (Previously: a 60s timer that force-closed MCP connections idle > 15
  // min. Removed in favor of an amber-bubble idle indicator in the
  // desktop UI — see renderMcpStatus() — which keeps stale entries
  // visible but visually distinct, while letting the user decide whether
  // to manually kick them via the × button. `mcpRegistry.sweepIdle()`
  // remains available as a method if a future caller wants explicit
  // bulk cleanup, just not on a timer.)

  // MCP server over stdio — the legacy path. Stays active so existing
  // configurations (where Claude Desktop spawns this binary directly) keep
  // working. Logs go to stderr only; stdout is the MCP transport.
  // When the App is the parent (Tauri-spawn), stdin is null → this server
  // sits idle, which is fine.
  await startStdioMcpServer(mcpDeps);
}

main().catch((e) => {
  console.error('[graphnosis-sidecar] fatal:', e);
  process.exit(1);
});
