import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckInText } from './ghampus-check-in.js';
import {
  buildAwayDigestText,
  AWAY_DIGEST_PREFIX,
  maybeSummarizeDigest,
  sanitizeDigestSummaryLine,
} from './away-digest.js';
import { isSafeAutoPreviewSkill, normalizeSkillSlug } from './ghampus-safe-preview.js';
import { extractPingSkills, composeCompanionPing } from './ghampus-llm-companion.js';
import type { NotificationEntry } from './agent-notifications.js';
import type { LocalLlm } from './correction.js';

describe('ghampus check-in voice', () => {
  it('names integrity items and previews consistency-audit', () => {
    const text = buildCheckInText({
      now: new Date('2026-08-06T10:00:00'),
      notifications: 2,
      corrections: 1,
      contradictions: 3,
      duplicates: 0,
      suggestSkill: 'consistency-audit',
    });
    assert.match(text, /Good morning/);
    assert.match(text, /3 contradictions/);
    assert.match(text, /preview consistency audit/i);
    assert.match(text, /won't silently rewrite/i);
  });

  it('stays quiet when integrity is clean', () => {
    const text = buildCheckInText({
      now: new Date('2026-08-06T20:00:00'),
      notifications: 0,
      corrections: 0,
      contradictions: 0,
      duplicates: 0,
      suggestSkill: null,
    });
    assert.match(text, /Evening check-in/);
    assert.match(text, /looks quiet/);
  });
});

describe('away digest integrity voice', () => {
  it('folds Memory Integrity into a quiet digest', async () => {
    const text = await buildAwayDigestText([], 0, null, {
      corrections: 0,
      contradictions: 2,
      duplicates: 4,
      suggestPreviewSkill: 'consistency-audit',
    });
    assert.ok(text.startsWith(AWAY_DIGEST_PREFIX));
    assert.match(text, /2 contradictions/);
    assert.match(text, /4 duplicate/);
    assert.match(text, /preview consistency audit/i);
  });
});

describe('safe auto-preview allowlist', () => {
  it('normalizes and matches allowlisted skills', () => {
    assert.equal(normalizeSkillSlug('skill:1:cortex-gardening'), 'cortex-gardening');
    assert.ok(isSafeAutoPreviewSkill('Consistency Audit'));
    assert.ok(isSafeAutoPreviewSkill('task-todo-management'));
    assert.ok(!isSafeAutoPreviewSkill('skill-dispatch'));
  });
});

describe('llm companion ping parsing', () => {
  it('strips PING_SKILL lines and keeps allowlisted only', () => {
    const { text, pingSkills } = extractPingSkills(
      'Status pulse.\n\nWhat first?\nPING_SKILL: consistency-audit\nPING_SKILL: skill-dispatch\nPING_SKILL: task-todo-management\n',
    );
    assert.match(text, /Status pulse/);
    assert.ok(!text.includes('PING_SKILL'));
    assert.deepEqual(pingSkills, ['consistency-audit', 'task-todo-management']);
  });

  it('falls back without LLM', async () => {
    const ping = await composeCompanionPing(null, {
      hourLabel: 'morning',
      notifications: 1,
      corrections: 0,
      contradictions: 2,
      duplicates: 0,
      obligationsDue: 1,
      obligationsOverdue: 0,
      obligationLabels: ['deadline · 8/10/2026'],
      poweredAgents: ['Skills'],
      suggestSkills: ['consistency-audit'],
    });
    assert.equal(ping.usedLlm, false);
    assert.match(ping.text, /Good morning|pulse|Integrity|obligation|@skill/i);
    assert.deepEqual(ping.pingSkills, ['consistency-audit']);
  });
});

describe('away digest Local LLM sweetener', () => {
  const sampleNotifs: NotificationEntry[] = [
    {
      id: 'e1:s1', engramId: 'e1', tier: 'personal', sourceId: 's1',
      originKind: 'connector', origin: 'github', label: 'SECRET_PR_TITLE', ingestedAtMs: 1,
    },
    {
      id: 'e1:s2', engramId: 'e1', tier: 'personal', sourceId: 's2',
      originKind: 'connector', origin: 'github', label: 'other', ingestedAtMs: 2,
    },
    {
      id: 'e1:s3', engramId: 'e1', tier: 'sensitive', sourceId: 's3',
      originKind: 'ai-client', origin: 'claude', label: 'SENSITIVE_CHAT', ingestedAtMs: 3,
    },
  ];

  it('skips LLM when null (Local LLM off / unreachable)', async () => {
    assert.equal(await maybeSummarizeDigest(null, sampleNotifs), null);
  });

  it('prompts with counts only — never labels or memory text', async () => {
    let seenUser = '';
    const llm: LocalLlm = {
      name: 'test',
      complete: async (input) => {
        seenUser = input.user;
        return 'Two connector items and one from AI clients landed while you were out.';
      },
    };
    const line = await maybeSummarizeDigest(llm, sampleNotifs);
    assert.match(line ?? '', /Two connector|AI clients/i);
    assert.match(seenUser, /connectors: 2/);
    assert.match(seenUser, /AI clients: 1/);
    assert.ok(!seenUser.includes('SECRET_PR_TITLE'));
    assert.ok(!seenUser.includes('SENSITIVE_CHAT'));
  });

  it('folds sweetener into full digest when LLM succeeds', async () => {
    const llm: LocalLlm = {
      name: 'test',
      complete: async () => 'A handful of inbound items from connectors and AI clients.',
    };
    const text = await buildAwayDigestText(sampleNotifs, 3, llm);
    assert.ok(text.startsWith(AWAY_DIGEST_PREFIX));
    assert.match(text, /handful of inbound/i);
    assert.match(text, /from connectors/);
  });

  it('strips markdown wrappers from model output', () => {
    assert.equal(sanitizeDigestSummaryLine('_Quiet day overall._'), 'Quiet day overall.');
    assert.equal(sanitizeDigestSummaryLine('**Busy connectors.**'), 'Busy connectors.');
  });
});
