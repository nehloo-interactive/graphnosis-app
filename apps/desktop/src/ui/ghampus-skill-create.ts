/**
 * `/train <description>` → author a NEW skill.
 *
 * The `/train` drawer in `ghampus.ts` is a picker over the existing library. When
 * the text after the command matches nothing, the drawer offers to author it
 * instead, and this module is that branch — the one that turns a description
 * into a skill.
 *
 * `ghampus.ts`'s `startSkillCreate` is the ONLY thing that calls
 * `runSkillCreateFlow`, and all three ways of taking the offer go through it:
 * a click on the offer, Enter in the drawer filter, and Enter in the chat box
 * (via `sendMessage` → `submitCreateIntent`). That last one is load-bearing, not
 * decorative: the drawer is synced FROM the chat box, so focus never leaves it
 * and the filter is `pointer-events: none` — Enter there is the only key the
 * user has. It used to fall off the end of `sendMessage` and send nothing at
 * all, which made the offer look inert; the single shared entry point is what
 * stops that from silently regrowing on one path while the others work.
 *
 * ── The four steps, and why they are DATA and not control flow ───────────────
 *
 * The flow is exactly four named steps:
 *
 *     recall → draft → review → train
 *
 * `SKILL_AUTHORING_SOP` below holds the step order AND every piece of prompt
 * text the flow uses, in one object. Nothing in the handlers composes prompt
 * text, and nothing decides what comes next; `runSkillCreateFlow` walks
 * `SKILL_AUTHORING_SOP.steps` and the step functions are pure-ish leaves that
 * take the accumulated state and return a typed result.
 *
 * ┌─ OPTION-3 SEAM ────────────────────────────────────────────────────────────┐
 * │ The next iteration replaces this hard-coded sequence with a WALKABLE        │
 * │ skill-authoring SOP — a real trained skill in the cortex, dispatched        │
 * │ through the same machinery as any other skill.                             │
 * │                                                                            │
 * │ The substitution point is `SKILL_AUTHORING_SOP` and nothing else. Replace   │
 * │ that one constant with something loaded from `walk_skill` /                 │
 * │ `skill:walkStructured` — a `{ steps, prompts }` projection of the walked    │
 * │ SOP — and `runSkillCreateFlow` keeps working unchanged, because it only     │
 * │ ever reads `.steps` in order and `.prompts.*` for text. The step functions  │
 * │ (`stepRecall` … `stepTrain`) become the executors the walked SOP names in   │
 * │ its `@needs:` tags.                                                        │
 * │                                                                            │
 * │ What must NOT move into the SOP: the approval gate. `stepTrain` is only     │
 * │ ever reachable from an affirmative click (see `runSkillCreateFlow`'s        │
 * │ `awaitApproval`). A walkable SOP that could dispatch its own `train` step   │
 * │ would defeat the whole point, so the driver — not the SOP — owns that       │
 * │ boundary.                                                                  │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ── Honest degradation is the contract, not a nicety ─────────────────────────
 *
 * Every step can fail in a way that is NOT an error: recall can come back empty,
 * the local LLM can be off, the licence gate can refuse. None of those may be
 * rendered as the success they are not. `StepOutcome` is a discriminated union
 * with three arms precisely so the renderer cannot accidentally paint a failure
 * as a draft:
 *
 *   ok       — proceed
 *   degraded — proceed, but the UI MUST show `note` (recall empty, source-only)
 *   failed   — stop, show `reason` verbatim, offer `openSkills` where it helps
 *
 * This mirrors the `skillsLoadFailed` distinction in `ghampus.ts`: a failed
 * fetch and an empty result are different facts and must never collapse into
 * one message.
 */
import { app } from './app-context';
import { ipcCall } from './ipc';
import { selectedAgentEngramId } from './agents-grid';
import { escapeHtml } from './util';

// ── Wire types ───────────────────────────────────────────────────────────────

/** `skill:train` (sidecar `ipc.ts` `case 'skill:train'`). */
interface SkillTrainWire {
  trained?: string;
  mode?: 'llm' | 'memory-augmented' | 'source-only';
  degradedNote?: string;
  skillId?: string;
  scaffoldNotes?: string[];
  structuralEdgeWarning?: string;
  duplicateWarning?: string;
  conformance?: { score: number; maxScore: number; issues?: string[] };
  /** Licence gate. Returned, NOT thrown — `ipc.ts` `case 'skill:train'`. */
  upgrade_required?: boolean;
  message?: string;
  license_state?: string;
  upgrade_url?: string;
}

/** `recall` (sidecar `ipc.ts` `case 'recall'`). */
interface RecallWire {
  prompt?: string;
  nodesIncluded?: number;
}

/** `llm:status`. Readiness rule copied from `main.ts`'s own. */
interface LlmStatusWire {
  ollamaReachable?: boolean;
  installedModels?: string[];
  enabled?: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SOP — step order and every prompt string, in one place.
// See the OPTION-3 SEAM note in the file header before editing.
// ═════════════════════════════════════════════════════════════════════════════

export type SkillCreateStepId = 'recall' | 'draft' | 'review' | 'train';

export const SKILL_AUTHORING_SOP = {
  id: 'builtin:skill-authoring/v1',

  /** Walked in order by `runSkillCreateFlow`. */
  steps: ['recall', 'draft', 'review', 'train'] as const,

  /** Status line shown while each step runs. */
  running: {
    recall: 'Recalling related memories…',
    draft:  'Drafting the skill with your local LLM…',
    review: 'Ready for your review.',
    train:  'Training into your cortex…',
  } as Record<SkillCreateStepId, string>,

  prompts: {
    /** What we ask the cortex for. The user's own words, unaltered. */
    recallQuery: (description: string): string => description,

    /** Working title. The user can change it before approving. */
    skillName: (description: string): string => {
      const words = description.trim().replace(/\s+/g, ' ').split(' ').slice(0, 7).join(' ');
      return (words || 'New skill').replace(/[.:;,]+$/, '');
    },

    /**
     * The authored SOURCE handed to `skill:train`.
     *
     * `skill:train` runs `scaffoldAgempus` first (skill-trainer.ts:797), which
     * supplies the eight TODO-hinted contract lines itself, so this template
     * does not emit them — it supplies the three things the scaffolder refuses
     * to guess:
     *
     *  1. a title line,
     *  2. an explicit `[dispatch-safe: no]` cap. An ABSENT tag parses as `yes`,
     *     i.e. eligible for unattended L3 dispatch. A machine-drafted skill must
     *     not inherit that by omission. The user can raise it in the review box.
     *  3. a numbered sequence, so `assessAgempus` has something to walk instead
     *     of scoring the body as prose.
     *
     * Recalled context is a clearly-fenced, deletable section. It is included
     * because `skill:train` has no separate context channel — `focusGraphIds` is
     * ignored at train time by the empty-recall contract — so the only way for
     * memory to guide the draft is through the source text. The review UI says
     * so out loud.
     */
    draftSource: (args: { name: string; description: string; recalled: string | null }): string => {
      const lines: string[] = [];
      lines.push(args.name, '');
      lines.push('[dispatch-safe: no]', '');
      lines.push(`Goal: ${args.description.trim()}`, '');
      if (args.recalled) {
        lines.push('Context (recalled from your memory — delete anything that should not be saved):');
        for (const l of args.recalled.split('\n')) lines.push(l.trimEnd() ? `  ${l.trimEnd()}` : '');
        lines.push('');
      }
      lines.push('1. Restate what the user is trying to achieve, in their words.');
      lines.push('2. Check the prerequisites above are actually met before doing anything.');
      lines.push('3. Carry out the goal, one observable action per step.');
      lines.push('4. Report what changed and what is still outstanding.');
      return lines.join('\n');
    },
  },

  notes: {
    recallEmpty:
      'Nothing relevant came back from your memory, so this draft is unguided by it — '
      + 'it is built from your description alone.',
    recallFailed: (why: string): string =>
      `Could not read your memory (${why}), so this draft is unguided by it.`,
    llmOff:
      'Your local LLM is off or unreachable, so nothing was rewritten — this draft is your '
      + 'description in skill shape. Enable it in Settings → Local LLM for a real draft.',
  },
} as const;

// ── Step results ─────────────────────────────────────────────────────────────

export type StepOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'degraded'; value: T; note: string }
  /** `openSkills: true` = the Skills page is where the user can actually fix this. */
  | { status: 'failed'; reason: string; openSkills?: boolean };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── Step 1 · recall ──────────────────────────────────────────────────────────

/** Never throws. An unreadable cortex degrades the draft; it does not stop it. */
export async function stepRecall(description: string): Promise<StepOutcome<string | null>> {
  try {
    const res = await ipcCall<RecallWire | null>('recall', {
      query: SKILL_AUTHORING_SOP.prompts.recallQuery(description),
      maxNodes: 12,
      maxTokens: 1200,
    });
    const prompt = (res?.prompt ?? '').trim();
    const n = res?.nodesIncluded ?? 0;
    if (!prompt || n === 0) {
      return { status: 'degraded', value: null, note: SKILL_AUTHORING_SOP.notes.recallEmpty };
    }
    return { status: 'ok', value: prompt };
  } catch (e) {
    return {
      status: 'degraded',
      value: null,
      note: SKILL_AUTHORING_SOP.notes.recallFailed(errText(e)),
    };
  }
}

// ── Step 2 · draft ───────────────────────────────────────────────────────────

export interface SkillDraft {
  /** The body the user reviews and, if they approve it, the body that is saved. */
  body: string;
  name: string;
  mode: 'llm' | 'memory-augmented' | 'source-only';
  conformance?: { score: number; maxScore: number; issues?: string[] } | undefined;
}

/**
 * Pre-flight the local LLM so "no local LLM" is a sentence the user reads BEFORE
 * a 20-second wait, not one they infer from a disappointing draft.
 *
 * Readiness rule is `main.ts:10187`'s. Deliberately NOT `!llm` — `main.ts:1422`
 * wires `llm: () => llm` ungated, so a null check there is always false even
 * with the master switch off.
 */
export async function localLlmReady(): Promise<boolean> {
  try {
    const s = await ipcCall<LlmStatusWire | null>('llm:status', {});
    return Boolean(s?.ollamaReachable && (s?.installedModels?.length ?? 0) > 0 && s?.enabled);
  } catch {
    return false;
  }
}

/**
 * Draft with `save: false`.
 *
 * `save: false` is the approval gate's primitive: the write block in
 * `skill-trainer.ts` is `if (save) { … }`, so this call reaches the LLM and the
 * compiler and touches no engram. `graphId` is still required by the IPC schema
 * — it scopes the run, it is not a write target while `save` is false.
 */
export async function stepDraft(args: {
  description: string;
  recalled: string | null;
  graphId: string;
  llmReady: boolean;
}): Promise<StepOutcome<SkillDraft>> {
  const name = SKILL_AUTHORING_SOP.prompts.skillName(args.description);
  const source = SKILL_AUTHORING_SOP.prompts.draftSource({
    name,
    description: args.description,
    recalled: args.recalled,
  });

  let res: SkillTrainWire | null;
  try {
    res = await ipcCall<SkillTrainWire | null>('skill:train', {
      skill: source,
      graphId: args.graphId,
      skillName: name,
      useLlmRewrite: args.llmReady,
      save: false,
    });
  } catch (e) {
    return { status: 'failed', reason: `Drafting failed: ${errText(e)}`, openSkills: true };
  }

  // `if (!deps.skillTrainer) return null` — ipc.ts. A null is not an empty draft.
  if (!res) {
    return {
      status: 'failed',
      reason: 'The skill trainer is not available in this sidecar build, so nothing was drafted.',
      openSkills: true,
    };
  }
  // The licence gate RETURNS rather than throws. Surface its real reason.
  if (res.upgrade_required) {
    return {
      status: 'failed',
      reason: res.message
        ? `${res.message}${res.license_state ? ` (${res.license_state})` : ''}`
        : 'Skill training is not licensed on this cortex.',
      openSkills: true,
    };
  }
  const body = (res.trained ?? '').trim();
  if (!body) {
    return {
      status: 'failed',
      reason: 'The trainer returned an empty draft. Nothing was written.',
      openSkills: true,
    };
  }

  const draft: SkillDraft = {
    body,
    name,
    mode: res.mode ?? 'source-only',
    conformance: res.conformance,
  };

  // The sidecar's own degradation story wins over our pre-flight guess: it knows
  // whether the rewrite ran, dropped SOP markers, or threw.
  const note = res.degradedNote
    ?? (draft.mode !== 'llm' ? SKILL_AUTHORING_SOP.notes.llmOff : undefined);
  if (note) return { status: 'degraded', value: draft, note };
  return { status: 'ok', value: draft };
}

// ── Step 4 · train (step 3, review, is the UI below) ─────────────────────────

/**
 * The ONLY call in this module that can write. Reachable from exactly one place:
 * the approve button's click handler.
 *
 * `useLlmRewrite: false` on purpose. The user approved a specific body; a second
 * LLM pass could return different text, and then what got saved is not what was
 * approved. The approved string is sent verbatim.
 */
export async function stepTrain(args: {
  body: string;
  name: string;
  graphId: string;
}): Promise<StepOutcome<{ skillId?: string | undefined; warnings: string[] }>> {
  let res: SkillTrainWire | null;
  try {
    res = await ipcCall<SkillTrainWire | null>('skill:train', {
      skill: args.body,
      graphId: args.graphId,
      skillName: args.name,
      useLlmRewrite: false,
      save: true,
    });
  } catch (e) {
    return { status: 'failed', reason: `Training failed: ${errText(e)}` };
  }
  if (!res) {
    return { status: 'failed', reason: 'The skill trainer is not available. Nothing was written.' };
  }
  if (res.upgrade_required) {
    return {
      status: 'failed',
      reason: res.message
        ? `${res.message}${res.license_state ? ` (${res.license_state})` : ''}`
        : 'Skill training is not licensed on this cortex.',
    };
  }
  // A save that reports no skillId did not save. Do not render it as one.
  if (!res.skillId) {
    return {
      status: 'failed',
      reason: 'The trainer returned no saved skill id, so the skill was not stored.',
    };
  }
  const warnings = [res.structuralEdgeWarning, res.duplicateWarning].filter(
    (w): w is string => Boolean(w),
  );
  return warnings.length
    ? { status: 'degraded', value: { skillId: res.skillId, warnings }, note: warnings.join(' ') }
    : { status: 'ok', value: { skillId: res.skillId, warnings } };
}

// ── Target engram ────────────────────────────────────────────────────────────

export interface EngramChoice { graphId: string; label: string }

/**
 * Skill-template engrams only — the same filter the Skills page's "Saving to"
 * dropdown uses (`skills.ts` `populateSkillsEngramPickers`).
 *
 * There is deliberately NO fallback to `engrams[0]`. The chat-side
 * `resolveSkillTrainGraphId()` ends in exactly that, and it picks an arbitrary
 * engram with no prompt. A silent target is the thing this flow must not do.
 */
export function skillEngramChoices(): EngramChoice[] {
  return app().getLoadedGraphs()
    .filter((g) => !g.metadata.archived && g.loaded !== false && g.metadata.template === 'skill')
    .map((g) => ({ graphId: g.graphId, label: app().formatEngramLabel(g) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Prefill only from a real, skill-template agent selection. Otherwise: unset. */
export function prefilledEngram(choices: EngramChoice[]): string {
  const sel = selectedAgentEngramId();
  return sel && choices.some((c) => c.graphId === sel) ? sel : '';
}

// ── Step 3 · review — the modal ──────────────────────────────────────────────

const MODAL_ID = 'skill-create-modal';

function closeModal(): void {
  document.getElementById(MODAL_ID)?.remove();
}

function mountModal(description: string): HTMLElement {
  closeModal();
  const el = document.createElement('div');
  el.id = MODAL_ID;
  el.className = 'skill-create-backdrop';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'skill-create-title');
  el.innerHTML = `
    <div class="skill-create">
      <div class="skill-create-header">
        <h3 id="skill-create-title">Train a new skill</h3>
        <button type="button" id="btn-skill-create-close" class="skill-create-close"
                aria-label="Close">×</button>
      </div>
      <p class="skill-create-desc">${escapeHtml(description)}</p>
      <p id="skill-create-status" class="skill-create-status" aria-live="polite"></p>
      <div id="skill-create-notes" class="skill-create-notes hidden" aria-live="polite"></div>
      <div id="skill-create-review" class="skill-create-review hidden">
        <label class="skill-create-field">
          <span>Skill name</span>
          <input type="text" id="skill-create-name" autocomplete="off" spellcheck="false" />
        </label>
        <label class="skill-create-field">
          <span>Train into</span>
          <select id="skill-create-engram"></select>
        </label>
        <label class="skill-create-field skill-create-field-grow">
          <span id="skill-create-body-label">Draft — edit before approving</span>
          <textarea id="skill-create-body" spellcheck="false" rows="14"></textarea>
        </label>
      </div>
      <div class="skill-create-actions">
        <button type="button" id="btn-skill-create-cancel" class="skill-create-btn">Cancel</button>
        <button type="button" id="btn-skill-create-skills" class="skill-create-btn hidden">Open Skills</button>
        <button type="button" id="btn-skill-create-approve"
                class="skill-create-btn skill-create-btn-primary hidden" disabled>Train this skill</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#btn-skill-create-close')?.addEventListener('click', closeModal);
  el.querySelector('#btn-skill-create-cancel')?.addEventListener('click', closeModal);
  el.querySelector('#btn-skill-create-skills')?.addEventListener('click', () => {
    closeModal();
    app().activateMode('skills');
  });
  el.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') { e.preventDefault(); closeModal(); }
  });
  return el;
}

function setStatus(text: string): void {
  const el = document.getElementById('skill-create-status');
  if (el) el.textContent = text;
}

/** Notes accumulate — a degraded recall AND a degraded draft must both be read. */
function addNote(note: string): void {
  const box = document.getElementById('skill-create-notes');
  if (!box) return;
  const p = document.createElement('p');
  p.className = 'skill-create-note';
  p.textContent = note;
  box.appendChild(p);
  box.classList.remove('hidden');
}

/**
 * Terminal failure. The review pane and the approve button stay hidden, so there
 * is no path from here to a write.
 */
function renderFailure(reason: string, openSkills: boolean): void {
  setStatus('');
  const box = document.getElementById('skill-create-notes');
  if (box) {
    const p = document.createElement('p');
    p.className = 'skill-create-note skill-create-note-bad';
    p.textContent = reason;
    box.appendChild(p);
    box.classList.remove('hidden');
  }
  document.getElementById('skill-create-review')?.classList.add('hidden');
  const approve = document.getElementById('btn-skill-create-approve');
  approve?.classList.add('hidden');
  (approve as HTMLButtonElement | null)?.setAttribute('disabled', 'disabled');
  if (openSkills) document.getElementById('btn-skill-create-skills')?.classList.remove('hidden');
  const cancel = document.getElementById('btn-skill-create-cancel');
  if (cancel) cancel.textContent = 'Close';
}

// ── The driver ───────────────────────────────────────────────────────────────

/** Accumulated state, one flow at a time (the modal is a singleton). */
const state: {
  recalled: string | null;
  draft: SkillDraft | null;
  approved: { body: string; name: string; graphId: string } | null;
} = { recalled: null, draft: null, approved: null };

/**
 * Walks `SKILL_AUTHORING_SOP.steps`. The only thing that advances past `review`
 * is a click on `#btn-skill-create-approve`.
 */
export async function runSkillCreateFlow(description: string): Promise<void> {
  const desc = description.trim();
  if (!desc) return;
  // A previous run's draft must never be carried into this one — that is how a
  // stale success gets rendered over a fresh failure.
  state.recalled = null;
  state.draft = null;
  state.approved = null;
  mountModal(desc);

  const choices = skillEngramChoices();

  for (const step of SKILL_AUTHORING_SOP.steps) {
    if (!document.getElementById(MODAL_ID)) return;   // user closed it

    if (step === 'recall') {
      setStatus(SKILL_AUTHORING_SOP.running.recall);
      const r = await stepRecall(desc);
      if (r.status === 'failed') { renderFailure(r.reason, r.openSkills ?? false); return; }
      if (r.status === 'degraded') addNote(r.note);
      state.recalled = r.value;
      continue;
    }

    if (step === 'draft') {
      // No Skills engram at all: there is no honest target and no point drafting
      // into a review the user cannot approve. Say so and point at the one place
      // that can fix it.
      if (choices.length === 0) {
        renderFailure(
          'You have no Skills engram to train into. Create one on the Skills page first — '
          + 'a new skill needs a skill-template engram to live in.',
          true,
        );
        return;
      }
      const llmReady = await localLlmReady();
      if (!llmReady) addNote(SKILL_AUTHORING_SOP.notes.llmOff);
      setStatus(llmReady
        ? SKILL_AUTHORING_SOP.running.draft
        : 'Structuring the skill from your description…');
      const d = await stepDraft({
        description: desc,
        recalled: state.recalled,
        // Drafting is read-only (`save: false`); the IPC still needs a graphId to
        // scope the run. Using the first choice here is NOT a target decision —
        // the target is whatever the user picks in the review select below.
        graphId: choices[0]!.graphId,
        llmReady,
      });
      if (d.status === 'failed') { renderFailure(d.reason, d.openSkills ?? false); return; }
      // Don't repeat our own pre-flight sentence if the sidecar said the same thing.
      if (d.status === 'degraded' && !(!llmReady && d.note === SKILL_AUTHORING_SOP.notes.llmOff)) {
        addNote(d.note);
      }
      state.draft = d.value;
      continue;
    }

    if (step === 'review') {
      if (!state.draft) return;
      const approved = await awaitApproval(state.draft, choices);
      if (!approved) return;              // cancelled or closed — nothing written
      state.approved = approved;
      continue;
    }

    if (step === 'train') {
      if (!state.approved) return;
      setStatus(SKILL_AUTHORING_SOP.running.train);
      const t = await stepTrain(state.approved);
      if (t.status === 'failed') { renderFailure(t.reason, false); return; }
      if (t.status === 'degraded') addNote(t.note);
      setStatus(`Saved “${state.approved.name}” into ${
        choices.find((c) => c.graphId === state.approved!.graphId)?.label ?? state.approved.graphId
      }.`);
      document.getElementById('skill-create-review')?.classList.add('hidden');
      document.getElementById('btn-skill-create-approve')?.classList.add('hidden');
      const cancel = document.getElementById('btn-skill-create-cancel');
      if (cancel) cancel.textContent = 'Done';
    }
  }
}

/**
 * Renders the draft and resolves ONLY on an affirmative click.
 *
 * Cancel, close and Escape all resolve `null`, and `runSkillCreateFlow` returns
 * without reaching `stepTrain`. There is no timeout and no default-yes.
 */
function awaitApproval(
  draft: SkillDraft,
  choices: EngramChoice[],
): Promise<{ body: string; name: string; graphId: string } | null> {
  const modal = document.getElementById(MODAL_ID);
  const review = document.getElementById('skill-create-review');
  const nameEl = document.getElementById('skill-create-name') as HTMLInputElement | null;
  const engramEl = document.getElementById('skill-create-engram') as HTMLSelectElement | null;
  const bodyEl = document.getElementById('skill-create-body') as HTMLTextAreaElement | null;
  const approve = document.getElementById('btn-skill-create-approve') as HTMLButtonElement | null;
  if (!modal || !review || !nameEl || !engramEl || !bodyEl || !approve) return Promise.resolve(null);

  nameEl.value = draft.name;
  bodyEl.value = draft.body;
  engramEl.innerHTML = [
    '<option value="">Choose an engram…</option>',
    ...choices.map((c) => `<option value="${escapeHtml(c.graphId)}">${escapeHtml(c.label)}</option>`),
  ].join('');
  engramEl.value = prefilledEngram(choices);

  const label = document.getElementById('skill-create-body-label');
  if (label) {
    const c = draft.conformance;
    label.textContent = `Draft (${draft.mode === 'llm' ? 'local LLM' : draft.mode}`
      + (c ? ` · contract ${c.score}/${c.maxScore}` : '')
      + ') — edit before approving';
  }
  review.classList.remove('hidden');
  approve.classList.remove('hidden');
  setStatus(SKILL_AUTHORING_SOP.running.review);

  // The engram must be CHOSEN. An unset select keeps approve disabled, so there
  // is no way to write into a target nobody picked.
  const sync = (): void => {
    approve.disabled = !engramEl.value || !bodyEl.value.trim() || !nameEl.value.trim();
    approve.title = engramEl.value ? '' : 'Choose the engram to train this skill into.';
  };
  engramEl.addEventListener('change', sync);
  bodyEl.addEventListener('input', sync);
  nameEl.addEventListener('input', sync);
  sync();

  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { body: string; name: string; graphId: string } | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    approve.addEventListener('click', () => {
      if (approve.disabled) return;
      approve.disabled = true;
      review.classList.add('hidden');
      done({
        body: bodyEl.value,
        name: nameEl.value.trim(),
        graphId: engramEl.value,
      });
    });
    document.getElementById('btn-skill-create-cancel')?.addEventListener('click', () => done(null));
    document.getElementById('btn-skill-create-close')?.addEventListener('click', () => done(null));
    modal.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') done(null);
    });
  });
}

/** Test seam: reset the singleton between cases. */
export function __resetSkillCreateState(): void {
  state.recalled = null;
  state.draft = null;
  state.approved = null;
  closeModal();
}
