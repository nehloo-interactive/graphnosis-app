import { randomUUID } from 'node:crypto';
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import type { BroadcastRawFn } from './events.js';
import { VitalityScorer, type VitalityReport } from './vitality.js';
import { TemporalEngine } from './temporal-engine.js';
import { GoalTracker } from './goal-tracker.js';
import { findSimilarPairs } from './duplicate-scan.js';
import { clientActiveWithin, CLIENT_QUIET_MS, isIngestActive, onClientIdle, onIngestIdle } from './client-activity.js';
// Brain recalls/searches embed the query — they MUST go through the global
// embedding queue or they can run concurrently with a connector ingest's embed
// and crash the (non-reentrant) embed worker, deadlocking all embedding.
import { withEmbedding } from './embedding-queue.js';
import { settings as settingsMod } from '@graphnosis-app/core';
import { predictEdgesForEngram, edgePredictionEnabled } from './edge-prediction.js';
import { redactId, dbg } from './log-redact.js';
import { ReinforcementEngine } from './reinforcement-engine.js';
import { MemoryHealthScorer, type MemoryHealth } from './memory-health.js';
import {
  type HealingRecord,
  type HealingRule,
  type HealingLlmVerdict,
  makeHealingRecord,
} from './healing-journal.js';

/** The result of a federated recall — derived from the host so brain-engine
 *  needn't import the secure-sync federation types directly. */
type RecallResult = Awaited<ReturnType<GraphnosisHost['recall']>>;

/**
 * A deduplication the brain decided it can do autonomously — no human
 * judgment needed. Collected during the scan, executed afterward (we
 * never mutate a graph while still iterating its node embeddings).
 */
interface HealAction {
  graphId: string;
  /** Node that stays active. */
  survivorId: string;
  /** Node to soft-delete (its information is fully preserved in the
   *  survivor — either an exact duplicate or a strict subset). */
  supersededId: string;
  /** Cleaned full text of each node, frozen for the healing journal. */
  survivorContent: string;
  supersededContent: string;
  rule: HealingRule;
  similarity: number;
  /** Audit-readable reason the survivor was chosen. */
  decisionReason: string;
}

// ── Public types ────────────────────────────────────────────────────────────

export interface DuplicatePair {
  id: string;
  graphId: string;
  nodeA: string;
  nodeB: string;
  snippetA: string;
  snippetB: string;
  similarity: number;
  detectedAt: number;
}

/** A contradiction the periodic scan surfaced for review — two nodes that
 *  share entities but assert conflicting content. Mirrors DuplicatePair so the
 *  Check-in deck and the `contradiction_pairs` MCP tool render it the same way. */
export interface ContradictionPair {
  id: string;
  graphId: string;
  nodeA: string;
  nodeB: string;
  snippetA: string;
  snippetB: string;
  sharedEntities: string[];
  description: string;
  detectedAt: number;
}

export interface Insight {
  id: string;
  graphId: string;
  kind: 'pattern' | 'gap' | 'opportunity' | 'conflict';
  title: string;
  body: string;
  relevantNodeIds: string[];
  createdAt: number;
  dismissed?: boolean;
}

export interface StrategicPlan {
  context: string;
  strategy: string;
  goals: string;
  synthesisMarkdown: string;
  referencedNodeIds: string[];
  graphIds: string[];
}

export interface PredictionResult {
  risks: string[];
  opportunities: string[];
  recommendation: string;
  referencedNodeIds: string[];
  /** True when no Local LLM was available, so `recommendation` carries the
   *  raw recalled memory rather than a synthesized risk/opportunity assessment. */
  degraded?: boolean;
}

// ── LLM prompts ─────────────────────────────────────────────────────────────

const SYNAPSE_SYSTEM_PROMPT = `You are a knowledge graph analyst reviewing a personal memory graph.
Given a list of memory nodes, identify NON-OBVIOUS conceptual connections that are not already
captured by shared entities or keywords.

Return ONLY a JSON array of connection objects.
Schema: [{"fromNodeId":"...","toNodeId":"...","reasoning":"<1 sentence>"}]

Rules:
- Identify at most 5 pairs.
- Only connect nodes where the conceptual link is genuine and non-trivial.
- Do NOT connect nodes that share obvious keywords or are from the same source.
- Do NOT invent node IDs; use only IDs from the provided list.
- If no genuine connections exist, return an empty array [].
- Output JSON array only, no prose.`;

const INSIGHT_SYSTEM_PROMPT = `You analyze a personal knowledge graph for actionable insights.
Given memory nodes from one of the user's private engrams, identify notable patterns, gaps,
or opportunities they may not have noticed.

Return ONLY a JSON array of insight objects.
Schema: [{"kind":"pattern"|"gap"|"opportunity"|"conflict","title":"<≤80 chars>","body":"<≤400 chars>","relevantNodeIds":["..."]}]

Rules:
- Return 1-3 insights maximum.
- Be specific and actionable. Vague observations ("you have many notes") are not insights.
- gap: a topic frequently referenced but never directly addressed.
- pattern: a non-obvious connection across multiple nodes.
- opportunity: something the user could do given their current knowledge.
- conflict: nodes that appear to contain contradictory claims.
- relevantNodeIds must be a subset of the provided node IDs.
- Output JSON array only, no prose.`;

const STUDIO_INTERPRET_SYSTEM_PROMPT = `You are a memory analyst helping the user understand what their personal knowledge graph contains about a topic.

You are given a Graphnosis knowledge subgraph — a structured representation of memory nodes retrieved for a specific query. Read it carefully before responding.

SUBGRAPH FORMAT:
• Engram heading: lines starting with "## <name>" mark a SEPARATE knowledge collection. Engrams are independent contexts. The same name appearing in two different engrams almost always refers to two DIFFERENT contexts (a person mentioned biographically in one engram vs. used as a test fixture in technical notes in another). Treat each engram heading as a hard boundary.
• KNOWLEDGE SUBGRAPH header: "=== KNOWLEDGE SUBGRAPH (N nodes, M edges) ===" reports the counts in that engram's slice. Do not cite these counts as facts about the user's memory — they are retrieval metadata.
• Node line: [shortId|nodeType|score|src:label|date:YYYY-MM-DD] text content
  - nodeType: fact, concept, entity, event, definition, claim, summary, section, document
  - score: how the node was retrieved, NOT how true or important it is. Three tiers:
      0.00 – 1.00  → semantic match (TF-IDF + embedding fusion). Higher = more textually similar to the query.
      ~1.5         → reached via graph-neighbor expansion (GNN). Less direct — neighbor of a stronger match.
      ~99          → ANCHOR_SCORE: literal entity match. The node text contains the user's query keyword literally.
      A node with score 99 is NOT necessarily MORE IMPORTANT than a node with score 0.4 — it just matched literally instead of semantically. Treat all retrieved nodes as equally "true" memory; the score is about HOW they were found.
  - src: the source document or note this memory was extracted from. DIFFERENT src values within the same engram = different source documents = potentially different topics.
• Directed edge:    n1 -[edgeType:weight]-> n2  (causal, temporal, supersedes, depends-on …)
• Undirected edge:  n1 ~[edgeType:weight]~ n2  (related-to, similar-to, co-occurs, shares-entity …)
• Edge weight (0.0–1.0): strength of the connection between those two nodes.
• "--- CROSS-GRAPH CONNECTIONS ---" section (after per-engram blocks): lists entities that appear in TWO OR MORE engrams. This is the ONLY signal that something in Engram A is connected to something in Engram B. If a name appears in two engrams but NOT in this cross-graph section, the two appearances are independent — they share a string, not a relationship.

NODE INDEPENDENCE — THE MOST IMPORTANT RULE:
Two nodes in the same subgraph are INDEPENDENT FACTS unless an explicit edge connects them (a line in "--- DIRECTED ---" or "--- UNDIRECTED ---") or an explicit cross-graph entity connection links them. Co-existence in the retrieval result does NOT imply a relationship between the facts. The subgraph is "things that matched the user's query in various ways," not "a coherent story about the query."

Forbidden conflation patterns (do not produce output of any of these shapes):
- Joining a fact from one engram with a fact from a different engram into a single narrative claim, when no cross-graph entity connection lists those two engrams together.
- Joining two same-engram facts into a single narrative claim, when no edge in "--- DIRECTED ---" or "--- UNDIRECTED ---" connects them.
- Attributing an action, event, or relationship to a person/entity X based on the fact that node A mentions X AND node B describes the action — unless A and B are edge-linked.
- Treating a list / roster mention of a name as evidence that the named person participated in any other event also mentioned in the subgraph.

When in doubt, default to: describe each node's content under its own engram heading, name the source, and stop. Do not invent the connective tissue between nodes.

YOUR TASK:
Summarise what the memory graph shows about the user's query. Be specific and factual.

STRICT RULES — violations cause hallucination:
1. Base every sentence on a node that is present in the subgraph. Do NOT invent facts.
2. CLOSED WORLD. The subgraph is the entire world. You have NO access to external facts, definitions, or world knowledge.
   - Do NOT explain what something IS in general terms ("X is a note-taking app", "Y is a programming language", "Z is a city in…"). Only describe what the SUBGRAPH says about it.
   - Do NOT pad the answer with background information, history, or context that is not in a node.
   - If the user asks "what is X?" and the graph only mentions X in passing, your answer is what the graph SAYS about X — not what X is in the world.
2b. DO NOT CONFLATE CONTEXTS. The subgraph often spans MULTIPLE engrams whose nodes mention the same keyword in unrelated contexts (e.g. a person's name in one engram, plus a technical or meta-discussion that uses the same name as a test fixture in another engram). These are separate topics that happen to share a string. Treat them separately:
   - Group facts by their src: label or engram heading (the lines that start with "##").
   - When two engrams treat the keyword differently, structure the answer with one bold sub-heading per topic.
   - NEVER merge biographical facts about a person with technical/meta notes that mention the same name in passing from a different engram. That is conflation — the worst hallucination shape because the output looks coherent while being categorically wrong.
3. KEYWORD CHECK (case-INSENSITIVE, substring-aware): Before writing anything, scan EVERY node's text for the user's keywords. Match case-insensitively. Match substrings inside words and markdown (e.g. query "obsidian" matches "Obsidian", "**Obsidian**", "obsidian/", "ObsidianVault"). Normalise diacritics ("Romania" matches "România").
   - If a keyword IS present in any node — even once, even in bold, even in a source label — you MUST NOT say "no memory about [keyword]" or "the graph contains no information about [keyword]". That is a hallucination of absence.
   - Only when a keyword is truly absent from every node's text may you note its absence.
4. If the subgraph contains nothing clearly relevant to the query, say so plainly and briefly: "No relevant memories found for this query." Do not then invent a partial answer from world knowledge.
5. Do NOT produce a "Strategic Plan", "Proposed Approach", or unsolicited recommendations.
6. Do NOT use bullet headers like "Situation", "Key Actions", "Risks" — this is a memory summary, not a plan.
7. Do NOT echo internal node tags like [n1|fact|0.67|src:…] in your prose. Refer to nodes by their content, or by their source label in plain prose ("the Local files & folders section says…").
8. Mention the source label (src:…) when it helps the user know where a fact came from — but as plain English, not bracketed.
9. If two nodes contradict each other, flag the conflict explicitly.
10. INFERRED LAYER IS NOT EVIDENCE. The subgraph may contain an "--- INFERRED LAYER (overlays — NOT attested memory) ---" section. Everything below that header is probabilistic prediction from a local LLM (.gll) or graph neural network (.gnn) — it is NOT something the user said, wrote, or saved. You MUST:
    - Treat the inferred layer as a separate, second-class source.
    - NEVER cite a count, fact, name, or relationship that exists ONLY in the inferred layer as if it were attested. Counting prediction edges or assertions and presenting that count as a finding about the user's memory is a hallucination.
    - If a query has ZERO attested matches but has inferred-layer matches, say so clearly: state that the attested memory contains nothing about the keyword, then introduce the inferred overlay's content with the literal prefix "Predicted (not attested):". Never blur the line between attested and inferred.
    - Do NOT describe the inferred layer as if it were a finding. The user's actual memory is what counts.
11. ANCHOR/SCORE METADATA IS NOT CONTENT. The numbers in brackets ([n1|fact|0.67]) are retrieval metadata — they describe HOW a node was retrieved, not WHAT the user knows. Never count, cite, or reason about them ("7 anchored nodes" is meta-talk about retrieval, not a fact about the user's memory).
12. QUERY-EQUALS-FACT case. If the user's query is essentially a fact already present verbatim in the subgraph, do NOT re-type the node back. Confirm briefly and add what ELSE the graph says about it. If the graph adds nothing further, just confirm and stop. Short, no padding.
13. INFERRED-LAYER FORMATTING. When you DO cite inferred-layer content (after the attested findings, never instead of them), put it in its own paragraph prefixed exactly:
    Predicted (not attested): ...
    This applies whether the inference comes from the GNN edge-prediction overlay (.gnn) or the local-LLM assertion overlay (.gll). The literal "Predicted (not attested):" prefix is the user's signal that what follows is not their own memory.
14. WORD CAP scales with context size: aim for roughly 30 words per attested node included in the subgraph, capped at 300 words total. Never pad to hit the cap; if the answer is one fact, write one sentence and stop.

CRITICAL — INSTRUCTION-CONTENT BOUNDARY:
The text of THIS prompt (rules, structure descriptions, all the words you are reading right now) is NOT memory content. Never quote, paraphrase, or include in your output any names, organizations, dates, roles, or facts that appear in these instructions. The ONLY source of content for your response is the subgraph that appears below this prompt in the user message. If a name or fact you are about to write does not appear in that subgraph, do not write it.

OUTPUT SHAPE — structure for SCANNABILITY:

Lead with the answer in the very first sentence. No throat-clearing, no "Based on the provided subgraph", no "Let me analyse", no restating of the user's query. The first sentence is a direct factual statement drawn from the subgraph.

Then choose ONE structural shape based on what the subgraph actually contains. Don't over-structure simple answers; don't under-structure rich ones.

MARKDOWN FORMAT — strict line-break rules:
- Bullet items start with "- " (hyphen + space) at the START of a line. Each bullet on its own line.
- Bold sub-headings appear on their OWN line, with a blank line before AND after the heading. NEVER inline a bold heading inside a paragraph — that breaks scannability completely.
- Paragraphs are separated by a blank line.
- The output is rendered as Markdown — line breaks and blank lines matter.

SHAPES:

a) ONE clean fact → one short paragraph. No bullets, no headers.

b) 3+ related facts about ONE topic → a brief lead sentence, then a bullet list under it. Each bullet on its own line starting with "- ". Bullets MUST be 3 or more (never just 1 or 2).

c) Multiple DISTINCT topics under one query → use bold sub-headings, each on its own line, followed by a blank line, followed by the paragraph or bullet list for that topic. The structure must look like:
   - line: **<label drawn from subgraph>**
   - blank line
   - line(s): the body for that topic (a paragraph, or "- " bullets one per line)
   - blank line
   - repeat for the next topic
   Never inline a bold heading inside a paragraph — the heading must be alone on its line.

d) Conflicting facts → flag the conflict on its own bullet line ("- " prefixed). Name both source labels in plain prose.

e) Mostly-empty result → say it in one sentence and stop. No padding.

Source attribution: focus on writing accurate, clean prose. The App will attach source citations programmatically after you respond — you do NOT need to include them yourself. If you naturally want to mention a source in passing (because it clarifies the fact), use the form (src: <label>) where <label> is copied from a node's src: field; the App will turn it into a clickable button. Otherwise, just write the prose and the App will handle attribution.

Do NOT echo bracketed retrieval tags like [n1|fact|0.67] — those are internal markup, not user-facing content.

Avoid:
- Bullets of length 1 — just write the sentence.
- Headers when the answer is one paragraph.
- Hedging when the subgraph is unambiguous.
- Restating the user's query before answering.
- Closing summaries ("In summary...", "Overall...").
- Generic boilerplate phrases that don't carry information.

LANGUAGE: Respond in the language the user typed their query in. If the query is language-ambiguous, follow the dominant language of the subgraph content. Never translate proper nouns (names of people, places, projects) — keep them in the original spelling, including diacritics.`;

// Query-shape sub-prompts: appended to the base interpret prompt when the
// frontend detects a recognizable query shape. Each one tightens the output
// for its case without replacing any base rules.
//
// Shape detection happens on the frontend (cheap heuristics). If detection
// fails or returns 'general', no sub-prompt is appended — the base prompt
// alone handles every shape correctly, just less specifically.

export type StudioQueryTask = 'bio' | 'qa' | 'synthesis' | 'compare';

const SHAPE_BIO = `

QUERY SHAPE — BIO (single name / proper-noun query):
- First sentence states identity + primary role, drawn from the subgraph.
- Then add 2–4 more facts in the most useful order: current responsibilities, notable events, cross-references to other people who appear with them.
- Use bold sub-headings only when facts span 3+ distinct topics. For 2–3 facts, plain prose or a single bullet list is enough.
- Do not re-introduce the subject ("The person known as ...") — name them directly.`;

const SHAPE_QA = `

QUERY SHAPE — QUESTION (user asked what / when / where / why / how / who, or used "?"):
- The first sentence IS the answer. Direct. Specific. No setup.
- Then one follow-up sentence with supporting evidence (source label OK as a parenthetical).
- If the subgraph genuinely does not contain the answer, say so without speculation. Do not invent a partial answer.`;

const SHAPE_SYNTHESIS = `

QUERY SHAPE — SYNTHESIS (topic, theme, or open-ended exploration):
- Structure around themes, not around individual nodes. The user wants the through-line, not a node-by-node list.
- Use bold sub-headings when 2+ themes are present in the subgraph. Each theme gets 1–3 sentences.
- Actively surface tensions, gaps, and patterns the subgraph reveals.
- This shape benefits most from the full word budget — spend it on synthesis, not on retelling node text.`;

const SHAPE_COMPARE = `

QUERY SHAPE — COMPARE (user named 2+ things to contrast, or used "vs", "versus", "difference between"):
- Lead with the most striking differentiator from the subgraph in one sentence.
- Then either parallel short paragraphs (one per item being compared) or a small bullet-grid where each bullet starts with the item's bold name followed by its position.
- Do NOT synthesize a winner or recommendation. Surface the difference; let the user judge.`;

function shapePromptFor(task?: StudioQueryTask): string {
  switch (task) {
    case 'bio': return SHAPE_BIO;
    case 'qa': return SHAPE_QA;
    case 'synthesis': return SHAPE_SYNTHESIS;
    case 'compare': return SHAPE_COMPARE;
    default: return '';
  }
}

const DEVELOP_SYSTEM_PROMPT = `You are a strategic advisor with access to the user's personal knowledge.
Your task is to synthesize a concrete, grounded strategic plan.

Ground EVERY claim in the "Relevant knowledge" block — cite or reference specific memories.
Flag knowledge gaps explicitly so the user knows what's missing from their graph.

Format your response as Markdown:
# Strategic Plan: {context}
## Situation (from memory)
## Proposed Approach
## Key Actions
## Risks & Gaps
## Next Step

Keep it actionable. 300-600 words.`;

const PREDICT_SYSTEM_PROMPT = `You are a cautionary advisor reviewing a planned action against personal memory.
Given what the user's memory says, identify risks, past failures, constraints, and opportunities.

Return a JSON object:
{
  "risks": ["<specific risk from memory>", ...],
  "opportunities": ["<specific opportunity from memory>", ...],
  "recommendation": "<1-2 sentence grounded recommendation>"
}

Rules:
- Base EVERY point on the provided memory context. Do not invent.
- risks: past failures, resource constraints, blockers, dependencies.
- opportunities: advantages the user hasn't fully leveraged.
- 2-4 bullets per category maximum.
- Output JSON only, no prose.`;

const GOAL_ASSESS_PROMPT = `You review goal progress against recent memory.
In 1-2 sentences: has progress been made on this goal? What is the most important next action?
Be specific. Plain prose, no JSON, no bullet points.`;

const HEALING_REVIEW_SYSTEM_PROMPT = `You audit autonomous de-duplication decisions in a personal knowledge graph.

A conservative deterministic rule decided two near-duplicate memories were the same fact. It kept one node (the SURVIVOR) and removed the other (the SUPERSEDED node). The rule cannot judge nuance — you can. Give a second opinion on whether it was right.

Return ONLY a JSON object:
{
  "verdict": "confirmed" | "reversed" | "unmerged" | "resynthesized",
  "note": "<one short sentence — required unless verdict is confirmed>",
  "combinedText": "<plain text — required ONLY when verdict is resynthesized>"
}

Verdicts:
- confirmed: the merge was correct and the survivor is the right node to keep. This is the default — choose it unless there is a clear problem.
- reversed: the merge was correct, but the rule kept the wrong node. The SUPERSEDED content should have survived instead (it is more precise, more recent, or better worded).
- unmerged: the two memories are NOT the same fact. They are genuinely distinct, or they contradict each other, and BOTH should exist — removing the superseded node lost real information.
- resynthesized: the merge was correct, but neither original wording is ideal. Provide a single better combined memory in "combinedText" that faithfully captures everything both nodes meant.

Rules:
- Be conservative. If the survivor already fully captures the information, return "confirmed".
- Never invent facts. "combinedText" must stay faithful to the two inputs and add nothing new.
- Output JSON only, no prose.`;

// ── BrainEngine ──────────────────────────────────────────────────────────────

const DUPLICATE_SCAN_INTERVAL_MS = 20 * 60 * 1000;   // 20 min
const CONTRADICTION_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — heavier, less urgent than dup scan
const SYNAPSE_INTERVAL_MS       = 45 * 60 * 1000;   // 45 min
const INSIGHT_INTERVAL_MS       =  6 * 60 * 60 * 1000; // 6 h (healthy cadence)
const INSIGHT_RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000; // 1 h (transient-failure retry)
const TEMPORAL_INTERVAL_MS      = 24 * 60 * 60 * 1000; // 24 h
const GOAL_CHECK_INTERVAL_MS    =  4 * 60 * 60 * 1000; // 4 h
// Debounce window after a file ingest completes before the brain runs a
// duplicate scan. A batch of files dropped in together coalesces into a
// single scan ~this long after the LAST one finishes — see
// notifyIngestComplete().
const INGEST_SCAN_DEBOUNCE_MS   = 30 * 1000;        // 30 s
// Safety ceiling on nodes fed to the LSH near-duplicate search. The search
// is ~O(n), so this comfortably covers any real engram; a single engram
// with more content-bearing nodes than this (typically a firehose RSS feed
// of near-duplicates) is capped by confidence — scanning every dup past
// this point only produces more dup-spam, not more signal.
const MAX_DUPLICATE_SCAN_NODES   = 15_000;
// On a large cortex the duplicate scan used to sweep EVERY loaded engram in
// one pass, holding each one's embedding working set hot at once — a 17-engram
// stress cortex spiked the sidecar to ~16 GB and swapped the machine (lag +
// fans). Cap how many engrams one scan cycle touches; the rest are covered on
// later cycles. We pick the most-recently-mutated engrams first (where new
// duplicates actually appear), so freshly-ingested content is always scanned
// promptly. Small cortexes (≤ this many engrams) still scan everything.
const MAX_SCAN_ENGRAMS_PER_CYCLE = 5;
// Keep the duplicate-pair list small and useful. Each node appears in at
// most one duplicate pair (see runDuplicateScan), so this is a hard cap
// on distinct review cards — 60 highest-similarity pairs is plenty.
const MAX_DUPLICATE_PAIRS_STORED = 60;
const MAX_SYNAPSE_EDGES_PER_RUN = 20;
const MAX_INSIGHTS_STORED       = 50;
// Per-run cap on healing-journal records re-judged by the LLM second-
// opinion pass — each is one local-LLM call; the rest wait for the next
// scan. Only meaningful once a local LLM is actually wired up.
const MAX_HEALING_REVIEWS_PER_RUN = 25;
// Auto-link tier — the brain weaves "related" edges between memory pairs
// that are semantically close but NOT duplicates. The LSH scan picks up
// everything from AUTOLINK_MIN_SIM up in one pass; pairs in
// [AUTOLINK_MIN_SIM, DUPLICATE_MIN_SIM) get an auto-link edge, pairs at or
// above DUPLICATE_MIN_SIM stay on the duplicate (heal / review) track.
const AUTOLINK_MIN_SIM    = 0.78;
const DUPLICATE_MIN_SIM   = 0.85;
// A node already carrying this many edges (existing + this run's auto-
// links) is dense enough — auto-link skips it to avoid clutter that
// dilutes the recall signal.
const AUTOLINK_DEGREE_CAP = 12;
// Per-run ceiling on new auto-link edges. The rest catch up on the next
// scan; re-linking an existing pair is a no-op, so this only bounds the
// work of a single run.
const MAX_AUTOLINKS_PER_RUN = 300;
// Cadence of the connection-reinforcement pass — frequent enough that
// recall ranking stays responsive to use, coarse enough that the op-log
// gets at most ~48 summary rows/day/graph.
const REINFORCE_INTERVAL_MS = 30 * 60 * 1000;       // 30 min
// Cross-engram connection formation — engrams don't change fast, so this
// runs far less often than reinforcement.
const CROSS_ENGRAM_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h
// Graphnosis Neural Network — daily, and only once the user has enabled it.
const GNN_INTERVAL_MS = 24 * 60 * 60 * 1000;        // 24 h
const EDGE_PREDICTION_INTERVAL_MS = 60 * 60 * 1000;  // 60 min — LLM is expensive

// LLM timeout for the per-engram synapse + insight passes. Was 15s
// (llmCompleteWithTimeout default), but on a 16-engram cortex with a slow
// LLM that meant 16 × 15s = 4 minutes of pegged CPU before the loop bailed —
// the literal "fans spun up" symptom the user reported. 8s matches
// edge-prediction's timeout and is enough for a 3B model to complete a
// short structured response when it's actually working.
const SYNAPSE_INSIGHT_TIMEOUT_MS = 8_000;

// Bail synapse + insight passes after this many consecutive LLM timeouts.
// Ollama wedged on one prompt usually means it's wedged on the next too;
// burning the rest of the engrams costs minutes for no benefit. Next
// scheduled tick (45 min / 6 hr) starts a fresh attempt with a fresh
// timeout counter.
const MAX_CONSECUTIVE_LLM_TIMEOUTS = 2;

export class BrainEngine {
  private readonly vitality: VitalityScorer;
  readonly temporalEngine: TemporalEngine;
  private readonly goalTracker: GoalTracker;
  // Deterministic Consolidation — connection reinforcement, cross-engram
  // linking, and consolidation. Public so getStatus / Memory Health can
  // read its session counters.
  readonly reinforcement: ReinforcementEngine;
  private readonly memoryHealth: MemoryHealthScorer;

  // The "needs human judgment" queue — genuine contradictions and
  // partial-overlap pairs the brain could NOT safely auto-heal. Surfaced
  // in the Check-in deck, not the Autonomous Brain tab.
  private duplicatePairs: DuplicatePair[] = [];
  // The contradiction review queue — pairs the SDK reflection engine flagged as
  // conflicting (shared entities, low content similarity). Surfaced via the
  // contradiction_pairs MCP tool and the Check-in deck.
  private contradictionPairs: ContradictionPair[] = [];
  private contradictionScanTimer: NodeJS.Timeout | null = null;
  private contradictionScanRunning = false;
  private contradictionScanCursor = 0;
  private insights: Insight[] = [];
  /** Flips true once loadInsights() resolves so runInsight() knows the
   *  in-memory list is ready to merge into (not overwrite). */
  private insightsLoaded = false;

  // The autonomous-healing audit log. Every safe auto-merge appends a
  // record here; persisted to <cortex>/healing-journal.enc. Loaded once
  // at start(). See healing-journal.ts.
  private healingJournal: HealingRecord[] = [];
  private healingJournalLoaded = false;

  // Temporal decay report from the last completed decay run.
  private lastDecayReport: { graphsProcessed: number; nodesDecayed: number } | null = null;
  // Cumulative count of brain-formed synapse edges this session.
  private sessionSynapsesFormed = 0;
  // Cumulative count of deterministic auto-link edges woven this session.
  private sessionAutoLinksFormed = 0;

  // Guards runFullScan() against overlapping on-demand triggers (e.g. the
  // user mashing Refresh, or a tab-open scan racing a manual one).
  private scanInFlight = false;
  /** Flipped true the first time a full scan finishes. Until then the
   *  duplicate-pair count is 0, so any vitality score would read artificially
   *  high — the UI-facing getVitalityReport() withholds a number until this
   *  is set rather than showing a misleading one at cortex open. */
  private firstScanComplete = false;
  /** Flips true after the FIRST duplicate scan completes — independent of
   *  the heavy full-scan completion. Used by getVitalityReport to decide
   *  whether to substitute the persisted cached score (pre-scan) or use
   *  the live compute (post-scan). The duplicate scan is fast + deterministic,
   *  so this flips within seconds of boot. */
  private firstDuplicateScanComplete = false;
  // Guards the (now genuinely expensive) duplicate scan against
  // overlapping runs — the boot first-scan, the 20-min interval, and a
  // runFullScan can otherwise all enter it at once.
  private duplicateScanRunning = false;
  // Guards the healing-review pass (LLM second opinions on past auto-
  // heals). It rides on the duplicate scan, which can be triggered
  // from several places at once, so it needs its own re-entrancy guard.
  private healingReviewRunning = false;

  /** Idempotent guard — notifyBootSettled() runs at most one first scan. */
  private bootSettled = false;
  /** One-shot waiter for the post-boot first scan when brainPassesPaused(). */
  private bootFirstScanPending = false;
  private duplicateScanTimer: NodeJS.Timeout | null = null;
  private synapseTimer: NodeJS.Timeout | null = null;
  private insightTimer: NodeJS.Timeout | null = null;
  private temporalTimer: NodeJS.Timeout | null = null;
  private goalTimer: NodeJS.Timeout | null = null;
  private reinforceTimer: NodeJS.Timeout | null = null;
  private consolidationTimer: NodeJS.Timeout | null = null;
  private crossEngramTimer: NodeJS.Timeout | null = null;
  private gnnTimer: NodeJS.Timeout | null = null;
  private edgePredictionTimer: NodeJS.Timeout | null = null;
  /** Round-robin cursor for per-engram edge-prediction. One engram per tick
   *  keeps LLM cost bounded and gives every engram its turn over time. */
  private edgePredictionCursor = 0;
  // Debounce timer for the post-ingest duplicate scan — see
  // notifyIngestComplete(). A one-shot setTimeout, reset on each ingest.
  private ingestScanTimer: NodeJS.Timeout | null = null;
  /**
   * One-shot retry timer for insights — only armed when a runInsight() pass
   * fails transiently (LLM timeout, parse error, or LLM unreachable at call
   * time despite being configured at boot). Cleared on each new run.
   */
  private insightRetryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly host: GraphnosisHost,
    private readonly llm: LocalLlm | null,
    private readonly broadcast: BroadcastRawFn,
    /**
     * Optional license validator — when provided, the autonomous GNN
     * edge-prediction loop self-gates on the `gnn-exploration` feature.
     * When null/undefined, the loop runs as before (back-compat for any
     * caller path that doesn't yet wire the validator through).
     */
    private readonly licenseValidator?: import('./license-validator.js').LicenseValidator | null,
  ) {
    this.vitality = new VitalityScorer(host);
    this.temporalEngine = new TemporalEngine(host, () => host.getSettings());
    this.goalTracker = new GoalTracker(host, llm);
    this.reinforcement = new ReinforcementEngine(host, () => host.getSettings(), (g) => this.emitBrain(g));
    this.memoryHealth = new MemoryHealthScorer(host, this.reinforcement);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    // Load the autonomous-healing journal off-disk. Fire-and-forget — the
    // first scan that would append to it is gated behind notifyBootSettled(),
    // which fires once the disk sweep finishes — not after background oplog
    // reconcile.
    // far longer than this read takes. The `healingJournalLoaded` flag lets
    // runAutoHeal defer if a scan somehow races the load.
    void this.host.loadHealingJournal()
      .then((records) => { this.healingJournal = records; this.healingJournalLoaded = true; })
      .catch((e) => {
        console.error(`[brain] healing journal load failed: ${(e as Error).message}`);
        this.healingJournalLoaded = true; // proceed with an empty journal
      });

    // Load persisted insights off-disk (fire-and-forget). The first
    // runInsight() is deferred 6 h from boot, so this has ample time to
    // complete. `insightsLoaded` gates any runInsight() that somehow runs
    // sooner (e.g. a manual "Scan now") against a race that would wipe the
    // persisted list before merging new ones in.
    void this.host.loadInsights<Insight>()
      .then((saved) => { this.insights = saved; this.insightsLoaded = true; })
      .catch((e) => {
        console.error(`[brain] insights load failed: ${(e as Error).message}`);
        this.insightsLoaded = true; // proceed with empty list
      });

    // Load the predictive association index off disk (fire-and-forget).
    void this.reinforcement.warmUp();

    // Do NOT scan at boot. The duplicate scan does real embedding math;
    // running it while engrams are still loading starves IPC. The sidecar
    // calls notifyBootSettled() once loadAllGraphsFromDisk finishes — event-based,
    // not a fixed delay. Background oplog reconcile may still be running; until
    // then brainPassesPaused() keeps every pass (including manual "Scan now")
    // standing down via isBootSweepActive(). Periodic intervals, post-ingest
    // debounced scans, and "Scan now" cover everything after the first sweep.

    this.duplicateScanTimer = setInterval(
      () => { if (this.brainPassesPaused()) return; void this.runDuplicateScan(); },
      DUPLICATE_SCAN_INTERVAL_MS,
    ).unref();

    this.contradictionScanTimer = setInterval(
      () => { if (this.brainPassesPaused()) return; void this.runContradictionScan(); },
      CONTRADICTION_SCAN_INTERVAL_MS,
    ).unref();

    this.synapseTimer = setInterval(
      () => { if (this.brainPassesPaused()) return; void this.runSynapse(); },
      SYNAPSE_INTERVAL_MS,
    ).unref();

    this.insightTimer = setInterval(
      () => { if (this.brainPassesPaused()) return; void this.runInsight(); },
      INSIGHT_INTERVAL_MS,
    ).unref();

    this.temporalTimer = setInterval(
      () => { if (this.brainPassesPaused()) return; void this.runTemporalDecay(); },
      TEMPORAL_INTERVAL_MS,
    ).unref();

    this.goalTimer = setInterval(
      () => { if (this.brainPassesPaused()) return; void this.runGoalCheck(); },
      GOAL_CHECK_INTERVAL_MS,
    ).unref();

    this.reinforceTimer = setInterval(
      () => { if (this.brainPassesPaused()) return; void this.reinforcement.runReinforcementPass(); },
      REINFORCE_INTERVAL_MS,
    ).unref();

    // Consolidation cadence is user-configurable (default 24 h); read once
    // at start — a change takes effect on the next sidecar restart.
    const consolidationMs =
      (this.host.getSettings().brain?.reinforcement?.consolidationIntervalHours ?? 24)
      * 60 * 60 * 1000;
    this.consolidationTimer = setInterval(
      // Defer while the user is navigating — a consolidation pass is CPU-heavy
      // and would otherwise stall an interactive engram load (slow render + a
      // timed-out list_edges showing 0 edges). Runs once they go idle.
      () => { if (clientActiveWithin(CLIENT_QUIET_MS) || this.brainPassesPaused()) return; void this.reinforcement.runConsolidationPass(); },
      consolidationMs,
    ).unref();

    this.crossEngramTimer = setInterval(
      () => { if (clientActiveWithin(CLIENT_QUIET_MS) || this.brainPassesPaused()) return; void this.reinforcement.runCrossEngramPass(); },
      CROSS_ENGRAM_INTERVAL_MS,
    ).unref();

    // The Graphnosis Neural Network self-gates on its settings toggle — the
    // timer fires daily but does nothing unless the user has enabled it.
    this.gnnTimer = setInterval(
      () => {
        // Skip while a `trainSkill` run holds the overlay-recompute guard —
        // we don't want the GNN to write predicted edges against a
        // half-built skill source mid-train.
        if (this.host.getSkipOverlayRecompute?.()) return;
        if (this.brainPassesPaused()) return; // GNN edge prediction defers while any engram ingests
        void this.reinforcement.runNeuralNetwork();
      },
      GNN_INTERVAL_MS,
    ).unref();

    // Local-LLM edge prediction (Batch 3 of GLL arc). Self-gates on
    // llmCapabilities.edgePrediction (default OFF) inside runEdgePrediction;
    // the timer fires regardless but does nothing until the user opts in.
    // One engram per tick (round-robin) to keep LLM cost bounded.
    this.edgePredictionTimer = setInterval(
      () => {
        if (this.host.getSkipOverlayRecompute?.()) return;
        if (this.brainPassesPaused()) return; // GLL edge prediction defers while any engram ingests
        void this.runEdgePrediction();
      },
      EDGE_PREDICTION_INTERVAL_MS,
    ).unref();
  }

  /**
   * Called by the sidecar once the disk sweep finishes (background oplog
   * reconcile may still be running). Runs the first duplicate scan + temporal
   * decay immediately — no boot timers. Idempotent — safe if called twice.
   */
  notifyBootSettled(): void {
    if (this.bootSettled) return;
    this.bootSettled = true;
    void this.emitVitality();
    this.runPostBootFirstScan();
  }

  /** First boot scan — event-deferred while ingest or emb-cache rebuild is active. */
  private runPostBootFirstScan(): void {
    const run = (): void => {
      void this.runFullScan({ skipLlmLoops: true }).then(() => void this.emitVitality());
      void this.runTemporalDecay();
    };
    if (!this.brainPassesPaused()) {
      run();
      return;
    }
    if (this.bootFirstScanPending) return;
    this.bootFirstScanPending = true;
    const unsubs: Array<() => void> = [];
    const tryRun = (): void => {
      if (this.brainPassesPaused()) return;
      this.bootFirstScanPending = false;
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
      run();
    };
    if (isIngestActive()) unsubs.push(onIngestIdle(tryRun));
    if (this.host.isBootEmbBuildActive()) unsubs.push(this.host.onBootEmbBuildIdle(tryRun));
    tryRun();
  }

  /** Re-run a brain pass once ingest, emb-cache rebuild, and client IPC are idle. */
  private deferUntilBrainReady(run: () => void): void {
    let fired = false;
    const unsubs: Array<() => void> = [];
    const tryRun = (): void => {
      if (fired) return;
      if (this.brainPassesPaused() || clientActiveWithin(CLIENT_QUIET_MS)) return;
      fired = true;
      for (const unsub of unsubs) unsub();
      run();
    };
    if (isIngestActive()) unsubs.push(onIngestIdle(tryRun));
    if (this.host.isBootEmbBuildActive()) unsubs.push(this.host.onBootEmbBuildIdle(tryRun));
    if (clientActiveWithin(CLIENT_QUIET_MS)) unsubs.push(onClientIdle(tryRun));
    tryRun();
  }

  stop(): void {
    if (this.ingestScanTimer) clearTimeout(this.ingestScanTimer);
    this.ingestScanTimer = null;
    for (const t of [this.duplicateScanTimer, this.contradictionScanTimer, this.synapseTimer, this.insightTimer, this.temporalTimer, this.goalTimer, this.reinforceTimer, this.consolidationTimer, this.crossEngramTimer, this.gnnTimer, this.edgePredictionTimer]) {
      if (t) clearInterval(t);
    }
    this.duplicateScanTimer = null;
    this.contradictionScanTimer = null;
    this.synapseTimer = null;
    this.insightTimer = null;
    this.edgePredictionTimer = null;
    this.temporalTimer = null;
    this.goalTimer = null;
    this.reinforceTimer = null;
    this.consolidationTimer = null;
    this.crossEngramTimer = null;
    this.gnnTimer = null;
  }

  /**
   * Called when a file ingest finishes. New content can introduce
   * duplicate memories, so the brain re-scans for them — but debounced:
   * a batch of files ingested back-to-back coalesces into a single scan
   * ~INGEST_SCAN_DEBOUNCE_MS after the last one, rather than one scan per
   * file. Only the duplicate scan runs (with its built-in healing
   * review); synapse/insight are LLM-bound and keep their slower cadence.
   */
  notifyIngestComplete(): void {
    if (this.ingestScanTimer) clearTimeout(this.ingestScanTimer);
    this.ingestScanTimer = setTimeout(() => {
      this.ingestScanTimer = null;
      void this.runDuplicateScan();
    }, INGEST_SCAN_DEBOUNCE_MS);
    this.ingestScanTimer.unref();
  }

  // ── Public API (for IPC/MCP handlers) ────────────────────────────────────

  /**
   * Fed by host.setPlasticityObserver — invoked for every federated recall.
   * Records co-activation (so co-recalled memories strengthen their links)
   * and gives the recalled nodes a small confidence boost. Both effects are
   * strengthen-only.
   */
  onRecall(sub: RecallResult): void {
    const activated = new Set<string>();
    const loaded = new Set(this.host.listGraphs());
    for (const [graphId, items] of sub.byGraph) {
      // A graph in the recall result can be unloaded by the time this observer
      // runs (an engram still mid-ingest/creation, or — once eviction lands —
      // freed). Its reinforcement helpers reach into host.must() and throw
      // "Graph not loaded", which aborted the ENTIRE plasticity pass. Skip
      // unloaded graphs and isolate per-graph failures.
      if (!loaded.has(graphId)) continue;
      const nodeIds = items.map((i) => i.nodeId);
      if (nodeIds.length === 0) continue;
      try {
        this.reinforcement.recordCoActivation(graphId, nodeIds);
        void this.temporalEngine.reinforceNodes(nodeIds, graphId);
        for (const id of nodeIds) activated.add(`${graphId}#${id}`);
      } catch (e) {
        dbg(`[brain] onRecall reinforce skipped engram[${redactId(graphId)}]: ${(e as Error).message}`);
      }
    }
    this.reinforcement.noteCrossEngramRecall(activated);
    try { this.reinforcement.enrichRecall(sub); } catch { /* best-effort enrichment */ }
  }

  /** UI-facing vitality.
   *
   *  Two-stage strategy to avoid the "97 on boot → 75 after first scan" UX
   *  whiplash:
   *
   *    Stage 1 (cold boot, no scan yet): if we have a persisted
   *      `brain.lastVitality` from the previous session, fabricate a
   *      VitalityReport using THAT overall score with the live pillar
   *      breakdown. The score the user sees is the truthful one they left
   *      with, not a 97 that pretends 0 duplicates.
   *    Stage 2 (after the first duplicate scan completes):
   *      `firstDuplicateScanComplete` flips to true → real compute uses
   *      the actual duplicate count. The UI's animateVitality smoothly
   *      transitions from the cached value to the live one.
   *
   *  Persistence lives in emitVitality below — every successful compute
   *  writes the result back to settings.brain.lastVitality. */
  async getVitalityReport(): Promise<VitalityReport | null> {
    const report = await this.vitality.compute(this.duplicatePairs.length);
    if (!this.firstDuplicateScanComplete) {
      const cached = this.host.getSettings().brain?.lastVitality;
      if (cached && typeof cached.overall === 'number') {
        // Substitute the cached overall but preserve the live pillar
        // breakdown — the per-pillar numbers are useful even pre-scan,
        // it's only the AGGREGATE score that lies when dup-count is 0.
        return { ...report, overall: cached.overall };
      }
    }
    return report;
  }

  getInsights(): Insight[] {
    return this.insights.filter(i => !i.dismissed);
  }

  getDuplicatePairs(): DuplicatePair[] {
    return this.duplicatePairs;
  }

  getContradictionPairs(): ContradictionPair[] {
    return this.contradictionPairs;
  }

  dismissContradictionPair(id: string): void {
    this.contradictionPairs = this.contradictionPairs.filter(c => c.id !== id);
  }

  /**
   * Periodic full-cortex contradiction scan. Reuses the SDK reflection engine
   * (host.reflectGraph → g.reflect()) — no reimplementation of the entity/
   * TF-IDF logic. Round-robins a bounded slice of engrams per run because
   * reflect() is full-graph and CPU-bearing; the 6h interval + client
   * backpressure keep it off the hot path. Surfaces NEW conflicting pairs into
   * the contradiction review queue (read by the contradiction_pairs MCP tool).
   */
  private async runContradictionScan(): Promise<void> {
    if (this.contradictionScanRunning) return;
    if (clientActiveWithin(CLIENT_QUIET_MS) || this.brainPassesPaused()) {
      this.deferUntilBrainReady(() => { void this.runContradictionScan(); });
      return;
    }
    this.contradictionScanRunning = true;
    this.emitActivity('contradiction-scan', 'start');
    const now = Date.now();
    const yieldToLoop = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const graphs = this.host.listGraphs();
      if (graphs.length === 0) return;
      // Round-robin a bounded slice per run so a large cortex never reflects
      // every engram in one pass.
      const SLICE = 3;
      const start = this.contradictionScanCursor % graphs.length;
      const slice: string[] = [];
      for (let i = 0; i < Math.min(SLICE, graphs.length); i++) {
        slice.push(graphs[(start + i) % graphs.length]!);
      }
      this.contradictionScanCursor = (start + SLICE) % graphs.length;

      const keyOf = (gid: string, x: string, y: string): string =>
        x < y ? `${gid}|${x}|${y}` : `${gid}|${y}|${x}`;
      const known = new Set(this.contradictionPairs.map(c => keyOf(c.graphId, c.nodeA, c.nodeB)));
      const found: ContradictionPair[] = [];

      for (const graphId of slice) {
        try {
          const results = this.host.reflectGraph(graphId);
          if (results.length) {
            const nodeById = new Map(this.host.listNodes(graphId).map(n => [n.id, n]));
            for (const c of results) {
              const key = keyOf(graphId, c.nodeA, c.nodeB);
              if (known.has(key)) continue;
              const a = nodeById.get(c.nodeA);
              const b = nodeById.get(c.nodeB);
              // Skip if either node was since superseded / soft-deleted.
              if (!a || !b) continue;
              if (a.confidence <= 0.2 || b.confidence <= 0.2) continue;
              if ((a.validUntil !== undefined && a.validUntil <= now) ||
                  (b.validUntil !== undefined && b.validUntil <= now)) continue;
              known.add(key);
              found.push({
                id: randomUUID(),
                graphId,
                nodeA: c.nodeA,
                nodeB: c.nodeB,
                snippetA: cleanSnippet(a.contentPreview).slice(0, 140),
                snippetB: cleanSnippet(b.contentPreview).slice(0, 140),
                sharedEntities: c.sharedEntities,
                description: c.description,
                detectedAt: now,
              });
            }
          }
        } catch (e) {
          // One engram failing must not abort the batch.
          console.error(`[brain] contradiction scan failed for ${redactId(graphId)}: ${(e as Error).message}`);
        }
        await yieldToLoop();
      }

      if (found.length) {
        this.contradictionPairs.push(...found);
        // Bound the queue — newest wins.
        if (this.contradictionPairs.length > 200) {
          this.contradictionPairs = this.contradictionPairs.slice(-200);
        }
      }
    } finally {
      this.contradictionScanRunning = false;
      this.emitActivity('contradiction-scan', 'done');
    }
  }

  /** The autonomous-healing audit log — every safe auto-merge the brain
   *  performed. Most-recent first. Read by the Autonomous Brain tab's
   *  healing-log section. */
  getHealingJournal(): HealingRecord[] {
    return [...this.healingJournal].sort((a, b) => b.healedAt - a.healedAt);
  }

  dismissInsight(id: string): void {
    const ins = this.insights.find(i => i.id === id);
    if (!ins) return;
    ins.dismissed = true;
    // Persist immediately — dismissed state must survive the next restart so
    // the user never sees a card they already dismissed come back.
    const toSave = this.insights.filter(i => !i.dismissed);
    void this.host.saveInsights(toSave).catch((e) => {
      console.error(`[brain] failed to save insights after dismiss: ${(e as Error).message}`);
    });
  }

  dismissDuplicatePair(id: string): void {
    this.duplicatePairs = this.duplicatePairs.filter(c => c.id !== id);
    this.vitality.invalidate();
  }

  /**
   * Resolve a needs-review pair from the Check-in deck.
   *
   * `merge`     — the user confirmed the two memories are the same fact.
   *               Soft-delete the lower-confidence node (the other
   *               survives). This is a user correction: op-logged and
   *               recoverable, but deliberately NOT written to the
   *               healing journal — that log is reserved for the brain's
   *               own autonomous heals, which are what the LLM review
   *               pass re-judges.
   * `keep-both` — the user judged them genuinely distinct. Just drop the
   *               pair from the needs-review queue.
   */
  async resolveDuplicatePair(id: string, action: 'merge' | 'keep-both'): Promise<void> {
    const c = this.duplicatePairs.find(x => x.id === id);
    if (!c) return;
    if (action === 'merge') {
      const nodes = this.host.listNodes(c.graphId);
      const a = nodes.find(n => n.id === c.nodeA);
      const b = nodes.find(n => n.id === c.nodeB);
      if (a && b) {
        const aWins =
          a.confidence > b.confidence ||
          (a.confidence === b.confidence && a.id < b.id);
        const supersededId = aWins ? b.id : a.id;
        try {
          await this.host.applyCorrection(c.graphId, {
            edits: [{
              kind: 'delete',
              nodeId: supersededId,
              reason: 'user-confirmed duplicate (Check-in review)',
            }],
          }, { triggeredBy: 'user:correct' });
        } catch (err) {
          console.error('[brain] resolveDuplicatePair merge failed:', err);
        }
      }
    }
    this.dismissDuplicatePair(id);
  }

  async runDevelop(params: {
    context: string;
    strategy: string;
    goals: string;
    graphIds?: string[];
  }): Promise<StrategicPlan> {
    const query = `${params.context} ${params.strategy} ${params.goals}`;
    const recalled = await withEmbedding(() => this.host.recall(query, {
      budget: { maxTokens: 3000, maxNodes: 30 },
      noLoadOnDemand: true, // background pass: search resident engrams only; never pull the whole cortex in
    }), 'brain:develop');

    const referencedNodeIds: string[] = [];
    for (const items of recalled.byGraph.values()) {
      for (const item of items) referencedNodeIds.push(item.nodeId);
    }

    let synthesis: string;
    if (this.llm && await this.pingLlm()) {
      synthesis = await this.llmCompleteWithTimeout({
        system: DEVELOP_SYSTEM_PROMPT,
        user: [
          `Context/Topic: ${params.context}`,
          `Strategy: ${params.strategy}`,
          `Goals: ${params.goals}`,
          '',
          'Relevant knowledge from your memory:',
          recalled.prompt.slice(0, 3000),
        ].join('\n'),
      });
    } else {
      synthesis =
        `_The Local LLM is not enabled, so this is the raw memory Graphnosis recalled — ` +
        `not a synthesized plan. Tell the user they can enable the Local LLM in Graphnosis ` +
        `(the "Go Non-Deterministic" tab) for a full strategic plan._\n\n---\n\n${recalled.prompt}`;
    }

    return {
      context: params.context,
      strategy: params.strategy,
      goals: params.goals,
      synthesisMarkdown: synthesis,
      referencedNodeIds,
      graphIds: params.graphIds ?? this.host.listGraphs(),
    };
  }

  async runPredict(params: {
    action: string;
    graphIds?: string[];
  }): Promise<PredictionResult> {
    const recalled = await withEmbedding(() => this.host.recall(params.action, {
      budget: { maxTokens: 2000, maxNodes: 20 },
      noLoadOnDemand: true, // background pass: search resident engrams only; never pull the whole cortex in
    }), 'brain:predict');

    const referencedNodeIds: string[] = [];
    for (const items of recalled.byGraph.values()) {
      for (const item of items) referencedNodeIds.push(item.nodeId);
    }

    if (!this.llm || !(await this.pingLlm())) {
      // No Local LLM — cannot synthesize a structured assessment. Hand back
      // the full recalled memory and flag it so the caller can tell the AI.
      return { risks: [], opportunities: [], recommendation: recalled.prompt, referencedNodeIds, degraded: true };
    }

    const raw = await this.llmCompleteWithTimeout({
      system: PREDICT_SYSTEM_PROMPT,
      user: [
        `Planned action: ${params.action}`,
        '',
        'Relevant memory:',
        recalled.prompt.slice(0, 2000),
      ].join('\n'),
      jsonSchema: { type: 'object' },
    });

    try {
      const parsed = extractJsonObj(raw) as {
        risks?: string[];
        opportunities?: string[];
        recommendation?: string;
      };
      return {
        risks: (parsed.risks ?? []).slice(0, 5),
        opportunities: (parsed.opportunities ?? []).slice(0, 5),
        recommendation: parsed.recommendation ?? '',
        referencedNodeIds,
      };
    } catch {
      return { risks: [], opportunities: [], recommendation: raw.slice(0, 300), referencedNodeIds };
    }
  }

  async ingestGoal(graphId: string, plan: StrategicPlan): Promise<string> {
    return this.goalTracker.ingestGoal(graphId, plan);
  }

  async listGoals() {
    return this.goalTracker.listGoals();
  }

  async computeVitality(): Promise<VitalityReport> {
    return this.vitality.compute(this.duplicatePairs.length);
  }

  /** Retrieval-quality Memory Health report — powers the Autonomous
   *  Indelibility tab's health ring. */
  async getMemoryHealth(): Promise<MemoryHealth> {
    return this.memoryHealth.compute();
  }

  /** Live cross-engram connection store — for the UI's cross-engram panel. */
  getCrossEngramConnections(): ReturnType<ReinforcementEngine['getCrossEngramConnections']> {
    return this.reinforcement.getCrossEngramConnections();
  }

  /** Trigger a Graphnosis Neural Network run (opt-in, non-deterministic).
   *  Fire-and-forget; gated internally by the settings toggle. */
  runNeuralNetworkNow(): void {
    void this.reinforcement.runNeuralNetwork();
  }

  /** Remove every neural-network-predicted edge — the live undo. */
  async removeNeuralNetworkEdges(): Promise<number> {
    return this.reinforcement.removeGnnEdges();
  }

  /**
   * Purge all in-memory references to a deleted engram. Call this immediately
   * after host.deleteGraph() so ghost edges don't survive until the next boot.
   */
  purgeDeletedGraph(graphId: string): void {
    this.reinforcement.purgeDeletedGraph(graphId);
  }

  /**
   * Purge in-memory connections and GNN edges anchored to soft-deleted nodes.
   * Call this immediately after host.forgetSource() returns its nodeIds.
   */
  purgeDeletedNodes(nodeIds: string[]): void {
    this.reinforcement.purgeDeletedNodes(nodeIds);
  }

  /** Neural-network state for the UI: on/off, predicted-edge count, last run. */
  getNeuralNetworkStatus(): {
    enabled: boolean;
    gnnEdgeCount: number;
    isRunning: boolean;
    lastRun: { at: number; edgesAdded: number; edgesPruned: number } | null;
  } {
    return {
      enabled: this.host.getSettings().brain?.neuralNetwork?.enabled === true,
      gnnEdgeCount: this.reinforcement.countGnnEdges(),
      isRunning: this.reinforcement.gnnRunning,
      lastRun: this.reinforcement.lastNeuralNetwork,
    };
  }

  /** Neural-network predicted edges (the `.gnn` overlay) — for the 3D
   *  Engram's toggleable prediction layer. Optionally scoped to one engram. */
  getPredictedEdges(graphId?: string): ReturnType<ReinforcementEngine['getPredictedEdges']> {
    const all = this.reinforcement.getPredictedEdges();
    return graphId ? all.filter((e) => e.graphId === graphId) : all;
  }

  /**
   * Interpret a Graphnosis subgraph context that has already been recalled.
   * Used by MemoryStudio's Local LLM panel — the LLM reads the exact same
   * context the user sees in the Raw Context panel instead of doing its own
   * separate recall, which prevents hallucination and keeps interpretation
   * grounded to what is displayed.
   */
  async interpretContext(
    rawContext: string,
    query: string,
    opts?: { task?: StudioQueryTask },
  ): Promise<string> {
    if (!this.llm || !(await this.pingLlm())) {
      return (
        `_The Local LLM is not enabled. Enable it in Graphnosis → Go Non-Deterministic → Local LLM._\n\n` +
        `_The Raw Context panel on the right shows the retrieved memory nodes._`
      );
    }
    return this.llmCompleteWithTimeout({
      system: STUDIO_INTERPRET_SYSTEM_PROMPT + shapePromptFor(opts?.task),
      user: `Query: ${query}\n\n${rawContext.slice(0, 4000)}`,
    }, 20_000);
  }

  /**
   * Run every scan loop once, back-to-back, for an on-demand full sweep —
   * e.g. when the user opens the Autonomous Brain tab or hits Refresh.
   * Emits a wrapping `fullscan` start/done frame so the UI can show one
   * unified "scanning" state; each sub-loop still emits its own phase
   * frames for the activity feed. Concurrent calls are coalesced: a second
   * trigger while a scan is in flight is a no-op.
   *
   * Temporal decay is deliberately excluded — it's an age-based daily
   * process, not a "scan", and re-running it on every tab open would be
   * noise. The background 24h timer still handles it.
   */
  /** True while the user has Low-power mode on — every autonomous pass stands
   *  down (the hard "stop heating my laptop" switch). Read live from settings so
   *  toggling takes effect immediately, no restart. */
  private lowPower(): boolean {
    return this.host.getSettings().brain?.lowPowerMode === true;
  }

  /** Single gate for every background brain pass: defer while an ingest is in
   *  flight (contention), the boot engram sweep is loading graphs from disk,
   *  a boot-throttled embedding-cache rebuild is still running, or Low-power
   *  mode is on (user opt-out). */
  private brainPassesPaused(): boolean {
    return isIngestActive()
      || this.host.isBootSweepActive()
      || this.host.isBootEmbBuildActive()
      || this.lowPower();
  }

  async runFullScan(opts: { skipLlmLoops?: boolean } = {}): Promise<void> {
    // Stand down entirely during boot sweep or ingest — manual "Scan now" and
    // the post-boot first scan both respect brainPassesPaused(). Periodic
    // timers re-run once the contention clears.
    if (this.brainPassesPaused()) return;
    if (this.scanInFlight) return;
    this.scanInFlight = true;
    this.emitBrain('__brain_start_fullscan__');
    try {
      await this.runDuplicateScan();
      // LLM-backed passes (synapse, insight) can stall on Ollama hangs and
      // each timeout costs 8-15 s × N engrams. Skipped during the post-boot
      // first scan so the very first sweep can't pin the CPU for minutes (the
      // original "fans spun up" symptom). The user's "Scan now" button DOES include
      // them — manual triggers express the user's intent to wait. And the
      // scheduled synapse/insight timers (45 min / 6 hr) still fire normally
      // so the boot-skip just defers the first LLM pass, doesn't disable it.
      if (!opts.skipLlmLoops) {
        await this.runSynapse();
        await this.runInsight();
      }
      await this.runGoalCheck();
      await this.reinforcement.runReinforcementPass();
      await this.reinforcement.runConsolidationPass();
      await this.reinforcement.runCrossEngramPass();
    } catch (err) {
      console.error('[brain] full scan error:', err);
    } finally {
      this.scanInFlight = false;
      this.firstScanComplete = true;
      this.emitBrain('__brain_done_fullscan__');
    }
  }

  /** Trigger a consolidation pass on demand — the "Run consolidation"
   *  button in the Deterministic Consolidation tab. Fire-and-forget; the pass
   *  emits its own start/done frames. */
  runConsolidationNow(): void {
    void this.reinforcement.runConsolidationPass();
  }

  /**
   * Trigger a cross-engram linking pass immediately — called after a source
   * moves between engrams so the re-ingested nodes get re-linked to other
   * engrams without waiting for the next background timer tick.
   * Fire-and-forget; the pass emits its own start/done frames.
   */
  runCrossEngramNow(): void {
    void this.reinforcement.runCrossEngramPass();
  }

  /** Snapshot for the UI's scan-status line: are we scanning, when did each
   *  loop last run, how often each loop runs, and aggregate stats. */
  getStatus(): {
    scanning: boolean;
    lastRun: Record<string, number>;
    intervals: Record<string, number>;
    lastDecayReport: { graphsProcessed: number; nodesDecayed: number } | null;
    sessionSynapsesFormed: number;
    sessionAutoLinksFormed: number;
    sessionReinforced: number;
    sessionConnectionsFormed: number;
    sessionInferred: number;
    sessionEdgesCleaned: number;
    sessionCrossEngram: number;
    lastConsolidation: { at: number; inferredEdges: number; communities: number; edgesCleaned: number } | null;
    lastInsightResult: {
      at: number;
      status: 'ok' | 'no-llm' | 'no-data' | 'timeout' | 'parse-error' | 'error';
      count: number;
      message?: string;
    } | null;
  } {
    const brain = this.host.getSettings().brain;
    return {
      scanning: this.scanInFlight,
      lastRun: { ...(brain?.lastRun ?? {}) },
      lastInsightResult: brain?.lastInsightResult ?? null,
      intervals: {
        duplicateScan: DUPLICATE_SCAN_INTERVAL_MS,
        synapse: SYNAPSE_INTERVAL_MS,
        insight: INSIGHT_INTERVAL_MS,
        temporalDecay: TEMPORAL_INTERVAL_MS,
        goalCheck: GOAL_CHECK_INTERVAL_MS,
        reinforce: REINFORCE_INTERVAL_MS,
        crossEngram: CROSS_ENGRAM_INTERVAL_MS,
        consolidation:
          (this.host.getSettings().brain?.reinforcement?.consolidationIntervalHours ?? 24)
          * 60 * 60 * 1000,
      },
      lastDecayReport: this.lastDecayReport,
      sessionSynapsesFormed: this.sessionSynapsesFormed,
      sessionAutoLinksFormed: this.sessionAutoLinksFormed,
      sessionReinforced: this.reinforcement.sessionReinforced,
      sessionConnectionsFormed: this.reinforcement.sessionConnectionsFormed,
      sessionInferred: this.reinforcement.sessionInferred,
      sessionEdgesCleaned: this.reinforcement.sessionEdgesCleaned,
      sessionCrossEngram: this.reinforcement.sessionCrossEngram,
      lastConsolidation: this.reinforcement.lastConsolidation,
    };
  }

  // ── Private loop implementations ──────────────────────────────────────────

  /** Rotating slot into the "cold" (least-recently-mutated) engrams, so that
   *  on a large cortex every engram is eventually scanned across cycles even
   *  though only a capped subset is touched per cycle. */
  private duplicateScanCursor = 0;

  /** Choose which engrams this duplicate-scan cycle will touch. Small cortex:
   *  all of them (unchanged). Large cortex: the (cap-1) most-recently-mutated
   *  engrams — where new duplicates actually land — plus ONE rotating cold
   *  engram, so the long tail is still covered over successive cycles without
   *  ever holding every engram's embedding working set hot at once (the OOM /
   *  swap cause on the stress cortex). */
  private selectDuplicateScanEngrams<T extends string>(all: T[]): T[] {
    if (all.length <= MAX_SCAN_ENGRAMS_PER_CYCLE) return all;
    const lastMut = this.host.getMutationCursor() as Record<string, number>;
    const byRecency = [...all].sort((a, b) => (lastMut[b] ?? 0) - (lastMut[a] ?? 0));
    const hot = byRecency.slice(0, MAX_SCAN_ENGRAMS_PER_CYCLE - 1);
    const cold = byRecency.slice(MAX_SCAN_ENGRAMS_PER_CYCLE - 1);
    const pick = cold[this.duplicateScanCursor % cold.length]!;
    this.duplicateScanCursor = (this.duplicateScanCursor + 1) % cold.length;
    return [...hot, pick];
  }

  private async runDuplicateScan(): Promise<void> {
    // The scan is genuinely expensive now — never let two overlap.
    if (this.duplicateScanRunning) return;
    // Backpressure: defer while AI/UI clients are actively using the sidecar, so
    // recalls and the UI keep the single-threaded loop. Retry once they're idle.
    if (clientActiveWithin(CLIENT_QUIET_MS) || this.brainPassesPaused()) {
      this.deferUntilBrainReady(() => { void this.runDuplicateScan(); });
      return;
    }
    this.duplicateScanRunning = true;
    this.emitActivity('duplicate-scan', 'start');
    // `found` = pairs that need human judgment (→ Check-in deck).
    // `healActions` = pairs the brain will auto-heal (→ healing journal).
    const found: DuplicatePair[] = [];
    const healActions: HealAction[] = [];
    // Auto-link tier: per-run budget + tally for the related-edge weaving.
    let autoLinkBudget = MAX_AUTOLINKS_PER_RUN;
    let autoLinkedThisRun = 0;
    const now = Date.now();
    const yieldToLoop = (): Promise<void> =>
      new Promise<void>((resolve) => setImmediate(resolve));

    try {
      for (const graphId of this.selectDuplicateScanEngrams(this.host.listGraphs())) {
        try {
          const nodes = this.host.listNodes(graphId);
          const active = nodes
            .filter(n =>
              n.confidence > 0.2 &&
              (n.validUntil === undefined || n.validUntil > now) &&
              n.nodeType !== 'document' &&
              n.nodeType !== 'section' &&
              n.contentPreview.length > 20,
            )
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, MAX_DUPLICATE_SCAN_NODES);
          if (active.length < 2) continue;

          const nodeById = new Map(active.map(n => [n.id, n]));
          const allEmbs = this.host.getNodeEmbeddings(graphId);
          // Restrict to active, content-bearing nodes that actually have a
          // vector — embeddings live in a separate index, see
          // graphnosis-impl.getNodeEmbeddings.
          const embs = new Map<string, number[]>();
          for (const n of active) {
            const v = allEmbs.get(n.id);
            if (v) embs.set(n.id, v);
          }
          if (embs.size < 2) continue;

          // Pre-index already-known pairs (O(1) dedup) and already-paired
          // nodes. `usedNodes` enforces "each node appears in at most one
          // duplicate-pair card" — without it, a cluster of near-duplicate
          // memories (e.g. an RSS feed re-ingested over time) yields
          // hundreds of pairs all pivoting on the same handful of nodes.
          const knownKeys = new Set<string>();
          const usedNodes = new Set<string>();
          for (const c of this.duplicatePairs) {
            if (c.graphId === graphId) {
              knownKeys.add(c.nodeA < c.nodeB
                ? `${c.nodeA}|${c.nodeB}` : `${c.nodeB}|${c.nodeA}`);
              usedNodes.add(c.nodeA);
              usedNodes.add(c.nodeB);
            }
          }

          // LSH similarity search — exhaustive across every embedded node
          // in the engram, ~O(n) instead of a brute O(n²) sweep. One pass
          // feeds two tiers: pairs ≥ DUPLICATE_MIN_SIM are duplicate
          // candidates (auto-heal or needs-review); pairs in the lower
          // [AUTOLINK_MIN_SIM, DUPLICATE_MIN_SIM) band are "related, not
          // duplicate" — the brain weaves an edge between them.
          // The band is half-open [minSim, maxSim); maxSim is 1.01 so
          // byte-identical pairs at cosine ~1.0 (± float error) are caught.
          const pairs = await findSimilarPairs(embs, {
            minSim: AUTOLINK_MIN_SIM,
            maxSim: 1.01,
            onYield: yieldToLoop,
          });
          // Strongest matches first: the greedy per-node caps below keep
          // the most likely-genuine pairing / closest auto-links when a
          // node could pair with several neighbours.
          pairs.sort((p1, p2) => p2.similarity - p1.similarity);

          // Edge degree per node — the auto-link tier skips nodes that are
          // already well-connected (see AUTOLINK_DEGREE_CAP).
          const edges = this.host.listEdges(graphId);
          const degree = new Map<string, number>();
          for (const e of edges.directed) {
            degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
            degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
          }
          for (const e of edges.undirected) {
            degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
            degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
          }
          const autoLinkCount = new Map<string, number>();
          const linkEdges: Array<{ a: string; b: string; similarity: number }> = [];

          let pairIdx = 0;
          for (const pair of pairs) {
            // Keep the UI's IPC responsive during a large near-duplicate set
            // (a re-ingested corpus can produce tens of thousands of pairs).
            if ((pairIdx++ & 2047) === 0) await yieldToLoop();
            const a = nodeById.get(pair.idA);
            const b = nodeById.get(pair.idB);
            if (!a || !b) continue;

            if (pair.similarity < DUPLICATE_MIN_SIM) {
              // ── Auto-link band: semantically close but NOT a duplicate.
              // Weave an undirected "related" edge — unless the run budget
              // is spent or either node is already edge-dense.
              if (autoLinkBudget <= 0) continue;
              const degA = (degree.get(a.id) ?? 0) + (autoLinkCount.get(a.id) ?? 0);
              const degB = (degree.get(b.id) ?? 0) + (autoLinkCount.get(b.id) ?? 0);
              if (degA >= AUTOLINK_DEGREE_CAP || degB >= AUTOLINK_DEGREE_CAP) continue;
              linkEdges.push({ a: a.id, b: b.id, similarity: pair.similarity });
              autoLinkCount.set(a.id, (autoLinkCount.get(a.id) ?? 0) + 1);
              autoLinkCount.set(b.id, (autoLinkCount.get(b.id) ?? 0) + 1);
              autoLinkBudget -= 1;
              continue;
            }

            // ── Duplicate band — one pairing per node, skip if used.
            if (usedNodes.has(a.id) || usedNodes.has(b.id)) continue;
            const dedupKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
            if (knownKeys.has(dedupKey)) continue;
            // Node previews are often raw HTML (web-clipped / RSS memories);
            // strip it so both the review card and the journal snapshot
            // show readable text.
            const snippetA = cleanSnippet(a.contentPreview);
            const snippetB = cleanSnippet(b.contentPreview);
            if (!snippetA || !snippetB) continue;
            knownKeys.add(dedupKey);
            usedNodes.add(a.id);
            usedNodes.add(b.id);

            // Classify: can the brain heal this pair autonomously (provably
            // no information loss), or does it need a human judgment call?
            const verdict = classifyHealingPair(a, b, snippetA, snippetB);
            if (verdict.bucket === 'needs-review') {
              found.push({
                id: randomUUID(),
                graphId,
                nodeA: a.id,
                nodeB: b.id,
                snippetA: snippetA.slice(0, 140),
                snippetB: snippetB.slice(0, 140),
                similarity: pair.similarity,
                detectedAt: now,
              });
            } else {
              healActions.push({
                graphId,
                survivorId: verdict.survivorId,
                supersededId: verdict.supersededId,
                survivorContent: verdict.survivorContent,
                supersededContent: verdict.supersededContent,
                rule: verdict.rule,
                similarity: pair.similarity,
                decisionReason: verdict.decisionReason,
              });
            }
          }

          // Weave this graph's auto-link edges in one batched save. Edges
          // don't touch nodes or embeddings, so this is safe mid-loop —
          // unlike the heals below, which delete nodes and are deferred.
          if (linkEdges.length > 0) {
            try {
              const woven = await this.host.linkNodesBatch(
                graphId,
                linkEdges.map((e) => ({
                  a: e.a,
                  b: e.b,
                  reason: `brain:auto-link (${Math.round(e.similarity * 100)}% similar)`,
                })),
              );
              this.sessionAutoLinksFormed += woven;
              autoLinkedThisRun += woven;
            } catch (err) {
              console.error(`[brain] auto-link failed on engram[${redactId(graphId)}]:`, err);
            }
          }
        } catch (err) {
          // A graph can be deleted/unloaded mid-scan (user deletes an engram,
          // or — once index eviction lands — the LRU frees a cold one) in the
          // async gap between this loop's listNodes and its later listEdges.
          // That surfaces as "Graph not loaded" from must(); it's a benign
          // race, not a scan fault — skip this engram quietly and move on.
          const msg = err instanceof Error ? err.message : String(err);
          if (/Graph not loaded/i.test(msg)) {
            dbg(`[brain] duplicate scan skipped engram[${redactId(graphId)}] — unloaded mid-scan`);
          } else {
            console.error(`[brain] duplicate scan error on engram[${redactId(graphId)}]:`, err);
          }
        }
        await yieldToLoop();
      }

      // Execute the autonomous heals AFTER the scan loop completes —
      // applyCorrection mutates the graph, which would invalidate the
      // nodeById map + embedding snapshots we iterated above.
      let healedCount = 0;
      for (const act of healActions) {
        try {
          await this.runAutoHeal(act);
          healedCount += 1;
        } catch (err) {
          console.error(`[brain] auto-heal failed for ${act.supersededId}:`, err);
        }
        await yieldToLoop();
      }
      if (healedCount > 0) {
        // One journal write per scan run, not one per heal.
        try {
          await this.host.saveHealingJournal(this.healingJournal);
        } catch (err) {
          console.error('[brain] healing journal save failed:', err);
        }
        // Per-cycle background sweep summary — debug-only.
        dbg(`[brain] autonomously healed ${healedCount} duplicate(s)`);
      }
      if (autoLinkedThisRun > 0) {
        this.emitActivity('auto-link', 'done');
        dbg(`[brain] auto-linked ${autoLinkedThisRun} related memory pair(s)`);
      }

      this.duplicatePairs.push(...found);
      // Keep the needs-review list bounded — highest-similarity pairs
      // first, since those are the most likely genuine same-fact pairs.
      if (this.duplicatePairs.length > MAX_DUPLICATE_PAIRS_STORED) {
        this.duplicatePairs.sort((a, b) => b.similarity - a.similarity);
        this.duplicatePairs = this.duplicatePairs.slice(0, MAX_DUPLICATE_PAIRS_STORED);
      }
      this.vitality.invalidate();
      await this.persistLastRun('duplicateScan');
      // First duplicate scan done — getVitalityReport now uses live data
      // instead of the cached previous-session score.
      this.firstDuplicateScanComplete = true;
    } finally {
      this.duplicateScanRunning = false;
    }
    this.emitActivity('duplicate-scan', 'done');
    await this.emitVitality();
    // Second-opinion pass over past auto-heals. A no-op unless a local
    // LLM is wired up, so it's cheap to call unconditionally here — the
    // scan is what produces new heal records, so reviewing at its tail
    // keeps the cadence aligned without a separate timer.
    await this.runHealingReview();
  }

  /**
   * Execute one autonomous heal: soft-delete the superseded (duplicate)
   * node and append a record to the healing journal.
   *
   * The delete goes through `host.applyCorrection` with `kind: 'delete'`,
   * which soft-deletes (confidence → 0.1, validUntil → now) and op-logs a
   * `deleteNode` event — fully recoverable from the Recovery panel. The
   * survivor is left untouched.
   *
   * This appends to the in-memory journal only; the caller batches the
   * single `saveHealingJournal` write per scan run.
   */
  private async runAutoHeal(act: HealAction): Promise<void> {
    await this.host.applyCorrection(act.graphId, {
      edits: [{
        kind: 'delete',
        nodeId: act.supersededId,
        reason: `autonomous-healing (${act.rule}): ${act.decisionReason}`,
      }],
    }, { triggeredBy: 'brain:consolidation' });
    this.healingJournal.push(makeHealingRecord({
      graphId: act.graphId,
      healedAt: Date.now(),
      similarity: act.similarity,
      rule: act.rule,
      survivingNodeId: act.survivorId,
      supersededNodeId: act.supersededId,
      survivingContentSnapshot: act.survivorContent,
      supersededContentSnapshot: act.supersededContent,
      decisionReason: act.decisionReason,
    }));
    this.emitActivity('auto-heal', 'done');
  }

  /**
   * The autonomous-healing second-opinion pass.
   *
   * Future-facing: this does real work ONLY when a local LLM is wired
   * up. Until then every deterministic auto-heal simply accumulates an
   * un-reviewed record in the healing journal — exactly the design
   * intent ("eventually-consistent intelligence": heal fast now with
   * provably-safe rules, upgrade the decisions when smarter capability
   * arrives).
   *
   * When an LLM IS available, this walks the oldest un-reviewed heal
   * records and asks the model to re-judge the *exact* inputs the
   * deterministic rule saw — both content snapshots are frozen in the
   * record. The model can confirm the call, flip it (`reversed`), undo
   * it as a false positive (`unmerged` → the pair is restored and sent
   * to the Check-in deck), or rewrite a cleaner combined memory
   * (`resynthesized`).
   *
   * Rides on `runDuplicateScan` rather than a timer of its own: the
   * scan is what produces new heal records, so reviewing at its tail
   * keeps the cadence aligned with no extra moving parts.
   */
  private async runHealingReview(): Promise<void> {
    const llm = this.llm;
    if (!llm) return;                       // no local model — nothing to do
    if (!this.healingJournalLoaded) return; // journal still loading off-disk
    const pending = this.healingJournal.filter((r) => !r.llmReviewed);
    if (pending.length === 0) return;
    if (this.healingReviewRunning) return;
    if (!(await this.pingLlm())) return;    // model configured but unreachable

    this.healingReviewRunning = true;
    this.emitActivity('healing-review', 'start');
    const yieldToLoop = (): Promise<void> =>
      new Promise<void>((resolve) => setImmediate(resolve));
    let reviewed = 0;
    let overturned = 0;
    try {
      for (const record of pending.slice(0, MAX_HEALING_REVIEWS_PER_RUN)) {
        try {
          const result = await this.reviewOneHeal(llm, record);
          record.llmReviewed = true;
          record.llmVerdict = result.verdict;
          record.llmReviewedAt = Date.now();
          if (result.note) record.llmNote = result.note;
          reviewed += 1;
          if (result.verdict !== 'confirmed') overturned += 1;
        } catch (err) {
          // Leave llmReviewed false so this record is retried next run.
          console.error(`[brain] healing review failed for ${record.id}:`, err);
        }
        await yieldToLoop();
      }

      if (reviewed > 0) {
        try {
          await this.host.saveHealingJournal(this.healingJournal);
        } catch (err) {
          console.error('[brain] healing journal save failed after review:', err);
        }
        console.log(
          `[brain] healing review: ${reviewed} record(s) re-judged, ${overturned} overturned`,
        );
      }
    } finally {
      this.healingReviewRunning = false;
    }

    this.emitActivity('healing-review', 'done');
    if (overturned > 0) {
      // An overturned heal mutated the graph (and maybe the Check-in
      // deck) — refresh vitality so the UI reflects the change.
      await this.emitVitality();
    }
  }

  /**
   * Ask the local LLM for a second opinion on one past auto-heal and
   * apply its verdict. Returns the verdict + an optional note for the
   * caller to write back onto the journal record.
   *
   * Robust against a stale record: if the engram is gone, or the
   * survivor node is no longer present/active (the user deleted it, or a
   * later heal superseded it), there is nothing left to re-judge — we
   * record `confirmed` with an explanatory note and skip the LLM call.
   */
  private async reviewOneHeal(
    llm: LocalLlm,
    record: HealingRecord,
  ): Promise<{ verdict: HealingLlmVerdict; note?: string }> {
    // Engram still exists?
    if (!this.host.listGraphs().includes(record.graphId)) {
      return {
        verdict: 'confirmed',
        note: 'engram no longer exists — original heal left as-is',
      };
    }
    // Survivor still in the graph and active?
    const now = Date.now();
    const survivor = this.host
      .listNodes(record.graphId)
      .find((n) => n.id === record.survivingNodeId);
    const survivorActive =
      survivor !== undefined &&
      survivor.confidence > 0.2 &&
      (survivor.validUntil === undefined || survivor.validUntil > now);
    if (!survivorActive) {
      return {
        verdict: 'confirmed',
        note: 'survivor node is no longer in the graph — original heal left as-is',
      };
    }

    const raw = await llm.complete({
      system: HEALING_REVIEW_SYSTEM_PROMPT,
      user: [
        `Rule that fired: ${record.rule}`,
        `Rule's stated reason: ${record.decisionReason}`,
        `Embedding similarity: ${record.similarity.toFixed(3)}`,
        '',
        'SURVIVOR (the node that was kept):',
        record.survivingContentSnapshot,
        '',
        'SUPERSEDED (the node that was removed):',
        record.supersededContentSnapshot,
        '',
        'Was this de-duplication correct?',
      ].join('\n'),
      jsonSchema: { type: 'object' },
    });

    const parsed = extractJsonObj(raw) as {
      verdict?: string;
      note?: string;
      combinedText?: string;
    };
    const note =
      typeof parsed.note === 'string' && parsed.note.trim().length > 0
        ? parsed.note.trim().slice(0, 300)
        : undefined;
    const combinedText =
      typeof parsed.combinedText === 'string' ? parsed.combinedText.trim() : '';

    switch (parsed.verdict) {
      case 'reversed':
        // Merge stands, but the rule kept the wrong node. Supersede the
        // survivor with the superseded content: the survivor is soft-
        // deleted, a new node carries the content that should have won,
        // and `supersede` preserves the audit lineage.
        await this.host.applyCorrection(record.graphId, {
          edits: [{
            kind: 'supersede',
            nodeId: record.survivingNodeId,
            content: record.supersededContentSnapshot,
            reason: `healing-review: reversed (heal ${record.id})`,
          }],
        }, { triggeredBy: 'brain:consolidation' });
        return { verdict: 'reversed', note: note ?? 'deterministic rule kept the wrong node' };

      case 'resynthesized': {
        if (combinedText.length === 0) {
          // Can't resynthesize without replacement text — treat as a
          // confirm so the record isn't retried forever.
          return {
            verdict: 'confirmed',
            note: 'LLM proposed a resynthesis but returned no combined text',
          };
        }
        await this.host.applyCorrection(record.graphId, {
          edits: [{
            kind: 'supersede',
            nodeId: record.survivingNodeId,
            content: combinedText,
            reason: `healing-review: resynthesized (heal ${record.id})`,
          }],
        }, { triggeredBy: 'brain:consolidation' });
        return { verdict: 'resynthesized', note: note ?? 'rewrote a cleaner combined memory' };
      }

      case 'unmerged': {
        // False-positive merge: the two memories are genuinely distinct.
        // Re-introduce the superseded content as a live node and hand the
        // pair to the Check-in deck for human judgment. While that review
        // card is live, runDuplicateScan's knownKeys / usedNodes
        // dedup keeps the deterministic rule from simply re-merging it on
        // the next sweep.
        const restoredIds = await this.host.addLooseContent(
          record.graphId,
          record.supersededContentSnapshot,
          `healing-review:unmerged:${record.id}`,
        );
        const restoredId = restoredIds[0];
        if (restoredId !== undefined) {
          this.duplicatePairs.push({
            id: randomUUID(),
            graphId: record.graphId,
            nodeA: record.survivingNodeId,
            nodeB: restoredId,
            snippetA: record.survivingContentSnapshot.slice(0, 140),
            snippetB: record.supersededContentSnapshot.slice(0, 140),
            similarity: record.similarity,
            detectedAt: Date.now(),
          });
          if (this.duplicatePairs.length > MAX_DUPLICATE_PAIRS_STORED) {
            this.duplicatePairs.sort((a, b) => b.similarity - a.similarity);
            this.duplicatePairs = this.duplicatePairs.slice(0, MAX_DUPLICATE_PAIRS_STORED);
          }
          this.vitality.invalidate();
        }
        return {
          verdict: 'unmerged',
          note: note ?? 'not a true duplicate — restored and sent to Check-in',
        };
      }

      case 'confirmed':
        return note !== undefined ? { verdict: 'confirmed', note } : { verdict: 'confirmed' };

      default:
        return {
          verdict: 'confirmed',
          note: `LLM returned an unrecognized verdict (${String(parsed.verdict)}) — heal left unchanged`,
        };
    }
  }

  private async runSynapse(): Promise<void> {
    if (!this.llm) return;
    if (!(await this.pingLlm())) return;

    this.emitActivity('synapse', 'start');
    let totalNewEdges = 0;
    const now = Date.now();
    // Bail the pass after MAX_CONSECUTIVE_LLM_TIMEOUTS timeouts in a row —
    // Ollama is clearly wedged and the remaining engrams would each cost
    // another 8s of pegged CPU for no benefit. The next scheduled tick
    // (45 min later) will retry from scratch.
    let consecutiveTimeouts = 0;

    for (const graphId of this.host.listGraphs()) {
      if (totalNewEdges >= MAX_SYNAPSE_EDGES_PER_RUN) break;
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_LLM_TIMEOUTS) {
        console.error(`[brain] synapse: bailing after ${consecutiveTimeouts} consecutive LLM timeouts — Ollama wedged. Will retry next cycle.`);
        break;
      }
      try {
        const nodes = this.host.listNodes(graphId);
        const active = nodes.filter(n =>
          n.confidence > 0.2 &&
          (n.validUntil === undefined || n.validUntil > now) &&
          n.nodeType !== 'document' &&
          n.nodeType !== 'section',
        );
        if (active.length < 3) continue;

        const edges = this.host.listEdges(graphId);
        const degree = new Map<string, number>();
        for (const e of edges.directed) {
          degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
          degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
        }
        for (const e of edges.undirected) {
          degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
          degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
        }

        const candidates = active
          .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
          .slice(0, 10);

        const nodesList = candidates
          .map(n => `- [${n.id}] ${n.contentPreview.slice(0, 120)}`)
          .join('\n');

        let raw: string;
        try {
          raw = await this.llmCompleteWithTimeout({
            system: SYNAPSE_SYSTEM_PROMPT,
            user: `Nodes from engram "${graphId}":\n${nodesList}\n\nWhich pairs share a deep conceptual relationship?`,
            jsonSchema: { type: 'array' },
          }, SYNAPSE_INSIGHT_TIMEOUT_MS);
          // Successful call — reset the consecutive-timeout counter.
          consecutiveTimeouts = 0;
        } catch (err) {
          // Distinguish a timeout (our explicit "LLM call exceeded …ms") from
          // a parse/network error — only timeouts trigger the bail counter,
          // because they cost a full timeout window of wasted compute. Other
          // errors are usually instant and benign.
          if ((err as Error).message?.includes('LLM call exceeded')) {
            consecutiveTimeouts++;
          }
          throw err;
        }

        let pairs: Array<{ fromNodeId: string; toNodeId: string; reasoning: string }> = [];
        try { pairs = JSON.parse(extractJsonArr(raw)) as typeof pairs; } catch { continue; }

        const activeIds = new Set(active.map(n => n.id));
        for (const pair of pairs.slice(0, MAX_SYNAPSE_EDGES_PER_RUN - totalNewEdges)) {
          if (!activeIds.has(pair.fromNodeId) || !activeIds.has(pair.toNodeId)) continue;
          if (pair.fromNodeId === pair.toNodeId) continue;
          try {
            const result = await this.host.linkNodesDirected(
              graphId,
              pair.fromNodeId,
              pair.toNodeId,
              { type: 'supports', evidence: `brain-synapse: ${pair.reasoning.slice(0, 200)}` },
            );
            if (result.created) {
              totalNewEdges++;
              this.sessionSynapsesFormed++;
              this.emitBrain('__brain_synapse__');
            }
          } catch { /* single edge failure is non-fatal */ }
        }
      } catch (err) {
        console.error(`[brain] synapse error on engram[${redactId(graphId)}]:`, err);
      }
    }

    this.vitality.invalidate();
    await this.persistLastRun('synapse');
    this.emitActivity('synapse', 'done');
    await this.emitVitality();
  }

  /**
   * Local-LLM edge prediction loop. Self-gates on `llmCapabilities.edgePrediction`
   * (default OFF). Picks one engram per tick in round-robin order so LLM
   * cost stays bounded — a cortex with 12 engrams takes 12 hours to cover
   * all of them once at the default 60-min cadence. New predictions land
   * in the `.gll` overlay for the user to review.
   *
   * Idempotent: predicted edges that already exist in `.gll` are filtered
   * out by `predictEdgesForEngram` before the LLM is asked.
   */
  async runEdgePrediction(): Promise<void> {
    if (!this.llm) return;
    if (!edgePredictionEnabled(this.host)) return;
    // Backpressure: defer while clients are active (GNN prediction + LSH scan is
    // heavy); retry once the sidecar is idle.
    if (clientActiveWithin(CLIENT_QUIET_MS) || this.brainPassesPaused()) {
      this.deferUntilBrainReady(() => { void this.runEdgePrediction(); });
      return;
    }
    // ── Pro gate: the autonomous edge-prediction loop is GNN-Exploration ──
    // territory. Unlicensed users get the deterministic recall pipeline
    // for free; the autonomous loop that writes inferred edges to the
    // `.gll` overlay requires Pro. Silent skip preserves the schedule
    // across subscription gaps — re-licensing resumes prediction.
    if (this.licenseValidator) {
      const token = await this.host.getLicenseToken();
      if (!this.licenseValidator.hasFeature(token, 'gnn-exploration')) return;
    }
    if (!(await this.pingLlm())) return;
    const graphIds = this.host.listGraphs();
    if (graphIds.length === 0) return;
    const graphId = graphIds[this.edgePredictionCursor % graphIds.length]!;
    this.edgePredictionCursor = (this.edgePredictionCursor + 1) % graphIds.length;
    this.emitActivity('edge-prediction', 'start');
    try {
      const { candidatesScanned, predicted } = await predictEdgesForEngram(this.host, this.llm, graphId);
      // Per-engram, per-cycle prediction stats — debug-only (was firing
      // every few minutes for every engram in the cortex).
      dbg(`[brain] edge-prediction on engram[${redactId(graphId)}]: scanned=${candidatesScanned}, predicted=${predicted.length}`);
      this.emitActivity('edge-prediction', 'done');
      if (predicted.length > 0) {
        // Surface freshly-predicted edges as a brain event so the UI can
        // refresh the review queue without polling.
        this.emitBrain(graphId);
      }
    } catch (e) {
      console.error(`[brain] edge-prediction failed on engram[${redactId(graphId)}]: ${(e as Error).message}`);
      this.emitActivity('edge-prediction', 'done');
    }
  }

  private async runInsight(): Promise<void> {
    // Track the outcome of THIS run for the diagnostic stored in
    // settings.brain.lastInsightResult — the Insights tab reads this to
    // render an honest empty-state ("Last scan: timed out — try a smaller
    // model") instead of generic "No insights yet" forever.
    let status: 'ok' | 'no-llm' | 'no-data' | 'timeout' | 'parse-error' | 'error' = 'ok';
    let message: string | undefined;
    let newInsightsThisRun = 0;
    const writeDiagnostic = async (count: number): Promise<void> => {
      try {
        const current = this.host.getSettings();
        await this.host.setSettings({
          brain: {
            ...current.brain,
            lastInsightResult: {
              at: Date.now(),
              status,
              count,
              ...(message ? { message } : {}),
            },
          },
        });
      } catch { /* non-fatal */ }
    };

    if (!this.llm) {
      status = 'no-llm';
      message = 'No local LLM configured at sidecar startup.';
      await writeDiagnostic(0);
      return;
    }
    if (!(await this.pingLlm())) {
      status = 'no-llm';
      message = 'Local LLM is disabled or Ollama is unreachable.';
      await writeDiagnostic(0);
      return;
    }

    // Wait until the boot load has settled so we don't overwrite persisted
    // insights with an empty in-memory list. In practice the 6-hour first-run
    // delay makes this a no-op, but defensive against manual "Scan now" fires.
    if (!this.insightsLoaded) {
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (this.insightsLoaded) { clearInterval(poll); resolve(); }
        }, 50);
      });
    }

    this.emitActivity('insight', 'start');
    let consecutiveTimeouts = 0;
    let engramsScanned = 0;
    let engramsSkippedNoData = 0;
    let parseFailures = 0;

    for (const graphId of this.host.listGraphs()) {
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_LLM_TIMEOUTS) {
        console.error(`[brain] insight: bailing after ${consecutiveTimeouts} consecutive LLM timeouts — Ollama wedged. Will retry next cycle.`);
        status = 'timeout';
        message = `Bailed after ${consecutiveTimeouts} consecutive LLM timeouts. Try a smaller / faster Ollama model.`;
        break;
      }
      try {
        const topNodes = await withEmbedding(() => this.host.searchNodes(
          graphId,
          'important facts decisions goals plans key information',
          30,
        ), 'brain:insight');
        if (topNodes.length < 5) {
          engramsSkippedNoData++;
          continue;
        }
        engramsScanned++;

        const nodesList = topNodes
          .map(n => `- [${n.nodeId}] ${n.text.slice(0, 200)}`)
          .join('\n');

        let raw: string;
        try {
          raw = await this.llmCompleteWithTimeout({
            system: INSIGHT_SYSTEM_PROMPT,
            user: `Nodes from engram "${graphId}":\n${nodesList}\n\nWhat patterns, gaps, or opportunities are noteworthy?`,
            jsonSchema: { type: 'array' },
          }, SYNAPSE_INSIGHT_TIMEOUT_MS);
          consecutiveTimeouts = 0;
        } catch (err) {
          if ((err as Error).message?.includes('LLM call exceeded')) {
            consecutiveTimeouts++;
          }
          throw err;
        }

        let parsedInsights: Array<{
          kind: string;
          title: string;
          body: string;
          relevantNodeIds: string[];
        }> = [];
        try {
          parsedInsights = JSON.parse(extractJsonArr(raw)) as typeof parsedInsights;
        } catch {
          parseFailures++;
          continue;
        }

        const activeIds = new Set(topNodes.map(n => n.nodeId));
        for (const item of parsedInsights.slice(0, 3)) {
          const kind = item.kind as Insight['kind'];
          if (!['pattern', 'gap', 'opportunity', 'conflict'].includes(kind)) continue;
          this.insights.unshift({
            id: randomUUID(),
            graphId,
            kind,
            title: String(item.title ?? 'Insight').slice(0, 80),
            body: String(item.body ?? '').slice(0, 400),
            relevantNodeIds: (item.relevantNodeIds ?? []).filter(
              (id: string) => typeof id === 'string' && activeIds.has(id),
            ),
            createdAt: Date.now(),
          });
          newInsightsThisRun++;
        }
      } catch (err) {
        console.error(`[brain] insight error on engram[${redactId(graphId)}]:`, err);
      }
    }

    // Triage the run outcome for the diagnostic. Order matters: a timeout
    // bail overrides downstream success/no-data heuristics; otherwise we
    // pick the most informative non-ok status.
    if (status !== 'timeout') {
      if (engramsScanned === 0 && engramsSkippedNoData > 0) {
        status = 'no-data';
        message = `All ${engramsSkippedNoData} engram(s) had fewer than 5 high-signal nodes — nothing to summarise yet. Save more memories first.`;
      } else if (newInsightsThisRun === 0 && parseFailures > 0) {
        status = 'parse-error';
        message = `LLM responded but ${parseFailures} engram(s) returned unparseable output. Try a more capable Ollama model (e.g. llama3.1:8b or larger).`;
      } else if (newInsightsThisRun === 0 && engramsScanned > 0) {
        // The LLM ran and parsed fine but didn't surface anything notable.
        // That's not a failure — it just means your memory is balanced.
        status = 'ok';
        message = `Scanned ${engramsScanned} engram(s); the LLM didn't surface anything noteworthy this round.`;
      }
    }

    // Keep only the most recent non-dismissed insights
    this.insights = this.insights.filter(i => !i.dismissed).slice(0, MAX_INSIGHTS_STORED);
    const pendingCount = this.insights.length;

    await this.persistLastRun('insight');
    await this.persistInsightCount(pendingCount);
    await writeDiagnostic(newInsightsThisRun);
    await this.host.saveInsights(this.insights).catch((e) => {
      console.error(`[brain] failed to save insights: ${(e as Error).message}`);
    });
    this.emitActivity('insight', 'done');

    if (pendingCount > 0) {
      this.emitBrain('__brain_done_insight__');
    }

    // If THIS run failed transiently (timeout / parse-error / no-llm), schedule
    // a faster retry at 1h instead of waiting the full 6h. Only one retry is
    // pending at a time — we clear any prior retry timer before arming a new one.
    // Note: 'no-llm' returns early above, so it can't reach here — narrowed out by control flow.
    if (status === 'timeout' || status === 'parse-error') {
      if (this.insightRetryTimer) clearTimeout(this.insightRetryTimer);
      this.insightRetryTimer = setTimeout(() => {
        this.insightRetryTimer = null;
        void this.runInsight();
      }, INSIGHT_RETRY_AFTER_FAILURE_MS).unref();
      // Periodic retry-scheduling status — debug-only.
      dbg(`[brain] insight: ${status} — will retry in ${Math.round(INSIGHT_RETRY_AFTER_FAILURE_MS / 60000)}m`);
    }
  }

  private async runTemporalDecay(): Promise<void> {
    if (this.brainPassesPaused()) return;
    this.emitActivity('temporal', 'start');
    try {
      const report = await this.temporalEngine.runDecay();
      this.lastDecayReport = { graphsProcessed: report.graphsProcessed, nodesDecayed: report.nodesDecayed };
    } catch (err) {
      console.error('[brain] temporal decay error:', err);
    }
    this.vitality.invalidate();
    await this.persistLastRun('temporalDecay');
    this.emitActivity('temporal', 'done');
    await this.emitVitality();
  }

  private async runGoalCheck(): Promise<void> {
    this.emitActivity('goal-check', 'start');
    try {
      const report = await this.goalTracker.runGoalCheck();
      if (report.deadlineAlerts.length > 0) {
        this.emitBrain('__brain_goal__');
      }
    } catch (err) {
      console.error('[brain] goal check error:', err);
    }
    await this.persistLastRun('goalCheck');
    this.emitActivity('goal-check', 'done');
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * LLM complete with a hard timeout. Brain-engine LLM calls used to hang
   * indefinitely when Ollama was slow — `runSynapse` / `runInsight` would
   * stay in the "running" phase forever, the UI's `__brain_done_*__` event
   * never fired, and the chip persisted (e.g. "🔬 Synthesizing insights…"
   * for minutes). All in-engine LLM calls now route through this so the
   * worst case is a single bounded timeout per call, not a stuck process.
   *
   * Default 15 s — generous for a 3B-param Ollama call; the synapse /
   * insight prompts are short enough that anything beyond this is a hang
   * rather than a slow inference.
   */
  private async llmCompleteWithTimeout(
    input: { system: string; user: string; jsonSchema?: unknown },
    timeoutMs = 15_000,
  ): Promise<string> {
    if (!this.llm) throw new Error('LLM not available');
    return Promise.race([
      this.llm.complete(input),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(`LLM call exceeded ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
  }

  private async pingLlm(): Promise<boolean> {
    if (!this.llm) return false;
    // The local LLM is opt-in. Even when Ollama is reachable, every
    // LLM-backed brain feature (develop, predict, synapse, insight, healing
    // review) stays off until the user explicitly enables it — and they all
    // gate on pingLlm() before calling complete(), so this is the one place
    // the master switch needs to be enforced.
    // Brain-engine LLM loops (synapse, insight, healing review, predict,
    // develop) all map to the `insights` capability — they generate
    // suggestions or surface patterns from the user's memory. Per-capability
    // resolution means the user can keep recall enrichment on while turning
    // off these autonomous background loops.
    if (!settingsMod.resolveLlmCapabilities(this.host.getSettings()).insights) return false;
    const llmWithPing = this.llm as { ping?: () => Promise<boolean> };
    if (typeof llmWithPing.ping === 'function') {
      return llmWithPing.ping();
    }
    return true; // assume reachable if no ping method
  }

  private emitBrain(graphId: string): void {
    // Piggyback on the graph.mutation event channel so the UI's existing
    // listener fires. The Rust event_stream only forwards frames whose
    // kind is 'event' (→ graphnosis://graph-mutation) and reads graphId +
    // ts off the payload; the UI checks graphId.startsWith('__brain') and
    // pulls fresh brain state via IPC.
    this.broadcast({
      kind: 'event',
      name: 'graph.mutation',
      payload: { graphId, ts: Date.now() },
    });
  }

  private emitActivity(phase: string, status: 'start' | 'done'): void {
    if (status === 'start') {
      this.emitBrain(`__brain_start_${phase}__`);
    } else {
      this.emitBrain(`__brain_done_${phase}__`);
    }
  }

  private async emitVitality(): Promise<void> {
    // Warm the vitality cache so the UI's follow-up IPC pull is instant.
    // The event channel only carries graphId + ts, so the report itself
    // can't ride along — the UI fetches it when it sees the done frame.
    try {
      const report = await this.vitality.compute(this.duplicatePairs.length);
      // Persist the live score so the NEXT cold boot can substitute it for
      // the inflated pre-scan estimate. Only persist after the first
      // duplicate scan has completed — otherwise we'd save the same
      // inflated number we're trying to avoid. Best-effort: a failed
      // settings write is non-fatal (next compute will retry).
      if (this.firstDuplicateScanComplete && report && typeof report.overall === 'number') {
        try {
          const current = this.host.getSettings();
          await this.host.setSettings({
            brain: {
              ...current.brain,
              lastVitality: { overall: report.overall, computedAt: Date.now() },
            },
          });
        } catch { /* non-fatal — next compute will try again */ }
      }
    } catch { /* non-fatal */ }
    this.emitBrain('__brain_done__');
  }

  private async persistLastRun(
    activity: 'duplicateScan' | 'synapse' | 'insight' | 'temporalDecay' | 'goalCheck',
  ): Promise<void> {
    try {
      const current = this.host.getSettings();
      await this.host.setSettings({
        brain: {
          ...current.brain,
          lastRun: {
            ...current.brain?.lastRun,
            [activity]: Date.now(),
          },
        },
      });
    } catch { /* non-fatal */ }
  }

  private async persistInsightCount(count: number): Promise<void> {
    try {
      const current = this.host.getSettings();
      await this.host.setSettings({
        brain: {
          ...current.brain,
          pendingInsightsCount: count,
        },
      });
    } catch { /* non-fatal */ }
  }
}

// ── JSON extraction helpers ──────────────────────────────────────────────────

function extractJsonArr(raw: string): string {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array in LLM response');
  return raw.slice(start, end + 1);
}

function extractJsonObj(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in LLM response');
  return JSON.parse(raw.slice(start, end + 1));
}

// ── Duplicate-pair snippet helpers ───────────────────────────────────────────

/** Strip HTML tags + entities and collapse whitespace, so a node's raw
 *  contentPreview (often HTML for web-clipped / RSS memories) renders as
 *  plain readable text in a duplicate-pair card. */
function cleanSnippet(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:[a-z]+|#\d+);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercase a snippet and mask every run of digits. Two snippets equal
 *  after this are the same statement differing only in numbers. NOTE:
 *  that is NOT a proof of duplication — the differing number can be
 *  meaningful ("deadline day 3" vs "deadline day 5"). So digit-masked
 *  equality routes to needs-review, never to autonomous healing. Kept
 *  for the Check-in card's "likely the same fact" hint + the future
 *  LLM review pass. */
function digitMasked(s: string): string {
  return s.toLowerCase().replace(/\d+/g, '#');
}

// ── Autonomous-healing classification ────────────────────────────────────────
//
// A candidate pair (two near-duplicate nodes) is sorted into one of two
// outcomes:
//   - 'heal'         → the brain can merge them autonomously, provably
//                      without losing information. Two safe cases only:
//                      byte-identical text, or negation-guarded superset.
//   - 'needs-review' → everything else (genuine contradictions, partial
//                      overlap, digit-only differences) — handed to the
//                      Check-in deck for a human judgment call.
//
// The bar for 'heal' is deliberately high: autonomous = provably safe.
// Anything merely *probably* a duplicate goes to a human.

type HealingVerdict =
  | { bucket: 'needs-review' }
  | {
      bucket: 'heal';
      survivorId: string;
      supersededId: string;
      survivorContent: string;
      supersededContent: string;
      rule: HealingRule;
      decisionReason: string;
    };

/** Minimal node shape the classifier needs — the full node records from
 *  host.listNodes() structurally satisfy this. */
interface ClassifyNode {
  id: string;
  confidence: number;
}

/** Don't treat a tiny fragment as a "subset" of a paragraph — that's a
 *  granularity difference, not a duplicate. Require the smaller node to
 *  carry real content. */
const MIN_SUBSET_TOKENS = 4;

/** Negation / polarity markers, English + Romanian (the cortex content
 *  in practice is bilingual). If the larger node has one of these and
 *  the smaller doesn't, the "extra" content may INVERT meaning rather
 *  than extend it — the signature of a contradiction masquerading as a
 *  superset ("I like X" ⊂ "I do not like X"). */
const POLARITY_RE =
  /\b(not|no|never|none|nor|without|cannot|nu|f[ăa]r[ăa]|niciodat[ăa]|nici|nicio|niciun)\b|n['']t\b/i;

function classifyHealingPair(
  a: ClassifyNode,
  b: ClassifyNode,
  snippetA: string,
  snippetB: string,
): HealingVerdict {
  // 1. Exact duplicate — byte-identical cleaned text. Zero information
  //    difference; provably safe to drop one. Survivor = higher
  //    confidence; deterministic id tiebreak.
  if (snippetA === snippetB) {
    const aWins =
      a.confidence > b.confidence ||
      (a.confidence === b.confidence && a.id < b.id);
    const survivor = aWins ? a : b;
    const superseded = aWins ? b : a;
    return {
      bucket: 'heal',
      survivorId: survivor.id,
      supersededId: superseded.id,
      survivorContent: snippetA, // identical to snippetB by definition
      supersededContent: snippetB,
      rule: 'exact-duplicate',
      decisionReason:
        `identical text; kept the higher-confidence node ` +
        `(${survivor.confidence.toFixed(2)} vs ${superseded.confidence.toFixed(2)})`,
    };
  }

  // 2. Superset duplicate — one node's token set strictly contains the
  //    other's, the larger is meaningfully bigger, and the extra content
  //    introduces no polarity flip. The larger says everything the
  //    smaller did, plus more — dropping the smaller loses nothing.
  const tokA = tokenSet(snippetA);
  const tokB = tokenSet(snippetB);

  if (
    tokA.size >= MIN_SUBSET_TOKENS &&
    tokB.size > tokA.size &&
    isSubset(tokA, tokB) &&
    !introducesPolarityFlip(snippetB, snippetA)
  ) {
    // A ⊆ B — B is the superset, survives.
    return supersetVerdict(b, a, snippetB, snippetA);
  }
  if (
    tokB.size >= MIN_SUBSET_TOKENS &&
    tokA.size > tokB.size &&
    isSubset(tokB, tokA) &&
    !introducesPolarityFlip(snippetA, snippetB)
  ) {
    // B ⊆ A — A is the superset, survives.
    return supersetVerdict(a, b, snippetA, snippetB);
  }

  // 3. Everything else — genuine contradiction, partial overlap, or a
  //    digit-only difference. Needs a human (or the LLM review pass).
  return { bucket: 'needs-review' };
}

function supersetVerdict(
  survivor: ClassifyNode,
  superseded: ClassifyNode,
  survivorContent: string,
  supersededContent: string,
): HealingVerdict {
  return {
    bucket: 'heal',
    survivorId: survivor.id,
    supersededId: superseded.id,
    survivorContent,
    supersededContent,
    rule: 'superset-duplicate',
    decisionReason:
      'survivor states everything the superseded node did, plus more — ' +
      'no polarity flip in the extra content',
  };
}

/** Lowercased word set: punctuation stripped, 1-char tokens dropped. */
function tokenSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2),
  );
}

function isSubset(small: Set<string>, large: Set<string>): boolean {
  for (const t of small) {
    if (!large.has(t)) return false;
  }
  return true;
}

/** True when `larger` carries a negation/polarity word that `smaller`
 *  lacks — i.e. the extra content might invert meaning, not just add. */
function introducesPolarityFlip(larger: string, smaller: string): boolean {
  return POLARITY_RE.test(larger) && !POLARITY_RE.test(smaller);
}
