# Graphnosis App — Project Instructions

## Use Graphnosis for memory

This repo uses Graphnosis as its persistent memory. Follow the imported standing
instructions — recall before answering; save decisions, to-dos, drafts, and open
questions as you work:

@GRAPHNOSIS.md

## Ship cadence: batch, don't drip

**Do not commit, tag, or push after every individual fix.** A small bugfix is
not a release. Stage changes locally; build up a coherent batch; ship when
Nelu explicitly says so.

### Signals that mean "ship now"

Look for one of these exact intents before committing or pushing:
- "ship", "release", "let's commit", "publish"
- "push to GitHub", "push it"
- "tag v0.x", "release v0.x"
- "make a PR", "open a PR"

Anything less specific ("looks good", "great", "fixed it") is **not** a ship
signal. Keep working, keep things buildable, but leave the commit pending.

### When Nelu does say ship

Don't fire off `git commit && git push` mechanically. Do this instead:

1. **Show `git status` and `git diff --stat`** so we agree on what's in scope.
2. **Group changes by concern.** One concern per commit when reasonable.
   "Fix PDF ingest" and "add inspector UI" are different commits, not one
   blob.
3. **Compile a real changelog**, not a one-liner. Each commit message should
   describe:
   - What the user-visible problem was
   - What changed and where
   - Any behavior the user should test or notice
   - Any follow-ups deliberately deferred
4. **Bump versions only when shipping a release**, not on every commit.
   Local commits don't need version bumps. Version bumps happen at the
   moment of `git tag vX.Y.Z`.
5. **Don't tag or trigger publish workflows without explicit confirmation.**
   Even on a ship signal, ask if a tag is wanted unless Nelu named the
   version.
6. **Before EVERY tag, regenerate and commit the bundled docs.** Run
   `node apps/desktop-sidecar/scripts/generate-docs-content.mjs` and commit
   `apps/desktop-sidecar/src/docs-content.generated.ts` if it changed, then
   push. That file is a build-time snapshot of `apps/docs/src/content/docs/`
   compiled into the app binary and ingested **offline** into the
   `graphnosis-docs` engram — there is NO live fetch from the website. If the
   bundle is stale, the release ships outdated docs to users until the next
   version bump re-ingests. Regeneration is deterministic, so a clean tree
   means it's already in sync. (Do the same sanity check for
   `skill-demos.generated.ts`, though that one needs the GSK signing key to
   rebuild.)

### What you can do without asking

- Read the code, run builds, run tests
- Edit files (the work-in-progress lives in the working tree)
- Run smoke tests, inspect logs, verify behavior
- Run `pnpm install`, `pnpm -r build`, `pnpm --filter ... smoke`
- Investigate errors, fix them, leave the fixes uncommitted until Nelu says
  ship

### What needs explicit confirmation

- `git commit`
- `git push`
- `git tag` of any kind
- `npm publish` (or anything that triggers the publish workflow — including
  `git push origin v*`)
- `gh release create`
- Destructive git operations (`reset --hard`, `push --force`, branch deletion)
- Any operation that modifies the npm registry or GitHub Releases

### Useful patterns when batching is in effect

- Keep a running list (in TodoWrite) of what's been changed since the last
  ship signal — makes the eventual commit message easy to compile.
- After each meaningful fix, briefly summarize what changed and that it's
  pending the next ship. Don't make Nelu ask "what's pending?"
- If a fix introduces a behavior change worth flagging in release notes,
  note it explicitly so the eventual ship has the material it needs.

## Project layout

Monorepo. Three packages:
- `apps/desktop` — Tauri shell (Rust + vanilla HTML/TS UI)
- `apps/desktop-sidecar` — Node sidecar (TypeScript), runs Graphnosis SDK +
  MCP server + IPC for the Tauri shell
- `packages/graphnosis-app-core` — shared types, crypto, op-log, source
  index, federation, policy, embedding cache

The SDK itself lives in a separate repo: `/Users/nelulazar/Developer/Graphnosis`
(npm: `@nehloo/graphnosis`, Apache-2.0). The App consumes it as a pinned
dependency in `apps/desktop-sidecar/package.json`.

## Test path that always works for the sidecar

```bash
pnpm --filter @graphnosis-app/desktop-sidecar smoke
```

Standalone end-to-end: encryption → ingest → recall → forget. No Tauri, no
Claude, no LLM required. First thing to run after any sidecar change.

## Tauri dev launch

```bash
pnpm dev:desktop
```

Compiles Rust on first run (slow), then incremental. The menu-bar icon
appears at the top of the screen when ready. Sidecar stderr inherits to the
dev terminal — real stack traces show up there.

## Stuff to NOT do

- Don't touch `.env` or any secrets file unless explicitly asked
- Don't change the SDK pin (`@nehloo/graphnosis`) without explicit instruction
- Don't add new runtime dependencies without flagging the cost
- Don't auto-fix linter warnings that aren't blocking the build — they
  often reveal real things
- **Don't change the dark-mode palette** in
  `apps/desktop/src/theme-tokens.css`. The `:root[data-theme="dark"]`
  block AND the `@media (prefers-color-scheme: dark)` auto-fallback block
  are the canonical Graphnosis appearance and are locked. A backup lives
  at `apps/desktop/src/theme-tokens.backup.css`. Light mode is fair game
  for design iteration; dark mode is not. If a real bug forces a dark-mode
  change, get explicit confirmation first.
