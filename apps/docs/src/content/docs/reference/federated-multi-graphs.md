---
title: Federated Multi-Graphs
description: How Graphnosis stores your memory as a dual graph inside each engram, and how the app federates many engrams into one searchable cortex without ever copying your data into a central index.
sidebar:
  order: 3
---

Most "AI memory" products store your stuff in one big bucket and search it with one trick. Graphnosis does neither.

This page is the short, consumer-friendly tour of the two ideas underneath: **the dual graph** inside each engram — provided by the open-source [`@nehloo/graphnosis`](https://www.npmjs.com/package/@nehloo/graphnosis) SDK (Apache-2.0, first released **April 12, 2026**) — and **federation** across many engrams, which the Graphnosis App layers on top. You don't need any of this to use Graphnosis — but it explains *why* recall feels different from a vector-database wrapper.

## One engram = two deterministic graphs over the same nodes

When Graphnosis ingests something — a file, a clip, a chat turn — it doesn't just store text. It splits the content into chunks, embeds each chunk locally with a small on-device model (BGE-small-en-v1.5, ~90 MB), extracts entities and concepts, and writes the result as **nodes** inside an engram (a `.gai` file).

Each node is one indexed memory trace: short text, a few entities, an embedding vector, and a confidence score.

Then comes the part that makes recall good rather than fuzzy. Every engram is a **dual graph** over the same set of nodes — two kinds of connection laid down side by side:

- **Undirected edges — associative.** "These two memories are about the same thing." Symmetric, no direction. Examples: `related-to`, `co-occurs`, `shares-topic`, `same-source`. This is the layer that catches *"I know I wrote something about this"* — even when you don't remember the exact words.
- **Directed, typed edges — causal and structural.** Each one carries a *direction* and a *meaning*. Examples: `causes`, `depends-on`, `contains`, `precedes`, `supersedes`, `elaborates`. This is the layer that lets recall follow *how* your memories relate, not just *that* they relate.

Both edge kinds live in the same encrypted `.gai` file, and both are computed deterministically — the same input always produces the same edges. A `recall` doesn't just match keywords; it walks the dual graph to bring back the smallest cluster that actually answers the question.

### Three ways recall finds things

Graphnosis blends three signals on every search — none of them on their own would be enough.

1. **Lexical (TF-IDF).** The classic "rare words win" trick. Common words like *the*, *project*, *meeting* count for little; distinctive words like *hippocampus*, *Postgres*, or your colleague's name count for a lot. Fast, deterministic, and excellent at proper nouns and technical terms. Diacritic-normalised, so *Stefan* and *Ștefan* match each other.
2. **Semantic (embeddings).** Your query is embedded into the same vector space as your notes, and the closest matches surface — even when you didn't use the same words. *"How do I roll back the deploy?"* finds a note titled *"Rollback procedure"*. The model runs entirely on your device; no API is called.
3. **Structural (the dual graph).** Once a few nodes match, Graphnosis walks the directed and undirected edges out from those seeds, pulling in the small handful of nodes that are clearly *adjacent* to what you asked. A `causes` edge from "the deploy failed" to "the migration ran out of memory" means a question about either one surfaces both.

All three are merged into a single ranked result. The lexical and semantic signals decide *what to seed*; the graph decides *what to include alongside*. Together they hit a sweet spot that pure vector search misses by default.

### Why a dual graph beats a flat vector store

A pure vector database tells you *"these chunks are similar to your query."* That's useful, but limited:

- **No direction.** It can't tell you *"this fact depends on that one"* — the causal chain is invisible.
- **No structure.** *"The deployment runbook contains step 4"* is a `contains` relationship; vector similarity has no idea.
- **No selectivity.** A vector store returns the top-K by cosine distance, even when those K are about three different things. The graph lets recall include the *cluster* that fits, and stop.

Graphnosis keeps the vector layer (it's the best tool for "semantically close"), and adds the dual graph on top. The result is recall that brings back a **subgraph** — a small connected cluster of nodes and the edges between them — rather than a flat list of bullets.

## Federation across many engrams

One engram is a graph. A cortex is many engrams — `work`, `personal`, `research`, `Skill Demos`, whatever you've created. Each engram lives in its own encrypted `.gai` file, with its own sensitivity tier, its own token budget, and its own owner-controlled lifecycle.

The naive thing to do would be: dump everything into one big graph at search time. Graphnosis does the opposite. **Engrams stay separate on disk; federation happens at recall time.**

### What federated recall actually does

Every `recall` call (and every `dig_deeper`, `recall_structured`, `recall_with_citations`) is **federated by default**:

- Runs the same query against every accessible engram in parallel.
- Each engram returns its own subgraph — its best match, drawn from its own dual graph, with its own audit footer.
- Results are merged into one ranked response, grouped per engram so you can see where each memory came from.
- Sensitivity tiers are honoured — sensitive engrams without consent are silently excluded from federated recall (the consent gate only fires when you explicitly name a sensitive engram).
- The total result is capped — token and node budgets keep the response small enough for any AI client.

This is why a question grounded in `work` can surface a relevant note from `research` without you having to ask twice.

### Cross-graph connections — the federation glue

There is one more federation move, and it's the one that makes the whole thing feel like a single brain instead of many filing cabinets.

When recall touches more than one engram, Graphnosis adds a `--- CROSS-GRAPH CONNECTIONS ---` block to the response — entity overlaps showing the same person, place, project, or concept appearing in two or more engrams, with a short preview from each:

```
--- CROSS-GRAPH CONNECTIONS ---
"GitHub Actions" → Work Notes: "deployment pipeline runs on GitHub Actions"
                 | Coding: "CI config lives in .github/workflows/deploy.yml"
```

These overlaps are pre-computed by a background pass and stored encrypted alongside your cortex. They are deterministic. They never copy your data into a central index — each engram remains its own self-contained encrypted file. Federation is a *runtime convention*, not a *storage layer*.

### `dig_deeper` — the federation escalation

When a plain `recall` returns thin results, `dig_deeper` runs a wider federated pass:

1. **Content recall** — the standard federated semantic + graph search.
2. **Source-filename expansion** — if your query mentions a document by name, pull more chunks from any source filename that matches, across every accessible engram.
3. **Cross-engram entity hop** — for entities in the query, pull in nodes from *other* engrams that share those entities.

The response shows which pass contributed which nodes, so you can see whether you got a direct match or a federation-assisted one. If most of the result came from indirect expansion, the response says so explicitly.

## What this means for you, in practice

You don't have to manage any of the above. But you'll notice three things:

- **Same query, same answer, every model.** Because the dual graph and the federation rules are deterministic, the same recall against the same cortex state returns the same memories — whether you're using Claude, Cursor, a local LLM, or Graphnosis on its own.
- **Cross-domain recall feels natural.** A question about a work decision can pull in the personal note that explains *why* you made it, without you having to copy-paste between engrams.
- **Your separation stays real.** Sensitive memory stays in a sensitive engram, behind a consent gate. Federation respects that — the gate is part of the federation rules, not bolted on after.

## What Graphnosis is *not* doing

A short list of things that would be easier but wrong, that Graphnosis deliberately doesn't do:

- **No central vector index.** Each engram is its own file. There is no "all your memory in one bucket" representation, anywhere on disk.
- **No cloud federation.** Federation happens locally on your device, at query time. No engram is sent anywhere to be searched.
- **No silent merging.** Cross-engram connections are surfaced as connections — never collapsed into a single fused node that hides where the memory came from.
- **No probabilistic re-ranking by default.** The lexical + semantic + graph blend is deterministic. The optional Neural Network and Local LLM overlays can widen the result, but they live in separate files (`.gnn` / `.gll`) and are always labelled when they contribute.

## Under the hood — the SDK boundary

Everything described above the **Federation** heading — the dual graph, the deterministic indexing, the directed/undirected edges, the on-device embeddings, the encrypted `.gai` files — is provided by [`@nehloo/graphnosis`](https://www.npmjs.com/package/@nehloo/graphnosis), the open-source SDK Graphnosis is built on. Apache-2.0 licensed, first published to npm on **April 12, 2026**, auditable end-to-end. If you want to build on Graphnosis directly without the desktop app, that is what you install.

Everything from the **Federation** heading down — multi-engram parallel recall, cross-graph entity overlaps, sensitivity-aware filtering, `dig_deeper` — is the Graphnosis App orchestrating many SDK instances on your device. The App is one consumer of the SDK; the SDK is the foundation.

---

## Related

[Overview](/getting-started/overview/) — how Graphnosis maps to the brain, end-to-end.

[MCP Tools — `recall` / `dig_deeper`](/reference/mcp-tools/#recall) — what an AI client actually calls.

[Skills as SOPs](/reference/skills/) — the procedural-memory layer that lives in its own engram.

[File Formats — `.gai`](/reference/file-formats/#gai--encrypted-graph-archive) — what an engram looks like on disk.

[Graphs & Sensitivity Tiers](/guides/graphs-and-tiers/) — how engram tiers interact with federation.

