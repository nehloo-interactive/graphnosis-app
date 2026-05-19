---
title: MCP Tools
description: Full reference for the 6 MCP tools exposed by the Graphnosis sidecar.
sidebar:
  order: 1
---

The Graphnosis sidecar exposes six tools via the Model Context Protocol. All tools are available to any connected MCP client. Tool availability is subject to the sensitivity tier of the targeted graph.

---

## `recall`

Semantic search over the Cortex. Returns the most relevant chunks for a given query.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Natural-language query or topic to search for. |
| `graphs` | string[] | No | Restrict search to these graph names. Defaults to all accessible graphs. |
| `topK` | integer | No | Maximum number of chunks to return. Default: `8`. Max: `32`. |
| `minScore` | number | No | Minimum cosine similarity score (0–1). Default: `0.3`. |

### Return shape

```json
{
  "results": [
    {
      "chunkId": "abc123",
      "sourceId": "src456",
      "graph": "work",
      "text": "The deployment pipeline runs on GitHub Actions...",
      "score": 0.87,
      "sourceName": "deployment-notes.md",
      "updatedAt": "2025-03-14T10:22:00Z"
    }
  ],
  "totalTokens": 412,
  "truncated": false
}
```

### Notes

- Results are sorted by descending similarity score.
- Chunks from `sensitive` graphs are never included, regardless of parameters.
- If `totalTokens` would exceed the graph's `maxTokensPerRecall` cap, lower-scoring chunks are dropped and `truncated` is set to `true`.

### Example

```json
{
  "tool": "recall",
  "arguments": {
    "query": "database migration strategy",
    "graphs": ["work"],
    "topK": 5
  }
}
```

---

## `remember`

Store a new memory directly from a conversation.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | The content to store. |
| `graphId` | string | No | Target engram slug (e.g. `book-notes`). Bypasses the resolver — caller must know the slug already exists. |
| `target_engram` | string | No | Human-friendly engram name (e.g. `"Book Notes"`). Resolved against existing engrams via exact-then-fuzzy matching; non-matches trigger a user-confirmation banner in the app (see below). Preferred over `graphId` for AI-driven calls. |
| `label` | string | No | Short label shown alongside the source in the Sources list. Defaults to a sensible placeholder. |
| `kind` | string | No | `"clip"` (default) — a discrete fact, note, or extracted text. `"ai-conversation"` — a turn or summary of the current AI ↔ user conversation. The Sources list shows these distinctly. |

### Return shape

```json
{
  "sourceId": "src789",
  "graphId": "book-notes",
  "nodeCount": 2
}
```

### Notes

- Text is chunked, embedded, and encrypted before storage — same pipeline as file ingest.
- Writing to a `sensitive` graph is rejected. The tool returns an error.
- **AI clients should prefer `target_engram` over `graphId`.** It's name-tolerant ("Book Notes" / "book-notes" / "booknotes" all resolve to the same engram), and when the name doesn't exactly exist Graphnosis surfaces a user-confirmation banner instead of silently writing to the default engram.

### The `target_engram` resolution flow

When `target_engram` is set, the sidecar runs a three-way resolver:

| Resolver result | What happens |
|---|---|
| **Exact match** (normalized graphId or displayName) | Writes immediately. |
| **Close matches** (≥1 candidate above similarity threshold) | The tool returns an error to the AI listing the closest matches by name. The app shows a banner top-center with ranked candidates (each labeled with the match reason — `contains your text`, `same words`, `close spelling`) plus a "Create new" option. The user picks one or creates a new engram with the AI's suggested name. |
| **No match** | The tool returns an error listing all existing engrams. The banner offers "Create new" only. |

**The AI never auto-creates an engram or silently disambiguates** — every new engram is a human-confirmed decision. The error returned to the AI is structured so a well-instructed client (Claude Desktop, Cursor, Claude Code) can relay the situation to the user without retrying the tool call.

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

---

## `correct`

Propose a natural-language correction to an existing chunk. Does **not** write anything — returns a diff for review.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chunkId` | string | Yes | ID of the chunk to correct. Obtain from a `recall` result. |
| `proposal` | string | Yes | Natural-language description of what should change. |

### Return shape

```json
{
  "correctionId": "cor001",
  "chunkId": "abc123",
  "originalText": "The API endpoint is /v1/search.",
  "proposedText": "The API endpoint is /v2/query.",
  "diff": "- The API endpoint is /v1/search.\n+ The API endpoint is /v2/query.",
  "expiresAt": "2025-03-14T11:00:00Z"
}
```

### Notes

- Requires Ollama running locally with `llama3.2:3b-instruct-q4_K_M`.
- The correction ID expires after 10 minutes if not applied.
- Always present this diff to the user before calling `apply`.

### Example

```json
{
  "tool": "correct",
  "arguments": {
    "chunkId": "abc123",
    "proposal": "The endpoint changed from /v1/search to /v2/query in March 2025."
  }
}
```

---

## `apply`

Commit a correction that was proposed by `correct`.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `correctionId` | string | Yes | The correction ID returned by `correct`. |

### Return shape

```json
{
  "chunkId": "abc123",
  "applied": true,
  "newEmbeddingComputed": true,
  "opLogEventId": "op999"
}
```

### Notes

- Will fail if the correction ID has expired (10-minute window).
- Overwrites the original chunk text and re-embeds.
- Writes a `correction` event to the op-log with both the old and new text.

### Example

```json
{
  "tool": "apply",
  "arguments": {
    "correctionId": "cor001"
  }
}
```

---

## `forget`

Remove a specific memory (chunk or source) from the Cortex.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chunkId` | string | No | Remove a single chunk by ID. |
| `sourceId` | string | No | Remove a source and all its chunks by source ID. |

At least one of `chunkId` or `sourceId` must be provided.

### Return shape

```json
{
  "deleted": true,
  "chunksRemoved": 7,
  "sourceRemoved": true
}
```

### Notes

- Deletion is permanent. The op-log records a `forget` event, but the content is gone.
- Attempting to forget a chunk in a `sensitive` graph returns an error (you cannot do it via AI — use the UI).

### Example

```json
{
  "tool": "forget",
  "arguments": {
    "sourceId": "src456"
  }
}
```

---

## `stats`

Return summary statistics for the active Cortex.

### Parameters

None.

### Return shape

```json
{
  "cortexPath": "/Users/you/Documents/MyCortex",
  "graphs": [
    {
      "name": "work",
      "tier": "personal",
      "sources": 48,
      "chunks": 1823,
      "estimatedTokens": 912000
    }
  ],
  "totalSources": 142,
  "totalChunks": 8421,
  "embeddingModel": "BGE-small-en-v1.5",
  "embeddingDimensions": 384,
  "cortexDbSizeBytes": 24117248
}
```

### Example

```json
{
  "tool": "stats",
  "arguments": {}
}
```
