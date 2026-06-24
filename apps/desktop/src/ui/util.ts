export function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

/** Build the ` data-pres-source="…"` attribute fragment (empty when unknown). */
export function presSourceAttr(sourceId: string | undefined): string {
  return sourceId ? ` data-pres-source="${escape(sourceId)}"` : '';
}

/** Ghampus Presentation Mode surfaces (see main.ts PresSurface). */
export const PRES_GHAMPUS_CHAT = 'ghampusChat';
export const PRES_GHAMPUS_PANELS = 'ghampusPanels';

export type PresTagKind = 'engram' | 'source' | 'node' | 'skill' | 'goal' | 'surface';

/** Build a ` data-pres="…"` attribute (plus optional engram/source scoping). */
export function presAttr(
  kind: PresTagKind,
  id: string,
  extras?: { engram?: string; source?: string },
): string {
  let s = ` data-pres="${kind}:${escape(id)}"`;
  if (extras?.engram) s += ` data-pres-engram="${escape(extras.engram)}"`;
  if (extras?.source) s += ` data-pres-source="${escape(extras.source)}"`;
  return s;
}

export function presSurfaceAttr(surface: string): string {
  return presAttr('surface', surface);
}

export function presEngramAttr(graphId: string): string {
  return presAttr('engram', graphId);
}

export function presSkillAttr(sourceId: string, graphId?: string): string {
  return presAttr('skill', sourceId, graphId ? { engram: graphId } : undefined);
}

export function presNodeAttr(nodeId: string, graphId?: string, sourceId?: string): string {
  const extras: { engram?: string; source?: string } = {};
  if (graphId) extras.engram = graphId;
  if (sourceId) extras.source = sourceId;
  return presAttr('node', nodeId, extras);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Alias used by activity atlas log renderer. */
export const escHtml = escapeHtml;

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function relativeTimeShort(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.max(1, Math.floor(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
