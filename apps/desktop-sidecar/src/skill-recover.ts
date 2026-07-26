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

import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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

/**
 * Heap for the engram-scan child. Generous because pass 1 genuinely needs it —
 * 47 engrams with embeddings peaked near 4 GB even loading one at a time.
 */
const CHILD_HEAP_MB = 8192;

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
  // Suppress per-engram op-log reconcile for the whole run.
  //
  // loadGraph fires reconcileGraphFromOplog fire-and-forget, and that collects
  // every event since the engram's checkpoint via safeReadEventsSince. Pass 1
  // loads 47 engrams in a loop, so 47 unawaited reconciles pile up
  // concurrently, each materialising a large slice of a 7.7M-event log — 6.7 GB
  // of live objects for a cortex holding only ~60k nodes. That, not the op-log
  // read, is what exhausted the heap.
  //
  // setBootPhaseActive(true) makes scheduleReconcile QUEUE instead of run, and
  // we deliberately never call flushBootDeferredWork.
  //
  // Correctness: reconcile only replays op-log events onto the .gai. This tool
  // reads the .gai to spot damaged skills and then reads the op-log itself, so
  // skipping it costs nothing here. The one risk is a skill that looks damaged
  // on disk but would be repaired by a pending reconcile — restoreSkillNodes
  // already skips text present on the source, so that degrades to a no-op
  // rather than a duplicate.
  host.setBootPhaseActive(true);
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

/**
 * Read the forget trail for a KNOWN set of sourceIds in one streaming pass.
 *
 * Deliberately not `host.listOplogEvents()`. That materialises every event in
 * the log as a JS object: on a 4.6 GB op-log it OOM'd a 4 GB heap inside
 * JSON.parse — and it was being called once PER damaged skill, so the cost
 * multiplied by the number of skills we were trying to save.
 *
 * safeCollectEvents keeps only what matches, so peak memory is one chunk plus
 * the handful of deleteNode events we actually want, and the log is read once
 * regardless of how many skills need repairing.
 */
async function collectForgetTrails(
  host: GraphnosisHost,
  sourceIds: ReadonlySet<string>,
): Promise<Parameters<typeof recoverFromForgetTrail>[0]> {
  return host.collectOplogEvents((ev) => {
    if (ev.op !== 'deleteNode') return false;
    const before = ev.before as { sourceId?: unknown; preview?: unknown } | undefined;
    return typeof before?.sourceId === 'string' &&
      sourceIds.has(before.sourceId) &&
      typeof before.preview === 'string';
  });
}

/** A damaged skill found by the graph scan, before any op-log work. */
interface DamagedCandidate {
  graphId: string;
  sourceId: string;
  label: string;
  /** Text of the nodes still attached — used to avoid re-adding them. */
  present: Set<string>;
}

/**
 * Pass 1: find damaged skills, ONE ENGRAM AT A TIME.
 *
 * Loading every engram and keeping them resident consumed ~3.9 GB of a 4 GB
 * heap on a 47-engram cortex (60k+ nodes with embeddings) — the op-log read
 * that followed then died of heap exhaustion, and the crash looked like an
 * op-log problem when the op-log was merely the last allocation.
 *
 * So: load, scan, unload. Only the tiny candidate records survive each
 * iteration, and peak memory is one engram rather than all of them.
 * `unloadGraph` disposes the SDK graph's internal indexes, so this genuinely
 * reclaims rather than just dropping a reference.
 *
 * Touches no op-log at all — that is pass 2, and it runs with the heap clear.
 */
async function findDamaged(
  host: GraphnosisHost,
  nameFilter: string | undefined,
): Promise<{
  candidates: DamagedCandidate[];
  engramsScanned: number;
  skillSources: number;
  failed: Array<{ graphId: string; error: string }>;
}> {
  const candidates: DamagedCandidate[] = [];
  const failed: Array<{ graphId: string; error: string }> = [];
  let engramsScanned = 0;
  let skillSources = 0;

  // Snapshot the id list up front: listBootPendingEngramIds() reflects what is
  // resident, and we are about to change that on every iteration.
  const resident = new Set(host.listGraphs());
  const allIds = [...resident, ...host.listBootPendingEngramIds(resident)];

  for (const graphId of allIds) {
    const wasResident = resident.has(graphId);
    try {
      if (!wasResident) await host.loadGraph(graphId);
    } catch (e) {
      failed.push({ graphId, error: (e as Error).message });
      continue;
    }
    engramsScanned++;
    // Heap trace, on by default. Two prior fixes here were shipped on a
    // plausible reading of an OOM stack and both turned out wrong, because the
    // stack only ever names the LAST allocation, never the one that filled the
    // heap. This makes the growth curve visible: flat means the scan is
    // innocent, monotonic means loading engrams leaks, and a step at one
    // engram names the culprit outright.
    const mb = (n: number) => Math.round(n / 1024 / 1024);
    const m = process.memoryUsage();
    console.error(
      `[skill-recover] scanned ${String(engramsScanned).padStart(3)}/${allIds.length}` +
      `  heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB  ext=${mb(m.external)}MB  rss=${mb(m.rss)}MB`,
    );
    try {
      for (const src of host.listSources(graphId)) {
        if (src.kind !== 'skill') continue;
        skillSources++;
        const label = src.ref.replace(/^skill:\d+:/, '');
        if (nameFilter && !label.toLowerCase().includes(nameFilter.toLowerCase())) continue;
        if (!looksDamaged(host, graphId, src.sourceId)) continue;
        candidates.push({
          graphId,
          sourceId: src.sourceId,
          label,
          present: new Set(
            (host.getSourceRecord(graphId, src.sourceId)?.nodeIds ?? [])
              .map((nid) => (host.getFullNodeContent(graphId, nid) ?? '').trim())
              .filter(Boolean),
          ),
        });
      }
    } finally {
      // Release it again unless it was already resident when we arrived.
      if (!wasResident) {
        try { await host.unloadGraph(graphId); } catch { /* best-effort */ }
      }
    }
  }
  return { candidates, engramsScanned, skillSources, failed };
}

/**
 * Pass 2: one streaming read of the op-log for ALL damaged skills at once.
 *
 * Splitting the two passes is what keeps this survivable on a large cortex —
 * the log is read once, filtered to the sourceIds we care about, rather than
 * read in full once per skill.
 */
/** Wire form of DamagedCandidate — Sets do not survive JSON. */
interface WireCandidate {
  graphId: string;
  sourceId: string;
  label: string;
  present: string[];
}

/**
 * Pass 1, running as the CHILD: scan engrams, write candidates, exit.
 *
 * Exiting is the entire point — see runFindDamagedIsolated.
 */
async function scanEngramsChild(): Promise<void> {
  const outFile = process.argv[3];
  const nameFilter = process.argv[4] || undefined;
  const cortexDir = process.env.GRAPHNOSIS_CORTEX;
  const passphrase = process.env.GRAPHNOSIS_PASSPHRASE;
  if (!outFile || !cortexDir || !passphrase) {
    console.error('[skill-recover scan-engrams] bad invocation');
    process.exit(2);
  }
  const host = await bootHost(cortexDir, passphrase);
  const found = await findDamaged(host, nameFilter);
  const wire = {
    ...found,
    candidates: found.candidates.map((c): WireCandidate => ({
      graphId: c.graphId,
      sourceId: c.sourceId,
      label: c.label,
      present: [...c.present],
    })),
  };
  await fs.writeFile(outFile, JSON.stringify(wire), 'utf8');
}

/**
 * Run pass 1 in a separate process, so pass 2 gets a genuinely empty heap.
 *
 * Pass 1 loads and unloads all 47 engrams. `unloadGraph` drops the SDK's
 * indexes, but V8 does not hand the pages back to the OS: the heap still
 * measured ~6.8 GB when pass 2 started, and pass 2 then died allocating its
 * first op-log chunk. The same op-log scans fine in `oplog-report`, which
 * loads no engram — so the op-log was never the problem, the residue was.
 *
 * A process boundary is the only thing that actually reclaims it. Pass 1 is
 * the one that gets exiled (rather than pass 2) because the cortex lock is
 * exclusive: the child must be gone before the parent can boot, and `apply`
 * needs the parent to hold a live host afterwards to write the repairs.
 */
async function runFindDamagedIsolated(
  nameFilter: string | undefined,
): Promise<{
  candidates: DamagedCandidate[];
  engramsScanned: number;
  skillSources: number;
  failed: Array<{ graphId: string; error: string }>;
}> {
  const outFile = path.join(
    os.tmpdir(),
    `graphnosis-skill-scan-${process.pid}-${Date.now()}.json`,
  );
  const selfPath = fileURLToPath(import.meta.url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--enable-source-maps',
        `--max-old-space-size=${CHILD_HEAP_MB}`,
        selfPath,
        'scan-engrams',
        outFile,
        ...(nameFilter ? [nameFilter] : []),
      ],
      // The payload travels by file, so host boot chatter on stdout can never
      // corrupt it. stderr passes through: a child crash must stay visible.
      { stdio: ['ignore', 'inherit', 'inherit'], env: process.env },
    );
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`engram scan failed (code=${code} signal=${signal})`));
    });
  });
  try {
    const wire = JSON.parse(await fs.readFile(outFile, 'utf8')) as {
      candidates: WireCandidate[];
      engramsScanned: number;
      skillSources: number;
      failed: Array<{ graphId: string; error: string }>;
    };
    return {
      ...wire,
      candidates: wire.candidates.map((c) => ({ ...c, present: new Set(c.present) })),
    };
  } finally {
    await fs.rm(outFile, { force: true });
  }
}

async function scan(
  host: GraphnosisHost,
  candidates: readonly DamagedCandidate[],
): Promise<DamagedSkill[]> {
  if (candidates.length === 0) return [];
  const ids = new Set(candidates.map((c) => c.sourceId));
  const events = await collectForgetTrails(host, ids);

  return candidates.map((c) => {
    const log = recoverFromForgetTrail(events, c.sourceId, c.present);
    return {
      graphId: c.graphId,
      sourceId: c.sourceId,
      label: c.label,
      liveNodes: c.present.size,
      recovered: log.texts,
      origin: log.texts.length > 0 ? 'oplog-preview' : 'none',
      ...(log.fromGraphId !== undefined ? { recoveredFrom: log.fromGraphId } : {}),
      truncated: log.truncated,
    } satisfies DamagedSkill;
  });
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
  if (mode === 'scan-engrams') return scanEngramsChild();
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

  // Pass 1 runs in a child process and exits before we boot anything here, so
  // the op-log read below starts from an empty heap and an unheld cortex lock.
  const { candidates, engramsScanned, skillSources, failed } =
    await runFindDamagedIsolated(nameFilter);

  console.log(
    `\nScanned ${engramsScanned} engram(s), ${skillSources} skill source(s)` +
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
  if (candidates.length === 0) {
    console.log('\nNo damaged skills found — every skill source has a body.\n');
    return;
  }
  console.log(
    `\nFound ${candidates.length} damaged skill(s):` +
    candidates.map((c) => `\n     ${c.label}  (${c.graphId})`).join('') +
    '\n\nReading the op-log forget trail — one streaming pass, filtered to these\n' +
    'sourceIds. On a multi-GB log this takes a while and prints nothing.\n',
  );
  // Only now do we take the cortex lock: the scan child has exited, so this
  // process starts clean and loads no engram until `apply` needs one.
  const host = await bootHost(cortexDir, passphrase);
  const items = await scan(host, candidates);
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
