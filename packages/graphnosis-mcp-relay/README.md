# @graphnosis/mcp-relay

Stdio ↔ Unix socket relay for Graphnosis MCP. Works with **any MCP client that uses stdio transport** — Hermes, Cursor, Claude Desktop, Claude Code, Zed, Cline, Continue, and custom agents.

## Prerequisites

- [Graphnosis](https://graphnosis.com/download) running with cortex unlocked
- Socket at `~/.graphnosis/mcp.sock` (default)

## Usage

```bash
npx --yes @graphnosis/mcp-relay ~/.graphnosis/mcp.sock
```

If you see `sh: graphnosis-mcp-relay: command not found`, clear stale npx cache and retry:

```bash
rm -rf ~/.npm/_npx
npx --yes @graphnosis/mcp-relay@latest ~/.graphnosis/mcp.sock
```

Or install once and call the bin directly:

```bash
npm install @graphnosis/mcp-relay
./node_modules/.bin/graphnosis-mcp-relay ~/.graphnosis/mcp.sock
```

Hermes catalog entry:

```yaml
mcp_servers:
  graphnosis:
    command: npx
    args: ["-y", "@graphnosis/mcp-relay", "${HOME}/.graphnosis/mcp.sock"]
```

## Environment

| Variable | Purpose |
|----------|---------|
| `GRAPHNOSIS_RELAY_WAIT_MS` | Initial socket wait (default 10s) |
| `GRAPHNOSIS_RELAY_RECONNECT_MS` | Reconnect wait (default unbounded) |

Same behavior as the relay shipped inside Graphnosis.app.

## Other MCP clients

```json
{
  "mcpServers": {
    "Graphnosis": {
      "command": "npx",
      "args": ["-y", "@graphnosis/mcp-relay", "/Users/you/.graphnosis/mcp.sock"]
    }
  }
}
```

Cursor / Claude users can also use the relay binary bundled in Graphnosis.app (no Node required). See [Connect Your AI](https://graphnosis.com/getting-started/connect-ai).
