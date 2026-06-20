---
name: graphnosis
description: Use Graphnosis local encrypted memory with Hermes — recall-first habits, remember proactively, consent protocol.
---

# Graphnosis memory for Hermes

Graphnosis is your user's local encrypted memory. With Hermes + Graphnosis configured, you get:

- **Memory provider** — auto-prefetch each turn; tools `graphnosis_recall`, `graphnosis_remember`, `graphnosis_stats`
- **MCP catalog** — full surface as `mcp_graphnosis_*` (`edit`, `forget`, `cross_search`, skills, consent)

## Non-negotiable habits

1. **Recall first, answer second** — for personal/history questions, call `graphnosis_recall` or rely on prefetched context before answering.
2. **Remember proactively** — save durable decisions, todos, and facts with `graphnosis_remember` or `mcp_graphnosis_remember`.

## Tool choice in Hermes

| Intent | Tool |
|--------|------|
| Search memory | `graphnosis_recall` or `mcp_graphnosis_recall` |
| Save new fact | `graphnosis_remember` or `mcp_graphnosis_remember` |
| Fix/update existing | `mcp_graphnosis_edit` (never a second remember) |
| Cross-engram search | `mcp_graphnosis_cross_search` |
| List engrams | `graphnosis_stats` or `mcp_graphnosis_stats` |

Prefetch may already inject context — still call recall when the question depends on history and prefetch looks thin.

## Query hygiene

- Strip framing ("remind me about…" → content words only)
- Match storage language; retry in another language if zero results
- 3–8 dense content words; keep proper nouns verbatim

## Consent

If a tool returns `⚠️ GRAPHNOSIS CONSENT REQUIRED`, show it verbatim, tell the user to open Graphnosis → Settings → AI → Consent Phrases, wait for the phrase, then call `mcp_graphnosis_confirm_data_access`.

## Prerequisites

Graphnosis app running, cortex unlocked, socket at `~/.graphnosis/mcp.sock`.
