/**
 * Agents — the Agempi roster (feature #41). One read-only card per NON-quarantined
 * skill-template engram (an "Agempus" — a domain agent Ghampus dispatches to).
 *
 * READ-ONLY: this view visualizes routing/autonomy/vitality; ALL editing routes
 * into the existing Skills page (deep-link via activateMode('skills') +
 * openSkillInTrainer). No new write paths. L3 is selectable in the shared
 * AGEMPUS_LEVELS and drives the opt-in unattended executor (OFF by default;
 * toggle + run review live in the Unattended tab).
 *
 * Each card has five regions:
 *   1) HEADER       — engram name + .agempus-badge + family-default dial +
 *                     a vitality-at-a-glance rollup.
 *   2) SKILLS       — compact rows (label + steps + vitality grade); clicking a
 *                     row deep-links into Skills/Trainer.
 *   3) TRIGGERS     — dispatch-trigger chips (family skill-dispatch source, or a
 *                     per-skill Trigger-goal fallback — never empty).
 *   4) CALL GRAPH   — nodes = family skills, edges = skill:calls. Intra-engram
 *                     solid; cross-engram dashed + labeled (from skills.callGraph).
 *   5) AUTONOMY     — per-skill effective-level table (batched dispatchSafeReadout).
 *
 * PERF: ONE batched dispatchSafeReadout + ONE skills.callGraph on mount; per-skill
 * vitality is lazy-loaded only for the expanded/visible card (warm-on-expand +
 * a TTL cache, mirroring skills.ts).
 */
import { app } from './app-context';
import { ipcCall } from './ipc';
import { escape, escapeHtml, presEngramAttr, presSkillAttr } from './util';
import { openSkillInTrainer } from './skills';
import {
  renderAgempusDial,
  vitalityGrade,
  levelRankUi,
  perSkillReadout,
  fetchDispatchReadout,
  fetchAllDispatchReadouts,
  skillsDispatchReadoutCache,
} from './skills-shared';
import type { GraphWithMetadata } from './types';

// ── Types (mirror the read-only IPC payloads) ────────────────────────────────
interface SkillListEntry {
  sourceId: string;
  graphId: string;
  engramName: string;
  label: string;
  nodeCount: number;
  trainedAt?: string;
}

interface SkillVitality {
  score: number;
  trainedAt?: number;
  staleNodesCount: number;
  recommendation: string;
}

interface CallEdge {
  callerGraphId: string;
  callerSourceId: string;
  callerLabel: string;
  targetGraphId: string;
  targetSourceId: string;
  targetTitle: string;
  crossEngram: boolean;
  kind: 'call' | 'parallel' | 'onFailure';
}

interface CallGraphResult {
  ok: boolean;
  edges: CallEdge[];
  triggers: Record<string, string[]>;
}

// ── Module state ─────────────────────────────────────────────────────────────
const AGENTS_VITALITY_TTL_MS = 5 * 60 * 1000;
const agentsVitalityCache = new Map<string, { value: SkillVitality; fetchedAt: number }>();

let agentsSkills: SkillListEntry[] = [];
let agentsEdges: CallEdge[] = [];
let agentsTriggers: Record<string, string[]> = {};
// graphId → expanded. Default: every card expanded so the roster reads as a
// roster (collapse is a convenience for large families).
const agentsExpanded = new Set<string>();
let agentsMounted = false;
let agentsRenderGen = 0;

function getLoadedGraphs(): GraphWithMetadata[] {
  return app().getLoadedGraphs();
}

function engramDisplayName(graphId: string): string {
  const g = getLoadedGraphs().find((x) => x.graphId === graphId);
  if (g) return app().formatEngramLabel(g);
  const entry = agentsSkills.find((s) => s.graphId === graphId);
  return entry?.engramName || graphId;
}

/** A quarantined (imported-but-unpromoted) engram is NOT a promoted Agempus.
 *  Exclude it from the roster. Mirrors host.isQuarantined: quarantined while a
 *  `quarantine` block exists with any item still in the 'quarantined' state. */
function isEngramQuarantined(g: GraphWithMetadata): boolean {
  const q = g.metadata.quarantine;
  if (!q || !Array.isArray(q.items)) return false;
  return q.items.some((it) => it.state === 'quarantined');
}

/** The roster set: NON-quarantined skill-template engrams that actually have
 *  at least one listed skill. */
function rosterGraphIds(): string[] {
  const withSkills = new Set(agentsSkills.map((s) => s.graphId));
  return getLoadedGraphs()
    .filter((g) =>
      !g.metadata.archived
      && g.loaded !== false
      && g.metadata.template === 'skill'
      && !isEngramQuarantined(g)
      && withSkills.has(g.graphId),
    )
    .map((g) => g.graphId)
    .sort((a, b) => engramDisplayName(a).localeCompare(engramDisplayName(b)));
}

function skillDisplayName(label: string): string {
  // Strip the trailing "(imported …)"/"(trained …)" suffix for compact rows.
  return label.replace(/\s*\((?:imported|trained)\s+\d{4}-\d{2}-\d{2}\)\s*$/i, '').trim() || label;
}

// ── Vitality (lazy, per visible card) ────────────────────────────────────────
function cachedVitality(sourceId: string): SkillVitality | null {
  const c = agentsVitalityCache.get(sourceId);
  if (!c) return null;
  if (Date.now() - c.fetchedAt > AGENTS_VITALITY_TTL_MS) return null;
  return c.value;
}

/** Warm vitality for the skills of currently-expanded cards only. Sequential —
 *  cheap per call, and a burst of parallel recalls would hammer the sidecar.
 *  Repaints once when done. */
async function warmVisibleVitality(): Promise<void> {
  const due = agentsSkills.filter(
    (s) => agentsExpanded.has(s.graphId) && !cachedVitality(s.sourceId),
  );
  if (due.length === 0) return;
  const gen = agentsRenderGen;
  for (const skill of due) {
    try {
      const v = await ipcCall<SkillVitality | null>('skill:vitality', {
        graphId: skill.graphId,
        sourceId: skill.sourceId,
      });
      if (v) agentsVitalityCache.set(skill.sourceId, { value: v, fetchedAt: Date.now() });
    } catch (e) {
      console.warn('[agents] vitality failed for', skill.sourceId, e);
    }
  }
  if (gen === agentsRenderGen) renderAgents();
}

// ── Card region renderers ────────────────────────────────────────────────────
function renderVitalityRollup(graphId: string, skills: SkillListEntry[]): string {
  const scores = skills
    .map((s) => cachedVitality(s.sourceId)?.score)
    .filter((n): n is number => typeof n === 'number');
  if (scores.length === 0) {
    return `<span class="agents-rollup agents-rollup-pending" title="Vitality loads when this card is expanded">vitality …</span>`;
  }
  const mean = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const min = Math.min(...scores);
  const grade = vitalityGrade(mean);
  return `<span class="agents-rollup agents-vitality-grade--${grade}" title="Family vitality — mean of ${scores.length} skill${scores.length === 1 ? '' : 's'} (min ${min})">vitality ${mean} · ${grade.toUpperCase()}</span>`;
}

function renderSkillRow(skill: SkillListEntry): string {
  const vit = cachedVitality(skill.sourceId);
  const grade = vit ? vitalityGrade(vit.score) : null;
  const gradeChip = grade
    ? `<span class="agents-grade-chip agents-vitality-grade--${grade}" title="Vitality ${vit!.score}">${grade.toUpperCase()}</span>`
    : `<span class="agents-grade-chip agents-grade-chip--pending" title="Vitality loads on expand">…</span>`;
  const steps = skill.nodeCount > 0 ? `<span class="agents-skill-steps">${skill.nodeCount} step${skill.nodeCount === 1 ? '' : 's'}</span>` : '';
  return `<button type="button" class="agents-skill-row" data-agents-open-skill="${escape(skill.sourceId)}" data-agents-open-graph="${escape(skill.graphId)}" title="Open in the Skills page to view or edit"${presSkillAttr(skill.sourceId, skill.graphId)}>
    <span class="agents-skill-name">${escapeHtml(skillDisplayName(skill.label))}</span>
    ${steps}
    ${gradeChip}
  </button>`;
}

function renderTriggers(graphId: string): string {
  const lines = agentsTriggers[graphId] ?? [];
  if (lines.length === 0) {
    return `<p class="agents-region-empty">No dispatch triggers declared for this Agempus.</p>`;
  }
  const chips = lines
    .slice(0, 24)
    .map((l) => `<span class="agents-trigger-chip" title="${escapeHtml(l)}">${escapeHtml(l.replace(/^[-—]\s*/, ''))}</span>`)
    .join('');
  return `<div class="agents-trigger-chips">${chips}</div>`;
}

function renderCallGraph(graphId: string): string {
  // Edges whose caller belongs to this family. Targets may be cross-engram.
  const edges = agentsEdges.filter((e) => e.callerGraphId === graphId);
  if (edges.length === 0) {
    return `<p class="agents-region-empty">No cross-skill calls — this Agempus's skills run standalone.</p>`;
  }
  const rows = edges.map((e) => {
    const kindLabel = e.kind === 'parallel' ? 'parallel' : e.kind === 'onFailure' ? 'on failure' : 'calls';
    const crossCls = e.crossEngram ? ' agents-edge--cross' : '';
    const crossNote = e.crossEngram
      ? `<span class="agents-edge-cross-note" title="Cross-engram call">↪ ${escapeHtml(engramDisplayName(e.targetGraphId))}</span>`
      : '';
    return `<div class="agents-edge${crossCls}">
      <span class="agents-edge-from">${escapeHtml(skillDisplayName(e.callerLabel))}</span>
      <span class="agents-edge-kind">${kindLabel}</span>
      <span class="agents-edge-to">${escapeHtml(skillDisplayName(e.targetTitle))}</span>
      ${crossNote}
    </div>`;
  }).join('');
  return `<div class="agents-call-graph">${rows}</div>`;
}

function renderAutonomyTable(graphId: string, skills: SkillListEntry[]): string {
  const readout = skillsDispatchReadoutCache.get(graphId);
  if (!readout) {
    return `<p class="agents-region-empty">Autonomy readout loading…</p>`;
  }
  const rows = skills.map((s) => {
    const entry = perSkillReadout(graphId, s.sourceId);
    if (!entry) return '';
    const pinned = entry.configuredSkillLevel !== null
      && levelRankUi(entry.configuredSkillLevel) > levelRankUi(entry.cap);
    const effClass = `agents-eff-level agents-eff-level--${entry.effectiveLevel.toLowerCase()}`;
    const note = pinned
      ? `<span class="agents-autonomy-note" title="Pinned by the authored dispatch-safe cap">pinned by cap</span>`
      : entry.configuredSkillLevel === null
        ? `<span class="agents-autonomy-note">inherits</span>`
        : `<span class="agents-autonomy-note">override ${escape(entry.configuredSkillLevel)}</span>`;
    return `<tr>
      <td class="agents-autonomy-skill">${escapeHtml(skillDisplayName(entry.label || s.label))}</td>
      <td><span class="${effClass}">${escape(entry.effectiveLevel)}</span></td>
      <td class="agents-autonomy-cap" title="Authored dispatch-safe cap">cap ${escape(entry.cap)}</td>
      <td>${note}</td>
    </tr>`;
  }).join('');
  if (!rows.trim()) return `<p class="agents-region-empty">No per-skill autonomy data.</p>`;
  return `<table class="agents-autonomy-table">
    <thead><tr><th>Skill</th><th>Effective</th><th>Cap</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderAgempusCard(graphId: string): string {
  const skills = agentsSkills
    .filter((s) => s.graphId === graphId)
    .sort((a, b) => skillDisplayName(a.label).localeCompare(skillDisplayName(b.label)));
  const expanded = agentsExpanded.has(graphId);
  const bodyHidden = expanded ? '' : ' hidden';
  return `<section class="agents-card${expanded ? ' expanded' : ''}" data-agents-card="${escape(graphId)}">
    <header class="agents-card-header">
      <button type="button" class="agents-card-toggle" data-agents-toggle="${escape(graphId)}" aria-expanded="${expanded}">
        <span class="agents-card-arrow">▶</span>
        <span class="agents-card-name" data-pres="engram:${escape(graphId)}"${presEngramAttr(graphId)}>${escape(engramDisplayName(graphId))}</span>
        <span class="agempus-badge" title="This skill-template engram is an Agempus — a domain agent Ghampus can dispatch to.">Agempus</span>
        <span class="agents-card-count">${skills.length} skill${skills.length === 1 ? '' : 's'}</span>
      </button>
      ${renderVitalityRollup(graphId, skills)}
    </header>
    <div class="agents-card-body"${bodyHidden}>
      <div class="agents-card-dial">${renderAgempusDial(graphId)}</div>

      <div class="agents-region">
        <h4 class="agents-region-title">Skills</h4>
        <div class="agents-skill-rows">${skills.map(renderSkillRow).join('')}</div>
      </div>

      <div class="agents-region">
        <h4 class="agents-region-title">Dispatch triggers</h4>
        ${renderTriggers(graphId)}
      </div>

      <div class="agents-region">
        <h4 class="agents-region-title">Cross-skill call graph</h4>
        ${renderCallGraph(graphId)}
      </div>

      <div class="agents-region">
        <h4 class="agents-region-title">Per-skill autonomy</h4>
        ${renderAutonomyTable(graphId, skills)}
      </div>
    </div>
  </section>`;
}

// ── Mount / render / wire ────────────────────────────────────────────────────
function renderAgents(): void {
  agentsRenderGen += 1;
  const host = document.getElementById('agents-list');
  if (!host) return;
  const ids = rosterGraphIds();
  if (ids.length === 0) {
    host.innerHTML = `<div class="agents-empty">
      <p>No Agempi yet.</p>
      <p class="subtitle">Train a skill into a Skill-template engram (see the <a href="#" data-agents-go-skills>Autonomous Skills</a> page) and it will appear here as a domain agent.</p>
    </div>`;
    host.querySelector('[data-agents-go-skills]')?.addEventListener('click', (e) => {
      e.preventDefault();
      app().activateMode('skills');
    });
    return;
  }
  host.innerHTML = ids.map(renderAgempusCard).join('');
  wireAgentsCards(host);
  app().applyPresentationMasking(host);
}

function wireAgentsCards(host: HTMLElement): void {
  host.querySelectorAll<HTMLButtonElement>('[data-agents-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const gid = btn.dataset.agentsToggle;
      if (!gid) return;
      if (agentsExpanded.has(gid)) agentsExpanded.delete(gid);
      else {
        agentsExpanded.add(gid);
        // Lazy-load this family's vitality + autonomy readout on first expand.
        void warmVisibleVitality();
        if (!skillsDispatchReadoutCache.has(gid)) {
          void fetchDispatchReadout(gid).then(() => renderAgents());
        }
      }
      renderAgents();
    });
  });
  host.querySelectorAll<HTMLButtonElement>('[data-agents-open-skill]').forEach((row) => {
    row.addEventListener('click', () => {
      const sid = row.dataset.agentsOpenSkill;
      const gid = row.dataset.agentsOpenGraph;
      if (!sid || !gid) return;
      // Deep-link into the existing Skills page — read-only Agents view never
      // edits; all mutation lives in Skills/Trainer.
      app().activateMode('skills');
      void openSkillInTrainer(sid, gid);
    });
  });
}

/** Public entry — called by main.ts on activateMode('agents'). Fetches the
 *  batched roster data once, then repaints. Cheap re-entry: re-fetches the
 *  list/edges (in case skills changed) but reuses the autonomy + vitality
 *  caches. */
export async function renderAgentsView(): Promise<void> {
  const host = document.getElementById('agents-list');
  if (host && !agentsMounted) {
    host.innerHTML = `<p class="subtitle">Loading Agempi…</p>`;
  }
  try {
    const [list, callGraph] = await Promise.all([
      ipcCall<SkillListEntry[]>('skill:list', {}),
      ipcCall<CallGraphResult>('skills.callGraph', {}),
      fetchAllDispatchReadouts(),
    ]);
    agentsSkills = Array.isArray(list) ? list : [];
    agentsEdges = callGraph?.edges ?? [];
    agentsTriggers = callGraph?.triggers ?? {};
    // First mount: expand every roster card so it reads as a roster.
    if (!agentsMounted) {
      for (const gid of rosterGraphIds()) agentsExpanded.add(gid);
      agentsMounted = true;
    }
  } catch (e) {
    console.warn('[agents] mount fetch failed', e);
  }
  renderAgents();
  void warmVisibleVitality();
}
