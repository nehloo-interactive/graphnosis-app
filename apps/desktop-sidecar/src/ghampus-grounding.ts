/**
 * Grounding helpers — detect LLM synthesis hallucination beyond recall context.
 */

const MONTH_DATE_RE =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+(20\d{2})\b/gi;
const ISO_DATE_RE = /\b(20\d{2})-\d{2}-\d{2}\b/g;
const SLASH_DATE_RE = /\b\d{1,2}\/\d{1,2}\/(20\d{2})\b/g;
const YEAR_ONLY_RE = /\b(20\d{2})\b/g;
const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.+]+)?\b/gi;

const PRODUCT_TERM_RE =
  /\b(?:federation|secure-sync|secure sync|MCP|sidecar|engram|cortex|Graphnosis|Tauri|desktop app|mobile app|Obsidian Vault|Memory Studio|Ghampus)\b/gi;

/** Shared grounding rules for synthesis, polish, and verify prompts. */
export const GHAMPUS_GROUNDING_RULES_BLOCK = `
STRICT GROUNDING — recall context is the only source of truth:
- State ONLY facts explicitly present in ## Recall results, ## Recall hits, ## Additional context, or other <cortex_data> sections.
- If context does not answer the question, say what is missing and suggest saving notes or a more specific recall/search — do NOT invent dates, milestones, features, URLs, setup steps, or English translations of titles.
- When recall is thin, say honestly what is missing — never pad with guessed translations or invented book/work titles.
- "Obsidian Vault" may be an engram name in the user's cortex — do NOT conflate it with the Obsidian note-taking app or its web interface unless recall data explicitly describes that product.
- Mention Graphnosis features (federation, secure-sync, MCP, desktop app, mobile, etc.) ONLY when those terms appear in the recall context below.
- Never cite "official documentation", external URLs, or product roadmaps unless they appear verbatim in recall context.
- Do NOT invent English titles for non-English book or work names — quote titles exactly as stored; if uncertain, use the original-language title without guessing.
- Preserve person names exactly as in recall — never merge spellings or blend OCR-corrupted variants.`;

export type ContextAnchors = {
  dates: Set<string>;
  years: Set<number>;
  versions: Set<string>;
  productTerms: Set<string>;
};

function normalizeToken(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function collectDates(text: string, dates: Set<string>, years: Set<number>): void {
  for (const re of [MONTH_DATE_RE, ISO_DATE_RE, SLASH_DATE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      dates.add(normalizeToken(m[0]));
      const yearStr = m[1] ?? m[0].match(/20\d{2}/)?.[0];
      if (yearStr) years.add(parseInt(yearStr, 10));
    }
  }
  YEAR_ONLY_RE.lastIndex = 0;
  let ym: RegExpExecArray | null;
  while ((ym = YEAR_ONLY_RE.exec(text)) !== null) {
    years.add(parseInt(ym[1]!, 10));
  }
}

/** Extract dates, versions, and product terms anchored in recall context. */
export function extractContextAnchors(recallContext: string): ContextAnchors {
  const dates = new Set<string>();
  const years = new Set<number>();
  const versions = new Set<string>();
  const productTerms = new Set<string>();
  const ctx = recallContext ?? '';

  collectDates(ctx, dates, years);

  VERSION_RE.lastIndex = 0;
  let vm: RegExpExecArray | null;
  while ((vm = VERSION_RE.exec(ctx)) !== null) {
    versions.add(normalizeToken(vm[0]));
  }

  PRODUCT_TERM_RE.lastIndex = 0;
  let pm: RegExpExecArray | null;
  while ((pm = PRODUCT_TERM_RE.exec(ctx)) !== null) {
    productTerms.add(normalizeToken(pm[0]));
  }

  return { dates, years, versions, productTerms };
}

export type HallucinationSignal = {
  likely: boolean;
  reasons: string[];
};

const HALLUCINATION_HEURISTICS: RegExp[] = [
  /\bmilestones?\s+like\b/i,
  /\bunlocking milestone\b/i,
  /\bcortex unlocking\b/i,
  /\brefer to (?:the )?official documentation\b/i,
  /\bcheck (?:the )?official docs\b/i,
  /\bas documented (?:on|in|at)\b/i,
  /\b(?:see|visit|go to)\s+https?:\/\//i,
  /\bknowledge cutoff\b/i,
  /\bmy training (?:data )?(?:only )?(?:goes|extends|ends)\b/i,
  /\b(?:as of|until) my (?:last )?(?:knowledge|training)\b/i,
  /\bi(?:'m| am) (?:sorry|unable to find).{0,80}(?:cutoff|don't have access|outside my)\b/i,
  /\bunpublished(?:romania| connect)? team\b/i,
];

const OBSIDIAN_APP_PATTERNS = [
  /\bObsidian(?:\.md)?(?:\s+(?:app|application|web interface|sync|plugin|vault UI|web))\b/i,
  /\bObsidian(?:'s)?\s+web\b/i,
  /\bObsidian(?:'s)?\s+(?:Sync|Publish)\b/i,
];

const GRAPHNOSIS_MOBILE_PATTERNS = [
  /\b(?:Graphnosis|Ghampus)\s+(?:mobile|iOS|Android|App Store|Play Store)\b/i,
  /\b(?:install|download)\s+(?:the\s+)?Graphnosis\s+app\s+on\s+(?:your\s+)?(?:phone|iOS|Android)\b/i,
];

function extractAnswerDates(answer: string): string[] {
  const found: string[] = [];
  for (const re of [MONTH_DATE_RE, ISO_DATE_RE, SLASH_DATE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(answer)) !== null) {
      found.push(normalizeToken(m[0]));
    }
  }
  return found;
}

function dateAppearsInContext(dateToken: string, anchors: ContextAnchors): boolean {
  if (anchors.dates.has(dateToken)) return true;
  return [...anchors.dates].some((d) => d.includes(dateToken) || dateToken.includes(d));
}

function hasObsidianVaultInContext(ctx: string): boolean {
  return /Obsidian Vault/i.test(ctx);
}

function mentionsObsidianAppNotEngram(answer: string, ctx: string): boolean {
  if (!hasObsidianVaultInContext(ctx)) return false;
  return OBSIDIAN_APP_PATTERNS.some((re) => re.test(answer));
}

function mentionsUnsupportedMobileSteps(answer: string, ctx: string): boolean {
  if (/\b(?:mobile|ios|android|phone|app store|play store)\b/i.test(ctx)) return false;
  return GRAPHNOSIS_MOBILE_PATTERNS.some((re) => re.test(answer));
}

const PERSON_NAME_PAIR_RE =
  /\b([A-ZĂÂÎȘȚ][a-zăâîșț]+)\s+([A-ZĂÂÎȘȚ][a-zăâîșț]+)\b/g;

/** First token in a capitalized pair that is not a person name — skip false pairs like "Author Ungur". */
const NON_NAME_PAIR_PREFIX = new Set([
  'author', 'also', 'see', 'from', 'about', 'book', 'writer', 'the', 'his', 'her',
  'their', 'this', 'that', 'with', 'note', 'mentioned', 'found', 'recall',
]);

function extractPersonNamePairs(text: string): Array<{ first: string; last: string; full: string }> {
  const pairs: Array<{ first: string; last: string; full: string }> = [];
  for (const m of text.matchAll(PERSON_NAME_PAIR_RE)) {
    const firstRaw = m[1]!;
    const lastRaw = m[2]!;
    const first = firstRaw.toLowerCase();
    if (NON_NAME_PAIR_PREFIX.has(first)) {
      const retryFirst = lastRaw;
      const afterIdx = m.index! + m[0].length;
      const nextM = text.slice(afterIdx).match(/^\s+([A-ZĂÂÎȘȚ][a-zăâîșț]+)/);
      if (nextM && !NON_NAME_PAIR_PREFIX.has(retryFirst.toLowerCase())) {
        pairs.push({
          first: retryFirst.toLowerCase(),
          last: nextM[1]!.toLowerCase(),
          full: `${retryFirst} ${nextM[1]}`,
        });
      }
      continue;
    }
    pairs.push({ first, last: lastRaw.toLowerCase(), full: `${firstRaw} ${lastRaw}` });
  }
  return pairs;
}

/** Detect blended OCR name variants in the same answer (e.g. Sandu vs Sanduhonv). */
export function detectBlendedNameVariants(answer: string): string[] {
  const reasons: string[] = [];
  const byFirst = new Map<string, Set<string>>();

  for (const { first, last } of extractPersonNamePairs(answer)) {
    const set = byFirst.get(first) ?? new Set<string>();
    set.add(last);
    byFirst.set(first, set);
  }

  for (const [first, lasts] of byFirst) {
    if (lasts.size < 2) continue;
    const variants = [...lasts];
    for (let i = 0; i < variants.length; i++) {
      for (let j = i + 1; j < variants.length; j++) {
        const a = variants[i]!;
        const b = variants[j]!;
        if (a.startsWith(b) || b.startsWith(a)) {
          reasons.push(`Blended name variants for "${first}": "${a}" and "${b}"`);
        }
      }
    }
  }

  return reasons;
}

/** Light heuristic: answer uses a corrupted name variant not present in recall context. */
export function detectLikelyNameCorruption(answer: string, context: string): HallucinationSignal {
  const reasons: string[] = [];
  const ctxLower = (context ?? '').toLowerCase();

  reasons.push(...detectBlendedNameVariants(answer));

  const seen = new Set<string>();
  for (const { first, last, full } of extractPersonNamePairs(answer)) {
    const key = full.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (ctxLower.includes(key)) continue;
    const ctxPairRe = new RegExp(
      `\\b${first.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s+([a-zăâîșț\\-]+)`,
      'gi',
    );
    ctxPairRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = ctxPairRe.exec(ctxLower)) !== null) {
      const ctxLast = cm[1]!.toLowerCase();
      if (ctxLast === last) continue;
      if (last.startsWith(ctxLast) && last.length > ctxLast.length + 2) {
        reasons.push(`Possible OCR name corruption: "${full}" vs recall "${first} ${ctxLast}"`);
        break;
      }
    }
  }

  return { likely: reasons.length > 0, reasons };
}

function answerHasUnsupportedFutureDates(answer: string, anchors: ContextAnchors): string[] {
  const reasons: string[] = [];
  const currentYear = new Date().getFullYear();

  for (const ad of extractAnswerDates(answer)) {
    if (!dateAppearsInContext(ad, anchors)) {
      const yearMatch = ad.match(/20\d{2}/);
      const year = yearMatch ? parseInt(yearMatch[0], 10) : null;
      if (year !== null && year >= currentYear) {
        reasons.push(`Future date not in recall context: ${ad}`);
      } else if (ad.length > 6) {
        reasons.push(`Date not in recall context: ${ad}`);
      }
    }
  }

  YEAR_ONLY_RE.lastIndex = 0;
  let ym: RegExpExecArray | null;
  while ((ym = YEAR_ONLY_RE.exec(answer)) !== null) {
    const year = parseInt(ym[1]!, 10);
    if (year >= currentYear && !anchors.years.has(year)) {
      const msg = `Future year ${year} not supported by recall context`;
      if (!reasons.some((r) => r.includes(String(year)))) reasons.push(msg);
    }
  }

  return reasons;
}

/** Heuristic check: answer cites facts, dates, or products not grounded in context. */
export function detectLikelyHallucination(answer: string, contextBlob: string): HallucinationSignal {
  const reasons: string[] = [];
  const ctx = contextBlob ?? '';
  const anchors = extractContextAnchors(ctx);

  for (const re of HALLUCINATION_HEURISTICS) {
    if (re.test(answer)) {
      reasons.push(`Unsupported phrasing: "${re.source.slice(0, 40)}"`);
    }
  }

  reasons.push(...answerHasUnsupportedFutureDates(answer, anchors));

  if (mentionsObsidianAppNotEngram(answer, ctx)) {
    reasons.push('Conflates engram name "Obsidian Vault" with the Obsidian app product');
  }

  if (mentionsUnsupportedMobileSteps(answer, ctx)) {
    reasons.push('Speculative mobile setup steps not present in recall context');
  }

  const nameCorruption = detectLikelyNameCorruption(answer, ctx);
  if (nameCorruption.likely) {
    reasons.push(...nameCorruption.reasons.slice(0, 2));
  }

  return { likely: reasons.length > 0, reasons };
}

export type GhampusBrevityOpts = {
  expanded?: boolean;
  simplePersonLookup?: boolean;
  howTo?: boolean;
};

/** Shared brevity rules for synthesis, polish, and verify prompts. */
export function buildGhampusBrevityRulesBlock(opts: GhampusBrevityOpts): string {
  if (opts.expanded) {
    return `DETAIL MODE: The user asked for expanded detail — you may use multiple paragraphs, bullets, or section headers when helpful.`;
  }

  const personHint = opts.simplePersonLookup
    ? '- Simple person/role lookup — one clear sentence naming the person and their role/context is enough.\n'
    : '';
  const lengthHint = opts.howTo
    ? '- How-to/setup: concise numbered steps or bullets (max 6) — still no recall metadata headers.\n'
    : '- Simple who/what/which questions: 1-3 sentences max.\n';

  return `BREVITY (default):
${lengthHint}${personHint}- No section headers (##, ###) unless the user asked for a list or grouped format.
- Do NOT repeat recall metadata, process narration, or echo <cortex_data> structure in the answer.
- Lead with the direct answer — no preamble like "Based on your memory" or "Here's what I found".`;
}

/** Prompt block when recall returned very little attested context. */
export function buildThinRecallGroundingBlock(): string {
  return `THIN RECALL WARNING: Your memory search found little on this topic — do NOT invent setup steps, product features, URLs, dates, or milestones. Say honestly what is missing from memory and suggest the user save notes or try a more specific recall/search query.`;
}

/** Whether structured recall + dig_deeper still returned sparse context. */
export function isThinRecallContext(
  structuredNodeCount: number,
  hasDeeperContext: boolean,
): boolean {
  return structuredNodeCount < 3 && !hasDeeperContext;
}

export function formatGroundingVerifyFeedback(reasons: string[]): string {
  const detail = reasons.slice(0, 2).join('; ');
  return `Remove anything not supported by the recall context below.${detail ? ` Issues: ${detail}.` : ''}`;
}
