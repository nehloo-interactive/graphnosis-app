// ── Recall passage rendering: coalesce · header · boundary repair ───────────
//
// WHY THIS FILE EXISTS
//
// Records longer than ~500 characters are split by the SDK chunker into
// ~500-char, ~3-sentence nodes. The splitter breaks after EVERY `.` `!` `?`
// with no whitespace required and rejoins with a single space, so boundaries
// land mid-token: "0.7.4" becomes "0. 7." + "4 …", "host.ts" becomes
// "host. ts", "??" becomes "? ?".
//
// NO TEXT IS LOST — five audited records reassembled character-identical to
// the authored input (441/441, 598/598, 387/387, zero delete/replace opcodes).
// This is a READ-PATH COHERENCE problem: `recall` returns INDIVIDUAL NODES, so
// an agent sees fragments that begin mid-token, end mid-sentence, and carry no
// subject.
//
// Everything here is READ-SIDE. Nothing is re-ingested, nothing is rewritten
// on disk, and content already stored damaged is repaired only in the rendered
// prompt.
//
// THREE MITIGATIONS, all pure-render (scoring, selection and caps are
// untouched — the federation has already decided WHICH nodes are included
// before any of this runs):
//
//   A — COALESCE  two or more chunks of the SAME source render as ONE
//                 contiguous passage in `SourceRecord.nodeIds` order (that
//                 array preserves chunk sequence — same fact recall_source
//                 relies on). A gap of exactly ONE missing chunk is filled.
//   B — HEADER    one contextual header per emitted passage carrying the
//                 source label and the position range ("chunks 2-4 of 9"),
//                 so a fragment is self-describing when it stands alone.
//   C — REPAIR    when a seam is broken, pull ONLY the fragment needed to
//                 close it: the previous chunk's trailing sentence and/or the
//                 next chunk's leading sentence. ONE FRAGMENT PER SEAM — not
//                 one chunk per side. Conditional: a clean sentence boundary
//                 costs nothing, which is what makes this cheap enough to be
//                 the default rather than an escalation.

// ── Sentence-boundary model ─────────────────────────────────────────────────
//
// The damage is caused by a splitter that treats EVERY `.` `!` `?` as a
// sentence end. The repair therefore needs the STRICTER, correct definition:
// a real boundary is terminal punctuation followed by whitespace AND then an
// uppercase letter or an opening quote/bracket. A digit or a lowercase letter
// after the terminator is the signature of a shattered token ("0. 7.",
// "host. ts") and is explicitly NOT a boundary.
const REAL_BOUNDARY = /[.!?]["'”’)\]]?(?=\s+["'“‘(\[]?\p{Lu})/gu;

/** Terminal punctuation at the very end of the text (optionally closed by a quote/bracket). */
const ENDS_WITH_TERMINATOR = /[.!?]["'”’)\]]?\s*$/u;

/** A short digits-only token immediately before the final terminator —
 *  "… 0. 11." — the exact residue of a shattered version number. Capped at
 *  three digits so a sentence that legitimately ends in a year ("shipped in
 *  2024.") is not mistaken for a shattered token and charged for a repair. */
const ENDS_WITH_NUMERIC_FRAGMENT = /(?:^|\s)\d{1,3}["'”’)\]]?[.!?]["'”’)\]]?\s*$/u;

/** Node types that BYPASS the splitter and are immune to the seam damage:
 *  titles, section headers, document stubs and session summaries. They are
 *  never coalesced — the SDK serializer routes them into different blocks
 *  (or drops them), and folding one into a passage would change which block
 *  the whole passage lands in. */
const NON_CHUNK_TYPES = new Set(['section', 'document', 'session-summary', 'title']);

/** Max characters a single repair fragment may contribute. A repair is meant
 *  to close a seam, not to smuggle a neighboring chunk in through the render
 *  layer. 240 chars ≈ 60 tokens. */
export const MAX_REPAIR_FRAGMENT_CHARS = 240;

/** Max WHOLE CHUNKS a single passage may gap-fill (E).
 *
 *  WHY 1. The run-builder refuses a two-chunk gap because pulling ~1000 chars
 *  the ranker declined would be "an unauthorised retrieval decision made by
 *  the render layer". Nothing bounded how many ONE-chunk gaps a single run
 *  could fill, so the same decision was taken repeatedly: measured on an
 *  alternating 21-chunk selection under shipping caps, TEN gaps were filled
 *  and the result was one passage covering chunks 1-21 of 21 — 1817 chars of
 *  body against 941 chars of selected content. Ten one-chunk fills is the
 *  refused decision ten times over.
 *
 *  ONE fill per passage still closes the common case (a single dropped chunk
 *  between two hits) and keeps the passage recognisably the selected material.
 *  Further gaps are not invented — the run splits, exactly as it does for a
 *  two-chunk gap, and the refusal is counted under its own reason. */
export const MAX_GAP_FILLS_PER_PASSAGE = 1;

/** Verdict from the seam detector. Pure — depends only on the chunk's own text. */
export interface SeamVerdict {
  /** The chunk starts mid-stream: first character is lowercase or a digit. */
  needsLeading: boolean;
  /** The chunk ends mid-stream: no terminal punctuation, or the terminator is
   *  preceded by a digits-only token (shattered version number). */
  needsTrailing: boolean;
  /** Human-readable justification, for the audit footer and for tests. */
  reason: string;
}

/**
 * THE SEAM DETECTOR (pure — canned strings in, verdict out, no cortex).
 *
 * Repair fires only when the matched chunk STARTS with a lowercase letter or a
 * digit, or ENDS mid-token. A chunk that starts at a capital letter after a
 * clean sentence end needs nothing and is returned unchanged — most hits pay
 * nothing at all.
 */
export function detectSeam(text: string): SeamVerdict {
  const t = text.trim();
  if (t.length === 0) return { needsLeading: false, needsTrailing: false, reason: 'empty' };
  const first = t[0]!;
  // Lowercase letter or digit at position 0 ⇒ the sentence started in the
  // previous chunk. Punctuation (a dash, an opening quote) is left alone: it
  // is legitimate prose formatting, not the splitter's signature.
  const needsLeading = /\p{Ll}/u.test(first) || /\d/.test(first);
  const noTerminator = !ENDS_WITH_TERMINATOR.test(t);
  const numericFragment = ENDS_WITH_NUMERIC_FRAGMENT.test(t);
  const needsTrailing = noTerminator || numericFragment;
  const reasons: string[] = [];
  if (needsLeading) reasons.push(/\d/.test(first) ? 'starts with a digit' : 'starts lowercase');
  if (noTerminator) reasons.push('no terminal punctuation');
  else if (numericFragment) reasons.push('ends on a numeric fragment');
  return {
    needsLeading,
    needsTrailing,
    reason: reasons.length > 0 ? reasons.join(' + ') : 'clean sentence boundaries — no repair needed',
  };
}

/** True when `text` begins mid-stream — used to test a NEIGHBOR chunk, which
 *  is the strongest available evidence that the seam before it is broken. */
export function startsMidStream(text: string): boolean {
  return detectSeam(text).needsLeading;
}

/**
 * The trailing sentence of the PREVIOUS chunk: everything after its last REAL
 * sentence boundary. For "… settled. The SHIPPED SDK 0. 7." this returns
 * "The SHIPPED SDK 0. 7." — the whole shattered version number comes back,
 * because "0. 7." is not a real boundary.
 */
export function trailingFragment(prevText: string, maxChars = MAX_REPAIR_FRAGMENT_CHARS): string {
  const t = prevText.trim();
  if (t.length === 0) return '';
  REAL_BOUNDARY.lastIndex = 0;
  let cut = 0;
  for (const m of t.matchAll(REAL_BOUNDARY)) {
    cut = m.index + m[0].length;
  }
  let frag = t.slice(cut).trim();
  if (frag.length === 0) frag = t; // no real boundary at all → the whole chunk
  if (frag.length > maxChars) frag = '…' + frag.slice(frag.length - maxChars).trim();
  return frag;
}

/**
 * The leading sentence of the NEXT chunk: everything up to and including its
 * first REAL sentence boundary. For "0 dev tree. Then the guard …" this
 * returns "0 dev tree.".
 */
export function leadingFragment(nextText: string, maxChars = MAX_REPAIR_FRAGMENT_CHARS): string {
  const t = nextText.trim();
  if (t.length === 0) return '';
  REAL_BOUNDARY.lastIndex = 0;
  const m = REAL_BOUNDARY.exec(t);
  REAL_BOUNDARY.lastIndex = 0;
  let frag = m ? t.slice(0, m.index + m[0].length).trim() : t;
  if (frag.length > maxChars) frag = frag.slice(0, maxChars).trim() + '…';
  return frag;
}

// ── Chunk index (ingestion order) ───────────────────────────────────────────

/** Where a node sits inside its source's chunk sequence. */
export interface ChunkPosition {
  sourceId: string;
  /** 0-based index into SourceRecord.nodeIds. */
  index: number;
  /** Total chunks in the source. */
  total: number;
  /** Display label for the source (basename of its ref). */
  label: string;
  /** The source's full ordered nodeIds — neighbor lookup for repair/gap-fill. */
  nodeIds: readonly string[];
}

export type ChunkIndex = Map<string, ChunkPosition>;

/** Basename of a path-shaped ref, capped for display. */
export function sourceLabel(ref: string, sourceId: string): string {
  const base = ref
    ? (ref.includes('/') ? ref.split('/').pop() ?? ref : ref)
    : sourceId;
  return base.length > 60 ? base.slice(0, 57) + '…' : base;
}

/** Build nodeId → ChunkPosition from a graph's source records. */
export function buildChunkIndex(
  sources: ReadonlyArray<{ sourceId: string; ref?: string; nodeIds?: readonly string[] }>,
): ChunkIndex {
  const idx: ChunkIndex = new Map();
  for (const src of sources) {
    const nodeIds = src.nodeIds ?? [];
    if (nodeIds.length === 0) continue;
    const label = sourceLabel(src.ref ?? '', src.sourceId);
    for (let i = 0; i < nodeIds.length; i++) {
      // First writer wins: a node claimed by two sources (possible after a
      // transfer) keeps its original position rather than flip-flopping.
      if (idx.has(nodeIds[i]!)) continue;
      idx.set(nodeIds[i]!, { sourceId: src.sourceId, index: i, total: nodeIds.length, label, nodeIds });
    }
  }
  return idx;
}

// ── Render input / output ───────────────────────────────────────────────────

/** The per-node data the renderer needs. Mirrors what the SDK subgraph holds;
 *  `content` is the node's FULL body, not a preview. */
export interface RenderNode {
  id: string;
  content: string;
  type: string;
  score: number;
  /** `node.source.section`, when the SDK captured one. */
  section?: string;
  /** `node.metadata.sessionDate`, when present. */
  sessionDate?: string;
  /** `node.metadata.sessionId`, when present (session-summary nodes). */
  sessionId?: string;
  /** `node.metadata.claims`, ' || '-separated (session-summary nodes). */
  claims?: string;
}

/** One emitted unit: a single node, or a coalesced run of same-source chunks. */
export interface Passage {
  /** Selected node ids in ingestion order. */
  nodeIds: string[];
  /** Gap-filled node ids — present in the body, never selected by the ranker. */
  filledNodeIds: string[];
  type: string;
  /** Max score among the selected nodes (the run inherits its best hit). */
  score: number;
  sourceId?: string;
  label?: string;
  /** 0-based inclusive positions this passage covers. */
  startIndex?: number;
  endIndex?: number;
  total?: number;
  /** Fragment pulled from the previous chunk to close the leading seam. */
  leadRepair?: string;
  /** Fragment pulled from the next chunk to close the trailing seam. */
  tailRepair?: string;
  /** Final rendered text, repairs included, exactly as it reaches the model. */
  body: string;
  section?: string;
  sessionDate?: string;
  sessionId?: string;
  claims?: string;
}

/** How much the render layer is allowed to ADD on top of the selected nodes. */
export interface ExpansionBudget {
  /** Hard ceiling in tokens for everything A and C add. */
  maxExpansionTokens: number;
  /** Per-source ceiling so one long document cannot eat the whole allowance. */
  maxExpansionTokensPerSource: number;
  /** Ceiling on gap-filled WHOLE chunks, so the recall's node cap keeps
   *  meaning something: a filled chunk is a whole node's worth of body text
   *  the ranker did not select. Repair fragments are sentences, not nodes,
   *  and are bounded by the token ceilings instead. */
  maxGapFills: number;
}

export interface PassageOptions {
  coalesce: boolean;
  header: boolean;
  repair: boolean;
  budget: ExpansionBudget;
  /** Full, untruncated content for a node id not present in the selected set
   *  (gap-fill and repair neighbors). Returns null when unavailable. */
  getFullContent(nodeId: string): string | null;
}

export interface PassageBuildResult {
  passages: Passage[];
  /** Tokens spent on gap-fill (A) and repair fragments (C) — the REFUSABLE
   *  expansion, charged against the budget above. Header cost is reported
   *  separately in `headerTokens`, not because it is free but because it is
   *  not refusable: see the note there. */
  expansionTokens: number;
  /** Tokens the headers (B) will add when `opts.header` is on, counted here so
   *  something actually accounts for them.
   *
   *  WHY THIS EXISTS. This field used to be a comment saying headers were
   *  "accounted separately by the renderer" — nothing accounted them. Measured
   *  on 40 single-chunk passages from 40 four-chunk sources: headers off 411
   *  tok, headers on 828 tok (+101.5%), while `expansionTokens` read 0 and the
   *  audit footer printed nothing at all, because a header contributes no
   *  `parts` entry. On a real cross-engram recall the unreported cost was
   *  +174 tok on a 2375-tok prompt.
   *
   *  NOT deducted from the expansion budget: a header is part of the render
   *  shape for every emitted passage, not an optional pull that can be refused
   *  halfway through a result set. It is MEASURED and DISCLOSED; gap-fill and
   *  repair remain the only things the budget can turn down. */
  headerTokens: number;
  /** How many passages actually got a header — the trigger for printing the
   *  audit footer even when nothing coalesced and no seam was repaired. */
  headersEmitted: number;
  /** Counters for the audit footer. */
  stats: {
    coalescedRuns: number;
    nodesCoalesced: number;
    gapsFilled: number;
    gapsRefusedForBudget: number;
    /** Gaps left split because the passage hit MAX_GAP_FILLS_PER_PASSAGE.
     *  Distinct from the budget reason: the allowance may be untouched. */
    gapsRefusedForCap: number;
    /** Gaps left split because the neighbor node could not be READ (deleted,
     *  forgotten, or absent from the store). Previously counted as a budget
     *  refusal, which made the footer blame the budget for a missing node. */
    gapsRefusedUnreadable: number;
    seamsRepaired: number;
    repairsRefusedForBudget: number;
  };
}

/** The token estimator used everywhere in this file. Same chars/4 heuristic
 *  the federation's own budget accounting uses, so the numbers are comparable. */
export function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * BUDGET POLICY — what gets dropped first when expansion would overflow.
 *
 * Expansion is ADDITIVE ONLY. It never removes, reorders or de-selects a node
 * the federation chose, so a coalesced passage CANNOT push out another
 * source's only hit: when the allowance runs out the response is to drop the
 * EXPANSION, never the selected content.
 *
 * Spend order, cheapest-and-most-valuable first:
 *   1. Headers (B) — never charged here. One header replaces N per-node
 *      prefixes on a coalesced run, so the net effect is usually a saving.
 *   2. Boundary repair (C) — ≤ MAX_REPAIR_FRAGMENT_CHARS per seam (≈60 tokens),
 *      and only for seams the detector says are broken.
 *   3. Gap-fill (A) — a whole ~500-char chunk (≈125 tokens), the most
 *      expensive item, so it is REFUSED FIRST. A refused gap-fill splits the
 *      run into two passages at the gap; it never silently joins
 *      non-adjacent text.
 *
 * Both passes go round-robin over sources, so a 400-chunk document cannot
 * consume the whole allowance before a 3-chunk note gets its first repair.
 */
export function buildPassages(
  selected: RenderNode[],
  chunkIndex: ChunkIndex,
  opts: PassageOptions,
): PassageBuildResult {
  const stats = {
    coalescedRuns: 0,
    nodesCoalesced: 0,
    gapsFilled: 0,
    gapsRefusedForBudget: 0,
    gapsRefusedForCap: 0,
    gapsRefusedUnreadable: 0,
    seamsRepaired: 0,
    repairsRefusedForBudget: 0,
  };
  let spent = 0;
  const spentPerSource = new Map<string, number>();
  const canSpend = (sourceId: string, tokens: number): boolean => {
    if (spent + tokens > opts.budget.maxExpansionTokens) return false;
    const used = spentPerSource.get(sourceId) ?? 0;
    if (used + tokens > opts.budget.maxExpansionTokensPerSource) return false;
    return true;
  };
  const spend = (sourceId: string, tokens: number): void => {
    spent += tokens;
    spentPerSource.set(sourceId, (spentPerSource.get(sourceId) ?? 0) + tokens);
  };

  const byId = new Map(selected.map((n) => [n.id, n]));

  // Partition: chunks of a multi-chunk source (coalescable) vs everything else
  // (section/title nodes, single-chunk sources, nodes with no source record).
  // Section/title nodes bypass the splitter entirely and are immune to the
  // damage — they are emitted as-is, just with a label when one is known.
  const grouped = new Map<string, RenderNode[]>();
  const standalone: RenderNode[] = [];
  for (const n of selected) {
    const pos = chunkIndex.get(n.id);
    if (!pos || pos.total <= 1 || NON_CHUNK_TYPES.has(n.type)) { standalone.push(n); continue; }
    const arr = grouped.get(pos.sourceId) ?? [];
    arr.push(n);
    grouped.set(pos.sourceId, arr);
  }

  // ── Runs ──────────────────────────────────────────────────────────────────
  type Run = { sourceId: string; nodes: RenderNode[]; positions: number[]; gapAfter: number[] };
  const runsBySource = new Map<string, Run[]>();
  for (const [sourceId, nodes] of grouped) {
    nodes.sort((a, b) => chunkIndex.get(a.id)!.index - chunkIndex.get(b.id)!.index);
    const runs: Run[] = [];
    let current: Run | null = null;
    for (const n of nodes) {
      const idx = chunkIndex.get(n.id)!.index;
      if (!current) {
        current = { sourceId, nodes: [n], positions: [idx], gapAfter: [] };
        continue;
      }
      const prevIdx = current.positions[current.positions.length - 1]!;
      const delta = idx - prevIdx;
      // delta === 1 → adjacent, always coalesce.
      // delta === 2 → exactly ONE missing chunk, a fillable gap.
      // delta > 2  → NOT filled. Two or more unselected chunks is ~1000+ chars
      //   of material the ranker actively declined; pulling it in would be an
      //   unauthorised retrieval decision made by the render layer, and it
      //   would dwarf the passage that earned its place. Split instead.
      if (opts.coalesce && (delta === 1 || delta === 2)) {
        if (delta === 2) current.gapAfter.push(prevIdx + 1);
        current.nodes.push(n);
        current.positions.push(idx);
      } else {
        runs.push(current);
        current = { sourceId, nodes: [n], positions: [idx], gapAfter: [] };
      }
    }
    if (current) runs.push(current);
    runsBySource.set(sourceId, runs);
  }

  // ── Pass 1: boundary repair (C), round-robin over sources ─────────────────
  // Cheap and conditional, so it is funded before gap-fill.
  type Pending = { run: Run; lead?: string; tail?: string };
  const pending = new Map<Run, Pending>();
  for (const runs of runsBySource.values()) for (const run of runs) pending.set(run, { run });

  if (opts.repair) {
    const queues = [...runsBySource.values()].map((r) => [...r]);
    let progress = true;
    while (progress) {
      progress = false;
      for (const q of queues) {
        const run = q.shift();
        if (!run) continue;
        progress = true;
        const p = pending.get(run)!;
        const first = run.nodes[0]!;
        const last = run.nodes[run.nodes.length - 1]!;
        const startPos = run.positions[0]!;
        const endPos = run.positions[run.positions.length - 1]!;
        const meta = chunkIndex.get(first.id)!;

        // Leading seam: the run's first chunk starts mid-stream and there IS a
        // previous chunk to pull the closing fragment from.
        //
        // The neighbor's text is read even when the seam turns out to be
        // clean — getFullNodeContent is an O(1) store read and costs ZERO
        // tokens. Only the FRAGMENT is charged, and only when a seam is
        // actually broken.
        //
        // A neighbor that is itself selected (but landed in a different
        // passage, because a two-chunk gap split the run) still contributes
        // its fragment: ~10 tokens of overlap is a cheaper failure than an
        // agent reading "4 chunker. js:57 …" with no idea what the 4 belongs to.
        if (detectSeam(first.content).needsLeading && startPos > 0) {
          const prevId = meta.nodeIds[startPos - 1];
          const prevText = prevId ? (byId.get(prevId)?.content ?? opts.getFullContent(prevId)) : null;
          if (prevText) {
            const frag = trailingFragment(prevText);
            const cost = estTokens(frag);
            if (frag && canSpend(run.sourceId, cost)) {
              spend(run.sourceId, cost);
              p.lead = frag;
              stats.seamsRepaired += 1;
            } else if (frag) {
              stats.repairsRefusedForBudget += 1;
            }
          }
        }

        // Trailing seam: either the run's last chunk ends mid-stream, or the
        // NEXT chunk starts mid-stream — the strongest available evidence that
        // the seam between them was cut mid-token.
        const nextPos = endPos + 1;
        if (nextPos < meta.total) {
          const nextId = meta.nodeIds[nextPos];
          const nextText = nextId ? (byId.get(nextId)?.content ?? opts.getFullContent(nextId)) : null;
          const broken = detectSeam(last.content).needsTrailing
            || (nextText ? startsMidStream(nextText) : false);
          if (broken && nextText) {
            const frag = leadingFragment(nextText);
            const cost = estTokens(frag);
            if (frag && canSpend(run.sourceId, cost)) {
              spend(run.sourceId, cost);
              p.tail = frag;
              stats.seamsRepaired += 1;
            } else if (frag) {
              stats.repairsRefusedForBudget += 1;
            }
          }
        }
      }
    }
  }

  // ── Pass 2: gap-fill (A), round-robin over sources ────────────────────────
  // Most expensive item, funded last, refused first.
  const fillText = new Map<Run, Map<number, string>>();
  {
    const queues = [...runsBySource.values()].map((r) => [...r]);
    let progress = true;
    while (progress) {
      progress = false;
      for (const q of queues) {
        const run = q.shift();
        if (!run) continue;
        progress = true;
        if (run.gapAfter.length === 0) continue;
        const meta = chunkIndex.get(run.nodes[0]!.id)!;
        const filled = new Map<number, string>();
        for (const gapPos of run.gapAfter) {
          const gapId = meta.nodeIds[gapPos];
          const text = gapId ? opts.getFullContent(gapId) : null;
          // An unreadable neighbor is a MISSING NODE, not a spending decision.
          // Counting it as a budget refusal made the footer report "gap(s) left
          // split (budget)" on a run where the allowance was untouched.
          if (!text) { stats.gapsRefusedUnreadable += 1; continue; }
          // Per-passage bound (E) — see MAX_GAP_FILLS_PER_PASSAGE. Checked
          // BEFORE the global caps so the reason reported is the specific one.
          if (filled.size >= MAX_GAP_FILLS_PER_PASSAGE) { stats.gapsRefusedForCap += 1; continue; }
          if (stats.gapsFilled >= opts.budget.maxGapFills) { stats.gapsRefusedForBudget += 1; continue; }
          const cost = estTokens(text);
          if (!canSpend(run.sourceId, cost)) { stats.gapsRefusedForBudget += 1; continue; }
          spend(run.sourceId, cost);
          filled.set(gapPos, text);
          stats.gapsFilled += 1;
        }
        if (filled.size > 0) fillText.set(run, filled);
      }
    }
  }

  // ── Emit ──────────────────────────────────────────────────────────────────
  const passages: Passage[] = [];

  for (const n of standalone) {
    const pos = chunkIndex.get(n.id);
    passages.push({
      nodeIds: [n.id],
      filledNodeIds: [],
      type: n.type,
      score: n.score,
      body: n.content,
      ...(pos ? { sourceId: pos.sourceId, label: pos.label, startIndex: pos.index, endIndex: pos.index, total: pos.total } : {}),
      ...(n.section !== undefined ? { section: n.section } : {}),
      ...(n.sessionDate !== undefined ? { sessionDate: n.sessionDate } : {}),
      ...(n.sessionId !== undefined ? { sessionId: n.sessionId } : {}),
      ...(n.claims !== undefined ? { claims: n.claims } : {}),
    });
  }

  for (const runs of runsBySource.values()) {
    for (const run of runs) {
      const meta = chunkIndex.get(run.nodes[0]!.id)!;
      const filled = fillText.get(run);
      const p = pending.get(run)!;
      // A gap we could NOT fill splits the run: never join non-adjacent text.
      const segments: Array<{ nodes: RenderNode[]; positions: number[]; filled: number[] }> = [];
      let seg = { nodes: [] as RenderNode[], positions: [] as number[], filled: [] as number[] };
      for (let i = 0; i < run.nodes.length; i++) {
        const idx = run.positions[i]!;
        if (i > 0) {
          const prevIdx = run.positions[i - 1]!;
          if (idx - prevIdx === 2) {
            const gapPos = prevIdx + 1;
            if (filled?.has(gapPos)) seg.filled.push(gapPos);
            else { segments.push(seg); seg = { nodes: [], positions: [], filled: [] }; }
          }
        }
        seg.nodes.push(run.nodes[i]!);
        seg.positions.push(idx);
      }
      segments.push(seg);

      for (let s = 0; s < segments.length; s++) {
        const sg = segments[s]!;
        if (sg.nodes.length === 0) continue;
        const startPos = sg.positions[0]!;
        const endPos = sg.positions[sg.positions.length - 1]!;
        // Body: walk the positions covered, taking selected content or fill.
        const parts: string[] = [];
        for (let pos = startPos; pos <= endPos; pos++) {
          const node = sg.nodes[sg.positions.indexOf(pos)];
          const text = node ? node.content : filled?.get(pos);
          if (text) parts.push(text.trim());
        }
        // Repairs attach only to the OUTER edges of the original run — an
        // inner split boundary is an unfilled gap, and inventing a bridge
        // across it would be a fabrication.
        const lead = s === 0 ? p.lead : undefined;
        const tail = s === segments.length - 1 ? p.tail : undefined;
        const allParts = [
          ...(lead ? [lead] : []),
          ...parts,
          ...(tail ? [tail] : []),
        ];
        passages.push({
          nodeIds: sg.nodes.map((n) => n.id),
          filledNodeIds: sg.filled.map((pos) => meta.nodeIds[pos]!).filter(Boolean),
          type: sg.nodes[0]!.type,
          score: Math.max(...sg.nodes.map((n) => n.score)),
          sourceId: meta.sourceId,
          label: meta.label,
          startIndex: startPos,
          endIndex: endPos,
          total: meta.total,
          ...(lead ? { leadRepair: lead } : {}),
          ...(tail ? { tailRepair: tail } : {}),
          body: joinParts(allParts),
          // A section label is emitted ONLY when every chunk in the passage
          // agrees on it. A coalesced run that spans two headings has no
          // single section, and asserting the first one would be a fabrication.
          ...(sg.nodes.every((n) => n.section === sg.nodes[0]!.section) && sg.nodes[0]!.section !== undefined
            ? { section: sg.nodes[0]!.section }
            : {}),
          ...(sg.nodes[0]!.sessionDate !== undefined ? { sessionDate: sg.nodes[0]!.sessionDate } : {}),
        });
        if (sg.nodes.length > 1) {
          stats.coalescedRuns += 1;
          stats.nodesCoalesced += sg.nodes.length;
        }
      }
    }
  }

  // ── Header accounting (A) ─────────────────────────────────────────────────
  // Charged here, from the SAME passage objects and the SAME predicate
  // serializePassages uses, so the two cannot drift into reporting a cost for
  // a header that is never printed (or missing one that is). Each header is
  // counted with the `|` that joins it to the node line's other tags, since
  // that pipe is the byte the header actually adds; the chars/4 estimate is
  // taken over the total rather than per header so it matches how the same
  // heuristic scores the whole prompt.
  let headerChars = 0;
  let headersEmitted = 0;
  if (opts.header) {
    for (const p of passages) {
      if (!isHeaderedPassage(p)) continue;
      const h = passageHeader(p);
      if (!h) continue;
      headersEmitted += 1;
      headerChars += h.length + 1;
    }
  }

  return {
    passages,
    expansionTokens: spent,
    headerTokens: headerChars > 0 ? Math.ceil(headerChars / 4) : 0,
    headersEmitted,
    stats,
  };
}

/**
 * Join adjacent pieces. A BROKEN seam is rejoined with the single space the
 * splitter itself used, which reassembles the shattered token exactly
 * ("0. 7." + "4 chunker." → "0. 7. 4 chunker."). A CLEAN seam keeps a newline
 * so paragraph structure survives.
 */
export function joinParts(parts: string[]): string {
  const kept = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  if (kept.length === 0) return '';
  let out = kept[0]!;
  for (let i = 1; i < kept.length; i++) {
    const next = kept[i]!;
    const brokenSeam = !ENDS_WITH_TERMINATOR.test(out) || startsMidStream(next);
    out += (brokenSeam ? ' ' : '\n') + next;
  }
  return out;
}

// ── Serialization ───────────────────────────────────────────────────────────
//
// Mirrors the SDK's `serializeSubgraph` output format (same === KNOWLEDGE
// SUBGRAPH === envelope, same [shortId|type|score|tags] node lines, same
// edge blocks) so nothing downstream has to learn a new shape — with ONE
// change: a node line may now carry a contextual header and cover a coalesced
// run of chunks.
//
// Short ids stay per-NODE (a passage of three chunks is labeled "n2+n3+n4")
// so the edge blocks, which reference individual nodes, still resolve.

export interface SerializeOptions {
  header: boolean;
  directedEdges: ReadonlyArray<{ from: string; to: string; type: string; weight: number }>;
  undirectedEdges: ReadonlyArray<{ nodes: [string, string]; type: string; weight: number }>;
}

/** Which passages carry a header — the SAME set `serializePassages` renders as
 *  evidence node lines. Session summaries get their own tag block, and
 *  document/section passages are not emitted at all, so neither is charged for
 *  a header. Shared so the accounting and the rendering cannot disagree. */
export function isHeaderedPassage(p: Passage): boolean {
  return p.type !== 'session-summary' && p.type !== 'document' && p.type !== 'section';
}

/** Contextual header (B): source label, plus the position range when the
 *  passage spans more than one chunk.
 *  Uses the `doc:` prefix so it never collides with the SDK serializer's
 *  `src:` tag, which means `node.source.section` — a different fact, and one
 *  the renderer still emits alongside this when the whole passage shares it. */
export function passageHeader(p: Passage): string {
  if (!p.label) return '';
  // B — SINGLE-CHUNK PASSAGES GET THE LABEL AND NOTHING ELSE.
  //
  // WHY. Measured on the owner's live cortex: a cross-engram query returned 31
  // nodes from 31 DISTINCT sources — zero repeats, nothing to coalesce, every
  // passage one chunk. A query scoped to one engram returned 17 nodes from 16
  // sources: exactly ONE source contributed two nodes. Single-chunk passages
  // dominate real result sets, and `chunk 1 of 4` was being paid on every one
  // of them. A range that starts and ends at the same chunk tells the reader
  // nothing they can act on — the label already answers "which document?", and
  // that is the whole job of the header on a lone hit.
  //
  // The full `chunks A-B of N` form is kept for multi-chunk passages, where the
  // range says how much of the document the passage spans and what it omits.
  //
  // TRADE-OFF, stated plainly: a single-chunk passage that received a seam
  // repair no longer carries its `|seam<>` marker. That provenance now lives
  // only in the `_render:` footer, which reports the repair count for the whole
  // recall. Restoring the per-passage marker costs ~2 tokens on repaired hits.
  const single = p.total === undefined || p.total <= 1
    || p.startIndex === undefined || p.endIndex === undefined
    || p.startIndex === p.endIndex;
  if (single) return `doc:${p.label}`;
  const range = `chunks ${p.startIndex! + 1}-${p.endIndex! + 1} of ${p.total}`;
  const fill = p.filledNodeIds.length > 0 ? ` +${p.filledNodeIds.length} filled` : '';
  const seam = (p.leadRepair ? '<' : '') + (p.tailRepair ? '>' : '');
  return `doc:${p.label}|${range}${fill}${seam ? `|seam${seam}` : ''}`;
}

export function serializePassages(passages: Passage[], opts: SerializeOptions): string {
  const ordered = [...passages].sort((a, b) => b.score - a.score);
  const shortIds = new Map<string, string>();
  let counter = 0;
  for (const p of ordered) {
    for (const id of p.nodeIds) shortIds.set(id, `n${++counter}`);
  }
  const nodeCount = ordered.reduce((s, p) => s + p.nodeIds.length, 0);
  const directed = opts.directedEdges.filter((e) => shortIds.has(e.from) && shortIds.has(e.to));
  const undirected = opts.undirectedEdges.filter((e) => shortIds.has(e.nodes[0]) && shortIds.has(e.nodes[1]));

  const lines: string[] = [];
  lines.push(`=== KNOWLEDGE SUBGRAPH (${nodeCount} nodes, ${directed.length + undirected.length} edges) ===`);
  lines.push('');

  const summaries = ordered.filter((p) => p.type === 'session-summary');
  const evidence = ordered.filter(isHeaderedPassage);

  if (summaries.length > 0) {
    lines.push('--- SESSION SUMMARIES ---');
    for (const p of summaries) {
      const tags = [
        p.sessionId ? `session:${p.sessionId}` : '',
        p.sessionDate ? `date:${p.sessionDate}` : '',
      ].filter(Boolean).join('|');
      lines.push(`[${idTag(p, shortIds)}|summary|${p.score.toFixed(2)}${tags ? '|' + tags : ''}] ${p.body}`);
      if (p.claims && p.claims.trim()) {
        const claims = p.claims.split(' || ').map((c) => c.trim()).filter(Boolean).slice(0, 10);
        if (claims.length > 0) lines.push(`  claims: ${claims.join(' | ')}`);
      }
    }
    lines.push('');
  }

  lines.push('--- NODES ---');
  for (const p of evidence) {
    // `src:` keeps its SDK meaning (node.source.section). The passage header
    // is added ALONGSIDE it, never in place of it — dropping the section would
    // trade one piece of position information for another.
    const tags = [
      p.section ? `src:${p.section}` : '',
      opts.header ? passageHeader(p) : '',
      p.sessionDate ? `date:${p.sessionDate}` : '',
    ].filter(Boolean).join('|');
    lines.push(`[${idTag(p, shortIds)}|${p.type}|${p.score.toFixed(2)}${tags ? '|' + tags : ''}] ${p.body}`);
  }

  if (directed.length > 0) {
    lines.push('');
    lines.push('--- DIRECTED ---');
    for (const e of directed) {
      lines.push(`${shortIds.get(e.from)} -[${e.type}:${e.weight.toFixed(1)}]-> ${shortIds.get(e.to)}`);
    }
  }
  if (undirected.length > 0) {
    lines.push('');
    lines.push('--- UNDIRECTED ---');
    for (const e of undirected) {
      lines.push(`${shortIds.get(e.nodes[0])} ~[${e.type}:${e.weight.toFixed(1)}]~ ${shortIds.get(e.nodes[1])}`);
    }
  }
  return lines.join('\n');
}

function idTag(p: Passage, shortIds: Map<string, string>): string {
  return p.nodeIds.map((id) => shortIds.get(id) ?? id).join('+');
}
