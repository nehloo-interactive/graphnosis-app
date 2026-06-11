---
title: Connect Your AI
description: Wire Graphnosis into Claude Desktop, Claude Code, Cursor, Zed, Cline, mobile, or any MCP-compatible client.
sidebar:
  order: 3
---

Graphnosis exposes a local MCP server — what we call the **synapse**, the small background process that bridges your AI client and your cortex. You connect your AI client to it once; after that, your memory is available in every conversation — as long as the app is running and your cortex is unlocked.

The synapse takes its name from the brain: a synapse is the connection that passes a signal between neurons. In Graphnosis it's the connection that passes a recall query into the cortex and the matched engrams back to your AI. No synapse, no memory exchange.

## Why this beats dropping files into your AI client

Graphnosis pre-indexes your content into structured engram graphs (`.gai` files). That changes how your AI client behaves at conversation time:

- **More precise answers.** Your AI does not re-parse the same 200-page PDF, your `meeting-notes.md` archive, or your `budget.xlsx` from scratch every time you prompt it. The relevant slice — already chunked, tagged, and semantically indexed — is what arrives in context.
- **More consistent answers across sessions.** The same memory shows up the same way today, tomorrow, and three months from now. No re-uploading, no "I lost the file you shared last week," no agentic tool fighting to re-extract the same text twice.
- **Smaller context windows used.** The AI receives the few hundred tokens that matter, not the tens of thousands of tokens in your raw files. Faster responses, lower token costs, more headroom for the actual conversation.
- **Cross-source recall.** Because everything is indexed in one graph, your AI can connect a sentence in a PDF to a related note in a markdown file to a clip you saved from a webpage — work an LLM can never do with one-shot file attachments.

This is the practical reason Graphnosis exists alongside the privacy story: AI clients become faster, more reliable, and noticeably smarter when they don't have to re-read your files from zero every prompt.

## Before you start: the app must be running

For any MCP-compatible AI client to read from your cortex, **Graphnosis must be running and your cortex must be unlocked**. The instructions below apply to macOS; Windows users can follow the same Claude Desktop / Claude Code / Cursor config steps — the sidecar binary and relay work on Windows.

| Graphnosis state | What your AI client sees |
|------------------|--------------------------|
| App quit / not running | No Graphnosis tools. The AI behaves as if you don't have a cortex. |
| App running, cortex locked | Graphnosis tools may appear but every `recall` returns "cortex is locked." |
| App running, cortex unlocked | Full access to your memories. Only the chunks relevant to each prompt leave the app. |

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

Replace `/Users/you/Documents/MyCortex` with the path to your cortex folder.

Restart Claude Desktop. On next launch you'll see a small plug icon in the bottom-left of the input field — that confirms the MCP connection is live.

**Windows:** the config file is at `%APPDATA%\Claude\claude_desktop_config.json`. Use the Windows sidecar path instead: `C:\Program Files\Graphnosis\graphnosis-sidecar.exe`. The in-app **Connect an AI client → Claude Desktop** wizard generates the correct snippet for your platform automatically.

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

Reload your Claude Code session (or open a new one). Run `/mcp` inside Claude Code to confirm `graphnosis` shows as connected, then the Graphnosis tools become available in any chat.

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

## GitHub Copilot (VS Code)

Graphnosis integrates with Copilot Chat via three paths. The in-app wizard (**Settings → Configure Copilot…** or the AI clients panel) shows all three options and generates your config with the bearer token pre-filled.

### Option A — In-app MCP install (recommended)

Open the Graphnosis app and go to the VS Code — Copilot Chat setup (AI clients panel or **Settings → Configure Copilot…**). Click **Install MCP Server** — this opens your VS Code user MCP config file directly in VS Code so you know exactly where to paste. Copy your bearer token from the same panel, then paste the JSON snippet from Option B (pre-filled with your token) into the file.

### Option B — VS Code MCP config

Create or edit the VS Code user MCP config with the snippet the wizard generates:

| Platform | Path |
|----------|------|
| macOS | `/Users/[username]/Library/Application Support/Code/User/mcp.json` |
| Windows | `C:\Users\[username]\AppData\Roaming\Code\User\mcp.json` |
| Linux | `/home/[username]/.config/Code/User/mcp.json` |

```json
{
  "servers": {
    "graphnosis": {
      "type": "http",
      "url": "http://127.0.0.1:3457/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

This registers Graphnosis as an MCP server for manual tool use. Copilot will call `recall` and `remember` when you explicitly ask it to.

The wizard's **Copy** button produces the exact JSON with your token pre-filled.

### Option C — GitHub Copilot CLI

For the `gh copilot` CLI (`gh copilot suggest`, `gh copilot explain`, etc.). This uses a **different file and a different top-level key** than the VS Code config above — save the snippet to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "graphnosis": {
      "type": "http",
      "url": "http://127.0.0.1:3457/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

The app's wizard generates this snippet with your token pre-filled — use the **Copy** button in the Option C panel. If you rotate your token later, update this file alongside your VS Code MCP config.

## Other MCP-native clients

The same `graphnosis` MCP server entry works in every MCP-native client — only the config file path changes. Below is the full set we've verified, ranked by user base. Each is a config-file drop-in; no Graphnosis-specific work per client.

| Client | Config file | Notes |
|---|---|---|
| **Zed** | `~/.config/zed/settings.json` (`context_servers` key) | Native MCP support since late 2024. Growing dev audience. |
| **Cline** (VS Code extension) | Settings panel in the Cline sidebar | Per-VS-Code-window config; nice UI for adding MCP servers. |
| **Continue.dev** | `~/.continue/config.json` | OSS-leaning. Same JSON shape as Claude Desktop. |
| **Goose** (Block) | `~/.config/goose/profiles.yaml` | Block-backed OSS MCP host. YAML, not JSON. |
| **5ire** | UI-driven MCP picker in app settings | Desktop MCP-first client. No file editing needed. |
| **Witsy** | UI-driven MCP picker in app settings | Smaller user base. Same flow as 5ire. |
| **LibreChat / Open WebUI** | Their MCP plugin pages | Self-hosted multi-model UIs. Documented in each project's MCP docs. |

The config snippet itself stays the same as the Claude Desktop / Claude Code / Cursor examples above — `command`, `args: ["--mcp-stdio"]`, `env: { GRAPHNOSIS_CORTEX_PATH }`. Reload the client after editing.

**Not yet MCP-native (need an adapter, not built yet):**
- **ChatGPT** (Desktop / Web / Mobile) — OpenAI has committed to MCP but rollout is partial. Today, the path is a Custom GPT Action (OpenAPI 3 spec served by Graphnosis' HTTP bridge). Tracked for a future release.
- **Gemini / Bard** — Google's own function-calling format. No MCP.

## Generic MCP clients (stdio transport)

Any MCP 1.x client that supports stdio transport can connect. Use:

- **Command:** `/Applications/Graphnosis.app/Contents/MacOS/graphnosis-sidecar`
- **Args:** `["--mcp-stdio"]`
- **Env:** `GRAPHNOSIS_CORTEX_PATH` set to your cortex folder path

## Connect from your phone (or any HTTP MCP client)

There are two ways to reach your cortex from another device, both configured under **Settings → Mobile & Remote**:

- **Browser access (personal server)** — Graphnosis serves the full app UI on port `3456`, so you open your cortex in any phone or tablet browser. Enable it, then scan the QR (it encodes the URL + access token for one-scan unlock).
- **MCP access** — mobile AI clients (Claude for iOS, Claude for Android) and any tool that speaks MCP over HTTP reach your cortex on port `3457` with bearer-token auth. Copy the MCP Server URL + bearer token from the same panel and paste them into the client's MCP server settings.

Both are opt-in and use the same Tailscale-vs-LAN security model. The full walkthrough — QR pairing, the `loopback-only` vs `all-interfaces` tradeoff, `tailscale serve` for HTTPS on iOS, token revocation, and running a headless personal server — is in **[Connect from your phone](/getting-started/mobile/)**.

**Why Tailscale is the recommended path:** the alternative — `all-interfaces` on your LAN — works at home but breaks the moment you leave the house. Tailscale gives you an encrypted overlay network that follows you everywhere without exposing a port to the public internet. Install it once on both devices; the panel auto-detects the Tailscale IP.

## The MCP tools

Once connected, the full Graphnosis toolset is available to your AI, organized into ten categories (Core memory, Engram discovery, Structured recall, Source operations, Engram operations, Brain maintenance, Skills (SOPs), Approximate, Conditional, and Non-deterministic). The most commonly used ones:

| Tool | What it does |
|------|-------------|
| `recall` | Semantic search over your cortex. The AI calls this automatically when it needs context. Returns the top-k most relevant chunks. |
| `dig_deeper` | Escalation tool — call this when `recall` returns thin results (0–3 nodes) before telling the user nothing was found. Runs content recall + filename expansion + cross-engram entity hop. |
| `remind` | Same as `recall` but tuned for "remind me about X" intent — biases toward recently-touched memories. |
| `remember` | Store a new memory from within a conversation. Useful for saving decisions, notes, or facts mid-chat. Supports `target_engram` so the AI can route the note into a specific engram (with a user-confirmation banner if the name doesn't exist or is ambiguous — see below). |
| `edit` | Propose a change to an existing memory — correction, update, or append. Returns a diff for user review; nothing is written until approved. Fires a notification when the app is in the background. (`correct` still works as an alias.) |
| `apply` | Commit a reviewed diff. Must be called after `edit` returns a diff ID. |
| `forget` | Remove a specific memory by ID. |
| `stats` | Return cortex statistics: total sources, chunks, graphs, embedding model info. |
| `walk_skill` / `walk_skill_structured` | Walk a Skill (a Standard Operating Procedure) step-by-step — narrative text for human-facing guidance, JSON `SkillExecutionPlan` for AI execution. The structured form gives the AI everything it needs to run a multi-step skill: required inputs, sub-skill calls with args + capture variables, and failure handlers. |

See the full [MCP Tools reference](/reference/mcp-tools/) for every tool with parameter details, including the Skills (SOPs) tools (`list_skills`, `walk_skill`, `walk_skill_structured`, `train_skill`, `save_skill_run`, and more).

### Asking the AI to save into a specific engram

When the AI calls `remember` with `target_engram: "Book Notes"`, Graphnosis tries to resolve the name against your existing engrams:

- **Exact name match** → the note is saved immediately.
- **Close matches** (typos, partial words, reordered tokens — `unpublished` ↔ `UnpublishedRomania`, `Romania Unpublished` ↔ `UnpublishedRomania`) → a banner appears top-center in the app listing the candidates with a match-reason label. Pick the right engram or create a new one with the AI's suggested name.
- **No match** → banner offers to create a new engram with that name in one click.

**The AI never auto-creates engrams or silently disambiguates.** Every new engram is your decision. If the app is in the background when this happens, you get a macOS notification too.

## How recall works automatically

When sensitivity allows it, Graphnosis can inject context proactively — before the AI even calls `recall`. The sidecar listens for the conversation's first user message, runs a fast semantic search, and prepends the top results as a system context block. This requires no AI cooperation; it works at the MCP transport layer.

If your client does not support proactive injection, the AI will use `recall` as a tool call in the first turn. Either way, your memory gets attached.

## Add the Graphnosis docs to your cortex

A connected AI client knows whatever is in your cortex — but by default it knows nothing about Graphnosis itself. To fix that, the first time you unlock a cortex the app offers to ingest the Graphnosis documentation into a dedicated `graphnosis-docs` engram. Accept, and your AI can answer "how do snapshots work?" or "what does the `edit` tool do?" straight from recall, using the same docs you are reading now.

The documentation ships **bundled inside the app** — adding it is a fully offline operation with no network call. The `graphnosis-docs` engram lives in your cortex like any other; it just is not built from your own content.

It also stays current on its own. After an app update brings newer docs, the engram auto-refreshes to match. Two things it always respects:

- If you **declined** the offer, the app does not ask again or ingest anything.
- If you **deleted** the `graphnosis-docs` engram, it stays gone — the auto-refresh will not silently recreate it.

So you can have a Graphnosis-aware AI with one click, or opt out entirely — your choice either way.

## Beyond AI clients: auto-ingest from your existing tools

Graphnosis is not just a memory you talk to — it's a memory that **grows on its own** from tools you already use. Built-in connectors pull, receive, or watch for new content and ingest it into the engram you choose:

| Connector | Ingests | Setup |
|---|---|---|
| **RSS / Atom** | new entries from any feed URL(s) | paste URLs, no credentials |
| **GitHub** | issues, PRs, releases from repos you watch | BYO Personal Access Token |
| **Slack** | starred items + (optional) channel history | BYO Slack app Bot/User Token |
| **Trello** | cards + checklists from boards you choose | BYO API Key + Token |
| **Linear** | issues with priority/state/assignee/label filters | BYO Personal API Key |
| **Obsidian** | notes from a vault folder, watched live | folder path, no credentials |
| **GBrain** | Markdown from a local knowledge repo, watched live | folder path, no credentials |
| **AI Context Files** | `CLAUDE.md` / `AGENTS.md` / `.cursorrules` etc. from your projects | folder paths, no credentials |
| **Webhook** | anything that can POST JSON (Zapier, IFTTT, custom scripts) | auto-generated unique URL |

All connectors are configured in **Settings → Connectors** in the Graphnosis app. **Your credentials, your apps** — Graphnosis is never in the OAuth callback chain. Credentials are stored encrypted at rest in your cortex (XChaCha20-Poly1305, same as your memory files).

Full setup walkthroughs for each connector: **[Auto-ingest from your tools](/guides/connectors/)**.

## Troubleshooting

**The MCP connection isn't showing up in Claude Desktop**
- Make sure Graphnosis is running (menu bar icon visible) and the cortex is unlocked.
- Verify the `command` path is correct: `ls /Applications/Graphnosis.app/Contents/MacOS/graphnosis-sidecar`
- Check Claude Desktop logs at `~/Library/Logs/Claude/`.

**`recall` returns no results**
- Your cortex may be empty. [Add some content](/guides/adding-content/) first.
- The cortex may be locked. Click the menu bar icon and unlock it.

---

## Related

[A GRAPHNOSIS.md for Your AI](/getting-started/graphnosis-md/) — the drop-in instructions file that tells your AI client to actually use Graphnosis.

[MCP Tools](/reference/mcp-tools/) — full reference for every tool.

[Memory Across AI Clients](/guides/memory-across-ai-clients/) — how the same cortex serves multiple AIs at once.

[AI Access Controls](/guides/ai-access-controls/) — sensitivity tiers, consent gates, and the audit trail.

[Connect from Your Phone](/getting-started/mobile/) — the same cortex from iOS or Android.

