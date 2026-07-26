#!/usr/bin/env node
/**
 * Skill-recovery CLI — restore a skill whose body was destroyed by a transfer.
 *
 * WHAT WENT WRONG
 * ---------------
 * `host.moveSource` re-ingests a source in the destination engram from its
 * CACHED content blob. For a trained skill that blob holds only the seed chunk
 * — the `<!-- Graphnosis skill training metadata -->` comment — because the
 * trainer ingests the seed and then appends every body/goal node individually
 * via `insertNodeAt`. So transferring a skill between Skills engrams replaced
 * the entire procedure with its own training header, silently, while the UI
 * still reported vitality 100.
 *
 * The transfer paths are fixed (moveSourcePreservingSkillNodes), but that only
 * helps future moves. This tool repairs skills already damaged.
 *
 * WHERE THE CONTENT STILL IS — AND WHERE IT DOES NOT
 * --------------------------------------------------
 * The op-log is the ONLY surviving copy. Three dead ends rule out everything
 * else, all confirmed by reading `host.forgetSource`:
 *
 *   1. Soft-deleted nodes do NOT retain their text. Before soft-deleting,
 *      forgetSource OVERWRITES each node's content with a tombstone
 *      (`__gn-forgotten:<stamp>:<i>:<nodeId>__`) to release its hash from the
 *      SDK's dedup table. The original text is gone from the `.gai`.
 *   2. That tombstone rewrite calls `adapter.applyCorrection` DIRECTLY, so it
 *      bypasses the host-level emit that would have recorded the pre-edit
 *      content. Nothing captures the full text on the way out.
 *   3. `addNode` events carry no content — only `sourceId` / `ref` / `role`.
 *      The original ingest is no help either.
 *
 * What does survive: forgetSource emits, per node,
 *   `op: 'deleteNode', before: { sourceId, preview }`
 * where `preview` was captured BEFORE the tombstone rewrite. That is
 * `contentPreview`, capped at 500 characters by the adapter.
 *
 * So recovery is faithful for any node under 500 characters — which is most
 * steps and every goal line — and TRUNCATED beyond that. Truncated nodes are
 * counted and reported; nothing lossy is written without saying so.
 *
 * USAGE
 * Build first — a fresh clone has no dist/. Use `exec tsc` rather than the
 * package's `build` script, which also runs generate-skill-demos-content.mjs
 * and needs the GSK signing key:
 *
 *   pnpm --filter @graphnosis-app/desktop-sidecar exec tsc -p tsconfig.json
 *
 * Then, from the REPO ROOT:
 *
 *   GRAPHNOSIS_CORTEX=/path/to/cortex GRAPHNOSIS_PASSPHRASE='…' \
 *     pnpm --filter @graphnosis-app/desktop-sidecar skill-recover plan
 *
 *   GRAPHNOSIS_CORTEX=… GRAPHNOSIS_PASSPHRASE='…' \
 *     pnpm --filter @graphnosis-app/desktop-sidecar skill-recover plan "Report Format"
 *
 *   GRAPHNOSIS_CORTEX=… GRAPHNOSIS_PASSPHRASE='…' \
 *     pnpm --filter @graphnosis-app/desktop-sidecar skill-recover apply "Report Format"
 *
 * Or directly: `node apps/desktop-sidecar/dist/skill-recover.js plan`.
 *
 * `apply` with no skill name repairs every damaged skill it can. It only ever
 * APPENDS nodes to a source that is missing them — it never deletes, never
 * overwrites, and is idempotent, so running it twice is safe.
 *
 * IMPORTANT: nothing else may hold the cortex lock. Quit the Graphnosis app and
 * any MCP relay pointing at this cortex first.
 */

import { pathToFileURL } from 'node:url';
import { embeddings } from '@graphnosis-app/core';
import { GraphnosisHost } from './host.js';
import { GraphnosisImpl } from './graphnosis-impl.js';
import { restoreSkillNodes } from './skill-trainer.js';
import { recoverFromForgetTrail, type OplogRecovery } from './skill-recover-oplog.js';

/** A skill source that looks like it lost its body to a transfer. */
interface DamagedSkill {
  graphId: string;
  sourceId: string;
  label: string;
  /** Node count currently attached to the source. */
  liveNodes: number;
  /** Recovered content, in the order it should be re-appended. */
  recovered: string[];
  /** Where `recovered` came from. */
  origin: 'oplog-preview' | 'none';
  /** The engram the forget trail was found in — i.e. where the skill came from. */
  recoveredFrom?: string;
  /** Recovered entries that hit the 500-char op-log preview cap. */
  truncated: number;
}

async function bootHost(cortexDir: string, passphrase: string): Promise<GraphnosisHost> {
  const adapter = new GraphnosisImpl();
  let embedFn = embeddings.stubEmbed;
  let embedAdapterId = 'graphnosis-app:stub@384';
  let embedDimensions = 384;
  try {
    // Imported lazily: local-embed spawns its worker pool at MODULE load, so a
    // static import made even `skill-recover.js` with no arguments fork workers
    // and then die on an unhandled 'error' event as process.exit raced them.
    const { workerEmbed, LOCAL_EMBED_ID, LOCAL_EMBED_DIM } = await import('./local-embed.js');
    const probe = await workerEmbed('graphnosis skill recovery probe');
    if (probe.length === LOCAL_EMBED_DIM) {
      embedFn = workerEmbed;
      embedAdapterId = LOCAL_EMBED_ID;
      embedDimensions = LOCAL_EMBED_DIM;
    }
  } catch (e) {
    console.error(`[skill-recover] embeddings unavailable: ${(e as Error).message} — using stub.`);
  }
  const { host } = await GraphnosisHost.open({
    cortexDir,
    passphrase,
    deviceId: `skill-recovery-${process.pid}`,
    adapter,
    embed: embedFn,
    embedAdapterId,
    embedDimensions,
  });
  return host;
}

/** A skill source carrying nothing but its metadata comment is the signature. */
function looksDamaged(host: GraphnosisHost, graphId: string, sourceId: string): boolean {
  const rec = host.getSourceRecord(graphId, sourceId);
  if (!rec || rec.kind !== 'skill') return false;
  const texts = rec.nodeIds
    .map((nid) => (host.getFullNodeContent(graphId, nid) ?? '').trim())
    .filter(Boolean);
  if (texts.length === 0) return true;
  // Damaged = every remaining node is the training-metadata comment.
  return texts.every((t) => t.startsWith('<!--'));
}

/** Read the op-log once, then reconstruct. Logic lives in skill-recover-oplog. */
async function recoverFromOplog(
  host: Pick<GraphnosisHost, 'listOplogEvents'>,
  sourceId: string,
  alreadyPresent: ReadonlySet<string>,
): Promise<OplogRecovery> {
  return recoverFromForgetTrail(await host.listOplogEvents(), sourceId, alreadyPresent);
}

/**
 * Load every engram in the cortex.
 *
 * `listGraphs()` returns only RESIDENT graphs, and `GraphnosisHost.open()`
 * loads none — the sidecar loads them in a boot sweep, which a CLI does not
 * run. Scanning without this enumerated an empty set and cheerfully reported
 * "no damaged skills found", which is exactly the wrong answer to give someone
 * whose skill was destroyed.
 *
 * Returns the ids that are resident afterwards, plus any that failed to load
 * (surfaced to the user — an engram we could not read is NOT evidence of no
 * damage).
 */
async function loadAllEngrams(host: GraphnosisHost): Promise<{
  loaded: string[];
  failed: Array<{ graphId: string; error: string }>;
}> {
  const failed: Array<{ graphId: string; error: string }> = [];
  for (const graphId of host.listBootPendingEngramIds(host.listGraphs())) {
    try {
      await host.loadGraph(graphId);
    } catch (e) {
      failed.push({ graphId, error: (e as Error).message });
    }
  }
  return { loaded: host.listGraphs(), failed };
}

async function scan(
  host: GraphnosisHost,
  graphIds: readonly string[],
  nameFilter?: string,
): Promise<DamagedSkill[]> {
  const out: DamagedSkill[] = [];
  for (const graphId of graphIds) {
    for (const src of host.listSources(graphId)) {
      if (src.kind !== 'skill') continue;
      const label = src.ref.replace(/^skill:\d+:/, '');
      if (nameFilter && !label.toLowerCase().includes(nameFilter.toLowerCase())) continue;
      if (!looksDamaged(host, graphId, src.sourceId)) continue;

      const present = new Set(
        (host.getSourceRecord(graphId, src.sourceId)?.nodeIds ?? [])
          .map((nid) => (host.getFullNodeContent(graphId, nid) ?? '').trim())
          .filter(Boolean),
      );

      const log = await recoverFromOplog(host, src.sourceId, present);
      out.push({
        graphId,
        sourceId: src.sourceId,
        label,
        liveNodes: present.size,
        recovered: log.texts,
        origin: log.texts.length > 0 ? 'oplog-preview' : 'none',
        ...(log.fromGraphId !== undefined ? { recoveredFrom: log.fromGraphId } : {}),
        truncated: log.truncated,
      });
    }
  }
  return out;
}

function report(items: DamagedSkill[]): void {
  if (items.length === 0) {
    console.log('\nNo damaged skills found — every skill source has a body.\n');
    return;
  }
  console.log(`\nFound ${items.length} damaged skill(s):\n`);
  for (const it of items) {
    const glyph = it.origin === 'oplog-preview' ? (it.truncated > 0 ? '~' : '✓') : '✗';
    console.log(`${glyph}  ${it.label}`);
    console.log(`     engram=${it.graphId}  sourceId=${it.sourceId}`);
    console.log(`     live nodes: ${it.liveNodes} (metadata only)`);
    if (it.origin === 'oplog-preview') {
      console.log(`     recoverable: ${it.recovered.length} node(s) from the op-log forget trail`);
      if (it.recoveredFrom) console.log(`     forgotten in: ${it.recoveredFrom}`);
      if (it.truncated > 0) {
        console.log(`     ⚠ ${it.truncated} node(s) exceeded the 500-char op-log preview cap`);
        console.log('       and will come back TRUNCATED. Review them before retraining.');
      } else {
        console.log('     all nodes are under the 500-char cap — recovery is exact');
      }
    } else {
      console.log('     ✗ nothing recoverable — no deleteNode trail for this sourceId in the op-log');
    }
    for (const t of it.recovered.slice(0, 4)) {
      console.log(`       · ${t.replace(/\s+/g, ' ').slice(0, 96)}`);
    }
    if (it.recovered.length > 4) console.log(`       … and ${it.recovered.length - 4} more`);
    console.log('');
  }
  console.log('Legend:  ✓ exact   ~ some nodes truncated at the 500-char cap   ✗ unrecoverable\n');
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const nameFilter = process.argv[3];
  if (mode !== 'plan' && mode !== 'apply') {
    console.error('Usage: skill-recover.js <plan|apply> [skill name substring]');
    process.exit(2);
  }
  const cortexDir = process.env.GRAPHNOSIS_CORTEX;
  const passphrase = process.env.GRAPHNOSIS_PASSPHRASE;
  if (!cortexDir || !passphrase) {
    console.error('Set GRAPHNOSIS_CORTEX and GRAPHNOSIS_PASSPHRASE.');
    process.exit(2);
  }

  const host = await bootHost(cortexDir, passphrase);

  // Engrams are lazy — load them all before scanning, or the scan sees nothing
  // and reports "no damage" for a cortex it never actually read.
  const { loaded, failed } = await loadAllEngrams(host);
  let skillSources = 0;
  for (const g of loaded) {
    skillSources += host.listSources(g).filter((s) => s.kind === 'skill').length;
  }
  console.log(
    `\nScanned ${loaded.length} engram(s), ${skillSources} skill source(s)` +
    (nameFilter ? ` matching "${nameFilter}"` : ''),
  );
  if (failed.length > 0) {
    console.log(`\n⚠ ${failed.length} engram(s) FAILED to load and were not scanned:`);
    for (const f of failed) console.log(`     ${f.graphId}: ${f.error}`);
    console.log('   A clean result below does not cover these.');
  }
  if (skillSources === 0) {
    console.log(
      '\n⚠ No skill sources found at all. Either this cortex holds no skills, or\n' +
      '  GRAPHNOSIS_CORTEX points somewhere unexpected. Check the path before\n' +
      '  concluding nothing is damaged.\n',
    );
    return;
  }

  const items = await scan(host, loaded, nameFilter);
  report(items);

  if (mode === 'plan') {
    console.log('This was a dry run. Re-run with `apply` to restore.\n');
    return;
  }

  let restored = 0;
  for (const it of items) {
    if (it.recovered.length === 0) continue;
    const { repaired } = await restoreSkillNodes(
      host, it.graphId, it.sourceId, it.recovered, { triggeredBy: 'skill:recover-cli' },
    );
    console.log(`restored ${repaired} node(s) into "${it.label}" (${it.graphId})`);
    restored += repaired;
  }
  for (const g of new Set(items.map((i) => i.graphId))) await host.save(g);
  console.log(`\nDone. ${restored} node(s) restored across ${items.length} skill(s).`);
  console.log('Reopen Graphnosis and check each skill walks correctly before retraining.\n');
}

// Only run as a CLI. Importing this module (the recovery unit tests do) must
// not boot a host or exit the process.
const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => {
    console.error(`[skill-recover] failed: ${(e as Error).stack ?? String(e)}`);
    process.exit(1);
  });
}
