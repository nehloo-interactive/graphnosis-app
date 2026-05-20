---
title: Graphs & Sensitivity Tiers
description: Organize your memory into graphs, and control what your AI can see with sensitivity tiers.
sidebar:
  order: 2
---

Graphs let you organize your Cortex into distinct namespaces. Sensitivity tiers let you decide how much of each graph an AI is allowed to see — including the option to block AI access entirely.

**Important:** even for graphs with open tiers, your AI never receives everything in that graph. On every `recall` call, Graphnosis performs a semantic search and returns only the nodes most relevant to your current question, subject to the token cap for that graph. The rest stays encrypted and untouched. This is intentional — Graphnosis acts as your hippocampus, retrieving targeted memory traces, not dumping your files.

## Multiple graphs

A single Cortex can hold multiple graphs. You might create:

- `work` — project notes, meeting summaries, technical decisions
- `personal` — journal entries, health notes, finance snippets
- `research` — papers, articles, reference material

Each graph is independent: its own sensitivity tier, its own token budget, its own sources. When the AI calls `recall`, it searches across all graphs you've granted it access to, respecting each graph's tier.

### Creating a graph

Open the Graphnosis window → click **+ New Graph** → give it a name and choose a sensitivity tier.

## Sensitivity tiers

Every graph is assigned one of three tiers:

<table>
<thead><tr><th>Tier</th><th>What it means</th></tr></thead>
<tbody>
<tr><td style="white-space:nowrap"><code>public</code></td><td>Content may be surfaced to any AI client without restriction.</td></tr>
<tr><td style="white-space:nowrap"><code>personal</code></td><td>Content is surfaced only when the AI explicitly asks for context (no proactive injection). Token cap applies.</td></tr>
<tr><td style="white-space:nowrap"><code>sensitive</code></td><td>Content is never surfaced to AI clients automatically. Requires manual export or explicit user action.</td></tr>
</tbody>
</table>

Tiers are a hard cap, enforced by the sidecar before any content leaves the Cortex. The AI model itself never sees the tier configuration — it simply doesn't receive content above its allowed level.

### Tier behavior in practice

**`public` graphs** — chunks flow freely into AI context. Proactive injection is enabled. Best for reference material, documentation, public notes.

**`personal` graphs** — chunks are only returned when `recall` is called explicitly. Proactive injection is disabled. The token cap limits how much context can be returned per conversation turn. Best for personal notes, journal entries, work summaries.

**`sensitive` graphs** — the sidecar returns zero results for `recall` queries targeting this graph. The AI is never told why — it just gets no results. You can still search and review these memories in the Graphnosis UI. Best for health information, financial records, anything you want to keep entirely local.

## Per-graph token caps

Each graph has a configurable maximum token budget per recall response. This prevents any single graph from consuming the entire context window of your AI.

Defaults:

| Tier | Default token cap |
|------|-----------------|
| `public` | 4000 tokens |
| `personal` | 2000 tokens |
| `sensitive` | 0 (AI access blocked) |

You can override these in `policy.json`.

## Configuring policy.json

`policy.json` lives in the root of your Cortex folder. It is not encrypted (it contains only policy rules, not content). You can edit it directly:

```json
{
  "graphs": {
    "work": {
      "tier": "personal",
      "maxTokensPerRecall": 3000
    },
    "research": {
      "tier": "public",
      "maxTokensPerRecall": 6000
    },
    "health": {
      "tier": "sensitive"
    }
  },
  "globalMaxTokensPerTurn": 8000
}
```

Changes to `policy.json` take effect immediately — no restart required. The sidecar watches the file for changes.

### `globalMaxTokensPerTurn`

This is a hard ceiling across all graphs combined. Even if individual graph caps add up to more, the sidecar will truncate the total context to this limit. Default: `8000`.

## Moving sources between engrams

Sources aren't permanently bound to the engram they were ingested into. You can reassign a source at any time from the Sources pane — hover the row, click **Move to…**, and pick the destination.

If you need a new engram as the destination, select **New Engram…** from the dropdown, type a name, and Graphnosis will create it and move the source in one step.

Moving a source is instant and non-destructive. All chunks, embeddings, and cached content travel with it. The AI clients reflect the new location on the next `recall` call — no restart or re-ingest needed. The moved source is governed by the destination engram's sensitivity tier immediately after the move.

Typical reasons to move a source:

- You ingested a work document into `personal` by accident — move it to `work`
- A research paper turned out to be closely related to a specific project — move it into that project's engram for tighter recall
- You're splitting a large general-purpose engram into topic-specific ones over time

## Which graphs does a client see?

By default, all graphs in the Cortex are visible to any connected MCP client, subject to their tier. If you want to expose only specific graphs to a specific AI client, you can scope the sidecar using the `GRAPHNOSIS_GRAPHS` environment variable (see [Environment Variables](/reference/environment-variables/)).
