---
title: Correcting Memories
description: How to fix, update, or extend memories with the edit flow — deterministic by default, reviewed before anything is written.
sidebar:
  order: 3
---

Information changes. Something you ingested six months ago may now be outdated, or you want to add detail to an existing memory. Graphnosis has a structured **edit flow** that changes a memory precisely, without re-ingesting an entire source — and without ever quietly destroying what was there before.

## What an edit is

An edit is a natural-language statement of what should change. It covers three situations:

- **Correction** — "actually it was September, not August." Fixes a factual error.
- **Update** — "my plans changed — update my Q3 milestones to…" Replaces outdated content.
- **Append / add detail** — "add these items to my project plan." Extends an existing memory.

Graphnosis turns that statement into a **diff** — a precise, structured set of changes — and shows it to you. **Nothing is written until you approve the diff.** No AI model, local or cloud, can modify your cortex without your explicit confirmation.

An edit is one of the few **correctness events** that can change a memory's standing (see [Indelibility & Determinism](/guides/indelibility-and-determinism/)). It does this safely: the original memory is **superseded**, not erased.

## Deterministic by default

The correction flow works with **no AI model installed** — this is the default.

Given your correction, Graphnosis recalls the single closest-matching memory and proposes one change: **supersede** that memory with your correction text. If nothing matches, it proposes recording the correction as a new memory instead. This is fully deterministic — the same correction always produces the same diff.

## With a Local LLM (optional)

If you enable the optional [Local LLM](/guides/indelibility-and-determinism/#local-llm), the correction flow auto-switches to a more capable path: the model reads several candidate memories and can propose a **multi-part diff** — superseding one memory, editing another, adding a third — all in one reviewed step. This path is non-deterministic (the proposed diff can vary between runs), which is why it is opt-in and off by default.

Either way, the diff is only ever a **preview**. You review it before anything is committed.

## Corrections preserve the original

Applying a correction does **not** overwrite or delete the old memory. The default `supersede` operation keeps the original for audit lineage — it is demoted, not destroyed — and the op-log records the full before/after. You can trace the history at any time, and corrections are reversible. This is the indelibility guarantee in action: **a correction never loses information.**

## Initiating an edit from your AI

Your AI can start an edit mid-conversation using the `edit` and `apply` MCP tools. (`correct` also works as a backward-compatible alias.)

**Step 1 — the AI calls `edit`:**

```json
{
  "tool": "edit",
  "arguments": {
    "correction": "The API endpoint changed from /v1/search to /v2/query in March 2025.",
    "graphId": "work"
  }
}
```

`correction` is required; `graphId` is optional (when omitted, Graphnosis infers the engram from the closest-matching memory). The tool **writes nothing** — it returns a `diffId`, a `mode` (`"deterministic"` or `"llm-assisted"`), the proposed `preview` diff, and the candidate memories it considered.

**Step 2 — you approve the diff.** Normally you do this in the app (see below). An AI client should only call `apply` if you have explicitly reviewed the diff and told it to commit:

```json
{
  "tool": "apply",
  "arguments": {
    "graphId": "work",
    "diffId": "diff_m8x2k1"
  }
}
```

`apply` commits the change via the op-log and returns `Applied.`

:::caution
Never let an AI client call `apply` without your review. In Claude Desktop and Cursor you can require tool-call confirmation in the client settings.
:::

## Reviewing a correction in the app

When a correction is proposed, it appears as a pending diff in the **Check-in** tab — and Graphnosis fires a system notification if its window is in the background. There you see exactly what will change and decide:

- **Approve** — the diff is applied via the op-log.
- **Reject** — the proposed diff is discarded; nothing changes.

Graphnosis proposes; you decide. A correction is never applied on your behalf.

## What happens when a correction is applied

- The targeted memory is **superseded** — kept for lineage, demoted so it no longer surfaces in recall.
- The corrected content becomes a new, active memory with a fresh embedding.
- The op-log records a `correction` event referencing both the old and new content, so the change is fully auditable and reversible.

## Correction scope

The deterministic path corrects **one memory** — the closest match — per call. The LLM-assisted path can touch several memories in a single diff.

If an error spans many memories (for example, a wrong date repeated across a whole document), it is usually faster to update the source file and use **Reingest** from the Source detail view.

---

## Related

[Indelibility & Determinism](/guides/indelibility-and-determinism/) — why `edit` supersedes rather than overwrites.

[MCP Tools — `edit`](/reference/mcp-tools/#edit) — what an AI client actually calls.

[Deterministic Consolidation](/guides/deterministic-consolidation/) — the background passes that merge near-duplicates.

[Recovery](/guides/recovery/) — how to roll back if a correction went wrong.

