// @disclosure: (a) publishable — Spec only — asserts what joinPdfTextItems must produce for a
//   given item stream. States a required behaviour; carries no defect mechanism, no reproduction
//   steps and no shipped-build claim.
// @disclosure-src: added 2026-08-03 · class (a) by construction · enforced by scripts/check-disclosure-tags.sh
/**
 * joinPdfTextItems — line-joining contract.
 *
 * The extractor may set the end-of-line flag on an item that ALSO carries
 * text: it emits standalone empty markers, but it equally flushes an
 * accumulating run with the flag still attached. Both shapes are ordinary
 * output, so the joiner must treat the flag as "break AFTER this item",
 * never as "this item has nothing to contribute".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinPdfTextItems } from '../dist/pdf-text-join.js';

/** Minimal item: text at x with a width, optionally ending its line. */
const item = (str, x = 0, y = 0, width = 10, hasEOL = false) => ({
  str,
  transform: [1, 0, 0, 1, x, y],
  width,
  hasEOL,
});

test('text on an end-of-line item is preserved, not dropped', () => {
  const out = joinPdfTextItems([
    item('The Un-Brain', 0, 100, 60, true),
    item('Author line', 0, 90, 50, true),
  ]);
  assert.ok(out.includes('The Un-Brain'), `title lost from output: ${JSON.stringify(out)}`);
  assert.ok(out.includes('Author line'), `second line lost from output: ${JSON.stringify(out)}`);
});

test('an end-of-line item still ends its line', () => {
  const out = joinPdfTextItems([
    item('first', 0, 100, 30, true),
    item('second', 0, 90, 30, false),
  ]);
  assert.equal(out, 'first\nsecond', `expected a break between the two: ${JSON.stringify(out)}`);
});

test('a standalone empty end-of-line marker still breaks the line', () => {
  const out = joinPdfTextItems([
    item('alpha', 0, 100, 30, false),
    { str: '', hasEOL: true },
    item('beta', 0, 100, 30, false),
  ]);
  assert.equal(out, 'alpha\nbeta', `empty marker did not break: ${JSON.stringify(out)}`);
});

test('no duplicate break when text and marker both end the same line', () => {
  const out = joinPdfTextItems([
    item('one', 0, 100, 20, true),
    { str: '', hasEOL: true },
    item('two', 0, 90, 20, false),
  ]);
  assert.ok(!out.includes('\n\n'), `doubled break: ${JSON.stringify(out)}`);
  assert.equal(out, 'one\ntwo');
});

test('ordinary same-line items are unaffected', () => {
  // Two words separated by a real gap, neither ending the line.
  const out = joinPdfTextItems([
    item('hello', 0, 100, 30, false),
    item('world', 40, 100, 30, false),
  ]);
  assert.equal(out, 'hello world', `same-line joining changed: ${JSON.stringify(out)}`);
});

test('total characters in equal total characters out, breaks aside', () => {
  const items = [
    item('Introduction', 0, 100, 60, true),
    item('to the', 0, 90, 30, false),
    item('subject', 40, 90, 30, true),
  ];
  const expected = items.reduce((n, i) => n + i.str.length, 0);
  const got = joinPdfTextItems(items).replace(/[\n ]/g, '').length;
  const want = items.map((i) => i.str).join('').replace(/ /g, '').length;
  assert.equal(got, want, `characters lost: kept ${got} of ${want} (input total ${expected})`);
});
