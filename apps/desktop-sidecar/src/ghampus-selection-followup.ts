/**
 * Ghampus selection follow-up — context builder for questions about a highlighted passage.
 */
import { z } from 'zod';
import { GHAMPUS_FIRST_PERSON_SELF_RULE } from './ghampus-glossary.js';
import { buildResponseLanguageRulesBlock } from './ghampus-language.js';

export const ghampusSelectionContextSchema = z.object({
  selectedText: z.string().min(1),
  parentAnswerText: z.string().min(1),
  parentTs: z.number().int().positive(),
  parentTurnId: z.string().optional(),
});

export type GhampusSelectionContext = z.infer<typeof ghampusSelectionContextSchema>;

export const ghampusFragmentCommentSchema = z.object({
  messageId: z.string().min(1),
  quotedText: z.string().min(1),
  userComment: z.string().min(1),
  contextBefore: z.string().optional(),
  contextAfter: z.string().optional(),
  /** Character offset of the highlight in the parent answer plain text — disambiguates duplicate phrases. */
  quoteStartOffset: z.number().int().nonnegative().optional(),
  /** Full parent Ghampus answer the highlight came from. */
  parentAnswerText: z.string().optional(),
});

export type GhampusFragmentComment = z.infer<typeof ghampusFragmentCommentSchema>;

export const ghampusFragmentReviewPayloadSchema = z.object({
  type: z.literal('fragment_review'),
  comments: z.array(ghampusFragmentCommentSchema).min(1),
});

export type GhampusFragmentReviewPayload = z.infer<typeof ghampusFragmentReviewPayloadSchema>;

export type GhampusHistLine = {
  kind?: string;
  text?: string;
  ts?: number;
  turnId?: string;
  selectionContext?: {
    selectedText?: string;
    parentAnswerText?: string;
    parentTs?: number;
    parentTurnId?: string;
  };
  fragmentReview?: GhampusFragmentReviewPayload;
};

export function parseGhampusSendPayload(params: unknown): {
  text: string;
  turnId?: string;
  selectionContext?: GhampusSelectionContext;
  fragmentReview?: GhampusFragmentReviewPayload;
} {
  const parsed = z.object({
    text: z.string(),
    turnId: z.string().optional(),
    selectionContext: ghampusSelectionContextSchema.optional(),
    fragmentReview: ghampusFragmentReviewPayloadSchema.optional(),
  }).parse(params ?? {});
  return {
    text: parsed.text,
    ...(parsed.turnId !== undefined ? { turnId: parsed.turnId } : {}),
    ...(parsed.selectionContext !== undefined ? { selectionContext: parsed.selectionContext } : {}),
    ...(parsed.fragmentReview !== undefined ? { fragmentReview: parsed.fragmentReview } : {}),
  };
}

export type FragmentQuoteLocateOpts = {
  startOffset?: number;
  contextBefore?: string;
  contextAfter?: string;
};

const FRAGMENT_CONTEXT_WINDOW = 48;

/** Resolve which occurrence of `quoted` the user highlighted when the phrase repeats. */
export function findFragmentQuoteOffset(
  fullText: string,
  quoted: string,
  opts: FragmentQuoteLocateOpts = {},
): number {
  if (!quoted) return -1;

  const candidates: number[] = [];
  let scan = 0;
  while (scan <= fullText.length) {
    const idx = fullText.indexOf(quoted, scan);
    if (idx < 0) break;
    candidates.push(idx);
    scan = idx + Math.max(1, quoted.length);
  }
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0]!;

  if (opts.startOffset != null && opts.startOffset >= 0) {
    const exact = candidates.find((pos) => pos === opts.startOffset);
    if (exact != null && fullText.slice(exact, exact + quoted.length) === quoted) {
      return exact;
    }
    let closest = candidates[0]!;
    let minDist = Math.abs(candidates[0]! - opts.startOffset);
    for (const pos of candidates) {
      const d = Math.abs(pos - opts.startOffset);
      if (d < minDist) {
        minDist = d;
        closest = pos;
      }
    }
    if (minDist <= 64) return closest;
  }

  const before = opts.contextBefore ?? '';
  const after = opts.contextAfter ?? '';
  let best = candidates[0]!;
  let bestScore = -1;
  for (const pos of candidates) {
    let score = 0;
    const windowBefore = fullText.slice(Math.max(0, pos - FRAGMENT_CONTEXT_WINDOW), pos);
    const windowAfter = fullText.slice(pos + quoted.length, pos + quoted.length + FRAGMENT_CONTEXT_WINDOW);
    if (before) {
      if (windowBefore.endsWith(before)) score += 8;
      else if (before.length >= 12 && windowBefore.endsWith(before.slice(-12))) score += 5;
      else if (windowBefore.includes(before)) score += 2;
    }
    if (after) {
      if (windowAfter.startsWith(after)) score += 8;
      else if (after.length >= 12 && windowAfter.startsWith(after.slice(0, 12))) score += 5;
      else if (windowAfter.includes(after)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = pos;
    }
  }
  return best;
}

/** Tight adjacency context — disambiguates repeated phrases like "AI clients". */
export function extractFragmentQuoteContext(
  fullText: string,
  quoted: string,
  startOffset: number,
): Pick<FragmentQuoteLocateOpts, 'contextBefore' | 'contextAfter'> {
  const idx = findFragmentQuoteOffset(fullText, quoted, { startOffset });
  if (idx < 0) return {};
  const contextBefore = fullText.slice(Math.max(0, idx - FRAGMENT_CONTEXT_WINDOW), idx);
  const contextAfter = fullText.slice(idx + quoted.length, idx + quoted.length + FRAGMENT_CONTEXT_WINDOW);
  return {
    ...(contextBefore ? { contextBefore } : {}),
    ...(contextAfter ? { contextAfter } : {}),
  };
}

export function formatFragmentQuoteExcerpt(
  fullText: string,
  quoted: string,
  opts: FragmentQuoteLocateOpts = {},
): string {
  const idx = findFragmentQuoteOffset(fullText, quoted, opts);
  if (idx < 0) return `«${quoted.trim()}»`;
  const before = fullText.slice(Math.max(0, idx - 80), idx);
  const after = fullText.slice(idx + quoted.length, idx + quoted.length + 80);
  return `…${before}【${quoted.trim()}】${after}…`;
}

export function buildLightRecallQuery(selectedText: string, question: string): string {
  const snippet = selectedText.trim().slice(0, 120);
  const q = question.trim();
  if (!snippet) return q;
  if (!q) return snippet;
  return `${snippet} — ${q}`;
}

export function parseRecentGhampusHistLines(raw: string, limit = 8): GhampusHistLine[] {
  return raw.trim().split('\n').filter(Boolean).slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as GhampusHistLine;
      } catch {
        return null;
      }
    })
    .filter((t): t is GhampusHistLine => !!t && !!t.text);
}

/** Structured transcript block for conversation-context synthesis (this chat session). */
export function buildConversationContextBlock(messages: GhampusHistLine[], limit = 15): string {
  const formatted = formatRecentThreadHistory(messages, limit);
  if (!formatted.trim()) return '';
  return `## Conversation transcript (this Ghampus chat session)\n\n${formatted}`;
}

export function formatRecentThreadHistory(messages: GhampusHistLine[], limit = 8): string {
  const chat = messages.filter((m) =>
    (m.kind === 'user' || m.kind === 'ghampus') && (m.text ?? '').trim(),
  );
  const tail = chat.slice(-limit);
  return tail
    .map((m) => {
      const text = (m.text ?? '').trim();
      if (!text) return '';
      const role = m.kind === 'user' ? 'User' : 'Ghampus';
      if (m.kind === 'user' && m.selectionContext?.selectedText) {
        const sel = m.selectionContext.selectedText.trim().slice(0, 80);
        return `${role} (about «${sel}»): ${text}`;
      }
      return `${role}: ${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function buildSelectionFollowUpUserPrompt(
  question: string,
  ctx: GhampusSelectionContext,
  recentHistory: string,
  recallSnippet?: string,
): string {
  const parts = [
    'The user highlighted a passage from your prior Ghampus answer and asked a follow-up.',
    '',
    '## Highlighted passage',
    `«${ctx.selectedText.trim()}»`,
    '',
    '## Full parent answer',
    ctx.parentAnswerText.trim(),
    '',
  ];
  if (recentHistory.trim()) {
    parts.push('## Recent conversation', recentHistory.trim(), '');
  }
  if (recallSnippet?.trim()) {
    parts.push(
      '## Related cortex recall (supplemental — use only if relevant)',
      recallSnippet.trim().slice(0, 2000),
      '',
    );
  }
  parts.push('## User follow-up question', question.trim());
  return parts.join('\n');
}

export function buildSelectionFollowUpSystemPrompt(question: string): string {
  return `You are Ghampus — the AI built into Graphnosis.
${GHAMPUS_FIRST_PERSON_SELF_RULE}

The user highlighted a specific passage from your previous answer and asked a follow-up question.

Answer ONLY about the highlighted passage, using the full parent answer and recent conversation for context. Do not repeat the entire parent answer unless needed for clarity.

Be concise and direct. Use markdown for structure when helpful.

${buildResponseLanguageRulesBlock(question)}

Do not invent facts beyond what appears in the parent answer, conversation history, or supplemental recall.

Do not echo internal IDs, node refs, or raw graph format.`;
}

export function sanitizeFragmentReviewResponse(text: string): string {
  return text
    .replace(/\buser\s+1\d{12,}\b/gi, 'you')
    .replace(/\b(?:message|turn|msg)[-\s]?id\s*[:#]?\s*1?\d{10,}\b/gi, '')
    .replace(/\b(?:received from|sent by)\s+user\s+1?\d{10,}\b/gi, 'received from you')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drop extra ## sections when the model repeats items beyond the comment count. */
export function trimFragmentReviewSections(text: string, maxSections: number): string {
  if (maxSections <= 0 || !text.trim()) return text.trim();
  const re = /^## /gm;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) starts.push(m.index);
  if (starts.length <= maxSections) return text.trim();
  return text.slice(0, starts[maxSections]!).trim();
}

export function formatFragmentReviewOutput(
  draft: string,
  payload: GhampusFragmentReviewPayload,
): string {
  const trimmed = trimFragmentReviewSections(sanitizeFragmentReviewResponse(draft), payload.comments.length);
  return trimmed;
}

export function buildFragmentReviewSystemPrompt(): string {
  return `You are Ghampus — the AI built into Graphnosis.
${GHAMPUS_FIRST_PERSON_SELF_RULE}

The user highlighted passages in your prior answers and left comments. Reply to **each input item exactly once** — same count, same order. Do not repeat items or add extra sections.

For every item use this shape only:

## [number]. [short label — a few words from the passage]

> **Your comment:** "[paste the user's comment verbatim from the input]"

[Your reply — 1–3 short paragraphs. Address their comment directly. Clarify the highlighted passage only if needed.]

Rules:
- Always open each item with the blockquote containing the user's comment verbatim, then your reply.
- When the same phrase appears twice in a parent answer, use ONLY that item's excerpt — not a different duplicate.
- If they asked you to save, train, recall, or run something, give the exact next step (\`/save …\`, \`/preview skill-name\`, etc.).
- Never mention message IDs, turn IDs, timestamps, node IDs, or "user 1782…"-style identifiers — say "you" instead.
- Do not use nested numbered lists (no "1. Restate… 2. Address… 3. No action needed").
- Be concise. No filler like "No action needed" unless they literally asked whether action is required.

Do not invent cortex facts. If an action needs Pro+ skill training and you cannot execute it here, say so plainly.`;
}

export function buildFragmentReviewUserPrompt(
  payload: GhampusFragmentReviewPayload,
): string {
  const n = payload.comments.length;
  const parts = [
    `Respond to exactly ${n} comment${n === 1 ? '' : 's'}. Output exactly ${n} "##" section${n === 1 ? '' : 's'} — no more, no fewer.`,
    '',
    '## Items',
  ];
  payload.comments.forEach((c, i) => {
    const parent = c.parentAnswerText?.trim() ?? '';
    const excerpt = parent
      ? formatFragmentQuoteExcerpt(parent, c.quotedText, {
          ...(c.quoteStartOffset != null ? { startOffset: c.quoteStartOffset } : {}),
          ...(c.contextBefore ? { contextBefore: c.contextBefore } : {}),
          ...(c.contextAfter ? { contextAfter: c.contextAfter } : {}),
        })
      : `«${c.quotedText.trim()}»`;
    parts.push(
      `### Item ${i + 1}`,
      '',
      'Highlighted passage (excerpt — this is what they selected):',
      excerpt,
      '',
      'User comment (quote verbatim in your blockquote before you reply):',
      `"${c.userComment.trim().replace(/"/g, '\\"')}"`,
      '',
    );
  });
  parts.push(`Write ${n} section${n === 1 ? '' : 's'} now.`);
  return parts.join('\n');
}
