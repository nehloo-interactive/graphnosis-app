---
title: Connect Your AI
description: Wire Graphnosis into Claude Desktop, Claude Code, Cursor, or any MCP-compatible client.
sidebar:
  order: 3
---

Graphnosis exposes a local MCP server — what we call the **synapse**, the small background process that bridges your AI client and your Cortex. You connect your AI client to it once; after that, your memory is available in every conversation — as long as the app is running and your Cortex is unlocked.

The synapse takes its name from the brain: a synapse is the connection that passes a signal between neurons. In Graphnosis it's the connection that passes a recall query into the Cortex and the matched engrams back to your AI. No synapse, no memory exchange.

## Why this beats dropping files into your AI client

Graphnosis pre-indexes your content into structured engram graphs (`.gai` files). That changes how your AI client behaves at conversation time:

- **More precise answers.** Your AI does not re-parse the same 200-page PDF, your `meeting-notes.md` archive, or your `budget.xlsx` from scratch every time you prompt it. The relevant slice — already chunked, tagged, and semantically indexed — is what arrives in context.
- **More consistent answers across sessions.** The same memory shows up the same way today, tomorrow, and three months from now. No re-uploading, no "I lost the file you shared last week," no agentic tool fighting to re-extract the same text twice.
- **Smaller context windows used.** The AI receives the few hundred tokens that matter, not the tens of thousands of tokens in your raw files. Faster responses, lower token costs, more headroom for the actual conversation.
- **Cross-source recall.** Because everything is indexed in one graph, your AI can connect a sentence in a PDF to a related note in a markdown file to a clip you saved from a webpage — work an LLM can never do with one-shot file attachments.

This is the practical reason Graphnosis exists alongside the privacy story: AI clients become faster, more reliable, and noticeably smarter when they don't have to re-read your files from zero every prompt.

## Before you start: the app must be running

For any MCP-compatible AI client to read from your Cortex, **Graphnosis must be running on your Mac and your Cortex must be unlocked**.

| Graphnosis state | What your AI client sees |
|------------------|--------------------------|
| App quit / not running | No Graphnosis tools. The AI behaves as if you don't have a Cortex. |
| App running, Cortex locked | Graphnosis tools may appear but every `recall` returns "Cortex is locked." |
| App running, Cortex unlocked | Full access to your memories. Only the chunks relevant to each prompt leave the app. |

The Graphnosis main window can be closed (⌘W) — the app keeps running in your menu bar. To fully stop it, use the tray icon's **Quit** option. If you want Graphnosis to start automatically at login, enable that in **Settings → Auto-start**.

## Find your MCP socket path

When Graphnosis is running, click the menu bar icon and choose **Copy MCP Config**. This puts the correct JSON snippet for your MCP server path onto your clipboard.

Alternatively, the server always listens on:

```
~/.graphnosis/mcp.sock
```

(stdio transport is also supported — see below)

## Claude Desktop

Open Claude Desktop's config file:

```
~/Library/Application Support/Claude/claude_desktop_config.json
```

Add a `graphnosis` entry inside the `mcpServers` object:

```json
{
  "mcpServers": {
    "graphnosis": {
      "command": "/Applications/Graphnosis.app/Contents/MacOS/graphnosis-sidecar",
      "args": ["--mcp-stdio"],
      "env": {
        "GRAPHNOSIS_CORTEX_PATH": "/Users/you/Documents/MyCortex"
      }
    }
  }
}
```

Replace `/Users/you/Documents/MyCortex` with the path to your Cortex folder.

Restart Claude Desktop. On next launch you'll see a small plug icon in the bottom-left of the input field — that confirms the MCP connection is live.

## Claude Code (CLI)

Claude Code reads MCP server config from `~/.claude.json` (user-level) or `.mcp.json` in your project root. Add a `graphnosis` entry to the `mcpServers` object:

```json
{
  "mcpServers": {
    "graphnosis": {
      "command": "/Applications/Graphnosis.app/Contents/MacOS/graphnosis-sidecar",
      "args": ["--mcp-stdio"],
      "env": {
        "GRAPHNOSIS_CORTEX_PATH": "/Users/you/Documents/MyCortex"
      }
    }
  }
}
```

Reload your Claude Code session (or open a new one). Run `/mcp` inside Claude Code to confirm `graphnosis` shows as connected, then the seven Graphnosis tools become available in any chat.

The fastest way to wire this is the menu-bar tray's **Connect an AI client → Claude Code** option — it writes the right config file for you and tells you whether to reload an active session.

## Cursor

In your project root, create or edit `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "graphnosis": {
      "command": "/Applications/Graphnosis.app/Contents/MacOS/graphnosis-sidecar",
      "args": ["--mcp-stdio"],
      "env": {
        "GRAPHNOSIS_CORTEX_PATH": "/Users/you/Documents/MyCortex"
      }
    }
  }
}
```

Reload the Cursor window. Graphnosis tools will appear in the MCP tools panel.

## Generic MCP clients (stdio transport)

Any MCP 1.x client that supports stdio transport can connect. Use:

- **Command:** `/Applications/Graphnosis.app/Contents/MacOS/graphnosis-sidecar`
- **Args:** `["--mcp-stdio"]`
- **Env:** `GRAPHNOSIS_CORTEX_PATH` set to your Cortex folder path

## The 7 MCP tools

Once connected, these tools are available to your AI:

| Tool | What it does |
|------|-------------|
| `recall` | Semantic search over your Cortex. The AI calls this automatically when it needs context. Returns the top-k most relevant chunks. |
| `remind` | Same as `recall` but tuned for "remind me about X" intent — biases toward recently-touched memories. |
| `remember` | Store a new memory from within a conversation. Useful for saving decisions, notes, or facts mid-chat. Supports `target_engram` so the AI can route the note into a specific engram (with a user-confirmation banner if the name doesn't exist or is ambiguous — see below). |
| `correct` | Propose a natural-language correction to an existing memory. Sends a diff to a local LLM and stores the proposed change for user review. Fires a notification when the app is in the background. |
| `apply` | Apply a confirmed correction. Must be called after `correct` returns a correction ID. |
| `forget` | Remove a specific memory by ID. |
| `stats` | Return Cortex statistics: total sources, chunks, graphs, embedding model info. |

### Asking the AI to save into a specific engram

When the AI calls `remember` with `target_engram: "Book Notes"`, Graphnosis tries to resolve the name against your existing engrams:

- **Exact name match** → the note is saved immediately.
- **Close matches** (typos, partial words, reordered tokens — `unpublished` ↔ `UnpublishedRomania`, `Romania Unpublished` ↔ `UnpublishedRomania`) → a banner appears top-center in the app listing the candidates with a match-reason label. Pick the right engram or create a new one with the AI's suggested name.
- **No match** → banner offers to create a new engram with that name in one click.

**The AI never auto-creates engrams or silently disambiguates.** Every new engram is your decision. If the app is in the background when this happens, you get a macOS notification too.

See the full [MCP Tools reference](/reference/mcp-tools/) for parameter details.

## How recall works automatically

When sensitivity allows it, Graphnosis can inject context proactively — before the AI even calls `recall`. The sidecar listens for the conversation's first user message, runs a fast semantic search, and prepends the top results as a system context block. This requires no AI cooperation; it works at the MCP transport layer.

If your client does not support proactive injection, the AI will use `recall` as a tool call in the first turn. Either way, your memory gets attached.

## Troubleshooting

**The MCP connection isn't showing up in Claude Desktop**
- Make sure Graphnosis is running (menu bar icon visible) and the Cortex is unlocked.
- Verify the `command` path is correct: `ls /Applications/Graphnosis.app/Contents/MacOS/graphnosis-sidecar`
- Check Claude Desktop logs at `~/Library/Logs/Claude/`.

**`recall` returns no results**
- Your Cortex may be empty. [Add some content](/guides/adding-content/) first.
- The Cortex may be locked. Click the menu bar icon and unlock it.
