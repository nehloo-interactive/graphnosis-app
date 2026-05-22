---
title: MCP Tools
description: Full reference for the MCP tools exposed by the Graphnosis sidecar.
sidebar:
  order: 1
---

The Graphnosis sidecar exposes **eleven tools** via the Model Context Protocol. Every connected MCP client — Claude Desktop, Claude Code, Cursor, and anything else that speaks MCP — sees the same eleven. What a tool can actually reach is still governed by each engram's sensitivity tier and its "share with AI" setting.

## How results are returned

Every tool returns a standard MCP **text content block**. The `text` is one of two things, noted per tool below:

- **Plain text** — a ready-to-read string (`recall`, `remind`, `remember`, `apply`, `forget`, `develop`, `predict`).
- **A JSON string** — structured data the client can parse (`correct`, `stats`, `insights`, `vitality`).

There is no separate "return object" — the JSON examples below show what that `text` string contains once parsed.

## Determinism

Graphnosis sorts its tools into four determinism tiers. Each tool states its own tier in the description an AI client sees, so the client knows exactly what it is invoking:

| Tier | Tools | What it means |
|---|---|---|
| **Deterministic** | `recall`, `remind`, `remember`, `apply`, `forget`, `stats`, `vitality` | Identical input always produces an identical result — no LLM, no randomness, fully auditable. |
| **Conditional** | `correct` | Deterministic by default — supersedes the single closest-matching memory. Enabling the optional Neural Network (which widens the candidate set) or the optional Local LLM (which authors a multi-edit diff) makes it non-deterministic. The result's `mode` field reports which path ran. |
| **Mixed** | `develop`, `predict` | Memory retrieval is deterministic and auditable, but a local LLM then synthesises the prose, so wording varies run to run. With no local LLM running, both degrade to a deterministic raw-context dump. |
| **Non-deterministic** | `insights` | A background local-LLM loop produces these; the tool only retrieves what was already computed — it never triggers a scan itself. |

One nuance for the deterministic tier: if the user has enabled the optional [Graphnosis Neural Network](/guides/indelibility-and-determinism/), `recall` and `remind` may append a separate, clearly-labelled "Neural-network predictions" block. That appendix is the only non-deterministic part, and it is never mixed into the deterministic results.

---

## `recall`

**Determinism: deterministic.** An identical query always returns identical memories — no LLM, no randomness, fully auditable.

Primary memory retrieval. Searches the user's encrypted knowledge graph and returns a ready-to-use context block of the most relevant memories.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural-language query or topic. Pass it in the user's language — the search is multilingual (BGE embeddings + multilingual entity extraction). |
| `maxTokens` | integer | No | Token budget for the attached context. Default `2000`. Range `100`–`8000`. |
| `maxNodes` | integer | No | Maximum number of memory nodes to attach. Default `20`. Range `1`–`50`. |

### Return

Plain text — a Markdown context block of the recalled memories grouped by engram, followed by an audit footer summarising what was served per engram:

```text
# Graphnosis context
The following memories from the user's personal graphs may be relevant.

## Graph: work
- The deployment pipeline runs on GitHub Actions, triggered on push to main.

---
Attached 1 memory node(s) / 24 tokens across 1 graph(s). Per-graph (tier · nodes · tokens): work · personal · 1n · 24t.
```

### Notes

- The server enforces hard caps (50 nodes / 8000 tokens) regardless of what is requested.
- Sensitive engrams are governed by their per-engram "share with AI" setting. When an engram is sensitive **and** shared, recall still includes it but applies a tighter cap (5 nodes / 500 tokens). When it is not shared, it is excluded entirely.
- Every recall is auditable: the footer above, plus a structured audit line on the sidecar's stderr that the desktop inspector tails.
- If the user has enabled the Graphnosis Neural Network, a separate "Neural-network predictions" block may be appended — clearly labelled and never mixed into the deterministic results.

### Example

```json
{
  "tool": "recall",
  "arguments": {
    "query": "database migration strategy",
    "maxNodes": 5,
    "maxTokens": 1500
  }
}
```

### Examples in practice

- **Everyday —** Last month you told your AI which paint colour you picked for the spare room. Today you ask "what was that paint colour again?" — it calls `recall`, finds the note, and gives you the exact name without you digging through old chats.
- **Technical —** Mid-refactor you ask "why did we drop the Redis cache layer?" — `recall` surfaces the decision note from a past session, so the AI reasons from the actual rationale instead of guessing.

---

## `remind`

**Determinism: deterministic.** An alias for `recall`, framed around the "remind me about X" intent — the same multilingual search, the same hard caps, the same plain-text context block. Use it when the user explicitly asks to be *reminded* of something (in any language: "remind me about…", "amintește-mi de…", "recuérdame…").

### Parameters

Identical to `recall`: `query` (required), `maxTokens` (optional, default `2000`), `maxNodes` (optional, default `20`).

`recall` and `remind` call the same underlying search and return the same shape — choosing one over the other is just a soft signal of intent to the user.

### Examples in practice

- **Everyday —** You say "remind me what gift ideas I had for Mum's birthday" — the phrasing signals intent, so the AI calls `remind`, which runs the same search as `recall` and pulls back the list you jotted down weeks ago.
- **Technical —** Before a release you ask "remind me of the open caveats on the auth migration" — `remind` returns the caveats you logged during the migration work, so nothing slips through the checklist.

---

## `remember`

**Determinism: deterministic.** Saving the same note produces the same memory — no LLM, no randomness, and every write is auditable.

Store a new memory directly from a conversation so it persists across sessions.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | The content to store. |
| `target_engram` | string | No | **Preferred.** A human-friendly engram name (e.g. `"Book Notes"`). Resolved against existing engrams via exact-then-fuzzy matching; non-matches trigger a user-confirmation banner in the app (see below). |
| `graphId` | string | No | An exact engram slug (e.g. `book-notes`). Skips name resolution. An unknown slug routes through the same banner flow as `target_engram` rather than dead-ending. |
| `label` | string | No | Short label shown alongside the source in the Sources list. Defaults to a sensible placeholder. |
| `kind` | string | No | `"clip"` (default) — a discrete fact, note, or extracted text. `"ai-conversation"` — a turn or summary of the current AI ↔ user conversation. The Sources list shows these distinctly. |

### Return

Plain text confirming the write:

```text
Saved to book-notes as clip:3c6e206d6aa7744913361348.
```

If the new note contradicts existing memory, a warning is appended naming the contradictions, so the AI can offer `correct` or `forget` as a follow-up.

### Notes

- Text is chunked, embedded, and encrypted before storage — the same pipeline as file ingest.
- **AI clients should prefer `target_engram` over `graphId`.** It is name-tolerant ("Book Notes" / "book-notes" / "booknotes" all resolve to the same engram), and when the name does not exactly exist Graphnosis surfaces a user-confirmation banner instead of silently writing to the default engram.
- Without `target_engram` or `graphId`, the note goes to the user's default engram — a fallback, not a recommendation.

### The `target_engram` resolution flow

When `target_engram` (or an unknown `graphId`) is set, the sidecar runs a three-way resolver:

| Resolver result | What happens |
|---|---|
| **Exact match** (normalized graphId or displayName) | Writes immediately. |
| **Close matches** (≥1 candidate above similarity threshold) | The tool returns an actionable error to the AI listing the closest matches by name. The app shows a banner top-center with ranked candidates (each labelled with the match reason — `contains your text`, `same words`, `close spelling`) plus a "Create new" option. The user picks one or creates a new engram. |
| **No match** | The tool returns an error listing all existing engrams. The banner offers "Create new" only. |

**The AI never auto-creates an engram or silently disambiguates** — every new engram is a human-confirmed decision. The error returned to the AI is structured so a well-instructed client can relay the situation to the user without retrying the call.

### Example

```json
{
  "tool": "remember",
  "arguments": {
    "text": "Decided to use PostgreSQL for the new service. SQLite was ruled out due to concurrent write requirements.",
    "target_engram": "Work decisions",
    "label": "DB choice",
    "kind": "clip"
  }
}
```

### Examples in practice

- **Everyday —** You tell your AI "save this — our plumber is Dan, 0712 345 678, and he wants 24 hours' notice" — it calls `remember` with a `target_engram` like "Home contacts", so the detail is there next time the sink leaks.
- **Technical —** After a long debugging session you say "note that the flaky CI test is a timezone bug, not a race condition" — `remember` stores it in your engineering engram, and the finding survives past the current session instead of being lost.

---

## `correct`

**Determinism: conditional.** Deterministic by default; non-deterministic when the optional Neural Network or Local LLM is enabled.

Propose a natural-language correction to the user's memory. Does **not** write anything — it returns a diff for review. Nothing is committed until the user approves the diff in the Graphnosis App (or, rarely, an AI client calls `apply` on the user's explicit instruction).

### The three paths

- **Deterministic** (`mode: deterministic` — no Neural Network, no Local LLM). Graphnosis recalls the single closest-matching memory and proposes one `supersede` edit — replacing it with the correction text while preserving the original for audit lineage. When nothing matches, the correction is proposed as a new memory instead. Identical input always yields an identical diff.
- **GNN-expanded** (`mode: gnn-expanded` — Neural Network enabled, no Local LLM). The candidate set is widened with GNN-predicted related memories; a strongly-predicted one can outrank the top recall hit and become the memory that is superseded. Still a single `supersede`, but the choice is GNN-influenced — and therefore non-deterministic.
- **LLM-assisted** (`mode: llm-assisted` — Local LLM enabled). The local LLM parses the correction against every candidate memory (including any GNN-surfaced ones) and may propose a multi-part diff (any mix of `supersede` / `edit` / `delete` / `add`). Most capable, but the proposed diff can vary between runs.

The path is chosen by what the user has enabled for the active cortex — the AI client does not pick. The result's `mode` field reports which one ran.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `correction` | string | Yes | A natural-language description of what is wrong and what it should be. Pass it in the user's language. |
| `graphId` | string | No | Restrict the correction to a specific engram. When omitted, the engram is inferred from the closest-matching memory. |

### Return

A JSON string. `mode` is `"deterministic"`, `"gnn-expanded"`, or `"llm-assisted"`; `preview` is the proposed diff; `candidates` are the memories considered — recall hits plus, when the Neural Network is on, GNN-surfaced ones (each flagged with `viaGnn`):

```json
{
  "diffId": "diff_m8x2k1",
  "mode": "deterministic",
  "preview": {
    "reasoning": "Deterministic correction (no Local LLM): superseding the closest-matching memory…",
    "edits": [
      {
        "kind": "supersede",
        "nodeId": "yBVlkQ-7DyfTucEFq2MQ0",
        "content": "Actually, we went to Greece in September 2020, not August.",
        "reason": "User correction (deterministic supersede)."
      }
    ],
    "adds": []
  },
  "candidates": [
    { "graphId": "personal", "nodeId": "yBVlkQ-7DyfTucEFq2MQ0", "text": "We went to Greece in August 2020…", "viaGnn": false }
  ]
}
```

### Notes

- `supersede` is preferred over `edit`: it keeps the original memory for audit lineage, consistent with Graphnosis' indelibility guarantee — a correction never destroys the prior memory, it demotes it.
- The diff stays pending in memory until the user approves or rejects it in the app. Always present the diff to the user before calling `apply`.
- Never call `remember` to "fix" something — that creates a duplicate, conflicting node the user has to clean up.

### Example

```json
{
  "tool": "correct",
  "arguments": {
    "correction": "The API endpoint changed from /v1/search to /v2/query in March 2025.",
    "graphId": "work"
  }
}
```

### Examples in practice

- **Everyday —** Your AI mentions your anniversary is in June, but it's actually July. You say "that's wrong, our anniversary is in July" — `correct` proposes a diff superseding the old memory, and you review it in the app before anything changes.
- **Technical —** You realise a stored note says the service runs on Node 18 when you've since moved to Node 22. You tell the AI to fix it — `correct` returns a reviewed `supersede` diff; the original is kept for audit lineage and nothing is written until you approve.

---

## `apply`

**Determinism: deterministic.** Writes an already-reviewed diff to the graph via the op-log; applying the same diff twice is idempotent.

Commit a correction diff that was proposed by `correct`.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `graphId` | string | Yes | The engram the diff targets. |
| `diffId` | string | Yes | The `diffId` returned by `correct`. |

### Return

Plain text:

```text
Applied.
```

### Notes

- **AI clients should almost never call this.** It is normally invoked by the Graphnosis App after the user clicks Approve. Only call it when the user has explicitly reviewed a specific diff and asked you to commit it.
- Each operation in the diff is written as an op-log event, so the change is fully auditable and reversible.
- Fails if the `diffId` is unknown — there is no "apply the last one" shortcut by design.

### Example

```json
{
  "tool": "apply",
  "arguments": {
    "graphId": "work",
    "diffId": "diff_m8x2k1"
  }
}
```

### Examples in practice

- **Everyday —** You usually just click Approve on the correction banner in the app, which commits the diff for you — the AI never touches `apply`. The one exception is when you explicitly say "yes, go ahead and apply that correction", and only then does the client call it.
- **Technical —** You're working in a terminal-only setup without the app window in front of you. After reviewing a specific diff's `diffId`, you instruct the AI to commit it — `apply` writes the reviewed diff to the op-log as an auditable, reversible change.

---

## `forget`

**Determinism: deterministic.** Removing the same source always yields the same result — no LLM, no randomness, and the soft-delete is recoverable from the op-log.

Remove a **source** from an engram. Every node derived from that source is soft-deleted and dropped from future recall results.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `graphId` | string | Yes | The engram the source lives in. |
| `sourceId` | string | Yes | The source to remove. Use `stats` with `includeNodes` to enumerate sources if you do not have the id. |

### Return

Plain text reporting how many nodes were soft-deleted:

```text
Forgot 7 nodes from source clip:abc123.
```

### Notes

- This is a **soft delete** — the op-log records a `forget` event and the user can restore the source via the app's Recover flow. Nothing is permanently destroyed.
- `forget` removes the *whole* source. To remove a single memory inside a multi-fact source, use `correct` with a delete operation instead.
- Confirm with the user before calling unless they have explicitly named the source.

### Example

```json
{
  "tool": "forget",
  "arguments": {
    "graphId": "work",
    "sourceId": "clip:abc123"
  }
}
```

### Examples in practice

- **Everyday —** You ingested an old rental lease that no longer applies. You tell your AI "drop the lease document from my files" — `forget` soft-deletes every node from that source so it stops surfacing in recall, and you can still restore it via Recover if needed.
- **Technical —** A stale API spec you imported keeps polluting answers with outdated endpoints. You ask the AI to remove that whole document — `forget` clears the entire source at once, rather than correcting each fact one by one.

---

## `stats`

**Determinism: deterministic.** A direct read of ground-truth graph state — identical calls return identical data, no LLM, no randomness.

Inspect the ground-truth state of every engram in the active cortex — node counts and source counts per engram. Useful when the user asks "show me my graph" or to debug why `recall` returned nothing.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `includeNodes` | boolean | No | If true, include up to 20 node-content previews per engram. Default `false`. |

### Return

A JSON string:

```json
{
  "graphs": [
    {
      "graphId": "work",
      "totalNodes": 1840,
      "activeNodes": 1823,
      "softDeletedNodes": 17,
      "sources": 48
    }
  ]
}
```

With `includeNodes: true`, each engram object also carries a `nodes` array of up to 20 previews.

### Example

```json
{
  "tool": "stats",
  "arguments": { "includeNodes": true }
}
```

### Examples in practice

- **Everyday —** You ask "how much have I actually saved into my memory so far?" — `stats` reads the ground-truth graph state and reports node and source counts per engram, so you see exactly what's stored.
- **Technical —** A `recall` came back empty and you can't tell why. You ask the AI to check the graph — `stats` with `includeNodes` shows which engrams hold which sources, revealing the notes landed in a different engram than expected.

---

## `develop`

**Determinism: mixed.** Recall is deterministic and auditable; a local LLM then synthesises the plan, so the wording varies between runs. With no local LLM running it degrades to a deterministic raw-context dump.

Strategic planning grounded in the user's own knowledge graph. Graphnosis recalls the relevant memory, then synthesises a plan — Situation → Approach → Key Actions → Risks & Gaps → Next Step. All computation is local.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `context` | string | Yes | The domain or situation to plan for (e.g. "my book project"). |
| `strategy` | string | Yes | The approach to use (e.g. "lean MVP", "bottom-up growth"). |
| `goals` | string | Yes | What success looks like (e.g. "publish a draft in 3 months"). |
| `graphIds` | string[] | No | Restrict recall to specific engrams. Defaults to all accessible engrams. |
| `saveAsGoal` | boolean | No | If true, the plan is also saved as a goal node for periodic check-ins. |

### Return

Plain text — a Markdown strategic plan, followed by a line naming how many memory nodes it referenced and across which engrams.

When the Local LLM is not enabled, `develop` instead returns the raw recalled memory, prefixed with a clear note that the model is off — so the AI can work from the context directly and tell the user how to enable a synthesized plan.

### Examples in practice

- **Everyday —** You say "help me plan the garden makeover this spring, on a tight budget, finished by May" — `develop` recalls your past notes on the yard and synthesises a Situation → Approach → Key Actions → Risks & Gaps → Next Step plan grounded in what you've already recorded.
- **Technical —** You ask the AI to plan migrating a monolith to services using a strangler-fig approach, aiming to ship the first extracted service in a quarter — `develop` grounds the plan in your logged architecture decisions rather than generic advice.

---

## `predict`

**Determinism: mixed.** Recall is deterministic and auditable; a local LLM then synthesises the risk/opportunity assessment, so the wording varies between runs. With no local LLM running it degrades to the raw recalled context.

Proactive risk and opportunity assessment *before* the user takes an action. Graphnosis recalls memory related to the action and uses the local LLM to surface past failures, constraints, blockers, and overlooked opportunities. All computation is local.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | The action or decision the user is about to take. |
| `graphIds` | string[] | No | Restrict recall to specific engrams. Defaults to all accessible engrams. |

### Return

Plain text — a Markdown assessment with **Risks**, **Opportunities**, and a **Recommendation**, followed by a line naming how many memory nodes it was grounded in.

When the Local LLM is not enabled, `predict` instead returns the raw recalled memory, prefixed with a clear note that the model is off — so the AI can assess it directly and tell the user how to enable a structured prediction.

### Examples in practice

- **Everyday —** Before booking a contractor you ask "anything I should watch out for here?" — `predict` recalls your past notes on home projects and surfaces Risks, Opportunities, and a Recommendation, like a reminder that the last contractor ran weeks over schedule.
- **Technical —** About to enable a feature flag for all users, you ask the AI to assess it first — `predict` pulls memory tied to that rollout and flags past failures and constraints, such as a load issue that bit you the last time you skipped a staged rollout.

---

## `insights`

**Determinism: non-deterministic.** Insights are produced by a background local-LLM loop; this tool only retrieves what was already computed — it does not trigger a new scan.

Returns the current pending insights — non-obvious patterns, gaps, opportunities, and conflicts the background analysis surfaced across all engrams. The loop runs roughly every six hours while a local LLM is available.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dismissed` | boolean | No | If true, include already-dismissed insights. Default `false` (active only). |

### Return

A JSON string — an array of insight objects, each with `kind` (`pattern` / `gap` / `opportunity` / `conflict`), `title`, `body`, and relevant node ids.

When the Local LLM is not enabled, `insights` instead returns a plain-text message explaining that insights come from a background local-LLM loop and there is nothing to retrieve until the model is turned on. With the LLM on, the array is simply empty until the loop has had a chance to run.

### Examples in practice

- **Everyday —** You ask "noticed anything interesting across my notes lately?" — `insights` returns what the background loop already worked out, such as a pattern that your best writing sessions all happen before noon.
- **Technical —** You ask the AI "any conflicts or gaps in my project memory?" — `insights` hands back the pre-computed findings, like two notes that disagree on the production database version, without kicking off a fresh scan.

---

## `vitality`

**Determinism: deterministic.** The vitality score is a fixed formula over current graph state — identical state yields an identical score, with no LLM and no randomness.

Returns the vitality score — a 0–100 measure of how alive and well-connected the engrams are. The score blends four ratios: connectivity (40%), average confidence (25%), recent activity (20%), and coherence — fewer unresolved duplicate pairs (15%).

### Parameters

None.

### Return

A JSON string:

```json
{
  "overall": 82,
  "byGraph": { "work": 88, "personal": 74 },
  "computedAt": 1716290000000
}
```

### Examples in practice

- **Everyday —** You ask "how healthy is my memory overall?" — `vitality` returns a 0–100 score, and a 74 on your personal engram nudges you to tidy up loosely connected notes.
- **Technical —** Tracking memory quality over time, you ask the AI for the current vitality — `vitality` reports the per-engram breakdown, and a dip flags a build-up of unresolved duplicate pairs dragging down the coherence component.
