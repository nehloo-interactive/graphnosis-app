import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';

interface PlanSummary {
  context: string;
  strategy: string;
  goals: string;
  synthesisMarkdown: string;
}

export interface GoalNode {
  nodeId: string;
  graphId: string;
  title: string;
  milestones: string[];
  targetDate?: number;
  createdAt: number;
  lastCheckedAt?: number;
}

export interface GoalCheckReport {
  goalsChecked: number;
  deadlineAlerts: string[];
  assessments: Array<{ goalId: string; assessment: string }>;
}

/**
 * Tracks goal-type nodes across all engrams and provides periodic check-ins.
 * Goals are regular graph nodes with nodeType='goal' — no separate storage.
 */
export class GoalTracker {
  constructor(
    private readonly host: GraphnosisHost,
    private readonly llm: LocalLlm | null,
  ) {}

  /**
   * Find all goals across all loaded graphs. Goals are identified by their
   * source ref carrying the `goal:` prefix that ingestGoal() assigns — the
   * SDK ingest path doesn't expose a custom node type, so the source ref is
   * the durable marker.
   */
  async listGoals(): Promise<GoalNode[]> {
    const goals: GoalNode[] = [];
    const now = Date.now();

    for (const graphId of this.host.listGraphs()) {
      const goalSources = this.host
        .listSources(graphId)
        .filter((s) => s.ref.startsWith('goal:'));
      if (goalSources.length === 0) continue;

      const nodeById = new Map(
        this.host.listNodes(graphId).map((n) => [n.id, n]),
      );

      for (const src of goalSources) {
        const firstNodeId = src.nodeIds[0];
        if (!firstNodeId) continue;
        const first = nodeById.get(firstNodeId);
        if (!first) continue;
        if (first.confidence <= 0.2) continue;
        if (first.validUntil !== undefined && first.validUntil <= now) continue;

        // Aggregate every node preview of the source so milestone and date
        // extraction sees the whole goal, not just its first chunk.
        const fullText = src.nodeIds
          .map((id) => nodeById.get(id)?.contentPreview ?? '')
          .join('\n');

        const targetDate = extractDate(fullText);
        goals.push({
          nodeId: firstNodeId,
          graphId,
          title: first.section ?? first.contentPreview.slice(0, 60),
          milestones: extractMilestones(fullText),
          ...(targetDate !== undefined ? { targetDate } : {}),
          createdAt: src.ingestedAt,
        });
      }
    }

    return goals;
  }

  /**
   * For each goal: check deadline proximity and optionally assess milestone
   * progress via local LLM. Called by BrainEngine every 4 hours.
   */
  async runGoalCheck(): Promise<GoalCheckReport> {
    const goals = await this.listGoals();
    const deadlineAlerts: string[] = [];
    const assessments: Array<{ goalId: string; assessment: string }> = [];
    const now = Date.now();
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

    for (const goal of goals) {
      // Deadline detection (works without LLM)
      if (goal.targetDate !== undefined && goal.targetDate > now) {
        const daysUntil = Math.ceil((goal.targetDate - now) / (24 * 60 * 60 * 1000));
        if (daysUntil <= 7) {
          deadlineAlerts.push(
            `Goal "${goal.title}" deadline in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}`,
          );
        }
      }

      // LLM milestone assessment — optional: needs Ollama AND the user's
      // opt-in, since the local LLM is off by default.
      if (!this.llm || this.host.getSettings().ai.llmEnabled !== true) continue;
      try {
        const recentContext = await this.host.recall(goal.title, {
          budget: { maxTokens: 500, maxNodes: 5 },
        });
        if (recentContext.nodesIncluded === 0) continue;

        const raw = await this.llm.complete({
          system: GOAL_CHECK_PROMPT,
          user: [
            `Goal: ${goal.title}`,
            goal.milestones.length > 0
              ? `Milestones: ${goal.milestones.join('; ')}`
              : '',
            '',
            'Recent related memory:',
            recentContext.prompt.slice(0, 600),
          ].filter(Boolean).join('\n'),
        });

        if (raw.trim()) {
          assessments.push({ goalId: goal.nodeId, assessment: raw.slice(0, 500) });
        }
      } catch {
        // Non-fatal — skip this goal
      }
    }

    return { goalsChecked: goals.length, deadlineAlerts, assessments };
  }

  /**
   * Ingest a strategic plan as a goal node in the target engram.
   * The plan is stored as markdown with nodeType='goal'.
   */
  async ingestGoal(graphId: string, plan: PlanSummary): Promise<string> {
    const content = [
      `# Goal: ${plan.context}`,
      '',
      `**Strategy:** ${plan.strategy}`,
      `**Goals:** ${plan.goals}`,
      '',
      plan.synthesisMarkdown,
    ].join('\n');

    const sourceRef = `goal:${Date.now()}`;
    await this.host.ingest(graphId, 'clip', sourceRef, {
      kind: 'markdown',
      content,
      sourceRef,
    });

    // Return the nodeId of the created goal node (first node from this source)
    const sources = this.host.listSources(graphId);
    const src = sources.find((s) => s.ref === sourceRef);
    return src?.nodeIds[0] ?? '';
  }
}

const GOAL_CHECK_PROMPT = `You are a goal progress advisor reviewing a personal goal against recent memory.
Given the goal title, milestones, and related recent knowledge:
- Assess in 1-2 sentences whether meaningful progress has been made.
- Identify the most important next action if progress is slow.
- Be specific and brief. Plain prose, no JSON.`;

function extractMilestones(content: string): string[] {
  const lines = content.split('\n');
  const milestones: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\.\s/.test(trimmed)) {
      milestones.push(trimmed.replace(/^[-*]\s|^\d+\.\s/, '').trim());
    }
  }
  return milestones.slice(0, 10);
}

function extractDate(content: string): number | undefined {
  // Look for ISO dates (YYYY-MM-DD) or "by [month] [year]" patterns
  const isoMatch = content.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch?.[1]) {
    const d = new Date(isoMatch[1]);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return undefined;
}
