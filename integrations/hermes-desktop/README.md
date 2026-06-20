# Graphnosis integration for Hermes Desktop

PR-ready patches for [fathah/hermes-desktop](https://github.com/fathah/hermes-desktop).

## Apply

```bash
DESKTOP=/path/to/hermes-desktop

# Memory provider copy + download link
patch -d "$DESKTOP" -p1 < patches/memory-graphnosis-i18n.patch
patch -d "$DESKTOP" -p1 < patches/MemoryProviders-graphnosis.patch

# Discover → MCPs: bundled Graphnosis catalog install (hermes mcp install graphnosis)
patch -d "$DESKTOP" -p1 < patches/graphnosis-mcp-discover.patch

# Capabilities → MCP Servers: install card + Graphnosis download
patch -d "$DESKTOP" -p1 < patches/tools-graphnosis-mcp-card.patch

# Welcome / Get Connected onboarding card
patch -d "$DESKTOP" -p1 < patches/welcome-graphnosis-onboarding.patch

# Shared styles for welcome + tools promo cards
patch -d "$DESKTOP" -p1 < patches/graphnosis-ui-styles.patch
```

Memory providers are discovered from Hermes Agent at runtime — once the Graphnosis memory provider ships in hermes-agent, it appears automatically. These patches add UI copy, MCP install surfaces, and a download link.

## Depends on

- [hermes-agent Graphnosis PR](../hermes-agent/PR.md) — `optional-mcps/graphnosis` + memory provider plugin
