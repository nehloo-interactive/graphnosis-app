import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';
import type { GraphnosisHost } from './host.js';
import { ingestFile, ingestWeb, ingestClip } from './ingest.js';
import { ingestGraphnosisDocs } from './docs-ingest.js';
import type { BroadcastRawFn } from './events.js';
import { mcpRegistry } from './mcp-registry.js';
import { applyCorrection as runApplyCorrection } from './correction.js';
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
          'team', 'compliance', 'onboarding',
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
          'team', 'compliance', 'onboarding',
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
          'team', 'compliance', 'onboarding',
        ]),
        displayName: z.string().min(1),
        text: z.string().min(1),
        label: z.string().default('Conversation note'),
        sourceKind: z.enum(['clip', 'ai-conversation']).optional(),
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
        'You are a precise research assistant working only with the snippets the user provides. ' +
        'Write a SINGLE paragraph (<= 90 words) that answers the user\'s question grounded ONLY in those snippets. ' +
        'After each claim, cite the snippet number in square brackets like [1], [2]. ' +
        'If the snippets do not answer the question, say so plainly — do not invent facts. ' +
        'No markdown headings, no lists, no preamble — just the paragraph.';
      const numbered = args.hits
        .map((h, i) => `[${i + 1}] ${h.text}${h.sourceFile ? ` (source: ${h.sourceFile})` : ''}`)
        .join('\n\n');
      const user = `Question: ${args.query}\n\nSnippets:\n${numbered}\n\nAnswer:`;
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
      // Re-link the re-ingested nodes across engrams immediately — don't wait
      // for the background cross-engram timer (could be hours away).
      deps.brainEngine?.runCrossEngramNow();
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
          inspectorDetail: z.enum(['simple', 'detailed']),
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
      if (parsed.ui) patch.ui = parsed.ui;
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
      const { LLM_CATALOG } = await import('./local-llm.js');
      // Resolved capability flags (with defaults applied) — UI uses these to
      // render the per-capability checkboxes under the master toggle without
      // having to know the default-on/default-off rules.
      const { resolveLlmCapabilities } = await import('@graphnosis-app/core').then(m => m.settings);
      const capabilities = resolveLlmCapabilities(settings);
      return {
        ollamaReachable, installedModels, activeModel,
        enabled: settings.ai.llmEnabled === true,
        capabilities,
        catalog: LLM_CATALOG,
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
        // Engram is present. Re-ingest only if it was last ingested under a
        // different app version — the docs site may have changed since.
        decision = docsState?.ingestedAppVersion !== appVersion ? 'reingest' : 'none';
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
        // Engram already exists (re-ingest after app update). Purge all
        // existing sources first so we replace, not duplicate. Each page
        // uses a stable `graphnosis-docs:<slug>` sourceRef — removing them
        // before re-ingesting keeps the engram clean regardless of whether
        // pages were added, removed, or renamed between releases.
        const existingSources = deps.host.listSources(DOCS_ENGRAM_ID);
        for (const src of existingSources) {
          await deps.host.forgetSource(DOCS_ENGRAM_ID, src.sourceId, {
            triggeredBy: 'user:ingest',
          });
        }
      } else {
        // Create the docs engram — mirror the create-then-set-metadata
        // pattern from graphs.createWithTemplate so it shows up in the
        // picker with a friendly name.
        await deps.host.createGraph(DOCS_ENGRAM_ID);
        await deps.host.setGraphMetadata(DOCS_ENGRAM_ID, {
          template: 'reading',
          displayName: 'Graphnosis Docs',
          createdAt: Date.now(),
        });
      }
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

    default:
      throw new Error(`Unknown IPC method: ${method}`);
  }
}
