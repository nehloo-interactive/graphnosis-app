---
title: What Leaves Your Device
description: A complete inventory of every network request Graphnosis makes — when, where, why, and what data is involved. Nothing is hidden.
sidebar:
  order: 6
---

Graphnosis is built on a single principle: your memory lives on your machine, not on a server. This page backs that claim with specifics — a full accounting of every network request the app makes, automatic or manual, so you can evaluate it yourself rather than taking it on faith.

The short version: **no telemetry, no cloud sync, no AI API calls, no analytics, no crash reporting.** The only automatic outbound request is an update check to GitHub on startup. Everything else is either something you explicitly configured or a link you clicked.

---

## What never leaves your device

Before the full inventory, the clear negatives — categories that might reasonably be expected in a modern app but are not present here:

| Category | Status |
|---|---|
| Telemetry / usage analytics | **None.** No Mixpanel, Amplitude, Segment, or equivalent. |
| Crash reporting | **None.** No Sentry, Bugsnag, or equivalent. Crashes stay on your machine. |
| Cloud LLM API calls | **None.** No calls to OpenAI, Anthropic, Google, or any hosted model. The optional AI layer uses a local Ollama instance, entirely on your device. |
| Cloud sync or backup | **None.** Your cortex files never leave your machine over the network. Sync to another device is manual (copy the cortex folder) or via your own setup. |
| Calls to Graphnosis / Nehloo servers | **None.** There is no Graphnosis cloud backend. No memory is uploaded, no usage is reported, no server is consulted. |
| User identity tracking | **None.** The app has no account, no login, and no way to identify who is using it. |

You can verify the last point the blunt way: **disconnect from the network entirely.** Recall, ingest, correction, the 3D atlas, the brain engine — everything works offline. None of the core functions need a network because none of them talk to a server.

---

## Automatic network activity

These requests happen without any action from you.

### Update check on startup

- **When:** 15 seconds after the app finishes starting up. Release builds only — not in development.
- **Where:** `https://github.com/nehloo-interactive/graphnosis-app/releases/latest/download/latest.json`
- **What is sent:** A plain HTTP GET. No user data, no identifiers, no cortex content. GitHub's server sees your IP address and a standard `User-Agent` string from the Tauri updater library.
- **What is received:** A small JSON manifest listing the latest version number and download URLs.
- **What happens next:** If your installed version is already current, nothing. If a newer version is available, the app shows a banner — you choose whether to install.
- **Signature verification:** Before any binary is applied, the update is verified against a hardcoded public key (`minisign`) that ships in the app. A tampered binary will not install.

**Can you disable it?** There is no Settings toggle for the update check today. If you want to skip it entirely, you can block the domain in a firewall (e.g. Little Snitch) or monitor for updates manually at [the releases page](https://github.com/nehloo-interactive/graphnosis-app/releases).

### Embedding model download (first run only)

- **When:** The very first time you run the app, if the embedding model is not already present on disk.
- **Where:** Hugging Face model hub — the BGE-small-en-v1.5 model used for semantic search.
- **What is sent:** An HTTP GET to fetch the model files. No user data.
- **What is received:** The ONNX model weights, cached to your local app data directory.
- **After the first run:** Never downloaded again. The model lives on disk and is loaded locally for every recall and ingest operation from that point on.

---

## Connector-driven network activity

Connectors are the integration layer that pulls content from external services into your cortex. They are entirely **opt-in** — if you have not set one up, none of this applies to you.

When you configure a connector, it pulls data from that service on a schedule you control. It reads; it never writes back to the service. Everything pulled is ingested into your local, encrypted cortex.

### GitHub connector

- **Destination:** `https://api.github.com` — issues, pull requests, releases, commits, review comments, CI run results
- **Auth:** Your personal access token, stored encrypted in your cortex
- **Token scope:** Whatever scope you granted when you created the token. Graphnosis reads only; it never creates, edits, or deletes GitHub data.
- **Risk note:** If your token has a broad scope (e.g. `repo` on all repos), the connector can read all of those repos. Grant the minimum scope needed.

### Slack connector

- **Destination:** `https://slack.com/api/stars.list` and `https://slack.com/api/conversations.history`
- **Auth:** An OAuth user token (`xoxp-...`) obtained through the Slack OAuth flow, stored encrypted in your cortex
- **What it reads:** Your starred items and channel message history, within the token's scope
- **Risk note:** The Slack OAuth flow runs between your browser and Slack's servers. Graphnosis never sees your Slack password — only the resulting token.

### Linear connector

- **Destination:** `https://api.linear.app/graphql` — issues, projects, cycles, team metadata
- **Auth:** A Linear API key, stored encrypted in your cortex
- **What it reads:** Issues and project data in your workspace

### Trello connector

- **Destination:** `https://api.trello.com/1` — boards, cards, checklists
- **Auth:** A Trello API key and user token, stored encrypted in your cortex
- **Risk note:** Trello's API design places credentials in URL query parameters (`?key=...&token=...`). These appear in Trello's server logs and any proxy logs. This is Trello's own API convention, not a Graphnosis decision. Treat your Trello token as long-lived; rotate it via Trello's developer settings if you suspect exposure.

### RSS / Atom connector

- **Destination:** Feed URLs you configure (any URL)
- **What it sends:** An HTTP GET with `User-Agent: GraphnosisApp/1.0 RSS reader (+local)`
- **Risk note:** The server hosting each feed sees your IP address and the Graphnosis User-Agent string. This is true of any RSS reader.

---

## User-initiated network activity

These requests happen only when you explicitly trigger them.

### URL ingest

When you paste a URL into Graphnosis to ingest a web page:

- **What is sent:** An HTTP GET to that URL, with `User-Agent: GraphnosisApp/0.0.1 (+local)`
- **Risk note:** The target server sees your IP address. Ingesting a URL is not anonymous — the destination knows the request came from somewhere.

### External links

Various help links, documentation links, and download buttons in Settings open URLs in your default browser. Examples:

- `https://docs.graphnosis.com` — documentation
- `https://github.com/nehloo-interactive/graphnosis-app/issues` — bug reports
- `https://ollama.com/download` — Ollama installer page
- `https://tailscale.com/download` — Tailscale VPN setup
- VS Code Extension Marketplace listing

These use Tauri's `open_url` command, which hands the URL to your OS to open. Graphnosis does not make the network request itself; your browser does, in the normal way.

---

## Local-only network activity

These look like network connections but never reach the Internet.

### Ollama (local LLM)

If you have Ollama installed and enabled in Graphnosis → Go Non-Deterministic → Local LLM, the sidecar communicates with it at:

- `http://127.0.0.1:11434/api/chat` — text completion
- `http://127.0.0.1:11434/api/tags` — health check / model list

This is loopback only. Your prompts and cortex context go to a model running on your own machine, processed locally, never sent over the network.

**Ollama's own telemetry:** Graphnosis controls only what it sends to Ollama. Whether Ollama itself reports anything to its own servers is governed by Ollama's settings — check Ollama's privacy configuration independently if this matters to you.

### HTTP MCP bridge (optional)

When enabled, Graphnosis listens on `http://127.0.0.1:3457` to expose a subset of MCP tools to mobile clients and browser-based AI tools. This port binds to loopback (`127.0.0.1`) only — it is not reachable from other machines on your network unless you deliberately tunnel it (e.g. via Tailscale or ngrok). Access requires a bearer token generated when you enable the bridge.

### Webhook server (optional)

When connectors are configured, a small HTTP server listens on `http://127.0.0.1:3458` to accept inbound pushes from automation tools like Zapier or n8n. Same loopback binding. Each webhook endpoint has its own randomly-generated token.

### Tauri IPC (desktop ↔ sidecar)

All communication between the Graphnosis desktop shell (Rust/Tauri) and the Node sidecar goes through a Unix socket on macOS/Linux, or a TCP connection to `127.0.0.1` on Windows. This is process-to-process communication on the same machine — no packets leave the device.

---

## How credentials are stored

Every connector token and API key you configure — Slack, GitHub, Linear, Trello — is stored encrypted inside your cortex, using the same XChaCha20-Poly1305 encryption with Argon2id key derivation that protects all your memory. They are not written to a plaintext config file, not stored in environment variables, and not uploaded anywhere.

The practical implication: if an attacker gains filesystem access to your cortex directory but does not know your passphrase, the credentials remain inaccessible. See [Keeping Your Cortex Safe](/guides/keeping-your-cortex-safe/) for the full encryption model.

---

## Summary

| Request | Automatic? | Data sent | To |
|---|---|---|---|
| Update check | Yes — 15s after startup | Nothing (IP only, from HTTP GET) | github.com |
| Embedding model download | Once, on first run | Nothing | Hugging Face |
| GitHub connector pull | On schedule you set | Nothing (reads only) | api.github.com |
| Slack connector pull | On schedule you set | Nothing (reads only) | slack.com |
| Linear connector pull | On schedule you set | Nothing (reads only) | api.linear.app |
| Trello connector pull | On schedule you set | Nothing (reads only) | api.trello.com |
| RSS feed fetch | On schedule you set | Nothing (reads only) | your configured feeds |
| URL ingest | When you paste a URL | Nothing (reads only) | the URL's host |
| External link opens | When you click a link | Nothing (browser handles it) | various |
| Ollama queries | When LLM features used | Prompt + context | 127.0.0.1 only |
| HTTP MCP bridge | When enabled | Nothing outbound | listens on 127.0.0.1 |
| Webhook server | When connectors enabled | Nothing outbound | listens on 127.0.0.1 |

---

## Verify this yourself

The claims on this page are verifiable, not just asserted:

- **Watch the network live** using Little Snitch, the macOS Activity Monitor → Network tab, or `lsof -i` in a terminal. You will see exactly the connections described here and nothing else.
- **Read the source code.** The app is source-available under FSL-1.1. The relevant files are `apps/desktop-sidecar/src/connectors/`, `apps/desktop/src-tauri/src/lib.rs` (update check), and `apps/desktop-sidecar/src/local-embed.ts` (embedding model).

See [Verify It Yourself](/guides/verify-it-yourself/) for a walkthrough of how to independently confirm these claims.

---

## Related

[Verify It Yourself](/guides/verify-it-yourself/) — the hands-on companion: how to watch every connection in real time.

[AI Access Controls](/guides/ai-access-controls/) — the consent layer above the network layer.

[Auto-ingest from Your Tools](/guides/connectors/) — which connectors hit which hosts, and when.

[Connect Offline Sources](/guides/connect-offline-sources/) — sources that never touch the network.

[Using Graphnosis with AI Clients](/legal/third-party-ai/) — what the AI provider sees on the other side.

