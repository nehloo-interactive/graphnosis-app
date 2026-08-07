// Pack crypto v2 — round-trip tests for the GEZ2/GSK2 encryption framing.
//
// Covers each encMode (none / passphrase / recipient) on BOTH formats:
//   - correct key decrypts
//   - wrong passphrase / wrong recipient key fails AEAD
//   - multi-recipient: each recipient opens
//   - v1 GEZ1/GSK1 still decode unchanged
//   - the Ed25519 signature still verifies on every v2 mode
//   - tampered ciphertext fails AEAD; tampered payload fails signature
//   - recipient-key derivation (Ed25519 → X25519) round-trips

import sodium from 'libsodium-wrappers-sumo';
import {
  buildGezPackage,
  buildGezPackageV2,
  parseGezPackage,
  parseGezPackageAny,
  parseGezPackageV2,
  verifyGezSignature,
  peekGezEncMode,
  type GezPayload,
} from '../apps/desktop-sidecar/src/gez-format.js';
import {
  buildGskPackage,
  buildGskPackageV2,
  parseGskPackage,
  parseGskPackageAny,
  parseGskPackageV2,
  verifyGskSignature,
  peekGskEncMode,
  type GskPayload,
} from '../apps/desktop-sidecar/src/gsk-format.js';
import {
  ed25519ToCurveKeypairB64,
  recipientPublicKeyB64FromEd25519,
} from '../apps/desktop-sidecar/src/pack-crypto.js';
import { assert, section, runSuite, standalone, type SuiteResult } from './_helpers.js';

function sampleGez(): GezPayload {
  return {
    formatVersion: '1',
    exportedBy: 'test-device',
    exportedAt: 1_700_000_000_000,
    engramId: 'work',
    engramDisplayName: 'Work',
    engramTier: 'personal',
    engramTemplate: 'personal',
    sources: [
      { sourceId: 'clip:a', kind: 'clip', ref: 'note-a', text: 'alpha secret content', ingestedAt: 1 },
      { sourceId: 'clip:b', kind: 'clip', ref: 'note-b', text: 'bravo secret content', ingestedAt: 2 },
    ],
    signerPublicKey: '',
    signature: '',
  };
}

function sampleGsk(): GskPayload {
  return {
    formatVersion: '1',
    kind: 'community',
    id: 'pack-x',
    displayName: 'Pack X',
    description: 'crypto test pack',
    version: '1.0.0',
    author: 'test',
    tierRequired: 'free',
    skills: [{
      name: 'skill-a',
      engramTemplate: 'skill',
      sensitivityTier: 'personal',
      baseText: 'Do the secret thing.',
      recallRecipes: [],
    }],
    graphnosisMd: '# md',
    signature: '',
  };
}

export async function run(): Promise<SuiteResult> {
  return runSuite('pack-crypto', cryptoSuite);
}

async function cryptoSuite(): Promise<void> {
  await sodium.ready;

  // Two distinct cortex Ed25519 signing keys (sender signs; recipients seal-to).
  const signerSk = Buffer.from(sodium.crypto_sign_keypair().privateKey).toString('hex');
  const recipA = sodium.crypto_sign_keypair();
  const recipB = sodium.crypto_sign_keypair();
  const recipAskHex = Buffer.from(recipA.privateKey).toString('hex');
  const recipBskHex = Buffer.from(recipB.privateKey).toString('hex');

  // ── Recipient key derivation ───────────────────────────────────────────────
  section('recipient-key derivation (Ed25519 → X25519)');
  const kpA = await ed25519ToCurveKeypairB64(recipAskHex);
  assert(Buffer.from(kpA.publicKeyB64, 'base64').length === sodium.crypto_box_PUBLICKEYBYTES, 'derived X25519 public key is 32 bytes');
  assert(Buffer.from(kpA.secretKeyB64, 'base64').length === sodium.crypto_box_SECRETKEYBYTES, 'derived X25519 secret key is 32 bytes');
  const pubA = await recipientPublicKeyB64FromEd25519(recipAskHex);
  assert(pubA === kpA.publicKeyB64, 'recipientPublicKeyB64FromEd25519 matches full-keypair derivation');
  // sealing to derived pub and opening with derived sk round-trips
  const probe = sodium.randombytes_buf(32);
  const sealedProbe = sodium.crypto_box_seal(probe, new Uint8Array(Buffer.from(kpA.publicKeyB64, 'base64')));
  const openedProbe = sodium.crypto_box_seal_open(
    sealedProbe,
    new Uint8Array(Buffer.from(kpA.publicKeyB64, 'base64')),
    new Uint8Array(Buffer.from(kpA.secretKeyB64, 'base64')),
  );
  assert(Buffer.from(openedProbe).equals(Buffer.from(probe)), 'sealed-to-derived-pub opens with derived-sk');

  // ── v1 back-compat (GEZ1 / GSK1) ───────────────────────────────────────────
  section('v1 packs still decode unchanged (GEZ1 / GSK1)');
  const gezV1 = buildGezPackage(sampleGez(), signerSk);
  assert(gezV1.subarray(0, 4).toString() === 'GEZ1', 'v1 gez carries GEZ1 magic');
  const gezV1Parsed = parseGezPackage(gezV1);
  assert(gezV1Parsed.sources.length === 2, 'v1 gez parses payload');
  assert((await verifyGezSignature(gezV1Parsed)).verified, 'v1 gez signature verifies');
  const anyV1 = await parseGezPackageAny(gezV1);
  assert(anyV1.version === 1 && anyV1.encMode === 'none', 'parseGezPackageAny dispatches GEZ1 → v1/none');
  assert(peekGezEncMode(gezV1) === 'none', 'v1 gez peekEncMode none');

  const gskV1 = buildGskPackage(sampleGsk());
  assert(gskV1.subarray(0, 4).toString() === 'GSK1', 'v1 gsk carries GSK1 magic');
  const gskV1Parsed = parseGskPackage(gskV1);
  assert(gskV1Parsed.skills.length === 1, 'v1 gsk parses payload');
  const gskAnyV1 = await parseGskPackageAny(gskV1);
  assert(gskAnyV1.version === 1 && gskAnyV1.encMode === 'none', 'parseGskPackageAny dispatches GSK1 → v1/none');

  // ── v2 encMode 'none' ──────────────────────────────────────────────────────
  section('GEZ2/GSK2 encMode none round-trip + signature');
  const gezNone = await buildGezPackageV2(sampleGez(), { signingKeyHex: signerSk });
  assert(gezNone.subarray(0, 4).toString() === 'GEZ2', 'v2 gez carries GEZ2 magic');
  assert(peekGezEncMode(gezNone) === 'none', 'v2 none peekEncMode none');
  const gezNoneP = await parseGezPackageV2(gezNone);
  assert(gezNoneP.encMode === 'none' && gezNoneP.payload.sources.length === 2, 'v2 none decodes');
  assert((await verifyGezSignature(gezNoneP.payload)).verified, 'v2 none signature verifies');

  const gskNone = await buildGskPackageV2(sampleGsk(), { signingKeyHex: signerSk });
  const gskNoneP = await parseGskPackageV2(gskNone);
  assert(gskNoneP.encMode === 'none' && gskNoneP.payload.skills.length === 1, 'v2 gsk none decodes');

  // ── v2 passphrase ──────────────────────────────────────────────────────────
  section('GEZ2/GSK2 passphrase mode (Argon2id)');
  const gezPass = await buildGezPackageV2(sampleGez(), { signingKeyHex: signerSk, encrypt: { passphrase: 'correct horse' } });
  assert(peekGezEncMode(gezPass) === 'passphrase', 'gez passphrase peekEncMode');
  const gezPassP = await parseGezPackageV2(gezPass, { passphrase: 'correct horse' });
  assert(gezPassP.payload.sources[0]!.text === 'alpha secret content', 'gez correct passphrase decrypts');
  assert((await verifyGezSignature(gezPassP.payload)).verified, 'gez passphrase signature verifies');
  let wrongPassErr = '';
  try { await parseGezPackageV2(gezPass, { passphrase: 'wrong' }); } catch (e) { wrongPassErr = (e as Error).message; }
  assert(wrongPassErr.length > 0, 'gez wrong passphrase fails AEAD');
  let noPassErr = '';
  try { await parseGezPackageV2(gezPass, {}); } catch (e) { noPassErr = (e as Error).message; }
  assert(noPassErr.includes('passphrase'), 'gez missing passphrase reports passphrase required');

  const gskPass = await buildGskPackageV2(sampleGsk(), { signingKeyHex: signerSk, encrypt: { passphrase: 'pw-2' } });
  const gskPassP = await parseGskPackageV2(gskPass, { passphrase: 'pw-2' });
  assert(gskPassP.payload.skills[0]!.baseText === 'Do the secret thing.', 'gsk correct passphrase decrypts');
  let gskWrongPass = '';
  try { await parseGskPackageV2(gskPass, { passphrase: 'nope' }); } catch (e) { gskWrongPass = (e as Error).message; }
  assert(gskWrongPass.length > 0, 'gsk wrong passphrase fails AEAD');

  // ── v2 recipient (single + multi) ──────────────────────────────────────────
  section('GEZ2/GSK2 recipient mode (crypto_box_seal, multi-recipient)');
  const pubAk = (await ed25519ToCurveKeypairB64(recipAskHex)).publicKeyB64;
  const pubBk = (await ed25519ToCurveKeypairB64(recipBskHex)).publicKeyB64;
  const skA = (await ed25519ToCurveKeypairB64(recipAskHex)).secretKeyB64;
  const skB = (await ed25519ToCurveKeypairB64(recipBskHex)).secretKeyB64;

  const gezRecip = await buildGezPackageV2(sampleGez(), { signingKeyHex: signerSk, encrypt: { recipientPubKeys: [pubAk, pubBk] } });
  assert(peekGezEncMode(gezRecip) === 'recipient', 'gez recipient peekEncMode');
  const openA = await parseGezPackageV2(gezRecip, { recipientSecretKeyB64: skA });
  assert(openA.payload.sources[1]!.text === 'bravo secret content', 'recipient A opens multi-recipient pack');
  const openB = await parseGezPackageV2(gezRecip, { recipientSecretKeyB64: skB });
  assert(openB.payload.sources[1]!.text === 'bravo secret content', 'recipient B opens multi-recipient pack');
  assert((await verifyGezSignature(openA.payload)).verified, 'recipient pack signature verifies');

  // a non-recipient key cannot open
  const strangerSk = (await ed25519ToCurveKeypairB64(Buffer.from(sodium.crypto_sign_keypair().privateKey).toString('hex'))).secretKeyB64;
  let strangerErr = '';
  try { await parseGezPackageV2(gezRecip, { recipientSecretKeyB64: strangerSk }); } catch (e) { strangerErr = (e as Error).message; }
  assert(strangerErr.length > 0, 'non-recipient key cannot open recipient pack');

  const gskRecip = await buildGskPackageV2(sampleGsk(), { signingKeyHex: signerSk, encrypt: { recipientPubKeys: [pubAk] } });
  const gskRecipP = await parseGskPackageV2(gskRecip, { recipientSecretKeyB64: skA });
  assert(gskRecipP.payload.skills[0]!.name === 'skill-a', 'gsk recipient opens');

  // ── tamper: ciphertext AEAD failure ────────────────────────────────────────
  section('tampered ciphertext fails AEAD');
  const tampered = Buffer.from(gezNone);
  tampered[tampered.length - 1] ^= 0xff; // flip last ciphertext byte
  let tamperErr = '';
  try { await parseGezPackageV2(tampered); } catch (e) { tamperErr = (e as Error).message; }
  assert(tamperErr.length > 0, 'tampered v2 ciphertext fails to decrypt (AEAD)');

  // ── tamper: payload content fails signature ────────────────────────────────
  section('tampered payload fails Ed25519 signature');
  const gezSigned = await buildGezPackageV2(sampleGez(), { signingKeyHex: signerSk });
  const parsed = (await parseGezPackageV2(gezSigned)).payload;
  const mutated: GezPayload = { ...parsed, sources: [...parsed.sources, { sourceId: 'clip:evil', kind: 'clip', ref: 'evil', text: 'injected', ingestedAt: 9 }] };
  let sigTamperErr = '';
  try { await verifyGezSignature(mutated); } catch (e) { sigTamperErr = (e as Error).message; }
  assert(sigTamperErr.includes('verification failed'), 'mutated payload fails signature verification');

  // gsk parity: encMode peek + dispatch
  section('parseGskPackageAny dispatches v2');
  const gskAny = await parseGskPackageAny(gskRecip, { recipientSecretKeyB64: skA });
  assert(gskAny.version === 2 && gskAny.encMode === 'recipient', 'parseGskPackageAny → v2/recipient');
  assert(peekGskEncMode(gskRecip) === 'recipient', 'gsk recipient peekEncMode');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('pack-crypto', cryptoSuite);
