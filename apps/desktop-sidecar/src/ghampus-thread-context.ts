/**
 * Thread-scoped context for Ghampus replies — parent + thread only,
 * so digressions don't pollute the main chat lane.
 */

import { z } from 'zod';
import { GHAMPUS_FIRST_PERSON_SELF_RULE } from './ghampus-glossary.js';

export const ghampusReplyContextSchema = z.object({
  threadId: z.string().min(1),
  parentId: z.string().min(1),
  rootText: z.string().min(1),
  parentText: z.string().min(1),
  /** Prior replies in the thread (oldest→newest), capped by caller. */
  threadReplies: z.array(z.object({
    kind: z.enum(['user', 'ghampus']),
    text: z.string(),
    messageId: z.string().optional(),
  })).max(40).default([]),
  mentions: z.array(z.string()).max(12).optional(),
});

export type GhampusReplyContext = z.infer<typeof ghampusReplyContextSchema>;

export function buildThreadScopedSystemPrompt(): string {
  return (
    `${GHAMPUS_FIRST_PERSON_SELF_RULE}\n` +
    'You are answering inside a SIDEBAR THREAD. Use ONLY the parent message and ' +
    'the thread replies provided. Do not bring in unrelated topics from the wider chat. ' +
    'If the thread is insufficient, say what is missing — do not invent. ' +
    'When you rely on memory or a skill, name that briefly so a "Why I said this" ' +
    'citation can attach. Keep replies concise.'
  );
}

export function buildThreadScopedUserPrompt(
  userText: string,
  ctx: GhampusReplyContext,
): string {
  const prior = ctx.threadReplies
    .slice(-20)
    .map((r) => `${r.kind === 'user' ? 'User' : 'Ghampus'}: ${r.text}`)
    .join('\n\n');
  const mentionLine = ctx.mentions?.length
    ? `\nMentions in this reply: ${ctx.mentions.map((m) => `@${m}`).join(', ')}\n`
    : '';
  return (
    `THREAD ROOT:\n${ctx.rootText}\n\n` +
    `REPLYING TO:\n${ctx.parentText}\n\n` +
    (prior ? `THREAD SO FAR:\n${prior}\n\n` : '') +
    `${mentionLine}` +
    `USER REPLY:\n${userText}`
  );
}

/** Pull citation-like rows from recent tool trace steps for attach on Agempi msgs. */
export function citationsFromTraceSteps(
  steps: Array<{ tool?: string; label?: string; preview?: string; status?: string }>,
): Array<{ kind: 'source' | 'skill-walk' | 'contradiction' | 'trace' | 'other'; label: string; detail?: string }> {
  const out: Array<{ kind: 'source' | 'skill-walk' | 'contradiction' | 'trace' | 'other'; label: string; detail?: string }> = [];
  for (const step of steps) {
    if (step.status === 'error') continue;
    const tool = (step.tool ?? '').toLowerCase();
    const label = step.label ?? step.tool ?? 'step';
    const blob = `${tool} ${label}`;
    if (/recall|remind|cross_search|dig_deeper|citation/i.test(blob)) {
      out.push({
        kind: 'source',
        label,
        ...(step.preview ? { detail: String(step.preview).slice(0, 160) } : {}),
      });
    } else if (/walk_skill|skill|sop|preview/i.test(blob)) {
      out.push({
        kind: 'skill-walk',
        label,
        ...(step.preview ? { detail: String(step.preview).slice(0, 160) } : {}),
      });
    } else if (/contradict|integrity|audit/i.test(blob)) {
      out.push({
        kind: 'contradiction',
        label,
        ...(step.preview ? { detail: String(step.preview).slice(0, 160) } : {}),
      });
    }
  }
  if (out.length === 0 && steps.length > 0) {
    out.push({
      kind: 'trace',
      label: `${steps.length} step${steps.length === 1 ? '' : 's'}`,
      detail: steps.map((s) => s.label).filter(Boolean).slice(0, 4).join(' · '),
    });
  }
  return out.slice(0, 8);
}
