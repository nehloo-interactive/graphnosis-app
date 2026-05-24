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

const EditOp = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'),      nodeId: z.string(), content: z.string(), reason: z.string() }),
  z.object({ kind: z.literal('supersede'), nodeId: z.string(), content: z.string(), reason: z.string() }),
  z.object({ kind: z.literal('delete'),    nodeId: z.string(), reason: z.string() }),
]);

const AddOp = z.object({
  text: z.string(),
  /** Optional label shown in the inspector; becomes the source ref. */
  label: z.string().optional(),
});

const DiffSchema = z.object({
  reasoning: z.string().optional(),
  edits: z.array(EditOp).default([]),
  adds: z.array(AddOp).default([]),
});
export type CorrectionDiff = z.infer<typeof DiffSchema>;

export interface LocalLlm {
  /** Single-shot completion. Implementations: llama.cpp server, Ollama, MLX, etc. */
  complete(input: { system: string; user: string; jsonSchema?: unknown }): Promise<string>;
  /** Human-readable identifier shown in the LLM picker UI. */
  name: string;
}

const SYSTEM_PROMPT = `You edit a personal knowledge graph on the user's behalf.
You will be given:
  1. A user correction in natural language.
  2. A small list of candidate nodes that may be wrong.

Return a JSON object with this exact shape:
{
  "reasoning": string?,
  "edits": [
    { "kind": "edit",      "nodeId": "...", "content": "...", "reason": "..." } |
    { "kind": "supersede", "nodeId": "...", "content": "...", "reason": "..." } |
    { "kind": "delete",    "nodeId": "...", "reason": "..." }
  ],
  "adds": [ { "text": "...", "label": "..." } ]
}

Rules:
  - Prefer "supersede" over "edit" when the user is correcting factual content — supersede preserves audit lineage.
  - Use "edit" only for trivial fixes (typos, formatting).
  - Use "delete" when the user explicitly wants the memory removed.
  - Use "adds" when the correction adds new information rather than fixing existing nodes.
  - Never invent nodeIds; use only IDs from the candidate list.
  - If unsure, return an empty diff rather than guessing.
  - Output JSON only, no prose.`;

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
    budget: { maxTokens: 1500, maxNodes: opts.candidateK ?? 8 },
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
  const candidates: CorrectionCandidate[] = scored.slice(0, 12).map(c => ({
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
  // across every candidate (including any GNN-surfaced ones) and may propose
  // several edits at once.
  if (candidates.length === 0) {
    return { diff: { edits: [], adds: [] }, candidates, mode: 'llm-assisted' };
  }

  const user = [
    `Correction: ${opts.correction}`,
    '',
    'Candidate nodes:',
    ...candidates.map(c =>
      `- [${c.nodeId}] (graph: ${c.graphId})${c.viaGnn ? ' [neural-network-predicted]' : ''} ${c.text}`),
  ].join('\n');

  const raw = await opts.llm.complete({ system: SYSTEM_PROMPT, user });
  const diff = DiffSchema.parse(extractJson(raw));
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

function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Local LLM did not return JSON');
  return JSON.parse(raw.slice(start, end + 1));
}
