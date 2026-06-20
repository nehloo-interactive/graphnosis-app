/**
 * Federated cortex unlock — org SSO key wraps the same dataKey as owner passphrase.
 * Phase 2: federated.master.enc + OS credential store on each admin-configured Mac.
 * Phase 3: per-user org subkeys.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadSettings } from '../settings/index.js';
import {
  DEFAULT_SSO_SETTINGS,
  enterpriseSsoPublicView,
  isEnterpriseSsoConfigured,
  type EnterpriseSsoSettings,
} from '../settings/sso.js';

export const FEDERATED_MASTER_FILE = 'federated.master.enc';

/** Pre-unlock offer read from plaintext settings.json (no cortex decrypt). */
export interface SsoUnlockOffer {
  available: boolean;
  enabled: boolean;
  configured: boolean;
  protocol: 'oidc' | 'saml';
  breakGlassPassphrase: boolean;
  oidc?: {
    issuer: string;
    clientId: string;
    hasClientSecret: boolean;
    scopes: string[];
    groupsClaim: string;
    redirectUri: string;
  };
  federatedUnlockReady: boolean;
  groupMappingCount: number;
  reason?: string;
}

export async function readSsoUnlockOffer(cortexDir: string): Promise<SsoUnlockOffer> {
  const settings = await loadSettings(cortexDir);
  const sso: EnterpriseSsoSettings = settings.sso ?? DEFAULT_SSO_SETTINGS;
  const publicView = enterpriseSsoPublicView(sso);
  const configured = isEnterpriseSsoConfigured(sso);
  const federatedReady = sso.federatedUnlockReady === true;
  let reason: string | undefined;
  if (!configured) reason = 'not_configured';
  else if (!sso.enabled) reason = 'disabled';
  else if (!federatedReady) reason = 'federated_key_not_provisioned';
  else if (sso.protocol !== 'oidc') reason = 'saml_not_supported_yet';

  return {
    available: configured && sso.enabled && federatedReady && sso.protocol === 'oidc',
    enabled: sso.enabled,
    configured,
    protocol: sso.protocol,
    breakGlassPassphrase: sso.breakGlassPassphrase,
    ...(publicView.oidc ? { oidc: publicView.oidc } : {}),
    federatedUnlockReady: federatedReady,
    groupMappingCount: sso.groupRoleMappings.length,
    ...(reason ? { reason } : {}),
  };
}

export function generateFederatedUnlockKey(): string {
  return randomBytes(32).toString('base64url');
}

export function federatedMasterPath(cortexDir: string): string {
  return path.join(cortexDir, FEDERATED_MASTER_FILE);
}

export async function federatedMasterExists(cortexDir: string): Promise<boolean> {
  try {
    await fs.access(federatedMasterPath(cortexDir));
    return true;
  } catch {
    return false;
  }
}
