import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffSkillProposal, formatStructuredDiffForUi } from './skill-proposal-diff.js';

const baseSkill = `# cortex-gardening

[dispatch-safe: yes]

Trigger: Weekly review
Success: Cortex tidy

1. List open todos
2. Archive done items
`;

const changedSkill = `# cortex-gardening-v2

[dispatch-safe: partial]

Trigger: Daily review
Success: Cortex tidy and prioritized
Out of scope: Investor updates

1. List open todos
2. Archive done items
3. Prioritize next week
`;

describe('skill proposal structured diff', () => {
  it('flags title, dispatch-safe, contract, and step changes', () => {
    const d = diffSkillProposal(baseSkill, changedSkill);
    assert.equal(d.titleChanged, true);
    assert.equal(d.dispatchSafeChanged, true);
    assert.equal(d.dispatchSafeBefore, 'yes');
    assert.equal(d.dispatchSafeAfter, 'partial');
    assert.equal(d.stepsChanged, true);
    assert.equal(d.stepsBefore, 2);
    assert.equal(d.stepsAfter, 3);
    assert.ok(d.contract.some((c) => c.field === 'Trigger'));
    assert.ok(d.summary.includes('dispatch-safe'));
  });

  it('reports body-only when structure matches', () => {
    const d = diffSkillProposal(baseSkill, baseSkill.replace('List open', 'List all open'));
    assert.equal(d.titleChanged, false);
    assert.equal(d.dispatchSafeChanged, false);
    assert.equal(d.stepsChanged, false);
    assert.equal(d.contract.length, 0);
    assert.match(d.summary, /body\/prose/i);
  });

  it('formats a readable UI block', () => {
    const text = formatStructuredDiffForUi(diffSkillProposal('', changedSkill));
    assert.match(text, /Changes:/);
    assert.match(text, /dispatch-safe/);
  });
});
