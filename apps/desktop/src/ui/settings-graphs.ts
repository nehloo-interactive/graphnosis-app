/**
 * Settings — engram graph list (archive, tier, preserve, delete, rename).
 * Extracted from main.ts (ui-modularize Batch 6).
 */
import { invoke } from '../platform';
import { app } from './app-context';
import { refreshConnectorsList } from './connectors';
import { ipcCall, invokeRetry } from './ipc';
import {
  fetchSkillsLibrary,
  renderSkillsLibrary,
  removeHiddenSkillsForGraph,
  skillsLibrary,
} from './skills';
import { escape } from './util';
import type { GraphWithMetadata } from './types';

/**
 * Render the "Graphs in this cortex" list inside Settings.
 * Shows every graph (including archived ones) with Archive/Unarchive and
 * Delete actions. Delete requires two clicks: first arms the button, second
 * confirms. Armed state resets if the user moves away.
 */
export function renderSettingsGraphsList(): void {
  const ctx = app();
  const loadedGraphs = ctx.getLoadedGraphs();
  const atlasActiveGraph = ctx.getAtlasActiveGraph();
  const container = document.getElementById('settings-graphs-list');
  if (!container) return;

  if (loadedGraphs.length === 0) {
    container.innerHTML = '<p style="font-size:14px; color:var(--fg-dim); margin:0;">No graphs loaded.</p>';
    return;
  }

  const TIER_CAPS: Record<string, string> = {
    public:    '4 000 tokens — unrestricted',
    personal:  '2 000 tokens — explicit recall only',
    sensitive: '0 tokens — AI blocked',
  };

  const renderRow = (g: GraphWithMetadata): string => {
    const archived = g.metadata.archived ?? false;
    const preserved = g.metadata.legalHold === true;
    const isActive = g.graphId === atlasActiveGraph;
    const tier = g.metadata.sensitivityTier ?? 'personal';
    const isSkillEngram = g.metadata.template === 'skill';
    const skillCount = isSkillEngram ? skillsLibrary.filter((s) => s.graphId === g.graphId).length : 0;
    const skillBadge = isSkillEngram ? `<span class="sgr-badge sgr-badge-skill" title="${skillCount} skill${skillCount === 1 ? '' : 's'}">🛠 ${skillCount}</span>` : '';
    const preservedBadge = preserved
      ? `<span class="sgr-badge sgr-badge-preserved" title="${escape(g.metadata.legalHoldMatter ? `Preserved (${g.metadata.legalHoldMatter})` : 'Preserved — forget, edit, and purge blocked until released.')}">Preserved</span>`
      : '';
    return `
      <div class="settings-graph-row${archived ? ' is-archived' : ''}${preserved ? ' is-preserved' : ''}" data-sgr-id="${escape(g.graphId)}" data-skill-count="${skillCount}">
        <span class="sgr-name" title="Click to rename" data-sgr-id="${escape(g.graphId)}" data-pres="engram:${escape(g.graphId)}">${escape(ctx.formatEngramLabel(g))}</span>
        ${archived ? '<span class="sgr-badge">archived</span>' : ''}
        ${preservedBadge}
        ${isActive ? '<span class="sgr-badge">active</span>' : ''}
        ${skillBadge}
        <select class="sgr-tier-select" data-sgr-id="${escape(g.graphId)}" title="${TIER_CAPS[tier]}"
          style="color:${tier === 'public' ? 'var(--ok)' : tier === 'sensitive' ? 'var(--error)' : 'var(--color-status-warn-gold)'}">
          <option value="public"    ${tier === 'public'    ? 'selected' : ''} style="color:var(--ok)">public</option>
          <option value="personal"  ${tier === 'personal'  ? 'selected' : ''} style="color:var(--color-status-warn-gold)">personal</option>
          <option value="sensitive" ${tier === 'sensitive' ? 'selected' : ''} style="color:var(--error)">sensitive</option>
        </select>
        <button class="btn-graph-preserve" data-sgr-id="${escape(g.graphId)}" data-preserved="${preserved}" title="${preserved ? 'Release preservation — forget, edit, and purge allowed again' : 'Preserve engram — blocks forget, edit, and purge until released'}">
          ${preserved ? 'Release' : 'Preserve'}
        </button>
        <button class="btn-graph-archive" data-sgr-id="${escape(g.graphId)}" data-archived="${archived}">
          ${archived ? 'Unarchive' : 'Archive'}
        </button>
        <button class="btn-graph-delete" data-sgr-id="${escape(g.graphId)}" data-name="${escape(g.metadata.displayName ?? g.graphId)}">
          Delete
        </button>
      </div>`;
  };

  const standard = [...loadedGraphs]
    .filter((g) => g.metadata.template !== 'skill')
    .sort((a, b) => ctx.formatEngramLabel(a).localeCompare(ctx.formatEngramLabel(b)));
  const skillEngrams = [...loadedGraphs]
    .filter((g) => g.metadata.template === 'skill')
    .sort((a, b) => ctx.formatEngramLabel(a).localeCompare(ctx.formatEngramLabel(b)));

  const standardHtml = standard.map(renderRow).join('');
  const skillsHtml = skillEngrams.length > 0
    ? `<div class="sgr-section-header">Skills Engrams</div>${skillEngrams.map(renderRow).join('')}`
    : '';
  container.innerHTML = standardHtml + skillsHtml;
  if (ctx.presActive()) ctx.applyPresentationMasking(container);

  container.querySelectorAll<HTMLButtonElement>('.btn-graph-preserve').forEach((btn) => {
    btn.addEventListener('click', () => {
      const graphId = btn.dataset['sgrId'] ?? '';
      const currentlyPreserved = btn.dataset['preserved'] === 'true';
      const g = loadedGraphs.find((gr) => gr.graphId === graphId);
      const displayName = g?.metadata.displayName ?? graphId;
      if (!graphId) return;

      const row = btn.closest<HTMLElement>('.settings-graph-row');
      if (!row) return;

      if (currentlyPreserved) {
        const ok = window.confirm(
          `Release preservation on "${displayName}"? Graphnosis will allow forget, edit, and purge again.`,
        );
        if (!ok) return;
        btn.disabled = true;
        void ipcCall('compliance.setEngramPreserve', { graphId, preserved: false })
          .then(() => {
            if (g) {
              delete g.metadata.legalHold;
              delete g.metadata.legalHoldAt;
              delete g.metadata.legalHoldMatter;
            }
            renderSettingsGraphsList();
            void ctx.refreshStats();
          })
          .catch((e) => {
            ctx.showError(`Could not release preservation: ${e}`);
            btn.disabled = false;
          });
        return;
      }

      btn.style.display = 'none';
      const archiveBtn = row.querySelector<HTMLButtonElement>('.btn-graph-archive');
      const deleteBtn = row.querySelector<HTMLButtonElement>('.btn-graph-delete');
      if (archiveBtn) archiveBtn.style.display = 'none';
      if (deleteBtn) deleteBtn.style.display = 'none';

      const confirmDiv = document.createElement('div');
      confirmDiv.className = 'sgr-confirm-preserve';
      confirmDiv.innerHTML = `
        <p class="sgr-preserve-copy">Preserve this engram? Graphnosis won't forget, edit, or purge its memory until you release preservation. Your original files aren't changed.</p>
        <details class="sgr-preserve-matter-details">
          <summary>Matter reference (optional)</summary>
          <input type="text" class="sgr-preserve-matter-input" placeholder="Case or matter label" autocomplete="off" />
        </details>
        <button class="sgr-preserve-go">Preserve engram</button>
        <button class="sgr-preserve-cancel">Cancel</button>
      `;
      row.appendChild(confirmDiv);

      const goBtn = confirmDiv.querySelector<HTMLButtonElement>('.sgr-preserve-go')!;
      const cancelBtn = confirmDiv.querySelector<HTMLButtonElement>('.sgr-preserve-cancel')!;
      const matterInput = confirmDiv.querySelector<HTMLInputElement>('.sgr-preserve-matter-input')!;

      cancelBtn.addEventListener('click', () => renderSettingsGraphsList());

      goBtn.addEventListener('click', async () => {
        goBtn.disabled = true;
        cancelBtn.disabled = true;
        matterInput.disabled = true;
        const matter = matterInput.value.trim();
        try {
          await ipcCall('compliance.setEngramPreserve', {
            graphId,
            preserved: true,
            ...(matter ? { matter } : {}),
          });
          if (g) {
            g.metadata.legalHold = true;
            g.metadata.legalHoldAt = Date.now();
            if (matter) g.metadata.legalHoldMatter = matter;
          }
          renderSettingsGraphsList();
          void ctx.refreshStats();
        } catch (e) {
          ctx.showError(`Could not preserve engram: ${e}`);
          goBtn.disabled = false;
          cancelBtn.disabled = false;
          matterInput.disabled = false;
        }
      });
    });
  });

  container.querySelectorAll<HTMLButtonElement>('.btn-graph-archive').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const graphId = btn.dataset['sgrId'] ?? '';
      const nowArchived = btn.dataset['archived'] === 'true';
      const nextArchived = !nowArchived;
      const displayName = loadedGraphs.find((g) => g.graphId === graphId)?.metadata.displayName ?? graphId;
      if (!graphId) return;

      if (nextArchived) {
        const g = loadedGraphs.find((gr) => gr.graphId === graphId);
        if (g?.metadata.template === 'skill') {
          const skillCount = skillsLibrary.filter((s) => s.graphId === graphId).length;
          if (skillCount > 0) {
            const ok = window.confirm(
              `"${g.metadata.displayName ?? g.graphId}" contains ${skillCount} trained skill${skillCount === 1 ? '' : 's'}.\n\nArchiving this engram will hide those skills from your library. Continue?`
            );
            if (!ok) return;
          }
        }
      }

      btn.disabled = true;
      try {
        await invoke('set_graph_archived', { graphId, archived: nextArchived });
        ctx.replaceLoadedGraphs(
          (await invoke('list_graphs_with_metadata', { includeUnloaded: true })) as GraphWithMetadata[],
        );
        if (nextArchived && ctx.getAtlasActiveGraph() === graphId) {
          ctx.setAtlasActiveGraph(ctx.pickAtlasGraph());
          ctx.refreshActiveEngramLabel();
        }
        await ctx.refreshAtlasView();
        renderSettingsGraphsList();
        renderSkillsLibrary();
      } catch (e) {
        ctx.showError(`Could not ${nextArchived ? 'archive' : 'unarchive'} "${displayName}": ${e}`);
        btn.disabled = false;
      }
    });
  });

  container.querySelectorAll<HTMLSpanElement>('.sgr-name').forEach((span) => {
    span.style.cursor = 'pointer';
    span.addEventListener('click', () => {
      const graphId = span.dataset['sgrId'] ?? '';
      const gRow = loadedGraphs.find((x) => x.graphId === graphId);
      const currentRaw = gRow?.metadata.displayName ?? graphId;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentRaw;
      input.className = 'sgr-rename-input';
      span.replaceWith(input);
      input.focus();
      input.select();

      const commit = async () => {
        const newName = input.value.trim();
        if (!newName || newName === currentRaw) { input.replaceWith(span); return; }
        input.disabled = true;
        try {
          await invoke('rename_graph', { graphId, displayName: newName });
          if (gRow) { gRow.metadata.displayName = newName; span.textContent = ctx.formatEngramLabel(gRow); }
          else span.textContent = newName;
        } catch (e) {
          ctx.showError(`Could not rename: ${e}`);
        } finally {
          input.replaceWith(span);
        }
      };

      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = currentRaw; input.blur(); }
      });
    });
  });

  const TIER_INFO: Record<string, { headline: string; bullets: string[]; warning?: string }> = {
    public: {
      headline: 'AI sees this engram without any consent step.',
      bullets: [
        'Up to <strong>4 000 tokens</strong> of content per recall query',
        'Proactive injection enabled — AI may surface memories unprompted',
        'Best for reference material, documentation, and public notes',
      ],
    },
    personal: {
      headline: 'AI sees this engram only with your explicit agreement.',
      bullets: [
        'Up to <strong>2 000 tokens</strong> of content per recall query',
        'A consent prompt appears in Graphnosis — you approve before anything is shown',
        'Proactive injection <strong>disabled</strong> — AI only reads when you ask it to recall',
        'Best for personal notes, journal entries, and work summaries',
      ],
    },
    sensitive: {
      headline: 'AI is blocked from this engram unless you grant access.',
      bullets: [
        '<strong>0 tokens</strong> — the sidecar returns no results for any query',
        'Access requires a typed consent phrase in Graphnosis → Settings → AI',
        'You can still browse and search these memories inside Graphnosis',
        'Best for health records, financial data, or anything strictly private',
      ],
      warning: 'The AI will not see content from this engram until you explicitly grant access via Graphnosis.',
    },
  };

  container.querySelectorAll<HTMLSelectElement>('.sgr-tier-select').forEach((sel) => {
    let prevTier = sel.value;
    sel.addEventListener('change', () => {
      const graphId = sel.dataset['sgrId'] ?? '';
      const tier = sel.value as 'public' | 'personal' | 'sensitive';
      const g = loadedGraphs.find((x) => x.graphId === graphId);
      if (!graphId) return;

      const modal = document.getElementById('tier-confirm-modal')!;
      const engramLabel = document.getElementById('tier-confirm-engram')!;
      const body = document.getElementById('tier-confirm-body')!;
      const okBtn = document.getElementById('tier-confirm-ok') as HTMLButtonElement;
      const cancelBtn = document.getElementById('tier-confirm-cancel') as HTMLButtonElement;

      const info = TIER_INFO[tier];
      engramLabel.textContent = g?.metadata.displayName ?? graphId;
      body.innerHTML = `
        <div style="padding:12px 14px; border-radius:8px; background:var(--bg-elev); border:1px solid var(--border);">
          <p style="margin:0 0 10px; font-weight:600; font-size:14px; color:var(--fg);">${tier} — ${info?.headline ?? ''}</p>
          <ul style="margin:0; padding-left:18px; display:flex; flex-direction:column; gap:5px; font-size:14px; color:var(--fg-dim);">
            ${(info?.bullets ?? []).map((b) => `<li>${b}</li>`).join('')}
          </ul>
          ${info?.warning ? `<p style="margin:10px 0 0; font-size:15px; color:#e0a055; padding:8px 10px; border-radius:6px; background:color-mix(in oklab,#e0a055 10%,transparent);">${info.warning}</p>` : ''}
        </div>`;

      modal.classList.remove('hidden');

      const cleanup = () => {
        modal.classList.add('hidden');
        okBtn.onclick = null;
        cancelBtn.onclick = null;
      };

      const TIER_COLORS: Record<string, string> = {
        public: 'var(--ok)',
        personal: 'var(--color-status-warn-gold)',
        sensitive: 'var(--error)',
      };
      const applySelColor = (t: string) => { sel.style.color = TIER_COLORS[t] ?? ''; };

      cancelBtn.onclick = () => {
        sel.value = prevTier;
        applySelColor(prevTier);
        cleanup();
      };

      okBtn.onclick = async () => {
        cleanup();
        sel.disabled = true;
        try {
          await invoke('set_graph_tier', { graphId, tier });
          if (g) g.metadata.sensitivityTier = tier;
          sel.title = TIER_CAPS[tier] ?? '';
          applySelColor(tier);
          prevTier = tier;
        } catch (e) {
          ctx.showError(`Could not update tier: ${e}`);
          sel.value = g?.metadata.sensitivityTier ?? 'personal';
          applySelColor(sel.value);
        } finally {
          sel.disabled = false;
        }
      };
    });
  });

  container.querySelectorAll<HTMLButtonElement>('.btn-graph-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const graphId = btn.dataset['sgrId'] ?? '';
      const displayName = btn.dataset['name'] ?? graphId;
      const confirmName = displayName.replace(/^(?:[\u{1F6E0}\u{1F527}]\u{FE0F}?\s*)+/u, '').trim() || displayName;
      if (!graphId) return;

      const row = btn.closest<HTMLElement>('.settings-graph-row');
      if (!row) return;

      btn.style.display = 'none';
      const archiveBtn = row.querySelector<HTMLButtonElement>('.btn-graph-archive');
      const preserveBtn = row.querySelector<HTMLButtonElement>('.btn-graph-preserve');
      if (archiveBtn) archiveBtn.style.display = 'none';
      if (preserveBtn) preserveBtn.style.display = 'none';

      const skillCount = Number(row.dataset['skillCount'] ?? 0);
      const skillWarning = skillCount > 0
        ? `<span class="sgr-confirm-skill-warning">⚠ This engram contains <strong>${skillCount} skill${skillCount === 1 ? '' : 's'}</strong>. Deleting it will permanently remove those skills and all their trained nodes.</span>`
        : '';

      const confirmDiv = document.createElement('div');
      confirmDiv.className = 'sgr-confirm-delete';
      confirmDiv.innerHTML = `
        ${skillWarning}
        <span class="sgr-confirm-label">Type <strong>${escape(confirmName)}</strong> to delete forever:</span>
        <input type="text" class="sgr-confirm-input" placeholder="type the engram name to confirm" autocomplete="off" />
        <button class="sgr-confirm-go" disabled>Delete forever</button>
        <button class="sgr-confirm-cancel">Cancel</button>
      `;
      row.appendChild(confirmDiv);

      const input = confirmDiv.querySelector<HTMLInputElement>('.sgr-confirm-input')!;
      const goBtn = confirmDiv.querySelector<HTMLButtonElement>('.sgr-confirm-go')!;
      const cancelBtn = confirmDiv.querySelector<HTMLButtonElement>('.sgr-confirm-cancel')!;

      input.focus();

      const normalize = (s: string): string => s.trim().toLowerCase();
      const target = normalize(confirmName);
      input.addEventListener('input', () => {
        goBtn.disabled = normalize(input.value) !== target;
      });

      cancelBtn.addEventListener('click', () => renderSettingsGraphsList());

      goBtn.addEventListener('click', async () => {
        goBtn.disabled = true;
        goBtn.textContent = 'Deleting…';
        cancelBtn.disabled = true;
        input.disabled = true;
        try {
          removeHiddenSkillsForGraph(graphId);

          await invokeRetry('delete_graph', { graphId });
          ctx.replaceLoadedGraphs(
            (await invokeRetry('list_graphs_with_metadata', { includeUnloaded: true })) as GraphWithMetadata[],
          );
          if (ctx.getAtlasActiveGraph() === graphId) {
            ctx.setAtlasActiveGraph(ctx.pickAtlasGraph());
            ctx.refreshActiveEngramLabel();
            ctx.clearAtlasGraphData();
          }
          await fetchSkillsLibrary();
          renderSkillsLibrary();
          await refreshConnectorsList();
          await ctx.refreshAtlasView();
          renderSettingsGraphsList();
        } catch (e) {
          ctx.showError(`Could not delete "${displayName}": ${e}`);
          input.disabled = false;
          cancelBtn.disabled = false;
          goBtn.disabled = false;
          goBtn.textContent = 'Delete forever';
        }
      });
    });
  });
}
