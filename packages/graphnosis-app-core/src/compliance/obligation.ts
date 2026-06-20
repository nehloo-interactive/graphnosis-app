/**
 * Temporal Job Memory — obligation metadata on memory nodes.
 *
 * Distinct from `validUntil` (soft-delete / supersession). Obligations model
 * deadlines, renewals, and review-by dates that retention must respect until
 * `expiresAt` even when the enclosing source exceeds its retention TTL.
 */

export type ObligationType = 'deadline' | 'renewal' | 'review-by';

export interface NodeObligation {
  graphId: string;
  nodeId: string;
  sourceId: string;
  obligationType: ObligationType;
  /** Unix ms when the obligation becomes actionable. Defaults to createdAt. */
  effectiveDate: number;
  /** Unix ms when the obligation lapses — retention purge must not remove before this. */
  expiresAt: number;
  createdAt: number;
}

export interface ObligationListFilter {
  graphIds?: string[];
  obligationType?: ObligationType;
  /** Include obligations with expiresAt <= now + dueWithinMs. */
  dueWithinMs?: number;
  /** When true, include obligations whose expiresAt is already past. */
  includeOverdue?: boolean;
  maxResults?: number;
  now?: number;
}

/** True when the obligation has not yet reached its expiry boundary. */
export function isActiveObligation(
  ob: Pick<NodeObligation, 'expiresAt'>,
  now = Date.now(),
): boolean {
  return ob.expiresAt > now;
}

/** True when expiresAt falls within [now, now + windowMs] (or is overdue). */
export function obligationDueWithin(
  ob: Pick<NodeObligation, 'expiresAt'>,
  windowMs: number,
  now = Date.now(),
  includeOverdue = true,
): boolean {
  if (ob.expiresAt <= now) return includeOverdue;
  return ob.expiresAt - now <= windowMs;
}

export function sortObligationsByExpiresAt<T extends Pick<NodeObligation, 'expiresAt'>>(
  rows: T[],
): T[] {
  return rows.slice().sort((a, b) => a.expiresAt - b.expiresAt);
}

export function filterObligations(
  rows: NodeObligation[],
  filter: ObligationListFilter = {},
): NodeObligation[] {
  const now = filter.now ?? Date.now();
  let out = rows.filter((ob) => isActiveObligation(ob, now));

  if (filter.graphIds?.length) {
    const allowed = new Set(filter.graphIds);
    out = out.filter((ob) => allowed.has(ob.graphId));
  }
  if (filter.obligationType) {
    out = out.filter((ob) => ob.obligationType === filter.obligationType);
  }
  if (filter.dueWithinMs !== undefined) {
    out = out.filter((ob) =>
      obligationDueWithin(ob, filter.dueWithinMs!, now, filter.includeOverdue !== false),
    );
  }

  out = sortObligationsByExpiresAt(out);
  const max = filter.maxResults ?? 50;
  return out.slice(0, max);
}
