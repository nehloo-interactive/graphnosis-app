import { settings as settingsMod } from '@graphnosis-app/core';
import { federation, type GraphId, type SubgraphBudget } from '@nehloo-interactive/graphnosis-secure-sync';
import type { HostOptions } from '../host.js';
import { cachedExtractQueryEntities } from '../query-enrichment-cache.js';
const { federatedQuery } = federation;
import {
  WorkPriority,
  enrichmentLlmPriority,
  shouldSkipRecallEnrichment,
  tryAcquireLlmSlot,
} from '../work-priority.js';
import {
  ANCHOR_SCORE,
  DIG_DEEPER_CROSS_ENGRAM_CAP,
  DIG_DEEPER_PER_SOURCE_CAP,
  GNN_ANCHOR_EXPANSION_PER_SEED,
  GNN_EXPANSION_PER_SEED,
  GNN_EXPANSION_SCORE,
  GNN_RECALL_THRESHOLD,
  buildGnnRecallAdjacency,
  buildOverlaySection,
  buildRichRecallPrompt,
  detectSourceFilenameMatches,
  enrichRecallQuery,
  expandViaGnn,
  foldDiacritics,
  selectAnchorNodes,
  type GnnRecallAdjacency,
} from './recall.js';

/** Host surface required by federated recall / dig_deeper. */
export interface RecallHost {
  settings: import('@graphnosis-app/core').settings.AppSettings;
  opts: HostOptions;
  policyCfg: import('@nehloo-interactive/graphnosis-secure-sync').policy.PolicyConfig;
  llmGetter?: () => import('../correction.js').LocalLlm | null;
  plasticityObserver?: (sub: federation.FederatedSubgraph) => void;
  readonly graphs: Map<GraphId, {
    handle: import('../graphnosis-adapter.js').GraphHandle;
  }>;
  listGraphs(): GraphId[];
  ensureLoaded(id: GraphId): Promise<void>;
  activeNodeIds(graphId: GraphId): Set<string>;
  recallNodeSnapshot(graphId: GraphId): {
    active: Set<string>;
    nodes: ReturnType<import('../graphnosis-adapter.js').GraphnosisAdapter['inspectNodes']>;
  };
  must(graphId: GraphId): { handle: import('../graphnosis-adapter.js').GraphHandle };
  loadGnnStore(): Promise<import('../gnn-store.js').PredictedEdge[]>;
  loadGllOverlay(): Promise<{ edges: import('../gll-overlay.js').GllPredictedEdge[]; assertions: import('../gll-overlay.js').GllAssertion[] }>;
  loadConnectionStore(): Promise<import('../connection-store.js').CrossEngramConnection[]>;
  getGraphMetadata(graphId: GraphId): { displayName?: string } | undefined;
  listSources(graphId: GraphId): import('@graphnosis-app/core').SourceRecord[];
  zeroResultHint(): string;
  recall(
    query: string,
    opts?: {
      budget?: SubgraphBudget;
      onlyGraphIds?: string[];
      exceptGraphIds?: string[];
      perGraphAnchorMax?: number;
      skipEnrichment?: boolean;
      noLoadOnDemand?: boolean;
      consentedGraphIds?: string[];
      /** Work-priority lane — defaults to P1 user recall, P3 when noLoadOnDemand. */
      recallPriority?: WorkPriority;
    },
  ): Promise<federation.FederatedSubgraph>;
}

export type RecallOpts = {
  budget?: SubgraphBudget;
  onlyGraphIds?: string[];
  exceptGraphIds?: string[];
  perGraphAnchorMax?: number;
  skipEnrichment?: boolean;
  noLoadOnDemand?: boolean;
  consentedGraphIds?: string[];
  recallPriority?: WorkPriority;
};

export async function hostRecall(
  host: RecallHost,
  query: string,
  opts?: RecallOpts,
): Promise<federation.FederatedSubgraph> {
    // ── Recall enrichment (non-mutating) ─────────────────────────────────
    // When the user has llmEnabled + llmCapabilities.recallEnrichment on AND
    // Ollama is reachable, ask the LLM to rewrite the raw user query into a
    // search-friendlier string: strip framing, add synonyms in the same
    // language, add cross-language translations for proper nouns and key
    // content words. The graph is never touched — this is pure query
    // augmentation. Falls back silently to the original query on any error,
    // any timeout, or any setting that disables the path. The audit footer
    // records when enrichment ran so the AI client / user can see it.
    // skipEnrichment: Studio passes true — users type deliberate search terms,
    // not conversational prompts, so LLM query rewriting does more harm than good.
    let effectiveQuery = query;
    let enrichmentNote: string | null = null;
    const recallPriority = opts?.recallPriority
      ?? (opts?.noLoadOnDemand ? WorkPriority.P3_ENRICHMENT : WorkPriority.P1_USER);
    const caps = settingsMod.resolveLlmCapabilities(host.settings);
    const llm = !opts?.skipEnrichment && caps.recallEnrichment && host.llmGetter
      ? host.llmGetter()
      : null;
    let enrichmentPromise: Promise<string | null> = Promise.resolve(null);
    if (llm && !shouldSkipRecallEnrichment(recallPriority)) {
      const slotPriority = enrichmentLlmPriority(recallPriority);
      const slot = tryAcquireLlmSlot(slotPriority);
      if (slot) {
        enrichmentPromise = enrichRecallQuery(llm, query, slot.signal)
          .catch((e: unknown) => {
            const msg = (e as Error).message ?? String(e);
            if ((e as Error).name === 'AbortError' || msg.includes('aborted') || msg.includes('preempted')) {
              return null;
            }
            // Non-fatal — recall must still work when the LLM is slow or down.
            console.error(`[host] recall enrichment failed, using raw query: ${msg}`);
            return null;
          })
          .finally(() => slot.release());
      }
    }
    // Lazy-boot: not all engrams are resident. Ensure the search set is loaded
    // BEFORE we snapshot active nodes + federate — otherwise recall silently
    // searches only whatever happened to be loaded (a correctness bug for an AI
    // client recalling across the cortex). A scoped recall loads just its targets;
    // a federated recall loads every engram (they evict via the LRU once idle).
    // (Follow-up: a streaming federated recall — load→search→dispose per engram —
    //  would also bound recall's peak memory; this loads all at once for now.)
    // noLoadOnDemand: background callers (the brain's develop/insight/predict
    // recalls) set this so they search only ENGRAMS ALREADY RESIDENT — they must
    // NOT pull the whole cortex into memory on a timer (that pins every engram
    // resident and defeats eviction → the "stuck in GBs"). Explicit user/MCP
    // recalls leave it unset and load their search set for full-cortex correctness.
    const loadPromise = !opts?.noLoadOnDemand
      ? (async () => {
          const recallSet = (opts?.onlyGraphIds?.length
            ? opts.onlyGraphIds
            : Object.keys(host.settings.graphMetadata)
          ).filter((id) => !opts?.exceptGraphIds?.includes(id));
          for (const id of recallSet) await host.ensureLoaded(id);
        })()
      : Promise.resolve();
    const [enriched] = await Promise.all([enrichmentPromise, loadPromise]);
    if (enriched && enriched !== query) {
      effectiveQuery = enriched;
      enrichmentNote = `enriched: "${query}" → "${enriched}"`;
    }
    // Snapshot active-node IDs per graph BEFORE the federated query runs.
    // Scope to engrams we will actually query — building active sets for every
    // loaded engram adds pure overhead when the caller passed onlyGraphIds.
    // One inspectNodes pass per engram (shared with anchoring / GNN expansion).
    const recallGraphIds = opts?.onlyGraphIds?.length
      ? opts.onlyGraphIds.filter((id) => !opts?.exceptGraphIds?.includes(id))
      : opts?.exceptGraphIds?.length
        ? host.listGraphs().filter((id) => !opts.exceptGraphIds!.includes(id))
        : host.listGraphs();
    const recallSnapshots = new Map<GraphId, ReturnType<RecallHost['recallNodeSnapshot']>>();
    for (const graphId of recallGraphIds) {
      recallSnapshots.set(graphId, host.recallNodeSnapshot(graphId));
    }
    // federatedQuery fires runQuery for every graph in parallel (Promise.all).
    // queryHybrid uses ONNX which is NOT safe for concurrent invocations —
    // simultaneous calls race on a shared C++ mutex and silently return empty
    // results (or crash the process). Serialize per-graph adapter calls using
    // a local promise chain scoped to this recall, so Promise.all starts all
    // callbacks concurrently but each one waits for the previous ONNX call to
    // finish. A local chain avoids deadlocking the global withEmbedding queue
    // (which already holds the lock for the duration of this host.recall call).
    let queryChain: Promise<void> = Promise.resolve();
    // Capture per-graph rich subgraph data (edges + serialize closure) so we
    // can build a === KNOWLEDGE SUBGRAPH === prompt after federation narrows
    // the node set to the budget-selected subset.
    const perGraphRich = new Map<GraphId, import('../graphnosis-adapter.js').RichSubgraph>();
    // Entity extraction: run once on the ORIGINAL query (not the enriched
    // version). Anchor matching is about literal-identifier preservation;
    // the LLM rewrite may strip or duplicate proper nouns, so we anchor on
    // what the user actually typed.
    const queryEntities = cachedExtractQueryEntities(query);
    const perGraphAnchorMax = opts?.perGraphAnchorMax ?? 3;
    let anchorCountTotal = 0;
    // GNN-driven recall (Batch 11): build a recall-grade adjacency from the
    // .gnn overlay so each engram's runQuery can do graph expansion +
    // anchor extension. Gated on neuralNetwork.enabled — when GNN is off,
    // adj is undefined and the expansion/extension code paths no-op.
    let gnnAdj: GnnRecallAdjacency | undefined;
    let gnnExpansionCountTotal = 0;
    if (host.settings.brain?.neuralNetwork?.enabled === true) {
      try {
        const gnnEdges = await host.loadGnnStore();
        if (gnnEdges.length > 0) {
          // Scope the adjacency to the engrams we'll actually query — saves
          // a tiny bit of memory on cortexes with many engrams.
          const scoped = new Set(opts?.onlyGraphIds ?? host.listGraphs());
          gnnAdj = buildGnnRecallAdjacency(gnnEdges, scoped);
        }
      } catch (e) {
        // Overlay load failure is non-fatal — recall still works without
        // GNN assist, just without the expansion/extension behavior.
        console.error(`[host] recall: GNN adjacency build failed (non-fatal): ${(e as Error).message}`);
      }
    }
    const runner: federation.FederatedQueryRunner = {
      runQuery: async (graphId, q, k) => {
        const result = queryChain.then(async () => {
          const g = host.must(graphId);
          const snap = recallSnapshots.get(graphId);
          const active = snap?.active ?? new Set<string>();
          // queryRich = queryHybrid/query + edge capture + serialize closure.
          // Same 3× over-fetch as searchNodes to recover real top-k after
          // dropping soft-deleted nodes without making the SDK call quadratic.
          const { candidates: raw, rich } = await host.opts.adapter.queryRich(g.handle, q, k * 3);
          perGraphRich.set(graphId, rich);
          const ranked = raw
            .filter((r) => active.has(r.nodeId))
            .slice(0, k)
            .map((r) => ({ graphId, nodeId: r.nodeId, score: r.score, text: r.text, ...(r.type !== undefined ? { type: r.type } : {}) }));
          // Lookup we'll need for both entity anchoring AND GNN expansion.
          const inspected = snap?.nodes ?? host.opts.adapter.inspectNodes(g.handle);
          const perGraphAdj = gnnAdj?.get(graphId);

          // Step 1: entity-anchored seeds (deterministic). Anchor matching
          // does two things:
          //   1a. PREPEND anchored nodes that the SDK's top-k missed (low
          //       semantic score but literal-entity match).
          //   1b. BOOST the score of anchored nodes that ARE in top-k to
          //       ANCHOR_SCORE so they dominate federation.
          //
          // The 1b step was the silent bug: when a node like "Robert Gomboș"
          // appeared in the per-engram top-k via weak semantic match (score
          // ~0.18) AND was also a literal-entity hit for query "robert",
          // the old code just skipped it ("already there") and let it keep
          // its raw 0.18. Federation then ranked it below higher-scoring
          // noise from other engrams. The fix: when a ranked node matches
          // an anchor, upgrade its score so anchoring's federation-priority
          // promise actually holds.
          let fresh: Array<{ graphId: string; nodeId: string; score: number; text: string; type?: string }> = [];
          const existingIds = new Set(ranked.map((r) => r.nodeId));
          if (queryEntities.length > 0 && perGraphAnchorMax > 0) {
            const anchors = selectAnchorNodes(inspected, active, queryEntities, perGraphAnchorMax);
            const anchorIdSet = new Set(anchors.map((a) => a.nodeId));
            // 1b. Boost matching ranked nodes to ANCHOR_SCORE in-place.
            let boostedInPlace = 0;
            for (const r of ranked) {
              if (anchorIdSet.has(r.nodeId)) {
                r.score = ANCHOR_SCORE;
                boostedInPlace++;
              }
            }
            // 1a. Prepend anchored nodes the top-k missed.
            fresh = anchors
              .filter((a) => !existingIds.has(a.nodeId))
              .map((a) => ({ graphId, nodeId: a.nodeId, score: ANCHOR_SCORE, text: a.text }));
            for (const a of fresh) existingIds.add(a.nodeId);
            anchorCountTotal += fresh.length + boostedInPlace;
          }

          // Step 2: GNN anchor extension (Batch 11). For each anchor node,
          // pull up to GNN_ANCHOR_EXPANSION_PER_SEED recall-grade neighbors.
          // They get ANCHOR_SCORE too — same priority — because if the GNN
          // is confident-enough they're related to a literal-entity match,
          // they're "anchor-adjacent" and deserve the same forced inclusion.
          if (perGraphAdj && fresh.length > 0) {
            const anchorNeighbors = expandViaGnn(
              perGraphAdj,
              inspected,
              active,
              fresh.map((a) => a.nodeId),
              existingIds,
              GNN_ANCHOR_EXPANSION_PER_SEED,
            );
            for (const n of anchorNeighbors) {
              existingIds.add(n.nodeId);
              fresh.push({ graphId, nodeId: n.nodeId, score: ANCHOR_SCORE, text: n.text });
              gnnExpansionCountTotal += 1;
            }
          }

          // Step 3: GNN graph expansion (Batch 11). For each top-k node,
          // pull up to GNN_EXPANSION_PER_SEED recall-grade neighbors that
          // weren't already in the candidate pool. They get GNN_EXPANSION_SCORE
          // — high enough to be considered by federation budget, low enough
          // that strong organic matches still win.
          let expansion: Array<{ graphId: string; nodeId: string; score: number; text: string }> = [];
          if (perGraphAdj && ranked.length > 0) {
            const expansionNodes = expandViaGnn(
              perGraphAdj,
              inspected,
              active,
              ranked.map((r) => r.nodeId),
              existingIds,
              GNN_EXPANSION_PER_SEED,
            );
            expansion = expansionNodes.map((n) => ({
              graphId,
              nodeId: n.nodeId,
              score: GNN_EXPANSION_SCORE,
              text: n.text,
            }));
            gnnExpansionCountTotal += expansion.length;
          }

          // Composition: anchors (+ their GNN neighbors) first, then top-k
          // ranked, then GNN-expanded. Keep total at k for federation budget
          // honesty — when expansion exists, it displaces lower-scored tail
          // entries from `ranked`. When expansion is huge it might also
          // displace some ranked items, which is intentional: the GNN
          // expansion is the user-requested precision boost.
          if (fresh.length === 0 && expansion.length === 0) return ranked;
          const tailBudget = Math.max(0, k - fresh.length - expansion.length);
          return [...fresh, ...ranked.slice(0, tailBudget), ...expansion];
        });
        queryChain = result.then(() => undefined, () => undefined);
        return result;
      },
    };
    // Apply onlyGraphIds / exceptGraphIds scope. Without this filter,
    // cross_search and compare_engrams ignore the caller's engram list and
    // run a full federated recall over every graph — the scope footer in
    // the response looked correct but the actual retrieval was not scoped.
    const allGraphIds = host.listGraphs();
    const scopedGraphIds = opts?.onlyGraphIds?.length
      ? allGraphIds.filter(id => opts.onlyGraphIds!.includes(id))
      : opts?.exceptGraphIds?.length
        ? allGraphIds.filter(id => !opts.exceptGraphIds!.includes(id))
        : allGraphIds;
    // `consentedGraphIds` lets explicitly-named, consent-approved engrams (incl.
    // sensitive) bypass the shareability filter so a consented sensitive recall
    // actually returns data — still clamped by the per-tier budget cap. Proactive
    // recall passes nothing, so sensitive stays excluded by default.
    const sub = await federatedQuery(runner, scopedGraphIds, effectiveQuery, host.policyCfg, opts?.budget, opts?.consentedGraphIds);
    try {
      host.plasticityObserver?.(sub);
    } catch (err) {
      console.error(`[host] plasticity observer failed: ${(err as Error).message}`);
    }

    // Replace the federation module's flat bullet-point renderPrompt with the
    // SDK's rich === KNOWLEDGE SUBGRAPH === format. We re-serialize per graph
    // using only the budget-selected node IDs so the prompt stays within the
    // token budget and edge references point only to nodes the AI can see.
    let richPrompt = buildRichRecallPrompt(sub.byGraph, perGraphRich, (graphId) => host.getGraphMetadata(graphId)?.displayName ?? graphId);
    // ── Overlay merge (GLL + GNN) ───────────────────────────────────────────
    // Load both overlays once and surface any entries that touch the
    // budget-selected node set. Entries are badged [gll] / [gnn] so the AI
    // client never confuses inferred content with attested memory. Failures
    // are non-fatal — overlay data is non-authoritative; recall must still
    // return canonical results.
    let overlaySection: string | null = null;
    try {
      const includedIdsByGraph = new Map<string, Set<string>>();
      for (const [graphId, nodes] of sub.byGraph) {
        if (nodes.length === 0) continue;
        includedIdsByGraph.set(graphId, new Set(nodes.map((n) => n.nodeId)));
      }
      if (includedIdsByGraph.size > 0) {
        const [gll, gnn] = await Promise.all([
          host.loadGllOverlay(),
          host.loadGnnStore(),
        ]);
        overlaySection = buildOverlaySection(
          includedIdsByGraph,
          gll,
          gnn,
          (graphId) => host.getGraphMetadata(graphId)?.displayName ?? graphId,
        );
      }
    } catch (err) {
      console.error(`[host] overlay merge failed (non-fatal): ${(err as Error).message}`);
    }
    if (overlaySection) {
      richPrompt = (richPrompt ? richPrompt + '\n\n' : '') + overlaySection;
    }
    // Zero-result hint: when nothing came back, append a short diagnostic so
    // the AI client can relay likely causes (language mismatch, phrasing,
    // missing memory) to the user — and surface the local LLM as the missing
    // enrichment layer when it's disabled. Suppressed for queries shorter
    // than 3 chars (garbage) and when there are no engrams at all (first-run).
    if (sub.nodesIncluded === 0 && query.trim().length >= 3 && host.listGraphs().length > 0) {
      richPrompt = (richPrompt ? richPrompt + '\n\n' : '') + host.zeroResultHint();
    }
    // Enrichment audit trail: surface the rewrite to the AI client so it can
    // see what query actually hit the index. Useful for debugging "why did
    // this recall return X?" without exposing the LLM call internals.
    if (enrichmentNote) {
      richPrompt = (richPrompt ? richPrompt + '\n\n' : '') + `_${enrichmentNote}_`;
    }
    // Anchor audit trail: when literal-entity matches force-included nodes,
    // mention it. Helps the AI / user understand why a particular memory
    // surfaced even when its TF-IDF score was unremarkable.
    if (anchorCountTotal > 0) {
      richPrompt = (richPrompt ? richPrompt + '\n\n' : '') + `_anchored ${anchorCountTotal} node(s) on entities: ${queryEntities.join(', ')}_`;
    }
    // Source-filename hint: when a query entity matches a SOURCE FILENAME
    // (not the chunk content), the AI may be asking about a document by
    // its name. recall() can only see the chunks where the entity appears
    // IN THE TEXT — not the rest of the document. Tell the AI it can pull
    // the full source via recall_source if that's what the user actually
    // wants. Suppressed when the matched source is already heavily
    // represented in the result (avoids nagging on already-satisfied queries).
    if (queryEntities.length > 0) {
      const filenameHints = detectSourceFilenameMatches(
        host,
        scopedGraphIds,
        queryEntities,
        sub.byGraph,
      );
      if (filenameHints.length > 0) {
        const list = filenameHints
          .slice(0, 3) // cap to avoid overwhelming
          .map((h) => `"${h.refLabel}" (${h.matchedOn})`)
          .join(', ');
        const more = filenameHints.length > 3 ? ` (+ ${filenameHints.length - 3} more)` : '';
        richPrompt = (richPrompt ? richPrompt + '\n\n' : '') +
          `💡 _The query entities also match source-file names: ${list}${more}. ` +
          `recall() only surfaces chunks where the entity is in the chunk's text content. ` +
          `For the full document(s), use \`find_source(content:"…")\` or \`recall_source(sourceId)\`._`;
      }
    }
    // GNN-recall audit trail (Batch 11): surfaces when the neural network's
    // predicted edges actively brought in additional nodes (graph expansion
    // or anchor extension). Distinct from the existing inferred-layer
    // [gnn·edge] rows, which only DISPLAY predictions; this number reflects
    // predictions that changed WHICH NODES were recalled.
    if (gnnExpansionCountTotal > 0) {
      richPrompt = (richPrompt ? richPrompt + '\n\n' : '') + `_GNN expanded recall by ${gnnExpansionCountTotal} node(s) at ≥${Math.round(GNN_RECALL_THRESHOLD * 100)}% confidence_`;
    }
    return { ...sub, prompt: richPrompt };
}

export async function hostDigDeeper(
  host: RecallHost,
  query: string,
  opts?: {
    budget?: SubgraphBudget;
    onlyGraphIds?: string[];
    exceptGraphIds?: string[];
    skipEnrichment?: boolean;
    consentedGraphIds?: string[];
    recallPriority?: WorkPriority;
  },
): Promise<federation.FederatedSubgraph & {
  digDeeperProvenance: {
    contentMatch: { nodes: number; avgScore: number };
    sourceFilenameExpansion: { nodes: number; sources: string[] };
    crossEngramEntityHop: { nodes: number; viaEntities: string[]; sourceEngrams: number };
  };
}> {
    // Stage 1: standard recall. This already does entity anchoring + GNN
    // expansion at recall-grade threshold (Batch 11). We use it as the
    // foundation and layer additional stages on top.
    const stage1 = await host.recall(query, opts);

    // Snapshot what came from stage 1 so subsequent stages don't double-add.
    const includedNodeIds = new Set<string>();
    let stage1ScoreSum = 0;
    let stage1ScoreCount = 0;
    for (const nodes of stage1.byGraph.values()) {
      for (const n of nodes) {
        includedNodeIds.add(`${n.nodeId}`); // node ids are graph-unique enough for this dedupe
        if (typeof (n as { score?: number }).score === 'number') {
          stage1ScoreSum += (n as { score: number }).score;
          stage1ScoreCount += 1;
        }
      }
    }
    const stage1AvgScore = stage1ScoreCount > 0 ? stage1ScoreSum / stage1ScoreCount : 0;

    // Resolve effective engram scope.
    const allGraphIds = host.listGraphs();
    const scopedGraphIds = opts?.onlyGraphIds?.length
      ? allGraphIds.filter((id) => opts.onlyGraphIds!.includes(id))
      : opts?.exceptGraphIds?.length
        ? allGraphIds.filter((id) => !opts.exceptGraphIds!.includes(id))
        : allGraphIds;

    const queryEntities = cachedExtractQueryEntities(query);

    // ── Stage 2: source-filename expansion ─────────────────────────────
    // For sources whose filename matches a query entity, pull up to
    // DIG_DEEPER_PER_SOURCE_CAP representative chunks. "Representative"
    // = top-scoring against the query via this graph's own queryHybrid,
    // already deduplicated against stage 1.
    const stage2NewByGraph = new Map<string, Array<{ nodeId: string; text: string }>>();
    const stage2Sources: string[] = [];
    if (queryEntities.length > 0) {
      const filenameHints = detectSourceFilenameMatches(host, scopedGraphIds, queryEntities, stage1.byGraph);
      for (const hint of filenameHints) {
        // Use recall_source-style content pull: get the full source's nodes,
        // pick the first DIG_DEEPER_PER_SOURCE_CAP that aren't already in
        // stage 1. Lightweight — no extra TF-IDF/embedding call.
        const sources = host.listSources(hint.graphId);
        const src = sources.find((s) => s.sourceId === hint.sourceId);
        if (!src) continue;
        const g = host.must(hint.graphId);
        const active = host.activeNodeIds(hint.graphId);
        const inspected = host.opts.adapter.inspectNodes(g.handle);
        const previewById = new Map(inspected.map((n) => [n.id, n.contentPreview]));
        const fresh: Array<{ nodeId: string; text: string }> = [];
        for (const nodeId of src.nodeIds) {
          if (fresh.length >= DIG_DEEPER_PER_SOURCE_CAP) break;
          if (includedNodeIds.has(nodeId)) continue;
          if (!active.has(nodeId)) continue;
          const text = previewById.get(nodeId);
          if (!text) continue;
          fresh.push({ nodeId, text });
          includedNodeIds.add(nodeId);
        }
        if (fresh.length > 0) {
          const arr = stage2NewByGraph.get(hint.graphId) ?? [];
          arr.push(...fresh);
          stage2NewByGraph.set(hint.graphId, arr);
          stage2Sources.push(hint.refLabel);
        }
      }
    }
    const stage2NodeCount = Array.from(stage2NewByGraph.values()).reduce((sum, arr) => sum + arr.length, 0);

    // ── Stage 3: cross-engram entity hop ───────────────────────────────
    // Walk the cross-engram connection store for connections whose
    // sharedEntities overlap with any query entity. For each match,
    // include the OTHER side's node (the one not already in the result).
    // Cap total contributions to DIG_DEEPER_CROSS_ENGRAM_CAP.
    const stage3NewByGraph = new Map<string, Array<{ nodeId: string; text: string }>>();
    const stage3ViaEntities = new Set<string>();
    const stage3SourceEngrams = new Set<string>();
    let stage3Count = 0;
    if (queryEntities.length > 0) {
      try {
        const connections = await host.loadConnectionStore();
        const foldedEntities = new Set(queryEntities.map((e) => foldDiacritics(e).toLowerCase()));
        for (const conn of connections) {
          if (stage3Count >= DIG_DEEPER_CROSS_ENGRAM_CAP) break;
          if (!conn.sharedEntities || conn.sharedEntities.length === 0) continue;
          // Match on any shared entity that overlaps the query (folded).
          const matchedEntity = conn.sharedEntities.find((e) =>
            foldedEntities.has(foldDiacritics(e).toLowerCase()),
          );
          if (!matchedEntity) continue;
          // Pick the side that's NOT already in the result. If both sides
          // are in scope but only one is included by stage 1/2, pull the
          // other.
          const sides: Array<{ graphId: string; nodeId: string }> = [
            { graphId: conn.graphA, nodeId: conn.nodeA },
            { graphId: conn.graphB, nodeId: conn.nodeB },
          ];
          for (const side of sides) {
            if (stage3Count >= DIG_DEEPER_CROSS_ENGRAM_CAP) break;
            if (includedNodeIds.has(side.nodeId)) continue;
            if (!scopedGraphIds.includes(side.graphId)) continue;
            const g = host.graphs.get(side.graphId);
            if (!g) continue;
            const active = host.activeNodeIds(side.graphId);
            if (!active.has(side.nodeId)) continue;
            const inspected = host.opts.adapter.inspectNodes(g.handle);
            const node = inspected.find((n) => n.id === side.nodeId);
            if (!node) continue;
            const arr = stage3NewByGraph.get(side.graphId) ?? [];
            arr.push({ nodeId: side.nodeId, text: node.contentPreview });
            stage3NewByGraph.set(side.graphId, arr);
            includedNodeIds.add(side.nodeId);
            stage3ViaEntities.add(matchedEntity);
            stage3SourceEngrams.add(side.graphId);
            stage3Count += 1;
          }
        }
      } catch (e) {
        console.error(`[host] digDeeper: cross-engram entity hop failed (non-fatal): ${(e as Error).message}`);
      }
    }

    // ── Compose unified prompt ─────────────────────────────────────────
    // Stage 1's prompt already includes proper section structure. We
    // append stage 2 + stage 3 nodes as additional sections + a clearly-
    // labeled provenance footer + meta-instruction for the AI.
    const sections: string[] = [stage1.prompt];

    if (stage2NodeCount > 0) {
      sections.push('\n## DIG_DEEPER — Source-filename expansion');
      for (const [graphId, nodes] of stage2NewByGraph) {
        const dn = host.getGraphMetadata(graphId)?.displayName ?? graphId;
        sections.push(`### ${dn} (additional chunks from matched source filenames)`);
        for (const n of nodes) sections.push(`- ${n.text}`);
      }
    }

    if (stage3Count > 0) {
      sections.push('\n## DIG_DEEPER — Cross-engram entity hop');
      sections.push(`_Pulled via shared entities: ${[...stage3ViaEntities].join(', ')}_`);
      for (const [graphId, nodes] of stage3NewByGraph) {
        const dn = host.getGraphMetadata(graphId)?.displayName ?? graphId;
        sections.push(`### ${dn}`);
        for (const n of nodes) sections.push(`- ${n.text}`);
      }
    }

    // Provenance footer + meta-instruction for the AI.
    const provenance = {
      contentMatch: { nodes: stage1.nodesIncluded, avgScore: stage1AvgScore },
      sourceFilenameExpansion: { nodes: stage2NodeCount, sources: stage2Sources },
      crossEngramEntityHop: { nodes: stage3Count, viaEntities: [...stage3ViaEntities], sourceEngrams: stage3SourceEngrams.size },
    };

    sections.push('\n---');
    sections.push('🔍 _dig_deeper provenance:_');
    sections.push(`_• Content match (recall): ${provenance.contentMatch.nodes} nodes, avg score ${provenance.contentMatch.avgScore.toFixed(2)}_`);
    if (stage2NodeCount > 0) {
      sections.push(`_• Source-filename expansion: ${stage2NodeCount} nodes from ${stage2Sources.length} source(s): ${stage2Sources.slice(0, 3).join(', ')}${stage2Sources.length > 3 ? '…' : ''}_`);
    } else {
      sections.push(`_• Source-filename expansion: 0 nodes (no source filenames matched query entities)_`);
    }
    if (stage3Count > 0) {
      sections.push(`_• Cross-engram entity hop: ${stage3Count} nodes via ${stage3ViaEntities.size} shared entit${stage3ViaEntities.size === 1 ? 'y' : 'ies'} across ${stage3SourceEngrams.size} engram(s)_`);
    } else {
      sections.push(`_• Cross-engram entity hop: 0 nodes (no shared-entity connections matched)_`);
    }

    // Meta-instruction to the AI to surface anomalies for user feedback.
    const totalNew = stage2NodeCount + stage3Count;
    if (totalNew > stage1.nodesIncluded * 2 && stage1.nodesIncluded < 3) {
      // Stage 1 was thin and the expansion stages dominated — speculative
      // territory. Tell the user so they can validate / report.
      sections.push(`\n⚠️ _Heads-up for the user: the direct content match returned few nodes; most of this result came from indirect expansion (source-filename or cross-engram entity hop). The AI client should flag this to the user so they can confirm whether these expanded results are actually relevant — and report mismatches to the developer if they are consistently off-base._`);
    }

    return {
      ...stage1,
      prompt: sections.join('\n'),
      // Also bump the federation counts so the caller's audit numbers
      // reflect the full pipeline.
      nodesIncluded: stage1.nodesIncluded + totalNew,
      digDeeperProvenance: provenance,
    };
}
