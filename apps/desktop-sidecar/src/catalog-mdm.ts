/**
 * MDM engram catalog bundle — import + auto-subscribe on unlock.
 *
 * Bundle shape: `MdmEngramCatalogBundle` (SSO hints + defaultSubscriptions packageIds).
 * Machine-local path: `~/.graphnosis/catalog-subscriptions.json` stores imported path
 * and packageIds. Env override: `GRAPHNOSIS_MDM_CATALOG_BUNDLE=/path/to/bundle.json`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  EngramCatalogEntry,
  MdmEngramCatalogBundle,
} from '@graphnosis-app/core/settings';
import {
  checkCatalogInstallEntitlement,
  sanitizeEngramCatalogSettings,
  parseMdmCatalogBundleExtras,
  mergeMdmCatalogIntoSettings,
} from '@graphnosis-app/core/settings';
import { sanitizeClassificationSchema } from '@graphnosis-app/core';
import type { GraphnosisHost } from './host.js';
import { catalogHasSsoSession } from './catalog-sso-gate.js';
import {
  readCatalogSubscriptions,
  writeCatalogSubscriptions,
  subscribeCatalogEntry,
  recordInstalledPackage,
} from './catalog-subscriptions.js';

export const MDM_CATALOG_BUNDLE_ENV = 'GRAPHNOSIS_MDM_CATALOG_BUNDLE';

export const DEFAULT_MDM_BUNDLE_PATH = path.join(os.homedir(), '.graphnosis', 'mdm-catalog-bundle.json');

export async function readMdmBundleFile(bundlePath: string): Promise<MdmEngramCatalogBundle | null> {
  try {
    const raw = await fs.readFile(bundlePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<MdmEngramCatalogBundle>;
    if (!parsed.sso?.issuer || !parsed.sso?.clientId) return null;
    if (!Array.isArray(parsed.defaultSubscriptions)) return null;
    const extras = parseMdmCatalogBundleExtras(parsed);
    return {
      sso: {
        issuer: String(parsed.sso.issuer).trim(),
        clientId: String(parsed.sso.clientId).trim(),
        ...(parsed.sso.tenantId?.trim() ? { tenantId: parsed.sso.tenantId.trim() } : {}),
      },
      defaultSubscriptions: parsed.defaultSubscriptions
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim()),
      ...extras,
      ...(parsed.compliance?.classificationSchema
        ? (() => {
          const schema = sanitizeClassificationSchema(parsed.compliance!.classificationSchema);
          return schema ? { compliance: { classificationSchema: schema } } : {};
        })()
        : {}),
    };
  } catch {
    return null;
  }
}

export async function resolveMdmBundlePath(): Promise<string | null> {
  const envPath = process.env[MDM_CATALOG_BUNDLE_ENV]?.trim();
  if (envPath) {
    try {
      await fs.access(envPath);
      return envPath;
    } catch { /* fall through */ }
  }
  const store = await readCatalogSubscriptions();
  if (store.mdmBundlePath?.trim()) {
    try {
      await fs.access(store.mdmBundlePath);
      return store.mdmBundlePath.trim();
    } catch { /* missing file */ }
  }
  try {
    await fs.access(DEFAULT_MDM_BUNDLE_PATH);
    return DEFAULT_MDM_BUNDLE_PATH;
  } catch {
    return null;
  }
}

export async function importMdmCatalogBundle(
  bundlePath: string,
  bundle: MdmEngramCatalogBundle,
): Promise<void> {
  const store = await readCatalogSubscriptions();
  store.mdmBundlePath = path.resolve(bundlePath);
  store.mdmDefaultSubscriptions = [...bundle.defaultSubscriptions];
  await writeCatalogSubscriptions(store);
}

function catalogIdsForPackageIds(
  entries: readonly EngramCatalogEntry[],
  packageIds: readonly string[],
): string[] {
  const wanted = new Set(packageIds);
  return entries.filter((e) => wanted.has(e.packageId)).map((e) => e.id);
}

export async function applyMdmAutoInstall(
  host: GraphnosisHost,
  installPackage: (entry: EngramCatalogEntry) => Promise<{ ok: true } | { ok: false }>,
  sessionDeps?: {
    ssoSession?: { role: import('@graphnosis-app/core/settings').SharingRole } | null;
    sharingScope?: { role: import('@graphnosis-app/core/settings').SharingRole; engrams: string[] | '*'; except?: string[] } | null;
  },
): Promise<{
  ok: boolean;
  applied: number;
  skipped: number;
  bundlePath?: string;
  message?: string;
}> {
  const bundlePath = await resolveMdmBundlePath();
  if (!bundlePath) {
    return { ok: true, applied: 0, skipped: 0, message: 'No MDM catalog bundle configured.' };
  }

  const bundle = await readMdmBundleFile(bundlePath);
  if (!bundle) {
    return { ok: false, applied: 0, skipped: 0, bundlePath, message: 'MDM bundle file is invalid or unreadable.' };
  }

  const settings = host.getSettings();
  const entries = settings.engramCatalog?.entries ?? [];
  const groups = settings.sso?.lastLogin?.groups ?? [];
  const hasSsoSession = sessionDeps ? catalogHasSsoSession(sessionDeps) : false;
  const packageIds = bundle.defaultSubscriptions.length > 0
    ? bundle.defaultSubscriptions
    : (await readCatalogSubscriptions()).mdmDefaultSubscriptions ?? [];

  const catalogIds = catalogIdsForPackageIds(entries, packageIds);
  if (catalogIds.length === 0) {
    return {
      ok: true,
      applied: 0,
      skipped: 0,
      bundlePath,
      message: 'MDM bundle has no matching catalog entries in this cortex.',
    };
  }

  const store = await readCatalogSubscriptions();
  const installed = new Set(store.installedPackageIds ?? []);
  let applied = 0;
  let skipped = 0;

  for (const catalogId of catalogIds) {
    const entry = entries.find((e) => e.id === catalogId);
    if (!entry || entry.published === false) {
      skipped++;
      continue;
    }
    const ent = checkCatalogInstallEntitlement(entry, groups, { hasSsoSession });
    if (!ent.entitled) {
      skipped++;
      continue;
    }
    if (installed.has(entry.packageId)) {
      skipped++;
      continue;
    }
    await subscribeCatalogEntry(catalogId);
    const result = await installPackage(entry);
    if (result.ok) {
      await recordInstalledPackage(entry.packageId);
      installed.add(entry.packageId);
      applied++;
    } else {
      skipped++;
    }
  }

  return {
    ok: true,
    applied,
    skipped,
    bundlePath,
    message: applied > 0
      ? `MDM auto-installed ${applied} organization package${applied === 1 ? '' : 's'}.`
      : 'MDM bundle present — no new entitled packages to install.',
  };
}

/** Persist imported bundle + optional SSO hint merge into cortex settings. */
export async function mergeMdmSsoHints(
  host: GraphnosisHost,
  bundle: MdmEngramCatalogBundle,
): Promise<void> {
  const current = host.getSettings();
  const sso = current.sso;
  const schema = bundle.compliance?.classificationSchema
    ? sanitizeClassificationSchema(bundle.compliance.classificationSchema)
    : undefined;
  const mergedCatalogEntries = (bundle.catalogEntries?.length || bundle.catalogOverrides)
    ? mergeMdmCatalogIntoSettings(current.engramCatalog?.entries ?? [], {
      ...(bundle.catalogEntries?.length ? { catalogEntries: bundle.catalogEntries } : {}),
      ...(bundle.catalogOverrides ? { catalogOverrides: bundle.catalogOverrides } : {}),
    })
    : undefined;
  const compliancePatch = schema
    ? {
      compliance: {
        enabled: current.compliance?.enabled === true,
        ...(current.compliance?.defaultRetentionTtlMs !== undefined
          ? { defaultRetentionTtlMs: current.compliance.defaultRetentionTtlMs }
          : {}),
        ...(current.compliance?.defaultExportBeforePurge !== undefined
          ? { defaultExportBeforePurge: current.compliance.defaultExportBeforePurge }
          : {}),
        ...(current.compliance?.lastRetentionDryRunAt !== undefined
          ? { lastRetentionDryRunAt: current.compliance.lastRetentionDryRunAt }
          : {}),
        classificationSchema: schema,
      },
    }
    : {};
  const catalogPatch = mergedCatalogEntries
    ? {
      engramCatalog: sanitizeEngramCatalogSettings({ entries: mergedCatalogEntries, version: 2 })
        ?? { entries: mergedCatalogEntries, version: 2 },
    }
    : {};
  if (!sso?.oidc?.issuer && bundle.sso.issuer) {
    await host.setSettings({
      ...current,
      ...compliancePatch,
      ...catalogPatch,
      sso: {
        ...(sso ?? { enabled: false, protocol: 'oidc', breakGlassPassphrase: true, groupRoleMappings: [] }),
        oidc: {
          issuer: bundle.sso.issuer,
          clientId: bundle.sso.clientId,
          ...(bundle.sso.tenantId ? { oidcTenantId: bundle.sso.tenantId } : {}),
          groupsClaim: 'groups',
          redirectUri: 'http://127.0.0.1:4580/sso/callback',
        },
      },
      ...(catalogPatch.engramCatalog
        ? {}
        : {
          engramCatalog: sanitizeEngramCatalogSettings(current.engramCatalog)
            ?? current.engramCatalog
            ?? { entries: [], version: 2 },
        }),
    });
  } else if (schema || mergedCatalogEntries) {
    await host.setSettings({ ...current, ...compliancePatch, ...catalogPatch });
  }
}
