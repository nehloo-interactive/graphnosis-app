/**
 * Deterministic Ghampus health-check answers — no recall, no LLM.
 */

import type { GraphnosisHost } from './host.js';
import type { BrainEngine } from './brain-engine.js';
import {
  formatFactorPct,
  suggestVitalityFixes,
  VITALITY_WEIGHTS,
  type VitalityDetailedReport,
  type VitalityEngramBreakdown,
} from './vitality.js';
import { resolveEngramFromUserHint, type EngramListEntry } from './ghampus-engram-resolve.js';

const HEALTH_CHECK_RE =
  /\b(?:health\s*check|healthcheck|vitality\s+check|verific[aă]\s+(?:s[aă]n[aă]tatea|vitality)|control(?:ul)?\s+(?:s[aă]n[aă]tate|vitality)|starea?\s+(?:engramului|cortexului))\b/i;

const VITALITY_ONLY_RE =
  /^(?:vitality|s[aă]n[aă]tate)\b/i;

export function isHealthCheckRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return HEALTH_CHECK_RE.test(t) || VITALITY_ONLY_RE.test(t);
}

/** Extract optional engram hint after health-check / vitality phrasing. */
export function extractHealthCheckEngramHint(text: string): string | null {
  const t = text.trim();
  const patterns = [
    /\bhealth\s*check(?:\s+(?:for|on|in|la|pentru))?\s+(.+?)\s*$/i,
    /\bvitality(?:\s+(?:for|on|in|la|pentru))?\s+(.+?)\s*$/i,
    /\bverific[aă]\s+(?:s[aă]n[aă]tatea|vitality)(?:\s+(?:pentru|la|în|in))?\s+(.+?)\s*$/i,
    /\bhealth\s*check\s+(.+?)\s*$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    const hint = m?.[1]?.trim().replace(/\bengram\b/i, '').trim();
    if (hint && hint.length >= 2) return hint;
  }
  return null;
}

async function listEngrams(host: GraphnosisHost): Promise<EngramListEntry[]> {
  const graphs = host.listGraphs();
  return graphs.map((graphId) => {
    const meta = host.getGraphMetadata(graphId);
    return {
      graphId,
      displayName: meta?.displayName ?? graphId,
    };
  });
}

export async function fetchVitalityDetailed(
  brainEngine: BrainEngine | null | undefined,
): Promise<VitalityDetailedReport | null> {
  if (!brainEngine) return null;
  const report = await brainEngine.getVitalityDetailedReport();
  return report;
}

function formatEngramSection(
  label: string,
  breakdown: VitalityEngramBreakdown,
): string {
  const f = breakdown.factors;
  const lines = [
    `### ${label} — **${breakdown.score}/100**`,
    `- **Connectivity** (${Math.round(VITALITY_WEIGHTS.connectivity * 100)}%): ${formatFactorPct(f.connectivity)} → +${f.weighted.connectivity} pts`,
    `- **Confidence** (${Math.round(VITALITY_WEIGHTS.confidence * 100)}%): ${formatFactorPct(f.confidence)} → +${f.weighted.confidence} pts`,
    `- **Activity** (${Math.round(VITALITY_WEIGHTS.activity * 100)}%): ${formatFactorPct(f.activity)} → +${f.weighted.activity} pts`,
    `- **Coherence** (${Math.round(VITALITY_WEIGHTS.coherence * 100)}%): ${formatFactorPct(f.coherence)} → +${f.weighted.coherence} pts`,
  ];
  if (breakdown.activeNodes > 0) {
    lines.push(
      `- Active memories: **${breakdown.activeNodes.toLocaleString()}** · woven: **${breakdown.connectedActive.toLocaleString()}** · orphan estimate: **${breakdown.orphansEstimate.toLocaleString()}**`,
    );
  } else {
    lines.push('- Engram is **empty** — no active memories to score.');
  }
  return lines.join('\n');
}

export async function buildHealthCheckReportMarkdown(
  host: GraphnosisHost,
  brainEngine: BrainEngine | null | undefined,
  userText: string,
): Promise<string> {
  const detailed = await fetchVitalityDetailed(brainEngine);
  if (!detailed) {
    return 'Vitality is still **computing** — unlock your cortex and wait for the first duplicate scan to finish, then try again.';
  }

  const hint = extractHealthCheckEngramHint(userText);
  const engrams = await listEngrams(host);
  const matched = hint ? resolveEngramFromUserHint(hint, engrams) : null;

  const cf = detailed.cortexFactors;
  const trust = detailed.trust;
  const parts: string[] = [
    '## Cortex health check',
    '',
    `**Overall vitality:** ${detailed.overall}/100`,
    '',
    '**Cortex-wide factors** (weights 40 / 25 / 20 / 15):',
    `- Connectivity: ${formatFactorPct(cf.connectivity)} (+${cf.weighted.connectivity} pts)`,
    `- Confidence: ${formatFactorPct(cf.confidence)} (+${cf.weighted.confidence} pts)`,
    `- Activity: ${formatFactorPct(cf.activity)} (+${cf.weighted.activity} pts)`,
    `- Coherence: ${formatFactorPct(cf.coherence)} (+${cf.weighted.coherence} pts)`,
  ];

  if (detailed.pendingDuplicatePairs > 0) {
    parts.push(
      '',
      `**Pending duplicate pairs:** ${detailed.pendingDuplicatePairs} — each shaves ~5% off the coherence factor until resolved in Check-in.`,
    );
  }
  if (trust && trust.orphans > 0) {
    parts.push(`**Orphan estimate (cortex-wide):** ${trust.orphans.toLocaleString()} active memories with no links.`);
  }

  if (matched) {
    const bd = detailed.byGraphBreakdown[matched.graphId];
    parts.push('', formatEngramSection(matched.displayName, bd ?? {
      graphId: matched.graphId,
      score: detailed.byGraph[matched.graphId] ?? 0,
      activeNodes: 0,
      connectedActive: 0,
      orphansEstimate: 0,
      recentOps: 0,
      factors: detailed.cortexFactors,
    }));
  } else if (!hint) {
    const sorted = Object.values(detailed.byGraphBreakdown)
      .filter((b) => b.activeNodes > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (sorted.length > 0) {
      parts.push('', '**Top engrams:**');
      for (const row of sorted) {
        const name = engrams.find((e) => e.graphId === row.graphId)?.displayName ?? row.graphId;
        parts.push(`- **${name}** \`${row.graphId}\`: ${row.score}/100`);
      }
    }
  } else {
    parts.push('', `_No engram matched "${hint}" — showing cortex-wide scores only._`);
  }

  const fixes = suggestVitalityFixes({
    overall: detailed.overall,
    pendingDuplicatePairs: detailed.pendingDuplicatePairs,
    byGraphBreakdown: detailed.byGraphBreakdown,
    trust: detailed.trust,
    cortexFactors: detailed.cortexFactors,
    focusGraphId: matched?.graphId ?? null,
  });
  if (fixes.length > 0) {
    parts.push('', '**Suggested fixes:**');
    for (let i = 0; i < fixes.length; i++) {
      parts.push(`${i + 1}. ${fixes[i]}`);
    }
  }

  parts.push('', '_Deterministic score from current graph state — no LLM, no recall._');
  return parts.join('\n');
}
