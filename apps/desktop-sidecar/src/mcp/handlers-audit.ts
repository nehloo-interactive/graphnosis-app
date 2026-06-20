/**
 * MCP audit-domain tool handlers (memory hygiene, compliance recall, brain journal).
 * Wired from mcp-server.ts dispatch — returns null when the tool name is outside this domain.
 */

import { z } from 'zod';
import type { GraphnosisHost } from '../host.js';
import type { BrainEngine } from '../brain-engine.js';
import type { LicenseValidator } from '../license-validator.js';
import { withEmbedding } from '../embedding-queue.js';

export type McpToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function mcpError(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export const RecallAsOfInput = z.preprocess(
  (raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return raw;
    const r = raw as Record<string, unknown>;
    if (!r.query && (r.q || r.question)) return { ...r, query: r.q ?? r.question };
    if (r.as_of_seq === undefined && r.asOfSeq !== undefined) return { ...r, as_of_seq: r.asOfSeq };
    if (r.as_of_ts === undefined && r.asOfTs !== undefined) return { ...r, as_of_ts: r.asOfTs };
    if (r.graphId === undefined && r.engram !== undefined) return { ...r, graphId: r.engram };
    return raw;
  },
  z.object({
    query: z.string(),
    graphId: z.string().optional(),
    as_of_seq: z.coerce.number().int().nonnegative().optional(),
    as_of_ts: z.coerce.number().int().nonnegative().optional(),
    maxNodes: z.coerce.number().int().positive().max(50).optional(),
  }).refine((d) => d.as_of_seq !== undefined || d.as_of_ts !== undefined, {
    message: 'Provide as_of_seq or as_of_ts (op-log boundary for point-in-time recall).',
  }),
);

export const AuditMemoryInput = z.object({
  engrams: z.array(z.string()).optional(),
  threshold: z.coerce.number().min(0.5).max(1.0).optional(),
});

export const CheckDuplicateInput = z.object({
  text: z.string(),
  engram: z.string().optional(),
  threshold: z.coerce.number().min(0.5).max(1.0).optional(),
});

export const DuplicatePairsInput = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
});

export const ContradictionPairsInput = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
});

export const HealingJournalInput = z.object({
  limit: z.coerce.number().int().positive().max(50).optional(),
});

export const AUDIT_MCP_TOOL_NAMES = new Set([
  'recall_as_of',
  'audit_memory',
  'check_duplicate',
  'duplicate_pairs',
  'contradiction_pairs',
  'healing_journal',
]);

export interface AuditMcpDeps {
  host: GraphnosisHost;
  brainEngine?: BrainEngine | null;
  licenseValidator?: LicenseValidator | null;
}

export interface AuditMcpHelpers {
  getEffectiveLicenseToken: (deps: AuditMcpDeps) => Promise<string | null>;
  resolveEngramList: (host: GraphnosisHost, names: string[]) => { resolved: string[]; warnings: string[] };
  requireEngram: (host: GraphnosisHost, name: string) => { graphId: string } | { error: McpToolResult };
}

async function getEffectiveLicenseToken(deps: AuditMcpDeps): Promise<string | null> {
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

/** Dispatch audit-domain MCP tools; null when `name` is not handled here. */
export async function dispatchAuditMcpTool(
  name: string,
  rawInput: Record<string, unknown>,
  deps: AuditMcpDeps,
  helpers: AuditMcpHelpers,
): Promise<McpToolResult | null> {
  if (!AUDIT_MCP_TOOL_NAMES.has(name)) return null;

  switch (name) {
    case 'recall_as_of': {
      const licenseToken = await helpers.getEffectiveLicenseToken(deps);
      const hasEnterprise = deps.licenseValidator?.hasFeature(licenseToken, 'enterprise') ?? false;
      if (!hasEnterprise) {
        return mcpError('recall_as_of requires an Enterprise license (Compliance Mode).');
      }
      const args = RecallAsOfInput.parse(rawInput);
      const { recallAsOf } = await import('../compliance.js');
      const result = await recallAsOf(deps.host, args.query, {
        ...(args.graphId ? { graphId: args.graphId } : {}),
        ...(args.as_of_seq !== undefined ? { asOfSeq: args.as_of_seq } : {}),
        ...(args.as_of_ts !== undefined ? { asOfTs: args.as_of_ts } : {}),
        ...(args.maxNodes !== undefined ? { maxNodes: args.maxNodes } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    case 'audit_memory': {
      const licenseToken = await helpers.getEffectiveLicenseToken(deps);
      const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
      if (!licensed) {
        return mcpError(
          'audit_memory requires a Graphnosis Pro subscription. ' +
          'Subscribe at https://graphnosis.com/upgrade.',
        );
      }
      const args = AuditMemoryInput.parse(rawInput);
      const threshold = args.threshold ?? 0.85;
      let graphIds = deps.host.listGraphs().filter((id) => {
        const m = deps.host.getGraphMetadata(id);
        return !(m as { archived?: boolean })?.archived && (m as { sensitivityTier?: string })?.sensitivityTier !== 'sensitive';
      });
      if (args.engrams?.length) {
        const { resolved } = helpers.resolveEngramList(deps.host, args.engrams);
        graphIds = graphIds.filter((id) => resolved.includes(id));
      }
      const duplicates: string[] = [];
      const graphPairs: Array<[string, string]> = [];
      for (let i = 0; i < graphIds.length; i++) {
        for (let j = i + 1; j < graphIds.length; j++) {
          const a = graphIds[i];
          const b = graphIds[j];
          if (a && b) graphPairs.push([a, b]);
        }
      }
      for (const [a, b] of graphPairs) {
        const nodesA = deps.host.listNodes(a) as Array<{ id: string; confidence?: number; contentPreview?: string; text?: string }>;
        const activeA = nodesA.filter((n) => (n.confidence ?? 1) > 0.2).slice(0, 5);
        for (const node of activeA) {
          const nodeText = (node.contentPreview ?? node.text ?? '').toString();
          if (!nodeText) continue;
          const hits = await withEmbedding(() => deps.host.searchNodes(b, nodeText, 3));
          for (const hit of hits) {
            if (hit.score >= threshold) {
              const srcA = deps.host.getNodeSource(a, node.id);
              const srcB = deps.host.getNodeSource(b, hit.nodeId);
              duplicates.push(
                `Score ${hit.score.toFixed(2)} | ${deps.host.getGraphMetadata(a)?.displayName ?? a}${srcA ? ` [${srcA}]` : ''} ↔ ${deps.host.getGraphMetadata(b)?.displayName ?? b}${srcB ? ` [${srcB}]` : ''}\n  "${nodeText.slice(0, 80)}…"`,
              );
              if (duplicates.length >= 20) break;
            }
          }
          if (duplicates.length >= 20) break;
        }
        if (duplicates.length >= 20) break;
      }
      return {
        content: [{
          type: 'text',
          text: duplicates.length
            ? `Found ${duplicates.length} near-duplicate pair(s) (threshold ${threshold}):\n\n${duplicates.join('\n\n')}`
            : `No near-duplicates found across ${graphIds.length} engram(s) at threshold ${threshold}.`,
        }],
      };
    }
    case 'check_duplicate': {
      const args = CheckDuplicateInput.parse(rawInput);
      const threshold = args.threshold ?? 0.85;
      let graphIds = deps.host.listGraphs();
      if (args.engram) {
        const res = helpers.requireEngram(deps.host, args.engram);
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
      return {
        content: [{
          type: 'text',
          text: hits.length
            ? `Similar content found — consider calling edit instead of remember:\n\n${hits.join('\n\n')}`
            : `No duplicates found above threshold ${threshold}. Safe to call remember.`,
        }],
      };
    }
    case 'duplicate_pairs': {
      if (!deps.brainEngine) {
        return mcpError('Brain engine is not available. Open the Graphnosis app to enable it.');
      }
      const licenseToken = await helpers.getEffectiveLicenseToken(deps);
      const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
      if (!licensed) {
        return mcpError(
          'duplicate_pairs requires a Graphnosis Pro subscription. ' +
          'Subscribe at https://graphnosis.com/upgrade.',
        );
      }
      const args = DuplicatePairsInput.parse(rawInput);
      const pairs = deps.brainEngine.getDuplicatePairs().slice(0, args.limit ?? 20);
      if (!pairs.length) {
        return { content: [{ type: 'text', text: 'No duplicate pairs queued for review.' }] };
      }
      const rows = pairs.map((p: {
        id?: string;
        score?: number;
        nodeA?: unknown;
        nodeAId?: string;
        graphIdA?: string;
        nodeB?: unknown;
        nodeBId?: string;
        graphIdB?: string;
      }) =>
        `• [${p.id}] score ${p.score?.toFixed(2) ?? '?'}\n` +
        `  A: "${String(typeof p.nodeA === 'object' && p.nodeA && 'text' in (p.nodeA as object) ? (p.nodeA as { text?: string }).text : p.nodeAId ?? '').slice(0, 80)}" (${p.graphIdA})\n` +
        `  B: "${String(typeof p.nodeB === 'object' && p.nodeB && 'text' in (p.nodeB as object) ? (p.nodeB as { text?: string }).text : p.nodeBId ?? '').slice(0, 80)}" (${p.graphIdB})`,
      ).join('\n\n');
      return {
        content: [{
          type: 'text',
          text:
            `${pairs.length} duplicate pair(s) awaiting review:\n\n${rows}\n\n` +
            'To resolve: call edit to merge, or forget(nodeIds=[nodeId]) to remove one side.',
        }],
      };
    }
    case 'contradiction_pairs': {
      if (!deps.brainEngine) {
        return mcpError('Brain engine is not available. Open the Graphnosis app to enable it.');
      }
      const licenseToken = await helpers.getEffectiveLicenseToken(deps);
      const licensed = deps.licenseValidator?.hasFeature(licenseToken, 'foresight') ?? false;
      if (!licensed) {
        return mcpError(
          'contradiction_pairs requires a Graphnosis Pro subscription. ' +
          'Subscribe at https://graphnosis.com/upgrade.',
        );
      }
      const args = ContradictionPairsInput.parse(rawInput);
      const getter = (deps.brainEngine as { getContradictionPairs?: () => unknown[] }).getContradictionPairs?.bind(deps.brainEngine);
      const pairs = (getter ? getter() : []).slice(0, args.limit ?? 20) as Array<{
        id?: string;
        description?: string;
        graphId?: string;
        nodeA?: string;
        nodeB?: string;
        snippetA?: string;
        snippetB?: string;
        sharedEntities?: string[];
      }>;
      if (!pairs.length) {
        return { content: [{ type: 'text', text: 'No contradictions queued for review. (The reflection scan runs every 6h and on a built cortex; if you just ingested, give it a pass.)' }] };
      }
      const rows = pairs.map((p) =>
        `• [${p.id}] ${p.description ?? 'Potential contradiction'} (${p.graphId})\n` +
        `  A [${p.nodeA}]: "${(p.snippetA ?? '').toString().slice(0, 100)}"\n` +
        `  B [${p.nodeB}]: "${(p.snippetB ?? '').toString().slice(0, 100)}"\n` +
        `  shared: ${(p.sharedEntities ?? []).join(', ')}`,
      ).join('\n\n');
      return {
        content: [{
          type: 'text',
          text:
            `${pairs.length} contradiction(s) awaiting review:\n\n${rows}\n\n` +
            'To resolve: call edit to supersede the OUTDATED side (newer attested wins) — ' +
            'do NOT add a third conflicting note. If both are still true, they may be context-dependent; ' +
            'surface to the user to adjudicate.',
        }],
      };
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
      const rows = journal.map((r: { healedAt?: number; at?: number; kind?: string; type?: string; graphId?: string; summary?: unknown }) =>
        `• ${new Date(r.healedAt ?? r.at ?? 0).toISOString()}  ${r.kind ?? r.type ?? 'heal'}  ${r.graphId ?? ''}  ${(r.summary ?? JSON.stringify(r)).toString().slice(0, 100)}`,
      ).join('\n');
      return { content: [{ type: 'text', text: `Healing journal (${journal.length} record(s)):\n\n${rows}` }] };
    }
    default:
      return null;
  }
}