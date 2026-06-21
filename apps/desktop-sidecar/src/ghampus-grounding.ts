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
- If context does not answer the question, say what is missing and suggest saving notes or a more specific recall/search — do NOT invent dates, milestones, features, URLs, or setup steps.
- "Obsidian Vault" may be an engram name in the user's cortex — do NOT conflate it with the Obsidian note-taking app or its web interface unless recall data explicitly describes that product.
- Mention Graphnosis features (federation, secure-sync, MCP, desktop app, mobile, etc.) ONLY when those terms appear in the recall context below.
- Never cite "official documentation", external URLs, or product roadmaps unless they appear verbatim in recall context.`;

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

  return { likely: reasons.length > 0, reasons };
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
