import { z } from 'zod';
import type { GraphnosisHost } from './host.js';
import type { CorrectionEdit, AppendDocumentInput } from './graphnosis-adapter.js';

// Correction = natural-language graph edit. Two paths, picked automatically by
// whether the user has enabled the optional Local LLM:
//
//   • Deterministic (default, no LLM) — recall the single closest-matching
//     memory and `supersede` it with the correction text (or `add` the
//     correction as a new memory when nothing matches). Reproducible: recall
//     is deterministic, "pick the top hit" is deterministic, and `supersede`
//     preserves audit lineage. Works for every user, offline, with no model.
//
//   • LLM-assisted (Local LLM enabled) — the LLM parses the correction into a
//     multi-part structured diff across several candidate nodes (edit /
//     supersede / delete / add). More capable, but non-deterministic: the
//     proposed diff can vary between runs.
//
// Either way the diff is only a PREVIEW — nothing is written until the user
// reviews and approves it. We mirror the @nehloo/graphnosis correction model:
// edits are content+reason only, deletes are soft, and `supersede` keeps audit
// lineage (preferred when the user is correcting rather than just tweaking).

// All string fields here are intentionally LENIENT on input — small local
// LLMs (Llama 3.2 3B, Phi-3, etc.) treat "no value" inconsistently: they
// omit the key sometimes (which Zod's .optional() handles), they emit JSON
// null sometimes (which .optional() rejects), and occasionally they emit
// empty string. Rejecting the entire diff over any of these throws away an
// otherwise-valid proposal and surfaces as a confusing Zod error banner.
//
// Pattern: a preprocess step coerces `null` → `undefined` before the
// schema sees it, so a downstream .optional() / .default() reads cleanly
// and the OUTPUT type stays as the consumer wants it (truly optional, or
// always present, but never the awkward "required-but-can-be-undefined"
// that wrecks the inferred type for callers like
// `{ edits: [], adds: [] }`).
const FALLBACK_REASON = 'No reason provided by LLM — added automatically.';
/** Field that may be null/undefined/missing → always-present string in output (with default). */
const lenientStringWithDefault = (defaultVal: string) =>
  z.preprocess((v) => (v === null ? undefined : v), z.string().default(defaultVal));
/** Field that may be null/undefined/missing → optional string in output. */
const lenientOptionalString = () =>
  z.preprocess((v) => (v === null ? undefined : v), z.string().optional());

const EditOp = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'),      nodeId: z.string(), content: z.string(), reason: lenientStringWithDefault(FALLBACK_REASON) }),
  z.object({ kind: z.literal('supersede'), nodeId: z.string(), content: z.string(), reason: lenientStringWithDefault(FALLBACK_REASON) }),
  z.object({ kind: z.literal('delete'),    nodeId: z.string(),                       reason: lenientStringWithDefault(FALLBACK_REASON) }),
]);

const AddOp = z.object({
  text: z.string(),
  /** Optional label shown in the inspector; becomes the source ref. */
  label: lenientOptionalString(),
});

const DiffSchema = z.object({
  // Top-level LLM reasoning — same null/undefined/missing tolerance, but
  // stays truly optional in the output type so consumers can omit it.
  reasoning: lenientOptionalString(),
  edits: z.array(EditOp).default([]),
  adds: z.array(AddOp).default([]),
});
export type CorrectionDiff = z.infer<typeof DiffSchema>;

export type LlmCompleteInput = {
  system: string;
  user: string;
  /** When set, the implementation enables its constrained-JSON mode (Ollama
   *  `format:'json'`) so the model can only emit a valid JSON object — no code
   *  fences, no trailing prose. The value may be a real JSON Schema for
   *  backends that support structured outputs. */
  jsonSchema?: unknown;
  /** Explicit override — rare; normally preset comes from settings. */
  temperature?: number;
  /** Hard cap on generated tokens (Ollama `num_predict`). Sized to fit the
   *  full expected object so the JSON isn't truncated mid-value. */
  maxTokens?: number;
  /** When aborted (e.g. work-priority preemption), implementations must cancel in-flight HTTP. */
  signal?: AbortSignal;
};

/** JSON Schema for the correction diff — passed to the local model to enable
 *  constrained-JSON output (the root fix for "malformed JSON": without it the
 *  model runs free-form and wraps the object in ```json fences / trailing
 *  prose that small models often mangle). */
const DIFF_JSON_SCHEMA = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['edit', 'supersede', 'delete'] },
          nodeId: { type: 'string' },
          content: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['kind', 'nodeId'],
      },
    },
    adds: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, label: { type: 'string' } },
        required: ['text'],
      },
    },
    reasoning: { type: 'string' },
  },
  required: ['edits', 'adds'],
} as const;

export interface LocalLlm {
  /** Single-shot completion. Implementations: llama.cpp server, Ollama, MLX, etc. */
  complete(input: LlmCompleteInput): Promise<string>;
  /**
   * Streaming completion. Same prompt as `complete()`; `onChunk` is
   * invoked with each new piece of text as the LLM emits it. Resolves
   * with the full final string after the stream ends. Optional —
   * implementations without streaming support should set this to
   * undefined; callers fall back to `complete()`.
   */
  completeStream?: (
    input: LlmCompleteInput,
    onChunk: (chunk: string) => void,
  ) => Promise<string>;
  /** Human-readable identifier shown in the LLM picker UI. */
  name: string;
}

/** Max recall-ranked candidates kept for edit targeting (LLM + deterministic). */
const CORRECTION_CANDIDATE_POOL = 6;
/** Max candidates shown to the local LLM in the edit prompt (smaller context → less scope creep). */
const LLM_CANDIDATE_LIMIT = 4;
/** Max edit ops after scope guardrails when the correction implies multiple targets. */
const MAX_LLM_EDITS_MULTI = 2;
/** Default max edit ops — most corrections target a single assertion. */
const MAX_LLM_EDITS_SINGLE = 1;

const SYSTEM_PROMPT = `You edit a personal knowledge graph on the user's behalf.
You will be given:
  1. A user correction in natural language.
  2. A small list of candidate nodes (best match first).

Return a JSON object with this exact shape. Emit "edits" and "adds" FIRST; keep "reasoning" last and to one short sentence:
{
  "edits": [
    { "kind": "edit",      "nodeId": "...", "content": "...", "reason": "..." } |
    { "kind": "supersede", "nodeId": "...", "content": "...", "reason": "..." } |
    { "kind": "delete",    "nodeId": "...", "reason": "..." }
  ],
  "adds": [ { "text": "...", "label": "..." } ],
  "reasoning": "one short sentence (optional)"
}

Rules:
  - DEFAULT: change ONLY the single best-matching candidate (the first listed). Do not touch other candidates unless the correction explicitly names them or says "all", "both", "every", or lists multiple distinct fixes.
  - Prefer "supersede" over "edit" when the user is correcting factual content — supersede preserves audit lineage.
  - Use "edit" only for trivial fixes (typos, formatting) on that one node.
  - Use "delete" ONLY when the user explicitly asked to remove, delete, or forget a memory.
  - Use "adds" only when the correction adds new information that does not replace an existing node.
  - Never invent nodeIds; use only IDs from the candidate list.
  - If unsure which node to change, return an empty diff rather than guessing or editing several nodes.
  - Output JSON only, no prose.`;

/** User correction text signals they intend to fix more than one memory. */
export function correctionImpliesMultiNodeEdit(correction: string): boolean {
  const c = correction.toLowerCase();
  if (/\b(all|both|every|each|multiple|several)\s+(of\s+)?(the\s+)?(memories|notes|entries|nodes|facts|records)\b/.test(c)) return true;
  if (/\b(all|both|every)\b/.test(c) && /\b(and|also|,)\b/.test(c)) return true;
  if (/\b(and also|as well as)\b/.test(c)) return true;
  if (/\b(1\.|2\.|first|second)\b/.test(c) && /\b(and|also)\b/.test(c)) return true;
  return false;
}

/** User correction text signals they want content removed, not superseded. */
export function correctionImpliesDelete(correction: string): boolean {
  const c = correction.toLowerCase();
  return /\b(delete|remove|forget|drop|discard|erase|purge)\b/.test(c);
}

/** Levenshtein distance, early-exiting once it provably exceeds `max`. */
function boundedEditDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Resolve an LLM-returned nodeId to a REAL candidate id. Exact match wins;
 * otherwise the single candidate within a small edit distance is used. Small
 * local models transpose/typo opaque ids (e.g. "qpqR…" for "qqpR…") — an
 * exact-only check dropped the correct target AND (worse) let the caller fall
 * back to superseding an unrelated node. Ambiguous (two candidates equally
 * close) or no-close-match → null, so the caller drops the edit rather than
 * guessing. Random 20+ char ids make a false fuzzy match astronomically
 * unlikely, so this recovers typos without risking a wrong target.
 */
export function resolveCandidateNodeId(nodeId: string, candidateIds: readonly string[]): string | null {
  if (candidateIds.includes(nodeId)) return nodeId;
  const MAX = 2;
  let best: string | null = null;
  let bestDist = MAX + 1;
  let tie = false;
  for (const cid of candidateIds) {
    const d = boundedEditDistance(nodeId, cid, MAX);
    if (d <= MAX) {
      if (d < bestDist) { bestDist = d; best = cid; tie = false; }
      else if (d === bestDist) tie = true;
    }
  }
  return best && !tie ? best : null;
}

/**
 * Post-process a local-LLM edit proposal so it cannot silently rewrite unrelated
 * memories. Resolves near-miss nodeIds to a candidate, drops truly out-of-pool
 * ids, caps edit count, and strips deletes unless the user asked for removal.
 */
export function scopeLlmCorrectionDiff(
  diff: CorrectionDiff,
  candidates: CorrectionCandidate[],
  correction: string,
): { diff: CorrectionDiff; scopeWarnings: string[] } {
  const warnings: string[] = [];
  const candidateIdList = candidates.map((c) => c.nodeId);
  const primaryNodeId = candidates[0]?.nodeId;
  const multiAllowed = correctionImpliesMultiNodeEdit(correction);
  const deleteAllowed = correctionImpliesDelete(correction);
  const maxEdits = multiAllowed ? MAX_LLM_EDITS_MULTI : MAX_LLM_EDITS_SINGLE;
  const maxAdds = multiAllowed ? 2 : 1;

  const validEdits: CorrectionDiff['edits'] = [];
  for (const rawEdit of diff.edits ?? []) {
    // Strip stray surrounding brackets/quotes the model may echo, then resolve
    // to a real candidate id — tolerating the transpositions/typos small local
    // models make on opaque ids ("qpqR…" → "qqpR…"). null = no confident match.
    const stripped = rawEdit.nodeId.trim().replace(/^[["'\s]+|[\]"'\s]+$/g, '');
    const nodeId = resolveCandidateNodeId(stripped, candidateIdList);
    if (!nodeId) {
      warnings.push(`Dropped edit on ${stripped}: node was not in the candidate pool.`);
      continue;
    }
    const edit = { ...rawEdit, nodeId };
    if (edit.kind === 'delete' && !deleteAllowed) {
      warnings.push(`Dropped delete on ${nodeId}: correction did not request removal.`);
      continue;
    }
    if (!multiAllowed && primaryNodeId && nodeId !== primaryNodeId) {
      warnings.push(`Dropped edit on ${nodeId}: scoped to top recall match only.`);
      continue;
    }
    if (validEdits.length >= maxEdits) {
      warnings.push(`Dropped edit on ${nodeId}: capped at ${maxEdits} operation(s).`);
      continue;
    }
    validEdits.push(edit);
  }

  const rawAdds = diff.adds ?? [];
  const validAdds = rawAdds.slice(0, maxAdds);
  if (rawAdds.length > maxAdds) {
    warnings.push(`Trimmed adds from ${rawAdds.length} to ${maxAdds}.`);
  }

  const scopeNote = warnings.length > 0
    ? `Scope guardrails applied: ${warnings.join(' ')}`
    : undefined;
  const reasoning = [diff.reasoning, scopeNote].filter(Boolean).join('\n\n') || undefined;

  return {
    diff: { reasoning, edits: validEdits, adds: validAdds },
    scopeWarnings: warnings,
  };
}

/** A memory the correction might target. `viaGnn` marks ones the Graphnosis
 *  Neural Network surfaced as predicted-related, rather than direct recall. */
export interface CorrectionCandidate {
  graphId: string;
  nodeId: string;
  text: string;
  /** true when the Neural Network surfaced this memory (not direct recall). */
  viaGnn: boolean;
}

/** Expands the recall candidate set with GNN-predicted neighbours. The caller
 *  supplies this only when the user has enabled the Neural Network — without
 *  it, `correct` runs purely on deterministic recall. */
export type GnnCandidateExpander = (
  recallCandidates: ReadonlyArray<{ graphId: string; nodeId: string; text: string }>,
) => Promise<Array<{
  graphId: string;
  nodeId: string;
  text: string;
  /** The model's predicted probability for the edge that surfaced this node, 0–1. */
  gnnScore: number;
}>>;

/** Which path produced a correction diff. `deterministic` — pure recall, no
 *  model; `gnn-expanded` — the Neural Network widened/re-ranked the candidate
 *  set (non-deterministic); `llm-assisted` — the Local LLM authored the diff. */
export type CorrectionMode = 'deterministic' | 'gnn-expanded' | 'llm-assisted';

/**
 * No-LLM correction. Given a candidate pool already ordered best-first,
 * produce a diff that supersedes the single closest match with the correction
 * text. When nothing matches, the correction is recorded as a new memory.
 *
 * With the Neural Network off the pool is plain recall order, so this is fully
 * reproducible — identical inputs yield an identical diff. With it on, the
 * pool may have been GNN-expanded and re-ranked upstream (`gnnExpanded`).
 *
 * `supersede` (not `edit`) is deliberate: the original memory is kept for
 * audit lineage, consistent with Graphnosis' indelibility guarantee — a
 * correction never destroys the prior memory, it just demotes it.
 */
export function proposeDeterministicCorrection(opts: {
  correction: string;
  /** Candidate pool, already ordered best-first. */
  candidates: CorrectionCandidate[];
  /** When set, only a memory inside this engram is eligible to supersede. */
  graphIdHint?: string;
  /** true when the Neural Network expanded/re-ranked the candidate pool. */
  gnnExpanded?: boolean;
}): { diff: CorrectionDiff; targetGraphId: string | null } {
  // When the caller named an engram, only supersede a memory that actually
  // lives in it — so the correction lands where they asked.
  const pool = opts.graphIdHint
    ? opts.candidates.filter(c => c.graphId === opts.graphIdHint)
    : opts.candidates;
  const top = pool[0];
  const label = opts.gnnExpanded
    ? 'Correction (Neural-Network-expanded candidates, no Local LLM)'
    : 'Deterministic correction (no Local LLM)';
  if (!top) {
    return {
      diff: {
        reasoning: `${label}: no existing memory matched, so the correction is recorded as a new memory.`,
        edits: [],
        adds: [{ text: opts.correction }],
      },
      targetGraphId: opts.graphIdHint ?? opts.candidates[0]?.graphId ?? null,
    };
  }
  const via = top.viaGnn ? ', surfaced by the Neural Network' : '';
  return {
    diff: {
      reasoning:
        `${label}: superseding the closest-matching memory (${top.nodeId}${via}) ` +
        'with your correction. The original is preserved for audit lineage. If this ' +
        'is not the memory you meant, decline it and rephrase — or enable the Local ' +
        'LLM for multi-memory corrections.',
      edits: [{
        kind: 'supersede',
        nodeId: top.nodeId,
        content: opts.correction,
        reason: 'User correction (deterministic supersede).',
      }],
      adds: [],
    },
    targetGraphId: top.graphId,
  };
}

export async function proposeCorrection(opts: {
  host: GraphnosisHost;
  /** Local LLM when the user has enabled it. When null/absent, the no-LLM
   *  supersede path is used instead — `correct` always works, with or without
   *  a model. */
  llm?: LocalLlm | null;
  correction: string;
  graphIdHint?: string;
  candidateK?: number;
  /** Supplied only when the Neural Network is enabled — expands the candidate
   *  set with GNN-predicted neighbours of the recall hits. */
  expandWithGnn?: GnnCandidateExpander;
}): Promise<{
  diff: CorrectionDiff;
  candidates: CorrectionCandidate[];
  /** Which path produced the diff. */
  mode: CorrectionMode;
  /** Engram the diff targets, when the path could determine one. */
  targetGraphId?: string | null;
}> {
  // When the caller named a target engram, scope candidate recall to that
  // engram only. Without this, cross-engram nodes out-rank the target and
  // the correction either lands in the wrong engram or misses entirely.
  const subgraph = await opts.host.recall(opts.correction, {
    budget: { maxTokens: 1200, maxNodes: opts.candidateK ?? 5 },
    ...(opts.graphIdHint ? { onlyGraphIds: [opts.graphIdHint] } : {}),
  });
  const recallCandidates: { graphId: string; nodeId: string; text: string }[] = [];
  for (const [graphId, items] of subgraph.byGraph) {
    for (const c of items) recallCandidates.push({ graphId, nodeId: c.nodeId, text: c.text });
  }

  // Score recall hits by rank — rank 0 (the best lexical/semantic match) = 1.0.
  const scored: Array<CorrectionCandidate & { score: number }> = recallCandidates.map((c, i) => ({
    ...c, viaGnn: false, score: 1 / (1 + i),
  }));

  // Neural-Network expansion — only when the user enabled it (expander given).
  // A highly-confident GNN prediction (gnnScore ≳0.91) outscores even the top
  // recall hit and can become the supersede target; weaker ones just enrich
  // the set below it. This makes `correct` genuinely GNN-influenced — and
  // therefore non-deterministic — whenever the Neural Network is on.
  let gnnExpanded = false;
  if (opts.expandWithGnn) {
    const extras = await opts.expandWithGnn(recallCandidates);
    if (extras.length > 0) {
      gnnExpanded = true;
      for (const ex of extras) {
        scored.push({
          graphId: ex.graphId, nodeId: ex.nodeId, text: ex.text,
          viaGnn: true, score: 1.1 * ex.gnnScore,
        });
      }
    }
  }
  // Best-first. With the Neural Network off this is exactly the recall order,
  // so the no-LLM path stays fully deterministic.
  scored.sort((a, b) => b.score - a.score);
  const candidates: CorrectionCandidate[] = scored.slice(0, CORRECTION_CANDIDATE_POOL).map(c => ({
    graphId: c.graphId, nodeId: c.nodeId, text: c.text, viaGnn: c.viaGnn,
  }));

  // No-LLM path — deterministic, or gnn-expanded when the Neural Network is on.
  if (!opts.llm) {
    const det = proposeDeterministicCorrection({
      correction: opts.correction,
      candidates,
      gnnExpanded,
      ...(opts.graphIdHint !== undefined ? { graphIdHint: opts.graphIdHint } : {}),
    });
    return {
      diff: det.diff,
      candidates,
      mode: gnnExpanded ? 'gnn-expanded' : 'deterministic',
      targetGraphId: det.targetGraphId,
    };
  }

  // LLM-assisted path — non-deterministic. The model interprets the correction
  // across a small candidate shortlist; scope guardrails cap blast radius.
  if (candidates.length === 0) {
    return { diff: { edits: [], adds: [] }, candidates, mode: 'llm-assisted' };
  }

  const candidatesForLlm = candidates.slice(0, LLM_CANDIDATE_LIMIT);
  const user = [
    `Correction: ${opts.correction}`,
    '',
    'Candidate nodes (best match first — edit ONLY the first unless the correction explicitly targets more).',
    'Copy the nodeId value AS-IS (the token after "nodeId=") — do NOT add brackets or quotes around it:',
    // NOTE: the nodeId is presented as `nodeId=<id>`, NOT `[<id>]`. Wrapping it
    // in square brackets made small models echo the brackets into the output
    // ("nodeId":"[abc]"), which then failed the exact-match candidate check in
    // scopeLlmCorrectionDiff and silently dropped every edit.
    ...candidatesForLlm.map(c =>
      `- nodeId=${c.nodeId} (graph: ${c.graphId})${c.viaGnn ? ' [neural-network-predicted]' : ''}: ${c.text}`),
  ].join('\n');

  // Constrained-JSON mode (jsonSchema → Ollama format:'json') so the model can
  // only emit a valid JSON object — no ```json fences or trailing prose for the
  // parser to choke on. maxTokens is sized for reasoning + edits + superseding
  // content so the object isn't truncated mid-value. Retry once with a stricter
  // instruction if the first response still won't parse; then surface a CLEAR
  // empty diff instead of a silent one.
  const complete = (extra = ''): Promise<string> => opts.llm!.complete({
    system: SYSTEM_PROMPT,
    user: extra ? `${user}\n\n${extra}` : user,
    jsonSchema: DIFF_JSON_SCHEMA,
    maxTokens: 1024,
  });
  let parsedDiff: CorrectionDiff;
  try {
    parsedDiff = DiffSchema.parse(extractJson(await complete()));
  } catch {
    try {
      parsedDiff = DiffSchema.parse(extractJson(
        await complete('Respond with ONLY the JSON object described above — no code fences, no commentary.'),
      ));
    } catch (e) {
      return {
        diff: {
          edits: [],
          adds: [],
          reasoning: `The local model did not return a usable edit (${e instanceof Error ? e.message : 'unparseable output'}). `
            + 'Try rephrasing the correction, or turn off the Local LLM in Settings to use the deterministic supersede path.',
        },
        candidates,
        mode: 'llm-assisted',
      };
    }
  }
  const scoped = scopeLlmCorrectionDiff(parsedDiff, candidatesForLlm, opts.correction);
  let diff = scoped.diff;

  const hadLlmChanges = (parsedDiff.edits?.length ?? 0) > 0 || (parsedDiff.adds?.length ?? 0) > 0;
  const strippedAll = scoped.scopeWarnings.length > 0
    && diff.edits.length === 0
    && diff.adds.length === 0
    && hadLlmChanges;
  if (strippedAll) {
    // CRITICAL: only fall back to superseding the top recall match for
    // OVER-SCOPING drops (the model tried to edit too many nodes). When EVERY
    // drop was an unmatched nodeId, the model aimed at a specific node we could
    // not resolve even fuzzily — superseding an unrelated top-recall node with
    // the raw correction text would DESTROY real data (the reported bug). Return
    // a clear empty diff instead of guessing.
    if (scoped.scopeWarnings.every((w) => /was not in the candidate pool/.test(w))) {
      return {
        diff: {
          edits: [],
          adds: [],
          reasoning: 'The local model targeted a node id that matches no recalled candidate (a mis-copied id). '
            + 'No safe edit was made — rephrase the correction to describe the memory in words, or edit the node '
            + 'directly in the app.',
        },
        candidates,
        mode: 'llm-assisted',
      };
    }
    const det = proposeDeterministicCorrection({
      correction: opts.correction,
      candidates,
      gnnExpanded,
      ...(opts.graphIdHint !== undefined ? { graphIdHint: opts.graphIdHint } : {}),
    });
    diff = {
      ...det.diff,
      reasoning: [
        diff.reasoning,
        'Local LLM proposed out-of-scope changes; fell back to superseding the top recall match only.',
      ].filter(Boolean).join('\n\n'),
    };
  }
  return { diff, candidates, mode: 'llm-assisted' };
}

export async function applyCorrection(opts: {
  host: GraphnosisHost;
  graphId: string;
  diff: CorrectionDiff;
  /** MCP client name when this correction was driven by an AI client
   *  (e.g. "claude-ai"). Surfaced as `correctedBy` on every op-log event
   *  the underlying host.applyCorrection emits. Undefined when the user
   *  applied the correction directly via the App UI. */
  correctedBy?: string;
  /** The user-facing correction text that was passed to the `correct` tool. */
  prompt?: string;
  /** Resolution mode from proposeCorrection. */
  mode?: 'deterministic' | 'gnn-expanded' | 'llm-assisted';
  /** Who/what initiated this correction — threads into the op-log `triggeredBy` field. */
  triggeredBy?: string;
}): Promise<void> {
  const adds: AppendDocumentInput[] = (opts.diff.adds ?? []).map(a => ({
    kind: 'markdown' as const,
    content: a.text,
    sourceRef: a.label ?? `correction:${Date.now()}`,
  }));
  const edits: CorrectionEdit[] = opts.diff.edits;
  await opts.host.applyCorrection(
    opts.graphId,
    { adds, edits },
    {
      ...(opts.correctedBy ? { correctedBy: opts.correctedBy } : {}),
      ...(opts.triggeredBy ? { triggeredBy: opts.triggeredBy } : {}),
    },
  );
  const ts = Date.now();
  const gllBase = {
    timestamp: ts,
    graphId: opts.graphId,
    originatingTool: 'apply' as const,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.correctedBy ? { clientName: opts.correctedBy } : {}),
  };
  for (const edit of edits) {
    await opts.host.gllWriter.append({
      ...gllBase,
      operation: edit.kind === 'delete' ? 'deleteNode' : edit.kind === 'supersede' ? 'supersede' : 'editNode',
      targetNodeIds: [edit.nodeId],
      after: edit.kind === 'delete' ? {} : { content: edit.content, reason: edit.reason },
    });
  }
  for (const add of adds) {
    await opts.host.gllWriter.append({
      ...gllBase,
      operation: 'addNode',
      after: { content: add.content, sourceRef: add.sourceRef },
    });
  }
}

/** Pull a JSON object out of a raw LLM completion. Small local models emit a
 *  variety of malformed shapes: bare prose + JSON, code-fenced JSON, JSON
 *  with trailing commas, JSON that stops mid-object on a token budget. We slice
 *  to the outermost braces, try plain parse, then repair the common failure
 *  modes. THROWS on unrecoverable output so the caller can retry once and then
 *  surface a clear error — rather than silently queuing an empty diff.
 *  Exported for unit tests (tests/correction-parse.test.mjs). */
export function extractJson(raw: string): unknown {
  // Slice from the FIRST `{` to the LAST `}` of the RAW output. A ```json
  // wrapper carries no braces, so this drops the fence — and, unlike a
  // non-greedy ```...``` capture, it is immune to an inner ```code``` fence
  // inside a superseding-content string (which used to truncate the object at
  // the first inner fence and fail the parse).
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1) throw new Error('model returned no JSON object');
  const candidate = end > start ? raw.slice(start, end + 1) : raw.slice(start);

  // 1. Try as-is. Most well-formed responses land here.
  try { return JSON.parse(candidate); } catch { /* fall through to repair */ }

  // 2. Repair pass — small-LLM failure modes: (a) trailing commas before
  //    `]`/`}`; (b)/(c) unbalanced braces/brackets from mid-object truncation.
  let repaired = candidate.replace(/,(\s*[}\]])/g, '$1');
  const openCurly = (repaired.match(/\{/g) ?? []).length;
  const closeCurly = (repaired.match(/\}/g) ?? []).length;
  const openSquare = (repaired.match(/\[/g) ?? []).length;
  const closeSquare = (repaired.match(/\]/g) ?? []).length;
  const missingSquare = Math.max(0, openSquare - closeSquare);
  const missingCurly = Math.max(0, openCurly - closeCurly);
  // Arrays close first (usually nested inside the object): `]` before `}`.
  repaired = repaired + ']'.repeat(missingSquare) + '}'.repeat(missingCurly);
  try { return JSON.parse(repaired); } catch { /* fall through to throw */ }

  // 3. Unrecoverable. Throw with a short preview of what the model actually
  //    sent so the caller's fallback message can show it.
  const preview = raw.slice(0, 200).replace(/\s+/g, ' ').trim();
  throw new Error(`unparseable JSON from local model — raw start: ${preview}…`);
}
