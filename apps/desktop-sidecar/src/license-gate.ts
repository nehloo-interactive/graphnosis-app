/**
 * license-gate — ONE truthful refusal message for every feature gate.
 *
 * Why this module exists
 * ----------------------
 * Every paid-feature gate in the sidecar used to hand-roll its own refusal
 * string, and every one of those strings said the same thing regardless of
 * cause: "requires a Graphnosis Pro subscription. Subscribe at …".
 *
 * That string is a LIE in the most common failure mode. A paying subscriber
 * whose token simply does not carry one particular feature key (because the
 * signing service minted it without that key) was told to go and subscribe —
 * to a subscription they already pay for. It is also a lie on a freshly
 * created cortex (the token exists on the account, just not on THIS cortex's
 * encrypted settings) and on an expired token (nothing to "subscribe" to —
 * the fix is a renewal, and the user deserves the date).
 *
 * `checkFeatureGate` states FACTS about the token in front of it and stops
 * there. It never diagnoses intent, never assumes the caller is a freeloader,
 * and — critically — never emits the word "Subscribe" to the holder of a
 * valid token.
 *
 * Four distinguishable states
 * ---------------------------
 *   'no_token'         nothing is stored on this cortex
 *   'expired'          a token is stored and its own `exp` is in the past
 *   'invalid'          a token is stored but does not verify (malformed, or
 *                      not signed by the Graphnosis license key)
 *   'feature_missing'  the token is valid and unexpired — it simply does not
 *                      list the required feature. THIS is the case that was
 *                      mislabelled, and the only one where we can name what
 *                      the license actually grants.
 *
 * Decision safety
 * ---------------
 * This module NEVER decides access. `checkFeatureGate` returns `null` under
 * exactly the condition `LicenseValidator.hasFeature(token, feature)` returns
 * `true`, and a denial object under exactly the condition it returns `false`
 * (including the `validator == null` case, which every call site already
 * treated as unlicensed via `?? false`). Call sites keep their own control
 * flow and their own response shapes; only the message text changes.
 *
 * The expired/invalid split reads the payload segment WITHOUT verifying the
 * signature. That is safe because it is used for WORDING ONLY — the access
 * decision has already been made (deny) by the time we look. An attacker who
 * forges an expired-looking token gains nothing but a different sentence.
 */

import type { LicenseValidator, LicenseFeature, LicensePayload } from './license-validator.js';

/** Where a user restores a token that exists on the account but not on this cortex. */
const RECHECK_HINT =
  'Open Graphnosis → Settings → License and use "Re-check subscription" to pull the current token onto this cortex.';

/** Only ever shown when there is NO token at all — never to a token holder. */
const NO_SUBSCRIPTION_HINT =
  'If there is no subscription on this account yet, plans are at https://graphnosis.com/upgrade.';

export type LicenseGateReason = 'no_token' | 'expired' | 'invalid' | 'feature_missing';

export interface LicenseGateDenial {
  /** Which of the four states produced the refusal. */
  reason: LicenseGateReason;
  /** The truthful, user-facing refusal text. */
  message: string;
  /** Feature keys the stored token actually grants. Empty unless `reason === 'feature_missing'`. */
  grantedFeatures: string[];
  /** The feature key the gated operation needs. */
  requiredFeature: LicenseFeature;
  /** Expiry as an ISO date (YYYY-MM-DD) — present only when `reason === 'expired'`. */
  expiredOn?: string;
}

export interface LicenseGateOptions {
  /**
   * What the caller tried to do, phrased as a subject: "train_skill",
   * "GSK skill-pack export", "Point-in-time recall". Used verbatim at the
   * head of the sentence.
   */
  subject: string;
  /**
   * Tool-specific guidance that is TRUE regardless of license state — e.g.
   * "Contradictions can still be reviewed and resolved in the Graphnosis app's
   * Memory Integrity Workbench." Appended after the cause, never instead of it.
   */
  guidance?: string;
}

/**
 * Decode the payload segment of a token WITHOUT verifying its signature.
 * Wording-only helper — see the decision-safety note in the module header.
 */
function decodeUnverifiedPayload(token: string): Partial<LicensePayload> | null {
  try {
    const dotIdx = token.lastIndexOf('.');
    if (dotIdx <= 0) return null;
    const b64 = token.slice(0, dotIdx).replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Partial<LicensePayload>;
  } catch {
    return null;
  }
}

/** "skill-training, foresight" — or "no features" for a featureless token. */
function formatFeatureList(features: string[]): string {
  return features.length ? features.join(', ') : 'no features';
}

/**
 * Gate check for a single required feature.
 *
 * @returns `null` when access is ALLOWED (identical condition to
 *          `validator.hasFeature(token, feature) === true`), otherwise a
 *          `LicenseGateDenial` whose `.message` states the real cause.
 */
export function checkFeatureGate(
  token: string | null | undefined,
  feature: LicenseFeature,
  validator: LicenseValidator | null | undefined,
  opts: LicenseGateOptions,
): LicenseGateDenial | null {
  const tail = opts.guidance ? ` ${opts.guidance}` : '';

  // ── (a) nothing stored on this cortex ───────────────────────────────────
  // NOTE: a paying subscriber lands here on any cortex created after the
  // token was issued — `licenseEnc` is encrypted with the CORTEX key and does
  // not travel between cortexes. So this message leads with the restore path,
  // and only mentions buying a plan as the secondary possibility.
  if (!token || !token.trim()) {
    return {
      reason: 'no_token',
      requiredFeature: feature,
      grantedFeatures: [],
      message:
        `${opts.subject} requires the "${feature}" license feature. ` +
        `No license is stored on this cortex. ${RECHECK_HINT} ${NO_SUBSCRIPTION_HINT}${tail}`,
    };
  }

  // No validator in this process (smoke tests, standalone). Every call site
  // already denied here via `?? false`; say why instead of blaming the user.
  if (!validator) {
    return {
      reason: 'invalid',
      requiredFeature: feature,
      grantedFeatures: [],
      message:
        `${opts.subject} requires the "${feature}" license feature, but license verification is ` +
        `not available in this process, so the stored token cannot be checked.${tail}`,
    };
  }

  // A validator that only implements `hasFeature`.
  //
  // The old gates called exactly one method — `hasFeature(token, feature)` — so
  // every injected validator, and every test fixture, was built to that shape.
  // This module widened the dependency to `verifyToken` in order to tell the
  // denial REASONS apart (expired vs unverifiable vs feature-missing), and any
  // caller still supplying the narrow shape started throwing
  // `validator.verifyToken is not a function` from INSIDE the gate — before the
  // tool it guards ever ran. Measured: 12 failures across five suites.
  //
  // The 260-combination ALLOW/DENY proof for this module missed it entirely,
  // because every one of those combinations used the real validator. A guard
  // proven only against the rich fixture is not proven against its callers.
  //
  // So: fall back to the narrow contract rather than requiring the wide one.
  // ALLOW/DENY is unchanged — `hasFeature` is the same predicate. Only the
  // message loses its reason breakdown, which is the correct trade: a caller
  // that cannot verify tokens has no reason detail to report anyway.
  if (typeof validator.verifyToken !== 'function') {
    if (validator.hasFeature(token, feature)) return null; // ALLOW
    return {
      reason: 'feature_missing',
      requiredFeature: feature,
      grantedFeatures: [],
      message:
        `${opts.subject} requires the "${feature}" license feature, which your license does ` +
        `not include. ${RECHECK_HINT}${tail}`,
    };
  }

  const payload = validator.verifyToken(token);

  // ── (d) valid token, feature absent — the case that mattered ────────────
  if (payload) {
    const granted = Array.isArray(payload.features) ? payload.features : [];
    if (granted.includes(feature)) return null; // ALLOW — same condition as hasFeature()
    return {
      reason: 'feature_missing',
      requiredFeature: feature,
      grantedFeatures: granted,
      message:
        `Your license grants ${formatFeatureList(granted)}. ` +
        `${opts.subject} requires the "${feature}" feature, which your token does not include. ` +
        `${RECHECK_HINT}${tail}`,
    };
  }

  // verifyToken() returned null: either expired or unverifiable. Split the two
  // from the token's own claimed `exp` — wording only, access already denied.
  const claimed = decodeUnverifiedPayload(token);
  const claimedExp = typeof claimed?.exp === 'number' ? claimed.exp : null;

  // ── (b) expired ─────────────────────────────────────────────────────────
  if (claimedExp !== null && claimedExp * 1000 < Date.now()) {
    const expiredOn = new Date(claimedExp * 1000).toISOString().slice(0, 10);
    return {
      reason: 'expired',
      requiredFeature: feature,
      grantedFeatures: [],
      expiredOn,
      message:
        `${opts.subject} requires the "${feature}" license feature. ` +
        `The license stored on this cortex expired on ${expiredOn}. ${RECHECK_HINT}${tail}`,
    };
  }

  // ── (c) unparseable / bad signature ─────────────────────────────────────
  return {
    reason: 'invalid',
    requiredFeature: feature,
    grantedFeatures: [],
    message:
      `${opts.subject} requires the "${feature}" license feature. ` +
      `The license stored on this cortex could not be verified — it is malformed, or it was not ` +
      `signed by the Graphnosis license key. ${RECHECK_HINT}${tail}`,
  };
}

/**
 * Gate check for an ANY-OF set of features — for gates whose decision is
 * `hasFeature(a) || hasFeature(b)`.
 *
 * Allowed under EXACTLY the same condition as that disjunction; the returned
 * denial names the first feature in `features` as `requiredFeature` and lists
 * the whole acceptable set in the message.
 */
export function checkAnyFeatureGate(
  token: string | null | undefined,
  features: readonly LicenseFeature[],
  validator: LicenseValidator | null | undefined,
  opts: LicenseGateOptions,
): LicenseGateDenial | null {
  if (features.length === 0) return null;
  const primary = features[0]!;
  let last: LicenseGateDenial | null = null;
  for (const f of features) {
    const denial = checkFeatureGate(token, f, validator, opts);
    if (!denial) return null; // ALLOW — same condition as the || chain
    last = denial;
  }
  // Every branch denied. `last` shares the cause (same token, same validator);
  // only re-word the feature_missing case so it names the acceptable set.
  const d = last!;
  if (d.reason !== 'feature_missing') return { ...d, requiredFeature: primary };
  const accepted = features.map((f) => `"${f}"`).join(' or ');
  return {
    ...d,
    requiredFeature: primary,
    message:
      `Your license grants ${formatFeatureList(d.grantedFeatures)}. ` +
      `${opts.subject} requires ${accepted}, and your token includes neither. ` +
      `${RECHECK_HINT}${opts.guidance ? ` ${opts.guidance}` : ''}`,
  };
}

/**
 * Convenience for gates that only need the sentence.
 * Returns `null` when allowed, otherwise the refusal text.
 */
export function featureGateMessage(
  token: string | null | undefined,
  feature: LicenseFeature,
  validator: LicenseValidator | null | undefined,
  opts: LicenseGateOptions,
): string | null {
  return checkFeatureGate(token, feature, validator, opts)?.message ?? null;
}
