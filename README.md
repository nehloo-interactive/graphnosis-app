# Graphnosis

> Private second memory for any AI. Local-first, encrypted, multi-graph.
> Attaches a relevant subgraph from your own memory to every prompt you send
> to any MCP-aware AI — no effort, no API keys, no AI literacy required.

**Product name:** Graphnosis · **Domain:** [graphnosis.com](https://graphnosis.com) (primary) · [graphnosis.app](https://graphnosis.app) (downloads) · [graphnosis.org](https://graphnosis.org) (OSS) · [graphnosis.ai](https://graphnosis.ai) (reserved)
**Repo:** Graphnosis App (this monorepo) · **Engine:** [`@nehloo/graphnosis`](https://www.npmjs.com/package/@nehloo/graphnosis) · **Sync primitives:** [`graphnosis-secure-sync`](https://github.com/nehloo-interactive/graphnosis-secure-sync)

---

## Status

**v1.15.0** — Memory-trained Skills + MCP tool exposure control. See the [changelog](https://graphnosis.com/changelog) for what's new and the [docs](https://graphnosis.com/getting-started/overview) for the full picture.

Source is available under the [Functional Source License 1.1 (FSL-1.1-Apache-2.0)](LICENSE) — so users can verify the privacy promises and the community can audit and contribute. The license converts to Apache 2.0 two years after each release.

The underlying engine, [`@nehloo/graphnosis`](https://github.com/nehloo/Graphnosis), is already open source under Apache 2.0. The sync primitives layer, [`graphnosis-secure-sync`](https://github.com/nehloo-interactive/graphnosis-secure-sync), is likewise open source.

---

## What it does

1. You pick a folder (local or iCloud/Drive) where your encrypted memory lives.
2. You feed it things worth remembering:
   - **Files** from Finder (in place — files stay where they are)
   - **Web pages or selected text** via Share Sheet / global hotkey
   - **AI conversation notes** via "remember this" inside Claude / Cursor / Claude Code
   - **Cloud tools automatically** via built-in connectors (RSS, GitHub, Slack, Linear, Trello, Obsidian, webhooks — [full list →](https://graphnosis.com/guides/connectors))
3. Anytime you talk to an MCP-aware AI, a relevant federated subgraph from your memory gets attached, within a tight token budget. The AI answers as if it knew you. ([How recall works →](https://graphnosis.com/reference/federated-multi-graphs))
4. You correct it in natural language (*"the trip was September, not August"*). A bundled local LLM produces a structured diff, you confirm, the graph updates — privately, on-device. ([Correcting memories →](https://graphnosis.com/guides/correcting-memories))
5. You build **Memory-trained Skills** — procedural SOPs compiled from your cortex into an 8-goal structure your AI can walk step-by-step, export as signed `.gsk` packs, and roll back to any prior version. 100+ free industry packs available. ([Skills & Autonomous Praxis →](https://graphnosis.com/reference/skills))
6. Optionally, you enable **Foresight** — five independently-toggleable LLM capabilities (recall enrichment, correction parsing, distillation, insights, edge prediction) each opt-in, each running entirely on your machine via Ollama. ([Foresight & determinism →](https://graphnosis.com/guides/indelibility-and-determinism))
7. You control exactly which MCP tools each AI client can see — toggle tools on/off, use presets (Recall-only, Remember-only, Expose all), enforced inside Graphnosis before the AI ever connects. ([MCP tool exposure →](https://graphnosis.com/guides/ai-access-controls))
8. You access your cortex from any device — desktop app, mobile browser (port 3456), or native MCP from Claude for iOS/Android over Tailscale or LAN. ([Mobile & remote access →](https://graphnosis.com/getting-started/mobile))

The full `.gai` files never reach the AI. The AI only ever sees the scoped subgraph relevant to the current prompt — and that subgraph is hard-capped by per-graph **sensitivity tiers** (`public` / `personal` / `sensitive`) that the AI cannot override. ([AI access controls →](https://graphnosis.com/guides/ai-access-controls))

---

## Screenshots

Unlock your cortex with a passphrase or Touch ID, then work across four tabs — daily check-ins, the 3D engram atlas (grab to rotate, ⌘-drag to pan), deterministic consolidation, and the optional non-deterministic Foresight layer. The status bar shows live GLL/GNN overlay activity pills that pulse when an inference engine is running.

![Graphnosis — unlock screen](apps/docs/public/screenshots/01-unlock.png)

| | |
|:--:|:--:|
| ![Check-in tab](apps/docs/public/screenshots/02-check-in.png)<br>**Check-in** — connect lonely memories | ![3D Engram tab](apps/docs/public/screenshots/03-3d-engram.png)<br>**3D Engram Atlas** — explore the whole graph |
| ![Deterministic Consolidation tab](apps/docs/public/screenshots/04-deterministic-consolidation.png)<br>**Deterministic Consolidation** — vitality & memory health | ![Go Non-Deterministic tab](apps/docs/public/screenshots/05-go-non-deterministic.png)<br>**Foresight** — the optional local-AI layer |

And the recall / remember loop, working live with an AI client:

| | |
|:--:|:--:|
| ![Saving a memory from an AI client](apps/docs/public/screenshots/06-remember.png)<br>**remember** — your AI saves a memory; Graphnosis asks which engram first | ![Recalling a memory from an AI client](apps/docs/public/screenshots/07-recall.png)<br>**recall** — any client pulls it back from your encrypted graph |

<sub>Claude is shown to demonstrate the MCP integration. Graphnosis is an independent product, not affiliated with or endorsed by Anthropic.</sub>

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
│  - ingest (file / web / clip); large files chunked for responsiveness      │
│  - Skills (Autonomous Praxis): SOP compile, 8-goal model, .gsk export      │
│  - correction pipeline (local LLM via Ollama → structured diff)            │
│  - local embeddings via fastembed (BGE-small-en-v1.5, ONNX)                │
│    → PDF parsing offloaded to a worker_threads Worker (pure JS, safe)      │
│    → ONNX inference runs in a pool of forked child processes (N-API safe)  │
│  - cloud connectors: RSS, GitHub, Slack, Linear, Trello, Obsidian,         │
│    GBrain, AI Context Files, Webhook — credentials stay on-device          │
│  - mobile HTTP bridge (port 3456 browser UI, port 3457 MCP relay)          │
│    + optional Tailscale integration for remote access                      │
│  - federated query across all user graphs with tier-capped budgets         │
│  - per-tool MCP exposure allowlist (Pro/Teams/Enterprise)                  │
│  - MCP server over stdio: 48 tools in 10 categories                        │
│    (recall, remember, skills, foresight, brain maintenance, …              │
│    see graphnosis.com/reference/mcp-tools)                                 │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Embedding worker pool (forked child processes)                             │
│  - 2 × node embed-worker.js, each with its own fastembed / ONNX session    │
│  - Round-robin dispatch; parent event loop never blocked by inference      │
│  - Pool size: GRAPHNOSIS_EMBED_WORKERS (default 2)                         │
└────────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
              ┌──────────────────────────────────────────┐
              │  @nehloo/graphnosis SDK  (Apache 2.0)    │
              │  graphnosis-secure-sync (Apache 2.0)     │
              └──────────────────────────────────────────┘
```

---

## Repo layout

```
apps/
  desktop/              Tauri app (Rust shell + minimal HTML/JS UI)
  desktop-sidecar/      Node TypeScript sidecar (Graphnosis + MCP + IPC)
    src/
      index.ts          Entry point — boot, IPC, MCP, signal handling
      host.ts           GraphnosisHost wrapper (ingest, ingestChunked, save, recover)
      ingest.ts         File/web/clip ingest; PDF parsed in worker thread
      skill-trainer.ts  Skills (Autonomous Praxis) — SOP compile, .gsk export, rollback
      pdf-parse-worker.ts  worker_threads PDF parser (pdfjs off the main thread)
      local-embed.ts    Fork-based embedding pool (round-robin, 2 workers default)
      embed-worker.ts   Forked child: owns one fastembed / ONNX session
      ipc.ts            Unix-socket JSON-RPC server for Tauri shell
      mcp-server.ts     48 MCP tool definitions in 10 categories
packages/
  graphnosis-app-core/  Crypto, op-log, source index, federation,
                        sensitivity tiers, embeddings cache, policy
```

---

## MCP tools exposed to AI clients

The sidecar exposes **48 tools** across **10 functional categories**. Tool-level exposure is configurable per-client in Settings → MCP Tools (Pro/Teams/Enterprise). The full reference with parameters, return shapes, and example prompts lives at [graphnosis.com/reference/mcp-tools](https://graphnosis.com/reference/mcp-tools).

★ = Pro/Teams/Enterprise only

| Category | Tools |
|---|---|
| **Core memory** (8) | `recall` · `remind` · `dig_deeper` · `remember` · `forget` · `apply` · `stats` · `vitality` |
| **Engram discovery** (5) | `list_engrams` · `suggest_engram` · `browse_engram` · `recent` · `get_engram_schema` |
| **Structured recall** (4) | `recall_structured` · `recall_with_citations` · `compare_engrams` · `cross_search` |
| **Source operations** (3) | `find_source` · `recall_source` · `transfer_source` |
| **Engram operations** (2) | `ingest_batch` · `engram_summary` |
| **Brain maintenance** (5) | `duplicate_pairs` ★ · `contradiction_pairs` ★ · `healing_journal` · `gnn_status` ★ · `confirm_data_access` |
| **Skills / SOPs** (12) | `walk_skill` · `walk_skill_structured` · `get_skill` · `list_skills` · `delete_skill` · `train_skill` ★ · `export_skill` ★ · `rollback_skill` ★ · `skill_history` ★ · `skill_vitality` ★ · `save_skill_run` ★ · `resume_skill_run` ★ |
| **Approximate** (2) | `audit_memory` ★ · `check_duplicate` |
| **Conditional** (1) | `edit` |
| **Foresight** (6) ★ | `develop` · `predict` · `insights` · `gnn_neighbors` · `llm_query` · `llm_distill` |

`recall` has the hardest caps: `maxNodes ≤ 50`, `maxTokens ≤ 8000`, clamped further on sensitive engrams (≤ 5 nodes / 500 tokens). Every recall returns an audit footer showing per-graph attribution.

---

## AI clients that read from your cortex

Any MCP-aware AI client speaks Graphnosis natively — no API keys, no custom plugin. The desktop app ships first-day-supported configuration flows for the most common clients. ([Full setup guide →](https://graphnosis.com/getting-started/connect-ai))

| Client | Status |
|---|---|
| **Claude Desktop** | Supported (macOS + Windows) |
| **Claude Code** | Supported (macOS + Windows) |
| **Cursor** | Supported (macOS + Windows) |
| **VS Code / GitHub Copilot Chat** | Supported via bundled Graphnosis VS Code extension (OAuth) |
| **Zed** | Supported |
| **Cline · Continue.dev** | Supported |
| **Claude for iOS / Android** | Supported via mobile MCP bridge (Tailscale or LAN) |
| **Any MCP-aware tool** | Supported — standard MCP config, point at the relay |
| **ChatGPT · Gemini** | Coming soon (browser extension) |

Every connection sees the same 48 tools above; what each client can actually read is governed by the [six-layer consent system](https://graphnosis.com/guides/ai-access-controls) (silent for personal-tier engrams, one-click in-app modal for sensitive ones, per-tool toggle allowlist for fine-grained control).

---

## Data sources (cloud auto-ingest)

Built-in connectors poll or receive on a schedule and route incoming content into the engram of your choice. All credentials stay on-device, encrypted alongside your cortex. ([Connectors guide →](https://graphnosis.com/guides/connectors))

| Connector | What it pulls | Mode |
|---|---|---|
| **RSS** | Any RSS / Atom feed | Pull, configurable cadence |
| **GitHub** | Issues, PRs, comments, commits, releases | Pull |
| **Slack** | Starred items, channel exports, DMs, threads | Pull |
| **Trello** | Cards, checklists, comments, attachments | Pull |
| **Linear** | Tickets, comments, project updates | Pull |
| **Obsidian** | Watched vault — every note saves as it changes | Watch |
| **GBrain** | Local Git repo of plain-text notes | Watch |
| **AI Context Files** | `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `GEMINI.md`, etc. | Watch |
| **Webhook** | Generic HTTP endpoint — `POST` JSON, becomes a memory | Receive |

Each connector has its own routing UI (target engram, sensitivity tier, schedule). Connectors are **incoming only** — they feed the cortex but never read from it.

---

## Local & offline sources

Graphnosis runs entirely on-device, and so can the data feeding it. Anything that can write to a file or hit an HTTP webhook becomes a source — no API keys, no network round-trip, no data leaving your machine. ([Offline sources guide →](https://graphnosis.com/guides/connect-offline-sources))

| Category | Pattern |
|---|---|
| **Local files & folders** | Drag onto the app, or use the Obsidian / AI Context Files / GBrain connectors |
| **NAS / network drives** | Mount as folder; watch the path |
| **Scanned PDFs / paper records** | Drop the PDF — OCR runs locally, no cloud |
| **Smart-home (Home Assistant, MQTT, Zigbee, Z-Wave)** | Bridge script subscribes to MQTT and POSTs to the Webhook connector |
| **Sensors / IoT / lab instruments / agriculture** | Tiny reader script (serial, USB, network) POSTs to Webhook |
| **Local databases (SQLite, Postgres on LAN, DuckDB)** | Cron-driven export to JSON/CSV + folder watch, or query-and-POST script |
| **On-device notes apps (Apple Notes, Bear, Logseq, Notion local cache)** | App's CLI export → watched folder |
| **Logs (router syslog, security cam DVR, audio recordings)** | Tail script → Webhook; for audio, transcribe locally with whisper.cpp first |
| **Industrial protocols (OPC-UA, Modbus, LoRaWAN)** | Bridge script per protocol → Webhook |

---

## Memory-trained Skills (Autonomous Praxis)

Skills are procedural SOPs compiled from your cortex into a structured graph that any AI client can walk step-by-step. Each skill has 8 goal categories (Success criteria, Prerequisites, Failure handlers, etc.), supports cross-skill orchestration via `@skill:` calls, and ships with a full snapshot history you can roll back to in one click. ([Skills reference →](https://graphnosis.com/reference/skills))

- **Free path** — memory-augmented body, deterministic, attribution preserved
- **Pro path** — optional local-LLM rewrite for prose clarity, same attribution, runs on your machine
- **Export** — signed `.gsk` packs (AES-256-GCM + Ed25519) sharable across teams
- **100+ free packs** — job memory kits across 20+ industries, from software engineering to HIPAA compliance ([browse the library →](https://graphnosis.com/job-memory-kits))

---

## Local development

Prerequisites:
- **Node 20+** (`nvm install 20 && nvm use 20`)
- **pnpm 9+** (`corepack enable && corepack prepare pnpm@9 --activate`)
- **Rust toolchain** (`curl https://sh.rustup.rs -sSf | sh`) — only for the Tauri shell
- **Ollama** + `llama3.2:3b-instruct-q4_K_M` — only for Foresight / `edit` tool

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
GRAPHNOSIS_CORTEX="$HOME/Graphnosis" \
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
        "GRAPHNOSIS_CORTEX": "/Users/you/Graphnosis",
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

After saving, restart Claude Desktop. The MCP server appears as **Graphnosis** in the tool picker with 48 tools.

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `GRAPHNOSIS_CORTEX` | Folder where encrypted graphs + op-log + caches live | (required) |
| `GRAPHNOSIS_PASSPHRASE` | Cortex passphrase, used for Argon2id key derivation | (required) |
| `GRAPHNOSIS_DEVICE_ID` | Stable device identifier (op-log attribution + sync) | `<hostname>-<pid>` |
| `GRAPHNOSIS_DEFAULT_GRAPH` | Graph ID for `remember` when none specified | `personal` |
| `GRAPHNOSIS_POLICY` | Path to JSON with per-graph sensitivity tiers | (none — defaults apply) |
| `GRAPHNOSIS_LLM` | Catalog LLM for Foresight / `edit` (`llama-3.2-3b`, `qwen-2.5-3b`, `llama-3.2-1b`) | `llama-3.2-3b` |
| `GRAPHNOSIS_EMBED_DISABLE` | Set to `1` to skip local embeddings (TF-IDF only) | unset |
| `GRAPHNOSIS_EMBED_CACHE` | Override the model cache dir for fastembed | `~/Library/Caches/GraphnosisApp/models` |
| `GRAPHNOSIS_EMBED_WORKERS` | Number of forked ONNX embedding child processes | `2` |
| `GRAPHNOSIS_IPC_SOCKET` | Override the Unix socket path for Tauri ↔ sidecar IPC | `<cortex>/sidecar.sock` |

---

## Security model — short version

- **At-rest encryption**: libsodium `crypto_secretstream_xchacha20poly1305`, key derived from passphrase via Argon2id. Passphrase lives only in the OS keychain after first unlock. Stored `.gai` files are unreadable without the key — leaked files are inert.
- **Recovery**: a 24-word BIP-39 phrase shown once at setup; decrypts the data key independently of the passphrase. ([Keeping your cortex safe →](https://graphnosis.com/guides/keeping-your-cortex-safe))
- **AI exposure**: only the federated subgraph chosen for the current prompt, capped by sensitivity tier per graph. Full `.gai` never leaves the device. Every `recall` returns an audit footer showing per-graph attribution.
- **Six-layer AI access control**: sensitivity tiers → in-app consent gate → per-session rate limits → session-replay blocker → optional session caps → per-tool MCP exposure allowlist. ([AI access controls →](https://graphnosis.com/guides/ai-access-controls))
- **Local LLM**: Foresight and correction drafts run on a bundled small model (default Llama 3.2 3B via Ollama). Never calls out to a remote AI for graph mutations.
- **Op-log syncing**: append-only encrypted event log per device. Drive/iCloud syncs the log directory, not the `.gai` file, so concurrent edits across devices converge without lost data. (Primitives in [`graphnosis-secure-sync`](https://github.com/nehloo-interactive/graphnosis-secure-sync).)

---

## Privacy

Graphnosis is designed so that your memory never leaves your device. ([What leaves your device →](https://graphnosis.com/guides/network-activity))

- **No cloud sync of memory content.** Your `.gai` graph files are encrypted at rest and never uploaded to Graphnosis — we have no servers. When an AI client recalls a memory, that content travels through the AI client's normal inference path and is subject to its privacy policy. The only other network traffic is connector syncs (RSS, GitHub, etc.) that you explicitly configure, plus optional iCloud/Drive sync of the *encrypted* op-log.
- **AI clients read only what you allow.** Each `recall` returns a scoped subgraph capped by the sensitivity tier of each engram. Sensitive engrams require explicit in-app consent before any AI client can read them. You can further restrict which tools a client can call at all via the MCP tool exposure allowlist.
- **Passphrase stays on-device.** After first unlock, the passphrase is stored in the OS keychain. It is never logged, never sent over the wire, and never visible to any AI client.
- **No telemetry.** The app and the MCP server collect no usage data.

Full details: [graphnosis.com/legal/privacy-policy](https://graphnosis.com/legal/privacy-policy)

---

## Embedding pipeline — why two layers of workers

`onnxruntime-node` is an N-API native addon that calls V8 APIs without holding the V8 isolate lock. Running it inside a `worker_threads` Worker crashes Node with `HandleScope::HandleScope Entering the V8 API without proper locking in place`. To keep the main event loop free during inference, the sidecar uses **forked child processes** instead — each fork has its own V8 isolate and main thread, so the native addon runs safely. The parent dispatches texts round-robin and never blocks.

PDF parsing (`pdfjs-dist` via `unpdf`) is pure JavaScript/WASM and has no lock requirements, so it runs in a **`worker_threads` Worker** (`pdf-parse-worker.ts`). This frees the main thread during the full parse phase of large documents.

For large documents the sidecar uses `ingestChunked()`: pages are embedded in batches separated by event-loop yields, but only a single `SourceRecord` is written at the end. Chunked ingests appear as one source in the UI with the original file path.

---

## What's deliberately not here yet

- **Mobile app** (Phase 2 — Capacitor capture + voice).
- **Browser extension** for ChatGPT / Gemini (Phase 3).
- **Op-log merge materialization on load** — reducer ready in [`graphnosis-secure-sync`](https://github.com/nehloo-interactive/graphnosis-secure-sync); wiring into `loadGraph` pending.
- **Ambient capture connectors** (calendar, mail, full Slack history) — Phase 3, strictly opt-in.
- **Recovery-phrase UI in the Tauri shell** — backend ready, frontend pending.
- **Additional planned connectors** — Notion, Google Drive, Apple Notes/Reminders, Things, Todoist, ChatGPT export, Discord, Telegram.

---

## License

[Functional Source License, Version 1.1, Apache 2.0 Future License](LICENSE) — `FSL-1.1-Apache-2.0`.

This license lets anyone read, audit, fork, modify, and self-host the code, but prevents commercial "Graphnosis as a service" competitors during the 2-year exclusivity window. After that, each release automatically converts to Apache 2.0.

If you want to use Graphnosis App commercially (hosted, embedded, white-labeled) before that window expires, contact the author about a commercial license.

The Graphnosis engine itself ([`@nehloo/graphnosis`](https://github.com/nehloo/Graphnosis)) and the sync primitives ([`graphnosis-secure-sync`](https://github.com/nehloo-interactive/graphnosis-secure-sync)) are and remain Apache 2.0.

---

Made by Nehloo Interactive LLC.
