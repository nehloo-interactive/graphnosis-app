---
title: Overview
description: What Graphnosis is, how it works conceptually, and what you need to run it.
sidebar:
  order: 1
---

Graphnosis gives any AI a persistent, private memory — without a cloud service, an account, or sending your data anywhere.

## The missing piece: AI never had a hippocampus

Here is the problem with how AI "memory" has worked until now.

When people want an AI to know something, they paste files into the chat window, attach documents, or use retrieval tools that dump raw text into the AI's context. The AI reads the document fresh — every single time, for every conversation. It is the cognitive equivalent of handing someone a textbook and asking them to read it before every question, then closing it and forgetting everything afterward.

The human brain doesn't work this way. The brain has a division of labour:

- The **hippocampus** converts raw experience into compact, indexed memory traces — **engrams**. It handles encoding (turning new information into memory), storage (maintaining those memory traces over time), and retrieval (surfacing the right memory when the brain needs it).
- The **prefrontal cortex** handles reasoning, planning, and language. When it needs to draw on something you've learned, it doesn't re-read the original source — the hippocampus retrieves the relevant engram and delivers it as context.
- The **cortex** (more precisely, the neocortex) is the long-term store — the vast, distributed archive of everything you know.

**AI has always had the prefrontal cortex (the reasoning layer) but not the hippocampus.** It reasons brilliantly but forgets everything the moment the context window closes. It has no long-term store it can draw on selectively.

Graphnosis is the hippocampus your AI has been missing.

### Why the seahorse?

The Graphnosis logo is a seahorse — and that's not just decoration.

The word **hippocampus** comes from the ancient Greek *hippókampos* (ἱππόκαμπος), literally "horse-monster of the sea" — a seahorse. The anatomist Julius Caesar Aranzi, dissecting a human brain in 1564, looked at the small curled structure deep in the medial temporal lobe and thought: *that looks like a seahorse*. The name stuck. Five centuries later, every neuroscience textbook still calls it the hippocampus.

So the brand stack lines up like this:

- **The seahorse** (logo) → reminds you of the **hippocampus** (anatomy) → which is the brain region for **encoding and retrieving memory** (function) → which Graphnosis embodies as the **sidecar / synapse + engram graph + .gai files** (software).

When you see the seahorse, think: *this is the part of the AI stack that remembers for me.*

### How Graphnosis maps to the brain

| Brain structure | Graphnosis equivalent | What it does |
|---|---|---|
| Neocortex (long-term store) | Your **Cortex folder** | Encrypted archive of all your knowledge — the `.gai` engram files |
| Engrams (memory traces) | **Knowledge graph nodes** | Compact, semantically indexed representations of what you've ingested |
| Hippocampus (encode + retrieve) | **Graphnosis sidecar** | Encodes raw content into engrams on ingest; retrieves relevant ones on recall |
| Synapse (signal pathway) | **Graphnosis synapse** (the local background process) | The bridge between your AI client and your Cortex; only fires when the app is running and the Cortex is unlocked |
| Prefrontal cortex (reasoning) | Your **AI client** | Receives only the retrieved engrams it needs; reasons from there |

The **synapse** is what we call Graphnosis's local sidecar process — the small program that runs in the background whenever the app is open. In the brain, a synapse is the active connection that passes a signal from one neuron to the next; in Graphnosis it is the active connection that passes a recall query from your AI client into the Cortex and the matched engrams back out. When the synapse is offline (app closed, Cortex locked, or sidecar crashed), no memory flows. The app's error messages refer to it by name — e.g. "Another Graphnosis synapse is already holding this cortex's lock" — so it helps to recognize the term.

When you ingest a PDF or document, Graphnosis doesn't hand the raw file to your AI — that's the old, expensive approach. It encodes the document into engrams: semantically compressed, binary-encrypted memory traces stored in the Cortex. The original file stays on your disk, untouched.

When you ask your AI a question, the hippocampus does its job: it searches the engram graph, finds the memory traces most relevant to what you're asking right now, and delivers a small, precise context block. Your AI reasons with current, targeted memory — not a stale document dump.

This is why Graphnosis responses feel different from naive retrieval-augmented generation. The AI isn't reading your whole document every time. It is remembering.

---

## The core idea

Most AI assistants are stateless by default. They don't remember what you told them last week, which documents you've been working with, or the decisions you've made. You end up re-explaining context in every conversation.

Graphnosis solves this by sitting alongside your AI client as an MCP server. When a conversation starts, it quietly retrieves only the most semantically relevant engrams from your personal Cortex and surfaces them as context. Your AI responds as if it already knows the background.

**Your data never leaves your device unless you are actively using an AI client.** Even then, Graphnosis sends only the small handful of memory nodes relevant to your specific question — not your full Cortex, not the original files, not anything unrelated to what you're asking at that moment. If you close the AI client or don't ask anything, nothing moves.

Everything stays on your machine. No Nehloo servers are ever contacted.

## Key concepts

### Cortex

A **Cortex** is an encrypted local folder — named after the neocortex, the brain's long-term memory store. It holds your engram graph (the `.gai` binary files), embedding cache, op-log, and policy configuration — all encrypted at rest with libsodium `xchacha20poly1305`. The encryption key is derived from your passphrase using Argon2id.

You choose where the folder lives. You can have multiple Cortexes — for work, personal life, specific projects. Each is completely independent.

### Engram graph

Inside the Cortex, memories are stored as an **engram graph** — a knowledge graph where each node is a semantically indexed memory trace derived from something you've ingested. Nodes are binary-encoded (`.gai` format), not human-readable plain text.

The files the app writes to disk are not plain `.gai` — they are encrypted with a `GNAPP\x01` envelope (xchacha20poly1305, Argon2id key derived from your passphrase) before being stored. This means:

- **Your AI cannot read your Cortex directly**, even if it somehow had access to the files. The engrams are only surfaced through Graphnosis's retrieval layer.
- **No tool can read your Cortex without your passphrase.** The encryption does not depend on the libraries being secret — both `@nehloo/graphnosis` and `@nehloo-interactive/graphnosis-secure-sync` are open source under FSL-1.1. Auditable crypto is stronger crypto.
- **Power users can access their own data programmatically.** With both libraries and your passphrase, you can decrypt and parse your Cortex outside the app — for exports, custom tooling, or migration. This is intentional. Your data is not locked in.

The Cortex is also intentionally portable: the encryption salt is embedded in each file, not tied to the machine it was created on. Copy the folder to another machine, unlock it with your passphrase — it just works. The passphrase is the key, not the device. Treat it accordingly.

### Graphs

Inside a Cortex you can have multiple **graphs** — named subsets of the engram graph, each with its own sensitivity tier and token budget. Think of graphs as separate topics: `work`, `health`, `research`. When the AI calls `recall`, each graph's tier determines whether and how much of it can be surfaced.

### Sources and chunks

When you ingest a file or URL, Graphnosis creates a **Source** record and splits the content into chunks. Each chunk is embedded (converted to a vector) locally using a BGE-small-en-v1.5 model running entirely on your device. The embedding is what enables semantic recall — finding relevant memories even when you don't remember the exact words you used.

### Recall via MCP

When you open a conversation in your AI client, Graphnosis is running as an MCP server in the background. The AI client calls the `recall` tool with the current conversation topic. Graphnosis performs a semantic search across your engram graph, selects the top-k most relevant nodes (subject to tier limits and token caps), and returns them as a compact, plain-text context block.

**This is the only moment when any memory content leaves your device** — and it travels only to the AI provider you are actively using, for the conversation you are actively having. It does not go to Nehloo Interactive. It does not go anywhere else. See [Using Graphnosis with AI Clients](/legal/third-party-ai/) for a full breakdown.

For this to work, the Graphnosis app must be running and your Cortex must be unlocked. If the app is closed or the Cortex is locked, your AI client falls back to behaving as if Graphnosis isn't there.

### Why pre-indexing makes AI clients more precise

Without Graphnosis, when you ask your AI to "summarize the budget spreadsheet I shared last week" or "find the section in that 200-page PDF about Q4," the client has to parse the file again — every prompt, every session. That's slow, expensive in tokens, and prone to inconsistency (different runs produce different summaries from the same file).

With Graphnosis:

- Each file is parsed **once** at ingest time and stored as structured engrams in `.gai` graphs.
- At conversation time, the AI receives the few hundred tokens that actually match the prompt, not the entire file.
- Answers stay consistent across sessions because the same indexed memory is recalled the same way every time.
- Different sources (PDFs, markdown notes, web clips, conversations) live in one graph, so the AI can connect ideas across files — something a one-shot file attachment can never do.

The result: faster prompts, smaller context windows, lower API costs, and noticeably more reliable answers — without giving up control of your data.

### Autonomous upkeep

A Cortex you never tend slowly fills with clutter — the same fact saved twice, near-identical notes, memories with nothing linked to them. Graphnosis maintains the graph on its own: background passes merge memories that are provably duplicates, weave connections between related ones, and let old, unused memory fade. Anything that needs a judgment call is routed to the Check-in tab rather than guessed at. See [Autonomous Upkeep](/guides/autonomous-upkeep/).

## What AI clients work with Graphnosis

Any client that supports the Model Context Protocol (MCP) will work:

- **Claude Desktop** — full support; all 6 MCP tools available
- **Cursor** — MCP tool support via `mcp.json`
- **Continue.dev** — MCP tool support
- **Generic MCP clients** — anything implementing MCP 1.x

ChatGPT desktop has limited third-party MCP support as of early 2025. Check the [Connect Your AI](/getting-started/connect-ai/) guide for current setup instructions.

## System requirements

| Component | Requirement |
|-----------|------------|
| Operating system | macOS 13 Ventura or later (Windows/Linux: planned) |
| Architecture | Apple Silicon or Intel |
| Node.js | 20 or later (bundled with the app) |
| Disk space | ~200 MB for the app; Cortex size depends on your content |
| Rust toolchain | Required only if building from source |

The embedding model (ONNX, ~90 MB) and any optional local LLM for corrections run entirely offline. No GPU required, though an Apple Silicon Mac with Neural Engine will be noticeably faster for embeddings.
