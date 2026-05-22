// Ingests the Graphnosis documentation into a dedicated `graphnosis-docs`
// engram so the user's AI can answer questions about Graphnosis itself.
//
// The docs are BUNDLED with the app — see `docs-content.generated.ts`, which
// `scripts/generate-docs-content.mjs` regenerates from apps/docs on every
// build. So this runs fully offline: no fetch, no sitemap, no server is ever
// contacted. It works with Wi-Fi off, and stays version-matched to the
// installed app (a new app build bundles the docs current for that release).

import type { GraphnosisHost } from './host.js';
import { BUNDLED_DOCS } from './docs-content.generated.js';

/**
 * Ingest the bundled Graphnosis documentation into `graphId`.
 *
 * Returns `{ ingested, failed }` — counts of pages that succeeded vs. threw.
 * One bad page never aborts the rest. Purely local — no network access.
 */
export async function ingestGraphnosisDocs(
  host: GraphnosisHost,
  graphId: string,
): Promise<{ ingested: number; failed: number }> {
  let ingested = 0;
  let failed = 0;
  for (const doc of BUNDLED_DOCS) {
    const sourceRef = `graphnosis-docs:${doc.slug}`;
    // Prepend the page title as an H1 so each page lands as a clearly titled
    // memory even when the body has no top-level heading of its own.
    const content = doc.title ? `# ${doc.title}\n\n${doc.markdown}` : doc.markdown;
    try {
      await host.ingest(graphId, 'file', sourceRef, {
        kind: 'markdown',
        content,
        sourceRef,
      });
      ingested++;
    } catch (e) {
      failed++;
      console.error(`[docs-ingest] failed to ingest ${doc.slug}:`, e);
    }
  }
  return { ingested, failed };
}
