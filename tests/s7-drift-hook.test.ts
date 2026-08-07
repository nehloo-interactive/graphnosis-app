// DEV-only cited-drift injection hook (paper #3, Appendix-S7 pilot).
//
// The S7 pilot needs an automated way to drive computeSkillVitality's REAL
// citedDriftPenalty term (real cited-drift only moves with wall-clock age or
// owner-approved edits, so it can't be produced in a single session).
// debugInjectCitedDrift seeds skillCitedNodes for a SANDBOX skill: the skill's
// own body nodes (present) + `missingCount` synthetic nodes in a non-existent
// engram (missing) → citedDriftPenalty = round(missing / (body + missing) * 40).
//
// This suite proves (a) the drift math is exact + monotonic through the real
// computeSkillVitality path, and (b) BOTH guards hold (dev-env + sandbox-slug).

import { SkillTrainer } from '../apps/desktop-sidecar/src/skill-trainer.js';
import type { GraphnosisHost } from '../apps/desktop-sidecar/src/host.js';
import { assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

const SANDBOX = 's7-pilot';
const SKILL = 'skill:s7-drift-test';
const BODY = 10;

// Minimal host: only the surface computeSkillVitality + debugInjectCitedDrift use.
class FakeHost {
  settings: { skillCitedNodes?: Record<string, { graphId: string; nodes: Record<string, string> }> } = {};
  private readonly ids = Array.from({ length: BODY }, (_, i) => `body-${i}`);

  listSources(graphId: string) {
    if (graphId !== SANDBOX) return [] as unknown as ReturnType<GraphnosisHost['listSources']>;
    return [{ sourceId: SKILL, nodeIds: this.ids, ingestedAt: Date.now() }] as unknown as ReturnType<GraphnosisHost['listSources']>;
  }
  listNodes(graphId: string) {
    if (graphId !== SANDBOX) return [] as unknown as ReturnType<GraphnosisHost['listNodes']>;
    return this.ids.map((id) => ({ id, confidence: 1, validUntil: undefined as number | undefined })) as unknown as ReturnType<GraphnosisHost['listNodes']>;
  }
  listGraphs() { return [SANDBOX] as unknown as ReturnType<GraphnosisHost['listGraphs']>; }
  getSettings() { return this.settings as unknown as ReturnType<GraphnosisHost['getSettings']>; }
  async setSettings(patch: Record<string, unknown>): Promise<void> { this.settings = { ...this.settings, ...(patch as object) }; }
}

function newTrainer() {
  const host = new FakeHost();
  return new SkillTrainer(host as unknown as GraphnosisHost, null);
}

async function expectThrow(fn: () => Promise<unknown>, re: RegExp): Promise<string> {
  try { await fn(); return '__no_throw__'; } catch (e) { return (e as Error).message; }
}

async function suite(): Promise<void> {
  const prior = process.env.GRAPHNOSIS_DEV;

  section('guard 1 — refuses without GRAPHNOSIS_DEV');
  delete process.env.GRAPHNOSIS_DEV;
  const m1 = await expectThrow(() => newTrainer().debugInjectCitedDrift(SANDBOX, SKILL, 3), /dev-only/);
  assert(/dev-only/.test(m1), 'throws dev-only when GRAPHNOSIS_DEV unset', m1);

  section('guard 2 — refuses a non-sandbox (personal) engram even in dev');
  process.env.GRAPHNOSIS_DEV = '1';
  const m2 = await expectThrow(() => newTrainer().debugInjectCitedDrift('code-skills', SKILL, 3), /refuses non-sandbox/);
  assert(/refuses non-sandbox/.test(m2), 'throws for a personal engram slug', m2);

  section('faithful drift math — real citedDriftPenalty = round(missing/(body+missing)*40)');
  // body = 10; expected penalty per missing count:
  //   0 -> 0 (score 100) · 3 -> round(3/13*40)=9 (91) · 6 -> round(6/16*40)=15 (85) · 10 -> 20 (80)
  const cases: Array<[number, number, number]> = [
    [0, 0, 100],
    [3, 9, 91],
    [6, 15, 85],
    [10, 20, 80],
  ];
  let prevScore = 101;
  for (const [missing, penalty, score] of cases) {
    const t = newTrainer();
    const r = await t.debugInjectCitedDrift(SANDBOX, SKILL, missing) as {
      score: number; citedDriftPenalty: number; agePenalty: number; stalenessPenalty: number;
    };
    assert(r.agePenalty === 0 && r.stalenessPenalty === 0, `missing=${missing}: age/staleness isolated to 0`, r);
    assert(r.citedDriftPenalty === penalty, `missing=${missing}: citedDriftPenalty === ${penalty}`, r.citedDriftPenalty);
    assert(r.score === score, `missing=${missing}: score === ${score}`, r.score);
    assert(r.score <= prevScore, `monotonic: score does not rise as drift grows (${r.score} <= ${prevScore})`, r.score);
    prevScore = r.score;
  }

  section('a staleness event is detectable — a run crosses the aging band');
  // With body=10, missing=10 → score 80 (still "fresh"); missing=25 → round(25/35*40)=29 → score 71 (aging band < 80).
  const t = newTrainer();
  const r = await t.debugInjectCitedDrift(SANDBOX, SKILL, 25) as { score: number };
  assert(r.score < 80, 'enough injected drift pushes the skill below the fresh band (a staleness event)', r.score);

  if (prior === undefined) delete process.env.GRAPHNOSIS_DEV; else process.env.GRAPHNOSIS_DEV = prior;
}

export async function run(): Promise<SuiteResult> {
  return runSuite('s7-drift-hook', suite);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) void standalone('s7-drift-hook', suite);
