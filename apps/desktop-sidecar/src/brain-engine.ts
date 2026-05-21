import { randomUUID } from 'node:crypto';
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import type { BroadcastRawFn } from './events.js';
import { VitalityScorer, type VitalityReport } from './vitality.js';
import { TemporalEngine } from './temporal-engine.js';
import { GoalTracker } from './goal-tracker.js';
import { findSimilarPairs } from './duplicate-scan.js';
import {
  type HealingRecord,
  type HealingRule,
  type HealingLlmVerdict,
  makeHealingRecord,
} from './healing-journal.js';

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
const SYNAPSE_INTERVAL_MS       = 45 * 60 * 1000;   // 45 min
const INSIGHT_INTERVAL_MS       =  6 * 60 * 60 * 1000; // 6 h
const TEMPORAL_INTERVAL_MS      = 24 * 60 * 60 * 1000; // 24 h
const GOAL_CHECK_INTERVAL_MS    =  4 * 60 * 60 * 1000; // 4 h
// Grace period before the first background sweep. The duplicate scan
// does real embedding math now; running it during boot starves the IPC
// the UI needs to load engrams. Hold off until the app has settled.
const BOOT_GRACE_MS             = 60 * 1000;        // 60 s
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

export class BrainEngine {
  private readonly vitality: VitalityScorer;
  readonly temporalEngine: TemporalEngine;
  private readonly goalTracker: GoalTracker;

  // The "needs human judgment" queue — genuine contradictions and
  // partial-overlap pairs the brain could NOT safely auto-heal. Surfaced
  // in the Check-in deck, not the Autonomous Brain tab.
  private duplicatePairs: DuplicatePair[] = [];
  private insights: Insight[] = [];

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
  // Guards the (now genuinely expensive) duplicate scan against
  // overlapping runs — the boot warmup, the 20-min interval, and a
  // runFullScan can otherwise all enter it at once.
  private duplicateScanRunning = false;
  // Guards the healing-review pass (LLM second opinions on past auto-
  // heals). It rides on the duplicate scan, which can be triggered
  // from several places at once, so it needs its own re-entrancy guard.
  private healingReviewRunning = false;

  private warmupTimer: NodeJS.Timeout | null = null;
  private duplicateScanTimer: NodeJS.Timeout | null = null;
  private synapseTimer: NodeJS.Timeout | null = null;
  private insightTimer: NodeJS.Timeout | null = null;
  private temporalTimer: NodeJS.Timeout | null = null;
  private goalTimer: NodeJS.Timeout | null = null;
  // Debounce timer for the post-ingest duplicate scan — see
  // notifyIngestComplete(). A one-shot setTimeout, reset on each ingest.
  private ingestScanTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly host: GraphnosisHost,
    private readonly llm: LocalLlm | null,
    private readonly broadcast: BroadcastRawFn,
  ) {
    this.vitality = new VitalityScorer(host);
    this.temporalEngine = new TemporalEngine(host, () => host.getSettings());
    this.goalTracker = new GoalTracker(host, llm);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    // Load the autonomous-healing journal off-disk. Fire-and-forget — the
    // first scan that would append to it is gated behind BOOT_GRACE_MS
    // (60 s), far longer than this read takes. The `healingJournalLoaded`
    // flag lets runAutoHeal defer if a scan somehow races the load.
    void this.host.loadHealingJournal()
      .then((records) => { this.healingJournal = records; this.healingJournalLoaded = true; })
      .catch((e) => {
        console.error(`[brain] healing journal load failed: ${(e as Error).message}`);
        this.healingJournalLoaded = true; // proceed with an empty journal
      });

    // Do NOT scan at boot. The duplicate scan does real embedding math
    // now; running it while the app is still loading engrams and wiring the
    // UI saturates the CPU and starves the IPC the UI needs — engrams then
    // appear not to load. Hold the first sweep for a grace period; the
    // intervals below take over after that, a completed file ingest
    // triggers a debounced scan, and the "Scan now" button covers the rest.
    this.warmupTimer = setTimeout(() => {
      // One coordinated sweep. runFullScan serialises the scan loops so they
      // don't all pin the CPU at once in the post-boot window, and coalesces
      // with any scan the user triggered by opening the Brain tab early.
      // Temporal decay runs alongside (runFullScan excludes it by design).
      void this.runFullScan();
      void this.runTemporalDecay();
    }, BOOT_GRACE_MS);
    this.warmupTimer.unref();

    this.duplicateScanTimer = setInterval(
      () => { void this.runDuplicateScan(); },
      DUPLICATE_SCAN_INTERVAL_MS,
    ).unref();

    this.synapseTimer = setInterval(
      () => { void this.runSynapse(); },
      SYNAPSE_INTERVAL_MS,
    ).unref();

    this.insightTimer = setInterval(
      () => { void this.runInsight(); },
      INSIGHT_INTERVAL_MS,
    ).unref();

    this.temporalTimer = setInterval(
      () => { void this.runTemporalDecay(); },
      TEMPORAL_INTERVAL_MS,
    ).unref();

    this.goalTimer = setInterval(
      () => { void this.runGoalCheck(); },
      GOAL_CHECK_INTERVAL_MS,
    ).unref();

    // Emit initial vitality once boot has settled — vitality.compute()
    // walks every node and the op-log, so keep it clear of the load path.
    setTimeout(() => {
      void this.emitVitality();
    }, 12_000).unref();
  }

  stop(): void {
    if (this.warmupTimer) clearTimeout(this.warmupTimer);
    this.warmupTimer = null;
    if (this.ingestScanTimer) clearTimeout(this.ingestScanTimer);
    this.ingestScanTimer = null;
    for (const t of [this.duplicateScanTimer, this.synapseTimer, this.insightTimer, this.temporalTimer, this.goalTimer]) {
      if (t) clearInterval(t);
    }
    this.duplicateScanTimer = null;
    this.synapseTimer = null;
    this.insightTimer = null;
    this.temporalTimer = null;
    this.goalTimer = null;
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

  async getVitalityReport(): Promise<VitalityReport> {
    return this.vitality.compute(this.duplicatePairs.length);
  }

  getInsights(): Insight[] {
    return this.insights.filter(i => !i.dismissed);
  }

  getDuplicatePairs(): DuplicatePair[] {
    return this.duplicatePairs;
  }

  /** The autonomous-healing audit log — every safe auto-merge the brain
   *  performed. Most-recent first. Read by the Autonomous Brain tab's
   *  healing-log section. */
  getHealingJournal(): HealingRecord[] {
    return [...this.healingJournal].sort((a, b) => b.healedAt - a.healedAt);
  }

  dismissInsight(id: string): void {
    const ins = this.insights.find(i => i.id === id);
    if (ins) ins.dismissed = true;
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
          });
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
    const recalled = await this.host.recall(query, {
      budget: { maxTokens: 3000, maxNodes: 30 },
    });

    const referencedNodeIds: string[] = [];
    for (const items of recalled.byGraph.values()) {
      for (const item of items) referencedNodeIds.push(item.nodeId);
    }

    let synthesis: string;
    if (this.llm && await this.pingLlm()) {
      synthesis = await this.llm.complete({
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
      synthesis = `*[Local AI not available — showing recalled context only]*\n\n${recalled.prompt}`;
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
    const recalled = await this.host.recall(params.action, {
      budget: { maxTokens: 2000, maxNodes: 20 },
    });

    const referencedNodeIds: string[] = [];
    for (const items of recalled.byGraph.values()) {
      for (const item of items) referencedNodeIds.push(item.nodeId);
    }

    if (!this.llm || !(await this.pingLlm())) {
      return { risks: [], opportunities: [], recommendation: recalled.prompt.slice(0, 200), referencedNodeIds };
    }

    const raw = await this.llm.complete({
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
  async runFullScan(): Promise<void> {
    if (this.scanInFlight) return;
    this.scanInFlight = true;
    this.emitBrain('__brain_start_fullscan__');
    try {
      await this.runDuplicateScan();
      await this.runSynapse();
      await this.runInsight();
      await this.runGoalCheck();
    } catch (err) {
      console.error('[brain] full scan error:', err);
    } finally {
      this.scanInFlight = false;
      this.emitBrain('__brain_done_fullscan__');
    }
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
  } {
    return {
      scanning: this.scanInFlight,
      lastRun: { ...(this.host.getSettings().brain?.lastRun ?? {}) },
      intervals: {
        duplicateScan: DUPLICATE_SCAN_INTERVAL_MS,
        synapse: SYNAPSE_INTERVAL_MS,
        insight: INSIGHT_INTERVAL_MS,
        temporalDecay: TEMPORAL_INTERVAL_MS,
        goalCheck: GOAL_CHECK_INTERVAL_MS,
      },
      lastDecayReport: this.lastDecayReport,
      sessionSynapsesFormed: this.sessionSynapsesFormed,
      sessionAutoLinksFormed: this.sessionAutoLinksFormed,
    };
  }

  // ── Private loop implementations ──────────────────────────────────────────

  private async runDuplicateScan(): Promise<void> {
    // The scan is genuinely expensive now — never let two overlap.
    if (this.duplicateScanRunning) return;
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
      for (const graphId of this.host.listGraphs()) {
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

          for (const pair of pairs) {
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
              console.error(`[brain] auto-link failed on ${graphId}:`, err);
            }
          }
        } catch (err) {
          console.error(`[brain] duplicate scan error on ${graphId}:`, err);
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
        console.log(`[brain] autonomously healed ${healedCount} duplicate(s)`);
      }
      if (autoLinkedThisRun > 0) {
        this.emitActivity('auto-link', 'done');
        console.log(`[brain] auto-linked ${autoLinkedThisRun} related memory pair(s)`);
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
    });
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
        });
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
        });
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

    for (const graphId of this.host.listGraphs()) {
      if (totalNewEdges >= MAX_SYNAPSE_EDGES_PER_RUN) break;
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

        const raw = await this.llm.complete({
          system: SYNAPSE_SYSTEM_PROMPT,
          user: `Nodes from engram "${graphId}":\n${nodesList}\n\nWhich pairs share a deep conceptual relationship?`,
          jsonSchema: { type: 'array' },
        });

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
        console.error(`[brain] synapse error on ${graphId}:`, err);
      }
    }

    this.vitality.invalidate();
    await this.persistLastRun('synapse');
    this.emitActivity('synapse', 'done');
    await this.emitVitality();
  }

  private async runInsight(): Promise<void> {
    if (!this.llm) return;
    if (!(await this.pingLlm())) return;

    this.emitActivity('insight', 'start');

    for (const graphId of this.host.listGraphs()) {
      try {
        // Search within this graph using searchNodes (per-graph, not federated)
        const topNodes = await this.host.searchNodes(
          graphId,
          'important facts decisions goals plans key information',
          30,
        );
        if (topNodes.length < 5) continue;

        const nodesList = topNodes
          .map(n => `- [${n.nodeId}] ${n.text.slice(0, 200)}`)
          .join('\n');

        const raw = await this.llm.complete({
          system: INSIGHT_SYSTEM_PROMPT,
          user: `Nodes from engram "${graphId}":\n${nodesList}\n\nWhat patterns, gaps, or opportunities are noteworthy?`,
          jsonSchema: { type: 'array' },
        });

        let parsedInsights: Array<{
          kind: string;
          title: string;
          body: string;
          relevantNodeIds: string[];
        }> = [];
        try { parsedInsights = JSON.parse(extractJsonArr(raw)) as typeof parsedInsights; } catch { continue; }

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
        }
      } catch (err) {
        console.error(`[brain] insight error on ${graphId}:`, err);
      }
    }

    // Keep only the most recent non-dismissed insights
    this.insights = this.insights.filter(i => !i.dismissed).slice(0, MAX_INSIGHTS_STORED);
    const pendingCount = this.insights.length;

    await this.persistLastRun('insight');
    await this.persistInsightCount(pendingCount);
    this.emitActivity('insight', 'done');

    if (pendingCount > 0) {
      this.emitBrain('__brain_done_insight__');
    }
  }

  private async runTemporalDecay(): Promise<void> {
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

  private async pingLlm(): Promise<boolean> {
    if (!this.llm) return false;
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
      await this.vitality.compute(this.duplicatePairs.length);
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
