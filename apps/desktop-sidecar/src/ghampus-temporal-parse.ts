/**
 * Heuristic due-date extraction from todo / obligation text (EN + RO).
 * No cloud LLM — regex + calendar math only.
 */

import type { ObligationWriteInput } from './obligation-index.js';

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

  const weekdayDueRe = new RegExp(
    `\\b(?:due|deadline|by|before|termen|scadent|p(?:â|a)n(?:ă|a)\\s+(?:pe|la))\\s*(${WEEKDAY_NAMES})\\b`,
    'i',
  );
  const weekdayDue = text.match(weekdayDueRe);
  if (weekdayDue) {
    const idx = weekdayIndex(weekdayDue[1]!);
    if (idx !== undefined) {
      const base = upcomingWeekday(idx, now);
      const withClock = applyClock(base, text);
      return { expiresAt: withClock.date.getTime(), hasTime: withClock.hasTime };
    }
  }

  const hasTemporalCue = /\b(?:due|deadline|renewal?|review|termen|scadent|todo|task|overdue)\b/i.test(text)
    || lineLooksTemporalTodo(text);

  if (hasTemporalCue) {
    const monthFirst = text.match(
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ian(?:uarie)?|feb(?:ruarie)?|mar(?:tie)?|apr(?:ilie)?|mai|iun(?:ie)?|iul(?:ie)?|aug(?:ust)?|sep(?:tembrie)?|oct(?:ombrie)?|noi(?:embrie)?|dec(?:embrie)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i,
    );
    if (monthFirst) {
      const month = monthFromToken(monthFirst[1]!);
      const day = parseInt(monthFirst[2]!, 10);
      if (month !== undefined && day >= 1 && day <= 31) {
        const base = new Date(resolveYear(month, day, now), month, day);
        const withClock = applyClock(base, text);
        return { expiresAt: withClock.date.getTime(), hasTime: withClock.hasTime };
      }
    }

    const dayFirst = text.match(
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ian(?:uarie)?|feb(?:ruarie)?|mar(?:tie)?|apr(?:ilie)?|mai|iun(?:ie)?|iul(?:ie)?|aug(?:ust)?|sep(?:tembrie)?|oct(?:ombrie)?|noi(?:embrie)?|dec(?:embrie)?)\b/i,
    );
    if (dayFirst) {
      const day = parseInt(dayFirst[1]!, 10);
      const month = monthFromToken(dayFirst[2]!);
      if (month !== undefined && day >= 1 && day <= 31) {
        const base = new Date(resolveYear(month, day, now), month, day);
        const withClock = applyClock(base, text);
        return { expiresAt: withClock.date.getTime(), hasTime: withClock.hasTime };
      }
    }
  }

  return null;
}

function inferObligationType(text: string): ObligationWriteInput['obligationType'] {
  const lower = text.toLowerCase();
  if (/\b(review|revis|verific)\b/i.test(lower)) return 'review-by';
  if (/\b(renew|reînno)/i.test(lower)) return 'renewal';
  return 'deadline';
}

/**
 * Deterministic obligation metadata from memory text when the client did not
 * pass `obligation`. Idempotent — returns undefined when no high-confidence date.
 */
export function inferObligationFromText(
  text: string,
  now = new Date(),
): ObligationWriteInput | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const candidates = [
    trimmed,
    ...trimmed.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && lineLooksTemporalTodo(l)),
  ];
  const seen = new Set<string>();
  for (const line of candidates) {
    if (seen.has(line)) continue;
    seen.add(line);
    const due = extractDueDateFromLine(line, now);
    if (!due) continue;
    return { obligationType: inferObligationType(line), expiresAt: due.expiresAt };
  }
  return undefined;
}

/** Resolved calendar window for a relative temporal phrase in memory text. */
export interface ParsedTemporalContext {
  /** Original matched phrase (lowercase). */
  phrase: string;
  /** Inclusive local-date range or single day. */
  start: Date;
  end: Date;
  kind: 'point' | 'range';
}

export interface AugmentMemoryResult {
  text: string;
  augmented: boolean;
  contexts: ParsedTemporalContext[];
}

const CALENDAR_TAG_RE = /\[calendar:\s/i;

const WEEKDAY_NAMES =
  'sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thurs|friday|fri|saturday|sat'
  + '|duminic[aă]|dum|luni|mar[tț]i|miercuri|mie|joi|vineri|vin|s[aâ]mb[aă]t[aă]|sam';

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0, sun: 0, duminica: 0, duminică: 0, dum: 0,
  monday: 1, mon: 1, luni: 1,
  tuesday: 2, tue: 2, tues: 2, marti: 2, marți: 2, mar: 2,
  wednesday: 3, wed: 3, miercuri: 3, mie: 3,
  thursday: 4, thu: 4, thurs: 4, joi: 4,
  friday: 5, fri: 5, vineri: 5, vin: 5,
  saturday: 6, sat: 6, sambata: 6, sâmbătă: 6, sam: 6,
};

function formatIsoLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function endOfLocalMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/** Monday-start week (ISO/EU convention; sidecar uses the host's local timezone). */
function thisWeekRange(now: Date): { start: Date; end: Date } {
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addLocalDays(startOfLocalDay(now), mondayOffset);
  return { start, end: addLocalDays(start, 6) };
}

function nextWeekRange(now: Date): { start: Date; end: Date } {
  const tw = thisWeekRange(now);
  return { start: addLocalDays(tw.start, 7), end: addLocalDays(tw.end, 7) };
}

function thisWeekendRange(now: Date): { start: Date; end: Date } {
  const day = now.getDay();
  let saturdayOffset: number;
  if (day === 0) saturdayOffset = -1;
  else if (day === 6) saturdayOffset = 0;
  else saturdayOffset = 6 - day;
  const start = addLocalDays(startOfLocalDay(now), saturdayOffset);
  return { start, end: addLocalDays(start, 1) };
}

function nextWeekendRange(now: Date): { start: Date; end: Date } {
  const tw = thisWeekendRange(now);
  return { start: addLocalDays(tw.start, 7), end: addLocalDays(tw.end, 7) };
}

function thisMonthRange(now: Date): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { start, end: endOfLocalMonth(now) };
}

function nextMonthRange(now: Date): { start: Date; end: Date } {
  const start = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { start, end: endOfLocalMonth(start) };
}

function weekdayIndex(token: string): number | undefined {
  const key = token.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return WEEKDAY_INDEX[key] ?? WEEKDAY_INDEX[token.toLowerCase()];
}

function weekdayInIsoWeek(weekday: number, now: Date, weekOffset: 0 | 1): Date {
  const range = weekOffset === 0 ? thisWeekRange(now) : nextWeekRange(now);
  const offset = weekday === 0 ? 6 : weekday - 1;
  return addLocalDays(range.start, offset);
}

function upcomingWeekday(weekday: number, now: Date): Date {
  const today = startOfLocalDay(now);
  let diff = weekday - today.getDay();
  if (diff < 0) diff += 7;
  return addLocalDays(today, diff);
}

function foldForMatch(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function formatCalendarTag(ctx: ParsedTemporalContext): string {
  const startIso = formatIsoLocalDate(ctx.start);
  const endIso = formatIsoLocalDate(ctx.end);
  const range = startIso === endIso ? startIso : `${startIso} — ${endIso}`;
  return `[calendar: ${range} (${ctx.phrase})]`;
}

/**
 * Detect relative calendar phrases and append searchable ISO date tags.
 * Uses the machine's local timezone (sidecar runs locally on the user's device).
 */
export function extractTemporalContexts(text: string, now = new Date()): ParsedTemporalContext[] {
  const lower = text.toLowerCase();
  const folded = foldForMatch(text);
  const found: ParsedTemporalContext[] = [];
  const seen = new Set<string>();

  const push = (ctx: ParsedTemporalContext) => {
    const key = `${ctx.phrase}|${formatIsoLocalDate(ctx.start)}|${formatIsoLocalDate(ctx.end)}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(ctx);
  };

  const pushPoint = (phrase: string, day: Date) => {
    const d = startOfLocalDay(day);
    push({ phrase, start: d, end: d, kind: 'point' });
  };

  const pushRange = (phrase: string, start: Date, end: Date) => {
    push({ phrase, start: startOfLocalDay(start), end: startOfLocalDay(end), kind: 'range' });
  };

  const weekdayRe = new RegExp(
    `\\b(?:this|next)\\s+(${WEEKDAY_NAMES})\\b`
    + `|(?:^|\\s)(${WEEKDAY_NAMES})\\s+(?:viitoare?|next|urmatoare?)\\b`
    + `|(?:^|\\s)(${WEEKDAY_NAMES})\\s+(?:aceasta|this|asta)\\b`,
    'gi',
  );
  for (const m of lower.matchAll(weekdayRe)) {
    const token = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    const idx = weekdayIndex(token);
    if (idx === undefined) continue;
    const full = m[0]!;
    const isNext = /\bnext\b/.test(full) || /\bviitoare?\b/.test(full) || /\burmatoare?\b/.test(foldForMatch(full));
    const day = isNext ? weekdayInIsoWeek(idx, now, 1) : weekdayInIsoWeek(idx, now, 0);
    pushPoint(full.trim(), day);
  }

  const bareWeekdayRe = new RegExp(`(?:^|\\s|\\b)(${WEEKDAY_NAMES})(?=\\s|$|[,.!?;:])`, 'gi');
  for (const m of lower.matchAll(bareWeekdayRe)) {
    const token = m[1]!.trim();
    const idx = weekdayIndex(token);
    if (idx === undefined) continue;
    const start = m.index ?? 0;
    const before = lower.slice(Math.max(0, start - 12), start);
    const after = lower.slice(start + m[0]!.length, start + m[0]!.length + 12);
    if (/\b(?:this|next|aceast|viitor|viitoare|urm[aă]toare)\s*$/.test(before)) continue;
    if (/^\s*(?:viitoare?|aceast[aă]|next|this|asta)\b/.test(after)) continue;
    pushPoint(token, upcomingWeekday(idx, now));
  }

  if (/\b(?:this|next)\s+week\b/.test(lower)
    || /(?:^|\s)in aceasta saptamana(?:\s|$|[,.!?;:])/.test(folded)
    || /(?:^|\s)saptamana aceasta(?:\s|$|[,.!?;:])/.test(folded)) {
    const next = /\bnext\s+week\b/.test(lower) || /(?:^|\s)saptamana viitoare(?:\s|$|[,.!?;:])/.test(folded);
    const r = next ? nextWeekRange(now) : thisWeekRange(now);
    pushRange(next ? 'next week' : 'this week', r.start, r.end);
  } else if (/(?:^|\s)saptamana viitoare(?:\s|$|[,.!?;:])/.test(folded)) {
    const r = nextWeekRange(now);
    pushRange('săptămâna viitoare', r.start, r.end);
  }

  if (/\bthis\s+weekend\b/.test(lower)
    || /(?:^|\s)weekend(?:-ul)?\s+(?:aceasta|acesta|asta)(?:\s|$|[,.!?;:])/.test(folded)
    || /(?:^|\s)acest weekend(?:\s|$|[,.!?;:])/.test(folded)) {
    const r = thisWeekendRange(now);
    pushRange('this weekend', r.start, r.end);
  } else if (/\bnext\s+weekend\b/.test(lower) || /(?:^|\s)weekend(?:-ul)?\s+viitor(?:\s|$|[,.!?;:])/.test(folded)) {
    const r = nextWeekendRange(now);
    pushRange('next weekend', r.start, r.end);
  }

  if (/\bthis\s+month\b/.test(lower) || /(?:^|\s)luna aceasta(?:\s|$|[,.!?;:])/.test(folded) || /(?:^|\s)luna asta(?:\s|$|[,.!?;:])/.test(folded)) {
    const r = thisMonthRange(now);
    pushRange('this month', r.start, r.end);
  } else if (/\bnext\s+month\b/.test(lower) || /(?:^|\s)luna viitoare(?:\s|$|[,.!?;:])/.test(folded)) {
    const r = nextMonthRange(now);
    pushRange('next month', r.start, r.end);
  }

  if (/\b(?:end\s+of\s+(?:the\s+)?month)\b/.test(lower) || /(?:^|\s)sfarsitul lunii(?:\s|$|[,.!?;:])/.test(folded)) {
    const end = endOfLocalMonth(now);
    pushPoint('end of month', end);
  }

  if (/\btomorrow\b/.test(lower) || /(?:^|\s)maine(?:\s|$|[,.!?;:])/.test(folded)) {
    pushPoint('tomorrow', addLocalDays(startOfLocalDay(now), 1));
  }

  if (/\btoday\b/.test(lower) || /(?:^|\s)astazi(?:\s|$|[,.!?;:])/.test(folded)) {
    pushPoint('today', startOfLocalDay(now));
  }

  return found;
}

/**
 * Append `[calendar: …]` tags for relative temporal phrases so recall can match ISO dates.
 * Non-temporal text is returned unchanged.
 */
export function augmentMemoryWithTemporalContext(
  text: string,
  referenceDate?: Date,
): AugmentMemoryResult {
  const trimmed = text.trim();
  if (!trimmed || CALENDAR_TAG_RE.test(trimmed)) {
    return { text, augmented: false, contexts: [] };
  }
  const now = referenceDate ?? new Date();
  const contexts = extractTemporalContexts(trimmed, now);
  if (contexts.length === 0) {
    return { text, augmented: false, contexts: [] };
  }
  const tags = contexts.map(formatCalendarTag).join('\n');
  return {
    text: `${trimmed}\n\n${tags}`,
    augmented: true,
    contexts,
  };
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
