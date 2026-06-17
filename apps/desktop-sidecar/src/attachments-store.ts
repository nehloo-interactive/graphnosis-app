// File attachments — references to local files (or shared-drive paths)
// the user wants associated with memories WITHOUT ingesting the file
// content into the graph. The file stays where it is; Graphnosis stores
// only the path + a small amount of metadata.
//
// Storage: a JSON file at `<cortex>/attachments.json`. Atomic rewrite on
// every mutation. Encrypted at rest with the rest of the cortex when the
// cortex directory is itself in an encrypted volume (Apple FileVault, etc.).
// The file paths themselves are NOT sensitive content — they're pointers,
// not payloads — so the slightly weaker on-disk posture vs `.gai` is OK.
//
// Cross-device note: paths captured on one machine may not resolve on
// another. When the cortex syncs across devices, attachments stay in
// the file but their `lastVerifiedAt` falls behind on machines where the
// file isn't reachable. The UI badges these as "not on this device".

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ATTACHMENTS_FILE = 'attachments.json';

/**
 * One attachment record. Lightweight — just enough to display a card,
 * open the file in its native app, and reconcile across devices.
 */
export interface AttachmentRecord {
  /** UUID v4. Stable across edits; used as the React key in the UI. */
  id: string;
  /** Absolute file system path. macOS / POSIX / Windows paths all flow through here. */
  path: string;
  /**
   * Free-form kind tag — drives the icon + preview strategy. Kept open
   * so future kinds (figma URLs, OneNote `onenote:` URIs, Notion exports,
   * cloud-storage virtual paths) slot in without changing the schema.
   */
  kind: 'image' | 'pdf' | 'doc' | 'spreadsheet' | 'video' | 'audio' | 'archive' | 'code' | 'onenote' | 'other';
  /** Display label — usually filename, but the user can rename. */
  label: string;
  /** Optional one-line note explaining why this file is attached. */
  note?: string;
  /** Engram this attachment lives in. Required — engram-scoped sharing
   *  carries attachments along; sensitive-engram attachments get the
   *  same redaction treatment as their parent engram. */
  graphId: string;
  /** When set, the attachment is bound to one source in that engram —
   *  e.g. "this PDF is the original of this Markdown ingest". */
  sourceId?: string;
  /** When set, the attachment is bound to specific nodes. Multiple nodes
   *  can share an attachment (e.g. a budget spreadsheet referenced by
   *  the Q3 forecast and the Q4 projection rows). */
  nodeIds?: string[];
  /** Unix ms when the attachment was created. */
  addedAt: number;
  /** Unix ms of last verification that the file exists at `path`. */
  lastVerifiedAt: number;
  /** True when the last verification found the file present. False when
   *  the file moved / was deleted / lives on a drive not mounted on this
   *  device. UIs render a "not on this device" badge for false. */
  lastVerifiedOk: boolean;
  /** Optional size in bytes captured at attach time. Informational. */
  sizeBytes?: number;
  /** Optional content hash (sha256) captured at attach time. Useful for
   *  detecting that the file was edited since attach. Computed lazily. */
  contentHash?: string;
}

export interface AttachInput {
  path: string;
  graphId: string;
  kind?: AttachmentRecord['kind'];
  label?: string;
  note?: string;
  sourceId?: string;
  nodeIds?: string[];
}

export interface ListFilter {
  graphId?: string;
  sourceId?: string;
  nodeIds?: string[];
}

/**
 * Append a new attachment record. The path is verified — if the file
 * isn't reachable, the record still saves but `lastVerifiedOk: false`
 * so the UI can flag it. Useful for cases where the user knows the file
 * will be there once a drive is mounted.
 */
export async function addAttachment(cortexDir: string, input: AttachInput): Promise<AttachmentRecord> {
  const existing = await readAll(cortexDir);
  const stat = await safeStat(input.path);
  const kind = input.kind ?? inferKindFromPath(input.path);
  const label = input.label?.trim() || path.basename(input.path) || input.path;
  const record: AttachmentRecord = {
    id: randomUUID(),
    path: input.path,
    kind,
    label,
    ...(input.note ? { note: input.note } : {}),
    graphId: input.graphId,
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    ...(input.nodeIds && input.nodeIds.length > 0 ? { nodeIds: input.nodeIds } : {}),
    addedAt: Date.now(),
    lastVerifiedAt: Date.now(),
    lastVerifiedOk: stat !== null,
    ...(stat ? { sizeBytes: stat.size } : {}),
  };
  await writeAll(cortexDir, [...existing, record]);
  return record;
}

/**
 * Update an existing attachment — rename, edit note, refresh verification,
 * attach to additional nodes. Returns the updated record or null if the
 * id wasn't found.
 */
export async function updateAttachment(
  cortexDir: string,
  id: string,
  patch: Partial<Pick<AttachmentRecord, 'label' | 'note' | 'nodeIds' | 'sourceId' | 'kind'>>,
): Promise<AttachmentRecord | null> {
  const all = await readAll(cortexDir);
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const current = all[idx]!;
  const updated: AttachmentRecord = {
    ...current,
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.nodeIds !== undefined ? { nodeIds: patch.nodeIds } : {}),
    ...(patch.sourceId !== undefined ? { sourceId: patch.sourceId } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
  };
  all[idx] = updated;
  await writeAll(cortexDir, all);
  return updated;
}

/**
 * Re-verify an attachment's file presence. Updates `lastVerifiedAt`
 * + `lastVerifiedOk` (and sizeBytes if reachable) and persists. Cheap;
 * called when the user opens an attachment surface so badges stay
 * accurate without a background verifier.
 */
export async function verifyAttachment(cortexDir: string, id: string): Promise<AttachmentRecord | null> {
  const all = await readAll(cortexDir);
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  const current = all[idx]!;
  const stat = await safeStat(current.path);
  const updated: AttachmentRecord = {
    ...current,
    lastVerifiedAt: Date.now(),
    lastVerifiedOk: stat !== null,
    ...(stat ? { sizeBytes: stat.size } : {}),
  };
  all[idx] = updated;
  await writeAll(cortexDir, all);
  return updated;
}

export async function removeAttachment(cortexDir: string, id: string): Promise<boolean> {
  const all = await readAll(cortexDir);
  const next = all.filter((a) => a.id !== id);
  if (next.length === all.length) return false;
  await writeAll(cortexDir, next);
  return true;
}

export async function listAttachments(cortexDir: string, filter: ListFilter = {}): Promise<AttachmentRecord[]> {
  const all = await readAll(cortexDir);
  return all.filter((a) => {
    if (filter.graphId && a.graphId !== filter.graphId) return false;
    if (filter.sourceId && a.sourceId !== filter.sourceId) return false;
    if (filter.nodeIds && filter.nodeIds.length > 0) {
      const nodes = a.nodeIds ?? [];
      if (!filter.nodeIds.some((n) => nodes.includes(n))) return false;
    }
    return true;
  });
}

async function readAll(cortexDir: string): Promise<AttachmentRecord[]> {
  try {
    const raw = await fs.readFile(path.join(cortexDir, ATTACHMENTS_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
}

async function writeAll(cortexDir: string, records: AttachmentRecord[]): Promise<void> {
  // Atomic-ish rewrite: write to a temp sibling then rename. Single
  // process, single cortex — no need for fcntl-locking.
  const target = path.join(cortexDir, ATTACHMENTS_FILE);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(records, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

async function safeStat(p: string): Promise<{ size: number } | null> {
  try {
    const s = await fs.stat(p);
    return { size: s.size };
  } catch {
    return null;
  }
}

/**
 * Best-effort kind inference from a path's extension. Falls back to
 * 'other' for unknown extensions. Open scheme paths (onenote://) get
 * tagged 'onenote'.
 */
function inferKindFromPath(p: string): AttachmentRecord['kind'] {
  if (p.startsWith('onenote:')) return 'onenote';
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.png': case '.jpg': case '.jpeg': case '.gif': case '.webp': case '.svg':
    case '.bmp': case '.tiff': case '.heic':
      return 'image';
    case '.pdf':
      return 'pdf';
    case '.doc': case '.docx': case '.rtf': case '.odt': case '.pages':
      return 'doc';
    case '.xls': case '.xlsx': case '.csv': case '.tsv': case '.numbers':
      return 'spreadsheet';
    case '.mp4': case '.mov': case '.mkv': case '.webm': case '.avi':
      return 'video';
    case '.mp3': case '.wav': case '.m4a': case '.flac': case '.ogg':
      return 'audio';
    case '.zip': case '.tar': case '.gz': case '.bz2': case '.7z':
      return 'archive';
    case '.ts': case '.tsx': case '.js': case '.jsx': case '.py': case '.rs':
    case '.go': case '.java': case '.c': case '.cpp': case '.h': case '.swift':
    case '.kt': case '.rb': case '.php':
      return 'code';
    default:
      return 'other';
  }
}
