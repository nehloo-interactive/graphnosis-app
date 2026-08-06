// Only file in the App that imports the `@nehloo/graphnosis` SDK directly.
// Verified against v0.2.3.

/**
 * Neutralize regex metacharacters in a user-supplied query before passing it to
 * SDK methods that internally call `expandQuery` / `new RegExp(word)`. Without
 * this, queries containing `+`, `*`, `?`, `(`, `[`, etc. throw "Invalid regular
 * expression: nothing to repeat / unmatched parentheses" — crashing the IPC call.
 *
 * We STRIP these characters (replace with a space) rather than escape them:
 * escaping (`\(`) doesn't survive the SDK's tokenizer, which splits words on
 * the backslash boundary and rebuilds per-word RegExps — re-exposing the bare
 * metachar and throwing anyway. Stripping is safe for lexical search (punctuation
 * is noise to TF-IDF) and better for embeddings than leaving backslashes in.
 */
function sanitizeQuery(q: string): string {
  return q.replace(/[.*+?^${}()|[\]\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

import { Graphnosis, serializeSubgraph, embedNodes } from '@nehloo/graphnosis';
import type { EmbeddingAdapter, EmbeddingIndex, GraphNode, NodeId } from '@nehloo/graphnosis';
import type {
  GraphnosisAdapter,
  GraphHandle,
  AppendDocumentInput,
  AppendDocumentOptions,
  AppendDocumentResult,
  ContradictionResult,
  BuildEmbeddingsAdapterOpts,
  QueryResult,
  RichQueryResult,
  CorrectionEdit,
} from './graphnosis-adapter.js';
import type { EmbedFn } from '@graphnosis-app/core/embeddings';
import { evidencePrefixOption } from './sdk-capabilities.js';

interface Internal extends GraphHandle {
  instance: Graphnosis;
  built: boolean;
}

/**
 * Outcome of a single correction. Plain scalars only — the SDK's
 * `CorrectionResult` stays inside this file, like every other SDK type here
 * (see the header note in graphnosis-adapter.ts: this module is the only one
 * that imports the SDK).
 *
 * Declared here rather than in graphnosis-adapter.ts only because the adapter
 * interface still types `applyCorrection` as `Promise<void>`; it belongs next
 * to `CorrectionEdit` once that declaration is widened.
 */
export interface CorrectionOutcome {
  /** The correction actually landed: the SDK applied it AND reported no errors. */
  applied: boolean;
  /** The node the correction targeted — i.e. `edit.nodeId`, echoed back. */
  nodeId: string;
  /**
   * The node that carries the corrected content AFTER the call.
   *
   * Equals `nodeId` for an in-place `edit` (SDK 0.8.0) and for `delete`.
   * Differs for `supersede` — and will differ for `edit` too once the SDK's
   * indelible edit lands, which is precisely the id the app has no way to
   * learn today. Callers that persist a node id (sources, skill step chains,
   * op-log targets) must follow this field, not `nodeId`.
   */
  resultNodeId: string;
  /** SDK counter — 1 when a supersede chain was written, else 0. */
  nodesSuperseded: number;
  /** Non-empty when the correction did NOT land. The SDK reports failure here, never by throwing. */
  errors: string[];
}

/**
 * Structural view of the SDK's `CorrectionResult` that is valid ACROSS SDK
 * VERSIONS. `edit` / `supersede` / `deleteNode` all return it.
 *
 *   - `applied` / `errors` — present on every version we support. This is the
 *     ONLY channel the SDK uses to report a refused correction; it does not
 *     throw (see `applyCorrectionChecked`).
 *   - `affectedNodeIds` — added in SDK 0.11.0. **ABSENT on the installed
 *     0.8.0**, whose `CorrectionResult` is exactly
 *     `{ applied, nodesAdded, nodesModified, nodesSuperseded, errors }`
 *     (verified in
 *     `node_modules/@nehloo/graphnosis/dist/core/corrections/correction-engine.d.ts`).
 *     Declared optional here for that reason, which is also what forces every
 *     read of it through an optional chain.
 *
 * The SDK's own `CorrectionResult` is assignable to this on both versions, so
 * no cast is needed at the call sites.
 */
type VersionedCorrectionResult = {
  applied: number;
  errors: string[];
  affectedNodeIds?: readonly string[];
};

/**
 * The node id that carries the corrected content AFTER an SDK correction.
 *
 * WHY THIS EXISTS. SDK 0.10.0 made `edit` INDELIBLE: rather than overwriting
 * the target in place it RETIRES the target and mints a NEW node. Code that
 * kept using the id it passed IN therefore holds a retired node from that
 * version on, while the corrected text sits on a node it never recorded.
 *
 * In this file that is not theoretical. `appendDocument`'s return value flows
 * straight into `host.insertNodeAt`, which splices those ids into
 * `sourceIndex.bySource[].nodeIds` (host.ts ~5026). Recording a retired id
 * there is exactly why trained-skill steps became unwalkable after an upgrade.
 *
 * SDK 0.11.0 exposes the answer as `CorrectionResult.affectedNodeIds` — the
 * ids the correction PRODUCED. Reading it defensively makes one expression
 * correct on both SDKs:
 *
 *   - 0.8.0: the field does not exist, `?.` yields `undefined`, and we return
 *     `targetId` — which is the RIGHT answer there, because the edit really
 *     was in place.
 *   - 0.11.0+: we return the minted node.
 *
 * The optional chain is load-bearing, not defensive style: `res.affectedNodeIds[0]`
 * would throw a TypeError on the installed 0.8.0.
 */
function liveNodeIdAfterCorrection(res: VersionedCorrectionResult, targetId: string): string {
  const produced = res.affectedNodeIds?.[0];
  return typeof produced === 'string' && produced.length > 0 ? produced : targetId;
}

/**
 * Did the correction actually land?
 *
 * `edit` / `supersede` / `deleteNode` NEVER throw — a refusal comes back as
 * `{ applied: 0, errors: ['...'] }`. `applied > 0` alone is not enough either:
 * a non-empty `errors` alongside a positive `applied` is a partial failure, and
 * is treated as failure here to match `applyCorrectionChecked`.
 */
function correctionLanded(res: VersionedCorrectionResult): boolean {
  return res.applied > 0 && res.errors.length === 0;
}

/** One-line failure text for a refused correction, for the sidecar's console. */
function correctionFailureText(res: VersionedCorrectionResult): string {
  return res.errors.length > 0 ? res.errors.join('; ') : 'the SDK applied no correction';
}

/**
 * Soft-delete a node and SAY SO WHEN IT DIDN'T HAPPEN.
 *
 * `deleteNode` is a correction like any other (SDK `correct()` →
 * `applyCorrection` → `applyDelete`), so it obeys the same contract the header
 * of this file spells out: it does NOT throw on refusal, it RETURNS
 * `{ applied: 0, errors: ['Node <id> not found'] }`. Every cleanup site in
 * `appendDocument` used to wrap the call in a try/catch whose catch body was
 * the single word `ignore` — a handler for an exception that cannot happen,
 * wrapped around a return value nobody read. Net effect: a delete that
 * silently did not occur.
 *
 * That is not cosmetic. These calls exist to remove nodes the app has already
 * decided the user must never see: sourceRef-header artifacts and merged skill
 * fragments. A refused delete leaves such a node LIVE — and, because the delete
 * never ran, at its full ingest confidence, so no recall-side confidence filter
 * screens it out — while the id is dropped from `newNodeIds` and therefore from
 * the source's node list. The graph and what the app believes about the graph
 * diverge, permanently and invisibly.
 *
 * Returns whether the delete landed so a caller can act on it; every current
 * caller only reports, because each one is best-effort cleanup running inside
 * an append the user asked for and that otherwise SUCCEEDED (see each site).
 *
 * `consequence` is the site-specific tail of the log line, matching the
 * `… refused for <id>: <why> — <what that means>` shape the correction sites
 * in this file already use.
 */
function deleteNodeReporting(g: Graphnosis, nodeId: string, reason: string, consequence: string): boolean {
  const res: VersionedCorrectionResult = g.deleteNode(nodeId, reason);
  if (correctionLanded(res)) return true;
  console.error(
    `[graphnosis-sidecar] deleteNode refused for ${nodeId} (${reason}): ${correctionFailureText(res)} — ${consequence}`,
  );
  return false;
}

export class GraphnosisImpl implements GraphnosisAdapter {
  async create(graphId: string): Promise<Internal> {
    return { graphId, instance: new Graphnosis({ name: graphId }), built: false };
  }

  async loadFromBuffer(graphId: string, buffer: Uint8Array, hmacKey?: Uint8Array): Promise<Internal> {
    const instance = new Graphnosis({ name: graphId });
    // The SDK's fromBuffer takes a Node Buffer and a fail-closed hmacKey policy.
    instance.fromBuffer(Buffer.from(buffer), hmacKey ? { hmacKey: Buffer.from(hmacKey) } : undefined);
    return { graphId, instance, built: true };
  }

  async toBuffer(handle: GraphHandle, hmacKey?: Uint8Array): Promise<Uint8Array> {
    const h = handle as Internal;
    // Build must have happened at least once before serializing. Critically,
    // we update h.built here too — previously we built the SDK graph but
    // forgot to flip our local flag, which left subsequent ingests routing
    // through addPreBuild and throwing for kinds (e.g. PDF) that don't have
    // a pre-build form.
    if (!h.built) {
      h.instance.build(h.graphId);
      h.built = true;
    }
    const buf = h.instance.toBuffer(hmacKey ? { hmacKey: Buffer.from(hmacKey) } : undefined);
    return new Uint8Array(buf);
  }

  async build(handle: GraphHandle): Promise<void> {
    const h = handle as Internal;
    // fromBuffer() materializes the graph and clears documents[]. The SDK's
    // build() discards the current graph and rebuilds from documents — calling
    // it on an already-built handle wipes every node. Oplog reconcile calls
    // build() to ensure a fresh graph is materialized before replay; that
    // must be a no-op for loadFromBuffer handles (skills engrams with tail
    // oplog events were hitting this on every boot → 0 nodes in 3D).
    if (h.built) return;
    h.instance.build(h.graphId);
    h.built = true;
  }

  async appendDocument(handle: GraphHandle, input: AppendDocumentInput, opts: AppendDocumentOptions = {}): Promise<AppendDocumentResult> {
    const h = handle as Internal;
    // Fresh graph: most kinds use add* (chainable) then build once. PDF doesn't
    // have a pre-build form in the SDK, so for PDF specifically we build an
    // empty graph first and route through the post-build append path. This
    // makes "first file is a PDF" Just Work instead of throwing.
    //
    // chunkSize: only the post-build path can honor it (the SDK's `addX`
    // pre-build chainables don't take chunk options yet). For pre-build
    // we route through `addX` → `build()`, which uses the SDK's default
    // chunking. Acceptable tradeoff: pre-build only runs on the very
    // first append to a fresh graph; all subsequent appends use the
    // chunk-aware post-build path.
    if (!h.built) {
      if (input.kind === 'pdf') {
        h.instance.build(h.graphId);
        h.built = true;
        // Fall through to the post-build path below.
      } else {
        this.addPreBuild(h.instance, input);
        h.instance.build(h.graphId);
        h.built = true;
        const newNodeIds = nodeIdsBySource(h.instance, input.sourceRef);
        return { newNodeIds, newNodes: newNodeIds.length, contradictions: [] };
      }
    }

    const before = new Set(h.instance.graph.nodes.keys());
    let result = await this.appendPostBuild(h.instance, input, opts);
    let newNodeIds: string[] = [];
    for (const id of h.instance.graph.nodes.keys()) if (!before.has(id)) newNodeIds.push(id);

    // Fallback for text/markdown shapes that produce zero nodes on the
    // first pass. Two failure modes, one retry per shape:
    //
    //   - kind='text' produced 0 nodes: the SDK's appendText sometimes
    //     skips structured short text with punctuation / URLs / numbers
    //     that doesn't look like prose to its splitter. Retry as
    //     markdown with a synthetic `# <label>` header derived from the
    //     source ref.
    //
    //   - kind='markdown' produced 0 nodes: the user (or an MCP client
    //     like `remember`) passed prose without any `#` heading. SDK
    //     0.5.1+ handles this internally via a synthetic section in
    //     parseMarkdown, but older SDKs drop the body entirely. Retry
    //     as text — host.ingest() doesn't differentiate node counts by
    //     kind, so the side-effect is identical from the user's POV.
    //
    // Both retries use the same `input.sourceRef` so the per-source
    // dedup key stays stable across the original and retry paths.
    if (newNodeIds.length === 0 && typeof input.content === 'string') {
      const fallbackBefore = new Set(h.instance.graph.nodes.keys());
      const fallbackOpts = opts.chunkSize ? { chunkSize: opts.chunkSize } : undefined;
      if (input.kind === 'text') {
        const label = labelFromSourceRef(input.sourceRef);
        const wrapped = `# ${label}\n\n${input.content}`;
        result = h.instance.appendMarkdown(wrapped, input.sourceRef, fallbackOpts);
      } else if (input.kind === 'markdown') {
        // Bare prose dressed as markdown — strip whatever pseudo-markdown
        // shape the caller used and pass through appendText, which has
        // its own "wrap with synthetic header" path inside the SDK.
        result = h.instance.appendText(input.content, input.sourceRef, fallbackOpts);
      }
      for (const id of h.instance.graph.nodes.keys()) {
        if (!fallbackBefore.has(id)) newNodeIds.push(id);
      }
    }

    // ── SDK sourceRef-header artifact filter ─────────────────────────────────
    // Root cause: the SDK's `appendText` is implemented as
    //   parseMarkdown(`# ${source}\n\n${text}`, source)
    // — it prepends a synthetic H1 whose CONTENT is the raw sourceRef. After
    // parseMarkdown chunks the wrapped string, the H1 ends up as its own
    // node alongside the real body chunk(s). For every text-mode insert
    // (every host.insertNodeAt call, plus every ingestClip "short text"
    // path), we therefore get one phantom node whose content is literally
    // "skill:<ts>:<label>" or "clip:<ts>:<label>" — never useful, always
    // surfaces in the Trained Output editor as a duplicate junk row.
    //
    // The markdown fallback path above ALSO triggers this (it composes
    // `# ${label}\n\n${content}` itself), but there `label` is the
    // human-readable suffix, not the full sourceRef — so the resulting
    // H1 node carries the friendly label, which is benign / sometimes
    // even desirable. We only strip nodes whose content equals the FULL
    // sourceRef (the artifact form).
    //
    // We strip by: (a) deleting the artifact node from the SDK graph via
    // applyCorrection so it doesn't pollute future queries, recalls, or
    // exports; (b) excluding its id from the returned newNodeIds so the
    // caller's source.nodeIds list never references it.
    if (newNodeIds.length > 0) {
      const keep: string[] = [];
      const drop: string[] = [];
      for (const id of newNodeIds) {
        const n = h.instance.graph.nodes.get(id);
        if (n && typeof n.content === 'string' && n.content.trim() === input.sourceRef.trim()) {
          drop.push(id);
        } else {
          keep.push(id);
        }
      }
      if (drop.length > 0) {
        // Two regimes, two strategies:
        //
        //   keep.length > 0 (the common case for real prose):
        //     parseMarkdown produced an H1 artifact AND one or more body
        //     chunks. Delete the artifact, return only the body ids.
        //     Clean separation.
        //
        //   keep.length === 0 (short / sparse / dedup'd content):
        //     parseMarkdown collapsed the wrapped string into a single
        //     node — its content is the H1 (the raw sourceRef), and the
        //     short body got merged into section metadata rather than
        //     getting its own chunk. If we delete this lone node, we
        //     return zero newNodeIds and host.insertNodeAt throws
        //     "SDK returned no node ids", which surfaces as failed
        //     paragraph inserts and broken skill saves.
        //
        //     Instead: rewrite the artifact's content in-place to the
        //     caller's input. The node already exists, is wired into
        //     the SDK graph, and has a valid id — flipping its content
        //     via `edit` is one call. The caller sees a successful
        //     insert with the real text; we never end up with both a
        //     phantom node AND a "couldn't save" failure.
        const inputText = typeof input.content === 'string' ? input.content.trim() : '';
        // appendText always produces TWO artifact nodes with content = sourceRef:
        // one `document` chunk and one `section` chunk, both with identical content.
        // The original drop.length === 1 condition therefore never fired. Using >= 1
        // catches the real case (drop.length === 2) and any future SDK variations.
        const canRewrite = keep.length === 0 && drop.length >= 1 && inputText.length > 0;

        if (canRewrite) {
          const id = drop[0]!;
          // No try/catch: `edit` never throws. A refusal is REPORTED, in the
          // return value, and the branch below is the handler for it — it used
          // to sit inside a `catch` that could never run.
          const res: VersionedCorrectionResult =
            h.instance.edit(id, inputText, 'SDK appendText artifact rewritten to real content');
          if (correctionLanded(res)) {
            // Delete any extra artifact nodes beyond the one we rewrote.
            // appendText produces document + section (same sourceRef content),
            // so there are typically 2 entries in drop; keep only the rewritten one.
            //
            // Report, do not throw: the insert the user asked for has ALREADY
            // landed at this point (the rewrite above succeeded and its id is
            // what we return). Aborting here would fail a completed operation
            // over failed hygiene. We also keep looping so a refusal on one
            // duplicate doesn't skip the attempt on the rest.
            for (const extraId of drop.slice(1)) {
              deleteNodeReporting(
                h.instance,
                extraId,
                'SDK appendText duplicate sourceRef-header artifact',
                'a node whose content is the raw sourceRef stays live in the graph and will surface in queries, recalls and exports, with nothing pointing at it',
              );
            }
            // NOT `id`. On SDK >= 0.10.0 `edit` retired `id` and minted a
            // replacement carrying the real text; handing `id` back would put
            // a retired node into the caller's source.nodeIds. On 0.8.0 the
            // edit was in place and this resolves to `id` anyway.
            newNodeIds = [liveNodeIdAfterCorrection(res, id)];
          } else {
            // Edit refused (unknown id, already-retired target, engine
            // refusal). Fall through to the delete path; the caller will throw
            // the pre-filter "no node ids" error rather than record a node
            // whose content is the raw sourceRef.
            console.error(`[graphnosis-sidecar] appendText artifact rewrite refused for ${id}: ${correctionFailureText(res)}`);
            // Report, do not throw: this branch already propagates. Setting
            // `newNodeIds = []` below makes host.insertNodeAt raise "SDK
            // returned no node ids" (the throw in `host.ts` `insertNodeAt`),
            // so the user is told the
            // insert failed either way. Throwing from inside the loop would
            // only replace that error with a less specific one AND skip the
            // remaining artifact deletes, leaving more junk behind, so the
            // log is the added signal here: it names the nodes that leaked.
            for (const dropId of drop) {
              deleteNodeReporting(
                h.instance,
                dropId,
                'SDK appendText sourceRef-header artifact',
                'the artifact node stays live in the graph after a rewrite that also failed; the insert itself fails at the caller',
              );
            }
            newNodeIds = [];
          }
        } else {
          for (const id of drop) {
            try {
              // SDK's own soft-delete — sets confidence to 0. We bypass
              // our adapter wrapper because this whole filter runs
              // inside an in-flight appendDocument and the wrapper
              // would re-trigger build() / settle paths we've already
              // done.
              h.instance.deleteNode(id, 'SDK appendText sourceRef-header artifact');
            } catch {
              // If the SDK refuses the delete, leave the node in the
              // graph but still exclude its id from the returned
              // newNodeIds so the caller's source.nodeIds stays clean.
              // Worst case: a stale orphan node with no source pointer —
              // recall-side confidence filters will ignore it.
            }
          }
          newNodeIds = keep;
        }
      }
    }

    // ── Single-node guarantee (opt-in) ───────────────────────────────────────
    // Skill inserts (steps, goal lines, recipes) are ONE semantic unit each.
    // The SDK's chunker may still split a single step across multiple nodes
    // at a sentence boundary it mis-detects — most often a step ending in an
    // abbreviation period ("...letters of support, etc.) and verify..." →
    // two nodes). When `singleNode` is set we collapse to exactly one node
    // carrying the verbatim input text. Runs AFTER the sourceRef-artifact
    // filter so we only ever operate on real body nodes.
    if (opts.singleNode && typeof input.content === 'string' && newNodeIds.length > 0) {
      const verbatim = input.content;
      const firstId = newNodeIds[0]!;
      if (newNodeIds.length > 1) {
        const res: VersionedCorrectionResult = h.instance.edit(firstId, verbatim, 'skill single-node insert');
        if (correctionLanded(res)) {
          // Report, do not throw: the merge above landed, so the step the user
          // saved exists and its id must be returned. A failed fragment delete
          // is the worst of the three for the user, though — the merged node
          // now carries the WHOLE step and the undeleted fragment still carries
          // a piece of it, so a recall can return the same step twice, once
          // truncated. Hence a named consequence rather than a bare log.
          for (const extraId of newNodeIds.slice(1)) {
            deleteNodeReporting(
              h.instance,
              extraId,
              'skill single-node insert — fragment merged',
              'the fragment stays live and duplicates text that also sits on the merged node — recall and skill walks can return this step twice',
            );
          }
          // The merged step text lives on whatever node the correction
          // PRODUCED, which on SDK >= 0.10.0 is a NEW node — `firstId` is now
          // retired. This id goes straight into the source's nodeIds, so
          // returning `firstId` here is precisely what left imported skill
          // steps pointing at retired nodes and made them unwalkable.
          newNodeIds = [liveNodeIdAfterCorrection(res, firstId)];
        } else {
          // The SDK refused the merge. It says so by RETURNING, which the old
          // `catch` could not observe. Behavior is otherwise unchanged: keep
          // the first fragment rather than splicing N ids in for one step.
          console.error(`[graphnosis-sidecar] skill single-node merge refused for ${firstId}: ${correctionFailureText(res)} — keeping the first chunk only`);
          newNodeIds = [firstId];
        }
      } else {
        // Exactly one node — make sure its content is the verbatim input
        // (the SDK may have trimmed/normalized it during chunking).
        const n = h.instance.graph.nodes.get(firstId);
        if (n && typeof n.content === 'string' && n.content !== verbatim) {
          // The `catch { /* ignore */ }` that used to wrap this call guarded an
          // exception `edit` cannot throw while hiding the errors it always
          // can return. Check the result instead.
          const res: VersionedCorrectionResult = h.instance.edit(firstId, verbatim, 'skill single-node insert — verbatim');
          if (correctionLanded(res)) {
            // This assignment is the substantive fix at this site. The old code
            // never updated newNodeIds even on SUCCESS, so on SDK >= 0.10.0 the
            // caller recorded the retired `firstId` while the verbatim step
            // text sat on a minted node nobody held the id for.
            newNodeIds = [liveNodeIdAfterCorrection(res, firstId)];
          } else {
            console.error(`[graphnosis-sidecar] skill single-node verbatim rewrite refused for ${firstId}: ${correctionFailureText(res)} — keeping the SDK's chunked text`);
          }
        }
      }
    }

    return { newNodeIds, newNodes: result.newNodes, contradictions: result.contradictions };
  }

  /** Full-graph contradiction detection via the SDK's reflection engine.
   *  Reused by the brain engine's periodic contradiction scan — no
   *  reimplementation of the entity/TF-IDF logic. Gracefully returns [] when
   *  the graph isn't built or lacks a TF-IDF index (reflect would no-op). */
  reflectGraph(handle: GraphHandle): ContradictionResult[] {
    const h = handle as Internal;
    if (!h.built) return [];
    // reflect() reads this.graph.tfidfIndex; if absent, detectContradictions
    // short-circuits to [] — guard so we never throw on an unbuilt index.
    const g = h.instance as unknown as { graph?: { tfidfIndex?: unknown }; reflect?: () => { contradictions?: Array<{ nodeA: string; nodeB: string; sharedEntities?: string[]; description?: string; detectedAt?: number }> } };
    if (!g.graph?.tfidfIndex || typeof g.reflect !== 'function') return [];
    try {
      const result = g.reflect();
      return (result.contradictions ?? []).map((c) => ({
        nodeA: c.nodeA,
        nodeB: c.nodeB,
        sharedEntities: c.sharedEntities ?? [],
        description: c.description ?? 'Potential contradiction',
        detectedAt: c.detectedAt ?? Date.now(),
      }));
    } catch {
      return [];
    }
  }

  async query(handle: GraphHandle, query: string, k: number): Promise<QueryResult[]> {
    const h = handle as Internal;
    if (!h.built) h.instance.build(h.graphId);
    const safeQuery = sanitizeQuery(query);
    // Prefer hybrid (TF-IDF + embeddings) when an embedding index is attached — covers
    // semantic queries where the user's wording doesn't share tokens with the content.
    // Fall back to TF-IDF when no embeddings are available, or if hybrid throws (e.g.,
    // adapter id mismatch between cached and current embed function).
    const res = h.instance.hasEmbeddings()
      ? await h.instance.queryHybrid(safeQuery, { maxNodes: k, ...GraphnosisImpl.recallEvidenceGuard() }).catch((e: Error) => {
          console.error(`[graphnosis-sidecar] queryHybrid failed (${e.message}) — falling back to TF-IDF`);
          return h.instance.query(safeQuery, { maxNodes: k, ...GraphnosisImpl.recallEvidenceGuard() });
        })
      : h.instance.query(safeQuery, { maxNodes: k, ...GraphnosisImpl.recallEvidenceGuard() });
    const seedScores = new Map<string, number>(
      (res.seeds as Array<{ nodeId: string; score: number }>).map(s => [s.nodeId, s.score]),
    );
    // Only include seeds — structural expansion nodes carry score=0 and add noise.
    return res.subgraph.nodes
      .filter((n: GraphNode) => seedScores.has(n.id))
      .map((n: GraphNode) => ({
        nodeId: n.id,
        score: seedScores.get(n.id)!,
        text: n.content,
        type: n.type,
        source: {
          file: n.source.file,
          ...(n.source.line !== undefined ? { line: n.source.line } : {}),
          ...(n.source.section !== undefined ? { section: n.source.section } : {}),
        },
      }));
  }

  /**
   * PURE TF-IDF query. `query()` above prefers `queryHybrid` whenever
   * `hasEmbeddings()` is true — and that is true on the stub adapter, whose
   * vectors are a sha256 of the text. So "fall back to keyword matching" via
   * `query()` was not actually a fallback: the hybrid seed pool still mixed
   * in embedding scores from the engine's UNNORMALISED dot-product scorer.
   *
   * Measured before this method existed: `check_duplicate` on a stub host
   * reported a hit at "Score 14.50" while labelling it a keyword match. TF-IDF
   * cosine cannot exceed 1.0, so 14.50 could only have come from the vectors
   * the label said were not being used.
   *
   * `instance.query()` is the engine's TF-IDF-only path — `findSeeds` scores
   * with `cosineSimilarity`, which is normalized and bounded to [0, 1].
   */
  queryLexical(handle: GraphHandle, query: string, k: number): QueryResult[] {
    const h = handle as Internal;
    if (!h.built) h.instance.build(h.graphId);
    const safeQuery = sanitizeQuery(query);
    const res = h.instance.query(safeQuery, { maxNodes: k, ...GraphnosisImpl.recallEvidenceGuard() });
    const seedScores = new Map<string, number>(
      (res.seeds as Array<{ nodeId: string; score: number }>).map((s) => [s.nodeId, s.score]),
    );
    return res.subgraph.nodes
      .filter((n: GraphNode) => seedScores.has(n.id))
      .map((n: GraphNode) => ({
        nodeId: n.id,
        score: seedScores.get(n.id)!,
        text: n.content,
        type: n.type,
        source: {
          file: n.source.file,
          ...(n.source.line !== undefined ? { line: n.source.line } : {}),
          ...(n.source.section !== undefined ? { section: n.source.section } : {}),
        },
      }));
  }

  async queryDirect(handle: GraphHandle, query: string, k: number): Promise<QueryResult[] | null> {
    const h = handle as Internal;
    if (!h.built) h.instance.build(h.graphId);
    // No embedding index → direct similarity is unavailable; the caller
    // chooses the fallback (check_duplicate uses the TF-IDF path with a
    // stricter threshold and says so).
    if (!h.instance.hasEmbeddings()) return null;
    const safeQuery = sanitizeQuery(query);
    try {
      // similarity:'embeddings' skips the TF-IDF seed pool entirely, and the
      // query embedding is computed from the raw text BEFORE decomposition /
      // synonym expansion — so seed scores are plain text-vs-node cosines.
      const res = await h.instance.queryHybrid(safeQuery, { maxNodes: k, similarity: 'embeddings', ...GraphnosisImpl.recallEvidenceGuard() });
      const seedScores = new Map<string, number>(
        (res.seeds as Array<{ nodeId: string; score: number }>).map(s => [s.nodeId, s.score]),
      );
      // Seeds only — structural expansion nodes carry score=0 and add noise.
      return res.subgraph.nodes
        .filter((n: GraphNode) => seedScores.has(n.id))
        .map((n: GraphNode) => ({
          nodeId: n.id,
          score: seedScores.get(n.id)!,
          text: n.content,
          type: n.type,
          source: {
            file: n.source.file,
            ...(n.source.line !== undefined ? { line: n.source.line } : {}),
            ...(n.source.section !== undefined ? { section: n.source.section } : {}),
          },
        }));
    } catch (e) {
      console.error(`[graphnosis-sidecar] queryDirect failed (${(e as Error).message}) — treating direct similarity as unavailable`);
      return null;
    }
  }

  /**
   * Evidence namespaces ordinary recall must not traverse ACROSS.
   *
   * A trained skill is a chain of step nodes joined by `precedes` edges tagged
   * `skill:seq`. Those nodes share the lexical index with ordinary knowledge, so
   * a factual query can seed into one step on vocabulary overlap and then unroll
   * the WHOLE procedure into a node budget meant for facts. Measured on a mock
   * cortex: a 12-step skill put 4 steps into a 20-node subgraph — 20% of the
   * budget spent on "Step 4. Internal procedure action 3 — checkpoint, verify".
   *
   * This blocks PROPAGATION, never membership. A skill step reached as a seed
   * still scores and still surfaces — asking "how do I ship a release?" still
   * finds the procedure. Traversal simply does not walk the chain behind it,
   * which is what was displacing knowledge.
   *
   * Set here, at the sidecar's retrieval boundary, rather than in the SDK: the
   * SDK is generic and has no opinion about what an evidence namespace means.
   * The app owns `skill:`, so the app declares it. Skill dispatch and walk do
   * not come through this path and are unaffected.
   *
   * NOT UNCONDITIONAL — see `recallEvidenceGuard()` directly below.
   */
  private static readonly RECALL_BLOCKED_EVIDENCE = ['skill:'];

  /**
   * The evidence guard as an options fragment, or nothing.
   *
   * `blockedEvidencePrefixes` is an SDK 0.8.0 option and app 1.31.0 ships on
   * `@nehloo/graphnosis: ^0.7.4`, which (caret on a 0.x version pins the minor)
   * can never resolve to 0.8.0. On 0.7.4 the key is not read — passing it is a
   * silent no-op, not an error — so this method omits it and the process states
   * the loss ONCE AT BOOT via `main.ts`, next to the semantic-similarity
   * capability line, rather than shipping a guard that is present in the source
   * and absent in effect.
   *
   * The capability is decided by `sdk-capabilities.ts` on the RESOLVED SDK's
   * declared version, never on what a query returns: a 0.8.0 query with no
   * skill overlap returns a byte-identical node set with and without the guard
   * (measured in b19859f1), so an outcome-based probe cannot tell "feature
   * absent" from "feature present and not triggered".
   *
   * WHAT 1.31.0 THEREFORE LOSES: a factual query that seeds into one step of a
   * trained skill will unroll the chain behind it. Measured on a mock cortex in
   * b19859f1: a 12-step skill put 4 steps into a 20-node subgraph — 20% of a
   * budget meant for facts. Bounding recovered 3 of those 4 slots. That is the
   * bound being given up, and it returns with no code change the moment the pin
   * moves to ^0.8.0 or later.
   */
  private static recallEvidenceGuard(): object {
    return evidencePrefixOption(GraphnosisImpl.RECALL_BLOCKED_EVIDENCE);
  }

  async queryRich(handle: GraphHandle, query: string, k: number): Promise<RichQueryResult> {
    const h = handle as Internal;
    if (!h.built) h.instance.build(h.graphId);
    const safeQuery = sanitizeQuery(query);
    const res = h.instance.hasEmbeddings()
      ? await h.instance.queryHybrid(safeQuery, { maxNodes: k, ...GraphnosisImpl.recallEvidenceGuard() }).catch((e: Error) => {
          console.error(`[graphnosis-sidecar] queryHybrid failed (${e.message}) — falling back to TF-IDF`);
          return h.instance.query(safeQuery, { maxNodes: k, ...GraphnosisImpl.recallEvidenceGuard() });
        })
      : h.instance.query(safeQuery, { maxNodes: k, ...GraphnosisImpl.recallEvidenceGuard() });

    const scores = new Map<string, number>(
      res.seeds.map((s: { nodeId: string; score: number }) => [s.nodeId, s.score]),
    );

    // Only include seed-scored nodes — structural expansion nodes have score=0 and add noise.
    const candidates: QueryResult[] = res.subgraph.nodes
      .filter((n: GraphNode) => scores.has(n.id))
      .map((n: GraphNode) => ({
        nodeId: n.id,
        score: scores.get(n.id)!,
        text: n.content,
        type: n.type,
        source: {
          file: n.source.file,
          ...(n.source.line !== undefined ? { line: n.source.line } : {}),
          ...(n.source.section !== undefined ? { section: n.source.section } : {}),
        },
      }));

    // Capture the SDK subgraph data in a closure so the adapter surface stays
    // free of SDK types. The host calls rich.serialize(selectedIds) after
    // federation budget filtering to get a prompt block for exactly those nodes.
    const sdkNodes = res.subgraph.nodes as GraphNode[];
    const sdkDirected = res.subgraph.directedEdges as Array<{ id: string; from: string; to: string; type: string; weight: number }>;
    const sdkUndirected = res.subgraph.undirectedEdges as Array<{ id: string; nodes: [string, string]; type: string; weight: number }>;

    const rich: RichQueryResult['rich'] = {
      directedEdges: sdkDirected.map(e => ({ id: e.id, from: e.from, to: e.to, type: e.type as import('./graphnosis-adapter.js').DirectedEdgeType, weight: e.weight })),
      undirectedEdges: sdkUndirected.map(e => ({ id: e.id, nodes: e.nodes, type: e.type as import('./graphnosis-adapter.js').UndirectedEdgeType, weight: e.weight })),
      scores,
      serialize(nodeIds: Set<string>): string {
        const filteredNodes = sdkNodes.filter(n => nodeIds.has(n.id));
        const filteredDirected = sdkDirected.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));
        const filteredUndirected = sdkUndirected.filter(e => nodeIds.has(e.nodes[0]) && nodeIds.has(e.nodes[1]));
        return serializeSubgraph(
          filteredNodes,
          filteredDirected as Parameters<typeof serializeSubgraph>[1],
          filteredUndirected as Parameters<typeof serializeSubgraph>[2],
          scores,
        ).serialized;
      },
      getNodeData(nodeIds: Set<string>): import('./graphnosis-adapter.js').NodeMergeData[] {
        return sdkNodes
          .filter(n => nodeIds.has(n.id))
          .map(n => ({
            id: n.id,
            content: n.content,
            type: n.type,
            entities: n.entities ?? [],
            score: scores.get(n.id) ?? 0,
          }));
      },
      getRenderData(nodeIds: Set<string>): import('./graphnosis-adapter.js').RenderNodeData[] {
        // Same fields serializeSubgraph reads, handed over as plain scalars so
        // the passage renderer (host/recall-passages.ts) stays SDK-free and
        // unit-testable with canned strings.
        return sdkNodes
          .filter(n => nodeIds.has(n.id))
          .map(n => {
            const meta = (n.metadata ?? {}) as Record<string, unknown>;
            const sessionDate = typeof meta.sessionDate === 'string' ? meta.sessionDate : undefined;
            const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : undefined;
            const claims = typeof meta.claims === 'string' ? meta.claims : undefined;
            return {
              id: n.id,
              content: n.content,
              type: n.type,
              score: scores.get(n.id) ?? 0,
              ...(n.source?.section !== undefined ? { section: n.source.section } : {}),
              ...(sessionDate !== undefined ? { sessionDate } : {}),
              ...(sessionId !== undefined ? { sessionId } : {}),
              ...(claims !== undefined ? { claims } : {}),
            };
          });
      },
    };

    return { candidates, rich };
  }

  /**
   * The interface entry point. Now returns the outcome — the shim that existed
   * only because `GraphnosisAdapter.applyCorrection` was declared
   * `Promise<void>` is gone, and every caller gets the outcome for free.
   *
   * (TypeScript would not accept a `Promise<T>` override for a `Promise<void>`
   * member: `Promise` is invariant through its type argument, so the
   * void-returning-function special case does not apply. Widening the interface
   * was therefore a prerequisite, not a nicety.)
   */
  async applyCorrection(handle: GraphHandle, edit: CorrectionEdit): Promise<CorrectionOutcome> {
    return this.applyCorrectionChecked(handle, edit);
  }

  /**
   * Apply a correction and REPORT WHAT HAPPENED.
   *
   * Do not go back to discarding this result. The SDK's correction API does
   * not signal failure by throwing: `Graphnosis.edit` / `supersede` /
   * `deleteNode` all funnel through `correct()`, which on failure RETURNS
   * `{ applied: 0, nodesSuperseded: 0, errors: ['...'] }`. Two concrete bugs
   * come out of throwing that away:
   *
   *   1. A correction that never landed (unknown node id, node already
   *      retired, engine refusal) is reported to the user as success, and the
   *      host writes an op-log event for a mutation the graph never took. The
   *      log then disagrees with the graph, which is exactly the state
   *      oplog replay cannot recover from.
   *
   *   2. The caller cannot learn which node now carries the corrected content.
   *      Already true on 0.8.0 for `supersede`: it mints a NEW node and
   *      `correct()` drops the new id on the floor (see the SDK's `correct()`
   *      — it maps the engine's `affectedNodeId` away). SDK 0.10.0 makes
   *      `edit` indelible the same way: the target is retired and a
   *      replacement node is minted. Any caller relying on "the node id stays
   *      the same after `edit`" silently starts pointing at a retired node on
   *      that upgrade — see `liveNodeIdAfterCorrection` for the three call
   *      sites in `appendDocument` that did exactly that.
   *
   * `resultNodeId` is resolved two ways, in order:
   *
   *   1. `CorrectionResult.affectedNodeIds` (SDK 0.11.0+) — the SDK naming the
   *      node the correction produced. Authoritative when present.
   *   2. Observing the node map around the SDK call. Older SDKs (including the
   *      installed 0.8.0) do not carry the field at all, and this is the only
   *      technique available there.
   *
   * The observation is a size check, not a key-set diff: corrections in this
   * SDK are soft (a retired node keeps its entry), so `graph.nodes` is
   * append-only across a correction and its insertion order is stable. If the
   * size grew, the minted node is the first entry past the old size. That
   * keeps the common in-place case at O(1) with no allocation, which matters
   * because the brain engine applies corrections in batches.
   */
  async applyCorrectionChecked(handle: GraphHandle, edit: CorrectionEdit): Promise<CorrectionOutcome> {
    const h = handle as Internal;
    if (!h.built) h.instance.build(h.graphId);

    const sizeBefore = h.instance.graph.nodes.size;

    let result: VersionedCorrectionResult & { nodesSuperseded: number };

    switch (edit.kind) {
      case 'edit':
        if (edit.content === undefined) throw new Error('edit requires content');
        result = h.instance.edit(edit.nodeId, edit.content, edit.reason);
        break;
      case 'supersede':
        if (edit.content === undefined) throw new Error('supersede requires content');
        result = h.instance.supersede(edit.nodeId, edit.content, edit.reason);
        break;
      case 'delete':
        result = h.instance.deleteNode(edit.nodeId, edit.reason);
        break;
    }

    // Which node carries the corrected content now? Prefer the SDK's own
    // answer (`affectedNodeIds`, 0.11.0+); it falls back to the target, which
    // is correct for an in-place `edit` on 0.8.0 and for `delete` on any
    // version.
    let resultNodeId = liveNodeIdAfterCorrection(result, edit.nodeId);
    // No field to read (0.8.0) but the SDK minted a node anyway — supersede on
    // any version, indelible edit on 0.10.0. It is the first entry past the
    // pre-call size.
    if (!result.affectedNodeIds?.length && h.instance.graph.nodes.size > sizeBefore) {
      let i = 0;
      for (const id of h.instance.graph.nodes.keys()) {
        if (i++ < sizeBefore) continue;
        resultNodeId = id;
        break;
      }
    }

    return {
      applied: result.applied > 0 && result.errors.length === 0,
      nodeId: edit.nodeId,
      resultNodeId,
      nodesSuperseded: result.nodesSuperseded,
      errors: result.errors,
    };
  }

  async buildEmbeddings(handle: GraphHandle, opts: BuildEmbeddingsAdapterOpts): Promise<void> {
    const h = handle as Internal;
    if (!h.built) h.instance.build(h.graphId);
    const adapter: EmbeddingAdapter = {
      id: opts.id,
      dimensions: opts.dimensions,
      embed: async (texts: string[]) => Promise.all(texts.map(t => opts.embed(t))),
    };
    // Pass batchSize through to the SDK. The SDK accepts either a number
    // or a preset string ('small' | 'medium' | 'large' | 'auto') and
    // resolves the preset to a numeric items-per-call internally.
    await h.instance.buildEmbeddings(
      opts.batchSize !== undefined
        ? { adapter, batchSize: opts.batchSize }
        : { adapter },
    );
  }

  /**
   * Embed exactly `nodeIds` into the index that is already attached — see the
   * contract on `GraphnosisAdapter.embedNodeIds`.
   *
   * Why this exists at all: `buildEmbeddings` above delegates to the SDK's
   * `attachEmbeddings`, which allocates a FRESH `EmbeddingIndex` and walks
   * `graph.nodes` in full. It is a rebuild, not an upsert. The correction path
   * changes one node's text and must not pay a whole-graph scan for it.
   *
   * The index lives on the SDK instance's internal `built` object — the same
   * (and only) access path `getNodeEmbeddings` documents below. `embedNodes`
   * is a public SDK export and upserts straight into `index.vectors`, so a
   * node that is already embedded gets its vector REPLACED, which is what an
   * in-place `edit` needs (its old vector still describes the old text).
   */
  async embedNodeIds(handle: GraphHandle, nodeIds: string[], opts: BuildEmbeddingsAdapterOpts): Promise<number> {
    const h = handle as Internal;
    if (!h.built || !h.instance.hasEmbeddings()) return 0;
    const index = (h.instance as unknown as { built?: { embeddingIndex?: EmbeddingIndex } }).built?.embeddingIndex;
    if (!index) return 0;
    const items: Array<{ nodeId: NodeId; text: string }> = [];
    for (const id of new Set(nodeIds)) {
      const node = h.instance.graph.nodes.get(id);
      if (!node) continue;
      // Same exclusions attachEmbeddings applies: structural nodes are
      // filtered out of the serialized prompt anyway, and providers reject
      // empty input. Embedding them here would drift the index away from
      // what a full rebuild produces.
      if (node.type === 'document' || node.type === 'section') continue;
      if (!node.content || !node.content.trim()) continue;
      items.push({ nodeId: id, text: node.content });
    }
    if (items.length === 0) return 0;
    const adapter: EmbeddingAdapter = {
      id: opts.id,
      dimensions: opts.dimensions,
      embed: async (texts: string[]) => Promise.all(texts.map(t => opts.embed(t))),
    };
    await embedNodes(index, adapter, items, { intent: 'document' });
    return items.length;
  }

  allNodeIds(handle: GraphHandle): string[] {
    const h = handle as Internal;
    if (!h.built) return [];
    return [...h.instance.graph.nodes.keys()];
  }

  hasEmbeddings(handle: GraphHandle): boolean {
    const h = handle as Internal;
    return h.built && h.instance.hasEmbeddings();
  }

  inspectNodes(handle: GraphHandle): Array<{
    id: string;
    confidence: number;
    validUntil?: number;
    sourceFile: string;
    contentPreview: string;
    section?: string;
    nodeType?: string;
    entities?: string[];
  }> {
    const h = handle as Internal;
    if (!h.built) return [];
    const out: Array<{
      id: string;
      confidence: number;
      validUntil?: number;
      sourceFile: string;
      contentPreview: string;
      section?: string;
      nodeType?: string;
      entities?: string[];
    }> = [];
    for (const [id, n] of h.instance.graph.nodes) {
      const rec: {
        id: string;
        confidence: number;
        validUntil?: number;
        sourceFile: string;
        contentPreview: string;
        section?: string;
        nodeType?: string;
        entities?: string[];
      } = {
        id,
        confidence: n.confidence,
        sourceFile: n.source.file,
        contentPreview: n.content.length > 500 ? n.content.slice(0, 497) + '…' : n.content,
      };
      if (n.validUntil !== undefined) rec.validUntil = n.validUntil;
      if (n.source.section) rec.section = n.source.section;
      if (n.type) rec.nodeType = n.type;
      // Pass the SDK's extracted entities through. Used by the App's
      // entity-aware candidate ranking + the deck's "connect" cards
      // ("This memory mentions {entity} — connect to other memories
      // where it appears?"). Empty array is fine for the App's Jaccard
      // calculation; we only attach the field when there's something.
      if (n.entities && n.entities.length > 0) rec.entities = n.entities;
      out.push(rec);
    }
    return out;
  }

  /** Like inspectNodes but for a SPECIFIC set of ids — O(ids), not O(all
   *  nodes). Used by the per-source live-ingest delta so we can push just the
   *  new source's nodes to the UI without re-serializing the whole graph. */
  getNodesByIds(handle: GraphHandle, ids: string[]): ReturnType<GraphnosisImpl['inspectNodes']> {
    const h = handle as Internal;
    if (!h.built) return [];
    const out: ReturnType<GraphnosisImpl['inspectNodes']> = [];
    for (const id of ids) {
      const n = h.instance.graph.nodes.get(id);
      if (!n) continue;
      const rec: ReturnType<GraphnosisImpl['inspectNodes']>[number] = {
        id,
        confidence: n.confidence,
        sourceFile: n.source.file,
        contentPreview: n.content.length > 500 ? n.content.slice(0, 497) + '…' : n.content,
      };
      if (n.validUntil !== undefined) rec.validUntil = n.validUntil;
      if (n.source.section) rec.section = n.source.section;
      if (n.type) rec.nodeType = n.type;
      if (n.entities && n.entities.length > 0) rec.entities = n.entities;
      out.push(rec);
    }
    return out;
  }

  /** Release the SDK graph's in-memory structures (node/edge Maps + tfidf/
   *  embedding indexes) so the host can EVICT an idle engram and actually return
   *  the memory to the OS. After dispose() the handle is dead — the host drops it
   *  and reloads from disk on next access. Best-effort: a handle built by an
   *  older SDK without dispose() is left to plain GC. */
  dispose(handle: GraphHandle): void {
    const h = handle as Internal;
    const inst = h.instance as Graphnosis & { dispose?: () => void };
    try { inst.dispose?.(); } catch { /* best-effort — never throw from eviction */ }
    h.built = false;
  }

  /** Count nodes created at/after `sinceMs` (epoch ms). Used by vitality's
   *  recency term so it reads REAL recent activity from the in-memory graph
   *  (node.createdAt) instead of the op-log — accurate, cheap, survives restart. */
  countRecentNodes(handle: GraphHandle, sinceMs: number): number {
    const h = handle as Internal;
    if (!h.built) return 0;
    let n = 0;
    for (const node of h.instance.graph.nodes.values()) {
      // createdAt is epoch ms; guard against an older seconds-based value.
      const t = node.createdAt < 1e12 ? node.createdAt * 1000 : node.createdAt;
      if (t >= sinceMs) n++;
    }
    return n;
  }

  /**
   * Return the FULL untruncated content of a single node by id, or null when
   * the node doesn't exist. Used by skill retrieval (getSkill) to assemble
   * complete trained-skill text — the standard inspectNodes path truncates
   * each node's content to 500 chars for the general UI, which silently ate
   * the trailing Goals block when a skill body + recipes + goals exceeded
   * that cap.
   */
  getFullNodeContent(handle: GraphHandle, nodeId: string): string | null {
    const h = handle as Internal;
    if (!h.built) return null;
    const n = h.instance.graph.nodes.get(nodeId);
    return n ? n.content : null;
  }

  /**
   * Snapshot every edge in the dual-graph. The SDK stores directed and
   * undirected edges separately (different semantics) so we keep that split
   * — the App's Atlas renders them differently (arrows vs lines).
   */
  inspectEdges(handle: GraphHandle): {
    directed: Array<{ id: string; from: string; to: string; type: ReturnType<GraphnosisImpl['_directedType']>; weight: number; evidence?: string }>;
    undirected: Array<{ id: string; a: string; b: string; type: ReturnType<GraphnosisImpl['_undirectedType']>; weight: number }>;
  } {
    const h = handle as Internal;
    if (!h.built) return { directed: [], undirected: [] };
    const directed = [...h.instance.graph.directedEdges.entries()].map(([id, e]) => {
      const rec: { id: string; from: string; to: string; type: ReturnType<GraphnosisImpl['_directedType']>; weight: number; evidence?: string } = {
        id,
        from: e.from,
        to: e.to,
        type: e.type,
        weight: e.weight,
      };
      // Pass through the user-chosen label (set by linkNodesDirected).
      // Auto-extracted edges typically don't set evidence; the App
      // falls back to a humanized SDK type for those.
      if (e.evidence) rec.evidence = e.evidence;
      return rec;
    });
    const undirected = [...h.instance.graph.undirectedEdges.entries()].map(([id, e]) => ({
      id,
      a: e.nodes[0],
      b: e.nodes[1],
      type: e.type,
      weight: e.weight,
    }));
    return { directed, undirected };
  }
  /**
   * Returns raw embedding vectors for all embedded nodes, keyed by nodeId.
   * Used by BrainEngine's duplicate scan (cosine pairwise comparison).
   * Returns an empty map when the graph has no embedding index.
   */
  getNodeEmbeddings(handle: GraphHandle): Map<string, number[]> {
    const h = handle as Internal;
    if (!h.built || !h.instance.hasEmbeddings()) return new Map();
    // Embedding vectors are NOT stored on GraphNode — the GraphNode type
    // has no `embedding` field at all. They live in a separate
    // EmbeddingIndex attached to the SDK instance's internal `built`
    // object. The SDK's own hasEmbeddings() is literally
    // `!!this.built?.embeddingIndex`, so reaching through
    // `built.embeddingIndex.vectors` (Map<nodeId, vector>) is the correct
    // — and only — access path. Reading `node.embedding` always yielded
    // undefined, which silently disabled the duplicate scan entirely.
    const index = (h.instance as unknown as {
      built?: { embeddingIndex?: { vectors?: Map<string, number[]> } };
    }).built?.embeddingIndex;
    const vectors = index?.vectors;
    if (!vectors) return new Map();
    const out = new Map<string, number[]>();
    for (const [id, vec] of vectors) {
      if (vec && vec.length > 0) out.set(id, vec);
    }
    return out;
  }

  /**
   * READ-ONLY borrow of the engram's live TF-IDF index. See the interface
   * doc in graphnosis-adapter.ts for why this is the substrate's own index
   * and not a recomputation: `undirected-edges.ts` scores every `similar-to`
   * edge from exactly these maps, so a cosine derived here is on the same
   * scale as SIMILARITY_THRESHOLD instead of merely near it.
   */
  getTfidfIndex(handle: GraphHandle): { documents: Map<string, Map<string, number>>; idf: Map<string, number> } | null {
    const h = handle as Internal;
    if (!h.built) return null;
    const idx = (h.instance as unknown as {
      graph?: { tfidfIndex?: { documents?: Map<string, Map<string, number>>; idf?: Map<string, number> } };
    }).graph?.tfidfIndex;
    if (!idx?.documents || !idx.idf) return null;
    return { documents: idx.documents, idf: idx.idf };
  }

  // Phantom methods purely to anchor the return-type inference for the
  // inspectEdges signature without re-importing the SDK types here.
  private _directedType(): import('@nehloo/graphnosis').DirectedEdge['type'] { throw new Error('phantom'); }
  private _undirectedType(): import('@nehloo/graphnosis').UndirectedEdge['type'] { throw new Error('phantom'); }

  /**
   * Add an undirected edge between two existing nodes. The SDK has no
   * public `addEdge`, so we write directly into `graph.undirectedEdges`.
   * Idempotent: if an edge of the same type already connects these two
   * nodes (in either order), we return the existing edge instead of
   * creating a duplicate.
   *
   * For the App's "Link them" workflow we default to `related-to` with
   * weight 0.7 — meaningful but below auto-extracted edges (which sit
   * at 0.85+), so manual links don't pollute the dominant-edge view.
   */
  async linkNodes(
    handle: GraphHandle,
    fromNodeId: string,
    toNodeId: string,
    opts: { type?: import('@nehloo/graphnosis').UndirectedEdge['type']; weight?: number; reason?: string } = {},
  ): Promise<{ edgeId: string; created: boolean }> {
    const h = handle as Internal;
    if (!h.built) {
      // Auto-build instead of throwing — mirrors the self-heal in the append
      // and search paths. A throw here is swallowed PER-EDGE by the host's
      // linkNodesDirectedBatch catch, so every skill-structure linker
      // (sequence/goals/loops/branches/calls) could silently persist zero
      // edges while train_skill reported success.
      h.instance.build(h.graphId);
      h.built = true;
    }
    if (fromNodeId === toNodeId) {
      throw new Error('Cannot link a node to itself');
    }
    if (!h.instance.graph.nodes.has(fromNodeId)) {
      throw new Error(`Node not found: ${fromNodeId}`);
    }
    if (!h.instance.graph.nodes.has(toNodeId)) {
      throw new Error(`Node not found: ${toNodeId}`);
    }
    const type = opts.type ?? 'related-to';
    // Dedupe: scan existing undirected edges for the same pair + type.
    // Order-independent (undirected) so both directions count as a match.
    for (const [eid, e] of h.instance.graph.undirectedEdges) {
      if (e.type !== type) continue;
      const [a, b] = e.nodes;
      if ((a === fromNodeId && b === toNodeId) || (a === toNodeId && b === fromNodeId)) {
        return { edgeId: eid, created: false };
      }
    }
    const edgeId = `e-link-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    h.instance.graph.undirectedEdges.set(edgeId, {
      id: edgeId,
      nodes: [fromNodeId, toNodeId],
      type,
      weight: opts.weight ?? 0.7,
      createdAt: Date.now(),
    });
    // Keep the metadata count fresh — the gai-writer reads this when
    // serializing, and the pruner only resets it on optimize. Before this
    // fix every manual link left the count stale until the next optimize
    // pass; downstream stats under-reported edge counts.
    if (h.instance.graph.metadata) {
      h.instance.graph.metadata.undirectedEdgeCount = h.instance.graph.undirectedEdges.size;
    }
    return { edgeId, created: true };
  }

  /**
   * Add a DIRECTED edge between two existing nodes. Mirror of `linkNodes`
   * but writes to `graph.directedEdges`. Order-sensitive dedupe on
   * `(from, to, type)` — reversed direction is a different edge.
   *
   * `evidence` carries the user-friendly label ("Works at", "Lives in"
   * etc.) so the App can render the user's vocabulary in the detail
   * pane instead of the structural SDK type.
   */
  async linkNodesDirected(
    handle: GraphHandle,
    fromNodeId: string,
    toNodeId: string,
    opts: { type: import('@nehloo/graphnosis').DirectedEdge['type']; weight?: number; evidence?: string },
  ): Promise<{ edgeId: string; created: boolean }> {
    const h = handle as Internal;
    if (!h.built) {
      // Auto-build instead of throwing — mirrors the self-heal in the append
      // and search paths. A throw here is swallowed PER-EDGE by the host's
      // linkNodesDirectedBatch catch, so every skill-structure linker
      // (sequence/goals/loops/branches/calls) could silently persist zero
      // edges while train_skill reported success.
      h.instance.build(h.graphId);
      h.built = true;
    }
    if (fromNodeId === toNodeId) {
      throw new Error('Cannot link a node to itself');
    }
    if (!h.instance.graph.nodes.has(fromNodeId)) {
      throw new Error(`Node not found: ${fromNodeId}`);
    }
    if (!h.instance.graph.nodes.has(toNodeId)) {
      throw new Error(`Node not found: ${toNodeId}`);
    }
    const { type } = opts;
    // Dedupe order-sensitively — directed `(A → B knows)` is distinct
    // from `(B → A knows)` and from `(A → B works-with)`. If the user
    // clicks Connect twice on the same row we no-op.
    for (const [eid, e] of h.instance.graph.directedEdges) {
      if (e.from === fromNodeId && e.to === toNodeId && e.type === type) {
        return { edgeId: eid, created: false };
      }
    }
    const edgeId = `e-dlink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const rec: import('@nehloo/graphnosis').DirectedEdge = {
      id: edgeId,
      from: fromNodeId,
      to: toNodeId,
      type,
      weight: opts.weight ?? 0.7,
      createdAt: Date.now(),
    };
    if (opts.evidence) rec.evidence = opts.evidence;
    h.instance.graph.directedEdges.set(edgeId, rec);
    if (h.instance.graph.metadata) {
      h.instance.graph.metadata.directedEdgeCount = h.instance.graph.directedEdges.size;
    }
    return { edgeId, created: true };
  }

  /**
   * Remove a single edge by its ID. Tries directed edges first, then
   * undirected. Returns `{ removed: false }` if the edge is not found
   * rather than throwing — callers can treat this as idempotent.
   */
  async unlinkEdge(
    handle: GraphHandle,
    edgeId: string,
  ): Promise<{ removed: boolean; wasDirected?: boolean }> {
    const h = handle as Internal;
    if (h.instance.graph.directedEdges.has(edgeId)) {
      h.instance.graph.directedEdges.delete(edgeId);
      if (h.instance.graph.metadata) {
        h.instance.graph.metadata.directedEdgeCount = h.instance.graph.directedEdges.size;
      }
      return { removed: true, wasDirected: true };
    }
    if (h.instance.graph.undirectedEdges.has(edgeId)) {
      h.instance.graph.undirectedEdges.delete(edgeId);
      if (h.instance.graph.metadata) {
        h.instance.graph.metadata.undirectedEdgeCount = h.instance.graph.undirectedEdges.size;
      }
      return { removed: true, wasDirected: false };
    }
    return { removed: false };
  }

  /**
   * Set an existing edge's weight (directed or undirected) — the primitive
   * behind Deterministic Consolidation's connection reinforcement. Tries the
   * directed map first, then undirected; clamps the new weight to [0, 1].
   * Edge count is unchanged, so no metadata update. Returns `{ ok: false }`
   * when the edge id is not found — idempotent, like `unlinkEdge`.
   */
  async reweightEdge(
    handle: GraphHandle,
    edgeId: string,
    newWeight: number,
  ): Promise<{ ok: boolean; wasDirected?: boolean; prevWeight?: number }> {
    const h = handle as Internal;
    const w = Math.max(0, Math.min(1, newWeight));
    const de = h.instance.graph.directedEdges.get(edgeId);
    if (de) {
      const prevWeight = de.weight;
      de.weight = w;
      return { ok: true, wasDirected: true, prevWeight };
    }
    const ue = h.instance.graph.undirectedEdges.get(edgeId);
    if (ue) {
      const prevWeight = ue.weight;
      ue.weight = w;
      return { ok: true, wasDirected: false, prevWeight };
    }
    return { ok: false };
  }

  /**
   * Cross-document entity-overlap relink. See adapter interface comment
   * for context. Logic:
   *   1. Snapshot every ACTIVE node's entity set.
   *   2. For each pair (i < j), compute the entity Jaccard.
   *   3. If Jaccard ≥ 0.2 AND no existing `shares-entity` edge between
   *      them, add one (weight scaled by overlap strength).
   *   4. For pairs sharing a person-shaped entity (2+ capitalized
   *      words, no digits, not ACRONYM), add a `same-person` edge.
   *      Dedupe by `(nodes, type)`.
   *
   * Pure mutation of `graph.undirectedEdges`. The host calls this
   * post-append and emits one op-log event per new edge for audit /
   * recovery.
   */
  async relinkFullGraph(
    handle: GraphHandle,
    opts: { maxNodes?: number } = {},
  ): Promise<{
    skipped: boolean;
    skipReason?: string;
    activeNodes: number;
    newEdges: Array<{
      edgeId: string;
      a: string;
      b: string;
      type: 'shares-entity' | 'same-person';
      weight: number;
      sharedEntities: string[];
    }>;
  }> {
    const h = handle as Internal;
    if (!h.built) {
      return { skipped: true, skipReason: 'graph not built', activeNodes: 0, newEdges: [] };
    }
    const maxNodes = opts.maxNodes ?? 5000;
    // 0 means "disabled" — the user (or default) opted out of post-ingest
    // cross-doc linking. Honor it.
    if (maxNodes === 0) {
      return { skipped: true, skipReason: 'auto-relink disabled (maxNodes=0)', activeNodes: 0, newEdges: [] };
    }
    const now = Date.now();
    // Snapshot active nodes + their entity sets. Skip soft-deleted +
    // structural-noise (document/section) nodes — these are graph
    // chrome and don't carry user-meaningful entities.
    interface NodeSnap {
      id: string;
      entitiesLower: Set<string>;
      personEntities: string[];
    }
    const snaps: NodeSnap[] = [];
    for (const [id, n] of h.instance.graph.nodes) {
      if (n.confidence <= 0.2) continue;
      if (n.validUntil !== undefined && n.validUntil < now) continue;
      if (n.type === 'document' || n.type === 'section') continue;
      const rawEnts = n.entities ?? [];
      if (rawEnts.length === 0) continue;
      const lower = new Set(rawEnts.map((e) => e.toLowerCase()));
      const personEnts = rawEnts.filter(isPersonLikeEntity);
      snaps.push({ id, entitiesLower: lower, personEntities: personEnts });
    }
    if (snaps.length > maxNodes) {
      return {
        skipped: true,
        skipReason: `active node count ${snaps.length} > maxNodes ${maxNodes}`,
        activeNodes: snaps.length,
        newEdges: [],
      };
    }
    if (snaps.length < 2) {
      return { skipped: true, skipReason: 'fewer than 2 candidate nodes', activeNodes: snaps.length, newEdges: [] };
    }

    // Index existing undirected edges by an unordered pair key so the
    // O(N²) scan can check "does this pair already have an edge of
    // this type?" in O(1). Pair key uses sorted ids.
    const existing = new Map<string, Set<string>>(); // pairKey → set of types
    const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
    for (const [, e] of h.instance.graph.undirectedEdges) {
      const [a, b] = e.nodes;
      const k = pairKey(a, b);
      const set = existing.get(k) ?? new Set<string>();
      set.add(e.type);
      existing.set(k, set);
    }
    // The newly-added edges we'll return to the host so it can emit op-log entries.
    const newEdges: Array<{
      edgeId: string;
      a: string;
      b: string;
      type: 'shares-entity' | 'same-person';
      weight: number;
      sharedEntities: string[];
    }> = [];

    const addEdge = (
      a: string,
      b: string,
      type: 'shares-entity' | 'same-person',
      weight: number,
      sharedEntities: string[],
    ): void => {
      const k = pairKey(a, b);
      const types = existing.get(k);
      if (types?.has(type)) return; // already linked with this type
      const edgeId = `e-relink-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      h.instance.graph.undirectedEdges.set(edgeId, {
        id: edgeId,
        nodes: [a, b],
        type,
        weight,
        createdAt: Date.now(),
      });
      const nextTypes = types ?? new Set<string>();
      nextTypes.add(type);
      existing.set(k, nextTypes);
      newEdges.push({ edgeId, a, b, type, weight, sharedEntities });
    };

    // Main O(N²) scan. snaps is capped by maxNodes above, so this is
    // bounded. For N=5000 worst case = 12.5M comparisons, each a small
    // Set lookup — finishes in under a second on a modern machine.
    for (let i = 0; i < snaps.length; i++) {
      const si = snaps[i];
      if (!si) continue;
      for (let j = i + 1; j < snaps.length; j++) {
        const sj = snaps[j];
        if (!sj) continue;
        // Jaccard on lowercased entities. We compute intersection +
        // union sizes directly (faster than allocating temporary sets).
        const aSet = si.entitiesLower;
        const bSet = sj.entitiesLower;
        const small = aSet.size <= bSet.size ? aSet : bSet;
        const large = small === aSet ? bSet : aSet;
        let inter = 0;
        const sharedLower: string[] = [];
        for (const e of small) {
          if (large.has(e)) {
            inter++;
            sharedLower.push(e);
          }
        }
        if (inter === 0) continue;
        // Hybrid threshold — Jaccard alone punishes short clips: a
        // remember-clip with {NYFA} vs a file with {NYFA + 12 others}
        // scores Jaccard = 1/13 = 0.077, below the SDK's 0.2 cutoff
        // even though the link is obvious. We OR-in containment
        // (intersection / shorter-set-size) which captures the
        // "all of the short clip's entities are in this longer doc"
        // case cleanly. Either signal at meaningful strength → link.
        const union = aSet.size + bSet.size - inter;
        const jaccard = inter / union;
        const containment = inter / Math.min(aSet.size, bSet.size);
        // Require at least 1 shared entity AND (decent containment
        // OR mild Jaccard). The containment ≥ 0.5 rule fires for
        // small-overlap-but-meaningful clips; the Jaccard ≥ 0.15
        // rule fires for two longish docs with sustained overlap.
        if (containment >= 0.5 || jaccard >= 0.15) {
          // Weight scaled by the strongest signal — favors high
          // containment for short clips, high Jaccard for long
          // docs. Capped at 0.85 so auto links visually sit
          // below SDK-auto-extracted edges (which sit at 0.85+).
          const strength = Math.max(jaccard, containment * 0.6);
          const weight = Math.min(0.85, 0.45 + strength * 0.55);
          addEdge(si.id, sj.id, 'shares-entity', weight, sharedLower);
        }
        // Person-bridge: if any person-shaped entity (2+ capitalized
        // words, not acronym, no digits) appears in both nodes, add
        // `same-person`. Independent of the threshold above — even a
        // single shared person name is a strong signal. NOTE: single-
        // word names like "Stela" don't trigger this path (need 2+
        // words); they still get caught by the shares-entity rule
        // above when there's any meaningful overlap.
        if (si.personEntities.length > 0 && sj.personEntities.length > 0) {
          const sharedPersons: string[] = [];
          for (const p of si.personEntities) {
            const pLower = p.toLowerCase();
            if (sj.entitiesLower.has(pLower)) sharedPersons.push(p);
          }
          if (sharedPersons.length > 0) {
            addEdge(si.id, sj.id, 'same-person', 0.75, sharedPersons);
          }
        }
      }
    }

    // Keep metadata count fresh — the gai-writer reads it.
    if (h.instance.graph.metadata) {
      h.instance.graph.metadata.undirectedEdgeCount = h.instance.graph.undirectedEdges.size;
    }
    return { skipped: false, activeNodes: snaps.length, newEdges };
  }

  // -- internals --

  private addPreBuild(g: Graphnosis, input: AppendDocumentInput): void {
    switch (input.kind) {
      case 'text':
        // Headerless prose → single-section wrap. Keeps "wife name Maria" as the searchable
        // node content instead of letting the markdown parser title-ify it as "Untitled".
        g.addText(asString(input.content), input.sourceRef);
        return;
      case 'markdown':
        g.addMarkdown(asString(input.content), input.sourceRef);
        return;
      case 'html':
        g.addHtml(asString(input.content), input.sourceRef);
        return;
      case 'json':
        g.addJson(asString(input.content), input.sourceRef);
        return;
      case 'csv':
        g.addCsv(asString(input.content), input.sourceRef);
        return;
      case 'pdf':
        // No pre-build addPdf in v0.2.3 — fall through to a post-build append.
        throw new Error('PDF ingest requires an already-built graph; ingest a markdown first or rebuild.');
    }
  }

  private async appendPostBuild(g: Graphnosis, input: AppendDocumentInput, opts: AppendDocumentOptions = {}) {
    // SDK accepts `{ chunkSize: ChunkSizePreset }` as the 3rd arg of every
    // append* sugar method. Pass undefined when the user hasn't set a
    // preset so the SDK falls back to its 'balanced' default.
    const ingestOpts = opts.chunkSize ? { chunkSize: opts.chunkSize } : undefined;
    switch (input.kind) {
      case 'text':
        return g.appendText(asString(input.content), input.sourceRef, ingestOpts);
      case 'markdown':
        return g.appendMarkdown(asString(input.content), input.sourceRef, ingestOpts);
      case 'html':
        return g.appendHtml(asString(input.content), input.sourceRef, ingestOpts);
      case 'json':
        return g.appendJson(asString(input.content), input.sourceRef, ingestOpts);
      case 'csv':
        return g.appendCsv(asString(input.content), input.sourceRef, ingestOpts);
      case 'pdf':
        return g.appendPdf(Buffer.from(input.content as Uint8Array), input.sourceRef, ingestOpts);
    }
  }
}

function asString(c: string | Uint8Array): string {
  return typeof c === 'string' ? c : new TextDecoder().decode(c);
}

/**
 * Heuristic person-shape classifier — mirrors the one in the App-side
 * suggestion panel so the relink pass and the user-facing review deck
 * use consistent signals. Person-like = 2+ capitalized words, no digits,
 * no dot-notation, not an ALL-CAPS acronym, length 4–60.
 */
function isPersonLikeEntity(e: string): boolean {
  if (!e || e.length < 4 || e.length > 60) return false;
  if (/\d/.test(e)) return false;
  if (e.includes('.')) return false;
  if (e === e.toUpperCase() && e.length < 10) return false; // ACRONYM
  const words = e.split(/\s+/);
  if (words.length < 2) return false;
  return words.every((w) => /^[A-ZÀ-Ý][a-zà-ÿ'-]+/.test(w));
}

function nodeIdsBySource(g: Graphnosis, sourceRef: string): NodeId[] {
  const out: NodeId[] = [];
  for (const [id, n] of g.graph.nodes) {
    if (n.source.file === sourceRef) out.push(id);
  }
  return out;
}

// Recover a human-readable label from a sourceRef of shape "<kind>:<ts>:<label>"
// where kind ∈ {'clip', 'skill', 'ai-conversation'} (all formats ingestClip produces).
// Falls back to the raw ref for unknown shapes.
function labelFromSourceRef(sourceRef: string): string {
  const parts = sourceRef.split(':');
  if (parts.length >= 3 && ['clip', 'skill', 'ai-conversation'].includes(parts[0]!)) {
    return parts.slice(2).join(':');
  }
  return sourceRef;
}
