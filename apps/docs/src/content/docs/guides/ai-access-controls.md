---
title: AI Access Controls
description: How Graphnosis decides whether an AI client can read your memories — the consent phrase, rate limit, session replay blocker, opt-in caps, and the audit trail behind them.
sidebar:
  order: 6
---

Graphnosis is **local encrypted memory, indexed for deterministic recall — auditable**. The "auditable" part is enforced by a layered access-control system that sits between your AI client and your cortex. This page explains each layer, what threat it addresses, and where to configure it.

## The five layers, summarised

| # | Layer | What it stops | Default |
|---|------|---------------|---------|
| 1 | **Sensitivity tiers** | Sensitive engrams from leaking at all | Engrams default to `personal` |
| 2 | **Consent phrase gate** | Untrusted AI clients from any access without your active approval | On for `personal` + `sensitive` engrams |
| 3 | **Recall rate limit** | Burst attacks (many distinct queries in a short window) | 10 recalls per 60 s per client |
| 4 | **Session replay blocker** | Systematic memory scraping via repeated near-identical queries | Jaccard ≥ 0.85 within a 5-min window |
| 5 | **Optional session caps** | Cumulative volume per conversation | Off by default — power users opt in |

Layers compose. A query has to pass every relevant layer before any memory data is returned.

---

## 1. Sensitivity tiers (recap)

Each engram has a tier: `public`, `personal`, or `sensitive`. The sidecar enforces tier-specific behaviour before any recall result leaves your device:

- **`public`** — no consent prompt, no gate. Best for documentation, reference material, public notes.
- **`personal`** — consent gate fires before first access from each AI client; rate limit and replay blocker apply. Best for journals, work notes, personal correspondence.
- **`sensitive`** — same gate as personal but with a tighter consent window (re-confirmed hourly by default) and visual red badge in the app. Best for health, financial, or other Article-9-class data.

See [Graphs & Sensitivity Tiers](/guides/graphs-and-tiers) for the full setup walkthrough.

---

## 2. The consent phrase gate

Before an AI client can read memories from a `personal` or `sensitive` engram, Graphnosis requires you — not the AI — to type a **time-limited phrase** that is only shown inside the Graphnosis app.

### How the phrase works

Phrases are three short words (e.g. `pixel ledge phase`), generated locally:

```
phrase = HMAC-SHA256( cortex_secret, tier + ":" + floor(now_ms / window_ms) )
```

- The **cortex secret** is a 32-byte random key generated once at cortex creation and stored encrypted in your settings. It never leaves your device. No MCP tool can read it.
- The **window** is 24 hours for `personal` tier and 1 hour for `sensitive` tier — phrases rotate automatically.
- The first 9 bytes of the HMAC select three words from a bundled 256-word list (`acorn`, `adapt`, `affix`, …, `zesty`, `zippy`). The list is public; the secret is not.

This is the same construction as a TOTP code, with words instead of digits.

### The user flow

1. An AI client calls `recall` against one of your personal engrams.
2. The sidecar replies with a structured consent notice describing exactly which engram, which tier, and where the data will go (named AI provider + privacy policy link).
3. The AI presents the notice to you and asks you to type the phrase.
4. You open **Graphnosis → Settings → AI → Consent Phrases**, read the current personal phrase, and type it back into the AI conversation.
5. The AI calls `confirm_data_access({ phrase, tier })`. The sidecar validates it locally.
6. On success, a consent record is stored and the original recall is retried automatically. On failure, a strike is recorded.

The phrase is **never** sent through MCP. The AI sees only what you type. The cortex secret never leaves the device.

### Configuring the consent interval

Settings → AI → "Re-confirm personal data" / "Re-confirm sensitive data" lets you pick how long a typed confirmation is remembered before re-prompting:

- **Every access** — phrase required for every recall (highest friction, highest assurance)
- **15 min / 30 min / 1 hour / 4 hours / 1 day / 1 week** — common intervals
- **Permanent — until revoked** — one informed grant per client, then no re-prompt until you click Revoke

Defaults: `personal` = permanent, `sensitive` = 1 hour.

You can override the interval per engram in Cortex Management → Edit Engrams. The stricter setting (lower interval) wins when an engram override is set.

### Lockout after failed attempts

After **5 consecutive failed** `confirm_data_access` attempts for the same `(client, tier)` pair within a 10-minute window, Graphnosis revokes that pair's consent and shows a notification. Lockout is **scoped** — it doesn't revoke unrelated consents.

### Honest scope of protection

The consent phrase gate is effective against:

- **Prompt injection** attempting to "supply" a phrase from inside an ingested document (the phrase rotates; old phrases stop working).
- **Autonomous agents** scripted to fake consent (the phrase is not exposed to any MCP tool — the AI literally cannot retrieve it).
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

A guardrail that rejects a recall whose query is too similar to one issued in the last 5 minutes by the same client.

**Default**: Jaccard token-set similarity ≥ 0.85 within a 5-minute window blocks the call.

The blocker normalises both queries to lowercase, strips punctuation, drops short words, and compares the resulting word sets. Jaccard similarity is the size of the intersection over the size of the union.

When it fires:
- The sidecar throws: "Session replay detected — this query is N% similar to one issued Xs ago (previous: …). Modify your query meaningfully or wait 5 min."
- A toast appears in the Graphnosis app: "Session replay blocked".

This catches **systematic scans** — repeated or trivially-paraphrased queries used to bypass per-call result caps and gradually exfiltrate the graph. It does not catch true semantic synonyms (different vocabulary, same meaning); those are legitimate follow-up questions.

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

## Where each control lives in the app

- **Top bar** — sensitivity badge next to the active engram name. Click to change tier or set a per-engram consent interval.
- **Settings → Open preferences → AI access & consent** — phrase display, intervals, active consents, full history.
- **Settings → AI → Optional session caps** — the three opt-in caps.
- **Settings → AI → Local LLM scope** — the LLM-only-for-search toggle.
- **Go Non-Deterministic tab → Local LLM** — master on/off checkbox for the Local LLM.

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
