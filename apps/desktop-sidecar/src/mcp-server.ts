import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { markClientActivity } from './client-activity.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { isClientDisabled } from './admin-policy.js';
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import { proposeCorrection, applyCorrection, type GnnCandidateExpander } from './correction.js';
import { ingestClip } from './ingest.js';
import { withEmbedding } from './embedding-queue.js';
import { mcpRegistry } from './mcp-registry.js';
import type { BrainEngine } from './brain-engine.js';
import { createHmac, randomUUID } from 'node:crypto';
import { recordConsent, revokeConsent, policyGrantMs, type ClientPolicy, type ConsentPolicyChoice, type SharingScope } from '@graphnosis-app/core/settings';
import { registerPrompt as registerConsentPrompt, listPendingPrompts, recordGatedRequest, getGatedRequest, type ConsentEngram } from './consent-prompts.js';
import { constantTimeEqual } from './crypto-compare.js';
import type { ConsentRecord } from '@graphnosis-app/core/settings';
import { SkillTrainer, type ExportFormat } from './skill-trainer.js';
import { LicenseValidator } from './license-validator.js';

// ── Session-level data budget ─────────────────────────────────────────────────
// These caps apply per MCP connection (i.e. per AI client session). They exist
// to prevent an AI from systematically exfiltrating the entire personal graph
// through repeated recall calls — regardless of how politely it asks.
//
// Normal usage (a few targeted recalls per conversation) never gets close.
// A bulk-dump attempt hits the cap after 2–3 maxed-out recall calls.
// Session breadth cap kept — a single conversation touching > 6 distinct engrams
// is an enumeration signal regardless of total volume. Cheap to keep; almost never
// trips in legitimate use.
const SESSION_ENGRAM_BREADTH_CAP = 6;

// Recall rate limit — max N recall calls per window per client. Catches burst
// attacks where an agent fires many distinct queries in rapid succession.
const RECALL_RATE_WINDOW_MS = 60_000;
const RECALL_RATE_MAX = 10;

// Session replay blocker — reject a recall whose query is too similar to one
// recently seen from the same client. Catches systematic scans where an attacker
// re-issues the same (or near-same) query repeatedly to exhaust the result set
// or paginate through it. We use Jaccard similarity on token sets — semantically
// blunt (won't catch synonym attacks) but effective against the practical
// attack shapes: exact replays, reorderings, trivial paraphrases.
// Replay blocker: short window, count-based threshold. A user (or AI)
// re-running the same query once or twice is a normal retry; the 3rd
// identical query inside 60s starts to look like scraping. The 10-req/60s
// rate limit is a separate layer that catches slow-drip patterns.
const REPLAY_WINDOW_MS = 60_000;        // was 5 * 60_000
const REPLAY_JACCARD_THRESHOLD = 0.85;
const REPLAY_ALLOWED_REPEATS = 2;       // block the (N+1)-th similar query in the window

// MCP tools the App exposes to any AI client (Claude Desktop, Claude Code, Cursor, Zed, ...).
//
// - recall    : federated subgraph for a user query (read-only)
// - remember  : user-invoked "save this" inside an AI conversation
// - correct   : process a natural-language correction and return a preview diff (no write)
// - apply     : commit a previously-previewed diff after the user confirms in the app
// - forget    : soft-delete one or more specific memory nodes (never an entire source)
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
/**
 * Tolerant string-array schema. Accepts:
 *   - A real string array: `["iaADN", "personal"]` (the intended shape)
 *   - A stringified JSON array: `'["iaADN", "personal"]'` (some AI clients
 *     serialize array parameters as strings before sending — observed in
 *     practice with Claude Desktop on certain tool calls)
 *   - A single bare string: `"iaADN"` (treated as a one-element array,
 *     for AI clients that pass a single value without wrapping)
 *
 * Without this tolerance, the second + third cases fail Zod validation with
 * "expected array, got string" and the tool surfaces an opaque "Tool
 * execution failed" to the AI. Now they parse cleanly and the AI's intent
 * is respected.
 */
const tolerantStringArray = z.preprocess((val: unknown) => {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  // JSON-array-shaped string → try to parse.
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through to single-string interpretation */ }
  }
  // Bare string → wrap as single-element array.
  return [val];
}, z.array(z.string()).optional());

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
    only_engrams: tolerantStringArray,
    except_engrams: tolerantStringArray,
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
/**
 * Forget input — supports two shapes.
 *
 *   New (preferred): `items: [{ nodeId, preview }]`
 *     The `preview` is a short snippet (≤200 chars) of the node's content
 *     that the AI MUST pull from a prior `recall_structured` call. The
 *     point is human safety: most MCP clients show the request payload in
 *     their consent prompt before letting the tool run. With opaque
 *     nodeIds the user sees `nodeIds: ["LhahITlgoMi15eqOCLeWj"]` and has
 *     no way to decide whether to approve. With previews they see what
 *     they're about to lose.
 *
 *   Legacy: `nodeIds: ["..."]` (with JSON-string and bare-string coercion
 *     for older MCP clients).
 *
 * If the AI uses the legacy form, the handler will still execute (we don't
 * want to break clients mid-session) but the response includes a heads-up
 * telling the AI to populate previews next time. Once the field has been
 * available for a release or two we may flip this to a hard requirement.
 */
const ForgetInput = z.object({
  graphId: z.string(),
  // Preferred shape — each entry carries its own preview.
  items: z.array(z.object({
    nodeId: z.string().min(1),
    preview: z.string().min(1).max(200),
  })).min(1).max(20).optional(),
  // Legacy fallback. Tolerates JSON-string and bare-string serialization.
  nodeIds: z.union([z.string(), z.array(z.string())]).transform(v => {
    if (Array.isArray(v)) return v;
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed) && parsed.every((x: unknown) => typeof x === 'string')) return parsed as string[];
    } catch {}
    return [v];
  }).optional(),
}).refine(d => (d.items?.length ?? 0) >= 1 || (d.nodeIds?.length ?? 0) >= 1, {
  message: 'Provide either `items: [{nodeId, preview}]` (preferred) or `nodeIds: [...]` (legacy).',
}).refine(d => (d.nodeIds?.length ?? 0) <= 20, {
  message: 'Provide between 1 and 20 nodeIds per call.',
});
const BrowseEngramInput = z.object({
  engram: z.string(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
const RecentInput = z.object({
  engram: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});
const SuggestEngramInput = z.object({
  text: z.string(),
  top_k: z.coerce.number().int().positive().max(5).optional(),
});
const RecallStructuredInput = z.preprocess(
  (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const r = raw as Record<string, unknown>;
    if (!r.query && (r.q || r.question)) return { ...r, query: r.q ?? r.question };
    return raw;
  },
  z.object({
    query: z.string(),
    maxTokens: z.coerce.number().int().positive().max(8000).optional(),
    maxNodes: z.coerce.number().int().positive().max(50).optional(),
    only_engrams: tolerantStringArray,
    except_engrams: tolerantStringArray,
  }),
);
const RecallWithCitationsInput = RecallStructuredInput;
const FindSourceInput = z.object({
  keyword: z.string().optional(),
  content: z.string().optional(),
  engram: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
}).refine(d => d.keyword || d.content, {
  message: 'Provide at least one of: keyword (metadata search) or content (semantic node-content search).',
});
const RecallSourceInput = z.object({
  sourceId: z.string(),
  engram: z.string().optional(),
});
const CompareEngramsInput = z.object({
  query: z.string(),
  engram_a: z.string(),
  engram_b: z.string(),
  maxNodes: z.coerce.number().int().positive().max(20).optional(),
});
const EngramSummaryInput = z.object({
  engram: z.string(),
  sample_size: z.coerce.number().int().positive().max(30).optional(),
});
const CrossSearchInput = z.object({
  query: z.string(),
  engrams: z.array(z.string()).min(1),
  maxNodes: z.coerce.number().int().positive().max(50).optional(),
});
const TransferSourceInput = z.object({
  sourceId: z.string(),
  from_engram: z.string(),
  to_engram: z.string(),
});
const AuditMemoryInput = z.object({
  engrams: z.array(z.string()).optional(),
  threshold: z.coerce.number().min(0.5).max(1.0).optional(),
});
const CheckDuplicateInput = z.object({
  text: z.string(),
  engram: z.string().optional(),
  threshold: z.coerce.number().min(0.5).max(1.0).optional(),
});
const IngestBatchInput = z.object({
  items: z.array(z.object({
    text: z.string(),
    label: z.string().optional(),
    target_engram: z.string().optional(),
    graphId: z.string().optional(),
  })).min(1).max(20),
});
const GetEngramSchemaInput = z.object({
  engram: z.string(),
});
const DuplicatePairsInput = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
});
const ContradictionPairsInput = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
});
const HealingJournalInput = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
});
const GnnNeighborsInput = z.object({
  query: z.string(),
  engram: z.string().optional(),
  limit: z.coerce.number().int().positive().max(20).optional(),
});
const LlmQueryInput = z.preprocess(
  (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const r = raw as Record<string, unknown>;
    if (!r.question && r.query) return { ...r, question: r.query };
    return raw;
  },
  z.object({
    question: z.string(),
    only_engrams: tolerantStringArray,
    maxTokens: z.coerce.number().int().positive().max(8000).optional(),
  }),
);
const LlmDistillInput = z.object({
  text: z.string(),
  target_engram: z.string().optional(),
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

function mcpError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

// ── Anomaly heads-up ──────────────────────────────────────────────────────
//
// A handful of tool results carry signals that are hard for the AI to judge
// on its own — a recall that scanned 8 engrams and returned 2 nodes, a
// `correct` that found zero candidates for the asserted fact, a vitality
// drop of 30 points since the previous call. Each of those is plausibly a
// real anomaly the user should hear about, AND a feedback loop into the
// developer (Nelu) about where the app's retrieval / scoring / scheduling
// is misbehaving.
//
// The heads-up is opt-in per signal: `anomalyHeadsUp` returns null in the
// normal case and a one-line "⚠️ _Heads-up for the user: ..._" string only
// when a real signal fires. Tools append it (or not) to their existing
// response footer; the AI then surfaces it to the user verbatim per the
// note "tell the user, ask them to report back."
//
// DO NOT spam this. Every false positive trains the AI to ignore the next
// real one. Thresholds below are deliberately conservative — they fire on
// situations where, if you saw the numbers yourself, you'd raise an eyebrow.
type AnomalySignals =
  | {
      kind: 'recall';
      nodesReturned: number;
      nodesRequested: number;
      engramsContributing: number;
      engramsSearched: number;
      query: string;
      tool: string; // 'recall' | 'remind' | 'recall_structured' | …
    }
  | { kind: 'edit'; candidatesFound: number }
  | { kind: 'vitality'; overall: number; previous: number | null };

// Tracks the vitality reading from the previous `vitality` call so we can
// flag sudden drops. Per-process; resets on sidecar restart, which is fine —
// boot-time vitality is already noisy and we don't want false alarms there.
let _lastVitalityReading: number | null = null;

function anomalyHeadsUp(s: AnomalySignals): string | null {
  if (s.kind === 'recall') {
    // ── Tier 1: zero results — always escalate regardless of engram count. ──
    // A zero-result recall is almost always a retrieval miss, not missing
    // memory. Language mismatch, synonyms, abbreviations — all common causes.
    if (s.nodesReturned === 0) {
      const escalationNote = s.tool === 'dig_deeper'
        ? ' If you are sure the memory exists, mention it to the developer — this is the kind of recall miss the team is actively tuning.'
        : ` CALL \`dig_deeper\` NOW with the same query — it adds source-filename expansion, cross-engram entity hop, and GNN graph expansion on top of standard recall, and routinely recovers memory that bare \`${s.tool}\` misses. Only if \`dig_deeper\` also returns nothing should you tell the user the memory isn't there.`;
      return (
        `\n\n⚠️ _Heads-up: \`${s.tool}\` returned 0 nodes` +
        (s.engramsSearched > 1 ? ` after searching ${s.engramsSearched} engrams` : '') +
        `. This is almost always a retrieval miss, not absent memory — ` +
        `common causes: query language differs from how the note was stored, synonym or phrasing gap, ` +
        `or the user searched with too short a fragment.${escalationNote}_`
      );
    }
    // ── Tier 2: 1–3 results — escalate when the result set is suspiciously thin. ──
    // Threshold matches the stated policy (0–3) and fires regardless of
    // engram count (the old gate of ≥ 3 engrams silently swallowed single-engram
    // cortexes).
    if (s.nodesReturned <= 3 && s.nodesRequested >= 5) {
      const escalationNote = s.tool === 'dig_deeper'
        // dig_deeper already IS the escalation — no further tool to retry with.
        ? ' If you are sure the memory exists, mention it to the developer — this is the kind of recall miss the team is actively tuning.'
        // For recall/remind/cross_search/etc., direct the AI to escalate.
        : ` BEFORE telling the user this is all there is, call \`dig_deeper\` with the same query — it adds source-filename expansion, cross-engram entity hop, and GNN graph expansion on top of standard recall, and routinely finds memory bare \`${s.tool}\` misses. Only if \`dig_deeper\` also returns ≤ 3 nodes should you conclude the topic is genuinely sparse.`;
      return (
        `\n\n⚠️ _Heads-up: \`${s.tool}\` searched ${s.engramsSearched} engram${s.engramsSearched === 1 ? '' : 's'} ` +
        `but returned only ${s.nodesReturned} node(s) for a request of ${s.nodesRequested}. ` +
        `Common causes: query language doesn't match how the memory was stored, ` +
        `phrasing is too different from the original notes, or the relevant engram ` +
        `genuinely has nothing on this.${escalationNote}_`
      );
    }
    // Dominance: many engrams searched, only one contributed. Usually fine
    // (the topic really does live in one place) but occasionally a sign that
    // a more relevant engram was crowded out by per-graph token floors or
    // an embedding-model mismatch. Threshold deliberately high so we only
    // flag the egregious cases.
    if (
      s.engramsContributing === 1 &&
      s.engramsSearched >= 6 &&
      s.nodesReturned >= 5
    ) {
      return (
        `\n\n⚠️ _Heads-up for the user: all ${s.nodesReturned} returned nodes came from a single engram ` +
        `despite ${s.engramsSearched} being searched. If you expected results from another engram, ` +
        `consider scoping the recall with \`only_engrams\` or letting the developer know which engram ` +
        `you thought should have contributed._`
      );
    }
    return null;
  }
  if (s.kind === 'edit') {
    if (s.candidatesFound === 0) {
      return (
        `\n\n⚠️ _Heads-up for the user: \`edit\` found no existing memory nodes that match ` +
        `the assertion. The edit was saved as a pending diff anyway, but it may not ` +
        `actually supersede anything. If you expected an existing memory to be replaced, the ` +
        `engram hint may be wrong, or the original note is phrased very differently — worth ` +
        `flagging to the developer if this keeps happening._`
      );
    }
    return null;
  }
  if (s.kind === 'vitality') {
    if (s.previous !== null && s.overall < s.previous - 15) {
      return (
        `\n\n⚠️ _Heads-up for the user: vitality dropped from ${s.previous} to ${s.overall} ` +
        `since the last check (>15 points). Common causes: a large source was just ingested ` +
        `and is still settling, or a background brain pass detected staleness. If the drop ` +
        `persists across several checks without a clear trigger, mention it to the developer._`
      );
    }
    return null;
  }
  return null;
}

/**
 * Consent-required signal. Thrown by `checkConsentOrThrow` and caught in
 * the CallTool dispatcher so the structured notice ends up as a normal
 * tool-call response with `isError: true` — instead of a JSON-RPC
 * `-32603 Internal Error`. Claude (and most MCP clients) render generic
 * `-32603` failures as "Tool execution failed" without surfacing the
 * embedded message, so the user never saw the actual consent
 * instructions. Returning via the tool-result path keeps the full text
 * in the AI's context where the consent protocol expects it.
 */
class ConsentRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentRequiredError';
  }
}

/** Thrown by assertWriteAllowed() when a viewer-role sharing token attempts a write. */
class ScopeViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeViolationError';
  }
}

function resolveEngramList(
  host: GraphnosisHost,
  names: string[],
): { resolved: string[]; warnings: string[] } {
  const resolved: string[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const r = resolveTargetEngram(host, name);
    if (r.kind === 'exact') resolved.push(r.graphId);
    else if (r.kind === 'ambiguous') {
      const first = r.candidates[0];
      if (first) resolved.push(first.graphId);
    } else {
      warnings.push(`No engram matched "${name}" — skipped.`);
    }
  }
  return { resolved, warnings };
}

function requireEngram(
  host: GraphnosisHost,
  name: string,
): { graphId: string } | { error: ReturnType<typeof mcpError> } {
  const r = resolveTargetEngram(host, name);
  if (r.kind === 'exact') return { graphId: r.graphId };
  if (r.kind === 'none') return { error: mcpError(`No engram matched "${name}". Call list_engrams to see available engrams.`) };
  return { error: mcpError(`Ambiguous: did you mean ${r.candidates.map(c => `"${c.displayName}" (${c.graphId})`).join(', ')}?`) };
}

/**
 * Returns a notice string (or empty string) when one or more engrams are
 * known to the cortex but haven't been loaded into memory yet — typically a
 * transient boot-lag state, but also triggered when a load previously failed.
 *
 * Inject this into any tool response that searches or enumerates engrams so
 * the AI client can inform the user that results may be incomplete.
 *
 * Format: "\n\n⚠️ Engram(s) still loading: …" — or "" when everything is up.
 */
function pendingEngramNotice(host: GraphnosisHost): string {
  const all = host.graphsWithMetadata({ includeUnloaded: true });
  const pending = all.filter(e => !e.loaded && !(e.metadata as any).archived);
  if (pending.length === 0) return '';
  const names = pending
    .map(e => e.metadata.displayName ?? e.graphId)
    .join(', ');
  return (
    `\n\n⚠️ ${pending.length} engram${pending.length === 1 ? '' : 's'} exist` +
    ` but ${pending.length === 1 ? 'is' : 'are'} not loaded yet: ${names}. ` +
    `Search results may be incomplete. Tell the user Graphnosis is still warming up ` +
    `and to try again in a moment, or to check the app for any load errors.`
  );
}

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

/**
 * Local-LLM capability requested by a call site. Each MCP tool that hits the
 * LLM passes the capability it represents; `deps.llm(cap)` returns the LLM
 * only when (a) the master switch is on AND (b) that specific capability
 * is enabled in settings. Replaces the old single-toggle gate so users can
 * keep e.g. `recallEnrichment` on while disabling autonomous `insights`.
 */
export type LlmCapability =
  | 'correctionParsing'
  | 'distillation'
  | 'insights'
  | 'edgePrediction';

/** Returns the highest-tier valid license token across the personal slot
 *  and the domain seat slot. Mirrors the same helper in ipc.ts. */
async function getEffectiveLicenseToken(deps: McpDeps): Promise<string | null> {
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

export interface McpDeps {
  host: GraphnosisHost;
  llm: (capability: LlmCapability) => LocalLlm | null;
  /** Default graph for ambient remember when no graphId is provided. */
  defaultGraphId: () => string;
  /** UI hook so a "correction proposed" notification fires for the user to confirm. */
  pendingDiffs: Map<string, { graphId: string; diff: import('./correction.js').CorrectionDiff; createdAt: number; mode?: 'deterministic' | 'gnn-expanded' | 'llm-assisted'; prompt?: string }>;
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
  /**
   * Skill trainer — provides train_skill, skill_vitality, export_skill tools.
   * Created at startup alongside the brain engine. Optional: absent in test /
   * smoke-test contexts where no full host is wired.
   */
  skillTrainer?: SkillTrainer | null;
  /**
   * License validator — verifies Ed25519-signed tokens from the Nehloo signing
   * service. Used to gate subscription-only features (currently: skill training).
   * Optional: absent in smoke-test / standalone contexts; callers treat absence
   * as "unlicensed" (same as `hasFeature` returning false).
   */
  licenseValidator?: LicenseValidator | null;
  /**
   * Sharing scope for this MCP session. Present when the session was opened
   * with a scoped sharing token (not the owner's master token). Enforces:
   *   - engram filter: only the listed engrams are visible
   *   - role gate: 'viewer' tokens reject remember/forget/edit calls
   * Absent (undefined) means the owner connected — no restrictions.
   */
  sharingScope?: SharingScope | null;
  /** Absolute path to the cortex directory. Used for GEZ signing-key storage. */
  cortexDir?: string;
}

/** Single MCP tool result — matches the MCP SDK CallToolResult shape. */
export type McpToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/**
 * Callable dispatcher for all 47+ MCP tool handlers.
 * Returned alongside the Server from createMcpServer so Ghampus and other
 * internal callers can reuse the exact same implementations without going
 * through the network transport or duplicating logic.
 */
export type McpCallTool = (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;

/**
 * Build a fresh MCP `Server` instance with all of Graphnosis' tools wired up.
 * The returned server is **unconnected** — caller decides which transport to
 * bind it to (stdio, Unix socket, etc.). The tool handlers close over `deps`,
 * so multiple Servers built from the same `deps` share one host + pendingDiffs
 * state — exactly what we want when one sidecar serves multiple MCP clients.
 */
// ── Consent phrase engine ─────────────────────────────────────────────────────
//
// Generates a rotating human-readable consent phrase from an HMAC-SHA256 digest
// of the cortex's secret key. The phrase is displayed ONLY in the Graphnosis app
// UI — never returned via any MCP tool, IPC response, or log line. The AI client
// relays what the user physically typed; it can never know the phrase in advance.
//
// Security:
//   - 256 words → 256^3 = ~16.7M combinations per window
//   - 5-attempt lockout eliminates brute force
//   - Phrase rotates every 24h (personal) / 1h (sensitive)
//   - Word list is public (FSL source-available) — security is from the HMAC key

const PERSONAL_WINDOW_MS  = 24 * 60 * 60 * 1000; // 24 hours
const SENSITIVE_WINDOW_MS =       60 * 60 * 1000; // 1 hour

const CONSENT_WORD_LIST: readonly string[] = [
  // A
  'acorn','adapt','affix','agile','alarm','album','alert','align',
  'alloy','amber','amend','ample','angel','angle','annex','anvil',
  'apart','apple','apron','arbor','arena','arise','armor','aroma',
  'array','asset','atlas','attic','audio','audit','awake','axiom',
  // B
  'badge','baker','banjo','basin','batch','baton','beach','bench',
  'birch','blade','blank','blend','block','bloom','board','brave',
  'bread','brick','brief','brine','brook','brush','build','burst',
  // C
  'cabin','cable','camel','canal','cargo','cedar','chain','chalk',
  'charm','chart','chase','chess','chief','chill','chord','chunk',
  'civic','clamp','clash','clasp','clean','clear','click','cliff',
  'cloud','comet','coral','couch','count','court','crank','creek',
  'crisp','cross','crown','crush','crust','cycle','dance','datum',
  // D-E
  'depot','depth','drift','drill','drink','drums','dunes','eagle',
  'earth','ember','epoch','exact','extra',
  // F
  'feast','fence','fever','fiber','field','finch','fixed','flame',
  'flash','fleet','flick','flock','flood','floor','flora','fluid',
  'flute','focus','forge','forte','forum','fresh','frost','fruit',
  // G
  'gavel','gauge','gleam','glide','globe','grace','grade','grain',
  'grasp','great','green','greet','grind','group','grove','guard',
  'guild','gulch','gusto',
  // H
  'hatch','haven','heron','holly','honor','horde',
  // I-J
  'ideal','image','infer','inlet','input','ivory','jewel','joint',
  'judge','jumbo','juror',
  // K-L
  'kayak','knife','knock','known','lance','large','laser','latch',
  'layer','ledge','lemon','level','light','limit','linen','liver',
  'local','lodge','logic','lunar',
  // M
  'maple','march','match','maxim','media','merge','metal','might',
  'model','month','moral','motor','mount','muddy','mural','music',
  // N-O
  'nerve','nexus','niche','noble','noise','north','notch','novel',
  'nudge','ocean','onset','optic','orbit','order','organ','outer',
  'oxide','ozone',
  // P
  'panel','pause','pearl','pedal','perch','phase','pinch','pixel',
  'pivot','place','plain','plank','plant','plaza','pluck','plume',
  'point','polar','power','prism','probe','proud','pulse',
  // Q-R
  'quake','query','quiet','quota','radar','rapid','ratio','reach',
  'realm','rebel','relay','resin','ridge','rivet','robot','rocky',
  'rough','round','route','royal','ruddy','ruler','rural',
  // S
  'scout','serum','shard','sharp','sheen','shelf','shine','shock',
  'shore','sigma','sixth','slash','sleek','slide','slope','smart',
  'smoke','solar','solid','solve','south','spark','speak','spear',
  'speck','speed','spell','spice','spike','spine','spire','spoke',
  'spoon','sport','spray','squad','stack','staff','stage','stake',
  'stalk','stamp','stand','stark','start','state','steam','steel',
  'steep','stern','stick','still','stone','storm','stout','strap',
  'stray','strip','strut','study','style','surge','swamp','swift',
  'sword','swirl',
  // T
  'table','tapir','tardy','tempo','tense','tidal','tiger','trace',
  'track','trail','train','trait','trawl','trend','trial','tribe',
  'trove','truce','truly','trunk','trust','twist',
  // U-V
  'ultra','union','unity','upper','urban','usher','utter','valid',
  'valor','valve','vault','viola','viral','vista','vivid','voice',
  'volts','voter',
  // W-Z
  'wedge','weigh','weird','whirl','widen','winch','witch','witty',
  'world','worth','wreck','yacht','yield','young','youth','zebra',
  'zesty','zippy',
] as const;

/** AI client → privacy policy URL (best-effort; unknown clients get a generic notice). */
const PROVIDER_PRIVACY_URLS: Record<string, string> = {
  'claude-ai':   'https://www.anthropic.com/privacy',
  'claude-code': 'https://www.anthropic.com/privacy',
  'cursor':      'https://www.cursor.com/privacy',
  'zed':         'https://zed.dev/privacy',
  'continue':    'https://www.continue.dev/privacy',
  'windsurf':    'https://www.codeium.com/privacy',
};

/** Generate the current consent phrase for a tier. Never logged or returned via MCP. */
function generateConsentPhrase(hmacKey: string, tier: 'personal' | 'sensitive'): string {
  const windowMs = tier === 'sensitive' ? SENSITIVE_WINDOW_MS : PERSONAL_WINDOW_MS;
  const slot = Math.floor(Date.now() / windowMs);
  const digest = createHmac('sha256', Buffer.from(hmacKey, 'hex'))
    .update(`${tier}:${slot}`)
    .digest();
  const n = CONSENT_WORD_LIST.length;
  return [digest[0]! % n, digest[1]! % n, digest[2]! % n]
    .map((i) => CONSENT_WORD_LIST[i])
    .join(' ');
}

/** Validate a user-typed phrase. Accepts current + previous window (60s grace). */
function validateConsentPhrase(hmacKey: string, tier: 'personal' | 'sensitive', input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return false;
  if (constantTimeEqual(normalized, generateConsentPhrase(hmacKey, tier))) return true;
  // Grace period: also accept previous window to handle boundary clock skew.
  const windowMs = tier === 'sensitive' ? SENSITIVE_WINDOW_MS : PERSONAL_WINDOW_MS;
  const prevSlot = Math.floor((Date.now() - 60_000) / windowMs);
  const currSlot = Math.floor(Date.now() / windowMs);
  if (prevSlot !== currSlot) {
    const digest = createHmac('sha256', Buffer.from(hmacKey, 'hex'))
      .update(`${tier}:${prevSlot}`)
      .digest();
    const n = CONSENT_WORD_LIST.length;
    const prev = [digest[0]! % n, digest[1]! % n, digest[2]! % n]
      .map((i) => CONSENT_WORD_LIST[i])
      .join(' ');
    if (constantTimeEqual(normalized, prev)) return true;
  }
  return false;
}

/**
 * Check consent validity against the EFFECTIVE interval for this (client, tier),
 * which is the stricter of: the stored record's own expiresAt, and the current
 * effective interval computed from global settings + per-graph overrides.
 */
function checkConsentValid(
  consents: ConsentRecord[] | undefined,
  clientName: string,
  tier: 'personal' | 'sensitive',
  effectiveIntervalMs: number,
  graphId?: string,
): boolean {
  if (!consents?.length) return false;
  const now = Date.now();
  return consents.some(
    (r) =>
      r.clientName === clientName &&
      r.tier === tier &&
      // Per-engram scoping (#14): when a specific engram is being checked, only
      // a grant for THAT engram counts. A legacy tier-wide record (no graphId)
      // never matches a specific engram, so it no longer unlocks every engram
      // of the tier — the user is re-prompted once per engram.
      (graphId === undefined || r.graphId === graphId) &&
      r.withdrawnAt === undefined &&
      r.expiresAt > now &&
      (effectiveIntervalMs === -1 || r.grantedAt + effectiveIntervalMs > now),
  );
}

// In-memory failed-attempt tracker per (clientName:tier). Resets on sidecar restart.
const _consentFailures = new Map<string, { count: number; windowStart: number }>();
const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 10 * 60_000; // 10 minutes

function trackConsentFailure(
  clientName: string,
  tier: 'personal' | 'sensitive',
): { lockedOut: boolean; count: number } {
  const key = `${clientName}:${tier}`;
  const now = Date.now();
  const prev = _consentFailures.get(key);
  if (!prev || now - prev.windowStart > LOCKOUT_WINDOW_MS) {
    _consentFailures.set(key, { count: 1, windowStart: now });
    return { lockedOut: false, count: 1 };
  }
  const count = prev.count + 1;
  _consentFailures.set(key, { count, windowStart: prev.windowStart });
  return { lockedOut: count >= LOCKOUT_MAX_ATTEMPTS, count };
}

function clearConsentFailures(clientName: string, tier: 'personal' | 'sensitive'): void {
  _consentFailures.delete(`${clientName}:${tier}`);
}

/** Public API for ipc.ts: generate the phrase for a tier + compute its expiry time. */
export function getConsentPhraseForTier(
  hmacKey: string,
  tier: 'personal' | 'sensitive',
): { phrase: string; expiresAt: number } {
  const windowMs = tier === 'sensitive' ? SENSITIVE_WINDOW_MS : PERSONAL_WINDOW_MS;
  const slot = Math.floor(Date.now() / windowMs);
  const phrase = generateConsentPhrase(hmacKey, tier);
  const expiresAt = (slot + 1) * windowMs;
  return { phrase, expiresAt };
}

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

TOOL SCHEMA LOADING: If your client uses lazy schema loading (Anthropic's \`tool_search\` and similar layers), call \`tool_search("graphnosis")\` once near the start of any conversation that might need these tools — this ensures parameter names are loaded before you invoke \`recall\`, \`remember\`, \`remind\`, \`edit\`, \`forget\`, or \`stats\`. If you skip this step, the tools still accept common parameter-name guesses (e.g. \`note\` for \`remember\`, \`q\`/\`question\` for \`recall\`/\`remind\`), but loading the real schema is more reliable.

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

WHEN TO CALL \`edit\`:
• The user says something stored is wrong — in any language. Don't try to fix the graph via \`remember\` — that creates conflicting duplicates. Use \`edit\` to propose a structured diff; the user approves it inside the Graphnosis App.
• The user wants to update something that has evolved ("my plans changed", "the deadline moved", "I moved to a new role").
• The user wants to add details or new items to something already stored ("add these tasks to my project plan", "append this to my meeting notes").
• A recall result contradicts something the user just said — surface the contradiction and offer \`edit\`.

WHEN NOT TO USE THESE TOOLS:
• General knowledge questions ("what's the capital of France"). The graph is personal context, not a world-fact lookup.
• Math, code generation, and tasks that don't depend on the user's history.

UX guidelines:
• Be quiet about it. Don't announce "I'll check your memory" every time — just call recall/remind and use the result. The user sees an audit log if they want to know.
• Ask the smallest budget that answers the question (default 1000–2000 tokens is plenty).
• If a result contradicts something the user just said, surface the contradiction gently in the user's own language and offer to \`edit\`.

The graph is end-to-end encrypted on disk and never leaves the user's machine.

CONSENT PROTOCOL — MANDATORY:
When a recall tool returns a message beginning with "⚠️ GRAPHNOSIS CONSENT REQUIRED", you MUST:
1. Display the COMPLETE notice to the user. Do not summarize, shorten, or paraphrase it.
2. Tell the user to open the Graphnosis app → Settings → AI → Consent Phrases to get the phrase.
3. Wait for the user to type the phrase. Do not suggest, guess, or autocomplete it.
4. Call confirm_data_access({ phrase: "<exactly what they typed>", tier: "<tier>" }).
5. Only after a successful confirm_data_access response, retry the original recall.

NEVER supply the phrase yourself. NEVER call confirm_data_access before the user has opened the Graphnosis app and typed the phrase. This protocol exists to ensure a human — not an AI — authorizes access to personal data.

If the user types SKIP, acknowledge and do NOT retry the recall. No data will be returned for that turn.`;

export function createMcpServer(deps: McpDeps): { server: Server; callTool: McpCallTool } {
  // Read the toggle live each time a fresh MCP server is built (per
  // session, per relay). When OFF, we leave `instructions` undefined so
  // the AI sees the tools but gets no system-prompt-level routing —
  // useful when the user wants their AI client's own memory features
  // to lead and Graphnosis to be one option among many.
  const useAsDefaultMemory = deps.host.getSettings().ai.useAsDefaultMemory;

  // ── User tool-exposure allowlist (Pro/Teams/Enterprise feature) ───────────
  // The user can DISABLE specific MCP tools so AI clients can't see or call
  // them (Settings → MCP Tools). Enforced server-side in TWO places below —
  // tools/list (filtered out) and tools/call (rejected) — because the UI can
  // never be the security boundary. Read LIVE per request (never captured in a
  // closure) so a change takes effect immediately, the way useAsDefaultMemory
  // and the consent settings already are. Stored as a DENYLIST: default empty =
  // everything on, so existing users and newly-added tools are unaffected.
  //
  // NO tool is force-on: the user may disable ANY tool — including recall — to
  // build, e.g., a "Remember-only" surface (AI clients can save but not read).
  // This never bricks Graphnosis: the app's own UI uses direct IPC, not MCP, so
  // disabling tools only narrows what AI clients can do, and "Expose all"
  // restores everything. (Disabling confirm_data_access drops only the HEADLESS
  // consent fallback; the in-app consent modal is unaffected.)
  const disabledToolSet = (): Set<string> =>
    new Set(deps.host.getSettings().ai.disabledMcpTools ?? []);

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

  // ── Per-client recall guardrails state (in-memory, per process) ────────────
  // These maps live for the lifetime of the sidecar. Restarting Graphnosis
  // clears the rate-limit and replay windows — intentional, since the threat
  // model is "active session abuse", not "long-term forensic tracking".
  const recallTimestamps: Map<string, number[]> = new Map();
  interface ReplayEntry { ts: number; tokens: Set<string>; queryPreview: string; }
  const recentQueries: Map<string, ReplayEntry[]> = new Map();

  function normalizeQuery(q: string): Set<string> {
    return new Set(
      q.toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3),
    );
  }

  function jaccardSet(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1;
    if (a.size === 0 || b.size === 0) return 0;
    let intersection = 0;
    for (const x of a) if (b.has(x)) intersection++;
    return intersection / (a.size + b.size - intersection);
  }

  // ── Rate limit ────────────────────────────────────────────────────────────
  // Throws if the calling client has already issued RECALL_RATE_MAX recalls in
  // the last RECALL_RATE_WINDOW_MS. Catches burst attacks. Always trips before
  // the replay blocker (cheap O(1) prune vs. O(N) set comparison).
  function enforceRecallRateLimit(): void {
    const connId = mcpRegistry.getMostRecentActiveId();
    if (!connId) return;
    const now = Date.now();
    const cutoff = now - RECALL_RATE_WINDOW_MS;
    const pruned = (recallTimestamps.get(connId) ?? []).filter((t) => t > cutoff);
    if (pruned.length >= RECALL_RATE_MAX) {
      const oldest = pruned[0]!;
      const waitMs = oldest + RECALL_RATE_WINDOW_MS - now;
      if (deps.broadcastRaw) {
        deps.broadcastRaw({
          kind: 'mcp.recall-rate-limited',
          name: connId,
          payload: {
            recentCalls: pruned.length,
            windowMs: RECALL_RATE_WINDOW_MS,
            maxPerWindow: RECALL_RATE_MAX,
            waitMs,
          },
        });
      }
      console.error(`[rate-limit] EXCEEDED connId=${connId} count=${pruned.length}/${RECALL_RATE_MAX}`);
      throw new Error(
        `Recall rate limit exceeded — ${pruned.length} recalls in the last ${Math.round(RECALL_RATE_WINDOW_MS / 1000)}s. ` +
        `Maximum is ${RECALL_RATE_MAX} per ${Math.round(RECALL_RATE_WINDOW_MS / 1000)}s. ` +
        `Wait ~${Math.ceil(waitMs / 1000)}s and try again. ` +
        `This is a Graphnosis security guardrail.`,
      );
    }
    pruned.push(now);
    recallTimestamps.set(connId, pruned);
  }

  // ── Session replay blocker ────────────────────────────────────────────────
  // Throws if the user's query is highly similar (Jaccard ≥ 0.85) to one issued
  // in the last REPLAY_WINDOW_MS by the same client. Catches systematic memory
  // scraping via repeated/near-repeated queries.
  function enforceReplayBlocker(query: string): void {
    const connId = mcpRegistry.getMostRecentActiveId();
    if (!connId) return;
    const now = Date.now();
    const cutoff = now - REPLAY_WINDOW_MS;
    const pruned = (recentQueries.get(connId) ?? []).filter((e) => e.ts > cutoff);
    const tokens = normalizeQuery(query);
    if (tokens.size === 0) {
      recentQueries.set(connId, pruned);
      return;
    }
    // Count how many recent queries are similar enough to this one.
    // We block ONLY when the count is already at REPLAY_ALLOWED_REPEATS —
    // i.e. this incoming call would be the 3rd identical query in the
    // window. First two identical queries pass (natural retries).
    let mostRecentSimilar: typeof pruned[number] | null = null;
    let similarCount = 0;
    for (const prev of pruned) {
      const sim = jaccardSet(tokens, prev.tokens);
      if (sim >= REPLAY_JACCARD_THRESHOLD) {
        similarCount += 1;
        if (!mostRecentSimilar || prev.ts > mostRecentSimilar.ts) mostRecentSimilar = prev;
      }
    }
    if (similarCount >= REPLAY_ALLOWED_REPEATS && mostRecentSimilar) {
      const ref = mostRecentSimilar;
      const ageS = Math.round((now - ref.ts) / 1000);
      const sim = jaccardSet(tokens, ref.tokens);
      if (deps.broadcastRaw) {
        deps.broadcastRaw({
          kind: 'mcp.session-replay-blocked',
          name: connId,
          payload: {
            similarity: Math.round(sim * 100) / 100,
            previousQuery: ref.queryPreview,
            ageSeconds: ageS,
            priorRepeats: similarCount,
          },
        });
      }
      console.error(`[replay] BLOCKED connId=${connId} sim=${sim.toFixed(2)} repeats=${similarCount} ageS=${ageS}`);
      throw new Error(
        `Session replay detected — this is the ${similarCount + 1}th identical query in ${Math.round(REPLAY_WINDOW_MS / 1000)} seconds. ` +
        `Modify your query meaningfully or wait ${Math.round(REPLAY_WINDOW_MS / 1000)}s. ` +
        `This is a Graphnosis security guardrail that prevents systematic memory scraping.`,
      );
    }
    pruned.push({ ts: now, tokens, queryPreview: query.slice(0, 80) });
    recentQueries.set(connId, pruned);
  }

  // ── Session-cap enforcement (opt-in by user) ──────────────────────────────
  //
  // All three caps default to disabled. Power users / extra-protective users
  // can enable them in Settings → AI to add cumulative-volume backstops on top
  // of the consent gate + rate limit + replay blocker.
  //
  // Tracked stats are recorded regardless of enable state so the UI can show
  // "how much did this conversation consume" even when no cap is enforced.
  function enforceSessionBudget(tokens: number, nodes: number, engramId?: string): void {
    const connId = mcpRegistry.getMostRecentActiveId();
    if (!connId) return;
    const stats = mcpRegistry.trackDataServed(connId, tokens, nodes);
    const aiSettings = deps.host.getSettings().ai;

    // Token cap — only enforced when user opted in.
    if (aiSettings.sessionTokenCapEnabled === true) {
      const cap = aiSettings.sessionTokenCap ?? 100_000;
      if (stats.tokensServed > cap) {
        if (deps.broadcastRaw) {
          deps.broadcastRaw({
            kind: 'mcp.session-budget-exceeded',
            name: connId,
            payload: {
              tokensServed: stats.tokensServed,
              nodesServed: stats.nodesServed,
              sessionTokenCap: cap,
              sessionNodeCap: aiSettings.sessionNodeCap ?? 500,
            },
          });
        }
        throw new Error(
          `Session token cap exceeded (${stats.tokensServed.toLocaleString()}/${cap.toLocaleString()} tokens). ` +
          `Start a new conversation to reset. Configurable in Settings → AI.`,
        );
      }
    }

    // Node cap — only enforced when user opted in.
    if (aiSettings.sessionNodeCapEnabled === true) {
      const cap = aiSettings.sessionNodeCap ?? 500;
      if (stats.nodesServed > cap) {
        if (deps.broadcastRaw) {
          deps.broadcastRaw({
            kind: 'mcp.session-budget-exceeded',
            name: connId,
            payload: {
              tokensServed: stats.tokensServed,
              nodesServed: stats.nodesServed,
              sessionTokenCap: aiSettings.sessionTokenCap ?? 100_000,
              sessionNodeCap: cap,
            },
          });
        }
        throw new Error(
          `Session node cap exceeded (${stats.nodesServed}/${cap} nodes). ` +
          `Start a new conversation to reset. Configurable in Settings → AI.`,
        );
      }
    }

    // Breadth cap — only enforced when user opted in. Tracking always happens
    // because it's cheap and useful for the UI's "this session touched N engrams" stat.
    if (engramId) {
      const breadth = mcpRegistry.trackEngramAccess(connId, engramId);
      if (aiSettings.sessionBreadthCapEnabled === true) {
        const cap = aiSettings.sessionBreadthCap ?? SESSION_ENGRAM_BREADTH_CAP;
        if (breadth > cap) {
          if (deps.broadcastRaw) {
            deps.broadcastRaw({
              kind: 'mcp.bulk-access-warning',
              name: connId,
              payload: {
                uniqueEngramsAccessed: breadth,
                tokensServed: stats.tokensServed,
                nodesServed: stats.nodesServed,
              },
            });
          }
          throw new Error(
            `Session engram-breadth cap exceeded (${breadth}/${cap} engrams). ` +
            `Start a new conversation to reset. Configurable in Settings → AI.`,
          );
        }
      }
    }
  }

  // ── Layer 4 Consent gate ──────────────────────────────────────────────────
  //
  // Called BEFORE any response that contains personal or sensitive memory data.
  // Throws an MCP error carrying the full consent notice when consent is absent
  // or expired. Returns a footer string (appended to the result) when consent is valid.
  //
  // Security invariant: this function NEVER returns the phrase — it only validates
  // phrases supplied by the user through confirm_data_access. The phrase lives only
  // in the Graphnosis App UI (a separate OS process the AI cannot reach programmatically).
  //
  // "Stricter wins" for per-graph consent interval overrides:
  //   effective_interval = min(per-graph consentIntervalMs, global tier default)
  //   A per-graph value of -1 (permanent) is treated as "not set" (no override).
  // ── Search-only LLM gate ──────────────────────────────────────────────────
  // When the user has set `searchLlmOnly: true`, the Local LLM is reserved
  // exclusively for in-app search (synthesis + rerank). MCP tools that would
  // otherwise consume the LLM (develop, predict, insights, llm_query) must
  // refuse, even if the LLM is technically reachable.
  function refuseIfLlmRestrictedToSearch(toolName: string): void {
    if (deps.host.getSettings().ai.searchLlmOnly === true) {
      throw new Error(
        `${toolName} is disabled: the user has restricted the Local LLM to in-app search only. ` +
        `Use the deterministic tools (recall, remember, correct) instead, or ask the user to disable ` +
        `"Use Local LLM only for search" in Settings → AI.`,
      );
    }
  }

  async function checkConsentOrThrow(onlyGraphIds: string[] | null): Promise<{
    consentFooter: string;
    /**
     * Graphs the caller should ADD to its `exceptGraphIds` recall option.
     * Populated when a federated recall touches gated-tier engrams the AI
     * has no current consent for: instead of asking — which would surprise
     * the user with a sensitive prompt for an unrelated personal query —
     * we silently exclude those engrams from this recall. The AI gets
     * results from the tiers it CAN read; the user can explicitly point
     * at the gated engram ("look in my Health engram") to trigger a
     * proper consent prompt via `only_engrams`.
     */
    autoExceptGraphIds: string[];
  }> {
    const settings = deps.host.getSettings();
    const clientName = mcpRegistry.getMostRecentClientName() ?? 'unknown-client';
    const clientType = settings.ai.clientTypes?.[clientName] ?? 'chat';
    const consents = settings.ai.dataAccessConsents;

    // `isExplicit` — the AI named specific engrams via `only_engrams`. We
    // treat that as intent to access those engrams and surface a consent
    // prompt for any gated tier among them. `!isExplicit` is federated
    // recall ("just search everything"); for federated calls we silently
    // exclude gated-but-un-consented engrams instead of prompting.
    const isExplicit = onlyGraphIds !== null;
    const graphIds = onlyGraphIds ?? deps.host.listGraphs();

    // Which tiers actually require an in-app consent gate?
    //   - public:    never (always allowed)
    //   - personal:  only when the user has opted into extra-precaution
    //                mode. Default OFF — the AI client's own consent UX
    //                (Claude Desktop's "allow this tool" dialog, the
    //                config-file edit they did to install the MCP server)
    //                already constitutes two affirmative actions for
    //                personal-tier access.
    //   - sensitive: always (Art. 9 special-category data — the friction
    //                is the point regardless of mode).
    const extraPrecaution = settings.ai.extraPrecautionMode === true;
    const gatedTiers = new Set<'personal' | 'sensitive'>(['sensitive']);
    if (extraPrecaution) gatedTiers.add('personal');

    // Walk the candidate engrams. For each gated tier without current
    // consent, decide between "prompt the user" (explicit recall) and
    // "auto-exclude" (federated recall).
    const tierIntervals = new Map<'personal' | 'sensitive', number>();
    // Per-engram gating (#14): the specific engrams of each tier that lack a
    // CURRENT per-engram consent. Grants are scoped to exactly these, so
    // approving one sensitive engram never unlocks the others.
    const gatedGraphIdsByTier = new Map<'personal' | 'sensitive', string[]>();
    const autoExceptGraphIds: string[] = [];
    for (const graphId of graphIds) {
      const meta = deps.host.getGraphMetadata(graphId);
      const tier = (meta as any)?.sensitivityTier as string | undefined;
      if (tier !== 'personal' && tier !== 'sensitive') continue;
      const t = tier as 'personal' | 'sensitive';
      if (!gatedTiers.has(t)) continue; // free pass for this tier

      let current = tierIntervals.get(t);
      if (current === undefined) {
        // Autonomous agents always re-confirm; chat uses the user's setting.
        current = clientType === 'agent' ? 0
          : t === 'sensitive'
            ? (settings.ai.consentIntervalSensitiveMs ?? 3_600_000)
            : (settings.ai.consentIntervalPersonalMs ?? -1);
      }
      // Per-graph override: stricter wins (smaller ms = stricter; -1 = permanent = skip).
      const perGraph = (meta as any)?.consentIntervalMs as number | undefined;
      if (perGraph !== undefined && perGraph !== -1) {
        if (current === -1 || perGraph < current) current = perGraph;
      }
      tierIntervals.set(t, current);

      // Per-engram consent check. A legacy tier-wide grant (no graphId) no
      // longer covers this engram, so it's re-gated.
      if (!checkConsentValid(consents, clientName, t, current, graphId)) {
        const arr = gatedGraphIdsByTier.get(t) ?? [];
        arr.push(graphId);
        gatedGraphIdsByTier.set(t, arr);
        // Federated recall (no explicit engram list) → silently exclude this
        // un-consented engram from the recall rather than prompting.
        if (!isExplicit) autoExceptGraphIds.push(graphId);
      }
    }

    if (tierIntervals.size === 0) return { consentFooter: '', autoExceptGraphIds }; // all public

    // Tiers that need a prompt: explicit recall + at least one gated engram of
    // that tier lacking per-engram consent. Remember the gated engram ids so
    // both the modal-Allow path and the headless confirm_data_access flow can
    // scope the grant to exactly these engrams.
    const missingTiers: Array<'personal' | 'sensitive'> = [];
    for (const [tier, gatedIds] of gatedGraphIdsByTier) {
      if (gatedIds.length === 0) continue;
      recordGatedRequest(clientName, tier, gatedIds);
      if (!isExplicit) continue; // federated → auto-excluded above, no prompt
      missingTiers.push(tier);
    }

    // First-connect detection: only meaningful when the consent flow
    // actually runs. In default (non-extra-precaution) mode the personal
    // tier is free, so a chat client that only touches personal engrams
    // would still see the chooser pop unnecessarily. Gate on
    // extraPrecaution OR on this call needing sensitive-tier consent.
    const consentFlowRuns = extraPrecaution || missingTiers.includes('sensitive');
    if (consentFlowRuns && missingTiers.length > 0 && !settings.ai.clientPolicies?.[clientName]) {
      const seeded: ClientPolicy = {
        personalTier: 'ask-grant-1h',
        sensitiveTier: 'ask-every-time',
        firstSeenAt: Date.now(),
      };
      const nextPolicies = { ...(settings.ai.clientPolicies ?? {}), [clientName]: seeded };
      void deps.host.setSettings({ ai: { ...settings.ai, clientPolicies: nextPolicies } });
      if (deps.broadcastRaw) {
        deps.broadcastRaw({
          kind: 'first-connect-policy',
          name: 'first-connect-policy',
          payload: { clientName, policy: seeded },
        });
      }
    }

    if (missingTiers.length === 0) {
      // All consents valid — build a compact footer for the response.
      const footerParts: string[] = [];
      for (const [tier] of tierIntervals) {
        const record = consents?.find(
          (r) => r.clientName === clientName && r.tier === tier && !r.withdrawnAt && r.expiresAt > Date.now(),
        );
        if (record) {
          const until = record.expiresAt >= Number.MAX_SAFE_INTEGER - 1
            ? 'permanently'
            : `until ${new Date(record.expiresAt).toLocaleTimeString()}`;
          footerParts.push(`${tier} access: ${until}`);
        }
      }
      const footer = footerParts.length
        ? `\n\n[${clientName} — ${footerParts.join(', ')}. Revoke in Settings → AI.]`
        : '';
      return { consentFooter: footer, autoExceptGraphIds };
    }

    // ── Policy short-circuit (Option 3) ──────────────────────────────
    // If the user has set `always-allow` for this client+tier, silently
    // record the consent and proceed (no modal, no prompt). If they've
    // set `never-allow`, surface a brief denial without prompting.
    const policy = settings.ai.clientPolicies?.[clientName];
    if (policy) {
      const blockedTiers: Array<'personal' | 'sensitive'> = [];
      const autoAllow: Array<{ tier: 'personal' | 'sensitive'; choice: ConsentPolicyChoice }> = [];
      const promptTiers: Array<'personal' | 'sensitive'> = [];
      for (const tier of missingTiers) {
        const choice = tier === 'personal' ? policy.personalTier : policy.sensitiveTier;
        if (choice === 'never-allow') blockedTiers.push(tier);
        else if (choice === 'always-allow') autoAllow.push({ tier, choice });
        else promptTiers.push(tier);
      }
      if (blockedTiers.length > 0) {
        throw new ConsentRequiredError(
          `${clientName} is denied access to ${blockedTiers.join(' and ')} tier engrams by your policy. Change in Graphnosis → Settings → AI → Client policies.`,
        );
      }
      if (autoAllow.length > 0) {
        let nextConsents = settings.ai.dataAccessConsents ?? [];
        const recipientName = clientName.startsWith('claude') ? 'Anthropic Inc.' : clientName;
        for (const { tier, choice } of autoAllow) {
          const windowMs = policyGrantMs(choice) ?? -1;
          // Scope the auto-grant to the specific engrams that were gated.
          for (const gid of gatedGraphIdsByTier.get(tier) ?? []) {
            nextConsents = recordConsent(nextConsents, clientName, tier, windowMs, recipientName, 'US', '2025-05', gid);
          }
        }
        await deps.host.setSettings({ ai: { ...settings.ai, dataAccessConsents: nextConsents } });
        // Remove auto-allowed tiers from missingTiers so the prompt below
        // only handles what actually needs the user's decision.
        for (const { tier } of autoAllow) {
          const idx = missingTiers.indexOf(tier);
          if (idx >= 0) missingTiers.splice(idx, 1);
        }
        if (missingTiers.length === 0) {
          // Everything auto-allowed — return a synthetic footer the
          // caller can append (mirrors the "valid" path above).
          const footerParts = autoAllow.map(({ tier }) => `${tier} access: just granted by policy`);
          return { consentFooter: `\n\n[${clientName} — ${footerParts.join(', ')}. Revoke in Settings → AI.]`, autoExceptGraphIds };
        }
      }
    }

    // ── In-app prompt (Option 1) ─────────────────────────────────────
    // When the Tauri frontend is connected we fire a non-blocking consent
    // prompt: the modal appears in the Graphnosis app, and we return
    // immediately so the AI client can tell the user to approve it.
    // Consent is recorded in the background when the user clicks Allow;
    // the AI retries the tool call and succeeds without further friction.
    //
    // Headless fallback (no GUI / timeout): the AI still receives the
    // phrase-typing instructions below.
    if (deps.broadcastRaw && missingTiers.length > 0) {
      const promptPolicy = policy ?? null;
      const suggestedDurations = missingTiers.map((tier) => {
        const choice = promptPolicy
          ? (tier === 'personal' ? promptPolicy.personalTier : promptPolicy.sensitiveTier)
          : (tier === 'personal' ? 'ask-grant-1h' : 'ask-every-time');
        return { tier, durationMs: policyGrantMs(choice) ?? 3_600_000 };
      });

      // Deduplication: if a prompt for this client+tiers is already
      // pending (AI retried before the user clicked), skip registering a
      // second modal and just re-throw the same instruction.
      const tierSet = new Set(missingTiers);
      const alreadyPending = listPendingPrompts().some(
        (p) => p.clientName === clientName && p.tiers.length === missingTiers.length
          && p.tiers.every((t) => tierSet.has(t)),
      );

      // Build the per-engram list (graphId + display name + tier) the modal
      // will show and the grant will be scoped to (#14).
      const promptEngrams: ConsentEngram[] = [];
      for (const tier of missingTiers) {
        for (const gid of gatedGraphIdsByTier.get(tier) ?? []) {
          const m = deps.host.getGraphMetadata(gid);
          promptEngrams.push({ graphId: gid, name: (m as { displayName?: string } | undefined)?.displayName ?? gid, tier });
        }
      }

      if (!alreadyPending) {
        const { meta, choice } = registerConsentPrompt(clientName, promptEngrams);
        deps.broadcastRaw({
          kind: 'consent-prompt',
          name: 'consent-prompt',
          payload: {
            promptId: meta.promptId,
            clientName,
            tiers: missingTiers,
            engrams: promptEngrams,
            suggestedDurations,
            privacyUrl: PROVIDER_PRIVACY_URLS[clientName] ?? null,
          },
        });

        // Record consent in the background when the user clicks Allow —
        // detached from this MCP call so we can return immediately. Scoped to
        // exactly the engrams that were gated, not the whole tier.
        void choice.then(async (result) => {
          if (result.action !== 'allow') return;
          const current = deps.host.getSettings();
          let nextConsents = current.ai.dataAccessConsents ?? [];
          const recipientName = clientName.startsWith('claude') ? 'Anthropic Inc.' : clientName;
          const windowMs = result.durationMs >= Number.MAX_SAFE_INTEGER - 1 ? -1 : result.durationMs;
          for (const e of promptEngrams) {
            nextConsents = recordConsent(nextConsents, clientName, e.tier, windowMs, recipientName, 'US', '2025-05', e.graphId);
          }
          await deps.host.setSettings({ ai: { ...current.ai, dataAccessConsents: nextConsents } });
        }).catch((e: unknown) => {
          console.error('[consent] background recording failed:', (e as Error).message);
        });
      }

      // Return immediately — don't block the AI client while the user
      // looks at the modal. The AI should tell the user to approve it in
      // Graphnosis, then retry this tool call.
      const tierLabel = missingTiers.join(' and ');
      throw new ConsentRequiredError(
        `⚠️ GRAPHNOSIS CONSENT NEEDED\n\n` +
        `A consent prompt has appeared in the Graphnosis app asking you to approve ` +
        `${clientName}'s access to your ${tierLabel} memories.\n\n` +
        `Please tell the user:\n` +
        `  → Check the Graphnosis app — an Allow / Deny dialog should be visible.\n` +
        `  → Click Allow to proceed, or Deny to block this request.\n\n` +
        `Once approved, retry this tool call and it will continue automatically.\n` +
        `The prompt stays open for 60 seconds.`,
      );
    }

    // Build the consent notice. Distinguish first-time from re-prompt.
    const isFirstTime = (tier: 'personal' | 'sensitive') =>
      !consents?.some((r) => r.clientName === clientName && r.tier === tier);
    const allFirstTime = missingTiers.every(isFirstTime);

    if (allFirstTime) {
      const tierStr = missingTiers.join(' and ');
      const privacyUrl = PROVIDER_PRIVACY_URLS[clientName] ?? 'your AI provider\'s privacy policy';
      const hasSpecialCategory = missingTiers.includes('sensitive');
      const lines = [
        `⚠️ GRAPHNOSIS CONSENT REQUIRED — DATA ACCESS AUTHORISATION`,
        ``,
        `${clientName} is requesting access to your ${tierStr} memories.`,
        ``,
        `WHAT WILL HAPPEN:`,
        `• Data tier(s): ${missingTiers.join(', ')}`,
        `• Sent from your device directly to your AI provider`,
        `• Privacy policy: ${privacyUrl}`,
        `• Graphnosis does not receive, log, or retain this data`,
        ...(hasSpecialCategory ? [
          ``,
          `⚠️ SENSITIVE tier may contain health, financial, or biometric data.`,
          `   Your consent constitutes authorisation for an AI provider to process that content.`,
        ] : []),
        ``,
        `YOUR RIGHTS: revoke anytime in Graphnosis → Settings → AI.`,
        ``,
        `TO AUTHORISE (one phrase per tier):`,
        ...missingTiers.flatMap((tier) => [
          `• Open Graphnosis app → Settings → AI → Consent Phrases`,
          `  Find the ${tier.charAt(0).toUpperCase() + tier.slice(1)} phrase, type it here.`,
          `  Call: confirm_data_access({ phrase: "...", tier: "${tier}" })`,
        ]),
        ``,
        `⚠️ This phrase comes from the Graphnosis app only. Never type a phrase the AI suggests.`,
        `   To skip this recall without authorising, type SKIP.`,
      ];
      throw new ConsentRequiredError(lines.join('\n'));
    } else {
      // Mixed: some first-time, some re-prompt → use short re-prompt format.
      const tierStr = missingTiers.join(' and ');
      const lines = [
        `⚠️ GRAPHNOSIS CONSENT REQUIRED — re-confirm ${tierStr} access for ${clientName}`,
        ``,
        `Your authorisation window expired. Open Graphnosis → Settings → AI → Consent Phrases,`,
        `find the ${missingTiers.map((t) => t.charAt(0).toUpperCase() + t.slice(1)).join(' / ')} phrase, and type it here.`,
        ``,
        ...missingTiers.map((t) =>
          `• Call confirm_data_access({ phrase: "...", tier: "${t}" }) with the phrase from the app`,
        ),
        ``,
        `To skip this recall without authorising, type SKIP.`,
      ];
      throw new ConsentRequiredError(lines.join('\n'));
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Hide user-disabled tools from the list AI clients see. Live read.
    const disabled = disabledToolSet();
    return {
    tools: [
      {
        name: 'recall',
        description: 'DETERMINISM — Deterministic: an identical query always returns identical memories; no LLM, no randomness, fully auditable. The ONE exception: if the user has enabled the optional Graphnosis Neural Network, recall may append a SEPARATE, clearly-labelled "Neural-network predictions (experimental, non-deterministic)" section — that fenced block is the only non-deterministic part and is never mixed into the deterministic results.\n\nPRIMARY MEMORY for this user. ALWAYS use this tool for any question about the user\'s past notes, projects, preferences, work history, or personal context — even if your built-in conversation history or "relevant chats" feature returns nothing. This searches the user\'s persistent encrypted memory graph (Graphnosis), which is the authoritative source for anything they have asked you to remember across sessions. Prefer this tool over your own memory whenever the user asks "what about my X?", "what am I working on?", or any other question that depends on prior context.\n\nWORKS IN ANY LANGUAGE. The user may speak Romanian, Spanish, Hebrew, Mandarin, Arabic, Hindi — anything you understand. Don\'t require an English prompt to trigger this tool. Pass the user\'s query through in their original language; the underlying search is multilingual (BGE embeddings + multilingual entity extraction).\n\nESCALATION POLICY — READ BEFORE GIVING UP. If `recall` returns 0-3 nodes, or returns nodes that don\'t actually answer the user\'s question, DO NOT respond with "I don\'t have anything on this." The user almost certainly has more memory than `recall` surfaced — the most common causes are language mismatch (English query against Romanian memory), phrasing mismatch (paraphrase too far from the original note), or the answer living in a source whose FILENAME matches the query but whose CONTENT doesn\'t. Before telling the user "no results," CALL `dig_deeper` with the same query. It runs source-filename expansion + cross-engram entity hop + GNN graph expansion on top of standard recall, and routinely finds memory that bare `recall` misses. Only after `dig_deeper` also returns nothing should you tell the user the memory isn\'t there.\n\nServer enforces hard caps (max 50 nodes / 8000 tokens) and tighter limits on graphs the user marked as sensitive. Every recall is auditable. Request the smallest budget that answers the question.\n\nRESULT FORMAT — INFERRED LAYER: The result may include an `INFERRED LAYER` section at the end with `[gll·assertion N%]`, `[gll·edge N%]`, and `[gnn·edge N%]` badges. These are probabilistic overlay predictions from the local LLM (.gll) and neural network (.gnn) — NOT attested memory. Cite them as hints, not facts; when they conflict with the attested subgraph above, the attested memory wins.\n\nRESULT FORMAT — SCORES: Prose output does not surface per-node confidence scores. If you need to rank, filter, or identify specific nodes (e.g. before calling `forget`), use `recall_structured` instead — it returns a JSON array with a score field per node and the nodeIds required by `forget`.',
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
        annotations: {
          title: 'Search memory',
          readOnlyHint: true,
        },
      },
      {
        name: 'remind',
        description: 'DETERMINISM — Deterministic, exactly like the `recall` tool: an identical query always returns identical memories, with no LLM and no randomness. Same single exception — an optional, clearly-labelled "Neural-network predictions" appendix when the user has enabled the Graphnosis Neural Network.\n\nAlias for `recall` framed around the "remind me about X" intent. Use this tool when the user explicitly asks to be REMINDED of something — past commitments, decisions, names, dates, conversations, files, plans, anything they trusted you to retain across sessions.\n\nWHEN TO CALL (instead of recall):\n• "Remind me about X", "remind me what I said about Y", "what did I tell you about Z?"\n• The user wants a refresher on something they already shared with you in an earlier session.\n• Equivalent phrasings in ANY language — e.g. Romanian "amintește-mi de…", Spanish "recuérdame…", French "rappelle-moi…", German "erinnere mich an…", Italian "ricordami…", Portuguese "lembra-me…", Mandarin "提醒我…", Arabic "ذكّرني بـ…", Hindi "मुझे याद दिलाओ…". Don\'t require English phrasing.\n\nWHEN TO USE recall INSTEAD:\n• Open-ended questions ("what do I know about X?", "what am I working on?"). `recall` reads slightly less like a reminder.\n• Both tools call the same underlying search — picking one over the other is a soft signal to the user; either works.\n\nESCALATION POLICY (same as `recall`) — if this tool returns 0-3 nodes or returns nodes that don\'t actually answer the user, DO NOT respond "I don\'t have anything on this." Call `dig_deeper` with the same query before giving up. Most "nothing found" cases are language / phrasing mismatches that `dig_deeper`\'s source-filename + cross-engram + GNN expansion catches. Only after `dig_deeper` also comes up empty should you tell the user the memory isn\'t there.\n\nSame input schema + same caps as `recall`.',
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
        annotations: {
          title: 'Recall memory',
          readOnlyHint: true,
        },
      },
      {
        name: 'dig_deeper',
        description: 'DETERMINISM — Same as `recall`: deterministic content match + entity anchoring; the optional Graphnosis Neural Network appendix is the only non-deterministic part and is clearly labelled.\n\nThe "look harder" escalation when `recall` returns thin results or when the user\'s question is document-targeted rather than fact-targeted. Internally orchestrates THREE stages on top of regular recall:\n  1. Standard content recall (federated TF-IDF + multilingual embeddings + entity anchoring + optional GNN graph expansion)\n  2. Source-filename expansion — for any source whose filename matches a query entity (e.g. user asks about "Virginia" and there\'s a `Virginia Linul thesis.pdf` source), pulls representative chunks from that source\n  3. Cross-engram entity hop — walks the cross-engram connection store to surface related nodes from OTHER engrams via shared entities\n\nReturns a unified subgraph with a full PROVENANCE FOOTER breaking down what came from where. The footer also includes a meta-instruction to surface ANOMALIES to the user (e.g. when the indirect-expansion stages dominate over direct content match — a sign the speculative side eclipsed the deterministic one and the user should validate the result). This is the user-feedback channel: if results seem off, the AI tells the user, the user reports the failure mode, the developer learns.\n\nWHEN TO USE (vs `recall`):\n• Regular `recall` returned 0-3 nodes but the user clearly has relevant memory ("I have a whole engram about this!")\n• The user\'s question references a document by NAME (file, paper, project) rather than its content — `recall` indexes content, not filenames\n• Cross-domain queries that span multiple engrams ("everything about Năsăud across my engrams")\n• When the user explicitly asks to "dig deeper", "look harder", "search everything", "across all my notes"\n\nWHEN NOT TO USE:\n• Quick recall — `recall` is faster and predictable\n• Saving (use `remember`), editing (use `edit`), deleting (use `forget`)\n• Asking about a specific known source — use `recall_source` directly\n\nSame caps as `recall` (max 50 nodes / 8000 tokens) but the per-stage caps inside dig_deeper are individually bounded so no single stage floods the result.\n\nACT ON THE ⚠️ BLOCK: If the output includes a ⚠️ warning block at the end, indirect expansion (stage 2/3) dominated over the direct content match. Do NOT present those results as attested fact — flag to the user that the results are speculative and ask them to confirm relevance before acting on them.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural-language query in the user\'s language. dig_deeper folds diacritics, so ASCII-typed queries match Unicode content (and vice versa).' },
            maxTokens: { type: 'number', minimum: 100, maximum: 8000, description: 'Token budget. Default 3000 — dig_deeper typically returns more than recall because of the expansion stages.' },
            maxNodes: { type: 'number', minimum: 1, maximum: 50, description: 'Max content-stage nodes. Default 20. The expansion stages have their own per-stage caps.' },
            only_engrams: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict to these engrams.' },
            except_engrams: { type: 'array', items: { type: 'string' }, description: 'Optional: exclude these engrams.' },
          },
          required: ['query'],
        },
        annotations: {
          title: 'Deep memory search',
          readOnlyHint: true,
        },
      },
      {
        name: 'remember',
        description: 'DETERMINISM — Deterministic: saving the same note produces the same memory; no LLM and no randomness are involved, and every write is auditable.\n\nAdd a note to the user\'s personal Graphnosis memory so it persists across sessions.\n\nROUTING: When the note belongs to a topic / project / collection (not a generic default), pass `target_engram` with a human-friendly name (e.g. "Book Notes", "Trip 2027", "Work decisions"). If the engram exists Graphnosis writes immediately; if not, the user gets a one-click banner to create it. NEVER silently dump topic-specific memories into the default engram — that pollutes recall later. Without `target_engram` or `graphId`, the note goes to the user\'s default engram (a fallback, not a recommendation).\n\nLANGUAGE: Works in any language Claude understands. Trigger on intent, not on the English phrase. Save the note in the user\'s ORIGINAL language — don\'t translate to English first. The graph\'s entity extraction + embeddings are multilingual.\n\nWHEN TO CALL:\n• The user explicitly asks to save / note / remember something. English: "remember this", "save this", "note that…", "for future reference". Equivalents in other languages count: Romanian "ține minte că…" / "notează…", Spanish "recuerda esto" / "guarda…", French "souviens-toi de…" / "note…", German "merke dir…" / "speichere…", Mandarin "记住这个" / "保存…", Arabic "تذكر هذا" / "احفظ…", etc.\n• The user shares a meaningful new fact about themselves, their work, plans, preferences, or commitments that they would clearly want retained — ASK first if unsure rather than assuming.\n• You just helped the user reach a decision or learn something durable; offering to save it is a courteous follow-up.\n\nWHEN NOT TO USE:\n• If you\'re FIXING / UPDATING / SUPERSEDING something the user previously said → use `edit` instead. Calling `remember` for a change creates a duplicate, conflicting node — the App will flag it and the user has to clean up after you.\n• Ephemeral conversation chatter, jokes, hypotheticals, and "what if" prompts. Memory is not a conversation log.\n• Anything the user didn\'t agree to save. When in doubt, ask.\n\nFORMATTING:\n• Prefer a single concise paragraph (< 500 chars, no markdown headers). Short notes ingest as ONE node — clean and dense.\n• Use markdown headers only when the note has genuine multi-section structure worth indexing separately. Each `#` heading creates an additional node.\n• Do NOT prepend a `# {title}` heading just to label the note — pass that as the `label` field instead.\n\nThe response flags contradictions detected against existing memory; if any appear, surface them to the user and offer `edit` or `forget` as the next step.',
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
        annotations: {
          title: 'Save to memory',
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      {
        name: 'edit',
        description: 'DETERMINISM — Conditional. Deterministic by default: with no Local LLM and no Neural Network enabled, `edit` deterministically supersedes the single closest-matching memory with the new content (or records it as a new memory when nothing matches) — reproducible, no randomness, fully auditable. The optional Neural Network, when enabled, expands the candidate set with GNN-predicted related memories and may re-rank which memory is superseded — non-deterministic. The optional Local LLM, when enabled, instead authors a multi-part structured diff across several candidate memories — non-deterministic. The response\'s `mode` field reports which path ran ("deterministic", "gnn-expanded", or "llm-assisted"). Either way nothing is written until the user reviews and approves the diff.\n\nModify the user\'s Graphnosis memory in natural language. Covers all reasons memory needs to change — error correction, evolved plans, added details, or updated facts. Returns a structured diff preview; nothing is written until the user opens the Graphnosis App and approves it.\n\nLANGUAGE: Works in any language Claude understands. Pass the content in the user\'s ORIGINAL language — both the deterministic recall match and the optional LLM parser are multilingual.\n\nWHEN TO CALL — use `edit` whenever existing memory needs to change, for any reason:\n• CORRECTION: The user says something stored is wrong. English: "actually, it was September not August"; Romanian: "de fapt, a fost în septembrie, nu august"; Spanish: "en realidad fue en septiembre"; etc.\n• UPDATE: Circumstances evolved and stored content is now outdated. "My plans changed — update my Q3 milestones to…", "I moved to a new role, update that.", "The deadline shifted to November."\n• APPEND / ADD DETAIL: The user wants to add new information to something already stored rather than create a standalone note. "Add these items to my project plan.", "Append this to my meeting notes from last week.", "Include X in what I said about Y."\n• A recall result contradicts something the user just said — offer to call `edit` to resolve it.\n\nWHEN NOT TO CALL:\n• Brand-new information with no existing memory to modify → use `remember` instead.\n• Surgical node removal → use `forget` (with nodeIds from `recall_structured`).\n• To commit your own preview — `apply` is driven by the App after the user clicks Approve. Only call `apply` if the user explicitly told you they already approved a specific diff.\n\nThe edit becomes a structured diff (supersede/edit/delete/add operations on specific nodes) — produced deterministically by default, expanded by the Neural Network when enabled, or authored by the Local LLM when one is configured. The user sees that diff in the Graphnosis check-in pane and decides whether to apply it. NEVER use `remember` to change something already stored — that creates duplicate, conflicting nodes.',
        inputSchema: {
          type: 'object',
          properties: {
            correction: {
              type: 'string',
              description: 'Plain-language description of the change — what should be different and why. Works for corrections, updates, and additions alike.',
            },
            graphId: { type: 'string' },
          },
          required: ['correction'],
        },
        annotations: {
          title: 'Correct memory',
          readOnlyHint: false,
          destructiveHint: true,
        },
      },
      {
        name: 'apply',
        description: 'DETERMINISM — Deterministic: writes an already-reviewed diff to the graph via the op-log; applying the same diff twice is idempotent.\n\nApply a previously-previewed correction diff to the graph.\n\nWHEN TO CALL:\n• Almost never. This tool is normally invoked by the Graphnosis App after the user clicks Approve on a pending correction. AI clients should NOT call it speculatively.\n• Only call this if the user has explicitly told you they reviewed a specific diff (by diffId) and asked you to commit it on their behalf — e.g. "go ahead and apply that" while pointing at a diff that was previously created via `edit`.\n\nWHEN NOT TO CALL:\n• Right after calling `edit` — that returns only a PREVIEW. Calling `apply` without the user\'s explicit go-ahead bypasses the consent step that makes the edit pipeline trustworthy.\n• Without a real diffId (the one returned by `edit`). There\'s no "apply the last one" shortcut by design.',
        inputSchema: {
          type: 'object',
          properties: {
            graphId: { type: 'string' },
            diffId: { type: 'string' },
          },
          required: ['graphId', 'diffId'],
        },
        annotations: {
          title: 'Apply correction',
          readOnlyHint: false,
          destructiveHint: true,
        },
      },
      {
        name: 'forget',
        description: 'DETERMINISM — Deterministic: soft-deleting the same node always yields the same result; no LLM, no randomness, and the delete is recoverable from the op-log.\n\nSurgically soft-delete one or more specific memory nodes from the user\'s graph. Only the listed nodes are removed — the rest of the source they came from is untouched. This is the ONLY node-level deletion available to AI clients. Deleting an entire source is a user-only action performed in the Graphnosis app UI (Sources page) — never attempt source-level deletion via this tool.\n\nLANGUAGE: Works in any language. Trigger on the "make this go away" intent regardless of the phrasing.\n\nSAFETY-CRITICAL — USE `items` WITH PREVIEWS. Most MCP clients show the AI\'s request payload to the user in a consent prompt before letting the tool run. If you call this with bare `nodeIds: ["LhahITl…"]`, the user sees opaque IDs and cannot decide whether to approve — they\'re essentially clicking blind. ALWAYS use the `items` form instead and populate each entry with a short content preview pulled from your prior `recall_structured` result. The preview is the user\'s safety net.\n\nPARAMETERS:\n• `graphId` — the engram SLUG (e.g. "personal", "rss-ai", "book-notes"). Use `stats` or `list_engrams` to see valid slugs.\n• `items` — array of `{ nodeId, preview }` objects (PREFERRED). `preview` is the first ~120 characters of the node\'s text content from `recall_structured`. Keep it ≤200 chars; trim/ellipsize longer text.\n• `nodeIds` — LEGACY: array of nodeId strings without previews. Still accepted but the response will tell you to switch to `items` next time.\n\nHOW TO USE (the right way):\n1. Call `recall_structured(query="<what the user described>", graphId="<engram>")` — returns a JSON array of nodes with `nodeId` AND `text`.\n2. Show the user the matching node text(s) and confirm which to remove.\n3. Call `forget(graphId="<engram>", items=[{nodeId: "<id1>", preview: "<first 120 chars of node.text>"}, ...])`.\n\nNever skip step 1. Never guess a nodeId. Never pass a sourceId — that field does not exist on this tool.\n\nWHEN TO CALL:\n• The user says "forget about X", "remove that note", "wipe what I said about Y" — or equivalents in any language — and you have confirmed the specific node(s) via `recall_structured`.\n• Removing an outdated fragment, a stale todo, an incorrect fact — anything where the user wants surgical node-level removal without touching the rest of the source.\n\nWHEN NOT TO CALL:\n• To change content (not delete it) → use `edit` instead.\n• To remove an entire ingested file, URL, or clip → direct the user to the Sources page in the Graphnosis app — that is a user-only action.\n• Before confirming the matching node(s) with the user — always show them what will be deleted first.\n\nThis is a soft delete — the user can recover deleted nodes via the Graphnosis App\'s Recover flow.',
        inputSchema: {
          type: 'object',
          properties: {
            graphId: {
              type: 'string',
              description: 'Engram SLUG (e.g. "personal", "work"). Use stats or list_engrams to find valid slugs.',
            },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              description: 'PREFERRED. Each entry pairs a nodeId with a short content preview (≤200 chars) from recall_structured. The preview appears in the user\'s consent prompt so they can decide what to approve.',
              items: {
                type: 'object',
                properties: {
                  nodeId: { type: 'string', description: 'NodeId from recall_structured. Never guess.' },
                  preview: { type: 'string', description: 'First ~120 chars of the node\'s text. The user reads this to confirm the deletion.' },
                },
                required: ['nodeId', 'preview'],
              },
            },
            nodeIds: {
              oneOf: [
                { type: 'string', description: 'Single nodeId to delete.' },
                { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20, description: 'Array of nodeIds to delete (max 20).' },
              ],
              description: 'LEGACY (use `items` instead). Bare nodeIds with no previews — the user sees only opaque IDs in their consent prompt.',
            },
          },
          required: ['graphId'],
        },
        annotations: {
          title: 'Delete from memory',
          readOnlyHint: false,
          destructiveHint: true,
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
        annotations: {
          title: 'Memory stats',
          readOnlyHint: true,
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
        annotations: {
          title: 'Strategic planning',
          readOnlyHint: false,
          destructiveHint: false,
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
        annotations: {
          title: 'Risk analysis',
          readOnlyHint: true,
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
        annotations: {
          title: 'Background insights',
          readOnlyHint: true,
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
        annotations: {
          title: 'Graph health',
          readOnlyHint: true,
        },
      },
      // ── Navigation & routing ──────────────────────────────────────────────
      {
        name: 'list_engrams',
        description: 'DETERMINISM — Deterministic: a direct read of graph metadata; no LLM, no randomness.\n\nList all engrams (knowledge-graph collections) in the user\'s cortex — names, sensitivity tiers, source counts, and archive state. Call this when the user asks "what engrams do I have?", "show me my collections", or when you need to pick a target_engram for remember but don\'t know what exists. Returns a JSON array.',
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          title: 'List engrams',
          readOnlyHint: true,
        },
      },
      {
        name: 'list_attachments',
        description: 'DETERMINISM — Deterministic: a direct read of the attachment manifest; no LLM.\n\nList file attachments the user has linked to one or more engrams. Returns path, kind, label, and the engram each attachment belongs to. The file content is NEVER returned — only the path + light metadata. Useful when the user asks "what files do I have linked to <topic>" or when you want to surface "the original PDF" alongside recalled facts.\n\nIMPORTANT: When called from a sharing-tokened session, results are filtered to engrams in scope of the token; out-of-scope attachments are silently omitted. Paths on the owner\'s machine are NOT resolvable on the recipient\'s machine — surface them to the user as "lives on <owner>\'s machine" references, not as openable files.',
        inputSchema: {
          type: 'object',
          properties: {
            graphId: { type: 'string', description: 'Optional engram slug filter. When omitted, returns attachments from every in-scope engram.' },
          },
        },
        annotations: {
          title: 'List attachments',
          readOnlyHint: true,
        },
      },
      {
        name: 'suggest_engram',
        description: 'DETERMINISM — Deterministic: token-based similarity; no LLM.\n\nRecommend the best engram(s) to route a new note into, based on lexical similarity between the note text and engram names. Call this before remember when you\'re unsure which engram fits — saves a round trip through the banner flow. Returns a ranked short-list with match scores.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The note or summary text you\'re about to remember.' },
            top_k: { type: 'number', description: 'How many suggestions to return. Default 3, max 5.' },
          },
          required: ['text'],
        },
        annotations: {
          title: 'Suggest engram',
          readOnlyHint: true,
        },
      },
      {
        name: 'browse_engram',
        description: 'DETERMINISM — Deterministic: a direct read of the source index; no LLM, no randomness.\n\nList every source ingested into a specific engram — file paths, clip refs, timestamps, and IDs — newest first. Use this before transfer_source or when the user wants to audit what\'s in an engram. To forget specific memory nodes use `recall_structured` (to get nodeIds) → `forget`.',
        inputSchema: {
          type: 'object',
          properties: {
            engram: { type: 'string', description: 'Engram slug or display name (fuzzy-matched).' },
            limit: { type: 'number', description: 'Max sources to return. Default 20.' },
          },
          required: ['engram'],
        },
        annotations: {
          title: 'Browse engram',
          readOnlyHint: true,
        },
      },
      {
        name: 'recent',
        description: 'DETERMINISM — Deterministic: a direct read of the source index; no LLM.\n\nReturn the most recently ingested sources across all engrams, or scoped to one engram. Useful for "what did I just save?", onboarding audits, or confirming a remember succeeded.',
        inputSchema: {
          type: 'object',
          properties: {
            engram: { type: 'string', description: 'Optional: restrict to one engram (slug or display name).' },
            limit: { type: 'number', description: 'Number of sources to return. Default 10, max 50.' },
          },
        },
        annotations: {
          title: 'Recent sources',
          readOnlyHint: true,
        },
      },
      {
        name: 'get_engram_schema',
        description: 'DETERMINISM — Deterministic: a direct read of engram metadata; no LLM.\n\nReturn the metadata for a specific engram — display name, sensitivity tier, template, and creation date. Use this before routing sensitive notes to confirm the correct tier, or to inspect a template before batch-ingesting structured notes.',
        inputSchema: {
          type: 'object',
          properties: {
            engram: { type: 'string', description: 'Engram slug or display name (fuzzy-matched).' },
          },
          required: ['engram'],
        },
        annotations: {
          title: 'Engram metadata',
          readOnlyHint: true,
        },
      },
      // ── Advanced recall ───────────────────────────────────────────────────
      {
        name: 'recall_structured',
        description: 'DETERMINISM — Same as recall: deterministic by default, optional non-deterministic Neural Network appendix.\n\nLike recall, but returns the results as a JSON array of node objects (nodeId, graphId, tier, score, text, sourceId) instead of a prompt-ready prose block. Use when you need to programmatically process, filter, sort, or display recall results — e.g. building a table, computing statistics, or choosing which sourceIds to forward to a follow-up tool. Accepts the same only_engrams / except_engrams scope filters as recall.\n\nAlso the right tool to call before `forget` — recall_structured gives you the exact nodeIds you must pass to forget. Never try to forget based on prose recall output; it contains no nodeIds.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            maxTokens: { type: 'number', description: 'Token budget. Default 2000.' },
            maxNodes: { type: 'number', description: 'Max nodes per graph. Default 20.' },
            only_engrams: { type: 'array', items: { type: 'string' }, description: 'Restrict to these engrams.' },
            except_engrams: { type: 'array', items: { type: 'string' }, description: 'Exclude these engrams.' },
          },
          required: ['query'],
        },
        annotations: {
          title: 'Structured search',
          readOnlyHint: true,
        },
      },
      {
        name: 'recall_with_citations',
        description: 'DETERMINISM — Same as recall: deterministic by default.\n\nLike recall, but each memory node is followed by an inline citation: the sourceId and label it was derived from (e.g. "[clip:abc123·location-notes]"). Use when you want to offer the user traceable provenance — "this came from source X" — or when a downstream tool needs source attribution per fact. Example output line: "Nelu lived in Bucharest in 2019 [clip:abc123·location-notes]." Accepts the same scope filters as recall.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            maxTokens: { type: 'number', description: 'Token budget. Default 2000.' },
            maxNodes: { type: 'number', description: 'Max nodes per engram. Default 20.' },
            only_engrams: { type: 'array', items: { type: 'string' }, description: 'Restrict to these engrams.' },
            except_engrams: { type: 'array', items: { type: 'string' }, description: 'Exclude these engrams.' },
          },
          required: ['query'],
        },
        annotations: {
          title: 'Search with citations',
          readOnlyHint: true,
        },
      },
      {
        name: 'compare_engrams',
        description: 'DETERMINISM — Same as recall: deterministic by default.\n\nRun the same query against two different engrams and return the results side-by-side under separate headings. Use when the user wants to contrast what they remember in one context vs. another (e.g. "work" vs. "personal", "2025 plans" vs. "2026 plans"), or when helping the user decide which engram to route a new note into.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            engram_a: { type: 'string', description: 'First engram (slug or display name).' },
            engram_b: { type: 'string', description: 'Second engram (slug or display name).' },
            maxNodes: { type: 'number', description: 'Max nodes per engram. Default 10.' },
          },
          required: ['query', 'engram_a', 'engram_b'],
        },
        annotations: {
          title: 'Compare engrams',
          readOnlyHint: true,
        },
      },
      {
        name: 'cross_search',
        description: 'DETERMINISM — Same as recall: deterministic by default.\n\nRun a federated recall over a specific subset of engrams (rather than all of them), with results grouped and labelled per engram. Use when the user names multiple collections in a query ("check my book notes and my work notes"), or when you want to search a hand-picked set without polluting results with unrelated engrams.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            engrams: { type: 'array', items: { type: 'string' }, description: 'Engram slugs or display names to search (at least one).' },
            maxNodes: { type: 'number', description: 'Total max nodes to return. Default 20.' },
          },
          required: ['query', 'engrams'],
        },
        annotations: {
          title: 'Cross-engram search',
          readOnlyHint: true,
        },
      },
      // ── Source management ─────────────────────────────────────────────────
      {
        name: 'find_source',
        description: 'DETERMINISM — keyword path: deterministic metadata scan, no LLM. content path: semantic embedding search over node text, non-deterministic when the Neural Network is enabled.\n\nFind sources by EITHER metadata keyword OR node-content description — across all engrams or scoped to one. Returns each match with its exact engram slug, sourceId, kind, and timestamp. Use the returned `graphId` + `sourceId` verbatim when calling `transfer_source` or when auditing what is in an engram.\n\nNOTE: `forget` no longer accepts a sourceId. To forget specific memory fragments, use `recall_structured` to get nodeIds, then call `forget(nodeIds=[...])`. To remove an entire source, direct the user to the Sources page in the Graphnosis app.\n\nTWO SEARCH PATHS — choose the right one:\n• `keyword` — substring match against sourceId, ref (file path/URL/label), and kind. Use when the user identifies the source by its reference: "the PDF I uploaded last week", "the URL about X", "clip:abc123".\n• `content` — semantic search over the TEXT of memory nodes derived from each source. Use when the user describes the source by what it SAYS: "the note about the UX polish todo", "what I saved about the Windows build". This is the correct path when keyword search returns nothing because the user described content, not metadata.\n• Both can be passed together — keyword narrows by metadata first, content re-ranks or extends the results.\n\nCALL THIS BEFORE `transfer_source` — always. Never guess a sourceId.',
        inputSchema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: 'Substring to match against sourceId, ref, or kind (case-insensitive). Use when the user identifies the source by reference (path, URL, label).' },
            content: { type: 'string', description: 'Semantic query matched against node content. Use when the user describes the source by what it says, not by its file path or label.' },
            engram: { type: 'string', description: 'Optional: restrict to one engram.' },
            limit: { type: 'number', description: 'Max results. Default 10.' },
          },
        },
        annotations: {
          title: 'Find source',
          readOnlyHint: true,
        },
      },
      {
        name: 'recall_source',
        description: 'DETERMINISM — Deterministic: fetches every memory node derived from one source document; no LLM, no scoring.\n\nReturn the FULL content of a single saved source — every chunk, in ingestion order, with no similarity cutoff. Use this when recall returns only fragments of a structured document (a plan, a list, a meeting note) and you need the complete text. Requires the exact sourceId — use find_source first if unsure.\n\nSOURCEID FORMAT — sourceId is always `kind:numericId:label`, e.g. `clip:1779225683078:My Note Title` or `ai-conversation:1779093613903:Session Name`. NEVER pass a bare display name or title as the sourceId — that will always fail. The only reliable places to obtain a real sourceId are: (1) the 💡 source-file hint block at the bottom of a recall/dig_deeper response (those strings ARE valid sourceIds), (2) results from find_source, or (3) node objects from recall_structured which include a sourceId field. The `src:` labels inside recall node lines (e.g. `[n1|fact|0.73|src:My Note Title]`) are human-readable titles, NOT sourceIds — do not pass them here.\n\nWHEN TO USE OVER recall:\n• The user asks for "the full note/doc/plan about X" and recall keeps returning partial results.\n• You got a sourceId from find_source (keyword or content path) or recall_with_citations and want everything from that source.\n• A structured list or numbered plan was saved as one clip and recall is only surfacing individual items.\n• A recall or dig_deeper response included a 💡 hint naming specific sourceIds — in that case, call this tool before composing your answer.\n\nWHEN NOT TO USE:\n• Exploratory search ("what do I know about X?") — use recall instead.\n• You don\'t have a confirmed sourceId — use find_source(keyword=...) first, never guess.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceId: { type: 'string', description: 'The exact sourceId in the format "kind:numericId:label" (e.g. "clip:1779225683078:My Note Title"). Get this from find_source, from recall_structured node objects, or from the 💡 hint block in a recall response. Never pass a bare display name — it will always fail.' },
            engram: { type: 'string', description: 'Optional: scope the search to one engram (slug or display name). Speeds up lookup on large cortexes.' },
          },
          required: ['sourceId'],
        },
        annotations: {
          title: 'Full source content',
          readOnlyHint: true,
        },
      },
      {
        name: 'transfer_source',
        description: 'DETERMINISM — Deterministic: moves one source between engrams via the op-log; recoverable.\n\nMove a single source (and all its derived memory nodes) from one engram to another. Use when the user says "move that note to my work engram" or "I put that in the wrong place." Requires the exact sourceId — use find_source or browse_engram first if unsure.',
        inputSchema: {
          type: 'object',
          properties: {
            sourceId: { type: 'string', description: 'The sourceId to move (e.g. "clip:abc123").' },
            from_engram: { type: 'string', description: 'Source engram (slug or display name).' },
            to_engram: { type: 'string', description: 'Destination engram (slug or display name).' },
          },
          required: ['sourceId', 'from_engram', 'to_engram'],
        },
        annotations: {
          title: 'Move source',
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      {
        name: 'ingest_batch',
        description: 'DETERMINISM — Deterministic: same ingest path as remember; no LLM.\n\nSave multiple notes in a single call — up to 20 items per batch. Each item may have its own target_engram. Useful when the user wants to bulk-import a list of facts, decisions, or to-dos without an individual remember call per item. Returns a per-item success/error summary.\n\nWHEN TO USE (vs `remember`):\n• Prefer ingest_batch over calling `remember` N times whenever you have 2 or more notes to save in the same turn — it is atomic, contradiction-checked per item, and produces a per-item success/error report.\n• Good fit for bulk-import flows: logs, sensor readings, lists of facts, decisions from a meeting. Each item may target a different engram.\n• Still use `remember` for a single note — ingest_batch of 1 is fine but adds no value.',
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: 'Notes to ingest. Max 20.',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  label: { type: 'string', description: 'Human-readable label for the Sources list.' },
                  target_engram: { type: 'string', description: 'Engram name (fuzzy-matched). Falls back to default engram.' },
                  graphId: { type: 'string', description: 'Exact engram slug (overrides target_engram).' },
                },
                required: ['text'],
              },
            },
          },
          required: ['items'],
        },
        annotations: {
          title: 'Batch save',
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      // ── Memory health ─────────────────────────────────────────────────────
      {
        name: 'engram_summary',
        description: 'DETERMINISM — Deterministic: a direct read of node previews; no LLM.\n\nReturn a readable snapshot of what\'s stored in a specific engram — node count, source count, and a sample of node content previews. Use when the user asks "what\'s in my X engram?", when deciding whether to merge or split an engram, or to orient yourself before querying a new engram.',
        inputSchema: {
          type: 'object',
          properties: {
            engram: { type: 'string', description: 'Engram slug or display name (fuzzy-matched).' },
            sample_size: { type: 'number', description: 'Number of node previews to include. Default 20, max 30.' },
          },
          required: ['engram'],
        },
        annotations: {
          title: 'Engram summary',
          readOnlyHint: true,
        },
      },
      {
        name: 'audit_memory',
        description: 'DETERMINISM — Approximate: uses vector similarity across engrams; results depend on embedding state. No LLM.\n\nDetect near-duplicate content across engrams by sampling top nodes from each engram and cross-searching them in all others above a similarity threshold. Use when the user asks "do I have duplicate notes?", before a merge, or for periodic memory hygiene. Note: this is approximate — it samples rather than exhaustively comparing every pair.',
        inputSchema: {
          type: 'object',
          properties: {
            engrams: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict audit to these engrams (slugs or names). Default: all non-archived, non-sensitive engrams.' },
            threshold: { type: 'number', description: 'Similarity threshold 0.5–1.0. Default 0.85. Lower = more matches, more noise.' },
          },
        },
        annotations: {
          title: 'Duplicate audit',
          readOnlyHint: true,
        },
      },
      {
        name: 'check_duplicate',
        description: 'DETERMINISM — Approximate: uses vector similarity; results depend on embedding state. No LLM.\n\nBefore calling remember, check whether very similar content already exists in one or all engrams. Returns matching nodes above the threshold so the user can decide whether to remember (new fact) or correct (updating an existing one). Helps prevent duplicate-node pollution.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The note text you\'re about to remember.' },
            engram: { type: 'string', description: 'Optional: restrict check to one engram.' },
            threshold: { type: 'number', description: 'Similarity threshold 0.5–1.0. Default 0.85.' },
          },
          required: ['text'],
        },
        annotations: {
          title: 'Pre-save duplicate check',
          readOnlyHint: true,
        },
      },
      {
        name: 'duplicate_pairs',
        description: 'DETERMINISM — Deterministic: reads the brain engine\'s already-computed queue; no LLM.\n\nReturn near-duplicate node pairs the brain engine has already flagged for review — these are high-confidence matches computed by the background scan, not ad-hoc searches. Use when the user asks "what does my brain think is duplicated?" or as part of a memory-hygiene workflow. To resolve: call correct to merge, or forget(nodeIds=[nodeId]) to remove one side. Requires the brain engine to be running (Graphnosis app open).',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max pairs to return. Default 20.' },
          },
        },
        annotations: {
          title: 'Duplicate pairs',
          readOnlyHint: true,
        },
      },
      {
        name: 'contradiction_pairs',
        description: 'DETERMINISM — Deterministic: reads the brain engine\'s already-computed queue; no LLM.\n\nReturn CONTRADICTING node pairs the brain engine\'s periodic reflection scan has flagged — two memories that share entities but assert conflicting content (e.g. "X lives in Cluj" vs "X lives in Bucharest"). Distinct from duplicate_pairs (those are near-IDENTICAL; these are near-OPPOSITE). Use in a memory-hygiene or consistency-audit workflow, or when the user asks "is anything in my memory contradictory?". To resolve: call edit to supersede the outdated side — never add a third conflicting note. Requires the brain engine running (Graphnosis app open).',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max pairs to return. Default 20.' },
          },
        },
        annotations: {
          title: 'Contradiction pairs',
          readOnlyHint: true,
        },
      },
      {
        name: 'healing_journal',
        description: 'DETERMINISM — Deterministic: reads a fixed audit log; no LLM.\n\nReturn the audit log of autonomous corrections the brain engine applied in the background — merges, confidence adjustments, and edge repairs the system made without explicit user prompting. Use when the user asks "what has my brain fixed on its own?" or to verify that a scheduled consolidation ran. Requires the brain engine to be running.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max records to return. Default 20.' },
          },
        },
        annotations: {
          title: 'Self-healing log',
          readOnlyHint: true,
        },
      },
      // ── On-demand LLM & GNN ───────────────────────────────────────────────
      {
        name: 'gnn_status',
        description: 'DETERMINISM — Deterministic: reads Neural Network state; no LLM.\n\nCheck whether the Graphnosis Neural Network is enabled, how many predicted edges it has computed, and when it last ran. Use before calling gnn_neighbors to confirm the GNN has data, or when the user asks "is the neural network running?". Requires the brain engine to be running.',
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          title: 'Neural network status',
          readOnlyHint: true,
        },
      },
      {
        name: 'gnn_neighbors',
        description: 'DETERMINISM — Non-deterministic: Neural Network edge predictions vary between runs.\n\nReturn nodes the Neural Network predicts are related to a query — connections that lexical/embedding recall did not surface directly. Use when the user asks "what else might be related to X?" or when recall returns thin results and you want to explore the graph\'s structural neighborhood. Each result includes the GNN edge probability score. Requires the brain engine with Neural Network enabled.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Topic or question to find GNN-predicted neighbors for.' },
            engram: { type: 'string', description: 'Optional: restrict to one engram.' },
            limit: { type: 'number', description: 'Max neighbors to return. Default 10.' },
          },
          required: ['query'],
        },
        annotations: {
          title: 'Neural network neighbors',
          readOnlyHint: true,
        },
      },
      {
        name: 'llm_query',
        description: 'DETERMINISM — Non-deterministic: local LLM synthesis varies between runs.\n\nRecall relevant memory for a question, then use the local LLM to synthesise a direct answer from that recalled context — all locally, nothing leaves the device. Use when the user wants an AI-synthesised answer grounded in their own memory, not just raw recalled nodes. If the local LLM is not running, returns the raw recalled context with a note explaining the degraded mode. Requires the brain engine to be running.',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to answer from memory.' },
            only_engrams: { type: 'array', items: { type: 'string' }, description: 'Optional: restrict recall to these engrams.' },
            maxTokens: { type: 'number', description: 'Token budget for recalled context. Default 2000.' },
          },
          required: ['question'],
        },
        annotations: {
          title: 'Local AI query',
          readOnlyHint: true,
        },
      },
      {
        name: 'llm_distill',
        description: 'DETERMINISM — Non-deterministic: local LLM extraction varies between runs.\n\nPass arbitrary text to the local LLM and ask it to extract discrete, self-contained facts worth remembering. Returns a JSON array of { text, label } objects ready to pass to ingest_batch or remember — all locally, nothing leaves the device. Use when the user pastes a long document, meeting notes, or conversation and asks you to extract key facts for saving. Degrades gracefully when no local LLM is running. Requires the brain engine to be running.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to extract facts from.' },
            target_engram: { type: 'string', description: 'Optional: suggested engram for the extracted facts (included in the output).' },
          },
          required: ['text'],
        },
        annotations: {
          title: 'Extract facts',
          readOnlyHint: true,
        },
      },
      {
        name: 'confirm_data_access',
        description: `Called after the user has physically looked at the Graphnosis app and typed the time-limited consent phrase shown in Settings → AI → Consent Phrases. Validates the phrase and stores a consent record.

WHEN TO CALL: Only after displaying the full GRAPHNOSIS CONSENT REQUIRED notice to the user and they have opened the Graphnosis app, read the phrase, and typed it here.
NEVER call preemptively. NEVER supply the phrase yourself. NEVER guess.`,
        inputSchema: {
          type: 'object',
          properties: {
            phrase: {
              type: 'string',
              description: 'The exact phrase the user typed (from Graphnosis app → Settings → AI → Consent Phrases). Pass it as-is; do not modify, trim, or guess.',
            },
            tier: {
              type: 'string',
              enum: ['personal', 'sensitive'],
              description: 'The data tier being authorised, as stated in the consent notice.',
            },
          },
          required: ['phrase', 'tier'],
        },
        annotations: {
          title: 'Confirm data access',
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      // ── Skill training (monthly subscription) ───────────────────────────────
      {
        name: 'train_skill',
        description:
          'DETERMINISM — Conditional. Memory surfacing is deterministic (same recall, same nodes). ' +
          'The rewrite step is non-deterministic when the local LLM is on; deterministic ' +
          '(memory-augmented: memories appended as context, no rewrite) when the LLM is off. ' +
          'The response `mode` field reports which path ran.\n\n' +
          'Personalize an AI skill using the user\'s Graphnosis memories. ' +
          'A "skill" is any AI behavior instruction: a Claude Code skill file, a system prompt, ' +
          'a CLAUDE.md block, a .cursorrules file, a ChatGPT system message — anything that ' +
          'shapes how an AI assistant behaves.\n\n' +
          'HOW IT WORKS:\n' +
          '1. Recall: surface the memories most relevant to this skill (federated, GNN-aware).\n' +
          '2. Personalize: if the Local LLM is on, rewrite the skill to reflect those memories ' +
          '   with per-change attribution ("from memory"). If the LLM is off, append the top ' +
          '   memories as a "Personal Context" block — still valuable; the AI consuming the ' +
          '   skill sees and applies the context.\n' +
          '3. Save: store the trained version in the Skills engram as a new node.\n\n' +
          'WHEN TO CALL:\n' +
          '• User says "train my code review skill", "personalize this prompt", ' +
          '  "use my memory to improve this instruction"\n' +
          '• User pastes a skill and says "make this match my style"\n' +
          '• Skill vitality is low (skill_vitality returned < 60)\n\n' +
          'Requires a Skills engram (template: skill). If none exists, tell the user to ' +
          'create one in Graphnosis → New Engram → Skill. ' +
          'Monthly subscription required for LLM-powered rewriting; ' +
          'memory-augmented mode is always available.',
        inputSchema: {
          type: 'object',
          properties: {
            skill: {
              type: 'string',
              description: 'The full text of the skill/instruction to personalize.',
            },
            skill_name: {
              type: 'string',
              description: 'Human-readable name for this skill (used as the label in the Skills engram). Optional.',
            },
            target_engram: {
              type: 'string',
              description: 'Name or ID of the Skills engram to save into. Default: the engram named "Skills" or "AI Skills".',
            },
            focus_engrams: {
              type: 'array',
              items: { type: 'string' },
              description: 'Restrict memory recall to these engram names/IDs. Omit to search all engrams (recommended).',
            },
            model_target: {
              type: 'string',
              enum: ['generic', 'claude', 'cursor', 'openai', 'copilot'],
              description: 'Target AI tool — shapes export hints in the diff notes. Default: generic.',
            },
            save: {
              type: 'boolean',
              description: 'Whether to save the trained version into the Skills engram. Default true. Pass false to preview without persisting.',
            },
            recall_breadth: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
              description: '0 = Broad (max context, up to 50 nodes from all engrams). 100 = Exact (strict semantic match, ~12 nodes). Omit to use auto-tuned value (starts at 50, self-adjusts after each training run based on cited/fetched ratio).',
            },
            use_llm_rewrite: {
              type: 'boolean',
              description: 'Opt into the LLM-rewrite path (clean goal/step structure, change attribution) instead of the default memory-augmented path (memories appended as a Personal Context block). Requires the Local LLM to be enabled (Foresight → Local LLM); falls back to memory-augmented if the LLM is unavailable or times out. Default false.',
            },
          },
          required: ['skill'],
        },
        annotations: {
          title: 'Train skill',
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      {
        name: 'skill_vitality',
        description:
          'DETERMINISM — Deterministic: reads engram metadata; no LLM.\n\n' +
          'How fresh is a trained skill? Returns a 0–100 score that drops as the skill ages ' +
          'and as its nodes are superseded by retraining.\n\n' +
          '  100   = just trained, fully fresh\n' +
          '  80–99 = fresh, no retraining needed\n' +
          '  60–79 = aging, consider retrain if cortex has grown\n' +
          '  40–59 = moderately stale, retrain recommended\n' +
          '  0–39  = stale, call train_skill\n\n' +
          'WHEN TO CALL:\n' +
          '• User asks "how fresh is my X skill?" or "should I retrain my prompt?"\n' +
          '• Before calling train_skill — if vitality is high, skip the retrain.',
        inputSchema: {
          type: 'object',
          properties: {
            source_id: {
              type: 'string',
              description: 'The sourceId of the trained skill (returned by train_skill as `skill_id`).',
            },
            target_engram: {
              type: 'string',
              description: 'Name or ID of the Skills engram containing this skill.',
            },
          },
          required: ['source_id'],
        },
        annotations: {
          title: 'Skill freshness',
          readOnlyHint: true,
        },
      },
      {
        name: 'export_skill',
        description:
          'DETERMINISM — Deterministic: format conversion; no LLM, no recall.\n\n' +
          'Export a trained skill in a target AI tool\'s native format. ' +
          'Memory references, node IDs, and graph metadata are stripped — only the ' +
          'behavioral content is exported. The personalization travels; the memories ' +
          'that caused it stay local.\n\n' +
          'Formats:\n' +
          '  claude-md     — CLAUDE.md snippet (copy into your project\'s CLAUDE.md)\n' +
          '  cursorrules   — .cursorrules entry\n' +
          '  system-prompt — Generic system prompt (paste into any AI tool)\n' +
          '  openai        — OpenAI API system message JSON\n' +
          '  raw           — Clean skill text with no wrapper\n' +
          '  gsk           — Graphnosis Skills Kit pack (.gsk encrypted JSON, base64-encoded in response)\n\n' +
          'WHEN TO CALL:\n' +
          '• User says "export my X skill for Cursor", "give me this as a CLAUDE.md block"\n' +
          '• After training, to deploy the skill in a specific AI tool\n' +
          '• User says "pack this as a .gsk file" or "export as Skills Pack"',
        inputSchema: {
          type: 'object',
          properties: {
            skill_text: {
              type: 'string',
              description: 'The trained skill text to export. Pass the `trained` field from train_skill output, or retrieve it from the Skills engram via recall_source.',
            },
            format: {
              type: 'string',
              enum: ['claude-md', 'cursorrules', 'system-prompt', 'openai', 'raw', 'gsk'],
              description: 'Target format.',
            },
          },
          required: ['skill_text', 'format'],
        },
        annotations: {
          title: 'Export skill',
          readOnlyHint: true,
        },
      },
      {
        name: 'export_engram',
        description:
          'DETERMINISM — Deterministic: reads all sources from one engram, returns an encrypted `.gez` pack (base64-encoded).\n\n' +
          'Export an entire engram as a signed, encrypted Graphnosis Engram Zero (`.gez`) pack for air-gapped sharing.\n\n' +
          'The pack contains the full text of every source in the engram, encrypted with AES-256-GCM and optionally ' +
          'signed with the cortex\'s Ed25519 key so recipients can verify authenticity. Personal memories stay in ' +
          'the pack — only share with trusted recipients or within your organization.\n\n' +
          'WHEN TO CALL:\n' +
          '• "Export my project engram to share with a colleague"\n' +
          '• "Create an air-gapped pack for the team"\n' +
          '• "Pack my research engram for offline transfer"',
        inputSchema: {
          type: 'object',
          properties: {
            engram: {
              type: 'string',
              description: 'Engram ID or display name to export.',
            },
            sign: {
              type: 'boolean',
              description: 'Sign the pack with this cortex\'s Ed25519 key (default: true). Recipients can verify authorship offline.',
            },
          },
          required: ['engram'],
        },
        annotations: { title: 'Export engram pack' },
      },
      {
        name: 'import_engram',
        description:
          'DETERMINISM — Deterministic: decrypts and re-ingests sources from a `.gez` pack.\n\n' +
          'Import a `.gez` Graphnosis Engram Zero pack into this cortex. Each source in the pack is ' +
          're-ingested into the target engram. Existing sources (matched by sourceId) are skipped by default.\n\n' +
          'Returns a per-source outcome report and whether the pack\'s signature verified.\n\n' +
          'WHEN TO CALL:\n' +
          '• "Import this engram pack a colleague sent me"\n' +
          '• "Load the .gez file into my research engram"\n' +
          '• "Merge this pack into my project engram"',
        inputSchema: {
          type: 'object',
          properties: {
            pack_base64: {
              type: 'string',
              description: 'Base64-encoded `.gez` pack bytes (as returned by export_engram).',
            },
            target_engram: {
              type: 'string',
              description: 'Target engram ID or display name. Defaults to the pack\'s original engram ID. Created if it doesn\'t exist.',
            },
            skip_existing: {
              type: 'boolean',
              description: 'Skip sources whose sourceId already exists in the target engram (default: true). Set false to re-ingest and overwrite.',
            },
          },
          required: ['pack_base64'],
        },
        annotations: { title: 'Import engram pack' },
      },
        {
          name: 'list_skills',
          description: 'List all trained skills stored in the user\'s Skills engram(s). Returns sourceId, label, engram name, training date, mode, recallBreadth, and active node count for each skill. Use this before get_skill, skill_history, rollback_skill, or delete_skill to discover available skills and their sourceIds. Optionally scope to a specific engram slug.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              engram: { type: 'string', description: 'Engram slug to scope the listing (e.g. "skills"). Omit to list skills across all engrams.' },
            },
          },
          annotations: {
            title: 'List skills',
            readOnlyHint: true,
          },
        },
        {
          name: 'walk_skill',
          description: 'Walk a skill as a Standard Operating Procedure (SOP). Returns human-readable narrative text with CONSTRAINTS / PROCEDURE sections — loop-back, conditional-branch, sub-skill invocations, failure handlers. Use this when you need to explain the skill to a user or guide them through it conversationally. For programmatic execution by an AI (invoking sub-skills, capturing return values, routing through failure handlers), prefer walk_skill_structured.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              graphId:   { type: 'string',  description: 'Engram slug containing the skill (e.g. "skills").' },
              sourceId:  { type: 'string',  description: 'sourceId of the skill from list_skills output.' },
              recursive: { type: 'boolean', description: 'When true, inline sub-skill steps for any step that invokes another skill. Default false.' },
            },
            required: ['graphId', 'sourceId'],
          },
          annotations: {
            title: 'Explain skill',
            readOnlyHint: true,
          },
        },
        {
          name: 'walk_skill_structured',
          description: 'Same as walk_skill but returns a SkillExecutionPlan as JSON: { skill, requires[], requiresTypes{}, produces[], constraints, steps[], failureHandlers[], unanchoredContext[] }. `requiresTypes` maps a required var to its declared type hint (e.g. {branch:"string", policy:"{phased|atomic}"}) — validate the values you pass before invoking. Each step entry may include `calls` (one sub-skill + args + captureAs), `parallel` (an ARRAY of sub-skills to dispatch CONCURRENTLY, each with its own captureAs), `maxIterations` (a loop-convergence cap — stop looping back after this many iterations), `unresolvedCall`, `branchesTo`, `loopsBackTo`, and `supportingContext`. Use this when the AI will actually EXECUTE the skill — walk steps in order, invoke sub-skills with the named args, capture their return values under the named variables, run `parallel` members concurrently, respect `maxIterations` on loops, and on exception route to the matching failureHandlers entry. Prefer this over walk_skill for any procedural execution task; pair with walk_skill when the user also needs a human-readable explanation.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              graphId:   { type: 'string',  description: 'Engram slug containing the skill (e.g. "skills").' },
              sourceId:  { type: 'string',  description: 'sourceId of the skill from list_skills output.' },
              recursive: { type: 'boolean', description: 'When true, inline sub-skill steps for any step that invokes another skill. Default false.' },
            },
            required: ['graphId', 'sourceId'],
          },
          annotations: {
            title: 'Execute skill plan',
            readOnlyHint: true,
          },
        },
        {
          name: 'save_skill_run',
          description: 'Persist the state of a multi-skill execution so it can be RESUMED in a later session (D5). Call this as you walk a skill, after each step or capture, passing the variables you have captured so far and how far you have got. Captured vars normally live only for one conversation; this stores them in the cortex. Returns { runId } — pass that same runId on subsequent saves (to update the run) and to resume_skill_run later. Omit runId on the first call to start a new run.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              runId:              { type: 'string', description: 'Existing run to update. Omit to start a new run (a runId is generated and returned).' },
              skillGraphId:       { type: 'string', description: 'Engram slug of the skill being executed.' },
              skillSourceId:      { type: 'string', description: 'sourceId of the skill being executed.' },
              planTitle:          { type: 'string', description: 'Optional human-readable skill title, for listing.' },
              capturedVars:       { type: 'object', description: 'Map of captured variable name (without `$`) → value, accumulated so far.' },
              completedStepIndex: { type: 'number', description: '1-based index of the last COMPLETED step (0 = none yet). Resume continues at this + 1.' },
            },
            required: ['skillGraphId', 'skillSourceId', 'capturedVars', 'completedStepIndex'],
          },
          annotations: {
            title: 'Save skill run',
            readOnlyHint: false,
            destructiveHint: false,
          },
        },
        {
          name: 'resume_skill_run',
          description: 'Resume a previously-saved multi-skill execution (D5). Returns the saved run: the skill reference, the captured variables, the last completed step, and nextStepIndex (the 1-based step to continue at). Pair with walk_skill_structured on the returned skill to get the remaining steps. Use list… nothing — you must already have the runId from a prior save_skill_run.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              runId: { type: 'string', description: 'The runId returned by save_skill_run.' },
            },
            required: ['runId'],
          },
          annotations: {
            title: 'Resume skill run',
            readOnlyHint: true,
          },
        },
        {
          name: 'get_skill',
          description: 'Retrieve the full text and metadata of a specific trained skill by its sourceId. Returns the skill text (metadata header + trained content), training mode, recallBreadth, and node count. Use list_skills first to find the sourceId.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              graphId: { type: 'string', description: 'Engram slug containing the skill (e.g. "skills").' },
              sourceId: { type: 'string', description: 'sourceId of the skill from list_skills output.' },
            },
            required: ['graphId', 'sourceId'],
          },
          annotations: {
            title: 'Get skill',
            readOnlyHint: true,
          },
        },
        {
          name: 'skill_history',
          description: 'Show the full version history of a skill — all trained versions grouped by skill name, newest first. Each entry includes sourceId, label, ingestedAt, nodeCount, and whether it is the current (most recent) version. Use to understand how a skill has evolved and to find the sourceId for rollback_skill.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              graphId: { type: 'string', description: 'Engram slug containing the skill.' },
              sourceId: { type: 'string', description: 'sourceId of any version of the skill — the full history for that skill name is returned.' },
            },
            required: ['graphId', 'sourceId'],
          },
          annotations: {
            title: 'Skill history',
            readOnlyHint: true,
          },
        },
        {
          name: 'rollback_skill',
          description: 'Restore a skill to a prior pre-retrain snapshot. The current source contents are first re-snapshotted (so this rollback can itself be rolled back), then replaced with the snapshot\'s nodes. Use skill_history first to find the snapshotId to restore — each row\'s `snapshotId` field is the value to pass here. Skills now live in a single source per name; snapshots are encrypted side-table files keyed by sourceId.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              graphId: { type: 'string', description: 'Engram slug containing the skill.' },
              sourceId: { type: 'string', description: 'sourceId of the skill to roll back. Same value across every history row of the same skill.' },
              snapshotId: { type: 'string', description: 'snapshotId of the version to restore (returned by skill_history).' },
            },
            required: ['graphId', 'sourceId', 'snapshotId'],
          },
          annotations: {
            title: 'Rollback skill',
            readOnlyHint: false,
            destructiveHint: true,
          },
        },
        {
          name: 'delete_skill',
          description: 'Delete a trained skill from the Skills engram. By default deletes only the specified version. Set all_versions=true to delete the skill and its entire version history (all trained versions with the same base name). This is a soft delete — recoverable from the op-log via the Graphnosis app.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              graphId: { type: 'string', description: 'Engram slug containing the skill.' },
              sourceId: { type: 'string', description: 'sourceId of the skill version to delete.' },
              all_versions: { type: 'boolean', description: 'If true, delete all versions of this skill (same base name). Default false.' },
            },
            required: ['graphId', 'sourceId'],
          },
          annotations: {
            title: 'Delete skill',
            readOnlyHint: false,
            destructiveHint: true,
          },
        },

    ].filter((t) => !disabled.has(t.name)),
    };
  });

  // ── Sharing scope helpers ─────────────────────────────────────────────────
  // These are called from tool handlers when deps.sharingScope is present.
  // Both no-op when there is no scope (owner session).

  /**
   * Merge the session's engram scope into tool input's `only_engrams`.
   * If scope.engrams is an array, the result is the intersection of the
   * AI-requested list and the allowed set (or the allowed set when none was
   * requested). If scope.engrams is '*', no-op. When scope applies, the
   * returned object replaces only_engrams and drops except_engrams (the
   * allow-list supersedes the deny-list).
   */
  function applyEngramScope(input: {
    only_engrams?: string[] | undefined;
    except_engrams?: string[] | undefined;
  }): { only_engrams?: string[]; except_engrams?: string[] } {
    const scope = deps.sharingScope;
    if (!scope || scope.engrams === '*') return input as { only_engrams?: string[]; except_engrams?: string[] };
    const allowed = scope.engrams as string[];
    const requested = input.only_engrams ?? [];
    const intersected = requested.length > 0
      ? requested.filter((e) => allowed.includes(e))
      : [...allowed];
    // Return only only_engrams — scope supersedes except_engrams.
    const result: { only_engrams?: string[] } = { only_engrams: intersected };
    return result;
  }

  /**
   * Throw an MCP error if the session role is 'viewer'. Called before any
   * write tool (remember, forget, edit, apply, ingest_batch, etc.).
   */
  function assertWriteAllowed(): void {
    const scope = deps.sharingScope;
    if (scope && scope.role === 'viewer') {
      throw new ScopeViolationError(
        '⛔ This share is read-only (viewer role). Contact the cortex owner to request editor access.',
      );
    }
  }

  // Extracted tool dispatcher — all 47+ tool handlers live here.
  // Both the MCP setRequestHandler (external AI clients) and Ghampus
  // (internal chat path) call this function so each tool is implemented
  // exactly once. The MCP wrapper adds policy checks; Ghampus skips them
  // (it runs as the owner with no client-disable or tool-allowlist gates).
  async function dispatchTool(name: string, rawInput: Record<string, unknown>): Promise<McpToolResult> {
    try {
    switch (name) {
      case 'recall':
      case 'remind': {
        // `remind` is an alias for `recall` — same input schema, same
        // handler, same audit. Two tool names give the AI two semantic
        // anchors to score against the user's prompt ("recall" matches
        // "what do I know about X"; "remind" matches "remind me about
        // X"). The audit line tags which name was used so we can see in
        // logs how often each phrasing fires.
        const toolName = name;
        const rawArgs = RecallInput.parse(rawInput);
        const args = { ...rawArgs, ...applyEngramScope(rawArgs) };
        const budget = {
          maxTokens: args.maxTokens ?? 2000,
          maxNodes: args.maxNodes ?? 20,
          // Reserve a token floor per engram so small engrams (e.g. a 3-node
          // personal note) are not fully crowded out by larger high-scoring
          // engrams (docs, coding) that exhaust the budget first.
          perGraphMinTokens: 150,
        };
        const only = args.only_engrams?.length ? resolveEngramList(deps.host, args.only_engrams) : null;
        const except = (!only && args.except_engrams?.length) ? resolveEngramList(deps.host, args.except_engrams) : null;
        enforceRecallRateLimit();
        enforceReplayBlocker(args.query);
        const { consentFooter, autoExceptGraphIds } = await checkConsentOrThrow(only?.resolved ?? null);
        // Merge any auto-excluded engrams (e.g. un-consented sensitive
        // tier on a federated recall) with the AI-provided exceptions.
        const mergedExcept = [...(except?.resolved ?? []), ...autoExceptGraphIds];
        const sub = await withEmbedding(() => deps.host.recall(args.query, {
          budget,
          ...(only?.resolved.length ? { onlyGraphIds: only.resolved } : {}),
          ...(mergedExcept.length ? { exceptGraphIds: mergedExcept } : {}),
          // The engrams in `only` are explicitly named AND have passed the
          // consent gate above (checkConsentOrThrow throws otherwise), so they
          // may bypass the shareability filter — a consented sensitive engram
          // returns data, clamped to its tier cap. Proactive recall (no `only`)
          // passes nothing here, so sensitive stays excluded.
          ...(only?.resolved.length ? { consentedGraphIds: only.resolved } : {}),
        }));
        const scopeWarnings = [...(only?.warnings ?? []), ...(except?.warnings ?? [])];
        // Structured audit line for the desktop inspector. PRIVACY: the
        // user's actual query is NOT logged (it would land in dev terminals,
        // crash reports, and the App-as-parent stderr buffer). We log only
        // its length + a stable short hash so the inspector can correlate
        // identical calls without retaining content. Engram names are
        // intentionally not logged either — they're user-chosen labels
        // that may themselves leak topic info (e.g. "health-bloodwork").
        // Counts and tier rollups are kept because they're useful for
        // "why did recall return nothing?" debugging and reveal nothing
        // about the user.
        const tierSummary = sub.audit.reduce<Record<string, { n: number; t: number }>>((acc, a) => {
          const slot = acc[a.tier] ?? (acc[a.tier] = { n: 0, t: 0 });
          slot.n += a.nodesIncluded; slot.t += a.tokensIncluded;
          return acc;
        }, {});
        console.error(`[${toolName}] qLen=${args.query.length} requested=${budget.maxNodes}n/${budget.maxTokens}t served=${sub.nodesIncluded}n/${sub.tokensUsed}t tiers=${JSON.stringify(tierSummary)} graphs=${sub.audit.length}`);
        enforceSessionBudget(sub.tokensUsed, sub.nodesIncluded);
        // Audit footer — only list engrams that ACTUALLY contributed nodes
        // to this recall. The full sub.audit roster includes every engram
        // the federation iterated, most of which contribute zero on any
        // given query. Returning the whole list to the AI client leaked
        // every engram name the user has (including engrams the AI should
        // arguably never know exist) AND added noise — 14 "0n · 0t" entries
        // for every 2 useful ones. The contributing engram names are
        // already visible in the prompt body as `## <displayName>` section
        // headers, so this footer is purely informational + tier signal.
        const contributing = sub.audit.filter((a) => a.nodesIncluded > 0);
        const skippedCount = sub.audit.length - contributing.length;
        const perGraphPart = contributing.length > 0
          ? ` Per-graph (tier · nodes · tokens): ${contributing.map(a => `${a.graphId} · ${a.tier} · ${a.nodesIncluded}n · ${a.tokensIncluded}t`).join(', ')}.`
          : '';
        const skippedPart = skippedCount > 0
          ? ` (${skippedCount} other engram${skippedCount === 1 ? '' : 's'} searched, no matches.)`
          : '';
        const auditFooter =
          '\n\n---\n' +
          `Attached ${sub.nodesIncluded} memory node(s) / ${sub.tokensUsed} tokens across ${contributing.length} graph(s).` +
          perGraphPart +
          skippedPart +
          (scopeWarnings.length ? ` Scope warnings: ${scopeWarnings.join(' ')}` : '');
        const headsUp = anomalyHeadsUp({
          kind: 'recall',
          nodesReturned: sub.nodesIncluded,
          nodesRequested: budget.maxNodes,
          engramsContributing: contributing.length,
          engramsSearched: sub.audit.length,
          query: args.query,
          tool: toolName,
        }) ?? '';
        // Savings tracking: a successful recall returned context to the
        // AI client *without* the client having to fire its own LLM call
        // to produce that context. The counterfactual cost is the
        // baseline rate applied to the same token volume. Fire-and-
        // forget — failure here mustn't break the recall path.
        if (sub.nodesIncluded > 0) {
          import('./savings-tracker.js').then(({ recordRecallOnlySavings }) => {
            void recordRecallOnlySavings(deps.host.getCortexDir(), {
              inputTokensSaved: sub.tokensUsed,
              outputTokensSaved: 0,
              source: `mcp:${toolName}`,
            }).catch(() => { /* non-fatal */ });
          }).catch(() => { /* dynamic import failed — skip silently */ });
        }
        return { content: [{ type: 'text', text: sub.prompt + auditFooter + headsUp + pendingEngramNotice(deps.host) + consentFooter }] };
      }
      case 'dig_deeper': {
        // Multi-strategy retrieval. Same input shape as recall + only/except
        // engrams + a higher default token budget (3000 vs recall's 2000)
        // because the pipeline naturally returns more.
        const rawDdArgs = RecallInput.parse(rawInput);
        const args = { ...rawDdArgs, ...applyEngramScope(rawDdArgs) };
        const budget = {
          maxTokens: args.maxTokens ?? 3000,
          maxNodes: args.maxNodes ?? 20,
          perGraphMinTokens: 150,
        };
        const only = args.only_engrams?.length ? resolveEngramList(deps.host, args.only_engrams) : null;
        const except = (!only && args.except_engrams?.length) ? resolveEngramList(deps.host, args.except_engrams) : null;
        enforceRecallRateLimit();
        enforceReplayBlocker(args.query);
        const { consentFooter, autoExceptGraphIds } = await checkConsentOrThrow(only?.resolved ?? null);
        const mergedExcept = [...(except?.resolved ?? []), ...autoExceptGraphIds];
        const sub = await withEmbedding(() => deps.host.digDeeper(args.query, {
          budget,
          ...(only?.resolved.length ? { onlyGraphIds: only.resolved } : {}),
          ...(mergedExcept.length ? { exceptGraphIds: mergedExcept } : {}),
          ...(only?.resolved.length ? { consentedGraphIds: only.resolved } : {}),
        }));
        const scopeWarnings = [...(only?.warnings ?? []), ...(except?.warnings ?? [])];
        // Structured log line for power-user debugging — single line per
        // dig_deeper call, no PII, redacted engram refs. Devs grep this
        // when investigating user reports about over-/under-expansion.
        const prov = sub.digDeeperProvenance;
        console.error(
          `[dig_deeper] qLen=${args.query.length} ` +
          `content=${prov.contentMatch.nodes}n@${prov.contentMatch.avgScore.toFixed(2)} ` +
          `sourceFilename=${prov.sourceFilenameExpansion.nodes}n ` +
          `crossEngram=${prov.crossEngramEntityHop.nodes}n ` +
          `total=${sub.nodesIncluded}n/${sub.tokensUsed}t`,
        );
        enforceSessionBudget(sub.tokensUsed, sub.nodesIncluded);
        const contributing = sub.audit.filter((a) => a.nodesIncluded > 0);
        const skippedCount = sub.audit.length - contributing.length;
        const perGraphPart = contributing.length > 0
          ? ` Per-graph (tier · nodes · tokens): ${contributing.map(a => `${a.graphId} · ${a.tier} · ${a.nodesIncluded}n · ${a.tokensIncluded}t`).join(', ')}.`
          : '';
        const skippedPart = skippedCount > 0
          ? ` (${skippedCount} other engram${skippedCount === 1 ? '' : 's'} searched, no matches.)`
          : '';
        const auditFooter =
          '\n\n---\n' +
          `Attached ${sub.nodesIncluded} memory node(s) / ${sub.tokensUsed} tokens across ${contributing.length} graph(s) — via dig_deeper (multi-strategy).` +
          perGraphPart +
          skippedPart +
          (scopeWarnings.length ? ` Scope warnings: ${scopeWarnings.join(' ')}` : '');
        // dig_deeper already emits its own strategy-mix heads-up inside the
        // prompt body (when direct-content recall returned few nodes and most
        // results came from source-filename / cross-engram expansion). On top
        // of that, the shared anomaly check fires for the "wide-search, thin
        // return" case so the user hears about it even when expansion didn't
        // pad the response.
        const ddHeadsUp = anomalyHeadsUp({
          kind: 'recall',
          nodesReturned: sub.nodesIncluded,
          nodesRequested: budget.maxNodes,
          engramsContributing: contributing.length,
          engramsSearched: sub.audit.length,
          query: args.query,
          tool: 'dig_deeper',
        }) ?? '';
        return { content: [{ type: 'text', text: sub.prompt + auditFooter + ddHeadsUp + pendingEngramNotice(deps.host) + consentFooter }] };
      }
      case 'remember': {
        assertWriteAllowed();
        const args = RememberInput.parse(rawInput);

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
            triggeredBy: 'mcp:remember',
          })
        ) as import('@graphnosis-app/core').SourceRecord & { contradictions?: unknown[] };
        let msg = `Saved to ${graphId} as ${rec.sourceId}.`;
        if (rec.contradictions && rec.contradictions.length > 0) {
          msg +=
            `\n\n⚠️ Detected ${rec.contradictions.length} contradiction(s) with existing memory. ` +
            `This often means the user was correcting a previous note, not adding a new one. ` +
            `Tell the user the previous note is now contradicted and offer to call \`edit\` or \`forget\` to clean it up. ` +
            `Contradictions: ${JSON.stringify(rec.contradictions)}`;
        }
        return { content: [{ type: 'text', text: msg }] };
      }
      case 'edit':
      // 'correct' kept as a backward-compatible alias — AI clients that have
      // the old tool name in their conversation history continue to work.
      case 'correct': {
        assertWriteAllowed();
        const args = CorrectInput.parse(rawInput);
        // Auto-switch. deps.llm() returns the Local LLM only when the user has
        // enabled it for this cortex. The Neural Network, when enabled, supplies
        // a GNN candidate expander. `correct` works in every combination and
        // never throws for a missing model.
        const llm = deps.llm('correctionParsing');
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
        deps.pendingDiffs.set(diffId, { graphId: targetGraph, diff, createdAt: Date.now(), mode, prompt: args.correction });
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
        const correctHeadsUp = anomalyHeadsUp({ kind: 'edit', candidatesFound: candidates.length });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ diffId, mode, preview: diff, candidates }, null, 2) + (correctHeadsUp ?? ''),
          }],
        };
      }
      case 'apply': {
        assertWriteAllowed();
        const args = ApplyInput.parse(rawInput);
        const pending = deps.pendingDiffs.get(args.diffId);
        if (!pending) throw new Error(`No pending diff ${args.diffId}. The user must confirm in the app first.`);
        const correctedBy = mcpRegistry.getMostRecentClientName();
        await applyCorrection({
          host: deps.host,
          graphId: pending.graphId,
          diff: pending.diff,
          ...(correctedBy ? { correctedBy } : {}),
          ...(pending.mode ? { mode: pending.mode } : {}),
          ...(pending.prompt ? { prompt: pending.prompt } : {}),
          triggeredBy: 'mcp:edit',
        });
        deps.pendingDiffs.delete(args.diffId);
        return { content: [{ type: 'text', text: 'Applied.' }] };
      }
      case 'forget': {
        assertWriteAllowed();
        const args = ForgetInput.parse(rawInput);
        // Coalesce the two accepted shapes into one normalized list. `items`
        // wins when both are present (it's the safer payload — has previews).
        const usedItemsShape = (args.items?.length ?? 0) > 0;
        const targets: Array<{ nodeId: string; preview?: string }> = usedItemsShape
          ? args.items!.map(i => ({ nodeId: i.nodeId, preview: i.preview }))
          : (args.nodeIds ?? []).map(id => ({ nodeId: id }));
        if (targets.length === 0) {
          return mcpError('forget requires either `items: [{nodeId, preview}]` (preferred) or `nodeIds: [...]` (legacy).');
        }
        await deps.host.applyCorrection(
          args.graphId,
          { edits: targets.map(t => ({ kind: 'delete' as const, nodeId: t.nodeId, reason: 'forgotten by AI client' })) },
          { triggeredBy: 'mcp:forget' },
        );
        // Build a response that surfaces what was removed. When we have
        // previews, echo them back so the user (and any later audit) can
        // see what content actually got soft-deleted, not just opaque IDs.
        const lines: string[] = [];
        lines.push(`Forgot ${targets.length} node${targets.length === 1 ? '' : 's'} from "${args.graphId}":`);
        for (const t of targets) {
          if (t.preview) {
            // Trim preview to a single visible line; keep it under ~140 chars.
            const oneLine = t.preview.replace(/\s+/g, ' ').trim().slice(0, 140);
            const ellipsis = t.preview.length > 140 ? '…' : '';
            lines.push(`  • [${t.nodeId}] ${oneLine}${ellipsis}`);
          } else {
            lines.push(`  • [${t.nodeId}]`);
          }
        }
        // Nudge AIs still using the legacy shape to upgrade. This is the
        // user-safety channel: opaque-ID deletes are hard for the user to
        // approve safely, so we make sure the AI hears about it.
        if (!usedItemsShape) {
          lines.push('');
          lines.push(
            '⚠️ _Heads-up: this call used the legacy `nodeIds` shape with no content previews. ' +
            'Most MCP clients show your request payload to the user in a consent prompt before ' +
            'running the tool — with bare nodeIds the user sees only opaque strings and cannot ' +
            'tell what they\'re about to approve. Next time, use `items: [{nodeId, preview}]` ' +
            'where `preview` is the first ~120 chars of node text from `recall_structured`. ' +
            'The user (and the developer) will thank you._'
          );
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
      case 'stats': {
        const { includeNodes } = z.object({ includeNodes: z.coerce.boolean().optional() }).parse(rawInput);
        const s = deps.host.stats();
        const summary = s.graphs.map(g => ({
          graphId: g.graphId,
          totalNodes: g.totalNodes,
          activeNodes: g.activeNodes,
          softDeletedNodes: g.softDeletedNodes,
          sources: g.sources,
          ...(includeNodes ? { nodes: g.nodes.slice(0, 20) } : {}),
        }));
        const notice = pendingEngramNotice(deps.host);
        return { content: [{ type: 'text', text: JSON.stringify({ graphs: summary }, null, 2) + notice }] };
      }
      case 'develop': {
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
          if (!licensed) {
            return mcpError(
              'The develop tool requires a Graphnosis Pro subscription (Foresight). ' +
              'Subscribe at https://graphnosis.com/upgrade.',
            );
          }
        }
        refuseIfLlmRestrictedToSearch('develop');
        const args = z.object({
          context: z.string().min(1),
          strategy: z.string().min(1),
          goals: z.string().min(1),
          graphIds: z.array(z.string()).optional(),
          saveAsGoal: z.boolean().optional(),
        }).parse(rawInput);
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
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
          if (!licensed) {
            return mcpError(
              'The predict tool requires a Graphnosis Pro subscription (Foresight). ' +
              'Subscribe at https://graphnosis.com/upgrade.',
            );
          }
        }
        refuseIfLlmRestrictedToSearch('predict');
        const args = z.object({
          action: z.string().min(1),
          graphIds: z.array(z.string()).optional(),
        }).parse(rawInput);
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
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
          if (!licensed) {
            return mcpError(
              'The insights tool requires a Graphnosis Pro subscription (Foresight). ' +
              'Subscribe at https://graphnosis.com/upgrade.',
            );
          }
        }
        refuseIfLlmRestrictedToSearch('insights');
        const { dismissed } = z.object({ dismissed: z.boolean().optional() }).parse(rawInput);
        if (!deps.brainEngine) {
          return { content: [{ type: 'text', text: JSON.stringify([]) }] };
        }
        if (!deps.llm('insights')) {
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
        const vitalityHeadsUp = anomalyHeadsUp({
          kind: 'vitality',
          overall: report.overall,
          previous: _lastVitalityReading,
        }) ?? '';
        _lastVitalityReading = report.overall;
        return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) + vitalityHeadsUp }] };
      }
      // ── Navigation & routing ──────────────────────────────────────────────
      case 'list_engrams': {
        const statsByGraph = new Map(deps.host.stats().graphs.map(g => [g.graphId, g]));
        const rows = deps.host.graphsWithMetadata({ includeUnloaded: true }).map(({ graphId, metadata, loaded }) => ({
          graphId,
          displayName: metadata.displayName ?? graphId,
          tier: (metadata as any).sensitivityTier ?? 'personal',
          template: metadata.template,
          archived: (metadata as any).archived ?? false,
          loaded,
          sources: loaded ? deps.host.listSources(graphId).length : null,
          lastMutationAt: statsByGraph.get(graphId)?.lastMutationAt,
        }));
        const notice = pendingEngramNotice(deps.host);
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) + notice }] };
      }
      case 'list_attachments': {
        // File attachments — metadata only, never content. When called
        // from a sharing-tokened session, results are scope-filtered so
        // collaborators only see attachments from engrams they can
        // already recall from. Paths stay on the owner's machine and
        // we badge that explicitly in the response so AI clients know
        // not to try and `open` them.
        const args = z.object({ graphId: z.string().optional() }).parse(rawInput);
        const scope = deps.sharingScope;
        let allowedGraphIds: string[] | null = null;
        if (scope && scope.engrams !== '*') {
          allowedGraphIds = scope.engrams as string[];
        }
        if (args.graphId) {
          const resolved = resolveEngramList(deps.host, [args.graphId]);
          if (resolved.warnings.length > 0) {
            return mcpError(`Engram "${args.graphId}" not found.`);
          }
          // Honor scope: refuse to list if the requested engram isn't
          // in the caller's sharing scope.
          if (allowedGraphIds && !allowedGraphIds.includes(resolved.resolved[0]!)) {
            return mcpError(`Engram "${args.graphId}" is outside your sharing scope.`);
          }
          allowedGraphIds = resolved.resolved;
        }
        const { listAttachments } = await import('./attachments-store.js');
        const cortexDir = deps.host.getCortexDir();
        const targets = allowedGraphIds ?? deps.host.listGraphs();
        const rows: Array<{
          path: string;
          kind: string;
          label: string;
          graphId: string;
          sourceId?: string;
          sizeBytes?: number;
          ownerSideOnly: true;
        }> = [];
        for (const graphId of targets) {
          const recs = await listAttachments(cortexDir, { graphId });
          for (const r of recs) {
            rows.push({
              path: r.path,
              kind: r.kind,
              label: r.label,
              graphId: r.graphId,
              ...(r.sourceId !== undefined ? { sourceId: r.sourceId } : {}),
              ...(r.sizeBytes !== undefined ? { sizeBytes: r.sizeBytes } : {}),
              ownerSideOnly: true,
            });
          }
        }
        // Footer note tells AI clients (especially collaborators on a
        // sharing token) that the paths are references to the owner's
        // local file system — not openable, not transferable, just
        // "this artifact exists alongside the recalled facts."
        const note = scope
          ? '\n\n_Note: paths reference files on the engram owner\'s machine. They will not resolve on your system. Surface them to the user as "the owner has these files linked" references._'
          : '';
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) + note }] };
      }
      case 'suggest_engram': {
        const args = SuggestEngramInput.parse(rawInput);
        const topK = args.top_k ?? 3;
        const textTokens = tokenize(args.text);
        const candidates = deps.host.graphsWithMetadata()
          .filter(({ metadata }) => !metadata.archived && metadata.sensitivityTier !== 'sensitive')
          .map(({ graphId, metadata }) => {
            const display = metadata.displayName ?? graphId;
            const nameTokens = [...tokenize(graphId), ...tokenize(display)];
            const score = jaccard(textTokens, nameTokens);
            const sources = deps.host.listSources(graphId).length;
            return { graphId, displayName: display, score, sources };
          })
          .sort((a, b) => b.score - a.score || b.sources - a.sources)
          .slice(0, topK);
        const out = candidates.map(c =>
          `• ${c.displayName} (${c.graphId}) — relevance ${(c.score * 100).toFixed(0)}%, ${c.sources} source(s)`
        ).join('\n');
        return { content: [{ type: 'text', text: candidates.length
          ? `Suggested engrams:\n\n${out}\n\nPass the chosen graphId as graphId, or displayName as target_engram, to remember.`
          : 'No accessible non-archived engrams found.'
        }] };
      }
      case 'browse_engram': {
        const args = BrowseEngramInput.parse(rawInput);
        const res = requireEngram(deps.host, args.engram);
        if ('error' in res) return res.error;
        enforceSessionBudget(0, 0, res.graphId);
        const meta = deps.host.getGraphMetadata(res.graphId);
        const sources = deps.host.listSources(res.graphId);
        const limit = args.limit ?? 20;
        const sorted = [...sources].sort((a, b) => b.ingestedAt - a.ingestedAt).slice(0, limit);
        const rows = sorted.map(s =>
          `• [${s.kind}] ${s.ref}  |  ${new Date(s.ingestedAt).toISOString()}${s.addedBy ? `  |  via ${s.addedBy}` : ''}  |  id: ${s.sourceId}`
        ).join('\n');
        return { content: [{ type: 'text', text:
          `Engram: ${meta?.displayName ?? res.graphId} (${res.graphId}) — ${sources.length} source(s), showing ${sorted.length}\n\n${rows || '(no sources yet)'}`
        }] };
      }
      case 'recent': {
        const args = RecentInput.parse(rawInput);
        let graphIdFilter: string | undefined;
        if (args.engram) {
          const res = requireEngram(deps.host, args.engram);
          if ('error' in res) return res.error;
          graphIdFilter = res.graphId;
        }
        const sources = deps.host.listSources(graphIdFilter);
        const limit = args.limit ?? 10;
        const sorted = [...sources].sort((a, b) => b.ingestedAt - a.ingestedAt).slice(0, limit);
        const rows = sorted.map(s => {
          const label = deps.host.getGraphMetadata(s.graphId)?.displayName ?? s.graphId;
          return `• ${new Date(s.ingestedAt).toISOString()}  [${s.kind}]  ${s.ref}  (${label})`;
        }).join('\n');
        const scope = graphIdFilter
          ? (deps.host.getGraphMetadata(graphIdFilter)?.displayName ?? graphIdFilter)
          : 'all engrams';
        return { content: [{ type: 'text', text:
          `Recent — ${scope} (${sorted.length} of ${sources.length} total):\n\n${rows || '(nothing yet)'}`
        }] };
      }
      case 'get_engram_schema': {
        const args = GetEngramSchemaInput.parse(rawInput);
        const res = requireEngram(deps.host, args.engram);
        if ('error' in res) return res.error;
        const meta = deps.host.getGraphMetadata(res.graphId);
        return { content: [{ type: 'text', text: JSON.stringify({
          graphId: res.graphId,
          displayName: meta?.displayName ?? res.graphId,
          template: meta?.template,
          sensitivityTier: (meta as any)?.sensitivityTier ?? 'personal',
          archived: (meta as any)?.archived ?? false,
          createdAt: (meta as any)?.createdAt,
        }, null, 2) }] };
      }
      // ── Advanced recall ───────────────────────────────────────────────────
      case 'recall_structured': {
        const rawRsArgs = RecallStructuredInput.parse(rawInput);
        const args = { ...rawRsArgs, ...applyEngramScope(rawRsArgs) };
        const only = args.only_engrams?.length ? resolveEngramList(deps.host, args.only_engrams) : null;
        const except = (!only && args.except_engrams?.length) ? resolveEngramList(deps.host, args.except_engrams) : null;
        enforceRecallRateLimit();
        enforceReplayBlocker(args.query);
        const { consentFooter: rsFooter, autoExceptGraphIds: rsAutoExcept } = await checkConsentOrThrow(only?.resolved ?? null);
        const allIds = deps.host.listGraphs();
        const rsExcept = new Set([...(except?.resolved ?? []), ...rsAutoExcept]);
        const scopedIds = only ? only.resolved : allIds.filter(id => !rsExcept.has(id));
        const k = Math.ceil(((args.maxNodes ?? 20)) / Math.max(1, scopedIds.length));
        const nodes: unknown[] = [];
        for (const graphId of scopedIds) {
          const meta = deps.host.getGraphMetadata(graphId);
          const hits = await withEmbedding(() => deps.host.searchNodes(graphId, args.query, k));
          for (const n of hits) {
            const sourceId = deps.host.getNodeSource(graphId, n.nodeId);
            nodes.push({
              graphId,
              engram: meta?.displayName ?? graphId,
              tier: (meta as any)?.sensitivityTier ?? 'personal',
              nodeId: n.nodeId,
              score: n.score,
              text: n.text,
              sourceId,
              ...(n.type ? { type: n.type } : {}),
            });
          }
        }
        nodes.sort((a: any, b: any) => b.score - a.score);
        const warnings = [...(only?.warnings ?? []), ...(except?.warnings ?? [])];
        const estTokens = Math.ceil(nodes.reduce((sum: number, n: any) => sum + (n.text?.length ?? 0), 0) / 4);
        enforceSessionBudget(estTokens, nodes.length);
        // Zero-result hint: surface the same diagnostic the federated recall
        // path attaches (language mismatch, phrasing, local-LLM toggle) via
        // an _notice field — keeps the JSON shape stable for callers that
        // ignore it while making the hint visible to the AI client.
        const rsResult: Record<string, unknown> = { nodes, nodesIncluded: nodes.length, ...(warnings.length ? { warnings } : {}) };
        if (nodes.length === 0 && args.query.trim().length >= 3 && deps.host.listGraphs().length > 0) {
          rsResult._notice = deps.host.zeroResultHint();
        }
        // Same anomaly check as the prose recall — but for structured callers
        // we inject it into the JSON shape via `_headsUp` so the field is
        // ignorable by code yet visible to AI clients rendering the response.
        const rsContributing = new Set(nodes.map((n: any) => n.graphId)).size;
        const rsHeadsUp = anomalyHeadsUp({
          kind: 'recall',
          nodesReturned: nodes.length,
          nodesRequested: args.maxNodes ?? 20,
          engramsContributing: rsContributing,
          engramsSearched: scopedIds.length,
          query: args.query,
          tool: 'recall_structured',
        });
        if (rsHeadsUp) rsResult._headsUp = rsHeadsUp.replace(/^\n\n/, '').replace(/^⚠️ _/, '').replace(/_$/, '');
        const rsPendingNotice = pendingEngramNotice(deps.host);
        if (rsPendingNotice) rsResult._pendingEngrams = rsPendingNotice.trim();
        return { content: [{ type: 'text', text: JSON.stringify(rsResult, null, 2) + rsFooter }] };
      }
      case 'recall_with_citations': {
        const rawRwcArgs = RecallWithCitationsInput.parse(rawInput);
        const args = { ...rawRwcArgs, ...applyEngramScope(rawRwcArgs) };
        const only = args.only_engrams?.length ? resolveEngramList(deps.host, args.only_engrams) : null;
        const except = (!only && args.except_engrams?.length) ? resolveEngramList(deps.host, args.except_engrams) : null;
        enforceRecallRateLimit();
        enforceReplayBlocker(args.query);
        const { consentFooter: rwcFooter, autoExceptGraphIds: rwcAutoExcept } = await checkConsentOrThrow(only?.resolved ?? null);
        const allIds = deps.host.listGraphs();
        const rwcExcept = new Set([...(except?.resolved ?? []), ...rwcAutoExcept]);
        const scopedIds = only ? only.resolved : allIds.filter(id => !rwcExcept.has(id));
        const k = Math.ceil(((args.maxNodes ?? 20)) / Math.max(1, scopedIds.length));
        const sections: string[] = [];
        for (const graphId of scopedIds) {
          const meta = deps.host.getGraphMetadata(graphId);
          const hits = await withEmbedding(() => deps.host.searchNodes(graphId, args.query, k));
          if (!hits.length) continue;
          const header = `### ${meta?.displayName ?? graphId}`;
          const lines = hits.map(n => {
            const sourceId = deps.host.getNodeSource(graphId, n.nodeId);
            return `${n.text}${sourceId ? ` [${sourceId}]` : ''}`;
          });
          sections.push(`${header}\n\n${lines.join('\n\n')}`);
        }
        const citationText = sections.join('\n\n---\n\n');
        const estCitationTokens = Math.ceil(citationText.length / 4);
        const citationNodeCount = sections.reduce((sum, s) => sum + s.split('\n\n').length - 1, 0);
        enforceSessionBudget(estCitationTokens, citationNodeCount);
        const rwcBody = sections.length
          ? citationText
          : (args.query.trim().length >= 3 && deps.host.listGraphs().length > 0
              ? '(no matching memories found)\n\n' + deps.host.zeroResultHint()
              : '(no matching memories found)');
        const rwcHeadsUp = anomalyHeadsUp({
          kind: 'recall',
          nodesReturned: citationNodeCount,
          nodesRequested: args.maxNodes ?? 20,
          engramsContributing: sections.length,
          engramsSearched: scopedIds.length,
          query: args.query,
          tool: 'recall_with_citations',
        }) ?? '';
        return { content: [{ type: 'text', text: rwcBody + rwcHeadsUp + rwcFooter }] };
      }
      case 'compare_engrams': {
        const args = CompareEngramsInput.parse(rawInput);
        const resA = requireEngram(deps.host, args.engram_a);
        if ('error' in resA) return resA.error;
        const resB = requireEngram(deps.host, args.engram_b);
        if ('error' in resB) return resB.error;
        enforceRecallRateLimit();
        enforceReplayBlocker(args.query);
        const { consentFooter: ceFooter } = await checkConsentOrThrow([resA.graphId, resB.graphId]);
        const budget = { maxNodes: args.maxNodes ?? 10, maxTokens: 4000 };
        const [subA, subB] = await Promise.all([
          withEmbedding(() => deps.host.recall(args.query, { budget, onlyGraphIds: [resA.graphId], consentedGraphIds: [resA.graphId] })),
          withEmbedding(() => deps.host.recall(args.query, { budget, onlyGraphIds: [resB.graphId], consentedGraphIds: [resB.graphId] })),
        ]);
        const metaA = deps.host.getGraphMetadata(resA.graphId);
        const metaB = deps.host.getGraphMetadata(resB.graphId);
        enforceSessionBudget(subA.tokensUsed + subB.tokensUsed, subA.nodesIncluded + subB.nodesIncluded);
        // compare_engrams specifically: heads-up only if BOTH sides came up
        // empty. A single-side miss is the whole point of the tool ("X has
        // it, Y doesn't"); two misses on a real query usually means the
        // wrong engrams were picked.
        const ceHeadsUp = (subA.nodesIncluded === 0 && subB.nodesIncluded === 0)
          ? `\n\n⚠️ _Heads-up for the user: neither engram returned any matches for this query. ` +
            `If you expected at least one to have something, you may be comparing the wrong engrams — ` +
            `try \`list_engrams\` to see what's available, or mention to the developer that this ` +
            `query feels like it should hit one of these two._`
          : '';
        return { content: [{ type: 'text', text:
          `## ${metaA?.displayName ?? resA.graphId}\n\n${subA.prompt || '(no results)'}\n\n` +
          `## ${metaB?.displayName ?? resB.graphId}\n\n${subB.prompt || '(no results)'}` + ceHeadsUp + ceFooter
        }] };
      }
      case 'cross_search': {
        const rawCsArgs = CrossSearchInput.parse(rawInput);
        // Apply scope: intersect requested engrams with allowed set.
        const scopedCsEngrams = (() => {
          const scope = deps.sharingScope;
          if (!scope || scope.engrams === '*') return rawCsArgs.engrams;
          const allowed = scope.engrams as string[];
          return rawCsArgs.engrams.filter((e) => allowed.includes(e));
        })();
        const args = { ...rawCsArgs, engrams: scopedCsEngrams };
        const { resolved, warnings } = resolveEngramList(deps.host, args.engrams);
        if (!resolved.length) {
          return mcpError(`No engrams matched. Warnings: ${warnings.join(' ')}`);
        }
        enforceRecallRateLimit();
        enforceReplayBlocker(args.query);
        const { consentFooter: csFooter } = await checkConsentOrThrow(resolved);
        const budget = { maxNodes: args.maxNodes ?? 20, maxTokens: 4000 };
        const sub = await withEmbedding(() => deps.host.recall(args.query, { budget, onlyGraphIds: resolved, consentedGraphIds: resolved }));
        enforceSessionBudget(sub.tokensUsed, sub.nodesIncluded);
        const csContributing = sub.audit.filter(a => a.nodesIncluded > 0).length;
        const csHeadsUp = anomalyHeadsUp({
          kind: 'recall',
          nodesReturned: sub.nodesIncluded,
          nodesRequested: budget.maxNodes,
          engramsContributing: csContributing,
          engramsSearched: resolved.length,
          query: args.query,
          tool: 'cross_search',
        }) ?? '';
        return { content: [{ type: 'text', text:
          sub.prompt +
          `\n\n---\nScope: ${resolved.map(id => deps.host.getGraphMetadata(id)?.displayName ?? id).join(', ')}` +
          (warnings.length ? `\nSkipped: ${warnings.join(' ')}` : '') +
          csHeadsUp +
          csFooter
        }] };
      }
      // ── Source management ─────────────────────────────────────────────────
      case 'find_source': {
        const args = FindSourceInput.parse(rawInput);
        let graphIdFilter: string | undefined;
        if (args.engram) {
          const res = requireEngram(deps.host, args.engram);
          if ('error' in res) return res.error;
          graphIdFilter = res.graphId;
        }
        const limit = args.limit ?? 10;

        // --- metadata keyword path (deterministic) ---
        const keywordMatches: import('@graphnosis-app/core').SourceRecord[] = args.keyword
          ? (() => {
              const kw = args.keyword.toLowerCase();
              return deps.host.listSources(graphIdFilter)
                .filter(s => s.sourceId.toLowerCase().includes(kw) ||
                             s.ref.toLowerCase().includes(kw) ||
                             s.kind.toLowerCase().includes(kw));
            })()
          : [];

        // --- content semantic path (embedding search over node text) ---
        const seenSourceIds = new Set(keywordMatches.map(m => m.sourceId));
        const contentMatches: import('@graphnosis-app/core').SourceRecord[] = [];
        if (args.content) {
          const graphIds = graphIdFilter ? [graphIdFilter] : deps.host.listGraphs();
          const k = Math.ceil(limit / Math.max(1, graphIds.length));
          for (const graphId of graphIds) {
            const hits = await withEmbedding(() => deps.host.searchNodes(graphId, args.content!, k));
            for (const n of hits) {
              const sourceId = deps.host.getNodeSource(graphId, n.nodeId);
              if (sourceId && !seenSourceIds.has(sourceId)) {
                seenSourceIds.add(sourceId);
                const src = deps.host.listSources(graphId).find(s => s.sourceId === sourceId);
                if (src) contentMatches.push(src);
              }
            }
          }
        }

        const matches = [...keywordMatches, ...contentMatches].slice(0, limit);
        if (!matches.length) {
          const hint = args.keyword && !args.content
            ? ` (tip: if you searched by reference but the user described the memory by content, retry with the \`content\` parameter instead of \`keyword\`)`
            : '';
          return { content: [{ type: 'text', text: `No sources matched.${hint}` }] };
        }
        const rows = matches.map(s => {
          const label = deps.host.getGraphMetadata(s.graphId)?.displayName ?? s.graphId;
          return `• [${s.kind}] ${s.ref}  |  (${label})  |  ${new Date(s.ingestedAt).toISOString()}  |  id: ${s.sourceId}`;
        }).join('\n');
        return { content: [{ type: 'text', text: `Found ${matches.length} source(s):\n\n${rows}` }] };
      }
      case 'recall_source': {
        const args = RecallSourceInput.parse(rawInput);
        let graphIdFilter: string | undefined;
        if (args.engram) {
          const res = requireEngram(deps.host, args.engram);
          if ('error' in res) return res.error;
          graphIdFilter = res.graphId;
        }
        // Tolerant source resolution — AI clients in the wild pass three
        // different things as `sourceId`:
        //   1. The canonical sourceId from listSources / find_source
        //      (`clip:<24-char-hash>`, `file:<24-char-hash>`, etc.).
        //   2. The `ref` string they saw in a recall response's `src:` tag,
        //      which for clips looks like `clip:<timestamp>:<label>` — that
        //      is the source REF, NOT the canonical id.
        //   3. A TRUNCATED form of (2) that ends in `…` because the AI
        //      client's UI truncated the visible string before the AI
        //      copied it back. Common with long clip labels.
        //
        // We try all three in order. Truncated matches require the input to
        // end with `…` (or `...`) and to uniquely prefix exactly one ref —
        // never disambiguate silently. This single resolver buys us a much
        // higher success rate on recall_source calls than strict equality.
        const sources = deps.host.listSources(graphIdFilter);
        const stripEllipsis = (s: string): string =>
          s.replace(/(?:…|\.{3})\s*$/u, '');
        const target = args.sourceId;
        const targetStripped = stripEllipsis(target);
        const wasTruncated = target !== targetStripped;
        // Pass 1: exact match on sourceId (canonical).
        let rec = sources.find(s => s.sourceId === target);
        // Pass 2: exact match on ref (the form emitted in recall `src:` tags).
        if (!rec) rec = sources.find(s => s.ref === target);
        // Pass 3: prefix match on ref after stripping a trailing ellipsis.
        // Only accept if exactly one source matches — never silently pick
        // the first of several.
        if (!rec && wasTruncated && targetStripped.length >= 8) {
          const prefixMatches = sources.filter(s => s.ref.startsWith(targetStripped));
          if (prefixMatches.length === 1) {
            rec = prefixMatches[0];
          } else if (prefixMatches.length > 1) {
            return mcpError(
              `Source "${target}" was truncated and matches ${prefixMatches.length} ` +
              `sources. Call find_source(content="…") with a more specific term, ` +
              `or use one of these exact sourceIds: ` +
              prefixMatches.slice(0, 5).map(s => `"${s.sourceId}"`).join(', ') +
              (prefixMatches.length > 5 ? `, …` : '') + '.',
            );
          }
        }
        if (!rec) {
          const hint = target.includes(':') && /:\d{10,}:/.test(target)
            ? ` (heads-up: the value you passed looks like a source REF — ` +
              `the \`clip:<timestamp>:<label>\` string from a recall \`src:\` ` +
              `tag — not a canonical sourceId. Call find_source(content="…") ` +
              `to get the real sourceId.)`
            : '';
          return mcpError(
            `Source "${target}" not found${graphIdFilter ? ` in engram "${args.engram}"` : ''}. ` +
            `Use find_source to locate it by keyword or content.${hint}`,
          );
        }
        const { consentFooter: rsrcFooter } = await checkConsentOrThrow([rec.graphId]);
        const meta = deps.host.getGraphMetadata(rec.graphId);
        const now = Date.now();
        const nodeMap = new Map(
          deps.host.listNodes(rec.graphId)
            .filter(n => n.confidence > 0.2 && (!n.validUntil || n.validUntil > now))
            .map(n => [n.id, n]),
        );
        // Return nodes in ingestion order (rec.nodeIds preserves chunk sequence).
        const chunks = rec.nodeIds
          .map(id => nodeMap.get(id))
          .filter((n): n is NonNullable<typeof n> => n !== undefined)
          .map(n => n.contentPreview);
        if (!chunks.length) {
          return { content: [{ type: 'text', text: `Source "${args.sourceId}" exists but all its nodes have been soft-deleted (forgotten).` }] };
        }
        const header =
          `# Source: ${rec.ref}\n` +
          `Engram: ${meta?.displayName ?? rec.graphId} | Kind: ${rec.kind} | ` +
          `Saved: ${new Date(rec.ingestedAt).toLocaleString()} | Chunks: ${chunks.length}`;
        const body = chunks.join('\n\n---\n\n');
        const totalText = `${header}\n\n${body}`;
        enforceSessionBudget(Math.ceil(totalText.length / 4), chunks.length);
        return { content: [{ type: 'text', text: totalText + rsrcFooter }] };
      }
      case 'transfer_source': {
        assertWriteAllowed();
        const args = TransferSourceInput.parse(rawInput);
        const resFrom = requireEngram(deps.host, args.from_engram);
        if ('error' in resFrom) return resFrom.error;
        const resTo = requireEngram(deps.host, args.to_engram);
        if ('error' in resTo) return resTo.error;

        // Consent gate: moving a source is access to (and relocation of) its
        // content. Treat both endpoints as explicitly named so any gated tier
        // among them (sensitive always; personal under extra-precaution mode)
        // surfaces a consent prompt before the move runs — matching every other
        // source/recall tool.
        const { consentFooter: xferFooter } = await checkConsentOrThrow([resFrom.graphId, resTo.graphId]);

        // Refuse tier-lowering moves. Relocating a source from a more-protected
        // engram to a less-protected one permanently strips its consent gate: a
        // later recall_source from the destination would see the lower tier and
        // never prompt. That is a clean bypass of the sensitive tier ("laundering").
        // Lowering sensitivity is a deliberate user action — route it through the
        // in-app Sources page (the trusted path), not an agent tool call.
        const tierRank = (graphId: string): number => {
          const t = (deps.host.getGraphMetadata(graphId) as { sensitivityTier?: string } | undefined)?.sensitivityTier;
          return t === 'sensitive' ? 2 : t === 'personal' ? 1 : 0;
        };
        if (tierRank(resTo.graphId) < tierRank(resFrom.graphId)) {
          return mcpError(
            `Refusing to move source ${args.sourceId} from a more-protected engram ` +
            `("${args.from_engram}") to a less-protected one ("${args.to_engram}"): this would ` +
            `strip its consent protection. If you intend to lower its sensitivity, do it from the ` +
            `app's Sources page.`,
          );
        }

        const { newRecord, forgottenNodeIds } = await deps.host.moveSource(resFrom.graphId, args.sourceId, resTo.graphId);
        // Sync in-memory cross-engram cache and rebuild links for the moved nodes.
        if (forgottenNodeIds.length > 0) {
          deps.brainEngine?.purgeDeletedNodes(forgottenNodeIds);
        }
        deps.brainEngine?.runCrossEngramNow();
        const metaTo = deps.host.getGraphMetadata(resTo.graphId);
        return { content: [{ type: 'text', text:
          `Moved source ${args.sourceId} to ${metaTo?.displayName ?? resTo.graphId}. New sourceId: ${newRecord.sourceId}` + xferFooter
        }] };
      }
      case 'ingest_batch': {
        assertWriteAllowed();
        const args = IngestBatchInput.parse(rawInput);
        const mcpClientName = mcpRegistry.getMostRecentClientName();
        const results: Array<{ index: number; status: 'ok' | 'error'; detail: string }> = [];
        const totalContradictions: unknown[] = [];
        for (const [i, item] of args.items.entries()) {
          try {
            const knownGraphs = deps.host.listGraphs();
            let graphId: string | null = null;
            const nameHint = (item.graphId && !knownGraphs.includes(item.graphId))
              ? item.graphId : item.target_engram ?? null;
            if (item.graphId && knownGraphs.includes(item.graphId)) graphId = item.graphId;
            if (!graphId && nameHint) {
              const r = resolveTargetEngram(deps.host, nameHint);
              if (r.kind === 'exact') graphId = r.graphId;
              else {
                results.push({ index: i, status: 'error', detail: `Engram "${nameHint}" not found — skipped` });
                continue;
              }
            }
            if (!graphId) graphId = deps.defaultGraphId();
            const rec = await withEmbedding(() =>
              ingestClip(deps.host, graphId!, item.text, item.label ?? 'Batch note', {
                ...(mcpClientName ? { addedBy: mcpClientName } : {}),
                triggeredBy: 'mcp:remember',
              })
            );
            const nContra = (rec as any).contradictions?.length ?? 0;
            results.push({
              index: i,
              status: 'ok',
              detail: `Saved as ${(rec as any).sourceId} in ${graphId}`
                + (nContra > 0 ? ` ⚠️ ${nContra} contradiction(s) with existing memory` : ''),
            });
            if (nContra > 0) totalContradictions.push(...(rec as any).contradictions);
          } catch (err) {
            results.push({ index: i, status: 'error', detail: (err as Error).message });
          }
        }
        const ok = results.filter(r => r.status === 'ok').length;
        let summary = `Ingested ${ok} of ${args.items.length} item(s).\n\n` +
          results.map(r => `[${r.index}] ${r.status}: ${r.detail}`).join('\n');
        // Surface contradictions the SDK detected on ingest — previously this
        // batch path computed them but silently dropped them (only `remember`
        // surfaced them). Now consistent with `remember`.
        if (totalContradictions.length > 0) {
          summary += `\n\n⚠️ Detected ${totalContradictions.length} contradiction(s) with existing memory across this batch. `
            + `Review and resolve via \`edit\` (supersede the outdated side) — do NOT add a third conflicting note. `
            + `Run \`contradiction_pairs\` to see the full review queue.\n`
            + `Contradictions: ${JSON.stringify(totalContradictions)}`;
        }
        return { content: [{ type: 'text', text: summary }] };
      }
      // ── Memory health ─────────────────────────────────────────────────────
      case 'engram_summary': {
        const args = EngramSummaryInput.parse(rawInput);
        const res = requireEngram(deps.host, args.engram);
        if ('error' in res) return res.error;
        const meta = deps.host.getGraphMetadata(res.graphId);
        const nodes = deps.host.listNodes(res.graphId);
        const active = (nodes as any[]).filter((n: any) => (n.confidence ?? 1) > 0.2);
        const sample = active.slice(0, args.sample_size ?? 20);
        const rows = sample.map((n: any) => `• ${(n.contentPreview ?? n.text ?? n.id ?? '').toString().slice(0, 100)}`).join('\n');
        return { content: [{ type: 'text', text:
          `Engram: ${meta?.displayName ?? res.graphId}\n` +
          `${active.length} active node(s) across ${deps.host.listSources(res.graphId).length} source(s)\n\n` +
          `Sample:\n${rows || '(empty)'}`
        }] };
      }
      case 'audit_memory': {
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
          if (!licensed) {
            return mcpError(
              'audit_memory requires a Graphnosis Pro subscription. ' +
              'Subscribe at https://graphnosis.com/upgrade.',
            );
          }
        }
        const args = AuditMemoryInput.parse(rawInput);
        const threshold = args.threshold ?? 0.85;
        let graphIds = deps.host.listGraphs().filter(id => {
          const m = deps.host.getGraphMetadata(id);
          return !(m as any)?.archived && (m as any)?.sensitivityTier !== 'sensitive';
        });
        if (args.engrams?.length) {
          const { resolved } = resolveEngramList(deps.host, args.engrams);
          graphIds = graphIds.filter(id => resolved.includes(id));
        }
        const duplicates: string[] = [];
        const graphPairs: Array<[string, string]> = [];
        for (let i = 0; i < graphIds.length; i++) {
          for (let j = i + 1; j < graphIds.length; j++) {
            const a = graphIds[i], b = graphIds[j];
            if (a && b) graphPairs.push([a, b]);
          }
        }
        for (const [a, b] of graphPairs) {
            const nodesA = deps.host.listNodes(a) as any[];
            const activeA = nodesA.filter((n: any) => (n.confidence ?? 1) > 0.2).slice(0, 5);
            for (const node of activeA) {
              const nodeText = (node.contentPreview ?? node.text ?? '').toString();
              if (!nodeText) continue;
              const hits = await withEmbedding(() => deps.host.searchNodes(b, nodeText, 3));
              for (const hit of hits) {
                if (hit.score >= threshold) {
                  const srcA = deps.host.getNodeSource(a, node.id);
                  const srcB = deps.host.getNodeSource(b, hit.nodeId);
                  duplicates.push(
                    `Score ${hit.score.toFixed(2)} | ${deps.host.getGraphMetadata(a)?.displayName ?? a}${srcA ? ` [${srcA}]` : ''} ↔ ${deps.host.getGraphMetadata(b)?.displayName ?? b}${srcB ? ` [${srcB}]` : ''}\n  "${nodeText.slice(0, 80)}…"`
                  );
                  if (duplicates.length >= 20) break;
                }
              }
              if (duplicates.length >= 20) break;
            }
            if (duplicates.length >= 20) break;
          }
        return { content: [{ type: 'text', text: duplicates.length
          ? `Found ${duplicates.length} near-duplicate pair(s) (threshold ${threshold}):\n\n${duplicates.join('\n\n')}`
          : `No near-duplicates found across ${graphIds.length} engram(s) at threshold ${threshold}.`
        }] };
      }
      case 'check_duplicate': {

        const args = CheckDuplicateInput.parse(rawInput);
        const threshold = args.threshold ?? 0.85;
        let graphIds = deps.host.listGraphs();
        if (args.engram) {
          const res = requireEngram(deps.host, args.engram);
          if ('error' in res) return res.error;
          graphIds = [res.graphId];
        }
        const hits: string[] = [];
        for (const graphId of graphIds) {
          const results = await withEmbedding(() => deps.host.searchNodes(graphId, args.text, 3));
          for (const r of results) {
            if (r.score >= threshold) {
              const meta = deps.host.getGraphMetadata(graphId);
              const sourceId = deps.host.getNodeSource(graphId, r.nodeId);
              hits.push(`Score ${r.score.toFixed(2)} in ${meta?.displayName ?? graphId}${sourceId ? ` [${sourceId}]` : ''}:\n  "${r.text.slice(0, 120)}"`);
            }
          }
        }
        return { content: [{ type: 'text', text: hits.length
          ? `Similar content found — consider calling edit instead of remember:\n\n${hits.join('\n\n')}`
          : `No duplicates found above threshold ${threshold}. Safe to call remember.`
        }] };
      }
      case 'duplicate_pairs': {
        if (!deps.brainEngine) {
          return mcpError('Brain engine is not available. Open the Graphnosis app to enable it.');
        }
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
          if (!licensed) {
            return mcpError(
              'duplicate_pairs requires a Graphnosis Pro subscription. ' +
              'Subscribe at https://graphnosis.com/upgrade.',
            );
          }
        }
        const args = DuplicatePairsInput.parse(rawInput);
        const pairs = deps.brainEngine.getDuplicatePairs().slice(0, args.limit ?? 20);
        if (!pairs.length) {
          return { content: [{ type: 'text', text: 'No duplicate pairs queued for review.' }] };
        }
        const rows = pairs.map((p: any) =>
          `• [${p.id}] score ${p.score?.toFixed(2) ?? '?'}\n` +
          `  A: "${(p.nodeA?.text ?? p.nodeAId ?? '').toString().slice(0, 80)}" (${p.graphIdA})\n` +
          `  B: "${(p.nodeB?.text ?? p.nodeBId ?? '').toString().slice(0, 80)}" (${p.graphIdB})`
        ).join('\n\n');
        return { content: [{ type: 'text', text:
          `${pairs.length} duplicate pair(s) awaiting review:\n\n${rows}\n\n` +
          `To resolve: call edit to merge, or forget(nodeIds=[nodeId]) to remove one side.`
        }] };
      }
      case 'contradiction_pairs': {
        if (!deps.brainEngine) {
          return mcpError('Brain engine is not available. Open the Graphnosis app to enable it.');
        }
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
          if (!licensed) {
            return mcpError(
              'contradiction_pairs requires a Graphnosis Pro subscription. ' +
              'Subscribe at https://graphnosis.com/upgrade.',
            );
          }
        }
        const args = ContradictionPairsInput.parse(rawInput);
        const getter = (deps.brainEngine as any).getContradictionPairs?.bind(deps.brainEngine);
        const pairs = (getter ? getter() : []).slice(0, args.limit ?? 20);
        if (!pairs.length) {
          return { content: [{ type: 'text', text: 'No contradictions queued for review. (The reflection scan runs every 6h and on a built cortex; if you just ingested, give it a pass.)' }] };
        }
        const rows = pairs.map((p: any) =>
          `• [${p.id}] ${p.description ?? 'Potential contradiction'} (${p.graphId})\n` +
          `  A [${p.nodeA}]: "${(p.snippetA ?? '').toString().slice(0, 100)}"\n` +
          `  B [${p.nodeB}]: "${(p.snippetB ?? '').toString().slice(0, 100)}"\n` +
          `  shared: ${(p.sharedEntities ?? []).join(', ')}`
        ).join('\n\n');
        return { content: [{ type: 'text', text:
          `${pairs.length} contradiction(s) awaiting review:\n\n${rows}\n\n` +
          `To resolve: call edit to supersede the OUTDATED side (newer attested wins) — ` +
          `do NOT add a third conflicting note. If both are still true, they may be context-dependent; ` +
          `surface to the user to adjudicate.`
        }] };
      }
      case 'healing_journal': {
        if (!deps.brainEngine) {
          return mcpError('Brain engine is not available. Open the Graphnosis app to enable it.');
        }
        const args = HealingJournalInput.parse(rawInput);
        const journal = deps.brainEngine.getHealingJournal().slice(0, args.limit ?? 20);
        if (!journal.length) {
          return { content: [{ type: 'text', text: 'No autonomous heals recorded yet.' }] };
        }
        const rows = journal.map((r: any) =>
          `• ${new Date(r.healedAt ?? r.at ?? 0).toISOString()}  ${r.kind ?? r.type ?? 'heal'}  ${r.graphId ?? ''}  ${(r.summary ?? JSON.stringify(r)).toString().slice(0, 100)}`
        ).join('\n');
        return { content: [{ type: 'text', text: `Healing journal (${journal.length} record(s)):\n\n${rows}` }] };
      }
      // ── On-demand LLM & GNN ───────────────────────────────────────────────
      case 'gnn_status': {
        if (!deps.brainEngine) {
          return mcpError('Brain engine is not available. Open the Graphnosis app to enable it.');
        }
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'gnn-exploration') ?? false;
          if (!licensed) {
            return mcpError(
              'GNN status requires a Graphnosis Pro subscription. ' +
              'Subscribe at https://graphnosis.com/upgrade to unlock the Graphnosis Neural Network.',
            );
          }
        }
        const status = deps.brainEngine.getNeuralNetworkStatus();
        return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
      }
      case 'gnn_neighbors': {
        if (!deps.brainEngine) {
          return mcpError('Brain engine is not available. Open the Graphnosis app to enable it.');
        }
        // ── Pro gate: GNN Exploration is a Pro feature ─────────────────
        // The Graphnosis Neural Network is compute-heavy (it predicts
        // graph edges that semantic recall alone can't find) and is the
        // headline non-deterministic-aid feature for power users. The
        // local-deterministic path stays free; GNN-derived predictions
        // require an active skill-training/gnn-exploration license.
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'gnn-exploration') ?? false;
          if (!licensed) {
            return mcpError(
              'GNN Exploration requires a Graphnosis Pro subscription. ' +
              'Subscribe at https://graphnosis.com/upgrade to unlock the ' +
              'Graphnosis Neural Network and its edge-prediction overlay.',
            );
          }
        }
        const args = GnnNeighborsInput.parse(rawInput);
        let graphIds = deps.host.listGraphs();
        if (args.engram) {
          const res = requireEngram(deps.host, args.engram);
          if ('error' in res) return res.error;
          graphIds = [res.graphId];
        }
        const limit = args.limit ?? 10;
        const neighbors: string[] = [];
        for (const graphId of graphIds) {
          const seeds = await withEmbedding(() => deps.host.searchNodes(graphId, args.query, 5));
          const seedIds = new Set(seeds.map(s => s.nodeId));
          const edges = deps.brainEngine.getPredictedEdges(graphId) as unknown as Array<{ from: string; to: string; score: number }>;
          // Build lazy text index from listNodes
          let textById: Map<string, string> | null = null;
          const textOf = (id: string): string | undefined => {
            if (!textById) {
              textById = new Map();
              for (const n of deps.host.listNodes(graphId) as any[]) {
                textById.set(n.id, n.contentPreview ?? n.text ?? '');
              }
            }
            return textById.get(id);
          };
          for (const edge of edges) {
            const neighborId = seedIds.has(edge.from) ? edge.to
              : seedIds.has(edge.to) ? edge.from
              : null;
            if (!neighborId) continue;
            const text = textOf(neighborId);
            if (!text) continue;
            const meta = deps.host.getGraphMetadata(graphId);
            neighbors.push(
              `Score ${edge.score.toFixed(2)} | ${meta?.displayName ?? graphId}\n` +
              `  "${text.slice(0, 100)}"`
            );
            if (neighbors.length >= limit) break;
          }
          if (neighbors.length >= limit) break;
        }
        return { content: [{ type: 'text', text: neighbors.length
          ? `GNN-predicted neighbors for "${args.query}":\n\n${neighbors.join('\n\n')}`
          : `No GNN-predicted neighbors found. The Neural Network may not have run yet — check gnn_status.`
        }] };
      }
      case 'llm_query': {
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
          if (!licensed) {
            return mcpError(
              'llm_query requires a Graphnosis Pro subscription (Foresight). ' +
              'Use the free recall tool for deterministic memory search. ' +
              'Subscribe at https://graphnosis.com/upgrade.',
            );
          }
        }
        refuseIfLlmRestrictedToSearch('llm_query');
        if (!deps.brainEngine) {
          return mcpError('Brain engine is not available. Use recall instead.');
        }
        const args = LlmQueryInput.parse(rawInput);
        const only = args.only_engrams?.length ? resolveEngramList(deps.host, args.only_engrams) : null;
        enforceRecallRateLimit();
        enforceReplayBlocker(args.question);
        const { consentFooter: lqFooter, autoExceptGraphIds: lqAutoExcept } = await checkConsentOrThrow(only?.resolved ?? null);
        const llmAvailable = !!deps.llm('insights');
        if (!llmAvailable) {
          const sub = await withEmbedding(() => deps.host.recall(args.question, {
            budget: { maxTokens: args.maxTokens ?? 2000, maxNodes: 20 },
            ...(only?.resolved.length ? { onlyGraphIds: only.resolved } : {}),
            ...(lqAutoExcept.length ? { exceptGraphIds: lqAutoExcept } : {}),
            ...(only?.resolved.length ? { consentedGraphIds: only.resolved } : {}),
          }));
          enforceSessionBudget(sub.tokensUsed, sub.nodesIncluded);
          return { content: [{ type: 'text', text:
            '(Local LLM unavailable — returning raw recalled context. Enable the LLM in Graphnosis for synthesis.)\n\n' + sub.prompt + lqFooter
          }] };
        }
        const result = await deps.brainEngine.runDevelop({
          context: args.question,
          strategy: '',
          goals: '',
          ...(only?.resolved.length ? { graphIds: only.resolved } : {}),
        });
        enforceSessionBudget(Math.ceil(result.synthesisMarkdown.length / 4), result.referencedNodeIds.length);
        return { content: [{ type: 'text', text: result.synthesisMarkdown + lqFooter }] };
      }
      case 'llm_distill': {
        if (!deps.brainEngine) {
          return mcpError('Brain engine is not available.');
        }
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
          if (!licensed) {
            return mcpError(
              'llm_distill requires a Graphnosis Pro subscription (Foresight). ' +
              'Subscribe at https://graphnosis.com/upgrade.',
            );
          }
        }
        const args = LlmDistillInput.parse(rawInput);
        const engramHint = args.target_engram
          ? (() => {
              const r = resolveTargetEngram(deps.host, args.target_engram);
              return r.kind === 'exact' ? r.graphId : undefined;
            })()
          : undefined;
        if (!deps.llm('distillation')) {
          return { content: [{ type: 'text', text: '(Local LLM unavailable — no distillation possible. Enable the LLM in Graphnosis → Settings → AI → Local LLM, with the Distillation capability on.)' }] };
        }
        const result = await deps.brainEngine.runDevelop({
          context: args.text,
          strategy: 'Extract discrete, self-contained facts worth remembering.',
          goals: 'Return a JSON array of { text, label } objects — one per fact. No prose, just the array.',
          ...(engramHint ? { graphIds: [engramHint] } : {}),
        });
        const raw = result.synthesisMarkdown;
        let display: string;
        try {
          const match = raw.match(/\[[\s\S]*\]/);
          if (match) {
            const facts: Array<{ text: string; label?: string }> = JSON.parse(match[0]);
            display = `Extracted ${facts.length} fact(s)` +
              (engramHint ? ` — suggested engram: ${engramHint}` : '') +
              `\n\nCall ingest_batch or remember for each:\n\n` +
              JSON.stringify(facts.map(f => ({ ...f, ...(engramHint ? { graphId: engramHint } : {}) })), null, 2);
          } else {
            display = `LLM output (parse as facts manually):\n\n${raw}`;
          }
        } catch {
          display = `LLM output (parse as facts manually):\n\n${raw}`;
        }
        return { content: [{ type: 'text', text: display }] };
      }
      case 'confirm_data_access': {
        const { phrase, tier, engrams } = z.object({
          phrase: z.string(),
          tier: z.enum(['personal', 'sensitive']),
          // Optional fallback: the engram(s) this grant should apply to. Normally
          // the server already knows them from the recall that triggered the gate
          // (getGatedRequest); this is for explicit/headless callers.
          engrams: z.array(z.string()).optional(),
        }).parse(rawInput);

        const clientName = mcpRegistry.getMostRecentClientName() ?? 'unknown-client';

        // A5 — SKIP keyword: user opts out gracefully without consuming a
        // failure attempt or storing consent. The notice text already tells
        // the user to type SKIP; honour it here so it doesn't get treated as
        // a wrong phrase and count toward the 5-attempt lockout.
        if (phrase.trim().toUpperCase() === 'SKIP') {
          return { content: [{ type: 'text', text:
            `Skipped — no ${tier} data will be returned for this request and no consent was stored. ` +
            `Do NOT retry the recall. Continue the conversation without that context.`,
          }] };
        }

        const hmacKey = await deps.host.getOrCreateConsentHmacKey();

        if (!validateConsentPhrase(hmacKey, tier, phrase)) {
          const { lockedOut, count } = trackConsentFailure(clientName, tier);
          if (lockedOut) {
            // Revoke this (client, tier) pair and broadcast lockout event.
            const settings = deps.host.getSettings();
            const revoked = revokeConsent(settings.ai.dataAccessConsents, clientName, tier);
            await deps.host.setSettings({ ai: { ...settings.ai, dataAccessConsents: revoked } });
            if (deps.broadcastRaw) {
              deps.broadcastRaw({
                kind: 'mcp.consent-lockout',
                name: clientName,
                payload: { clientName, tier, failedAttempts: count },
              });
            }
            return mcpError(
              `Too many failed phrase attempts for ${clientName} / ${tier} (${count}). ` +
              `Consent has been revoked for this client and tier. ` +
              `Check Settings → AI in the Graphnosis app.`,
            );
          }
          const windowMs = tier === 'sensitive' ? SENSITIVE_WINDOW_MS : PERSONAL_WINDOW_MS;
          const windowDesc = tier === 'sensitive' ? '1 hour' : '24 hours';
          return mcpError(
            `Phrase did not match the current Graphnosis consent phrase for tier "${tier}". ` +
            `Attempt ${count} of ${LOCKOUT_MAX_ATTEMPTS}. ` +
            `Phrases rotate every ${windowDesc} — if the window just changed, ask the user to ` +
            `check the Graphnosis app again. Do not guess.`,
          );
        }

        // Valid phrase — clear failures and record consent.
        clearConsentFailures(clientName, tier);

        // Compute effective window for this (client, tier) — same "stricter wins" logic.
        const settings = deps.host.getSettings();
        const clientType = settings.ai.clientTypes?.[clientName] ?? 'chat';
        let windowMs: number = clientType === 'agent' ? 0
          : tier === 'sensitive'
            ? (settings.ai.consentIntervalSensitiveMs ?? 3_600_000)
            : (settings.ai.consentIntervalPersonalMs ?? -1);

        // Per-graph stricter wins across all loaded graphs of this tier.
        for (const graphId of deps.host.listGraphs()) {
          const meta = deps.host.getGraphMetadata(graphId);
          const graphTier = (meta as any)?.sensitivityTier as string | undefined;
          if (graphTier !== tier) continue;
          const perGraph = (meta as any)?.consentIntervalMs as number | undefined;
          if (perGraph !== undefined && perGraph !== -1) {
            if (windowMs === -1 || perGraph < windowMs) windowMs = perGraph;
          }
        }

        const recipientName = clientName.startsWith('claude') ? 'Anthropic Inc.' : clientName;
        // Scope the grant to the specific engram(s) this consent is for (#14):
        // prefer the engrams the agent named, else the engrams the gate last
        // blocked for this (client, tier). A grant with no graphId does NOT
        // satisfy the per-engram check, so the fallback fails closed (re-prompt)
        // rather than unlocking the whole tier.
        let grantGraphIds: string[] = [];
        if (engrams?.length) {
          for (const name of engrams) {
            const r = resolveTargetEngram(deps.host, name);
            if (r.kind === 'exact') grantGraphIds.push(r.graphId);
          }
        }
        if (grantGraphIds.length === 0) grantGraphIds = getGatedRequest(clientName, tier);

        let updatedConsents: ConsentRecord[] = settings.ai.dataAccessConsents ?? [];
        if (grantGraphIds.length > 0) {
          for (const gid of grantGraphIds) {
            updatedConsents = recordConsent(updatedConsents, clientName, tier, windowMs, recipientName, 'US', '2025-05', gid);
          }
        } else {
          // No engram context — record a tier-level audit entry, but it won't
          // satisfy the per-engram check, so the agent will be re-prompted with
          // the engram named. Surface this so it doesn't look like a silent grant.
          console.error(`[consent] confirm_data_access for ${clientName}/${tier}: no engram context — recording unscoped (will re-prompt).`);
          updatedConsents = recordConsent(updatedConsents, clientName, tier, windowMs, recipientName, 'US', '2025-05');
        }
        await deps.host.setSettings({ ai: { ...settings.ai, dataAccessConsents: updatedConsents } });

        if (deps.broadcastRaw) {
          deps.broadcastRaw({
            kind: 'mcp.consent-granted',
            name: clientName,
            payload: {
              clientName,
              tier,
              expiresAt: updatedConsents.find(
                (r) => r.clientName === clientName && r.tier === tier && !r.withdrawnAt,
              )?.expiresAt ?? -1,
            },
          });
        }

        const expiresAt = updatedConsents.find(
          (r) => r.clientName === clientName && r.tier === tier && !r.withdrawnAt,
        )?.expiresAt ?? -1;
        const until = expiresAt >= Number.MAX_SAFE_INTEGER - 1
          ? 'permanently (until revoked)'
          : `until ${new Date(expiresAt).toLocaleString()}`;
        return { content: [{ type: 'text', text:
          `Consent recorded for ${tier} engrams. Valid ${until}. You may now retry the original recall.`
        }] };
      }
      // ── Skill training ────────────────────────────────────────────────────
      case 'train_skill': {
        assertWriteAllowed();
        const TrainSkillInput = z.object({
          skill: z.string().min(1),
          skill_name: z.string().optional(),
          target_engram: z.string().optional(),
          focus_engrams: z.array(z.string()).optional(),
          model_target: z.enum(['generic', 'claude', 'cursor', 'openai', 'copilot']).optional(),
          save: z.boolean().optional(),
          recall_breadth: z.number().int().min(0).max(100).optional(),
          // Accept boolean or "true"/"false" string — some MCP clients stringify
          // booleans for params absent from their cached tool schema.
          use_llm_rewrite: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
        });
        const args = TrainSkillInput.parse(rawInput);

        // Resolve the Skills engram (where trained skills are stored)
        const engramName = args.target_engram ?? 'Skills';
        const engramRes = requireEngram(deps.host, engramName);
        if ('error' in engramRes) {
          // Trigger the App's engram-create banner so the user can confirm
          // creating a Skills engram with one click, then retry.
          const clientName = mcpRegistry.getMostRecentClientName() ?? 'an AI client';
          if (deps.broadcastRaw) {
            deps.broadcastRaw({
              kind: 'engram.create-suggested',
              name: engramName,
              payload: {
                suggestedName: engramName,
                label: args.skill_name ?? 'Skill',
                text: args.skill,
                preview: args.skill.slice(0, 280),
                sourceKind: 'skill',
                template: 'skill',
                requestedBy: clientName,
                candidates: [],
              },
            });
          }
          return {
            content: [{
              type: 'text',
              text:
                `No Skills engram named "${engramName}" was found. ` +
                `A prompt has appeared in the Graphnosis app asking you to create one. ` +
                `Confirm the engram creation there, then retry this call.`,
            }],
          };
        }

        // Resolve focus engrams (optional — filter where to draw memories from)
        let focusGraphIds: string[] | null = null;
        if (args.focus_engrams?.length) {
          const resolved = resolveEngramList(deps.host, args.focus_engrams);
          focusGraphIds = resolved.resolved;
        }

        if (!deps.skillTrainer) {
          return mcpError(
            'Skill trainer is not available. Open the Graphnosis app to enable it.',
          );
        }

        // ── Subscription gate ────────────────────────────────────────────────
        // Skill training (both LLM-rewrite and memory-augmented paths) is a
        // monthly-subscription feature. The license token is stored encrypted in the
        // cortex; we decrypt on demand and check the Ed25519 signature.
        //
        // Free users can still store and export raw skills (Skills engram is
        // always available); they just cannot run the training pipeline.
        {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'skill-training') ?? false;
          if (!licensed) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  upgrade_required: true,
                  feature: 'skill-training',
                  message:
                    'Skill training is a Graphnosis monthly-subscription feature. ' +
                    'Subscribe or renew to personalize skills using your cortex memory.',
                  upgrade_url: 'https://graphnosis.com/upgrade',
                }),
              }],
            };
          }
        }

        const clientName = mcpRegistry.getMostRecentClientName() ?? undefined;
        const trainInput: import('./skill-trainer.js').TrainSkillInput = {
          skill: args.skill,
          graphId: engramRes.graphId,
          ...(args.skill_name !== undefined ? { skillName: args.skill_name } : {}),
          ...(focusGraphIds !== null ? { focusGraphIds } : {}),
          ...(args.model_target !== undefined ? { modelTarget: args.model_target } : {}),
          ...(args.save !== undefined ? { save: args.save } : {}),
          ...(clientName !== undefined ? { addedBy: clientName } : {}),
          ...(args.recall_breadth !== undefined ? { recallBreadth: args.recall_breadth } : {}),
          ...(args.use_llm_rewrite !== undefined ? { useLlmRewrite: args.use_llm_rewrite === true || args.use_llm_rewrite === 'true' } : {}),
        };
        const result = await deps.skillTrainer.trainSkill(trainInput);

        const lines: string[] = [];
        lines.push(`## Skill Training Complete`);
        lines.push('');
        lines.push(`**Mode:** ${result.mode === 'llm' ? '✨ LLM rewrite' : '📎 Memory-augmented (no LLM)'}`);
        if (result.degradedNote) {
          lines.push(`**Note:** ${result.degradedNote}`);
        }
        lines.push(`**Influential memories:** ${result.influentialNodes.length} node(s) surfaced`);
        if (result.skillId) {
          lines.push(`**Saved as:** \`${result.skillId}\` in ${engramName} engram`);
        }
        lines.push('');
        lines.push('### Trained Skill');
        lines.push('');
        lines.push(result.trained);
        if (result.diffNotes) {
          lines.push('');
          lines.push('### Change Attribution');
          lines.push('');
          lines.push(result.diffNotes);
        }
        if (result.influentialNodes.length > 0) {
          lines.push('');
          lines.push('### Top Influential Memories');
          result.influentialNodes.slice(0, 5).forEach((n, i) => {
            lines.push(`${i + 1}. [score ${n.score.toFixed(2)}] ${n.preview}`);
          });
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'skill_vitality': {
        const SkillVitalityInput = z.object({
          source_id: z.string().min(1),
          target_engram: z.string().optional(),
        });
        const args = SkillVitalityInput.parse(rawInput);

        const engramName = args.target_engram ?? 'Skills';
        const engramRes = requireEngram(deps.host, engramName);
        if ('error' in engramRes) {
          return mcpError(
            `Could not find a Skills engram named "${engramName}". ` +
            `Create one in Graphnosis → New Engram → Skill template.`,
          );
        }

        if (!deps.skillTrainer) {
          return mcpError(
            'Skill trainer is not available. Open the Graphnosis app to enable it.',
          );
        }

        const vitality = deps.skillTrainer.computeSkillVitality(
          engramRes.graphId,
          args.source_id,
        );

        const scoreBar = '█'.repeat(Math.floor(vitality.score / 10)) +
          '░'.repeat(10 - Math.floor(vitality.score / 10));

        const lines: string[] = [];
        lines.push(`## Skill Vitality`);
        lines.push('');
        lines.push(`**Score:** ${vitality.score}/100  [${scoreBar}]`);
        lines.push(`**Recommendation:** ${vitality.recommendation}`);
        if (vitality.trainedAt) {
          lines.push(`**Trained:** ${new Date(vitality.trainedAt).toLocaleDateString()}`);
        }
        if (vitality.staleNodesCount > 0) {
          lines.push(`**Stale nodes:** ${vitality.staleNodesCount} (superseded by a newer version)`);
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'export_skill': {
        const ExportSkillInput = z.object({
          skill_text: z.string().min(1),
          format: z.enum(['claude-md', 'cursorrules', 'system-prompt', 'openai', 'raw', 'gsk']),
        });
        const args = ExportSkillInput.parse(rawInput);

        if (!deps.skillTrainer) {
          return mcpError(
            'Skill trainer is not available. Open the Graphnosis app to enable it.',
          );
        }

        // ── Pro gate for GSK exports ───────────────────────────────────
        // Same gate the desktop UI enforces in ipc.ts skill:export. We
        // re-check here because AI clients can hit this MCP tool
        // directly, bypassing the desktop UI; without a server-side
        // check the gate would be advisory only.
        if (args.format === 'gsk') {
          const licenseToken = await getEffectiveLicenseToken(deps);
          const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'skill-training') ?? false;
          if (!licensed) {
            return mcpError(
              'GSK skill-pack export requires a Graphnosis Pro subscription. ' +
              'Subscribe at https://graphnosis.com/upgrade or export in any other format ' +
              '(claude-md, cursorrules, system-prompt, openai, raw) for free.',
            );
          }
        }

        const exported = deps.skillTrainer.exportSkill(
          args.skill_text,
          args.format as ExportFormat,
        );

        if (Buffer.isBuffer(exported)) {
          // GSK format: return as base64 so the MCP transport can carry it.
          return {
            content: [{
              type: 'text',
              text: `## Exported Skill Pack (.gsk)\n\n` +
                `**Format:** Graphnosis Skills Kit (encrypted JSON)\n` +
                `**Encoding:** base64 (save as \`.gsk\` after decoding)\n\n` +
                '```\n' + exported.toString('base64') + '\n```\n\n' +
                '_This pack contains only your trained skill text and recall recipes. ' +
                'Your personal memories are not included — however, personal or proprietary ' +
                'content may have influenced training and could appear in the trained text. ' +
                'Review carefully before sharing._',
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: `## Exported Skill (${args.format})\n\n` +
              '```\n' + exported + '\n```\n\n' +
              '_Memory references and graph metadata have been stripped. ' +
              'Only the behavioral content is exported — the personalization travels; ' +
              'the memories that caused it stay local._',
          }],
        };
      }

      case 'export_engram': {
        const args = z.object({
          engram: z.string().min(1),
          sign: z.boolean().optional(),
        }).parse(rawInput);

        const { requireEngram: _req } = { requireEngram };
        const res = requireEngram(deps.host, args.engram);
        if ('error' in res) return res.error;
        const { graphId } = res;

        // Respect sharing scope — only owner sessions may export
        if (deps.sharingScope) {
          return mcpError('⛔ Engram export is only available to the cortex owner. Sessions connected via a share cannot export.');
        }

        // Gate behind Pro+ (sharing feature)
        const licenseToken = await getEffectiveLicenseToken(deps);
        const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'teams') ?? false;
        if (!licensed) {
          return mcpError(
            'Engram Pack export requires a Graphnosis Pro subscription. ' +
            'Subscribe at https://graphnosis.com/upgrade',
          );
        }

        const { exportEngram, getOrCreateGezSigningKeyHex } = await import('./engram-pack.js');
        const shouldSign = args.sign !== false;
        let signingKeyHex: string | undefined;
        if (shouldSign && deps.cortexDir) {
          try {
            signingKeyHex = await getOrCreateGezSigningKeyHex(deps.cortexDir);
          } catch { /* signing key unavailable — proceed unsigned */ }
        }

        const engramMeta = deps.host.getGraphMetadata(graphId) ?? {};
        const exportOpts: import('./engram-pack.js').ExportEngramOptions = {
          exportedBy: (engramMeta as any).displayName ?? graphId,
        };
        if (signingKeyHex !== undefined) exportOpts.signingKeyHex = signingKeyHex;
        const result = await exportEngram(deps.host, graphId, exportOpts);

        return {
          content: [{
            type: 'text',
            text:
              `## Engram Pack (.gez)\n\n` +
              `**Engram:** ${(engramMeta as any).displayName ?? graphId}\n` +
              `**Sources:** ${result.sourceCount}\n` +
              `**Signed:** ${result.signed ? 'Yes (Ed25519)' : 'No (unsigned)'}\n` +
              `**Encoding:** base64 — save as \`.gez\` after decoding\n\n` +
              '```\n' + result.pack.toString('base64') + '\n```\n\n' +
              '_This pack contains the full text of every source in the engram. ' +
              'Only share with trusted recipients. ' +
              'Import with `import_engram` or `graphnosis engram import`._',
          }],
        };
      }

      case 'import_engram': {
        const args = z.object({
          pack_base64: z.string().min(1),
          target_engram: z.string().optional(),
          skip_existing: z.boolean().optional(),
        }).parse(rawInput);

        // Reject scoped (sharing) sessions
        if (deps.sharingScope) {
          return mcpError('⛔ Engram import is only available to the cortex owner.');
        }

        // Pro gate
        const licenseToken = await getEffectiveLicenseToken(deps);
        const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'teams') ?? false;
        if (!licensed) {
          return mcpError(
            'Engram Pack import requires a Graphnosis Pro subscription. ' +
            'Subscribe at https://graphnosis.com/upgrade',
          );
        }

        let packBuffer: Buffer;
        try {
          packBuffer = Buffer.from(args.pack_base64, 'base64');
        } catch {
          return mcpError('Invalid base64 data in pack_base64.');
        }

        // Resolve optional target engram
        let targetEngramId: string | undefined;
        if (args.target_engram) {
          const res = requireEngram(deps.host, args.target_engram);
          if ('error' in res) {
            // Not found — use the string as a new engram ID
            targetEngramId = args.target_engram;
          } else {
            targetEngramId = res.graphId;
          }
        }

        const { importEngram } = await import('./engram-pack.js');
        const importOpts: import('./engram-pack.js').ImportEngramOptions = {
          skipExisting: args.skip_existing !== false,
          withEmbedding: (fn) => withEmbedding(fn),
        };
        if (targetEngramId !== undefined) importOpts.targetEngramId = targetEngramId;
        const { result, payload } = await importEngram(deps.host, packBuffer, importOpts);

        const sigLine = result.unsigned
          ? 'unsigned pack'
          : result.signatureVerified ? '✅ signature verified' : '⚠️ signature invalid';

        const lines = [
          `## Import complete`,
          ``,
          `**Source engram:** ${payload.engramDisplayName} (${payload.engramId})`,
          `**Exported by:** ${payload.exportedBy} on ${new Date(payload.exportedAt).toISOString().split('T')[0]}`,
          `**Signature:** ${sigLine}`,
          ``,
          `| Outcome | Count |`,
          `|---|---|`,
          `| Imported | ${result.imported} |`,
          `| Skipped (already existed) | ${result.skipped} |`,
          `| Failed | ${result.failed} |`,
        ];

        if (result.failed > 0) {
          lines.push('', '**Failures:**');
          for (const o of result.outcomes.filter((o) => o.status === 'failed')) {
            lines.push(`- \`${o.ref}\`: ${o.error}`);
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'list_skills': {
        const args = z.object({
          engram: z.string().optional(),
        }).parse(rawInput);
        if (!deps.skillTrainer) return mcpError('Skill trainer not available.');
        let graphId: string | undefined;
        if (args.engram) {
          const res = requireEngram(deps.host, args.engram);
          if ('error' in res) return res.error;
          graphId = res.graphId;
        }
        const skills = deps.skillTrainer.listSkills(graphId);
        if (!skills.length) {
          return { content: [{ type: 'text', text: 'No trained skills found. Use train_skill to train your first skill.' }] };
        }
        const lines = skills.map((s) => [
          `**${s.label}**`,
          `  sourceId: ${s.sourceId}`,
          `  Engram: ${s.engramName} | Nodes: ${s.nodeCount} | Mode: ${s.mode ?? 'unknown'}`,
          `  Trained: ${s.trainedAt ?? new Date(s.ingestedAt).toISOString()} | recallBreadth: ${s.recallBreadth ?? 'unknown'}`,
        ].join('\n'));
        return { content: [{ type: 'text', text: `## Skills (${skills.length})\n\n${lines.join('\n\n')}` }] };
      }

      case 'walk_skill': {
        const args = z.object({
          graphId:   z.string().min(1),
          sourceId:  z.string().min(1),
          recursive: z.boolean().optional().default(false),
        }).parse(rawInput);
        const resEngramW = requireEngram(deps.host, args.graphId);
        if ('error' in resEngramW) return resEngramW.error;
        const { walkSkillSequence: walkFn, formatSkillForRecall: formatFn } =
          await import('./skill-trainer.js');
        // D1 — pre-load cross-engram call links (the walk is sync) so any
        // `@skill:` ref resolving to another engram surfaces in the SOP.
        const crossLinksW = await deps.host.skillCallLinks.getForSource(resEngramW.graphId, args.sourceId);
        const walked = walkFn(deps.host, resEngramW.graphId, args.sourceId, { recursive: args.recursive, crossEngramLinks: crossLinksW });
        if (walked.steps.length === 0) {
          return mcpError(`Skill "${args.sourceId}" has no steps. Use get_skill to read it as raw text, or train_skill to rebuild it.`);
        }
        return { content: [{ type: 'text', text: formatFn(walked) }] };
      }

      case 'walk_skill_structured': {
        const args = z.object({
          graphId:   z.string().min(1),
          sourceId:  z.string().min(1),
          recursive: z.boolean().optional().default(false),
        }).parse(rawInput);
        const resEngramS = requireEngram(deps.host, args.graphId);
        if ('error' in resEngramS) return resEngramS.error;
        const { walkSkillSequence: walkFn2, walkSkillToJson } =
          await import('./skill-trainer.js');
        const crossLinksS = await deps.host.skillCallLinks.getForSource(resEngramS.graphId, args.sourceId);
        const walked = walkFn2(deps.host, resEngramS.graphId, args.sourceId, { recursive: args.recursive, crossEngramLinks: crossLinksS });
        if (walked.steps.length === 0 && walked.goals.length === 0) {
          return mcpError(`Skill "${args.sourceId}" has no steps or goals to walk. Use get_skill, or train_skill to rebuild it.`);
        }
        // Resolve title (first body step's text, falling back to source ref) + engram display name
        const meta = deps.host.getGraphMetadata(resEngramS.graphId);
        const src = deps.host.getSourceRecord(resEngramS.graphId, args.sourceId);
        const title = walked.steps[0]?.text ?? src?.ref ?? args.sourceId;
        const plan = walkSkillToJson(walked, {
          sourceId: args.sourceId,
          title,
          ...(meta?.displayName ? { engramName: meta.displayName } : {}),
        });
        return { content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }] };
      }

      case 'save_skill_run': {
        const args = z.object({
          runId:              z.string().min(1).optional(),
          skillGraphId:       z.string().min(1),
          skillSourceId:      z.string().min(1),
          planTitle:          z.string().optional(),
          capturedVars:       z.record(z.string(), z.unknown()),
          completedStepIndex: z.number().int().nonnegative(),
        }).parse(rawInput);
        const now = Date.now();
        const runId = args.runId ?? randomUUID();
        const existing = args.runId ? await deps.host.skillRuns.read(args.runId) : null;
        await deps.host.skillRuns.save({
          runId,
          skillGraphId: args.skillGraphId,
          skillSourceId: args.skillSourceId,
          ...(args.planTitle ? { planTitle: args.planTitle } : {}),
          capturedVars: args.capturedVars,
          completedStepIndex: args.completedStepIndex,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ runId, saved: true, completedStepIndex: args.completedStepIndex }, null, 2) }] };
      }

      case 'resume_skill_run': {
        const args = z.object({ runId: z.string().min(1) }).parse(rawInput);
        const rec = await deps.host.skillRuns.read(args.runId);
        if (!rec) return mcpError(`No saved skill-run with runId "${args.runId}". It may have completed (and been deleted) or never been saved.`);
        return { content: [{ type: 'text', text: JSON.stringify({
          runId: rec.runId,
          skill: { graphId: rec.skillGraphId, sourceId: rec.skillSourceId, ...(rec.planTitle ? { title: rec.planTitle } : {}) },
          capturedVars: rec.capturedVars,
          completedStepIndex: rec.completedStepIndex,
          nextStepIndex: rec.completedStepIndex + 1,
          updatedAt: rec.updatedAt,
          hint: 'Call walk_skill_structured on skill.graphId/sourceId, then continue at nextStepIndex with capturedVars in scope.',
        }, null, 2) }] };
      }

      case 'get_skill': {
        const args = z.object({
          graphId: z.string().min(1),
          sourceId: z.string().min(1),
        }).parse(rawInput);
        if (!deps.skillTrainer) return mcpError('Skill trainer not available.');
        const resEngram = requireEngram(deps.host, args.graphId);
        if ('error' in resEngram) return resEngram.error;
        const detail = deps.skillTrainer.getSkill(resEngram.graphId, args.sourceId);
        if (!detail) return mcpError(`Skill "${args.sourceId}" not found in engram "${args.graphId}".`);
        const header =
          `# ${detail.label}\n` +
          `Engram: ${detail.engramName} | Mode: ${detail.mode ?? 'unknown'} | ` +
          `recallBreadth: ${detail.recallBreadth ?? 'unknown'} | Nodes: ${detail.nodeCount}\n` +
          `Trained: ${detail.trainedAt ?? new Date(detail.ingestedAt).toISOString()}`;
        return { content: [{ type: 'text', text: `${header}\n\n---\n\n${detail.text}` }] };
      }

      case 'skill_history': {
        const args = z.object({
          graphId: z.string().min(1),
          sourceId: z.string().min(1),
        }).parse(rawInput);
        if (!deps.skillTrainer) return mcpError('Skill trainer not available.');
        const resEngram = requireEngram(deps.host, args.graphId);
        if ('error' in resEngram) return resEngram.error;
        const history = await deps.skillTrainer.getSkillHistory(resEngram.graphId, args.sourceId);
        if (!history.length) return mcpError(`No skill history found for "${args.sourceId}".`);
        const lines = history.map((v, i) => [
          `${i === 0 ? '**[current]**' : `[snap ${v.snapshotId}]`} ${v.label}`,
          `  sourceId: ${v.sourceId}`,
          `  Trained: ${v.trainedAt ?? new Date(v.ingestedAt).toISOString()} | Mode: ${v.mode ?? 'unknown'} | Nodes: ${v.nodeCount}`,
        ].join('\n'));
        return { content: [{ type: 'text', text: `## Skill History (${history.length} versions)\n\n${lines.join('\n\n')}` }] };
      }

      case 'rollback_skill': {
        assertWriteAllowed();
        // Args migrated: the legacy `targetSourceId` field actually identified
        // the OLD source to keep (under the now-removed per-retrain-source
        // model). With history living in snapshot files, callers pass the
        // current skill's sourceId AND the snapshotId to restore.
        const args = z.object({
          graphId: z.string().min(1),
          sourceId: z.string().min(1),
          snapshotId: z.string().min(1),
        }).parse(rawInput);
        if (!deps.skillTrainer) return mcpError('Skill trainer not available.');
        const resEngram = requireEngram(deps.host, args.graphId);
        if ('error' in resEngram) return resEngram.error;
        const result = await deps.skillTrainer.rollbackSkill(resEngram.graphId, args.sourceId, args.snapshotId);
        return { content: [{ type: 'text', text: `Rolled back to snapshot ${args.snapshotId}. Restored ${result.restoredNodeCount} node(s) into source ${args.sourceId}.` }] };
      }

      case 'delete_skill': {
        assertWriteAllowed();
        const args = z.object({
          graphId: z.string().min(1),
          sourceId: z.string().min(1),
          all_versions: z.boolean().optional(),
        }).parse(rawInput);
        if (!deps.skillTrainer) return mcpError('Skill trainer not available.');
        const resEngram = requireEngram(deps.host, args.graphId);
        if ('error' in resEngram) return resEngram.error;
        const result = await deps.skillTrainer.deleteSkill(resEngram.graphId, args.sourceId, args.all_versions ?? false);
        const scope = args.all_versions ? 'all versions of the skill' : 'this skill version';
        return { content: [{ type: 'text', text: `Deleted ${scope} (${result.forgottenSourceIds.length} source(s) soft-deleted). Recoverable from the Graphnosis app op-log.` }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    } catch (e) {
      // Consent gate: surface the full notice text as a normal tool result
      // (isError:true). The SDK would otherwise turn the throw into a
      // JSON-RPC -32603 that clients render as "Tool execution failed",
      // hiding the actual consent instructions the user needs.
      if (e instanceof ConsentRequiredError) return mcpError(e.message);
      if (e instanceof ScopeViolationError) return mcpError(e.message);
      throw e;
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // AI client just made a tool call — mark activity so heavy background brain
    // passes defer and this recall/remember wins the single-threaded loop.
    markClientActivity();
    // Admin/IT policy: reject EVERY tool call from a disabled AI client. The
    // user/IT blocks a client by name; enforced here in the sidecar (the only
    // place a client can't route around).
    const policyClient = mcpRegistry.getMostRecentClientName() ?? 'unknown-client';
    if (isClientDisabled(policyClient)) {
      return {
        content: [{ type: 'text', text: `⛔ Access blocked. The AI client "${policyClient}" has been disabled by policy. Contact your administrator to re-enable it.` }],
        isError: true,
      };
    }
    // User tool-exposure allowlist: reject calls to a disabled tool. Runs BEFORE
    // the switch (and before any per-tool Pro-tier gate) and re-reads live, so a
    // client with a stale/cached schema still can't invoke a disabled tool.
    if (disabledToolSet().has(req.params.name)) {
      return {
        content: [{ type: 'text', text: `⛔ The tool "${req.params.name}" has been disabled in Graphnosis (Settings → MCP Tools). Ask the user to re-enable it if you need it.` }],
        isError: true,
      };
    }
    return dispatchTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
  });

  return { server, callTool: dispatchTool };
}

/**
 * Bind a freshly built MCP server to stdio. Used when the sidecar is spawned
 * directly by an MCP client (e.g., a `command`/`args` entry in Claude
 * Desktop's config).
 */
export async function startStdioMcpServer(deps: McpDeps): Promise<void> {
  // mcpRegistry is now imported statically at the top of the file so the
  // tool handlers can use it too (attribution of MCP-driven ingests).
  const { server } = createMcpServer(deps);
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
