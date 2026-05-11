// libsodium-wrappers-sumo ships a broken ESM export map (points at a .mjs that
// isn't in the tarball). Load via CJS createRequire — its CommonJS entry works.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sodium = require('libsodium-wrappers-sumo') as typeof import('libsodium-wrappers-sumo');

let ready: Promise<void> | null = null;
function init(): Promise<void> {
  if (!ready) ready = sodium.ready;
  return ready;
}

export interface DerivedKey {
  key: Uint8Array;
  salt: Uint8Array;
  opslimit: number;
  memlimit: number;
}

export async function deriveKey(passphrase: string, salt?: Uint8Array): Promise<DerivedKey> {
  await init();
  const s = salt ?? sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const opslimit = sodium.crypto_pwhash_OPSLIMIT_MODERATE;
  const memlimit = sodium.crypto_pwhash_MEMLIMIT_MODERATE;
  const key = sodium.crypto_pwhash(
    sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
    passphrase,
    s,
    opslimit,
    memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  return { key, salt: s, opslimit, memlimit };
}

const MAGIC = new TextEncoder().encode('GNAPP\x01');

export async function encrypt(plaintext: Uint8Array, key: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  await init();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const chunkSize = 64 * 1024;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < plaintext.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, plaintext.length);
    const isFinal = end === plaintext.length;
    const tag = isFinal
      ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
      state,
      plaintext.subarray(offset, end),
      null,
      tag,
    );
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, ct.length, true);
    chunks.push(len, ct);
  }
  const body = concat(chunks);
  return concat([MAGIC, salt, header, body]);
}

export async function decrypt(ciphertext: Uint8Array, passphraseOrKey: string | Uint8Array): Promise<Uint8Array> {
  await init();
  if (!startsWith(ciphertext, MAGIC)) throw new Error('Not a Graphnosis App encrypted blob');
  let cursor = MAGIC.length;
  const salt = ciphertext.subarray(cursor, cursor + sodium.crypto_pwhash_SALTBYTES);
  cursor += sodium.crypto_pwhash_SALTBYTES;
  const headerLen = sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  const header = ciphertext.subarray(cursor, cursor + headerLen);
  cursor += headerLen;

  const key =
    typeof passphraseOrKey === 'string'
      ? (await deriveKey(passphraseOrKey, salt)).key
      : passphraseOrKey;

  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
  const out: Uint8Array[] = [];
  while (cursor < ciphertext.length) {
    const len = new DataView(
      ciphertext.buffer,
      ciphertext.byteOffset + cursor,
      4,
    ).getUint32(0, true);
    cursor += 4;
    const chunk = ciphertext.subarray(cursor, cursor + len);
    cursor += len;
    const r = sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk, null);
    if (!r) throw new Error('Decryption failed (wrong passphrase or tampered file)');
    out.push(r.message);
    if (r.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) break;
  }
  return concat(out);
}

// BIP-39-style recovery phrase: a separately-encrypted copy of the data-encryption key.
// The phrase is the entropy source for an Argon2id key that wraps the real key.
export async function makeRecoveryWrap(dataKey: Uint8Array, recoveryPhrase: string): Promise<Uint8Array> {
  return encrypt(dataKey, (await deriveKey(recoveryPhrase)).key, (await deriveKey(recoveryPhrase)).salt);
}

export async function unwrapRecovery(blob: Uint8Array, recoveryPhrase: string): Promise<Uint8Array> {
  return decrypt(blob, recoveryPhrase);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function startsWith(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
