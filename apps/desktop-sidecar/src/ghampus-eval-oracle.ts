/**
 * Ghampus eval oracle — intent, recall facts, consistency, parity scoring.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GhampusIntent } from './ghampus-intent.ts';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'fixtures', 'ghampus-eval');

export type CanonicalFacts = Record<
  string,
  { requiredFacts?: string[]; forbiddenFacts?: string[] }
>;

export function loadCanonicalFacts(): CanonicalFacts {
  const raw = readFileSync(join(FIXTURES_DIR, 'canonical-facts.json'), 'utf8');
  return JSON.parse(raw) as CanonicalFacts;
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function checkRequiredFacts(text: string, required: string[]): string[] {
  const norm = normalizeText(text);
  return required.filter((f) => !norm.includes(normalizeText(f)));
}

export function checkForbiddenFacts(text: string, forbidden: string[]): string[] {
  const norm = normalizeText(text);
  return forbidden.filter((f) => norm.includes(normalizeText(f)));
}

export type IntentOracleResult = {
  pass: boolean;
  expected: GhampusIntent['action'];
  actual: GhampusIntent['action'] | null;
  reason?: string;
};

export function scoreIntent(
  expected: GhampusIntent['action'] | 'question',
  actual: GhampusIntent['action'] | null,
): IntentOracleResult {
  const exp = expected === 'question' ? 'recall' : expected;
  const pass = actual === exp;
  return {
    pass,
    expected: exp as GhampusIntent['action'],
    actual,
    ...(pass ? {} : { reason: `expected intent ${exp}, got ${actual ?? 'null'}` }),
  };
}

export type RecallOracleResult = {
  pass: boolean;
  missingFacts: string[];
  forbiddenHits: string[];
  reason?: string;
};

export function scoreRecall(
  responseText: string,
  canonicalKey: string,
  facts: CanonicalFacts = loadCanonicalFacts(),
): RecallOracleResult {
  const spec = facts[canonicalKey];
  if (!spec) {
    return { pass: false, missingFacts: [], forbiddenHits: [], reason: `unknown canonicalKey ${canonicalKey}` };
  }
  const required = spec.requiredFacts ?? [];
  const forbidden = spec.forbiddenFacts ?? [];
  const missingFacts = checkRequiredFacts(responseText, required);
  const forbiddenHits = checkForbiddenFacts(responseText, forbidden);
  const pass = missingFacts.length === 0 && forbiddenHits.length === 0;
  return {
    pass,
    missingFacts,
    forbiddenHits,
    ...(pass
      ? {}
      : {
          reason: [
            missingFacts.length ? `missing: ${missingFacts.join(', ')}` : '',
            forbiddenHits.length ? `forbidden: ${forbiddenHits.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('; '),
        }),
  };
}

export type ConsistencyOracleResult = {
  pass: boolean;
  uniqueNormalized: number;
  totalRuns: number;
  agreementScore?: number;
  factSets?: string[][];
  reason?: string;
};

/** Same case + model + overlay should produce identical normalized text across repeats. */
export function scoreConsistency(normalizedResponses: string[]): ConsistencyOracleResult {
  const totalRuns = normalizedResponses.length;
  const unique = new Set(normalizedResponses);
  const pass = unique.size === 1 && totalRuns > 0;
  return {
    pass,
    uniqueNormalized: unique.size,
    totalRuns,
    ...(pass ? {} : { reason: `${unique.size} distinct responses across ${totalRuns} runs` }),
  };
}

export type ParityOracleResult = {
  pass: boolean;
  ghampusFactsMissing: string[];
  mcpFactsMissing: string[];
  reason?: string;
};

/** Ghampus response should cover same required facts as direct MCP recall for canonical key. */
export function scoreParity(
  ghampusText: string,
  mcpText: string,
  canonicalKey: string,
  facts: CanonicalFacts = loadCanonicalFacts(),
): ParityOracleResult {
  const spec = facts[canonicalKey];
  if (!spec) {
    return {
      pass: false,
      ghampusFactsMissing: [],
      mcpFactsMissing: [],
      reason: `unknown canonicalKey ${canonicalKey}`,
    };
  }
  const required = spec.requiredFacts ?? [];
  const ghampusFactsMissing = checkRequiredFacts(ghampusText, required);
  const mcpFactsMissing = checkRequiredFacts(mcpText, required);
  const pass =
    ghampusFactsMissing.length === 0 &&
    mcpFactsMissing.length === 0 &&
    ghampusFactsMissing.length === mcpFactsMissing.length;
  return {
    pass,
    ghampusFactsMissing,
    mcpFactsMissing,
    ...(pass
      ? {}
      : {
          reason: `ghampus missing ${ghampusFactsMissing.join(', ')}; mcp missing ${mcpFactsMissing.join(', ')}`,
        }),
  };
}

export type LlmJudgeResult = {
  pass: boolean;
  score: number;
  rationale?: string;
};

/** Optional LLM judge — caller supplies async judge fn when GRAPHNOSIS_EVAL_LLM_JUDGE=1 */
export async function scoreWithLlmJudge(
  question: string,
  response: string,
  canonicalKey: string,
  judgeFn?: (prompt: string) => Promise<string>,
): Promise<LlmJudgeResult | null> {
  if (!judgeFn) return null;
  const facts = loadCanonicalFacts();
  const spec = facts[canonicalKey];
  const required = spec?.requiredFacts?.join(', ') ?? 'none';
  const forbidden = spec?.forbiddenFacts?.join(', ') ?? 'none';
  const prompt = `You are an eval judge. Question: ${question}\nResponse: ${response}\nRequired facts: ${required}\nForbidden facts: ${forbidden}\nReply JSON only: {"pass":boolean,"score":0-1,"rationale":"..."}`;
  const raw = await judgeFn(prompt);
  try {
    const parsed = JSON.parse(raw.trim()) as LlmJudgeResult;
    return parsed;
  } catch {
    return { pass: false, score: 0, rationale: `judge parse failed: ${raw.slice(0, 200)}` };
  }
}

export function aggregateCasePass(
  intent?: IntentOracleResult,
  recall?: RecallOracleResult,
  consistency?: ConsistencyOracleResult,
  parity?: ParityOracleResult,
  judge?: LlmJudgeResult | null,
): boolean {
  const checks = [
    intent?.pass,
    recall?.pass,
    consistency?.pass,
    parity?.pass,
    judge ? judge.pass : true,
  ].filter((v) => v !== undefined);
  return checks.every((v) => v === true);
}

/** Strip markdown bold, relative times, collapse whitespace for prose stability checks. */
export function normalizeForCompare(text: string): string {
  return normalizeText(text)
    .replace(/\*\*/g, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\b(just now|a moment ago|minutes? ago|hours? ago)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Regex-based fact extraction for consistency oracle (sorted unique set). */
export function extractStructuredFacts(text: string): string[] {
  const norm = normalizeText(text);
  const facts: string[] = [];
  const patterns = [
    /\b\d+\.\d+\.\d+\b/g,
    /\b(?:alice|bob|carol)\b/gi,
    /\b(?:dashboard refactor|rate limiting|roadmap|refactor dashboard)\b/gi,
    /\b(?:seahorse|friday|wednesday|monday|vineri|miercuri|luni|marți|marti)\b/gi,
    /\b2\.4\.1\b/g,
  ];
  for (const re of patterns) {
    for (const m of norm.matchAll(re)) {
      facts.push(m[0].toLowerCase());
    }
  }
  return [...new Set(facts)].sort();
}

export function agreementScore(normalizedResponses: string[]): number {
  if (normalizedResponses.length === 0) return 0;
  const groups = new Map<string, number>();
  for (const r of normalizedResponses) {
    const key = r;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const maxGroup = Math.max(...groups.values());
  return maxGroup / normalizedResponses.length;
}

export function scoreConsistencyDetailed(
  responseTexts: string[],
  minAgreement = 1.0,
): ConsistencyOracleResult & { agreementScore: number; factSets: string[][] } {
  const normalized = responseTexts.map(normalizeForCompare);
  const factSets = responseTexts.map(extractStructuredFacts);
  const hashAgreement = agreementScore(normalized);
  const firstFacts = factSets[0] ?? [];
  const factAgreement =
    factSets.length > 0
      ? factSets.filter((fs) => JSON.stringify(fs) === JSON.stringify(firstFacts)).length / factSets.length
      : 0;
  const agreementScoreValue = Math.max(hashAgreement, factAgreement);
  const pass = agreementScoreValue >= minAgreement;
  const unique = new Set(normalized);
  return {
    pass,
    uniqueNormalized: unique.size,
    totalRuns: responseTexts.length,
    agreementScore: agreementScoreValue,
    factSets,
    ...(pass
      ? {}
      : {
          reason: `agreement ${agreementScoreValue.toFixed(2)} < ${minAgreement} (${unique.size} prose variants)`,
        }),
  };
}

/** Alias for plan naming — MCP client-sim vs Ghampus chat parity. */
export function compareMcpGhampusParity(
  ghampusText: string,
  mcpText: string,
  canonicalKey: string,
  facts?: CanonicalFacts,
): ParityOracleResult {
  return scoreParity(ghampusText, mcpText, canonicalKey, facts);
}
