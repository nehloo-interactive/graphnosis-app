import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThreadScopedUserPrompt,
  citationsFromTraceSteps,
} from './ghampus-thread-context.js';

describe('ghampus thread context', () => {
  it('scopes prompt to parent + thread replies', () => {
    const prompt = buildThreadScopedUserPrompt('What next?', {
      threadId: 'root-1',
      parentId: 'root-1',
      rootText: 'While you were away — 3 items',
      parentText: 'While you were away — 3 items',
      threadReplies: [
        { kind: 'user', text: 'Show connectors', messageId: 'u1' },
        { kind: 'ghampus', text: 'Two from GitHub.', messageId: 'g1' },
      ],
      mentions: ['Nelu'],
    });
    assert.match(prompt, /THREAD ROOT/);
    assert.match(prompt, /While you were away/);
    assert.match(prompt, /Show connectors/);
    assert.match(prompt, /@Nelu/);
    assert.match(prompt, /USER REPLY:\nWhat next\?/);
  });

  it('builds citations from recall / skill / integrity steps', () => {
    const cites = citationsFromTraceSteps([
      { tool: 'recall', label: 'Searching memory', preview: 'hit A', status: 'ok' },
      { tool: 'walk_skill', label: 'Preview consistency-audit', status: 'ok' },
      { tool: 'stats', label: 'Other', status: 'ok' },
    ]);
    assert.ok(cites.some((c) => c.kind === 'source'));
    assert.ok(cites.some((c) => c.kind === 'skill-walk'));
  });
});
