---
title: Autonomous Upkeep
description: How Graphnosis keeps your memory healthy on its own — merging duplicates, weaving connections, and flagging the rest for you.
sidebar:
  order: 4
---

A Cortex you never tend slowly fills with clutter: the same fact saved three times, near-identical notes from a re-ingested feed, memories left floating with nothing linked to them. Graphnosis doesn't just *store* your memories — it maintains them. A set of background passes runs on a schedule, **autonomously**, with no prompts and no buttons to press. What they can fix safely, they fix. What needs a judgment call, they hand to you.

The **Autonomous** tab — the third tab in the main window — is where you see all of this.

## The Autonomous tab

The Autonomous tab is a holistic view: it spans **every engram in your Cortex**, not just the one selected in the dropdown above. It shows:

- **Vitality** — a single 0–100 score for how alive and well-connected your memory is.
- **Self-healing** — how many duplicate memories Graphnosis has merged on its own.
- **Insights** — patterns, gaps, and opportunities surfaced from your knowledge (requires a local LLM).
- **Goals & Strategic Thinking** — strategic plans Graphnosis is tracking, with deadline awareness.
- **Recent activity** — a live feed of what the upkeep passes are doing, plus the schedule they run on.

A **Scan now** button forces a full pass on demand; otherwise everything runs on its own schedule.

## Vitality

Vitality is a 0–100 score blended from how much you've stored, how densely it's connected, how recently it's been active, and the average confidence of your memories — minus a small penalty for duplicate pairs still waiting on your review. It's a glanceable health number, not something you act on directly. It reads **0** until the first real score has been calculated.

## Self-healing — merging duplicates

The same fact often lands in your Cortex more than once: you re-ingest a file, a connector pulls an RSS item that was already there, an AI saves a note that paraphrases one you already had. Left alone, duplicates dilute recall — the AI sees the same thing three times and weighs it too heavily.

Graphnosis scans for near-duplicate memories in the background. When it finds two that are **provably the same**, it merges them **automatically** — no prompt:

- **Identical text** — the two memories say the same thing word for word, once web markup and spacing are normalized away.
- **Fully contained** — one memory's wording is entirely contained within a longer one. The longer memory already says everything the shorter one did, so the shorter one is redundant.

The bar is deliberately high: a merge happens **only when dropping one side provably loses no information**. Anything merely *likely* to be a duplicate is never merged automatically — see the next section.

A merge is a **soft-delete**: the redundant memory is set aside, not destroyed. Every merge is recorded in the op-log, so it can be traced and recovered — see [Recovery](/guides/recovery/). The Self-healing section of the Autonomous tab shows the running count of what's been merged.

If you set up a local LLM (see below), a second-opinion pass can re-examine past merges and, rarely, refine or reverse one — a stronger judgment than the conservative rules can make on their own.

## What it won't merge on its own — your review queue

Plenty of pairs look alike but aren't *provably* the same: one has a number the other doesn't, one adds a "not", they overlap only partially. Merging those could quietly lose or flip meaning, so Graphnosis **never** does it automatically.

Instead, those pairs surface in the **Check-in** tab under **"Needs your review"** — each one shows both memories side by side, and you make the call:

- **Same memory — merge** — collapses them into one. The lower-confidence side is soft-deleted (recoverable, like any merge).
- **Keep both** — they're genuinely distinct; the pair drops off the queue.

This is the division of labour: Graphnosis heals what's certain, you decide what's ambiguous.

## Weaving connections

Isolated memories — ones with nothing linked to them — are a weak spot: the AI can recall them, but it can't connect them to anything. Alongside duplicate detection, the same scan looks for memories that are **clearly related but genuinely distinct** (close in meaning, not the same fact) and weaves an automatic **"related"** connection between them.

This is deterministic and conservative: only strong matches are linked, and a memory that's already well-connected is left alone so the graph doesn't turn into noise. Typed, directional relationships — "depends on", "reports to", "builds on", and the like — can't be inferred safely by a rule, so Graphnosis leaves those for you to make in the Check-in deck.

Auto-woven edges are recorded in the op-log, tagged so you can tell them from connections you made yourself, and can be cut like any other edge.

## Other upkeep passes

- **Memory decay** — once a day, memories you haven't recalled in a long time lose a little confidence. Old, unused memory fades; memory you actually use stays sharp, because every recall reinforces it.
- **Goal tracking** — strategic plans you've saved are checked against recent memory, with deadline awareness.
- **Connection forming** and **Insights** — deeper, conceptual work that needs a local LLM; see below.

## When it runs

Graphnosis runs these passes on a schedule so they never compete with what you're doing:

| Pass | How often |
|---|---|
| Duplicate scan + connection weaving | every 20 minutes |
| Connection forming (conceptual) | every 45 minutes |
| Goal check | every 4 hours |
| Insights | every 6 hours |
| Memory decay | every 24 hours |

The first sweep waits about 60 seconds after you unlock — long enough for the app to finish loading without the scan competing for CPU. A duplicate scan also runs a short while after you ingest a file, so new content is checked promptly instead of waiting for the next scheduled pass. The **Scan now** button forces a full pass any time, and the current schedule is always shown at the bottom of the Autonomous tab.

## Standalone vs. a local LLM

Everything **deterministic** above works with **no AI model installed** — this is the default, **Standalone** mode:

- vitality, the duplicate scan and auto-merge, connection weaving, memory decay, and goal deadline tracking.

Adding a **local LLM** — via [Ollama](https://ollama.com), the same setup the [correction flow](/guides/correcting-memories/) uses — unlocks the passes that need real language judgment:

- **Insights** — patterns, gaps, and opportunities across your engrams.
- **Connection forming** — deeper conceptual links than the similarity-based auto-link can make.
- **Second-opinion review** of past merges.

A local LLM is optional and always runs on your own machine — nothing about upkeep ever sends your memory anywhere. The two shortcuts under **Get connected** in the sidebar — **Standalone** and **Local LLM** — explain each mode, and the Local LLM one takes you straight to setup.
