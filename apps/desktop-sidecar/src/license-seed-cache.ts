/**
 * Device-level license SEED CACHE — machine-local, NOT in the encrypted cortex.
 *
 * Path: $GRAPHNOSIS_STATE/license-seed.json, default ~/.graphnosis/…  (0600)
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The authoritative license token lives in each cortex's `settings.licenseEnc`,
 * encrypted with THAT CORTEX'S DATA KEY (host.setLicenseToken). That is what
 * makes feature checks offline-first and per-cortex — but it also means the
 * token cannot be copied byte-wise from one cortex to another: a fresh cortex
 * has a fresh data key and could never decrypt another cortex's `licenseEnc`.
 *
 * So a paying subscriber who creates a second cortex starts with no license and
 * no way to carry one across without re-running an activation flow.
 *
 * This cache closes that gap. It holds the token in a form readable WITHOUT any
 * cortex key, so a newly created cortex can be seeded from it.
 *
 * ── Hard invariants (do not relax) ──────────────────────────────────────────
 *  1. THIS IS A SEED / RESTORE CACHE ONLY. It is NEVER consulted during a
 *     feature check. `LicenseValidator.hasFeature` is always fed the token that
 *     came out of THAT cortex's own `licenseEnc` (host.getLicenseToken).
 *     Entitlement must not become a device-global property, and no feature
 *     check may ever depend on a file outside the cortex.
 *  2. NO NETWORK. Reading or writing this file never talks to a server.
 *     Offline-first is the product thesis; seeding must not regress it.
 *  3. WRITE-THROUGH ONLY FROM THE PRIMARY SLOT. Only tokens that are persisted
 *     into `settings.licenseEnc` (the personal slot) are mirrored here. The
 *     domain-seat token (`settings.domainSeatLicenseToken`) is a per-seat
 *     grant and is deliberately NOT cached — seeding a domain seat into a new
 *     cortex's personal slot would misattribute the entitlement.
 *  4. NEVER install an expired token from this cache. See `readLicenseSeed`
 *     callers: the seed path verifies signature AND expiry before install.
 *
 * ── Storage form ────────────────────────────────────────────────────────────
 * The token is stored as-is (it is an Ed25519-signed, self-describing string —
 * exactly the bytes the signing service issued). It cannot be encrypted with a
 * cortex key, because being readable without a cortex key is the entire point.
 *
 * The file is 0600, in the user's own home directory. This is the SAME posture
 * the Tauri side already accepts for a strictly more sensitive secret: the
 * cortex passphrase Touch-ID cache falls back to a 0600 file under
 * `~/Library/Application Support/Graphnosis/touchid-cache/` on builds without
 * the `keychain` cargo feature (apps/desktop/src-tauri/src/keychain.rs:23-27).
 * A license token is proof of subscription, not a key to any data: worst case
 * on a compromised user account is that the attacker learns the subscriber's
 * email and plan — data they already have, since they are inside the account.
 *
 * NOTE ON THE OS KEYCHAIN: the app does own a keychain module, but it is Rust
 * (apps/desktop/src-tauri/src/keychain.rs), compiled into the Tauri process,
 * and on macOS only under `--features keychain`. Every license-token persist
 * path is here in the Node sidecar, which has no channel to call back into
 * Tauri (the IPC runs Tauri → sidecar only). Routing through it would need new
 * Tauri commands plus a reverse RPC that does not exist today.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { stateFile } from './state-dir.js';

/** Machine-local Graphnosis state dir — `$GRAPHNOSIS_STATE`, default
 *  `~/.graphnosis`. Resolved PER CALL by the one shared resolver in
 *  state-dir.ts; same convention as catalog-subscriptions.ts and the inline
 *  copy in mcp-relay.ts (which cannot import — see its packaging invariant). */
const storeFile = (): string => stateFile('license-seed.json');

interface LicenseSeedFileV1 {
  v: 1;
  /** The raw Ed25519-signed license token, exactly as issued. */
  token: string;
  /** When this cache entry was last written (ms since epoch). Diagnostics only —
   *  never used to decide validity. Expiry comes from the token's own `exp`. */
  updatedAt: number;
}

/** Absolute path of the seed cache. Exported for diagnostics and tests. */
export function licenseSeedPath(): string {
  return storeFile();
}

/**
 * Read the cached token, or `null` when there is no cache / it is unreadable.
 *
 * Returns the raw token WITHOUT validating it. Callers MUST verify it
 * (signature + expiry) before installing it anywhere — see the seed-on-create
 * path in host.ts, which refuses to install anything `verifyToken` rejects.
 *
 * Never throws.
 */
export async function readLicenseSeed(): Promise<string | null> {
  try {
    const raw = await fs.readFile(storeFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LicenseSeedFileV1>;
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    return token.length > 0 ? token : null;
  } catch {
    // Absent, unreadable, or corrupt JSON — all mean "no seed available".
    return null;
  }
}

/**
 * Mirror `token` into the device cache (write-through).
 *
 * Called immediately after a token is persisted into a cortex's primary slot,
 * so the newest token this device has seen is always the one a future cortex
 * would be seeded from.
 *
 * Best-effort by design: a failure here must NEVER fail the activation that
 * triggered it. The cortex-side persist has already succeeded and is the
 * authoritative copy; the cache is a convenience. Returns whether it landed.
 */
export async function writeLicenseSeed(token: string): Promise<boolean> {
  const trimmed = token.trim();
  if (!trimmed) return false;
  // Resolve ONCE for this write. Per-call resolution is the point, but tmp and
  // target must be the same directory or the rename below would cross state
  // roots (and devices) if the env changed mid-write. One resolution per
  // invocation — not one per process.
  const file = storeFile();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const data: LicenseSeedFileV1 = { v: 1, token: trimmed, updatedAt: Date.now() };
    // Write 0600 from the start (mode on the tmp file), then rename, so the
    // token is never briefly world-readable.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    // writeFile's `mode` only applies when it CREATES the file; chmod anyway so
    // a pre-existing tmp with looser bits cannot widen it.
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, file);
    return true;
  } catch (e) {
    console.error('[license-seed] could not write device seed cache:', (e as Error).message);
    return false;
  }
}

/**
 * Delete the device cache. Called from `license:clear` so that "Reset
 * verification" is a real device-level reset — otherwise a cleared license
 * would silently reappear on the next cortex the user created, which is
 * exactly the surprise the reset button exists to prevent.
 *
 * Never throws; a missing file is success.
 */
export async function clearLicenseSeed(): Promise<void> {
  try {
    await fs.unlink(storeFile());
  } catch {
    /* already absent — that is the desired end state */
  }
}
