// Recipe-binding (opt-in bindRecipes mode): the recipe block the trainer emits
// must (a) parse as a real recall recipe so it binds at walk time, and (b) be
// inserted before the first numbered step — never as the title or a goal.
// Pure functions — no host, no LLM.

import { insertRecipeBeforeFirstStep } from '../apps/desktop-sidecar/src/skill-trainer.js';
import { isRecallRecipeParagraph, parseRecallRecipeText } from '../apps/desktop-sidecar/src/skill-recall-bindings.js';
import { assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

const BLOCK =
  'Personal context: go-to-market-planning\n' +
  '- recall: go-to-market-planning prior context decisions preferences only_engrams: ["graphnosis-go-to-market", "graphnosis-business-strategy"]';

async function recipeBindingSuite(): Promise<void> {
  section('emitted recipe block parses as a recall recipe');
  assert(isRecallRecipeParagraph(BLOCK) === true, 'isRecallRecipeParagraph recognizes the emitted block');
  const parsed = parseRecallRecipeText(BLOCK);
  assert(parsed !== null && parsed.steps.length === 1, 'parses exactly one recipe step', parsed);
  assert(parsed?.steps[0]?.tool === 'recall', 'recipe tool is recall');
  assert(
    parsed?.steps[0]?.onlyEngrams?.join(',') === 'graphnosis-go-to-market,graphnosis-business-strategy',
    'only_engrams parsed (binding, not frozen content)', parsed?.steps[0],
  );
  assert(parsed?.steps[0]?.query?.includes('go-to-market-planning') === true, 'query preserved');

  section('insertRecipeBeforeFirstStep — before step 1, never as the title');
  const skill = 'go-to-market-planning\n\nTrigger: GTM question.\nSuccess: brief written. [verify: human]\n\n1. Frame the launch scope.\n2. Define the ICP.';
  const out = insertRecipeBeforeFirstStep(skill, BLOCK);
  assert(out.split('\n').filter(Boolean)[0] === 'go-to-market-planning', 'title stays first line (recipe not above title)');
  const recipeIdx = out.indexOf('- recall:');
  const step1Idx = out.indexOf('1. Frame');
  assert(recipeIdx >= 0 && recipeIdx < step1Idx, 'recipe inserted before the first numbered step');

  section('insertRecipeBeforeFirstStep — no numbered steps → appended at end');
  const noSteps = 'some-skill\n\nTrigger: x.';
  const out2 = insertRecipeBeforeFirstStep(noSteps, BLOCK);
  assert(out2.includes('- recall:') && out2.indexOf('- recall:') > out2.indexOf('Trigger:'), 'appended after body when no steps');
}

export async function run(): Promise<SuiteResult> {
  return runSuite('skill-recipe-binding', recipeBindingSuite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('skill-recipe-binding', recipeBindingSuite);
