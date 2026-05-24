import type { GraphnosisHost } from './host.js';
import type { AppSettings } from '@graphnosis-app/core/settings';
import { redactPair } from './log-redact.js';

/**
 * Source kinds whose nodes are genuinely ephemeral — unconfirmed ambient
 * auto-capture — and may fade with disuse. Human-added memories (file,
 * url, ai-conversation, clip) are NEVER in this set: under Autonomous
 * Indelibility they strengthen, never weaken. No current ingest path
 * produces an ephemeral kind, so the decay loop is dormant by design; a
 * future ambient-capture feature would ingest under such a kind.
 */
const EPHEMERAL_SOURCE_KINDS: ReadonlySet<string> = new Set(['ephemeral']);

export interface DecayReport {
  graphsProcessed: number;
  nodesDecayed: number;
  nodesReinforced: number;
}

/**
 * Temporal decay: nodes that go unrecalled lose confidence over time;
 * nodes that appear in recall results gain a small confidence boost.
 *
 * Decay is intentionally slow (default 0.5%/day) so users don't see
 * memories vanishing — they drift into the review deck's low-confidence
 * queue where the user can confirm or dismiss them deliberately.
 *
 * Privacy: all operations are local and op-logged as 'editNode' with
 * reason 'brain:temporal-decay' or 'brain:reinforcement' for auditability.
 */
export class TemporalEngine {
  constructor(
    private readonly host: GraphnosisHost,
    private readonly getSettings: () => AppSettings,
  ) {}

  /**
   * Apply one decay tick to all active nodes across all graphs.
   * Called by BrainEngine once per day. Non-fatal: errors per node are
   * logged and skipped so a single corrupt node doesn't abort the pass.
   */
  async runDecay(): Promise<DecayReport> {
    const settings = this.getSettings();
    const td = settings.brain?.temporalDecay;
    if (td?.enabled === false) {
      return { graphsProcessed: 0, nodesDecayed: 0, nodesReinforced: 0 };
    }

    const dailyRate = (td?.dailyRatePercent ?? 0.5) / 100;
    const now = Date.now();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;

    let graphsProcessed = 0;
    let nodesDecayed = 0;

    for (const graphId of this.host.listGraphs()) {
      const nodes = this.host.listNodes(graphId);
      const sources = this.host.listSources(graphId);

      // Build a map from nodeId → ingestedAt using the source index.
      const nodeIngestedAt = new Map<string, number>();
      const nodeKind = new Map<string, string>();
      for (const src of sources) {
        for (const nid of src.nodeIds) {
          nodeIngestedAt.set(nid, src.ingestedAt);
          nodeKind.set(nid, src.kind);
        }
      }

      for (const node of nodes) {
        // Only decay active nodes that aren't near the soft-delete floor.
        if (node.confidence <= 0.25 || node.confidence > 0.95) continue;
        if (node.validUntil !== undefined && node.validUntil <= now) continue;
        // Skip structural nodes (document/section) — they decay with their source.
        if (node.nodeType === 'document' || node.nodeType === 'section') continue;

        const ingestedAt = nodeIngestedAt.get(node.id) ?? now;
        const daysSinceIngest = (now - ingestedAt) / MS_PER_DAY;
        if (daysSinceIngest < 1) continue; // too young

        // Deterministic Consolidation — human-added memories never decay from
        // disuse; only genuinely ephemeral auto-capture is allowed to
        // fade. No current ingest path produces an ephemeral kind, so this
        // skip fires for every node today and the loop is a no-op.
        const kind = nodeKind.get(node.id) ?? 'file';
        if (!EPHEMERAL_SOURCE_KINDS.has(kind)) continue;
        const rate = dailyRate;

        // Exponential decay over the node's lifetime.
        const decayFactor = Math.pow(1 - rate, daysSinceIngest);
        const newConfidence = Math.max(0.21, node.confidence * decayFactor);

        // Only write if the change is meaningful (> 1 percentage point).
        if (node.confidence - newConfidence < 0.01) continue;

        try {
          await this.host.applyDecayCorrection(graphId, node.id, node.contentPreview, newConfidence);
          nodesDecayed++;
        } catch (err) {
          console.error(`[brain:temporal] decay failed for ${redactPair(graphId, node.id)}:`, err);
        }
      }

      graphsProcessed++;
    }

    return { graphsProcessed, nodesDecayed, nodesReinforced: 0 };
  }

  /**
   * Reinforce nodes that appeared in a recall result — they are useful
   * and should regain a small confidence boost. Capped to avoid
   * over-reinforcement: never raises above 0.95 and adds at most +0.03.
   */
  async reinforceNodes(nodeIds: string[], graphId: string): Promise<void> {
    const settings = this.getSettings();
    if (settings.brain?.temporalDecay?.reinforceOnRecall === false) return;

    for (const nodeId of nodeIds) {
      try {
        await this.host.reinforceNode(graphId, nodeId);
      } catch {
        // Non-fatal — reinforcement is best-effort
      }
    }
  }
}
