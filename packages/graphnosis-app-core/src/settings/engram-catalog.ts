/**
 * Organization Engram Catalog — IT-published engram packages only (Phase 4).
 *
 * **Product model:** one cortex per user; catalog rows are engram packages
 * (e.g. DevOps Skills, Compliance baseline) the employee adds to their cortex.
 * Subscribe = "Add to my cortex". SSO IdP groups gate install entitlement, not
 * which folder to unlock. Org cortex as a catalog item is out of scope (MDM only).
 *
 * **SharePoint sync note:** a SharePoint list row maps 1:1 to an engram package
 * entry — not a cortex folder or org-cortex row type.
 *
 * **Data controller:** IT on `itControlled` org packages; employee on personal
 * engrams. Explicit share only — org packages set `noReshare`.
 *
 * Catalog entries live in cortex `AppSettings.engramCatalog` (IT publishes).
 * Employee subscriptions + install state are machine-local
 * (`~/.graphnosis/catalog-subscriptions.json`).
 */

import { randomUUID } from 'node:crypto';
import type { SharingRole } from './rbac.js';
import { isSharingRole, normalizeSharingRole } from './rbac.js';
import type { EnterpriseSsoSettings } from './sso.js';
import { hasActiveSsoUnlockSession, isEnterpriseSsoConfigured } from './sso.js';

export type EngramCatalogKind = 'engram-package' | 'hub-slice';

export type EngramInstallMode = 'merge-copy' | 'federate-readonly';

/** IT-published catalog row — visible to employees when `published` is true. */
export interface EngramCatalogEntry {
  /** Stable catalog entry id (UUID). */
  id: string;
  /** Logical package identifier (engram slug after install). */
  packageId: string;
  displayName: string;
  description?: string;
  /** Region / facility label for division-scoped catalogs. */
  region?: string;
  kind: EngramCatalogKind;
  /**
   * IdP groups required to subscribe / install. Empty = any authenticated user
   * in the org tenant. Case-insensitive match at runtime.
   */
  requiredIdpGroups: string[];
  /** Default sharing role for collaborators on installed content. */
  defaultRole?: SharingRole;
  /** How the package lands in the active cortex. */
  installMode: EngramInstallMode;
  /** Source engram id for merge-copy packages (org hub). */
  sourceEngramId?: string;
  /** Federated read-only hub reference for hub-slice packages. */
  hubRef?: string;
  /** GSK pack id lineage for drift detection (SharePoint / MDM). */
  packId?: string;
  /** Semver of the published catalog package (SharePoint / MDM). */
  catalogVersion?: string;
  /** IT / org is data controller (typical for org packages). */
  itControlled: boolean;
  /** Employees may not ad-hoc re-share org catalog content. */
  noReshare: boolean;
  /** MDM bundle identifier for IT push profiles. */
  mdmBundleId?: string;
  /** When false, hidden from employee catalog (IT draft). Default true. */
  published?: boolean;
  /** Fixed classification label for IT-controlled catalog installs (schema label id). */
  defaultClassificationLabelId?: string;
  /**
   * When true, subscribe/install and recall into the installed engram require
   * an Enterprise IdP unlock for this session (not passphrase-only break-glass).
   * Default false when absent.
   */
  requireSsoSession?: boolean;
}

/** Optional SharePoint list provider for IT catalog sync (cached in cortex settings). */
export interface EngramCatalogSharePointSettings {
  /** Full SharePoint list URL (AllItems.aspx or site-relative list path). */
  listUrl?: string;
  /** Optional bearer token for SharePoint REST (org-managed; not exposed via MCP). */
  accessToken?: string;
  lastSyncedAt?: number;
  lastSyncError?: string;
  lastSyncEntryCount?: number;
}

export interface EngramCatalogSettings {
  entries: EngramCatalogEntry[];
  /** Schema version for forward compat. */
  version?: number;
  /** SharePoint catalog provider state + last sync cache. */
  sharePoint?: EngramCatalogSharePointSettings;
}

/** Machine-local subscription + install store (not in encrypted cortex). */
export interface CatalogSubscriptionStore {
  /** Catalog entry ids the user subscribed to on this machine. */
  subscribedCatalogIds: string[];
  /** packageIds installed into the active cortex on this machine. */
  installedPackageIds?: string[];
  updatedAt?: number;
  /** Machine-local path to last imported MDM catalog bundle JSON. */
  mdmBundlePath?: string;
  /** packageIds from MDM bundle — auto-subscribe on unlock when entitled. */
  mdmDefaultSubscriptions?: string[];
  /** Per-package install metadata for semver / packId drift detection. */
  installedPackages?: Record<string, {
    catalogVersion?: string;
    packId?: string;
    installedAt: number;
  }>;
}

export type CatalogEntitlementReason =
  | 'entitled'
  | 'not_subscribed'
  | 'missing_groups'
  | 'sso_required'
  | 'not_published'
  | 'not_found';

export interface CatalogEntitlement {
  catalogId: string;
  entry: EngramCatalogEntry;
  entitled: boolean;
  reason: CatalogEntitlementReason;
  /** Groups the user lacks when reason is `missing_groups`. */
  missingGroups?: string[];
}

/** Per-package catalog overrides in an MDM bundle (keyed by packageId). */
export type MdmCatalogEntryOverride = Partial<
  Pick<
    EngramCatalogEntry,
    'requireSsoSession' | 'requiredIdpGroups' | 'defaultClassificationLabelId' | 'published'
  >
>;

/** MDM / plist JSON shape for IT push — SSO + default package subscriptions. */
export interface MdmEngramCatalogBundle {
  sso: {
    issuer: string;
    tenantId?: string;
    clientId: string;
  };
  /** packageIds to auto-subscribe on enrolled devices. */
  defaultSubscriptions: string[];
  /** Optional full catalog rows to upsert when the bundle is imported. */
  catalogEntries?: Partial<EngramCatalogEntry>[];
  /** Optional per-packageId field overrides merged onto existing catalog rows. */
  catalogOverrides?: Record<string, MdmCatalogEntryOverride>;
  /** Optional Enterprise compliance controls pushed with the catalog bundle. */
  compliance?: {
    classificationSchema?: import('../compliance/classification-schema.js').ClassificationSchema;
  };
}

export const DEFAULT_ENGRAM_CATALOG_SETTINGS: EngramCatalogSettings = {
  entries: [],
  version: 2,
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

export interface CatalogInstallEntitlementOpts {
  /** Present when the active session was unlocked via Enterprise IdP. */
  hasSsoSession?: boolean;
}

/** Resolve install entitlement for a single catalog entry. */
export function checkCatalogInstallEntitlement(
  entry: EngramCatalogEntry,
  userGroups: readonly string[],
  opts?: CatalogInstallEntitlementOpts,
): { entitled: boolean; reason: CatalogEntitlementReason; missingGroups?: string[] } {
  if (entry.published === false) {
    return { entitled: false, reason: 'not_published' };
  }
  if (entry.requireSsoSession === true && opts?.hasSsoSession !== true) {
    return { entitled: false, reason: 'sso_required' };
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

/** @deprecated Use checkCatalogInstallEntitlement — unlock gates removed in engram-only catalog. */
export const checkCatalogUnlockEntitlement = checkCatalogInstallEntitlement;

/**
 * Employee catalog entitlements: published entries filtered by IdP groups,
 * optionally filtered to subscribed ids.
 */
export function resolveCatalogEntitlements(
  entries: readonly EngramCatalogEntry[],
  userGroups: readonly string[],
  subscribedCatalogIds?: readonly string[],
  opts?: CatalogInstallEntitlementOpts,
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
    const check = checkCatalogInstallEntitlement(entry, userGroups, opts);
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

/** @deprecated Import from ./sso.js — re-export for catalog callers. */
export { hasActiveSsoUnlockSession };

export function buildMdmEngramCatalogBundle(
  entries: readonly EngramCatalogEntry[],
  sso: EnterpriseSsoSettings | undefined,
  defaultSubscriptions: readonly string[],
  compliance?: MdmEngramCatalogBundle['compliance'],
): MdmEngramCatalogBundle | null {
  const oidc = sso?.oidc;
  if (!isEnterpriseSsoConfigured(sso) || !oidc) return null;
  const packageIds = defaultSubscriptions.length > 0
    ? [...defaultSubscriptions]
    : entries.map((e) => e.packageId);
  return {
    sso: {
      issuer: oidc.issuer.trim(),
      clientId: oidc.clientId.trim(),
      ...(oidc.oidcTenantId?.trim() ? { tenantId: oidc.oidcTenantId.trim() } : {}),
    },
    defaultSubscriptions: packageIds,
    ...(compliance?.classificationSchema ? { compliance } : {}),
  };
}

function isCatalogKind(v: unknown): v is EngramCatalogKind {
  return v === 'engram-package' || v === 'hub-slice';
}

function isInstallMode(v: unknown): v is EngramInstallMode {
  return v === 'merge-copy' || v === 'federate-readonly';
}

function isCatalogEntry(v: unknown): v is EngramCatalogEntry {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const kind = r['kind'];
  const defaultRole = r['defaultRole'];
  const installMode = r['installMode'];
  return (
    typeof r['id'] === 'string' && r['id'].trim().length > 0
    && typeof r['packageId'] === 'string' && r['packageId'].trim().length > 0
    && typeof r['displayName'] === 'string' && r['displayName'].trim().length > 0
    && isCatalogKind(kind)
    && isInstallMode(installMode)
    && typeof r['itControlled'] === 'boolean'
    && typeof r['noReshare'] === 'boolean'
    && Array.isArray(r['requiredIdpGroups'])
    && r['requiredIdpGroups'].every((g) => typeof g === 'string')
    && (defaultRole === undefined || (typeof defaultRole === 'string' && isSharingRole(defaultRole)))
  );
}

/** Migrate legacy Phase 4 cortex-catalog row shapes; drop org-cortex rows. */
function migrateLegacyCatalogEntry(raw: Record<string, unknown>): Partial<EngramCatalogEntry> | null {
  const legacyKind = raw['kind'];
  if (legacyKind === 'org') return null;
  const packageId = typeof raw['packageId'] === 'string' && raw['packageId'].trim()
    ? raw['packageId'].trim()
    : typeof raw['cortexId'] === 'string' && raw['cortexId'].trim()
      ? raw['cortexId'].trim()
      : '';
  if (!packageId) return null;
  let kind: EngramCatalogKind = 'engram-package';
  if (legacyKind === 'hub-slice') kind = 'hub-slice';
  else if (legacyKind === 'hub-package') kind = 'engram-package';
  const hubIds = Array.isArray(raw['hubPackageEngramIds'])
    ? raw['hubPackageEngramIds'].filter((g): g is string => typeof g === 'string' && g.length > 0)
    : [];
  const sourceEngramId = typeof raw['sourceEngramId'] === 'string' && raw['sourceEngramId'].trim()
    ? raw['sourceEngramId'].trim()
    : hubIds[0];
  const itControlled = typeof raw['itControlled'] === 'boolean'
    ? raw['itControlled']
    : legacyKind !== 'personal';
  const noReshare = typeof raw['noReshare'] === 'boolean'
    ? raw['noReshare']
    : itControlled;
  let installMode: EngramInstallMode = 'merge-copy';
  if (isInstallMode(raw['installMode'])) installMode = raw['installMode'];
  else if (kind === 'hub-slice') installMode = 'federate-readonly';
  return {
    ...(typeof raw['id'] === 'string' && raw['id'].trim() ? { id: raw['id'].trim() } : {}),
    packageId,
    displayName: typeof raw['displayName'] === 'string' ? raw['displayName'] : '',
    kind,
    requiredIdpGroups: Array.isArray(raw['requiredIdpGroups']) ? raw['requiredIdpGroups'] as string[] : [],
    installMode,
    itControlled,
    noReshare,
    ...(typeof raw['description'] === 'string' && raw['description'].trim()
      ? { description: raw['description'].trim() }
      : {}),
    ...(sourceEngramId ? { sourceEngramId } : {}),
    ...(typeof raw['hubRef'] === 'string' && raw['hubRef'].trim()
      ? { hubRef: raw['hubRef'].trim() }
      : {}),
    ...(typeof raw['region'] === 'string' && raw['region'].trim()
      ? { region: raw['region'].trim() }
      : {}),
    ...(typeof raw['defaultRole'] === 'string' && isSharingRole(raw['defaultRole'])
      ? { defaultRole: normalizeSharingRole(raw['defaultRole']) }
      : {}),
    ...(typeof raw['mdmBundleId'] === 'string' && raw['mdmBundleId'].trim()
      ? { mdmBundleId: raw['mdmBundleId'].trim() }
      : {}),
    published: raw['published'] !== false,
    ...(typeof raw['requireSsoSession'] === 'boolean' ? { requireSsoSession: raw['requireSsoSession'] } : {}),
  };
}

export function sanitizeEngramCatalogEntry(raw: Partial<EngramCatalogEntry> | Record<string, unknown>): EngramCatalogEntry | null {
  const source = (raw && typeof raw === 'object' && !('packageId' in raw) && 'kind' in raw)
    ? migrateLegacyCatalogEntry(raw as Record<string, unknown>)
    : raw;
  if (!source || typeof source !== 'object') return null;
  const id = typeof source.id === 'string' && source.id.trim() ? source.id.trim() : generateCatalogEntryId();
  const packageId = typeof source.packageId === 'string' ? source.packageId.trim() : '';
  const displayName = typeof source.displayName === 'string' ? source.displayName.trim() : '';
  if (!packageId || !displayName || !isCatalogKind(source.kind)) return null;
  const installMode = isInstallMode(source.installMode)
    ? source.installMode
    : source.kind === 'hub-slice'
      ? 'federate-readonly'
      : 'merge-copy';
  const requiredIdpGroups = Array.isArray(source.requiredIdpGroups)
    ? source.requiredIdpGroups.map((g) => (typeof g === 'string' ? g.trim() : '')).filter(Boolean)
    : [];
  let defaultRole: SharingRole | undefined;
  if (typeof source.defaultRole === 'string' && isSharingRole(source.defaultRole)) {
    defaultRole = normalizeSharingRole(source.defaultRole);
  }
  const itControlled = typeof source.itControlled === 'boolean' ? source.itControlled : true;
  const noReshare = typeof source.noReshare === 'boolean' ? source.noReshare : itControlled;
  return {
    id,
    packageId,
    displayName,
    kind: source.kind,
    installMode,
    requiredIdpGroups,
    itControlled,
    noReshare,
    ...(typeof source.description === 'string' && source.description.trim()
      ? { description: source.description.trim() }
      : {}),
    ...(typeof source.region === 'string' && source.region.trim() ? { region: source.region.trim() } : {}),
    ...(defaultRole ? { defaultRole } : {}),
    ...(typeof source.sourceEngramId === 'string' && source.sourceEngramId.trim()
      ? { sourceEngramId: source.sourceEngramId.trim() }
      : {}),
    ...(typeof source.hubRef === 'string' && source.hubRef.trim()
      ? { hubRef: source.hubRef.trim() }
      : {}),
    ...(typeof source.packId === 'string' && source.packId.trim()
      ? { packId: source.packId.trim() }
      : {}),
    ...(typeof source.catalogVersion === 'string' && source.catalogVersion.trim()
      ? { catalogVersion: source.catalogVersion.trim() }
      : {}),
    ...(typeof source.mdmBundleId === 'string' && source.mdmBundleId.trim()
      ? { mdmBundleId: source.mdmBundleId.trim() }
      : {}),
    ...(typeof source.defaultClassificationLabelId === 'string' && source.defaultClassificationLabelId.trim()
      ? { defaultClassificationLabelId: source.defaultClassificationLabelId.trim() }
      : {}),
    ...(source.requireSsoSession === true ? { requireSsoSession: true } : {}),
    published: source.published !== false,
  };
}

function sanitizeMdmCatalogOverride(raw: unknown): MdmCatalogEntryOverride | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out: MdmCatalogEntryOverride = {};
  if (typeof r['requireSsoSession'] === 'boolean') out.requireSsoSession = r['requireSsoSession'];
  if (Array.isArray(r['requiredIdpGroups'])) {
    out.requiredIdpGroups = r['requiredIdpGroups']
      .filter((g): g is string => typeof g === 'string')
      .map((g) => g.trim())
      .filter(Boolean);
  }
  if (typeof r['defaultClassificationLabelId'] === 'string' && r['defaultClassificationLabelId'].trim()) {
    out.defaultClassificationLabelId = r['defaultClassificationLabelId'].trim();
  }
  if (typeof r['published'] === 'boolean') out.published = r['published'];
  return Object.keys(out).length > 0 ? out : null;
}

/** Parse catalog rows + overrides from an MDM bundle JSON object. */
export function parseMdmCatalogBundleExtras(
  raw: Partial<MdmEngramCatalogBundle> | Record<string, unknown>,
): Pick<MdmEngramCatalogBundle, 'catalogEntries' | 'catalogOverrides'> {
  const catalogEntries = Array.isArray(raw['catalogEntries'])
    ? raw['catalogEntries']
      .map((e) => sanitizeEngramCatalogEntry(e as Partial<EngramCatalogEntry>))
      .filter(Boolean) as EngramCatalogEntry[]
    : undefined;
  let catalogOverrides: Record<string, MdmCatalogEntryOverride> | undefined;
  if (raw['catalogOverrides'] && typeof raw['catalogOverrides'] === 'object') {
    const parsed: Record<string, MdmCatalogEntryOverride> = {};
    for (const [packageId, overrideRaw] of Object.entries(raw['catalogOverrides'] as Record<string, unknown>)) {
      const key = packageId.trim();
      if (!key) continue;
      const override = sanitizeMdmCatalogOverride(overrideRaw);
      if (override) parsed[key] = override;
    }
    if (Object.keys(parsed).length > 0) catalogOverrides = parsed;
  }
  return {
    ...(catalogEntries?.length ? { catalogEntries } : {}),
    ...(catalogOverrides ? { catalogOverrides } : {}),
  };
}

/** Merge MDM catalog rows and per-package overrides into cortex catalog settings. */
export function mergeMdmCatalogIntoSettings(
  currentEntries: readonly EngramCatalogEntry[],
  extras: Pick<MdmEngramCatalogBundle, 'catalogEntries' | 'catalogOverrides'>,
): EngramCatalogEntry[] {
  const byPackageId = new Map(currentEntries.map((e) => [e.packageId, { ...e }]));
  for (const entry of extras.catalogEntries ?? []) {
    const packageId = entry.packageId?.trim();
    if (!packageId) continue;
    byPackageId.set(packageId, entry as EngramCatalogEntry);
  }
  for (const [packageId, override] of Object.entries(extras.catalogOverrides ?? {})) {
    const existing = byPackageId.get(packageId);
    if (!existing) continue;
    byPackageId.set(packageId, {
      ...existing,
      ...(override.requireSsoSession !== undefined ? { requireSsoSession: override.requireSsoSession } : {}),
      ...(override.requiredIdpGroups !== undefined ? { requiredIdpGroups: override.requiredIdpGroups } : {}),
      ...(override.defaultClassificationLabelId !== undefined
        ? { defaultClassificationLabelId: override.defaultClassificationLabelId }
        : {}),
      ...(override.published !== undefined ? { published: override.published } : {}),
    });
  }
  return [...byPackageId.values()];
}

function sanitizeSharePointSettings(
  raw: Partial<EngramCatalogSharePointSettings> | undefined,
): EngramCatalogSharePointSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const listUrl = typeof raw.listUrl === 'string' && raw.listUrl.trim() ? raw.listUrl.trim() : undefined;
  const accessToken = typeof raw.accessToken === 'string' && raw.accessToken.trim()
    ? raw.accessToken.trim()
    : undefined;
  if (!listUrl && !accessToken && raw.lastSyncedAt == null && !raw.lastSyncError) return undefined;
  return {
    ...(listUrl ? { listUrl } : {}),
    ...(accessToken ? { accessToken } : {}),
    ...(typeof raw.lastSyncedAt === 'number' ? { lastSyncedAt: raw.lastSyncedAt } : {}),
    ...(typeof raw.lastSyncError === 'string' && raw.lastSyncError.trim()
      ? { lastSyncError: raw.lastSyncError.trim() }
      : {}),
    ...(typeof raw.lastSyncEntryCount === 'number' ? { lastSyncEntryCount: raw.lastSyncEntryCount } : {}),
  };
}

export function sanitizeEngramCatalogSettings(
  raw: Partial<EngramCatalogSettings> | undefined,
): EngramCatalogSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const entries = Array.isArray(raw.entries)
    ? raw.entries
      .map((e) => sanitizeEngramCatalogEntry(e as Partial<EngramCatalogEntry> | Record<string, unknown>))
      .filter(Boolean) as EngramCatalogEntry[]
    : [];
  const sharePoint = sanitizeSharePointSettings(raw.sharePoint);
  return {
    entries,
    version: typeof raw.version === 'number' ? raw.version : 2,
    ...(sharePoint ? { sharePoint } : {}),
  };
}

/** Read engram catalog from settings, migrating legacy `cortexCatalog` if needed. */
export function engramCatalogFromAppSettings(
  partial: { engramCatalog?: Partial<EngramCatalogSettings>; cortexCatalog?: Partial<EngramCatalogSettings> } | null | undefined,
): EngramCatalogSettings | undefined {
  if (!partial) return undefined;
  const raw = partial.engramCatalog ?? partial.cortexCatalog;
  return sanitizeEngramCatalogSettings(raw);
}

/** Public catalog row for employee IPC. */
export function engramCatalogPublicEntry(entry: EngramCatalogEntry): EngramCatalogEntry {
  return { ...entry };
}
