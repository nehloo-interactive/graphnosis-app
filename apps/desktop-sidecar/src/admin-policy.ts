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
}

export interface AdminPolicyState extends AdminPolicy {
  /** True when an env-managed policy is in force — the app cannot edit it. */
  managed: boolean;
}

let policyFilePath = '';
let filePolicy: AdminPolicy = { disabledConnectorKinds: [], disabledClients: [] };
let envConnectors: string[] = [];
let envClients: string[] = [];
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
    };
  } catch {
    filePolicy = { disabledConnectorKinds: [], disabledClients: [] };
  }
  envConnectors = envList('GRAPHNOSIS_DISABLED_CONNECTORS');
  envClients = envList('GRAPHNOSIS_DISABLED_CLIENTS');
  // Managed when IT pins anything via env, or explicitly via the flag.
  envManaged = process.env.GRAPHNOSIS_MANAGED_POLICY === '1' || envConnectors.length > 0 || envClients.length > 0;
}

/** The EFFECTIVE policy (file ∪ env) + the managed flag. */
export function getAdminPolicy(): AdminPolicyState {
  return {
    disabledConnectorKinds: [...new Set([...filePolicy.disabledConnectorKinds, ...envConnectors])],
    disabledClients: [...new Set([...filePolicy.disabledClients, ...envClients])],
    managed: envManaged,
  };
}

export function isConnectorKindDisabled(kind: string): boolean {
  return getAdminPolicy().disabledConnectorKinds.includes(kind);
}
export function isClientDisabled(name: string): boolean {
  return getAdminPolicy().disabledClients.includes(name);
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
  };
  writeFileSync(policyFilePath, JSON.stringify(filePolicy, null, 2), 'utf8');
  return getAdminPolicy();
}
