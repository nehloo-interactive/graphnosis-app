/** Ghampus recall prompt / structured-node helpers — keep audit meta out of user answers. */

export type StructuredRecallNode = {
  text?: string;
  engram?: string;
  graphId?: string;
  sourceId?: string;
  score?: number;
};

/** Internal recall audit lines — not user memory. */
export function isRecallAuditMeta(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^enriched:\s/i.test(t)) return true;
  if (/^_(?:enriched|anchored|GNN expanded)/i.test(t)) return true;
  if (/^💡\s/.test(t)) return true;
  return false;
}

/** Strip enrichment / anchor / GNN / filename-hint footers from prose recall. */
export function stripRecallAuditTrail(raw: string): string {
  return raw
    .replace(/^_?enriched:\s*"[^"]*"\s*→\s*"[^"]*"_?\s*$/gim, '')
    .replace(/^_anchored \d+ node\(s\) on entities:.*_$/gim, '')
    .replace(/^_GNN expanded recall by \d+ node\(s\).*?_$/gim, '')
    .replace(/^💡 _[\s\S]*?_\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sourceLabelFromId(sourceId: string | undefined): string {
  if (!sourceId) return '';
  return sourceId
    .replace(/^skill:\d+:/, '')
    .replace(/^[^:]+:[^:]+:/, '')
    .replace(/-/g, ' ')
    .trim();
}

export function formatNodeBullet(n: StructuredRecallNode): string {
  const body = (n.text ?? '').trim().replace(/\s+/g, ' ');
  const where = n.engram ?? n.graphId ?? 'cortex';
  const src = sourceLabelFromId(n.sourceId);
  return `- ${body} _(from ${where}${src && src !== where ? ` · ${src}` : ''})_`;
}

/** Drop audit meta and obvious query-polarity mismatches before synthesis / fallback. */
export function filterStructuredRecallNodes(
  nodes: StructuredRecallNode[],
  query: string,
): StructuredRecallNode[] {
  let filtered = nodes.filter((n) => !isRecallAuditMeta(n.text ?? ''));

  const ql = query.toLowerCase();
  const wantsUnpublished = /\bunpublished\b/.test(ql);
  const wantsPublished = /\bpublished\b/.test(ql.replace(/\bunpublished\b/g, ''));
  if (wantsUnpublished && !wantsPublished) {
    filtered = filtered.filter((n) => {
      const t = (n.text ?? '').toLowerCase();
      if (/\bunpublished\b/.test(t)) return true;
      if (/\bpublished\b/.test(t) && !/\bunpublished\b/.test(t)) return false;
      return true;
    });
  }

  if (/\btodos?\b/.test(ql)) {
    filtered = filtered.filter((n) => {
      const t = (n.text ?? '').toLowerCase();
      if (/\bpublished to npm\b/.test(t)) return false;
      if (/\bgithub release\b/.test(t) && /\bpublished\b/.test(t)) return false;
      return true;
    });
  }

  return filtered;
}

export function inferGroupDimension(query: string): string {
  const m = query.match(
    /\bby\s+(team\s+members?|members?|person|people|owner|assignee|author|category|status|engram|project)\b/i,
  );
  if (m?.[1]) return m[1].toLowerCase().replace(/\s+/g, ' ');
  return 'category';
}

export function inferOwnerFromNode(n: StructuredRecallNode): string {
  const text = n.text ?? '';
  const patterns = [
    /\b(?:assignee|owner|assigned to|team member|member|for):\s*([^\n,;(\[]+)/i,
    /\b@([\w.-]+)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const name = m?.[1]?.trim();
    if (name && name.length <= 60) return name;
  }
  return 'Unassigned';
}

export function formatStructuredRecallList(nodes: StructuredRecallNode[]): string {
  if (nodes.length === 0) return '';
  return `Found **${nodes.length}** matching memor${nodes.length === 1 ? 'y' : 'ies'} in your cortex:\n\n${nodes.map(formatNodeBullet).join('\n')}`;
}

export function formatGroupedRecallList(nodes: StructuredRecallNode[], query: string): string {
  if (nodes.length === 0) return '';
  const dimension = inferGroupDimension(query);
  const groups = new Map<string, StructuredRecallNode[]>();
  for (const n of nodes) {
    const key = inferOwnerFromNode(n);
    const list = groups.get(key) ?? [];
    list.push(n);
    groups.set(key, list);
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });
  const sections = sortedKeys.map((key) => {
    const items = groups.get(key) ?? [];
    return `### ${key}\n${items.map(formatNodeBullet).join('\n')}`;
  });
  return (
    `Found **${nodes.length}** matching memor${nodes.length === 1 ? 'y' : 'ies'}, grouped by ${dimension}:\n\n` +
    sections.join('\n\n')
  );
}

/** True when the LLM produced section headings for grouped-list mode. */
export function looksGroupedResponse(text: string): boolean {
  return /^#{1,3}\s+\S/m.test(text) || /^\*\*[^*\n]{2,60}\*\*\s*$/m.test(text);
}
