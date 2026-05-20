import { randomUUID } from 'node:crypto';
import { embeddings } from '@graphnosis-app/core';
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import type { BroadcastRawFn } from './events.js';
import { VitalityScorer, type VitalityReport } from './vitality.js';
import { TemporalEngine } from './temporal-engine.js';
import { GoalTracker } from './goal-tracker.js';

const { cosine } = embeddings;

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
// Per-graph cap on nodes fed into the O(n²) pairwise cosine comparison.
// 1200 keeps a full cortex sweep (11 engrams) near ~8M comparisons — a few
// seconds of work, and the loop yields to the event loop so it never blocks
// IPC. Nodes are taken highest-confidence-first, so the cap samples the
// memories where a contradiction matters most.
const MAX_CONTRADICTION_NODES   = 1200;
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
    // Fire all loops immediately (async, non-blocking) then schedule repeats.
    void this.runContradictionScan();
    void this.runSynapse();
    void this.runInsight();
    void this.runTemporalDecay();
    void this.runGoalCheck();

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

    // Emit initial vitality after a short delay so host is fully settled.
    setTimeout(() => {
      void this.emitVitality();
    }, 2_000).unref();
  }

  stop(): void {
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
    this.emitActivity('contradiction-scan', 'start');
    const found: Contradiction[] = [];
    const now = Date.now();

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

        const embs = this.host.getNodeEmbeddings(graphId);
        if (embs.size < 2) continue;

        const embeddedNodes = active.filter(n => embs.has(n.id));

        for (let i = 0; i < embeddedNodes.length; i++) {
          // Yield to the event loop every 64 rows so a large pairwise
          // sweep stays responsive — IPC and other sidecar work keep
          // flowing instead of stalling for the whole O(n²) pass.
          if (i > 0 && i % 64 === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          for (let j = i + 1; j < embeddedNodes.length; j++) {
            const a = embeddedNodes[i]!;
            const b = embeddedNodes[j]!;
            const embA = embs.get(a.id)!;
            const embB = embs.get(b.id)!;
            const sim = cosine(embA, embB);

            // High similarity but not identical content = potential contradiction
            if (sim >= 0.85 && sim < 0.99 &&
                a.contentPreview.slice(0, 40) !== b.contentPreview.slice(0, 40)) {
              const key = `${graphId}|${a.id}|${b.id}`;
              const alreadyKnown = this.contradictions.some(
                c => c.graphId === graphId &&
                     ((c.nodeA === a.id && c.nodeB === b.id) ||
                      (c.nodeA === b.id && c.nodeB === a.id)),
              );
              if (!alreadyKnown) {
                found.push({
                  id: randomUUID(),
                  graphId,
                  nodeA: a.id,
                  nodeB: b.id,
                  snippetA: a.contentPreview.slice(0, 120),
                  snippetB: b.contentPreview.slice(0, 120),
                  similarity: sim,
                  detectedAt: now,
                });
                this.emitBrain('__brain_contradiction__');
              }
            }
          }
        }
      } catch (err) {
        console.error(`[brain] contradiction scan error on ${graphId}:`, err);
      }
    }

    this.contradictions.push(...found);
    this.vitality.invalidate();
    await this.persistLastRun('contradictionScan');
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
