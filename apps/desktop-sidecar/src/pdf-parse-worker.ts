/**
 * Worker-thread PDF parser — offloads pdfjs page extraction off the main thread.
 *
 * Unlike onnxruntime-node, pdfjs-dist (via unpdf) is pure JavaScript/WASM with
 * no V8-lock requirements, so it runs safely inside a worker_threads Worker.
 * Keeping PDF parsing off the main thread means IPC connections, stats calls,
 * and the Tauri UI remain responsive for the full duration of a large ingest.
 *
 * Protocol (via parentPort):
 *   workerData → { filePath: string }
 *   worker → parent : { type: 'progress', pagesProcessed: number, totalPages: number }
 *   worker → parent : { type: 'done', pageTexts: string[] }
 *   worker → parent : { type: 'error', message: string }
 */
import { workerData, parentPort } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import { joinPdfTextItems } from './pdf-text-join.js';

const { filePath } = workerData as { filePath: string };

// Larger batch than the old main-thread value (10) — we can afford more work
// per tick here because the main thread never blocks.
const BATCH_SIZE = 50;

async function run(): Promise<void> {
  const { getDocumentProxy } = await import('unpdf');
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
        // joinPdfTextItems handles two bugs the naive `.join(' ')` had:
        //   1. PDF parsers (especially InDesign-output / custom-subset
        //      fonts) emit one item per glyph — blind join inserted a
        //      space between every character. The new joiner reads each
        //      item's transform + width to detect whether it's adjacent
        //      to the previous one (no space needed) or actually
        //      separated (insert one space).
        //   2. Diacritics often come back in NFD form (`a` + combining
        //      breve). Final NFC normalisation collapses them into the
        //      precomposed character so the stored text reads natively.
        return joinPdfTextItems(content.items);
      }),
    );
    pageTexts.push(...batch);
    parentPort!.postMessage({ type: 'progress', pagesProcessed: end, totalPages });
  }

  parentPort!.postMessage({ type: 'done', pageTexts });
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  parentPort!.postMessage({ type: 'error', message });
});
