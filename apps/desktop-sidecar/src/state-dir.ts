/**
 * The machine-local Graphnosis STATE directory — one resolver, used by every
 * module that keeps per-machine state outside the encrypted cortex.
 *
 * WHAT LIVES HERE: license seed cache, catalog subscriptions + install state,
 * remote-MCP bearer credentials, and (for the launcher) the HTTP-UI token,
 * the passphrase file and server.log. None of it is cortex data; all of it is
 * "this machine, this install".
 *
 * WHY THIS MODULE EXISTS: `deploy/launcher/graphnosis-server.sh` already honors
 * `GRAPHNOSIS_STATE` and `deploy/launcher/README.md` advertises it as a
 * supported knob, but the sidecar never read it — three modules each hardcoded
 * `~/.graphnosis` at module scope. A server deployed with
 * `GRAPHNOSIS_STATE=/opt/graphnosis` got its cortex there while its license
 * seed, subscriptions and MCP credentials still landed in `$HOME/.graphnosis`,
 * and two instances under different state dirs silently shared — and
 * cross-contaminated — one `catalog-subscriptions.json`. Three independent
 * copies of the same resolution is how they drifted apart; this is the one
 * copy.
 *
 * RESOLVED PER CALL, NEVER MEMOIZED. A module-scope `const` freezes the answer
 * at import; a lazily-cached getter freezes it at first use. Both reproduce the
 * original defect with a different shape — a caller that changes
 * `process.env.GRAPHNOSIS_STATE` (a test, a re-exec, an embedder driving two
 * roots in one process) would still be writing to the first root it ever saw.
 * `process.env` reads are a plain object lookup; there is nothing to cache.
 *
 * DEFAULT IS UNCHANGED, BYTE FOR BYTE. With `GRAPHNOSIS_STATE` unset the
 * fallback is exactly the expression the three modules used before — an
 * upgrading user finds their existing files where they left them.
 *
 * NOTE — `mcp-relay.ts` CANNOT import this module. Its compiled
 * `dist/mcp-relay.js` is copied VERBATIM, as a single file with no
 * dependencies, into the `@graphnosis/mcp-relay` npm package
 * (packages/graphnosis-mcp-relay/scripts/build.mjs:34-36), so any sibling
 * import would publish an unresolvable module. It carries an inline copy of
 * `stateDir()` that must be kept in step with this one; the copy is marked at
 * its definition site.
 */

import os from 'node:os';
import path from 'node:path';

/**
 * Absolute path of the machine-local state directory.
 *
 * `GRAPHNOSIS_STATE` when it is set to something other than whitespace,
 * otherwise `~/.graphnosis`.
 *
 * - An override is `path.resolve`d, so the returned string is always absolute:
 *   a RELATIVE `GRAPHNOSIS_STATE` is anchored to the process CWD at the moment
 *   of the call (same as the shell launcher, which passes the value through to
 *   `mkdir -p` unresolved). Relative values are accepted but not recommended —
 *   a process that chdir's would move its own state.
 * - Unset, empty, or whitespace-only all fall back. The shell's `${VAR:-…}`
 *   only falls back on unset-or-empty; whitespace-only is treated as empty here
 *   too, because a state dir literally named " " is a typo every time.
 * - The fallback branch is deliberately NOT run through `path.resolve` — it is
 *   character-for-character the expression the three call sites used before, so
 *   the default cannot drift.
 */
export function stateDir(): string {
  const override = process.env.GRAPHNOSIS_STATE;
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), '.graphnosis');
}

/** `path.join(stateDir(), …segments)`. Resolved per call, like `stateDir()`. */
export function stateFile(...segments: string[]): string {
  return path.join(stateDir(), ...segments);
}
