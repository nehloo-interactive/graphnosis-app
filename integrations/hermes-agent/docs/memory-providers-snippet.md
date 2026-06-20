### Graphnosis

Local encrypted engram graph — recall, remember, auto-prefetch. Requires the [Graphnosis](https://graphnosis.com/download) app running with cortex unlocked. No API key.

| Best for | Personal encrypted memory, cross-session recall, engram routing |
| --- | --- |
| Requires | Graphnosis desktop app |
| Data storage | Local encrypted cortex on your machine |
| Cost | Free (Graphnosis app) |

Tools (3): `graphnosis_recall`, `graphnosis_remember`, `graphnosis_stats`

Also install the MCP catalog for the full tool surface (`edit`, `forget`, `cross_search`, skills):

```bash
hermes mcp install graphnosis
```

Setup:

```bash
hermes memory setup    # select "graphnosis"
hermes graphnosis status
```

Config: `$HERMES_HOME/graphnosis.json` (`socket_path`, `default_engram`, `prefetch_max_tokens`).

See [Graphnosis + Hermes integration](https://graphnosis.com/getting-started/connect-ai#hermes-agent).
