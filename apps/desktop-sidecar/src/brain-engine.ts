import { randomUUID } from 'node:crypto';
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import type { BroadcastRawFn } from './events.js';
import { VitalityScorer, type VitalityReport } from './vitality.js';
import { TemporalEngine } from './temporal-engine.js';
import { GoalTracker } from './goal-tracker.js';
import { findSimilarPairs } from './contradiction-scan.js';

// ── Public types ────────────────────────────────────────────────────────────

export interface Contradiction {
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

// ── BrainEngine ──────────────────────────────────────────────────────────────

const CONTRADICTION_INTERVAL_MS = 20 * 60 * 1000;   // 20 min
const SYNAPSE_INTERVAL_MS       = 45 * 60 * 1000;   // 45 min
const INSIGHT_INTERVAL_MS       =  6 * 60 * 60 * 1000; // 6 h
const TEMPORAL_INTERVAL_MS      = 24 * 60 * 60 * 1000; // 24 h
const GOAL_CHECK_INTERVAL_MS    =  4 * 60 * 60 * 1000; // 4 h
// Grace period before the first background sweep. The contradiction scan
// does real embedding math now; running it during boot starves the IPC
// the UI needs to load engrams. Hold off until the app has settled.
const BOOT_GRACE_MS             = 60 * 1000;        // 60 s
// Safety ceiling on nodes fed to the LSH near-duplicate search. The search
// is ~O(n), so this comfortably covers any real engram; a single engram
// with more content-bearing nodes than this (typically a firehose RSS feed
// of near-duplicates) is capped by confidence — scanning every dup past
// this point only produces more dup-spam, not more signal.
const MAX_CONTRADICTION_NODES   = 15_000;
// Keep the contradiction list small and useful. Each node appears in at
// most one contradiction (see runContradictionScan), so this is a hard cap
// on distinct review cards — 60 highest-similarity pairs is plenty.
const MAX_CONTRADICTIONS_STORED = 60;
const MAX_SYNAPSE_EDGES_PER_RUN = 20;
const MAX_INSIGHTS_STORED       = 50;

export class BrainEngine {
  private readonly vitality: VitalityScorer;
  readonly temporalEngine: TemporalEngine;
  private readonly goalTracker: GoalTracker;

  private contradictions: Contradiction[] = [];
  private insights: Insight[] = [];

  // Guards runFullScan() against overlapping on-demand triggers (e.g. the
  // user mashing Refresh, or a tab-open scan racing a manual one).
  private scanInFlight = false;
  // Guards the (now genuinely expensive) contradiction scan against
  // overlapping runs — the boot warmup, the 20-min interval, and a
  // runFullScan can otherwise all enter it at once.
  private contradictionScanRunning = false;

  private warmupTimer: NodeJS.Timeout | null = null;
  private contradictionTimer: NodeJS.Timeout | null = null;
  private synapseTimer: NodeJS.Timeout | null = null;
  private insightTimer: NodeJS.Timeout | null = null;
  private temporalTimer: NodeJS.Timeout | null = null;
  private goalTimer: NodeJS.Timeout | null = null;

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
    // Do NOT scan at boot. The contradiction scan does real embedding math
    // now; running it while the app is still loading engrams and wiring the
    // UI saturates the CPU and starves the IPC the UI needs — engrams then
    // appear not to load. Hold the first sweep for a grace period; the
    // intervals below take over after that, and the Autonomous Brain tab
    // triggers an on-demand scan whenever the user wants one sooner.
    this.warmupTimer = setTimeout(() => {
      // One coordinated sweep. runFullScan serialises the scan loops so they
      // don't all pin the CPU at once in the post-boot window, and coalesces
      // with any scan the user triggered by opening the Brain tab early.
      // Temporal decay runs alongside (runFullScan excludes it by design).
      void this.runFullScan();
      void this.runTemporalDecay();
    }, BOOT_GRACE_MS);
    this.warmupTimer.unref();

    this.contradictionTimer = setInterval(
      () => { void this.runContradictionScan(); },
      CONTRADICTION_INTERVAL_MS,
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
    for (const t of [this.contradictionTimer, this.synapseTimer, this.insightTimer, this.temporalTimer, this.goalTimer]) {
      if (t) clearInterval(t);
    }
    this.contradictionTimer = null;
    this.synapseTimer = null;
    this.insightTimer = null;
    this.temporalTimer = null;
    this.goalTimer = null;
  }

  // ── Public API (for IPC/MCP handlers) ────────────────────────────────────

  async getVitalityReport(): Promise<VitalityReport> {
    return this.vitality.compute(this.contradictions.length);
  }

  getInsights(): Insight[] {
    return this.insights.filter(i => !i.dismissed);
  }

  getContradictions(): Contradiction[] {
    return this.contradictions;
  }

  dismissInsight(id: string): void {
    const ins = this.insights.find(i => i.id === id);
    if (ins) ins.dismissed = true;
  }

  dismissContradiction(id: string): void {
    this.contradictions = this.contradictions.filter(c => c.id !== id);
    this.vitality.invalidate();
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
    return this.vitality.compute(this.contradictions.length);
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
      await this.runContradictionScan();
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
   *  loop last run, and how often does each loop run on its own. */
  getStatus(): {
    scanning: boolean;
    lastRun: Record<string, number>;
    intervals: Record<string, number>;
  } {
    return {
      scanning: this.scanInFlight,
      lastRun: { ...(this.host.getSettings().brain?.lastRun ?? {}) },
      intervals: {
        contradictionScan: CONTRADICTION_INTERVAL_MS,
        synapse: SYNAPSE_INTERVAL_MS,
        insight: INSIGHT_INTERVAL_MS,
        temporalDecay: TEMPORAL_INTERVAL_MS,
        goalCheck: GOAL_CHECK_INTERVAL_MS,
      },
    };
  }

  // ── Private loop implementations ──────────────────────────────────────────

  private async runContradictionScan(): Promise<void> {
    // The scan is genuinely expensive now — never let two overlap.
    if (this.contradictionScanRunning) return;
    this.contradictionScanRunning = true;
    this.emitActivity('contradiction-scan', 'start');
    const found: Contradiction[] = [];
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
            .slice(0, MAX_CONTRADICTION_NODES);
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
          // contradiction card" — without it, a cluster of near-duplicate
          // memories (e.g. an RSS feed re-ingested over time) yields
          // hundreds of pairs all pivoting on the same handful of nodes.
          const knownKeys = new Set<string>();
          const usedNodes = new Set<string>();
          for (const c of this.contradictions) {
            if (c.graphId === graphId) {
              knownKeys.add(c.nodeA < c.nodeB
                ? `${c.nodeA}|${c.nodeB}` : `${c.nodeB}|${c.nodeA}`);
              usedNodes.add(c.nodeA);
              usedNodes.add(c.nodeB);
            }
          }

          // LSH near-duplicate search — exhaustive across every embedded
          // node in the engram, ~O(n) instead of a brute O(n²) sweep.
          const pairs = await findSimilarPairs(embs, {
            minSim: 0.85,
            maxSim: 0.99,
            onYield: yieldToLoop,
          });
          // Strongest matches first: the greedy per-node cap below should
          // keep the most likely-genuine pairing when a node could pair
          // with several neighbours.
          pairs.sort((p1, p2) => p2.similarity - p1.similarity);

          for (const pair of pairs) {
            const a = nodeById.get(pair.idA);
            const b = nodeById.get(pair.idB);
            if (!a || !b) continue;
            // One contradiction per node — skip if either is already paired.
            if (usedNodes.has(a.id) || usedNodes.has(b.id)) continue;
            const dedupKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
            if (knownKeys.has(dedupKey)) continue;
            // Node previews are often raw HTML (web-clipped / RSS memories);
            // strip it so the review card shows readable text.
            const snippetA = cleanSnippet(a.contentPreview);
            const snippetB = cleanSnippet(b.contentPreview);
            if (!snippetA || !snippetB) continue;
            // Two memories whose text is identical once numbers are masked
            // are the same record captured twice (e.g. an RSS item re-fetched
            // as its score ticks up) — a duplicate, not a contradiction.
            if (digitMasked(snippetA) === digitMasked(snippetB)) continue;
            knownKeys.add(dedupKey);
            usedNodes.add(a.id);
            usedNodes.add(b.id);
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
          }
        } catch (err) {
          console.error(`[brain] contradiction scan error on ${graphId}:`, err);
        }
        await yieldToLoop();
      }

      this.contradictions.push(...found);
      // Keep the list bounded — highest-similarity pairs first, since those
      // are the most likely to be genuine same-fact contradictions.
      if (this.contradictions.length > MAX_CONTRADICTIONS_STORED) {
        this.contradictions.sort((a, b) => b.similarity - a.similarity);
        this.contradictions = this.contradictions.slice(0, MAX_CONTRADICTIONS_STORED);
      }
      this.vitality.invalidate();
      await this.persistLastRun('contradictionScan');
    } finally {
      this.contradictionScanRunning = false;
    }
    this.emitActivity('contradiction-scan', 'done');
    await this.emitVitality();
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
      await this.temporalEngine.runDecay();
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
      await this.vitality.compute(this.contradictions.length);
    } catch { /* non-fatal */ }
    this.emitBrain('__brain_done__');
  }

  private async persistLastRun(
    activity: 'contradictionScan' | 'synapse' | 'insight' | 'temporalDecay' | 'goalCheck',
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

// ── Contradiction snippet helpers ────────────────────────────────────────────

/** Strip HTML tags + entities and collapse whitespace, so a node's raw
 *  contentPreview (often HTML for web-clipped / RSS memories) renders as
 *  plain readable text in a contradiction card. */
function cleanSnippet(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:[a-z]+|#\d+);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lowercase a snippet and mask every run of digits. Two snippets equal
 *  after this are the same statement differing only in numbers — the
 *  signature of a re-captured record rather than a genuine contradiction. */
function digitMasked(s: string): string {
  return s.toLowerCase().replace(/\d+/g, '#');
}
