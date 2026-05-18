import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import mammoth from 'mammoth';
import type { GraphnosisHost } from './host.js';
import type { AppendDocumentInput } from './graphnosis-adapter.js';

const pdfWorkerScriptPath = fileURLToPath(new URL('./pdf-parse-worker.js', import.meta.url));

// Same safety guard as local-embed.ts: in a Bun-compiled binary, paths like
// `pdfWorkerScriptPath` live inside the virtual /$bunfs/ filesystem and Node's
// `new Worker(path)` either fails or re-execs the parent binary. We detect
// compiled mode and route PDF parsing inline (slower, blocks event loop
// during parse, but no fork-bomb risk). See local-embed.ts for the full
// rationale.
const IS_COMPILED_BIN = (() => {
  try {
    if (import.meta.url.startsWith('file:///$bunfs/')) return true;
    if (import.meta.url.includes('/$bunfs/')) return true;
  } catch { /* import.meta.url may throw in some embedded contexts */ }
  const exe = process.execPath || '';
  if (exe.endsWith('/node')) return false;
  if (exe.includes('graphnosis-sidecar')) return true;
  return false;
})();

// Markdown extensions go through the SDK's markdown parser (heading-aware,
// produces one node per section). `.txt` is plain prose without structure —
// route it to `kind: 'text'` so the SDK splits by paragraph/length instead
// of bailing with 0 chunks when no `#` headings are present.
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const PLAIN_TEXT_EXTS = new Set(['.txt']);
const HTML_EXTS = new Set(['.html', '.htm']);
const JSON_EXTS = new Set(['.json']);
const CSV_EXTS = new Set(['.csv']);
const PDF_EXTS = new Set(['.pdf']);
const DOCX_EXTS = new Set(['.docx']);

export interface IngestFileOpts {
  onProgress?: (pagesProcessed: number, totalPages: number) => void;
  /** Called immediately before the embedding phase begins — once all pages
   *  are extracted. Receives the total page count. */
  onEmbeddingStart?: (pagesExtracted: number) => void;
  /** Called after each PDF embedding chunk completes. Chunked embedding
   *  breaks large PDFs into smaller batches so the event loop can breathe
   *  and IPC connections stay responsive. */
  onEmbeddingChunk?: (chunksDone: number, totalChunks: number, nodesTotal: number) => void;
  /**
   * Optional wrapper applied around every embedding call inside this
   * function. The caller uses this to inject serialization (e.g. the
   * embedding-queue mutex) without blocking the parsing phase.
   *
   * Default: identity — runs fn immediately.
   */
  wrapIngest?: <T>(fn: () => Promise<T>) => Promise<T>;
}

/** How many pages to embed per chunk. Each chunk's ONNX call is serialized
 *  separately so the event loop can breathe and service IPC between chunks. */
const PDF_EMBED_CHUNK_PAGES = 500;

export async function ingestFile(host: GraphnosisHost, graphId: string, filePath: string, opts: IngestFileOpts = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);

  const wrap = opts.wrapIngest ?? (<T>(fn: () => Promise<T>) => fn());

  let input: AppendDocumentInput;
  if (MARKDOWN_EXTS.has(ext)) {
    input = { kind: 'markdown', content: await fs.readFile(filePath, 'utf8'), sourceRef: filePath };
  } else if (PLAIN_TEXT_EXTS.has(ext)) {
    input = { kind: 'text', content: await fs.readFile(filePath, 'utf8'), sourceRef: filePath };
  } else if (HTML_EXTS.has(ext)) {
    input = { kind: 'html', content: await fs.readFile(filePath, 'utf8'), sourceRef: filePath };
  } else if (JSON_EXTS.has(ext)) {
    input = { kind: 'json', content: await fs.readFile(filePath, 'utf8'), sourceRef: filePath };
  } else if (CSV_EXTS.has(ext)) {
    input = { kind: 'csv', content: await fs.readFile(filePath, 'utf8'), sourceRef: filePath };
  } else if (PDF_EXTS.has(ext)) {
    return ingestPdfWithProgress(host, graphId, filePath, opts.onProgress, opts.onEmbeddingStart, opts.onEmbeddingChunk, wrap);
  } else if (DOCX_EXTS.has(ext)) {
    // Word documents: convert to markdown via mammoth so the SDK gets clean
    // structured text. mammoth understands paragraphs, headings, lists,
    // tables, and inline emphasis — far better than reading the raw zip-XML
    // bytes as "text", which produced 124 nodes of binary garbage before
    // this path existed.
    input = await convertDocxToMarkdownInput(filePath); // .docx parse is JS-only; wrap covers host.ingest below
  } else if (ext === '.doc') {
    // Legacy binary .doc (pre-2007). mammoth only handles .docx; we don't
    // bundle a .doc parser. Fail loudly so the user knows to convert/re-save.
    throw new Error(
      `Legacy .doc files aren't supported — open the file in Word/Pages/LibreOffice ` +
      `and Save As .docx, then try again. (File: ${filePath})`,
    );
  } else {
    // Best-effort: treat unknown as text.
    input = { kind: 'text', content: await fs.readFile(filePath, 'utf8'), sourceRef: filePath };
  }
  // All non-PDF paths reach here. wrap serializes the ONNX embedding call
  // while allowing file reads above to happen outside the mutex.
  return wrap(() => host.ingest(graphId, 'file', filePath, input));
}

/**
 * Parse a PDF in a dedicated worker_threads Worker, then embed in chunked
 * batches on the main thread (via the forked embed-worker pool).
 *
 * Phase 1 — parsing (worker thread):
 *   pdfjs-dist / unpdf is pure JS/WASM — safe for worker_threads.
 *   The worker owns all pdfjs work; the main thread is completely free to
 *   serve IPC requests, stats calls, and Tauri events throughout.
 *
 * Phase 2 — embedding (main thread, forked embed-worker pool):
 *   The main thread re-enters after the worker resolves. Embedding is
 *   chunked (PDF_EMBED_CHUNK_PAGES pages/chunk) and serialized via the
 *   embedding-queue mutex so the event loop can breathe between chunks.
 */
async function ingestPdfWithProgress(
  host: GraphnosisHost,
  graphId: string,
  filePath: string,
  onProgress?: (pagesProcessed: number, totalPages: number) => void,
  onEmbeddingStart?: (pagesExtracted: number) => void,
  onEmbeddingChunk?: (chunksDone: number, totalChunks: number, nodesTotal: number) => void,
  wrap: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
) {
  // ── Phase 1: Parse all pages ─────────────────────────────────────────────
  // Two paths: worker_threads in dev mode, inline in compiled-binary mode.
  // The inline path blocks the main thread during parse, but Bun's compiled
  // binary either doesn't support `new Worker(virtual-path)` or routes it
  // through process re-exec — both unacceptable. We accept worse latency for
  // PDF ingest in compiled mode to guarantee no fork-bomb risk.
  const pageTexts = IS_COMPILED_BIN
    ? await parsePdfInline(filePath, onProgress)
    : await new Promise<string[]>((resolve, reject) => {
        const worker = new Worker(pdfWorkerScriptPath, { workerData: { filePath } });

        worker.on('message', (msg: { type: string; pagesProcessed?: number; totalPages?: number; pageTexts?: string[]; message?: string }) => {
          if (msg.type === 'progress') {
            onProgress?.(msg.pagesProcessed!, msg.totalPages!);
          } else if (msg.type === 'done') {
            resolve(msg.pageTexts!);
          } else if (msg.type === 'error') {
            reject(new Error(`pdf-parse-worker: ${msg.message}`));
          }
        });

        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`pdf-parse-worker exited with code ${code}`));
        });
      });

  const totalPages = pageTexts.length;

  // ── Phase 2: Split into embedding chunks ────────────────────────────────
  // Each chunk covers PDF_EMBED_CHUNK_PAGES pages. ingestChunked() embeds
  // them one at a time (inside wrap/mutex) and yields between chunks so the
  // event loop can service IPC connections throughout the embedding phase.
  onEmbeddingStart?.(totalPages);

  const chunkInputs: AppendDocumentInput[] = [];
  for (let ci = 0; ci < totalPages; ci += PDF_EMBED_CHUNK_PAGES) {
    const chunkText = pageTexts.slice(ci, ci + PDF_EMBED_CHUNK_PAGES).join('\n');
    if (chunkText.trim()) {
      chunkInputs.push({ kind: 'text', content: chunkText, sourceRef: filePath });
    }
  }

  return host.ingestChunked(graphId, 'file', filePath, chunkInputs, wrap, onEmbeddingChunk);
}

/**
 * Convert a .docx to HTML via mammoth, then hand off to the SDK's HTML
 * parser. mammoth's HTML output preserves headings, paragraphs, lists, and
 * tables — everything the SDK needs to split sensibly. mammoth's warnings
 * (unrecognized styles, images skipped, etc.) are non-fatal: partial
 * conversion beats rejecting the doc.
 *
 * (We picked HTML over markdown only because mammoth's TS typings only
 * expose `convertToHtml`. The runtime path is otherwise identical.)
 */
async function convertDocxToMarkdownInput(filePath: string): Promise<AppendDocumentInput> {
  const buf = await fs.readFile(filePath);
  const { value: html, messages } = await mammoth.convertToHtml({ buffer: buf });
  for (const m of messages) {
    console.error(`[ingest:docx] ${m.type}: ${m.message}`);
  }
  if (!html.trim()) {
    throw new Error(
      `mammoth produced empty HTML for ${filePath}. The document may be ` +
      `image-only or password-protected.`,
    );
  }
  return { kind: 'html', content: html, sourceRef: filePath };
}

export interface WebIngestInput {
  url: string;
  /** Optional pre-fetched HTML (e.g., from share-sheet payload). */
  html?: string;
  /** Optional selected text — overrides full-page extraction. */
  selection?: string;
}

export async function ingestWeb(host: GraphnosisHost, graphId: string, web: WebIngestInput) {
  if (web.selection && web.selection.trim()) {
    const md = `# Clip from ${web.url}\n\n${web.selection}`;
    return host.ingest(graphId, 'url', web.url, {
      kind: 'markdown',
      content: md,
      sourceRef: web.url,
    });
  }

  const html = web.html ?? (await fetchWithReadabilityFallback(web.url));
  const dom = new JSDOM(html, { url: web.url });
  const article = new Readability(dom.window.document).parse();
  const content = article
    ? `# ${article.title ?? web.url}\n\n${article.textContent ?? ''}`
    : `# ${web.url}\n\n${dom.window.document.body?.textContent ?? ''}`;
  return host.ingest(graphId, 'url', web.url, {
    kind: 'markdown',
    content,
    sourceRef: web.url,
  });
}

async function fetchWithReadabilityFallback(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'GraphnosisApp/0.0.1 (+local)' } });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

// Short clips (< 500 chars, no markdown headers in body) ingest as a single chunk.
// Anything longer or already structured goes through markdown so the SDK can split sensibly.
// The label is stored on the source record (visible in stats), not prepended as a heading
// — heading prefixes were causing the SDK to spawn label/metadata + content nodes (3-way split)
// for every short remember call, ballooning the graph.
const SHORT_CLIP_THRESHOLD = 500;
const HAS_MARKDOWN_HEADER = /^\s*#{1,6}\s/m;

export async function ingestClip(
  host: GraphnosisHost,
  graphId: string,
  text: string,
  label: string,
  opts?: { addedBy?: string; sourceKind?: 'clip' | 'ai-conversation' },
) {
  const sourceKind = opts?.sourceKind ?? 'clip';
  // Prefix the source ref so Sources-list filtering + the recovery panel
  // can distinguish AI-conversation captures from plain clips without
  // having to read the SourceRecord. Stable for the lifetime of the
  // source — never rewritten.
  const refPrefix = sourceKind === 'ai-conversation' ? 'ai-conversation' : 'clip';
  const sourceRef = `${refPrefix}:${Date.now()}:${label}`;
  const isShort = text.length < SHORT_CLIP_THRESHOLD && !HAS_MARKDOWN_HEADER.test(text);
  return host.ingest(graphId, sourceKind, sourceRef, {
    kind: isShort ? 'text' : 'markdown',
    content: text,
    sourceRef,
  }, opts?.addedBy ? { addedBy: opts.addedBy } : undefined);
}

// ── Inline PDF parser (compiled-binary fallback) ─────────────────────────────
//
// Replicates pdf-parse-worker.ts's logic on the main thread. Used when
// `IS_COMPILED_BIN` is true because Bun's compiled binary can't host a
// `new Worker(virtual-fs-path)`. Blocks the event loop while parsing; on
// big PDFs the App's UI will pause for a few seconds. Acceptable tradeoff
// for v0 single-binary shipping — proper worker re-exec is a follow-up.
async function parsePdfInline(
  filePath: string,
  onProgress?: (pagesProcessed: number, totalPages: number) => void,
): Promise<string[]> {
  const BATCH_SIZE = 50;
  const { getDocumentProxy } = await import('unpdf');
  const { joinPdfTextItems } = await import('./pdf-text-join.js');
  const buf = await fs.readFile(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const totalPages = pdf.numPages;
  const pageTexts: string[] = [];
  for (let start = 1; start <= totalPages; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, totalPages);
    const batch = await Promise.all(
      Array.from({ length: end - start + 1 }, async (_, i) => {
        const page = await pdf.getPage(start + i);
        const content = await page.getTextContent();
        return joinPdfTextItems(content.items);
      }),
    );
    pageTexts.push(...batch);
    onProgress?.(end, totalPages);
  }
  return pageTexts;
}
