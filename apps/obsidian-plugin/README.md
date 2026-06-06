[![Release](https://img.shields.io/github/v/release/nehloo-interactive/graphnosis-obsidian-plugin)](https://github.com/nehloo-interactive/graphnosis-obsidian-plugin/releases/latest)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Graphnosis App](https://img.shields.io/badge/Graphnosis-App-4f46e5)](https://graphnosis.ai)
[![SDK](https://img.shields.io/npm/v/%40nehloo%2Fgraphnosis?label=%40nehloo%2Fgraphnosis)](https://www.npmjs.com/package/@nehloo/graphnosis)
[![Docs](https://img.shields.io/badge/Docs-graphnosis.ai%2Fdocs-4f46e5)](https://graphnosis.ai/docs)

# Graphnosis for Obsidian

Private encrypted memory for your Obsidian vault, powered by [Graphnosis](https://graphnosis.ai).

- **Recall** — search your Graphnosis memory from the command palette and insert results directly into any note
- **Remember** — save the current note (or selected text) to your encrypted cortex with a single command
- **Vault sync** — automatically push modified `.md` files to memory on save; catches up any files changed while Obsidian was closed
- **Status bar** — a live cortex health indicator so you always know the bridge is up

Everything stays on your device. Graphnosis encrypts your memory at rest; nothing leaves your machine.

---

## Prerequisites

1. **Graphnosis desktop app** — [download here](https://graphnosis.ai/download). The app must be running and your cortex unlocked.
2. **Bearer token** — open Graphnosis → Settings → VS Code tab and copy the token shown there. (The same token works for Obsidian — it's a local-only bridge.)

---

## Installation

### Via BRAT (pre-release / beta)

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from Obsidian's community plugin list.
2. Open BRAT settings → **Add Beta Plugin** → paste `nehloo-interactive/graphnosis-obsidian-plugin`.
3. Enable **Graphnosis** in Settings → Community plugins.

### Via Obsidian Marketplace (once listed)

Search "Graphnosis" in Settings → Community plugins → Browse, then install and enable.

---

## Configuration

Open Settings → Graphnosis:

| Setting | Default | Description |
|---|---|---|
| HTTP bridge URL | `http://127.0.0.1:3457/mcp` | URL of the local MCP bridge (rarely needs changing) |
| Bearer token | — | Paste from Graphnosis → Settings → VS Code tab |
| Enable vault sync | off | Push modified notes to memory on save |
| Target engram | `personal` | Which Graphnosis engram receives vault notes |
| Max recall tokens | 2000 | Token budget per recall query (100–8000) |

Use **Test connection** to confirm the bridge is reachable after pasting the token.

---

## Commands

| Command | What it does |
|---|---|
| `Search Graphnosis memory…` | Opens the recall modal — type a query, click a result to insert it |
| `Save current note to Graphnosis memory` | Pushes the full current note to your cortex |

---

## Related

- [**nehloo-interactive/graphnosis-app**](https://github.com/nehloo-interactive/graphnosis-app) — desktop app monorepo (Tauri shell, Node sidecar, VS Code extension)
- [**@nehloo/graphnosis**](https://www.npmjs.com/package/@nehloo/graphnosis) — core memory SDK (npm)
- [**nehloo-interactive/graphnosis-secure-sync**](https://github.com/nehloo-interactive/graphnosis-secure-sync) — encryption, op-log, and federation layer the SDK is built on

---

## License

Apache-2.0 — see [LICENSE](LICENSE).
