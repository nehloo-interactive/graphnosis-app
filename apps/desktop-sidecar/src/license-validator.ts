/**
 * LicenseValidator — Ed25519-signed license token verification for Graphnosis.
 *
 * License tokens are issued by the Nehloo signing service (a server-side backend
 * that holds the private key). The validator holds ONLY the public key, hardcoded
 * at build time, and verifies signatures locally. No token can be forged without the
 * private key; reading or modifying this source file does not help an attacker.
 *
 * Token wire format:
 *   <base64url(UTF-8 JSON payload)>.<base64url(64-byte Ed25519 signature)>
 *
 * Payload shape (JSON):
 *   { sub: string, plan: string, features: string[], iat: number, exp: number }
 *   - sub:      user identifier (email or UUID)
 *   - plan:     subscription plan slug, e.g. "monthly-subscription"
 *   - features: feature keys this token unlocks, e.g. ["skill-training"]
 *   - iat:      issued-at (Unix seconds)
 *   - exp:      expiry (Unix seconds)
 *
 * The Ed25519 signature covers the raw UTF-8 bytes of the JSON payload (the bytes
 * that base64url(payload) encodes — not the base64url string itself).
 *
 * Security note: the public key is visible in this open FSL source. That is
 * intentional and by design — Ed25519 security does not depend on public-key
 * secrecy. Forging a token requires the private key, which lives only on the
 * Nehloo signing service and is never committed to any repo. The residual
 * patching risk (fork + bypass validation logic) is mitigated by Tauri code
 * signing on the shipped binary and FSL license terms.
 */

import sodium from 'libsodium-wrappers-sumo';

// ── Ed25519 signing public key ────────────────────────────────────────────────
//
// This constant is the Nehloo license-signing public key (32 raw bytes).
// The matching private key lives ONLY on the Nehloo signing service backend
// and is never stored in or referenced from this repository.
//
// ⚠️  PLACEHOLDER — swap in the real production public key before deploying
//     the signing service. Until then, all token verification calls will
//     return null (no features unlocked), which is the correct behaviour for
//     a pre-production build.
//
// How to generate a real keypair (one-time setup, keep the private key secret):
//   node --input-type=module << 'EOF'
//     import sodium from 'libsodium-wrappers-sumo';
//     await sodium.ready;
//     const kp = sodium.crypto_sign_keypair();
//     console.log('Public key (hex):', Buffer.from(kp.publicKey).toString('hex'));
//     console.log('Secret key (hex):', Buffer.from(kp.privateKey).toString('hex'));
//   EOF
//
// Paste the public key bytes here (32 bytes, big-endian hex octets).
// Store the secret key securely in your signing service; never commit it.
const SIGNING_PUBLIC_KEY = new Uint8Array([
  0xe6, 0x59, 0xe0, 0x5c, 0x6c, 0x01, 0x9a, 0x90,
  0xf5, 0x15, 0xc8, 0x2f, 0x05, 0x56, 0xf2, 0x3f,
  0xf6, 0xee, 0x7c, 0x82, 0x34, 0xfe, 0x95, 0xe4,
  0x1e, 0x5e, 0x1b, 0x55, 0x73, 0xf0, 0x38, 0x11,
]); // 32 bytes — production Ed25519 public key

// ── Public types ──────────────────────────────────────────────────────────────

export interface LicensePayload {
  /** User identifier (email or UUID). */
  sub: string;
  /** Subscription plan slug, e.g. "monthly-subscription". */
  plan: string;
  /** Feature keys this token unlocks. */
  features: string[];
  /** Issued-at, Unix seconds. */
  iat: number;
  /** Expiry, Unix seconds. */
  exp: number;
  /** True/absent when the subscription auto-renews at `exp`; false when it's
   *  set to cancel at period end. Drives the "Renews" vs "Expires" label.
   *  Optional for backward-compat with tokens minted before this field. */
  renews?: boolean;
}

/**
 * Gated feature keys. A token must list the feature by this exact string to
 * grant access. Add entries here as new gated features ship.
 */
/**
 * Gated feature keys. A token must list the feature by this exact string to
 * grant access. Today the Nehloo signing service mints both keys together
 * for any Pro subscriber, so users don't see different tiers — but keeping
 * the keys distinct in the validator lets us deploy a "GNN-only" or
 * "Skill-only" plan without changing client code.
 *
 *   skill-training       — full Autonomous Praxis pipeline + .gsk export
 *   gnn-exploration      — Graphnosis Neural Network: MCP `gnn_neighbors`,
 *                          MemoryStudio chip, autonomous edge-prediction loop
 */
export type LicenseFeature = 'skill-training' | 'gnn-exploration';

// ── LicenseValidator ──────────────────────────────────────────────────────────

/**
 * Verifies Ed25519-signed license tokens. Must be initialised via `create()`
 * before first use — `create()` awaits the libsodium WASM boot (one-time cost,
 * typically < 5 ms on first call). All subsequent `verifyToken` / `hasFeature`
 * calls are synchronous and allocation-minimal.
 *
 * Thread-safety note: libsodium-wrappers-sumo is single-threaded by design;
 * safe to share one `LicenseValidator` instance across all MCP handlers.
 */
export class LicenseValidator {
  // Private constructor — callers must use LicenseValidator.create().
  private constructor() {}

  /**
   * Initialise the validator. Awaits libsodium WASM boot (one-time cost,
   * shared across all callers). Safe to call concurrently — all callers
   * share the same WASM instance.
   */
  static async create(): Promise<LicenseValidator> {
    await sodium.ready;
    return new LicenseValidator();
  }

  /**
   * Verify a license token. Returns the decoded `LicensePayload` on success,
   * or `null` when the token is:
   *   - missing or malformed
   *   - carrying an invalid Ed25519 signature
   *   - expired (exp < current Unix time)
   *
   * Never throws — all errors are caught and surfaced as `null`.
   */
  verifyToken(token: string): LicensePayload | null {
    try {
      // Format: <base64url(json)>.<base64url(signature)>
      const dotIdx = token.lastIndexOf('.');
      if (dotIdx === -1 || dotIdx === 0 || dotIdx === token.length - 1) return null;

      const payloadB64 = token.slice(0, dotIdx);
      const sigB64     = token.slice(dotIdx + 1);

      const payloadBytes = base64urlToBytes(payloadB64);
      const sig          = base64urlToBytes(sigB64);

      // Ed25519 signatures are exactly 64 bytes.
      if (sig.length !== sodium.crypto_sign_BYTES) return null;

      // Verify the signature over the raw JSON bytes.
      const valid = sodium.crypto_sign_verify_detached(sig, payloadBytes, SIGNING_PUBLIC_KEY);
      if (!valid) return null;

      const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as LicensePayload;

      // Reject expired tokens. exp is Unix seconds; Date.now() is milliseconds.
      if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;

      // Sanity-check required fields.
      if (!Array.isArray(payload.features)) return null;

      return payload;
    } catch {
      // Malformed base64, invalid JSON, unexpected sodium error, etc.
      return null;
    }
  }

  /**
   * Returns `true` if `token` is a valid, unexpired license token that includes
   * `feature` in its `features` array.
   *
   * Null / undefined tokens always return `false` — callers do not need to
   * guard against missing tokens before calling this method.
   */
  hasFeature(token: string | null | undefined, feature: LicenseFeature): boolean {
    if (!token) return false;
    const payload = this.verifyToken(token);
    if (!payload) return false;
    return payload.features.includes(feature);
  }

  /**
   * Returns true if the token is valid and will expire within `withinMs` milliseconds.
   * Used to surface a renewal reminder banner on startup.
   */
  isExpiringSoon(token: string | null | undefined, withinMs = 14 * 24 * 60 * 60 * 1000): boolean {
    if (!token) return false;
    const payload = this.verifyToken(token);
    if (!payload) return false;
    const expiresAt = payload.exp * 1000;
    return expiresAt - Date.now() < withinMs;
  }

  /**
   * Verify the Ed25519 signature on an official GSK pack payload.
   * Delegates to the gsk-format module which uses the same libsodium instance.
   * Returns true for a valid official pack signature.
   * Returns false for community packs (empty signature field — not an error).
   * Throws if a non-empty signature is present but invalid.
   */
  async verifyGskSignature(payload: import('./gsk-format.js').GskPayload): Promise<boolean> {
    const { verifyGskSignature } = await import('./gsk-format.js');
    return verifyGskSignature(payload);
  }
}

// ── Base64url codec ───────────────────────────────────────────────────────────

/** Decode a base64url string to a Uint8Array (no padding required). */
function base64urlToBytes(s: string): Uint8Array {
  // Base64url uses - and _ in place of + and /
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  // Re-add = padding to reach a multiple of 4
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}
