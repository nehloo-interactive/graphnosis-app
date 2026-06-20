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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/.:,;()\[\]{}'"!?@#$%^&*+=<>\\|+]+/)
    .filter((w) => w.length >= 3);
}

/**
 * Score context text against dispatch trigger lines.
 * Returns deduped matches sorted by score (highest first).
 */
export function matchDispatchTriggers(context: string, triggerLines: string[]): DispatchTriggerMatch[] {
  const contextLower = context.toLowerCase();
  const contextTokens = new Set(tokenize(context));
  const matches: DispatchTriggerMatch[] = [];

  for (const line of triggerLines) {
    const parsed = parseDispatchTriggerLine(line);
    if (!parsed) continue;
    const { triggerPhrase, skillSlug } = parsed;
    const phraseLower = triggerPhrase.toLowerCase();

    let score = 0;
    if (contextLower.includes(phraseLower)) score += 10;

    for (const alt of phraseLower.split(/\s+\/\s+|\s+or\s+/)) {
      const trimmed = alt.trim();
      if (trimmed && contextLower.includes(trimmed)) score += 6;
    }

    for (const pt of tokenize(triggerPhrase)) {
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
