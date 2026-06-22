/** Ghampus turn trace — tool steps broadcast to the desktop UI while ghampus:send runs. */

import { isConsentGateMessage } from './ghampus-recall-format.js';

export type GhampusTraceStatus = 'running' | 'ok' | 'error' | 'skip';

export type GhampusTraceStep = {
  stepId: string;
  status: GhampusTraceStatus;
  label: string;
  tool?: string;
  preview?: string;
  ms?: number;
};

/** Full turn trace attached to ghampus.message for UI render / history reload. */
export type GhampusTurnTraceSnapshot = {
  turnId: string;
  startedAt: number;
  endedAt?: number;
  steps: GhampusTraceStep[];
  elapsedMs?: number;
};

export type GhampusTracePayload = {
  turnId: string;
  stepId: string;
  status: GhampusTraceStatus;
  label: string;
  tool?: string;
  preview?: string;
  ms?: number;
  ts: number;
  /** Elapsed ms since user sent the message */
  elapsedMs?: number;
};

export function ghampusTraceStepId(tool: string): string {
  return `${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function formatGhampusTraceLabel(tool: string, args: Record<string, unknown>): string {
  const q = String(args.query ?? args.content ?? args.keyword ?? '').trim();
  const shortQ = q.length > 48 ? `${q.slice(0, 45)}…` : q;
  switch (tool) {
    case 'recall':
    case 'remind':
    case 'dig_deeper':
    case 'recall_structured':
    case 'recall_obligations':
    case 'recall_with_citations':
    case 'cross_search':
      return shortQ ? `${tool} · "${shortQ}"` : tool;
    case 'recall_source':
      return `recall_source · ${String(args.sourceId ?? '').slice(0, 40)}`;
    case 'find_source':
      return `find_source · ${String(args.content ?? args.keyword ?? '').slice(0, 40)}`;
    case 'stats':
      return 'cortex stats';
    case 'recent':
      return 'recent ingests';
    case 'list_engrams':
      return 'list engrams';
    case 'list_skills':
      return 'list skills';
    case 'walk_skill':
      return 'walk skill';
    default:
      return tool;
  }
}

/** Human-readable MCP / Zod error text for trace previews (not raw JSON blobs). */
export function formatGhampusToolErrorPreview(errText: string): string {
  const trimmed = errText.trim();
  if (isConsentGateMessage(trimmed)) return 'consent needed — check Graphnosis app';
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return trimmed.slice(0, 120);
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const parts: string[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const path = Array.isArray(row.path) ? row.path.join('.') : '';
      const msg = String(row.message ?? row.code ?? '').trim();
      if (path === 'maxTokens' || /maxtokens/i.test(msg)) {
        parts.push('maxTokens must be ≤ 8000');
      } else if (path === 'query' || /expected string.*query/i.test(msg)) {
        parts.push('search query missing');
      } else if (path === 'graphId' || /graphId/i.test(path)) {
        parts.push('memory graph not specified');
      } else if (msg && !/invalid_type|received undefined|expected string/i.test(msg)) {
        parts.push(path ? `${path}: ${msg}` : msg);
      } else if (path) {
        parts.push(`${path} invalid`);
      }
    }
    if (parts.length > 0) return parts.join('; ').slice(0, 120);
  } catch { /* not JSON */ }
  if (/invalid input|expected string|zod/i.test(trimmed)) {
    return 'tool input validation failed';
  }
  return 'tool error';
}

export function summarizeGhampusToolResult(tool: string, result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  switch (tool) {
    case 'recall':
    case 'remind':
    case 'dig_deeper':
    case 'cross_search':
    case 'recall_with_citations':
      const nodes = Number(r.nodesIncluded ?? 0);
      return nodes > 0 ? `${nodes} nodes` : 'no hits';
    case 'recall_structured': {
      const nodes = (r.nodes as unknown[]) ?? [];
      return `${nodes.length} structured nodes`;
    }
    case 'recall_obligations': {
      const count = Number(r.count ?? (r.obligations as unknown[])?.length ?? 0);
      return count > 0 ? `${count} obligations` : 'no obligations';
    }
    case 'recall_source': {
      const text = String((r as { text?: string }).text ?? '');
      const chunks = (text.match(/---/g) ?? []).length;
      return chunks > 0 ? `full source · ${chunks + 1} chunks` : 'source loaded';
    }
    case 'find_source': {
      const sources = (r as { sources?: unknown[] }).sources ?? [];
      return `${sources.length} source(s)`;
    }
    case 'stats':
      return typeof r.totalNodes === 'number' ? `${r.totalNodes} total nodes` : 'stats ok';
    case 'recent': {
      const sources = (r as { sources?: unknown[] }).sources ?? [];
      return `${sources.length} recent`;
    }
    default:
      return '';
  }
}
