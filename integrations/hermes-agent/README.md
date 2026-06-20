# Graphnosis integration for Hermes Agent

PR-ready artifacts to merge into [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).

## Apply

```bash
HERMES=/path/to/hermes-agent
cp -R plugins/memory/graphnosis "$HERMES/plugins/memory/"
cp optional-mcps/graphnosis/manifest.yaml "$HERMES/optional-mcps/graphnosis/"
cp tests/agent/test_graphnosis_memory_provider.py "$HERMES/tests/agent/"
patch -d "$HERMES" -p1 < patches/mcp_config_graphnosis_preset.patch
```

Add a Graphnosis section to `website/docs/user-guide/features/memory-providers.md` (see `docs/memory-providers-snippet.md`).

Add `website/docs/user-guide/integrations/graphnosis.md` from `docs/graphnosis-integration.md`.

## Verify

```bash
pytest tests/agent/test_graphnosis_memory_provider.py -q
hermes memory setup   # graphnosis should appear when socket exists
hermes mcp catalog | grep graphnosis
```
