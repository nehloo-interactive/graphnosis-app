//! Admin / IT policy — connector kinds + AI-client identities that are BLOCKED.
//!
//! Trust root = whoever controls the SIDECAR HOST is the admin:
//!   • Individual user (sidecar on their own device) → they ARE the admin and
//!     can toggle the policy from the app (writes policy.json in the cortex dir).
//!   • Enterprise (central sidecar IT runs on a server the user's device can't
//!     touch) → IT sets the policy on the host via env vars (or a managed
//!     policy.json + GRAPHNOSIS_MANAGED_POLICY=1). Those are MANAGED: the app
//!     can read them but `setAdminPolicy` refuses to change them.
//!
//! Enforcement lives in the sidecar (never the UI, which is bypassable):
//!   • connectors  → ConnectorManager skips/stops disabled kinds.
//!   • AI clients  → the MCP CallTool handler rejects disabled client names.
//!
//! Deliberately a standalone JSON file, NOT part of AppSettings — it avoids the
//! settings normalizer/zod-migration surface and keeps the trust boundary
//! (the host's filesystem + env) cleanly separate from user-editable settings.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface AdminPolicy {
  disabledConnectorKinds: string[];
  disabledClients: string[];
  /** Model provider ids IT has blocked from routing (e.g. anthropic, openai). */
  disabledProviders: string[];
  /** Enterprise-negotiated rate overrides merged into settings.models.customRates. */
  pinnedRates: Array<{
    modelId?: string;
    providerId?: string;
    pricing: unknown;
    note?: string;
  }>;
}

export interface AdminPolicyState extends AdminPolicy {
  /** True when an env-managed policy is in force — the app cannot edit it. */
  managed: boolean;
}

let policyFilePath = '';
let filePolicy: AdminPolicy = { disabledConnectorKinds: [], disabledClients: [], disabledProviders: [], pinnedRates: [] };
let envConnectors: string[] = [];
let envClients: string[] = [];
let envProviders: string[] = [];
let envManaged = false;

function envList(name: string): string[] {
  const v = process.env[name];
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** Read the policy file + env once at boot. Call again to reload from disk. */
export function initAdminPolicy(cortexDir: string): void {
  policyFilePath = path.join(cortexDir, 'policy.json');
  try {
    const raw = JSON.parse(readFileSync(policyFilePath, 'utf8')) as Partial<AdminPolicy>;
    filePolicy = {
      disabledConnectorKinds: Array.isArray(raw.disabledConnectorKinds) ? raw.disabledConnectorKinds : [],
      disabledClients: Array.isArray(raw.disabledClients) ? raw.disabledClients : [],
      disabledProviders: Array.isArray(raw.disabledProviders) ? raw.disabledProviders : [],
      pinnedRates: Array.isArray(raw.pinnedRates) ? raw.pinnedRates : [],
    };
  } catch {
    filePolicy = { disabledConnectorKinds: [], disabledClients: [], disabledProviders: [], pinnedRates: [] };
  }
  envConnectors = envList('GRAPHNOSIS_DISABLED_CONNECTORS');
  envClients = envList('GRAPHNOSIS_DISABLED_CLIENTS');
  envProviders = envList('GRAPHNOSIS_DISABLED_PROVIDERS');
  // Managed when IT pins anything via env, or explicitly via the flag.
  envManaged = process.env.GRAPHNOSIS_MANAGED_POLICY === '1'
    || envConnectors.length > 0
    || envClients.length > 0
    || envProviders.length > 0;
}

/** The EFFECTIVE policy (file ∪ env) + the managed flag. */
export function getAdminPolicy(): AdminPolicyState {
  return {
    disabledConnectorKinds: [...new Set([...filePolicy.disabledConnectorKinds, ...envConnectors])],
    disabledClients: [...new Set([...filePolicy.disabledClients, ...envClients])],
    disabledProviders: [...new Set([...filePolicy.disabledProviders, ...envProviders])],
    pinnedRates: filePolicy.pinnedRates,
    managed: envManaged,
  };
}

export function isConnectorKindDisabled(kind: string): boolean {
  return getAdminPolicy().disabledConnectorKinds.includes(kind);
}
export function isClientDisabled(name: string): boolean {
  // Case-insensitive so a block on "Cursor" stops a client reporting "cursor",
  // and the toggle label format doesn't have to match the relay's exactly.
  const lower = name.toLowerCase();
  return getAdminPolicy().disabledClients.some((d) => d.toLowerCase() === lower);
}

export function isProviderDisabled(providerId: string): boolean {
  const lower = providerId.toLowerCase();
  return getAdminPolicy().disabledProviders.some((d) => d.toLowerCase() === lower);
}

/** Apply IT-managed provider blocks + pinned rates into user settings at boot. */
export async function mergeManagedProviderPolicy(host: {
  getSettings: () => { models?: import('@graphnosis-app/core/settings').ModelsSettings };
  setSettings: (partial: Partial<import('@graphnosis-app/core/settings').AppSettings>) => Promise<unknown>;
}): Promise<void> {
  const policy = getAdminPolicy();
  if (policy.disabledProviders.length === 0 && policy.pinnedRates.length === 0) return;

  const current = host.getSettings();
  const models = current.models ?? { strategy: 'adaptive' as const, providers: { ollama: { enabled: true } } };
  const providers = { ...models.providers };

  for (const pid of policy.disabledProviders) {
    const prior = providers[pid] ?? { enabled: false };
    providers[pid] = { ...prior, enabled: false, adminLocked: true };
  }

  const userRates = (models.customRates ?? []).filter((r) => !(r as { adminEnforced?: boolean }).adminEnforced);
  const pinnedRates = policy.pinnedRates.map((pin) => ({
    ...(pin.modelId ? { modelId: pin.modelId } : {}),
    ...(pin.providerId ? { providerId: pin.providerId } : {}),
    pricing: pin.pricing,
    ...(pin.note ? { note: pin.note } : {}),
    adminEnforced: true,
  }));

  await host.setSettings({
    ...current,
    models: {
      ...models,
      providers,
      customRates: [...userRates, ...pinnedRates],
    },
  });
}

/** Update the user-editable file policy. Throws if the policy is env-managed
 *  (enterprise) — that's IT's call on the host, not the app's. */
export function setAdminPolicy(patch: Partial<AdminPolicy>): AdminPolicyState {
  if (envManaged) {
    throw new Error('This policy is managed by your administrator and cannot be changed from here.');
  }
  if (!policyFilePath) throw new Error('Admin policy not initialized.');
  filePolicy = {
    disabledConnectorKinds: patch.disabledConnectorKinds ?? filePolicy.disabledConnectorKinds,
    disabledClients: patch.disabledClients ?? filePolicy.disabledClients,
    disabledProviders: patch.disabledProviders ?? filePolicy.disabledProviders,
    pinnedRates: patch.pinnedRates ?? filePolicy.pinnedRates,
  };
  writeFileSync(policyFilePath, JSON.stringify(filePolicy, null, 2), 'utf8');
  return getAdminPolicy();
}
