---
title: Auto-ingest from Your Tools
description: Connect RSS, GitHub, Slack, Trello, Linear, Obsidian, GBrain, AI context files, or any webhook to grow your cortex automatically — your credentials, your apps, encrypted at rest.
sidebar:
  order: 2
---

The first version of Graphnosis was a memory you talk to. The point of connectors is to make it a memory that **grows on its own** from the tools you already use. The built-in connectors pull or receive new content, ingest it into the engram of your choice, and let your AI clients recall it the same way they recall anything else you've added.

There are two families:

- **Network connectors** (RSS, GitHub, Slack, Trello, Linear, Webhook) — reach out to a service on a schedule (or receive a push) using credentials you supply.
- **Local-file connectors** (Obsidian, GBrain, AI Context Files) — watch a folder on your own disk and ingest new or changed files within seconds.

All credentials and paths are stored locally, encrypted at rest in your cortex.

## How connectors work

Every connector follows the same pattern:

1. You install it once in **Settings → Connectors** in the Graphnosis app.
2. You choose a **target engram** for ingested events.
3. You paste credentials, point it at a folder, or accept an auto-generated webhook URL.
4. Graphnosis pulls on a schedule — or webhook-style connectors fire on push, and local-file connectors fire on file change.
5. Each new event becomes a memory node in your engram, available to every AI client connected to your cortex.

**The poll schedule.** Network connectors pull on a shared schedule, configurable in **Settings → Connectors** (default: every 15 minutes; you can lower it, with a 60-second floor). Local-file connectors don't wait for the schedule — they watch their folder and ingest within seconds of a change — but the same poll runs as a backstop in case a filesystem event is missed.

**Why BYO credentials.** Most cloud memory products use a "first-party OAuth app" model — you log into Slack via their app, they hold a token on your behalf, they're a 4th-party data processor in every workflow. Graphnosis goes the other way: **you create your own app/key** in each service's developer console and paste credentials into Graphnosis. The trade is 1–5 minutes of upfront setup-in-service per connector, and the win is **end-to-end privacy** — Graphnosis is never in the OAuth callback chain, the service-side relationship is between you and that service.

**Credentials are encrypted at rest.** Every connector credential (PATs, tokens, API keys) is encrypted with your cortex data key before it touches disk. Same crypto primitive as your `.gai` memory files. You can safely sync your cortex folder via iCloud Drive / Dropbox / S3 — cloud providers see ciphertext only.

**Privacy notice.** Every connector form displays a one-line privacy notice confirming that credentials are encrypted locally and that Graphnosis never relays them to Nehloo servers. This notice is informational — it doesn't gate setup.

**Folder pickers.** The Obsidian and GBrain connector modals include a **Browse…** button next to their folder path fields. Click it to open a native folder picker instead of typing a path by hand.

## Syncing & re-scans

**Three ways a connector pulls:**

- **Pull now** — a full re-scan of the source on demand. Use it after adding files when you want them ingested immediately.
- **Re-sync** — resets the connector's cursor and re-checks everything from scratch.
- **Automatic** — auto-sync connectors pull on the schedule (incremental and fast), and **periodically promote to a full re-scan** so nothing is ever permanently missed.

**Self-healing.** An incremental pull only looks at what changed since the last sync — so a file that was skipped or failed mid-run would never be revisited by incremental pulls alone. To prevent that, auto-sync connectors run a **full re-scan on a cadence**: default every 30 minutes, set per connector in its **Edit** form under **Full re-scan (self-heal) every … minutes** (leave blank for the 30-minute default; set **0** to disable and rely on manual *Pull now* / *Re-sync*). A connector therefore always *eventually* ingests every source, regardless of what failed before.

**Re-scans don't redo work.** A full re-scan does **not** re-process unchanged files. Graphnosis records each file's content hash and **skips the embedding work entirely when the content hasn't changed** — so repeat syncs of an already-ingested folder, and the periodic self-heal sweep, do almost no work and won't heat your machine. Only new or modified files are embedded.

**On-graph progress.** While a connector syncs, the 3D view shows a `[X%] ingesting <file> to <engram>…` bar so you can watch what's landing (redacted in Presentation Mode). When the pull finishes, the button returns from **⟳ Syncing…** to **⟳ Sync now**.

## RSS / Atom feeds — the simplest connector

**What it pulls:** new entries from any RSS or Atom feed URL(s) you provide. Deduplicates by entry `guid` (or `link` as fallback), so re-pulls of already-seen entries are no-ops.

**Setup time:** 30 seconds. No credentials.

### How to add

1. Open **Settings → Connectors → RSS**
2. Paste one feed URL per line. Examples:
   - `https://news.ycombinator.com/rss`
   - `https://simonwillison.net/atom/everything/`
   - `https://anthropic.com/news/rss.xml`
3. Pick the target engram
4. Click **Save**

The connector starts pulling on the next 15-minute tick. Click **Pull now** on the row to fetch immediately.

### Tips

- **Quality > quantity.** A handful of high-signal feeds (industry leaders' blogs, primary-source news) is better than 50 noisy ones. Your engram will reflect what you feed it.
- **Multi-engram strategy.** Use separate engrams per topic: a `tech-news` engram for HN/Simon Willison, a `industry-x` engram for the trade publications you actually read, etc.

---

## GitHub — repos you care about

**What it pulls:** issues, pull requests, and releases from a list of repos. Configurable per-event-type so you can pull only releases for one repo and full issue/PR history for another.

**Setup time:** ~3 minutes.

### Step 1: create a Personal Access Token

1. Go to **[github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)** (Fine-grained tokens — recommended over Classic PATs)
2. Click **Generate new token**
3. **Token name:** "Graphnosis" or similar
4. **Expiration:** 90 days or longer
5. **Repository access:** select the specific repos you want indexed (don't grant all-repos access — least privilege)
6. **Permissions:** under "Repository permissions" → `Contents: Read`, `Issues: Read`, `Pull requests: Read`, `Metadata: Read` (the last one is required)
7. Click **Generate token** and copy it (`github_pat_...`)

### Step 2: add the connector in Graphnosis

1. **Settings → Connectors → GitHub**
2. Paste the PAT
3. Repos to watch: comma-separated `owner/repo` format. Example: `anthropics/claude-code, nehloo-interactive/graphnosis-app`
4. Event types: check the boxes for what you want indexed (Issues, PRs, Releases)
5. Pick the target engram
6. Click **Connect**

### Tips

- **Releases-only is great for "stay current."** Check just the Releases box and add a list of dependencies you care about — your engram becomes a personalized changelog.
- **Issues/PRs ingest is heavy.** A busy repo with hundreds of open issues will produce hundreds of memory nodes on first pull. Start with one repo, see how it lands in your engram, then add more.
- **Token rotation:** fine-grained tokens have an expiration. When yours expires, GitHub stops responding; the connector shows "auth expired" in Settings. Re-generate and re-paste.

---

## Slack — your workspace as memory

**What it pulls:** starred items (default) and channel history (optional) from a single Slack workspace.

**Setup time:** ~5 minutes. The most involved of the connectors because Slack requires a custom app.

### Step 1: create a Slack app

1. Go to **[api.slack.com/apps](https://api.slack.com/apps)**
2. Click **Create New App → From scratch**
3. **App name:** "Graphnosis" (or anything)
4. **Workspace:** pick the workspace you want to ingest from
5. Click **Create App**

### Step 2: configure scopes

1. In the new app's sidebar, click **OAuth & Permissions**
2. Scroll to **Scopes → Bot Token Scopes** (or User Token Scopes if you want to pull your personal stars / personal DMs)
3. Add scopes based on what you want pulled:
   - `stars:read` — required for starred items
   - `channels:history` + `channels:read` — required for public channel history
   - `groups:history` + `groups:read` — required for private channel history (only if invited to the channels)
   - `users:read` — recommended for human-readable usernames in ingested messages

### Step 3: install the app to your workspace

1. Scroll to the top of **OAuth & Permissions**
2. Click **Install to Workspace**
3. Approve the permissions
4. Copy the **Bot User OAuth Token** (`xoxb-...`) — or the **User OAuth Token** (`xoxp-...`) if you used User scopes

### Step 4: add the connector in Graphnosis

1. **Settings → Connectors → Slack**
2. Paste the token
3. Check the boxes for what to pull (Starred items, Channel history)
4. Pick the target engram
5. Click **Save**

### Tips

- **Starred items is the high-signal path.** A workspace-wide channel-history pull is enormous and mostly noise. Star the messages you actually want indexed and let the connector do the rest.
- **User vs Bot tokens:** User tokens pull what *you* see (DMs, your starred items, private channels you're in). Bot tokens pull what *the bot* sees (must be added to channels). Pick based on what you want indexed.
- **Don't grant `chat:write` scopes** unless you want the bot to be able to post on your behalf. Read-only is sufficient for ingestion.

---

## Trello — boards and cards

**What it pulls:** cards + checklists from a list of boards you specify, with their descriptions, labels, and checklist progress.

**Setup time:** ~3 minutes.

### Step 1: create a Trello Power-Up to get an API key

1. Go to **[trello.com/power-ups/admin](https://trello.com/power-ups/admin)**
2. Click **New** to create a Power-Up (you don't need to publish it — it's just to get an API key)
3. Fill in the basic fields (any name + your workspace)
4. After creation, go to the **API Key** tab
5. Copy the **API Key**
6. On the same page, click the **Token** link to generate a personal token (it'll open Trello's auth flow); copy the **token**

### Step 2: find the board IDs you want to ingest

The board ID is in the URL when you have a board open:
```
https://trello.com/b/<BOARD_ID>/your-board-name
                       ^^^^^^^^^^
```
Copy that segment for each board you want indexed.

### Step 3: add the connector in Graphnosis

1. **Settings → Connectors → Trello**
2. Paste API Key + Token
3. Paste board IDs (comma-separated)
4. Pick the target engram
5. Click **Save**

### Tips

- **One engram per board** works well if boards represent distinct projects. Add the connector multiple times (one per board, with a different `id` slug each time) and route each to its own engram.
- **Archived cards** are pulled in some Trello plans but not others. If you're missing cards you'd expect, check whether they're archived on the board.

---

## Linear — issues and projects

**What it pulls:** issues from your Linear teams with their priority, state, assignee, and labels.

**Setup time:** ~1 minute. Easiest of the credentialed connectors — no OAuth flow, no app to create.

### Step 1: create a personal API key

1. Go to **[linear.app/settings/api](https://linear.app/settings/api)**
2. Click **Create new key**
3. **Label:** "Graphnosis" or similar
4. Copy the key (`lin_api_...`)

That's it. Linear's personal API keys are first-class — no OAuth dance, no app review.

### Step 2: add the connector in Graphnosis

1. **Settings → Connectors → Linear**
2. Paste the API key
3. *(Optional)* team key (e.g. `ENG`, `OPS`) — leave blank to pull from every team you have access to
4. Pick the target engram
5. Click **Save**

### Tips

- **Team filter is your friend.** Without it, the connector pulls every issue from every team you're a member of — for a large org this can be thousands of items on first pull. Specify a team key to narrow scope.
- **State + priority filters** are coming in a follow-up release. For now, the connector pulls all states (Backlog, In Progress, Done, Cancelled, etc.).

---

## Local-file connectors — watch a folder

The next three connectors don't reach out to any service. They watch a folder on your own disk and ingest files as they appear or change — no credentials, no network. They share one behavior worth understanding up front:

- **Live watch.** Each one registers a recursive filesystem watcher on its folder. When you create or edit a matching file, the connector ingests it within a few seconds (a short quiet-window debounce coalesces a burst of changes — say, syncing a whole vault — into a single pull).
- **Poll backstop.** The shared connector poll (default 15 min, configurable in **Settings → Connectors** with a 60-second floor) re-scans the folder regardless, so nothing is lost if the OS drops a filesystem event. On platforms where the recursive watcher isn't available, the connector falls back to this poll alone — slower, but still correct.
- **Incremental.** Only files modified since the last successful pull are ingested. A first pull of a large folder drains in batches so the app stays responsive.

Set the folder once and these run themselves.

---

## Obsidian — your vault as memory

**What it ingests:** Markdown notes (`.md`) from an Obsidian vault folder you point at. New and edited notes flow in as you write them.

**Setup time:** under a minute. No credentials.

### How to add

1. **Settings → Connectors → Obsidian**
2. Set the **vault path** — click **Browse…** to pick the folder with a native folder picker, or paste the path
3. Pick the target engram
4. Click **Save**

The connector ingests the existing notes on first save, then watches the vault for changes.

### How to disable

Toggle the connector off (or **Remove** it) in **Settings → Connectors**. Disabling stops the watcher and the poll; removing also deletes the stored folder path.

### Tips

- **One vault, one engram.** Route your vault to a dedicated engram (e.g. `obsidian`) so vault notes don't blur into manually-added content.
- **`.obsidian/` config files are skipped** — only your actual notes are ingested.

---

## GBrain — your local knowledge repo

**What it ingests:** Markdown files (`.md`) from a GBrain git repository folder. GBrain stores knowledge as Markdown in a local repo; this connector reads those files directly — no database, no API key.

**Setup time:** under a minute. No credentials.

### How to add

1. **Settings → Connectors → GBrain**
2. Set the **repo path** — click **Browse…** to pick the folder, or paste the path
3. Pick the target engram
4. Click **Save**

The `.git` folder is skipped; only the knowledge Markdown is ingested. New and changed files flow in within seconds.

### How to disable

Toggle off or **Remove** in **Settings → Connectors**.

---

## AI Context Files — your assistant instructions as memory

**What it ingests:** the standard AI-assistant context files from project folders you point at — `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `MEMORY.md`, `.cursorrules`, `.cursor/rules/*.md`, `GEMINI.md`, `.windsurfrules`, and `.github/copilot-instructions.md`. Your global `~/.claude/CLAUDE.md` is always included automatically.

This makes the instructions you've written for *other* AI tools recallable inside Graphnosis — useful when you want one AI to know the conventions you've set for another.

**Setup time:** under a minute. No credentials.

### How to add

1. **Settings → Connectors → AI Context Files**
2. Add one or more **project / home directory paths** to scan (the global `~/.claude` directory is added for you)
3. Pick the target engram
4. Click **Save**

The connector ingests the matching files it finds, then watches those directories for changes.

### How to disable

Toggle off or **Remove** in **Settings → Connectors**.

### Tips

- **Point it at your active project roots.** It only ingests the known context filenames, so pointing it at a code repo picks up that repo's `CLAUDE.md` / `AGENTS.md` and nothing else.

---

## Webhook — anything that can POST

**What it does:** generates a unique URL that any external service can POST events to. Push-only (no pull schedule).

**Setup time:** under a minute.

### How to add

1. **Settings → Connectors → Webhook**
2. Pick the target engram
3. Click **Save**
4. The connector creates and shows a unique webhook URL like:
   ```
   http://localhost:3458/webhook/my-webhook/a1b2c3d4-...-9876
   ```
5. Click **Copy** and paste into your external tool's webhook target

### What to POST

Send a JSON body like:

```json
{
  "text": "The full content to remember",
  "label": "Optional short title shown in the Sources list",
  "source": "Optional source attribution"
}
```

Only `text` is required. Anything you POST hits your local Graphnosis instance directly — no cloud relay.

### What to wire it to

- **Zapier / IFTTT / Make:** any "Webhook" action — sends new tweets, new Substack posts, new Discord messages, anything those platforms support.
- **GitHub Actions:** push a `curl` step after a build to log build outcomes.
- **Cron + curl:** scheduled shell scripts that summarize logs / metrics / whatever and POST the summary.
- **Browser bookmarklet:** save the current article URL + selection. (See the docs section on `bookmarklet` for a one-line script — coming in v0.7.)
- **iOS Shortcuts:** Action → "Get Contents of URL" → POST to the webhook URL. Lets you ingest from the Share Sheet on your phone.

### Network reachability

The webhook URL is `localhost:3458` by default — only reachable from the same Mac. For external services to reach it:

- **From your LAN:** use the wizard's mobile-setup flow to bind the **MCP HTTP bridge** to all interfaces. (Note: webhooks ride a separate port, `3458`. Same security tradeoff.)
- **From the public internet:** use a tunnel like Cloudflare Tunnel, ngrok, or Tailscale Funnel. The webhook token in the URL is your authentication.

## On the roadmap — not yet available

These connectors are planned but **not built yet**. They don't appear in **Settings → Connectors** today. Listed so you know what's coming, not as something you can enable now:

- **Notion** — pages and databases
- **Google Drive** — docs, sheets, and files
- **Apple Notes / Reminders** — notes and reminders
- **Things** — tasks and projects
- **Todoist** — tasks and projects
- **ChatGPT export** — your exported conversation archive
- **Discord** — messages and threads
- **Telegram** — saved messages and channels
- **Web bookmarklet** — save the current page URL + selection from any browser
- **Browser "save current page" extension** — one-click capture of the page you're reading

If one of these is the connector you most want, let us know — demand shapes the order they ship in.

## Troubleshooting

**"auth expired" status on a connector**
- GitHub PATs, Slack tokens, Trello tokens, and Linear keys all have expiration / rotation policies. When yours expires, the service returns 401 and the connector surfaces "auth expired." Re-generate in the service, paste the new value via **Edit** on the connector row, save.

**Connector shows "error" with cryptic message**
- The error message comes verbatim from the service's API. Common cases:
  - GitHub: `404` usually means the token doesn't have access to the repo (most often: you watch the repo but the PAT scoping doesn't include it).
  - Slack: `not_authed` means the token is wrong; `missing_scope` means you didn't grant the scope at app install (re-install the app with new scopes).
  - Trello: `invalid token` means the personal token was revoked; regenerate.
  - Linear: `Authentication failed` means the API key is wrong or rotated.

**Pulls happen but events don't show up in the engram**
- Check the **target engram** dropdown in the connector's row — events go to the engram set at install time. Connectors automatically skip archived engrams; if the target engram is archived, re-activate it or edit the connector to point to a different engram.
- Verify in **Sources** that the connector's `source.<id>` entries are appearing. If yes but no nodes are showing in your atlas / recall, your engram might need a refresh (Settings → Cortex Tools → Refresh stats).

**Too many events on first pull**
- Connectors don't have a "first-pull limit" today. A busy GitHub repo or a starred-rich Slack workspace can drop hundreds of memory nodes the first time. If this happens, you can `forget` the source from the Sources list (one source covers all events from that connector since install) and re-install with tighter filters.

## Security and storage notes

- **Credentials at rest:** XChaCha20-Poly1305 encrypted with your cortex data key in `<cortex>/settings.json` (as a `credentialsEnc` blob). Cloud-sync-safe — providers only ever see ciphertext.
- **In-memory credentials:** decrypted on cortex unlock; held in memory for the connector to use. Never logged.
- **No telemetry:** connector calls go directly from your Mac to the service. Graphnosis has no server in the path.
- **Per-connector revocation:** to revoke a connector's access, **Remove** it in Settings (deletes the credentials locally) AND revoke the token in the service's developer console (forces immediate cutoff even if the local copy somehow leaks).

---

## Related

[Connect Offline Sources](/guides/connect-offline-sources/) — the on-device counterpart: files, MQTT, OPC-UA, LoRaWAN.

[Adding Content](/guides/adding-content/) — manual ingest of files, URLs, and clips.

[What Leaves Your Device](/guides/network-activity/) — every outbound connection a connector makes.

[Graphs & Sensitivity Tiers](/guides/graphs-and-tiers/) — route each connector to the right engram tier.

