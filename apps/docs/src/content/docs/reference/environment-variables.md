---
title: Environment Variables
description: All environment variables read by the Graphnosis sidecar.
sidebar:
  order: 2
---

The Graphnosis sidecar (`graphnosis-sidecar`) reads its configuration from environment variables.

**In normal use you do not set any of these.** The Graphnosis desktop app sets them automatically each time it spawns the sidecar for the active cortex. They are documented here for headless / standalone runs and for debugging.

## cortex & unlock

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPHNOSIS_CORTEX` | Yes | — | Absolute path to the cortex folder. The sidecar will not start without it. |
| `GRAPHNOSIS_PASSPHRASE` | No | — | Unlocks the cortex non-interactively. **Use only in trusted environments** — see the security note below. If unset, the app's unlock prompt is used. |
| `GRAPHNOSIS_RECOVERY_PHRASE` | No | — | The 24-word recovery phrase, as an alternative to `GRAPHNOSIS_PASSPHRASE` for unlocking. |
| `GRAPHNOSIS_DEVICE_ID` | No | `<hostname>-<pid>` | Identifier recorded in the op-log for changes made from this device. |
| `GRAPHNOSIS_DEFAULT_GRAPH` | No | `personal` | The engram an ambient `remember` writes to when no target engram is given. |
| `GRAPHNOSIS_POLICY` | No | — | Path to a JSON file defining per-engram sensitivity tiers. Without it, all engrams use default policy. |

## Local LLM

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPHNOSIS_LLM` | No | — | The local LLM model id the sidecar should load (e.g. `llama-3.2-3b`). The optional Local LLM powers `develop` / `predict` / `insights` and the LLM-assisted `edit` path. When unset, no model id is pre-selected. |

## Embedding

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPHNOSIS_EMBED_WORKERS` | No | `2` | Number of parallel embedding worker processes. Raise it on machines with more cores to speed up ingest. |
| `GRAPHNOSIS_EMBED_CACHE` | No | platform cache dir | Directory for the embedding cache. |
| `GRAPHNOSIS_EMBED_CACHE_DIR` | No | `$HOME` | Directory an embedding worker process uses for its model / tokenizer cache. |
| `GRAPHNOSIS_EMBED_DISABLE` | No | — | Set to `1` to disable on-device embeddings entirely. Debugging only — recall quality degrades sharply without embeddings. |

## Sockets

The sidecar communicates over Unix domain sockets. The app assigns these paths; override them only for unusual multi-instance setups.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPHNOSIS_MCP_SOCKET` | No | `~/.graphnosis/mcp.sock` | Unix socket the MCP server listens on. The app sets this to a fixed per-user path so an MCP client configured once keeps working across cortex switches. Falls back to `<cortex>/mcp.sock` when unset. |
| `GRAPHNOSIS_IPC_SOCKET` | No | `<cortex>/sidecar.sock` | Unix socket for desktop-app ↔ sidecar IPC. |
| `GRAPHNOSIS_EVENTS_SOCKET` | No | `<cortex>/events.sock` | Unix socket the sidecar emits live events on. |

## MCP relay

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPHNOSIS_RELAY_WAIT_MS` | No | built-in | Initial wait, in milliseconds, before the MCP relay first connects. |
| `GRAPHNOSIS_RELAY_RECONNECT_MS` | No | built-in | Interval, in milliseconds, between MCP relay reconnection attempts. |

## Internal

`GRAPHNOSIS_WORKER_ROLE` is set by the sidecar on itself when it forks an embedding worker process. Do not set it manually.

## Example: running the sidecar standalone

```sh
GRAPHNOSIS_CORTEX="/Users/you/Documents/MyCortex" \
GRAPHNOSIS_PASSPHRASE="your-passphrase" \
graphnosis-sidecar
```

## Security note on `GRAPHNOSIS_PASSPHRASE`

Passing your passphrase as an environment variable means it may be visible in process listings (`ps aux`) and in any config file that holds it on disk. Only use it on a machine you control, with software you trust. For interactive use, leave it unset and unlock through the app's prompt instead.

---

## Related

[Boot & Engram Loading](/guides/boot-and-engram-loading/) — how these variables shape startup.

[Graphs & Sensitivity Tiers](/guides/graphs-and-tiers/) — what `GRAPHNOSIS_GRAPHS` actually scopes.

[What Leaves Your Device](/guides/network-activity/) — relevant when you enable the HTTP MCP bridge.

[File Formats](/reference/file-formats/) — the files these paths point at.

