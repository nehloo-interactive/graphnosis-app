// Trainer goal-header robustness — normalizeInlineGoalHeader.
//
// Fixes a real 1/8-goal bug for inline-authored skills: when all 8 goal fields
// are written on ONE semicolon-joined line, that line carries only the leading
// `Trigger:` keyword, so the chunker classifies the whole thing as a single
// `goal-trigger` chunk and the other 7 fields ride inside the trigger value —
// the skill stores 1/8 goal nodes instead of 8/8.
//
// The fix is a deterministic pre-chunk normalization that splits a single
// goal-header line into one line per goal field. These tests prove:
//   (a) an inline 8-field header yields 8 goal-role chunks,
//   (b) a header already one-per-line is unchanged (still 8 goal chunks),
//   (c) a semicolon inside a step body is NOT split.

import {
  normalizeInlineGoalHeader,
  classifyChunkRole,
} from '../apps/desktop-sidecar/src/skill-trainer.js';
import { assert, section, standalone, runSuite, type SuiteResult } from './_helpers.js';

/** Mirror the trainer's body→chunk pipeline closely enough to classify roles:
 *  normalize the body, split into blank-line paragraphs, then split each
 *  paragraph at goal-line boundaries (the same line-level split trainSkill does
 *  inside its body-sectioning loop). Returns the per-chunk role list as the
 *  stored skill would carry, prefixed by a synthetic title so the first
 *  non-metadata chunk is the title (matching classifyChunkRole's contract). */
function chunkRolesFromBody(body: string): string[] {
  const normalized = normalizeInlineGoalHeader(body);
  const paragraphs = normalized.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  // Within each paragraph, every line that begins a goal field becomes its own
  // chunk; consecutive non-goal lines stay grouped (same as trainSkill).
  const GOAL_LINE = /^(?:Trigger|Prerequisites|Requires|Produces|Success|Out of scope|On failure|On completion):/u;
  const chunks: string[] = ['My Skill']; // synthetic title chunk
  for (const p of paragraphs) {
    let run: string[] = [];
    const flush = (): void => {
      const t = run.join('\n').trim();
      if (t) chunks.push(t);
      run = [];
    };
    for (const line of p.split('\n')) {
      if (GOAL_LINE.test(line.trim())) {
        flush();
        chunks.push(line.trim());
      } else {
        run.push(line);
      }
    }
    flush();
  }
  let classified = 0;
  return chunks.map((c, i) => {
    const role = classifyChunkRole(c, i, classified);
    if (role !== 'metadata') classified++;
    return role;
  });
}

function countGoalRoles(roles: string[]): number {
  return roles.filter((r) => r.startsWith('goal-')).length;
}

const INLINE_HEADER =
  'Trigger: a new contract arrives; Prerequisites: the legal engram is loaded; ' +
  'Requires: contract PDF; Produces: a risk summary; Success: every clause is flagged; ' +
  'Out of scope: signing the contract; On failure: escalate to counsel; ' +
  'On completion: a saved review note';

const PER_LINE_HEADER = [
  'Trigger: a new contract arrives',
  'Prerequisites: the legal engram is loaded',
  'Requires: contract PDF',
  'Produces: a risk summary',
  'Success: every clause is flagged',
  'Out of scope: signing the contract',
  'On failure: escalate to counsel',
  'On completion: a saved review note',
].join('\n\n');

async function goalHeaderSuite(): Promise<void> {
  section('(a) inline 8-field header → 8 goal-role chunks');
  const inlineRoles = chunkRolesFromBody(INLINE_HEADER);
  assert(countGoalRoles(inlineRoles) === 8, 'inline header yields exactly 8 goal chunks', inlineRoles);
  const inlineSet = new Set(inlineRoles.filter((r) => r.startsWith('goal-')));
  assert(inlineSet.size === 8, 'all 8 goal roles are distinct (no duplicates / drops)', [...inlineSet]);
  for (const r of ['goal-trigger', 'goal-prereq', 'goal-requires', 'goal-produces',
                   'goal-success', 'goal-scope', 'goal-failure', 'goal-done']) {
    assert(inlineSet.has(r), `inline header produces ${r}`);
  }

  section('(b) one-per-line header is unchanged');
  // normalize must be a no-op on already-split text…
  assert(
    normalizeInlineGoalHeader(PER_LINE_HEADER) === PER_LINE_HEADER,
    'normalize is a no-op on a one-per-line header',
  );
  // …and still classifies to 8 goal chunks.
  const perLineRoles = chunkRolesFromBody(PER_LINE_HEADER);
  assert(countGoalRoles(perLineRoles) === 8, 'one-per-line header still yields 8 goal chunks', perLineRoles);

  section('(b′) the two authoring styles classify identically');
  assert(
    JSON.stringify(chunkRolesFromBody(INLINE_HEADER)) === JSON.stringify(perLineRoles),
    'inline and per-line headers produce the same role sequence',
    { inline: inlineRoles, perLine: perLineRoles },
  );

  section('(c) a semicolon inside a step body is NOT split');
  const stepWithSemicolon =
    '1. Open the contract; then read the indemnity clause; finally note the term.';
  assert(
    normalizeInlineGoalHeader(stepWithSemicolon) === stepWithSemicolon,
    'a numbered step with inner semicolons is left untouched',
  );
  const stepRoles = chunkRolesFromBody(stepWithSemicolon);
  // Only the synthetic title + the single body step — no goal chunks at all.
  assert(countGoalRoles(stepRoles) === 0, 'step-with-semicolons produces no goal chunks', stepRoles);
  assert(stepRoles.filter((r) => r === 'body').length === 1, 'the step stays a single body chunk', stepRoles);

  section('(c′) a semicolon inside a goal VALUE is not split');
  // "Success: parsed; validated; saved" — the inner semicolons are part of the
  // value, not field separators, because they are NOT followed by a goal keyword.
  const goalWithInnerSemicolons = 'Success: parsed; validated; saved';
  assert(
    normalizeInlineGoalHeader(goalWithInnerSemicolons) === goalWithInnerSemicolons,
    'semicolons inside a goal value are not split',
  );
  const goalValueRoles = chunkRolesFromBody(goalWithInnerSemicolons);
  assert(countGoalRoles(goalValueRoles) === 1, 'a single goal with inner semicolons stays one goal chunk', goalValueRoles);

  section('(c″) a mixed header (real goals + a value semicolon) splits only on field boundaries');
  const mixed =
    'Trigger: a contract arrives; Success: parsed; validated; saved; On failure: escalate to counsel';
  const mixedRoles = chunkRolesFromBody(mixed);
  // Three goal fields: Trigger, Success (carrying its inner semicolons), On failure.
  assert(countGoalRoles(mixedRoles) === 3, 'mixed header yields exactly 3 goal chunks', mixedRoles);
}

export async function run(): Promise<SuiteResult> {
  return runSuite('skill-goal-header-normalize', goalHeaderSuite);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void standalone('skill-goal-header-normalize', goalHeaderSuite);
}
