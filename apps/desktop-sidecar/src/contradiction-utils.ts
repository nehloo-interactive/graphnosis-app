/**
 * Deterministic helpers for Memory Integrity — severity rubric, temporal
 * verdict heuristics, and ingest-time precision gates (no LLM).
 */

export type ContradictionSeverity = 'low' | 'medium' | 'high';
export type TemporalVerdict =
  | 'genuine_contradiction'
  | 'temporal_supersession'
  | 'negation_artifact';

const NEGATION_RE =
  /\b(?:not|never|no longer|don't|doesn't|didn't|won't|can't|cannot|without|except)\b/i;
const DATE_RE =
  /\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?\b/i;
// Identity-statement markers. "always" / "never" / "no longer" are only an
// identity signal when first-person-anchored ("I never eat meat", "we're no
// longer based here") — bare "always"/"never" anywhere in a snippet was a
// false-positive source, so they no longer match standalone.
const IDENTITY_RE =
  /\b(?:i am|i'm|we are|we're|live in|based in|vegan|vegetarian|married|ceo|founder)\b|\b(?:i|we|i'm|we're)\s+(?:\w+\s+){0,2}(?:always|never|no longer)\b/i;

/** ISO-ish dates, bare years, money, and ultra-common corpus terms. */
const WEAK_ENTITY_RE =
  /^(?:\$?\d+(?:\.\d+)?%?|\d{4}(?:-\d{2}){0,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i;

/** Entities that appear in almost every note — not useful for contradiction pairing. */
const COMMON_TERM_ENTITIES = new Set([
  'mcp', 'free', 'api', 'sdk', 'app', 'tool', 'tools', 'note', 'notes', 'memory',
  'graph', 'graphnosis', 'data', 'user', 'text', 'file', 'files', 'code', 'test',
  'true', 'false', 'null', 'none', 'open', 'pro', 'tier', 'plan', 'plans',
  'first', 'second', 'third', 'last', 'new', 'old', 'next', 'previous',
  'general', 'special', 'common', 'standard', 'modern', 'early', 'late',
  'large', 'small', 'high', 'low', 'long', 'short', 'major', 'minor',
  'important', 'significant', 'similar', 'different', 'various', 'several',
  'many', 'most', 'some', 'other', 'such', 'based', 'used', 'known',
  'called', 'named', 'given', 'made', 'found', 'developed', 'designed',
  'published', 'released', 'introduced', 'proposed', 'described',
  'system', 'model', 'method', 'process', 'program', 'device',
]);

/** Stricter than SDK ingest CONFLICT_PATTERNS — aligned with reflect Path-2. */
const STRONG_CONFLICT_RE = [
  /\bnot\s+(?:a|an|the)\s/i,
  /\bno longer\b/i,
  /\bwas\s+(?:not|never)\b/i,
  /\breplaced\s+by\b/i,
  /\bcontrary\s+to\b/i,
  /\bis\s+(?:incorrect|wrong|false|inaccurate)\b/i,
  /\bwas\s+(?:incorrect|wrong|false|inaccurate)\b/i,
  /\breclassified\b/i,
  /\bdisputed\b/i,
  /\bdisproven\b/i,
  /\bdebunked\b/i,
  /\brefuted\b/i,
  /\bretracted\b/i,
  /\bsuperseded\b/i,
  /\bcorrected\b/i,
  /\bnot\s+actually\b/i,
];

export function isMeaningfulContradictionEntity(entity: string): boolean {
  const raw = entity.trim();
  if (raw.length < 4) return false;
  if (/^\d+$/.test(raw)) return false;
  if (WEAK_ENTITY_RE.test(raw)) return false;
  const lower = raw.toLowerCase();
  if (COMMON_TERM_ENTITIES.has(lower)) return false;
  return true;
}

export function filterMeaningfulSharedEntities(
  entities: string[],
  isCommonEntity?: (entity: string) => boolean,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entities) {
    if (!isMeaningfulContradictionEntity(e)) continue;
    if (isCommonEntity?.(e)) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function classifySeverity(
  snippetA: string,
  snippetB: string,
  sharedEntities: string[],
): ContradictionSeverity {
  const a = snippetA.trim();
  const b = snippetB.trim();
  if (!a || !b) return 'low';
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 'low';
  // Strong identity conflicts win before the short-drift shortcut: an identity
  // statement ("I am vegan" vs "I am not vegan") is a real contradiction even
  // when both snippets are short and share a single anchor. Ordering it ahead
  // of the drift rule stops that rule from masking it as low severity.
  if (IDENTITY_RE.test(a) || IDENTITY_RE.test(b)) return 'high';
  // Short name/format drift (only once strong signals are ruled out).
  if (a.length < 24 && b.length < 24 && sharedEntities.length <= 1) return 'low';
  if (NEGATION_RE.test(a) !== NEGATION_RE.test(b)) return 'medium';
  if (/\d/.test(a) && /\d/.test(b)) return 'medium';
  return 'medium';
}

export function classifyTemporalVerdict(
  snippetA: string,
  snippetB: string,
  validUntilA?: number,
  validUntilB?: number,
): TemporalVerdict {
  const now = Date.now();
  if (
    (validUntilA !== undefined && validUntilA <= now) ||
    (validUntilB !== undefined && validUntilB <= now)
  ) {
    return 'temporal_supersession';
  }
  if (
    DATE_RE.test(snippetA) && DATE_RE.test(snippetB) && !NEGATION_RE.test(snippetA + snippetB)
    && !hasStrongConflictLanguage(snippetA, snippetB)
  ) {
    return 'temporal_supersession';
  }
  if (NEGATION_RE.test(snippetA) && NEGATION_RE.test(snippetB)) {
    return 'negation_artifact';
  }
  return 'genuine_contradiction';
}

export function pairKey(graphId: string, nodeA: string, nodeB: string): string {
  return nodeA < nodeB ? `${graphId}|${nodeA}|${nodeB}` : `${graphId}|${nodeB}|${nodeA}`;
}

function wordTokenJaccard(a: string, b: string): number {
  const tokens = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const w of s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
      if (w.length >= 3) out.add(w);
    }
    return out;
  };
  const sa = tokens(a);
  const sb = tokens(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

export function hasStrongConflictLanguage(snippetA: string, snippetB: string): boolean {
  const a = snippetA.trim();
  const b = snippetB.trim();
  if (a.length < 80 || b.length < 80) return false;
  const aStrong = STRONG_CONFLICT_RE.some((p) => p.test(a));
  const bStrong = STRONG_CONFLICT_RE.some((p) => p.test(b));
  return aStrong || bStrong;
}

/** Path-2-style ingest gate: meaningful entity overlap + conflict signal (+ not a near-duplicate). */
export function passesIngestContradictionGate(
  snippetA: string,
  snippetB: string,
  meaningfulShared: string[],
  severity: ContradictionSeverity = 'medium',
): boolean {
  // High-severity (identity) conflicts queue on a single strong anchor; every
  // other pair still needs ≥2 meaningful shared entities.
  const floor = severity === 'high' ? 1 : 2;
  if (meaningfulShared.length < floor) return false;
  if (!hasStrongConflictLanguage(snippetA, snippetB)) return false;
  const contentSim = wordTokenJaccard(snippetA, snippetB);
  // Near-identical prose → duplicate pair, not a contradiction.
  return contentSim <= 0.85;
}

export interface ContradictionTriageInput {
  snippetA: string;
  snippetB: string;
  sharedEntities: string[];
  /** Ingest-time pairs apply stricter Path-2-style gates. */
  ingest?: boolean;
  validUntilA?: number;
  validUntilB?: number;
  /** Optional corpus-derived stopword check (#4b) — entities with high document
   *  frequency in THIS engram are not meaningful contradiction anchors. */
  isCommonEntity?: (entity: string) => boolean;
}

/** Why a detected pair was kept out of the live review queue (audit lane, never silent). */
export type SuppressionReason =
  | 'insufficient-entities'
  | 'low-severity'
  | 'negation-artifact'
  | 'temporal-supersession'
  | 'ingest-gate';

export interface ContradictionTriageResult {
  queue: boolean;
  /** 'queued' when surfaced; otherwise the reason it was routed to the audit lane. */
  reason: 'queued' | SuppressionReason;
  meaningfulShared: string[];
  severity: ContradictionSeverity;
  temporalVerdict: TemporalVerdict;
}

/** A triage-suppressed pair, recorded so suppression stays auditable (#1/#3). */
export interface SuppressedContradiction {
  graphId: string;
  nodeA: string;
  nodeB: string;
  snippetA: string;
  snippetB: string;
  severity: ContradictionSeverity;
  temporalVerdict: TemporalVerdict;
  reason: SuppressionReason;
  sharedEntities: string[];
  fromIngest: boolean;
  detectedAt: number;
}

/** Decide whether a pair belongs in the human review queue (not just severity labels). */
export function evaluateContradictionTriage(input: ContradictionTriageInput): ContradictionTriageResult {
  const meaningfulShared = filterMeaningfulSharedEntities(input.sharedEntities, input.isCommonEntity);
  const severity = classifySeverity(input.snippetA, input.snippetB, meaningfulShared);
  const temporalVerdict = classifyTemporalVerdict(
    input.snippetA,
    input.snippetB,
    input.validUntilA,
    input.validUntilB,
  );

  const base = { meaningfulShared, severity, temporalVerdict };

  // High-severity (identity) conflicts are allowed through on a single strong
  // anchor; everything else needs ≥2 meaningful shared entities. This recovers
  // genuine single-anchor identity contradictions the flat ≥2 floor used to drop.
  const floor = severity === 'high' ? 1 : 2;
  if (meaningfulShared.length < floor) {
    return { ...base, queue: false, reason: 'insufficient-entities' };
  }
  // Temporal supersession is not a live conflict — route it to its own audit
  // lane (recorded, recoverable), never auto-resolved and never queued.
  if (temporalVerdict === 'temporal_supersession') {
    return { ...base, queue: false, reason: 'temporal-supersession' };
  }
  if (temporalVerdict === 'negation_artifact') {
    return { ...base, queue: false, reason: 'negation-artifact' };
  }
  if (severity === 'low') {
    return { ...base, queue: false, reason: 'low-severity' };
  }
  if (input.ingest
    && !passesIngestContradictionGate(input.snippetA, input.snippetB, meaningfulShared, severity)) {
    return { ...base, queue: false, reason: 'ingest-gate' };
  }
  return { ...base, queue: true, reason: 'queued' };
}
