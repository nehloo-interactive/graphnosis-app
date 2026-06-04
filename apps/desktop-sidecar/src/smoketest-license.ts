/**
 * License-validator smoke test.
 *
 * Exercises the entitlement-gating logic that protects Pro features, without
 * needing the real signing private key: we generate a throwaway Ed25519 keypair,
 * point a LicenseValidator at the test PUBLIC key (via the create() override),
 * mint tokens with the test SECRET key, and assert verify/hasFeature behaviour.
 *
 * Run: pnpm --filter @graphnosis-app/desktop-sidecar smoke:license
 * Exits non-zero on the first failed assertion.
 */

import sodium from 'libsodium-wrappers-sumo';
import { LicenseValidator } from './license-validator.js';

function log(phase: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ phase, ...(extra ?? {}) }));
}

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) { log(`ok.${name}`); }
  else { failures++; log(`FAIL.${name}`); }
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface Payload {
  sub: string; plan: string; features: string[]; iat: number; exp: number; renews?: boolean;
}

async function main(): Promise<void> {
  await sodium.ready;
  log('start');

  // Throwaway signing keypair (stands in for the Worker's secret).
  const kp = sodium.crypto_sign_keypair();
  const sign = (p: Payload): string => {
    const payloadBytes = new TextEncoder().encode(JSON.stringify(p));
    const sig = sodium.crypto_sign_detached(payloadBytes, kp.privateKey);
    return `${b64url(payloadBytes)}.${b64url(sig)}`;
  };
  const nowS = Math.floor(Date.now() / 1000);

  // Validator that trusts ONLY the test public key.
  const v = await LicenseValidator.create(kp.publicKey);

  // 1. A valid, unexpired token verifies and unlocks its listed features.
  const good = sign({
    sub: 'test@example.com', plan: 'monthly-subscription',
    features: ['skill-training', 'gnn-exploration'],
    iat: nowS, exp: nowS + 3600, renews: true,
  });
  const payload = v.verifyToken(good);
  check('valid-token-verifies', payload !== null);
  check('hasFeature-listed', v.hasFeature(good, 'skill-training'));
  check('renews-roundtrips', payload?.renews === true);

  // 2. A feature NOT in the token is denied even on a valid token.
  const limited = sign({
    sub: 'test@example.com', plan: 'gnn-only',
    features: ['gnn-exploration'], iat: nowS, exp: nowS + 3600,
  });
  check('hasFeature-unlisted-denied', v.hasFeature(limited, 'skill-training') === false);

  // 3. Expired token is rejected (signature valid, exp in the past).
  const expired = sign({
    sub: 'test@example.com', plan: 'monthly-subscription',
    features: ['skill-training'], iat: nowS - 7200, exp: nowS - 3600,
  });
  check('expired-token-rejected', v.verifyToken(expired) === null);

  // 4. Tampered payload (valid signature no longer matches) is rejected.
  const [p, s] = good.split('.');
  const tamperedPayload = JSON.parse(Buffer.from(p!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  tamperedPayload.features = ['skill-training', 'gnn-exploration', 'forged'];
  const tampered = `${b64url(new TextEncoder().encode(JSON.stringify(tamperedPayload)))}.${s}`;
  check('tampered-payload-rejected', v.verifyToken(tampered) === null);

  // 5. Token signed by a DIFFERENT key is rejected — the core anti-theft guard.
  const attacker = sodium.crypto_sign_keypair();
  const forgedBytes = new TextEncoder().encode(JSON.stringify({
    sub: 'attacker@example.com', plan: 'monthly-subscription',
    features: ['skill-training', 'gnn-exploration'], iat: nowS, exp: nowS + 3600,
  }));
  const forged = `${b64url(forgedBytes)}.${b64url(sodium.crypto_sign_detached(forgedBytes, attacker.privateKey))}`;
  check('foreign-key-rejected', v.verifyToken(forged) === null);

  // 6. Malformed / garbage inputs return null, never throw.
  check('garbage-rejected', v.verifyToken('not-a-token') === null);
  check('empty-rejected', v.verifyToken('') === null);
  check('null-hasFeature-false', v.hasFeature(null, 'skill-training') === false);

  // 7. The embedded production validator (no override) must boot and reject a
  //    foreign-signed token — proves the real key is wired, not the test one.
  const prod = await LicenseValidator.create();
  check('prod-rejects-foreign', prod.verifyToken(forged) === null);

  log('done', { failures });
  if (failures > 0) {
    console.error(`license smoke FAILED: ${failures} assertion(s)`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
