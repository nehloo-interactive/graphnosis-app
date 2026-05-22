---
title: Using Graphnosis with AI Clients
description: What leaves your device when you connect Graphnosis to Claude, ChatGPT, or other AI services — and what doesn't.
---

Graphnosis is designed to work with AI clients like Claude Desktop, ChatGPT, Cursor, and any other MCP-aware application. This page explains exactly what data moves where when those connections are active — and what the precise conditions are for any data to move at all.

---

## The fundamental rule: your data only moves when you use it

Your Cortex is encrypted on your device. Graphnosis runs locally. **No memory content leaves your device under any circumstances unless you are actively interacting with an AI client.**

Specifically, memory content moves only when **all three** of the following are true simultaneously:

1. You have launched an AI client that is connected to Graphnosis via MCP.
2. You are actively engaged in a conversation — typing a message, asking a question.
3. That AI client calls the `recall` tool (or you explicitly call it yourself) in the context of that conversation.

If you have Graphnosis installed but your AI client is closed, nothing moves. If your AI client is open but you haven't started a conversation, nothing moves. If you're chatting about something unrelated to anything in your Cortex, recall either isn't called or returns nothing relevant. **Your Cortex is passive by default.**

---

## What actually gets sent — and how small it is

When `recall` fires, here is the exact sequence:

1. Graphnosis receives the query (typically the current conversation topic or your last message).
2. It runs a semantic search against your local engram graph — entirely on your device.
3. It selects the **top-k most relevant memory nodes** from that search — not your full Cortex, not even a full graph, just the nodes whose embedding vectors are closest to your query.
4. It enforces the **sensitivity tier caps** for each graph the nodes come from (see table below).
5. It formats the selected nodes as a plain-text context block.
6. That context block — and only that context block — is passed to the AI client.

**An analogy:** asking your AI client a question when Graphnosis is connected is like asking a colleague a question when they happen to have taken relevant notes. They don't hand you the whole filing cabinet. They pull out the two or three pages that apply to your question and read them to the AI on your behalf.

The rest of your Cortex — the other graphs, the other sources, the original files — remains encrypted on your device, untouched, unsent.

---

## What the AI provider sees — and what their policies say

Once the context block reaches your AI client, it is processed by the AI provider's infrastructure. **Graphnosis and Nehloo Interactive are not a party to that transaction.** The AI provider's privacy policy governs what happens to that text — whether it is retained, used for model training, or processed in any other way.

| AI client | Provider | Privacy policy |
|---|---|---|
| Claude Desktop | Anthropic | https://www.anthropic.com/privacy |
| ChatGPT | OpenAI | https://openai.com/privacy |
| Cursor | Anysphere | https://cursor.com/privacy |
| GitHub Copilot | Microsoft / GitHub | https://privacy.microsoft.com |

This table is not exhaustive and policies change. Always check the current privacy policy of any AI service you use before ingesting sensitive information.

---

## Sensitivity tiers limit what gets recalled

Graphnosis lets you assign a **sensitivity tier** to each graph. These limits are enforced by the sidecar — the AI client never sees the tier configuration and cannot override it. The limits apply per `recall` call, not per session.

| Tier | Max nodes recalled | Max tokens recalled |
|---|---|---|
| `public` | 50 | 8,000 |
| `personal` | 50 | 8,000 |
| `sensitive` | 0 | 0 (AI access blocked entirely) |

For `sensitive` graphs, recall returns zero results. The AI is not told why — it simply gets no content from that graph. You can still search, view, and manage sensitive-tier memories in the Graphnosis UI. They just never leave your device.

See [Graphs & Sensitivity Tiers](/guides/graphs-and-tiers) for setup instructions.

---

## What Graphnosis does NOT send — ever

- Your full Cortex
- Your original source files (files stay on your disk; only extracted engram nodes are in the Cortex)
- Your encryption key or passphrase
- Any data to Nehloo Interactive's servers (we have none)
- Telemetry, usage analytics, or error reports
- Anything from a `sensitive`-tier graph
- Any content from a conversation where `recall` was not called

---

## Open-source encryption — what it means for you

Both libraries that handle your data are open to read and audit: `@nehloo/graphnosis` (the `.gai` graph format) under Apache-2.0, and `@nehloo-interactive/graphnosis-secure-sync` (the encryption layer) under the [Functional Source License (FSL-1.1)](https://fsl.software). You can read the source code, verify how encryption works, and use the libraries directly to access your own Cortex programmatically — for exports, custom tooling, or building integrations.

The open-source nature of the encryption libraries does not weaken your security. The protection is your passphrase, not the secrecy of the algorithm. Anyone who has your Cortex files but not your passphrase still cannot read anything.

---

## How this differs from file-based AI memory

Traditional approaches to "giving AI your documents" involve either pasting files into the chat window or using retrieval tools that return large raw text blocks. In both cases, the AI receives unprocessed document content — sometimes entire files.

Graphnosis is architecturally different. When you ingest a file, Graphnosis does not store the raw text for later retrieval. It encodes the content into **engrams** — semantically indexed, binary-encrypted memory nodes. The original file stays on your disk. The engrams live in the encrypted Cortex.

When `recall` fires, what the AI receives is:
- **Binary-decoded** from the engram graph — not a raw file read
- **Semantically filtered** — only nodes relevant to the current query
- **Token-budgeted** — hard-capped by graph tier
- **Formatted** as a clean context block — not a file attachment

This means even in the moment of recall, the AI receives a compact, curated slice of your memory — not a dump of your files. The precision is the point.

---

## Recommendations

- **Know your AI provider's policy** before ingesting sensitive content. If your AI provider uses conversation data for model training by default, be aware that recalled excerpts may be included.
- **Use sensitivity tiers actively.** Health records, financial information, personal correspondence — consider a dedicated `sensitive` graph for these. They will never be shared with any AI client.
- **Forget what you don't need.** The `forget` MCP tool removes a source and all derived nodes from your Cortex permanently. You control what stays.
- **You don't have to connect any AI client at all.** Graphnosis works as a personal knowledge store independently. You can use the `recall` and `stats` tools without ever connecting an AI client.

---

## The bottom line

Graphnosis is designed so that your information goes nowhere unless you put it to use — and even then, it delivers only what is relevant to what you're doing at that exact moment. Your Cortex is not a data source that AI providers mine. It is your private memory. Graphnosis retrieves from it surgically, on your behalf, only when you ask.

---

*See also: [Privacy Policy](/legal/privacy-policy) · [Terms of Use](/legal/terms-of-use)*
