import { promises as fs } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import mammoth from 'mammoth';
import type { GraphnosisHost } from './host.js';
import type { AppendDocumentInput } from './graphnosis-adapter.js';

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

export async function ingestFile(host: GraphnosisHost, graphId: string, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);

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
    input = { kind: 'pdf', content: new Uint8Array(await fs.readFile(filePath)), sourceRef: filePath };
  } else if (DOCX_EXTS.has(ext)) {
    // Word documents: convert to markdown via mammoth so the SDK gets clean
    // structured text. mammoth understands paragraphs, headings, lists,
    // tables, and inline emphasis — far better than reading the raw zip-XML
    // bytes as "text", which produced 124 nodes of binary garbage before
    // this path existed.
    input = await convertDocxToMarkdownInput(filePath);
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
  return host.ingest(graphId, 'file', filePath, input);
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

export async function ingestClip(host: GraphnosisHost, graphId: string, text: string, label: string) {
  const sourceRef = `clip:${Date.now()}:${label}`;
  const isShort = text.length < SHORT_CLIP_THRESHOLD && !HAS_MARKDOWN_HEADER.test(text);
  return host.ingest(graphId, 'clip', sourceRef, {
    kind: isShort ? 'text' : 'markdown',
    content: text,
    sourceRef,
  });
}
