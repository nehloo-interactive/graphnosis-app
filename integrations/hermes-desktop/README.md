# Graphnosis integration for Hermes Desktop

PR-ready patches for [fathah/hermes-desktop](https://github.com/fathah/hermes-desktop).

## Apply

```bash
DESKTOP=/path/to/hermes-desktop

# English i18n — provider description + MCP hint
patch -d "$DESKTOP" -p1 < patches/memory-graphnosis-i18n.patch

# Provider website link in Memory screen
patch -d "$DESKTOP" -p1 < patches/MemoryProviders-graphnosis.patch
```

Memory providers are discovered from Hermes Agent at runtime — once the Graphnosis memory provider ships in hermes-agent, it appears automatically. These patches add UI copy and a website link.

## Optional follow-up

- Tools/Discover screen: surface `hermes mcp install graphnosis` when catalog merges upstream
- Get Connected onboarding card linking to graphnosis.com/download
