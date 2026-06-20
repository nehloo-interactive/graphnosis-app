# Pull request: Graphnosis memory + MCP for Hermes Agent

Open against https://github.com/NousResearch/hermes-agent

## Title

feat(memory): Graphnosis local memory provider + MCP catalog entry

## Summary

- Adds `plugins/memory/graphnosis/` — local encrypted memory via `~/.graphnosis/mcp.sock`
- Adds `optional-mcps/graphnosis/manifest.yaml` — `hermes mcp install graphnosis`
- Adds MCP preset `graphnosis` in `hermes_cli/mcp_config.py`
- Tests in `tests/agent/test_graphnosis_memory_provider.py`
- Docs in `website/docs/user-guide/integrations/graphnosis.md` (copy from `docs/graphnosis-integration.md`)

## Depends on

npm package `@graphnosis/mcp-relay` (published from GraphnosisApp `packages/graphnosis-mcp-relay`)

## Test plan

- [ ] `pytest tests/agent/test_graphnosis_memory_provider.py`
- [ ] Graphnosis running → `hermes memory setup` lists graphnosis
- [ ] `hermes mcp catalog | grep graphnosis`
- [ ] `hermes graphnosis status` when provider active
