---
title: Indelibility & Determinism
description: The two principles behind Graphnosis — memories that strengthen and never weaken, and a deterministic-first design where AI guessing is always opt-in and clearly labelled.
sidebar:
  order: 3
---

Two principles shape how Graphnosis treats your memory: **indelibility** (a memory you add only ever gets stronger) and **determinism** (the same input always produces the same result, with any AI guessing kept opt-in and clearly labelled). This page explains both, and the one tab where you can deliberately step outside them.

## Indelibility — your memory only ever gets stronger

The governing principle is **strengthen, never weaken**. Every memory you deliberately add — a file, a URL, a clip, a saved conversation — is **indelible**: permanent, and permanently retrievable. It does not fade. It does not decay from disuse. Over time it grows *more* confident, *more* connected, and *more* integrated — through use, through corroboration by new memories, and through the consolidation passes.

### Treated like memory — without the brain's decay

Graphnosis treats your AI's memory the way human memory works *in the ways that help*: knowledge is encoded as engrams, related memories are connected, the connections you actually use grow stronger, and recall surfaces what is relevant to the moment instead of dumping everything.

What it deliberately does **not** copy is the brain's *decay*. The human brain is the flawed baseline that artificial memory exists to surpass: it forgets, it is recency- and emotion-biased, it confabulates, and it lets memories fade when you have not used them lately — because biological neurons are metabolically expensive to maintain. None of those constraints apply to software. So Graphnosis is brain-*inspired*, not brain-*faithful*: it keeps the mechanisms that genuinely make retrieval better (reinforcing the connections you use, consolidating related knowledge) and rejects every one of the brain's failure modes (forgetting, disuse-decay, recency bias). A memory you add never weakens because time passed or because you did not revisit it. It only ever strengthens.

### What can — and cannot — lower a memory's standing

Nothing fades on its own. The **only** things that ever lower a memory's confidence are explicit *correctness* events:

- a **contradiction** is detected against another memory,
- a memory is **superseded** by a newer one, or
- **you correct it** (via the `correct` flow).

Every one of those is audited in the op-log and reversible. There is no silent decay.

:::note
Graphnosis does carry a temporal-decay pass — but it is **dormant by design**. It skips every memory unless that memory carries an explicit `ephemeral` marker, and nothing you add is ever marked ephemeral. The mechanism is reserved for a hypothetical future ambient auto-capture feature; today, nothing you save ever decays.
:::

### Permanence is absolute; prominence is earned

"Strengthen, never weaken" governs *storage and trust* — no correct memory is ever lost or quietly demoted. It does **not** mean every connection grows equally loud. Reinforcement is *selective and saturating*: a connection you use often strengthens, but the increment shrinks as it approaches the ceiling, so the graph keeps a meaningful spread. That spread is what lets recall surface the *right* memory at the right time, rather than all of them at once.

## The determinism spectrum

Graphnosis is **deterministic-first**. Deterministic means: the same input always produces the same result — no LLM in the loop, no randomness, fully auditable. Core recall is deterministic, so an identical query always returns identical memories.

Not every useful feature can be deterministic, so Graphnosis sorts its capabilities into four tiers and labels each one honestly:

| Tier | What it means | MCP tools |
|---|---|---|
| **Deterministic** | Identical input → identical output. No AI guessing. | `recall`, `remind`, `remember`, `apply`, `forget`, `stats`, `vitality` |
| **Conditional** | Deterministic by default; becomes non-deterministic when you enable the optional Neural Network or Local LLM. | `correct` |
| **Mixed** | Memory retrieval is deterministic and auditable; a local LLM then synthesises the prose, so wording varies. Degrades to a deterministic context dump with no LLM. | `develop`, `predict` |
| **Non-deterministic** | A local LLM is in the loop and results vary between runs. | `insights` |

`correct` is the conditional case worth understanding. With **neither** the Neural Network nor the Local LLM enabled, it deterministically supersedes the single closest-matching memory with your correction — reproducible, no guessing. The **Neural Network**, when on, expands the candidate set with GNN-predicted related memories and can re-rank which memory the correction targets. The **Local LLM**, when on, instead authors a multi-edit diff across several memories. The tool's response carries a `mode` field — `deterministic`, `gnn-expanded`, or `llm-assisted` — naming which path ran. Either way the diff is only a preview you approve before anything is written.

In the desktop app, the first three tabs — **Check-in**, **3D Engram**, and **Deterministic Consolidation** — are entirely deterministic. The fourth tab is where you opt into everything else.

## The "Go Non-Deterministic" tab

The **Go Non-Deterministic** tab is the one place you deliberately step outside the deterministic core. It holds two opt-in, **off-by-default** layers:

### Graphnosis Neural Network (GNN)

A small link-predictor that trains locally on your engrams and proposes connections it judges *likely real but not yet recorded*. Its predictions are kept in a **separate encrypted overlay file** (`neural-network.gnn`) — never written into the deterministic `.gai` graph. They surface only where they are clearly labelled: a "Neural-network predictions" block in recall enrichment, toggleable dashed edges in the 3D Engram, and the widened candidate set the `correct` tool considers when the GNN is on. Removing them is one click — the overlay is simply discarded, and the deterministic graph is untouched. See [File Formats](/reference/file-formats/) for the `.gnn` format.

### Local LLM

An optional on-device model (via Ollama). It produces `insights`, supplies the richer synthesis in `develop` / `predict`, and upgrades `correct` from its deterministic default to a multi-memory diff path. Everything runs locally — nothing is sent to the cloud. It is **off by default**: even when Graphnosis detects a model already running, it will not use it until you explicitly turn it on (with a confirmation). Detection is never consent.

Both layers are reversible and clearly marked. Neither ever touches **core recall** — an identical query returns identical memories whether or not they are on. What they *do* affect is opt-in and labelled: the GNN adds a separate predictions block to recall enrichment and widens the `correct` candidate set; the Local LLM authors the `correct` diff and the prose behind `develop`, `predict`, and `insights`. Even then nothing escapes review — `correct` always returns a diff you approve — and turning either layer off restores the fully deterministic behaviour.

## See also

- [Deterministic Consolidation](/guides/deterministic-consolidation/) — how the background passes strengthen and consolidate your memory.
- [Correcting Memories](/guides/correcting-memories/) — the audited, reversible way a memory's standing changes.
- [File Formats](/reference/file-formats/) — the `.gai` graph and the `.gnn` prediction overlay.
- [MCP Tools](/reference/mcp-tools/) — every tool, with its determinism tier.
