// Privacy hard-lock (paper Invariant 2): a skill step that recalls from a
// SENSITIVE-tier engram MUST be routed to a LOCAL model — even when cloud
// providers are enabled and the strategy would otherwise prefer them.
//
// This is the regression guard for the shipped-walker bug where the walker
// derived plan steps WITHOUT the per-step engram-tier map, so the privacy lock
// in the router never engaged. The chain under test:
//
//   recall recipe (only_engrams: ["secrets"])
//     → deriveEngramTierByStep (resolve engram → sensitivityTier)
//     → deriveStepsFromText (sensitive tier ⇒ privacyLocked)
//     → planSkillWalk (privacyLocked ⇒ local-only candidate filter)
//     → picked model's provider.local === true
//
// Pure functions + a tiny host stub — no real cortex, no LLM.

import { deriveEngramTierByStep } from '../apps/desktop-sidecar/src/agent-walker.js';
import { planSkillWalk, deriveStepsFromText } from '../apps/desktop-sidecar/src/model-router.js';
import { getKnownModel, getKnownProvider } from '../apps/desktop-sidecar/src/model-registry.js';
import type { GraphnosisHost } from '../apps/desktop-sidecar/src/host.js';
import { extractRecipeEngramNames } from '../apps/desktop-sidecar/src/skill-recall-bindings.js';
import { assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

/** Minimal host stub: deriveEngramTierByStep only needs listGraphs +
 *  getGraphMetadata (the engram-name → tier resolution path). Cast to the full
 *  host type; the planner under test never touches the rest. */
function stubHost(tiers: Record<string, 'public' | 'personal' | 'sensitive'>): GraphnosisHost {
  const graphs = Object.keys(tiers);
  return {
    listGraphs: () => graphs,
    getGraphMetadata: (gid: string) =>
      tiers[gid] !== undefined
        ? { displayName: gid, sensitivityTier: tiers[gid] }
        : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as GraphnosisHost;
}

/** All cloud + local providers enabled, adaptive strategy — the setup where a
 *  cloud model WOULD win for a non-locked step, so a local pick proves the lock. */
const ALL_PROVIDERS = ['ollama', 'mlx', 'vllm', 'anthropic', 'openai', 'google', 'copilot'] as const;

async function privacyLockSuite(): Promise<void> {
  section('extractRecipeEngramNames — recipe forms');
  assert(
    extractRecipeEngramNames('- recall: foo only_engrams: ["secrets", "work"]').join() === 'secrets,work',
    'colon form, quoted list parsed',
  );
  assert(
    extractRecipeEngramNames('recall foo only_engrams=[secrets]').join() === 'secrets',
    'equals form, bare name parsed',
  );
  assert(
    extractRecipeEngramNames('recall foo target_engram: "secrets"').join() === 'secrets',
    'target_engram single form parsed',
  );
  assert(extractRecipeEngramNames('plain step, no recall').length === 0, 'non-recipe step → no names');

  section('deriveEngramTierByStep — strictest tier wins');
  const host = stubHost({ work: 'personal', docs: 'public', secrets: 'sensitive' });
  const tierMap = deriveEngramTierByStep(host, [
    { index: 1, text: 'Personal context\n- recall: q only_engrams: ["work"]' },
    { index: 2, text: 'Read secrets\n- recall: q only_engrams: ["docs", "secrets"]' },
    { index: 3, text: 'No recall here — just compose a summary.' },
    // recipe lives in anchored supporting context, not the step text itself
    { index: 4, text: 'Compose the reply.', supportingContext: ['- recall: q only_engrams: ["secrets"]'] },
  ]);
  assert(tierMap[1] === 'personal', 'step 1 (work) → personal');
  assert(tierMap[2] === 'sensitive', 'step 2 (docs + secrets) → sensitive (strictest wins)');
  assert(tierMap[3] === undefined, 'step 3 (no recall) → no entry, normal routing');
  assert(tierMap[4] === 'sensitive', 'step 4 sensitive recipe in supportingContext → sensitive');

  section('deriveEngramTierByStep — unresolvable engram locks conservatively');
  const lockUnknown = deriveEngramTierByStep(stubHost({ work: 'personal' }), [
    { index: 1, text: '- recall: q only_engrams: ["does-not-exist"]' },
  ]);
  assert(lockUnknown[1] === 'sensitive', 'unknown named engram → sensitive (lock when unsure)');

  section('END-TO-END — sensitive step routes LOCAL with cloud enabled');
  const steps = [
    { index: 1, text: 'Draft a public announcement. @needs: writing' },
    { index: 2, text: 'Personal context\n- recall: prior notes only_engrams: ["secrets"]' },
  ];
  const e2eTiers = deriveEngramTierByStep(host, steps);
  const planSteps = deriveStepsFromText(steps, e2eTiers);
  assert(planSteps[1]?.privacyLocked === true, 'sensitive step is privacyLocked after derive');
  assert(planSteps[0]?.privacyLocked !== true, 'non-sensitive step is NOT privacyLocked');

  const plan = planSkillWalk(planSteps, {
    strategy: 'adaptive',
    enabledProviders: [...ALL_PROVIDERS],
  });
  assert(plan.feasible, 'plan is feasible with all providers enabled');

  const sensitiveStep = plan.steps.find((s) => s.index === 2);
  assert(sensitiveStep !== undefined, 'sensitive step is present in the plan');
  assert(sensitiveStep?.privacyLocked === true, 'sensitive step stays privacyLocked in the plan');
  const picked = sensitiveStep?.pickedModelId ? getKnownModel(sensitiveStep.pickedModelId) : undefined;
  assert(picked !== undefined, 'sensitive step picked a model');
  const provider = picked ? getKnownProvider(picked.provider) : undefined;
  assert(
    provider?.local === true,
    'PRIVACY HARD-LOCK: sensitive-engram step routed to a LOCAL provider despite cloud being enabled',
    { pickedModelId: sensitiveStep?.pickedModelId, provider: picked?.provider },
  );

  section('CONTROL — without the tier map the lock does NOT engage (proves the wiring matters)');
  const unwiredPlan = planSkillWalk(deriveStepsFromText(steps), {
    strategy: 'adaptive',
    enabledProviders: [...ALL_PROVIDERS],
  });
  const unwiredSensitive = unwiredPlan.steps.find((s) => s.index === 2);
  assert(
    unwiredSensitive?.privacyLocked !== true,
    'without engramTierByStep the step is NOT locked (the original bug) — confirms the fix is load-bearing',
  );
}

export async function run(): Promise<SuiteResult> {
  return runSuite('skill-privacy-lock', privacyLockSuite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('skill-privacy-lock', privacyLockSuite);
