/**
 * Pre-unlock OIDC listener — no cortex lock, no host. Spawned by Tauri with
 * GRAPHNOSIS_SSO_LISTENER=1. Emits GRAPHNOSIS_SSO_AUTH_URL for browser open
 * and GRAPHNOSIS_SSO_RESULT JSON on success/failure.
 */

import { loadSettings } from '@graphnosis-app/core/settings';
import {
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
  emitResult(outcome);
}

main().catch((e) => {
  emitResult({ ok: false, reason: 'internal_error', message: String(e) });
});
