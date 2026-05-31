#!/usr/bin/env node
/**
 * gen-gsk-keypair.mjs — generate a fresh Ed25519 keypair for signing .gsk packs.
 *
 * Usage: node scripts/gen-gsk-keypair.mjs
 *
 * Outputs:
 *   - The 64-byte hex secret key to stdout (add as GSK_SIGNING_KEY_HEX repo secret)
 *   - Writes ~/.graphnosis/gsk-signing.secret (local backup, never commit)
 *   - Prints the 32-byte public key as a Uint8Array literal to paste into
 *     apps/desktop-sidecar/src/gsk-format.ts (GSK_SIGNING_PUBLIC_KEY)
 *
 * Run this ONCE when rotating the signing key. After rotating:
 *   1. Update GSK_SIGNING_PUBLIC_KEY in gsk-format.ts with the printed literal.
 *   2. Add the printed secret hex as the GSK_SIGNING_KEY_HEX repo Actions secret.
 *   3. Rebuild and re-sign all official packs with `node scripts/build-gsk.mjs --sign`.
 *
 * WARNING: rotating the key invalidates all previously signed packs. All users
 * will see "tampered" warnings on packs signed with the old key until the app
 * ships the new public key. Only rotate when necessary.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Relaunch under tsx so we can import libsodium-wrappers-sumo.
const alreadyUnderTsx = process.env._GN_GEN_KEYPAIR_TSX === '1';
if (!alreadyUnderTsx) {
  const tsxBin = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsxBin)) {
    console.error('[gen-gsk-keypair] tsx not found. Run `pnpm install` first.');
    process.exit(1);
  }
  const result = spawnSync(
    tsxBin,
    [fileURLToPath(import.meta.url)],
    {
      stdio: 'inherit',
      env: { ...process.env, _GN_GEN_KEYPAIR_TSX: '1' },
      cwd: REPO_ROOT,
    },
  );
  process.exit(result.status ?? 1);
}

// Running under tsx — import libsodium via dynamic import.
const sodiumModule = await import('libsodium-wrappers-sumo');
const sodium = sodiumModule.default ?? sodiumModule;
await sodium.ready;

const keypair = sodium.crypto_sign_keypair();
const secretKeyHex = Buffer.from(keypair.privateKey).toString('hex');
const publicKeyBytes = keypair.publicKey;

// Write secret to ~/.graphnosis/gsk-signing.secret
const secretDir = join(homedir(), '.graphnosis');
mkdirSync(secretDir, { recursive: true });
const secretPath = join(secretDir, 'gsk-signing.secret');
writeFileSync(secretPath, secretKeyHex, { mode: 0o600 });

// Format public key as a Uint8Array literal for gsk-format.ts
const hexPairs = Array.from(publicKeyBytes).map((b) => '0x' + b.toString(16).padStart(2, '0'));
const rows = [];
for (let i = 0; i < hexPairs.length; i += 8) {
  rows.push('  ' + hexPairs.slice(i, i + 8).join(', ') + ',');
}
const uint8Literal = `new Uint8Array([\n${rows.join('\n')}\n])`;

console.log('');
console.log('=== GSK SIGNING KEY GENERATED ===');
console.log('');
console.log('Secret key written to:', secretPath);
console.log('');
console.log('Add as GitHub Actions secret GSK_SIGNING_KEY_HEX:');
console.log('');
console.log(secretKeyHex);
console.log('');
console.log('Update GSK_SIGNING_PUBLIC_KEY in apps/desktop-sidecar/src/gsk-format.ts:');
console.log('');
console.log(`const GSK_SIGNING_PUBLIC_KEY = ${uint8Literal};`);
console.log('');
console.log('Then rebuild all official packs: node scripts/build-gsk.mjs --sign');
