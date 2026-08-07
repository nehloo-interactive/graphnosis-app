// Regression: in-place retrain matching must be case- and punctuation-
// insensitive on the skill name. A slug passed for a title-cased skill
// (e.g. "enterprise-compliance-lens" vs the stored "Enterprise Compliance
// Lens") must resolve to the SAME source, not fork a duplicate.
// Observed 2026-06-26 during the skills-paper improve pass: the slug name
// failed the exact `=== baseName` test and train_skill created a second
// source. Pure functions — no cortex, no LLM.

import { baseSkillName, skillNameMatchKey } from '../apps/desktop-sidecar/src/skill-trainer.js';
import { assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

async function skillNameMatchSuite(): Promise<void> {
  section('baseSkillName — strips skill:<ts>: prefix and (trained …) suffix');
  assert(baseSkillName('skill:1781968688081:go-to-market-planning') === 'go-to-market-planning', 'strips prefix');
  assert(baseSkillName('go-to-market-planning (trained 2026-06-26)') === 'go-to-market-planning', 'strips trained suffix');

  section('skillNameMatchKey — slug and title-case resolve to the same key');
  assert(
    skillNameMatchKey('Enterprise Compliance Lens') === skillNameMatchKey('enterprise-compliance-lens'),
    'title-case == slug',
    { titleCase: skillNameMatchKey('Enterprise Compliance Lens'), slug: skillNameMatchKey('enterprise-compliance-lens') },
  );
  assert(skillNameMatchKey('enterprise-compliance-lens') === 'enterprise-compliance-lens', 'slug key is itself');
  assert(
    skillNameMatchKey('skill:123:Enterprise Compliance Lens (trained 2026-06-26)') === 'enterprise-compliance-lens',
    'key strips prefix+suffix, then normalizes case/punctuation',
  );

  section('skillNameMatchKey — distinct skills do NOT collide');
  assert(
    skillNameMatchKey('go-to-market-planning') !== skillNameMatchKey('go-to-market-strategy'),
    'distinct names stay distinct',
  );
}

export async function run(): Promise<SuiteResult> {
  return runSuite('skill-name-match', skillNameMatchSuite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('skill-name-match', skillNameMatchSuite);
