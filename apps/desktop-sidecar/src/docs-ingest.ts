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
import { withEmbedding } from './embedding-queue.js';
import { beginIngest, endIngest } from './client-activity.js';
import { dbg } from './log-redact.js';

export type DocsIngestProgress = {
  phase: 'wipe' | 'ingest' | 'relink' | 'save';
  pagesDone?: number;
  totalPages?: number;
  slug?: string;
};

/** Fixed slug for the engram holding ingested Graphnosis documentation. */
export const DOCS_ENGRAM_ID = 'graphnosis-docs';

/** Settings row without .gai/.aikg on disk (any engram). */
export function isGhostMetadataEngram(host: GraphnosisHost, graphId: string): boolean {
  return host.getGraphMetadata(graphId) !== undefined && !host.isGraphOnDisk(graphId);
}

/** Expected loadGraph failure for metadata without a graph file (boot race / ghost repair). */
export function isGhostLoadError(err: unknown, host: GraphnosisHost, graphId: string): boolean {
  const e = err as NodeJS.ErrnoException;
  if (
    typeof e.message === 'string'
    && e.message.includes('has metadata but no graph file on disk')
  ) return true;
  return e.code === 'ENOENT' && isGhostMetadataEngram(host, graphId);
}

/** Settings row without .gai/.aikg — deleteGraph didn't run or crashed mid-delete. */
export function isDocsGhostEngram(host: GraphnosisHost): boolean {
  return (
    isGhostMetadataEngram(host, DOCS_ENGRAM_ID) &&
    !host.listGraphs().includes(DOCS_ENGRAM_ID)
  );
}

export type DocsIngestDecision = 'offer' | 'reingest' | 'none';

/** Shared state machine for docs:checkOffer and post-boot maintenance. */
export async function evaluateDocsIngestDecision(
  host: GraphnosisHost,
  appVersion: string,
  opts?: { bootBusy?: boolean; ingestInflight?: boolean },
): Promise<DocsIngestDecision> {
  if (opts?.ingestInflight) return 'none';

  const settings = host.getSettings();
  const loaded = host.listGraphs().includes(DOCS_ENGRAM_ID);
  const onDisk = host.isGraphOnDisk(DOCS_ENGRAM_ID);
  const docsState = settings.docsEngram;

  if (isDocsGhostEngram(host)) {
    return 'reingest';
  }

  if (loaded || onDisk) {
    const sourceCount = loaded
      ? host.listSources(DOCS_ENGRAM_ID).length
      : await host.countBundleSources(DOCS_ENGRAM_ID);
    const nodeCount = loaded ? host.listNodes(DOCS_ENGRAM_ID).length : 0;
    const versionMismatch = docsState?.ingestedAppVersion !== appVersion;
    const sourcesIncomplete = sourceCount < BUNDLED_DOCS.length;

    if (!versionMismatch && !sourcesIncomplete) return 'none';
    if (versionMismatch) {
      if (opts?.bootBusy) return 'none';
      return 'reingest';
    }
    // Hollow .gai (0 nodes) with bundle sources — deferred materialize, not wipe+reingest.
    if (sourceCount > 0 && nodeCount === 0) return 'none';
    // Incomplete ingest — defer while boot sweep / emb-cache rebuild is active.
    if (opts?.bootBusy) return 'none';
    return 'reingest';
  }

  if (docsState?.declined === true) return 'none';
  if (typeof docsState?.ingestedAppVersion === 'string' && docsState.ingestedAppVersion.length > 0) {
    return 'none';
  }
  return 'offer';
}

/**
 * Wipe (if present) and recreate + ingest bundled docs. Shared by IPC and boot
 * ghost repair so partial/orphan state is always rebuilt from a clean slate.
 */
export async function recreateAndIngestDocsEngram(
  host: GraphnosisHost,
  appVersion: string,
  onProgress?: (p: DocsIngestProgress) => void,
): Promise<{ ingested: number; failed: number }> {
  const resident = host.listGraphs().includes(DOCS_ENGRAM_ID);
  const sourceCount = resident
    ? host.listSources(DOCS_ENGRAM_ID).length
    : (host.isGraphOnDisk(DOCS_ENGRAM_ID) ? await host.countBundleSources(DOCS_ENGRAM_ID) : 0);
  const nodeCount = resident ? host.listNodes(DOCS_ENGRAM_ID).length : 0;
  const emptyShell = sourceCount === 0 && nodeCount === 0;

  // Interrupted re-ingest often leaves a hollow shell — skip wipe+recreate and
  // resume ingesting into the existing engram instead of resetting every boot.
  const needsWipe = !emptyShell && (
    resident ||
    host.isGraphOnDisk(DOCS_ENGRAM_ID) ||
    host.getGraphMetadata(DOCS_ENGRAM_ID) !== undefined
  );
  if (needsWipe) {
    onProgress?.({ phase: 'wipe' });
    await host.deleteGraph(DOCS_ENGRAM_ID);
  }
  if (!host.listGraphs().includes(DOCS_ENGRAM_ID)) {
    if (host.isGraphOnDisk(DOCS_ENGRAM_ID)) {
      await host.loadGraph(DOCS_ENGRAM_ID);
    } else {
      await host.createGraph(DOCS_ENGRAM_ID);
      await host.setGraphMetadata(DOCS_ENGRAM_ID, {
        template: 'reading',
        displayName: 'Graphnosis Docs',
        createdAt: Date.now(),
      });
    }
  }
  if (host.getGraphMetadata(DOCS_ENGRAM_ID) === undefined) {
    await host.setGraphMetadata(DOCS_ENGRAM_ID, {
      template: 'reading',
      displayName: 'Graphnosis Docs',
      createdAt: Date.now(),
    });
  }
  const { ingested, failed } = await ingestGraphnosisDocs(host, DOCS_ENGRAM_ID, onProgress);
  if (ingested >= BUNDLED_DOCS.length) {
    await host.setSettings({
      docsEngram: { declined: false, ingestedAppVersion: appVersion },
    });
  }
  return { ingested, failed };
}

/** Repair ghost metadata (no .gai) before IPC serves graphs.load. No-op if healthy. */
export async function repairDocsGhostEngram(
  host: GraphnosisHost,
  appVersion: string,
): Promise<{ repaired: boolean; ingested: number; failed: number }> {
  if (!isDocsGhostEngram(host)) {
    return { repaired: false, ingested: 0, failed: 0 };
  }
  dbg(
    '[graphnosis-sidecar] repairing ghost graphnosis-docs (metadata without .gai on disk)',
  );
  const { ingested, failed } = await recreateAndIngestDocsEngram(host, appVersion);
  return { repaired: true, ingested, failed };
}

/** Resolve bundled doc markdown for a `graphnosis-docs:<slug>` source ref. */
export function bundledDocForRef(sourceRef: string): {
  kind: 'markdown';
  content: string;
  sourceRef: string;
} | null {
  if (!sourceRef.startsWith('graphnosis-docs:')) return null;
  const slug = sourceRef.slice('graphnosis-docs:'.length);
  const doc = BUNDLED_DOCS.find((d) => d.slug === slug || d.slug.endsWith(`/${slug}`));
  if (!doc) return null;
  const content = doc.title ? `# ${doc.title}\n\n${doc.markdown}` : doc.markdown;
  return { kind: 'markdown', content, sourceRef };
}

/**
 * Ingest the bundled Graphnosis documentation into `graphId`.
 *
 * Returns `{ ingested, failed }` — counts of pages that succeeded vs. threw.
 * One bad page never aborts the rest. Purely local — no network access.
 */
export async function ingestGraphnosisDocs(
  host: GraphnosisHost,
  graphId: string,
  onProgress?: (p: DocsIngestProgress) => void,
  opts?: { skipRelink?: boolean },
): Promise<{ ingested: number; failed: number }> {
  let ingested = 0;
  let failed = 0;
  const totalPages = BUNDLED_DOCS.length;
  const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

  beginIngest(graphId);
  try {
    for (const doc of BUNDLED_DOCS) {
      const sourceRef = `graphnosis-docs:${doc.slug}`;
      const bundled = bundledDocForRef(sourceRef);
      if (!bundled) continue;
      try {
        await withEmbedding(() => host.ingest(graphId, 'clip', sourceRef, bundled, {
          // Suppress the per-document relink debounce. Without this flag,
          // every page ingest fires kickoffRelink — and because embedding
          // each page takes 2-5s (longer than the 1500ms debounce window),
          // a full O(N²) relink pass fires between every page. 32 relink
          // passes on a growing engram adds 60-120s+ to the ingest and causes
          // the IPC timeout. One relink after all pages is sufficient.
          skipAutoRelink: true,
          // Batch save: one encrypted write after all pages instead of 32.
          skipSave: true,
        }), `docs:${doc.slug}`);
        ingested++;
      } catch (e) {
        failed++;
        console.error(`[docs-ingest] failed to ingest ${doc.slug}:`, e);
      }
      onProgress?.({
        phase: 'ingest',
        pagesDone: ingested + failed,
        totalPages,
        slug: doc.slug,
      });
      // Yield so the event loop can service IPC + push progress frames.
      await yieldToLoop();
    }
    // Single relink pass after all pages are ingested — picks up cross-page
    // entity overlaps in one shot instead of 32 incremental passes.
    // Latency benchmark skips relink: relinkFullGraph on ~3400 nodes adds
    // ~100k edges and turns a ~200 ms recall into multi-second contention.
    if (ingested > 0) {
      onProgress?.({ phase: 'relink', totalPages });
      if (!opts?.skipRelink) {
        host.triggerRelink(graphId);
      }
      onProgress?.({ phase: 'save', totalPages });
      await host.save(graphId);
    }
    return { ingested, failed };
  } finally {
    endIngest(graphId);
  }
}
