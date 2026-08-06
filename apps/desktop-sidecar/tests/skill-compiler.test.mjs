/**
 * skill-compiler — the deterministic Agempus layer under train_skill.
 *
 * These pin the behavior that was missing entirely before: arbitrary prose in,
 * Agempus shape out, with an honest score and a bounded caller loop. Several
 * cases are direct regressions of the Claude Cowork report — a well-written
 * markdown procedure that compiled to a 0/8 skill with no warning.
 *
 * Run: pnpm --filter @graphnosis-app/desktop-sidecar test:skill-compiler
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assessAgempus,
  scaffoldAgempus,
  traceCoverage,
  stripPlaceholders,
  parseSkillText,
  buildCompileGuidance,
  CompileLoopTracker,
  CONTRACT_FIELDS,
  CONFORMANCE_THRESHOLD,
  MAX_COMPILE_ROUNDS,
} from '../dist/skill-compiler.js';

// The shape of what a real user pastes: a good procedure, zero Agempus markup.
// This is the Cowork case — it used to save silently at 0/8.
const PROSE_SKILL = `Report Format

When formatting a report, keep the layout consistent across every page.

- Set the page to A4 portrait with 15mm margins
- Put the title at the top in 18pt bold, the date beneath it
- Render figure captions below each figure, never inline
- Keep each section as a single block; never break a section across a page
- Export to PDF at 300dpi and check the first and last page by eye
`;

const CONFORMING_SKILL = `Ship Release

[dispatch-safe: partial]

Trigger: the user says "ship", "release", "tag vX.Y.Z" or "publish".
Prerequisites: Working tree builds and smoke passes.
Requires: $version
Produces: $tagName, $releaseUrl
Success: The published artifact installs and reports $version [verify: tool]
Out of scope: Deciding WHETHER to release — that is the user's call.
On failure: @skill: release-rollback(version=$version)
On completion: A signed tag exists on the remote and the changelog is updated.

1. Show git status and diff --stat @needs: shell
2. Group the changes by concern and write the changelog @needs: reasoning
3. Bump every version file, then verify they agree @needs: shell
4. @skill: verify-bundle(version=$version) -> $bundleCheck
`;

// ── assessAgempus ─────────────────────────────────────────────────────────────

test('prose with no contract scores 0/8 and does not conform', () => {
  const c = assessAgempus(PROSE_SKILL);
  assert.equal(c.score, 0);
  assert.equal(c.conforms, false);
  assert.deepEqual([...c.missing].sort(), [...CONTRACT_FIELDS].sort());
});

test('a fully authored Agempus skill scores 8/8 and conforms', () => {
  const c = assessAgempus(CONFORMING_SKILL);
  assert.equal(c.score, 8);
  assert.equal(c.conforms, true);
  assert.equal(c.stepCount, 4);
  assert.equal(c.stepsWithNeeds, 3);
  assert.equal(c.stepsWithStructure, 1);
  assert.equal(c.dispatchSafe, 'partial');
  assert.equal(c.title, 'Ship Release');
});

test('TODO placeholders are NOT counted as filled fields', () => {
  // The bug this guards: skill_lint scored by line prefix, so a body made
  // entirely of `Trigger: TODO` lines reported a perfect 8/8.
  const allTodo = CONTRACT_FIELDS.map((f) => `${f}: TODO — fill me in`).join('\n');
  const c = assessAgempus(`Some Skill\n\n${allTodo}\n\n1. do the thing\n`);
  assert.equal(c.score, 0);
  assert.equal(c.conforms, false);
});

test('conformance needs Trigger and Success specifically, not just a count', () => {
  // Seven filled fields clears the numeric threshold comfortably — but with no
  // Trigger the skill can never be dispatched, so a score-only check would wave
  // through something structurally inert.
  const withoutTrigger = [
    'Some Skill', '',
    'Prerequisites: a', 'Requires: $x', 'Produces: $y',
    'Success: it worked [verify: state]', 'Out of scope: b', 'On failure: c', 'On completion: d',
    '', '1. do the thing',
  ].join('\n');
  const a = assessAgempus(withoutTrigger);
  assert.equal(a.score, 7);
  assert.ok(a.score >= CONFORMANCE_THRESHOLD, 'clears the numeric bar');
  assert.equal(a.conforms, false, 'but must still fail: no Trigger');
  assert.ok(a.issues.some((i) => i.includes('Trigger')));

  // Same story for Success, the other load-bearing field.
  const withoutSuccess = withoutTrigger
    .replace('Success: it worked [verify: state]', 'Trigger: when a thing happens');
  const b = assessAgempus(withoutSuccess);
  assert.equal(b.score, 7);
  assert.equal(b.conforms, false);
  assert.ok(b.issues.some((i) => i.includes('Success')));

  // With both present it conforms.
  const complete = withoutTrigger.replace(
    'Prerequisites: a',
    'Trigger: when a thing happens\nPrerequisites: a',
  );
  assert.equal(assessAgempus(complete).conforms, true);
});

test('a skill with a full contract but no numbered steps does not conform', () => {
  const noSteps = CONFORMING_SKILL.split('\n').filter((l) => !/^\d+\./.test(l)).join('\n');
  const c = assessAgempus(noSteps);
  assert.equal(c.score, 8);
  assert.equal(c.stepCount, 0);
  assert.equal(c.conforms, false);
  assert.ok(c.issues.some((i) => i.includes('no numbered sequence')));
});

test('the rendered walk_skill goal form round-trips back in', () => {
  // walk_skill emits `- ✓ **Success:** …`; users paste that back when iterating.
  // Accepting it is what keeps a round-trip lossless instead of duplicating.
  const rendered = [
    'Some Skill', '', '## Goals', '',
    '- ⚡ **Trigger:** when the build breaks',
    '- ✓ **Success:** the build is green [verify: tool]',
    '', '1. read the log',
  ].join('\n');
  const c = assessAgempus(rendered);
  assert.equal(c.score, 2);
  assert.equal(c.contract.find((e) => e.field === 'Trigger').value, 'when the build breaks');
  assert.equal(c.stepCount, 1);
});

// ── scaffoldAgempus ───────────────────────────────────────────────────────────

test('scaffolding promotes bullets into a numbered sequence', () => {
  const { text, notes } = scaffoldAgempus(PROSE_SKILL, { skillName: 'report-format' });
  const c = assessAgempus(text);
  assert.equal(c.stepCount, 5, 'all five bullets became steps');
  assert.ok(notes.some((n) => /Promoted 5 top-level bullets/.test(n)));
  assert.match(text, /^1\. Set the page to A4 portrait/m);
  assert.match(text, /^5\. Export to PDF at 300dpi/m);
});

test('scaffolding never invents contract values — only hinted placeholders', () => {
  const { text } = scaffoldAgempus(PROSE_SKILL, { skillName: 'report-format' });
  // Every field is present as a line...
  for (const f of CONTRACT_FIELDS) {
    assert.ok(text.includes(`${f}:`), `expected a ${f}: line`);
  }
  // ...but none of them counts as filled. This is the whole safety argument:
  // a guessed Trigger fires the skill on the wrong context.
  assert.equal(assessAgempus(text).score, 0);
});

test('scaffolding REPORTS a missing dispatch-safe cap, it does not inject one', () => {
  // Regression: an earlier draft wrote `[dispatch-safe: no]` when the source had
  // no tag. parseDispatchSafe() treats an absent tag as `yes`, so that would
  // have silently demoted every untagged skill in an existing library on its
  // next retrain — and the added line becomes its own body node, shifting every
  // downstream step index (the golden walks caught it).
  const { text, notes } = scaffoldAgempus(PROSE_SKILL, { skillName: 'x' });
  assert.doesNotMatch(text, /\[dispatch-safe:/, 'must not invent a cap');
  assert.ok(notes.some((n) => /eligible for unattended dispatch at L3/.test(n)));
  assert.ok(
    assessAgempus(text).issues.some((i) => i.includes('dispatch-safe')),
    'and the gap is reported to the caller',
  );
});

test('scaffolding does not change the node count of a tagless skill', () => {
  // Node count drives walk step indices; a formatting pass must not shift them.
  const src = 'Some Skill\n\nTrigger: a thing happens\n\n1. do it\n\n2. check it\n';
  const before = src.split('\n').filter((l) => l.trim()).length;
  const after = scaffoldAgempus(src, { skillName: 'Some Skill', includePlaceholders: false })
    .text.split('\n').filter((l) => l.trim()).length;
  assert.equal(after, before);
});

test('scaffolding respects an authored dispatch-safe cap', () => {
  const { text } = scaffoldAgempus(CONFORMING_SKILL, { skillName: 'ship-release' });
  assert.match(text, /\[dispatch-safe: partial\]/);
  assert.doesNotMatch(text, /\[dispatch-safe: no\]/);
});

test('scaffolding preserves every authored contract value verbatim', () => {
  const { text } = scaffoldAgempus(CONFORMING_SKILL, { skillName: 'ship-release' });
  const c = assessAgempus(text);
  assert.equal(c.score, 8);
  assert.equal(
    c.contract.find((e) => e.field === 'Out of scope').value,
    'Deciding WHETHER to release — that is the user\'s call.',
  );
});

test('scaffolding is idempotent — compiling twice changes nothing', () => {
  const once = scaffoldAgempus(PROSE_SKILL, { skillName: 'report-format' }).text;
  const twice = scaffoldAgempus(once, { skillName: 'report-format' }).text;
  assert.equal(twice, once);
});

test('scaffolding an already-conforming skill leaves it conforming', () => {
  const { text } = scaffoldAgempus(CONFORMING_SKILL, { skillName: 'ship-release' });
  const c = assessAgempus(text);
  assert.equal(c.conforms, true);
  assert.equal(c.stepCount, 4);
  assert.equal(c.stepsWithNeeds, 3);
  // Structure tokens the walk depends on must survive byte-for-byte.
  assert.ok(text.includes('@skill: verify-bundle(version=$version) -> $bundleCheck'));
  assert.ok(text.includes('@skill: release-rollback(version=$version)'));
});

test('scaffolding preserves prose that is not a step', () => {
  const { text } = scaffoldAgempus(PROSE_SKILL, { skillName: 'report-format' });
  assert.ok(
    text.includes('keep the layout consistent across every page'),
    'preamble prose must survive the compile',
  );
});

test('prose that closes a skill stays after the steps', () => {
  // Regression: an earlier draft emitted all prose first and all steps last,
  // which hoisted trailing blocks (an "ENGRAM MAP", a "PRAXIS LOOP") above the
  // sequence. Retraining the existing skill library would have silently
  // scrambled every one of them.
  const src = [
    'skill-dispatch', '', '[dispatch-safe: yes]', '',
    'LAZY LOADING DESIGN: keeps other content out of context.', '',
    '1. Call list_skills.', '',
    '2. Classify $currentContext.', '',
    'PRAXIS IMPROVEMENT LOOP: append friction to sandbox/.', '',
    'ENGRAM MAP — where to write.',
  ].join('\n');
  const { text } = scaffoldAgempus(src, { skillName: 'skill-dispatch' });
  const at = (needle) => text.indexOf(needle);
  assert.ok(at('LAZY LOADING DESIGN') < at('1. Call list_skills'), 'preamble stays before');
  assert.ok(at('1. Call list_skills') < at('PRAXIS IMPROVEMENT LOOP'), 'trailing prose stays after');
  assert.ok(at('PRAXIS IMPROVEMENT LOOP') < at('ENGRAM MAP'), 'trailing prose keeps its own order');
  assert.equal(assessAgempus(text).stepCount, 2);
});

test('a single bullet is not enough to infer a sequence', () => {
  // Two or more is a list; one is a sentence with a dash in front of it.
  const one = 'Some Skill\n\nDo this carefully.\n\n- the only bullet here\n';
  const { text } = scaffoldAgempus(one, { skillName: 'x' });
  assert.equal(assessAgempus(text).stepCount, 0);
  assert.ok(text.includes('the only bullet here'), 'still preserved, just not numbered');
});

// ── stripPlaceholders ─────────────────────────────────────────────────────────

test('placeholders are stripped before persist, real values are kept', () => {
  const { text } = scaffoldAgempus(
    'X\n\nTrigger: when the thing happens\n\n1. do it\n',
    { skillName: 'x' },
  );
  const stripped = stripPlaceholders(text);
  assert.ok(stripped.includes('Trigger: when the thing happens'));
  assert.doesNotMatch(stripped, /TODO/);
  assert.ok(stripped.includes('1. do it'));
  assert.equal(assessAgempus(stripped).score, 1);
});

// ── traceCoverage ─────────────────────────────────────────────────────────────

test('a faithful compile reports no drops and no inventions', () => {
  const { text } = scaffoldAgempus(PROSE_SKILL, { skillName: 'report-format' });
  const cov = traceCoverage(PROSE_SKILL, text);
  assert.deepEqual(cov.dropped, [], `unexpected drops: ${JSON.stringify(cov.dropped)}`);
  assert.deepEqual(cov.invented, [], `unexpected inventions: ${JSON.stringify(cov.invented)}`);
  assert.equal(cov.retention, 1);
  assert.equal(cov.ok, true);
});

test('coverage detects a dropped step', () => {
  const truncated = PROSE_SKILL.split('\n').filter((l) => !/300dpi/.test(l)).join('\n');
  const cov = traceCoverage(PROSE_SKILL, truncated);
  assert.equal(cov.dropped.length, 1);
  assert.match(cov.dropped[0], /300dpi/);
  assert.ok(cov.retention < 1);
  assert.equal(cov.ok, false);
});

test('coverage detects an invented step', () => {
  const embellished = `${PROSE_SKILL}\n- Upload the finished report to the public web server\n`;
  const cov = traceCoverage(PROSE_SKILL, embellished);
  assert.equal(cov.dropped.length, 0);
  assert.equal(cov.invented.length, 1);
  assert.match(cov.invented[0], /public web server/);
});

test('coverage ignores our own TODO placeholders', () => {
  // Placeholders are the tool talking to the caller, not authored content —
  // tracing them would report every scaffold as mass invention.
  const { text } = scaffoldAgempus(PROSE_SKILL, { skillName: 'report-format' });
  assert.ok(text.includes('TODO'));
  assert.deepEqual(traceCoverage(PROSE_SKILL, text).invented, []);
});

// ── the bounded caller loop ───────────────────────────────────────────────────

test('the compile loop terminates after MAX_COMPILE_ROUNDS', () => {
  const t = new CompileLoopTracker();
  const rounds = [];
  for (let i = 0; i < 5; i++) {
    rounds.push(t.record('g1', 'my-skill', `attempt ${i}`));
  }
  assert.equal(rounds[0].round, 1);
  assert.equal(rounds[0].exhausted, false);
  assert.equal(rounds[1].exhausted, false);
  assert.equal(rounds[MAX_COMPILE_ROUNDS - 1].exhausted, true);
  assert.equal(rounds[4].exhausted, true, 'stays exhausted');
});

test('resending identical text burns the loop immediately', () => {
  // A client stuck retrying the same payload must not get three free passes.
  const t = new CompileLoopTracker();
  assert.equal(t.record('g1', 's', 'same').exhausted, false);
  const second = t.record('g1', 's', 'same');
  assert.equal(second.repeated, true);
  assert.equal(second.exhausted, true);
});

test('loops are tracked per skill and reset on save', () => {
  const t = new CompileLoopTracker();
  t.record('g1', 'skill-a', 'v1');
  assert.equal(t.record('g1', 'skill-b', 'v1').round, 1, 'different skill, own counter');
  assert.equal(t.record('g1', 'skill-a', 'v2').round, 2);
  t.clear('g1', 'skill-a');
  assert.equal(t.record('g1', 'skill-a', 'v3').round, 1, 'cleared after save');
});

test('skill-name matching is slug-insensitive', () => {
  const t = new CompileLoopTracker();
  t.record('g1', 'Report Format', 'v1');
  assert.equal(
    t.record('g1', 'report-format', 'v2').round, 2,
    'a title-case / slug difference must not fork the loop',
  );
});

// ── the guidance block ────────────────────────────────────────────────────────

test('guidance names the gaps, shows the format, and asks for a re-call', () => {
  const scaffold = scaffoldAgempus(PROSE_SKILL, { skillName: 'report-format' });
  const guidance = buildCompileGuidance({
    conformance: assessAgempus(scaffold.text),
    coverage: traceCoverage(PROSE_SKILL, scaffold.text),
    scaffold,
    round: 1,
    skillName: 'report-format',
  });
  assert.match(guidance, /round 1 of 3/);
  assert.match(guidance, /Trigger/);
  assert.match(guidance, /\[dispatch-safe: yes\|partial\|no\]/);
  assert.match(guidance, /Call `train_skill` again/);
  assert.match(guidance, /@needs:/);
  // The caller must get its own text back, not a summary of it.
  assert.ok(guidance.includes('Export to PDF at 300dpi'));
});

test('the last round tells the caller it is the last', () => {
  const scaffold = scaffoldAgempus(PROSE_SKILL, { skillName: 'x' });
  const g = buildCompileGuidance({
    conformance: assessAgempus(scaffold.text),
    coverage: traceCoverage(PROSE_SKILL, scaffold.text),
    scaffold,
    round: MAX_COMPILE_ROUNDS - 1,
  });
  assert.match(g, /This is the last round/);
});

// ── the privacy invariant ─────────────────────────────────────────────────────

test('the compiler is a pure function of the caller-supplied text', () => {
  // The caller loop is only safe to hand back to a cloud-hosted model because
  // nothing here can reach the cortex. If this module ever grows a host,
  // engram, or recall dependency, the loop must be disabled in the same commit.
  const src = readFileSync(
    fileURLToPath(new URL('../src/skill-compiler.ts', import.meta.url)),
    'utf8',
  );
  // Strip the header comment — it *describes* the invariant, so its prose would
  // otherwise trip the very checks it documents.
  const code = src.slice(src.indexOf('export type ContractField'));
  assert.doesNotMatch(code, /from '\.\/host\.js'/, 'compiler must not import the host');
  assert.doesNotMatch(code, /\brecall\s*\(/, 'compiler must not call recall');
  assert.doesNotMatch(code, /GraphnosisHost/, 'compiler must not reference the host type');
  assert.doesNotMatch(code, /^import\s/m, 'compiler must have no imports at all');
});

// ── parse invariants ──────────────────────────────────────────────────────────

test('parsing keeps the training metadata comment out of the body', () => {
  const withMeta = `<!-- Graphnosis skill training metadata
     trainedAt: 2026-07-25T00:00:00.000Z
     mode: source-only
-->

Some Skill

1. do it
`;
  const p = parseSkillText(withMeta);
  assert.equal(p.metadataBlocks.length, 1);
  assert.equal(p.title, 'Some Skill');
  assert.deepEqual(p.steps, ['do it']);
  // ...and the scaffold re-emits it exactly once, not twice.
  const { text } = scaffoldAgempus(withMeta, { skillName: 'Some Skill' });
  assert.equal((text.match(/Graphnosis skill training metadata/g) ?? []).length, 1);
});
