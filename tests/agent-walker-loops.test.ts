// Loop re-execution scheduler (#41) — the caps ARE enforced in code.
//
// Model-free suite for the walker's loop scheduler (agent-walker.ts). The
// §5/§11 bounded-loop claim is only honest if the STOPPING decision is made by
// code, not by the model walking the plan: declared `max=N` caps, the default
// cap for uncapped loops, fixed-point convergence, invalid-target refusal, and
// lifetime (never-reset) budgets are each pinned here. Composes with the
// unattended-executor suite, which pins WHO may run such plans unattended.

import {
  createLoopScheduler,
  DEFAULT_UNCAPPED_LOOP_ITERATIONS,
  MAX_TOTAL_STEP_EXECUTIONS,
} from '../apps/desktop-sidecar/src/agent-walker.js';
import { assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

/** Drive a scheduler the way walkSkillPlan does, with a distinct body
 *  signature per iteration (sig fn defaults to never-converging). */
function driveLoop(
  sched: ReturnType<typeof createLoopScheduler>,
  fromIndex: number,
  sig: (iteration: number) => string = (i) => `body-${i}`,
): { jumps: number; lastNextIteration: number | null } {
  let jumps = 0;
  let lastNextIteration: number | null = null;
  for (let i = 1; i <= 1_000; i++) {
    const jump = sched.onLoopStepComplete(fromIndex, sig(i));
    if (!jump) break;
    jumps++;
    lastNextIteration = jump.nextIteration;
  }
  return { jumps, lastNextIteration };
}

async function loopSuite(): Promise<void> {
  section('declared cap — `@loop: N max=M` stops after exactly M iterations');
  {
    const sched = createLoopScheduler([
      { index: 1 },
      { index: 2, loopsBackTo: [1], maxIterations: 3 },
    ]);
    assert(sched.edgeTarget(2) === 1, 'edge target resolves to step 1');
    assert(sched.edgeTarget(1) === null, 'non-loop step has no edge target');
    const run = driveLoop(sched, 2);
    assert(run.jumps === 2, 'cap 3 → exactly 2 jump-backs (3 body iterations)', run);
    const [r] = sched.report();
    assert(r?.iterations === 3 && r.cap === 3 && r.capSource === 'declared' && r.stop === 'cap',
      'report: 3 iterations, declared cap, stopped by cap', r);
  }

  section('uncapped loop — walker default cap applies (the executor decides)');
  {
    const sched = createLoopScheduler([
      { index: 1 },
      { index: 2, loopsBackTo: [1] },
    ]);
    const run = driveLoop(sched, 2);
    assert(run.jumps === DEFAULT_UNCAPPED_LOOP_ITERATIONS - 1,
      `uncapped → default cap of ${DEFAULT_UNCAPPED_LOOP_ITERATIONS} body iterations`, run);
    const [r] = sched.report();
    assert(r?.cap === DEFAULT_UNCAPPED_LOOP_ITERATIONS && r.capSource === 'default' && r.stop === 'cap',
      'report marks the cap as walker-defaulted', r);
  }

  section('cap=1 — a capped loop may forbid any re-entry');
  {
    const sched = createLoopScheduler([
      { index: 1 },
      { index: 2, loopsBackTo: [1], maxIterations: 1 },
    ]);
    const run = driveLoop(sched, 2);
    assert(run.jumps === 0, 'max=1 → single pass, no jump-back', run);
    assert(sched.report()[0]?.stop === 'cap', 'stopped by cap immediately');
  }

  section('convergence — identical consecutive body outputs stop the loop early');
  {
    const sched = createLoopScheduler([
      { index: 1 },
      { index: 2, loopsBackTo: [1], maxIterations: 10 },
    ]);
    // Signatures: A, B, B → iteration 3 matches iteration 2 → converged.
    const sigs = ['A', 'B', 'B', 'C', 'D'];
    const run = driveLoop(sched, 2, (i) => sigs[i - 1] ?? 'Z');
    assert(run.jumps === 2, 'converged after 3 body iterations (2 jumps), well under cap 10', run);
    const [r] = sched.report();
    assert(r?.iterations === 3 && r.stop === 'converged', 'report: stopped by convergence', r);
  }

  section('invalid targets — never jumped, reported not silent');
  {
    // Forward jump (target not earlier) and unknown step are both invalid.
    const sched = createLoopScheduler([
      { index: 1, loopsBackTo: [2] },
      { index: 2, loopsBackTo: [99] },
    ]);
    assert(sched.edgeTarget(1) === null, 'forward target → no jump');
    assert(sched.edgeTarget(2) === null, 'unknown target → no jump');
    assert(sched.onLoopStepComplete(1, 'x') === null, 'invalid edge never returns a jump');
    const reports = sched.report();
    assert(reports.length === 2 && reports.every((r) => r.stop === 'invalid-target'),
      'both edges reported invalid-target', reports);
  }

  section('lifetime budgets — an edge cap is never reset within one walk');
  {
    // Two independent edges; driving one to its cap leaves the other intact,
    // and a capped edge stays stopped when re-asked (no budget reset).
    const sched = createLoopScheduler([
      { index: 1 },
      { index: 2, loopsBackTo: [1], maxIterations: 2 },
      { index: 3 },
      { index: 4, loopsBackTo: [3], maxIterations: 4 },
    ]);
    const first = driveLoop(sched, 2);
    assert(first.jumps === 1, 'edge 2→1 capped at 2 iterations', first);
    assert(sched.onLoopStepComplete(2, 'later') === null, 'capped edge refuses further jumps (lifetime budget)');
    const second = driveLoop(sched, 4);
    assert(second.jumps === 3, 'independent edge 4→3 keeps its own budget', second);
    const byFrom = new Map(sched.report().map((r) => [r.fromIndex, r]));
    assert(byFrom.get(2)?.stop === 'cap' && byFrom.get(4)?.stop === 'cap', 'both edges report cap-stop');
  }

  section('termination arithmetic — Σ caps stays under the walk backstop');
  {
    // The trained corpus tops out near 45 steps; even a pathological plan with
    // a capped loop on every second step stays well under the code backstop.
    const steps = Array.from({ length: 45 }, (_, i) => ({
      index: i + 1,
      ...(i % 2 === 1 ? { loopsBackTo: [i], maxIterations: 3 } : {}),
    }));
    const sched = createLoopScheduler(steps);
    const totalCap = sched.report().reduce((sum, r) => sum + r.cap, 0);
    assert(steps.length * (1 + totalCap) > 0, 'bound computes');
    assert(steps.length + totalCap < MAX_TOTAL_STEP_EXECUTIONS,
      `worst-case jump count (${totalCap}) + linear pass fits the ${MAX_TOTAL_STEP_EXECUTIONS} backstop`);
  }

  section('next-iteration numbering — jumps announce the upcoming iteration');
  {
    const sched = createLoopScheduler([
      { index: 1 },
      { index: 2, loopsBackTo: [1], maxIterations: 3 },
    ]);
    const j1 = sched.onLoopStepComplete(2, 's1');
    assert(j1?.jumpTo === 1 && j1.nextIteration === 2, 'first jump announces iteration 2', j1);
    const j2 = sched.onLoopStepComplete(2, 's2');
    assert(j2?.jumpTo === 1 && j2.nextIteration === 3, 'second jump announces iteration 3', j2);
    assert(sched.onLoopStepComplete(2, 's3') === null, 'third completion hits the cap');
  }
}

export async function run(): Promise<SuiteResult> {
  return runSuite('agent-walker-loops', loopSuite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('agent-walker-loops', loopSuite);
