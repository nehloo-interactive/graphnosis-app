---
title: Engram Sharing
description: Share specific engrams with collaborators using scoped shares — without handing over your whole cortex or running any cloud sync.
sidebar:
  order: 9
---

Engram sharing lets you give a collaborator — a teammate, a client, a co-author — access to specific engrams in your cortex, with the role you choose, via your MCP server. Their AI client queries your sidecar directly; no data ever transits a Graphnosis server.

**Requires:** [Mobile & Remote Access](/getting-started/mobile/) enabled

---

## How it works

The mechanism is simple: you create a **share** that names exactly which engrams it covers and whether the holder can only read (viewer) or also write (editor). The collaborator adds one line to their MCP config — your sidecar URL plus the share. From that point, their AI client can recall, remember, and otherwise work with those engrams as if they were local.

Their AI client never sees your other engrams. The share enforces the scope at the sidecar layer — not just in the UI, but at the recall and write levels. A viewer share silently returns empty results for engrams it doesn't cover and rejects `remember`, `forget`, and `edit` calls outright.

---

## Setup

### 1. Enable Mobile & Remote Access

Sharing requires your HTTP MCP server to be reachable. If you haven't already:

1. Open **Settings → Mobile & Remote Access**
2. Enable **Remote Access** and note your sidecar URL (shown in the panel)
3. If sharing outside your local network: set up Tailscale or expose the port via a reverse proxy

The collaborator will use that URL as the MCP endpoint.

### 2. Create a share

1. Open **Settings → Sharing**
2. Click **Create share**
3. Fill in:
   - **Name** — what you'll call it (shown in your list; the collaborator doesn't see it)
   - **Role** — `viewer` (recall only) or `editor` (recall + write)
   - **Engrams** — pick specific engrams, choose **Entire cortex** to include every engram — current *and* future — or **Entire cortex except…** to share everything minus the engrams you check (see [Cortex-wide shares](#cortex-wide-shares))
   - **Expires** — optional; leave blank for no expiry
4. Click **Create**

The share is shown exactly once. Copy it — it won't be shown again.

### 3. Send the share and URL to your collaborator

Send them:
- Your sidecar URL (e.g. `http://your-machine.ts.net:PORT/mcp`)
- The share

They add it to their MCP config:

```json
{
  "mcpServers": {
    "nelu-shared": {
      "url": "http://your-machine.ts.net:PORT/mcp",
      "headers": {
        "Authorization": "Bearer <share>"
      }
    }
  }
}
```

Their AI client will now see a second set of engrams alongside their own cortex — the ones you scoped to that share.

---

## What collaborators can and can't do

| Action | Viewer | Editor |
|--------|--------|--------|
| `recall`, `remind`, `dig_deeper` | ✅ | ✅ |
| `remember`, `edit`, `forget` | ✗ | ✅ |
| `ingest_batch` | ✗ | ✅ |
| Access engrams not in the share's scope | ✗ | ✗ |
| Access your sensitive-tier engrams without your consent gate | ✗ | ✗ |

The consent gate still applies to sensitive-tier engrams even for editor shares — the collaborator's writes and recalls on sensitive engrams fire the same in-app approval prompt you'd see for any AI client. If you want a shared engram to flow without prompts, keep it at `personal` or `public` tier.

Writes through an editor share are attributed in the op-log with the share name, so you can always see what a collaborator added.

---

## Cortex-wide shares

Choosing **Entire cortex** in the create form makes the share cover **every engram — including engrams you create after the share exists**. Scope is evaluated at call time, so a new engram is visible to the share the moment it's created. Three things to understand before handing one out:

- **Personal-tier engrams flow silently.** Only sensitive-tier engrams are protected by the consent gate; everything at `public` or `personal` tier answers a cortex-wide share without any prompt on your machine.
- **The share is owner-equivalent in breadth** (though not in power — role limits still apply, and app settings, your passphrase, and share management are never reachable through it).
- **Carve-outs narrow it without losing the cortex-wide default.** **Entire cortex except…** shares everything minus the engrams you check. A carved-out engram behaves as if the share doesn't exist — invisible to recall and listing, rejected for writes — while every other engram, including future ones, stays covered. (Shares are immutable once minted; to change carve-outs later, revoke and re-create.)

Cortex-wide shares fit cases where the holder is effectively *you*: your own second device, or a personal AI assistant you run yourself. For collaborators, prefer specific engrams — scope is the security boundary, and the smallest scope that works is the right one.

---

## Managing shares

**Settings → Sharing** shows all your shares with their name, role, engram scope, creation date, and expiry. You can revoke any share from there — revocation is immediate. The collaborator's next MCP call will receive a 401.

There's no way to retrieve a share after creation. If a share is lost, revoke it and create a new one.

---

## Share limits

| Plan | Shares |
|------|--------|
| Free | 1 active share |
| Pro | Unlimited |
| Teams | Unlimited |
| Enterprise | Unlimited |

Expired shares don't count toward the limit.

---

## Air-gapped sharing: Engram Packs (`.gez`)

If your collaborator can't reach your sidecar — different network, air-gapped environment, or you just want a one-time snapshot — you can export an engram as a signed encrypted `.gez` pack and hand it over any way you like (USB, secure file transfer, email).

`.gez` (Graphnosis Engram Zero) uses the same AES-256-GCM + Ed25519 format as `.gsk` skill packs. On import, the signature is verified, nodes are merged into the recipient's cortex, and any conflicts are flagged for review.

Export and import are available via the MCP tools `export_engram` and `import_engram`, or the CLI:

```bash
graphnosis engram export --engram project-x --out project-x.gez
graphnosis engram import project-x.gez
```

---

## Security model

A few things worth knowing:

- **Shares are bearer credentials.** Anyone who holds a share can use it. Treat them like API keys — don't paste them into public repos or shared docs.
- **No Graphnosis server is involved.** The connection is between the collaborator's AI client and your sidecar. Graphnosis doesn't route, log, or see the traffic.
- **Your other engrams are invisible.** Scope enforcement is server-side — the collaborator's AI client never learns that your other engrams exist.
- **Sensitive-tier consent still applies.** The consent gate is not bypassed by shares. If you gate an engram as `sensitive`, recalls against it from a share will still fire the in-app prompt on your machine.

---

## Related

[Mobile & Remote Access](/getting-started/mobile/) — required prerequisite; covers network setup, Tailscale, and port forwarding.

[AI Access Controls](/guides/ai-access-controls/) — the full consent and rate-limiting stack that applies to shared connections.

[Graphs & Sensitivity Tiers](/guides/graphs-and-tiers/) — set the right tier before sharing an engram.

[File Formats](/reference/file-formats/) — `.gez` pack format spec.
