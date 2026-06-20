/**
 * Pre-unlock OIDC listener — no cortex lock, no host. Spawned by Tauri with
 * GRAPHNOSIS_SSO_LISTENER=1. Emits GRAPHNOSIS_SSO_AUTH_URL for browser open
 * and GRAPHNOSIS_SSO_RESULT JSON on success/failure.
 *
 * GRAPHNOSIS_SSO_PROBE=1 — reachability + lock-screen discover only (no browser).
 */

import {
  loadSettings,
  findCatalogEntryForCortex,
  checkCatalogUnlockEntitlement,
} from '@graphnosis-app/core/settings';
import {
  discoverSsoUnlock,
  oidcConfigFromSettings,
  runOidcUnlockFlow,
  type OidcUnlockOutcome,
} from '@graphnosis-app/core/sso';

function emitResult(outcome: OidcUnlockOutcome): never {
  console.error(`GRAPHNOSIS_SSO_RESULT:${JSON.stringify(outcome)}`);
  process.exit(outcome.ok ? 0 : 1);
}

async function main(): Promise<void> {
  const cortexDir = process.env.GRAPHNOSIS_CORTEX;
  if (!cortexDir) {
    emitResult({ ok: false, reason: 'missing_cortex', message: 'GRAPHNOSIS_CORTEX is required' });
  }

  if (process.env.GRAPHNOSIS_SSO_PROBE === '1') {
    const discover = await discoverSsoUnlock(cortexDir);
    console.error(`GRAPHNOSIS_SSO_PROBE_RESULT:${JSON.stringify(discover)}`);
    process.exit(0);
  }

  const settings = await loadSettings(cortexDir);
  const sso = settings.sso;
  if (!sso?.enabled) {
    emitResult({ ok: false, reason: 'sso_disabled', message: 'Enterprise SSO unlock is not enabled' });
  }
  if (!sso.federatedUnlockReady) {
    emitResult({
      ok: false,
      reason: 'not_provisioned',
      message: 'Federated unlock key not provisioned — owner must save SSO settings while unlocked',
    });
  }

  const config = oidcConfigFromSettings(sso);
  if (!config) {
    emitResult({ ok: false, reason: 'not_configured', message: 'OIDC issuer and client ID are required' });
  }

  const secretFromEnv = process.env.GRAPHNOSIS_SSO_CLIENT_SECRET?.trim();
  if (secretFromEnv) config.clientSecret = secretFromEnv;

  const outcome = await runOidcUnlockFlow({ config });
  if (outcome.ok) {
    const catalogEntries = settings.cortexCatalog?.entries ?? [];
    const catalogMatch = findCatalogEntryForCortex(catalogEntries, cortexDir);
    if (catalogMatch && catalogMatch.kind === 'org') {
      const ent = checkCatalogUnlockEntitlement(catalogMatch, outcome.groups);
      if (!ent.entitled) {
        const missing = ent.missingGroups?.join(', ') ?? 'required IdP groups';
        emitResult({
          ok: false,
          reason: 'catalog_not_entitled',
          message: ent.reason === 'missing_groups'
            ? `You are not in the IdP groups required for "${catalogMatch.displayName}" (${missing}). Contact IT to request access.`
            : `You are not entitled to unlock "${catalogMatch.displayName}".`,
        });
      }
    }
  }
  emitResult(outcome);
}

main().catch((e) => {
  emitResult({ ok: false, reason: 'internal_error', message: String(e) });
});
