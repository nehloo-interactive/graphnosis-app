// Unattended-executor reversal manager.
//
// SAFETY-CRITICAL: the executor only ever ADMITS actions whose side effects are
// reversible (when requireReversibleOnly, the default). This module is the other
// half of that contract — it (a) classifies an action's reversibility BEFORE the
// step runs (so the admission gate can refuse irreversible ones) and (b) replays
// the inverse on owner request from the review UI.
//
// Reversible kinds, all going through the substrate's indelible, snapshot-
// versioned machinery so the inverse is itself audited:
//   - 'supersede' : a cortex node was superseded → re-supersede with the
//                   captured pre-state content (round-trip via the correction
//                   pipeline). Undoable by construction.
//   - 'skill-edit': a skill's nodes were edited/retrained → roll back to the
//                   snapshot captured before the edit (rollback_skill path).
//   - 'forget'    : a node was forgotten → re-insert from the captured pre-state.
//   - 'none'      : read/compute-only (the MVP walker's normal case — captured
//                   outputs, no mutation). Nothing to undo.
//
// Any side effect that is NONE of the above (e.g. an external MCP tool that
// sends an email) is classified `{ reversible: false }` → the admission gate
// refuses it, and applyUndo refuses it defensively too.

import type { GraphnosisHost } from './host.js';
import type { UndoClassification, UndoKind } from './unattended-audit.js';

/** A side-effect descriptor the walker/executor hands us per action. The MVP
 *  reference walker dispatches LLM prompts and performs NO cortex mutation, so
 *  the common case is `kind: 'none'`. The mutating kinds carry the pre-state we
 *  need to invert them, captured at the moment the side effect was applied. */
export type ActionSideEffect =
  | { kind: 'none' }
  | {
      kind: 'supersede';
      graphId: string;
      nodeId: string;
      /** The node's content BEFORE the supersede — what undo restores. */
      previousContent: string;
    }
  | {
      kind: 'skill-edit';
      graphId: string;
      sourceId: string;
      /** Snapshot id captured before the edit — undo rolls back to it. */
      snapshotId: string;
    }
  | {
      kind: 'forget';
      graphId: string;
      /** Source the forgotten content lived under. */
      sourceId: string;
      /** The forgotten content, captured before the forget, for re-insert. */
      previousContent: string;
    }
  | {
      /** Anything else — an irreversible external side effect. The admission
       *  gate refuses these when requireReversibleOnly. */
      kind: 'external';
      description: string;
    };

interface UndoTokenPayload {
  kind: Exclude<UndoKind, 'none'>;
  graphId: string;
  nodeId?: string;
  sourceId?: string;
  snapshotId?: string;
  previousContent?: string;
}

function encodeToken(p: UndoTokenPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

function decodeToken(token: string): UndoTokenPayload | null {
  try {
    const p = JSON.parse(Buffer.from(token, 'base64').toString('utf8')) as UndoTokenPayload;
    if (p.kind === 'supersede' || p.kind === 'skill-edit' || p.kind === 'forget') return p;
    return null;
  } catch {
    return null;
  }
}

/**
 * Classify whether an action's side effect can be reversed, and mint the token
 * that replays the inverse. Pure + deterministic (no host) so the admission
 * gate's truth table is unit-testable. `none` is trivially reversible (nothing
 * happened); `external` is never reversible.
 */
export function classifyReversibility(effect: ActionSideEffect): UndoClassification {
  switch (effect.kind) {
    case 'none':
      return { reversible: true, kind: 'none' };
    case 'supersede':
      return {
        reversible: true,
        kind: 'supersede',
        undoToken: encodeToken({
          kind: 'supersede',
          graphId: effect.graphId,
          nodeId: effect.nodeId,
          previousContent: effect.previousContent,
        }),
      };
    case 'skill-edit':
      return {
        reversible: true,
        kind: 'skill-edit',
        undoToken: encodeToken({
          kind: 'skill-edit',
          graphId: effect.graphId,
          sourceId: effect.sourceId,
          snapshotId: effect.snapshotId,
        }),
      };
    case 'forget':
      return {
        reversible: true,
        kind: 'forget',
        undoToken: encodeToken({
          kind: 'forget',
          graphId: effect.graphId,
          sourceId: effect.sourceId,
          previousContent: effect.previousContent,
        }),
      };
    case 'external':
      return { reversible: false, kind: 'none' };
  }
}

/** Host surface applyUndo needs — narrowed so it's easy to stub in tests. */
export interface UndoHost {
  applyCorrection: GraphnosisHost['applyCorrection'];
  getFullNodeContent: GraphnosisHost['getFullNodeContent'];
  insertNodeAt: GraphnosisHost['insertNodeAt'];
  skillSnapshots: { read: GraphnosisHost['skillSnapshots']['read'] };
}

/**
 * Replay the inverse of an action from its undoToken. Goes through the same
 * indelible correction/snapshot machinery the forward action used, so the undo
 * is itself audited and re-reversible. Refuses (returns ok:false) for any token
 * that doesn't decode to a reversible kind — defence in depth behind the
 * admission gate, which already never admits an irreversible action.
 */
export async function applyUndo(
  host: UndoHost,
  undoToken: string,
  skillTrainer?: { rollbackSkill: (g: string, s: string, snap: string) => Promise<unknown> } | null,
): Promise<{ ok: boolean; reverted?: UndoKind; reason?: string }> {
  const p = decodeToken(undoToken);
  if (!p) return { ok: false, reason: 'irreversible' };

  try {
    switch (p.kind) {
      case 'supersede': {
        if (!p.nodeId || p.previousContent === undefined) {
          return { ok: false, reason: 'malformed-token' };
        }
        // Re-supersede the (now-current) node with its captured pre-state — a
        // round-trip that restores the original content while preserving audit
        // lineage (supersede is undoable by construction).
        await host.applyCorrection(
          p.graphId,
          {
            edits: [
              {
                kind: 'supersede',
                nodeId: p.nodeId,
                content: p.previousContent,
                reason: 'Unattended-run undo: restore pre-supersede content',
              },
            ],
          },
          { triggeredBy: 'unattended:undo' },
        );
        return { ok: true, reverted: 'supersede' };
      }
      case 'skill-edit': {
        if (!p.sourceId || !p.snapshotId) return { ok: false, reason: 'malformed-token' };
        if (!skillTrainer) return { ok: false, reason: 'skill-trainer-unavailable' };
        await skillTrainer.rollbackSkill(p.graphId, p.sourceId, p.snapshotId);
        return { ok: true, reverted: 'skill-edit' };
      }
      case 'forget': {
        if (!p.sourceId || p.previousContent === undefined) {
          return { ok: false, reason: 'malformed-token' };
        }
        // Re-insert the forgotten content back into its source.
        await host.insertNodeAt(p.graphId, p.sourceId, 0, p.previousContent, {
          triggeredBy: 'unattended:undo',
        });
        return { ok: true, reverted: 'forget' };
      }
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
