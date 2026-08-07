/**
 * Host-boundary types for secure-sync 0.4 federation results.
 *
 * WHY THIS EXISTS (SS040.3 — widening trap)
 * ----------------------------------------
 * `federatedQuery` returns a discriminated union: complete results have
 * `prompt`, incomplete ones have `partialPrompt` + `failures`. The App host
 * ALWAYS rebuilds its own rich prompt (and appends a partial-recall notice),
 * so every `host.recall` / `host.digDeeper` return value has a real `prompt`
 * string. That is a host invariant, not a cast that erases the union.
 *
 * Call sites must consume `HostRecallResult`, not widen federation types or
 * `as any` the prompt field. Audit count fields still require `status === 'ok'`
 * narrowing (SS040.2).
 */
import type { federation } from '@nehloo-interactive/graphnosis-secure-sync';

export type QueriedGraphAudit = federation.QueriedGraphAudit;
export type AnsweredGraphAudit = federation.AnsweredGraphAudit;
export type FailedGraphAudit = federation.FailedGraphAudit;

/** Post-host-rebuild recall: federation facts + always-present prompt. */
export type HostRecallResult = {
  complete: boolean;
  byGraph: Map<string, federation.CandidateNode[]>;
  tokensUsed: number;
  nodesIncluded: number;
  audit: QueriedGraphAudit[];
  withheld: federation.WithheldGraphAudit[];
  /** Always set by the host after rich-prompt rebuild (+ optional partial notice). */
  prompt: string;
  /** Present when federation reported `complete: false`. */
  failures?: federation.GraphFailure[];
  partialPrompt?: string;
};

export type DigDeeperProvenance = {
  contentMatch: { nodes: number; avgScore: number };
  sourceFilenameExpansion: { nodes: number; sources: string[] };
  crossEngramEntityHop: { nodes: number; viaEntities: string[]; sourceEngrams: number };
};

export type HostDigDeeperResult = HostRecallResult & {
  digDeeperProvenance: DigDeeperProvenance;
};

export function emptyHostRecall(): HostRecallResult {
  return {
    complete: true,
    byGraph: new Map(),
    prompt: '',
    tokensUsed: 0,
    nodesIncluded: 0,
    audit: [],
    withheld: [],
  };
}

/** Attach the host-rebuilt prompt without erasing complete/failures. */
export function withHostPrompt(
  sub: federation.FederatedSubgraph,
  prompt: string,
): HostRecallResult {
  return { ...sub, prompt };
}

export function isAnsweredAudit(a: QueriedGraphAudit): a is AnsweredGraphAudit {
  return a.status === 'ok';
}

export function isFailedAudit(a: QueriedGraphAudit): a is FailedGraphAudit {
  return a.status === 'failed';
}

/** Engrams that answered and contributed at least one node. */
export function contributingAudits(audit: QueriedGraphAudit[]): AnsweredGraphAudit[] {
  return audit.filter((a): a is AnsweredGraphAudit => a.status === 'ok' && a.nodesIncluded > 0);
}

/**
 * Engrams asked that answered with zero matches.
 * SS040.2: must NOT use `audit.length - contributing` — that treats failed
 * rows as "searched, no matches".
 */
export function noMatchSearchedCount(audit: QueriedGraphAudit[]): number {
  return audit.filter((a) => a.status === 'ok' && a.nodesIncluded === 0).length;
}

/** Sum nodes/tokens for answered rows only (failed rows have no counts). */
export function sumAnsweredTierCounts(
  audit: QueriedGraphAudit[],
): Record<string, { n: number; t: number }> {
  return audit.reduce<Record<string, { n: number; t: number }>>((acc, a) => {
    if (a.status !== 'ok') return acc;
    const slot = acc[a.tier] ?? (acc[a.tier] = { n: 0, t: 0 });
    slot.n += a.nodesIncluded;
    slot.t += a.tokensIncluded;
    return acc;
  }, {});
}
