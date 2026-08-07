/**
 * Agents / Agempi — the grid, and the drill-down into one agent's skills.
 *
 * This is the landing view of what used to be the Autonomous Skills page. An
 * agent is un-ganglia (its skills subgraph) plus a hippocampus (its memory), and
 * today both live in one skill-template engram — so the roster is derived from
 * the skills library rather than stored anywhere.
 *
 * PRESENTATION ONLY. The AgentRecord this reads (settings.agents) carries a hat
 * shape, a colorway, a display alias, a drag-to-group category and a
 * hide-this-tile flag, and nothing else in the product reads any of it. Recall
 * scoping, MCP `target_engram` resolution, skill routing, autonomy and consent
 * all key off the ENGRAM. Delete the entire roster and behavior is unchanged —
 * the avatars reset to their deterministic defaults and every hidden tile comes
 * back, which is a presentation reset, not a behavior change. The skill engrams
 * are the functional truth; this file is a face on top of them.
 *
 * THE ONE FUNCTIONAL STATE ON THIS PAGE IS NOT IN THE ROSTER, deliberately. The
 * agent OFF SWITCH — "fully inert": no dispatch by any route, no listing — is
 * `GraphMetadata.skillsDisabled` on the ENGRAM. Putting it in `settings.agents`
 * would break the invariant above in the worst possible direction: deleting the
 * roster would silently re-enable every agent the owner had turned off. This
 * file only READS that flag (to grey the tile and sort it last) and WRITES it
 * through one IPC (`agents.setDisabled`); the inertness itself is enforced
 * server-side, at dispatch, at the walker, at `@skill:` resolution, in the
 * library listing and in the MCP tools.
 *
 * Two views share the page, toggled by `body.agents-grid-mode`:
 *   grid   — every agent as an avatar, name, and skill-count bubble
 *   detail — the existing skills layout, its left sidebar scoped to one agent,
 *            its right-hand trainer untouched
 */

import { app } from './app-context';
import {
  renderAgempusAvatar, renderShapePicker, renderColorPicker,
  defaultShapeFor, defaultColorFor, AGEMPUS_HAT_SHAPES,
} from './agempus-avatars';
import {
  skillsLibrary, setSkillsEngramScope, resetSkillsWorkbenchForAgent,
  skillDisplayName, showSkillsToast,
  agentVitality, agentLastTrainedAt, getSkillsHiddenSet,
  fetchSkillsLibrary, skillsLibraryStatus, skillsLibraryError, warmAgentVitality,
  setSkillsSaveTargetAgent, createSkillsEngramQuiet, showSkillsComposeMode,
  pendingSopCountForEngram,
} from './skills';
import { gPrompt } from './dialogs';
import { ipcCall, isUnknownIpcMethodError } from './ipc';

/** Mirrors AgentRecord in graphnosis-app-core settings. Presentation only. */
interface AgentRecord {
  agentId: string;
  engramId: string;
  shape?: string;
  color?: string;
  alias?: string;
  group?: string;
  /** Tile not drawn on the grid. Presentation — see the note in core settings. */
  hidden?: boolean;
  createdAt: number;
}

export interface RosterEntry {
  graphId: string;
  /** Engram display name, or the agent's alias when one is set. */
  name: string;
  skillCount: number;
  record: AgentRecord | undefined;
  /**
   * The agent OFF SWITCH, read from ENGRAM metadata (`skillsDisabled`) — not
   * from `record`. Resolved once here so every consumer (the sort, the tile,
   * the home card's repaint signature) agrees about one value.
   */
  disabled: boolean;
  /** Tile suppressed from the grid. Read from `record` — presentation only. */
  hidden: boolean;
}

/** agentId-keyed roster from settings.agents, indexed by engram for pairing. */
let agentRecords = new Map<string, AgentRecord>();
/** Which agent the detail view is showing; null = grid. */
let selectedEngramId: string | null = null;

export function isAgentsGridMode(): boolean {
  return selectedEngramId === null;
}

export function selectedAgentEngramId(): string | null {
  return selectedEngramId;
}

/**
 * Load the agent records. Failure is NOT fatal and must not empty the grid: the
 * roster comes from the skills library, and records only decorate it. A cortex
 * that has never opened this page has no records at all, which is the same code
 * path — so the empty case is the normal case, not an error.
 */
export async function loadAgentRecords(): Promise<void> {
  try {
    const res = await ipcCall<{ agents?: AgentRecord[] }>('agents.list', {});
    const next = new Map<string, AgentRecord>();
    for (const a of res?.agents ?? []) {
      if (a && typeof a.engramId === 'string') next.set(a.engramId, a);
    }
    agentRecords = next;
  } catch (e) {
    console.warn('[agents] could not load agent records — rendering defaults', e);
    agentRecords = new Map();
  }
  // Records are loaded, so the roster now knows which agents are still wearing
  // a derived hat. Fire-and-forget: nothing below depends on it, and it is a
  // no-op after the first pass.
  void freezeDefaultAvatars();
}

/**
 * Hats assigned by NAME rather than left to the hash.
 *
 * Consulted only at freeze time. Once a hat is stored the pin is never read
 * again, so renaming the agent afterwards keeps the hat it was given — the pin
 * decides the FIRST hat, it does not own the agent's appearance forever.
 *
 * Matching is `name` or `name ` + anything, so "Coach" and "Coach Skills" hit
 * and "Coaching notes" does not.
 */
const AVATAR_PINS: ReadonlyArray<{ readonly match: string; readonly shape: string }> = [
  { match: 'coach', shape: 'dacian' },
];

function pinnedShapeFor(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  return AVATAR_PINS.find((p) => n === p.match || n.startsWith(`${p.match} `))?.shape;
}

/** One pass per session. Set before the first await so two concurrent callers
 *  cannot both enter the loop. */
let avatarsFrozen = false;

/**
 * Write each agent's hat and colorway down the first time we see it, so the
 * assignment survives the shape list growing.
 *
 * Why this exists: `defaultShapeFor` is `hash(seed) % SHAPES.length`, and
 * `AgentRecord.shape` is documented as "absent → deterministic default". That
 * default is deterministic for a FIXED list — append a shape and the modulus
 * changes, so every agent that never picked a hat silently gets a new one.
 * Persisting the first assignment turns "stable until we ship more hats" into
 * "stable, full stop", and costs one settings write per agent, once.
 *
 * An explicit choice is never touched: an agent is only written when it has no
 * stored shape or colour, and the stored value is what wins from then on.
 */
export async function freezeDefaultAvatars(): Promise<void> {
  if (avatarsFrozen) return;
  const roster = agentRoster();
  // An empty roster means "the library has not loaded yet", NOT "no agents to
  // freeze". Marking the pass done here would leave every avatar derived for
  // the whole session — and a later call is free, so simply return.
  if (roster.length === 0) return;
  avatarsFrozen = true;
  let changed = false;

  // ── No two agents in the same hat ────────────────────────────────────────
  // `defaultShapeFor` hashes each agent independently, so nothing stops two of
  // them landing on the same one — and with a roster of ~8 against 43 shapes a
  // collision is likelier than not (birthday paradox: ~1 in 2). Two identical
  // hats side by side on the grid read as a rendering bug, so resolve them here
  // rather than hoping.
  //
  // Shapes already written down are claimed FIRST, so a new agent moves aside
  // for an existing one and never the reverse — an agent's hat must not change
  // because a different agent was created later.
  const used = new Set<string>();
  for (const e of roster) if (e.record?.shape) used.add(e.record.shape);
  const claim = (want: string): string => {
    if (!used.has(want)) { used.add(want); return want; }
    // Walk forward from the wanted shape so the fallback is still spread across
    // the list rather than piling everyone onto index 0.
    const start = Math.max(0, AGEMPUS_HAT_SHAPES.findIndex((s) => s.id === want));
    for (let i = 1; i < AGEMPUS_HAT_SHAPES.length; i++) {
      const cand = AGEMPUS_HAT_SHAPES[(start + i) % AGEMPUS_HAT_SHAPES.length]!.id;
      if (!used.has(cand)) { used.add(cand); return cand; }
    }
    return want; // more agents than shapes — duplicates become unavoidable
  };

  // Pinned agents are assigned before hashed ones so a pin always gets the hat
  // it names, and an unpinned agent is the one that moves.
  const pending = roster
    .filter((e) => !(e.record?.shape && e.record?.color))
    .sort((a, b) => Number(!!pinnedShapeFor(b.name)) - Number(!!pinnedShapeFor(a.name)));

  for (const e of pending) {
    const shape = e.record?.shape ?? claim(pinnedShapeFor(e.name) ?? defaultShapeFor(e.graphId));
    const color = e.record?.color ?? defaultColorFor(e.graphId);
    try {
      const res = await ipcCall<{ agent?: AgentRecord }>('agents.upsert', {
        engramId: e.graphId, shape, color,
      });
      if (res?.agent) { agentRecords.set(e.graphId, res.agent); changed = true; }
    } catch (err) {
      if (isUnknownIpcMethodError(err)) {
        // An older sidecar — a remote cortex on a previous release — has no
        // `agents.upsert`. Every remaining engram would fail identically, so
        // stop rather than emit one failure per agent. Avatars stay derived,
        // which still renders correctly; they are simply not pinned yet.
        console.warn('[agents] sidecar predates agents.upsert — avatars stay derived');
        return;
      }
      console.warn('[agents] could not persist avatar for', e.graphId, err);
    }
  }
  // Only a PIN changes what is on screen (the hashed values were already being
  // drawn), but that case is real — Coach arrives wearing whatever the hash
  // gave it and has to be repainted into its pinned hat.
  if (changed) renderAgentsGrid();
}

/**
 * What the SIDECAR last told us it stored for `skillsDisabled`, per engram.
 *
 * Not a second source of truth, and not optimism: every entry is written from
 * the value the `agents.setDisabled` response RE-READ after its own write, and
 * the entry is dropped the moment the reloaded engram metadata agrees with it.
 * It exists to close the window between "the sidecar committed the flag" and
 * "this process's copy of the engram list has caught up" — without it, the tile
 * repaints from stale metadata and snaps straight back to its old state, which
 * reads exactly like a failed write.
 */
const disabledEcho = new Map<string, boolean>();

/**
 * Same role as `disabledEcho`, for tile visibility (`AgentRecord.hidden`).
 *
 * Guest / remote shells race `agents.list` and `crews.list` against hide
 * upserts — a slower list response can replace `agentRecords` with a snapshot
 * taken before the write and put the tile straight back. Echo closes that
 * window. Also covers optimistic paint before the IPC round-trip returns.
 */
const hiddenEcho = new Map<string, boolean>();

/** The off switch for one engram: the stored flag, or the sidecar's echo of a
 *  write the local engram list has not caught up with yet. */
function isAgentDisabled(graphId: string): boolean {
  const stored = app().getLoadedGraphs()
    .find((g) => g.graphId === graphId)?.metadata.skillsDisabled === true;
  const echo = disabledEcho.get(graphId);
  if (echo === undefined) return stored;
  // Caught up — the echo has nothing left to say, so stop shadowing metadata.
  if (echo === stored) { disabledEcho.delete(graphId); return stored; }
  return echo;
}

/** Tile hidden: stored record, or a hide/unhide the list reload has not caught. */
function isAgentHidden(graphId: string): boolean {
  const stored = agentRecords.get(graphId)?.hidden === true;
  const echo = hiddenEcho.get(graphId);
  if (echo === undefined) return stored;
  if (echo === stored) { hiddenEcho.delete(graphId); return stored; }
  return echo;
}

/**
 * The roster: one entry per engram that actually owns at least one skill.
 *
 * Derived from `skillsLibrary` rather than from the engram list, because an
 * engram with no skills is not an agent — it has no un-ganglia. Archived and
 * unloaded engrams are excluded to match what the library itself shows; listing
 * an agent whose skills the sidebar then refuses to display would be a lie.
 *
 * HIDDEN AGENTS ARE IN HERE. `hidden` is carried as a flag on the entry and it
 * is the GRID that drops them — not this function. Filtering here would make
 * `findAgentByName` (and through it the home card) report a hidden agent as
 * genuinely absent from the cortex, which is a different and false claim.
 *
 * DISABLED AGENTS SORT LAST, and that ordering lives here rather than in the
 * grid so every consumer sees the same sequence. Within each half the name sort
 * is unchanged.
 */
export function agentRoster(): RosterEntry[] {
  const visible = new Set(
    app().getLoadedGraphs()
      .filter((g) => !g.metadata.archived && g.loaded !== false)
      .map((g) => g.graphId),
  );
  const counts = new Map<string, number>();
  for (const s of skillsLibrary) {
    if (visible.size > 0 && !visible.has(s.graphId)) continue;
    counts.set(s.graphId, (counts.get(s.graphId) ?? 0) + 1);
  }
  // A DISABLED AGENT IS ON THE ROSTER WHETHER OR NOT THE LIBRARY STILL REPORTS
  // ITS SKILLS, and this is load-bearing rather than defensive tidying.
  //
  // "Fully inert" includes leaving the skills listing. The roster is DERIVED
  // from that listing — so the moment the listing gate lands, a gate that drops
  // rows instead of marking them takes the tile with them, and the only control
  // that can turn the agent back on goes with the tile. Turning an agent off
  // would be irreversible from this page. Keying off the engram flag directly
  // makes the tile independent of whatever the listing gate decides.
  //
  // Only engrams that are already `visible` (loaded, not archived) qualify, so
  // this cannot resurrect an archived engram as an agent.
  for (const g of app().getLoadedGraphs()) {
    if (!visible.has(g.graphId) || counts.has(g.graphId)) continue;
    if (isAgentDisabled(g.graphId)) counts.set(g.graphId, 0);
  }
  const out: RosterEntry[] = [];
  for (const [graphId, skillCount] of counts) {
    const record = agentRecords.get(graphId);
    const g = app().getLoadedGraphs().find((x) => x.graphId === graphId);
    const engramName = g ? stripLeadingIcon(app().formatEngramLabel(g)) : graphId;
    out.push({
      graphId,
      name: record?.alias || engramName,
      skillCount,
      record,
      disabled: isAgentDisabled(graphId),
      hidden: isAgentHidden(graphId),
    });
  }
  return out.sort((a, b) => {
    if (a.disabled !== b.disabled) return a.disabled ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Drop the leading emoji that `formatEngramLabel` prefixes to skill engrams.
 *
 * On every other surface that badge tells you what kind of engram you are
 * looking at. Here the avatar already does, in color and at 96px — so the
 * wrench is redundant, and it pushes every name off-center under a centered
 * circle. Only a LEADING pictograph is removed; letters, digits and punctuation
 * are untouched, so a name that legitimately begins with a symbol survives.
 */
function stripLeadingIcon(label: string): string {
  return label.replace(/^[\p{Extended_Pictographic}️‍]+\s*/u, '').trim() || label;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/** Per-engram run roll-up from `agents.activity`. Empty until it loads. */
interface AgentActivity {
  engramId: string; lastRunAt: number; runCount: number; completeCount: number; activeCount: number;
  /** Most recent skill tool call touching this engram, from the MCP audit log. */
  lastUsedAt?: number;
}
let agentActivity = new Map<string, AgentActivity>();

/**
 * True once the grid has painted for this visit.
 *
 * The staggered entrance is for ARRIVING at the roster, not for every repaint.
 * renderAgentsGrid() rebuilds innerHTML, so fresh nodes re-run the CSS animation
 * — meaning a library refresh, a crew edit, or either half of a dispatch pulse
 * (which repaints twice, 6s apart) re-assembled the whole grid under the user
 * while they were reading it. Reset only on entering the grid view.
 */
let gridHasPainted = false;

/** Engrams currently pulsing because Ghampus just dispatched to them. */
const dispatching = new Set<string>();

/** An agent with no run and no training for this long is asleep. */
const SLEEP_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export async function loadAgentActivity(): Promise<void> {
  try {
    const res = await ipcCall<{ activity?: AgentActivity[] }>('agents.activity', {});
    const next = new Map<string, AgentActivity>();
    for (const a of res?.activity ?? []) if (a?.engramId) next.set(a.engramId, a);
    agentActivity = next;
  } catch (e) {
    // A sidecar without this IPC must not blank the grid — the caption simply
    // falls back to training time, which the library already carries.
    console.warn('[agents] activity unavailable', e);
    agentActivity = new Map();
  }
}

/** "2h ago" / "3d ago" / "just now". Returns '' for 0 so callers can branch. */
function ago(ts: number): string {
  if (!ts) return '';
  const s = Math.max(0, Date.now() - ts) / 1000;
  if (s < 90) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d ago`;
  const mo = d / 30;
  if (mo < 12) return `${Math.round(mo)}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

/**
 * The caption under a name, as SEPARATE LINES.
 *
 * States what is MEASURED and nothing more. There is no acceptance signal in
 * SkillRunRecord, so this never claims one — it reports runs and completions,
 * and when an agent has never run it says so rather than showing a zero that
 * reads like a failure rate.
 *
 * ONE FACT PER LINE, and the break is chosen rather than left to the wrap. At
 * the tile's 152px these two facts never fit on one line for any agent, so the
 * joined "trained 4h ago · no recorded use" always wrapped — and it wrapped
 * mid-phrase, stranding "use" on a line of its own. The split is at exactly the
 * boundary the "·" used to sit on, so no wording changes and no fact is added
 * or dropped; only where it breaks is different.
 *
 * Returns 1 or 2 entries, never an empty one — a tile with only one fact prints
 * one line and the CSS reserves the second, so heights stay uniform without an
 * invented sentence to fill it.
 */
function captionLines(graphId: string): string[] {
  const act = agentActivity.get(graphId);
  const trainedAt = agentLastTrainedAt(graphId);
  const usedAt = act?.lastUsedAt ?? 0;
  // Prefer USE over runs. A walked skill is this agent working, and it is by far
  // the common case — most agents here have never been through the executor but
  // are used constantly. Reporting only executor runs is what produced the
  // flatly false "never run" on engrams walked all day.
  if (usedAt > 0) {
    const runs = act && act.runCount > 0 ? [`${act.completeCount}/${act.runCount} runs completed`] : [];
    return [`active ${ago(usedAt)}`, ...runs];
  }
  if (act && act.runCount > 0) return [`ran ${ago(act.lastRunAt)}`, `${act.completeCount}/${act.runCount} completed`];
  // NOT "never run". Nothing recorded is not the same as nothing happened — the
  // audit log only reaches back as far as it was kept, so this says exactly what
  // is known and no more.
  return trainedAt ? [`trained ${ago(trainedAt)}`, 'no recorded use'] : ['no recorded use'];
}

/** ms since this agent last did anything at all. Infinity = never. */
function idleFor(graphId: string): number {
  const act = agentActivity.get(graphId);
  const last = Math.max(act?.lastRunAt ?? 0, act?.lastUsedAt ?? 0, agentLastTrainedAt(graphId));
  return last === 0 ? Infinity : Date.now() - last;
}

/**
 * The two on-tile controls: the OFF SWITCH and hide/unhide.
 *
 * WHY SPANS AND NOT BUTTONS. `.agempus-tile` is itself a `<button>`, and the
 * HTML parser CLOSES an open `<button>` when it meets a nested one — a nested
 * button would silently split every tile in two and take the avatar, the name
 * and the caption out of the clickable element. `role="switch"` /
 * `role="button"` with `tabindex="0"` gives the same semantics and keyboard
 * reachability (the page's existing keydown handler serves Enter/Space) without
 * touching the parse tree. That in turn is why they are not `<input>`s either.
 *
 * WHY A SWITCH AND NOT A CHECKBOX OR A BARE ICON. A checkbox in a grid of tiles
 * reads as multi-select — "pick several of these and do something to them" —
 * which is the wrong sentence entirely. A bare power glyph is a button with no
 * state: you cannot tell by looking whether you are about to turn it on or off,
 * and a screen reader gets nothing. `role="switch"` + `aria-checked` announces
 * the state and the action, and the power glyph makes it legible at a glance.
 * Crucially it is NOT a × or a trash can: nothing here deletes anything, and a
 * destructive-looking control on a tile the user is being invited to click is
 * how an off switch gets mistaken for a delete.
 *
 * `draggable="false"` on both: without it, press-and-move on a control starts
 * the tile's drag-to-group gesture instead of activating the control, and the
 * click never arrives. The tile stays draggable everywhere else.
 */
function tileControls(e: RosterEntry, draggable: boolean): string {
  // Not on the home card — that tile is a door to the roster, and an off switch
  // reachable from the dashboard is a decision nobody asked to be offered there.
  if (!draggable) return '';
  const power = e.disabled
    ? { title: `Turn “${e.name}” back on — its skills become dispatchable and reappear in the library`, label: `Turn ${e.name} on` }
    : { title: `Turn “${e.name}” off — its skills stop dispatching (automatically, by hand, and from other agents' @skill: calls) and leave the skills library. Nothing is deleted.`, label: `Turn ${e.name} off` };
  const eye = e.hidden
    ? { title: `Unhide “${e.name}” — put its tile back on the grid`, label: `Unhide ${e.name}`, attr: 'data-agent-unhide' }
    : { title: `Hide “${e.name}”'s tile. Presentation only — its skills keep working exactly as they do now.`, label: `Hide ${e.name}`, attr: 'data-agent-hide' };
  // The eye is FIRST in the DOM so it paints above the power in the column, and
  // so tab order runs top-to-bottom the way the stack reads. Ordering visually
  // with `column-reverse` instead would leave focus travelling bottom-to-top.
  return (
    `<span class="agempus-tile-controls">` +
      `<span class="agempus-eye" role="button" tabindex="0" draggable="false"` +
        ` ${eye.attr}="${escapeHtml(e.graphId)}"` +
        ` aria-label="${escapeHtml(eye.label)}" title="${escapeHtml(eye.title)}">` +
        (e.hidden
          ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
              `<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="2.9"/>` +
            `</svg>`
          : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
              `<path d="M3.2 3.2 20.8 20.8"/>` +
              `<path d="M10.4 5.2A11 11 0 0 1 12 5c6.4 0 10 7 10 7a19 19 0 0 1-3.2 4.1"/>` +
              `<path d="M6.1 6.9A18.6 18.6 0 0 0 2 12s3.6 7 10 7a10.6 10.6 0 0 0 4.2-.85"/>` +
              `<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>` +
            `</svg>`) +
      `</span>` +
      `<span class="agempus-power" role="switch" tabindex="0" draggable="false"` +
        ` aria-checked="${e.disabled ? 'false' : 'true'}"` +
        ` data-agent-power="${escapeHtml(e.graphId)}"` +
        ` aria-label="${escapeHtml(power.label)}" title="${escapeHtml(power.title)}">` +
        `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">` +
          `<path d="M12 3.2v8.4"/><path d="M18.4 6.4a9 9 0 1 1-12.8 0"/>` +
        `</svg>` +
      `</span>` +
    `</span>`
  );
}

/**
 * One tile.
 *
 * `draggable` is the one thing that is not universal about it: dragging a tile
 * means "group these two agents", which only has a meaning where a second tile
 * exists to drop it on. The home card passes false so a stray drag there cannot
 * start a gesture that can never complete — and, now, so it carries no on-tile
 * controls either (see `tileControls`).
 */
function tile(e: RosterEntry, index = 0, draggable = true): string {
  const vit = agentVitality(e.graphId);
  const asleep = idleFor(e.graphId) > SLEEP_AFTER_MS;
  const busy = dispatching.has(e.graphId) || (agentActivity.get(e.graphId)?.activeCount ?? 0) > 0;
  const cls =
    'agempus-tile' + (asleep ? ' is-asleep' : '') + (busy ? ' is-busy' : '')
    // `is-living` is the IDLE BOB, and an inert agent must not fidget — a
    // greyed tile that still breathes contradicts the state it is showing.
    // `is-busy` is deliberately NOT suppressed: if a run really is in flight
    // it stays visible, because hiding a fact to make a claim look tidier is
    // how a UI starts lying.
    + (vit !== undefined && !asleep && !e.disabled ? ' is-living' : '')
    + (e.disabled ? ' is-disabled' : '')
    + (e.hidden ? ' is-hidden-agent' : '');
  // Vitality ring: a conic sweep behind the avatar. Only drawn when vitality is
  // actually KNOWN — an unloaded cache is not a score of zero, and rendering it
  // as one would report every agent as dead on first paint.
  const ring = vit === undefined
    ? ''
    : `<span class="agempus-ring" style="--vit-turn:${(vit / 100).toFixed(3)}turn;--vit-hue:${Math.round(vit * 1.2)};"></span>`;
  // Idle motion scaled by vitality: a fresh agent bobs briskly and widely, a
  // decaying one barely stirs. Computed here rather than in CSS because the
  // mapping is non-linear — amplitude has to reach ~0 well before vitality does,
  // or a nearly-dead agent still looks busy.
  const t = vit === undefined ? 0 : Math.max(0, Math.min(100, vit)) / 100;
  const amp = (t * t * 3.4).toFixed(2);        // px — quadratic, so low scores go still
  const dur = (7.5 - t * 4.6).toFixed(2);      // s  — 7.5s at 0 → 2.9s at 100
  const tilt = (t * 1.6).toFixed(2);           // deg of sway
  const life = vit === undefined
    ? ''
    : `--vit-amp:${amp}px;--vit-dur:${dur}s;--vit-tilt:${tilt}deg;`;
  // Staggered entrance. Capped so a large roster still finishes in about a
  // second — an animation the user has to WAIT through stops being delight and
  // becomes latency.
  const enter = gridHasPainted ? '' : `--enter-delay:${Math.min(index * 55, 900)}ms;`;
  const pendingSops = pendingSopCountForEngram(e.graphId);
  const vitTitle = vit === undefined ? '' : ` · vitality ${vit}`;
  const stateTitle = (e.disabled ? ' · OFF' : '') + (e.hidden ? ' · hidden' : '');
  const pendingTitle = pendingSops > 0 ? ` · ${pendingSops} Proposed SOP${pendingSops === 1 ? '' : 's'}` : '';
  return (
    `<button type="button" class="${cls}" style="${life}${enter}" draggable="${draggable}" data-agent-engram="${escapeHtml(e.graphId)}"` +
    ` title="${escapeHtml(e.name)} — ${e.skillCount} skill${e.skillCount === 1 ? '' : 's'}${vitTitle}${pendingTitle}${asleep ? ' · asleep' : ''}${stateTitle}">` +
      tileControls(e, draggable) +
      `<span class="agempus-tile-av">` +
        ring +
        renderAgempusAvatar({ seed: e.graphId, shapeId: e.record?.shape, colorId: e.record?.color, size: 124 }) +
        // Spell out the unit. A bare "27" on an avatar reads as a badge count —
        // unread items, notifications — which is the opposite of what it means.
        //
        // "0 skills" on a disabled agent would be a FALSE claim about the agent
        // rather than a fact about it: the count comes from the skills library,
        // which an inert agent has left, and the skills themselves are all still
        // there. Say what is actually known instead.
        `<span class="agempus-tile-count">` +
          (e.disabled && e.skillCount === 0
            ? 'off'
            : `${e.skillCount} skill${e.skillCount === 1 ? '' : 's'}`) +
        `</span>` +
        (pendingSops > 0
          ? `<span class="agempus-tile-sops" title="${pendingSops} Proposed SOP${pendingSops === 1 ? '' : 's'} awaiting Accept">${pendingSops}</span>`
          : '') +
        (asleep ? `<span class="agempus-zzz" aria-hidden="true">z</span>` : '') +
      `</span>` +
      `<span class="agempus-tile-name">${escapeHtml(e.name)}</span>` +
      // One span per fact. The container reserves two lines' height whether or
      // not both are present, so a one-fact tile is exactly as tall as its
      // two-fact neighbor and the grid stays level.
      `<span class="agempus-tile-caption">` +
        // A greyed tile has to SAY why it is grey. Color alone is not a cause,
        // it is not available to anyone who cannot see it, and it is exactly
        // the "shown as empty with no cause named" shape this page keeps
        // getting wrong. The state line replaces the leading activity fact
        // rather than being added to it — "off" over "active 2h ago" is a
        // contradiction, and the caption only has room for two lines.
        (e.disabled
          ? ['off — no dispatch', ...captionLines(e.graphId).slice(0, 1)]
          : captionLines(e.graphId))
          .map((line) => `<span class="agempus-tile-caption-line">${escapeHtml(line)}</span>`)
          .join('') +
      `</span>` +
    `</button>`
  );
}

/**
 * The "+ New agent" tile — first cell of the grid, and the only thing here that
 * is an ACTION rather than an agent.
 *
 * Deliberately NOT `.agempus-tile`, and that is load-bearing in three places:
 *   - the click handler opens an agent from `.agempus-tile[data-agent-engram]`;
 *   - `dragover` only calls preventDefault over an `.agempus-tile`, so without
 *     the class this can never become a drop target and an agent cannot be
 *     grouped "into" it;
 *   - the drop handler reads `data-agent-engram` off the same selector.
 * It also carries no avatar, no vitality ring and no skill-count blob, so there
 * is nothing on it that could be read as an agent that already exists.
 *
 * Not draggable: `<button>` is not draggable by default and nothing sets it, so
 * a drag started here produces no `text/graphnosis-agent` payload and the drop
 * handlers ignore it.
 */
function newAgentTile(): string {
  // IT DOES NOT JOIN THE ENTRANCE, and that is a decision rather than an
  // omission. This tile is already on screen during "Loading agents…" — the
  // empty branch of renderAgentsGrid() renders it — so when the roster lands and
  // the staggered entrance plays, animating it too would fade a tile the user
  // has been looking at back to zero and in again. A visible blink, and a claim
  // that it just arrived when it did not. The agents arrive; the furniture stays
  // put. Nothing here touches `gridHasPainted`, so the one-shot gating on the
  // agent tiles is exactly as it was.
  return (
    `<button type="button" class="agempus-new-tile" id="btn-agempus-new"` +
    ` title="Create a new agent — its own Skills engram, with the trainer open on its first skill">` +
      `<span class="agempus-new-mark" aria-hidden="true">+</span>` +
      `<span class="agempus-new-name">New agent</span>` +
      `<span class="agempus-new-caption">Its own Skills engram — train its first skill</span>` +
    `</button>`
  );
}

/**
 * Create an agent from the grid: a Skills engram, then straight into it.
 *
 * Reuses `createSkillsEngramQuiet()` — the exact call the trainer's
 * "+ Create Skill engram" button ends in — rather than a second creation path,
 * so engram-limit handling, slug collision suffixing, the metadata reload and
 * the picker refresh all stay in one place. Navigation is `enterAgentView()`
 * for the same reason.
 *
 * A brand-new engram owns no skills, so it is NOT in `agentRoster()` yet and its
 * tile will not appear on the grid until its first skill is trained. That is why
 * this lands the user IN the agent rather than back on the roster — returning to
 * a grid that does not show what you just made reads as a failure.
 */
async function createAgentFromGrid(): Promise<void> {
  const raw = await gPrompt(
    'New agent',
    'Name this agent. Graphnosis creates a Skills engram for it and opens the trainer on its first skill.',
    { placeholder: 'e.g. Coding Skills', secret: false },
  );
  if (raw === null) return;                      // canceled — nothing created
  const name = raw.trim();
  if (!name) return;
  const graphId = await createSkillsEngramQuiet(name);
  if (!graphId) return;                          // failed; the toast already said why
  // Decoration for an agent that has never been opened does not exist yet, and
  // the header reads from these maps — load them before painting, or the first
  // render shows defaults that then change under the user.
  await loadAgentRecords();
  enterAgentView(graphId);
  // The trainer may still be showing the previous agent's skill in review mode.
  showSkillsComposeMode();
}

// ── The default agent, and its tile on the Stats / Cortex home card ─────────

/**
 * Which agent the home card prefers, BY NAME (not graphId — ids are minted
 * per cortex). New cortexes ship Ghampus Hush present-but-OFF; Onboarding is
 * live from day one. Legacy cortexes may still use "Ghampus Skills".
 *
 * Resolution order is in `resolveHomeAgentEntry()`: powered-on Ghampus first,
 * else Onboarding so first-run Home is never an empty "no agent named…" box.
 */
const HOME_AGENT_GHAMPUS_NAMES = ['Ghampus Hush', 'Ghampus Skills'] as const;
const HOME_AGENT_ONBOARDING_NAME = 'Onboarding';

/**
 * Loose key for name matching: case, spacing, punctuation and the engram-kind
 * emoji `formatEngramLabel` prefixes all fall out, so "🔧 Ghampus Hush",
 * "Ghampus hush" and "ghampus-hush" are one name.
 */
function nameKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Home-card agent: powered-on Ghampus when the owner has flipped it on;
 * otherwise Onboarding (the default Agempi that installs live). If Onboarding
 * is missing too, fall through to a powered-off Ghampus tile rather than a
 * blank absent note — the power switch is the recovery path.
 */
function resolveHomeAgentEntry(): RosterEntry | undefined {
  for (const name of HOME_AGENT_GHAMPUS_NAMES) {
    const ghampus = findAgentByName(name);
    if (ghampus && !ghampus.disabled) return ghampus;
  }
  const onboarding = findAgentByName(HOME_AGENT_ONBOARDING_NAME);
  if (onboarding) return onboarding;
  for (const name of HOME_AGENT_GHAMPUS_NAMES) {
    const ghampus = findAgentByName(name);
    if (ghampus) return ghampus;
  }
  return undefined;
}

/**
 * Find a roster entry by display name.
 *
 * Checks the roster label first (which is the agent's alias when one is set),
 * then the underlying engram name — otherwise renaming an agent's alias would
 * make the default agent unfindable even though its engram never moved.
 * Returns undefined when the engram is missing, unloaded or archived, because
 * `agentRoster()` already excludes all three; the caller must render that as
 * absence rather than as an empty tile.
 */
export function findAgentByName(name: string): RosterEntry | undefined {
  const want = nameKey(name);
  if (!want) return undefined;
  const roster = agentRoster();
  const byLabel = roster.find((e) => nameKey(e.name) === want);
  if (byLabel) return byLabel;
  const g = app().getLoadedGraphs().find((x) => nameKey(app().formatEngramLabel(x)) === want);
  return g ? roster.find((e) => e.graphId === g.graphId) : undefined;
}

/**
 * Load the roster decoration + activity roll-up once, for the home card.
 *
 * The Agents page loads both on entry; the home card renders long before the
 * user has ever been there. Without them the tile would wear a default hat and
 * caption an agent that has been used all week as "no recorded use" — a
 * fabricated line, which is worse than showing nothing.
 */
/** Last graphId we warmed meta for — re-run when Home switches Onboarding ↔ Ghampus. */
let homeAgentMetaRequestedFor: string | null = null;
function ensureHomeAgentMeta(entry: RosterEntry): void {
  if (homeAgentMetaRequestedFor === entry.graphId) return;
  homeAgentMetaRequestedFor = entry.graphId;
  // Both loaders swallow their own failures and fall back to empty maps, so a
  // sidecar without these IPCs degrades the caption instead of the tile.
  //
  // warmAgentVitality joins them because the ring and the idle bob are already
  // in `tile()` and read `agentVitality()`, which is undefined until something
  // fills the vitality cache. On the Agents page mountSkillsPane() does that;
  // Home never called anything that would, so the tile would have rendered
  // ringless and motionless — reporting an unasked question as "no life".
  void Promise.all([loadAgentRecords(), loadAgentActivity(), warmAgentVitality(entry.graphId)])
    .then(() => renderHomeAgentTile());
}

/**
 * Load the skills library for the home card, once.
 *
 * THE BUG THIS FIXES: the roster is derived from `skillsLibrary`, and the only
 * unconditional caller of `fetchSkillsLibrary()` is `mountSkillsPane()`, which
 * runs on entry to the Skills / Agents studio tool. Every other call site is
 * behind a user action (import, demo ingest, presentation mode) or gated on
 * that tool already being active. A session that never opened Agents / Agempi
 * therefore left the library empty and `skillsLibraryLoadOk` false forever —
 * and the card's loading branch keyed off exactly that flag. Permanent
 * skeleton, indistinguishable from a hang. Home now asks for the library
 * itself instead of waiting for another page to do it.
 *
 * COST: one IPC (`skill:list`), which the sidecar answers from its in-memory
 * graph — no disk read, no LLM, no per-skill follow-up. Vitality is the
 * expensive part and it is NOT paid here: it is deferred to
 * `ensureHomeAgentMeta`, which only runs once an agent has actually been found,
 * and is capped at SKILLS_VITALITY_AUTO_CAP calls.
 *
 * WHEN: on the card's own render rather than at app init. `initAgentsGrid()`
 * runs while the cortex may still be locked, and `skill:list` against a locked
 * or not-yet-connected sidecar answers with an error or an empty list — which
 * this card would then render as a confident "no default agent", a false clean.
 * The unlock gate below defers to the first render after the app shell is
 * visible; `renderHomeDashboard()` re-runs on every Home refresh, so no extra
 * plumbing is needed to retry.
 */
let homeLibraryRequested = false;
function ensureHomeAgentLibrary(): void {
  if (homeLibraryRequested) return;
  // Someone else already owns this load (the Agents page, an import) or has
  // already answered it. Latch and stay out of the way — a second skill:list
  // would be pure duplication, and `skills:library-changed` already repaints
  // this card when theirs lands. 'error' is deliberately NOT in this set: it is
  // the state the Try-again button clears the latch to get back to.
  const status = skillsLibraryStatus();
  if (status === 'loading' || status === 'ok') { homeLibraryRequested = true; return; }
  // Not before the cortex is open — see WHEN above. Same check main.ts uses.
  if (document.getElementById('view-app')?.classList.contains('hidden') !== false) return;
  homeLibraryRequested = true;
  // fetchSkillsLibrary() never rejects: it records the failure in the library's
  // own state, which skillsLibraryStatus() then reports as 'error'. So this
  // repaint runs on BOTH paths, and a failed load lands on the error branch
  // below rather than leaving the skeleton up.
  void fetchSkillsLibrary().then(() => renderHomeAgentTile());
}

/**
 * The default agent's tile on the Stats / Cortex home card.
 *
 * Renders the SAME `tile()` the roster grid renders — not a lookalike. A second
 * copy of that markup would drift from the grid the first time either changed,
 * and the two pages would then disagree about the same agent.
 *
 * Four states, deliberately distinguishable:
 *   present  — the real tile.
 *   loading  — the skills library has not come back yet. The roster is derived
 *              from it, so "no agent" is not yet knowable.
 *   absent   — the library loaded and neither Ghampus nor Onboarding is in it.
 *              Explained, with a door to the Agents page. Never a tile with
 *              invented numbers, and never a bare empty box.
 *   error    — the library FAILED to load. Split out of `loading` because they
 *              used to share a branch (`!skillsLibraryLoadOk`), which meant a
 *              failed skill:list showed a spinner that could never resolve. A
 *              permanent spinner is a lie shaped exactly like a hang; this says
 *              what broke and offers the retry.
 */
export function renderHomeAgentTile(): void {
  const host = document.getElementById('home-agent-tile');
  if (!host) return;
  // Ahead of the signature short-circuit below: on a session that never opens
  // Agents / Agempi this is the only thing that will ever load the library, and
  // a repeat render with an unchanged signature is precisely the case that must
  // still be allowed to kick it. Latched internally, so it is one IPC per
  // session, not one per Home repaint.
  ensureHomeAgentLibrary();
  const entry = resolveHomeAgentEntry();
  const status = skillsLibraryStatus();
  let html: string;
  let sig: string;
  if (entry) {
    ensureHomeAgentMeta(entry);
    html = tile(entry, 0, false);
    // Joined only to key the repaint — the tile itself renders the lines apart.
    //
    // `disabled` and `hidden` are IN the signature. Without them, turning the
    // default agent off from the Agents page leaves this card painting the old
    // bright tile forever — the sig would not have changed, so the guard below
    // would short-circuit the repaint and the two pages would disagree about
    // the same agent. (The card still SHOWS a hidden agent, deliberately:
    // hiding suppresses the grid tile, and reporting a present agent as absent
    // here would be a different and false claim.)
    //
    // Which name we resolved (Ghampus vs Onboarding fallback) is also in the
    // sig so powering Ghampus on/off swaps the tile instead of sticking.
    sig = `at:${entry.graphId}:${entry.name}:${entry.skillCount}:${agentVitality(entry.graphId) ?? '-'}`
      + `:${entry.disabled ? 'off' : 'on'}:${entry.hidden ? 'hid' : 'vis'}`
      + `:${captionLines(entry.graphId).join(' · ')}`;
  } else if (status === 'error') {
    const why = skillsLibraryError();
    html =
      `<p class="home-agent-tile-note subtitle">Couldn’t load agents${why ? ` — ${escapeHtml(why)}` : ''}.</p>` +
      `<button type="button" class="home-agent-tile-link" data-home-agents-retry>Try again</button>`;
    // Keyed on the message so a second, different failure repaints.
    sig = `error:${why ?? ''}`;
  } else if (status === 'ok') {
    html =
      `<p class="home-agent-tile-note subtitle">No Onboarding or Ghampus agent in this cortex yet — ` +
      `open Agents / Agempi to install the defaults, or turn Ghampus Hush on.</p>` +
      `<button type="button" class="home-agent-tile-link" data-home-agents-open>Open Agents / Agempi</button>`;
    sig = 'absent';
  } else {
    html =
      `<div class="home-skel"></div>` +
      `<p class="home-agent-tile-note subtitle">Loading agents…</p>`;
    sig = 'loading';
  }
  // Repaint only on a real change. renderHomeDashboard() runs on every Home
  // refresh, and rebuilding the node would restart the avatar's idle animation
  // each time — the tile would twitch while the user was looking at it.
  if (host.dataset['sig'] === sig) return;
  host.dataset['sig'] = sig;
  host.innerHTML = html;
}

/**
 * Pulse an agent because Ghampus just routed to it.
 *
 * Fired from the chat's "Handled by {Agempus}" render — a real dispatch, not a
 * timer. The pulse decays on its own so a missed clear cannot leave an avatar
 * breathing forever.
 */
export function markAgentDispatched(engramId: string): void {
  dispatching.add(engramId);
  if (isAgentsGridMode()) renderAgentsGrid();
  setTimeout(() => {
    dispatching.delete(engramId);
    if (isAgentsGridMode()) renderAgentsGrid();
  }, 6000);
}

// ── The two on-tile writes ───────────────────────────────────────────────────

/**
 * Flip the agent OFF SWITCH.
 *
 * Writes ENGRAM metadata via `agents.setDisabled`, NOT the agent record — see
 * the invariant note at the top of this file. Nothing here is optimistic: the
 * tile only changes once the sidecar has answered with what it RE-READ after
 * its own write, so a write that silently failed shows as a tile that did not
 * move plus a toast, rather than as a tile that flips and quietly reverts on
 * the next repaint.
 *
 * `reloadGraphsMetadata()` is what makes it durable in this process — the flag
 * lives on the engram list, and until that reloads our copy still says the old
 * thing. `disabledEcho` covers the gap; see its note.
 */
async function setAgentDisabled(graphId: string, disabled: boolean): Promise<void> {
  let stored: boolean;
  try {
    const res = await ipcCall<{ ok?: boolean; disabled?: boolean; error?: unknown }>(
      'agents.setDisabled', { graphId, disabled },
    );
    // A sidecar that predates this IPC answers without the field. Treating a
    // missing answer as success is how a no-op looks like a working control.
    if (typeof res?.disabled !== 'boolean') throw new Error('no stored state returned');
    stored = res.disabled;
  } catch (e) {
    console.warn('[agents] could not set the agent off switch', e);
    showSkillsToast(
      `Could not turn that agent ${disabled ? 'off' : 'on'} — the sidecar may need a rebuild.`,
      'error',
    );
    return;
  }
  disabledEcho.set(graphId, stored);
  renderAgentsGrid();          // immediate, from the value the sidecar stored
  await app().reloadGraphsMetadata();
  renderAgentsGrid();          // …and again once metadata agrees, which clears the echo
  renderHomeAgentTile();
}

/**
 * Hide or unhide a tile. PRESENTATION — nothing about the agent changes.
 *
 * Re-renders from the record the SIDECAR stored (the `agents.upsert` contract),
 * for the same reason `saveAgent` does: a field dropped by a schema mismatch
 * then shows up as a tile that did not move, instead of as a silent no-op that
 * looked like success.
 *
 * Unhiding leaves `revealHidden` exactly as it is. Collapsing the reveal the
 * moment the last agent is unhidden would yank the remaining rows out from
 * under a user who is working through several of them.
 */
async function setAgentHidden(graphId: string, hidden: boolean): Promise<void> {
  // Paint immediately — remote IPC can take hundreds of ms, and a toast that
  // says "hidden" while the tile is still sitting there is the bug report.
  hiddenEcho.set(graphId, hidden);
  const prev = agentRecords.get(graphId);
  if (prev) {
    const next: AgentRecord = { ...prev };
    if (hidden) next.hidden = true;
    else delete next.hidden;
    agentRecords.set(graphId, next);
  } else if (hidden) {
    agentRecords.set(graphId, {
      agentId: `pending:${graphId}`,
      engramId: graphId,
      createdAt: Date.now(),
      hidden: true,
    });
  }
  renderAgentsGrid();
  renderHomeAgentTile();

  try {
    const res = await ipcCall<{ ok?: boolean; agent?: AgentRecord }>(
      'agents.upsert', { engramId: graphId, hidden },
    );
    // Older host sidecars strip unknown fields and still return ok — treat a
    // missing/mismatched `hidden` as failure so we never toast a no-op.
    const storedHidden = res?.agent?.hidden === true;
    if (storedHidden !== hidden) {
      throw new Error(
        res?.agent
          ? 'hide flag not persisted on agent record'
          : 'no stored agent returned',
      );
    }
    agentRecords.set(res.agent!.engramId, res.agent!);
    hiddenEcho.set(graphId, hidden);
  } catch (e) {
    console.warn('[agents] could not change tile visibility', e);
    hiddenEcho.delete(graphId);
    await loadAgentRecords();
    renderAgentsGrid();
    renderHomeAgentTile();
    showSkillsToast(
      `Could not ${hidden ? 'hide' : 'unhide'} that agent — the sidecar may need a rebuild.`,
      'error',
    );
    return;
  }
  if (hidden) {
    // Say where it went, and say it survived. A tile that vanishes with no
    // sentence attached is indistinguishable from a delete, and this control
    // sits next to one that is genuinely a state change.
    showSkillsToast('Hidden from the grid. Its skills are unaffected.', 'success');
  }
  renderAgentsGrid();
  renderHomeAgentTile();
}

/** Crews, keyed by crewId. Loaded alongside the roster. */
interface CrewRecord {
  crewId: string; name: string; brief?: string;
  autonomy?: 'L0' | 'L1' | 'L2' | 'L3'; createdAt: number;
}
let crews = new Map<string, CrewRecord>();

export async function loadCrews(): Promise<void> {
  try {
    const res = await ipcCall<{ crews?: CrewRecord[]; agents?: AgentRecord[] }>('crews.list', {});
    const next = new Map<string, CrewRecord>();
    for (const c of res?.crews ?? []) if (c?.crewId) next.set(c.crewId, c);
    crews = next;
    // crews.list also self-heals pre-crews group strings, so take its agents
    // back rather than keeping a copy that may now point at a stale label.
    if (res?.agents) {
      const m = new Map<string, AgentRecord>();
      for (const a of res.agents) if (a?.engramId) m.set(a.engramId, a);
      agentRecords = m;
    }
  } catch (e) {
    console.warn('[agents] crews unavailable', e);
    crews = new Map();
  }
}

/**
 * Propose a crew name for two agents being grouped for the first time.
 *
 * Deliberately dumb and local: the longest word both names share, else a
 * neutral fallback. It is a SUGGESTION that lands in an editable field the user
 * must confirm — never applied on its own. A cleverer suggestion that applied
 * itself would be worse than a dull one the user approves.
 */
function suggestCrewName(a: string, b: string): string {
  const stop = new Set(['skills', 'skill', 'the', 'and', 'my', 'agent', 'agents']);
  const words = (s: string): string[] =>
    s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !stop.has(w));
  const shared = words(a).filter((w) => words(b).includes(w))
    .sort((x, y) => y.length - x.length);
  const pick = shared[0];
  return pick ? pick[0]!.toUpperCase() + pick.slice(1) : 'New crew';
}

async function assignToCrew(engramId: string, crewId: string | null): Promise<void> {
  await ipcCall('agents.upsert', { engramId, group: crewId });
  await loadAgentRecords();
  await loadCrews();
  renderAgentsGrid();
}

/** Drop A onto B: put both into a crew. Asks for the name, pre-filled. */
async function groupAgents(draggedId: string, targetId: string): Promise<void> {
  if (draggedId === targetId) return;
  const roster = agentRoster();
  const a = roster.find((e) => e.graphId === draggedId);
  const b = roster.find((e) => e.graphId === targetId);
  if (!a || !b) return;
  // If the target is already in a crew, join it rather than asking again —
  // dragging onto a crew member obviously means "add to that crew".
  const targetCrew = b.record?.group;
  if (targetCrew && crews.has(targetCrew)) { await assignToCrew(draggedId, targetCrew); return; }
  const proposed = suggestCrewName(a.name, b.name);
  const name = window.prompt(
    `Group “${a.name}” and “${b.name}” into a crew.\n\nName this crew:`, proposed,
  );
  if (name === null) return;              // canceled — nothing changes
  const finalName = name.trim() || proposed;
  const res = await ipcCall<{ crew?: CrewRecord }>('crews.upsert', { name: finalName });
  const crewId = res?.crew?.crewId;
  if (!crewId) { showSkillsToast('Could not create the crew.', 'error'); return; }
  await ipcCall('agents.upsert', { engramId: targetId, group: crewId });
  await assignToCrew(draggedId, crewId);
}

function crewHeader(crew: CrewRecord, memberCount: number): string {
  const lvl = crew.autonomy ?? '';
  const dial = (['L0', 'L1', 'L2', 'L3'] as const).map((l) =>
    `<button type="button" class="agempus-crew-lvl${l === lvl ? ' is-on' : ''}"` +
    ` data-crew-autonomy="${crew.crewId}" data-level="${l}">${l}</button>`).join('');
  return (
    `<div class="agempus-crew" data-crew="${escapeHtml(crew.crewId)}">` +
      `<div class="agempus-crew-top">` +
        `<span class="agempus-crew-name" data-crew-rename="${escapeHtml(crew.crewId)}"` +
          ` role="button" tabindex="0" title="Rename crew">${escapeHtml(crew.name)}</span>` +
        `<span class="agempus-crew-count">${memberCount}</span>` +
        `<span class="agempus-crew-dial" title="Apply one autonomy level to every member. Each skill's authored dispatch-safe cap still wins.">${dial}</span>` +
        `<button type="button" class="agempus-crew-x" data-crew-forget="${escapeHtml(crew.crewId)}" title="Disband crew (agents and skills are untouched)">×</button>` +
      `</div>` +
      `<p class="agempus-crew-brief" data-crew-brief="${escapeHtml(crew.crewId)}" role="button" tabindex="0"` +
        ` title="Click to edit the crew brief">` +
        (crew.brief ? escapeHtml(crew.brief) : '<span class="agempus-crew-brief-empty">+ add a shared brief</span>') +
      `</p>` +
    `</div>`
  );
}

/**
 * THE WAY BACK TO A HIDDEN AGENT.
 *
 * Hiding removes the tile, and the tile is the only place the unhide control
 * can live — so without something here, hiding an agent is a one-way door and
 * the grid becomes "shorter than it was, for no stated reason". That is the
 * exact defect shape this page has already had to fix more than once.
 *
 * A dropdown was rejected and so was permanent chrome, so this is neither: a
 * single line at the FOOT of the grid that DOES NOT EXIST unless the user has
 * hidden something. On every cortex that has never used the feature there is
 * nothing extra on the page at all; the moment there is, the page names the
 * cause and offers the way back, and it goes away again on the last unhide.
 * Session-scoped on purpose — revealing is a look, not a setting, so it does
 * not persist and cannot leave the grid in a state the user forgot they set.
 */
let revealHidden = false;

function hiddenFoot(hiddenCount: number): string {
  if (hiddenCount === 0) return '';
  const n = `${hiddenCount} agent${hiddenCount === 1 ? '' : 's'}`;
  return (
    `<p class="agempus-hidden-foot">` +
      `<button type="button" class="agempus-hidden-toggle" id="btn-agempus-reveal-hidden"` +
        ` aria-expanded="${revealHidden ? 'true' : 'false'}"` +
        ` title="${revealHidden
          ? 'Collapse the hidden agents again. They keep working either way — hiding is presentation only.'
          : 'Show the hidden agents so you can unhide them. Hiding never stopped their skills working.'}">` +
        (revealHidden ? `Done — collapse ${n} again` : `${n} hidden — show`) +
      `</button>` +
    `</p>`
  );
}

/**
 * Stable fingerprint of what the grid would paint. Used to skip no-op
 * rebuilds — first open fires renderAgentsGrid several times (mountSkillsPane
 * → library-changed → records/activity/crews), and each wipe+fill restarts
 * the entrance animation (opacity 0) while `is-entering` is still on the host.
 */
function agentsGridSignature(
  roster: RosterEntry[],
  hiddenCount: number,
  emptyKey: string | null,
): string {
  if (emptyKey !== null) return emptyKey;
  const crewPart = [...crews.values()]
    .map((c) => `${c.crewId}:${c.name}:${c.autonomy ?? ''}:${c.brief ?? ''}`)
    .sort()
    .join('|');
  const tiles = roster.map((e) => {
    const r = e.record;
    return [
      e.graphId,
      e.skillCount,
      e.disabled ? 1 : 0,
      e.hidden ? 1 : 0,
      agentVitality(e.graphId) ?? '-',
      captionLines(e.graphId).join('·'),
      r?.group ?? '',
      r?.shape ?? '',
      r?.color ?? '',
      dispatching.has(e.graphId) ? 1 : 0,
      agentActivity.get(e.graphId)?.activeCount ?? 0,
      agentActivity.get(e.graphId)?.lastRunAt ?? 0,
      agentActivity.get(e.graphId)?.lastUsedAt ?? 0,
    ].join(':');
  }).join(';');
  return `g:${revealHidden ? 1 : 0}:${hiddenCount}:${crewPart}::${tiles}`;
}

export function renderAgentsGrid(): void {
  const host = document.getElementById('skills-agents-grid');
  if (!host) return;
  // `agentRoster()` carries hidden agents WITH a flag rather than dropping them
  // — see its note. The grid is the surface that hides, so it filters here, and
  // it counts what it filtered so the foot below can name it.
  const full = agentRoster();
  const hiddenCount = full.filter((e) => e.hidden).length;
  const roster = revealHidden ? full : full.filter((e) => !e.hidden);
  if (roster.length === 0) {
    // Distinguish "no agents yet" from "still loading" — the library populates
    // asynchronously, and an empty grid that looks final is worse than one that
    // says it is waiting.
    //
    // Read from the library's own load status rather than from `skillsLibrary
    // .length === 0`, which cannot tell a pending load from a FAILED one: a
    // skill:list error empties the library, and the length test then reported it
    // as "Loading agents…" with nothing left running to change that. Same
    // permanent-spinner-as-hang the home card had.
    const status = skillsLibraryStatus();
    const message =
      status === 'error'
        // NOT "use ↻": that button lives inside .skills-pane, which
        // `body.agents-grid-mode` hides — pointing at a control the user cannot
        // see is worse than not offering one. Re-entering the page re-runs
        // mountSkillsPane(), which is a real retry.
        ? `Couldn’t load agents${skillsLibraryError() ? ` — ${escapeHtml(skillsLibraryError() ?? '')}` : ''}. Leave this page and come back to try again.`
        : status === 'ok'
          // The sentence changed with the tile above it. "No agents yet" alone
          // was a dead end — it described a condition and offered nothing. There
          // is now an action on this screen, so this says how to take it AND
          // keeps the other, equally true route (train a skill into any engram
          // and its agent appears on its own).
          // …unless the grid is empty BECAUSE the user hid everything. Telling
          // someone who has six hidden agents that they have none is the exact
          // "empty with no cause named" failure — and it points at a create
          // action that would not solve anything. The foot below carries the
          // way back; this sentence has to agree with it.
          ? (hiddenCount > 0
            ? `Every agent here is hidden — ${hiddenCount} of them. Nothing was deleted and their skills are unaffected; use the control below to bring them back.`
            : 'No agents yet — start one with + New agent, or train a skill into any Skills engram and its agent appears here.')
          : 'Loading agents…';
    const emptySig = `empty:${status}:${hiddenCount}:${revealHidden ? 1 : 0}:${message}`;
    if (host.dataset['sig'] === emptySig) return;
    host.dataset['sig'] = emptySig;
    host.classList.remove('is-entering');
    // The tile renders in every empty state, including `error`: creating an
    // engram does not depend on the skills library having loaded, so withholding
    // the only action on the page because a LIST failed would be a false gate.
    //
    // `gridHasPainted` is deliberately NOT set here, and the host does not get
    // `is-entering`. This branch is what paints while the library is still in
    // flight — the common first render — so claiming the entrance now would
    // spend it on an empty screen and the real roster would snap in without it.
    host.innerHTML =
      `<div class="agempus-grid">${newAgentTile()}</div>` +
      `<div class="agempus-grid-empty"><p class="subtitle">${message}</p></div>` +
      // The foot renders in the EMPTY branch too. This is the case where it
      // matters most: an all-hidden grid is exactly the state with no tile to
      // carry an on-tile control, so leaving it out here would strand the user
      // in the one situation the control exists for.
      hiddenFoot(hiddenCount);
    return;
  }
  // Grouped agents render under their category heading; ungrouped come first
  // under no heading, so an untouched cortex sees a plain grid.
  const ungrouped = roster.filter((e) => !e.record?.group);
  const groups = new Map<string, RosterEntry[]>();
  for (const e of roster) {
    const g = e.record?.group;
    if (!g) continue;
    const bucket = groups.get(g) ?? [];
    bucket.push(e);
    groups.set(g, bucket);
  }
  // The leading grid is emitted UNCONDITIONALLY now — it carries the "+ New
  // agent" tile, which must be the first box on the page whether or not any
  // agent is ungrouped. Keeping it out of the crew grids below is what stops the
  // tile being swept into a crew: those are separate `[data-crew-drop]`
  // containers, and this one has no crew id at all.
  //
  // Agents start at index 1 so the stagger still reads left-to-right with the
  // new tile leading at 0.
  let html = `<div class="agempus-grid">${newAgentTile()}`
    + `${ungrouped.map((e, i) => tile(e, i + 1)).join('')}</div>`;
  for (const crewId of [...groups.keys()].sort((a, b) =>
    (crews.get(a)?.name ?? a).localeCompare(crews.get(b)?.name ?? b))) {
    const members = groups.get(crewId) ?? [];
    const crew = crews.get(crewId);
    // A membership pointing at a crew that no longer exists still renders its
    // agents rather than hiding them — losing sight of an agent because a crew
    // record went missing would be far worse than an unnamed heading.
    html += crew
      ? crewHeader(crew, members.length)
      : `<p class="agempus-group-label">Ungrouped crew</p>`;
    html += `<div class="agempus-grid" data-crew-drop="${escapeHtml(crewId)}">${members.map((e, i) => tile(e, i)).join('')}</div>`;
  }
  html += hiddenFoot(hiddenCount);
  const sig = agentsGridSignature(roster, hiddenCount, null);
  if (host.dataset['sig'] === sig) return;
  host.dataset['sig'] = sig;
  // The entrance animation is gated on the host carrying `is-entering`.
  // First-open also fires several follow-up renders (library-changed,
  // records/activity/crews) while that class is still live (~1.4s). Those
  // rebuilds create new tiles WITHOUT --enter-delay, so they all match the
  // still-active rule at delay 0 and restart from opacity 0 — the flicker.
  // Skip identical paints above; for real changes, drop the entrance class
  // so remounted tiles stay opaque.
  const firstPaint = !gridHasPainted;
  gridHasPainted = true;
  if (firstPaint) host.classList.add('is-entering');
  else host.classList.remove('is-entering');
  // Class before markup so first-paint tiles never exist a frame without the
  // rule; `animation-fill-mode: both` holds them at opacity 0 through stagger.
  host.innerHTML = html;
  if (firstPaint) {
    // Drop the class once the last tile has landed.
    // Longest delay (900ms, the cap in `tile`) + duration (420ms) + margin.
    window.setTimeout(() => {
      if (host.dataset['sig'] === sig) host.classList.remove('is-entering');
    }, 1400);
  }
}

/** Enter one agent's skills. Left sidebar narrows; the trainer is untouched. */
export function enterAgentView(graphId: string): void {
  selectedEngramId = graphId;
  document.body.classList.remove('agents-grid-mode');
  // Every agent is entered on the same known view: Most recent, no hidden-only
  // filter, trainer on a blank form with nothing selected, library scrolled to
  // the top. Otherwise state left over from one agent follows you to the next —
  // a filter whose cause is now off-screen, or worse, the previous agent's
  // skill still open in the trainer beside a header naming this one.
  // State only; setSkillsEngramScope below does the repaint.
  resetSkillsWorkbenchForAgent();
  setSkillsEngramScope(graphId);
  // …and the trainer's save target with it. This is the ONLY way the trainer
  // becomes visible (`body.agents-grid-mode` hides `.skills-pane` everywhere
  // else), so from here on the destination is decided and the "Saving to"
  // picker becomes a sentence instead of a question.
  setSkillsSaveTargetAgent(graphId);
  renderAgentHeader();
}

/** Back to the full roster. */
export function exitToAgentsGrid(): void {
  // Deliberately does NOT reset `gridHasPainted`. Coming back from an agent
  // used to earn the entrance again, which made the stagger a recurring toll
  // on a navigation the user performs constantly. It now plays once per
  // session: an introduction, not a transition.
  selectedEngramId = null;
  document.body.classList.add('agents-grid-mode');
  // Widen the library again, or the next agent opened would inherit this scope.
  setSkillsEngramScope('all');
  // Same for the trainer's save target: no agent on screen, no agent implied.
  setSkillsSaveTargetAgent(null);
  renderAgentsGrid();
}

/**
 * The selected agent's avatar + name at the top of the skills sidebar, replacing
 * the text/engram filters. Those filters are redundant once the list is already
 * one agent's skills, and keeping them would let the user filter to an engram
 * that contradicts the header.
 */
export function renderAgentHeader(): void {
  const host = document.getElementById('skills-agent-header');
  if (!host) return;
  // The avatar below is drawn from the SAVED record, so any hover preview is
  // gone with this repaint — forget it, or the next revert would repaint over
  // a header that is already correct.
  previewedLook = null;
  if (selectedEngramId === null) { host.innerHTML = ''; return; }
  const entry = agentRoster().find((e) => e.graphId === selectedEngramId);
  const record = agentRecords.get(selectedEngramId);
  // An agent created from the "+ New agent" tile owns no skills for as long as
  // it takes to train the first one, and `agentRoster()` is derived from the
  // skills library — so there is no entry for it here. Falling through to
  // `selectedEngramId` would greet the user with the raw slug ("coding-skills")
  // seconds after they typed a name; read the engram's own label instead.
  const graph = app().getLoadedGraphs().find((x) => x.graphId === selectedEngramId);
  const engramName = graph ? stripLeadingIcon(app().formatEngramLabel(graph)) : selectedEngramId;
  const name = entry?.name ?? record?.alias ?? engramName;
  const count = entry?.skillCount ?? 0;
  // The header counts what the agent OWNS; the list below counts what is
  // SHOWN. Both are correct, and hidden skills make them disagree — which,
  // unexplained, reads as one of them being wrong. Naming the delta costs a
  // few words and removes the doubt.
  const hiddenSet = getSkillsHiddenSet();
  const hiddenHere = skillsLibrary
    .filter((sk) => sk.graphId === selectedEngramId && hiddenSet.has(sk.sourceId)).length;
  const countLabel = hiddenHere > 0
    ? `${count} skill${count === 1 ? '' : 's'} · ${hiddenHere} hidden`
    : `${count} skill${count === 1 ? '' : 's'}`;
  host.innerHTML =
    `<button type="button" id="btn-agents-back" class="agempus-back" title="Back to all agents">← All Agents / Agempi</button>` +
    `<div class="agempus-header-id agempus-header-centered">` +
      // The avatar is the edit affordance: hovering or focusing it reveals a
      // pencil. A button, not a div with a click handler, so it is reachable by
      // keyboard — a hover-only control is invisible to anyone not using a mouse.
      `<button type="button" class="agempus-avatar-edit" id="btn-agempus-avatar"` +
        ` title="Change this agent's look" aria-label="Change avatar" aria-haspopup="dialog">` +
        renderAgempusAvatar({ seed: selectedEngramId, shapeId: record?.shape, colorId: record?.color, size: 92 }) +
        `<span class="agempus-avatar-pencil" aria-hidden="true">` +
          `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>` +
        `</span>` +
      `</button>` +
      `<div class="agempus-header-text">` +
        // Click-to-rename. Writes the ALIAS only — the engram's displayName is
        // what recall, target_engram and skill routing resolve against, so
        // renaming through it would quietly change what those calls hit.
        `<span class="agempus-header-name" id="agempus-name" role="button" tabindex="0"` +
          ` title="Click to rename (display only — the engram is untouched)">${escapeHtml(name)}</span>` +
        // "Hidden skills" narrows the list to the hidden ones — it does not add
        // them to the rest — so the tooltip says what the list becomes, not
        // that it grows.
        `<span class="agempus-header-sub" title="${hiddenHere > 0 ? 'The list below shows ' + (count - hiddenHere) + ' — pick Hidden skills in the menu to see the other ' + hiddenHere + ' on their own.' : ''}">${escapeHtml(countLabel)}</span>` +
      `</div>` +
    `</div>` +
    `<div id="agempus-editor" class="agempus-editor hidden" role="dialog" aria-label="Agent appearance"></div>`;

  // Publish the header's real height so the sort/refresh row can stick BELOW it.
  // Measured rather than assumed: the name wraps to two lines for longer agents,
  // and a hard-coded offset would either overlap the header or leave a gap.
  requestAnimationFrame(() => {
    const h = host.getBoundingClientRect().height;
    if (h > 0) host.style.setProperty('--agent-header-h', `${Math.round(h)}px`);
    document.documentElement.style.setProperty('--agent-header-h', `${Math.round(h)}px`);
  });
}

/** Persist one patch and re-render from what the SIDECAR stored, not from what
 *  we sent — the response carries the stored record so a dropped field shows up
 *  as an unchanged avatar rather than a silent no-op that looks like success. */
async function saveAgent(patch: Record<string, string | null>): Promise<void> {
  if (!selectedEngramId) return;
  try {
    const res = await ipcCall<{ ok?: boolean; agent?: AgentRecord }>(
      'agents.upsert', { engramId: selectedEngramId, ...patch },
    );
    if (res?.agent) agentRecords.set(res.agent.engramId, res.agent);
    else await loadAgentRecords();
  } catch (e) {
    // The most likely cause is a sidecar that predates this IPC. Say so rather
    // than failing mutely — the avatar would simply snap back with no reason.
    console.warn('[agents] could not save agent appearance', e);
    // The hover preview of the swatch just clicked is still on screen. Nothing
    // was stored, so leaving it there would show a look the cortex does not
    // have — drop back to the saved one before saying the save failed.
    clearLookPreview();
    showSkillsToast('Could not save the agent’s look — the sidecar may need a rebuild.', 'error');
    return;
  }
  renderAgentHeader();
  openEditor(); // keep the picker open so several choices can be made in a row
}

/** The agent's ACTUALLY SAVED look, with the deterministic defaults resolved.
 *  Every preview reverts to this, and the pickers open on it. */
function currentLook(): { shape: string; color: string } {
  const id = selectedEngramId ?? '';
  const rec = selectedEngramId ? agentRecords.get(selectedEngramId) : undefined;
  return {
    shape: rec?.shape ?? defaultShapeFor(id),
    color: rec?.color ?? defaultColorFor(id),
  };
}

/**
 * Hover preview of a hat or a colorway.
 *
 * `null` when nothing is previewed, otherwise the `shape|color` currently
 * painted. Two things depend on it being a value rather than a flag:
 *   - mouseover fires again for every descendant inside a swatch (the button,
 *     its avatar span, the SVG), so repainting unconditionally would rewrite
 *     the avatar several times per swatch and flicker;
 *   - it is the record of whether the avatar on screen is a LIE about what is
 *     stored, which is what `clearLookPreview` exists to undo.
 */
let previewedLook: string | null = null;

/** Swap only the avatar inside the header button, leaving the pencil and the
 *  edit ring alone. Scoped to `#btn-agempus-avatar` because the shape picker
 *  renders `.agempus-avatar` spans too. */
function paintHeaderAvatar(shapeId: string, colorId: string): void {
  if (!selectedEngramId) return;
  const av = document.getElementById('btn-agempus-avatar')?.querySelector('.agempus-avatar');
  if (!av) return;
  av.outerHTML = renderAgempusAvatar({ seed: selectedEngramId, shapeId, colorId, size: 92 });
}

/** PREVIEW ONLY — never persists, never calls saveAgent. */
function previewLook(shape: string, color: string): void {
  const key = `${shape}|${color}`;
  if (previewedLook === key) return;
  previewedLook = key;
  paintHeaderAvatar(shape, color);
}

/** Back to what is stored. Cheap no-op when nothing is previewed, so it is safe
 *  to call from the broad mouse handlers that catch every way out of a swatch. */
function clearLookPreview(): void {
  if (previewedLook === null) return;
  previewedLook = null;
  const look = currentLook();
  paintHeaderAvatar(look.shape, look.color);
}

function openEditor(): void {
  const el = document.getElementById('agempus-editor');
  if (!el || !selectedEngramId) return;
  const { shape, color } = currentLook();
  el.innerHTML =
    `<p class="agempus-editor-label">Hat</p>` +
    `<div class="agempus-pick-row agempus-pick-shapes">${renderShapePicker(selectedEngramId, shape, color)}</div>` +
    `<p class="agempus-editor-label">Color</p>` +
    `<div class="agempus-pick-row">${renderColorPicker(selectedEngramId, shape, color)}</div>` +
    `<button type="button" class="agempus-editor-done" id="btn-agempus-done">Done</button>`;
  el.classList.remove('hidden');
  // Mark the avatar as being edited — CSS draws the shine ring outside it.
  document.getElementById('btn-agempus-avatar')?.classList.add('is-editing');
}

function closeEditor(): void {
  document.getElementById('agempus-editor')?.classList.add('hidden');
  document.getElementById('btn-agempus-avatar')?.classList.remove('is-editing');
  clearLookPreview();
}

/** Swap the name for an input, in place. */
function beginRename(): void {
  const span = document.getElementById('agempus-name');
  if (!span || !selectedEngramId) return;
  const current = span.textContent ?? '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'agempus-name-input';
  input.value = current;
  input.maxLength = 120;
  span.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = (commit: boolean): void => {
    if (settled) return;
    settled = true;
    const next = input.value.trim();
    if (!commit || next === current) { renderAgentHeader(); return; }
    // Empty clears the alias and falls back to the engram's own name, rather
    // than storing a blank that would render as a nameless agent.
    void saveAgent({ alias: next === '' ? null : next }).then(closeEditor);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/**
 * The on-tile controls and the hidden-agents foot, in ONE place.
 *
 * Shared by the click handler and the keydown handler rather than written
 * twice: the controls are spans with `role`, so Enter/Space has to do exactly
 * what a click does or they are mouse-only — and two copies of this list is how
 * one of them ends up a control behind.
 *
 * Returns true when it consumed the event, so the caller stops.
 */
function handleTileControlClick(target: HTMLElement): boolean {
  const power = target.closest<HTMLElement>('[data-agent-power]');
  const powerId = power?.dataset['agentPower'];
  if (powerId) {
    // Read the state off the roster rather than off `aria-checked`: the DOM is
    // a render of the state, not the state, and trusting it would flip the
    // wrong way after any repaint that raced the click.
    const entry = agentRoster().find((x) => x.graphId === powerId);
    void setAgentDisabled(powerId, !(entry?.disabled ?? false));
    return true;
  }
  const hide = target.closest<HTMLElement>('[data-agent-hide]');
  if (hide?.dataset['agentHide']) { void setAgentHidden(hide.dataset['agentHide'], true); return true; }
  const unhide = target.closest<HTMLElement>('[data-agent-unhide]');
  if (unhide?.dataset['agentUnhide']) { void setAgentHidden(unhide.dataset['agentUnhide'], false); return true; }
  if (target.closest('#btn-agempus-reveal-hidden')) {
    revealHidden = !revealHidden;
    renderAgentsGrid();
    return true;
  }
  return false;
}

/** Refresh whichever view is on screen. Called after the library reloads. */
export function refreshAgentsView(): void {
  if (isAgentsGridMode()) renderAgentsGrid();
  else renderAgentHeader();
  // The home card carries the same tile and belongs to neither view, so it
  // refreshes here too — the library-changed event is what takes it off its
  // loading state.
  renderHomeAgentTile();
}

export function initAgentsGrid(): void {
  // The roster is DERIVED from the skills library, which loads asynchronously
  // and reloads on train / retrain / import / delete / engram switch. Without
  // this the grid rendered exactly once — before the library existed — and sat
  // on "Loading agents…" for the rest of the session.
  document.addEventListener('skills:library-changed', () => { refreshAgentsView(); });

  // First paint of the home card. Home is on screen before the library resolves,
  // and the markup ships EMPTY — without this the card would sit as a blank box
  // until the first library event, which is indistinguishable from having no
  // agent at all.
  renderHomeAgentTile();

  // Ghampus routed a turn to an agent — pulse it. A real dispatch signal from
  // the chat, not a poll.
  document.addEventListener('agents:dispatched', (e) => {
    const id = (e as CustomEvent<{ engramId?: string }>).detail?.engramId;
    if (id) markAgentDispatched(id);
  });

  // Delegated: tiles and the back button are re-rendered constantly, so binding
  // per-element would leak listeners and miss anything drawn later.
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // The home card's tile is the same component on a different page, so it has
    // to change pages first — and it stops there, on the ROSTER.
    //
    // It used to follow activateMode with enterAgentView(graphId), landing on
    // this one agent's scoped sidebar. The owner wants the grid: the tile is a
    // door to the agents, not a shortcut past them. activateMode('skills') is
    // all it takes — that path calls exitToAgentsGrid(), which clears the
    // selected agent, re-adds `body.agents-grid-mode` and widens the library
    // scope back to 'all'. Adding an explicit exitToAgentsGrid() here would be
    // the same call twice.
    //
    // Checked BEFORE the generic `.agempus-tile` branch below, which DOES open
    // the agent — that is the grid's own behavior and is unchanged.
    if (target.closest<HTMLElement>('#home-agent-tile .agempus-tile')) {
      app().activateMode('skills');
      return;
    }
    // Absent-state fallback on the same card: no agent to open, so this goes to
    // the roster and stops there.
    if (target.closest('#home-agent-tile [data-home-agents-open]')) {
      app().activateMode('skills');
      return;
    }
    // Error-state retry: clear the one-shot latch and ask again, in place. The
    // repaint is immediate so the button visibly does something even while the
    // retry is still in flight.
    if (target.closest('#home-agent-tile [data-home-agents-retry]')) {
      homeLibraryRequested = false;
      ensureHomeAgentLibrary();
      renderHomeAgentTile();
      return;
    }
    // Checked before the agent tiles below purely for reading order — the new
    // tile is not `.agempus-tile`, so the two selectors cannot both match.
    if (target.closest('#btn-agempus-new')) { void createAgentFromGrid(); return; }

    // ── On-tile state controls ───────────────────────────────────────────
    // These MUST be tested before the `.agempus-tile` branch below, and each
    // one returns. They live INSIDE the tile button, so the tile selector
    // matches them too — checked the other way round, every click on the off
    // switch would also open the agent. Returning is what stops that; no
    // stopPropagation, because other document-level listeners on this page are
    // entitled to see the event.
    if (handleTileControlClick(target)) return;

    const tileEl = target.closest<HTMLElement>('.agempus-tile');
    if (tileEl?.dataset['agentEngram']) {
      enterAgentView(tileEl.dataset['agentEngram']);
      return;
    }
    if (target.closest('#btn-agents-back')) { exitToAgentsGrid(); return; }

    // ── Appearance editor ────────────────────────────────────────────────
    if (target.closest('#btn-agempus-avatar')) {
      const open = !document.getElementById('agempus-editor')?.classList.contains('hidden');
      if (open) closeEditor(); else openEditor();
      return;
    }
    if (target.closest('#btn-agempus-done')) { closeEditor(); return; }
    const shapeBtn = target.closest<HTMLElement>('.agempus-pick-shape');
    if (shapeBtn?.dataset['shapeId']) { void saveAgent({ shape: shapeBtn.dataset['shapeId'] }); return; }
    const colorBtn = target.closest<HTMLElement>('.agempus-pick-color');
    if (colorBtn?.dataset['colorId']) { void saveAgent({ color: colorBtn.dataset['colorId'] }); return; }
    if (target.closest('#agempus-name')) { beginRename(); return; }

    // ── Crew controls ────────────────────────────────────────────────────
    const lvlBtn = target.closest<HTMLElement>('[data-crew-autonomy]');
    if (lvlBtn?.dataset['crewAutonomy'] && lvlBtn.dataset['level']) {
      void setCrewAutonomy(lvlBtn.dataset['crewAutonomy'], lvlBtn.dataset['level']);
      return;
    }
    const forget = target.closest<HTMLElement>('[data-crew-forget]');
    if (forget?.dataset['crewForget']) {
      const crew = crews.get(forget.dataset['crewForget']);
      // Disbanding is reversible in effect (nothing is deleted but the grouping)
      // so a plain confirm is proportionate — but say what survives, because
      // "disband" sounds destructive.
      if (window.confirm(`Disband “${crew?.name ?? 'this crew'}”?\n\nThe agents, their skills and their autonomy levels all stay exactly as they are — only the grouping goes.`)) {
        void ipcCall('crews.forget', { crewId: forget.dataset['crewForget'] })
          .then(loadAgentRecords).then(loadCrews).then(renderAgentsGrid);
      }
      return;
    }
    const renameEl = target.closest<HTMLElement>('[data-crew-rename]');
    if (renameEl?.dataset['crewRename']) { void renameCrew(renameEl.dataset['crewRename']); return; }
    const briefEl = target.closest<HTMLElement>('[data-crew-brief]');
    if (briefEl?.dataset['crewBrief']) { void editBrief(briefEl.dataset['crewBrief']); return; }

    // Click anywhere else closes the picker. Checked last so the branches above
    // still work while it is open.
    if (!target.closest('#agempus-editor')) closeEditor();
  });

  // ── Hover preview of a hat or a colorway ─────────────────────────────────
  // Delegated for the same reason as the clicks: the picker is rebuilt after
  // every commit. One `mouseover` decides BOTH directions — a swatch under the
  // pointer previews, anything else reverts — so there is no way to leave the
  // row that forgets to undo. That matters more than the preview itself: an
  // avatar left showing an unsaved hat is a lie about what the cortex stored.
  document.addEventListener('mouseover', (e) => {
    // Cheap gate first. With the picker closed this is one id lookup per
    // mouseover, and the selector matching below never runs.
    const editor = document.getElementById('agempus-editor');
    if (!editor || editor.classList.contains('hidden')) { clearLookPreview(); return; }
    const t = e.target as HTMLElement | null;
    if (!t) { clearLookPreview(); return; }
    const shapeId = t.closest<HTMLElement>('.agempus-pick-shape')?.dataset['shapeId'];
    // A hat is previewed in the color the agent already has, and a colorway on
    // the hat it already wears — one axis moves at a time, which is the same
    // promise the swatches themselves make.
    if (shapeId) { previewLook(shapeId, currentLook().color); return; }
    const colorId = t.closest<HTMLElement>('.agempus-pick-color')?.dataset['colorId'];
    if (colorId) { previewLook(currentLook().shape, colorId); return; }
    clearLookPreview();
  });
  // Leaving the window fires no `mouseover` anywhere, so the handler above
  // never gets its chance to revert. A null relatedTarget is that exit.
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget === null) clearLookPreview();
  });
  // Same gap for a window that loses focus mid-hover (cmd-tab, a dialog).
  window.addEventListener('blur', () => { clearLookPreview(); });

  // Keyboard parity for the rename target — it is a span with role=button, so
  // Enter/Space must do what a click does or it is mouse-only.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const t = e.target as HTMLElement | null;
    // The on-tile controls are spans carrying `role="switch"` / `role="button"`,
    // which buys the announcement but NOT the activation — a role does not make
    // a span respond to a key. Without this the off switch is mouse-only, which
    // is the same defect the header's pencil was fixed for.
    if (t && handleTileControlClick(t)) { e.preventDefault(); return; }
    if (t?.id === 'agempus-name') { e.preventDefault(); beginRename(); }
    const crewName = t?.closest<HTMLElement>('[data-crew-rename]');
    if (crewName?.dataset['crewRename']) { e.preventDefault(); void renameCrew(crewName.dataset['crewRename']); }
    const brief = t?.closest<HTMLElement>('[data-crew-brief]');
    if (brief?.dataset['crewBrief']) { e.preventDefault(); void editBrief(brief.dataset['crewBrief']); }
  });

  // ── Drag to group ────────────────────────────────────────────────────────
  // Native HTML5 DnD rather than pointer maths: it gives keyboard-independent
  // drop targets, an OS-drawn drag image, and correct behavior when the drag
  // leaves the window — all of which a hand-rolled version gets wrong.
  document.addEventListener('dragstart', (e) => {
    // Belt to the `draggable="false"` on the controls themselves: a drag that
    // STARTS on the off switch is a mis-hit, not a grouping gesture, and the
    // click that was meant never arrives. Two guards because the attribute is
    // honored inconsistently once a pointer-down lands on a descendant SVG.
    if ((e.target as HTMLElement | null)?.closest('.agempus-tile-controls')) {
      e.preventDefault();
      return;
    }
    const t = (e.target as HTMLElement | null)?.closest<HTMLElement>('.agempus-tile');
    const id = t?.dataset['agentEngram'];
    if (!id || !e.dataTransfer) return;
    e.dataTransfer.setData('text/graphnosis-agent', id);
    e.dataTransfer.effectAllowed = 'move';
    t?.classList.add('is-dragging');
  });
  document.addEventListener('dragend', () => {
    document.querySelectorAll('.agempus-tile.is-dragging, .agempus-tile.is-drop-target')
      .forEach((el) => el.classList.remove('is-dragging', 'is-drop-target'));
  });
  document.addEventListener('dragover', (e) => {
    const over = (e.target as HTMLElement | null)?.closest<HTMLElement>('.agempus-tile');
    if (!over || !e.dataTransfer?.types.includes('text/graphnosis-agent')) return;
    // preventDefault is what actually marks this a valid drop target; without
    // it the browser refuses the drop and nothing happens, silently.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.agempus-tile.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    if (!over.classList.contains('is-dragging')) over.classList.add('is-drop-target');
  });
  document.addEventListener('drop', (e) => {
    const over = (e.target as HTMLElement | null)?.closest<HTMLElement>('.agempus-tile');
    const dragged = e.dataTransfer?.getData('text/graphnosis-agent');
    if (!over?.dataset['agentEngram'] || !dragged) return;
    e.preventDefault();
    void groupAgents(dragged, over.dataset['agentEngram']);
  });
}

async function renameCrew(crewId: string): Promise<void> {
  const crew = crews.get(crewId);
  if (!crew) return;
  const name = window.prompt('Rename crew:', crew.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === crew.name) return;
  await ipcCall('crews.upsert', { crewId, name: trimmed });
  await loadCrews();
  renderAgentsGrid();
}

async function editBrief(crewId: string): Promise<void> {
  const crew = crews.get(crewId);
  if (!crew) return;
  const brief = window.prompt(
    `Shared brief for “${crew.name}”.\n\nShown for every member. It does not change how skills run on its own.`,
    crew.brief ?? '',
  );
  if (brief === null) return;
  await ipcCall('crews.upsert', { crewId, brief: brief.trim() === '' ? null : brief });
  await loadCrews();
  renderAgentsGrid();
}

async function setCrewAutonomy(crewId: string, level: string): Promise<void> {
  const crew = crews.get(crewId);
  if (!crew) return;
  const res = await ipcCall<{ ok?: boolean; applied?: Array<{ engramId: string; ok: boolean }> }>(
    'crews.setAutonomy', { crewId, level },
  );
  const applied = res?.applied ?? [];
  const failed = applied.filter((a) => !a.ok);
  // Report the partial case honestly. "Applied to 4 of 5" is the truth; a bare
  // success tick after one member failed is the shape this codebase keeps
  // getting wrong.
  if (failed.length > 0) {
    showSkillsToast(`${level} applied to ${applied.length - failed.length}/${applied.length} — ${failed.length} failed.`, 'error');
  } else {
    showSkillsToast(`${level} applied to all ${applied.length} member${applied.length === 1 ? '' : 's'}.`, 'success');
  }
  await loadCrews();
  renderAgentsGrid();
}

// Re-exported so main.ts has one import for the page rather than reaching into
// skills.ts for the label helper as well.
export { skillDisplayName };
