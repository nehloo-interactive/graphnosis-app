import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import { proposeCorrection, applyCorrection, type GnnCandidateExpander } from './correction.js';
import { ingestClip } from './ingest.js';
import { withEmbedding } from './embedding-queue.js';
import { mcpRegistry } from './mcp-registry.js';
import type { BrainEngine } from './brain-engine.js';

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
    /**
     * Optional engram target by NAME (graph id slug OR human display name).
     *
     * Use this when the user's intent names a specific engram:
     *   "save this to my book-notes engram"
     *   "remember this in work-2026"
     *
     * Resolution priority:
     *   1. Exact match on a loaded graph's id slug (`book-notes`)
     *   2. Case-insensitive match on a graph's displayName ("Book Notes")
     *
     * If neither matches, the sidecar returns an actionable error AND
     * broadcasts a `engram.create-suggested` event to the App's UI so
     * the user can click "Create" once to (a) create the engram and
     * (b) ingest this same note in one shot. The AI does NOT create
     * engrams unilaterally — that's a taxonomy decision the human
     * must approve.
     *
     * If both `graphId` and `target_engram` are passed, `graphId` wins
     * (explicit slug beats fuzzy resolution).
     */
    target_engram: z.string().optional(),
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

/**
 * Resolve a user-supplied engram name against the loaded graphs.
 *
 * Three outcomes:
 *   - `exact`     — normalized name matches a graphId or displayName exactly;
 *                   safe to write without user confirmation.
 *   - `ambiguous` — at least one candidate scored above the similarity
 *                   threshold; the App banner shows them so the user can
 *                   pick (or create a new engram instead). The AI never
 *                   silently disambiguates.
 *   - `none`      — no candidate above threshold; the banner offers
 *                   "Create new" only.
 *
 * Matching is dependency-free and runs O(N) over engrams:
 *   1. Normalize both sides: NFC, lowercase, strip non-alphanumeric.
 *   2. Score = max(substring_containment, jaccard_token_overlap,
 *                  1 - normalized_levenshtein).
 *   3. Threshold 0.6; keep up to 3 candidates ranked by score.
 *
 * Token splitting handles camelCase, snake_case, kebab-case, and spaces —
 * so "Romania Unpublished" and "UnpublishedRomania" both tokenize to
 * {romania, unpublished} and match via Jaccard = 1.0.
 */
type EngramCandidate = {
  graphId: string;
  displayName: string;
  score: number;
  reason: 'substring' | 'tokens' | 'edit-distance';
};
type ResolveResult =
  | { kind: 'exact'; graphId: string }
  | { kind: 'ambiguous'; candidates: EngramCandidate[] }
  | { kind: 'none' };

const FUZZY_THRESHOLD = 0.6;
const MAX_CANDIDATES = 3;

function normalizeName(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function tokenize(s: string): string[] {
  // Split camelCase ("UnpublishedRomania" → ["Unpublished","Romania"]),
  // then on non-alphanumerics, then lowercase, drop empties.
  return s
    .normalize('NFC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function scoreCandidate(query: string, candidate: string): { score: number; reason: EngramCandidate['reason'] } {
  const qn = normalizeName(query);
  const cn = normalizeName(candidate);
  if (!qn || !cn) return { score: 0, reason: 'edit-distance' };

  // 1. Substring containment (either direction). Strong signal — but scale
  //    down a bit when the query is much shorter than the candidate, so a
  //    3-char query doesn't auto-match every long name that happens to
  //    contain those letters.
  let substring = 0;
  if (cn.includes(qn)) substring = qn.length >= 4 ? 0.9 : 0.7;
  else if (qn.includes(cn)) substring = 0.9;

  // 2. Token-set Jaccard
  const tokens = jaccard(tokenize(query), tokenize(candidate));

  // 3. Edit distance normalized by longer length, inverted
  const dist = levenshtein(qn, cn);
  const editScore = 1 - dist / Math.max(qn.length, cn.length);

  // Pick best signal so each reason gets a fair shot
  if (substring >= tokens && substring >= editScore) return { score: substring, reason: 'substring' };
  if (tokens >= editScore) return { score: tokens, reason: 'tokens' };
  return { score: editScore, reason: 'edit-distance' };
}

function resolveTargetEngram(host: GraphnosisHost, name: string): ResolveResult {
  const ids = host.listGraphs();
  if (!ids.length) return { kind: 'none' };

  // Pass 1: exact match on slug or displayName (normalized).
  const qn = normalizeName(name);
  for (const id of ids) {
    if (normalizeName(id) === qn) return { kind: 'exact', graphId: id };
    const meta = host.getGraphMetadata(id);
    if (meta?.displayName && normalizeName(meta.displayName) === qn) {
      return { kind: 'exact', graphId: id };
    }
  }

  // Pass 2: fuzzy. Score against both slug and displayName, keep the better.
  const scored: EngramCandidate[] = [];
  for (const id of ids) {
    const meta = host.getGraphMetadata(id);
    const display = meta?.displayName?.trim() || id;
    const a = scoreCandidate(name, id);
    const b = scoreCandidate(name, display);
    const best = b.score > a.score ? b : a;
    if (best.score >= FUZZY_THRESHOLD) {
      scored.push({ graphId: id, displayName: display, score: best.score, reason: best.reason });
    }
  }
  if (!scored.length) return { kind: 'none' };
  scored.sort((x, y) => y.score - x.score);
  return { kind: 'ambiguous', candidates: scored.slice(0, MAX_CANDIDATES) };
}

/**
 * Builds a GNN candidate expander for `correct`. Given the recall hits, it
 * returns Neural-Network-predicted neighbour memories — connections lexical
 * recall missed — so the correction can consider them. Bounded to 8 extras;
 * each carries the GNN edge probability so a strong prediction can be ranked
 * above a weak recall hit.
 */
function buildGnnExpander(host: GraphnosisHost, brainEngine: BrainEngine): GnnCandidateExpander {
  return async (recallCandidates) => {
    const extras: Array<{ graphId: string; nodeId: string; text: string; gnnScore: number }> = [];
    const seen = new Set(recallCandidates.map(c => `${c.graphId}::${c.nodeId}`));
    const graphIds = [...new Set(recallCandidates.map(c => c.graphId))];
    for (const graphId of graphIds) {
      const predicted = brainEngine.getPredictedEdges(graphId);
      if (predicted.length === 0) continue;
      const recallIds = new Set(
        recallCandidates.filter(c => c.graphId === graphId).map(c => c.nodeId),
      );
      // Index node text lazily — only when this graph actually contributes.
      let textById: Map<string, string> | null = null;
      const textOf = (id: string): string | undefined => {
        if (!textById) {
          textById = new Map();
          for (const n of host.listNodes(graphId)) textById.set(n.id, n.contentPreview);
        }
        return textById.get(id);
      };
      for (const e of predicted) {
        // Keep edges with exactly one endpoint among the recall hits — the
        // other endpoint is a memory recall did not directly surface.
        let neighbor: string | null = null;
        if (recallIds.has(e.from) && !recallIds.has(e.to)) neighbor = e.to;
        else if (recallIds.has(e.to) && !recallIds.has(e.from)) neighbor = e.from;
        if (!neighbor) continue;
        const key = `${graphId}::${neighbor}`;
        if (seen.has(key)) continue;
        const text = textOf(neighbor);
        if (!text) continue; // node gone / no preview — skip
        seen.add(key);
        extras.push({ graphId, nodeId: neighbor, text, gnnScore: e.score });
        if (extras.length >= 8) return extras;
      }
    }
    return extras;
  };
}

export interface McpDeps {
  host: GraphnosisHost;
  llm: () => LocalLlm | null;
  /** Default graph for ambient remember when no graphId is provided. */
  defaultGraphId: () => string;
  /** UI hook so a "correction proposed" notification fires for the user to confirm. */
  pendingDiffs: Map<string, { graphId: string; diff: import('./correction.js').CorrectionDiff; createdAt: number }>;
  /**
   * Emit a frame to all connected event-socket subscribers (currently
   * just the App's Rust event_stream forwarder). Used by `remember` to
   * surface the "engram doesn't exist — create?" prompt in the App UI
   * when the AI passes a target_engram that doesn't resolve. Optional —
   * undefined in test/standalone-MCP contexts where no event channel is
   * wired and the AI just gets the actionable error string.
   */
  broadcastRaw?: import('./events.js').BroadcastRawFn;
  /** Brain engine — provides develop/predict/insights/vitality tools. Optional. */
  brainEngine?: BrainEngine | null;
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
        description: 'DETERMINISM — Deterministic: an identical query always returns identical memories; no LLM, no randomness, fully auditable. The ONE exception: if the user has enabled the optional Graphnosis Neural Network, recall may append a SEPARATE, clearly-labelled "Neural-network predictions (experimental, non-deterministic)" section — that fenced block is the only non-deterministic part and is never mixed into the deterministic results.\n\nPRIMARY MEMORY for this user. ALWAYS use this tool for any question about the user\'s past notes, projects, preferences, work history, or personal context — even if your built-in conversation history or "relevant chats" feature returns nothing. This searches the user\'s persistent encrypted memory graph (Graphnosis), which is the authoritative source for anything they have asked you to remember across sessions. Prefer this tool over your own memory whenever the user asks "what about my X?", "what am I working on?", or any other question that depends on prior context.\n\nWORKS IN ANY LANGUAGE. The user may speak Romanian, Spanish, Hebrew, Mandarin, Arabic, Hindi — anything you understand. Don\'t require an English prompt to trigger this tool. Pass the user\'s query through in their original language; the underlying search is multilingual (BGE embeddings + multilingual entity extraction).\n\nServer enforces hard caps (max 50 nodes / 8000 tokens) and tighter limits on graphs the user marked as sensitive. Every recall is auditable. Request the smallest budget that answers the question.',
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
        description: 'DETERMINISM — Deterministic, exactly like the `recall` tool: an identical query always returns identical memories, with no LLM and no randomness. Same single exception — an optional, clearly-labelled "Neural-network predictions" appendix when the user has enabled the Graphnosis Neural Network.\n\nAlias for `recall` framed around the "remind me about X" intent. Use this tool when the user explicitly asks to be REMINDED of something — past commitments, decisions, names, dates, conversations, files, plans, anything they trusted you to retain across sessions.\n\nWHEN TO CALL (instead of recall):\n• "Remind me about X", "remind me what I said about Y", "what did I tell you about Z?"\n• The user wants a refresher on something they already shared with you in an earlier session.\n• Equivalent phrasings in ANY language — e.g. Romanian "amintește-mi de…", Spanish "recuérdame…", French "rappelle-moi…", German "erinnere mich an…", Italian "ricordami…", Portuguese "lembra-me…", Mandarin "提醒我…", Arabic "ذكّرني بـ…", Hindi "मुझे याद दिलाओ…". Don\'t require English phrasing.\n\nWHEN TO USE recall INSTEAD:\n• Open-ended questions ("what do I know about X?", "what am I working on?"). `recall` reads slightly less like a reminder.\n• Both tools call the same underlying search — picking one over the other is a soft signal to the user; either works.\n\nSame input schema + same caps as `recall`.',
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
        description: 'DETERMINISM — Deterministic: saving the same note produces the same memory; no LLM and no randomness are involved, and every write is auditable.\n\nAdd a note to the user\'s personal Graphnosis memory so it persists across sessions.\n\nROUTING: When the note belongs to a topic / project / collection (not a generic default), pass `target_engram` with a human-friendly name (e.g. "Book Notes", "Trip 2027", "Work decisions"). If the engram exists Graphnosis writes immediately; if not, the user gets a one-click banner to create it. NEVER silently dump topic-specific memories into the default engram — that pollutes recall later. Without `target_engram` or `graphId`, the note goes to the user\'s default engram (a fallback, not a recommendation).\n\nLANGUAGE: Works in any language Claude understands. Trigger on intent, not on the English phrase. Save the note in the user\'s ORIGINAL language — don\'t translate to English first. The graph\'s entity extraction + embeddings are multilingual.\n\nWHEN TO CALL:\n• The user explicitly asks to save / note / remember something. English: "remember this", "save this", "note that…", "for future reference". Equivalents in other languages count: Romanian "ține minte că…" / "notează…", Spanish "recuerda esto" / "guarda…", French "souviens-toi de…" / "note…", German "merke dir…" / "speichere…", Mandarin "记住这个" / "保存…", Arabic "تذكر هذا" / "احفظ…", etc.\n• The user shares a meaningful new fact about themselves, their work, plans, preferences, or commitments that they would clearly want retained — ASK first if unsure rather than assuming.\n• You just helped the user reach a decision or learn something durable; offering to save it is a courteous follow-up.\n\nWHEN NOT TO USE:\n• If you\'re FIXING / UPDATING / SUPERSEDING something the user previously said → use `correct` instead. Calling `remember` for a correction creates a duplicate, conflicting node — the App will flag it and the user has to clean up after you.\n• Ephemeral conversation chatter, jokes, hypotheticals, and "what if" prompts. Memory is not a conversation log.\n• Anything the user didn\'t agree to save. When in doubt, ask.\n\nFORMATTING:\n• Prefer a single concise paragraph (< 500 chars, no markdown headers). Short notes ingest as ONE node — clean and dense.\n• Use markdown headers only when the note has genuine multi-section structure worth indexing separately. Each `#` heading creates an additional node.\n• Do NOT prepend a `# {title}` heading just to label the note — pass that as the `label` field instead.\n\nThe response flags contradictions detected against existing memory; if any appear, surface them to the user and offer `correct` or `forget` as the next step.',
        inputSchema: {
          type: 'object',
          properties: {
            target_engram: {
              type: 'string',
              description: 'PREFERRED: a human-friendly engram name to save into (e.g. "Book Notes", "Work decisions", "Trip 2027"). Graphnosis resolves this name against existing engrams via fuzzy matching: exact match → writes immediately; ambiguous (close matches like "unpublished" ↔ "UnpublishedRomania") → user picks in a banner; no match → user confirms creating a new engram in the banner. The AI NEVER auto-creates engrams. Use this in preference to `graphId` whenever you have a topic-based name — it\'s name-tolerant ("Book Notes" / "book-notes" / "booknotes" all resolve to the same engram) and surfaces a user-friendly confirmation UI when the name is new. If neither this nor `graphId` is given, the note goes to the user\'s default engram.',
            },
            graphId: {
              type: 'string',
              description: 'ADVANCED: a known engram slug (e.g. "book-notes"). Skips name resolution. Use only when you already know the exact slug. Unknown slugs route through the same banner flow as `target_engram` rather than dead-ending. Prefer `target_engram` for new memory routing — it\'s name-tolerant and never silently writes to the default engram on a typo.',
            },
            label: {
              type: 'string',
              description: 'Short human-readable label shown alongside the source in the Sources list (e.g. "Trip planning", "Auth flow decision"). Optional; defaults to a sensible placeholder.',
            },
            text: {
              type: 'string',
              description: 'The actual content to remember. Required.',
            },
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
        description: 'DETERMINISM — Conditional. Deterministic by default: with no Local LLM and no Neural Network enabled, `correct` deterministically supersedes the single closest-matching memory with the correction text (or records it as a new memory when nothing matches) — reproducible, no randomness, fully auditable. The optional Neural Network, when enabled, expands the candidate set with GNN-predicted related memories and may re-rank which memory is superseded — non-deterministic. The optional Local LLM, when enabled, instead authors a multi-part structured diff across several candidate memories — non-deterministic. The response\'s `mode` field reports which path ran ("deterministic", "gnn-expanded", or "llm-assisted"). Either way nothing is written until the user reviews and approves the diff.\n\nPropose a CORRECTION to the user\'s Graphnosis memory in natural language. Returns a structured diff preview; nothing is written until the user opens the Graphnosis App and approves it.\n\nLANGUAGE: Works in any language Claude understands. Pass the user\'s correction in their ORIGINAL language — both the deterministic recall match and the optional LLM parser are multilingual.\n\nWHEN TO CALL:\n• The user says you (or the graph) got something wrong about them — in any language. English: "actually, it was September not August"; Romanian: "de fapt, a fost în septembrie, nu august"; Spanish: "en realidad fue en septiembre, no agosto"; etc.\n• A recall result surfaced a memory that the user just contradicted in conversation. Pass the correction in plain language describing what should change.\n\nWHEN NOT TO CALL:\n• To add brand-new information unrelated to anything already in the graph → use `remember`.\n• To delete a memory wholesale → use `forget` (by sourceId) instead.\n• To "apply" your own preview — `apply` is normally driven by the App after the user clicks Approve, not by you. Only call `apply` if the user has explicitly told you they already approved a specific diff and asked you to commit it.\n\nThe correction becomes a structured diff (supersede/edit/delete/add operations on specific nodes) — produced deterministically by default, with the candidate set expanded by the Neural Network when enabled, or authored by the Local LLM when one is enabled. The user sees that diff in the deck at the top of the Graphnosis check-in pane and decides whether to apply it. You should NEVER call `remember` to "fix" something — that creates duplicate, conflicting nodes that pollute the graph.',
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
        description: 'DETERMINISM — Deterministic: writes an already-reviewed diff to the graph via the op-log; applying the same diff twice is idempotent.\n\nApply a previously-previewed correction diff to the graph.\n\nWHEN TO CALL:\n• Almost never. This tool is normally invoked by the Graphnosis App after the user clicks Approve on a pending correction. AI clients should NOT call it speculatively.\n• Only call this if the user has explicitly told you they reviewed a specific diff (by diffId) and asked you to commit it on their behalf — e.g. "go ahead and apply that correction" while pointing at a diff that was previously created via `correct`.\n\nWHEN NOT TO CALL:\n• Right after calling `correct` — that returns only a PREVIEW. Calling `apply` without the user\'s explicit go-ahead bypasses the consent step that makes the correction pipeline trustworthy.\n• Without a real diffId (the one returned by `correct`). There\'s no "apply the last one" shortcut by design.',
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
        description: 'DETERMINISM — Deterministic: removing the same source always yields the same result; no LLM, no randomness, and the soft-delete is recoverable from the op-log.\n\nRemove a source from the user\'s graph — every node that was derived from that source gets soft-deleted (recoverable from the op-log) and removed from future recall results.\n\nLANGUAGE: Works in any language. Trigger on the "make this go away" intent regardless of the phrasing.\n\nWHEN TO CALL:\n• The user says "forget about X", "remove my notes on Y", "wipe everything I told you about Z" — or equivalents in any language — and you can identify a specific source (file path, URL, clip ID) that backs it.\n• The user is cleaning up an experimental ingest they don\'t want polluting recall anymore.\n\nWHEN NOT TO CALL:\n• To remove a single memory inside a multi-fact source → use `correct` with a delete operation instead. `forget` removes the WHOLE source.\n• Without first identifying the sourceId. Call `stats` if you need to enumerate sources to find the right one; never guess.\n• If the user only said something like "I changed my mind about that" — that\'s ambiguous; ask whether they want to forget the whole source or just amend a specific memory.\n\nThis is a soft delete by default — the user can recover via the Graphnosis App\'s Recover flow if they change their mind. Confirm with the user before calling unless they\'ve explicitly named the source.',
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
        description: 'DETERMINISM — Deterministic: a direct read of ground-truth graph state; identical calls return identical data, no LLM, no randomness.\n\nInspect the ground-truth state of the user\'s graphs — total/active/soft-deleted node counts per graph, plus a sample of node contents. Use this when the user asks "show me my graph" or to debug why `recall` returned nothing.',
        inputSchema: {
          type: 'object',
          properties: {
            includeNodes: { type: 'boolean', description: 'Include up to 20 node previews. Default false.' },
          },
        },
      },
      {
        name: 'develop',
        description: 'DETERMINISM — Mixed: memory retrieval is deterministic and auditable, but a local LLM then synthesises the plan, so the wording varies between runs. With no local LLM running it degrades to a fully deterministic raw-context dump.\n\nStrategic planning synthesised from the user\'s private knowledge graph. ' +
          'Call this when the user asks to "develop X", "plan Y", "think through Z with my knowledge", or wants a strategic analysis grounded in what they already know. ' +
          'The brain recalls relevant memory, then synthesises a full plan: Situation → Approach → Key Actions → Risks & Gaps → Next Step. ' +
          'All computation is LOCAL — no data leaves the user\'s machine. ' +
          'Respects sensitivity-tier policy (sensitive engrams may be excluded from recall). ' +
          'If Ollama is not running, returns the raw recalled context block for the AI to synthesise instead.\n\n' +
          'Returns a Markdown strategic plan (or raw recalled context when no local LLM is available) plus metadata about which memory nodes were referenced.',
        inputSchema: {
          type: 'object',
          properties: {
            context: {
              type: 'string',
              description: 'The domain or situation to develop a plan for (e.g. "my book project", "launching a product in Romania").',
            },
            strategy: {
              type: 'string',
              description: 'The approach or method to use (e.g. "bottom-up growth", "lean MVP", "focus on existing relationships").',
            },
            goals: {
              type: 'string',
              description: 'What success looks like (e.g. "publish a draft in 3 months", "reach 100 paying users").',
            },
            graphIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: restrict recall to specific engram IDs. If omitted, searches all accessible engrams.',
            },
            saveAsGoal: {
              type: 'boolean',
              description: 'If true, the resulting plan is also saved as a goal node in the first resolved engram, enabling periodic check-ins.',
            },
          },
          required: ['context', 'strategy', 'goals'],
        },
      },
      {
        name: 'predict',
        description: 'DETERMINISM — Mixed: memory retrieval is deterministic and auditable, but a local LLM then synthesises the risk/opportunity assessment, so the wording varies between runs.\n\nProactive risk and opportunity assessment BEFORE the user takes an action. ' +
          'Call this when the user is about to do something and asks "what does my memory say about this?" or "any risks I should know?" or "have I done anything like this before?". ' +
          'The brain recalls memory related to the proposed action and uses local AI to identify: past failures, resource or timeline constraints, dependencies or blockers, and overlooked opportunities. ' +
          'All computation is LOCAL — no data leaves the device. ' +
          'Returns structured risks, opportunities, a recommendation, and referenced memory node IDs.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              description: 'The action or decision the user is about to take (e.g. "hire a contractor for the redesign", "launch a new product line in Q3").',
            },
            graphIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional: restrict recall to specific engram IDs. If omitted, searches all accessible engrams.',
            },
          },
          required: ['action'],
        },
      },
      {
        name: 'insights',
        description: 'DETERMINISM — Non-deterministic: insights are generated by a local-LLM background loop, so the set of insights varies between runs. This tool only retrieves what was already computed.\n\nReturn the current pending brain insights — non-obvious patterns, gaps, opportunities, and conflicts detected by the background analysis loop across all engrams. ' +
          'Call this when the user asks "what has my brain noticed?", "any insights for me?", or "what patterns have you found?". ' +
          'Insights are generated automatically every 6 hours when Ollama is running; this tool retrieves what\'s already been computed — it does NOT trigger a new scan. ' +
          'Returns an array of insight objects with kind (pattern/gap/opportunity/conflict), title, body, and relevant node IDs.',
        inputSchema: {
          type: 'object',
          properties: {
            dismissed: {
              type: 'boolean',
              description: 'If true, include already-dismissed insights. Default false (active only).',
            },
          },
        },
      },
      {
        name: 'vitality',
        description: 'DETERMINISM — Deterministic: the vitality score is a fixed formula over current graph state; identical state yields an identical score, no LLM, no randomness.\n\nReturn the current vitality score for the user\'s knowledge graph — a 0-100 measure of how alive and well-connected the engrams are. ' +
          'Factors: connectivity (40%), average confidence (25%), recent activity (20%), and coherence — fewer unresolved duplicate pairs (15%). ' +
          'Call this when the user asks "how healthy is my brain?", "how active is my knowledge graph?", or "what\'s my vitality score?". ' +
          'Returns overall score plus per-engram breakdown.',
        inputSchema: {
          type: 'object',
          properties: {},
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

        // ── Resolve target engram ────────────────────────────────────
        //
        // Two name-bearing inputs converge into one resolver:
        //   - `graphId`     — explicit slug; preferred when the AI knows
        //                     the exact graph id.
        //   - `target_engram` — human-friendly name; preferred when the
        //                     AI is going off what the user typed.
        //
        // Behavior:
        //   - graphId provided AND exists      → write immediately.
        //   - graphId provided but UNKNOWN     → treat it as a target name
        //                                        and route through the same
        //                                        banner flow as target_engram.
        //                                        This catches AIs that guess
        //                                        a slug instead of using
        //                                        target_engram (e.g. claude
        //                                        passing graphId: "trademark"
        //                                        when no such graph exists).
        //   - target_engram provided           → fuzzy-resolve; if not exact,
        //                                        broadcast banner + return
        //                                        actionable error to the AI.
        //   - neither                          → defaultGraphId().
        //
        // The AI is told to relay the situation to the user and NOT retry —
        // the App handles the create-then-ingest two-step on user confirm.
        const knownGraphs = deps.host.listGraphs();
        let graphId: string | null = null;
        let unresolvedName: string | null = null;
        if (args.graphId && knownGraphs.includes(args.graphId)) {
          graphId = args.graphId;
        } else if (args.graphId) {
          // graphId points at a non-existent slug — promote to target name.
          unresolvedName = args.graphId;
        } else if (args.target_engram) {
          unresolvedName = args.target_engram;
        }

        if (graphId === null && unresolvedName !== null) {
          const resolution = resolveTargetEngram(deps.host, unresolvedName);
          if (resolution.kind === 'exact') {
            graphId = resolution.graphId;
          } else {
            // Either ambiguous (close matches exist) or none — both go
            // through the App banner, never through silent AI guess.
            // Truncate text payload for the broadcast; the App re-supplies
            // the full body via Tauri IPC when the user confirms, so we
            // don't ship 50KB over the socket.
            const candidates = resolution.kind === 'ambiguous' ? resolution.candidates : [];
            if (deps.broadcastRaw) {
              deps.broadcastRaw({
                kind: 'engram.create-suggested',
                name: unresolvedName,
                payload: {
                  suggestedName: unresolvedName,
                  label: args.label,
                  text: args.text,
                  preview: args.text.slice(0, 280),
                  sourceKind: args.kind ?? 'clip',
                  requestedBy: mcpRegistry.getMostRecentClientName() ?? 'an AI client',
                  candidates: candidates.map((c) => ({
                    graphId: c.graphId,
                    displayName: c.displayName,
                    score: Number(c.score.toFixed(2)),
                    reason: c.reason,
                  })),
                },
              });
            }
            // Compose an AI-facing error. When candidates exist, hint them
            // so the AI can correct itself on the next call instead of
            // re-asking the user; when none, list everything so the AI
            // can suggest alternatives without another tool round-trip.
            const lines: string[] = [];
            if (candidates.length) {
              lines.push(
                `No engram exactly matches "${unresolvedName}". ` +
                `Closest matches: ${candidates.map((c) => `"${c.displayName}"`).join(', ')}.`,
              );
              lines.push(
                `Tell the user: "I'd save this to '${unresolvedName}' but found similar engrams already — ` +
                `a banner in the Graphnosis App is asking which one to use (or create a new one)."`,
              );
            } else {
              const known = knownGraphs.join(', ');
              lines.push(
                `No engram named "${unresolvedName}" exists yet. ` +
                `Tell the user: "I'd save this to a new '${unresolvedName}' engram. ` +
                `A banner in the Graphnosis App is asking you to confirm — click Create there. ` +
                `It'll create the engram AND save this note in one click."`,
              );
              lines.push(`Existing engrams the user could pick instead: ${known}.`);
            }
            lines.push(`DO NOT retry this remember call. The App handles the ingest after the user confirms.`);
            return { isError: true, content: [{ type: 'text', text: lines.join('\n\n') }] };
          }
        } else if (graphId === null) {
          graphId = deps.defaultGraphId();
        }

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
        // Auto-switch. deps.llm() returns the Local LLM only when the user has
        // enabled it for this cortex. The Neural Network, when enabled, supplies
        // a GNN candidate expander. `correct` works in every combination and
        // never throws for a missing model.
        const llm = deps.llm();
        const gnnOn = deps.host.getSettings().brain?.neuralNetwork?.enabled === true;
        const expandWithGnn = (gnnOn && deps.brainEngine)
          ? buildGnnExpander(deps.host, deps.brainEngine)
          : undefined;
        const { diff, candidates, mode, targetGraphId } = await proposeCorrection({
          host: deps.host,
          llm,
          correction: args.correction,
          ...(args.graphId !== undefined ? { graphIdHint: args.graphId } : {}),
          ...(expandWithGnn ? { expandWithGnn } : {}),
        });
        const targetGraph =
          targetGraphId ?? args.graphId ?? candidates[0]?.graphId ?? deps.defaultGraphId();
        const diffId = `diff_${Date.now().toString(36)}`;
        deps.pendingDiffs.set(diffId, { graphId: targetGraph, diff, createdAt: Date.now() });
        // Surface to the App so it can refresh its pending-corrections
        // panel immediately AND fire a system notification when the
        // window's in the background. Without this broadcast the user
        // only sees the proposed diff when their poll cycle ticks, with
        // no nudge from the OS — easy to miss when they're elsewhere.
        if (deps.broadcastRaw) {
          deps.broadcastRaw({
            kind: 'correction.proposed',
            name: diffId,
            payload: {
              diffId,
              graphId: targetGraph,
              correction: args.correction,
              requestedBy: mcpRegistry.getMostRecentClientName() ?? 'an AI client',
              // Small preview for the notification body — count of changes
              // gives the user enough signal to decide whether to switch.
              changeCount: (diff.edits?.length ?? 0) + (diff.adds?.length ?? 0),
            },
          });
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ diffId, mode, preview: diff, candidates }, null, 2),
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
      case 'develop': {
        const args = z.object({
          context: z.string().min(1),
          strategy: z.string().min(1),
          goals: z.string().min(1),
          graphIds: z.array(z.string()).optional(),
          saveAsGoal: z.boolean().optional(),
        }).parse(req.params.arguments ?? {});
        if (!deps.brainEngine) {
          return { content: [{ type: 'text', text: 'Brain engine is not running. Open the Graphnosis app to enable it.' }] };
        }
        const plan = await deps.brainEngine.runDevelop({
          context: args.context,
          strategy: args.strategy,
          goals: args.goals,
          ...(args.graphIds ? { graphIds: args.graphIds } : {}),
        });
        const firstGraphId = plan.graphIds[0];
        if (args.saveAsGoal && firstGraphId) {
          await deps.brainEngine.ingestGoal(firstGraphId, plan);
        }
        return {
          content: [{
            type: 'text',
            text: plan.synthesisMarkdown +
              `\n\n---\n_Referenced ${plan.referencedNodeIds.length} memory nodes across engrams: ${plan.graphIds.join(', ')}_`,
          }],
        };
      }
      case 'predict': {
        const args = z.object({
          action: z.string().min(1),
          graphIds: z.array(z.string()).optional(),
        }).parse(req.params.arguments ?? {});
        if (!deps.brainEngine) {
          return { content: [{ type: 'text', text: 'Brain engine is not running. Open the Graphnosis app to enable it.' }] };
        }
        const result = await deps.brainEngine.runPredict({
          action: args.action,
          ...(args.graphIds ? { graphIds: args.graphIds } : {}),
        });
        if (result.degraded) {
          // No Local LLM — predict could not synthesise an assessment.
          // Hand the AI the raw recalled memory plus a clear, actionable note.
          const nodeNote = result.referencedNodeIds.length > 0
            ? `\n\n_Recalled ${result.referencedNodeIds.length} memory node(s)._`
            : '';
          return { content: [{ type: 'text', text:
            'The Local LLM is not enabled, so `predict` could not synthesise a risk/opportunity ' +
            'assessment. Below is the raw memory Graphnosis recalled for this action — assess it ' +
            'yourself, and let the user know they can enable the Local LLM in Graphnosis (the ' +
            '"Go Non-Deterministic" tab) for a structured prediction.' + nodeNote +
            '\n\n---\n\n' + (result.recommendation || 'No relevant memory found for this action.') }] };
        }
        const text = [
          result.risks.length > 0 ? `**Risks:**\n${result.risks.map(r => `- ${r}`).join('\n')}` : '',
          result.opportunities.length > 0 ? `**Opportunities:**\n${result.opportunities.map(o => `- ${o}`).join('\n')}` : '',
          result.recommendation ? `**Recommendation:** ${result.recommendation}` : '',
          result.referencedNodeIds.length > 0 ? `\n_Grounded in ${result.referencedNodeIds.length} memory node(s)_` : '',
        ].filter(Boolean).join('\n\n') || 'No relevant memory found for this action.';
        return { content: [{ type: 'text', text }] };
      }
      case 'insights': {
        const { dismissed } = z.object({ dismissed: z.boolean().optional() }).parse(req.params.arguments ?? {});
        if (!deps.brainEngine) {
          return { content: [{ type: 'text', text: JSON.stringify([]) }] };
        }
        if (!deps.llm()) {
          // Insights come from a background Local-LLM loop. With no LLM
          // enabled the loop never runs — tell the AI plainly rather than
          // returning a bare empty array it cannot interpret.
          return { content: [{ type: 'text', text:
            'The Local LLM is not enabled, so no insights are available — they are produced by a ' +
            'background local-LLM analysis loop. Tell the user they can enable the Local LLM in ' +
            'Graphnosis (the "Go Non-Deterministic" tab) to start generating insights.' }] };
        }
        const all = deps.brainEngine.getInsights();
        const filtered = dismissed ? all : all.filter(i => !i.dismissed);
        return { content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }] };
      }
      case 'vitality': {
        if (!deps.brainEngine) {
          return { content: [{ type: 'text', text: JSON.stringify({ overall: 0, byGraph: {}, computedAt: Date.now() }) }] };
        }
        const report = await deps.brainEngine.computeVitality();
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
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
