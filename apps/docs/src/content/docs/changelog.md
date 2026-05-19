---
title: Changelog
description: Public summary of changes to the Graphnosis app, version by version.
sidebar:
  order: 99
---

What changed in each release, in user-facing terms. Internal refactors and dev-only cleanups aren't listed.

Conventions: **Added** = new features, **Changed** = behavior or UX shifts, **Fixed** = bugs, **Security** = anything affecting your data, **Migrations** = automatic upgrades the app applies to existing Cortexes.

---

## v0.5 — More AI clients, smarter remember, background notifications

Theme: **let any AI client confidently target a specific engram, and tell you when the app's in the background**. Plus a broader AI-client expansion beyond Claude Desktop, and ingest performance you can dial in.

### Added

- **Claude Code (CLI) and Cursor support** alongside Claude Desktop. The "Connect an AI client" modal in the menu-bar tray now writes the correct config for all three. Settings → AI Clients lets you re-run the configuration for any of them at any time. All three use the same stdio MCP transport against the bundled sidecar binary — same Cortex, same memory, three faces.
- **`target_engram` parameter on `remember`.** An AI client can now say "save this to my `book-notes` engram" instead of dumping into the default. Graphnosis resolves the name with a normalized exact match, then a dependency-free fuzzy matcher (substring containment + token-set Jaccard + Levenshtein) and surfaces one of three outcomes:
  - **Exact match** → write immediately.
  - **Close matches** → a banner top-center in the app lists ranked candidates with match reasons (`contains your text · 90%`, `same words · 100%`, `close spelling · 75%`). You pick which existing engram to use or create a new one with the AI's suggested name.
  - **No match** → banner offers "Create new" only. **The AI never auto-creates an engram or silently disambiguates** — every new engram is a human-confirmed decision.
- **One-click create-and-save from the banner.** Click "Create engram & save" and the app creates the engram (template: personal, your suggested display name) AND ingests the note in one gesture. Top-bar engram dropdown refreshes immediately so the new engram is selectable everywhere.
- **Background notifications for AI-driven confirmations.** When the menu-bar panel is collapsed or another app is on top, the app fires a native macOS notification for events that need your attention: `engram-create-suggested` (an AI wants to save into a new engram) and `correction-proposed` (an AI proposed a `correct` diff). Foreground stays silent — the in-app banner is the only signal so you're never double-notified. Permission requested lazily on first event.
- **Ingest performance presets** in Settings → AI Settings. Chunk size (`fine` 300 chars / `balanced` 500 / `coarse` 2500) and embed batch (`small` 64 / `medium` 256 / `large` 1024 / `auto` based on total RAM). Lets you trade ingest speed against recall granularity without touching env vars.
- **Pluggable 3D engine architecture.** The 3D Engram view now boots through an engine-selector with three implementations: deck.gl (default), three.js + custom physics worker, and three.js + force-graph-3d. Settings → AI Settings → Visualization lets you switch engines live. Default is deck.gl for stability across large graphs; three.js variants are available for engagement experiments.
- **Right sidebar memory inspector.** Click any node in 3D Engram or any row in Sources / Recall to open a sticky right-side detail pane: full text, source, neighbors, "How are these connected?" picker, +Connect candidates with sticky Connect/Cancel buttons at the bottom.
- **Check-in deck redesign.** The daily check-in panel got a denser, less cluttered layout — 10 inline "Connect as" buttons (was 6), turquoise tagline, mustard-gold inline content, grayed-out non-interactive chips, single-click Forget confirm.
- **AI-conversation source kind on the Sources list.** When an AI calls `remember` with `kind: 'ai-conversation'`, the Sources list shows a distinct icon so you can tell "the AI paraphrased our conversation" from "the AI saw this in a doc I shared". (Schema was added in v0.4; the UI distinction landed in v0.5.)

### Changed

- **`remember` MCP tool parameters.** Renamed `graph` → `graphId`, removed `tags` (never wired through), added `kind` and `label`. See [MCP Tools reference](/reference/mcp-tools/) for the current shape.
- **Synapse copy across the app.** "this App's Synapse" / "this App's running Synapse" → "Graphnosis Synapse" everywhere it appeared (configure-client modal, tour, status text). The synapse story is now consistent: the synapse is the bridge between your AI client and your Cortex, period.
- **Configure-client modal post-success state.** After a successful Connect, the modal now shows a check + "Done" instead of leaving "Apply" visible (Apply was a stale instruction — there was nothing left to apply).

### Fixed

- **`remember` returned "Ingest produced 0 nodes"** for some markdown inputs. Root cause was in the SDK's `parseMarkdown` — input with no headers returned an empty section list. Three-layer fix: SDK v0.5.1 wraps headerless input in a synthetic section, sidecar adds a symmetric fallback for the kind=markdown → 0-nodes case, MCP `remember` routes short text / long markdown / long headerless text differently.

### Migrations

None. v0.5 is fully backward-compatible with v0.4 Cortexes.

---

## v0.4 — Touch ID, attribution, and a better Check-in

### Added

- **Touch ID unlock (macOS).** Lock screen now shows an "Unlock with Touch ID" button once you've signed in with a passphrase at least once. Powered by a Swift sidecar binary that talks to Apple's LocalAuthentication.framework — the actual unlock still reads your saved passphrase from the macOS Keychain after biometric success. Falls back gracefully on Macs without a Touch ID sensor.
- **AI client attribution on Sources.** When an AI client adds a memory via the `remember` MCP tool, the Sources list shows a small turquoise badge — `via claude-ai`, `via cursor`, etc. — derived from the MCP `initialize` handshake's `clientInfo.name`. User-added sources (drag-drop, paste, file picker) have no badge.
- **`ai-conversation` source kind.** The `remember` MCP tool now accepts an optional `kind: 'clip' | 'ai-conversation'` parameter. AI clients can use `ai-conversation` when saving a turn or summary of the CURRENT conversation, distinct from `clip` for facts extracted from external content. The Sources list surfaces these differently so the user can tell "the AI paraphrased me" from "the AI saw this in a doc I shared".
- **Correction attribution on the op-log.** Every event emitted by `applyCorrection` (addNode, editNode, supersede, deleteNode) now carries `correctedBy` when the correction came through an MCP client. The audit log can show "Claude edited this node" alongside the content + reason.
- **Default cortex path suggestion.** First-time users see `~/Graphnosis-Cortex` pre-filled in the lock-screen folder input — no need to click Choose to pick a path. The folder is created on first unlock if it doesn't exist.

### Changed

- **Check-in card layout overhaul:**
  - Removed the "Choose another memory" search box (redundant with ⌘K and the deck arrows).
  - Bottom action bar now has only **Skip** and **🗑 Forget** (was Looks right / Fix / Skip + an in-card Forget).
  - Forget asks for a single-click confirm: "Forget this memory? It will be soft-deleted (recoverable until Purge)" → Cancel / 🗑 Forget anyway.
  - Inline-text colors: source + candidate memory texts are now mustard gold (`#d4a82c`) to distinguish content from interactive elements.
  - `fact` / `trust 0.90` chips are grayed out so they read as info, not buttons.
  - Funny tagline at the top of each card is now turquoise (matching the seahorse logo) and a touch larger.
  - **Connect as** shows up to 10 inline buttons (was 6), always topped up with generic types (Same topic / Related / Mentioned in / Depends on / Cited in / Builds on / Contradicts).
- **"How are these connected?" picker** (opened from candidate panel's "Other…"):
  - Overlays the right-side memory-trace sidebar instead of dimming the whole screen — you can still see source + candidate while picking.
  - Auto-closes when you click either node text, switch to 3D Engram, click anywhere else on the deck card, or hit Escape.
- **Lock screen title**: "Unlock your private Cortex" → "Unlock your private second cortex of memories:".
- **Last-used cortex path** is now pre-filled and the passphrase field auto-focuses on launch.

### Fixed

- **Dev-server infinite rebuild loop.** Tauri's file watcher was triggering a fresh build every time `build.rs` rewrote the Swift biometric binary. Fixed via `.taurignore` excluding `binaries/` + an mtime guard in `build.rs` that skips swiftc when the binary is already up-to-date.

---

## v0.3 — Recovery, safety, and the synapse story

The big theme: **make data loss require a series of unlikely mistakes, not just one bad day.** Five new safety layers, a real passphrase-rotation flow, and several long-standing UI bugs fixed in the process.

### Added

- **24-word BIP-39 recovery phrase.** Generated locally when you create a new Cortex (or auto-backfilled on first unlock of a pre-v0.3 Cortex). Shown exactly once via a gated lock-screen modal — the unlock → app transition is paused until you acknowledge. See [Recovery](/guides/recovery/).
- **Passphrase change.** Settings → after a recovery-mode unlock, the app offers to set a new passphrase. Instant — only the wrapper file is rewritten; engrams stay encrypted with the same data key. The recovery phrase remains valid.
- **Regenerate recovery phrase.** Settings → Recovery phrase → typed-confirmation flow. Useful if you never saw the original modal, suspect the phrase is exposed, or want periodic rotation.
- **Cortex Management.** Settings → Cortex Tools → red "Cortex Management…" button opens a dedicated modal for every destructive engram operation: forgotten-memories purge, engram archive/delete, quarantined-file restore/delete. Every action gated by typed confirmation.
- **Auto-quarantine.** When Graphnosis detects a corrupt `.gai` at startup (HMAC mismatch, signature failure), it auto-renames the file to `<id>.gai.corrupt-<timestamp>` so the next launch doesn't keep retrying it. The engram becomes "missing" until you recover it from the op-log.
- **Recovery from op-log: live progress + backgroundable.** The "Recover selected" flow now returns immediately, runs in the background, and pushes per-source progress events to the UI. You can close the panel and keep working; a native notification fires when recovery completes. Previously a 60–90-minute PDF re-ingest would time out at 10 minutes with no progress visible.
- **Snapshot offer before destructive ops.** "Save a snapshot first?" prompt now appears before recover-from-op-log and before changing the passphrase. The snapshot now includes `master.enc` and `recovery.enc` — previously these were silently omitted, which would have bricked any restored snapshot.
- **Native macOS notifications** for ingest completion and recovery completion. Permission requested lazily on first event.
- **Two-worker embedding pool.** Embedding work runs in dedicated worker threads instead of the main process, keeping the UI responsive during large ingests (the 4233-page PDF case).
- **Auto-jump to 3D Engram after ingest.** When the last file in a batch finishes successfully and adds at least one node, the UI hops to the 3D Engram view so you immediately see your new memories in the graph.
- **Seahorse / hippocampus / engram brand story.** The seahorse logo is now explained inline: "hippocampus" is Greek for seahorse — the brain region the logo references is exactly the structure Graphnosis embodies in software (encoding, storage, retrieval).
- **Keeping your Cortex safe guide.** New doc consolidating the five safety layers and what to do when things go wrong.

### Changed

- **Settings tab reorganization.** The Preferences modal is now just app-behavior knobs (cache mode, forget behavior, MCP relay, AI client routing). Engrams management, quarantined files, and the "forgotten memories" / purge surface all moved into the new Cortex Management modal. Recovery-phrase regeneration is a top-level Settings tab panel.
- **Tray menu**: "Open inspector…" → "Open Graphnosis…".
- **Unlock screen title**: "Unlock your Graphnosis Cortex folder" → "Unlock your private Cortex". Passphrase field gained an inline warning about the passphrase being the only key + recovery-phrase fallback.
- **Content cache default cap raised** from 50 MB → 512 MB per source. Now covers realistic large reference manuals (e.g. a 4233-page PDF at ~210 MB) without users having to change settings.
- **Tour copy updated** to reference the hippocampus / engram / synapse / seahorse story and to explain that Graphnosis must be running and the Cortex unlocked for AI clients to read memories.
- **Status pane** is now a read-only health snapshot. "Forgotten memories" footer moved to Cortex Management (where every destructive op lives).

### Fixed

- **Tauri 2 event-name silent failure.** Periods aren't allowed in Tauri 2 event names (only `[a-z0-9]`, `-`, `/`, `:`, `_`). The app was emitting `graphnosis://cortex.created`, `graphnosis://ingest.progress`, `graphnosis://ingest.done`, `graphnosis://recovery.progress`, `graphnosis://recovery.done` — all rejected silently. Result: the one-time recovery-phrase modal never showed, ingest progress toasts never updated, recovery progress bars never updated. All five renamed to use hyphens.
- **`.gai` / `.bundle` corruption from interrupted saves.** Pre-v0.3 the app used `fs.writeFile` directly to the canonical path, leaving partial files on process kill (force-quit, OS kill, crash). All saves now go through an atomic-write helper (`tmp → fsync → rename`). POSIX `rename(2)` is atomic — either the old file is intact or the new one is fully written.
- **Large engrams silently disappearing from the picker.** A graph with a 160 MB+ embcache could throw mid-load and never make it into the in-memory engram map. Cache load failures are now non-fatal — the graph is added with an empty cache and embeddings rebuild from scratch.
- **Recovery panel timed out at 600s** even when the sidecar was still working. The Rust → sidecar IPC for `recovery.apply` is now async — returns `{ accepted, jobId }` in 15s; the actual work pushes events.
- **Duplicate `formatBytes` function** declaration broke dev-server HMR.
- **Quarantine timestamps showing 1970.** Display now auto-detects seconds-vs-milliseconds in the filename so manually-quarantined files (with `date +%s` timestamps) render the right date.

### Security

- **Two-tier key model (`master.enc`).** Passphrase no longer directly derives the data key. Argon2id(passphrase, salt) derives a wrap key that decrypts `master.enc`, which holds the actual data key. Industry-standard pattern; makes passphrase rotation an O(1) operation instead of having to re-encrypt every file in the cortex.
- **Recovery phrase wraps the data key, not the passphrase.** The previous documentation said the opposite. The phrase is an independent unlock path: phrase → Argon2id → recovery wrap key → `recovery.enc` → data key. Lose the passphrase, the phrase still works; lose both, no one (including us) can open your Cortex.
- **Atomic writes** close a class of "I unlocked yesterday but today the file is corrupt" scenarios that had no recoverable cause beyond "the save was interrupted."

### Migrations

These run automatically on first unlock of a pre-v0.3 Cortex; no user action required.

1. **`master.enc` written.** Existing Cortexes use the legacy "passphrase = data key" model. On first v0.3 unlock, the app derives the same key, writes `master.enc` wrapping it, and from that point on uses the wrapped-key path. Old code can still open the Cortex until you change the passphrase.
2. **`recovery.enc` generated.** Pre-v0.3 Cortexes had no recovery phrase. The first v0.3 unlock generates a fresh 24-word phrase, wraps the data key, writes `recovery.enc`, and shows the phrase via the one-time lock-screen modal. **Write it down before clicking Continue.**

If you miss the modal (closed too fast, lost focus), regenerate from **Settings → Recovery phrase** any time.

---

## v0.2.x and earlier

Pre-v0.3 changes weren't tracked in this changelog. The headline features for those releases:

- v0.2.x: PDF ingest worker, op-log recovery flow (sync), source index, embedding cache, MCP relay
- v0.1.x: Initial release — local-first encrypted Cortex, MCP server, federated recall, BGE-small embeddings, Tauri shell

Future releases will be tracked here from the date they ship.
