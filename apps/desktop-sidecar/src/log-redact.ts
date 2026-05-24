//! Tiny privacy helper for sidecar logging.
//!
//! Engram slugs ("home-automation", "client-acme", "health-bloodwork") and
//! source ids are sensitive — they leak topical information about the user
//! the moment they hit a console.error line, because that line travels to:
//!   - dev terminals (visible over shoulder, in screen shares, in screenshots),
//!   - the parent Tauri process's stderr buffer (which can land in crash
//!     reports),
//!   - any log-aggregation tooling the user has hooked into the OS log stream.
//!
//! Internal logs use `redactId()` to produce a short stable token that's
//! useful for cross-referencing related log lines without identifying the
//! engram. Same id → same token across calls (so you can grep a single
//! request's trail), different id → different token, no way to recover the
//! original from the token alone.
//!
//! Cheap, intentionally non-cryptographic (FNV-1a, 32-bit). The point is
//! privacy hygiene in OUR logs, not authentication.

const ZERO_HASH = '00000000';

/**
 * Redact an id (engram slug, source id, node id) into a short stable token
 * suitable for console logs. Pass-through for empty / null / undefined.
 */
export function redactId(id: string | null | undefined): string {
  if (!id) return ZERO_HASH;
  // FNV-1a 32-bit. Compact and stable across runs.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Convenience for the very common pattern `${graphId}/${nodeId}` or
 * `${graphId}/${sourceId}` — produces `<hash>/<hash>` without exposing
 * either side.
 */
export function redactPair(a: string | null | undefined, b: string | null | undefined): string {
  return `${redactId(a)}/${redactId(b)}`;
}
