/**
 * Heuristic due-date extraction from todo / obligation text (EN + RO).
 * No cloud LLM — regex + calendar math only.
 */

export interface ParsedDue {
  expiresAt: number;
  /** True when an explicit clock time was parsed (not midnight-only). */
  hasTime: boolean;
}

const RO_MONTHS: Record<string, number> = {
  ianuarie: 0, ian: 0,
  februarie: 1, feb: 1,
  martie: 2, mar: 2,
  aprilie: 3, apr: 3,
  mai: 4,
  iunie: 5, iun: 5,
  iulie: 6, iul: 6,
  august: 7, aug: 7,
  septembrie: 8, sep: 8, sept: 8,
  octombrie: 9, oct: 9,
  noiembrie: 10, noi: 10,
  decembrie: 11, dec: 11,
};

const EN_MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addLocalDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

function parseClock(text: string): { hour: number; minute: number } | null {
  const h24 = text.match(/\b(?:at|la|ora)?\s*(\d{1,2}):(\d{2})\b/i);
  if (h24) {
    const hour = parseInt(h24[1]!, 10);
    const minute = parseInt(h24[2]!, 10);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }
  const h12 = text.match(/\b(?:at|la)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (h12) {
    let hour = parseInt(h12[1]!, 10);
    const minute = h12[2] ? parseInt(h12[2], 10) : 0;
    const ampm = h12[3]!.toLowerCase();
    if (hour === 12) hour = 0;
    if (ampm === 'pm') hour += 12;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }
  return null;
}

function applyClock(base: Date, text: string): { date: Date; hasTime: boolean } {
  const clock = parseClock(text);
  if (!clock) return { date: base, hasTime: false };
  const out = new Date(base);
  out.setHours(clock.hour, clock.minute, 0, 0);
  return { date: out, hasTime: true };
}

function monthFromToken(token: string): number | undefined {
  const t = token.toLowerCase();
  return RO_MONTHS[t] ?? EN_MONTHS[t];
}

function resolveYear(month: number, day: number, now: Date): number {
  let year = now.getFullYear();
  const candidate = new Date(year, month, day);
  if (candidate.getTime() < startOfLocalDay(now).getTime() - 24 * 60 * 60 * 1000) {
    year += 1;
  }
  return year;
}

/** Extract a due instant from a single line of memory text. */
export function extractDueDateFromLine(line: string, now = new Date()): ParsedDue | null {
  const text = line.trim();
  if (!text) return null;

  const lower = text.toLowerCase();

  // ISO: 2026-06-21 or 2026-06-21T14:30 / 2026-06-21 14:30
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?\b/);
  if (iso) {
    const y = parseInt(iso[1]!, 10);
    const mo = parseInt(iso[2]!, 10) - 1;
    const d = parseInt(iso[3]!, 10);
    const base = new Date(y, mo, d);
    if (iso[4] !== undefined) {
      base.setHours(parseInt(iso[4], 10), parseInt(iso[5]!, 10), 0, 0);
      return { expiresAt: base.getTime(), hasTime: true };
    }
    const withClock = applyClock(base, text);
    return { expiresAt: withClock.date.getTime(), hasTime: withClock.hasTime };
  }

  // Relative: today / tomorrow / mâine / astăzi
  const relDay =
    /\b(?:due|deadline|termen|scadent|p(?:â|a)n(?:ă|a)\s+(?:pe|la))?\s*(?:today|ast[aă]zi)\b/i.test(lower)
      ? 0
      : /\b(?:due|deadline|termen|scadent|p(?:â|a)n(?:ă|a)\s+(?:pe|la))?\s*(?:tomorrow|m(?:â|a)ine)\b/i.test(lower)
        ? 1
        : null;
  if (relDay !== null) {
    const base = addLocalDays(startOfLocalDay(now), relDay);
    const withClock = applyClock(base, text);
    return { expiresAt: withClock.date.getTime(), hasTime: withClock.hasTime };
  }

  // Named month: "due March 15", "termen 21 iunie", "deadline: 3 mai"
  const namedEn = text.match(
    /\b(?:due|deadline|by|before|termen|scadent|p(?:â|a)n(?:ă|a)\s+(?:pe|la))[\s:–-]*(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i,
  );
  if (namedEn) {
    const day = parseInt(namedEn[1]!, 10);
    const month = monthFromToken(namedEn[2]!);
    if (month !== undefined && day >= 1 && day <= 31) {
      const base = new Date(resolveYear(month, day, now), month, day);
      const withClock = applyClock(base, text);
      return { expiresAt: withClock.date.getTime(), hasTime: withClock.hasTime };
    }
  }

  const namedRo = text.match(
    /\b(?:due|deadline|termen|scadent|p(?:â|a)n(?:ă|a)\s+(?:pe|la))[\s:–-]*(\d{1,2})\s+(ian(?:uarie)?|feb(?:ruarie)?|mar(?:tie)?|apr(?:ilie)?|mai|iun(?:ie)?|iul(?:ie)?|aug(?:ust)?|sep(?:tembrie)?|oct(?:ombrie)?|noi(?:embrie)?|dec(?:embrie)?)\b/i,
  );
  if (namedRo) {
    const day = parseInt(namedRo[1]!, 10);
    const month = monthFromToken(namedRo[2]!);
    if (month !== undefined && day >= 1 && day <= 31) {
      const base = new Date(resolveYear(month, day, now), month, day);
      const withClock = applyClock(base, text);
      return { expiresAt: withClock.date.getTime(), hasTime: withClock.hasTime };
    }
  }

  // Numeric: 6/21, 21.06, 21/06/2026
  const slash = text.match(/\b(?:due|deadline|termen|scadent|by)?[\s:–-]*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i);
  if (slash) {
    const a = parseInt(slash[1]!, 10);
    const b = parseInt(slash[2]!, 10);
    let month: number;
    let day: number;
    if (a > 12) { day = a; month = b - 1; } else { month = a - 1; day = b; }
    let year = slash[3]
      ? (slash[3].length === 2 ? 2000 + parseInt(slash[3], 10) : parseInt(slash[3], 10))
      : resolveYear(month, day, now);
    const base = new Date(year, month, day);
    const withClock = applyClock(base, text);
    return { expiresAt: withClock.date.getTime(), hasTime: withClock.hasTime };
  }

  const dot = text.match(/\b(?:due|deadline|termen|scadent|by)?[\s:–-]*(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b/);
  if (dot) {
    const day = parseInt(dot[1]!, 10);
    const month = parseInt(dot[2]!, 10) - 1;
    const year = dot[3]
      ? (dot[3].length === 2 ? 2000 + parseInt(dot[3], 10) : parseInt(dot[3], 10))
      : resolveYear(month, day, now);
    const base = new Date(year, month, day);
    const withClock = applyClock(base, text);
    return { expiresAt: withClock.date.getTime(), hasTime: withClock.hasTime };
  }

  return null;
}

/** True when the line looks like a todo / task with possible temporal data. */
export function lineLooksTemporalTodo(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^[-*•]\s*\[[ xX]\]/.test(t)) return true;
  if (/\bTODO\b/i.test(t)) return true;
  if (/\b(?:due|deadline|termen|scadent|overdue|mâine|maine|tomorrow|today|astăzi|astazi)\b/i.test(t)) {
    return true;
  }
  return /^[-*•]\s/.test(t)
    && /\b(?:task|todo|sarcin|lucru|fix|ship|review|draft)\b/i.test(t);
}
