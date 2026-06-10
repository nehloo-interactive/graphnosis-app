// Device identity & TOFU peer registry for the signed op-log (Finding #13).
//
// Each install owns:
//   • a STABLE deviceId (random, persisted — replaces the old PID-based id that
//     changed every restart),
//   • an Ed25519 keypair (private key encrypted at rest with the cortex data key),
//   • a monotonic op-log sequence counter (`nextSeq`),
//   • a PINNED registry of other devices' public keys (encrypted, so a party
//     without the data key can't swap a peer's key — TOFU integrity).
//
// `device.json` (per install) holds the above. `devices.json` (synced) is the
// DISCOVERY channel: every device announces its own pubkey there. On load we
// TOFU-pin any newly-announced device into our encrypted pinned set; a pubkey
// CHANGE for an already-pinned device is surfaced as a possible attack and the
// original pin is kept.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { crypto } from '@nehloo-interactive/graphnosis-secure-sync';

const DEVICE_FILE = 'device.json';
const REGISTRY_FILE = 'devices.json';

interface DeviceFileV2 {
  v: 2;
  deviceId: string;
  signPublicKey: string;   // base64 (public)
  secretEnc: string;       // base64 — encrypt(secretKey, dataKey)
  nextSeq: number;
  pinnedEnc?: string;      // base64 — encrypt(JSON {deviceId: pubKeyB64}, dataKey)
}

interface RegistryEntry { pubKey: string; firstSeenAt: number }
type Registry = Record<string, RegistryEntry>;

export interface PeerKeyAlert {
  deviceId: string;
  detail: string;
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export class DeviceIdentity {
  private constructor(
    private readonly cortexDir: string,
    private readonly dataKey: Uint8Array,
    readonly deviceId: string,
    readonly signPublicKey: Uint8Array,
    readonly signSecretKey: Uint8Array,
    private nextSeqValue: number,
    private readonly pinned: Map<string, Uint8Array>,
    /** Pubkey-change alerts found while reconciling the synced registry. */
    readonly peerKeyAlerts: PeerKeyAlert[],
  ) {}

  /** The starting seq for a fresh OpLogWriter (the persisted high-water). */
  get initialSeq(): number { return this.nextSeqValue; }

  /** Pinned public key for a device, or undefined if we've never trusted it. */
  getPubKey(deviceId: string): Uint8Array | undefined {
    return this.pinned.get(deviceId);
  }

  /** Persist the advanced seq so it survives restarts and never rewinds. */
  persistSeq = async (next: number): Promise<void> => {
    if (next <= this.nextSeqValue) return;
    this.nextSeqValue = next;
    await this.write();
  };

  private deviceFilePath(): string { return path.join(this.cortexDir, DEVICE_FILE); }

  private async write(): Promise<void> {
    const secretEnc = b64(await crypto.encrypt(this.signSecretKey, this.dataKey, randomBytes(16)));
    const pinnedObj: Record<string, string> = {};
    for (const [id, pk] of this.pinned) pinnedObj[id] = b64(pk);
    const pinnedEnc = b64(await crypto.encrypt(
      new TextEncoder().encode(JSON.stringify(pinnedObj)), this.dataKey, randomBytes(16),
    ));
    const data: DeviceFileV2 = {
      v: 2,
      deviceId: this.deviceId,
      signPublicKey: b64(this.signPublicKey),
      secretEnc,
      nextSeq: this.nextSeqValue,
      pinnedEnc,
    };
    const tmp = `${this.deviceFilePath()}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(tmp, this.deviceFilePath());
  }

  /** Announce our own pubkey in the synced registry so peers can discover it. */
  private async announce(): Promise<void> {
    const p = path.join(this.cortexDir, REGISTRY_FILE);
    let reg: Registry = {};
    try { reg = JSON.parse(await fs.readFile(p, 'utf8')) as Registry; } catch { /* fresh */ }
    const mine = reg[this.deviceId];
    if (!mine || mine.pubKey !== b64(this.signPublicKey)) {
      reg[this.deviceId] = { pubKey: b64(this.signPublicKey), firstSeenAt: mine?.firstSeenAt ?? Date.now() };
      const tmp = `${p}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(reg), { mode: 0o600 });
      await fs.rename(tmp, p);
    }
  }

  /** TOFU-reconcile the synced registry into our encrypted pinned set. New
   *  devices are pinned; a changed key for a pinned device is alerted and the
   *  original pin kept. Returns whether anything changed (→ persisted). */
  private async reconcile(): Promise<boolean> {
    const p = path.join(this.cortexDir, REGISTRY_FILE);
    let reg: Registry = {};
    try { reg = JSON.parse(await fs.readFile(p, 'utf8')) as Registry; } catch { return false; }
    let changed = false;
    for (const [id, entry] of Object.entries(reg)) {
      if (!entry?.pubKey) continue;
      const announced = unb64(entry.pubKey);
      const existing = this.pinned.get(id);
      if (!existing) {
        this.pinned.set(id, announced); // TOFU pin on first contact
        changed = true;
      } else if (b64(existing) !== entry.pubKey) {
        this.peerKeyAlerts.push({ deviceId: id,
          detail: `announced public key for device ${id} differs from the pinned key — possible tampering; keeping the pinned key.` });
      }
    }
    return changed;
  }

  static async loadOrCreate(cortexDir: string, dataKey: Uint8Array): Promise<DeviceIdentity> {
    const filePath = path.join(cortexDir, DEVICE_FILE);
    let identity: DeviceIdentity;

    let parsed: DeviceFileV2 | null = null;
    try { parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as DeviceFileV2; } catch { /* create */ }

    if (parsed && parsed.v === 2 && parsed.deviceId && parsed.secretEnc) {
      const signSecretKey = await crypto.decrypt(unb64(parsed.secretEnc), dataKey);
      const pinned = new Map<string, Uint8Array>();
      if (parsed.pinnedEnc) {
        try {
          const obj = JSON.parse(new TextDecoder().decode(await crypto.decrypt(unb64(parsed.pinnedEnc), dataKey))) as Record<string, string>;
          for (const [id, pk] of Object.entries(obj)) pinned.set(id, unb64(pk));
        } catch { /* corrupt pinned set → rebuild via TOFU */ }
      }
      identity = new DeviceIdentity(
        cortexDir, dataKey, parsed.deviceId,
        unb64(parsed.signPublicKey), signSecretKey,
        typeof parsed.nextSeq === 'number' ? parsed.nextSeq : 0,
        pinned, [],
      );
    } else {
      const kp = await crypto.generateSigningKeyPair();
      const deviceId = randomBytes(16).toString('hex');
      identity = new DeviceIdentity(
        cortexDir, dataKey, deviceId, kp.publicKey, kp.secretKey, 0, new Map(), [],
      );
      // Pin self so our own events verify locally.
      identity.pinned.set(deviceId, kp.publicKey);
      await identity.write();
    }

    // Ensure self is pinned (covers upgrades from a pinned-less device.json).
    if (!identity.pinned.has(identity.deviceId)) {
      identity.pinned.set(identity.deviceId, identity.signPublicKey);
    }
    await identity.announce();
    const changed = await identity.reconcile();
    if (changed) await identity.write();
    return identity;
  }
}
