import net from 'node:net';
import https from 'node:https';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { markClientActivity, BACKGROUND_POLL_METHODS, notifyClientRequestComplete } from './client-activity.js';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';
import type { GraphnosisHost } from './host.js';
import { ingestFile, ingestWeb, ingestClip } from './ingest.js';
import {
  DOCS_ENGRAM_ID,
  isDocsGhostEngram,
  recreateAndIngestDocsEngram,
} from './docs-ingest.js';
import { BUNDLED_DOCS } from './docs-content.generated.js';
import { ingestBundledSkillDemos } from './skill-demos-ingest.js';
import { BUNDLED_SKILL_DEMOS } from './skill-demos.generated.js';
import type { BroadcastRawFn } from './events.js';
import { broadcastOplogCompacted } from './sidecar-idle-maintenance.js';
import { mcpRegistry } from './mcp-registry.js';
import { skillRunToListItem, deriveSkillRunStatus } from './skill-runs.js';
import { loadCatalogDrift } from './catalog-drift.js';
import { applyCorrection as runApplyCorrection, proposeCorrection } from './correction.js';
import {
  linkSkillSequence,
  linkSkillGoals,
  linkSkillLoopsAndBranches,
  linkSkillContextEdges,
  linkSkillCalls,
  linkCrossEngramCalls,
  skillEngramIds,
  walkSkillSequence,
  formatSkillForRecall,
  baseSkillName,
  classifyChunkRole,
} from './skill-trainer.js';
import { SkillSnapshotStore } from './skill-snapshots.js';
import type { CorrectionDiff } from './correction.js';
import { oplog } from '@nehloo-interactive/graphnosis-secure-sync';
import { withEmbedding } from './embedding-queue.js';
import type { ConnectorManager } from './connectors/manager.js';
import { getAdminPolicy, isProviderDisabled, setAdminPolicy } from './admin-policy.js';
import { getConsentPhraseForTier, type McpCallTool } from './mcp-server.js';
import {
  filterStructuredRecallNodes,
  formatGroupedRecallList,
  formatNodeBullet,
  formatStructuredRecallList,
  looksGroupedResponse,
  stripRecallAuditTrail,
  type StructuredRecallNode,
} from './ghampus-recall-format.js';
import {
  revokeConsent,
  SHARING_TOKEN_ROLES,
  SHARING_ROLE_LABELS,
  enterpriseSsoPublicView,
  isEnterpriseSsoConfigured,
  resolveRoleFromIdpGroups,
  sanitizeEnterpriseSsoSettings,
  sanitizeEngramCatalogEntry,
  sanitizeEngramCatalogSettings,
  engramCatalogPublicEntry,
  checkCatalogInstallEntitlement,
  resolveCatalogEntitlements,
  buildMdmEngramCatalogBundle,
  generateCatalogEntryId,
  type SharingRole,
  type EnterpriseSsoSettings,
  type IdpGroupRoleMapping,
  type EngramCatalogEntry,
} from '@graphnosis-app/core/settings';
import {
  readCatalogSubscriptions,
  subscribeCatalogEntry,
  unsubscribeCatalogEntry,
  recordInstalledPackage,
} from './catalog-subscriptions.js';
import {
  catalogHasSsoSession,
  checkRecallSsoGate,
  CATALOG_SSO_REQUIRED_MESSAGE,
} from './catalog-sso-gate.js';
import { readSsoUnlockOffer, discoverSsoUnlock, idpUiHints, probeIdpReachability } from '@graphnosis-app/core/sso';
import { resolveClassificationPolicy, sanitizeClassificationSchema } from '@graphnosis-app/core';
import type { GraphMetadata } from '@graphnosis-app/core/settings';
import {
  isCortexSessionBusy,
  isSessionLeaseFresh,
  readSessionLease,
} from '@graphnosis-app/core/cortex';

// Local IPC between Tauri shell and Node sidecar. Newline-delimited JSON over a
// Unix-domain socket on macOS/Linux (Windows uses a named pipe — same socket API).
//
// Tauri sends requests like { id, method, params }; sidecar replies { id, result | error }.

const Request = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

/** Fixed slug for the bundled skill demos engram. Stays in sync with the
 * displayName 'Skill Demos' via setGraphMetadata at ingest time. The id is
 * what every IPC + sidecar code path looks up (rename-safe); the display
 * name is purely user-facing. */
const SKILL_DEMOS_ENGRAM_ID = 'graphnosis-skill-demos';

// Cooperative cancellation handles for long-running operations. Each is a
// module-scope `AbortController | null` because only one of each operation
// can run at a time (we serialize via the running loop's existence — kicking
// off a new switch while one is in flight would replace the controller and
// the prior signal would never fire). The cancel IPC handlers call
// `.abort()` on these; the host loops poll between engrams and bail.
let currentEmbeddingSwitchAbort: AbortController | null = null;
let currentReingestAbort: AbortController | null = null;

// Ghampus clarification state — persists across IPC calls (module scope).
// Set when Ghampus can't confidently classify a message and asks the user
// to confirm. Cleared when the user replies or sends an unrelated message.
let ghampusPendingClarification: {
  originalText: string;   // the user's ambiguous message
  content: string;        // extracted save content
  engramHint: string | null;
} | null = null;

// Set when a save is blocked because the target engram doesn't exist yet.
// Cleared when the engram is created (auto-saves) or user sends a new unrelated message.
let ghampusPendingEngram: {
  content: string;        // the content to save once the engram is created
  engramHint: string;     // the name the user intended (slug-normalised on use)
} | null = null;

/**
 * Walk an arbitrary IPC result and replace characters that produce invalid
 * JSON when round-tripped through a strict parser (serde_json on the Tauri
 * side). Specifically:
 *
 *  - Lone UTF-16 surrogates (high without low or vice versa) — JS strings
 *    are permitted to contain these but JSON.stringify echoes them as raw
 *    `\uDxxx` escapes that serde_json rejects mid-parse.
 *  - Control characters outside the JSON-allowed set (\b \f \n \r \t) —
 *    JSON.stringify *does* escape these properly to `\uXXXX`, so most
 *    parsers accept them, but some implementations are stricter. We replace
 *    them defensively too.
 *
 * Real-world trigger: a JPEG (or other binary file) accidentally ingested
 * as text leaves nodes whose `contentPreview` and `entities` contain raw
 * binary bytes. A single such node corrupts the IPC response and makes
 * `list_nodes` fail for the whole engram. Sanitizing here keeps the engram
 * usable; the offending node renders with U+FFFD ("�") in place of the
 * bad bytes so the user can locate it and forget it from the UI.
 *
 * Performance: O(total string length). For 3.7k nodes ≈ 2 MB of text the
 * extra walk is well under 50ms — acceptable per-request cost given the
 * alternative is "your engram appears empty".
 */
function sanitizeForIpc(value: unknown): unknown {
  if (typeof value === 'string') {
    // Replace lone high surrogates (D800-DBFF NOT followed by DC00-DFFF)
    // and lone low surrogates (DC00-DFFF NOT preceded by D800-DBFF), plus
    // unescapable control chars. Three passes is cheaper than one regex
    // that tries to do everything.
    return value
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '�')
      .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, (_m, p) => `${p}�`)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0E-\x1F\x7F]/g, '�');
  }
  if (Array.isArray(value)) return value.map(sanitizeForIpc);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeForIpc(v);
    }
    return out;
  }
  return value;
}

export interface IpcDeps {
  host: GraphnosisHost;
  socketPath: string;
  /** Absolute path to the cortex directory. Used for GEZ signing-key storage. */
  cortexDir?: string;
  /** Same Map shared with the MCP server — proposed corrections waiting for user approval. */
  pendingDiffs: Map<string, { graphId: string; diff: CorrectionDiff; createdAt: number }>;
  /** Closes + reopens the MCP socket listener — used by the "Reconnect" button in the inspector. */
  restartMcpListener: () => Promise<void>;
  /** Push arbitrary frames to all event-socket subscribers (e.g. ingest progress). */
  broadcastRaw: BroadcastRawFn;
  /** Service connector manager. Always present; starts with empty config if no connectors exist yet. */
  connectorManager: ConnectorManager;
  /** Alive Brain engine. Null before the cortex is fully unlocked or if BrainEngine failed to start. */
  brainEngine?: import('./brain-engine.js').BrainEngine | null;
  /**
   * Lazy LLM accessor — returns the LocalLlm when the user has enabled it,
   * null otherwise. Mirrors the pattern used by mcpDeps.llm. Used by the
   * `ai.synthesizeSearchResults` and `ai.rerankSearchResults` IPCs.
   */
  llm?: () => import('./correction.js').LocalLlm | null;
  /** Skill trainer — personalize AI skills using cortex memories. */
  skillTrainer?: import('./skill-trainer.js').SkillTrainer | null;
  /** License validator — Ed25519 subscription gate for skill training and GSK packs. */
  licenseValidator?: import('./license-validator.js').LicenseValidator | null;
  /** Proactive watcher — surfaces skill-match cards into the Ghampus chat thread. */
  proactiveWatcher?: import('./proactive-watcher.js').ProactiveWatcher | null;
  /** Ghampus stale-skill maintenance — drains skillRetrainQueue during idle windows. */
  skillMaintenanceScheduler?: import('./skill-maintenance-scheduler.js').SkillMaintenanceScheduler | null;
  /**
   * Unified MCP tool dispatcher — routes to the exact same handler as external
   * AI clients for all 47+ tools. Used by Ghampus so no tool logic is duplicated.
   * Absent only in contexts where no MCP server was built (e.g. some unit tests).
   */
  callMcpTool?: McpCallTool;
  /** Present when the desktop session was unlocked via Enterprise SSO (not owner). */
  ssoSession?: {
    role: SharingRole;
    email?: string;
    subject?: string;
  };
}

/** Returns true when socketPath is a TCP address like "127.0.0.1:PORT". */
function isTcpAddress(socketPath: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(socketPath);
}

/**
 * Detected Tailscale Serve state. `host` is the MagicDNS name; the two
 * `*Https` flags say whether Serve is fronting that local port with a real
 * https cert, and the `*HttpsUrl` carry the public origin to advertise.
 *
 * Two independent mappings matter because the browser UI and the MCP bridge
 * live on different local ports (3456 / 3457) and Tailscale Serve fronts ONE
 * backend per https endpoint:
 *   tailscale serve --bg http://127.0.0.1:3456            → https://host/        (UI, port 443)
 *   tailscale serve --bg --https=8443 http://127.0.0.1:3457 → https://host:8443/ (MCP)
 */
interface TailscaleServeInfo {
  host: string;
  /** Back-compat alias for uiHttps (older callers read `.https`). */
  https: boolean;
  uiHttps: boolean;
  uiHttpsUrl?: string;
  mcpHttps: boolean;
  mcpHttpsUrl?: string;
}

/**
 * Best-effort detection of this machine's Tailscale MagicDNS name and which
 * local ports Tailscale Serve fronts over HTTPS. Used to hand the browser/QR
 * and the MCP QR `https://<host>.<tailnet>.ts.net[:port]` URLs (valid cert, no
 * iOS ATS exception) instead of plain `http://100.x:PORT`. Returns null if
 * Tailscale isn't found or status can't be read; callers fall back to http.
 *
 * @param uiPort  local browser-UI port (default 3456)
 * @param mcpPort local MCP-bridge port (default 3457)
 */
async function detectTailscaleServe(uiPort: number, mcpPort: number): Promise<TailscaleServeInfo | null> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const candidates = [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale', // macOS GUI app
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
  ];
  let bin: string | null = null;
  for (const c of candidates) {
    try { await run(c, ['version'], { timeout: 2000 }); bin = c; break; }
    catch { /* try next */ }
  }
  if (!bin) return null;

  let host = '';
  try {
    const { stdout } = await run(bin, ['status', '--json'], { timeout: 3000 });
    const dns = (JSON.parse(stdout) as { Self?: { DNSName?: string } })?.Self?.DNSName;
    if (dns) host = dns.replace(/\.$/, ''); // strip trailing dot → host.tailnet.ts.net
  } catch { /* status unavailable */ }
  if (!host) return null;

  let uiHttps = false, mcpHttps = false;
  let uiHttpsUrl: string | undefined, mcpHttpsUrl: string | undefined;

  // Build the public origin for an https endpoint on `port` (omit :443).
  const origin = (port: number): string => `https://${host}${port === 443 ? '' : `:${port}`}`;

  // Preferred path: parse `serve status --json` and map each https web handler
  // to the local backend port it proxies, so we know WHICH service (UI vs MCP)
  // is reachable over https and on which public port.
  let parsedJson = false;
  try {
    const { stdout } = await run(bin, ['serve', 'status', '--json'], { timeout: 3000 });
    if (stdout?.trim()) {
      const status = JSON.parse(stdout) as {
        Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
      };
      for (const [endpoint, cfg] of Object.entries(status.Web ?? {})) {
        // endpoint key shape: "host.tailnet.ts.net:443"
        const publicPort = Number(endpoint.split(':').pop()) || 443;
        for (const handler of Object.values(cfg.Handlers ?? {})) {
          const proxy = handler.Proxy ?? '';
          if (proxy.includes(`:${uiPort}`)) { uiHttps = true; uiHttpsUrl = origin(publicPort); }
          if (proxy.includes(`:${mcpPort}`)) { mcpHttps = true; mcpHttpsUrl = origin(publicPort); }
        }
      }
      parsedJson = true;
    }
  } catch { /* fall through to the legacy heuristic */ }

  // Legacy fallback: older `tailscale serve status` has no JSON. We can only
  // tell that *some* https handler is active, not which port — assume it's the
  // UI (the common single-mapping setup) and leave MCP as http.
  if (!parsedJson) {
    try {
      const { stdout } = await run(bin, ['serve', 'status'], { timeout: 3000 });
      if (stdout && /https|:443\b/i.test(stdout)) { uiHttps = true; uiHttpsUrl = origin(443); }
    } catch { /* give up — http fallback */ }
  }

  return {
    host,
    https: uiHttps,
    uiHttps,
    mcpHttps,
    ...(uiHttpsUrl !== undefined ? { uiHttpsUrl } : {}),
    ...(mcpHttpsUrl !== undefined ? { mcpHttpsUrl } : {}),
  };
}

export async function startIpc(deps: IpcDeps): Promise<net.Server> {
  if (!isTcpAddress(deps.socketPath)) {
    // 0o700 dir: the IPC socket dispatches privileged methods (passphrase
    // change, purge, node edit/delete). Keep the directory owner-only.
    await fs.mkdir(path.dirname(deps.socketPath), { recursive: true, mode: 0o700 });
    await fs.rm(deps.socketPath, { force: true });
  }

  const server = net.createServer((sock) => {
    // EPIPE / ECONNRESET = client closed before we finished writing.
    // Without this handler the error propagates as an uncaught exception
    // and takes the whole sidecar down.
    sock.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPIPE' && code !== 'ECONNRESET') {
        console.error('[graphnosis-sidecar] IPC socket error:', err);
      }
    });
    let buf = '';
    sock.on('data', async (chunk) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let req: z.infer<typeof Request>;
        try {
          req = Request.parse(JSON.parse(line));
        } catch (e) {
          sock.write(JSON.stringify({ id: null, error: String(e) }) + '\n');
          continue;
        }
        try {
          const result = await dispatch(deps, req.method, req.params);
          notifyClientRequestComplete(BACKGROUND_POLL_METHODS.has(req.method));
          // Sanitize string values before JSON-encoding. A node that was
          // ingested from a binary file (e.g. a JPEG mis-parsed as text)
          // can contain raw lone UTF-16 surrogates or unprintable bytes
          // in its content/entities. Node's JSON.stringify happily emits
          // those, but serde_json on the Tauri side rejects the resulting
          // text with "unexpected end of hex escape" mid-parse — meaning
          // a single bad node could make every list_nodes call fail and
          // the entire engram appear empty in the UI. Replacing the
          // offending characters with U+FFFD keeps the response parseable
          // and lets the user see the bad node (and forget it).
          sock.write(JSON.stringify({ id: req.id, result: sanitizeForIpc(result) }) + '\n');
        } catch (e) {
          notifyClientRequestComplete(BACKGROUND_POLL_METHODS.has(req.method));
          // Log full stack to stderr so the dev terminal shows it; return
          // a multi-line message to the caller so the UI surfaces the cause.
          const err = e instanceof Error ? e : new Error(String(e));
          console.error(`[graphnosis-sidecar] IPC method '${req.method}' failed:`, err);
          const message = err.stack ?? err.message;
          sock.write(JSON.stringify({ id: req.id, error: message }) + '\n');
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    if (isTcpAddress(deps.socketPath)) {
      const colonIdx = deps.socketPath.lastIndexOf(':');
      const host = deps.socketPath.slice(0, colonIdx);
      const port = parseInt(deps.socketPath.slice(colonIdx + 1), 10);
      server.listen(port, host, () => resolve(server));
    } else {
      server.listen(deps.socketPath, () => {
        // Restrict the Unix socket to the owner (listen() uses the umask).
        fs.chmod(deps.socketPath, 0o600).catch((err) => {
          console.error(`[graphnosis-sidecar] could not chmod IPC socket: ${(err as Error).message}`);
        });
        resolve(server);
      });
    }
  });
}

/** Throws a user-facing error when the Studio subscription is not active. */
function assertStudioEnabled(_deps: IpcDeps): void {
  // bypassed — gate off during development
}

/**
 * True when the user has ANY paid plan in flight — personal subscription,
 * Teams seat, Enterprise seat, or a domain-seat token granted via OTP.
 *
 * Why this exists: v1.15.6 fixed domain-seat token validation to accept
 * tokens with an empty `features` array (some OTP-minted tokens carry
 * no explicit features, the seat itself is the entitlement). Code that
 * gates only on `features.includes(...)` will reject those tokens and
 * treat the user as Free even though they're on an enterprise allowlist.
 *
 * Treat the presence of either a verified personal token OR a verified
 * domain-seat token as paid. Free users have no verified token at all.
 */
async function hasAnyPaidPlan(deps: IpcDeps): Promise<boolean> {
  const primary = await deps.host.getLicenseToken();
  if (primary && deps.licenseValidator?.verifyToken(primary)) return true;
  const settings = deps.host.getSettings();
  const domain = settings.domainSeatLicenseToken ?? null;
  if (domain && deps.licenseValidator?.verifyToken(domain)) return true;
  return false;
}

/**
 * Resolve the user's plan tier — `'free' | 'pro' | 'teams' | 'enterprise'`
 * — from the license JWT. The Ghampus surface is open to every tier; this
 * is just so the chat UI can render contextual upsells ("on Pro this would
 * auto-distill") and so per-tool handlers can gate features that map to
 * paid LicenseFeatures. Domain-seat tokens without explicit features are
 * treated as Enterprise — they're by definition org-managed allowlist
 * entitlements.
 */
async function resolveAgentPlan(deps: IpcDeps): Promise<'free' | 'pro' | 'teams' | 'enterprise'> {
  const token = await getEffectiveLicenseToken(deps);
  if (deps.licenseValidator?.hasFeature(token, 'enterprise')) return 'enterprise';
  if (deps.licenseValidator?.hasFeature(token, 'teams')) return 'teams';
  // Any of the Pro feature markers — skill-training, foresight,
  // gnn-exploration, mcp-tool-control — means a paid Pro plan.
  for (const f of ['skill-training', 'foresight', 'gnn-exploration', 'mcp-tool-control'] as const) {
    if (deps.licenseValidator?.hasFeature(token, f)) return 'pro';
  }
  // Domain-seat token present but with no explicit features → org-managed,
  // treat as Enterprise. Caught after the feature scans so explicit Pro/
  // Teams tokens take precedence if both are configured.
  const settings = deps.host.getSettings();
  const domain = settings.domainSeatLicenseToken ?? null;
  if (domain && deps.licenseValidator?.verifyToken(domain)) return 'enterprise';
  return 'free';
}

/** Flatten a byGraph Map into a score-sorted candidate array for the threshold slider. */
function flattenByGraph(
  byGraph: Map<string, Array<{ nodeId: string; score: number; text: string; type?: string }>>,
): Array<{ nodeId: string; graphId: string; score: number; text: string; type?: string }> {
  const all: Array<{ nodeId: string; graphId: string; score: number; text: string; type?: string }> = [];
  for (const [graphId, nodes] of byGraph) {
    for (const n of nodes) {
      all.push({ nodeId: n.nodeId, graphId, score: n.score, text: n.text, ...(n.type ? { type: n.type } : {}) });
    }
  }
  return all.sort((a, b) => b.score - a.score);
}

/** In-flight docs ingest job — coalesce duplicate triggers (boot ghost + UI reingest). */
let docsIngestJobId: string | null = null;
let docsIngestInflight: Promise<void> | null = null;

/** Await boot/UI docs ingest started via startBackgroundDocsIngest (no-op if idle). */
export function whenBackgroundDocsIngestDone(): Promise<void> {
  return docsIngestInflight ?? Promise.resolve();
}

/** Kick off bundled docs ingest in the background. Returns immediately with a
 *  jobId; progress + completion arrive via `docs.progress` / `docs.done` on the
 *  events socket (same pattern as ingest.upload / recovery.apply). */
export function startBackgroundDocsIngest(
  deps: IpcDeps,
  appVersion: string,
  reason: 'user' | 'boot-ghost' = 'user',
): { accepted: boolean; jobId: string } {
  if (docsIngestInflight) {
    return { accepted: true, jobId: docsIngestJobId! };
  }
  const jobId = `docs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  docsIngestJobId = jobId;
  const totalPages = BUNDLED_DOCS.length;
  deps.broadcastRaw({
    kind: 'docs.progress', name: 'docs.progress',
    payload: { jobId, phase: 'started', totalPages, reason },
  });
  docsIngestInflight = (async () => {
    try {
      const { ingested, failed } = await recreateAndIngestDocsEngram(
        deps.host,
        appVersion,
        (p) => {
          deps.broadcastRaw({
            kind: 'docs.progress', name: 'docs.progress',
            payload: { jobId, ...p },
          });
        },
      );
      deps.broadcastRaw({
        kind: 'docs.done', name: 'docs.done',
        payload: { jobId, ingested, failed },
      });
      deps.brainEngine?.notifyIngestComplete();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[graphnosis-sidecar] background docs ingest failed:', e);
      deps.broadcastRaw({
        kind: 'docs.done', name: 'docs.done',
        payload: { jobId, ingested: 0, failed: totalPages, error: message },
      });
    } finally {
      docsIngestJobId = null;
      docsIngestInflight = null;
    }
  })();
  return { accepted: true, jobId };
}

/** Kick off a background file ingest with progress/done events broadcast to the
 *  events socket. Shared by the path-based `ingest.file` and the upload-based
 *  `ingest.upload`. Returns immediately with a jobId; `afterDone` runs in a
 *  finally (used to delete an uploaded temp file). */
function startBackgroundIngest(
  deps: IpcDeps,
  graphId: string,
  filePath: string,
  fileName: string,
  afterDone?: () => Promise<void> | void,
): { accepted: boolean; jobId: string } {
  const jobId = `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  deps.broadcastRaw({
    kind: 'ingest.progress', name: 'ingest.progress',
    payload: { jobId, graphId, fileName, phase: 'parsing', nodesAdded: 0, edgesAdded: 0 },
  });
  void (async () => {
    try {
      const result = await ingestFile(deps.host, graphId, filePath, {
        onProgress: (pagesProcessed, totalPages) => deps.broadcastRaw({ kind: 'ingest.progress', name: 'ingest.progress', payload: { jobId, graphId, fileName, phase: 'parsing', nodesAdded: 0, pagesProcessed, totalPages } }),
        onEmbeddingStart: (pagesExtracted) => deps.broadcastRaw({ kind: 'ingest.progress', name: 'ingest.progress', payload: { jobId, graphId, fileName, phase: 'embedding', nodesAdded: 0, pagesExtracted } }),
        onEmbeddingChunk: (chunksDone, chunksTotal, nodesTotal) => deps.broadcastRaw({ kind: 'ingest.progress', name: 'ingest.progress', payload: { jobId, graphId, fileName, phase: 'embedding', nodesAdded: nodesTotal, chunksDone, chunksTotal } }),
        wrapIngest: (fn) => withEmbedding(fn),
        triggeredBy: 'user:ingest',
      });
      const nodeCount = (result as { nodeIds?: string[] }).nodeIds?.length ?? 0;
      deps.broadcastRaw({ kind: 'ingest.done', name: 'ingest.done', payload: { jobId, graphId, fileName, nodeIds: (result as { nodeIds?: string[] }).nodeIds ?? [], nodesAdded: nodeCount } });
      deps.brainEngine?.notifyIngestComplete();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes('0 bytes')) console.error(`[graphnosis-sidecar] background ingest failed for ${filePath}:`, e);
      deps.broadcastRaw({ kind: 'ingest.done', name: 'ingest.done', payload: { jobId, graphId, fileName, error: message, nodesAdded: 0 } });
    } finally {
      try { await afterDone?.(); } catch { /* cleanup best-effort */ }
    }
  })();
  return { accepted: true, jobId };
}

// Read CA certs from the OS trust store so corporate SSL-inspection proxies
// (whose root CA is trusted by the OS but not Node's bundled CA list) work.
// macOS: reads from system keychain via `security` CLI.
// Windows: delegates to win-ca which reads the Windows Certificate Store.
// Linux: reads the distro's system PEM bundle file.
async function getSystemCAs(): Promise<string[]> {
  if (process.platform === 'darwin') {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const keychains = [
        '/Library/Keychains/SystemRootCertificates.keychain',
        '/Library/Keychains/System.keychain',
      ];
      const results = await Promise.allSettled(
        keychains.map((kc) => run('security', ['find-certificate', '-a', '-p', kc])),
      );
      const pem: string[] = [];
      const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
      for (const r of results) {
        if (r.status === 'fulfilled') {
          let m: RegExpExecArray | null;
          while ((m = re.exec(r.value.stdout)) !== null) pem.push(m[0]);
        }
      }
      return pem;
    } catch {
      return [];
    }
  }
  if (process.platform === 'win32') {
    try {
      const winCa = await import('win-ca');
      const certs: string[] = [];
      winCa.inject('+');
      winCa.each((cert: Buffer) => {
        const b64 = cert.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
        if (b64) certs.push(`-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`);
      });
      return certs;
    } catch {
      return [];
    }
  }
  if (process.platform === 'linux') {
    const candidates = [
      '/etc/ssl/certs/ca-certificates.crt',            // Debian / Ubuntu
      '/etc/pki/tls/certs/ca-bundle.crt',              // RHEL / CentOS / Fedora
      '/etc/ssl/ca-bundle.pem',                        // OpenSUSE
      '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem', // RHEL alternative
    ];
    for (const p of candidates) {
      try {
        const pem = await (await import('node:fs')).promises.readFile(p, 'utf8');
        const certs: string[] = [];
        const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(pem)) !== null) certs.push(m[0]);
        if (certs.length > 0) return certs;
      } catch { /* try next */ }
    }
    return [];
  }
  return [];
}

// node:https wrapper that injects system CAs so corporate SSL-inspection
// proxies work. Returns { status, body }. Rejects on network/timeout error.
async function httpsGetLicense(url: string, timeoutMs = 15_000): Promise<{ status: number; body: string }> {
  const systemCAs = await getSystemCAs();
  const agent = systemCAs.length > 0
    ? new https.Agent({ ca: [...systemCAs, ...https.globalAgent.options.ca as string[] ?? []] })
    : undefined;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** Returns the highest-tier valid license token across the personal slot
 *  (licenseEnc via host.getLicenseToken) and the domain seat slot
 *  (domainSeatLicenseToken stored directly in settings).
 *  Tier rank: enterprise (4) > teams (3) > skill-training/Pro (2) > other (1). */
async function getEffectiveLicenseToken(deps: IpcDeps): Promise<string | null> {
  const primary = await deps.host.getLicenseToken();
  const settings = deps.host.getSettings();
  const domain = settings.domainSeatLicenseToken ?? null;
  if (!domain) return primary;
  if (!primary) return domain;
  const tier = (token: string): number => {
    const payload = deps.licenseValidator?.verifyToken(token);
    if (!payload) return 0;
    const f = payload.features;
    if (f.includes('enterprise')) return 4;
    if (f.includes('teams')) return 3;
    if (f.includes('skill-training')) return 2;
    return 1;
  };
  return tier(domain) >= tier(primary) ? domain : primary;
}

async function hasEnterpriseAccess(deps: IpcDeps): Promise<boolean> {
  const licenseToken = await getEffectiveLicenseToken(deps);
  const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
  const settings = deps.host.getSettings();
  const domainSeat = (settings.domainSeatLicenseToken ?? null) !== null
    && deps.licenseValidator?.verifyToken(settings.domainSeatLicenseToken ?? '') !== null;
  return hasEnterprise || domainSeat;
}

/** Teams or Enterprise license — org catalog admin CRUD + SharePoint sync. */
async function hasTeamsOrEnterpriseAccess(deps: IpcDeps): Promise<boolean> {
  const licenseToken = await getEffectiveLicenseToken(deps);
  const hasTeams = deps.licenseValidator?.hasFeature(licenseToken, 'teams') ?? false;
  if (hasTeams) return true;
  return hasEnterpriseAccess(deps);
}

function catalogEntriesFromSettings(deps: IpcDeps): EngramCatalogEntry[] {
  const settings = deps.host.getSettings();
  return settings.engramCatalog?.entries ?? [];
}

function catalogInstallEntitlement(
  deps: IpcDeps,
  entry: EngramCatalogEntry,
  groups: readonly string[],
) {
  return checkCatalogInstallEntitlement(entry, groups, {
    hasSsoSession: catalogHasSsoSession(deps),
  });
}

function catalogEntitlementMessage(entry: EngramCatalogEntry, reason: string): string {
  if (reason === 'missing_groups') {
    return `You are not in the IdP groups required for "${entry.displayName}".`;
  }
  if (reason === 'sso_required') {
    return CATALOG_SSO_REQUIRED_MESSAGE;
  }
  return `You are not entitled to access "${entry.displayName}".`;
}

/** Resolve hubRef to a local engram id for federated read pull. */
function resolveHubRefEngramId(hubRef: string, host: GraphnosisHost): string | null {
  const trimmed = hubRef.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('engram:')) {
    const id = trimmed.slice('engram:'.length).trim();
    return host.listGraphs().includes(id) ? id : null;
  }
  if (host.listGraphs().includes(trimmed)) return trimmed;
  return null;
}

/** Mint a catalog-scoped share token when IT sets defaultRole on subscribe/install. */
async function provisionCatalogDefaultRoleToken(
  deps: IpcDeps,
  entry: EngramCatalogEntry,
  engramId: string,
): Promise<{ tokenId?: string; created: boolean }> {
  if (!entry.defaultRole) return { created: false };
  const tokenName = `Catalog: ${entry.displayName}`;
  const current = deps.host.getSettings();
  const existing = current.sharing?.tokens ?? [];
  const match = existing.find((t) => t.name === tokenName && (
    Array.isArray(t.scope.engrams)
      ? t.scope.engrams.includes(engramId)
      : t.scope.engrams === '*'
  ));
  if (match) return { tokenId: match.id, created: false };
  const newToken = {
    id: randomUUID(),
    name: tokenName,
    scope: {
      engrams: [engramId] as string[],
      role: entry.defaultRole,
    },
    createdAt: Date.now(),
  };
  await deps.host.setSettings({
    ...current,
    sharing: { tokens: [...existing, newToken] },
  });
  return { tokenId: newToken.id, created: true };
}

/** Install catalog package — create engram shell and pull content when configured. */
async function installCatalogPackage(
  deps: IpcDeps,
  entry: EngramCatalogEntry,
): Promise<
  | { ok: true; engramId: string; contentPull: 'shell-only' | 'copied' | 'empty-source' | 'hub-slice-metadata' | 'hub-slice-pulled' }
  | { ok: false; reason: string; message: string }
> {
  const engramId = entry.packageId;
  const graphs = deps.host.listGraphs();
  if (!graphs.includes(engramId)) {
    await deps.host.createGraph(engramId);
    const schema = deps.host.complianceSchema();
    const meta: GraphMetadata = {
      template: entry.itControlled ? 'compliance' : 'team',
      displayName: entry.displayName,
      createdAt: Date.now(),
    };
    if (entry.defaultClassificationLabelId && schema?.enabled) {
      meta.classificationLabelId = entry.defaultClassificationLabelId;
      meta.sensitivityTier = resolveClassificationPolicy(
        entry.defaultClassificationLabelId,
        schema,
        meta,
      ).tier;
    }
    if (entry.requireSsoSession === true) {
      meta.requireSsoSession = true;
    }
    await deps.host.setGraphMetadata(engramId, meta);
  }

  if (entry.installMode === 'merge-copy' && entry.sourceEngramId?.trim()) {
    const sourceId = entry.sourceEngramId.trim();
    if (!deps.host.listGraphs().includes(sourceId)) {
      return {
        ok: false,
        reason: 'source_missing',
        message: `Source engram "${sourceId}" is not in this cortex — publish content to the org hub first.`,
      };
    }
    await deps.host.ensureLoaded(sourceId);
    await deps.host.ensureLoaded(engramId);
    const { exportEngram, importEngram } = await import('./engram-pack.js');
    const { pack } = await exportEngram(deps.host, sourceId, {});
    const { result } = await importEngram(deps.host, pack, {
      targetEngramId: engramId,
      skipExisting: false,
    });
    return {
      ok: true,
      engramId,
      contentPull: result.imported > 0 ? 'copied' : 'empty-source',
    };
  }

  if (entry.kind === 'hub-slice' && entry.hubRef?.trim()) {
    const meta = deps.host.getGraphMetadata(engramId);
    await deps.host.setGraphMetadata(engramId, {
      ...(meta ?? {}),
      template: entry.itControlled ? 'compliance' : 'team',
      displayName: entry.displayName,
      createdAt: meta?.createdAt ?? Date.now(),
      ...(entry.requireSsoSession === true ? { requireSsoSession: true } : {}),
    });
    const hubEngramId = resolveHubRefEngramId(entry.hubRef, deps.host);
    if (hubEngramId) {
      await deps.host.ensureLoaded(hubEngramId);
      await deps.host.ensureLoaded(engramId);
      const { exportEngram, importEngram } = await import('./engram-pack.js');
      const { pack } = await exportEngram(deps.host, hubEngramId, {});
      const { result } = await importEngram(deps.host, pack, {
        targetEngramId: engramId,
        skipExisting: false,
      });
      return {
        ok: true,
        engramId,
        contentPull: result.imported > 0 ? 'hub-slice-pulled' : 'empty-source',
      };
    }
    return { ok: true, engramId, contentPull: 'hub-slice-metadata' };
  }

  return { ok: true, engramId, contentPull: 'shell-only' };
}

export async function dispatch(deps: IpcDeps, method: string, params: unknown): Promise<unknown> {
  // Mark client activity so heavy background brain passes defer to keep the UI
  // responsive — but NOT for the app's recurring reconciliation polls, or
  // background work would never get to run.
  if (!BACKGROUND_POLL_METHODS.has(method)) {
    markClientActivity();
    // LRU lazy-reload: if this user/AI call targets a specific engram that was
    // evicted to bound memory, bring it back BEFORE the handler runs (its sync
    // must() callers assume the graph is resident). Background polls are skipped
    // so they can't keep a cold engram pinned hot. ensureLoaded also records the
    // access, so the active engram stays resident.
    const gid = (params as Record<string, unknown> | undefined)?.['graphId'];
    if (typeof gid === 'string' && gid) await deps.host.ensureLoaded(gid);
  }
  switch (method) {
    // ── Consent prompt resolution (in-app modal flow) ──────────────────
    case 'consent.resolvePrompt': {
      // Frontend → sidecar: user clicked Allow/Deny on the consent modal.
      // The MCP server's pending Promise resolves with this choice and the
      // recall it was blocking proceeds (or errors with a clean "denied").
      const { resolvePrompt } = await import('./consent-prompts.js');
      const args = z.object({
        promptId: z.string().min(1),
        action: z.enum(['allow', 'deny']),
        // Required when action === 'allow'. Ignored otherwise.
        durationMs: z.number().int().nonnegative().optional(),
      }).parse(params ?? {});
      const choice = args.action === 'allow'
        ? { action: 'allow' as const, durationMs: args.durationMs ?? 3_600_000 }
        : { action: 'deny' as const };
      return { resolved: resolvePrompt(args.promptId, choice) };
    }
    case 'consent.listPendingPrompts': {
      const { listPendingPrompts } = await import('./consent-prompts.js');
      return listPendingPrompts();
    }

    // ── Per-client consent policy (first-connect + Settings → AI edit) ─
    case 'ai.setClientPolicy': {
      const policyChoice = z.enum([
        'always-allow', 'ask-grant-1h', 'ask-grant-1d', 'ask-every-time', 'never-allow',
      ]);
      const args = z.object({
        clientName: z.string().min(1),
        personalTier: policyChoice,
        sensitiveTier: policyChoice,
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      const nextPolicies = {
        ...(current.ai.clientPolicies ?? {}),
        [args.clientName]: {
          personalTier: args.personalTier,
          sensitiveTier: args.sensitiveTier,
          firstSeenAt:
            current.ai.clientPolicies?.[args.clientName]?.firstSeenAt ?? Date.now(),
        },
      };
      await deps.host.setSettings({ ai: { ...current.ai, clientPolicies: nextPolicies } });
      return { ok: true };
    }
    case 'ai.getClientPolicies': {
      return deps.host.getSettings().ai.clientPolicies ?? {};
    }

    // ── MCP tool-exposure allowlist (Pro/Teams/Enterprise) ─────────────
    case 'ai.setDisabledTools': {
      const args = z.object({ tools: z.array(z.string()) }).parse(params ?? {});
      // Editing the exposure allowlist is a Pro/Teams/Enterprise feature.
      // Accept the dedicated `mcp-tool-control` key OR — since the signing
      // service mints ALL Pro keys together for any Pro subscriber (see
      // license-validator.ts) — `skill-training` as the universal "is Pro+"
      // signal. This means current subscribers work immediately without the
      // issuer re-minting tokens; once issuance grants `mcp-tool-control`, that
      // path lights up too. Server-side enforcement in mcp-server.ts honors any
      // EXISTING denylist regardless of tier — only WRITES are gated here, so a
      // downgrade never silently re-exposes a tool.
      const licenseToken = await getEffectiveLicenseToken(deps);
      const isProSubscriber =
        (deps.licenseValidator?.hasFeature(licenseToken, 'mcp-tool-control') ?? false) ||
        (deps.licenseValidator?.hasFeature(licenseToken, 'skill-training') ?? false);
      if (!isProSubscriber) {
        return {
          ok: false,
          upgrade_required: true,
          message: 'Choosing which MCP tools are exposed to AI clients is a Pro/Teams/Enterprise feature.',
        };
      }
      const current = deps.host.getSettings();
      await deps.host.setSettings({ ai: { ...current.ai, disabledMcpTools: args.tools } });
      return { ok: true };
    }
    case 'ai.getDisabledTools': {
      return deps.host.getSettings().ai.disabledMcpTools ?? [];
    }

    // ── MCP connection lifecycle ───────────────────────────────────────
    case 'mcp.disconnect': {
      // Frontend × button: force-close one MCP connection. The relay
      // (Claude Desktop / Cursor / Zed) auto-reconnects on its next
      // tool call, so this is non-destructive — UX is "kick the stale
      // entry out of the panel; if the AI is actually still active it
      // reappears on its next request".
      const { mcpRegistry: registry } = await import('./mcp-registry.js');
      const args = z.object({ connId: z.string().min(1) }).parse(params ?? {});
      const kicked = registry.kick(args.connId);
      return { kicked };
    }

    case 'graphs.list': return deps.host.listGraphs();
    case 'graphs.listWithMetadata': {
      // includeUnloaded surfaces engrams that have metadata but aren't loaded
      // in memory yet (still in loadAllGraphsFromDisk's queue). The App opts
      // in so the picker can show the full set during boot.
      const args = z.object({ includeUnloaded: z.boolean().optional() })
        .safeParse(params ?? {});
      const includeUnloaded = args.success ? args.data.includeUnloaded === true : false;
      return deps.host.graphsWithMetadata({ includeUnloaded });
    }
    // Reconciliation cursor — returns {graphId: lastMutationTs} for all
    // loaded graphs. Cheap (memo read, microseconds). The App polls this
    // periodically as a safety net for the push-event channel: if a
    // push frame was dropped (backpressure, socket reconnect, sidecar
    // restart between events), this catches the drift on the next tick.
    case 'node.cursor': return deps.host.getMutationCursor();
    case 'graphs.setMetadata': {
      const args = z.object({
        graphId: z.string(),
        template: z.enum([
          'personal', 'journal', 'reading', 'learning',
          'project', 'research', 'codebase', 'health',
          'team', 'compliance', 'onboarding', 'skill',
        ]),
        displayName: z.string().min(1),
        createdAt: z.number().int().nonnegative().optional(),
      }).parse(params);
      await deps.host.setGraphMetadata(args.graphId, {
        template: args.template,
        displayName: args.displayName,
        createdAt: args.createdAt ?? Date.now(),
      });
      return { ok: true };
    }
    case 'graphs.createWithTemplate': {
      const args = z.object({
        graphId: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'graphId must be slug-like'),
        template: z.enum([
          'personal', 'journal', 'reading', 'learning',
          'project', 'research', 'codebase', 'health',
          'team', 'compliance', 'onboarding', 'skill',
        ]),
        displayName: z.string().min(1),
      }).parse(params);
      {
        // Free tier: max 3 user engrams. System engrams (docs, skill-demos)
        // don't count — they're auto-created by the app, not by the user.
        const licenseToken = await getEffectiveLicenseToken(deps);
        const hasPaidPlan = (deps.licenseValidator?.verifyToken(licenseToken ?? '') ?? null) !== null;
        if (!hasPaidPlan) {
          const SYSTEM_ENGRAMS = new Set([DOCS_ENGRAM_ID, SKILL_DEMOS_ENGRAM_ID]);
          const userEngrams = deps.host.listGraphs().filter(id => !SYSTEM_ENGRAMS.has(id));
          if (userEngrams.length >= 3) {
            return { error: { code: 'ENGRAM_LIMIT_REACHED', message: 'Free plan is limited to 3 engrams. Upgrade to Pro for unlimited engrams.', limit: 3, upgradeUrl: 'https://graphnosis.com/upgrade' } };
          }
        }
      }
      await deps.host.createGraph(args.graphId);
      await deps.host.setGraphMetadata(args.graphId, {
        template: args.template,
        displayName: args.displayName,
        createdAt: Date.now(),
      });
      return { ok: true, graphId: args.graphId };
    }
    case 'graphs.acceptEngramSuggestion': {
      // One-shot create-then-ingest used by the App's UI when the user
      // accepts a "Create engram?" banner that was suggested by an MCP
      // `remember` call with an unresolved target_engram. Idempotent on
      // the create side — if a graph with this slug already exists (the
      // user might have created it manually between the AI suggestion
      // and the click), we skip the create and go straight to ingest.
      //
      // Single IPC roundtrip so the App UI doesn't have to choreograph
      // create + ingest + error handling across two calls.
      const args = z.object({
        graphId: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, 'graphId must be slug-like'),
        template: z.enum([
          'personal', 'journal', 'reading', 'learning',
          'project', 'research', 'codebase', 'health',
          'team', 'compliance', 'onboarding', 'skill',
        ]),
        displayName: z.string().min(1),
        text: z.string().min(1),
        label: z.string().default('Conversation note'),
        sourceKind: z.enum(['clip', 'ai-conversation', 'skill']).optional(),
      }).parse(params);
      // listGraphs returns the in-memory loaded set — accurate for "does
      // this engram already exist" because all engrams are loaded at
      // sidecar startup.
      const existed = deps.host.listGraphs().includes(args.graphId);
      if (!existed) {
        // Free tier engram limit — same gate as graphs.createWithTemplate.
        const licenseToken = await getEffectiveLicenseToken(deps);
        const hasPaidPlan = (deps.licenseValidator?.verifyToken(licenseToken ?? '') ?? null) !== null;
        if (!hasPaidPlan) {
          const SYSTEM_ENGRAMS = new Set([DOCS_ENGRAM_ID, SKILL_DEMOS_ENGRAM_ID]);
          const userEngrams = deps.host.listGraphs().filter(id => !SYSTEM_ENGRAMS.has(id));
          if (userEngrams.length >= 3) {
            return { error: { code: 'ENGRAM_LIMIT_REACHED', message: 'Free plan is limited to 3 engrams. Upgrade to Pro for unlimited engrams.', limit: 3, upgradeUrl: 'https://graphnosis.com/upgrade' } };
          }
        }
        await deps.host.createGraph(args.graphId);
        await deps.host.setGraphMetadata(args.graphId, {
          template: args.template,
          displayName: args.displayName,
          createdAt: Date.now(),
        });
      }
      const rec = await withEmbedding(() =>
        ingestClip(deps.host, args.graphId, args.text, args.label, {
          sourceKind: args.sourceKind ?? 'clip',
          triggeredBy: 'user:ingest',
        }),
      );
      return {
        ok: true,
        graphId: args.graphId,
        sourceId: rec.sourceId,
        engramCreated: !existed,
      };
    }
    case 'search.nodes': {
      const args = z.object({
        graphId: z.string(),
        query: z.string(),
        k: z.number().int().positive().max(200).optional(),
      }).parse(params);
      // A deleted (or never-loaded) engram has nothing to search. Return empty
      // QUIETLY instead of letting must() throw "Graph not loaded" on every
      // call — a stale client (e.g. an MCP client or the global-search cache)
      // can hammer a just-deleted engram and flood the log + waste an embed.
      if (!deps.host.listGraphs().includes(args.graphId)) return [];
      const hits = await withEmbedding(() => deps.host.searchNodes(args.graphId, args.query, args.k ?? 30));
      // Enrich each hit with its true allowlist sourceId so the client can
      // redact per-source precisely in Presentation Mode (the SDK's source.file
      // string is NOT the allowlist sourceId). getNodeSource is a Map lookup.
      return hits.map((h) => ({ ...h, sourceId: deps.host.getNodeSource(args.graphId, h.nodeId) }));
    }
    case 'nodes.list': {
      const args = z.object({ graphId: z.string() }).parse(params);
      // A node read can arrive moments after the engram was deleted/unloaded
      // (a stale 3D view or in-flight poll still pointing at it). Return empty
      // instead of letting must() throw "Graph not loaded" + a stack trace —
      // benign race, not an error. (Mirrors the search.nodes guard.)
      if (!deps.host.listGraphs().includes(args.graphId)) return [];
      await deps.host.waitForReconcile(args.graphId);
      const nodes = deps.host.listNodes(args.graphId);
      // Attach allowlist sourceId per node (see search.nodes note).
      return nodes.map((n) => ({ ...n, sourceId: deps.host.getNodeSource(args.graphId, n.id) }));
    }
    case 'edges.list': {
      const args = z.object({ graphId: z.string() }).parse(params);
      // Same post-delete race guard as nodes.list — the 3D view fetches both.
      if (!deps.host.listGraphs().includes(args.graphId)) return [];
      await deps.host.waitForReconcile(args.graphId);
      return deps.host.listEdges(args.graphId);
    }
    case 'node.directEdit': {
      // Inline-edit a node's content from the App's detail pane. Bypasses
      // the correct/apply pending-diff dance — the user just typed the
      // new text, no LLM proposal needed. Op-log records `editNode` so
      // history is preserved.
      const args = z.object({
        graphId: z.string(),
        nodeId: z.string(),
        content: z.string().min(1),
        reason: z.string().optional(),
      }).parse(params);
      await deps.host.applyCorrection(args.graphId, {
        edits: [{
          kind: 'edit',
          nodeId: args.nodeId,
          content: args.content,
          reason: args.reason ?? 'Direct edit from Graphnosis App',
        }],
      }, { triggeredBy: 'user:correct' });
      return { ok: true };
    }
    case 'node.softDelete': {
      // Forget a single node (soft-delete via SDK correction). Used by
      // the detail pane's Forget action + the Delete key shortcut.
      // Returns ok so the UI can refresh.
      const args = z.object({
        graphId: z.string(),
        nodeId: z.string(),
        reason: z.string().optional(),
      }).parse(params);
      await deps.host.applyCorrection(args.graphId, {
        edits: [{
          kind: 'delete',
          nodeId: args.nodeId,
          reason: args.reason ?? 'Forgotten from Graphnosis App',
        }],
      }, { triggeredBy: 'user:forget' });
      await deps.host.obligationIndex.removeNodeIds([args.nodeId]);
      return { ok: true };
    }

    // ── source.* — Skills w/ Goals editor surface ────────────────────────
    // Bidirectional binding between the Trained Output box and the
    // graph. The editor calls these on every edit / reorder / remove /
    // insert / rename so the graph always matches what the user sees.
    // See plan: /Users/nelulazar/.claude/plans/let-s-plan-the-skills-piped-beacon.md

    case 'source.insertNode': {
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        // afterNodeId takes precedence when present:
        //   string → insert after this node in the source record
        //   null   → insert before the first visible (non-<!--) node
        // Falls back to position (legacy) when afterNodeId is absent.
        afterNodeId: z.string().nullable().optional(),
        position: z.number().int().min(0).optional(),
        content: z.string().min(1),
        role: z.string().optional(),
      }).parse(params);

      let insertPosition: number;
      const src = deps.host.getSourceRecord(args.graphId, args.sourceId);
      if (args.afterNodeId !== undefined) {
        if (args.afterNodeId === null) {
          // Insert before the first visible (non-metadata) node
          const now = Date.now();
          const nodeList = deps.host.listNodes(args.graphId);
          const nodeMap = new Map(nodeList.map((n) => [n.id, n]));
          const firstVis = src?.nodeIds.findIndex((id) => {
            const n = nodeMap.get(id);
            return n && n.confidence > 0.2
              && (n.validUntil === undefined || n.validUntil > now)
              && !n.contentPreview.trimStart().startsWith('<!--');
          }) ?? -1;
          insertPosition = firstVis >= 0 ? firstVis : 0;
        } else {
          // Insert immediately after the named node
          const afterIdx = src?.nodeIds.indexOf(args.afterNodeId) ?? -1;
          insertPosition = afterIdx >= 0 ? afterIdx + 1 : (src?.nodeIds.length ?? 0);
        }
      } else {
        insertPosition = args.position ?? 0;
      }

      const result = await deps.host.insertNodeAt(
        args.graphId,
        args.sourceId,
        insertPosition,
        args.content,
        {
          triggeredBy: 'ipc:source.insertNode',
          ...(args.role !== undefined ? { role: args.role } : {}),
        },
      );
      // Refresh all SOP edges (sequence, loops, branches, ctx, sub-skill calls).
      void Promise.all([
        linkSkillSequence(deps.host, args.graphId, args.sourceId),
        linkSkillGoals(deps.host, args.graphId, args.sourceId),
        linkSkillLoopsAndBranches(deps.host, args.graphId, args.sourceId),
        linkSkillContextEdges(deps.host, args.graphId, args.sourceId),
        linkSkillCalls(deps.host, args.graphId, args.sourceId, args.graphId),
        linkCrossEngramCalls(deps.host, deps.host.skillCallLinks, args.graphId, args.sourceId, skillEngramIds(deps.host)),
      ]).catch(() => {});
      return { ok: true, nodeId: result.nodeId };
    }

    case 'source.reorderNodes': {
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        newOrder: z.array(z.string().min(1)),
      }).parse(params);
      try {
        await deps.host.reorderSourceNodes(args.graphId, args.sourceId, args.newOrder, {
          triggeredBy: 'ipc:source.reorderNodes',
        });
        void Promise.all([
          linkSkillSequence(deps.host, args.graphId, args.sourceId),
          linkSkillLoopsAndBranches(deps.host, args.graphId, args.sourceId),
          linkSkillContextEdges(deps.host, args.graphId, args.sourceId),
          linkSkillCalls(deps.host, args.graphId, args.sourceId, args.graphId),
          linkCrossEngramCalls(deps.host, deps.host.skillCallLinks, args.graphId, args.sourceId, skillEngramIds(deps.host)),
        ]).catch(() => {});
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: 'reorder_failed', message: (e as Error).message };
      }
    }

    case 'source.removeNode': {
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        nodeId: z.string().min(1),
        reason: z.string().optional(),
      }).parse(params);
      try {
        await deps.host.removeNodeFromSource(args.graphId, args.sourceId, args.nodeId, {
          triggeredBy: 'ipc:source.removeNode',
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        void Promise.all([
          linkSkillSequence(deps.host, args.graphId, args.sourceId),
          linkSkillLoopsAndBranches(deps.host, args.graphId, args.sourceId),
          linkSkillContextEdges(deps.host, args.graphId, args.sourceId),
          linkSkillCalls(deps.host, args.graphId, args.sourceId, args.graphId),
          linkCrossEngramCalls(deps.host, deps.host.skillCallLinks, args.graphId, args.sourceId, skillEngramIds(deps.host)),
        ]).catch(() => {});
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: 'remove_failed', message: (e as Error).message };
      }
    }

    case 'source.rename': {
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        newRef: z.string().min(1),
      }).parse(params);
      await deps.host.renameSource(args.graphId, args.sourceId, args.newRef, {
        triggeredBy: 'ipc:source.rename',
      });
      return { ok: true };
    }

    case 'source.listNodes': {
      // Single render source for the Trained Output editor — returns each
      // node's FULL content (via host.getFullNodeContent) in source.nodeIds
      // order. Skips soft-deleted nodes so the editor doesn't render
      // tombstones.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
      }).parse(params);
      if (deps.skillTrainer) {
        await deps.skillTrainer.repairHollowSkillSource(args.graphId, args.sourceId);
      }
      const rec = deps.host.getSourceRecord(args.graphId, args.sourceId);
      if (!rec) {
        return { ok: false, reason: 'unknown_source', nodes: [] };
      }
      // Build a live-id set so we drop soft-deleted nodes (confidence ≤ 0.2)
      // from the editor view.
      const now = Date.now();
      const wantedIds = new Set(rec.nodeIds);
      const liveIds = new Set<string>();
      for (const n of deps.host.listNodes(args.graphId)) {
        if (!wantedIds.has(n.id)) continue;
        if (n.confidence <= 0.2) continue;
        if (n.validUntil !== undefined && n.validUntil <= now) continue;
        liveIds.add(n.id);
        if (liveIds.size === wantedIds.size) break;
      }
      // Attach the canonical chunk role (title / metadata / goal-* / recipe /
      // recalled-memory / body) so the Trained Output editor can group goal
      // sections under a meta header and number only the body steps — instead
      // of guessing by a weaker prefix test. Roles are derived heuristically
      // from content + position (we don't persist them), exactly as the export
      // formatter does, so classifiedCount counts non-metadata chunks in order.
      let chunkIndex = 0;
      let classifiedCount = 0;
      const nodes: Array<{ id: string; content: string; role: string }> = [];
      for (const id of rec.nodeIds) {
        if (!liveIds.has(id)) continue;
        const content = deps.host.getFullNodeContent(args.graphId, id) ?? '';
        if (!content) continue;
        const role = classifyChunkRole(content, chunkIndex, classifiedCount);
        if (role !== 'metadata') classifiedCount++;
        nodes.push({ id, content, role });
        chunkIndex++;
      }
      return { ok: true, nodes };
    }

    case 'node.link': {
      // Create an UNDIRECTED typed edge between two existing nodes.
      // Powers the App's typed-relationship picker for inherently-
      // symmetric labels (Same person, Same topic, Partners with,
      // Related). Idempotent — returns `created: false` if an edge of
      // the same type already connects this pair (in either order).
      const args = z.object({
        graphId: z.string(),
        fromNodeId: z.string(),
        toNodeId: z.string(),
        // The full set of undirected edge types the SDK supports.
        // Defaulted to 'related-to' if the caller omits.
        type: z.enum([
          'similar-to',
          'co-occurs',
          'shares-entity',
          'shares-topic',
          'same-source',
          'same-person',
          'related-to',
        ]).optional(),
        reason: z.string().optional(),
      }).parse(params);
      const linkOpts: { type?: import('@nehloo/graphnosis').UndirectedEdge['type']; reason?: string } = {};
      if (args.type !== undefined) linkOpts.type = args.type;
      if (args.reason !== undefined) linkOpts.reason = args.reason;
      const result = await deps.host.linkNodes(
        args.graphId,
        args.fromNodeId,
        args.toNodeId,
        linkOpts,
      );
      return result;
    }
    case 'node.linkDirected': {
      // Create a DIRECTED typed edge between two existing nodes. Used
      // by the App's typed-relationship picker for asymmetric labels
      // (Knows, Works with, Reports to, Lives in, Works at, …).
      //
      // The Zod enum below catches type-name typos at the boundary —
      // far better than letting the SDK throw from inside the adapter.
      // `evidence` carries the user-friendly label (e.g. "Works at")
      // so the detail pane renders the user's vocabulary, not the
      // structural SDK type.
      const args = z.object({
        graphId: z.string(),
        fromNodeId: z.string(),
        toNodeId: z.string(),
        type: z.enum([
          'causes',
          'depends-on',
          'precedes',
          'contains',
          'defines',
          'cites',
          'contradicts',
          'supports',
          'supersedes',
          'discussed-in',
          'knows',
          'works-with',
          'reports-to',
          'collaborated-on',
          'prefers',
          'summarizes',
        ]),
        evidence: z.string().optional(),
      }).parse(params);
      const linkOpts: { type: import('@nehloo/graphnosis').DirectedEdge['type']; evidence?: string } = {
        type: args.type,
      };
      if (args.evidence !== undefined) linkOpts.evidence = args.evidence;
      const result = await deps.host.linkNodesDirected(
        args.graphId,
        args.fromNodeId,
        args.toNodeId,
        linkOpts,
      );
      return result;
    }
    case 'node.unlink': {
      // Remove a single edge by its SDK edge id. The UI calls this
      // before re-linking with a new type so the old edge doesn't
      // linger. Idempotent — returns `{ removed: false }` if the
      // edge was already gone.
      const args = z.object({
        graphId: z.string(),
        edgeId: z.string(),
      }).parse(params);
      const result = await deps.host.unlinkEdge(args.graphId, args.edgeId);
      return result;
    }
    case 'activity.list': {
      // Optional bounding: `since` (ms epoch) + `limit`. The Audit view omits
      // both (wants everything); the Home digest passes `since` so it never
      // drags the entire op-log over IPC on a large cortex (which was timing
      // out the 5s budget and silently hiding the digest).
      // `ops` filters to specific op kinds BEFORE the limit slice — so a rare
      // type (forgetSource, ingestSource) can be pulled from the full op-log
      // without being buried under millions of autonomous-brain edge events.
      const a = z.object({
        since: z.number().int().nonnegative().optional(),
        until: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().optional(),
        ops: z.array(z.string()).optional(),
        actor: z.string().optional(), // server-side "who made it" filter (full op-log)
      }).parse(params ?? {});
      // Who-made-it classification — mirrors the desktop's activityActor +
      // friendlyClient so the actor labels in the row badges (client-rendered)
      // match the dropdown + server filter exactly. Keep in sync with main.ts.
      const friendlyClientName = (name?: string): string => {
        if (!name) return 'Unknown client';
        const map: Record<string, string> = {
          'claude-ai': 'Claude Desktop', 'claude-desktop': 'Claude Desktop',
          'claude-code': 'Claude Code', 'cursor-vscode': 'Cursor', 'cursor': 'Cursor',
          'zed': 'Zed', 'windsurf': 'Windsurf',
        };
        if (map[name]) return map[name]!;
        if (name.startsWith('local-agent-mode-')) return 'Claude Skills agent';
        return name;
      };
      const actorOf = (ev: { after?: unknown; before?: unknown }): { label: string; cls: string } => {
        const aa = (ev.after ?? {}) as Record<string, unknown>;
        const bb = (ev.before ?? {}) as Record<string, unknown>;
        const client = (aa['addedBy'] ?? aa['correctedBy']) as string | undefined;
        if (client) return { label: friendlyClientName(client), cls: 'ai' };
        const trig = ((aa['triggeredBy'] ?? bb['triggeredBy']) as string | undefined) ?? '';
        const reason = ((aa['reason'] ?? bb['reason']) as string | undefined) ?? '';
        if (trig.startsWith('user:')) return { label: 'You', cls: 'user' };
        if (trig.startsWith('brain:') || /\bbrain:|auto-relink|auto-link/i.test(reason)) return { label: 'Autonomous brain', cls: 'brain' };
        if (/user-confirmed/i.test(reason)) return { label: 'You', cls: 'user' };
        if (trig.startsWith('ipc:')) return { label: 'App', cls: 'app' };
        return { label: 'System', cls: 'app' };
      };
      let events = await deps.host.listOplogEvents();
      if (a.since !== undefined) events = events.filter((ev) => ev.ts > a.since!);
      if (a.until !== undefined) events = events.filter((ev) => ev.ts <= a.until!);
      if (a.ops !== undefined && a.ops.length > 0) {
        const set = new Set(a.ops);
        events = events.filter((ev) => set.has(ev.op));
      }
      // Distinct actors across the WHOLE current scope (since/until/ops), before
      // the limit slice — so the desktop's "who" dropdown is complete even when
      // the recent-N window is dominated by one actor's events.
      const actorSet = new Set<string>();
      for (const ev of events) actorSet.add(actorOf(ev).label);
      const actors = [...actorSet].sort((x, y) => x.localeCompare(y));
      // Server-side actor filter — applied across the full op-log, like `ops`.
      if (a.actor) events = events.filter((ev) => actorOf(ev).label === a.actor);
      if (a.limit !== undefined) {
        events = events.slice().sort((x, y) => y.ts - x.ts).slice(0, a.limit);
      } else {
        events = events.slice().sort((x, y) => y.ts - x.ts);
      }
      // ── Node-content enrichment ────────────────────────────────────────
      // The op-log stores opaque node ids. The Activity UI can only resolve
      // ids that belong to the engram CURRENTLY loaded in the desktop, so
      // rows for other engrams (or background-brain ops) showed bare ids
      // ("2fNzp1WtPShx…"). Resolve them here instead: the sidecar can reach
      // EVERY loaded engram's nodes. We build a per-graph id→preview map
      // lazily (only for graphs that actually appear in the returned slice)
      // and attach a `resolved` block the client prefers over the raw id.
      // Soft-deleted nodes may no longer be inspectable — those keep the id.
      const loadedSet = new Set(deps.host.listGraphs());
      const previewCache = new Map<string, Map<string, string>>();
      const previewMap = (graphId: string): Map<string, string> => {
        let m = previewCache.get(graphId);
        if (!m) {
          m = new Map();
          if (loadedSet.has(graphId)) {
            try {
              for (const n of deps.host.listNodes(graphId) as Array<{ id: string; contentPreview?: string }>) {
                if (n.contentPreview) m.set(n.id, n.contentPreview);
              }
            } catch { /* graph unreadable — leave map empty */ }
          }
          previewCache.set(graphId, m);
        }
        return m;
      };
      const clipPrev = (s: string | undefined): string | undefined =>
        s ? (s.length > 160 ? s.slice(0, 160) : s) : undefined;
      const enriched = events.map((ev) => {
        const m = previewMap(ev.graphId);
        const after = (ev.after ?? {}) as Record<string, unknown>;
        const resolved: { target?: string; from?: string; to?: string } = {};
        let targetSourceId: string | undefined;
        if (ev.target?.kind === 'node') {
          const p = clipPrev(m.get(ev.target.id));
          if (p) resolved.target = p;
          // Resolve the node's allowlist sourceId so the Activity row can be
          // redacted per-source in Presentation Mode (precise, not fail-safe).
          // GUARD: the op-log spans EVERY engram that ever existed — including
          // deleted/archived/not-yet-loaded ones (gbrain-notes-*). getNodeSource
          // does a hard must() that throws "Graph not loaded" for those, and a
          // single throw here aborts the whole .map → activity.list fails → the
          // Activity page times out. Only resolve for loaded graphs; swallow the
          // rest (the row keeps its raw id, which is fine — fail-safe).
          if (loadedSet.has(ev.graphId)) {
            try {
              targetSourceId = deps.host.getNodeSource(ev.graphId, ev.target.id);
            } catch { /* soft-deleted node or unreadable graph — leave id */ }
          }
        }
        if (ev.op === 'addEdge' || ev.op === 'deleteEdge') {
          const from = clipPrev(m.get(after['fromNodeId'] as string));
          const to = clipPrev(m.get(after['toNodeId'] as string));
          if (from) resolved.from = from;
          if (to) resolved.to = to;
        }
        // Attach the computed actor so the desktop's row badge matches the
        // dropdown + filter exactly (one source of truth, no label drift).
        const who = actorOf(ev);
        const extra: Record<string, unknown> = { actor: who.label, actorCls: who.cls };
        if (Object.keys(resolved).length > 0) extra['resolved'] = resolved;
        if (targetSourceId) extra['targetSourceId'] = targetSourceId;
        return { ...ev, ...extra };
      });
      // Sidecar housekeeping (not Ghampus): corrections sweep + maybe compact
      // the op-log after Activity/Audit pulls audit data. Fire-and-forget so
      // the IPC response is not blocked on compaction I/O.
      void deps.host.refreshAllCorrectionsFromOplog().then(({ compaction }) => {
        const record = deps.host.getLastOplogCompaction();
        broadcastOplogCompacted(deps.broadcastRaw, compaction, record?.at ?? Date.now());
      }).catch((e: unknown) => {
        console.error(
          `[graphnosis-ipc] activity.list oplog housekeeping failed: ${(e as Error).message}`,
        );
      });
      return { events: enriched, actors, lastCompaction: deps.host.getLastOplogCompaction() };
    }
    case 'activity.log': {
      const args = z.object({
        graphId: z.string(),
        limit: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(),
        ops: z.array(z.enum(['add', 'edit', 'delete', 'edge'])).optional(),
        search: z.string().optional(),
      }).parse(params ?? {});

      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;

      // 1. Fetch all events and filter to this graph.
      const allEvents = await deps.host.listOplogEvents();
      let events = allEvents.filter(ev => ev.graphId === args.graphId);

      // 2. Apply op-type filter.
      if (args.ops && args.ops.length > 0) {
        const opKindSet = new Set<string>();
        for (const opFilter of args.ops) {
          if (opFilter === 'add')    { opKindSet.add('ingestSource'); opKindSet.add('addNode'); }
          if (opFilter === 'edit')   { opKindSet.add('editNode');     opKindSet.add('supersede'); }
          if (opFilter === 'delete') { opKindSet.add('deleteNode');   opKindSet.add('forgetSource'); }
          if (opFilter === 'edge')   { opKindSet.add('addEdge');      opKindSet.add('deleteEdge'); }
        }
        events = events.filter(ev => opKindSet.has(ev.op));
      }

      // 3. Sort newest-first.
      events = events.slice().sort((a, b) => b.ts - a.ts);

      // 4. Build sourceId → ref map for enrichment.
      const sources = deps.host.listSources(args.graphId);
      const sourceRefMap = new Map<string, string>();
      for (const src of sources) {
        sourceRefMap.set(src.sourceId, src.ref);
      }

      // 5. Group addNode events under their ingestSource event.
      //    Collect addNode events keyed by (after as any).sourceId.
      const addNodesBySourceId = new Map<string, typeof events>();
      for (const ev of events) {
        if (ev.op === 'addNode') {
          const sid = (ev.after as Record<string, unknown> | undefined)?.sourceId as string | undefined;
          if (sid) {
            const bucket = addNodesBySourceId.get(sid) ?? [];
            bucket.push(ev);
            addNodesBySourceId.set(sid, bucket);
          }
        }
      }

      // Identify sourceIds covered by an ingestSource event in this set.
      const ingestSourceIds = new Set<string>();
      for (const ev of events) {
        if (ev.op === 'ingestSource') {
          ingestSourceIds.add(ev.target.id);
        }
      }

      interface ActivityEntry {
        id: string;
        ts: number;
        op: string;
        graphId: string;
        target: { kind: string; id: string };
        preview?: string | undefined;
        sourceRef?: string | undefined;
        nodeCount?: number | undefined;
        triggeredBy?: string | undefined;
        nodes?: Array<{ id: string; ts: number; target: { kind: string; id: string }; preview?: string | undefined }>;
      }

      const entries: ActivityEntry[] = [];

      for (const ev of events) {
        if (ev.op === 'addNode') {
          // If this node belongs to an ingestSource that appeared in the same
          // filtered set, it will be grouped — skip the standalone row.
          const sid = (ev.after as Record<string, unknown> | undefined)?.sourceId as string | undefined;
          if (sid && ingestSourceIds.has(sid)) continue;
        }

        if (ev.op === 'ingestSource') {
          const sourceId = ev.target.id;
          const childNodes = addNodesBySourceId.get(sourceId) ?? [];
          const ingestTriggeredBy = (ev.after as Record<string, unknown> | undefined)?.triggeredBy as string | undefined;

          const nodeEntries = childNodes.map(n => {
            const nPreview = deps.host.getNodeSource(args.graphId, n.target.id) !== undefined
              ? ((n.after as Record<string, unknown> | undefined)?.contentPreview as string | undefined)
              : undefined;
            return {
              id: n.id,
              ts: n.ts,
              target: n.target,
              preview: nPreview,
            };
          });

          entries.push({
            id: ev.id,
            ts: ev.ts,
            op: 'ingestGroup',
            graphId: ev.graphId,
            target: ev.target,
            sourceRef: sourceRefMap.get(sourceId),
            nodeCount: childNodes.length,
            ...(ingestTriggeredBy !== undefined ? { triggeredBy: ingestTriggeredBy } : {}),
            nodes: nodeEntries,
          });
          continue;
        }

        // All other event types: build a plain ActivityEntry.
        let preview: string | undefined;
        let sourceRef: string | undefined;

        if (ev.op === 'deleteNode') {
          preview = (ev.before as Record<string, unknown> | undefined)?.preview as string | undefined;
          const sid = (ev.before as Record<string, unknown> | undefined)?.sourceId as string | undefined;
          if (sid) sourceRef = sourceRefMap.get(sid);
        } else if (ev.op === 'addNode') {
          preview = (ev.after as Record<string, unknown> | undefined)?.contentPreview as string | undefined;
          const sid = (ev.after as Record<string, unknown> | undefined)?.sourceId as string | undefined;
          if (sid) sourceRef = sourceRefMap.get(sid);
        } else if (ev.op === 'editNode' || ev.op === 'supersede') {
          preview = (ev.after as Record<string, unknown> | undefined)?.contentPreview as string | undefined;
        } else if (ev.op === 'forgetSource') {
          preview = (ev.before as Record<string, unknown> | undefined)?.ref as string | undefined;
        }

        const evTriggeredBy = (ev.after as Record<string, unknown> | undefined)?.triggeredBy as string | undefined;
        entries.push({
          id: ev.id,
          ts: ev.ts,
          op: ev.op,
          graphId: ev.graphId,
          target: ev.target,
          preview,
          sourceRef,
          ...(evTriggeredBy !== undefined ? { triggeredBy: evTriggeredBy } : {}),
        });
      }

      // 6. Apply search filter.
      let filtered = entries;
      if (args.search && args.search.length > 0) {
        const needle = args.search.toLowerCase();
        filtered = entries.filter(e =>
          (e.preview ?? '').toLowerCase().includes(needle) ||
          (e.sourceRef ?? '').toLowerCase().includes(needle) ||
          ((e.target as { id: string }).id ?? '').toLowerCase().includes(needle),
        );
      }

      // 7. Paginate.
      const total = filtered.length;
      const page = filtered.slice(offset, offset + limit);

      void deps.host.refreshAllCorrectionsFromOplog().then(({ compaction }) => {
        const record = deps.host.getLastOplogCompaction();
        broadcastOplogCompacted(deps.broadcastRaw, compaction, record?.at ?? Date.now());
      }).catch((e: unknown) => {
        console.error(
          `[graphnosis-ipc] activity.log oplog housekeeping failed: ${(e as Error).message}`,
        );
      });
      return {
        entries: page,
        total,
        hasMore: offset + limit < total,
        lastCompaction: deps.host.getLastOplogCompaction(),
      };
    }
    case 'snapshots.list': {
      return { snapshots: await deps.host.listSnapshots() };
    }
    case 'snapshots.create': {
      return deps.host.createSnapshot();
    }
    case 'graphs.create': {
      const { graphId } = z.object({ graphId: z.string() }).parse(params);
      await deps.host.createGraph(graphId);
      return { ok: true };
    }
    case 'graphs.setArchived': {
      const args = z.object({
        graphId: z.string(),
        archived: z.boolean(),
      }).parse(params);
      await deps.host.setGraphArchived(args.graphId, args.archived);
      return { ok: true };
    }
    case 'graphs.setTier': {
      const args = z.object({
        graphId: z.string(),
        tier: z.enum(['public', 'personal', 'sensitive']),
      }).parse(params);
      await deps.host.setGraphTier(args.graphId, args.tier);
      return { ok: true };
    }
    case 'graphs.setClassificationLabel': {
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      const args = z.object({
        graphId: z.string(),
        labelId: z.string().min(1).nullable(),
      }).parse(params);
      const schema = deps.host.complianceSchema();
      if (schema?.enabled && args.labelId) {
        const label = schema.labels.find((l) => l.id === args.labelId && l.enabled !== false);
        if (!label) {
          return { ok: false, reason: 'unknown_label', message: 'Classification label is not in the IT schema.' };
        }
        if (!hasEnterprise && label.userAssignable === false) {
          return { ok: false, reason: 'not_assignable', message: 'This label is IT-assigned only.' };
        }
      }
      await deps.host.setGraphClassificationLabel(args.graphId, args.labelId);
      return { ok: true };
    }
    case 'engram.setConfig': {
      // Update an engram's sensitivity tier and/or per-graph consent interval.
      // Both fields are optional; pass only the ones that changed.
      // Write-protected from MCP — only reachable from the Tauri UI process.
      const MAX_INTERVAL_MS = 15_552_000_000; // 6 months
      const args = z.object({
        engramId: z.string(),
        tier: z.enum(['public', 'personal', 'sensitive']).optional(),
        consentIntervalMs: z.union([
          z.literal(-1),
          z.number().int().min(0).max(MAX_INTERVAL_MS),
        ]).optional(),
        // When true, remove any per-graph consentIntervalMs override so the graph
        // falls back to the global tier default. Mutually exclusive with consentIntervalMs.
        clearConsentInterval: z.boolean().optional(),
      }).parse(params);
      await deps.host.updateEngramConfig(args.engramId, {
        ...(args.tier !== undefined ? { tier: args.tier } : {}),
        ...(args.consentIntervalMs !== undefined ? { consentIntervalMs: args.consentIntervalMs } : {}),
        ...(args.clearConsentInterval ? { clearConsentInterval: true } : {}),
      });
      return { ok: true };
    }
    case 'ai.getConsentPhrase': {
      // Returns the current consent phrase for a tier. Called only by the Tauri UI
      // to display in Settings → AI → Consent Phrases. NEVER accessible via MCP.
      const { tier } = z.object({ tier: z.enum(['personal', 'sensitive']) }).parse(params);
      const hmacKey = await deps.host.getOrCreateConsentHmacKey();
      return getConsentPhraseForTier(hmacKey, tier);
    }
    case 'ai.revokeConsents': {
      // Soft-expire all (or specific) consent records. Revocation takes effect immediately.
      // Optional filters: clientName and/or tier. Omit both to revoke everything.
      const args = z.object({
        clientName: z.string().optional(),
        tier: z.enum(['personal', 'sensitive']).optional(),
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      const revoked = revokeConsent(
        current.ai.dataAccessConsents,
        args.clientName,
        args.tier,
      );
      await deps.host.setSettings({ ai: { ...current.ai, dataAccessConsents: revoked } });
      return { revoked: true, count: (current.ai.dataAccessConsents?.length ?? 0) - revoked.filter(r => !r.withdrawnAt).length };
    }
    case 'ai.getConsentHistory': {
      // Returns all consent records (including revoked) for the consent history modal.
      const current = deps.host.getSettings();
      return { records: current.ai.dataAccessConsents ?? [] };
    }
    case 'ai.synthesizeSearchResults': {
      // Local-LLM "answer the question with citations" path. Given a query and
      // a small set of top hits, ask the LLM to write a 1-paragraph answer
      // using ONLY the provided snippets. Citations point back to nodeIds.
      // Never leaves the device.
      const args = z.object({
        query: z.string().min(1),
        hits: z.array(z.object({
          nodeId: z.string(),
          text: z.string(),
          sourceFile: z.string().optional(),
          score: z.number().optional(),
        })).min(1).max(15),
      }).parse(params);
      const llm = deps.llm?.() ?? null;
      if (!llm) {
        throw new Error('Local LLM is not enabled or not reachable. Configure in Settings → AI.');
      }
      const system =
        'You are a precise research assistant. The snippets below are raw excerpts from the user\'s ' +
        'personal memory — they may include OCR text, partial sentences, or metadata noise. ' +
        'Apply these rules strictly and in this order:\n\n' +
        '1. LANGUAGE (MANDATORY — highest priority): The search query language OVERRIDES everything else. ' +
        'Look at the search query word(s) only — ignore the language of the snippets entirely. ' +
        'If the query is English, respond in English even if every snippet is in French, Spanish, Romanian, etc. ' +
        'Example: query "sensors" → respond in English. Query "capteurs" → respond in French. ' +
        'If the query is one ambiguous word used in multiple languages, default to English.\n\n' +
        '2. LENGTH (MANDATORY): Your response MUST NOT exceed 60 words total. Count carefully. ' +
        'Cut mercilessly — one tight sentence per main point.\n\n' +
        '3. CITATIONS: Every claim MUST be followed immediately by the snippet number(s) in square brackets, ' +
        'e.g. [1] or [3, 7]. This is mandatory — never omit citations.\n\n' +
        '4. RELEVANCE CHECK:\n' +
        '   • If snippets clearly address the query: write ≤ 60 words grounded ONLY in the snippets.\n' +
        '   • If snippets are mostly noise or off-topic: say so in one sentence — do not fabricate content.\n' +
        '   • If snippets partially answer: state what you found and what is missing.\n\n' +
        '5. NEVER invent facts, never use outside knowledge, never speculate.\n\n' +
        'FORMAT: One plain paragraph only. No headings, no bullet lists, no bold, no italics, no markdown, ' +
        'no URLs, no links. Plain prose with citation numbers [N] only.';
      const numbered = args.hits
        .map((h, i) => `[${i + 1}] ${h.text}${h.sourceFile ? ` (source: ${h.sourceFile})` : ''}`)
        .join('\n\n');
      const user = `User searched for: "${args.query}"\n\nExcerpts from their personal memory:\n${numbered}\n\nAnswer:`;
      const synthesis = await llm.complete({ system, user });
      return {
        answer: synthesis.trim(),
        citedNodeIds: args.hits.map(h => h.nodeId),
      };
    }
    case 'ai.rerankSearchResults': {
      // Local-LLM "re-order top-k by judged relevance" path. Cheaper than
      // synthesis — the LLM returns a JSON array of nodeIds in best-first order.
      const args = z.object({
        query: z.string().min(1),
        hits: z.array(z.object({
          nodeId: z.string(),
          text: z.string(),
        })).min(1).max(30),
      }).parse(params);
      const llm = deps.llm?.() ?? null;
      if (!llm) {
        throw new Error('Local LLM is not enabled or not reachable. Configure in Settings → AI.');
      }
      const system =
        'You re-rank a list of memory snippets by how directly they answer the user\'s question. ' +
        'Return ONLY a JSON object with shape {"order":[snippet_number,...]} listing snippet numbers in best-first order. ' +
        'Include every snippet exactly once. No commentary, no markdown.';
      const numbered = args.hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n\n');
      const user = `Question: ${args.query}\n\nSnippets:\n${numbered}\n\nRespond with the JSON object only.`;
      const raw = await llm.complete({
        system,
        user,
        jsonSchema: { type: 'object', properties: { order: { type: 'array', items: { type: 'number' } } }, required: ['order'] },
      });
      let order: number[] = [];
      try {
        const parsed = JSON.parse(raw) as { order?: unknown };
        if (Array.isArray(parsed.order)) order = parsed.order.filter(n => typeof n === 'number') as number[];
      } catch { /* fall through to identity order */ }
      // Build the reordered nodeId list, falling back to original order for missing entries.
      const orderedNodeIds: string[] = [];
      const seen = new Set<number>();
      for (const n of order) {
        const idx = n - 1;
        if (idx >= 0 && idx < args.hits.length && !seen.has(idx)) {
          orderedNodeIds.push(args.hits[idx]!.nodeId);
          seen.add(idx);
        }
      }
      // Append any hits the LLM omitted, in original order, so nothing is lost.
      for (let i = 0; i < args.hits.length; i++) {
        if (!seen.has(i)) orderedNodeIds.push(args.hits[i]!.nodeId);
      }
      return { orderedNodeIds };
    }
    case 'graphs.rename': {
      const args = z.object({
        graphId: z.string(),
        displayName: z.string().min(1),
      }).parse(params);
      const existing = deps.host.getGraphMetadata(args.graphId);
      if (!existing) throw new Error(`graph ${args.graphId} not found`);
      await deps.host.setGraphMetadata(args.graphId, { ...existing, displayName: args.displayName });
      return { ok: true };
    }
    case 'graphs.delete': {
      const args = z.object({ graphId: z.string() }).parse(params);
      // Stop + remove any connector feeding this engram BEFORE deleting it.
      // Otherwise an in-flight pull keeps ingesting into the engram while we
      // delete it — which stalled the delete (thread contention) AND re-created
      // files (the .gll/.bundle) the instant after deleteGraph unlinked them.
      let removedConnectors: string[] = [];
      try { removedConnectors = await deps.connectorManager.removeForGraph(args.graphId); }
      catch (e) { console.error(`[graphs.delete] connector cleanup failed for '${args.graphId}': ${(e as Error).message}`); }
      await deps.host.deleteGraph(args.graphId);
      // Purge in-memory ghost edges from the brain engine's live caches.
      deps.brainEngine?.purgeDeletedGraph(args.graphId);
      return { ok: true, removedConnectors };
    }
    case 'graphs.load': {
      const { graphId } = z.object({ graphId: z.string() }).parse(params);
      await deps.host.loadGraph(graphId);
      return { ok: true };
    }
    case 'ingest.file': {
      // Path-based ingest (desktop / native file-drop). Runs in the background;
      // progress + completion broadcast to the events socket so the IPC returns
      // immediately — large PDFs easily exceed any sensible socket timeout.
      const { graphId, path: filePath } = z.object({ graphId: z.string(), path: z.string() }).parse(params);
      return startBackgroundIngest(deps, graphId, filePath, filePath.split('/').pop() ?? filePath);
    }
    case 'ingest.upload': {
      // Bytes-based ingest (browser / mobile drag-drop, which can't give file
      // paths). Write the bytes to a temp file — keeping the original filename
      // so the source ref + parse-by-extension both work — then run the normal
      // ingest and delete the temp file when done.
      const { graphId, filename, contentBase64 } = z.object({
        graphId: z.string(),
        filename: z.string(),
        contentBase64: z.string(),
      }).parse(params);
      const safeName = (filename.replace(/[/\\]/g, '_').trim().slice(0, 200)) || 'upload';
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graphnosis-upload-'));
      const tmpPath = path.join(dir, safeName);
      await fs.writeFile(tmpPath, Buffer.from(contentBase64, 'base64'));
      return startBackgroundIngest(deps, graphId, tmpPath, safeName, async () => {
        await fs.rm(dir, { recursive: true, force: true });
      });
    }
    case 'ingest.web': {
      const args = z.object({
        graphId: z.string(),
        url: z.string().url(),
        html: z.string().optional(),
        selection: z.string().optional(),
      }).parse(params);
      return withEmbedding(() => ingestWeb(deps.host, args.graphId, {
        url: args.url,
        ...(args.html !== undefined ? { html: args.html } : {}),
        ...(args.selection !== undefined ? { selection: args.selection } : {}),
        triggeredBy: 'user:ingest',
      }));
    }
    case 'ingest.clip': {
      const { graphId, text, label } = z.object({
        graphId: z.string(),
        text: z.string(),
        label: z.string().default('Clip'),
      }).parse(params);
      return withEmbedding(() => ingestClip(deps.host, graphId, text, label, { triggeredBy: 'user:ingest' }));
    }
    case 'stats.summary': {
      // Used by the Tauri inspector — lighter than `stats` with `includeNodes`.
      // Returns per-graph counts and source list (no node previews).
      //
      // `lastMutationAt` MUST be passed through: the App diff's it against
      // its `lastSeenMutationAt` cache to decide whether to reload the
      // active engram. Without this field every poll sees `undefined > N`
      // (false), so the counter on the Graphnosis main tab never refreshes
      // after an ingest — even though the push-event channel did fire.
      const s = deps.host.stats();
      return {
        graphs: s.graphs.map(g => ({
          graphId: g.graphId,
          totalNodes: g.totalNodes,
          activeNodes: g.activeNodes,
          softDeletedNodes: g.softDeletedNodes,
          sources: g.sources,
          corrections: g.corrections,
          lastMutationAt: g.lastMutationAt,
        })),
        sources: deps.host.listSources(),
      };
    }
    case 'sources.list': {
      const { graphId } = z.object({ graphId: z.string().optional() }).parse(params ?? {});
      return deps.host.listSources(graphId);
    }
    case 'sources.setExcluded': {
      // Toggle a source's exclude-from-recall flag (power-user). Excluded
      // sources' nodes are dropped from recall / dig_deeper / search but stay in
      // the Sources list, stats, and 3D. Takes effect on the next recall.
      const { graphId, sourceId, excluded } = z.object({
        graphId: z.string(), sourceId: z.string(), excluded: z.boolean(),
      }).parse(params);
      await deps.host.setSourceExcluded(graphId, sourceId, excluded);
      return { ok: true, excluded };
    }
    case 'sources.forget': {
      const { graphId, sourceId } = z.object({ graphId: z.string(), sourceId: z.string() }).parse(params);
      const result = await deps.host.forgetSource(graphId, sourceId, { triggeredBy: 'user:forget' });
      await deps.host.obligationIndex.removeForSource(graphId, sourceId);
      // Purge in-memory ghost edges from the brain engine's live caches.
      // host.forgetSource already cleaned the on-disk stores.
      if (result.nodeIds.length > 0) {
        deps.brainEngine?.purgeDeletedNodes(result.nodeIds);
      }
      return result;
    }
    case 'sources.reingest': {
      // "Forget + re-read from disk" round-trip. Surfaces re-chunked
      // content (e.g. after the user edited the file in Vim) into the
      // existing engram without making the user click Forget then re-drop
      // the file in. Only valid for file-backed sources — URLs would need
      // a fresh fetch (separate concern), clips don't have a "disk" to
      // reread, and ai-conversation has no source-of-truth file at all.
      const { graphId, sourceId } = z.object({ graphId: z.string(), sourceId: z.string() }).parse(params);
      const all = deps.host.listSources(graphId);
      const source = all.find((s) => s.sourceId === sourceId);
      if (!source) {
        throw new Error(`No source ${sourceId} in engram ${graphId}.`);
      }
      if (source.kind !== 'file') {
        throw new Error(
          `Only file-backed sources can be reingested. ` +
          `This source is a '${source.kind}' — use the original ingest path instead.`,
        );
      }
      // Forget the prior nodes first so the soft-deleted slots don't
      // double-up against the fresh node ids. Save() fires inside both
      // calls, so the push-event channel emits two mutation ticks; the
      // App's pollGraphMutations will pick up the second one and refresh.
      await deps.host.forgetSource(graphId, sourceId, { triggeredBy: 'user:ingest' });
      // Purge orphan active nodes left by any previous failed reingest.
      // A crash or IPC timeout mid-ingest can leave SDK-graph nodes with no
      // source record; their hashes block the full chunk count from being
      // restored on the next attempt.
      await deps.host.purgeOrphanNodes(graphId);
      const ref = source.ref;
      const record = await ingestFile(deps.host, graphId, ref, {
        wrapIngest: (fn) => withEmbedding(fn),
        triggeredBy: 'user:ingest',
      });
      return record;
    }
    case 'sources.move': {
      const { fromGraphId, sourceId, toGraphId } = z.object({
        fromGraphId: z.string(),
        sourceId: z.string(),
        toGraphId: z.string(),
      }).parse(params);
      const { newRecord, forgottenNodeIds } = await deps.host.moveSource(fromGraphId, sourceId, toGraphId);
      // Purge the in-memory cross-engram cache of stale entries anchored to
      // the old node IDs (the on-disk store was already cleaned inside
      // host.forgetSource, but ReinforcementEngine holds a live copy).
      if (forgottenNodeIds.length > 0) {
        deps.brainEngine?.purgeDeletedNodes(forgottenNodeIds);
      }
      // NOTE: we intentionally do NOT call runCrossEngramNow() here.
      // Each move already triggers kickoffRelink() inside host.ingest(), and
      // firing a full cross-engram pass per move on large engrams saturates the
      // event loop when the user moves several sources in quick succession.
      // The background cross-engram timer (brain-engine) picks it up after the
      // moves settle — a short delay is acceptable for relinking.
      return newRecord;
    }
    case 'corrections.list': {
      // Return every pending diff so the App can render its approval panel.
      // Sorted oldest-first so the user reviews them in creation order.
      const items = Array.from(deps.pendingDiffs.entries())
        .map(([diffId, v]) => ({
          diffId,
          graphId: v.graphId,
          createdAt: v.createdAt,
          reasoning: v.diff.reasoning ?? null,
          edits: v.diff.edits,
          adds: v.diff.adds,
        }))
        .sort((a, b) => a.createdAt - b.createdAt);
      return { pending: items };
    }
    case 'corrections.apply': {
      const { diffId } = z.object({ diffId: z.string() }).parse(params);
      const pending = deps.pendingDiffs.get(diffId);
      if (!pending) throw new Error(`No pending diff ${diffId}. It may have been applied or rejected already.`);
      await runApplyCorrection({ host: deps.host, graphId: pending.graphId, diff: pending.diff });
      deps.pendingDiffs.delete(diffId);
      return { ok: true, graphId: pending.graphId };
    }
    case 'corrections.reject': {
      const { diffId } = z.object({ diffId: z.string() }).parse(params);
      const existed = deps.pendingDiffs.delete(diffId);
      return { ok: existed };
    }
    case 'mcp.restartListener': {
      // Bounce the MCP socket: close the current listener, recreate it at
      // the same path. Any relay in auto-reconnect-wait sees the new socket
      // and connects on its next probe. Dead relays don't come back from
      // this — those need their parent (Claude Desktop, Cursor, etc.) to
      // respawn them.
      await deps.restartMcpListener();
      return { ok: true };
    }
    case 'mcp.status': {
      // Live registry of MCP clients currently connected to this sidecar
      // (socket transport for the relay-based clients, stdio for legacy
      // direct-spawn clients). The App polls this for its inspector panel.
      return { connections: mcpRegistry.list() };
    }
    case 'settings.get':
    case 'settings:get': {
      return deps.host.getSettings();
    }
    case 'fs.listDir': {
      // Server-side folder navigator for the browser/personal-server folder
      // picker (connectors' vault path). Lists DIRECTORY NAMES only — no file
      // contents — and is reachable only through the authed IPC/HTTP surface.
      // Defaults to the user's home directory.
      const { path: p } = z.object({ path: z.string().optional() }).parse(params ?? {});
      const base = (p && p.trim()) ? path.resolve(p) : os.homedir();
      const entries = await fs.readdir(base, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(base, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { path: base, parent: path.dirname(base), dirs };
    }
    case 'fs.listFiles': {
      // Enumerate FILE paths under a directory (for browser-mode +Files /
      // +Folders ingest). Extension filtering is done client-side by
      // partitionIngestPaths, so we return every regular file. Recursive walk
      // is depth-capped and skips dotfiles/dirs. Token-gated like fs.listDir.
      const { path: p, recursive } = z.object({
        path: z.string().min(1),
        recursive: z.boolean().optional(),
      }).parse(params ?? {});
      const root = path.resolve(p);
      const files: string[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        let entries: import('node:fs').Dirent[];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { if (recursive && depth < 6) await walk(full, depth + 1); }
          else if (e.isFile()) files.push(full);
        }
      };
      await walk(root, 0);
      return { files };
    }
    case 'quarantine.list': {
      // List every .gai.corrupt-<ts> / .bundle.corrupt-<ts> file currently
      // in the cortex's graphs/ directory. These are engrams that failed
      // integrity checks at load time and were auto-quarantined. The user
      // can delete them from Settings once they've recovered the engram.
      const graphsDir = path.join(deps.host.getCortexDir(), 'graphs');
      const out: Array<{
        name: string;
        engramId: string;
        kind: 'gai' | 'bundle';
        timestamp: number;
        sizeBytes: number;
        /** Whether an engram with this id currently exists in the live
         *  set. NOTE: this alone does NOT mean "recovered" — after an
         *  integrity failure the loader leaves an EMPTY stub engram with the
         *  same id, so this is true from the moment of corruption, before any
         *  "Recover from op-log" has run. Combine with `liveNodeCount`. */
        liveEngramExists: boolean;
        /** Node count of the live engram with this id (0 if not live, or if
         *  the live engram is an empty stub). The UI uses `liveNodeCount > 0`
         *  — not mere id-existence — to decide a quarantined file is safe to
         *  delete. An empty live engram means recovery has NOT populated it
         *  and this quarantined file may be the only copy of the bytes. */
        liveNodeCount: number;
      }> = [];
      let entries: string[];
      try {
        entries = await fs.readdir(graphsDir);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') return { items: [] };
        throw err;
      }
      const liveIds = new Set(deps.host.listGraphs());
      // Count nodes per live engram once (an engram may have both a .gai and a
      // .bundle quarantine row — don't inspect twice). 0 = empty stub, which
      // means recovery has NOT actually populated the engram yet.
      const nodeCounts = new Map<string, number>();
      const liveNodeCountFor = (engramId: string): number => {
        if (!liveIds.has(engramId)) return 0;
        const cached = nodeCounts.get(engramId);
        if (cached !== undefined) return cached;
        let count = 0;
        try { count = deps.host.listNodes(engramId).length; } catch { count = 0; }
        nodeCounts.set(engramId, count);
        return count;
      };
      // Matches "<engramId>.<gai|bundle>.corrupt-<digits>"
      const re = /^(.+)\.(gai|bundle)\.corrupt-(\d+)$/;
      for (const name of entries) {
        const m = name.match(re);
        if (!m) continue;
        const engramId = m[1] as string;
        const kind = m[2] as 'gai' | 'bundle';
        const timestamp = Number(m[3]);
        const full = path.join(graphsDir, name);
        let sizeBytes = 0;
        try {
          const stat = await fs.stat(full);
          sizeBytes = stat.size;
        } catch { /* file vanished — skip */ continue; }
        out.push({
          name, engramId, kind, timestamp, sizeBytes,
          liveEngramExists: liveIds.has(engramId),
          liveNodeCount: liveNodeCountFor(engramId),
        });
      }
      out.sort((a, b) => b.timestamp - a.timestamp);
      return { items: out };
    }
    case 'quarantine.delete': {
      // Permanently delete a quarantined file. The frontend gates this
      // behind a typed confirmation; the sidecar trusts the caller but
      // performs a defensive check that the file name actually looks like
      // a quarantined artifact (won't delete arbitrary cortex files via
      // a malicious IPC call from a compromised webview).
      const { name } = z.object({
        name: z.string().regex(/^[^/\\]+\.(gai|bundle)\.corrupt-\d+$/),
      }).parse(params ?? {});
      const fullPath = path.join(deps.host.getCortexDir(), 'graphs', name);
      await fs.unlink(fullPath);
      console.error(`[graphnosis-sidecar] user-deleted quarantined file: ${name}`);
      return { ok: true };
    }
    case 'quarantine.restore': {
      // Rename a quarantined file back to its canonical name so the next
      // unlock will try to load it again. Useful if the user believes the
      // quarantine was spurious (e.g. they restored a known-good cortex
      // from backup and the timestamps mismatched). The sidecar refuses
      // if a canonical file with the same name already exists — that
      // would overwrite the current (presumably good) data.
      const { name } = z.object({
        name: z.string().regex(/^[^/\\]+\.(gai|bundle)\.corrupt-\d+$/),
      }).parse(params ?? {});
      const graphsDir = path.join(deps.host.getCortexDir(), 'graphs');
      const m = name.match(/^(.+)\.(gai|bundle)\.corrupt-\d+$/);
      if (!m) throw new Error('Invalid quarantine name');
      const canonical = path.join(graphsDir, `${m[1]}.${m[2]}`);
      try {
        await fs.access(canonical);
        throw new Error(
          `Refusing to restore: a current ${m[2]} file already exists for engram '${m[1]}'. ` +
          `Move or delete it first if you really mean to overwrite.`,
        );
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw err;
      }
      await fs.rename(path.join(graphsDir, name), canonical);
      console.error(`[graphnosis-sidecar] user-restored quarantined file: ${name} → ${path.basename(canonical)}`);
      return { ok: true };
    }
    case 'recoveryPhrase.regenerate': {
      // Generate a fresh 24-word phrase and rewrap recovery.enc. Returns
      // the phrase so the UI can show it once. The OLD phrase no longer
      // unwraps anything in this cortex. The dataKey is preserved.
      const phrase = await deps.host.regenerateRecoveryPhrase();
      return { recoveryPhrase: phrase };
    }
    case 'passphrase.change': {
      // Rewrap master.enc with a key derived from `newPassphrase`. The
      // dataKey (and therefore every encrypted file) is unchanged. The
      // recovery phrase remains valid.
      //
      // `skipOldPassphraseCheck` is for the post-recovery-unlock flow: the
      // user has already authenticated by entering their 24-word phrase, so
      // requiring them to also produce the (forgotten) old passphrase would
      // defeat the recovery purpose. The Rust layer only sets this flag when
      // it knows the current session is a recovery session.
      const { newPassphrase, oldPassphrase, skipOldPassphraseCheck } = z.object({
        newPassphrase: z.string().min(1),
        oldPassphrase: z.string().optional(),
        skipOldPassphraseCheck: z.boolean().optional(),
      }).parse(params ?? {});
      const changeOpts: { oldPassphrase?: string; skipOldPassphraseCheck?: boolean } = {};
      if (oldPassphrase !== undefined) changeOpts.oldPassphrase = oldPassphrase;
      if (skipOldPassphraseCheck) changeOpts.skipOldPassphraseCheck = true;
      await deps.host.changePassphrase(newPassphrase, changeOpts);
      return { ok: true };
    }
    case 'settings.update': {
      const parsed = z.object({
        contentCache: z.object({
          mode: z.enum(['all', 'ephemeral-only', 'off']),
          maxBytesPerSource: z.number().int().nonnegative(),
        }).optional(),
        forget: z.object({
          mode: z.enum(['soft', 'purge']),
        }).optional(),
        mcpRelay: z.object({
          initialWaitMs: z.number().int().positive(),
          reconnectMs: z.number().int().positive(),
        }).optional(),
        ui: z.object({
          // All fields optional so callers can do partial updates (e.g.
          // the status-bar theme toggle posts just `{ ui: { theme } }`
          // without re-asserting inspectorDetail). The host-side
          // normalizeSettings backfills defaults for anything missing.
          inspectorDetail: z.enum(['simple', 'detailed']).optional(),
          theme: z.enum(['auto', 'light', 'dark']).optional(),
        }).optional(),
        ai: z.object({
          useAsDefaultMemory: z.boolean(),
          // Optional in the payload so older App builds (which don't
          // know about the field yet) still pass validation. The
          // mergeWithDefaults pass on the host side fills in the
          // current default for any missing fields.
          autoRelinkMaxNodes: z.number().int().nonnegative().optional(),
          autoReingestOnFileChange: z.boolean().optional(),
          reingestQuietMs: z.number().int().positive().optional(),
          chunkSize: z.enum(['fine', 'balanced', 'coarse']).optional(),
          embedBatch: z.enum(['small', 'medium', 'large', 'auto']).optional(),
          embedWorkers: z.number().int().min(1).max(4).optional(),
          sessionTokenCap: z.number().int().min(1000).max(200_000).optional(),
          sessionNodeCap: z.number().int().min(10).max(5000).optional(),
          // Consent interval settings — writable from the UI, blocked from MCP.
          // -1 = permanent (until revoked); 0 = every access; positive = interval in ms.
          consentIntervalSensitiveMs: z.union([
            z.literal(-1),
            z.number().int().min(0).max(15_552_000_000),
          ]).optional(),
          consentIntervalPersonalMs: z.union([
            z.literal(-1),
            z.number().int().min(0).max(15_552_000_000),
          ]).optional(),
          // AI client type — 'chat' (default) or 'agent' (always re-confirms per call).
          clientTypes: z.record(z.string(), z.enum(['chat', 'agent'])).optional(),
        }).optional(),
        mobile: z.object({
          httpBridge: z.object({
            enabled: z.boolean(),
            port: z.number().int().min(1024).max(65535).optional(),
            host: z.enum(['127.0.0.1', '0.0.0.0']).optional(),
            token: z.string().optional(),
            allowedOrigins: z.array(z.string()).optional(),
          }).optional(),
          httpUi: z.object({
            enabled: z.boolean(),
            port: z.number().int().min(1024).max(65535).optional(),
            host: z.enum(['127.0.0.1', '0.0.0.0']).optional(),
            token: z.string().optional(),
          }).optional(),
        }).optional(),
        brain: z.object({
          clipboardCapture: z.object({
            enabled: z.boolean(),
          }).optional(),
          lowPowerMode: z.boolean().optional(),
        }).optional(),
        connectors: z.object({
          // Poll interval (ms) for all connectors. 60s floor. Owned by the
          // ConnectorManager (which also persists the configs blob), so it's
          // applied via the manager below rather than the generic patch.
          pullIntervalMs: z.number().int().min(60_000).max(86_400_000),
        }).optional(),
      }).parse(params ?? {});
      // Strip undefined keys explicitly for exactOptionalPropertyTypes.
      const patch: Parameters<typeof deps.host.setSettings>[0] = {};
      if (parsed.contentCache) patch.contentCache = parsed.contentCache;
      if (parsed.forget) patch.forget = parsed.forget;
      if (parsed.mcpRelay) patch.mcpRelay = parsed.mcpRelay;
      if (parsed.ui) {
        // UiSettings on the host requires all fields; the wire payload
        // accepts partials so the theme toggle can post just `{ ui: { theme } }`
        // without touching inspectorDetail. Backfill missing fields from
        // current settings so partial updates don't silently revert anything.
        const currentUi = deps.host.getSettings().ui;
        patch.ui = {
          inspectorDetail: parsed.ui.inspectorDetail ?? currentUi.inspectorDetail,
          theme: parsed.ui.theme ?? currentUi.theme,
        };
      }
      if (parsed.ai) {
        // AiSettings requires all fields, but the wire payload allows
        // older clients to omit newer ones. Fill from current settings so
        // we never silently revert any to the default.
        const currentAi = deps.host.getSettings().ai;
        patch.ai = {
          useAsDefaultMemory: parsed.ai.useAsDefaultMemory,
          autoRelinkMaxNodes: parsed.ai.autoRelinkMaxNodes ?? currentAi.autoRelinkMaxNodes,
          autoReingestOnFileChange: parsed.ai.autoReingestOnFileChange ?? currentAi.autoReingestOnFileChange,
          reingestQuietMs: parsed.ai.reingestQuietMs ?? currentAi.reingestQuietMs,
          chunkSize: parsed.ai.chunkSize ?? currentAi.chunkSize,
          embedBatch: parsed.ai.embedBatch ?? currentAi.embedBatch,
          ...(parsed.ai.embedWorkers !== undefined ? { embedWorkers: parsed.ai.embedWorkers } : currentAi.embedWorkers !== undefined ? { embedWorkers: currentAi.embedWorkers } : {}),
          // The local-LLM master switch is owned by the dedicated
          // `llm:setEnabled` IPC — preserve it across a generic settings update.
          llmEnabled: currentAi.llmEnabled,
          ...(parsed.ai.sessionTokenCap !== undefined ? { sessionTokenCap: parsed.ai.sessionTokenCap } : currentAi.sessionTokenCap !== undefined ? { sessionTokenCap: currentAi.sessionTokenCap } : {}),
          ...(parsed.ai.sessionNodeCap !== undefined ? { sessionNodeCap: parsed.ai.sessionNodeCap } : currentAi.sessionNodeCap !== undefined ? { sessionNodeCap: currentAi.sessionNodeCap } : {}),
          // Consent interval settings — UI-writable, never overwritable via MCP.
          ...(parsed.ai.consentIntervalSensitiveMs !== undefined ? { consentIntervalSensitiveMs: parsed.ai.consentIntervalSensitiveMs } : currentAi.consentIntervalSensitiveMs !== undefined ? { consentIntervalSensitiveMs: currentAi.consentIntervalSensitiveMs } : {}),
          ...(parsed.ai.consentIntervalPersonalMs !== undefined ? { consentIntervalPersonalMs: parsed.ai.consentIntervalPersonalMs } : currentAi.consentIntervalPersonalMs !== undefined ? { consentIntervalPersonalMs: currentAi.consentIntervalPersonalMs } : {}),
          ...(parsed.ai.clientTypes !== undefined ? { clientTypes: parsed.ai.clientTypes } : currentAi.clientTypes !== undefined ? { clientTypes: currentAi.clientTypes } : {}),
          // dataAccessConsents — NEVER written via generic settings patch.
          // Only writable via dedicated ai.revokeConsents and confirm_data_access MCP tool.
          ...(currentAi.dataAccessConsents !== undefined ? { dataAccessConsents: currentAi.dataAccessConsents } : {}),
          // disabledMcpTools — written ONLY via the dedicated, Pro-gated
          // ai.setDisabledTools IPC. Preserve here so an unrelated settings
          // patch (which rebuilds `ai` field-by-field) can't silently drop it.
          ...(currentAi.disabledMcpTools !== undefined ? { disabledMcpTools: currentAi.disabledMcpTools } : {}),
        };
      }
      if (parsed.mobile) {
        // Fill from current settings so partial updates don't lose fields.
        const currentMobile = deps.host.getSettings().mobile;
        const currentBridge = currentMobile?.httpBridge;
        const currentUi = currentMobile?.httpUi;
        const inBridge = parsed.mobile.httpBridge;
        const inUi = parsed.mobile.httpUi;

        // httpBridge is required on the stored shape. Update it if the caller
        // passed it; otherwise preserve the current value (or a disabled default).
        const httpBridge = inBridge
          ? {
              enabled: inBridge.enabled,
              port: inBridge.port ?? currentBridge?.port ?? 3457,
              host: inBridge.host ?? currentBridge?.host ?? '127.0.0.1',
              // Auto-generate a token on first enable; UI shows it once.
              token: inBridge.token || currentBridge?.token || (inBridge.enabled ? randomUUID() : ''),
              allowedOrigins: inBridge.allowedOrigins ?? currentBridge?.allowedOrigins ?? [],
            }
          : (currentBridge ?? { enabled: false, port: 3457, host: '127.0.0.1', token: '', allowedOrigins: [] });

        patch.mobile = { httpBridge };

        // httpUi is the parallel browser-UI server block. Same token lifecycle.
        if (inUi) {
          patch.mobile.httpUi = {
            enabled: inUi.enabled,
            port: inUi.port ?? currentUi?.port ?? 3456,
            host: inUi.host ?? currentUi?.host ?? '127.0.0.1',
            token: inUi.token || currentUi?.token || (inUi.enabled ? randomUUID() : ''),
          };
        } else if (currentUi) {
          patch.mobile.httpUi = currentUi;
        }
      }
      if (parsed.brain) {
        const currentBrain = deps.host.getSettings().brain ?? {};
        patch.brain = {
          ...currentBrain,
          ...(parsed.brain.clipboardCapture !== undefined
            ? { clipboardCapture: parsed.brain.clipboardCapture }
            : {}),
          // Low-power toggle — must be threaded here too, or this handler drops
          // the incoming value (same trap as clipboardCapture above).
          ...(parsed.brain.lowPowerMode !== undefined
            ? { lowPowerMode: parsed.brain.lowPowerMode }
            : {}),
        };
      }
      // Connector poll interval is owned by the ConnectorManager (it persists
      // the connectors blob and swaps live timers). Apply it through the
      // manager instead of the generic patch so the two don't race.
      if (parsed.connectors?.pullIntervalMs !== undefined) {
        let intervalMs = parsed.connectors.pullIntervalMs;
        // Free tier: enforce a daily-minimum floor on polling connectors.
        // Watch-based connectors (filesystem watchers) are unaffected — they
        // fire on changes, not on a timer. This gate only applies to the
        // global backstop poll interval used by RSS, GitHub, Slack, etc.
        const licenseToken = await getEffectiveLicenseToken(deps);
        const hasCadence = deps.licenseValidator?.hasFeature(licenseToken, 'connector-cadence') ?? false;
        if (!hasCadence) intervalMs = Math.max(86_400_000, intervalMs);
        await deps.connectorManager.setPullInterval(intervalMs);
      }
      return deps.host.setSettings(patch, { userInitiated: true });
    }
    case 'cortex.purgeForgotten': {
      const { graphId } = z.object({ graphId: z.string() }).parse(params);
      return deps.host.purgeSoftDeleted(graphId);
    }
    case 'recovery.plan': {
      // No params — uses the running sidecar's existing key. Returns a list
      // of every source ever ingested (minus forgotten), with per-item status
      // (recoverable / file-missing / already-present / etc).
      return deps.host.planRecovery();
    }
    case 'recovery.apply': {
      // Re-ingest selected sources. `sourceIds: null` means "all recoverable".
      // ASYNC: returns { accepted, jobId } immediately. Progress and the final
      // report are pushed via `recovery.progress` / `recovery.done` event frames
      // on the events socket. This avoids the IPC timeout for long-running
      // recoveries — a 4233-page PDF takes 60-90 min to re-embed, far beyond
      // any sensible request/response window. The user can also close the
      // recovery panel and navigate elsewhere; events keep firing.
      const { sourceIds } = z.object({
        sourceIds: z.array(z.string()).nullable().optional(),
      }).parse(params ?? {});
      const jobId = `recovery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      deps.broadcastRaw({
        kind: 'recovery.progress',
        name: 'recovery.progress',
        payload: { jobId, phase: 'started' },
      });
      void (async () => {
        try {
          const report = await deps.host.applyRecovery(sourceIds ?? undefined, {
            onSourceStart: (sourceId, ref, index, total) => {
              deps.broadcastRaw({
                kind: 'recovery.progress',
                name: 'recovery.progress',
                payload: { jobId, phase: 'source-start', sourceId, ref, index, total },
              });
            },
            onSourceDone: (outcome, index, total) => {
              deps.broadcastRaw({
                kind: 'recovery.progress',
                name: 'recovery.progress',
                payload: { jobId, phase: 'source-done', outcome, index, total },
              });
            },
          });
          deps.broadcastRaw({
            kind: 'recovery.done',
            name: 'recovery.done',
            payload: { jobId, report },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[graphnosis-sidecar] background recovery failed:`, e);
          deps.broadcastRaw({
            kind: 'recovery.done',
            name: 'recovery.done',
            payload: { jobId, error: message },
          });
        }
      })();
      return { accepted: true, jobId };
    }
    case 'recall': {
      const { query, maxTokens, maxNodes } = z.object({
        query: z.string(),
        maxTokens: z.number().optional(),
        maxNodes: z.number().optional(),
      }).parse(params);
      const { beginScope, WorkPriority } = await import('./work-priority.js');
      const endP1 = beginScope(WorkPriority.P1_USER);
      try {
        const { autoExceptGraphIds } = checkRecallSsoGate(deps.host, deps, null);
        const sub = await withEmbedding(() => deps.host.recall(query, {
          budget: { maxTokens: maxTokens ?? 2000, maxNodes: maxNodes ?? 20 },
          recallPriority: WorkPriority.P1_USER,
          ...(autoExceptGraphIds.length ? { exceptGraphIds: autoExceptGraphIds } : {}),
        }));
        // Enrich each recalled node with its allowlist sourceId so MemoryStudio
        // can redact per-source precisely in Presentation Mode.
        const byGraph: Record<string, unknown> = {};
        for (const [gid, nodes] of sub.byGraph) {
          byGraph[gid] = (nodes as Array<{ nodeId: string }>).map(
            (n) => ({ ...n, sourceId: deps.host.getNodeSource(gid, n.nodeId) }),
          );
        }
        return {
          prompt: sub.prompt,
          tokensUsed: sub.tokensUsed,
          nodesIncluded: sub.nodesIncluded,
          byGraph,
          audit: sub.audit,
        };
      } finally {
        endP1();
      }
    }
    // ── Connector IPC ────────────────────────────────────────────────────────
    case 'policy.get': {
      // Admin/IT policy state for the "Disabled by IT" Home card + (later)
      // the editable toggles. `managed` = env-pinned by IT (read-only here).
      const p = getAdminPolicy();
      const ALL_CONNECTOR_KINDS = ['webhook', 'rss', 'github', 'slack', 'trello', 'linear', 'obsidian', 'gbrain', 'ai-context'];
      const clientTypes = deps.host.getSettings().ai.clientTypes ?? {};
      // Always offer the supported clients as blockable, even before they've
      // ever connected, unioned with any others the registry has seen.
      const SUPPORTED_CLIENTS = ['Claude Desktop', 'Claude Code', 'Cursor', 'Copilot', 'Claude Skills agent'];
      const knownClients = Array.from(new Set([...SUPPORTED_CLIENTS, ...Object.keys(clientTypes)]));
      return {
        ...p,
        connectorKinds: ALL_CONNECTOR_KINDS,
        knownClients,
      };
    }
    case 'policy.set': {
      // Update the user-editable file policy (throws if env-managed), then
      // re-enforce live so a just-disabled connector stops immediately.
      const a = z.object({
        disabledConnectorKinds: z.array(z.string()).optional(),
        disabledClients: z.array(z.string()).optional(),
      }).parse(params ?? {});
      const next = setAdminPolicy({
        ...(a.disabledConnectorKinds !== undefined ? { disabledConnectorKinds: a.disabledConnectorKinds } : {}),
        ...(a.disabledClients !== undefined ? { disabledClients: a.disabledClients } : {}),
      }); // throws if managed → IPC surfaces the error
      deps.connectorManager.reapplyPolicy();
      return next;
    }
    case 'connectors.list': {
      return deps.connectorManager.list();
    }
    case 'connectors.install': {
      if (!deps.connectorManager) throw new Error('ConnectorManager not initialized');  // should never happen
      const { config } = z.object({
        config: z.object({
          id: z.string().optional(),
          kind: z.enum(['webhook', 'rss', 'github', 'slack', 'trello', 'linear', 'obsidian', 'gbrain', 'ai-context']),
          graphId: z.string().optional(),
          enabled: z.boolean().optional(),
          // zod v4: z.record requires (keyType, valueType). Credentials are
          // string → string; options are string → unknown (connector-defined).
          credentials: z.record(z.string(), z.string()).optional(),
          options: z.record(z.string(), z.unknown()).optional(),
        }),
      }).parse(params ?? {});
      // Strip explicit `undefined` keys so Partial<ConnectorConfig> matches
      // under exactOptionalPropertyTypes (which distinguishes absent from
      // present-but-undefined). zod's .optional() produces the latter.
      const cleanConfig: Partial<import('@graphnosis-app/core').ConnectorConfig> & { kind: import('@graphnosis-app/core').ConnectorKind } = {
        kind: config.kind,
        ...(config.id !== undefined ? { id: config.id } : {}),
        ...(config.graphId !== undefined ? { graphId: config.graphId } : {}),
        ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
        ...(config.credentials !== undefined ? { credentials: config.credentials } : {}),
        ...(config.options !== undefined ? { options: config.options } : {}),
      };
      const installed = await deps.connectorManager.install(cleanConfig);
      return { config: installed };
    }
    case 'connectors.remove': {
      const { id } = z.object({ id: z.string() }).parse(params ?? {});
      await deps.connectorManager.remove(id);
      return { ok: true };
    }
    case 'connectors.triggerPull': {
      const { id } = z.object({ id: z.string() }).parse(params ?? {});
      return deps.connectorManager.triggerPull(id);
    }
    case 'connectors.resync': {
      const { id } = z.object({ id: z.string() }).parse(params ?? {});
      return deps.connectorManager.resync(id);
    }
    case 'connectors.stop': {
      const { id } = z.object({ id: z.string() }).parse(params ?? {});
      deps.connectorManager.stopPull(id);
      return { ok: true };
    }
    case 'connectors.getAuthUrl': {
      const { id } = z.object({ id: z.string() }).parse(params ?? {});
      return deps.connectorManager.getAuthUrl(id);
    }

    case 'mobile.getConnectionInfo': {
      const settings = deps.host.getSettings();
      const bridge = settings.mobile?.httpBridge;
      const nets = os.networkInterfaces();
      const localIps: string[] = [];
      let tailscaleIp: string | undefined;
      for (const ifaces of Object.values(nets)) {
        if (!ifaces) continue;
        for (const iface of ifaces) {
          if (iface.family !== 'IPv4' || iface.internal) continue;
          // Tailscale assigns IPs in the 100.64.0.0/10 CGNAT range.
          if (iface.address.startsWith('100.')) {
            tailscaleIp = iface.address;
          } else {
            localIps.push(iface.address);
          }
        }
      }
      const ui = settings.mobile?.httpUi;
      const mcpPort = bridge?.port ?? 3457;
      const uiPort = ui?.port ?? 3456;
      // Tailscale Serve detection (MagicDNS + per-port https mapping) — lets the
      // QR/clients use real-cert https URLs. Best-effort; null when Tailscale
      // isn't present.
      //
      // CRITICAL: this shells out to the `tailscale` CLI several times in
      // sequence (version + status --json + serve status --json). When the CLI
      // is installed but cold/slow (the macOS GUI app is a frequent offender),
      // those per-call timeouts SUM well past the 5s front-end IPC budget — so
      // the whole getConnectionInfo call would fail and the Port field never
      // populates, even though port/token/IPs are all available instantly.
      // Cap the detection with an overall budget: if Tailscale doesn't answer
      // in time we return the core connection info anyway (the https badge just
      // stays off; reopening the modal retries against a now-warm CLI).
      const TS_DETECT_BUDGET_MS = 2500;
      const ts = await Promise.race([
        detectTailscaleServe(uiPort, mcpPort).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), TS_DETECT_BUDGET_MS)),
      ]);
      return {
        enabled: bridge?.enabled ?? false,
        host: bridge?.host ?? '127.0.0.1',
        port: mcpPort,
        token: bridge?.token ?? '',
        localIps,
        tailscaleIp,
        tailscaleHost: ts?.host ?? null,   // host.tailnet.ts.net (if detectable)
        tailscaleHttps: ts?.uiHttps ?? false, // true when Serve fronts the UI port over https
        // MCP-over-https (a SECOND Serve mapping, e.g. --https=8443 → :3457).
        // Independent of the UI mapping; when present, the MCP QR/clients can
        // use a real-cert https URL that satisfies iOS ATS.
        mcpTailscaleHttps: ts?.mcpHttps ?? false,
        mcpTailscaleHttpsUrl: ts?.mcpHttpsUrl ?? null, // https://host[:port] (append /mcp)
        // Browser UI (personal-server mode) connection details.
        httpUi: {
          enabled: ui?.enabled ?? false,
          host: ui?.host ?? '127.0.0.1',
          port: uiPort,
          token: ui?.token ?? '',
        },
      };
    }
    case 'vscode.getConnectionInfo': {
      const settings = deps.host.getSettings();
      return {
        port: settings.vscode?.localBridgePort ?? 3457,
        token: settings.vscode?.localBridgeToken ?? '',
      };
    }
    case 'vscode.rotateToken': {
      const before = deps.host.getSettings();
      const newToken = randomUUID();
      await deps.host.setSettings({
        vscode: {
          localBridgeToken: newToken,
          localBridgePort: before.vscode?.localBridgePort ?? 3457,
        },
      });
      // Re-read after commit so the modal reflects the actual persisted value.
      const after = deps.host.getSettings();
      return {
        port: after.vscode?.localBridgePort ?? 3457,
        token: after.vscode?.localBridgeToken ?? newToken,
      };
    }

    // ── Alive Brain IPC ──────────────────────────────────────────────────────

    case 'brain:getVitality': {
      // Null (not a fabricated 0) when the brain isn't ready yet — lets the
      // UI keep a neutral "computing…" ring instead of showing a real-
      // looking vitality of 0.
      if (!deps.brainEngine) return null;
      const args = z.object({ force: z.boolean().optional() }).parse(params ?? {});
      if (args.force) deps.brainEngine.invalidateVitality();
      return deps.brainEngine.getVitalityReport();
    }

    case 'brain:getInsights': {
      if (!deps.brainEngine) return [];
      return deps.brainEngine.getInsights();
    }

    case 'brain:getDuplicatePairs': {
      if (!deps.brainEngine) return [];
      return deps.brainEngine.getDuplicatePairs();
    }

    case 'brain:getContradictionPairs': {
      if (!deps.brainEngine) return [];
      return deps.brainEngine.getContradictionPairs();
    }

    case 'brain:dismissContradictionPair': {
      const { id } = z.object({ id: z.string() }).parse(params);
      deps.brainEngine?.dismissContradictionPair(id);
      return { ok: true };
    }

    case 'brain:getHealingJournal': {
      if (!deps.brainEngine) return [];
      return deps.brainEngine.getHealingJournal();
    }

    case 'brain:dismissInsight': {
      const { id } = z.object({ id: z.string() }).parse(params);
      deps.brainEngine?.dismissInsight(id);
      return { ok: true };
    }

    case 'brain:dismissDuplicatePair': {
      const { id } = z.object({ id: z.string() }).parse(params);
      deps.brainEngine?.dismissDuplicatePair(id);
      return { ok: true };
    }

    case 'brain:resolveDuplicatePair': {
      const { id, action } = z.object({
        id: z.string(),
        action: z.enum(['merge', 'keep-both']),
      }).parse(params);
      await deps.brainEngine?.resolveDuplicatePair(id, action);
      return { ok: true };
    }

    case 'brain:develop': {
      const args = z.object({
        context: z.string().min(1),
        strategy: z.string().min(1),
        goals: z.string().min(1),
        graphIds: z.array(z.string()).optional(),
        saveAsGoal: z.boolean().optional(),
        goalGraphId: z.string().optional(),
      }).parse(params);
      if (!deps.brainEngine) throw new Error('BrainEngine not initialized. Ensure cortex is unlocked.');
      const plan = await deps.brainEngine.runDevelop({
        context: args.context,
        strategy: args.strategy,
        goals: args.goals,
        ...(args.graphIds ? { graphIds: args.graphIds } : {}),
      });
      if (args.saveAsGoal) {
        const goalGraph = args.goalGraphId ?? plan.graphIds[0];
        if (goalGraph) await deps.brainEngine.ingestGoal(goalGraph, plan);
      }
      return plan;
    }

    case 'brain:predict': {
      const args = z.object({
        action: z.string().min(1),
        graphIds: z.array(z.string()).optional(),
      }).parse(params);
      if (!deps.brainEngine) return { risks: [], opportunities: [], recommendation: '', referencedNodeIds: [] };
      return deps.brainEngine.runPredict({
        action: args.action,
        ...(args.graphIds ? { graphIds: args.graphIds } : {}),
      });
    }

    case 'brain:listGoals': {
      if (!deps.brainEngine) return [];
      return deps.brainEngine.listGoals();
    }

    case 'brain:runScan': {
      // Fire-and-forget: the scan emits start/done frames that drive the
      // UI's scanning visuals. Awaiting here would block the IPC response
      // for the whole (potentially minute-long, LLM-bound) sweep.
      if (deps.brainEngine) void deps.brainEngine.runFullScan();
      return { ok: true };
    }

    case 'brain:getStatus': {
      if (!deps.brainEngine) {
        return {
          scanning: false, lastRun: {}, intervals: {},
          lastDecayReport: null, sessionSynapsesFormed: 0, sessionAutoLinksFormed: 0,
          sessionReinforced: 0, sessionConnectionsFormed: 0, sessionInferred: 0,
          sessionEdgesCleaned: 0, sessionCrossEngram: 0, lastConsolidation: null,
        };
      }
      return deps.brainEngine.getStatus();
    }

    case 'brain:getMemoryHealth': {
      // Null (not a fabricated 0) when the brain isn't ready — lets the UI
      // keep a neutral "computing…" ring.
      if (!deps.brainEngine) return null;
      return deps.brainEngine.getMemoryHealth();
    }

    case 'brain:getCrossEngramConnections': {
      if (!deps.brainEngine) return [];
      return deps.brainEngine.getCrossEngramConnections();
    }

    case 'brain:runConsolidation': {
      // Fire-and-forget: the pass emits its own start/done frames.
      if (deps.brainEngine) deps.brainEngine.runConsolidationNow();
      return { ok: true };
    }

    case 'brain:getNeuralNetworkStatus': {
      if (!deps.brainEngine) return { enabled: false, gnnEdgeCount: 0, lastRun: null };
      return deps.brainEngine.getNeuralNetworkStatus();
    }

    case 'brain:getPredictedEdges': {
      if (!deps.brainEngine) return [];
      const args = z.object({ graphId: z.string().optional() }).parse(params ?? {});
      return deps.brainEngine.getPredictedEdges(args.graphId);
    }

    case 'brain:enableNeuralNetwork': {
      // Snapshot every engram BEFORE enabling — the safety net the user can
      // fall back to. Then flip the setting on and kick off the first run.
      const snapshotPath = await deps.host.snapshotGraphs('pre-neural-network');
      const current = deps.host.getSettings();
      await deps.host.setSettings({
        brain: { ...current.brain, neuralNetwork: { enabled: true } },
      });
      if (deps.brainEngine) deps.brainEngine.runNeuralNetworkNow();
      return { ok: true, snapshotPath };
    }

    case 'brain:disableNeuralNetwork': {
      const current = deps.host.getSettings();
      await deps.host.setSettings({
        brain: { ...current.brain, neuralNetwork: { enabled: false } },
      });
      return { ok: true };
    }

    case 'brain:runNeuralNetwork': {
      if (deps.brainEngine) deps.brainEngine.runNeuralNetworkNow();
      return { ok: true };
    }

    case 'brain:removeNeuralNetworkEdges': {
      const removed = deps.brainEngine ? await deps.brainEngine.removeNeuralNetworkEdges() : 0;
      return { removed };
    }

    // ── LLM / Ollama management IPC ─────────────────────────────────────────

    case 'llm:status': {
      const ollamaUrl = 'http://127.0.0.1:11434';
      let ollamaReachable = false;
      let installedModels: string[] = [];
      try {
        const res = await fetch(`${ollamaUrl}/api/tags`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) {
          ollamaReachable = true;
          const data = await res.json() as { models?: Array<{ name: string }> };
          installedModels = (data.models ?? []).map(m => m.name);
        }
      } catch { /* Ollama not running or not installed */ }
      const settings = deps.host.getSettings();
      const activeModel = settings.ai?.llmModel ?? null;
      const { LLM_CATALOG, activeBackend } = await import('./local-llm.js');
      // Resolved capability flags (with defaults applied) — UI uses these to
      // render the per-capability checkboxes under the master toggle without
      // having to know the default-on/default-off rules.
      const { resolveLlmCapabilities } = await import('@graphnosis-app/core').then(m => m.settings);
      const capabilities = resolveLlmCapabilities(settings);
      // Active backend descriptor — drives MemoryStudio's loopback
      // verification badge and the future self-test / wizard. v1 always
      // returns the Ollama descriptor; v2 will look up the user's chosen
      // backend from settings.
      const backend = activeBackend('ollama');
      return {
        ollamaReachable, installedModels, activeModel,
        enabled: settings.ai.llmEnabled === true,
        capabilities,
        catalog: LLM_CATALOG,
        backend,
      };
    }

    case 'llm:setModel': {
      const { model } = z.object({ model: z.string().min(1) }).parse(params);
      const current = deps.host.getSettings();
      await deps.host.setSettings({ ai: { ...current.ai, llmModel: model } });
      return { ok: true };
    }

    case 'llm:setEnabled': {
      // The local LLM master switch. OFF by default; the App's Local LLM
      // panel flips it on (behind a confirmation) once Ollama + a model are
      // ready. Every LLM-backed feature gates on this — see pingLlm() and
      // the mcpDeps.llm getter in the sidecar.
      const { enabled } = z.object({ enabled: z.boolean() }).parse(params);
      const current = deps.host.getSettings();
      await deps.host.setSettings({ ai: { ...current.ai, llmEnabled: enabled } });
      return { ok: true };
    }

    case 'llm:setCapability': {
      // Per-capability toggle for the local LLM. The master switch must be on
      // for any capability to take effect — resolveLlmCapabilities short-
      // circuits everything to false when the master is off. We still persist
      // the per-capability preference so flipping the master back on restores
      // the user's prior fine-grained choices.
      const { capability, enabled } = z.object({
        capability: z.enum(['recallEnrichment', 'correctionParsing', 'distillation', 'insights', 'edgePrediction']),
        enabled: z.boolean(),
      }).parse(params);
      const current = deps.host.getSettings();
      const existing = current.ai.llmCapabilities ?? {};
      await deps.host.setSettings({
        ai: {
          ...current.ai,
          llmCapabilities: { ...existing, [capability]: enabled },
        },
      });
      return { ok: true };
    }

    case 'embedding:status': {
      // Reports the live embedding model + dim so the Settings → Search model
      // panel can render the current state without guessing. Read from the
      // running pool (post-switch values), not boot-time constants.
      const { currentEmbedModel } = await import('./local-embed.js');
      const live = currentEmbedModel();
      const settings = deps.host.getSettings();
      const stored = settings.ai.embeddingModel ?? 'english';
      return {
        active: live,
        stored,
        // Reflect whether a re-embed would be triggered if the user clicks Apply
        // for the stored value (i.e., stored differs from active because the
        // sidecar hasn't restarted yet).
        needsApply: stored !== live.model,
        catalog: [
          { id: 'english', label: 'English-first (recommended for English-only users)',
            description: 'BGE-small-en-v1.5 · 384-dim · ~30 MB download.',
            sizeMb: 30 },
          { id: 'multilingual', label: 'Multilingual (recommended if you store notes in multiple languages)',
            description: 'multilingual-e5-large · 1024-dim · ~2.2 GB download. Cross-language recall works without the local LLM.',
            sizeMb: 2200 },
        ],
      };
    }

    case 'embedding:cancelSwitch': {
      // Cancel an in-flight embedding switch. The actual cancellation is
      // cooperative — the host loop checks the AbortSignal between engrams,
      // so this fires the abort and the loop bails after the current engram
      // finishes. The progress event with phase='done' will carry
      // `cancelled: true` so the UI can render the partial-completion state.
      currentEmbeddingSwitchAbort?.abort();
      return { ok: true };
    }

    case 'embedding:setModel': {
      // Switch the embedding model and re-embed every engram. This is the
      // user-facing entry point for the Search model picker. Sequence:
      //   1. Snapshot every graph (recovery if something goes wrong)
      //   2. Swap the embed-worker pool to the new model
      //   3. Update the host's adapter id + dimensions
      //   4. Re-embed every engram, emitting progress events
      //   5. Persist the user's choice to settings.json
      // Progress events fire on broadcastRaw so the Settings UI can drive
      // a progress modal in real time.
      const { model } = z.object({ model: z.enum(['english', 'multilingual']) }).parse(params);
      const { switchEmbedModel, currentEmbedModel, workerEmbed } = await import('./local-embed.js');
      const before = currentEmbedModel();
      if (before.model === model) {
        // No-op switch — just persist the choice (covers re-applying the same
        // value, e.g. on first explicit user selection of the default).
        const current = deps.host.getSettings();
        await deps.host.setSettings({ ai: { ...current.ai, embeddingModel: model } });
        return { ok: true, switched: false };
      }

      deps.broadcastRaw({
        kind: 'embedding.switch-progress',
        name: 'embedding.switch-progress',
        payload: { phase: 'snapshot' },
      });
      try { await deps.host.snapshotGraphs(`pre-embed-switch-${model}`); } catch (e) {
        console.error(`[ipc] embedding:setModel snapshot failed (non-fatal): ${(e as Error).message}`);
      }

      deps.broadcastRaw({
        kind: 'embedding.switch-progress',
        name: 'embedding.switch-progress',
        payload: { phase: 'downloading-model', model },
      });
      await switchEmbedModel(model);
      const after = currentEmbedModel();
      deps.host.setEmbedAdapter(workerEmbed, after.id, after.dim);

      deps.broadcastRaw({
        kind: 'embedding.switch-progress',
        name: 'embedding.switch-progress',
        payload: { phase: 'reembedding', model },
      });
      // Install a fresh abort controller for this switch. The cancel IPC
      // handler aborts it; the host loop polls signal.aborted between
      // engrams and bails. The controller is cleared after the switch
      // returns (either normally or cancelled) so the next switch starts
      // with a clean slate.
      currentEmbeddingSwitchAbort = new AbortController();
      const result = await deps.host.reembedAllGraphs((evt) => {
        deps.broadcastRaw({
          kind: 'embedding.switch-progress',
          name: 'embedding.switch-progress',
          payload: { phase: 'reembedding', model, ...evt },
        });
      }, currentEmbeddingSwitchAbort.signal);
      currentEmbeddingSwitchAbort = null;

      const current = deps.host.getSettings();
      await deps.host.setSettings({ ai: { ...current.ai, embeddingModel: model } });

      deps.broadcastRaw({
        kind: 'embedding.switch-progress',
        name: 'embedding.switch-progress',
        payload: { phase: 'done', model, ...result },
      });
      return { ok: true, switched: true, ...result };
    }

    case 'gll:listPredictedEdges': {
      // List every GLL-predicted edge across the cortex, newest first.
      // Used by the Foresight → predicted edges review surface.
      const overlay = await deps.host.loadGllOverlay();
      const edges = overlay.edges
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt);
      // Inflate with short content previews on both endpoints — the UI
      // needs them to render the row without N additional IPC calls.
      const enriched = edges.map((e) => {
        const inspected = deps.host.listNodes(e.graphId);
        const fromNode = inspected.find((n) => n.id === e.from);
        const toNode = inspected.find((n) => n.id === e.to);
        return {
          ...e,
          fromPreview: fromNode?.contentPreview ?? '',
          toPreview: toNode?.contentPreview ?? '',
        };
      });
      return { edges: enriched };
    }

    case 'gll:acceptPredictedEdge': {
      const { id } = z.object({ id: z.string().min(1) }).parse(params);
      const { acceptPredictedEdge } = await import('./edge-prediction.js');
      const result = await acceptPredictedEdge(deps.host, id);
      return result;
    }

    case 'gll:rejectPredictedEdge': {
      const { id } = z.object({ id: z.string().min(1) }).parse(params);
      const { rejectPredictedEdge } = await import('./edge-prediction.js');
      const result = await rejectPredictedEdge(deps.host, id);
      return result;
    }

    case 'gll:listAssertions': {
      // Newest-first listing of all GLL assertions. Used by the assertion
      // review surface (forthcoming UI batch) and exposable to AI clients
      // for tools that want to inspect what synthesized facts are pending.
      const overlay = await deps.host.loadGllOverlay();
      const assertions = overlay.assertions.slice().sort((a, b) => b.createdAt - a.createdAt);
      return { assertions };
    }

    case 'gll:writeAssertion': {
      // The writer endpoint AI clients (via MCP) and the App's own flows
      // can call to deposit an LLM-derived assertion into the .gll overlay.
      // This is the path "distill facts → review → promote-or-discard" runs
      // through. The host validates that the graphId exists (no orphan
      // assertions) and clamps the score to [0, 1].
      const { graphId, content, derivedFrom, score, modelTag } = z.object({
        graphId: z.string().min(1),
        content: z.string().min(1).max(2000),
        derivedFrom: z.array(z.string()).default([]),
        score: z.number().min(0).max(1),
        modelTag: z.string().optional(),
      }).parse(params);
      const created = await deps.host.addGllAssertion({
        graphId,
        content,
        derivedFrom,
        score,
        ...(modelTag !== undefined ? { modelTag } : {}),
      });
      return { ok: true, assertion: created };
    }

    case 'gll:removeAssertion': {
      const { id } = z.object({ id: z.string().min(1) }).parse(params);
      const result = await deps.host.removeGllAssertion(id);
      return result;
    }

    case 'gll:runPredictionNow': {
      // Manual kick — same as waiting for the 60-min scheduler. Useful for
      // demos and for users who just turned the capability on and want
      // immediate output. Self-gates on the capability flag inside
      // runEdgePrediction so this can't bypass the user's opt-in.
      if (!deps.brainEngine) return { ok: false, reason: 'brain engine not available' };
      await deps.brainEngine.runEdgePrediction();
      return { ok: true };
    }

    case 'snapshots:restore': {
      // Restore .gai files from a snapshot over the canonical graphs/ dir.
      // Takes a snapshot LABEL (the folder name returned by listSnapshots),
      // not an absolute path — keeps the IPC surface free of path-traversal
      // risk. The host takes a fresh safety snapshot first so a wrong-row
      // click is recoverable.
      const { label } = z.object({ label: z.string().min(1) }).parse(params);
      const result = await deps.host.restoreSnapshot(label);
      return { ok: true, ...result };
    }

    case 'snapshots:delete': {
      const { label } = z.object({ label: z.string().min(1) }).parse(params);
      await deps.host.deleteSnapshot(label);
      return { ok: true };
    }

    case 'engram:reingest': {
      // Reingest one source by sourceId. Per-source path — invoked from the
      // Sources tab's per-row Reingest button or from automation. Does NOT
      // snapshot — the existing per-source Reingest button doesn't either,
      // and snapshotting on every single-source call would create snapshot
      // sprawl. The whole-cortex 'engrams:reingestAll' path below DOES
      // snapshot first because the blast radius is bigger.
      const { graphId, sourceId } = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
      }).parse(params);
      const result = await deps.host.reingestSource(graphId, sourceId);
      return { ok: true, result };
    }

    case 'reingest:cancel': {
      // Cooperative cancel for any in-flight reingest (whole-cortex OR
      // per-engram — both share the abort controller because only one
      // reingest can run at a time anyway).
      currentReingestAbort?.abort();
      return { ok: true };
    }

    case 'engrams:reingestAll': {
      // Reingest every source across every loaded engram. Snapshots first
      // (the old chunks/vectors remain recoverable). Progress events fire
      // on broadcastRaw so the UI can drive a progress modal in real time.
      // Skipped sources (content cache unavailable) and failures are
      // surfaced in the final response so the UI can show a summary.
      deps.broadcastRaw({
        kind: 'reingest.progress',
        name: 'reingest.progress',
        payload: { phase: 'snapshot' },
      });
      try { await deps.host.snapshotGraphs(`pre-reingest-all`); } catch (e) {
        console.error(`[ipc] engrams:reingestAll snapshot failed (non-fatal): ${(e as Error).message}`);
      }
      deps.broadcastRaw({
        kind: 'reingest.progress',
        name: 'reingest.progress',
        payload: { phase: 'reingesting' },
      });
      currentReingestAbort = new AbortController();
      const result = await deps.host.reingestAllGraphs((evt) => {
        deps.broadcastRaw({
          kind: 'reingest.progress',
          name: 'reingest.progress',
          payload: { phase: 'reingesting', ...evt },
        });
      }, currentReingestAbort.signal);
      currentReingestAbort = null;
      deps.broadcastRaw({
        kind: 'reingest.progress',
        name: 'reingest.progress',
        payload: { phase: 'done', ...result },
      });
      return { ok: true, ...result };
    }

    case 'engram:reingestAll': {
      // Per-engram variant — same as engrams:reingestAll but scoped to one
      // graph. Snapshots that one engram's files. Useful for users who
      // want to test the migration on a small engram before doing the
      // whole cortex.
      const { graphId } = z.object({ graphId: z.string().min(1) }).parse(params);
      deps.broadcastRaw({
        kind: 'reingest.progress',
        name: 'reingest.progress',
        payload: { phase: 'snapshot', graphId },
      });
      try { await deps.host.snapshotGraphs(`pre-reingest-${graphId}`); } catch (e) {
        console.error(`[ipc] engram:reingestAll snapshot failed (non-fatal): ${(e as Error).message}`);
      }
      deps.broadcastRaw({
        kind: 'reingest.progress',
        name: 'reingest.progress',
        payload: { phase: 'reingesting', graphId },
      });
      currentReingestAbort = new AbortController();
      const result = await deps.host.reingestAllSources(graphId, (evt) => {
        deps.broadcastRaw({
          kind: 'reingest.progress',
          name: 'reingest.progress',
          // Wrap into the same shape as the whole-cortex path (graphIndex/total = 1/1)
          // so the UI listener can render uniformly.
          payload: { phase: 'reingesting', graphIndex: 0, graphsTotal: 1, ...evt },
        });
      }, currentReingestAbort.signal);
      currentReingestAbort = null;
      deps.broadcastRaw({
        kind: 'reingest.progress',
        name: 'reingest.progress',
        payload: { phase: 'done', perGraph: [{ graphId, ...result }], reingested: result.reingested, skipped: result.skipped.length, failed: result.failed.length },
      });
      return { ok: true, ...result };
    }

    case 'llm:pullModel': {
      const { model } = z.object({ model: z.string().min(1) }).parse(params);
      const { spawn } = await import('node:child_process');
      return new Promise<{ ok: boolean }>((resolve, reject) => {
        const child = spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout?.on('data', (chunk: Buffer) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const event = JSON.parse(line) as { status?: string; completed?: number; total?: number };
              // Forwarded raw by the Rust event_stream as
              // graphnosis://llm-pull-progress (see its kind allow-list).
              deps.broadcastRaw({
                kind: 'llm.pull-progress',
                name: 'llm.pull-progress',
                payload: { model, ...event },
              });
            } catch { /* non-JSON line — ignore */ }
          }
        });
        child.on('close', (code) => {
          if (code === 0) resolve({ ok: true });
          else reject(new Error(`ollama pull exited with code ${code}`));
        });
        child.on('error', reject);
      });
    }

    // ── Graphnosis docs ingest ───────────────────────────────────────────────
    //
    // On cortex unlock the App asks whether to offer ingesting the Graphnosis
    // documentation site into a dedicated `graphnosis-docs` engram. The state
    // machine below distinguishes "never offered" from "user declined" from
    // "user deleted it" so we never nag a user who said no — while still
    // auto-re-ingesting after an app update (docs may have changed).

    case 'docs:getArticle': {
      // Fetch one bundled docs article by slug for the in-app contextual-help
      // modal (the "?" affordance). Reads straight from the binary-embedded
      // BUNDLED_DOCS — offline, no recall fuzziness.
      const { slug } = z.object({ slug: z.string().min(1) }).parse(params ?? {});
      const doc = BUNDLED_DOCS.find((d) => d.slug === slug || d.slug.endsWith(`/${slug}`));
      if (!doc) return { found: false };
      return { found: true, slug: doc.slug, title: doc.title, markdown: doc.markdown };
    }

    case 'docs:checkOffer': {
      const { appVersion } = z.object({ appVersion: z.string() }).parse(params ?? {});
      const settings = deps.host.getSettings();
      const loaded = deps.host.listGraphs().includes(DOCS_ENGRAM_ID);
      const onDisk = deps.host.isGraphOnDisk(DOCS_ENGRAM_ID);
      const docsState = settings.docsEngram;
      let decision: 'offer' | 'reingest' | 'none';
      // Ghost metadata: settings row without a .gai — not a deliberate user
      // delete (deleteGraph strips metadata). Repair on next unlock.
      if (isDocsGhostEngram(deps.host)) {
        decision = 'reingest';
      } else if (loaded || onDisk) {
        // Engram is present (loaded or on disk). Re-ingest if:
        //  (a) app version changed — docs content may have changed, OR
        //  (b) source count is below bundled pages — partial/interrupted ingest.
        // Hollow .gai (0 nodes, bundle intact) is repaired by deferred bundle
        // materialize — do not wipe+reingest here (that blocks boot for minutes).
        const sourceCount = loaded
          ? deps.host.listSources(DOCS_ENGRAM_ID).length
          : await deps.host.countBundleSources(DOCS_ENGRAM_ID);
        const versionMismatch = docsState?.ingestedAppVersion !== appVersion;
        const sourcesIncomplete = sourceCount < BUNDLED_DOCS.length;
        decision = (versionMismatch || sourcesIncomplete) ? 'reingest' : 'none';
      } else if (docsState?.declined === true) {
        // User explicitly clicked "Not now" — respect that, never re-offer.
        decision = 'none';
      } else if (typeof docsState?.ingestedAppVersion === 'string' && docsState.ingestedAppVersion.length > 0) {
        // It was ingested before and is now gone ⇒ the user deleted the
        // engram. Respect that deletion — don't silently recreate it.
        decision = 'none';
      } else {
        // Never offered, never ingested, never declined → offer it.
        decision = 'offer';
      }
      return { decision };
    }

    case 'docs:ingest': {
      const { appVersion } = z.object({ appVersion: z.string() }).parse(params ?? {});
      return startBackgroundDocsIngest(deps, appVersion, 'user');
    }

    case 'docs:decline': {
      // User clicked "Not now". Persist the decline, preserving any existing
      // ingestedAppVersion so a later re-ingest decision stays correct.
      const current = deps.host.getSettings().docsEngram;
      await deps.host.setSettings({
        docsEngram: {
          declined: true,
          ...(typeof current?.ingestedAppVersion === 'string' && current.ingestedAppVersion.length > 0
            ? { ingestedAppVersion: current.ingestedAppVersion }
            : {}),
        },
      });
      return { ok: true };
    }

    // ── Bundled Skill Demos ingest ───────────────────────────────────────────
    //
    // Twin of docs:checkOffer / docs:ingest / docs:decline. Three signed
    // Graphnosis demo skill packs ship inside the sidecar binary as
    // base64-encoded bytes in skill-demos.generated.ts. On first cortex
    // unlock the App offers to ingest them into a dedicated `Skill Demos`
    // engram; on app-version bumps it re-ingests so updated demos reach
    // existing users. Same state-machine shape as docs:
    //   never-offered → 'offer'
    //   declined-then-app-update → 'none' (respect the decline)
    //   ingested-but-deleted → 'none' (user removed it; don't recreate)
    //   ingested-old-version → 'reingest' (refresh)
    //   absent-with-no-prior-state → 'offer'

    case 'skillDemos:checkOffer': {
      const { appVersion } = z.object({ appVersion: z.string() }).parse(params ?? {});
      const settings = deps.host.getSettings();
      const exists = deps.host.listGraphs().includes(SKILL_DEMOS_ENGRAM_ID);
      const sdState = settings.skillDemosEngram;
      let decision: 'offer' | 'reingest' | 'none';
      if (exists) {
        const sourceCount = deps.host.listSources(SKILL_DEMOS_ENGRAM_ID)
          .filter((s) => s.kind === 'skill').length;
        const versionMismatch = sdState?.ingestedAppVersion !== appVersion;
        // Single-language install: each bundled .gsk pack contributes exactly
        // one skill (the chosen-language variant). Expected source count is
        // therefore one per pack. (Users who installed both languages under an
        // older build have 2× and read as complete — >= passes.)
        const expectedSources = BUNDLED_SKILL_DEMOS.length;
        const sourcesIncomplete = sourceCount < expectedSources;
        decision = (versionMismatch || sourcesIncomplete) ? 'reingest' : 'none';
      } else if (sdState?.declined === true) {
        decision = 'none';
      } else if (typeof sdState?.ingestedAppVersion === 'string' && sdState.ingestedAppVersion.length > 0) {
        // User had it, then deleted the engram. Respect that.
        decision = 'none';
      } else {
        decision = 'offer';
      }
      return { decision, packsAvailable: BUNDLED_SKILL_DEMOS.length };
    }

    case 'skillDemos:ingest': {
      const { appVersion, language: reqLanguage } = z.object({
        appVersion: z.string(),
        language: z.enum(['en', 'ro']).optional(),
      }).parse(params ?? {});
      // Resolve the language: explicit choice (fresh install) wins; otherwise
      // reuse the stored choice (silent re-ingest on app-version bump);
      // default to English for the legacy/no-choice path.
      const language: 'en' | 'ro' =
        reqLanguage ?? deps.host.getSettings().skillDemosEngram?.language ?? 'en';
      const exists = deps.host.listGraphs().includes(SKILL_DEMOS_ENGRAM_ID);
      if (exists) {
        // Wipe and recreate — same rationale as docs:ingest. Partial prior
        // ingests can leave orphan nodes whose content hashes block fresh
        // inserts; the cleanest fix is to start with a blank engram.
        await deps.host.deleteGraph(SKILL_DEMOS_ENGRAM_ID);
      }
      await deps.host.createGraph(SKILL_DEMOS_ENGRAM_ID);
      await deps.host.setGraphMetadata(SKILL_DEMOS_ENGRAM_ID, {
        template: 'skill',
        displayName: 'Skill Demos',
        createdAt: Date.now(),
      });
      const result = await withEmbedding(() =>
        ingestBundledSkillDemos(deps.host, SKILL_DEMOS_ENGRAM_ID, deps.licenseValidator ?? undefined, { language }),
      );
      await deps.host.setSettings({
        skillDemosEngram: { declined: false, ingestedAppVersion: appVersion, language },
      });
      return result;
    }

    case 'skillDemos:decline': {
      const current = deps.host.getSettings().skillDemosEngram;
      await deps.host.setSettings({
        skillDemosEngram: {
          declined: true,
          ...(typeof current?.ingestedAppVersion === 'string' && current.ingestedAppVersion.length > 0
            ? { ingestedAppVersion: current.ingestedAppVersion }
            : {}),
        },
      });
      return { ok: true };
    }

    // ── MemoryStudio IPC ────────────────────────────────────────────────────
    // All studio.* methods are gated behind the Studio subscription.
    // They route through the same host/brain/LLM functions the MCP server uses,
    // so there is no logic duplication — only a thin IPC shim on top.

    case 'studio.recall': {
      assertStudioEnabled(deps);
      const args = z.object({
        query: z.string().min(1),
        maxTokens: z.coerce.number().int().positive().max(8000).optional(),
        maxNodes: z.coerce.number().int().positive().max(60).optional(),
        onlyEngrams: z.array(z.string()).optional(),
        // Slider re-run path: frontend already has allCandidates and topScore,
        // so it passes the pre-computed filteredCount as displayMaxNodes and we
        // do a single focused call — no wide phase needed.
        displayMaxNodes: z.coerce.number().int().positive().max(60).optional(),
      }).parse(params ?? {});

      const scopeOpts = args.onlyEngrams?.length ? { onlyGraphIds: args.onlyEngrams } : {};
      const onlyIds = args.onlyEngrams?.length ? args.onlyEngrams : null;
      const { autoExceptGraphIds } = checkRecallSsoGate(deps.host, deps, onlyIds);
      const recallScope = onlyIds?.length
        ? scopeOpts
        : { ...(autoExceptGraphIds.length ? { exceptGraphIds: autoExceptGraphIds } : {}) };

      if (args.displayMaxNodes !== undefined) {
        // Slider adjustment: single focused call, no allCandidates returned
        // (frontend already holds the full candidate list from the initial call).
        const sub = await withEmbedding(() => deps.host.recall(args.query, {
          budget: { maxTokens: args.maxTokens ?? 3000, maxNodes: args.displayMaxNodes! },
          skipEnrichment: true,
          ...recallScope,
        }));
        return {
          prompt: sub.prompt,
          tokensUsed: sub.tokensUsed,
          nodesIncluded: sub.nodesIncluded,
          byGraph: Object.fromEntries(sub.byGraph),
          audit: sub.audit,
        };
      }

      // Initial call: single wide fetch — used for both display and slider population.
      // maxTokens: 999_999 so all maxNodes candidates are included for the slider;
      // the raw context panel is scrollable so prompt length is not a concern here.
      // skipEnrichment: Studio users type exact search terms — LLM query rewriting
      // does more harm than good (drops proper nouns, mistranslates).
      const wideSub = await withEmbedding(() => deps.host.recall(args.query, {
        budget: { maxTokens: 999_999, maxNodes: args.maxNodes ?? 50 },
        skipEnrichment: true,
        ...recallScope,
      }));
      const allCandidates = flattenByGraph(wideSub.byGraph);
      const topScore = allCandidates[0]?.score ?? 0;

      return {
        prompt: wideSub.prompt,
        tokensUsed: wideSub.tokensUsed,
        nodesIncluded: wideSub.nodesIncluded,
        byGraph: Object.fromEntries(wideSub.byGraph),
        audit: wideSub.audit,
        allCandidates,
        topScore,
      };
    }

    case 'studio.digDeeper': {
      assertStudioEnabled(deps);
      const args = z.object({
        query: z.string().min(1),
        maxTokens: z.coerce.number().int().positive().max(8000).optional(),
        maxNodes: z.coerce.number().int().positive().max(60).optional(),
        onlyEngrams: z.array(z.string()).optional(),
        displayMaxNodes: z.coerce.number().int().positive().max(60).optional(),
      }).parse(params ?? {});

      const scopeOpts = args.onlyEngrams?.length ? { onlyGraphIds: args.onlyEngrams } : {};

      if (args.displayMaxNodes !== undefined) {
        const sub = await withEmbedding(() => deps.host.digDeeper(args.query, {
          budget: { maxTokens: args.maxTokens ?? 4000, maxNodes: args.displayMaxNodes! },
          skipEnrichment: true,
          ...scopeOpts,
        }));
        return {
          prompt: sub.prompt,
          tokensUsed: sub.tokensUsed,
          nodesIncluded: sub.nodesIncluded,
          byGraph: Object.fromEntries(sub.byGraph),
          audit: sub.audit,
          provenance: sub.digDeeperProvenance,
        };
      }

      const wideSub = await withEmbedding(() => deps.host.digDeeper(args.query, {
        budget: { maxTokens: 999_999, maxNodes: args.maxNodes ?? 50 },
        skipEnrichment: true,
        ...scopeOpts,
      }));
      const allCandidates = flattenByGraph(wideSub.byGraph);
      const topScore = allCandidates[0]?.score ?? 0;

      return {
        prompt: wideSub.prompt,
        tokensUsed: wideSub.tokensUsed,
        nodesIncluded: wideSub.nodesIncluded,
        byGraph: Object.fromEntries(wideSub.byGraph),
        audit: wideSub.audit,
        provenance: wideSub.digDeeperProvenance,
        allCandidates,
        topScore,
      };
    }

    case 'studio.setThresholdDelta': {
      assertStudioEnabled(deps);
      const args = z.object({
        type: z.enum(['recall', 'digDeeper']),
        delta: z.number().min(0).max(1.0),
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      const key = args.type === 'recall' ? 'recallThresholdDelta' : 'digDeeperThresholdDelta';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await deps.host.setSettings({ ai: { ...current.ai, [key]: args.delta } as any });
      return { ok: true };
    }

    case 'studio.llmQuery': {
      assertStudioEnabled(deps);
      const args = z.object({
        query: z.string().min(1),
        engrams: z.array(z.string()).optional(),
      }).parse(params ?? {});
      if (!deps.brainEngine) throw new Error('LLM_UNAVAILABLE: Brain engine not initialized.');
      const result = await deps.brainEngine.runDevelop({
        context: args.query,
        strategy: '',
        goals: '',
        ...(args.engrams?.length ? { graphIds: args.engrams } : {}),
      });
      return { synthesisMarkdown: result.synthesisMarkdown };
    }

    // Interpret the already-recalled raw context shown to the user.
    // Unlike studio.llmQuery (which runs its own recall via runDevelop),
    // this handler takes the raw subgraph text directly so the LLM reads
    // exactly what the user sees — no hallucination from a separate recall.
    case 'studio.llmInterpret': {
      assertStudioEnabled(deps);
      const args = z.object({
        query: z.string().min(1),
        rawContext: z.string().min(1),
        // Optional query-shape hint from the frontend's cheap heuristic.
        // brain-engine appends a shape-specific sub-prompt addendum;
        // omitting it falls back to the general base prompt.
        task: z.enum(['bio', 'qa', 'synthesis', 'compare']).optional(),
      }).parse(params ?? {});
      if (!deps.brainEngine) throw new Error('LLM_UNAVAILABLE: Brain engine not initialized.');
      const synthesis = await deps.brainEngine.interpretContext(
        args.rawContext, args.query,
        args.task ? { task: args.task } : undefined,
      );
      return { synthesisMarkdown: synthesis };
    }

    case 'studio.suggestEngram': {
      assertStudioEnabled(deps);
      const args = z.object({
        text: z.string().min(1),
        topK: z.coerce.number().int().min(1).max(5).optional(),
      }).parse(params ?? {});
      const topK = args.topK ?? 3;
      const candidates = deps.host.listGraphs()
        .map((graphId) => {
          const meta = deps.host.getGraphMetadata(graphId);
          return { graphId, displayName: meta?.displayName ?? graphId };
        })
        .slice(0, topK);
      return { candidates };
    }

    case 'studio.remember': {
      assertStudioEnabled(deps);
      const args = z.object({
        text: z.string().min(1),
        graphId: z.string().min(1),
        label: z.string().optional(),
        kind: z.enum(['clip', 'ai-conversation']).optional(),
      }).parse(params ?? {});
      const result = await withEmbedding(() => ingestClip(
        deps.host,
        args.graphId,
        args.text,
        args.label ?? 'MemoryStudio note',
        { addedBy: 'memory-studio', sourceKind: args.kind ?? 'clip' },
      ));
      return { ok: true, sourceId: result.sourceId, nodeCount: result.nodeIds.length };
    }

    case 'studio.edit': {
      assertStudioEnabled(deps);
      const args = z.object({
        correction: z.string().min(1),
        graphId: z.string().optional(),
      }).parse(params ?? {});
      const llm = deps.llm?.() ?? null;
      const { diff, candidates, mode, targetGraphId } = await proposeCorrection({
        host: deps.host,
        llm,
        correction: args.correction,
        ...(args.graphId ? { graphIdHint: args.graphId } : {}),
      });
      const resolvedGraphId = targetGraphId ?? args.graphId ?? candidates[0]?.graphId ?? deps.host.listGraphs()[0] ?? '';
      const diffId = `studio_diff_${Date.now().toString(36)}`;
      deps.pendingDiffs.set(diffId, { graphId: resolvedGraphId, diff, createdAt: Date.now() });
      deps.broadcastRaw({
        kind: 'correction.proposed',
        name: diffId,
        payload: {
          diffId,
          graphId: resolvedGraphId,
          correction: args.correction,
          requestedBy: 'memory-studio',
          changeCount: (diff.edits?.length ?? 0) + (diff.adds?.length ?? 0),
        },
      });
      return { diffId, mode, preview: diff, candidates };
    }

    case 'studio.gnnNeighbors': {
      assertStudioEnabled(deps);
      // ── Pro gate: GNN Exploration is Pro-only ────────────────────────
      // Same gate the MCP `gnn_neighbors` tool enforces. We surface a
      // structured upgrade-required response so the chip handler can
      // pop the existing license card instead of guessing at the error.
      {
        const licenseToken = await getEffectiveLicenseToken(deps);
        const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'gnn-exploration') ?? false;
        if (!licensed) {
          return {
            neighbors: [],
            upgrade_required: true,
            upgrade_url: 'https://graphnosis.com/upgrade',
            error: 'GNN Exploration requires a Graphnosis Pro subscription.',
          };
        }
      }
      const args = z.object({
        query: z.string().min(1),
        engram: z.string().optional(),
        limit: z.coerce.number().int().positive().max(20).optional(),
      }).parse(params ?? {});
      if (!deps.brainEngine) {
        return { neighbors: [], error: 'GNN not enabled. Enable it in Foresight → Neural Network.' };
      }
      const limit = args.limit ?? 10;
      let graphIds = deps.host.listGraphs();
      if (args.engram) {
        const found = graphIds.find(
          (id) => id === args.engram || deps.host.getGraphMetadata(id)?.displayName === args.engram,
        );
        if (found) graphIds = [found];
      }
      const neighbors: Array<{ nodeId: string; graphId: string; text: string; score: number; engramName: string }> = [];
      for (const graphId of graphIds) {
        // Get semantically close seeds for this query in this engram
        const seeds = await withEmbedding(
          () => deps.host.searchNodes(graphId, args.query, 5) as Promise<Array<{ nodeId: string; score: number }>>,
        );
        const seedIds = new Set(seeds.map((s) => s.nodeId));
        // Look up GNN-predicted edges where one end is a seed
        const edges = (deps.brainEngine!.getPredictedEdges(graphId) as unknown) as Array<{ from: string; to: string; score: number }>;
        const nodeList = deps.host.listNodes(graphId) as Array<{ id: string; contentPreview?: string }>;
        const textById = new Map(nodeList.map((n) => [n.id, n.contentPreview ?? '']));
        const engramName = deps.host.getGraphMetadata(graphId)?.displayName ?? graphId;
        for (const edge of edges) {
          const neighborId = seedIds.has(edge.from) ? edge.to : seedIds.has(edge.to) ? edge.from : null;
          if (!neighborId) continue;
          const text = textById.get(neighborId);
          if (!text) continue;
          neighbors.push({ nodeId: neighborId, graphId, text, score: edge.score, engramName });
          if (neighbors.length >= limit) break;
        }
        if (neighbors.length >= limit) break;
      }
      // Deduplicate by nodeId and sort by score descending
      const seen = new Set<string>();
      const deduped = neighbors
        .filter((n) => { if (seen.has(n.nodeId)) return false; seen.add(n.nodeId); return true; })
        .sort((a, b) => b.score - a.score);
      return { neighbors: deduped };
    }

    case 'studio.checkDuplicate': {
      assertStudioEnabled(deps);
      const args = z.object({
        text: z.string().min(1),
        engram: z.string().optional(),
        threshold: z.coerce.number().min(0.5).max(1.0).optional(),
      }).parse(params ?? {});
      const threshold = args.threshold ?? 0.85;
      let graphIds = deps.host.listGraphs();
      if (args.engram) {
        const found = graphIds.find(
          (id) => id === args.engram || deps.host.getGraphMetadata(id)?.displayName === args.engram,
        );
        if (found) graphIds = [found];
      }
      const hits: Array<{ score: number; graphId: string; engramName: string; text: string; nodeId: string }> = [];
      for (const graphId of graphIds) {
        const results = await withEmbedding(
          () => deps.host.searchNodes(graphId, args.text, 3) as Promise<Array<{ nodeId: string; score: number; contentPreview?: string }>>,
        );
        // searchNodes' contentPreview is documented as optional and is in
        // practice empty for embeddings-driven hits — without a fallback the
        // duplicate list renders the engram + percentage but no actual node
        // text, so the user has no way to judge whether the "match" is
        // really a duplicate. Look up the previews from listNodes once per
        // engram and join them in.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const previews = new Map<string, string>(
          (deps.host.listNodes(graphId) as Array<{ id: string; contentPreview?: string }>)
            .map((n) => [n.id, n.contentPreview ?? '']),
        );
        for (const r of results) {
          if (r.score >= threshold) {
            const text = ((r.contentPreview ?? '').trim() || previews.get(r.nodeId) || '').slice(0, 240);
            hits.push({
              score: r.score,
              graphId,
              engramName: deps.host.getGraphMetadata(graphId)?.displayName ?? graphId,
              text,
              nodeId: r.nodeId,
            });
          }
        }
      }
      return { duplicates: hits, hasDuplicates: hits.length > 0 };
    }

    case 'studio.setEnabled': {
      // Called by the subscription check (Stripe webhook via graphnosis.com backend)
      // or manually during development. Sets the flag that gates all studio.* methods.
      // TODO: in production, this should be called from the subscription-check
      // flow in main.ts after verifying with https://graphnosis.com/api/subscription/token
      const { enabled } = z.object({ enabled: z.boolean() }).parse(params ?? {});
      const current = deps.host.getSettings();
      // studioEnabled not yet in AiSettings type — cast until core adds it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await deps.host.setSettings({ ai: { ...current.ai, studioEnabled: enabled } as any });
      return { ok: true };
    }

    // ── Ghampus (local agent) ────────────────────────────────────────────
    case 'agent:status': {
      // Snapshot for the Chat tab to render the right surface (kill-switch
      // banner, contextual upsells based on tier). No gate — readable in
      // every state. Ghampus itself is open to every plan; the `plan`
      // field drives the upgrade language not access.
      const settings = deps.host.getSettings();
      const plan = await resolveAgentPlan(deps);
      const { resolveGhampusSkillMaintenance, resolveGhampusProactiveSettings } = await import('@graphnosis-app/core/settings');
      return {
        enabled: settings.agent?.enabled !== false,
        plan,
        skillMaintenance: resolveGhampusSkillMaintenance(settings.agent),
        proactive: resolveGhampusProactiveSettings(settings.agent),
      };
    }
    case 'agent:setEnabled': {
      // User-controlled kill switch. Always permitted — no gate — so the
      // user can always disable Ghampus regardless of license state.
      const { enabled } = z.object({ enabled: z.boolean() }).parse(params ?? {});
      const current = deps.host.getSettings();
      const prior = current.agent ?? { enabled: true };
      await deps.host.setSettings({
        ...current,
        agent: { ...prior, enabled },
      });
      return { ok: true };
    }
    case 'agent:setSkillMaintenance': {
      const args = z.object({
        enabled: z.boolean().optional(),
        idleOnly: z.boolean().optional(),
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      const prior = current.agent ?? { enabled: true };
      const { resolveGhampusSkillMaintenance } = await import('@graphnosis-app/core/settings');
      const sm = resolveGhampusSkillMaintenance(prior);
      await deps.host.setSettings({
        ...current,
        agent: {
          ...prior,
          skillMaintenance: {
            ...sm,
            ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
            ...(args.idleOnly !== undefined ? { idleOnly: args.idleOnly } : {}),
          },
        },
      });
      return { ok: true };
    }
    case 'agent:setProactive': {
      const args = z.object({
        startupDelayMs: z.number().int().nonnegative().optional(),
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      const prior = current.agent ?? { enabled: true };
      const { resolveGhampusProactiveSettings } = await import('@graphnosis-app/core/settings');
      const pr = resolveGhampusProactiveSettings(prior);
      await deps.host.setSettings({
        ...current,
        agent: {
          ...prior,
          proactive: {
            ...pr,
            ...(args.startupDelayMs !== undefined ? { startupDelayMs: args.startupDelayMs } : {}),
          },
        },
      });
      return { ok: true };
    }
    case 'agent:runTool': {
      // Run one Ghampus tool call through the full pipeline:
      // policy gate → tool handler → audit log → return result. Each step
      // can fail; failures are also audited so the inspector shows a
      // complete record of what was attempted.
      const { invokeAgentTool, AgentToolNotImplementedError } = await import('./agent-tools.js');
      const { assertCanInvokeTool, AgentPolicyError } = await import('./agent-policy.js');
      const { appendAuditEntry } = await import('./agent-audit.js');
      const args = z.object({
        tool: z.enum(['recall', 'stats', 'list_engrams', 'list_skills', 'remember', 'edit', 'forget']),
        args: z.record(z.string(), z.unknown()).optional(),
        conversationId: z.string().optional(),
      }).parse(params ?? {});
      const startedAt = Date.now();
      const cortexDir = deps.host.getCortexDir();
      const toolArgs = args.args ?? {};
      try {
        assertCanInvokeTool(
          { host: deps.host, licenseValidator: deps.licenseValidator ?? undefined },
          args.tool,
        );
      } catch (err) {
        if (err instanceof AgentPolicyError) {
          await appendAuditEntry(cortexDir, {
            tool: args.tool,
            args: toolArgs,
            result: null,
            error: err.message,
            startedAt,
            durationMs: Date.now() - startedAt,
            ...(args.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
            policyDenied: true,
            policyReason: err.reason,
          });
        }
        throw err;
      }
      try {
        const result = await invokeAgentTool(
          { host: deps.host, skillTrainer: deps.skillTrainer ?? null },
          args.tool,
          toolArgs,
        );
        await appendAuditEntry(cortexDir, {
          tool: args.tool,
          args: toolArgs,
          result,
          startedAt,
          durationMs: Date.now() - startedAt,
          ...(args.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
        });
        return { ok: true, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await appendAuditEntry(cortexDir, {
          tool: args.tool,
          args: toolArgs,
          result: null,
          error: message,
          startedAt,
          durationMs: Date.now() - startedAt,
          ...(args.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
        });
        if (err instanceof AgentToolNotImplementedError) {
          // Surface as a user-facing message rather than crash the IPC.
          return { ok: false, error: message };
        }
        throw err;
      }
    }
    case 'agent:listAuditEntries': {
      const { readRecentAuditEntries } = await import('./agent-audit.js');
      const { limit } = z.object({ limit: z.number().int().positive().max(500).optional() }).parse(params ?? {});
      const entries = await readRecentAuditEntries(deps.host.getCortexDir(), limit ?? 50);
      return { entries };
    }
    case 'agent:recentSaves': {
      // Drives the "Picking up where we left off" panel on the Ghampus
      // tab. Read-only; doesn't pass through the policy gate because the
      // panel needs to render even when Ghampus is killed (so the user
      // can see what was saved last session before resuming).
      const { listRecentSaves } = await import('./agent-tools.js');
      const args = z.object({
        limit: z.number().int().positive().max(50).optional(),
        sinceMs: z.number().int().positive().optional(),
      }).parse(params ?? {});
      return listRecentSaves({ host: deps.host }, args);
    }
    case 'agent:listNotifications': {
      // Drives the "While you were away" panel — inbound activity from
      // connectors, AI clients, sharing-token writes, direct ingest.
      // Excludes Ghampus's own saves (those live in agent:recentSaves so
      // the two surfaces are clean). No policy gate — visibility is the
      // whole point.
      const { listNotifications } = await import('./agent-notifications.js');
      const args = z.object({
        limit: z.number().int().positive().max(50).optional(),
        sinceMs: z.number().int().positive().optional(),
      }).parse(params ?? {});
      return listNotifications({ host: deps.host }, args);
    }
    case 'agent:listSkills': {
      // Surfaces the cortex's trained-skill library so the Ghampus tab
      // can render a skills awareness panel (matching what the Free tier
      // can already do via the MCP `list_skills` tool — Ghampus just
      // makes them discoverable in conversation).
      const { invokeAgentTool } = await import('./agent-tools.js');
      const args = z.object({ engramId: z.string().optional() }).parse(params ?? {});
      return invokeAgentTool({ host: deps.host, skillTrainer: deps.skillTrainer ?? null }, 'list_skills', args);
    }

    // ── Ghampus chat surface ──────────────────────────────────────────────
    case 'ghampus:history': {
      // Returns the persisted conversation thread from the cortex directory.
      try {
        const { readFile } = await import('node:fs/promises');
        const cortexDir = deps.cortexDir ?? deps.host.getCortexDir?.() ?? '';
        if (!cortexDir) return { messages: [] };
        const histPath = `${cortexDir}/ghampus-history.jsonl`;
        const raw = await readFile(histPath, 'utf8').catch(() => '');
        const messages = raw.trim().split('\n').filter(Boolean).map((line) => {
          try { return JSON.parse(line) as unknown; }
          catch { return null; }
        }).filter(Boolean);
        // Return last 100 messages to avoid huge payloads.
        return { messages: messages.slice(-100) };
      } catch {
        return { messages: [] };
      }
    }

    case 'ghampus:inbox:list': {
      const watcher = deps.proactiveWatcher;
      return { cards: watcher ? watcher.listCards() : [] };
    }

    case 'ghampus:inbox:dismiss': {
      const { id } = z.object({ id: z.string() }).parse(params ?? {});
      deps.proactiveWatcher?.dismissCard(id);
      return { ok: true };
    }

    case 'ghampus:inbox:snooze': {
      const { id, snoozeMs } = z.object({
        id: z.string(),
        snoozeMs: z.number().int().positive().optional(),
      }).parse(params ?? {});
      deps.proactiveWatcher?.snoozeCard(id, snoozeMs ?? 6 * 60 * 60 * 1000);
      return { ok: true };
    }

    case 'ghampus:inbox:run': {
      const { id } = z.object({ id: z.string() }).parse(params ?? {});
      const watcher = deps.proactiveWatcher;
      if (watcher) {
        watcher.markRunning(id);
        const card = watcher.listCards().find((c) => c.id === id);
        if (card) {
          deps.broadcastRaw({
            kind: 'ghampus.card',
            name: 'ghampus.card',
            payload: card,
          });
        }
      }
      return { ok: true };
    }

    case 'ghampus:activity': {
      const { busy } = z.object({ busy: z.boolean() }).parse(params ?? {});
      const { setGhampusUiBusy } = await import('./ghampus-busy.js');
      setGhampusUiBusy(busy);
      return { ok: true };
    }

    case 'ui:workScope': {
      const args = z.object({
        priority: z.number().int().min(0).max(3),
        active: z.boolean(),
      }).parse(params ?? {});
      try {
        const { setScopeActive } = await import('./work-priority.js');
        setScopeActive(args.priority as import('./work-priority.js').WorkPriority, args.active);
      } catch (err) {
        console.error('[ui:workScope] failed:', err instanceof Error ? err.message : String(err));
        throw err;
      }
      return { ok: true };
    }

    case 'ghampus:skillMaintenance:run': {
      const args = z.object({
        cardId: z.string().optional(),
        sourceId: z.string().optional(),
        batch: z.boolean().optional(),
      }).parse(params ?? {});
      const scheduler = deps.skillMaintenanceScheduler;
      if (!scheduler) return { ok: false, reason: 'scheduler-unavailable' };
      const card = scheduler.getPendingCard();
      if (args.cardId && card?.id !== args.cardId) {
        return { ok: false, reason: 'card-not-found' };
      }
      const sourceIds = args.batch && card
        ? card.batchSourceIds
        : [args.sourceId ?? card?.skillSourceId].filter(Boolean) as string[];
      if (sourceIds.length === 0) return { ok: false, reason: 'no-target' };
      const { incrementGhampusBusy, decrementGhampusBusy } = await import('./ghampus-busy.js');
      incrementGhampusBusy();
      try {
        return await scheduler.runRetrain(sourceIds);
      } finally {
        decrementGhampusBusy();
      }
    }

    case 'ghampus:skillMaintenance:snooze': {
      const args = z.object({
        cardId: z.string(),
        snoozeMs: z.number().int().positive().optional(),
      }).parse(params ?? {});
      deps.skillMaintenanceScheduler?.snoozeCard(args.cardId, args.snoozeMs ?? 6 * 60 * 60 * 1000);
      return { ok: true };
    }

    case 'ghampus:skillMaintenance:dismiss': {
      const { cardId } = z.object({ cardId: z.string() }).parse(params ?? {});
      await deps.skillMaintenanceScheduler?.dismissAndSnooze(cardId);
      return { ok: true };
    }

    case 'ghampus:digest': {
      const args = z.object({ sinceMs: z.number().optional() }).parse(params ?? {});
      const sinceMs = args.sinceMs ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
      const cortexDir = deps.cortexDir ?? deps.host.getCortexDir?.() ?? '';
      if (!cortexDir) return { emitted: false };
      const histPath = `${cortexDir}/ghampus-history.jsonl`;
      const { readFile, appendFile } = await import('node:fs/promises');
      const {
        hasRecentAwayDigest,
        buildAwayDigestText,
      } = await import('./away-digest.js');

      type HistMsg = { kind?: string; text?: string; ts?: number };
      const tail: HistMsg[] = (await readFile(histPath, 'utf8').catch(() => ''))
        .trim().split('\n').filter(Boolean).slice(-40)
        .map((line) => { try { return JSON.parse(line) as HistMsg; } catch { return null; } })
        .filter((m): m is HistMsg => m != null);

      const { listNotifications } = await import('./agent-notifications.js');
      const { notifications, totalAvailable } = listNotifications({ host: deps.host }, { sinceMs, limit: 12 });

      if (notifications.length === 0) {
        if (hasRecentAwayDigest(tail, true)) return { emitted: false };
      } else if (hasRecentAwayDigest(tail, false)) {
        return { emitted: false };
      }

      const llm = deps.llm?.() ?? null;
      const text = await buildAwayDigestText(notifications, totalAvailable, llm);

      const digestMsg = { kind: 'ghampus', text, ts: Date.now() };
      await appendFile(histPath, JSON.stringify(digestMsg) + '\n').catch(() => {});
      return { emitted: true };
    }
    case 'ghampus:send': {
      // Recall memory context, call local LLM, emit response as a
      // 'ghampus.message' event (forwarded to frontend as
      // 'graphnosis://ghampus-message' by event_stream.rs).
      const { text } = z.object({ text: z.string() }).parse(params ?? {});

      // Persist the user message immediately.
      const cortexDirForHistory = deps.cortexDir ?? deps.host.getCortexDir?.() ?? '';
      const histPath = cortexDirForHistory ? `${cortexDirForHistory}/ghampus-history.jsonl` : '';
      const userMsg: Record<string, unknown> = { kind: 'user', text, ts: Date.now() };
      if (histPath) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(histPath, JSON.stringify(userMsg) + '\n').catch(() => {});
      }

      const llm = deps.llm?.() ?? null;
      if (!llm) {
        const noLlmMsg = {
          kind: 'ghampus',
          text: 'Local LLM is not available. Enable Ollama in **Settings → Models**.',
          ts: Date.now(),
        };
        if (histPath) {
          const { appendFile } = await import('node:fs/promises');
          await appendFile(histPath, JSON.stringify(noLlmMsg) + '\n').catch(() => {});
        }
        deps.broadcastRaw({
          kind: 'ghampus.message',
          name: 'ghampus.message',
          payload: noLlmMsg,
        });
        return { ok: true };
      }
      // Fire-and-forget so IPC returns immediately; response arrives via event.
      void (async () => {
        const { incrementGhampusBusy, decrementGhampusBusy } = await import('./ghampus-busy.js');
        incrementGhampusBusy();
        // Signal "thinking" immediately so the UI can show a spinner.
        deps.broadcastRaw({
          kind: 'ghampus.thinking',
          name: 'ghampus.thinking',
          payload: { thinking: true, ts: Date.now() },
        });
        try {
          const { listRecentSaves } = await import('./agent-tools.js');

          // Universal MCP tool adapter — all tool calls route through the exact same
          // handlers as external AI clients. No tool logic is duplicated here.
          const ghampusTool = async (name: string, toolArgs: Record<string, unknown> = {}): Promise<unknown> => {
            if (!deps.callMcpTool) throw new Error(`[ghampus] callMcpTool not wired — cannot call ${name}`);
            const result = await deps.callMcpTool(name, toolArgs);
            if (result.isError) throw new Error(result.content[0]?.text ?? `MCP ${name} error`);
            const rawText = result.content[0]?.text ?? '';
            // Normalize MCP text output to the structured shapes Ghampus expects.
            switch (name) {
              case 'list_engrams': {
                // MCP returns JSON.stringify(rows) + optional notice suffix.
                // Slice to last ] to safely strip any trailing non-JSON text.
                try {
                  const jsonText = rawText.slice(0, rawText.lastIndexOf(']') + 1).trim();
                  const rows = JSON.parse(jsonText);
                  return { engrams: Array.isArray(rows) ? rows : [] };
                } catch { return { engrams: [] }; }
              }
              case 'list_skills': {
                // MCP returns formatted markdown text, not JSON.
                if (!rawText || rawText.startsWith('No trained')) return { skills: [] };
                const skills: Array<{ label: string; trainedAt?: string }> = [];
                const blocks = rawText.split('\n\n').filter((b: string) => b.startsWith('**'));
                for (const block of blocks) {
                  const lines = block.split('\n');
                  const label = lines[0]?.replace(/^\*\*|\*\*$/g, '') ?? '';
                  const trainedAt = lines.find((l: string) => l.includes('Trained:'))?.match(/Trained:\s+(\S+)/)?.[1];
                  if (label) skills.push({ label, ...(trainedAt ? { trainedAt } : {}) });
                }
                return { skills };
              }
              case 'stats': {
                // MCP returns JSON + optional notice — find last } to safely strip suffix.
                try {
                  const jsonText = rawText.slice(0, rawText.lastIndexOf('}') + 1).trim();
                  return JSON.parse(jsonText);
                } catch { return {}; }
              }
              case 'recall':
              case 'remind':
              case 'dig_deeper':
              case 'recall_with_citations':
                // Return in the shape Ghampus expects (prompt = raw knowledge subgraph text).
                return { prompt: rawText, nodesIncluded: (rawText.match(/\[[\w-]+\|/g) ?? []).length, tokensUsed: 0, engramsContributing: [], sharingProvenance: [], attachments: [] };
              case 'recent': {
                // MCP: "Recent — scope (N total):\n\n• ISO-date  [kind]  ref  (EngramLabel)"
                const lines = rawText.split('\n').filter((l: string) => l.startsWith('•'));
                const sources = lines.map((l: string) => {
                  const m = l.match(/^•\s+(\S+)\s+\[[^\]]+\]\s+(\S+)\s+\(([^)]+)\)/);
                  // m[1]=date  m[2]=ref  m[3]=engram display name
                  return m ? { ingestedAt: m[1], label: m[2], engramName: m[3] } : null;
                }).filter(Boolean);
                return { sources };
              }
              case 'find_source': {
                // MCP: "Found N source(s):\n\n• [kind] ref  |  (EngramLabel)  |  date  |  id: sourceId"
                const lines = rawText.split('\n').filter((l: string) => l.startsWith('•'));
                const sources = lines.map((l: string) => {
                  const parts = l.replace(/^•\s+/, '').split('|').map((s: string) => s.trim());
                  const label = parts[0]?.replace(/^\[[^\]]+\]\s+/, '') ?? '';
                  const engramName = (parts[1] ?? '').replace(/^\(|\)$/g, '').trim();
                  const sourceId = (parts[3] ?? '').replace(/^id:\s*/, '').trim();
                  return label ? { label, engramName, sourceId } : null;
                }).filter(Boolean);
                return { sources };
              }
              case 'remember':
                return { ok: true };
              case 'recall_structured': {
                try {
                  const jsonText = rawText.slice(0, rawText.lastIndexOf('}') + 1).trim();
                  return JSON.parse(jsonText) as {
                    nodes?: Array<{ text?: string; engram?: string; graphId?: string; sourceId?: string; score?: number }>;
                    nodesIncluded?: number;
                    _notice?: string;
                  };
                } catch { return { nodes: [] }; }
              }
              default:
                return { rawText };
            }
          };
          const q = text.toLowerCase();

          // ── Intent detection ──────────────────────────────────────────────
          const wantsRecent    = /recent|latest|last|new|today|added|ingested|saved recently/i.test(text);
          const wantsSkills    = /skill|procedure|sop|workflow|how (do|to|should)|step.by.step|walk/i.test(text);
          const wantsStats     = /stat|count|how many|total|size|storage|node|health|vitality/i.test(text);
          const wantsSource    = /source|file|document|attachment|pdf|url|link|ref/i.test(text);
          const wantsCitations = /where did|which source|cite|citation|proof|evidence/i.test(text);

          // Exhaustive-listing intent: user wants broad recall (higher caps, dig_deeper).
          const wantsExhaustive =
            /\b(list all|show all|find all|give me all|what are all|all (my |the )?(nodes?|todos?|tasks?|items?|entries)|every|enumerate)\b/i.test(text)
            || /\b(list|show)\b.*\b(todos?|tasks?|items?|entries|obligations?|memories)\b/i.test(text);
          // Grouped/aggregated answers need LLM synthesis — never raw-dump these.
          const wantsGrouped =
            /\b(by team member|by member|grouped by|group by|per person|by person|by owner|by assignee|organized by|sorted by)\b/i.test(text)
            || /\b(list|show)\b.+\bby\s+\w+/i.test(text);

          // RecallInput schema caps maxNodes at 50 — stay within that bound.
          const recallMaxNodes  = (wantsExhaustive || wantsGrouped) ? 50 : 20;
          const recallMaxTokens = (wantsExhaustive || wantsGrouped) ? 8000 : 2000;
          // Structured list queries: skip LLM query rewrite — cross-language expansion
          // (e.g. Romanian "membrii echipei") pulls wrong engrams like "UnpublishedRomania".
          const skipEnrichmentRecallOpts = (wantsExhaustive || wantsGrouped)
            ? { skip_enrichment: true as const }
            : {};

          // ── Helper: emit a Ghampus response and persist it ───────────────────
          // Defined early so slash-command handlers can use it before the LLM path.
          const emitGhampusMsg = async (responseText: string) => {
            const responseMsg = { kind: 'ghampus', text: responseText, ts: Date.now() };
            if (histPath) {
              const { appendFile } = await import('node:fs/promises');
              await appendFile(histPath, JSON.stringify(responseMsg) + '\n').catch(() => {});
            }
            deps.broadcastRaw({ kind: 'ghampus.message', name: 'ghampus.message', payload: responseMsg });
          };

          // ── Pending clarification resolution ─────────────────────────────
          // If the previous turn was uncertain, we asked the user to confirm.
          // A simple yes/no/save/recall here resolves the deferred action.
          // Anything else clears the pending state and processes normally.
          if (ghampusPendingClarification) {
            const pending = ghampusPendingClarification;
            const t = text.trim().toLowerCase().replace(/[!.]+$/, '');
            const confirmsSave   = /^(yes|save( it)?|do it|store( it)?|keep( it)?|confirm|ok|okay|sure|yep|yeah|si|oui|ja|да|s[íi]|罗|sí)$/i.test(t);
            const confirmsRecall = /^(no|recall|search|look( it)? up|find( it)?|don'?t save|nope|nah|cancel|skip|non|nein|нет|否)$/i.test(t);
            if (confirmsSave) {
              ghampusPendingClarification = null;
              const engListForSave2 = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string }> };
              const allEngrams2 = engListForSave2.engrams ?? [];
              const matched2 = allEngrams2.find((e) => e.tier === 'personal') ?? allEngrams2[0] ?? null;
              if (!matched2) { await emitGhampusMsg('No engrams to save to yet. Create one with `/create [name]`.'); return { ok: true }; }
              const LLM_PH = new Set(['ENGRAM_NAME_OR_NULL', 'TEXT_TO_SAVE', 'ENGRAM_NAME', 'NULL', 'null', '']);
              const hint2 = pending.engramHint && !LLM_PH.has(pending.engramHint) ? pending.engramHint.toLowerCase() : null;
              const target2 = hint2
                ? allEngrams2.find((e) => e.graphId === hint2 || e.graphId.includes(hint2.replace(/[^a-z0-9]+/g, '-')) || e.displayName.toLowerCase().includes(hint2)) ?? matched2
                : matched2;
              try {
                await ghampusTool('remember', { graphId: target2.graphId, text: pending.content, label: pending.content.slice(0, 80) });
                await emitGhampusMsg(`Saved to **${target2.displayName}**.`);
              } catch (e) { await emitGhampusMsg(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`); }
              return { ok: true };
            }
            if (confirmsRecall) {
              ghampusPendingClarification = null;
              const recallResult = await ghampusTool('recall', { query: pending.originalText, maxNodes: 20 }).catch(() => null) as { prompt?: string } | null;
              const answer = recallResult?.prompt
                ? await llm.complete({ system: 'You are Ghampus. Answer concisely using the memory context below.', user: `Context:\n${recallResult.prompt}\n\nQuestion: ${pending.originalText}` }).catch(() => null)
                : null;
              await emitGhampusMsg(answer ?? recallResult?.prompt ?? "I couldn't find anything on that. Try rephrasing.");
              return { ok: true };
            }
            // Not a simple yes/no — drop pending state and classify the new message fresh.
            ghampusPendingClarification = null;
            // Also drop any deferred engram-create save when user abandons the flow.
            if (!/create|engram|creat|make\s+engram|new\s+engram/i.test(text)) {
              ghampusPendingEngram = null;
            }
          }

          // ── Slash-command dispatch (bypasses intent classifier entirely) ─────
          if (text.startsWith('/')) {
            const [rawCmd = '', ...rawArgParts] = text.slice(1).trim().split(/\s+/);
            const cmd = rawCmd.toLowerCase();
            const argsStr = rawArgParts.join(' ').trim();

            switch (cmd) {
              case 'help': {
                await emitGhampusMsg(
                  '**Ghampus slash commands:**\n\n' +
                  '- `/save [content] [@engram]` — save a memory to your cortex\n' +
                  '- `/create [engram name]` — create a new engram\n' +
                  '- `/engrams` — list all your engrams\n' +
                  '- `/skills` — list all your skills\n' +
                  '- `/forget` — manage / delete memories (opens Memory Studio)\n' +
                  '- `/help` — show this list\n\n' +
                  'You can also just chat naturally — Ghampus understands plain language for all of these.',
                );
                return { ok: true };
              }

              case 'engrams': {
                const res = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string; loaded: boolean }> };
                const list = res.engrams ?? [];
                if (!list.length) {
                  await emitGhampusMsg('No engrams found. Create one with `/create [name]`.');
                } else {
                  const lines = list.map((e) =>
                    `- **${e.displayName}** \`${e.graphId}\` (${e.tier}${e.loaded ? '' : ', not loaded'})`
                  ).join('\n');
                  await emitGhampusMsg(`**Your engrams (${list.length}):**\n\n${lines}`);
                }
                return { ok: true };
              }

              case 'skills': {
                const res = await ghampusTool('list_skills', {}) as { skills?: Array<{ label: string; trainedAt?: string; vitality?: number }> };
                const skills = res.skills ?? [];
                if (!skills.length) {
                  await emitGhampusMsg('No skills found. Train one in the Skills page.');
                } else {
                  const lines = skills.map((s) => {
                    const label = s.label.replace(/^skill:\d+:/, '').replace(/-/g, ' ');
                    const v = s.vitality != null ? ` · vitality ${s.vitality}` : '';
                    return `- **${label}**${v}`;
                  }).join('\n');
                  await emitGhampusMsg(`**Your skills (${skills.length}):**\n\n${lines}`);
                }
                return { ok: true };
              }

              case 'forget': {
                await emitGhampusMsg(
                  'To delete or edit memories, go to **Memory Studio** and find the node or source you want to remove.\n\n' +
                  'I can also search for something specific first — just ask: "find my notes about X".',
                );
                return { ok: true };
              }

              case 'save': {
                if (!argsStr) {
                  await emitGhampusMsg('Usage: `/save [content] [@engram]`\n\nExample: `/save I need to fix Ghampus @coding`');
                  return { ok: true };
                }
                // Parse optional @engram at the end
                const atMatch = argsStr.match(/\s@([\w-]+)$/);
                const engramSlug = atMatch?.[1]?.toLowerCase() ?? null;
                const saveContent = atMatch ? argsStr.slice(0, argsStr.lastIndexOf(atMatch[0])).trim() : argsStr;
                const engListSave = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string }> };
                const allEngrams = engListSave.engrams ?? [];
                let matched = allEngrams.find((e) => e.tier === 'personal') ?? allEngrams[0] ?? null;
                if (engramSlug) {
                  const explicit = allEngrams.find((e) => e.graphId === engramSlug || e.graphId.includes(engramSlug) || e.displayName.toLowerCase().includes(engramSlug));
                  if (!explicit) {
                    const names = allEngrams.map((e) => `\`@${e.graphId}\``).join(', ');
                    await emitGhampusMsg(`No engram matching \`@${engramSlug}\`. Available: ${names || 'none'}.`);
                    return { ok: true };
                  }
                  matched = explicit;
                }
                if (!matched) {
                  await emitGhampusMsg('No engrams yet. Create one with `/create [name]`.');
                  return { ok: true };
                }
                try {
                  await ghampusTool('remember', { graphId: matched.graphId, text: saveContent, label: saveContent.slice(0, 80) });
                  await emitGhampusMsg(`Saved to **${matched.displayName}**.`);
                } catch (e) {
                  await emitGhampusMsg(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
                }
                return { ok: true };
              }

              case 'create': {
                if (!argsStr) {
                  await emitGhampusMsg('Usage: `/create [engram name]`\n\nExample: `/create Work Notes`');
                  return { ok: true };
                }
                const graphId = argsStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                const engListCreate = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string }> };
                const existing = engListCreate.engrams?.find((e) => e.graphId === graphId || e.displayName.toLowerCase() === argsStr.toLowerCase());
                if (existing) {
                  await emitGhampusMsg(`**${existing.displayName}** already exists. Want to save something to it?`);
                  return { ok: true };
                }
                try {
                  await deps.host.createGraph(graphId);
                  const pendingSlashCreate = ghampusPendingEngram;
                  const pendingSlugSc = pendingSlashCreate?.engramHint.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                  if (pendingSlashCreate && (pendingSlugSc === graphId || pendingSlashCreate.engramHint.toLowerCase().includes(argsStr.toLowerCase()) || argsStr.toLowerCase().includes(pendingSlashCreate.engramHint.toLowerCase()))) {
                    ghampusPendingEngram = null;
                    await ghampusTool('remember', { graphId, text: pendingSlashCreate.content, label: pendingSlashCreate.content.slice(0, 80) });
                    await emitGhampusMsg(`Created engram **${argsStr}** and saved your note: "${pendingSlashCreate.content.slice(0, 120)}${pendingSlashCreate.content.length > 120 ? '…' : ''}"`);
                  } else {
                    await emitGhampusMsg(`Created engram **${argsStr}** (\`${graphId}\`). Use \`/save [content] @${graphId}\` to add memories.`);
                  }
                } catch (e) {
                  await emitGhampusMsg(`Couldn't create: ${e instanceof Error ? e.message : String(e)}`);
                }
                return { ok: true };
              }

              default: {
                // Unknown slash command — let the user know and list valid ones.
                await emitGhampusMsg(
                  `Unknown command \`/${cmd}\`. Try:\n` +
                  '`/save` `/create` `/engrams` `/skills` `/forget` `/help`',
                );
                return { ok: true };
              }
            }
          }

          // ── Intent classification: LLM with keyword fallback ────────────────
          // Step 1 — lightweight keyword scoring (no LLM, instant).
          // Catches obvious patterns even if the LLM call fails.
          type GhampusIntent =
            | { action: 'remember'; content: string; engram: string | null }
            | { action: 'create_engram'; name: string }
            | { action: 'ui_only'; reason: string }
            | { action: 'recall' };

          function keywordIntent(msg: string): GhampusIntent | null {
            const m = msg.trim();
            // Score write verbs using character-level similarity to handle typos.
            // A word scores as a write-verb if ≥60% of its chars overlap with the target.
            const firstWord = (m.split(/\s+/)[0] ?? '').toLowerCase();
            const verbScores: Record<string, string[]> = {
              remember: ['remember', 'remeber', 'remmber', 'remmeber', 'remmbr', 'remb', 'recuerda', 'noter', 'запомни', 'merkt'],
              save:     ['save', 'sav', 'saev', 'store', 'stor', 'keep', 'kep', 'note', 'jot', 'add', 'salva', 'speichern', 'zapisz'],
              create:   ['create', 'creat', 'crete', 'make', 'mak', 'new', 'add', 'build', 'créer', 'erstell', 'crea'],
              delete:   ['delete', 'delet', 'remove', 'remov', 'drop', 'erase', 'del'],
            };
            const isVerb = (target: keyof typeof verbScores) =>
              (verbScores[target] ?? []).some((v) => {
                if (firstWord === v) return true;
                if (Math.abs(firstWord.length - v.length) > 3) return false;
                let common = 0;
                for (const c of firstWord) if (v.includes(c)) common++;
                return common / Math.max(firstWord.length, v.length) >= 0.6;
              });

            const lower = m.toLowerCase();
            const hasEngramWord = /\bengram\b/.test(lower);

            if (isVerb('create') && hasEngramWord) {
              const nameM = m.match(/(?:engram\s+)?(?:called|named|:)?\s*["']?([^"'\n]{1,60})["']?\s*$/i);
              const name = nameM?.[1]?.trim() ?? '';
              if (name && !/^engram$/i.test(name)) return { action: 'create_engram', name };
            }
            if (isVerb('delete') && hasEngramWord) {
              return { action: 'ui_only', reason: 'engram deletion requires Memory Studio' };
            }
            if (isVerb('remember') || isVerb('save')) {
              // Try "verb in/to [engram] that/: [content]" (word order A)
              const mA = m.replace(/^\S+\s+/, '').match(
                /^(?:in|to|into)\s+(?:(?:my|the)\s+)?["']?([^"',\n]{1,50?})["']?\s*(?:engram\s+)?(?:that|:|–|-|,)?\s+(.+)$/i,
              );
              if (mA?.[2]?.trim()) return { action: 'remember', content: mA[2].trim(), engram: mA![1]!.trim() };
              // Try "verb [content] in/to [engram]" (word order B)
              const mB = m.replace(/^\S+\s+/, '').match(
                /^(?:that\s+)?(.+?)\s+(?:to|in|into)\s+(?:(?:my|the)\s+)?["']?([^"',\n]{1,50})["']?\s*(?:engram)?$/i,
              );
              if (mB?.[1]?.trim()) return { action: 'remember', content: mB[1].trim(), engram: mB[2]?.trim() ?? null };
              // Bare: "verb [content]" with no target
              const bare = m.replace(/^\S+\s+(?:that\s+)?/, '').trim();
              if (bare.length >= 3) return { action: 'remember', content: bare, engram: null };
            }
            return null;
          }

          // Step 1b — question pre-classifier: runs before keyword scorer.
          // Catches context-following questions ("what about X?", "how about Y?",
          // single-entity follow-ups, anything question-shaped with no save verb).
          // If it fires, we skip the LLM entirely — no ambiguity.
          function questionIntent(msg: string): GhampusIntent | null {
            const m = msg.trim();
            const lower = m.toLowerCase();
            // Never classify as recall if there's an explicit save verb present.
            const hasSaveVerb = /\b(remember|remmber|remeber|save|sav|store|keep|note|jot|noter|salva|guardar|speichern|записать)\b/i.test(lower);
            if (hasSaveVerb) return null;
            // "remember when/the time/that night" → recall (not save)
            if (/^remember\s+(when|the\s+time|that\s+night|that\s+day|how|why|who|where)/i.test(m)) return { action: 'recall' };
            // "do you remember / don't you remember / can you recall" → recall
            if (/^(do you|don't you|dont you|can you|could you)\s+(remember|recall|find|tell|show)/i.test(m)) return { action: 'recall' };
            // Explicit question-phrase prefixes — collapse ~30 patterns into one regex:
            //   "what about / how about / tell me about / anything on / anything about /
            //    what's X / what is X / what are X / what do/did / how do/did / who is /
            //    where is / when did / show me / find / look up / search / do i have /
            //    is there / are there / give me / list / any info on"
            if (/^(what about|how about|tell me about|anything (on|about|for|in)|what'?s\b|what (is|are|do|did|can|could|was|were|have)\b|how (do|did|is|are|many|much|come)\b|who (is|are|was|were|did|has|have)\b|where (is|are|was|were|did)\b|when (did|was|were|is|are|do|does)\b|why (did|is|are|was|were|do|does)\b|which\b|show me|find (me |out |the )?|look up|search (for |the )?|do i (have|know|remember|own|need)\b|is there\b|are there\b|give me\b|list (my |the |all )?|any info|can i\b|could i\b|would\b|should\b|how to\b)/i.test(lower)) {
              return { action: 'recall' };
            }
            // Short message (≤5 words) ending in "?" with no save verb → recall
            if (m.endsWith('?') && m.split(/\s+/).length <= 5) return { action: 'recall' };
            // Any message ending in "?" with no save verb and no colon (colons suggest "note: ...")
            if (m.endsWith('?') && !m.includes(':')) return { action: 'recall' };
            return null;
          }

          // Step 2 — LLM classification (typo-proof, multilingual, nuanced).
          // Keyword result or question pre-classifier takes priority; LLM only
          // runs if neither fires. Constrained to echo the exact engram name the
          // user wrote — no substitution, no fuzzy-matching.
          const keywordResult = questionIntent(text) ?? keywordIntent(text);
          let intent: GhampusIntent = keywordResult ?? { action: 'recall' };
          let llmConfidence: number | null = null;

          if (!keywordResult) {
            const { isBusyAbove, tryAcquireLlmSlot, WorkPriority } = await import('./work-priority.js');
            const { isGhampusBusy } = await import('./ghampus-busy.js');
            if (!isBusyAbove(WorkPriority.P2_GHAMPUS) || isGhampusBusy()) {
              const classifySlot = tryAcquireLlmSlot(WorkPriority.P2_GHAMPUS);
              if (classifySlot) {
                try {
            // Load the last 3 turns from history to give the LLM conversation context.
            // This lets it understand "what about X?" after a recall response.
            let recentContext = '';
            if (histPath) {
              try {
                const { readFile } = await import('node:fs/promises');
                const raw = await readFile(histPath, 'utf8').catch(() => '');
                const turns = raw.trim().split('\n').filter(Boolean).slice(-7)
                  .map((line) => { try { return JSON.parse(line) as { kind: string; text: string }; } catch { return null; } })
                  .filter((t): t is { kind: string; text: string } => !!t && !!t.text);
                // Exclude the current message (last entry) from context
                const contextTurns = turns.slice(0, -1).slice(-6);
                if (contextTurns.length > 0) {
                  recentContext = '\n\nConversation history (most recent last):\n' +
                    contextTurns.map((t) => `${t.kind === 'user' ? 'User' : 'Ghampus'}: ${t.text.slice(0, 300)}`).join('\n');
                }
              } catch { /* non-fatal */ }
            }

            const engListForIntent = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string }> };
            const engramList = (engListForIntent.engrams ?? []).map((e) => `${e.graphId}="${e.displayName}"`).join(', ');

            const classifySystem =
              'Intent classifier for Graphnosis (personal knowledge graph). ' +
              'Output ONLY a single JSON object — no prose, no code fences, no explanation.\n' +
              'Always include a "confidence" field (0.0–1.0) — how certain you are about the action.\n\n' +
              'Schemas:\n' +
              '{"action":"remember","content":"TEXT_TO_SAVE","engram":"ENGRAM_NAME_OR_NULL","confidence":0.95}\n' +
              '{"action":"create_engram","name":"ENGRAM_NAME","confidence":0.9}\n' +
              '{"action":"ui_only","reason":"engram deletion requires UI"|"rename requires UI"|"merge requires UI","confidence":0.9}\n' +
              '{"action":"recall","confidence":0.85}\n\n' +
              'Rules — apply even with heavy spelling errors or any language:\n' +
              '• Save verbs → action=remember: remember/save/store/note/add/keep/jot/noter/salva/guardar/speichern/записать + all typos (remmber, remeber, sav, stor…)\n' +
              '• create/make/new/creat/créer/erstell + engram → action=create_engram\n' +
              '• delete/remove/rename/merge + engram → action=ui_only\n' +
              '• QUESTION RULE: Any message shaped as a question (starts with what/who/when/where/how/why/which/tell me/show me/find/is there/do I/any, or ends with ?) → action=recall, even if it mentions a known engram name.\n' +
              '• CONTEXT RULE: If history shows a recall exchange immediately before, a short follow-up ("what about X", "and Y?", "how about Z") continues the recall — do NOT classify as remember.\n' +
              '• Any other message → action=recall\n\n' +
              'Confidence guidance:\n' +
              '• Explicit save verb present → confidence ≥ 0.9\n' +
              '• Clear question word present → confidence ≥ 0.9\n' +
              '• No clear verb, ambiguous noun/phrase → confidence ≤ 0.6\n' +
              '• Short message with no verb and no question mark → confidence ≤ 0.5\n' +
              '• Single entity name (no verb, no ?) → confidence 0.4\n\n' +
              'Engram extraction (for action=remember — only when a genuine save verb is present):\n' +
              '• "verb in/to/into X that Y"  → content=Y  engram=X\n' +
              '• "verb Y in/to/into X"        → content=Y  engram=X\n' +
              '• "verb Y" with no target      → content=Y  engram=null\n' +
              '• If content is unclear (user wrote "save this" with no text) → action=recall\n' +
              `• Known engrams (reference only): ${engramList || 'none'}\n` +
              '• CRITICAL: engram = the EXACT word/phrase the user wrote. Do NOT substitute, rephrase, or fuzzy-match to a known engram. "test" → engram="test", not "graphnosis-it-architecture".\n' +
              '• content must not be empty for action=remember. If you cannot extract content, use action=recall instead.' +
              recentContext;

            if (!classifySlot.signal.aborted) {
            const classifyRaw = await llm.complete({
              system: classifySystem,
              user: text,
              jsonSchema: { type: 'object', properties: { action: { type: 'string' }, confidence: { type: 'number' } }, required: ['action'] },
              signal: classifySlot.signal,
            });
            console.log('[ghampus:classify] raw:', classifyRaw.slice(0, 200));
            // Use greedy match to capture the outermost JSON object (handles nested values).
            const jsonMatch = classifyRaw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]) as GhampusIntent & { confidence?: number };
              if (['remember', 'create_engram', 'ui_only', 'recall'].includes(parsed.action)) {
                intent = parsed;
                llmConfidence = typeof parsed.confidence === 'number' ? parsed.confidence : null;
                console.log('[ghampus:classify] intent:', JSON.stringify(intent), 'confidence:', llmConfidence);
              }
            }
            }
                } catch (err) {
                  // LLM classification failed — stick with keyword result or recall.
                  if (err instanceof DOMException && err.name === 'AbortError') {
                    console.warn('[ghampus:classify] aborted — using keyword fallback');
                  } else {
                    console.warn('[ghampus:classify] failed, using keyword fallback:', err instanceof Error ? err.message : String(err));
                  }
                } finally {
                  classifySlot.release();
                }
              }
            }
          }

          // ── Dispatch write actions ────────────────────────────────────────────
          if (intent.action === 'remember') {
            const { content: saveContent, engram: rawEngramHint } = intent as Extract<GhampusIntent, { action: 'remember' }>;
            // Guard: LLM returned action=remember but no content (prompt rule violation).
            if (!saveContent?.trim()) {
              await emitGhampusMsg("What would you like me to save? Just tell me the content and I'll take care of it.");
              return { ok: true };
            }
            // Sanitize placeholder strings the LLM may echo literally from the prompt template.
            const LLM_PLACEHOLDERS = new Set(['ENGRAM_NAME_OR_NULL', 'TEXT_TO_SAVE', 'ENGRAM_NAME', 'NULL', 'null', '']);
            const engramHint = rawEngramHint && !LLM_PLACEHOLDERS.has(rawEngramHint) ? rawEngramHint : null;

            // ── Uncertainty gate ─────────────────────────────────────────────
            // If the keyword pre-classifier didn't fire (no explicit save verb
            // detected) AND the LLM confidence is below 0.75, ask before saving.
            // This prevents misclassifying questions, entity lookups, or
            // context-following messages as save actions.
            const isLowConfidence = !keywordResult && (llmConfidence === null || llmConfidence < 0.75);
            if (isLowConfidence) {
              const preview = saveContent.length > 80 ? saveContent.slice(0, 77) + '…' : saveContent;
              ghampusPendingClarification = { originalText: text, content: saveContent, engramHint };
              await emitGhampusMsg(
                `Did you want to **save** "${preview}" or **look something up**?\n\n` +
                `Reply **save** to store it${engramHint ? ` in ${engramHint}` : ''}, or **recall** to search your memory instead.`,
              );
              return { ok: true };
            }

            const engListForSave = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string; tier: string }> };
            const allEngrams = engListForSave.engrams ?? [];

            // Match engram: exact graphId, slugified hint vs graphId, or displayName substring.
            // Normalizing both sides to slug form (spaces→hyphens) catches LLM returning
            // "Book Notes" when the graphId is "book-notes".
            let matched = allEngrams.find((e) => e.tier === 'personal') ?? allEngrams[0] ?? null;
            if (engramHint) {
              const hint = engramHint.toLowerCase();
              const hintSlug = hint.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
              const explicit = allEngrams.find(
                (e) =>
                  e.graphId === hint ||
                  e.graphId === hintSlug ||
                  e.graphId.replace(/-/g, ' ').includes(hint) ||
                  e.displayName.toLowerCase().includes(hint),
              );
              if (!explicit) {
                // Engram doesn't exist — stash the save and ask the user to confirm creation.
                ghampusPendingEngram = { content: saveContent, engramHint };
                const suggestions = allEngrams.slice(0, 5).map((e) => `\`${e.graphId}\``).join(', ');
                await emitGhampusMsg(
                  `There's no engram named **"${engramHint}"** yet.\n\n` +
                  `Say **"create engram ${engramHint}"** to create it — I'll save your note there automatically.\n\n` +
                  (suggestions ? `Available engrams: ${suggestions}.` : ''),
                );
                return { ok: true };
              }
              matched = explicit;
            }

            if (!matched) {
              await emitGhampusMsg('No engrams to save to yet. Ask me to create one, or go to **Memory Studio → + New Engram**.');
              return { ok: true };
            }
            try {
              await ghampusTool('remember', {
                graphId: matched.graphId,
                text: saveContent,
                label: saveContent.slice(0, 80),
              });
              await emitGhampusMsg(`Saved to **${matched.displayName}**.`);
            } catch (e) {
              await emitGhampusMsg(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
            }
            return { ok: true };
          }

          if (intent.action === 'create_engram') {
            const { name: rawName } = intent as Extract<GhampusIntent, { action: 'create_engram' }>;
            const graphId = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            if (!graphId) {
              await emitGhampusMsg(`Couldn't turn "${rawName}" into a valid engram ID. Try a simpler name.`);
              return { ok: true };
            }
            const engListCheck = await ghampusTool('list_engrams', {}) as { engrams?: Array<{ graphId: string; displayName: string }> };
            const existing = engListCheck.engrams?.find((e) => e.graphId === graphId || e.displayName.toLowerCase() === rawName.toLowerCase());
            if (existing) {
              await emitGhampusMsg(`**${existing.displayName}** already exists. Want to save something to it?`);
              return { ok: true };
            }
            try {
              await deps.host.createGraph(graphId);
              // Auto-save the deferred note if the user was blocked on this engram.
              const pending = ghampusPendingEngram;
              const pendingSlug = pending?.engramHint.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
              if (pending && (pendingSlug === graphId || pending.engramHint.toLowerCase().includes(rawName.toLowerCase()) || rawName.toLowerCase().includes(pending.engramHint.toLowerCase()))) {
                ghampusPendingEngram = null;
                await ghampusTool('remember', { graphId, text: pending.content, label: pending.content.slice(0, 80) });
                await emitGhampusMsg(`Created engram **${rawName}** and saved your note: "${pending.content.slice(0, 120)}${pending.content.length > 120 ? '…' : ''}"`);
              } else {
                await emitGhampusMsg(`Created engram **${rawName}** (\`${graphId}\`). It's empty — want to save something to it?`);
              }
            } catch (e) {
              await emitGhampusMsg(`Couldn't create the engram: ${e instanceof Error ? e.message : String(e)}`);
            }
            return { ok: true };
          }

          if (intent.action === 'ui_only') {
            const { reason } = intent as Extract<GhampusIntent, { action: 'ui_only' }>;
            await emitGhampusMsg(
              `That requires the **Memory Studio** UI — I can't do it from here (${reason}). ` +
              'I can create engrams and save memories for you though.',
            );
            return { ok: true };
          }

          // intent.action === 'recall' — fall through to the full recall + LLM path below.

          // ── Phase 1: recall + base tools ─────────────────────────────────
          const [recallResult, engramsResult, skillsResult] = await Promise.allSettled([
            ghampusTool('recall', { query: text, maxNodes: recallMaxNodes, maxTokens: recallMaxTokens, ...skipEnrichmentRecallOpts }),
            ghampusTool('list_engrams', {}),
            wantsSkills || !wantsRecent
              ? ghampusTool('list_skills', {})
              : Promise.resolve(null),
          ]);

          // Extract recall node count to decide whether to escalate.
          const recallValue = recallResult.status === 'fulfilled' ? recallResult.value as Record<string, unknown> : null;
          const recallPromptRaw = (recallValue?.prompt as string | undefined) ?? '';
          // Count nodes by scanning for the node-line pattern [shortId|…]
          const recallNodeCount = (recallPromptRaw.match(/\[[\w]+\|/g) ?? []).length;

          const phase2: Array<Promise<unknown>> = [];
          const phase2Labels: string[] = [];

          // Escalation policy (per GRAPHNOSIS.md): recall < 3 nodes → dig_deeper.
          // Also force dig_deeper on exhaustive queries so we get cross-engram expansion.
          if (recallNodeCount < 3 || wantsExhaustive || wantsGrouped) {
            const digMaxNodes  = (wantsExhaustive || wantsGrouped) ? 50 : 30; // RecallInput schema caps at 50
            const digMaxTokens = (wantsExhaustive || wantsGrouped) ? 12000 : 3000;
            phase2.push(ghampusTool('dig_deeper', { query: text, maxNodes: digMaxNodes, maxTokens: digMaxTokens, ...skipEnrichmentRecallOpts }));
            phase2Labels.push('dig_deeper');
          }
          if (wantsExhaustive || wantsGrouped) {
            phase2.push(ghampusTool('recall_structured', { query: text, maxNodes: recallMaxNodes }));
            phase2Labels.push('recall_structured');
          }
          if (wantsStats) {
            phase2.push(ghampusTool('stats', {}));
            phase2Labels.push('stats');
          }
          if (wantsRecent) {
            phase2.push(ghampusTool('recent', { limit: 10 }));
            phase2Labels.push('recent');
          }
          if (wantsCitations && recallNodeCount > 0) {
            phase2.push(ghampusTool('recall_with_citations', { query: text, maxNodes: 10, maxTokens: 1500 }));
            phase2Labels.push('recall_with_citations');
          }
          if (wantsSource) {
            // Extract potential source keywords from the query.
            const srcKeyword = text.replace(/source|file|document|attachment|pdf|url|link|ref|show me|find|get/gi, '').trim().slice(0, 80);
            if (srcKeyword.length > 2) {
              phase2.push(ghampusTool('find_source', { content: srcKeyword }));
              phase2Labels.push('find_source');
            }
          }

          const phase2Results = phase2.length > 0
            ? await Promise.allSettled(phase2)
            : [];

          // ── Pre-process recall context ────────────────────────────────────
          // The raw recall prompt contains internal graph format:
          //   [n2|fact|0.79|src:skill:1781244988966:Task Todo Management] content…
          // The LLM must never see or repeat those IDs. Strip them down to
          // the readable content + a clean source attribution.
          // Attested vs inferred: overlays (.gll/.gnn) are NOT user memory —
          // keep them out of the primary context Ghampus treats as ground truth.
          const INFERRED_LAYER_MARKER = '--- INFERRED LAYER (overlays — NOT attested memory) ---';

          function splitAttestedInferred(raw: string): { attested: string; inferred: string } {
            const idx = raw.indexOf(INFERRED_LAYER_MARKER);
            if (idx < 0) return { attested: raw, inferred: '' };
            return {
              attested: raw.slice(0, idx).trim(),
              inferred: raw.slice(idx).trim(),
            };
          }

          function cleanRecallPrompt(raw: string): string {
            return cleanRecallPromptAttested(splitAttestedInferred(raw).attested);
          }

          function cleanRecallPromptAttested(attestedRaw: string): string {
            return stripRecallAuditTrail(
              attestedRaw
              // Node lines: [shortId|type|score|src:sourceRef] → "• content (from Source Name)"
              .replace(
                /\[[\w-]+\|[\w-]+\|[\d.]+\|src:([^\]]+)\]\s*/g,
                (_m: string, srcRef: string) => {
                  // Strip timestamps from skill refs: "skill:1781244988966:Task Todo Mgmt" → "Task Todo Mgmt"
                  const label = srcRef
                    .replace(/^skill:\d+:/, '')
                    .replace(/^[^:]+:[^:]+:/, '') // generic "kind:id:label" → "label"
                    .replace(/-/g, ' ')
                    .trim();
                  return label ? `[from ${label}] ` : '';
                },
              )
              // Edge lines: "n1 -[edgeType:weight]-> n2" → remove entirely
              .replace(/^[\w-]+ [~-]\[[\w:.-]+\][~>-]+ [\w-]+.*$/gm, '')
              // Residual pipe-separated node records: "n3|fact|0.76|src:..." anywhere in text
              .replace(/\b[a-z]\w*\|[\w:.|-]+/g, '')
              // Leftover short node IDs standing alone (n1, n2, etc.)
              .replace(/\bn\d+\b/g, '')
              // "src:" prefixes that sneak through in prose
              .replace(/src:[\w:/.-]+/g, '')
              // Collapse 3+ blank lines to 2
              .replace(/\n{3,}/g, '\n\n')
              .trim(),
            );
          }

          // ── Build context sections ────────────────────────────────────────
          const engrams = engramsResult.status === 'fulfilled'
            ? (engramsResult.value as { engrams: Array<{ graphId: string; displayName: string; tier: string; loaded: boolean }> }).engrams ?? []
            : [];
          const skillsValue = skillsResult.status === 'fulfilled' ? skillsResult.value : null;
          const skills = skillsValue
            ? (skillsValue as { skills: Array<{ label: string; trainedAt?: string }> }).skills ?? []
            : [];
          const recentSaves = listRecentSaves({ host: deps.host }, { limit: 5 }).saves;

          const sections: string[] = [];

          if (engrams.length > 0) {
            sections.push(
              '## Your engrams\n' +
              engrams.map((e) => `- ${e.displayName} (${e.tier}${e.loaded ? '' : ', not loaded'})`).join('\n'),
            );
          }
          if (skills.length > 0) {
            sections.push(
              '## Your skills\n' +
              skills.map((s) => {
                const label = s.label.replace(/^skill:\d+:/, '');
                return `- ${label}${s.trainedAt ? ` (trained ${new Date(s.trainedAt).toLocaleDateString()})` : ''}`;
              }).join('\n'),
            );
          }
          if (recentSaves.length > 0 && wantsRecent) {
            sections.push(
              '## Recently saved\n' +
              recentSaves.map((s) => `- ${s.label} (${s.engramId})`).join('\n'),
            );
          }

          // Primary recall — attested only (inferred overlay kept separate).
          const citationsResult = phase2Results[phase2Labels.indexOf('recall_with_citations')];
          const citationsText = citationsResult?.status === 'fulfilled'
            ? (citationsResult.value as { prompt?: string })?.prompt ?? '' : '';
          const primaryRecallRaw = citationsText || recallPromptRaw;
          const { attested: attestedRaw, inferred: inferredRaw } = splitAttestedInferred(primaryRecallRaw);
          const primaryRecall = cleanRecallPromptAttested(attestedRaw);
          const recallContextLimit = wantsExhaustive ? 8000 : 3000;
          if (primaryRecall) {
            sections.push('## What I found in your cortex (attested memory)\n' + primaryRecall.slice(0, recallContextLimit));
          }

          // dig_deeper — only add attested portion if it surfaced something beyond phase-1.
          const deeperIdx = phase2Labels.indexOf('dig_deeper');
          if (deeperIdx >= 0 && phase2Results[deeperIdx]?.status === 'fulfilled') {
            const deeperRawFull = (phase2Results[deeperIdx].value as { prompt?: string })?.prompt ?? '';
            const deeperAttested = cleanRecallPromptAttested(splitAttestedInferred(deeperRawFull).attested);
            if (deeperAttested && deeperAttested !== primaryRecall) {
              const deeperLimit = wantsExhaustive ? 6000 : 2000;
              sections.push('## Additional context (deeper search · attested)\n' + deeperAttested.slice(0, deeperLimit));
            }
          }

          // Inferred overlay — labelled so the LLM cannot treat predictions as facts.
          const inferredClean = inferredRaw
            ? cleanRecallPromptAttested(inferredRaw.replace(INFERRED_LAYER_MARKER, '').trim())
            : '';
          if (inferredClean) {
            sections.push(
              '## Predicted overlay (NOT attested — do not cite as user memory)\n' +
              inferredClean.slice(0, 1500),
            );
          }

          // recent sources.
          const recentIdx = phase2Labels.indexOf('recent');
          if (recentIdx >= 0 && phase2Results[recentIdx]?.status === 'fulfilled') {
            const recentData = phase2Results[recentIdx].value as { sources?: Array<{ label: string; engramId: string; ingestedAt: string }> };
            if (recentData?.sources?.length) {
              sections.push(
                '## Recently added to cortex\n' +
                recentData.sources.map((s) => `- "${s.label}" (in ${s.engramId}, added ${s.ingestedAt})`).join('\n'),
              );
            }
          }

          // stats — summarize key fields rather than dumping raw JSON.
          const statsIdx = phase2Labels.indexOf('stats');
          if (statsIdx >= 0 && phase2Results[statsIdx]?.status === 'fulfilled') {
            const sd = phase2Results[statsIdx].value as Record<string, unknown>;
            const lines: string[] = [];
            if (typeof sd.totalNodes === 'number') lines.push(`- Total memory nodes: ${sd.totalNodes}`);
            if (typeof sd.totalSources === 'number') lines.push(`- Total sources: ${sd.totalSources}`);
            if (typeof sd.vitality === 'number') lines.push(`- Cortex vitality: ${sd.vitality}/100`);
            if (lines.length) sections.push('## Cortex stats\n' + lines.join('\n'));
          }

          // find_source results.
          const srcIdx = phase2Labels.indexOf('find_source');
          if (srcIdx >= 0 && phase2Results[srcIdx]?.status === 'fulfilled') {
            const srcData = phase2Results[srcIdx].value as { sources?: Array<{ label: string; engramId: string }> };
            if (srcData?.sources?.length) {
              sections.push(
                '## Matching sources\n' +
                srcData.sources.slice(0, 8).map((s) => `- "${s.label}" (in ${s.engramId})`).join('\n'),
              );
            }
          }

          // Structured recall — cleaner node text for synthesis (and last-resort fallback).
          let structuredNodesForFallback: StructuredRecallNode[] = [];
          if (wantsExhaustive || wantsGrouped) {
            const structIdx = phase2Labels.indexOf('recall_structured');
            if (structIdx >= 0 && phase2Results[structIdx]?.status === 'fulfilled') {
              const structData = phase2Results[structIdx].value as {
                nodes?: StructuredRecallNode[];
                _notice?: string;
              };
              structuredNodesForFallback = filterStructuredRecallNodes(
                structData?.nodes ?? [],
                text,
              );
              if (structuredNodesForFallback.length > 0) {
                sections.push(
                  '## Recall hits (structured)\n' +
                  structuredNodesForFallback.map(formatNodeBullet).join('\n'),
                );
              }
            }
          }

          const contextBlock = sections.length > 0
            ? `\n\n<cortex_data>\n${sections.join('\n\n')}\n</cortex_data>`
            : '';

          // No attested context at all — refuse to invent an answer.
          const hasAttestedContext = !!primaryRecall
            || structuredNodesForFallback.length > 0
            || sections.some((s) =>
              s.startsWith('## Additional context (deeper search')
              || s.startsWith('## Recall hits (structured)'),
            );
          if (!hasAttestedContext && !wantsStats && !wantsRecent) {
            await emitGhampusMsg(
              'I couldn\'t find any **attested memories** matching that in your cortex. ' +
              'Nothing was saved with those terms — try rephrasing, or save the list first with `/save`.',
            );
            return { ok: true };
          }

          // ── System prompt with explicit output guardrails ─────────────────
          const system = `You are Ghampus — the AI built into Graphnosis, the user's personal knowledge graph. You're sharp, warm, and direct. You know their cortex deeply and you guide them through it like a knowledgeable friend, not a search engine.

Your job: help the user navigate, understand, and act on their memories, skills, and engrams — using ONLY what appears in <cortex_data> below.

GROUND TRUTH RULES — non-negotiable:
1. <cortex_data> is your ONLY source of facts. Never invent names, tasks, dates, team members, or counts not present in attested memory sections.
2. Sections labelled "attested memory" are authoritative. Sections labelled "Predicted overlay (NOT attested)" are second-class — prefix any use with "Predicted (not attested):" and never mix them with attested facts.
3. If attested memory is empty or irrelevant, say plainly: "No relevant memories found for this query." Do NOT fill gaps from world knowledge or guess plausible names.
4. Before listing items, scan attested memory for the user's keywords. Only list items whose text actually appears there — quote or paraphrase closely, never embellish.
5. Do NOT produce strategic plans, recommended next steps, or sample data when memory is thin — say what's missing instead.

TONE:
- Conversational and direct. Cut filler words. Get to the point fast.
- Use "you" and "your" freely — you know this person and their data.
- When you find something relevant, lead with it: "Here's what I found:" not "Based on the cortex data…"
- It's OK to ask a follow-up question if the answer would be much better with one more detail.

OUTPUT RULES — non-negotiable:
1. NEVER output node IDs, short IDs, pipe-separated records, or raw source refs. Specifically: never output n1, n2, n3, anything matching [n2|fact|…], src:skill:…, skill:1781…, clip:…, |fact|, |0.79|, or any text containing pipe characters (|) from the raw graph format. Translate everything to plain English.
2. Do NOT echo or paraphrase the user's question.
3. When listing items, use clean bullet points or numbered lists — never database-style records.
4. If attested data is truly empty, say so in one sentence and suggest what to save next.
5. Use **bold** for key terms and markdown lists for structure. Keep it readable.
6. Source attribution: natural and human-readable only — "(from your Milestones engram)" not "(src:abc123)".
7. You can reference skill names by their human label (e.g. "your Task Todo Management skill") — never by their raw ID.
8. NEVER cite query-enrichment metadata (lines like "Enriched:" or "enriched: ... → ..."), anchor logs, or GNN expansion notes — those are internal debug text, not user memory.${wantsExhaustive ? `
9. EXHAUSTIVE MODE: The user asked for ALL items. List every single attested item found in <cortex_data> — no summarizing, no "here are some examples". If there are 80 items, show all 80. Do not add items that are not in attested memory.` : ''}${wantsGrouped ? `
${wantsExhaustive ? '10' : '9'}. GROUPED LIST MODE: Organize attested items under markdown headings (### Name) grouped exactly as the user requested (team member, owner, assignee, etc.). A flat bullet dump is wrong. Only use names/categories that appear in attested memory — never invent people or assignments. Put items with no clear owner under **Unassigned**. Quote or paraphrase item text closely; do not embellish.` : ''}${contextBlock}`;

          // user is the bare message — no "User:" prefix to avoid echo
          const userMsg = text;

          // ── Call LLM, then sanitize + optionally retry ────────────────────
          // Patterns that indicate the LLM leaked internal format in its reply.
          const leakPatterns = [
            /\bn\d+\b/,            // node short IDs: n1, n2, n3
            /\|fact\|/,            // node type segment
            /\|\d+\.\d+\|/,        // score segment
            /src:[\w:/.-]{6,}/,    // raw source refs
            /skill:\d{10,}/,       // skill timestamp IDs
            /clip:[a-f0-9]{16,}/,  // clip source IDs
          ];

          function hasLeakedIDs(t: string): boolean {
            return leakPatterns.some((re) => re.test(t));
          }

          function sanitizeResponse(t: string): string {
            return t
              // Full bracketed node records: [n3|fact|0.76|src:...] content
              .replace(/\[[\w-]+\|[\w-]+\|[\d.]+\|[^\]]+\]\s*/g, '')
              // Bare pipe-separated node records: n3|fact|0.76|src:... (no brackets)
              .replace(/\b[a-z]\w*\|[\w:.|-]+/g, '')
              // Edge lines: n1 -[edgeType]-> n2
              .replace(/\b[\w-]+ [~-]\[[\w:.-]+\][~>-]+ [\w-]+\b/g, '')
              .replace(/\bsrc:[\w:/.-]+/g, '')
              .replace(/\bskill:\d+:[^\s,)]+/g, (m) => m.replace(/^skill:\d+:/, ''))
              .replace(/\bclip:[a-f0-9]+\b/g, '')
              .replace(/\bn\d+\b/g, '')
              .replace(/\|fact\|[\d.]+\|/g, '')
              // Recall audit metadata must never appear in user-facing answers
              .replace(/^[_]*enriched:\s*".*"\s*→\s*".*"[_]*\s*$/gim, '')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
          }

          async function callLlm(systemPrompt: string, userPrompt: string): Promise<string | null> {
            const { isBusyAbove, tryAcquireLlmSlot, WorkPriority } = await import('./work-priority.js');
            const { isGhampusBusy } = await import('./ghampus-busy.js');
            if (isBusyAbove(WorkPriority.P2_GHAMPUS) && !isGhampusBusy()) {
              console.warn('[ghampus:synthesize] skipped — higher-priority work active');
              return null;
            }
            const synthSlot = tryAcquireLlmSlot(WorkPriority.P2_GHAMPUS);
            if (!synthSlot) {
              console.warn('[ghampus:synthesize] skipped — LLM slot busy');
              return null;
            }
            try {
              if (synthSlot.signal.aborted) return null;
              let out = '';
              // llm is non-null here — guarded by the early-return above; TS can't
              // narrow across the async closure boundary so we assert.
              if (llm!.completeStream) {
                await llm!.completeStream({ system: systemPrompt, user: userPrompt, signal: synthSlot.signal }, (chunk) => { out += chunk; });
              } else {
                out = await llm!.complete({ system: systemPrompt, user: userPrompt, signal: synthSlot.signal });
              }
              return synthSlot.signal.aborted ? null : out;
            } catch (err) {
              if (err instanceof DOMException && err.name === 'AbortError') return null;
              throw err;
            } finally {
              synthSlot.release();
            }
          }

          async function emitRawRecallFallback(reason: string): Promise<void> {
            if (structuredNodesForFallback.length > 0) {
              const body = wantsGrouped
                ? formatGroupedRecallList(structuredNodesForFallback, text)
                : formatStructuredRecallList(structuredNodesForFallback);
              await emitGhampusMsg(`${reason}\n\n${body}`);
              return;
            }
            if (primaryRecall) {
              await emitGhampusMsg(
                `${reason}\n\nHere's what I found in your cortex:\n\n${primaryRecall.slice(0, recallContextLimit)}`,
              );
              return;
            }
            await emitGhampusMsg(
              "I couldn't synthesize an answer and didn't find attested memories to show. Try rephrasing, or save the list first with `/save`.",
            );
          }

          let responseText = await callLlm(system, userMsg);

          if (!responseText?.trim()) {
            await emitRawRecallFallback(
              "I couldn't synthesize a structured answer right now — the local LLM was busy or unavailable.",
            );
            return { ok: true };
          }

          // Retry once if the response contains leaked internal IDs.
          if (hasLeakedIDs(responseText)) {
            const retrySystem = system +
              '\n\nIMPORTANT: Your previous response contained raw database IDs like "n2", "|fact|", "src:skill:…". ' +
              'Rewrite your answer in plain English only. No IDs, no pipe characters, no source references.';
            const retryText = await callLlm(retrySystem, userMsg);
            if (retryText?.trim()) responseText = retryText;
          }

          // Grouped-list queries must use section headings — retry once if flat dump.
          if (wantsGrouped && responseText.trim() && !looksGroupedResponse(responseText)) {
            const retrySystem = system +
              '\n\nIMPORTANT: Your previous answer was a flat bullet list. ' +
              'Reformat with markdown headings (### Name) grouping items by the dimension the user asked for. ' +
              'Do not invent assignees — use **Unassigned** when owner is unclear.';
            const retryText = await callLlm(retrySystem, userMsg);
            if (retryText?.trim()) responseText = retryText;
          }

          // Final sanitization pass — scrub anything that still slipped through.
          responseText = sanitizeResponse(responseText);

          if (!responseText.trim()) {
            await emitRawRecallFallback(
              "I couldn't produce a clean synthesized answer — here's the raw recall instead.",
            );
            return { ok: true };
          }

          await emitGhampusMsg(responseText);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const errMsg = { kind: 'ghampus', text: `Error: ${msg}`, ts: Date.now() };
          if (histPath) {
            const { appendFile } = await import('node:fs/promises');
            await appendFile(histPath, JSON.stringify(errMsg) + '\n').catch(() => {});
          }
          deps.broadcastRaw({
            kind: 'ghampus.message',
            name: 'ghampus.message',
            payload: errMsg,
          });
        } finally {
          decrementGhampusBusy();
        }
      })();
      return { ok: true };
    }
    case 'ghampus:walkPlan': {
      const args = z.object({
        sourceId: z.string(),
        graphId: z.string().optional(),
      }).parse(params ?? {});
      let graphId = args.graphId;
      if (!graphId) {
        for (const gid of skillEngramIds(deps.host)) {
          try {
            if (deps.host.getSourceRecord(gid, args.sourceId)) {
              graphId = gid;
              break;
            }
          } catch { /* engram not loaded */ }
        }
      }
      if (!graphId) {
        return {
          sourceId: args.sourceId,
          label: args.sourceId,
          steps: [],
          totalCost: 0,
          privacySafe: true,
          routing: 'local-only',
          cloudRoutingReady: false,
        };
      }
      const { walkSkillSequence, walkSkillToJson } = await import('./skill-trainer.js');
      const { planSkillWalk, deriveStepsFromText } = await import('./model-router.js');
      const { KNOWN_PROVIDERS } = await import('./model-registry.js');
      const walked = walkSkillSequence(deps.host, graphId, args.sourceId, { recursive: false });
      const meta = deps.host.getGraphMetadata(graphId);
      const src = deps.host.getSourceRecord(graphId, args.sourceId);
      const title = walked.steps[0]?.text ?? src?.ref ?? args.sourceId;
      const label = title.replace(/^#+\s*/, '').slice(0, 80);
      if (walked.steps.length === 0) {
        return {
          sourceId: args.sourceId,
          label,
          steps: [],
          totalCost: 0,
          privacySafe: true,
          routing: 'local-only',
          cloudRoutingReady: false,
          graphId,
        };
      }
      const settings = deps.host.getSettings();
      const providerStates = settings.models?.providers ?? {};
      const enabledProviders = Object.entries(providerStates)
        .filter(([id, s]) => s?.enabled === true && !isProviderDisabled(id))
        .map(([id]) => id as Parameters<typeof planSkillWalk>[1]['enabledProviders'][number]);
      if (enabledProviders.length === 0) enabledProviders.push('ollama');
      const cloudRoutingReady = KNOWN_PROVIDERS.some((p) => {
        if (p.local || isProviderDisabled(p.id)) return false;
        const ps = providerStates[p.id];
        return ps?.enabled === true && ps?.hasKey === true;
      }) && (settings.models?.strategy ?? 'adaptive') !== 'local-only';
      const subscriptionPoolUsage: Record<string, { poolSpentUsd: number; flexSpentUsd: number }> = {};
      for (const [pid, ps] of Object.entries(providerStates)) {
        if (ps?.poolSpentUsd !== undefined || ps?.flexSpentUsd !== undefined) {
          subscriptionPoolUsage[pid] = { poolSpentUsd: ps.poolSpentUsd ?? 0, flexSpentUsd: ps.flexSpentUsd ?? 0 };
        }
      }
      const skillPlan = walkSkillToJson(walked, {
        sourceId: args.sourceId,
        title,
        ...(meta?.displayName ? { engramName: meta.displayName } : {}),
      });
      const rawSteps = skillPlan.steps.map((s) => ({ index: s.index, text: s.text }));
      const planSteps = deriveStepsFromText(rawSteps);
      const strategy = settings.models?.strategy ?? 'adaptive';
      const plan = planSkillWalk(planSteps, {
        strategy,
        enabledProviders,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        subscriptionPoolUsage: subscriptionPoolUsage as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        customRates: (settings.models?.customRates as any) ?? [],
      });
      const steps = plan.steps.map((s) => ({
        label: s.label,
        needs: s.capabilities,
        model: s.pickedModelDisplay ?? s.unsatisfiedReason ?? 'Not configured',
        isLocal: !s.pickedProvider || s.pickedProvider === 'ollama',
        cost: s.cost?.usd ?? 0,
      }));
      return {
        sourceId: args.sourceId,
        label,
        steps,
        totalCost: plan.totalUsd,
        privacySafe: !plan.steps.some((s) => s.privacyLocked),
        routing: strategy,
        cloudRoutingReady,
        graphId,
        learningHint: plan.feasible ? undefined : plan.missingCapabilities.join(', '),
      };
    }
    case 'ghampus:confirmWalk': {
      const args = z.object({
        sourceId: z.string(),
        routing: z.enum(['adaptive', 'local-only']),
        graphId: z.string().optional(),
      }).parse(params ?? {});
      let graphId = args.graphId;
      if (!graphId) {
        for (const gid of skillEngramIds(deps.host)) {
          try {
            if (deps.host.getSourceRecord(gid, args.sourceId)) {
              graphId = gid;
              break;
            }
          } catch { /* not loaded */ }
        }
      }
      if (!graphId) return { ok: false, reason: 'skill-not-found' };

      const settings = deps.host.getSettings();
      const priorStrategy = settings.models?.strategy ?? 'adaptive';
      if (args.routing === 'local-only' && priorStrategy !== 'local-only') {
        await deps.host.setSettings({
          ...settings,
          models: { ...(settings.models ?? { providers: {} }), strategy: 'local-only' },
        });
      }
      const { incrementGhampusBusy, decrementGhampusBusy } = await import('./ghampus-busy.js');
      incrementGhampusBusy();
      try {
        return await dispatch(deps, 'agent:walkSkill', {
          sourceId: args.sourceId,
          graphId,
        });
      } finally {
        decrementGhampusBusy();
        if (args.routing === 'local-only' && priorStrategy !== 'local-only') {
          const cur = deps.host.getSettings();
          await deps.host.setSettings({
            ...cur,
            models: { ...(cur.models ?? { providers: {} }), strategy: priorStrategy },
          });
        }
      }
    }
    case 'ghampus:refineResponse': {
      z.object({ sourceId: z.string(), action: z.enum(['update', 'edit', 'skip']) }).parse(params ?? {});
      return { ok: true };
    }

    // ── Models registry + routing ───────────────────────────────────────
    case 'models:catalog': {
      // Returns the static catalog (providers + known models) plus the
      // user's current per-provider state. Drives the Settings → Models
      // page entirely. No gate — visible on every plan.
      const { KNOWN_PROVIDERS, KNOWN_MODELS, KNOWN_MODELS_VERSION } = await import('./model-registry.js');
      const {
        pingOpenAiCompatible,
        resolveLocalOpenAiBaseUrl,
      } = await import('./cloud-llm.js');
      const settings = deps.host.getSettings();
      const providerStates = settings.models?.providers ?? {};
      const ollamaUrl = 'http://127.0.0.1:11434';
      let ollamaReachable = false;
      try {
        const res = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
        ollamaReachable = res.ok;
      } catch { /* not running */ }
      const providers = await Promise.all(KNOWN_PROVIDERS.map(async (p) => {
        const ps = providerStates[p.id];
        let reachable: boolean | undefined;
        if (p.id === 'ollama') reachable = ollamaReachable;
        else if (p.id === 'mlx' || p.id === 'vllm') {
          const baseUrl = resolveLocalOpenAiBaseUrl(deps.host, p.id);
          reachable = baseUrl ? await pingOpenAiCompatible(baseUrl) : false;
        }
        return {
          ...p,
          enabled: ps?.enabled === true && !isProviderDisabled(p.id),
          hasKey: ps?.hasKey === true,
          keyTail: ps?.keyTail,
          adminLocked: isProviderDisabled(p.id) || ps?.adminLocked === true,
          poolSpentUsd: ps?.poolSpentUsd ?? 0,
          flexSpentUsd: ps?.flexSpentUsd ?? 0,
          needsKey: !p.local,
          ...(typeof ps?.baseUrl === 'string' && ps.baseUrl.trim() ? { baseUrl: ps.baseUrl.trim() } : {}),
          ...(reachable !== undefined ? { reachable } : {}),
        };
      }));
      return {
        catalogVersion: KNOWN_MODELS_VERSION,
        cloudRoutingReady: KNOWN_PROVIDERS.some((p) => {
          if (p.local || isProviderDisabled(p.id)) return false;
          const ps = providerStates[p.id];
          return ps?.enabled === true && ps?.hasKey === true;
        }) && (settings.models?.strategy ?? 'adaptive') !== 'local-only',
        providers,
        models: KNOWN_MODELS,
        strategy: settings.models?.strategy ?? 'adaptive',
        monthlyBudgetUsd: settings.models?.monthlyBudgetUsd ?? null,
        spentThisCycleUsd: settings.models?.spentThisCycleUsd ?? 0,
        customRates: settings.models?.customRates ?? [],
        savingsBaseline: (await import('./savings-tracker.js')).resolveSavingsBaseline(settings),
      };
    }
    case 'models:setStrategy': {
      const { strategy } = z.object({
        strategy: z.enum(['adaptive', 'local-only', 'always-best']),
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      await deps.host.setSettings({
        ...current,
        models: { ...(current.models ?? { providers: {}, strategy: 'adaptive' }), strategy },
      });
      return { ok: true };
    }
    case 'models:setProviderKey': {
      const { providerId, apiKey } = z.object({
        providerId: z.string().min(1),
        apiKey: z.string().min(1),
      }).parse(params ?? {});
      const { getKnownProvider } = await import('./model-registry.js');
      const providerInfo = getKnownProvider(providerId as import('./model-registry.js').ModelProviderId);
      if (!providerInfo) return { ok: false, reason: 'unknown-provider' };
      if (providerInfo.local) return { ok: false, reason: 'local-provider', message: 'Local providers do not use API keys.' };
      const current = deps.host.getSettings();
      const models = current.models ?? { providers: {}, strategy: 'adaptive' as const };
      const providerState = models.providers[providerId] ?? { enabled: false };
      if (providerState.adminLocked) {
        return { ok: false, reason: 'admin-locked', message: 'This provider is locked by your organization admin.' };
      }
      const trimmed = apiKey.trim();
      await deps.host.setSettings({
        ...current,
        models: {
          ...models,
          providers: {
            ...models.providers,
            [providerId]: {
              ...providerState,
              enabled: true,
              apiKey: trimmed,
              hasKey: true,
              keyTail: trimmed.length >= 4 ? trimmed.slice(-4) : trimmed,
            },
          },
        },
      });
      return { ok: true };
    }
    case 'models:clearProviderKey': {
      const { providerId } = z.object({ providerId: z.string().min(1) }).parse(params ?? {});
      const current = deps.host.getSettings();
      const models = current.models ?? { providers: {}, strategy: 'adaptive' as const };
      const providerState = models.providers[providerId];
      if (!providerState) return { ok: true };
      if (providerState.adminLocked) {
        return { ok: false, reason: 'admin-locked', message: 'This provider is locked by your organization admin.' };
      }
      const { apiKey: _k, apiKeyEnc: _e, keyTail: _t, hasKey: _h, ...rest } = providerState;
      await deps.host.setSettings({
        ...current,
        models: {
          ...models,
          providers: {
            ...models.providers,
            [providerId]: { ...rest, enabled: false, hasKey: false },
          },
        },
      });
      return { ok: true };
    }
    case 'models:setProviderEnabled': {
      const { providerId, enabled } = z.object({
        providerId: z.string().min(1),
        enabled: z.boolean(),
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      const models = current.models ?? { providers: {}, strategy: 'adaptive' as const };
      const providerState = models.providers[providerId] ?? { enabled: false };
      // Admin-locked providers cannot be toggled by users.
      if (providerState.adminLocked) {
        return { ok: false, reason: 'admin-locked', message: 'This provider is locked by your organization admin.' };
      }
      await deps.host.setSettings({
        ...current,
        models: {
          ...models,
          providers: { ...models.providers, [providerId]: { ...providerState, enabled } },
        },
      });
      return { ok: true };
    }
    case 'models:setBudget': {
      const { monthlyBudgetUsd } = z.object({
        // null / 0 / undefined all mean "no cap" — caller can clear the budget by sending null.
        monthlyBudgetUsd: z.number().nullable().optional(),
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      const models = current.models ?? { providers: {}, strategy: 'adaptive' as const };
      const next = { ...models };
      if (monthlyBudgetUsd && monthlyBudgetUsd > 0) {
        next.monthlyBudgetUsd = monthlyBudgetUsd;
      } else {
        delete next.monthlyBudgetUsd;
      }
      await deps.host.setSettings({ ...current, models: next });
      return { ok: true };
    }
    case 'models:setSavingsBaseline': {
      const { savingsBaseline } = z.object({
        savingsBaseline: z.object({
          modelDisplayName: z.string().min(1),
          inputUsdPer1M: z.number().nonnegative(),
          outputUsdPer1M: z.number().nonnegative(),
        }),
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      const models = current.models ?? { providers: {}, strategy: 'adaptive' as const };
      await deps.host.setSettings({
        ...current,
        models: { ...models, savingsBaseline },
      });
      return { ok: true };
    }
    case 'models:setCustomRate': {
      // Add or update an override. Admin-enforced overrides cannot be
      // changed by users — only the admin policy fetcher writes those.
      const args = z.object({
        modelId: z.string().optional(),
        providerId: z.string().optional(),
        pricing: z.unknown(),
        note: z.string().optional(),
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      const models = current.models ?? { providers: {}, strategy: 'adaptive' as const };
      const existing = models.customRates ?? [];
      const idx = existing.findIndex((o) =>
        (args.modelId && o.modelId === args.modelId) ||
        (!args.modelId && args.providerId && o.providerId === args.providerId && !o.modelId)
      );
      if (idx >= 0 && existing[idx]?.adminEnforced) {
        return { ok: false, reason: 'admin-locked', message: 'This rate is enforced by your organization admin.' };
      }
      const entry = {
        ...(args.modelId !== undefined ? { modelId: args.modelId } : {}),
        ...(args.providerId !== undefined ? { providerId: args.providerId } : {}),
        pricing: args.pricing,
        ...(args.note !== undefined ? { note: args.note } : {}),
      };
      const nextRates = idx >= 0 ? [...existing.slice(0, idx), entry, ...existing.slice(idx + 1)] : [...existing, entry];
      await deps.host.setSettings({ ...current, models: { ...models, customRates: nextRates } });
      return { ok: true };
    }
    case 'agent:planSkillWalk': {
      // Compute the routing + cost plan for a skill walk. Pure read —
      // no walk happens here, the user approves the plan and the walk
      // ships once the LLM turn loop lands. Reads strategy + provider
      // state + custom rates + pool state from settings.
      const { planSkillWalk, deriveStepsFromText } = await import('./model-router.js');
      const args = z.object({
        sourceId: z.string().optional(),
        steps: z.array(z.object({
          index: z.number().int(),
          text: z.string(),
        })).optional(),
        engramTierByStep: z.record(z.string(), z.enum(['public', 'personal', 'sensitive'])).optional(),
      }).parse(params ?? {});

      // Two input modes: caller passes pre-formed steps, OR a sourceId
      // (+ graphId) we resolve into a SkillExecutionPlan via the
      // skill-trainer walker. The mocked-up cost preview path uses the
      // first; real skill walks use the second.
      let rawSteps: Array<{ index: number; text: string }>;
      const sourceArgs = z.object({ graphId: z.string().optional() }).safeParse(params ?? {});
      if (args.steps && args.steps.length > 0) {
        rawSteps = args.steps;
      } else if (args.sourceId && sourceArgs.success && sourceArgs.data.graphId) {
        const { walkSkillSequence, walkSkillToJson } = await import('./skill-trainer.js');
        const walked = walkSkillSequence(deps.host, sourceArgs.data.graphId, args.sourceId, { recursive: false });
        if (walked.steps.length === 0) return { ok: false, reason: 'empty-skill' };
        const meta = deps.host.getGraphMetadata(sourceArgs.data.graphId);
        const src = deps.host.getSourceRecord(sourceArgs.data.graphId, args.sourceId);
        const title = walked.steps[0]?.text ?? src?.ref ?? args.sourceId;
        const plan = walkSkillToJson(walked, {
          sourceId: args.sourceId,
          title,
          ...(meta?.displayName ? { engramName: meta.displayName } : {}),
        });
        rawSteps = plan.steps.map((s) => ({ index: s.index, text: s.text }));
      } else {
        return { ok: false, reason: 'no-input' };
      }

      const settings = deps.host.getSettings();
      const enabledProviders = Object.entries(settings.models?.providers ?? { ollama: { enabled: true } })
        .filter(([id, s]) => s?.enabled === true && !isProviderDisabled(id))
        .map(([id]) => id as Parameters<typeof planSkillWalk>[1]['enabledProviders'][number]);

      const subscriptionPoolUsage: Record<string, { poolSpentUsd: number; flexSpentUsd: number }> = {};
      for (const [pid, ps] of Object.entries(settings.models?.providers ?? {})) {
        if (ps?.poolSpentUsd !== undefined || ps?.flexSpentUsd !== undefined) {
          subscriptionPoolUsage[pid] = {
            poolSpentUsd: ps.poolSpentUsd ?? 0,
            flexSpentUsd: ps.flexSpentUsd ?? 0,
          };
        }
      }

      // The engramTierByStep input lets the caller mark which steps
      // touch which engrams so the planner can apply privacy locks.
      const tierMap: Record<number, 'public' | 'personal' | 'sensitive'> = {};
      for (const [k, v] of Object.entries(args.engramTierByStep ?? {})) {
        const n = Number(k);
        if (Number.isFinite(n)) tierMap[n] = v;
      }

      const planSteps = deriveStepsFromText(rawSteps, tierMap);
      const plan = planSkillWalk(planSteps, {
        strategy: settings.models?.strategy ?? 'adaptive',
        enabledProviders,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        subscriptionPoolUsage: subscriptionPoolUsage as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        customRates: (settings.models?.customRates as any) ?? [],
      });
      return { ok: true, plan };
    }
    case 'savings:summary': {
      // Aggregate the savings log into the Ghampus / Settings dashboard
      // numbers. Defaults to a 30-day window so the panel speaks in
      // monthly terms.
      const { summariseSavings, resolveSavingsBaseline } = await import('./savings-tracker.js');
      const args = z.object({ windowDays: z.number().int().positive().max(365).optional() }).parse(params ?? {});
      const baseline = resolveSavingsBaseline(deps.host.getSettings());
      return summariseSavings(deps.host.getCortexDir(), args.windowDays ?? 30, baseline);
    }
    case 'agent:walkSkill': {
      // Execute a planned skill walk step-by-step against the chosen
      // models. Ollama + configured BYOK cloud providers dispatch for real;
      // unconfigured paid providers report a clear error per step. Each step writes a
      // routing-savings entry as it lands; the walk's final result
      // carries the per-step outputs + captures for the UI to render.
      const { walkSkillPlan } = await import('./agent-walker.js');
      const { planSkillWalk, deriveStepsFromText } = await import('./model-router.js');
      const args = z.object({
        sourceId: z.string().min(1),
        graphId: z.string().min(1),
        initialCaptures: z.record(z.string(), z.string()).optional(),
        runId: z.string().min(1).optional(),
      }).parse(params ?? {});

      // Re-derive the steps + plan inline so callers don't have to ship
      // both. Mirrors the agent:planSkillWalk path.
      const { walkSkillSequence, walkSkillToJson } = await import('./skill-trainer.js');
      const walked = walkSkillSequence(deps.host, args.graphId, args.sourceId, { recursive: false });
      if (walked.steps.length === 0) return { ok: false, reason: 'empty-skill' };
      const meta = deps.host.getGraphMetadata(args.graphId);
      const src = deps.host.getSourceRecord(args.graphId, args.sourceId);
      const title = walked.steps[0]?.text ?? src?.ref ?? args.sourceId;
      const skillPlan = walkSkillToJson(walked, {
        sourceId: args.sourceId,
        title,
        ...(meta?.displayName ? { engramName: meta.displayName } : {}),
      });
      const rawSteps = skillPlan.steps.map((s) => ({ index: s.index, text: s.text }));

      const settings = deps.host.getSettings();
      const enabledProviders = Object.entries(settings.models?.providers ?? { ollama: { enabled: true } })
        .filter(([id, s]) => s?.enabled === true && !isProviderDisabled(id))
        .map(([id]) => id as Parameters<typeof planSkillWalk>[1]['enabledProviders'][number]);
      const subscriptionPoolUsage: Record<string, { poolSpentUsd: number; flexSpentUsd: number }> = {};
      for (const [pid, ps] of Object.entries(settings.models?.providers ?? {})) {
        if (ps?.poolSpentUsd !== undefined || ps?.flexSpentUsd !== undefined) {
          subscriptionPoolUsage[pid] = { poolSpentUsd: ps.poolSpentUsd ?? 0, flexSpentUsd: ps.flexSpentUsd ?? 0 };
        }
      }
      const planSteps = deriveStepsFromText(rawSteps);
      const plan = planSkillWalk(planSteps, {
        strategy: settings.models?.strategy ?? 'adaptive',
        enabledProviders,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        subscriptionPoolUsage: subscriptionPoolUsage as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        customRates: (settings.models?.customRates as any) ?? [],
      });
      if (!plan.feasible) {
        return { ok: false, reason: 'plan-infeasible', missingCapabilities: plan.missingCapabilities };
      }

      const result = await walkSkillPlan({ host: deps.host }, {
        sourceId: args.sourceId,
        graphId: args.graphId,
        steps: rawSteps,
        plan,
        executionSteps: skillPlan.steps,
        failureHandlers: skillPlan.failureHandlers,
        ...(args.initialCaptures ? { initialCaptures: args.initialCaptures } : {}),
      });

      if (args.runId) {
        const { resolveSkillRunActor } = await import('./skill-runs.js');
        const existing = await deps.host.skillRuns.read(args.runId);
        if (existing) {
          const actor = resolveSkillRunActor({
            ...(deps.ssoSession ? { ssoSession: deps.ssoSession } : {}),
            host: deps.host,
          });
          const lastCompleted = result.steps.reduce(
            (max, s) => (!s.error && s.index > max ? s.index : max),
            existing.completedStepIndex,
          );
          const stepLog = [...(existing.stepLog ?? [])];
          for (const s of result.steps) {
            stepLog.push({
              stepIndex: s.index,
              actor: actor.actorLabel,
              tool: 'agent:walkSkill',
              outcome: s.error ? 'error' : 'ok',
              ts: Date.now(),
            });
          }
          const status = result.ok ? 'complete' : (result.steps.some((s) => s.error) ? 'failed' : 'running');
          await deps.host.skillRuns.save({
            ...existing,
            completedStepIndex: lastCompleted,
            status,
            capturedVars: { ...existing.capturedVars, ...result.captures },
            stepLog,
            updatedAt: Date.now(),
          });
        }
      }

      return { ok: true, plan, result };
    }
    case 'savings:recordRecallOnly': {
      // Called by the MCP recall handler when a recall succeeded and
      // returned context to the AI client. The counterfactual is "the
      // AI would have spent these tokens at baseline rates"; we record
      // the saving so the dashboard reflects it.
      const { recordRecallOnlySavings, resolveSavingsBaseline } = await import('./savings-tracker.js');
      const args = z.object({
        inputTokensSaved: z.number().int().nonnegative(),
        outputTokensSaved: z.number().int().nonnegative().optional(),
        source: z.string().optional(),
      }).parse(params ?? {});
      const baseline = resolveSavingsBaseline(deps.host.getSettings());
      await recordRecallOnlySavings(deps.host.getCortexDir(), {
        inputTokensSaved: args.inputTokensSaved,
        outputTokensSaved: args.outputTokensSaved ?? 0,
        ...(args.source !== undefined ? { source: args.source } : {}),
      }, baseline);
      return { ok: true };
    }

    // ── File attachments — references to local files associated with
    //    notes / memories. The files stay where they are; we store only
    //    the path + metadata.
    case 'attachments:attach': {
      const { addAttachment } = await import('./attachments-store.js');
      const args = z.object({
        path: z.string().min(1),
        graphId: z.string().min(1),
        kind: z.enum(['image', 'pdf', 'doc', 'spreadsheet', 'video', 'audio', 'archive', 'code', 'onenote', 'other']).optional(),
        label: z.string().optional(),
        note: z.string().optional(),
        sourceId: z.string().optional(),
        nodeIds: z.array(z.string()).optional(),
      }).parse(params ?? {});
      const rec = await addAttachment(deps.host.getCortexDir(), {
        path: args.path,
        graphId: args.graphId,
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.label !== undefined ? { label: args.label } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.sourceId !== undefined ? { sourceId: args.sourceId } : {}),
        ...(args.nodeIds !== undefined ? { nodeIds: args.nodeIds } : {}),
      });
      return { ok: true, attachment: rec };
    }
    case 'attachments:list': {
      const { listAttachments } = await import('./attachments-store.js');
      const args = z.object({
        graphId: z.string().optional(),
        sourceId: z.string().optional(),
        nodeIds: z.array(z.string()).optional(),
      }).parse(params ?? {});
      const filter: { graphId?: string; sourceId?: string; nodeIds?: string[] } = {};
      if (args.graphId !== undefined) filter.graphId = args.graphId;
      if (args.sourceId !== undefined) filter.sourceId = args.sourceId;
      if (args.nodeIds !== undefined) filter.nodeIds = args.nodeIds;
      const attachments = await listAttachments(deps.host.getCortexDir(), filter);
      return { attachments };
    }
    case 'attachments:update': {
      const { updateAttachment } = await import('./attachments-store.js');
      const args = z.object({
        id: z.string().min(1),
        label: z.string().optional(),
        note: z.string().optional(),
        nodeIds: z.array(z.string()).optional(),
        sourceId: z.string().optional(),
        kind: z.enum(['image', 'pdf', 'doc', 'spreadsheet', 'video', 'audio', 'archive', 'code', 'onenote', 'other']).optional(),
      }).parse(params ?? {});
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { id, ...patchRaw } = args;
      const patch: Parameters<typeof updateAttachment>[2] = {};
      if (patchRaw.label !== undefined) patch.label = patchRaw.label;
      if (patchRaw.note !== undefined) patch.note = patchRaw.note;
      if (patchRaw.nodeIds !== undefined) patch.nodeIds = patchRaw.nodeIds;
      if (patchRaw.sourceId !== undefined) patch.sourceId = patchRaw.sourceId;
      if (patchRaw.kind !== undefined) patch.kind = patchRaw.kind;
      const updated = await updateAttachment(deps.host.getCortexDir(), id, patch);
      return updated ? { ok: true, attachment: updated } : { ok: false, reason: 'not_found' };
    }
    case 'attachments:verify': {
      const { verifyAttachment } = await import('./attachments-store.js');
      const args = z.object({ id: z.string().min(1) }).parse(params ?? {});
      const v = await verifyAttachment(deps.host.getCortexDir(), args.id);
      return v ? { ok: true, attachment: v } : { ok: false, reason: 'not_found' };
    }
    case 'attachments:detach': {
      const { removeAttachment } = await import('./attachments-store.js');
      const args = z.object({ id: z.string().min(1) }).parse(params ?? {});
      const ok = await removeAttachment(deps.host.getCortexDir(), args.id);
      return ok ? { ok: true } : { ok: false, reason: 'not_found' };
    }
    case 'attachments:describeImage': {
      // (A) Free-form vision description of an attached image. Uses the
      // local vision model (llama3.2-vision by default). When
      // `ingestAsSource: true`, the description is piped into the
      // existing host.ingest() pipeline as a Markdown source, with the
      // image's file path cited at the top — recall results then
      // surface the image alongside the textual description.
      const { describeAttachmentImage, describeResultToMarkdown } = await import('./vision-pipeline.js');
      const args = z.object({
        attachmentId: z.string().min(1),
        modelTag: z.string().optional(),
        promptHint: z.string().optional(),
        ingestAsSource: z.boolean().optional(),
      }).parse(params ?? {});
      const result = await describeAttachmentImage({ host: deps.host }, {
        attachmentId: args.attachmentId,
        ...(args.modelTag !== undefined ? { modelTag: args.modelTag } : {}),
        ...(args.promptHint !== undefined ? { promptHint: args.promptHint } : {}),
      });
      if (result.ok && args.ingestAsSource) {
        const { listAttachments } = await import('./attachments-store.js');
        const all = await listAttachments(deps.host.getCortexDir(), {});
        const att = all.find((a) => a.id === args.attachmentId);
        if (att) {
          const ref = `vision:${att.id}-${Date.now().toString(36)}`;
          await deps.host.ingest(
            att.graphId,
            'ai-conversation',
            ref,
            {
              kind: 'markdown',
              content: describeResultToMarkdown(att.path, result),
              sourceRef: ref,
            },
            { addedBy: 'ghampus-vision' },
          ).catch(() => { /* non-fatal — describe still returns */ });
        }
      }
      return result;
    }
    case 'attachments:extractStructure': {
      // (B) Structured `{nodes, edges}` extraction from a diagram /
      // flowchart / whiteboard image. Pro-gated: uses more tokens than
      // describe and produces graph mutations the user must approve.
      // The handler returns the parsed structure; committing it to the
      // engram is the correction-flow integration's job (deferred to
      // the UI surface that wraps the propose-then-approve loop).
      if (!(await hasAnyPaidPlan(deps))) {
        return {
          ok: false,
          reason: 'not_licensed',
          message: 'Structured visual extraction is a Pro feature. Free users can still describe images via attachments:describeImage.',
        };
      }
      const { extractStructureFromImage } = await import('./vision-pipeline.js');
      const args = z.object({
        attachmentId: z.string().min(1),
        modelTag: z.string().optional(),
      }).parse(params ?? {});
      return await extractStructureFromImage({ host: deps.host }, {
        attachmentId: args.attachmentId,
        ...(args.modelTag !== undefined ? { modelTag: args.modelTag } : {}),
      });
    }
    case 'attachments:commitExtraction': {
      // The user approved an extracted `{nodes, edges}` payload — write
      // it to the engram as a structured source. Each extracted node
      // becomes a chunk in the source body; edges live as Markdown
      // arrows between nodes so the entity-linker auto-wires them to
      // existing memories about the same labels.
      if (!(await hasAnyPaidPlan(deps))) {
        return { ok: false, reason: 'not_licensed' };
      }
      const args = z.object({
        attachmentId: z.string().min(1),
        nodes: z.array(z.object({
          id: z.string(),
          label: z.string(),
          category: z.string().optional(),
          note: z.string().optional(),
        })),
        edges: z.array(z.object({
          from: z.string(),
          to: z.string(),
          label: z.string().optional(),
          directed: z.boolean().optional(),
        })),
      }).parse(params ?? {});
      const { listAttachments } = await import('./attachments-store.js');
      const all = await listAttachments(deps.host.getCortexDir(), {});
      const att = all.find((a) => a.id === args.attachmentId);
      if (!att) return { ok: false, reason: 'attachment_not_found' };
      const lines: string[] = [];
      lines.push(`> Structured extraction from \`${att.label}\` (${att.path})`);
      lines.push('');
      lines.push('## Entities');
      for (const n of args.nodes) {
        const cat = n.category ? ` _(${n.category})_` : '';
        const note = n.note ? ` — ${n.note}` : '';
        lines.push(`- **${n.label}**${cat}${note}`);
      }
      if (args.edges.length > 0) {
        lines.push('');
        lines.push('## Relationships');
        const byId = new Map(args.nodes.map((n) => [n.id, n.label]));
        for (const e of args.edges) {
          const from = byId.get(e.from) ?? e.from;
          const to = byId.get(e.to) ?? e.to;
          const arrow = e.directed === false ? '↔' : '→';
          const label = e.label ? ` (${e.label})` : '';
          lines.push(`- ${from} ${arrow} ${to}${label}`);
        }
      }
      const ref = `vision-extract:${att.id}-${Date.now().toString(36)}`;
      const result = await deps.host.ingest(
        att.graphId,
        'ai-conversation',
        ref,
        { kind: 'markdown', content: lines.join('\n'), sourceRef: ref },
        { addedBy: 'ghampus-vision' },
      );
      return { ok: true, sourceId: result.sourceId, nodeCount: result.nodeIds.length };
    }
    case 'attachments:repair': {
      // User found where their file moved to — re-point the attachment.
      // If we stored a contentHash at attach time and the new file hashes
      // differently, refuse unless `force: true` (the UI surfaces a
      // "looks like a different file" confirm and re-calls with force).
      const { repairAttachmentPath } = await import('./attachments-store.js');
      const args = z.object({
        id: z.string().min(1),
        newPath: z.string().min(1),
        force: z.boolean().optional(),
      }).parse(params ?? {});
      const res = await repairAttachmentPath(deps.host.getCortexDir(), args.id, args.newPath, {
        force: args.force === true,
      });
      return res;
    }

    case 'mcp:activitySummary': {
      // Aggregates the existing agent-audit + MCP source-attribution
      // streams into a per-client / per-tool rollup. Drives the
      // "AI activity" panel on the Activity page. No gate.
      const cortexDir = deps.host.getCortexDir();
      const { readRecentAuditEntries } = await import('./agent-audit.js');
      const auditEntries = await readRecentAuditEntries(cortexDir, 500);
      // MCP-client activity is derivable from SourceRecord.addedBy on
      // recent ingests + sharing-session metadata.
      const sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const byClient: Record<string, { events: number; lastSeenMs: number }> = {};
      const byTool: Record<string, { events: number; lastSeenMs: number }> = {};
      const skillWalks: Array<{ sourceId: string; whenMs: number }> = [];
      for (const engramId of deps.host.listGraphs()) {
        for (const s of deps.host.listSources(engramId)) {
          if (s.ingestedAt < sinceMs) continue;
          if (s.addedBy && s.addedBy !== 'ghampus') {
            const entry = byClient[s.addedBy] ?? { events: 0, lastSeenMs: 0 };
            entry.events += 1;
            entry.lastSeenMs = Math.max(entry.lastSeenMs, s.ingestedAt);
            byClient[s.addedBy] = entry;
          }
        }
      }
      for (const a of auditEntries) {
        const entry = byTool[a.tool] ?? { events: 0, lastSeenMs: 0 };
        entry.events += 1;
        entry.lastSeenMs = Math.max(entry.lastSeenMs, a.startedAt);
        byTool[a.tool] = entry;
        if (a.tool === 'recall' && typeof a.args.source === 'string' && a.args.source.startsWith('skill:')) {
          skillWalks.push({ sourceId: a.args.source, whenMs: a.startedAt });
        }
      }
      return {
        windowDays: 30,
        byClient: Object.entries(byClient).map(([client, agg]) => ({ client, ...agg })),
        byTool: Object.entries(byTool).map(([tool, agg]) => ({ tool, ...agg })),
        skillWalks: skillWalks.slice(0, 20),
      };
    }

    case 'correction.apply': {
      // Apply a pending correction diff by its diffId (used by MemoryStudio's
      // Edit panel after the user reviews and approves the proposed changes).
      const { diffId } = z.object({ diffId: z.string().min(1) }).parse(params ?? {});
      const pending = deps.pendingDiffs.get(diffId);
      if (!pending) throw new Error(`No pending diff with id "${diffId}". It may have expired or already been applied.`);
      await runApplyCorrection({ host: deps.host, graphId: pending.graphId, diff: pending.diff });
      deps.pendingDiffs.delete(diffId);
      return { ok: true };
    }

    // ── Graphnosis Skills IPC ────────────────────────────────────────────────

    case 'skill:buildContext': {
      // Deterministic Phase 1 preview. Under the empty-engram train contract,
      // returns empty context (no personal-cortex recall). Same scope as train.
      const args = z.object({
        skill: z.string().min(1),
        graphId: z.string().min(1),
        focusGraphIds: z.array(z.string()).nullable().optional(),
        recallBreadth: z.number().int().min(0).max(100).nullable().optional(),
        goals: z.object({
          successLooksLike: z.string().default(''),
          outOfScope: z.string().default(''),
          expectedOnCompletion: z.string().default(''),
        }).optional(),
      }).parse(params ?? {});
      if (!deps.skillTrainer) return null;
      return deps.skillTrainer.buildSkillContext(
        args.skill,
        args.graphId,
        args.focusGraphIds ?? null,
        args.recallBreadth ?? null,
        args.goals,
      );
    }

    case 'skill:train': {
      // License-gated. Full training pipeline (LLM rewrite or memory-augmented).
      const args = z.object({
        skill: z.string().min(1),
        graphId: z.string().min(1),
        skillName: z.string().optional(),
        focusGraphIds: z.array(z.string()).nullable().optional(),
        modelTarget: z.string().optional(),
        save: z.boolean().optional(),
        recallBreadth: z.number().int().min(0).max(100).nullable().optional(),
        goals: z.object({
          successLooksLike: z.string().default(''),
          outOfScope: z.string().default(''),
          expectedOnCompletion: z.string().default(''),
          trigger: z.string().optional(),
          prerequisites: z.string().optional(),
          onFailure: z.string().optional(),
          requires: z.string().optional(),
          produces: z.string().optional(),
        }).optional(),
        // Opt-in for the local-LLM rewrite path. Default false → chunk-and-save.
        useLlmRewrite: z.boolean().optional(),
      }).parse(params ?? {});
      if (!deps.skillTrainer) return null;
      const licenseToken = await getEffectiveLicenseToken(deps);
      const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'skill-training') ?? false;
      if (!licensed) {
        return {
          upgrade_required: true,
          upgrade_url: 'https://graphnosis.com/upgrade',
          message: 'Skill training requires a Graphnosis Pro subscription.',
        };
      }
      // Stream the LLM rewrite token-by-token to the desktop so it can
      // render a live progressive diff. Each Ollama chunk gets broadcast
      // as a graph.mutation-shaped event (the existing event channel
      // already routes through to the desktop's event listener with no
      // protocol changes). The streamId lets the desktop scope chunks
      // to this particular train call — necessary if the user ever fires
      // multiple trains in quick succession.
      const streamId = `train-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      deps.broadcastRaw({
        kind: 'event',
        name: 'graph.mutation',
        payload: { graphId: `__skill_train_start__${streamId}`, ts: Date.now() },
      });
      const onChunk = (chunk: string): void => {
        deps.broadcastRaw({
          kind: 'event',
          name: 'graph.mutation',
          payload: {
            graphId: `__skill_train_chunk__${streamId}`,
            ts: Date.now(),
            chunk,
          },
        });
      };
      // Per-operation status text for the desktop status bar. The label is
      // generic and carries no sensitive data (no skill/engram name, no memory
      // content), so it's safe to broadcast and safe in Presentation Mode; the
      // desktop adds the skill name itself and redacts that locally.
      const onStatus = (label: string): void => {
        deps.broadcastRaw({
          kind: 'event',
          name: 'graph.mutation',
          payload: {
            graphId: `__skill_train_status__${streamId}`,
            ts: Date.now(),
            label,
          },
        });
      };
      const result = await deps.skillTrainer.trainSkill({
        skill: args.skill,
        graphId: args.graphId,
        ...(args.skillName !== undefined ? { skillName: args.skillName } : {}),
        ...(args.focusGraphIds != null ? { focusGraphIds: args.focusGraphIds } : {}),
        ...(args.modelTarget !== undefined ? { modelTarget: args.modelTarget } : {}),
        ...(args.save !== undefined ? { save: args.save } : {}),
        ...(args.recallBreadth != null ? { recallBreadth: args.recallBreadth } : {}),
        // Zod parses optional `goals` fields as `string | undefined`. The
        // TrainSkillInput shape (with `exactOptionalPropertyTypes`) wants
        // those fields either absent or `string` — not the union with
        // `undefined`. The runtime accepts both; this cast just lines up
        // the compile-time types.
        ...(args.goals !== undefined ? { goals: args.goals as import('./gsk-format.js').SkillGoals } : {}),
        ...(args.useLlmRewrite !== undefined ? { useLlmRewrite: args.useLlmRewrite } : {}),
        onChunk,
        onStatus,
      });
      // Final "done" frame — the desktop uses this to finalize the diff
      // view and clean up any in-flight state.
      deps.broadcastRaw({
        kind: 'event',
        name: 'graph.mutation',
        payload: { graphId: `__skill_train_done__${streamId}`, ts: Date.now() },
      });
      return { ...result, streamId };
    }

    case 'skill:export': {
      // Two callable shapes:
      //   - Legacy text-blob export: { skillText, format }
      //   - Phase 3c chunk-driven export: { graphId, sourceId, format }
      // The chunk-driven path is preferred — it reads chunks directly from
      // the graph and runs them through formatTrainedOutputAsMarkdown so
      // export-time markdown is emitted from plain-text storage.
      const args = z.object({
        skillText: z.string().min(1).optional(),
        graphId: z.string().min(1).optional(),
        sourceId: z.string().min(1).optional(),
        format: z.enum(['claude-md', 'cursorrules', 'system-prompt', 'openai', 'raw', 'gsk']),
      }).parse(params ?? {});
      if (!deps.skillTrainer) return '';
      // ── Pro gate: .gsk (encrypted skill pack) exports require a valid
      // skill-training license. All other text formats stay free.
      // The .gsk format is the distribution vehicle for community/official
      // skill packs and signed-and-verifiable artifacts — that's the
      // value-extraction moment we charge for. Plain text exports
      // (claude-md, cursorrules, raw, etc.) remain unrestricted so free
      // users can still ship skills into their own AI tools.
      if (args.format === 'gsk') {
        const licenseToken = await getEffectiveLicenseToken(deps);
        const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'skill-training') ?? false;
        if (!licensed) {
          return {
            upgrade_required: true,
            upgrade_url: 'https://graphnosis.com/upgrade',
            message: 'GSK skill-pack export requires a Graphnosis Pro subscription. Use any other format (claude-md, cursorrules, system-prompt, openai, raw) to share this skill for free.',
          };
        }
      }
      const format = args.format as import('./skill-trainer.js').ExportFormat;
      let result: string | Buffer;
      if (args.graphId && args.sourceId) {
        if (deps.skillTrainer) {
          await deps.skillTrainer.repairHollowSkillSource(args.graphId, args.sourceId);
        }
        result = deps.skillTrainer.exportSkillFromSource(args.graphId, args.sourceId, format);
      } else if (args.skillText) {
        result = deps.skillTrainer.exportSkill(args.skillText, format);
      } else {
        return { ok: false, reason: 'missing_args', message: 'Provide either skillText or {graphId, sourceId}.' };
      }
      // GSK format returns a Buffer — encode as base64 for IPC transport.
      if (Buffer.isBuffer(result)) return result.toString('base64');
      return result;
    }

    case 'skill:syncDispatchExport': {
      const args = z.object({
        graphId: z.string().min(1).default('graphnosis-skills'),
      }).parse(params ?? {});
      if (!deps.skillTrainer || !deps.host) {
        return { ok: false, reason: 'skill-trainer-unavailable' };
      }
      const { exportDispatchToExternalTargets } = await import('./skill-dispatch-sync.js');
      const result = await exportDispatchToExternalTargets(deps.host, deps.skillTrainer, args.graphId);
      return {
        ok: true,
        registryPath: path.join(deps.host.getCortexDir(), 'skill-dispatch-registry.json'),
        claudeLocalPaths: result.claudeLocalPaths,
        cursorRulePath: result.cursorRulePath ?? null,
        cursorrulesPaths: result.cursorrulesPaths,
        routeCount: result.registry?.routes.length ?? 0,
      };
    }

    case 'skill:vitality': {
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
      }).parse(params ?? {});
      if (!deps.skillTrainer) return null;
      return deps.skillTrainer.computeSkillVitality(args.graphId, args.sourceId);
    }

    case 'skill:list': {
      // Read-only listing of all skill sources across engrams (or filtered to one).
      // Returns SkillListEntry[] — already enriched with parsed metadata
      // (trainedAt, mode, recallBreadth) so the Skills UI library can render
      // without a follow-up `getSkill` per row.
      const args = z.object({
        graphId: z.string().min(1).optional(),
      }).parse(params ?? {});
      if (!deps.skillTrainer) return [];
      return deps.skillTrainer.listSkills(args.graphId);
    }

    case 'skill:listRuns': {
      const args = z.object({
        status: z.enum(['running', 'paused', 'blocked-on-human', 'complete', 'failed']).optional(),
        graphId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }).parse(params ?? {});
      let runs = await deps.host.skillRuns.listPublic();
      if (args.graphId) runs = runs.filter((r) => r.skillGraphId === args.graphId);
      if (args.status) runs = runs.filter((r) => r.status === args.status);
      const limit = args.limit ?? 100;
      return { ok: true, runs: runs.slice(0, limit), total: runs.length };
    }

    case 'skill:get': {
      // Full skill detail — includes the trained text. Called when the user
      // opens a row from the library into the Trainer column.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
      }).parse(params ?? {});
      if (!deps.skillTrainer) return null;
      await deps.skillTrainer.repairHollowSkillSource(args.graphId, args.sourceId);
      return deps.skillTrainer.getSkill(args.graphId, args.sourceId);
    }

    case 'skill:history': {
      // Version history for a skill: the current live version plus every prior
      // in-place-retrain snapshot (newest first). Powers the "Version history"
      // expander in the library — retrain history moved from sibling sources to
      // the snapshot side-table when in-place retrain shipped.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
      }).parse(params ?? {});
      if (!deps.skillTrainer) return { ok: false, versions: [] };
      const versions = await deps.skillTrainer.getSkillHistory(args.graphId, args.sourceId);
      return { ok: true, versions };
    }

    case 'skill:rollback': {
      // Restore a prior snapshot as the current version (itself recorded as a
      // new snapshot, so the rollback is reversible).
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        snapshotId: z.string().min(1),
      }).parse(params ?? {});
      if (!deps.skillTrainer) return { ok: false };
      const result = await deps.skillTrainer.rollbackSkill(args.graphId, args.sourceId, args.snapshotId);
      return { ok: true, result };
    }

    case 'skill:listNotifications': {
      // Returns sourceIds that have an unacknowledged auto-retrain notification.
      // Used by the library renderer to surface a 🆕 dot on rows.
      const settings = deps.host.getSettings();
      return { sourceIds: settings.skillRetrainNotifications ?? [] };
    }

    case 'skill:clearNotification': {
      // Acknowledge a single sourceId. Called when the user opens that
      // skill in the trainer. The dot disappears on the next library render.
      const args = z.object({ sourceId: z.string().min(1) }).parse(params ?? {});
      const settings = deps.host.getSettings();
      const filtered = (settings.skillRetrainNotifications ?? []).filter((id) => id !== args.sourceId);
      await deps.host.setSettings({ skillRetrainNotifications: filtered });
      return { ok: true };
    }

    case 'skill:listPendingProposals': {
      // Returns the entire skillRetrainPending map. Used by the library
      // header to render a "N pending reviews" indicator + dedicated UI.
      const settings = deps.host.getSettings();
      return { proposals: settings.skillRetrainPending ?? {} };
    }

    case 'skill:listRetrainQueue': {
      const settings = deps.host.getSettings();
      return { queue: settings.skillRetrainQueue ?? {} };
    }

    case 'skill:dismissRetrainQueue': {
      const args = z.object({ sourceId: z.string().min(1) }).parse(params ?? {});
      const { clearSkillRetrainQueueEntry } = await import('./skill-retrain-queue.js');
      await clearSkillRetrainQueueEntry(deps.host, args.sourceId);
      return { ok: true };
    }

    case 'skill:acceptProposal': {
      // Promote a pending retrain proposal: ingest its trained text as the
      // new current version of the skill, then clear the pending entry.
      // Same Pro gate as set-config — only Pro users can have a queue,
      // so accepting one without a license shouldn't be possible, but
      // we re-check defensively.
      const args = z.object({ sourceId: z.string().min(1) }).parse(params ?? {});
      const licenseToken = await getEffectiveLicenseToken(deps);
      const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'skill-training') ?? false;
      if (!licensed) {
        return { ok: false, reason: 'upgrade_required' };
      }
      const settings = deps.host.getSettings();
      const pending = settings.skillRetrainPending ?? {};
      const proposal = pending[args.sourceId];
      if (!proposal) return { ok: false, reason: 'not_found' };
      if (!deps.skillTrainer) return { ok: false, reason: 'trainer_unavailable' };
      // Re-run trainSkill with save=true; this writes the proposal's text
      // as a fresh version via the normal ingest path so vitality, history,
      // and supersession all behave normally.
      try {
        const dateStr = new Date().toISOString().slice(0, 10);
        const label = `auto-praxis review (${dateStr})`;
        await deps.skillTrainer.trainSkill({
          skill: proposal.trained,
          graphId: proposal.graphId,
          skillName: label,
          save: true,
          addedBy: 'graphnosis-autopraxis-accept',
        });
        // Remove from pending.
        const next = { ...pending };
        delete next[args.sourceId];
        await deps.host.setSettings({ skillRetrainPending: next });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: 'accept_failed', message: e instanceof Error ? e.message : String(e) };
      }
    }

    case 'skill:rejectProposal': {
      // Discard a pending proposal without promoting it. Same Pro check
      // as accept; rejection is also a Pro action since only Pro users
      // can have a queue.
      const args = z.object({ sourceId: z.string().min(1) }).parse(params ?? {});
      const settings = deps.host.getSettings();
      const pending = { ...(settings.skillRetrainPending ?? {}) };
      delete pending[args.sourceId];
      await deps.host.setSettings({ skillRetrainPending: pending });
      return { ok: true };
    }

    case 'skill:getRetrainConfig': {
      // Read-only. Returns the AutoRetrainConfig for a given skill source,
      // or null if none is set. Open to all users — the sidecar can't
      // schedule anything without the user being Pro, but knowing whether
      // a config exists is useful for the UI's "currently scheduled" hint.
      const args = z.object({
        sourceId: z.string().min(1),
      }).parse(params ?? {});
      const settings = deps.host.getSettings();
      const map = settings.skillAutoRetrain ?? {};
      return map[args.sourceId] ?? null;
    }

    case 'skill:setRetrainConfig': {
      // Pro-gated. Writes (or clears) the AutoRetrainConfig for a skill.
      // Pass `config: null` to unschedule.
      //
      // We do NOT short-circuit the write when no license is present —
      // we explicitly REJECT with upgrade_required so the desktop UI can
      // show the same upgrade card the LLM-rewrite path uses.
      const ConfigSchema = z.object({
        enabled: z.boolean(),
        graphId: z.string().min(1),
        trigger: z.enum(['scheduled', 'cortex-growth', 'vitality-decay', 'hybrid']),
        intervalMs: z.number().int().positive().optional(),
        cortexGrowthThreshold: z.number().int().positive().optional(),
        vitalityThreshold: z.number().int().min(0).max(100).optional(),
        autonomyLevel: z.enum(['notify', 'auto-accept', 'preview-first']),
        lastAutoRetrain: z.number().int().positive().optional(),
        lastNodeCountSnapshot: z.number().int().nonnegative().optional(),
        enabledAt: z.number().int().positive().optional(),
      }).nullable();
      const args = z.object({
        sourceId: z.string().min(1),
        config: ConfigSchema,
      }).parse(params ?? {});

      const licenseToken = await getEffectiveLicenseToken(deps);
      const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'skill-training') ?? false;
      if (!licensed) {
        return {
          upgrade_required: true,
          upgrade_url: 'https://graphnosis.com/upgrade',
          message: 'Autonomous skill retraining requires a Graphnosis Pro subscription. Subscribe to unlock scheduled and trigger-based retraining.',
        };
      }

      const current = deps.host.getSettings().skillAutoRetrain ?? {};
      const next = { ...current };
      if (args.config === null) {
        delete next[args.sourceId];
      } else {
        // Stamp enabledAt on first enable, preserve on subsequent updates.
        const prior = current[args.sourceId];
        const enabledAt = prior?.enabledAt ?? Date.now();
        // Strip explicit `undefined` values so the result matches
        // SkillAutoRetrainConfig under exactOptionalPropertyTypes.
        const clean = Object.fromEntries(
          Object.entries(args.config).filter(([, v]) => v !== undefined),
        ) as typeof args.config;
        next[args.sourceId] = { ...clean, enabledAt } as typeof next[string];
      }
      await deps.host.setSettings({ skillAutoRetrain: next });
      return { ok: true };
    }

    case 'skill:getHistory': {
      // Version history for a skill. Used by the desktop's diff view so the
      // user can see what changed between the current saved version and the
      // previous one when browsing the library. Returns an array of
      // SkillVersionEntry rows newest first; entry [0] is the live source,
      // entries [1..] are encrypted snapshot files keyed by snapshotId.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
      }).parse(params ?? {});
      if (!deps.skillTrainer) return [];
      return await deps.skillTrainer.getSkillHistory(args.graphId, args.sourceId);
    }

    case 'skill:getSnapshot': {
      // Full content of one snapshot — feeds the desktop's diff baseline
      // view. The returned text is the concatenation of every node in
      // source order, mirroring how `skill:get` renders the live source.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        snapshotId: z.string().min(1),
      }).parse(params ?? {});
      const snap = await deps.host.skillSnapshots.read(args.graphId, args.sourceId, args.snapshotId);
      if (!snap) return null;
      // Editor convention: hidden metadata comment is filtered out so the
      // user-facing diff doesn't lead with the audit header.
      const text = snap.nodes
        .filter((n) => !n.content.trimStart().startsWith('<!--'))
        .map((n) => n.content)
        .join('\n\n');
      return {
        label: snap.label,
        snapshotId: snap.snapshotId,
        ts: snap.ts,
        text,
      };
    }

    case 'skill:rollback': {
      // Restore a skill to a previous snapshot. Same semantics as the
      // `rollback_skill` MCP tool but reachable from the desktop UI
      // when we add a "Restore this version" button to the history
      // panel.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        snapshotId: z.string().min(1),
      }).parse(params ?? {});
      if (!deps.skillTrainer) throw new Error('Skill trainer not available.');
      return await deps.skillTrainer.rollbackSkill(args.graphId, args.sourceId, args.snapshotId);
    }

    case 'skill:deleteSnapshot': {
      // User-initiated delete from the history panel. Idempotent — a
      // missing file is silently a success.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        snapshotId: z.string().min(1),
      }).parse(params ?? {});
      await deps.host.skillSnapshots.delete(args.graphId, args.sourceId, args.snapshotId);
      return { ok: true };
    }

    case 'skill:walkSequence': {
      // Walk a skill as an SOP: returns steps in source order with loop,
      // branch, and sub-skill call annotations.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        recursive: z.boolean().optional().default(false),
      }).parse(params ?? {});
      const { ensureSkillCitedNodesPersisted } = await import('./skill-recall-bindings.js');
      await ensureSkillCitedNodesPersisted(deps.host, args.graphId, args.sourceId);
      const walked = walkSkillSequence(deps.host, args.graphId, args.sourceId, { recursive: args.recursive });
      if (walked.loops.length === 0 && walked.branches.length === 0 && walked.steps.length >= 3) {
        void linkSkillLoopsAndBranches(deps.host, args.graphId, args.sourceId).catch(() => {});
      }
      return walked;
    }

    case 'skill:walkStructured': {
      // Machine-readable SkillExecutionPlan — IPC mirror of MCP walk_skill_structured.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        recursive: z.boolean().optional().default(false),
      }).parse(params ?? {});
      const { walkSkillSequence: walkFn, walkSkillToJson } = await import('./skill-trainer.js');
      const crossLinks = await deps.host.skillCallLinks.getForSource(args.graphId, args.sourceId);
      const { ensureSkillCitedNodesPersisted } = await import('./skill-recall-bindings.js');
      await ensureSkillCitedNodesPersisted(deps.host, args.graphId, args.sourceId);
      const walked = walkFn(deps.host, args.graphId, args.sourceId, {
        recursive: args.recursive,
        crossEngramLinks: crossLinks,
      });
      if (walked.steps.length === 0 && walked.goals.length === 0) {
        return { ok: false, reason: 'empty-skill' };
      }
      const meta = deps.host.getGraphMetadata(args.graphId);
      const src = deps.host.getSourceRecord(args.graphId, args.sourceId);
      const title = walked.steps[0]?.text ?? src?.ref ?? args.sourceId;
      return walkSkillToJson(walked, {
        sourceId: args.sourceId,
        title,
        ...(meta?.displayName ? { engramName: meta.displayName } : {}),
      });
    }

    case 'skill:linkLoops': {
      // Force re-run all SOP edge detection — exposed as a manual "Relink" action.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
      }).parse(params ?? {});
      const [loops, calls, goals] = await Promise.all([
        linkSkillLoopsAndBranches(deps.host, args.graphId, args.sourceId),
        linkSkillCalls(deps.host, args.graphId, args.sourceId, args.graphId),
        linkCrossEngramCalls(deps.host, deps.host.skillCallLinks, args.graphId, args.sourceId, skillEngramIds(deps.host)),
        linkSkillGoals(deps.host, args.graphId, args.sourceId),
      ]);
      await linkSkillContextEdges(deps.host, args.graphId, args.sourceId);
      return { ...loops, ...calls, ...goals };
    }

    case 'skill:formatSop': {
      // Format a skill as a readable SOP text for display or export.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
        recursive: z.boolean().optional().default(false),
      }).parse(params ?? {});
      const walked = walkSkillSequence(deps.host, args.graphId, args.sourceId, { recursive: args.recursive });
      return { text: formatSkillForRecall(walked), walked };
    }

    case 'skill:peekGsk': {
      // Peek at the metadata of a .gsk skill pack WITHOUT ingesting it.
      // Used by the desktop import flow to show a destination picker
      // (per-pack engram vs. existing) populated with the actual pack
      // name, kind, and skill list — so the UI can recommend a sensible
      // default engram (one named after the pack) before committing.
      //
      // The pack bytes arrive base64-encoded just like skill:importGsk.
      // We decrypt, optionally verify the signature when present, and
      // return only the structural metadata. No engram is required, no
      // source is written, no host state is touched.
      const args = z.object({
        gskBase64: z.string().min(1),
      }).parse(params ?? {});

      const { parseGskPackage } = await import('./gsk-format.js');
      let payload: import('./gsk-format.js').GskPayload;
      try {
        const bytes = Buffer.from(args.gskBase64, 'base64');
        payload = parseGskPackage(bytes);
      } catch (e) {
        return {
          ok: false,
          reason: 'parse_failed',
          message: e instanceof Error ? e.message : 'Could not read GSK file.',
        };
      }

      let verified: boolean;
      try {
        verified = deps.licenseValidator
          ? await deps.licenseValidator.verifyGskSignature(payload)
          : false;
      } catch (e) {
        return {
          ok: false,
          reason: 'signature_failed',
          message: e instanceof Error ? e.message : 'GSK signature is invalid.',
        };
      }

      return {
        ok: true,
        verified,
        pack: {
          id: payload.id,
          displayName: payload.displayName,
          version: payload.version,
          author: payload.author,
          kind: payload.kind,
          description: payload.description,
        },
        skills: (payload.skills ?? []).map((s) => ({
          name: s.name,
          sensitivityTier: s.sensitivityTier,
        })),
      };
    }

    case 'skill:saveFallback': {
  // Save a memory-augmented skill result without a Pro license gate.
  // The Pro path uses skill:train (LLM rewrite). The free path uses
  // skill:buildContext (empty recall scope) and assembles the trained text on
  // the JS side. This handler persists that assembled text so free users
  // can save their memory-augmented output — previously they could train
  // but not save, which meant closing the app lost the result.
  const args = z.object({
    graphId: z.string().min(1),
    text: z.string().min(1),
    skillName: z.string().optional(),
    influentialNodeCount: z.number().int().min(0).optional(),
    recallBreadth: z.number().int().min(0).max(100).nullable().optional(),
    addedBy: z.string().optional(),
    goals: z.object({
      successLooksLike: z.string().default(''),
      outOfScope: z.string().default(''),
      expectedOnCompletion: z.string().default(''),
    }).optional(),
  }).parse(params ?? {});

  if (!deps.skillTrainer) return { ok: false, reason: 'trainer_unavailable' };

  const dateStr = new Date().toISOString().slice(0, 10);
  const label = args.skillName
    ? `${args.skillName} (trained ${dateStr})`
    : `Trained skill (${dateStr})`;

  // Phase 3b — section walker. Plain text in storage; export-time formatter
  // is the only place that emits markdown decoration.
  const metadataComment = [
    `<!-- Graphnosis skill training metadata`,
    `     trainedAt: ${new Date().toISOString()}`,
    `     mode: memory-augmented`,
    `     influentialNodes: ${args.influentialNodeCount ?? 0}`,
    `     recallBreadth: ${args.recallBreadth ?? 50}`,
    `-->`,
  ].join('\n');

  // Split the assembled text on blank-line boundaries so each paragraph
  // becomes its own chunk. The free-tier UI assembles a single string here
  // — `args.text` may contain both the original skill and the recalled
  // memories joined together. We don't try to re-classify them: every
  // paragraph lands as role 'body' (the editor doesn't care).
  const bodyParagraphs = args.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const sections: Array<{ role: string; text: string }> = [];
  sections.push({ role: 'metadata', text: metadataComment });
  sections.push({ role: 'title', text: label });
  for (const p of bodyParagraphs) sections.push({ role: 'body', text: p });
  if (args.goals?.successLooksLike) {
    sections.push({ role: 'goal-success', text: `Success: ${args.goals.successLooksLike}` });
  }
  if (args.goals?.outOfScope) {
    sections.push({ role: 'goal-scope', text: `Out of scope: ${args.goals.outOfScope}` });
  }
  if (args.goals?.expectedOnCompletion) {
    sections.push({ role: 'goal-done', text: `On completion: ${args.goals.expectedOnCompletion}` });
  }

  // In-place rewrite path — mirrors trainSkill's Phase 3 logic so the free
  // memory-augmented save and the Pro train end up with identical on-disk
  // shape: one source per skill name, snapshot of the previous state in
  // skill-snapshots/, no atlas pollution from accumulated retrain sources.
  //
  // Helpers used below are statically imported at the top of this file:
  //   - baseSkillName(label): strips the `skill:<ts>:` ref prefix and the
  //     "(trained YYYY-MM-DD)" suffix, so a freshly-built label and an
  //     existing source ref normalize to the same base name
  //   - SkillSnapshotStore.idFromTs: builds the snapshot filename stem
  const baseName = baseSkillName(label);

  // Find the prior source for this skill name. Multiple matches can only
  // happen with engrams that pre-date the in-place model — the most
  // recent is the canonical one and the older duplicates get cleaned up
  // below.
  const allSkills = deps.host.listSources(args.graphId).filter((s) => s.kind === 'skill');
  const matching = allSkills
    .filter((s) => baseSkillName(s.ref) === baseName)
    .sort((a, b) => b.ingestedAt - a.ingestedAt);
  const existing = matching[0];

  let skillId: string;
  if (existing) {
    // Snapshot the live state before mutating. Same shape trainSkill writes
    // so the history panel renders both paths uniformly.
    const now = Date.now();
    const nodeMap = new Map(deps.host.listNodes(args.graphId).map((n) => [n.id, n]));
    const liveNodes: Array<{ content: string }> = [];
    for (const nid of existing.nodeIds) {
      const meta = nodeMap.get(nid);
      if (!meta) continue;
      if (meta.confidence <= 0.2) continue;
      if (meta.validUntil !== undefined && meta.validUntil <= now) continue;
      const content = deps.host.getFullNodeContent(args.graphId, nid) ?? '';
      if (!content) continue;
      liveNodes.push({ content });
    }
    const ts = Date.now();
    await deps.host.skillSnapshots.append(args.graphId, {
      snapshotId: SkillSnapshotStore.idFromTs(ts),
      ts,
      sourceId: existing.sourceId,
      ref: existing.ref,
      label: existing.ref.replace(/^skill:\d+:/, ''),
      mode: 'memory-augmented',
      nodes: liveNodes,
    });

    // Forget any older duplicate sources (pre-in-place model migration).
    for (const dup of matching.slice(1)) {
      try {
        await deps.host.forgetSource(args.graphId, dup.sourceId, {
          triggeredBy: 'ipc:skill:saveFallback:migrate-duplicates',
        });
      } catch { /* non-fatal */ }
    }

    // Wipe the source — rename only after inserts succeed (see trainSkill).
    await deps.host.clearSourceNodes(args.graphId, existing.sourceId, {
      triggeredBy: 'ipc:skill:saveFallback:in-place',
      reason: 'pre-retrain clear (snapshot saved)',
    });
    const newRef = `skill:${ts}:${baseName}`;
    skillId = existing.sourceId;

    // Insert every section into the cleared source. The metadata-comment
    // node leads so the editor's hidden-audit-row treatment matches the
    // Pro path.
    for (const s of sections) {
      const len = deps.host.getSourceRecord(args.graphId, skillId)?.nodeIds.length ?? 0;
      await deps.host.insertNodeAt(args.graphId, skillId, len, s.text, {
        skipRelink: true,
        role: s.role,
        triggeredBy: 'ipc:skill:saveFallback',
      });
    }
    await deps.host.renameSource(args.graphId, existing.sourceId, newRef, {
      triggeredBy: 'ipc:skill:saveFallback:in-place',
    });
  } else {
    // First-time save for this skill name. Same as the legacy path: seed
    // the source via ingestClip(metadataComment) and append the rest.
    const first = sections.shift()!;
    const rec = await ingestClip(
      deps.host,
      args.graphId,
      first.text,
      label,
      {
        addedBy: args.addedBy ?? 'graphnosis-skill-trainer',
        sourceKind: 'skill',
        triggeredBy: 'ipc:skill:saveFallback',
      },
    );
    for (const s of sections) {
      const len = deps.host.getSourceRecord(args.graphId, rec.sourceId)?.nodeIds.length ?? 1;
      await deps.host.insertNodeAt(args.graphId, rec.sourceId, len, s.text, {
        skipRelink: true,
        role: s.role,
        triggeredBy: 'ipc:skill:saveFallback',
      });
    }
    skillId = rec.sourceId;
  }

  deps.host.triggerRelink(args.graphId);

  return { ok: true, skillId };
}

    case 'skill:importGsk': {
      // Import a .gsk skill pack into the user's cortex.
      //
      // The file arrives as base64-encoded bytes from the desktop's
      // <input type=file> reader. We:
      //   1. Decrypt + parse the AES-GCM-wrapped JSON payload.
      //   2. Verify the Ed25519 signature when present (official pack);
      //      community packs with empty signature import as "unverified".
      //   3. Ingest EACH skill in the pack as its own kind:'skill' source
      //      in the target engram (the auto-resolved Skills engram on the
      //      UI side, or whichever engram the user picked via "Change").
      //      Each source is independent — the user can re-train, export,
      //      or forget it just like a self-trained skill.
      //
      // The pack's `graphnosisMd` is NOT written to disk here — that
      // belongs in a separate user-confirmed flow ("Drop GRAPHNOSIS.md
      // into project root?") which is outside this IPC's responsibility.
      const args = z.object({
        graphId: z.string().min(1),
        gskBase64: z.string().min(1),
        // Optional override for the addedBy audit field — defaults to
        // 'graphnosis-skill-importer' so imports are visible in the
        // Sources panel's "added by" column.
        addedBy: z.string().optional(),
      }).parse(params ?? {});

      const { parseGskPackage } = await import('./gsk-format.js');
      let payload: import('./gsk-format.js').GskPayload;
      try {
        const bytes = Buffer.from(args.gskBase64, 'base64');
        payload = parseGskPackage(bytes);
      } catch (e) {
        return {
          ok: false,
          reason: 'parse_failed',
          message: e instanceof Error ? e.message : 'Could not read GSK file.',
        };
      }

      // Verify signature when present. Community packs return false (not an
      // error — just no badge). Tampered signatures throw and we surface
      // that to the UI as a hard error so the user knows the file isn't
      // trustworthy.
      let verified: boolean;
      try {
        verified = deps.licenseValidator
          ? await deps.licenseValidator.verifyGskSignature(payload)
          : false;
      } catch (e) {
        return {
          ok: false,
          reason: 'signature_failed',
          message: e instanceof Error ? e.message : 'GSK signature is invalid.',
        };
      }

      // Confirm the target engram exists.
      const meta = deps.host.getGraphMetadata(args.graphId);
      if (!meta) {
        return { ok: false, reason: 'unknown_graph', message: `Engram ${args.graphId} is not loaded.` };
      }

      const imported: Array<{ name: string; sourceId: string }> = [];
      const skippedEmpty: string[] = [];
      for (const skill of payload.skills) {
        // Prefer trainedTextFallback (already-applied delta) over baseText
        // when a delta pack carries one — matches how the export side picks
        // what to render for users without the base pack.
        const body = (skill.trainedTextFallback?.trim() || skill.baseText?.trim() || '').trim();
        if (!body) {
          skippedEmpty.push(skill.name);
          continue;
        }
        const label = skill.name;

        // Phase 3a — per-paragraph section walker.
        // Build a `sections[]` array of plain-text chunks (NO markdown
        // decoration — markdown is a presentation concern emitted by
        // formatTrainedOutputAsMarkdown at export time only). Preserve the
        // .gsk's paragraph boundaries verbatim — one chunk per body
        // paragraph, one per recipe, one per goal line.
        const provenanceComment = [
          `<!-- imported ${new Date().toISOString()} · pack:${payload.id} v${payload.version}`,
          payload.upstreamPackId ? ` · upstream:${payload.upstreamPackId}` : '',
          ` · ${payload.kind} · verified:${verified} · author:${payload.author} -->`,
        ].join('');

        const formatRecipePlain = (
          r: { name: string; trigger: string; steps: Array<{ tool: string; query: string }> },
        ): string => {
          const lines: string[] = [`${r.name}: ${r.trigger}`];
          for (const s of r.steps) lines.push(`- ${s.tool}: ${s.query}`);
          return lines.join('\n');
        };

        // Build the full section list. Each entry becomes one node in the
        // skill source. The TITLE is included here as a regular section —
        // it'll be inserted via insertNodeAt below, not via ingestClip's
        // markdown path (which was duplicating titles 2x via the SDK chunker
        // because `# Title` with no body created both an H1 node AND a
        // section-content node).
        const sections: Array<{ role: string; text: string }> = [];
        sections.push({ role: 'title', text: label });
        for (const para of body.split(/\n{2,}/)) {
          const t = para.trim();
          if (t) sections.push({ role: 'body', text: t });
        }
        for (const r of skill.recallRecipes ?? []) {
          sections.push({ role: 'recipe', text: formatRecipePlain(r) });
        }
        // All 8 goal categories — must mirror the trainSkill path. Earlier
        // versions only handled the first 3, which silently dropped Trigger /
        // Prerequisites / On failure / Requires / Produces from every imported
        // .gsk pack regardless of what the pack actually contained.
        if (skill.goals?.successLooksLike) {
          sections.push({ role: 'goal-success', text: `Success: ${skill.goals.successLooksLike}` });
        }
        if (skill.goals?.outOfScope) {
          sections.push({ role: 'goal-scope', text: `Out of scope: ${skill.goals.outOfScope}` });
        }
        if (skill.goals?.expectedOnCompletion) {
          sections.push({ role: 'goal-done', text: `On completion: ${skill.goals.expectedOnCompletion}` });
        }
        if (skill.goals?.trigger) {
          sections.push({ role: 'goal-trigger', text: `Trigger: ${skill.goals.trigger}` });
        }
        if (skill.goals?.prerequisites) {
          sections.push({ role: 'goal-prereq', text: `Prerequisites: ${skill.goals.prerequisites}` });
        }
        if (skill.goals?.onFailure) {
          sections.push({ role: 'goal-failure', text: `On failure: ${skill.goals.onFailure}` });
        }
        if (skill.goals?.requires) {
          sections.push({ role: 'goal-requires', text: `Requires: ${skill.goals.requires}` });
        }
        if (skill.goals?.produces) {
          sections.push({ role: 'goal-produces', text: `Produces: ${skill.goals.produces}` });
        }

        // Ingest the provenance comment as the SEED chunk. ingestClip's text
        // path creates exactly ONE node for an HTML comment (no markdown
        // duplication), matching the trainSkill pattern. Everything else —
        // title, body, recipes, goals — gets inserted via insertNodeAt as
        // plain text, one node per section, no SDK chunker involvement.
        const rec = await ingestClip(
          deps.host,
          args.graphId,
          provenanceComment,
          label,
          {
            addedBy: args.addedBy ?? 'graphnosis-skill-importer',
            sourceKind: 'skill',
            triggeredBy: 'ipc:skill:importGsk',
          },
        );
        for (const s of sections) {
          const len = deps.host.getSourceRecord(args.graphId, rec.sourceId)?.nodeIds.length ?? 1;
          await deps.host.insertNodeAt(args.graphId, rec.sourceId, len, s.text, {
            skipRelink: true,
            role: s.role,
            triggeredBy: 'ipc:skill:importGsk',
          });
        }
        // ── SDK artifact cleanup ─────────────────────────────────────────────
        // Done AFTER all explicit inserts so we catch every artifact node
        // regardless of when the SDK created it (some land synchronously in
        // rec.nodeIds, others appear via the deferred relink/embedding pass
        // that happens between ingestClip return and the loop above).
        //
        // The SDK's text-mode chunker, when handed a short non-prose blob
        // like an HTML comment, sometimes synthesizes one or two extra
        // "header" nodes whose CONTENT is literally the raw sourceRef
        // (e.g. "skill:1780218553067:Vision-based defect inspection").
        // They're never useful — purge them.
        //
        // We compare against FULL node content via getFullNodeContent (not
        // listNodes.contentPreview, which is truncated to ~120 chars and
        // can lose trailing punctuation, so an equality test on it would
        // miss matches). And we scan the entire current source.nodeIds
        // list — not just rec.nodeIds — so artifacts added by background
        // processes after ingestClip returned are also caught.
        {
          const refText = rec.ref; // "skill:{ts}:{label}"
          const src = deps.host.getSourceRecord(args.graphId, rec.sourceId);
          const idsSnapshot = src ? src.nodeIds.slice() : [];
          const artifactIds: string[] = [];
          for (const nid of idsSnapshot) {
            const full = deps.host.getFullNodeContent(args.graphId, nid) ?? '';
            if (full.trim() === refText) artifactIds.push(nid);
          }
          for (const aid of artifactIds) {
            try {
              await deps.host.removeNodeFromSource(args.graphId, rec.sourceId, aid, {
                triggeredBy: 'ipc:skill:importGsk',
                reason: 'SDK seed artifact (sourceRef-text node)',
              });
            } catch { /* node already gone — non-fatal */ }
          }
        }
        // Single coalesced relink pass after all paragraphs are in.
        deps.host.triggerRelink(args.graphId);
        // Wire all SOP edges (sequence, goals, loops, ctx, sub-skill calls).
        await linkSkillSequence(deps.host, args.graphId, rec.sourceId);
        await linkSkillGoals(deps.host, args.graphId, rec.sourceId);
        imported.push({ name: skill.name, sourceId: rec.sourceId });
      }

      return {
        ok: true,
        verified,
        pack: {
          id: payload.id,
          displayName: payload.displayName,
          version: payload.version,
          author: payload.author,
          kind: payload.kind,
          description: payload.description,
        },
        engramName: meta.displayName ?? args.graphId,
        graphId: args.graphId,
        imported,
        skippedEmpty,
      };
    }

    case 'license:setToken': {
      // Persist a license token received via the graphnosis:// deep link,
      // the status-poll endpoint, or the manual Settings → License paste
      // field. The token is encrypted at rest with the cortex data key
      // (host.setLicenseToken). Validation is a best-effort verify against
      // the validator's public key — invalid tokens are rejected here so
      // we never persist garbage, even though setLicenseToken itself only
      // encrypts opaque bytes.
      const args = z.object({
        token: z.string().min(1),
      }).parse(params ?? {});
      const trimmed = args.token.trim();
      // Reject obvious malformed tokens up-front.
      if (!/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(trimmed)) {
        return { ok: false, reason: 'malformed' };
      }
      const payload = deps.licenseValidator?.verifyToken(trimmed) ?? null;
      if (!payload) {
        return { ok: false, reason: 'invalid_or_expired' };
      }
      await deps.host.setLicenseToken(trimmed);
      return {
        ok: true,
        plan: payload.plan,
        features: payload.features,
        sub: payload.sub,
        expiresAt: payload.exp * 1000,
      };
    }

    case 'license:pollServer': {
      // Server-side subscription poll. The browser `fetch` from the frontend is
      // blocked by CORS — both in dev (origin http://localhost:5173) AND in the
      // installed app (origin tauri://localhost) — because graphnosis.com only
      // allows its own web origin. Doing the request HERE (Node, no CORS) works
      // in every build. Uses node:https (not fetch) so it inherits the system
      // CA trust store — required on corporate networks with SSL inspection proxies.
      // On success the token is validated + persisted just like license:setToken.
      const args = z.object({
        email: z.string().min(3),
        key: z.string().optional(),
        baseUrl: z.string().optional(),
      }).parse(params ?? {});
      const base = (args.baseUrl ?? 'https://graphnosis.com').replace(/\/$/, '');
      const keyParam = args.key ? `&key=${encodeURIComponent(args.key)}` : '';
      const url = `${base}/api/subscription/token?email=${encodeURIComponent(args.email)}${keyParam}`;
      let token: string | undefined;
      try {
        const { status, body } = await httpsGetLicense(url);
        if (status === 204) {
          return { ok: false, reason: 'no_token' };
        }
        if (status === 202) {
          return { ok: false, reason: 'otp_required' };
        }
        if (status < 200 || status >= 300) {
          return { ok: false, reason: `http_${status}` };
        }
        const data = JSON.parse(body) as { token?: string };
        token = data.token;
      } catch (e) {
        const msg = (e as Error).message ?? '';
        const blocked = /socket.*closed|connection.*reset|ECONNRESET|ECONNREFUSED|network.*changed|timeout/i.test(msg);
        console.error('[license:pollServer] https error:', msg);
        return { ok: false, reason: blocked ? 'network_blocked' : `fetch_failed: ${msg}` };
      }
      if (!token) { console.error('[license:pollServer] server returned 200 but no token field'); return { ok: false, reason: 'no_token' }; }
      const trimmed = token.trim();
      const dotCount = (trimmed.match(/\./g) ?? []).length;
      if (!/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(trimmed)) {
        return { ok: false, reason: 'malformed' };
      }
      const payload = deps.licenseValidator?.verifyToken(trimmed) ?? null;
      if (!payload) {
        console.error('[license:pollServer] verifyToken returned null — len:', trimmed.length, 'dots:', dotCount);
        return { ok: false, reason: 'invalid_or_expired' };
      }
      await deps.host.setLicenseToken(trimmed);
      return { ok: true, plan: payload.plan, features: payload.features, sub: payload.sub, expiresAt: payload.exp * 1000 };
    }

    case 'license:verifyOtp': {
      const args = z.object({
        email: z.string().min(3),
        code: z.string().length(6),
        key: z.string().optional(),
        baseUrl: z.string().optional(),
        target: z.enum(['primary', 'domain']).optional(),
      }).parse(params ?? {});
      const base = (args.baseUrl ?? 'https://graphnosis.com').replace(/\/$/, '');
      const keyParam = args.key ? `&key=${encodeURIComponent(args.key)}` : '';
      const otpUrl = `${base}/api/subscription/token?email=${encodeURIComponent(args.email)}&otp=${encodeURIComponent(args.code)}${keyParam}`;
      let token: string | undefined;
      let pollSecret: string | undefined;
      try {
        const { status, body } = await httpsGetLicense(otpUrl);
        if (status === 401) {
          const data = JSON.parse(body) as { error?: string; attemptsLeft?: number };
          return { ok: false, reason: data.error ?? 'otp_invalid', attemptsLeft: data.attemptsLeft };
        }
        if (status < 200 || status >= 300) return { ok: false, reason: `http_${status}` };
        const data = JSON.parse(body) as { token?: string; pollSecret?: string };
        token = data.token;
        pollSecret = data.pollSecret;
      } catch (e) {
        const msg = (e as Error).message ?? '';
        const blocked = /socket.*closed|connection.*reset|ECONNRESET|ECONNREFUSED|network.*changed|timeout/i.test(msg);
        console.error('[license:verifyOtp] https error:', msg);
        return { ok: false, reason: blocked ? 'network_blocked' : `fetch_failed: ${msg}` };
      }
      if (!token) { console.error('[license:verifyOtp] server returned 200 but no token field'); return { ok: false, reason: 'no_token' }; }
      const trimmed = token.trim();
      const dotCount = (trimmed.match(/\./g) ?? []).length;
      if (!/^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$/.test(trimmed)) {
        console.error('[license:verifyOtp] token format invalid — len:', trimmed.length, 'dots:', dotCount, 'start:', trimmed.slice(0, 30));
        return { ok: false, reason: 'malformed' };
      }
      const payload = deps.licenseValidator?.verifyToken(trimmed) ?? null;
      if (!payload) {
        console.error('[license:verifyOtp] verifyToken returned null — len:', trimmed.length, 'dots:', dotCount);
        return { ok: false, reason: 'invalid_or_expired' };
      }
      if (args.target === 'primary') {
        // Stripe recovery — store in the primary encrypted slot.
        await deps.host.setLicenseToken(trimmed);
      } else {
        // Domain seat activation — store in the domain slot so a personal Pro
        // subscription in the primary slot is not overwritten.
        const currentSettings = deps.host.getSettings();
        await deps.host.setSettings({ ...currentSettings, domainSeatLicenseToken: trimmed });
      }
      return { ok: true, plan: payload.plan, features: payload.features, sub: payload.sub, expiresAt: payload.exp * 1000, pollSecret };
    }

    case 'license:status': {
      // Read-only summary of the currently-stored license. Used by the
      // Skills tab's "your subscription" chip and Settings → License panel
      // to render plan / expiry / features without re-decoding the token
      // on the frontend. Returns both the effective (best-tier) token's flat
      // fields for backward compat, and a `tokens` array with one entry per
      // active slot (personal + domain seat) so the UI can show both.
      const primaryToken = await deps.host.getLicenseToken();
      const settings = deps.host.getSettings();
      const domainToken = settings.domainSeatLicenseToken ?? null;
      const toEntry = (raw: string, source: 'personal' | 'domain') => {
        const p = deps.licenseValidator?.verifyToken(raw) ?? null;
        if (!p) return null;
        return {
          source,
          plan: p.plan,
          features: p.features,
          sub: p.sub,
          expiresAt: p.exp * 1000,
          expiringSoon: deps.licenseValidator?.isExpiringSoon(raw) ?? false,
          renews: p.renews !== false,
        };
      };
      const entries = [
        primaryToken ? toEntry(primaryToken, 'personal') : null,
        domainToken ? toEntry(domainToken, 'domain') : null,
      ].filter((e): e is NonNullable<ReturnType<typeof toEntry>> => e !== null);
      if (entries.length === 0) return { present: false };
      // Effective token = highest-tier entry (for flat backward-compat fields).
      const best = entries.reduce((a, b) => {
        const tierOf = (e: typeof a) => {
          if (e.features.includes('enterprise')) return 4;
          if (e.features.includes('teams')) return 3;
          if (e.features.includes('skill-training')) return 2;
          return 1;
        };
        return tierOf(b) > tierOf(a) ? b : a;
      });
      return {
        present: true,
        valid: true,
        plan: best.plan,
        features: best.features,
        sub: best.sub,
        expiresAt: best.expiresAt,
        expiringSoon: best.expiringSoon,
        renews: best.renews,
        tokens: entries,
      };
    }

    case 'license:clear': {
      // Wipe both license slots from disk. The frontend also clears cached
      // billing emails from localStorage. Non-destructive on Stripe or OTP —
      // the user returns to Free tier locally until they reconnect.
      //
      // Pass explicit undefined for both fields. setSettings does a shallow
      // merge ({ ...this.settings, ...partial }), so a deleted key in a copy
      // of this.settings would not shadow the live value — the old licenseEnc
      // would survive. Spreading { licenseEnc: undefined } DOES override it,
      // and mergeWithDefaults's typeof-string guard then omits both fields.
      await deps.host.setSettings({
        licenseEnc: undefined as unknown as string,
        domainSeatLicenseToken: undefined as unknown as string,
      });
      return { ok: true };
    }

    case 'skill:checkLicenseExpiry': {
      // Returns expiry info for the renewal reminder banner.
      // Non-null only when a valid token is present and expiring soon.
      const licenseToken = await getEffectiveLicenseToken(deps);
      if (!licenseToken || !deps.licenseValidator) return null;
      const expiringSoon = deps.licenseValidator.isExpiringSoon(licenseToken);
      const payload = deps.licenseValidator.verifyToken(licenseToken);
      if (!payload) return null;
      return {
        expiringSoon,
        validUntil: payload.exp * 1000,
        plan: payload.plan,
      };
    }

    // ── Sharing token management ──────────────────────────────────────────────

    case 'cortex:sessionLease': {
      const cortexDir = deps.cortexDir ?? deps.host.getCortexDir?.() ?? '';
      if (!cortexDir) return { busy: false, lease: null, self: true };
      const { busy, lease } = await isCortexSessionBusy(cortexDir);
      const fresh = lease && isSessionLeaseFresh(lease) ? lease : null;
      return {
        busy,
        lease: fresh,
        self: fresh?.pid === process.pid,
      };
    }

    case 'sso:get': {
      const settings = deps.host.getSettings();
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      const domainSeat = (settings.domainSeatLicenseToken ?? null) !== null
        && deps.licenseValidator?.verifyToken(settings.domainSeatLicenseToken ?? '') !== null;
      const ssoReady = settings.sso?.enabled
        && isEnterpriseSsoConfigured(settings.sso)
        && settings.sso.federatedUnlockReady === true;
      return {
        ok: true,
        enterprise: hasEnterprise || domainSeat,
        phase: 'oidc-unlock',
        unlockMode: ssoReady ? 'sso' : 'passphrase',
        ssoSession: deps.ssoSession ?? null,
        settings: enterpriseSsoPublicView(settings.sso),
      };
    }

    case 'sso:status': {
      const settings = deps.host.getSettings();
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      const domainSeat = (settings.domainSeatLicenseToken ?? null) !== null
        && deps.licenseValidator?.verifyToken(settings.domainSeatLicenseToken ?? '') !== null;
      const sso = settings.sso;
      const configured = isEnterpriseSsoConfigured(sso);
      const ssoReady = sso?.enabled && configured && sso.federatedUnlockReady === true;
      const issuer = sso?.oidc?.issuer?.trim() ?? '';
      const hints = issuer ? idpUiHints(issuer, sso?.oidc?.oidcTenantId) : {
        suggestedButtonLabel: 'Sign in with company account',
      };
      let idpReachable = false;
      let idpReachabilityError: string | undefined;
      if (issuer) {
        const probe = await probeIdpReachability(issuer);
        idpReachable = probe.reachable;
        idpReachabilityError = probe.error;
      }
      return {
        ok: true,
        enterprise: hasEnterprise || domainSeat,
        enabled: sso?.enabled ?? false,
        protocol: sso?.protocol ?? 'oidc',
        configured,
        federatedUnlockReady: sso?.federatedUnlockReady === true,
        breakGlassPassphrase: sso?.breakGlassPassphrase ?? true,
        groupMappingCount: sso?.groupRoleMappings?.length ?? 0,
        lastLogin: sso?.lastLogin ?? null,
        unlockMode: ssoReady ? 'sso' : 'passphrase',
        phase: 'oidc-unlock',
        ssoSession: deps.ssoSession ?? null,
        idpReachable,
        ...(idpReachabilityError ? { idpReachabilityError } : {}),
        suggestedButtonLabel: hints.suggestedButtonLabel,
        ...(hints.tenantHint ? { tenantHint: hints.tenantHint } : {}),
        showButton: configured && (sso?.enabled ?? false) && (sso?.protocol ?? 'oidc') === 'oidc',
        note: ssoReady
          ? idpReachable
            ? 'Federated OIDC unlock is available on the lock screen when SSO credentials are in the OS keychain on this Mac.'
            : 'SSO is configured but the IdP is unreachable — connect to your company network, or use break-glass passphrase.'
          : 'Enable SSO and save while unlocked to provision federated unlock.',
      };
    }

    case 'sso:discover': {
      const cortexDir = deps.cortexDir ?? deps.host.getCortexDir?.() ?? '';
      if (!cortexDir) return { ok: false, reason: 'no_cortex' };
      const discover = await discoverSsoUnlock(cortexDir);
      return { ok: true, discover };
    }

    case 'sso:offer': {
      const cortexDir = deps.cortexDir ?? deps.host.getCortexDir?.() ?? '';
      if (!cortexDir) return { ok: false, reason: 'no_cortex' };
      const offer = await readSsoUnlockOffer(cortexDir);
      return { ok: true, offer };
    }

    case 'sso:set': {
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      if (!hasEnterprise) {
        return {
          ok: false,
          reason: 'enterprise_required',
          message: 'Enterprise SSO configuration requires an Enterprise license.',
        };
      }

      const args = z.object({
        enabled: z.boolean().optional(),
        protocol: z.enum(['oidc', 'saml']).optional(),
        breakGlassPassphrase: z.boolean().optional(),
        oidc: z.object({
          issuer: z.string().max(512).optional(),
          clientId: z.string().max(256).optional(),
          clientSecret: z.string().max(512).optional(),
          oidcTenantId: z.string().max(64).optional(),
          scopes: z.array(z.string().min(1).max(64)).max(32).optional(),
          groupsClaim: z.string().max(128).optional(),
          redirectUri: z.string().max(512).optional(),
          clearClientSecret: z.boolean().optional(),
        }).optional(),
        saml: z.object({
          entityId: z.string().max(512).optional(),
          ssoUrl: z.string().max(512).optional(),
          idpCertificate: z.string().max(8192).optional(),
        }).optional(),
        groupRoleMappings: z.array(z.object({
          idpGroup: z.string().min(1).max(256),
          role: z.enum(SHARING_TOKEN_ROLES as unknown as [SharingRole, ...SharingRole[]]),
        })).max(64).optional(),
        generateOrgSigningKey: z.boolean().optional(),
        clearOrgSigningKey: z.boolean().optional(),
      }).parse(params ?? {});

      const current = deps.host.getSettings();
      const prev = current.sso ?? sanitizeEnterpriseSsoSettings({})!;
      const next: EnterpriseSsoSettings = {
        ...prev,
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.protocol !== undefined ? { protocol: args.protocol } : {}),
        ...(args.breakGlassPassphrase !== undefined ? { breakGlassPassphrase: args.breakGlassPassphrase } : {}),
        ...(args.groupRoleMappings !== undefined
          ? { groupRoleMappings: args.groupRoleMappings as IdpGroupRoleMapping[] }
          : {}),
      };

      if (args.oidc) {
        const o = args.oidc;
        const prevOidc = prev.oidc ?? { issuer: '', clientId: '' };
        let clientSecret = prevOidc.clientSecret;
        let clientSecretEnc = prevOidc.clientSecretEnc;
        if (o.clearClientSecret) {
          clientSecret = undefined;
          clientSecretEnc = undefined;
        } else if (o.clientSecret !== undefined && o.clientSecret.length > 0) {
          clientSecret = o.clientSecret;
          clientSecretEnc = undefined;
        }
        next.oidc = {
          issuer: o.issuer !== undefined ? o.issuer.trim() : prevOidc.issuer,
          clientId: o.clientId !== undefined ? o.clientId.trim() : prevOidc.clientId,
          ...(clientSecret ? { clientSecret } : {}),
          ...(clientSecretEnc ? { clientSecretEnc } : {}),
          ...(o.oidcTenantId !== undefined
            ? (o.oidcTenantId.trim() ? { oidcTenantId: o.oidcTenantId.trim() } : {})
            : prevOidc.oidcTenantId ? { oidcTenantId: prevOidc.oidcTenantId } : {}),
          ...(o.scopes ?? prevOidc.scopes ? { scopes: o.scopes ?? prevOidc.scopes } : {}),
          ...(o.groupsClaim !== undefined
            ? (o.groupsClaim.trim() ? { groupsClaim: o.groupsClaim.trim() } : {})
            : prevOidc.groupsClaim ? { groupsClaim: prevOidc.groupsClaim } : {}),
          ...(o.redirectUri !== undefined
            ? (o.redirectUri.trim() ? { redirectUri: o.redirectUri.trim() } : {})
            : prevOidc.redirectUri ? { redirectUri: prevOidc.redirectUri } : {}),
        };
      }

      if (args.saml) {
        const s = args.saml;
        const prevSaml = prev.saml ?? {};
        const entityId = s.entityId !== undefined ? s.entityId.trim() : prevSaml.entityId;
        const ssoUrl = s.ssoUrl !== undefined ? s.ssoUrl.trim() : prevSaml.ssoUrl;
        const idpCertificate = s.idpCertificate !== undefined ? s.idpCertificate : prevSaml.idpCertificate;
        next.saml = {
          ...(entityId ? { entityId } : {}),
          ...(ssoUrl ? { ssoUrl } : {}),
          ...(idpCertificate ? { idpCertificate } : {}),
        };
      }

      if (args.clearOrgSigningKey) {
        delete next.orgSignPublicKey;
        delete next.orgSignSecret;
        delete next.orgSignSecretEnc;
      } else if (args.generateOrgSigningKey) {
        const kp = await deps.host.provisionOrgSigningKey();
        next.orgSignPublicKey = kp.publicKey;
        next.orgSignSecret = kp.secretKey;
        delete next.orgSignSecretEnc;
      }

      const sanitized = sanitizeEnterpriseSsoSettings(next);
      await deps.host.setSettings({
        ...current,
        sso: sanitized ?? next,
      });

      let keychainSync: { federatedUnlockKey: string; clientSecret?: string } | undefined;
      const saved = deps.host.getSettings().sso;
      const shouldProvision = saved?.enabled
        && isEnterpriseSsoConfigured(saved)
        && saved.protocol === 'oidc';
      if (shouldProvision) {
        let federatedUnlockKey = saved.federatedUnlockKey;
        if (!saved.federatedUnlockReady) {
          const provisioned = await deps.host.provisionFederatedUnlockKey();
          federatedUnlockKey = provisioned.federatedUnlockKey;
        }
        if (federatedUnlockKey) {
          keychainSync = {
            federatedUnlockKey,
            ...(saved.oidc?.clientSecret ? { clientSecret: saved.oidc.clientSecret } : {}),
          };
        }
      }

      return {
        ok: true,
        settings: enterpriseSsoPublicView(deps.host.getSettings().sso),
        ...(keychainSync ? { keychainSync } : {}),
      };
    }

    case 'sso:resolveRole': {
      // Test / preview helper — maps sample IdP groups to a sharing role.
      const args = z.object({
        groups: z.array(z.string()),
      }).parse(params ?? {});
      const settings = deps.host.getSettings();
      const mappings = settings.sso?.groupRoleMappings ?? [];
      const role = resolveRoleFromIdpGroups(mappings, args.groups);
      return {
        ok: true,
        role,
        label: SHARING_ROLE_LABELS[role] ?? role,
      };
    }

    case 'catalog:list': {
      const entries = catalogEntriesFromSettings(deps);
      const args = z.object({
        includeUnpublished: z.boolean().optional(),
      }).parse(params ?? {});
      const includeUnpublished = args.includeUnpublished === true
        && await hasTeamsOrEnterpriseAccess(deps);
      const visible = includeUnpublished
        ? entries
        : entries.filter((e) => e.published !== false);
      const subs = await readCatalogSubscriptions();
      return {
        ok: true,
        entries: visible.map(engramCatalogPublicEntry),
        subscribedCatalogIds: subs.subscribedCatalogIds,
        installedPackageIds: subs.installedPackageIds ?? [],
        drift: await loadCatalogDrift(visible),
      };
    }

    case 'catalog:adminAccess': {
      const licensed = await hasTeamsOrEnterpriseAccess(deps);
      const plan = await resolveAgentPlan(deps);
      return {
        ok: true,
        licensed,
        plan: licensed ? plan : null,
      };
    }

    case 'catalog:upsert': {
      if (!await hasTeamsOrEnterpriseAccess(deps)) {
        return {
          ok: false,
          reason: 'teams_or_enterprise_required',
          message: 'Organization Engram Catalog requires a Teams or Enterprise license.',
        };
      }
      const args = z.object({
        entry: z.object({
          id: z.string().max(64).optional(),
          packageId: z.string().min(1).max(128),
          displayName: z.string().min(1).max(256),
          description: z.string().max(2048).optional(),
          region: z.string().max(128).optional(),
          kind: z.enum(['engram-package', 'hub-slice']),
          installMode: z.enum(['merge-copy', 'federate-readonly']).optional(),
          requiredIdpGroups: z.array(z.string().max(256)).max(64).optional(),
          defaultRole: z.enum(SHARING_TOKEN_ROLES as unknown as [SharingRole, ...SharingRole[]]).optional(),
          sourceEngramId: z.string().max(128).optional(),
          hubRef: z.string().max(256).optional(),
          itControlled: z.boolean().optional(),
          noReshare: z.boolean().optional(),
          mdmBundleId: z.string().max(128).optional(),
          published: z.boolean().optional(),
          requireSsoSession: z.boolean().optional(),
          packId: z.string().max(128).optional(),
          catalogVersion: z.string().max(32).optional(),
        }),
      }).parse(params ?? {});
      const e = args.entry;
      const sanitized = sanitizeEngramCatalogEntry({
        id: e.id?.trim() || generateCatalogEntryId(),
        packageId: e.packageId,
        displayName: e.displayName,
        kind: e.kind,
        installMode: e.installMode ?? (e.kind === 'hub-slice' ? 'federate-readonly' : 'merge-copy'),
        requiredIdpGroups: e.requiredIdpGroups ?? [],
        itControlled: e.itControlled ?? true,
        noReshare: e.noReshare ?? (e.itControlled ?? true),
        ...(e.description !== undefined ? { description: e.description } : {}),
        ...(e.region !== undefined ? { region: e.region } : {}),
        ...(e.defaultRole !== undefined ? { defaultRole: e.defaultRole } : {}),
        ...(e.sourceEngramId !== undefined ? { sourceEngramId: e.sourceEngramId } : {}),
        ...(e.hubRef !== undefined ? { hubRef: e.hubRef } : {}),
        ...(e.packId !== undefined ? { packId: e.packId } : {}),
        ...(e.catalogVersion !== undefined ? { catalogVersion: e.catalogVersion } : {}),
        ...(e.mdmBundleId !== undefined ? { mdmBundleId: e.mdmBundleId } : {}),
        ...(e.published !== undefined ? { published: e.published } : {}),
        ...(e.requireSsoSession === true ? { requireSsoSession: true } : {}),
      });
      if (!sanitized) {
        return { ok: false, reason: 'invalid_entry', message: 'Catalog entry failed validation.' };
      }
      const current = deps.host.getSettings();
      const prev = current.engramCatalog?.entries ?? [];
      const idx = prev.findIndex((e) => e.id === sanitized.id);
      const nextEntries = idx >= 0
        ? prev.map((e, i) => (i === idx ? sanitized : e))
        : [...prev, sanitized];
      await deps.host.setSettings({
        ...current,
        engramCatalog: sanitizeEngramCatalogSettings({ entries: nextEntries, version: 2 })
          ?? { entries: nextEntries, version: 2 },
      });
      return { ok: true, entry: engramCatalogPublicEntry(sanitized) };
    }

    case 'catalog:delete': {
      if (!await hasTeamsOrEnterpriseAccess(deps)) {
        return {
          ok: false,
          reason: 'teams_or_enterprise_required',
          message: 'Organization Engram Catalog requires a Teams or Enterprise license.',
        };
      }
      const args = z.object({ catalogId: z.string().min(1).max(64) }).parse(params ?? {});
      const current = deps.host.getSettings();
      const prev = current.engramCatalog?.entries ?? [];
      const nextEntries = prev.filter((e) => e.id !== args.catalogId);
      if (nextEntries.length === prev.length) {
        return { ok: false, reason: 'not_found', message: 'Catalog entry not found.' };
      }
      await deps.host.setSettings({
        ...current,
        engramCatalog: { entries: nextEntries, version: 2 },
      });
      return { ok: true };
    }

    case 'catalog:installPackage': {
      const args = z.object({ catalogId: z.string().min(1).max(64) }).parse(params ?? {});
      const entry = catalogEntriesFromSettings(deps).find((e) => e.id === args.catalogId);
      if (!entry || entry.published === false) {
        return { ok: false, reason: 'not_found', message: 'Catalog entry not found or not published.' };
      }
      const settings = deps.host.getSettings();
      const groups = settings.sso?.lastLogin?.groups ?? [];
      const ent = catalogInstallEntitlement(deps, entry, groups);
      if (!ent.entitled) {
        return {
          ok: false,
          reason: ent.reason,
          message: catalogEntitlementMessage(entry, ent.reason),
          ...(ent.missingGroups ? { missingGroups: ent.missingGroups } : {}),
        };
      }
      const installed = await installCatalogPackage(deps, entry);
      if (!installed.ok) return installed;
      const store = await recordInstalledPackage(entry.packageId, {
        ...(entry.catalogVersion ? { catalogVersion: entry.catalogVersion } : {}),
        ...(entry.packId ? { packId: entry.packId } : {}),
      });
      const tokenProvision = await provisionCatalogDefaultRoleToken(deps, entry, installed.engramId);
      return {
        ok: true,
        engramId: installed.engramId,
        contentPull: installed.contentPull,
        installedPackageIds: store.installedPackageIds ?? [],
        ...(tokenProvision.created ? { defaultRoleTokenId: tokenProvision.tokenId } : {}),
      };
    }

    case 'catalog:subscribe': {
      const args = z.object({ catalogId: z.string().min(1).max(64) }).parse(params ?? {});
      const entry = catalogEntriesFromSettings(deps).find((e) => e.id === args.catalogId);
      if (!entry || entry.published === false) {
        return { ok: false, reason: 'not_found', message: 'Catalog entry not found or not published.' };
      }
      const settings = deps.host.getSettings();
      const groups = settings.sso?.lastLogin?.groups ?? [];
      const ent = catalogInstallEntitlement(deps, entry, groups);
      if (!ent.entitled) {
        return {
          ok: false,
          reason: ent.reason,
          message: catalogEntitlementMessage(entry, ent.reason),
          ...(ent.missingGroups ? { missingGroups: ent.missingGroups } : {}),
        };
      }
      const store = await subscribeCatalogEntry(args.catalogId);
      const installed = await installCatalogPackage(deps, entry);
      let tokenProvision: { tokenId?: string; created: boolean } = { created: false };
      if (installed.ok) {
        await recordInstalledPackage(entry.packageId, {
          ...(entry.catalogVersion ? { catalogVersion: entry.catalogVersion } : {}),
          ...(entry.packId ? { packId: entry.packId } : {}),
        });
        tokenProvision = await provisionCatalogDefaultRoleToken(deps, entry, installed.engramId);
      }
      const finalStore = await readCatalogSubscriptions();
      return {
        ok: true,
        subscribedCatalogIds: store.subscribedCatalogIds,
        installedPackageIds: finalStore.installedPackageIds ?? [],
        ...(installed.ok
          ? {
            engramId: installed.engramId,
            contentPull: installed.contentPull,
            ...(tokenProvision.created ? { defaultRoleTokenId: tokenProvision.tokenId } : {}),
          }
          : { installWarning: 'Subscription recorded but engram install failed.' }),
      };
    }

    case 'catalog:unsubscribe': {
      const args = z.object({ catalogId: z.string().min(1).max(64) }).parse(params ?? {});
      const store = await unsubscribeCatalogEntry(args.catalogId);
      return { ok: true, subscribedCatalogIds: store.subscribedCatalogIds };
    }

    case 'catalog:subscriptions': {
      const store = await readCatalogSubscriptions();
      return {
        ok: true,
        subscribedCatalogIds: store.subscribedCatalogIds,
        installedPackageIds: store.installedPackageIds ?? [],
        installedPackages: store.installedPackages ?? {},
      };
    }

    case 'catalog:checkDrift': {
      const entries = catalogEntriesFromSettings(deps).filter((e) => e.published !== false);
      const drift = await loadCatalogDrift(entries);
      return { ok: true, drift, count: drift.length };
    }

    case 'catalog:remergePackage': {
      const args = z.object({ catalogId: z.string().min(1).max(64) }).parse(params ?? {});
      const entry = catalogEntriesFromSettings(deps).find((e) => e.id === args.catalogId);
      if (!entry || entry.published === false) {
        return { ok: false, reason: 'not_found', message: 'Catalog entry not found or not published.' };
      }
      const settings = deps.host.getSettings();
      const groups = settings.sso?.lastLogin?.groups ?? [];
      const ent = catalogInstallEntitlement(deps, entry, groups);
      if (!ent.entitled) {
        return {
          ok: false,
          reason: ent.reason,
          message: catalogEntitlementMessage(entry, ent.reason),
        };
      }
      const installed = await installCatalogPackage(deps, entry);
      if (!installed.ok) return installed;
      const store = await recordInstalledPackage(entry.packageId, {
        ...(entry.catalogVersion ? { catalogVersion: entry.catalogVersion } : {}),
        ...(entry.packId ? { packId: entry.packId } : {}),
      });
      return {
        ok: true,
        engramId: installed.engramId,
        contentPull: installed.contentPull,
        installedPackageIds: store.installedPackageIds ?? [],
      };
    }

    case 'playbooks:supervisorDashboard': {
      const runs = await deps.host.skillRuns.list();
      const active = runs.filter((r) => {
        const st = r.status ?? deriveSkillRunStatus(r);
        return st === 'running' || st === 'paused' || st === 'blocked-on-human';
      });
      const complete = runs.filter((r) => (r.status ?? deriveSkillRunStatus(r)) === 'complete');
      const failed = runs.filter((r) => (r.status ?? deriveSkillRunStatus(r)) === 'failed');
      const blocked = runs.filter((r) => (r.status ?? deriveSkillRunStatus(r)) === 'blocked-on-human');
      const entries = catalogEntriesFromSettings(deps).filter((e) => e.published !== false);
      const drift = await loadCatalogDrift(entries);
      const staleSkills: Array<{ graphId: string; sourceId: string; score: number; label?: string }> = [];
      if (deps.skillTrainer) {
        for (const graphId of deps.host.listGraphs()) {
          for (const sk of deps.skillTrainer.listSkills(graphId)) {
            const vit = deps.skillTrainer.computeSkillVitality(graphId, sk.sourceId);
            if (vit.score < 80) {
              staleSkills.push({
                graphId,
                sourceId: sk.sourceId,
                score: vit.score,
                ...(sk.label ? { label: sk.label } : {}),
              });
            }
          }
        }
      }
      return {
        ok: true,
        activePlaybooks: active.map(skillRunToListItem),
        blockedRuns: blocked.map(skillRunToListItem),
        completionRate: runs.length > 0 ? complete.length / runs.length : 0,
        totals: {
          runs: runs.length,
          complete: complete.length,
          failed: failed.length,
          active: active.length,
        },
        catalogDrift: drift,
        staleSkills: staleSkills.slice(0, 20),
      };
    }

    case 'catalog:entitlements': {
      const args = z.object({
        groups: z.array(z.string()).optional(),
        requireSubscription: z.boolean().optional(),
      }).parse(params ?? {});
      const settings = deps.host.getSettings();
      const groups = args.groups
        ?? settings.sso?.lastLogin?.groups
        ?? [];
      const entries = catalogEntriesFromSettings(deps).filter((e) => e.published !== false);
      const subs = await readCatalogSubscriptions();
      const requireSub = args.requireSubscription === true;
      const entitlements = resolveCatalogEntitlements(
        entries,
        groups,
        requireSub ? subs.subscribedCatalogIds : undefined,
        { hasSsoSession: catalogHasSsoSession(deps) },
      );
      return {
        ok: true,
        groups,
        entitlements: entitlements.map((e) => ({
          catalogId: e.catalogId,
          entitled: e.entitled,
          reason: e.reason,
          entry: engramCatalogPublicEntry(e.entry),
          ...(e.missingGroups ? { missingGroups: e.missingGroups } : {}),
        })),
        subscribedCatalogIds: subs.subscribedCatalogIds,
        installedPackageIds: subs.installedPackageIds ?? [],
      };
    }

    case 'catalog:exportMdm': {
      if (!await hasTeamsOrEnterpriseAccess(deps)) {
        return {
          ok: false,
          reason: 'teams_or_enterprise_required',
          message: 'MDM export requires a Teams or Enterprise license.',
        };
      }
      const args = z.object({
        defaultSubscriptions: z.array(z.string().max(128)).max(64).optional(),
      }).parse(params ?? {});
      const entries = catalogEntriesFromSettings(deps);
      const settings = deps.host.getSettings();
      const packageIds = args.defaultSubscriptions
        ?? entries.filter((e) => e.published !== false).map((e) => e.packageId);
      const bundle = buildMdmEngramCatalogBundle(
        entries,
        settings.sso,
        packageIds,
        settings.compliance?.classificationSchema
          ? { classificationSchema: settings.compliance.classificationSchema }
          : undefined,
      );
      if (!bundle) {
        return {
          ok: false,
          reason: 'sso_not_configured',
          message: 'Configure Enterprise SSO (OIDC issuer + client ID) before exporting an MDM bundle.',
        };
      }
      return { ok: true, bundle };
    }

    case 'catalog:syncFromSharePoint': {
      if (!await hasTeamsOrEnterpriseAccess(deps)) {
        return {
          ok: false,
          reason: 'teams_or_enterprise_required',
          message: 'SharePoint catalog sync requires a Teams or Enterprise license.',
        };
      }
      const args = z.object({
        listUrl: z.string().max(2048).optional(),
        accessToken: z.string().max(4096).optional(),
      }).parse(params ?? {});
      const current = deps.host.getSettings();
      const prevCatalog = current.engramCatalog ?? { entries: [], version: 2 };
      const listUrl = args.listUrl?.trim() || prevCatalog.sharePoint?.listUrl?.trim();
      if (!listUrl) {
        return {
          ok: false,
          reason: 'missing_url',
          message: 'SharePoint list URL is required.',
        };
      }
      const accessToken = args.accessToken?.trim() || prevCatalog.sharePoint?.accessToken;
      const { fetchSharePointCatalogEntries } = await import('./catalog-sharepoint.js');
      const sync = await fetchSharePointCatalogEntries(
        listUrl,
        prevCatalog.entries ?? [],
        accessToken,
      );
      const nextSharePoint = sync.ok
        ? {
          listUrl,
          ...(accessToken ? { accessToken } : {}),
          lastSyncedAt: sync.syncedAt,
          lastSyncEntryCount: sync.entries.length,
        }
        : {
          listUrl,
          ...(accessToken ? { accessToken } : {}),
          lastSyncedAt: sync.syncedAt,
          lastSyncError: sync.message ?? sync.reason ?? 'Sync failed',
        };
      if (sync.ok) {
        await deps.host.setSettings({
          ...current,
          engramCatalog: sanitizeEngramCatalogSettings({
            entries: sync.entries,
            version: 2,
            sharePoint: nextSharePoint,
          }) ?? { entries: sync.entries, version: 2, sharePoint: nextSharePoint },
        });
      } else {
        await deps.host.setSettings({
          ...current,
          engramCatalog: sanitizeEngramCatalogSettings({
            ...prevCatalog,
            sharePoint: nextSharePoint,
          }) ?? { ...prevCatalog, sharePoint: nextSharePoint },
        });
      }
      return {
        ok: sync.ok,
        ...(sync.message ? { message: sync.message } : {}),
        ...(sync.reason ? { reason: sync.reason } : {}),
        entryCount: sync.entries.length,
        lastSyncedAt: sync.syncedAt,
        usedCache: !sync.ok,
      };
    }

    case 'catalog:importMdmBundle': {
      const args = z.object({
        bundlePath: z.string().min(1).max(4096).optional(),
        bundle: z.object({
          sso: z.object({
            issuer: z.string().min(1),
            clientId: z.string().min(1),
            tenantId: z.string().optional(),
          }),
          defaultSubscriptions: z.array(z.string()),
          compliance: z.object({
            classificationSchema: z.unknown(),
          }).optional(),
        }).optional(),
        mergeSsoHints: z.boolean().optional(),
      }).parse(params ?? {});
      const { readMdmBundleFile, importMdmCatalogBundle, mergeMdmSsoHints, DEFAULT_MDM_BUNDLE_PATH } = await import('./catalog-mdm.js');
      let bundlePath = args.bundlePath?.trim();
      let bundle = bundlePath ? await readMdmBundleFile(bundlePath) : null;
      if (!bundle && args.bundle) {
        const inlineSchema = args.bundle.compliance?.classificationSchema
          ? sanitizeClassificationSchema(args.bundle.compliance.classificationSchema)
          : undefined;
        bundle = {
          sso: {
            issuer: args.bundle.sso.issuer.trim(),
            clientId: args.bundle.sso.clientId.trim(),
            ...(args.bundle.sso.tenantId?.trim() ? { tenantId: args.bundle.sso.tenantId.trim() } : {}),
          },
          defaultSubscriptions: args.bundle.defaultSubscriptions.map((p) => p.trim()).filter(Boolean),
          ...(inlineSchema ? { compliance: { classificationSchema: inlineSchema } } : {}),
        };
        await fs.mkdir(path.dirname(DEFAULT_MDM_BUNDLE_PATH), { recursive: true, mode: 0o700 });
        await fs.writeFile(DEFAULT_MDM_BUNDLE_PATH, JSON.stringify(bundle, null, 2), { encoding: 'utf8', mode: 0o600 });
        bundlePath = DEFAULT_MDM_BUNDLE_PATH;
      }
      if (!bundle || !bundlePath) {
        return {
          ok: false,
          reason: 'invalid_bundle',
          message: 'MDM bundle JSON is invalid (need sso.issuer, sso.clientId, defaultSubscriptions).',
        };
      }
      await importMdmCatalogBundle(bundlePath, bundle);
      if (args.mergeSsoHints === true || bundle.compliance?.classificationSchema
        || bundle.catalogEntries?.length || bundle.catalogOverrides) {
        await mergeMdmSsoHints(deps.host, bundle);
      }
      return {
        ok: true,
        defaultSubscriptions: bundle.defaultSubscriptions,
        bundlePath,
        message: `Imported MDM bundle with ${bundle.defaultSubscriptions.length} default subscription${bundle.defaultSubscriptions.length === 1 ? '' : 's'}.`,
      };
    }

    case 'catalog:applyMdmAutoInstall': {
      const { applyMdmAutoInstall } = await import('./catalog-mdm.js');
      const result = await applyMdmAutoInstall(deps.host, async (entry) => {
        const installed = await installCatalogPackage(deps, entry);
        return installed.ok ? { ok: true as const } : { ok: false as const };
      }, deps);
      const store = await readCatalogSubscriptions();
      return {
        ...result,
        subscribedCatalogIds: store.subscribedCatalogIds,
        installedPackageIds: store.installedPackageIds ?? [],
      };
    }

    case 'sharing:list': {
      // Returns all active sharing tokens. Token IDs (the bearer values) are
      // included so the UI can display them for copy-paste. The tokens are
      // stored encrypted at rest inside the cortex; this IPC call is only
      // reachable after the cortex is unlocked.
      const settings = deps.host.getSettings();
      const tokens = settings.sharing?.tokens ?? [];
      const now = Date.now();
      return tokens.map((t) => ({
        id: t.id,
        name: t.name,
        role: t.scope.role,
        engrams: t.scope.engrams,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt ?? null,
        expired: t.expiresAt !== undefined && t.expiresAt < now,
      }));
    }

    case 'sharing:create': {
      // Create a new scoped sharing token. Free users are limited to 1 active
      // token; Pro / Teams / Enterprise are unlimited. Generates a random UUID
      // as the bearer token value; stored in settings and returned once for copy-paste.
      const args = z.object({
        name: z.string().min(1).max(80),
        role: z.enum(SHARING_TOKEN_ROLES as unknown as [SharingRole, ...SharingRole[]]),
        engrams: z.union([z.array(z.string().min(1)), z.literal('*')]),
        expiresAt: z.number().optional(), // Unix ms; absent = never
      }).parse(params ?? {});

      const enterpriseRoles = new Set<SharingRole>(['skill-train', 'admin-audit']);
      if (enterpriseRoles.has(args.role)) {
        const licenseToken = await getEffectiveLicenseToken(deps);
        if (!(deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false)) {
          return {
            ok: false,
            reason: 'enterprise_required',
            message: 'Skill trainer and admin/audit roles require an Enterprise license.',
          };
        }
      }

      // ── Token limit enforcement ────────────────────────────────────────────
      // Free: 1 token. Any paid plan (Pro / Teams / Enterprise / domain-
      // seat OTP allowance): unlimited. `hasAnyPaidPlan` accepts
      // domain-seat tokens with no explicit features so OTP-minted
      // enterprise users aren't capped at 1 share.
      const hasPaidPlan = await hasAnyPaidPlan(deps);
      const current = deps.host.getSettings();
      const existing = current.sharing?.tokens ?? [];
      const now = Date.now();
      const activeCount = existing.filter((t) => t.expiresAt === undefined || t.expiresAt >= now).length;
      const seatCap = hasPaidPlan ? null : 1; // null = unlimited
      if (seatCap !== null && activeCount >= seatCap) {
        return {
          ok: false,
          reason: 'seat_limit',
          message: 'Free plan includes 1 share. Upgrade to Pro for unlimited shares.',
          seats: seatCap,
          activeCount,
        };
      }

      const newToken = {
        id: randomUUID(),
        name: args.name,
        scope: {
          engrams: args.engrams as string[] | '*',
          role: args.role as import('@graphnosis-app/core/settings').SharingRole,
        },
        createdAt: now,
        ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
      };

      await deps.host.setSettings({
        ...current,
        sharing: { tokens: [...existing, newToken] },
      });

      return {
        ok: true,
        id: newToken.id,
        name: newToken.name,
        role: newToken.scope.role,
        engrams: newToken.scope.engrams,
        createdAt: newToken.createdAt,
        expiresAt: (newToken as { expiresAt?: number }).expiresAt ?? null,
      };
    }

    case 'sharing:planInfo': {
      // Returns seat cap + active count so the UI can show seat usage.
      // Free: 1 token. Any paid plan (Pro/Teams/Enterprise/domain-seat
      // OTP): unlimited (seats=null). hasAnyPaidPlan accepts
      // domain-seat tokens regardless of their feature list.
      const licenseToken = await getEffectiveLicenseToken(deps);
      const payload = deps.licenseValidator?.verifyToken(licenseToken ?? '') ?? null;
      const hasPaidPlan = await hasAnyPaidPlan(deps);
      const settings = deps.host.getSettings();
      const tokens = settings.sharing?.tokens ?? [];
      const now = Date.now();
      const activeCount = tokens.filter((t) => t.expiresAt === undefined || t.expiresAt >= now).length;
      // Enterprise badge: explicit feature OR a domain-seat token (org-
      // managed allowlist is by definition enterprise tier).
      const hasExplicitEnterprise = payload?.features.includes('enterprise') ?? false;
      const hasDomainSeat = (settings.domainSeatLicenseToken ?? null) !== null
        && deps.licenseValidator?.verifyToken(settings.domainSeatLicenseToken ?? '') !== null
        && deps.licenseValidator?.verifyToken(settings.domainSeatLicenseToken ?? '') !== undefined;
      return {
        licensed: true,
        enterprise: hasExplicitEnterprise || hasDomainSeat,
        plan: payload?.plan ?? null,
        seats: hasPaidPlan ? null : 1,
        activeCount,
      };
    }

    case 'sharing:sessions': {
      // Returns active MCP sessions grouped by sharing token ID.
      // Used by the Team Admin panel to show per-token active connections.
      const byToken = mcpRegistry.listByToken();
      const result: Record<string, { connectedAt: number; lastActivityAt: number; clientName?: string }[]> = {};
      for (const [tokenId, conns] of byToken.entries()) {
        if (tokenId === null) continue; // owner sessions — not attributed to a sharing token
        result[tokenId] = conns.map((c) => ({
          connectedAt: c.connectedAt,
          lastActivityAt: c.lastActivityAt,
          ...(c.clientName ? { clientName: c.clientName } : {}),
        }));
      }
      return result;
    }

    case 'sharing:revoke': {
      // Remove a sharing token by ID. Active sessions using this token are
      // not forcibly closed (they stay open until they time out or disconnect)
      // but new sessions with this token are rejected immediately.
      const args = z.object({ id: z.string().min(1) }).parse(params ?? {});
      const current = deps.host.getSettings();
      const before = current.sharing?.tokens ?? [];
      const after = before.filter((t) => t.id !== args.id);
      if (after.length === before.length) return { ok: false, reason: 'not_found' };
      await deps.host.setSettings({
        ...current,
        sharing: { tokens: after },
      });
      return { ok: true };
    }

    case 'engram.export': {
      // Export an engram to a base64-encoded .gez pack.
      // Gated behind Pro (sharing feature).
      const args = z.object({
        engramId: z.string().min(1),
        sign: z.boolean().optional(),
      }).parse(params ?? {});

      if (!deps.host.listGraphs().includes(args.engramId)) {
        return { ok: false, reason: 'not_found', message: `Engram "${args.engramId}" not found.` };
      }

      // Engram Pack export is a paid-plan feature, but the historical
      // gate only checked the 'teams' feature flag — that locked out
      // Pro users AND Enterprise OTP domain-seat users (whose tokens
      // can have no explicit features). hasAnyPaidPlan accepts every
      // paid path so the error message and the gate finally agree.
      if (!(await hasAnyPaidPlan(deps))) {
        return {
          ok: false, reason: 'not_licensed',
          message: 'Engram Pack export requires a Graphnosis Pro, Teams, or Enterprise subscription. Visit https://graphnosis.com/upgrade',
        };
      }

      const { exportEngram, getOrCreateGezSigningKeyHex } = await import('./engram-pack.js');
      const shouldSign = args.sign !== false;
      let signingKeyHex: string | undefined;
      if (shouldSign && deps.cortexDir) {
        try { signingKeyHex = await getOrCreateGezSigningKeyHex(deps.cortexDir); } catch { /* unsigned */ }
      }

      const meta = deps.host.getGraphMetadata(args.engramId) ?? {};
      const exportOpts: import('./engram-pack.js').ExportEngramOptions = {
        exportedBy: (meta as any).displayName ?? args.engramId,
      };
      if (signingKeyHex !== undefined) exportOpts.signingKeyHex = signingKeyHex;
      const result = await exportEngram(deps.host, args.engramId, exportOpts);

      return {
        ok: true,
        packBase64: result.pack.toString('base64'),
        sourceCount: result.sourceCount,
        signed: result.signed,
        engramDisplayName: (meta as any).displayName ?? args.engramId,
      };
    }

    case 'engram.import': {
      // Import a .gez pack into the local cortex.
      const args = z.object({
        packBase64: z.string().min(1),
        targetEngramId: z.string().optional(),
        skipExisting: z.boolean().optional(),
      }).parse(params ?? {});

      // Same gate fix as export — see hasAnyPaidPlan comment above.
      if (!(await hasAnyPaidPlan(deps))) {
        return {
          ok: false, reason: 'not_licensed',
          message: 'Engram Pack import requires a Graphnosis Pro, Teams, or Enterprise subscription. Visit https://graphnosis.com/upgrade',
        };
      }

      let packBuffer: Buffer;
      try {
        packBuffer = Buffer.from(args.packBase64, 'base64');
      } catch {
        return { ok: false, reason: 'invalid_pack', message: 'Invalid base64 data.' };
      }

      const { importEngram } = await import('./engram-pack.js');
      const importOpts: import('./engram-pack.js').ImportEngramOptions = {
        skipExisting: args.skipExisting !== false,
        withEmbedding: (fn) => withEmbedding(fn),
      };
      if (args.targetEngramId !== undefined) importOpts.targetEngramId = args.targetEngramId;
      const { result, payload } = await importEngram(deps.host, packBuffer, importOpts);

      return {
        ok: true,
        result,
        sourceEngramId: payload.engramId,
        sourceEngramName: payload.engramDisplayName,
        exportedBy: payload.exportedBy,
        exportedAt: payload.exportedAt,
      };
    }

    case 'engram.exportSigningKey': {
      // Returns the base64-encoded public key of this cortex's GEZ signing key.
      // Used by the UI to show the "verify this pack came from me" fingerprint.
      if (!deps.cortexDir) return { ok: false, reason: 'no_cortex_dir' };
      const { getOrCreateGezSigningKeyHex } = await import('./engram-pack.js');
      const keyHex = await getOrCreateGezSigningKeyHex(deps.cortexDir);
      const sodium = await import('libsodium-wrappers-sumo');
      await sodium.default.ready;
      const sk = Buffer.from(keyHex, 'hex');
      const pubKey = sk.subarray(32);
      return { ok: true, publicKeyB64: pubKey.toString('base64') };
    }

    case 'audit.mcp.list': {
      const a = z.object({
        since: z.number().int().nonnegative().optional(),
        until: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(10000).optional(),
        client: z.string().optional(),
        tool: z.string().optional(),
        tools: z.array(z.string()).optional(),
        engram: z.string().optional(),
      }).parse(params ?? {});
      const limit = a.limit ?? 500;

      let events = await deps.host.listMcpAuditEvents();
      if (a.since !== undefined) events = events.filter((ev) => ev.ts >= a.since!);
      if (a.until !== undefined) events = events.filter((ev) => ev.ts <= a.until!);
      if (a.engram !== undefined) {
        events = events.filter((ev) => ev.engramIds?.includes(a.engram!) ?? false);
      }
      if (a.client) events = events.filter((ev) => ev.clientId === a.client);
      if (a.tool) events = events.filter((ev) => ev.tool === a.tool);
      if (a.tools !== undefined && a.tools.length > 0) {
        const set = new Set(a.tools);
        events = events.filter((ev) => set.has(ev.tool));
      }

      const clientSet = new Set<string>();
      const toolSet = new Set<string>();
      for (const ev of events) {
        clientSet.add(ev.clientId);
        toolSet.add(ev.tool);
      }
      const clients = [...clientSet].sort((x, y) => x.localeCompare(y));
      const tools = [...toolSet].sort((x, y) => x.localeCompare(y));

      events = events.slice().sort((x, y) => y.ts - x.ts);
      const hasMore = events.length > limit;
      events = events.slice(0, limit);

      return { events, clients, tools, hasMore };
    }

    case 'audit.export': {
      // Returns op-log events for SIEM/audit export. Enterprise-gated.
      // Query params (all optional): since (Unix ms), until (Unix ms), engram (graphId).
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      if (!hasEnterprise) {
        return { ok: false, reason: 'not_licensed', message: 'Audit log export requires an Enterprise license.' };
      }
      const a = z.object({
        since: z.number().optional(),
        until: z.number().optional(),
        engram: z.string().optional(),
      }).parse(params ?? {});

      let events = await deps.host.listOplogEvents();
      if (a.since !== undefined) events = events.filter((ev) => ev.ts >= a.since!);
      if (a.until !== undefined) events = events.filter((ev) => ev.ts <= a.until!);
      if (a.engram !== undefined) events = events.filter((ev) => ev.graphId === a.engram);
      events = events.slice().sort((x, y) => x.ts - y.ts);

      let mcpEvents = await deps.host.listMcpAuditEvents();
      if (a.since !== undefined) mcpEvents = mcpEvents.filter((ev) => ev.ts >= a.since!);
      if (a.until !== undefined) mcpEvents = mcpEvents.filter((ev) => ev.ts <= a.until!);
      if (a.engram !== undefined) {
        mcpEvents = mcpEvents.filter((ev) =>
          ev.engramIds?.includes(a.engram!) ?? false,
        );
      }
      mcpEvents = mcpEvents.slice().sort((x, y) => x.ts - y.ts);

      return { ok: true, count: events.length, events, mcpCount: mcpEvents.length, mcpEvents };
    }

    case 'compliance.get': {
      const licenseToken = await getEffectiveLicenseToken(deps);
      const enterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      const settings = deps.host.getSettings();
      return {
        ok: true,
        enterprise,
        compliance: settings.compliance ?? { enabled: false },
      };
    }

    case 'compliance.save': {
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      if (!hasEnterprise) {
        return { ok: false, reason: 'not_licensed', message: 'Compliance settings require an Enterprise license.' };
      }
      const args = z.object({
        enabled: z.boolean().optional(),
        defaultRetentionTtlMs: z.number().int().positive().nullable().optional(),
        defaultExportBeforePurge: z.boolean().optional(),
      }).parse(params ?? {});
      const prev = deps.host.getSettings().compliance ?? { enabled: false };
      const next = {
        enabled: args.enabled !== undefined ? args.enabled : prev.enabled,
        ...(args.defaultRetentionTtlMs === null
          ? {}
          : args.defaultRetentionTtlMs !== undefined
            ? { defaultRetentionTtlMs: args.defaultRetentionTtlMs }
            : prev.defaultRetentionTtlMs !== undefined
              ? { defaultRetentionTtlMs: prev.defaultRetentionTtlMs }
              : {}),
        ...(args.defaultExportBeforePurge !== undefined
          ? { defaultExportBeforePurge: args.defaultExportBeforePurge }
          : prev.defaultExportBeforePurge !== undefined
            ? { defaultExportBeforePurge: prev.defaultExportBeforePurge }
            : {}),
        ...(prev.lastRetentionDryRunAt !== undefined ? { lastRetentionDryRunAt: prev.lastRetentionDryRunAt } : {}),
        ...(prev.classificationSchema ? { classificationSchema: prev.classificationSchema } : {}),
      };
      await deps.host.setSettings({ compliance: next });
      return { ok: true, compliance: deps.host.getSettings().compliance };
    }

    case 'compliance.getClassificationSchema': {
      const licenseToken = await getEffectiveLicenseToken(deps);
      const enterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      const schema = deps.host.complianceSchema();
      return { ok: true, enterprise, schema: schema ?? { enabled: false, labels: [] } };
    }

    case 'compliance.setClassificationSchema': {
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      if (!hasEnterprise) {
        return { ok: false, reason: 'not_licensed', message: 'Classification schema requires an Enterprise license.' };
      }
      const args = z.object({
        enabled: z.boolean(),
        labels: z.array(z.object({
          id: z.string().min(1).max(64),
          displayName: z.string().min(1).max(64),
          color: z.string().min(1).max(32),
          internalTier: z.enum(['public', 'personal', 'sensitive']),
          userAssignable: z.boolean().optional(),
          enabled: z.boolean().optional(),
          capOverrides: z.object({
            maxTokens: z.number().int().positive().optional(),
            maxNodes: z.number().int().positive().optional(),
          }).optional(),
        })).max(32),
        defaultEngramLabel: z.string().max(64).nullable().optional(),
      }).parse(params ?? {});
      const schema = sanitizeClassificationSchema({
        enabled: args.enabled,
        labels: args.labels,
        ...(args.defaultEngramLabel ? { defaultEngramLabel: args.defaultEngramLabel } : {}),
      });
      if (!schema) {
        return { ok: false, reason: 'invalid_schema', message: 'Classification schema is invalid.' };
      }
      const prev = deps.host.getSettings().compliance ?? { enabled: false };
      await deps.host.setSettings({
        compliance: {
          enabled: prev.enabled === true,
          ...(prev.defaultRetentionTtlMs !== undefined ? { defaultRetentionTtlMs: prev.defaultRetentionTtlMs } : {}),
          ...(prev.defaultExportBeforePurge !== undefined ? { defaultExportBeforePurge: prev.defaultExportBeforePurge } : {}),
          ...(prev.lastRetentionDryRunAt !== undefined ? { lastRetentionDryRunAt: prev.lastRetentionDryRunAt } : {}),
          classificationSchema: schema,
        },
      });
      return { ok: true, schema: deps.host.complianceSchema() };
    }

    case 'graphs.updateCompliance': {
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      if (!hasEnterprise) {
        return { ok: false, reason: 'not_licensed', message: 'Per-engram compliance fields require Enterprise.' };
      }
      const args = z.object({
        graphId: z.string(),
        retentionTtlMs: z.number().int().positive().nullable().optional(),
        retentionExportBeforePurge: z.boolean().optional(),
        industryTags: z.array(z.string().max(64)).max(16).nullable().optional(),
        classificationLabelId: z.string().max(64).nullable().optional(),
      }).parse(params);
      await deps.host.updateGraphComplianceFields(args.graphId, {
        ...(args.retentionTtlMs !== undefined ? { retentionTtlMs: args.retentionTtlMs } : {}),
        ...(args.retentionExportBeforePurge !== undefined ? { retentionExportBeforePurge: args.retentionExportBeforePurge } : {}),
        ...(args.industryTags !== undefined ? { industryTags: args.industryTags } : {}),
      });
      if (args.classificationLabelId !== undefined) {
        await deps.host.setGraphClassificationLabel(args.graphId, args.classificationLabelId);
      }
      return { ok: true };
    }

    case 'compliance.setEngramPreserve': {
      const args = z.object({
        graphId: z.string(),
        preserved: z.boolean(),
        matter: z.string().optional(),
      }).parse(params);
      await deps.host.setEngramPreserve(args.graphId, args.preserved, args.matter);
      return { ok: true };
    }

    case 'compliance.setSourceLegalHold': {
      const args = z.object({
        graphId: z.string(),
        sourceId: z.string(),
        held: z.boolean(),
        matter: z.string().optional(),
      }).parse(params);
      await deps.host.setSourceLegalHold(args.graphId, args.sourceId, args.held, args.matter);
      return { ok: true };
    }

    case 'compliance.exportEvidencePack': {
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      if (!hasEnterprise) {
        return { ok: false, reason: 'not_licensed', message: 'Evidence Pack export requires an Enterprise license.' };
      }
      if (!deps.cortexDir) return { ok: false, reason: 'no_cortex_dir' };
      const args = z.object({
        since: z.number().optional(),
        until: z.number().optional(),
        engram: z.string().optional(),
      }).parse(params ?? {});
      const { buildSignedEvidencePack } = await import('./compliance.js');
      const signed = await buildSignedEvidencePack(deps.host, deps.cortexDir, {
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.until !== undefined ? { until: args.until } : {}),
        ...(args.engram !== undefined ? { engram: args.engram } : {}),
      });
      return { ok: true, pack: signed.pack, manifestHash: signed.manifestHash, signatures: signed.signatures, detachedSig: signed.detachedSig };
    }

    case 'compliance.recallAsOf': {
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      if (!hasEnterprise) {
        return { ok: false, reason: 'not_licensed', message: 'Point-in-time recall preview requires Enterprise.' };
      }
      const args = z.object({
        query: z.string().min(1),
        graphId: z.string().optional(),
        asOfSeq: z.number().int().nonnegative().optional(),
        asOfTs: z.number().int().nonnegative().optional(),
        maxNodes: z.number().int().min(1).max(50).optional(),
      }).parse(params ?? {});
      const { recallAsOf } = await import('./compliance.js');
      const result = await recallAsOf(deps.host, args.query, {
        ...(args.graphId ? { graphId: args.graphId } : {}),
        ...(args.asOfSeq !== undefined ? { asOfSeq: args.asOfSeq } : {}),
        ...(args.asOfTs !== undefined ? { asOfTs: args.asOfTs } : {}),
        ...(args.maxNodes !== undefined ? { maxNodes: args.maxNodes } : {}),
      });
      return { ok: true, result };
    }

    case 'compliance.runRetention': {
      const licenseToken = await getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      if (!hasEnterprise) {
        return { ok: false, reason: 'not_licensed', message: 'Retention purge requires an Enterprise license.' };
      }
      if (!deps.cortexDir) return { ok: false, reason: 'no_cortex_dir' };
      const args = z.object({ dryRun: z.boolean().optional() }).parse(params ?? {});
      const { runRetentionPurge } = await import('./compliance.js');
      const result = await runRetentionPurge(deps.host, deps.cortexDir, args.dryRun === true);
      return { ok: true, ...result };
    }

    default:
      throw new Error(`Unknown IPC method: ${method}`);
  }
}
