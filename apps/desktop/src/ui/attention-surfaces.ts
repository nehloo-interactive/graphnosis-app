/**
 * Memory Integrity attention surfaces — sticky banner, floating Ghampus bubble,
 * and shared session dismiss state. All wired to the same `AttentionCounts`.
 */

import type { AttentionCounts } from './memory-integrity-workbench';
import { openMemoryIntegrityWorkbench } from './memory-integrity-workbench';
import { syncGhampusAttentionNudge } from './ghampus';

const ATTENTION_DISMISS_SIG_KEY = 'graphnosis:attention-dismissed-sig';
export const ATTENTION_NUDGE_ID = 'memory-integrity-queue';

export interface AttentionSurfaceDeps {
  escapeHtml: (s: string) => string;
  openTrivia: () => void;
  isHomeDashboardView: () => boolean;
  isGhampusMode: () => boolean;
  isAppUnlocked: () => boolean;
}

let deps: AttentionSurfaceDeps | null = null;
let lastCounts: AttentionCounts | null = null;
let bubbleWired = false;

export function initAttentionSurfaces(d: AttentionSurfaceDeps): void {
  deps = d;
  document.addEventListener('graphnosis:attention-dismiss', () => {
    if (lastCounts) dismissAttention(lastCounts);
  });
}

export function attentionSignature(counts: AttentionCounts): string {
  return `${counts.corrections}:${counts.duplicates}:${counts.contradictions}`;
}

export function isAttentionDismissed(counts: AttentionCounts): boolean {
  try {
    return sessionStorage.getItem(ATTENTION_DISMISS_SIG_KEY) === attentionSignature(counts);
  } catch {
    return false;
  }
}

export function dismissAttention(counts: AttentionCounts): void {
  try {
    sessionStorage.setItem(ATTENTION_DISMISS_SIG_KEY, attentionSignature(counts));
  } catch { /* private mode */ }
  document.dispatchEvent(new CustomEvent('graphnosis:attention-snooze'));
  hideAttentionSurfaces();
  syncGhampusAttentionNudge(counts, false);
}

export function clearAttentionDismiss(): void {
  try { sessionStorage.removeItem(ATTENTION_DISMISS_SIG_KEY); } catch { /* ignore */ }
}

function hideAttentionSurfaces(): void {
  const strip = document.getElementById('home-attention-strip');
  strip?.classList.add('hidden');
  const bubble = document.getElementById('ghampus-attention-bubble');
  bubble?.classList.add('hidden');
}

function formatAttentionParts(counts: AttentionCounts): string[] {
  const parts: string[] = [];
  if (counts.corrections > 0) {
    parts.push(`${counts.corrections} correction${counts.corrections === 1 ? '' : 's'}`);
  }
  if (counts.contradictions > 0) {
    parts.push(`${counts.contradictions} contradiction${counts.contradictions === 1 ? '' : 's'}`);
  }
  if (counts.duplicates > 0) {
    parts.push(`${counts.duplicates} duplicate${counts.duplicates === 1 ? '' : 's'}`);
  }
  return parts;
}

function wireAttentionBubble(d: AttentionSurfaceDeps): void {
  if (bubbleWired) return;
  const bubble = document.getElementById('ghampus-attention-bubble');
  if (!bubble) return;
  bubbleWired = true;
  bubble.querySelector('[data-attention-bubble-review]')?.addEventListener('click', () => {
    openMemoryIntegrityWorkbench('queue');
  });
  bubble.querySelector('[data-attention-bubble-corrections]')?.addEventListener('click', () => {
    openMemoryIntegrityWorkbench('queue');
  });
  bubble.querySelector('[data-attention-bubble-ghampus]')?.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('graphnosis:open-ghampus-attention'));
  });
  bubble.querySelector('[data-attention-bubble-dismiss]')?.addEventListener('click', () => {
    if (lastCounts) dismissAttention(lastCounts);
  });
}

function renderStickyBanner(counts: AttentionCounts, d: AttentionSurfaceDeps): void {
  const strip = document.getElementById('home-attention-strip');
  if (!strip) return;
  const parts = formatAttentionParts(counts);
  strip.classList.remove('hidden');
  strip.innerHTML =
    `<span class="cortex-attention-icon" aria-hidden="true">!</span>` +
    `<span class="home-attention-text"><strong>Needs attention:</strong> ${d.escapeHtml(parts.join(' · '))}</span>` +
    `<div class="cortex-attention-actions">` +
    `<button type="button" class="home-attention-cta cortex-attention-primary" data-attention-review>Review in Memory Integrity →</button>` +
    (counts.corrections > 0
      ? `<button type="button" class="home-attention-link" data-attention-corrections>Corrections deck</button>`
      : '') +
    `<button type="button" class="cortex-attention-dismiss" data-attention-dismiss aria-label="Snooze for now">×</button>` +
    `</div>`;
  strip.querySelector('[data-attention-review]')?.addEventListener('click', () => openMemoryIntegrityWorkbench('queue'));
  strip.querySelector('[data-attention-corrections]')?.addEventListener('click', () => openMemoryIntegrityWorkbench('queue'));
  strip.querySelector('[data-attention-dismiss]')?.addEventListener('click', () => dismissAttention(counts));
}

function renderFloatingBubble(counts: AttentionCounts, d: AttentionSurfaceDeps): void {
  wireAttentionBubble(d);
  const bubble = document.getElementById('ghampus-attention-bubble');
  if (!bubble) return;
  const parts = formatAttentionParts(counts);
  const headline = parts[0] ?? 'items need review';
  const textEl = bubble.querySelector('.ghampus-attention-bubble-text');
  if (textEl) {
    textEl.textContent = counts.total === 1
      ? `1 ${headline} waiting — review in Memory Integrity`
      : `${counts.total} items need attention — ${parts.join(', ')}`;
  }
  const badge = bubble.querySelector('.ghampus-attention-bubble-badge');
  if (badge) badge.textContent = String(counts.total);
  const correctionsBtn = bubble.querySelector<HTMLElement>('[data-attention-bubble-corrections]');
  if (correctionsBtn) correctionsBtn.classList.toggle('hidden', counts.corrections <= 0);
  bubble.classList.remove('hidden');
}

/** Sync sticky banner, floating bubble, and Ghampus in-chat nudge to the same counts. */
export function syncAttentionSurfaces(counts: AttentionCounts): void {
  if (!deps) return;
  lastCounts = { ...counts };
  counts.total = counts.corrections + counts.duplicates + counts.contradictions;

  if (counts.total <= 0) {
    hideAttentionSurfaces();
    syncGhampusAttentionNudge(counts, false);
    clearAttentionDismiss();
    return;
  }

  if (isAttentionDismissed(counts)) {
    hideAttentionSurfaces();
    syncGhampusAttentionNudge(counts, false);
    return;
  }

  if (deps.isHomeDashboardView()) {
    renderStickyBanner(counts, deps);
  } else {
    document.getElementById('home-attention-strip')?.classList.add('hidden');
  }

  const showBubble = deps.isAppUnlocked() && !deps.isGhampusMode() && !deps.isHomeDashboardView();
  if (showBubble) {
    renderFloatingBubble(counts, deps);
  } else {
    document.getElementById('ghampus-attention-bubble')?.classList.add('hidden');
  }

  syncGhampusAttentionNudge(counts, true);
}
