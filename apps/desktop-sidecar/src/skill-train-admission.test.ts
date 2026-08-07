import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideTrainAdmission,
  praxisAutoAcceptAllowed,
  DEFAULT_PRAXIS_AUTONOMY,
  type TrainAdmissionInput,
} from './skill-train-admission.js';

const base: TrainAdmissionInput = {
  caller: 'mcp',
  skillLabel: 'cortex-gardening',
  isNewSkill: false,
  requestedSave: true,
};

describe('skill train admission', () => {
  it('defaults Praxis dial to preview-first', () => {
    assert.equal(DEFAULT_PRAXIS_AUTONOMY, 'preview-first');
  });

  it('never silent-saves a new skill from MCP', () => {
    const d = decideTrainAdmission({ ...base, isNewSkill: true, requestedSave: true });
    assert.equal(d.save, false);
    assert.equal(d.forcedDraft, true);
    assert.match(d.reason, /new skill/i);
  });

  it('MCP retrain without approved → draft + proposal stash', () => {
    const d = decideTrainAdmission({ ...base, caller: 'mcp', requestedSave: true });
    assert.equal(d.save, false);
    assert.equal(d.stashAsProposal, true);
    assert.equal(d.forcedDraft, true);
  });

  it('human IPC / accept-proposal may write', () => {
    assert.equal(
      decideTrainAdmission({ ...base, caller: 'ipc-human', requestedSave: true }).save,
      true,
    );
    assert.equal(
      decideTrainAdmission({ ...base, caller: 'accept-proposal', requestedSave: true }).save,
      true,
    );
    assert.equal(
      decideTrainAdmission({ ...base, caller: 'mcp', approved: true, requestedSave: true }).save,
      true,
    );
  });

  it('meta skills never auto-accept under Praxis', () => {
    const d = decideTrainAdmission({
      ...base,
      caller: 'autopraxis',
      skillLabel: 'skill-dispatch',
      praxisEnabled: true,
      praxisAutonomy: 'auto-accept',
      requestedSave: true,
    });
    assert.equal(d.save, false);
    assert.match(d.reason, /meta/i);
  });

  it('Praxis auto-accept works when opted in and clean', () => {
    const d = decideTrainAdmission({
      ...base,
      caller: 'autopraxis',
      praxisEnabled: true,
      praxisAutonomy: 'auto-accept',
      hasOpenContradictions: false,
      isNewSkill: false,
    });
    assert.equal(d.save, true);
    assert.equal(d.promotion, 'auto-accept');
  });

  it('open contradictions cap Praxis auto-accept to draft', () => {
    const d = decideTrainAdmission({
      ...base,
      caller: 'autopraxis',
      praxisEnabled: true,
      praxisAutonomy: 'auto-accept',
      hasOpenContradictions: true,
    });
    assert.equal(d.save, false);
    assert.equal(d.stashAsProposal, true);
    assert.match(d.reason, /contradiction/i);
  });

  it('notify means draft + badge, not silent write', () => {
    const d = decideTrainAdmission({
      ...base,
      caller: 'autopraxis',
      praxisEnabled: true,
      praxisAutonomy: 'notify',
    });
    assert.equal(d.save, false);
    assert.equal(d.notify, true);
    assert.equal(d.stashAsProposal, true);
  });

  it('staleness without Praxis opt-in drafts only', () => {
    const d = decideTrainAdmission({
      ...base,
      caller: 'staleness-queue',
      praxisEnabled: false,
      requestedSave: true,
    });
    assert.equal(d.save, false);
    assert.equal(d.stashAsProposal, true);
    assert.match(d.reason, /without Praxis/i);
  });

  it('praxisAutoAcceptAllowed helper matches stance', () => {
    assert.ok(praxisAutoAcceptAllowed({
      skillLabel: 'cortex-gardening',
      praxisEnabled: true,
      hasOpenContradictions: false,
      isNewSkill: false,
    }));
    assert.ok(!praxisAutoAcceptAllowed({
      skillLabel: 'skill-dispatch',
      praxisEnabled: true,
      hasOpenContradictions: false,
      isNewSkill: false,
    }));
    assert.ok(!praxisAutoAcceptAllowed({
      skillLabel: 'cortex-gardening',
      praxisEnabled: true,
      hasOpenContradictions: true,
      isNewSkill: false,
    }));
  });
});
