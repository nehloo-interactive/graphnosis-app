# Pull request: Graphnosis UI for Hermes Desktop

Open against https://github.com/fathah/hermes-desktop

## Title

feat(memory): Graphnosis provider, MCP install surfaces, and onboarding

## Summary

- English i18n description for `graphnosis` memory provider
- Website link to graphnosis.com/download on Memory providers screen
- **Capabilities → MCP Servers:** Graphnosis install promo (`hermes mcp install graphnosis`) + app download link
- **Discover → MCPs:** bundled Graphnosis catalog entry when `optional-mcps/graphnosis` exists in hermes-agent
- **Welcome:** Get Connected onboarding card linking to graphnosis.com/download

Apply patches from `patches/` or copy changes from this bundle.

Memory provider discovery is automatic once hermes-agent merges the Graphnosis plugin.

## Depends on

- hermes-agent optional-mcps/graphnosis manifest (GraphnosisApp `integrations/hermes-agent/`)

## Test plan

- [ ] Memory screen shows Graphnosis card when hermes-agent plugin is installed
- [ ] External link opens graphnosis.com/download
- [ ] Capabilities → MCP shows Graphnosis promo when `graphnosis` server not installed; Install runs `hermes mcp install graphnosis`
- [ ] Discover → MCPs lists Graphnosis when optional-mcps manifest present
- [ ] Welcome screen shows Graphnosis onboarding card with download link
