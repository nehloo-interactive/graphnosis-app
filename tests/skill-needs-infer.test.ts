// Auto-@needs inference: a step with no explicit @needs should get a best-fit
// capability inferred from its text (so the router right-sizes instead of
// defaulting every un-annotated step to ['general'] → the 1B model). An explicit
// @needs tag must still override the inference. Pure function — no host, no LLM.

import { inferCapabilities, deriveStepsFromText } from '../apps/desktop-sidecar/src/model-router.js';
import { assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

async function needsInferSuite(): Promise<void> {
  section('inferCapabilities — heavy capabilities win, trivial → fast');
  assert(inferCapabilities('Refactor the auth module and fix the failing test')[0] === 'code', 'code step → code');
  assert(inferCapabilities('Analyze the trade-offs and decide the pricing tier')[0] === 'reasoning', 'analysis → reasoning');
  assert(inferCapabilities('Draft the release announcement')[0] === 'writing', 'draft → writing');
  assert(inferCapabilities('Summarize the week into a digest')[0] === 'summarization', 'summary → summarization');
  assert(inferCapabilities('List the open files and check status')[0] === 'fast', 'trivial → fast');
  assert(inferCapabilities('Extract the author name from the recalled note')[0] === 'extraction', 'extract step → extraction');
  assert(inferCapabilities('Extract fields into a JSON object')[0] === 'structured-output', 'extract-fields-to-JSON stays → structured-output');
  assert(inferCapabilities('Greet the stakeholder by name')[0] === 'general', 'no hint → general');

  section('deriveStepsFromText — explicit @needs overrides inference');
  const steps = deriveStepsFromText([
    { index: 1, text: 'Draft the announcement email. @needs: reasoning' },
    { index: 2, text: 'Draft the announcement email.' },
    // Guards the bug where 'extraction' was missing from the router's known-capability
    // list, so a valid @needs tag was silently dropped and the step fell back to general.
    { index: 3, text: 'Pull the totals from the invoices. @needs: extraction' },
  ]);
  assert(steps[0]?.capabilities?.join() === 'reasoning', 'explicit @needs wins over inference');
  assert(steps[1]?.capabilities?.includes('writing') === true, 'no @needs → inferred (writing), not general');
  assert(steps[2]?.capabilities?.join() === 'extraction', '@needs: extraction survives (not dropped to general)');
}

export async function run(): Promise<SuiteResult> {
  return runSuite('skill-needs-infer', needsInferSuite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('skill-needs-infer', needsInferSuite);
