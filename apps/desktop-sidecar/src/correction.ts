import { z } from 'zod';
import type { GraphnosisHost } from './host.js';
import type { CorrectionEdit, AppendDocumentInput } from './graphnosis-adapter.js';

// Correction = natural-language graph edit, processed by a bundled local LLM.
// Pipeline: query candidates -> ask local LLM for a structured diff -> preview to user -> apply.
//
// We mirror the @nehloo/graphnosis correction model: edits are content+reason only,
// deletes are soft, and `supersede` keeps audit lineage (preferred when the user is
// correcting rather than just tweaking).

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

export async function proposeCorrection(opts: {
  host: GraphnosisHost;
  llm: LocalLlm;
  correction: string;
  graphIdHint?: string;
  candidateK?: number;
}): Promise<{ diff: CorrectionDiff; candidates: { graphId: string; nodeId: string; text: string }[] }> {
  const subgraph = await opts.host.recall(opts.correction, {
    budget: { maxTokens: 1500, maxNodes: opts.candidateK ?? 8 },
  });
  const candidates: { graphId: string; nodeId: string; text: string }[] = [];
  for (const [graphId, items] of subgraph.byGraph) {
    for (const c of items) candidates.push({ graphId, nodeId: c.nodeId, text: c.text });
  }
  if (candidates.length === 0) {
    return { diff: { edits: [], adds: [] }, candidates };
  }

  const user = [
    `Correction: ${opts.correction}`,
    '',
    'Candidate nodes:',
    ...candidates.map(c => `- [${c.nodeId}] (graph: ${c.graphId}) ${c.text}`),
  ].join('\n');

  const raw = await opts.llm.complete({ system: SYSTEM_PROMPT, user });
  const diff = DiffSchema.parse(extractJson(raw));
  return { diff, candidates };
}

export async function applyCorrection(opts: {
  host: GraphnosisHost;
  graphId: string;
  diff: CorrectionDiff;
}): Promise<void> {
  const adds: AppendDocumentInput[] = (opts.diff.adds ?? []).map(a => ({
    kind: 'markdown' as const,
    content: a.text,
    sourceRef: a.label ?? `correction:${Date.now()}`,
  }));
  const edits: CorrectionEdit[] = opts.diff.edits;
  await opts.host.applyCorrection(opts.graphId, { adds, edits });
}

function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Local LLM did not return JSON');
  return JSON.parse(raw.slice(start, end + 1));
}
