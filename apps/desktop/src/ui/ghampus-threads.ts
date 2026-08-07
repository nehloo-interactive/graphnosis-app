/**
 * Ghampus reply threads — right sidebar, nested replies, action chips,
 * citation attach, promote / remember / resolve / mentions.
 *
 * Main feed shows root messages only (+ reply count badge). Replies live in
 * the sidebar under a pinned parent. Nested replies indent by parent chain.
 */

import { escapeHtml, presSurfaceAttr, PRES_GHAMPUS_CHAT } from './util';

/** Structured “why I said this” block on Agempi messages. */
export interface GhampusCitationAttach {
  kind: 'source' | 'skill-walk' | 'contradiction' | 'trace' | 'other';
  label: string;
  detail?: string;
}

export interface GhampusThreadFields {
  messageId?: string;
  /** Root of the thread (= root messageId). Absent on root messages. */
  threadId?: string;
  /** Immediate parent messageId (supports nested reply-to-reply). */
  parentId?: string;
  mentions?: string[];
  citations?: GhampusCitationAttach[];
  /** Root-only flags (also mirrored in localStorage for mute/resolve). */
  threadResolved?: boolean;
  threadMuted?: boolean;
}

export type ThreadableMsg = {
  kind: 'user' | 'ghampus';
  text: string;
  ts: number;
  turnId?: string;
} & GhampusThreadFields;

const THREAD_META_KEY = 'ghampus.threadMeta.v1';

export interface ThreadMeta {
  resolved?: boolean;
  muted?: boolean;
}

function loadAllMeta(): Record<string, ThreadMeta> {
  try {
    const raw = localStorage.getItem(THREAD_META_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ThreadMeta>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveAllMeta(map: Record<string, ThreadMeta>): void {
  try {
    localStorage.setItem(THREAD_META_KEY, JSON.stringify(map));
  } catch { /* quota */ }
}

export function getThreadMeta(threadId: string): ThreadMeta {
  return loadAllMeta()[threadId] ?? {};
}

export function setThreadMeta(threadId: string, patch: ThreadMeta): ThreadMeta {
  const all = loadAllMeta();
  const next = { ...(all[threadId] ?? {}), ...patch };
  all[threadId] = next;
  saveAllMeta(all);
  return next;
}

export function resolveMessageId(msg: {
  messageId?: string;
  turnId?: string;
  ts?: number;
  kind?: string;
}): string {
  if (msg.messageId) return msg.messageId;
  if (msg.turnId) return `${msg.kind ?? 'msg'}-${msg.turnId}`;
  return `msg-${msg.ts ?? Date.now()}`;
}

export function isThreadReply(msg: ThreadableMsg): boolean {
  return Boolean(msg.threadId || msg.parentId);
}

export function rootThreadId(msg: ThreadableMsg): string {
  return msg.threadId ?? resolveMessageId(msg);
}

/** Depth in the reply tree (0 = root). */
export function replyDepth(
  msg: ThreadableMsg,
  byId: Map<string, ThreadableMsg>,
): number {
  let depth = 0;
  let cur: ThreadableMsg | undefined = msg;
  const seen = new Set<string>();
  while (cur?.parentId) {
    const id = resolveMessageId(cur);
    if (seen.has(id)) break;
    seen.add(id);
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    depth += 1;
    cur = parent;
    if (depth > 32) break;
  }
  return depth;
}

export function indexThreadable(messages: ThreadableMsg[]): Map<string, ThreadableMsg> {
  const map = new Map<string, ThreadableMsg>();
  for (const m of messages) {
    if (m.kind !== 'user' && m.kind !== 'ghampus') continue;
    map.set(resolveMessageId(m), m);
  }
  return map;
}

/** Replies belonging to a thread, chronological, with depth. */
export function listThreadReplies(
  messages: ThreadableMsg[],
  threadId: string,
): Array<{ msg: ThreadableMsg; depth: number }> {
  const byId = indexThreadable(messages);
  const out: Array<{ msg: ThreadableMsg; depth: number }> = [];
  for (const m of messages) {
    if (m.kind !== 'user' && m.kind !== 'ghampus') continue;
    const id = resolveMessageId(m);
    if (id === threadId) continue; // skip root itself
    const tid = m.threadId ?? (m.parentId ? threadIdOf(m, byId) : null);
    if (tid !== threadId) continue;
    if (!m.parentId && !m.threadId) continue;
    out.push({ msg: m, depth: replyDepth(m, byId) });
  }
  out.sort((a, b) => a.msg.ts - b.msg.ts);
  return out;
}

function threadIdOf(msg: ThreadableMsg, byId: Map<string, ThreadableMsg>): string | null {
  if (msg.threadId) return msg.threadId;
  let cur: ThreadableMsg | undefined = msg;
  const seen = new Set<string>();
  while (cur?.parentId) {
    const id = resolveMessageId(cur);
    if (seen.has(id)) return null;
    seen.add(id);
    const parent = byId.get(cur.parentId);
    if (!parent) return cur.parentId;
    if (!parent.parentId) return resolveMessageId(parent);
    cur = parent;
  }
  return null;
}

export function countThreadReplies(messages: ThreadableMsg[], threadId: string): number {
  return listThreadReplies(messages, threadId).length;
}

/** Parse @Mentions from compose text (simple token form). */
export function parseMentions(text: string): string[] {
  const found = new Set<string>();
  const re = /@([A-Za-z][\w.-]{0,39})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}

/** Compact stroke icons for action chips — kept inline so CSS can color via currentColor. */
const CHIP_ICON: Record<string, string> = {
  explain: '<svg class="ghampus-msg-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M8 3.5v5M8 11.5h.01"/><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  'preview-skill': '<svg class="ghampus-msg-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M3.5 4.5h9M3.5 8h6M3.5 11.5h4"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M12 9.5v3M10.5 11h3"/></svg>',
  audit: '<svg class="ghampus-msg-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M4 3.5h6.5L13 6v6.5H4z"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M6.5 9.5 8 11l3-3"/></svg>',
  todo: '<svg class="ghampus-msg-action-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.75" y="2.75" width="10.5" height="10.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M5.5 8.2 7.2 10l3.5-3.8"/></svg>',
  reply: '<svg class="ghampus-msg-action-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M6 4.5 2.5 8 6 11.5M2.5 8H10a3.5 3.5 0 0 1 0 7H8.5"/></svg>',
};

/**
 * Message action toolbelt (Explain / Preview skill / Audit / Todo / Reply).
 * Hidden until those flows ship — flip to true to re-show the neutral chips.
 */
export const GHAMPUS_MSG_ACTIONS_VISIBLE = false;

export function renderActionChips(messageId: string): string {
  if (!GHAMPUS_MSG_ACTIONS_VISIBLE) return '';
  const chips: Array<{ action: string; label: string; title: string }> = [
    { action: 'explain', label: 'Explain', title: 'Open a thread: explain this message' },
    { action: 'preview-skill', label: 'Preview skill', title: 'Preview a related skill SOP' },
    { action: 'audit', label: 'Audit claim', title: 'Run consistency / integrity check on this claim' },
    { action: 'todo', label: 'Add to todos', title: 'Capture as a todo / obligation' },
  ];
  return `<div class="ghampus-msg-actions" data-msg-id="${escapeHtml(messageId)}" role="toolbar" aria-label="Message actions">
    ${chips.map((c) =>
      `<button type="button" class="ghampus-msg-action" data-thread-action="${c.action}" data-msg-id="${escapeHtml(messageId)}" title="${escapeHtml(c.title)}">${CHIP_ICON[c.action] ?? ''}<span class="ghampus-msg-action-label">${escapeHtml(c.label)}</span></button>`,
    ).join('')}
    <button type="button" class="ghampus-msg-action ghampus-msg-action--reply" data-thread-action="reply" data-msg-id="${escapeHtml(messageId)}" title="Reply in thread">${CHIP_ICON.reply}<span class="ghampus-msg-action-label">Reply</span></button>
  </div>`;
}

/** @deprecated Citation attach UI removed — prefer the live step trace under the message. */
export function renderCitationAttach(_citations: GhampusCitationAttach[] | undefined): string {
  return '';
}

/**
 * Thread reply count badge under a message ("N replies").
 * Hidden with the rest of the reply UX until that surface ships.
 */
export const GHAMPUS_REPLY_BADGE_VISIBLE = false;

export function renderReplyBadge(count: number, threadId: string, meta: ThreadMeta): string {
  if (!GHAMPUS_REPLY_BADGE_VISIBLE) return '';
  if (count <= 0 && !meta.resolved && !meta.muted) return '';
  const bits: string[] = [];
  if (count > 0) bits.push(`${count} ${count === 1 ? 'reply' : 'replies'}`);
  if (meta.resolved) bits.push('resolved');
  if (meta.muted) bits.push('muted');
  return `<button type="button" class="ghampus-reply-badge" data-open-thread="${escapeHtml(threadId)}" title="Open thread">
    ${escapeHtml(bits.join(' · '))}
  </button>`;
}

export function renderMentions(mentions: string[] | undefined): string {
  if (!mentions?.length) return '';
  return `<div class="ghampus-mentions">${mentions.map((n) =>
    `<span class="ghampus-mention">@${escapeHtml(n)}</span>`,
  ).join('')}</div>`;
}

/** Build sidebar HTML for an open thread. */
export function renderThreadSidebarHtml(opts: {
  root: ThreadableMsg;
  replies: Array<{ msg: ThreadableMsg; depth: number }>;
  meta: ThreadMeta;
  fmtTime: (ts: number) => string;
  renderMarkdown: (text: string) => string;
}): string {
  const { root, replies, meta, fmtTime, renderMarkdown } = opts;
  const rootId = resolveMessageId(root);
  const who = root.kind === 'user' ? 'You' : 'Ghampus';
  const preview = root.text.length > 280 ? `${root.text.slice(0, 280)}…` : root.text;
  const replyRows = replies.map(({ msg, depth }) => {
    const id = resolveMessageId(msg);
    const name = msg.kind === 'user' ? 'You' : 'Ghampus';
    const body = msg.kind === 'ghampus'
      ? renderMarkdown(msg.text)
      : escapeHtml(msg.text);
    const nest = Math.min(depth, 6);
    return `<div class="ghampus-sidebar-reply depth-${nest}" data-msg-id="${escapeHtml(id)}" data-parent-id="${escapeHtml(msg.parentId ?? rootId)}" style="--reply-depth:${nest}">
      <div class="ghampus-sidebar-reply-head">
        <strong>${escapeHtml(name)}</strong>
        <span class="ghampus-sidebar-reply-time">${fmtTime(msg.ts)}</span>
      </div>
      ${renderMentions(msg.mentions)}
      <div class="ghampus-sidebar-reply-body ${msg.kind === 'ghampus' ? 'chat-msg-bubble--markdown' : ''}">${body}</div>
      ${msg.kind === 'ghampus' ? renderActionChips(id) : ''}
    </div>`;
  }).join('');

  return `
    <div class="ghampus-thread-sidebar-head">
      <div class="ghampus-thread-sidebar-title">Thread</div>
      <button type="button" id="btn-ghampus-thread-close" class="ghampus-thread-sidebar-close" aria-label="Close thread">×</button>
    </div>
    <div class="ghampus-thread-sidebar-parent" data-root-id="${escapeHtml(rootId)}">
      <div class="ghampus-thread-sidebar-parent-meta">
        <strong>${escapeHtml(who)}</strong>
        <span>${fmtTime(root.ts)}</span>
        ${meta.resolved ? '<span class="ghampus-thread-flag">Resolved</span>' : ''}
        ${meta.muted ? '<span class="ghampus-thread-flag">Muted</span>' : ''}
      </div>
      <div class="ghampus-thread-sidebar-parent-body chat-msg-bubble--markdown"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${root.kind === 'ghampus' ? renderMarkdown(preview) : escapeHtml(preview)}</div>
    </div>
    <div class="ghampus-thread-sidebar-toolbar">
      <button type="button" class="g-btn btn-sm" data-thread-tool="promote" data-thread-id="${escapeHtml(rootId)}" title="Open this thread as its own chat">Open as chat</button>
      <button type="button" class="g-btn btn-sm" data-thread-tool="remember" data-thread-id="${escapeHtml(rootId)}" title="Remember thread into an engram">Remember</button>
      <button type="button" class="g-btn btn-sm" data-thread-tool="resolve" data-thread-id="${escapeHtml(rootId)}">${meta.resolved ? 'Reopen' : 'Resolve'}</button>
      <button type="button" class="g-btn btn-sm" data-thread-tool="mute" data-thread-id="${escapeHtml(rootId)}">${meta.muted ? 'Unmute' : 'Mute'}</button>
      <button type="button" class="g-btn btn-sm" data-thread-tool="jump" data-thread-id="${escapeHtml(rootId)}" title="Jump to message in main feed">Jump</button>
    </div>
    <div class="ghampus-thread-sidebar-replies" id="ghampus-thread-sidebar-replies">
      ${replyRows || '<p class="ghampus-thread-sidebar-empty">No replies yet — add the first one below.</p>'}
    </div>
    <div class="ghampus-thread-sidebar-compose">
      <div id="ghampus-thread-reply-target" class="ghampus-thread-reply-target" data-parent-id="${escapeHtml(rootId)}" data-thread-id="${escapeHtml(rootId)}">
        Replying to thread
      </div>
      <textarea id="ghampus-thread-input" class="ghampus-thread-input" rows="2"
        placeholder="Reply… use @Name to mention · Enter to send"></textarea>
      <div class="ghampus-thread-compose-actions">
        <button type="button" class="g-btn" id="btn-ghampus-thread-cancel-nest">Reply to root</button>
        <button type="button" class="g-btn primary" id="btn-ghampus-thread-send">Send reply</button>
      </div>
    </div>`;
}

/** Action-chip → seed text for a new reply turn. */
export function actionChipSeed(action: string, parentText: string): string {
  const clip = parentText.length > 200 ? `${parentText.slice(0, 200)}…` : parentText;
  switch (action) {
    case 'explain':
      return `Explain this more clearly:\n\n> ${clip}`;
    case 'preview-skill':
      return `/preview consistency-audit\n\nContext from this message:\n> ${clip}`;
    case 'audit':
      return `Audit this claim for contradictions or stale facts:\n\n> ${clip}`;
    case 'todo':
      return `Add a todo from this:\n\n> ${clip}`;
    default:
      return '';
  }
}

/** Citations extracted from a turn trace snapshot (best-effort). */
export function citationsFromTrace(trace: {
  steps?: Array<{ tool?: string; label?: string; preview?: string; status?: string }>;
} | undefined): GhampusCitationAttach[] {
  if (!trace?.steps?.length) return [];
  const out: GhampusCitationAttach[] = [];
  for (const step of trace.steps) {
    if (step.status === 'error') continue;
    const tool = (step.tool ?? '').toLowerCase();
    const label = step.label ?? step.tool ?? 'step';
    if (/recall|remind|cross_search|dig_deeper|citation/i.test(tool) || /recall|memory|search/i.test(label)) {
      out.push({
        kind: 'source',
        label,
        ...(step.preview ? { detail: step.preview.slice(0, 160) } : {}),
      });
    } else if (/walk_skill|skill/i.test(tool) || /skill|sop|preview/i.test(label)) {
      out.push({
        kind: 'skill-walk',
        label,
        ...(step.preview ? { detail: step.preview.slice(0, 160) } : {}),
      });
    } else if (/contradict|integrity|audit/i.test(tool + label)) {
      out.push({
        kind: 'contradiction',
        label,
        ...(step.preview ? { detail: step.preview.slice(0, 160) } : {}),
      });
    }
  }
  // Always expose a compact trace summary when there were tool steps
  if (out.length === 0 && trace.steps.length > 0) {
    out.push({
      kind: 'trace',
      label: `${trace.steps.length} step${trace.steps.length === 1 ? '' : 's'} in this turn`,
      detail: trace.steps.map((s) => s.label).filter(Boolean).slice(0, 4).join(' · '),
    });
  }
  return out.slice(0, 8);
}

export function buildThreadRememberText(
  root: ThreadableMsg,
  replies: Array<{ msg: ThreadableMsg }>,
): string {
  const lines = [
    `Ghampus thread (${new Date(root.ts).toISOString()})`,
    '',
    `[${root.kind}] ${root.text}`,
  ];
  for (const { msg } of replies) {
    lines.push('', `[${msg.kind}] ${msg.text}`);
  }
  return lines.join('\n');
}
