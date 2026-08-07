/**
 * Structured field-level diff for skill Accept review.
 * Compares Agempus contract fields + dispatch-safe + step counts — not a
 * full prose LCS (the UI can still show line diff for the body).
 */

import { parseSkillText, CONTRACT_FIELDS, type ContractField } from './skill-compiler.js';

export interface SkillFieldChange {
  field: string;
  before: string;
  after: string;
  status: 'unchanged' | 'added' | 'removed' | 'changed';
}

export interface SkillProposalStructuredDiff {
  titleChanged: boolean;
  titleBefore: string;
  titleAfter: string;
  dispatchSafeBefore: string;
  dispatchSafeAfter: string;
  dispatchSafeChanged: boolean;
  contract: SkillFieldChange[];
  stepsBefore: number;
  stepsAfter: number;
  stepsChanged: boolean;
  /** Human summary line for the pending card meta. */
  summary: string;
}

function statusOf(before: string, after: string): SkillFieldChange['status'] {
  if (!before && after) return 'added';
  if (before && !after) return 'removed';
  if (before !== after) return 'changed';
  return 'unchanged';
}

/** Diff current (saved) skill text vs proposed trained text. */
export function diffSkillProposal(currentText: string, proposedText: string): SkillProposalStructuredDiff {
  const cur = parseSkillText(currentText || '');
  const next = parseSkillText(proposedText || '');

  const titleBefore = cur.title ?? '';
  const titleAfter = next.title ?? '';
  const dsBefore = cur.dispatchSafe ?? '(unset)';
  const dsAfter = next.dispatchSafe ?? '(unset)';

  const contract: SkillFieldChange[] = [];
  for (const field of CONTRACT_FIELDS) {
    const before = cur.contract.get(field as ContractField) ?? '';
    const after = next.contract.get(field as ContractField) ?? '';
    const status = statusOf(before, after);
    if (status === 'unchanged') continue;
    contract.push({ field, before, after, status });
  }

  const stepsBefore = cur.steps.length;
  const stepsAfter = next.steps.length;

  const bits: string[] = [];
  if (titleBefore !== titleAfter) bits.push('title');
  if (dsBefore !== dsAfter) bits.push(`dispatch-safe: ${dsBefore} → ${dsAfter}`);
  if (contract.length) bits.push(`${contract.length} contract field(s)`);
  if (stepsBefore !== stepsAfter) bits.push(`steps ${stepsBefore} → ${stepsAfter}`);
  if (bits.length === 0) bits.push('body/prose changes only');

  return {
    titleChanged: titleBefore !== titleAfter,
    titleBefore,
    titleAfter,
    dispatchSafeBefore: dsBefore,
    dispatchSafeAfter: dsAfter,
    dispatchSafeChanged: dsBefore !== dsAfter,
    contract,
    stepsBefore,
    stepsAfter,
    stepsChanged: stepsBefore !== stepsAfter,
    summary: bits.join(' · '),
  };
}

/** Markdown-ish block for the pending card (plain text safe). */
export function formatStructuredDiffForUi(diff: SkillProposalStructuredDiff): string {
  const lines: string[] = [`Changes: ${diff.summary}`, ''];
  if (diff.titleChanged) {
    lines.push(`Title: "${diff.titleBefore || '—'}" → "${diff.titleAfter || '—'}"`);
  }
  if (diff.dispatchSafeChanged) {
    lines.push(`dispatch-safe: ${diff.dispatchSafeBefore} → ${diff.dispatchSafeAfter}`);
  }
  if (diff.stepsChanged) {
    lines.push(`Steps: ${diff.stepsBefore} → ${diff.stepsAfter}`);
  }
  for (const c of diff.contract) {
    const mark = c.status === 'added' ? '+' : c.status === 'removed' ? '−' : '~';
    lines.push(`${mark} ${c.field}:`);
    if (c.before) lines.push(`    was: ${c.before.slice(0, 160)}`);
    if (c.after) lines.push(`    now: ${c.after.slice(0, 160)}`);
  }
  return lines.join('\n');
}
