/**
 * SharePoint list → Organization Engram Catalog sync.
 *
 * Each SharePoint list row maps 1:1 to an `EngramCatalogEntry` (engram package).
 *
 * Column mapping (SharePoint internal name → catalog field):
 * | SharePoint column   | EngramCatalogEntry field | Notes |
 * |---------------------|--------------------------|-------|
 * | Title               | displayName              | Required |
 * | PackageId           | packageId                | Required; engram slug after install |
 * | Description         | description              | Optional |
 * | Region              | region                   | Optional facility label |
 * | Kind                | kind                     | `engram-package` or `hub-slice` |
 * | InstallMode         | installMode              | `merge-copy` or `federate-readonly` |
 * | SourceEngramId      | sourceEngramId           | Org hub engram for merge-copy |
 * | HubRef              | hubRef                   | Federated hub ref for hub-slice |
 * | RequiredGroups      | requiredIdpGroups        | Semicolon-separated IdP groups |
 * | MDMBundleId         | mdmBundleId              | MDM profile identifier |
 * | ITControlled        | itControlled             | Yes/true/1 → true |
 * | NoReshare           | noReshare                | Yes/true/1 → true |
 * | Published           | published                | No/false/0 → draft; default true |
 * | RequireSsoSession   | requireSsoSession        | Yes/true/1 → SSO unlock required |
 */

import type { EngramCatalogEntry } from '@graphnosis-app/core/settings';
import { generateCatalogEntryId, sanitizeEngramCatalogEntry } from '@graphnosis-app/core/settings';

export interface SharePointListTarget {
  siteUrl: string;
  listTitle: string;
}

export interface SharePointSyncResult {
  ok: boolean;
  entries: EngramCatalogEntry[];
  syncedAt: number;
  message?: string;
  reason?: string;
}

function parseBoolField(v: unknown, defaultValue: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultValue;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['yes', 'true', '1', 'y'].includes(s)) return true;
  if (['no', 'false', '0', 'n'].includes(s)) return false;
  return defaultValue;
}

/** Parse a SharePoint list URL into site base + list title. */
export function parseSharePointListUrl(listUrl: string): SharePointListTarget | null {
  const trimmed = listUrl.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const parts = u.pathname.split('/').filter(Boolean);
    const listsIdx = parts.findIndex((p) => p.toLowerCase() === 'lists');
    if (listsIdx >= 0 && parts.length > listsIdx + 1) {
      const listTitle = decodeURIComponent(parts[listsIdx + 1]!);
      const sitePath = parts.slice(0, listsIdx).join('/');
      return {
        siteUrl: `${u.origin}/${sitePath}`,
        listTitle,
      };
    }
    // Site-relative: /sites/Team/Lists/Catalog
    if (parts.length >= 2) {
      const listTitle = decodeURIComponent(parts[parts.length - 1]!);
      const sitePath = parts.slice(0, -1).join('/');
      return {
        siteUrl: `${u.origin}/${sitePath}`,
        listTitle,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function fieldValue(fields: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (fields[name] !== undefined) return fields[name];
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(fields)) {
      if (k.toLowerCase() === lower) return v;
    }
  }
  return undefined;
}

function splitGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((g): g is string => typeof g === 'string').map((g) => g.trim()).filter(Boolean);
  }
  if (typeof raw !== 'string') return [];
  return raw.split(/[;,|\n]+/).map((g) => g.trim()).filter(Boolean);
}

/** Map one SharePoint list item `fields` object to a catalog entry. */
export function sharePointRowToCatalogEntry(
  fields: Record<string, unknown>,
  existingByPackageId: Map<string, EngramCatalogEntry>,
): EngramCatalogEntry | null {
  const packageId = String(fieldValue(fields, 'PackageId', 'packageId') ?? '').trim();
  const displayName = String(fieldValue(fields, 'Title', 'displayName') ?? '').trim();
  if (!packageId || !displayName) return null;

  const kindRaw = String(fieldValue(fields, 'Kind', 'kind') ?? 'engram-package').trim().toLowerCase();
  const kind = kindRaw === 'hub-slice' ? 'hub-slice' : 'engram-package';
  const installRaw = String(fieldValue(fields, 'InstallMode', 'installMode') ?? '').trim().toLowerCase();
  let installMode: 'merge-copy' | 'federate-readonly' = kind === 'hub-slice' ? 'federate-readonly' : 'merge-copy';
  if (installRaw === 'federate-readonly' || installRaw === 'merge-copy') installMode = installRaw;

  const existing = existingByPackageId.get(packageId);
  return sanitizeEngramCatalogEntry({
    id: existing?.id ?? generateCatalogEntryId(),
    packageId,
    displayName,
    kind,
    installMode,
    requiredIdpGroups: splitGroups(fieldValue(fields, 'RequiredGroups', 'requiredIdpGroups', 'RequiredIdpGroups')),
    itControlled: parseBoolField(fieldValue(fields, 'ITControlled', 'itControlled'), true),
    noReshare: parseBoolField(fieldValue(fields, 'NoReshare', 'noReshare'), true),
    published: parseBoolField(fieldValue(fields, 'Published', 'published'), true),
    ...(typeof fieldValue(fields, 'Description', 'description') === 'string'
      && String(fieldValue(fields, 'Description', 'description')).trim()
      ? { description: String(fieldValue(fields, 'Description', 'description')).trim() }
      : {}),
    ...(typeof fieldValue(fields, 'Region', 'region') === 'string'
      && String(fieldValue(fields, 'Region', 'region')).trim()
      ? { region: String(fieldValue(fields, 'Region', 'region')).trim() }
      : {}),
    ...(typeof fieldValue(fields, 'SourceEngramId', 'sourceEngramId') === 'string'
      && String(fieldValue(fields, 'SourceEngramId', 'sourceEngramId')).trim()
      ? { sourceEngramId: String(fieldValue(fields, 'SourceEngramId', 'sourceEngramId')).trim() }
      : {}),
    ...(typeof fieldValue(fields, 'HubRef', 'hubRef') === 'string'
      && String(fieldValue(fields, 'HubRef', 'hubRef')).trim()
      ? { hubRef: String(fieldValue(fields, 'HubRef', 'hubRef')).trim() }
      : {}),
    ...(typeof fieldValue(fields, 'MDMBundleId', 'mdmBundleId') === 'string'
      && String(fieldValue(fields, 'MDMBundleId', 'mdmBundleId')).trim()
      ? { mdmBundleId: String(fieldValue(fields, 'MDMBundleId', 'mdmBundleId')).trim() }
      : {}),
    ...(parseBoolField(fieldValue(fields, 'RequireSsoSession', 'requireSsoSession'), false)
      ? { requireSsoSession: true }
      : {}),
  });
}

export async function fetchSharePointCatalogEntries(
  listUrl: string,
  existingEntries: readonly EngramCatalogEntry[],
  accessToken?: string,
): Promise<SharePointSyncResult> {
  const target = parseSharePointListUrl(listUrl);
  if (!target) {
    return {
      ok: false,
      entries: [...existingEntries],
      syncedAt: Date.now(),
      reason: 'invalid_url',
      message: 'Could not parse SharePoint list URL.',
    };
  }

  const apiUrl = `${target.siteUrl}/_api/web/lists/getbytitle('${target.listTitle.replace(/'/g, "''")}')/items?$select=Id,Title,PackageId,Description,Region,Kind,InstallMode,SourceEngramId,HubRef,RequiredGroups,MDMBundleId,ITControlled,NoReshare,Published,RequireSsoSession&$top=500`;
  const headers: Record<string, string> = {
    Accept: 'application/json;odata=nometadata',
  };
  if (accessToken?.trim()) {
    headers.Authorization = `Bearer ${accessToken.trim()}`;
  }

  let body: { value?: Array<{ Id?: number; Title?: string; [key: string]: unknown }> };
  try {
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        entries: [...existingEntries],
        syncedAt: Date.now(),
        reason: 'fetch_failed',
        message: `SharePoint returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      };
    }
    body = await res.json() as typeof body;
  } catch (e) {
    return {
      ok: false,
      entries: [...existingEntries],
      syncedAt: Date.now(),
      reason: 'network_error',
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const existingByPackageId = new Map(existingEntries.map((e) => [e.packageId, e]));
  const pulled: EngramCatalogEntry[] = [];
  for (const row of body.value ?? []) {
    const fields = (row.fields && typeof row.fields === 'object')
      ? row.fields as Record<string, unknown>
      : row as Record<string, unknown>;
    const entry = sharePointRowToCatalogEntry(fields, existingByPackageId);
    if (entry) {
      existingByPackageId.set(entry.packageId, entry);
      pulled.push(entry);
    }
  }

  if (pulled.length === 0) {
    return {
      ok: false,
      entries: [...existingEntries],
      syncedAt: Date.now(),
      reason: 'empty_list',
      message: 'SharePoint list returned no valid catalog rows (need Title + PackageId).',
    };
  }

  // Merge: SharePoint rows replace same packageId; keep local-only rows not in SP.
  const pulledIds = new Set(pulled.map((e) => e.packageId));
  const retained = existingEntries.filter((e) => !pulledIds.has(e.packageId));
  return {
    ok: true,
    entries: [...retained, ...pulled],
    syncedAt: Date.now(),
    message: `Synced ${pulled.length} package${pulled.length === 1 ? '' : 's'} from SharePoint.`,
  };
}
