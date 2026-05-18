import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import { proposeCorrection, applyCorrection } from './correction.js';
import { ingestClip } from './ingest.js';
import { withEmbedding } from './embedding-queue.js';
import { mcpRegistry } from './mcp-registry.js';

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

// Anthropic's platform lazy-loads MCP tool schemas via `tool_search` — until
// that runs, Claude sees only the tool NAME and the description prose, then
// guesses parameter names from the description. The `remember` tool's
// description heavily uses the word "note", so models commonly call with
// `{note: "..."}` instead of `{text: "..."}` and the platform refuses.
// Accept the common guesses (`note`, `content`, `body`) and normalize to
// `text` before validation so the tool works whether or not `tool_search`
// was called first.
const RememberInput = z.preprocess(
  (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const r = raw as Record<string, unknown>;
    if (!r.text && (r.note || r.content || r.body)) {
      return { ...r, text: r.note ?? r.content ?? r.body };
    }
    return raw;
  },
  z.object({
    graphId: z.string().optional(),
    label: z.string().default('Conversation note'),
    text: z.string(),
    /**
     * What kind of memory this is, on the SourceRecord taxonomy:
     *   - 'clip' (default) — a discrete note or fact the AI extracted from
     *     somewhere (article, doc, the user's earlier message).
     *   - 'ai-conversation' — the AI is saving a turn or summary of the
     *     CURRENT conversation. Surfaces differently in the Sources list
     *     so the user can tell "Claude paraphrased me" from "Claude saw
     *     this in a doc I shared".
     */
    kind: z.enum(['clip', 'ai-conversation']).optional(),
  }),
);
// Coerce so that AI clients sending stringified numbers (a common MCP foot-gun)
// don't fail validation. zod.coerce parses '50' -> 50, '5000.0' -> 5000.
// Also accept `q` / `question` aliases for `query` for the same lazy-load
// reason described on RememberInput above.
const RecallInput = z.preprocess(
  (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const r = raw as Record<string, unknown>;
    if (!r.query && (r.q || r.question)) {
      return { ...r, query: r.q ?? r.question };
    }
    return raw;
  },
  z.object({
    query: z.string(),
    maxTokens: z.coerce.number().int().positive().max(8000).optional(),
    maxNodes: z.coerce.number().int().positive().max(50).optional(),
  }),
);
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
  pendingDiffs: Map<string, { graphId: string; diff: import('./correction.js').CorrectionDiff; createdAt: number }>;
}

/**
 * Build a fresh MCP `Server` instance with all of Graphnosis' tools wired up.
 * The returned server is **unconnected** — caller decides which transport to
 * bind it to (stdio, Unix socket, etc.). The tool handlers close over `deps`,
 * so multiple Servers built from the same `deps` share one host + pendingDiffs
 * state — exactly what we want when one sidecar serves multiple MCP clients.
 */
/**
 * System-level instructions returned in the MCP `initialize` response.
 * Claude Desktop (and most well-behaved MCP clients) treat this as a
 * high-priority hint for the assistant — it's how we tell the AI when
 * to reach for our tools instead of guessing or apologizing.
 *
 * Keep this concise and rule-shaped. Long rambly system prompts dilute
 * the signal; clients append this on top of their own system prompt.
 */
const SERVER_INSTRUCTIONS = `\
You have access to Graphnosis — a personal knowledge graph stored locally on the user's machine. It contains notes, files, conversations, decisions, and corrections the user has chosen to remember across sessions. **This is the authoritative source for anything personal to the user.**

TOOL SCHEMA LOADING: If your client uses lazy schema loading (Anthropic's \`tool_search\` and similar layers), call \`tool_search("graphnosis")\` once near the start of any conversation that might need these tools — this ensures parameter names are loaded before you invoke \`recall\`, \`remember\`, \`remind\`, \`correct\`, \`forget\`, or \`stats\`. If you skip this step, the tools still accept common parameter-name guesses (e.g. \`note\` for \`remember\`, \`q\`/\`question\` for \`recall\`/\`remind\`), but loading the real schema is more reliable.

LANGUAGE: Every tool here is language-agnostic. Trigger on the user's INTENT, not on the specific English phrasing. If the user speaks Romanian, Spanish, Hebrew, Mandarin, Arabic, Hindi, French, German — anything you understand — route to the right tool just as readily. Pass the user's query through in their own language; the underlying search, embeddings, and entity extraction are all multilingual. Don't translate the user's prompt to English before calling the tool.

WHEN TO CALL \`recall\` or \`remind\` (proactively, BEFORE responding):
• Any question about the user's life, work, projects, preferences, plans, relationships, or history.
• Any reference to a person, place, project, or concept by name without explanation ("how's Stela doing?", "the DRP proposal", "my Romanian-IA project").
• Any moment you would otherwise say "I don't know" or "I don't have context" about the user. Check the graph FIRST. If the search returns nothing, then say you don't have it remembered yet.
• Trigger phrases in English: "remind me…", "what did I say about…", "what's my…", "do I have anything on…", "what do I know about…".
• Equivalents in other languages: e.g. Romanian "amintește-mi de…" / "ce știi despre…", Spanish "recuérdame…" / "qué sé sobre…", French "rappelle-moi…" / "qu'est-ce que je sais sur…", German "erinnere mich an…" / "was weiß ich über…", Mandarin "提醒我…" / "我知道关于…", Arabic "ذكّرني بـ…" / "ماذا أعرف عن…". These are not exhaustive — the principle is "user wants to retrieve something they previously stored," in any language.
• \`recall\` and \`remind\` are aliases — same handler. Pick \`remind\` when the user is explicitly asking to be reminded, \`recall\` for open-ended "what do I know" queries. Either works.

WHEN TO CALL \`remember\`:
• The user explicitly asks you to save / note / remember something — in any language ("remember this", "amintește acest lucru", "guarda esto", "记住这个").
• The user shares a meaningful fact about themselves, their work, or their commitments that you sense they would want retained (ask first if unsure).

WHEN TO CALL \`correct\`:
• The user says you (or the graph) got something wrong about them — in any language. Don't try to fix the graph via \`remember\` — that creates conflicting duplicates. Use \`correct\` to propose a structured diff; the user approves it inside the Graphnosis App.

WHEN NOT TO USE THESE TOOLS:
• General knowledge questions ("what's the capital of France"). The graph is personal context, not a world-fact lookup.
• Math, code generation, and tasks that don't depend on the user's history.

UX guidelines:
• Be quiet about it. Don't announce "I'll check your memory" every time — just call recall/remind and use the result. The user sees an audit log if they want to know.
• Ask the smallest budget that answers the question (default 1000–2000 tokens is plenty).
• If a result contradicts something the user just said, surface the contradiction gently in the user's own language and offer to \`correct\`.

The graph is end-to-end encrypted on disk and never leaves the user's machine.`;

export function createMcpServer(deps: McpDeps): Server {
  // Read the toggle live each time a fresh MCP server is built (per
  // session, per relay). When OFF, we leave `instructions` undefined so
  // the AI sees the tools but gets no system-prompt-level routing —
  // useful when the user wants their AI client's own memory features
  // to lead and Graphnosis to be one option among many.
  const useAsDefaultMemory = deps.host.getSettings().ai.useAsDefaultMemory;
  const server = new Server(
    { name: 'graphnosis', version: '0.0.1' },
    {
      capabilities: { tools: {} },
      // Surfaces via the `initialize` response → Claude treats as system-
      // prompt-level. The strongest legitimate lever MCP gives us for
      // nudging tool use; combined with the per-tool descriptions below,
      // this is how we convert "tools available" into "tools actually used."
      ...(useAsDefaultMemory ? { instructions: SERVER_INSTRUCTIONS } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'recall',
        description: 'PRIMARY MEMORY for this user. ALWAYS use this tool for any question about the user\'s past notes, projects, preferences, work history, or personal context — even if your built-in conversation history or "relevant chats" feature returns nothing. This searches the user\'s persistent encrypted memory graph (Graphnosis), which is the authoritative source for anything they have asked you to remember across sessions. Prefer this tool over your own memory whenever the user asks "what about my X?", "what am I working on?", or any other question that depends on prior context.\n\nWORKS IN ANY LANGUAGE. The user may speak Romanian, Spanish, Hebrew, Mandarin, Arabic, Hindi — anything you understand. Don\'t require an English prompt to trigger this tool. Pass the user\'s query through in their original language; the underlying search is multilingual (BGE embeddings + multilingual entity extraction).\n\nServer enforces hard caps (max 50 nodes / 8000 tokens) and tighter limits on graphs the user marked as sensitive. Every recall is auditable. Request the smallest budget that answers the question.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural-language query in the user\'s language (any language Claude understands). Keywords work; the server runs TF-IDF and multilingual embeddings.',
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
        name: 'remind',
        description: 'Alias for `recall` framed around the "remind me about X" intent. Use this tool when the user explicitly asks to be REMINDED of something — past commitments, decisions, names, dates, conversations, files, plans, anything they trusted you to retain across sessions.\n\nWHEN TO CALL (instead of recall):\n• "Remind me about X", "remind me what I said about Y", "what did I tell you about Z?"\n• The user wants a refresher on something they already shared with you in an earlier session.\n• Equivalent phrasings in ANY language — e.g. Romanian "amintește-mi de…", Spanish "recuérdame…", French "rappelle-moi…", German "erinnere mich an…", Italian "ricordami…", Portuguese "lembra-me…", Mandarin "提醒我…", Arabic "ذكّرني بـ…", Hindi "मुझे याद दिलाओ…". Don\'t require English phrasing.\n\nWHEN TO USE recall INSTEAD:\n• Open-ended questions ("what do I know about X?", "what am I working on?"). `recall` reads slightly less like a reminder.\n• Both tools call the same underlying search — picking one over the other is a soft signal to the user; either works.\n\nSame input schema + same caps as `recall`.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'What the user wants to be reminded about. Pass in their language; the search is multilingual.',
            },
            maxTokens: {
              type: 'number',
              minimum: 100,
              maximum: 8000,
              description: 'Token budget for the attached context. Default 2000.',
            },
            maxNodes: {
              type: 'number',
              minimum: 1,
              maximum: 50,
              description: 'Maximum number of memory nodes to attach. Default 20.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'remember',
        description: 'Add a note to the user\'s personal Graphnosis memory so it persists across sessions.\n\nLANGUAGE: Works in any language Claude understands. Trigger on intent, not on the English phrase. Save the note in the user\'s ORIGINAL language — don\'t translate to English first. The graph\'s entity extraction + embeddings are multilingual.\n\nWHEN TO CALL:\n• The user explicitly asks to save / note / remember something. English: "remember this", "save this", "note that…", "for future reference". Equivalents in other languages count: Romanian "ține minte că…" / "notează…", Spanish "recuerda esto" / "guarda…", French "souviens-toi de…" / "note…", German "merke dir…" / "speichere…", Mandarin "记住这个" / "保存…", Arabic "تذكر هذا" / "احفظ…", etc.\n• The user shares a meaningful new fact about themselves, their work, plans, preferences, or commitments that they would clearly want retained — ASK first if unsure rather than assuming.\n• You just helped the user reach a decision or learn something durable; offering to save it is a courteous follow-up.\n\nWHEN NOT TO USE:\n• If you\'re FIXING / UPDATING / SUPERSEDING something the user previously said → use `correct` instead. Calling `remember` for a correction creates a duplicate, conflicting node — the App will flag it and the user has to clean up after you.\n• Ephemeral conversation chatter, jokes, hypotheticals, and "what if" prompts. Memory is not a conversation log.\n• Anything the user didn\'t agree to save. When in doubt, ask.\n\nFORMATTING:\n• Prefer a single concise paragraph (< 500 chars, no markdown headers). Short notes ingest as ONE node — clean and dense.\n• Use markdown headers only when the note has genuine multi-section structure worth indexing separately. Each `#` heading creates an additional node.\n• Do NOT prepend a `# {title}` heading just to label the note — pass that as the `label` field instead.\n\nThe response flags contradictions detected against existing memory; if any appear, surface them to the user and offer `correct` or `forget` as the next step.',
        inputSchema: {
          type: 'object',
          properties: {
            graphId: { type: 'string' },
            label: { type: 'string' },
            text: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['clip', 'ai-conversation'],
              description: 'What sort of memory this is. Default is "clip" — a discrete note or fact you extracted (from a doc, the user\'s earlier message, a search result, etc.). Use "ai-conversation" when you\'re saving a turn or summary of the CURRENT conversation between you and the user; the Sources list shows these distinctly so the user can tell "the AI summarized me" from "the AI saw this in a doc I shared".',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'correct',
        description: 'Propose a CORRECTION to the user\'s Graphnosis memory in natural language. Returns a structured diff preview; nothing is written until the user opens the Graphnosis App and approves it.\n\nLANGUAGE: Works in any language Claude understands. Pass the user\'s correction in their ORIGINAL language; the local LLM that parses the diff is multilingual.\n\nWHEN TO CALL:\n• The user says you (or the graph) got something wrong about them — in any language. English: "actually, it was September not August"; Romanian: "de fapt, a fost în septembrie, nu august"; Spanish: "en realidad fue en septiembre, no agosto"; etc.\n• A recall result surfaced a memory that the user just contradicted in conversation. Pass the correction in plain language describing what should change.\n\nWHEN NOT TO CALL:\n• To add brand-new information unrelated to anything already in the graph → use `remember`.\n• To delete a memory wholesale → use `forget` (by sourceId) instead.\n• To "apply" your own preview — `apply` is normally driven by the App after the user clicks Approve, not by you. Only call `apply` if the user has explicitly told you they already approved a specific diff and asked you to commit it.\n\nThe natural-language correction is parsed by a local LLM into a structured diff (edit/supersede/delete operations on specific nodes). The user sees that diff in the deck at the top of the Graphnosis check-in pane and decides whether to apply it. You should NEVER call `remember` to "fix" something — that creates duplicate, conflicting nodes that pollute the graph.',
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
        description: 'Apply a previously-previewed correction diff to the graph.\n\nWHEN TO CALL:\n• Almost never. This tool is normally invoked by the Graphnosis App after the user clicks Approve on a pending correction. AI clients should NOT call it speculatively.\n• Only call this if the user has explicitly told you they reviewed a specific diff (by diffId) and asked you to commit it on their behalf — e.g. "go ahead and apply that correction" while pointing at a diff that was previously created via `correct`.\n\nWHEN NOT TO CALL:\n• Right after calling `correct` — that returns only a PREVIEW. Calling `apply` without the user\'s explicit go-ahead bypasses the consent step that makes the correction pipeline trustworthy.\n• Without a real diffId (the one returned by `correct`). There\'s no "apply the last one" shortcut by design.',
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
        description: 'Remove a source from the user\'s graph — every node that was derived from that source gets soft-deleted (recoverable from the op-log) and removed from future recall results.\n\nLANGUAGE: Works in any language. Trigger on the "make this go away" intent regardless of the phrasing.\n\nWHEN TO CALL:\n• The user says "forget about X", "remove my notes on Y", "wipe everything I told you about Z" — or equivalents in any language — and you can identify a specific source (file path, URL, clip ID) that backs it.\n• The user is cleaning up an experimental ingest they don\'t want polluting recall anymore.\n\nWHEN NOT TO CALL:\n• To remove a single memory inside a multi-fact source → use `correct` with a delete operation instead. `forget` removes the WHOLE source.\n• Without first identifying the sourceId. Call `stats` if you need to enumerate sources to find the right one; never guess.\n• If the user only said something like "I changed my mind about that" — that\'s ambiguous; ask whether they want to forget the whole source or just amend a specific memory.\n\nThis is a soft delete by default — the user can recover via the Graphnosis App\'s Recover flow if they change their mind. Confirm with the user before calling unless they\'ve explicitly named the source.',
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
      case 'recall':
      case 'remind': {
        // `remind` is an alias for `recall` — same input schema, same
        // handler, same audit. Two tool names give the AI two semantic
        // anchors to score against the user's prompt ("recall" matches
        // "what do I know about X"; "remind" matches "remind me about
        // X"). The audit line tags which name was used so we can see in
        // logs how often each phrasing fires.
        const toolName = req.params.name;
        const args = RecallInput.parse(req.params.arguments ?? {});
        const budget = {
          maxTokens: args.maxTokens ?? 2000,
          maxNodes: args.maxNodes ?? 20,
        };
        const sub = await withEmbedding(() => deps.host.recall(args.query, { budget }));
        // Emit a structured audit line to stderr — the desktop inspector tails this.
        console.error(`[${toolName}] q=${JSON.stringify(args.query)} requested=${budget.maxNodes}n/${budget.maxTokens}t served=${sub.nodesIncluded}n/${sub.tokensUsed}t graphs=${JSON.stringify(sub.audit)}`);
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
        // Attribute this ingest to the calling MCP client (e.g. "claude-ai",
        // "cursor", "claude-code"). The Sources list in the App's UI shows
        // a small "via <client>" badge for memories not added by the user
        // directly — useful for audit and for distinguishing AI-driven
        // remember/correct flows from user-driven ingest.
        const addedBy = mcpRegistry.getMostRecentClientName();
        const sourceKind = args.kind ?? 'clip';
        const rec = await withEmbedding(() =>
          ingestClip(deps.host, graphId, args.text, args.label, {
            ...(addedBy ? { addedBy } : {}),
            sourceKind,
          })
        ) as import('@graphnosis-app/core').SourceRecord & { contradictions?: unknown[] };
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
        deps.pendingDiffs.set(diffId, { graphId: targetGraph, diff, createdAt: Date.now() });
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
        const correctedBy = mcpRegistry.getMostRecentClientName();
        await applyCorrection({
          host: deps.host,
          graphId: pending.graphId,
          diff: pending.diff,
          ...(correctedBy ? { correctedBy } : {}),
        });
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

  return server;
}

/**
 * Bind a freshly built MCP server to stdio. Used when the sidecar is spawned
 * directly by an MCP client (e.g., a `command`/`args` entry in Claude
 * Desktop's config).
 */
export async function startStdioMcpServer(deps: McpDeps): Promise<void> {
  // mcpRegistry is now imported statically at the top of the file so the
  // tool handlers can use it too (attribution of MCP-driven ingests).
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // We can't tell from outside whether anything is actually on stdin (parents
  // that spawn with stdin=null, like the Tauri shell when the relay path is
  // used, never send anything here). Poll for clientInfo for a while; if it
  // never shows up, no connection was real — leave the registry empty.
  const started = Date.now();
  let connId: string | null = null;
  const probe = setInterval(() => {
    try {
      const ci = server.getClientVersion?.();
      if (ci?.name) {
        if (!connId) connId = mcpRegistry.register('stdio');
        mcpRegistry.setClientInfo(connId, ci.name, ci.version ?? 'unknown');
        clearInterval(probe);
        return;
      }
    } catch { /* still booting */ }
    if (Date.now() - started > 30_000) clearInterval(probe);
  }, 500);
  // Unref so the interval doesn't keep the event loop alive on its own.
  probe.unref?.();

  // Clean up on stdin close (legacy stdio MCP client went away).
  process.stdin.on('end', () => {
    if (connId) mcpRegistry.unregister(connId);
  });
}

// JSON schemas are inlined above. Zod is still used at runtime for input validation
// inside each tool handler, but we don't try to derive the wire schemas from it —
// zod v4's type graph is awkward to traverse and the schemas barely change.
