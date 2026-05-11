import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import { proposeCorrection, applyCorrection } from './correction.js';
import { ingestClip } from './ingest.js';

// MCP tools the App exposes to any AI client (Claude Desktop, Claude Code, Cursor, Zed, ...).
//
// - recall    : federated subgraph for a user query (read-only)
// - remember  : user-invoked "save this" inside an AI conversation
// - correct   : process a natural-language correction and return a preview diff (no write)
// - apply     : commit a previously-previewed diff after the user confirms in the app
// - forget    : remove a source and everything derived from it
//
// The MCP layer never writes without explicit user-side confirmation for mutations
// except `remember` (which the user themselves invoked from the conversation).

const RememberInput = z.object({
  graphId: z.string().optional(),
  label: z.string().default('Conversation note'),
  text: z.string(),
});
// Coerce so that AI clients sending stringified numbers (a common MCP foot-gun)
// don't fail validation. zod.coerce parses '50' -> 50, '5000.0' -> 5000.
const RecallInput = z.object({
  query: z.string(),
  maxTokens: z.coerce.number().int().positive().max(8000).optional(),
  maxNodes: z.coerce.number().int().positive().max(50).optional(),
});
const CorrectInput = z.object({
  correction: z.string(),
  graphId: z.string().optional(),
});
const ApplyInput = z.object({
  graphId: z.string(),
  diffId: z.string(),
});
const ForgetInput = z.object({
  graphId: z.string(),
  sourceId: z.string(),
});

export interface McpDeps {
  host: GraphnosisHost;
  llm: () => LocalLlm | null;
  /** Default graph for ambient remember when no graphId is provided. */
  defaultGraphId: () => string;
  /** UI hook so a "correction proposed" notification fires for the user to confirm. */
  pendingDiffs: Map<string, { graphId: string; diff: import('./correction.js').CorrectionDiff }>;
}

export async function startMcpServer(deps: McpDeps): Promise<void> {
  const server = new Server(
    { name: 'graphnosis', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'recall',
        description: 'Search the user\'s personal memory and return a relevant subgraph as context. Server enforces hard caps (max 50 nodes / 8000 tokens) and tighter limits on graphs the user marked as sensitive. Every recall is auditable in the Graphnosis App — request the smallest budget that answers the user\'s question.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural-language query. Keywords work; the server runs TF-IDF and embeddings.',
            },
            maxTokens: {
              type: 'number',
              minimum: 100,
              maximum: 8000,
              description: 'Token budget for the attached context. Default 2000. Higher values are visible to the user in the audit log — prefer 1000-2000 unless the question genuinely needs more.',
            },
            maxNodes: {
              type: 'number',
              minimum: 1,
              maximum: 50,
              description: 'Maximum number of memory nodes to attach. Default 20. Each node is roughly one chunked memory.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'remember',
        description: 'Add a note from the current conversation to the user\'s personal memory.\n\nFormatting guidance:\n- Prefer a single concise paragraph (< 500 chars, no markdown headers). Short notes ingest as ONE node — clean and dense.\n- Use markdown only when the note has genuine multi-section structure worth indexing separately. Each `#` heading creates additional nodes.\n- Do NOT prepend a `# {title}` heading just to label the note — pass that as the `label` field instead.\n\nWhen NOT to use this tool: if you\'re trying to FIX, UPDATE, or supersede something the user previously said, use `correct` instead — otherwise you create duplicate, conflicting nodes. The response flags contradictions detected against existing memory; if any appear, surface them to the user and offer `correct` or `forget` as the next step.',
        inputSchema: {
          type: 'object',
          properties: {
            graphId: { type: 'string' },
            label: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['text'],
        },
      },
      {
        name: 'correct',
        description: 'Propose a correction to the user\'s memory in natural language. Returns a preview diff; nothing is written until the user confirms in the Graphnosis App.',
        inputSchema: {
          type: 'object',
          properties: {
            correction: { type: 'string' },
            graphId: { type: 'string' },
          },
          required: ['correction'],
        },
      },
      {
        name: 'apply',
        description: 'Apply a previously-previewed correction after the user confirms it.',
        inputSchema: {
          type: 'object',
          properties: {
            graphId: { type: 'string' },
            diffId: { type: 'string' },
          },
          required: ['graphId', 'diffId'],
        },
      },
      {
        name: 'forget',
        description: 'Remove a source and all nodes derived from it.',
        inputSchema: {
          type: 'object',
          properties: {
            graphId: { type: 'string' },
            sourceId: { type: 'string' },
          },
          required: ['graphId', 'sourceId'],
        },
      },
      {
        name: 'stats',
        description: 'Inspect the ground-truth state of the user\'s graphs — total/active/soft-deleted node counts per graph, plus a sample of node contents. Use this when the user asks "show me my graph" or to debug why `recall` returned nothing.',
        inputSchema: {
          type: 'object',
          properties: {
            includeNodes: { type: 'boolean', description: 'Include up to 20 node previews. Default false.' },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    switch (req.params.name) {
      case 'recall': {
        const args = RecallInput.parse(req.params.arguments ?? {});
        const budget = {
          maxTokens: args.maxTokens ?? 2000,
          maxNodes: args.maxNodes ?? 20,
        };
        const sub = await deps.host.recall(args.query, { budget });
        // Emit a structured audit line to stderr — the desktop inspector tails this.
        console.error(`[recall] q=${JSON.stringify(args.query)} requested=${budget.maxNodes}n/${budget.maxTokens}t served=${sub.nodesIncluded}n/${sub.tokensUsed}t graphs=${JSON.stringify(sub.audit)}`);
        const auditFooter =
          '\n\n---\n' +
          `Attached ${sub.nodesIncluded} memory node(s) / ${sub.tokensUsed} tokens across ${sub.audit.length} graph(s). ` +
          `Per-graph (tier · nodes · tokens): ` +
          sub.audit.map(a => `${a.graphId} · ${a.tier} · ${a.nodesIncluded}n · ${a.tokensIncluded}t`).join(', ') + '.';
        return { content: [{ type: 'text', text: sub.prompt + auditFooter }] };
      }
      case 'remember': {
        const args = RememberInput.parse(req.params.arguments ?? {});
        const graphId = args.graphId ?? deps.defaultGraphId();
        const rec = await ingestClip(deps.host, graphId, args.text, args.label) as
          import('@graphnosis-app/core').SourceRecord & { contradictions?: unknown[] };
        let msg = `Saved to ${graphId} as ${rec.sourceId}.`;
        if (rec.contradictions && rec.contradictions.length > 0) {
          msg +=
            `\n\n⚠️ Detected ${rec.contradictions.length} contradiction(s) with existing memory. ` +
            `This often means the user was correcting a previous note, not adding a new one. ` +
            `Tell the user the previous note is now contradicted and offer to call \`correct\` or \`forget\` to clean it up. ` +
            `Contradictions: ${JSON.stringify(rec.contradictions)}`;
        }
        return { content: [{ type: 'text', text: msg }] };
      }
      case 'correct': {
        const args = CorrectInput.parse(req.params.arguments ?? {});
        const llm = deps.llm();
        if (!llm) throw new Error('No local LLM is configured. Open Graphnosis App to install one.');
        const { diff, candidates } = await proposeCorrection({
          host: deps.host,
          llm,
          correction: args.correction,
          ...(args.graphId !== undefined ? { graphIdHint: args.graphId } : {}),
        });
        const targetGraph = args.graphId ?? candidates[0]?.graphId ?? deps.defaultGraphId();
        const diffId = `diff_${Date.now().toString(36)}`;
        deps.pendingDiffs.set(diffId, { graphId: targetGraph, diff });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ diffId, preview: diff, candidates }, null, 2),
          }],
        };
      }
      case 'apply': {
        const args = ApplyInput.parse(req.params.arguments ?? {});
        const pending = deps.pendingDiffs.get(args.diffId);
        if (!pending) throw new Error(`No pending diff ${args.diffId}. The user must confirm in the app first.`);
        await applyCorrection({ host: deps.host, graphId: pending.graphId, diff: pending.diff });
        deps.pendingDiffs.delete(args.diffId);
        return { content: [{ type: 'text', text: 'Applied.' }] };
      }
      case 'forget': {
        const args = ForgetInput.parse(req.params.arguments ?? {});
        const { nodeIds } = await deps.host.forgetSource(args.graphId, args.sourceId);
        return { content: [{ type: 'text', text: `Forgot ${nodeIds.length} nodes from source ${args.sourceId}.` }] };
      }
      case 'stats': {
        const { includeNodes } = z.object({ includeNodes: z.coerce.boolean().optional() }).parse(req.params.arguments ?? {});
        const s = deps.host.stats();
        const summary = s.graphs.map(g => ({
          graphId: g.graphId,
          totalNodes: g.totalNodes,
          activeNodes: g.activeNodes,
          softDeletedNodes: g.softDeletedNodes,
          sources: g.sources,
          ...(includeNodes ? { nodes: g.nodes.slice(0, 20) } : {}),
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ graphs: summary }, null, 2) }] };
      }
      default:
        throw new Error(`Unknown tool: ${req.params.name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// JSON schemas are inlined above. Zod is still used at runtime for input validation
// inside each tool handler, but we don't try to derive the wire schemas from it —
// zod v4's type graph is awkward to traverse and the schemas barely change.
