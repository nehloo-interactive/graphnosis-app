/**
 * Ghampus selection follow-up — context builder for questions about a highlighted passage.
 */
import { z } from 'zod';
import { buildResponseLanguageRulesBlock } from './ghampus-language.js';

export const ghampusSelectionContextSchema = z.object({
  selectedText: z.string().min(1),
  parentAnswerText: z.string().min(1),
  parentTs: z.number().int().positive(),
  parentTurnId: z.string().optional(),
});

export type GhampusSelectionContext = z.infer<typeof ghampusSelectionContextSchema>;

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
};

export function parseGhampusSendPayload(params: unknown): {
  text: string;
  turnId?: string;
  selectionContext?: GhampusSelectionContext;
} {
  const parsed = z.object({
    text: z.string(),
    turnId: z.string().optional(),
    selectionContext: ghampusSelectionContextSchema.optional(),
  }).parse(params ?? {});
  return {
    text: parsed.text,
    ...(parsed.turnId !== undefined ? { turnId: parsed.turnId } : {}),
    ...(parsed.selectionContext !== undefined ? { selectionContext: parsed.selectionContext } : {}),
  };
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

The user highlighted a specific passage from your previous answer and asked a follow-up question.

Answer ONLY about the highlighted passage, using the full parent answer and recent conversation for context. Do not repeat the entire parent answer unless needed for clarity.

Be concise and direct. Use markdown for structure when helpful.

${buildResponseLanguageRulesBlock(question)}

Do not invent facts beyond what appears in the parent answer, conversation history, or supplemental recall.

Do not echo internal IDs, node refs, or raw graph format.`;
}
