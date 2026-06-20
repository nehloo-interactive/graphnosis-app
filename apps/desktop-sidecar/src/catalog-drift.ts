/**
 * Catalog package version drift — compare IT-published semver vs machine-local install.
 */

import { catalogVersionDrift } from './gsk-format.js';
import type { EngramCatalogEntry } from '@graphnosis-app/core/settings';
import type { CatalogSubscriptionStore } from '@graphnosis-app/core/settings';
import { readCatalogSubscriptions } from './catalog-subscriptions.js';

export interface CatalogDriftItem {
  catalogId: string;
  packageId: string;
  displayName: string;
  installedVersion?: string;
  catalogVersion?: string;
  installedPackId?: string;
  catalogPackId?: string;
  packIdMismatch: boolean;
  versionDrift: boolean;
}

export function detectCatalogDrift(
  entries: readonly EngramCatalogEntry[],
  store: CatalogSubscriptionStore,
): CatalogDriftItem[] {
  const installed = store.installedPackages ?? {};
  const out: CatalogDriftItem[] = [];
  for (const entry of entries) {
    if (entry.published === false) continue;
    const local = installed[entry.packageId];
    if (!local && !(store.installedPackageIds ?? []).includes(entry.packageId)) continue;
    const versionDrift = catalogVersionDrift(local?.catalogVersion, entry.catalogVersion);
    const packIdMismatch = Boolean(
      entry.packId?.trim()
      && local?.packId?.trim()
      && entry.packId.trim() !== local.packId.trim(),
    );
    if (versionDrift || packIdMismatch) {
      out.push({
        catalogId: entry.id,
        packageId: entry.packageId,
        displayName: entry.displayName,
        ...(local?.catalogVersion ? { installedVersion: local.catalogVersion } : {}),
        ...(entry.catalogVersion ? { catalogVersion: entry.catalogVersion } : {}),
        ...(local?.packId ? { installedPackId: local.packId } : {}),
        ...(entry.packId ? { catalogPackId: entry.packId } : {}),
        packIdMismatch,
        versionDrift,
      });
    }
  }
  return out;
}

export async function loadCatalogDrift(
  entries: readonly EngramCatalogEntry[],
): Promise<CatalogDriftItem[]> {
  const store = await readCatalogSubscriptions();
  return detectCatalogDrift(entries, store);
}
