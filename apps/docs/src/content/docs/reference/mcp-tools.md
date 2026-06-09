---
title: MCP Tools
description: Full reference for the MCP tools exposed by the Graphnosis sidecar.
sidebar:
  order: 1
---

The Graphnosis sidecar exposes **47 tools** via the Model Context Protocol, organized into ten functional categories. Every connected MCP client — Claude Desktop, Claude Code, Cursor, and anything else that speaks MCP — sees the same 47. What a tool can actually reach is still governed by each engram's sensitivity tier and the [consent gate](/guides/ai-access-controls/#2-the-consent-gate) — by default a one-click in-app prompt for `sensitive`-tier recalls, silent for `personal` and `public`.

You can browse the full toolset inside the app too: open the **MCP Tools** button in the left sidebar (next to Settings). Each tool name opens a short explainer with example prompts you can paste straight into your AI client.

## At a glance — the 47 tools

| Category | Tools |
|---|---|
| **Core memory** (8) | [`recall`](#recall) · [`remind`](#remind) · [`dig_deeper`](#dig_deeper) · [`remember`](#remember) · [`forget`](#forget) · [`apply`](#apply) · [`stats`](#stats) · [`vitality`](#vitality) |
| **Engram discovery** (5) | [`list_engrams`](#list_engrams) · [`suggest_engram`](#suggest_engram) · [`browse_engram`](#browse_engram) · [`recent`](#recent) · [`get_engram_schema`](#get_engram_schema) |
| **Structured recall** (4) | [`recall_structured`](#recall_structured) · [`recall_with_citations`](#recall_with_citations) · [`compare_engrams`](#compare_engrams) · [`cross_search`](#cross_search) |
| **Source operations** (3) | [`find_source`](#find_source) · [`recall_source`](#recall_source) · [`transfer_source`](#transfer_source) |
| **Engram operations** (2) | [`ingest_batch`](#ingest_batch) · [`engram_summary`](#engram_summary) |
| **Brain maintenance** (4) | [`duplicate_pairs`](#duplicate_pairs) ★ · [`healing_journal`](#healing_journal) · [`gnn_status`](#gnn_status) ★ · [`confirm_data_access`](#confirm_data_access) |
| **Skills (SOPs)** (12) | [`walk_skill`](#walk_skill) · [`walk_skill_structured`](#walk_skill_structured) · [`get_skill`](#get_skill) · [`list_skills`](#list_skills) · [`delete_skill`](#delete_skill) · [`train_skill`](#train_skill) ★ · [`export_skill`](#export_skill) ★ · [`rollback_skill`](#rollback_skill) ★ · [`skill_history`](#skill_history) ★ · [`skill_vitality`](#skill_vitality) ★ · [`save_skill_run`](#save_skill_run) ★ · [`resume_skill_run`](#resume_skill_run) ★ |
| **Approximate** (2) | [`audit_memory`](#audit_memory) ★ · [`check_duplicate`](#check_duplicate) |
| **Conditional** (1) | [`edit`](#edit) |
| **Foresight** (6) | [`develop`](#develop) ★ · [`predict`](#predict) ★ · [`insights`](#insights) ★ · [`gnn_neighbors`](#gnn_neighbors) ★ · [`llm_query`](#llm_query) ★ · [`llm_distill`](#llm_distill) ★ |

★ = requires a [Graphnosis Pro subscription](https://graphnosis.com/upgrade). Returns a license error on the free plan.

## How results are returned

Every tool returns a standard MCP **text content block**. The `text` is one of two things, noted per tool below:

- **Plain text** — a ready-to-read string (`recall`, `remind`, `remember`, `apply`, `forget`, `develop`, `predict`, `llm_query`, `confirm_data_access`).
- **A JSON string** — structured data the client can parse (everything else).

There is no separate "return object" — the JSON examples below show what that `text` string contains once parsed.

## Determinism

Graphnosis sorts its tools into four determinism tiers. Each tool states its own tier in the description an AI client sees, so the client knows exactly what it is invoking:

| Tier | What it means | Tools |
|---|---|---|
| **Deterministic** | Identical input always produces an identical result — no LLM, no randomness, fully auditable. | All Core memory, Engram discovery, Structured recall, Source operations, Engram operations, and Brain maintenance tools (including `confirm_data_access`). |
| **Approximate** | Vector-similarity scan — given the same embedding state, results are reproducible. No LLM involved. | `audit_memory`, `check_duplicate` |
| **Conditional** | Deterministic by default — `edit` supersedes the single closest-matching memory, and `train_skill` builds the skill from recall alone. Enabling the optional Neural Network (which widens the candidate set) or the optional Local LLM (which authors a multi-edit diff for `edit`, or an LLM-rewritten body with attribution for `train_skill`) makes them non-deterministic. The result's `mode` field reports which path ran. | `edit`, `train_skill` |
| **Non-deterministic** | Needs the optional Local LLM (or Neural Network). Retrieval is exact and auditable; the synthesised output varies between runs. Degrades to raw context when the LLM is off. | `develop`, `predict`, `insights`, `gnn_neighbors`, `llm_query`, `llm_distill` |

One nuance for the deterministic tier: when the user has overlay engines enabled, `recall` and `remind` may append a clearly-labelled `--- INFERRED LAYER ---` block containing `[gll·assertion N%]` rows from the local LLM and `[gnn·edge N%]` rows from the neural network. The inferred layer is never mixed into the deterministic subgraph — treat it as predictions, not attested memory. The canonical `.gai` subgraph is always the authoritative answer.

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

Plain text — a structured context block grouped by engram, followed by an audit footer. The body uses the SDK's subgraph format:

```text
# Graphnosis context
The following memories from the user's personal knowledge graphs may be relevant.

## Work Notes
=== KNOWLEDGE SUBGRAPH (3 nodes, 2 edges) ===

--- SESSION SUMMARIES ---
[n0|summary|0.91|session:abc123|date:2026-05-20] Pipeline discussion with the team
  claims: deploys on push to main | GitHub Actions in use | rollback is manual

--- NODES ---
[n1|fact|0.95|src:work-notes|date:2026-05-20] The deployment pipeline runs on GitHub Actions, triggered on push to main.
[n2|fact|0.82|src:work-notes|date:2026-05-18] Rollback is a manual re-deploy of the previous tag — no automated rollback yet.
[n3|concept|0.74|date:2026-05-15] GitHub Actions runner is self-hosted on the team's EC2 instance.

--- DIRECTED ---
n1 -[depends-on:0.9]-> n3

--- UNDIRECTED ---
n1 ~[related-to:0.8]~ n2

--- CROSS-GRAPH CONNECTIONS ---
"GitHub Actions" → Work Notes: "deployment pipeline runs on GitHub Actions" | Coding: "CI config lives in .github/workflows/deploy.yml"

---
Attached 3 memory node(s) / 210 tokens across 1 graph(s). Per-graph (tier · nodes · tokens): work-notes · personal · 3n · 210t.
_anchored 1 node(s) on entities: GitHub Actions_
```

**Node format:** `[shortId|nodeType|score|tags] content`
- `nodeType`: `fact`, `concept`, `entity`, `event`, `definition`, `claim`, `data-point`, `person`, `document`, `section`, `summary`
- `score`: relevance, 0.00–1.00
- `tags` (optional): `src:{sourceLabel}` and/or `date:{YYYY-MM-DD}`

**Session summaries** (`--- SESSION SUMMARIES ---`): compressed prior-session context. Each entry has a `claims:` line listing atomic facts pipe-separated. Treat them as high-confidence context — they are attested memory distilled from earlier sessions.

**Edge formats:**
- Directed: `n1 -[edgeType:weight]-> n2` (causes, depends-on, precedes, supersedes, cites…)
- Undirected: `n1 ~[edgeType:weight]~ n2` (related-to, co-occurs, shares-topic…)

**Cross-graph connections** (`--- CROSS-GRAPH CONNECTIONS ---`): entity overlap when recall spans multiple engrams. Shows the same entity appearing in two or more engrams with a short preview from each — useful context for cross-domain questions.

**Audit footer footnotes** (may appear after the main `---` line):
- `_anchored N node(s) on entities: EntityName_` — entity anchoring ran; those nodes were pinned as high-confidence seeds.
- `_GNN expanded recall by N node(s) at ≥65% confidence_` — the neural network widened the candidate set; the extra nodes have a GNN basis, not pure vector similarity.
- `_enriched: "original query" → "rewritten query"_` — the local LLM rewrote the query at recall time (only when Recall enrichment is on).

**Inferred layer** (appended when overlay engines are on):
```text
--- INFERRED LAYER (overlays — NOT attested memory) ---
### Work Notes
  [gll·assertion 78%] The self-hosted runner may be a bottleneck for parallel jobs from [n3, n1]
  [gll·edge 65%] n1 —[elaborates]→ n2
  [gnn·edge 81%] n2 —→ n3
```
Treat `[gll·*]` and `[gnn·*]` rows as predictions, not facts. Never cite them as "you said X."

### Notes

- The server enforces hard caps (50 nodes / 8000 tokens) regardless of what is requested.
- Sensitive engrams: when shared, recall applies a tighter cap (5 nodes / 500 tokens); when not shared, excluded entirely.
- Every recall is auditable via the footer + a structured audit line on the sidecar's stderr.
- **Diacritic matching:** entity extraction normalises diacritic variants, so "Stefan" matches "Ștefan", "Ştefan", etc.
- **Escalation policy:** if `recall` returns 0–3 nodes, or nodes that don't answer the question, call [`dig_deeper`](#dig_deeper) with the same query before telling the user nothing was found.

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

## `dig_deeper`

**Determinism: deterministic.** The expansion pass runs the same searches every time given the same cortex state — no LLM, no randomness.

Escalation tool for when `recall` returns thin results (0–3 nodes, or nodes that don't actually answer the question). Internally orchestrates three passes: content recall, source-filename expansion, and a cross-engram entity hop. Returns more nodes than a plain `recall` with full provenance for each — which engram it came from, which source it lives in, and how it was reached.

**AI clients should always escalate to `dig_deeper` before telling the user "nothing was found."** Most empty-recall cases are phrasing or language mismatches that the expansion pass resolves.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | The same query you passed to `recall`. Pass it in the user's language — the expansion is multilingual. |
| `maxNodes` | integer | No | Maximum nodes to return across all passes. Default `30`, hard cap `80`. |
| `maxTokens` | integer | No | Token budget across all passes. Default `3000`, hard cap `10000`. |

### Return

Plain text — standard subgraph format for stage 1 (same shape as `recall`), then clearly labelled Markdown sections for stages 2 and 3, then italic provenance bullets:

```text
[Stage 1 — standard recall subgraph, same format as `recall`]

## DIG_DEEPER — Source-filename expansion
### Work Notes (additional chunks from matched source filenames)
- Chunk text from the matched source file

## DIG_DEEPER — Cross-engram entity hop
_Pulled via shared entities: GitHub Actions, EC2_
### Coding
- Node text reached via entity overlap from another engram
```

Followed by the provenance summary (rendered as italic Markdown, not a code block):

_• Content match (recall): 2 nodes, avg score 0.87_
_• Source-filename expansion: 3 nodes from 2 source(s): deploy.yml, pipeline-notes.md_
_• Cross-engram entity hop: 1 nodes via 1 shared entity across 2 engram(s)_

If indirect stages (2 + 3) contributed more than 60% of the returned nodes, a heads-up line is appended:

⚠️ _Heads-up for the user: the direct content match returned few nodes; most of this result came from indirect expansion (source-filename or cross-engram entity hop). The AI client should flag this to the user so they can confirm whether these expanded results are actually relevant._

This is actionable: if you see the ⚠️, tell the user the answer is based mostly on expanded/adjacent content, not a direct match — and invite them to rephrase if it looks off.

### Escalation policy

```
recall → thin result (0–3 nodes) → dig_deeper with same query → compose answer
                                 → still empty → tell user nothing was found
```

A `💡 The query entities also match source-file names…` hint in any recall or dig_deeper response means a whole document is relevant. Stop and call `recall_source` with the listed source IDs before composing your answer.

### Examples in practice

- **Everyday —** `recall` finds only one note about a project. `dig_deeper` with the same query hops to related nodes across three engrams and returns the full context the user was looking for.
- **Technical —** A query for a filename returns nothing from `recall`. `dig_deeper`'s filename-expansion pass finds the source directly and returns its contents.

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

If the new note contradicts existing memory, a warning is appended naming the contradictions, so the AI can offer `edit` or `forget` as a follow-up.

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

## `edit`

**Determinism: conditional.** Deterministic by default; non-deterministic when the optional Neural Network or Local LLM is enabled.

Propose a change to the user's memory. Covers three flavors — use whichever fits what the user said:

- **CORRECTION** — "actually it was September, not August." Fixes a factual error in an existing memory.
- **UPDATE** — "my plans changed — update my Q3 milestones to…" Replaces outdated content with the current state.
- **APPEND / ADD DETAIL** — "add these items to my project plan." Extends existing memory with new content.

Does **not** write anything — it returns a diff for review. Nothing is committed until the user approves the diff in the Graphnosis App (or, rarely, an AI client calls `apply` on the user's explicit instruction).

> **Backward-compatible alias:** the old name `correct` still works — existing AI clients don't need a session restart.

### The three paths

- **Deterministic** (`mode: deterministic` — no Neural Network, no Local LLM). Graphnosis recalls the single closest-matching memory and proposes one `supersede` edit — replacing it with the new content while preserving the original for audit lineage. When nothing matches, the change is proposed as a new memory instead. Identical input always yields an identical diff.
- **GNN-expanded** (`mode: gnn-expanded` — Neural Network enabled, no Local LLM). The candidate set is widened with GNN-predicted related memories; a strongly-predicted one can outrank the top recall hit. Still a single `supersede`, but the choice is GNN-influenced — and therefore non-deterministic.
- **LLM-assisted** (`mode: llm-assisted` — Local LLM enabled). The local LLM parses the change against every candidate memory and may propose a multi-part diff (any mix of `supersede` / `edit` / `delete` / `add`). Most capable, but the proposed diff can vary between runs.

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
  "tool": "edit",
  "arguments": {
    "correction": "The API endpoint changed from /v1/search to /v2/query in March 2025.",
    "graphId": "work"
  }
}
```

### Examples in practice

- **Correction —** Your AI mentions your anniversary is in June, but it's actually July. You say "that's wrong, our anniversary is in July" — `edit` proposes a diff superseding the old memory, and you review it in the app before anything changes.
- **Update —** You've moved from Node 18 to Node 22. You tell the AI to update it — `edit` proposes a `supersede` diff; the original is kept for audit lineage and nothing is written until you approve.
- **Append —** You say "add 'bring laptop charger' to my packing list" — `edit` finds the packing list memory and proposes appending the item, leaving the rest intact.

---

## `apply`

**Determinism: deterministic.** Writes an already-reviewed diff to the graph via the op-log; applying the same diff twice is idempotent.

Commit a diff that was proposed by `edit`.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `graphId` | string | Yes | The engram the diff targets. |
| `diffId` | string | Yes | The `diffId` returned by `edit`. |

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

**Determinism: deterministic.** Soft-deleting the same node always yields the same result — no LLM, no randomness, and the delete is recoverable from the op-log.

Surgically soft-delete **one or more specific memory nodes** from an engram. Only the listed nodes are removed — the rest of the source they came from is completely untouched.

:::caution[Node-level only — sources are user-only]
`forget` operates at the **node level**, not the source level. Removing an entire ingested file, URL, or clip is a **user-only action** done from the Sources page in the Graphnosis app. An AI client has no API to delete a whole source — by design.

This matters: if a source has 500 nodes and the user only wants one stale fact gone, `forget` removes just that node. The other 499 are untouched.
:::

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `graphId` | string | Yes | The engram **slug** (e.g. `personal`, `rss-ai`, `work`). Use `list_engrams` or `stats` to see valid slugs. |
| `nodeIds` | string or string[] | Yes | One nodeId or an array of up to 20 nodeIds. Node IDs come from `recall_structured` results — never guess or construct them. |

### How to get nodeIds — always use `recall_structured` first

```text
1. Call recall_structured(query="<what the user described>", graphId="<engram>")
2. Show the user the matching node(s) — confirm which ones to remove.
3. Call forget(graphId="<engram>", nodeIds=["<id1>", "<id2>", ...])
```

Never skip the `recall_structured` step. Never pass a `sourceId` — that field does not exist on this tool.

### Return

Plain text confirming how many nodes were soft-deleted:

```text
Forgot 1 node: node_abc123.
Forgot 3 nodes: node_abc123, node_def456, node_ghi789.
```

### Notes

- This is a **soft delete** — the user can recover deleted nodes via the app's Recover flow. Nothing is permanently destroyed.
- `forget` removes only the nodes you name. The source record and every other node from that source remain intact.
- Always confirm with the user which node(s) to remove before calling.
- To fix content rather than delete it, use `edit` instead.

### Example

```json
{
  "tool": "forget",
  "arguments": {
    "graphId": "work",
    "nodeIds": ["node_abc123"]
  }
}
```

### Examples in practice

- **Everyday —** You saved a to-do that's no longer relevant. You tell your AI "remove that note about the UX polish cleanup" — the AI calls `recall_structured` to find the exact node, shows you the text to confirm, then calls `forget` with just that nodeId. Your other notes from the same session are untouched.
- **Surgical cleanup —** An ingested document has one outdated fact that keeps surfacing in recall. Rather than re-ingesting the whole document, the AI finds the specific node with `recall_structured` and removes it with `forget`. The rest of the document's 40+ nodes stay in place.

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

## `develop` *(Pro)*

**Requires Graphnosis Pro.** Returns a license error on the free plan. [Upgrade →](https://graphnosis.com/upgrade)

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

## `predict` *(Pro)*

**Requires Graphnosis Pro.** Returns a license error on the free plan. [Upgrade →](https://graphnosis.com/upgrade)

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

## `insights` *(Pro)*

**Requires Graphnosis Pro.** Returns a license error on the free plan. [Upgrade →](https://graphnosis.com/upgrade)

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

### Notes

- The vitality score **persists across sessions** — it is stored alongside your cortex and does not drop to zero just because you unlocked the app. The score reflects the last computed state and updates after each consolidation pass.

### Examples in practice

- **Everyday —** You ask "how healthy is my memory overall?" — `vitality` returns a 0–100 score, and a 74 on your personal engram nudges you to tidy up loosely connected notes.
- **Technical —** Tracking memory quality over time, you ask the AI for the current vitality — `vitality` reports the per-engram breakdown, and a dip flags a build-up of unresolved duplicate pairs dragging down the coherence component.

---

## Engram discovery

These five tools let an AI client navigate your cortex without needing to guess engram names. All deterministic — metadata reads only.

### `list_engrams`

Lists every engram in your cortex — names, sensitivity tiers, source counts, archive state. Use before routing a `remember` if you don't already know what exists.

- **Returns:** JSON array of engram objects.
- **Try saying:** *"What engrams do I have?"* · *"Show me all my memory collections."*

### `suggest_engram`

Recommends the best engram to save a note into, based on token similarity between the note text and existing engram names. A pre-check before `remember` so the AI can avoid the routing banner when there's an obvious fit.

- **Parameters:** `text` (required) · `top_k` (optional, default 3, max 5).
- **Returns:** JSON-ranked short-list with match scores.
- **Try saying:** *"Where should I save this note about marathon training?"*

### `browse_engram`

Lists every source ingested into a specific engram — file paths, clip refs, timestamps, IDs — newest first. The right lookup before `transfer_source` when you need the exact sourceId. To forget specific memory nodes, use `recall_structured` → `forget` instead.

- **Parameters:** `engram` (required, slug or display name; fuzzy-matched) · `limit` (optional, default 20).
- **Try saying:** *"What's inside my Reading List engram?"*

### `recent`

The most recently ingested sources across all engrams, or scoped to one. Answers "what did I just save?" and verifies an ingest succeeded.

- **Parameters:** `engram` (optional) · `limit` (optional, default 10, max 50).
- **Try saying:** *"What did I just save?"*

### `get_engram_schema`

Returns the metadata for one engram — display name, sensitivity tier, template, creation date. Used to confirm a tier before routing sensitive notes.

- **Parameters:** `engram` (required, slug or display name).
- **Try saying:** *"What sensitivity tier is my Personal engram on?"*

---

## Structured recall

Four variants on `recall` for when the AI needs more than the standard prose context block.

### `recall_structured`

Like `recall`, but results come back as a JSON array of node objects (`nodeId`, `graphId`, `tier`, `score`, `text`, `sourceId`) for programmatic processing — sorting by score, computing statistics, choosing which sourceIds to forward to a follow-up tool.

- **Parameters:** `query` (required) · `maxTokens` (default 2000) · `maxNodes` per graph (default 20) · `only_engrams` / `except_engrams` (optional scope filters).
- **Try saying:** *"Recall my Q4 roadmap notes as JSON so I can sort them by score."*

### `recall_with_citations`

Like `recall`, but each fact in the prose carries an inline citation linking it to its source — useful when you need to present provenance per statement.

Citation format: `[{kind}:{numericId}·{label}]` — e.g. `[clip:1779225683078·work-notes]` or `[ai-conversation:1779093613903·session-summary]`. Kind is one of `clip`, `ai-conversation`, `file`, or `url`.

- **Parameters:** same as `recall_structured`.
- **Try saying:** *"Tell me about the API redesign and cite the source for each fact."*

### `compare_engrams`

Runs the same query against two engrams and returns the results side-by-side under separate headings — useful for contrasting work vs. personal, 2025 vs. 2026 plans, etc.

- **Parameters:** `query` · `engram_a` · `engram_b` · `maxNodes` (default 10).
- **Try saying:** *"Compare what I know about Python in Work vs. Personal."*

### `cross_search`

Federated recall over a hand-picked subset of engrams (not all), with results grouped and labelled per engram. Use when the user names multiple collections in a query.

- **Parameters:** `query` · `engrams` (array, at least one) · `maxNodes` (default 20 total).
- **Try saying:** *"Search my Book Notes and Work engrams for distributed systems."*

---

## Source operations

The op-log primitives — find, fetch, and move whole sources between engrams. All deterministic, all recoverable.

### `find_source`

Find sources by a keyword substring match against sourceId, ref (label/path/URL), or kind — across all engrams or scoped to one. Returns each match with its exact engram slug, sourceId, kind, and timestamp.

- **Parameters:** `keyword` (required) · `engram` (optional, narrows the search to one engram) · `limit` (default 10).
- **Try saying:** *"Where did I save that PDF about Raft?"*

:::tip[Call this before `transfer_source`]
Always call `find_source` before `transfer_source`. Use the returned `graphId` (engram slug) and `sourceId` verbatim — never construct or guess either value.

To **forget** specific memories, use `recall_structured` (not `find_source`) — it returns `nodeId` values, which is what `forget` accepts.
:::

### `recall_source`

Returns the FULL content of a single saved source — every chunk, in ingestion order, with no similarity cutoff. Use when `recall` keeps returning partial results for a structured document (a plan, a numbered list, a meeting note) and you need the complete text.

- **Parameters:** `sourceId` (required, exact — use `find_source` first if unsure) · `engram` (optional, speeds up large cortexes).
- **Try saying:** *"Pull up the complete text of my Q4 planning doc."*

### `transfer_source`

Moves a single source (and every memory derived from it) from one engram to another via the op-log. Recoverable per-source.

- **Parameters:** `sourceId` · `from_engram` · `to_engram`.
- **Try saying:** *"Move that file from Inbox to Work."*

---

## Engram operations

:::note[Merging engrams is a user-only action]
Merging an entire engram into another is done from **Settings → Engrams** in the Graphnosis app — AI clients cannot trigger this operation. This keeps a broad, hard-to-reverse action under explicit user control.
:::

### `ingest_batch`

Saves multiple notes in a single call — up to 20 items per batch, each with its own `target_engram`. For bulk-importing a list of facts without one `remember` per item.

- **Parameters:** `items` (array, max 20).
- **Returns:** JSON per-item success/error summary.
- **Try saying:** *"Save these 5 facts about the project in one go: …"*

### `engram_summary`

A readable snapshot of an engram — node count, source count, and a sample of node-content previews. For orienting yourself before querying a new engram.

- **Parameters:** `engram` (required).
- **Try saying:** *"What's in my Reading List engram?"*

---

## Brain maintenance

Read-only windows into the autonomous brain engine that runs in the background while the app is open.

### `duplicate_pairs` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Near-duplicate node pairs the brain engine has already flagged for review — high-confidence matches from the background scan, not ad-hoc searches. Resolve with `edit` (merge) or `forget(nodeIds=[nodeId])` (remove one side). Requires the brain engine to be running.

- **Try saying:** *"What does my brain think is duplicated?"*

### `healing_journal`

Audit log of autonomous corrections the brain engine applied in the background — merges, confidence adjustments, edge repairs. *"What has my brain fixed on its own?"*

- **Try saying:** *"Show me autonomous corrections from the last week."*

### `gnn_status` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Reports whether the Graphnosis Neural Network is enabled, how many predicted edges it has computed, and when it last ran. Use before `gnn_neighbors` to confirm the GNN has data.

- **Try saying:** *"Is the neural network running?"*

### `confirm_data_access`

System-driven, **headless-fallback only**. The primary consent flow in v0.10+ is the **in-app one-click prompt** that pops automatically in the Graphnosis app when a gated recall fires — the AI client never calls this tool in normal desktop use.

This tool exists for environments without a GUI (sidecar running over SSH, in a Docker container, in CI) where the user can't see the modal. In those cases the consent gate returns the legacy `"⚠️ GRAPHNOSIS CONSENT REQUIRED"` message instructing the user to read the current phrase from **Settings → AI → Consent Phrases** in the app and have the AI invoke `confirm_data_access({ phrase, tier })`. Validates the phrase locally and stores a consent record for the (client, tier) pair. AI clients never invent or guess the phrase. See [AI Access Controls](/guides/ai-access-controls/) for the full protocol.

- **Parameters:** `phrase` (the exact phrase the user typed) · `tier` (`personal` or `sensitive`).

---

## Skills (SOPs)

Skills are the procedural memory layer of Graphnosis — Standard Operating Procedures wired into the cortex as graphs of steps, with goals, loops, branches, supporting context, and cross-skill orchestration. All twelve tools below operate on the **Skills engram** that ships with every cortex.

The procedural model in one paragraph: each skill is a sequence of body steps stored in source order; five evidence-tagged edge types connect them — `skill:seq` for the linear chain, `skill:loop` for "go back to step N", `skill:branch` for conditional forks, `skill:ctx` for recalled memories anchored to a specific step, and `skill:calls` for `@skill: target(args) -> $capture` cross-skill invocations. Eight goal categories live inside each skill (Success, Out of scope, On completion, Trigger, Prerequisites, On failure, Requires, Produces). See [Skills as SOPs](/reference/skills/) for the full model.

All twelve Skills tools are deterministic reads/writes against the same engram. **Five tools are free** — `walk_skill`, `walk_skill_structured`, `get_skill`, `list_skills`, `delete_skill` — so imported `.gsk` packs are fully usable without a Pro license. **Seven tools require Pro** (`train_skill`, `export_skill`, `rollback_skill`, `skill_history`, `skill_vitality`, `save_skill_run`, `resume_skill_run`) — they return a license error on the free plan. `train_skill` additionally has a Pro LLM path: by default it uses memory-augmented training (deterministic); with Pro + Local LLM, the body is LLM-rewritten while keeping `_(from source)_` attribution markers.

### `walk_skill`

**Determinism: deterministic.** Returns the same narrative every time given the same skill state.

Walks a skill step-by-step as a Standard Operating Procedure. Returns human-readable narrative text with `CONSTRAINTS:` (the 8 goal categories) and `PROCEDURE:` (the ordered steps) sections. Loop-back, conditional-branch, and sub-skill invocation annotations are inlined. Use when explaining the skill to a user or guiding them through it conversationally.

- **Parameters:** `sourceId` (required) · `recursive` (optional boolean — inline called sub-skills under each calling step).
- **Returns:** Plain text. The narrative includes ⟲ for loops, ⤳ for branches, and ⊕ for sub-skill calls.
- **Try saying:** *"Walk me through the Production deployment skill."*

### `walk_skill_structured`

**Determinism: deterministic.** Same walk, machine-readable shape.

Returns a `SkillExecutionPlan` JSON object: `requires` and `produces` variable lists, `constraints` (the goal categories), ordered `steps` with `calls` metadata (target sub-skill, args, captureAs), and `failureHandlers`. Use when the AI will actually execute the skill — walk steps in order, invoke sub-skills with the named args, capture their return values, and route to failure handlers on exception. Prefer this over `walk_skill` for any procedural-execution task.

- **Parameters:** same as `walk_skill`.
- **Returns:** JSON string matching `SkillExecutionPlan`.
- **Try saying:** *"Get the execution plan for the Safe Deploy skill so you can run it."*

### `get_skill`

Fetches the trained output of a single skill by id — the final markdown the user sees in the editor, including all body steps and goal blocks.

- **Parameters:** `sourceId` (required).
- **Returns:** Plain text (the rendered skill).
- **Try saying:** *"Show me the Code review skill."*

### `list_skills`

Lists every skill in the Skills engram with metadata: source id, name, last-trained timestamp, vitality, snapshot count.

- **Parameters:** none.
- **Returns:** JSON array.
- **Try saying:** *"What skills do I have?"*

### `train_skill` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

**Determinism: conditional.** Deterministic memory-augmented body by default; LLM-rewritten body with the Pro license + Local LLM.

Trains or retrains a skill — anchors fresh recall to body steps, wires the five SOP edge types, and writes a snapshot to history. In-place: one source per skill (no duplicate sources per retraining run). The Pro path additionally rewrites the body through the local LLM with `_(from source)_` attribution preserved.

- **Parameters:** `sourceId` (required for retrain) · `name` / `goals` / `base` (required for new) · `mode` (optional — `"deterministic"` or `"llm"`; auto-selected from your license).
- **Returns:** JSON `{ sourceId, mode, snapshotId, edges: { seq, loop, branch, ctx, calls } }`.
- **Try saying:** *"Retrain the Code review skill against my latest notes."*

### `export_skill` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Exports a signed `.gsk` pack for sharing or backup. `.gsk` is the Graphnosis Skill Kit wire format: AES-256-GCM encrypted JSON body with an Ed25519 signature over the manifest. See [File formats](/reference/file-formats/#gsk--graphnosis-skill-kit).

- **Parameters:** `sourceId` (required) · `outputPath` (optional, defaults to the app's exports dir).
- **Returns:** Plain text — the absolute path of the written `.gsk` file.
- **Try saying:** *"Export the Production deployment skill as a .gsk pack."*

### `delete_skill`

Removes a skill and its trained output from the Skills engram via the op-log. Soft delete — recoverable from Recovery.

- **Parameters:** `sourceId` (required).
- **Returns:** Plain text confirming the delete.
- **Try saying:** *"Delete the draft skill I was experimenting with."*

### `skill_history` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Snapshot history of a skill — every training run, with timestamp, mode (deterministic vs LLM), and a diff summary against the previous snapshot.

- **Parameters:** `sourceId` (required) · `limit` (optional, default 20).
- **Returns:** JSON array of snapshot objects.
- **Try saying:** *"Show me the training history of the Code review skill."*

### `rollback_skill` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Reverts a skill to a prior snapshot. Writes a new snapshot of the rollback itself so the lineage is preserved — nothing is destroyed.

- **Parameters:** `sourceId` (required) · `snapshotId` (required — from `skill_history`).
- **Returns:** Plain text confirming the rollback + the new snapshot id.
- **Try saying:** *"Roll the Production deployment skill back to yesterday's version."*

### `skill_vitality` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

0–100 health score for one skill — blends staleness (time since last retrain), anchor coverage (how many body steps have supporting context), goal completeness (how many of the 8 categories are filled), and loop/branch resolution rate.

- **Parameters:** `sourceId` (required).
- **Returns:** JSON `{ overall, components: { staleness, anchorCoverage, goalCompleteness, structureResolution }, lastTrainedAt }`.
- **Try saying:** *"How healthy is my Code review skill?"*

### `save_skill_run` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Persists a multi-skill orchestration's captured variables (`@skill: x -> $var`) and progress to an encrypted per-run file, so a run can be paused and resumed in a later session. Call it as you walk the steps.

- **Parameters:** `capturedVars` (object) · `completedStepIndex` (number) · `skillRef` (the skill being run) · `runId` (optional — omit to start a new run, pass it back to update an existing one).
- **Returns:** The `runId` (newly minted, or the one you passed).
- **Try saying:** *"Save my progress on the Safe Deploy run so I can pick it up tomorrow."*

### `resume_skill_run` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Reloads a saved run by `runId`: its captured variables, last completed step, and the `nextStepIndex` to continue at. Pair with `walk_skill_structured` to keep going.

- **Parameters:** `runId` (required).
- **Returns:** JSON `{ capturedVars, completedStepIndex, nextStepIndex, skillRef, createdAt, updatedAt }`.
- **Try saying:** *"Resume the Safe Deploy run I started yesterday."*

---

## Approximate

Vector-similarity scans across the cortex — deterministic given the embedding state, no LLM involved.

### `audit_memory` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Detects near-duplicate content across engrams by sampling top nodes from each engram and cross-searching them in all others above a similarity threshold. Approximate — samples rather than exhaustively comparing every pair. Useful before a merge or for periodic memory hygiene.

- **Try saying:** *"Do I have duplicate notes anywhere?"*

### `check_duplicate`

Before `remember`, checks whether very similar content already exists in one engram or all of them. Returns matches above the threshold so the user can choose `remember` (new fact) or `edit` (update existing). Helps prevent duplicate-node pollution.

- **Parameters:** `text` · `engram` (optional).
- **Try saying:** *"Before I save this note about Postgres tuning, is there anything similar already?"*

---

## Foresight — Local LLM + GNN tools

**Requires Graphnosis Pro.** These tools return a license error on the free plan. [Upgrade →](https://graphnosis.com/upgrade)

The Foresight tools require the optional [Local LLM](/getting-started/connect-ai/) (Ollama) or Neural Network. All computation stays on device — nothing leaves the machine. Each degrades gracefully when the LLM is off (raw context dump with a note explaining how to enable synthesis).

### `gnn_neighbors` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Returns nodes the Neural Network predicts are related to a query — structural connections that lexical/embedding recall didn't surface. Each result includes the GNN edge-probability score.

- **Parameters:** `query` · `top_k` (default 10).
- **Try saying:** *"What else might be related to my notes on graph databases?"*

### `llm_query` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Recalls relevant memory then uses the local LLM to synthesise a direct answer from that recalled context — entirely locally. Use when the user wants an AI-synthesised answer grounded in their own memory, not just raw recalled nodes.

- **Parameters:** `query` · `maxNodes` (optional).
- **Try saying:** *"Use the local model to answer: what's the current state of my migration plan?"*

### `llm_distill` *(Pro)*

**Requires Graphnosis Pro.** [Upgrade →](https://graphnosis.com/upgrade)

Pass arbitrary text to the local LLM and ask it to extract discrete, self-contained facts worth remembering. Returns a JSON array of `{text, label}` objects ready to pass to `ingest_batch` or `remember`.

- **Parameters:** `text` · `target_engram` (optional).
- **Try saying:** *"Extract the key facts from this meeting transcript for saving: …"*

---

## Skills (SOPs)

Skills are Standard Operating Procedures the user has authored or imported. Each skill is a sequence of paragraph nodes wired together by directed edges (sequence, loops, branches, sub-skill calls, goals, context). Skill packs distribute as `.gsk` files (signed by Graphnosis for official packs, unsigned for community packs).

**7 tools require Pro** — `train_skill`, `export_skill`, `rollback_skill`, `skill_history`, `skill_vitality`, `save_skill_run`, `resume_skill_run`. Read-only tools (`walk_skill`, `walk_skill_structured`, `get_skill`, `list_skills`, `delete_skill`) are free so imported `.gsk` packs work without a subscription.

### `list_skills`

Enumerates every trained skill stored in the user's Skills engram(s). Returns sourceId, label, engram name, training mode, recallBreadth, and active node count per skill. Use before `get_skill` / `walk_skill` / `skill_history` / `rollback_skill` / `delete_skill` to discover the sourceIds.

- **Parameters:** `engram` (optional engram slug to scope the listing).
- **Try saying:** *"What skills do I have?"* or *"List the skills in my coding engram."*

### `get_skill`

Retrieves the full text and metadata of one trained skill. Returns the raw skill text (metadata header + body + recipes + goals), training mode, recallBreadth, and node count. Use for "show me what's in this skill" — for execution-oriented walks, prefer `walk_skill` / `walk_skill_structured`.

- **Parameters:** `graphId` · `sourceId`.
- **Try saying:** *"Show me the contents of my Code Review skill."*

### `walk_skill`

Walks a skill as a Standard Operating Procedure and returns **human-readable narrative text** with `CONSTRAINTS:` and `PROCEDURE:` sections. Annotates each step with loop-back, conditional-branch, sub-skill invocation, and supporting-context callouts. Use for explaining a skill to the user or guiding them through it conversationally.

- **Parameters:** `graphId` · `sourceId` · `recursive` (optional, default false — when true, inline sub-skill steps).
- **Returns:** plain text formatted like:
  ```
  CONSTRAINTS:
    ✓ Success: …
    🔑 Prerequisites: …
    ⚠ On failure: …

  PROCEDURE (5 steps):
    Step 1: …
    Step 2: …
      → Context: recalled memory anchored here
    Step 3: …
      → INVOKES SKILL: validate-environment with $branch, capture result as $envOk
    Step 4: … (BRANCHES to step 6 on condition)
    Step 5: … (LOOPS BACK to step 2)

  FAILURE HANDLERS:
    → On failure: invoke rollback skill
       RECOVERY SKILL: rollback-deployment with $branch
  ```
- **Try saying:** *"Walk me through the Production deployment skill step by step."*

### `walk_skill_structured`

Same as `walk_skill` but returns a **machine-readable `SkillExecutionPlan` JSON** for programmatic execution. Each step entry may include `calls` (target sub-skill + args + captureAs), `unresolvedCall`, `branchesTo`, `loopsBackTo`, `supportingContext`. The top-level object includes `requires[]`, `produces[]`, `constraints`, `steps[]`, `failureHandlers[]`, `unanchoredContext[]`. **Prefer this over `walk_skill` for any procedural execution task** — walking steps in order, invoking sub-skills with named args, capturing return values under named variables, routing to failure handlers on exception.

- **Parameters:** `graphId` · `sourceId` · `recursive` (optional).
- **Returns:** JSON shape:
  ```json
  {
    "skill": { "sourceId": "...", "title": "Production deployment", "engramName": "skills" },
    "requires": ["branch"],
    "produces": ["envOk", "migrationReport", "smokeReport"],
    "constraints": {
      "success": "...",
      "prerequisites": "CI on the branch is green, $branch is set",
      "trigger": "user asks to deploy a branch to production"
    },
    "steps": [
      { "index": 1, "text": "...", "calls": { "targetSourceId": "...", "targetTitle": "validate-environment", "args": ["branch"], "captureAs": "envOk" }, "supportingContext": [] }
    ],
    "failureHandlers": [
      { "description": "invoke @skill: rollback-deployment with the failure context", "targetSourceId": "...", "targetTitle": "rollback-deployment", "args": ["branch"] }
    ],
    "unanchoredContext": []
  }
  ```
- **Try saying:** *"Execute the Production deployment skill — get the structured plan first so you can invoke each sub-skill correctly."*

### `train_skill`  *(Pro)*

Personalizes a skill instruction against the user's memory. Phase 1: deterministic recall. Phase 2: surgical placement of recalled memories at the right sequential position in the skill (Jaccard + triplet-coherence scoring; LLM-rewrite path opt-in via `useLlmRewrite`). Phase 3: save as a new versioned node set, wire all SOP edges (sequence / goals / loops / branches / context / sub-skill calls). Re-train any time to refresh against newly-added memories.

- **Parameters:** `skill` (the skill text) · `graphId` (target Skills engram) · `skillName` (optional) · `focusGraphIds` (optional — restrict recall to specific engrams) · `modelTarget` (optional, e.g. `'claude'` / `'cursor'`) · `save` (default true) · `recallBreadth` (0–100, default auto) · `goals` (structured 8-field SkillGoals) · `useLlmRewrite` (optional, default false).
- **Try saying:** *"Train this CLAUDE.md skill against my Coding engram: …"*

### `skill_vitality`

0–100 freshness score for a saved skill. Drops as the skill's nodes are superseded by retrains and as time passes (~5pts/month, capped at 25). Useful for "which of my skills need retraining?"

- **Parameters:** `graphId` · `sourceId`.
- **Returns:** `{score, trainedAt, staleNodesCount, recommendation}`.
- **Try saying:** *"How fresh is my Code Review skill?"*

### `skill_history`

Full version history of one skill — all trained versions grouped by skill name, newest first. Each entry includes sourceId, label, ingestedAt, nodeCount, and whether it's the current (most recent) version. Use to find the sourceId for `rollback_skill`.

- **Parameters:** `graphId` · `sourceId` (any version of the skill — full history for that skill name is returned).
- **Try saying:** *"Show the version history of my Production deployment skill."*

### `rollback_skill`

Rolls a skill back to a specific previous version by forgetting all versions trained after the target. The target becomes current; newer versions are soft-deleted (recoverable from the Sources page in the app). Non-reversible without manual node recovery. Use `skill_history` first to find the `targetSourceId`.

- **Parameters:** `graphId` · `targetSourceId`.
- **Try saying:** *"Roll back my Production deployment skill to the version from last Tuesday."*

### `delete_skill`

Permanently forgets one skill source (or all versions of a skill when `allVersions=true`). All trained nodes for the chosen sources are soft-deleted via the standard `forgetSource` path; the soft-delete is recoverable from the Sources page in the app until purged.

- **Parameters:** `graphId` · `sourceId` · `allVersions` (optional, default false — when true, forgets every version sharing the same base name).
- **Try saying:** *"Delete my old Sales Outreach skill, all versions."*

### `export_skill`

Exports a trained skill into a target AI tool's format. Six formats supported:

| Format | Output |
|---|---|
| `claude-md` | Block to paste into `CLAUDE.md` |
| `cursorrules` | Entry for `.cursorrules` |
| `system-prompt` | Generic system prompt (paste into any AI tool) |
| `openai` | OpenAI API system message JSON |
| `raw` | Clean skill text with no wrapper |
| `gsk` | **(Pro)** Graphnosis Skills Kit pack — `.gsk` encrypted JSON, base64-encoded in the response |

- **Parameters:** `skill_text` (the trained skill text from `train_skill` output or `recall_source`) · `format`.
- **Try saying:** *"Export my Code Review skill as a CLAUDE.md block."*

---

## Related

[Skills as SOPs](/reference/skills/) — the procedural model behind the twelve Skills tools.

[Federated Multi-Graphs](/reference/federated-multi-graphs/) — what `recall` and `dig_deeper` actually walk.

[A GRAPHNOSIS.md for Your AI](/getting-started/graphnosis-md/) — drop-in instructions so the AI uses these tools without prompting.

[AI Access Controls](/guides/ai-access-controls/) — the consent gate every recall passes through.

[File Formats](/reference/file-formats/) — `.gai`, `.gnn`, `.gll`, and `.gsk`.

