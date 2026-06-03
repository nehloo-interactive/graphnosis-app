// WebAuthn credential store (A8 — biometric browser unlock).
//
// The personal-server browser UI gates a session behind a static access token.
// WebAuthn lets a registered device (Touch ID / Windows Hello / a security key)
// stand in for typing that token: the credential's public key is stored here,
// and a successful assertion mints the same session bearer token /api/unlock
// issues. The cortex is ALREADY unlocked server-side when this runs — these
// credentials authenticate *access to the server*, they don't decrypt the
// cortex.
//
// Storage: a single AES-encrypted file `<cortexDir>/webauthn-creds.json.enc`
// (same crypto + atomic-write pattern as the other side-tables). Public keys
// aren't secret, but keeping them in the encrypted cortex dir avoids leaking
// which devices can reach the server.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';

const { encrypt, decrypt } = crypto;

export interface WebAuthnCredential {
  /** Credential ID, base64url. */
  id: string;
  /** COSE public key bytes, base64url-encoded. */
  publicKey: string;
  /** Signature counter (clone-detection). */
  counter: number;
  /** Authenticator transports hint (usb/internal/hybrid…). */
  transports?: string[];
  /** Human label shown in the UI (e.g. "MacBook Touch ID"). */
  label: string;
  createdAt: number;
}

export interface WebAuthnStoreOptions {
  cortexDir: string;
  key: Uint8Array;
  salt: Uint8Array;
}

export class WebAuthnCredentialStore {
  private readonly file: string;
  private readonly key: Uint8Array;
  private readonly salt: Uint8Array;
  private cache: WebAuthnCredential[] | null = null;

  constructor(opts: WebAuthnStoreOptions) {
    this.file = path.join(opts.cortexDir, 'webauthn-creds.json.enc');
    this.key = opts.key;
    this.salt = opts.salt;
  }

  async loadAll(): Promise<WebAuthnCredential[]> {
    if (this.cache) return this.cache;
    try {
      const bytes = await fs.readFile(this.file);
      const pt = await decrypt(new Uint8Array(bytes), this.key);
      const parsed = JSON.parse(new TextDecoder().decode(pt)) as WebAuthnCredential[];
      this.cache = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.cache = [];
      else throw e;
    }
    return this.cache;
  }

  private async persist(creds: WebAuthnCredential[]): Promise<void> {
    this.cache = creds;
    const json = new TextEncoder().encode(JSON.stringify(creds));
    const ct = await encrypt(json, this.key, this.salt);
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, Buffer.from(ct));
    await fs.rename(tmp, this.file);
  }

  /** Add (or replace by id) a credential. */
  async add(cred: WebAuthnCredential): Promise<void> {
    const all = await this.loadAll();
    const kept = all.filter((c) => c.id !== cred.id);
    await this.persist([...kept, cred]);
  }

  async getById(id: string): Promise<WebAuthnCredential | null> {
    return (await this.loadAll()).find((c) => c.id === id) ?? null;
  }

  /** Update only the signature counter for a credential after a successful auth. */
  async updateCounter(id: string, counter: number): Promise<void> {
    const all = await this.loadAll();
    const idx = all.findIndex((c) => c.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx]!, counter };
    await this.persist(all);
  }

  /** Remove a credential (revoke a device). */
  async remove(id: string): Promise<void> {
    const all = await this.loadAll();
    const kept = all.filter((c) => c.id !== id);
    if (kept.length !== all.length) await this.persist(kept);
  }

  /** Public listing for the UI — id, label, createdAt only. */
  async list(): Promise<Array<{ id: string; label: string; createdAt: number }>> {
    return (await this.loadAll()).map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt }));
  }
}
