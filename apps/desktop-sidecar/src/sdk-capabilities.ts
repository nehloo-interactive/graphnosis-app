//! Which OPTIONAL SDK features the linked `@nehloo/graphnosis` actually has.
//! One explicit, propagating answer per feature, derived from PACKAGE IDENTITY.
//!
//! THE DEFECT THIS EXISTS TO CLOSE
//! ------------------------------
//! App 1.31.0 ships on `@nehloo/graphnosis: ^0.7.4`. On a 0.x version a caret
//! range pins the MINOR, so `^0.7.4` means `>=0.7.4 <0.8.0` — 0.8.0 can never
//! satisfy it. `QueryOptions.blockedEvidencePrefixes` was introduced in 0.8.0
//! (0.7.4's `QueryOptions` has 9 fields; 0.8.0 adds `now`, `recordAccess` and
//! `blockedEvidencePrefixes` on top). So on the shipping pin that option DOES
//! NOT EXIST.
//!
//! It does not throw either. `query()` / `queryHybrid()` take a plain options
//! object and read the keys they know; an unknown key is simply never read.
//! Passing `blockedEvidencePrefixes` to 0.7.4 is a silent no-op — no error, no
//! warning, no behavioural difference the caller can observe. A guard that is
//! present in the source, absent in effect, and quiet about it is exactly the
//! defect class `semantic-availability.ts` and `mcp/handlers-audit.ts` exist to
//! close, one layer down.
//!
//! WHY DECLARED VERSION, NOT A RUNTIME PROBE
//! -----------------------------------------
//! Every probe of the form "call it and see" answers WRONG here, for the same
//! reason `handlers-audit.ts` refuses to set `keywordFallback` from a score:
//!
//!   - try/catch — 0.7.4 does not throw on the unknown key, so the catch never
//!     runs and the probe reports SUPPORTED.
//!   - compare results with and against the option — on 0.7.4 both calls are
//!     byte-identical, which is also what a 0.8.0 query with NO skill overlap
//!     returns (b19859f1 measured exactly that). "Same answer" cannot
//!     distinguish "feature absent" from "feature present and not triggered".
//!   - `'blockedEvidencePrefixes' in opts` — `QueryOptions` is a TypeScript
//!     interface. It is erased at compile time. There is no runtime object to
//!     interrogate.
//!
//! What CAN answer is who the callee is. The version in the resolved package's
//! own `package.json` is the SDK's own statement of which API surface it
//! implements, and it is read from the ACTUAL linked copy — not from our
//! manifest range — so a split pin, a hoist, or a `pnpm.overrides` entry is
//! reported as what it really resolved to.
//!
//! WHICH WAY THIS FAILS
//! --------------------
//! Unreadable or unparseable version -> UNAVAILABLE. An absent provenance is
//! not a claim that a feature exists; treating it as one is the defect above.
//! The cost of the conservative direction is bounded and loud: recall loses the
//! skill-chain bound (see `RECALL_BLOCKED_EVIDENCE` in `graphnosis-impl.ts`)
//! and `main.ts` says so at boot. The cost of the optimistic direction is
//! silence, which is the thing being fixed.
//!
//! WHEN THE PIN MOVES BACK
//! -----------------------
//! Nothing here needs editing. Bump the manifest to `^0.8.0` or later and the
//! resolved version answers `true`, the option is passed again, and the boot
//! line flips from the UNAVAILABLE warning to the available note. The guard is
//! dormant, not deleted.

import { createRequire } from 'node:module';

/**
 * First SDK version whose `QueryOptions` / `HybridQueryOptions` carry
 * `blockedEvidencePrefixes`. Verified against the shipped type declarations of
 * both versions in the store: `core/query/query-engine.d.ts` at 0.7.4 has no
 * such field; at 0.8.0 it is the third member of `QueryOptions`.
 */
export const EVIDENCE_PREFIX_BLOCKING_MIN_SDK = '0.8.0';

/** `1.2.3`, `1.2.3-rc.1`, `1.2.3+build` -> `[1, 2, 3]`. Null when not semver. */
function parseSemverCore(version: string): [number, number, number] | null {
  const core = version.trim().split(/[-+]/, 1)[0] ?? '';
  const parts = core.split('.');
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^[0-9]+$/.test(p) ? Number(p) : Number.NaN));
  if (nums.some((n) => !Number.isInteger(n))) return null;
  return [nums[0]!, nums[1]!, nums[2]!];
}

/** True when `version` is >= `floor`. Both must be well-formed semver. */
function atLeast(version: string, floor: string): boolean {
  const a = parseSemverCore(version);
  const b = parseSemverCore(floor);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

let cachedSdkVersion: string | null | undefined;

/**
 * The `version` field of the `@nehloo/graphnosis` copy this process actually
 * loaded, or null when it cannot be read.
 *
 * Two resolution strategies, because the subpath is only reachable when the SDK
 * exports it:
 *   1. `@nehloo/graphnosis/package.json` — 0.7.4 lists it in `exports`.
 *   2. resolve the package MAIN entry and walk up to the nearest package.json —
 *      works whether or not the subpath is exported.
 * Strategy 2 exists so a future release that drops the subpath export degrades
 * to a correct answer rather than to `null`.
 */
export function resolveSdkVersion(): string | null {
  if (cachedSdkVersion !== undefined) return cachedSdkVersion;
  const req = createRequire(import.meta.url);
  const read = (id: string): string | null => {
    try {
      const v = (req(id) as { version?: unknown }).version;
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
    } catch {
      return null;
    }
  };
  let v = read('@nehloo/graphnosis/package.json');
  if (v === null) {
    try {
      // dist/sdk/index.js -> …/@nehloo/graphnosis/package.json
      const main = req.resolve('@nehloo/graphnosis');
      const marker = `${'@nehloo'}/graphnosis/`;
      const at = main.lastIndexOf(marker);
      if (at >= 0) v = read(`${main.slice(0, at + marker.length)}package.json`);
    } catch {
      v = null;
    }
  }
  cachedSdkVersion = v;
  return v;
}

/** For tests: forget the memoised version so a stubbed resolver is re-read. */
export function resetSdkVersionCache(): void {
  cachedSdkVersion = undefined;
}

/**
 * THE capability state for `QueryOptions.blockedEvidencePrefixes`. `false`
 * means: passing the option would be a silent no-op, so this process does not
 * pass it and says so instead.
 */
export function evidencePrefixBlockingAvailable(): boolean {
  return sdkVersionSupportsEvidencePrefixBlocking(resolveSdkVersion());
}

/**
 * The DECISION, separated from the RESOLUTION so both halves can be exercised.
 *
 * `evidencePrefixBlockingAvailable()` can only ever be observed in the `false`
 * branch on the shipping pin — `^0.7.4` cannot resolve to 0.8.0 — so the
 * `true` branch would otherwise be untestable, and an untested branch is how a
 * gate that never re-enables gets shipped. Call this directly with a literal
 * version to control both directions.
 */
export function sdkVersionSupportsEvidencePrefixBlocking(version: string | null): boolean {
  return version !== null && atLeast(version, EVIDENCE_PREFIX_BLOCKING_MIN_SDK);
}

/** One-line explanation for logs and operator-facing copy. */
export function evidencePrefixBlockingUnavailableReason(): string {
  const v = resolveSdkVersion();
  if (v === null) {
    return `the linked @nehloo/graphnosis version could not be read, so no version can be shown to implement blockedEvidencePrefixes (added in ${EVIDENCE_PREFIX_BLOCKING_MIN_SDK})`;
  }
  return `the linked @nehloo/graphnosis is ${v}, which predates blockedEvidencePrefixes (added in ${EVIDENCE_PREFIX_BLOCKING_MIN_SDK}); the option is not read by this SDK and passing it would change nothing`;
}

/**
 * The evidence-prefix option, or NOTHING, spread into an SDK query options
 * literal at the call site:
 *
 *   h.instance.query(q, { maxNodes: k, ...evidencePrefixOption(PREFIXES) })
 *
 * The return type is deliberately `object`. On the shipping 0.7.4 pin the
 * field is not in `QueryOptions`, so naming it in the return type would put
 * back the same 8 x TS2353 this replaces; and a spread of `object` contributes
 * no properties to the literal's type, which is precisely the honest statement
 * that whether the key is there is a RUNTIME fact about the linked SDK, not a
 * compile-time one. The single unavoidable cast lives here, once, rather than
 * at eight call sites.
 */
export function evidencePrefixOption(prefixes: readonly string[]): object {
  if (!evidencePrefixBlockingAvailable()) return {};
  return { blockedEvidencePrefixes: [...prefixes] };
}
