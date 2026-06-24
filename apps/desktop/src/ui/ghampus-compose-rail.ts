/**
 * Ghampus compose rail — proactive strips above the chat input.
 */
import { ipcCall } from './ipc';
import { gAlert } from './dialogs';
import { app } from './app-context';
import {
  escapeHtml, presEngramAttr, presSkillAttr, presSurfaceAttr, PRES_GHAMPUS_CHAT, PRES_GHAMPUS_PANELS,
} from './util';

function sweepGhampusComposePres(root?: ParentNode | null): void {
  if (!app().presActive()) return;
  const r = root ?? document.getElementById('ghampus-compose-rail');
  if (r) app().applyPresentationMasking(r);
}

export interface ComposeEngramOption {
  graphId: string;
  displayName: string;
  tier?: string;
}

export interface GhampusComposeAssist {
  primaryIntent: string;
  intentLabel: string;
  mcpToolHint: string | null;
  saveIntent: boolean;
  slashSave: boolean;
  slashCommand: string | null;
  selectedEngramHint: string | null;
  selectedEngramId: string | null;
  chipEngramIds: string[];
  engrams: ComposeEngramOption[];
  suggestedEngram: ComposeEngramOption | null;
  duplicateWarning: {
    graphId: string;
    engramName: string;
    snippet: string;
    score: number;
  } | null;
  contradictionWarning: { count: number } | null;
  obligationHint: { obligationType: string; expiresAt: number; label: string } | null;
  languageMirror: string[] | null;
  vagueReference: { pronoun: string; suggestedSnippet: string } | null;
  consentGate: { tier: string; engramId: string; displayName: string } | null;
  skillMatches: Array<{ slug: string; label: string }>;
  foresightHint: { kind: string; label: string; proRequired: boolean } | null;
  recallPrefetch: { matchCount: number; topSnippet: string | null } | null;
  threadSummaryOffer: boolean;
  sourceMentions: Array<{ sourceId: string; label: string; graphId: string }>;
  memoryVoice: 'decision' | 'todo' | 'fact' | 'quote' | null;
  temporalAnchor: string | null;
  crossEngramSuggestion: ComposeEngramOption | null;
  vitalityNudge: { engramId: string; displayName: string; message: string } | null;
  awayDigest: { corrections: number; contradictions: number; duplicates: number } | null;
  selectionBridge: { quotedText: string; action: string } | null;
  createEngramOffer: {
    displayName: string;
    graphId: string;
    defaultTier: 'personal' | 'sensitive';
  } | null;
  intentSource?: 'heuristic' | 'llm';
  llmConfidence?: number | null;
}

const ASSIST_DEBOUNCE_MS = 180;

function engramHintMatches(hint: string, e: ComposeEngramOption): boolean {
  const h = hint.toLowerCase();
  return e.graphId.toLowerCase() === h
    || e.displayName.toLowerCase() === h
    || e.graphId.toLowerCase().includes(h)
    || e.displayName.toLowerCase().includes(h);
}

export function applyEngramToGhampusInput(
  input: HTMLTextAreaElement,
  engram: ComposeEngramOption,
  slashSave: boolean,
): void {
  const trimmed = input.value.trimEnd();
  if (slashSave || trimmed.startsWith('/save')) {
    const base = trimmed.replace(/\s@[\w-]+$/, '').trimEnd();
    input.value = base ? `${base} @${engram.graphId}` : `/save @${engram.graphId}`;
  } else {
    const base = trimmed.replace(
      /\s+(?:to|in|into|@)\s+(?:(?:my|the)\s+)?["']?[^"'\n@]+?["']?\s*$/i,
      '',
    ).trimEnd();
    input.value = `${base} to ${engram.graphId}`;
  }
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function slugifyEngramHint(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function titleCaseEngramName(hint: string): string {
  return hint.trim().replace(/(^|[\s-])([a-z])/gi, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

/** After inline create — finish an incomplete "save to" / "remember in" line. */
function applyCreatedEngramToGhampusInput(
  input: HTMLTextAreaElement,
  engram: ComposeEngramOption,
  slashSave: boolean,
): void {
  const trimmed = input.value.trimEnd();
  if (slashSave || trimmed.startsWith('/save')) {
    applyEngramToGhampusInput(input, engram, true);
    return;
  }
  const danglingTarget = /^(?:save|remember|store)\s+(?:to|in|into)\s*$/i.test(trimmed)
    || /^(?:save|remember|store)\s*$/i.test(trimmed);
  if (danglingTarget) {
    const lead = /^save\b/i.test(trimmed) ? 'save to' : 'remember in';
    input.value = `${lead} ${engram.graphId} that `;
  } else {
    applyEngramToGhampusInput(input, engram, false);
    if (!/\bthat\b/i.test(input.value) && !/:\s*$/.test(input.value.trim())) {
      input.value = `${input.value.trimEnd()} that `;
    }
  }
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function createEngramFromGuide(
  displayName: string,
  graphId: string,
  tier: 'personal' | 'sensitive',
): Promise<{ ok: boolean; error?: string }> {
  const res = await ipcCall<{ ok?: boolean; error?: { code: string; message?: string } }>(
    'graphs.createWithTemplate',
    { graphId, template: 'personal', displayName },
  );
  if (res.error?.code === 'ENGRAM_LIMIT_REACHED') {
    return { ok: false, error: res.error.message ?? 'Free plan is limited to 3 engrams.' };
  }
  if (tier !== 'personal') {
    await ipcCall('engram.setConfig', { engramId: graphId, tier });
  }
  return { ok: true };
}

export interface GhampusComposeRailContext {
  getSelectedText: () => string;
  getLastGhampusSnippet: () => string;
  getThreadTurnCount: () => number;
  getHoursSinceActive: () => number;
  shouldHide: () => boolean;
  onInputChange: () => void;
  onFillPrompt: (text: string) => void;
  onThreadSummary: () => void;
}

export function wireGhampusComposeRail(
  input: HTMLTextAreaElement,
  ctx: GhampusComposeRailContext,
): { update: () => void; hide: () => void } {
  const rail = document.getElementById('ghampus-compose-rail');
  const stripsEl = document.getElementById('ghampus-compose-strips');
  if (!rail || !stripsEl) {
    return { update: () => {}, hide: () => {} };
  }

  let assistTimer: ReturnType<typeof setTimeout> | null = null;
  let assistSeq = 0;
  let refineSeq = 0;
  let lastAssist: GhampusComposeAssist | null = null;
  let newEngramGuideOpen = false;
  let newEngramDraftName = '';
  let dismissedCreateOfferId: string | null = null;
  let pinnedEngramGraphId: string | null = null;

  function hide(): void {
    rail.classList.add('hidden');
    lastAssist = null;
    newEngramGuideOpen = false;
    dismissedCreateOfferId = null;
    pinnedEngramGraphId = null;
    if (assistTimer) {
      clearTimeout(assistTimer);
      assistTimer = null;
    }
  }

  function stripHtml(label: string, body: string, actions = '', bodyPres = presSurfaceAttr(PRES_GHAMPUS_CHAT)): string {
    return `<div class="ghampus-compose-strip">
      <span class="ghampus-compose-strip-label">${escapeHtml(label)}</span>
      <span class="ghampus-compose-strip-body"${bodyPres}>${body}</span>
      ${actions ? `<span class="ghampus-compose-strip-actions">${actions}</span>` : ''}
    </div>`;
  }

  function renderStrips(assist: GhampusComposeAssist): void {
    const parts: string[] = [];

    if (assist.intentLabel) {
      const mcp = assist.mcpToolHint
        ? `<code class="ghampus-compose-mcp"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(assist.mcpToolHint)}</code>`
        : '';
      const detected = assist.intentSource === 'llm'
        ? ' <span class="ghampus-compose-detected">(detected)</span>'
        : '';
      parts.push(stripHtml('Intent', `${escapeHtml(assist.intentLabel)}${detected} ${mcp}`.trim()));
    }

    if (assist.saveIntent) {
      const chipEngrams = assist.chipEngramIds
        .map((id) => assist.engrams.find((e) => e.graphId === id))
        .filter((e): e is ComposeEngramOption => Boolean(e));
      const selectedId = assist.selectedEngramId;
      const hint = assist.selectedEngramHint;
      const isChipSelected = (e: ComposeEngramOption) =>
        (selectedId != null && e.graphId === selectedId)
        || (hint != null && engramHintMatches(hint, e));
      let chips = chipEngrams.map((e) =>
        `<button type="button" class="ghampus-engram-chip${isChipSelected(e) ? ' is-selected' : ''}" data-graph-id="${escapeHtml(e.graphId)}"${presEngramAttr(e.graphId)}>${escapeHtml(e.displayName)}</button>`,
      ).join('');
      chips += `<button type="button" class="ghampus-engram-chip ghampus-engram-chip-new${newEngramGuideOpen ? ' is-active' : ''}" data-action="open-new-engram-guide">+ New engram</button>`;

      const guideName = newEngramDraftName || assist.createEngramOffer?.displayName || '';
      const guideSlug = slugifyEngramHint(guideName || 'my-topic');
      const guideOpen = newEngramGuideOpen;
      const guideBlock = guideOpen
        ? `<div class="ghampus-new-engram-guide">
            <p class="ghampus-new-engram-guide-hint">Name the topic for this memory, pick a sensitivity tier, then finish your note after <em>that</em>.</p>
            <div class="ghampus-new-engram-guide-row">
              <input type="text" class="ghampus-new-engram-name" placeholder="e.g. Karma · Book notes" value="${escapeHtml(guideName)}" aria-label="New engram name"${presSurfaceAttr(PRES_GHAMPUS_CHAT)} />
              <code class="ghampus-new-engram-slug" title="Internal ID"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(guideSlug || '…')}</code>
            </div>
            <div class="ghampus-new-engram-guide-actions">
              <button type="button" class="g-btn btn-sm ghampus-compose-tier-btn" data-action="create-engram-guide" data-tier="personal"${guideSlug.length < 2 ? ' disabled' : ''}>Create personal</button>
              <button type="button" class="g-btn btn-sm ghampus-compose-tier-btn ghampus-compose-tier-btn--sensitive" data-action="create-engram-guide" data-tier="sensitive"${guideSlug.length < 2 ? ' disabled' : ''}>Create sensitive</button>
              <button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="cancel-new-engram">Cancel</button>
            </div>
          </div>`
        : '';

      const selectOpts = assist.engrams.map((e) =>
        `<option value="${escapeHtml(e.graphId)}"${isChipSelected(e) ? ' selected' : ''}${presEngramAttr(e.graphId)}>${escapeHtml(e.displayName)}</option>`,
      ).join('');
      parts.push(`<div class="ghampus-compose-strip ghampus-compose-strip-engrams${guideOpen ? ' is-guide-open' : ''}">
        <span class="ghampus-compose-strip-label">Save to</span>
        <div class="ghampus-compose-strip-engrams-col">
          <span class="ghampus-compose-strip-body ghampus-engram-picker-chips">${chips}</span>
          ${guideBlock}
        </div>
        <select class="ghampus-engram-picker-select" aria-label="All engrams">
          <option value="">All engrams…</option>${selectOpts}
        </select>
      </div>`);
    }

    if (assist.suggestedEngram && assist.saveIntent && !assist.selectedEngramId && !assist.createEngramOffer) {
      parts.push(stripHtml(
        'Suggested',
        `<span${presEngramAttr(assist.suggestedEngram.graphId)}>${escapeHtml(assist.suggestedEngram.displayName)}</span>`,
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="use-suggested" data-graph-id="${escapeHtml(assist.suggestedEngram.graphId)}">Use</button>`,
      ));
    }

    if (assist.duplicateWarning) {
      parts.push(stripHtml(
        'Similar memory',
        `<span${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(assist.duplicateWarning.snippet.slice(0, 100))}… (${Math.round(assist.duplicateWarning.score * 100)}%)</span>`,
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="edit-instead">Edit instead</button>`,
      ));
    }

    if (assist.selectionBridge) {
      parts.push(stripHtml(
        'Selection',
        `<span${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>"${escapeHtml(assist.selectionBridge.quotedText.slice(0, 80))}"</span>`,
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="save-selection">Save selection</button>`,
      ));
    }

    if (assist.contradictionWarning) {
      parts.push(stripHtml(
        'Integrity',
        `${assist.contradictionWarning.count} contradiction(s) queued — saving may add noise.`,
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="open-foresight">Review</button>`,
      ));
    }

    if (assist.obligationHint) {
      parts.push(stripHtml(
        'Deadline',
        `<span${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(assist.obligationHint.label)}</span>`,
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="track-obligation">Track obligation</button>`,
      ));
    }

    if (assist.languageMirror?.length) {
      parts.push(stripHtml(
        'Languages',
        `<span${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${assist.languageMirror.map(escapeHtml).join(' + ')}</span>`,
      ));
    }

    if (assist.vagueReference) {
      parts.push(stripHtml(
        'Refers to',
        `<span${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(assist.vagueReference.suggestedSnippet.slice(0, 100))}</span>`,
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="expand-vague">Use this</button>`,
      ));
    }

    if (assist.consentGate) {
      parts.push(stripHtml(
        'Consent',
        `<span${presEngramAttr(assist.consentGate.engramId)}>${escapeHtml(assist.consentGate.displayName)}</span> is ${escapeHtml(assist.consentGate.tier)} tier.`,
      ));
    }

    if (assist.skillMatches.length > 0) {
      const btns = assist.skillMatches.map((s) =>
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="run-skill" data-slug="${escapeHtml(s.slug)}"${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(s.label)}</button>`,
      ).join('');
      parts.push(stripHtml('Skills', '', btns));
    }

    if (assist.foresightHint) {
      const pro = assist.foresightHint.proRequired ? ' (Pro)' : '';
      parts.push(stripHtml(
        'Foresight',
        `${escapeHtml(assist.foresightHint.label)}${pro}`,
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="foresight">${escapeHtml(assist.foresightHint.label)}</button>`,
      ));
    }

    if (assist.recallPrefetch) {
      const preview = assist.recallPrefetch.topSnippet
        ? `: <span${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>"${escapeHtml(assist.recallPrefetch.topSnippet.slice(0, 80))}…"</span>`
        : '';
      parts.push(stripHtml(
        'Recall',
        `${assist.recallPrefetch.matchCount} match(es)${preview}`,
      ));
    }

    if (assist.sourceMentions.length > 0) {
      const btns = assist.sourceMentions.slice(0, 5).map((s) =>
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="cite-source" data-label="${escapeHtml(s.label)}"${presSurfaceAttr(PRES_GHAMPUS_PANELS)}>${escapeHtml(s.label.slice(0, 24))}</button>`,
      ).join('');
      parts.push(stripHtml('@ Source', '', btns));
    }

    if (assist.memoryVoice) {
      parts.push(stripHtml('Voice', escapeHtml(assist.memoryVoice)));
    }

    if (assist.temporalAnchor) {
      parts.push(stripHtml('Time', escapeHtml(assist.temporalAnchor)));
    }

    if (assist.crossEngramSuggestion) {
      parts.push(stripHtml(
        'Also link',
        `<span${presEngramAttr(assist.crossEngramSuggestion.graphId)}>${escapeHtml(assist.crossEngramSuggestion.displayName)}</span>`,
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="cross-engram" data-graph-id="${escapeHtml(assist.crossEngramSuggestion.graphId)}">Add link</button>`,
      ));
    }

    if (assist.vitalityNudge) {
      parts.push(stripHtml(
        'Vitality',
        `<span${presSurfaceAttr(PRES_GHAMPUS_CHAT)}>${escapeHtml(assist.vitalityNudge.message)}</span>`,
      ));
    }

    if (assist.awayDigest) {
      const d = assist.awayDigest;
      parts.push(stripHtml(
        'While away',
        `${d.contradictions} contradiction(s), ${d.duplicates} duplicate(s) awaiting review.`,
        `<button type="button" class="g-btn btn-sm ghampus-compose-action" data-action="open-checkin">Check-in</button>`,
      ));
    }

    stripsEl.innerHTML = parts.join('');

    stripsEl.querySelectorAll<HTMLButtonElement>('.ghampus-engram-chip').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (btn.dataset.action === 'open-new-engram-guide') {
          newEngramGuideOpen = true;
          if (assist.createEngramOffer && !newEngramDraftName) {
            newEngramDraftName = assist.createEngramOffer.displayName;
          }
          renderStrips(assist);
          return;
        }
        const id = btn.dataset.graphId ?? '';
        const engram = assist.engrams.find((x) => x.graphId === id);
        if (engram) {
          newEngramGuideOpen = false;
          pinnedEngramGraphId = engram.graphId;
          applyEngramToGhampusInput(input, engram, assist.slashSave);
          ctx.onInputChange();
        }
      });
    });

    const nameEl = stripsEl.querySelector<HTMLInputElement>('.ghampus-new-engram-name');
    const slugEl = stripsEl.querySelector<HTMLElement>('.ghampus-new-engram-slug');
    const syncNewEngramSlug = (): void => {
      const slug = slugifyEngramHint(nameEl?.value ?? newEngramDraftName);
      if (slugEl) slugEl.textContent = slug || '…';
      stripsEl.querySelectorAll<HTMLButtonElement>('[data-action="create-engram-guide"]').forEach((b) => {
        b.disabled = slug.length < 2;
      });
    };
    nameEl?.addEventListener('input', () => {
      newEngramDraftName = nameEl.value;
      syncNewEngramSlug();
    });
    syncNewEngramSlug();
    if (newEngramGuideOpen && nameEl) {
      nameEl.focus();
      nameEl.select();
    }

    stripsEl.querySelectorAll<HTMLButtonElement>('[data-action="create-engram-guide"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tier = btn.dataset.tier === 'sensitive' ? 'sensitive' : 'personal';
        const name = titleCaseEngramName(nameEl?.value ?? newEngramDraftName);
        const graphId = slugifyEngramHint(name);
        if (graphId.length < 2) return;
        btn.disabled = true;
        void (async () => {
          try {
            const res = await createEngramFromGuide(name, graphId, tier);
            if (!res.ok) {
              await gAlert('Could not create engram', res.error ?? 'Create failed');
              return;
            }
            newEngramGuideOpen = false;
            newEngramDraftName = '';
            dismissedCreateOfferId = graphId;
            applyCreatedEngramToGhampusInput(
              input,
              { graphId, displayName: name, tier },
              assist.slashSave,
            );
            ctx.onInputChange();
          } catch (err) {
            await gAlert('Could not create engram', err instanceof Error ? err.message : String(err));
          } finally {
            btn.disabled = false;
          }
        })();
      });
    });

    stripsEl.querySelector<HTMLSelectElement>('.ghampus-engram-picker-select')?.addEventListener('change', (e) => {
      const sel = e.currentTarget as HTMLSelectElement;
      const id = sel.value;
      if (!id) return;
      const engram = assist.engrams.find((x) => x.graphId === id);
      if (engram) {
        applyEngramToGhampusInput(input, engram, assist.slashSave);
        sel.value = '';
        ctx.onInputChange();
      }
    });

    stripsEl.querySelectorAll<HTMLButtonElement>('.ghampus-compose-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action ?? '';
        const val = input.value.trim();
        switch (action) {
          case 'use-suggested':
          case 'cross-engram': {
            const id = btn.dataset.graphId ?? '';
            const engram = assist.engrams.find((x) => x.graphId === id);
            if (engram) applyEngramToGhampusInput(input, engram, assist.slashSave);
            break;
          }
          case 'cancel-new-engram':
            newEngramGuideOpen = false;
            if (assist.createEngramOffer) {
              dismissedCreateOfferId = assist.createEngramOffer.graphId;
            }
            if (lastAssist) renderStrips(lastAssist);
            break;
          case 'edit-instead':
            ctx.onFillPrompt(val ? `/edit ${val.replace(/^(save|remember)\s+/i, '')}` : '/edit ');
            break;
          case 'save-selection':
            if (assist.selectionBridge) {
              ctx.onFillPrompt(`/save ${assist.selectionBridge.quotedText} `);
            }
            break;
          case 'expand-vague':
            if (assist.vagueReference) {
              const base = val.replace(/\b(it|that|this)\b/i, assist.vagueReference.suggestedSnippet.slice(0, 200));
              ctx.onFillPrompt(base);
            }
            break;
          case 'track-obligation':
            ctx.onFillPrompt(val.includes('deadline') ? val : `${val} (deadline tracked)`);
            break;
          case 'run-skill':
            ctx.onFillPrompt(`/preview ${btn.dataset.slug ?? ''}`);
            break;
          case 'foresight':
            ctx.onFillPrompt('walk me through memory integrity contradictions');
            break;
          case 'cite-source':
            input.value = `${input.value.replace(/@[\w\s.-]*$/, '')}@${btn.dataset.label ?? ''} `;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            break;
          case 'open-foresight':
          case 'open-checkin':
            document.querySelector<HTMLButtonElement>('[data-mode="foresight"]')?.click()
              ?? document.querySelector<HTMLButtonElement>('[data-mode="checkin"]')?.click();
            break;
          default:
            break;
        }
        ctx.onInputChange();
      });
    });
    sweepGhampusComposePres(stripsEl);
  }

  function shouldShowRail(assist: GhampusComposeAssist, text: string): boolean {
    if (ctx.shouldHide()) return false;
    if (!text.trim()) return false;
    return assist.primaryIntent !== 'idle'
      || assist.saveIntent
      || Boolean(assist.createEngramOffer)
      || Boolean(assist.awayDigest)
      || Boolean(assist.selectionBridge);
  }

  async function maybeRefineAssist(text: string, seq: number): Promise<void> {
    if (seq !== assistSeq || input.value !== text) return;
    if (!lastAssist || lastAssist.primaryIntent !== 'idle') return;
    const rSeq = ++refineSeq;
    try {
      const refine = await ipcCall<{ refined: boolean; assist?: GhampusComposeAssist }>(
        'ghampus:input:assist-refine',
        {
          text,
          selectedText: ctx.getSelectedText(),
          lastGhampusSnippet: ctx.getLastGhampusSnippet(),
          threadTurnCount: ctx.getThreadTurnCount(),
          hoursSinceActive: ctx.getHoursSinceActive(),
          pinnedEngramGraphId,
        },
      );
      if (rSeq !== refineSeq || seq !== assistSeq || input.value !== text) return;
      if (!refine.refined || !refine.assist) return;
      lastAssist = refine.assist;
      if (refine.assist.selectedEngramId) {
        pinnedEngramGraphId = refine.assist.selectedEngramId;
      }
      if (!shouldShowRail(refine.assist, text)) {
        hide();
        return;
      }
      rail.classList.remove('hidden');
      renderStrips(refine.assist);
    } catch {
      /* keep heuristic assist */
    }
  }

  async function refreshAssist(): Promise<void> {
    const text = input.value;
    if (!text.trim()) {
      hide();
      return;
    }
    if (ctx.shouldHide()) {
      hide();
      return;
    }

    const seq = ++assistSeq;
    const localSlash = text.trimStart().startsWith('/save');
    if (localSlash && text.trim().length >= 5) {
      rail.classList.remove('hidden');
    }

    await new Promise<void>((resolve) => {
      if (assistTimer) clearTimeout(assistTimer);
      assistTimer = setTimeout(() => {
        assistTimer = null;
        resolve();
      }, localSlash ? 0 : ASSIST_DEBOUNCE_MS);
    });

    if (seq !== assistSeq) return;

    try {
      const assist = await ipcCall<GhampusComposeAssist>('ghampus:input:assist', {
        text,
        selectedText: ctx.getSelectedText(),
        lastGhampusSnippet: ctx.getLastGhampusSnippet(),
        threadTurnCount: ctx.getThreadTurnCount(),
        hoursSinceActive: ctx.getHoursSinceActive(),
        pinnedEngramGraphId,
      });
      if (seq !== assistSeq || input.value !== text) return;
      lastAssist = assist;
      if (assist.selectedEngramId) {
        pinnedEngramGraphId = assist.selectedEngramId;
      }
      if (
        assist.createEngramOffer
        && assist.createEngramOffer.graphId !== dismissedCreateOfferId
        && !assist.selectedEngramId
        && newEngramGuideOpen
        && !newEngramDraftName
      ) {
        newEngramDraftName = assist.createEngramOffer.displayName;
      }
      if (!shouldShowRail(assist, text)) {
        hide();
        return;
      }
      rail.classList.remove('hidden');
      renderStrips(assist);
      if (assist.primaryIntent === 'idle' && text.trim().length >= 3) {
        void maybeRefineAssist(text, seq);
      }
    } catch {
      hide();
    }
  }

  return {
    update: () => { void refreshAssist(); },
    hide,
  };
}
