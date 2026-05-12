import net from 'node:net';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { GraphnosisHost } from './host.js';
import { ingestFile, ingestWeb, ingestClip } from './ingest.js';

// Local IPC between Tauri shell and Node sidecar. Newline-delimited JSON over a
// Unix-domain socket on macOS/Linux (Windows uses a named pipe — same socket API).
//
// Tauri sends requests like { id, method, params }; sidecar replies { id, result | error }.

const Request = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

export interface IpcDeps {
  host: GraphnosisHost;
  socketPath: string;
}

export async function startIpc(deps: IpcDeps): Promise<net.Server> {
  await fs.mkdir(path.dirname(deps.socketPath), { recursive: true });
  await fs.rm(deps.socketPath, { force: true });

  const server = net.createServer((sock) => {
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
          sock.write(JSON.stringify({ id: req.id, result }) + '\n');
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
    server.listen(deps.socketPath, () => resolve(server));
  });
}

async function dispatch(deps: IpcDeps, method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'graphs.list': return deps.host.listGraphs();
    case 'graphs.create': {
      const { graphId } = z.object({ graphId: z.string() }).parse(params);
      await deps.host.createGraph(graphId);
      return { ok: true };
    }
    case 'graphs.load': {
      const { graphId } = z.object({ graphId: z.string() }).parse(params);
      await deps.host.loadGraph(graphId);
      return { ok: true };
    }
    case 'ingest.file': {
      const { graphId, path: filePath } = z.object({ graphId: z.string(), path: z.string() }).parse(params);
      return ingestFile(deps.host, graphId, filePath);
    }
    case 'ingest.web': {
      const args = z.object({
        graphId: z.string(),
        url: z.string().url(),
        html: z.string().optional(),
        selection: z.string().optional(),
      }).parse(params);
      return ingestWeb(deps.host, args.graphId, {
        url: args.url,
        ...(args.html !== undefined ? { html: args.html } : {}),
        ...(args.selection !== undefined ? { selection: args.selection } : {}),
      });
    }
    case 'ingest.clip': {
      const { graphId, text, label } = z.object({
        graphId: z.string(),
        text: z.string(),
        label: z.string().default('Clip'),
      }).parse(params);
      return ingestClip(deps.host, graphId, text, label);
    }
    case 'stats.summary': {
      // Used by the Tauri inspector — lighter than `stats` with `includeNodes`.
      // Returns per-graph counts and source list (no node previews).
      const s = deps.host.stats();
      return {
        graphs: s.graphs.map(g => ({
          graphId: g.graphId,
          totalNodes: g.totalNodes,
          activeNodes: g.activeNodes,
          softDeletedNodes: g.softDeletedNodes,
          sources: g.sources,
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
      return deps.host.forgetSource(graphId, sourceId);
    }
    case 'recall': {
      const { query, maxTokens, maxNodes } = z.object({
        query: z.string(),
        maxTokens: z.number().optional(),
        maxNodes: z.number().optional(),
      }).parse(params);
      const sub = await deps.host.recall(query, {
        budget: { maxTokens: maxTokens ?? 2000, maxNodes: maxNodes ?? 20 },
      });
      return {
        prompt: sub.prompt,
        tokensUsed: sub.tokensUsed,
        nodesIncluded: sub.nodesIncluded,
        byGraph: Object.fromEntries(sub.byGraph),
        audit: sub.audit,
      };
    }
    default:
      throw new Error(`Unknown IPC method: ${method}`);
  }
}
