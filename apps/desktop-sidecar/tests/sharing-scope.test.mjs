/**
 * Unit tests for the sharing-scope predicate (core settings) — the single
 * source of truth for what a share covers, including cortex-wide carve-outs.
 * Run after building @graphnosis-app/core: node --test tests/sharing-scope.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeCoversEngram,
  resolveScopedEngramIds,
  scopeIsFullCortex,
} from '@graphnosis-app/core/settings';

test('array scope covers only listed engrams', () => {
  const scope = { engrams: ['a', 'b'], role: 'viewer' };
  assert.equal(scopeCoversEngram(scope, 'a'), true);
  assert.equal(scopeCoversEngram(scope, 'c'), false);
  assert.equal(scopeIsFullCortex(scope), false);
});

test('full-cortex scope covers everything, including future ids', () => {
  const scope = { engrams: '*', role: 'viewer' };
  assert.equal(scopeCoversEngram(scope, 'anything'), true);
  assert.equal(scopeCoversEngram(scope, 'created-later'), true);
  assert.equal(scopeIsFullCortex(scope), true);
});

test('carve-outs exclude exactly the excepted ids', () => {
  const scope = { engrams: '*', except: ['private-x'], role: 'editor' };
  assert.equal(scopeCoversEngram(scope, 'private-x'), false);
  assert.equal(scopeCoversEngram(scope, 'work'), true);
  assert.equal(scopeCoversEngram(scope, 'created-later'), true);
});

test('a scope with carve-outs is NOT full-cortex', () => {
  assert.equal(scopeIsFullCortex({ engrams: '*', except: ['x'] }), false);
  assert.equal(scopeIsFullCortex({ engrams: '*', except: [] }), true);
  assert.equal(scopeIsFullCortex({ engrams: '*' }), true);
  assert.equal(scopeIsFullCortex({ engrams: ['a'] }), false);
});

test('empty except behaves like full cortex', () => {
  const scope = { engrams: '*', except: [], role: 'viewer' };
  assert.equal(scopeCoversEngram(scope, 'anything'), true);
});

test('except is inert on array scopes', () => {
  // The sanitizer never persists except on array scopes; the predicate
  // must also ignore it defensively if one slips through.
  const scope = { engrams: ['a'], except: ['a'], role: 'viewer' };
  assert.equal(scopeCoversEngram(scope, 'a'), true);
});

test('resolveScopedEngramIds filters the cortex inventory', () => {
  const all = ['a', 'b', 'private-x'];
  assert.deepEqual(resolveScopedEngramIds({ engrams: '*', except: ['private-x'] }, all), ['a', 'b']);
  assert.deepEqual(resolveScopedEngramIds({ engrams: ['b', 'ghost'] }, all), ['b']);
  assert.deepEqual(resolveScopedEngramIds({ engrams: '*' }, all), all);
});
