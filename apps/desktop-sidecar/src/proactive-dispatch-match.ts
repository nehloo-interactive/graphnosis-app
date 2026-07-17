/**
 * Lightweight skill-dispatch trigger matching for the proactive watcher.
 * Parses trained skill-dispatch routing lines and scores signal context
 * against Trigger → skill mappings — same rules agents use at session start,
 * without loading full skill step text.
 */

export interface DispatchTriggerMatch {
  skillSlug: string;
  triggerPhrase: string;
  score: number;
}

/** Parse `- Bug found → bug-investigation` style lines. */
export function parseDispatchTriggerLine(line: string): { triggerPhrase: string; skillSlug: string } | null {
  const trimmed = line.trim().replace(/^[-—]\s*/, '');
  const arrowIdx = trimmed.indexOf('→');
  if (arrowIdx <= 0) return null;
  const triggerPhrase = trimmed.slice(0, arrowIdx).trim();
  const rawSkill = trimmed.slice(arrowIdx + 1).trim();
  const skillSlug = rawSkill.split(/\s+/)[0]?.replace(/[.,;]+$/, '') ?? '';
  if (!triggerPhrase || !skillSlug) return null;
  return { triggerPhrase, skillSlug };
}

/** Function words that carry no routing signal — a query like
 * "What did we decide on the pricing tiers?" must not match a trigger like
 * "what's the priority" on "what"/"the" alone. Covers the languages we can
 * enumerate cheaply (EN, RO, ES, FR, DE); for everything else the IDF
 * downweighting in matchDispatchTriggers is the language-agnostic defense. */
const DISPATCH_STOPWORDS = new Set([
  // English
  'the', 'and', 'but', 'for', 'nor', 'not', 'you', 'your', 'yours', 'our', 'ours',
  'are', 'was', 'were', 'did', 'does', 'done', 'has', 'have', 'had', 'been', 'being',
  'what', 'whats', 'when', 'where', 'which', 'who', 'whom', 'why', 'how',
  'this', 'that', 'these', 'those', 'there', 'here',
  'with', 'from', 'into', 'onto', 'about', 'over', 'under', 'between',
  'all', 'any', 'also', 'just', 'now', 'then', 'than', 'too', 'very', 'some',
  'can', 'cant', 'could', 'should', 'would', 'will', 'wont', 'shall', 'may', 'might', 'must',
  'let', 'lets', 'its', 'out', 'own', 'per', 'via', 'get', 'got', 'one',
  'current', 'currently', 'right', 'most', 'more',
  // Romanian
  'din', 'care', 'este', 'sunt', 'fost', 'pentru', 'despre', 'unde', 'cand', 'când',
  'cum', 'cine', 'sau', 'dar', 'mai', 'cel', 'cea', 'cei', 'cele', 'ale', 'acest',
  'aceasta', 'această', 'asta', 'avem', 'aveți', 'aveti', 'ceva', 'după', 'dupa',
  // Spanish
  'que', 'qué', 'como', 'cómo', 'donde', 'dónde', 'cuando', 'cuándo', 'quien', 'quién',
  'los', 'las', 'una', 'uno', 'unos', 'unas', 'del', 'por', 'para', 'con', 'sobre',
  'este', 'esta', 'esto', 'estos', 'estas', 'son', 'está', 'esta', 'estamos', 'hay',
  'nosotros', 'ustedes', 'ellos', 'ellas', 'pero', 'porque', 'también', 'tambien',
  // French
  'qui', 'quoi', 'comment', 'où', 'quand', 'les', 'des', 'une', 'dans', 'pour',
  'avec', 'sur', 'est', 'sont', 'nous', 'vous', 'ils', 'elles', 'cette', 'ces',
  'quel', 'quelle', 'quels', 'quelles', 'mais', 'parce', 'aussi', 'très', 'tres',
  // German
  'was', 'wie', 'wer', 'wann', 'wem', 'wen', 'das', 'der', 'die', 'und', 'für',
  'fur', 'mit', 'auf', 'ist', 'sind', 'wir', 'ihr', 'sie', 'ein', 'eine', 'einen',
  'einem', 'einer', 'dem', 'den', 'des', 'über', 'uber', 'nicht', 'haben', 'hatte',
  'sollte', 'wurde', 'werden', 'kann', 'können', 'konnen', 'auch', 'noch', 'schon',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/.:,;()\[\]{}'"!?@#$%^&*+=<>\\|+]+/)
    .filter((w) => w.length >= 3 && !DISPATCH_STOPWORDS.has(w));
}

/**
 * Score context text against dispatch trigger lines.
 * Returns deduped matches sorted by score (highest first).
 */
export function matchDispatchTriggers(context: string, triggerLines: string[]): DispatchTriggerMatch[] {
  const contextLower = context.toLowerCase();
  const contextTokens = new Set(tokenize(context));
  const matches: DispatchTriggerMatch[] = [];

  const parsedLines = triggerLines
    .map((line) => parseDispatchTriggerLine(line))
    .filter((p): p is NonNullable<typeof p> => p !== null);

  // Language-agnostic downweighting: a token that recurs across a large share
  // of trigger lines ("what", "ce", "qué", "何") is dispatch-table glue, not a
  // routing signal — the stopword list can't enumerate every language, this
  // catches the rest. Only meaningful with enough lines to estimate frequency.
  const df = new Map<string, number>();
  for (const p of parsedLines) {
    for (const t of new Set(tokenize(p.triggerPhrase))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const lineCount = parsedLines.length;
  const isLowSignal = (t: string): boolean =>
    lineCount >= 4 && (df.get(t) ?? 0) / lineCount >= 0.4;

  for (const { triggerPhrase, skillSlug } of parsedLines) {
    const phraseLower = triggerPhrase.toLowerCase();

    let score = 0;
    if (contextLower.includes(phraseLower)) score += 10;

    for (const alt of phraseLower.split(/\s+\/\s+|\s+or\s+/)) {
      const trimmed = alt.trim();
      if (trimmed && contextLower.includes(trimmed)) score += 6;
    }

    for (const pt of new Set(tokenize(triggerPhrase))) {
      if (isLowSignal(pt)) {
        if (contextTokens.has(pt)) score += 1;
        continue;
      }
      if (contextTokens.has(pt)) score += 3;
      for (const ct of contextTokens) {
        if (ct.startsWith(pt) || pt.startsWith(ct)) score += 1;
      }
    }

    if (score >= 3) matches.push({ skillSlug, triggerPhrase, score });
  }

  const bySlug = new Map<string, DispatchTriggerMatch>();
  for (const m of matches) {
    const prev = bySlug.get(m.skillSlug);
    if (!prev || m.score > prev.score) bySlug.set(m.skillSlug, m);
  }
  return Array.from(bySlug.values()).sort((a, b) => b.score - a.score);
}
