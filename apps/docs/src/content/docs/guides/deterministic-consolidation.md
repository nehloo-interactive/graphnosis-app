---
title: Deterministic Consolidation
description: How Graphnosis keeps your memory permanent and strengthens it on its own — reinforcing connections, linking engrams, and consolidating, without ever weakening a memory.
sidebar:
  order: 4
---

A cortex you never tend slowly fills with clutter: the same fact saved three times, near-identical notes from a re-ingested feed, memories left floating with nothing linked to them. Graphnosis doesn't just *store* your memories — it keeps them **indelible**: permanent, well-connected, and ever more retrievable. A set of background passes runs on a schedule, **autonomously**, with no prompts and no buttons to press.

The guiding principle is **strengthen, never weaken**. A memory you add grows *more* confident, *more* connected, and *more* integrated over time — through use, through corroboration, and through consolidation. Nothing fades from disuse. The only things that ever lower a memory's standing are explicit correctness events — a contradiction is detected, the memory is superseded, or you correct it — and those are audited and reversible, never silent decay.

The **Deterministic Consolidation** tab — the third tab in the main window — is where you see all of this.

## The Deterministic Consolidation tab

It is a holistic view: it spans **every engram in your cortex**, not just the one selected in the dropdown above. It shows:

- **Memory health** — a retrieval-quality report: can you find what you need, is it trustworthy, is it well-integrated.
- **Self-healing** — how many duplicate memories Graphnosis has merged on its own.
- **Insights** — patterns, gaps, and opportunities surfaced from your knowledge (requires a local LLM).
- **Goals & Strategic Thinking** — strategic plans Graphnosis is tracking, with deadline awareness.
- **Recent activity** — a live feed of what the passes are doing, plus the schedule they run on.

A **Scan now** button forces a full pass on demand; otherwise everything runs on its own schedule.

## Memory health

Memory health rewards *retrieval quality*, not raw size. It blends:

- **Connectivity** — what fraction of your memories are reachable within their engram (no orphans).
- **Integration** — how interlinked the Cortex is beyond raw structure: cross-engram links and inferred connections.
- **Confidence** — the average confidence of your memories. Under strengthen-only this should trend *up*.
- **Coherence** — high when there are no unresolved contradictions.
- **Reinforcement** — how actively your memory is being used and strengthened.
- **Weight spread** — a guard against saturation: it warns if every connection has become equally strong, which would flatten retrieval ranking.

A quiet, sparse, perfectly-accurate engram is *healthy*. The headline number is 0–100; it reads **0** until the first real score is calculated.

## Connection reinforcement

Every time your AI recalls a set of memories together, Graphnosis notices. Memories that are **recalled together** have the connection between them **strengthened** — and if no connection existed yet, a repeatedly co-recalled pair earns a new one. This is the heart of Deterministic Consolidation: your memory adapts to how you actually use it, so the connections you lean on rank higher in future recalls.

Reinforcement is **strengthen-only and saturating**: a connection climbs toward — but never past — full strength, and strong connections plateau on their own. A connection that *isn't* used is simply left untouched; it is never weakened. New connections enter at a moderate baseline, so the cortex always keeps a meaningful spread of strengths.

## Self-healing — merging duplicates

The same fact often lands in your cortex more than once: you re-ingest a file, a connector pulls an RSS item that was already there, an AI saves a note that paraphrases one you already had. Left alone, duplicates dilute recall.

Graphnosis scans for near-duplicate memories in the background. When it finds two that are **provably the same**, it merges them **automatically** — no prompt:

- **Identical text** — the two memories say the same thing word for word, once web markup and spacing are normalized away.
- **Fully contained** — one memory's wording is entirely contained within a longer one, so the shorter one is redundant.

The bar is deliberately high: a merge happens **only when dropping one side provably loses no information**. A merge is a **soft-delete** — the redundant memory is set aside, not destroyed, recorded in the op-log, and recoverable (see [Recovery](/guides/recovery/)).

## What it won't merge on its own — your review queue

Plenty of pairs look alike but aren't *provably* the same: one has a number the other doesn't, one adds a "not", they overlap only partially. Merging those could quietly lose or flip meaning, so Graphnosis **never** does it automatically.

Instead they surface in the **Check-in** tab under **"Needs your review"**, side by side, and you make the call: **merge** them, or **keep both**. Graphnosis heals what's certain; you decide what's ambiguous.

## Weaving connections

Isolated memories — ones with nothing linked to them — are a weak spot. Alongside duplicate detection, the same scan looks for memories that are **clearly related but genuinely distinct** and weaves an automatic **"related"** connection between them. This is deterministic and conservative: only strong matches are linked, and an already well-connected memory is left alone so the graph doesn't turn into noise.

## Consolidation — the deep pass

Once a day, a deeper **consolidation** pass integrates and tidies the cortex. It is deterministic, and — like everything else here — it only ever *adds* or *tidies*, never weakens:

- **Transitive inference** — if A leads to B and B leads to C, Graphnosis infers the A→C connection. Each memory becomes *more* connected.
- **Community detection** — it reads how your memories cluster, feeding the Memory health metrics.
- **Redundancy cleanup** — it removes dead connections (edges left dangling to an already-deleted memory) and exact-duplicate parallel edges. It **never** removes a connection between two live memories.

## Cross-engram connections

Your engrams aren't islands. Graphnosis links memories **across** engrams when they share meaningful named entities or are highly similar in meaning — so a query about a topic in one engram can surface what you know about it in another. These cross-engram connections are reinforced by use, just like connections within an engram, and are stored encrypted alongside your cortex.

## Memory decay — and why it no longer touches your memories

Earlier versions slowly decayed the confidence of memories you hadn't recalled in a long time. Under Deterministic Consolidation, **that no longer happens to anything you've added**. A memory you deliberately saved — a file, a URL, a clip, a saved conversation — never loses confidence from disuse. The decay machinery remains only for a future *ambient capture* feature (unconfirmed, auto-captured content), which is the only thing that should ever be allowed to fade.

## When it runs

Graphnosis runs these passes on a schedule so they never compete with what you're doing:

| Pass | How often |
|---|---|
| Duplicate scan + connection weaving | every 20 minutes |
| Connection reinforcement | every 30 minutes |
| Connection forming (conceptual) | every 45 minutes |
| Goal check | every 4 hours |
| Cross-engram linking | every 6 hours |
| Insights | every 6 hours |
| Consolidation | every 24 hours |

The first sweep waits about 60 seconds after you unlock. A duplicate scan also runs a short while after you ingest a file. The **Scan now** button forces a full pass any time, and the current schedule is always shown at the bottom of the tab.

## Standalone vs. a local LLM

Everything **deterministic** above works with **no AI model installed** — this is the default, **Standalone** mode: Memory health, the duplicate scan and auto-merge, connection weaving, connection reinforcement, cross-engram linking, consolidation, and goal deadline tracking.

Adding a **local LLM** — via [Ollama](https://ollama.com), the same on-device model that also upgrades the [correction flow](/guides/correcting-memories/) — unlocks the passes that need real language judgment:

- **Insights** — patterns, gaps, and opportunities across your engrams.
- **Connection forming** — deeper conceptual links than the similarity-based passes can make.
- **Second-opinion review** of past merges.

A local LLM is optional and always runs on your own machine — nothing about upkeep ever sends your memory anywhere.
