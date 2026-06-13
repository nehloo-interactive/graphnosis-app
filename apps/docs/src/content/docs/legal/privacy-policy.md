---
title: Privacy Policy
description: How Graphnosis handles your data — and why Nehloo Interactive never sees any of it.
---

*Last updated: May 2026*

> **Short version:** Graphnosis has no servers. Nehloo Interactive never receives, processes, or stores any of your personal data. Everything lives on your device, encrypted. The one moment that involves any external data flow: when you are actively using an AI client and it calls `recall`, a small, semantically filtered excerpt of your memory is sent to that AI provider — not to us, and only in response to the specific question you're asking right now. Read on for the full picture.

---

## 1. Who we are

Graphnosis is a product of **Nehloo Interactive LLC** ("Nehloo Interactive," "we," "us," or "our"). This Privacy Policy explains how the Graphnosis desktop application and any related services handle information about you.

If you have questions, contact us at: **privacy@graphnosis.com**

---

## 2. The core principle: we see nothing

Nehloo Interactive operates **no servers that receive your personal data**. We have no data centers where your cortex is stored. We run no analytics pipelines processing your behavior. We collect no telemetry. When you use Graphnosis, your data does not travel to us — ever.

This is an architectural choice, not just a policy. The application is designed so that personal data physically cannot reach our infrastructure because our infrastructure is not in the loop.

---

## 3. What is stored and where

### 3.1 Your cortex — local, encrypted

All graph data — your memories, nodes, source records, embeddings, and the op-log — are stored in the **cortex folder** you choose on your own device. Files are encrypted at rest using **libsodium `crypto_secretstream_xchacha20poly1305`**, with a key derived from your passphrase via **Argon2id**. Without your passphrase (or the 24-word recovery phrase shown once at setup), the files are unreadable ciphertext.

Nehloo Interactive does not hold a copy of your passphrase, your recovery phrase, or your encryption key. If you lose both, the data is unrecoverable. We cannot help you recover it.

### 3.2 What the cortex folder contains

- `.gai` files — encrypted serialized knowledge graphs
- `neural-network.gnn` — the encrypted Neural Network prediction overlay, present only if you enable the Neural Network (kept separate from the deterministic `.gai` graph)
- An encrypted cross-engram connection store
- An encrypted op-log (append-only event log used for multi-device sync)
- A settings file holding your app and engram preferences, including the configuration of any connectors you set up
- A model cache directory — see §4.1 below
- Socket files (`.sock`) — ephemeral, local process communication only

### 3.3 Keychain storage

On macOS, after you first unlock your cortex, the passphrase is stored in the **macOS Keychain** (the system secure enclave). This is local OS-level storage; Nehloo Interactive does not have access to it. On Windows, the Windows Credential Manager is used equivalently.

---

## 4. The only network activity Graphnosis initiates

Graphnosis never transmits your cortex, your memories, or any personal data to Nehloo Interactive or anyone else. The app makes only the two kinds of outbound request described below — and the second happens **only if you set it up**.

### 4.1 Embedding model download (one-time)

On first use, Graphnosis downloads the **BGE-small-en-v1.5** embedding model from Hugging Face Hub to your local model cache. After that, all inference runs offline on your device. No personal data is sent during this download — only a standard HTTP request for a public model file. You can pre-stage the model manually to avoid this network call entirely.

### 4.2 Connectors you set up

Graphnosis can pull content into your cortex from external services — RSS feeds and similar — through **connectors**. A connector fetches content *from* a service you choose, on a schedule you set. These connections happen **only with your permission**: a connector never runs unless you have explicitly created and configured it. If you set up no connectors, Graphnosis makes no such connections. A connector only ever *downloads into* your cortex — it never sends your cortex anywhere.

### 4.3 What does not happen

Apart from the one-time model download and any connectors you configure, Graphnosis makes no outbound network connections. It does not check for updates automatically, does not send error reports, does not transmit telemetry or analytics, and does not ping any Nehloo Interactive endpoint. The Graphnosis documentation is **bundled inside the app** — adding it to your cortex is a fully offline, local operation that contacts no server.

---

## 5. Third-party AI clients — when data moves and how

This is the most important section for your privacy.

### 5.1 The precise conditions for any data to leave your device

Memory content leaves your device **only** when all of the following are true simultaneously:

1. You have an AI client open and actively connected to Graphnosis via MCP.
2. You are engaged in a conversation — asking a question, sending a message.
3. The AI client calls the `recall` tool in the context of that conversation.

If your AI client is closed, nothing moves. If it is open but you are not actively conversing, nothing moves. Your cortex does not broadcast, sync, or transmit anything on its own. It is entirely passive.

### 5.2 What the AI provider receives — and how small it is

When `recall` fires, Graphnosis does not send your documents, your files, or your full graph. It:

1. Runs a semantic search against your local engram graph — entirely on your device.
2. Selects only the memory nodes most relevant to your current query.
3. Enforces your sensitivity tier caps (see §5.3 below).
4. Formats the selected nodes as a plain-text context block.

**That context block — and only that context block — is what the AI provider receives.** It contains a small, curated excerpt of the memories relevant to the question you are asking right now. The rest of your cortex stays encrypted on your device, unread and unsent. Across a typical conversation, this amounts to a few hundred to a few thousand words — a fraction of what you've ingested.

This is architecturally different from approaches that dump your files into AI context windows. Graphnosis encodes content into binary engrams (`.gai` format) on ingest; the AI never receives raw files. On recall, it receives only decoded, semantically filtered excerpts.

The recalled text is processed by the AI provider (Anthropic, OpenAI, etc.) under **their** privacy policy, not ours. Nehloo Interactive is not a party to that exchange. We do not see it, log it, or store a copy of it.

**Before you ingest sensitive information**, we strongly recommend reviewing the privacy policy of the AI clients you connect to Graphnosis:
- [Anthropic (Claude) Privacy Policy](https://www.anthropic.com/privacy)
- [OpenAI Privacy Policy](https://openai.com/privacy)
- [GitHub Copilot / Microsoft Privacy Statement](https://privacy.microsoft.com/en-us/privacystatement)

These policies may change. Nehloo Interactive is not responsible for how third-party AI providers process data you share with them through or alongside Graphnosis.

### 5.3 Sensitivity tiers — hard limits you set

Every graph in your cortex has a sensitivity tier. These limits are enforced by the Graphnosis sidecar before any content is returned to an AI client. The AI cannot override them.

| Tier | What gets recalled |
|---|---|
| `public` | Up to 50 nodes / 8,000 tokens per recall |
| `personal` | Up to 50 nodes / 8,000 tokens per recall |
| `sensitive` | Excluded from AI recall by default. If you explicitly share one, a tight cap applies — at most 5 nodes / 500 tokens per recall. |

By default, a `sensitive` graph is fully blocked from AI access — the AI receives no results and no indication that the graph exists. Sharing one with an AI client is a deliberate, per-graph choice you make in the app; even then, the tight cap above always applies. Nothing from a `sensitive` graph reaches an AI client unless you have opted that specific graph in.

### 5.4 Layer 4 data access controls

Starting in Graphnosis **v0.10**, before any AI client can retrieve memories from `sensitive` engrams, Graphnosis enforces a layered access-control stack that requires **active confirmation from you — not the AI.** Personal-tier engrams flow without an extra per-recall prompt (your decision to install Graphnosis and add it to your AI client's MCP configuration constitutes the informed consent for routine access); users who want every personal-tier recall gated too can enable **Extra precaution mode** in Settings → AI. A full technical walkthrough lives at [AI Access Controls](/guides/ai-access-controls); the summary:

- **In-app consent prompt (primary).** When a `sensitive`-tier recall fires (or any gated recall in extra-precaution mode), the Graphnosis app pops a modal naming the AI client, the tiers requested, and the AI provider's privacy policy, with buttons **Deny / Allow once / Allow for 1 hour / Allow for today**. One click resolves it; the recall proceeds or errors cleanly.
- **Per-client default policy.** The first time a new AI client triggers the gate, the app offers a one-time chooser per tier (always-allow / ask-1h / ask-1d / ask-every-time / never-allow). Editable later in Settings → AI → Client policies.
- **Consent phrase gate (headless fallback).** When the in-app prompt cannot reach a window (sidecar over SSH, in Docker, in CI), the gate falls back to a 3-word time-limited phrase displayed only in the Graphnosis app (Settings → AI → Consent Phrases) that you type into the AI conversation. Phrases rotate every 24 hours for `personal` engrams and every 1 hour for `sensitive`. Generated locally via `HMAC-SHA256(per-cortex-secret, tier + ":" + time-window)`. The secret never leaves your device and is not exposed via any MCP tool.
- **Federated recall is silently scoped.** A `recall` that does not name specific engrams excludes un-consented sensitive engrams from the search entirely rather than firing a prompt; the AI gets results only from tiers it can read. The prompt fires when the AI explicitly names a sensitive engram via `only_engrams` — i.e. when access is deliberate.
- **Configurable re-confirmation intervals.** When you choose **Allow for 1 hour / for today** on the modal, the grant lasts that long. The legacy interval settings (Settings → AI) still govern phrase-typed grants and per-engram overrides. The stricter setting always wins.
- **Recall rate limit.** Each AI client is capped at 10 recall-class calls per 60-second window.
- **Session replay blocker.** Recalls are blocked when the same query is repeated 3+ times within a 60-second window by the same client (Jaccard token-set similarity ≥ 0.85). First two identical queries pass as natural retries.
- **5-attempt lockout.** Five consecutive failed phrase attempts for the same (client, tier) pair within 10 minutes revoke that pair's consent and notify you.
- **Optional cumulative session caps.** Token cap, node cap, and engram-breadth cap — all off by default; available in Settings → AI for power users who want extra backstops.

**Consent audit trail.** Every grant, expiration, and revocation is recorded inside your cortex. Settings → AI → "View full history…" lists all records. Records contain only metadata (timestamp, client name, tier, interval) — never the phrase itself and never the memory content. Records never leave your device; Nehloo has no copy and no technical means to access them.

**What this protection covers:** prompt-injection attempts to "supply" a phrase from an ingested document (phrases rotate; old ones stop working), autonomous AI agents scripted to fake consent (phrase is not exposed via any MCP tool), reconnection-based bypass (consent is tracked per `(client, tier)`, not per session), and routine bulk-export pressure from any AI client.

**Honest limits.** A malicious agent with OS-level screen-capture, clipboard, or Accessibility API access on the same user account could theoretically read the phrase displayed in the app. That is the "compromised machine" threat model; no software mechanism at the MCP layer can fully defeat it. Graphnosis discloses this in the consent flow itself and in [Using Graphnosis with AI Clients](/legal/third-party-ai).

You can revoke all AI consents at any time from Settings → AI. Revocation is immediate; consent records remain in your audit history with a `withdrawnAt` timestamp.

### 5.5 Engram Sharing (Pro and above)

Starting in Graphnosis **v1.16.0**, Pro, Teams, and Enterprise users can generate **scoped sharing tokens** (Settings → Sharing) to give collaborators read or write access to specific engrams via the HTTP MCP server. When you create a sharing token, you choose which engrams are accessible and the role (viewer or editor). Collaborators connect using the token and your sidecar's URL — no data transits Nehloo's servers; the connection is direct between the collaborator's AI client and your sidecar. You can revoke any token at any time from Settings → Sharing; revocation is immediate.

### 5.6 International data transfers (made by you, not by Nehloo)

Nehloo Interactive does not transfer your data anywhere. When you authorize an AI client (by clicking Allow on the in-app consent prompt, or in headless setups by typing the consent phrase), your data travels directly from your device to the AI provider's servers — a transfer made by you, using your own AI account and credentials, outside Nehloo's infrastructure.

**EU/UK users**: This transfer is made under your agreement with the AI provider. For US-based providers, check their privacy policy and Data Processing Addendum for the applicable transfer mechanism (Standard Contractual Clauses, adequacy decision, etc.). Graphnosis's consent gate ensures you have full information before any transfer occurs.

**All users**: Graphnosis cannot interrupt, modify, or control your data once it leaves your device. Revoke consent in Settings → AI → Manage Consents to stop future transfers. Data already sent to an AI provider in past conversations is outside Graphnosis's control and governed by that provider's retention policies.

### 5.6 Special category and sensitive data

If your sensitive-tier engrams contain health, financial, political, biometric, or other sensitive information (per GDPR Article 9 or equivalent local law), the Graphnosis consent action — your click on the in-app prompt's Allow button, or the phrase you type into the AI conversation in headless setups — constitutes your explicit, active authorization to share that data with the named AI provider. This is your decision — Nehloo does not evaluate or control the content of your memories.

We recommend assigning the `sensitive` tier and the shortest appropriate re-confirmation interval to any engram of this nature.

### 5.7 Software versions and consent protections

The Layer 4 consent mechanism was introduced in Graphnosis **v0.10**. Older versions do not include this protection. Nehloo recommends always running the latest release. Using an outdated version means the consent gate described in §5.4 may not apply to your installation. Nehloo is not liable for data transfers that occur through older app versions that predate this mechanism.

### 5.8 You decide what goes in and what tier it gets

Graphnosis gives you explicit control at every stage:
- **You choose what to ingest.** Nothing is ingested automatically. Graphnosis only processes what you explicitly add.
- **You assign sensitivity tiers to graphs.** You decide what gets protected and what consent interval applies.
- **You can forget at any time.** The `forget` tool removes a source and all its derived memories from recall. It is a *soft delete* — the removal is recorded in the op-log and reversible from the app's Recover flow, so an accidental forget can be undone. The original content remains in your encrypted cortex on your device, no longer surfaced to you or any AI client; deleting the cortex folder erases it entirely.

---

## 6. Optional cloud storage (iCloud, Dropbox, Google Drive, etc.)

If you store your cortex folder inside iCloud Drive, Dropbox, Google Drive, OneDrive, or any similar cloud storage service, those files will be synced to that service's servers. **This is entirely your choice and under your control.** The files remain encrypted (the cloud service sees only ciphertext), but that service's privacy policy applies to the encrypted blobs it stores.

Nehloo Interactive is not affiliated with any cloud storage provider and does not recommend or require their use. Graphnosis works entirely with a local folder.

---

## 7. Children's privacy

Graphnosis is not directed to children under the age of 13. We do not knowingly collect personal information from children under 13. Since we collect no personal information from anyone, this is a structural guarantee. If you believe a child under 13 is using Graphnosis, please contact us.

---

## 8. Data security

We have designed Graphnosis so that your data security does not depend on trusting us. Strong encryption, local-only storage, and no cloud backend mean that even a complete compromise of Nehloo Interactive's infrastructure would not expose your cortex data.

That said, the security of your cortex also depends on:
- The strength and confidentiality of your passphrase
- The physical security of your device
- The security practices of any cloud storage service you choose
- The security of the AI clients you connect

We recommend using a strong, unique passphrase and storing your 24-word recovery phrase securely offline.

### 8.1 Programmatic access — the libraries are source-available

The two libraries that underpin Graphnosis are open to read and audit:

- **`@nehloo/graphnosis`** — defines the `.gai` binary graph format; parse and query engram graphs. Open source under Apache-2.0.
- **`@nehloo-interactive/graphnosis-secure-sync`** — the encryption layer; the `GNAPP\x01` format used to wrap and protect `.gai` files on disk. Source-available under the [Functional Source License (FSL-1.1)](https://fsl.software).

This is intentional. We believe your data should never be locked behind proprietary tooling that only we control. You can inspect, export, migrate, or build on top of your own cortex using these libraries — and you can audit exactly how your data is encrypted.

**What this means in practice:**

A power user or developer with both libraries can decrypt and read their own cortex programmatically:

```
decrypt(cortex_file, your_passphrase)   // graphnosis-secure-sync → removes GNAPP\x01 wrapper
→ raw .gai bytes
parse(raw_gai_bytes)                    // @nehloo/graphnosis → deserializes the graph
→ nodes, edges, metadata
```

**The passphrase is still the only gate.** The open-source libraries do not provide any bypass. Someone who has a copy of your cortex folder but does not know your passphrase cannot read anything — the encryption does not depend on the libraries being secret. Auditable crypto is stronger crypto.

This also means you are not locked in. If Nehloo Interactive ever ceased to exist, you would still have full access to your own data using the open-source libraries and your passphrase. Your memory belongs to you.

### 8.2 cortex portability — what "passphrase is the key" means

The cortex folder is **portable by design**. The encryption salt is embedded inside each encrypted file, not tied to the machine it was created on. This enables the cloud sync use case (iCloud Drive, Dropbox, etc.) and lets you migrate your cortex to a new device without any re-encryption step.

**What this means for security:**

- If someone obtains a copy of your entire cortex folder AND knows your passphrase, they can open that cortex on any machine using Graphnosis or the SDK.
- If someone obtains a copy of your cortex folder but does NOT know your passphrase, they cannot read anything. The files are Argon2id-hardened ciphertext. Brute-forcing a strong passphrase is computationally infeasible with current hardware.
- Graphnosis does not implement device binding (tying decryption to a specific machine's hardware key). Device binding would make the cortex unrecoverable if your device fails, even with your recovery phrase. We believe this tradeoff is wrong for a personal knowledge tool. The passphrase is the secret.

**The practical implication:** treat your passphrase with the same care you would treat the data itself. A weak passphrase is a weak lock. A strong, unique passphrase — combined with not storing it anywhere obvious — means your cortex is secure even if the encrypted files are copied.

---

## 9. Nehloo Interactive's role — software vendor, not data controller

Nehloo Interactive is the developer and distributor of Graphnosis software. **Nehloo is not a data controller or processor for data you store in your cortex or share with AI providers.**

- Your cortex data flows from your device → directly to the AI provider, using your own AI account and credentials. Nehloo is never in this flow.
- Nehloo designs the software that enables this flow but does not determine the purpose of processing — you do.
- This is legally analogous to a browser vendor: Mozilla does not become a data controller for what users do on websites visited via Firefox. Nehloo does not become a data controller for what you share with AI providers via Graphnosis.

**What Nehloo does control** (and is responsible for): your email address and newsletter subscription, software design and distribution, and accuracy of privacy disclosures.

**What Nehloo does NOT have**: any copy of your cortex, your consent records, your passphrase, or the data you share with AI providers.

## 10. EU/UK GDPR rights

For **cortex data**: Nehloo Interactive does not hold this data. All GDPR rights (access, portability, rectification, erasure) are exercised directly in the Graphnosis app — Settings → AI → Data tab. Nehloo cannot fulfill requests about cortex content because it does not possess it.

For **account/newsletter data** (the only personal data Nehloo holds — your email address):
- **Lawful basis**: consent (newsletter), contract (customer accounts).
- **Retention**: until unsubscribed or account closed.
- **Rights**: access, correction, erasure — contact privacy@graphnosis.com.
- **International transfers**: Nehloo does not transfer EU customer data to third countries. Email marketing services used by Nehloo (if any) are disclosed on request.

**AI clients are separate controllers.** When you authorize an AI client via the consent gate, the AI provider becomes an independent controller of the data you send. Their DPA with you governs — not Nehloo's. Nehloo is not a party to that data flow.

**Consent records** are stored in your encrypted cortex (not at Nehloo). Withdrawal of AI consent is done in Settings → AI → Manage Consents — not by contacting Nehloo.

## 11. California privacy rights (CCPA/CPRA)

Nehloo Interactive collects: your email address (newsletter/account). We do **not** sell or share this data. We run no targeted advertising.

**cortex data**: stored only on your device. Nehloo has no copy and cannot respond to CCPA requests about cortex content — it is not in our possession. Use the Graphnosis app to export or delete your memories.

**"Do Not Sell or Share My Personal Information"**: Graphnosis does not sell data. AI sharing of sensitive-tier data requires your explicit, active consent via the in-app prompt (or phrase fallback) — see §5.4. You can revoke at any time in Settings → AI.

**California resident requests** about newsletter/account email: contact privacy@graphnosis.com with subject "CCPA Request."

## 12. Other jurisdictions

**India (DPDP Act 2023)**: Rights to access, correction, and erasure apply to data Nehloo holds (email only). cortex data is yours locally. Contact privacy@graphnosis.com for account data requests.

**Brazil (LGPD)**: Same structure as §10. International transfers of cortex data are executed by you, under your agreements with AI providers.

**Canada (PIPEDA/Quebec Law 25)**: Explicit per-session consent is required before any cortex data is shared with AI providers. No data sharing occurs without active phrase confirmation. Contact privacy@graphnosis.com for account data.

**China (PIPL)**: Graphnosis does not geofence users by country. Users in mainland China should consult local PIPL cross-border data transfer requirements before enabling AI integrations. Nehloo is not responsible for the user's compliance with local law.

**All other regions**: The consent gate (in-app prompt + phrase fallback) ensures no sensitive cortex data is forwarded to any AI provider without your active approval, regardless of jurisdiction. Contact privacy@graphnosis.com for region-specific questions about Nehloo's account data.

## 13. Changes to this policy

We may update this Privacy Policy from time to time. When we do, we will update the "Last updated" date at the top. Material changes will be noted in the release notes accompanying app updates. Continued use of Graphnosis after a policy change constitutes acceptance of the new terms.

---

---

## 14. Contact

For privacy questions or concerns:

**Nehloo Interactive LLC**
Email: privacy@graphnosis.com
Website: https://graphnosis.com

---

*This Privacy Policy should be read alongside our [Terms of Use](/legal/terms-of-use). This policy does not constitute legal advice. If you have specific legal or compliance requirements, consult a qualified attorney.*
