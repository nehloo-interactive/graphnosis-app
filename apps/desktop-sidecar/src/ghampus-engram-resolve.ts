/**
 * Ghampus remember/save — engram hint parsing and resolution against list_engrams.
 */

export type EngramListEntry = { graphId: string; displayName: string; tier?: string };

export const MAX_ENGRAM_HINT_CHARS = 60;

/** Delimiters between engram name and note content in save commands. */
const ENGRAM_CONTENT_SPLIT_RES = [
  /\s+that\s+/i,
  /\s+c[aă]\s+/i,
  /\s*:\s+/,
  /\s+[–—-]\s+/,
  /\n/,
];

function stripQuotes(s: string): string {
  return s.replace(/^["']+|["']+$/g, '').trim();
}

/** If a greedy parse swallowed content into the hint, re-split on that/că/: etc. */
export function trimGreedyEngramHint(hint: string): string {
  let h = stripQuotes(hint.trim());
  if (!h) return h;

  for (const re of ENGRAM_CONTENT_SPLIT_RES) {
    const m = h.match(re);
    if (m?.index !== undefined && m.index > 0) {
      h = h.slice(0, m.index).trim();
      break;
    }
  }

  if (h.length > MAX_ENGRAM_HINT_CHARS) {
    h = h.slice(0, MAX_ENGRAM_HINT_CHARS).trim();
    for (const re of ENGRAM_CONTENT_SPLIT_RES) {
      const m = h.match(re);
      if (m?.index !== undefined && m.index > 0) {
        h = h.slice(0, m.index).trim();
        break;
      }
    }
  }

  return stripQuotes(h);
}

/**
 * Partial save lines often append note text after a known engram ("music to come up with …").
 * When a prefix resolves to an existing engram and the next word opens note content, trim back.
 */
export function refinePartialEngramHint(hint: string, engramList: EngramListEntry[]): string {
  const trimmed = trimGreedyEngramHint(hint);
  if (!trimmed || engramList.length === 0) return trimmed;
  if (resolveEngramFromUserHint(trimmed, engramList)) return trimmed;

  const words = trimmed.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const prefix = words.slice(0, i).join(' ');
    if (!resolveEngramFromUserHint(prefix, engramList)) continue;
    const next = words[i]?.toLowerCase() ?? '';
    if (next === 'to' || next === 'that' || next === 'că' || next === 'ca' || next === ':') {
      return prefix;
    }
  }
  return trimmed;
}

/** Compact key for slug/display comparison — lowercase alphanumerics only. */
export function normalizeEngramKey(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function slugifyHint(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Slug for a new engram from a user-typed hint (matches graph wizard rules). */
export function slugifyEngramHint(hint: string): string {
  return slugifyHint(trimGreedyEngramHint(hint)).slice(0, 32);
}

function tokenizeEngramName(s: string): string[] {
  return s
    .normalize('NFC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

function scoreEngramMatch(query: string, candidate: string): number {
  const qn = normalizeEngramKey(query);
  const cn = normalizeEngramKey(candidate);
  if (!qn || !cn) return 0;
  if (qn === cn) return 1;
  if (cn.startsWith(qn) || qn.startsWith(cn)) return 0.92;
  if (cn.includes(qn)) return qn.length >= 4 ? 0.9 : 0.75;
  if (qn.includes(cn)) return 0.88;
  const tokens = jaccard(tokenizeEngramName(query), tokenizeEngramName(candidate));
  const dist = levenshtein(qn, cn);
  const editScore = 1 - dist / Math.max(qn.length, cn.length);
  return Math.max(tokens, editScore);
}

const FUZZY_THRESHOLD = 0.6;

/**
 * Resolve a user-provided engram hint against list_engrams results.
 * Handles exact graphId, case/hyphen normalization, prefix, and displayName fuzzy match.
 */
export function resolveEngramFromUserHint(
  hint: string,
  engramList: EngramListEntry[],
): EngramListEntry | null {
  const trimmed = trimGreedyEngramHint(hint);
  if (!trimmed || engramList.length === 0) return null;

  const qLower = trimmed.toLowerCase();
  const qKey = normalizeEngramKey(trimmed);
  const qSlug = slugifyHint(trimmed);

  for (const e of engramList) {
    if (e.graphId === trimmed || e.graphId.toLowerCase() === qLower) return e;
    if (e.graphId === qSlug) return e;
    if (normalizeEngramKey(e.graphId) === qKey) return e;
    if (e.displayName.toLowerCase() === qLower) return e;
    if (normalizeEngramKey(e.displayName) === qKey) return e;
  }

  for (const e of engramList) {
    const gid = e.graphId.toLowerCase();
    const gidCompact = gid.replace(/-/g, '');
    if (gid.startsWith(qSlug) || qSlug.startsWith(gid)) return e;
    if (gidCompact.startsWith(qKey) || qKey.startsWith(gidCompact)) return e;
  }

  let best: EngramListEntry | null = null;
  let bestScore = FUZZY_THRESHOLD;
  for (const e of engramList) {
    const scoreG = scoreEngramMatch(trimmed, e.graphId);
    const scoreD = scoreEngramMatch(trimmed, e.displayName);
    const score = Math.max(scoreG, scoreD);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

const ENGRAM_PREP_RE = /^(?:in|to|into|în|in)\s+(?:(?:my|the|meu|mea|lui|ei|un|o)\s+)?/i;

/**
 * Parse "in/to ENGRAM that CONTENT" (or : / că / – delimiters).
 * Returns null when the pattern does not match.
 */
export function parseRememberInToPattern(afterVerb: string): { engram: string; content: string } | null {
  const rest = afterVerb.trim();
  const prep = rest.match(ENGRAM_PREP_RE);
  if (!prep) return null;
  const body = rest.slice(prep[0].length).trim();
  if (!body) return null;

  for (const re of ENGRAM_CONTENT_SPLIT_RES) {
    const m = body.match(re);
    if (m?.index !== undefined && m.index > 0) {
      const engram = trimGreedyEngramHint(body.slice(0, m.index));
      const content = body.slice(m.index + m[0].length).trim();
      if (engram && content.length >= 1) return { engram, content };
    }
  }
  return null;
}

/** Parse "CONTENT to/in ENGRAM" — engram at end. */
export function parseRememberContentFirstPattern(afterVerb: string): { engram: string; content: string } | null {
  const m = afterVerb.trim().match(
    /^(.+?)\s+(?:to|in|into|în|in)\s+(?:(?:my|the|meu|mea)\s+)?["']?([^"'\n]+?)["']?\s*(?:engram)?$/i,
  );
  if (!m?.[1]?.trim() || !m[2]?.trim()) return null;
  return {
    content: m[1].trim(),
    engram: trimGreedyEngramHint(m[2].trim()),
  };
}

/** Split a remember intent engram hint — returns trimmed hint and optional trailing content recovered from greedy parse. */
export function splitGreedyRememberHint(
  engramHint: string | null,
  content: string,
): { engram: string | null; content: string } {
  if (!engramHint?.trim()) return { engram: null, content };
  const trimmed = trimGreedyEngramHint(engramHint);
  if (trimmed === engramHint.trim()) return { engram: trimmed || null, content };

  for (const re of ENGRAM_CONTENT_SPLIT_RES) {
    const m = engramHint.match(re);
    if (m?.index !== undefined && m.index > 0) {
      const engram = trimGreedyEngramHint(engramHint.slice(0, m.index));
      const recovered = engramHint.slice(m.index + m[0].length).trim();
      const mergedContent = recovered ? `${recovered} ${content}`.trim() : content;
      return { engram: engram || null, content: mergedContent };
    }
  }
  return { engram: trimmed || null, content };
}
