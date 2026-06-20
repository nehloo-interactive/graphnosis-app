/**
 * Machine-local engram catalog subscriptions + install state — not in encrypted cortex.
 * Path: ~/.graphnosis/catalog-subscriptions.json
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CatalogSubscriptionStore } from '@graphnosis-app/core/settings';

const STORE_DIR = path.join(os.homedir(), '.graphnosis');
const STORE_FILE = path.join(STORE_DIR, 'catalog-subscriptions.json');

function emptyStore(): CatalogSubscriptionStore {
  return { subscribedCatalogIds: [], installedPackageIds: [] };
}

export async function readCatalogSubscriptions(): Promise<CatalogSubscriptionStore> {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CatalogSubscriptionStore>;
    const ids = Array.isArray(parsed.subscribedCatalogIds)
      ? parsed.subscribedCatalogIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const installed = Array.isArray(parsed.installedPackageIds)
      ? parsed.installedPackageIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const mdmBundlePath = typeof parsed.mdmBundlePath === 'string' && parsed.mdmBundlePath.trim()
      ? parsed.mdmBundlePath.trim()
      : undefined;
    const mdmDefaultSubscriptions = Array.isArray(parsed.mdmDefaultSubscriptions)
      ? parsed.mdmDefaultSubscriptions.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : undefined;
    return {
      subscribedCatalogIds: [...new Set(ids)],
      installedPackageIds: [...new Set(installed)],
      ...(mdmBundlePath ? { mdmBundlePath } : {}),
      ...(mdmDefaultSubscriptions?.length ? { mdmDefaultSubscriptions: [...new Set(mdmDefaultSubscriptions)] } : {}),
      ...(parsed.updatedAt != null ? { updatedAt: parsed.updatedAt } : {}),
    };
  } catch {
    return emptyStore();
  }
}

export async function writeCatalogSubscriptions(store: CatalogSubscriptionStore): Promise<void> {
  await fs.mkdir(STORE_DIR, { recursive: true, mode: 0o700 });
  const payload: CatalogSubscriptionStore = {
    subscribedCatalogIds: [...new Set(store.subscribedCatalogIds)],
    installedPackageIds: [...new Set(store.installedPackageIds ?? [])],
    updatedAt: Date.now(),
  };
  await fs.writeFile(STORE_FILE, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
}

export async function subscribeCatalogEntry(catalogId: string): Promise<CatalogSubscriptionStore> {
  const store = await readCatalogSubscriptions();
  if (!store.subscribedCatalogIds.includes(catalogId)) {
    store.subscribedCatalogIds.push(catalogId);
  }
  await writeCatalogSubscriptions(store);
  return store;
}

export async function unsubscribeCatalogEntry(catalogId: string): Promise<CatalogSubscriptionStore> {
  const store = await readCatalogSubscriptions();
  store.subscribedCatalogIds = store.subscribedCatalogIds.filter((id) => id !== catalogId);
  await writeCatalogSubscriptions(store);
  return store;
}

export async function recordInstalledPackage(packageId: string): Promise<CatalogSubscriptionStore> {
  const store = await readCatalogSubscriptions();
  const installed = new Set(store.installedPackageIds ?? []);
  installed.add(packageId);
  store.installedPackageIds = [...installed];
  await writeCatalogSubscriptions(store);
  return store;
}

/** Apply MDM-pushed subscription list (union with existing). */
export async function applyMdmSubscriptions(catalogIds: readonly string[]): Promise<CatalogSubscriptionStore> {
  const store = await readCatalogSubscriptions();
  const merged = new Set([...store.subscribedCatalogIds, ...catalogIds.filter(Boolean)]);
  store.subscribedCatalogIds = [...merged];
  await writeCatalogSubscriptions(store);
  return store;
}
