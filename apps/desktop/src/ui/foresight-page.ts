/**
 * Foresight page — compact tile dashboard + detail modal.
 * Full lane content lives in #foresight-detail-pool and moves into the modal on demand.
 */

import type { AttentionCounts } from './memory-integrity-workbench';

export interface ForesightInsightRow {
  id: string;
  graphId: string;
  kind: string;
  title: string;
  body: string;
  dismissed?: boolean;
}

export type InsightActionKind = 'ask-ghampus' | 'open-integrity' | 'open-engram';

export interface InsightPrimaryAction {
  label: string;
  kind: InsightActionKind;
  prompt?: string;
}

export function insightPrimaryAction(i: ForesightInsightRow, engramLabel: string): InsightPrimaryAction {
  const k = i.kind.toLowerCase();
  const engram = engramLabel || i.graphId;
  if (k.includes('gap')) {
    return {
      label: 'Ask Ghampus',
      kind: 'ask-ghampus',
      prompt: `What do I know about "${i.title}" in ${engram}? Help me fill this gap: ${i.body}`,
    };
  }
  if (k.includes('conflict')) {
    return {
      label: 'Review conflicts',
      kind: 'open-integrity',
    };
  }
  if (k.includes('pattern')) {
    return {
      label: 'Dig deeper',
      kind: 'ask-ghampus',
      prompt: `Tell me more about this pattern in ${engram}: ${i.title}. ${i.body}`,
    };
  }
  if (k.includes('opp')) {
    return {
      label: 'Explore opportunity',
      kind: 'ask-ghampus',
      prompt: `How should I act on this opportunity in ${engram}? ${i.title} — ${i.body}`,
    };
  }
  if (k.includes('risk')) {
    return {
      label: 'Ask Ghampus',
      kind: 'ask-ghampus',
      prompt: `What should I know about this risk in ${engram}? ${i.title} — ${i.body}`,
    };
  }
  return {
    label: 'Ask Ghampus',
    kind: 'ask-ghampus',
    prompt: `${i.title}: ${i.body}`,
  };
}

export interface ForesightPageState {
  insights: ForesightInsightRow[];
  goalsCount: number;
  llmReady: boolean;
  llmEnabled: boolean;
  llmSetupDone: boolean;
  gllPending: number;
  gnnEnabled: boolean;
  gnnEdgeCount: number;
  attention: AttentionCounts;
}

export interface ForesightPageDeps {
  escapeHtml: (s: string) => string;
  engramName: (graphId: string) => string;
  openNonDeterministic: () => void;
  onDismissInsight: (id: string) => void | Promise<void>;
  onInsightAction: (action: InsightPrimaryAction, insight: ForesightInsightRow) => void | Promise<void>;
}

const LANE_CARDS: Record<string, { cardId: string; title: string }> = {
  integrity: { cardId: 'fcard-memory-integrity', title: 'Memory Integrity' },
  insights: { cardId: 'fcard-insights', title: 'Insights' },
  predict: { cardId: 'fcard-predict', title: 'Predict' },
  goals: { cardId: 'fcard-goals', title: 'Your goals' },
  llm: { cardId: 'fcard-llm', title: 'Local LLM' },
  gll: { cardId: 'fcard-gll', title: 'Local Layer (.GLL)' },
  gnn: { cardId: 'fcard-gnn', title: 'Neural Network (.GNN)' },
};

let deps: ForesightPageDeps | null = null;
let getState: (() => ForesightPageState) | null = null;
let bootstrap: (() => void) | null = null;
let modalWired = false;
let openLane: string | null = null;

/** main.ts registers this so late callers (insights refresh, GLL list) can self-heal. */
export function setForesightBootstrap(fn: () => void): void {
  bootstrap = fn;
}

function poolEl(): HTMLElement | null {
  return document.getElementById('foresight-detail-pool');
}

function insightKindLabel(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes('conflict')) return 'Conflict hint';
  return kind;
}

function insightKindClass(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes('gap')) return 'gap';
  if (k.includes('opp')) return 'opportunity';
  if (k.includes('pattern')) return 'pattern';
  if (k.includes('risk') || k.includes('conflict')) return 'risk';
  return 'default';
}

export function renderInsightCard(
  i: ForesightInsightRow,
  d: Pick<ForesightPageDeps, 'escapeHtml' | 'engramName'>,
  opts?: { compact?: boolean; showDismiss?: boolean; showAction?: boolean },
): string {
  const compact = opts?.compact ?? false;
  const kindCls = insightKindClass(i.kind);
  const kindLabel = insightKindLabel(i.kind);
  const isConflictHint = i.kind.toLowerCase().includes('conflict');
  const conflictNote = isConflictHint && !compact
    ? '<p class="foresight-insight-footnote">LLM-inferred tension — not the Memory Integrity review queue. Dismiss if it\'s not useful, or ask Ghampus to investigate.</p>'
    : '';
  const action = insightPrimaryAction(i, d.engramName(i.graphId));
  const actionBtn = opts?.showAction !== false
    ? `<button type="button" class="btn-sm foresight-insight-action" data-insight-action="${d.escapeHtml(action.kind)}" data-insight-id="${d.escapeHtml(i.id)}" data-insight-prompt="${d.escapeHtml(action.prompt ?? '')}">${d.escapeHtml(action.label)}</button>`
    : '';
  const dismiss = opts?.showDismiss
    ? `<button type="button" class="btn-sm foresight-insight-dismiss" data-dismiss-insight="${d.escapeHtml(i.id)}">Dismiss</button>`
    : '';
  const actions = (actionBtn || dismiss)
    ? `<div class="foresight-insight-actions">${actionBtn}${dismiss}</div>`
    : '';
  return `<article class="foresight-insight-card${compact ? ' foresight-insight-card--compact' : ''}" data-insight-id="${d.escapeHtml(i.id)}">
    <div class="foresight-insight-card-head">
      <span class="foresight-insight-kind foresight-insight-kind--${kindCls}">${d.escapeHtml(kindLabel)}</span>
      <span class="foresight-insight-engram" title="Engram">${d.escapeHtml(d.engramName(i.graphId))}</span>
    </div>
    <h4 class="foresight-insight-card-title">${d.escapeHtml(i.title)}</h4>
    <p class="foresight-insight-card-body">${d.escapeHtml(i.body)}</p>
    ${conflictNote}
    ${actions}
  </article>`;
}

export function wireInsightDismiss(host: ParentNode, d: ForesightPageDeps): void {
  host.querySelectorAll<HTMLButtonElement>('[data-dismiss-insight]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset['dismissInsight'];
      if (id) void d.onDismissInsight(id);
    });
  });
}

export function wireInsightActions(host: ParentNode, d: ForesightPageDeps, insights: ForesightInsightRow[]): void {
  host.querySelectorAll<HTMLButtonElement>('[data-insight-action]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset['insightId'];
      const kind = btn.dataset['insightAction'] as InsightActionKind | undefined;
      const prompt = btn.dataset['insightPrompt'];
      if (!id || !kind) return;
      const insight = insights.find((row) => row.id === id);
      if (!insight) return;
      const action = insightPrimaryAction(insight, d.engramName(insight.graphId));
      if (prompt) action.prompt = prompt;
      void d.onInsightAction(action, insight);
    });
  });
}

function tileShell(
  lane: string,
  icon: string,
  title: string,
  stat: string,
  body: string,
  cta: string,
  accent?: 'warn' | 'ok' | 'muted',
): string {
  const accentCls = accent ? ` foresight-tile--${accent}` : '';
  return `<button type="button" class="foresight-tile${accentCls}" data-foresight-lane="${lane}">
    <span class="foresight-tile-icon" aria-hidden="true">${icon}</span>
    <span class="foresight-tile-title">${title}</span>
    <span class="foresight-tile-stat">${stat}</span>
    <span class="foresight-tile-body">${body}</span>
    <span class="foresight-tile-cta">${cta} →</span>
  </button>`;
}

function renderInsightPreviewGrid(insights: ForesightInsightRow[], d: ForesightPageDeps): string {
  if (insights.length === 0) {
    return `<div class="foresight-tile-preview foresight-tile-preview--empty">
      <p>No insights yet — patterns surface as your memory grows.</p>
    </div>`;
  }
  const preview = insights.slice(0, 4);
  const cards = preview.map((i) => renderInsightCard(i, d, { compact: true, showAction: false })).join('');
  const more = insights.length > 4
    ? `<button type="button" class="foresight-tile-more foresight-tile-more-btn" data-foresight-lane="insights">+ ${insights.length - 4} more — open full view →</button>`
    : '';
  return `<div class="foresight-insight-preview-grid">${cards}</div>${more}`;
}

function renderTiles(state: ForesightPageState, d: ForesightPageDeps): string {
  const parts: string[] = [];

  if (state.attention.total > 0) {
    const bits: string[] = [];
    if (state.attention.contradictions > 0) bits.push(`${state.attention.contradictions} contradiction${state.attention.contradictions === 1 ? '' : 's'}`);
    if (state.attention.duplicates > 0) bits.push(`${state.attention.duplicates} duplicate${state.attention.duplicates === 1 ? '' : 's'}`);
    if (state.attention.corrections > 0) bits.push(`${state.attention.corrections} correction${state.attention.corrections === 1 ? '' : 's'}`);
    parts.push(tileShell(
      'integrity',
      '⚖️',
      'Memory Integrity',
      `${state.attention.total} need review`,
      bits.join(' · '),
      'Open workbench',
      'warn',
    ));
  }

  parts.push(`<div class="foresight-tile foresight-tile--wide foresight-tile--insights">
    <div class="foresight-tile-wide-head">
      <span class="foresight-tile-icon" aria-hidden="true">💡</span>
      <div>
        <span class="foresight-tile-title">Insights</span>
        <span class="foresight-tile-stat">${state.insights.length} active</span>
      </div>
      <button type="button" class="btn-sm foresight-tile-open-btn" data-foresight-lane="insights">View all</button>
    </div>
    ${renderInsightPreviewGrid(state.insights, d)}
  </div>`);

  parts.push(tileShell(
    'predict',
    '🔮',
    'Predict',
    state.llmReady ? 'Ready' : 'Needs Local LLM',
    'See risks & opportunities before you act.',
    state.llmReady ? 'Run prediction' : 'Set up first',
    state.llmReady ? 'ok' : 'muted',
  ));

  parts.push(tileShell(
    'goals',
    '🎯',
    'Your goals',
    state.goalsCount === 0 ? 'None yet' : `${state.goalsCount} active`,
    'Strategic plans Graphnosis tracks over time.',
    'Manage goals',
  ));

  if (state.gllPending > 0) {
    parts.push(tileShell(
      'gll',
      '✨',
      'Local Layer',
      `${state.gllPending} pending`,
      'LLM-proposed links awaiting your review.',
      'Review edges',
      'warn',
    ));
  } else if (state.llmReady) {
    parts.push(tileShell(
      'gll',
      '✨',
      'Local Layer',
      'Up to date',
      'Autonomous edge predictions from your local model.',
      'Open settings',
    ));
  }

  parts.push(tileShell(
    'gnn',
    '🧠',
    'Neural Network',
    state.gnnEnabled ? `${state.gnnEdgeCount} edges` : 'Off',
    state.gnnEnabled ? 'Learned connection guesses in a separate overlay.' : 'Optional — enable when you want graph hunches.',
    state.gnnEnabled ? 'Manage GNN' : 'Learn more',
  ));

  const llmStat = !state.llmSetupDone
    ? 'Setup needed'
    : state.llmEnabled
      ? 'ON · ready'
      : 'Ready · off';
  const llmBody = !state.llmSetupDone
    ? 'One-time Ollama setup unlocks insights, predict, and GLL.'
    : state.llmEnabled
      ? 'Running on your device — nothing sent to the cloud.'
      : 'Configured — flip the master toggle when you want AI features.';
  parts.push(tileShell(
    'llm',
    '🤖',
    'Local LLM',
    llmStat,
    llmBody,
    state.llmSetupDone ? 'Configure' : 'Set up',
    state.llmEnabled ? 'ok' : undefined,
  ));

  return parts.join('');
}

export function openForesightLaneModal(lane: string): void {
  const meta = LANE_CARDS[lane];
  if (!meta) return;
  const card = document.getElementById(meta.cardId);
  const modal = document.getElementById('foresight-modal');
  const body = document.getElementById('foresight-modal-body');
  const titleEl = document.getElementById('foresight-modal-title');
  if (!card || !modal || !body || !titleEl) return;

  if (openLane && openLane !== lane) {
    const prev = LANE_CARDS[openLane];
    const prevCard = prev ? document.getElementById(prev.cardId) : null;
    if (prevCard) poolEl()?.appendChild(prevCard);
  }

  titleEl.textContent = meta.title;
  body.appendChild(card);
  card.classList.remove('hidden');
  openLane = lane;
  modal.classList.remove('hidden');
  document.body.classList.add('foresight-modal-open');
  card.scrollTop = 0;
  onLaneOpen?.(lane);
}

export function closeForesightModal(): void {
  if (openLane) {
    const meta = LANE_CARDS[openLane];
    const card = meta ? document.getElementById(meta.cardId) : null;
    if (card) poolEl()?.appendChild(card);
    openLane = null;
  }
  document.getElementById('foresight-modal')?.classList.add('hidden');
  document.body.classList.remove('foresight-modal-open');
}

function wireModal(): void {
  if (modalWired) return;
  modalWired = true;
  document.getElementById('foresight-modal-close')?.addEventListener('click', closeForesightModal);
  document.getElementById('foresight-modal-backdrop')?.addEventListener('click', closeForesightModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openLane) {
      e.preventDefault();
      closeForesightModal();
    }
  });
}

export function initForesightPage(
  stateGetter: () => ForesightPageState,
  pageDeps: ForesightPageDeps,
): void {
  getState = stateGetter;
  deps = pageDeps;
  wireModal();
}

function wireForesightTileClicks(host: HTMLElement, d: ForesightPageDeps): void {
  host.querySelectorAll<HTMLElement>('[data-foresight-lane]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const lane = el.dataset['foresightLane'];
      if (!lane) return;
      if (lane === 'llm' && !getState?.().llmSetupDone) {
        d.openNonDeterministic();
        return;
      }
      openForesightLaneModal(lane);
    });
  });

  host.querySelectorAll<HTMLElement>('.foresight-insight-card--compact').forEach((card) => {
    card.addEventListener('click', () => openForesightLaneModal('insights'));
    card.style.cursor = 'pointer';
  });
}

export function renderForesightTiles(): void {
  const host = document.getElementById('foresight-tiles');
  if (!host) return;
  if (!deps || !getState) {
    bootstrap?.();
  }
  if (!deps || !getState) {
    host.innerHTML = '<div class="foresight-tile-preview foresight-tile-preview--empty"><p>Loading Foresight…</p></div>';
    return;
  }
  const state = getState();
  const d = deps;
  try {
    host.innerHTML = renderTiles(state, d);
    wireForesightTileClicks(host, d);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    host.innerHTML = `<div class="foresight-tile-preview foresight-tile-preview--empty"><p>Foresight could not render (${d.escapeHtml(msg)}). Try leaving and re-opening this page.</p></div>`;
  }
}

function foresightModalIsOpen(): boolean {
  const modal = document.getElementById('foresight-modal');
  return !!modal && !modal.classList.contains('hidden');
}

/** Re-attach the active lane card if the modal is open but the body was emptied (e.g. after stash). */
export function syncForesightModalLane(): void {
  if (!openLane || !foresightModalIsOpen()) return;
  const meta = LANE_CARDS[openLane];
  const body = document.getElementById('foresight-modal-body');
  const card = meta ? document.getElementById(meta.cardId) : null;
  if (!meta || !body || !card || card.parentElement === body) return;
  body.appendChild(card);
  card.classList.remove('hidden');
}

/** Move lane cards into the hidden pool (safe to call repeatedly). */
export function stashForesightDetailCards(): void {
  const pool = poolEl();
  if (!pool) return;
  const modalOpen = foresightModalIsOpen();
  const keepCardId = modalOpen && openLane ? LANE_CARDS[openLane]?.cardId : null;
  for (const meta of Object.values(LANE_CARDS)) {
    const card = document.getElementById(meta.cardId);
    if (card && card.parentElement !== pool) {
      if (keepCardId && meta.cardId === keepCardId) continue;
      card.classList.add('foresight-detail-card');
      pool.appendChild(card);
    }
  }
  pool.dataset['stashed'] = '1';
  syncForesightModalLane();
}

let onLaneOpen: ((lane: string) => void) | null = null;

/** main.ts registers lane-specific refresh (insights grid, integrity queue, …). */
export function setForesightLaneOpenHandler(fn: (lane: string) => void): void {
  onLaneOpen = fn;
}
