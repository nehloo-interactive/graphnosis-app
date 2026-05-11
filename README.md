# Graphnosis

> Private second memory for any AI. Local-first, encrypted, multi-graph.
> Attaches a relevant subgraph from your own memory to every prompt you send
> to any MCP-aware AI — no effort, no API keys, no AI literacy required.

**Product name:** Graphnosis · **Domain:** [graphnosis.com](https://graphnosis.com) (primary) · [graphnosis.app](https://graphnosis.app) (downloads) · [graphnosis.org](https://graphnosis.org) (OSS) · [graphnosis.ai](https://graphnosis.ai) (reserved)
**Repo:** Graphnosis App (this monorepo) · **Engine:** [`@nehloo/graphnosis`](https://www.npmjs.com/package/@nehloo/graphnosis)

---

## Status

**Private alpha.** This repository is private during foundational development. Source will be made available at public launch under the [Functional Source License 1.1 (FSL-1.1-Apache-2.0)](LICENSE) — both so users can verify the privacy promises ("your memory never leaves your device") and so the community can audit and contribute. The license converts to Apache 2.0 two years after each release.

The underlying engine, [`@nehloo/graphnosis`](https://github.com/nehloo/Graphnosis), is already open source under Apache 2.0.

---

## What it does

1. You pick a folder (local or iCloud/Drive) where your encrypted memory lives.
2. You feed it things worth remembering:
   - **Files** from Finder (in place — files stay where they are)
   - **Web pages or selected text** via Share Sheet / global hotkey
   - **AI conversation notes** via "remember this" inside Claude / Cursor / Claude Code
3. Anytime you talk to an MCP-aware AI, a relevant federated subgraph from your memory gets attached, within a tight token budget. The AI answers as if it knew you.
4. You correct it in natural language (*"the trip was September, not August"*). A bundled local LLM produces a structured diff, you confirm, the graph updates — privately, on-device.

The full `.aikg` files never reach the AI. The AI only ever sees the scoped subgraph relevant to the current prompt — and that subgraph is hard-capped by per-graph **sensitivity tiers** (`public` / `personal` / `sensitive`) that the AI cannot override.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Tauri shell (Rust) — apps/desktop                                          │
│  - menu bar, hotkeys, Share Sheet receiver                                 │
│  - OS keychain (Touch ID / Windows Hello)                                  │
│  - folder watcher + op-log sync engine                                     │
│  - spawns and supervises the Node sidecar                                  │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │  Unix socket (newline JSON-RPC)
                                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Node sidecar (TypeScript) — apps/desktop-sidecar                          │
│  - GraphnosisHost: encryption at rest, op-log, source index                │
│  - ingest (file / web / clip)                                              │
│  - correction pipeline (local LLM via Ollama → structured diff)            │
│  - local embeddings via fastembed (BGE-small-en-v1.5, ONNX)                │
│  - federated query across all user graphs with tier-capped budgets         │
│  - MCP server over stdio: recall, remember, correct, apply, forget, stats  │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │
                                 ▼
                  ┌─────────────────────────────┐
                  │  @nehloo/graphnosis SDK     │
                  │  (Apache 2.0, npm)          │
                  └─────────────────────────────┘
```

---

## Repo layout

```
apps/
  desktop/              Tauri app (Rust shell + minimal HTML/JS UI)
  desktop-sidecar/      Node TypeScript sidecar (Graphnosis + MCP + IPC)
packages/
  graphnosis-app-core/  Crypto, op-log, source index, federation,
                        sensitivity tiers, embeddings cache, policy
```

---

## MCP tools exposed to AI clients

| Tool | Purpose |
|---|---|
| `recall` | Federated semantic search across user graphs; subject to per-graph tier caps. Hard limits: `maxNodes ≤ 50`, `maxTokens ≤ 8000`. Sensitive graphs are clamped further (≤ 5 nodes / 500 tokens). Each response includes an audit footer showing exactly which graphs contributed. |
| `remember` | Save a note from the current AI conversation. Surfaces contradictions if the SDK detects them. |
| `correct` | Natural-language correction → bundled local LLM produces a structured diff → preview returned. No write happens here. |
| `apply` | Commit a previewed correction after user confirmation. |
| `forget` | Remove a source and all nodes derived from it (soft-delete per SDK semantics). |
| `stats` | Ground-truth inspection: total / active / soft-deleted node counts per graph, sources, and previews. Used to debug "where did my nodes go?" |

---

## Local development

Prerequisites:
- **Node 20+** (use `nvm install 20 && nvm use 20`)
- **pnpm 9+** (via `corepack enable && corepack prepare pnpm@9 --activate`)
- **Rust toolchain** (`curl https://sh.rustup.rs -sSf | sh`) — only for the Tauri shell
- **Ollama** + `llama3.2:3b-instruct-q4_K_M` — only for the `correct` tool

Setup:

```bash
pnpm install
pnpm -r build
```

Smoke test (no Tauri, no Claude, no LLM required — exercises the full encryption → ingest → recall → forget loop):

```bash
pnpm --filter @graphnosis-app/desktop-sidecar smoke
```

Run the sidecar standalone for MCP wiring into Claude Desktop:

```bash
GRAPHNOSIS_VAULT="$HOME/Graphnosis" \
GRAPHNOSIS_PASSPHRASE="dev-passphrase-change-me" \
pnpm dev:sidecar
```

Run the full desktop app (requires Rust):

```bash
pnpm dev:desktop
```

---

## Wiring into Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "Graphnosis": {
      "command": "node",
      "args": ["/absolute/path/to/GraphnosisApp/apps/desktop-sidecar/dist/index.js"],
      "env": {
        "GRAPHNOSIS_VAULT": "/Users/you/Graphnosis",
        "GRAPHNOSIS_PASSPHRASE": "your-passphrase",
        "GRAPHNOSIS_DEFAULT_GRAPH": "personal",
        "GRAPHNOSIS_POLICY": "/Users/you/Graphnosis/policy.json",
        "GRAPHNOSIS_LLM": "llama-3.2-3b"
      }
    }
  }
}
```

Optional `policy.json` for per-graph sensitivity tiers:

```json
{
  "graphs": [
    { "graphId": "personal", "tier": "personal" },
    { "graphId": "health",   "tier": "sensitive" },
    { "graphId": "work",     "tier": "public" }
  ]
}
```

After saving, restart Claude Desktop. The MCP server appears as **Graphnosis** in the tool picker with 6 tools.

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `GRAPHNOSIS_VAULT` | Folder where encrypted graphs + op-log + caches live | (required) |
| `GRAPHNOSIS_PASSPHRASE` | Vault passphrase, used for Argon2id key derivation | (required) |
| `GRAPHNOSIS_DEVICE_ID` | Stable device identifier (op-log attribution + sync) | `<hostname>-<pid>` |
| `GRAPHNOSIS_DEFAULT_GRAPH` | Graph ID for `remember` when none specified | `personal` |
| `GRAPHNOSIS_POLICY` | Path to JSON with per-graph sensitivity tiers | (none — defaults apply) |
| `GRAPHNOSIS_LLM` | Which catalog LLM to use for `correct` (`llama-3.2-3b`, `qwen-2.5-3b`, `llama-3.2-1b`) | recommended (`llama-3.2-3b`) |
| `GRAPHNOSIS_EMBED_DISABLE` | Set to `1` to skip local embeddings (TF-IDF only) | unset |
| `GRAPHNOSIS_EMBED_CACHE` | Override the model cache dir for fastembed | `~/Library/Caches/GraphnosisApp/models` |
| `GRAPHNOSIS_IPC_SOCKET` | Override the Unix socket path for Tauri ↔ sidecar IPC | `<vault>/sidecar.sock` |

---

## Security model — short version

- **At-rest encryption**: libsodium `crypto_secretstream_xchacha20poly1305`, key derived from the user's passphrase via Argon2id. Passphrase lives only in the OS keychain after first unlock. Stored `.aikg` files are unreadable without the key — leaked files are inert.
- **Recovery**: a 24-word phrase shown once at setup; can decrypt the data key without the passphrase. (Implementation in [`packages/graphnosis-app-core/src/crypto`](packages/graphnosis-app-core/src/crypto/index.ts) — currently library-side; UI wiring in Tauri shell pending.)
- **AI exposure**: only the federated subgraph chosen for the current prompt, capped by sensitivity tier per graph. Full `.aikg` never leaves the device. Every `recall` returns an audit footer showing per-graph attribution.
- **Local LLM**: corrections run on a bundled small model (default Llama 3.2 3B via Ollama). Never call out to a remote AI for graph mutations.
- **Op-log syncing**: append-only encrypted event log per device. Drive/iCloud syncs the log directory, not the `.aikg` file, so concurrent edits across devices converge without lost data. (Reducer ready in [`packages/graphnosis-app-core/src/oplog`](packages/graphnosis-app-core/src/oplog/index.ts); materializer pass on load pending.)

---

## What's deliberately not here yet

- **Mobile app** (Phase 2 — Capacitor capture + voice).
- **Browser extension** for ChatGPT / Gemini (Phase 3).
- **Op-log merge engine** materialization on load — sketched, not yet wired into `loadGraph`.
- **Ambient capture connectors** (calendar, mail, Slack) — Phase 3, strictly opt-in.
- **Recovery-phrase UI in the Tauri shell** — backend ready, frontend pending.
- **Tauri shell completion** — autostart, global hotkey, Share Sheet receiver, prompt-context inspector all scaffolded but not implemented end-to-end.

See `~/.claude/plans/i-m-imagining-a-desktop-modular-sprout.md` for the full phased roadmap.

---

## License

[Functional Source License, Version 1.1, Apache 2.0 Future License](LICENSE) — `FSL-1.1-Apache-2.0`.

This license lets anyone read, audit, fork, modify, and self-host the code, but prevents commercial "Graphnosis as a service" competitors during the 2-year exclusivity window. After that, each release automatically converts to Apache 2.0.

If you want to use Graphnosis App commercially (hosted, embedded, white-labeled) before that window expires, contact the author about a commercial license.

The Graphnosis engine itself ([`@nehloo/graphnosis`](https://github.com/nehloo/Graphnosis)) is and remains Apache 2.0.
