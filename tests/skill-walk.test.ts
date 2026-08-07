// Golden regression tests for walk_skill_structured output shape.
// Uses pure walkSkillToJson — no host, no LLM, deterministic.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  walkSkillToJson,
  parseTypedVarList,
  type WalkedSkill,
} from '../apps/desktop-sidecar/src/skill-trainer.js';
import { assert, runSuite, standalone, section, type SuiteResult } from './_helpers.js';

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url));

function buildWalkedSkillFixture(): WalkedSkill {
  return {
    goals: [
      { text: 'Requires: $taskContext:string', kind: 'requires' },
      { text: 'Produces: $matchedSkills', kind: 'produces' },
      { text: 'Success: Every matched skill is returned in priority order.', kind: 'success' },
      { text: 'Trigger: Session start or explicit skill routing request.', kind: 'trigger' },
      {
        text: 'On failure: No skills matched — fall back to session-start. @skill: session-start',
        kind: 'failure',
      },
    ],
    steps: [
      { nodeId: 'n1', text: 'Recall standing instructions from graphnosis-skills engram.', index: 0, isBranchPoint: false, isLoopBack: false },
      {
        nodeId: 'n2',
        text: 'Walk skill-dispatch with the current task context.',
        index: 1,
        isBranchPoint: false,
        isLoopBack: false,
        callsSkill: {
          targetSourceId: 'skill:dispatch',
          targetTitle: 'skill-dispatch',
          args: ['$taskContext'],
          captureAs: 'dispatchPlan',
        },
      },
      {
        nodeId: 'n3',
        text: 'If vitality < 60, queue skill-maintenance before execution.',
        index: 2,
        isBranchPoint: true,
        isLoopBack: false,
      },
      { nodeId: 'n4', text: 'Return matched skill list to caller.', index: 3, isBranchPoint: false, isLoopBack: false },
    ],
    contextNodes: [
      { text: 'Prefer deterministic recall before acting.', anchorStepIndex: 1 },
      { text: 'User prefers concise SOP summaries.', anchorStepIndex: null },
    ],
    loops: [],
    branches: [[2, 3]],
    failureHandlers: [{
      description: 'No skills matched — fall back to session-start.',
      targetSourceId: 'skill:session-start',
      targetTitle: 'session-start',
      args: [],
    }],
  };
}

export async function run(): Promise<SuiteResult> {
  return runSuite('skill-walk', skillWalkSuite);
}

async function skillWalkSuite(): Promise<void> {
  section('parseTypedVarList — D3 type hints');
  const typed = parseTypedVarList('Requires: $taskContext:string, $policy:{phased|atomic}');
  assert(typed.length === 2, 'parses two typed vars');
  assert(typed[0]?.name === 'taskContext' && typed[0]?.type === 'string', 'first var + type');
  assert(typed[1]?.name === 'policy' && typed[1]?.type === '{phased|atomic}', 'enum type preserved');

  section('walkSkillToJson — golden plan shape');
  const walked = buildWalkedSkillFixture();
  const plan = walkSkillToJson(walked, { sourceId: 'skill:test-dispatch', title: 'Skill Dispatch' });
  const goldenPath = path.join(FIXTURE_DIR, 'fixtures', 'skill-walk-golden.json');
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as typeof plan;

  assert(JSON.stringify(plan) === JSON.stringify(golden),
    'walkSkillToJson output matches golden fixture byte-for-byte',
    { got: plan, expected: golden });

  section('walkSkillToJson — step indices are 1-based');
  assert(plan.steps.every((s, i) => s.index === i + 1), 'steps use 1-based indices');
  assert(plan.steps[1]?.calls?.captureAs === 'dispatchPlan', 'sub-skill captureAs preserved');
  assert(plan.steps[2]?.branchesTo?.[0] === 4, 'branch targets are 1-based');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('skill-walk', skillWalkSuite);
