/**
 * Ghampus compose rail — language-agnostic proactive helpers while typing.
 * Single IPC payload powers engram chips, intent hints, integrity warnings, etc.
 */
import type { GraphnosisHost } from './host.js';
import type { BrainEngine } from './brain-engine.js';
import type { SkillTrainer } from './skill-trainer.js';
import {
  detectWantsConsistencyWalk,
  detectWantsCrossEngramSearch,
  isVagueRememberContent,
  keywordIntent,
  parseEditIntent,
  extractSkillWalkTarget,
  questionIntent,
  hasExplicitSaveVerb,
  isForgetLikeCommand,
  isChatSummarizeRequest,
} from './ghampus-intent.js';
import {
  parseRememberContentFirstPattern,
  parseRememberInToPattern,
  refinePartialEngramHint,
  resolveEngramFromUserHint,
  slugifyEngramHint,
  trimGreedyEngramHint,
} from './ghampus-engram-resolve.js';
import { extractDueDateFromLine } from './ghampus-temporal-parse.js';
import { listRecentSaves } from './agent-tools.js';
import type { ComposeIntentFields } from './ghampus-compose-intent-llm.js';

export type PrimaryIntent = 'idle' | 'save' | 'recall' | 'edit' | 'slash' | 'skill' | 'foresight' | 'create_engram';
export type MemoryVoice = 'decision' | 'todo' | 'fact' | 'quote';

export interface ComposeEngramOption {
  graphId: string;
  displayName: string;
  tier: string;
}

export interface GhampusComposeAssistContext {
  selectedText?: string;
  lastGhampusSnippet?: string;
  threadTurnCount?: number;
  hoursSinceActive?: number;
  /** User picked an engram chip — keep target while note text grows. */
  pinnedEngramGraphId?: string | null;
}

export interface GhampusComposeAssist {
  primaryIntent: PrimaryIntent;
  intentLabel: string;
  mcpToolHint: string | null;

  saveIntent: boolean;
  slashSave: boolean;
  slashCommand: string | null;
  selectedEngramHint: string | null;
  /** Resolved engram when the user typed a hint in compose text. */
  selectedEngramId: string | null;

  chipEngramIds: string[];
  engrams: ComposeEngramOption[];
  suggestedEngram: ComposeEngramOption | null;

  duplicateWarning: {
    graphId: string;
    engramName: string;
    snippet: string;
    score: number;
  } | null;

  contradictionWarning: { count: number } | null;
  obligationHint: { obligationType: string; expiresAt: number; label: string } | null;
  languageMirror: string[] | null;
  vagueReference: { pronoun: string; suggestedSnippet: string } | null;
  consentGate: { tier: string; engramId: string; displayName: string } | null;

  skillMatches: Array<{ slug: string; label: string }>;
  foresightHint: { kind: string; label: string; proRequired: boolean } | null;
  recallPrefetch: { matchCount: number; topSnippet: string | null } | null;
  threadSummaryOffer: boolean;
  sourceMentions: Array<{ sourceId: string; label: string; graphId: string }>;

  memoryVoice: MemoryVoice | null;
  temporalAnchor: string | null;
  crossEngramSuggestion: ComposeEngramOption | null;
  vitalityNudge: { engramId: string; displayName: string; message: string } | null;
  awayDigest: { corrections: number; contradictions: number; duplicates: number } | null;

  selectionBridge: { quotedText: string; action: 'save' | 'comment' } | null;

  /** Typed engram name does not match any existing engram — offer inline create. */
  createEngramOffer: {
    displayName: string;
    graphId: string;
    defaultTier: 'personal' | 'sensitive';
  } | null;

  /** Set when a follow-up LLM refine pass upgraded intent from idle. */
  intentSource?: 'heuristic' | 'llm';
  llmConfidence?: number | null;
}

const CHIP_LIMIT = 6;
const MEMORY_VOICE_RE: Array<{ voice: MemoryVoice; re: RegExp }> = [
  { voice: 'decision', re: /\b(decided|decision|will use|going with|chosen|ales|deciz)\b/i },
  { voice: 'todo', re: /\b(todo|task|deadline|due|follow up|remind me to|termen|de f[aă]cut)\b/i },
  { voice: 'quote', re: /^["'""]| said:|:\s*["'""]/ },
];

function titleCaseEngramName(hint: string): string {
  return trimGreedyEngramHint(hint).replace(/(^|[\s-])([a-z])/gi, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

function buildCreateEngramOffer(
  hint: string | null,
  resolved: ComposeEngramOption | null,
  saveIntent: boolean,
): GhampusComposeAssist['createEngramOffer'] {
  if (!saveIntent || !hint?.trim() || resolved) return null;
  const displayName = titleCaseEngramName(hint);
  const graphId = slugifyEngramHint(hint);
  if (graphId.length < 2 || !/^[a-z0-9][a-z0-9-]*$/.test(graphId)) return null;
  return { displayName, graphId, defaultTier: 'personal' };
}

function stripLeadingVerb(text: string): string {
  return text.trim().replace(/^\S+\s+/, '');
}

function parseEngramHintFromText(text: string): string | null {
  const t = text.trim();
  const atMatch = t.match(/\s@([\w-]+)$/);
  if (atMatch?.[1]) return atMatch[1].toLowerCase();

  const afterVerb = stripLeadingVerb(t);
  const inTo = parseRememberInToPattern(afterVerb);
  if (inTo?.engram) return inTo.engram.toLowerCase();

  const contentFirst = parseRememberContentFirstPattern(afterVerb);
  if (contentFirst?.engram) return contentFirst.engram.toLowerCase();

  // Partial: "in/to ENGRAM" while still typing (before note content or trailing "that").
  const prep = afterVerb.match(/^(?:in|to|into|în)\s+(?:(?:my|the|meu|mea)\s+)?(.+)$/i);
  if (prep?.[1]) {
    let segment = prep[1].trim().replace(/\s+that\s*$/i, '').trim();
    segment = trimGreedyEngramHint(segment);
    if (segment.length >= 2) return segment.toLowerCase();
  }

  return null;
}

/**
 * Compose rail engram hint — prefer "remember in ENGRAM …" over "CONTENT to ENGRAM"
 * so note infinitives ("to come up with") are not mistaken for engram names.
 */
export function resolveComposeSaveEngramHint(
  text: string,
  keyword: ReturnType<typeof keywordIntent>,
): string | null {
  const parsed = parseEngramHintFromText(text);
  const afterVerb = stripLeadingVerb(text.trim());
  const usesInToLeading = /^(?:in|to|into|în|in)\s+/i.test(afterVerb);
  if (usesInToLeading && parsed) return parsed;
  if (keyword?.action === 'remember' && keyword.engram) {
    return keyword.engram.toLowerCase();
  }
  return parsed;
}

function resolveSelectedEngramFromHint(
  hint: string | null,
  all: ComposeEngramOption[],
): ComposeEngramOption | null {
  if (!hint?.trim()) return null;
  const resolved = resolveEngramFromUserHint(hint, all.map((e) => ({
    graphId: e.graphId,
    displayName: e.displayName,
    tier: e.tier,
  })));
  if (!resolved) return null;
  return all.find((e) => e.graphId === resolved.graphId) ?? {
    graphId: resolved.graphId,
    displayName: resolved.displayName,
    tier: resolved.tier ?? 'personal',
  };
}

function listAllEngrams(host: GraphnosisHost): ComposeEngramOption[] {
  return host.listGraphs().map((graphId) => {
    const meta = host.getGraphMetadata(graphId) as { displayName?: string; sensitivityTier?: string } | undefined;
    return {
      graphId,
      displayName: meta?.displayName ?? graphId,
      tier: meta?.sensitivityTier ?? 'personal',
    };
  });
}

/** Rank engrams by latest ingest activity (any source, any client). */
export function rankEngramIdsByRecentActivity(host: GraphnosisHost): string[] {
  const latest = new Map<string, number>();
  for (const graphId of host.listGraphs()) {
    let max = 0;
    for (const s of host.listSources(graphId)) {
      if (s.ingestedAt > max) max = s.ingestedAt;
    }
    if (max > 0) latest.set(graphId, max);
  }
  const ghampusRecent = listRecentSaves({ host }, { limit: 30, sinceMs: Date.now() - 14 * 86400_000 });
  for (const save of ghampusRecent.saves) {
    const prev = latest.get(save.engramId) ?? 0;
    if (save.addedAtMs > prev) latest.set(save.engramId, save.addedAtMs);
  }
  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

function buildChipEngramIds(
  host: GraphnosisHost,
  all: ComposeEngramOption[],
  pinnedGraphId?: string | null,
): string[] {
  const ranked = rankEngramIdsByRecentActivity(host);
  const seen = new Set<string>();
  const chips: string[] = [];

  if (pinnedGraphId && all.some((e) => e.graphId === pinnedGraphId)) {
    chips.push(pinnedGraphId);
    seen.add(pinnedGraphId);
  }

  for (const id of ranked) {
    if (!all.some((e) => e.graphId === id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    chips.push(id);
    if (chips.length >= CHIP_LIMIT) return chips;
  }
  for (const e of all.sort((a, b) => {
    const ap = a.tier === 'personal' || a.graphId === 'personal';
    const bp = b.tier === 'personal' || b.graphId === 'personal';
    if (ap !== bp) return ap ? -1 : 1;
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  })) {
    if (seen.has(e.graphId)) continue;
    seen.add(e.graphId);
    chips.push(e.graphId);
    if (chips.length >= CHIP_LIMIT) break;
  }
  return chips;
}

function suggestEngramForText(host: GraphnosisHost, text: string, all: ComposeEngramOption[]): ComposeEngramOption | null {
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
  if (words.length === 0) return null;
  let best: ComposeEngramOption | null = null;
  let bestScore = 0;
  for (const e of all) {
    const hay = `${e.graphId} ${e.displayName}`.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (hay.includes(w)) score += w.length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return bestScore >= 4 ? best : null;
}

function extractSaveContent(text: string): string {
  const t = text.trim();
  if (t.startsWith('/save')) {
    const rest = t.slice(5).trim().replace(/\s@[\w-]+$/, '');
    return rest;
  }
  const kw = keywordIntent(t);
  if (kw?.action === 'remember') return kw.content;
  return stripLeadingVerb(t);
}

function detectMemoryVoice(content: string): MemoryVoice | null {
  const c = content.trim();
  if (c.length < 6) return null;
  for (const { voice, re } of MEMORY_VOICE_RE) {
    if (re.test(c)) return voice;
  }
  return 'fact';
}

function detectTemporalAnchor(content: string): string | null {
  const due = extractDueDateFromLine(content);
  if (due) return new Date(due.expiresAt).toLocaleDateString();
  if (/\b(as of|effective|starting|from|until|before|after)\b/i.test(content)) {
    return 'Mentions a date or time boundary — consider valid-until metadata.';
  }
  return null;
}

function detectLanguageMirror(text: string): string[] | null {
  const hasLatinExt = /[\u0100-\u024F]/.test(text);
  const hasCyrillic = /[\u0400-\u04FF]/.test(text);
  const hasCjk = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(text);
  const langs: string[] = [];
  if (hasLatinExt) langs.push('RO');
  if (hasCyrillic) langs.push('RU');
  if (hasCjk) langs.push('ZH/JA');
  if (/^[a-z\s'?,.\-!]+$/i.test(text) && text.split(/\s+/).length >= 3) langs.push('EN');
  return langs.length >= 2 ? langs : null;
}

function fuzzySkillMatches(
  skillTrainer: SkillTrainer | null | undefined,
  text: string,
): Array<{ slug: string; label: string }> {
  if (!skillTrainer) return [];
  const kw = extractSkillWalkTarget(text)?.toLowerCase() ?? '';
  const needle = kw || text.toLowerCase().slice(0, 40);
  if (needle.length < 2) return [];
  const skills = skillTrainer.listSkills();
  return skills
    .filter((s) => {
      const slug = s.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const label = s.label.toLowerCase();
      return slug.includes(needle) || label.includes(needle) || needle.includes(slug);
    })
    .slice(0, 4)
    .map((s) => ({
      slug: s.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
      label: s.label,
    }));
}

export function detectComposePrimaryIntent(text: string): {
  primaryIntent: PrimaryIntent;
  intentLabel: string;
  mcpToolHint: string | null;
  saveIntent: boolean;
  slashSave: boolean;
  slashCommand: string | null;
  selectedEngramHint: string | null;
} {
  const t = text.trim();
  const idle = {
    primaryIntent: 'idle' as const,
    intentLabel: '',
    mcpToolHint: null,
    saveIntent: false,
    slashSave: false,
    slashCommand: null,
    selectedEngramHint: null,
  };
  if (!t) return idle;

  if (t.startsWith('/')) {
    const cmd = t.slice(1).split(/\s/)[0]?.toLowerCase() ?? '';
    const slashMap: Record<string, { label: string; mcp: string }> = {
      save: { label: 'Saving to memory', mcp: 'remember' },
      recall: { label: 'Searching memory', mcp: 'recall' },
      edit: { label: 'Proposing a correction', mcp: 'edit' },
      compare: { label: 'Comparing sources', mcp: 'compare_sources' },
      create: { label: 'Creating engram', mcp: 'list_engrams' },
      train: { label: 'Training skill', mcp: 'train_skill' },
      preview: { label: 'Previewing skill', mcp: 'walk_skill_structured' },
      forget: { label: 'Memory management', mcp: 'forget' },
      insights: { label: 'Foresight insights', mcp: 'insights' },
    };
    const meta = slashMap[cmd];
    if (cmd === 'save') {
      const rest = t.slice(1 + cmd.length);
      return {
        primaryIntent: 'slash',
        intentLabel: meta?.label ?? 'Slash command',
        mcpToolHint: meta?.mcp ?? null,
        saveIntent: rest.trim().length >= 1 || /\s$/.test(rest),
        slashSave: true,
        slashCommand: cmd,
        selectedEngramHint: parseEngramHintFromText(rest),
      };
    }
    if (meta) {
      return {
        primaryIntent: cmd === 'compare' || cmd === 'insights' ? 'foresight' : cmd === 'train' || cmd === 'preview' ? 'skill' : 'slash',
        intentLabel: meta.label,
        mcpToolHint: meta.mcp,
        saveIntent: false,
        slashSave: false,
        slashCommand: cmd,
        selectedEngramHint: null,
      };
    }
    return { ...idle, primaryIntent: 'slash', intentLabel: 'Slash command', slashCommand: cmd };
  }

  if (detectWantsConsistencyWalk(t)) {
    return {
      primaryIntent: 'foresight',
      intentLabel: 'Memory integrity walk',
      mcpToolHint: 'contradiction_pairs',
      saveIntent: false,
      slashSave: false,
      slashCommand: null,
      selectedEngramHint: null,
    };
  }

  const edit = parseEditIntent(t);
  if (edit) {
    return {
      primaryIntent: 'edit',
      intentLabel: 'Correcting memory',
      mcpToolHint: 'edit',
      saveIntent: false,
      slashSave: false,
      slashCommand: null,
      selectedEngramHint: edit.engram,
    };
  }

  const skillKw = extractSkillWalkTarget(t);
  if (skillKw) {
    return {
      primaryIntent: 'skill',
      intentLabel: 'Running a skill',
      mcpToolHint: 'walk_skill_structured',
      saveIntent: false,
      slashSave: false,
      slashCommand: null,
      selectedEngramHint: null,
    };
  }

  const recall = questionIntent(t);
  if (recall?.action === 'recall') {
    return {
      primaryIntent: 'recall',
      intentLabel: 'Searching memory',
      mcpToolHint: 'recall',
      saveIntent: false,
      slashSave: false,
      slashCommand: null,
      selectedEngramHint: null,
    };
  }

  if (isForgetLikeCommand(t)) {
    return {
      primaryIntent: 'slash',
      intentLabel: 'Removing from memory',
      mcpToolHint: 'forget',
      saveIntent: false,
      slashSave: false,
      slashCommand: t.trimStart().startsWith('/') ? 'forget' : null,
      selectedEngramHint: null,
    };
  }

  if (isChatSummarizeRequest(t)) {
    return {
      primaryIntent: 'recall',
      intentLabel: 'Summarizing this chat',
      mcpToolHint: null,
      saveIntent: false,
      slashSave: false,
      slashCommand: null,
      selectedEngramHint: null,
    };
  }

  const keyword = keywordIntent(t);
  const saveIntent = keyword?.action === 'remember' || hasExplicitSaveVerb(t);
  if (keyword?.action === 'create_engram') {
    return {
      primaryIntent: 'create_engram',
      intentLabel: 'Creating engram',
      mcpToolHint: 'list_engrams',
      saveIntent: false,
      slashSave: false,
      slashCommand: null,
      selectedEngramHint: null,
    };
  }

  if (saveIntent) {
    const hint = resolveComposeSaveEngramHint(t, keyword);
    return {
      primaryIntent: 'save',
      intentLabel: 'Saving to memory',
      mcpToolHint: 'remember',
      saveIntent: true,
      slashSave: false,
      slashCommand: null,
      selectedEngramHint: hint,
    };
  }

  return idle;
}

async function checkDuplicateWarning(
  host: GraphnosisHost,
  content: string,
  engramHint: string | null,
): Promise<GhampusComposeAssist['duplicateWarning']> {
  if (content.trim().length < 24) return null;
  let graphIds = host.listGraphs();
  if (engramHint) {
    const resolved = resolveEngramFromUserHint(engramHint, listAllEngrams(host).map((e) => ({
      graphId: e.graphId,
      displayName: e.displayName,
      tier: e.tier,
    })));
    if (resolved) graphIds = [resolved.graphId];
  }
  for (const graphId of graphIds.slice(0, 4)) {
    const results = await host.searchNodes(
      graphId,
      content.slice(0, 500),
      2,
    ) as Array<{ nodeId: string; score: number; contentPreview?: string }>;
    const hit = results.find((r) => r.score >= 0.85);
    if (hit) {
      const nodes = host.listNodes(graphId) as Array<{ id: string; contentPreview?: string }>;
      const preview = nodes.find((n) => n.id === hit.nodeId)?.contentPreview
        ?? hit.contentPreview
        ?? '';
      return {
        graphId,
        engramName: host.getGraphMetadata(graphId)?.displayName ?? graphId,
        snippet: preview.slice(0, 140),
        score: hit.score,
      };
    }
  }
  return null;
}

async function recallPrefetch(
  host: GraphnosisHost,
  query: string,
): Promise<GhampusComposeAssist['recallPrefetch']> {
  const q = query.trim();
  if (q.length < 8) return null;
  let total = 0;
  let topSnippet: string | null = null;
  for (const graphId of host.listGraphs().slice(0, 5)) {
    const hits = await host.searchNodes(graphId, q.slice(0, 200), 3) as Array<{
      score: number;
      contentPreview?: string;
      nodeId: string;
    }>;
    for (const h of hits) {
      if (h.score < 0.35) continue;
      total += 1;
      if (!topSnippet) {
        const nodes = host.listNodes(graphId) as Array<{ id: string; contentPreview?: string }>;
        topSnippet = (nodes.find((n) => n.id === h.nodeId)?.contentPreview ?? h.contentPreview ?? '').slice(0, 120);
      }
    }
  }
  return total > 0 ? { matchCount: total, topSnippet } : null;
}

function filterSourceMentions(host: GraphnosisHost, query: string): GhampusComposeAssist['sourceMentions'] {
  const q = query.toLowerCase().trim();
  if (q.length < 1) return [];
  const out: GhampusComposeAssist['sourceMentions'] = [];
  for (const graphId of host.listGraphs()) {
    for (const s of host.listSources(graphId)) {
      const label = s.ref || s.sourceId;
      if (label.toLowerCase().includes(q)) {
        out.push({ sourceId: s.sourceId, label: label.slice(0, 60), graphId });
        if (out.length >= 8) return out;
      }
    }
  }
  return out;
}

export async function buildGhampusComposeAssist(
  deps: {
    host: GraphnosisHost;
    brainEngine?: BrainEngine | null;
    skillTrainer?: SkillTrainer | null;
    proFeatures?: boolean;
  },
  text: string,
  ctx: GhampusComposeAssistContext = {},
  opts?: {
    intentOverride?: ComposeIntentFields;
    intentSource?: 'heuristic' | 'llm';
    llmConfidence?: number | null;
  },
): Promise<GhampusComposeAssist> {
  const intent = opts?.intentOverride ?? detectComposePrimaryIntent(text);
  const allEngrams = listAllEngrams(deps.host);
  const engramEntries = allEngrams.map((e) => ({
    graphId: e.graphId,
    displayName: e.displayName,
    tier: e.tier,
  }));

  let selectedEngramHint = intent.selectedEngramHint;
  if (selectedEngramHint && intent.saveIntent) {
    selectedEngramHint = refinePartialEngramHint(selectedEngramHint, engramEntries);
  }

  if (ctx.pinnedEngramGraphId && intent.saveIntent && allEngrams.some((e) => e.graphId === ctx.pinnedEngramGraphId)) {
    const explicitHint = resolveComposeSaveEngramHint(text, keywordIntent(text));
    const explicitRefined = explicitHint ? refinePartialEngramHint(explicitHint, engramEntries) : null;
    const explicitResolved = explicitRefined
      ? resolveEngramFromUserHint(explicitRefined, engramEntries)
      : null;
    if (!explicitResolved || explicitResolved.graphId === ctx.pinnedEngramGraphId) {
      selectedEngramHint = ctx.pinnedEngramGraphId;
    }
  }

  const resolvedSelected = resolveSelectedEngramFromHint(selectedEngramHint, allEngrams);
  const selectedEngramId = resolvedSelected?.graphId ?? null;
  const chipEngramIds = buildChipEngramIds(deps.host, allEngrams, selectedEngramId);
  const saveContent = intent.saveIntent ? extractSaveContent(text) : '';
  const createEngramOffer = buildCreateEngramOffer(
    selectedEngramHint,
    resolvedSelected,
    intent.saveIntent,
  );
  const suggested = intent.saveIntent && !selectedEngramId && !createEngramOffer
    ? suggestEngramForText(deps.host, saveContent || text, allEngrams)
    : null;

  let duplicateWarning: GhampusComposeAssist['duplicateWarning'] = null;
  if (intent.saveIntent && saveContent.length >= 24) {
    duplicateWarning = await checkDuplicateWarning(deps.host, saveContent, intent.selectedEngramHint);
  }

  const attention = deps.brainEngine?.getAttentionCounts() ?? { duplicates: 0, contradictions: 0, total: 0 };
  const contradictionWarning = intent.saveIntent && attention.contradictions > 0
    ? { count: attention.contradictions }
    : null;

  const obligation = intent.saveIntent ? extractDueDateFromLine(saveContent || text) : null;
  const obligationHint = obligation
    ? {
        obligationType: 'deadline',
        expiresAt: obligation.expiresAt,
        label: new Date(obligation.expiresAt).toLocaleDateString(),
      }
    : null;

  const languageMirror = intent.primaryIntent === 'recall' ? detectLanguageMirror(text) : null;

  let vagueReference: GhampusComposeAssist['vagueReference'] = null;
  if (intent.saveIntent && isVagueRememberContent(saveContent) && ctx.lastGhampusSnippet) {
    vagueReference = {
      pronoun: saveContent.trim(),
      suggestedSnippet: ctx.lastGhampusSnippet.slice(0, 160),
    };
  }

  let consentGate: GhampusComposeAssist['consentGate'] = null;
  if (intent.selectedEngramHint) {
    const resolved = resolveEngramFromUserHint(intent.selectedEngramHint, allEngrams.map((e) => ({
      graphId: e.graphId,
      displayName: e.displayName,
      tier: e.tier,
    })));
    if (resolved && (resolved.tier ?? 'personal') !== 'personal') {
      consentGate = {
        tier: resolved.tier ?? 'sensitive',
        engramId: resolved.graphId,
        displayName: resolved.displayName,
      };
    }
  }

  const skillMatches = fuzzySkillMatches(deps.skillTrainer, text);

  let foresightHint: GhampusComposeAssist['foresightHint'] = null;
  if (intent.primaryIntent === 'foresight' || /\bcompare\b/i.test(text)) {
    foresightHint = {
      kind: detectWantsConsistencyWalk(text) ? 'integrity' : 'compare',
      label: detectWantsConsistencyWalk(text) ? 'Consistency audit' : 'Compare sources',
      proRequired: !deps.proFeatures,
    };
  } else if (detectWantsCrossEngramSearch(text)) {
    foresightHint = {
      kind: 'cross_engram',
      label: 'Cross-engram search',
      proRequired: !deps.proFeatures,
    };
  }

  let recallPrefetchResult: GhampusComposeAssist['recallPrefetch'] = null;
  if (intent.primaryIntent === 'recall' && text.trim().length >= 10) {
    recallPrefetchResult = await recallPrefetch(deps.host, text);
  }

  const atQuery = text.match(/@([\w\s.-]{0,40})$/);
  const sourceMentions = atQuery?.[1] != null
    ? filterSourceMentions(deps.host, atQuery[1])
    : [];

  let crossEngramSuggestion: ComposeEngramOption | null = null;
  if (intent.saveIntent && suggested && intent.selectedEngramHint) {
    const primary = resolveEngramFromUserHint(intent.selectedEngramHint, allEngrams.map((e) => ({
      graphId: e.graphId,
      displayName: e.displayName,
      tier: e.tier,
    })));
    if (primary && suggested.graphId !== primary.graphId) {
      crossEngramSuggestion = suggested;
    }
  }

  let vitalityNudge: GhampusComposeAssist['vitalityNudge'] = null;
  const targetId = intent.selectedEngramHint
    ? resolveEngramFromUserHint(intent.selectedEngramHint, allEngrams.map((e) => ({
      graphId: e.graphId,
      displayName: e.displayName,
      tier: e.tier,
    })))?.graphId
    : chipEngramIds[0];
  if (intent.saveIntent && targetId) {
    const nodes = deps.host.listNodes(targetId);
    if (nodes.length === 0) {
      const meta = allEngrams.find((e) => e.graphId === targetId);
      vitalityNudge = {
        engramId: targetId,
        displayName: meta?.displayName ?? targetId,
        message: 'This engram is empty — good place for a seed note.',
      };
    }
  }

  let awayDigest: GhampusComposeAssist['awayDigest'] = null;
  if ((ctx.hoursSinceActive ?? 0) >= 4 && deps.brainEngine) {
    awayDigest = {
      corrections: 0,
      contradictions: attention.contradictions,
      duplicates: attention.duplicates,
    };
  }

  const selectionBridge = intent.saveIntent && ctx.selectedText && ctx.selectedText.length >= 2
    ? { quotedText: ctx.selectedText.slice(0, 120), action: 'save' as const }
    : null;

  return {
    ...intent,
    selectedEngramId,
    chipEngramIds,
    engrams: allEngrams,
    suggestedEngram: suggested,
    createEngramOffer,
    duplicateWarning,
    contradictionWarning,
    obligationHint,
    languageMirror,
    vagueReference,
    consentGate,
    skillMatches,
    foresightHint,
    recallPrefetch: recallPrefetchResult,
    threadSummaryOffer: (ctx.threadTurnCount ?? 0) >= 8,
    sourceMentions,
    memoryVoice: intent.saveIntent ? detectMemoryVoice(saveContent) : null,
    temporalAnchor: intent.saveIntent ? detectTemporalAnchor(saveContent || text) : null,
    crossEngramSuggestion,
    vitalityNudge,
    awayDigest,
    selectionBridge,
    intentSource: opts?.intentSource ?? 'heuristic',
    llmConfidence: opts?.llmConfidence ?? null,
  };
}

/** Back-compat slim payload for callers that only need save/engram hints. */
export function detectGhampusInputAssist(text: string): Pick<
  GhampusComposeAssist,
  'saveIntent' | 'slashSave' | 'selectedEngramHint'
> {
  const intent = detectComposePrimaryIntent(text);
  return {
    saveIntent: intent.saveIntent,
    slashSave: intent.slashSave,
    selectedEngramHint: intent.selectedEngramHint,
  };
}
