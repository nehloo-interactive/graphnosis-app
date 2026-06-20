/**
 * Golden walk regression — compare walkSkillToJson output against committed fixtures.
 * Volatile fields (sourceId, targetSourceId) are stripped before comparison.
 */
import type { SkillExecutionPlan } from './skill-trainer.js';

export interface GoldenWalkFixture {
  skill: { title: string };
  requires?: string[];
  produces?: string[];
  constraints?: SkillExecutionPlan['constraints'];
  steps: Array<{
    index: number;
    text: string;
    calls?: { targetTitle: string; args?: string[]; captureAs?: string };
    parallel?: Array<{ targetTitle: string; args?: string[]; captureAs?: string }>;
    branchesTo?: number[];
    loopsBackTo?: number[];
    maxIterations?: number;
    unresolvedCall?: string;
  }>;
  failureHandlers?: Array<{
    description: string;
    targetTitle?: string;
    unresolvedCall?: string;
  }>;
}

/** Normalize a live plan for golden comparison — drop volatile IDs and title noise. */
export function normalizeWalkPlanForGolden(plan: SkillExecutionPlan): GoldenWalkFixture {
  const titleHead = plan.skill.title.replace(/^#+\s*/, '').trim();
  const procedural = plan.steps.filter((s) => {
    const t = s.text.trim();
    if (/^\d+\./.test(t)) return true;
    if (s.calls || s.parallel?.length || s.loopsBackTo?.length || s.unresolvedCall) return true;
    if (/\(trained \d{4}-\d{2}-\d{2}\)/.test(t)) return false;
    if (t === titleHead || t === `# ${titleHead}`) return false;
    return false;
  });
  const steps = (procedural.length > 0 ? procedural : plan.steps).map((s) => ({
      index: s.index,
      text: s.text,
      ...(s.calls ? {
        calls: {
          targetTitle: s.calls.targetTitle,
          ...(s.calls.args.length ? { args: s.calls.args } : {}),
          ...(s.calls.captureAs ? { captureAs: s.calls.captureAs } : {}),
        },
      } : {}),
      ...(s.parallel?.length ? {
        parallel: s.parallel.map((p) => ({
          targetTitle: p.targetTitle,
          ...(p.args.length ? { args: p.args } : {}),
          ...(p.captureAs ? { captureAs: p.captureAs } : {}),
        })),
      } : {}),
      ...(s.branchesTo?.length ? { branchesTo: s.branchesTo } : {}),
      ...(s.loopsBackTo?.length ? { loopsBackTo: s.loopsBackTo } : {}),
      ...(s.maxIterations !== undefined ? { maxIterations: s.maxIterations } : {}),
      ...(s.unresolvedCall ? { unresolvedCall: s.unresolvedCall } : {}),
    }));

  const out: GoldenWalkFixture = {
    skill: { title: titleHead },
    steps,
  };
  if (plan.requires.length) out.requires = plan.requires;
  if (plan.produces.length) out.produces = plan.produces;
  if (Object.keys(plan.constraints).length) out.constraints = plan.constraints;
  if (plan.failureHandlers.length) {
    out.failureHandlers = plan.failureHandlers.map((h) => ({
      description: h.description,
      ...(h.targetTitle ? { targetTitle: h.targetTitle } : {}),
      ...(h.unresolvedCall ? { unresolvedCall: h.unresolvedCall } : {}),
    }));
  }
  return out;
}

export interface GoldenWalkDiff {
  ok: boolean;
  path: string;
  expected: unknown;
  actual: unknown;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Compare normalized plan against a golden fixture; returns first drift or ok. */
export function compareGoldenWalk(
  plan: SkillExecutionPlan,
  golden: GoldenWalkFixture,
  label: string,
): GoldenWalkDiff {
  const actual = normalizeWalkPlanForGolden(plan);
  if (deepEqual(actual, golden)) return { ok: true, path: label, expected: golden, actual };

  // Walk field-by-field for a useful error message.
  if (actual.skill.title !== golden.skill.title) {
    return { ok: false, path: `${label}.skill.title`, expected: golden.skill.title, actual: actual.skill.title };
  }
  if ((actual.requires ?? []).join(',') !== (golden.requires ?? []).join(',')) {
    return { ok: false, path: `${label}.requires`, expected: golden.requires, actual: actual.requires };
  }
  if (actual.steps.length !== golden.steps.length) {
    return {
      ok: false,
      path: `${label}.steps.length`,
      expected: golden.steps.length,
      actual: actual.steps.length,
    };
  }
  for (let i = 0; i < golden.steps.length; i++) {
    const g = golden.steps[i]!;
    const a = actual.steps[i]!;
    if (a.index !== g.index) {
      return { ok: false, path: `${label}.steps[${i}].index`, expected: g.index, actual: a.index };
    }
    if (a.text !== g.text) {
      return { ok: false, path: `${label}.steps[${i}].text`, expected: g.text, actual: a.text };
    }
    const gCall = g.calls?.targetTitle;
    const aCall = a.calls?.targetTitle;
    if (gCall !== aCall) {
      return { ok: false, path: `${label}.steps[${i}].calls.targetTitle`, expected: gCall, actual: aCall };
    }
    if ((g.loopsBackTo ?? []).join(',') !== (a.loopsBackTo ?? []).join(',')) {
      return { ok: false, path: `${label}.steps[${i}].loopsBackTo`, expected: g.loopsBackTo, actual: a.loopsBackTo };
    }
  }
  if ((actual.failureHandlers ?? []).length !== (golden.failureHandlers ?? []).length) {
    return {
      ok: false,
      path: `${label}.failureHandlers.length`,
      expected: (golden.failureHandlers ?? []).length,
      actual: (actual.failureHandlers ?? []).length,
    };
  }
  return { ok: false, path: label, expected: golden, actual };
}
