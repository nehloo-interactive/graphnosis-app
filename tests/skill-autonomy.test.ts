// Skills Autonomy Engine (#16) — the gating decision. Pure, deterministic.
// Proves the core invariant: autonomy is capped by authored safety, never the
// reverse. Levels map to actions; dispatch-safety, meta-routing, open
// contradictions, and low confidence each cap how far a skill may be taken.

import {
  decideSkillAutonomy,
  safetyCeiling,
  isAutonomous,
  AUTONOMY_CONFIDENCE_FLOOR,
  type SkillAutonomyInput,
} from '../apps/desktop-sidecar/src/skill-autonomy.js';
import { assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

const base: SkillAutonomyInput = {
  level: 'L3',
  dispatchSafe: 'yes',
  isMetaSkill: false,
  matchConfidence: 0.95,
};
const d = (over: Partial<SkillAutonomyInput>) => decideSkillAutonomy({ ...base, ...over });

async function autonomySuite(): Promise<void> {
  section('level → action when nothing caps');
  assert(d({ level: 'L0' }).action === 'manual', 'L0 → manual');
  assert(d({ level: 'L1' }).action === 'suggest', 'L1 → suggest');
  assert(d({ level: 'L2' }).action === 'preview', 'L2 → preview');
  assert(d({ level: 'L3' }).action === 'auto', 'L3 + dispatch-safe:yes + high conf → auto');
  assert(isAutonomous(d({ level: 'L3' })) === true, 'isAutonomous true only at auto');

  section('safety ceiling caps autonomy (never the reverse)');
  const no = d({ level: 'L3', dispatchSafe: 'no' });
  assert(no.action === 'suggest' && no.capped, 'dispatch-safe:no caps L3 to suggest', no);
  assert(no.reason.includes('dispatch-safe:no'), 'reason names the binding gate', no.reason);
  const partial = d({ level: 'L3', dispatchSafe: 'partial' });
  assert(partial.action === 'preview' && partial.capped, 'dispatch-safe:partial caps L3 to preview', partial);
  assert(d({ level: 'L1', dispatchSafe: 'partial' }).action === 'suggest', 'a lower level is not raised by a higher ceiling');

  section('meta-skills never auto-run');
  const meta = d({ level: 'L3', isMetaSkill: true });
  assert(meta.action === 'suggest' && meta.reason.includes('meta'), 'meta/router capped to suggest', meta);
  assert(safetyCeiling({ dispatchSafe: 'yes', isMetaSkill: true }) === 'suggest', 'ceiling: meta beats dispatch-safe:yes');

  section('contradiction-aware (seam with #13): never auto-act on contradicted memory');
  const contra = d({ level: 'L3', hasUnresolvedContradiction: true });
  assert(contra.action === 'preview' && contra.reason.includes('contradiction'), 'open contradiction caps to preview', contra);

  section('confidence floor downgrades to suggest');
  const weak = d({ level: 'L3', matchConfidence: AUTONOMY_CONFIDENCE_FLOOR - 0.01 });
  assert(weak.action === 'suggest' && weak.reason.includes('confidence'), 'weak match capped to suggest', weak);
  assert(d({ level: 'L2', matchConfidence: 0.3 }).action === 'suggest', 'weak match also caps preview to suggest');
  assert(d({ level: 'L1', matchConfidence: 0.1 }).action === 'suggest', 'suggest is the floor, not manual, for a surfaced match');

  section('transparency fields');
  const capped = d({ level: 'L3', dispatchSafe: 'no' });
  assert(capped.requested === 'auto', 'requested records what the level wanted');
  assert(d({ level: 'L3' }).capped === false, 'uncapped decisions report capped=false');
}

export async function run(): Promise<SuiteResult> {
  return runSuite('skill-autonomy', autonomySuite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('skill-autonomy', autonomySuite);
