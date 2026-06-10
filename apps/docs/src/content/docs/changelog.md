---
title: Changelog
description: Public summary of changes to the Graphnosis app, version by version.
sidebar:
  order: 99
---

What changed in each release, in user-facing terms. Internal refactors and dev-only cleanups aren't listed.

Conventions: **Added** = new features, **Changed** = behavior or UX shifts, **Fixed** = bugs, **Security** = anything affecting your data, **Migrations** = automatic upgrades the app applies to existing cortexes.

---

## v1.14.3 — VS Code setup & copy fixes

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-06-10</p>

Three follow-up fixes to the VS Code / Copilot Chat setup modal.

### Fixed

- **"Install extension" button now works.** The button was routing through a Tauri command whose scheme allowlist blocked `vscode:` URLs, so clicks had no effect. It now goes through the correct command with `vscode:` explicitly permitted, so clicking it hands off to VS Code and opens the extension installation page directly.
- **Copy buttons now work reliably.** The copy function was using `navigator.clipboard.writeText` with no error handling — if the clipboard API was blocked or unavailable in the webview context, the rejection was silently swallowed and nothing happened. It now falls back to a `textarea` + `execCommand('copy')` path so the button always works.
- **VS Code MCP config path updated.** VS Code now requires MCP servers to be registered in the global user config rather than a per-project `.vscode/mcp.json`. Option B in the setup modal and the documentation now show the correct path for each platform: `~/Library/Application Support/Code/User/mcp.json` (macOS), `%APPDATA%\Code\User\mcp.json` (Windows), `~/.config/Code/User/mcp.json` (Linux).

---

## v1.14.2 — VS Code & Copilot Chat setup fixes

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-06-10</p>

Two small but visible fixes to the VS Code / Copilot Chat setup modal.

### Fixed

- **VS Code MCP config snippet always shows valid JSON.** The config field in Option B previously showed a prose message ("Unlock the cortex first…") when the cortex was locked, making it impossible to see the snippet structure. It now always renders the full JSON block; when locked, the `Authorization` header shows `Bearer <your-bearer-token>` as a placeholder so you can preview and copy the format. The real token drops in automatically once you unlock.
- **"Install extension" button now opens VS Code directly.** The button was linking to a Marketplace browser URL that returned a 404. It now uses the `vscode:extension/nehloo-interactive.graphnosis` deep-link scheme, which hands off to VS Code and opens the extension's installation page without going through a browser.

---

## v1.14.1 — Contradiction detection & sharper skill exports

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-06-10</p>

A focused follow-up to v1.14.0. Your memory now notices when two things you've saved disagree, trained skills export as ready-to-use Claude Code skills, and IT teams get a dedicated FAQ.

### Added

- **Contradiction detection.** Graphnosis now spots memories that conflict — two notes about the same thing that say opposite things — and surfaces them in the Home **Needs you** review, where you keep the current one and retire the outdated one. Your AI client gets a matching `contradiction_pairs` tool to review and resolve them too. It runs quietly in the background and only surfaces high-confidence conflicts, so the list stays short and worth your attention.
- **Drop-in Claude Code skills.** Exporting a trained skill as Markdown now produces a ready-to-use Claude Code skill — with proper `name` / `description` frontmatter (the "when to use this" line your AI reads) and the full set of goals — so a skill you train in Graphnosis drops straight into a `.claude/skills` folder.
- **Enterprise IT FAQ.** A new documentation page answering the security, installation, tamper-resistance, industrial/OT-integration, and compliance-mapping questions IT and infosec teams ask before approving Graphnosis.

### Changed

- **Batch saves report conflicts too.** Saving several notes at once now reports any contradictions it detects, the same way single saves already did.

---

## v1.14.0 — Security & privacy hardening

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-06-09</p>

A release focused on strengthening how your data is protected — at rest, while syncing between your devices, and when an AI client asks to read it. Most changes are invisible: your memories, recall, and skills work exactly as before. A couple of items need a quick action from you (below). We recommend everyone update.

### Strengthened

- **Sync integrity.** The op-log your devices sync is now cryptographically signed per device and sequence-verified, adding strong protection for synced and backed-up data. (New format; your existing op-log history is still read.)
- **Per-engram consent.** Access approvals are now scoped to the specific engram an AI client requests — each sensitive engram is authorised individually, and the consent prompt names it.
- **Encryption of bridge tokens at rest.** The mobile, browser, and VS Code bridge tokens are now encrypted within your settings.
- **Tighter on-disk isolation.** Your cortex folder, settings, caches, op-log, and the app's local sockets are now created with owner-only permissions.
- **Sensitive engrams and recall.** Sensitive engrams are kept out of broad "search everything" recall — they're returned only when you explicitly name and approve them, and then only up to the sensitive-tier cap.
- **Imported-file and stored-data handling.** More robust, bounded parsing of imported files with size limits, stronger integrity verification of encrypted memory files, constant-time checks on secrets, safer link handling, and refreshed parsing dependencies.

### Fixed

- **Recovery-phrase reliability.** Recovery-phrase backups are now reliably restorable. **Action:** if you created a recovery phrase before v1.14.0, please generate a new one (Settings → Security) — an earlier phrase may not restore your cortex.
- **Sensitive recall returns results.** Explicitly recalling an approved sensitive engram now returns content (capped to the sensitive tier); it could previously come back empty.

### Migrations & actions

- **Recovery phrase:** regenerate it (see above).
- **Bridge tokens:** re-encrypted automatically on first save after upgrade. As a precaution, you may rotate them in Settings afterward.
- **Consent approvals:** existing approvals are requested once more as consent moves to per-engram scope.
- **Op-log:** the new signed format is written going forward; your existing history is read as before.

---

## v1.13.6 — Pricing tiers, Pro tool gating, and upgrade page

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-06-09</p>

### Added

- **Free, Pro, and Teams pricing tiers.** Graphnosis now has a public upgrade page at `/upgrade` showing all tiers side by side. Free stays free forever — all 31 core MCP tools, unlimited sources, up to 3 user engrams. Pro ($10/mo or $99/yr) unlocks 16 advanced tools plus unlimited engrams and unclamped connector cadence. Teams ($25/mo or $249/yr per person) adds team-collaboration features as they ship.
- **Annual billing.** Pro and Teams can now be purchased annually — $99/yr for Pro and $249/yr for Teams (both save two months vs. monthly). The upgrade page has a monthly/annual toggle.
- **Upgrade link in the nav and footer.** A persistent Upgrade link appears in the top navigation bar and footer of graphnosis.com.

### Changed

- **16 Pro tools are now gated** behind a Pro or Teams license. Previously ungated tools that required a local LLM — `develop`, `predict`, `insights`, `llm_query`, `llm_distill` — now return a clear license error instead of "Local LLM unavailable" on the free plan. Same for `gnn_status`, `audit_memory`, and `duplicate_pairs`. Skills-authoring tools (`train_skill`, `export_skill`, `rollback_skill`, `skill_history`, `skill_vitality`, `save_skill_run`, `resume_skill_run`) were already gated; now consistently enforced.
- **Free plan: 3 user engram limit.** Free-plan users can create up to 3 engrams. The two built-in system engrams (`graphnosis-docs`, `graphnosis-skill-demos`) don't count toward the limit. Attempting to create a 4th engram returns a structured `ENGRAM_LIMIT_REACHED` error with an upgrade prompt in the app.
- **Free plan: connector cadence floor.** On the free plan, network connector pull intervals are clamped to a minimum of 24 hours. Watch-based connectors (Obsidian, GBrain, AI Context Files) are unaffected — they use filesystem watchers. Pro removes the floor entirely.
- **MCP tool documentation updated.** The MCP Tools reference page now marks all 16 Pro tools with a ★ indicator, lists the correct free (5) vs. Pro (7) skill-authoring tool split, and renames the "Non-deterministic" section to "Foresight."

---

## v1.13.5 — Foresight, Your Cortex, and Claude Desktop extension

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-06-08</p>

### Added

- **Graphnosis is now available as a Claude Desktop extension.** Install it from the Anthropic Connectors Directory to connect your local cortex to Claude Desktop with three config fields — cortex folder, passphrase, and default engram. No new setup required if you already have Graphnosis installed.
- **MCP tool annotations.** All 47 MCP tools now carry `title`, `readOnlyHint`, and `destructiveHint` metadata, so AI clients that support tool annotations display cleaner, safer tool lists.

### Changed

- **"Non-Deterministic Aid" is now "Foresight."** The tab, all tooltips, error messages, and in-app references have been updated throughout the app. Same capabilities — GLL overlay, GNN predictions, local LLM — cleaner name.
- **"Overview" is now "Your Cortex."** The main rail button label now reflects what it actually is: your personal memory home.

---

## v1.13.4 — Low-power mode, cooler ingests, smoother graph

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-06-07</p>

A performance and reliability release focused on heat, battery, and import correctness on a busy machine — so Graphnosis stays cool and bounded even with many connectors, a large cortex, and a local LLM running alongside.

### Added

- **Low-power mode.** A toggle in **Settings** that pauses the autonomous "brain" — duplicate detection, connection-weaving, neural-network and local-LLM passes — to cut CPU and save battery. Your graph still ingests, recalls, and saves normally; only the background self-improvement stops. A **⏻ Low-power** chip in the status bar shows when it's on (click it to jump to Preferences). The 3D animation is separate — use the **Alive Engram** toggle on the graph to pause that.
- **Self-healing connector sync.** A connector can no longer permanently miss a file. **Pull now** / **Re-sync** do a full re-scan; auto-sync connectors also promote to a full re-scan periodically (default every 30 min, configurable per connector via **Full re-scan** in the connector's Edit form — set 0 to disable). So a file that was skipped or failed in an earlier run is always eventually re-checked, with no manual action.
- **On-graph ingest progress.** During a connector sync the 3D view shows a `[X%] ingesting <file> to <engram>…` bar (redacted in Presentation Mode).
- **Linux builds.** Graphnosis is now available for Linux as an `.AppImage` (runs on any distro) and a `.deb` (Debian / Ubuntu), alongside the existing macOS and Windows installers.

### Changed

- **Re-scans skip unchanged files.** A full re-scan used to re-embed every file just to discover it hadn't changed — which on an already-ingested vault could peg the CPU and spin up the fans. The connector now records each file's content hash and **skips the embedding entirely when a file is unchanged**, so repeat syncs and the periodic self-heal sweep are nearly free and stay cool.
- **Dramatically lower idle memory on a large cortex.** A multi-engram cortex that previously sat at several GB (and spiked higher) now idles close to ~1 GB — small enough to run beside a ~28 GB local model on a 32 GB machine. Achieved by not reading the cold operation log at boot, scavenging freed memory back to the OS, and standing the brain's heavy passes down while any engram is ingesting.
- **The 3D graph grows smoothly during ingest.** New nodes ease into the existing layout instead of re-exploding the whole graph on every update, and the animation automatically pauses when the window is in the background.

### Fixed

- **The "⟳ Syncing…" button reverts to "⟳ Sync now"** the moment an ingest finishes, instead of appearing stuck.
- **Dragging the 3D graph rotates it again.** A stuck Cmd/Ctrl state could leave a plain drag pinning nodes; the graph now re-asserts drag-to-rotate on every render (hold Cmd/Ctrl to move and pin a node).
- **Vitality no longer drops after a restart** on a large cortex — recent-activity is now counted from the memories themselves rather than a log read that was removed.

---

## v1.13.3 — Large-cortex performance & reliability

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-06-05</p>

A reliability and performance release focused on big cortexes — many engrams, large imports, and heavy AI use at the same time. The headline is that the app stays responsive and bounded in memory even with a very large graph, plus a data-integrity fix for large engrams and two new import formats.

### Added

- **Excel (`.xlsx`) and PowerPoint (`.pptx`) ingest.** Spreadsheets and slide decks now import alongside the existing PDF / Office / Markdown formats.

### Changed

- **The 3D atlas handles very large engrams smoothly.** It now renders the most-connected nodes (up to a cap) and resamples on demand as you explore, samples dense edge categories (showing a representative slice instead of hiding them), and settles freshly-ingested nodes incrementally instead of re-exploding the whole graph each time a new source lands. Selecting a new engram clears the view and shows a loading state while the next one streams in.

### Fixed

- **Large engrams no longer flagged as corrupted on load.** A checksum sign bug mis-flagged big engrams (above ~17 MB) as failing integrity, sending them to quarantine. The check is fixed — affected engrams were never actually damaged and load normally again.
- **The sidecar no longer stalls your AI client or the UI on a large cortex.** Background "brain" work (duplicate detection, connection-weaving) now yields the processor and defers while you or an AI client are actively using Graphnosis, so recalls and the window stay responsive. Saves are serialized and memory-bounded, and the duplicate scan now covers engrams in rotation rather than all at once — which on a large cortex could spike memory and bog the whole machine down.
- **The Activity timeline no longer times out** when the history references an engram that was since deleted or isn't loaded.
- **Drag-and-drop file ingest** works again.
- **The "recovered ✓" badge on quarantined engrams** no longer appears before recovery has actually completed.

### Security

- **Every engram save now keeps a last-known-good copy and a durable recovery log.** If a write is interrupted or comes back unreadable, the app can fall back to the previous good copy instead of surfacing the failure as data loss — and the structural-only recovery log makes any such incident diagnosable after the fact.

---

## v1.13.1 — Presentation Mode, per-source redaction, and billing hardening

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-06-04</p>

Patch release on top of v1.13.0. The headline is **Presentation Mode** — a demo-safe redaction layer so you can show Graphnosis (talks, screenshots, screen-shares) without exposing real memories. Plus a round of billing hardening and reliability fixes.

### Added

- **Presentation Mode.** A new rail destination where you pre-select exactly what to reveal — per engram, source, skill, or goal, plus fixed surface toggles. On **Start**, everything else is redacted **in place** as solid ████ blocks with the layout preserved (not hidden, not blurred). **Default-deny**: anything you didn't explicitly reveal stays masked, so a missed tag fails safe. It covers the Inspector, the 3D atlas (masked at the data layer, not just visually), MemoryStudio (raw context filtered per engram; LLM synthesis is all-or-nothing), Activity, Cortex Management, Settings (consent phrases, license email/expiry), the lock screen, and more. Your selection persists, but "active" never does — the app always boots **un-masked**, so you can't get stuck; exit via the banner or **Esc** with a confirm step.
- **Per-source redaction.** Presentation Mode can reveal or mask individual sources within an engram: revealing an engram shows all its sources unless you've checked specific ones, in which case only those reveal. Precise across Search, the Inspector, Activity, MemoryStudio, and the 3D atlas.
- **Activity "who made it" filter.** The Activity page now filters by actor — Claude Code, the Autonomous brain, You, the App, or System — via a dropdown and per-row badges.
- **Manage your subscription via Stripe's portal.** **Manage subscription** opens Stripe's hosted billing portal (update card, cancel, view invoices) — Graphnosis keeps no billing account of its own.
- **"Renews" vs "Expires" on your license.** The license panel shows *Renews \<date\>* for an active subscription and *Expires \<date\>* once you've cancelled.
- **Goal delete.** Goal cards get a confirm-gated delete button.

### Changed

- **License refresh moved to the sidecar.** The browser can't poll the billing endpoint (CORS), so license refresh now runs in the sidecar, carrying a per-subscription secret from your claim link.
- **Search results scroll back to the top on each new search**, selecting an engram switches to the 3D view only when it makes sense, and Search / Sources / Activity now default to **All Engrams**.
- **Presentation Mode clause added to the [Terms of Use](/legal/terms-of-use/)**, and the [Network activity](/guides/network-activity/) guide now discloses the Pro-licensing and billing network paths.

### Fixed

- **The UI no longer freezes during a bulk or connector ingest.** Ingesting a folder of many small files could lock the window mid-ingest; the sidecar now yields to the UI every few files so it stays clickable throughout.
- **Search no longer crashes on special characters.** Queries containing `(`, `*`, or other regex metacharacters are now sanitized instead of throwing.
- **Skill engram double-wrench icon, lock-screen white flash on launch, and window-resize-on-launch** are fixed; the window now reliably reveals (4-second fallback) and the app restarts itself cleanly after an update.
- **Quieter terminal/log output during ingest** — the benign-noise filter now also covers stderr chatter while still surfacing real errors and warnings.

### Security

- **Entitlement-theft fix on the license endpoint.** The license-token poll was keyed on email alone, so anyone who knew (or guessed) a subscriber's email could pull their replayable license token — and confirm the email was a paying customer. The endpoint now requires a per-subscription secret, compares it in constant time, and otherwise returns an indistinguishable "no subscription" response — failing closed.
- **Per-cortex settings writes are now serialized.** Concurrent writes (e.g. a connector state update racing a user change) could interleave and truncate or merge `settings.json`. Writes are now serial, each with a unique temp file before the atomic rename, so two in-flight writes can't clobber each other.

### Migrations

- **Pro users may need to re-claim once.** Legacy license records have no poll secret, so the hardened endpoint fails them closed — clicking your claim link again mints a fresh, secured token. Manual token paste is unaffected.

---

## v1.13.0 — Personal Server: reach your cortex from any device

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-06-03</p>

The headline: Graphnosis can now run as a **personal server**. The sidecar serves the full app in a **browser** — so you can reach your cortex from a phone, tablet, or another computer, on your home network or anywhere over [Tailscale](https://tailscale.com), with the cortex staying encrypted on the server. The Mac desktop app is unchanged and remains the primary experience; this is additive. This release also reorganizes the desktop app around a **Home mission-control dashboard**, advances **Skills** with cross-engram and parallel orchestration, and adds an **enterprise admin-policy layer**.

### Added

- **Browser access (personal-server mode).** Turn on **Settings → Mobile & Remote → Browser access** and Graphnosis serves its UI on a separate port. Scan the QR (or open the URL + paste the access token) from any device. Sessions use a bearer token; live updates stream over the connection so a memory saved on your laptop appears on your phone.
- **Mobile-responsive UI.** On phones: a bottom nav (Memory · MCP · Status), a slide-out menu, full-screen panels, a bottom inspector drawer, and a 3D engram view that fits the screen. Installable to your home screen as a PWA. Tablets adapt by orientation.
- **Connect Claude for iOS / Android.** The Mobile & Remote panel hands you an MCP server URL + bearer token (and a QR) to add Graphnosis as an MCP server in your phone's AI client.
- **Tailscale HTTPS, auto-detected.** Run `tailscale serve` and the app automatically switches the browser and MCP QR codes to real-certificate `https://…ts.net` URLs (which iOS requires) — no certificate setup on your side.
- **Linux / Docker server.** Run the sidecar headless on a Linux box (systemd unit, `.env`, and a multi-arch Docker image included) for an always-on personal server.
- **Live file connectors.** The **GBrain**, **Obsidian**, and **AI Context Files** connectors now **watch their folder** and ingest new or changed notes within seconds, instead of only on a timer. The poll interval is now configurable in **Settings → Connectors**.
- **Home — a mission-control dashboard.** The desktop app is reorganized around a rail of first-class destinations (Home · 3D Engram · Sources · Skills + Goals · Foresight · Brainstorming · Search · Activity · Status), with the manual recall / remember / edit / dig-deeper / GNN tools collapsed into a **Manual tools** drawer ("your AI client does this for you"). Home opens on a cortex-wide overview: Trust & Vitality, Memory health, Self-healing, Recent activity, Needs-you items, Stranded memories, a *Since you last opened* digest, and an On-Premise egress ledger. Picking an engram now **scopes the current view** instead of yanking you to the 3D atlas.
- **Foresight page.** Goals plus brain `predict` / `insights` in one place (shown when the Local LLM is enabled).
- **Biometric unlock for personal-server browser mode.** Touch ID, Windows Hello, or a hardware security key (WebAuthn) can unlock the browser UI. It authenticates **access to the server** — minting the same session token a pasted access token would — and does **not** decrypt the cortex. Available only in a secure context (Tailscale HTTPS or `localhost`); token/QR unlock remains the always-available fallback. The desktop app keeps using native Touch ID and is unaffected.
- **Exclude a source from recall.** A per-source toggle hides that source's nodes from AI `recall` / `dig_deeper` / node search while keeping it fully visible — and forgettable — everywhere in the app. Excluded rows are dimmed and struck-through; the flag persists with the cortex.
- **Enterprise admin-policy layer.** IT admins can centrally disable specific **connectors** (incoming data) and **AI clients** (outgoing memory access) via environment variables or a `policy.json` next to the cortex. A disabled client's tool calls are rejected and a disabled connector won't mount; when the policy is centrally managed, a local user can't override it. For individual users the same mechanism makes them admin of their own sidecar.
- **Skills — cross-engram `@skill:` calls.** A skill can now invoke a skill that lives in **another engram**. Resolutions are persisted in an encrypted side-table and surface in the walk, with cross-engram targets flagged by `targetGraphId`.
- **Skills — concurrent sub-skills (`@parallel`).** `@parallel: [a, b(arg=$x)] -> [$ra, $rb]` dispatches the listed sub-skills concurrently and captures each return under its positional variable. `walk_skill_structured` surfaces a `parallel[]` set per step.
- **Skills — loop convergence guards + typed inputs.** `@loop: N max=M` caps a loop at *M* iterations so an executor can stop a non-progressing loop, and `Requires: $branch:string, $policy:{phased|atomic}, $count:number` now parses inline argument types (exposed as `requiresTypes`) so inputs can be validated before a skill runs. Both stay backward-compatible with the untyped/uncapped forms.
- **Skills — resumable runs.** Two new MCP tools, `save_skill_run` and `resume_skill_run`, persist a multi-skill run's captured variables and progress to an encrypted per-run file, so an orchestration can be paused and continued in a later session.
- **Connectors — opt-in "mirror deletions."** Local-file connectors (GBrain, Obsidian, AI Context Files) can optionally remove the corresponding memories when a watched file is deleted, keeping the cortex in sync with the folder. Off by default.

### Changed

- **Starter skill demos install in one language.** When you add the bundled demo skills, pick **English or Romanian** — only that set of 3 installs, not both.
- **47 MCP tools across 10 categories.** Up from 45 — `save_skill_run` and `resume_skill_run` join the **Skills (SOPs)** group, which now has 12 tools.

### Fixed

- **Large folder imports no longer lose files.** A connector pulling a folder of more than ~50 notes previously stopped after the first batch and silently skipped the rest. It now ingests the whole folder, in order, without dropping the tail.
- **Startup crash from a missing runtime polyfill.** A dependency added for the personal-server work could crash the bundled binary on launch; the required `reflect-metadata` polyfill is now loaded so the app starts reliably.

---

## v1.12.0 — Skills as Standard Operating Procedures + MemoryStudio

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-31</p>

The big shift in this release: **Skills are now first-class, executable Standard Operating Procedures**. A skill is no longer just a markdown body — it is a graph of steps with goals, loops, branches, anchored context, and cross-skill orchestration that any MCP client can walk and execute. The MCP surface grows from 35 to 45 tools.

### Added

- **Skills as SOPs.** Skills are wired into the cortex as graphs with five evidence-tagged edge types: `skill:seq` for the linear chain, `skill:loop` for "go back to step N", `skill:branch` for conditional forks, `skill:ctx` for recalled memories anchored to a specific step, and `skill:calls` for cross-skill invocation. See [Skills as SOPs](/reference/skills/).
- **Position-aware recall placement.** Training no longer dumps recalled memories at the end as a flat block — each fragment is placed in the procedure at the position where it actually fits. Two-step deterministic check: similarity to surrounding steps + triplet coherence between `prev` step / fragment / `next` step. Fragments that don't fit anywhere mid-procedure go to a `Supporting context` block instead.
- **Eight goal categories per skill.** Added `Trigger:`, `Prerequisites:`, `On failure:`, `Requires:`, and `Produces:` to the original three (`Success:`, `Out of scope:`, `On completion:`). Each renders as a colored chip in the editor and is wired to the title with a `contains/skill:goal` edge. The full set is what makes a skill executable rather than just readable.
- **Cross-skill orchestration.** A step can invoke another skill with `@skill: target-name(arg=value, arg=$priorVar) -> $captureName`. The bare form `@skill: name` still works. The AI executor reads the structured plan from `walk_skill_structured` and resolves variables, captures returns, and routes failures.
- **`walk_skill` and `walk_skill_structured` MCP tools.** Two paired tools — narrative SOP text for human-facing guidance, JSON `SkillExecutionPlan` for AI execution. The structured plan includes `requires` / `produces`, ordered steps with `calls` metadata, and `failureHandlers` derived from `On failure:` blocks.
- **Eight more Skills MCP tools.** `get_skill`, `list_skills`, `train_skill`, `export_skill`, `delete_skill`, `skill_history`, `rollback_skill`, `skill_vitality` — the full lifecycle, all deterministic reads/writes against the Skills engram.
- **45 MCP tools across 10 categories.** Up from 35 / 9. The new **Skills (SOPs)** group is the tenth category.
- **Bundled Skill Demos.** Three signed `.gsk` demo packs auto-load into a dedicated **Skill Demos** engram on the first unlock of a fresh cortex: *Code review* (single-skill with prerequisites + failure recovery), *Safe Deploy* (six-skill cross-skill orchestration with `$captures` and rollback handlers), and *Comprehensive job memory* (a longer SOP showing position-aware placement on the full goal block). All three are inspectable, editable, and deletable — they are normal skills in a normal engram.
- **In-place retrain + snapshot history.** Retraining mutates the existing skill source in place via the op-log; the `sourceId` is stable across retrains so inbound `@skill:` references keep resolving. Every retrain writes a snapshot of the prior body, goals, and edges to a per-cortex encrypted side-table. Browse via the `skill_history` MCP tool or the Skills page UI.
- **Skill rollback.** `rollback_skill` (or the UI button) restores any snapshot. The rollback itself is recorded as a new snapshot so the lineage is preserved — nothing is destroyed.
- **Pro train path — LLM-rewritten body with attribution.** With the Pro license + Local LLM, the local LLM rewrites body steps to integrate recalled context fluently, while every fact pulled in keeps its `_(from source)_` marker. The rewrite happens entirely on-device. Free path remains the deterministic memory-augmented body (recall appended in-place with attribution); the user picks per skill, the AI client does not.
- **Autonomous retrain (Pro).** Brain-engine loop that re-runs `train_skill` on a schedule, on cortex growth, on vitality decay, or any of those (hybrid). Three autonomy levels: auto-accept, notify, preview-first. Opt-in per skill from the Skills page.
- **Streaming trainer with live diff.** Ollama tokens stream back to the desktop during training so the diff paints as Ghampus writes — green/red line-diff hunks update in real time. `< >` arrows navigate hunks; a Cancel button stops the run cleanly. Draft body is auto-saved to `localStorage` every 500ms so refreshing or quitting mid-train does not lose work.
- **AI-driven engram creation for Skills.** If the AI calls `train_skill` against a cortex with no Skills engram, the sidecar broadcasts an `engram-create-suggested` event (template: `skill`) instead of hard-erroring. The user confirms or renames in the in-app banner; the engram is created with the raw skill ingested as a `skill` source; the AI retries and training proceeds. The `skill` template is also available manually from the New Engram wizard.
- **MemoryStudio — a first-party UI for what AI clients do via MCP.** New top-level tab covering Skills · Recall · Dig Deeper · Remember · Edit / Correct · GNN Exploration · (All Tools), all running entirely on-device with no internet required. Every panel delegates to the same `host`/`brain` functions used by the MCP tools — no logic duplication, so what you see in Studio is what an AI sees over MCP. See [MemoryStudio](/memory-studio).
  - **Per-tool result panels.** Recall and Dig Deeper snapshot their rendered DOM + slider state on tab leave and restore on tab enter; switching between tools preserves each one's last result, slider position, and LLM output independently.
  - **Threshold slider syncs per tool.** Each tool re-anchors the slider to its own saved Δ (separate `localStorage` keys per tool) so a tool always opens at its own preferred strictness, not the previous tool's value.
  - **Cross-engram Memory Trace.** Clicking nodes across different engrams in the raw-context panel no longer resets the rail's Memory Trace; a global recents list (with per-engram fallback preview lookup) accumulates across switches.
  - **Remember as the default tab on open**, with a two-click confirm on Save memory — the second click commits, and the pending state resets the moment the textarea content changes.
  - **Cross-engram search-result clicks switch the active engram** before selecting, so the inspector populates instead of showing empty.
  - **Collapsible left sidebar.** Chevron toggle in the top-right collapses everything to icon-only (56px wide); state persists across sessions. Memory Trace, AI-clients / Data-sources groups, and bottom-row labels hide; tooltips keep navigation discoverable.
  - **New rail icons** — MemoryStudio (brain/cognition), Sources (document with corner), Status (EKG pulse). Inline line-art SVGs that tint with the existing fg-dim/fg palette.
  - **Tab strip polish** — font 14px → 12px, padding 14px → 9px per side (~30px saved across the strip). Each tab gets a thin turquoise left border at 28% opacity as a visual separator; the active tab raises it to 55%; the first tab has no left border.
  - **GAP status-bar pill** sits left of GLL — pulses green while the trainer is busy, greys when idle, and is clickable to jump straight to the Skills chip.
- **Loopback verification — privacy as a visible signal.** Tauri `verify_local_llm` command: `pgrep` by process name → `lsof` by port fallback → `lsof -i -P -n -p PID` to enumerate the local LLM daemon's open sockets, classifying each as loopback (`127.0.0.1`, `::1`, `localhost`) or external. The result feeds an inline badge so you can prove at a glance that Ollama is not phoning home.
- **Ghampus on the dashboard.** The duplicate "Graphnosis · your second cortex" headline is replaced with a Ghampus block: *"Ghampus / your memory seahorse."* with a faint, bobbing seahorse mark behind the text in the top-right of the title.
- **Meet Ghampus modal.** Clicking the Ghampus title block opens a *"Hi again. I'm Ghampus."* modal with origin story, what-I-do bullets, where-you'll-bump-into-me list, what-I-will-never-do trust spine, and a closing *"Pleased to be your hippocampus."* Backdrop click / Got it / Esc close. Keyboard-accessible (role=button, tabindex, Enter/Space). See [The story of Ghampus](/reference/ghampus/).
- **What's New carousel modal.** A single multi-slide intro modal (MemoryStudio → Graphnosis Skills / Autonomous Praxis) replaces the previous two separate startup modals. Dot indicators at the top jump between slides; the primary button reads *"Next"* while slides remain and switches to *"Get started"* on the last slide. Single dismissal key (`graphnosis.whatsNewV1Dismissed`) covers the whole carousel.
- **Pro upgrade flow — Stripe + Cloudflare-hosted `/upgrade`.** New marketing landing at [graphnosis.com/upgrade](/upgrade) (hero, $10/mo card, feature list, FAQ, contact). `/upgrade/checkout` creates a Stripe Checkout Session; on success, `/upgrade/success` emails a magic link with a `graphnosis://claim` URL. Webhook signs license tokens with Ed25519 and stores them in Cloudflare KV. License validation is offline-first after delivery.
- **`graphnosis://` URL scheme registered (macOS + Windows).** Clicking the post-checkout magic link activates Pro automatically — the deep-link handler routes `graphnosis://claim` into the sidecar's `license:setToken` IPC. Manual paste in **Settings → Pro license** still works for headless or air-gapped setups.
- **Compact New Engram wizard.** Wizard modal is significantly shorter: subtitle compressed to one line, Display name + Internal ID inputs side-by-side, sensitivity tier section trimmed to two lines, radio captions shortened (*AI always on* / *Ask once* / *Ask hourly*), template-card padding and font tightened. `skill` template added as a free-tier option.
- **Window state persistence.** Window remembers its size, position, and maximize state across launches. Starts hidden until JS confirms ≥ minWidth/minHeight, then reveals — no more visible jump from a stale stored size.
- **`recall` → `dig_deeper` escalation flow is now well-defined.** AI clients should call `dig_deeper` with the same query when `recall` returns 0–3 nodes, before telling the user nothing was found. The MCP tool descriptions enforce this. See [MCP Tools — `dig_deeper`](/reference/mcp-tools/#dig_deeper).
- **0-score node filter.** `recall` and `recall_structured` (via the underlying `query` / `queryRich`) now filter out structural SDK expansion nodes that have no seed score (`score=0`). Only semantically scored nodes appear in AI responses and MemoryStudio. Eliminates the confusing 0.00-confidence rows users were seeing in AI output.
- **Insights — honest empty-states + faster retry.** The `insights` MCP tool surfaces explicit messages for no-LLM / timeout / no-data, and the background loop retries after 1h on transient failure instead of 6h.
- **License launcher moved to the top of Settings.** Previously buried in the Settings modal; now visually consistent with the other settings panels (transparent background, top of the Settings pane).
- **Atlas engram-switch loader.** Switching engrams on the 3D atlas wipes the canvas immediately and pops a centered loading overlay with a turquoise spinner, friendly label (*"Loading <engram name>…"*), and a sub-line that fills in with the node count once the IPC returns. Old engram's nodes no longer linger 1–3s reading as "switch didn't work."

### Changed

- **`.gts` → `.gsk` rename.** The skill wire format extension changed from `.gts` ("Graphnosis Training Skill") to `.gsk` ("Graphnosis Skill Kit") — it reads more naturally to users and matches the file-type association now registered on macOS and Windows. Older `.gts` files still import — the loader matches on magic bytes (`GSK\x01`), not the filename. See [File formats — `.gsk`](/reference/file-formats/#gsk--graphnosis-skill-kit).
- **`.gsk` packs are Ed25519-signed.** Every export is signed; every import verifies. Tampered or unsigned packs are rejected. The Graphnosis signing secret never enters the codebase. Third parties publishing their own packs use their own keypair and ship the public key alongside.
- **Tauri file-association registered.** Double-clicking a `.gsk` file in Finder or Explorer prompts the Graphnosis app to import it into the cortex you choose.
- **One source per skill instead of per-train.** Retraining no longer creates a new source — the existing source is mutated in place. Existing per-train sources from older cortexes are coalesced on first launch (migration is one-shot, no user action required).

### Fixed

- **Preview-mode textbox no longer suppresses input.** A focus-trap bug in the skill preview pane was eating the first character of every edit. Resolved.
- **Archived skills are now hidden from the Skills picker.** Previously an archived skill could still be selected from the picker and trained, leading to ghost sources.
- **IPC timeout on long skill trains.** The sidecar IPC bridge was timing out after 30s on cortexes with thousands of recall candidates. The timeout is now adaptive to candidate-set size and `train_skill` carries its own progress channel.
- **Recall / Dig Deeper button stuck disabled after a search.** `runStudioRecall`'s slider re-run fast-path was returning before entering the `try/finally` that re-enables the button, and most fresh recalls trigger an auto-apply slider re-run via `revealThresholdSlider`. Every exit path now hits `finally { recallBtn.disabled = false }`.
- **Sidecar 90s startup hang on Windows.** A blocking probe at boot would wait the full 90s when the embed-worker subprocess failed silently. Now terminates failed workers immediately and surfaces the error so the cortex load unblocks.
- **Orphan lock on Windows after force-quit.** A crash or force-quit on Windows could leave the cortex lock file in place, blocking the next launch. The sidecar now releases the lock cleanly on exit and self-heals on the next launch if it finds a stale one.
- **Billing — `sendMagicLink` not awaited on Cloudflare Workers.** Workers kill fire-and-forget promises the moment the response is returned, so the magic-link email was sometimes silently dropped. The webhook now `await`s the send before responding to Stripe.
- **Billing — Stripe `ui_mode` value.** Switched from `'hosted'` to the correct `'hosted_page'` so checkout creation stops 400-ing.
- **SDK `appendText` sourceRef-header artifact.** A stray header line was leaking into appended text in some skill-edit paths; stripped before write.

### Migrations

- **Skill sources coalesce on first launch.** Cortexes upgraded from v1.11.x with multiple per-train sources per skill are migrated to one-source-per-skill, with the prior versions written into the snapshot side-table as the initial history. Migration is one-shot, idempotent, and runs before any background process starts.
- **`.gts` files in user folders are not renamed.** The migration is read-only — `.gts` imports still work indefinitely. Re-exporting writes a `.gsk` file alongside.

---

## v1.11.1 — Startup reliability and status bar polish

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-26</p>

Patch release fixing issues found in installed v1.11.0 builds.

### Fixed

- **All engrams are fully loaded before any background process starts.** Connectors (RSS, GitHub, Slack, etc.) and the brain engine now wait for the complete cortex to be in memory before they begin. Previously, connectors could fire ingest jobs on engrams that hadn't finished decrypting yet, causing partial writes and the greyed-out engrams visible in the picker until the load caught up.
- **Update notification "OK" now opens the in-app install modal.** Clicking OK on the macOS system notification did nothing if Graphnosis was minimised or hidden — the event was delivered to a hidden webview and the listener never fired. The click handler now brings the window forward and re-emits the event so the Install modal appears reliably.
- **CI release: DMG located dynamically instead of by hardcoded filename.** The release workflow now finds whatever DMG Tauri produces (arch suffix varies by runner) rather than assuming `_aarch64.dmg`. Fixes the v1.11.1 CI failure where the build produced the DMG at the correct path but the step couldn't find it because the package version was mismatched.
- **Status bar items right-aligned reliably.** Version, Vitality, GLL, GNN, and the MCP client indicator are now wrapped in a single flex container with `margin-left:auto`, replacing a fragile empty-span spacer approach that left the items drifting at intermediate positions on some window widths.
- **Offline source categories added to landing page.** The "Auto-ingest from the tools you already use" section on graphnosis.com now lists the full range of off-the-grid sources — smart home, IoT sensors, local networks, research instruments, personal agents, robotics, agriculture — with a link to the step-by-step recipes guide.

---

## v1.11.0 — Overlay recall, LLM capability split, and UI redesign

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-26</p>

### Added

- **`dig_deeper` MCP tool.** New escalation tool for queries that `recall` can't fully answer — it searches harder, crosses engram boundaries, and tells your AI which strategy found each result. AI clients should call it before reporting "nothing found." See [MCP Tools](/reference/mcp-tools/#dig_deeper).
- **Inferred layer in recall responses.** When overlay engines are running, recall results now include a clearly-labelled inferred section — predictions from the neural network and the local LLM, kept visually separate from your attested memory so you always know what's real versus what's suggested.
- **AI now flags thin or lopsided recalls.** Eight core tools surface a heads-up when a recall looks suspiciously narrow — too few results for what was asked, or one engram drowning out all the others — so you know to prompt your AI to look harder.
- **Source-filename hint in recall.** When a query matches a source filename but not the nodes inside it, `recall` names the source so your AI can follow up instead of stopping at "nothing found."
- **LLM capability split.** The Foresight panel now has five independently-toggleable switches instead of a single on/off: **Recall enrichment**, **Correction parsing**, **Distillation**, **Insights & predictions**, and **Edge prediction**. All off by default, all on-device.
- **Edge prediction loop.** With Edge prediction enabled, a background process periodically finds memory pairs that look related but aren't yet connected, proposes a link, and queues it for your review in the Graphnosis Local Layer (.GLL) section of the Foresight tab.
- **Full light-mode palette.** The app now has a complete, designed light theme. Dark mode is unchanged.
- **Overlay engine indicators in the status bar.** Two small pills — turquoise for the Local LLM, purple for the Neural Network — sit beside the MCP client indicator, dimmed when the engine is idle and pulsing when it's active.
- **⌘F global search shortcut.** Pressing ⌘F from anywhere in the app jumps to the search input.
- **3D atlas: grab-to-rotate, ⌘-drag-to-move.** Plain drag now rotates the graph like a globe. ⌘-held switches back to per-node repositioning.
- **Lock screen cortex-missing notice.** If the last-used cortex folder has been moved, renamed, or is on an unmounted drive, the lock screen tells you before you try to unlock.
- **Browse… buttons for Obsidian and GBrain connectors.** Folder picker in each connector's setup modal — no more manual path typing.
- **Privacy notice on all connector forms.** Every connector now shows a one-line local-first reminder: credentials stay on your device, encrypted alongside your cortex.
- **Network activity guide.** New guide covering what Graphnosis connects to, why, and how to verify it yourself. See [Network activity](/guides/network-activity/).
- **Purge All in Cortex Management.** When two or more engrams have forgotten nodes, a single **Purge All** button clears them all in one step.
- **Windows: full sidecar + relay support.** The bundled binaries now work on Windows, and the in-app **Configure Claude Desktop / Claude Code / Cursor** flows support Windows paths and config locations.
- **Search bar shows which engram you're searching.** The stats line below the search input now reads "Coding · 4 matches for 'sensors'" so you always know which engram produced the results.
- **Semantic search tells you when results are off-topic.** If the embedding search returns results that don't actually contain your search terms, the stats line now says so explicitly: "No match for 'sensors' — showing 30 nearest (may not be relevant)." Previously those results silently appeared and looked like real matches.
- **Engram picker updates in real time as each engram loads.** Previously all pending engrams turned active at the same moment (when the last one finished). Now each one becomes clickable the moment it's ready.
- **Startup is significantly faster for large cortexes.** Engrams are available for search and recall the moment each one finishes loading, instead of all at once at the end. Cortexes with many engrams that previously took 30–40 seconds to become responsive are now usable in a few seconds.

### Changed

- **35 MCP tools.** `dig_deeper` joins the Core memory group — up from 34.
- **`correct` renamed to `edit`.** The tool now covers three situations: correcting a factual error, updating outdated content, and appending new detail to an existing memory. The old name `correct` still works as a backward-compatible alias — existing AI clients don't need a session restart.
- **Vitality no longer resets on every boot.** The score you left with is what you see on the next unlock, not an inflated placeholder while the first background scan runs.
- **Status bar layout.** Overlay engine pills and the MCP client indicator are now pushed to the far right, leaving the left side clear for the theme toggle and cortex path. The ⌘K search chip is gone — ⌘F handles it.
- **Clicking the MCP indicator opens the Status page.**
- **Predicted edges hidden by default in the 3D atlas.** The overlay edges no longer appear unless you turn them on — the canonical view stays clean.
- **Recall audit footer no longer lists every engram.** Only engrams that contributed results appear in the footer; the rest are summarised as a count. Previously all engram names — including sensitive ones — were listed on every recall.
- **Engram scoping in recall now works regardless of how your AI formats the parameter.** `only_engrams` and `except_engrams` accept a list, a JSON-encoded string, or a bare name — all three were previously handled inconsistently.

### Fixed

- **Vitality 97 → 75 drop on boot.** Vitality now persists across sessions.
- **Interrupted shutdown left cortex in a broken state.** A force-quit or crash during a graph save used to require manually triggering "Recover from op-log" in Settings. Graphnosis now self-heals on the next launch and shows a toast with the recovery count.
- **Error banners appeared on the lock screen.** They now only show inside the authenticated app.
- **Recall missed memories with accented characters.** "Stefan" and "Ștefan", "resume" and "résumé" — diacritic variants now match each other in entity search. Your stored text is unchanged.
- **Graphnosis no longer pegs CPU when Ollama is unresponsive.** The connection now times out and backs off cleanly.
- **Connectors no longer write to archived engrams.** Previously an archived engram could still receive connector updates (RSS feeds, GitHub, etc.), which caused a quarantine loop on the next boot. Connectors now skip archived targets entirely.
- **Closing Graphnosis unexpectedly no longer leaves the sidecar running in the background.** A crash or force-quit now also terminates the background process, preventing a stale sidecar from blocking the next launch.

---

## v0.10.1 — Boot stability and UI polish

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-24</p>

Patch release fixing issues found in installed v0.10.0 DMGs.

### Fixed

- **Consent toast storm on first launch.** Dozens of "Memory access requires confirmation" popups appeared on boot because `markClientSeen()` was deferred until the user clicked through the first-connect modal — meanwhile the background poller kept firing a new modal for each engram that finished loading. The fix: mark the client as seen immediately when the modal opens, and add a guard so only one first-connect modal can be pending at a time.
- **3D node tooltip stuck at top of canvas.** The node label was rendering at a fixed position in the top-left corner of the 3D view instead of floating near the cursor. The graph library's internal `d3.pointer()` returns incorrect coordinates in the Tauri production webview; replaced with a custom `.atlas-node-tip` element positioned via `mousemove` using raw `clientX/clientY − getBoundingClientRect()`.
- **QR code blank in mobile setup.** The QR code in the mobile/remote setup wizard (Step 3) rendered as a white blank. The Tauri CSP's `default-src 'self'` blocked the `data:` URL the QR library writes into an `<img>` element. Fixed by adding `img-src 'self' data: blob:` to the CSP.
- **Graphnosis Docs duplicated on app update.** Every time the app detected a newer bundled docs version and re-ingested, it appended a new copy of the docs to the existing `graphnosis-docs` engram instead of replacing it. The `docs:ingest` handler now purges all existing sources in that engram before re-ingesting.
- **Sidebar logo not centered.** The Graphnosis logo in the left sidebar was visually offset. Fixed the wrapper to use `display:flex; justify-content:center` instead of relying on `margin:auto` inside the flex column.
- **`forget` tool modal described source-level behavior.** The in-app MCP Tools browser entry for `forget` still said the tool removes a source. Updated to describe node-level soft-delete, the `recall_structured` prerequisite for finding node IDs, and that removing an entire source is a user-only action in the Sources page.
- **MCP Tools modal brand badge layout.** The Graphnosis logo and wordmark now appear as a top-right badge (logo above label) with `align-items:flex-start` on the header, cleanly separated from the tool name on the left. The "Full MCP Tools reference" docs link is flush left in the footer via `margin-right:auto`.
- **Updater bundle missing from CI.** The release workflow was not producing the `.app.tar.gz` needed by the Tauri updater endpoint. Added `"createUpdaterArtifacts": true` to `tauri.conf.json`.

---

## v0.10 — Consent, Activity Log, and safer AI tools

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-24</p>

### Added

- **Consent gate for sensitive data.** Before any `sensitive` engram is served to an AI client, the Graphnosis app pops a one-click prompt: **Deny / Allow once / Allow for 1 hour / Allow for today**. Personal-tier recalls are silent by default (installation + MCP config are already two informed actions). The old phrase-typing flow is preserved as a headless fallback for SSH / CI / no-GUI sessions. See [AI Access Controls](/guides/ai-access-controls).
- **Per-(client, tier) consent records.** Every grant, expiration, and revocation is logged inside your cortex. Settings → AI shows currently-active grants and a full history modal. Records never leave your device.
- **Configurable consent intervals.** Pick how long a confirmation is remembered before re-prompting: every access, 15 min, 30 min, 1 hour, 4 hours, daily, weekly, monthly, 6 months, or permanent. Per-engram overrides in Cortex Management → Edit Engrams; the stricter setting wins.
- **First-connect policy chooser.** The first time a never-seen AI client triggers the consent flow, the app pops a one-time chooser so you can set per-tier defaults (always-allow / ask-1h / ask-1d / ask-every-time / never-allow). Editable later in Settings → AI → Client policies.
- **Recall rate limit.** Each AI client is limited to 10 recall calls per 60 seconds. Catches burst-scan patterns.
- **Session replay blocker.** A recall whose query is ≥ 85% similar (Jaccard token set) to a query issued within the last 60 seconds by the same client is blocked on the 3rd occurrence. First two identical queries pass (legitimate retries); sustained 3rd+ is the scraping pattern.
- **Opt-in session caps.** Three optional cumulative-volume caps in Settings → AI → Optional session caps: token cap (default 100 000 when enabled), node cap (default 500), engram-breadth cap (default 6). All off by default.
- **Settings → AI → Extra precaution mode.** New checkbox that gates `personal`-tier recalls behind the same in-app prompt + per-client policies + first-connect chooser as sensitive recalls. Off by default.
- **Top-bar sensitivity badge.** A color-coded PUBLIC / PERSONAL / SENSITIVE pill next to the active engram in the top bar. Click to change tier or set a per-engram consent interval.
- **First-connect AI client modal.** When a new AI client connects for the first time, Graphnosis asks whether it's a chat assistant or an autonomous agent. Agent mode overrides the consent interval to "every recall" — extra friction for unattended automation.
- **34 MCP tools across 9 categories.** The toolset expanded from the original 11 to 34: full Engram discovery (`list_engrams`, `suggest_engram`, `browse_engram`, `recent`, `get_engram_schema`); structured recall variants (`recall_structured`, `recall_with_citations`, `compare_engrams`, `cross_search`); source operations (`find_source`, `recall_source`, `transfer_source`); engram operations (`ingest_batch`, `engram_summary`); brain maintenance (`duplicate_pairs`, `healing_journal`, `gnn_status`); approximate similarity (`audit_memory`, `check_duplicate`); and Local-LLM-backed (`gnn_neighbors`, `llm_query`, `llm_distill`). Full reference: [MCP Tools](/reference/mcp-tools/).
- **Activity Log in Status pane — full upgrade.** The Status tab's activity feed now loads 20 entries at a time and adds more on scroll (IntersectionObserver sentinel). Each row shows: a short content preview (first ~120 chars of the memory), a **triggeredBy badge** indicating who initiated the action (`user · ingest`, `user · forget`, `mcp · remember`, `brain · consolidation`, `connector · <kind>`, etc.), and an **Open in Sources ↗** button for source-linked events. Historical entries without attribution show no badge — no backfill.
- **Actor attribution on all write paths (`triggeredBy`).** Every op-log event written by the sidecar now carries a `triggeredBy` field identifying the actor — `mcp:remember`, `mcp:forget`, `mcp:correct`, `user:ingest`, `user:forget`, `user:correct`, `brain:reinforcement`, `brain:consolidation`, `connector:<kind>`. The Activity Log surfaces this as a colour-coded badge. New cortexes and all events going forward are attributed automatically; no migration of historical events.
- **3D Engram edge hard-lock.** Any edge category with more than 10,000 edges is permanently hard-locked: it is never rendered, never toggled by the legend, and never triggered by hover — regardless of any setting. The legend row for a locked category is shown at 25% opacity with a "not-allowed" cursor and no interactivity. This prevents THREE.js geometry-allocation freezes on large cortexes (the trigger was a 65K-edge semantic graph). Categories between 5,000 and 10,000 remain in the existing auto-hide tier (off by default, re-enableable); categories below 5,000 are always interactive.
- **In-app MCP Tools browser.** New **MCP Tools** button in the left sidebar (next to Settings) opens a dedicated page listing every tool grouped by category, with a short description, determinism class, and 1–3 example prompts you can paste straight into your AI client.
- **Boot loads your last-active engram first.** Graphnosis now remembers which engram you had selected and loads it as the default on next unlock — the lock screen reveals with the correct engram already showing. See [Boot & engram loading](/guides/boot-and-engram-loading/).
- **Sequential background engram loading.** Secondary engrams load one at a time with event-loop yields between each, so the desktop app's first `list_nodes` call doesn't sit queued behind 12 concurrent decryption jobs. Reveals in ~3 seconds instead of 25–30 seconds on cortexes with many engrams. Status bar shows a live "Loading N more engrams…" countdown while the rest stream in.
- **Engram picker shows pending engrams.** The active-engram dropdown lists every engram immediately on unlock — the ones still loading appear greyed out and aren't clickable until they finish. Positions stay alphabetical with no reshuffling.
- **Local LLM-assisted search.** Two checkboxes inline with the search box (only enabled when the local LLM is reachable): "🤖 Synthesize answer" writes a 1-paragraph answer with citations, "Enhanced ranking" re-orders results by LLM-judged relevance. Settings → AI → "Use Local LLM only for search" restricts the LLM to in-app search and disables `develop`/`predict`/`insights`/`llm_query` MCP tools.
- **Local LLM checkbox toggle.** The Go Non-Deterministic tab's Local LLM master switch is now a labeled checkbox instead of separate Enable/Turn off buttons.
- **"Local LLM…" button replaces the static search-row hint.** The previous "Requires a local AI model — enable in Go Non-Deterministic" cluttering the search row is now a small "Local LLM…" button that takes you directly to the toggle.
- **Search-results × close button.** A close button in the search-results header mirrors the in-input × — clears the query and returns to the dashboard without scrolling back up to the input.
- **Needs Your Review overlay polish.** The overlay now shows an immediate loading placeholder while populating (was empty for ~1s), and auto-closes when you switch away from the Deterministic Consolidation tab.
- **Amber idle indicator on MCP connections.** AI tools panel rows turn amber + show `· Idle Xm` (compact: `47s` / `12m` / `3h`) when a connection hasn't seen a request in 15+ min. Returns to green pulse automatically on the next request. The status-bar dot and left-sidebar chip for that client also turn amber while idle.
- **× force-close button per MCP connection.** Hover any row in the AI tools panel to reveal a × button; one click force-closes that connection. **Non-destructive** — the relay auto-reconnects on its next tool call and a fresh row appears. Hidden for `stdio` transport.
- **Relay reconnect window: indefinite.** The MCP relay used to give up after 24 hours of waiting for the sidecar to come back. Now it parks forever (only exits when the AI client closes its stdin pipe). Closing Graphnosis for a week and reopening just works — your AI clients reconnect on their next tool call, no restart needed. Power users can still set a finite timeout via `GRAPHNOSIS_RELAY_RECONNECT_MS` env var or `settings.json:mcpRelay.reconnectMs`.

### Changed

- **`forget` MCP tool is now node-level only.** `forget` takes `nodeIds` (one ID or an array of up to 20), never a source ID. Removing an entire ingested file, URL, or clip is a **user-only action** done from the Sources page in the app — AI clients have no API path to delete a whole source. The correct workflow: `recall_structured` to find the exact node(s), confirm the text, then `forget(nodeIds=[...])`. If a source has 500 nodes and only one fact is stale, only that node is removed; the other 499 are untouched.
- **`merge_engrams` removed from the MCP toolset.** Merging engrams is now a user-only action in the app UI. AI clients can move individual sources between engrams via `transfer_source`, but cannot trigger a full engram merge. This prevents irreversible structural changes from automated AI flows.
- **Tagline updated.** "Your local encrypted memory, indexed for deterministic recall — auditable." The new ending reflects that every access decision is logged and reversible.
- **Sensitive-tier defaults.** Sensitive engrams now require consent every hour by default (was: blocked outright). The block-by-default behavior is still available — pick "Every access" or set the engram to never be granted consent.
- **Personal-tier recalls are silent by default.** The consent gate only fires for `sensitive`-tier recalls (or any tier in extra-precaution mode).
- **Federated recall silently scopes to consented tiers.** When the AI doesn't name specific engrams, Graphnosis silently excludes any un-consented sensitive engrams from the search instead of firing a prompt. The prompt only fires when the AI explicitly names a sensitive engram via `only_engrams`. Stops the surprise where merely *having* a sensitive engram caused every personal-data query to prompt.
- **MCP `recall` audit footer.** When consent is valid, recall results now end with `[<client> — <tier> access: valid until <time>. Revoke in Settings → AI.]` so the AI surface always shows the current authorization state.
- **MCP consent errors now render correctly in Claude's UI.** The consent-required notice was being returned as a JSON-RPC `-32603 Internal Error`, which Claude renders as a generic "Tool execution failed" with no detail. Now returned as a proper tool result with `isError: true` so the full notice reaches the AI client's UI.
- **Background neuron-field animation rewritten.** The ambient "cortex simulation" behind the vitality card now uses pure Brownian motion with per-node pulsation and short directed-edge synapse pulses, replacing the prior attraction-based simulation that collapsed nodes into 2D lines. Opacity dropped from 0.55 → 0.2 so it reads as a true backdrop.
- **"Cortex secured" capitalization.** Lock-screen boot status now reads "Cortex secured" instead of "cortex secured".

### Security

- **5-attempt lockout per (client, tier).** Five consecutive failed `confirm_data_access` attempts in 10 minutes revokes that pair's consent and notifies you. Other consents are unaffected.
- **Per-cortex HMAC secret.** Each cortex generates a 32-byte secret on first unlock that drives consent phrase rotation. Stored encrypted in your settings; never exposed via MCP, IPC responses, or logs.
- **MCP write protection.** `consentHmacKey`, `dataAccessConsents`, `consentIntervalSensitiveMs`, `consentIntervalPersonalMs`, and `clientTypes` are not writable via any MCP tool. Only the authenticated Tauri IPC channel can update them.
- **Fast-fail when cortex is locked.** Tool calls reaching the MCP relay while the cortex is locked now respond immediately with a clear "Graphnosis is locked" error instead of hanging up to 24 hours.

### Fixed

- **3D Engram freeze on Cmd+Tab and source-legend hover (large graphs).** On cortexes with 65K+ semantic edges, switching apps or hovering any source row in the legend would freeze the UI for several seconds. Two causes fixed: (1) rapid hover events coalesced into a single `requestAnimationFrame`-gated refresh instead of stacking; (2) the `linkVisibility` peek-through callback — which temporarily reveals all edges for a hovered source — is now gated at 10,000 total links. Above that threshold the callback returns the current visibility state unchanged, preventing THREE.js from allocating geometry for tens of thousands of hidden edges in a single frame.
- **Lock-screen freeze during boot.** The lock screen would sit on "Loading memories…" for 25–30s on large cortexes. The sidecar was using `Promise.all` for 12 concurrent decryption jobs, saturating the Node event loop and starving the IPC socket so the boot's `list_nodes` call sat queued. Sequential loading + `setImmediate` yields between each load lets IPC interleave and reveals the lock screen in ~3 seconds.
- **Stale localStorage engram preference.** If you deleted the engram you'd last selected, the next boot would silently create a fresh empty engram with that name. Now falls back to `personal` instead.
- **HMAC key race condition.** Concurrent `get_consent_phrase` calls during Settings panel open no longer race on the atomic settings write. The in-flight promise is cached so the first save wins and concurrent callers share the same key.
- **`mergeWithDefaults` was dropping `consentHmacKey`.** Every settings save was silently regenerating the phrase secret, breaking consent validation. The key is now explicitly preserved through merge.

### Migrations

- **HMAC secret generation.** Older cortexes that pre-date v0.10 will generate a fresh consent secret on first unlock. No user action required.
- **Consent records.** Cortexes with no `dataAccessConsents` field are treated as having no granted consents. The first recall from an AI client triggers the first-time notice.

---

## v0.9 — Deterministic Consolidation

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-22</p>

Theme: **a memory that strengthens, never weakens.** The third tab is reborn as **Deterministic Consolidation** — an engine that makes every memory you add permanent and ever more retrievable. Connections strengthen the more you use them, engrams link to one another, and a daily consolidation pass integrates the whole cortex. Nothing here ever weakens a correct memory.

### Added

- **Connection reinforcement.** Memories recalled together have the connection between them strengthened ("fire together, wire together"); a repeatedly co-recalled pair with no link yet earns one. Reinforcement is live — strengthened connections genuinely rank higher in future recalls — and saturating, so it never runs away.
- **Cross-engram connections.** Graphnosis now links memories *across* engrams — via shared named entities or high semantic similarity — so a query in one engram can surface what you know in another. Stored encrypted alongside your cortex.
- **Consolidation.** A daily deep pass: transitive inference (if A→B and B→C, infer A→C), community detection, and redundancy cleanup (dead edges left dangling to already-deleted memories). All additive or tidying — a connection between two live memories is never removed.
- **Memory health.** The tab's headline is now a retrieval-quality report — connectivity, integration, confidence, coherence, reinforcement activity, and a saturation guard — instead of a raw size-and-density score.
- **Graphnosis Neural Network (opt-in).** A new **Go Non-Deterministic** tab adds an optional, off-by-default neural network that predicts likely-missing connections between your memories. Predictions live in a separate encrypted overlay (`neural-network.gnn`) — never mixed into your deterministic graph — and surface only as clearly-labelled, one-click-removable suggestions. That tab is also the new home for the optional local-LLM setup and AI-generated insights.
- **Add the Graphnosis docs to your cortex.** On unlock, Graphnosis offers to load its own documentation into a dedicated `graphnosis-docs` engram, so your AI can answer questions about Graphnosis itself. The docs are bundled inside the app — adding them is fully offline, with no network access — and refresh when you update the app.

### Changed

- **The third tab is now "Deterministic Consolidation"** (was "Autonomous upkeep").
- **Memories no longer decay from disuse.** Anything you deliberately add — a file, URL, clip, or saved conversation — keeps its confidence indefinitely. The only things that lower a memory's standing are explicit correctness events (contradiction, supersession, your own correction), all audited and reversible.
- **Recalled memories are reinforced.** Appearing in a recall result now gives a memory a small confidence boost — the strengthening half of the old decay/reinforce pair, now active.
- **The local LLM is now opt-in.** Graphnosis no longer uses a local LLM just because one happens to be running. Insights and the richer `develop` / `predict` synthesis stay off until you explicitly enable the local LLM in the Go Non-Deterministic tab — detection is never consent.
- **`correct` no longer needs an AI model.** The correction tool is deterministic by default — it supersedes the closest-matching memory with your fix, reproducibly, with no model required. The optional Neural Network widens its candidate set and the optional local LLM upgrades it to multi-edit diffs, but neither is required. With the local LLM off, `develop` / `predict` / `insights` also degrade gracefully — returning the deterministic recalled context with a clear note instead of failing quietly.
- **Vitality is a ratio-based score.** The 0–100 vitality reading is now computed from connectivity, confidence, recent activity, and coherence, so it ranges meaningfully across a cortex's life instead of pinning near the top.

### Fixed

- **cortexes that wouldn't open.** A crashed embedding worker could stall the sidecar so a cortex never finished unlocking. The worker pool now routes around a dead worker and recovers.
- **Your AI client keeps working across Cortex switches.** The MCP connection now uses a fixed per-user socket path, so a client you configured once (Claude Desktop, Cursor, …) keeps working after you switch or reopen cortexes.
- **A moved, renamed, or deleted cortex folder no longer crashes the app.** If the folder Graphnosis remembered is gone, the app reports it cleanly instead of failing to start.
- **UI polish.** The lock-screen footer no longer breaks awkwardly, the top-left logo is centered, the Settings → Connectors section renders cleanly, and the main tab strip no longer clips the first tab.

### Migrations

None. Existing cortexes gain the cross-engram connection store on first run, and may be offered the bundled Graphnosis documentation; the neural network and local LLM both default to off until you opt in. No memory is altered on upgrade.

---

## v0.8 — Autonomous upkeep

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-21</p>

Theme: **a cortex that maintains itself.** Graphnosis now keeps your memory tidy on its own — merging duplicates it can prove are redundant, weaving connections between related memories, and surfacing the judgment calls it can't safely make. New background passes run on a schedule: what they can fix, they fix; what needs you, they route to Check-in.

### Added

- **Autonomous self-healing.** A background duplicate scan merges memories that are *provably* the same — byte-identical text, or one fully contained within a longer one. Merges are automatic, conservative (a merge never loses information), and reversible (soft-delete, recorded in the op-log). The Autonomous tab's Self-healing section shows the running count. Full detail in [Deterministic Consolidation](/guides/deterministic-consolidation/).
- **"Needs your review" in Check-in.** Near-duplicate pairs that *aren't* provably identical — a differing number, an added negation, a partial overlap — surface in the Check-in tab with both memories side by side and a one-click **Same memory — merge** / **Keep both** decision. Graphnosis heals what's certain; you decide what's ambiguous.
- **Automatic connection weaving.** Memories that are clearly related but distinct get an automatic "related" connection, so isolated memories aren't left floating. Conservative — already-dense memories are skipped, and typed/directional relationships are still left to you in the Check-in deck.
- **Post-ingest scan.** Ingesting a file now triggers a duplicate scan shortly after it completes, so new content is checked promptly instead of waiting for the next scheduled pass.
- **Visible upkeep schedule.** The Autonomous tab now shows the cadence of every background pass (duplicate scan every 20 min, connection forming 45 min, goal check 4 h, insights 6 h, memory decay 24 h).
- **Standalone / Local LLM shortcuts.** Two buttons in the sidebar's "Get connected" section explain the two modes — fully deterministic Standalone (the default) vs. adding a local LLM for insights and deeper connection-forming.

### Changed

- **The third tab is now "Autonomous"** — it collects vitality, self-healing, insights, goals, and live activity in one place.
- **Vitality shows 0 until it's calculated**, so a still-starting-up score is never mistaken for a real one.
- **"Cache everything" is the default** content-cache mode, selected out of the box.
- **The memory trace clears on lock.** Locking your cortex now clears the left-rail recents list and the detail pane, so a re-unlock starts with a clean slate.

### Migrations

None. v0.8 is fully backward-compatible. The self-healing journal is created on first run; existing cortexes gain it automatically.

---

## v0.7 — Sources management, 3D graph performance, and readability

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-20</p>

Theme: **make large cortexes easier to navigate and large graphs easier to work with.** This release adds first-class source management (search, move between engrams), makes the 3D graph usable on 25K-edge graphs without freezing the UI, and addresses a wave of readability and polish issues reported after v0.6.

### Added

- **Sources search filter.** A "Filter sources…" input sits above the Sources list. Typing narrows the list instantly — source names and file paths both match. Engram group headings hide automatically when none of their sources match, so you only see the groups that are relevant.
- **Move a source to another engram.** Each source row now has a **Move to…** button. A compact inline picker appears with a list of your other engrams (sorted alphabetically). Pick an existing engram or choose **New Engram…** to create one right from the picker — the new engram is created with a Personal template and your chosen display name, and the move happens in the same gesture. All chunks, embeddings, and the content cache entry transfer with the source; the graph re-links automatically after the move.
- **Help button in the top bar.** A `?` button next to the Lock button opens [docs.graphnosis.com](https://docs.graphnosis.com) in your default browser.

### Changed

- **Sticky engram headings in Sources.** When you scroll through a long sources list, the current engram's name header sticks to the menu bar so you always know which engram you're looking at. The heading is replaced by the next engram's heading as it scrolls into view.
- **Semantic edges auto-hide on large graphs.** When a graph has more than 5,000 semantic (embedding-similarity) edges, Graphnosis automatically hides that category in the 3D view to keep framerate navigable. The legend shows semantic edges as "off" so you can re-enable them at any time. Switching to a smaller graph that is below the threshold restores them automatically.
- **3D graph layout no longer freezes the UI during initial layout.** The force simulation now scales its parameters to the graph's node count. Large graphs (1,500+ nodes) skip the synchronous warmup pass and run with a faster alpha-decay and fewer collision iterations — the graph appears immediately and settles in the background. Periodic reheat is also disabled above this threshold. Small graphs are unaffected.
- **3D graph reset no longer shifts the view.** Previously the Reset button moved the orbit pivot to the world origin, which caused the camera to visibly jump when the pivot didn't coincide with the view center. Reset now only clears selection emphasis (node size, opacity); the camera stays exactly where it was.
- **Engrams sorted alphabetically in all pickers.** The top-bar engram dropdown, the move-to picker, the connector target selector, and the Settings engram lists all now sort by display name instead of creation order.
- **`ai-conversation` source references rendered as readable labels everywhere.** The detail-pane breadcrumb and trivia-card source label now show `AI: <topic>` (or `AI conversation` when no topic is set), matching the formatting the Sources list and atlas legend already used. The raw `ai-conversation:<timestamp>:<topic>` ref no longer appears anywhere in the UI.

### Fixed

- **Sources list scroll position preserved after a move.** Confirming a move previously reloaded the list and scrolled it back to the top. The view now stays in place.
- **Sources list auto-refreshes after a move completes** rather than requiring a manual pane switch to see the updated state.

### Migrations

None. v0.7 is fully backward-compatible with v0.6 cortexes.

---

## v0.6 — Mobile, connectors, and the broader MCP-client universe

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-19</p>

Theme: **make your cortex reachable from anywhere, growing on its own from the tools you already use.** The biggest single release since v0.1 in scope of new surface — a mobile bridge with a 3-step wizard, six service connectors with BYO credentials, encryption for those credentials at rest, broader MCP-client coverage beyond Claude Desktop / Code / Cursor, and a Settings UI to manage all of it.

### Added

- **Mobile & Remote Access.** New HTTP/SSE MCP bridge on port `3457` with bearer-token auth, configurable interface (loopback-only vs all-interfaces). Auto-generated UUID token, no manual token handling. Connect Claude for iOS, Claude for Android, browser extensions, or any HTTP MCP client — over LAN at home or Tailscale anywhere. Full walkthrough at [Connect from your phone](/getting-started/mobile/).
- **3-step mobile setup wizard.** Settings → Mobile & Remote Access → "Set up mobile access…" — enable the bridge, pick the network interface (Tailscale-aware, recommended), copy MCP URL + masked bearer with one-click Copy buttons. Returning-user fast path: jumps straight to Step 3 on re-open.
- **Six service connectors.** Auto-ingest from existing tools, all BYO-credentials so Graphnosis is never in any OAuth chain:
  - **RSS / Atom** — pull from any feed URLs, deduplicated by guid
  - **GitHub** — issues, PRs, releases from a list of repos (fine-grained PAT)
  - **Slack** — starred items + optional channel history (your own Slack app)
  - **Trello** — cards + checklists from selected boards (API key + token)
  - **Linear** — issues with team / state / priority filters (personal API key)
  - **Generic webhook** — receive POSTs from Zapier, IFTTT, custom scripts, iOS Shortcuts; auto-generated unique URL per connector
  Full walkthroughs per connector at [Auto-ingest from your tools](/guides/connectors/).
- **Settings → Connectors panel.** Install, configure, pull-now, edit, remove — all 6 kinds. Status pills (enabled / disabled / error / pulling), last-pull timestamp, event counts, target engram, per-row actions. Lives between AI Clients and Cortex Tools in Settings.
- **Connector credentials encrypted at rest.** XChaCha20-Poly1305 with the cortex data key, base64-stored in `settings.json` as `credentialsEnc`. Same primitive as `.gai` files. Cloud-sync-safe — providers see ciphertext only. Migration from v0.6 plaintext is automatic on next save.
- **Broader MCP-client coverage.** Added drop-in support documentation for Zed, Cline (VS Code), Continue.dev, Goose (Block), 5ire, Witsy, LibreChat, and Open WebUI — all the same `graphnosis` server entry, just different config-file paths per client.
- **Sources pane → Settings deep links.** Above the Sources list, a quiet hint banner: "Want this list to grow on its own? Connect an AI client → · Set up a connector →". One click jumps to Settings, scrolls the relevant panel into view with a brief accent ring.
- **Custom engram picker** in the top bar — always opens **downward** (replaces native `<select>` whose macOS-default open direction often drifted upward off the top bar). Outside-click and Escape close. Selected option indicator + chevron button.

### Changed

- **Brand line: "Your Local Encrypted Second Cortex"** (dropped the comma between Local and Encrypted — cleaner rhythm). Lock-screen unlock prompt sharpened to "Unlock your encrypted second cortex:" — fits the act of entering a passphrase.
- **Atlas legend labels.** AI-conversation source labels were rendering as raw refs (`ai-conversation:1779139479066:Milestone — …`); now formatted to `AI: <topic>` so the legend reads as a list of things, not internal sourceRefs. Full label preserved in hover tooltip.
- **About panel links** updated for current org / docs URLs: Source → `nehloo-interactive/graphnosis-app` (LLC org), Docs → `docs.graphnosis.com`. New **Terms** link added next to Privacy.
- **Engram-suggest banner preview** now renders the full text scrollable inside the banner (was 280-char truncation), so you can read what the AI is about to save before confirming.

### Fixed

- **Sidecar typecheck violations** from the mobile session's HTTP-bridge + connectors commits (zod v4 `record` signature change, `exactOptionalPropertyTypes` strict mode catching explicit-undefined property assignments). 8 errors → 0, unblocking the v0.6 connectors UI work.
- **Engram dropdown direction.** Was a macOS-OS-controlled annoyance for picker placement near the top bar; now custom-rendered to always drop down predictably.

### Security

- **Connector credential encryption at rest** (described above) closes the gap where v0.5 / pre-v0.6.1 settings.json stored Slack/GitHub/Trello/Linear tokens plaintext. Anyone backing up or cloud-syncing their cortex folder pre-v0.6.1 should re-paste their connector credentials so the new encrypted-at-rest path takes effect, then verify `settings.json` shows `"credentialsEnc"` instead of `"credentials"` for each connector.

### Migrations

None required. v0.6 is fully backward-compatible with v0.5 cortexes. The first settings save after upgrading to v0.6.1 transparently encrypts any plaintext connector credentials.

---

## v0.5 — More AI clients, smarter remember, background notifications

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-18</p>

Theme: **let any AI client confidently target a specific engram, and tell you when the app's in the background**. Plus a broader AI-client expansion beyond Claude Desktop, and ingest performance you can dial in.

### Added

- **Claude Code (CLI) and Cursor support** alongside Claude Desktop. The "Connect an AI client" modal in the menu-bar tray now writes the correct config for all three. Settings → AI Clients lets you re-run the configuration for any of them at any time. All three use the same stdio MCP transport against the bundled sidecar binary — same cortex, same memory, three faces.
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
- **Synapse copy across the app.** "this App's Synapse" / "this App's running Synapse" → "Graphnosis Synapse" everywhere it appeared (configure-client modal, tour, status text). The synapse story is now consistent: the synapse is the bridge between your AI client and your cortex, period.
- **Configure-client modal post-success state.** After a successful Connect, the modal now shows a check + "Done" instead of leaving "Apply" visible (Apply was a stale instruction — there was nothing left to apply).

### Fixed

- **`remember` returned "Ingest produced 0 nodes"** for some markdown inputs. Root cause was in the SDK's `parseMarkdown` — input with no headers returned an empty section list. Three-layer fix: SDK v0.5.1 wraps headerless input in a synthetic section, sidecar adds a symmetric fallback for the kind=markdown → 0-nodes case, MCP `remember` routes short text / long markdown / long headerless text differently.

### Migrations

None. v0.5 is fully backward-compatible with v0.4 cortexes.

---

## v0.4 — Touch ID, attribution, and a better Check-in

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-16</p>

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
- **Lock screen title**: "Unlock your private cortex" → "Unlock your private second cortex of memories:".
- **Last-used cortex path** is now pre-filled and the passphrase field auto-focuses on launch.

### Fixed

- **Dev-server infinite rebuild loop.** Tauri's file watcher was triggering a fresh build every time `build.rs` rewrote the Swift biometric binary. Fixed via `.taurignore` excluding `binaries/` + an mtime guard in `build.rs` that skips swiftc when the binary is already up-to-date.

---

## v0.3 — Recovery, safety, and the synapse story

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-15</p>

The big theme: **make data loss require a series of unlikely mistakes, not just one bad day.** Five new safety layers, a real passphrase-rotation flow, and several long-standing UI bugs fixed in the process.

### Added

- **24-word BIP-39 recovery phrase.** Generated locally when you create a new cortex (or auto-backfilled on first unlock of a pre-v0.3 cortex). Shown exactly once via a gated lock-screen modal — the unlock → app transition is paused until you acknowledge. See [Recovery](/guides/recovery/).
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
- **Keeping your cortex safe guide.** New doc consolidating the five safety layers and what to do when things go wrong.

### Changed

- **Settings tab reorganization.** The Preferences modal is now just app-behavior knobs (cache mode, forget behavior, MCP relay, AI client routing). Engrams management, quarantined files, and the "forgotten memories" / purge surface all moved into the new Cortex Management modal. Recovery-phrase regeneration is a top-level Settings tab panel.
- **Tray menu**: "Open inspector…" → "Open Graphnosis…".
- **Unlock screen title**: "Unlock your Graphnosis cortex folder" → "Unlock your private cortex". Passphrase field gained an inline warning about the passphrase being the only key + recovery-phrase fallback.
- **Content cache default cap raised** from 50 MB → 512 MB per source. Now covers realistic large reference manuals (e.g. a 4233-page PDF at ~210 MB) without users having to change settings.
- **Tour copy updated** to reference the hippocampus / engram / synapse / seahorse story and to explain that Graphnosis must be running and the cortex unlocked for AI clients to read memories.
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
- **Recovery phrase wraps the data key, not the passphrase.** The previous documentation said the opposite. The phrase is an independent unlock path: phrase → Argon2id → recovery wrap key → `recovery.enc` → data key. Lose the passphrase, the phrase still works; lose both, no one (including us) can open your cortex.
- **Atomic writes** close a class of "I unlocked yesterday but today the file is corrupt" scenarios that had no recoverable cause beyond "the save was interrupted."

### Migrations

These run automatically on first unlock of a pre-v0.3 cortex; no user action required.

1. **`master.enc` written.** Existing cortexes use the legacy "passphrase = data key" model. On first v0.3 unlock, the app derives the same key, writes `master.enc` wrapping it, and from that point on uses the wrapped-key path. Old code can still open the cortex until you change the passphrase.
2. **`recovery.enc` generated.** Pre-v0.3 cortexes had no recovery phrase. The first v0.3 unlock generates a fresh 24-word phrase, wraps the data key, writes `recovery.enc`, and shows the phrase via the one-time lock-screen modal. **Write it down before clicking Continue.**

If you miss the modal (closed too fast, lost focus), regenerate from **Settings → Recovery phrase** any time.

---

## v0.2.x and earlier

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-05-11 → 2026-05-13</p>

Pre-v0.3 changes weren't tracked in this changelog. The headline features for those releases:

- v0.2.x · 2026-05-13: PDF ingest worker, op-log recovery flow (sync), source index, embedding cache, MCP relay
- v0.1.x · 2026-05-11: Initial release — local-first encrypted cortex, MCP server, federated recall, BGE-small embeddings, Tauri shell

---

## `@nehloo/graphnosis` SDK — first publish

<p style="margin-top:0.5rem;font-size:1.25em;opacity:0.85;">2026-04-12</p>

The Graphnosis App is built on top of the open-source **`@nehloo/graphnosis`** SDK (Apache-2.0) — the deterministic dual-graph engine that powers every engram: TF-IDF + embeddings + the directed/undirected edge model, encryption, the op-log, federated recall, and the `recall` / `remember` / `edit` primitives the App's MCP tools delegate to.

The SDK was first published to npm on **2026-04-12**, a month before the App scaffold landed. Every release listed above pins a specific SDK version in `apps/desktop-sidecar/package.json`; the App's behavior is the SDK's behavior plus the desktop shell, the MCP server, MemoryStudio, Skills, connectors, and the brain engine on top.

If you build with Graphnosis directly — without the App — the SDK is what you reach for. The App is one consumer of it; the SDK is the foundation.

Future releases will be tracked here from the date they ship.
