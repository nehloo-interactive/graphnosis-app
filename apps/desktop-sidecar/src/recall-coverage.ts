/**
 * Federated-recall coverage — "did every engram in scope actually answer?"
 *
 * THE DEFECT THIS EXISTS TO CLOSE. `federatedQuery` degrades per engram: one
 * unreadable engram no longer costs the user every other engram's answer. That
 * is the right trade only if the degradation is DISCLOSED. The secure-sync
 * module hands the caller a `complete: false` branch carrying `failures`, and
 * its own `renderPrompt` writes an `INCOMPLETE CONTEXT` banner — but the
 * sidecar throws that banner away: `hostRecall` replaces the federation prompt
 * with its own rich `=== KNOWLEDGE SUBGRAPH ===` render, and the IPC layer
 * projects the result down to `{ prompt, tokensUsed, nodesIncluded, byGraph,
 * audit }`. Both `complete` and `failures` were dropped on the floor.
 *
 * The consequence is not cosmetic. A recall that read 3 of 5 engrams looked
 * exactly like one that read all 5, so the model asserted absence ("you have no
 * record of that") for memories it was never shown, and the user had no signal
 * that anything was missing. In a system whose promise is that nothing is lost,
 * answering from an unknown subset without saying so is a correctness failure.
 *
 * WHY THE INPUT IS TYPED STRUCTURALLY AND NOT AS `federation.FederatedSubgraph`.
 *
 * INSTALLED: `@nehloo-interactive/graphnosis-secure-sync` **0.4.0** (git tag
 * `#v0.4.0`). Re-check with:
 *
 *   node -p "JSON.parse(require('fs').readFileSync( \
 *     'node_modules/@nehloo-interactive/graphnosis-secure-sync/package.json','utf8')).version"
 *
 * 0.4.0's `FederatedSubgraph` is a complete/incomplete discriminated union with
 * `failures` / `withheld`, and audit rows are `AnsweredGraphAudit |
 * FailedGraphAudit`. Reading structurally keeps this module compilable against
 * older pins and against host-rebuilt shapes that always carry `prompt`.
 *
 * On 0.4.0, `complete: false` + `failures` light up in production when any
 * engram in scope does not answer. Edge ranks (rescue statusless rows,
 * withheld>failed) are still exercised by synthetic CONTRACT-ONLY tests — see
 * `tests/_contract-level.mjs`.
 *
 * Everything below is pure. No I/O, no host, no SDK — so the contract is
 * testable directly against `dist/recall-coverage.js`.
 */

/** Why an engram went unread. Mirrors secure-sync's `GraphFailure.reason`. */
export type RecallFailureReason = 'error' | 'timeout';

/** One engram that was asked and did not answer, named for a human. */
export interface RecallCoverageFailure {
  graphId: string;
  /** Resolved through the host's graph metadata; falls back to the raw id. */
  displayName: string;
  tier: string;
  reason: RecallFailureReason;
  /** Detail as reported by federation, e.g. `sqlite: database is locked`. */
  error: string;
}

/**
 * What a federated recall actually covered.
 *
 * `complete: true` is the ONLY state in which a caller may present the answer
 * as covering the user's memory. Note the deliberate asymmetry with
 * `engramsQueried`: a WITHHELD engram (policy kept it out) is not counted as
 * queried and is never named here — surfacing "clinic-records was withheld"
 * would disclose the existence and relevance of a sensitive engram, which is
 * the thing withholding exists to prevent.
 *
 * That is enforced on every channel this type exposes, not just the obvious
 * one (see gates 1-3 in `summarizeRecallCoverage`): a withheld engram never
 * reaches `failures` (name, id, tier, error string), never moves
 * `engramsQueried`, and never moves `engramsAnswered`. `failures` ordering
 * carries nothing either — it is a fresh array, so a filtered-out engram
 * leaves no gap to count.
 *
 * The ONE channel deliberately left open is `complete` itself: if federation
 * says `complete: false`, this reports `false` even when the only thing it
 * could name was withheld, and the notice degrades to "at least one engram did
 * not answer". That discloses that a gap exists, never which engram — and
 * suppressing it would mean presenting a knowingly partial answer as total,
 * which is the failure this whole module exists to close.
 */
export interface RecallCoverage {
  complete: boolean;
  /** Engrams federation actually asked (withheld engrams excluded). */
  engramsQueried: number;
  /** Of those, how many answered. */
  engramsAnswered: number;
  /** Non-empty iff `complete` is false. */
  failures: RecallCoverageFailure[];
}

/** The shape we read off a federated subgraph. Intentionally all-optional. */
export interface RecallCoverageInput {
  complete?: boolean;
  failures?: Array<{
    graphId?: unknown;
    tier?: unknown;
    reason?: unknown;
    error?: unknown;
  }>;
  audit?: Array<{
    graphId?: unknown;
    tier?: unknown;
    status?: unknown;
    error?: unknown;
  }>;
}

/**
 * withheld beats failed beats ok.
 *
 * `failed > ok` is the load-bearing half: the rescue pass pushes a SECOND,
 * statusless audit row for an engram it retried, and a statusless row
 * normalizes to `ok` — without the rank that row would silently mark a failed
 * engram answered.
 *
 * `withheld > failed` is the PRIVACY half, and it is deliberately the reverse
 * of what a "worst status wins" reading would suggest. If a future federation
 * ever reports an engram as BOTH withheld and failed, naming it in the
 * disclosure would defeat the whole point of having withheld it — the reader
 * learns a sensitive engram exists and was relevant to this query, which is
 * exactly what withholding prevents. Under-disclosure is the safer error here
 * and it is bounded: `complete` still goes false (see below), so the recall is
 * still announced as partial, just without an identity attached.
 */
const STATUS_RANK: Record<'ok' | 'withheld' | 'failed', number> = { ok: 0, failed: 1, withheld: 2 };

function normalizeStatus(raw: unknown): 'ok' | 'withheld' | 'failed' {
  return raw === 'failed' ? 'failed' : raw === 'withheld' ? 'withheld' : 'ok';
}

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/**
 * Reduce a federated subgraph to the coverage facts a caller must disclose.
 *
 * `displayNameFor` resolves an engram id to the name the user knows it by; the
 * host supplies it from graph metadata. Omit it and ids are used verbatim.
 */
export function summarizeRecallCoverage(
  sub: RecallCoverageInput | null | undefined,
  displayNameFor?: (graphId: string) => string,
): RecallCoverage {
  const name = (id: string): string => {
    if (!displayNameFor) return id;
    try {
      return asString(displayNameFor(id), id);
    } catch {
      // Metadata lookup must never take down a recall.
      return id;
    }
  };

  // Collapse the audit to one status per engram. The rescue pass in
  // host/recall-methods.ts pushes an EXTRA audit row for an engram it rescued,
  // so a naive row count double-counts; and those rescue rows carry no
  // `status`, which normalizes to `ok`. Ranking makes both harmless.
  const statusByGraph = new Map<string, 'ok' | 'withheld' | 'failed'>();
  const tierByGraph = new Map<string, string>();
  for (const row of sub?.audit ?? []) {
    const gid = typeof row?.graphId === 'string' ? row.graphId : null;
    if (gid === null) continue;
    const status = normalizeStatus(row?.status);
    const prev = statusByGraph.get(gid);
    if (prev === undefined || STATUS_RANK[status] > STATUS_RANK[prev]) statusByGraph.set(gid, status);
    if (typeof row?.tier === 'string' && !tierByGraph.has(gid)) tierByGraph.set(gid, row.tier);
  }

  // Failure detail: prefer the `failures` array (it carries reason + message);
  // fall back to failed audit rows so a federation that reports the status but
  // not the union still surfaces something rather than nothing.
  const failures: RecallCoverageFailure[] = [];
  const failedIds = new Set<string>();
  for (const f of sub?.failures ?? []) {
    const gid = typeof f?.graphId === 'string' ? f.graphId : null;
    if (gid === null || failedIds.has(gid)) continue;
    // GATE 1 (identity). The header promises a withheld engram is "never
    // named"; nothing used to enforce it, because this loop read `failures`
    // without ever consulting the audit. A graph that is both withheld AND
    // present in `failures` was pushed straight into the disclosure WITH ITS
    // DISPLAY NAME — "Could not read: Clinic records (…)" — which is the leak
    // withholding exists to prevent. Skipping BEFORE `failedIds.add` also
    // keeps the id out of every count derived from that set.
    if (statusByGraph.get(gid) === 'withheld') continue;
    failedIds.add(gid);
    failures.push({
      graphId: gid,
      displayName: name(gid),
      tier: asString(f?.tier, tierByGraph.get(gid) ?? 'personal'),
      reason: f?.reason === 'timeout' ? 'timeout' : 'error',
      error: asString(f?.error, 'no detail reported'),
    });
  }
  for (const [gid, status] of statusByGraph) {
    if (status !== 'failed' || failedIds.has(gid)) continue;
    failedIds.add(gid);
    const row = (sub?.audit ?? []).find((r) => r?.graphId === gid && normalizeStatus(r?.status) === 'failed');
    failures.push({
      graphId: gid,
      displayName: name(gid),
      tier: tierByGraph.get(gid) ?? 'personal',
      reason: 'error',
      error: asString(row?.error, 'no detail reported'),
    });
  }

  // GATE 2 (count). `failures` can carry an engram with no audit row at all, so
  // the failed set seeds the queried set — but it must be filtered on the way
  // in for the same reason as gate 1. A withheld engram counted here turns
  // "1 of 1 answered" into "1 of 2", and a count that moves when a sensitive
  // engram is in scope is an identity channel just as surely as a name is.
  const queried = new Set<string>();
  for (const gid of failedIds) {
    if (statusByGraph.get(gid) !== 'withheld') queried.add(gid);
  }
  for (const [gid, status] of statusByGraph) {
    if (status !== 'withheld') queried.add(gid);
  }

  // GATE 3 (the arithmetic). `queried.size - failedIds.size` would let a
  // withheld id that reached `failedIds` shrink the ANSWERED figure without
  // ever growing the QUERIED one — "0 of 1 answered" on a recall where the one
  // real engram answered fine. Count only the failures that are actually in
  // scope, so the ratio can never depend on a withheld engram either way.
  let unanswered = 0;
  for (const gid of failedIds) if (queried.has(gid)) unanswered += 1;

  // `complete === false` is authoritative even when the failure list is empty
  // or malformed: the union said the result does not cover everything, and a
  // caller must never upgrade that to "complete" because it could not parse
  // the detail.
  const complete = sub?.complete !== false && failures.length === 0;

  return {
    complete,
    engramsQueried: queried.size,
    engramsAnswered: Math.max(0, queried.size - unanswered),
    failures,
  };
}

/**
 * The model-facing disclosure appended to a partial recall's prompt.
 *
 * Returns `''` for a complete recall — a complete result must NOT be annotated,
 * or the warning becomes noise the model learns to ignore, and the one recall
 * that genuinely is partial reads like every other one.
 *
 * This restores what `hostRecall` destroys by replacing federation's
 * `renderPrompt` with the rich subgraph render: secure-sync's own comment names
 * this exact hazard — "a caller that builds its own prompt from `byGraph` (as
 * the desktop app does) discards the banner and must disclose the gap itself".
 */
export function renderPartialRecallNotice(coverage: RecallCoverage): string {
  if (coverage.complete) return '';
  const named = coverage.failures
    .map((f) => `${f.displayName} (${f.reason === 'timeout' ? 'did not respond in time' : f.error})`)
    .join('; ');
  // The ratio is only quotable when there is a NAMED failure behind it. With
  // the failure list empty — federation said `complete: false` but gave no
  // usable detail, or the only candidate was withheld and suppressed upstream —
  // the counts describe a fully-answered scope, so printing "1 of 1 answered"
  // next to "could not read" hands the model a self-contradiction it will
  // resolve in whichever direction it likes. Say only what is certain.
  const scope = coverage.failures.length > 0 && coverage.engramsQueried > 0
    ? `${coverage.engramsAnswered} of ${coverage.engramsQueried} engram(s) answered`
    : 'at least one engram did not answer';
  return (
    `⚠️ _INCOMPLETE RECALL: ${scope}. ` +
    `Could not read: ${named || 'unnamed engram(s)'}. ` +
    `Absence of a memory above is NOT evidence it does not exist — ` +
    `do not tell the user they have no record of something based on this context._`
  );
}
