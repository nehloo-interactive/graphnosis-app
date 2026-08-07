/**
 * Per-skill Role — short focus line stored in the training metadata comment.
 * Pure helpers only (no host / cortex). Cap matches the skills-library column.
 */

/** Max length for a per-skill Role focus line (skills-library column width). */
export const SKILL_ROLE_MAX_CHARS = 40;

export interface ParsedSkillMeta {
  trainedAt?: string;
  mode?: string;
  recallBreadth?: number;
  influentialNodes?: number;
  modelTarget?: string;
  role?: string;
}

export interface SkillMetadataFields {
  trainedAt: string;
  mode: string;
  influentialNodes?: number;
  modelTarget?: string;
  recallBreadth?: number;
  role?: string;
}

/** Trim, collapse whitespace, and cap a Role at SKILL_ROLE_MAX_CHARS. */
export function normalizeSkillRole(role: string | null | undefined): string | undefined {
  if (role == null) return undefined;
  const trimmed = role.trim().replace(/\s+/g, ' ');
  if (!trimmed) return undefined;
  return trimmed.slice(0, SKILL_ROLE_MAX_CHARS);
}

/** Build the HTML training-metadata comment written as the skill's first node. */
export function buildSkillMetadataComment(fields: SkillMetadataFields): string {
  const lines = [
    `<!-- Graphnosis skill training metadata`,
    `     trainedAt: ${fields.trainedAt}`,
    `     mode: ${fields.mode}`,
  ];
  if (fields.influentialNodes !== undefined) {
    lines.push(`     influentialNodes: ${fields.influentialNodes}`);
  }
  if (fields.modelTarget !== undefined) {
    lines.push(`     modelTarget: ${fields.modelTarget}`);
  }
  if (fields.recallBreadth !== undefined) {
    lines.push(`     recallBreadth: ${fields.recallBreadth}`);
  }
  const role = normalizeSkillRole(fields.role);
  if (role !== undefined) lines.push(`     role: ${role}`);
  lines.push(`-->`);
  return lines.join('\n');
}

export function parseSkillMetadata(text: string): ParsedSkillMeta {
  const result: ParsedSkillMeta = {};
  const match = text.match(/<!--\s*Graphnosis skill training metadata([\s\S]*?)-->/u);
  if (!match) return result;
  const block = match[1]!;
  const get = (key: string): string | undefined => {
    const m = block.match(new RegExp(`${key}:\\s*(.+)`, 'u'));
    return m?.[1]?.trim();
  };
  const ta = get('trainedAt'); if (ta !== undefined) result.trainedAt = ta;
  const mo = get('mode'); if (mo !== undefined) result.mode = mo;
  const rb = get('recallBreadth');
  if (rb !== undefined && rb !== 'undefined') result.recallBreadth = Number(rb);
  const inf = get('influentialNodes');
  if (inf !== undefined && inf !== 'undefined') result.influentialNodes = Number(inf);
  const mt = get('modelTarget'); if (mt !== undefined) result.modelTarget = mt;
  const role = get('role');
  if (role !== undefined) {
    const normalized = normalizeSkillRole(role);
    if (normalized !== undefined) result.role = normalized;
  }
  return result;
}
