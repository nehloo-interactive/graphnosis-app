import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';
import type { GraphnosisHost } from './host.js';
import { ingestFile, ingestWeb, ingestClip } from './ingest.js';
import { ingestGraphnosisDocs } from './docs-ingest.js';
import { BUNDLED_DOCS } from './docs-content.generated.js';
import { ingestBundledSkillDemos } from './skill-demos-ingest.js';
import { BUNDLED_SKILL_DEMOS } from './skill-demos.generated.js';
import type { BroadcastRawFn } from './events.js';
import { mcpRegistry } from './mcp-registry.js';
import { applyCorrection as runApplyCorrection, proposeCorrection } from './correction.js';
import {
  linkSkillSequence,
  linkSkillGoals,
  linkSkillLoopsAndBranches,
  linkSkillContextEdges,
  linkSkillCalls,
  walkSkillSequence,
  formatSkillForRecall,
  baseSkillName,
} from './skill-trainer.js';
import { SkillSnapshotStore } from './skill-snapshots.js';
import type { CorrectionDiff } from './correction.js';
import { oplog } from '@nehloo-interactive/graphnosis-secure-sync';
import { withEmbedding } from './embedding-queue.js';
import type { ConnectorManager } from './connectors/manager.js';
import { getConsentPhraseForTier } from './mcp-server.js';
import { revokeConsent } from '@graphnosis-app/core/settings';

// Local IPC between Tauri shell and Node sidecar. Newline-delimited JSON over a
// Unix-domain socket on macOS/Linux (Windows uses a named pipe — same socket API).
//
// Tauri sends requests like { id, method, params }; sidecar replies { id, result | error }.

const Request = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

/** Fixed slug for the engram holding the ingested Graphnosis documentation.
 *  Slug-like so it satisfies createGraph's filesystem-safety rules. */
const DOCS_ENGRAM_ID = 'graphnosis-docs';
// Stable id for the bundled skill demos engram. Stays in sync with the
// displayName 'Skill Demos' via setGraphMetadata at ingest time. The id is
// what every IPC + sidecar code path looks up (rename-safe); the display
// name is purely user-facing.
const SKILL_DEMOS_ENGRAM_ID = 'graphnosis-skill-demos';

// Cooperative cancellation handles for long-running operations. Each is a
// module-scope `AbortController | null` because only one of each operation
// can run at a time (we serialize via the running loop's existence — kicking
// off a new switch while one is in flight would replace the controller and
// the prior signal would never fire). The cancel IPC handlers call
// `.abort()` on these; the host loops poll between engrams and bail.
let currentEmbeddingSwitchAbort: AbortController | null = null;
let currentReingestAbort: AbortController | null = null;

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
}

/** Returns true when socketPath is a TCP address like "127.0.0.1:PORT". */
function isTcpAddress(socketPath: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(socketPath);
}

export async function startIpc(deps: IpcDeps): Promise<net.Server> {
  if (!isTcpAddress(deps.socketPath)) {
    await fs.mkdir(path.dirname(deps.socketPath), { recursive: true });
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
      server.listen(deps.socketPath, () => resolve(server));
    }
  });
}

/** Throws a user-facing error when the Studio subscription is not active. */
function assertStudioEnabled(_deps: IpcDeps): void {
  // bypassed — gate off during development
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

async function dispatch(deps: IpcDeps, method: string, params: unknown): Promise<unknown> {
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
      return withEmbedding(() => deps.host.searchNodes(args.graphId, args.query, args.k ?? 30));
    }
    case 'nodes.list': {
      const args = z.object({ graphId: z.string() }).parse(params);
      return deps.host.listNodes(args.graphId);
    }
    case 'edges.list': {
      const args = z.object({ graphId: z.string() }).parse(params);
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
      const nodes = rec.nodeIds
        .filter((id) => liveIds.has(id))
        .map((id) => ({
          id,
          content: deps.host.getFullNodeContent(args.graphId, id) ?? '',
        }))
        .filter((n) => n.content);
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
      // No filtering server-side; the UI is small enough to handle that
      // client-side and benefits from showing every event for "all" filter.
      const events = await deps.host.listOplogEvents();
      return { events };
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

      return {
        entries: page,
        total,
        hasMore: offset + limit < total,
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
      await deps.host.deleteGraph(args.graphId);
      // Purge in-memory ghost edges from the brain engine's live caches.
      // host.deleteGraph already cleaned the on-disk stores above.
      deps.brainEngine?.purgeDeletedGraph(args.graphId);
      return { ok: true };
    }
    case 'graphs.load': {
      const { graphId } = z.object({ graphId: z.string() }).parse(params);
      await deps.host.loadGraph(graphId);
      return { ok: true };
    }
    case 'ingest.file': {
      const { graphId, path: filePath } = z.object({ graphId: z.string(), path: z.string() }).parse(params);
      // Fire the ingest in the background so the IPC response returns
      // immediately — large PDFs easily exceed any sensible socket timeout.
      // Progress and completion are broadcast to the events socket so the
      // frontend can update its toast without waiting for a response.
      const jobId = `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const fileName = filePath.split('/').pop() ?? filePath;
      deps.broadcastRaw({
        kind: 'ingest.progress',
        name: 'ingest.progress',
        payload: { jobId, graphId, fileName, phase: 'parsing', nodesAdded: 0, edgesAdded: 0 },
      });
      // Run async — do not await.
      void (async () => {
        try {
          const result = await ingestFile(deps.host, graphId, filePath, {
            onProgress: (pagesProcessed, totalPages) => {
              deps.broadcastRaw({
                kind: 'ingest.progress',
                name: 'ingest.progress',
                payload: { jobId, graphId, fileName, phase: 'parsing', nodesAdded: 0, pagesProcessed, totalPages },
              });
            },
            onEmbeddingStart: (pagesExtracted) => {
              deps.broadcastRaw({
                kind: 'ingest.progress',
                name: 'ingest.progress',
                payload: { jobId, graphId, fileName, phase: 'embedding', nodesAdded: 0, pagesExtracted },
              });
            },
            onEmbeddingChunk: (chunksDone, chunksTotal, nodesTotal) => {
              deps.broadcastRaw({
                kind: 'ingest.progress',
                name: 'ingest.progress',
                payload: { jobId, graphId, fileName, phase: 'embedding', nodesAdded: nodesTotal, chunksDone, chunksTotal },
              });
            },
            // Serialize only the ONNX embedding step (fastembed/ort is not
            // concurrency-safe). PDF parsing runs outside the mutex so
            // per-page progress events fire even while another embedding
            // op is in flight.
            wrapIngest: (fn) => withEmbedding(fn),
            triggeredBy: 'user:ingest',
          });
          const nodeCount = (result as { nodeIds?: string[] }).nodeIds?.length ?? 0;
          deps.broadcastRaw({
            kind: 'ingest.done',
            name: 'ingest.done',
            payload: { jobId, graphId, fileName, nodeIds: (result as { nodeIds?: string[] }).nodeIds ?? [], nodesAdded: nodeCount },
          });
          // Fresh content may have introduced duplicates — let the brain
          // re-scan (debounced; a batch of files coalesces into one pass).
          deps.brainEngine?.notifyIngestComplete();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`[graphnosis-sidecar] background ingest failed for ${filePath}:`, e);
          deps.broadcastRaw({
            kind: 'ingest.done',
            name: 'ingest.done',
            payload: { jobId, graphId, fileName, error: message, nodesAdded: 0 },
          });
        }
      })();
      return { accepted: true, jobId };
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
    case 'sources.forget': {
      const { graphId, sourceId } = z.object({ graphId: z.string(), sourceId: z.string() }).parse(params);
      const result = await deps.host.forgetSource(graphId, sourceId, { triggeredBy: 'user:forget' });
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
    case 'settings.get': {
      return deps.host.getSettings();
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
         *  set — used by the UI to decide whether deleting the quarantined
         *  file is "safe" (recovery already done) or "risky" (would
         *  permanently lose the only copy). */
        liveEngramExists: boolean;
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
        out.push({ name, engramId, kind, timestamp, sizeBytes, liveEngramExists: liveIds.has(engramId) });
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
          }),
        }).optional(),
        brain: z.object({
          clipboardCapture: z.object({
            enabled: z.boolean(),
          }).optional(),
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
        };
      }
      if (parsed.mobile) {
        // Fill from current settings so partial updates don't lose fields.
        const currentBridge = deps.host.getSettings().mobile?.httpBridge;
        const inBridge = parsed.mobile.httpBridge;
        // Auto-generate a token when enabling the bridge for the first time.
        // The App UI reads it back from the returned settings and shows it to
        // the user exactly once so they can copy it into their mobile client.
        const token = inBridge.token
          || currentBridge?.token
          || (inBridge.enabled ? randomUUID() : '');
        patch.mobile = {
          httpBridge: {
            enabled: inBridge.enabled,
            port: inBridge.port ?? currentBridge?.port ?? 3457,
            host: inBridge.host ?? currentBridge?.host ?? '127.0.0.1',
            token,
            allowedOrigins: inBridge.allowedOrigins ?? currentBridge?.allowedOrigins ?? [],
          },
        };
      }
      if (parsed.brain) {
        const currentBrain = deps.host.getSettings().brain ?? {};
        patch.brain = {
          ...currentBrain,
          ...(parsed.brain.clipboardCapture !== undefined
            ? { clipboardCapture: parsed.brain.clipboardCapture }
            : {}),
        };
      }
      return deps.host.setSettings(patch);
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
      const sub = await withEmbedding(() => deps.host.recall(query, {
        budget: { maxTokens: maxTokens ?? 2000, maxNodes: maxNodes ?? 20 },
      }));
      return {
        prompt: sub.prompt,
        tokensUsed: sub.tokensUsed,
        nodesIncluded: sub.nodesIncluded,
        byGraph: Object.fromEntries(sub.byGraph),
        audit: sub.audit,
      };
    }
    // ── Connector IPC ────────────────────────────────────────────────────────
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
      return {
        enabled: bridge?.enabled ?? false,
        host: bridge?.host ?? '127.0.0.1',
        port: bridge?.port ?? 3457,
        token: bridge?.token ?? '',
        localIps,
        tailscaleIp,
      };
    }

    // ── Alive Brain IPC ──────────────────────────────────────────────────────

    case 'brain:getVitality': {
      // Null (not a fabricated 0) when the brain isn't ready yet — lets the
      // UI keep a neutral "computing…" ring instead of showing a real-
      // looking vitality of 0.
      if (!deps.brainEngine) return null;
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
      // Used by the Non-Deterministic Aid → predicted edges review surface.
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

    case 'docs:checkOffer': {
      const { appVersion } = z.object({ appVersion: z.string() }).parse(params ?? {});
      const settings = deps.host.getSettings();
      const exists = deps.host.listGraphs().includes(DOCS_ENGRAM_ID);
      const docsState = settings.docsEngram;
      let decision: 'offer' | 'reingest' | 'none';
      if (exists) {
        // Engram is present. Re-ingest if:
        //  (a) app version changed — docs content may have changed, OR
        //  (b) source count is below the number of bundled doc pages — this
        //      catches partial losses caused by interrupted reingest operations
        //      (forgetSource succeeds, re-ingest fails → source permanently gone).
        const sourceCount = deps.host.listSources(DOCS_ENGRAM_ID).length;
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
      const docsExists = deps.host.listGraphs().includes(DOCS_ENGRAM_ID);
      if (docsExists) {
        // Wipe the entire docs engram and recreate it from scratch. A simple
        // forgetSource loop is insufficient: previous partial ingests (failed
        // mid-way due to IPC timeouts or crashes) can leave "orphan" active
        // nodes in the graph whose source records were never saved. Those
        // nodes stay confidence=0.9 across restarts, their content hashes
        // land in the dedup set, and every subsequent ingest of the same
        // content produces 0 new nodes → host.ingest throws → only the
        // subset that didn't orphan ever succeeds. Deleting + recreating the
        // engram guarantees a completely clean slate with no orphan nodes.
        await deps.host.deleteGraph(DOCS_ENGRAM_ID);
      }
      // (Re-)create the docs engram with the same stable metadata.
      await deps.host.createGraph(DOCS_ENGRAM_ID);
      await deps.host.setGraphMetadata(DOCS_ENGRAM_ID, {
        template: 'reading',
        displayName: 'Graphnosis Docs',
        createdAt: Date.now(),
      });
      const { ingested, failed } = await withEmbedding(() =>
        ingestGraphnosisDocs(deps.host, DOCS_ENGRAM_ID),
      );
      // Record the app version we ingested under so a future app update
      // triggers a re-ingest. Clearing `declined` is intentional: if the
      // user previously declined and later ingested anyway, they no longer
      // count as declined. setSettings deep-merges this partial.
      await deps.host.setSettings({
        docsEngram: { declined: false, ingestedAppVersion: appVersion },
      });
      return { ingested, failed };
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
        // Each bundled .gsk pack contributes 2 skills (English + Romanian
        // variants), so the expected source count is 2 × pack count.
        const expectedSources = BUNDLED_SKILL_DEMOS.length * 2;
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
      const { appVersion } = z.object({ appVersion: z.string() }).parse(params ?? {});
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
        ingestBundledSkillDemos(deps.host, SKILL_DEMOS_ENGRAM_ID, deps.licenseValidator ?? undefined),
      );
      await deps.host.setSettings({
        skillDemosEngram: { declined: false, ingestedAppVersion: appVersion },
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

      if (args.displayMaxNodes !== undefined) {
        // Slider adjustment: single focused call, no allCandidates returned
        // (frontend already holds the full candidate list from the initial call).
        const sub = await withEmbedding(() => deps.host.recall(args.query, {
          budget: { maxTokens: args.maxTokens ?? 3000, maxNodes: args.displayMaxNodes! },
          skipEnrichment: true,
          ...scopeOpts,
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
        const licenseToken = await deps.host.getLicenseToken();
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
        return { neighbors: [], error: 'GNN not enabled. Enable it in Non-Deterministic Aid → Neural Network.' };
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
      // Deterministic Phase 1 — surface relevant memories for a skill without
      // running the LLM. Returns the full subgraph + ranked influential nodes
      // so the Skills panel can show what will be used before training starts.
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
      const licenseToken = await deps.host.getLicenseToken();
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
        const licenseToken = await deps.host.getLicenseToken();
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

    case 'skill:get': {
      // Full skill detail — includes the trained text. Called when the user
      // opens a row from the library into the Trainer column.
      const args = z.object({
        graphId: z.string().min(1),
        sourceId: z.string().min(1),
      }).parse(params ?? {});
      if (!deps.skillTrainer) return null;
      return deps.skillTrainer.getSkill(args.graphId, args.sourceId);
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

    case 'skill:acceptProposal': {
      // Promote a pending retrain proposal: ingest its trained text as the
      // new current version of the skill, then clear the pending entry.
      // Same Pro gate as set-config — only Pro users can have a queue,
      // so accepting one without a license shouldn't be possible, but
      // we re-check defensively.
      const args = z.object({ sourceId: z.string().min(1) }).parse(params ?? {});
      const licenseToken = await deps.host.getLicenseToken();
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

      const licenseToken = await deps.host.getLicenseToken();
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
      const walked = walkSkillSequence(deps.host, args.graphId, args.sourceId, { recursive: args.recursive });
      // Lazy back-fill: run loop detection for skills that predate this feature.
      if (walked.loops.length === 0 && walked.branches.length === 0 && walked.steps.length >= 3) {
        void linkSkillLoopsAndBranches(deps.host, args.graphId, args.sourceId).catch(() => {});
      }
      return walked;
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
  // skill:buildContext (ungated recall) and assembles the trained text on
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
  //   - baseSkillName(label): strips "(trained YYYY-MM-DD)" suffix
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

    // Wipe the source and rename so the new train date shows in the
    // Sources panel.
    await deps.host.clearSourceNodes(args.graphId, existing.sourceId, {
      triggeredBy: 'ipc:skill:saveFallback:in-place',
      reason: 'pre-retrain clear (snapshot saved)',
    });
    const newRef = `skill:${ts}:${baseName}`;
    await deps.host.renameSource(args.graphId, existing.sourceId, newRef, {
      triggeredBy: 'ipc:skill:saveFallback:in-place',
    });
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
        const provenanceComment = `<!-- imported ${new Date().toISOString()} · pack:${payload.id} v${payload.version} · ${payload.kind} · verified:${verified} · author:${payload.author} -->`;

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

    case 'license:status': {
      // Read-only summary of the currently-stored license. Used by the
      // Skills tab's "your subscription" chip and Settings → License panel
      // to render plan / expiry / features without re-decoding the token
      // on the frontend.
      const token = await deps.host.getLicenseToken();
      if (!token) {
        return { present: false };
      }
      const payload = deps.licenseValidator?.verifyToken(token) ?? null;
      if (!payload) {
        return { present: true, valid: false };
      }
      const expiresAt = payload.exp * 1000;
      return {
        present: true,
        valid: true,
        plan: payload.plan,
        features: payload.features,
        sub: payload.sub,
        expiresAt,
        expiringSoon: deps.licenseValidator?.isExpiringSoon(token) ?? false,
      };
    }

    case 'skill:checkLicenseExpiry': {
      // Returns expiry info for the renewal reminder banner.
      // Non-null only when a valid token is present and expiring soon.
      const licenseToken = await deps.host.getLicenseToken();
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

    default:
      throw new Error(`Unknown IPC method: ${method}`);
  }
}
