---
title: Environment Variables
description: All environment variables supported by the Graphnosis sidecar.
sidebar:
  order: 2
---

These variables are read by the Graphnosis sidecar (`graphnosis-sidecar`). Set them in the `env` block of your MCP client config, or in your shell environment when running the sidecar directly.

## Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPHNOSIS_CORTEX_PATH` | Yes | — | Absolute path to the Cortex folder. The sidecar will not start without this. |
| `GRAPHNOSIS_PASSPHRASE` | No | — | Unlock the Cortex non-interactively. **Use only in trusted environments.** If not set, the app prompts the user via the menu bar UI. |
| `GRAPHNOSIS_GRAPHS` | No | all graphs | Comma-separated list of graph names to expose via MCP. Unlisted graphs are invisible to AI clients. Example: `work,research`. |

## Embedding

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPHNOSIS_EMBED_CONCURRENCY` | No | `2` | Number of concurrent embedding worker processes. Increase on machines with more cores to speed up ingest. |
| `GRAPHNOSIS_EMBED_MODEL_DIR` | No | `<cortex>/models` | Override the directory where the ONNX embedding model is stored. Useful if you want to share the model cache across multiple Cortexes. |

## MCP server

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPHNOSIS_MCP_TRANSPORT` | No | `stdio` | Transport to use. Accepted values: `stdio`, `unix`. Use `unix` to listen on a Unix socket instead of stdio. |
| `GRAPHNOSIS_MCP_SOCKET` | No | `~/.graphnosis/mcp.sock` | Path for the Unix socket. Only used when `GRAPHNOSIS_MCP_TRANSPORT=unix`. |

## Corrections (Ollama)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPHNOSIS_OLLAMA_URL` | No | `http://localhost:11434` | Base URL for the Ollama API. Override if Ollama is running on a different port or host. |
| `GRAPHNOSIS_OLLAMA_MODEL` | No | `llama3.2:3b-instruct-q4_K_M` | Ollama model to use for the correction diff flow. Must be pulled before use. |

## Logging

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRAPHNOSIS_LOG_LEVEL` | No | `info` | Log verbosity. Accepted values: `error`, `warn`, `info`, `debug`, `trace`. |
| `GRAPHNOSIS_LOG_FILE` | No | stderr | Absolute path to write log output. If not set, logs go to stderr (visible in the Tauri dev terminal). |

## Example: Claude Desktop config with env vars

```json
{
  "mcpServers": {
    "graphnosis": {
      "command": "/Applications/Graphnosis.app/Contents/MacOS/graphnosis-sidecar",
      "args": ["--mcp-stdio"],
      "env": {
        "GRAPHNOSIS_CORTEX_PATH": "/Users/you/Documents/MyCortex",
        "GRAPHNOSIS_GRAPHS": "work,research",
        "GRAPHNOSIS_LOG_LEVEL": "warn"
      }
    }
  }
}
```

## Security note on `GRAPHNOSIS_PASSPHRASE`

Passing your passphrase as an environment variable means it may be visible in process listings (`ps aux`) and in the MCP client config file on disk. Only use this in environments where you control the machine and trust the software reading the config. For interactive use, leave this variable unset and use the app's unlock prompt instead.
