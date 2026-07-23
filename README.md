# Graphnosis App

**Local, encrypted, deterministic job memory for humans, AI, and local intelligence.**

Graphnosis is a desktop app that stores what you know in an encrypted knowledge graph on your machine, then attaches the right slice of that memory to every prompt you send to any MCP-aware AI — recall, remember, correct, and walk procedural SOPs without pasting context or trusting a cloud.

**[Download Graphnosis](https://graphnosis.com/download)** · **[Docs & guides](https://graphnosis.com/getting-started/overview)** · **[Changelog](https://graphnosis.com/changelog)**

---

## Who it's for

- **Individuals** — researchers, writers, and power users who want AI that actually remembers prior conversations, notes, and files.
- **Developers** — engineers using Cursor, Claude Code, or VS Code who want repo context, decisions, and runbooks in reach via MCP.
- **Teams & business** — ops, customer success, and knowledge workers sharing runbooks and onboarding SOPs without re-pasting them every session.
- **Regulated & air-gapped** — healthcare, legal, defense, and offline environments where memory must stay on-device and auditable.
- **Industries with heavy procedure** — software, manufacturing, clinical workflows, compliance — 100+ free [Job Memory Kits](https://graphnosis.com/job-memory-kits) to start fast.

Full personas, screenshots, and product depth live on **[graphnosis.com](https://graphnosis.com)** — this repo is the app source, not the marketing site.

---

## What you get

- Encrypted cortex on a folder you choose (local disk or synced op-log via iCloud/Drive).
- Federated recall into Claude, Cursor, Zed, Cline, and any MCP client — scoped subgraphs, tier caps, audit footers.
- **Autonomous Skills** — walkable SOPs dispatched each session, self-improving with each run; compile from source, walk step-by-step, export signed `.gsk` packs. ([Reference →](https://graphnosis.com/reference/skills))
- Optional **Foresight** layer (local LLM via Ollama) for enrichment, corrections, and insights — entirely opt-in.
- Connectors (RSS, GitHub, Slack, Linear, Obsidian, webhooks, and more) that feed the graph; credentials stay on-device.

---

## Development

Monorepo: Tauri shell (`apps/desktop`) + Node sidecar (`apps/desktop-sidecar`) + shared core (`packages/graphnosis-app-core`). The Graphnosis engine is [`@nehloo/graphnosis`](https://github.com/nehloo/Graphnosis) (Apache 2.0); sync primitives are [`graphnosis-secure-sync`](https://github.com/nehloo-interactive/graphnosis-secure-sync).

**Prerequisites:** Node 20+, pnpm 10+, Rust (for the desktop shell), and [Bun](https://bun.sh) — the Tauri build compiles the sidecar and MCP relay into standalone binaries via `bun build --compile` (`apps/desktop/src-tauri/build.rs` looks for bun in `~/.bun/bin` and on PATH; without it `pnpm dev:desktop` fails with `resource path binaries/graphnosis-sidecar-… doesn't exist`). Ollama only if you exercise Foresight locally.

### Supply chain & dependency security

- Transitive-dependency fixes are applied explicitly and documented inline in the root `package.json`: `fastembed`'s pinned `tar` is overridden to a patched major (the advisories it carried have no fix on the 6.x line), paired with a patch that keeps `fastembed` working on tar 7; `libsodium-wrappers-sumo`'s broken ESM entry is corrected via `packageExtensions` + patch. See the `_comment_overrides` / `_comment_packageExtensions` keys for the full rationale.
- Generate a CycloneDX SBOM with `pnpm sbom` (writes `sbom.cdx.json`; uses `cdxgen` via npx, no repo dependency).
- Review production license obligations with `pnpm licenses`.

```bash
git clone https://github.com/nehloo-interactive/GraphnosisApp.git
cd GraphnosisApp
pnpm install
pnpm -r build
```

**Smoke test** (encryption → ingest → recall → forget; no Tauri, no LLM):

```bash
pnpm --filter @graphnosis-app/desktop-sidecar smoke
```

**Run desktop dev** (menu-bar app; first compile is slow):

```bash
pnpm dev:desktop
```

**Run sidecar standalone** (MCP wiring):

```bash
GRAPHNOSIS_CORTEX="$HOME/Graphnosis" \
GRAPHNOSIS_PASSPHRASE="dev-passphrase-change-me" \
pnpm dev:sidecar
```

Deeper setup, MCP tool reference, connectors, and security model: **[graphnosis.com/getting-started/overview](https://graphnosis.com/getting-started/overview)** and **[graphnosis.com/reference/mcp-tools](https://graphnosis.com/reference/mcp-tools)**.

### Architecture (compact)

```
Tauri shell (Rust) ── Unix socket JSON-RPC ── Node sidecar (TypeScript)
       │                                              │
       │  menu bar, keychain, Share Sheet             │  GraphnosisHost, ingest, MCP (48 tools)
       │                                              │  Autonomous Skills, connectors, mobile bridge
       └──────────────────────────────────────────────┴── @nehloo/graphnosis SDK
```

---

## License

[Functional Source License 1.1, Apache 2.0 Future License](LICENSE) (`FSL-1.1-Apache-2.0`) — read, audit, fork, and self-host; commercial hosted use requires a separate license during the 2-year window. Each release converts to Apache 2.0 after two years.

Engine: [`@nehloo/graphnosis`](https://github.com/nehloo/Graphnosis) · Sync: [`graphnosis-secure-sync`](https://github.com/nehloo-interactive/graphnosis-secure-sync) — both Apache 2.0.

Made by Nehloo Interactive LLC.
