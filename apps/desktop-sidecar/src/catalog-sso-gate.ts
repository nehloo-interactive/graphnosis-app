/**
 * SSO session gates for org catalog packages — subscribe/install + recall.
 */

import type { SharingRole } from '@graphnosis-app/core/settings';
import { hasActiveSsoUnlockSession } from '@graphnosis-app/core/settings';
import type { GraphnosisHost } from './host.js';

export class SsoRecallRequiredError extends Error {
  readonly code = 'sso_required' as const;

  constructor(
    public readonly graphIds: string[],
    message: string,
  ) {
    super(message);
    this.name = 'SsoRecallRequiredError';
  }
}

export function catalogHasSsoSession(deps: {
  ssoSession?: { role: SharingRole } | null;
  sharingScope?: { role: SharingRole; engrams: string[] | '*'; except?: string[] } | null;
}): boolean {
  return hasActiveSsoUnlockSession({
    ...(deps.ssoSession !== undefined ? { ssoSession: deps.ssoSession } : {}),
    ...(deps.sharingScope !== undefined ? { sharingScope: deps.sharingScope } : {}),
  });
}

export const CATALOG_SSO_REQUIRED_MESSAGE =
  'This organization package requires Enterprise SSO unlock for this session. Sign in with your IdP instead of passphrase-only unlock.';

/**
 * Federated recall silently excludes SSO-gated engrams; explicit `only_engrams`
 * recall throws when the session lacks an IdP unlock marker.
 */
export function checkRecallSsoGate(
  host: GraphnosisHost,
  sessionDeps: {
    ssoSession?: { role: SharingRole } | null;
    sharingScope?: { role: SharingRole; engrams: string[] | '*'; except?: string[] } | null;
  },
  onlyGraphIds: string[] | null,
): { autoExceptGraphIds: string[] } {
  if (catalogHasSsoSession(sessionDeps)) {
    return { autoExceptGraphIds: [] };
  }

  const isExplicit = onlyGraphIds !== null;
  const candidates = onlyGraphIds ?? host.listGraphs();
  const gatedIds: string[] = [];
  for (const graphId of candidates) {
    if (host.getGraphMetadata(graphId)?.requireSsoSession === true) {
      gatedIds.push(graphId);
    }
  }
  if (gatedIds.length === 0) return { autoExceptGraphIds: [] };

  if (isExplicit) {
    const names = gatedIds.map((id) => host.getGraphMetadata(id)?.displayName ?? id);
    const label = names.length === 1 ? `"${names[0]!}"` : names.map((n) => `"${n}"`).join(', ');
    throw new SsoRecallRequiredError(
      gatedIds,
      `⛔ SSO sign-in required. ${label} require${names.length === 1 ? 's' : ''} an Enterprise IdP unlock for this session — passphrase-only unlock is not sufficient. Unlock with SSO in the Graphnosis app.`,
    );
  }

  return { autoExceptGraphIds: gatedIds };
}
