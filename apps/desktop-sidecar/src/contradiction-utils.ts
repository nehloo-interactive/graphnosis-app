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
// "live in" matches its third-person conjugations (lives/lived/living in) so a
// stated location identity ("Nelu lives in Brașov") is recognised, not just the
// first-person "I live in" form. ("based in" already covers is/are/was based in.)
const IDENTITY_RE =
  /\b(?:i am|i'm|we are|we're|liv(?:e|es|ed|ing) in|based in|vegan|vegetarian|married|ceo|founder)\b|\b(?:i|we|i'm|we're)\s+(?:\w+\s+){0,2}(?:always|never|no longer)\b/i;

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

/** Same predicate frame, different object/value — location, leadership, stack, counts. */
const PREDICATE_FRAME_RE = [
  /\b(?:live|lives|lived|living)\s+in\b/i,
  /\b(?:based|headquarter(?:ed|s)?)\s+in\b/i,
  /\bled\s+by\b/i,
  /\b(?:lead|leads)\s+(?:of|the)\b/i,
  /\bruns?\s+on\b/i,
  /\bpersonal\s+best\s+is\b/i,
  /\bmost\s+recent\b/i,
  /\bbought\s+is\b/i,
  /\bpre-approval\s+(?:is|was)\b/i,
  /\bdeadline\b/i,
  // NOTE: bare numeric frames ("has N", "is/are N", "leads N") were removed —
  // they matched any count regardless of attribute, so "has 50 engineers" vs
  // "has 200 customers" read as a conflict. Numeric conflicts are now owned by
  // hasNumericValueConflict(), which checks the value quantifies the SAME attribute.
];

/** Non-conflicting aspects of the same subject (additive facts, not opposites). */
const ASPECT_PATTERNS: Record<string, RegExp> = {
  location: /\b(?:away|near|close|distance|located|address|headquarter|based|live|miles?|ft|feet|km|blocks?)\b/i,
  requirement: /\b(?:requires?|must|mandatory|onsite|on-site|prerequisite|need to bring|by appointment)\b/i,
  preference: /\b(?:prefer|favorite|favourite|like|dislike|love|hate|enjoy)\b/i,
  procedure: /\b(?:steps? to|how to|workflow|process for|instructions for)\b/i,
  hours: /\b(?:hours?|open|closed|weekdays?|weekends?)\b/i,
};

const NEAR_DUPLICATE_JACCARD = 0.72;
const FRAMED_CONFLICT_MIN_JACCARD = 0.3;
const NUMERIC_CONFLICT_MIN_SUBJECT_JACCARD = 0.45;
const NUMERIC_CONFLICT_MIN_ATTR_JACCARD = 0.6;
const GENERAL_VALUE_MAX_JACCARD = 0.92;
const GENERAL_VALUE_FRAME_MIN_JACCARD = 0.6;
const NARRATIVE_SUBJECT_MIN_JACCARD = 0.34;

// Narrative temporal-supersession cues the explicit-date rule misses — one snippet
// marks the past, the other the present ("used to … / now …", "before the merger /
// after …"). Single combined strip pattern (global) for the subject-frame match.
const NARRATIVE_PAST_RE =
  /\b(?:used to|use to|previously|formerly|before the|prior to|during beta|back in|no longer|last (?:year|winter|spring|summer|fall|autumn|month|week)|was|were)\b/i;
const NARRATIVE_PRESENT_RE =
  /\b(?:now|nowadays|currently|these days|moved to|switched to|after the|in production|this (?:year|winter|spring|summer|fall|autumn|month|week))\b/i;
const NARRATIVE_CUE_STRIP_RE =
  /\b(?:used to|use to|previously|formerly|before the|prior to|during beta|back in|no longer|last (?:year|winter|spring|summer|fall|autumn|month|week)|was|were|now|nowadays|currently|these days|moved to|switched to|after the|in production|this (?:year|winter|spring|summer|fall|autumn|month|week))\b/gi;

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

/** Two snippets carry DIFFERING 4-digit years → a timestamp progression marking WHEN a
 *  fact held (2022 → 2024), as opposed to a month/day that is itself the differing value
 *  (a birthday). Year progression keeps a dated value-change in the supersession lane even
 *  when the value also differs (status Silver → Gold). */
function hasYearProgression(snippetA: string, snippetB: string): boolean {
  const ya: string[] = snippetA.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  const yb: string[] = snippetB.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  if (ya.length === 0 || yb.length === 0) return false;
  return ya.some((y) => !yb.includes(y)) || yb.some((y) => !ya.includes(y));
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
    !NEGATION_RE.test(snippetA + snippetB) && !hasStrongConflictLanguage(snippetA, snippetB)
    && (
      (DATE_RE.test(snippetA) && DATE_RE.test(snippetB)
        && (hasYearProgression(snippetA, snippetB) || !hasGeneralValueConflict(snippetA, snippetB)))
      || hasNarrativeSupersession(snippetA, snippetB)
    )
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

function stripNumbers(s: string): string {
  return s.replace(/\d+(?:\.\d+)?/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Verb/auxiliary/function words that carry no attribute identity — dropped so a
 *  numeric conflict is judged on WHAT is counted, not tense or articles. */
const FRAME_STOPWORDS = new Set([
  'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'now', 'still',
  'currently', 'recently', 'the', 'and', 'for', 'with', 'about', 'around', 'since',
  'this', 'that', 'these', 'those', 'far', 'each', 'every', 'per',
]);

/** Number-free, stopword-free attribute frame — the noun(s) a value quantifies.
 *  "X has 50 engineers" → "engineers"; "X has 200 customers" → "customers". */
function attrFrame(s: string): string {
  return stripNumbers(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !FRAME_STOPWORDS.has(w))
    .join(' ');
}

/** Proper-noun-ish tokens: Capitalized, mid-sentence, ≥3 letters — the likely VALUE
 *  fillers of a frame ("…is Juniper", "uses PostgreSQL"). Sentence-initial capitals are
 *  skipped (they are usually "My"/"The"/"I", not a value). */
function properNounTokens(s: string): string[] {
  const words = s.trim().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (i === 0) continue;
    const raw = words[i];
    if (raw === undefined) continue;
    const w = raw.replace(/[^\p{L}\p{N}]/gu, '');
    if (/^[A-Z][a-zA-Z]{2,}$/.test(w)) out.push(w.toLowerCase());
  }
  return out;
}

/** Generalizes hasFramedValueConflict beyond the hardcoded predicate list: the two
 *  snippets share a frame (moderate token overlap, not identical) and each carries a
 *  DIFFERENT proper-noun value the other lacks — "My cat's name is Juniper" vs "…Marlo",
 *  "Morpho uses PostgreSQL" vs "…SQLite". The proper-noun requirement is the precision
 *  guard: complementary pairs differ in common modifiers (weekly/concise), a shared
 *  number on different metrics (81% recall/precision), or a different predicate
 *  (named Toast / a greyhound) — none of which expose a distinct proper noun on BOTH
 *  sides, so none trip this. */
export function hasGeneralValueConflict(snippetA: string, snippetB: string): boolean {
  const a = snippetA.trim();
  const b = snippetB.trim();
  if (a === b) return false;
  if (wordTokenJaccard(a, b) > GENERAL_VALUE_MAX_JACCARD) return false; // near-identical → restatement, not a value conflict
  const tokenSet = (s: string) =>
    new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3));
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  // A proper-noun value is "distinct" only if it appears NOWHERE in the other snippet, so
  // a reordered paraphrase ("Atlas led by Sarah" vs "Sarah leads Atlas") does not read as
  // two different values.
  const distinctA = properNounTokens(a).filter((w) => !tb.has(w));
  const distinctB = properNounTokens(b).filter((w) => !ta.has(w));
  if (distinctA.length === 0 || distinctB.length === 0) return false;
  // The residual FRAMES (those values removed) must be near-identical — the two snippets
  // ask the same thing of the same subject. This is what separates "my dentist is X" vs
  // "…is Y" (frame "dentist" identical) from two unrelated facts that share a frame word,
  // and it tolerates long multi-token values ("Rafi Benes") that would dilute raw overlap.
  const frameA = new Set([...ta].filter((w) => !distinctA.includes(w)));
  const frameB = new Set([...tb].filter((w) => !distinctB.includes(w)));
  let inter = 0;
  for (const w of frameA) if (frameB.has(w)) inter += 1;
  const union = frameA.size + frameB.size - inter;
  return (union > 0 ? inter / union : 0) >= GENERAL_VALUE_FRAME_MIN_JACCARD;
}

/** Subject frame for narrative-supersession matching: numbers, transition cues, and
 *  mid-sentence proper-noun values stripped, leaving the thing being updated. */
function narrativeSubjectTokens(s: string): Set<string> {
  const stripped = stripNumbers(s).replace(NARRATIVE_CUE_STRIP_RE, ' ');
  const out = new Set<string>();
  const words = stripped.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const raw = words[i];
    if (raw === undefined) continue;
    const w = raw.replace(/[^\p{L}\p{N}]/gu, '');
    if (w.length < 3) continue;
    if (FRAME_STOPWORDS.has(w.toLowerCase())) continue;
    if (i > 0 && /^[A-Z][a-zA-Z]{2,}$/.test(w)) continue;
    out.add(w.toLowerCase());
  }
  return out;
}

function narrativeSubjectSimilarity(a: string, b: string): number {
  const sa = narrativeSubjectTokens(a);
  const sb = narrativeSubjectTokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union > 0 ? inter / union : 0;
}

/** One snippet marks the past, the other the present, about the same subject → an update
 *  over time, not a conflict to adjudicate. The subject-match guard stops two unrelated
 *  dated facts from being merged into a false supersession. */
export function hasNarrativeSupersession(snippetA: string, snippetB: string): boolean {
  // A numeric value change (mortgage 350k → 400k) is a conflict to surface, not a silent
  // supersession — defer to the numeric signal so dated count drifts still reach the queue.
  if (hasNumericValueConflict(snippetA, snippetB)) return false;
  const split =
    (NARRATIVE_PAST_RE.test(snippetA) && NARRATIVE_PRESENT_RE.test(snippetB)) ||
    (NARRATIVE_PAST_RE.test(snippetB) && NARRATIVE_PRESENT_RE.test(snippetA));
  if (!split) return false;
  return narrativeSubjectSimilarity(snippetA, snippetB) >= NARRATIVE_SUBJECT_MIN_JACCARD;
}

export function hasNegationPolarityFlip(snippetA: string, snippetB: string): boolean {
  return NEGATION_RE.test(snippetA) !== NEGATION_RE.test(snippetB);
}

export function hasNumericValueConflict(snippetA: string, snippetB: string): boolean {
  const numsA: string[] = snippetA.match(/\d+(?:\.\d+)?/g) ?? [];
  const numsB: string[] = snippetB.match(/\d+(?:\.\d+)?/g) ?? [];
  if (numsA.length === 0 || numsB.length === 0) return false;
  // The numbers must actually differ.
  if (!numsA.some((n) => !numsB.includes(n)) && !numsB.some((n) => !numsA.includes(n))) return false;
  // …and the differing value must quantify the SAME attribute. Comparing the
  // value-free, verb-normalised frames (not the raw subject) stops "X has 50
  // engineers" vs "X has 200 customers" — same subject, different attribute —
  // from reading as a contradiction.
  return wordTokenJaccard(attrFrame(snippetA), attrFrame(snippetB)) >= NUMERIC_CONFLICT_MIN_ATTR_JACCARD;
}

export function hasFramedValueConflict(snippetA: string, snippetB: string): boolean {
  const a = snippetA.trim();
  const b = snippetB.trim();
  if (a === b) return false;
  const sim = wordTokenJaccard(a, b);
  if (sim < FRAMED_CONFLICT_MIN_JACCARD || sim > 0.92) return false;
  return PREDICATE_FRAME_RE.some((p) => p.test(a) && p.test(b));
}

function aspectTags(snippet: string): Set<string> {
  const tags = new Set<string>();
  for (const [tag, re] of Object.entries(ASPECT_PATTERNS)) {
    if (re.test(snippet)) tags.add(tag);
  }
  return tags;
}

/** Restatement / paraphrase — same fact, different wording. */
export function isNearDuplicatePair(snippetA: string, snippetB: string): boolean {
  if (hasNumericValueConflict(snippetA, snippetB)) return false;
  if (hasFramedValueConflict(snippetA, snippetB)) return false;
  if (hasGeneralValueConflict(snippetA, snippetB)) return false;
  const sim = wordTokenJaccard(snippetA, snippetB);
  if (sim < NEAR_DUPLICATE_JACCARD) return false;
  if (hasNegationPolarityFlip(snippetA, snippetB)) return false;
  if (hasStrongConflictLanguage(snippetA, snippetB)) return false;
  return true;
}

/** Same subject, different non-opposing aspects (distance vs requirement, etc.). */
export function isComplementaryPair(snippetA: string, snippetB: string): boolean {
  if (hasNegationPolarityFlip(snippetA, snippetB)) return false;
  if (hasNumericValueConflict(snippetA, snippetB)) return false;
  if (hasFramedValueConflict(snippetA, snippetB)) return false;
  if (hasGeneralValueConflict(snippetA, snippetB)) return false;
  if (hasStrongConflictLanguage(snippetA, snippetB)) return false;
  const ta = aspectTags(snippetA);
  const tb = aspectTags(snippetB);
  if (ta.size === 0 || tb.size === 0) return false;
  for (const t of ta) if (tb.has(t)) return false;
  return true;
}

export interface ConflictSignalResult {
  strong: boolean;
  negationFlip: boolean;
  numeric: boolean;
  framed: boolean;
  valueConflict: boolean;
  any: boolean;
}

export function detectConflictSignals(snippetA: string, snippetB: string): ConflictSignalResult {
  const strong = hasStrongConflictLanguage(snippetA, snippetB);
  const negationFlip = hasNegationPolarityFlip(snippetA, snippetB);
  const numeric = hasNumericValueConflict(snippetA, snippetB);
  const framed = hasFramedValueConflict(snippetA, snippetB);
  const valueConflict = hasGeneralValueConflict(snippetA, snippetB);
  return {
    strong, negationFlip, numeric, framed, valueConflict,
    any: strong || negationFlip || numeric || framed || valueConflict,
  };
}

/** Minimum meaningful shared entities before queueing. */
function entityFloor(
  severity: ContradictionSeverity,
  signals: ConflictSignalResult,
  meaningfulShared: string[],
  snippetA: string,
  snippetB: string,
): number {
  if (severity === 'high') return 0;
  if (signals.numeric && wordTokenJaccard(snippetA, snippetB) >= NUMERIC_CONFLICT_MIN_SUBJECT_JACCARD) {
    return 0;
  }
  // A same-frame / distinct-proper-noun-value conflict establishes itself from the frame,
  // not from shared anchors (the differing values ARE the entities, so they never overlap).
  if (signals.valueConflict) return 0;
  if (signals.framed || signals.numeric) return 1;
  if (meaningfulShared.length >= 2) return 2;
  return 2;
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
  | 'ingest-gate'
  | 'near-duplicate'
  | 'complementary'
  | 'no-conflict-signal';

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
  const signals = detectConflictSignals(input.snippetA, input.snippetB);
  const floor = entityFloor(severity, signals, meaningfulShared, input.snippetA, input.snippetB);

  // Narrative supersession carries its own subject-match guard, so route it to the
  // supersession lane BEFORE the anchor floor (a "used to / now" update shares no named
  // entity). Date-anchored supersession stays behind the floor below, so a weak-entity
  // pair that merely shares a year is still suppressed as insufficient.
  if (temporalVerdict === 'temporal_supersession' && hasNarrativeSupersession(input.snippetA, input.snippetB)) {
    return { ...base, queue: false, reason: 'temporal-supersession' };
  }
  if (meaningfulShared.length < floor) {
    return { ...base, queue: false, reason: 'insufficient-entities' };
  }
  if (temporalVerdict === 'temporal_supersession') {
    return { ...base, queue: false, reason: 'temporal-supersession' };
  }
  if (temporalVerdict === 'negation_artifact') {
    return { ...base, queue: false, reason: 'negation-artifact' };
  }
  if (severity === 'low') {
    return { ...base, queue: false, reason: 'low-severity' };
  }
  if (isNearDuplicatePair(input.snippetA, input.snippetB)) {
    return { ...base, queue: false, reason: 'near-duplicate' };
  }
  if (isComplementaryPair(input.snippetA, input.snippetB)) {
    return { ...base, queue: false, reason: 'complementary' };
  }
  if (!signals.any && severity !== 'high') {
    return { ...base, queue: false, reason: 'no-conflict-signal' };
  }
  if (input.ingest
    && !passesIngestContradictionGate(input.snippetA, input.snippetB, meaningfulShared, severity)) {
    return { ...base, queue: false, reason: 'ingest-gate' };
  }
  return { ...base, queue: true, reason: 'queued' };
}
