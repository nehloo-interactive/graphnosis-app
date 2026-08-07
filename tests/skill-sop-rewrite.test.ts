// Regression: the SOP structure-preservation validator must guard the
// per-step model-routing tag (@needs:) and the recall/privacy binding
// (only_engrams=[...]), not just @skill / @loop / @branch / goal headers.
//
// Before this fix SOP_TOKEN_PATTERNS omitted both, so a Pro LLM rewrite could
// silently drop a routing tag (changing which model a step runs on) or a
// recall binding (changing which engrams a step reads) and validateSopPreservation
// would still report ok=true. These are pure functions — no cortex, no LLM.

import {
  validateSopPreservation,
  extractSopPreservationSnapshot,
} from '../apps/desktop-sidecar/src/skill-sop-rewrite.js';
import { assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

const ORIGINAL = [
  'Trigger: Session start when routing skills.',
  'Success: Plan returned. [verify: tool]',
  '',
  '1. recall("dispatch routing", only_engrams=["coding", "graphnosis-skills"]). @needs: reasoning',
  '2. Summarize matches into a plan. @needs: summarization, writing',
  '3. @skill: session-start',
].join('\n');

async function sopRewriteSuite(): Promise<void> {
  section('extractSopPreservationSnapshot — captures @needs + only_engrams');
  const tokens = extractSopPreservationSnapshot(ORIGINAL).tokens.join(' || ');
  assert(/@needs:\s*reasoning/i.test(tokens), 'captures single-capability @needs', tokens);
  assert(/@needs:\s*summarization, writing/i.test(tokens), 'captures multi-capability @needs', tokens);
  assert(/only_engrams=\["coding", "graphnosis-skills"\]/i.test(tokens), 'captures only_engrams binding', tokens);
  assert(/@skill:\s*session-start/i.test(tokens), 'still captures @skill (no regression)', tokens);

  section('validateSopPreservation — passes when routing tags survive a prose edit');
  const faithful = ORIGINAL.replace('Summarize matches into a plan.', 'Summarize the matched skills into an ordered plan.');
  const okResult = validateSopPreservation(ORIGINAL, faithful);
  assert(okResult.ok === true, 'prose-only rewrite that preserves tags passes', okResult.missing);

  section('validateSopPreservation — flags a dropped @needs tag');
  const droppedNeeds = ORIGINAL.replace(' @needs: reasoning', '');
  const r1 = validateSopPreservation(ORIGINAL, droppedNeeds);
  assert(r1.ok === false, 'dropping @needs is rejected');
  assert(r1.missing.some((m) => /@needs:\s*reasoning/i.test(m)), 'missing list names the dropped @needs', r1.missing);

  section('validateSopPreservation — flags a dropped only_engrams binding');
  const droppedBinding = ORIGINAL.replace(', only_engrams=["coding", "graphnosis-skills"]', '');
  const r2 = validateSopPreservation(ORIGINAL, droppedBinding);
  assert(r2.ok === false, 'dropping only_engrams is rejected');
  assert(r2.missing.some((m) => /only_engrams/i.test(m)), 'missing list names the dropped binding', r2.missing);
}

export async function run(): Promise<SuiteResult> {
  return runSuite('skill-sop-rewrite', sopRewriteSuite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('skill-sop-rewrite', sopRewriteSuite);
