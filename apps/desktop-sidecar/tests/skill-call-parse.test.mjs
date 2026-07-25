/**
 * Regression tests for sub-skill call detection (parseSkillCall).
 *
 * Guards the invariant the golden-walk fixtures depend on: a step reports an
 * `unresolvedCall` ONLY when the author wrote deliberate call syntax. Two
 * regressions motivated these:
 *
 *  1. `@skill:` was matched greedily anywhere in a node's text, so prose that
 *     merely QUOTED the syntax (documentation describing how calls work) was
 *     read as a call whose "name" was the rest of the sentence.
 *  2. Natural-language phrasings ("use the X skill") were treated the same as
 *     real calls, so ordinary sentences surfaced as broken sub-skill links.
 *
 * The explicit cases below are the verbatim strings behind the committed
 * golden-walk fixtures (src/fixtures/golden-walks/), so if detection ever stops
 * recognising them, this fails before the fixtures drift.
 *
 * Run after build: node --test tests/skill-call-parse.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillCall } from '../dist/skill-trainer.js';

test('explicit @skill: call parses and is marked explicit', () => {
  // Verbatim from src/fixtures/golden-walks/skill-dispatch.json (step 2).
  const parsed = parseSkillCall('1. Call @skill: verify-target.');
  assert.ok(parsed, 'expected a parsed call');
  assert.equal(parsed.target, 'verify-target');
  assert.equal(parsed.explicit, true);
});

test('explicit call in an On failure: goal parses and is marked explicit', () => {
  // Verbatim from src/fixtures/golden-walks/ship-workflow.json (failureHandlers).
  const parsed = parseSkillCall('@skill: rollback-ship');
  assert.ok(parsed, 'expected a parsed call');
  assert.equal(parsed.target, 'rollback-ship');
  assert.equal(parsed.explicit, true);
});

test('explicit call spanning multiple lines keeps the name only', () => {
  const parsed = parseSkillCall(
    '5. Check if $shipSignal names a version tag. If yes:\n' +
    '   @skill: generated-artifact-freshness-check\n' +
    '   Then bump version + commit version files.',
  );
  assert.ok(parsed, 'expected a parsed call');
  assert.equal(parsed.target, 'generated-artifact-freshness-check');
  assert.equal(parsed.explicit, true);
});

test('explicit call carries args and capture', () => {
  const parsed = parseSkillCall('@skill: consistency-audit(scope=all) -> $auditResult');
  assert.ok(parsed, 'expected a parsed call');
  assert.equal(parsed.target, 'consistency-audit');
  assert.equal(parsed.explicit, true);
  assert.deepEqual(parsed.args, ['all']);
  assert.equal(parsed.captureAs, 'auditResult');
});

test('[[skill: …]] form is explicit', () => {
  const parsed = parseSkillCall('Then [[skill: runtime-diagnosis]] to instrument the boot path.');
  assert.ok(parsed, 'expected a parsed call');
  assert.equal(parsed.target, 'runtime-diagnosis');
  assert.equal(parsed.explicit, true);
});

test('prose quoting the call syntax is not read as a call', () => {
  // Regression 1: the greedy matcher captured the remainder of the sentence as
  // a skill name, producing an unresolved call on a documentation paragraph.
  const parsed = parseSkillCall(
    'NOTE: cross-skill `@skill:` links are bound at TRAIN time, and under the ' +
    'current SDK that binding no longer happens.',
  );
  if (parsed) {
    assert.equal(parsed.explicit, false, 'prose must never be treated as an explicit call');
    assert.ok(
      !parsed.target.includes(' bound at train time'),
      `sentence was swallowed as a skill name: ${parsed.target}`,
    );
  }
});

test('natural-language mention resolves but is never explicit', () => {
  // Regression 2: still detected (a real sibling skill may be named), but it
  // must not be reportable as a missing sub-skill.
  const parsed = parseSkillCall('If the score drops, use the retrain queue skill later.');
  assert.ok(parsed, 'natural-language detection should still fire');
  assert.equal(parsed.explicit, false);
});

test('natural-language "run the X skill" is never explicit', () => {
  const parsed = parseSkillCall('You may run the generated-artifact-freshness-check skill manually.');
  assert.ok(parsed, 'natural-language detection should still fire');
  assert.equal(parsed.explicit, false);
});

test('a step with no skill reference parses to null', () => {
  assert.equal(parseSkillCall('7. Stage and commit each group separately.'), null);
});
