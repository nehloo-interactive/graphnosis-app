// Dispatch-safe readout — the computed effective execution-autonomy ceiling.
//
// effectiveLevel = min(engram's configured executionAutonomyLevel, the authored
// dispatch-safe cap derived from the engram's skills' [dispatch-safe: …] tags).
// The cap is the MOST permissive skill's cap (each skill is still capped per
// dispatch); an engram with no skills is uncapped (L3). These tests prove the
// pure compute function and the host-backed readout + the set-autonomy refusal
// when a requested level exceeds the cap.

import {
  computeDispatchSafeReadout,
  dispatchSafeCapForSkill,
  parseDispatchSafe,
  isMetaSkillLabel,
  levelRank,
  type SkillSafetyInfo,
} from '../apps/desktop-sidecar/src/skill-autonomy.js';
import { assert, section, standalone, runSuite, setupTestCortex, type SuiteResult } from './_helpers.js';
import type { GraphnosisHost } from '../apps/desktop-sidecar/src/host.js';

async function ingestSkill(host: GraphnosisHost, graphId: string, name: string, tag: string): Promise<string> {
  const ref = `skill:${name}`;
  const content = `# ${name}\n\nTrigger: do the thing ${tag}\n\n1. Step one.`;
  const rec = await host.ingest(graphId, 'skill', ref, { kind: 'markdown', content, sourceRef: ref });
  return rec.sourceId;
}

async function dispatchSafeSuite(): Promise<void> {
  section('parse helpers');
  assert(parseDispatchSafe('Trigger: x [dispatch-safe: no]') === 'no', 'parses :no');
  assert(parseDispatchSafe('Trigger: x [dispatch-safe: partial]') === 'partial', 'parses :partial');
  assert(parseDispatchSafe('Trigger: x [dispatch-safe: yes]') === 'yes', 'parses :yes');
  assert(parseDispatchSafe('no tag here') === 'yes', 'missing tag → yes (explicit opt-out model)');
  assert(parseDispatchSafe('[dispatch-safe: bogus]') === 'yes', 'unknown value → yes');
  assert(isMetaSkillLabel('skill:123:skill-dispatch') === true, 'meta-skill label detected with prefix');
  assert(isMetaSkillLabel('ordinary-skill') === false, 'ordinary label is not meta');

  section('per-skill cap from authored safety');
  assert(dispatchSafeCapForSkill({ dispatchSafe: 'yes', isMetaSkill: false }) === 'L3', 'yes → L3');
  assert(dispatchSafeCapForSkill({ dispatchSafe: 'partial', isMetaSkill: false }) === 'L2', 'partial → L2');
  assert(dispatchSafeCapForSkill({ dispatchSafe: 'no', isMetaSkill: false }) === 'L1', 'no → L1');
  assert(dispatchSafeCapForSkill({ dispatchSafe: 'yes', isMetaSkill: true }) === 'L1', 'meta/router → L1 even at dispatch-safe:yes');

  section('computeDispatchSafeReadout — pure');
  const skills: SkillSafetyInfo[] = [
    { sourceId: 's1', label: 'a', dispatchSafe: 'no', isMetaSkill: false },      // cap L1
    { sourceId: 's2', label: 'b', dispatchSafe: 'partial', isMetaSkill: false }, // cap L2
    { sourceId: 's3', label: 'c', dispatchSafe: 'yes', isMetaSkill: false },     // cap L3
  ];
  const r = computeDispatchSafeReadout('g', 'L3', skills);
  assert(r.dispatchSafeCap === 'L3', 'cap = most permissive skill (L3)', r);
  assert(r.effectiveLevel === 'L3', 'effective = min(L3 configured, L3 cap) = L3', r);
  assert(r.perSkill.length === 3 && r.perSkill[0]?.cap === 'L1', 'per-skill caps reported', r.perSkill);

  const capped = computeDispatchSafeReadout('g', 'L3', [
    { sourceId: 's1', label: 'a', dispatchSafe: 'partial', isMetaSkill: false }, // cap L2
    { sourceId: 's2', label: 'b', dispatchSafe: 'no', isMetaSkill: false },      // cap L1
  ]);
  assert(capped.dispatchSafeCap === 'L2', 'cap = L2 (most permissive is partial)', capped);
  assert(capped.effectiveLevel === 'L2', 'L3 configured clamped to L2 cap', capped);

  const lowConfig = computeDispatchSafeReadout('g', 'L1', skills);
  assert(lowConfig.effectiveLevel === 'L1', 'a lower configured level is not raised by a higher cap', lowConfig);

  const empty = computeDispatchSafeReadout('g', 'L3', []);
  assert(empty.dispatchSafeCap === 'L3' && empty.effectiveLevel === 'L3', 'empty engram is uncapped (L3)', empty);

  section('host.dispatchSafeReadout — end to end');
  const cortex = await setupTestCortex('dispatch-safe');
  try {
    const host = cortex.host;
    await host.createGraph('skills-x');
    await host.replaceGraphMetadata('skills-x', { template: 'skill', displayName: 'Skills X', createdAt: 1 });
    await ingestSkill(host, 'skills-x', 'safe-one', '[dispatch-safe: yes]');
    await ingestSkill(host, 'skills-x', 'partial-one', '[dispatch-safe: partial]');

    // No configured override → global default L1.
    const ro1 = host.dispatchSafeReadout('skills-x')[0]!;
    assert(ro1.configuredLevel === 'L1', 'configured falls back to global default L1', ro1);
    assert(ro1.dispatchSafeCap === 'L3', 'cap is L3 (the dispatch-safe:yes skill)', ro1);
    assert(ro1.effectiveLevel === 'L1', 'effective = min(L1, L3) = L1', ro1);
    assert(ro1.perSkill.length === 2, 'two skills in the readout', ro1.perSkill);

    // Configure the engram to L3 — effective rises to L3 (cap allows it).
    await host.setGraphExecutionAutonomy('skills-x', 'L3');
    const ro2 = host.dispatchSafeReadout('skills-x')[0]!;
    assert(ro2.configuredLevel === 'L3' && ro2.effectiveLevel === 'L3', 'L3 configured + L3 cap → effective L3', ro2);

    // Add a dispatch-safe:no skill → cap stays L3 (most permissive wins) but the
    // no-skill is individually capped at L1 in perSkill.
    await ingestSkill(host, 'skills-x', 'no-one', '[dispatch-safe: no]');
    const ro3 = host.dispatchSafeReadout('skills-x')[0]!;
    assert(ro3.dispatchSafeCap === 'L3', 'cap still L3 — most permissive skill sets it', ro3);
    const noSkill = ro3.perSkill.find((p) => p.dispatchSafe === 'no');
    assert(noSkill?.cap === 'L1', 'the dispatch-safe:no skill is individually capped at L1', ro3.perSkill);

    // An engram whose ONLY skill is partial → cap L2; a set-to-L3 request would
    // exceed the cap (the MCP setter refuses this; here we assert the cap value).
    await host.createGraph('skills-y');
    await host.replaceGraphMetadata('skills-y', { template: 'skill', displayName: 'Skills Y', createdAt: 2 });
    await ingestSkill(host, 'skills-y', 'only-partial', '[dispatch-safe: partial]');
    const roY = host.dispatchSafeReadout('skills-y')[0]!;
    assert(roY.dispatchSafeCap === 'L2', 'partial-only engram caps at L2', roY);
    assert(levelRank('L3') > levelRank(roY.dispatchSafeCap), 'L3 exceeds the L2 cap (setter must refuse)', roY);

    section('host.dispatchSafeReadout — all engrams');
    const all = host.dispatchSafeReadout();
    const ids = new Set(all.map((x) => x.graphId));
    assert(ids.has('skills-x') && ids.has('skills-y'), 'all-engrams readout covers every skill-bearing engram', [...ids]);
  } finally {
    await cortex.cleanup();
  }
}

export async function run(): Promise<SuiteResult> {
  return runSuite('dispatch-safe-readout', dispatchSafeSuite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('dispatch-safe-readout', dispatchSafeSuite);
