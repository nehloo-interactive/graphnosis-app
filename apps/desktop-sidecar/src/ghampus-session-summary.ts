/**
 * Summarize the active Ghampus session for "Remember & start fresh".
 * Chat threads stay ephemeral; this path promotes durable facts into memory.
 */
import type { GraphnosisHost } from './host.js';
import type { LocalLlm } from './correction.js';
import { augmentMemoryWithTemporalContext } from './ghampus-temporal-parse.js';
import { isGhampusBusy } from './ghampus-busy.js';

export interface SessionTurn {
  role: 'user' | 'ghampus';
  text: string;
  ts: number;
}

const MAX_TURNS_IN_HEURISTIC = 14;
const MAX_TURN_CHARS = 240;
const MAX_SUMMARY_CHARS = 3500;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max: number): string {
  const t = stripMarkdown(text);
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Pull user + Ghampus turns from persisted session JSONL rows. */
export function extractSessionTurns(messages: unknown[]): SessionTurn[] {
  const turns: SessionTurn[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    if ((m.kind !== 'user' && m.kind !== 'ghampus') || typeof m.text !== 'string') continue;
    const text = m.text.trim();
    if (!text) continue;
    turns.push({
      role: m.kind === 'user' ? 'user' : 'ghampus',
      text,
      ts: typeof m.ts === 'number' ? m.ts : Date.now(),
    });
  }
  return turns.sort((a, b) => a.ts - b.ts);
}

export function sessionHasSubstantiveTurns(turns: SessionTurn[]): boolean {
  const userTurns = turns.filter((t) => t.role === 'user' && t.text.length >= 8);
  return userTurns.length >= 1 || turns.length >= 3;
}

export function buildHeuristicSessionSummary(turns: SessionTurn[]): string {
  if (turns.length === 0) return '';
  const startTs = turns[0]?.ts ?? Date.now();
  const date = new Date(startTs).toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const lines: string[] = [`Ghampus chat summary (${date})`];
  for (const turn of turns.slice(-MAX_TURNS_IN_HEURISTIC)) {
    const who = turn.role === 'user' ? 'You' : 'Ghampus';
    lines.push(`• ${who}: ${truncate(turn.text, MAX_TURN_CHARS)}`);
  }
  const out = lines.join('\n');
  return out.length > MAX_SUMMARY_CHARS ? `${out.slice(0, MAX_SUMMARY_CHARS - 1)}…` : out;
}

async function summarizeWithLlm(
  llm: LocalLlm,
  turns: SessionTurn[],
): Promise<string | null> {
  const { isBusyAbove, tryAcquireLlmSlot, WorkPriority } = await import('./work-priority.js');
  if (isBusyAbove(WorkPriority.P2_GHAMPUS) || isGhampusBusy()) return null;
  const slot = tryAcquireLlmSlot(WorkPriority.P3_ENRICHMENT);
  if (!slot || slot.signal.aborted) return null;
  try {
    const transcript = turns.slice(-20).map((t) => {
      const who = t.role === 'user' ? 'User' : 'Ghampus';
      return `${who}: ${truncate(t.text, 500)}`;
    }).join('\n');
    const raw = await llm.complete({
      system:
        'Summarize this Ghampus chat for the user\'s long-term memory. '
        + 'Extract decisions, tasks, commitments, and durable facts. Skip greetings and chitchat. '
        + 'Plain text only — short bullet list, max 350 words. If nothing worth saving, reply SKIP.',
      user: transcript.slice(0, 8000),
      signal: slot.signal,
    });
    const out = (raw ?? '').trim();
    if (!out || /^skip$/i.test(out)) return null;
    return out.length > MAX_SUMMARY_CHARS ? `${out.slice(0, MAX_SUMMARY_CHARS - 1)}…` : out;
  } catch {
    return null;
  } finally {
    slot.release();
  }
}

export function resolveDefaultSessionEngram(host: GraphnosisHost): string {
  const graphs = host.listGraphs();
  if (graphs.includes('personal')) return 'personal';
  if (graphs.includes('coding')) return 'coding';
  const personal = graphs.find((id) => {
    const meta = host.getGraphMetadata(id) as { sensitivityTier?: string } | undefined;
    return meta?.sensitivityTier === 'personal';
  });
  return personal ?? graphs[0] ?? 'personal';
}

export async function summarizeActiveGhampusSession(
  cortexDir: string,
  host: GraphnosisHost,
  llm?: LocalLlm | null,
): Promise<{
  summary: string;
  turnCount: number;
  hasSubstantive: boolean;
  usedLlm: boolean;
  defaultEngramId: string;
}> {
  const { getGhampusHistory } = await import('./ghampus-history-cache.js');
  const { messages } = await getGhampusHistory(cortexDir);
  const turns = extractSessionTurns(messages);
  const hasSubstantive = sessionHasSubstantiveTurns(turns);
  const heuristic = buildHeuristicSessionSummary(turns);
  let summary = heuristic;
  let usedLlm = false;
  if (llm && turns.length >= 2) {
    const llmSummary = await summarizeWithLlm(llm, turns);
    if (llmSummary) {
      summary = llmSummary;
      usedLlm = true;
    }
  }
  return {
    summary,
    turnCount: turns.length,
    hasSubstantive,
    usedLlm,
    defaultEngramId: resolveDefaultSessionEngram(host),
  };
}

export async function rememberGhampusSessionSummary(
  host: GraphnosisHost,
  engramId: string,
  summaryText: string,
  sessionId?: string,
): Promise<{ sourceId: string; nodeCount: number }> {
  const { ingestClip } = await import('./ingest.js');
  const saveText = augmentMemoryWithTemporalContext(summaryText).text;
  const label = `Ghampus thread · ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
  const body = sessionId
    ? `Archived Ghampus session \`${sessionId}\`\n\n${saveText}`
    : saveText;
  const rec = await ingestClip(host, engramId, body, label, {
    addedBy: 'ghampus',
    sourceKind: 'ai-conversation',
    triggeredBy: 'ghampus:session-summary',
  });
  return { sourceId: rec.sourceId, nodeCount: rec.nodeIds.length };
}
