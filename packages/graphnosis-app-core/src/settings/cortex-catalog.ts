/**
 * Enterprise Cortex Catalog — IT-published org cortices + hub packages (Phase 4).
 *
 * **Data controller model (SharePoint-like, explicit share only):**
 * - `personal` entries — employee is data controller on their personal cortex.
 * - `org` entries — IT / the organization is data controller on the org cortex;
 *   employees subscribe and unlock subject to IdP group gates.
 * - `hub-package` — read-only engram bundles in the catalog; org owns source
 *   content, employee controls whether to subscribe (v1: subscribe records intent;
 *   full engram pull ships in a follow-on).
 *
 * Catalog entries live in org cortex `AppSettings.cortexCatalog` (IT publishes).
 * Employee subscriptions are machine-local (`~/.graphnosis/catalog-subscriptions.json`).
 */

import { randomUUID } from 'node:crypto';
import type { SharingRole } from './rbac.js';
import { isSharingRole, normalizeSharingRole } from './rbac.js';
import type { EnterpriseSsoSettings } from './sso.js';
import { isEnterpriseSsoConfigured } from './sso.js';

export type CortexCatalogKind = 'org' | 'hub-package' | 'personal';

/** IT-published catalog row — visible to employees when `published` is true. */
export interface CortexCatalogEntry {
  /** Stable catalog entry id (UUID). */
  id: string;
  /** Logical cortex identifier (may differ from on-disk folder name). */
  cortexId: string;
  displayName: string;
  /** Region / facility label for division-scoped catalogs. */
  region?: string;
  kind: CortexCatalogKind;
  /**
   * IdP groups required to unlock or subscribe. Empty = any authenticated user
   * in the org tenant. Case-insensitive match at runtime.
   */
  requiredIdpGroups: string[];
  /** Default sharing role when unlocked via SSO (maps via groupRoleMappings). */
  defaultRole?: SharingRole;
  /** MDM bundle identifier for IT push profiles. */
  mdmBundleId?: string;
  /**
   * Hub-package engram ids (read-only bundles). v1 subscribe records intent only;
   * engram import from org hub is deferred.
   */
  hubPackageEngramIds: string[];
  /**
   * SSO profile reference. `'default'` or absent → cortex `sso` settings.
   * Future: named profiles in `cortexCatalog.ssoProfiles`.
   */
  ssoProfileRef?: string;
  /** Optional on-disk cortex folder path (lock-screen picker + MDM). */
  cortexPath?: string;
  /** When false, hidden from employee catalog (IT draft). Default true. */
  published?: boolean;
}

export interface CortexCatalogSettings {
  entries: CortexCatalogEntry[];
  /** Schema version for forward compat. */
  version?: number;
}

/** Machine-local subscription store (not in encrypted cortex). */
export interface CatalogSubscriptionStore {
  /** Catalog entry ids the user subscribed to on this machine. */
  subscribedCatalogIds: string[];
  updatedAt?: number;
}

export type CatalogEntitlementReason =
  | 'entitled'
  | 'not_subscribed'
  | 'missing_groups'
  | 'not_published'
  | 'not_found';

export interface CatalogEntitlement {
  catalogId: string;
  entry: CortexCatalogEntry;
  entitled: boolean;
  reason: CatalogEntitlementReason;
  /** Groups the user lacks when reason is `missing_groups`. */
  missingGroups?: string[];
}

/** MDM / plist JSON shape for IT push (one catalog entry). */
export interface MdmCatalogBundle {
  catalogId: string;
  mdmBundleId?: string;
  cortexPath?: string;
  sso: {
    issuer: string;
    tenantId?: string;
    clientId: string;
  };
  subscriptions: string[];
}

export const DEFAULT_CORTEX_CATALOG_SETTINGS: CortexCatalogSettings = {
  entries: [],
  version: 1,
};

export function generateCatalogEntryId(): string {
  return randomUUID();
}

function normalizeGroupSet(groups: readonly string[]): Set<string> {
  return new Set(groups.map((g) => g.trim().toLowerCase()).filter(Boolean));
}

/** True when the user belongs to at least one required group (or none required). */
export function userMeetsCatalogGroupRequirement(
  requiredIdpGroups: readonly string[],
  userGroups: readonly string[],
): { ok: boolean; missingGroups?: string[] } {
  const required = requiredIdpGroups.map((g) => g.trim()).filter(Boolean);
  if (required.length === 0) return { ok: true };
  const userSet = normalizeGroupSet(userGroups);
  const matched = required.some((g) => userSet.has(g.toLowerCase()));
  if (matched) return { ok: true };
  return { ok: false, missingGroups: [...required] };
}

/** Resolve unlock entitlement for a single catalog entry. */
export function checkCatalogUnlockEntitlement(
  entry: CortexCatalogEntry,
  userGroups: readonly string[],
): { entitled: boolean; reason: CatalogEntitlementReason; missingGroups?: string[] } {
  if (entry.published === false) {
    return { entitled: false, reason: 'not_published' };
  }
  const groupCheck = userMeetsCatalogGroupRequirement(entry.requiredIdpGroups, userGroups);
  if (!groupCheck.ok) {
    return {
      entitled: false,
      reason: 'missing_groups',
      ...(groupCheck.missingGroups ? { missingGroups: groupCheck.missingGroups } : {}),
    };
  }
  return { entitled: true, reason: 'entitled' };
}

/**
 * Employee catalog entitlements: published entries the user may unlock,
 * optionally filtered to subscribed ids (employee-driven catalog flow).
 */
export function resolveCatalogEntitlements(
  entries: readonly CortexCatalogEntry[],
  userGroups: readonly string[],
  subscribedCatalogIds?: readonly string[],
): CatalogEntitlement[] {
  const subSet = subscribedCatalogIds
    ? new Set(subscribedCatalogIds)
    : null;
  const out: CatalogEntitlement[] = [];
  for (const entry of entries) {
    if (entry.published === false) continue;
    if (subSet && !subSet.has(entry.id)) {
      out.push({
        catalogId: entry.id,
        entry,
        entitled: false,
        reason: 'not_subscribed',
      });
      continue;
    }
    const check = checkCatalogUnlockEntitlement(entry, userGroups);
    out.push({
      catalogId: entry.id,
      entry,
      entitled: check.entitled,
      reason: check.reason,
      ...(check.missingGroups ? { missingGroups: check.missingGroups } : {}),
    });
  }
  return out;
}

/** Match catalog entry for SSO unlock — by cortexPath, then cortexId, then id. */
export function findCatalogEntryForCortex(
  entries: readonly CortexCatalogEntry[],
  cortexPath: string,
  cortexId?: string,
): CortexCatalogEntry | undefined {
  const normPath = cortexPath.replace(/\/+$/, '');
  for (const e of entries) {
    if (e.cortexPath && e.cortexPath.replace(/\/+$/, '') === normPath) return e;
  }
  if (cortexId) {
    const hit = entries.find((e) => e.cortexId === cortexId || e.id === cortexId);
    if (hit) return hit;
  }
  // Org cortex unlock: if exactly one org entry points at this path prefix, use it.
  const orgEntries = entries.filter((e) => e.kind === 'org' && e.cortexPath);
  if (orgEntries.length === 1 && orgEntries[0]!.cortexPath!.replace(/\/+$/, '') === normPath) {
    return orgEntries[0];
  }
  return undefined;
}

export function buildMdmCatalogBundle(
  entry: CortexCatalogEntry,
  sso: EnterpriseSsoSettings | undefined,
  subscriptions: readonly string[],
): MdmCatalogBundle | null {
  const oidc = sso?.oidc;
  if (!isEnterpriseSsoConfigured(sso) || !oidc) return null;
  return {
    catalogId: entry.id,
    ...(entry.mdmBundleId ? { mdmBundleId: entry.mdmBundleId } : {}),
    ...(entry.cortexPath ? { cortexPath: entry.cortexPath } : {}),
    sso: {
      issuer: oidc.issuer.trim(),
      clientId: oidc.clientId.trim(),
      ...(oidc.oidcTenantId?.trim() ? { tenantId: oidc.oidcTenantId.trim() } : {}),
    },
    subscriptions: [...subscriptions],
  };
}

function isCatalogKind(v: unknown): v is CortexCatalogKind {
  return v === 'org' || v === 'hub-package' || v === 'personal';
}

function isCatalogEntry(v: unknown): v is CortexCatalogEntry {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const kind = r['kind'];
  const defaultRole = r['defaultRole'];
  return (
    typeof r['id'] === 'string' && r['id'].trim().length > 0
    && typeof r['cortexId'] === 'string' && r['cortexId'].trim().length > 0
    && typeof r['displayName'] === 'string' && r['displayName'].trim().length > 0
    && isCatalogKind(kind)
    && Array.isArray(r['requiredIdpGroups'])
    && r['requiredIdpGroups'].every((g) => typeof g === 'string')
    && Array.isArray(r['hubPackageEngramIds'])
    && r['hubPackageEngramIds'].every((g) => typeof g === 'string')
    && (defaultRole === undefined || (typeof defaultRole === 'string' && isSharingRole(defaultRole)))
  );
}

export function sanitizeCortexCatalogEntry(raw: Partial<CortexCatalogEntry>): CortexCatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : generateCatalogEntryId();
  const cortexId = typeof raw.cortexId === 'string' ? raw.cortexId.trim() : '';
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  if (!cortexId || !displayName || !isCatalogKind(raw.kind)) return null;
  const requiredIdpGroups = Array.isArray(raw.requiredIdpGroups)
    ? raw.requiredIdpGroups.map((g) => (typeof g === 'string' ? g.trim() : '')).filter(Boolean)
    : [];
  const hubPackageEngramIds = Array.isArray(raw.hubPackageEngramIds)
    ? raw.hubPackageEngramIds.filter((g): g is string => typeof g === 'string' && g.length > 0)
    : [];
  let defaultRole: SharingRole | undefined;
  if (typeof raw.defaultRole === 'string' && isSharingRole(raw.defaultRole)) {
    defaultRole = normalizeSharingRole(raw.defaultRole);
  }
  return {
    id,
    cortexId,
    displayName,
    kind: raw.kind,
    requiredIdpGroups,
    hubPackageEngramIds,
    ...(typeof raw.region === 'string' && raw.region.trim() ? { region: raw.region.trim() } : {}),
    ...(defaultRole ? { defaultRole } : {}),
    ...(typeof raw.mdmBundleId === 'string' && raw.mdmBundleId.trim()
      ? { mdmBundleId: raw.mdmBundleId.trim() }
      : {}),
    ...(typeof raw.ssoProfileRef === 'string' && raw.ssoProfileRef.trim()
      ? { ssoProfileRef: raw.ssoProfileRef.trim() }
      : {}),
    ...(typeof raw.cortexPath === 'string' && raw.cortexPath.trim()
      ? { cortexPath: raw.cortexPath.trim() }
      : {}),
    published: raw.published !== false,
  };
}

export function sanitizeCortexCatalogSettings(
  raw: Partial<CortexCatalogSettings> | undefined,
): CortexCatalogSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const entries = Array.isArray(raw.entries)
    ? raw.entries.map((e) => sanitizeCortexCatalogEntry(e as Partial<CortexCatalogEntry>)).filter(Boolean) as CortexCatalogEntry[]
    : [];
  return {
    entries,
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

/** Public catalog row for employee IPC (no internal draft fields stripped). */
export function cortexCatalogPublicEntry(entry: CortexCatalogEntry): CortexCatalogEntry {
  return { ...entry };
}
