/**
 * Federated cortex unlock — org SSO key wraps the same dataKey as owner passphrase.
 * Phase 2: federated.master.enc + OS credential store on each admin-configured Mac.
 * Phase 3: tenant-bound IdP unlock, reachability probe, lock-screen discover.
 * Phase 4: per-user org subkeys.
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
import { idpUiHints, probeIdpReachability } from './idp.js';

export const FEDERATED_MASTER_FILE = 'federated.master.enc';

/** Pre-unlock offer read from plaintext settings.json (no cortex decrypt). */
export interface SsoUnlockOffer {
  /** Show SSO button on lock screen when configured + enabled (even if not fully ready). */
  showButton: boolean;
  /** Full OIDC unlock path is ready (provisioned + OIDC + keychain on this Mac when probed). */
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
    oidcTenantId?: string;
  };
  federatedUnlockReady: boolean;
  groupMappingCount: number;
  suggestedButtonLabel: string;
  tenantHint?: string;
  idpReachable?: boolean;
  idpReachabilityError?: string;
  reason?: string;
}

export interface SsoDiscoverResult {
  configured: boolean;
  enabled: boolean;
  provisioned: boolean;
  idpReachable: boolean;
  idpReachabilityError?: string;
  suggestedButtonLabel: string;
  tenantHint?: string;
  breakGlassPassphrase: boolean;
  showButton: boolean;
  available: boolean;
  reason?: string;
}

function buildOfferBase(sso: EnterpriseSsoSettings): Omit<SsoUnlockOffer, 'idpReachable' | 'idpReachabilityError'> {
  const publicView = enterpriseSsoPublicView(sso);
  const configured = isEnterpriseSsoConfigured(sso);
  const federatedReady = sso.federatedUnlockReady === true;
  const issuer = publicView.oidc?.issuer ?? '';
  const hints = idpUiHints(issuer, publicView.oidc?.oidcTenantId);

  let reason: string | undefined;
  if (!configured) reason = 'not_configured';
  else if (!sso.enabled) reason = 'disabled';
  else if (!federatedReady) reason = 'federated_key_not_provisioned';
  else if (sso.protocol !== 'oidc') reason = 'saml_not_supported_yet';

  const showButton = configured && sso.enabled && sso.protocol === 'oidc';

  return {
    showButton,
    available: showButton && federatedReady,
    enabled: sso.enabled,
    configured,
    protocol: sso.protocol,
    breakGlassPassphrase: sso.breakGlassPassphrase,
    ...(publicView.oidc ? { oidc: publicView.oidc } : {}),
    federatedUnlockReady: federatedReady,
    groupMappingCount: sso.groupRoleMappings.length,
    suggestedButtonLabel: hints.suggestedButtonLabel,
    ...(hints.tenantHint ? { tenantHint: hints.tenantHint } : {}),
    ...(reason ? { reason } : {}),
  };
}

export async function readSsoUnlockOffer(cortexDir: string): Promise<SsoUnlockOffer> {
  const settings = await loadSettings(cortexDir);
  const sso: EnterpriseSsoSettings = settings.sso ?? DEFAULT_SSO_SETTINGS;
  const base = buildOfferBase(sso);

  if (!base.showButton || !base.oidc?.issuer) {
    return base;
  }

  const probe = await probeIdpReachability(base.oidc.issuer);
  return {
    ...base,
    idpReachable: probe.reachable,
    ...(probe.error ? { idpReachabilityError: probe.error } : {}),
  };
}

export async function discoverSsoUnlock(cortexDir: string): Promise<SsoDiscoverResult> {
  const offer = await readSsoUnlockOffer(cortexDir);
  return {
    configured: offer.configured,
    enabled: offer.enabled,
    provisioned: offer.federatedUnlockReady,
    idpReachable: offer.idpReachable ?? false,
    ...(offer.idpReachabilityError ? { idpReachabilityError: offer.idpReachabilityError } : {}),
    suggestedButtonLabel: offer.suggestedButtonLabel,
    ...(offer.tenantHint ? { tenantHint: offer.tenantHint } : {}),
    breakGlassPassphrase: offer.breakGlassPassphrase,
    showButton: offer.showButton,
    available: offer.available,
    ...(offer.reason ? { reason: offer.reason } : {}),
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
