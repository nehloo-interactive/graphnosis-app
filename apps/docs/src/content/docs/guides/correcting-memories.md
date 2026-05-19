---
title: Correcting Memories
description: How to fix inaccurate or outdated memories using the correction flow.
sidebar:
  order: 3
---

Information changes. Something you ingested six months ago may now be outdated. Graphnosis has a structured correction flow that lets you update memories precisely, without re-ingesting an entire source.

## What a correction is

A correction targets a specific chunk (or group of chunks) and proposes a natural-language change. A local LLM reviews the proposal, generates a diff, and asks you to confirm before anything is written. No AI model — local or cloud — can modify your Cortex without your explicit confirmation.

## Prerequisites

The correction flow requires **Ollama** running locally with the `llama3.2:3b-instruct-q4_K_M` model:

```bash
# Install Ollama from https://ollama.com, then:
ollama pull llama3.2:3b-instruct-q4_K_M
```

Ollama must be running (`ollama serve`) when you trigger a correction. Graphnosis will show an error if it cannot reach Ollama at `http://localhost:11434`.

:::note
The local LLM is used only to generate and review the diff — it never receives your full Cortex. It only sees the specific chunk you're correcting and your proposed change.
:::

## Correcting a memory from the UI

1. Open the Graphnosis window and find the chunk you want to correct (use the search bar).
2. Click the chunk to open the detail view.
3. Click **Correct this memory**.
4. Type your correction in natural language, for example: *"The API endpoint changed from /v1/search to /v2/query in March 2025."*
5. Graphnosis sends the chunk + your description to Ollama and shows you a proposed diff.
6. Review the diff. If it looks right, click **Apply**. If not, edit your description and try again.

## Correcting via MCP (from a conversation)

Your AI can initiate a correction mid-conversation using the `correct` and `apply` tools.

**Step 1 — the AI calls `correct`:**

```json
{
  "tool": "correct",
  "arguments": {
    "chunkId": "abc123",
    "proposal": "The endpoint changed from /v1/search to /v2/query."
  }
}
```

The `correct` tool does not write anything. It returns a `correctionId` and a proposed diff for your review.

**Step 2 — you (or the AI, with your permission) calls `apply`:**

```json
{
  "tool": "apply",
  "arguments": {
    "correctionId": "xyz789"
  }
}
```

`apply` commits the change. The original chunk is replaced, a new embedding is generated, and the op-log records the correction event.

:::caution
Never allow your AI client to call `apply` without reviewing the diff. In Claude Desktop and Cursor, you can require tool-call confirmation in the client settings.
:::

## What happens to the original chunk

After applying a correction:

- The original chunk text is overwritten with the corrected version.
- A new embedding is computed for the corrected text.
- The op-log records a `correction` event referencing both the old and new content (for audit purposes).
- The old content is not retained in the active graph, but it remains in the op-log if you need to trace history.

## Correction scope

A single correction targets one chunk at a time. If an error spans multiple chunks (for example, a wrong date mentioned in several places), you'll need to correct each chunk individually or reingest the updated source file.

For bulk updates, reingest is usually faster: update the source file and use **Reingest** from the Source detail view.
