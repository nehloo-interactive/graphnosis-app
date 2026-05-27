---
title: AI Access Controls
description: How Graphnosis decides whether an AI client can read your memories — the consent phrase, rate limit, session replay blocker, opt-in caps, and the audit trail behind them.
sidebar:
  order: 6
---

Graphnosis is **local encrypted memory, indexed for deterministic recall — auditable**. The "auditable" part is enforced by a layered access-control system that sits between your AI client and your cortex. This page explains each layer, what threat it addresses, and where to configure it.

## The five layers, summarized

| # | Layer | What it stops | Default |
|---|------|---------------|---------|
| 1 | **Sensitivity tiers** | Sensitive engrams from leaking at all | Engrams default to `personal` |
| 2 | **Consent gate** | Untrusted AI clients from reading sensitive data without your active approval | In-app one-click prompt for `sensitive` tier; `personal` tier silent (your AI-client install was already informed consent) |
| 3 | **Recall rate limit** | Burst attacks (many distinct queries in a short window) | 10 recalls per 60 s per client |
| 4 | **Session replay blocker** | Systematic memory scraping via repeated near-identical queries | Jaccard ≥ 0.85, blocks the 3rd identical query within a 60-sec window (first two = natural retries) |
| 5 | **Optional session caps** | Cumulative volume per conversation | Off by default — power users opt in |

Layers compose. A query has to pass every relevant layer before any memory data is returned.

> **What's new in v0.10 (later in the cycle):** the consent gate moved from forced phrase-typing to a **one-click in-app prompt** for sensitive-tier access, with **`personal` tier silent by default** (your decision to install Graphnosis + add it to your AI client's config already counts as informed consent for personal data). Phrase typing is preserved as a headless fallback for SSH/CI sessions. Power users who want the old behavior can flip **"Extra precaution mode"** in Settings → AI to gate `personal` recalls behind the same prompt. See [Layer 2](#2-the-consent-gate) below for the full flow.

---

## 1. Sensitivity tiers (recap)

Each engram has a tier: `public`, `personal`, or `sensitive`. The sidecar enforces tier-specific behavior before any recall result leaves your device:

- **`public`** — no consent prompt, no gate. Best for documentation, reference material, public notes.
- **`personal`** — consent gate fires before first access from each AI client; rate limit and replay blocker apply. Best for journals, work notes, personal correspondence.
- **`sensitive`** — same gate as personal but with a tighter consent window (re-confirmed hourly by default) and visual red badge in the app. Best for health, financial, or other Article-9-class data.

See [Graphs & Sensitivity Tiers](/guides/graphs-and-tiers) for the full setup walkthrough.

---

## 2. The consent gate

Before an AI client can read memories from a `sensitive` engram, Graphnosis requires you — not the AI — to authorize the access. By default, `personal` tier flows through with no extra friction: installing Graphnosis and adding it to your AI client's MCP config is already informed consent for that tier. Sensitive data (health, financial, biometric — Article 9 special category) is held to a higher standard.

### Default behavior, by tier

| Tier | Default | Override (Settings → AI) |
|---|---|---|
| `public` | Silent (no gate) | None — public is always free |
| `personal` | **Silent** — your AI-client install was already affirmative consent | "Extra precaution mode" gates personal too |
| `sensitive` | One-click in-app prompt (modal) per grant | Phrase typing available as headless fallback |

The reasoning: a user who manually copied Graphnosis into their `claude_desktop_config.json` and approved the MCP tool the first time Claude ran it has already performed two affirmative, informed actions for personal data. Adding a third per-recall click for routine notes is friction without a privacy gain. Sensitive data warrants the extra click; Article 9 explicitly requires explicit consent.

### The in-app prompt (sensitive tier, and personal in extra-precaution mode)

When an AI client touches a gated tier without a current grant, the Graphnosis app **pops a modal to the foreground** with:

- Which AI client is asking (e.g. *"Claude Desktop wants to read your memories"*)
- Which tiers (PERSONAL / SENSITIVE pills)
- A short disclosure: data is sent from your Mac directly to the AI provider; Graphnosis itself receives nothing
- Link to that provider's privacy policy
- Four buttons: **Deny**, **Allow once**, **Allow for 1 hour**, **Allow for today**

One click resolves it. The recall proceeds (or errors cleanly with "denied"). The consent record is written the same way the phrase flow writes it — same audit log, same revoke flow in Settings.

### First-connect chooser

The first time a never-before-seen AI client connects and would trigger the consent flow, the app pops a one-time **policy chooser** so you can set defaults per tier:

| Choice | Behavior after first save |
|---|---|
| **Ask, then allow for 1 hour** *(default for personal in extra-precaution mode)* | Prompt fires, Allow grants for 1h, then silent until window expires |
| **Ask, then allow for today** | Same, 24h window |
| **Ask every time** *(default for sensitive)* | Prompt every recall — strictest |
| **Always allow** | Silent grants forever — least friction |
| **Never allow** | Blocks immediately, no prompt |

Saved policy is editable later in Settings → AI → Client policies. The chooser only appears in modes where a consent flow actually runs (i.e. `sensitive`-touching calls, or any call when extra-precaution mode is on) — so a new client that only uses your `personal` data in the default mode never even sees it.

### Federated recall is silently scoped to what's consented

When an AI client issues a `recall` without naming engrams (federated search across your cortex), Graphnosis **silently excludes any un-consented sensitive engrams** from the search rather than firing a consent prompt. The AI gets results from the tiers it can read; it sees nothing from sensitive engrams that need authorization.

To trigger the consent prompt, the AI has to explicitly name a sensitive engram via `only_engrams: ["health"]` — i.e. you'd say to the AI: *"look in my Health engram"*. That's a deliberate access request, which deserves a deliberate authorization.

This stops the surprise where merely *having* a sensitive engram in your cortex caused every personal-data query to prompt for sensitive consent.

### The phrase typing fallback

The original mechanism — typing a time-limited phrase the AI cannot generate — is preserved as a fallback for environments without a desktop window:

- The sidecar is running over SSH / in CI / in a Docker container with no GUI
- You explicitly prefer phrase typing for sensitive grants
- The in-app prompt timed out (60s default — usually because the app isn't running)

In those cases the consent gate returns the same `"⚠️ GRAPHNOSIS CONSENT REQUIRED"` message it always did, with instructions for the user to open Settings → AI → Consent Phrases, read the current phrase, and have the AI call `confirm_data_access({ phrase, tier })`. See [Phrase mechanics](#phrase-mechanics-headless-fallback) below.

### Extra precaution mode

A single checkbox in **Settings → AI**: *"Require an in-app consent click for personal-tier recalls too"*. When on:

- Personal tier joins sensitive tier in the gated set
- The in-app prompt fires for personal recalls (with the same policy + first-connect chooser flow)
- The phrase fallback is available for personal grants too
- Sensitive tier behavior is unchanged (it's always gated)

This is for users who want every AI access logged behind an explicit click, even for routine notes — e.g. shared machines, security audits, compliance reviews. Off by default.

### Configuring grant duration (consent interval)

When you choose **Allow for 1 hour** / **Allow for today** on the modal, the grant duration is exactly that. The legacy consent-interval settings (Settings → AI → "Re-confirm personal data" / "Re-confirm sensitive data") still control:

- Phrase-typing grants (headless fallback) — how long one typed phrase is remembered
- Per-engram overrides set in Cortex Management → Edit Engrams (the stricter setting wins)

Defaults: `personal` = permanent (the gate is off by default anyway), `sensitive` = 1 hour.

### Phrase mechanics (headless fallback)

Phrases are three short words (e.g. `pixel ledge phase`), generated locally:

```
phrase = HMAC-SHA256( cortex_secret, tier + ":" + floor(now_ms / window_ms) )
```

- The **cortex secret** is a 32-byte random key generated once at cortex creation and stored encrypted in your settings. It never leaves your device. No MCP tool can read it.
- The **window** is 24 hours for `personal` tier and 1 hour for `sensitive` tier — phrases rotate automatically.
- The first 9 bytes of the HMAC select three words from a bundled 256-word list (`acorn`, `adapt`, `affix`, …, `zesty`, `zippy`). The list is public; the secret is not.

This is the same construction as a TOTP code, with words instead of digits. The phrase is **never** sent through MCP. The AI sees only what you type.

### Lockout after failed attempts

After **5 consecutive failed** `confirm_data_access` attempts for the same `(client, tier)` pair within a 10-minute window, Graphnosis revokes that pair's consent and shows a notification. Lockout is **scoped** — it doesn't revoke unrelated consents.

### Honest scope of protection

The consent gate is effective against:

- **Prompt injection** attempting to "supply" a phrase or trigger an auto-accept from inside an ingested document (phrases rotate; the in-app modal click is an OS event no AI client can synthesize into Graphnosis's window).
- **Autonomous agents** scripted to fake consent (neither the phrase nor the modal-click bypass is reachable via MCP — the AI literally cannot resolve a prompt itself).
- **Reconnection-based bypass** (consent is tracked per `(client, tier)`, not per session; reconnecting doesn't reset).

It is **not** effective against:

- A compromised AI agent with **screen-capture, clipboard, or Accessibility API** access on the same OS account. Once an attacker has those OS-level privileges, no MCP-layer mechanism can stop them. That is the "compromised machine" threat model, not Graphnosis's.

The app discloses this in the consent flow itself so you can decide accordingly.

---

## 3. Recall rate limit

A per-AI-client cap on how many `recall`-class tool calls (recall, remind, recall_structured, recall_with_citations, compare_engrams, cross_search, llm_query) can fire in a rolling 60-second window.

**Default**: 10 calls per 60 s per client.

When the limit is exceeded:
- The sidecar throws a clear error: "Recall rate limit exceeded — N recalls in the last 60s. Wait ~Xs and try again."
- A toast appears in the Graphnosis app: "Recall rate limit hit".

Rate limiting catches **burst attacks** — agents that fire many distinct queries in rapid succession to exhaust the result set or paginate through the graph. Counts are kept in-memory per sidecar process; restarting Graphnosis resets all counters.

---

## 4. Session replay blocker

A guardrail that rejects a recall when the same query is repeated **3 or more times** within a short window by the same client.

**Default**: Jaccard token-set similarity ≥ 0.85, allowed repeats = 2, window = 60 seconds. The first two identical queries pass (natural retries — the AI rewording slightly, you asking again because the answer was incomplete); the 3rd identical query in 60 seconds blocks.

The blocker normalizes both queries to lowercase, strips punctuation, drops short words, and compares the resulting word sets. Jaccard similarity is the size of the intersection over the size of the union.

When it fires:
- The sidecar throws: "Session replay detected — this is the Nth identical query in 60 seconds. Modify your query meaningfully or wait 60s."
- A toast appears in the Graphnosis app: "Session replay blocked", with the prior-repeat count.

This catches **systematic scans** — agents that fire the same query 20+ times in succession to bypass per-call result caps and gradually exfiltrate the graph. The "allow 2, block 3rd" threshold preserves the natural retry pattern (user asks again, AI re-runs the same tool) while still catching the sustained-burst attack. Slow-drip patterns (≤ 2 repeats per minute) are caught by the 10-recalls-per-60s rate limit in Layer 3.

---

## 5. Optional session caps

Three opt-in caps in **Settings → AI → Optional session caps**. All off by default — they are extra backstops for users who want cumulative-volume limits on top of the rest of the stack.

| Cap | Default value when enabled | What it limits |
|---|---|---|
| **Token cap** | 100 000 tokens | Total tokens served to one AI client per session |
| **Node cap** | 500 nodes | Total nodes served to one AI client per session |
| **Engram-breadth cap** | 6 distinct engrams | How many engrams a single conversation can touch |

When any enabled cap is exceeded, the sidecar refuses further recall calls until the AI starts a new conversation (which resets the session). The Graphnosis app shows an "AI memory export blocked" toast.

These caps target the residual risk from a *trusted-but-misbehaving* AI client (one that already has consent). In that scenario, the consent gate has already done its job; the caps are belt-and-suspenders.

---

## The audit trail

Every consent grant, revocation, and lockout is recorded in your cortex. Settings → AI → Active AI consents shows the currently-active grants; "View full history…" opens the complete record, including expired and revoked grants.

Each record stores:
- `consentId` — unique per grant
- `grantedAt` / `expiresAt` / `withdrawnAt` timestamps
- `clientName` — which AI client requested access
- `tier` — `personal` or `sensitive`
- `windowMs` — the interval at grant time

Consent records **never leave your device**. Nehloo has no copy and no technical means to access them. They live in your cortex; deleting your cortex erases them along with everything else.

---

## "Use Local LLM only for search"

A toggle in **Settings → AI → Local LLM scope** that restricts the optional Local LLM (Ollama) to in-app search assistance only. When enabled:

- In-app search synthesis ("🤖 Synthesize answer") and re-ranking still work.
- The MCP tools `develop`, `predict`, `insights`, and `llm_query` refuse to run with a message directing the AI to ask you to disable the toggle.

This lets you keep smart local search without exposing the LLM to connected AI clients.

---

## Connection lifecycle (the "AI tools connected" panel)

The Graphnosis dashboard shows every live MCP connection — which AI client, what version, when it connected, how many requests it's served. Three lifecycle states:

- **Green pulse** — connection is live and recently active.
- **Amber pulse** — connection is live but **idle for 15+ minutes**. The relay (Claude Desktop's MCP subprocess, etc.) is still attached; the AI just hasn't asked for anything in a while. The row shows `· Idle 23m`. Returns to green automatically on the next request.
- **× button** (hover any row) — force-close that connection. **Non-destructive**: the relay auto-reconnects on its next request and a fresh row appears. Use this to clear stale entries left over from AI clients that removed the connector but didn't kill their relay subprocess (notably Claude Desktop until you restart it).

When you close Graphnosis (lock the cortex, quit the app), all open relays **park indefinitely** waiting for the sidecar to come back. The next time you unlock and the AI client makes a tool call, the relay reconnects transparently — you don't need to restart your AI client. Power users who want a finite timeout can set `GRAPHNOSIS_RELAY_RECONNECT_MS` in the env or `settings.json:mcpRelay.reconnectMs`.

## Where each control lives in the app

- **Top bar** — sensitivity badge next to the active engram name. Click to change tier or set a per-engram consent interval.
- **Settings → Open preferences → AI access & consent** — "Extra precaution mode" toggle, phrase display (headless fallback), intervals, active consents, full history.
- **Settings → AI → Client policies** — per-AI-client default policy for the consent prompt (always-allow / ask-1h / ask-1d / ask-every-time / never-allow), editable after the first-connect chooser saved a default.
- **Settings → AI → Optional session caps** — the three opt-in caps.
- **Settings → AI → Local LLM scope** — the LLM-only-for-search toggle.
- **Go Non-Deterministic tab → Local LLM** — master on/off checkbox for the Local LLM.
- **Dashboard → AI tools connected** — live connection list with idle indicator + × disconnect button.

---

## What's *not* a guardrail

Graphnosis is honest about its threat model. The following are **not** what the access-control system protects against:

- **Local malware** that has already compromised your user account
- **Physical access** to an unlocked machine
- **An AI client you intentionally granted permanent consent to**, that turns out to behave badly — the consent gate's job ended when you said yes; auditing and revoking are the after-the-fact tools
- **The AI provider's own data handling** — once a recall result leaves your device, the AI provider's privacy policy governs what happens to it. Pick clients whose policies you trust.

The honest line: Graphnosis stops **untrusted** clients from reading your memories. It also gives you tools to audit and revoke trust. Trust itself is your call.

---

*See also: [Graphs & Sensitivity Tiers](/guides/graphs-and-tiers) · [Using Graphnosis with AI Clients](/legal/third-party-ai) · [Privacy Policy](/legal/privacy-policy)*
