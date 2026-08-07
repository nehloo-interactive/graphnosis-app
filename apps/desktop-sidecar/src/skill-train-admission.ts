/**
 * Skill train admission — procedural authority gate.
 *
 * A skill is closer to installing code than saving a note. This module is the
 * shared conscience for every write path (MCP, IPC, Praxis, staleness queue):
 *
 *   - NEW skills never silent-save without human approval
 *   - Draft without approval is fine (propose → "Train this?")
 *   - Retrain: preview-first / notify (draft) by default; auto-accept only
 *     for skills the owner opted into Praxis, never meta/dispatch, never
 *     while the target engram has open contradictions
 *
 * Pure + deterministic. Host/IO stays in callers.
 */

import { isMetaSkillLabel } from './skill-autonomy.js';

/** Who is asking to train / retrain. */
export type TrainCaller =
  | 'mcp'
  | 'ipc-human'
  | 'accept-proposal'
  | 'autopraxis'
  | 'staleness-queue'
  | 'ghampus-retrain';

/** Praxis promotion dial (retrain axis — not L0–L3 execution autonomy). */
export type RetrainPromotion = 'notify' | 'auto-accept' | 'preview-first';

export interface TrainAdmissionInput {
  caller: TrainCaller;
  /** Base skill label (any skill:<ts>: prefix stripped is fine). */
  skillLabel: string;
  /** True when no existing skill source matches this name in the target engram. */
  isNewSkill: boolean;
  /** Caller requested persistence. */
  requestedSave: boolean;
  /**
   * Human explicitly approved this write (Train-this button, Accept proposal,
   * or MCP `approved: true` after the user confirmed in-app).
   */
  approved?: boolean;
  /** Per-skill Praxis config is present and enabled. */
  praxisEnabled?: boolean;
  /** Owner-chosen Praxis promotion level (ignored when praxisEnabled is false). */
  praxisAutonomy?: RetrainPromotion;
  /** Unresolved contradictions involving the target skill engram (or cortex-wide attention). */
  hasOpenContradictions?: boolean;
}

export interface TrainAdmissionDecision {
  /** May the trainer persist into the Skills engram? */
  save: boolean;
  /** Stash trained text in skillRetrainPending for review. */
  stashAsProposal: boolean;
  /** Mark sourceId in skillRetrainNotifications (🆕 badge). */
  notify: boolean;
  /** Hard refuse — do not train at all (rare; usually we draft instead). */
  refuse: boolean;
  /** Effective promotion after caps. */
  promotion: RetrainPromotion | 'refuse' | 'human-approved';
  /** Human-readable reason for logs / MCP responses. */
  reason: string;
  /** True when we overrode requestedSave to false. */
  forcedDraft: boolean;
}

const HUMAN_WRITE_CALLERS: ReadonlySet<TrainCaller> = new Set([
  'ipc-human',
  'accept-proposal',
]);

/**
 * Decide whether a train/retrain may write, must draft, or is refused.
 *
 * Invariant: **approval (or narrow Praxis auto-accept) before procedural write.**
 */
export function decideTrainAdmission(input: TrainAdmissionInput): TrainAdmissionDecision {
  const label = input.skillLabel.replace(/^skill:\d+:/, '').trim();
  const isMeta = isMetaSkillLabel(label);

  // ── Explicit human approval always writes (accept proposal / Train this) ──
  if (input.approved === true || HUMAN_WRITE_CALLERS.has(input.caller)) {
    if (input.requestedSave === false && input.caller !== 'accept-proposal') {
      // Human asked for a draft preview — honor it.
      return {
        save: false,
        stashAsProposal: false,
        notify: false,
        refuse: false,
        promotion: 'preview-first',
        reason: 'human draft preview (save: false)',
        forcedDraft: false,
      };
    }
    return {
      save: true,
      stashAsProposal: false,
      notify: false,
      refuse: false,
      promotion: 'human-approved',
      reason: 'human-approved write',
      forcedDraft: false,
    };
  }

  // ── Autopraxis / staleness without opt-in ─────────────────────────────────
  if (input.caller === 'staleness-queue' && !input.praxisEnabled) {
    return draftDecision(
      'preview-first',
      'staleness retrain without Praxis opt-in — draft only (Train this?)',
      true,
    );
  }

  if (input.caller === 'autopraxis' && !input.praxisEnabled) {
    return {
      save: false,
      stashAsProposal: false,
      notify: false,
      refuse: true,
      promotion: 'refuse',
      reason: 'Praxis scheduler requires per-skill opt-in',
      forcedDraft: false,
    };
  }

  // ── Meta / dispatch skills: never silent write ────────────────────────────
  if (isMeta && input.requestedSave) {
    return draftDecision(
      'preview-first',
      'meta/dispatch skill — never silent-train; draft for human approval',
      true,
    );
  }

  // ── New skills: never silent-save from agents / schedulers ────────────────
  if (input.isNewSkill && input.requestedSave) {
    return {
      save: false,
      // Caller stashes under draft:<uuid> in skillRetrainPending (Train this? inbox).
      stashAsProposal: true,
      notify: true,
      refuse: false,
      promotion: 'preview-first',
      reason: 'new skill — draft only until human approves (Train this?)',
      forcedDraft: true,
    };
  }

  // ── Open contradictions: cap to preview-first (Memory Integrity spirit) ───
  if (input.hasOpenContradictions && input.requestedSave) {
    const praxis = resolvePraxisPromotion(input);
    if (praxis === 'auto-accept') {
      return draftDecision(
        'preview-first',
        'open contradictions on target — capped auto-accept to preview-first',
        true,
      );
    }
  }

  // ── Praxis opt-in retrain lane ────────────────────────────────────────────
  if (
    (input.caller === 'autopraxis' || input.caller === 'staleness-queue')
    && input.praxisEnabled
  ) {
    const promotion = resolvePraxisPromotion(input);
    if (promotion === 'auto-accept') {
      if (isMeta) {
        return draftDecision(
          'preview-first',
          'Praxis auto-accept refused for meta skill — draft instead',
          true,
        );
      }
      if (input.hasOpenContradictions) {
        return draftDecision(
          'preview-first',
          'Praxis auto-accept refused while contradictions open — draft instead',
          true,
        );
      }
      if (input.isNewSkill) {
        return draftDecision(
          'preview-first',
          'Praxis never creates new skills — draft only',
          true,
        );
      }
      return {
        save: true,
        stashAsProposal: false,
        notify: false,
        refuse: false,
        promotion: 'auto-accept',
        reason: 'Praxis auto-accept (owner opted in)',
        forcedDraft: false,
      };
    }
    if (promotion === 'notify') {
      // Stance: notify = draft + badge, NOT silent write then toast.
      return {
        save: false,
        stashAsProposal: true,
        notify: true,
        refuse: false,
        promotion: 'notify',
        reason: 'Praxis notify — draft + notification (approval before write)',
        forcedDraft: true,
      };
    }
    // preview-first
    return {
      save: false,
      stashAsProposal: true,
      notify: false,
      refuse: false,
      promotion: 'preview-first',
      reason: 'Praxis preview-first — draft for review',
      forcedDraft: true,
    };
  }

  // ── MCP / Ghampus tool path without approved flag ─────────────────────────
  if (input.caller === 'mcp' || input.caller === 'ghampus-retrain') {
    if (!input.requestedSave) {
      return {
        save: false,
        stashAsProposal: true, // Train this? inbox (retrain or draft:<uuid>)
        notify: input.isNewSkill,
        refuse: false,
        promotion: 'preview-first',
        reason: 'explicit draft (save: false)',
        forcedDraft: false,
      };
    }
    // save:true from an agent without approved → force draft
    return {
      save: false,
      stashAsProposal: true,
      notify: true,
      refuse: false,
      promotion: 'preview-first',
      reason: 'agent train without approval — draft for Train this?',
      forcedDraft: true,
    };
  }

  // Fallback: never write silently
  if (input.requestedSave) {
    return draftDecision(
      'preview-first',
      'unclassified caller — defaulting to draft',
      true,
    );
  }
  return {
    save: false,
    stashAsProposal: false,
    notify: false,
    refuse: false,
    promotion: 'preview-first',
    reason: 'draft',
    forcedDraft: false,
  };
}

function resolvePraxisPromotion(input: TrainAdmissionInput): RetrainPromotion {
  return input.praxisAutonomy ?? 'preview-first';
}

function draftDecision(
  promotion: RetrainPromotion,
  reason: string,
  forcedDraft: boolean,
): TrainAdmissionDecision {
  return {
    save: false,
    stashAsProposal: promotion !== 'auto-accept',
    notify: promotion === 'notify',
    refuse: false,
    promotion,
    reason,
    forcedDraft,
  };
}

/** Default Praxis dial for new opt-ins — matches approval-first stance. */
export const DEFAULT_PRAXIS_AUTONOMY: RetrainPromotion = 'preview-first';

/** True when auto-accept is allowed for this label under the stance. */
export function praxisAutoAcceptAllowed(input: {
  skillLabel: string;
  praxisEnabled: boolean;
  hasOpenContradictions: boolean;
  isNewSkill: boolean;
}): boolean {
  if (!input.praxisEnabled) return false;
  if (input.isNewSkill) return false;
  if (input.hasOpenContradictions) return false;
  if (isMetaSkillLabel(input.skillLabel)) return false;
  return true;
}
