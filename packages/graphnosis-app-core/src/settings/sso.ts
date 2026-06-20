/**
 * Enterprise SSO — IdP-gated cortex unlock and group → role mapping.
 *
 * Phase 1 (shipped): settings types, persistence, Settings UI, IPC.
 * Phase 2: OIDC device / system-browser callback unlock on desktop.
 * Phase 3: SAML SP-initiated flow; org cortex subkeys.
 *
 * See apps/docs/src/content/docs/guides/enterprise-rbac.md.
 */

import type { SharingRole } from './rbac.js';
import { isSharingRole, normalizeSharingRole } from './rbac.js';

/** Federated login protocol. v1 implements OIDC first (desktop-friendly). */
export type SsoProtocol = 'oidc' | 'saml';

/** Maps an IdP group claim to a Graphnosis sharing role. */
export interface IdpGroupRoleMapping {
  /** IdP group name or id (case-insensitive match at runtime). */
  idpGroup: string;
  role: SharingRole;
}

/** OIDC provider configuration (Okta, Azure AD, Google Workspace, etc.). */
export interface OidcSsoConfig {
  /** Issuer URL — e.g. https://login.microsoftonline.com/{tenant}/v2.0 */
  issuer: string;
  clientId: string;
  /**
   * Client secret (confidential clients). In-memory on unlock; on-disk encrypted
   * form in `clientSecretEnc` once the host wires credential encryption.
   */
  clientSecret?: string;
  clientSecretEnc?: string;
  /** OAuth scopes. Default: openid profile email groups (when supported). */
  scopes?: string[];
  /** JWT claim for group membership. Default `groups`. */
  groupsClaim?: string;
  /**
   * Loopback redirect registered at the IdP for desktop callback.
   * Default http://127.0.0.1:4580/sso/callback when unset.
   */
  redirectUri?: string;
}

/** SAML 2.0 SP config — Phase D follow-on (enterprise browser / IdP-initiated). */
export interface SamlSsoConfig {
  entityId?: string;
  ssoUrl?: string;
  idpCertificate?: string;
}

export interface SsoLastLogin {
  at: number;
  email?: string;
  subject?: string;
  groups?: string[];
  resolvedRole?: SharingRole;
}

export interface EnterpriseSsoSettings {
  /** When true, unlock prefers IdP login (once Phase 2 flow ships). */
  enabled: boolean;
  protocol: SsoProtocol;
  /** Passphrase remains valid as break-glass recovery when true. */
  breakGlassPassphrase: boolean;
  oidc?: OidcSsoConfig;
  saml?: SamlSsoConfig;
  groupRoleMappings: IdpGroupRoleMapping[];
  lastLogin?: SsoLastLogin;
}

export const DEFAULT_OIDC_SCOPES = ['openid', 'profile', 'email'] as const;

export const DEFAULT_SSO_REDIRECT_URI = 'http://127.0.0.1:4580/sso/callback';

export const DEFAULT_SSO_SETTINGS: EnterpriseSsoSettings = {
  enabled: false,
  protocol: 'oidc',
  breakGlassPassphrase: true,
  groupRoleMappings: [],
};

/** Role precedence for group mapping — highest matching privilege wins. */
const GROUP_ROLE_PRECEDENCE: readonly SharingRole[] = [
  'admin-audit',
  'skill-train',
  'editor',
  'edit-approve',
  'remember',
  'recall-only',
  'viewer',
];

/**
 * Resolve the effective sharing role from IdP group claims using configured
 * mappings. Unmapped users receive `fallback` (default recall-only).
 */
export function resolveRoleFromIdpGroups(
  mappings: readonly IdpGroupRoleMapping[],
  idpGroups: readonly string[],
  fallback: SharingRole = 'recall-only',
): SharingRole {
  if (mappings.length === 0 || idpGroups.length === 0) return fallback;
  const groupSet = new Set(idpGroups.map((g) => g.trim().toLowerCase()).filter(Boolean));
  let best: SharingRole | null = null;
  let bestIdx = GROUP_ROLE_PRECEDENCE.length;
  for (const m of mappings) {
    const key = m.idpGroup.trim().toLowerCase();
    if (!key || !groupSet.has(key)) continue;
    const normalized = normalizeSharingRole(m.role);
    const idx = GROUP_ROLE_PRECEDENCE.indexOf(normalized);
    if (idx >= 0 && idx < bestIdx) {
      best = normalized;
      bestIdx = idx;
    }
  }
  return best ?? fallback;
}

export function isOidcSsoConfigured(oidc: OidcSsoConfig | undefined): boolean {
  return Boolean(oidc?.issuer?.trim() && oidc?.clientId?.trim());
}

export function isSamlSsoConfigured(saml: SamlSsoConfig | undefined): boolean {
  return Boolean(saml?.ssoUrl?.trim() && saml?.entityId?.trim());
}

export function isEnterpriseSsoConfigured(settings: EnterpriseSsoSettings | undefined): boolean {
  if (!settings) return false;
  if (settings.protocol === 'oidc') return isOidcSsoConfigured(settings.oidc);
  return isSamlSsoConfigured(settings.saml);
}

/** Public IPC / UI view — never includes client secrets. */
export interface EnterpriseSsoPublicView {
  enabled: boolean;
  protocol: SsoProtocol;
  breakGlassPassphrase: boolean;
  oidc?: {
    issuer: string;
    clientId: string;
    hasClientSecret: boolean;
    scopes: string[];
    groupsClaim: string;
    redirectUri: string;
  };
  saml?: SamlSsoConfig;
  groupRoleMappings: IdpGroupRoleMapping[];
  lastLogin?: SsoLastLogin;
  configured: boolean;
}

export function enterpriseSsoPublicView(
  raw: EnterpriseSsoSettings | undefined,
): EnterpriseSsoPublicView {
  const base = raw ?? DEFAULT_SSO_SETTINGS;
  const oidc = base.oidc;
  const scopes = (oidc?.scopes?.length ? oidc.scopes : [...DEFAULT_OIDC_SCOPES]);
  const publicOidc = oidc && (oidc.issuer || oidc.clientId)
    ? {
        issuer: oidc.issuer ?? '',
        clientId: oidc.clientId ?? '',
        hasClientSecret: Boolean(oidc.clientSecret?.length || oidc.clientSecretEnc?.length),
        scopes,
        groupsClaim: oidc.groupsClaim?.trim() || 'groups',
        redirectUri: oidc.redirectUri?.trim() || DEFAULT_SSO_REDIRECT_URI,
      }
    : undefined;
  return {
    enabled: base.enabled,
    protocol: base.protocol,
    breakGlassPassphrase: base.breakGlassPassphrase,
    ...(publicOidc ? { oidc: publicOidc } : {}),
    ...(base.saml ? { saml: { ...base.saml } } : {}),
    groupRoleMappings: [...base.groupRoleMappings],
    ...(base.lastLogin ? { lastLogin: { ...base.lastLogin } } : {}),
    configured: isEnterpriseSsoConfigured(base),
  };
}

function isIdpGroupRoleMapping(v: unknown): v is IdpGroupRoleMapping {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const role = r['role'];
  return typeof r['idpGroup'] === 'string'
    && r['idpGroup'].trim().length > 0
    && typeof role === 'string'
    && isSharingRole(role)
    && role !== 'owner';
}

export function sanitizeEnterpriseSsoSettings(
  raw: Partial<EnterpriseSsoSettings> | undefined,
): EnterpriseSsoSettings | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const protocol: SsoProtocol = raw.protocol === 'saml' ? 'saml' : 'oidc';
  const mappings = Array.isArray(raw.groupRoleMappings)
    ? raw.groupRoleMappings.filter(isIdpGroupRoleMapping)
    : [];

  let oidc: OidcSsoConfig | undefined;
  if (raw.oidc && typeof raw.oidc === 'object') {
    const o = raw.oidc;
    const issuer = typeof o.issuer === 'string' ? o.issuer.trim() : '';
    const clientId = typeof o.clientId === 'string' ? o.clientId.trim() : '';
    if (issuer || clientId) {
      oidc = {
        issuer,
        clientId,
        ...(typeof o.clientSecret === 'string' && o.clientSecret.length > 0
          ? { clientSecret: o.clientSecret }
          : {}),
        ...(typeof o.clientSecretEnc === 'string' && o.clientSecretEnc.length > 0
          ? { clientSecretEnc: o.clientSecretEnc }
          : {}),
        ...(Array.isArray(o.scopes) && o.scopes.every((s) => typeof s === 'string')
          ? { scopes: o.scopes.filter((s) => s.length > 0) }
          : {}),
        ...(typeof o.groupsClaim === 'string' && o.groupsClaim.trim()
          ? { groupsClaim: o.groupsClaim.trim() }
          : {}),
        ...(typeof o.redirectUri === 'string' && o.redirectUri.trim()
          ? { redirectUri: o.redirectUri.trim() }
          : {}),
      };
    }
  }

  let saml: SamlSsoConfig | undefined;
  if (raw.saml && typeof raw.saml === 'object') {
    const s = raw.saml;
    saml = {
      ...(typeof s.entityId === 'string' ? { entityId: s.entityId.trim() } : {}),
      ...(typeof s.ssoUrl === 'string' ? { ssoUrl: s.ssoUrl.trim() } : {}),
      ...(typeof s.idpCertificate === 'string' ? { idpCertificate: s.idpCertificate } : {}),
    };
    if (!saml.entityId && !saml.ssoUrl && !saml.idpCertificate) saml = undefined;
  }

  let lastLogin: SsoLastLogin | undefined;
  if (raw.lastLogin && typeof raw.lastLogin === 'object') {
    const l = raw.lastLogin;
    if (typeof l.at === 'number' && Number.isFinite(l.at)) {
      lastLogin = {
        at: l.at,
        ...(typeof l.email === 'string' ? { email: l.email } : {}),
        ...(typeof l.subject === 'string' ? { subject: l.subject } : {}),
        ...(Array.isArray(l.groups) ? { groups: l.groups.filter((g) => typeof g === 'string') } : {}),
        ...(typeof l.resolvedRole === 'string' && isSharingRole(l.resolvedRole)
          ? { resolvedRole: l.resolvedRole }
          : {}),
      };
    }
  }

  return {
    enabled: raw.enabled === true,
    protocol,
    breakGlassPassphrase: raw.breakGlassPassphrase !== false,
    ...(oidc ? { oidc } : {}),
    ...(saml ? { saml } : {}),
    groupRoleMappings: mappings,
    ...(lastLogin ? { lastLogin } : {}),
  };
}
