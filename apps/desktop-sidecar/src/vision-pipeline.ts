// Vision pipeline — runs local vision models against attached images
// for two distinct flows:
//
//   (A) Describe:  generate a free-form text description of what's in
//                  the image + any OCR text. The output becomes a normal
//                  text source the existing ingest + entity-linking
//                  pipeline operates on. Works for every plan with
//                  Ollama + a vision model installed.
//
//   (B) Extract:   produce a structured `{nodes, edges}` payload — the
//                  flowchart boxes, the diagram arrows, the chart data
//                  points. Routes through the existing correction-flow
//                  review so the user approves before any graph mutation
//                  happens. Pro-gated because it consumes more tokens.
//
// Both flows take an attachment id, read the file as base64 (limited by
// MAX_BYTES so we don't OOM on huge files), and post to Ollama's
// /api/chat with `images: [<base64>]`. Other vision providers
// (Claude/OpenAI/etc.) layer on top of the same call shape; for now
// only Ollama dispatches for real.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { GraphnosisHost } from './host.js';
import { listAttachments } from './attachments-store.js';

/** 50 MB cap. Even Ollama vision adapters struggle above this. */
const MAX_BYTES = 50 * 1024 * 1024;

/** Default model — every cortex with Ollama + vision can use this. */
const DEFAULT_VISION_MODEL = 'llama3.2-vision:11b';

const OLLAMA_BASE_URL = process.env['OLLAMA_BASE_URL']?.trim() || 'http://127.0.0.1:11434';

export interface VisionDeps {
  host: GraphnosisHost;
}

export interface DescribeArgs {
  attachmentId: string;
  /** Override the default model — e.g. claude/openai once those adapters land. */
  modelTag?: string;
  /** Optional extra guidance for the model. */
  promptHint?: string;
}

export interface DescribeResult {
  ok: boolean;
  /** Free-form description from the vision model. */
  description?: string | undefined;
  /** OCR text the model extracted, when applicable. */
  ocrText?: string | undefined;
  /** Model tag actually used. */
  modelTag?: string | undefined;
  /** Latency end-to-end including base64 + HTTP. */
  elapsedMs?: number | undefined;
  reason?: 'attachment_not_found' | 'file_unreachable' | 'file_too_large' | 'model_unreachable' | 'model_error' | undefined;
  error?: string | undefined;
}

export interface ExtractStructureArgs {
  attachmentId: string;
  modelTag?: string;
}

export interface ExtractedNode {
  /** Stable id within this extraction — used by edges to reference. */
  id: string;
  /** Human-readable label as it appears in the image. */
  label: string;
  /** Optional category — system, person, decision, data, action, other. */
  category?: 'system' | 'person' | 'decision' | 'data' | 'action' | 'other' | undefined;
  /** Optional spatial position 0-1 normalized to image dimensions. */
  position?: { x: number; y: number } | undefined;
  /** Optional descriptive note about this entity. */
  note?: string | undefined;
}

export interface ExtractedEdge {
  /** References ExtractedNode.id. */
  from: string;
  to: string;
  /** Label on the arrow / connection. */
  label?: string | undefined;
  /** Direction — directed (arrow) or undirected (line). Default directed. */
  directed?: boolean | undefined;
}

export interface ExtractStructureResult {
  ok: boolean;
  nodes?: ExtractedNode[] | undefined;
  edges?: ExtractedEdge[] | undefined;
  /** Raw JSON the model returned, for debugging. */
  raw?: string | undefined;
  modelTag?: string | undefined;
  elapsedMs?: number | undefined;
  reason?: DescribeResult['reason'];
  error?: string | undefined;
}

/**
 * (A) Describe an image. Reads the attachment, base64-encodes it, posts
 * to Ollama's chat endpoint with the vision model. Returns a free-form
 * description + any OCR text the model surfaces.
 */
export async function describeAttachmentImage(
  deps: VisionDeps,
  args: DescribeArgs,
): Promise<DescribeResult> {
  const att = await loadAttachment(deps.host.getCortexDir(), args.attachmentId);
  if (!att) return { ok: false, reason: 'attachment_not_found' };
  const buffer = await readBoundedFile(att.path);
  if (buffer === 'unreachable') return { ok: false, reason: 'file_unreachable' };
  if (buffer === 'too_large') return { ok: false, reason: 'file_too_large' };

  const modelTag = args.modelTag ?? DEFAULT_VISION_MODEL;
  const startedAt = Date.now();
  const system = 'You are a vision specialist describing images for a memory-augmented note system. Be concrete, specific, and complete. If the image contains text, include the literal text verbatim. If it shows people, structures, devices, charts, or diagrams, describe them at a useful level of detail.';
  const userPrompt = args.promptHint?.trim()
    ? `${args.promptHint.trim()}\n\nAlso include any literal text visible in the image.`
    : 'Describe this image in full. If there is any literal text — labels, captions, handwriting, signs — transcribe it verbatim and label it as "Text:".';
  try {
    const response = await callOllamaVision(modelTag, system, userPrompt, buffer);
    const elapsedMs = Date.now() - startedAt;
    return {
      ok: true,
      description: response,
      ocrText: extractOcrSection(response),
      modelTag,
      elapsedMs,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const reason: DescribeResult['reason'] = /ECONNREFUSED|reachable|not.*running/i.test(message)
      ? 'model_unreachable'
      : 'model_error';
    return { ok: false, reason, error: message, modelTag, elapsedMs };
  }
}

/**
 * (B) Extract a structured `{nodes, edges}` payload from an image
 * (diagram, flowchart, whiteboard, chart). Uses a strict prompt that
 * asks the model to return JSON in the schema we then parse + validate.
 *
 * On invalid JSON or shape mismatch, we return `ok: false` with the raw
 * output so the UI can surface "the model returned something we
 * couldn't parse — here's what it said." Callers (the correction-flow
 * integration) should NOT auto-commit these nodes/edges; the user
 * approves the diff before mutation.
 */
export async function extractStructureFromImage(
  deps: VisionDeps,
  args: ExtractStructureArgs,
): Promise<ExtractStructureResult> {
  const att = await loadAttachment(deps.host.getCortexDir(), args.attachmentId);
  if (!att) return { ok: false, reason: 'attachment_not_found' };
  const buffer = await readBoundedFile(att.path);
  if (buffer === 'unreachable') return { ok: false, reason: 'file_unreachable' };
  if (buffer === 'too_large') return { ok: false, reason: 'file_too_large' };

  const modelTag = args.modelTag ?? DEFAULT_VISION_MODEL;
  const startedAt = Date.now();
  const system = `You are a vision specialist extracting graph structure from diagrams, flowcharts, and whiteboard photos. Output ONLY valid JSON matching this schema (no commentary, no markdown fences):

{
  "nodes": [
    { "id": "n1", "label": "exact text inside the box", "category": "system | person | decision | data | action | other", "position": { "x": 0..1, "y": 0..1 }, "note": "optional" }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "label": "arrow label if present", "directed": true | false }
  ]
}

Rules:
- Use the exact text inside boxes/circles/labels — do not paraphrase.
- Every box / shape / labeled element becomes a node.
- Every arrow or connecting line becomes an edge.
- The "position" field uses 0-1 normalized image coordinates (top-left = 0,0).
- If the image is not a diagram, return { "nodes": [], "edges": [] }.`;
  const userPrompt = 'Extract the nodes and edges from this diagram. Return JSON only.';
  try {
    const raw = await callOllamaVision(modelTag, system, userPrompt, buffer);
    const elapsedMs = Date.now() - startedAt;
    const parsed = parseExtractionJson(raw);
    if (!parsed) {
      return { ok: false, reason: 'model_error', error: 'model output was not valid JSON', raw, modelTag, elapsedMs };
    }
    return { ok: true, nodes: parsed.nodes, edges: parsed.edges, raw, modelTag, elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    const reason: ExtractStructureResult['reason'] = /ECONNREFUSED|reachable|not.*running/i.test(message)
      ? 'model_unreachable'
      : 'model_error';
    return { ok: false, reason, error: message, modelTag, elapsedMs };
  }
}

// ── Internal helpers ───────────────────────────────────────────────────

async function loadAttachment(cortexDir: string, id: string) {
  const all = await listAttachments(cortexDir, {});
  return all.find((a) => a.id === id);
}

type FileBufferResult = Buffer | 'unreachable' | 'too_large';
async function readBoundedFile(p: string): Promise<FileBufferResult> {
  try {
    const stat = await fs.stat(p);
    if (stat.size > MAX_BYTES) return 'too_large';
    return await fs.readFile(p);
  } catch {
    return 'unreachable';
  }
}

async function callOllamaVision(
  modelTag: string,
  system: string,
  user: string,
  imageBuffer: Buffer,
): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelTag,
      stream: false,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: user,
          // Ollama's chat endpoint accepts `images: [base64...]` on the
          // user message. Vision models route them through the multimodal
          // tokenizer; non-vision models silently ignore.
          images: [imageBuffer.toString('base64')],
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama vision call failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { message?: { content?: string } };
  return json.message?.content ?? '';
}

/** Best-effort scrape of the "Text:" section the describe prompt asks for. */
function extractOcrSection(description: string): string | undefined {
  const match = description.match(/Text:\s*\n?([\s\S]+?)(?:\n\n|$)/i);
  return match?.[1]?.trim();
}

function parseExtractionJson(raw: string): { nodes: ExtractedNode[]; edges: ExtractedEdge[] } | null {
  // Models sometimes wrap JSON in ``` fences or add prose. Strip them.
  let candidate = raw.trim();
  const fenced = candidate.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fenced) candidate = fenced[1]!.trim();
  // Find the first { and trim everything before it; same for the last }.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < 0 || end < start) return null;
  candidate = candidate.slice(start, end + 1);

  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object') return null;
    const nodesRaw = (parsed as { nodes?: unknown }).nodes;
    const edgesRaw = (parsed as { edges?: unknown }).edges;
    if (!Array.isArray(nodesRaw)) return null;
    const nodes: ExtractedNode[] = [];
    for (const n of nodesRaw) {
      if (!n || typeof n !== 'object') continue;
      const obj = n as Record<string, unknown>;
      if (typeof obj['id'] !== 'string' || typeof obj['label'] !== 'string') continue;
      nodes.push({
        id: obj['id'],
        label: obj['label'],
        ...(typeof obj['category'] === 'string' && ['system', 'person', 'decision', 'data', 'action', 'other'].includes(obj['category'])
          ? { category: obj['category'] as ExtractedNode['category'] }
          : {}),
        ...(obj['position'] && typeof obj['position'] === 'object'
          && typeof (obj['position'] as Record<string, unknown>)['x'] === 'number'
          && typeof (obj['position'] as Record<string, unknown>)['y'] === 'number'
          ? { position: { x: (obj['position'] as { x: number }).x, y: (obj['position'] as { y: number }).y } }
          : {}),
        ...(typeof obj['note'] === 'string' ? { note: obj['note'] } : {}),
      });
    }
    const edges: ExtractedEdge[] = [];
    if (Array.isArray(edgesRaw)) {
      for (const e of edgesRaw) {
        if (!e || typeof e !== 'object') continue;
        const obj = e as Record<string, unknown>;
        if (typeof obj['from'] !== 'string' || typeof obj['to'] !== 'string') continue;
        edges.push({
          from: obj['from'],
          to: obj['to'],
          ...(typeof obj['label'] === 'string' ? { label: obj['label'] } : {}),
          ...(typeof obj['directed'] === 'boolean' ? { directed: obj['directed'] } : { directed: true }),
        });
      }
    }
    return { nodes, edges };
  } catch {
    return null;
  }
}

/**
 * Helper used by the ingest-after-describe flow: given the result of
 * `describeAttachmentImage`, build a Markdown body suitable for the
 * existing `host.ingest()` pipeline. The attached image's file path is
 * cited at the top so recall results carry the provenance link back
 * to the original file.
 */
export function describeResultToMarkdown(
  filePath: string,
  result: DescribeResult,
): string {
  const lines: string[] = [];
  lines.push(`> Image: ${path.basename(filePath)} (\`${filePath}\`)`);
  lines.push('');
  if (result.description) {
    lines.push(result.description);
  }
  if (result.ocrText) {
    lines.push('');
    lines.push('## Transcribed text');
    lines.push(result.ocrText);
  }
  return lines.join('\n');
}
