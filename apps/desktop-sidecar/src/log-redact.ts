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

// ── Debug-only logger ────────────────────────────────────────────────────────
//
// `dbg()` is a no-op in production. It writes to stderr only when one of these
// is true at process start:
//   - `GRAPHNOSIS_DEBUG=1` env var is set
//   - `NODE_ENV !== 'production'` (covers `npm run dev` / `pnpm dev`)
//
// Use it for verbose per-operation diagnostics that are useful when actively
// debugging but pure noise in production logs — per-ingest auto-relink stats,
// per-insert chunker decisions, per-sweep oplog summaries, cross-engram prune
// counts, etc. Real errors should keep using `console.error` so they always
// surface; `dbg()` is strictly for the chatty informational lines.

const DEBUG_ENABLED = process.env['GRAPHNOSIS_DEBUG'] === '1'
  || process.env['NODE_ENV'] !== 'production';

export function dbg(message: string, ...rest: unknown[]): void {
  if (!DEBUG_ENABLED) return;
  if (rest.length > 0) console.error(message, ...rest);
  else                  console.error(message);
}

/** True when debug logging is active. Use to gate expensive-to-compute log
 *  payloads (e.g. JSON.stringify of large objects) so they don't run at all
 *  in production. */
export function isDebug(): boolean {
  return DEBUG_ENABLED;
}
