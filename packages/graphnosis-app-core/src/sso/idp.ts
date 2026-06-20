/**
 * IdP discovery helpers — reachability probe, friendly labels, tenant binding.
 */

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

export interface IdpProbeResult {
  reachable: boolean;
  error?: string;
}

export interface IdpUiHints {
  suggestedButtonLabel: string;
  tenantHint?: string;
}

/** Friendly lock-screen label from OIDC issuer URL. */
export function suggestedIdpButtonLabel(issuer: string): string {
  const lower = issuer.trim().toLowerCase();
  if (!lower) return 'Sign in with company account';
  if (lower.includes('login.microsoftonline.com') || lower.includes('sts.windows.net')) {
    return 'Sign in with Microsoft';
  }
  if (lower.includes('accounts.google.com') || lower.includes('googleusercontent.com')) {
    return 'Sign in with Google';
  }
  if (lower.includes('.okta.com') || lower.includes('oktapreview.com')) {
    return 'Sign in with Okta';
  }
  if (lower.includes('auth0.com')) {
    return 'Sign in with Auth0';
  }
  if (lower.includes('onelogin.com')) {
    return 'Sign in with OneLogin';
  }
  return 'Sign in with company account';
}

/** Extract Azure AD tenant GUID from a v2 issuer URL when present. */
export function parseTenantIdFromIssuer(issuer: string): string | undefined {
  const trimmed = issuer.trim().replace(/\/$/, '');
  const m = trimmed.match(/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/i);
  return m?.[1];
}

export function tenantHintFromConfig(issuer: string, explicitTenantId?: string): string | undefined {
  const tid = explicitTenantId?.trim() || parseTenantIdFromIssuer(issuer);
  if (tid) return tid;
  try {
    const host = new URL(issuer).hostname;
    if (host && host !== 'localhost') return host;
  } catch { /* ignore */ }
  return undefined;
}

export function idpUiHints(issuer: string, explicitTenantId?: string): IdpUiHints {
  const tenantHint = tenantHintFromConfig(issuer, explicitTenantId);
  return {
    suggestedButtonLabel: suggestedIdpButtonLabel(issuer),
    ...(tenantHint ? { tenantHint } : {}),
  };
}

function probeAbortSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

/**
 * Lightweight reachability check — GET OIDC discovery (HEAD often blocked by IdPs).
 * Used pre-unlock to detect VPN / corp-network requirements.
 */
export async function probeIdpReachability(
  issuer: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<IdpProbeResult> {
  const trimmed = issuer.trim();
  if (!trimmed) {
    return { reachable: false, error: 'issuer not configured' };
  }
  const base = trimmed.replace(/\/$/, '');
  const url = `${base}/.well-known/openid-configuration`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: probeAbortSignal(timeoutMs),
    });
    if (!res.ok) {
      return { reachable: false, error: `HTTP ${res.status} from IdP` };
    }
    const doc = await res.json() as { authorization_endpoint?: string };
    if (!doc.authorization_endpoint) {
      return { reachable: false, error: 'incomplete OIDC discovery document' };
    }
    return { reachable: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = /abort|timeout|timed out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(msg)
      ? 'IdP unreachable — connect to your company network'
      : msg;
    return { reachable: false, error: friendly };
  }
}

export interface TenantValidationConfig {
  issuer: string;
  oidcTenantId?: string;
}

export interface TenantValidationResult {
  ok: boolean;
  reason?: string;
  message?: string;
}

/**
 * After ID-token verification, ensure the login belongs to the configured org tenant.
 * Entra: `tid` claim; all IdPs: normalized `iss` must match configured issuer.
 */
export function validateOidcTenantClaims(
  claims: Record<string, unknown>,
  config: TenantValidationConfig,
): TenantValidationResult {
  const issuerNorm = config.issuer.trim().replace(/\/$/, '');
  const iss = claims['iss'];
  const issNorm = typeof iss === 'string' ? iss.replace(/\/$/, '') : '';
  if (!issNorm) {
    return { ok: false, reason: 'missing_iss', message: 'ID token missing issuer claim' };
  }
  if (issNorm !== issuerNorm) {
    return {
      ok: false,
      reason: 'issuer_mismatch',
      message: 'Signed in with a different organization than configured for this cortex',
    };
  }

  const expectedTenant = config.oidcTenantId?.trim()
    || parseTenantIdFromIssuer(config.issuer);
  if (!expectedTenant) {
    return { ok: true };
  }

  const tid = claims['tid'];
  if (typeof tid === 'string' && tid.trim()) {
    if (tid.trim().toLowerCase() !== expectedTenant.toLowerCase()) {
      return {
        ok: false,
        reason: 'tenant_mismatch',
        message: 'Your account belongs to a different organization than this cortex',
      };
    }
    return { ok: true };
  }

  // Non-Entra IdPs may omit tid — issuer match above is sufficient.
  return { ok: true };
}
