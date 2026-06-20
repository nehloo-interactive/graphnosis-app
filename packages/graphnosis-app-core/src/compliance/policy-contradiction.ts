/**
 * Deterministic policy-contradiction detection — nodes vs canonical policy sources.
 */

import type { SourceRecord } from '../types.js';
import type { GraphMetadata } from '../settings/index.js';

export interface PolicyContradictionCandidate {
  graphId: string;
  nodeId: string;
  canonicalNodeId: string;
  canonicalSourceId: string;
  sharedTokens: string[];
  reason: string;
}

const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'are', 'was', 'were',
  'not', 'but', 'you', 'your', 'must', 'shall', 'will', 'can', 'may',
]);

const NEGATION_MARKERS = ['not', 'never', 'forbidden', 'prohibited', 'disallowed', 'must not', 'shall not'];
const AFFIRMATION_MARKERS = ['must', 'required', 'shall', 'mandatory', 'always', 'allowed'];

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

function isCanonicalPolicySource(src: SourceRecord, meta?: GraphMetadata): boolean {
  const ref = src.ref.toLowerCase();
  if (ref.includes('policy:canonical') || ref.startsWith('tag:policy:canonical')) return true;
  if (meta?.template === 'skill' && src.kind === 'skill') return true;
  return false;
}

function hasMarker(text: string, markers: string[]): string | undefined {
  const lower = text.toLowerCase();
  for (const m of markers) {
    if (lower.includes(m)) return m;
  }
  return undefined;
}

function sharedSignificant(a: string, b: string): string[] {
  const ta = new Set(tokenize(a));
  const tb = tokenize(b);
  const shared: string[] = [];
  for (const t of tb) {
    if (ta.has(t)) shared.push(t);
  }
  return shared;
}

export function detectPolicyContradictions(input: {
  graphId: string;
  meta?: GraphMetadata;
  sources: SourceRecord[];
  nodePreview: (nodeId: string) => string | undefined;
}): PolicyContradictionCandidate[] {
  const canonicalNodes: Array<{ sourceId: string; nodeId: string; text: string }> = [];
  for (const src of input.sources) {
    if (!isCanonicalPolicySource(src, input.meta)) continue;
    for (const nodeId of src.nodeIds) {
      const text = input.nodePreview(nodeId);
      if (text?.trim()) canonicalNodes.push({ sourceId: src.sourceId, nodeId, text: text.trim() });
    }
  }
  if (canonicalNodes.length === 0) return [];

  const canonicalNodeIds = new Set(canonicalNodes.map((c) => c.nodeId));
  const out: PolicyContradictionCandidate[] = [];
  const seen = new Set<string>();

  for (const src of input.sources) {
    if (isCanonicalPolicySource(src, input.meta)) continue;
    for (const nodeId of src.nodeIds) {
      if (canonicalNodeIds.has(nodeId)) continue;
      const text = input.nodePreview(nodeId);
      if (!text?.trim()) continue;
      for (const canon of canonicalNodes) {
        const shared = sharedSignificant(canon.text, text);
        if (shared.length < 3) continue;
        const neg = hasMarker(text, NEGATION_MARKERS);
        const aff = hasMarker(canon.text, AFFIRMATION_MARKERS);
        if (!neg && !aff) continue;
        if (neg && aff) {
          const key = `${nodeId}|${canon.nodeId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            graphId: input.graphId,
            nodeId,
            canonicalNodeId: canon.nodeId,
            canonicalSourceId: canon.sourceId,
            sharedTokens: shared.slice(0, 8),
            reason: `Policy conflict: canonical requires "${aff}" but memory contains "${neg}" (shared: ${shared.slice(0, 3).join(', ')})`,
          });
        }
      }
    }
  }
  return out;
}
